# agent-clinic 评估报告（第二轮）

- 评估日期：2026-10-14
- 评估对象：本仓库 `main`（`ca83576` + 本轮 F8 修复）
- 评估方式：三路并行**只读**审计（代码质量 / 文档与交付体验 / 功能有效性）+ 评估人对**原始会话日志**的实证核对
- 实证语料：本机 `~/.dsh/sessions` 13 个会话、6430 条原始记录、1092 次 `tool/call`
- 复核状态：每条结论标注 `[实测]`（评估人亲自跑过）或 `[审计]`（子代理结论，未逐条复核）

> 事件计数会随你继续使用而增长，量级与比例不变。

---

## 0. 整改情况（评估后已落地的部分）

用户确认「需要，现在进行改进」后，P0 清单已落地并全部带上回归护栏（自检 182 → **207 项全绿**）：

| 条目 | 状态 | 落地内容 |
|---|---|---|
| F12 C1 基线 | ✅ | 改**单位请求 output** 对比**仅主会话**基线（排除子代理与 0 产出会话）、加 2 万 token 绝对量下限、阈值 1.5→2、结论写明"产出量大不必然是浪费"。本机 6 处 → **1 处** |
| F13 A2 前提 | ✅ | 适配层新增 `skill_name`（从 `skill` 工具参数取 `name`，只取这一个字段）；A2 据此判定并补上窗口起点证据。**已装 skill（含 `agent-clinic`）不再被误判闲置** |
| F14 A3 噪声 | ✅ | 去镜像（`a↔b` 合并）+ 任一端是通用工具即排除 + 跨会话合并 + 严重度降为低。本机 18 条 → **1 条**（`web_search↔web_fetch` 28 次，确实可固化） |
| F1 五项"不可实现" | ✅（3/5） | E3/N3/N4 **已实现**（适配层补 `text_len` / `approval_asked+decided` / `KIND.RETRY`），并各配可执行处方；K1/K2 的措辞改为"隐私取舍下的方案未定，**不是平台做不到**" |
| F4 静默降级 | ✅ | `findSessionFilesDetailed()` 区分 ENOENT/EACCES；`readRegistrySnapshot()` 区分"没同步过"与"损坏"；`scan` 错误分 `kind=read`/`kind=parse`；CLI 与报告不再把"读不到"说成"没有数据" |
| F16 处方撤销可见 | ✅ | 报告与面板新增「已评估但未给出的处方」段（含当前值）；`spill-tighten` 在"未设预算"时**不再被静默撤销**（与 `pruner-tighten` 行为统一）；全局处方上限 4 → 6（指标 12→15 项后 4 个名额会把 E3 的配置建议挤掉） |
| F5 两条飘红断言 | ✅ | 行号一致性只在文件未被并发写入时比对，否则记"跳过"；只读断言改为内容一致 + 目录条目数不变 |
| F6/F9/F10 文档漂移 | ✅ | `docs/diagnostics.md` 重写为代码镜像（15 项已实现 / 1 排期 / 2 未实现）；README/SKILL/remedies/report-format/evidence 的数字与措辞同步；**新增断言：文档指标清单 == 代码 REGISTRY**、README 不得再出现"零外部请求""5 项不可实现" |

仍未动（P1/P2，待确认）：C3 不看 compaction、`reasoning-effort` 处方硬编码 provider、证据区间只展开起点、
复核命令 bash-only、配置旋钮未接线、`install.sh` 不自带、`joinPath` 硬编码反斜杠、无 CI、死代码与重复实现。

---

## 1. 总评

| 维度 | 评级 | 一句话 |
|---|---|---|
| 工程纪律 | **A-** | 零依赖、注释解释"为什么"、生成物不入库、降级路径真的会降级 |
| 问题发现能力 | **B** | 12 项指标能跑；但**旗舰指标 C1 测的不是浪费**（F12），A2 前提是错的（F13），A3 刷屏（F14） |
| 方案可执行性 | **B** | 处方 YAML 正确（含整行替换注意事项）；但最该给的那条被静默撤销（F16） |
| 结论可信度 | **C+** | 静默降级把"读不到"说成"没有数据"（F4）；测试与文档数字互相矛盾（F5/F6）；证据跨度打不开（F18） |
| 度量准确性 | **C** | token 口径不完整（F3）；C1 基线混杂空会话与子代理会话（F12） |
| 交付体验 | **B-** | 可安装可跑通；`install.sh` 不自带、未识别平台误报成功（F20） |

**一句话**：这个项目的**诚实性设计**（证据可复核、不静默降级、检出即给理由）是它最大的资产，而本轮发现的问题恰恰集中在**它没能对自己执行同一套标准**：三项指标的判定前提与真实数据不符，五条"数据源缺失"的理由与自家适配层的行为矛盾。

**性价比最高的三件事**：F1（把 5 项"不可实现"改成可实现）+ F12（修 C1 基线）+ F13（修 A2 判定前提）。

