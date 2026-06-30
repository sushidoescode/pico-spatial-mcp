#!/usr/bin/env bash
# setup_bridge_venv.sh — create the isolated venv the mouse bridge needs.
#
# The system python on macOS is PEP-668 locked (no global pip installs), so the host-side mouse
# bridge (mouse_menu_bridge.py) runs from its own venv with pyobjc-framework-Quartz (the global
# mouse event tap + window enumeration) and Pillow (framebuffer color detection).
#
# Idempotent: safe to re-run. Prints the venv python path on success.
set -euo pipefail

VENV="${PICO_BRIDGE_VENV:-$HOME/.pico-bridge/venv}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "creating venv at $VENV ..." >&2
  python3 -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --quiet --upgrade pip >&2
"$VENV/bin/python" -m pip install --quiet pyobjc-framework-Quartz Pillow >&2
"$VENV/bin/python" -c "import Quartz, PIL; print('Quartz + Pillow OK')" >&2

echo "$VENV/bin/python"
