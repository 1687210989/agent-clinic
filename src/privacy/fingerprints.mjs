/**
 * 用户文本指纹 —— K1（跨会话失忆）/ K2（已解决重新排查）的数据基础
 *
 * 2026-10-15 决策 D4：用户选了「指纹写入本地快照」这个较强的一档。
 *
 * 【隐私边界，必须逐条说清】
 *   1. 会话文件**只读**：本模块从不写 DSH 的会话数据。
 *   2. 正文**不落盘、不进报告、不进事件**：解析时当场规范化 → 加盐 sha256 →只留
 *      32 位十六进制指纹。任何地方都拿不回原文。
 *   3. 指纹仍带隐私含义：对**已知候选文本**（比如"你是不是问过 '帮我看看构建失败'"），
 *      持有快照文件的人可以逐条试算比对。加盐（每台机器一份随机盐）让**预先算好的**
 *      字典/彩虹表失效，也让不同机器的快照之间无法互相比对。
 *   4. 因此这是**本机、可清除**的能力：路径 `~/.agent-clinic/text-fingerprints.json`，
 *      `agent-clinic fingerprints` 可查看统计，`--clear` 可删除；
 *      环境变量 `AGENT_CLINIC_NO_FINGERPRINT_STORE=1` 可整体关闭（关闭后 K1/K2 会
 *      如实说明"本次未采集指纹"，而不是假装没问题）。
 *   5. 太短的文本（< MIN_CHARS）**不生成指纹**：既避免"继续 / 好的"这类噪音误报，
 *      也让指纹集合不含无意义条目。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 快照目录（与插件目录快照 catalog.snapshot.json 同目录） */
export const STORE_DIR = path.join(os.homedir(), '.agent-clinic');
export const STORE_PATH = path.join(STORE_DIR, 'text-fingerprints.json');
export const STORE_VERSION = 1;
/** 短于这个字符数的用户文本不生成指纹（防噪音误报） */
export const MIN_CHARS = 12;
/** 每个指纹最多保留多少条观测（跨会话长期比对够用，同时给文件设上界） */
export const MAX_OBS_PER_HASH = 20;
/** 最多保留多少个不同指纹（超出按最近一次出现时间淘汰） */
export const MAX_HASHES = 5000;

/** 关闭开关：设了就完全不采集、不读、不写 */
export function fingerprintsDisabled(env = process.env) {
  return env.AGENT_CLINIC_NO_FINGERPRINT_STORE === '1';
}

// ---------------------------------------------------------------------------
// 盐：进程级，扫面前设置一次（适配层要给事件算指纹）
// ---------------------------------------------------------------------------

let activeSalt = null;

/** @param {string|null} salt */
export function setActiveSalt(salt) {
  activeSalt = typeof salt === 'string' && salt ? salt : null;
}

export function getActiveSalt() {
  return activeSalt;
}

export function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// 规范化 + 指纹
// ---------------------------------------------------------------------------

/**
 * 规范化用户文本：去零宽字符、NFC、压缩空白、小写。
 * 目的：让"同一个问题"的排版差异（多打一个空格、换个大小写）不会变成两个指纹。
 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * @param {string} salt
 * @param {string} text 用户文本
 * @returns {{hash:string, chars:number}|null} 文本太短或没有盐时返回 null（不假装有指纹）
 */
export function fingerprintOf(salt, text) {
  const n = normalizeText(text);
  if (!salt || n.length < MIN_CHARS) return null;
  const hash = crypto
    .createHash('sha256')
    .update(`${salt}\u0000${n}`)
    .digest('hex')
    .slice(0, 32);
  return { hash, chars: n.length };
}

