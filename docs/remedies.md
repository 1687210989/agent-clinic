# 处方目录：问题 → 可执行方案

> 状态：**可用**（2026-10-15 重写）。这是 `src/prescriber/` 的说明文档，也是
> 「为什么这条处方可以信」的出处台账。

---

## 为什么要重写

用户反馈原话：

> 分析一下代码，定位到了问题但是没有给出可行的解决方案，例如 token 消耗过高，
> 但是没有给出可以省 token 的插件推荐。

复盘结论：**不是文案问题，是代码结构问题。**

| 症状 | 根因 |
|---|---|
| 报了 C1/C2，但处方只有一句"把重活拆成短会话" | `PRESCRIPTIONS` 三条插件的 `targets` 全是 `[]`，`prescribeOne` 的插件分支**永远匹配不上** |
| 唯一的配置处方是"调低 reasoningEffort（当前 low，可试更低的档位）" | `low` 就是最低档，这条建议**物理上无法执行** |
| 处方总数被卡在 2 条 | 上限本身没错，但配上"空靶 + 废话"就等于"没有方案" |

---

## 现在的处方长什么样

每条处方都必须同时具备五件事，缺一条就会被 `selfJustify()` 拒绝：

1. **靶子**：`targets` 里必须有触发它的指标 ID（不再允许空靶）
2. **自证**：说清它解决什么（`solves`）
3. **出处**：`source`（包名 + 文档 + 核实日期 + 核实方式）
4. **风险**：`risk`（这条建议会牺牲什么）
5. **验证**：`verify`（用户怎么确认它真的有效）
6. **步骤**：`steps`（展开态的「具体怎么做」，逐条能照着做）

### 收起态 / 展开态

用户反馈：「图一虽然给出建议，但是用户不知道具体操作步骤」、
「图二给出命令，命令具体在哪里输入使用给出具体的，卡片再进行精简，
设计成展开才是全部内容」。

所以面板里的卡片是**可折叠**的：

| 状态 | 显示内容 |
|---|---|
| 收起（默认） | 类型标签 + 标题 + 针对哪个指标 + **一行摘要**（`brief`：配置类是「当前值 → 建议值」，行为类是结论第一句） |
| 展开 | 完整说明 → **具体怎么做（分步）** → YAML 片段 / 命令 → 依据 → 风险 → 验证方式 → 出处 |

`steps` 由 `src/prescriber/index.mjs` 的 `buildSteps()` 按类型生成：

- **改配置**：打开哪个文件 → 搜哪一行 → 搜到就整段替换、没搜到就追加到末尾 → 保存 → 生效方式 → 验证
- **装插件**：侧边栏 → 插件 → 添加插件 → 粘贴包名 → 安装并启用 → **完全退出重启** → 验证
- **跑命令**：在会话输入框里敲什么、什么状态下可用、怎么验证
- **改设置**：打开哪个页面、把哪几项改成什么
- **行为建议**：由 `remedies.mjs` 的 `EXPLICIT_STEPS` 逐条写死（例如"写成 skill"会写明
  去 `~/.agents/skills/` 建目录、SKILL.md 的 frontmatter 要写什么）

命令行报告的「处方」章节会把这些步骤一并打印出来。

再加一件"让建议真正落地"的事：**配置类处方必须能说出「当前值 → 建议值」**。
为此新增了只读配置层 `src/config/index.mjs`：读 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
（**只读，绝不写入**），把「随附默认值」与「用户覆盖」合成一份生效值快照。

如果当前值已经不弱于建议值（例如 `maxInlineTokens` 已经是 6000），
`skipIf` 会**撤掉这条处方**，并在报告里写明"已否决：xxx —— 已经是 6000，无需再调"。
宁可不说，也不给一句正确的废话。

---

## 处方类型

| kind | 界面标签 | 交付物 |
|---|---|---|
| `config` | 改配置 | 可整段粘进 profile patch 的 YAML 片段（含 id / name / config 三要素） |
| `command` | 跑命令 | 斜杠命令 |
| `plugin` | 装插件 | 界面安装入口 + CLI 命令 + 仓库地址 |
| `settings` | 改设置 | 图形界面路径与要改的值 |
| `behavior` | 行为建议 | 指向具体动作（含实测工具名/次数），而不是"要更细心" |