---

## 2. P0：指标判定与数据事实不符

### F12 C1「token 消耗过快」测的是"干了多少活"，不是"浪费" `[实测]`

**判定逻辑**（`src/diagnostics/index.mjs:130-163`）：某会话 assistant `output_tokens` 之和 > **全会话中位数** × 1.5（`c1BaselineRatio`，硬编码）。

**实测本机**：

```
各会话 output 排序：0, 0, 2516, 5562, 6752, 9408, 10329, 15760, 18422, 25636, 31512, 68314, 426045
中位数 = 10,329  → 阈值 15,493
C1 命中 6 个会话，全部使用同一个"自身基线 10,329"：
  31,512（3.1×）· 68,314（6.6×）· 29,167（2.8×）· 26,959（2.6×）· 48,480（4.7×）· 444,335（43.0×）
```

三处口径问题：

1. **基线含空会话**：两个 0 值会话把中位数从 15,760 拉到 10,329；去掉它们，最小命中者（15,760）立刻不再超阈值。
2. **主会话与子代理会话混在一个中位数里**：命中的 6 个中有只有 37 条消息的子代理会话 —— 子代理串行干活，天然高于中位数。
3. **无归一化**：不看轮次、请求次数、时长。output 高只说明会话长/任务重，**不构成"浪费"的证据**。

**还有措辞硬伤**：报告写「本会话 output 31,512，是**自身基线** 10,329 的 3.1 倍」—— 那个 10,329 是全机器 13 个会话的中位数，不是该会话自己的基线。而 `docs/diagnostics.md:79` 把 C1 描述为"vs 自身 30 天中位数"，代码从未按会话自身的历史窗口算过。

**影响**：C1 是这个工具的旗舰指标（也是你最初抱怨的那类问题）。当前口径会让"正常干了重活"的会话被判高，用户会照处方去降推理强度/拆会话 —— 治不了真问题。

**建议**：① 基线改为**该会话自身**的前段窗口（如前 30% 请求）对比后段；② 排除空会话与子代理会话；③ 按请求数归一（output/请求）；④ 至少把措辞从"自身基线"改为"全会话中位数"。

### F13 A2「资产闲置」的判定前提是错的 —— 窗口一到必然误报全部 skill `[实测]`

`src/diagnostics/index.mjs:572-574` 的注释宣称"skill 在 DSH 里触发时表现为同名工具调用"，代码据此把 `tool_name` 集合与已安装 skill 目录名比对。

**实测：DSH 只有一个名为 `skill` 的工具，技能名在参数里。**

```
distinct tool_name: 22 个；其中名为 skill 的调用 1 次，参数 = {"name":"agent-clinic"}
与 skill 目录同名的 tool_name：不存在
```

**三重后果**：① `usedTools.has(技能名)` 永不为真 → 30 天窗口一到，**每个已装 skill 都被判"闲置"**（本机装的是 `agent-clinic`，而它确实被调用过）；② A2 的 findings 带 `evidence: []`、`scope: null`，与"每条结论都有可复核证据"直接矛盾。

> **⚠️ 本报告的一处更正（写作时未复核）**：初稿还写了"代码读两个技能目录、同名技能会重复计入"。
> 这是**错的** —— `listInstalledSkills()` 末尾已有 `[...new Set(out)]` 去重（`src/diagnostics/index.mjs:609`）。
> 子代理的这条指控未经复核就被采信，属评估方错误，在此更正。其余 F13 内容（判定前提错误、无证据）属实。

**建议**：从 `skill` 调用的 `arguments.name` 取技能名，与工具名集合分开维护。

### F14 A3「高频手动序列」是相邻工具对直方图，必然刷屏 `[实测]`

`src/diagnostics/index.mjs:452-488`：只统计**相邻**两个工具名配对，同名对重复 ≥5 次即报"可考虑固化为技能"。

**实测本机 18 条**，且存在对称重复：

```
工具序列「grep→read」重复 10 次   工具序列「read→grep」重复 9 次
工具序列「pwsh→read」重复 6 次    工具序列「read→pwsh」重复 7 次
```

`read→edit`、`edit→read`、`edit→pwsh` 这类"读文件后编辑、编辑后跑命令"是 Agent 的**正规工作流**，不是可固化的套路。另外 `src/report.mjs:127-136` 把**实例数**写成「N 类工具序列」（18 条实例 → 读起来像 18 类）。

**影响**：A3 一次运行就产出十几到二十几条，稀释了真正的高价值发现；而它推的插件也不对症（见 F17-M6）。

**建议**：① 增加"该序列是否具备可复用性"判据（如跨会话稳定出现 + 参数形态一致 + 出现于多个项目）；② 去对称重复（`a→b` 与 `b→a` 合并）；③ 排除纯读写编辑类组合，或降级为提示；④ headline 改回"实例数"。

---

## 3. P0：能力被自己误判 / 被自己掩盖

