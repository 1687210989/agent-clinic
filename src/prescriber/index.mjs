/**
 * L4 处方层 —— 问题 → 可执行处方
 *
 * 单一事实来源：`remedies.mjs`（处方目录，带出处与风险）+
 * `src/config`（本机真实生效配置）。
 *
 * 本模块负责三件事：
 *   1. **匹配**：finding 的指标 ID → 对症处方（插件 > 配置 > 命令 > 设置 > 行为）
 *   2. **落地**：把处方渲染成"当前值 → 建议值 + 可粘贴片段"
 *   3. **自我否决**：当前值已经不弱于建议值时，撤掉那条处方（宁可少给，不给废话）
 *
 * ⚠️ 2026-10-14 的历史纪律仍然有效：**没有对症插件就不编插件**。
 *    当时池里 caveman / Superpowers / claude-mem / deja-vu 四条经 GitHub API
 *    核实为不存在，已全部移除；池中只保留核实过的仓库。
 *
 * ⚠️ 2026-10-15 修正（本文件被重写的原因）：
 *    旧版本的 `PRESCRIPTIONS` 三条插件 `targets` 全是 `[]`，`prescribeOne`
 *    的插件分支**永远匹配不上**，于是 C1/C2 这类成本问题只能落到"行为建议"。
 *    用户反馈原文："定位到了问题但是没有给出可行的解决方案，例如 token 消耗
 *    过高，但是没有给出可以省 token 的插件推荐。"
 *    现在每条处方都声明 targets，并且指向**本机真实存在的**开关：
 *      · 随附插件（spill / pruner / repeat-reminder / compaction）→ 出处 app.asar
 *      · 社区插件（smart-compaction / billion-context-dsh）→ 出处 npm registry
 */

import { REMEDY_KIND, RX_TYPE, KIND_LABEL, toPatchSnippet } from './types.mjs';
import { REMEDIES, VERIFY_VIA } from './remedies.mjs';
import { readEffectiveConfig, valueOf } from '../config/index.mjs';
import { matchPlugins, PLUGIN_CATALOG, activeCatalog } from '../catalog/index.mjs';
import { num } from '../summary.mjs';

export { REMEDY_KIND, RX_TYPE, KIND_LABEL };

/**
 * 已核实、但**当前没有指标靶子**的插件。
 *
 * 它们现在活在插件目录（src/catalog）里，靠**能力标签 + 关键词检索**被匹配出来，
 * 不再依赖硬绑 targets。这份列表保留，是为了让"目录里到底有哪些、什么时候核实的"
 * 有据可查。
 */
export const VERIFIED_BUT_UNTARGETED = PLUGIN_CATALOG.filter((p) => !(p.targets ?? []).length).map((p) => ({
  id: p.id,
  name: p.package,
  repo: p.repo,
  solves: p.summary,
  verifiedAt: p.source?.verifiedAt,
}));

/**
 * 已核实的插件处方池 —— 现在**由插件目录派生**（单一事实来源 src/catalog）。
 * 保留 `repo` / `verifiedAt` / `targets` 字段，便于复核与防回归。
 */
export const PRESCRIPTIONS = PLUGIN_CATALOG.map((p) => ({
  id: p.id,
  name: p.package,
  repo: p.repo,
  type: RX_TYPE.INSTALL,
  targets: p.targets ?? [],
  solves: p.summary,
  capabilities: p.capabilities ?? [],
  verifiedAt: p.source?.verifiedAt,
  verifiedVia: p.source?.via,
  install: { dsh: p.install?.cli ?? null, gui: p.install?.gui ?? null },
  note: p.risk,
}));

// ---------------------------------------------------------------------------
// 自证
// ---------------------------------------------------------------------------

/**
 * 校验"处方自证"：一条处方必须能说明它解决什么、解决哪个指标、出处在哪。
 * @returns {{ok:boolean, reason?:string}}
 */
