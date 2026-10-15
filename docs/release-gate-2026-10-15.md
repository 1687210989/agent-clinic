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

> **2026-10-15 更新**：B / C / D 已完成并随 tag `v0.2.0-rc.1` 一起发布；
> A（npm 发布）仍等凭据，但**执行路径已备好且被 CI 验证**（见下）。

| 序 | 事项 | 状态 | 说明 |
|---|---|---|---|
| A | **npm 发布 `0.2.0-rc.1`（`--tag next`）** | ⏳ **等凭据** | 本机**没有 npm**（`npm`/`npm.cmd`/`corepack`/`npm-cli.js` 全无，`~/.npmrc` 不存在）。为此新增**零依赖发布通道** `scripts/publish-npm.mjs`：自己按 `files` 白名单打 tar+gzip → **解包回来逐字节自校验** → 直接 `PUT registry.npmjs.org`。预演实跑：`47 个文件 · tgz 320.8 KiB`，自校验通过；`--publish` 才联网。凭据就绪后一条命令即可：`node scripts/publish-npm.mjs --publish`（或 `npm run publish:npm:go`） |
| B | 打 tag `v0.2.0-rc.1` | ✅ 已完成 | 随本次发行推送（见 §1.4 记录） |
| C | CHANGELOG 从 `[Unreleased]` 切版 | ✅ 已完成 | 新增 `## [0.2.0-rc.1] — 2026-10-15` 段，累计 6 轮未发版改动归入其下；顶部保留空的 `[Unreleased]` |
| D | README 安装地址随版本更新 | ✅ 已完成 | jsDelivr 备用地址 `@v0.1.1` → `@v0.2.0-rc.1`；`--ref` 示例同步；安装节顶部新增「当前版本 `0.2.0-rc.1`（预发布通道）」与 npm 通道待开放说明 |

> **发行后仍待完成的唯一一件事**：npm 发布（见上表 A 项）。凭据用法（脚本按顺序查找，三种任选其一）：

```bash
# ① 环境变量（推荐，不落盘）
NPM_TOKEN=<token> node scripts/publish-npm.mjs --publish
# ② 写进 ~/.npmrc（脚本会读其中的 _authToken）
#    //registry.npmjs.org/:_authToken=<token>
# ③ 账号开了 2FA 时补一次性验证码
node scripts/publish-npm.mjs --publish --otp 123456
```

> 未实测的部分如实标明：**上传那一步（`PUT` + 鉴权）从没有真实执行过**（因为一直没有 token）；
> 被验证的是它前面的一切（打包、自校验、发布体构造、凭据查找），且 CI 会在三平台都跑一遍打包预演。
> 首次真发时如果 registry 有额外要求（例如 `_npmVersion` 字段或 2FA 策略），按返回的 HTTP 错误现场调整。

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

**RC 已经发出**：tag `v0.2.0-rc.1`（附注 tag → 发行提交 `8ffd724`）已推送，
CHANGELOG 切版、安装地址更新、零依赖发布通道三件事都完成并各自验证过
（远端 tag 直查、jsDelivr 实取 200、CI 8/8 job 全绿、自检 **313 条全绿**）。

**剩下的唯一一件**是 npm 通道：它需要凭据，代码与执行路径已就绪
（`scripts/publish-npm.mjs --publish`，打包部分已被 CI 在三平台验证）。

---

## 6. 发行执行记录（2026-10-15）

| 项 | 结果 | 复核方式 |
|---|---|---|
| 发行提交 | `8ffd724`「release(0.2.0-rc.1): 切 CHANGELOG + 更新安装地址 + 零依赖发布通道」 | `git log --oneline -1` |
| tag | 附注 tag `v0.2.0-rc.1` → 对象 `9e3ad3f2…` → commit `8ffd724e…`（= `refs/heads/main` 头） | `git ls-remote --tags origin`（直查远端） |
| CHANGELOG 切版 | `## [0.2.0-rc.1] — 2026-10-15` 段已建，累计 6 轮未发版改动归入其下 | `git show v0.2.0-rc.1:CHANGELOG.md` |
| 安装地址 | README 的 jsDelivr 备用地址改为 `@v0.2.0-rc.1`，`--ref` 示例同步 | **实取验证**：`https://cdn.jsdelivr.net/gh/1687210989/agent-clinic@v0.2.0-rc.1/install.sh` → **HTTP 200（7,727 字节）** |
| CI（发行提交） | run **38718200107** → **8/8 job success**（含 `ubuntu-26.04` 迁移探针） | GitHub Actions API |
| 打包器跨平台 | 新增步骤「发布打包器自检（预演，不联网）」在 **windows-latest / macos-latest / ubuntu-24.04 / ubuntu-26.04** 全部 success | 同上（逐 job 步骤） |
| 自检 | **313 条全绿**（新增 6 条发行护栏） | `node scripts/smoke.mjs` |

> 环境限制如实记录：`raw.githubusercontent.com` 在本机被 hosts 拦（已知），
> 因此"raw 直取安装脚本"这一步**没法在本机验证**；改用了两条不受影响的证据 ——
> git 协议直查远端 tag/分支，以及 jsDelivr（走 CDN）实取 200。


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
