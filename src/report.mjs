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
 */

import { runDiagnostics } from './diagnostics/index.mjs';
import { prescribe } from './prescriber/index.mjs';
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
  const { findings, notDetected, notImplemented } = runDiagnostics(ctx, opts);

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
      evidence: (f.evidence ?? []).map((e) => ({
        locator: e.locator,
        note: e.note ?? null,
      })),
    })),
    notDetected: notDetected.map((d) => ({ id: d.id, title: d.title, note: d.note ?? null })),
    notImplemented: notImplemented.map((d) => ({ id: d.id, title: d.title })),
    // 处方：宁精勿滥，最多 2 条；没有对症插件时给行为建议
    prescriptions: prescribe(findings),
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
      push();
    }
  }

  push('### 未检测到异常的维度');
  push(data.notDetected.length ? data.notDetected.map((d) => `${d.id} ${d.title}`).join('、') : '（无）');
  push();

  if (data.prescriptions.length > 0) {
    push(`### 处方（${data.prescriptions.length} 条，宁精勿滥）`);
    push();
    for (const [i, rx] of data.prescriptions.entries()) {
      push(`${i + 1}. **${rx.title}**`);
      push(`   - 怎么做：${rx.detail}`);
      if (rx.command) push(`   - 命令：\`${rx.command}\``);
      push(`   - 依据：${rx.because}`);
      push();
    }
  }

  if (data.notImplemented.length) {
    push('### 未实现的维度（骨架阶段）');
    push(data.notImplemented.map((d) => `${d.id} ${d.title}`).join('、'));
    push();
  }

  push('---');
  push(data.footer);

  return `${out.join('\n')}\n`;
}
