/**
 * L4.5 配置层 —— 只读探测本机 DSH 的「真实生效配置」
 *
 * 为什么需要这一层（2026-10-15 修正）：
 *   旧处方层只会给"行为建议"，因为它不知道用户当前的门槛值是多少。
 *   结果就是"定位到了问题，但没有可行方案"——例如报出 C2 上下文膨胀，
 *   却只说"把长驻内容写进文件"，而用户真正能拧的旋钮（spill 预算、
 *   工具结果剪枝阈值、自动压缩触发比例）一个都没提。
 *
 * 本层只做一件事：把「随附默认值」和「用户 profile 覆盖」合成一份
 * 当前生效值快照，让处方能说出「当前 12500 → 建议 6000」。
 *
 * 硬性约束：
 *   - **只读**：绝不写入任何 DSH 文件
 *   - **零依赖**：不引入 YAML 库，只解析我们需要的那个 YAML 子集
 *   - **不假装**：解析不了的值标成 null 并在 warnings 里说明，绝不猜
 *
 * 关于"随附默认值"的来源：
 *   `@deepseek-ai/dsh-base` 的 cordis.patch.yml（随包补丁层）里有这些行。
 *   它在 app.asar 内，运行期不一定可读，因此这里内置一份**带出处**的
 *   默认值表；真正的用户覆盖一律从磁盘上的 profile patch 现读。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 随附默认值（出处：@deepseek-ai/dsh-base 的 cordis.patch.yml）
// ---------------------------------------------------------------------------


/**
 * 我们真正会给处方的行。
 *
 * 只收录**已逐字核对过随附 bundle**的行；没核对过的宁可不收录，
 * 也不给一个"可能不生效"的配置建议。
 */
export const SHIPPED_ROWS = [
  {
    id: 'spill-policy',
    name: '@deepseek-ai/dsh-spill-policy',
    config: { maxInlineTokens: 12500 },
    note: '超过预算的工具结果落到磁盘，内联只留首尾与文件路径',
  },
  {
    id: 'tool-result-pruner',
    name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
    config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    note: '压缩前把超大工具结果剪成头 + 尾，中段丢弃',
  },
  {
    id: 'compaction-basic',
    name: '@deepseek-ai/dsh-compaction-basic',
    config: {},
    note: '自动压缩后端；随附层没写 config，全部走包内默认值',
  },
  {
    id: 'repeat-tool-reminder',
    name: '@deepseek-ai/dsh-repeat-tool-reminder',
    config: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 },
    note: '同参数重复调用到阈值时提醒模型换策略',
  },
  {
    id: 'agent-default-model',
    name: '@deepseek-ai/dsh-agent-default-model',
    config: { provider: 'deepseek-official', model: 'deepseek-flash' },
    note: '新会话的默认模型路由',
  },
  {
    id: 'subagent',
    name: '@deepseek-ai/dsh-subagent',
    config: {},
    note: '子代理委派 seam；maxDepth / maxActiveSubagents 在 Host 设置里',
  },
  {
    id: 'session-title-llm',
    name: '@deepseek-ai/dsh-session-title-first-prompt-llm',
    config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 },
    note: '会话标题的辅助模型请求（每次新会话一次）',
  },
];

/** 包内默认值（README 里写死、bundle 未覆盖的那些） */
export const PACKAGE_DEFAULTS = {
  'spill-policy': { maxInlineTokens: null, _note: 'README：省略 maxInlineTokens 会禁用策略' },
  'tool-result-pruner': { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  'compaction-basic': {
    thresholdRatio: 0.8,
    headroomTokens: 65536,
    retainRatio: 0.16,
    maxTokens: 65536,
    compactionRetries: 1,
    maxOverflowRetries: 1,
    auto: true,
  },
  'repeat-tool-reminder': { thresholds: [3, 5, 8], argumentsPreviewChars: 500 },
  subagent: { maxDepth: 1, maxActiveSubagents: 8 },
};

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 按 DSH_HOME → ~/.dsh 回退解析数据根目录 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME && String(env.DSH_HOME).trim();
  if (fromEnv) return fromEnv;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return home ? path.join(home, '.dsh') : null;
}

