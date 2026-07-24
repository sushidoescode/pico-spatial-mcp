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
temporary_output=$(mktemp "$output_dir/.cmio-camera-reader.XXXXXX")
cleanup() {
  rm -f -- "$temporary_output"
}
trap cleanup EXIT HUP INT TERM

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
  "$source_path" \
  -o "$temporary_output"

chmod 0755 "$temporary_output"
mv -f -- "$temporary_output" "$output_path"
trap - EXIT HUP INT TERM
echo "$output_path"
