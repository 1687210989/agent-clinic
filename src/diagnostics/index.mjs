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

import fs from 'node:fs';
import { KIND } from '../adapters/base.mjs';
import { num, pct } from '../summary.mjs';

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
// C 类：成本
// ---------------------------------------------------------------------------

/** 中位数（自身基线，不做跨用户比较） */
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * C1 token 消耗过快
 * 单会话 output_tokens vs 自身其他会话的中位数，超 50%
 */
function detectC1(ctx, opts) {
  const ratio = opts.c1BaselineRatio ?? 1.5;
  const minSessions = 3; // 样本太少无法定义"基线"
  const sessions = ctx.scan.sessions;
  if (sessions.length < minSessions) return [];

  const totals = sessions.map((s) =>
    s.events
      .filter((e) => e.kind === KIND.ASSISTANT_MSG)
      .reduce((n, e) => n + (e.output_tokens ?? 0), 0),
  );
  const base = median(totals);
  if (!base || base <= 0) return [];

  const findings = [];
  for (const [i, s] of sessions.entries()) {
    const v = totals[i];
    if (v <= base * ratio) continue;
    const ev = s.events.find((e) => e.kind === KIND.ASSISTANT_MSG);
    if (!ev) continue;
    findings.push({
      id: 'C1',
      title: 'token 消耗过快',
      category: 'C',
      severity: SEVERITY.HIGH,
      scope: s.sessionId,
      summary: `本会话 output ${num(v)}，是自身基线 ${num(base)} 的 ${(v / base).toFixed(1)} 倍（阈值 ${ratio} 倍）`,
      evidence: [{ locator: ev.locator, note: '首个 assistant 消息' }],
      impact: `约多消耗 ${num(v - base)} output token`,
      confidence: 0.7,
    });
  }
  return findings;
}

/**
 * C2 上下文膨胀
 * 末轮 / 首轮 input 比值 > 10x 且 cache_read 占比 < 30%
 */
function detectC2(ctx, opts) {
  const growthRatio = opts.c2GrowthRatio ?? 10;
  const cacheShareMin = opts.c2CacheShareMin ?? 0.3;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const msgs = s.events.filter((e) => e.kind === KIND.ASSISTANT_MSG);
    if (msgs.length < 8) continue; // 太少没有"膨胀"可言
    const inputs = msgs.map((m) => m.input_tokens ?? 0);
    const first = inputs[0];
    const last = inputs[inputs.length - 1];
    if (first <= 0 || last <= first * growthRatio) continue;

    const totalIn = inputs.reduce((a, b) => a + b, 0);
    const cacheRead = msgs.reduce((n, m) => n + (m.cache_read_tokens ?? 0), 0);
    const share = totalIn + cacheRead > 0 ? cacheRead / (totalIn + cacheRead) : 0;
    if (share >= cacheShareMin) continue; // 已经在吃缓存红利，不算膨胀

    findings.push({
      id: 'C2',
      title: '上下文膨胀',
      category: 'C',
      severity: SEVERITY.HIGH,
      scope: s.sessionId,
      summary:
        `input 从首轮 ${num(first)} 涨到末轮 ${num(last)}（${(last / first).toFixed(1)} 倍），` +
        `cacheRead 仅占 ${pct(share)}`,
      evidence: [
        { locator: msgs[0].locator, note: `首轮 input ${num(first)}` },
        { locator: msgs[msgs.length - 1].locator, note: `末轮 input ${num(last)}` },
      ],
      impact: `末轮比首轮多带 ${num(last - first)} input token`,
      confidence: 0.8,
    });
  }
  return findings;
}

/**
 * C3 长会话疲劳
 * 单会话消息数 > 200 且无 compact
 */