/** 从 content 块数组里拼出纯文本（只用于**当场**算指纹，不返回给上层） */
export function textOfContent(blocks, type = 'text') {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (b && b.type === type && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 快照读写
// ---------------------------------------------------------------------------

/** @returns {{store:object|null, error:{code:string|null,message:string}|null, created:boolean}} */
export function loadStore({ path: file = STORE_PATH } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 「还没有快照」的两种表现，都必须当成正常：
    //   ENOENT  —— 文件不存在（Windows / 首次运行）
    //   ENOTDIR —— 路径的某一级不是目录（Linux/macOS 上读 <文件>/sub/store.json 会这样报）
    // ⚠️ 这是 CI 的跨平台 matrix 抓出来的真实差异：同一段"故意写不进去"的构造，
    //    Windows 报 ENOENT 走到 save 阶段，Linux 报 ENOTDIR 被当成"读不出来"，
    //    于是"写盘失败 ≠ 没判定"那条断言在 Linux 上假红。
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
      // 没同步过：正常，用新盐建一份空快照（**不落盘**，等真正有观测再写）
      return {
        store: { version: STORE_VERSION, salt: makeSalt(), createdAt: null, updatedAt: null, observations: {} },
        error: null,
        created: true,
      };
    }
    return { store: null, error: { code: e?.code ?? null, message: e?.message ?? String(e) }, created: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.salt !== 'string' || !parsed.salt) {
      return {
        store: null,
        error: { code: null, message: '快照格式不认识（缺 salt）—— 可删除该文件后重跑' },
        created: false,
      };
    }
    if (!parsed.observations || typeof parsed.observations !== 'object') parsed.observations = {};
    return { store: { ...parsed, version: parsed.version ?? STORE_VERSION }, error: null, created: false };
  } catch (e) {
    return { store: null, error: { code: null, message: `快照不是合法 JSON：${e.message}` }, created: false };
  }
}

/** @returns {{ok:boolean, error:{code:string|null,message:string}|null}} */
export function saveStore(store, { path: file = STORE_PATH } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 只写我们认识的字段，避免把调用方的临时对象整包落盘
    const payload = {
      version: STORE_VERSION,
      salt: store.salt,
      createdAt: store.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      observations: store.observations ?? {},
    };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: { code: e?.code ?? null, message: e?.message ?? String(e) } };
  }
}

export function clearStore({ path: file = STORE_PATH } = {}) {
  try {
    fs.rmSync(file, { force: true });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: { code: e?.code ?? null, message: e?.message ?? String(e) } };
  }
}

// ---------------------------------------------------------------------------
// 观测：从 scan 收集，与快照合并
// ---------------------------------------------------------------------------

/**
 * 从扫描结果里收集用户文本指纹观测。
 *
 * 事件上的 `text_hash` 由适配层在解析时算好（正文不落盘）。
 * 没有 `text_hash`（未设置盐 / 文本过短 / 旧数据）的事件**不会被计入** ——
 * 上层据 `missing` 判断"本次到底采到没有"，并如实说明。
 *
 * @param {{sessions:Array}} scan
 * @returns {{observations:Array<{hash:string,session:string,ts:string|null,chars:number,locator:string}>, missing:number}}
 */
export function observationsFromScan(scan) {
  const observations = [];
  let missing = 0;
  for (const s of scan?.sessions ?? []) {
    for (const e of s.events ?? []) {
      if (e.kind !== 'user_msg') continue;
      if (!e.text_hash) {
        missing += 1;
        continue;
      }
      observations.push({
        hash: e.text_hash,
        session: e.session_id ?? s.sessionId,
        ts: e.ts ?? null,
        chars: e.text_len ?? 0,
        locator: e.locator,
      });
    }
  }
  return { observations, missing };
}

/**
 * 把观测合并进快照（按 hash → 观测列表，去重 session+ts，设上界）。
 *
 * @returns {{store:object, added:number}}
 */
export function mergeObservations(store, observations) {
  const obs = store.observations ?? (store.observations = {});
  let added = 0;
  for (const o of observations) {
    const list = obs[o.hash] ?? (obs[o.hash] = []);
    const dup = list.some((x) => x.session === o.session && x.ts === o.ts);
    if (dup) continue;
    list.push({ session: o.session, ts: o.ts, chars: o.chars, locator: o.locator });
    added += 1;
    // 同一指纹只留最近 MAX_OBS_PER_HASH 条（按时间排序后裁掉最旧的）
    if (list.length > MAX_OBS_PER_HASH) {
      list.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
      list.splice(0, list.length - MAX_OBS_PER_HASH);
    }
  }
  // 整体上界：超出就淘汰"最近一次出现最早"的指纹
  const hashes = Object.keys(obs);
  if (hashes.length > MAX_HASHES) {
    const lastSeen = (h) => {
      const list = obs[h] ?? [];
      return list.reduce((m, x) => (String(x.ts ?? '') > m ? String(x.ts ?? '') : m), '');
    };
    hashes
      .sort((a, b) => lastSeen(a).localeCompare(lastSeen(b)))
      .slice(0, hashes.length - MAX_HASHES)
      .forEach((h) => delete obs[h]);
  }
  return { store, added };
}

/** 把快照里的观测摊平成与 observationsFromScan 相同的形状（供 K1/K2 统一处理） */
export function observationsFromStore(store) {
  const out = [];
  for (const [hash, list] of Object.entries(store?.observations ?? {})) {
    for (const o of list ?? []) {
      out.push({ hash, session: o.session, ts: o.ts ?? null, chars: o.chars ?? 0, locator: o.locator ?? null });
    }
  }
  return out;
}

