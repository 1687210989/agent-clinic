#!/usr/bin/env bash
#
# agent-clinic 安装脚本
#
# 特性：
#   - 自动检测已安装的平台（DSH / WorkBuddy）
#   - 幂等：重复执行无副作用（旧版本先备份，不删除）
#   - 只写入本技能自己的目录，绝不动用户其他文件
#   - 支持 --dry-run 预览
#
set -euo pipefail

SKILL_NAME="agent-clinic"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "用法: ./install.sh [--dry-run]"
      exit 0
      ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------
say ""
say "agent-clinic 安装程序"
say "====================="
say ""

if ! command -v node >/dev/null 2>&1; then
  err "未找到 node。本技能需要 Node >= 22.15.0（用于原生 zstd 解码）。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 15 ]; }; then
  err "Node 版本过低：$(node --version)（需要 >= 22.15.0）"
  err "zstd 解码依赖 Node 22.15+ 的原生支持，低版本无法运行。"
  exit 1
fi
ok "Node $(node --version)"

# ---------------------------------------------------------------------------
# 平台检测
# ---------------------------------------------------------------------------
TARGETS=()

# DSH：共享 skill 目录
if [ -d "$HOME/.dsh" ] || [ -d "$HOME/.agents" ]; then
  TARGETS+=("$HOME/.agents/skills/$SKILL_NAME")
fi

# WorkBuddy
if [ -d "$HOME/.workbuddy" ]; then
  TARGETS+=("$HOME/.workbuddy/skills/$SKILL_NAME")
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  warn "未检测到已安装的平台（既没有 ~/.dsh 也没有 ~/.workbuddy）。"
  warn "仍可使用 CLI 形态：node src/cli.mjs scan"
  say ""
  exit 0
fi

say ""
say "检测到 ${#TARGETS[@]} 个安装目标："
for t in "${TARGETS[@]}"; do say "  - $t"; done
say ""

# ---------------------------------------------------------------------------
# 部署
# ---------------------------------------------------------------------------
copy_payload() {
  local dest="$1"
  mkdir -p "$dest"
  cp "$SRC_DIR/SKILL.md"      "$dest/" 2>/dev/null || true
  cp "$SRC_DIR/package.json"  "$dest/" 2>/dev/null || true
  cp "$SRC_DIR/README.md"     "$dest/" 2>/dev/null || true
  cp "$SRC_DIR/LICENSE"       "$dest/" 2>/dev/null || true
  rm -rf "$dest/src" "$dest/docs"
  cp -R "$SRC_DIR/src"  "$dest/src"
  cp -R "$SRC_DIR/docs" "$dest/docs"
}

for target in "${TARGETS[@]}"; do
  say "部署到 $target"

  if [ "$DRY_RUN" -eq 1 ]; then
    ok "（dry-run，未实际写入）"
    continue
  fi

  # 幂等 + 非破坏：已存在则先备份，绝不直接删除用户数据
  if [ -d "$target" ]; then
    local_bak="${target}.bak-${STAMP}"
    mv "$target" "$local_bak"
    warn "已存在旧版本，备份至 $(basename "$local_bak")"
  fi

  copy_payload "$target"
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
say "使用：对 Agent 说「体检一下」，或直接运行 node src/cli.mjs scan"
say ""