function detectC3(ctx, opts) {
  const limit = opts.c3MessageLimit ?? 200;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const count = s.events.filter(
      (e) => e.kind === KIND.USER_MSG || e.kind === KIND.ASSISTANT_MSG,
    ).length;
    if (count <= limit) continue;
    const ev = s.events.find((e) => e.kind === KIND.USER_MSG) ?? s.events[0];
    if (!ev) continue;
    findings.push({
      id: 'C3',
      title: '长会话疲劳',
      category: 'C',
      severity: SEVERITY.MID,
      scope: s.sessionId,
      summary: `单会话 ${count} 条消息，超过 ${limit} 条阈值`,
      evidence: [{ locator: ev.locator, note: `会话共 ${count} 条消息` }],
      impact: '长会话更容易跑偏、重复劳动，建议拆分任务或开新会话',
      confidence: 0.7,
    });
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

// ---------------------------------------------------------------------------
// E4 计划执行脱节
// ---------------------------------------------------------------------------

function detectE4(ctx, opts) {
  const minStepsAfter = opts.e4MinStepsAfter ?? 5;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const todos = s.events.filter((e) => e.kind === KIND.TODO_WRITE);
    if (todos.length === 0) continue;
    const last = todos[todos.length - 1];
    const total = last.todo_count ?? 0;
    const done = last.done_count ?? 0;
    if (total <= 0 || done > 0) continue;

    // 写完计划之后还得真的在干活，否则"没执行"可能只是会话刚开始
    const idx = s.events.indexOf(last);
    const after = s.events.slice(idx + 1).filter((e) => e.kind === KIND.TOOL_CALL).length;
    if (after < minStepsAfter) continue;

    findings.push({
      id: 'E4',
      title: '计划执行脱节',
      category: 'E',
      severity: SEVERITY.MID,
      scope: s.sessionId,
      summary: `写了 ${total} 条计划，之后又执行了 ${after} 次工具调用，但没有一条被标记完成`,
      evidence: [
        { locator: last.locator, note: `${total} 条计划，0 条完成` },
      ],
      impact: '计划与执行脱节时，Agent 容易重复劳动或漏掉步骤',
      confidence: 0.65,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// N 类：风险
// ---------------------------------------------------------------------------

/** 命令执行类工具（与适配器的 COMMAND_TOOLS 保持一致） */
const CMD_TOOL_RE =
  /^(?:pwsh|powershell|powershell\.exe|pwsh\.exe|bash|sh|zsh|dash|shell|exec|execute|run_command|cmd|cmd\.exe|terminal|node|python|python3|ruby)$/i;

/**
 * N1 环境命令反复失败
 * 与 E1 的区别：不要求同参数 —— 命令类失败往往是参数不同但环境相同
 */
function detectN1(ctx, opts) {
  const minRepeat = opts.n1MinRepeat ?? 3;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const { byId } = pairCalls(s);
    const cmdCalls = s.events.filter(
      (e) => e.kind === KIND.TOOL_CALL && CMD_TOOL_RE.test(String(e.tool_name || '')),
    );
    if (cmdCalls.length === 0) continue;

    const errs = cmdCalls.filter((c) => {
      const r = byId.get(c.tool_call_id);
      return r && r.is_error;
    });
    if (errs.length < minRepeat) continue;

    findings.push({
      id: 'N1',
      title: '环境命令反复失败',
      category: 'N',
      severity: SEVERITY.MID,
      scope: s.sessionId,
      summary: `命令类调用失败 ${errs.length} 次（阈值 ${minRepeat}）`,
      evidence: errs.slice(0, 8).map((c) => ({ locator: c.locator, note: `${c.tool_name} 失败` })),
      impact: '命令反复失败通常是环境问题（权限 / 路径 / 工具缺失），不是模型问题',
      confidence: 0.8,
    });
  }
  return findings;
}

/** N2 高危操作 —— danger 由适配器在解析时打标，这里只汇总 */
function detectN2(ctx) {
  const findings = [];
  for (const s of ctx.scan.sessions) {
    const hits = s.events.filter((e) => e.kind === KIND.TOOL_CALL && e.danger?.length);
    if (hits.length === 0) continue;
    const patterns = [...new Set(hits.flatMap((h) => h.danger))];
    findings.push({
      id: 'N2',
      title: '高风险操作',
      category: 'N',
      severity: SEVERITY.HIGH,
      scope: s.sessionId,
      summary: `检测到 ${hits.length} 次高危命令调用，命中模式：${patterns.join('、')}`,
      evidence: hits.slice(0, 8).map((h) => ({
        locator: h.locator,
        note: `${h.tool_name} 命中 ${h.danger.join('、')}`,
      })),
      impact: '建议对这类命令建立人工确认习惯',
      confidence: 0.9,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A 类：资产
// ---------------------------------------------------------------------------

/**
 * A3 高频手动序列
 * 同工具**相邻**序列模式复现 >=5 次
 *
 * ⚠️ 必须是两个**不同**工具的相邻转换。
 * 实测踩过的坑：早期版本允许 `web_fetch→web_fetch`，结果把"连续抓取
 * 44 个 URL"当成高频手动序列报了 4 条 —— 那只是单一工具的重复使用，
 * 不是"序列",也没有可自动化的固定套路。
 */
function detectA3(ctx, opts) {
  const minRepeat = opts.a3MinRepeat ?? 5;
  const findings = [];

  for (const s of ctx.scan.sessions) {
    const calls = s.events.filter((e) => e.kind === KIND.TOOL_CALL);
    const names = calls.map((e) => e.tool_name);
    if (names.length < minRepeat * 2) continue;

    const counts = new Map();
    const firstAt = new Map();
    for (let i = 0; i + 1 < names.length; i++) {
      const a = names[i];
      const b = names[i + 1];
      if (a === b) continue; // 同一工具的连续使用不算"序列"
      const key = `${a}→${b}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!firstAt.has(key)) firstAt.set(key, calls[i].locator);
    }

    for (const [key, n] of counts) {
      if (n < minRepeat) continue;
      findings.push({
        id: 'A3',
        title: '高频手动序列',
        category: 'A',
        severity: SEVERITY.MID,
        scope: s.sessionId,
        summary: `工具序列「${key}」重复 ${n} 次，可考虑固化为技能`,
        evidence: [{ locator: firstAt.get(key), note: `该序列首次出现` }],
        impact: `${n - 1} 次重复的序列操作，可自动化`,
        confidence: 0.7,
      });
    }
  }
  return findings;
}

/**
 * A4 子代理开销
 * delegationDepth>0 的会话 token 占比 > 40%
 */
function detectA4(ctx, opts) {
  const threshold = opts.a4SubagentShare ?? 0.4;
  const findings = [];

  let total = 0;
  let sub = 0;
  const subSessions = [];
  for (const s of ctx.scan.sessions) {
    const t = s.events
      .filter((e) => e.kind === KIND.ASSISTANT_MSG)
      .reduce((n, e) => n + (e.total_tokens ?? (e.input_tokens ?? 0) + (e.output_tokens ?? 0)), 0);
    total += t;
    if (s.isSubagent) {
      sub += t;
      subSessions.push({ s, t });
    }
  }
  if (total <= 0 || subSessions.length === 0) return [];

  const share = sub / total;
  if (share <= threshold) return [];

  const worst = subSessions.sort((a, b) => b.t - a.t)[0];
  findings.push({
    id: 'A4',
    title: '子代理开销',
    category: 'A',
    severity: SEVERITY.MID,
    scope: worst.s.sessionId,
    summary: `${subSessions.length} 个子代理会话占总 token 的 ${pct(share)}（阈值 ${(threshold * 100).toFixed(0)}%）`,
    evidence: subSessions.slice(0, 8).map(({ s, t }) => {
      const ev = s.events.find((e) => e.kind === KIND.ASSISTANT_MSG);
      return { locator: ev?.locator ?? s.file, note: `子代理会话 ${num(t)} token` };
    }),
    impact: '子代理是按会话全额计费的，收敛使用策略可直接降本',
    confidence: 0.75,
  });
  return findings;
}

/**
 * A1 / A2 资产闲置
 *
 * 需要外部数据（MCP 配置 / 已装 skill 目录），且任务书要求"30 天窗口"。
 * 扫描窗口不足时**明确不报**，并说明原因 —— 拿 3 天数据假装能下 30 天
 * 的结论，比不报更糟。
 *
 * @returns {{findings:Array, note?:string}}
 */
function detectAssetIdle(ctx, opts) {
  const minDays = opts.assetMinDays ?? 30;

  // 扫描窗口：用事件时间跨度估算
  const times = ctx.scan.sessions
    .map((s) => {
      const t = s.events[0]?.ts ? Date.parse(s.events[0].ts) : NaN;
      return Number.isFinite(t) ? t : NaN;
    })
    .filter((n) => Number.isFinite(n));
  const spanDays =
    times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 86400000 : 0;

  const findings = [];

  if (spanDays < minDays) {
    return {
      findings,
      note: `扫描窗口仅 ${spanDays.toFixed(1)} 天（需 ${minDays} 天）—— 样本不足，无法判定资产闲置；这不是"已确认无异常"`,
    };
  }

  const skills = listInstalledSkills();
  const usedTools = new Set(
    ctx.scan.sessions.flatMap((s) =>
      s.events.filter((e) => e.kind === KIND.TOOL_CALL).map((e) => e.tool_name),
    ),
  );
  const firstEv = ctx.scan.sessions.find((s) => s.events[0]);
  for (const name of skills) {
    // skill 在 DSH 里触发时表现为同名工具调用
    if (usedTools.has(name)) continue;
    findings.push({
      id: 'A2',
      title: 'skill 闲置',
      category: 'A',
      severity: SEVERITY.MID,
      scope: null,
      summary: `已装 skill「${name}」在 ${Math.floor(spanDays)} 天窗口内 0 次触发`,
      evidence: [],
      impact: '卸载可省启动时间与维护成本',
      confidence: 0.7,
    });
  }
  if (findings.length === 0) {
    return { findings, note: `已装 skill 共 ${skills.length} 个，窗口内均有触发` };
  }
  return { findings };
}

/** 列出已安装的 skill 名（只读目录名，不读内容） */
function listInstalledSkills() {
  const out = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return out;
  for (const sub of ['.agents/skills', '.workbuddy/skills']) {
    try {
      const dir = `${home}/${sub}`;
      if (!fs.existsSync(dir)) continue;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(e.name);
      }
    } catch {
      /* 目录不存在或无权限：跳过 */
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// 指标注册表
// ---------------------------------------------------------------------------

export const REGISTRY = [
  // --- C 类：成本 ---
  {
    id: 'C1',
    title: 'token 消耗过快',
    category: 'C',
    severity: SEVERITY.HIGH,
    implemented: true,
    desc: '单会话 output 超自身其他会话中位数 50%',
    detect: detectC1,
  },
  {
    id: 'C2',
    title: '上下文膨胀',
    category: 'C',
    severity: SEVERITY.HIGH,
    implemented: true,
    desc: '末轮/首轮 input 增长 >10x 且 cacheRead <30%',
    detect: detectC2,
  },
  {
    id: 'C3',
    title: '长会话疲劳',
    category: 'C',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '单会话消息数 > 200',
    detect: detectC3,
  },
  // --- E 类：效率 ---
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
    id: 'E4',
    title: '计划执行脱节',
    category: 'E',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '有计划无执行（写 >=1 条计划后仍大量调用工具但 0 条完成）',
    detect: detectE4,
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
  // --- N 类：风险 ---
  {
    id: 'N1',
    title: '环境命令反复失败',
    category: 'N',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '命令类调用失败 >=3 次（不要求同参数）',
    detect: detectN1,
  },
  {
    id: 'N2',
    title: '高风险操作',
    category: 'N',
    severity: SEVERITY.HIGH,
    implemented: true,
    desc: '命令执行类工具命中高危模式（rm -rf / --force / reset --hard 等）',
    detect: detectN2,
  },
  // --- A 类：资产 ---
  {
    id: 'A2',
    title: 'skill 闲置',
    category: 'A',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '已装 skill 在扫描窗口内 0 次触发（需 >=30 天窗口）',
    detect: detectAssetIdle,
  },
  {
    id: 'A3',
    title: '高频手动序列',
    category: 'A',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '同工具相邻序列模式复现 >=5 次',
    detect: detectA3,
  },
  {
    id: 'A4',
    title: '子代理开销',
    category: 'A',
    severity: SEVERITY.MID,
    implemented: true,
    desc: 'delegationDepth>0 会话 token 占比 >40%',
    detect: detectA4,
  },
  // --- M2+ 预留 ---
  { id: 'A1', title: 'MCP 闲置', category: 'A', severity: SEVERITY.MID, implemented: false, desc: '已配置 MCP 30 天 0 调用（本机未配置 MCP，暂无数据源）', detect: () => [] },
  // --- 已废弃：数据源在 DSH 中不存在，非实现优先级问题 ---
  // E3（工具结果过大）：tool/result 只归一化 is_error，不含 content/长度
  // K1/K2（跨会话失忆 / 已解决重新排查）：user/message 只保留 text_len，无正文，
  //   无法跨会话比对"同一个问题"
  // N3（权限审批摩擦）：只有 approval/policy（策略快照），无 approval/asked/decided
  // N4（API 重试频繁）：无 llm/retry 事件
  // I1/I2/I3（无用思考 / 反复澄清 / 不合偏好）：v4 已整体砍掉
];

/**
 * 明确不可实现的指标。
 *
 * 与「未实现（排期中）」区分开：这些是**数据源在 DSH 里不存在**，
 * 不是优先级问题。报告必须把它们列出来，否则读者会以为
 * "没报 = 没问题"。
 */
export const UNIMPLEMENTABLE = [
  {
    id: 'E3',
    title: '工具结果过大',
    reason: 'tool/result 只归一化 is_error，不含 content 原文与长度',
  },
  {
    id: 'K1',
    title: '跨会话失忆',
    reason: 'user/message 只保留 text_len，无正文，无法跨会话比对你是否在重复问同一个问题',
  },
  {
    id: 'K2',
    title: '已解决重新排查',
    reason: '同上，缺少用户文本正文',
  },
  {
    id: 'N3',
    title: '权限审批摩擦',
    reason: 'DSH 只有 approval/policy（策略快照），没有 approval/asked / approval/decided',
  },
  {
    id: 'N4',
    title: 'API 重试频繁',
    reason: 'DSH 会话日志中不存在 llm/retry 事件',
  },
];

/**
 * 运行诊断。
 *
 * @param {{scan:object, summary:object}} ctx
 * @param {Object} [opts]
 * @returns {{findings:Finding[], notDetected:Array, notImplemented:Array, unimplementable:Array}}
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
    let note = null;
    try {
      const raw = metric.detect(ctx, opts);
      // detect 可直接返回数组，或返回 { findings, note }
      if (Array.isArray(raw)) {
        result = raw;
      } else if (raw && typeof raw === 'object') {
        result = Array.isArray(raw.findings) ? raw.findings : [];
        note = typeof raw.note === 'string' ? raw.note : null;
      }
    } catch (e) {
      notDetected.push({ id: metric.id, title: metric.title, note: `判定异常：${e.message}` });
      continue;
    }
    if (result.length === 0) {
      notDetected.push({ id: metric.id, title: metric.title, note });
    } else {
      findings.push(...result);
    }
  }

  const order = { [SEVERITY.HIGH]: 0, [SEVERITY.MID]: 1, [SEVERITY.LOW]: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  return { findings, notDetected, notImplemented, unimplementable: UNIMPLEMENTABLE };
}

export { KIND };
