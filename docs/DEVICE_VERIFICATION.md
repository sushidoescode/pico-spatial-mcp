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
`usd_host_render` under the same check (`src/ledger.ts:67`):

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
cannot crash the pipeline. The moment it sees a non-emulator adb device in `adb devices` (any
serial not prefixed `emulator-`), it takes over: installs the APK (`adb -s <serial> install -r`),
force-stops any prior instance, launches (`adb -s <serial> shell am start -S -n <package>/<activity>`,
default activity `.platform.LaunchActivity`), waits 8 seconds to settle, then captures one frame
via `adb -s <serial> exec-out screencap -p` and returns it as an image for you to look at.

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
`built_for_headset`. With a Swan attached it marks each relevant row `device_pending` and gives
you the exact on-device re-test to run (e.g. "point the controller ray at an interactable, pull
the trigger" for `controller_ray`). Run `deploy_to_device` (or the manual steps above) to get the
build on-device, run the listed test, capture, look, then record the result per Section 4 below.

Note a wording inconsistency you may notice in that tool's own output: `swan_verify_matrix`'s
`note` field currently says to flip rows using `evidenceType: vision_verified`. That's stale —
`device_verified` is the evidence type that actually exists in the ledger schema for this
purpose and is the one ranked correctly above `vision_verified` in the capability report and
claims page. Use `device_verified`, not `vision_verified`, for anything captured on real
hardware; this doc is the correction until the tool's own string is fixed.

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
   playbook, `docs/playbooks/os61-bringup.md`, for why version identity matters here).
4. **The app package + the exact launch command used** — package name, activity (or the monkey
   LAUNCHER invocation if none was given), and the `adb install`/`am start` commands actually
   run, so the run is reproducible from the ask-list alone.
5. **One sentence from a human (or agent) who looked at the frame**, stating plainly what is
   visible — the same attestation discipline this ledger already requires for `vision_verified`
   (e.g. "the six shelf cards render at eye level, PBR reflections visible on the metal trim").

Package these as a directory (PNG + a short text file with the other four items is enough — no
need to write prose beyond the one-sentence attestation). This is the same "send the artifact,
not a summary" discipline used in `docs/playbooks/os61-bringup.md` Section 6.

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
  cClass: "C1" | "C3" | "C4_headset_only"   // if this closes a built_for_headset row
}
```

`record_verification`'s schema today (`src/ledger.ts:120-128`) does not expose a dedicated
`deviceSerial` field, even though `src/claimspage.ts` already knows how to render one if present
(`e.deviceSerial`, populated only via the internal `appendLedgerEntry` `extra` parameter that
other tools like `visual_judge` use, but which `record_verification` does not currently thread
through). Until that gap is closed, fold the device identity (model/serial + build fingerprint
from Section 3, items 2–3) into the `attestation` text itself, so it's on record even without a
structured field — don't invent a `deviceSerial` parameter that the running tool doesn't accept.

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
