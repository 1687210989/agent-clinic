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
    // E3 与 C2 是同一根因的两面：C2 量"末轮 input 涨了多少"，E3 直接点出
    // "哪些工具结果本身太大了"。两者都指向同一个开关，不该各写一遍。
    targets: ['C2', 'E3', 'C5'],
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
      const v = ctx?.config?.rows?.['spill-policy']?.config?.maxInlineTokens;
      const budgetNote =
        typeof v === 'number'
          ? `当前预算 ${v} token。`
          : '当前这一行**没有设 maxInlineTokens**（省略即禁用策略）—— 设上预算才会开始落盘，这条正是你现在最需要的。';
      if (!tool) return budgetNote;
      return `${budgetNote}你的会话里调用最多的是 ${tool}（${n} 次）；这类"整页抓取/整目录列举"的结果是 spill 的主要对象。`;
    },
    /**
     * ⚠️ 第二轮评估 F16：这里原来在"没设预算"时返回原因字符串 → 处方被静默撤掉，
     *    而"没设预算"恰恰是这条建议最该出现的场景（同族的 pruner-tighten 当时
     *    就是给建议的，两条规则自相矛盾）。
     *    现在：只有**确实已经比建议值更紧**才撤；没设/非数字一律照给。
     */
    skipIf: (snap) => {
      const v = snap?.rows?.['spill-policy']?.config?.maxInlineTokens;
      if (typeof v === 'number' && v <= 6000) return `已经是 ${v}，比建议值还紧，无需再调`;
      return null;
    },
    risk: '被省略的中间内容模型看不到，需要时它得自己 read/grep 那个 spill 文件；预算过小会让"通知放不下"从而放弃替换。',
    verify: './run.sh report 再看 C2 的末轮 input；或在会话里让 Agent 抓一个大页面观察是否出现 "Full formatted result stored at:"',
  }),

  P({
    id: 'pruner-tighten',
    kind: REMEDY_KIND.CONFIG,
    priority: 20,
    targets: ['C2', 'E3', 'C5'],
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
    targets: ['C3', 'C2', 'C5'],
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
  // 第三方插件
  //
  // ⚠️ 2026-10-16：插件处方**已从这里迁走**，改由 `src/catalog/index.mjs`
  // 的插件目录 + 能力检索提供（用户要求"能够检索插件目录进行针对性推荐"）。
  // 硬绑 targets 只能覆盖被显式绑定的指标；目录检索还能靠能力标签与关键词
  // 命中问题描述（例如 C1 的文本里出现"token 消耗"，也能召回省 token 的插件）。
  // 插件目录同样要求每条都带核实出处，纪律不变。
  // =========================================================================

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
    // ⚠️ 第二轮评估 F17：只建议 reasoningEffort。
    //    旧版本把 provider/model 一起写死成 deepseek-account + deepseek-flash，
    //    而 profile patch 是"整行替换 config"——official 用户整段粘贴就会被静默改路由。
    //    provider/model 交给 preserveKeys 从**当前行**原样带过来。
    suggest: { reasoningEffort: 'low' },
    preserveKeys: ['provider', 'model'],
    shippedConfig: { provider: 'deepseek-official', model: 'deepseek-flash' },
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
    targets: ['C2', 'C7'],
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
    id: 'behavior-approval-preset',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 88,
    // 第二轮评估 F1：N3 原本被列为"不可实现"，现在能给出可执行动作了
    targets: ['N3'],
    title: '把常用低风险工具放进权限预设',
    solves: '每次审批都要你亲手点一下，等待时间纯属额外开销',
    build: (f) => ({
      detail:
        '按证据里的工具分布，把高频且低风险的那几个加进权限预设（或放宽对应策略），' +
        '保留真正危险的命令（rm -rf / --force 之类）为人工确认。' +
        `实测：${f.summary}`,
      because: '审批等待时长与工具分布都是从会话日志里实测出来的，不是推测。',
    }),
  }),

  P({
    id: 'behavior-retry-route',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 88,
    targets: ['N4'],
    title: '重试集中在同一失败码时先查路由',
    solves: '反复重试同一类失败是白花的等待与 token，先定位再重试',
    build: (f) => ({
      detail:
        '按失败码分组看：如果集中在 TRANSPORT/TIMEOUT，多半是本机网络或代理稳定性；' +
        '如果是 SERVER/RATE_LIMIT，考虑换时段或换路由。' +
        '同时确认适配器行的 retryPolicy 是 normal 模式（有界重试），别用 always 无限重试。' +
        `实测：${f.summary}`,
      because: '失败码、重试次数与累计退避都能在证据里逐条复核。',
    }),
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
    id: 'behavior-tool-surface',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 86,
    // 第三轮：C6 从 request/header 的 tools 数组量出了工具面成本
    targets: ['C6'],
    title: '盘点工具面：用不到的工具就是每个请求的固定成本',
    solves: '工具 schema 每个请求都要重发，少一个工具就少付一份固定输入 token',
    build: (f) => ({
      detail:
        `${f.summary}。工具 schema 是**每个请求**都要重发的固定成本（4 字符≈1 token）——` +
        '注意内置工具（create_goal / workflow / read_image 等）是 DSH 自带的，你不需要为它们做任何事；' +
        '真正能省的是**插件类**工具：不再用的插件卸载掉，它的 schema 就跟着消失。',
      because: '工具清单与 schema 字节数都来自日志里的 request/header，可逐条复核。',
    }),
  }),

  P({
    id: 'behavior-aux-cost',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 86,
    targets: ['A5'],
    title: '减少辅助模型调用（联网检索 / 会话标题）',
    solves: '辅助调用独立计费且不进 token 概览，次数是最容易优化的那一项',
    build: (f) => ({
      detail:
        `${f.summary}。这些调用**不计入报告的 token 概览**（DSH 没给它们记 usage），` +
        '所以你的真实开销比概览数字更高。可优化的部分：联网检索前先 grep/read 本地已有结论、' +
        '把"查过的东西"写进项目文件复用，而不是每次重新联网；会话标题只有首次生效，不必反复触发。',
      because: '次数与每次的 maxTokens 上限都能在证据里复核（上界 ≠ 实际用量，见影响说明）。',
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

  // --- 2026-10-15：A1（MCP 闲置）实现后补的对症处方 ---
  P({
    id: 'behavior-mcp-idle',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 85,
    // A1 是"配置了 MCP 服务器但窗口内 0 调用"
    targets: ['A1'],
    title: '闲置的 MCP 服务器：要么用起来，要么卸掉',
    solves: 'MCP 服务器的工具 schema 会随工具面一起每请求重发，配了不用就是纯成本',
    build: (f) => ({
      detail:
        `确认「${f.scope ?? '该服务器'}」是否还需要：**需要** → 把任务明确交给它（在指令里点名用它，` +
        `否则模型更倾向用内置工具）；**不需要** → 从 profile patch 里删掉那一行（证据里的行号就是它）。` +
        `两种都比留着强。实测：${f.summary}`,
      because: '窗口内 0 次调用是可核验的事实（按 mcp__<serverName>__ 前缀统计），不是猜测。',
    }),
    risk: '删掉配置后该服务器提供的工具立即消失；若还有在跑的任务依赖它，会报"工具不存在"。先确认没人用它。',
    verify: '重跑 ./run.sh report：A1 里不再出现这个 serverName（若改成用起来，调用次数会从 0 变 >0）。',
  }),

  // --- 决策 D4（2026-10-15）：K1/K2 变成已实现指标 → 必须有对症处方 ---
  P({
    id: 'behavior-cross-session-note',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 88,
    // K1 是"跨会话失忆"：同一段文本在多个会话里重复出现
    targets: ['K1'],
    title: '把结论写进项目里，别靠会话记忆',
    solves: '跨会话重复解释同一个问题 —— 会话不留记忆，能留记忆的是项目文件',
    build: (f) => ({
      detail:
        `同一个问题被问了多次（${f.summary}）。把它的**结论**写进项目里的固定位置：` +
        `AGENTS.md（约定与边界）、README 的「已知问题/决策」、或一份 docs/<主题>.md；` +
        `下次开新会话时让 Agent 先读那份文件，而不是重新讲一遍。`,
      because: '指纹重合是客观事实（同一段文本出现在多个会话），不是猜你忘了。',
    }),
    risk: '把结论写进项目文件会留下长期维护成本；建议只沉淀"反复被问到"的那几件事。',
    verify: '重跑 ./run.sh report：K1 里那几条指纹重合应当消失或不再增长。',
  }),

  P({
    id: 'behavior-resolved-list',
    kind: REMEDY_KIND.BEHAVIOR,
    source: BEHAVIOR_SOURCE,
    priority: 87,
    // K2 是"已解决重新排查"：同一问题再次被提起且其后又出现失败/重试
    targets: ['K2'],
    title: '维护一份"已解决"清单，排查前先读',
    solves: '已经定位过的问题又被从头排查一遍 —— 重复的定位与试错成本',
    build: (f) => ({
      detail:
        `把已经查清的问题与最终结论记成一张清单（docs/known-issues.md 或 AGENTS.md 的一节）：` +
        `症状 → 根因 → 当时的修法 → 复核命令。这条是**软信号**（${f.summary}），` +
        `定位也指向具体会话，你可以直接打开看对不对。`,
      because: '同一个问题再次出现、其后又走进失败/重试，是"重新排查"的可观察代理信号。',
    }),
    risk: 'K2 是软信号（代理判据），可能把"新问题"看成"旧问题"；先打开证据确认再动手。',
    verify: '重跑 ./run.sh report：若同一指纹不再伴随失败/重试，K2 不再报。',
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
  'behavior-tool-surface': {
    risk: '卸载插件会一并失去它的能力；先确认那个工具在窗口内确实没用过，并且你不打算用。',
    verify: '重跑 ./run.sh report，看 C6 的工具 schema 字节数是否下降。',
  },
  'behavior-aux-cost': {
    risk: '少联网可能拿不到最新信息；只对"本地已有答案"的检索做裁剪。',
    verify: '重跑 ./run.sh report，看 A5 的辅助调用次数是否下降。',
  },
  'behavior-approval-preset': {
    risk: '放宽权限意味着这些工具以后不再问你 —— 只把低频危险之外的常用工具放进去，别整个放开。',
    verify: '重跑 ./run.sh report，看 N3 的审批次数与等待中位数是否下降。',
  },
  'behavior-retry-route': {
    risk: '换路由/改重试策略可能掩盖真实故障；先确认失败码分布再动。',
    verify: '重跑 ./run.sh report，看 N4 的重试次数是否下降。',
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

/**
 * 行为处方的**具体操作步骤**。
 *
 * 为什么单独一张表：用户反馈"图一虽然给出建议，但是用户不知道具体操作步骤"。
 * 「把这个序列写成一个小 skill」这种话对老手够用，对新手等于没说 ——
 * 每条行为处方都要能展开成"先做什么、再做什么"。
 *
 * 配置 / 命令 / 插件 / 设置四类处方的步骤是通用的（在 index.mjs 里按 action 生成，
 * 需要带上真实文件路径），这里只写行为类。
 */
const EXPLICIT_STEPS = {
  'behavior-mcp-idle': [
    '打开报告里 A1 的证据定位（形如 <profile>/cordis.patch.yml#L34），确认那一行就是它',
    '想留：下次相关任务里**点名**用它的工具（例如「用 files 的 read_file 看 X」），否则模型倾向用内置工具',
    '想删：用编辑器删掉 `- id: mcp-<名字>` 起的整块（name/config 那几行一起删）',
    '保存后重启 Harness（MCP 配置改动需要重启才生效；编辑同一行会原地重载）',
    '重跑 ./run.sh report：A1 里不再出现这个 serverName',
  ],
  'behavior-split-session': [
    '在当前会话里说一句：「先把进度写成交接文件：当前目标、已完成、已确认的结论、下一步、涉及的文件路径」',
    '让 Agent 把交接写到工作区的一个固定文件（例如 HANDOFF.md），确认文件真的写出来了',
    '新开一个会话，把交接文件路径贴进去，让 Agent 先读它再开工',
    '旧会话不要继续追加需求 —— 留着当存档，需要时用 ./run.sh show 复核',
  ],
  'behavior-context-hygiene': [
    '把反复粘贴的长内容挑出来：项目约定、目录结构、接口文档、术语表',
    '在项目根目录建文件（例如 AGENTS.md 或 docs/PROJECT.md），把这些内容写进去',
    '之后每个新会话只贴一行：「先读 docs/PROJECT.md」',
    '需要新增约定时改文件，不再往对话里贴 —— 同一份内容就不会被反复计费',
  ],
  'behavior-new-session': [
    '打开 ./run.sh scan，找到消息数最多的那个会话',
    '在这个会话里让 Agent 输出一份交接说明（目标 / 结论 / 未完成 / 关键文件）',
    '新建会话，把交接内容作为第一条消息发过去，继续未完成的部分',
    '旧会话封存不删 —— 需要回溯时用证据定位符复核',
  ],
  'behavior-reuse-result': [
    '从报告里给出的重复调用（证据定位可逐条复核）确认是哪几个工具',
    '把这条写进项目 AGENTS.md：「同一轮里已经取回的结果直接复用，不要重复调用同一工具同一参数」',
    '需要反复复查的内容，用脚本一次取回并落盘，让 Agent 读文件而不是反复调用工具',
  ],
  'behavior-break-loop': [
    '用 ./run.sh show "<定位符>" 打开那几次失败的原始记录，看错误文本是什么',
    '按错误类型处理：权限不足 → 授权或换目录；命令不存在 → 换等价命令；网络 → 检查代理',
    '确认走不通时直接告诉 Agent：「这条路已验证不通，换方案，不要再重试同样的命令」',
  ],
  'behavior-tool-surface': [
    '打开 ./run.sh report，看 C6 列出的"注册了多少工具 / 哪些窗口内 0 调用"',
    '把 0 调用清单分成两类：内置工具（DSH 自带，不动）与插件提供的工具',
    '对插件类：确认不再需要后卸载该插件（侧边栏 → 插件 → 卸载），它的工具 schema 就没了',
    '重启 Harness 后重跑 report，看 C6 的 schema 字节数是否下降',
  ],
  'behavior-aux-cost': [
    '打开 ./run.sh report，看 A5 的"联网检索 N 次 / 会话标题 M 次"与上界估算',
    '在项目 AGENTS.md 里加一条约定：联网搜索前先 grep/read 本地已有结论，避免重复联网',
    '把查过的重要结论写进项目文件（例如 docs/RESEARCH.md），后续直接读文件而非重新检索',
  ],
  'behavior-approval-preset': [
    '打开 ./run.sh report，看 N3 给出的"审批集中在哪些工具"（证据定位可逐条复核）',
    '侧边栏 → 插件 → 找到权限/审批设置（Host 的 permission/preset 一类入口）',
    '把这几个高频低风险工具加进允许列表，其余保持人工确认',
    '改完重启 Harness 生效，下次跑 report 看 N3 的等待中位数是否下降',
  ],
  'behavior-retry-route': [
    '打开 ./run.sh report，看 N4 给出的失败码分布与累计退避时间',
    '集中在 TIMEOUT / TRANSPORT → 先查本机网络与代理；集中在 RATE_LIMIT / SERVER → 换时段或换路由',
    '确认适配器行的 retryPolicy 是 normal（有界）而不是 always（无上限重试）',
    '改完重启，下次跑 report 看 N4 的重试次数是否下降',
  ],
  'behavior-error-rate': [
    '用 ./run.sh show "<定位符>" 抽样 3~5 条失败记录',
    '把失败原因归类（权限 / 路径 / 依赖缺失 / 网络），找出出现最多的那一类',
    '修好这一类（例如把常用目录加进可写范围、安装缺失的命令）',
    '在项目 AGENTS.md 里写明正确的前置命令，避免 Agent 再试探一遍',
  ],
  'behavior-danger-confirm': [
    '用 ./run.sh show "<定位符>" 逐条看命中的高危调用，判断是不是真的必要',
    '确实需要的：固化成脚本，并在 AGENTS.md 里写明「执行前必须先问我」',
    '不必要的：在 AGENTS.md 里明确禁止这类操作',
    '高风险操作保留人工确认，不要为了省事关掉审批',
  ],
  'behavior-drop-idle-skill': [
    '打开 ~/.agents/skills/，确认报告里列出的 skill 目录确实存在',
    '先备份：把整个目录复制到别处，或重命名加 .bak 后缀，不要直接删',
    '确认不再需要后再删除；若是插件带的 skill，改 profile 的 dsh.profile.bundles 移除它',
    '重跑 ./run.sh report，A2 里不应再出现它',
  ],
  'behavior-solidify-sequence': [
    '从证据定位里把这段序列抄下来（哪几个工具、什么参数、什么顺序）',
    '在 ~/.agents/skills/ 下新建目录，例如 my-sequence/',
    '写 SKILL.md：frontmatter 必须含 name 与 description，description 要写清"什么时候用"（它决定会不会被触发）',
    '把固定不变的部分写成脚本放在同目录，SKILL.md 里说明怎么调用',
    '之后一句话就能触发，不用每次手动带 Agent 走一遍',
  ],
  'behavior-subagent-budget': [
    '翻最近的会话，找出派了子代理但结果没被真正用上的那些',
    '下次派活时把任务缩到一句话能说清：目标 / 输入文件 / 期望输出格式 / 边界（不许做什么）',
    '在指令里加上「只回结论，不要回过程」',
    '能自己做完的小任务不要派子代理 —— 子代理按独立会话全额计费',
  ],
  'behavior-cross-session-note': [
    '打开报告里 K1 的 Evidence，确认这几个会话问的确实是同一件事（指纹只证明文本重合）',
    '把这件事的结论写成文件：项目根目录 AGENTS.md 的「约定」一节，或新增 docs/<主题>.md',
    '文件里至少写清：结论 / 为什么这么做 / 怎么复核（可复制的命令）',
    '在项目 AGENTS.md 里加一句：「开新会话先读 docs/<主题>.md 再动手」',
    '下次同类问题直接在会话开头引用该文件，不再复述背景',
  ],
  'behavior-resolved-list': [
    '打开报告里 K2 的两条证据定位，确认"后一次"确实是在重复排查（而不是新问题）',
    '在 docs/known-issues.md 建表：症状 / 根因 / 修法 / 复核命令 / 当时日期',
    '把这次确认过的问题补进去，尤其写清"怎么验证已经修好"',
    '在项目 AGENTS.md 里写：「排查失败类问题前，先查 docs/known-issues.md」',
    '下次再遇到同类症状，先跑清单里的复核命令，再决定要不要重新排查',
  ],
  'behavior-todo-update': [
    '在项目 AGENTS.md 里写明：「每完成一步立刻更新 todo 状态，不要全部做完后一次性回写」',
    '长任务开始时先让 Agent 用 todo_write 列出计划（3~7 条为宜）',
    '中途抽看一眼计划：如果工具调用了很多次但状态还停在第一项，当场纠正',
  ],
};

for (const r of REMEDIES) {
  if (EXPLICIT_STEPS[r.id]) r.steps = EXPLICIT_STEPS[r.id];
}

/** 会话里调用次数最多的工具（用于让处方"对着你的用法说话"） */
function topTool(ctx) {
  const byTool = ctx?.summary?.global?.byTool ?? null;
  if (!byTool) return [null, 0];
  const sorted = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0] : [null, 0];
}


export { toPatchSnippet };
