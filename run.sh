#!/usr/bin/env bash
#
# agent-clinic 启动器 —— 自动定位 node，无需 node 在 PATH 上
#
# 用法：
#   ./run.sh scan
#   ./run.sh show "<file>#L<n>"
#   ./run.sh diagnose
#   ./run.sh report
#
# 也可用环境变量指定 node：
#   AGENT_CLINIC_NODE=/path/to/node ./run.sh scan
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE="$(bash "$DIR/scripts/find-node.sh" 2>/dev/null)" || NODE=""

if [ -z "$NODE" ]; then
  printf '\n' >&2
  printf '✗ 未找到可用的 Node.js（需要 >= 22.15.0）\n' >&2
  printf '\n' >&2
  printf '本工具用 Node 的原生 zstd 解码读取 DSH 会话文件，无法绕过。\n' >&2
  printf '已自动搜索以下位置均未命中：\n' >&2
  printf '  · PATH 上的 node\n' >&2
  printf '  · ~/.workbuddy-ai/binaries/node/versions/*\n' >&2
  printf '  · ~/.dsh/dsh-runtimes/*/dependencies/node/bin\n' >&2
  printf '  · /c/Program Files/nodejs、nvm、volta、fnm 等常见位置\n' >&2
  printf '\n' >&2
  printf '解决办法（任选其一）：\n' >&2
  printf '  1) 安装 Node 22.x LTS 或更高：https://nodejs.org\n' >&2
  printf '  2) 若已知 node 路径，显式指定：\n' >&2
  printf '       AGENT_CLINIC_NODE=/path/to/node ./run.sh scan\n' >&2
  printf '\n' >&2
  exit 1
fi

exec "$NODE" "$DIR/src/cli.mjs" "$@"
