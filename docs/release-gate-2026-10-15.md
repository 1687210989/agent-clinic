# 发行放行检查记录（2026-10-15）

> 本轮**只做检查**，不改任何代码或指标口径。检查对象：仓库当前 `main` HEAD
> （`72d7dcc`「ci: action 升 v7 + Linux runner 钉版本 + ubuntu-26.04 迁移探针」，2026-10-15 15:18）。
> 判定依据：`docs/plan-2026-10-15.md` §5「发布门槛」+ 第三方评估报告 §八 顺序。
>
> **2026-10-15 更新**：检查通过后已执行发行（tag `v0.2.0-rc.1` + npm 发布），
> 结果与教训见 §6 / §6.1；本文档因此从"放行检查"变成"放行 + 发行记录"。

---

## 0. 判定

> ## ✅ **已发行**：`0.2.0-rc.1` 已可通过三种通道安装（npm / git tag / main）
> ### ⚠️ 仍未进 GA（0.2.0 正式）：RC 需要观察期，且见 §4 的 5 条建议

**理由**：方案 §5 的四条质量门槛**全部通过**（每条都有断言守护，不是人工判断）；
第五条"以上全绿才谈上线"已满足。当前 `package.json` 版本是 `0.2.0-rc.1`，
按语义化版本本就属于预发布 —— 与"先发 RC 观察"的发行策略一致。

**四项发行动作（tag / CHANGELOG / 凭据 / 安装地址）全部完成**，记录见 §6；
npm 发布结果与三个真实教训见 §6.1。

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
| 插件面板测试 | `node scripts/plugin-dom.test.mjs` | **通过 106 · 失败 0**，exit 0（并自带"文档条数声称"核对） |
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
| A | **npm 发布 `0.2.0-rc.1`（`--tag next`）** | ✅ **已完成** | 2026-10-15 10:26 UTC 发布成功：`dist-tags { next: 0.2.0-rc.1, latest: 0.2.0-rc.1 }`。因为本机没有 npm CLI，走的是仓库自带的**零依赖发布通道** `scripts/publish-npm.mjs`（自己打 tar+gzip → 解包逐字节自校验 → `PUT registry.npmjs.org`）。**复核方式：装一遍再跑**（见 §6） |
| B | 打 tag `v0.2.0-rc.1` | ✅ 已完成 | 随本次发行推送（见 §1.4 记录） |
| C | CHANGELOG 从 `[Unreleased]` 切版 | ✅ 已完成 | 新增 `## [0.2.0-rc.1] — 2026-10-15` 段，累计 6 轮未发版改动归入其下；顶部保留空的 `[Unreleased]` |
| D | README 安装地址随版本更新 | ✅ 已完成 | jsDelivr 备用地址 `@v0.1.1` → `@v0.2.0-rc.1`；`--ref` 示例同步；安装节顶部新增「当前版本 `0.2.0-rc.1`（预发布通道）」与 npm 通道待开放说明 |

**发行后仍待完成的唯一一件事**：npm 发布（见上表 A 项）。凭据用法（脚本按顺序查找，三种任选其一）：

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

### 6.1 npm 发布记录与三个真实教训

**结果（2026-10-15 10:26:36 UTC）**

| 检查 | 实测 |
|---|---|
| packument | `GET registry.npmjs.org/agent-clinic` → 200 |
| dist-tags | `{"latest":"0.2.0-rc.1","next":"0.2.0-rc.1"}` |
| 版本列表 | `0.0.0-stage`（npm 的占位版本，历史痕迹）、`0.2.0-rc.1` |
| tarball 完整性 | 下载 329,594 字节，本地重算 sha512 **与 registry 声明一致**；包内 47 条目、`package.json` 版本 `0.2.0-rc.1` |
| **装一遍再跑** | `npm install agent-clinic@next` → `added 1 package`；版本读出 `0.2.0-rc.1`；`src/cli.mjs help`/`scan` 正常，空数据优雅退出（exit 0）；`.bin` 里生成了 `agent-clinic` / `.cmd` / `.ps1` 三个 shim |

**教训 1：HTTP 202 不是失败**。首次 `--publish` 返回 `202 {"success":true}`，
我的脚本按"只认 200/201"打成 `❌ 发布失败：HTTP 202` —— 而 registry 其实**已经接受**。
真相是 npm 的**分阶段发布（staged publish）**：账号带 2FA 时先建占位版本
`0.0.0-stage`，正式版本随后生效（本次是自动生效的）。
修法：`classifyPublishResponse()` 把 2xx 一律当"已接受"，并按 body/409 文案区分
"已在审核区 / 版本已存在 / 凭据不足 / 真失败"；自检里加了 2 条断言钉住
（其中一条就是"202 必须判为 staged，不是失败"）。

