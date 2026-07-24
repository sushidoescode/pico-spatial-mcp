#!/bin/sh
set -eu

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [OUTPUT_PATH]" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_path="$script_dir/macos/cmio-camera-reader.m"
output_path=${1:-"$HOME/.pico-mcp/bin/cmio-camera-reader"}
output_dir=$(dirname -- "$output_path")

mkdir -p -- "$output_dir"
# Compile into a file literally named cmio-camera-reader: on Apple silicon the linker ad-hoc-signs
# with the OUTPUT basename as the sealed code-signing identifier, so this keeps that identity stable
# and meaningful (a random mktemp basename would be baked in before the final rename).
temporary_dir=$(mktemp -d "$output_dir/.cmio-camera-reader-build.XXXXXX")
temporary_output="$temporary_dir/cmio-camera-reader"
info_plist=$(mktemp "${TMPDIR:-/tmp}/cmio-camera-reader-info.XXXXXX")
cleanup() {
  rm -rf -- "$temporary_dir" "$info_plist"
}
trap cleanup EXIT HUP INT TERM

# An embedded camera-usage description is required for a host binary that can touch a capture
# device. It is a prompt PREREQUISITE that grants nothing and never moves the authorization state.
cat > "$info_plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.pico.vcam.cmio-camera-reader</string>
  <key>CFBundleName</key>
  <string>cmio-camera-reader</string>
  <key>NSCameraUsageDescription</key>
  <string>PICO virtual-camera diagnostic verifies the injected test-card feed. It reads camera frames only when this client is already authorized and never requests access.</string>
</dict>
</plist>
PLIST

xcrun --sdk macosx clang \
  -fobjc-arc \
  -std=gnu11 \
  -Wall \
  -Wextra \
  -Werror \
  -Wpedantic \
  -framework Foundation \
  -framework AVFoundation \
  -framework CoreMediaIO \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework CoreGraphics \
  -framework ImageIO \
  -framework Security \
  -sectcreate __TEXT __info_plist "$info_plist" \
  "$source_path" \
  -o "$temporary_output"

chmod 0755 "$temporary_output"
mv -f -- "$temporary_output" "$output_path"
trap - EXIT HUP INT TERM
echo "$output_path"
