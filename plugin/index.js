/**
 * agent-clinic 的 DeepSeek Harness 插件入口
 *
 * 本文件让同一个仓库**既能当 Skill 装，也能当 Plugin 装**：
 *   - Skill  路径：把仓库目录拷到 ~/.agents/skills/agent-clinic/
 *   - Plugin 路径：dsh plugin --profile <p> add -w <repo>
 *
 * 插件契约（对照真实插件 @shengsheng/dsh-taskboard 逆向确认）：
 *   - 导出 `name`（短名，字符串）
 *   - 导出 `Config`（schemastery schema）
 *   - 导出 `apply(ctx, config)` 函数
 *   - package.json 声明 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
 *
 * ⚠️ 本文件的对等依赖（@deepseek-ai/*）只在 DSH 运行环境内可解析，
 *    无法在本机独立验证。peer 一律用**动态导入 + 兜底**，保证：
 *      - 本地 `import()` 不报错（满足 DSH 的冒烟测试：name + apply）
 *      - DSH 内正常注册工具
 */

import fs from 'node:fs';
import { scanSessions, resolveSessionsRoot } from '../src/adapters/dsh.mjs';
import { summarize, topTools, num, pct } from '../src/summary.mjs';
import { hasZstdSupport } from '../src/adapters/zstd-frames.mjs';
import { renderEvidence } from '../src/evidence/index.mjs';
import { buildReport, analyze } from '../src/report.mjs';

/** 插件短名（cordis patch 里的 id / name 与之对应） */
export const name = 'agent-clinic';

/**
 * API 版本号，随宿主响应回传。
 *
 * 客户端用同一个常量（plugin/client.js 的 CLIENT_VERSION）比对，识别
 * 「插件文件已更新到磁盘、但 Harness 进程仍跑旧代码」的情况。
 * 插件只在启动时装载，更新后必须重启才生效；若不显式提示，
 * 用户只会看到面板内容没变，无法判断该做什么。
 * 改动 /api/agent-clinic/report 的响应结构时，两边一起 +1。
 */
export const API_VERSION = '4';

// ---------------------------------------------------------------------------
// Config：优先用 schemastery；本地无 peer 时退化为朴素描述，保证可导入
// ---------------------------------------------------------------------------
let z = null;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  z = null; // 本地无 DSH peer —— 仅在 DSH 环境内需要真正的 schema
}

export const Config = z
  ? z.object({
      dshHome: z.string(),
      maxSessions: z.natural().min(1).default(500),
      minRepeatCount: z.natural().min(2).default(3),
      contextLines: z.natural().min(0).max(20).default(2),
    })
  : {
      type: 'object',
      properties: {
        dshHome: { type: 'string' },
        maxSessions: { type: 'number', default: 500 },
        minRepeatCount: { type: 'number', default: 3 },
        contextLines: { type: 'number', default: 2 },
      },
    };

// ---------------------------------------------------------------------------
// 业务逻辑（与 CLI 共用同一套 src/ 实现，避免两份真相）
// ---------------------------------------------------------------------------

