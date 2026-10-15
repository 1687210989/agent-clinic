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
import path from 'node:path';
import { KIND } from '../adapters/base.mjs';
import { num, pct } from '../summary.mjs';
import { observationsFromScan, observationsFromStore, MIN_CHARS } from '../privacy/fingerprints.mjs';
import { readProfilePatch, mcpServersFromRows } from '../config/index.mjs';

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
 * C5 压缩可观测性 —— **第三轮（待优化报告 Phase 1）新增**
 *
 * 为什么它比 C1 更可信：C1 用"单位请求 output vs 基线"**推**浪费，
 * 而 DSH 自己把**实测释放量**写进了日志：
 *   compaction/summary → shadowedTokenCount（这次摘要替代了多少 token）
 *   compaction/prune   → shadowedTokenCount（这次剪枝释放了多少 token）
 * 两者都是白给的交叉验证信号，此前完全没采。
 *
 * 判定：单会话压缩次数 ≥ 3 次（说明上下文反复触顶），报告实测释放量、
 * prune 与 summary 的比例、摘要正文与释放量的比（压缩效率）。
 * 数据全是数字，**零隐私代价**。
 */
function detectC5(ctx, opts) {
  const minCompactions = opts.c5MinCompactions ?? 3;
  const findings = [];
  let totalFreed = 0;
  let totalCount = 0;

  for (const s of ctx.scan.sessions) {
    const comps = s.events.filter((e) => e.kind === KIND.COMPACTION);
    if (!comps.length) continue;
    const starts = comps.filter((e) => e.compaction_phase === 'start').length;
    const summaries = comps.filter((e) => e.compaction_phase === 'summary');
    const prunes = comps.filter((e) => e.compaction_phase === 'prune');
    // ⚠️ 待优化报告 §4.3：释放量必须**分开算**。
    //    旧版 freed = summary + prune，却拿只统计 summary 的 summaryChars 去除它 ——
    //    prune 多的会话里"回吐比例"会被系统性低估（分母被 prune 撑大了）。
    const freedBySummary = summaries.reduce((n, e) => n + (e.shadowed_token_count ?? 0), 0);
    const freedByPrune = prunes.reduce((n, e) => n + (e.shadowed_token_count ?? 0), 0);
    const freed = freedBySummary + freedByPrune;
    const summaryChars = summaries.reduce((n, e) => n + (e.summary_chars ?? 0), 0);
    const count = starts || summaries.length + prunes.length;
    totalFreed += freed;
    totalCount += count;
    if (count < minCompactions) continue;

    const first = summaries[0] ?? prunes[0] ?? comps[0];
    // 压缩效率：摘要正文换成 token（4 字符≈1 token）÷ **摘要自己**的释放量
    const summaryTokens = Math.round(summaryChars / 4);
    const ratio = freedBySummary > 0 ? summaryTokens / freedBySummary : 0;
    const parts = [
      `本会话压缩 ${count} 次（摘要 ${summaries.length} / 剪枝 ${prunes.length}）`,
      `**实测**释放 ${num(freed)} token（DSH 日志的 shadowedTokenCount，非估算）`,
    ];
    if (freedBySummary || freedByPrune) {
      parts.push(`其中摘要释放 ${num(freedBySummary)}、剪枝释放 ${num(freedByPrune)}`);
    }
    if (freedBySummary > 0) {
      parts.push(`摘要自身约 ${num(summaryTokens)} token，相对**摘要释放量**回吐 ${(ratio * 100).toFixed(0)}%`);
    }

    findings.push({
      id: 'C5',
      title: '压缩可观测性',
      category: 'C',
      severity: count >= minCompactions * 3 ? SEVERITY.MID : SEVERITY.LOW,
      scope: s.sessionId,
      summary: parts.join('，'),
      evidence: [
        { locator: first.locator, note: `首次压缩（实测释放 ${num(first.shadowed_token_count ?? 0)} token）` },
      ],
      impact:
        `反复触发压缩说明上下文一次又一次顶到上限（每次压缩还会让该点之后的 KV cache 失效）。` +
        `实测释放 ${num(freed)} token 是**DSH 自报的数字**，可以直接和 C1/C2 的估算互相验证`,
      confidence: 0.95, // 数字是日志里抄的，不是推断的
    });
  }

  if (!findings.length) {
    return {
      findings,
      note:
        totalCount > 0
          ? `窗口内共压缩 ${totalCount} 次，实测释放 ${num(totalFreed)} token —— 没有会话达到 ${minCompactions} 次阈值`
          : '窗口内没有 compaction 事件（本机尚未触发过自动压缩）',
    };
  }
  return findings;
}

/**
 * C6 工具面成本 —— **第三轮新增**
 *
 * `request/header` 里有**完整的工具 schema**（实测 27 个工具、约 29.8 KB），
 * 而它每个请求都要重发一次 —— 这块成本此前从未被计量。
 * 同时能回答："注册了但整个窗口 0 次调用"的工具有几个（白付的 schema）。
 *
 * 只记工具名（指令标识符，不是用户内容）与字节数。
 */
