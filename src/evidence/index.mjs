/**
 * L3 证据层 —— agent-clinic 的护城河
 *
 * 所有竞品都只给统计数字；本层给的是**可复核**的证据：
 *   - 精确定位：<file>#L<start>-L<end>
 *   - 可展开：readRange() 重新解码并打印该区间
 *   - 可复现：与 scan 共用同一套切帧逻辑，行号严格一致
 *
 * 【当前状态：骨架】readRange 已实现并可用；buildEvidencePackage 待 M1 Step 4。
 */

import fs from 'node:fs';

import { decodeFrames } from '../adapters/zstd-frames.mjs';
import { parseLocator, makeLocator } from '../adapters/base.mjs';

/**
 * 读取某个会话文件的指定行**区间**（重新解码，与 scan 逻辑完全一致）。
 *
 * 第三轮（待优化报告 Phase 2 第 5 项）：以前只接受单个行号，`#L1733-L2688`
 * 这种带区间的定位符会被**静默忽略终点** —— 报告里 955 行跨度的结论
 * （例如"同一个 read 调了 3 次"的第 1 与第 3 次）根本打不开。
 *
 * @param {string} file         会话文件绝对路径
 * @param {number} line         起始行号（1-based，解码后全局行号）
 * @param {number} [context=2]  区间两端各多取几行
 * @param {number} [endLine]    结束行号；省略或等于 line 时退化为单行 ± context
 */
export function readRange(file, line, context = 2, endLine = undefined) {
  const buf = fs.readFileSync(file);
  const { text, frames, badFrames, plain } = decodeFrames(buf);
  const all = text.split('\n');
  // 与 adapters/dsh.mjs 保持一致：去掉尾部空串，保证行号严格对齐
  if (all.length && all[all.length - 1] === '') all.pop();

  const end = Number.isInteger(endLine) && endLine > line ? endLine : line;
  for (const n of [line, end]) {
    if (n < 1 || n > all.length) {
      const err = new Error(`行号 ${n} 超出范围（该文件共 ${all.length} 行）`);
      err.code = 'LINE_OUT_OF_RANGE';
      throw err;
    }
  }

  const from = Math.max(1, line - context);
  // 区间跨度大时行数会爆掉：上限 200 行，超出则截断中点并如实告知
  const MAX_LINES = 200;
  const wanted = end + context - from + 1;
  const truncated = wanted > MAX_LINES;
  const to = truncated ? Math.min(all.length, from + MAX_LINES - 1) : Math.min(all.length, end + context);

  const lines = [];
  for (let n = from; n <= to; n++) {
    lines.push({ no: n, text: all[n - 1] ?? '', isTarget: n >= line && n <= end });
  }

  return {
    file,
    from,
    to,
    totalLines: all.length,
    frames,
    badFrames,
    plain,
    lines,
    rangeStart: line,
    rangeEnd: end,
    truncated,
  };
}

/** 解析 "<file>#L<line>" 或 "<file>#L<start>-L<end>" 形式的定位符 */
export function parseRange(locator) {
  const s = String(locator);
  const m = /^(.*?)#L(\d+)(?:-L(\d+))?$/.exec(s);
  if (!m) return null;
  const file = m[1];
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (!file || !Number.isInteger(start) || start < 1) return null;
  return { file, start, end: Math.max(start, end) };
}

/** 把一段定位符渲染成可读的证据块（默认脱敏：超长行截断） */
export function renderEvidence(locator, { context = 2, maxLen = 400 } = {}) {
  const range = parseRange(locator);
  if (!range) throw new Error(`无法解析定位符：${locator}`);

  // 带上区间终点：旧版本只读 range.start，955 行跨度的证据只能看到开头 5 行
  const r = readRange(range.file, range.start, context, range.end);
  const out = [];
  out.push(`证据位置：${locator}`);
  out.push(
    `文件共 ${r.totalLines} 行 · zstd 帧 ${r.frames}（坏帧 ${r.badFrames}）` +
      (range.end > range.start
        ? ` · 目标区间 #L${range.start}-L${range.end}（${range.end - range.start + 1} 行）`
        : ''),
  );
  if (r.truncated) {
    out.push(
      `⚠ 区间过长，这里只展开 #L${r.from}-L${r.to}（共 ${r.totalLines} 行中的一段）—— ` +
        `需要看别处请用 offset/limit 分段复核`,
    );
  }
  out.push('');
  for (const l of r.lines) {
    const mark = l.isTarget ? '>' : ' ';
    const body = l.text.length > maxLen ? `${l.text.slice(0, maxLen)} …(+${l.text.length - maxLen})` : l.text;
    out.push(`${mark} ${String(l.no).padStart(5)} | ${body}`);
  }
  return out.join('\n');
}


export { makeLocator, parseLocator };