**教训 2：发布脚本正确路由是 `POST /-/stage/package/<name>`**（响应带回 `stageId`），
而经典路由是 `PUT /<name>`。两者都能触发分阶段发布，但只有前者会把 `stageId`
交给你去 `POST /-/stage/<stageId>/approve`。本次用经典路由发出、靠 npm 自动放行成功；
若账号策略要求人工批准，就必须用 stage 路由（或 npm 网站）拿 id 再批准。

**教训 3（卫生）**：`--verify` 会去 registry 把包拉回来对 integrity。
发布之后我又改了 `scripts/publish-npm.mjs`，于是 `--verify` 现在如实报
"本地打包与已发布内容不一致" —— 这**不是故障**，而是它在正确工作：
**下一次发布请从已提交（最好已打 tag）的状态打包**。

**凭据说明（重要）**：本次使用的 token 是**可绕过 2FA 的 granular token**；
registry 在响应头里发了提醒 —— npm 正在限制这类 token 用于直接发布
（"npm tokens that bypass 2FA are being restricted for account changes and direct publishing"）。
建议：**用完即轮换/吊销**（尤其它曾出现在聊天记录里），后续发布优先用
`npm stage publish` + 网页批准，或改用带 2FA 的发布流程。

实测到的 token 事实（`npm token list`）：名称 `dsh-clinic`，id **`a209b6`**，
权限 `package:write`，`bypass_2fa: true`，**有效期至 2026-10-22**（7 天），此刻尚未吊销。
吊销一条命令：`npm token revoke a209b6`。

### 6.2 发行后按优先级修复的三个问题（2026-10-15，提交 `2c526c9`）

发行之后继续"还剩什么问题 → 按优先级依次修"，本轮修掉三项，每项都配了守护断言：

| 序 | 问题 | 修法 | 守护断言 |
|---|---|---|---|
| A | **README 的「已知缺陷」表失真**：把 4 条本轮已修的东西继续写成"未修"（定位符两份 / `show` 200 行上限 / A3 硬编码 / 面板无浏览器测试） | 表拆成「已关闭」（8 条，附决策号）+「仍未修」（4 条）+「测试空白」一节；旧措辞全部清除 | 2 条：旧措辞四句若重现即红；"已关闭"的说法必须与代码事实一致（`parseRange` 是转发 / `learnedGenericTools` 存在 / `plugin-dom.test.mjs` 存在） |
| B1 | **WorkBuddy 只有安装、没有适配器**（`install.sh:156` 会静默部署到 `~/.workbuddy/skills`） | `install.sh` 部署到 WorkBuddy 时打印诚实警告；README 安装节补同样说明 | 1 条：**只要适配器还不存在**，README 与 install.sh 就必须都写明"装了也扫不到"（将来实现了适配器，这条会自动提示同步措辞） |
| C | **CLI 行为只有源码级正则**（`scripts/smoke.mjs:2288` 读一眼文件里有没有那几行字） | `src/cli.mjs` 加"仅直接执行才跑 dispatch"守卫（合成语料 fixture 的同一课），抽出纯函数 `parseShowOptions()` / `buildHelpText()`；顺带修掉 `--context` 给错值时被静默忽略的降级 | 6 条：导入无副作用 / 合法参数解析（含配置默认值）/ 7 个非法输入逐个报错 / help 覆盖全部子命令 |

结果：自检 **315 → 322 条全绿**，CI 对 `2c526c9` 判定 **success**。

### 6.3 面板测试补齐与 M3.5 处方反馈闭环（2026-10-15）

**面板测试 76 → 106 条**（补 watch 内容级刷新、现搜失败路径、5 种异常响应形状；
顺带修掉一处测试保真度隐患：fixture 硬编码宿主版本 `'14'` 而 `client.js` 已是 `'15'`，
此前所有渲染断言都跑在"宿主版本落后"分支上）。并让该测试**自己核对**文档里写的条数
（与 smoke 的徽章守护同一套做法）。

**M3.5 处方反馈闭环实现**（用户拍板"现在做"）：新增 `src/prescriber/feedback.mjs` 与
CLI 子命令 `rx`（`reject / interested / remove / clear`）。拒绝的处方不再给出，
报告单列「已按你的反馈撤掉的处方」（ID / 日期 / 理由）；「感兴趣」只标记不剔除；
读坏/写不进去都如实报错。第三个本地状态文件 `~/.agent-clinic/rx-feedback.json`
（只存处方 ID + 状态 + 用户自己写的理由）。自检 **322 → 332 条**。

**npm token 吊销的实测结论（如实记录）**：按用户决定执行 `npm token revoke a209b6` →
**HTTP 403 Forbidden**。原因是该 token 属于"可绕过 2FA 的 granular token"，
npm 正限制这类 token 做**账号级操作**（即 registry 响应头那条公告）。
→ 它**无法自我吊销**：需要在 npm 网站（浏览器会话）删除，或等 **2026-10-22** 自然过期。
`0.0.0-stage` 占位版本保留（npm 分阶段发布的固有痕迹；`latest`/`next` 已指向 `0.2.0-rc.1`）。

