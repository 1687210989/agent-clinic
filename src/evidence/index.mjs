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
 * 2026-10-15 决策 D8：区间过长时不再只是"截断 + 让你自己猜怎么继续"，
 * 而是支持**显式分页**（`opts.offset` / `opts.limit`），并由 renderEvidence
 * 在截断提示里直接给出下一条可执行的复核命令。
 *
 * @param {string} file         会话文件绝对路径
 * @param {number} line         起始行号（1-based，解码后全局行号）
 * @param {number} [context=2]  区间两端各多取几行
 * @param {number} [endLine]    结束行号；省略或等于 line 时退化为单行 ± context
 * @param {{offset?:number, limit?:number}} [opts]
 *        offset：从本次请求窗口起点（`line - context`）再向后跳过的行数，用于翻页
 *        limit ：本次最多展开多少行（默认 200，上限仍然是"不刷屏"的默认值，仅当显式传入时生效）
 */
export function readRange(file, line, context = 2, endLine = undefined, opts = {}) {
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

  const winStart = Math.max(1, line - context); // 本次请求窗口起点（未翻页时）
  const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
  const pageFrom = Math.min(all.length, winStart + offset);
  // 区间跨度大时行数会爆掉：默认上限 200 行（可用 limit 显式调整）
  const MAX_LINES = Math.max(1, Math.trunc(Number(opts.limit) || 0) || 200);
  const wanted = end + context - pageFrom + 1;
  const truncated = wanted > MAX_LINES;
  const to = truncated ? Math.min(all.length, pageFrom + MAX_LINES - 1) : Math.min(all.length, end + context);
  const from = pageFrom;

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
    offset,
    limit: MAX_LINES,
    // 还有多少行没展开（截断后用来说明"下一页从哪开始"）
    remaining: truncated ? Math.max(0, end + context - to) : 0,
  };
}

/**
 * 解析 "<file>#L<line>" 或 "<file>#L<start>-L<end>" 形式的定位符。
 *
 * 2026-10-15 决策 D7：这里**不再有第二份解析实现** —— 统一转发给
 * `src/adapters/base.mjs` 的 `parseLocator`（唯一实现，支持区间）。
 * 保留本导出是为了不改动既有调用方（CLI / 插件 / 自检）。
 */
export function parseRange(locator) {
  return parseLocator(locator);
}

/** 把一段定位符渲染成可读的证据块（默认脱敏：超长行截断） */
export function renderEvidence(locator, { context = 2, maxLen = 400, offset = 0, limit = undefined } = {}) {
  const range = parseRange(locator);
  if (!range) throw new Error(`无法解析定位符：${locator}`);

  // 带上区间终点：旧版本只读 range.start，955 行跨度的证据只能看到开头 5 行
  const r = readRange(range.file, range.start, context, range.end, { offset, limit });
  const out = [];
  out.push(`证据位置：${locator}`);
  out.push(
    `文件共 ${r.totalLines} 行 · zstd 帧 ${r.frames}（坏帧 ${r.badFrames}）` +
      (range.end > range.start
        ? ` · 目标区间 #L${range.start}-L${range.end}（${range.end - range.start + 1} 行）`
        : ''),
  );
  // 翻页时先说清"本页是从哪里开始的"：这条以前挂在 truncation 的 else 分支里，
  // 于是"区间很长 + 正在翻页"（恰好是最常见的组合）时反而看不到 —— 现在独立输出。
  if (r.offset > 0) {
    out.push(`（已跳过前 ${r.offset} 行，本页 #L${r.from}-L${r.to}）`);
  }
  if (r.truncated) {
    // 决策 D8：截断不只是"告知"，而是给出**可直接复制的下一条命令** ——
    // 旧提示写的是"请用 offset/limit 分段复核"，但从没告诉用户具体该填什么。
    const nextOffset = r.to - Math.max(1, range.start - context) + 1;
    out.push(
      `⚠ 本次只展开 #L${r.from}-L${r.to}（共 ${r.totalLines} 行中的一段，每页 ${r.limit} 行），` +
        `还剩 ${r.remaining} 行未展开。继续看下一页：`,
    );
    out.push(`    agent-clinic show "${locator}" --offset ${nextOffset} --limit ${r.limit}`);
    out.push(`  （也可一次多给些：--limit ${Math.min(r.limit + r.remaining, 5000)}）`);
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
