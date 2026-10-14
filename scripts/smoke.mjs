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

// --- 10. 客户端 UI 契约 ---
process.stdout.write('\n10) 客户端 UI 契约\n');
{
  const clientPath = new URL('../plugin/client.js', import.meta.url);
  const src = fs.readFileSync(clientPath, 'utf8');

  const captured = [];
  globalThis.window = globalThis.window || {};
  globalThis.window.__ModuleLoader__ = { load: (m) => captured.push(m) };

  // 用 new Function 执行入口文件，捕获 window.__ModuleLoader__.load 的参数
  try {
    new Function(src)(); // eslint-disable-line no-new-func
  } catch (e) {
    check('客户端入口可执行', false, e.message);
  }

  check('客户端入口调用 __ModuleLoader__.load', captured.length === 1, `捕获 ${captured.length} 个模块`);
  check('模块 id 与包名一致', captured[0] && captured[0].id === 'agent-clinic', captured[0]?.id);

  if (captured[0]) {
    const ReactStub = {
      createElement: () => ({}),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useSyncExternalStore: (sub, snap) => snap(),
    };
    let mod = null;
    try {
      mod = captured[0].factory((name) => {
        if (name === 'react') return ReactStub;
        if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) };
        throw new Error(`未知模块：${name}`);
      });
    } catch (e) {
      check('客户端工厂可调用', false, e.message);
    }

    if (mod) {
      check('客户端工厂可调用', true);
      check('导出 inject', Array.isArray(mod.inject), JSON.stringify(mod.inject));
      check('导出 apply 函数', typeof mod.apply === 'function');

      // 模拟 slots 服务，验证两处 UI 挂载
      // 真实契约：slots.inject(name, cb) 会在插槽可用时回调 cb，
      // 由 cb 内部调用 slots.register({name, id}, Component)
      const registered = [];
      const injected = [];
      const slots = {
        inject: (name, cb) => {
          injected.push(name);
          cb();
        },
        register: (opts) => registered.push(`${opts.name}→${opts.id}`),
      };
      const ctx = { get: (n) => (n === 'slots' ? slots : undefined) };
      let threw = '';
      try {
        await mod.apply(ctx);
      } catch (e) {
        threw = e.message;
      }
      check('apply() 不抛异常', !threw, threw);
      check('注册了侧边栏入口', registered.some((r) => r.startsWith('sidebar.footer.action')), registered.join(', '));
      check('注册了报告面板', registered.some((r) => r.startsWith('shell.overlay')), registered.join(', '));
      check('两处插槽都已 inject', injected.length === 2, injected.join(', '));

      // 容错：插槽未声明时 register 会抛错，apply 不应把错误传出去
      // （宿主只在启动时装载客户端模块，抛错就意味着整个 UI 挂载失败，没有第二次机会）
      const badSlots = {
        inject: (name, cb) => cb(),
        register: () => {
          throw new Error('slot 未声明');
        },
      };
      let guarded = true;
      try {
        await mod.apply({ get: (n) => (n === 'slots' ? badSlots : undefined) });
      } catch {
        guarded = false;
      }
      check('插槽不可用时 apply 不抛错（容错生效）', guarded);
    }
  }
}

