# Changelog

本项目遵循「一轮评估 → 一轮整改」的节奏；每个版本都附可复核的证据入口。

## [Unreleased]

### 第三轮：开采 DSH 实测数据源（依据 `agent-clinic-待优化报告-DSH单平台.md`）

**新增 4 项指标（15 → 19 项）** —— 全部零隐私代价（只记数字）：

- **C5 压缩可观测性**：采 `compaction/summary` 与 `compaction/prune` 的 `shadowedTokenCount`。
  C1/C2 是**推断**浪费，C5 是 DSH **自报的实测释放量**（本机实测释放 638,171 token，
  单会话最多 19 次压缩）。顺带修掉 C3：现在只数"最后一次压缩之后仍活着"的消息，
  不再对"压过 19 次的会话"建议 `/compact`。
- **C6 工具面成本**：采 `request/header` 的 `tools` 数组 —— 工具 schema
  每个请求都要重发，此前从未被计量（实测 29,779 字符 ≈ 7,445 token/请求；
  31 个注册工具中 9 个窗口内 0 调用）。
- **C7 上下文注入量**：采 `agent/inbox/spliced`（实测 96 次、158,393 字符）。
- **A5 辅助 LLM 开销**：采两类 `*-llm-request`。这些调用**没有 usage 记录**，
  此前完全不可见（实测 96 次，maxTokens 上界 381,120）。

**报告口径修正（F3）**：`token：input … output …` 现在写明「仅主对话
（assistant/message 的 usage）」，并单列一行辅助调用的上界估算 —— 此前读者会
以为那就是全部开销。

**A2 窗口算法修正**：从"事件时间跨度"改为"今天 − 首次会话时间"（日历跨度），
并报告活跃天数；不足 30 天时说明"还差 N 天生效"。旧算法会把
"60 天前用一次 + 昨天用一次"误判成闲置 60 天。

**A3 通用工具清单可配置**：`GENERIC_TOOLS` 支持 `opts` 覆盖（不自动学习，
原因见 `docs/diagnostics.md`）。

### 第二轮：评估整改（依据 `docs/evaluation-2026-10-14.md`）

- **修 C1 基线**：改「单位请求 output vs 仅主会话基线」，排除子代理与 0 产出会话，
  加绝对量下限（本机 6 处误报 → 1 处）
- **修 A2 判定前提**：技能名从 `skill` 工具的 `arguments.name` 取
  （旧版比 `tool_name`，永远匹配不上 → 窗口一到全部误报）
- **收 A3 噪声**：去镜像 + 任一端是通用工具即排除 + 跨会话合并（18 条 → 1 条）
- **E3 / N3 / N4 落地**：三项曾被判"数据源缺失"，实测证伪后实现
  （补 `text_len` / `approval/asked+decided` / `llm/retry` 字段）
- **去掉静默降级**：目录读不了 ≠ 没有会话；快照损坏 ≠ 没同步过
- **撤销处方可见**：报告与面板新增「已评估但未给出的处方」（含当前值）
- **修 F17**：`reasoning-effort` 处方不再硬编码 provider，
  改为 `preserveKeys` 沿用当前行的 provider/model
- **证据区间展开**：`show` 支持 `#L<start>-L<end>`（此前只打起点 ±2 行）
- **复核命令跨平台**：报告改给 `node src/cli.mjs show "…"`
- **报告显示 scan.errors**：解析失败的会话不再静默消失

### 第三轮工程基建（依据待优化报告 Phase 3）

- `joinPath` 改 `path.join`（macOS/Linux 上文件监听此前**全量失败**且被静默吞掉）
- `install.sh`：复制自身（此前装完无法就地重装）、未识别平台 `exit 1`
  （此前误报成功）、装完打印版本、隐私措辞与 README 对齐
- `package.json` 版本与 tag 对齐（0.1.0 → 0.1.1）
- 删死代码：`src/state.mjs` 整模块 + 5 处零引用导出 + 悬空 `@deprecated`
- 合并已分叉的重复实现：`resolveDshHome`（×2）、`fetchJson`/`mapLimit`（×2，
  抽到 `src/catalog/http.mjs`，并加数字参数的误用护栏）
- 加 CI：`.github/workflows/ci.yml`（三平台跑 smoke）
- 本 Changelog

## [0.1.1] — 2026-10-14

- 插件目录改为真从 npm registry 与 GitHub 同步（含中继通道），按热度检索、
  按能力标签推荐、已装不推、简介中文化
- 处方层重写：读本机真实配置，给出「当前值 → 建议值」与分步操作
- 面板：问题/处方可折叠、同类型问题合并成一张卡、联网现搜按钮

## [0.1.0] — 2026-10-13

- 首个可用版本：多帧 zstd 解码 + 统一事件模型 + 证据层 `show` + 体检报告
- 诊断指标 5 项（E1/E2/E5 + C 类骨架）
