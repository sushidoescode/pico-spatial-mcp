#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "cmio-camera-writer native gate: skipped (requires macOS SDK)"
  exit 0
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/pico-vcam-native-gate.XXXXXX")
cleanup() {
  rm -R -- "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

writer="$temporary_dir/cmio-camera-writer"
lifetime_test="$temporary_dir/cmio-camera-writer-lifetime"
manifest="$temporary_dir/manifest.json"
"$script_dir/build-cmio-camera-writer.sh" "$writer" >/dev/null
"$writer" --help >/dev/null

xcrun --sdk macosx clang \
  -fobjc-arc \
  -std=gnu11 \
  -Wall \
  -Wextra \
  -Werror \
  -Wpedantic \
  -framework Foundation \
  -framework CoreMediaIO \
  -framework CoreMedia \
  -framework CoreVideo \
  "$script_dir/../test/macos/cmio-camera-writer-lifetime.m" \
  -o "$lifetime_test"
"$lifetime_test"

printf '{}\n' > "$manifest"

set +e
diagnostic=$(
  "$writer" \
    --device-uid 00000000-0000-0000-0000-000000000001 \
    --width 1280 \
    --height 720 \
    --pixel-format BGRA \
    --manifest "$manifest" \
    --expected-manifest-sha256 0000000000000000000000000000000000000000000000000000000000000000 \
    2>&1
)
status=$?
set -e

if [ "$status" -ne 65 ]; then
  echo "cmio-camera-writer native gate: expected manifest rejection exit 65, got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi
case "$diagnostic" in
  *"manifest SHA-256 mismatch"*) ;;
  *)
    echo "cmio-camera-writer native gate: missing manifest mismatch diagnostic" >&2
    echo "$diagnostic" >&2
    exit 1
    ;;
esac

printf '%s\n' '{"schemaVersion":1,"kind":"pico-vcam-fixed-pose-sequence","width":1280,"height":720,"pixelFormat":"BGRA","frameBytes":3686400,"frames":[]}' > "$manifest"
manifest_sha=$(shasum -a 256 "$manifest" | awk '{print $1}')

set +e
diagnostic=$(
  "$writer" \
    --device-uid 00000000-0000-0000-0000-000000000001 \
    --width 1280 \
    --height 720 \
    --pixel-format BGRA \
    --manifest "$manifest" \
    --expected-manifest-sha256 "$manifest_sha" \
    2>&1
)
status=$?
set -e

if [ "$status" -ne 65 ]; then
  echo "cmio-camera-writer native gate: expected unsupported-kind exit 65, got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi
case "$diagnostic" in
  *"unsupported manifest kind"*) ;;
  *)
    echo "cmio-camera-writer native gate: unproved fixed-pose kind was not rejected" >&2
    echo "$diagnostic" >&2
    exit 1
    ;;
esac

echo "cmio-camera-writer native gate: strict build, ownership lifetime, parser, and pre-CMIO manifest rejection passed"
