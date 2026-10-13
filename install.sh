#!/usr/bin/env bash
#
# agent-clinic 安装脚本（自举式）
#
# 两种用法：
#   1) 本地仓库内：   ./install.sh
#   2) 一行远程安装：  curl -fsSL https://raw.githubusercontent.com/1687210989/agent-clinic/main/install.sh | bash
#
# 特性：
#   - 自举：不在仓库内时会自动从 GitHub 获取源码
#   - 自动检测平台（DSH / WorkBuddy），无需用户选择位置
#   - 幂等：重复执行无副作用（旧版本先备份，绝不删除）
#   - 只写入本技能自己的目录，不动用户其他文件
#
# 参数：
#   --dry-run              预览，不实际写入
#   --target <dir>         指定安装目录（可重复）
#   --dsh-only             只装 DSH
#   --workbuddy-only       只装 WorkBuddy
#   --ref <branch|tag>     指定版本（默认 main）
#   -h, --help
#
set -euo pipefail

SKILL_NAME="agent-clinic"
REPO_SLUG="1687210989/agent-clinic"
REPO_URL="https://github.com/${REPO_SLUG}.git"
REF="${AGENT_CLINIC_REF:-main}"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY_RUN=0
DSH_ONLY=0
WB_ONLY=0
CUSTOM_TARGETS=()

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'USAGE'
用法:
  ./install.sh [选项]

选项:
  --dry-run              预览，不实际写入
  --target <dir>         指定安装目录（可重复使用）
  --dsh-only             只安装到 DSH（~/.agents/skills/）
  --workbuddy-only       只安装到 WorkBuddy（~/.workbuddy/skills/）
  --ref <branch|tag>     指定版本，默认 main
  -h, --help             显示本帮助

示例:
  ./install.sh
  ./install.sh --dry-run
  ./install.sh --dsh-only
  ./install.sh --target ~/my/skills

一行远程安装:
  curl -fsSL https://raw.githubusercontent.com/1687210989/agent-clinic/main/install.sh | bash
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)          DRY_RUN=1 ;;
    --dsh-only)         DSH_ONLY=1 ;;
    --workbuddy-only)   WB_ONLY=1 ;;
    --target)           shift; [ -n "${1:-}" ] || die "--target 需要参数"; CUSTOM_TARGETS+=("$1") ;;
    --ref)              shift; [ -n "${1:-}" ] || die "--ref 需要参数"; REF="$1" ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "未知参数：$1（用 --help 查看用法）" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# 定位源码：优先本地仓库，否则从 GitHub 自举
# ---------------------------------------------------------------------------
TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"; }
trap cleanup EXIT

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

say ""
say "agent-clinic 安装程序"
say "====================="
say ""

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/SKILL.md" ] && [ -d "$SCRIPT_DIR/src" ]; then
  SRC_DIR="$SCRIPT_DIR"
  ok "使用本地源码  $SRC_DIR"
