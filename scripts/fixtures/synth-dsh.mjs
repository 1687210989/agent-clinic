#!/usr/bin/env node
/**
 * 合成 DSH_HOME 语料生成器
 * ============================================================================
 *
 * 目的：让 `scripts/smoke.mjs` 在**没有本机会话数据**的干净环境（CI runner）里
 * 也能跑完整自检 —— 事件模型、19 个已实现指标、处方层、面板与插件层。
 *
 * 语料是**完全合成**的：不含任何真实会话内容、不读 `~/.dsh`、不联网。
 * 确定性：固定时间戳（基准日 2026-07-01 / 2026-08-20）、无随机数 ——
 * 同一份代码每次生成字节级一致的文件。
 *
 * CLI：
 *   node scripts/fixtures/synth-dsh.mjs --out <dir>   生成到 <dir>/sessions/...（默认 .tmp/synth-home）
 *   node scripts/fixtures/synth-dsh.mjs --verify      生成到 .tmp/synth-verify + 跑诊断，
 *                                                    打印"每个指标命中几处"，任一为 0 则退出码 1
 *   node scripts/fixtures/synth-dsh.mjs --help
 *
 * 零第三方依赖（只用 node: 内置模块）。
 *
 * ---------------------------------------------------------------------------
 * 文件格式（依据 docs/data-formats.md，已实测确认）
 * ---------------------------------------------------------------------------
 *   <out>/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
 *   - 磁盘上是**多帧 zstd 拼接**（每帧一个独立 zstdCompressSync），每个文件 ≥3 帧
 *   - 第 1 行是 header，字段在**顶层**：{type:"session", version:4, id, createdAt, cwd, agentPreset}
 *     子代理会话另加 origin/delegationDepth/parentSession
 *   - 之后每行：{type, seq, time, data}，事件字段在 .data
 *   - usage 是 camelCase：inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/totalTokens
 *
 * ---------------------------------------------------------------------------
 * 指标 → 会话 对照表（这套语料就是按这张表构造的）
 * ---------------------------------------------------------------------------
 *   C1  token 消耗过快      c1a / c1b（各 10 条 assistant，单请求 output 5000，
 *                                        总量 50000 > 20000 门槛，是基线 150 的 33 倍）
 *   C2  上下文膨胀          c2a / c2b（10 条 assistant，input 1000 → 20000 = 20 倍，
 *                                        cacheRead 全 0 → 占比 0% < 30%）
 *   C3  长会话疲劳          c3a / c3b（205 条 user + 5 条 assistant = 210 > 200，且无压缩）
 *   C5  压缩可观测性        c5a（4 次 compaction/start + summary + prune）、
 *                            c5b（3 次 start + summary）
 *   C6  工具面成本          c6（2 个 request/header，工具 schema 各 ≈3.2 万字符；
 *                                注册 30 个工具，其中 22 个全窗口未调用）
 *   C7  上下文注入量        c7（30 次 agent/inbox/spliced，每次 ≈5000 字符 → ≈15 万字符）
 *   E1  死循环              e1a / e1b（同工具 + 同参数 + 同错误 ×3）
 *   E2  反复失败            e2a / e2b（12 次调用 / 5 次错误 = 41.7% > 30%）
 *   E3  工具结果过大        e3a / e3b（各 6 条 tool/result 文本 20000 字符 > 8192）
 *   E4  计划执行脱节        e4a / e4b（todo/write 3 条全 pending，之后 6 次工具调用）
 *   E5  冗余重复调用        e5a / e5b（同参数成功调用 list_agents ×4）
 *   N1  环境命令反复失败    e1a / e1b（pwsh 失败各 3 次；N1 不要求同参数）
 *   N2  高风险操作          n2（git reset --hard / rm -rf / chmod 777，各 1 次）
 *   N3  权限审批摩擦        n3（6 次 approval/asked + 6 次 decided，等待中位 120 秒）
 *   N4  API 重试频繁        n4（4 次 llm/retry，失败码 TRANSPORT）
 *   A2  skill 闲置          全局（窗口 2026-07-01 起 >30 天；语料只触发
 *                                   skill 工具 + {"name":"office-xlsx"}，
 *                                   「已装 skill」名单由语料自带目录
 *                                   <out>/agents-skills/demo-idle-skill 提供，
 *                                   该 skill 窗口内 0 次触发）
 *   A3  高频手动序列        a3a（web_search↔web_fetch 交替 ×6）、
 *                            a3b（image_ocr↔pdf_extract 交替 ×6）
 *   A4  子代理开销          a4（origin=subagent，3 条 assistant，各 40 万 total，
 *                                占全窗口 token ≈79% > 40%）
 *   A5  辅助 LLM 开销       a5（12 次 web/deepseek-search-llm-request +
 *                                10 次 session/title-llm-request = 22 ≥ 20）
 *
 * A2 的两个输入都不再取决于宿主机：
 *   1) 观察窗口天数 —— 来自语料（事件时间锚在固定基准日 2026-07-01，>30 天）；
 *   2) 「已装 skill」名单 —— 来自语料**自带的目录** <out>/agents-skills/
 *      （里面只有 demo-idle-skill 一个子目录）。
 * 名单是怎么被读到的：src/diagnostics/index.mjs 的 listInstalledSkills() 支持
 * 环境变量 `AGENT_CLINIC_SKILL_DIRS`（用平台路径分隔符分隔多个目录）——
 * 设了它就**只**扫这些目录，不再读 `$HOME/.agents/skills`、`$HOME/.workbuddy/skills`。
 *
 *   - `--verify` 会在跑诊断前自动把 AGENT_CLINIC_SKILL_DIRS 指向它自己刚生成的
 *     `<生成目录>/agents-skills`（确定性优先：不继承调用方的取值），
 *     于是 A2 必然命中 1 处，与跑测机器上装了什么无关。
 *   - `--out` 模式只负责把目录写出来，并把要设置的变量打印给你；
 *     要复现 A2，跑冒烟测试时把该变量指向同一目录即可：
 *       $env:AGENT_CLINIC_SKILL_DIRS = "<out>\agents-skills"
 *     不设时 listInstalledSkills 退回旧行为（读 HOME/USERPROFILE），
 *     此时 A2 是否命中取决于宿主机 —— 这属于调用方选择，不是语料的依赖。
 *
 * ⚠️ agents-skills/ 故意放在 `sessions/` **之外**，所以不会被会话扫描当成会话。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** zstd 帧 magic number：28 B5 2F FD */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 固定基准日（相对时间戳，绝不用 Date.now()，保证确定性） */
