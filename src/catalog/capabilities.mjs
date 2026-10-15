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
  // 决策 D4：K1/K2（跨会话失忆 / 已解决重新排查）对应的能力标签。
  // ⚠️ 这两类问题**基本没有插件能解决** —— 它们的解法是把结论写进项目文件，
  // 所以检索词刻意保持中性（知识沉淀 / 问题清单类工具），不硬凑"记忆插件"。
  'knowledge-capture': ['notes to markdown', 'docs generator'],
  'issue-tracking': ['known issues', 'changelog'],
  // 2026-10-15（A1 实现后）：MCP 服务器的管理与观测类工具
  'mcp-ops': ['mcp server', 'mcp inspector'],
};

/**
 * 「窄领域」插件规则 —— 专门用来挡住**蹭通用能力词**的插件。
 *
 * 用户报的问题（原话）：
 *   「去掉这类'窄领域插件蹭到通用能力词'的噪音」
 * 实例：`ilps2/dsh-video-understand`（★12，视频理解插件）描述里写了
 *   「低成本视频理解 … token 压缩 99.95%+」——
 *   这里的"省 token / 低成本"指的是**它自己那条视频流水线**，
 *   跟"你主会话的上下文在烧 token"（C1）根本不是一回事，
 *   但它同时命中了 `token-saving` + `cost` 两个通用能力标签，
 *   于是拿到 6 分、过了非人工条目的 5 分门槛，被推荐给 C1。
 *
 * 判定：插件文本里出现窄领域词 → 它的**通用基础设施能力主张**不可信
 *   （见 `GENERAL_CAPABILITIES`），这些标签不再计分。
 * 这不是黑名单封杀：窄领域插件仍可靠 `targets`（人工核实）与
 *   问题文本关键词命中拿分。
 */
export const NARROW_DOMAIN_RULES = [
  { domain: 'media', label: '视频/音频/图像处理', re: /视频|音频|语音|图片|图像|照片|字幕|video|audio|speech|image|photo|ocr|transcri/i },
  { domain: 'entertainment', label: '桌面娱乐', re: /壁纸|桌宠|宠物|小游戏|游戏化|wallpaper|desktop ?pet/i },
  { domain: 'content-gen', label: '内容创作', re: /小说|网文|剧本|文案|写作|翻译|novel|screenplay|translat|story ?writ/i },
  { domain: 'web-crawl', label: '网页抓取/浏览器自动化', re: /爬虫|网页抓取|浏览器自动化|crawler|scrap/i },
  { domain: 'file-convert', label: '文件格式转换', re: /演示文稿|\bppt\b|\bpdf\b|\bxlsx?\b|\bpptx\b|\bdocx\b|格式转换|文件转换/i },
];

/**
 * 通用基础设施能力：窄领域插件用这些标签对症问题，视为蹭词。
 * （全部取自 `CAPABILITY_RULES` —— 这些能力与具体领域无关，是"给主会话省资源"。）
 */
export const GENERAL_CAPABILITIES = new Set([
  'token-saving',
  'cost',
  'long-session',
  'memory',
  'planning',
  'loop-guard',
  'observability',
  'safety',
  'session-mgmt',
  'subagent-control',
  'skill-asset',
  'web-search',
]);

/**
 * 一段插件文本属于哪个窄领域（都不属于时返回 null）。
 * 注意：本函数是"文本里出现窄领域词"的宽松判定，用之前请先想清楚位置是否重要
 * —— 见 `domainOfEntry()` 用的是什么位置。
 * @returns {{domain:string,label:string,matched:string}|null}
 */
export function narrowDomainOf(text) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const rule of NARROW_DOMAIN_RULES) {
    const m = s.match(rule.re);
    if (m) return { domain: rule.domain, label: rule.label, matched: m[0] };
  }
  return null;
}

/**
 * 插件的**身份文本**：包名 + 显示名 + 关键词 + 简介**开头第一个分句**。
 *
 * 为什么是"第一个分句"而不是"前 N 个字符"：
 *   - 聚合包 `@fish-under-sea/dsh-fish` 的简介是
 *     「插件全家桶聚合包：一键插入十四个插件行 —— … 视频下载 video-fetch …」，
 *     按字符数截断会把清单里的 "视频下载" 收进来，于是把一个正常的 14 插件
 *     聚合包误判成"视频插件"。按分句切，它的第一句只是"插件全家桶聚合包"。
 *   - 而真正以某领域为主业的插件，第一句就写着它是什么：
 *     `dsh-ppt` →「DSH 演示文稿插件：生成 HTML、可编辑 PPTX …」
 *     `@wxg-prc-cpg/browser-skill-dsh-plugin` →「把 BrowserSkill 浏览器自动化能力…暴露给模型」
 */