### F1 五项"不可实现"的判定是错的 —— 数据都在日志里 `[实测]`

`src/diagnostics/index.mjs:747-773` 把这 5 项标为"DSH 数据源缺失，非排期问题"，报告里也这样打印。逐项验真，**5 项全部不成立**：

| 指标 | 项目声称的原因 | 实测事实 |
|---|---|---|
| E3 工具结果过大 | "tool/result 只归一化 is_error，不含 content 原文与长度" | `tool/result` 原文带 `data.message.content[].text`；**1116 条有正文，57 条 >8192 字符** |
| K1 跨会话失忆 | "user/message 只保留 text_len，无正文" | `user/message` 原文带 `data.content[].text`；**84 条有正文** |
| K2 已解决重新排查 | 同 K1 | 同 K1 |
| N3 权限审批摩擦 | "DSH 只有 approval/policy，没有 approval/asked / approval/decided" | **`approval/asked` 23 条**（`{id,toolName,callId,reason}`）+ **`approval/decided` 23 条**（`{id,outcome}`） |
| N4 API 重试频繁 | "DSH 会话日志中不存在 llm/retry 事件" | **`llm/retry` 1 条**（`{retryId,provider,mode,retry,maxRetries,delayMs,failure:{code}}`）+ `llm/retry-started` |

`src/adapters/dsh.mjs:182-189,259-264` 用 `sumTextLen(data.content,'text')` **从正文算出长度后丢弃正文**；`tool/result`（`:286-291`）只留 `is_error`。所以这是"适配层没抽"，不是"平台没有"。

**三项零隐私代价就能做**：E3 加 `text_len`（与现有 message 做法一致）；N3 用 asked/decided 的 `id` 关联算等待时长与被拒率；N4 直接读 retry 次数与 `delayMs`。**K1/K2** 建议存**规范化指纹**而非正文：跨会话比对"同一问题被重复问"完全可行，不破坏"零对话原文"约束。

### F2 37 种事件类型，适配层只归一化了 8 种 `[实测]`

本机观测到 **37 种事件类型**；`src/adapters/base.mjs` 的 `KIND` 只有 **8 种**（USER_MSG / ASSISTANT_MSG / TOOL_CALL / TOOL_RESULT / USAGE / APPROVAL / TODO_WRITE / META）。未建模的 26 种里有大量高价值信号：

| 未建模事件 | 本机条数 | 可用于 |
|---|---|---|
| `compaction/start` / `summary` / `end` | 各 22 | 压缩可观测性（F2.1） |
| `compaction/prune` | 5 | 压缩实测释放量 |
| `web/deepseek-search-llm-request` | 93 | 联网检索开销（辅助 LLM） |
| `agent/inbox/spliced` | 86 | 上下文被拼接/替换的痕迹 |
| `approval/asked` / `decided` | 各 23 | N3 |
| `request/header` | 25 | 含完整工具 schema 与 `maxTokens` → 可量 schema 成本 |
| `session/title-llm-request` | 3 | 辅助请求开销 |
| `llm/retry` / `retry-started` | 各 1 | N4 |
| `workspace/changes` / `deliverables/presented` | 12 / 1 | 产物是否落地 |
| `sandbox/mode` / `permission/preset` | 13 / 5 | 权限与沙箱姿态 |
| `subagent/descriptor` / `catalog` | 各 8 | 子代理使用情况 |

#### F2.1 压缩可观测性是现成的最好素材，却完全没用 `[实测]`

`compaction/summary` 带 `shadowedSeqs` / `shadowedTokenCount`；`compaction/prune` 带 `shadowedRange` / `shadowedTokenCount`（样本：一次 prune 释放 1115 token）。

**DSH 自己就把"这次压缩实际释放了多少 token"写进了日志**，而 C1/C3 还在用启发式估算绕圈子。据此可做（都不需要正文）：压缩触发频率、每次实测释放量、prune 与 summary 的比例、压缩后是否仍超阈值。

### F3 token 口径不完整 `[实测]`

`usage` 只出现在 `assistant/message`（914 条）。辅助 LLM 调用**没有 usage**，但它们确实在花钱：

- `web/deepseek-search-llm-request` **93 次**（请求体在日志里，`max_tokens: 4096`，模型 `deepseek-v4-flash`）
- `session/title-llm-request` 3 次

报告的 `token：input … output … cacheRead …` 没有任何"仅主对话"的限定。**建议**：① 显式写明口径；② 用次数 × `max_tokens` 给出上界估算并标注为估算。

### F4 "读不到"被伪装成"没有数据" `[实测]`

| 位置 | 行为 | 用户看到 |
|---|---|---|
| `src/adapters/dsh.mjs:40-46` `walk()` | `catch { return; }` 静默吞目录读取失败 | `src/cli.mjs:63-66` 打印「未找到会话文件」→ 权限/路径错误伪装成"没数据" |
| `src/catalog/index.mjs:251-279` `loadRegistrySnapshot` | `catch { return null; }` 吞 ENOENT / JSON 损坏 / EACCES | `src/cli.mjs:213` 打印「快照不存在」→ 损坏与缺失不可区分 |

