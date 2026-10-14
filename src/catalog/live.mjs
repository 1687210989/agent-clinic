/**
 * 体检时**联网现搜**插件 —— 「发现问题就去网上找方案」。
 *
 * 为什么要有它（用户原话）：
 *   「我想要的结果是发现问题后联网搜索得到解决方案」
 *   在它之前，体检只读一份可能过期的快照：新出的插件要手动跑 `catalog-sync` 才看得见。
 *   现在 `report --live` 会在诊断出问题的当下，按**问题的能力需求**去 npm 与 GitHub 现搜。
 *
 * 三条硬约束（都是刻意的）：
 *   1. **只发问题类型，不发你的会话内容。**
 *      检索词来自 `CAPABILITY_TERMS`（如 `context compression`），
 *      绝不包含会话 id、消息文本、工具输出、文件路径。返回结果里 `sent` 字段
 *      原样列出**实际发出的每一条检索词**，可自行核对。
 *   2. **不能拖死体检。** 总预算 `budgetMs`（默认 12s），超时即停，
 *      带着已拿到的部分返回，并标记 `degraded`；网络全断也只是"本次没搜到"，
 *      而不是报告失败。
 *   3. **不编造。** 拿不到的字段一律 `null` / 缺失，热度只在真取到时才展示。
 *
 * 用法（在 `src/report.mjs` 的 `analyze({ live: true })` 里调用）：
 *   const live = await searchPluginsLive(findings, { budgetMs: 12000 });
 *   // live.entries 与快照条目同构，可直接喂给 searchCatalog({ catalog: entries })
 */

import { fetchJson, mapLimit, UA_LIVE } from './http.mjs';
import {
  CAPABILITY_TERMS,
  deriveCapabilities,
  installOf,
  textOf,
} from './capabilities.mjs';
import { CAPABILITY_BY_METRIC } from './index.mjs';

// 供测试与文档引用「联网时到底可能发出哪些词」的完整词表
export { CAPABILITY_TERMS };

export const LIVE_DEFAULTS = {
  budgetMs: 12000, // 总预算：到点就收手，不阻塞体检
  perRequestMs: 6000, // 单次 HTTP 上限
  npmSize: 60, // 每条 npm 检索式取多少条
  npmQueryCap: 4, // 最多几条检索式（含固定的那条）
  detailLimit: 30, // 最多抓多少个包的 packument
  githubQueryCap: 3,
  githubLimit: 12, // 每条 GitHub 检索式取多少仓库
  concurrency: 6,
  // api.github.com 被 hosts 拦死时改走公共中继（实测 gh-proxy.com 可原样中继 API）
  ghRelays: ['', 'https://gh-proxy.com/'],
};

/** 官方内置包（已随 dsh-base 分发，不该再推荐安装） */
const isOfficialBundle = (name) => /^@deepseek-ai\/dsh($|-)/.test(String(name));

/** 看起来像 DSH 插件吗（npm 全文检索会带回一堆无关包，必须过滤） */
export function looksDsh(pkg) {
  const name = String(pkg?.name ?? '');
  const kw = (pkg?.keywords ?? []).join(' ').toLowerCase();
  const desc = String(pkg?.description ?? '').toLowerCase();
  return (
    /\bdsh\b/i.test(name) ||
    /^dsh-|[-/]dsh-/.test(name) ||
    kw.includes('dsh') ||
    /dsh[- ]?(plugin|hub)|deepseek harness/i.test(`${name} ${desc}`)
  );
}

/** 本轮问题需要哪些能力（去重，并记下是哪个指标提的） */
export function capabilitiesForFindings(findings = []) {
  const byCap = new Map();
  for (const f of findings) {
    for (const cap of CAPABILITY_BY_METRIC[f?.id] ?? []) {
      if (!CAPABILITY_TERMS[cap]) continue; // 没有检索词的能力（内部标签）跳过
      if (!byCap.has(cap)) byCap.set(cap, []);
      byCap.get(cap).push(f.id);
    }
  }
  return [...byCap.entries()].map(([cap, metrics]) => ({ cap, metrics, terms: CAPABILITY_TERMS[cap] }));
}

/**
 * 构造检索式。**这是唯一决定"什么飞出本机"的地方** ——
 * 返回的 `sent` 会被原样写进报告，供核对。
 */
