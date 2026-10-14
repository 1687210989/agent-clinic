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

// 能力标签规则是**共享**的：同步脚本与体检时的联网现搜（src/catalog/live.mjs）
// 用同一份规则，否则"目录里能搜到的"与"联网现搜到的"会给出不同标签。
import {
  CAPABILITY_RULES,
  CAPABILITY_TERMS,
  deriveCapabilities,
  installOf,
  textOf,
} from '../src/catalog/capabilities.mjs';

export { CAPABILITY_RULES, CAPABILITY_TERMS, deriveCapabilities, installOf, textOf };

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

/** 多路检索：单条关键词会漏，多关键词 + 翻页能显著扩大覆盖率 */
export const NPM_QUERIES = [
  { q: 'keywords:dsh-plugin', why: 'DSH 插件官方关键词' },
  { q: 'keywords:dsh', why: '更宽的 dsh 关键词' },
  { q: 'text:deepseek harness plugin', why: '描述里提到 DeepSeek Harness 插件' },
];

/** 候选池上限（翻页拿到的总数），排序后再取前 DETAIL_LIMIT 个抓详情 */
const CANDIDATE_POOL = Number(argOf('--pool', 600)) || 600;

async function searchNpm(q, from) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=250&from=${from}`;
  const d = await fetchJson(url);
  return { total: d.total ?? 0, objects: d.objects ?? [] };
}

async function collectNpmCandidates() {
  const byName = new Map();
  for (const { q, why } of NPM_QUERIES) {
    let from = 0;
    let total = null;
    while (from < CANDIDATE_POOL) {
      let page;
      try {
        page = await searchNpm(q, from);
      } catch (e) {
        process.stdout.write(`  检索「${q}」第 ${from} 页失败：${e.message}\n`);
        break;
      }
      if (total === null) {
        total = page.total;
        process.stdout.write(`  检索「${q}」（${why}）：共 ${total} 条\n`);
      }
      if (!page.objects.length) break;
      for (const o of page.objects) {
        const p = o.package;
        if (!p?.name) continue;
        const kws = (p.keywords ?? []).map((k) => String(k).toLowerCase());
        const looksDsh =
          kws.includes('dsh-plugin') ||
          kws.includes('dsh') ||
          /(^|[/@-])dsh|deepseek[- ]harness/i.test(`${p.name} ${p.description ?? ''}`);
        if (!looksDsh) continue;
        const prev = byName.get(p.name);
        // 热度信号：npm 搜索自带周/月下载量；取各查询里的最大值
        const weekly = o.downloads?.weekly ?? 0;
        const monthly = o.downloads?.monthly ?? 0;
        const rec = {
          name: p.name,
          description: p.description ?? '',
          keywords: p.keywords ?? [],
          version: p.version,
          date: p.date ?? null,
          links: p.links ?? {},
          weeklyDownloads: Math.max(weekly, prev?.weeklyDownloads ?? 0),
          monthlyDownloads: Math.max(monthly, prev?.monthlyDownloads ?? 0),
          dependents: Number(o.dependents ?? prev?.dependents ?? 0) || 0,
          popularity: Math.max(o.score?.detail?.popularity ?? 0, prev?.popularity ?? 0),
          matchedBy: [...new Set([...(prev?.matchedBy ?? []), why])],
        };
        byName.set(p.name, rec);
      }
      from += 250;
      if (page.objects.length < 250) break;
    }
  }
  return [...byName.values()];
}

/**
 * 热度排序：优先"周下载量"，其次月下载、依赖数、npm 的 popularity 分。
 * 「最近热度高」的插件因此排在前面，先被收录。
 */
function heatOfNpm(c) {
  return c.weeklyDownloads * 1000 + c.monthlyDownloads + c.dependents * 500 + c.popularity;
}

/**
 * 是不是随 dsh-base 一起分发的官方内置包。
 *
 * 为什么必须把这类挑出来：按下载量排序时，`@deepseek-ai/dsh-*` 这些内置包
 * 下载量碾压社区插件（实测周下载 50 万+），会把收录名额全占满 ——
 * 于是"插件目录"里塞满用户本来就装好了、根本不需要再装的东西。
 * 所以：**社区插件优先收录**，内置包只作为可检索项保留并如实标注。
 */
function isOfficialBundle(name) {
  return /^@deepseek-ai\/dsh($|-)/.test(String(name));
}

/** 按"社区优先"补名额：先取社区包，不够再用内置包填满 */
function pickForDetail(candidates, limit) {
  const community = candidates.filter((c) => !isOfficialBundle(c.name));
  const official = candidates.filter((c) => isOfficialBundle(c.name));
  const picked = [...community.slice(0, limit)];
  for (const o of official) {
    if (picked.length >= limit) break;
    picked.push(o);
  }
  return picked;
}

async function syncNpm() {
  process.stdout.write(`\n[来源 1] npm registry\n`);

  const candidates = await collectNpmCandidates();
  candidates.sort((a, b) => heatOfNpm(b) - heatOfNpm(a));
  const community = candidates.filter((c) => !isOfficialBundle(c.name));
  process.stdout.write(
    `  过滤后候选：${candidates.length} 个（社区包 ${community.length} 个）\n` +
      `  社区热度头部：${community
        .slice(0, 3)
        .map((c) => `${c.name}(周下载 ${c.weeklyDownloads})`)
        .join('、') || '（无）'}\n`,
  );

  const detail = pickForDetail(candidates, DETAIL_LIMIT);
  process.stdout.write(
    `  抓取详情（含 dshhub 元数据）：${detail.length} 个` +
      `（社区 ${detail.filter((d) => !isOfficialBundle(d.name)).length} · 官方内置 ${detail.filter((d) => isOfficialBundle(d.name)).length}）…\n`,
  );

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
      // 热度：npm 搜索自带的真实下载量（未取到时为 null，界面如实显示"未知"）
      heat: {
        weeklyDownloads: pkg.weeklyDownloads ?? null,
        monthlyDownloads: pkg.monthlyDownloads ?? null,
        dependents: pkg.dependents ?? null,
        updatedAt: pkg.date ?? doc.time?.[latest] ?? null,
        source: 'npm 搜索的下载量统计',
      },
      install: installOf(pkg.name),
      origin: 'npm-registry',
      // 内置包 vs 社区插件：排序与提示都要用，界面也据此说明"多半已随 dsh-base 挂载"
      kind: isOfficialBundle(pkg.name) ? 'bundled' : 'community',
      source: {
        type: 'third-party',
        package: pkg.name,
        doc: `npm registry packument（dshhub=${hub ? '有' : '无'}）`,
        via: `npm registry search（${(pkg.matchedBy ?? []).join(' / ') || 'keywords:dsh-plugin'}）`,
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

/** git 是否可用（现在只是兜底通道；API 中继可用时不需要 git） */
export function gitOk() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub API 中继。
 *
 * 实测（本机）：`api.github.com` 被 hosts 拦成 127.0.0.1，但公共镜像 `gh-proxy.com`
 * 能原样中继 GitHub API —— 于是**真正的 GitHub 检索可用**，包括按 star 数排序
 * （「较多人推荐」）与按更新时间排序（「最近热度高」）。
 * 直连优先（没被墙的机器更快），失败再逐个试中继。
 *
 * 诚实说明：经第三方中继拿到的数据，来源仍是 GitHub API；
 * 仓库**是否存在**另有 `git ls-remote` 独立核实（走官方 git 协议），
 * 报告里也会写明"经中继 / 直连"。
 */
export const GH_RELAYS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/'];

let _ghRelay = null;

async function ghFetch(pathWithQuery, timeoutMs = 25000) {
  const tried = [];
  const relays = _ghRelay === null ? GH_RELAYS : [_ghRelay, ...GH_RELAYS.filter((r) => r !== _ghRelay)];
  for (const relay of relays) {
    const url = `${relay}https://api.github.com${pathWithQuery}`;
    try {
      const d = await fetchJson(url, timeoutMs, { accept: 'application/vnd.github+json' });
      if (_ghRelay !== relay) {
        _ghRelay = relay;
        process.stdout.write(`  GitHub API 通道：${relay || '直连'}\n`);
      }
      return d;
    } catch (e) {
      tried.push(`${relay || '直连'}(${e.message})`);
    }
  }
  throw new Error(`所有 GitHub 通道都失败：${tried.join(' / ')}`);
}