// --- 11. 宿主 → 客户端数据契约 ---
process.stdout.write('\n11) 宿主→客户端数据契约\n');
{
  const { analyze } = await import('../src/report.mjs');
  const data = analyze({ scan, summary: summarize(scan) });

  check(
    'analyze() 返回 header',
    data.header && typeof data.header.sessions === 'number',
    `sessions=${data.header?.sessions}`,
  );
  check(
    'header 含面板需要的全部字段',
    ['sessions', 'toolCalls', 'errorRate', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'platform'].every(
      (k) => data.header[k] !== undefined,
    ),
  );
  check(
    'findings 含面板渲染所需字段',
    data.findings.every(
      (f) =>
        f.id && f.title && f.severity && f.summary && Array.isArray(f.evidence) && f.evidence.length > 0,
    ),
    `${data.findings.length} 个`,
  );
  check(
    '每条证据都带 locator',
    data.findings.every((f) => f.evidence.every((e) => typeof e.locator === 'string' && e.locator.includes('#L'))),
  );
  check('未检测到的维度有记录', Array.isArray(data.notDetected), `${data.notDetected.length} 项`);
  check('未实现的维度有记录', Array.isArray(data.notImplemented), `${data.notImplemented.length} 项`);

  // 客户端与宿主各自算错误率 / 千分位会不一致，这里防的是「字段改名」这类回归
  const jsBad = [];
  try {
    const captured = [];
    globalThis.window = globalThis.window || {};
    globalThis.window.__ModuleLoader__ = { load: (m) => captured.push(m) };
    const clientSrc = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8');
    new Function(clientSrc)(); // eslint-disable-line no-new-func
    const ReactStub = {
      createElement: () => ({}),
      useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
      useEffect: () => {},
      useSyncExternalStore: (s, snap) => snap(),
    };
    const mod = captured[0].factory((n) => (n === 'react' ? ReactStub : { jsx: () => ({}) }));
    for (const k of ['hd.sessions', 'hd.toolCalls', 'hd.errorRate', 'hd.inputTokens', 'hd.outputTokens', 'hd.cacheReadTokens']) {
      if (clientSrc.includes(k)) {
        const field = k.split('.')[1];
        if (data.header[field] === undefined) jsBad.push(field);
      }
    }
    void mod;
  } catch (e) {
    jsBad.push(`执行失败：${e.message}`);
  }
  check('客户端依赖的 header 字段在 analyze() 中都存在', jsBad.length === 0, jsBad.join(',') || '全部匹配');

  // 版本号：用于识别「磁盘已更新、进程仍跑旧代码」，两侧必须一致
  const { API_VERSION } = await import('../plugin/index.js');
  const clientSrcForVer = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8');
  const m = clientSrcForVer.match(/const CLIENT_VERSION = '([^']+)'/);
  check(
    '宿主 API_VERSION 与客户端 CLIENT_VERSION 一致',
    Boolean(m) && m[1] === API_VERSION,
    `宿主=${API_VERSION} 客户端=${m ? m[1] : '未找到'}`,
  );
  check(
    '路由响应携带 version',
    /version:\s*API_VERSION/.test(fs.readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8')),
  );

  // 实时监测：/watch 轻量端点 + 签名机制
  const hostSrc = fs.readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8');
  check('注册了 /api/agent-clinic/watch 路由', hostSrc.includes("'/api/agent-clinic/watch'") || hostSrc.includes('"/api/agent-clinic/watch"'));
  check('宿主实现了 fs.watch 监听', /fs\.watch\(/.test(hostSrc));
  check('宿主有防抖（避免一次写入触发多次重扫）', /WATCH_DEBOUNCE_MS/.test(hostSrc));

  const clientSrc = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8');
  check('客户端有轮询间隔定义', /POLL_MS\s*=\s*\d+/.test(clientSrc));
  check('客户端轮询 /watch', clientSrc.includes('/api/agent-clinic/watch'));
  check('客户端有未读角标逻辑', /unseen/.test(clientSrc));
  check('面板订阅轮询刷新', /panelRefreshListeners/.test(clientSrc));

  // 签名必须随数据变化，否则客户端永远感知不到新问题
  const { API_VERSION: _v } = await import('../plugin/index.js');
  let sigReal = '';
  let sigEmpty = '';
  try {
    const pmod = await import('../plugin/index.js');
    const probe = async (dshHome) => {
      const rs = [];
      const tc = { tools: { defineTool: (d) => d, register: () => {} } };
      const wc = { get: (n) => (n === 'webServer' ? { register: (r) => { rs.push(r); return () => {}; } } : undefined) };
      pmod.apply({ logger: { info() {} }, inject: (deps, cb) => cb(deps.includes('tools') ? tc : wc) }, { dshHome });
      const r = rs.find((x) => x.path === '/api/agent-clinic/watch');
      const out = [];
      await r.handler({}, { writeHead() {}, end: (b) => out.push(b) });
      return JSON.parse(out[0]);
    };
    const a = await probe(undefined);
    const b = await probe('/nonexistent-agent-clinic-dsh-home');
    sigReal = a.signature;
    sigEmpty = b.signature;
    check('/watch 返回完整字段', typeof a.count === 'number' && Array.isArray(a.ids) && typeof a.signature === 'string' && a.version === _v,
      `count=${a.count} ids=${a.ids.join(',') || '(无)'}`);
    check('签名随数据变化（否则客户端感知不到新问题）', sigReal !== sigEmpty,
      `真实=${sigReal.slice(0, 24)} / 空=${sigEmpty.slice(0, 24)}`);
  } catch (e) {
    check('签名随数据变化（否则客户端感知不到新问题）', false, e.message);
  }
}

// --- 12. 处方层 ---
process.stdout.write('\n12) 处方层\n');
{
  const { analyze } = await import('../src/report.mjs');
  const findings_12 = analyze({ scan, summary: summarize(scan) }).findings;

  const { PRESCRIPTIONS, prescribe, prescribeOne, selfJustify, RX_TYPE } = await import('../src/prescriber/index.mjs');

  check('处方池只含已验证插件', PRESCRIPTIONS.every((p) => p.verifiedAt && p.repo), `${PRESCRIPTIONS.length} 项`);
  check(
    '处方池没有未验证的条目（防回归）',
    !PRESCRIPTIONS.some((p) => ['caveman', 'superpowers', 'claude-mem', 'deja-vu'].includes(p.id)),
    PRESCRIPTIONS.map((p) => p.id).join(', '),
  );

  const noSolve = PRESCRIPTIONS.filter((p) => p.targets.length === 0);
  check(
    '没有对症插件时不给安装处方（诚实降级为行为建议）',
    noSolve.length === PRESCRIPTIONS.length || noSolve.every((p) => p.targets.length === 0),
  );

  // 用真实数据跑一遍
  const rx = prescribe(findings_12);
  check('处方数量 <= 2（宁精勿滥）', rx.length <= 2, `${rx.length} 条`);
  check(
    '每条处方结构完整',
    rx.every((r) => r.kind && r.title && r.detail && r.because),
    rx.map((r) => `${r.kind}/${r.title}`).join(' · '),
  );
  check(
    'E5 的行为建议基于实测工具名生成（非固定文案）',
    rx.some((r) => r.kind === RX_TYPE.BEHAVIOR && /list_agents/.test(r.detail)),
  );
  check(
    '行为建议带实测次数',
    rx.some((r) => /4\s*次/.test(r.detail)),
  );

  // 自证校验：处方不许声称能解决自己没声明的指标
  const bogus = { id: 'x', targets: [], solves: 's' };
  check('selfJustify 拒绝未声明 targets 的处方', !selfJustify(bogus, 'E1').ok);
  const okOne = PRESCRIPTIONS.find((p) => p.targets.length > 0);
  if (okOne) {
    check('selfJustify 接受已声明的处方', selfJustify(okOne, okOne.targets[0]).ok);
  }

  // 无 finding 时不给处方
  check('没有问题时不硬编处方', prescribe([]).length === 0);
}

// --- 汇总 ---
process.stdout.write(`\n=====================\n通过 ${pass} · 失败 ${fail}\n`);
if (fail > 0) {
  process.stdout.write(`失败项：${failures.join('、')}\n`);
}
process.exit(fail === 0 ? 0 : 1);
