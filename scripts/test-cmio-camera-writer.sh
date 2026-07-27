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

printf '%s\n' '{"schemaVersion":1,"kind":"pico-vcam-live-pose-stream","width":1280,"height":720,"pixelFormat":"BGRA","frameBytes":3686400,"frames":[]}' > "$manifest"
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
    echo "cmio-camera-writer native gate: unproved live-pose-stream kind was not rejected" >&2
    echo "$diagnostic" >&2
    exit 1
    ;;
esac

for bad_ticks in 0 61 abc -1; do
  set +e
  diagnostic=$(
    "$writer" \
      --device-uid 00000000-0000-0000-0000-000000000001 \
      --width 1280 \
      --height 720 \
      --pixel-format BGRA \
      --manifest "$manifest" \
      --expected-manifest-sha256 "$manifest_sha" \
      --ticks-per-source-frame "$bad_ticks" \
      2>&1
  )
  status=$?
  set -e
  if [ "$status" -ne 64 ]; then
    echo "cmio-camera-writer native gate: --ticks-per-source-frame $bad_ticks should exit 64, got $status" >&2
    echo "$diagnostic" >&2
    exit 1
  fi
  case "$diagnostic" in
    *"--ticks-per-source-frame must be"*) ;;
    *)
      echo "cmio-camera-writer native gate: missing tick-range diagnostic for $bad_ticks" >&2
      echo "$diagnostic" >&2
      exit 1
      ;;
  esac
done

set +e
diagnostic=$(
  "$writer" \
    --probe-only \
    --device-uid 00000000-0000-0000-0000-000000000001 \
    --width 1280 \
    --height 720 \
    --pixel-format BGRA \
    --ticks-per-source-frame 1 \
    2>&1
)
status=$?
set -e
if [ "$status" -ne 64 ]; then
  echo "cmio-camera-writer native gate: --probe-only + producer flag should exit 64, got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi
case "$diagnostic" in
  *"--probe-only cannot be combined with producer arguments"*) ;;
  *)
    echo "cmio-camera-writer native gate: --probe-only did not reject the producer-only cadence flag" >&2
    echo "$diagnostic" >&2
    exit 1
    ;;
esac

set +e
diagnostic=$(
  "$writer" \
    --device-uid 00000000-0000-0000-0000-000000000001 \
    --width 1280 \
    --height 720 \
    --pixel-format BGRA \
    --manifest "$manifest" \
    --expected-manifest-sha256 "$manifest_sha" \
    --ticks-per-source-frame 60 \
    2>&1
)
status=$?
set -e
if [ "$status" -ne 65 ]; then
  echo "cmio-camera-writer native gate: accepted --ticks-per-source-frame should still reach manifest validation (exit 65), got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi

usage=$("$writer" --help)
case "$usage" in
  *"--ticks-per-source-frame"*) ;;
  *)
    echo "cmio-camera-writer native gate: --help does not document --ticks-per-source-frame" >&2
    echo "$usage" >&2
    exit 1
    ;;
esac

# A VALID fixed-pose manifest must get past kind + provenance + frame validation and fail only at
# sink discovery. The synthetic UID below must never match a real device, or this gate would fall
# through to RunProducer and start writing into a live sink.
fixed_dir="$temporary_dir/fixed-pose"
mkdir -p "$fixed_dir"
dd if=/dev/zero of="$fixed_dir/frame-000.bgra" bs=1024 count=3600 2>/dev/null
frame_sha=$(shasum -a 256 "$fixed_dir/frame-000.bgra" | awk '{print $1}')
zero_hex=$(printf '0%.0s' $(seq 1 64))