export function buildLiveQueries(findings = [], opts = {}) {
  const o = { ...LIVE_DEFAULTS, ...opts };
  const caps = capabilitiesForFindings(findings);

  // npm：先一条广谱的（抓最新上架的 dsh 插件），再按能力补
  const npm = [`keywords:dsh-plugin`];
  for (const { terms } of caps) {
    for (const t of terms) {
      if (npm.length >= o.npmQueryCap) break;
      if (!npm.includes(t)) npm.push(t);
    }
    if (npm.length >= o.npmQueryCap) break;
  }

  // GitHub：广谱按最近更新 + 按能力关键词
  const github = ['topic:dsh-plugin'];
  for (const { terms } of caps) {
    if (github.length >= o.githubQueryCap) break;
    const t = terms[0];
    if (!github.includes(t)) github.push(`${t} dsh`);
  }

  return { caps, npm, github, sent: [...npm.map((q) => `npm: ${q}`), ...github.map((q) => `github: ${q}`)] };
}

// ---------------------------------------------------------------------------
// HTTP（带总预算）
// ---------------------------------------------------------------------------

function makeBudget(totalMs) {
  const startedAt = Date.now();
  return {
    startedAt,
    /** 还剩多少预算；<=0 表示该收手了 */
    left: () => totalMs - (Date.now() - startedAt),
    expired: () => Date.now() - startedAt >= totalMs,
  };
}

/** GitHub API 中继：直连优先，失败逐个试公共镜像，并记住能用的那个 */
function makeGhClient(relays, perRequestMs) {
  let good = null;
  return {
    get workingRelay() {
      return good;
    },
    async json(pathWithQuery) {
      const order = good !== null ? [good, ...relays.filter((r) => r !== good)] : relays;
      let lastErr = null;
      for (const relay of order) {
        try {
          const doc = await fetchJson(`${relay}https://api.github.com${pathWithQuery}`, {
            timeoutMs: perRequestMs,
            userAgent: UA_LIVE,
          });
          good = relay;
          return doc;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr ?? new Error('无可用 GitHub 通道');
    },
  };
}

// ---------------------------------------------------------------------------
// 条目构造（与 catalog-sync 的 npm 条目同构：报告/面板可直接复用渲染）
// ---------------------------------------------------------------------------

function npmEntry({ pkg, doc }) {
  const latest = doc?.['dist-tags']?.latest ?? pkg.version;
  const ver = doc?.versions?.[latest] ?? {};
  const hub = ver.dshhub ?? ver.dsh?.hub ?? null;
  const caps = deriveCapabilities(textOf(pkg, hub));
  return {
    id: `npm:${pkg.name}`,
    package: pkg.name,
    displayName: hub?.displayName || pkg.name,
    summary: hub?.summary || pkg.description || '(npm 未提供描述)',
    summaryLang: 'en', // 中文覆盖层由目录层统一套用；未覆盖的如实标英文原文
    version: latest ?? null,
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
    license: ver.license ?? doc?.license ?? null,
    publishedAt: doc?.time?.[latest] ?? null,
    heat: {
      weeklyDownloads: pkg.weeklyDownloads ?? null,
      monthlyDownloads: pkg.monthlyDownloads ?? null,
      dependents: pkg.dependents ?? null,
      updatedAt: pkg.date ?? doc?.time?.[latest] ?? null,
      source: 'npm 搜索的下载量统计',
    },
    install: installOf(pkg.name),
    origin: 'npm-live',
    kind: isOfficialBundle(pkg.name) ? 'bundled' : 'community',
    live: true,
    source: {
      type: 'third-party',
      package: pkg.name,
      doc: `npm registry packument（实时抓取；dshhub=${hub ? '有' : '无'}）`,
      via: `本次体检联网现搜（匹配式：${pkg.__query ?? 'n/a'}）`,
      verifiedAt: new Date().toISOString().slice(0, 10),
    },
    risk:
      `本次联网现搜到的社区插件（未逐行审阅源码）。` +
      `安装前请自行看仓库：${(ver.repository && (ver.repository.url || ver.repository)) || pkg.links?.repository || '(未提供)'}`,
    verify: `装完重启，确认「${hub?.displayName || pkg.name}」在插件页处于已启用状态`,
    targets: [],
  };
}

function githubEntry(repo, query) {
  const caps = deriveCapabilities(
    [repo.name, repo.full_name, repo.description, (repo.topics ?? []).join(' ')].filter(Boolean).join(' \n '),
  );
  const slug = repo.full_name;
  return {
    id: `github:${slug}`,
    package: slug,
    displayName: slug,
    summary: repo.description || '(仓库未提供描述)',
    summaryLang: 'en',
    keywords: repo.topics ?? [],
    capabilities: [...new Set(caps.map((c) => c.cap))],
    capabilityEvidence: caps,
    repo: `https://github.com/${slug}`,
    install: {
      gui: `按仓库 README 安装（本工具不代装）—— https://github.com/${slug}`,
      cli: `git clone https://github.com/${slug}.git   # 再按仓库说明挂载`,
    },
    heat: {
      stars: repo.stargazers_count ?? null,
      forks: repo.forks_count ?? null,
      updatedAt: repo.pushed_at ?? repo.updated_at ?? null,
      source: 'GitHub API（实时）',
    },
    origin: 'github-live',
    kind: 'community',
    live: true,
    source: {
      type: 'third-party',
      package: slug,
      doc: 'GitHub 仓库（实时检索；只核实仓库存在与元数据，未审阅源码）',
      via: `本次体检联网现搜（匹配式：${query}）`,
      verifiedAt: new Date().toISOString().slice(0, 10),
    },
    risk: `来自 GitHub（未发 npm；只核实了仓库存在与元数据，未审阅源码）。安装需按仓库 README 自行操作：https://github.com/${slug}`,
    verify: '按仓库 README 挂载后重启，确认出现在插件页',
    targets: [],
  };
}

// ---------------------------------------------------------------------------
// 两个来源
// ---------------------------------------------------------------------------

async function liveNpm(queries, o, budget, errors, sink) {
  const hits = new Map(); // name → pkg（带 __query 记录命中来源）
  for (const q of queries) {
    if (budget.expired()) break;
    sink.searched = (sink.searched ?? 0) + 1;
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${o.npmSize}`;
    let doc;
    try {
      doc = await fetchJson(url, {
        timeoutMs: Math.min(o.perRequestMs, Math.max(1000, budget.left())),
        userAgent: UA_LIVE,
      });
    } catch (e) {
      errors.push(`npm 检索「${q}」失败：${e.message}`);
      continue;
    }
    for (const obj of doc.objects ?? []) {
      const pkg = obj.package ?? {};
      // 全文检索会带回大量无关包：必须是 DSH 插件，且不是已内置的官方包
      if (!looksDsh(pkg)) continue;
      if (isOfficialBundle(pkg.name)) continue;
      const prev = hits.get(pkg.name);
      if (prev) {
        prev.__query = `${prev.__query} + ${q}`;
        continue;
      }
      hits.set(pkg.name, { ...pkg, weeklyDownloads: obj.downloads?.weekly ?? null, monthlyDownloads: obj.downloads?.monthly ?? null, dependents: obj.dependents ?? null, __query: q });
    }
  }

  // 按真实周下载量排序后取前 N 抓 packument（拿 dshhub 元数据与能力标签）
  const candidates = [...hits.values()].sort(
    (a, b) => (b.weeklyDownloads ?? -1) - (a.weeklyDownloads ?? -1),
  );
  const detail = candidates.slice(0, o.detailLimit);
  sink.candidates = candidates.length;

  // 边抓边写进 sink：预算耗尽被强停时，已拿到的条目**不能丢**
  // （踩过的坑：超时后整条 npm 通道被丢弃，一次丢掉 26 条）
  const entries = [];
  sink.entries = entries;

  await mapLimit(detail, o.concurrency, async (p) => {
    if (budget.expired()) return { error: '预算用尽' };
    let doc;
    try {
      doc = await fetchJson(
        `https://registry.npmjs.org/${encodeURIComponent(p.name).replace('%40', '@')}`,
        {
          timeoutMs: Math.min(o.perRequestMs, Math.max(1000, budget.left())),
          userAgent: UA_LIVE,
        },
      );
    } catch (e) {
      // aborted = 预算到点被掐断，不算异常；真实 HTTP 错误才记录
      if (!/abort/i.test(e.message)) errors.push(`npm packument「${p.name}」失败：${e.message}`);
      return { error: e.message };
    }
    try {
      entries.push(npmEntry({ pkg: p, doc }));
    } catch (e) {
      errors.push(`npm 条目「${p.name}」解析失败：${e.message}`);
    }
    return { ok: true };
  });

  return { entries, candidates: candidates.length, searched: sink.searched ?? 0 };
}

