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

核实方式：`https://registry.npmjs.org/<包名>`（**这是目录录入时的核实动作**：体检本体默认不联网，只有 catalog-sync 与 report --live 会发出请求）。
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

现在目录有**三个来源**，每条都标出处：

| 来源 | 怎么来的 | 本机实测 | 说明 |
|---|---|---|---|
| `curated` | 人工核实并写进 `src/catalog/index.mjs` | 5 条 | 读过包文档，带 `targets` 与风险说明 |
| `npm-registry` | `./run.sh catalog-sync` 检索 npm registry | 150 条 | 从描述/关键词推导能力标签，带真实下载量 |
| `github` | `./run.sh catalog-sync --source github` 核实 GitHub 仓库 | 1 条 | 很多插件只在 GitHub、没发 npm；只核实**仓库存在 + package.json 元数据**，未审阅源码 |
| `npm-live` / `github-live` | `./run.sh report --live`（或面板「联网现搜插件」按钮）**当场**检索 | 每次不同 | 不落盘、不进快照；同名时让位给上面三种已审阅/已同步的条目 |

### 发现问题后联网现搜（`report --live`）

用户要求：「我想要的结果是发现问题后联网搜索得到解决方案」。

在它之前，体检只读一份可能过期的快照 —— 新出的插件要手动跑 `catalog-sync` 才看得见。
现在 `src/catalog/live.mjs` 会在**诊断出问题之后、生成处方之前**跑一次实时检索：

1. **检索词由问题推导**（`buildLiveQueries()`）：
   `CAPABILITY_BY_METRIC` 给出该指标需要什么能力，`CAPABILITY_TERMS` 再给出该能力的关键词。
   例：C1（token 消耗过快）→ `token-saving`/`cost` → `context compression`、`token saving`、`compaction`。
   npm 侧必带一条广谱式 `keywords:dsh-plugin`（捞最新上架的），GitHub 侧必带 `topic:dsh-plugin`。
2. **只发问题类型，不发会话内容**（刻意的硬约束）：
   `sent` 数组会被原样写进报告与面板，可逐条核对；冒烟里有断言
   「检索词里不含会话内容（长度与字符集都受限）」。
3. **硬截止**：默认 12s（面板 10s）总预算，`Promise.race` 兜底 ——
   只靠单请求超时是不够的（实测 12s 预算跑了 14.7s，因为在途并发请求会拖过去）。
   到点就用已拿到的部分，并记录「超出预算，本次未采用其结果」。
4. **两条通道独立降级**：npm 与 GitHub 各自失败各自记录，
   网络全断只是"本次没搜到"，报告照常出。
5. **不落盘**：现搜结果只活在这一份报告里，不会污染 `~/.agent-clinic/catalog.snapshot.json`；
   同名条目让位给快照/人工条目（避免把已审阅的降级成未审阅版本），并在报告里标「本次联网现搜」。
6. **JSON 输出里可复核**：`data.catalog.sources.live = { at, elapsedMs, kept, added, sent, networked, degraded, errors }`。

页脚与面板标签会跟着变：跑过 `--live` 就不再写「零外发」；
禁用联网（`network: false`）时 `networked: false`，措辞退回「零外发」——有断言守住这一点。


### 扩大检索数量（多关键词 + 翻页 + 热度排序）

用户要求：「有什么方法能增加检索到的插件数量，可以从最近热度高的插件，
或者较多人推荐的插件进行检索」。

- **多路检索**：单条关键词会漏，所以 `NPM_QUERIES` 同时跑
  `keywords:dsh-plugin`（8444 条）、`keywords:dsh`（10636 条）、
  `text:deepseek harness plugin`（32 万条，噪音多但能捞到没打关键词的包）
- **翻页收集**：`--pool`（默认 600）条候选全收进来，再按热度排序取前
  `--limit`（默认 120）个抓 packument 详情
- **热度来自真实数据**：npm 侧用搜索接口自带的周/月下载量、被依赖数、
  popularity 分（`heatOfNpm()`）；GitHub 侧用仓库 star / fork / 最近推送时间。
  界面与报告都如实显示（`formatHeat()`），**拿不到就返回 null，不编造**
- **热度不参与打分**：一个插件能不能解决问题，靠的是指标靶子与能力标签；
  热度只在**分数相同**时决定先看哪个 —— 有断言守住（"高热但不对症依然不推荐"）

### 窄领域插件「蹭通用能力词」的过滤

用户要求（原话）：「去掉这类'窄领域插件蹭到通用能力词'的噪音」。

实例：`ilps2/dsh-video-understand`（★12，视频理解插件）简介写着
「低成本视频理解 … 摘要+问答（token 压缩 99.95%+）」——
这里的"省 token / 低成本"指的是**它自己那条视频流水线**，
不是"你主会话的上下文在烧 token"，但它同时命中 `token-saving` + `cost`，
拿到 6 分、过了非人工条目的 5 分门槛，于是被推荐给 C1。

规则（`src/catalog/capabilities.mjs` `domainOfEntry()`）：判定为窄领域后，
该插件的**通用基础设施能力标签**（`GENERAL_CAPABILITIES`）不再计分。
两道判据，命中任一即算：

| 判据 | 怎么判 | 例 |
|---|---|---|
| `identity` | 包名 / 显示名 / 关键词 / **简介第一个分句**里出现领域词 | `dsh-video-understand`、`dsh-ppt`、`@dfy-plugins/dsh-image-generation` |
| `self-claim` | 领域词与"省 token / 低成本"说法**挨在一起**（40 字符内，含空格） | 包名正常，但简介写「主打低成本和速度，token 压缩 99.95%+；支持视频」 |

