#!/usr/bin/env node
/**
 * agent-clinic CLI
 *
 * 用法：
 *   agent-clinic scan                    扫描并输出概览
 *   agent-clinic show "<file>#L<n>"      展开证据（复核用；--context / --offset / --limit 可控）
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
import { readEffectiveConfig } from './config/index.mjs';
import * as catalogMod from './catalog/index.mjs';
// 决策 D4：用户文本指纹（K1/K2）—— 生命周期、隐私边界与可清除入口都在这里
import {
  beginFingerprintRun,
  clearStore,
  loadStore,
  storeStats,
  STORE_PATH,
  MIN_CHARS,
} from './privacy/fingerprints.mjs';
// M3.5 处方反馈闭环：记住"这条建议别再给我看"
import {
  FEEDBACK_PATH,
  clearFeedback,
  feedbackEntries,
  feedbackOptions,
  loadFeedback,
  recordFeedback,
  removeFeedback,
  saveFeedback,
  stateLabel,
  summarizeFeedback,
} from './prescriber/feedback.mjs';

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
  // 决策 D4：单独 scan 也会贡献指纹观测（同样必须在扫描前设好盐）
  const fp = beginFingerprintRun();
  const root = resolveSessionsRoot({});
  const scan = scanSessions({});
  const fpOutcome = fp.finish(scan);
  const { global: g, perSession } = summarize(scan);

  if (scan.fileCount === 0) {
    // F4：区分"目录读不了"与"确实没有会话" —— 别把权限问题说成"你没数据"
    const readErrs = (scan.errors ?? []).filter((e) => e.kind === 'read');
    if (readErrs.length) {
      process.stdout.write(`读不到会话目录（不是"没有会话"）：\n`);
      for (const e of readErrs) process.stdout.write(`  ${e.file}\n    ${e.message}\n`);
      return;
    }
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
  writeFingerprintOutcome(fpOutcome);
  if (scan.errors.length) {
    const readErrs = scan.errors.filter((e) => e.kind === 'read');
    const parseErrs = scan.errors.filter((e) => e.kind !== 'read');
    if (readErrs.length) {
      process.stdout.write(`\n⚠ ${readErrs.length} 个目录读不了（这部分数据没被统计到）：\n`);
      for (const e of readErrs) process.stdout.write(`  ${e.file}\n    ${e.message}\n`);
    }
    if (parseErrs.length) {
      process.stdout.write(`\n⚠ ${parseErrs.length} 个会话解析失败：\n`);
      for (const e of parseErrs) {
        process.stdout.write(`  ${path.basename(path.dirname(e.file))}：${e.message}\n`);
      }
    }
  }
}

function doShow() {
  envCheck();
  // 待优化报告 §5-1：插件侧按 contextLines 展开，CLI 却固定 2 行 —— 同一工具两种行为。
  // 现在优先用 --context，其次读 profile patch 里本插件那一行的 contextLines，最后才是 2。
  let defaults = { context: 2 };
  try {
    const cfg = readEffectiveConfig();
    const v = Number(cfg?.rows?.['agent-clinic']?.config?.contextLines);
    if (Number.isFinite(v)) defaults = { context: v };
  } catch {
    defaults = { context: 2 };
  }
  // 决策 D8：区间过长时的显式分页（--offset/--limit）。参数解析抽成纯函数 parseShowOptions，
  // 由自检直接断言；给错要报错，不能静默当成默认值 —— 否则用户以为自己翻页了，看到的还是第一页。
  const parsed = parseShowOptions(argv.slice(1), defaults);
  if (!parsed.ok) fail(parsed.error);
  const { locator, context, offset, limit } = parsed.options;
  try {
    process.stdout.write(`${renderEvidence(locator, { context, offset, limit })}\n`);
  } catch (e) {
    fail(`无法展开证据：${e.message}`);
  }
}

function doDiagnose() {
  envCheck();
  // 决策 D4：指纹必须在 **scan 之前**开好（适配层在解析时就算指纹，正文不落盘）
  const fp = beginFingerprintRun();
  const scan = scanSessions({});
  const summary = summarize(scan);
  const { findings, notDetected, notImplemented } = runDiagnostics(
    { scan, summary },
    fp.diagnosticOpts(scan),
  );
  const fpOutcome = fp.finish(scan);

  // M3.5：把处方反馈读出来（读坏了如实说明，但不影响诊断本身）
  const fb = feedbackOptions();

  process.stdout.write('运行诊断…\n\n');
  process.stdout.write(`发现 ${findings.length} 个问题\n`);
  for (const f of findings) {
    process.stdout.write(`  [${f.severity}] ${f.id} ${f.title} —— ${f.summary}\n`);
  }
  if (fb.summary.total) {
    process.stdout.write(
      `\n处方反馈：已应用 ${fb.summary.total} 条（已拒绝 ${fb.summary.rejected} · 感兴趣 ${fb.summary.interested}）\n`,
    );
  }
  if (fb.error) process.stdout.write(`⚠ 处方反馈读不出来（本次未应用）：${fb.error.message}\n`);
  if (notDetected.length) {
    process.stdout.write(`\n未检测到异常：${notDetected.map((d) => d.id).join('、') || '（无）'}\n`);
  }
  if (notImplemented.length) {
    process.stdout.write(`未实现：${notImplemented.map((d) => d.id).join('、')}\n`);
  }
  writeFingerprintOutcome(fpOutcome);
}

/**
 * 指纹快照的**运行结果如实回报**（决策 D4）。
 * 四件事都要说清：关闭了 / 读不出来 / 本次没采到指纹 / 写入失败。
 * 任何一件都不许静默 —— 否则用户会以为 K1/K2 的"没报问题"是"查过了，没问题"。
 */
