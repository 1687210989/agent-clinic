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
  const analysis = analyze({ scan, summary: summarize(scan) });
  const findings_12 = analysis.findings;

  const {
    PRESCRIPTIONS,
    prescribe,
    prescribeOne,
    tokenInventory,
    selfJustify,
    REMEDY_KIND,
    VERIFIED_BUT_UNTARGETED,
  } = await import('../src/prescriber/index.mjs');
  const { REMEDIES } = await import('../src/prescriber/remedies.mjs');
  const { REGISTRY } = await import('../src/diagnostics/index.mjs');

  check('处方池只含已验证插件', PRESCRIPTIONS.every((p) => p.verifiedAt && p.repo), `${PRESCRIPTIONS.length} 项`);
  check(
    '处方池没有未验证的条目（防回归）',
    !PRESCRIPTIONS.some((p) => ['caveman', 'superpowers', 'claude-mem', 'deja-vu'].includes(p.id)),
    PRESCRIPTIONS.map((p) => p.id).join(', '),
  );
  const { PLUGIN_CATALOG, matchPlugins, scanInstalledPlugins, CAPABILITY_BY_METRIC } = await import(
    '../src/catalog/index.mjs'
  );
  const { buildCatalogPrescription } = await import('../src/prescriber/index.mjs');
  check(
    '插件目录条目都带核实出处与仓库地址',
    PLUGIN_CATALOG.every((p) => p.source?.verifiedAt && p.repo && p.source?.via),
    `${PLUGIN_CATALOG.length} 条`,
  );
  check(
    '不对症的插件不会被硬塞进指标处方（按能力检索，不按人情）',
    matchPlugins(
      { id: 'C1', title: 'token 消耗过快', summary: '本会话 output 是自身基线的 7 倍', category: 'C' },
      { installed: [] },
    ).every((h) => h.entry.id !== 'modsearch'),
  );
  check(
    '检索能把"省 token"的插件召回给成本类问题（用户点名要的场景）',
    matchPlugins(
      { id: 'C1', title: 'token 消耗过快', summary: '本会话 output 是自身基线的 7 倍', category: 'C' },
      { installed: [] },
    ).some((h) => ['billion-context-dsh', 'smart-compaction'].includes(h.entry.id)),
    'billion-context-dsh / smart-compaction',
  );
  check(
    '每条命中都给出可读的命中原因（不做黑盒推荐）',
    matchPlugins(
      { id: 'C2', title: '上下文膨胀', summary: 'input 从首轮涨到末轮 14 倍', category: 'C' },
      { installed: [] },
    ).every((h) => Array.isArray(h.reasons) && h.reasons.length > 0),
  );
  check(
    '已安装的插件不推"安装"，改推"确认启用"',
    (() => {
      const hit = matchPlugins(
        { id: 'C2', title: '上下文膨胀', summary: 'input 膨胀', category: 'C' },
        { installed: ['smart-compaction'] },
      ).find((h) => h.entry.id === 'smart-compaction');
      if (!hit) return false;
      const rx = buildCatalogPrescription(
        hit,
        { id: 'C2', title: '上下文膨胀', summary: 'input 膨胀', evidence: [] },
        { config: null },
      );
      return rx.installed === true && rx.steps.every((s) => !/打开侧边栏 → 插件 → 添加插件/.test(s));
    })(),
  );
  check(
    '能力表覆盖所有已实现指标（检索不会漏掉某个指标）',
    REGISTRY.filter((m) => m.implemented).every(
      (m) => (CAPABILITY_BY_METRIC[m.id]?.length ?? 0) > 0 || Boolean(CAPABILITY_BY_METRIC._category[m.category]),
    ),
  );
  const localScan = scanInstalledPlugins();
  check(
    '只读扫描本地插件目录不抛异常',
    Array.isArray(localScan.installed),
    `发现 ${localScan.installed.length} 个包${localScan.error ? `（${localScan.error}）` : ''}`,
  );

  // 核心回归：每条处方必须有真靶子。
  // 2026-10-15 的真实事故就是所有插件 targets=[]，插件分支永远不触发。
  check(
    '每条处方都有对症指标（不再有空靶）',
    REMEDIES.every((r) => Array.isArray(r.targets) && r.targets.length > 0),
    REMEDIES.filter((r) => !r.targets?.length).map((r) => r.id).join(', ') || '全部有靶',
  );
  check(
    '每条处方都可自证（targets + solves + 出处）',
    REMEDIES.every((r) => selfJustify(r, r.targets[0]).ok),
    REMEDIES.filter((r) => !selfJustify(r, r.targets[0]).ok).map((r) => r.id).join(', ') || '全部自证通过',
  );
  check(
    '每条处方都写了风险与验证方式（不给"试了也不知道有没有用"的建议）',
    REMEDIES.every((r) => r.risk && r.verify),
    REMEDIES.filter((r) => !r.risk || !r.verify).map((r) => r.id).join(', ') || '全部具备',
  );
  check(
    '成本类指标（C1/C2/C3）都有"可执行"处方，不只是行为建议',
    ['C1', 'C2', 'C3'].every((id) =>
      REMEDIES.some((r) => r.targets.includes(id) && r.kind !== REMEDY_KIND.BEHAVIOR),
    ),
    ['C1', 'C2', 'C3']
      .filter((id) => !REMEDIES.some((r) => r.targets.includes(id) && r.kind !== REMEDY_KIND.BEHAVIOR))
      .join(', ') || '全部具备',
  );
  check(
    '每个已实现指标都至少有一条对症处方',
    REGISTRY.filter((m) => m.implemented).every((m) => REMEDIES.some((r) => r.targets.includes(m.id))),
    REGISTRY.filter((m) => m.implemented && !REMEDIES.some((r) => r.targets.includes(m.id)))
      .map((m) => m.id)
      .join(', ') || '全覆盖',
  );

  // 配置类处方必须给出可粘贴的 YAML（含 id / name / config 三要素）
  const cfgRx = prescribe([{ id: 'C2', summary: '合成样本', evidence: [] }], {
    ctx: { config: null, summary: { global: {} } },
  });
  const spill = cfgRx.find((r) => r.targetId === 'spill-tighten');
  check(
    'C2 能拿到省 input 的配置处方',
    Boolean(spill),
    cfgRx.map((r) => r.targetId).join(', ') || '（空）',
  );
  check(
    '配置处方含可整段粘贴的 YAML（id + name + config）',
    Boolean(spill) &&
      /^- id: spill-policy$/m.test(spill.command) &&
      /name: '@deepseek-ai\/dsh-spill-policy'/.test(spill.command) &&
      /maxInlineTokens: 6000/.test(spill.command),
    spill ? spill.command.split('\n')[0] : '(无)',
  );
  check(
    '配置处方会说明"当前值 → 建议值"',
    Boolean(spill) && /当前：/.test(spill.detail) && /建议：/.test(spill.detail),
    spill ? spill.detail.split('\n')[1] : '(无)',
  );

  // 用户反馈：卡片只给结论、不知道该干什么 → 每条处方都必须能"展开成步骤"
  const { readEffectiveConfig: readCfg } = await import('../src/config/index.mjs');
  const synth = { config: readCfg({ HOME: '/nonexistent-home', USERPROFILE: '/nonexistent-home' }), summary: { global: { byTool: { web_fetch: 12 } } } };
  const allRx = REMEDIES.flatMap((r) =>
    prescribeOne(
      { id: r.targets[0], tool: 'list_agents', repeatCount: 4, summary: '合成样本', evidence: [] },
      { ctx: synth },
    ),
  );
  check(
    '每条处方都有分步操作指引（展开即照着做）',
    allRx.length > 0 && allRx.every((r) => Array.isArray(r.steps) && r.steps.length >= 3),
    allRx.filter((r) => !r.steps || r.steps.length < 3).map((r) => r.targetId).join(', ') ||
      `${allRx.length} 条均有步骤`,
  );
  check(
    '每条处方都有收起态摘要（一行说明白）',
    allRx.every((r) => typeof r.brief === 'string' && r.brief.trim().length > 0),
  );
  const cfgSteps = (allRx.find((r) => r.targetId === 'spill-tighten') || {}).steps || [];
  check(
    '配置处方的步骤带真实文件路径与"整段替换"提醒',
    cfgSteps.length >= 4 &&
      cfgSteps.some((s) => /cordis\.patch\.yml/.test(s)) &&
      cfgSteps.some((s) => /整段替换/.test(s)),
    cfgSteps[0] ? cfgSteps[0].slice(0, 56) : '(无)',
  );
  const plugSteps = (allRx.find((r) => r.targetId === 'catalog-smart-compaction') || {}).steps || [];
  check(
    '插件处方的步骤写明界面入口与"完全重启"',
    plugSteps.some((s) => /插件 → 添加插件/.test(s)) && plugSteps.some((s) => /完全退出/.test(s)),
    `${plugSteps.length} 步`,
  );
  check(
    '行为处方的步骤是具体动作而非结论',
    ((allRx.find((r) => r.targetId === 'behavior-solidify-sequence') || {}).steps || []).some((s) =>
      /SKILL\.md|\.agents\/skills/.test(s),
    ) === true,
  );

  // 用真实数据跑一遍
  const rx = prescribe(findings_12, { ctx: { config: analysis.config ? { rows: {} } : null } });
  check('处方数量 <= 4（仍不放任刷屏）', rx.length <= 4, `${rx.length} 条`);
  check(
    '每条处方结构完整',
    rx.every((r) => r.kind && r.kindLabel && r.title && r.detail && r.because),
    rx.map((r) => `${r.kind}/${r.title}`).join(' · '),
  );
  check(
    'E5 的行为建议基于实测工具名生成（非固定文案）',
    prescribeOne({ id: 'E5', tool: 'list_agents', repeatCount: 4, summary: '合成本' }, {
      ctx: { config: null, summary: { global: {} } },
    }).some((r) => r.kind === REMEDY_KIND.BEHAVIOR && /list_agents/.test(r.detail)),
  );
  check(
    '行为建议带实测次数',
    prescribeOne({ id: 'E5', tool: 'list_agents', repeatCount: 4, summary: '合成本' }, {
      ctx: { config: null, summary: { global: {} } },
    }).some((r) => /4\s*次/.test(r.detail)),
  );

  // 自我否决：推理强度已经是最低档时，不许再建议"调低"
  const { readEffectiveConfig } = await import('../src/config/index.mjs');
  const snap = readEffectiveConfig({ HOME: '/nonexistent-home', USERPROFILE: '/nonexistent-home' });
  const c1 = prescribeOne(
    { id: 'C1', summary: '合成样本', evidence: [] },
    { ctx: { config: null, summary: { global: {} } } },
  );
  check('C1 在没有配置快照时仍有可用处方', c1.length > 0, c1.map((r) => r.targetId).join(', '));
  const c1Real = prescribeOne(
    { id: 'C1', summary: '合成样本', evidence: [] },
    { ctx: { config: snap, summary: { global: {} } } },
  );
  check(
    '推理强度已是最低档时不给"再调低"的空建议',
    !c1Real.some((r) => r.targetId === 'reasoning-effort') ||
      snap.rows['agent-default-model'].config.reasoningEffort !== 'low',
    `reasoningEffort=${snap.rows['agent-default-model'].config.reasoningEffort}`,
  );

  // 省 token 开关清单：必须包含配置与插件两类，且带当前值
  const levers = tokenInventory({ ctx: { config: null } });
  check(
    '省 token 开关清单覆盖配置与插件',
    levers.some((l) => l.kind === REMEDY_KIND.CONFIG) && levers.some((l) => l.kind === REMEDY_KIND.PLUGIN),
    levers.map((l) => l.id).join(', '),
  );
  check(
    '清单里的插件都带安装入口与出处',
    levers
      .filter((l) => l.kind === REMEDY_KIND.PLUGIN)
      .every((l) => (l.install?.gui || l.install?.cli) && l.source),
  );

  // 自证校验：处方不许声称能解决自己没声明的指标
  const bogus = { id: 'x', targets: [], solves: 's', source: { package: 'p' } };
  check('selfJustify 拒绝未声明 targets 的处方', !selfJustify(bogus, 'E1').ok);
  const okOne = REMEDIES.find((p) => p.targets.length > 0);
  check('selfJustify 接受已声明的处方', selfJustify(okOne, okOne.targets[0]).ok);
  check(
    'selfJustify 拒绝没有出处的处方',
    !selfJustify({ id: 'y', targets: ['E1'], solves: 's' }, 'E1').ok,
  );

  // 无 finding 时不给处方
  check('没有问题时不硬编处方', prescribe([]).length === 0);
}

