/**
 * 处方反馈（M3.5）—— 记住"这条建议我不想再看到"或"这条我感兴趣"
 *
 * 解决的问题（用户的真实抱怨）：**每次体检都推同一批处方**。
 * 其中有些是用户已经明确拒绝过的（例如"我不拆会话"），下次报告还在推 ——
 * 报告于是变成噪音。这里把反馈记在本机，体检时自动应用。
 *
 * 与其它本地状态（目录快照、文本指纹快照）一致的三条纪律：
 *   1. 只写自己的目录 `~/.agent-clinic/rx-feedback.json`，不碰会话数据；
 *   2. **写不进去要如实说**（沙箱/权限问题不许静默失败）；
 *   3. **读坏了也要如实说**，并且不让体检崩掉 —— 反馈是附加信息，不是核心数据。
 *
 * 反馈的粒度是**处方的 targetId**（例如 `behavior-split-session`、
 * `plugin:npm:billion-context-dsh`）。报告里每条处方都会打印这个 ID，
 * 方便直接复制：`agent-clinic rx reject <目标 ID>`。
 *
 * ⚠️ 这里**故意只存 ID 与用户自己写的理由**，不存会话内容；
 * 理由字段是用户自己的文本，随 `rx clear` 一并删除。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FEEDBACK_DIR = path.join(os.homedir(), '.agent-clinic');
export const FEEDBACK_PATH = path.join(FEEDBACK_DIR, 'rx-feedback.json');
export const FEEDBACK_VERSION = 1;

/** 反馈状态：拒绝（不再给出）/ 感兴趣（标记出来，不隐藏） */
export const FEEDBACK_STATE = {
  REJECTED: 'rejected',
  INTERESTED: 'interested',
};

const STATE_LABEL = {
  [FEEDBACK_STATE.REJECTED]: '已拒绝',
  [FEEDBACK_STATE.INTERESTED]: '感兴趣',
};

export function stateLabel(state) {
  return STATE_LABEL[state] ?? state;
}

function emptyStore() {
  return { version: FEEDBACK_VERSION, updatedAt: null, entries: {} };
}

/**
 * 读取反馈。
 *
 * @param {{path?:string}} [opts]
 * @returns {{store:object, error:{message:string}|null, created:boolean}}
 *   - 文件不存在（ENOENT/ENOTDIR）→ 空反馈，不是错误
 *   - 文件损坏 → store 为空但 error 非空（调用方必须把这件事说出来）
 */
export function loadFeedback({ path: file = FEEDBACK_PATH } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
      return { store: emptyStore(), error: null, created: true };
    }
    return { store: emptyStore(), error: { message: `读不出来：${e.message}` }, created: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { store: emptyStore(), error: { message: '格式不认识（缺 entries）—— 可删除该文件后重来' }, created: false };
    }
    return {
      store: { version: parsed.version ?? FEEDBACK_VERSION, updatedAt: parsed.updatedAt ?? null, entries: parsed.entries },
      error: null,
      created: false,
    };
  } catch (e) {
    return { store: emptyStore(), error: { message: `不是合法 JSON：${e.message}` }, created: false };
  }
}

/** @returns {{ok:boolean, error:{message:string}|null}} */
export function saveFeedback(store, { path: file = FEEDBACK_PATH } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      version: FEEDBACK_VERSION,
      updatedAt: new Date().toISOString(),
      entries: store.entries ?? {},
    };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: { message: e.message } };
  }
}

/**
 * 记一条反馈（同 ID 覆盖旧状态）。
 * @returns {{store:object, changed:boolean, entry:object}}
 */
export function recordFeedback(store, { targetId, state, reason = null, metric = null, label = null, at = null }) {
  if (!targetId) throw new Error('缺少 targetId');
  if (!Object.values(FEEDBACK_STATE).includes(state)) {
    throw new Error(`未知反馈状态：${state}（可用：${Object.values(FEEDBACK_STATE).join(' / ')}）`);
  }
  const entries = store.entries ?? (store.entries = {});
  const prev = entries[targetId];
  const entry = {
    // targetId 也放进条目里：条目以它为键，但调用方（CLI 回显、报告渲染、断言）
    // 拿到的是一个对象，没有它就只能显示 undefined —— 我自己踩过这个坑。
    targetId,
    state,
    at: at ?? new Date().toISOString(),
    reason: reason || null,
    metric: metric || null,
    label: label || prev?.label || null,
  };
  const changed = !prev || prev.state !== entry.state || (prev.reason ?? null) !== (entry.reason ?? null);
  entries[targetId] = entry;
  store.updatedAt = entry.at;
  return { store, changed, entry };
}

/** 某个状态下的全部 targetId */
export function feedbackIds(store, state) {
  return Object.entries(store?.entries ?? {})
    .filter(([, v]) => v?.state === state)
    .map(([k]) => k);
}

/** 摊平成列表（便于渲染与断言） */
export function feedbackEntries(store) {
  return Object.entries(store?.entries ?? {})
    .map(([targetId, v]) => ({
      targetId,
      state: v?.state ?? null,
      at: v?.at ?? null,
      reason: v?.reason ?? null,
      metric: v?.metric ?? null,
      label: v?.label ?? null,
    }))
    .filter((e) => e.state);
}

export function summarizeFeedback(store) {
  const entries = feedbackEntries(store);
  return {
    rejected: entries.filter((e) => e.state === FEEDBACK_STATE.REJECTED).length,
    interested: entries.filter((e) => e.state === FEEDBACK_STATE.INTERESTED).length,
    total: entries.length,
    updatedAt: store?.updatedAt ?? null,
  };
}

export function removeFeedback(store, targetId) {
  const entries = store.entries ?? (store.entries = {});
  const existed = Boolean(entries[targetId]);
  delete entries[targetId];
  return { store, existed };
}

export function clearFeedback({ path: file = FEEDBACK_PATH } = {}) {
  try {
    fs.rmSync(file, { force: true });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: { message: e.message } };
  }
}

/**
 * 供体检路径使用的一站式封装：读反馈 → 返回给 analyze/report 的选项。
 * 读坏了不抛异常（体检照常跑），但把 error 带出来让上层如实提示。
 */
export function feedbackOptions({ path: file = FEEDBACK_PATH } = {}) {
  const { store, error } = loadFeedback({ path: file });
  return {
    store,
    error,
    rejected: feedbackIds(store, FEEDBACK_STATE.REJECTED),
    interested: feedbackIds(store, FEEDBACK_STATE.INTERESTED),
    summary: summarizeFeedback(store),
  };
}