/** 解析当前 profile 目录：DSH_PROFILE_DIR → DSH_PROFILE → profiles/ 下第一个 */
export function resolveProfileDir(env = process.env) {
  if (env.DSH_PROFILE_DIR && String(env.DSH_PROFILE_DIR).trim()) {
    return String(env.DSH_PROFILE_DIR).trim();
  }
  const home = resolveDshHome(env);
  if (!home) return null;
  const profilesRoot = path.join(home, 'profiles');
  if (env.DSH_PROFILE && String(env.DSH_PROFILE).trim()) {
    return path.join(profilesRoot, String(env.DSH_PROFILE).trim());
  }
  try {
    const entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
    const dir = entries.find((e) => e.isDirectory());
    if (dir) return path.join(profilesRoot, dir.name);
  } catch {
    /* 目录不存在：返回 null，由调用方标注"未找到 profile" */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 极小 YAML 子集解析
//
// 只需要认这几种形状（真实 profile patch 实测就是这个形状）：
//   - id: spill-policy
//     name: '@deepseek-ai/dsh-spill-policy'
//     config:
//       maxInlineTokens: 6000
// 以及 `- insert:` 容器、`disabled: !!js "..."`、列表值 [3, 5, 8]。
// 更深的嵌套（如 modelPolicies 的列表元素）一律忽略，不做假设。
// ---------------------------------------------------------------------------

const unquote = (s) => {
  const t = String(s).trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  // 去掉行尾注释（仅当 # 前面有空格，避免切掉 URL 里的 #）
  const i = t.search(/\s#/);
  return (i < 0 ? t : t.slice(0, i)).trim();
};

function parseScalar(raw) {
  const t = String(raw).trim();
  if (t === '') return null;
  if (t.startsWith('!!js')) return { __js: unquote(t.replace(/^!!js\s*/, '')) };
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^\[.*\]$/.test(t)) {
    return t
      .slice(1, -1)
      .split(',')
      .map((x) => parseScalar(x))
      .filter((x) => x !== null);
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  return unquote(t);
}

/**
 * 解析 profile patch 文本，返回 id 定位的行。
 *
 * @returns {{rows:Array<{id:string,name:string|null,disabled:any,config:Object}>, warnings:string[]}}
 */
export function parsePatch(text) {
  const rows = [];
  const warnings = [];
  let cur = null;
  let inConfig = false;
  let configChildIndent = null;

  const lines = String(text ?? '').split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item) {
      const rest = item[1];
      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rest);
      inConfig = false;
      configChildIndent = null;
      if (kv && kv[1] !== 'insert') {
        const key = kv[1];
        const val = kv[2];
        if (key === 'id' && indent <= 6 && !val.startsWith('!')) {
          // line：该行在 patch 文件里的 1-based 行号 —— 用来给"配置类"结论做证据定位
          // （A1「MCP 闲置」的证据就是配置本身，不是某条会话事件）
          cur = { id: unquote(val), name: null, disabled: null, config: {}, line: idx + 1 };
          rows.push(cur);
          continue;
        }
      }
      // `- insert:` 容器或列表元素：不作为行处理
      if (kv && kv[1] === 'insert') cur = null;
      continue;
    }

    if (!cur) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];

    if (key === 'id') {
      cur.id = unquote(val);
      inConfig = false;
      continue;
    }
    if (key === 'name') {
      cur.name = unquote(val);
      inConfig = false;
      continue;
    }
    if (key === 'disabled') {
      cur.disabled = parseScalar(val);
      inConfig = false;
      continue;
    }
    if (key === 'config') {
      if (val && val !== '{}') {
        warnings.push(`行 ${cur.id} 的 config 不是映射，已忽略：${val}`);
        inConfig = false;
      } else {
        inConfig = true;
        configChildIndent = null;
      }
      continue;
    }
    if (inConfig) {
      if (configChildIndent === null) configChildIndent = indent;
      if (indent !== configChildIndent) continue; // 更深层（列表元素等）忽略
      cur.config[key] = parseScalar(val);
    }
  }

  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// 生效配置快照
// ---------------------------------------------------------------------------

/**
 * 读取用户 profile patch（只读；不存在不算错）。
 *
 * 路径可被 `AGENT_CLINIC_PROFILE_PATCH` 覆盖 —— 为了自检/CI 能在**确定性输入**上
 * 断言 A1（MCP 闲置）这类"配置驱动"的指标：干净 runner 上没有 profile 目录，
 * 真读宿主只会得到"没配置"，覆盖不足就会假红（与 `AGENT_CLINIC_SKILL_DIRS` 同一套路）。
 */