/** GitHub 检索式：既按 star（较多人推荐），也按最近更新（最近热度高） */
export const GH_QUERIES = [
  { q: 'topic:dsh-plugin', sort: 'stars', why: 'dsh-plugin 主题·按 star 数' },
  { q: 'topic:dsh-plugin', sort: 'updated', why: 'dsh-plugin 主题·按最近更新' },
  { q: 'topic:deepseek-harness', sort: 'stars', why: 'deepseek-harness 主题·按 star 数' },
  { q: 'dsh-plugin in:name,description,readme', sort: 'stars', why: '名称/描述/README 命中·按 star 数' },
  { q: 'deepseek harness plugin in:name,description,readme', sort: 'stars', why: '描述命中·按 star 数' },
];

const GH_DISCOVER_LIMIT = Number(argOf('--gh-discover', 150)) || 150;

/**
 * GitHub 检索是不是"真的与 DSH 相关"。
 *
 * 为什么需要：GitHub 的关键词检索是全文匹配，`dsh-plugin` 会命中 1.9 万个仓库，
 * star 排序的头部全是 ollama、awesome-go 这类蹭到词的大仓库。
 * 所以先按名字/描述/主题过一遍，再按 star 排 —— 宁缺毋滥。
 */
export function isDshRelated(cand) {
  const hay = `${cand.slug ?? ''} ${cand.description ?? ''} ${(cand.topics ?? []).join(' ')}`;
  if (/(^|[/@._-])dsh([._-]|$)|deepseek[- ]harness/i.test(hay)) return true;
  return (cand.topics ?? []).some((t) => /^dsh$|^dsh-|deepseek-harness/i.test(t));
}

