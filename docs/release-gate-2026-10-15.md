# 发行放行检查记录（2026-10-15）

> 本轮**只做检查**，不改任何代码或指标口径。检查对象：仓库当前 `main` HEAD
> （`72d7dcc`「ci: action 升 v7 + Linux runner 钉版本 + ubuntu-26.04 迁移探针」，2026-10-15 15:18）。
> 判定依据：`docs/plan-2026-10-15.md` §5「发布门槛」+ 第三方评估报告 §八 顺序。

---

## 0. 判定

> ## ✅ 可以进入发行上线阶段 —— 但限于 **DSH 平台**、且走 **预发布（RC）通道**
> ### ⚠️ 不能直接进 GA（0.2.0 正式）：有 4 项「发行动作」未完成，其中 1 项需凭据

**理由**：方案 §5 的四条质量门槛**全部通过**（每条都有断言守护，不是人工判断）；
第五条"以上全绿才谈上线"已满足。当前 `package.json` 版本是 `0.2.0-rc.1`，
按语义化版本本就属于预发布 —— 与"先发 RC 观察"的发行策略一致。

**没有任何一项质量问题构成阻断**；未完成的都是**发行动作**（打 tag / 切 CHANGELOG / 填凭据 / 更新安装地址）。

---

## 1. 质量门槛（方案 §5 前 4 条）逐条取证

| # | 门槛 | 实测 | 判定 |
|---|---|---|---|
| 1 | smoke 降级语义修复 + CI 造合成会话 | 合成语料下 `通过 307 · 失败 0 · 跳过 0`；空数据降级 `通过 2 · 失败 0 · 跳过 2` 且 **exit 0**；`DSH_SMOKE_REQUIRE_DATA=1` 时空数据会红 | ✅ |
| 2 | 现搜条目进处方层 | 构造输入断言：`prescribeOne` 直连 + 报告接线（单点/合并卡）+ 7 类问题全局轮转仍含插件；**并新增"名额 8 覆盖 ≥4 类"与"名额说明"断言** | ✅ |
| 3 | N3 被拒判定修复 | 三条断言：`approved/accept/granted/ok/allow` 不计被拒；`deny/rejected/declined` 计被拒；其余计"结果无法识别" | ✅ |
| 4 | 徽章 == 实际通过数 | 徽章守护内建进 smoke（README 三处 + SKILL.md）；`--write-badge` 可回写；当前 307/307 一致 | ✅ |

## 2. 独立取证（本次实跑，非引用文档）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 自检总条数 | `DSH_HOME=<语料> DSH_SMOKE_REQUIRE_DATA=1 AGENT_CLINIC_SKILL_DIRS=… node scripts/smoke.mjs` | **通过 307 · 失败 0 · 跳过 0**，exit 0 |
| 语料覆盖率 | `node scripts/fixtures/synth-dsh.mjs --verify` | **命中 21/21 个指标**（会话 27 个），exit 0 |
| 插件面板测试 | `node scripts/plugin-dom.test.mjs` | **通过 76 · 失败 0**，exit 0 |
| 空数据降级 | `DSH_HOME=<空目录> node scripts/smoke.mjs` | 退出码 0（不冒充全绿） |
| 空数据报告 | `DSH_HOME=<空目录> node src/cli.mjs report` | exit 0 |
| 指纹命令 | `node src/cli.mjs fingerprints` | exit 0（可读、可 `--clear`） |
| 语法完整性 | 对 `src/`、`scripts/`、`plugin/` 共 **24 个 `.mjs`/`.js`** 逐个 `node --check` | **语法错误 0** |
| 仓库卫生 | `git ls-files` 过滤 `*.jsonl|*.zstd|agent-clinic-report.md|.tmp/|.agent-clinic/|*-msg.txt` | **无命中**（会话数据、报告、临时产物均未入库） |
| 隐私卫生 | `git grep` 本机绝对路径 / 用户名 | **无命中** |
| 遗留标记 | `git grep TODO|FIXME|XXX` | 4 处均为误报（`KIND.TODO_WRITE` 等），**无真实遗留标记** |
| 包元数据 | `package.json` | `name=agent-clinic` · `version=0.2.0-rc.1` · `private=false` · `engines.node>=22.15.0` · `bin` 指向存在的文件 · `files` 9 项全部存在 · `dependencies` 为空（零依赖） |
| CI 实况 | shields.io CI 徽章（`ci.yml@main`） | **build: passing** |
| 已发布 tag | shields.io tag 徽章 / `git tag -l` | 最新为 **v0.1.1**（本地 tag：v0.1.0 / v0.1.1） |

