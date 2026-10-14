/**
 * 插件目录层 —— 「按能力检索插件」而不是「背一份固定推荐清单」
 *
 * 背景（用户反馈）：
 *   「还要能够检索插件目录进行针对性推荐，例如 billion-context 可以压缩上下文
 *     省 token，就可以建议出来」
 *
 *   旧做法是每条处方在 remedies.mjs 里硬绑 targets，插件只能出现在它被显式
 *   绑定的那个指标上。一旦某个指标没有绑定（例如 C1 的 output 侧），
 *   即使用户的问题描述里明摆着写着"上下文/token"，也没有任何插件会被推荐出来。
 *
 * 现在改成两层：
 *   1. **指标靶子**（entry.targets）：确定对症，最高优先级
 *   2. **能力标签 + 关键词检索**（entry.capabilities / entry.keywords × finding 文本）：
 *      泛化匹配，并且**必须说明为什么匹配**（matchedOn），不做黑盒推荐
 *
 * ⚠️ 2026-10-16 用户追问：「billion-context 是你告诉我的，还是真正从插件目录检索出来的？」
 *    当时的诚实回答是：**目录是人工写死的白名单**，billion-context 来自用户点名 + 我事后核实。
 *    现在目录有**两个来源**，每条都标出处：
 *      - `curated`：人工核实并写进本文件的条目（数量少，但每条都读过文档）
 *      - `npm-registry`：`./run.sh catalog-sync` 从 npm registry 按
 *        `keywords:dsh-plugin` 同步下来的真实插件清单（快照存在
 *        ~/.agent-clinic/catalog.snapshot.json，用户显式执行才联网）
 *    内置条目优先（同包名时覆盖 registry 条目，因为人工读过它的文档）。
 *
 * 硬性纪律（继承 2026-10-14 的事故教训）：
 *   - 目录里只放**核实过的包**（随附插件给出包内文档出处，社区插件给出 npm 复核方式）
 *   - 检索不到就诚实说"没有对症插件"，绝不为了有话说而编一条
 *   - 已安装的插件不推"安装"，改为提示"确认已启用 / 检查配置"
 *
 * 本模块**零外发**：只读本地 profile、node_modules 与同步快照，自己不联网。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProfileDir } from '../config/index.mjs';
import {
  GENERAL_CAPABILITIES,
  domainOfEntry,
} from './capabilities.mjs';

/** 目录版本（人工核实日），报告里会显示，便于判断推荐是否过期 */
export const CATALOG_VERSION = '2026-10-16';

/** npm 同步快照的默认落盘位置（由 `./run.sh catalog-sync` 生成） */
export const SNAPSHOT_PATH = path.join(os.homedir(), '.agent-clinic', 'catalog.snapshot.json');

/** 中文简介覆盖层（离线、人工翻译、可复核；不含机器翻译） */
export const I18N_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n.zh.json');

let _i18n = null;
function i18nTable() {
  if (_i18n) return _i18n;
  try {
    const raw = JSON.parse(fs.readFileSync(I18N_PATH, 'utf8'));
    delete raw._comment;
    _i18n = raw;
  } catch {
    _i18n = {};
  }
  return _i18n;
}

/**
 * 套用中文简介。
 *
 * 为什么要有这一层：npm / GitHub 同步进来的插件描述大多只有英文
 * （用户反馈"标出的插件简介需要翻译为中文"）。这里用**人工维护的覆盖层**
 * 提供中文简介；没覆盖到的条目**原样保留英文**，并在 `summaryLang` 上如实标注，
 * 不用机器翻译糊弄。
 */
export function applyTranslation(entry) {
  const t = i18nTable()[entry.package];
  if (!t) {
    return { ...entry, summaryLang: /[\u4e00-\u9fff]/.test(entry.summary ?? '') ? 'zh' : 'en' };
  }
  return {
    ...entry,
    displayName: t.displayName || entry.displayName,
    summaryOriginal: entry.summary,
    summary: t.summary,
    summaryLang: 'zh',
  };
}