同仓库 `src/catalog/index.mjs:344-365` 就做对了（`e.code !== 'ENOENT'` 才记错）—— **标准不一致**。
另有 L7 `[审计]`：解析失败的会话进 `scan.errors`，但**只有 `scan` 命令打印**（`cli.mjs:102-107`），`report` 不显示 → 报告分母可能少算会话而不自知。

---

## 4. P0：处方层

### F16 最该给的那条处方被静默撤销，且"为什么没给"从不渲染 `[实测]`

- `src/prescriber/remedies.mjs:84-89` 的 `spill-tighten` 在 `maxInlineTokens` 非数字时返回原因串 → `src/prescriber/index.mjs:426` 收到即 `continue` 丢弃。而"非数字"恰恰来自 `src/config/index.mjs:87-101` 的 `PACKAGE_DEFAULTS`（spill `maxInlineTokens: null` = **策略被禁用**）—— **最该补预算的场景正好看不到这条**。
- 同一情形下 `pruner-tighten`（`remedies.mjs:111-116`）却返回 null 照常给建议 → 同类问题两种处理。
- `skippedFor`（`prescriber/index.mjs:459-469`）被 `src/report.mjs:263,280,317` 算进数据，但处方段（`report.mjs:507-534`）**从不打印 `skipped`**。用户无法区分"被否决"与"没有这条"。

### F17 `reasoning-effort` 处方硬编码 provider，会顺带改写用户的模型路由 `[实测]`

`src/prescriber/remedies.mjs:192`：
```js
suggest: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }
```
而 `src/config/index.mjs:67-69` 记录 shipped 值是 `provider: 'deepseek-official'`。由于 profile patch **按 id 定位、整体替换该行 config**，用户整段粘贴即把 provider 从 `official` 改成 `account`。

本机之所以没暴露：`skipIf`（`remedies.mjs:200-206`）看到 `reasoningEffort` 已经是 `low` 就跳过了。**换成任何 official 用户就会静默切路由。**
**建议**：只写 `reasoningEffort`；或从当前 profile 行回填 provider/model。

### F18 证据跨度打不开、复核命令在 Windows 上不可执行 `[实测/审计]`

- `src/evidence/index.mjs:61-76` 的 `renderEvidence` 只读 `range.start` 打 ±2 行，`-L<end>` 被忽略。实测 E5 给出 `#L1733-L2688`（955 行跨度，实为"同一个 read 调了 3 次"的第 1 与第 3 次），`show` 只显示 L1731-1735 —— **结论属实，但复核链断在展示层**。
- `src/report.mjs:490` 每条都推 `./run.sh show "<locator>"`，而 `run.sh` 是 bash-only，本环境是 Windows/pwsh → 报告承诺的复核路径大概率直接失败。应给 `node src/cli.mjs show` 形式。

### F19 其他处方层缺陷 `[审计]`

- **C3 不看 compaction**（`diagnostics/index.mjs:207-235`）：注释写"且无 compact"，代码只数消息。本机被报"长会话疲劳"的会话其实有 15 次 compaction → 长期靠 `/compact` 续命的用户仍被反复建议 `/compact`。
- **A3 → skill-asset 映射靠裸词 `/skill/`**（`capabilities.mjs:21`）：给"重复的工具序列"推「技能浏览入口」，装了什么也省不下来；且 `automation` 不在 `CAPABILITY_RULES` 里，该映射一半恒不生效。
- **多 profile 机器取第一个目录**（`config/index.mjs:116-134`）：无 desktop 偏好，多 profile 用户可能被指向另一份 patch。
- **N2 命中面偏宽**（`adapters/dsh.mjs:112-113`）：`COMMAND_TOOLS` 含 `node|python`，`dangerOf` 只匹配命令文本 → 参数里出现 `--force`/`mkfs` 即记一条"高风险"（N2 严重度=高）。
- **tokenInventory 死分支**（`prescriber/index.mjs:555,581,589-611`）：`continue` 之后的 `status` 恒为 `'adjustable'`，PLUGIN 分支不可达 → 清单永远无法表达"你已调好"。
- **严重度与置信度打架**：C1 `confidence=0.7` → 报告头写 `[高]`，条目内写「置信度：中」。

---

## 5. P1：配置、测试、文档的可信度

### F7 三个配置旋钮是死的 `[实测]`

- `plugin/index.js:60-61,68-69` 用 schema 承诺 `maxSessions`(500) 与 `minRepeatCount`(3)，但 `runAnalyze`(`:142-149`) 调 `analyze({scan, summary})` **不传 opts**；`minRepeatCount` 本已被 `diagnostics/index.mjs:72,286` 支持（`opts.minRepeatCount ?? 3`），只是没人往下传。
- `contextLines` 进了 Config（`plugin/index.js:62`），`report` 路径用得上（`:360`），但 `src/cli.mjs:115` 调 `renderEvidence(locator)` 不传 → CLI 永远固定 2 行。