### 关于 profile patch 的一个硬知识点

随附 bundle 的头部注释写得很明确：

> Later bundle patches and the user's profile `cordis.patch.yml` address these rows
> by id, with the last write winning per row.
> **A patch replaces the targeted row's whole `config` rather than merging into it.**

所以处方给出的 YAML 片段**必须把该行需要的键写全**（例如 `tool-result-pruner`
要同时写 `thresholdChars` / `headChars` / `tailChars`），否则会悄悄把其它键改回包内默认。
`docs/report-format.md` 与片段里的 `note` 都重复了这一点。

---

## 出处台账

### 一、随附插件（first-party）

核实方式：解包本机的 `D:\dsh\resources\app.asar`，逐字读包内 `README.zh.md`。
复核命令（需要 Node ≥ 22.15）：

```bash
node scripts/asar-extract.mjs "D:/dsh/resources/app.asar" "/dsh/node_modules/@deepseek-ai/dsh-spill-policy/README.zh.md"
node scripts/asar-extract.mjs "D:/dsh/resources/app.asar" --list /dsh/node_modules/@deepseek-ai/dsh-compaction
```

| 处方 | 包 | 依据（包内文档原文要点） |
|---|---|---|
| `spill-tighten` | `@deepseek-ai/dsh-spill-policy` | 「`maxInlineTokens`：保留的文字、图片、图片说明和提示的估算 token 上限；**省略时禁用策略**」。随附 `dsh-base` 里是 `12500` |
| `pruner-tighten` | `@deepseek-ai/dsh-compaction-tool-result-pruner` | 配置表：`thresholdChars` 8192 / `headChars` 4096 / `tailChars` 1024，约束「头部加标记加尾部之和必须不超过阈值」 |
| `compact-now` | `@deepseek-ai/dsh-command-compact` | 「`/compact`：空闲时可用，不接受参数，成功后报告被替换的历史项数与估算 token」 |
| `repeat-reminder-tighten` | `@deepseek-ai/dsh-repeat-tool-reminder` | 配置表：`thresholds` 默认 `[3, 5, 8]`（必须 ≥2 且不重复）、`argumentsPreviewChars` 500 |
| `reasoning-effort` | `@deepseek-ai/dsh-agent-default-model` | 「`reasoningEffort` 是可选的；保存不含此字段的选择，会从 profile 的完整配置覆盖中移除此字段」；本机当前为 `low` |
| `subagent-limit` | `@deepseek-ai/dsh-subagent` | 「`maxDepth` 默认 1」「`maxActiveSubagents` 默认 8」，均为 Host 设置项 |

随附默认值表（`src/config/index.mjs` 的 `SHIPPED_ROWS`）就是照 `@deepseek-ai/dsh-base`
的 `cordis.patch.yml` 抄的，7 行，每行都带 `note` 说明它管什么。

### 二、社区插件（third-party）

核实方式：`https://registry.npmjs.org/<包名>`（本工具不联网，条目录入时人工核实）。
复核命令：`npm view <包名> version`。

| 处方 | 包 | 核实到的事实 |
|---|---|---|
| `plugin-smart-compaction` | `smart-compaction`（v0.3.10，MIT） | 有 `dsh.bundle.patch`；提供 `compact_now` / `context_status` 两个工具；todo 勾完且上下文过半时自动压缩（`safePointRatio` 默认 0.5） |
| `plugin-billion-context` | `billion-context-dsh`（v0.2.27，MIT） | 有 `dsh.bundle.patch`；ACP 引擎，模型自写摘要；**README 顶部自述为测试版，请勿用于生产**，安装后会禁用 host 的 `compaction-basic` |

### 三、已核实但不对症（不进处方池）

保留记录是为了不丢失 2026-10-14 的核实工作 —— 它们不是被删了，是没有对症指标：