/**
 * 指标 → 能力标签。
 *
 * 检索时先看这一层：某个指标的问题，应该由具备哪些能力的插件来解决。
 * 它让"推荐"这件事有据可依（匹配理由会原样打印给用户）。
 */
export const CAPABILITY_BY_METRIC = {
  C1: ['token-saving', 'cost'],
  C2: ['context-compaction', 'token-saving'],
  C3: ['context-compaction', 'long-session', 'token-saving'],
  E1: ['loop-guard'],
  E2: ['loop-guard', 'tool-hygiene'],
  E4: ['planning'],
  E5: ['loop-guard', 'tool-hygiene'],
  N1: ['safety', 'sandbox'],
  N2: ['safety'],
  A2: ['skill-asset'],
  A3: ['skill-asset', 'automation'],
  A4: ['subagent-control', 'cost'],
  // 类别兜底：指标没单独列时按大类给能力
  _category: {
    C: ['token-saving'],
    E: ['tool-hygiene'],
    N: ['safety'],
    A: ['skill-asset'],
  },
};

/**
 * 已核实插件目录。
 *
 * 每条都带 source（核实方式 + 日期）。新增条目必须先核实再写进来 ——
 * 这条纪律来自 2026-10-14 的事故：当时四条"插件"经 GitHub API 核实**不存在**。
 */