用户改了旋钮没有任何效果，也没有提示 —— 正是本工具指责用户 Agent 的那类问题。

### F5 两条核心断言不稳定（"绿"取决于运气）`[实测]`

- `scripts/smoke.mjs:136`「会话文件未被修改（size/mtime 不变）」：按 size/mtime 判定，宿主正在写活跃会话时必然失败，把"别人在写"和"我们写了"混为一谈。
- `scripts/smoke.mjs:121`「show 行号与 scan 一致」：11 个会话里 1 个 locator 行号不可复现（`可复现 10 / 不一致 1`）。

同一台机器：我连跑两次 **182/182**；子代理跑出 **179/181**（失败项正是这两条）。
**建议**：只读断言改为校验"已读字节区间的内容"，检测到并发写入时输出"跳过"；行号不可复现的会话写进「已知限制」。

### F6 自检项数有五份互相矛盾的记录 `[实测]`

`README.md:21` 徽章 `148/148`；`README.md:93` 「103/103」；`README.md:307` 「33 项」；`SKILL.md:64` 「169 项」；`docs/remedies.md:364` 「114 项」；**实测 182**。
**建议**：删掉硬编码数字，由 self-check 生成徽章与片段，并加断言"文档数字 == 实际项数"。

### F9 指标清单文档整表过期 `[审计]`

- `docs/diagnostics.md:3` 仍写「骨架阶段」；`:24-28` 状态表、`:30` 「不可实现仅 N3,N4」、`:98` 「软信号仅 K2」、`:79` C1「30 天中位数」全部与代码矛盾。
- `SKILL.md:81-89` 只列 E1/E2/E5 并称「C1/C2/A2 尚在骨架阶段」—— 实际这 3 项已实现。
- `docs/evidence.md:72` 把已可用的 `show` 列为「待实现」；`docs/report-format.md:10` 模板头多出"近 30 天"，`:107` 硬性要求仍引已判不可实现的 K2。

与代码一致的只有 `README.md`。**建议**：三张清单从 `REGISTRY` 生成 + 断言一致。

### F10 隐私措辞自相矛盾 `[实测]`

`README.md:357`「**零外部请求**（插件元数据打包在仓库内）」无限定词，但同文件 `:262-263` 就介绍了联网按钮（`plugin/client.js:1020`）；`docs/remedies.md:120` 更写成「本工具不联网」。
真实承诺是**默认零外发**。建议统一措辞。

### F11 联网预算三处不一致 `[审计]`

`plugin/index.js:45` `LIVE_BUDGET_MS=10000`（模块常量，不进 Config）vs `src/catalog/live.mjs:36` `budgetMs=12000` vs `src/cli.mjs:147` `--live-budget` 默认 12000；面板值不可配置，且 `src/cli.mjs:241-262` 的 help **漏列** `--live` / `--live-budget`。

### F21 联网现搜的披露在"未联网"分支失效 `[实测/审计]`

- `src/catalog/live.mjs:459` `networked = !(network===false) && findings.length>0` —— 与是否有请求成功无关。实测 `budgetMs:4000`：`networked=true, degraded=true, entries=0`（全部通道 403/超时），页脚仍写"已联网"。
- `src/report.mjs:592-594` 的"本次未联网"提示条件写作 `!src?.live`，而 `--no-network` 时 `src.live` **存在**（`networked=false`）→ 该提示**永不显示**。实测 `network:false` 时报告插件段只由本地快照填充，**没有任何未联网说明**。

### F8 面板「联网现搜插件」的结果没有进入卡片（本轮已修）`[实测]`

`plugin/client.js` 的状态是组件内 `const [live, setLive]`（`:1005`），但渲染分支写 `state.live`（`:1101`）—— `state` 里从来没有 `live` 字段，三元恒取 `state.data`。点按钮后只有状态行变化，**问题卡/处方/插件列表全是旧数据**。

已修复为 `const d = live && live.data ? live.data : state.data;`，并在 `scripts/smoke.mjs` 加回归护栏（断言渲染分支读组件 `live`、全文件不出现 `state.live`）。当前自检 **182/182**。

---

## 6. P2：工程质量与交付

### 治理缺口 `[实测]`

- **无 CI**（无 `.github`）：182 项自检没有任何自动化执行者 —— F5 的"徽章绿但实跑红"就是这么来的
- **无 CHANGELOG**；`package.json` version 停在 `0.1.0`，git tag 已到 `v0.1.1`，README 一处钉 `@v0.1.1`、一处钉 `--ref v0.1.0`
- 无 lint/format 配置

### 死代码 `[实测/审计]`

