# agent-clinic · Agent 体检诊所

> **你的 Agent 体检诊所。** 只读扫描本地 Agent 会话，用**可逐条复核的证据**诊断真实发生的使用体验问题（token 浪费、死循环、跨会话失忆、资产闲置），并为每个问题开出可执行的处方。

[![status](https://img.shields.io/badge/status-M1%20skeleton-yellow)]()
[![node](https://img.shields.io/badge/node-%3E%3D22.15-blue)]()
[![license](https://img.shields.io/badge/license-MIT-green)]()

---

## 它解决什么问题

大多数 Agent 使用分析工具只给你一堆统计数字，你看完也不知道该干什么。

agent-clinic 的做法不同：**它给证据，也给处方。**

- 不只说"你有死循环"，而是说"10 月 8 日这个会话，`list_agents` 用同样的参数失败了 4 次，在 `session.v4.jsonl.zstd#L101-L108`"——一条命令你就能自己复核。
- 不只给建议，而是给**能装的插件**或**明确说没有插件能解**。

> **不做的事**：不主动推送、不代你安装、不改你的配置、不诊断代码质量、不把任何对话内容发到外部。

---

## 当前状态

| 能力 | 状态 |
|---|---|
| DSH 会话解析（多帧 zstd） | ✅ 可用 |
| 统一事件模型 | ✅ 可用 |
| 聚合统计 | ✅ 可用 |
| 证据层 `show` | ✅ 可用 |
| **DSH 插件脚手架** | 🚧 契约已验证，待真实 DSH 加载 |
| 诊断指标 E1 / E2 | 🚧 进行中 |
| 体检报告 | ⏳ 待实现 |
| 处方匹配 | ⏳ 待实现 |
| WorkBuddy 平台 | ⏳ 待实现 |

**当前版本是 M1 骨架**，`scan` 与 `show` 已可实际使用；冒烟测试 **26/26 通过**（`node scripts/smoke.mjs`）。

---

## 安装

本仓库支持**两种安装路径**，同一个仓库两种用法：

### 路径 A · 作为 Skill（推荐，零改动）

```bash
git clone https://github.com/<owner>/agent-clinic.git
cd agent-clinic
./install.sh          # 自动检测平台并部署到 ~/.agents/skills/
```

装完对 DSH 说「**体检一下**」即可触发。

### 路径 B · 作为 DSH Plugin（原生工具）

```bash
dsh plugin --profile <profile> add -w git+https://github.com/<owner>/agent-clinic.git
# 装完必须重启 Harness —— 插件只在启动时装载
```

注册两个模型可见工具：`agent_clinic_scan`、`agent_clinic_show`。

> ⚠️ `-w`（workspace root）是必须的，漏掉会报 `ERR_PNPM_ADDING_TO_ROOT`。
> 完整发布与安装步骤见 [DSH 插件指南](../agent-clinic-DSH插件发布与安装指南.md)。

**零依赖** —— 不需要 `npm install`，只需要 Node ≥ 22.15（用于原生 zstd 解码）。

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
# 扫描并输出概览
node src/cli.mjs scan

# 展开某条证据（复核用）
node src/cli.mjs show "~/.dsh/sessions/<...>/session.v4.jsonl.zstd#L101-L108"
```

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
L4 处方层   问题 → 处方（≤2 条，须自证有效）
  ▼
L5 输出层   体检报告 + 证据清单 + 处方卡片
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
- 需要 Node ≥ 22.15（低版本会明确报错，不会静默跳过数据）
- 目前只实现 2 个诊断指标
- 需要 `~/.agents/skills/` 目录存在（`install.sh` 会自动创建）

### ⚠️ 关于 DSH 数据格式

DSH 会话文件是**多帧 zstd 拼接**（单个文件实测含 60~233 个帧）。
`zlib.zstdDecompressSync()` 和流式 API **都只能解出第一帧**。
本项目的 `src/adapters/zstd-frames.mjs` 按 magic number 手工切帧，已在真实数据上验证 463/463 帧成功。详见 [docs/data-formats.md](docs/data-formats.md)。

---

## 路线图

- **M1**（进行中）DSH 解码 + E1/E2 + 证据层 + 报告
- M2 扩展 C1/C2/A1/A2
- M3 处方池 + 四重过滤 + 反馈闭环
- M4 体检报告卡片（可分享）
- M5 开源发布（SKILL.md / install.sh / 文档）
- M6 全维度 + 生态接入
- M7 WorkBuddy 平台

---

## License

MIT
