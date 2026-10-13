#!/usr/bin/env bash
# agent-clinic 证据展开封装 —— 供 agent 直接调用
# 用法: ./scripts/show.sh "<file>#L<n>"
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/src/cli.mjs" show "$@"
