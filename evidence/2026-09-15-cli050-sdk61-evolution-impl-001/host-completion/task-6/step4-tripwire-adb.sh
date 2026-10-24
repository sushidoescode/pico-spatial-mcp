#!/bin/sh
# Task-6 battery tripwire. If ANY battery child resolves `adb` from PATH, this records the call
# and fails it. It never contacts a device, a server or the host adb. Exit 66 is unmistakable.
printf '%s pid=%s ppid=%s cwd=%s argv=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$PPID" "$PWD" "$*" >> "/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-6/step4-tripwire-adb-marker.txt"
exit 66
