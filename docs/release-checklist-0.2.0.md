# 0.2.0 正式上线清单（GA runbook）

> 用途：把"正式上线"变成一串**可勾选、可复核**的动作，每步都写明**谁做**、**命令**、**证据**。
> 当前基线：HEAD `6d86fe6`（工作区干净）· npm 上 `0.2.0-rc.2` · 自检 343 条 · 面板 106 条 · 语料 22/22。
> 决策依据见 [docs/plan-2026-10-15.md](plan-2026-10-15.md)，发行历史见
> [docs/release-gate-2026-10-15.md](release-gate-2026-10-15.md) §6。

---

## 0. 只有你能做的四件事（我做不了或需要你决定）

| # | 事项 | 为什么是你 | 建议 |
|---|---|---|---|
| U1 | **npm 发布凭据** | 发布鉴权只能用凭据；另外旧 token 需要在**网页**删除（API 吊销被 npm 403 拒绝） | 二选一：① 复用现有 `dsh-clinic` token（有效期到 2026-10-22，仍能发布）；② 新建一个 granular token（`package: write`）并把旧的删掉（更干净） |
| U2 | **GitHub Release** | 本机没有 GitHub API 凭据（无 `GITHUB_TOKEN`、未装 `gh`） | 在仓库 → Releases → Draft a new release → 选 tag `v0.2.0` → 粘贴 [docs/release-notes-0.2.0.md](release-notes-0.2.0.md) |
| U3 | **确认 GA 范围** | 这是产品决定 | 我建议：GA 就发当前 HEAD（22/22 指标）。K2 是软信号、已按"低+疑似"约束，**不必等观察期** |
| U4 | **macOS 额度（可选）** | 需要你的账号看账单 | GitHub → Settings → Billing → Actions usage，确认 macOS 分钟是否紧张（今天出现过"排队 15 分钟拿不到 runner 被取消"） |

## 1. 我一次做完的九步（每步都有证据）

| # | 动作 | 命令 / 产物 | 证据 |
|---|---|---|---|
| 1 | 版本号 `0.2.0-rc.2` → `0.2.0` | `package.json` | `node -e "console.log(require('./package.json').version)"` → `0.2.0` |
| 2 | CHANGELOG 切 GA 段 | `## [0.2.0] — <日期>` + 上线亮点（rc.1 / rc.2 段保留为历史） | `git show v0.2.0:CHANGELOG.md` |
| 3 | 安装地址随版本更新 | README / SKILL 的 `@v0.2.0-rc.2` → `@v0.2.0`、`--ref v0.2.0`、jsDelivr 地址 | 实取 jsDelivr `@v0.2.0/install.sh` → HTTP 200 |
| 4 | **全量本地验收** | `node scripts/smoke.mjs`（343）· `node scripts/panel-dom.test.mjs`（106）· `synth-dsh --verify`（22/22）· 空数据降级 · 真机 `report` | 全部 exit 0 |
| 5 | 提交 + 打 tag | `git tag -a v0.2.0` → push `main` 与 tag | `git ls-remote --tags origin` 见 `v0.2.0^{}` → 发行提交 |
| 6 | **等 tag 触发的 CI** | tag 推送会走**全量矩阵**（macOS 两个 node + ubuntu 24.04/26.04 + windows） | 逐个 job 看结论（⚠️ 不要只看徽章 —— 徽章可能显示缓存结果） |
| 7 | **从干净 tag 打包**（rc.2 的教训：发布物必须等于 tag） | `node scripts/publish-npm.mjs`（预演） | 打印"版本 0.2.0 · 48 文件 · 自校验通过" |
| 8 | npm 发布（GA 用 `latest`） | `NPM_TOKEN=… node scripts/publish-npm.mjs --publish --tag latest --also-latest` | 202/200 → 随后 `--verify` |
| 9 | **发布后自证 + 干净安装测试** | `--verify --tag latest`；再用 npm 装到临时目录跑 `scan/report/catalog/fingerprints/rx` | tarball 与本地**逐字节一致**；六个子命令 exit 0 |

> 第 8 步注意两条已知规则（都踩过）：
> · **一次发布只能带一个 dist-tag**（多带会 400）；`--also-latest` 是发布成功后再单独改 `latest`；
> · 账号带 2FA 时 registry 可能返回 **202（已接受）** —— 那是"分阶段发布"，不是失败，脚本会如实报并在稍后用 `--verify` 复核。

## 2. 上线后（24 小时内建议做的三件事）

| # | 事项 | 说明 |
|---|---|---|
| P1 | 看一次真实报告 | 在**非沙箱**上下文跑 `./run.sh report`：K1/K2 的指纹快照才能写进 `~/.agent-clinic/`（沙箱里会如实报"已判定但没存下"） |
| P2 | 收集反馈 | 处方反馈已可用（`./run.sh rx reject <目标 ID>`）；把真实抱怨记下来，作为下一轮输入 |
| P3 | 可选清理 | npm 上的 `0.0.0-stage` 占位（分阶段发布的痕迹）可选删除；**留着也不影响安装**，`latest` 已指向 0.2.0 |

## 3. 上线前已知且**不阻断**的空白（避免上线后被当成事故）

1. **WorkBuddy 未适配**：`install.sh` 会在 `~/.workbuddy` 存在时部署 skill，但只有 DSH 适配器 ——
   安装脚本与 README 都已写明"装了也扫不到"，自检有断言守着这条口径一致；
2. **v3 会话格式未验证**（无压缩 `.jsonl` 已支持）；
3. **配置层只解析 `cordis.patch.yml` 的 YAML 子集**；"随附默认值"是抄录表，DSH 升级后需同步；
4. **面板暂无反馈按钮**（反馈用 CLI `rx`）；面板测试仍有已列明的空白（真实计时器 / CSS 布局 /
   React 语义 / 事件系统 / 网络竞态）；
5. **A1 在窗口不足 30 天时不下结论**（本机会话历史目前只有几天，会如实写"再过约 N 天生效"）；
6. **macOS CI 依赖 GitHub 容量**：单次排队可能十几分钟，仓库侧已加固（concurrency + 矩阵分档 + 超时），
   但排队本身不可控。