// --- 12b. 配置探测层 ---
process.stdout.write('\n12b) 配置探测层（只读）\n');
{
  const { parsePatch, readEffectiveConfig, toPatchSnippet, resolveDshHome, SHIPPED_ROWS } = await import(
    '../src/config/index.mjs'
  );

  const sample = [
    '# 注释行',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: deepseek-account',
    '    model: deepseek-flash',
    '    reasoningEffort: low',
    '- id: spill-policy',
    "  name: '@deepseek-ai/dsh-spill-policy'",
    '  config:',
    '    maxInlineTokens: 8000',
  ].join('\n');
  const parsed = parsePatch(sample);
  check('能解析 profile patch 的行', parsed.rows.length === 2, parsed.rows.map((r) => r.id).join(', '));
  check(
    '能解析 config 里的标量（含字符串/数字）',
    parsed.rows[1].config.maxInlineTokens === 8000 &&
      parsed.rows[0].config.reasoningEffort === 'low' &&
      parsed.rows[0].config.provider === 'deepseek-account',
    JSON.stringify(parsed.rows[1].config),
  );
  check('解析不带警告', parsed.warnings.length === 0, parsed.warnings.join('; '));

  const listSample = [
    '- id: repeat-tool-reminder',
    "  name: '@deepseek-ai/dsh-repeat-tool-reminder'",
    '  config:',
    '    thresholds: [2, 3, 5]',
    '    argumentsPreviewChars: 500',
    '- id: tool-result-pruner',
    "  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '  config:',
    '    thresholdChars: 4096',
    '    headChars: 2048',
    '    tailChars: 512',
  ].join('\n');
  const listParsed = parsePatch(listSample);
  check(
    '能解析列表值 [2, 3, 5]',
    Array.isArray(listParsed.rows[0].config.thresholds) && listParsed.rows[0].config.thresholds.length === 3,
    JSON.stringify(listParsed.rows[0].config.thresholds),
  );
  check(
    'pruner 三个键都解析到',
    listParsed.rows[1].config.thresholdChars === 4096 &&
      listParsed.rows[1].config.headChars === 2048 &&
      listParsed.rows[1].config.tailChars === 512,
  );

  const snippet = toPatchSnippet('spill-policy', { maxInlineTokens: 6000 }, '@deepseek-ai/dsh-spill-policy');
  check(
    'YAML 片段可直接粘贴（id/name/config 三要素）',
    snippet.split('\n')[0] === '- id: spill-policy' && /config:\n {4}maxInlineTokens: 6000/.test(snippet),
    snippet.replace(/\n/g, ' ⏎ '),
  );

  check('能解析 DSH_HOME', resolveDshHome({ DSH_HOME: 'X:/dsh' }) === 'X:/dsh');
  check('DSH_HOME 缺失时回退到 HOME', resolveDshHome({ HOME: 'X:/home' }).endsWith('.dsh'));

  check(
    '随附默认值表都带 id / name / 说明',
    SHIPPED_ROWS.every((r) => r.id && r.name && r.note),
    `${SHIPPED_ROWS.length} 行`,
  );
  check(
    '随附默认值都用带 @scope 的包名（防止把插件短名当成包名）',
    SHIPPED_ROWS.every((r) => r.name.startsWith('@deepseek-ai/')),
  );

  // 空目录/不存在目录不得抛异常
  const empty = readEffectiveConfig({ HOME: 'X:/nonexistent-home', USERPROFILE: 'X:/nonexistent-home' });
  check('profile 不存在时不抛异常且标注来源', empty.patchExists === false && Object.keys(empty.rows).length > 0);
  check(
    '未覆盖的行标为 bundle-default',
    empty.rows['spill-policy'].source === 'bundle-default' &&
      empty.rows['spill-policy'].config.maxInlineTokens === 12500,
    JSON.stringify(empty.rows['spill-policy'].config),
  );
}


