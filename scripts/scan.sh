#!/usr/bin/env bash
# agent-clinic 扫描封装 —— 供 agent 直接调用
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/src/cli.mjs" scan "$@"