function writeFingerprintOutcome(out) {
  if (!out) return;
  if (out.skipped && !out.error) {
    process.stdout.write(`\n指纹：${out.skipped}\n`);
    return;
  }
  if (out.error) {
    // ⚠️ 分清两种失败（我自己写反过一次）：
    //   phase='load'（读不出快照/没有盐）→ K1/K2 确实**没判**
    //   phase='save'（写盘失败，例如沙箱只允许写工作区）→ K1/K2 **已按本次扫描判定**，
    //                 损失的是"跨会话历史不会累积"
    if (out.phase === 'save') {
      process.stdout.write(
        `\n⚠ 指纹快照写入失败：${out.error.message}` +
          `\n  （K1/K2 本次仍按本次扫描的会话判定完毕；但这份快照没存下来，` +
          `下次体检不会带上历史观测 —— 想持久化请让本工具能写 ${out.path}）\n`,
      );
      return;
    }
    process.stdout.write(
      `\n⚠ 指纹快照不可用：${out.error.message}` +
        `\n  （K1 跨会话失忆 / K2 已解决重新排查 本次**未判定** —— 是"没查"，不是"没问题"）\n`,
    );
    return;
  }
  if (out.saved) {
    process.stdout.write(
      `\n指纹：本次新增 ${out.added} 条观测 → ${out.path}` +
        `（累计 ${out.stats?.hashes ?? 0} 个指纹 / ${out.stats?.observations ?? 0} 条观测；` +
        `只存加盐哈希，正文不落盘；agent-clinic fingerprints --clear 可删除）\n`,
    );
  } else if (out.added === 0 && out.missing > 0) {
    process.stdout.write(
      `\n指纹：本次扫描的 ${out.missing} 条用户消息都太短（<${MIN_CHARS} 字符）或未参与采集，没有新增观测。\n`,
    );
  }
}