| 包/仓库 | 作用 | 为什么不出现在处方里 |
|---|---|---|
| `liustack/modsearch` | 免费联网检索 | 与 token/循环/资产类指标都不对症 |
| `shengsheng90/DSH-taskboard` | 本地任务看板 | 同上（它是展示层，不改变 token 消耗） |
| `cheshireez/dsh-skill-hub` | 浏览本地技能 | 同上 |

**没有对症插件就不编插件** —— 这条纪律来自 2026-10-14 的事故：
`caveman` / `Superpowers` / `claude-mem` / `deja-vu` 四条"插件"经 GitHub API 核实**不存在**，
星数与安装命令也是编的。它们已被永久移除，并加了防回归断言
（`scripts/smoke.mjs` 的「处方池没有未验证的条目」）。

---

## 省 token 开关清单（不是结论）

成本类问题只在**命中指标**时才开处方。但用户通常还想知道"我还能拧哪些旋钮"，
所以报告里另有一份 **「省 token 开关清单」**：它陈列本机真实存在的、与 C1/C2/C3 相关的
配置与插件，标注「本次未触发对应指标，仅供参考」，并已经排除掉"当前值已足够"的项。

这是**工具陈列**，不是诊断结论 —— 因此不违反「禁止硬编问题」。

---

## 插件目录检索（针对性推荐）

用户反馈：「还要能够检索插件目录进行针对性推荐，例如 billion-context 可以压缩
上下文省 token，就可以建议出来」。

后来又追问了一句更要紧的：**「billion-context 是你告诉我的，还是真正从插件目录
检索出来的？」**

当时的诚实回答是：**目录是人工写死的白名单** —— billion-context 来自用户点名，
我事后用 npm registry 核实（v0.2.27、有 `dsh.bundle.patch`、README 自述测试版）
才写进 `src/catalog/index.mjs`。检索逻辑是真的，目录是手工维护的。

现在目录有**两个来源**，每条都标出处：

| 来源 | 怎么来的 | 本机实测 | 说明 |
|---|---|---|---|
| `curated` | 人工核实并写进 `src/catalog/index.mjs` | 5 条 | 读过包文档，带 `targets` 与风险说明 |
| `npm-registry` | `./run.sh catalog-sync` 检索 npm registry | 59 条 | 从描述/关键词推导能力标签 |
| `github` | `./run.sh catalog-sync --source github` 核实 GitHub 仓库 | 5 条 | 很多插件只在 GitHub、没发 npm；只核实**仓库存在 + package.json 元数据**，未审阅源码 |

### GitHub 方向（受限网络下的做法）

用户要求：「不能从插件市场检索的话就去 GitHub 上寻找开源的可以解决问题的插件」。

现实约束（本机实测）：`api.github.com`、`github.com/search`、`raw.githubusercontent.com`
都被 hosts 拦成 127.0.0.1 —— **搜不了**；但 `git` 协议与 `codeload.github.com` 是通的。
所以 GitHub 方向拆成"发现"与"核实"两步：

1. **发现**：优先 `api.github.com/search/repositories`（没被墙的机器直接可用）；
   不可用时退回 `scripts/catalog-github-seeds.txt` —— 由联网检索（web_search）得到的
   候选清单，一行一个 `owner/repo`
2. **核实**：对每个候选执行 `git ls-remote https://github.com/<owner>/<repo>.git HEAD`
   证明仓库真实存在，再 `git clone --depth 1 --filter=blob:none --no-checkout` 浅克隆读
   `package.json`（判定 `dsh.bundle.patch` / `dshhub` 并推导能力）

GitHub 条目没有 npm 包可装，安装入口如实写成"按仓库 README 自行安装"，
风险提示明确标注**未审阅源码**。

### 打分与门槛

三层打分：指标靶子 +5、能力标签每个 +3（最多计 2 个）、问题文本关键词每个 +2。
**非人工条目（npm / GitHub）门槛 ≥5**：它们没有人工读过的 `targets`，
**单个泛能力标签不算数**。