else
  say "未在本地找到源码，正在从 GitHub 获取（ref: $REF）…"
  TMP_DIR="$(mktemp -d 2>/dev/null || printf '%s' "/tmp/agent-clinic-$$")"
  mkdir -p "$TMP_DIR"

  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$REF" --quiet "$REPO_URL" "$TMP_DIR/$SKILL_NAME" \
      || die "克隆失败。请检查网络，或手动克隆后运行 ./install.sh"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/${REPO_SLUG}/archive/refs/heads/${REF}.tar.gz" \
      | tar -xz -C "$TMP_DIR" \
      || die "下载失败。请检查网络，或手动克隆后运行 ./install.sh"
    mv "$TMP_DIR"/*-"${REF#v}" "$TMP_DIR/$SKILL_NAME" 2>/dev/null \
      || mv "$TMP_DIR"/* "$TMP_DIR/$SKILL_NAME" 2>/dev/null \
      || true
  else
    die "既没有 git 也没有 curl，无法自动获取源码。请手动克隆后运行 ./install.sh"
  fi

  SRC_DIR="$TMP_DIR/$SKILL_NAME"
  [ -f "$SRC_DIR/SKILL.md" ] || die "源码获取不完整（缺少 SKILL.md）"
  ok "已获取源码"
fi

# ---------------------------------------------------------------------------
# 前置检查 —— 用定位器找 node，不假设它在 PATH 上
# ---------------------------------------------------------------------------
NODE_BIN="$(bash "$SRC_DIR/scripts/find-node.sh" 2>/dev/null)" || NODE_BIN=""

if [ -z "$NODE_BIN" ]; then
  err "未找到可用的 Node.js（需要 >= 22.15.0）"
  say ""
  say "  本技能用 Node 的原生 zstd 解码读取 DSH 会话文件，无法绕过。"
  say "  已自动搜索 PATH、~/.workbuddy-ai/binaries/node、~/.dsh/dsh-runtimes、"
  say "  /c/Program Files/nodejs、nvm、volta、fnm 等常见位置，均未命中。"
  say ""
  say "  解决办法："
  say "    1) 安装 Node 22.x LTS 或更高：https://nodejs.org"
  say "    2) 或显式指定：AGENT_CLINIC_NODE=/path/to/node bash install.sh"
  say ""
  exit 1
fi

ok "Node $("$NODE_BIN" -p 'process.versions.node')"

# ---------------------------------------------------------------------------
# 平台检测（自动，无需用户选择）
# ---------------------------------------------------------------------------
HOME_DIR="${HOME:-$USERPROFILE}"
TARGETS=()

if [ "${#CUSTOM_TARGETS[@]}" -gt 0 ]; then
  TARGETS=("${CUSTOM_TARGETS[@]}")
else
  if [ "$WB_ONLY" -eq 0 ] && { [ -d "$HOME_DIR/.dsh" ] || [ -d "$HOME_DIR/.agents" ]; }; then
    TARGETS+=("$HOME_DIR/.agents/skills/$SKILL_NAME")
  fi
  if [ "$DSH_ONLY" -eq 0 ] && [ -d "$HOME_DIR/.workbuddy" ]; then
    TARGETS+=("$HOME_DIR/.workbuddy/skills/$SKILL_NAME")
  fi
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  warn "未检测到已安装的平台（既没有 ~/.dsh / ~/.agents 也没有 ~/.workbuddy）。"
  say ""
  say "  可显式指定安装目录："
  say "    bash install.sh --target <目录>"
  say ""
  say "  或直接以 CLI 形态使用（无需安装）："
  say "    ./run.sh scan"
  say ""
  exit 0
fi

say ""
say "安装目标（自动检测，共 ${#TARGETS[@]} 个）："
for t in "${TARGETS[@]}"; do say "  - $t"; done
say ""

# ---------------------------------------------------------------------------
# 部署
# ---------------------------------------------------------------------------
copy_payload() {
  local dest="$1"
  mkdir -p "$dest"
  for f in SKILL.md package.json README.md LICENSE cordis.patch.yml run.sh; do
    [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$dest/" 2>/dev/null || true
  done
  # 完整拷贝目录，保证「安装 = 仓库完整副本」（冒烟测试可自检通过）
  rm -rf "$dest/src" "$dest/docs" "$dest/scripts" "$dest/plugin"
  for d in src docs scripts plugin; do
    [ -d "$SRC_DIR/$d" ] && cp -R "$SRC_DIR/$d" "$dest/$d" 2>/dev/null || true
  done
}

for target in "${TARGETS[@]}"; do
  # 展开 ~
  case "$target" in "~"*) target="${HOME_DIR}${target#\~}" ;; esac
  say "部署到 $target"

  if [ "$DRY_RUN" -eq 1 ]; then
    ok "（dry-run，未实际写入）"
    continue
  fi

  # 幂等 + 非破坏：已存在则先备份，绝不直接删除用户数据
  if [ -d "$target" ]; then
    bak="${target}.bak-${STAMP}"
    mv "$target" "$bak"
    warn "已存在旧版本，备份至 $(basename "$bak")"
  fi

  copy_payload "$target"
  chmod +x "$target/run.sh" "$target/install.sh" 2>/dev/null || true
  chmod +x "$target"/scripts/*.sh 2>/dev/null || true
  ok "已安装"
done

# ---------------------------------------------------------------------------
# 隐私声明
# ---------------------------------------------------------------------------
say ""
say "隐私声明"
say "--------"
say "  · 诊断全流程在本地完成，会话文件只读，绝不修改"
say "  · 零外部请求，不发送任何会话内容"
say "  · 无遥测、无崩溃上报"
say "  · 状态文件只存「日期 + 一句话摘要」，删除即重置"
say ""
say "使用：对 Agent 说「体检一下」，或运行 ./run.sh scan"
say ""