export function readProfilePatch(env = process.env) {
  const dir = resolveProfileDir(env);
  const override = env?.AGENT_CLINIC_PROFILE_PATCH ? String(env.AGENT_CLINIC_PROFILE_PATCH) : null;
  const file = override ?? (dir ? path.join(dir, 'cordis.patch.yml') : null);
  if (!file) {
    return { path: null, exists: false, rows: [], warnings: ['未找到 profile 目录（DSH_HOME/profiles）'], profileDir: dir };
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const { rows, warnings } = parsePatch(text);
    return {
      path: file,
      exists: true,
      rows,
      warnings,
      profileDir: dir,
      overridden: Boolean(override),
    };
  } catch (e) {
    return {
      path: file,
      exists: false,
      rows: [],
      warnings: [`读取失败：${e.message}`],
      profileDir: dir,
      overridden: Boolean(override),
    };
  }
}

/** 从 patch 行里挑出 MCP 服务器配置（A1 用） */
export function mcpServersFromRows(rows, { patchPath = null } = {}) {
  const MC = {
    '@deepseek-ai/dsh-mcp-client': 'client',
    '@deepseek-ai/dsh-mcp-resources': 'resources',
  };
  return (rows ?? [])
    .filter((r) => MC[r.name] && r.disabled !== true)
    .map((r) => ({
      rowId: r.id,
      plugin: r.name,
      kind: MC[r.name],
      serverName: r.config?.serverName ?? null,
      transport: r.config?.transport ?? null,
      command: r.config?.command ?? null,
      url: r.config?.url ?? null,
      toolTimeoutMs: r.config?.toolCallTimeoutMs ?? null,
      locator: patchPath && Number.isInteger(r.line) ? `${patchPath}#L${r.line}` : null,
      line: r.line ?? null,
    }));
}

/**
 * 合成「当前生效配置」快照。
 *
 * 语义（与随附 bundle 头部注释一致）：profile patch 按 id 定位，
 * **整体替换该行的 config**（不是逐键合并），最后写入者胜出。
 *
 * @returns {{patchPath:string|null, patchExists:boolean, warnings:string[], rows:Object}}
 */
export function readEffectiveConfig(env = process.env) {
  const patch = readProfilePatch(env);
  const patchRows = new Map();
  for (const r of patch.rows) patchRows.set(r.id, r);

  const rows = {};
  for (const shipped of SHIPPED_ROWS) {
    const override = patchRows.get(shipped.id);
    const pkgDefaults = PACKAGE_DEFAULTS[shipped.id] ?? {};
    // 生效值优先级：profile 覆盖 > 随附 bundle config > 包内默认值
    const effective = {};
    for (const [k, v] of Object.entries(pkgDefaults)) if (!k.startsWith('_')) effective[k] = v;
    Object.assign(effective, shipped.config);
    let source = 'bundle-default';
    if (override) {
      // 整体替换语义：覆盖行的 config 即最终 config（未写的键回落到包内默认）
      const replaced = {};
      for (const [k, v] of Object.entries(pkgDefaults)) if (!k.startsWith('_')) replaced[k] = v;
      Object.assign(replaced, override.config);
      for (const k of Object.keys(effective)) delete effective[k];
      Object.assign(effective, replaced);
      source = 'profile';
    }
    rows[shipped.id] = {
      id: shipped.id,
      name: shipped.name,
      note: shipped.note,
      config: effective,
      bundleConfig: shipped.config,
      profileConfig: override ? override.config : null,
      source,
      disabled: override?.disabled ?? null,
    };
  }

  return {
    patchPath: patch.path,
    patchExists: patch.exists,
    profileDir: patch.profileDir,
    warnings: patch.warnings,
    rows,
  };
}

/** 取某行的某个键（找不到返回 undefined） */
export function valueOf(snapshot, rowId, key) {
  return snapshot?.rows?.[rowId]?.config?.[key];
}

/** 生成一段可直接粘进 profile patch 的 YAML（含 id/name/config 三要素） */
export function toPatchSnippet(rowId, config, name) {
  const lines = [`- id: ${rowId}`, `  name: '${name}'`, '  config:'];
  for (const [k, v] of Object.entries(config ?? {})) {
    lines.push(`    ${k}: ${formatScalar(v)}`);
  }
  return lines.join('\n');
}

/** YAML 标量渲染（只处理我们目录里出现过的类型） */
export function formatScalar(v) {
  if (Array.isArray(v)) return `[${v.map((x) => formatScalar(x)).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v === null || v === undefined) return 'null';
  return `'${String(v)}'`;
}
