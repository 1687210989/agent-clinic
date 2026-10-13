/**
 * 会话聚合统计（L1 信号层的运行时通道）
 *
 * 只做统计，不做判定 —— 判定属于 diagnostics/。
 */

import path from 'node:path';

import { KIND } from './adapters/base.mjs';

/** 把 scanSessions 的结果汇总成全局 + 逐会话统计 */
export function summarize(scanResult) {
  const sessions = scanResult.sessions ?? [];

  const g = {
    sessions: sessions.length,
    frames: 0,
    lines: 0,
    badFrames: 0,
    badLines: 0,
    unmapped: 0,
    assistantMsgs: 0,
    userMsgs: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    byTool: {},
  };

  const perSession = [];

  for (const s of sessions) {
    const cwd = s.meta?.cwd;
    const ps = {
      sessionId: s.sessionId,
      project: typeof cwd === 'string' && cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) || cwd : '(unknown)',
      file: s.file,
      version: s.version,
      frames: s.frames,
      lines: s.totalLines,
      toolCalls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      title: s.title ?? null,
      depth: s.meta?.delegationDepth ?? null,
      origin: s.meta?.origin ?? null,
    };

    for (const e of s.events) {
      switch (e.kind) {
        case KIND.USER_MSG:
          g.userMsgs += 1;
          break;
        case KIND.ASSISTANT_MSG:
          g.assistantMsgs += 1;
          break;
        case KIND.TOOL_CALL:
          g.toolCalls += 1;
          ps.toolCalls += 1;
          g.byTool[e.tool_name] = (g.byTool[e.tool_name] ?? 0) + 1;
          break;
        case KIND.TOOL_RESULT:
          g.toolResults += 1;
          if (e.is_error) {
            g.errors += 1;
            ps.errors += 1;
          }
          break;
        default:
          break;
      }

      g.inputTokens += e.input_tokens ?? 0;
      g.outputTokens += e.output_tokens ?? 0;
      g.cacheReadTokens += e.cache_read_tokens ?? 0;
      g.cacheWriteTokens += e.cache_write_tokens ?? 0;
      ps.inputTokens += e.input_tokens ?? 0;
      ps.outputTokens += e.output_tokens ?? 0;
      ps.cacheReadTokens += e.cache_read_tokens ?? 0;
    }

    g.frames += s.frames;
    g.lines += s.totalLines;
    g.badFrames += s.badFrames;
    g.badLines += s.badLines;
    g.unmapped += s.unmapped;

    perSession.push(ps);
  }

  g.errorRate = g.toolCalls > 0 ? g.errors / g.toolCalls : 0;
  const totalIn = g.inputTokens + g.cacheReadTokens;
  g.cacheReadShare = totalIn > 0 ? g.cacheReadTokens / totalIn : 0;

  return { global: g, perSession };
}

/** 工具调用频次 Top N */
export function topTools(global, n = 8) {
  return Object.entries(global.byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/** 千分位 */
export function num(v) {
  return Number(v ?? 0).toLocaleString('en-US');
}

/** 百分比 */
export function pct(v, digits = 1) {
  return `${(Number(v ?? 0) * 100).toFixed(digits)}%`;
}