async function liveGithub(queries, o, budget, errors, sink) {
  const gh = makeGhClient(o.ghRelays, o.perRequestMs);
  const seen = new Map();
  for (const q of queries) {
    if (budget.expired()) break;
    sink.searched = (sink.searched ?? 0) + 1;
    const path =
      `/search/repositories?q=${encodeURIComponent(q)}` +
      `&sort=${q.includes('topic:') ? 'updated' : 'stars'}&per_page=${o.githubLimit}`;
    let doc;
    try {
      doc = await gh.json(path);
    } catch (e) {
      errors.push(`GitHub 检索「${q}」失败：${e.message}`);
      continue;
    }
    for (const repo of doc.items ?? []) {
      const slug = repo.full_name;
      if (!slug || seen.has(slug)) continue;
      // 相关性：DSH 主题标签、或名称/描述里真的提到 dsh / deepseek harness
      const text = `${repo.name} ${slug} ${repo.description ?? ''} ${(repo.topics ?? []).join(' ')}`;
      if (!/dsh|deepseek[- ]?harness/i.test(text)) continue;
      seen.set(slug, { ...repo, __query: q });
    }
    // 每检索完一式就刷新 sink：被预算强停时保留已完成的部分
    sink.entries = [...seen.values()].map((r) => githubEntry(r, r.__query));
    sink.candidates = seen.size;
    sink.relay = gh.workingRelay;
  }
  const entries = sink.entries ?? [];
  return { entries, candidates: seen.size, relay: gh.workingRelay, searched: sink.searched ?? 0 };
}

