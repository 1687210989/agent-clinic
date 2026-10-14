/**
 * 处方目录（Remedy Catalog）—— 问题 → **可执行**方案
 *
 * 背景（2026-10-15）：
 *   旧版本诊断出 C1/C2 之后只会给"行为建议"（"把重活拆成多个短会话"），
 *   用户的原话是"定位到了问题但是没有给出可行的解决方案，例如 token 消耗
 *   过高，但是没有给出可以省 token 的插件推荐"。
 *
 *   根因不是文案问题，是**处方池里 targets 全空**：PRESCRIPTIONS 三条插件
 *   的 targets 都是 `[]`，`prescribeOne` 的插件分支永远匹配不上，于是所有
 *   成本类问题都只能落到"行为建议"分支。
 *
 *   本目录的纪律不变（不编插件、不编命令），但把"可执行"落到三件事上：
 *     1. 每条处方声明 `targets`，不再有空靶
 *     2. 每条处方给出**可粘贴**的产物：YAML 片段 / 斜杠命令 / 安装入口
 *     3. 每条处方带 `source`（出处 + 核实日期 + 核实方式）与 `risk`
 *
 * 出处分两类，都可在本机复核：
 *   - first-party：随附 DSH 包，出处是 app.asar 里的包文档（本机可解包复核）
 *   - third-party：npm registry 上的社区插件，`npm view <name> version` 可复核
 */

import { REMEDY_KIND, toPatchSnippet } from './types.mjs';

/** 核实方式标注（报告里会原样显示，用户能自己重跑一遍） */
export const VERIFY_VIA = {
  asar: 'D:\\dsh\\resources\\app.asar → @deepseek-ai/<包>/README.zh.md',
  npm: 'npm view <包名> version（registry.npmjs.org）',
};

const P = (o) => o;

/**
 * 行为处方的出处。
 *
 * 行为建议也必须可自证（selfJustify 要求 source）：它的依据是 finding 的
 * 实测字段（工具名、重复次数、阈值），而不是某个外部包 —— 所以出处写清楚
 * 是"本仓库根据实测字段生成"，不冒充任何插件的功劳。
 */
const BEHAVIOR_SOURCE = {
  type: 'builtin',
  package: 'agent-clinic · 行为处方',
  doc: '由 finding 的实测字段（工具名 / 次数 / 阈值）生成，不依赖第三方插件',
  via: 'src/prescriber/remedies.mjs',
  verifiedAt: '2026-10-15',
};

/**
 * 处方目录本体。
 *
 * 字段：
 *   targets    能解决的指标 ID（必须真实对症，否则 selfJustify 会拒绝）
 *   row        需要改的配置行（first-party config 类处方）
 *   suggest    建议写入的 config（**整体替换**该行 config，所以要写全）
 *   skipIf     当前值已经不弱于建议时返回原因字符串 → 不给这条（避免无用建议）
 *   evidence   用实测数据补一句"为什么是你"
 */
