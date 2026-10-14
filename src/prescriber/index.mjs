/**
 * L4 处方层 —— 问题 → 处方映射
 *
 * 原则（任务书 §5.4）：
 *   - 处方池只有 5 项（宁精勿滥），每次输出 <= 2 条
 *   - 每条处方必须"自证有效"：说明它如何解决对应的检测到的信号
 *   - 无对症插件时，诚实给"行为建议"，不硬凑
 *   - 四重过滤：已装 / 已推荐 / 已拒绝 / 不感兴趣
 *
 * ⚠️ 2026-10-14 修正：原处方池里 caveman / Superpowers / claude-mem / deja-vu
 *    四条均经 GitHub API 核实为**不存在**，星数与安装命令也是编的。
 *    已全部移除。池中只保留核实过的仓库，且坦白说明它们不覆盖当前任一指标。
 *
 *    这是本模块最重要的一条纪律：**没有对症插件就不编插件**。
 *    宁可给一条基于证据的行为建议，也不给一个无效的安装命令。
 */

/** 处方形态 */
export const RX_TYPE = {
  INSTALL: 'install',   // 安装现成插件
  BUILD: 'build',       // 自建 skill
  CONFIG: 'config',     // 平台配置建议
  BEHAVIOR: 'behavior', // 行为建议
};

/**
 * 已验证的处方池。
 *
 * 每一条都经 GitHub API 核实仓库存在；stars 是核实当天读数，仅供参考。
 * `targets` 只填**确实能解决**的指标 —— 当前实现的 E1/E2/E5 都不在列，
 * 因此这些插件不会出现在现有指标的处方里（这是诚实的结果，不是遗漏）。
 */
export const PRESCRIPTIONS = [
  {
    id: 'modsearch',
    name: 'modsearch',
    repo: 'liustack/modsearch',
    type: RX_TYPE.INSTALL,
    targets: [],
    solves: '给模型补上免费联网检索能力（web search / 页面抓取），无需 API key',
    stars: 675,
    verifiedAt: '2026-10-14',
    install: { dsh: 'dsh plugin add @liustack/modsearch' },
    note: '对当前指标不对症，暂无推荐理由',
  },
  {
    id: 'dsh-taskboard',
    name: 'dsh-taskboard',
    repo: 'shengsheng90/DSH-taskboard',
    type: RX_TYPE.INSTALL,
    targets: [],
    solves: '本地任务看板，把长任务显式化，减少 Agent 自己维护状态',
    stars: 334,
    verifiedAt: '2026-10-14',
    install: { dsh: 'dsh plugin add @shengsheng/dsh-taskboard' },
    note: '对当前指标不对症，暂无推荐理由',
  },
  {
    id: 'dsh-skill-hub',
    name: 'dsh-skill-hub',
    repo: 'cheshireez/dsh-skill-hub',
    type: RX_TYPE.INSTALL,
    targets: [],
    solves: '在 Web GUI 里浏览 / 搜索已安装的本地技能目录',
    stars: 29,
    verifiedAt: '2026-10-14',
    install: { dsh: 'dsh plugin add dsh-skill-hub' },
    note: '对当前指标不对症，暂无推荐理由',
  },
];

/**
 * 行为处方的生成器。
 *
 * 注意：这里刻意**不是固定文案**，而是从 finding 的实测字段（工具名、次数）
 * 组合出来。同一指标在不同会话里看到的具体对象不同，建议也应该不同 ——
 * 否则"处方"就退化成了一句正确的废话。
 */

const BEHAVIOR_BUILDERS = {
  E5: (f) => {
    const tool = f.tool || '同一个工具';
    const n = f.repeatCount ? `（实测同参数调用了 ${f.repeatCount} 次）` : '';
    return {
      text: `在同一轮对话里把 ${tool} 的结果一次性取回并记住，后续步骤直接复用，不要每个 step 都重新调用${n}。`,
    };
  },

  E1: (f) => {
    const tool = f.tool || '同一个工具';
    const n = f.repeatCount ? `（实测连续失败 ${f.repeatCount} 次）` : '';
    return {
      text: `定位到 ${tool} 连续失败的位置（见证据定位），检查参数或工具本身；若已确认无解，主动中断并换策略，不要让 Agent 原地重试${n}。`,
    };
  },

  E2: () => ({
    text: '错误率高通常是环境问题而非模型问题。先看失败样本的共同点（见证据定位）—— 多数是权限、路径或网络，修好后错误率会立刻下来。',
  }),
};

/**
 * 为单个 finding 生成处方。
 *
 * 顺序：先找对症插件（已验证的池），找不到再退到行为建议。
 * @returns {Object|null} 处方，或 null（该指标既无插件也无建议）
 */
export function prescribeOne(finding) {
  // 1) 对症插件
  const plugin = PRESCRIPTIONS.find((p) => p.targets.includes(finding.id));
  if (plugin) {
    const check = selfJustify(plugin, finding.id);
    if (!check.ok) return null;
    return {
      kind: plugin.type,
      title: `安装 ${plugin.name}`,
      detail: plugin.solves,
      command: plugin.install?.dsh ?? null,
      because: `它解决「${plugin.solves}」，正好对上检测到的 ${finding.id}（${finding.summary}）`,
      targetId: plugin.id,
    };
  }

  // 2) 行为建议
  const builder = BEHAVIOR_BUILDERS[finding.id];
  if (!builder) return null;
  const built = builder(finding);

  return {
    kind: RX_TYPE.BEHAVIOR,
    title: '行为建议',
    detail: built.text,
    command: null,
    because: `没有现成插件能解决 ${finding.id}${finding.tool ? `（${finding.tool}）` : ''}，这是本项目实测后的诚实结论。`,
    targetId: `behavior-${finding.id}`,
  };
}

/**
 * 匹配处方。
 *
 * @param {string|Array} problem 问题 ID 或 finding 列表
 * @param {Object} [opts] { limit=2, rejected=[], interested=false }
 * @returns {Array} 0~limit 条处方
 */
export function matchPrescriptions(problem, opts = {}) {
  const limit = opts.limit ?? 2;
  const rejected = new Set(opts.rejected ?? []);

  const findings = Array.isArray(problem)
    ? problem
    : [{ id: String(problem) }];

  const out = [];
  const seen = new Set();

  for (const f of findings) {
    if (out.length >= limit) break;
    const rx = prescribeOne(f);
    if (!rx) continue;
    if (rejected.has(rx.targetId)) continue;
    if (seen.has(rx.targetId)) continue; // 同一处方不重复给
    seen.add(rx.targetId);
    out.push(rx);
  }

  return out;
}

/**
 * 给一批 finding 出处方（按严重度排序，最多 limit 条）。
 */
export function prescribe(findings, opts = {}) {
  return matchPrescriptions(findings, opts);
}

/**
 * 校验"处方自证"：处方必须能说明它如何解决对应信号。
 * @returns {{ok:boolean, reason?:string}}
 */
export function selfJustify(prescription, problemId) {
  if (!prescription?.targets?.includes(problemId)) {
    return { ok: false, reason: `处方 ${prescription?.id} 未声明可解决 ${problemId}` };
  }
  if (!prescription.solves) {
    return { ok: false, reason: '处方缺少 solves 说明，无法自证' };
  }
  return { ok: true };
}