async function doReport() {
  envCheck();
  // 决策 D4：扫面之前先开指纹（解析时算哈希），扫完把观测合并进本地快照
  const fp = beginFingerprintRun();
  const scan = scanSessions({});
  const summary = summarize(scan);
  // M3.5：处方反馈（rejected 会被处方层剔除；feedback 让报告能写出"哪几条是你撤掉的"）
  const fb = feedbackOptions();
  const fbOpts = {
    rejected: fb.rejected,
    interested: fb.interested,
    feedback: fb.store,
    feedbackError: fb.error,
  };

  // --live：发现问题后**当场联网**去 npm / GitHub 找插件（默认关闭，联网是显式动作）
  if (argv.includes('--live')) {
    const budget = argOf('--live-budget', 12000);
    process.stdout.write(
      `\n正在联网检索插件（预算 ${budget}ms，只发问题类型、不发会话内容）…\n`,
    );
    const { text, live } = await buildReportLive({ scan, summary }, {
      ...fp.diagnosticOpts(scan),
      ...fbOpts,
      liveOptions: { budgetMs: Number(budget) || 12000 },
    });
    process.stdout.write(text);
    const fpOutcome = fp.finish(scan);
    if (live) {
      process.stdout.write(
        `\n联网现搜：npm 检索 ${live.stats.npmQueries} 式 → ${live.stats.npmCandidates} 个候选 → 收录 ${live.stats.npmEntries} 条` +
          `；GitHub 检索 ${live.stats.githubQueries} 式 → ${live.stats.githubCandidates} 个仓库 → 收录 ${live.stats.githubEntries} 条` +
          `（通道：${live.stats.githubRelay ? '中继 ' + live.stats.githubRelay : '直连'}，耗时 ${(live.elapsedMs / 1000).toFixed(1)}s）\n`,
      );
      for (const e of live.errors) process.stdout.write(`  ⚠ ${e}\n`);
    }
    writeFingerprintOutcome(fpOutcome);
    const reportPath = path.resolve(process.cwd(), 'agent-clinic-report.md');
    try {
      fs.writeFileSync(reportPath, text, 'utf8');
      process.stdout.write(`\n报告已写入：${reportPath}\n`);
    } catch (e) {
      process.stdout.write(`\n（写入报告文件失败：${e.message}）\n`);
    }
    return;
  }

  const text = buildReport({ scan, summary }, { ...fp.diagnosticOpts(scan), ...fbOpts });
  const fpOutcome = fp.finish(scan);

  process.stdout.write(text);
  writeFingerprintOutcome(fpOutcome);

  const reportPath = path.resolve(process.cwd(), 'agent-clinic-report.md');
  try {
    fs.writeFileSync(reportPath, text, 'utf8');
    process.stdout.write(`\n报告已写入：${reportPath}\n`);
  } catch (e) {
    process.stdout.write(`\n（写入报告文件失败：${e.message}）\n`);
  }
}


/**
 * 解析 `rx` 子命令 —— 纯函数，便于自检直接断言。
 *
 * 用法：
 *   rx                                  列出已记录的反馈
 *   rx reject <目标 ID> [--reason "..."] [--metric C1]
 *   rx interested <目标 ID> [--reason "..."]
 *   rx remove <目标 ID>                 只删这一条
 *   rx clear                            清空全部
 *
 * @param {string[]} args `rx` 之后的参数
 * @returns {{ok:true, action:string, targetId?:string, reason?:string, metric?:string}|{ok:false, error:string}}
 */
export function parseRxArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const get = (name) => {
    const i = list.indexOf(name);
    return i >= 0 && list[i + 1] !== undefined ? list[i + 1] : null;
  };
  const action = list[0] ?? 'list';
  const reason = get('--reason');
  const metric = get('--metric');
  if (action === 'list' || action === 'clear') {
    return { ok: true, action, reason, metric };
  }
  if (!['reject', 'interested', 'remove'].includes(action)) {
    return {
      ok: false,
      error: `用法：agent-clinic rx [reject|interested|remove <目标 ID>] [--reason "..."] [--metric C1] | rx clear`,
    };
  }
  const targetId = list[1];
  if (!targetId || String(targetId).startsWith('--')) {
    return { ok: false, error: `rx ${action} 需要目标 ID（处方后面括号里那个，例如 behavior-split-session）` };
  }
  return { ok: true, action, targetId, reason, metric };
}