const T0 = Date.parse('2026-07-01T00:00:00.000Z'); // 首次会话 —— A2 的观察窗口起点
const T1 = Date.parse('2026-08-20T00:00:00.000Z'); // 第二个观察点

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const WORKSPACE_SLUG = '--C-work-synth--';
const CWD = 'C:\\work';
const SESSION_FILE = 'session.v4.jsonl.zstd';

/**
 * 语料自带的「已装 skill」目录（A2 的第二个输入）。
 *
 * 放在 <out>/agents-skills/，**不在 sessions/ 之下** —— 不会被会话扫描当成会话。
 * 里面只有一个 demo-idle-skill：名字既不是 agent-clinic（宿主机可能装着），
 * 也不是语料会触发的 office-xlsx，所以它必然是"窗口内 0 次触发"的闲置 skill。
 * 配合环境变量 AGENT_CLINIC_SKILL_DIRS 指向本目录，A2 的命中不再依赖宿主机。
 */
const SKILLS_DIRNAME = 'agents-skills';
const IDLE_SKILL_NAME = 'demo-idle-skill';

/**
 * 语料自带的 profile patch —— A1（MCP 闲置）的输入。
 *
 * A1 是**配置驱动**指标：先要知道"配了哪些 MCP 服务器"，再数 `mcp__<serverName>__*` 调用。
 * 语料里的会话没有任何 mcp 调用，所以"配了不用"这个最典型的场景可以确定性命中。
 * 由环境变量 AGENT_CLINIC_PROFILE_PATCH 指向本文件（干净 runner 上没有真实 profile）。
 */
const PATCH_FILENAME = 'cordis.patch.yml';
const CORPUS_PATCH = [
  '# 合成语料自带的 profile patch（A1 的输入）',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: demo-provider',
  '    model: demo-model',
  '- id: mcp-demo-files',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: demo-files',
  '    transport: stdio',
  '    command: /usr/bin/false',
  '    args:',
  '      - /tmp/never-used-mcp-server.js',
  '- id: mcp-demo-http',
  '  name: "@deepseek-ai/dsh-mcp-resources"',
  '  config:',
  '    serverName: demo-http',
  '    transport: streamable-http',
  '    url: http://127.0.0.1:9/mcp',
  '',
].join('\n');

const IDLE_SKILL_MD = [
  '---',
  `name: ${IDLE_SKILL_NAME}`,
  'description: 合成语料自带的"已装但 0 次触发" skill，用于让 A2 可确定性命中。',
  '---',
  '',
  '# demo-idle-skill',
  '',
  '这是 scripts/fixtures/synth-dsh.mjs 生成的占位 skill，不含任何真实内容。',
  '它被列在 agents-skills/ 里，且语料中没有任何 tool/call 触发它 ——',
  '因此 A2（skill 闲置）必然能对它出结论。',
  '',
].join('\n');

/** 本语料必须覆盖的 22 个已实现指标（A1 于 2026-10-15 实现后加入） */
export const METRIC_IDS = [
  'C1', 'C2', 'C3', 'C5', 'C6', 'C7',
  'E1', 'E2', 'E3', 'E4', 'E5',
  'N1', 'N2', 'N3', 'N4',
  'A1', 'A2', 'A3', 'A4', 'A5',
  // 决策 D4：K1/K2 从"未实现"变为已实现（本地加盐指纹），语料必须覆盖
  'K1', 'K2',
];

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DEFAULT_OUT = path.join('.tmp', 'synth-home');
const VERIFY_DIR = path.join(REPO_ROOT, '.tmp', 'synth-verify');

const ID = {
  c1a: '11111111-1111-4111-8111-000000000001',
  c1b: '11111111-1111-4111-8111-000000000002',
  c2a: '22222222-2222-4222-8222-000000000001',
  c2b: '22222222-2222-4222-8222-000000000002',
  c3a: '33333333-3333-4333-8333-000000000001',
  c3b: '33333333-3333-4333-8333-000000000002',
  c5a: '44444444-4444-4444-8444-000000000001',
  c5b: '44444444-4444-4444-8444-000000000002',
  c6: '55555555-5555-4555-8555-000000000001',
  c7: '66666666-6666-4666-8666-000000000001',
  e1a: '77777777-7777-4777-8777-000000000001',
  e1b: '77777777-7777-4777-8777-000000000002',
  e2a: '88888888-8888-4888-8888-000000000001',
  e2b: '88888888-8888-4888-8888-000000000002',
  e3a: '99999999-9999-4999-8999-000000000001',
  e3b: '99999999-9999-4999-8999-000000000002',
  e4a: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  e4b: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
  e5a: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  e5b: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
  n2: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  n3: 'dddddddd-dddd-4ddd-8ddd-000000000001',
  n4: 'eeeeeeee-eeee-4eee-8eee-000000000001',
  a3a: 'ffffffff-ffff-4fff-8fff-000000000001',
  a3b: 'ffffffff-ffff-4fff-8fff-000000000002',
  a5: 'abcdefab-cdef-4def-8def-000000000001',
  a4: 'abcdefab-cdef-4def-8def-000000000002',
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** DSH 的 usage 是 camelCase；totalTokens 与真实日志口径一致 = input + output */
const usage = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  totalTokens: inputTokens + outputTokens,
});