/**
 * 联网现搜主入口。
 *
 * 永不抛：任何一条通道失败都只记录到 `errors` 并降级，体检继续。
 *
 * @returns {Promise<{
 *   entries:Array, caps:Array, queries:{npm:Array, github:Array}, sent:Array,
 *   stats:Object, errors:Array, degraded:boolean, elapsedMs:number, fetchedAt:string
 * }>}
 */
export async function searchPluginsLive(findings = [], opts = {}) {
  const o = { ...LIVE_DEFAULTS, ...opts };
  o.ghRelays = opts.ghRelays ?? LIVE_DEFAULTS.ghRelays;
  const budget = makeBudget(o.budgetMs);
  const errors = [];
  const { caps, npm, github, sent } = buildLiveQueries(findings, o);

  let npmRes = { entries: [], candidates: 0, searched: 0 };
  let ghRes = { entries: [], candidates: 0, relay: null, searched: 0 };

  if (opts.network === false) {
    errors.push('已禁用联网（--no-network）');
  } else if (findings.length === 0) {
    errors.push('本次没有发现问题，未发起联网检索');
  } else {
    // 两条通道并行，各自独立降级。
    // ⚠️ 必须有**硬截止**：单看每请求超时是不够的（实测 12s 预算跑了 14.7s，
    //    因为并发里的在途请求会拖过预算）。到点就带着已拿到的部分返回。
    let timedOut = false;
    // sink 是**可增量读取的共享状态**：通道每拿到一点就写进来，
    // 所以即使被强停，已抓到的条目也不会丢。
    const sink = {
      npm: { entries: [], candidates: 0, searched: 0, relay: null },
      gh: { entries: [], candidates: 0, searched: 0, relay: null },
    };
    const work = Promise.all([
      liveNpm(npm, o, budget, errors, sink.npm)
        .then((r) => {
          sink.npm = r;
        })
        .catch((e) => {
          errors.push(`npm 通道异常：${e.message}`);
        }),
      liveGithub(github, o, budget, errors, sink.gh)
        .then((r) => {
          sink.gh = r;
        })
        .catch((e) => {
          errors.push(`GitHub 通道异常：${e.message}`);
        }),
    ]);
    const timer = new Promise((resolve) => setTimeout(resolve, o.budgetMs + 250));
    await Promise.race([work, timer]).then(() => {
      timedOut = budget.expired();
    });
    npmRes = {
      entries: sink.npm.entries ?? [],
      candidates: sink.npm.candidates ?? 0,
      searched: sink.npm.searched ?? 0,
    };
    ghRes = {
      entries: sink.gh.entries ?? [],
      candidates: sink.gh.candidates ?? 0,
      searched: sink.gh.searched ?? 0,
      relay: sink.gh.relay ?? null,
    };
    if (timedOut) {
      errors.push(
        `超出 ${o.budgetMs}ms 预算已停止检索（采用已抓到的部分：npm ${npmRes.entries.length} 条 / GitHub ${ghRes.entries.length} 条）`,
      );
    }
  }

  // 同名去重：npm 优先（有版本/下载量这类可核对的数据），GitHub 条目按包名并列
  const byName = new Map();
  for (const e of [...npmRes.entries, ...ghRes.entries]) {
    if (!byName.has(e.package)) byName.set(e.package, e);
  }
  const entries = [...byName.values()];

  return {
    entries,
    caps,
    queries: { npm, github },
    sent,
    // 本次**是否真的发出过请求**。`--no-network` / 没有问题时为 false ——
    // 报告页脚与面板标签据此措辞，避免"没联网却写已联网"。
    networked: !(opts.network === false) && findings.length > 0,
    stats: {
      npmCandidates: npmRes.candidates,
      npmEntries: npmRes.entries.length,
      npmQueries: npmRes.searched,
      githubCandidates: ghRes.candidates,
      githubEntries: ghRes.entries.length,
      githubQueries: ghRes.searched,
      githubRelay: ghRes.relay ?? null,
      kept: entries.length,
    },
    errors,
    degraded: errors.length > 0 || budget.expired(),
    elapsedMs: Date.now() - budget.startedAt,
    fetchedAt: new Date().toISOString(),
  };
}