export const REMEDIES = [
  // =========================================================================
  // C2 上下文膨胀 —— 最贵的 input 来自"把整个工具结果原样塞回上下文"
  // =========================================================================
  P({
    id: 'spill-tighten',
    kind: REMEDY_KIND.CONFIG,
    priority: 10,
    targets: ['C2'],
    title: '收紧工具结果的 spill 预算（最能省 input 的一档）',
    solves: '超过预算的工具结果落到磁盘，内联只留首尾与文件路径，直接砍掉最大块的 input',
    row: { id: 'spill-policy', name: '@deepseek-ai/dsh-spill-policy' },
    suggest: { maxInlineTokens: 6000 },
    shippedConfig: { maxInlineTokens: 12500 },
    source: {
      type: 'first-party',
      package: '@deepseek-ai/dsh-spill-policy',
      doc: 'README.zh.md「使用本包」：maxInlineTokens 是保留的文字/图片估算 token 上限；省略则禁用策略',
      via: VERIFY_VIA.asar,
      verifiedAt: '2026-10-15',
    },
    evidence: (f, ctx) => {
      const [tool, n] = topTool(ctx);
      if (!tool) return null;
      return `你的会话里调用最多的是 ${tool}（${n} 次）；这类"整页抓取/整目录列举"的结果是 spill 的主要对象。`;
    },
    skipIf: (snap) => {
      const v = snap?.rows?.['spill-policy']?.config?.maxInlineTokens;
      if (typeof v !== 'number') return 'spill 策略当前未设预算（或已被禁用），建议先确认这一行是否被覆盖删除';
      if (v <= 6000) return `已经是 ${v}，比建议值还紧，无需再调`;
      return null;
    },
    risk: '被省略的中间内容模型看不到，需要时它得自己 read/grep 那个 spill 文件；预算过小会让"通知放不下"从而放弃替换。',
    verify: './run.sh report 再看 C2 的末轮 input；或在会话里让 Agent 抓一个大页面观察是否出现 "Full formatted result stored at:"',
  }),

  P({
    id: 'pruner-tighten',
    kind: REMEDY_KIND.CONFIG,
    priority: 20,
    targets: ['C2'],
    title: '收紧历史工具结果的剪枝阈值',
    solves: '压缩触发时把超大工具结果剪成"头 + 尾"，中段不再重复占用后续每一轮的 input',
    row: { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
    suggest: { thresholdChars: 4096, headChars: 2048, tailChars: 512 },
    shippedConfig: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    source: {
      type: 'first-party',
      package: '@deepseek-ai/dsh-compaction-tool-result-pruner',
      doc: 'README.zh.md 配置表：thresholdChars / headChars / tailChars；约束 head+标记+tail ≤ thresholdChars',
      via: VERIFY_VIA.asar,
      verifiedAt: '2026-10-15',
    },
    skipIf: (snap) => {
      const v = snap?.rows?.['tool-result-pruner']?.config?.thresholdChars;
      if (typeof v !== 'number') return null;
      if (v <= 4096) return `thresholdChars 已经是 ${v}，无需再调`;
      return null;
    },
    risk: '剪枝只看语法（保头尾），中段内容模型看不到；错误堆栈常在中段，排障会话不建议调得太狠。',
    verify: '重跑 ./run.sh report，看 C2 的末轮 input 是否回落',
  }),

  P({
    id: 'compact-now',
    kind: REMEDY_KIND.COMMAND,
    priority: 30,
    targets: ['C3', 'C2'],
    title: '长会话里手动 /compact',
    solves: '把最旧的一段历史换成一份摘要，立刻缩小后续每一步的 input',
    command: '/compact',
    source: {
      type: 'first-party',
      package: '@deepseek-ai/dsh-command-compact',
      doc: 'README.zh.md：空闲时可用，不接受参数，成功后报告被替换的历史项数与估算 token',
      via: VERIFY_VIA.asar,
      verifiedAt: '2026-10-15',
    },
    evidence: (f) =>
      f.id === 'C3' ? `本会话消息数已超阈值（${f.summary}），正是该压缩的对象。` : null,
    risk: '只在 Agent 空闲时可用（busy 会拒绝）；摘要本身要付一次辅助模型调用。',
    verify: '执行后看上下文用量是否下降；`/compact` 无历史可压会明确提示',
  }),

  // =========================================================================
  // 第三方插件（已核实存在，给出可粘贴的安装入口）
  // =========================================================================
  P({
    id: 'plugin-smart-compaction',
    kind: REMEDY_KIND.PLUGIN,
    priority: 40,
    targets: ['C3', 'C2'],
    title: '装 smart-compaction（让模型自己择机压缩 + 看得见真实用量）',
    solves:
      '给模型 compact_now（在它自己判断的安全点压缩，回合中途也能用）与 context_status（对照真实上下文窗口报告 token 用量），并在 todo 勾完、上下文过半时自动压缩',
    install: {
      gui: '侧边栏 → 插件 → 添加插件 → 粘贴 smart-compaction',
      cli: 'dsh plugin --profile <你的 profile> add smart-compaction --allow-build=smart-compaction',
    },
    source: {
      type: 'third-party',
      package: 'smart-compaction',
      repo: 'https://github.com/JoblessJoe/smart-compaction',
      doc: 'npm 包元数据 dsh.bundle.patch + README（v0.3.10）',
      via: VERIFY_VIA.npm,
      verifiedAt: '2026-10-15',
    },
    risk: '社区插件（MIT）；desktop profile 由应用独占，只能用界面安装，装完需完全重启 Harness；它不改动 DSH 核心，只挂在公开的 compaction API 上。',
    verify: '装完重启，让会话调用 context_status，应报告类似 "~42,300 / 77,824 tokens used"',
  }),

  P({
    id: 'plugin-billion-context',
    kind: REMEDY_KIND.PLUGIN,
    priority: 60, // 排在 smart-compaction 之后：更重、更激进
    targets: ['C2', 'C3'],
    title: '装 billion-context-dsh（ACP：模型驱动压缩，作者标注为测试版）',
    solves:
      '给模型 compress / decompress / search_context / acp_status 四个工具，由模型决定压缩什么，摘要由模型自己写（不额外调用一次摘要模型）',
    install: {
      gui: '侧边栏 → 插件 → 添加插件 → 粘贴 billion-context-dsh',
      cli: 'dsh plugin --profile <你的 profile> add billion-context-dsh',
    },
    source: {
      type: 'third-party',
      package: 'billion-context-dsh',
      repo: 'https://github.com/Tyan66666/billion-context-dsh',
      doc: 'npm 包元数据（v0.2.27）+ README「安装」',
      via: VERIFY_VIA.npm,
      verifiedAt: '2026-10-15',
    },
    risk:
      '作者在 README 顶部明确写「测试版，请勿用于工程化/生产环境」；它会禁用 host 的 compaction-basic 并接管压缩，对 DSH 版本有 peer 区间要求。想稳就别装它。',
    verify: '装完重启，新会话调用 acp_status 自证挂载',
  }),

  // =========================================================================
  // E5 冗余重复调用
  // =========================================================================
  P({
    id: 'repeat-reminder-tighten',
    kind: REMEDY_KIND.CONFIG,
    priority: 10,
    targets: ['E5', 'E1'],
    title: '让重复调用提醒来得更早',
    solves: '同参数重复调用达到阈值时提醒模型换策略，减少"同参数再来一次"的冗余回合',
    row: { id: 'repeat-tool-reminder', name: '@deepseek-ai/dsh-repeat-tool-reminder' },
    suggest: { thresholds: [2, 3, 5], argumentsPreviewChars: 500 },
    shippedConfig: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 },
    source: {
      type: 'first-party',
      package: '@deepseek-ai/dsh-repeat-tool-reminder',
      doc: 'README.zh.md 配置表：thresholds（默认 [3,5,8]，必须 ≥2 且不重复）/ argumentsPreviewChars',
      via: VERIFY_VIA.asar,
      verifiedAt: '2026-10-15',
    },
    skipIf: (snap) => {
      const t = snap?.rows?.['repeat-tool-reminder']?.config?.thresholds;
      if (Array.isArray(t) && t[0] <= 2) return `thresholds 已经是 [${t.join(', ')}]，无需再调`;
      return null;
    },
    risk: '提醒只是建议，不阻止合理重复；阈值调到 2 会在幂等轮询场景里更吵。',
    verify: '再遇到同参数重复时，结果后面应出现插件的提醒消息',
  }),

  // =========================================================================
  // C1 token 消耗过快（output 侧）
  // =========================================================================
  P({
    id: 'reasoning-effort',
    kind: REMEDY_KIND.CONFIG,
    priority: 10,
    targets: ['C1'],
    title: '调低默认推理强度',
    solves: '推理强度直接决定每次回复的思考长度，是 output token 最大的单点杠杆',
    row: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' },
    suggest: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    source: {
      type: 'first-party',
      package: '@deepseek-ai/dsh-agent-default-model',
      doc: 'README.zh.md「配置默认值」：provider / model 必填，reasoningEffort 可选（保存不含该字段的选择会移除它）',
      via: VERIFY_VIA.asar,
      verifiedAt: '2026-10-15',
    },
    skipIf: (snap) => {
      const row = snap?.rows?.['agent-default-model'];
      const v = row?.config?.reasoningEffort;
      if (v === 'low') return 'reasoningEffort 已经是 low（最低档），output 高只能从"任务拆小"入手';
      if (v === undefined || v === null) return null;
      return null;
    },
    risk: '推理强度降低会牺牲复杂任务的成功率；建议只在长对话/简单任务上降，别一刀切。',
    verify: '重跑 ./run.sh scan 看 output 总量变化',
  }),

  // =========================================================================
  // A4 子代理开销
  // =========================================================================
  P({
    id: 'subagent-limit',
    kind: REMEDY_KIND.SETTINGS,
    priority: 10,
    targets: ['A4'],
    title: '收紧子代理的深度与并发',
    solves: '子代理按独立会话全额计费；限制深度与并发能直接压住这块开销',
    settings: {
      where: '侧边栏 → 插件 → 子智能体 → 限制',
      keys: { maxDepth: 0, maxActiveSubagents: 1 },
      note: '用户值覆盖插件组合配置；改完在下次委派时生效',
    },
    source: {
      type: 'first-party',
      package: '@deepseek-ai/dsh-subagent',
      doc: 'README.zh.md：默认 maxDepth 1 / maxActiveSubagents 8，均为 Host 设置项',
      via: VERIFY_VIA.asar,
      verifiedAt: '2026-10-15',
    },
    risk: 'maxDepth=0 会禁止一切委派，长任务的可并行度下降；确认你真的不需要并行再设 0。',
    verify: '重跑 ./run.sh report，看 A4 的占比是否下降',
  }),

  // =========================================================================
  // 行为类（保持诚实：没有插件/配置可解时才给，且必须指向具体动作）
  // =========================================================================
  P({
    id: 'behavior-split-session',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 90,
    targets: ['C1'],
    title: '把长任务拆成多个短会话',
    solves: '单会话越长，Agent 越容易反复铺陈，output 会持续放大',
    build: (f) => ({
      detail:
        '在开新会话前，让 Agent 先写一份简短交接（当前进度 / 已确认的结论 / 下一步），' +
        '把交接文件带进新会话。本会话 output 已达自身基线的数倍：' + f.summary,
      because: 'output 高通常来自"一个会话里想做太多事"，拆分是零成本且立刻见效的一步。',
    }),
  }),

  P({
    id: 'behavior-context-hygiene',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 91,
    targets: ['C2'],
    title: '别把长驻内容每轮重贴一遍',
    solves: '同样的上下文被反复重新计费，是 input 膨胀最常见的来源',
    build: (f) => ({
      detail:
        '把会反复用到的长驻内容（项目约定、目录结构、接口文档）写进文件或系统提示，让缓存能复用；' +
        '不要每个 step 重新贴一遍。实测：' + f.summary,
      because: 'input 逐轮上涨且 cacheRead 占比低，说明同样的上下文被重复计费。',
    }),
  }),

  P({
    id: 'behavior-new-session',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 92,
    targets: ['C3'],
    title: '到 200 条消息左右就开新会话',
    solves: '长会话里 Agent 更容易重复劳动和跑偏，这是实测中最常见的隐性浪费来源',
    build: () => ({
      detail: '把已完成的部分写成一份简短交接说明带进新会话，而不是在同一条会话里继续加长。',
      because: '长会话的每一步都要重发全部历史，成本随长度线性上涨。',
    }),
  }),

  P({
    id: 'behavior-reuse-result',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 92,
    targets: ['E5'],
    title: '同参数的工具结果一次性取回后复用',
    solves: '重复调用不只浪费工具开销，每次都要把结果重新送回模型，是双重计费',
    build: (f) => {
      const tool = f.tool || '同一个工具';
      const n = f.repeatCount ? `（实测同参数调用了 ${f.repeatCount} 次）` : '';
      return {
        detail: `在同一轮对话里把 ${tool} 的结果一次性取回并记住，后续步骤直接复用，不要每个 step 都重新调用${n}。`,
        because: '同参数重复调用在证据里可逐条复核，属于可避免的重复计费。',
      };
    },
  }),

  P({
    id: 'behavior-break-loop',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 91,
    targets: ['E1'],
    title: '确认无解就换策略，别原地重试',
    solves: '同参数反复失败说明重试不会改变结果，继续跑只是白烧 token',
    build: (f) => {
      const tool = f.tool || '同一个工具';
      const n = f.repeatCount ? `（实测连续失败 ${f.repeatCount} 次）` : '';
      return {
        detail:
          `定位到 ${tool} 连续失败的位置（见证据定位），检查参数或工具本身；` +
          `若已确认无解，主动中断并换策略，不要让 Agent 原地重试${n}。`,
        because: '同参数 + 同错误才算死循环，这类重试在证据里是逐条可复核的。',
      };
    },
  }),

  P({
    id: 'behavior-error-rate',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 92,
    targets: ['E2', 'N1'],
    title: '先修失败样本的共同点',
    solves: '错误率高通常是环境问题（权限/路径/依赖），修环境的收益远大于调 prompt',
    build: (f) => ({
      detail:
        '按证据定位抽 3~5 条失败记录，找共同点：权限、路径、依赖缺失、网络。' +
        '修好之后错误率会立刻下来，比重试有效。实测：' + f.summary,
      because: '命令反复失败基本是环境问题，试错式重试是最贵的排查方式。',
    }),
  }),

  P({
    id: 'behavior-danger-confirm',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 90,
    targets: ['N2'],
    title: '给高危命令加人工确认',
    solves: '高危命令一旦误执行，代价远高于多问一句',
    build: (f) => {
      const pats = f.dangerPatterns?.join('、') || '高危模式';
      return {
        detail:
          `命中「${pats}」的调用逐条过一遍：确认是否真的必要、Agent 为什么认为需要它。` +
          '把这类操作固化为人工确认习惯，比事后清理便宜得多。',
        because: `${f.summary} —— 证据可逐条复核。`,
      };
    },
  }),

  P({
    id: 'behavior-drop-idle-skill',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 90,
    targets: ['A2'],
    title: '卸载长期不触发的 skill',
    solves: '闲置资产不产生价值，只增加启动与维护成本',
    build: (f) => ({
      detail:
        `确认这些 skill 确实不再需要后，删掉对应目录（~/.agents/skills/<名字>），` +
        `或从 profile 的 dsh.profile.bundles 里移除。实测：${f.summary}`,
      because: '窗口内 0 次触发是可核验的事实，不是猜测。',
    }),
  }),

  P({
    id: 'behavior-solidify-sequence',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 90,
    targets: ['A3'],
    title: '把固定套路写成 skill',
    solves: '重复的固定序列正是 skill 该做的事，固化后一句话就能触发',
    build: (f) => ({
      detail: '把这个序列写成一个小 skill（SKILL.md + 脚本）固化下来，之后不必每次手动带 Agent 走一遍。',
      because: f.summary,
    }),
  }),

  P({
    id: 'behavior-subagent-budget',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 91,
    targets: ['A4'],
    title: '派活前先算子代理的账',
    solves: '子代理按独立会话全额计费，边界不清的任务会成倍放大成本',
    build: (f) => ({
      detail:
        '给子代理一个明确的、边界清晰的小任务，并要求它只回结论不回过程；能自己做就别派子代理。实测：' + f.summary,
      because: '子代理的 token 占比是可测量的事实。',
    }),
  }),

  P({
    id: 'behavior-todo-update',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 90,
    targets: ['E4'],
    title: '要求 Agent 边做边更新计划状态',
    solves: '计划写了不更新，等于没有计划 —— 执行脱节时 Agent 会重复劳动或漏步骤',
    build: (f) => ({
      detail:
        '在会话开头就把这条说清楚：每完成一步立刻更新 todo 状态，而不是全部做完后一次性回写。' +
        '这样计划与执行的偏差能当场发现。实测：' + f.summary,
      because: '写入计划后仍有大量工具调用且 0 条完成，说明计划没有进入执行闭环。',
    }),
  }),
];

