#!/usr/bin/env node
/**
 * 插件目录同步 —— 从 npm registry 与 GitHub 拉取真实的 DSH 插件清单
 *
 * 为什么需要它：
 *   用户问得很直接：「billion-context 是你告诉我的，还是真正从插件目录检索出来的？」
 *   老实说，初版 `src/catalog/index.mjs` 里的目录是**人工写死的白名单**。
 *   本脚本把它变成真的，**两条来源**：
 *     - npm：`keywords:dsh-plugin` 检索 registry，读每个包的 dshhub 元数据
 *     - GitHub：检索仓库后逐条 `git ls-remote` 核实存在，再浅克隆读 package.json
 *       （很多插件只在 GitHub 上、没发 npm —— 用户明确要求"去 GitHub 上找"）
 *
 * 重要：这是**用户显式执行的联网脚本**，不是插件的后台行为。
 *   体检本体（report / 面板）依然零外发，只读生成的快照。
 *
 * 用法：
 *   ./run.sh catalog-sync                  # 默认两条来源都试
 *   ./run.sh catalog-sync --source npm     # 只同步 npm
 *   ./run.sh catalog-sync --source github  # 只同步 GitHub
 *   ./run.sh catalog-sync --limit 80       # 抓更多候选
 *
 * 输出：~/.agent-clinic/catalog.snapshot.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=250';
const GH_API = 'https://api.github.com/search/repositories';
const DEFAULT_OUT = path.join(os.homedir(), '.agent-clinic', 'catalog.snapshot.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(HERE, 'catalog-github-seeds.txt');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DETAIL_LIMIT = Number(argOf('--limit', 120)) || 120;
const OUT = argOf('--out', DEFAULT_OUT);
const SOURCE = argOf('--source', 'both'); // both | npm | github

/**
 * 关键词 → 能力标签。
 *
 * 这是"检索为什么命中"的唯一依据：每命中一个能力标签，都记下**是哪个词命中的**，
 * 报告与面板里会原样展示。规则是可读的，不是黑盒。
 *
 * ⚠️ 规则必须**具体**。踩过的坑：`loop-guard` 一开始写了裸词 `retry|loop|重试`，
 *    结果 `@morlay/session-branch`（会话分支编辑）因为描述里出现一次 "retry"
 *    就被标成"循环防护"，进而被推给 E5 冗余重复调用 —— 纯噪音。
 *    所以这类泛词一律删掉，只保留指向明确的说法。
 */
export const CAPABILITY_RULES = [
  { cap: 'token-saving', re: /上下文压缩|压缩上下文|上下文精简|上下文管理|上下文优化|context compress|compact(ion)?\b|token (节省|压缩|优化)|省 ?token|prune/i },
  { cap: 'cost', re: /成本|费用|花费|计费|价格|cost|billing|budget|额度|用量统计/i },
  { cap: 'long-session', re: /长会话|长期任务|长任务|续航|long[- ]?session|checkpoint|检查点|断点续跑/i },
  { cap: 'memory', re: /记忆|memory|recall|mnemon|知识库|知识图谱/i },
  { cap: 'skill-asset', re: /skill|技能库|技能管理|提示词库|prompt library/i },
  { cap: 'planning', re: /计划|待办|todo|任务看板|看板|task ?board|工作流|workflow/i },
  { cap: 'web-search', re: /联网|网络搜索|网页抓取|web ?search|web ?fetch|爬虫|浏览器自动化/i },
  { cap: 'loop-guard', re: /死循环|重复调用|循环调用|循环检测|loop ?guard|duplicate (tool )?call|repeat(ed)? tool/i },
  { cap: 'safety', re: /安全审计|权限管理|permission|审计|audit|沙箱|sandbox|危险命令/i },
  { cap: 'subagent-control', re: /子代理|子智能体|subagent|多智能体|agent ?team|代理团队/i },
  { cap: 'session-mgmt', re: /会话归档|会话管理|会话分支|归档|archive|会话导出|session (manage|archive|branch)/i },
  { cap: 'observability', re: /监控|用量看板|统计面板|dashboard|可视化|metrics|telemetry/i },
];

/** 从一段文本里推导能力标签，并记下命中的词 */
export function deriveCapabilities(text) {
  const out = [];
  const s = String(text ?? '');
  for (const rule of CAPABILITY_RULES) {
    const m = s.match(rule.re);
    if (m) out.push({ cap: rule.cap, matched: m[0] });
  }
  return out;
}