export const IDENTITY_HEAD_CHARS = 40;

/** 取简介的第一个分句（按中英文冒号、破折号、顿号、斜杠等切分，并限长） */
export function firstClause(summary) {
  const s = String(summary ?? '').trim();
  if (!s) return '';
  const head = s.split(/[：:——、／/\n]|--/)[0] ?? s;
  const chosen = head.trim().length >= 4 ? head : s; // 切出来太短（如"插件："）就退回全句
  return chosen.slice(0, IDENTITY_HEAD_CHARS);
}

export function identityTextOf(entry) {
  return [entry?.package, entry?.displayName, (entry?.keywords ?? []).join(' '), firstClause(entry?.summary)]
    .filter(Boolean)
    .join(' \n ');
}

/** 插件的**完整文本**（含简介全文），用于"自我成本声明"判定 */
export function domainTextOf(entry) {
  return [entry?.package, entry?.displayName, entry?.summary, (entry?.keywords ?? []).join(' ')]
    .filter(Boolean)
    .join(' \n ');
}

/**
 * 「自我成本声明」：窄领域名词与省成本/省 token 的说法**挨在一起**。
 *
 * 例（真实条目 ilps2/dsh-video-understand）：
 *   「低成本视频理解 … 摘要+问答（token 压缩 99.95%+）」
 * 这里的省 token 说的是**它自己那条视频流水线**，不是你的主会话上下文。
 * 名词与成本词必须在 40 字符以内 —— 长描述里隔了半屏的两句话不算，
 * 否则会误伤"顺带提一句某领域词"的正常插件。
 */
export const SELF_CLAIM_GAP = 40;

export function selfScopedEfficiency(text) {
  const s = String(text ?? '');
  if (!s) return null;
  const gap = `[\\s\\S]{0,${SELF_CLAIM_GAP}}`; // 允许跨空格：声明里常夹着标点与空格
  for (const rule of NARROW_DOMAIN_RULES) {
    // 名词在前、成本词在后（视频…省 token）
    const forward = new RegExp(
      `(?:${rule.re.source})${gap}(?:token|省 ?token|成本|费用|低价|免费|compress|压缩)`,
      rule.re.flags.includes('i') ? 'i' : '',
    );
    // 成本词在前、名词在后（低成本视频理解）
    const backward = new RegExp(
      `(?:token|省 ?token|低成本|降本|成本|费用|compress|压缩)${gap}(?:${rule.re.source})`,
      rule.re.flags.includes('i') ? 'i' : '',
    );
    const m = s.match(forward) ?? s.match(backward);
    if (m) return { domain: rule.domain, label: rule.label, matched: m[0].slice(0, 60) };
  }
  return null;
}

/**
 * 判定一个条目是否属于「窄领域」——这决定它的通用能力标签还算不算数。
 *
 * 两道判据，命中任一即算：
 *   1. **身份就是窄领域**（包名/关键词/简介开头出现领域词）
 *      —— 例：`dsh-video-understand`、`dsh-ppt`、`dsh-image-generation`
 *   2. **自我成本声明**（领域词与省成本说法挨在一起）
 *      —— 例：包名看不出来，但简介写"低成本视频理解…token 压缩 99.95%"
 *
 * 为什么不用"文本里任意位置出现领域词"：长描述里经常只是顺带提一句
 * （实测 `@fish-under-sea/dsh-fish` 的 14 个聚合子包里提到了 video），
 * 那属于正常插件，不该被降权。
 */
export function domainOfEntry(entry) {
  const byIdentity = narrowDomainOf(identityTextOf(entry));
  if (byIdentity) return { ...byIdentity, via: 'identity' };
  const bySelfClaim = selfScopedEfficiency(domainTextOf(entry));
  if (bySelfClaim) return { ...bySelfClaim, via: 'self-claim' };
  return null;
}

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