- **`src/state.mjs` 整模块零引用**（5 个导出、53 行，含 `filterPrescriptions` 空桩 `return candidates`）；我实测全仓库引用数 = **0**
- `src/adapters/zstd-frames.mjs:98` `decodeFramesFromFile`、`src/prescriber/remedies.mjs:570` `remediesFor`、`src/config/index.mjs:33` `BUNDLE_SOURCE`、`scripts/catalog-sync.mjs:292` `gitOk`、`src/evidence/index.mjs:82` `buildEvidencePackage`
- `src/catalog/index.mjs:636-641` 的 `@deprecated` 注释悬空 —— 它注释的函数已被删除

### 重复实现且已分叉 `[实测]`

| 功能 | A | B | 已分叉 |
|---|---|---|---|
| `resolveDshHome` | `src/config/index.mjs:108-113`（trim + HOME/USERPROFILE 回退） | `src/adapters/dsh.mjs:28-30`（不 trim，只 `os.homedir()`） | **是** |
| `fetchJson`/`mapLimit` | `src/catalog/live.mjs:120,135` | `scripts/catalog-sync.mjs:58,74` | **是**（默认超时/UA/并发下限不同） |
| 定位符解析 | `src/adapters/base.mjs:36-43`（不支持区间） | `src/evidence/index.mjs:49-58`（支持 `-L<n>`） | **是** |
| `argOf` | `src/cli.mjs:30-33` | `scripts/catalog-sync.mjs:50-53` | 否 |
| 项目名推导 | `src/adapters/dsh.mjs:191-197` | `src/summary.mjs:40` | 未确认 |

### 测试盲区（`scripts/smoke.mjs` 是唯一测试）`[审计]`

零断言覆盖：**`src/cli.mjs` 整文件 292 行**（6 个子命令）；`src/report.mjs` 的 `buildReport`/`renderReport`/`buildReportLive`；`src/evidence/index.mjs:61,49`；`src/adapters/base.mjs` 的 `makeLocator`/`parseLocator`/`stableStringify`/`makeEvent`（E1/E5 的 args hash 稳定性完全没测）；`src/catalog/index.mjs` 的 `searchCatalog`/`isInstalled`/`heatScore`；`src/config/index.mjs` 的 `readProfilePatch`/`resolveProfileDir`；面板 `/report`、`/live` 路由只做源码字符串断言。

### 复杂度热点 `[审计]`

>120 行：`plugin/client.js:1000-1357` `ClinicPanel` **358 行**、`src/report.mjs:185-406` `analyze` **222 行**、`src/report.mjs:448-653` `renderReport` **206 行**、`plugin/index.js:293-491` `apply` **199 行**。`analyze()` 里塞了 4 个关注点（诊断/配置探测/目录检索/处方聚合），本轮加"现搜合并"后又长了。

### 跨平台 `[实测]`

`plugin/index.js:280-282` `joinPath(...parts){ return parts.join('\\') }` 被 `:264,267-268` 用于 `fs.watch`/`readdirSync`。仓库带 POSIX 脚本（`install.sh`/`run.sh`），但在 macOS/Linux 上 `startWatching` 会全部失败，且失败被 `:246-248` 静默吞掉 → 面板退化成"只有点刷新才有数据"，正是 `:151-165` 注释声称已修掉的旧体验。

### 交付体验 `[审计]`

- `install.sh:184-191` 的 `copy_payload` **不含 `install.sh` 自身**，`:212-213` 却 `chmod +x "$target/install.sh"`（`|| true` 静默）→ 安装目录里没有它，无法就地重装
- `install.sh:161-171` 未识别平台时只打印提示并 **`exit 0`** → 不支持的环境里一键安装仍报成功
- 装完不打印版本；`package.json` 又是 0.1.0
- 面板 IA：唯一可执行产出（处方）被压在"问题卡 → 未检测到异常 → 未实现 → 不可实现"四段之后；notDetected 在 `client.js:1189-1199` 与 `:1202-1211` **重复展示两遍**；同一批处方在 `report.mjs:248/:315-317/:325` 三处重复暴露
- 术语 `C1/A3/E5` 在报告与面板里**都没有图例**
- 最常见的故障（宿主跑旧代码）给出**错误诊断**：`client.js:1079-1090` 把 404 解释为"宿主未挂载 webServer 服务"，正确解释在 `:1144`；`stale` 横幅（`:1104`）只在请求成功时可达 —— 最需要"请重启"的场景反而没提示

---

## 7. 值得肯定的地方