export function selfJustify(prescription, problemId) {
  if (!prescription) return { ok: false, reason: '处方为空' };
  if (!Array.isArray(prescription.targets) || !prescription.targets.includes(problemId)) {
    return { ok: false, reason: `处方 ${prescription.id} 未声明可解决 ${problemId}` };
  }
  if (!prescription.solves) return { ok: false, reason: `处方 ${prescription.id} 缺少 solves 说明，无法自证` };
  if (!prescription.source?.package) {
    return { ok: false, reason: `处方 ${prescription.id} 缺少出处（source），无法复核` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const q = (v) => `'${String(v)}'`;

/**
 * 构造「具体怎么做」的分步指引。
 *
 * 用户反馈：「图一虽然给出建议，但是用户不知道具体操作步骤」、
 * 「图二给出命令，命令具体在哪里输入使用给出具体的」。
 * 所以每条处方都必须能展开成一串**照着做就行**的步骤，而不是一句结论。
 *
 * 配置 / 命令 / 插件 / 设置四类在这里按 action 生成（要带上真实文件路径）；
 * 行为类由 remedies.mjs 自带 steps。
 */
function buildSteps(remedy, finding, ctx, action) {
  if (Array.isArray(remedy.steps)) return remedy.steps;
  if (typeof remedy.steps === 'function') return remedy.steps(finding, ctx, action);

  const snap = ctx.config ?? null;
  const verify = remedy.verify
    ? `验证：${remedy.verify}`
    : '验证：重跑 ./run.sh report，看这条指标是否还命中。';

  // --- 改配置：打开文件 → 定位 → 替换/追加 → 保存 → 生效 → 验证 ---
  if (remedy.kind === REMEDY_KIND.CONFIG && remedy.row) {
    const file = action?.file || '~/.dsh/profiles/<profile>/cordis.patch.yml';
    const exists = snap?.patchExists;
    return [
      `用任意文本编辑器打开这个文件：${file}` +
        (exists
          ? ''
          : '　—— 该文件当前不存在，按同样路径新建一个即可（目录 ~/.dsh/profiles/desktop/ 已存在）'),
      `在文件里搜索这一行：- id: ${remedy.row.id}`,
      '分两种情况：① 搜到了 → 用下面的 YAML 片段把它**整段替换**（profile patch 是「整体替换」这一行的 config，没变的键也要一起写进去，缩进保持 2 空格）；② 没搜到 → 把片段**追加到文件末尾**',
      '保存文件。profile 配置默认会热重载；若行为没有变化，完全退出 Harness（从托盘退出，不是关窗口）再重新打开',
      verify,
    ];
  }

  // --- 插件：界面安装 → 启用 → 重启 → 验证 ---
  if (remedy.kind === REMEDY_KIND.PLUGIN) {
    const pkg = remedy.source?.package;
    const steps = [
      '打开侧边栏 → 插件 → 添加插件',
      `在输入框里粘贴包名并回车：${pkg}`,
      '点「安装」，装完点「立即启用」',
      '**完全退出 Harness**（从托盘/任务栏退出，不是关窗口）后重新打开 —— 插件只在启动时装载',
      verify,
    ];
    if (remedy.install?.cli) {
      steps.push(
        `（仅自建 profile 适用；桌面版 profile 由应用独占，只能用上面的界面安装）命令行等价写法：${remedy.install.cli}`,
      );
    }
    return steps;
  }

  // --- 斜杠命令：在输入框里敲 ---
  if (remedy.kind === REMEDY_KIND.COMMAND) {
    return [
      `在 Harness 会话的输入框里直接输入并回车：${remedy.command}`,
      '注意：Agent 必须处于空闲状态，正在执行时会被拒绝',
      '该命令不接受参数；没有可压缩的历史时它会明确告诉你',
      verify,
    ];
  }

  // --- 设置项：点哪里、改成什么 ---
  if (remedy.kind === REMEDY_KIND.SETTINGS && remedy.settings) {
    const kv = Object.entries(remedy.settings.keys).map(([k, v]) => `${k} = ${fmt(v)}`).join('、');
    return [
      `打开：${remedy.settings.where}`,
      `把这几项改成：${kv}`,
      '保存（用户值会覆盖插件自带的组合配置）',
      verify,
    ];
  }

  return [verify];
}

/** 找到 finding 的证据定位（第一条） */
const firstLocator = (f) => f?.evidence?.[0]?.locator ?? null;

/**
 * 构造一条可执行的处方输出。
 *
 * `command` 字段保持向后兼容（客户端会渲染成可复制的代码块）：
 *   - config   → 可粘贴的 YAML 片段
 *   - command  → 斜杠命令本身
 *   - plugin   → CLI 安装命令
 *   - settings → 界面路径
 */
export function buildPrescription(remedy, finding, ctx = {}) {
  const snap = ctx.config ?? null;
  const base = {
    kind: remedy.kind,
    kindLabel: KIND_LABEL[remedy.kind] ?? remedy.kind,
    title: remedy.title,
    solves: remedy.solves,
    targetId: remedy.id,
    findingId: finding.id,
    risk: remedy.risk ?? null,
    verify: remedy.verify ?? null,
    source: remedy.source
      ? `${remedy.source.package}（${
          remedy.source.type === 'third-party'
            ? '社区插件'
            : remedy.source.type === 'builtin'
              ? '本工具生成'
              : '随附插件'
        }）· 核实于 ${remedy.source.verifiedAt}`
      : null,
    sourceDoc: remedy.source?.doc ?? null,
    sourceVia: remedy.source?.via ?? null,
  };

  const evidence = typeof remedy.evidence === 'function' ? remedy.evidence(finding, ctx) : null;

  // --- config：把"当前值 → 建议值"写清楚 ---
  if (remedy.kind === REMEDY_KIND.CONFIG && remedy.row) {
    const row = snap?.rows?.[remedy.row.id] ?? null;
    const currentKeys = Object.keys(remedy.suggest ?? {});
    const current = currentKeys.map((k) => `${k}=${fmt(row?.config?.[k])}`);
    const suggest = currentKeys.map((k) => `${k}=${fmt(remedy.suggest[k])}`);
    const origin =
      row?.source === 'profile'
        ? '你的 profile 已覆盖这一行'
        : row
          ? '随附默认值（你的 profile 未覆盖这一行）'
          : '未能读到该行（profile 未找到）';

    // ⚠️ 第二轮评估 F17：profile patch 按 id 定位、**整体替换**该行 config。
    //    所以只写 reasoningEffort 的片段会把同一行的 provider/model **抹掉**——
    //    实测 remedies 里曾经硬编码 provider: deepseek-account，official 用户
    //    整段粘贴就会被静默改成 account。
    //    现在：这类处方声明 preserveKeys，片段里把当前行的这些键原样带上
    //    （读不到当前行时退化为随附默认值，并在 note 里说明来源）。
    const preserve = Array.isArray(remedy.preserveKeys) ? remedy.preserveKeys : [];
    const carried = {};
    const carriedNote = [];
    for (const k of preserve) {
      const v = row?.config?.[k];
      if (v !== undefined && v !== null) {
        carried[k] = v;
        carriedNote.push(`${k}=${fmt(v)}（沿用你当前的值）`);
      } else if (remedy.shippedConfig?.[k] !== undefined) {
        carried[k] = remedy.shippedConfig[k];
        carriedNote.push(`${k}=${fmt(remedy.shippedConfig[k])}（随附默认，未读到你当前的值）`);
      }
    }
    const nextConfig = { ...carried, ...remedy.suggest };

    const snippet = remedy.row ? toPatchSnippet(remedy.row.id, nextConfig, remedy.row.name) : null;
    const action = {
      type: 'config',
      file: snap?.patchPath ?? '~/.dsh/profiles/<profile>/cordis.patch.yml',
      rowId: remedy.row.id,
      packageName: remedy.row.name,
      config: nextConfig,
      snippet,
      note:
        'profile patch 按 id 定位、**整体替换**该行的 config，所以片段里要把这一行需要的键写全' +
        (carriedNote.length ? `。已带上：${carriedNote.join('、')}` : ''),
    };
    return {
      ...base,
      brief: `${current.join(' · ')} → ${suggest.join(' · ')}`,
      steps: buildSteps(remedy, finding, ctx, action),
      detail:
        `${remedy.solves}。\n` +
        `当前：${current.join(' · ')}（${origin}）\n` +
        `建议：${suggest.join(' · ')}` +
        (carriedNote.length ? `\n片段里同时带上：${carriedNote.join('、')}` : '') +
        (evidence ? `\n为什么是你：${evidence}` : ''),
      command: snippet,
      because: `它解决「${remedy.solves}」，正好对上检测到的 ${finding.id}（${finding.summary}）`,
      action,
    };
  }

  // --- command ---
  if (remedy.kind === REMEDY_KIND.COMMAND) {
    const action = { type: 'command', command: remedy.command };
    return {
      ...base,
      brief: `在会话输入框里输入 ${remedy.command} 并回车`,
      steps: buildSteps(remedy, finding, ctx, action),
      detail: `${remedy.solves}。${evidence ? `\n为什么是你：${evidence}` : ''}`,
      command: remedy.command,
      because: `它解决「${remedy.solves}」，正好对上检测到的 ${finding.id}（${finding.summary}）`,
      action,
    };
  }

  // --- plugin ---
  if (remedy.kind === REMEDY_KIND.PLUGIN) {
    const gui = remedy.install?.gui ?? null;
    const cli = remedy.install?.cli ?? null;
    const action = { type: 'plugin', packageName: remedy.source?.package, gui, cli };
    return {
      ...base,
      brief: `装社区插件 ${remedy.source?.package}（界面：插件 → 添加插件）`,
      steps: buildSteps(remedy, finding, ctx, action),
      detail:
        `${remedy.solves}。\n` +
        (gui ? `界面安装：${gui}\n` : '') +
        (remedy.source?.repo ? `仓库：${remedy.source.repo}` : '') +
        (evidence ? `\n为什么是你：${evidence}` : ''),
      command: cli,
      because: `它解决「${remedy.solves}」，正好对上检测到的 ${finding.id}（${finding.summary}）`,
      action,
    };
  }

  // --- settings ---
  if (remedy.kind === REMEDY_KIND.SETTINGS && remedy.settings) {
    const kv = Object.entries(remedy.settings.keys).map(([k, v]) => `${k} = ${fmt(v)}`).join(' · ');
    const action = { type: 'settings', where: remedy.settings.where, keys: remedy.settings.keys };
    return {
      ...base,
      brief: `${remedy.settings.where}：${kv}`,
      steps: buildSteps(remedy, finding, ctx, action),
      detail:
        `${remedy.solves}。\n` +
        `在哪里改：${remedy.settings.where}\n` +
        `改成：${kv}` +
        (remedy.settings.note ? `\n说明：${remedy.settings.note}` : '') +
        (evidence ? `\n为什么是你：${evidence}` : ''),
      command: null,
      because: `它解决「${remedy.solves}」，正好对上检测到的 ${finding.id}（${finding.summary}）`,
      action,
    };
  }

  // --- behavior ---
  const built =
    typeof remedy.build === 'function'
      ? remedy.build(finding, ctx)
      : { detail: remedy.solves, because: '' };
  const action = { type: 'behavior' };
  return {
    ...base,
    // 收起时只显示这一行；展开才给完整说明与分步操作
    brief: built.brief || firstSentence(built.detail ?? remedy.solves),
    steps: buildSteps(remedy, finding, ctx, action),
    detail: built.detail,
    command: null,
    because: built.because || `针对 ${finding.id}（${finding.summary}）`,
    action,
  };
}

/** 取第一句（收起态用），过长则截断 */
function firstSentence(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^.*?[。！？；]/);
  const one = m ? m[0] : s;
  return one.length > 72 ? `${one.slice(0, 70)}…` : one;
}

const fmt = (v) => {
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  if (typeof v === 'string') return q(v);
  if (v === undefined) return '(未设置)';
  if (v === null) return 'null';
  return String(v);
};

/**
 * 把一条插件目录检索结果变成处方。
 *
 * 与固定处方不同：它带 `matchedOn`（为什么推荐它），因为这是"检索"出来的，
 * 用户有权知道匹配依据；已安装的不再推"安装"，改推"确认启用 / 检查配置"。
 */
export function buildCatalogPrescription(hit, finding, ctx = {}) {
  const { entry, installed, reasons } = hit;
  const pseudo = {
    id: 'catalog-' + entry.id,
    kind: REMEDY_KIND.PLUGIN,
    targets: [finding.id],
    title: `${installed ? '已装' : '装'} ${entry.displayName}`,
    solves: entry.summary,
    install: entry.install,
    risk: entry.risk,
    verify: entry.verify,
    source: {
      type: entry.source?.type === 'third-party' ? 'third-party' : 'first-party',
      package: entry.package,
      repo: entry.repo,
      doc: entry.source?.doc,
      via: entry.source?.via,
      verifiedAt: entry.source?.verifiedAt,
    },
  };

  const built = buildPrescription(pseudo, finding, ctx);
  return {
    ...built,
    brief: installed
      ? `已安装 ${entry.package}（${entry.version ?? ''}）—— 确认已启用并核对配置`
      : `${entry.summary.slice(0, 40)}…（界面：插件 → 添加插件）`,
    matchedOn: reasons,
    installed,
    catalogId: entry.id,
    capabilityTags: entry.capabilities ?? [],
    compatibility: entry.compatibility ?? null,
    steps: installed
      ? [
          '打开侧边栏 → 插件，确认这个插件处于「已启用」状态',
          `核对版本：本地已装 ${entry.package}${entry.version ? `，目录里核实到的最新版是 ${entry.version}` : ''}`,
          entry.repo ? `用法与配置项见仓库：${entry.repo}` : '用法见插件自身的说明页',
          `验证：${entry.verify}`,
        ]
      : built.steps,
    action: installed
      ? { type: 'plugin', packageName: entry.package, installed: true, repo: entry.repo }
      : built.action,
  };
}

/** 为一个 finding 做插件目录检索（返回处方形态；**已安装的不再推荐**） */
export function pluginRecommendations(finding, ctx = {}) {
  const hits = matchPlugins(finding, {
    // ctx.catalog 是"本次生效的目录"（可能含**联网现搜**到的条目）——
    // 不传就会退回本地快照，现搜到的插件将无法进入处方。
    ...(ctx.catalog ? { catalog: ctx.catalog } : {}),
    installed: ctx.installedPlugins ?? [],
    limit: ctx.pluginLimit ?? 3,
  });
  // 用户要求：已经装了的插件不再作为"推荐"出现
  return hits.filter((hit) => !hit.installed).map((hit) => buildCatalogPrescription(hit, finding, ctx));
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

/**
 * 为单个 finding 生成候选处方（已按优先级排序、已剔除"当前值已经不弱"的）。
 *
 * @param {Object} finding
 * @param {Object} [opts] { ctx, rejected=[] }
 * @returns {Array<Object>}
 */
export function prescribeOne(finding, opts = {}) {
  const ctx = opts.ctx ?? {};
  const snap = ctx.config ?? null;
  const rejected = new Set(opts.rejected ?? []);
  const out = [];

  const candidates = REMEDIES.filter((r) => r.targets.includes(finding.id)).sort(
    (a, b) => (a.priority ?? 99) - (b.priority ?? 99),
  );

  for (const remedy of candidates) {
    const check = selfJustify(remedy, finding.id);
    if (!check.ok) continue;
    // 当前值已经不弱于建议 → 撤掉这条，绝不为了"有话说"而凑数。
    // 注意：**只有真的读到了配置快照**才做这个否决 —— 读不到配置时不该假装知道当前值。
    const skip = snap && typeof remedy.skipIf === 'function' ? remedy.skipIf(snap, finding) : null;
    if (skip) continue;
    const built = buildPrescription(remedy, finding, ctx);
    if (rejected.has(built.targetId)) continue;
    out.push({ ...built, skipped: null });
  }

  // 插件目录检索结果也参与排序：**能动手的排在纯建议前面**
  // （用户明确希望"能省 token 的插件"被建议出来，而不是被一句行为建议盖住）
  const seenIds = new Set(out.map((r) => r.targetId));
  for (const rx of pluginRecommendations(finding, ctx)) {
    if (rejected.has(rx.targetId)) continue;
    if (seenIds.has(rx.targetId)) continue;
    seenIds.add(rx.targetId);
    out.push(rx);
  }

  const KIND_WEIGHT = {
    [REMEDY_KIND.CONFIG]: 0,
    [REMEDY_KIND.COMMAND]: 0,
    [REMEDY_KIND.SETTINGS]: 0,
    [REMEDY_KIND.PLUGIN]: 1,
    [REMEDY_KIND.BEHAVIOR]: 2,
  };
  return out
    .map((rx, i) => ({ rx, i }))
    .sort((a, b) => {
      const wa = KIND_WEIGHT[a.rx.kind] ?? 3;
      const wb = KIND_WEIGHT[b.rx.kind] ?? 3;
      return wa - wb || a.i - b.i;
    })
    .map((x) => x.rx);
}

/** 被 skipIf 否决的处方（报告里可用来解释"为什么没给这条"） */
export function skippedFor(finding, opts = {}) {
  const snap = (opts.ctx ?? {}).config ?? null;
  const out = [];
  if (!snap) return out; // 没读到配置就不谈"否决"
  for (const remedy of REMEDIES.filter((r) => r.targets.includes(finding.id))) {
    const skip = typeof remedy.skipIf === 'function' ? remedy.skipIf(snap, finding) : null;
    if (!skip) continue;
    // 把"为什么没给"讲清楚：带上当前值，用户才能复核这个判断
    // （典型场景：spill 预算被禁用时最该给的建议恰好被撤掉）
    let current = null;
    const rowId = remedy.row?.id;
    if (rowId && remedy.suggest && typeof remedy.suggest === 'object') {
      const cur = snap?.rows?.[rowId]?.config ?? null;
      if (cur) {
        const keys = Object.keys(remedy.suggest);
        const pairs = keys
          .filter((k) => cur[k] !== undefined)
          .map((k) => `${k}=${JSON.stringify(cur[k])}`);
        if (pairs.length) current = pairs.join(', ');
      }
    }
    out.push({ id: remedy.id, title: remedy.title, reason: skip, current });
  }
  return out;
}

/**
 * 匹配处方（跨 finding 轮转，保证每个问题都能分到额度）。
 *
 * 与旧版的区别：默认上限从 2 提到 4。旧上限加上空靶插件池，
 * 是"看到问题却拿不到方案"的直接原因；现在每条都指向可执行动作，
 * 仍然不放任刷屏。
 *
 * @param {string|Array} problem 问题 ID 或 finding 列表
 * @param {Object} [opts] { limit=8, rejected=[], perFinding=2, ctx }
 */
export function matchPrescriptions(problem, opts = {}) {
  // 上限 8（2026-10-15 决策 D3）：每类问题 2 个名额，8 个名额 = 前 4 类问题各 2 条。
  // 上限 6 时只覆盖得下 3 类（7 类问题抢 6 个名额），第 4 类起在全局清单里没有处方 ——
  // 虽已如实报出"因名额未展示 N 条"，但覆盖率太低。8 是"每类 2 条"语义下最小的
  // 扩容（每 +2 个名额多覆盖 1 类），同时报告长度仍可控。
  const limit = opts.limit ?? 8;
  // 每个问题默认给 2 个名额：第 1 个是确定对症的处方，第 2 个留给插件目录检索结果，
  // 这样"能装的插件"不会被一句行为建议挤掉。
  const perFinding = opts.perFinding ?? 2;
  const ctx = opts.ctx ?? {};

  const findings = Array.isArray(problem) ? problem : [{ id: String(problem), summary: '' }];

  const rounds = Math.max(perFinding, 1);
  // 每轮配额 = 总名额按轮数分摊（上取整）。
  //
  // 旧实现用 `out.length < limit` 直接当轮次门控：perFinding=2、limit=6 时，
  // 第 0 轮就把 6 个名额填满 → **第 1 轮永不执行** → 每类问题的第 2 个位次
  // 结构性丢失。插件类处方正排在那个位次（KIND_WEIGHT 里 PLUGIN 排 1），
  // 于是「联网现搜到的对症插件」只进推荐、进不了全局处方列表。
  // 轮配额保证每一轮都有名额，位次轮转才是真的。
  const roundCap = Math.max(1, Math.ceil(limit / rounds));

  // 同一个 finding 的候选只算一次（旧写法每轮重算，且重算结果本应一致）
  const allCache = new Map();
  const allFor = (f) => {
    if (!allCache.has(f)) allCache.set(f, prescribeOne(f, { ...opts, ctx }));
    return allCache.get(f);
  };

  const out = [];
  const seen = new Set();
  const tryPush = (f, rank) => {
    const pick = allFor(f)[rank];
    if (!pick) return false;
    // 按**处方本身**去重：同一个插件 / 同一条配置建议只出现一次。
    // 否则 billion-context-dsh 会因为同时命中 C1 与 C3 而被重复列出。
    if (seen.has(pick.targetId)) return false;
    seen.add(pick.targetId);
    out.push(pick);
    return true;
  };

  // 第一遍：轮转 —— 每个问题、每个位次都有机会（公平性）
  for (let round = 0; round < rounds && out.length < limit; round++) {
    const roundStart = out.length;
    for (const f of findings) {
      if (out.length >= limit || out.length - roundStart >= roundCap) break;
      tryPush(f, round);
    }
  }

  // 第二遍：候选取尽后若仍有名额，按位次顺序继续填满。
  // 轮转只负责"位次有机会"，不该因为公平而浪费名额（旧实现贪婪填充这一点是对的）。
  for (let round = 0; round < rounds && out.length < limit; round++) {
    for (const f of findings) {
      if (out.length >= limit) break;
      tryPush(f, round);
    }
  }

  return out;
}

/** 给一批 finding 出处方（按严重度顺序，最多 limit 条） */
export function prescribe(findings, opts = {}) {
  const ctx = opts.ctx ?? {};
  if (!ctx.config) {
    // 未显式传入时自行读一次（CLI / 单元测试路径）
    try {
      ctx.config = readEffectiveConfig();
    } catch {
      ctx.config = null;
    }
  }
  return matchPrescriptions(findings, { ...opts, ctx });
}

// ---------------------------------------------------------------------------
// 省 token 开关清单
// ---------------------------------------------------------------------------

/** 成本类指标 */
const COST_IDS = ['C1', 'C2', 'C3'];

/**
 * 「省 token 开关清单」——**不是问题清单**。
 *
 * 当本次体检没有触发成本类指标（例如 C2 没命中）时，用户仍然会问
 * "我能调哪些开关省 token"。这份清单直接列出本机真实存在的旋钮、
 * 当前值与建议值，并明确标注「本次未触发对应指标，仅供参考」——
 * 它是工具陈列，不是诊断结论，因此不违反"禁止硬编问题"。
 *
 * @param {Object} opts { ctx, excludeIds=[] }
 * @returns {Array<Object>}
 */
export function tokenInventory(opts = {}) {
  const ctx = opts.ctx ?? {};
  const snap = ctx.config ?? null;
  const exclude = new Set(opts.excludeIds ?? []);

  const rows = [];
  for (const remedy of REMEDIES) {
    if (!remedy.targets.some((t) => COST_IDS.includes(t))) continue;
    if (remedy.kind === REMEDY_KIND.BEHAVIOR) continue; // 清单只列"开关"，不列行为
    if (exclude.has(remedy.id)) continue;

    const skip =
      snap && typeof remedy.skipIf === 'function' ? remedy.skipIf(snap, { id: remedy.targets[0], summary: '' }) : null;
    // 已经被判定为"当前值已足够"的开关，不进清单 —— 列出来只会说一句正确的废话
    if (skip) continue;

    if (remedy.kind === REMEDY_KIND.CONFIG && remedy.row) {
      const row = snap?.rows?.[remedy.row.id] ?? null;
      const action = {
        type: 'config',
        file: snap?.patchPath ?? '~/.dsh/profiles/<profile>/cordis.patch.yml',
        rowId: remedy.row.id,
      };
      rows.push({
        id: remedy.id,
        kind: remedy.kind,
        kindLabel: KIND_LABEL[remedy.kind],
        title: remedy.title,
        solves: remedy.solves,
        steps: buildSteps(remedy, { id: remedy.targets[0], summary: '' }, ctx, action),
        rowId: remedy.row.id,
        packageName: remedy.row.name,
        fileName: action.file,
        current: remedy.suggest
          ? Object.keys(remedy.suggest).map((k) => `${k}=${fmt(row?.config?.[k])}`).join(' · ')
          : null,
        suggested: remedy.suggest
          ? Object.keys(remedy.suggest).map((k) => `${k}=${fmt(remedy.suggest[k])}`).join(' · ')
          : null,
        snippet: remedy.suggest ? toPatchSnippet(remedy.row.id, remedy.suggest, remedy.row.name) : null,
        status: skip ? 'normal' : 'adjustable',
        note: skip ?? null,
        source: remedy.source ? `${remedy.source.package} · 核实于 ${remedy.source.verifiedAt}` : null,
        risk: remedy.risk ?? null,
      });
      continue;
    }

    if (remedy.kind === REMEDY_KIND.PLUGIN) {
      rows.push({
        id: remedy.id,
        kind: remedy.kind,
        kindLabel: KIND_LABEL[remedy.kind],
        title: remedy.title,
        solves: remedy.solves,
        steps: buildSteps(
          remedy,
          { id: remedy.targets[0], summary: '' },
          ctx,
          { type: 'plugin', packageName: remedy.source?.package },
        ),
        packageName: remedy.source?.package ?? null,        repo: remedy.source?.repo ?? null,
        install: remedy.install ?? null,
        current: '未安装',
        suggested: '按需安装',
        status: 'optional',
        note: null,
        source: remedy.source ? `${remedy.source.package} · 核实于 ${remedy.source.verifiedAt}` : null,
        risk: remedy.risk ?? null,
      });
    }
  }

  // 插件目录里与「省 token / 省成本」相关的条目也进清单（含 npm / GitHub 同步进来的），
  // 这样即使用户这次没有命中 C1/C2/C3，也能看到"有哪些插件能省 token"。
  // 已安装的不列（用户要求：装过的不再显示推荐）。
  const installedList = ctx.installedPlugins ?? [];
  const catalogEntries = ctx.catalogEntries ?? activeCatalog().entries;
  for (const entry of catalogEntries) {
    const caps = entry.capabilities ?? [];
    if (!caps.includes('token-saving') && !caps.includes('cost')) continue;
    if (exclude.has('catalog-' + entry.id)) continue;
    const installed = installedList.some(
      (n) => n === entry.package || n === entry.package.replace(/^@[^/]+\//, ''),
    );
    if (installed) continue;
    const pseudo = {
      id: 'catalog-' + entry.id,
      kind: REMEDY_KIND.PLUGIN,
      targets: [entry.targets?.[0] ?? 'C2'],
      source: { package: entry.package, type: 'third-party' },
      install: entry.install,
    };
    rows.push({
      id: 'catalog-' + entry.id,
      kind: REMEDY_KIND.PLUGIN,
      kindLabel: KIND_LABEL[REMEDY_KIND.PLUGIN],
      title: `装 ${entry.displayName}`,
      solves: entry.summary,
      steps: buildSteps(pseudo, { id: 'C2', summary: '' }, ctx, { type: 'plugin', packageName: entry.package }),
      packageName: entry.package,
      repo: entry.repo ?? null,
      install: entry.install ?? null,
      current: '未安装',
      suggested: '按需安装',
      status: 'optional',
      note: null,
      capabilityTags: caps,
      origin: entry.origin ?? 'curated',
      source: `${entry.package} · 核实于 ${entry.source?.verifiedAt ?? entry.source?.via ?? '—'}`,
      risk: entry.risk ?? null,
    });
  }

  return rows;
}

export { valueOf, readEffectiveConfig, toPatchSnippet };