export function storeStats(store) {
  const obs = store?.observations ?? {};
  const hashes = Object.keys(obs);
  const observations = hashes.reduce((n, h) => n + (obs[h]?.length ?? 0), 0);
  return { hashes: hashes.length, observations, updatedAt: store?.updatedAt ?? null };
}

// ---------------------------------------------------------------------------
// 一次运行的完整生命周期（调用方只需要这三个动作）
// ---------------------------------------------------------------------------

/**
 * 开始一次"带指纹"的运行。
 *
 * ⚠️ 顺序很重要：**必须在 scanSessions() 之前**调用 —— 适配层是在**解析时**
 * 就把用户文本算成指纹的（正文不落盘），没有先设好盐，这次扫描就不会带指纹。
 *
 * 用法：
 *   const fp = beginFingerprintRun();
 *   const scan = scanSessions({});
 *   const d = analyze({ scan, summary }, { ...opts, ...fp.diagnosticOpts(scan) });
 *   const outcome = fp.finish(scan);   // 合并 + 落盘；返回如实的结果给用户看
 *
 * @param {{path?:string, env?:NodeJS.ProcessEnv}} [opts]
 */
export function beginFingerprintRun(opts = {}) {
  const env = opts.env ?? process.env;
  const file = opts.path ?? STORE_PATH;

  if (fingerprintsDisabled(env)) {
    const skipped = '已按 AGENT_CLINIC_NO_FINGERPRINT_STORE=1 关闭指纹采集（K1/K2 本次不判定）';
    return {
      enabled: false,
      store: null,
      error: null,
      skipped,
      diagnosticOpts: (scan) => ({
        fingerprintObservations: [],
        fingerprintMissing: observationsFromScan(scan).missing,
        fingerprintUnavailable: skipped,
      }),
      finish: () => ({ saved: false, added: 0, skipped, error: null }),
    };
  }

  const { store, error, created } = loadStore({ path: file });
  if (!store) {
    // 读不出来就**如实报错**，不静默降级成"没问题"（本项目的硬规矩）
    const note = `指纹快照读不出来：${error?.message ?? '未知原因'}（K1/K2 本次未判定；可删除 ${file} 后重跑）`;
    return {
      enabled: false,
      store: null,
      error,
      skipped: null,
      diagnosticOpts: (scan) => ({
        fingerprintObservations: [],
        fingerprintMissing: observationsFromScan(scan).missing,
        fingerprintUnavailable: note,
      }),
      // phase='load'：连盐都没有，K1/K2 确实**没判**——措辞必须说"未判定"
      finish: () => ({ saved: false, added: 0, skipped: null, error, phase: 'load', judged: false }),
      note,
    };
  }

  setActiveSalt(store.salt);
  let finished = false;

  return {
    enabled: true,
    store,
    error: null,
    skipped: null,
    path: file,
    created,
    /**
     * 给 runDiagnostics/analyze 的选项：把**本次扫描**的观测与**快照里**的历史观测
     * 合在一起交给 K1/K2（这样上一次体检里出现过、本次已不在窗口内的会话也能被算进去）。
     */
    diagnosticOpts(scan) {
      const { observations, missing } = observationsFromScan(scan);
      return {
        fingerprintObservations: [...observations, ...observationsFromStore(store)],
        fingerprintStore: store,
        fingerprintMissing: missing,
      };
    },
    /** 合并 + 落盘。没有新观测时不写盘（避免每次空跑都改文件时间） */
    finish(scan) {
      if (finished) return { saved: false, added: 0, skipped: '本次运行已结束', error: null };
      finished = true;
      setActiveSalt(null);
      const { observations, missing } = observationsFromScan(scan);
      const { added } = mergeObservations(store, observations);
      const stats = storeStats(store);
      if (added === 0) {
        return { saved: false, added: 0, missing, stats, path: file, error: null, phase: null, judged: true };
      }
      const res = saveStore(store, { path: file });
      // ⚠️ 关键区分（这是我自己写错过的）：**写盘失败 ≠ 没判定**。
      // 盐在本进程内存里是有的，本次扫描的指纹已经算出来了，K1/K2 照样判定了；
      // 写失败的后果是"跨会话历史不会累积"，不是"这次没查"。说成"未判定"就成了假话。
      return {
        saved: res.ok,
        added,
        missing,
        stats,
        path: file,
        error: res.error,
        phase: res.ok ? null : 'save',
        judged: true,
      };
    },
  };
}
