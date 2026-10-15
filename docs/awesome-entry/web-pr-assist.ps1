<#
  向 awesome-dsh-plugin 提收录 PR —— 网页路线的"手把手"助手

  它替你做了三件容易出错的事：
    ① 把要提交的 YAML 放进**剪贴板**（你不用手抄，避免漏字符/被引号坑）；
    ② 打开**预填了路径**的 GitHub 新建文件页面；
    ③ 在你贴完、进入 PR 页面后，再把 **PR 正文**放进剪贴板。

  用法（在 agent-clinic 仓库根执行）：
    pwsh docs\awesome-entry\web-pr-assist.ps1

  过程中它会在两个地方停下来等你按回车，照着屏幕上的字点即可。
#>
[CmdletBinding()]
param(
  [string]$ForkOwner = '1687210989',
  [switch]$SkipOpen   # 只把内容放进剪贴板并打印提示，不打开浏览器
)

$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot '1687210989__agent-clinic.yml'
if (-not (Test-Path $entry)) { throw "找不到条目文件：$entry" }
$yaml = (Get-Content $entry -Raw).TrimEnd() + "`r`n"

$targetRepo = 'awesome-dsh-plugin/awesome-dsh-plugin'
$newFileUrl = "https://github.com/$targetRepo/new/main/data/plugins/1687210989__agent-clinic.yml"
$forkUrl = "https://github.com/$targetRepo/fork"
$topicsUrl = 'https://github.com/1687210989/agent-clinic/settings'

$prBody = @"
- [x] 新增一个 ``data/plugins/1687210989__agent-clinic.yml`` 文件（未改 README，也未改他人条目）
- [x] 仓库 ``package.json`` 声明了 **``dsh.bundle``**（``dsh.bundle.patch: ./cordis.patch.yml``）
- [x] 仓库创建于 2026-10-13，已满 1 天
- [x] ``category: usage``（在允许取值内）
- [x] 描述只说功能、无营销词，且每条声明都可对着代码核对
- [x] 仓库已打 ``dsh-plugin`` topic

推荐项（已满足）：
- npm 已发布 ``agent-clinic@0.2.0``（预构建安装，用户一条命令即可）
- 官方 ``@deepseek-ai/*`` 走 ``peerDependencies``；``dependencies`` 为空（零运行时依赖）
"@

function Say($text, $color = 'White') { Write-Host $text -ForegroundColor $color }
function Set-Clip($text, $label) {
  try {
    Set-Clipboard -Value $text
    Say "   已放入剪贴板：$label" 'Green'
  } catch {
    Say "   ⚠ 剪贴板不可用（$($_.Exception.Message)）—— 下面是内容，请手工复制：" 'Yellow'
    Write-Host $text
  }
}

Say ''
Say '════════ 第 0 步：给自己的仓库加 topic（只需一次）════════' 'Cyan'
Say "1. 打开：$topicsUrl"
Say '2. 页面右侧 About 那一行的最右边有个齿轮 ⚙ → 点它'
Say '3. 在 Topics 输入框里输入： dsh-plugin   →  点 Add'
Say '4. 点输入框下方的 Save（或按回车）'
Say ''
Read-Host '做完后按回车继续'

Say '════════ 第 1 步：打开 GitHub 的新建文件页（会提示 fork）════════' 'Cyan'
Say "链接：$newFileUrl"
Say '（如果它提示你需要先 fork：点页面上的 “fork this repository” / “Create a new fork”，'
Say "  或先手动打开 $forkUrl 点 Create fork）"
Set-Clip $yaml '要提交的 YAML 内容'
if (-not $SkipOpen) {
  Start-Process $newFileUrl
  Say '   已尝试在你的浏览器里打开这个页面' 'Green'
}
Say ''
Read-Host '浏览器打开后按回车继续（接下来把内容粘进去）'

Say '════════ 第 2 步：粘贴 + 提交 ════════' 'Cyan'
Say '1. 文件名框里应该已经是： data/plugins/1687210989__agent-clinic.yml （不要改）'
Say '2. 点内容大框，按 Ctrl+A 全选删掉，再按 Ctrl+V 粘贴（内容已在剪贴板）'
Say '3. 页面底部 “Commit message” 填： Add 1687210989/agent-clinic'
Say '4. 点绿色按钮 “Propose new file”'
Say '5. 下一页点 “Create pull request”（先别提交，先完成下面第 3 步）'
Say ''
Read-Host '进入 PR 页面后按回车，我把 PR 正文放进剪贴板'

Say '════════ 第 3 步：填 PR 标题与正文 ════════' 'Cyan'
Say 'PR 标题（手动输入或复制）：Add 1687210989/agent-clinic'
Set-Clip $prBody 'PR 正文（含 6 个必勾项）'
Say '1. 标题填： Add 1687210989/agent-clinic'
Say '2. 正文框：Ctrl+V 粘贴（内容已在剪贴板），确认 6 个 [x] 都在'
Say '3. 点 “Create pull request”'
Say ''
Say '✅ 完成标志：页面上出现你的 PR，且下方开始跑 CI 检查。' 'Green'
Say '   把 PR 链接贴给我，我帮你盯评审意见。' 'Green'
