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
import { resolveDshHome as resolveEnvDshHome } from '../config/index.mjs';
import { KIND, PLATFORM, makeLocator, makeEvent, stableStringify } from './base.mjs';

/** 会话文件名匹配：session.v4.jsonl.zstd / session.v1.jsonl */
const SESSION_FILE_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;

/** 解析 DSH_HOME：显式参数 > 环境变量 > ~/.dsh */
/**
 * 会话根目录所在（DSH_HOME）。
 *
 * ⚠️ 第三轮：这里原本自带一份回退逻辑，与 src/config/index.mjs 的
 * resolveDshHome 已经分叉（那份会 trim 并回退 HOME/USERPROFILE）。
 * 现在统一委托给 config 的那一份，只保留"显式路径优先"的包装。
 */
export function resolveDshHome(explicit) {
  if (explicit) return explicit;
  return resolveEnvDshHome(process.env) || path.join(os.homedir(), '.dsh');
}

/** 会话根目录 */
export function resolveSessionsRoot(opts = {}) {
  return path.join(resolveDshHome(opts.dshHome), 'sessions');
}

/**
 * 递归找出所有会话文件，按路径排序（保证输出稳定可复现）。
 *
 * 第二轮评估 F4：旧实现是 `catch { return; }` 静默跳过 —— 目录**不可读**与
 * **本来就没有会话**在下游看起来一模一样，于是 CLI 会打印"未找到会话文件"，
 * 把权限/路径问题伪装成"你机器上没有数据"。现在把读取失败如实带出去。
 *
 * @returns {{files:string[], errors:Array<{dir:string, code:string|null, message:string}>}}
 */
export function findSessionFilesDetailed(root) {
  const files = [];
  const errors = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // ENOENT = 这个目录确实不存在（正常：没装过/没用过）；其余要报出来
      if (e?.code !== 'ENOENT') {
        errors.push({ dir, code: e?.code ?? null, message: e?.message ?? String(e) });
      }
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SESSION_FILE_RE.test(e.name)) files.push(p);
    }
  };
  walk(root);
  return { files: files.sort(), errors };
}

/** 兼容入口：只要文件列表（不关心读取失败） */
export function findSessionFiles(root) {
  return findSessionFilesDetailed(root).files;
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

/**
 * N2 高风险操作的模式表。
 *
 * 隐私约束（本项目硬性原则）：只返回**命中的模式标签**，
 * 绝不返回原始参数、路径或命令正文。报告与面板里也只出现标签。
 *
 * ⚠️ 只匹配命令执行类工具的 command 字段。
 * 实测踩过的坑：早期版本对整个 arguments JSON 做匹配，结果把
 * `write` 工具写入的 Markdown 文档正文里的 "--force" 当成高危命令，
 * 报了 2 条假警报。write/edit/read 的参数是**用户内容**，不是命令。
 */
const DANGER_PATTERNS = [
  { label: 'rm -r/-f', re: /\brm\s+-[a-z]*(?:r|f)[a-z]*\b/i },
  { label: '--force', re: /--force\b/i },
  { label: 'git reset --hard', re: /\breset\s+--hard\b/i },
  { label: 'git clean -fd', re: /\bgit\s+clean\s+-[a-z]*f/i },
  { label: 'DROP/TRUNCATE', re: /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i },
  { label: 'curl | sh', re: /\bcurl\b[^|]{0,200}\|\s*(?:ba|z|a)?sh\b/i },
  { label: 'kill -9', re: /\bkill\s+-9\b/i },
  { label: 'chmod 777', re: /\bchmod\s+777\b/i },
  { label: 'mkfs', re: /\bmkfs\b/i },
  { label: 'fork bomb', re: /:\(\)\s*\{/ },
];

/** 命令执行类工具：只有它们的参数才是"命令"而非"内容" */
const COMMAND_TOOLS =
  /^(?:pwsh|powershell|powershell\.exe|pwsh\.exe|bash|sh|zsh|dash|shell|exec|execute|run_command|cmd|cmd\.exe|terminal|node|python|python3|ruby)$/i;

/** 从参数里取出命令文本；取不到返回 null */
function commandTextOf(args) {
  let obj;
  if (typeof args === 'string') {
    try {
      obj = JSON.parse(args);
    } catch {
      return args; // 纯字符串当作命令
    }
  } else {
    obj = args;
  }
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['command', 'cmd', 'script', 'code', 'shellCommand']) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
  }
  return null;
}

