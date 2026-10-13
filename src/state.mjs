/**
 * L6 状态层 —— 四重过滤与反馈闭环
 *
 * 隐私约束：只存「日期 + 一句话摘要」，绝不存对话原文。
 * 可逆：删除状态文件即完全重置。
 *
 * 【当前状态：骨架】M3 待实现。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_STATE_PATH = path.join(os.homedir(), '.agent-clinic', 'state.json');

const EMPTY = {
  version: 1,
  // 四重过滤
  installed: [],   // 已安装
  recommended: [], // 已推荐
  rejected: [],    // 已拒绝
  uninterested: [],// 不感兴趣
  // 反馈闭环
  feedback: [],    // [{ date, rxId, verdict: 'useful'|'useless'|'installed' }]
};

export function loadState(statePath = DEFAULT_STATE_PATH) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY }; // 不存在或损坏 → 视为全新状态，不影响运行
  }
}

export function saveState(state, statePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function resetState(statePath = DEFAULT_STATE_PATH) {
  try {
    fs.unlinkSync(statePath);
    return true;
  } catch {
    return false;
  }
}

/** 【M3 待实现】四重过滤 */
export function filterPrescriptions(candidates, _state) {
  return candidates;
}