1. **零运行时依赖**，只靠 Node 原生 zstd；`node_modules/` 为空仍能完整运行
2. **注释解释"为什么"**，并把踩过的坑写进代码（loop-guard 误报、内置包碾压社区插件、14.7s 预算超时）—— 这是本项目最稀缺的品质
3. **处方 YAML 是正确的**：实测 `repeat-reminder-tighten` 产出片段包含 `name:` 与完整 config，并附注"profile patch 按 id 定位、整体替换该行的 config，所以片段里要把这一行需要的键写全"—— 最容易埋雷的地方做对了
4. **隐私取舍明确**：适配层刻意不落对话正文（`dsh.mjs:280-282` 连危险命令参数都只记模式标签）；联网现搜只发能力关键词并把 `sent` 回写报告
5. **生成物没有进仓库**：`agent-clinic-report.md` 在 `.gitignore` 里，实测未被 git 跟踪 —— 避免了把本机会话数据推到公开仓库
6. **降级路径真的会降级**：本轮同时观察到 GitHub 中继 403 与 npm 通道正常，报告如实打印 `⚠ …失败：HTTP 403` 而不是假装搜过
7. **证据定位经抽查属实**：E5 的"同一 read 调用 3 次"展开后确为参数完全相同的三次调用（问题在展示层，不在结论层）

---

## 8. 建议路线图

### P0（做完才算"结论可信"）

| # | 动作 | 验收 |
|---|---|---|
| 1 | **修 C1 基线**（F12）：改会话自身前段窗口对比；排除空会话与子代理；按请求数归一；修正"自身基线"措辞 | 13 个会话里命中数从 6 降到与本机实际浪费相符；报告措辞与算法一致 |
| 2 | **修 A2 前提**（F13）：从 `skill` 调用参数取技能名；两个技能目录去重；补 evidence | 已调用的 `agent-clinic` 不再被判闲置 |
| 3 | **收 A3**（F14）：去对称重复、排除读写编辑组合、headline 改实例数、加可复用性判据 | A3 从 18 条降到个位数且每条站得住 |
| 4 | 修正 5 项指标的定性（F1）：把"数据源缺失"改为"适配层未抽取/隐私取舍未定" | 报告不再出现"数据源缺失"字样 |
| 5 | 抽取零隐私代价三项：`tool/result` 记 `text_len`(E3)、`approval/asked|decided`(N3)、`llm/retry`(N4) | 三项能出结论且不含正文 |
| 6 | 修静默降级（F4）：区分 ENOENT / EACCES / 解析失败；`report` 显示解析失败会话数 | 权限错误时明说"读不到" |
| 7 | 处方撤销可见（F16）：渲染 `skipped` 及原因；统一 `spill-tighten`/`pruner-tighten` 处理 | 最该补 spill 预算的用户能看到该条或明确知道为何没有 |
| 8 | 稳定两条红断言（F5） | 连跑 5 次自检项数一致 |

### P1（一致性与发布质量）

| # | 动作 | 验收 |
|---|---|---|
| 9 | 文档数字与三张指标清单从代码生成 + 断言一致（F6/F9） | README/SKILL/docs 无硬编码项数；`docs/diagnostics.md` 与 REGISTRY 一致 |
| 10 | 统一隐私与联网措辞（F10/F21）；`--no-network` 分支明确披露未联网 | 未联网时报告写明"只读本地目录" |
| 11 | 接线 `maxSessions`/`minRepeatCount`/`contextLines`（F7）或在 schema 删除；联网预算三处统一（F11） | 改旋钮有可观察效果 |
| 12 | `reasoning-effort` 只写 `reasoningEffort` 或回填当前 provider（F17） | 不改变用户模型路由 |
| 13 | 证据范围展开 `-L<end>`；复核命令改 `node src/cli.mjs show`（F18） | 955 行跨度的 E5 可从报告直接复核 |
| 14 | 加 CI 跑 smoke（三平台） | PR 上自动红绿 |

### P2（能力与工程）

| # | 动作 | 验收 |
|---|---|---|
| 15 | 新增"压缩可观测性"维度（compaction/\*）：触发频率 / 实测释放量 / prune 比例（F2.1） | 报告给出实测释放 token，替代启发式估算 |
| 16 | token 口径声明 + 辅助请求开销上界估算（F3） | C1 不再把主对话口径当全部开销 |
| 17 | 拆 `analyze()`（222 行）为 4 个关注点；`ClinicPanel` 拆组件 | 单函数 ≤ 80 行 |
| 18 | 删死代码（`src/state.mjs` 等 6 处 + 悬空 @deprecated）；合并 3 处已分叉重复实现 | grep 不再出现；`resolveDshHome` 只剩一处 |
| 19 | 修 `install.sh`（自带自身、未识别平台 exit 1、打印版本）；`joinPath` 改 `path.join` | 三平台安装/监听可用 |
| 20 | 面板 IA：处方提到首屏、notDetected 收一行、术语图例、404 统一指向"完全重启" | — |

---

## 附录 A：逐指标判定依据与误报/漏报（校准用）

阈值**全部**是代码内魔法数（`opts.x ?? 默认`），无外部配置项。

