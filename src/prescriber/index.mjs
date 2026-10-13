/**
 * L4 处方层 —— 问题 → 处方映射
 *
 * 原则（任务书 §5.4）：
 *   - 处方池只有 5 项（宁精勿滥），每次输出 <= 2 条
 *   - 每条处方必须"自证有效"：说明它如何解决对应的检测到的信号
 *   - 无对症插件时，诚实给"行为建议"，不硬凑
 *   - 四重过滤：已装 / 已推荐 / 已拒绝 / 不感兴趣
 *
 * 【当前状态：骨架】处方池数据已就绪；匹配与过滤待 M3。
 */

/** 处方形态 */
export const RX_TYPE = {
  INSTALL: 'install',   // 安装现成插件
  BUILD: 'build',       // 自建 skill
  CONFIG: 'config',     // 平台配置建议
  BEHAVIOR: 'behavior', // 行为建议
};

/**
 * 处方池（5 项，均于 2026-10-13 核实为真实存在）
 * 星数仅供参考，不参与判定。
 */
export const PRESCRIPTIONS = [
  {
    id: 'caveman',
    name: 'caveman',
    type: RX_TYPE.INSTALL,
    targets: ['C1', 'C3', 'E3'],
    solves: '回复冗长、token 浪费',
    stars: 111353,
    install: { dsh: 'dsh plugin add caveman', workbuddy: 'npx skills add caveman' },
  },
  {
    id: 'superpowers',
    name: 'Superpowers',
    type: RX_TYPE.INSTALL,
    targets: ['E4'],
    solves: '计划执行脱节、流程失控',
    stars: 298450,
    install: { dsh: 'dsh plugin add superpowers', workbuddy: 'npx skills add superpowers' },
  },
  {
    id: 'claude-mem',
    name: 'claude-mem',
    type: RX_TYPE.INSTALL,
    targets: ['K1', 'C3'],
    solves: '跨会话失忆、重复解释',
    stars: 100270,
    install: { dsh: 'dsh plugin add claude-mem', workbuddy: 'npx skills add claude-mem' },
  },
  {
    id: 'deja-vu',
    name: 'deja-vu',
    type: RX_TYPE.INSTALL,
    targets: ['E2', 'K2', 'N1'],
    solves: '历史检索、已解决问题重新排查',
    stars: 1185,
    note: 'DSH 原生（含 dsh-plugin topic）',
    install: { dsh: 'dsh plugin add deja-vu', workbuddy: 'npx skills add deja-vu' },
  },
  {
    id: 'skill-creator',
    name: 'skill-creator',
    type: RX_TYPE.BUILD,
    targets: ['A3'],
    solves: '高频手动序列 → 固化为技能',
    stars: null,
    note: '自建处方',
    install: { dsh: '（自建，非安装）', workbuddy: '（自建，非安装）' },
  },
];

/** 无法用插件解决的问题 → 诚实给行为建议 */
export const NO_PLUGIN_SOLUTIONS = {
  E1: { type: RX_TYPE.BEHAVIOR, text: '死循环在 GitHub 上没有对症的现成插件。建议：定位到重复的那次调用，检查参数或工具本身，必要时中断并换策略。' },
  N2: { type: RX_TYPE.BEHAVIOR, text: '高风险操作没有插件可拦。建议：为这类命令建立人工确认习惯。' },
  N4: { type: RX_TYPE.BEHAVIOR, text: '重试频繁多为网络或 provider 侧问题。建议：检查网络 / 更换 provider / 降级模型。' },
  A1: { type: RX_TYPE.BEHAVIOR, text: 'MCP 闲置建议直接卸载，省磁盘与启动时间。' },
  A2: { type: RX_TYPE.BEHAVIOR, text: 'skill 闲置建议直接卸载，省启动时间。' },
};

/**
 * 为问题 ID 匹配处方。
 * @returns {Array} 0~2 条
 */
export function matchPrescriptions(_problemId, _opts = {}) {
  // 【M3 待实现】四重过滤 + 自证 + 平台化命令生成
  return [];
}

/**
 * 校验"处方自证"：处方必须能说明它如何解决对应信号。
 * @returns {{ok:boolean, reason?:string}}
 */
export function selfJustify(prescription, problemId) {
  if (!prescription?.targets?.includes(problemId)) {
    return { ok: false, reason: `处方 ${prescription?.id} 未声明可解决 ${problemId}` };
  }
  if (!prescription.solves) {
    return { ok: false, reason: '处方缺少 solves 说明，无法自证' };
  }
  return { ok: true };
}