/** 重复串（确定性、无随机） */
const repeated = (s, n) => s.repeat(n);

// ---------------------------------------------------------------------------
// 会话构造器
// ---------------------------------------------------------------------------

function newSession(id, opts = {}) {
  return {
    id,
    cwd: opts.cwd ?? CWD,
    createdAt: opts.start ?? T0,
    origin: opts.origin ?? null,
    delegationDepth: opts.delegationDepth ?? null,
    parentSession: opts.parentSession ?? null,
    entries: [],
  };
}

/** 追加一条事件（seq 在序列化时按顺序分配） */
function ev(session, time, type, data) {
  session.entries.push({ type, time, data });
}

function user(session, time, text = '继续（合成语料）') {
  ev(session, time, 'user/message', {
    content: [{ type: 'text', text }],
    role: 'user',
    source: { kind: 'user' },
  });
}

function asst(session, time, opts = {}) {
  const { input = 1000, output = 100, cacheRead = 0, cacheWrite = 0, text = '继续。' } = opts;
  ev(session, time, 'assistant/message', {
    message: {
      content: [
        { type: 'reasoning', text: '（合成语料的思考块）' },
        { type: 'text', text },
      ],
    },
    usage: usage(input, output, cacheRead, cacheWrite),
  });
}

function call(session, time, name, args, callId) {
  ev(session, time, 'tool/call', {
    turn: 1,
    step: 1,
    callId,
    name,
    // ⚠️ 真实日志里 arguments 是 **JSON 字符串**（不是对象），哈希前要先 parse
    arguments: JSON.stringify(args),
  });
}

function result(session, time, callId, opts = {}) {
  const { text = 'ok', isError = false, error = null } = opts;
  const data = {
    turn: 1,
    step: 1,
    // tool/result 只有 callId，配对靠它；真实日志里在 message.source.callId
    message: { isError, source: { callId }, content: [{ type: 'text', text }] },
  };
  // 双重失败信号：data.error 或 data.message.isError（适配层两者都认）
  if (error) data.error = error;
  ev(session, time, 'tool/result', data);
}

/** 一条 tool/call + 对应的 tool/result */
function pair(session, time, name, args, callId, resultOpts) {
  call(session, time, name, args, callId);
  result(session, time + 500, callId, resultOpts);
}

// ---------------------------------------------------------------------------
// 语料：会话集合
// ---------------------------------------------------------------------------

/** C6 用的工具 schema 名单：已调用的 6 个 + 从未调用的 24 个（触发"未观察到调用"分支） */
const SCHEMA_TOOL_NAMES = [
  // 这些名字在本语料里都有 tool/call — 计算"未调用"时会被排除
  'read', 'edit', 'pwsh', 'grep', 'web_search', 'web_fetch',
  // 下面 24 个全窗口 0 调用 → C6 的 dead 分支（≥5 即可命中）
  'zz_dead_1', 'zz_dead_2', 'zz_dead_3', 'zz_dead_4', 'zz_dead_5', 'zz_dead_6',
  'filler_tool_01', 'filler_tool_02', 'filler_tool_03', 'filler_tool_04',
  'filler_tool_05', 'filler_tool_06', 'filler_tool_07', 'filler_tool_08',
  'filler_tool_09', 'filler_tool_10', 'filler_tool_11', 'filler_tool_12',
  'filler_tool_13', 'filler_tool_14', 'filler_tool_15', 'filler_tool_16',
  'filler_tool_17', 'filler_tool_18',
];

/** 构造一份"体量够大"的工具 schema（C6 阈值：中位 ≥ 20000 字符） */
function buildSchemaTools() {
  const tools = SCHEMA_TOOL_NAMES.map((name) => ({
    name,
    description: repeated('用于合成语料，覆盖 C6 工具面成本指标。', 40),
    parameters: {
      type: 'object',
      properties: {
        [`${name}_arg`]: { type: 'string', description: repeated('参数说明。', 40) },
      },
      required: [],
    },
  }));
  // 保险：确保 JSON 体量稳超阈值（确定性循环，不是随机）
  let guard = 0;
  while (JSON.stringify(tools).length < 30000 && guard < 1000) {
    tools[0].description += 'X';
    guard += 1;
  }
  return tools;
}

const SCHEMA_TOOLS = buildSchemaTools();

