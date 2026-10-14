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
[![smoke](https://img.shields.io/badge/smoke-144%2F144-brightgreen)]()

---

## 它解决什么问题

大多数 Agent 使用分析工具只给你一堆统计数字，你看完也不知道该干什么。

agent-clinic 的做法不同：**它给证据，也给处方。**

- 不只说"你有死循环"，而是说"10 月 8 日这个会话，`list_agents` 用同样的参数失败了 4 次，在 `session.v4.jsonl.zstd#L101-L108`"——一条命令你就能自己复核。
- 不只给建议，而是给**可执行的动作**：能整段粘进 profile 的 YAML 片段、斜杠命令、已核实插件的安装入口，或明确说没有插件能解。
- **读你的真实配置**再开口：处方会说"你现在 `maxInlineTokens=12500`（随附默认，profile 未覆盖）→ 建议 6000"，而不是"建议调低一点"。当前值已经不弱于建议时，这条处方会被直接撤掉。
- **检索插件目录做针对性推荐**：按「能力标签 + 关键词」匹配你的问题，并说明**为什么推荐它**（例如"能力标签 token-saving 对上 C1；你的问题描述里出现了 token、消耗"）。目录有三个来源并逐一标出：**人工核实 / npm registry 同步 / GitHub 核实**（受限网络下用 `git ls-remote` 核实仓库存在）。**已经装过的插件不再推荐**。
- **面板里一切皆可折叠**：问题卡点开能看到证据与**挂在它下面的处方**；处方卡点开才展开分步操作、片段、风险与出处。
- **同类型合并**：同一指标在多个会话命中（或同一种模式出现多次）只会显示**一张卡**并标出「N 处」，展开后每一处仍保留自己的会话、结论与证据定位 —— 不重复展示，也不丢信息。

> **不做的事**：不主动推送、不代你安装、不改你的配置、不诊断代码质量、不把任何对话内容发到外部。

---

## 诊断维度

**12 项已实现**

| ID | 名称 | 判定 | 严重度 |
|---|---|---|---|
| C1 | token 消耗过快 | 单会话 output 超自身其他会话中位数 50% | 高 |
| C2 | 上下文膨胀 | 末轮/首轮 input 增长 >10x 且 cacheRead <30% | 高 |
| C3 | 长会话疲劳 | 单会话消息数 >200 | 中 |
| E1 | 死循环 | 同工具 + 同参数 + 同错误，≥3 次 | 高 |
| E2 | 反复失败 | 会话工具错误率 >30% | 中 |
| E4 | 计划执行脱节 | 写计划后又大量调用工具，但 0 条完成 | 中 |
| E5 | 冗余重复调用 | 同工具 + 同参数 + 无错误，≥3 次 | 中 |
| N1 | 环境命令反复失败 | 命令类调用失败 ≥3 次 | 中 |
| N2 | 高风险操作 | 命令执行类工具命中 `rm -rf` / `--force` / `reset --hard` 等 | 高 |
| A2 | skill 闲置 | 已装 skill 在窗口内 0 次触发（需 ≥30 天窗口） | 中 |
| A3 | 高频手动序列 | 同工具相邻序列复现 ≥5 次 | 中 |
| A4 | 子代理开销 | `delegationDepth>0` 会话 token 占比 >40% | 中 |

**1 项排期中**：A1 MCP 闲置（本机未配置 MCP，暂无数据源）

**5 项明确不可实现**（DSH 数据源缺失，报告会显式列出并说明原因）

| ID | 名称 | 缺什么 |
|---|---|---|
| E3 | 工具结果过大 | `tool/result` 只归一化 `is_error`，不含 content 与长度 |
| K1 / K2 | 跨会话失忆 / 已解决重新排查 | `user/message` 只保留 `text_len`，无正文，无法跨会话比对 |
| N3 | 权限审批摩擦 | 只有 `approval/policy`（策略快照），无 `approval/asked` / `decided` |
| N4 | API 重试频繁 | 不存在 `llm/retry` 事件 |

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
| **诊断指标 12 项** | ✅ **可用**（见上表） |
| **处方层（可执行：配置片段 / 命令 / 插件 / 设置 / 行为）** | ✅ **可用**（读本机真实配置，给出「当前值 → 建议值」） |
| **体检报告 `report`** | ✅ **可用** |
| **DSH 插件（侧边栏入口 + 报告面板 + 准实时角标）** | ✅ **可用** |
| **处方反馈闭环**（记住已拒绝 / 感兴趣） | ⏳ 待实现 |
| A1 MCP 闲置 | ⏳ 排期中（本机未配置 MCP，暂无数据源） |
| WorkBuddy 平台 | ⏳ 待实现 |

**M1 闭环已完成**：`./run.sh report` 产出带可复核证据 + 可执行处方的体检报告；DSH 插件有侧边栏入口、面板与准实时角标；冒烟测试 **103/103 通过**。

```bash
$ ./run.sh report

## Agent 体检报告（平台：DSH · 5 个会话）

扫描概览：5 会话 / 1078 行 / 230 次工具调用 / 错误率 7.0%
token：input 427,379 · output 114,656 · cacheRead 6,551,936

### 发现 3 个问题（按严重度排序）

**[高] C1 token 消耗过快** —— 会话 8383b82c-f69
- 结论：本会话 output 31,512，是自身基线 6,752 的 4.7 倍（阈值 1.5 倍）
- 证据定位：…/session.v4.jsonl.zstd#L17
- 影响估算：约多消耗 24,760 output token

**[中] E5 冗余重复调用** —— 会话 32fd3d17-6ab
- 结论：list_agents 用完全相同的参数成功调用了 4 次（可省 3 次）
- 证据定位：…/session.v4.jsonl.zstd#L182-L236

### 未检测到异常的维度
- C2 上下文膨胀 / C3 长会话疲劳 / E1 死循环 / E2 反复失败 / N1 / N2 / A3 / A4
- A2 skill 闲置 —— 扫描窗口仅 3.0 天（需 30 天），样本不足

### 处方（3 条 · 每条都有可执行动作）

> 配置类处方改的是这份文件（本工具只读它，不代你改）：`C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml`

1. **【行为建议】把长任务拆成多个短会话** —— 针对 C1
   - 怎么做：在开新会话前，让 Agent 先写一份简短交接（当前进度 / 已确认的结论 / 下一步）…
   - 依据：output 高通常来自"一个会话里想做太多事"，拆分是零成本且立刻见效的一步。
   - 风险提示：拆会话会丢掉原会话的上下文，必须靠交接文件补齐。
   - 怎么确认有效：重跑 ./run.sh report，看 C1 是否还命中。
   - 出处：agent-clinic · 行为处方（本工具生成）· 核实于 2026-10-15

2. **【改配置】让重复调用提醒来得更早** —— 针对 E5
   - 怎么做：同参数重复调用达到阈值时提醒模型换策略，减少"同参数再来一次"的冗余回合。
     当前：thresholds=[3, 5, 8] · argumentsPreviewChars=500（随附默认值（你的 profile 未覆盖这一行））
     建议：thresholds=[2, 3, 5] · argumentsPreviewChars=500
   - 改成（可整段粘进 profile patch）：
     ```yaml
     - id: repeat-tool-reminder
       name: '@deepseek-ai/dsh-repeat-tool-reminder'
       config:
         thresholds: [2, 3, 5]
         argumentsPreviewChars: 500
     ```
   - 风险提示：提醒只是建议，不阻止合理重复；阈值调到 2 会在幂等轮询场景里更吵。
   - 怎么确认有效：再遇到同参数重复时，结果后面应出现插件的提醒消息
   - 出处：@deepseek-ai/dsh-repeat-tool-reminder（随附插件）· 核实于 2026-10-15

3. **【行为建议】把固定套路写成 skill** —— 针对 A3 …

### 省 token 开关清单（本机真实存在，供按需调整）

> 这是**工具陈列**，不是体检结论 —— 本次未触发对应指标，列出来是因为你随时可以拧它们。

- **【改配置】收紧工具结果的 spill 预算（最能省 input 的一档）**
  - 当前：maxInlineTokens=12500 → 建议：maxInlineTokens=6000
  - 片段：
    ```yaml
    - id: spill-policy
      name: '@deepseek-ai/dsh-spill-policy'
      config:
        maxInlineTokens: 6000
    ```
  - 风险：被省略的中间内容模型看不到，需要时它得自己 read/grep 那个 spill 文件。
- **【装插件】装 smart-compaction（让模型自己择机压缩 + 看得见真实用量）**
  - 安装：侧边栏 → 插件 → 添加插件 → 粘贴 smart-compaction
  - 出处：smart-compaction · 核实于 2026-10-15

### 不可实现的维度（DSH 数据源缺失）
- E3 工具结果过大 —— tool/result 不含 content 与长度
- K1 / K2 —— user/message 无正文，无法跨会话比对
- N3 / N4 —— 无 approval/asked 与 llm/retry 事件
```

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
./install.sh --ref v0.1.0       # 指定版本
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

作为 DSH 插件安装后，会在侧边栏底部多一个**「🩺 体检」按钮**，点开是**全页面板**，直接展示体检报告（含问题、证据定位、处方、未检测到的维度）。

| 位置 | 插槽 | 内容 |
|---|---|---|
| 侧边栏底部 | `sidebar.footer.action` | 「🩺 体检」入口按钮（带未读角标） |
| 覆盖层面板 | `shell.overlay` | 体检报告：指标格 / 问题卡 / 处方卡 |

数据流：面板 → `fetch('/api/agent-clinic/report')` → 宿主半路由 → `buildReport()` → JSON。
该路由**只读本地会话，零外发**。

> **纯 JavaScript 手写，无构建步骤** —— 客户端入口 `plugin/client.js` 通过
> `window.__ModuleLoader__.load` 注册，React 取自宿主浏览器模块表。
> 各插槽注册彼此隔离：某个插槽不可用时不会拖垮整个插件。
> 若面板提示「宿主仍是旧版」，说明插件更新后没完全重启 Harness。

> **纯 JavaScript 手写，无构建步骤** —— 客户端入口 `plugin/client.js` 通过
> `window.__ModuleLoader__.load` 注册，React 取自宿主浏览器模块表。
> 各插槽注册彼此隔离：某个插槽不可用时不会拖垮整个插件。

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
| 能力 | 提示词 + CLI | 原生工具（模型可直接调用） |
| 状态 | ✅ 可用 | 🚧 脚手架就绪，待真实 DSH 验证 |

---

## 使用

```bash
./run.sh report      # 体检报告（推荐入口，同时写入 agent-clinic-report.md）
./run.sh scan        # 扫描概览
./run.sh diagnose    # 只跑诊断
./run.sh show "~/.dsh/sessions/<...>/session.v4.jsonl.zstd#L101-L108"   # 展开证据
./scripts/smoke.sh   # 自检（33 项）
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
L4 处方层   问题 → 可执行处方（≤4 条，须自证有效）   ← 读本机真实配置，给"当前值 → 建议值"
  ▼
L5 输出层   体检报告 + 证据清单 + 处方卡片 + 省 token 开关清单
```

---

## 隐私

- 诊断**全流程本地**完成，会话文件**只读**
- **零外部请求**（插件元数据打包在仓库内）
- 无遥测、无崩溃上报
- 状态文件只存"日期 + 一句话摘要"，不存对话原文
- 删除状态文件即完全重置

---

## 已知限制

- **只支持 DSH v4 会话格式**；v3 / 无压缩格式兼容待验证
- 需要 Node ≥ 22.15（低版本会明确报错，不会静默跳过数据）；node 不在 PATH 上也没关系，会自动定位
- **12 项诊断指标已实现**，1 项排期（A1 MCP 闲置），5 项明确不可实现（报告会列出原因）
- 处方里的「随附默认值」是一份**抄录表**（出处 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`），
  升级 DSH 后若随附默认值变了，需要同步这份表；用户 profile 的真实覆盖值一律现读，不靠猜
- 配置层只解析 `cordis.patch.yml` 里用到的那个 YAML 子集（顶层 `- id/name/config` + 标量与列表），
  更深的嵌套结构会被忽略并在 `warnings` 里说明
- 需要 `~/.agents/skills/` 目录存在（`install.sh` 会自动创建）

### ⚠️ 关于 DSH 数据格式

DSH 会话文件是**多帧 zstd 拼接**（单个文件实测含 60~233 个帧）。
`zlib.zstdDecompressSync()` 和流式 API **都只能解出第一帧**。
本项目的 `src/adapters/zstd-frames.mjs` 按 magic number 手工切帧，已在真实数据上验证 463/463 帧成功。详见 [docs/data-formats.md](docs/data-formats.md)。

---

## 路线图

- **M1** ✅ DSH 解码 + E1/E2/E5 诊断 + 证据层 + 体检报告（最小闭环已打通）
- M2 ✅ 扩展 C1/C2/C3/E4/N1/N2/A2/A3/A4（12 项）
- M3 ✅ 处方层重写：读本机真实配置 + 可执行处方（配置片段 / 命令 / 插件 / 设置 / 行为）+ 省 token 开关清单
- M3.5 ⏳ 处方四重过滤 + 反馈闭环（记住已拒绝 / 感兴趣）
- M4 体检报告卡片（可分享）
- M5 ✅ 开源发布（SKILL.md / install.sh / 文档）
- M6 全维度 + 生态接入
- M7 WorkBuddy 平台

---

## License

MIT