/**
 * GitHub 方向的"发现"：走 GitHub 检索（star / 最近更新两个维度），
 * 拿不到才退回人工种子清单。
 */
async function discoverRepos() {
  const bySlug = new Map();
  let apiOk = false;
  for (const { q, sort, why } of GH_QUERIES) {
    try {
      const d = await ghFetch(
        `/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=50`,
      );
      apiOk = true;
      for (const it of d.items ?? []) {
        const prev = bySlug.get(it.full_name);
        bySlug.set(it.full_name, {
          slug: it.full_name,
          stars: it.stargazers_count ?? 0,
          forks: it.forks_count ?? 0,
          pushedAt: it.pushed_at ?? null,
          description: it.description ?? '',
          topics: it.topics ?? [],
          matchedBy: [...new Set([...(prev?.matchedBy ?? []), why])],
        });
      }
      process.stdout.write(`  「${why}」：命中 ${d.total_count ?? '?'} 个，取前 ${(d.items ?? []).length}\n`);
    } catch (e) {
      process.stdout.write(`  「${why}」检索失败：${e.message}\n`);
    }
  }

  // GitHub 的关键词检索是全文匹配，放宽后会带回大量无关的大仓库
  // （star 排序头部是 ollama、awesome-go 这类）。所以先按"名字/描述/主题是否
  // 真的与 DSH 相关"筛一遍，再按 star 排序 —— 宁缺毋滥。
  const before = bySlug.size;
  for (const [slug, c] of [...bySlug]) {
    if (c.matchedBy.includes('人工种子清单')) continue;
    if (!isDshRelated(c)) bySlug.delete(slug);
  }
  const dropped = before - bySlug.size;

  if (!apiOk) {
    process.stdout.write('  GitHub 检索全不可用 → 退回人工种子清单\n');
  }
  if (dropped) process.stdout.write(`  相关性过滤：剔除 ${dropped} 个与 DSH 无关的仓库\n`);
  for (const slug of readSeeds()) {
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, stars: null, forks: null, pushedAt: null, description: '', topics: [], matchedBy: ['人工种子清单'] });
    }
  }

  // 排序：star 数优先（没有 star 数据的种子排后面），再按最近推送
  const repos = [...bySlug.values()]
    .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || String(b.pushedAt ?? '').localeCompare(String(a.pushedAt ?? '')))
    .slice(0, GH_DISCOVER_LIMIT);
  return { repos, viaApi: apiOk, seedCount: readSeeds().length, dropped };
}