/**
 * 行为处方的风险与验证方式。
 *
 * 单独放一张表而不是塞进每条里：行为建议的风险是"共性"的（比如拆会话会丢上下文），
 * 集中写一次比复制 10 遍更好维护，也保证**没有任何一条行为处方缺这两项**。
 */
const BEHAVIOR_META = {
  'behavior-split-session': {
    risk: '拆会话会丢掉原会话的上下文，必须靠交接文件补齐；交接写得太粗会重复劳动。',
    verify: '重跑 ./run.sh report，看 C1 是否还命中；命中会话的 output 应回落到基线附近。',
  },
  'behavior-context-hygiene': {
    risk: '写进文件的内容仍需被读取才会进入上下文；该方法减少的是"重复贴"的部分，不是全部 input。',
    verify: '重跑 ./run.sh report，看 C2 的 cacheRead 占比是否上升、末轮 input 是否下降。',
  },
  'behavior-new-session': {
    risk: '新会话没有旧会话的隐式上下文，跨会话的模糊指代会失效。',
    verify: '看 ./run.sh scan 里最长会话的消息数是否下降，以及 C3 是否不再命中。',
  },
  'behavior-reuse-result': {
    risk: '复用旧结果在文件/状态已变化时会出错；只对幂等读取安全。',
    verify: '重跑 ./run.sh report，看 E5 是否还命中同一工具。',
  },
  'behavior-break-loop': {
    risk: '主动中断可能打断一个"再试一次就成功"的调用；先看证据再决定，别一刀切。',
    verify: '重跑 ./run.sh report，看 E1 是否还出现同参数同错误的记录。',
  },
  'behavior-error-rate': {
    risk: '环境问题需要你手动改权限/路径，Agent 无法自行修复。',
    verify: '重跑 ./run.sh report，看该会话错误率是否降到阈值以下。',
  },
  'behavior-danger-confirm': {
    risk: '增加确认会拖慢高频安全操作；只对真正高危的模式加。',
    verify: '重跑 ./run.sh report，N2 应显示新的高危调用已被逐条确认（无新增未确认记录）。',
  },
  'behavior-drop-idle-skill': {
    risk: '删除 skill 不可撤销；先把目录备份或从 bundles 里移除而不是直接删。',
    verify: '重跑 ./run.sh report，A2 不再列出该 skill。',
  },
  'behavior-solidify-sequence': {
    risk: '序列里若含可变参数，固化后仍需你补齐参数；写得太死会不适用。',
    verify: '重跑 ./run.sh report，看 A3 中该序列的重复次数是否下降。',
  },
  'behavior-subagent-budget': {
    risk: '收敛子代理会降低并行度，长任务墙钟时间可能变长。',
    verify: '重跑 ./run.sh report，看 A4 的子代理 token 占比是否下降。',
  },
  'behavior-todo-update': {
    risk: '每一步都回写 todo 会增加少量工具调用；对极短任务不划算。',
    verify: '重跑 ./run.sh report，E4 不再命中（计划有执行且有完成标记）。',
  },
};

for (const r of REMEDIES) {
  if (r.kind === REMEDY_KIND.BEHAVIOR && BEHAVIOR_META[r.id]) {
    Object.assign(r, BEHAVIOR_META[r.id]);
  }
}

/** 会话里调用次数最多的工具（用于让处方"对着你的用法说话"） */function topTool(ctx) {
  const byTool = ctx?.summary?.global?.byTool ?? null;
  if (!byTool) return [null, 0];
  const sorted = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0] : [null, 0];
}

/** 按指标取候选处方（保持目录顺序） */
export function remediesFor(findingId) {
  return REMEDIES.filter((r) => r.targets.includes(findingId));
}

export { toPatchSnippet };