function doRx() {
  const parsed = parseRxArgs(argv.slice(1));
  if (!parsed.ok) fail(parsed.error);

  if (parsed.action === 'clear') {
    const r = clearFeedback({ path: FEEDBACK_PATH });
    if (!r.ok) fail(`清空反馈失败：${r.error.message}`);
    process.stdout.write(`已清空处方反馈：${FEEDBACK_PATH}\n`);
    return;
  }

  const { store, error } = loadFeedback({ path: FEEDBACK_PATH });
  if (error) {
    // 读坏了不能装作没事：否则"记反馈"会覆盖掉用户已有的反馈记录
    process.stdout.write(`⚠ 现有的反馈文件读不出来：${error.message}\n`);
    process.stdout.write('  （继续写会覆盖它。建议先备份或删除该文件再重试。）\n');
  }

  if (parsed.action === 'list') {
    const entries = feedbackEntries(store);
    process.stdout.write(`处方反馈：${FEEDBACK_PATH}\n`);
    if (!entries.length) {
      process.stdout.write('（还没有记录。用 `agent-clinic rx reject <目标 ID>` 记一条。）\n');
      return;
    }
    const summary = summarizeFeedback(store);
    process.stdout.write(
      `共 ${summary.total} 条（已拒绝 ${summary.rejected} · 感兴趣 ${summary.interested}）` +
        `${summary.updatedAt ? ` · 最近更新 ${summary.updatedAt}` : ''}\n`,
    );
    for (const e of entries) {
      process.stdout.write(
        `  [${stateLabel(e.state)}] ${e.targetId}` +
          `${e.metric ? ` (${e.metric})` : ''}${e.reason ? ` —— ${e.reason}` : ''}` +
          `${e.at ? ` · ${String(e.at).slice(0, 10)}` : ''}\n`,
      );
    }
    process.stdout.write('\n恢复某条：agent-clinic rx remove <目标 ID>；全部清空：agent-clinic rx clear\n');
    return;
  }

  if (parsed.action === 'remove') {
    const { existed } = removeFeedback(store, parsed.targetId);
    if (!existed) fail(`没有这条反馈：${parsed.targetId}`);
    const saved = saveFeedback(store, { path: FEEDBACK_PATH });
    if (!saved.ok) {
      fail(
        `反馈写入失败：${saved.error.message}\n` +
          '（注意：本工具在受限沙箱里可能写不了 ~/.agent-clinic/ —— 那就换到非沙箱环境再试）',
      );
    }
    process.stdout.write(`已删除反馈：${parsed.targetId}\n`);
    return;
  }

  const state = parsed.action === 'reject' ? 'rejected' : 'interested';
  const { entry } = recordFeedback(store, {
    targetId: parsed.targetId,
    state,
    reason: parsed.reason,
    metric: parsed.metric,
  });
  const saved = saveFeedback(store, { path: FEEDBACK_PATH });
  if (!saved.ok) {
    fail(
      `反馈写入失败：${saved.error.message}\n` +
        `（${FEEDBACK_PATH} 写不了 —— 受限沙箱里这是常见情况，换到非沙箱环境再试）`,
    );
  }
  process.stdout.write(
    `已记录：${entry.targetId} → ${stateLabel(state)}${entry.reason ? `（理由：${entry.reason}）` : ''}\n` +
      `  影响：下次体检不再把它作为处方给出（并会写明是你撤掉的）。恢复：agent-clinic rx remove ${entry.targetId}\n`,
  );
}

/**
 * 指纹快照的查看 / 清除（决策 D4 的隐私出口）。
 *
 * 这条命令本身**不联网、不读会话**，只读我们自己写的那份快照文件。
 */
