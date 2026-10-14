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
import { searchCatalog } from './catalog/index.mjs';
import { num, pct } from './summary.mjs';

/**
 * 把同一指标的多条 finding 合并成一组 —— 「同类型合并，不要重复展示」。
 *
 * 合并键是**指标 ID**：C1 在 3 个会话里命中 = 1 类问题、3 处实例；
 * A3 有 4 种工具序列 = 1 类问题、4 处实例。展开后仍能看到每一处的
 * 会话、结论与证据定位，不会因为合并而丢信息。
 *
 * @param {Array} findings 诊断层的扁平结果
 * @returns {Array} 分组（保持原始出现顺序，即严重度顺序）
 */
export function groupFindings(findings) {
  const byId = new Map();
  for (const f of findings) {
    if (!byId.has(f.id)) byId.set(f.id, []);
    byId.get(f.id).push(f);
  }

  const groups = [];
  for (const [id, list] of byId) {
    const first = list[0];
    const sessions = [...new Set(list.map((f) => f.scope).filter(Boolean))];
    const tools = [...new Set(list.map((f) => f.tool).filter(Boolean))];
    const dangerPatterns = [...new Set(list.flatMap((f) => f.dangerPatterns ?? []))];
    const repeatCount = Math.max(...list.map((f) => f.repeatCount ?? 0)) || null;
    const severity = pickSeverity(list);
    const headline = buildHeadline(id, list, tools);

    const instances = list.map((f) => ({
      scope: f.scope ?? null,
      summary: f.summary,
      impact: f.impact ?? null,
      confidence: f.confidence ?? null,
      evidence: (f.evidence ?? []).map((e) => ({ locator: e.locator, note: e.note ?? null })),
    }));

    // 用于出处方的"聚合 finding"：处方文案对着整体数字说话，
    // 而不是只描述第一个会话（否则合并后会张冠李戴）。
    const meta = {
      id,
      title: first.title,
      category: first.category,
      severity,
      scope: sessions[0] ?? null,
      summary: headline,
      tool: tools[0] ?? null,
      repeatCount,
      dangerPatterns,
      evidence: instances.flatMap((i) => i.evidence).slice(0, 12),
      occurrenceCount: list.length,
      sessions,
    };

    groups.push({
      id,
      title: first.title,
      category: first.category,
      severity,
      count: list.length,
      sessions,
      tools,
      summary: headline,
      impact: sumImpact(list),
      confidence: Math.max(...list.map((f) => f.confidence ?? 0)),
      instances,
      dangerPatterns,
      meta,
    });
  }
  return groups;
}

const SEV_ORDER = { 高: 0, 中: 1, 低: 2 };
const pickSeverity = (list) =>
  [...list].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))[0].severity;

/**
 * 合并后的一句话结论。
 *
 * 尽量把"最值"提出来（最高倍数 / 最多条数 / 涉及的序列与工具）；
 * 拿不到就用"N 处 + 首个实例结论"兜底 —— 不编数字。
 */
function buildHeadline(id, list, tools) {
  const n = list.length;
  const pick = (re, idx = 1) => {
    const nums = list.map((f) => Number((f.summary.match(re) ?? [])[idx])).filter((x) => Number.isFinite(x));
    return nums.length ? Math.max(...nums) : null;
  };

  if (id === 'C1') {
    const max = pick(/的\s*([\d.]+)\s*倍/);
    const ratios = list
      .slice(0, 3)
      .map((f) => (f.summary.match(/的\s*([\d.]+)\s*倍/) ?? [, '?'])[1] + ' 倍')
      .join(' / ');
    return `${n} 个会话的 output 远超自身基线${max ? `（最高 ${max} 倍）` : ''}：${ratios}${n > 3 ? ` 等 ${n} 处` : ''}`;
  }
  if (id === 'C3') {
    const max = pick(/单会话\s*(\d+)\s*条消息/);
    return `${n} 个会话消息数超阈值${max ? `（最多 ${max} 条）` : ''}`;
  }
  if (id === 'A3') {
    const seqs = list
      .map((f) => (f.summary.match(/「(.+?)」重复\s*(\d+)\s*次/) ?? []).slice(1))
      .filter((x) => x.length === 2);
    if (seqs.length) {
      return `${seqs.length} 类工具序列重复出现：${seqs
        .slice(0, 3)
        .map(([s, c]) => `${s} ${c} 次`)
        .join('、')}${seqs.length > 3 ? ` 等 ${seqs.length} 类` : ''}`;
    }
  }
  if (id === 'E5' || id === 'E1') {
    const detail = list
      .slice(0, 3)
      .map((f) => `${f.tool ?? '工具'} ${f.repeatCount ?? '?'} 次`)
      .join('、');
    return `${n} 处${id === 'E1' ? '死循环' : '冗余重复调用'}：${detail}${n > 3 ? ` 等 ${n} 处` : ''}`;
  }
  if (id === 'N2') {
    const pats = [...new Set(list.flatMap((f) => f.dangerPatterns ?? []))];
    return `${n} 处高风险操作${pats.length ? `：命中 ${pats.join('、')}` : ''}`;
  }
  if (id === 'A2') {
    const names = list.map((f) => (f.summary.match(/skill「(.+?)」/) ?? [])[1]).filter(Boolean);
    return names.length ? `${names.length} 个 skill 长期未触发：${names.join('、')}` : `${n} 处 skill 闲置`;
  }
  if (tools.length > 1) {
    return `${n} 处${list[0].title}：涉及 ${tools.slice(0, 4).join('、')}`;
  }
  return n > 1 ? `${n} 处${list[0].title}：${list[0].summary}` : list[0].summary;
}