| 指标 | 判定依据 | 阈值来源 | 已知误报/漏报 |
|---|---|---|---|
| C1 | 会话 assistant `output_tokens` 之和 > 全会话中位数 × 1.5 | `diagnostics/index.mjs:130-163` | **见 F12**：混杂空/子代理会话、无归一；会话 ≤2 时永不判 |
| C2 | `last.input > first.input × 10` 且缓存占比 < 0.3，需 ≥8 条 assistant | `:169-205` | 纯相对、无绝对体量下限（2→21 token 也报）；吃缓存红利的真膨胀会话主动漏掉（`:185` 注释自认） |
| C3 | USER_MSG+ASSISTANT_MSG 计数 > 200 | `:211-235` | **不看 compaction**（与 `:208-209` 注释冲突）→ 压过也报（F19） |
| E1 | 同 `tool_name\|args_hash` 且 `is_error`，≥3 次 | `:71-112` | args 哈希对语义等价写法不鲁棒 → 漏报；幂等重试报为死循环 |
| E2 | 失败/总结果 ≥ 0.3 且调用 ≥10 | `:241-268` | 阈值偏高 → 小会话漏报；一次环境性批量失败即触发 |
| E4 | 取**最后一条** `todo/write`，`total>0 && done===0` 且其后 tool_call ≥5 | `:335-367` | 只看最后一条计划；`todo_count` 结构不符返回 null → 静默不判 |
| E5 | 同 `tool_name\|args_hash` 成功且全有配对结果，≥3 次 | `:285-325` | 跨轮重复读同文件是真阳（本机 `read` 3 次为真）；幂等轮询也算冗余 → 误报 |
| N1 | 命令类失败 ≥3（不要求同参） | `:381-411` | 3 个不同命令各失败一次即报，与环境故障不可区分 |
| N2 | adapter `danger` 标签聚合 | `:414-437` + `dsh.mjs:98-109` | 命令文本子串命中、含 `node/python` → 噪声（F19） |
| A2 | 窗口跨度 ≥30 天；skill 目录名 vs tool_name | `:543-591` | **见 F13**：必然误报 + 重复条目 + 无证据 |
| A3 | 相邻工具对重复 ≥5，会话调用 ≥10 | `:452-488` | **见 F14**：正规工作流全命中 |
| A4 | 子代理 token 占比 ≥0.4 | `:494-532` | 子代理多为正常委派；分母含空会话 → 易越线 |

## 附录 B：复核命令（本机 `node` 不在 PATH）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

& $node scripts\smoke.mjs                          # 自检（当前 182）
& $node src\cli.mjs report                         # 体检（默认零外发）
& $node src\cli.mjs report --live --live-budget 15000   # 联网现搜

# F1/F2：枚举全部事件类型与条数
& $node --input-type=module -e "import {findSessionFiles,resolveSessionsRoot} from './src/adapters/dsh.mjs'; import {decodeFramesFromFile} from './src/adapters/zstd-frames.mjs'; const t=new Map(); for (const f of findSessionFiles(resolveSessionsRoot({}))) { const {text}=decodeFramesFromFile(f); for (const l of text.split('\n')) { if(!l.trim())continue; let r; try{r=JSON.parse(l)}catch{continue}; if(r.type) t.set(r.type,(t.get(r.type)??0)+1); } } console.log([...t.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+' '+v).join('\n'));"

# F12：C1 的基线与命中
& $node --input-type=module -e "import {analyze} from './src/report.mjs'; import {scanSessions} from './src/adapters/dsh.mjs'; import {summarize} from './src/summary.mjs'; const s=scanSessions({}); const d=analyze({scan:s,summary:summarize(s)}); console.log(d.findings.filter(f=>f.id==='C1').map(f=>f.summary).join('\n'));"

# F13：skill 是否以同名工具出现
& $node --input-type=module -e "import {findSessionFiles,resolveSessionsRoot} from './src/adapters/dsh.mjs'; import {decodeFramesFromFile} from './src/adapters/zstd-frames.mjs'; const n=new Map(); for (const f of findSessionFiles(resolveSessionsRoot({}))) { const {text}=decodeFramesFromFile(f); for (const l of text.split('\n')) { if(!l.trim())continue; let r; try{r=JSON.parse(l)}catch{continue}; if(r.type==='tool/call') n.set(r.data?.name,(n.get(r.data?.name)??0)+1); } } console.log([...n.keys()].join(', '));"
```

## 附录 C：证据来源与复核状态

| 结论 | 来源 | 复核状态 |
|---|---|---|
| F1 F2 F2.1 F3 F4 F5 F6 F7 F8 F12 F13 F14 F16 F17 F18 F21 | 评估人亲自实测 | 已逐条跑过（命令见附录 B） |
| F9 F10 F11 F19 F20 及 P2 各条 | 子代理审计（代码质量 / 文档交付 / 功能有效性） | 抽样复核：`src/state.mjs` 零引用、`joinPath` 硬编码反斜杠、`maxSessions/minRepeatCount` 未透传、`remedies.mjs:192` 硬编码 provider、E5 955 行跨度 —— 均已确认；其余为审计结论，未逐条复核 |

> 本轮为**只读审计 + 一处回归修复**（F8）。除 F8 的修复与回归护栏外未改动任何代码 —— 路线图待确认后再动。
