/**
 * L5 输出层 —— 体检报告
 *
 * 单一事实来源：`analyze()` 只产结构化数据，再由两个渲染器分别输出：
 *   - `buildReport()` → Markdown 文本（CLI / 模型工具用）
 *   - 客户端 `plugin/client.js` → 结构化 UI（DSH 面板用）
 *
 * 这样避免「解析 markdown 文本」这种脆弱做法，也让面板能做出真正的卡片式 UI。
 *
 * 硬性要求（任务书 §5.3 / docs/report-format.md）：
 *   1. 每个结论必须带证据定位与复核命令
 *   2. 必须列出「未检测到异常的维度」
 *   3. 必须列出「未实现的维度」—— 不假装全知
 *   4. 零对话原文；证据只给定位符，原文由 show 命令按需展开
 *
 * 2026-10-15 修正：处方不再是"一句正确的废话"。`analyze()` 现在会先读一次
 * 本机真实生效配置（只读），处方因此能说出「当前 12500 → 建议 6000」。
 */

import { runDiagnostics } from './diagnostics/index.mjs';
import { prescribe, prescribeOne, skippedFor, tokenInventory, KIND_LABEL } from './prescriber/index.mjs';
import { readEffectiveConfig } from './config/index.mjs';
import { num, pct } from './summary.mjs';

/**
 * 产出结构化体检结果。
 *
 * @param {{scan:object, summary:object}} ctx
 * @param {Object} [opts]
 * @returns {Object} 结构化结果
 */
export function analyze(ctx, opts = {}) {
  const g = ctx.summary.global;
  const { findings, notDetected, notImplemented, unimplementable } = runDiagnostics(ctx, opts);

  // 只读探测本机生效配置：处方据此说"当前值 → 建议值"
  let config = null;
  let configError = null;
  try {
    config = readEffectiveConfig(opts.env ?? process.env);
  } catch (e) {
    configError = e.message;
  }

  const rxCtx = { ...ctx, config };
  const prescriptions = prescribe(findings, { ...opts, ctx: rxCtx });

  // 省 token 开关清单：已经作为处方给出的不再重复列
  const levers = tokenInventory({
    ctx: rxCtx,
    excludeIds: prescriptions.map((r) => r.targetId),
  });

  // 每个问题各自挂上它的处方（旧版只在末尾给全局列表，用户看不出"这条对应哪个问题"）
  const perFinding = findings.map((f) => ({
    id: f.id,
    scope: f.scope ?? null,
    remedies: prescribeOne(f, { ctx: rxCtx, rejected: opts.rejected }).map((r) => ({
      targetId: r.targetId,
      kind: r.kind,
      kindLabel: r.kindLabel,
      title: r.title,
    })),
    skipped: skippedFor(f, { ctx: rxCtx }),
  }));

  return {
    header: {
      platform: 'DSH',
      sessions: g.sessions ?? 0,
      lines: g.lines ?? 0,
      toolCalls: g.toolCalls ?? 0,
      errorRate: g.errorRate ?? 0,
      inputTokens: g.inputTokens ?? 0,
      outputTokens: g.outputTokens ?? 0,
      cacheReadTokens: g.cacheReadTokens ?? 0,
      cacheWriteTokens: g.cacheWriteTokens ?? 0,
      badFrames: g.badFrames ?? 0,
      badLines: g.badLines ?? 0,
    },
    findings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      category: f.category,
      summary: f.summary,
      scope: f.scope ?? null,
      confidence: f.confidence,
      impact: f.impact ?? null,
      // 保留这两个字段：处方层要据此生成具体建议（工具名、重复次数），
      // 丢掉它们会让行为建议退化成无信息量的通用文案
      tool: f.tool ?? null,
      repeatCount: f.repeatCount ?? null,
      dangerPatterns: f.dangerPatterns ?? null,
      evidence: (f.evidence ?? []).map((e) => ({
        locator: e.locator,
        note: e.note ?? null,
      })),
      prescriptions: perFinding.find((p) => p.id === f.id && p.scope === (f.scope ?? null))?.remedies ?? [],
      // 被"当前值已足够"否决掉的处方，写出来是为了让用户看到"为什么没给这条"
      skippedPrescriptions: perFinding.find((p) => p.id === f.id && p.scope === (f.scope ?? null))?.skipped ?? [],
    })),
    notDetected: notDetected.map((d) => ({ id: d.id, title: d.title, note: d.note ?? null })),
    notImplemented: notImplemented.map((d) => ({ id: d.id, title: d.title })),
    unimplementable: unimplementable.map((d) => ({ id: d.id, title: d.title, reason: d.reason })),
    // 处方：每条都可执行（配置片段 / 命令 / 插件入口 / 设置路径 / 具体动作）
    prescriptions,
    // 省 token 开关清单（陈列本机真实存在的旋钮，不是诊断结论）
    levers,
    // 处方所依据的本机配置快照（只含我们真正会给处方的行）
    config: config
      ? {
          patchPath: config.patchPath,
          patchExists: config.patchExists,
          profileDir: config.profileDir,
          rows: Object.values(config.rows).map((r) => ({
            id: r.id,
            name: r.name,
            source: r.source,
            config: r.config,
          })),
          warnings: config.warnings,
        }
      : { patchPath: null, patchExists: false, error: configError },
    footer: '证据可复核 · 全程本地 · 零外发',
  };
}

/**
 * 生成体检报告（Markdown 文本）
 *
 * @param {{scan:object, summary:object}} ctx
 * @param {Object} [opts]
 * @returns {string}
 */
