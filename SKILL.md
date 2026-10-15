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

1. **出报告**：运行 `./run.sh report`，得到带证据的体检报告（含处方）
2. **复核**：对报告里的任一结论，用 `./run.sh show "<定位符>"` 展开原始记录亲眼确认
3. **只报事实**：没有检测到问题的维度必须显式说明，不要编造问题
4. **给方案**：每条问题至少给一条**可执行**处方；报告末尾另附「省 token 开关清单」（陈列，不是结论）

## 硬性约束

执行本技能时必须遵守：

| 约束 | 说明 |
|---|---|
| **只读** | 绝不修改 `~/.dsh/` 下任何文件（读 profile 配置是为了说出"当前值"，也只读） |
| **零外发（默认）** | 体检本体（scan / diagnose / report / 面板）默认不发送任何内容到外部服务。**联网动作只有两个，都需显式指定**：<br>① `./run.sh catalog-sync` —— 同步插件目录（npm registry + 经 `gh-proxy.com` 中继的 GitHub 公开仓库元数据），不上传任何本地数据；<br>② `./run.sh report --live` —— **发现问题后当场联网现搜插件**（见下） |
| **可定位** | 每个结论必须附 `file#L` 定位，不可复现的结论不出 |
| **未异常要说明** | 没有检测到问题的维度必须显式列出"未检测到异常" |
| **处方必须可执行** | 每条处方必须给出：YAML 片段 / 命令 / 插件安装入口 / 界面路径 / 指向具体动作的建议；并附**分步操作指引**、风险、验证方式、出处 |
| **不编插件** | 只推荐插件目录里的包，且每条都要说明**命中原因**；目录条目三类并标出处（人工核实 / npm 同步 / GitHub 核实），官方内置包单独标注；**热度（star / 下载量）如实展示，只用于同分排序、不参与对症打分**；检索不到就诚实说"无插件可解" |
| **处方有上限** | 默认最多 4 条，每个问题至少 1 条；当前值已经不弱于建议时**撤掉该条**并说明原因；同一个插件只出现一次 |
| **不代安装** | 处方只给命令与片段，由用户自己执行 |

## 环境要求

- Node ≥ 22.15（原生 zstd 解码）
- **node 不必在 PATH 上** —— `./run.sh` 会自动定位（PATH → WorkBuddy 托管目录 → DSH 运行时 → nvm/volta/fnm 等）
- 若自动定位失败，可用 `AGENT_CLINIC_NODE=/path/to/node` 显式指定
- 缺依赖时必须**明确报错**，绝不静默跳过数据

## 命令

统一用 `./run.sh`（自动定位 node，无需 node 在 PATH）：

```bash
./run.sh report                  # 体检报告（推荐入口，读本地目录）
./run.sh report --live           # 体检 + **发现问题后当场联网现搜插件**（npm + GitHub）
./run.sh report --live --live-budget 15000   # 联网预算（毫秒，默认 12000）
./run.sh scan                    # 扫描概览
./run.sh diagnose                # 只跑诊断，不生成完整报告
./run.sh show "<file>#L<n>"      # 展开证据，复核结论
./run.sh show "<file>#L2-L211" --limit 20 --offset 20   # 长区间显式分页（截断提示里给的就是这条命令）
./run.sh fingerprints            # 查看本地文本指纹快照（K1/K2 的数据基础；只存加盐哈希，正文不落盘）
./run.sh fingerprints --clear    # 删除该快照
./run.sh catalog                 # 查看插件目录（人工核实 + npm 同步 + GitHub 核实，按热度排序）
./run.sh catalog-sync            # 同步插件目录（npm + GitHub）
./run.sh catalog-sync --source github   # 只同步 GitHub 方向（经 gh-proxy.com 中继 GitHub API）
./run.sh catalog-sync --pool 900 --limit 150 --gh-discover 40   # 扩大候选池 / 收录数 / GitHub 核实数
./scripts/smoke.sh               # 自检（307 项）
node scripts/plugin-dom.test.mjs # 插件面板的零依赖 DOM 桩测试（76 条）
```

**K1/K2 的隐私开关**：`AGENT_CLINIC_NO_FINGERPRINT_STORE=1` 可整体关闭指纹采集；
关闭（或快照损坏）时报告会在"未检测到异常"里写明 K1/K2 **未采集/未判定** —— 是"没查"，不是"没问题"。

自检在**没有本地会话**的环境里也能跑：先用合成语料装置造一份确定性语料，
再要求"跳过数必须为 0"（CI 就是这么跑的）。徽章/声称的条数由 smoke 自己在跑完后核对，
对不上即以退出码 1 结束；确认无误用 `--write-badge` 回写。

