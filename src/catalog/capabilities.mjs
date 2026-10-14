/**
 * 能力标签：把一段插件描述文本变成「能用它解决什么问题」的标签。
 *
 * 两个消费者共用这份规则（**单一事实来源**）：
 *   - `scripts/catalog-sync.mjs`：同步目录时给每条插件打标签
 *   - `src/catalog/live.mjs`：体检时联网现搜，给临时抓到的插件打标签
 *
 * 这是"检索为什么命中"的唯一依据：每命中一个能力标签，都记下**是哪个词命中的**，
 * 报告与面板里会原样展示。规则是可读的，不是黑盒。
 *
 * ⚠️ 规则必须**具体**。踩过的坑：`loop-guard` 一开始写了裸词 `retry|loop|重试`，
 *    结果 `@morlay/session-branch`（会话分支编辑）因为描述里出现一次 "retry"
 *    就被标成"循环防护"，进而被推给 E5 冗余重复调用 —— 纯噪音。
 *    所以这类泛词一律删掉，只保留指向明确的说法。
 */
export const CAPABILITY_RULES = [
  { cap: 'token-saving', re: /上下文压缩|压缩上下文|上下文精简|上下文管理|上下文优化|context compress|compact(ion)?\b|token (节省|压缩|优化)|省 ?token|prune/i },
  { cap: 'cost', re: /成本|费用|花费|计费|价格|cost|billing|budget|额度|用量统计/i },
  { cap: 'long-session', re: /长会话|长期任务|长任务|续航|long[- ]?session|checkpoint|检查点|断点续跑/i },
  { cap: 'memory', re: /记忆|memory|recall|mnemon|知识库|知识图谱/i },
  { cap: 'skill-asset', re: /skill|技能库|技能管理|提示词库|prompt library/i },
  { cap: 'planning', re: /计划|待办|todo|任务看板|看板|task ?board|工作流|workflow/i },
  { cap: 'web-search', re: /联网|网络搜索|网页抓取|web ?search|web ?fetch|爬虫|浏览器自动化/i },
  { cap: 'loop-guard', re: /死循环|重复调用|循环调用|循环检测|loop ?guard|duplicate (tool )?call|repeat(ed)? tool/i },
  { cap: 'safety', re: /安全审计|权限管理|permission|审计|audit|沙箱|sandbox|危险命令/i },
  { cap: 'subagent-control', re: /子代理|子智能体|subagent|多智能体|agent ?team|代理团队/i },
  { cap: 'session-mgmt', re: /会话归档|会话管理|会话分支|归档|archive|会话导出|session (manage|archive|branch)/i },
  { cap: 'observability', re: /监控|用量看板|统计面板|dashboard|可视化|metrics|telemetry/i },
];

/**
 * 联网现搜用的检索词：能力 → 关键词。
 *
 * 只描述**问题类型**，不带任何本地会话内容 ——
 * 「发现问题就联网找方案」要能成立，同时不能把你机器上的会话文本发出去。
 */
export const CAPABILITY_TERMS = {
  'token-saving': ['context compression', 'token saving', 'compaction'],
  cost: ['token cost', 'usage meter'],
  'long-session': ['long session', 'checkpoint'],
  memory: ['memory', 'recall'],
  'skill-asset': ['skill manager'],
  planning: ['task board', 'todo'],
  'web-search': ['web search'],
  'loop-guard': ['duplicate tool call'],
  safety: ['audit', 'sandbox'],
  'subagent-control': ['subagent'],
  'session-mgmt': ['session archive'],
  observability: ['usage dashboard', 'telemetry'],
};

/** 从一段文本里推导能力标签，并记下命中的词 */
export function deriveCapabilities(text) {
  const out = [];
  const s = String(text ?? '');
  for (const rule of CAPABILITY_RULES) {
    const m = s.match(rule.re);
    if (m) out.push({ cap: rule.cap, matched: m[0] });
  }
  return out;
}

/** 从包元数据里拼出可检索文本（npm 搜索命中 / packument 都能用） */
export function textOf(pkg, hub) {
  return [
    pkg.name,
    pkg.description,
    (pkg.keywords ?? []).join(' '),
    hub?.summary,
    hub?.displayName,
    (hub?.categories ?? []).join(' '),
    (hub?.capabilities?.provides ?? []).join(' '),
    hub?.surfaces ? Object.keys(hub.surfaces).join(' ') : '',
  ]
    .filter(Boolean)
    .join(' \n ');
}

/** 单个包的 install 入口（与既有处方层、同步脚本保持同一措辞） */
export function installOf(name) {
  return {
    gui: `侧边栏 → 插件 → 添加插件 → 粘贴 ${name}`,
    cli: `dsh plugin --profile <你的 profile> add ${name}`,
  };
}