function detectC6(ctx, opts) {
  const minSchemaChars = opts.c6SchemaChars ?? 20000;
  const minDeadTools = opts.c6MinDeadTools ?? 5;

  const headers = [];
  for (const s of ctx.scan.sessions) {
    for (const e of s.events) if (e.kind === KIND.REQUEST_HEADER) headers.push({ ev: e, session: s });
  }
  if (!headers.length) {
    return { findings: [], note: '窗口内没有 request/header 事件，无法计量工具面成本' };
  }

  const registered = new Set();
  for (const h of headers) for (const n of h.ev.tool_names ?? []) registered.add(n);
  const used = new Set();
  for (const s of ctx.scan.sessions) {
    for (const e of s.events) if (e.kind === KIND.TOOL_CALL && e.tool_name) used.add(e.tool_name);
  }
  const dead = [...registered].filter((n) => !used.has(n)).sort();

  const bytes = headers.map((h) => h.ev.tool_schema_bytes ?? 0).sort((a, b) => a - b);
  const medianBytes = bytes[bytes.length >> 1] ?? 0;
  const maxBytes = bytes[bytes.length - 1] ?? 0;
  const findings = [];
  const anchor = headers[0].ev;

  if (medianBytes >= minSchemaChars) {
    // 4 字符≈1 token 是工具自己的口径（token-meter 的启发式），这里沿用并标注
    const perRequestTokens = Math.round(medianBytes / 4);
    findings.push({
      id: 'C6',
      title: '工具面成本',
      category: 'C',
      severity: perRequestTokens >= 6000 ? SEVERITY.MID : SEVERITY.LOW,
      scope: `窗口 ${headers.length} 个请求头`,
      summary:
        `工具 schema ${num(medianBytes)} 字符（约 ${num(perRequestTokens)} token，按 4 字符/token 估算）` +
        `随**每个**请求重发；窗口内注册工具 ${registered.size} 个`,
      evidence: [{ locator: anchor.locator, note: `request/header（${anchor.request_reason ?? '未知原因'}，${anchor.tool_count ?? '?'} 个工具）` }],
      impact:
        `按 4 字符/token 估算，这一项每个请求都要付约 ${num(perRequestTokens)} token 的固定输入成本；` +
        `与工具数量成正比 —— 少注册一个用不到的工具就少付一份`,
      confidence: 0.8,
    });
  }

  if (dead.length >= minDeadTools) {
    findings.push({
      id: 'C6',
      title: '工具面成本',
      category: 'C',
      severity: SEVERITY.LOW,
      scope: '本窗口未观察到调用的工具',
      // ⚠️ 待优化报告 §4.1：旧措辞"整个窗口内 0 次调用"会被读成"这工具没用/该卸"。
      //    但注册是**所有会话的并集**，而单个会话只用自己的预设 ——
      //    低频插件（如只在做某类任务时才用的工具）仅仅是因为窗口里没遇到那类任务。
      summary:
        `注册了 ${registered.size} 个工具，其中 ${dead.length} 个在**本窗口内未观察到调用**：${dead.join('、')}`,
      evidence: [{ locator: anchor.locator, note: '工具清单来自 request/header 的 tools 数组' }],
      impact:
        '这些工具的 schema 仍然每个请求都要重发。**注意：未被调用 ≠ 不需要** —— ' +
        '窗口内恰好没遇到需要它的任务，同样会出现在这张清单里；' +
        '请按自己的使用习惯判断，插件的价值不该由一次窗口统计决定。' +
        '内置工具（create_goal / workflow / read_image 等）是 DSH 自带的，不必处理。',
      confidence: 0.7, // 从 0.85 下调：这个判据本身带着"窗口没覆盖到"的不确定性
    });
  }

  if (!findings.length) {
    return {
      findings,
      note: `工具 schema 中位 ${num(medianBytes)} 字符（低于 ${num(minSchemaChars)} 阈值），注册 ${registered.size} 个工具、窗口内未调用 ${dead.length} 个（低于 ${minDeadTools} 阈值）`,
    };
  }
  return findings;
}

/**
 * C7 上下文注入量 —— **第三轮新增**
 *
 * `agent/inbox/spliced` 是上下文被拼接/替换的痕迹（DSH 往对话里塞东西）。
 * 塞进去的每一个字符都会随后的请求重复计费，所以它算成本。
 * 只记体积与目标，**不记插入内容**。
 */
function detectC7(ctx, opts) {
  const minSplices = opts.c7MinSplices ?? 20;
  const minChars = opts.c7MinChars ?? 100000;

  const splices = [];
  for (const s of ctx.scan.sessions) {
    for (const e of s.events) if (e.kind === KIND.INBOX_SPLICE) splices.push({ ev: e, session: s });
  }
  const chars = splices.reduce((n, x) => n + (x.ev.inserted_chars ?? 0), 0);
  if (splices.length < minSplices || chars < minChars) {
    return {
      findings: [],
      note:
        splices.length === 0
          ? '窗口内没有上下文注入事件'
          : `窗口内注入 ${splices.length} 次、共 ${num(chars)} 字符 —— 低于阈值（${minSplices} 次 / ${num(minChars)} 字符）`,
    };
  }

  const byTarget = new Map();
  for (const x of splices) {
    const k = x.ev.splice_target ?? '(未知)';
    byTarget.set(k, (byTarget.get(k) ?? 0) + 1);
  }
  const biggest = splices.reduce((a, b) => ((b.ev.inserted_chars ?? 0) > (a.ev.inserted_chars ?? 0) ? b : a), splices[0]);

  return [
    {
      id: 'C7',
      title: '上下文注入量',
      category: 'C',
      severity: chars >= minChars * 3 ? SEVERITY.MID : SEVERITY.LOW,
      scope: '窗口',
      summary:
        `上下文被注入 ${splices.length} 次、共 ${num(chars)} 字符` +
        `（约 ${num(Math.round(chars / 4))} token，按 4 字符/token 估算）；` +
        `目标分布：${[...byTarget].map(([k, n]) => `${k}(${n})`).join('、')}`,
      evidence: [{ locator: biggest.ev.locator, note: `单次注入最大（${num(biggest.ev.inserted_chars ?? 0)} 字符）` }],
      impact:
        '注入的内容会留在历史里，被后续每个请求重复计费；' +
        '把反复粘贴的长内容（约定、文档、术语表）落到项目文件、让 Agent 按需读取，可以省掉这部分',
      confidence: 0.7,
    },
  ];
}

/**
 * A5 辅助 LLM 开销 —— **第三轮新增**
 *
 * 联网检索（`web/*-llm-request`）与会话标题（`session/title-llm-request`）
 * 都是**独立的模型调用**，日志里没有 usage —— 但它们确实在花钱。
 * 这里用 次数 × max_tokens 给**上界**，并明确标注是上界而不是实测。
 */
