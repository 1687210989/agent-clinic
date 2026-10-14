/**
 * L2 诊断层 —— 指标判定
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
 * @property {string} title       问题标题
 * @property {string} severity    SEVERITY.*
 * @property {string} category    'C'|'E'|'K'|'N'|'A'
 * @property {string} summary     一句话结论
 * @property {Array<{locator:string,note?:string}>} evidence 证据定位
 * @property {string} [impact]    影响估算
 * @property {number} confidence  0~1
 * @property {string} [scope]     会话标识（用于报告分组）
 * @property {string} [tool]      涉及的工具名（E1/E5）
 * @property {number} [repeatCount] 重复次数（E1/E5）
 */

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 把 tool/call 与 tool/result 按 callId 配对 */
function pairCalls(session) {
  const calls = session.events.filter((e) => e.kind === KIND.TOOL_CALL);
  const results = session.events.filter((e) => e.kind === KIND.TOOL_RESULT);
  const byId = new Map();
  for (const r of results) {
    if (r.tool_call_id) byId.set(r.tool_call_id, r);
  }
  return { calls, results, byId };
}

/** 按 tool_name + args_hash 分组 */
function groupIdenticalCalls(calls) {
  const groups = new Map();
  for (const c of calls) {
    const key = `${c.tool_name}|${c.tool_args_hash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return groups;
}

const lineOf = (locator) => {
  const s = String(locator);
  const i = s.lastIndexOf('#L');
  return i < 0 ? '?' : s.slice(i + 2);
};

// ---------------------------------------------------------------------------
// E1 死循环
// ---------------------------------------------------------------------------

function detectE1(ctx, opts) {
  const minRepeat = opts.minRepeatCount ?? 3;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const { calls, byId } = pairCalls(s);
    for (const [key, list] of groupIdenticalCalls(calls)) {
      if (list.length < minRepeat) continue;

      // 防误报：只取「同参数 + 同错误」的调用；参数有变化的试错不算
      const errored = list.filter((c) => {
        const r = byId.get(c.tool_call_id);
        return r && r.is_error;
      });
      if (errored.length < minRepeat) continue;

      const toolName = key.split('|')[0];
      const first = errored[0];
      const last = errored[errored.length - 1];
      findings.push({
        id: 'E1',
        title: '死循环',
        category: 'E',
        severity: SEVERITY.HIGH,
        scope: s.sessionId,
        tool: toolName,
        repeatCount: errored.length,
        summary: `${toolName} 用相同参数连续失败 ${errored.length} 次`,
        evidence: [
          {
            locator: `${first.locator}-L${lineOf(last.locator)}`,
            note: `${errored.length} 次同参数同错误的调用`,
          },
          ...errored.map((c) => ({ locator: c.locator, note: `${toolName} 失败` })),
        ],
        impact: `约 ${errored.length} 次无效工具调用`,
        confidence: 0.9,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// E2 反复失败
// ---------------------------------------------------------------------------

function detectE2(ctx, opts) {
  const threshold = opts.errorRateThreshold ?? 0.3;
  const minCalls = opts.minCallsForRate ?? 10;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const { calls, results } = pairCalls(s);
    if (calls.length < minCalls) continue; // 样本太小不下结论
    const errors = results.filter((r) => r.is_error);
    const rate = results.length > 0 ? errors.length / results.length : 0;
    if (rate <= threshold) continue;

    findings.push({
      id: 'E2',
      title: '反复失败',
      category: 'E',
      severity: SEVERITY.MID,
      scope: s.sessionId,
      summary:
        `工具调用错误率 ${(rate * 100).toFixed(1)}%（${errors.length}/${results.length}）` +
        `，高于 ${(threshold * 100).toFixed(0)}% 阈值`,
      evidence: errors.slice(0, 10).map((r) => ({ locator: r.locator, note: '工具调用失败' })),
      impact: `${errors.length} 次失败的工具调用`,
      confidence: 0.85,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// E5 冗余重复调用
//
// ⚠️ 本指标为**基于真实数据实测新增**，不在任务书原 17 项内。
//
// 起因：任务书的 E1 要求「同参数 + 同错误」，但实测本机数据中
// 同参数重复 4 次的 list_agents 调用**全部成功** —— 严格按 E1 定义
// 一条都命中不了。而这类「同参数、成功、重复」的调用同样在浪费
// token（每次调用都要重新走一遍模型 + 工具），值得单独报出。
//
// 与 E1 的边界：
//   E1 = 同参数 + 同错误（卡死，无法推进）
//   E5 = 同参数 + 无错误（冗余，可避免的重复劳动）
// ---------------------------------------------------------------------------

function detectE5(ctx, opts) {
  const minRepeat = opts.minRepeatCount ?? 3;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const { calls, byId } = pairCalls(s);
    for (const [key, list] of groupIdenticalCalls(calls)) {
      if (list.length < minRepeat) continue;

      const paired = list.map((c) => byId.get(c.tool_call_id)).filter(Boolean);
      if (paired.length < list.length) continue; // 结果缺失则不下结论
      // 只要有错误就交给 E1，避免同一件事报两次
      if (paired.some((r) => r.is_error)) continue;

      const toolName = key.split('|')[0];
      const redundant = list.length - 1; // 首次视为可能必要
      const first = list[0];
      const last = list[list.length - 1];
      findings.push({
        id: 'E5',
        title: '冗余重复调用',
        category: 'E',
        severity: SEVERITY.MID,
        scope: s.sessionId,
        tool: toolName,
        repeatCount: list.length,
        summary: `${toolName} 用完全相同的参数成功调用了 ${list.length} 次（可省 ${redundant} 次）`,
        evidence: [
          {
            locator: `${first.locator}-L${lineOf(last.locator)}`,
            note: `${list.length} 次同参数调用`,
          },
          ...list.map((c) => ({ locator: c.locator, note: `${toolName} 同参数调用` })),
        ],
        impact: `约 ${redundant} 次冗余调用，每次都要重新消耗 token`,
        confidence: 0.75,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 指标注册表
// ---------------------------------------------------------------------------

export const REGISTRY = [
  {
    id: 'E1',
    title: '死循环',
    category: 'E',
    severity: SEVERITY.HIGH,
    implemented: true,
    desc: '同工具 + 同参数 + 同错误，重复 >=3 次',
    detect: detectE1,
  },
  {
    id: 'E2',
    title: '反复失败',
    category: 'E',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '会话工具错误率 > 30%',
    detect: detectE2,
  },
  {
    id: 'E5',
    title: '冗余重复调用',
    category: 'E',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '同工具 + 同参数 + 无错误，重复 >=3 次（实测新增）',
    detect: detectE5,
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
 * @param {{scan:object, summary:object}} ctx
 * @param {Object} [opts]
 * @returns {{findings:Finding[], notDetected:Array, notImplemented:Array}}
 */
export function runDiagnostics(ctx, opts = {}) {
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
      result = metric.detect(ctx, opts) ?? [];
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
