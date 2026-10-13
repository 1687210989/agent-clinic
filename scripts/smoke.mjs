#!/usr/bin/env node
/**
 * 冒烟测试 —— 验证 M1 最小闭环的骨架能力
 *
 * 运行：node scripts/smoke.mjs
 * 退出码 0 = 全部通过
 *
 * 检查项：
 *   1. 运行环境支持原生 zstd
 *   2. 能扫到会话
 *   3. 多帧解码完整（帧数 / 行数 > 0，无坏帧）
 *   4. 事件模型字段完整
 *   5. scan 与 show 的行号严格一致（可复现性）
 *   6. 只读 —— 运行前后文件 mtime / size 不变
 *   7. 缺失数据时不崩溃
 */

import fs from 'node:fs';
import path from 'node:path';

import { scanSessions, resolveSessionsRoot } from '../src/adapters/dsh.mjs';
import { summarize } from '../src/summary.mjs';
import { hasZstdSupport } from '../src/adapters/zstd-frames.mjs';
import { readRange } from '../src/evidence/index.mjs';
import { KIND } from '../src/adapters/base.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stdout.write(`  ✓ ${name}${detail ? `  ${detail}` : ''}\n`);
  } else {
    fail += 1;
    failures.push(name);
    process.stdout.write(`  ✗ ${name}${detail ? `  ${detail}` : ''}\n`);
  }
}

process.stdout.write('\nagent-clinic 冒烟测试\n=====================\n\n');

// --- 1. 环境 ---
process.stdout.write('1) 运行环境\n');
check('Node 支持原生 zstd 解码', hasZstdSupport(), process.version);
if (!hasZstdSupport()) {
  process.stdout.write('\n环境不满足，后续检查跳过。\n');
  process.exit(1);
}

// --- 2. 扫描 ---
process.stdout.write('\n2) 扫描会话\n');
const root = resolveSessionsRoot({});
check('会话根目录存在', fs.existsSync(root), root);

const scan = scanSessions({});
check('扫到会话文件', scan.fileCount > 0, `${scan.fileCount} 个`);
check('无解析失败', scan.errors.length === 0, scan.errors.length ? JSON.stringify(scan.errors) : '');

if (scan.fileCount === 0) {
  process.stdout.write('\n无会话数据，跳过剩余检查。\n');
  process.exit(fail === 0 ? 0 : 1);
}

// --- 3. 多帧解码完整性 ---
process.stdout.write('\n3) 多帧 zstd 解码\n');
const { global: g } = summarize(scan);
check('识别到 zstd 帧', g.frames > 0, `${g.frames} 帧`);
check('解码出行', g.lines > 0, `${g.lines} 行`);
check('无坏帧', g.badFrames === 0, g.badFrames ? `${g.badFrames} 个坏帧` : '');
check('无坏行', g.badLines === 0, g.badLines ? `${g.badLines} 行无法解析` : '');
check(
  '每会话平均行数 > 1（验证未只解首帧）',
  g.lines / scan.sessions.length > 1,
  `平均 ${(g.lines / scan.sessions.length).toFixed(1)} 行/会话`,
);

// --- 4. 事件模型字段 ---
process.stdout.write('\n4) 统一事件模型\n');
const allEvents = scan.sessions.flatMap((s) => s.events);
const kinds = new Set(allEvents.map((e) => e.kind));
check('存在 tool_call 事件', kinds.has(KIND.TOOL_CALL));
check('存在 assistant_msg 事件', kinds.has(KIND.ASSISTANT_MSG));

const toolCalls = allEvents.filter((e) => e.kind === KIND.TOOL_CALL);
check(
  'tool_call 字段完整',
  toolCalls.every((e) => e.tool_name && e.tool_args_hash && e.locator),
  `${toolCalls.length} 条`,
);

const msgs = allEvents.filter((e) => e.kind === KIND.ASSISTANT_MSG);
check(
  'usage 字段已归一化（snake_case）',
  msgs.some((e) => typeof e.input_tokens === 'number' && typeof e.cache_read_tokens === 'number'),
);
check(
  '所有事件都带 locator',
  allEvents.every((e) => typeof e.locator === 'string' && e.locator.includes('#L')),
);

// --- 5. 行号可复现性 ---
process.stdout.write('\n5) 证据可复现性\n');
let reproducible = 0;
let mismatched = 0;
for (const s of scan.sessions) {
  const ev = s.events.find((e) => e.kind === KIND.TOOL_CALL);
  if (!ev) continue;
  const line = Number(ev.locator.slice(ev.locator.lastIndexOf('#L') + 2));
  try {
    const r = readRange(s.file, line, 0);
    if (r.totalLines === s.totalLines && r.lines[0].no === line) reproducible += 1;
    else mismatched += 1;
  } catch {
    mismatched += 1;
  }
}
check('show 行号与 scan 一致', mismatched === 0, `可复现 ${reproducible} / 不一致 ${mismatched}`);
check('至少验证了一个会话', reproducible > 0);

// --- 6. 只读 ---
process.stdout.write('\n6) 只读保证\n');
const before = scan.sessions.map((s) => {
  const st = fs.statSync(s.file);
  return `${s.file}|${st.size}|${st.mtimeMs}`;
});
const rescan = scanSessions({});
const after = rescan.sessions.map((s) => {
  const st = fs.statSync(s.file);
  return `${s.file}|${st.size}|${st.mtimeMs}`;
});
const unchanged = before.every((b, i) => b === after[i]);
check('会话文件未被修改（size/mtime 不变）', unchanged);