function detectA5(ctx, opts) {
  const minRequests = opts.a5MinRequests ?? 20;

  const aux = [];
  for (const s of ctx.scan.sessions) {
    for (const e of s.events) if (e.kind === KIND.AUX_REQUEST) aux.push({ ev: e, session: s });
  }
  if (aux.length < minRequests) {
    return {
      findings: [],
      note:
        aux.length === 0
          ? '窗口内没有辅助 LLM 请求'
          : `窗口内辅助 LLM 请求 ${aux.length} 次（需 ${minRequests} 次）—— 低于阈值`,
    };
  }

  const bySource = new Map();
  let bound = 0;
  const models = new Set();
  for (const x of aux) {
    bySource.set(x.ev.aux_source, (bySource.get(x.ev.aux_source) ?? 0) + 1);
    bound += x.ev.aux_max_tokens ?? 0;
    if (x.ev.aux_model) models.add(x.ev.aux_model);
  }
  const top = [...bySource].sort((a, b) => b[1] - a[1]);

  return [
    {
      id: 'A5',
      title: '辅助 LLM 开销',
      category: 'A',
      severity: aux.length >= minRequests * 3 ? SEVERITY.MID : SEVERITY.LOW,
      scope: '窗口',
      summary:
        `主对话之外还有 ${aux.length} 次辅助模型调用：` +
        `${top.map(([k, n]) => `${k === 'web-search' ? '联网检索' : '会话标题'} ${n} 次`).join('、')}；` +
        `按各自的 maxTokens 上限估算，最多 ${num(bound)} token（模型：${[...models].join('、') || '未标注'}）`,
      evidence: aux.slice(0, 3).map((x) => ({
        locator: x.ev.locator,
        note: `${x.ev.aux_source} · ${x.ev.aux_model ?? '?'} · maxTokens ${num(x.ev.aux_max_tokens ?? 0)}`,
      })),
      impact:
        `**这些调用不计入报告的 token 概览**（DSH 没给它们记 usage），所以真实开销比概览数字更高。` +
        `${num(bound)} 是上界（每次都跑满 maxTokens 才会达到），实际通常远低于它 —— 但次数本身是可优化的：` +
        '先 grep 本地已有结论、少做重复联网检索',
      confidence: 0.9,
    },
  ];
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
 *   - 基线只取**主会话**（非子代理、有 assistant 用量、output > 0）的单位请求 output 中位数，
 *     且**排除被判定的那个会话自身**（评估 §5.1：自己不该当自己的对照）
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

  // 基线：主会话、有实际产出 —— **且排除被判定者自身**。
  //
  // 旧实现把被判会话自己也算进基线池（第三方评估 §5.1）：中位数对离群值稳健，
  // 所以多数情况下结论不变，但"自己当自己的对照"在口径上站不住 ——
  // 一个远超他人的会话会把基线抬高，从而**压低自己的倍率**，属于自我掩饰。
  // 现在逐会话排除自身后再取中位数。
  const poolEntries = stats.filter((x) => !x.subagent && x.output > 0);
  const baselineFor = (self) =>
    median(poolEntries.filter((x) => x !== self).map((x) => x.perRequest));
  const base = median(poolEntries.map((x) => x.perRequest));
  if (!poolEntries.length || !base || base <= 0) return [];

  const findings = [];
  for (const x of stats) {
    if (x.subagent) continue; // 子代理天然高于基线，单列（A4）而不是在这里报
    if (x.output < minOutput) continue; // 绝对量下限
    // 对照取"排除了本会话之后"的基线；剩余样本不足时退回全体基线（并在摘要里如实标注）
    const own = baselineFor(x);
    const useBase = own && own > 0 ? own : base;
    const selfExcluded = own && own > 0;
    if (x.perRequest <= useBase * ratio) continue;
    const worst = x.msgs.reduce((a, b) => ((b.output_tokens ?? 0) > (a.output_tokens ?? 0) ? b : a), x.msgs[0]);
    findings.push({
      id: 'C1',
      title: 'token 消耗过快',
      category: 'C',
      severity: SEVERITY.HIGH,
      scope: x.session.sessionId,
      summary:
        `本会话单位请求 output ${num(x.perRequest)}（共 ${num(x.output)} / ${x.requests} 次请求），` +
        `是主会话基线 ${num(useBase)} 的 ${(x.perRequest / useBase).toFixed(1)} 倍（阈值 ${ratio} 倍；` +
        `基线为${selfExcluded ? '排除本会话后的其余主会话' : '全体主会话（可对照样本不足）'}中位值）`,
      evidence: [{ locator: worst.locator, note: `单次 output 最高的一条（${num(worst.output_tokens ?? 0)} token）` }],
      impact:
        `相对基线约多消耗 ${num(Math.round((x.perRequest - useBase) * x.requests))} output token；` +
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
 * C3 长会话疲劳 —— **第三轮接线 compaction**
 *
 * 旧实现的注释写着"且无 compact"，代码却只数消息条数：实测有一个会话被报
 * "长会话疲劳"，而它**实际压缩过 19 次**（每次释放几万 token）。长期靠
 * `/compact` 续命的用户会被反复建议 `/compact` —— 而压缩早就在发生了。
 *
 * 现在：只数**最后一次压缩之后**还"活着"的消息（compaction 的 shadowedRange.end
 * 之后的部分），因为被压缩遮蔽的历史已经不再占用上下文。
 *   - 活消息 > 200 → 真的在疲劳（压缩没跟上）
 *   - 总消息 > 200 但活消息 ≤ 200 → 不报，并在 notDetected 里说明"压缩正在起作用"
 */
function detectC3(ctx, opts) {
  const limit = opts.c3MessageLimit ?? 200;
  const findings = [];
  let relieved = 0;

  for (const s of ctx.scan.sessions) {
    const msgs = s.events.filter((e) => e.kind === KIND.USER_MSG || e.kind === KIND.ASSISTANT_MSG);
    if (msgs.length <= limit) continue;

    // 压缩遮蔽到哪里为止（取所有 compaction 事件里最大的 shadowed_end）
    const comps = s.events.filter((e) => e.kind === KIND.COMPACTION);
    const shadowedUpTo = comps.reduce(
      (m, e) => (Number.isFinite(e.shadowed_end) ? Math.max(m, e.shadowed_end) : m),
      0,
    );
    const liveMsgs = msgs.filter((e) => (Number.isFinite(e.seq) ? e.seq > shadowedUpTo : true));
    const freed = comps.reduce((n, e) => n + (e.shadowed_token_count ?? 0), 0);

    if (shadowedUpTo > 0 && liveMsgs.length <= limit) {
      relieved += 1; // 压缩在起作用，不该报"疲劳"
      continue;
    }

    const ev = s.events.find((e) => e.kind === KIND.USER_MSG) ?? s.events[0];
    if (!ev) continue;
    const compNote =
      shadowedUpTo > 0
        ? `；已压缩 ${comps.filter((c) => c.compaction_phase === 'start').length} 次、实测释放 ${num(freed)} token，` +
          `但压缩后仍有 ${liveMsgs.length} 条未遮蔽消息`
        : '；会话内**没有发生任何压缩**';
    findings.push({
      id: 'C3',
      title: '长会话疲劳',
      category: 'C',
      severity: SEVERITY.MID,
      scope: s.sessionId,
      summary: `单会话共 ${msgs.length} 条消息，超过 ${limit} 条阈值${compNote}`,
      evidence: [{ locator: ev.locator, note: `会话共 ${msgs.length} 条消息（活消息 ${liveMsgs.length} 条）` }],
      impact: '长会话更容易跑偏、重复劳动，建议拆分任务或开新会话',
      confidence: 0.7,
    });
  }

  if (!findings.length) {
    return {
      findings,
      note:
        relieved > 0
          ? `${relieved} 个会话消息数超 ${limit} 条，但压缩在起作用（最后一次压缩之后再无 ${limit} 条以上的未遮蔽消息）—— 不判为疲劳`
          : null,
    };
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
  let unknownOutcome = 0;
  const waits = [];
  let slowest = null;
  for (const [id, a] of asked) {
    byTool.set(a.tool, (byTool.get(a.tool) ?? 0) + 1);
    const d = decided.get(id);
    if (!d) {
      unknown += 1;
      continue;
    }
    // outcome 判定：**显式匹配拒绝语义**，其余归"未知结果"，绝不猜。
    //
    // 旧实现是 `if (!/^allow/i.test(outcome)) denied += 1` —— 任何非 allow* 开头
    // 的结果（approved / accept / granted …）都被计成"被拒"。第三方实测拿
    // 5 个 approved 跑出"被拒 5 次"；若 DSH 某版本改用 approved 措辞，N3 的
    // 被拒字段会系统性全错，而用户会据此调整权限配置 —— 误导比不报更糟。
    const outcome = String(d.outcome ?? '').toLowerCase().trim();
    if (/^(deny|denied|reject|rejected|decline|declined|refus|forbid)/.test(outcome)) {
      denied += 1;
    } else if (!/^(allow|approv|accept|grant|ok|yes|permit)/.test(outcome)) {
      unknownOutcome += 1;
    }
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
  // 三类结果分开报：被拒 / 结果无法识别 / 无对应决定记录（彼此不混算）
  if (denied) parts.push(`被拒 ${denied} 次`);
  if (unknownOutcome) parts.push(`结果无法识别 ${unknownOutcome} 次`);
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
 *
 * 2026-10-15 决策 D5：通用工具清单不再纯硬编码，改为 **基础集 + 从会话数据自动学习**。
 *
 *   - **基础集**（`BASE_GENERIC_TOOLS`）硬编码、不可被学习移除 —— 它是保底判据，
 *     任何"从数据学出来"的东西都不许把 `read`/`pwsh` 这类工具重新变成候选。
 *   - **学习只做排除**，判据是**广度**：一个工具出现在 ≥ `a3GenericMinSessions`（默认 3）
 *     个不同会话里，就视为通用工具 —— 跨任务普遍出现的工具不可能是"某个任务的固定套路"。
 *   - **为什么不用"内置包白名单"**：会话数据里只有工具名，**没有工具→包的映射**
 *     （`request/header` 给的是 tool_names 与 schema 体积，不含包名），所以"排除
 *     `@deepseek-ai/*` 提供的工具"在这条数据源上无法判定。硬要按包名排除就只能靠猜，
 *     而本项目"宁可承认做不到，也不假装有数据"。广度判据是**可复核**的：它只看
 *     "这个工具出现在几个会话里"，任何人都能从报告里验证。
 *   - 学习结果**如实报出**：A3 命中时写进 summary，未命中时作为说明进 notDetected
 *     （`runDiagnostics` 会把 `{findings, note}` 的 note 放进"未检测到"的说明里）。
 *   - 可关掉/可追加：`opts.a3LearnGeneric = false` 关闭学习；`opts.a3GenericTools`
 *     追加排除名单（用户知道自己环境里哪些工具是通用的）。
 */
const BASE_GENERIC_TOOLS = new Set([
  'read', 'write', 'edit', 'grep', 'glob', 'pwsh', 'bash', 'sh', 'shell',
  'todo_write', 'ask_user_question', 'compress', 'subagent', 'subagent_fork',
  'list_agents', 'send_message', 'job_output', 'job_list', 'job_kill',
]);

/**
 * 从会话数据里学习"通用工具"（决策 D5）：在 ≥ minSessions 个不同会话里都出现过的工具。
 *
 * @param {{scan:{sessions:Array}}} ctx
 * @param {{a3GenericMinSessions?:number, a3LearnGeneric?:boolean}} [opts]
 * @returns {Set<string>}
 */
export function learnedGenericTools(ctx, opts = {}) {
  const out = new Set();
  if (opts.a3LearnGeneric === false) return out;
  const minSessions = opts.a3GenericMinSessions ?? 3;
  const byTool = new Map();
  for (const s of ctx?.scan?.sessions ?? []) {
    const seen = new Set();
    for (const e of s.events ?? []) {
      if (e.kind !== KIND.TOOL_CALL || !e.tool_name || seen.has(e.tool_name)) continue;
      seen.add(e.tool_name);
      byTool.set(e.tool_name, (byTool.get(e.tool_name) ?? 0) + 1);
    }
  }
  for (const [tool, sessions] of byTool) {
    if (sessions >= minSessions) out.add(tool);
  }
  return out;
}

function detectA3(ctx, opts) {
  const minRepeat = opts.a3MinRepeat ?? 5;
  const learned = learnedGenericTools(ctx, opts);
  const extra = new Set(opts.a3GenericTools ?? []);
  const isGeneric = (n) => BASE_GENERIC_TOOLS.has(n) || extra.has(n) || learned.has(n);
  const learnedList = [...learned].sort();
  const criteria =
    `判据：基础通用工具 ${BASE_GENERIC_TOOLS.size} 个` +
    ` + 本次自动学习 ${learnedList.length} 个` +
    (learnedList.length ? `（${learnedList.slice(0, 8).join('、')}${learnedList.length > 8 ? '…' : ''}）` : '') +
    (extra.size ? ` + 手工追加 ${extra.size} 个` : '');

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
      if (isGeneric(a) || isGeneric(b)) continue;
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
        `两端都不在通用工具清单里，可考虑固化（${criteria}）`,
      evidence: [{ locator: rec.first, note: '该序列首次出现' }],
      impact: `约 ${rec.count} 次固定的两步操作，可合并为一次调用或固化为技能`,
      confidence: 0.6,
    });
  }
  return { findings, note: criteria };
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

  // ⚠️ 第三轮（待优化报告 2.1）：这里原来用的是**事件时间跨度**
  //    （max(时间) - min(时间)），不是日历跨度。反例：用户 60 天前集中用了一次、
  //    昨天又用了一次 → 跨度 ≈60 天就过门槛，于是"这个 skill 闲置 60 天"，
  //    可中间 59 天他根本没用过 Agent，这不代表 skill 闲置。
  //    现在改成两个都算，并把"活跃天数"作为置信度参考：
  //      calendarDays = 今天 - 首次会话时间（这才是"观察窗口有多长"）
  //      activeDays   = 有事件的不同日历天数（这才是"实际用了多少天"）
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const times = ctx.scan.sessions
    .flatMap((s) => s.events)
    .map((e) => (e.ts ? Date.parse(e.ts) : NaN))
    .filter((t) => Number.isFinite(t));
  if (!times.length) {
    return { findings: [], note: '窗口内没有带时间戳的事件，无法判断资产闲置' };
  }
  const firstMs = Math.min(...times);
  const lastMs = Math.max(...times);
  const calendarDays = Math.max(0, (now - firstMs) / 86400000);
  const historyDays = (lastMs - firstMs) / 86400000;
  const activeDays = new Set(
    ctx.scan.sessions
      .flatMap((s) => s.events)
      .map((e) => (e.ts ? new Date(e.ts).toISOString().slice(0, 10) : null))
      .filter(Boolean),
  ).size;

  const findings = [];
  const dayWord = (d) => `${d.toFixed(1)} 天`;

  if (calendarDays < minDays) {
    // 报告 2.1 的第二个点：DSH 发布于 2026-08-13，新用户短期内永远够不到 30 天。
    // 如实说明"还差多久"，而不是让用户以为 A2 坏了。
    const needDays = Math.ceil(minDays - calendarDays);
    return {
      findings,
      note:
        `观察窗口只有 ${dayWord(calendarDays)}（自首次会话算起，需 ${minDays} 天）—— ` +
        `样本不足，无法判定资产闲置；这不是"已确认无异常"，再过约 ${needDays} 天本项才会开始生效`,
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
  const firstEv = ctx.scan.sessions
    .flatMap((s) => s.events)
    .filter((e) => e.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
  const windowNote =
    `观察窗口 ${dayWord(calendarDays)}（首次会话起算）· 活跃 ${activeDays} 天 · ` +
    `历史跨度 ${dayWord(historyDays)} · 起点 ${firstEv?.ts ?? '未知'}`;

  for (const name of skills) {
    if (usedSkills.has(name)) continue;
    findings.push({
      id: 'A2',
      title: 'skill 闲置',
      category: 'A',
      severity: SEVERITY.MID,
      // 活跃天数少 → 结论更弱，置信度如实下调
      scope: `窗口 ${Math.floor(calendarDays)} 天（活跃 ${activeDays} 天）`,
      summary: `已装 skill「${name}」在 ${Math.floor(calendarDays)} 天观察窗口内 0 次触发`,
      evidence: firstEv ? [{ locator: firstEv.locator, note: `窗口起点（${windowNote}）` }] : [],
      impact: '卸载可省启动时间与维护成本',
      confidence: activeDays >= 5 ? 0.7 : 0.5,
    });
  }
  if (findings.length === 0) {
    return { findings, note: `已装 skill 共 ${skills.length} 个，窗口内均有触发（${windowNote}）` };
  }
  return { findings };
}

/** 列出已安装的 skill 名（只读目录名，不读内容） */
function listInstalledSkills() {
  const out = [];
  // 目录来源可覆盖（`AGENT_CLINIC_SKILL_DIRS`，用平台路径分隔符分隔多个）。
  // 为什么需要它：本项的输入一半来自会话（窗口天数），一半来自**跑测机器上装了什么** ——
  // 于是自检与 CI 的结果取决于宿主机恰好装了哪个 skill（第三方评估 §4.2 正是这类病：
  // 断言针对作者本机校准，换个环境就挂）。CI / 合成语料用本变量给一个确定性的 skill 目录。
  const override = (process.env.AGENT_CLINIC_SKILL_DIRS ?? '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const roots = override.length
    ? override
    : (() => {
        const home = process.env.HOME || process.env.USERPROFILE;
        if (!home) return [];
        return ['.agents/skills', '.workbuddy/skills'].map((sub) => `${home}/${sub}`);
      })();
  for (const dir of roots) {
    try {
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
  // --- 第三轮（待优化报告 Phase 1）：把 DSH 自己记的实测值接进来 ---
  {
    id: 'C5',
    title: '压缩可观测性',
    category: 'C',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '单会话压缩 ≥3 次，报告 DSH 实测释放量（shadowedTokenCount，非估算）',
    detect: detectC5,
  },
  {
    id: 'C6',
    title: '工具面成本',
    category: 'C',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '工具 schema >20000 字符（每请求重发）+ 窗口内 0 调用的工具 ≥5 个',
    detect: detectC6,
  },
  {
    id: 'C7',
    title: '上下文注入量',
    category: 'C',
    severity: SEVERITY.LOW,
    implemented: true,
    desc: 'agent/inbox/spliced 注入 ≥20 次且 ≥100000 字符',
    detect: detectC7,
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
    desc: '非通用工具的两步序列复现 >=5 次（去镜像、跨会话合并；通用工具 = 基础集 + 从会话广度自动学习，见决策 D5）',
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
  {
    id: 'A5',
    title: '辅助 LLM 开销',
    category: 'A',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '窗口内辅助模型调用（联网检索 / 会话标题）≥20 次，给出 maxTokens 上界估算',
    detect: detectA5,
  },
  // --- 决策 D4（2026-10-15）：K1/K2 从"隐私取舍下方案未定"变为已实现 ---
  //   数据基础：用户文本的**加盐指纹**（正文不落盘），详见 src/privacy/fingerprints.mjs
  {
    id: 'K1',
    title: '跨会话失忆',
    category: 'K',
    severity: SEVERITY.MID,
    implemented: true,
    desc: '同一用户文本指纹出现在 ≥3 个不同会话（本地加盐指纹，正文不落盘）',
    detect: detectK1,
  },
  {
    id: 'K2',
    title: '已解决重新排查',
    category: 'K',
    severity: SEVERITY.LOW,
    implemented: true,
    desc: '同一指纹在 ≥2 个会话出现，且较晚的会话在其后有失败/重试（软信号，措辞"疑似"）',
    detect: detectK2,
  },
  // --- M2+ 预留 ---
  { id: 'A1', title: 'MCP 闲置', category: 'A', severity: SEVERITY.MID, implemented: true, desc: 'profile patch 里已配置 MCP 服务器，但观察窗口（≥30 天）内 0 次调用（工具名 mcp__<serverName>__*）', detect: detectA1 },
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
 *
 * 2026-10-15 决策 D4：K1/K2 已实现（列为项已移入 REGISTRY），本数组因此为空。
 * 保留这个导出是为了报告结构稳定（"尚未实现的维度"这一节会如实显示"没有"）。
 */
export const UNIMPLEMENTABLE = [];

/**
 * K1 跨会话失忆 / K2 已解决重新排查 —— **决策 D4（2026-10-15）实现**
 *
 * ⚠️ 这两项以前被列在"尚未实现"，原因写的是"隐私取舍"：适配层按隐私约束只记
 *    `user/message` 的 `text_len`、不留正文，所以做不了"你是不是又在问同一个问题"。
 *    用户拍板选了**较强的**一档：把**规范化文本指纹（加盐 sha256）写入本地快照**
 *    （`~/.agent-clinic/text-fingerprints.json`）。于是这两项从"方案未定"变成已实现，
 *    代价与边界都写在 src/privacy/fingerprints.mjs 里（正文不落盘、加盐、可清除、可关闭）。
 *
 * 判定口径（写在代码里，就是为了可复核）：
 *   K1：**同一指纹在 ≥3 个不同会话里出现**（默认阈值 3）。取 3 而不是 2 —— 两次
 *       提问同一件事可能是正常的追问，三次跨会话才是"没记住"。
 *   K2：同一指纹在 ≥2 个会话里出现，且**较晚那个会话**在该消息之后又出现了
 *       失败/重试信号（`tool/result` 且 `is_error`，或 `llm/retry`）。
 *       为什么用这个代理判据：日志里**没有**"这件事已解决"的显式信号，
 *       能观测到的最接近事实是"这个问题再次被提起，而且又走进了排查（失败/重试）"。
 *       因此 K2 措辞必须是"疑似"，严重度只给 LOW（约定 3）。
 *
 * 单样本不出结论（约定 4）：一个指纹只在一个会话里出现时，两个指标都不报。
 */

/** 把观测按指纹分组 */
function groupByHash(observations) {
  const byHash = new Map();
  for (const o of observations) {
    if (!o?.hash) continue;
    const list = byHash.get(o.hash) ?? [];
    list.push(o);
    byHash.set(o.hash, list);
  }
  return byHash;
}

const tsKey = (o) => String(o?.ts ?? '');

/** 每个会话里"失败/重试"信号出现的时间点 */
function failureTimesBySession(scan) {
  const map = new Map();
  for (const s of scan?.sessions ?? []) {
    const times = [];
    for (const e of s.events ?? []) {
      const failed =
        (e.kind === KIND.TOOL_RESULT && e.is_error) || e.kind === KIND.RETRY;
      if (failed) times.push(String(e.ts ?? ''));
    }
    map.set(s.sessionId, times);
  }
  return map;
}

/** K1/K2 共用的观测来源：优先用调用方给的（scan + 快照合并后），否则只从本次 scan 里取 */
function kObservations(ctx, opts) {
  if (Array.isArray(opts.fingerprintObservations)) return opts.fingerprintObservations;
  const { observations } = observationsFromScan(ctx.scan);
  if (opts.fingerprintStore) return [...observations, ...observationsFromStore(opts.fingerprintStore)];
  return observations;
}

/** 把"这次到底采到指纹没有"如实写进判据说明（不静默降级） */
function fingerprintNoteSuffix(opts) {
  const parts = [];
  if (opts.fingerprintUnavailable) parts.push(`本次未采集指纹：${opts.fingerprintUnavailable}`);
  if (opts.fingerprintMissing) {
    parts.push(`本次有 ${opts.fingerprintMissing} 条用户消息未参与指纹（过短或未采集）`);
  }
  return parts.length ? `；${parts.join('；')}` : '';
}

/**
 * A1 MCP 闲置 —— **配置驱动**指标（2026-10-15 实现）
 *
 * 为什么它长期"排期中"：判定需要两个输入 —— ①**配置了哪些 MCP 服务器**、
 * ②窗口内对它们的**调用次数**。本机此前 `~/.dsh` 下没有任何 MCP 配置，两个输入都拿不到，
 * 于是如实写成"没有可判定的数据源"，而不是拿合成数据自证。
 *
 * 2026-10-15：用户接入本地 filesystem MCP server（配置写进 profile patch），
 * 两个输入就都有了 —— A1 可以实现，并且**用真实配置验收**。
 *
 * 判定口径：
 *   - 服务器清单来自 profile patch 里 `name: '@deepseek-ai/dsh-mcp-client'`
 *     （或 `@deepseek-ai/dsh-mcp-resources`）且未被 disabled 的行，取 `config.serverName`；
 *   - 调用次数按 DSH 的**固定工具命名** `mcp__<serverName>__<rawName>` 统计
 *     （`dsh-mcp-client` README「工具命名与共存」：公开名是 (serverName, rawName) 的纯函数，
 *     重启 / HMR / 重连后保持稳定，所以按前缀统计不会漏也不会串台）；
 *   - 观察窗口与 A2 同口径：`今天 − 首次会话时间`（日历跨度）。不足 `a1MinDays`（默认 30 天）
 *     时**只报"窗口不够，还差 N 天"**，不下闲置结论；
 *   - 缺 `serverName` 的配置行单独报出来（配置本身有问题），不静默忽略。
 *
 * 证据用**配置文件的行号**（`<patch>#L<行>`）：这个指标的证据是"你配置了什么"，
 * 不是某条会话事件 —— 而 `show` 能展开任何文件（非 zstd 按明文读），所以照样可复核。
 */
function detectA1(ctx, opts) {
  const minDays = opts.a1MinDays ?? 30;
  const patch = opts.mcpPatch ?? readProfilePatch(opts.env ?? process.env);
  if (!patch.exists) {
    return {
      findings: [],
      note:
        `没有读到 profile patch（${patch.path ?? '未知路径'}）—— 无法判断 MCP 配置，本项不下结论。` +
        `（测试/CI 可用 AGENT_CLINIC_PROFILE_PATCH 指定一份 patch）`,
    };
  }
  const servers = mcpServersFromRows(patch.rows, { patchPath: patch.path });
  if (servers.length === 0) {
    return {
      findings: [],
      note: `已读 profile patch（${patch.path}），其中没有 MCP 服务器配置行（@deepseek-ai/dsh-mcp-client / -resources）`,
    };
  }

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const times = (ctx.scan?.sessions ?? [])
    .flatMap((s) => s.events ?? [])
    .map((e) => (e.ts ? Date.parse(e.ts) : NaN))
    .filter((t) => Number.isFinite(t));
  if (!times.length) {
    return { findings: [], note: '窗口内没有带时间戳的事件，无法判断 MCP 是否闲置' };
  }
  const calendarDays = Math.max(0, (now - Math.min(...times)) / 86400000);
  if (calendarDays < minDays) {
    const need = Math.ceil(minDays - calendarDays);
    return {
      findings: [],
      note:
        `观察窗口只有 ${calendarDays.toFixed(1)} 天（自首次会话算起，需 ${minDays} 天）—— ` +
        `样本不足，无法判定 MCP 闲置；再过约 ${need} 天本项才会开始生效`,
    };
  }

  // 调用计数：mcp__<serverName>__*
  const calls = new Map(servers.filter((s) => s.serverName).map((s) => [s.serverName, 0]));
  for (const s of ctx.scan?.sessions ?? []) {
    for (const e of s.events ?? []) {
      if (e.kind !== KIND.TOOL_CALL || typeof e.tool_name !== 'string') continue;
      const m = /^mcp__(.+?)__/.exec(e.tool_name);
      if (!m || !calls.has(m[1])) continue;
      calls.set(m[1], calls.get(m[1]) + 1);
    }
  }

  const findings = [];
  for (const s of servers) {
    if (!s.serverName) continue;
    if ((calls.get(s.serverName) ?? 0) > 0) continue;
    findings.push({
      id: 'A1',
      title: 'MCP 闲置',
      category: 'A',
      severity: SEVERITY.MID,
      scope: s.serverName,
      summary:
        `MCP 服务器「${s.serverName}」已配置（${s.transport ?? '未知传输'}），` +
        `但在 ${calendarDays.toFixed(0)} 天观察窗口内 **0 次调用** —— 它的工具每次请求都随工具面重发`,
      evidence: s.locator
        ? [{ locator: s.locator, note: `配置行：${s.rowId}（serverName=${s.serverName}）` }]
        : [],
      impact: '闲置的 MCP 服务器不产生价值，只增加工具面与维护成本（工具 schema 每随请求重发）',
      confidence: 0.8,
    });
  }

  const misconfigured = servers.filter((s) => !s.serverName);
  const notes = [
    `观察窗口 ${calendarDays.toFixed(0)} 天 · 已配置 ${servers.length} 个 MCP 服务器：` +
      servers
        .map((s) => `${s.serverName ?? '(缺 serverName)'}=${calls.get(s.serverName) ?? 0} 次`)
        .join('、'),
  ];
  if (misconfigured.length) {
    notes.push(
      `⚠ ${misconfigured.length} 行 MCP 配置缺少 serverName（配置本身有问题）：${misconfigured.map((s) => s.rowId).join('、')}`,
    );
  }
  if (patch.overridden) notes.push('（配置路径由 AGENT_CLINIC_PROFILE_PATCH 指定）');
  return { findings, note: notes.join('；') };
}

function detectK1(ctx, opts) {
  const minSessions = opts.k1MinSessions ?? 3;
  const observations = kObservations(ctx, opts);
  const byHash = groupByHash(observations);
  const findings = [];
  let multiSession = 0;

  for (const [hash, list] of byHash) {
    const sessions = [...new Set(list.map((o) => o.session).filter(Boolean))];
    if (sessions.length < 2) continue;
    multiSession += 1;
    if (sessions.length < minSessions) continue;
    const chars = list.reduce((m, o) => Math.max(m, o.chars ?? 0), 0);
    const sorted = list.slice().sort((a, b) => tsKey(a).localeCompare(tsKey(b)));
    findings.push({
      id: 'K1',
      title: '跨会话失忆',
      category: 'K',
      severity: SEVERITY.MID,
      scope: sessions.join(','),
      summary:
        `同一段用户文本（指纹 ${hash.slice(0, 8)}…，约 ${num(chars)} 字符）在 ${sessions.length} 个会话里出现 ` +
        `—— 疑似同一个问题被反复提出（跨会话没有记住）`,
      evidence: sorted
        .slice(0, 3)
        .map((o) => ({ locator: o.locator, note: `${o.session} · ${o.ts ?? '无时间'}` })),
      impact: `同一个问题被解释了 ${sessions.length} 遍，上下文成本按会话数翻倍`,
      confidence: 0.6,
    });
  }

  const criteria =
    `判据：同一指纹出现在 ≥${minSessions} 个不同会话（本次有 ${multiSession} 个指纹跨了 2 个以上会话）` +
    `；文本短于 ${MIN_CHARS} 字符不生成指纹` +
    fingerprintNoteSuffix(opts);
  return { findings, note: criteria };
}

function detectK2(ctx, opts) {
  const minSessions = opts.k2MinSessions ?? 2;
  const observations = kObservations(ctx, opts);
  const byHash = groupByHash(observations);
  const failures = failureTimesBySession(ctx.scan);
  const findings = [];

  for (const [hash, list] of byHash) {
    const sessions = [...new Set(list.map((o) => o.session).filter(Boolean))];
    if (sessions.length < minSessions) continue;
    // 每个会话最早一次出现（用它判断"先解决过、后来又提"的时间关系）
    const firstBySession = new Map();
    for (const o of list) {
      if (!o.session) continue;
      const prev = firstBySession.get(o.session);
      if (!prev || tsKey(o) < tsKey(prev)) firstBySession.set(o.session, o);
    }
    const ordered = [...firstBySession.values()].sort((a, b) => tsKey(a).localeCompare(tsKey(b)));
    const earliest = ordered[0];
    // 时间不可比时不出结论（约定 4：宁可不出，也不猜）
    if (!earliest || !tsKey(earliest)) continue;
    // ⚠️ 必须检查**最早一次之后的每一个会话**，而不是只看最后一个：
    // 三次提问时，失败/重试可能发生在中间那次（只看最后一次会把这种情况漏掉）。
    const laterFailed = ordered
      .slice(1)
      .filter((o) => tsKey(o) && tsKey(o) > tsKey(earliest))
      .filter((o) => (failures.get(o.session) ?? []).some((t) => t >= tsKey(o)));
    if (laterFailed.length === 0) continue;
    const later = laterFailed[0];
    // 收紧一步：**最早那次出现之后不能就有失败** —— 否则这条更可能是"一直在排查"
    // （E2/N4 已经在报），而不是"当时看着解决了、后来又翻出来"。
    // 实测未收紧时合成语料里 K2 一次报 8 条（同一段文本在很多会话里都出现），
    // 收紧后降到 1 条量级；仍是软信号，故只给 LOW + "疑似"。
    const earlierFailed = (failures.get(earliest.session) ?? []).some((t) => t >= tsKey(earliest));
    if (earlierFailed) continue;

    const chars = list.reduce((m, o) => Math.max(m, o.chars ?? 0), 0);
    findings.push({
      id: 'K2',
      title: '已解决重新排查',
      category: 'K',
      severity: SEVERITY.LOW, // 软信号（约定 3）：只给低，且措辞"疑似"
      scope: `${earliest.session},${later.session}`,
      summary:
        `疑似"已经解决过的事又排查了一遍"：同一段用户文本（指纹 ${hash.slice(0, 8)}…，约 ${num(chars)} 字符）` +
        `先出现在 ${earliest.ts?.slice(0, 10) ?? '较早'}，之后在 ${later.ts?.slice(0, 10) ?? '较晚'} 再次出现，` +
        `且后一次之后有失败/重试信号`,
      evidence: [
        { locator: earliest.locator, note: `较早提出（${earliest.session}）` },
        { locator: later.locator, note: `再次提出（${later.session}），其后出现失败/重试` },
      ],
      impact: '同一问题被重新排查一遍：重复的定位与试错成本',
      confidence: 0.4,
    });
  }

  const criteria =
    `判据：同一指纹在 ≥${minSessions} 个会话出现，且较晚的会话在该消息之后有失败/重试信号` +
    `（日志里没有"已解决"的显式信号，故这是代理判据，措辞必须保留"疑似"）` +
    fingerprintNoteSuffix(opts);
  return { findings, note: criteria };
}

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
