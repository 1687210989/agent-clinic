/**
 * 目录抓取的共用 HTTP 工具。
 *
 * 第三轮（待优化报告 Phase 3 第 6 项）：`fetchJson` / `mapLimit` 原本在
 * `src/catalog/live.mjs`（体检时现搜）与 `scripts/catalog-sync.mjs`（目录同步）
 * 各写了一份，而且**已经分叉**（默认超时、UA、并发下限都不同）。
 * 抽成一份，两边 import —— 免得改了一处忘了另一处。
 */

import { setTimeout as delay } from 'node:timers/promises';

/** 默认 UA：目录同步与现搜要能区分，但都标明来自本工具 */
export const UA_SYNC = 'agent-clinic-catalog-sync';
export const UA_LIVE = 'agent-clinic-live-search';

/**
 * 带超时的 JSON GET。
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: object, userAgent?: string }} [opts]
 */
export async function fetchJson(url, { timeoutMs = 20000, headers = {}, userAgent = UA_SYNC } = {}) {
  // 护栏：旧签名是 fetchJson(url, 超时, 头)。迁移时若漏改一处，
  // 传进来的数字会被当成 opts 对象**静默忽略超时** —— 那是最难查的一类 bug。
  if (typeof arguments[1] === 'number') {
    throw new TypeError(
      `fetchJson(url, { timeoutMs, headers, userAgent }) —— 第二参数应为 opts 对象，收到数字 ${arguments[1]}`,
    );
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': userAgent, ...headers },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * 有限并发地跑一批任务。
 *
 * `minConcurrency` 默认 1：live.mjs 传的是 1（保序、少打对方接口），
 * catalog-sync 传的是它自己的批次大小。
 */
export async function mapLimit(items, limit, fn, { minConcurrency = 1 } = {}) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Math.max(minConcurrency, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: e.message };
        }
      }
    }),
  );
  return out;
}

/** 偶尔让出事件循环（给长批次用，避免饿死别的工作） */
export const tick = (ms = 0) => delay(ms);
