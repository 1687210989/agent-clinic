#!/usr/bin/env bash
#
# 定位可用的 node（>= 22.15，用于原生 zstd 解码）
#
# 成功：把 node 可执行文件路径打印到 stdout，退出码 0
# 失败：退出码 1（stdout 无输出）
#
# 查找顺序：
#   1. $AGENT_CLINIC_NODE 显式指定
#   2. PATH 上的 node
#   3. 已知的常见安装位置（含 DSH / WorkBuddy 运行时自带 node）
#   4. 通配扫描版本目录
#
# 之所以需要这个：很多用户的终端里 node 并不在 PATH 上
# （例如 WorkBuddy / DSH 自带的 node 只存在于其托管目录）。
#
set -uo pipefail

MIN_MAJOR=22
MIN_MINOR=15

version_ok() {
  local bin="$1" v major minor
  v="$("$bin" -p 'process.versions.node' 2>/dev/null)" || return 1
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  minor="$(printf '%s' "$v" | cut -d. -f2)"
  minor="${minor:-0}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
  if [ "$major" -gt "$MIN_MAJOR" ]; then return 0; fi
  if [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; then return 0; fi
  return 1
}

try() {
  local bin="$1"
  [ -n "$bin" ] || return 1
  [ -e "$bin" ] || return 1
  [ -x "$bin" ] || return 1
  if version_ok "$bin"; then
    printf '%s\n' "$bin"
    exit 0
  fi
  return 1
}

# 1) 显式指定
if [ -n "${AGENT_CLINIC_NODE:-}" ]; then try "$AGENT_CLINIC_NODE"; fi

# 2) PATH
if command -v node >/dev/null 2>&1; then
  try "$(command -v node)"
fi

# 3) 已知位置
HOME_DIR="${HOME:-$USERPROFILE}"
for c in \
  "$HOME_DIR/.workbuddy-ai/binaries/node/versions/current/node.exe" \
  "$HOME_DIR/.workbuddy-ai/binaries/node/versions/current/bin/node" \
  "$HOME_DIR/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
  "/c/Program Files/nodejs/node.exe" \
  "/c/Program Files/nodejs/node" \
  "/usr/local/bin/node" \
  "/opt/homebrew/bin/node" \
  "/usr/bin/node" \
  "$HOME_DIR/AppData/Local/Programs/nodejs/node.exe" \
  "$HOME_DIR/AppData/Roaming/nvm/current/node.exe" ; do
  try "$c"
done

# 4) 通配扫描（nvm / workbuddy 版本目录 / volta / fnm）
for c in \
  "$HOME_DIR"/.workbuddy-ai/binaries/node/versions/*/node.exe \
  "$HOME_DIR"/.workbuddy-ai/binaries/node/versions/*/bin/node \
  "$HOME_DIR"/AppData/Roaming/nvm/v*/node.exe \
  "$HOME_DIR"/.nvm/versions/node/*/bin/node \
  "$HOME_DIR"/.volta/bin/node \
  "$HOME_DIR"/AppData/Local/fnm_multishells/*/node.exe ; do
  try "$c"
done

exit 1
