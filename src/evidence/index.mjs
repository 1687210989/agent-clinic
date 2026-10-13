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
 * 读取某个会话文件的指定行区间（重新解码，与 scan 逻辑完全一致）。
 *
 * @param {string} file        会话文件绝对路径
 * @param {number} line        目标行号（1-based，解码后全局行号）
 * @param {number} [context=2] 上下各取几行
 * @returns {{file:string, from:number, to:number, totalLines:number, lines:Array<{no:number, text:string, isTarget:boolean}>}}
 */
export function readRange(file, line, context = 2) {
  const buf = fs.readFileSync(file);
  const { text, frames, badFrames, plain } = decodeFrames(buf);
  const all = text.split('\n');
  // 与 adapters/dsh.mjs 保持一致：去掉尾部空串，保证行号严格对齐
  if (all.length && all[all.length - 1] === '') all.pop();

  if (line < 1 || line > all.length) {
    const err = new Error(`行号 ${line} 超出范围（该文件共 ${all.length} 行）`);
    err.code = 'LINE_OUT_OF_RANGE';
    throw err;
  }

  const from = Math.max(1, line - context);
  const to = Math.min(all.length, line + context);
  const lines = [];
  for (let n = from; n <= to; n++) {
    lines.push({ no: n, text: all[n - 1] ?? '', isTarget: n === line });
  }

  return { file, from, to, totalLines: all.length, frames, badFrames, plain, lines };
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

  const r = readRange(range.file, range.start, context);
  const out = [];
  out.push(`证据位置：${locator}`);
  out.push(`文件共 ${r.totalLines} 行 · zstd 帧 ${r.frames}（坏帧 ${r.badFrames}）`);
  out.push('');
  for (const l of r.lines) {
    const mark = l.isTarget ? '>' : ' ';
    const body = l.text.length > maxLen ? `${l.text.slice(0, maxLen)} …(+${l.text.length - maxLen})` : l.text;
    out.push(`${mark} ${String(l.no).padStart(5)} | ${body}`);
  }
  return out.join('\n');
}

/**
 * 为一个 Finding 生成完整证据包。
 * 【M1 Step 4 待实现】需要：区间合并、脱敏、可点击链接渲染。
 */
export function buildEvidencePackage(_finding) {
  return { status: 'not_implemented', note: 'M1 Step 4 待实现' };
}

export { makeLocator, parseLocator };