function buildSessions() {
  const sessions = [];
  const add = (s) => {
    sessions.push(s);
    return s;
  };

  // ------------------------------------------------------------------ C1 ×2
  const buildC1 = (n, id) => {
    const s = newSession(id, { start: T0 + n * 2 * HOUR });
    let t = s.createdAt;
    for (let i = 0; i < 10; i += 1) {
      user(s, t, `请继续第 ${i + 1} 步（合成语料：高消耗会话）`);
      asst(s, t + 1000, {
        input: 1000,
        output: 5000, // 单请求 output 是基线（150）的 33 倍；总量 50000
        text: repeated('这一段输出很长，用来把单位请求 output 抬到基线之上。', 30),
      });
      t += 5 * MIN;
    }
    return s;
  };
  add(buildC1(0, ID.c1a));
  add(buildC1(1, ID.c1b));

  // ------------------------------------------------------------------ C2 ×2
  const buildC2 = (n, id) => {
    const s = newSession(id, { start: T1 });
    const inputs = [1000, 2000, 3000, 4000, 5000, 6000, 8000, 12000, 16000, 20000];
    let t = s.createdAt;
    inputs.forEach((input) => {
      // cacheRead 全 0 → 缓存占比 0% < 30%，input 1000 → 20000 = 20 倍 > 10 倍
      asst(s, t, { input, output: 50, cacheRead: 0, text: '上下文持续增长。' });
      t += 30_000;
    });
    return s;
  };
  add(buildC2(0, ID.c2a));
  add(buildC2(1, ID.c2b));

  // ------------------------------------------------------------------ C3 ×2
  const buildC3 = (n, id) => {
    const s = newSession(id, { start: T1 + n * DAY });
    let t = s.createdAt;
    for (let i = 0; i < 205; i += 1) {
      user(s, t, `第 ${i + 1} 条输入（合成语料：长会话）`);
      t += 1000;
    }
    for (let i = 0; i < 5; i += 1) {
      asst(s, t, { input: 500, output: 100, text: '收到。' });
      t += 1000;
    }
    // 注意：C3 的语义是"没有压缩兜底" → 本会话**故意不含** compaction 事件
    return s;
  };
  add(buildC3(0, ID.c3a));
  add(buildC3(1, ID.c3b));

  // ------------------------------------------------------------------ C5 ×2
  const buildC5 = (n, id, starts) => {
    const s = newSession(id, { start: T1 + (10 + n) * DAY });
    let t = s.createdAt;
    user(s, t, '压缩会话（合成语料）');
    asst(s, t + 1000, { input: 2000, output: 200, text: '上下文触顶了，准备压缩。' });
    for (let i = 0; i < starts; i += 1) {
      ev(s, t + (i + 1) * MIN, 'compaction/start', {
        compactionId: `cp-${n}-${i}`,
        turn: i + 1,
      });
    }
    // compaction/summary：DSH 自报**实测**释放量 shadowedTokenCount
    ev(s, t + 10 * MIN, 'compaction/summary', {
      compactionId: `cp-${n}-0`,
      shadowedTokenCount: 53675 - n * 1000,
      shadowedSeqs: Array.from({ length: 40 }, (_, i) => i + 1),
      shadowedRange: { start: 5, end: 263 },
      summary: [{ type: 'text', text: repeated('压缩摘要正文（合成）。', 200) }],
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    });
    ev(s, t + 11 * MIN, 'compaction/prune', {
      compactionId: `cp-${n}-1`,
      shadowedTokenCount: n === 0 ? 2393 : 1100,
      shadowedSeqs: Array.from({ length: 20 }, (_, i) => i + 264),
      shadowedRange: { start: 264, end: 292 },
    });
    ev(s, t + 12 * MIN, 'compaction/end', { compactionId: `cp-${n}-0`, turn: 1 });
    return s;
  };
  add(buildC5(0, ID.c5a, 4)); // starts=4 ≥ 3 → 命中
  add(buildC5(1, ID.c5b, 3)); // starts=3 ≥ 3 → 命中

  // ------------------------------------------------------------------ C6 ×1
  {
    const s = newSession(ID.c6, { start: T1 + 5 * DAY });
    const t = s.createdAt;
    ev(s, t, 'turn/start', { turn: 1 });
    ev(s, t + 100, 'step/start', { turn: 1, step: 1 });
    // 工具 schema 随**每个**请求重发 —— 两个 header，中位体量 ≈3.2 万字符
    ev(s, t, 'request/header', {
      reason: 'initial',
      header: { tools: SCHEMA_TOOLS, config: { maxTokens: 64000 } },
    });
    ev(s, t + 60_000, 'request/header', {
      reason: 'tool-result',
      header: { tools: SCHEMA_TOOLS, config: { maxTokens: 64000 } },
    });
    user(s, t + 2000, '工具面成本会话（合成语料）');
    asst(s, t + 3000, { input: 8000, output: 300, text: '先读文件再改。' });
    pair(s, t + 4000, 'read', { file_path: 'src/a.mjs' }, 'c6-1', { text: '文件内容' });
    pair(s, t + 5000, 'edit', { file_path: 'src/a.mjs', old_string: 'a', new_string: 'b' }, 'c6-2', { text: 'ok' });
    pair(s, t + 6000, 'pwsh', { command: 'npm test' }, 'c6-3', { text: 'pass' });
    pair(s, t + 7000, 'grep', { pattern: 'foo' }, 'c6-4', { text: 'match' });
    // A2 相关：skill 触发**不是**同名工具调用，而是 `skill` 工具 + 参数 name。
    // 这里触发一个**非本机已装**的 skill（office-xlsx），好让已装的
    // agent-clinic 保持"0 次触发"，A2 才有结论可出。
    pair(s, t + 8000, 'skill', { name: 'office-xlsx' }, 'c6-5', { text: '已加载 skill：office-xlsx' });
    pair(s, t + 9000, 'web_search', { query: 'dsh plugin' }, 'c6-6', { text: '检索结果' });
    pair(s, t + 10_000, 'web_fetch', { url: 'https://example.invalid/doc' }, 'c6-7', { text: '页面正文' });
    ev(s, t + 11_000, 'session/title', { title: '合成语料 · 工具面成本', source: { kind: 'provider' } });
    ev(s, t + 12_000, 'workspace/changes', { files: ['src/a.mjs'] });
    ev(s, t + 13_000, 'approval/policy', { policy: 'ask' });
    add(s);
  }

  // ------------------------------------------------------------------ C7 ×1
  {
    const s = newSession(ID.c7, { start: T1 + 6 * DAY });
    const t = s.createdAt;
    user(s, t, '上下文注入会话（合成语料）');
    for (let i = 0; i < 30; i += 1) {
      // 30 次 × ≈5000 字符 → ≈15 万字符（阈值 20 次 / 100000 字符）
      ev(s, t + i * MIN, 'agent/inbox/spliced', {
        target: i % 2 ? 'next-turn' : 'current-turn',
        start: i,
        inserted: [{ type: 'text', text: repeated('Z', 5000) }],
      });
    }
    add(s);
  }

  // ------------------------------------------------------------------ E1 ×2（同时命中 N1）
  const buildE1 = (n, id, cmd) => {
    const s = newSession(id, { start: T1 + (20 + n) * DAY });
    const t = s.createdAt;
    user(s, t, '死循环会话（合成语料）');
    for (let i = 0; i < 3; i += 1) {
      // 同工具 + **同参数** + 同错误 ×3 → E1；命令类失败 ≥3 → N1
      pair(s, t + i * MIN, 'pwsh', { command: cmd }, `loop-${n}-${i}`, {
        text: 'Error: command failed',
        isError: true,
        error: { name: 'Error', code: 'EFAIL' },
      });
    }
    return s;
  };
  add(buildE1(0, ID.e1a, 'npm run build'));
  add(buildE1(1, ID.e1b, 'node scripts/missing.mjs'));

  // ------------------------------------------------------------------ E2 ×2
  const buildE2 = (n, id) => {
    const s = newSession(id, { start: T1 + (30 + n) * DAY });
    const t = s.createdAt;
    for (let i = 0; i < 12; i += 1) {
      const bad = i < 5; // 5/12 = 41.7% > 30%；参数各不相同，所以不会命中 E1
      pair(s, t + i * MIN, 'read', { file_path: `src/file-${n}-${i}.mjs` }, `e2-${n}-${i}`,
        bad ? { text: 'Error: 文件不存在', isError: true } : { text: '文件内容' });
    }
    return s;
  };
  add(buildE2(0, ID.e2a));
  add(buildE2(1, ID.e2b));

  // ------------------------------------------------------------------ E3 ×2
  const buildE3 = (n, id) => {
    const s = newSession(id, { start: T1 + (40 + n) * DAY });
    const t = s.createdAt;
    for (let i = 0; i < 6; i += 1) {
      // 单条结果 20000 字符 > 8192 阈值；每会话 6 条 ≥ 5 条
      pair(s, t + i * MIN, 'read', { file_path: `logs/big-${n}-${i}.log` }, `e3-${n}-${i}`, {
        text: repeated('L', 20000),
      });
    }
    return s;
  };
  add(buildE3(0, ID.e3a));
  add(buildE3(1, ID.e3b));

  // ------------------------------------------------------------------ E4 ×2
  const buildE4 = (n, id) => {
    const s = newSession(id, { start: T1 + (50 + n) * DAY });
    const t = s.createdAt;
    ev(s, t, 'todo/write', {
      todos: [
        { id: 't1', status: 'in_progress', text: '第一步' },
        { id: 't2', status: 'pending', text: '第二步' },
        { id: 't3', status: 'pending', text: '第三步' },
      ],
    });
    // 写完计划之后 ≥5 次工具调用，但一条都没标记完成 → E4
    for (let i = 0; i < 6; i += 1) {
      pair(s, t + (i + 1) * MIN, 'grep', { pattern: `pat-${n}-${i}` }, `e4-${n}-${i}`, { text: 'no match' });
    }
    return s;
  };
  add(buildE4(0, ID.e4a));
  add(buildE4(1, ID.e4b));

  // ------------------------------------------------------------------ E5 ×2
  const buildE5 = (n, id, args) => {
    const s = newSession(id, { start: T1 + (60 + n) * DAY });
    const t = s.createdAt;
    for (let i = 0; i < 4; i += 1) {
      // 同工具 + 同参数 + **无错误** ×4 → E5（重复 3 次即可命中）
      pair(s, t + i * MIN, 'list_agents', args, `e5-${n}-${i}`, { text: '[]' });
    }
    return s;
  };
  add(buildE5(0, ID.e5a, { scope: 'all' }));
  add(buildE5(1, ID.e5b, { scope: 'running' }));

  // ------------------------------------------------------------------ N2 ×1
  {
    const s = newSession(ID.n2, { start: T1 + 70 * DAY });
    const t = s.createdAt;
    const dangerous = [
      'git reset --hard HEAD~1',
      'rm -rf /tmp/synth-cache',
      'chmod 777 ./data',
    ];
    dangerous.forEach((cmd, i) => {
      // 高危模式只对**命令执行类工具**的 command 字段匹配
      pair(s, t + i * MIN, 'pwsh', { command: cmd }, `n2-${i}`, { text: 'ok' });
    });
    add(s);
  }

  // ------------------------------------------------------------------ N3 ×1
  {
    const s = newSession(ID.n3, { start: T1 + 80 * DAY });
    const t = s.createdAt;
    ev(s, t, 'approval/policy', { policy: 'ask' });
    const outcomes = ['allowed', 'denied', 'allowed', 'weird-value', 'denied', 'allow'];
    outcomes.forEach((outcome, i) => {
      const askedAt = t + (i + 1) * MIN;
      ev(s, askedAt, 'approval/asked', {
        id: `ap-${i}`,
        toolName: i % 2 ? 'pwsh' : 'write',
        reason: '需要审批（合成语料）',
      });
      // 等待 120 秒后决定 → 中位等待 120.0 秒
      ev(s, askedAt + 120_000, 'approval/decided', { id: `ap-${i}`, outcome });
    });
    add(s);
  }

  // ------------------------------------------------------------------ N4 ×1
  {
    const s = newSession(ID.n4, { start: T1 + 90 * DAY });
    const t = s.createdAt;
    for (let i = 0; i < 4; i += 1) {
      ev(s, t + i * 30_000, 'llm/retry', {
        retryId: `r-${i}`,
        provider: 'deepseek-account',
        mode: 'retry',
        retry: i + 1,
        maxRetries: 5,
        delayMs: 500,
        failure: { code: 'TRANSPORT' },
      });
    }
    add(s);
  }

  // ------------------------------------------------------------------ A3 ×2
  const buildA3 = (n, id, a, b) => {
    const s = newSession(id, { start: T1 + (100 + n) * DAY });
    const t = s.createdAt;
    for (let i = 0; i < 6; i += 1) {
      // 两端都**不是**通用读写/命令工具 → A3 才会认可这个"可固化序列"
      pair(s, t + i * 2 * MIN, a, { query: `${a}-${i}` }, `a3-${n}-a-${i}`, { text: 'ok' });
      pair(s, t + (i * 2 + 1) * MIN, b, { url: `https://example.invalid/${n}/${i}` }, `a3-${n}-b-${i}`, { text: 'ok' });
    }
    return s;
  };
  add(buildA3(0, ID.a3a, 'web_search', 'web_fetch'));
  add(buildA3(1, ID.a3b, 'image_ocr', 'pdf_extract'));

  // ------------------------------------------------------------------ A5 ×1
  {
    const s = newSession(ID.a5, { start: T1 + 110 * DAY });
    const t = s.createdAt;
    for (let i = 0; i < 12; i += 1) {
      ev(s, t + i * 2000, 'web/deepseek-search-llm-request', {
        body: {
          model: 'deepseek-v4-flash',
          max_tokens: 4096,
          messages: [{ role: 'user', content: '检索词（合成）' }],
        },
      });
    }
    for (let i = 0; i < 10; i += 1) {
      ev(s, t + i * 2000, 'session/title-llm-request', {
        route: { model: 'deepseek-v4-flash' },
        maxTokens: 64,
        messages: [{ role: 'user', content: '生成标题（合成）' }],
      });
    }
    add(s);
  }

  // ------------------------------------------------------------------ A4 ×1
  {
    const s = newSession(ID.a4, {
      start: T1 + 120 * DAY,
      origin: 'subagent',
      delegationDepth: 1,
      parentSession: ID.c1a,
    });
    const t = s.createdAt;
    for (let i = 0; i < 3; i += 1) {
      asst(s, t + i * MIN, {
        input: 200000,
        output: 200000, // 3 × 40 万 = 120 万，占全窗口 token 约 79% > 40%
        text: repeated('子代理产出。', 50),
      });
    }
    add(s);
  }

  // --- 决策 D4：K1/K2 的语料 ---
  // 同一段用户文本出现在 ≥3 个会话里（K1 跨会话失忆），
  // 并且**较晚的**会话在该消息之后又走进了排查（失败信号）→ K2 已解决重新排查。
  // 注意：文本要 ≥12 字符才会生成指纹（短文本被指纹层排除，这是防噪音的设计）。
  const K_REPEAT_TEXT = '同一个问题：为什么构建又失败了？我上次已经让你修过了（合成语料，用于验证 K1/K2 指纹）';
  sessions.slice(0, 3).forEach((s, i) => {
    const t = s.createdAt + 30 * MIN;
    user(s, t, K_REPEAT_TEXT);
    if (i > 0) {
      pair(s, t + 2 * MIN, 'pwsh', { command: 'npm run build' }, `kfail-${i}`, {
        isError: true,
        text: '构建失败（合成语料）',
        error: 'ExitCode=1',
      });
    }
  });

  return sessions;
}

