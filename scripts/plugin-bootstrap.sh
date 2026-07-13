#!/usr/bin/env bash
# MCP entry point for plugin installs (git clones carry no node_modules/dist).
# First run: npm ci + tsc build — ALL output to stderr, stdout stays clean for MCP stdio.
# Subsequent runs: exec the built server directly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "[pico-spatial-mcp] node not found on PATH — install Node.js 20+ first." >&2
  exit 1
fi

if [ ! -f dist/index.js ] || [ ! -d node_modules ]; then
  echo "[pico-spatial-mcp] first run: installing dependencies + building (one-time, ~1 min)..." >&2
  npm ci --no-audit --no-fund >&2
  npm run build >&2
  echo "[pico-spatial-mcp] build complete." >&2
fi

exec node dist/index.js