function doFingerprints() {
  if (argv.includes('--clear')) {
    const r = clearStore({ path: STORE_PATH });
    if (!r.ok) fail(`删除指纹快照失败：${r.error.message}`);
    process.stdout.write(`已删除指纹快照：${STORE_PATH}\n`);
    return;
  }
  const { store, error, created } = loadStore({ path: STORE_PATH });
  process.stdout.write(`指纹快照：${STORE_PATH}\n`);
  if (error) {
    fail(`读不出来：${error.message}`);
  }
  if (created || !store.updatedAt) {
    process.stdout.write('状态：还没有写过（没跑过 scan / diagnose / report，或每次都没有新观测）\n');
  }
  const stats = storeStats(store);
  process.stdout.write(
    `内容：${stats.hashes} 个文本指纹 · ${stats.observations} 条观测` +
      `（每个指纹最多留 20 条）${stats.updatedAt ? ` · 最近更新 ${stats.updatedAt}` : ''}\n`,
  );
  process.stdout.write(
    [
      '',
      '里面存的是什么：',
      `  - 只有 sha256(盐 + 规范化用户文本) 的前 32 位十六进制，**没有正文**`,
      `  - 盐是本机随机生成的一串十六进制，存在同一个文件里（换机器不可比对）`,
      `  - 短于 ${MIN_CHARS} 字符的用户文本不生成指纹（"继续""好的"不会进来）`,
      '能反推出来吗：',
      '  - 不能反推出原文；但持有这个文件的人可以拿**已知候选句子**逐条试算比对 ——',
      '    这正是"可清除"存在的理由。',
      '',
      '删除：agent-clinic fingerprints --clear',
      '关闭：环境变量 AGENT_CLINIC_NO_FINGERPRINT_STORE=1（关闭后 K1/K2 会如实说"未采集"）',
    ].join('\n') + '\n',
  );
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
      (a.sources.snapshotAt ? `（快照 ${a.sources.snapshotAt}）` : '') +
      '\n',
  );
  // F4：快照读不了 ≠ 没同步过。损坏/无权限必须说出来，否则用户以为要重跑同步就好了
  if (a.sources.snapshotError) {
    process.stdout.write(`  ⚠ ${a.sources.snapshotError.message}\n`);
  } else if (!a.sources.snapshotAt) {
    process.stdout.write(`  （还没有同步过快照：${snapPath}，可跑 catalog-sync 获取社区插件）\n`);
  }
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

/**
 * help 文案（导出以便断言：子命令清单必须与实际 dispatch 一致）。
 * @returns {string}
 */
export function buildHelpText() {
  return (
    [
      'agent-clinic —— Agent 体检诊所',
      '',
      '用法：',
      '  agent-clinic scan                 扫描 DSH 会话并输出概览',
      '  agent-clinic show "<file>#L<n>"   展开证据（复核用）',
      '                                    --context N  区间两端各多取几行（默认读配置，回退 2）',
      '                                    --offset N   翻页：再跳过 N 行（配合截断提示里的命令）',
      '                                    --limit N    本次展开多少行（默认 200，上限 5000）',
      '  agent-clinic diagnose             只跑诊断',
      '  agent-clinic report               输出体检报告（只读本地目录）',
      '  agent-clinic report --live        发现问题后**联网现搜**插件（npm + GitHub）',
      '                                    --live-budget 12000  联网预算（毫秒，默认 12000）',
      '  agent-clinic catalog              查看插件目录（人工核实 + npm + GitHub）',
      '  agent-clinic catalog-sync         同步插件目录（npm registry + GitHub）',
      '                                    --source npm|github|both（默认 both）',
      '  agent-clinic fingerprints         查看本人文本指纹快照（K1/K2 的数据基础）',
      '                                    --clear  删除该快照',
      '  agent-clinic rx                   查看/记录**处方反馈**（记住"这条别再给我看"）',
      '                                    rx reject <目标 ID> [--reason "..."] [--metric C1]',
      '                                    rx interested <目标 ID> · rx remove <目标 ID> · rx clear',
      '',
      '只读 · 零依赖 · 默认零外发',
      '会话文件只读；本工具只在自己目录 ~/.agent-clinic/ 下写三份状态：目录快照、文本指纹快照、处方反馈',
      '指纹快照只存加盐哈希（正文不落盘），可用 fingerprints --clear 删除或',
      'AGENT_CLINIC_NO_FINGERPRINT_STORE=1 关闭',
      '处方反馈只存处方 ID 与你自己写的理由，可用 rx clear 清空',
      '联网动作只有两个，都需显式指定：catalog-sync（同步目录）、report --live（现搜插件）',
      'report --live 只发送问题类型关键词，不发送任何会话内容（报告里会列出实际发出的检索词）',
    ].join('\n') + '\n'
  );
}

