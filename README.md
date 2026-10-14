# agent-clinic · Agent 体检诊所

**装为 Skill**（一行命令，无需克隆、无需选位置、无需回答任何提问）：

```bash
curl -fsSL https://raw.githubusercontent.com/1687210989/agent-clinic/main/install.sh | bash
```

**装为 DSH 插件**（侧边栏 → **插件** → **添加插件**，粘贴下面这行）：

```bash
https://github.com/1687210989/agent-clinic.git
```

> 装成插件后有侧边栏「🩺 体检」入口和全页面板。**装完必须完全退出并重启 Harness**——插件只在启动时装载。

> **你的 Agent 体检诊所。** 只读扫描本地 Agent 会话，用**可逐条复核的证据**诊断真实发生的使用体验问题（token 浪费、死循环、跨会话失忆、资产闲置），并为每个问题开出可执行的处方。

[![node](https://img.shields.io/badge/node-%3E%3D22.15-blue)]()
[![license](https://img.shields.io/badge/license-MIT-green)]()
[![smoke](https://img.shields.io/badge/smoke-249%2F249-brightgreen)]()

---

## 它解决什么问题

大多数 Agent 使用分析工具只给你一堆统计数字，你看完也不知道该干什么。

agent-clinic 的做法不同：**它给证据，也给处方。**

- 不只说"你有死循环"，而是说"10 月 8 日这个会话，`list_agents` 用同样的参数失败了 4 次，在 `session.v4.jsonl.zstd#L101-L108`"——一条命令你就能自己复核。
- 不只给建议，而是给**可执行的动作**：能整段粘进 profile 的 YAML 片段、斜杠命令、已核实插件的安装入口，或明确说没有插件能解。
- **读你的真实配置**再开口：处方会说"你现在 `maxInlineTokens=12500`（随附默认，profile 未覆盖）→ 建议 6000"，而不是"建议调低一点"。当前值已经不弱于建议时，这条处方会被撤掉 —— **而且会写出来**（报告里的「已评估但未给出的处方」段会列出被撤的原因和当前值，你才能复核这个判断，不会以为"根本没有这条建议"）。
- **宁可承认做不到，也不假装有数据**：从未实现的维度一律列在报告里并写明原因。第二轮评估用原始日志证伪了旧的"数据源缺失"说法后，E3/N3/N4 从"不可实现"变成**已实现**；剩下的 K1/K2 也如实写成"隐私取舍下的方案未定"，而不是"平台做不到"。
- **检索插件目录做针对性推荐**：按「能力标签 + 关键词」匹配你的问题，并说明**为什么推荐它**（例如"能力标签 token-saving 对上 C1；你的问题描述里出现了 token、消耗"）。目录有三个来源并逐一标出：**人工核实 / npm registry 同步 / GitHub 核实**（经 `gh-proxy.com` 中继 GitHub API，按 star 数与最近更新检索；API 不通时退回人工种子清单 + `git ls-remote`）。**已经装过的插件不再推荐**，**官方内置包单独标注**（通常已随 dsh-base 挂载）。热度（star / 下载量）如实展示，只用于同分排序、不参与对症打分。
- **面板里一切皆可折叠**：问题卡点开能看到证据与**挂在它下面的处方**；处方卡点开才展开分步操作、片段、风险与出处。
- **同类型合并**：同一指标在多个会话命中（或同一种模式出现多次）只会显示**一张卡**并标出「N 处」，展开后每一处仍保留自己的会话、结论与证据定位 —— 不重复展示，也不丢信息。

> **不做的事**：不主动推送、不代你安装、不改你的配置、不诊断代码质量、不把任何对话内容发到外部。

---

## 诊断维度

**19 项已实现**

| ID | 名称 | 判定 | 严重度 |
|---|---|---|---|
| C1 | token 消耗过快 | 会话**单位请求** output 超主会话基线 2 倍（且总量 ≥2 万） | 高 |
| C2 | 上下文膨胀 | 末轮/首轮 input 增长 >10x 且 cacheRead <30% | 高 |
| C3 | 长会话疲劳 | 单会话消息数 >200 | 中 |
| C5 | 压缩可观测性 | 单会话压缩 ≥3 次，给出 **DSH 实测**释放 token（非估算） | 中 |
| C6 | 工具面成本 | 工具 schema >20000 字符（每请求重发）+ 窗口内 0 调用的工具 ≥5 个 | 中 |
| C7 | 上下文注入量 | 上下文被注入 ≥20 次且 ≥100000 字符 | 低 |
| E1 | 死循环 | 同工具 + 同参数 + 同错误，≥3 次 | 高 |
| E2 | 反复失败 | 会话工具错误率 >30% | 中 |
| E3 | 工具结果过大 | 单条工具结果 >8192 字符，会话内 ≥5 条 | 中 |
| E4 | 计划执行脱节 | 写计划后又大量调用工具，但 0 条完成 | 中 |
| E5 | 冗余重复调用 | 同工具 + 同参数 + 无错误，≥3 次 | 中 |
| N1 | 环境命令反复失败 | 命令类调用失败 ≥3 次 | 中 |
| N2 | 高风险操作 | 命令执行类工具命中 `rm -rf` / `--force` / `reset --hard` 等 | 高 |
| N3 | 权限审批摩擦 | 审批请求 ≥5 次（给出等待时长与被拒比例） | 中 |
| N4 | API 重试频繁 | 模型请求重试 ≥3 次（给出失败码与累计退避） | 中 |
| A2 | skill 闲置 | 已装 skill 在 ≥30 天**日历窗口**内 0 次触发 | 中 |
| A3 | 高频手动序列 | **非通用工具**的两步序列 ≥5 次（去镜像、跨会话合并） | 低 |
| A4 | 子代理开销 | `delegationDepth>0` 会话 token 占比 >40% | 中 |
| A5 | 辅助 LLM 开销 | 辅助模型调用（联网检索 / 会话标题）≥20 次，给出 maxTokens 上界 | 中 |

> **C5/C6/C7/A5 是第三轮新增的"实测数据源"**（依据 `agent-clinic-待优化报告-DSH单平台.md`）：
> C1/C2 是**推断**浪费，而 DSH 自己就把**实测值**写进了日志 ——
> 压缩释放了多少 token（`shadowedTokenCount`）、工具 schema 多大、上下文注入多少、
> 辅助请求跑了几次。这四项**零隐私代价**（只记数字），
> 本机实测：压缩释放 **638,171** token、工具 schema **29,779** 字符/请求、
> 注入 **158,393** 字符、辅助调用 **96** 次。定义与阈值见 [docs/diagnostics.md](docs/diagnostics.md)。

**1 项排期中**：A1 MCP 闲置（本机未配置 MCP，暂无数据源）

**2 项尚未实现（原因见下，都不是"平台做不到"）**

| ID | 名称 | 为什么还没做 |
|---|---|---|
| K1 | 跨会话失忆 | 本工具按隐私约束只记 `user/message` 的 `text_len`、不留正文（正文在日志里）。要做"你是否又在问同一个问题"，需改为记录**规范化文本指纹**（hash，不可复原）—— 方案未定 |
| K2 | 已解决重新排查 | 同 K1，依赖用户文本指纹 |

> E3 / N3 / N4 曾经也被列在上面这张表里，理由是"DSH 数据源缺失"。
> 第二轮评估（[docs/evaluation-2026-10-14.md](docs/evaluation-2026-10-14.md)）拿原始日志逐条证伪：
> 数据一直都在，是适配层没抽 —— 现已全部实现（只补长度/编号/结论，不落正文）。

> **未检测到异常 ≠ 已确认无异常。** 样本不足时（如 A2 的 30 天窗口），
> 报告会写「样本不足，无法判定」，而不是混在「未检测到异常」里。

---

## 当前状态

| 能力 | 状态 |
|---|---|
| DSH 会话解析（多帧 zstd） | ✅ 可用 |
| 统一事件模型 | ✅ 可用 |
| 聚合统计 | ✅ 可用 |
| 证据层 `show` | ✅ 可用 |
| **诊断指标 19 项** | ✅ **可用**（见上表） |
| **处方层（可执行：配置片段 / 命令 / 插件 / 设置 / 行为）** | ✅ **可用**（读本机真实配置，给出「当前值 → 建议值」；被撤掉的处方会写明原因） |
| **体检报告 `report`** | ✅ **可用** |
| **DSH 插件（侧边栏入口 + 报告面板 + 准实时角标）** | ✅ **可用** |
| **处方反馈闭环**（记住已拒绝 / 感兴趣） | ⏳ 待实现 |
| A1 MCP 闲置 | ⏳ 排期中（本机未配置 MCP，暂无数据源） |
| WorkBuddy 平台 | ⏳ 待实现 |

**M1 闭环已完成**：`./run.sh report` 产出带可复核证据 + 可执行处方的体检报告；DSH 插件有侧边栏入口、面板与准实时角标；冒烟测试 **249/249 通过**。

````bash
$ ./run.sh report

## Agent 体检报告（平台：DSH · 13 个会话）

扫描概览：13 会话 / 8058 行 / 1387 次工具调用 / 错误率 6.5%
token：input 1,871,421 · output 781,317 · cacheRead 197,114,880

### 发现 7 类问题（共 10 处 · 按严重度排序）

**[高] C1 token 消耗过快** —— 1 处
- 结论：1 个会话单位请求 output 高于同类会话基线（最高 2.4 倍）：每请求 1,423.208 token
- 影响估算：相对基线约多消耗 40,415 output token；注意：产出量大不必然是浪费，
  请结合 E1（死循环）/E5（冗余调用）/C2（上下文膨胀）判断
- 置信度：中
  1. 会话 32fd3d17-6ab：本会话单位请求 output 1,423.208（共 68,314 / 48 次请求），
     是主会话基线 581.231 的 2.4 倍（阈值 2 倍）
     - 证据定位：…/session-32fd3d17-6ab0-40e1-8bfa-21545f099428/session.v4.jsonl.zstd#L378
     - 复核命令：./run.sh show "…/session.v4.jsonl.zstd#L378"

**[中] N3 权限审批摩擦** —— 1 处
- 结论：审批请求 24 次，集中在 pwsh(24)，等待审批中位 104.5 秒
- 证据定位：…/session-c067f917-f18/session.v4.jsonl.zstd#L120

**[中] E3 工具结果过大** —— 3 处（3 个会话）
- 结论：3 个会话存在超大工具结果（单条 >8K 字符）
  1. 会话 8383b82c-f69：工具结果 39 条中有 10 条超过 8,192 字符（累计 264,266 字符，
     最大一条 49,930 字符），主要来自 web_fetch(10 条)

**[低] A3 高频手动序列** —— 1 处
- 结论：1 类可固化序列：web_search↔web_fetch 28 次

### 未检测到异常的维度
- C2 上下文膨胀 / E1 死循环 / E2 反复失败 / N1 / N4 / A4
- A2 skill 闲置 —— 扫描窗口仅 3.0 天（需 30 天），样本不足

### 处方（6 条 · 每条都有可执行动作）

> 配置类处方改的是这份文件（本工具只读它，不代你改）：`~/.dsh/profiles/desktop/cordis.patch.yml`

1. **【装插件】装 Smart Compaction（模型择机压缩 + 用量可见）** —— 针对 C1
   - 具体怎么做：
     1. 打开侧边栏 → 插件 → 添加插件
     2. 在输入框里粘贴包名并回车：smart-compaction
   - 依据：模型自己择机压缩，并让真实用量可见。
   - 怎么确认有效：重跑 ./run.sh report，看 C1 是否还命中。
2. **【改配置】收紧工具结果的 spill 预算（最能省 input 的一档）** —— 针对 E3
   - 具体怎么做：
     1. 用任意文本编辑器打开：`~/.dsh/profiles/desktop/cordis.patch.yml`
     2. 搜索这一行：`- id: spill-policy`
     3. 把 `config:` 整段替换成下面这段（profile patch 按 id 定位、**整体替换**该行 config）
   - 改成（可整段粘进 profile patch）：
     ```yaml
     - id: spill-policy
       name: '@deepseek-ai/dsh-spill-policy'
       config:
         maxInlineTokens: 6000
     ```
   - 依据：超过预算的工具结果落到磁盘，内联只留首尾与文件路径，直接砍掉最大块的 input。
   - 风险提示：被省略的中间内容模型看不到，需要时它得自己 read/grep 那个 spill 文件。
   - 怎么确认有效：重跑 ./run.sh report，看 C2 的末轮 input 是否回落。
3. **【行为建议】把常用低风险工具放进权限预设** —— 针对 N3
   - 具体怎么做：
     1. 打开 ./run.sh report，看 N3 给出的"审批集中在哪些工具"
     2. 侧边栏 → 插件 → 权限/审批设置，把高频低风险的那几个加进允许列表
     3. 改完重启，下轮看 N3 的等待中位数是否下降
…（共 6 条，其余为命令 / 设置 / 行为类）

### 省 token 开关清单（本机真实存在，供按需调整）

> 这是**工具陈列**，不是体检结论 —— 本次未触发对应指标，列出来是因为你随时可以拧它们。

- **【改配置】收紧历史工具结果的剪枝阈值**
  - 当前：thresholdChars=8192 · headChars=4096 · tailChars=1024 → 建议：4096 / 2048 / 512
- **【装插件】装 smart-compaction**
  - 安装：侧边栏 → 插件 → 添加插件 → 粘贴 smart-compaction

### 尚未实现的维度（原因见下，都不是"平台做不到"）
- K1 跨会话失忆 —— 适配层按隐私约束只记 user/message 的 text_len、不留正文（正文在日志里，
  但本工具不落盘）。要做跨会话"你是不是又在问同一个问题"，需改为记录**规范化文本指纹**
  （hash，可复原性为零）—— 方案未定，未排期
- K2 已解决重新排查 —— 同 K1：同样依赖用户文本指纹，未排期

### 已评估但未给出的处方（1 条）

> 这些建议本可针对下面的问题，但按**你当前的配置**判断"已经达标或不需要" ——
> 列出来是为了让你能复核这个判断。

- C1 · 调低默认推理强度（当前：provider="deepseek-account", model="deepseek-flash",
  reasoningEffort="low"） —— 未给出原因：reasoningEffort 已经是 low（最低档），
  output 高只能从"任务拆小"入手
````

> 关于"哪些开关能省 token、出处是什么、怎么复核"，
> 见 [docs/remedies.md](docs/remedies.md)（含 asar 解包命令与 npm 核实方式）。

---

## 安装

### 一行安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/1687210989/agent-clinic/main/install.sh | bash
```

**无需克隆、无需选位置、无需回答任何提问** —— 脚本会自动：

1. 从 GitHub 拉取源码
2. 定位可用的 Node（**不要求 node 在 PATH 上**）
3. 自动检测已安装的平台（DSH / WorkBuddy）并部署到对应 skills 目录
4. 已存在旧版本时先备份，绝不直接删除

装完对 Agent 说「**体检一下**」即可触发。

> **镜像 / 备用地址**
>
> 中国大陆网络下 `raw.githubusercontent.com` 可能不稳定，可用 jsDelivr（**必须带 tag**，分支 `@main` 会被重定向回 raw，起不到加速作用）：
> ```bash
> curl -fsSL https://cdn.jsdelivr.net/gh/1687210989/agent-clinic@v0.1.1/install.sh | bash
> ```
> 若遇到 `curl: (35)` 证书吊销检查错误（常见于国内网络），加 `--ssl-no-revoke`：
> ```bash
> curl -fsSL --ssl-no-revoke https://raw.githubusercontent.com/1687210989/agent-clinic/main/install.sh | bash
> ```

### 克隆安装（想读源码时）

```bash
git clone https://github.com/1687210989/agent-clinic.git
cd agent-clinic
./install.sh
```

### 常用参数

```bash
./install.sh --dry-run          # 预览，不写入
./install.sh --dsh-only         # 只装 DSH
./install.sh --workbuddy-only   # 只装 WorkBuddy
./install.sh --target ~/my/skills   # 指定目录
./install.sh --ref v0.1.1       # 指定版本（以 git tag 为准）
```

### 另：作为 DSH Plugin（原生工具 + UI 面板）

**推荐用应用内界面装**（桌面版的 profile 由应用独占，CLI 改不了）：

侧边栏 → **插件** → **添加插件** → 粘贴下面这行 →

```bash
https://github.com/1687210989/agent-clinic.git
```

→ **安装** → 装完点 **立即启用** → **完全退出并重启 Harness**。

也可以走 CLI（仅对自建 profile 有效，桌面版 `desktop` profile 会报
`profile "desktop" is managed exclusively by the Electron application`）：

```bash
dsh plugin --profile <profile> add -w git+https://github.com/1687210989/agent-clinic.git
```

> ⚠️ CLI 方式下 `-w`（workspace root）是必须的，漏掉会报 `ERR_PNPM_ADDING_TO_ROOT`。
> 完整步骤见 [DSH 插件指南](../agent-clinic-DSH插件发布与安装指南.md)。

装好后额外得到：

- 3 个模型可见工具：`agent_clinic_scan`、`agent_clinic_show`、`agent_clinic_report`
- 侧边栏「🩺 体检」入口 + 全页面板（见下节）
- **准实时角标**：对话过程中每 6 秒检查一次，发现新问题会在按钮上亮红点

### 插件带 UI 面板

作为 DSH 插件安装后，会在侧边栏底部多一个**「🩺 体检」按钮**，点开是**全页面板**，直接展示体检报告（含问题卡、证据定位、处方卡、未检测到的维度、尚未实现的维度，以及**被撤掉的处方与原因**）。

| 位置 | 插槽 | 内容 |
|---|---|---|
| 侧边栏底部 | `sidebar.footer.action` | 「🩺 体检」入口按钮（带未读角标） |
| 覆盖层面板 | `shell.overlay` | 体检报告：指标格 / 问题卡 / 处方卡 / 撤销处方 / 插件目录 |

数据流：面板 → `fetch('/api/agent-clinic/report')` → 宿主半路由 → `buildReport()` → JSON。
该路由**只读本地会话，零外发**。

面板右上角还有一个 **「联网现搜插件」** 按钮：点它才会走 `fetch('/api/agent-clinic/live')`，
按本次发现的问题**当场**去 npm registry 与 GitHub 检索插件（不点就不联网）。
只发送问题类型关键词（如 `context compression`），**不发送任何会话内容**，
面板与报告里会列出实际发出的检索词；默认 10s 预算，到点带已有结果返回并标注降级。

> **纯 JavaScript 手写，无构建步骤** —— 客户端入口 `plugin/client.js` 通过
> `window.__ModuleLoader__.load` 注册，React 取自宿主浏览器模块表。
> 各插槽注册彼此隔离：某个插槽不可用时不会拖垮整个插件。
> 若面板提示「宿主仍是旧版」，说明插件更新后没完全重启 Harness。

**零依赖** —— 不需要 `npm install`，只需要 Node ≥ 22.15（用于原生 zstd 解码）。
**node 不必在 PATH 上** —— `run.sh` 与 `install.sh` 会自动定位它。

### 更新插件

插件**安装后不会自动更新**。仓库推送新代码后，按下面步骤：

1. 侧边栏 → **插件** → 找到 agent-clinic → **卸载**（会要求确认）
2. **添加插件** → 重新填 `https://github.com/1687210989/agent-clinic.git` → 安装 → 立即启用
3. **完全退出 DeepSeek Harness**（从托盘/任务栏退出，不是关窗口）
4. 重新打开

> ⚠️ **第 3 步不能省。** 插件只在启动时装载，不重启进程里还是旧代码。
>
> 面板已内置识别：如果出现「宿主仍是旧版，请完全退出并重启 Harness」的提示条，
> 就是在告诉你这件事。

### 两种路径对比

| | Skill | Plugin |
|---|---|---|
| 安装位置 | `~/.agents/skills/agent-clinic/` | `$DSH_HOME/profiles/<p>/node_modules/` |
| 需要重启 | 否 | **是** |
| 能力 | 提示词 + CLI | 原生工具（模型可直接调用）+ 面板 |
| 状态 | ✅ 可用 | ✅ 可用（面板 + 准实时角标；需完全重启 Harness 才会装载新代码） |

---

## 使用

```bash
./run.sh report      # 体检报告（推荐入口，同时写入 agent-clinic-report.md）
./run.sh scan        # 扫描概览
./run.sh diagnose    # 只跑诊断
./run.sh show "~/.dsh/sessions/<...>/session.v4.jsonl.zstd#L101-L108"   # 展开证据
./run.sh catalog     # 看插件目录（来源、能力标签、热度、中文简介覆盖情况）
./run.sh catalog-sync            # 联网同步插件目录（唯一会写盘 + 联网的只读工具命令）
./run.sh catalog-sync --pool 900 --limit 150 --gh-discover 40   # 加大候选池与收录数
./scripts/smoke.sh   # 自检（249 项）
```

> **node 不必在 PATH 上** —— `./run.sh` 会自动定位（PATH → WorkBuddy 托管目录 → DSH 运行时 → nvm / volta / fnm / Program Files）。
> 若自动定位失败，用 `AGENT_CLINIC_NODE=/path/to/node ./run.sh scan` 显式指定。
> 若你环境里 node 已在 PATH 上，也可以直接用 `node src/cli.mjs scan`。

`scan` 输出示例：

```
扫描目录：C:\Users\you\.dsh\sessions
会话文件：4

  32fd3d17-6ab  帧=233 行=432 调用= 74 错误= 8 in=151,210 out=68,314  GitHub 高星项目可行性推断
  ...

===== 合计 =====
会话=4  帧=463  行=994  助手消息=85  用户消息=22
工具调用=220  错误=16  错误率=7.3%
input=421,174  output=112,140  cacheRead=6,447,872  cacheWrite=0
cacheRead 占比=93.9%
TOP 工具：web_fetch 156 · web_search 26 · pwsh 13 · list_agents 4
```

---

## 架构

```
触发（"体检一下"）
  │
  ▼
L0 适配层   多帧 zstd 解码 → 统一事件模型（带全局行号）
  ▼
L1 信号层   运行时统计 / 工具调用序列 / 错误复现
  ▼
L2 诊断层   指标判定（阈值 + 防误报）
  ▼
L3 证据层   file#L 定位 · 可展开 · 可复现   ← 护城河
  ▼
L4 处方层   问题 → 可执行处方（≤6 条，须自证有效）   ← 读本机真实配置，给"当前值 → 建议值"；被撤掉的会写明原因
  ▼
L5 输出层   体检报告 + 证据清单 + 处方卡片 + 省 token 开关清单 + 插件目录检索
```

---

## 隐私

- 诊断**全流程本地**完成，会话文件**只读**
- **默认零外发**（插件元数据打包在仓库内，体检本体不发起任何网络请求；联网只有两个显式动作：`catalog-sync` 与 `report --live`/面板的「联网现搜」按钮，检索词只含问题类型）
- 无遥测、无崩溃上报
- 状态文件只存"日期 + 一句话摘要"，不存对话原文
- 删除状态文件即完全重置

---

## 已知限制

- **只支持 DSH v4 会话格式**；v3 / 无压缩格式兼容待验证
- 需要 Node ≥ 22.15（低版本会明确报错，不会静默跳过数据）；node 不在 PATH 上也没关系，会自动定位
- **19 项诊断指标已实现**，1 项排期（A1 MCP 闲置），2 项尚未实现（K1/K2，报告会写明原因 —— 是隐私取舍而非平台做不到）
- 处方里的「随附默认值」是一份**抄录表**（出处 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`），
  升级 DSH 后若随附默认值变了，需要同步这份表；用户 profile 的真实覆盖值一律现读，不靠猜
- 配置层只解析 `cordis.patch.yml` 里用到的那个 YAML 子集（顶层 `- id/name/config` + 标量与列表），
  更深的嵌套结构会被忽略并在 `warnings` 里说明
- 需要 `~/.agents/skills/` 目录存在（`install.sh` 会自动创建）
- 版本以 git tag 为准；`install.sh` 现在会在装完后打印版本与安装位置（此前不打印）
- **C3 已接线 compaction**：只数"最后一次压缩之后仍活着"的消息 ——
  被压缩遮蔽的历史不再占用上下文，所以"靠 `/compact` 续命的长会话"不会被误报疲劳

### 已知缺陷（已记录、尚未修）

第二轮评估发现的问题已在 2026-10-14/15 两轮整改中修掉大部分
（C1 基线、A2 判定与窗口、A3 噪声、E3/N3/N4 落地、静默降级、撤销处方可见性、
证据区间展开、复核命令跨平台、`reasoning-effort` 改写 provider、C3 接线 compaction、
文档漂移 —— 详见 [docs/evaluation-2026-10-14.md](docs/evaluation-2026-10-14.md) 的"整改情况"）。
**下面这些仍未修**：

| 缺陷 | 影响 |
|---|---|
| ~~配置旋钮未接线~~ | ✅ 第三轮验收时修掉：`maxSessions` / `minRepeatCount` / `contextLines` 现在都真的生效（插件四条路径 + CLI `show --context`），并且**有功能测试守着** |
| **定位符解析仍有两份** | `src/adapters/base.mjs` 的 `parseLocator`（不支持区间）与 `src/evidence/index.mjs` 的 `parseRange`（支持区间）—— 调用方要自己选对那个 |
| **`show` 的区间展开有 200 行上限** | 超长区间会截断并提示，需要看别处得用 offset/limit 分段复核 |
| **A3 的通用工具清单是硬编码** | 插件生态新增的通用工具不在清单里时，A3 可能重新变吵（阈值可用 `opts` 覆盖，但清单本身要先改代码） |

### ⚠️ 关于 DSH 数据格式

DSH 会话文件是**多帧 zstd 拼接**（单个文件实测含 60~233 个帧）。
`zlib.zstdDecompressSync()` 和流式 API **都只能解出第一帧**。
本项目的 `src/adapters/zstd-frames.mjs` 按 magic number 手工切帧，已在真实数据上验证 463/463 帧成功。详见 [docs/data-formats.md](docs/data-formats.md)。

---

## 路线图

- **M1** ✅ DSH 解码 + E1/E2/E5 诊断 + 证据层 + 体检报告（最小闭环已打通）
- M2 ✅ 扩展 C1/C2/C3/E4/N1/N2/A2/A3/A4（当时 12 项，现共 19 项）
- M3 ✅ 处方层重写：读本机真实配置 + 可执行处方（配置片段 / 命令 / 插件 / 设置 / 行为）+ 省 token 开关清单
- **M3.6 ✅ 第二轮评估整改**（[docs/evaluation-2026-10-14.md](docs/evaluation-2026-10-14.md)）：
  修 C1 基线 / A2 判定前提 / A3 噪声；E3、N3、N4 从"不可实现"变为已实现（15 项）；
  去掉"读不到伪装成没有数据"的静默降级；被否决的处方显式列出；文档与代码加一致性断言
- **M3.7 ✅ 第三轮：开采 DSH 实测数据源**（依据 `agent-clinic-待优化报告-DSH单平台.md`）：
  C5 压缩可观测性（实测释放 638,171 token）/ C6 工具面成本（schema 29,779 字符每请求）/
  C7 上下文注入量 / A5 辅助 LLM 开销（96 次调用此前完全不可见）→ 19 项；
  C3 接线 compaction；A2 窗口改日历跨度；报告 token 口径声明 + 辅助调用上界；
  证据区间展开 `-L<end>`；复核命令跨平台；`reasoning-effort` 不再改写 provider
- **M3.8 ✅ 第三轮工程基建**：CI（三平台 × node 22/24）、`joinPath` 跨平台、
  `install.sh` 三处修复、版本与 tag 对齐、CHANGELOG、删死代码 `src/state.mjs` 等 6 处、
  合并已分叉的 `resolveDshHome` / `fetchJson` / `mapLimit`
- M3.5 ⏳ 处方四重过滤 + 反馈闭环（记住已拒绝 / 感兴趣）
- M4 体检报告卡片（可分享）
- M5 ✅ 开源发布（SKILL.md / install.sh / 文档）
- M6 全维度 + 生态接入
- M7 WorkBuddy 平台

---

## License

MIT