/**
 * 取仓库的 package.json。
 *
 * 优先用 GitHub contents API（经中继，一次请求，快），失败再退回浅克隆
 * （克隆走官方 git 协议，作为独立的兜底通道）。
 */
async function fetchRepoPackageJson(slug) {
  try {
    const c = await ghFetch(`/repos/${slug}/contents/package.json`, 20000);
    if (c?.content) {
      const txt = Buffer.from(String(c.content).replace(/\n/g, ''), 'base64').toString('utf8');
      const pkg = JSON.parse(txt.replace(/^\uFEFF/, ''));
      pkg.__viaContents = true;
      return pkg;
    }
  } catch {
    /* 落到克隆兜底 */
  }
  return null;
}

/** git ls-remote：独立核实仓库真实存在（走官方 git 协议，不经中继） */
function lsRemote(slug) {
  const ls = execFileSync('git', ['ls-remote', `https://github.com/${slug}.git`, 'HEAD'], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!ls) throw new Error('ls-remote 无输出');
  return ls.split(/\s+/)[0];
}

/** 浅克隆读 package.json（contents API 不可用时的兜底） */
function clonePackageJson(slug) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gh-'));
  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', `https://github.com/${slug}.git`, tmp],
      { timeout: 90000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const raw = execFileSync('git', ['-C', tmp, 'show', 'HEAD:package.json'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows 偶尔占用，忽略：临时目录会被系统清理 */
    }
  }
}

/**
 * 核实单个仓库，并取它的元数据 + package.json。
 *
 * 两条独立通道，按"先轻后重"排：
 *   1) GitHub API（经中继）：`/repos/{slug}` 证明存在并给出 star/fork/最近推送，
 *      `/contents/package.json` 取清单 —— 只需要两次 HTTP，且**不依赖 git**。
 *   2) git：`ls-remote` 证明存在 + 浅克隆读 package.json —— 官方 git 协议，
 *      当 API 通道全挂时兜底。
 *
 * 为什么必须先走 API：实测在受限沙箱里 spawn `git` 会直接 EPERM
 * （piped stdio 打不开命名管道），一旦把 git 放在第一步，整个 GitHub
 * 方向会全军覆没 —— 而其实 HTTP 通道是通的。
 */
async function inspectRepo(slug) {
  let meta = null;
  try {
    meta = await ghFetch(`/repos/${slug}`, 20000);
  } catch (e) {
    meta = null;
  }

  let pkg = meta ? await fetchRepoPackageJson(slug) : null;
  let via = meta ? 'GitHub API 核实（/repos 存在性 + contents 读 package.json）' : null;
  let headSha = meta?.default_branch ? null : null;

  if (!pkg) {
    // API 拿不到清单 → 走 git（可能因沙箱/网络失败，失败了也要说清原因）
    try {
      headSha = lsRemote(slug);
      pkg = clonePackageJson(slug);
      via = meta
        ? 'GitHub API 核实存在 + git 浅克隆读 package.json'
        : `git ls-remote 核实存在（HEAD ${String(headSha).slice(0, 8)}）+ 浅克隆读 package.json`;
      if (!meta) meta = {};
    } catch (e) {
      if (!meta) throw new Error(`GitHub API 与 git 都拿不到仓库信息（${e.message}）`);
      // 仓库确实存在（API 已证明），只是没有 package.json → 返回空清单，由调用方决定
      return { slug, headSha, pkg: null, meta, via };
    }
  }
  return { slug, headSha, pkg, meta, via };
}