function runScan(opts = {}) {
  if (!hasZstdSupport()) {
    return [
      '运行环境不支持原生 zstd 解码，无法读取 DSH 会话文件。',
      `当前 Node 版本：${process.version}（需要 >= 22.15.0）`,
      '本工具不会静默跳过无法解码的数据。',
    ].join('\n');
  }

  const root = resolveSessionsRoot({ dshHome: opts.dshHome });
  const scan = scanSessions({ dshHome: opts.dshHome });
  const { global: g, perSession } = summarize(scan);

  if (scan.fileCount === 0) {
    return `未找到会话文件。\n扫描目录：${root}`;
  }

  const lines = [];
  lines.push(`扫描目录：${root}`);
  lines.push(`会话文件：${scan.fileCount}`);
  lines.push('');
  for (const s of perSession) {
    const id = String(s.sessionId).replace(/^session-/, '').slice(0, 12);
    lines.push(
      `  ${id}  帧=${s.frames} 行=${s.lines} 调用=${s.toolCalls} 错误=${s.errors}` +
        ` in=${num(s.inputTokens)} out=${num(s.outputTokens)}${s.title ? `  ${s.title}` : ''}`,
    );
  }
  lines.push('');
  lines.push('===== 合计 =====');
  lines.push(`会话=${g.sessions}  帧=${g.frames}  行=${g.lines}`);
  lines.push(`工具调用=${g.toolCalls}  错误=${g.errors}  错误率=${pct(g.errorRate)}`);
  lines.push(
    `input=${num(g.inputTokens)}  output=${num(g.outputTokens)}  ` +
      `cacheRead=${num(g.cacheReadTokens)}  cacheWrite=${num(g.cacheWriteTokens)}`,
  );
  lines.push(`cacheRead 占比=${pct(g.cacheReadShare)}`);
  const tt = topTools(g, 8);
  if (tt.length) lines.push(`TOP 工具：${tt.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (g.badFrames || g.badLines) {
    lines.push(`⚠ 数据完整性：坏帧 ${g.badFrames} / 坏行 ${g.badLines}`);
  }
  return lines.join('\n');
}

function runShow(locator, context = 2) {
  if (!locator) return '缺少参数：locator（形如 <file>#L<n>）';
  try {
    return renderEvidence(locator, { context });
  } catch (e) {
    return `无法展开证据：${e.message}`;
  }
}

function runReport(opts = {}) {
  if (!hasZstdSupport()) {
    return `运行环境不支持原生 zstd 解码（需要 Node >= 22.15，当前 ${process.version}）。`;
  }
  const scan = scanSessions({ dshHome: opts.dshHome });
  const summary = summarize(scan);
  return buildReport({ scan, summary });
}

/** 结构化体检结果（供客户端面板渲染卡片式 UI，避免解析 markdown 文本） */
function runAnalyze(opts = {}) {
  if (!hasZstdSupport()) {
    throw new Error(`运行环境不支持原生 zstd 解码（需要 Node >= 22.15，当前 ${process.version}）`);
  }
  const scan = scanSessions({ dshHome: opts.dshHome });
  const summary = summarize(scan);
  return analyze({ scan, summary });
}

// ---------------------------------------------------------------------------
// 实时监测：文件监听 + 轻量状态端点
//
// 现状：面板只有点「刷新」才重新扫描，用户在对话过程中看不到新出现的问题。
//
// 这里补上「准实时」：
//   1. fs.watch 盯 ~/.dsh/sessions（根目录 + 各会话目录）
//      —— DSH 每次工具调用都会追加写入会话文件，所以文件变化 ≈ 有新事件
//   2. 命中后把缓存标记为脏；/watch 端点只在脏时才真正重扫
//      （一次全量扫描约 130ms，不能每次轮询都跑）
//   3. 客户端每 6 秒轮询一次 /watch，签名变化才拉全量报告
//
// 不用 DSH 内部的 session/event 流，是因为那套 API 属于内部契约、
// 且 desktop profile 装不进去、本地无法验证；Node 的 fs API 足够且可测。
// ---------------------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 400;

const watchState = {
  dshHome: null,
  watchers: [],
  dirty: true,
  timer: null,
  // 缓存最近一次体检结论的「签名」——用于判断是否真的发生了变化
  signature: '',
  count: 0,
  ids: [],
  generatedAt: null,
};

function signatureOf(data) {
  return `${data.findings.length}|${data.findings
    .map((f) => `${f.id}:${f.scope || ''}`)
    .join(',')}|${data.header.sessions}|${data.header.toolCalls}`;
}

function refreshState(dshHome) {
  const data = runAnalyze({ dshHome });
  watchState.signature = signatureOf(data);
  watchState.count = data.findings.length;
  watchState.ids = data.findings.map((f) => f.id);
  watchState.generatedAt = new Date().toISOString();
  return data;
}

/** 轻量状态：签名变了客户端才去拉全量报告，所以要保证它足够便宜 */
function currentState(dshHome) {
  if (watchState.dirty || watchState.signature === '') {
    refreshState(dshHome);
    watchState.dirty = false;
  }
  return {
    ok: true,
    version: API_VERSION,
    count: watchState.count,
    ids: watchState.ids,
    signature: watchState.signature,
    generatedAt: watchState.generatedAt,
  };
}

function markDirty() {
  watchState.dirty = true;
  if (watchState.timer) return;
  // 防抖：一次工具调用可能触发多个文件事件，短时间内的重复通知无意义
  watchState.timer = setTimeout(() => {
    watchState.timer = null;
  }, WATCH_DEBOUNCE_MS);
}

function stopWatching() {
  for (const w of watchState.watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  watchState.watchers = [];
  if (watchState.timer) {
    clearTimeout(watchState.timer);
    watchState.timer = null;
  }
}

/** 监听会话目录。fs.watch 在 Windows 上对递归不可靠，因此逐目录监听。 */
function startWatching(dshHome) {
  stopWatching();
  const root = resolveSessionsRoot({ dshHome });
  if (!root) return;

  const watchDir = (dir) => {
    let w;
    try {
      w = fs.watch(dir, { persistent: false }, markDirty);
    } catch {
      return; // 目录不存在或无权限：跳过，不影响其他功能
    }
    w.on('error', () => {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    });
    watchState.watchers.push(w);
  };

  watchDir(root);
  // 会话子目录（DSH 按 workspace-slug/<session-id>/ 组织）
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        watchDir(joinPath(root, entry.name));
        // 再下一层才是 session.v4.jsonl.zstd 所在
        try {
          for (const sub of fs.readdirSync(joinPath(root, entry.name), { withFileTypes: true })) {
            if (sub.isDirectory()) watchDir(joinPath(root, entry.name, sub.name));
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function joinPath(...parts) {
  return parts.join('\\');
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 挂载 agent-clinic：向 Harness 注册两个模型可见工具。
 * @param {object} ctx    cordis 上下文
 * @param {object} config 由 Config schema 校验后的配置
 */
export function apply(ctx, config = {}) {
  const log = (m) => {
    try {
      ctx?.logger?.info?.(`[agent-clinic] ${m}`);
    } catch {
      /* 日志失败不影响功能 */
    }
  };

  // 应用户要求补上「准实时」：监听会话文件变化，面板轮询 /watch 即可发现新问题
  watchState.dshHome = config.dshHome ?? null;
  watchState.dirty = true;
  try {
    startWatching(config.dshHome);
    log(`已开始监听会话目录：${resolveSessionsRoot({ dshHome: config.dshHome }) ?? '(未找到)'}`);
  } catch (e) {
    log(`监听启动失败（不影响其他功能）：${e?.message ?? e}`);
  }

  log('已加载');

  ctx.inject(['tools'], (toolCtx) => {
    let defineTool;
    try {
      // 动态取，避免本地无 peer 时模块导入失败
      ({ defineTool } = toolCtx.tools?.defineTool ? toolCtx.tools : {});
    } catch {
      defineTool = undefined;
    }

    // 若 Harness 未在 ctx.tools 上暴露 defineTool，则退回静态导入路径
    if (typeof defineTool !== 'function') {
      log('ctx.tools.defineTool 不可用，跳过工具注册（请在 DSH 内核对 API）');
      return;
    }

    const TEXT_OUTPUT = {
      schema: { type: 'text' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    };

    toolCtx.tools.register(
      defineTool({
        name: 'agent_clinic_scan',
        description:
          '扫描本地 DSH 会话并输出使用概览（会话数、帧、行、工具调用、错误率、token）。只读，零外发。',
        parameters: {
          dsh_home: { type: 'string' },
        },
        output: TEXT_OUTPUT,
        execute(args) {
          return Promise.resolve(runScan({ dshHome: args?.dsh_home ?? config.dshHome }));
        },
      }),
    );

    toolCtx.tools.register(
      defineTool({
        name: 'agent_clinic_show',
        description:
          '展开一条证据定位（形如 <file>#L<n>），用于复核诊断结论。只读。',
        parameters: {
          locator: { type: 'string', required: true },
        },
        output: TEXT_OUTPUT,
        execute(args) {
          return Promise.resolve(
            runShow(args?.locator, config.contextLines ?? 2),
          );
        },
      }),
    );

    toolCtx.tools.register(
      defineTool({
        name: 'agent_clinic_report',
        description:
          '生成 Agent 使用体检报告：诊断体验问题（死循环、反复失败、冗余重复调用等），每个结论附可复核的证据定位。只读，零外发。',
        parameters: {
          dsh_home: { type: 'string' },
        },
        output: TEXT_OUTPUT,
        execute(args) {
          return Promise.resolve(runReport({ dshHome: args?.dsh_home ?? config.dshHome }));
        },
      }),
    );

    log('已注册工具：agent_clinic_scan、agent_clinic_show、agent_clinic_report');
  });

  // -------------------------------------------------------------------------
  // 宿主 HTTP 路由 —— 供客户端面板取数
  //
  // 客户端「浏览器半」没有 fetch/setTimeout 等浏览器全局；但静态客户端模块
  // （/plugins/<包名>/client.js）是普通浏览器模块，可用 fetch。因此这里注册
  // 一个只读路由，面板通过它拿到报告文本。
  //
  // 路由 API 实测确认（@deepseek-ai/dsh-host-webserver）：
  //   ctx.webServer.register({ kind: 'exact'|'prefix', path, handler }) → disposer
  //   handler 拥有完整响应生命周期；重复 (kind,path) 会抛错。
  // -------------------------------------------------------------------------
  try {
    ctx.inject(['webServer'], (wsCtx) => {
      const ws = typeof wsCtx.get === 'function' ? wsCtx.get('webServer') : wsCtx.webServer;
      if (!ws || typeof ws.register !== 'function') {
        log('webServer 服务不可用，跳过面板路由注册（面板将显示提示）');
        return;
      }
      ws.register({
        kind: 'exact',
        path: '/api/agent-clinic/report',
        handler: async (_req, res) => {
          const send = (code, payload) => {
            const body = JSON.stringify(payload);
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(body);
          };
          try {
            const scan = scanSessions({ dshHome: config.dshHome });
            const summary = summarize(scan);
            const ctxReport = { scan, summary };
            send(200, {
              ok: true,
              version: API_VERSION,
              generatedAt: new Date().toISOString(),
              report: buildReport(ctxReport),
              data: analyze(ctxReport),
            });
          } catch (e) {
            send(500, { ok: false, error: String(e?.message ?? e) });
          }
        },
      });
      log('已注册只读路由 /api/agent-clinic/report');
      ws.register({
        kind: 'exact',
        path: '/api/agent-clinic/watch',
        handler: async (_req, res) => {
          const send = (code, payload) => {
            const body = JSON.stringify(payload);
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(body);
          };
          try {
            send(200, currentState(config.dshHome));
          } catch (e) {
            send(500, { ok: false, error: String(e?.message ?? e) });
          }
        },
      });
      log('已注册只读路由 /api/agent-clinic/watch（轻量状态，供客户端轮询）');
    });
  } catch (e) {
    log(`路由注册失败（不影响其他功能）：${e?.message ?? e}`);
  }
}
