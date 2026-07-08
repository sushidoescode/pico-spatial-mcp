#!/bin/bash
# Cold-restart the PICO Swan emulator from the CLI (recovers from focus-wedge / frozen-mirror / a killed qemu).
# DISCOVERED 2026-07-08: the emulator binary needs BOTH env vars + explicit -sysdir/-kernel because the AVD's
# image.sysdir.1 is oddly relative and SDK-root inference fails when launched outside the PICO app wrapper.
set -e
EMU=~/Library/PICO/sdk/0.13/emulator/emulator
ADB=~/Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb
SYS=~/Library/PICO/sdk/0.13/emulator/system-images/system-images
export ANDROID_AVD_HOME=~/.pico/avd
export ANDROID_SDK_ROOT=~/Library/PICO/sdk/0.13/emulator/system-images
export ANDROID_HOME="$ANDROID_SDK_ROOT"
"$ADB" -s emulator-5554 emu kill 2>/dev/null || true
pkill -f "qemu-system-aarch64.*PICO_0.13" 2>/dev/null || true
sleep 3
nohup "$EMU" -avd PICO_0.13 -sysdir "$SYS" -kernel "$SYS/kernel-ranchu" -gpu angle_indirect -no-snapshot-load > /tmp/pico-emu.log 2>&1 &
echo "relaunched (pid $!) — waiting for boot..."
"$ADB" wait-for-device
for i in $(seq 1 40); do [ "$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 4; done
echo "boot_completed=1 — emulator ready"
