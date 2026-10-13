/**
 * 统一事件模型 —— L0 适配层的核心契约
 *
 * 所有平台的适配器（dsh / workbuddy）都必须把原始记录归一化成这个形状，
 * 上层的诊断层、证据层、处方层只认这个模型，不认平台细节。
 */

/** 事件种类（与任务书 §6.2 一致） */
export const KIND = {
  USER_MSG: 'user_msg',
  ASSISTANT_MSG: 'assistant_msg',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  USAGE: 'usage',
  APPROVAL: 'approval',
  META: 'meta',
};

/** 平台标识 */
export const PLATFORM = {
  DSH: 'dsh',
  WORKBUDDY: 'workbuddy',
};

/**
 * 证据定位符：`<绝对路径>#L<行号>`
 * 行号是**解码后的全局行号**（跨 zstd 帧累加，1-based），
 * 保证 scan 与 show 使用同一套切帧逻辑时可精确复现。
 */
export function makeLocator(file, line) {
  return `${file}#L${line}`;
}

/** 解析定位符 → { file, line }；格式非法时返回 null */
export function parseLocator(locator) {
  const i = String(locator).lastIndexOf('#L');
  if (i < 0) return null;
  const file = String(locator).slice(0, i);
  const line = Number(String(locator).slice(i + 2));
  if (!file || !Number.isInteger(line) || line < 1) return null;
  return { file, line };
}

/**
 * 稳定的参数序列化：对象键排序，保证语义相同的参数得到相同哈希。
 * 用于 E1 死循环检测 —— 参数有变化的试错必须产生不同哈希。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 构造一条统一事件。字段全部显式给默认值，避免上层到处判 undefined。
 *
 * @returns {{
 *   platform:string, session_id:string, project:string, ts:string|null,
 *   seq:number|null, kind:string, locator:string,
 *   tool_name?:string, tool_args_hash?:string, tool_call_id?:string,
 *   is_error?:boolean, policy?:string,
 *   input_tokens?:number, output_tokens?:number,
 *   cache_read_tokens?:number, cache_write_tokens?:number, total_tokens?:number,
 *   text_len?:number, reasoning_len?:number
 * }}
 */
export function makeEvent(base, extra = {}) {
  return {
    platform: base.platform,
    session_id: base.session_id,
    project: base.project,
    ts: base.ts,
    seq: base.seq ?? null,
    kind: base.kind,
    locator: base.locator,
    ...extra,
  };
}