// ---------------------------------------------------------------------------
// 序列化 + 多帧 zstd
// ---------------------------------------------------------------------------

function serializeSession(session) {
  const header = {
    type: 'session',
    version: 4,
    id: session.id,
    createdAt: session.createdAt,
    cwd: session.cwd,
    agentPreset: 'standard',
  };
  if (session.origin) {
    header.origin = session.origin;
    header.delegationDepth = session.delegationDepth ?? 1;
    if (session.parentSession) header.parentSession = session.parentSession;
  }
  const lines = [JSON.stringify(header)];
  session.entries.forEach((e, i) => {
    lines.push(JSON.stringify({ type: e.type, seq: i + 1, time: e.time, data: e.data }));
  });
  return lines;
}

/**
 * 把一个会话的多行 JSONL 编码成**多帧 zstd 拼接**（每帧 ≥ 3 帧）。
 * 每帧内都是完整行（以 \n 结尾），避免帧间粘连。
 */
function encodeFrames(lines) {
  const desired = Math.ceil(lines.length / 20);
  const frames = Math.min(Math.max(3, desired), Math.max(lines.length, 1));
  const per = Math.ceil(lines.length / frames);
  const parts = [];
  for (let i = 0; i < lines.length; i += per) {
    const chunk = `${lines.slice(i, i + per).join('\n')}\n`;
    parts.push(zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')));
  }
  return Buffer.concat(parts);
}

/** 生成器自带的解码器（只用于自检，与 src/adapters/zstd-frames.mjs 同口径） */
function decodeFrames(buf) {
  const offsets = [];
  let p = 0;
  for (;;) {
    const i = buf.indexOf(ZSTD_MAGIC, p);
    if (i < 0) break;
    offsets.push(i);
    p = i + ZSTD_MAGIC.length;
  }
  const parts = [];
  let badFrames = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      let s = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
      if (s && !s.endsWith('\n')) s += '\n';
      parts.push(s);
    } catch {
      badFrames += 1;
    }
  }
  return { frames: offsets.length, badFrames, text: parts.join('') };
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/**
 * 把语料写到 <outDir>/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd，
 * 并写出 <outDir>/agents-skills/<demo-idle-skill>/SKILL.md（A2 的"已装 skill"输入）。
 * @returns {{outDir:string, workspaceDir:string, skillsDir:string,
 *            sessions:Array<{id:string,file:string,lines:number,frames:number}>}}
 */
