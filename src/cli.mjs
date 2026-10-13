#!/usr/bin/env node
/**
 * agent-clinic CLI
 *
 * 用法：
 *   agent-clinic scan                    扫描并输出概览
 *   agent-clinic show "<file>#L<n>"      展开证据（复核用）
 *   agent-clinic report                  输出体检报告（M1 Step 5 待实现）
 *   agent-clinic diagnose                运行诊断（M1 Step 3 待实现）
 *   agent-clinic help
 *
 * 只读、零外发、零依赖。
 */

import path from 'node:path';

import { scanSessions, resolveSessionsRoot } from './adapters/dsh.mjs';
import { summarize, topTools, num, pct } from './summary.mjs';
import { hasZstdSupport } from './adapters/zstd-frames.mjs';
import { renderEvidence } from './evidence/index.mjs';
import { runDiagnostics } from './diagnostics/index.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function envCheck() {
  if (!hasZstdSupport()) {
    fail(
      [
        '运行环境不支持原生 zstd 解码，无法读取 DSH 会话文件。',
        `当前 Node 版本：${process.version}（需要 >= 22.15.0）`,
        '',
        '解决办法：升级到 Node 22.x LTS 或更高版本。',
        '本工具不会静默跳过无法解码的数据。',
      ].join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------

function doScan() {
  envCheck();
  const root = resolveSessionsRoot({});
  const scan = scanSessions({});
  const { global: g, perSession } = summarize(scan);

  if (scan.fileCount === 0) {
    process.stdout.write(`未找到会话文件。\n扫描目录：${root}\n`);
    return;
  }

  process.stdout.write(`扫描目录：${root}\n`);
  process.stdout.write(`会话文件：${scan.fileCount}\n\n`);

  for (const s of perSession) {
    const id = String(s.sessionId).replace(/^session-/, '').slice(0, 12).padEnd(12);
    const title = s.title ? `  ${s.title}` : '';
    const depth = s.depth ? ` depth=${s.depth}` : '';
    process.stdout.write(
      `  ${id}  帧=${String(s.frames).padStart(3)} 行=${String(s.lines).padStart(3)}` +
        ` 调用=${String(s.toolCalls).padStart(3)} 错误=${String(s.errors).padStart(2)}` +
        ` in=${num(s.inputTokens)} out=${num(s.outputTokens)}${depth}${title}\n`,
    );
  }

  process.stdout.write('\n===== 合计 =====\n');
  process.stdout.write(`会话=${g.sessions}  帧=${g.frames}  行=${g.lines}`);
  process.stdout.write(`  助手消息=${g.assistantMsgs}  用户消息=${g.userMsgs}\n`);
  process.stdout.write(
    `工具调用=${g.toolCalls}  错误=${g.errors}  错误率=${pct(g.errorRate)}\n`,
  );
  process.stdout.write(
    `input=${num(g.inputTokens)}  output=${num(g.outputTokens)}  ` +
      `cacheRead=${num(g.cacheReadTokens)}  cacheWrite=${num(g.cacheWriteTokens)}\n`,
  );
  process.stdout.write(`cacheRead 占比=${pct(g.cacheReadShare)}\n`);

  const tt = topTools(g, 8);
  if (tt.length) {
    process.stdout.write(`TOP 工具：${tt.map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);
  }

  if (g.badFrames || g.badLines) {
    process.stdout.write(`\n⚠ 数据完整性：坏帧 ${g.badFrames} / 坏行 ${g.badLines}\n`);
  }
  if (scan.errors.length) {
    process.stdout.write(`\n⚠ ${scan.errors.length} 个会话解析失败：\n`);
    for (const e of scan.errors) {
      process.stdout.write(`  ${path.basename(path.dirname(e.file))}：${e.message}\n`);
    }
  }
}

function doShow() {
  envCheck();
  const locator = argv[1];
  if (!locator) fail('用法：agent-clinic show "<file>#L<n>"');
  try {
    process.stdout.write(`${renderEvidence(locator)}\n`);
  } catch (e) {
    fail(`无法展开证据：${e.message}`);
  }
}

function doDiagnose() {
  envCheck();
  const scan = scanSessions({});
  const summary = summarize(scan);
  const { findings, notDetected, notImplemented } = runDiagnostics(summary);

  process.stdout.write('运行诊断…\n');
  process.stdout.write(`发现 ${findings.length} 个问题\n`);
  if (notDetected.length) {
    process.stdout.write(`未检测到异常：${notDetected.map((d) => d.id).join('、') || '（无）'}\n`);
  }
  if (notImplemented.length) {
    process.stdout.write(
      `未实现（骨架阶段）：${notImplemented.map((d) => d.id).join('、')}\n`,
    );
  }
}

function doReport() {
  envCheck();
  process.stdout.write('体检报告：M1 Step 5 待实现。\n');
  process.stdout.write('当前可用：agent-clinic scan / show / diagnose\n');
}

function doHelp() {
  process.stdout.write(
    [
      'agent-clinic —— Agent 体检诊所',
      '',
      '用法：',
      '  agent-clinic scan                 扫描 DSH 会话并输出概览',
      '  agent-clinic show "<file>#L<n>"   展开证据（复核用）',
      '  agent-clinic diagnose             运行诊断（骨架阶段）',
      '  agent-clinic report               输出体检报告（待实现）',
      '',
      '只读 · 零依赖 · 零外发',
    ].join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------

switch (cmd) {
  case 'scan':
    doScan();
    break;
  case 'show':
    doShow();
    break;
  case 'diagnose':
    doDiagnose();
    break;
  case 'report':
    doReport();
    break;
  case 'help':
  case '--help':
  case '-h':
    doHelp();
    break;
  default:
    fail(`未知命令：${cmd}\n\n运行 agent-clinic help 查看用法。`);
}