### 6.4 0.2.0-rc.2 发行（2026-10-15，指标 22/22 全实现）

**这一版的意义**：最后一个排期指标 **A1（MCP 闲置）** 实现 ——
诊断指标 **22 项全部已实现、0 项排期、0 项尚未实现**。
A1 的实现前提是用户先接入本地 filesystem MCP server（配置写在
`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `mcp-files` 行，server 装在
`~/.dsh/mcp-servers/filesystem`，用绝对 node 路径启动 —— 本机 node 不在 PATH 上）。

| 项 | 结果 | 复核方式 |
|---|---|---|
| 发行提交 / tag | `851cdab` · 附注 tag `v0.2.0-rc.2` | `git ls-remote --tags origin` |
| CI | run **38740563744** → **8/8 job success**（含 A1 在干净 runner 上的覆盖） | Actions API |
| 本地验收 | 自检 **340 条** · 面板 **106 条** · 语料覆盖率 **22/22** · 空数据降级与真机 report 均 exit 0 | 本机实跑 |
| npm 发布 | `dist-tags { next: 0.2.0-rc.2, latest: 0.2.0-rc.2 }` · tarball 从 registry 拉回**与本地逐字节一致** | `publish-npm.mjs --verify` |
| 装一遍再跑 | `npm install agent-clinic@next` → 版本 `0.2.0-rc.2`；`rx` 子命令可用；`diagnose` 里 A1 参与判定 | 本机实跑 |

**本轮踩到的坑（第 4 条发布教训）**：一次发布**只能带一个 dist-tag** ——
把 `{next, latest}` 同时塞进发布体会被 registry 直接拒绝：
`HTTP 400 {"error":"Must associate a single dist tag with new publishes."}`。
正确做法是**发布时只带一个 tag，成功后再单独调 dist-tags 接口**改另一个
（npm CLI 的 `npm dist-tag add` 走的就是它）——脚本里已实现为
`--also-latest`：先发 `next`，再 `PUT /-/package/<name>/dist-tags/latest`。

**A1 在本机的现状（如实说明）**：真机会话历史目前只有 **4.2 天**，A1 的观察窗口要求 ≥30 天，
所以它现在**不会**报"MCP 闲置"，而是在"未检测到异常的维度"里写明
"观察窗口只有 4.2 天…再过约 26 天本项才会开始生效"。
命中路径由合成语料（107 天窗口 + 0 调用）与自检第 24 段覆盖。

**一处必须说明的偏差（rc.2 专属）**：`0.2.0-rc.2` 的 tarball 是在**修完上面那个
"单 dist-tag" 问题之后**、从当时的工作区快照打包的，因此它与 tag `v0.2.0-rc.2`（`851cdab`）
逐字节**不完全一致** —— 差别只有 `scripts/publish-npm.mjs` 一个开发脚本（tag 里是修复前的版本）。
它不参与运行、不影响使用者，但**GA 发布要从干净 tag 打包**：先提交 → 打 tag → 从该状态打包发布，
避免再出现"发布物 ≠ tag"。

### 6.5 rc.2 之后两次 run 变红：macOS runner 排队被取消（非代码问题）

**现象**（来自 Actions API 原始数据，不是从 UI 猜的）：

| job | runner | steps | 起止 | 结论 |
|---|---|---|---|---|
| smoke (macos-latest · node 24) | **（空）** | **0** | created 13:42:03 → started 13:42:03 → done 13:57:06 | **cancelled（15 分 03 秒）** |
| smoke (macos-latest · node 22.15.0) | **（空）** | **0** | 同上 | **cancelled** |
| 其余 6 个 job | GitHub Actions… | 16（隐私 job 5） | 都在 33 秒内跑完 | success |

两个 macOS job **没拿到 runner、一步都没执行**，排队 15 分钟后被取消；
同一份代码的上一次 run（`851cdab`）macOS 是 **55 秒绿**的。
⇒ 结论：**不是代码失败**，是 GitHub 托管 macOS runner 的容量/额度
（macOS 计费是 Linux 的 10 倍，当天共 22 次 workflow ≈ 44 个 macOS job）。

**加固**（提交见 CI 文件头部注释）：`concurrency` 取消同 ref 旧 run；
push 用轻量矩阵（macOS 只跑 node 24）、tag/手动触发用全量矩阵；
每个 job 加 `timeout-minutes`（拿不到 runner 时快速失败并写明原因）。
plan 步骤的 bash 已用本地 git bash 真跑三种触发验证（light 6 项 / full 7 项）。

> ⚠️ 教训（写给自己）：我之前说"CI 徽章 passing"是**误读** —— shields 徽章反映最近**完成**的 run，
> 最新 run 还在排队/被取消时它会显示缓存的旧结果。**判断 CI 状态要看 run 列表的逐个 job**，
> 不能只看徽章。






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