/**
 * 解析 `show` 的参数 —— **纯函数**，便于断言（不读全局、不退出进程）。
 *
 * 2026-10-15：`--context` 以前给错值时会被静默忽略并回退到配置/2 —— 现在像
 * `--offset/--limit` 一样明确报错（"给错要说，不许静默退回默认值"是 D8 的既定原则）。
 *
 * @param {string[]} args  `show` 之后的参数（第一个非 `--` 项是定位符）
 * @param {{context?:number}} [defaults] 从 profile 配置读到的 contextLines
 * @returns {{ok:true, options:{locator:string,context:number,offset:number,limit:number|undefined}}
 *          | {ok:false, error:string}}
 */
export function parseShowOptions(args, defaults = {}) {
  const list = Array.isArray(args) ? args : [];
  const get = (name) => {
    const i = list.indexOf(name);
    return i >= 0 && list[i + 1] !== undefined ? list[i + 1] : null;
  };
  const locator = list[0] && !String(list[0]).startsWith('--') ? list[0] : null;
  if (!locator) {
    return {
      ok: false,
      error: '用法：agent-clinic show "<file>#L<n>" [--context N] [--offset N] [--limit N]',
    };
  }

  const contextRaw = get('--context');
  const context = contextRaw === null ? (defaults.context ?? 2) : Number(contextRaw);
  if (!Number.isFinite(context) || context < 0) {
    return { ok: false, error: `--context 必须是非负整数，收到 ${JSON.stringify(contextRaw)}` };
  }

  const offsetRaw = get('--offset');
  const limitRaw = get('--limit');
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (offsetRaw !== null && (!Number.isInteger(offset) || offset < 0)) {
    return { ok: false, error: `--offset 必须是非负整数，收到 ${JSON.stringify(offsetRaw)}` };
  }
  if (limitRaw !== null && (!Number.isInteger(limit) || limit < 1)) {
    return { ok: false, error: `--limit 必须是正整数，收到 ${JSON.stringify(limitRaw)}` };
  }
  if (limit !== undefined && limit > 5000) {
    return {
      ok: false,
      error: `--limit 上限 5000 行（收到 ${limit}）—— 证据是用来复核的，不是用来倾倒整个会话的`,
    };
  }
  return { ok: true, options: { locator, context, offset, limit } };
}

function doHelp() {
  process.stdout.write(buildHelpText());
}

// ---------------------------------------------------------------------------

/**
 * 只在**直接执行**时跑命令 —— 被 import 时必须无副作用。
 *
 * 这条守卫是"合成语料 fixture 那个坑"的同一课（见 scripts/fixtures/synth-dsh.mjs 末尾）：
 * 裸着跑 dispatch，任何 `import { parseShowOptions }` 都会顺带执行 CLI
 * （还可能真的 exit）。加了守卫之后，CLI 的参数解析与 help 文案才能被自检直接断言。
 */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
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
    case 'fingerprints':
      doFingerprints();
      break;
    case 'rx':
      doRx();
      break;
    case 'help':
    case '--help':
    case '-h':
      doHelp();
      break;
    default:
      fail(`未知命令：${cmd}\n\n运行 agent-clinic help 查看用法。`);
  }
}
