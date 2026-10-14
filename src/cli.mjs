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

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanSessions, resolveSessionsRoot } from './adapters/dsh.mjs';
import { summarize, topTools, num, pct } from './summary.mjs';
import { hasZstdSupport } from './adapters/zstd-frames.mjs';
import { renderEvidence } from './evidence/index.mjs';
import { runDiagnostics } from './diagnostics/index.mjs';
import { buildReport, buildReportLive } from './report.mjs';
import * as catalogMod from './catalog/index.mjs';

const argv = process.argv.slice(2);
/** 取 `--flag value` 形式的参数值 */
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
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
  const { findings, notDetected, notImplemented } = runDiagnostics({ scan, summary });

  process.stdout.write('运行诊断…\n\n');
  process.stdout.write(`发现 ${findings.length} 个问题\n`);
  for (const f of findings) {
    process.stdout.write(`  [${f.severity}] ${f.id} ${f.title} —— ${f.summary}\n`);
  }
  if (notDetected.length) {
    process.stdout.write(`\n未检测到异常：${notDetected.map((d) => d.id).join('、') || '（无）'}\n`);
  }
  if (notImplemented.length) {
    process.stdout.write(`未实现：${notImplemented.map((d) => d.id).join('、')}\n`);
  }
}

async function doReport() {
  envCheck();
  const scan = scanSessions({});
  const summary = summarize(scan);

  // --live：发现问题后**当场联网**去 npm / GitHub 找插件（默认关闭，联网是显式动作）
  if (argv.includes('--live')) {
    const budget = argOf('--live-budget', 12000);
    process.stdout.write(
      `\n正在联网检索插件（预算 ${budget}ms，只发问题类型、不发会话内容）…\n`,
    );
    const { text, live } = await buildReportLive({ scan, summary }, {
      liveOptions: { budgetMs: Number(budget) || 12000 },
    });
    process.stdout.write(text);
    if (live) {
      process.stdout.write(
        `\n联网现搜：npm 检索 ${live.stats.npmQueries} 式 → ${live.stats.npmCandidates} 个候选 → 收录 ${live.stats.npmEntries} 条` +
          `；GitHub 检索 ${live.stats.githubQueries} 式 → ${live.stats.githubCandidates} 个仓库 → 收录 ${live.stats.githubEntries} 条` +
          `（通道：${live.stats.githubRelay ? '中继 ' + live.stats.githubRelay : '直连'}，耗时 ${(live.elapsedMs / 1000).toFixed(1)}s）\n`,
      );
      for (const e of live.errors) process.stdout.write(`  ⚠ ${e}\n`);
    }
    const reportPath = path.resolve(process.cwd(), 'agent-clinic-report.md');
    try {
      fs.writeFileSync(reportPath, text, 'utf8');
      process.stdout.write(`\n报告已写入：${reportPath}\n`);
    } catch (e) {
      process.stdout.write(`\n（写入报告文件失败：${e.message}）\n`);
    }
    return;
  }

  const text = buildReport({ scan, summary });

  process.stdout.write(text);

  const reportPath = path.resolve(process.cwd(), 'agent-clinic-report.md');
  try {
    fs.writeFileSync(reportPath, text, 'utf8');
    process.stdout.write(`\n报告已写入：${reportPath}\n`);
  } catch (e) {
    process.stdout.write(`\n（写入报告文件失败：${e.message}）\n`);
  }
}


/**
 * 插件目录同步：**唯一会联网的命令**，且只在用户显式执行时运行。
 *
 * 体检本体（scan / diagnose / report / 面板）依然零外发 —— 它们只读快照。
 */