export const PLUGIN_CATALOG = [
  {
    id: 'billion-context-dsh',
    package: 'billion-context-dsh',
    displayName: 'Billion Context（ACP 上下文压缩）',
    summary:
      '模型驱动的上下文压缩：由模型自己决定压缩什么、何时压缩，摘要由模型书写（不额外调用摘要模型），把长会话的 token 压下来',
    capabilities: ['context-compaction', 'long-session', 'token-saving'],
    keywords: ['上下文', '压缩', 'token', '长会话', '膨胀', 'context', 'compaction', '上下文膨胀', '消耗'],
    targets: ['C2', 'C3'],
    repo: 'https://github.com/Tyan66666/billion-context-dsh',
    version: '0.2.27',
    compatibility: { dsh: '>=0.1.5-alpha.1 <0.2.1-0', node: '>=20' },
    install: {
      gui: '侧边栏 → 插件 → 添加插件 → 粘贴 billion-context-dsh',
      cli: 'dsh plugin --profile <你的 profile> add billion-context-dsh',
    },
    risk:
      '作者在 README 顶部明确写「测试版，请勿用于工程化/生产环境」；安装后会禁用 host 的 compaction-basic 并接管压缩，且对 DSH 版本有 peer 区间要求。想稳就别装它。',
    verify: '装完重启，新会话里让模型调用 acp_status 自证挂载',
    source: {
      type: 'third-party',
      package: 'billion-context-dsh',
      doc: 'npm 包元数据（v0.2.27）+ README「安装」',
      via: 'npm view billion-context-dsh version（registry.npmjs.org）',
      verifiedAt: '2026-10-15',
    },
  },
  {
    id: 'smart-compaction',
    package: 'smart-compaction',
    displayName: 'Smart Compaction（模型择机压缩 + 用量可见）',
    summary:
      '给模型 compact_now 工具，让它在自己判断的安全点压缩上下文（回合中途也可用），并提供 context_status 报告真实 token 用量；todo 勾完且上下文过半时自动压缩',
    capabilities: ['context-compaction', 'long-session', 'token-saving', 'observability'],
    keywords: ['上下文', '压缩', 'token', '长会话', '用量', 'context', 'compaction', '消耗'],
    targets: ['C2', 'C3'],
    repo: 'https://github.com/JoblessJoe/smart-compaction',
    version: '0.3.10',
    compatibility: { dsh: '>=0.1.5-rc.3', node: '>=22' },
    install: {
      gui: '侧边栏 → 插件 → 添加插件 → 粘贴 smart-compaction',
      cli: 'dsh plugin --profile <你的 profile> add smart-compaction --allow-build=smart-compaction',
    },
    risk:
      '社区插件（MIT）；desktop profile 由应用独占，只能用界面安装，装完需完全重启 Harness；它只挂在 DSH 公开的 compaction API 上，不改动核心。',
    verify: '装完重启，让会话调用 context_status，应报告类似 "~42,300 / 77,824 tokens used"',
    source: {
      type: 'third-party',
      package: 'smart-compaction',
      doc: 'npm 包元数据 dsh.bundle.patch + README（v0.3.10）',
      via: 'npm view smart-compaction version（registry.npmjs.org）',
      verifiedAt: '2026-10-15',
    },
  },
  {
    id: 'modsearch',
    package: '@liustack/modsearch',
    displayName: 'modsearch（免费联网检索）',
    summary: '给模型补上免费联网检索能力（web search / 页面抓取），无需 API key',
    capabilities: ['web-search', 'network'],
    keywords: ['联网', '搜索', '抓取', 'web', '检索', '网络'],
    targets: [],
    repo: 'https://github.com/liustack/modsearch',
    install: { gui: '侧边栏 → 插件 → 添加插件 → 粘贴 @liustack/modsearch', cli: 'dsh plugin add @liustack/modsearch' },
    risk: '仅在你确实缺少联网能力时才有意义；与本工具的 token/循环类指标不对症。',
    verify: '装完重启，让会话做一次 web_search',
    source: {
      type: 'third-party',
      package: '@liustack/modsearch',
      doc: 'GitHub 仓库存在性核实（2026-10-14）',
      via: 'GitHub API /repos/<owner>/<repo>',
      verifiedAt: '2026-10-14',
    },
  },
  {
    id: 'dsh-taskboard',
    package: '@shengsheng/dsh-taskboard',
    displayName: 'DSH Taskboard（本地任务看板）',
    summary: '本地任务看板，把长任务的计划与状态显式化，减少 Agent 自己维护计划时的遗漏',
    capabilities: ['planning', 'task-board'],
    keywords: ['计划', '任务', 'todo', '看板', '脱节', '步骤'],
    targets: ['E4'],
    repo: 'https://github.com/shengsheng90/DSH-taskboard',
    install: { gui: '侧边栏 → 插件 → 添加插件 → 粘贴 @shengsheng/dsh-taskboard', cli: 'dsh plugin add @shengsheng/dsh-taskboard' },
    risk: '它把计划显式化，但不能强迫 Agent 更新状态 —— 仍需配合"边做边更新"的行为约定。',
    verify: '装完重启，看板里应能看到任务的推进状态',
    source: {
      type: 'third-party',
      package: '@shengsheng/dsh-taskboard',
      doc: 'GitHub 仓库存在性核实（2026-10-14）',
      via: 'GitHub API /repos/<owner>/<repo>',
      verifiedAt: '2026-10-14',
    },
  },
  {
    id: 'dsh-skill-hub',
    package: 'dsh-skill-hub',
    displayName: 'DSH Skill Hub（本地技能目录浏览）',
    summary: '在 Web GUI 里浏览 / 搜索已安装的本地技能目录，便于清理闲置技能与复用已有技能',
    capabilities: ['skill-asset'],
    keywords: ['skill', '技能', '闲置', '目录', '复用'],
    targets: ['A2', 'A3'],
    repo: 'https://github.com/cheshireez/dsh-skill-hub',
    install: { gui: '侧边栏 → 插件 → 添加插件 → 粘贴 dsh-skill-hub', cli: 'dsh plugin add dsh-skill-hub' },
    risk: '只是浏览入口，不改变技能本身的装载行为。',
    verify: '装完重启，插件页应出现技能浏览入口',
    source: {
      type: 'third-party',
      package: 'dsh-skill-hub',
      doc: 'GitHub 仓库存在性核实（2026-10-14）',
      via: 'GitHub API /repos/<owner>/<repo>',
      verifiedAt: '2026-10-14',
    },
  },
];

// ---------------------------------------------------------------------------
// 目录来源：内置已核实条目 + npm 同步快照
// ---------------------------------------------------------------------------