# One emitter and one set of known-good provenance parts serve every fixed-pose fixture below, so
# each negative fixture differs from the valid one in exactly one place and a failure can only be
# about the single check it names. Field names and nesting mirror createFixedPoseSequence's
# FixedPoseProvenance in src/vcamtransport.ts exactly.
good_world_model="{\"splatPath\":\"/gate/world.ply\",\"splatSha256\":\"$zero_hex\",\"offsetApplied\":[0,0.775604248046875,0]}"
good_pose='{"position":[0.034,1.896,0.147],"target":[0.034,2.238,-0.7927],"frame":"app"}'
good_intrinsics='{"f":914.01,"cx":640,"cy":360,"fovDeg":70}'
good_renderer="{\"script\":\"/gate/splat_perspective.py\",\"scriptSha256\":\"$zero_hex\",\"pointsRendered\":500000}"

compose_provenance() {
  printf '{"worldModel":%s,"pose":%s,"intrinsics":%s,"renderer":%s,"baseFrameSha256":"%s"}' "$1" "$2" "$3" "$4" "$5"
}
good_provenance=$(compose_provenance "$good_world_model" "$good_pose" "$good_intrinsics" "$good_renderer" "$zero_hex")

emit_fixed_pose_manifest() {
  emit_destination=$1
  emit_provenance=$2
  printf '%s\n' "{\"schemaVersion\":1,\"kind\":\"pico-vcam-fixed-pose-sequence\",\"nonce\":\"VCAM-GATE\",\"width\":1280,\"height\":720,\"pixelFormat\":\"BGRA\",\"frameBytes\":3686400,\"counterRegion\":{\"x\":960,\"y\":480,\"width\":256,\"height\":160},\"provenance\":$emit_provenance,\"frames\":[{\"counter\":0,\"bytes\":3686400,\"sha256\":\"$frame_sha\"}]}" > "$emit_destination"
}

emit_fixed_pose_manifest "$fixed_dir/manifest.json" "$good_provenance"
fixed_sha=$(shasum -a 256 "$fixed_dir/manifest.json" | awk '{print $1}')

set +e
diagnostic=$(
  "$writer" \
    --device-uid 00000000-0000-0000-0000-000000000001 \
    --width 1280 \
    --height 720 \
    --pixel-format BGRA \
    --manifest "$fixed_dir/manifest.json" \
    --expected-manifest-sha256 "$fixed_sha" \
    2>&1
)
status=$?
set -e
if [ "$status" -ne 69 ]; then
  echo "cmio-camera-writer native gate: valid fixed-pose manifest should reach sink discovery (69), got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi

# The allowlist gained an entry; it must not have gained a requirement. A test-card manifest with no
# provenance at all still reaches sink discovery, so provenance is required for the new kind only.
printf '%s\n' "{\"schemaVersion\":1,\"kind\":\"pico-vcam-test-card-sequence\",\"nonce\":\"VCAM-GATE\",\"width\":1280,\"height\":720,\"pixelFormat\":\"BGRA\",\"frameBytes\":3686400,\"counterRegion\":{\"x\":960,\"y\":480,\"width\":256,\"height\":160},\"frames\":[{\"counter\":0,\"bytes\":3686400,\"sha256\":\"$frame_sha\"}]}" > "$fixed_dir/test-card.json"
card_sha=$(shasum -a 256 "$fixed_dir/test-card.json" | awk '{print $1}')
set +e
diagnostic=$(
  "$writer" --device-uid 00000000-0000-0000-0000-000000000001 --width 1280 --height 720 \
    --pixel-format BGRA --manifest "$fixed_dir/test-card.json" --expected-manifest-sha256 "$card_sha" 2>&1
)
status=$?
set -e
if [ "$status" -ne 69 ]; then
  echo "cmio-camera-writer native gate: test-card manifest must still reach sink discovery (69) without provenance, got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi

# And provenance is REQUIRED for that kind, not decorative.
printf '%s\n' '{"schemaVersion":1,"kind":"pico-vcam-fixed-pose-sequence","nonce":"VCAM-GATE","width":1280,"height":720,"pixelFormat":"BGRA","frameBytes":3686400,"counterRegion":{"x":960,"y":480,"width":256,"height":160},"frames":[]}' > "$manifest"
manifest_sha=$(shasum -a 256 "$manifest" | awk '{print $1}')
set +e
diagnostic=$(
  "$writer" --device-uid 00000000-0000-0000-0000-000000000001 --width 1280 --height 720 \
    --pixel-format BGRA --manifest "$manifest" --expected-manifest-sha256 "$manifest_sha" 2>&1
)
status=$?
set -e
if [ "$status" -ne 65 ]; then
  echo "cmio-camera-writer native gate: fixed-pose without provenance should exit 65, got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi
case "$diagnostic" in
  *"provenance"*) ;;
  *)
    echo "cmio-camera-writer native gate: missing provenance diagnostic" >&2
    echo "$diagnostic" >&2
    exit 1
    ;;
esac

# Requiring the provenance OBJECT is not the same as validating its FIELDS. Mutation-testing proved
# the two cases above survive a writer that accepts a malformed baseFrameSha256 or that drops the
# yawDeg/pitchDeg rejection entirely: their fixture carries no provenance at all, so no field check
# ever runs. Every case below carries an otherwise-valid provenance block with exactly ONE defect and
# names the specific diagnostic, so removing any single check makes that manifest fully valid — it
# then reaches sink discovery (69) instead of 65 and the case fails.
reject_provenance() {
  reject_label=$1
  reject_needle=$2
  reject_json=$3
  reject_path="$fixed_dir/bad-provenance.json"
  emit_fixed_pose_manifest "$reject_path" "$reject_json"
  reject_sha=$(shasum -a 256 "$reject_path" | awk '{print $1}')
  set +e
  diagnostic=$(
    "$writer" --device-uid 00000000-0000-0000-0000-000000000001 --width 1280 --height 720 \
      --pixel-format BGRA --manifest "$reject_path" --expected-manifest-sha256 "$reject_sha" 2>&1
  )
  status=$?
  set -e
  if [ "$status" -ne 65 ]; then
    echo "cmio-camera-writer native gate: $reject_label should exit 65, got $status" >&2
    echo "$diagnostic" >&2
    exit 1
  fi
  case "$diagnostic" in
    *"$reject_needle"*) ;;
    *)
      echo "cmio-camera-writer native gate: $reject_label did not report '$reject_needle'" >&2
      echo "$diagnostic" >&2
      exit 1
      ;;
  esac
}

# Each defective part is bound to its own variable before composition. Writing the JSON literal
# inline inside the nested command substitution silently lost everything after its first comma
# (brace expansion), which produced unparseable manifests that were rejected for the wrong reason.
empty_splat_path="{\"splatPath\":\"\",\"splatSha256\":\"$zero_hex\",\"offsetApplied\":[0,0.775604248046875,0]}"
bad_splat_sha='{"splatPath":"/gate/world.ply","splatSha256":"NOTHEX","offsetApplied":[0,0.775604248046875,0]}'
short_offset="{\"splatPath\":\"/gate/world.ply\",\"splatSha256\":\"$zero_hex\",\"offsetApplied\":[0,0.775604248046875]}"
bad_position='{"position":"not-an-array","target":[0.034,2.238,-0.7927],"frame":"app"}'
missing_target='{"position":[0.034,1.896,0.147],"frame":"app"}'
bad_frame='{"position":[0.034,1.896,0.147],"target":[0.034,2.238,-0.7927],"frame":"splat"}'
# target is present and valid here, so the ONLY defect is the extra yaw/pitch encoding.
yaw_pitch_pose='{"position":[0.034,1.896,0.147],"target":[0.034,2.238,-0.7927],"frame":"app","yawDeg":0,"pitchDeg":20}'
zero_fov='{"f":914.01,"cx":640,"cy":360,"fovDeg":0}'
empty_script="{\"script\":\"\",\"scriptSha256\":\"$zero_hex\",\"pointsRendered\":500000}"
bad_script_sha='{"script":"/gate/splat_perspective.py","scriptSha256":"NOTHEX","pointsRendered":500000}'
negative_points="{\"script\":\"/gate/splat_perspective.py\",\"scriptSha256\":\"$zero_hex\",\"pointsRendered\":-1}"

