#!/bin/bash
# Cold-restart the PICO Swan emulator from the CLI (recovers from focus-wedge / frozen-mirror / a killed qemu).
# DISCOVERED 2026-07-08: the emulator binary needs BOTH env vars + explicit -sysdir/-kernel because the AVD's
# image.sysdir.1 is oddly relative and SDK-root inference fails when launched outside the PICO app wrapper.
set -e
DEFAULT_EMU_ROOT=~/Library/PICO/sdk/0.13/emulator
EMU_ROOT="${PICO_EMU_SDK_ROOT:-$DEFAULT_EMU_ROOT}"
EMU="$EMU_ROOT/emulator"
ADB="$EMU_ROOT/system-images/platform-tools/adb"
SYS="$EMU_ROOT/system-images/system-images"
EMU_LOG_PATH="${PICO_EMU_LOG_PATH:-/tmp/pico-emu.log}"
DISCOVERY_DIR="${PICO_EMU_DISCOVERY_DIR:-$HOME/Library/Caches/TemporaryItems/avd/pico_running}"
EMULATOR_KILL_BIN="${PICO_EMU_KILL_BIN:-/bin/kill}"
WAIT_TIMEOUT_SEC="${PICO_EMU_WAIT_TIMEOUT_SEC:-60}"
ADB_TIMEOUT_SEC="${PICO_EMU_ADB_TIMEOUT_SEC:-10}"
export ANDROID_AVD_HOME=~/.pico/avd
export ANDROID_SDK_ROOT="$EMU_ROOT/system-images"
export ANDROID_HOME="$ANDROID_SDK_ROOT"

