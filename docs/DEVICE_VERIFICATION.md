# The `device_verified` path: capture steps + evidence ask-list for real Swan hardware

## 0. Audience note

You have a real PICO Swan headset (or other real PICO hardware). We don't — every claim on
file in this repo's trust ledger was produced against the emulator (`emulator-5554`), and the
strongest evidence class this ledger supports, `device_verified`, has **zero entries anywhere**
today. `README.md` says so directly ("real PICO hardware — **none yet**, said honestly"), and
`CAPABILITIES.md` has never tagged a single capability with it, because it can't — there is
nothing to tag.

This document is the protocol we designed for the day that changes. It has never been run
against real hardware. Every step below is grounded in code that exists and runs today
(`src/ledger.ts`, `src/deploy.ts`, `src/swanparity.ts`, `src/capture.ts`) — nothing here is
invented tool behavior — but the exact on-device flow (timing, adb quirks, screencap behavior
on Swan's OS build) is **unproven**. If something below doesn't match what you see on real
hardware, that's not you doing it wrong — that's a finding. Send it back (Section 4) rather than
silently working around it, so we can fix the doc and the tooling for the next person.

## 1. What `device_verified` means

`device_verified` is held to **exactly the same honesty bar as `vision_verified`** — a human or
agent actually looked at a real rendered frame and can say what's in it — plus one additional
fact: the frame came from real Swan hardware, not the emulator.

The enforcement lives in the ledger gate itself, not in discipline. In `src/ledger.ts`,
`validateEntry` groups `device_verified` with `vision_verified`, `auto_judged`, and
`usd_host_render` under the same check (`src/ledger.ts:81`):

```ts
if (e.evidenceType === "device_verified" || e.evidenceType === "vision_verified" || e.evidenceType === "auto_judged" || e.evidenceType === "usd_host_render") {
  if (!e.artifactPath) return { ok: false, error: `${label} REQUIRES artifactPath (the real frame) — rejected as an over-claim.` };
  capture = validateCapture(e.artifactPath);
  if (!capture.ok) return { ok: false, error: `${capture.reason} — a ${label} claim must link a real rendered frame (v6.1 evidence gate).` };
  if (!e.attestation || e.attestation.trim().length < 8) return { ok: false, error: `${label} REQUIRES an attestation (...)`; }
}
```

Concretely, a `device_verified` claim is **rejected** unless:
- `artifactPath` points to a real, existing image (`validateCapture` in `src/evidence.ts` checks
  PNG/JPEG signature + real dimensions — a text file, a 0-byte file, a directory, or a missing
  path are all rejected the same way a spoofed `vision_verified` claim would be), and
- `attestation` is at least 8 characters describing what was actually seen.

`device_verified` outranks every other evidence class. In `src/capabilityreport.ts` (line 18)
and `src/claimspage.ts` (line 22), the rank order is:

```
device_verified (6) > vision_verified (5) > auto_judged (4) > usd_host_render (3) > logcat/structural (2) > compiles/built_for_headset (1)
```

So a claim that flips from `built_for_headset` (compiled, deferred honestly, never run) to
`device_verified` is the single biggest upgrade this ledger can record.

## 2. On-device capture steps

There is no dedicated "capture on Swan" tool distinct from the emulator one — the same `adb`
primitives apply, targeted at the headset's serial instead of `emulator-5554`. Two entry points
already exist in this repo for exactly this:

**`deploy_to_device`** (`src/deploy.ts`) is the wired hardware handoff. Today, with only the
emulator attached, it returns a `dormant` status and does nothing else — that's intentional, it
cannot crash the pipeline. When it sees a non-emulator adb device in `adb devices` it first runs
a hardware-identity probe (`getprop ro.product.model` + `ro.build.fingerprint` + `ro.boot.qemu`,
all included in the result): a device that doesn't look like PICO hardware — a phone, another
vendor's headset (a Meta Quest 3 over USB was the live case that motivated this), or the
emulator reattached over adb-over-TCP — is refused with `identity_blocked` unless you pass
`assumeSwan: true`. Once the gate passes it takes over: installs the APK
(`adb -s <serial> install -r`), force-stops any prior instance, launches
(`adb -s <serial> shell am start -S -n <package>/<activity>`, default activity
`.platform.LaunchActivity`), waits 8 seconds to settle, then captures one frame via
`adb -s <serial> exec-out screencap -p` and returns it as an image for you to look at.

> **Day-one warning — a black screencap of an immersive app is NOT a failure.** The v30.1
> retraction (commit `1827676`, ledger `pico-emulator-capture-paths` seq 0) proved on the
> emulator that `adb screencap` captures the **shell composite** (home environment, 2D panels,
> native Spatial SDK apps) and is **structurally blind to XR-runtime output**: two immersive
> Unity apps that demonstrably rendered (LOOKED at in the emulator's own window) came back
> uniformly black over screencap. Every capture path in this section — `deploy_to_device`'s
> first frame, `capture_frame`, the manual `exec-out screencap -p` below — has the same
> blind spot. On real hardware, before concluding an immersive app failed, verify through a
> different channel (logcat markers via `assert_logcat`, `assert_scene`'s entity dump, or
> whatever on-device casting/recording facility the Swan build offers — we could not test
> that from here). If screencap on Swan turns out to capture immersive content correctly,
> that's a finding too — send it back per Section 3.

If you'd rather drive the steps by hand (recommended the first time, so you can see exactly
where reality diverges from what this doc claims):

```bash
adb devices -l                          # confirm the Swan's serial and that it's `device`, not `unauthorized`
adb -s <serial> install -r <path-to.apk>
adb -s <serial> shell am force-stop <package>
adb -s <serial> shell am start -S -n <package>/<activity>
# settle a few seconds for the scene to render
adb -s <serial> exec-out screencap -p > /tmp/pico-render/swan-capture.png
```

This mirrors `capture_frame` (`src/capture.ts`) and `verify_pico_apk` (`src/verifyapk.ts`),
both of which already use `exec-out screencap -p` against the emulator and are proven
byte-stable there — screencap itself is a stock Android primitive, so it should behave the same
against Swan's OS build, but that assumption has never been checked on real hardware.

**`swan_verify_matrix`** (`src/swanparity.ts`) is the companion tool for the C1/C3/C4
headset-only capability catalogue (scene understanding, world anchors, controller-ray, hand
pinch, in-front panels, measured room) that this repo has only ever been able to defer as
`built_for_headset`. It runs the same hardware-identity gate as `deploy_to_device` (an
unrecognized non-emulator serial returns `unrecognized_hardware` until you pass
`assumeSwan: true`). With a Swan attached it marks each relevant row `device_pending` and gives
you the exact on-device re-test to run (e.g. "point the controller ray at an interactable, pull
the trigger" for `controller_ray`). Run `deploy_to_device` (or the manual steps above) to get the
build on-device, run the listed test, capture, look, then record the result per Section 4 below.
After you record a `device_verified` entry, re-running `swan_verify_matrix` reads it back and
flips the matching row to `device_verified` (carrying the capture's sha256 and the
`deviceSerial`), merging into the existing parity file — a closed row is never reopened by a
later run. The match contract: the entry's `cClass` must equal the row's class
(`C4_headset_only` and `C4` are treated as the same), and the entry's claim must contain the
feature keyword with underscores/hyphens/spaces folded together — so a claim like
"controller-ray select fires on hardware" closes the `controller_ray` row.

Either path, LOOK at the returned/pulled PNG before you do anything else with it. A capture that
exists but that nobody looked at is worth nothing here — that's the whole point of the ledger.

## 3. The evidence ask-list — exactly what to send back

For the first (and every subsequent) `device_verified` entry, send back all of the following.
This is deliberately the same rigor as a `vision_verified` claim, plus hardware identity:

1. **The capture PNG itself** — the actual file `screencap` produced, not a description of it.
2. **`adb devices -l` output** — the full line for the Swan, including the model/serial fields
   (this is the proof it was a real headset and not another emulator instance).
3. **`adb -s <serial> shell getprop ro.build.fingerprint`** — the exact build fingerprint of the
   OS on the device at capture time. This pins down which PICO OS/Swan build produced the frame,
   which matters the moment there's more than one build in circulation (see the OS 6.1 bring-up
   playbook (internal notes) for why version identity matters here).
4. **The app package + the exact launch command used** — package name, activity (or the monkey
   LAUNCHER invocation if none was given), and the `adb install`/`am start` commands actually
   run, so the run is reproducible from the ask-list alone.
5. **One sentence from a human (or agent) who looked at the frame**, stating plainly what is
   visible — the same attestation discipline this ledger already requires for `vision_verified`
   (e.g. "the six shelf cards render at eye level, PBR reflections visible on the metal trim").

Package these as a directory (PNG + a short text file with the other four items is enough — no
need to write prose beyond the one-sentence attestation). This is the same "send the artifact,
not a summary" discipline used in the OS 6.1 bring-up playbook (internal notes).

## 4. How we mint the entry

Once you have the capture and the ask-list items above, the entry is minted the same way every
other ledger entry is — through `record_verification` (`src/ledger.ts`), never hand-written into
a report:

```
record_verification {
  app: "<app name/package — the ledger key>",
  claim: "<what you're claiming, e.g. 'the shelf UI renders correctly on Swan hardware'>",
  evidenceType: "device_verified",
  artifactPath: "<path to the capture PNG you looked at>",
  attestation: "<the one-sentence description of what you saw>",
  deviceSerial: "<the Swan serial from `adb devices -l`, e.g. 'PA9K1ABCDEF'>",
  cClass: "C1" | "C3" | "C4_headset_only"   // if this closes a built_for_headset row
}
```

`record_verification`'s schema (`src/ledger.ts`) now exposes a dedicated optional `deviceSerial`
field, which lands on the entry the same way `src/claimspage.ts` already knew how to render it
(`e.deviceSerial`). No tool populates `deviceSerial` on its own — set it explicitly on the
`record_verification` call whenever the capture came from real hardware. It's still good practice
to also fold the device identity (model/serial + build fingerprint from Section 3, items 2–3) into
the `attestation` text itself, so the full provenance reads naturally even for anyone looking at
just the attestation string — the structured field and the attestation text are complementary, not
either/or.

`validateEntry` will reject the call if `artifactPath` doesn't resolve to a real image or if
`attestation` is missing/too short (Section 1) — that's the honesty gate working as designed, not
a bug to work around.

Once accepted, the entry is picked up automatically by:
- `ledger_report` / `capability_matrix` (`src/capabilityreport.ts`) — the capability now shows
  `device_verified` as its strongest evidence, ranked above any existing `vision_verified` entry
  for the same claim.
- `generate_claims_page` (`src/claimspage.ts`) — the public claims page gets its first
  `device_verified` row, badge color `#7ce38b`, with the capture's sha256 + dimensions so anyone
  holding the artifact can `shasum -a 256` it and match the page.

If this is the app's first headset run and it closes out rows that `swan_verify_matrix` was
tracking as `built_for_headset` / `device_pending`, record one `device_verified` entry per row
you actually re-tested and looked at — never one entry standing in for the whole matrix.

## 5. Honest boundary

Until an entry like the one in Section 4 actually exists in `~/.pico-mcp/ledgers/*.json`:

- `README.md`'s evidence-class line keeps saying `device_verified` has **none yet**.
- `CAPABILITIES.md` keeps showing every capability's strongest evidence as whatever it actually
  is today — `vision_verified`, `auto_judged`, `structural`, or `built_for_headset` — never
  `device_verified`, because the ledger it's generated from has none.
- The public claims page (`docs/claims/index.html`, `docs/claims/claims.json`) keeps showing zero
  `device_verified` claims in its totals.

None of that flips by editing prose. It flips the moment `record_verification` accepts a real
`device_verified` entry backed by a real capture someone looked at — which is exactly what this
document exists to make possible, and exactly why every claim in it is written as a protocol we
designed, not a result we're reporting.

## 6. Serial support: which tools work against a hardware serial today

Classified by reading each tool's actual serial handling in `src/` (file:line cited), not by
assumption. Three buckets: **takes-serial** (pass `serial` and it targets the headset),
**emulator-only** (the mechanism itself has no meaning on hardware), and **needs-param-added**
(hardcodes `emulator-5554` with no way to point it at a headset — a known gap, not a promise).

One operational note that applies to every `src/adb.ts` / `src/agentloop.ts` row: their default
serial is "the sole connected device" (`resolveSerial`, `src/adb.ts:23-37`). With the headset
AND the emulator both attached there is no sole device, so omitting `serial` **errors** — always
pass the Swan's serial explicitly during bring-up.

| Tool | Bucket | Evidence |
| --- | --- | --- |
| `deploy_to_device` | takes-serial (auto-targets the first non-emulator device; identity-gated) | `src/deploy.ts:36` |
| `swan_verify_matrix` | takes-serial (scans `adb devices`; identity-gated) | `src/swanparity.ts` |
| `capture_frame` | takes-serial (`serial` param, default `emulator-5554`) — screencap blind spot applies (Section 2) | `src/capture.ts:39,46` |
| `assert_scene` | takes-serial (`serial` param, default `emulator-5554`); needs the Agent Bridge injected in the APK | `src/assertscene.ts:61,80` |
| `logcat` / `assert_logcat` | takes-serial (explicit `serial`, else sole-device resolution) | `src/adb.ts:120,194` |
| `app_broadcast` | takes-serial (same resolution) | `src/adb.ts:244` |
| `adb_shell` / `app_install` / `app_launch` / `app_stop` / `screencap` / `ui_input` / `file_push` / `file_pull` | takes-serial (same resolution) | `src/adb.ts` |
| `screenrecord` / `wait_for_log` / `check_crash` / `ui_dump` | takes-serial (same resolution) — screenrecord records the same shell composite as screencap | `src/agentloop.ts:135,166,98,235` |
| `verify_baseline` / `verify_visual` | takes-serial (`serial` param, default `emulator-5554`) | `src/verifybaseline.ts:26`, `src/verifyvisual.ts:91` |
| `capture_canonical` | takes-serial (`serial` param, default `emulator-5554`) | `src/eye.ts:155` |
| `visual_judge` | no adb at all — judges a saved frame by path, wherever it was captured | `src/eye.ts:200` |
| `verify_pico_apk` | **needs-param-added** — `const SERIAL = "emulator-5554"` is hardcoded; cannot target a headset today | `src/verifyapk.ts:12` |
| `gui_capture` / `gui_camera` / `gui_find_window` | emulator-only — captures the emulator's macOS host window, which is exactly the capture path immersive apps NEED on the emulator (Section 2); no equivalent exists for hardware from this machine | `src/hostgui.ts` |
| `emulator_look` | emulator-only — drives the emulator free-cam via host mouse drag | `src/emulatorlook.ts` |
| `snapshot_save` / `snapshot_load` / `snapshot_list` | emulator-only — AVD snapshots | `src/agentloop.ts:56,71,85` |
| `controller_map` / `controller_press` | emulator-only — keyboard-mapped emulator controllers via key events | `src/agentloop.ts:197,212` |
| `record_verification` / `ledger_report` | no adb at all — works identically for hardware evidence (set `deviceSerial` yourself, Section 4) | `src/ledger.ts` |

Beyond this day-one list, roughly 20 more `src/` files hardcode `emulator-5554` inside larger
pipelines (`fleetbuild.ts` ×13, `agentbridge.ts` ×4, `hybridbuild.ts` ×4, and others — grep
`emulator-5554` for the current census). Those pipelines are emulator-first by design; treat any
of them as **needs-param-added** if a hardware workflow ever needs them directly.
