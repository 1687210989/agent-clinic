/**
 * L2 诊断层 —— 指标判定
 *
 * 【当前状态：骨架】M1 只实现 E1 / E2，其余指标留空位。
 *
 * 约定（与任务书 §5.3 一致）：
 *   1. 可定位 —— 每个结论必须附 locator，不可复现的结论不出
 *   2. 死循环豁免正常重试 —— 同参数 + 同错误 + >=3 次，参数有变化的不算
 *   3. 软信号仅 K2 一项，措辞"疑似"，不给"高"严重度
 *   4. 单样本不出结论
 *   5. 禁止硬编问题 —— 未检测到异常必须在报告中显式列出
 *   6. 处方须自证有效
 */

import { KIND } from '../adapters/base.mjs';

/** 严重度 */
export const SEVERITY = { HIGH: '高', MID: '中', LOW: '低' };

/**
 * @typedef {Object} Finding
 * @property {string} id          指标 ID，如 'E1'
 * @property {string} title       问题标题，如 '死循环'
 * @property {string} severity    SEVERITY.*
 * @property {string} category    'C'|'E'|'K'|'N'|'A'
 * @property {string} summary     一句话结论
 * @property {Array<{locator:string, note?:string}>} evidence 证据定位
 * @property {string} [impact]    影响估算
 * @property {number} confidence  0~1
 */

/**
 * 指标注册表。
 * `detect` 返回 Finding[]（空数组 = 未检测到异常）。
 * 未实现的指标 detect 返回 []，并由 runner 记为 "未实现"。
 */
export const REGISTRY = [
  {
    id: 'E1',
    title: '死循环',
    category: 'E',
    severity: SEVERITY.HIGH,
    implemented: false,
    desc: '同工具 + 同参数 + 同错误，重复 >=3 次',
    detect: () => [],
  },
  {
    id: 'E2',
    title: '反复失败',
    category: 'E',
    severity: SEVERITY.MID,
    implemented: false,
    desc: '会话工具错误率 > 30%',
    detect: () => [],
  },
  // --- M2 预留 ---
  { id: 'C1', title: 'token 消耗过快', category: 'C', severity: SEVERITY.HIGH, implemented: false, desc: '超自身 30 天基线 50%', detect: () => [] },
  { id: 'C2', title: '上下文膨胀', category: 'C', severity: SEVERITY.HIGH, implemented: false, desc: '末轮/首轮 input 增长 >10x（阈值待重新标定）', detect: () => [] },
  { id: 'A1', title: 'MCP 闲置', category: 'A', severity: SEVERITY.MID, implemented: false, desc: '已配置 MCP 30 天 0 调用', detect: () => [] },
  { id: 'A2', title: 'skill 闲置', category: 'A', severity: SEVERITY.MID, implemented: false, desc: '已装 skill 30 天未触发', detect: () => [] },
  // --- 已废弃 ---
  // I1/I2/I3（无用思考 / 需求反复澄清 / 输出不合偏好）：
  //   v4 已整体砍掉 —— 中文启发式误报率高，且无可执行处方。
  // N3/N4（审批摩擦 / API 重试）：
  //   实测 DSH 不存在 approval/asked、approval/decided、llm/retry 事件，暂不可实现。
];

/**
 * 运行诊断。
 *
 * @param {ReturnType<import('../summary.mjs').summarize>} summary
 * @param {Object} [opts]
 * @returns {{findings:Finding[], notDetected:Array, notImplemented:Array}}
 */
export function runDiagnostics(summary, opts = {}) {
  const findings = [];
  const notDetected = [];
  const notImplemented = [];

  for (const metric of REGISTRY) {
    if (!metric.implemented) {
      notImplemented.push({ id: metric.id, title: metric.title, category: metric.category });
      continue;
    }
    let result = [];
    try {
      result = metric.detect(summary, opts) ?? [];
    } catch (e) {
      notDetected.push({ id: metric.id, title: metric.title, note: `判定异常：${e.message}` });
      continue;
    }
    if (result.length === 0) {
      notDetected.push({ id: metric.id, title: metric.title });
    } else {
      findings.push(...result);
    }
  }

  const order = { [SEVERITY.HIGH]: 0, [SEVERITY.MID]: 1, [SEVERITY.LOW]: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  return { findings, notDetected, notImplemented };
}

export { KIND };
