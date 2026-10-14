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
 * C1 token 消耗过快 —— **第二轮评估 F12 重写**
 *
 * 旧判据（"单会话 output 总量 > 全会话总量中位数 × 1.5"）有三处硬伤，
 * 实测 13 个会话命中 6 个，测出来的是"这个会话干了多少活"而不是"浪费"：
 *   1. 基线混入空会话：两个 0 值会话把中位数从 15,760 拉到 10,329；
 *   2. 主会话与子代理会话混在一个中位数里 —— 子代理串行干活天然高于中位数；
 *   3. 不做归一化：output 总量只反映会话长短，长会话必然上榜。
 * 而且报告里写"自身基线"，那个数字其实与"自身"无关。
 *
 * 新判据：
 *   - 基线只取**主会话**（非子代理、有 assistant 用量、output > 0）的单位请求 output 中位数
 *   - 归一化：比较 output / 请求数，而不是会话总量
 *   - 绝对量下限：会话 output 总量低于阈值不报（小会话凭比例上榜没有意义）
 *   - 措辞如实说明"产出量大不必然是浪费"，并指向 E1/E5/C2 去看重复劳动
 */
function detectC1(ctx, opts) {
  const ratio = opts.c1BaselineRatio ?? 2;
  const minSessions = opts.c1MinSessions ?? 3;
  const minOutput = opts.c1MinOutputTokens ?? 20000;
  if (ctx.scan.sessions.length < minSessions) return [];

  const stats = [];
  for (const s of ctx.scan.sessions) {
    const msgs = s.events.filter((e) => e.kind === KIND.ASSISTANT_MSG);
    if (!msgs.length) continue;
    const output = msgs.reduce((n, e) => n + (e.output_tokens ?? 0), 0);
    stats.push({
      session: s,
      msgs,
      output,
      requests: msgs.length,
      perRequest: output / msgs.length,
      subagent: Boolean(s.isSubagent),
    });
  }

  // 基线：主会话、有实际产出
  const baselinePool = stats.filter((x) => !x.subagent && x.output > 0).map((x) => x.perRequest);
  const base = median(baselinePool);
  if (!base || base <= 0) return [];

  const findings = [];
  for (const x of stats) {
    if (x.subagent) continue; // 子代理天然高于基线，单列（A4）而不是在这里报
    if (x.output < minOutput) continue; // 绝对量下限
    if (x.perRequest <= base * ratio) continue;
    const worst = x.msgs.reduce((a, b) => ((b.output_tokens ?? 0) > (a.output_tokens ?? 0) ? b : a), x.msgs[0]);
    findings.push({
      id: 'C1',
      title: 'token 消耗过快',
      category: 'C',
      severity: SEVERITY.HIGH,
      scope: x.session.sessionId,
      summary:
        `本会话单位请求 output ${num(x.perRequest)}（共 ${num(x.output)} / ${x.requests} 次请求），` +
        `是主会话基线 ${num(base)} 的 ${(x.perRequest / base).toFixed(1)} 倍（阈值 ${ratio} 倍）`,
      evidence: [{ locator: worst.locator, note: `单次 output 最高的一条（${num(worst.output_tokens ?? 0)} token）` }],
      impact:
        `相对基线约多消耗 ${num(Math.round((x.perRequest - base) * x.requests))} output token；` +
        `注意：产出量大不必然是浪费，请结合 E1（死循环）/E5（冗余调用）/C2（上下文膨胀）判断`,
      confidence: 0.6,
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
      dangerPatterns: patterns,
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

/** 事件时间戳 → 毫秒（拿不到返回 null） */
function tsOf(ev) {
  const t = ev?.ts ? Date.parse(ev.ts) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * N3 权限审批摩擦 —— **第二轮评估 F1：从"不可实现"变成可实现**
 *
 * 旧版本的定性理由是"DSH 只有 approval/policy，没有 approval/asked / approval/decided"。
 * 实测这句话是错的：本机 23 次 asked + 23 次 decided 都在日志里，且 decided 通过
 * `id` 与 asked 关联。适配层已补上这两类事件（只记 id / 工具名 / 结论，
 * **不记 reason 正文**）。
 *
 * 现在能回答：审批多不多、卡在哪些工具上、等人批了多久、有没有被拒。
 */
function detectN3(ctx, opts) {
  const minAsks = opts.n3MinAsks ?? 5;
  const slowMs = opts.n3SlowDecisionMs ?? 60000;

  const asked = new Map(); // id → { ev, tool }
  const decided = new Map();
  for (const s of ctx.scan.sessions) {
    for (const e of s.events) {
      if (e.kind !== KIND.APPROVAL) continue;
      if (e.approval_phase === 'asked' && e.approval_id) asked.set(e.approval_id, { ev: e, tool: e.tool_name });
      if (e.approval_phase === 'decided' && e.approval_id) decided.set(e.approval_id, e);
    }
  }
  if (asked.size < minAsks) {
    return {
      findings: [],
      note: `窗口内审批请求 ${asked.size} 次（需 ${minAsks} 次）—— 低于阈值，不判定为摩擦`,
    };
  }

  const byTool = new Map();
  let denied = 0;
  let unknown = 0;
  const waits = [];
  let slowest = null;
  for (const [id, a] of asked) {
    byTool.set(a.tool, (byTool.get(a.tool) ?? 0) + 1);
    const d = decided.get(id);
    if (!d) {
      unknown += 1;
      continue;
    }
    const outcome = String(d.outcome ?? '');
    if (!/^allow/i.test(outcome)) denied += 1;
    const gap = tsOf(d) !== null && tsOf(a.ev) !== null ? tsOf(d) - tsOf(a.ev) : null;
    if (gap !== null && gap >= 0) {
      waits.push(gap);
      if (!slowest || gap > slowest.gap) slowest = { gap, ev: a.ev, tool: a.tool };
    }
  }
  const topTools = [...byTool.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
  const medWait = median(waits);
  const parts = [`审批请求 ${asked.size} 次`];
  if (topTools.length) parts.push(`集中在 ${topTools.map(([t, n]) => `${t}(${n})`).join('、')}`);
  if (medWait !== null) parts.push(`等待审批中位 ${(medWait / 1000).toFixed(1)} 秒`);
  if (denied) parts.push(`被拒 ${denied} 次`);
  if (unknown) parts.push(`无对应决定记录 ${unknown} 次`);

  const first = [...asked.values()][0].ev;
  const evidence = [{ locator: first.locator, note: `首次审批请求（${String(first.tool_name)}）` }];
  if (slowest) {
    evidence.push({
      locator: slowest.ev.locator,
      note: `等待最久的一次：${(slowest.gap / 1000).toFixed(1)} 秒（${String(slowest.tool)}）`,
    });
  }

  return [
    {
      id: 'N3',
      title: '权限审批摩擦',
      category: 'N',
      severity: medWait !== null && medWait > slowMs ? SEVERITY.MID : SEVERITY.LOW,
      scope: (ctx.scan.sessions.find((s) => s.events.includes(first)) ?? {}).sessionId ?? null,
      summary: parts.join('，'),
      evidence,
      impact: '反复审批会打断你的节奏；把常用且低风险的工具固化到权限预设可省掉这些往返',
      confidence: 0.8,
    },
  ];
}

/**
 * N4 API 重试频繁 —— **第二轮评估 F1：从"不可实现"变成可实现**
 *
 * 旧理由"DSH 会话日志中不存在 llm/retry 事件"实测是错的：
 * `llm/retry` 携带失败码、重试序号、退避时长。适配层已补上。
 */
function detectN4(ctx, opts) {
  const minRetries = opts.n4MinRetries ?? 3;

  const retries = [];
  for (const s of ctx.scan.sessions) {
    for (const e of s.events) {
      if (e.kind === KIND.RETRY) retries.push({ ev: e, session: s });
    }
  }
  if (retries.length < minRetries) {
    return {
      findings: [],
      note: `窗口内模型请求重试 ${retries.length} 次（需 ${minRetries} 次）—— 低于阈值，不判定为频繁`,
    };
  }

  const codes = new Map();
  let delaySum = 0;
  for (const r of retries) {
    codes.set(r.ev.failure_code ?? '(未标注)', (codes.get(r.ev.failure_code ?? '(未标注)') ?? 0) + 1);
    delaySum += r.ev.delay_ms ?? 0;
  }
  const codeText = [...codes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join('、');

  return [
    {
      id: 'N4',
      title: 'API 重试频繁',
      category: 'N',
      severity: retries.length >= minRetries * 2 ? SEVERITY.MID : SEVERITY.LOW,
      scope: retries[0].session.sessionId,
      summary: `发生 ${retries.length} 次模型请求重试，失败码：${codeText}，累计退避 ${(delaySum / 1000).toFixed(1)} 秒`,
      evidence: retries.slice(0, 5).map((r) => ({
        locator: r.ev.locator,
        note: `${r.ev.provider ?? '?'} ${r.ev.failure_code ?? ''} 第 ${r.ev.retry_index ?? '?'}/${r.ev.max_retries ?? '?'} 次重试`,
      })),
      impact: '每次重试都是一次新的提供方请求，可能重复计费并增加等待',
      confidence: 0.8,
    },
  ];
}

/**
 * E3 工具结果过大 —— **第二轮评估 F1：从"不可实现"变成可实现**
 *
 * 旧理由"tool/result 只归一化 is_error，不含 content 原文与长度"是**适配层的自我描述错误**：
 * 原始记录里 `data.message.content[].text` 就在手边（适配器算完长度把正文丢了）。
 * 现在适配层记录 `text_len`（**只有长度，没有正文**），本指标据此判定。
 */
function detectE3(ctx, opts) {
  const bigChars = opts.e3ResultChars ?? 8192;
  const minCount = opts.e3MinCount ?? 5;
  const maxFindings = opts.e3MaxFindings ?? 3; // 只列最严重的几个会话，避免刷屏
  const candidates = [];
  let sawSome = 0;
  let totalBig = 0;

  for (const s of ctx.scan.sessions) {
    // tool/result 只有 callId，需要用 tool/call 把工具名接回来
    const nameByCall = new Map();
    for (const e of s.events) {
      if (e.kind === KIND.TOOL_CALL && e.tool_call_id) nameByCall.set(e.tool_call_id, e.tool_name);
    }
    const results = s.events.filter((e) => e.kind === KIND.TOOL_RESULT);
    if (!results.length) continue;

    const big = results.filter((e) => (e.text_len ?? 0) > bigChars);
    if (big.length) sawSome += big.length;
    if (big.length < minCount) continue;

    const chars = big.reduce((n, e) => n + (e.text_len ?? 0), 0);
    totalBig += chars;
    const byTool = new Map();
    for (const e of big) {
      const t = nameByCall.get(e.tool_call_id) ?? '(未知工具)';
      const cur = byTool.get(t) ?? { n: 0, chars: 0 };
      cur.n += 1;
      cur.chars += e.text_len ?? 0;
      byTool.set(t, cur);
    }
    const topTools = [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 3);
    const largest = big.reduce((a, b) => ((b.text_len ?? 0) > (a.text_len ?? 0) ? b : a), big[0]);

    candidates.push({
      chars,
      finding: {
        id: 'E3',
        title: '工具结果过大',
        category: 'E',
        severity: big.length >= 10 ? SEVERITY.MID : SEVERITY.LOW,
        scope: s.sessionId,
        summary:
          `工具结果 ${results.length} 条中有 ${big.length} 条超过 ${num(bigChars)} 字符` +
          `（累计 ${num(chars)} 字符，最大一条 ${num(largest.text_len ?? 0)} 字符）` +
          (topTools.length ? `，主要来自 ${topTools.map(([t, v]) => `${t}(${v.n} 条)`).join('、')}` : ''),
        evidence: [{ locator: largest.locator, note: `最大一条工具结果（${num(largest.text_len ?? 0)} 字符）` }],
        impact:
          '超大工具结果会随历史反复重发并挤占上下文；用 compaction/prune 或落盘（spill）可省下这部分重复输入',
        confidence: 0.8,
      },
    });
  }

  // 只留最严重的几个会话：E3 的处方是**一个全局配置**，列 6 个会话只是刷屏
  const findings = candidates
    .sort((a, b) => b.chars - a.chars)
    .slice(0, maxFindings)
    .map((c) => c.finding);

  if (!findings.length) {
    return {
      findings,
      note:
        sawSome > 0
          ? `窗口内有 ${sawSome} 条超大工具结果，但没有任何会话达到 ${minCount} 条阈值（已按会话过滤噪音）`
          : `窗口内没有超过 ${num(bigChars)} 字符的工具结果`,
    };
  }
  if (candidates.length > findings.length) {
    findings[0] = {
      ...findings[0],
      impact:
        `${findings[0].impact}（同类会话共 ${candidates.length} 个、累计 ${num(totalBig)} 字符，` +
        `此处只列最大的 ${findings.length} 个）`,
    };
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A 类：资产
// ---------------------------------------------------------------------------

/**
 * A3 高频手动序列 —— **第二轮评估 F14 收窄**
 *
 * 旧版本是"相邻工具对直方图"：相邻两个不同工具重复 ≥5 次就报"可考虑固化为技能"。
 * 实测本机 18 条，其中一半是同一个对的镜像（grep→read 10 与 read→grep 9、
 * pwsh→read 与 read→pwsh），而"读文件后编辑、编辑后跑命令"本来就是正规工作流。
 *
 * 三处收窄：
 *   1. 去镜像：a→b 与 b→a 合成一次计数；
 *   2. 排除含通用工具的对：任一端是通用工具（读 / 写 / 编辑 / grep / 命令 / 委派）
 *      就不算"可固化套路"—— 任何任务都要走这些路，留下的是两端都很专门的序列；
 *   3. 跨会话合并：同一个对只报一条，并给出会话数。
 *
 * ⚠️ 另有一条老约束：必须是两个**不同**工具的相邻转换。
 *    早期版本允许 `web_fetch→web_fetch`，把"连续抓取 44 个 URL"报成 4 条 —— 那是
 *    单一工具的重复使用（已由 E5 覆盖），不是"序列"。
 */
const GENERIC_TOOLS = new Set([
  'read', 'write', 'edit', 'grep', 'glob', 'pwsh', 'bash', 'sh', 'shell',
  'todo_write', 'ask_user_question', 'compress', 'subagent', 'subagent_fork',
  'list_agents', 'send_message', 'job_output', 'job_list', 'job_kill',
]);

function detectA3(ctx, opts) {
  const minRepeat = opts.a3MinRepeat ?? 5;

  const pairs = new Map();
  for (const s of ctx.scan.sessions) {
    const calls = s.events.filter((e) => e.kind === KIND.TOOL_CALL);
    const names = calls.map((e) => e.tool_name);
    if (names.length < minRepeat * 2) continue;

    for (let i = 0; i + 1 < names.length; i++) {
      const a = names[i];
      const b = names[i + 1];
      if (!a || !b || a === b) continue; // 同一工具的连续使用不算"序列"
      // 任一端是通用工具就不算"可固化套路"：任何任务都要读文件、跑命令，
      // 「跑命令→搜网页」这种组合是任务形状，不是可复用的固定套路。
      if (GENERIC_TOOLS.has(a) || GENERIC_TOOLS.has(b)) continue;
      const key = [a, b].sort().join('\u0000');
      let rec = pairs.get(key);
      if (!rec) {
        rec = { from: a, to: b, count: 0, first: calls[i].locator, sessions: new Set() };
        pairs.set(key, rec);
      }
      rec.count += 1;
      rec.sessions.add(s.sessionId);
    }
  }

  const findings = [];
  for (const rec of pairs.values()) {
    if (rec.count < minRepeat) continue;
    findings.push({
      id: 'A3',
      title: '高频手动序列',
      category: 'A',
      severity: SEVERITY.LOW,
      scope: [...rec.sessions].join(','),
      summary:
        `工具序列「${rec.from}↔${rec.to}」出现 ${rec.count} 次（跨 ${rec.sessions.size} 个会话），` +
        `两端都不是通用读写/命令工具，可考虑固化`,
      evidence: [{ locator: rec.first, note: '该序列首次出现' }],
      impact: `约 ${rec.count} 次固定的两步操作，可合并为一次调用或固化为技能`,
      confidence: 0.6,
    });
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
  // ⚠️ 第二轮评估 F13：DSH 的 skill 触发**不是**同名工具调用。
  //    实测 22 个 distinct tool_name 里没有任何技能名，只有唯一的 `skill` 工具，
  //    参数形如 {"name":"agent-clinic"}。旧代码拿 tool_name 比技能目录名，
  //    于是 usedTools.has(name) 永不为真 → 窗口一到全部 skill 都被误报"闲置"。
  const usedSkills = new Set(
    ctx.scan.sessions.flatMap((s) =>
      s.events.filter((e) => e.kind === KIND.TOOL_CALL && e.skill_name).map((e) => e.skill_name),
    ),
  );
  // 证据：拿窗口内最早的一条事件作为"扫描范围"的复核锚点（旧版本这里是 []）
  const windowStart = ctx.scan.sessions
    .flatMap((s) => s.events)
    .filter((e) => e.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
  const windowNote = `扫描窗口 ${Math.floor(spanDays)} 天，起点 ${windowStart?.ts ?? '未知'}`;

  for (const name of skills) {
    if (usedSkills.has(name)) continue;
    findings.push({
      id: 'A2',
      title: 'skill 闲置',
      category: 'A',
      severity: SEVERITY.MID,
      scope: `窗口 ${Math.floor(spanDays)} 天`,
      summary: `已装 skill「${name}」在 ${Math.floor(spanDays)} 天窗口内 0 次触发`,
      evidence: windowStart
        ? [{ locator: windowStart.locator, note: `窗口起点（${windowNote}）` }]
        : [],
      impact: '卸载可省启动时间与维护成本',
      confidence: windowStart ? 0.7 : 0.5,
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
  {
    id: 'E3',
    title: '工具结果过大',
    category: 'E',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '单条 tool/result 文本超过 8192 字符（第二轮评估 F1：补记 text_len 后从"不可实现"变为可实现）',
    detect: detectE3,
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
  {
    id: 'N3',
    title: '权限审批摩擦',
    category: 'N',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '审批请求 >=5 次，并给出等待时长与被拒（第二轮评估 F1：补记 approval/asked + decided 后变为可实现）',
    detect: detectN3,
  },
  {
    id: 'N4',
    title: 'API 重试频繁',
    category: 'N',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '模型请求重试 >=3 次，并给出失败码与累计退避（第二轮评估 F1：补记 llm/retry 后变为可实现）',
    detect: detectN4,
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
    severity: SEVERITY.LOW,
    implemented: true,
    desc: '非通用工具的两步序列复现 >=5 次（去镜像、跨会话合并；第二轮评估 F14 收窄）',
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
  // --- 第二轮评估：以下三项原本被列在"不可实现"，实为适配层没抽，已实现并移入上方 REGISTRY ---
  //   E3（工具结果过大）：tool/result 补记 text_len（只记长度，不留正文）
  //   N3（权限审批摩擦）：补记 approval/asked + approval/decided（按 id 关联）
  //   N4（API 重试频繁）：补记 llm/retry（失败码 / 重试序号 / 退避时长）
  // I1/I2/I3（无用思考 / 反复澄清 / 不合偏好）：v4 已整体砍掉
];

/**
 * 尚未实现、且**原因需要如实说明**的指标。
 *
 * ⚠️ 第二轮评估 F1 更正了这里的定性口径：
 *    旧版写的是"数据源在 DSH 里不存在"（不可实现），但实测 E3/N3/N4 的数据都在日志里
 *    —— 那是适配层没抽（已修）。剩下 K1/K2 同样**不是数据源缺失**：
 *    user/message 的正文就在日志里，是适配层按隐私约束只记了长度。
 *    所以这里描述的是"要用什么方案才能做"，而不是"平台做不到"。
 */
export const UNIMPLEMENTABLE = [
  {
    id: 'K1',
    title: '跨会话失忆',
    reason:
      '适配层按隐私约束只记 user/message 的 text_len、不留正文（正文在日志里，但本工具不落盘）。' +
      '要做跨会话"你是不是又在问同一个问题"，需改为记录**规范化文本指纹**（hash，可复原性为零）—— 方案未定，未排期',
  },
  {
    id: 'K2',
    title: '已解决重新排查',
    reason: '同 K1：同样依赖用户文本指纹，未排期',
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