/** 从 npm 搜索结果的 package 描述里拼出可检索文本 */
function textOf(pkg, hub) {
  return [
    pkg.name,
    pkg.description,
    (pkg.keywords ?? []).join(' '),
    hub?.summary,
    hub?.displayName,
    (hub?.categories ?? []).join(' '),
    (hub?.capabilities?.provides ?? []).join(' '),
    hub?.surfaces ? Object.keys(hub.surfaces).join(' ') : '',
  ]
    .filter(Boolean)
    .join(' \n ');
}

/** 单个包的 install 入口（与既有处方层保持同一措辞） */
const installOf = (name) => ({
  gui: `侧边栏 → 插件 → 添加插件 → 粘贴 ${name}`,
  cli: `dsh plugin --profile <你的 profile> add ${name}`,
});

async function fetchJson(url, timeoutMs = 20000, extraHeaders = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': 'agent-clinic-catalog-sync', ...extraHeaders },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** 有限并发 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: e.message };
        }
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// 来源 1：npm registry
// ---------------------------------------------------------------------------

async function syncNpm() {
  process.stdout.write(`\n[来源 1] npm registry\n  检索：${SEARCH_URL}\n`);

  const search = await fetchJson(SEARCH_URL);
  const objects = search.objects ?? [];
  process.stdout.write(`  npm 返回：共 ${search.total ?? '?'} 条，取前 ${objects.length} 条候选\n`);

  // 只保留"看起来真的是 DSH 插件"的：关键词里有 dsh-plugin，或包名/描述里带 dsh
  const candidates = objects
    .map((o) => o.package)
    .filter((p) => {
      const kws = (p.keywords ?? []).map((k) => String(k).toLowerCase());
      return kws.includes('dsh-plugin') || /(^|[/@-])dsh|deepseek[- ]harness/i.test(`${p.name} ${p.description ?? ''}`);
    });
  process.stdout.write(`  过滤后候选：${candidates.length} 个\n`);

  const detail = candidates.slice(0, DETAIL_LIMIT);
  process.stdout.write(`  抓取详情（含 dshhub 元数据）：${detail.length} 个…\n`);

  const packuments = await mapLimit(detail, 6, async (p) => {
    const doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(p.name).replace('%40', '@')}`);
    return { pkg: p, doc };
  });

  const entries = [];
  for (const item of packuments) {
    if (!item || item.error) continue;
    const { pkg, doc } = item;
    const latest = doc['dist-tags']?.latest ?? pkg.version;
    const ver = doc.versions?.[latest] ?? {};
    const hub = ver.dshhub ?? ver.dsh?.hub ?? null;
    const text = textOf(pkg, hub);
    const caps = deriveCapabilities(text);
    entries.push({
      id: `npm:${pkg.name}`,
      package: pkg.name,
      displayName: hub?.displayName || pkg.name,
      summary: hub?.summary || pkg.description || '(npm 未提供描述)',
      version: latest,
      repo:
        (ver.repository && (ver.repository.url || ver.repository)) ||
        pkg.links?.repository ||
        pkg.links?.npm ||
        null,
      keywords: pkg.keywords ?? [],
      capabilities: [...new Set(caps.map((c) => c.cap))],
      capabilityEvidence: caps,
      hasDshBundlePatch: Boolean(ver.dsh?.bundle?.patch),
      dshCompatibility: ver.dsh?.compatibility?.dsh ?? hub?.compatibility?.dsh ?? null,
      license: ver.license ?? doc.license ?? null,
      publishedAt: doc.time?.[latest] ?? null,
      install: installOf(pkg.name),
      origin: 'npm-registry',
      source: {
        type: 'third-party',
        package: pkg.name,
        doc: `npm registry packument（dshhub=${hub ? '有' : '无'}）`,
        via: 'npm registry search keywords:dsh-plugin',
        verifiedAt: new Date().toISOString().slice(0, 10),
      },
    });
  }
  process.stdout.write(`  收录 ${entries.length} 条（其中 ${entries.filter((e) => e.hasDshBundlePatch).length} 条带 dsh.bundle.patch）\n`);
  return entries;
}

// ---------------------------------------------------------------------------
// 来源 2：GitHub
// ---------------------------------------------------------------------------

/** 读种子清单（owner/repo 每行一个，# 开头是注释） */
function readSeeds(file = SEED_FILE) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter((l) => /^[\w.-]+\/[\w.-]+$/.test(l));
  } catch {
    return [];
  }
}

/** git 是否可用（GitHub 方向全靠它，因为它能穿过受限网络） */
function gitOk() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub 方向的"发现"。
 *
 * 优先级：api.github.com 检索 → 种子清单。
 * 说明：本机（以及不少受限网络）访问不了 api.github.com 与 github.com/search，
 * 但 `git` 协议是通的 —— 所以**检索靠种子清单，核实靠 git ls-remote**，
 * 两者都不假：种子是人找的候选，仓库是否存在由 git 当场证明。
 */
async function discoverRepos() {
  const queries = [
    'dsh plugin compaction context in:name,description,readme',
    'dsh-plugin in:name,description,readme',
    'deepseek harness plugin in:name,description,readme',
  ];
  const found = [];
  for (const q of queries) {
    try {
      const d = await fetchJson(`${GH_API}?q=${encodeURIComponent(q)}&sort=stars&per_page=30`, 15000, {
        accept: 'application/vnd.github+json',
      });
      for (const it of d.items ?? []) found.push(it.full_name);
      process.stdout.write(`  GitHub API 可用：查询「${q}」命中 ${(d.items ?? []).length} 个仓库\n`);
      break;
    } catch (e) {
      process.stdout.write(`  GitHub API 不可用（${e.message}）→ 改用种子清单\n`);
      break;
    }
  }
  const seeds = readSeeds();
  const all = [...new Set([...found, ...seeds])];
  return { repos: all, viaApi: found.length > 0, seedCount: seeds.length };
}

/** 核实单个仓库：git ls-remote 证明存在 → 浅克隆读 package.json 取元数据 */
function inspectRepo(slug) {
  const url = `https://github.com/${slug}.git`;
  const out = { slug, url };

  // 1) 存在性 + HEAD（最便宜的一步，受限网络下也能过）
  const ls = execFileSync('git', ['ls-remote', url, 'HEAD'], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!ls) throw new Error('ls-remote 无输出');
  out.headSha = ls.split(/\s+/)[0];

  // 2) 浅克隆（只取树 + 需要的 blob）读 package.json
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gh-'));
  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', url, tmp],
      { timeout: 90000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    let pkgRaw = null;
    try {
      pkgRaw = execFileSync('git', ['-C', tmp, 'show', 'HEAD:package.json'], {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      pkgRaw = null;
    }
    out.pkg = pkgRaw ? JSON.parse(pkgRaw.replace(/^\uFEFF/, '')) : null;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows 偶尔占用，忽略：临时目录会被系统清理 */
    }
  }
  return out;
}

async function syncGithub() {
  process.stdout.write(`\n[来源 2] GitHub\n`);

  if (!gitOk()) {
    process.stdout.write('  跳过：本机没有可用的 git（GitHub 方向依赖 git 协议穿过受限网络）\n');
    return [];
  }

  const disc = await discoverRepos();
  process.stdout.write(
    `  候选 ${disc.repos.length} 个（API ${disc.viaApi ? '可用' : '不可用'}·种子清单 ${disc.seedCount} 条）\n`,
  );

  const entries = [];
  for (const slug of disc.repos) {
    let info;
    try {
      info = inspectRepo(slug);
    } catch (e) {
      process.stdout.write(`  ✗ ${slug} —— git 核实失败（${e.message}）\n`);
      continue;
    }
    const pkg = info.pkg;
    const isDsh = Boolean(pkg?.dsh?.bundle?.patch || pkg?.dshhub || pkg?.keywords?.includes('dsh-plugin'));
    if (!isDsh) {
      process.stdout.write(`  ✗ ${slug} —— 仓库存在，但 package.json 未见 dsh 元数据，跳过\n`);
      continue;
    }
    const hub = pkg.dshhub ?? null;
    const caps = deriveCapabilities(textOf({ name: pkg.name, description: pkg.description, keywords: pkg.keywords }, hub));
    if (!caps.length) {
      process.stdout.write(`  ✗ ${slug} —— 有 dsh 元数据，但推导不出与本工具指标相关的能力，跳过\n`);
      continue;
    }
    entries.push({
      id: `gh:${slug}`,
      package: pkg.name || slug.split('/')[1],
      displayName: hub?.displayName || pkg.name || slug,
      summary: hub?.summary || pkg.description || '(GitHub 仓库未提供描述)',
      version: pkg.version ?? null,
      repo: `https://github.com/${slug}`,
      keywords: pkg.keywords ?? [],
      capabilities: [...new Set(caps.map((c) => c.cap))],
      capabilityEvidence: caps,
      hasDshBundlePatch: Boolean(pkg?.dsh?.bundle?.patch),
      dshCompatibility: pkg?.dsh?.compatibility?.dsh ?? hub?.compatibility?.dsh ?? null,
      license: pkg.license ?? null,
      headSha: info.headSha,
      install: {
        gui: `GitHub 插件：按仓库 README 安装（本工具不代装）—— https://github.com/${slug}`,
        cli: `git clone https://github.com/${slug}.git   # 再按仓库说明挂载`,
      },
      origin: 'github',
      source: {
        type: 'third-party',
        package: pkg.name || slug,
        repo: `https://github.com/${slug}`,
        doc: `GitHub 仓库 package.json（dshhub=${hub ? '有' : '无'}, dsh.bundle.patch=${pkg?.dsh?.bundle?.patch ? '有' : '无'}）`,
        via: `git ls-remote 核实存在（HEAD ${String(info.headSha).slice(0, 8)}）+ 浅克隆读 package.json`,
        verifiedAt: new Date().toISOString().slice(0, 10),
      },
    });
    process.stdout.write(`  ✓ ${slug} —— ${entries[entries.length - 1].capabilities.join('/')}\n`);
  }
  process.stdout.write(`  收录 ${entries.length} 条 GitHub 插件\n`);
  return entries;
}

async function main() {
  process.stdout.write(`插件目录同步（来源：${SOURCE}）\n`);

  // 上次快照：本次没同步（或同步失败）的来源直接沿用，**绝不因为只跑一个来源而丢另一半**
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    prev = null;
  }
  const prevEntries = Array.isArray(prev?.entries) ? prev.entries : [];

  const entries = [];
  const freshOrigins = new Set();

  if (SOURCE === 'both' || SOURCE === 'npm') {
    try {
      const npm = await syncNpm();
      if (npm.length) {
        entries.push(...npm);
        freshOrigins.add('npm-registry');
      }
    } catch (e) {
      process.stdout.write(`  npm 同步失败：${e.message}（沿用上次快照里的 npm 条目）\n`);
    }
  }
  if (SOURCE === 'both' || SOURCE === 'github') {
    try {
      const gh = await syncGithub();
      if (gh.length) {
        entries.push(...gh);
        freshOrigins.add('github');
      }
    } catch (e) {
      process.stdout.write(`  GitHub 同步失败：${e.message}（沿用上次快照里的 GitHub 条目）\n`);
    }
  }

  const carried = prevEntries.filter((e) => !freshOrigins.has(e.origin ?? 'npm-registry'));
  if (carried.length) {
    process.stdout.write(`\n沿用上次快照：${carried.length} 条（本次未同步或同步失败的来源）\n`);
    entries.push(...carried);
  }

  // 同包名去重：npm 条目优先（有版本号与安装入口）
  const byPackage = new Map();
  for (const e of [...entries].sort((a) => (a.origin === 'npm-registry' ? -1 : 1))) {
    const key = String(e.package).toLowerCase();
    if (!byPackage.has(key)) byPackage.set(key, e);
  }
  const final = [...byPackage.values()];

  const snapshot = {
    version: 1,
    generatedBy: 'agent-clinic scripts/catalog-sync.mjs',
    source: { npm: SEARCH_URL, github: GH_API, githubSeeds: SEED_FILE },
    fetchedAt: new Date().toISOString(),
    syncedOrigins: [...freshOrigins],
    entries: final,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  const byOrigin = final.reduce((m, e) => ((m[e.origin ?? 'npm-registry'] = (m[e.origin ?? 'npm-registry'] ?? 0) + 1), m), {});
  process.stdout.write(
    `\n写入：${OUT}\n  收录 ${final.length} 条` +
      `（npm ${byOrigin['npm-registry'] ?? 0} · github ${byOrigin.github ?? 0}）\n\n` +
      '提示：体检本体不会联网；报告与面板只读这份快照。下次想更新插件清单，再跑一次本命令即可。\n',
  );
}


// 只有直接执行（node scripts/catalog-sync.mjs）才跑同步；
// 被 import 时（例如冒烟测试要复用 readSeeds）不产生副作用。
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((e) => {
    process.stderr.write(`同步失败：${e.message}\n`);
    process.stderr.write('（体检本体仍可正常使用；没有快照时会退回内置的已核实目录）\n');
    process.exit(1);
  });
}

export { main, readSeeds, SEED_FILE };
