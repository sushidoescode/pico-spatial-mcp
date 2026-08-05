#!/usr/bin/env sh
# Compatibility entry point for older installations. Host manifests launch the
# cross-platform Node bootstrap directly.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/plugin-bootstrap.mjs"