/**
 * 合计影响估算。
 *
 * 只在**所有实例的单位一致**时才相加（例如都是"约多消耗 N output token"）；
 * 单位不同就老实不合计 —— 宁可少说，不编一个加不出来的数。
 */
function sumImpact(list) {
  const parsed = list.map((f) => {
    const m = String(f.impact ?? '').match(/^(.*?)([\d,]+)(.*)$/);
    if (!m) return null;
    return { prefix: m[1], value: Number(m[2].replace(/,/g, '')), suffix: m[3] };
  });
  if (!parsed.length || parsed.some((p) => !p || !Number.isFinite(p.value))) return null;
  const suffix = parsed[0].suffix;
  if (!parsed.every((p) => p.suffix === suffix)) return null;
  const total = parsed.reduce((a, p) => a + p.value, 0);
  return `${parsed[0].prefix}${total.toLocaleString('en-US')}${suffix}`;
}

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

  // 插件目录检索：读本地已装插件 + 用能力/关键词匹配每个问题
  let catalog = null;
  try {
    catalog = searchCatalog(findings, { env: opts.env ?? process.env });
  } catch (e) {
    catalog = { matches: {}, installed: { installed: [], error: e.message }, catalogSize: 0, catalogVersion: null };
  }

  const rxCtx = { ...ctx, config, installedPlugins: catalog.installed.installed ?? [] };
  const prescriptions = prescribe(findings, { ...opts, ctx: rxCtx });

  // 省 token 开关清单：已经作为处方给出的不再重复列
  const levers = tokenInventory({
    ctx: rxCtx,
    excludeIds: prescriptions.map((r) => r.targetId),
  });

  // 每个问题各自挂上它的处方与插件检索命中（旧版只在末尾给全局列表，
  // 用户看不出"这条对应哪个问题"，也看不到"为什么推荐这个插件"）。
  // 这里存**完整处方对象**，面板展开问题时可以直接渲染成卡片。
  const perFinding = findings.map((f) => ({
    id: f.id,
    scope: f.scope ?? null,
    full: prescribeOne(f, { ctx: rxCtx, rejected: opts.rejected }),
    skipped: skippedFor(f, { ctx: rxCtx }),
  }));

  // 同类型合并：一类问题一张卡，处方对着聚合后的数字生成（不再一处一张）
  const groups = groupFindings(findings).map((grp) => ({
    id: grp.id,
    title: grp.title,
    category: grp.category,
    severity: grp.severity,
    count: grp.count,
    sessions: grp.sessions,
    tools: grp.tools,
    summary: grp.summary,
    impact: grp.impact,
    confidence: grp.confidence,
    instances: grp.instances,
    prescriptions: prescribeOne(grp.meta, { ctx: rxCtx, rejected: opts.rejected }),
    skippedPrescriptions: skippedFor(grp.meta, { ctx: rxCtx }),
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
      prescriptions: perFinding.find((p) => p.id === f.id && p.scope === (f.scope ?? null))?.full ?? [],
      // 被"当前值已足够"否决掉的处方，写出来是为了让用户看到"为什么没给这条"
      skippedPrescriptions: perFinding.find((p) => p.id === f.id && p.scope === (f.scope ?? null))?.skipped ?? [],
    })),
    // 同类型合并后的分组视图（面板与报告都用它，避免一处一张卡）
    groups,
    notDetected: notDetected.map((d) => ({ id: d.id, title: d.title, note: d.note ?? null })),
    notImplemented: notImplemented.map((d) => ({ id: d.id, title: d.title })),
    unimplementable: unimplementable.map((d) => ({ id: d.id, title: d.title, reason: d.reason })),
    // 处方：每条都可执行（配置片段 / 命令 / 插件入口 / 设置路径 / 具体动作）
    prescriptions,
    // 省 token 开关清单（陈列本机真实存在的旋钮，不是诊断结论）
    levers,
    // 插件目录检索：本地已装清单 + 命中到的插件（**按插件去重**，列全命中的指标）
    catalog: {
      version: catalog.catalogVersion,
      size: catalog.catalogSize,
      sources: catalog.sources ?? null,
      installedCount: (catalog.installed.installed ?? []).length,
      installed: catalog.installed.installed ?? [],
      installedDir: catalog.installed.profileDir ?? null,
      error: catalog.installed.error ?? null,
      // 去重后的推荐清单：同一个插件只出现一次，findingIds 列出它命中的全部指标
      recommendations: (catalog.recommendations ?? []).map((r) => ({
        id: r.id,
        package: r.package,
        displayName: r.displayName,
        summary: r.summary,
        capabilities: r.capabilities,
        capabilityEvidence: r.capabilityEvidence,
        repo: r.repo,
        version: r.version,
        install: r.install,
        risk: r.risk,
        origin: r.origin,
        hasDshBundlePatch: r.hasDshBundlePatch,
        verifiedAt: r.verifiedAt,
        sourceVia: r.sourceVia,
        installed: r.installed,
        score: r.score,
        findingIds: r.findingIds,
        reasons: r.reasons,
      })),
      // 按 finding 分组的视图（面板里"这个问题命中什么"仍可用）
      matches: Object.entries(catalog.matches ?? {}).map(([id, hits]) => ({
        findingId: id,
        hits: hits.map((h) => ({
          id: h.entry.id,
          package: h.entry.package,
          displayName: h.entry.displayName,
          installed: h.installed,
          reasons: h.reasons,
        })),
      })),
    },
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

  if (data.groups.length === 0) {
    push('### 未发现问题');
    push();
    push('所有已实现的指标均未检测到异常。');
    push();
  } else {
    // 同类型合并：一类问题一条，实例作为子条目列出（不再一处一张）
    const total = data.groups.reduce((n, g) => n + g.count, 0);
    push(`### 发现 ${data.groups.length} 类问题（共 ${total} 处 · 按严重度排序）`);
    push();
    for (const grp of data.groups) {
      push(
        `**[${grp.severity}] ${grp.id} ${grp.title}** —— ${grp.count} 处` +
          (grp.count > 1 ? `（${grp.sessions.length} 个会话）` : ''),
      );
      push(`- 结论：${grp.summary}`);
      if (grp.impact) push(`- 影响估算：${grp.impact}`);
      push(`- 置信度：${grp.confidence >= 0.8 ? '高' : '中'}`);
      for (const [i, inst] of grp.instances.entries()) {
        const sess = String(inst.scope ?? '').replace(/^session-/, '').slice(0, 12) || '(全局)';
        const loc = inst.evidence[0]?.locator ?? null;
        push(`  ${i + 1}. 会话 ${sess}：${inst.summary}`);
        if (loc) {
          push(`     - 证据定位：${loc}`);
          push(`     - 复核命令：./run.sh show "${loc}"`);
        }
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
      if (rx.steps?.length) {
        push('   - 具体怎么做：');
        for (const [n, s] of rx.steps.entries()) push(`     ${n + 1}. ${s}`);
      }
      push(`   - 说明：${rx.detail.replace(/\n/g, '\n     ')}`);
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
      if (lv.steps?.length) {
        push('  - 具体怎么做：');
        for (const [n, s] of lv.steps.entries()) push(`    ${n + 1}. ${s}`);
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

  if (data.catalog?.recommendations?.length) {
    const src = data.catalog.sources;
    push(
      `### 插件目录检索（目录 ${data.catalog.size} 条 · 本地已装 ${data.catalog.installedCount} 个）`,
    );
    push();
    if (src) {
      push(
        `> 目录来源：**人工核实 ${src.curated} 条**` +
          (src.registry
            ? ` + **npm registry 同步 ${src.registry} 条**（同步于 ${String(src.snapshotAt).slice(0, 10)}，\`./run.sh catalog-sync\` 可更新）`
            : ` + npm 快照未同步（可选：\`./run.sh catalog-sync\`）`),
      );
    }
    push('> 按「能力标签 + 关键词」检索出来的相关插件 —— 同一个插件只列一次，并说明**为什么命中**。');
    push();
    for (const h of data.catalog.recommendations) {
      push(
        `- **${h.displayName}**（\`${h.package}\`${h.version ? ` v${h.version}` : ''}，` +
          `${h.installed ? '本地已安装' : '未安装'}${h.origin === 'npm-registry' ? ' · 来自 npm 同步' : ' · 人工核实'}）`,
      );
      push(`  - 命中指标：${(h.findingIds ?? []).join(' / ')}`);
      push(`  - 能力：${(h.capabilities ?? []).join(' / ') || '(目录未标注)'}`);
      push(`  - 作用：${h.summary}`);
      for (const r of h.reasons) push(`  - 命中原因：${r}`);
      if (!h.installed && h.install?.gui) push(`  - 安装：${h.install.gui}`);
      if (h.install?.cli) push(`  - 命令行：\`${h.install.cli}\``);
      if (h.risk) push(`  - 风险：${h.risk}`);
      if (h.repo) push(`  - 仓库：${h.repo}`);
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
