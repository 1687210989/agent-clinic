<#
  向 awesome-dsh-plugin 提收录 PR —— 命令行路线（路线 B）

  为什么有它：对方要求"一个 PR 只加一个文件"，而最容易踩的坑是
  （a）顺手改了 README（它们是生成物）、（b）动到别的条目（评审第 6 条会追问）。
  这个脚本只做一件事：把本仓库 docs/awesome-entry/ 下那**一个**条目文件复制进
  fork 的 data/plugins/，并在提交前用 git 自检"本次改动恰好只有一个新增文件"。

  用法（先做两件手工事）：
    1. 在网页点一次 Fork：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/fork
    2. 给**自己的仓库**加上 `dsh-plugin` topic（仓库页 → About ⚙ → Topics）
  然后：
    pwsh docs/awesome-entry/open-pr.ps1 -ForkOwner <你的 GitHub 用户名>

  可选参数：
    -Branch  add-agent-clinic   # 分支名
    -WorkDir <路径>             # 克隆目录（默认 $env:TEMP\awesome-plugin-pr）
    -DryRun                     # 只到"提交前自检"，不 push
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ForkOwner,
  [string]$Branch = 'add-agent-clinic',
  [string]$WorkDir = (Join-Path $env:TEMP 'awesome-plugin-pr'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # 仓库根
$entryName = '1687210989__agent-clinic.yml'
$entrySrc = Join-Path $PSScriptRoot $entryName
$entryRel = "data/plugins/$entryName"
$upstream = 'awesome-dsh-plugin/awesome-dsh-plugin'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '找不到 git' }
if (-not (Test-Path $entrySrc)) { throw "找不到条目文件：$entrySrc" }

# ① 条目文件必须已经是我们仓库里提交过的那一份（避免"本地改了没提交"就发出去）
Push-Location $root
$tracked = git ls-files --error-unmatch "docs/awesome-entry/$entryName" 2>$null
$dirty = git status --porcelain -- "docs/awesome-entry/$entryName"
Pop-Location
if (-not $tracked) { throw "条目文件还没被 git 跟踪：docs/awesome-entry/$entryName（先 commit）" }
if ($dirty) { throw "条目文件有未提交改动，先 commit 再发 PR：$dirty" }
Write-Host "① 条目文件已跟踪且干净：docs/awesome-entry/$entryName" -ForegroundColor Green

# ② 克隆/更新 fork
if (-not (Test-Path (Join-Path $WorkDir '.git'))) {
  Write-Host "② 克隆 fork：https://github.com/$ForkOwner/$upstream.git → $WorkDir"
  git clone "https://github.com/$ForkOwner/$upstream.git" $WorkDir
} else {
  Write-Host "② 复用已有克隆：$WorkDir（拉取最新 main）"
  Push-Location $WorkDir
  git checkout main
  git pull --ff-only origin main
  Pop-Location
}

Push-Location $WorkDir
try {
  # ③ 分支 + 复制那一个文件
  git checkout -B $Branch main
  New-Item -ItemType Directory -Force -Path 'data/plugins' | Out-Null
  Copy-Item $entrySrc (Join-Path $WorkDir $entryRel) -Force
  Write-Host "③ 已写入 $entryRel" -ForegroundColor Green

  # ④ 自检：本次改动必须恰好是一个**新增**文件（防"顺手改 README/改别人条目"）
  git add $entryRel
  $status = git status --porcelain
  $added = ($status | Where-Object { $_ -match '^A\s' }).Count
  $other = ($status | Where-Object { $_ -notmatch "^A\s+$([regex]::Escape($entryRel))$" })
  Write-Host "   本次改动：$added 个新增文件" -ForegroundColor Cyan
  if ($other) {
    Write-Host '   ⚠ 还有其它改动，按对方规则应当剔除：' -ForegroundColor Yellow
    $other | ForEach-Object { Write-Host "     $_" }
    throw 'PR 只应包含一个新增文件；请把上面的改动撤掉后重试'
  }
  if ($added -ne 1) { throw "新增文件数应为 1，实际 $added" }
  Write-Host '④ 自检通过：本次 PR 恰好只新增这 1 个文件' -ForegroundColor Green

  if ($DryRun) {
    Write-Host '（-DryRun：到此为止，没有提交也没有 push）' -ForegroundColor Yellow
    return
  }

  # ⑤ 提交 + push + 打印 PR 链接
  git commit -m "Add 1687210989/agent-clinic"
  git push -u origin $Branch
  $compare = "https://github.com/$upstream/compare/main...${ForkOwner}:${upstream}:${Branch}?expand=1"
  Write-Host ''
  Write-Host '⑤ 已推送。打开下面这个链接创建 PR（页面里勾选模板中的 6 个必勾项）：' -ForegroundColor Green
  Write-Host "   $compare"
  Write-Host ''
  Write-Host '   PR 标题建议：Add 1687210989/agent-clinic'
  Write-Host '   PR 正文：勾选模板 6 项；并说明已发布 npm 包（agent-clinic@0.2.0）、官方 @deepseek-ai/* 走 peerDependencies'
} finally {
  Pop-Location
}