# A present-but-not-an-object provenance is the one shape that could reach a keyed subscript on the
# wrong class, so it is asserted as a rejection rather than left to the missing-key path.
reject_provenance "provenance that is a JSON array" "provenance is required" '[]'
reject_provenance "provenance that is a JSON string" "provenance is required" '"nope"'

bad=$(compose_provenance "$empty_splat_path" "$good_pose" "$good_intrinsics" "$good_renderer" "$zero_hex")
reject_provenance "empty worldModel.splatPath" "provenance worldModel.splatPath" "$bad"
bad=$(compose_provenance "$bad_splat_sha" "$good_pose" "$good_intrinsics" "$good_renderer" "$zero_hex")
reject_provenance "malformed worldModel.splatSha256" "provenance worldModel.splatSha256" "$bad"
bad=$(compose_provenance "$short_offset" "$good_pose" "$good_intrinsics" "$good_renderer" "$zero_hex")
reject_provenance "two-element worldModel.offsetApplied" "provenance worldModel.offsetApplied" "$bad"
bad=$(compose_provenance "$good_world_model" "$bad_position" "$good_intrinsics" "$good_renderer" "$zero_hex")
reject_provenance "non-numeric pose.position" "provenance pose.position" "$bad"
bad=$(compose_provenance "$good_world_model" "$missing_target" "$good_intrinsics" "$good_renderer" "$zero_hex")
reject_provenance "missing pose.target" "provenance pose.target" "$bad"
bad=$(compose_provenance "$good_world_model" "$bad_frame" "$good_intrinsics" "$good_renderer" "$zero_hex")
reject_provenance "pose.frame that is not app" "provenance pose.frame" "$bad"
bad=$(compose_provenance "$good_world_model" "$yaw_pitch_pose" "$good_intrinsics" "$good_renderer" "$zero_hex")
reject_provenance "pose carrying yawDeg/pitchDeg" "yawDeg/pitchDeg" "$bad"
bad=$(compose_provenance "$good_world_model" "$good_pose" "$zero_fov" "$good_renderer" "$zero_hex")
reject_provenance "non-positive intrinsics.fovDeg" "provenance intrinsics.fovDeg" "$bad"
bad=$(compose_provenance "$good_world_model" "$good_pose" "$good_intrinsics" "$empty_script" "$zero_hex")
reject_provenance "empty renderer.script" "provenance renderer.script" "$bad"
bad=$(compose_provenance "$good_world_model" "$good_pose" "$good_intrinsics" "$bad_script_sha" "$zero_hex")
reject_provenance "malformed renderer.scriptSha256" "provenance renderer.scriptSha256" "$bad"
bad=$(compose_provenance "$good_world_model" "$good_pose" "$good_intrinsics" "$negative_points" "$zero_hex")
reject_provenance "negative renderer.pointsRendered" "provenance renderer.pointsRendered" "$bad"
bad=$(compose_provenance "$good_world_model" "$good_pose" "$good_intrinsics" "$good_renderer" NOTHEX)
reject_provenance "malformed baseFrameSha256" "provenance baseFrameSha256" "$bad"

# A defective fixture that is merely unparseable proves nothing about provenance, so assert the
# positive control one final time: the same emitter with every part known-good still reaches 69.
emit_fixed_pose_manifest "$fixed_dir/recheck.json" "$good_provenance"
recheck_sha=$(shasum -a 256 "$fixed_dir/recheck.json" | awk '{print $1}')
set +e
diagnostic=$(
  "$writer" --device-uid 00000000-0000-0000-0000-000000000001 --width 1280 --height 720 \
    --pixel-format BGRA --manifest "$fixed_dir/recheck.json" --expected-manifest-sha256 "$recheck_sha" 2>&1
)
status=$?
set -e
if [ "$status" -ne 69 ]; then
  echo "cmio-camera-writer native gate: composed known-good provenance should reach sink discovery (69), got $status" >&2
  echo "$diagnostic" >&2
  exit 1
fi

echo "cmio-camera-writer native gate: strict build, ownership lifetime, parser, cadence-flag validation, pre-CMIO manifest rejection, two-kind allowlist, and fixed-pose provenance validation passed"