```bash
node scripts/fixtures/synth-dsh.mjs --out .tmp/synth-home    # 覆盖全部 21 项已实现指标，固定时间戳
node scripts/fixtures/synth-dsh.mjs --verify                 # 每项指标至少命中 1 处，否则非零退出
DSH_HOME=.tmp/synth-home DSH_SMOKE_REQUIRE_DATA=1 \
  AGENT_CLINIC_SKILL_DIRS=.tmp/synth-home/agents-skills node scripts/smoke.mjs
node scripts/smoke.mjs --write-badge                         # 全绿后回写 README/SKILL 的条数声称
```

A2「skill 闲置」默认读宿主机的 `~/.agents/skills`、`~/.workbuddy/skills`；
`AGENT_CLINIC_SKILL_DIRS` 可覆盖该名单（CI 与合成自检用它，免得断言绑在跑测机器上）。

### 发现问题后联网找方案（`report --live`）

体检默认只读本地目录，可能过期。`--live` 会在诊断出问题之后**当场**按问题的能力需求
去 npm registry 与 GitHub 现搜插件，把新发现的并进目录再生成处方。面板上对应
「联网现搜插件」按钮（走独立端点 `/api/agent-clinic/live`，不点就不联网）。

三条承诺：

1. **只发问题类型，不发会话内容** —— 检索词由指标推导（如 C1 → `context compression`），
   报告里用 `实际发出的检索词` 一行原样列出，可自行核对。
2. **不能拖死体检** —— 默认 12s 预算，到点带已有结果返回并标记降级；
   网络全断只是"本次没搜到"，报告照常出。
3. **不编造** —— 拿不到的字段留空；联网失败/降级/超时都会在报告与面板里写明。

## 已实现的诊断指标

| ID | 名称 | 判定 |
|---|---|---|
| C1 | token 消耗过快 | 会话单位请求 output 超主会话基线 2 倍（且总量 ≥2 万 token） |
| C2 | 上下文膨胀 | 末轮/首轮 input 增长 >10x 且 cacheRead <30% |
| C3 | 长会话疲劳 | 单会话消息数 >200 |
| C5 | 压缩可观测性 | 单会话压缩 ≥3 次，给出 **DSH 实测**释放 token |
| C6 | 工具面成本 | 工具 schema >20000 字符 + 窗口内 0 调用的工具 ≥5 个 |
| C7 | 上下文注入量 | 上下文被注入 ≥20 次且 ≥100000 字符 |
| E1 | 死循环 | 同工具 + 同参数 + 同错误，重复 ≥3 次 |
| E2 | 反复失败 | 会话工具错误率 >30%（样本 ≥10 次调用） |
| E3 | 工具结果过大 | 单条工具结果 >8192 字符且会话内 ≥5 条 |
| E4 | 计划执行脱节 | 写计划后又大量调用工具但 0 条完成 |
| E5 | 冗余重复调用 | 同工具 + 同参数 + 无错误，重复 ≥3 次 |
| N1 | 环境命令反复失败 | 命令类调用失败 ≥3 次 |
| N2 | 高风险操作 | 命令执行类工具命中 rm -rf / --force / reset --hard 等 |
| N3 | 权限审批摩擦 | 审批请求 ≥5 次（给出等待时长与被拒比例） |
| N4 | API 重试频繁 | 模型请求重试 ≥3 次（给出失败码与累计退避） |
| A2 | skill 闲置 | 已装 skill 在 ≥30 天窗口内 0 次触发 |
| A3 | 高频手动序列 | 非通用工具的两步序列 ≥5 次（去镜像、跨会话合并） |
| A4 | 子代理开销 | 子委托会话 token 占比 >40% |
| A5 | 辅助 LLM 开销 | 辅助模型调用 ≥20 次，给出 maxTokens 上界 |

**1 项排期**：A1 MCP 闲置（本机未配置 MCP）。
**2 项尚未实现**：K1/K2 跨会话失忆类 —— 原因**不是**平台没有数据，而是本工具按隐私约束
不落对话正文；要做得改用文本指纹，方案未定。报告中会写明原因，不会假装全知。
指标定义与阈值以 [docs/diagnostics.md](docs/diagnostics.md) 为准（与代码 REGISTRY 有断言对齐）。

## 处方的三种"可执行"

报告里的处方只有四类内容，出现别的就说明有人又写了空话：

1. **改配置** —— 一段可整段粘进 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 YAML，
   并写明「当前值 → 建议值」与这份文件的确切路径
2. **跑命令 / 装插件** —— `/compact` 这类斜杠命令，或已核实的插件安装入口
3. **改设置** —— 图形界面里点哪里、改成什么
4. **行为建议** —— 必须指向具体动作（含实测的工具名与次数），不是"要更细心"

详见 [docs/remedies.md](docs/remedies.md)。