窄领域分类：`media`（视频/音频/图像）、`entertainment`（壁纸/桌宠）、
`content-gen`（小说/写作/翻译）、`web-crawl`（爬虫/浏览器自动化）、
`file-convert`（PPT/PDF/Excel 等格式转换）。本机目录 155 条里命中 20 条。

**刻意不做的两件事**（都踩过）：

1. **不按"文本里任意位置出现领域词"判**。实测 `@fish-under-sea/dsh-fish`
   （14 个插件的聚合包）清单里列了一句"视频下载 video-fetch"，
   全文检索会把它误判成视频插件 —— 所以身份判据只看**第一个分句**。
2. **不是封杀**。被扣分的只是通用能力标签；窄领域插件仍可靠人工核实的
   `targets` 与问题文本关键词命中拿分。人工核实条目（`curated`）完全豁免 ——
   那是人读过后给出的判断，不该由文本推断推翻。

**如实披露**：被扣分/挡掉的插件会写进报告
（`已挡掉 N 个「窄领域插件蹭通用能力词」的推荐`）与 JSON
（`data.catalog.offDomainFiltered`，含 `domain` / `domainLabel` / `domainVia` / `caps`），
不是静默丢弃 —— 否则用户无法区分"真的没有对症插件"和"被规则挡了"。

### 官方内置包 vs 社区插件

按下载量排序时，`@deepseek-ai/dsh-*` 这些**随 dsh-base 分发的内置包会碾压社区插件**
（实测周下载 50 万+），把收录名额全占满 —— 目录里于是塞满用户本来就装好了、
根本不需要再装的东西。所以：

- `isOfficialBundle()` 识别 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
- **抓详情的名额社区优先**（`pickForDetail()`）：社区包先占满，不够才用内置包填
- 排序上社区插件排在官方内置包前面（`rankKind()`），`kindLabel()` 如实标注
  「人工核实 / 社区插件 / 官方内置包」
- 万一内置包进了推荐，报告与面板会附一句：通常已随 dsh-base 挂载，一般不需要再装

### GitHub 方向（受限网络下的做法）

用户要求：「不能从插件市场检索的话就去 GitHub 上寻找开源的可以解决问题的插件」。

现实约束（本机实测）：`api.github.com`、`github.com/search`、`raw.githubusercontent.com`
都被 hosts 拦成 127.0.0.1；`git` 协议与 `codeload.github.com` 通。
**但是**：公共镜像 `gh-proxy.com` 能**原样中继 GitHub API**（`ghfast.top` 403，
`hub.gitmirror.com` / `api.kkgithub.com` / `bgithub.xyz` 均不可达）——
所以真正的 GitHub 检索是可用的（`GH_RELAYS` 直连优先，失败逐个试中继）。

做法：

1. **发现**：`GH_QUERIES` 五条检索式，既按 star 数（"较多人推荐"）
   也按最近更新（"最近热度高"）：`topic:dsh-plugin`（1.9 万）、
   `topic:deepseek-harness`（1.5 万）、`dsh-plugin in:name,description,readme` 等
2. **相关性过滤**：GitHub 的关键词检索是全文匹配，star 排序头部全是
   `ollama/ollama`、`avelino/awesome-go` 这类蹭到词的大仓库 ——
   `isDshRelated()` 先按名字/描述/主题过一遍（实测一次剔除 57 个），宁缺毋滥
3. **核实**：`/repos/{slug}` 证明存在并取 star/fork/最近推送，`/contents/package.json`
   读清单判定 `dsh.bundle.patch` / `dshhub` 并推导能力。
   **API 通道优先、`git` 只做兜底** —— 踩过的坑：受限沙箱里 spawn `git`
   直接 `EPERM`（piped stdio 打不开命名管道），把 git 放第一步会让整个
   GitHub 方向全军覆没；现在 API 挂了才退回 `git ls-remote` + 浅克隆
4. 拿不到 API 时，`scripts/catalog-github-seeds.txt`（6 条人工种子）仍是最后退路

GitHub 条目没有 npm 包可装，安装入口如实写成"按仓库 README 自行安装",
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
- **默认零外发**；联网动作有两个，都只在用户显式指定时运行：
  `catalog-sync`（同步目录）与 `report --live`（发现问题后当场现搜，只发问题类型关键词）

---

## 处方上限

- 默认 `limit = 4`（旧版是 2）
- 每个 finding 给 2 个名额（`perFinding = 2` 轮转）：第 1 个是确定对症的处方，
  第 2 个留给插件目录检索结果 —— 避免"能装的插件"被一句行为建议挤掉
- 能动手的排在纯建议前面（config/command/settings → plugin → behavior）
- 同一 (处方, 指标) 组合不重复给

旧版把上限压到 2 条，本意是"宁精勿滥"，但配合空靶池的结果是"看到问题却拿不到方案"。
现在的取舍是：**每条都必须是可执行动作**，在这个前提下允许最多 6 条。
（原为 4 条；第二轮评估后指标从 12 项增到 15 项，7 类问题抢 4 个名额会把最可执行的配置类建议挤掉，例如 E3 → spill 预算那一条。）

---

## 自检

```bash
./scripts/smoke.sh          # 203 项
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