> 踩过的坑：`loop-guard` 规则一开始写了裸词 `retry|loop|重试`，结果
> `@morlay/session-branch`（会话分支编辑）因为描述里出现一次 "retry" 被标成
> "循环防护"，进而被推给 E5 冗余重复调用 —— 纯噪音。现在规则全部改成指向明确的
> 说法（`死循环|重复调用|循环检测|repeat(ed)? tool`），并有断言守住。

### 去重与已安装过滤

- **同一个插件只列一次**，`findingIds` 列出它命中的全部指标
  （billion-context 命中 C1 与 C3 → 一行 `→ C1 / C3`）
- **已经安装的插件不再出现在推荐里**（用户要求）：`searchCatalog()`、
  `pluginRecommendations()`、`tokenInventory()` 三处都过滤。
  本机实测：用户装了 `billion-context-dsh` 后，报告里 `billion` 出现 **0 次**

### 本地插件目录（只读扫描）

`scanInstalledPlugins()` 读两处，都不写：

- `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` + `dependencies`
- 同目录 `node_modules` 的顶层包名（跳过 `.pnpm` / `.bin` 等点开头目录）

用途：报告里显示「本地已装 N 个」并据此**剔除已装插件**。

### 中文简介覆盖层

npm / GitHub 同步进来的插件描述大多是英文。处理办法是**人工维护的覆盖层**
`src/catalog/i18n.zh.json`（key = 包名，value = `{ summary, displayName? }`）：

- 目录层（`applyTranslation()`）在读取快照时套用，所以**旧快照也会被翻译**
- 命中覆盖层的条目保留 `summaryOriginal`，便于复核翻译是否忠实
- 没覆盖到的条目**原样保留英文**并标记 `summaryLang: 'en'`，
  界面与报告显示为"（英文原文）"—— 不用机器翻译糊弄

覆盖情况用 `./run.sh catalog` 查看（打印 `中文简介：N/M 条` 与待翻译清单）。
冒烟里有一条断言：**可能被推荐的插件（有能力和标签的）都必须有中文简介**；
将来同步到新的英文插件时它会报出具体包名，提示补进覆盖层。

### 纪律

- 目录条目必须标出处（人工核实 / npm 同步 / GitHub 核实 + 时间），不允许匿名条目
- 简介必须中文；实在没有中文来源就如实标"英文原文"，不机翻
- 检索不到就诚实说"没有对症插件"，不硬凑
- **体检本体零外发**；`catalog-sync` 是唯一联网命令，且只在用户显式执行时运行

---

## 处方上限

- 默认 `limit = 4`（旧版是 2）
- 每个 finding 给 2 个名额（`perFinding = 2` 轮转）：第 1 个是确定对症的处方，
  第 2 个留给插件目录检索结果 —— 避免"能装的插件"被一句行为建议挤掉
- 能动手的排在纯建议前面（config/command/settings → plugin → behavior）
- 同一 (处方, 指标) 组合不重复给

旧版把上限压到 2 条，本意是"宁精勿滥"，但配合空靶池的结果是"看到问题却拿不到方案"。
现在的取舍是：**每条都必须是可执行动作**，在这个前提下允许最多 4 条。

---

## 自检

```bash
./scripts/smoke.sh          # 114 项
```

处方层相关的关键断言：

- 每条处方都有对症指标（不再有空靶）
- 每条处方都可自证（targets + solves + 出处）
- 每条处方都写了风险与验证方式
- 成本类指标（C1/C2/C3）都有"可执行"处方，不只是行为建议
- 每个已实现指标都至少有一条对症处方
- 配置处方含可整段粘贴的 YAML，且会说明"当前值 → 建议值"
- 推理强度已是最低档时不给"再调低"的空建议
- 插件目录条目都带核实出处与仓库地址
- 检索能把"省 token"的插件召回给成本类问题，且每条命中都有可读原因
- 不对症的插件不会被硬塞进指标处方（按能力检索，不按人情）
- 已安装的插件不推"安装"，改推"确认启用"
- 每条处方都有分步操作指引（展开即照着做）
- 每条处方都有收起态摘要（一行说明白）
- 配置处方的步骤带真实文件路径与"整段替换"提醒
- 插件处方的步骤写明界面入口与"完全重启"
- 行为处方的步骤是具体动作而非结论
