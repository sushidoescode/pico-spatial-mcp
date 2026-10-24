# The `device_verified` path: protocol for real PICO hardware

## 0. Evidence status

This repository has **not run this protocol on Swan hardware**. It currently has no effective
real-hardware `device_verified` row. The ledger also contains emulator, host-render, and structural
evidence, so it would be false to describe every historical claim as emulator-produced.

The code paths below exist in `src/ledger.ts`, `src/deviceidentity.ts`, `src/deploy.ts`, and
`src/swanparity.ts`. Their CI coverage uses explicitly injected identity and capture fixtures. That
coverage proves the validation and schema flow; it does not prove Swan identity values, capture
timing, adb behavior, or visual output. Treat any divergence on hardware as a finding.

## 1. What `device_verified` means

`device_verified` starts with the same non-negotiable requirement as `vision_verified`: a human or
vision-capable agent LOOKED at the rendered frame and wrote an attestation limited to its pixels.
The strongest tier then adds live hardware lineage and capture binding. A new row is rejected unless
all of these conditions hold:

1. `artifactPath` is a structurally valid PNG or JPEG and `attestation` describes what was seen.
2. `deviceSerial` names an online adb device. The server probes that exact serial's
   `ro.product.model`, `ro.build.fingerprint`, and `ro.boot.qemu` values live.
3. The live values are PICO-shaped and contain no recognized emulator marker. There is no identity
   override. If multiple PICO-shaped devices are online, the caller must name the intended serial.
4. The server takes a fresh `adb -s <serial> exec-out screencap -p`; its bytes must be exactly equal
   to the already-looked artifact. Caller-supplied model/fingerprint values are only optional
   mismatch guards and cannot mint provenance.
5. `deviceFeature` is a structured lowercase feature slug, and `deviceOutcome` explicitly says
   `pass` or `fail`. Free-text claim polarity is never inferred.

The identity classifier establishes only “PICO-shaped, with no known emulator marker.” Real Swan
values have not been measured here, and this is not remote attestation of a device's manufacture.

Accepted image bytes are copied into a ledger-owned content-addressed store. Every ledger read
revalidates the stored image and hash. A missing, malformed, or changed artifact becomes
`provenance-broken`; a legacy `device_verified` row without validated live-probe and same-serial
capture lineage is capped at `vision_verified` when its image provenance remains intact.

The evidence ranking is:

```text
device_verified > vision_verified > auto_judged > usd_host_render > logcat/structural > compiles/built_for_headset
```

A `deviceOutcome: "fail"` row remains an honest hardware observation, but it is not positive
capability proof.

## 2. On-device capture flow

`deploy_to_device` is the wired hardware handoff. It scans online non-emulator adb candidates,
live-probes their identity, refuses unrecognized devices, and requires `deviceSerial` when more than
one PICO-shaped candidate exists. There is no `assumeSwan` bypass. Once selected, it installs the
APK, force-stops the previous process, launches the requested activity, checks that the process stays
alive, and returns an adb screencap for a later LOOK. Install, launch, and a live PID are structural
evidence only.

Equivalent manual steps are:

```bash
adb devices -l
adb -s <serial> install -r <path-to.apk>
adb -s <serial> shell am force-stop <package>
adb -s <serial> shell am start -S -n <package>/<activity>
adb -s <serial> exec-out screencap -p > /tmp/pico-render/swan-capture.png
```

> **A black screencap is inconclusive.** Historical emulator runs produced black adb frames while
> the host window showed immersive Unity content, but a later same-moment OpenXR run produced a
> non-black adb frame. Do not infer either rendering failure or a capture-path artifact from black
> pixels alone. Use an alternate casting/recording path if hardware provides one, LOOK at that
> frame, and retain the exact bytes. Swan screencap behavior was not tested here.

There is an important unmeasured constraint: `record_verification` takes a new screencap and demands
byte equality with the frame already looked at. A changing scene may not hold still long enough.
Use a stable test frame and record immediately; if that still fails on Swan, report the failure
instead of bypassing the gate.

`swan_verify_matrix` supplies the C1/C3/C4 device test plan. With recognized hardware attached it
returns pending tests; without hardware it remains `awaiting_swan`. A parity row closes only from an
active effective `device_verified` entry with:

- the exact structured `deviceFeature`;
- `deviceOutcome: "pass"`;
- matching normalized `cClass`;
- intact revalidated capture bytes; and
- validated live identity plus same-serial screencap lineage.

A retraction, failed outcome, missing/mismatched artifact, missing lineage, or authoritative cache
refresh reopens the row. A prior closed value is never trusted merely because it remains in a parity
JSON file.

## 3. Evidence to retain

For each individual feature test, retain:

1. The exact image that was LOOKED at.
2. The matching `adb devices -l` line and the server-observed model, build fingerprint, and qemu
   marker.
3. The app package, activity, APK digest, and exact install/launch commands.
4. The structured `deviceFeature`, `deviceOutcome`, and `cClass` for that test.
5. One sentence stating only what the observer actually saw.

Do not use one frame or one broad claim to close an entire device matrix.

## 4. Recording the observation

Record through `record_verification`; do not hand-edit a report:

```text
record_verification {
  app: "<canonical package or ledger key>",
  claim: "<narrow pixel-grounded claim or observed failure>",
  evidenceType: "device_verified",
  artifactPath: "<exact stable frame that was LOOKED at>",
  attestation: "<what was visible>",
  deviceSerial: "<online adb serial>",
  deviceFeature: "controller_ray",
  deviceOutcome: "pass" | "fail",
  cClass: "C1" | "C3" | "C4_headset_only"
}
```

The server, not the caller, fills the authoritative observed identity, capture source, timestamps,
and hashes. Optional `deviceModel`, `deviceFingerprint`, and `deviceBootQemu` inputs can require a
match with expected values, but cannot replace the live probes.

After acceptance, `ledger_report` and `capability_matrix` use only effective revalidated evidence.
The generated claims page can publish the row's metadata and hash after explicit regeneration; it
does not contain the image bytes or monitor the local store continuously.

## 5. Honest boundary

Until this exact flow succeeds on real PICO hardware and the frame is actually LOOKED at:

- do not call any feature `device_verified`;
- do not infer Swan behavior from emulator behavior or CI fixtures;
- do not infer immersive success or failure from a black adb frame; and
- keep controller-ray, head-tracked depth, Guardian behavior, and other hardware-only rows deferred.

This document defines an unexercised protocol, not a Swan result.

## 6. Serial support

This table describes code routing, not hardware validation:

| Tool | Current routing boundary |
|---|---|
| `deploy_to_device` | Selects one live-probed PICO-shaped candidate; accepts explicit `deviceSerial`; no override. |
| `swan_verify_matrix` | Same identity selection; returns pending tests until effective passing device evidence exists. |
| `capture_frame` | Requires an explicit `serial` since 38.0.0 — no default target; a black adb frame is inconclusive. |
| `assert_scene` | Accepts `serial`; requires the Agent Bridge in the APK. |
| `logcat`, `assert_logcat`, `app_broadcast`, and basic adb tools | Accept an explicit serial or use their documented sole-device resolution. |
| `screenrecord`, `wait_for_log`, `check_crash`, `ui_dump` | Accept serial through the agent-loop adb path; no Swan run has validated them. |
| `verify_baseline`, `verify_visual`, `capture_canonical` | Accept a serial but default to the emulator. |
| `visual_judge` | Reads a saved image and performs no adb operation. |
| `verify_pico_apk` | Requires an explicit `serial` since 38.0.0 — no hardcoded emulator; it can be pointed at hardware, but no hardware run has been performed. It force-stops only the package it installs, stops no foreign app, and clears no logcat buffer. |
| `gui_capture`, `gui_camera`, `gui_find_window` | macOS host-window tools for the emulator/editor; not hardware capture tools. |
| emulator lifecycle, snapshots, free-camera, and mapped-controller tools | Emulator-only. |
| `record_verification` | Uses live adb identity and capture probes only for `device_verified`; lower tiers do not use adb. |
| `ledger_report` | Performs no adb probe; it revalidates persisted evidence and downgrades failures. |

Larger build and fleet pipelines remain emulator-first unless their schema explicitly accepts a
hardware serial. Inspect the current tool contract before assuming a pipeline can target Swan.
