---
name: agent-clinic
description: Agent 使用体验诊断与处方。只读扫描本地 DSH 会话，用可复核的证据诊断 token 浪费、死循环、跨会话失忆、资产闲置等问题，并为每个问题开出可执行处方。当用户说"体检一下"、"诊断一下"、"我哪里在浪费 token"、"Agent 用得有没有问题"时使用。
license: MIT
---

# agent-clinic · Agent 体检诊所

## 何时使用

用户表达以下意图时触发：

- "体检一下" / "诊断一下"
- "我哪里在浪费 token"
- "Agent 用起来有没有什么问题"
- "帮我看看我的使用习惯"

**仅被动触发**，不做定时任务、不主动推送。

## 触发后做什么

1. **扫描**：运行 `./run.sh scan`，读取 `~/.dsh/sessions/`（只读）
2. **诊断**：运行 `./run.sh diagnose`，逐项判定指标
3. **输出报告**：按 `docs/report-format.md` 的格式输出

## 硬性约束

执行本技能时必须遵守：

| 约束 | 说明 |
|---|---|
| **只读** | 绝不修改 `~/.dsh/` 下任何文件 |
| **零外发** | 不发送任何会话内容到外部服务 |
| **可定位** | 每个结论必须附 `file#L` 定位，不可复现的结论不出 |
| **未异常要说明** | 没有检测到问题的维度必须显式列出"未检测到异常" |
| **处方 ≤2 条** | 宁精勿滥；无对症插件时诚实说"无插件可解，给行为建议" |
| **不代安装** | 处方只给命令，由用户自己执行 |

## 环境要求

- Node ≥ 22.15（原生 zstd 解码）
- **node 不必在 PATH 上** —— `./run.sh` 会自动定位（PATH → WorkBuddy 托管目录 → DSH 运行时 → nvm/volta/fnm 等）
- 若自动定位失败，可用 `AGENT_CLINIC_NODE=/path/to/node` 显式指定
- 缺依赖时必须**明确报错**，绝不静默跳过数据

## 命令

统一用 `./run.sh`（自动定位 node，无需 node 在 PATH）：

```bash
./run.sh scan                    # 扫描概览
./run.sh diagnose                # 运行诊断
./run.sh show "<file>#L<n>"      # 展开证据
./run.sh report                  # 输出体检报告
./scripts/smoke.sh               # 自检（26 项）
```

若环境中 node 已在 PATH 上，也可直接：

```bash
node src/cli.mjs scan
```
