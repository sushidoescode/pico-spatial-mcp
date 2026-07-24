#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "cmio-camera-reader native gate: skipped (requires macOS SDK)"
  exit 0
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/pico-vcam-reader-gate.XXXXXX")
cleanup() {
  rm -R -- "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

reader="$temporary_dir/cmio-camera-reader"
lifetime_test="$temporary_dir/cmio-camera-reader-lifetime"
"$script_dir/build-cmio-camera-reader.sh" "$reader" >/dev/null
"$reader" --help >/dev/null

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
  "$script_dir/../test/macos/cmio-camera-reader-lifetime.m" \
  -o "$lifetime_test"
"$lifetime_test"

# Parser fails closed before any CoreMediaIO access: unknown argument -> usage exit 64.
set +e
"$reader" --nope >/dev/null 2>&1
status=$?
set -e
if [ "$status" -ne 64 ]; then
  echo "cmio-camera-reader native gate: expected unknown-argument exit 64, got $status" >&2
  exit 1
fi

# No mode selected -> usage exit 64 (mode mutual-exclusivity guard).
set +e
"$reader" --device-uid 00000000-0000-0000-0000-000000000001 >/dev/null 2>&1
status=$?
set -e
if [ "$status" -ne 64 ]; then
  echo "cmio-camera-reader native gate: expected no-mode exit 64, got $status" >&2
  exit 1
fi

# Fail-closed on an unresolved device: a well-formed but non-matching UUID must exit 69 (this only
# enumerates read-only device metadata; it opens no camera and emits no {"ok":true}).
set +e
diagnostic=$(
  "$reader" --cmio-probe-only --device-uid 00000000-0000-0000-0000-0000000000ff 2>&1
)
status=$?
set -e
if [ "$status" -ne 69 ]; then
  echo "cmio-camera-reader native gate: expected unresolved-device exit 69, got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi
case "$diagnostic" in
  *'"ok":true'*)
    echo "cmio-camera-reader native gate: unresolved device wrongly reported ok:true" >&2
    exit 1
    ;;
esac

echo "cmio-camera-reader native gate: strict build, signal/stop lifetime, JSON escaping, and fail-closed rejection passed"
