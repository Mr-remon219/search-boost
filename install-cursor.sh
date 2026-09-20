#!/usr/bin/env bash
# Legacy wrapper — use: node cli.mjs install
set -euo pipefail
cd "$(dirname "$0")"
[[ -d node_modules ]] || npm install --silent
node cli.mjs install "$@"