export function writeCorpus(outDir) {
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw new Error(`当前 Node ${process.version} 不支持原生 zstd 压缩（需要 >= 22.15.0）`);
  }
  const sessionsRoot = path.join(outDir, 'sessions');
  fs.rmSync(sessionsRoot, { recursive: true, force: true });
  const workspaceDir = path.join(sessionsRoot, WORKSPACE_SLUG);

  const written = [];
  for (const session of buildSessions()) {
    const lines = serializeSession(session);
    if (lines.length < 3) {
      throw new Error(`会话 ${session.id} 行数 ${lines.length} < 3，无法保证至少 3 帧`);
    }
    const buf = encodeFrames(lines);
    // 自检：解码回来必须逐行一致、无坏帧（多帧切片不得出现假 magic）
    const dec = decodeFrames(buf);
    if (dec.badFrames !== 0) throw new Error(`会话 ${session.id} 出现 ${dec.badFrames} 个坏帧`);
    const back = dec.text.split('\n');
    if (back.length && back[back.length - 1] === '') back.pop();
    if (back.length !== lines.length) {
      throw new Error(`会话 ${session.id} 往返行数不一致：${back.length} != ${lines.length}`);
    }
    if (back.some((l, i) => l !== lines[i])) {
      throw new Error(`会话 ${session.id} 往返内容不一致（多帧切片异常）`);
    }

    const dir = path.join(workspaceDir, session.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SESSION_FILE);
    fs.writeFileSync(file, buf);
    written.push({ id: session.id, file, lines: lines.length, frames: dec.frames });
  }

  // ---- 语料自带的「已装 skill」目录（A2 的第二个输入）----
  // 放在 sessions/ 之外，不会被会话扫描当成会话；由 AGENT_CLINIC_SKILL_DIRS 指过来。
  const skillsDir = path.join(outDir, SKILLS_DIRNAME);
  fs.rmSync(skillsDir, { recursive: true, force: true });
  const idleSkillDir = path.join(skillsDir, IDLE_SKILL_NAME);
  fs.mkdirSync(idleSkillDir, { recursive: true });
  fs.writeFileSync(path.join(idleSkillDir, 'SKILL.md'), IDLE_SKILL_MD, 'utf8');

  // ---- 语料自带的 profile patch（A1 的输入）----
  // A1 是**配置驱动**指标：要知道"配了哪些 MCP 服务器"。干净 runner 上没有 profile 目录，
  // 所以这里造一份 patch，由 AGENT_CLINIC_PROFILE_PATCH 指过来（与 A2 的 skill 目录同一套路）。
  // 语料里的会话**没有任何** mcp__* 调用 → A1 必然命中（这正是"配了不用"的真实场景）。
  const patchFile = path.join(outDir, PATCH_FILENAME);
  fs.writeFileSync(patchFile, CORPUS_PATCH, 'utf8');

  return { outDir, workspaceDir, skillsDir, patchFile, sessions: written };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `合成 DSH_HOME 语料生成器 —— 让冒烟测试在干净环境里也能跑完整自检

用法：
  node scripts/fixtures/synth-dsh.mjs --out <dir>    生成语料到 <dir>/sessions/...（默认 ${DEFAULT_OUT}）
  node scripts/fixtures/synth-dsh.mjs --verify       生成到临时目录 + 跑诊断，打印每个指标命中处数，
                                                     任一指标命中 < 1 处则退出码 1
  node scripts/fixtures/synth-dsh.mjs --help         显示本帮助

生成后跑完整自检（PowerShell）：
  $env:DSH_HOME = "<dir>"; $env:DSH_SMOKE_REQUIRE_DATA = "1"
  $env:AGENT_CLINIC_SKILL_DIRS = "<dir>/agents-skills"   # 让 A2 不依赖宿主机装了什么
  node scripts/smoke.mjs

A2 的输入：观察窗口天数来自语料，已装 skill 名单来自 <out>/agents-skills/
（由 AGENT_CLINIC_SKILL_DIRS 指向；不设该变量时才退回读 HOME/USERPROFILE）。
--verify 会自己把该变量指向本次生成的 agents-skills，无需调用方设置。

确定性：固定时间戳（基准日 2026-07-01 / 2026-08-20）、无随机数 —— 每次生成结果一致。
零第三方依赖；不读取、不修改任何真实 DSH 会话。`;