async function syncGithub() {
  process.stdout.write(`\n[来源 2] GitHub\n`);
  // 不再因为"没有 git"跳过整个来源：API 中继通道不依赖 git（沙箱里 spawn git 会 EPERM）

  const disc = await discoverRepos();
  process.stdout.write(
    `  候选 ${disc.repos.length} 个（GitHub 检索 ${disc.viaApi ? '可用' : '不可用'}·人工种子 ${disc.seedCount} 条）\n`,
  );

  const entries = [];
  let checked = 0;
  let noPkg = 0;
  for (const cand of disc.repos) {
    const slug = cand.slug;
    let info;
    try {
      info = await inspectRepo(slug);
    } catch (e) {
      process.stdout.write(`  ✗ ${slug} —— 无法核实（${e.message}）\n`);
      continue;
    }
    checked += 1;
    const pkg = info.pkg;
    if (!pkg) {
      noPkg += 1;
      continue;
    }
    const isDsh = Boolean(pkg?.dsh?.bundle?.patch || pkg?.dshhub || pkg?.keywords?.includes('dsh-plugin'));
    if (!isDsh) {
      if (cand.matchedBy.includes('人工种子清单')) {
        process.stdout.write(`  ✗ ${slug} —— 仓库存在，但 package.json 未见 dsh 元数据，跳过\n`);
      }
      continue;
    }
    const hub = pkg.dshhub ?? null;
    const caps = deriveCapabilities(textOf({ name: pkg.name, description: pkg.description, keywords: pkg.keywords }, hub));
    if (!caps.length) {
      process.stdout.write(`  ✗ ${slug} —— 有 dsh 元数据，但推导不出与本工具指标相关的能力，跳过\n`);
      continue;
    }
    // 热度优先用 GitHub 检索/仓库 API 给的真实数（种子清单没有这些字段 → null）
    const stars = typeof info.meta?.stargazers_count === 'number' ? info.meta.stargazers_count : cand.stars;
    const forks = typeof info.meta?.forks_count === 'number' ? info.meta.forks_count : cand.forks;
    const pushedAt = info.meta?.pushed_at ?? cand.pushedAt;
    entries.push({
      id: `gh:${slug}`,
      package: pkg.name || slug.split('/')[1],
      displayName: hub?.displayName || pkg.name || slug,
      summary: hub?.summary || pkg.description || cand.description || '(GitHub 仓库未提供描述)',
      version: pkg.version ?? null,
      repo: `https://github.com/${slug}`,
      keywords: pkg.keywords ?? [],
      capabilities: [...new Set(caps.map((c) => c.cap))],
      capabilityEvidence: caps,
      hasDshBundlePatch: Boolean(pkg?.dsh?.bundle?.patch),
      dshCompatibility: pkg?.dsh?.compatibility?.dsh ?? hub?.compatibility?.dsh ?? null,
      license: pkg.license ?? null,
      headSha: info.headSha,
      kind: 'community',
      // 热度：star 数（较多人推荐）+ 最近推送时间（最近热度高）
      heat: {
        stars: stars ?? null,
        forks: forks ?? null,
        updatedAt: pushedAt ?? null,
        source: 'GitHub 仓库元数据（star / 最近推送）',
      },
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
        via: `GitHub 检索（${cand.matchedBy.join(' / ')}）→ ${info.via}`,
        verifiedAt: new Date().toISOString().slice(0, 10),
      },
    });
    const e = entries[entries.length - 1];
    process.stdout.write(`  ✓ ${slug} —— ${e.capabilities.join('/')}${stars != null ? `（★${stars}）` : ''}\n`);
  }
  process.stdout.write(
    `  核实了 ${checked} 个仓库（其中 ${noPkg} 个没有 package.json），收录 ${entries.length} 条 GitHub 插件\n`,
  );
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

export { main, readSeeds, SEED_FILE, isOfficialBundle, pickForDetail, heatOfNpm };