CAMERA_BACK="${PICO_EMU_CAMERA_BACK:-}"
if [[ ! "$WAIT_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ || ! "$ADB_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
  echo "PICO_EMU_WAIT_TIMEOUT_SEC and PICO_EMU_ADB_TIMEOUT_SEC must be positive integer seconds" >&2
  exit 2
fi
if [[ -n "$CAMERA_BACK" && ! "$CAMERA_BACK" =~ ^(emulated|webcam[0-9]+|virtualscene|videoplayback|none)$ ]]; then
  echo "invalid PICO_EMU_CAMERA_BACK '$CAMERA_BACK' (expected emulated, webcam<N>, virtualscene, videoplayback, or none)" >&2
  exit 2
fi

EMU_ARGV=(
  "$EMU"
  -avd PICO_0.13
  -sysdir "$SYS"
  -kernel "$SYS/kernel-ranchu"
  -gpu angle_indirect
  -no-snapshot-load
)
if [[ -n "$CAMERA_BACK" ]]; then
  EMU_ARGV+=( -camera-back "$CAMERA_BACK" )
fi

# Non-mutating contract for regression tests and operator inspection. NUL delimiters preserve
# exact argv boundaries, including paths with spaces, without eval or shell re-parsing.
if [[ "${PICO_EMU_DRY_RUN:-}" == "1" ]]; then
  printf '%s\0' "${EMU_ARGV[@]}"
  exit 0
fi

# Trust boundary: this helper runs the installed SDK adb, not arbitrary untrusted executables.
# macOS has no built-in `timeout`. Give each adb invocation a private process group and redirect
# its output to a file so a forked descendant cannot hold command-substitution stdout open. A
# marker makes expiry authoritative even if TERM becomes exit 0; one second later, KILL wins.
run_bounded() {
  local timeout_seconds="$1"
  shift
  local run_dir=""
  if ! run_dir="$(mktemp -d "${TMPDIR:-/tmp}/pico-emu-watchdog.XXXXXX")"; then
    echo "could not create emulator watchdog directory" >&2
    return 125
  fi
  local timeout_marker="$run_dir/timed-out"
  local output_path="$run_dir/stdout"
  local monitor_was_enabled=0
  if [[ "$-" == *m* ]]; then
    monitor_was_enabled=1
  else
    set -m
  fi
  "$@" > "$output_path" &
  local command_pid=$!
  if [[ "$monitor_was_enabled" == "0" ]]; then
    set +m
  fi
  (
    local sleep_pid=""
    trap 'if [[ -n "$sleep_pid" ]]; then kill -TERM "$sleep_pid" 2>/dev/null || true; fi; exit 0' TERM INT
    /bin/sleep "$timeout_seconds" &
    sleep_pid=$!
    wait "$sleep_pid" || exit 0
    printf 'timeout\n' > "$timeout_marker"
    kill -TERM -- "-$command_pid" 2>/dev/null || true
    /bin/sleep 1 &
    sleep_pid=$!
    wait "$sleep_pid" || exit 0
    kill -KILL -- "-$command_pid" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  local watchdog_pid=$!
  local status=0
  wait "$command_pid" || status=$?
  local surviving_descendants=0
  if kill -0 -- "-$command_pid" 2>/dev/null; then
    surviving_descendants=1
  fi
  # Seal stdout first: any descendant that survived its direct parent is killed before the
  # watchdog is reaped or output is replayed. Treat that process-tree escape as a failed probe.
  kill -KILL -- "-$command_pid" 2>/dev/null || true
  kill -TERM "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  local timed_out=0
  if [[ -s "$timeout_marker" || "$surviving_descendants" == "1" ]]; then
    timed_out=1
  fi
  if [[ "$timed_out" == "0" ]]; then
    /bin/cat "$output_path"
  fi
  rm -f "$timeout_marker" "$output_path"
  rmdir "$run_dir" 2>/dev/null || true
  if [[ "$timed_out" == "1" ]]; then
    return 124
  fi
  return "$status"
}

# PICO's discovery filename embeds the qemu PID and its record binds that process to console
# serial 5554. This is the exact fallback when `adb emu kill` cannot stop a wedged emulator;
# never use a pattern-wide pkill because another PICO_0.13 instance may be on serial 5556.
terminate_discovered_emulator_5554() {
  local discovery_ini=""
  local emulator_pid=""
  local emulator_command=""
  local key=""
  local value=""
  local matches_serial=0
  for discovery_ini in "$DISCOVERY_DIR"/pid_*.ini; do
    [[ -f "$discovery_ini" ]] || continue
    matches_serial=0
    while IFS='=' read -r key value; do
      value="${value//$'\r'/}"
      if [[ "$key" == "port.serial" && "$value" == "5554" ]]; then
        matches_serial=1
        break
      fi
    done < "$discovery_ini"
    [[ "$matches_serial" == "1" ]] || continue
    emulator_pid="${discovery_ini##*/pid_}"
    emulator_pid="${emulator_pid%.ini}"
    [[ "$emulator_pid" =~ ^[1-9][0-9]*$ ]] || continue
    emulator_command="$(ps -p "$emulator_pid" -o command= 2>/dev/null || true)"
    if [[ "$emulator_command" == *qemu-system-aarch64* && "$emulator_command" == *PICO_0.13* ]]; then
      "$EMULATOR_KILL_BIN" -TERM "$emulator_pid" 2>/dev/null || true
    fi
  done
}

"$ADB" -s emulator-5554 emu kill 2>/dev/null || true
terminate_discovered_emulator_5554
sleep 3
nohup "${EMU_ARGV[@]}" > "$EMU_LOG_PATH" 2>&1 &
echo "relaunched (pid $!) — waiting for boot..."
if ! run_bounded "$WAIT_TIMEOUT_SEC" "$ADB" -s emulator-5554 wait-for-device; then
  echo "emulator-5554 did not appear before the wait-for-device timeout" >&2
  exit 1
fi
boot_completed=0
for i in $(seq 1 40); do
  boot_value=""
  if boot_value="$(run_bounded "$ADB_TIMEOUT_SEC" "$ADB" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null)"; then
    boot_value="${boot_value//$'\r'/}"
    if [ "$boot_value" = "1" ]; then
      boot_completed=1
      break
    fi
  fi
  sleep 4
done
if [ "$boot_completed" != "1" ]; then
  echo "emulator-5554 did not report sys.boot_completed=1 before timeout" >&2
  exit 1
fi
echo "boot_completed=1 — emulator ready"