function parseArgs(argv) {
  const out = { mode: 'generate', out: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--verify') out.mode = 'verify';
    else if (a === '--out') {
      out.out = argv[i + 1];
      i += 1;
      if (!out.out) throw new Error('--out 需要一个目录参数');
    } else if (a.startsWith('--out=')) {
      out.out = a.slice('--out='.length);
    } else {
      throw new Error(`未知参数：${a}（用 --help 查看用法）`);
    }
  }
  return out;
}

function printGenerated(result) {
  const totalLines = result.sessions.reduce((n, s) => n + s.lines, 0);
  const totalFrames = result.sessions.reduce((n, s) => n + s.frames, 0);
  process.stdout.write(`已生成合成语料：${result.outDir}\n`);
  process.stdout.write(`  会话 ${result.sessions.length} 个 · 帧 ${totalFrames} 个 · 解码后 ${totalLines} 行\n`);
  process.stdout.write(`  路径：${result.workspaceDir}\\<session-id>\\${SESSION_FILE}\n`);
  process.stdout.write(`  已装 skill 目录（A2 用）：${result.skillsDir}\\${IDLE_SKILL_NAME}\n`);
  process.stdout.write(`\n跑完整自检（PowerShell）：\n`);
  process.stdout.write(`  $env:DSH_HOME = "${result.outDir}"; $env:DSH_SMOKE_REQUIRE_DATA = "1"\n`);
  process.stdout.write(`  $env:AGENT_CLINIC_SKILL_DIRS = "${result.skillsDir}"   # 让 A2 不依赖宿主机装了什么\n`);
  process.stdout.write(`  node scripts/smoke.mjs\n`);
}

