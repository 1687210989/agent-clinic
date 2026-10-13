/**
 * L5 输出层 —— 体检报告生成
 *
 * 被 CLI（run.sh report）与 DSH 插件（agent_clinic_report）共用，
 * 避免两份真相。
 *
 * 硬性要求（任务书 §5.3 / docs/report-format.md）：
 *   1. 每个结论必须带证据定位与复核命令
 *   2. 必须列出「未检测到异常的维度」
 *   3. 必须列出「未实现的维度」—— 不假装全知
 *   4. 零对话原文；证据只给定位符，原文由 show 命令按需展开
 */

import { runDiagnostics } from './diagnostics/index.mjs';
import { num, pct } from './summary.mjs';

/**
 * 生成体检报告（Markdown 文本）
 *
 * @param {{scan:object, summary:object}} ctx
 * @param {Object} [opts]
 * @returns {string}
 */
export function buildReport(ctx, opts = {}) {
  const g = ctx.summary.global;
  const { findings, notDetected, notImplemented } = runDiagnostics(ctx, opts);
  const out = [];
  const push = (s = '') => out.push(s);

  push(`## Agent 体检报告（平台：DSH · ${g.sessions} 个会话）`);
  push();
  push(
    `扫描概览：${g.sessions} 会话 / ${g.lines} 行 / ${g.toolCalls} 次工具调用 / 错误率 ${pct(g.errorRate)}`,
  );
  push(
    `token：input ${num(g.inputTokens)} · output ${num(g.outputTokens)} · cacheRead ${num(g.cacheReadTokens)}`,
  );
  if (g.badFrames || g.badLines) {
    push(`⚠ 数据完整性：坏帧 ${g.badFrames} / 坏行 ${g.badLines}`);
  }
  push();

  if (findings.length === 0) {
    push('### 未发现问题');
    push();
    push('所有已实现的指标均未检测到异常。');
    push();
  } else {
    push(`### 发现 ${findings.length} 个问题（按严重度排序）`);
    push();
    for (const f of findings) {
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
  push(notDetected.length ? notDetected.map((d) => `${d.id} ${d.title}`).join('、') : '（无）');
  push();

  if (notImplemented.length) {
    push('### 未实现的维度（骨架阶段）');
    push(notImplemented.map((d) => `${d.id} ${d.title}`).join('、'));
    push();
  }

  push('---');
  push('证据可复核 · 全程本地 · 零外发');

  return `${out.join('\n')}\n`;
}