// --- 7. 健壮性 ---
process.stdout.write('\n7) 健壮性\n');
const { decodeFrames } = await import('../src/adapters/zstd-frames.mjs');
let noThrow = true;
try {
  decodeFrames(Buffer.from('not a zstd file at all'));
} catch {
  noThrow = false;
}
check('非 zstd 输入不抛异常（按明文处理）', noThrow);

// --- 8. DSH 插件契约 ---
process.stdout.write('\n8) DSH 插件契约\n');
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
} catch (e) {
  check('package.json 可解析', false, e.message);
}
if (pkg) {
  check('package.json 声明 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
  check('package.json 声明 main', typeof pkg.main === 'string' && pkg.main.length > 0, pkg.main);
  check(
    'cordis.patch.yml 存在',
    fs.existsSync(new URL('../cordis.patch.yml', import.meta.url)),
  );
}

let pluginOk = false;
let pluginDetail = '';
try {
  const m = await import('../plugin/index.js');
  pluginOk = typeof m.name === 'string' && typeof m.apply === 'function';
  pluginDetail = `name=${m.name} apply=${typeof m.apply}`;
} catch (e) {
  pluginDetail = e.message;
}
// 这正是 DSH 的冒烟测试判据：OK <name> function
check('插件导出 name + apply（DSH 冒烟测试判据）', pluginOk, pluginDetail);

if (pluginOk) {
  // 用模拟 ctx 验证 apply 不崩、且能注册工具
  const m = await import('../plugin/index.js');
  const registered = [];
  const toolCtx = { tools: { defineTool: (d) => d, register: (d) => registered.push(d) } };
  const ctx = { logger: { info() {} }, inject: (_deps, cb) => cb(toolCtx) };
  let applyThrew = false;
  try {
    m.apply(ctx, { contextLines: 2 });
  } catch {
    applyThrew = true;
  }
  check('apply() 不抛异常', !applyThrew);
  check('apply() 注册了工具', registered.length > 0, `${registered.length} 个`);
  const scanTool = registered.find((t) => t.name === 'agent_clinic_scan');
  check('注册了 agent_clinic_scan', Boolean(scanTool));
  if (scanTool) {
    let out = '';
    try {
      out = await scanTool.execute({});
    } catch (e) {
      out = `ERR:${e.message}`;
    }
    check('agent_clinic_scan 可执行', typeof out === 'string' && out.length > 0 && !out.startsWith('ERR:'));
  }
}

// --- 9. 诊断层 ---
process.stdout.write('\n9) 诊断层\n');
const { runDiagnostics, REGISTRY, SEVERITY } = await import('../src/diagnostics/index.mjs');

let diag = null;
try {
  diag = runDiagnostics({ scan, summary: summarize(scan) });
} catch (e) {
  check('runDiagnostics 可执行', false, e.message);
}

if (diag) {
  check('runDiagnostics 可执行', true, `发现 ${diag.findings.length} 个问题`);
  check(
    'findings 结构完整',
    diag.findings.every(
      (f) =>
        f.id &&
        f.title &&
        f.severity &&
        f.category &&
        f.summary &&
        Array.isArray(f.evidence) &&
        f.evidence.length > 0 &&
        f.evidence.every((e) => typeof e.locator === 'string' && e.locator.includes('#L')),
    ),
  );
  check(
    '每个 finding 都带可定位证据',
    diag.findings.every((f) => f.evidence.some((e) => e.locator.includes('#L'))),
  );
  check(
    '按严重度排序',
    diag.findings.every((f, i, a) => {
      if (i === 0) return true;
      const ord = { [SEVERITY.HIGH]: 0, [SEVERITY.MID]: 1, [SEVERITY.LOW]: 2 };
      return (ord[a[i - 1].severity] ?? 9) <= (ord[f.severity] ?? 9);
    }),
  );
  check(
    '未检测到异常的维度已显式记录',
    Array.isArray(diag.notDetected) && diag.notImplemented.length >= 0,
    `未异常 ${diag.notDetected.length} 项 / 未实现 ${diag.notImplemented.length} 项`,
  );
  check(
    '已实现指标与注册表一致',
    REGISTRY.filter((m) => m.implemented).every((m) => typeof m.detect === 'function'),
    `已实现 ${REGISTRY.filter((m) => m.implemented).map((m) => m.id).join('、')}`,
  );

  // 防误报：构造「参数有变化的 3 次失败」，必须不被 E1 判为死循环
  const fakeSession = {
    sessionId: 'smoke-e1-guard',
    events: [],
  };
  for (let i = 0; i < 3; i++) {
    const callId = `c${i}`;
    fakeSession.events.push({
      kind: KIND.TOOL_CALL,
      tool_name: 'fake_tool',
      tool_args_hash: `hash-${i}`, // 参数不同
      tool_call_id: callId,
      locator: `/fake/session.v4.jsonl.zstd#L${100 + i}`,
    });
    fakeSession.events.push({
      kind: KIND.TOOL_RESULT,
      tool_call_id: callId,
      is_error: true,
      locator: `/fake/session.v4.jsonl.zstd#L${100 + i}`,
    });
  }
  const guardDiag = runDiagnostics({
    scan: { sessions: [fakeSession] },
    summary: { global: {} },
  });
  check(
    'E1 不误报「参数有变化的试错」',
    !guardDiag.findings.some((f) => f.id === 'E1'),
  );
}

// --- 汇总 ---
process.stdout.write(`\n=====================\n通过 ${pass} · 失败 ${fail}\n`);
if (fail > 0) {
  process.stdout.write(`失败项：${failures.join('、')}\n`);
}
process.exit(fail === 0 ? 0 : 1);
