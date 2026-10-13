/**
 * DeepSeek Harness (DSH) 适配器
 *
 * 已在本机 4 个真实会话（463 帧 / 994 行）上验证。
 *
 * 数据格式要点（详见 docs/data-formats.md）：
 *   - 文件：<DSH_HOME>/sessions/<workspace-slug>/<session-id>/session.vN.jsonl.zstd
 *   - 磁盘上是多帧 zstd 拼接 → 必须走 zstd-frames.mjs
 *   - 第 1 行是 header，字段在**顶层**（不是 .data）
 *   - 之后每行是事件 {type, seq, time, data}，字段在 .data
 *   - usage 是 camelCase：inputTokens / outputTokens / cacheReadTokens ...
 *   - tool/call 的 arguments 是 **JSON 字符串**，需先 parse 再哈希
 *   - tool/result 失败有双信号：data.error 或 data.message.isError
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { decodeFrames } from './zstd-frames.mjs';
import { KIND, PLATFORM, makeLocator, makeEvent, stableStringify } from './base.mjs';

/** 会话文件名匹配：session.v4.jsonl.zstd / session.v1.jsonl */
const SESSION_FILE_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;

/** 解析 DSH_HOME：显式参数 > 环境变量 > ~/.dsh */
export function resolveDshHome(explicit) {
  return explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 会话根目录 */
export function resolveSessionsRoot(opts = {}) {
  return path.join(resolveDshHome(opts.dshHome), 'sessions');
}

/** 递归找出所有会话文件，按路径排序（保证输出稳定可复现） */
export function findSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不可读：跳过，由上层报告
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SESSION_FILE_RE.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** 会话文件版本（v4 / v3 …），未知返回 null */
export function sessionVersion(file) {
  const m = SESSION_FILE_RE.exec(path.basename(file));
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function hashArgs(args) {
  let normalized;
  if (typeof args === 'string') {
    try {
      normalized = stableStringify(JSON.parse(args)); // arguments 是 JSON 字符串
    } catch {
      normalized = args; // 不是 JSON 就按原串处理
    }
  } else {
    normalized = stableStringify(args ?? null);
  }
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

function isErrorResult(data) {
  if (data?.error) return true; // { name:"AbortError", code:"ABORTED" }
  if (data?.message?.isError === true) return true; // 第二重信号
  return false;
}

function usageOf(data) {
  const u = data?.usage;
  if (!u) return {};
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    cache_read_tokens: u.cacheReadTokens ?? 0,
    cache_write_tokens: u.cacheWriteTokens ?? 0,
    total_tokens: u.totalTokens ?? 0,
  };
}

/** 累加 content 块中指定类型的文本长度 */
function sumTextLen(blocks, type) {
  if (!Array.isArray(blocks)) return 0;
  let n = 0;
  for (const b of blocks) {
    if (b && b.type === type && typeof b.text === 'string') n += b.text.length;
  }
  return n;
}

function projectOf(meta) {
  const cwd = meta?.cwd;
  if (typeof cwd === 'string' && cwd.trim()) {
    return path.basename(cwd.replace(/[\\/]+$/, '')) || cwd;
  }
  return '(unknown)';
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析单个会话文件 → 统一事件模型
 *
 * 只读、容错：坏帧 / 坏行跳过并计数，绝不中断。
 *
 * @param {string} file 会话文件绝对路径
 */
export function parseSession(file) {
  const buf = fs.readFileSync(file); // 只读，绝不写回
  const { frames, badFrames, text, plain } = decodeFrames(buf);

  const rawLines = text.split('\n');
  // 文本以 \n 结尾时 split 会产生一个尾部空串，它不是真实行 —— 去掉，
  // 保证 totalLines 准确，且与 evidence.readRange 的行号完全一致。
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const events = [];
  let meta = null;
  let sessionId = null;
  let title = null;
  let badLines = 0;
  let unmapped = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (!raw.trim()) continue;

    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      badLines += 1;
      continue;
    }

    const lineNo = i + 1; // 解码后的全局行号（1-based）

    // header：字段在顶层
    if (rec.type === 'session') {
      meta = { ...rec };
      sessionId = rec.id ?? path.basename(path.dirname(file));
      continue;
    }

    const data = rec.data ?? {};
    const base = {
      platform: PLATFORM.DSH,
      session_id: sessionId ?? path.basename(path.dirname(file)),
      project: projectOf(meta),
      ts: typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null,
      seq: rec.seq ?? null,
      locator: makeLocator(file, lineNo),
    };

    let ev = null;
    switch (rec.type) {
      case 'user/message':
        // content 在 data.content
        ev = makeEvent({ ...base, kind: KIND.USER_MSG }, {
          text_len: sumTextLen(data.content, 'text'),
        });
        break;

      case 'assistant/message':
        // content 在 data.message.content
        ev = makeEvent({ ...base, kind: KIND.ASSISTANT_MSG }, {
          text_len: sumTextLen(data.message?.content, 'text'),
          reasoning_len: sumTextLen(data.message?.content, 'reasoning'),
          ...usageOf(data),
        });
        break;

      case 'tool/call':
        ev = makeEvent({ ...base, kind: KIND.TOOL_CALL }, {
          tool_name: data.name ?? '(unknown)',
          tool_call_id: data.callId ?? null,
          tool_args_hash: hashArgs(data.arguments),
        });
        break;

      case 'tool/result':
        ev = makeEvent({ ...base, kind: KIND.TOOL_RESULT }, {
          tool_call_id: data.toolCallId ?? data.message?.source?.callId ?? null,
          is_error: isErrorResult(data),
        });
        break;

      case 'approval/policy':
        ev = makeEvent({ ...base, kind: KIND.APPROVAL }, { policy: data.policy ?? null });
        break;

      case 'session/title':
        // 标题不是事件，挂在会话上；provider 生成的标题优于 fallback
        if (typeof data.title === 'string' && data.title.trim()) {
          if (title === null || data.source?.kind === 'provider') title = data.title.trim();
        }
        unmapped += 1;
        break;

      default:
        unmapped += 1; // 不关心的事件类型：只计数
        break;
    }

    if (ev) events.push(ev);
  }

  return {
    file,
    sessionId: sessionId ?? path.basename(path.dirname(file)),
    version: sessionVersion(file),
    meta,
    title,
    frames,
    badFrames,
    plain,
    totalLines: rawLines.length,
    badLines,
    unmapped,
    events,
  };
}

/** 扫描根目录下全部会话 */
export function scanSessions(opts = {}) {
  const root = resolveSessionsRoot(opts);
  const files = findSessionFiles(root);
  const sessions = [];
  const errors = [];

  for (const f of files) {
    try {
      sessions.push(parseSession(f));
    } catch (e) {
      errors.push({ file: f, message: e?.message ?? String(e) });
    }
  }

  return { root, sessions, errors, fileCount: files.length };
}
