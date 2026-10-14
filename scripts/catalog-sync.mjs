#!/usr/bin/env node
/**
 * 插件目录同步 —— 从 npm registry 拉取真实的 DSH 插件清单
 *
 * 为什么需要它：
 *   用户问得很直接：「billion-context 是你告诉我的，还是真正从插件目录检索出来的？」
 *   老实说，初版 `src/catalog/index.mjs` 里的目录是**人工写死的白名单**。
 *   本脚本把它变成真的：按 `keywords:dsh-plugin` 检索 npm registry，
 *   读每个包的 `dshhub` 元数据与描述，落成一份**可复核的快照**。
 *
 * 重要：这是**用户显式执行的联网脚本**，不是插件的后台行为。
 *   体检本体（report / 面板）依然零外发，只读这份快照。
 *
 * 用法：
 *   ./run.sh catalog-sync            # 同步到默认路径
 *   ./run.sh catalog-sync --limit 80 # 抓更多候选包的详情
 *
 * 输出：~/.agent-clinic/catalog.snapshot.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=250';
const DEFAULT_OUT = path.join(os.homedir(), '.agent-clinic', 'catalog.snapshot.json');

const argv = process.argv.slice(2);
const limitArg = argv.indexOf('--limit');
const DETAIL_LIMIT = limitArg >= 0 ? Number(argv[limitArg + 1]) || 60 : 60;
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 ? argv[outArg + 1] : DEFAULT_OUT;

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

async function fetchJson(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
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

async function main() {
  process.stdout.write(`插件目录同步\n  检索：${SEARCH_URL}\n`);

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

  const snapshot = {
    version: 1,
    generatedBy: 'agent-clinic scripts/catalog-sync.mjs',
    source: SEARCH_URL,
    fetchedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    entries,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  const withHub = entries.filter((e) => e.hasDshBundlePatch).length;
  process.stdout.write(
    `  写入：${OUT}\n  收录 ${entries.length} 条（其中 ${withHub} 条带 dsh.bundle.patch）\n\n` +
      '提示：体检本体不会联网；报告与面板只读这份快照。下次想更新插件清单，再跑一次本命令即可。\n',
  );
}

main().catch((e) => {
  process.stderr.write(`同步失败：${e.message}\n`);
  process.stderr.write('（体检本体仍可正常使用；没有快照时会退回内置的已核实目录）\n');
  process.exit(1);
});