/** 返回命中的高危模式标签数组（空数组 = 未命中）。不携带任何原始内容。 */
function dangerOf(name, args) {
  if (!name || !COMMAND_TOOLS.test(String(name))) return [];
  const cmd = commandTextOf(args);
  if (!cmd) return [];
  const hits = [];
  for (const p of DANGER_PATTERNS) {
    try {
      if (p.re.test(cmd)) hits.push(p.label);
    } catch {
      /* 单个正则异常不影响其他模式 */
    }
  }
  return hits;
}

/** todo 条目数。结构未知时保守返回 null，不下结论。 */
function todoCountOf(data) {
  const t = data?.todos ?? data?.todoList ?? data?.items;
  if (Array.isArray(t)) return t.length;
  if (typeof t === 'number') return t;
  return null;
}

/** 已完成的 todo 条目数 */
function todoDoneOf(data) {
  const t = data?.todos ?? data?.todoList ?? data?.items;
  if (!Array.isArray(t)) return null;
  let n = 0;
  for (const item of t) {
    const st = item?.status ?? item?.state;
    if (st === 'done' || st === 'completed' || item?.done === true) n += 1;
  }
  return n;
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

/**
 * 结构化数据的**字节/字符体量** —— 只取长度，绝不保留内容。
 *
 * 用于 C6（工具 schema 体量）与 C7（上下文注入量）：这两个指标要的是"多大"，
 * 不是"是什么"。用 JSON 序列化长度而不是递归数叶子，是为了让口径可复核
 * （同一份数据任何时候算出同一个数）。
 */
function jsonLen(value) {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0; // 循环引用等异常输入：按 0 处理，不让单条脏数据毁掉整个会话解析
  }
}

/**
 * 从工具参数里只取出**技能名**（A2 需要）。
 *
 * ⚠️ 第二轮评估 F13 的根因：DSH 的 skill 触发**不是**同名工具调用，
 * 而是唯一的 `skill` 工具 + 参数 `{"name":"<技能名>"}`。
 * 旧代码拿 tool_name 去比技能目录名，于是永远匹配不上 → 窗口一到
 * 所有已装 skill 都被误报为"闲置"。
 *
 * 只提炼 `name` 一个字段，不保留其它参数（隐私硬约束与 A2 的判据一致）。
 */