async function runVerify() {
  fs.rmSync(VERIFY_DIR, { recursive: true, force: true });
  const result = writeCorpus(VERIFY_DIR);

  // A2 的「已装 skill」输入必须确定 —— 直接指向本次生成的 agents-skills，
  // 而不是继承调用方/宿主机的取值（确定性优先）。覆盖会打印在输出里。
  const inherited = process.env.AGENT_CLINIC_SKILL_DIRS ?? '';
  process.env.AGENT_CLINIC_SKILL_DIRS = result.skillsDir;
  // A1（MCP 闲置）同理：指向本次生成的 profile patch，不读宿主机的真实 profile
  const inheritedPatch = process.env.AGENT_CLINIC_PROFILE_PATCH ?? '';
  process.env.AGENT_CLINIC_PROFILE_PATCH = result.patchFile;

  const { scanSessions } = await import('../../src/adapters/dsh.mjs');
  const { summarize } = await import('../../src/summary.mjs');
  const { runDiagnostics } = await import('../../src/diagnostics/index.mjs');
  const { beginFingerprintRun } = await import('../../src/privacy/fingerprints.mjs');

  // 决策 D4：K1/K2 要指纹。**用一次性快照目录**，绝不碰用户真实的
  // ~/.agent-clinic/text-fingerprints.json（自检不该污染开发者的本机状态）。
  const fpStore = path.join(VERIFY_DIR, 'fingerprints.json');
  const fp = beginFingerprintRun({ path: fpStore });
  // 顺序：beginFingerprintRun 必须在 scanSessions 之前（适配层解析时算哈希）
  const scan = scanSessions({ dshHome: VERIFY_DIR });
  const summary = summarize(scan);
  const diag = runDiagnostics({ scan, summary }, fp.diagnosticOpts(scan));
  fp.finish(scan);

  const counts = new Map(METRIC_IDS.map((id) => [id, 0]));
  for (const f of diag.findings) {
    if (counts.has(f.id)) counts.set(f.id, counts.get(f.id) + 1);
  }

  const badFrames = summary.global?.badFrames ?? 0;
  process.stdout.write(`合成语料自检：${VERIFY_DIR}\n`);
  process.stdout.write(
    `会话 ${scan.sessions.length} · 帧 ${summary.global?.frames ?? 0} · 行 ${summary.global?.lines ?? 0}` +
      ` · 坏帧 ${badFrames} · 解析失败 ${scan.errors.length}\n`,
  );
  process.stdout.write(
    `已装 skill 目录：${process.env.AGENT_CLINIC_SKILL_DIRS}` +
      `（含 ${IDLE_SKILL_NAME}）` +
      (inherited && inherited !== result.skillsDir
        ? `；已覆盖调用方传入的 AGENT_CLINIC_SKILL_DIRS=${inherited}`
        : '') +
      '\n\n',
  );

  process.stdout.write('指标  命中处数\n');
  const zero = [];
  for (const id of METRIC_IDS) {
    const n = counts.get(id);
    process.stdout.write(`${id.padEnd(6)}${n}\n`);
    if (n < 1) zero.push(id);
  }

  const hit = METRIC_IDS.length - zero.length;
  process.stdout.write(`\n命中 ${hit}/${METRIC_IDS.length} 个指标（会话 ${scan.sessions.length} 个）\n`);

  if (zero.length) {
    process.stdout.write(`\n命中 0 处的指标：${zero.join('、')}\n`);
    for (const id of zero) {
      const nd = diag.notDetected.find((x) => x.id === id);
      process.stdout.write(`  ${id}${nd?.note ? `：${nd.note}` : '（无说明）'}\n`);
    }
  }

  return zero.length === 0 ? 0 : 1;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (args.mode === 'verify') {
    process.exitCode = await runVerify();
    return;
  }

  const outDir = path.resolve(process.cwd(), args.out ?? DEFAULT_OUT);
  printGenerated(writeCorpus(outDir));
}

// ---------------------------------------------------------------------------
// 只在**直接执行**时跑 CLI —— 被 import 时绝不能有副作用
// ---------------------------------------------------------------------------
//
// ⚠️ 这里踩过一次真坑（自查时抓到的，症状很隐蔽）：
//    原来写的是裸 `await main()`，于是 smoke 里 `import { writeCorpus }` 会**顺带执行 CLI**，
//    以 DEFAULT_OUT（.tmp/synth-home）为目标重新生成语料 —— 那正是许多人跑 smoke 时
//    用 DSH_HOME 指向的目录。结果：smoke 跑到一半，语料被删了又写回来，
//    于是出现间歇性假红（"扫描没有新增/删除任何会话文件 1 → 0"、
//    "ENOENT: 打不开某一个 session 文件"、断言总数在 288/303 之间跳）。
//    守卫写成"入口文件路径 == 本文件路径"；用 fileURLToPath 比较，跨平台可靠。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
