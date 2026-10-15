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
[![smoke](https://img.shields.io/badge/smoke-322%2F322-brightgreen)]()
[![CI](https://github.com/1687210989/agent-clinic/actions/workflows/ci.yml/badge.svg)](https://github.com/1687210989/agent-clinic/actions/workflows/ci.yml)

> `smoke N/N` 是**本地自检的通过数**（由 smoke 自己在跑完后核对，数字对不上就以退出码 1 结束）——
> 想知道 CI 此刻是红是绿，看旁边那枚 **CI** 徽章（它就是 GitHub Actions 的实况，改不了）。

---

## 它解决什么问题

大多数 Agent 使用分析工具只给你一堆统计数字，你看完也不知道该干什么。

agent-clinic 的做法不同：**它给证据，也给处方。**

- 不只说"你有死循环"，而是说"10 月 8 日这个会话，`list_agents` 用同样的参数失败了 4 次，在 `session.v4.jsonl.zstd#L101-L108`"——一条命令你就能自己复核。
- 不只给建议，而是给**可执行的动作**：能整段粘进 profile 的 YAML 片段、斜杠命令、已核实插件的安装入口，或明确说没有插件能解。
- **读你的真实配置**再开口：处方会说"你现在 `maxInlineTokens=12500`（随附默认，profile 未覆盖）→ 建议 6000"，而不是"建议调低一点"。当前值已经不弱于建议时，这条处方会被撤掉 —— **而且会写出来**（报告里的「已评估但未给出的处方」段会列出被撤的原因和当前值，你才能复核这个判断，不会以为"根本没有这条建议"）。
- **宁可承认做不到，也不假装有数据**：从未实现的维度一律列在报告里并写明原因。第二轮评估用原始日志证伪了旧的"数据源缺失"说法后，E3/N3/N4 从"不可实现"变成**已实现**；K1/K2 曾如实写成"隐私取舍下的方案未定"，2026-10-15 定案（写入本地加盐指纹快照）后也已实现 —— 现在报告里"尚未实现的维度"是**空的**，而这一节会保留并显示"没有"。
- **检索插件目录做针对性推荐**：按「能力标签 + 关键词」匹配你的问题，并说明**为什么推荐它**（例如"能力标签 token-saving 对上 C1；你的问题描述里出现了 token、消耗"）。目录有三个来源并逐一标出：**人工核实 / npm registry 同步 / GitHub 核实**（经 `gh-proxy.com` 中继 GitHub API，按 star 数与最近更新检索；API 不通时退回人工种子清单 + `git ls-remote`）。**已经装过的插件不再推荐**，**官方内置包单独标注**（通常已随 dsh-base 挂载）。热度（star / 下载量）如实展示，只用于同分排序、不参与对症打分。
- **面板里一切皆可折叠**：问题卡点开能看到证据与**挂在它下面的处方**；处方卡点开才展开分步操作、片段、风险与出处。
- **同类型合并**：同一指标在多个会话命中（或同一种模式出现多次）只会显示**一张卡**并标出「N 处」，展开后每一处仍保留自己的会话、结论与证据定位 —— 不重复展示，也不丢信息。

> **不做的事**：不主动推送、不代你安装、不改你的配置、不诊断代码质量、不把任何对话内容发到外部。

---

## 诊断维度

**21 项已实现**

| ID | 名称 | 判定 | 严重度 |
|---|---|---|---|
| C1 | token 消耗过快 | 会话**单位请求** output 超**其余主会话**基线 2 倍（基线逐会话排除自身；且总量 ≥2 万） | 高 |
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
| N3 | 权限审批摩擦 | 审批请求 ≥5 次（给出等待时长，以及**被拒 / 结果无法识别 / 无对应决定记录**三者分列） | 中 |
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

**0 项尚未实现**（K1/K2 已于 2026-10-15 按决策 D4 实现，见下表）

| ID | 名称 | 判定 | 隐私代价 |
|---|---|---|---|
| K1 | 跨会话失忆 | 同一用户文本指纹出现在 **≥3 个**不同会话（两次可能是正常追问） | 需要把**加盐哈希**写入本地快照 `~/.agent-clinic/text-fingerprints.json`（正文不落盘）；`agent-clinic fingerprints --clear` 可删、`AGENT_CLINIC_NO_FINGERPRINT_STORE=1` 可关 |
| K2 | 已解决重新排查 | 同一指纹在 ≥2 个会话出现，较晚那次之后有失败/重试，而最早那次之后没有（**软信号，只给"低"+措辞"疑似"**） | 同上 |

> K1/K2 曾长期挂在"尚未实现"里，理由写的是"隐私取舍、方案未定"。2026-10-15 你选了
> **写入本地快照**这一档，于是它们从"方案未定"变成已实现 —— 代价与边界见
> [docs/diagnostics.md](docs/diagnostics.md) 的实现状态一节。

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
| **诊断指标 21 项** | ✅ **可用**（见上表） |
| **处方层（可执行：配置片段 / 命令 / 插件 / 设置 / 行为）** | ✅ **可用**（读本机真实配置，给出「当前值 → 建议值」；被撤掉的处方会写明原因） |
| **体检报告 `report`** | ✅ **可用** |
| **DSH 插件（侧边栏入口 + 报告面板 + 准实时角标）** | ✅ **可用** |
| **处方反馈闭环**（记住已拒绝 / 感兴趣） | ⏳ 待实现 |
| A1 MCP 闲置 | ⏳ 排期中（本机未配置 MCP，暂无数据源） |
| WorkBuddy 平台 | ⏳ 待实现 |

**M1 闭环已完成**：`./run.sh report` 产出带可复核证据 + 可执行处方的体检报告；DSH 插件有侧边栏入口、面板与准实时角标；冒烟测试 **322/322 通过**。

**输出示例**（2026-10-15 之前某次实跑的原文快照，数字随本机数据变化）：

> N3 与 C1 的口径此后有变更 —— N3 现在分列「被拒 / 结果无法识别 / 无对应决定记录」，
> C1 基线改为**排除被判会话自身**（同一组数据下倍率会比旧口径更高）。
> 你重跑得到的是当前口径，下面的数字不必逐字对齐。

````bash
$ ./run.sh report

## Agent 体检报告（平台：DSH · 27 个会话）

扫描概览：27 会话 / 809 行 / 98 次工具调用 / 错误率 18.4%
token（**仅主对话**：assistant/message 的 usage）：input 791,000 · output 702,700 · cacheRead 0
辅助调用（**不计入上者**，DSH 未给它们记 usage）：联网检索 12 次 · 会话标题 10 次，按各自 maxTokens 上界估算 ≤49,792 token（模型 deepseek-v4-flash）

### 发现 19 类问题（共 31 处 · 按严重度排序）

**[高] C1 token 消耗过快** —— 2 处（2 个会话）
- 结论：2 个会话单位请求 output 高于同类会话基线（最高 33.3 倍）：每请求 5,000 token / 每请求 5,000 token
- 影响估算：相对基线约多消耗 97,000 output token；注意：产出量大不必然是浪费，请结合 E1（死循环）/E5（冗余调用）/C2（上下文膨胀）判断
- 置信度：中
  1. 会话 11111111-111：本会话单位请求 output 5,000（共 50,000 / 10 次请求），是主会话基线 150 的 33.3 倍（阈值 2 倍；基线为排除本会话后的其余主会话中位值）
     - 证据定位：…/sessions/--C-work-synth--/11111111-…-000000000001/session.v4.jsonl.zstd#L3
     - 复核命令：./run.sh show "…/session.v4.jsonl.zstd#L3"

…（中间 17 类问题略，形制相同：C2 C3 C5 C6 C7 · E1 E2 E3 E4 E5 · N1 N2 N4 · A2 A3 A4 A5，
每处都带「结论 / 影响估算 / 置信度 / 证据定位 / 复核命令」）…

**[中] N3 权限审批摩擦** —— 1 处
- 结论：审批请求 6 次，集中在 write(3)、pwsh(3)，等待审批中位 120.0 秒，被拒 2 次，结果无法识别 1 次
- 置信度：高
  1. 会话 dddddddd-ddd：审批请求 6 次，集中在 write(3)、pwsh(3)，等待审批中位 120.0 秒，被拒 2 次，结果无法识别 1 次
     - 证据定位：…/session.v4.jsonl.zstd#L3

### 处方（8 条 · 每条都有可执行动作）

> 名额说明：本次共 27 条可给处方，本清单按"每类问题轮转 + 严重度顺序"取前 8 条；另有 **19 条** 因名额未在此列出（各类问题卡片里的处方不受此限）。

> 配置类处方改的是这份文件（本工具只读它，不代你改）：`~/.dsh/profiles/desktop/cordis.patch.yml`

1. **【行为建议】把长任务拆成多个短会话** —— 针对 C1
   - 具体怎么做：
     1. 在当前会话里说一句：「先把进度写成交接文件：当前目标、已完成、已确认的结论、下一步、涉及的文件路径」
     2. 让 Agent 把交接写到工作区的一个固定文件（例如 HANDOFF.md），确认文件真的写出来了
     3. 新开一个会话，把交接文件路径贴进去，让 Agent 先读它再开工
     4. 旧会话不要继续追加需求 —— 留着当存档，需要时用 ./run.sh show 复核
   - 依据：output 高通常来自"一个会话里想做太多事"，拆分是零成本且立刻见效的一步。
   - 风险提示：拆会话会丢掉原会话的上下文，必须靠交接文件补齐；交接写得太粗会重复劳动。
   - 怎么确认有效：重跑 ./run.sh report，看 C1 是否还命中；命中会话的 output 应回落到基线附近。
   - 出处：agent-clinic · 行为处方（本工具生成）· 核实于 2026-10-15 · src/prescriber/remedies.mjs

2. **【改配置】收紧工具结果的 spill 预算（最能省 input 的一档）** —— 针对 C2
   - 改成（可整段粘进 profile patch）：
     ```yaml
     - id: spill-policy
       name: '@deepseek-ai/dsh-spill-policy'
       config:
         maxInlineTokens: 6000
     ```
   - 风险提示：被省略的中间内容模型看不到，需要时它得自己 read/grep 那个 spill 文件。
   - 怎么确认有效：./run.sh report 再看 C2 的末轮 input。
   - 出处：@deepseek-ai/dsh-spill-policy（随附插件）· 核实于 2026-10-15

…（余下 6 条同形：每条都有「具体怎么做 / 风险提示 / 怎么确认有效 / 出处」）…

### 未检测到的维度（9）
- C7 上下文注入量 · N4 API 重试频繁 · A3 高频手动序列 · A5 辅助 LLM 开销 …（每个都附一句"为什么这次不报"）

### 尚未实现的维度

- 没有 —— 21 项已实现，1 项（A1 MCP 闲置）排期中（本机未配置 MCP，没有可判定的数据源）。

---

指纹：本次新增 435 条观测 → ~/.agent-clinic/text-fingerprints.json（累计 218 个指纹 / 435 条观测；只存加盐哈希，正文不落盘）
证据可复核 · 全程本地 · 零外发

报告已写入：<工作区>/agent-clinic-report.md
````

> 关于"哪些开关能省 token、出处是什么、怎么复核"，
> 见 [docs/remedies.md](docs/remedies.md)（含 asar 解包命令与 npm 核实方式）。

---

## 安装

**当前版本：`0.2.0-rc.1`（预发布通道）** —— 版本以 git tag 为准（`v0.2.0-rc.1`）。
npm 通道已开放：`npm i -g agent-clinic@next`（该 RC 目前也是 `latest`，因为这是首个发布版本）。
放行检查记录见 [docs/release-gate-2026-10-15.md](docs/release-gate-2026-10-15.md)。

### 一行安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/1687210989/agent-clinic/main/install.sh | bash
```

**无需克隆、无需选位置、无需回答任何提问** —— 脚本会自动：

1. 从 GitHub 拉取源码
2. 定位可用的 Node（**不要求 node 在 PATH 上**）
3. 自动检测已安装的平台（DSH / WorkBuddy）并部署到对应 skills 目录
4. 已存在旧版本时先备份，绝不直接删除

> ⚠️ **关于 WorkBuddy**：检测到 `~/.workbuddy` 时脚本会把 skill 装过去，
> 但当前**只有 DSH 会话适配器** —— 装在 WorkBuddy 上扫不到它的会话数据
> （脚本自己也会打印这条提示，见"已知缺陷"）。WorkBuddy 适配未排期。

装完对 Agent 说「**体检一下**」即可触发。

> **镜像 / 备用地址**
>
> 中国大陆网络下 `raw.githubusercontent.com` 可能不稳定，可用 jsDelivr（**必须带 tag**，分支 `@main` 会被重定向回 raw，起不到加速作用）：
> ```bash
> curl -fsSL https://cdn.jsdelivr.net/gh/1687210989/agent-clinic@v0.2.0-rc.1/install.sh | bash
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
./install.sh --ref v0.2.0-rc.1  # 指定版本（以 git tag 为准）
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
./run.sh fingerprints            # 查看我本地的文本指纹快照（K1/K2 的数据基础；只存加盐哈希）
./run.sh fingerprints --clear    # 删除该快照
./scripts/smoke.sh   # 自检（322 项）
node scripts/plugin-dom.test.mjs # 插件面板的零依赖 DOM 桩测试（106 项）
```

**关于 `show` 的翻页**（决策 D8）：区间超过 200 行时默认只展开一页，并直接给出**可复制**的下一条命令：

```bash
./run.sh show "<file>#L2-L211" --limit 20          # 每页 20 行
./run.sh show "<file>#L2-L211" --offset 20 --limit 20   # 照抄提示里的 offset 看下一页
./run.sh show "<file>#L2-L211" --limit 5000        # 一次看全（上限 5000 行）
```

**关于指纹快照的隐私边界**（决策 D4）：`~/.agent-clinic/text-fingerprints.json` 里只有
`sha256(盐 + 规范化用户文本)` 的前 32 位十六进制 —— 正文不落盘、不进报告；短于 12 字符
（"继续""好的"）不生成指纹；设 `AGENT_CLINIC_NO_FINGERPRINT_STORE=1` 可整体关闭，
关闭或快照损坏时 K1/K2 会在报告里写明**未采集**（不是"没问题"）。
若本工具跑在受限沙箱里（例如 DSH 的 workspace-write 模式），写 `~/.agent-clinic/` 可能被拒 ——
报告会明确说"**已判定但没存下**"（本次照样判定了，只是跨会话历史没累积），
而不是含糊地报一句"未判定"。

**自检两种跑法**（第三方评估 §3.1 的整改）：

- **完整自检**（推荐，也是 CI 的跑法）：先用合成语料装置造一份确定性会话，
  再要求"跳过数必须为 0"—— 无数据时"跳过"会直接变成失败，降级不得冒充全绿：

  ```bash
  node scripts/fixtures/synth-dsh.mjs --out .tmp/synth-home   # 覆盖 21 项指标，固定时间戳
  node scripts/fixtures/synth-dsh.mjs --verify                # 每项指标都要被触达，命中 0 即非零退出
  DSH_HOME=.tmp/synth-home DSH_SMOKE_REQUIRE_DATA=1 \
    AGENT_CLINIC_SKILL_DIRS=.tmp/synth-home/agents-skills node scripts/smoke.mjs
  ```

  A2「skill 闲置」的一半输入是"这台机器装了哪些 skill"（默认读 `~/.agents/skills`、
  `~/.workbuddy/skills`）—— CI 与合成自检用 `AGENT_CLINIC_SKILL_DIRS` 指向语料自带的
  demo skill 目录，免得断言绑在宿主机上。

- **降级自检**（无 DSH 会话的环境）：跑得动的照跑，跳过项如实列出并以退出码 0 结束
  （`通过 p · 失败 f · 跳过 s`）。此时徽章不做核对（通过数不可比），且**不会**把跳过算成失败。
- **徽章守护**：完整跑完且全绿时，smoke 会核对 `README.md` / `SKILL.md` 里声称的条数
  （徽章、`冒烟测试 N/N 通过`、`自检（N 项）`）与实际是否一致，不一致即以退出码 1 结束；
  确认无误后用 `node scripts/smoke.mjs --write-badge` 回写。


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
L4 处方层   问题 → 可执行处方（≤8 条，须自证有效）   ← 读本机真实配置，给"当前值 → 建议值"；被撤掉的会写明原因
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
- **21 项诊断指标已实现**，1 项排期（A1 MCP 闲置），**0 项尚未实现**（K1/K2 于 2026-10-15 按决策 D4 实现）
- 处方里的「随附默认值」是一份**抄录表**（出处 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`），
  升级 DSH 后若随附默认值变了，需要同步这份表；用户 profile 的真实覆盖值一律现读，不靠猜
- 配置层只解析 `cordis.patch.yml` 里用到的那个 YAML 子集（顶层 `- id/name/config` + 标量与列表），
  更深的嵌套结构会被忽略并在 `warnings` 里说明
- 需要 `~/.agents/skills/` 目录存在（`install.sh` 会自动创建）
- 版本以 git tag 为准；`install.sh` 现在会在装完后打印版本与安装位置（此前不打印）
- **C3 已接线 compaction**：只数"最后一次压缩之后仍活着"的消息 ——
  被压缩遮蔽的历史不再占用上下文，所以"靠 `/compact` 续命的长会话"不会被误报疲劳

### 已知缺陷

这张表**只列当前仍未修**的缺陷。修掉的移入下面"已关闭"，并且自检里有一条守护断言
（把已修条目重新写回"未修"会直接红）—— 文档漂移和代码 bug 一样，都要有东西拦着。

**已关闭**（每条都有断言或测试守着；决策号见 [docs/plan-2026-10-15.md](docs/plan-2026-10-15.md)）：

| 曾经的问题 | 现状 |
|---|---|
| 配置旋钮未接线 | ✅ 第三轮验收修掉：`maxSessions` / `minRepeatCount` / `contextLines` 在插件四条路径 + CLI 都真的生效 |
| 定位符解析有两份 | ✅ 第五轮 D7 合并为一份：`src/evidence/index.mjs` 的 `parseRange` 只是 `src/adapters/base.mjs` `parseLocator` 的转发，后者已支持 `#L<a>-L<b>` |
| `show` 区间展开有 200 行硬上限 | ✅ 第五轮 D8 改为显式分页 `--offset/--limit`（上限 5000），截断提示直接给**可复制**的下一条命令 |
| A3 通用工具清单硬编码 | ✅ 第五轮 D5 改为"基础集（硬编码保底）+ 会话广度自动学习"，判据写进报告，`opts` 可覆盖 |
| `plugin/client.js` 面板与角标缺浏览器端测试 | ✅ 第五轮 D9 新增 `scripts/plugin-dom.test.mjs`（零依赖 DOM 桩，76 条） |
| 面板错误态点「联网现搜」无可见反馈 | ✅ 第六轮修掉（`liveErr` 未在错误分支渲染）；同轮修掉会让界面卡死的通知自激 |
| 发布脚本把 HTTP 202 当失败 | ✅ 首次真实发布时修掉：`classifyPublishResponse()` + 2 条断言（202 = registry 已接受／分阶段发布） |
| CI 连续全红 / 徽章无守护 | ✅ 第四轮修掉根因，徽章核对内建进 smoke（不一致即退出码 1） |

**仍未修**：

| 缺陷 | 影响 | 现状 |
|---|---|---|
| **WorkBuddy 会话解析未实现** | `install.sh` 在 `~/.workbuddy` 存在时会把 skill 部署过去，但当前**只有 DSH 适配器** —— 装了也扫不到会话 | 安装节已如实标注；适配器本身未排期 |
| **v3 会话格式未验证** | `session.v3` 可能是单帧或无压缩，未实测（无压缩 `.jsonl` 已支持） | 见 [docs/data-formats.md](docs/data-formats.md) |
| **配置层只解析 `cordis.patch.yml` 的 YAML 子集**；处方里的"随附默认值"是抄录表 | DSH 升级后随附默认值会漂移，需要同步；更深嵌套结构会被忽略（在 `warnings` 里说明） | 设计取舍，非缺陷 |
| **CLI 行为缺少断言** | 参数校验之外的 CLI 端到端行为只在 CI 步骤里跑（只看退出码），smoke 里没有断言 | 本轮补了参数校验断言，见下"测试空白" |

### 测试空白（明确列出，不吹全覆盖）

> 面板测试（`scripts/plugin-dom.test.mjs`，106 条）**自己核对**文档里写的条数：
> 数字对不上就以退出码 1 结束（与 smoke 的徽章守护同一套做法），
> 全绿后可 `--write-badge` 回写。

- **面板 —— 已覆盖**：面板/角标渲染、问题卡与处方卡的折叠与合并、交互（关闭、刷新、
  联网现搜的成功与失败路径）、`liveBusy` 中间态（含失败后按钮恢复，不会永久卡死）、
  **watch 签名变化 → 面板内容级自动刷新**（新报告文本出现、旧文本消失，不只是"请求 +1"）、
  异常响应形状（HTTP 500 + HTML、200 + 标量、200 + `null`、`/report` 非 JSON、`/watch` 非 JSON）。
- **面板 —— 仍未覆盖**：**真实计时**（6 秒轮询节奏、复制按钮 1.4 秒复位 —— 桩只记录
  `setInterval`/`setTimeout` 的注册与间隔，不真的等）、CSS/布局（`var(--x, fallback)` 不解析，
  无 `getComputedStyle`/`offsetWidth`，看不出错位与遮挡）、真实 React 语义（StrictMode 双调用、
  依赖数组漏写、并发渲染、错误边界）、真实事件系统（capture/once/passive、键盘与 focus、
  Escape 关闭 —— `client.js` 本身没有键盘处理）、网络细节（AbortSignal/CORS/流式、
  **watch tick 与在飞 `/report` 的竞态**、连点「刷新」）、`CatalogRow` 其余展开分支、
  处方 kind 的其它类型（command/plugin/setting）、多面板实例共存、localStorage/history/无障碍树。
- **CLI 端到端**：`report` / `catalog` / `fingerprints` 的真实执行由 CI 步骤覆盖（只看退出码）；
  `show` 的参数解析与 help 文案现在有断言（`parseShowOptions` / `buildHelpText`）。
- **证据层与适配层部分 helper**：`stableStringify`、`makeEvent` 等没有直接断言
  （它们的稳定性由 E1/E5 的哈希断言间接覆盖）。
- **一处测试保真度隐患（已修）**：面板测试的 fixture 曾长期硬编码宿主版本 `'14'`，
  而 `plugin/client.js` 的 `CLIENT_VERSION` 已升到 `'15'` —— 于是**所有渲染断言都跑在
  "宿主版本落后"的横幅分支上**。现已改成从源码读版本号，并断言非落后分支。


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
- **M3.9 ✅ 第四轮：第三方独立评估整改**（依据 `agent-clinic-独立评估报告-实测版(1).md`，
  方案 [docs/plan-2026-10-15.md](docs/plan-2026-10-15.md)）：
  ①CI 全红根因修复 —— smoke 无数据时计**跳过**而非失败（`skipCheck`，`DSH_SMOKE_REQUIRE_DATA=1`
  可把跳过转成失败），CI 跑前用合成语料装置造数据；②新增 `scripts/fixtures/synth-dsh.mjs`
  确定性覆盖 19 项指标（`--verify` 校验每项 ≥1 处命中）；③**徽章守护**内建进 smoke
  （比对 README 三处声称与实际条数，`--write-badge` 可回写）；
  ④自检不再针对作者本机校准（合并卡/现搜处方改为构造输入，第 14 节覆盖插件类处方所在的
  第 2 个位次）；⑤N3 outcome 三分类（`approved` 不再被算成"被拒"）；
  ⑥C1 基线逐会话排除自身（倍率变大、更敏感，`[100,250,2000]`：8.0× → 11.4×）；
  ⑦修 `matchPrescriptions` 名额轮转 bug（每类问题第 2 个位次丢失的根因）。
  偏差说明：徽章核对**未**做成独立的 `scripts/badge.mjs`，而是内建进 smoke 随 CI 一起跑
  （最终条数只有跑完才知道；且沙箱内 spawn 捕获输出会 EPERM）
- **M3.10 ✅ 第七轮：CI 加固（action 升 v7 + runner 钉版本）**（2026-10-15）：
  ①`actions/checkout` / `actions/setup-node` 由 v4 升到 **v7** —— v4 跑在 Node 20 上，
  已被 GitHub 强制迁到 Node 24 并每次运行都告警（v7 是 ESM 迁移版，本项目只用默认参数，
  无破坏性影响）；②Linux runner 由会自己漂移的 `ubuntu-latest` 改为**显式钉版本**
  `ubuntu-24.04`，并加挂 `ubuntu-26.04` **迁移探针**（只配 node 24 控成本）——
  依据 [actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748)：
  `ubuntu-latest` 从 2026-10-19 起分几周切到 Ubuntu 26.04、11-19 完成，
  官方给的缓解办法就是显式写标签；③自检新增 3 条断言守着"三平台覆盖 + Linux 显式版本 +
  不得回退到 ubuntu-latest + action 主版本 ≥5"。CI 由 7 job 变 8 job。
- M3.5 ⏳ 处方四重过滤 + 反馈闭环（记住已拒绝 / 感兴趣）
- M4 体检报告卡片（可分享）
- M5 ✅ 开源发布（SKILL.md / install.sh / 文档）
- M6 全维度 + 生态接入
- M7 WorkBuddy 平台

---

## License

MIT