function doCatalogSync() {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'catalog-sync.mjs');
  const r = spawnSync(process.execPath, [script, ...argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function doCatalog() {
  const { activeCatalog, SNAPSHOT_PATH: snapPath, I18N_PATH: i18nPath, formatHeat, kindLabel } = catalogMod;
  const a = activeCatalog();
  const cjk = /[\u4e00-\u9fff]/;
  const withCaps = a.entries.filter((e) => (e.capabilities ?? []).length);
  const untranslated = withCaps.filter((e) => !cjk.test(e.summary ?? ''));
  const community = a.entries.filter((e) => kindLabel(e) === '社区插件').length;
  const bundled = a.entries.filter((e) => kindLabel(e) === '官方内置包').length;
  const withHeat = a.entries.filter((e) => formatHeat(e)).length;
  process.stdout.write('插件目录\n');
  process.stdout.write(`  总条目：${a.entries.length}\n`);
  process.stdout.write(`  人工核实：${a.sources.curated} 条\n`);
  process.stdout.write(`  npm 同步：${a.sources.registry} 条\n`);
  process.stdout.write(
    `  GitHub 核实：${a.sources.github} 条` +
      (a.sources.snapshotAt ? `（快照 ${a.sources.snapshotAt}）` : `（快照不存在：${snapPath}）`) +
      '\n',
  );
  process.stdout.write(`  社区插件 ${community} 条 · 官方内置包 ${bundled} 条（内置包一般不必再装）\n`);
  process.stdout.write(`  带热度数据：${withHeat} 条（star / 下载量，只用于同分排序）\n`);
  process.stdout.write(
    `  中文简介：${withCaps.length - untranslated.length}/${withCaps.length} 条（可能被推荐的条目）· 覆盖层 ${i18nPath}\n`,
  );
  if (untranslated.length) {
    process.stdout.write(`  ⚠ 仍为英文（补进覆盖层即可）：${untranslated.map((e) => e.package).join('、')}\n`);
  }
  const synced = a.entries.filter((e) => e.origin && e.origin !== 'curated');
  if (synced.length) {
    // 按热度排一下，让"最近热度高 / 较多人推荐"的排前面（与推荐排序同一口径）
    const ranked = [...synced].sort((x, y) => (y.heat?.stars ?? -1) - (x.heat?.stars ?? -1) || (y.heat?.weeklyDownloads ?? -1) - (x.heat?.weeklyDownloads ?? -1));
    process.stdout.write('\n  同步条目（热度前 20）:\n');
    for (const e of ranked.slice(0, 20)) {
      const tag = e.origin === 'github' ? 'gh ' : 'npm';
      const heat = formatHeat(e);
      process.stdout.write(
        `    [${tag}] ${e.package}${e.version ? ` v${e.version}` : ''} — ${(e.capabilities ?? []).join('/') || '(未标注能力)'}` +
          `${heat ? ` · ${heat}` : ''}\n`,
      );
    }
    process.stdout.write('\n  提示：./run.sh catalog-sync 可更新这份清单\n');
  }
}

function doHelp() {
  process.stdout.write(
    [
      'agent-clinic —— Agent 体检诊所',
      '',
      '用法：',
      '  agent-clinic scan                 扫描 DSH 会话并输出概览',
      '  agent-clinic show "<file>#L<n>"   展开证据（复核用）',
      '  agent-clinic diagnose             只跑诊断',
      '  agent-clinic report               输出体检报告（只读本地目录）',
      '  agent-clinic report --live        发现问题后**联网现搜**插件（npm + GitHub）',
      '                                    --live-budget 12000  联网预算（毫秒，默认 12000）',
      '  agent-clinic catalog              查看插件目录（人工核实 + npm + GitHub）',
      '  agent-clinic catalog-sync         同步插件目录（npm registry + GitHub）',
      '                                    --source npm|github|both（默认 both）',
      '',
      '只读 · 零依赖 · 默认零外发',
      '联网动作只有两个，都需显式指定：catalog-sync（同步目录）、report --live（现搜插件）',
      'report --live 只发送问题类型关键词，不发送任何会话内容（报告里会列出实际发出的检索词）',
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
    await doReport();
    break;
  case 'catalog':
    doCatalog();
    break;
  case 'catalog-sync':
    doCatalogSync();
    break;
  case 'help':
  case '--help':
  case '-h':
    doHelp();
    break;
  default:
    fail(`未知命令：${cmd}\n\n运行 agent-clinic help 查看用法。`);
}