> **取证局限（如实标明）**：GitHub Actions API 因出口 IP 额度用尽返回 403，
> 因此本次**无法逐 job 复核**最新一次运行的 8 个 job 明细；
> 用的是独立信号（shields.io 徽章 = passing）。仓库自身记录显示
> `d6fd3b7` / `51735fd` / `3d8140a` / `dfb84a7` 四次运行均 **7/7 全绿**。
> 第七轮的 job 数 7 → 8 由那一次运行自证，**建议在放行前用浏览器打开 Actions 页确认一眼**。

## 3. 未完成项（发行动作，非质量问题）

| 序 | 事项 | 谁做 | 为什么现在没做 | 是否阻断 |
|---|---|---|---|---|
| A | **npm 发布 `0.2.0-rc.1`（`--tag next`）** | 需要你给 `NPM_TOKEN`，或你在有 npm 的机器上执行 | 本机**没有 npm**（`npm`/`npm.cmd`/`corepack`/`npm-cli.js` 全无，`~/.npmrc` 不存在） | **阻断 npm 通道**；不阻断 git/install.sh 通道 |
| B | **打 tag `v0.2.0-rc.1`** | 我（一条命令） | 从未打过 0.2.x tag（最新 v0.1.1） | 不阻断发布本身，但**发行版必须有 tag**（jsDelivr 备用地址依赖 tag） |
| C | **CHANGELOG 从 `[Unreleased]` 切版** | 我（文档改动） | 第五/六/七轮都在 `[Unreleased]` 下 | 建议切版后再发；否则发布物没有对应的变更说明 |
| D | **README 一行安装的 jsDelivr 备用地址仍钉 `@v0.1.1`** | 我（文档改动） | 该行写于 v0.1.1 时期，需随 tag 更新 | 不阻断（主地址走 `main` 可用），但会误导镜像用户 |

## 4. GA（0.2.0 正式）前建议处理，但**不阻断 RC**

1. **K2 噪声按真实使用校准**：K2 是**代理判据**（日志里没有"已解决"的显式信号），
   本机实测报 2 处（LOW + 措辞"疑似"）。RC 期间观察真实报告是否偏吵，必要时加"两次出现间隔 ≥N 天"。
2. **面板测试空白**（D9 已登记）：真实计时器（6 秒轮询 / 复制 1.4 秒复位）、CSS 布局、
   `liveBusy` 中间态、watch 签名变化后面板自动刷新、Escape 关闭。属"测试空白"而非已知功能缺陷。
3. **WorkBuddy 口径要一致**：`install.sh:156` 会在 `~/.workbuddy` 存在时把 skill 部署到
   `~/.workbuddy/skills/`，但 `src/adapters/` 里**只有 DSH 适配器**（无 WorkBuddy）。
   README 能力表已如实写「WorkBuddy 平台 ⏳ 待实现」，但安装节读起来像"支持"。
   建议二选一：安装节加一句"WorkBuddy 会话解析尚未实现"，或 `install.sh` 在 WorkBuddy-only 场景给提示。
4. **本机指纹快照不可写（环境事实）**：DSH 沙箱 workspace-write 下写 `~/.agent-clinic/` 报 EPERM；
   当前行为是如实报"**已判定但没存下**"（K1/K2 本次仍判定，只是跨会话历史不累积）。
   若要在真实使用中累积，需要在非沙箱上下文运行。
5. **A1（MCP 闲置）**：继续排期 —— 本机无任何 MCP 配置，没有可判定数据源；报告已如实列出。

## 5. 结论摘要（一句话给决策）

**代码与质量门已具备发行条件**：21 项指标全部可复核、307 条自检全绿、三平台 CI 通过、
零依赖、仓库无隐私泄漏。**"进入发行上线阶段"的唯一前置是你选一条凭据路径（A）**；
其余三项（B/C/D）是发版例行动作，我可以在你点头后一次性做完。

---

### 附：本次检查执行的最小命令集

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\fixtures\synth-dsh.mjs --verify
$env:DSH_HOME = (Resolve-Path .tmp\synth-home).Path
$env:DSH_SMOKE_REQUIRE_DATA = '1'
$env:AGENT_CLINIC_SKILL_DIRS = "$env:DSH_HOME\agents-skills"
& $node scripts\smoke.mjs
& $node scripts\plugin-dom.test.mjs
```
