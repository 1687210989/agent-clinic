#!/usr/bin/env bash
# agent-clinic 冒烟测试封装（自动定位 node）
# 用法: ./scripts/smoke.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(bash "$DIR/scripts/find-node.sh" 2>/dev/null)" || NODE=""
if [ -z "$NODE" ]; then
  printf '✗ 未找到可用的 Node.js（需要 >= 22.15.0）\n' >&2
  printf '  可用 AGENT_CLINIC_NODE=/path/to/node 显式指定\n' >&2
  exit 1
fi
exec "$NODE" "$DIR/scripts/smoke.mjs" "$@"
