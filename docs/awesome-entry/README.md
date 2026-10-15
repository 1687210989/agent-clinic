# 提交到 awesome-dsh-plugin 的条目（本地副本）

这个目录放着**要提交给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的那一个文件**。
放在这里是为了：① 有版本记录（改了描述能看出改了什么）；② 以后更新条目不用重新推导。

## 提交方式（对方仓库的规则）

对方的 `contributing.md` 说得很明确：**一个 PR 只加一个文件**，文件名为
`data/plugins/<owner>__<repo>.yml`。两个 README 由脚本从 `data/plugins/*.yml` 生成，
**不要手工编辑 README**。

所以：

1. Fork 对方仓库；
2. 新建文件 `data/plugins/1687210989__agent-clinic.yml`，内容 = 本目录同名文件；
3. 提 PR（只改这一个文件）。

想本地预览自己那一行长什么样（可选，提交生成结果也照样接受）：

```sh
npm ci
node scripts/generate-readme.mjs
```

## 提交前的前置条件（对方要求，2026-10-15 核对）

| 要求 | 我们的状态 |
|---|---|
| `package.json` 声明 **`dsh.bundle`** manifest（能被 `dsh plugin add` 安装） | ✅ `dsh.bundle.patch: ./cordis.patch.yml` |
| 仓库根有 `cordis.patch.yml`，且形状是 `- insert:` + `id/name(/config)` | ✅ 见仓库根同名文件 |
| 是真实可用的代码（非占位 / 非空壳） | ✅ 22 项指标、343+ 条自检、面板测试 |
| 仓库创建满 **1 天** | ✅ 创建于 2026-10-13（CI 自动查） |
| 处于活跃维护 | ✅ 当天仍在提交 |
| 仓库加 **`dsh-plugin`** topic | ⚠️ **待你操作**（GitHub 仓库页 → About ⚙ → Topics → 加 `dsh-plugin`） |
| 描述只说功能、不带营销词、**内容属实**（维护者会对着代码核） | ✅ 描述里的每个声明都有对应实现（22 项指标 / `show` 证据定位 / 处方含风险与验证 / `rx` 反馈闭环 / 零依赖与只读） |
| 分类贴合实际做的事 | 选 `usage`（Usage & Billing）；选不准维护者会直接改，不会因此打回 |

## 已知的"邻近条目"（评审会问"是否已被覆盖"）

对方规则第 4 条：两个插件做同一件事时先来者保留位置，但"**谁更好**"才是规则，且**确实做了新东西**也可以收。
列表里最接近的是：

- `que3sui/dsh-darwin#sentinel` —— "Session health-check: mechanically mines session logs into structured
  problem tickets (retry loops, tool-error clusters, interrupted turns, token waste)"。

我们的差异点（也是上面描述里刻意写出来的）：
**①有名字有阈值的 22 项诊断**（对方是 4 类"problem ticket"）；
**②每条结论带可复演的定位符**（`session.v4.jsonl.zstd#L101-L110`，配 `show` 命令当场核对）；
**③把结论变成可执行处方**（profile patch 片段 / 命令，含当前值→建议值、风险、验证方式、出处），
并且在"你的当前值已经不弱于建议"时**主动撤掉**并写明原因；
**④处方反馈闭环**（`rx reject` 之后不再出现，且报告写明是你撤掉的）；
**⑤只读 + 零依赖 + 默认零外发**，跨会话记忆用加盐哈希快照（正文不落盘、可 `--clear`）。

## 收录之后（可选）

对方提供了一个徽章（README 的 `## Badge` 一节）：

```markdown
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
```

合并后可以加进我们 README 的顶部——那时再加，避免"还没收录就挂徽章"。