function skillNameOf(name, args) {
  if (String(name ?? '') !== 'skill') return null;
  let obj = args;
  if (typeof args === 'string') {
    try {
      obj = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const v = obj?.name;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 供冒烟测试直接验证技能名提取（不在生产路径上调用） */
export const skillNameOfForTest = skillNameOf;

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
          // A2：skill 触发是 `skill` 工具 + 参数 name（不是同名工具调用）
          skill_name: skillNameOf(data.name, data.arguments),
          // N2：只对命令执行类工具检测，且只记命中的模式标签，
          // 不记原始参数（隐私硬约束 + 防 write/edit 内容误报）
          danger: dangerOf(data.name, data.arguments),
        });
        break;

      case 'tool/result':
        ev = makeEvent({ ...base, kind: KIND.TOOL_RESULT }, {
          tool_call_id: data.toolCallId ?? data.message?.source?.callId ?? null,
          is_error: isErrorResult(data),
          // E3：工具结果过大。只记**长度**，不保留正文 ——
          // 旧版本连长度都没记，于是 E3 被误判成"数据源缺失"。
          text_len: sumTextLen(data.message?.content ?? data.content, 'text'),
        });
        break;

      case 'todo/write':
        // E4 计划执行脱节：把「写了计划」这个事实记下来。
        // 只记条目数与是否全部完成，不记计划正文。
        ev = makeEvent({ ...base, kind: KIND.TODO_WRITE }, {
          todo_count: todoCountOf(data),
          done_count: todoDoneOf(data),
        });
        break;

      case 'approval/policy':
        ev = makeEvent({ ...base, kind: KIND.APPROVAL }, {
          approval_phase: 'policy',
          policy: data.policy ?? null,
        });
        break;

      // N3 权限审批摩擦：asked 与 decided 用 id 关联 ——
      // 旧版本只认 approval/policy，于是把 N3 判成"DSH 没有这些事件"。
      // 这里记 id / 工具名 / 决定结果，**不记 reason 正文**（可能含用户上下文）。
      case 'approval/asked':
        ev = makeEvent({ ...base, kind: KIND.APPROVAL }, {
          approval_phase: 'asked',
          approval_id: data.id ?? null,
          tool_name: data.toolName ?? null,
          reason_len: typeof data.reason === 'string' ? data.reason.length : 0,
        });
        break;
      case 'approval/decided':
        ev = makeEvent({ ...base, kind: KIND.APPROVAL }, {
          approval_phase: 'decided',
          approval_id: data.id ?? null,
          outcome: data.outcome ?? null,
        });
        break;

      // N4 API 重试频繁：llm/retry 携带失败码、重试序号与退避时长
      case 'llm/retry':
        ev = makeEvent({ ...base, kind: KIND.RETRY }, {
          retry_id: data.retryId ?? null,
          provider: data.provider ?? null,
          retry_mode: data.mode ?? null,
          retry_index: Number.isFinite(data.retry) ? data.retry : null,
          max_retries: Number.isFinite(data.maxRetries) ? data.maxRetries : null,
          delay_ms: Number.isFinite(data.delayMs) ? data.delayMs : null,
          failure_code: data.failure?.code ?? null,
        });
        break;

      // ---------------------------------------------------------------------
      // C5 压缩可观测性 —— DSH 自己记着"这次压缩实际释放了多少 token"：
      //   compaction/summary 带 shadowedTokenCount + shadowedSeqs + provider/model
      //   compaction/prune   带 shadowedTokenCount（只有剪枝，没有摘要）
      // 旧版本完全不解析这四类事件，于是 C1/C3 只能靠启发式估算绕圈子。
      // 只记数字与范围，**不记 summary / rawOutput 正文**。
      // ---------------------------------------------------------------------
      case 'compaction/start':
      case 'compaction/end':
        ev = makeEvent({ ...base, kind: KIND.COMPACTION }, {
          compaction_phase: rec.type === 'compaction/start' ? 'start' : 'end',
          compaction_id: data.compactionId ?? null,
          turn: Number.isFinite(data.turn) ? data.turn : null,
        });
        break;

      case 'compaction/summary':
        ev = makeEvent({ ...base, kind: KIND.COMPACTION }, {
          compaction_phase: 'summary',
          compaction_id: data.compactionId ?? null,
          shadowed_token_count: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : null,
          shadowed_count: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null,
          shadowed_start: Number.isFinite(data.shadowedRange?.start) ? data.shadowedRange.start : null,
          shadowed_end: Number.isFinite(data.shadowedRange?.end) ? data.shadowedRange.end : null,
          // 摘要本身的体量（与"释放了多少"对比，能看出压缩效率）
          summary_chars: Array.isArray(data.summary) ? sumTextLen(data.summary, 'text') : null,
          provider: data.provider ?? null,
          model: data.model ?? null,
        });
        break;

      case 'compaction/prune':
        ev = makeEvent({ ...base, kind: KIND.COMPACTION }, {
          compaction_phase: 'prune',
          compaction_id: data.compactionId ?? null,
          shadowed_token_count: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : null,
          shadowed_count: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null,
          shadowed_start: Number.isFinite(data.shadowedRange?.start) ? data.shadowedRange.start : null,
          shadowed_end: Number.isFinite(data.shadowedRange?.end) ? data.shadowedRange.end : null,
        });
        break;

      // ---------------------------------------------------------------------
      // C6 工具面成本 —— request/header 里有**完整的工具 schema**（实测 27 个工具）。
      // 工具 schema 每个请求都要重发，但此前从未被计量过。
      // 记工具名（它们是指令标识符，不是用户内容）+ schema 字节数与 maxTokens。
      // ---------------------------------------------------------------------
      case 'request/header': {
        const header = data.header ?? {};
        const tools = Array.isArray(header.tools) ? header.tools : [];
        ev = makeEvent({ ...base, kind: KIND.REQUEST_HEADER }, {
          request_reason: typeof data.reason === 'string' ? data.reason : null,
          tool_count: tools.length,
          tool_names: tools.map((t) => (typeof t?.name === 'string' ? t.name : null)).filter(Boolean),
          tool_schema_bytes: jsonLen(tools),
          max_tokens: Number.isFinite(header.config?.maxTokens)
            ? header.config.maxTokens
            : Number.isFinite(header.adapterDefaults?.maxTokens)
              ? header.adapterDefaults.maxTokens
              : null,
        });
        break;
      }

      // C7 上下文注入量 —— inbox 被 splice 的痕迹（塞了什么进去、多大）。
      // 只记体积与目标，不记插入内容。
      case 'agent/inbox/spliced':
        ev = makeEvent({ ...base, kind: KIND.INBOX_SPLICE }, {
          splice_target: typeof data.target === 'string' ? data.target : null,
          splice_start: Number.isFinite(data.start) ? data.start : null,
          inserted_count: Array.isArray(data.inserted) ? data.inserted.length : null,
          inserted_chars: jsonLen(data.inserted),
        });
        break;

      // ---------------------------------------------------------------------
      // A5 辅助 LLM 开销 —— 这两类请求**没有 usage 记录**，但它们确实在花钱：
      //   web/deepseek-search-llm-request（联网检索，实测 max_tokens=4096）
      //   session/title-llm-request（会话标题，maxTokens=64）
      // 只记次数、模型与 token 上限（据此给上界估算），不记请求体正文。
      // ---------------------------------------------------------------------
      case 'web/deepseek-search-llm-request':
        ev = makeEvent({ ...base, kind: KIND.AUX_REQUEST }, {
          aux_source: 'web-search',
          aux_model: data.body?.model ?? null,
          aux_max_tokens: Number.isFinite(data.body?.max_tokens) ? data.body.max_tokens : null,
          aux_input_chars: jsonLen(data.body?.messages),
        });
        break;

      case 'session/title-llm-request':
        ev = makeEvent({ ...base, kind: KIND.AUX_REQUEST }, {
          aux_source: 'session-title',
          aux_model: data.route?.model ?? null,
          aux_max_tokens: Number.isFinite(data.maxTokens) ? data.maxTokens : null,
          aux_input_chars: jsonLen(data.messages),
        });
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
    // A4 子代理开销：header 顶层字段（不在 .data 里）
    delegationDepth: Number.isFinite(meta?.delegationDepth) ? meta.delegationDepth : null,
    parentSession: typeof meta?.parentSession === 'string' ? meta.parentSession : null,
    isSubagent: (meta?.origin === 'subagent') || (Number(meta?.delegationDepth) > 0),
    origin: typeof meta?.origin === 'string' ? meta.origin : null,
    events,
  };
}

/** 扫描根目录下全部会话 */
export function scanSessions(opts = {}) {
  const root = resolveSessionsRoot(opts);
  const { files, errors: scanErrors } = findSessionFilesDetailed(root);
  const sessions = [];
  // 目录读取失败与文件解析失败**分开记**：前者让人以为"没数据"，后者让人以为"没问题"
  const errors = scanErrors.map((e) => ({
    kind: 'read',
    file: e.dir,
    code: e.code,
    message:
      e.code === 'EACCES' || e.code === 'EPERM'
        ? `无权限读取目录（${e.code}）`
        : `读取目录失败：${e.message}`,
  }));

  for (const f of files) {
    try {
      sessions.push(parseSession(f));
    } catch (e) {
      errors.push({ kind: 'parse', file: f, code: e?.code ?? null, message: e?.message ?? String(e) });
    }
  }

  return { root, sessions, errors, fileCount: files.length };
}