/** 给内置条目补上 origin 标记 */
const CURATED = PLUGIN_CATALOG.map((e) => ({ ...e, origin: 'curated' }));

/**
 * 读取同步快照（npm + GitHub；不存在或损坏都返回 null，绝不抛）。
 * @returns {{entries:Array, fetchedAt:string, source:string, file:string}|null}
 */
export function loadRegistrySnapshot(file = SNAPSHOT_PATH) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(doc.entries) ? doc.entries : [];
    return {
      entries: entries.map((e) =>
        applyTranslation({
          ...e,
          origin: e.origin ?? 'npm-registry',
          // 同步进来的条目没有人工读过的 targets，只靠能力与关键词命中
          targets: e.targets ?? [],
          risk:
            e.risk ??
            (e.origin === 'github'
              ? `来自 GitHub（未发 npm；本工具只核实了仓库存在与 package.json 元数据，未审阅源码）。` +
                `安装需按仓库 README 自行操作：${e.repo ?? ''}`
              : `社区插件（来自 npm 同步，${e.hasDshBundlePatch ? '含 dsh.bundle.patch' : '未见 dsh.bundle.patch'}）。` +
                `未逐行审阅源码 —— 安装前请自行看仓库：${e.repo ?? '(未提供)'}`),
          verify: e.verify ?? `装完重启，确认「${e.displayName}」在插件页处于已启用状态`,
        }),
      ),
      fetchedAt: doc.fetchedAt ?? null,
      source: typeof doc.source === 'string' ? doc.source : JSON.stringify(doc.source ?? ''),
      file,
    };
  } catch {
    return null;
  }
}

/**
 * 生效目录 = 快照条目 + 内置已核实条目（同包名时内置优先）。
 *
 * @returns {{entries:Array, sources:Object}}
 */
export function activeCatalog(opts = {}) {
  const snap = opts.snapshot === null ? null : loadRegistrySnapshot(opts.snapshotPath ?? SNAPSHOT_PATH);
  const curatedNames = new Set(CURATED.map((e) => e.package));
  const synced = (snap?.entries ?? []).filter((e) => !curatedNames.has(e.package));
  return {
    entries: [...CURATED.map(applyTranslation), ...synced],
    sources: {
      curated: CURATED.length,
      registry: synced.filter((e) => e.origin === 'npm-registry').length,
      github: synced.filter((e) => e.origin === 'github').length,
      snapshotAt: snap?.fetchedAt ?? null,
      snapshotSource: snap?.source ?? null,
      snapshotPath: snap?.file ?? (opts.snapshotPath ?? SNAPSHOT_PATH),
    },
  };
}

// ---------------------------------------------------------------------------
// 本地插件目录（只读扫描）
// ---------------------------------------------------------------------------

/**
 * 扫描本地已装的插件 / bundle —— 这是"检索插件目录"里的**目录**。
 *
 * 只看两处，都是只读：
 *   1. profile 的 package.json：dsh.profile.bundles + dependencies
 *   2. profile 的 node_modules 顶层目录名（跳过 .pnpm / .bin 等）
 *
 * @returns {{profileDir:string|null, dirExists:boolean, installed:string[], versions:Object, error?:string}}
 */
export function scanInstalledPlugins(env = process.env) {
  const profileDir = resolveProfileDir(env);
  const out = { profileDir, dirExists: false, installed: [], versions: {}, error: null };
  if (!profileDir) {
    out.error = '未找到 profile 目录';
    return out;
  }

  const names = new Set();
  const versions = {};

  // 1) profile package.json
  try {
    const pkgPath = path.join(profileDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    out.dirExists = true;
    for (const b of pkg?.dsh?.profile?.bundles ?? []) {
      if (typeof b === 'string') names.add(b);
    }
    for (const [k, v] of Object.entries(pkg?.dependencies ?? {})) {
      names.add(k);
      if (typeof v === 'string') versions[k] = v;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') out.error = `读取 profile package.json 失败：${e.message}`;
  }

  // 2) node_modules 顶层
  try {
    const nm = path.join(profileDir, 'node_modules');
    for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue; // .bin / .pnpm / .modules.yaml
      if (entry.name.startsWith('@')) {
        try {
          const scopeDir = path.join(nm, entry.name);
          for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
            if (sub.isDirectory() || sub.isSymbolicLink()) names.add(`${entry.name}/${sub.name}`);
          }
        } catch {
          /* 读不到就跳过，不猜 */
        }
        continue;
      }
      names.add(entry.name);
    }
    out.dirExists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') out.error = `读取 node_modules 失败：${e.message}`;
  }

  out.installed = [...names].sort();
  out.versions = versions;
  return out;
}