export function buildReport(ctx, opts = {}) {
  const data = analyze(ctx, opts);
  const h = data.header;
  const out = [];
  const push = (s = '') => out.push(s);

  push(`## Agent 体检报告（平台：${h.platform} · ${h.sessions} 个会话）`);
  push();
  push(
    `扫描概览：${h.sessions} 会话 / ${h.lines} 行 / ${h.toolCalls} 次工具调用 / 错误率 ${pct(h.errorRate)}`,
  );
  push(
    `token：input ${num(h.inputTokens)} · output ${num(h.outputTokens)} · cacheRead ${num(h.cacheReadTokens)}`,
  );
  if (h.badFrames || h.badLines) {
    push(`⚠ 数据完整性：坏帧 ${h.badFrames} / 坏行 ${h.badLines}`);
  }
  push();

  if (data.findings.length === 0) {
    push('### 未发现问题');
    push();
    push('所有已实现的指标均未检测到异常。');
    push();
  } else {
    push(`### 发现 ${data.findings.length} 个问题（按严重度排序）`);
    push();
    for (const f of data.findings) {
      const sess = String(f.scope ?? '').replace(/^session-/, '').slice(0, 12);
      push(`**[${f.severity}] ${f.id} ${f.title}** —— 会话 ${sess}`);
      push(`- 结论：${f.summary}`);
      const first = f.evidence[0];
      if (first) {
        push(`- 证据定位：${first.locator}`);
        push(`- 复核命令：./run.sh show "${first.locator}"`);
      }
      if (f.impact) push(`- 影响估算：${f.impact}`);
      push(`- 置信度：${f.confidence >= 0.8 ? '高' : '中'}`);
      if (f.prescriptions.length) {
        push(`- 处方：${f.prescriptions.map((r) => `${r.kindLabel}·${r.title}`).join(' / ')}`);
      }
      for (const s of f.skippedPrescriptions ?? []) {
        push(`- 已否决：${s.title} —— ${s.reason}`);
      }
      push();
    }
  }

  push('### 未检测到异常的维度');
  if (data.notDetected.length === 0) {
    push('（无）');
  } else {
    for (const d of data.notDetected) {
      push(d.note ? `- ${d.id} ${d.title} —— ${d.note}` : `- ${d.id} ${d.title}`);
    }
  }
  push();

  if (data.prescriptions.length > 0) {
    push(`### 处方（${data.prescriptions.length} 条 · 每条都有可执行动作）`);
    push();
    if (data.config?.patchPath) {
      push(`> 配置类处方改的是这份文件（本工具只读它，不代你改）：\`${data.config.patchPath}\``);
      push();
    }
    for (const [i, rx] of data.prescriptions.entries()) {
      push(`${i + 1}. **【${rx.kindLabel}】${rx.title}** —— 针对 ${rx.findingId}`);
      push(`   - 怎么做：${rx.detail.replace(/\n/g, '\n     ')}`);
      if (rx.command) {
        const isYaml = rx.action?.type === 'config';
        push(isYaml ? '   - 改成（可整段粘进 profile patch）：' : '   - 命令：');
        push('     ```' + (isYaml ? 'yaml' : 'bash'));
        for (const line of String(rx.command).split('\n')) push(`     ${line}`);
        push('     ```');
      }
      push(`   - 依据：${rx.because}`);
      if (rx.risk) push(`   - 风险提示：${rx.risk}`);
      if (rx.verify) push(`   - 怎么确认有效：${rx.verify}`);
      if (rx.source) push(`   - 出处：${rx.source}${rx.sourceVia ? ` · ${rx.sourceVia}` : ''}`);
      push();
    }
  }

  if (data.levers?.length) {
    push('### 省 token 开关清单（本机真实存在，供按需调整）');
    push();
    push('> 这是**工具陈列**，不是体检结论 —— 本次未触发对应指标，列出来是因为你随时可以拧它们。');
    if (data.config?.patchPath) push(`> 配置类改的是：\`${data.config.patchPath}\``);
    push();
    for (const lv of data.levers) {
      push(`- **【${lv.kindLabel}】${lv.title}**`);
      push(`  - 作用：${lv.solves}`);
      if (lv.current || lv.suggested) {
        push(`  - 当前：${lv.current ?? '(未读到)'} → 建议：${lv.suggested ?? '按需'}`);
      }
      if (lv.snippet) {
        push('  - 片段：');
        push('    ```yaml');
        for (const line of String(lv.snippet).split('\n')) push(`    ${line}`);
        push('    ```');
      }
      if (lv.install?.gui) push(`  - 安装：${lv.install.gui}`);
      if (lv.install?.cli) push(`  - 命令行：\`${lv.install.cli}\``);
      if (lv.note) push(`  - 备注：${lv.note}`);
      if (lv.risk) push(`  - 风险：${lv.risk}`);
      if (lv.source) push(`  - 出处：${lv.source}`);
    }
    push();
  }

  if (data.notImplemented.length) {
    push('### 未实现的维度（排期中）');
    for (const d of data.notImplemented) push(`- ${d.id} ${d.title}`);
    push();
  }

  if (data.unimplementable.length) {
    push('### 不可实现的维度（DSH 数据源缺失，非排期问题）');
    for (const d of data.unimplementable) push(`- ${d.id} ${d.title} —— ${d.reason}`);
    push();
  }

  push('---');
  push(data.footer);

  return `${out.join('\n')}\n`;
}

export { KIND_LABEL };
