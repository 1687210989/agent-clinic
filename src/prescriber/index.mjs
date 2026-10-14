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
import { num } from '../summary.mjs';

export { REMEDY_KIND, RX_TYPE, KIND_LABEL };

/**
 * 已核实、但**对当前指标不对症**的插件。
 *
 * 保留这份记录是为了不丢失 2026-10-14 的核实工作，也为了让"为什么不出现在
 * 处方里"有据可查 —— 它们不是被删了，是没有对症指标。
 */
export const VERIFIED_BUT_UNTARGETED = [
  { id: 'modsearch', name: 'modsearch', repo: 'liustack/modsearch', solves: '给模型补上免费联网检索能力', verifiedAt: '2026-10-14' },
  { id: 'dsh-taskboard', name: 'dsh-taskboard', repo: 'shengsheng90/DSH-taskboard', solves: '本地任务看板', verifiedAt: '2026-10-14' },
  { id: 'dsh-skill-hub', name: 'dsh-skill-hub', repo: 'cheshireez/dsh-skill-hub', solves: '浏览本地技能目录', verifiedAt: '2026-10-14' },
];

/**
 * 已核实的插件处方池（由处方目录派生，单一事实来源）。
 * 保留 `repo` / `verifiedAt` / `install` 字段，便于复核与防回归。
 */
export const PRESCRIPTIONS = REMEDIES.filter((r) => r.kind === REMEDY_KIND.PLUGIN).map((r) => ({
  id: r.id,
  name: r.source.package,
  repo: r.source.repo,
  type: RX_TYPE.INSTALL,
  targets: r.targets,
  solves: r.solves,
  stars: undefined,
  verifiedAt: r.source.verifiedAt,
  verifiedVia: r.source.via,
  install: { dsh: r.install?.cli ?? null, gui: r.install?.gui ?? null },
  note: r.risk,
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

    const snippet = remedy.row ? toPatchSnippet(remedy.row.id, remedy.suggest, remedy.row.name) : null;
    const action = {
      type: 'config',
      file: snap?.patchPath ?? '~/.dsh/profiles/<profile>/cordis.patch.yml',
      rowId: remedy.row.id,
      packageName: remedy.row.name,
      config: remedy.suggest,
      snippet,
      note: 'profile patch 按 id 定位、**整体替换**该行的 config，所以片段里要把这一行需要的键写全',
    };
    return {
      ...base,
      brief: `${current.join(' · ')} → ${suggest.join(' · ')}`,
      steps: buildSteps(remedy, finding, ctx, action),
      detail:
        `${remedy.solves}。\n` +
        `当前：${current.join(' · ')}（${origin}）\n` +
        `建议：${suggest.join(' · ')}` +
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
  return out;
}

/** 被 skipIf 否决的处方（报告里可用来解释"为什么没给这条"） */
export function skippedFor(finding, opts = {}) {
  const snap = (opts.ctx ?? {}).config ?? null;
  const out = [];
  if (!snap) return out; // 没读到配置就不谈"否决"
  for (const remedy of REMEDIES.filter((r) => r.targets.includes(finding.id))) {
    const skip = typeof remedy.skipIf === 'function' ? remedy.skipIf(snap, finding) : null;
    if (skip) out.push({ id: remedy.id, title: remedy.title, reason: skip });
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
 * @param {Object} [opts] { limit=4, rejected=[], perFinding=1, ctx }
 */
export function matchPrescriptions(problem, opts = {}) {
  const limit = opts.limit ?? 4;
  const perFinding = opts.perFinding ?? 1;
  const ctx = opts.ctx ?? {};

  const findings = Array.isArray(problem) ? problem : [{ id: String(problem), summary: '' }];
  const out = [];
  const seen = new Set();

  for (let round = 0; round < Math.max(perFinding, 1) && out.length < limit; round++) {
    for (const f of findings) {
      if (out.length >= limit) break;
      const all = prescribeOne(f, { ...opts, ctx });
      const pick = all[round];
      if (!pick) continue;
      if (seen.has(pick.targetId + '@' + pick.findingId)) continue;
      seen.add(pick.targetId + '@' + pick.findingId);
      out.push(pick);
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
        packageName: remedy.source?.package ?? null,
        repo: remedy.source?.repo ?? null,
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
  return rows;
}

export { valueOf, readEffectiveConfig, toPatchSnippet };