/** 某个包是否已安装（@scope/name 与裸名都能对上） */
export function isInstalled(pkgName, installedList) {
  if (!pkgName) return false;
  const list = installedList ?? [];
  const bare = pkgName.replace(/^@[^/]+\//, '');
  return list.some((n) => n === pkgName || n === bare || n.endsWith(`/${bare}`));
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

/** 从 finding 里抽出可检索的文本 */
function findingText(finding) {
  return [finding.id, finding.title, finding.summary, finding.category, finding.tool]
    .filter(Boolean)
    .join(' ');
}

/**
 * 热度：把「较多人推荐」（GitHub star / npm 周下载量）折算成一个可比较的数。
 *
 * 契约上的诚实之处：**热度只做同分时的排序参考，不参与打分**——
 * 一个插件能不能解决问题，靠的是它的指标/能力标签；热度只回答
 * 「在同样对症的几个插件里，先看哪个」。拿不到热度数据时返回 0，
 * 不猜测、不编造。
 */
export function heatScore(entry) {
  const h = entry?.heat ?? {};
  if (typeof h.stars === 'number') return 1000 + Math.min(h.stars, 50000);
  if (typeof h.weeklyDownloads === 'number') return 500 + Math.min(h.weeklyDownloads, 50000);
  return 0;
}

/**
 * 同分时的排序优先级：人工核实 0 → 社区插件 1 → 官方内置包 2。
 *
 * 内置包（`@deepseek-ai/dsh-*`）多半已经随 dsh-base 挂载好了，
 * 把它们排在社区插件前面等于让用户去看自己已经装过的东西。
 */
function rankKind(entry) {
  if ((entry.origin ?? 'curated') === 'curated') return 0;
  return entry.kind === 'bundled' ? 2 : 1;
}

/** 条目种类的中文标注（界面/报告共用；没有 kind 的老条目按时长最长的"第三方"处理） */
export function kindLabel(entry) {
  if ((entry?.origin ?? 'curated') === 'curated') return '人工核实';
  if (entry?.kind === 'bundled') return '官方内置包';
  return '社区插件';
}

/** 热度的可读文案（界面/报告都用它，避免两处各写一份口径） */
export function formatHeat(entry) {
  const h = entry?.heat;
  if (!h) return null;
  const parts = [];
  if (typeof h.stars === 'number') parts.push(`★ ${h.stars}`);
  if (typeof h.forks === 'number' && h.forks > 0) parts.push(`fork ${h.forks}`);
  if (typeof h.weeklyDownloads === 'number') parts.push(`周下载 ${h.weeklyDownloads}`);
  if (typeof h.monthlyDownloads === 'number') parts.push(`月下载 ${h.monthlyDownloads}`);
  if (typeof h.dependents === 'number' && h.dependents > 0) parts.push(`被 ${h.dependents} 个包依赖`);
  if (h.updatedAt) parts.push(`最近更新 ${String(h.updatedAt).slice(0, 10)}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * 按能力检索目录，为一个 finding 找出相关插件。
 *
 * 打分（可解释，不做黑盒推荐）：
 *   +5  指标在 entry.targets 里（确定对症）
 *   +3  能力标签命中该指标的能力表
 *   +2  每个关键词出现在问题文本里（最多计 3 个）
 *
 * @returns {Array<{entry:Object, score:number, reasons:string[], installed:boolean}>}
 */
export function matchPlugins(finding, opts = {}) {
  const catalog = opts.catalog ?? activeCatalog(opts).entries;
  const installedList = opts.installed ?? [];
  const limit = opts.limit ?? 3;
  const text = findingText(finding);

  const wanted = [
    ...(CAPABILITY_BY_METRIC[finding.id] ?? []),
    ...((CAPABILITY_BY_METRIC._category ?? {})[finding.category] ?? []),
  ];

  const hits = [];
  const offDomain = [];
  for (const entry of catalog) {
    // npm / GitHub 同步进来的条目没有人工读过文档，门槛更高：单个泛能力标签不算数。
    // （踩过的坑：某会话分支插件因描述里出现一次 "retry" 被当作循环防护推给 E5）
    const isAudited = (entry.origin ?? 'curated') === 'curated';
    const minScore = opts.minScore ?? (isAudited ? 3 : 5);
    let score = 0;
    const reasons = [];

    if ((entry.targets ?? []).includes(finding.id)) {
      score += 5;
      reasons.push(`它的适用指标里明确写了 ${finding.id}（${finding.title ?? ''}）`);
    }

    // 窄领域插件不得用"通用基础设施能力"对症通用问题 —— 它的省 token / 降成本
    // 通常指它自己那条流水线（用户报的噪音：视频插件因描述里的一句
    // "token 压缩 99.95%" 被推荐给 C1 token 消耗过快）。
    // 人工核实过的条目豁免：那是人读过后给出的判断，不由文本推断。
    const domain = isAudited ? null : domainOfEntry(entry);
    const capHitsAll = (entry.capabilities ?? []).filter((c) => wanted.includes(c));
    const capHits = domain ? capHitsAll.filter((c) => !GENERAL_CAPABILITIES.has(c)) : capHitsAll;
    const droppedCaps = capHitsAll.length - capHits.length;
    if (droppedCaps > 0) {
      offDomain.push({
        package: entry.package,
        displayName: entry.displayName ?? entry.package,
        domain: domain.domain,
        domainLabel: domain.label,
        domainMatched: domain.matched,
        domainVia: domain.via ?? null,
        droppedCaps: capHitsAll.filter((c) => GENERAL_CAPABILITIES.has(c)),
      });
    }

    if (capHits.length) {
      // 命中多个能力标签才算强信号（每个 +3，最多计 2 个）
      score += Math.min(capHits.length, 2) * 3;
      const evidence = (entry.capabilityEvidence ?? [])
        .filter((e) => capHits.includes(e.cap))
        .map((e) => `「${e.matched}」`)
        .join('、');
      reasons.push(
        `能力标签 ${capHits.map((c) => `「${c}」`).join('、')} 对上 ${finding.id} 需要的能力` +
          (evidence ? `（依据目录里的描述命中 ${evidence}）` : ''),
      );
    }

    const kwHits = [];
    for (const kw of entry.keywords ?? []) {
      if (kw.length >= 2 && text.includes(kw)) kwHits.push(kw);
      if (kwHits.length >= 3) break;
    }
    if (kwHits.length) {
      score += 2 * kwHits.length;
      reasons.push(`你的问题描述里出现了 ${kwHits.map((k) => `「${k}」`).join('、')}`);
    }

    if (score < minScore) continue;
    hits.push({
      entry,
      score,
      reasons,
      installed: isInstalled(entry.package, installedList),
      origin: entry.origin ?? 'curated',
    });
  }

  const result = hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        // 同分时：人工核实过的优先（我们能担保其行为），再按热度
        Number((b.origin ?? 'curated') === 'curated') - Number((a.origin ?? 'curated') === 'curated') ||
        rankKind(a.entry) - rankKind(b.entry) ||
        heatScore(b.entry) - heatScore(a.entry) ||
        String(a.entry.id).localeCompare(String(b.entry.id)),
    )
    .slice(0, limit);
  // 挂上"因域外被扣分"的清单，供报告如实披露（不是静默丢弃）
  result.offDomain = offDomain;
  return result;
}

/**
 * 为一批 finding 做插件检索。
 *
 * 返回两套视图：
 *   - `matches`：按 finding 分组（用于"这个问题命中什么"）
 *   - `recommendations`：**按插件去重**（同一个插件只出现一次，列出它命中的
 *     所有指标）—— 修掉"billion-context 出现三次"的重复展示
 */
export function searchCatalog(findings, opts = {}) {
  const scan = opts.scan ?? scanInstalledPlugins(opts.env ?? process.env);
  const active = opts.catalog ? { entries: opts.catalog, sources: null } : activeCatalog(opts);
  const catalog = active.entries;
  const matches = {};
  const byPackage = new Map();
  // 因"窄领域蹭通用能力词"被扣分/排除的插件（如实披露，不静默丢弃）
  const offDomainFiltered = new Map();

  for (const f of findings) {
    const hits = matchPlugins(f, { catalog, installed: scan.installed, ...opts });
    for (const od of hits.offDomain ?? []) {
      const key = od.package;
      const prev = offDomainFiltered.get(key);
      if (prev) {
        prev.caps = [...new Set([...prev.caps, ...od.droppedCaps])];
      } else {
        offDomainFiltered.set(key, { ...od, caps: od.droppedCaps, findingIds: [f.id] });
      }
    }
    // 用户要求：**已经安装的就不再显示推荐** —— 直接过滤掉，不再以"已装"形式出现
    const fresh = hits.filter((h) => !h.installed);
    if (!fresh.length) continue;
    matches[f.id] = fresh;
    for (const h of fresh) {
      const key = h.entry.package;
      if (!byPackage.has(key)) {
        byPackage.set(key, {
          id: h.entry.id,
          package: h.entry.package,
          displayName: h.entry.displayName,
          summary: h.entry.summary,
          capabilities: h.entry.capabilities ?? [],
          capabilityEvidence: h.entry.capabilityEvidence ?? [],
          repo: h.entry.repo ?? null,
          version: h.entry.version ?? null,
          install: h.entry.install ?? null,
          risk: h.entry.risk ?? null,
          origin: h.origin,
          hasDshBundlePatch: h.entry.hasDshBundlePatch ?? null,
          verifiedAt: h.entry.source?.verifiedAt ?? null,
          sourceVia: h.entry.source?.via ?? null,
          installed: h.installed,
          score: h.score,
          heat: h.entry.heat ?? null,
          heatText: formatHeat(h.entry),
          summaryLang: h.entry.summaryLang ?? null,
          kind: h.entry.kind ?? null,
          kindText: kindLabel(h.entry),
          // 同一个插件命中多个指标时，在这里一次性列全
          findingIds: [f.id],
          reasons: [...h.reasons],
        });
      } else {
        const rec = byPackage.get(key);
        if (!rec.findingIds.includes(f.id)) rec.findingIds.push(f.id);
        rec.score = Math.max(rec.score, h.score);
        for (const r of h.reasons) {
          if (!rec.reasons.includes(r)) rec.reasons.push(r);
        }
      }
    }
  }

  // 排序：先看对症程度（score），同分再看人工核实、社区优先与热度 —— 热度不参与打分
  const recommendations = [...byPackage.values()].sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.origin === 'curated') - Number(a.origin === 'curated') ||
      rankKind(a) - rankKind(b) ||
      heatScore({ heat: b.heat }) - heatScore({ heat: a.heat }),
  );

  return {
    matches,
    recommendations,
    // 域外扣分清单：报告里会写明"挡掉了哪些、为什么"
    offDomainFiltered: [...offDomainFiltered.values()],
    installed: scan,
    catalogSize: catalog.length,
    catalogVersion: CATALOG_VERSION,
    sources: active.sources,
  };
}

/**
 * 把一批 finding 做插件检索并**按插件去重**（旧的分组视图仅供兼容）。
 *
 * @deprecated 使用 searchCatalog()，它同时返回 matches 与 recommendations
 */