// --- 13. 全维度覆盖与误报防护 ---
process.stdout.write('\n13) 全维度覆盖与误报防护\n');
{
  const { REGISTRY, UNIMPLEMENTABLE, SEVERITY, runDiagnostics } = await import('../src/diagnostics/index.mjs');
  const validSeverities = new Set(Object.values(SEVERITY));

  const implemented = REGISTRY.filter((m) => m.implemented).map((m) => m.id);
  const pending = REGISTRY.filter((m) => !m.implemented).map((m) => m.id);
  check(
    '已实现指标齐全',
    ['C1', 'C2', 'C3', 'E1', 'E2', 'E4', 'E5', 'N1', 'N2', 'A2', 'A3', 'A4'].every((id) =>
      implemented.includes(id),
    ),
    `${implemented.length} 项`,
  );
  check('排期中的指标有记录', pending.length > 0, pending.join(','));
  check(
    '不可实现的 5 项全部显式列出',
    ['E3', 'K1', 'K2', 'N3', 'N4'].every((id) => UNIMPLEMENTABLE.some((u) => u.id === id)) &&
      UNIMPLEMENTABLE.every((u) => u.reason && u.reason.length > 5),
    `${UNIMPLEMENTABLE.length} 项`,
  );
  check(
    '每条不可实现都带原因',
    UNIMPLEMENTABLE.every((u) => typeof u.reason === 'string' && u.reason.trim()),
  );

  // 每个已实现指标必须跑通且返回结构合法（含不命中的）
  const rAll = runDiagnostics({ scan, summary: summarize(scan) });
  check(
    '所有 detect 均不抛异常',
    rAll.notDetected.every((d) => !String(d.note || '').startsWith('判定异常')),
    `异常项：${rAll.notDetected.filter((d) => String(d.note || '').startsWith('判定异常')).length}`,
  );
  check(
    'findings 都带合法严重度与摘要',
    rAll.findings.every((f) => validSeverities.has(f.severity) && typeof f.summary === 'string' && f.summary),
    `${rAll.findings.length} 条`,
  );
  check(
    '除全局型 finding 外都带证据定位',
    rAll.findings.every((f) => f.scope === null || (Array.isArray(f.evidence) && f.evidence.length > 0)),
    rAll.findings.map((f) => `${f.id}${f.evidence?.length ? '' : '(全局)'}`).join(' · '),
  );
}

// --- 汇总 ---
process.stdout.write(`\n=====================\n通过 ${pass} · 失败 ${fail}\n`);
if (fail > 0) {
  process.stdout.write(`失败项：${failures.join('、')}\n`);
}
process.exit(fail === 0 ? 0 : 1);
