# CP2 — productized Full-stage in-app locomotion

Date: 2026-09-05

Branch: `in-app-locomotion-cp2-2026-09-04`

Base: `9ad746d` (`main` at CP2 start)

Live branch head: `d1435ef86e035d4688504a52a48779129a5b89a0`

Post-live server hardening: `07b6366a3f44b54310cba0a48e8f9dd3365f6367`
(rebuilt-fake evidence only; no emulator rerun)

Target: `emulator-5554` only

Boot: `84e6cabf-2f79-46e5-aadd-478ab535c5a7`

External evidence root: `/private/tmp/pico-in-app-locomotion-cp2-2026-09-05.lAWEYP`

## Result

**Positive product-route evidence, with an entry-chronology caveat.** The repository's full-surface
`run_in_app_locomotion_route` tool traversed the generated Boundary Lab Full
world at absolute world-root offsets `0/1/2/4/8/16 m`. Every accepted
baseline/waypoint HMD sample was `(0,1.65,0)`—`x/z` at tracking origin and
`y=1.65 m` at the provider's eye height—and every measured translation drift
was `0 m` against the `0.02 m` experiment threshold. Guardian remained active,
and the app remained
immersive beyond the earlier physical-walk experiment's authored route-gate
labels between 1 m and 2 m. Those labels were not calibrated physical distance.

Both explicitly selected mechanisms passed independent, matched cold-launch
routes on the same boot: receipt, APK, absolute targets, budgets, and capture
policy matched; the explicit mechanism and required glide duration differed.
The approved selection rule therefore chooses
**direct transform glide as the default mechanism** and retains
**root replacement as a rendered-frame-proven fallback**. The tool input still
requires an explicit mechanism and never silently switches or falls back.

Every retained baseline, waypoint, and restoration PNG from both successful
runs was opened and LOOKed. The visual verdicts below are grounded in those
exact bytes. The tool receipts and adjudications remain capped at
`evidenceCeiling: "structural"`; this report does not relabel them as
`vision_verified` or `device_verified` and does not turn temporal settlement
into visual proof.

The retained evidence does not establish that the complete detailed
released-state probe preceded the earliest build/install mutation. Therefore
this report does not claim that the exact staged CP2 entry protocol was proved
end to end. The later same-boot snapshot and each successful product route's
own clean Full pre-movement safety checks support the route result described
here; they do not repair the missing earlier chronology.

This is not a Guardian disable and it emits no physical-walk, controller,
keyboard, or tracked-head movement input. It moves the app-owned world root
relative to the stationary tracked head.

## Released-state recheck and product binding

The retained seven-file `safety-pre-r4` snapshot, captured later on the same
boot immediately before replacement attempt r4, reproduced the released state:

- qemu PID `12827` was alive and `emulator-5554` was the only attached serial;
- boot ID was exactly `84e6cabf-2f79-46e5-aadd-478ab535c5a7`;
- Guardian/VST/debug were `1/1/1`;
- `/data/misc/user/0/boundary/localmode` was absent;
- SystemUI was foreground; and
- runtime configuration was stage `2`, safeguard `0`, center `0,0,0`, and
  virtual-content flag `0`.

The retained bytes do not establish that this complete detailed probe set ran
before the earliest build/install mutation; that entry-gate chronology is
therefore **UNVERIFIED** rather than inferred from the later matching snapshot.

The product build recorded native-run receipt
`fe6024632eb3e772240f1aa7b3c1be13eca50c879678eb36b878d76b73a550e2`
for `com.fleet.boundarylabmanifestfull/.platform.LaunchActivity`. The authored
and effective AppSpec SHA-256 was
`8cd9f0e6b2f5233e224e2d62c1ac706f5a8d7bf6ffc321a2017945cbeed46825`;
the built and installed APK SHA-256 was
`01ccd10dfb90d76687bb352a96054d5212274468d421157ffdc80db223bc2231`.
The build capture remained structural and is not used as route visual proof.

Both route prepares discovered locomotion capability revision 1 through the
read-only `commands` preflight, sampled a fresh HMD listener callback, and
passed five fresh-launch health/dialog observations. The replacement monitor
ran 64,764 ms; the direct monitor ran 63,295 ms. Every observation retained
the exact boot/APK/PID/start/foreground binding and clean Full safety:
Guardian/VST/debug `1/1/1`, stage style `3`, safeguard `1`, center `0,0,0`, and
virtual-content flag `1`.

| Mechanism | Run ID | PID / start ticks | Initial root incarnation / generation |
| --- | --- | --- | --- |
| replacement | `6a629d6fcfdedeb88c245b178cb9441f99f46d13fcfa488485acc557105d2e43` | `32717 / 17666305` | `57cafeee-3504-47af-903c-2bc8d17b050b / 1` |
| direct, 500 ms glide | `fdf736da02b6ea396d1a276f1faf4da655b739e8ac98d6e17105a6bc44e7226a` | `4083 / 17884394` | `a86c7473-581b-4adf-b2fa-d341fc2526c6 / 1` |

## Ordered frames and LOOK verdict

All files below are 2160×2158 source captures under the external evidence
root. Each of the 14 file instances was opened independently, including the
byte-identical direct baseline and restore files. A second reviewer also
LOOKed all seven distinct image byte sets and confirmed the descriptions and
replacement-recovery caveat.

| Offset | Replacement source / SHA-256 | Direct source / SHA-256 | LOOK result |
| --- | --- | --- | --- |
| 0 m | `replacement-route-r8/captures/000-app-baseline.png` / `4e135c1b4543d60d2283aa4b998ca32d2bdd92925ab77257291a7578c8348585` | `direct-route-r3/captures/000-app-baseline.png` / same SHA | Full cyan nested-gate corridor and grid at zero; no Home or ejection frame. |
| 1 m | `replacement-route-r8/captures/001-waypoint.png` / `db0e6018d165d26201552fbdf129ba792cc5d5a981cce23d85783ea37820c777` | `direct-route-r3/captures/001-waypoint.png` / same SHA | View advances through the near gate; Boundary Lab panel grows while the corridor remains. |
| 2 m | `replacement-route-r8/captures/002-waypoint.png` / `510669aea047d7689dc535a7cd5041ee6d50509e01dad5f58719d784fa5d0d59` | `direct-route-r3/captures/002-waypoint.png` / same SHA | Next cyan gate enters the foreground and the 4 m marker remains deeper in the corridor. This is beyond the prior authored route-gate label bracket, not a calibrated physical-distance claim. |
| 4 m | `replacement-route-r8/captures/003-waypoint.png` / `f34916499dbb4df3e9ee79f9ba0a6ff5b2f8d094da44926f3699da700fb4f54c` | `direct-route-r3/captures/003-waypoint.png` / same SHA | Prior gate has passed; a deeper cyan portal is centered over the shifted grid. |
| 8 m | `replacement-route-r8/captures/004-waypoint.png` / `71618e11fa1f4b99b69be0af8893eb46b8a153e55e4267c09c3bec7817973381` | `direct-route-r3/captures/004-waypoint.png` / same SHA | Corridor advances again; the smaller cyan portal and center post remain visible, with no Guardian/Home frame. |
| 16 m | `replacement-route-r8/captures/005-waypoint.png` / `9eb352694fd95654cc6a52298d4ee7988c0bf7360b6d37f579103ea51f198653` | `direct-route-r3/captures/005-waypoint.png` / same SHA | Far cyan gate and post remain centered on the continuing grid; no Home or ejection pixels appear. |
| restored 0 m command | `replacement-route-r8/captures/999-restored-001.png` / `6db8516889f149d673066132a664c94899ac1d0d7530e793668b79751ed49a5a` | `direct-route-r3/captures/999-restored-001.png` / `4e135c1b4543d60d2283aa4b998ca32d2bdd92925ab77257291a7578c8348585` | Both remain in the Full corridor and both bridge receipts/readbacks report an absolute-zero root. Direct is byte-identical to baseline. Replacement is not: its LOOKed frame is closer and includes yellow/white peripheral geometry, so no pixel-identical replacement-baseline claim is made. |

The exact numeric offsets are bound by ordered absolute locomotion commands and
their bridge acknowledgements. The screenshots prove the matching ordered
perspective changes and uninterrupted Full-world rendering; they do not alone
encode metric coordinates.

## Real transition-then-stable behavior

The timing origin is host-side completion of the stable guest acknowledgement
pull. The
transition time is the first subsequently observed capture whose SHA differs
from the reviewed prior frame; stable time is the following byte-equal pair
that the settle state machine accepted. These are real observed polling
latencies and therefore upper bounds on when a rendered transition first
became capturable—not exact compositor presentation instants and not an SDK
guarantee.

| Mechanism / target | Observed presentation interval after ack | Stable after ack | Rejected prior-frame polls |
| --- | ---: | ---: | ---: |
| replacement 1 m | `(2,460.976, 3,774.048] ms` | 5,082.767 ms | 2 |
| replacement 2 m | `(2,223.821, 3,503.676] ms` | 4,802.956 ms | 2 |
| replacement 4 m | `(3,714.432, 5,020.995] ms` | 6,301.631 ms | 3 |
| replacement 8 m | `(2,283.482, 3,638.609] ms` | 4,909.607 ms | 2 |
| replacement 16 m | `(2,014.318, 3,264.527] ms` | 4,534.787 ms | 2 |
| replacement restore | `≤548.053 ms` | 18,406.918 ms | 0 |
| direct 1 m | `(2,856.101, 4,038.903] ms` | 5,230.130 ms | 3 |
| direct 2 m | `(2,815.129, 3,987.972] ms` | 5,172.873 ms | 3 |
| direct 4 m | `(2,906.667, 4,094.916] ms` | 5,272.934 ms | 3 |
| direct 8 m | `(3,034.450, 4,262.836] ms` | 5,465.735 ms | 3 |
| direct 16 m | `(2,817.543, 3,991.482] ms` | 5,173.462 ms | 3 |
| direct restore | `(1,648.358, 2,837.756] ms` | 5,211.646 ms | 2 |

An interval `(a,b]` means the prior frame was still observed at `a` and a
changed frame had been captured by `b`; replacement restore had no post-ack
prior observation from which to derive a lower bound. No waypoint or
restoration capture settled on the stale prior SHA. Prior-frame
polls were retained as `relation: "prior"` and rejected until a transition.
Replacement restore changed on its first poll, then produced 12 changing
candidate hashes before the twelfth candidate repeated on poll 13; its 18.4 s
stable latency demonstrates why the protocol cannot encode the spike's 10 s
grace as a guarantee. Direct restore first produced an intermediate candidate,
then the exact baseline SHA, then its stable match.

## Head pose, freshness, and drift

Every accepted waypoint pre/post sample was `(0,1.65,0)` with quaternion
`(x=0,y=0,z=0,w=1)`. Here "head at origin" means position `x=0,z=0` at the
tracking origin while the provider reported eye height `y=1.65 m`. The table
records listener sample age in milliseconds and
the strictly increasing callback sequence pair. The admission ceiling was
250 ms; the maximum observed accepted age was 221.294 ms.

| Mechanism / target | Accepted pre / post age | Sequence pre → post | Translation drift |
| --- | ---: | ---: | ---: |
| replacement 1 m | 8.020 / 8.602 ms | 3035 → 3384 | 0 m |
| replacement 2 m | 5.375 / 9.212 ms | 6145 → 6457 | 0 m |
| replacement 4 m | 49.944 / 31.207 ms | 7750 → 7774 | 0 m |
| replacement 8 m | 6.163 / 140.052 ms | 8553 → 8628 | 0 m |
| replacement 16 m | 10.283 / 16.448 ms | 10147 → 10454 | 0 m |
| direct 1 m | 0.150 / 5.098 ms | 2539 → 2909 | 0 m |
| direct 2 m | 171.539 / 3.508 ms | 5195 → 5286 | 0 m |
| direct 4 m | 2.932 / 0.892 ms | 6639 → 7014 | 0 m |
| direct 8 m | 0.233 / 221.294 ms | 8688 → 8949 | 0 m |
| direct 16 m | 22.960 / 10.418 ms | 9980 → 10174 | 0 m |

Both baselines were fresh: replacement accepted 60.710 ms on attempt 3 and
direct accepted 170.300 ms on attempt 4. The acquisition loop rejected aged
samples rather than letting them satisfy the gate: replacement rejected two
baseline samples and one 8 m post sample, including a retained 736.938 ms
candidate before accepting the fresh retry; direct rejected three baseline
samples and five waypoint pre samples in total. Every accepted pre/post pair
passed strict sequence, observation-time, and read-time advancement. Each
baseline-to-pre, baseline-to-post, and pre-to-post Euclidean result was `0 m`,
passing the `0.02 m` experiment threshold.

All recorded quaternion deltas were `0 rad`. They are telemetry only; CP2 did
not invent a quaternion pass threshold. Restore actions do not sample HMD pose,
so no restore freshness claim is inferred.

## Guardian, continuity, and no ejection

Every prepare and waypoint safety receipt remained Guardian/VST/debug `1/1/1`
with Full stage `3`, safeguard `1`, center `0,0,0`, and virtual content `1`.
Every movement acknowledgement recorded `physicalWalk: false`. The app kept
the exact boot/APK/PID/start binding through each route until its owned restore
stopped it.

Each of the ten waypoint log brackets had exactly one BEGIN and one END marker
and zero counts for app pause/ejection, `boundary min`, container-info change,
launcher resume, and `setSpatialContainerBoundary`. The replacement log SHAs,
in route order, are `e6923bc55417c931125357899e86bbed88ff7231d46b6e95a754e2d6aeb59e19`,
`badd7ab49300098996a707805c10e40e411dc04eaa9d7a731879b14d79eacc9d`,
`6f1c1d62477f7f7aab357169489c3b619ee9c890e3c8f0e6cb4c30d3ab753572`,
`a17ef6aca7e6a2ed5766fb9da8ee252f09167d1fb8d3a0c56d00c8518f94fa69`,
and `2db6ac406d53f288a10afdc7a00e54ade3292509ff356c0e7273e8daa482adaa`.
The direct log SHAs are
`b5f575cdb9e9110f6ff4405a79e3ab7e0d1afd9b402699d2b774d1a7630c2ca9`,
`2e704111855c664cd84262f8204b2b941ca2191d7836feffd90e7ac3dd8f6dec`,
`39d067a39c3997b7d0a48bd02f1507cb6ba9ca8649660adcdc51f6e399475fbc`,
`a81af46afd22dd711275ea5646d2580466adb80e54fa35dde28a65cf9d012f02`,
and `be023291b0b2e61280ac4430aa3e14a348c03645422f49f4aaebd77d12dae0ed`.

The no-ejection conclusion is the conjunction of the LOOKed Full-world frames,
exact foreground continuity, clean active-Guardian snapshots, and empty
bracketed transition counters. It does not claim that screenshots alone prove
Guardian state.

## Mechanism conclusion

Direct mutation and root replacement rendered the same byte-exact baseline and
the same five ordered `1/2/4/8/16 m` waypoint frames. Their restoration frames
are separately reported above and were not byte-identical to each other. Direct
kept root generation `1` throughout and used a 500 ms glide. Replacement
advanced the lifecycle generation at every absolute move and restored
generation `6 → 7`; generation reconciliation remained successful.

Because both passed, direct glide is the selected default: it is the smaller
mutation and preserves root identity. Replacement remains an explicitly
selectable, independently proven fallback. The tool must continue to reject
legacy capability, stale root generation, or an explicit mechanism failure;
it must never switch to the fallback silently.

The direct acknowledgement structurally records completion of the requested
500 ms interpolation, and the LOOKed captures prove its endpoints. CP2 retained
no video or intermediate frames, so perceptual smoothness is **UNVERIFIED** and
is not part of the mechanism-selection claim.

## Deviations and live hardening

Only the successful `replacement-route-r8` and `direct-route-r3` runs support
the mechanism conclusion. Earlier replacement attempts exposed bounded
prepare/log/readiness issues and were used to add TDD coverage before retrying.
The first direct prepare exhausted its prepare budget while the emulator's
safeguard center was nonzero; it never reached capability discovery, HMD
sampling, capture, or locomotion, so it is not a direct-mechanism failure. A
second attempt was stopped before movement for the same reason.

Guest XR recenter accepted its command, but its receipt explicitly left the
rendered-pose effect unverified; a later failed direct prepare still observed a
nonzero absolute center. An operator then reported attempting the emulator host
**Reset Camera** control, and the later successful direct prepare observed
center `0,0,0` on the same boot. The final operator audit also records the
released qemu PID `12827` and same boot ID. The retained external bytes contain
the control script but no execution receipt or immediate pre/post center probe,
so attributing that restoration causally to Reset Camera is **UNVERIFIED**.
PICO SDK 0.13's local vault document
`spatial-toolkit_PICO Emulator_Navigate the PICO Emulator UI.md` describes the
control as restoring the initial viewpoint position and orientation (lines 19
and 49), but that documentation does not prove its effect in this run. The
cause of the intermediate center displacement is also **UNVERIFIED**. The
successful direct run began from SystemUI, produced the same byte-exact
baseline as replacement, and used the same receipt, APK, targets, budgets, and
capture policy. The documented control is an emulator viewpoint reset rather
than app locomotion or physical-walk input.

The successful product runs include the live-discovered, test-first hardening
on this branch: bounded prepare clearance and log windows, observed Full-stage
readiness, retried explicit launch deferrals, spatial-shell-aware continuity,
fresh HMD acquisition within reserved deadlines, and omission of absent
receipt error fields. Navigation, boundary-experiment, door, and benchmark
implementations were not restructured.

After live work and emulator release, independent review found additional
server-orchestration gaps. TDD hardening now assigns nested waypoint and
restoration subdeadlines so early work cannot consume the time reserved for
settled capture, post-HMD safety/continuity, boundary-log closure, target
shutdown, final process/safety proof, and immutable action publication. The
route and restoration floors include explicit stage-handoff and capture-
completion guards; route BEGIN/pre-safety/pre-continuity and restore entry
validation have their own protected windows, and exact-deadline completion is
rejected. Every successful or failed step/restore action is fenced immediately
before and after its immutable hard-link commit. A post-link timing failure
retains that semantic record, demotes the top-level result, and publishes a
structured incident rather than writing a conflicting stopped payload.
Completed actions defer repairable directory fsync, stage removal, and derived
JSONL work. Every later state-bound call validates the immutable chain before
device effects; filesystem-only repair occurs when a later action is published
or during a no-device terminal-restore replay/adjudication, not necessarily
before every later device effect. An idempotent completed-restore replay does
that filesystem-only validation/repair without a device probe or effect and
rejects later artifact damage. This process-lifetime repair design does
not claim crash durability across the interval between hard-link creation and
directory fsync. Cleanup-only subprocess timeouts can also aggregate beyond a
nominal stage reserve; the overrun remains a recorded failure and cannot yield
a false completed restore. Prepare now reserves its own final publication
window and fences successful and failed action records. If a completed prepare
record commits but misses its post-link fence, cleanup is published under a
distinct fenced compensation operation; the serial is released only after
that publication returns. A failed-action record says only that release is
eligible after publication, so a post-link fence miss cannot leave an immutable
false release claim. Prepare also persists an exact, separately validated
PID-absence receipt rather than deriving
clearance from the force-stop command receipt alone. It distinguishes
`known_stale` (clean prior PID absence proved) from
`unknown_after_stop_attempt` (a prior stop was attempted or command-completed,
but absence was not proved) and `not_evaluated_cp1` (the prior was untouched).
Receipt-bound relaunch remains withheld in every state. These post-live changes
were exercised by rebuilt fake gates. No post-live emulator rerun occurred;
these changes do not alter or broaden the rendered-frame result above.

The same post-live review also tightened emergency-stop convergence. Shutdown
requires an in-deadline successful stop receipt followed by exact process
absence; neither proof stands in for the other, and both precede stopped-process
nonce cleanup. If a nonzero mutation may have
applied and no bound zero recovery exists, the terminal receipt remains
`restore_failed` with `safe_release_without_zero_proof`, cannot be adjudicated,
and releases the serial only after exact process/prior, nonce, final
Guardian/VST/debug plus center `0,0,0`, and fenced action-publication proofs.
Pre-link, post-link, retry, idempotent-replay, and safeguard-center drift cases
are fake-gated. They were not rerun on the released emulator.

## Scope and remaining reuse proof

The live conclusion is bound to this exact generated Boundary Lab Full app,
APK, emulator, and boot. CP1 structurally covers the general Full generator
and preserves Mixed/Progressive output, but CP2 does not visually generalize
from one app to every possible generated or third-party world. Welcome Space,
the external Polyfork GLB lane, hardware, and arbitrary Full-world reuse remain
**UNVERIFIED** until the separately staged reuse work runs.

## Restoration and emulator release

Both product routes returned their owned world root to absolute zero and
proved the target process absent. Replacement restore completed with generation
`7`; direct restore completed with generation `1`. Both recorded no primary or
cleanup error, target PID set `[]`, post-stop Guardian/VST/debug `1/1/1`, and
center `0,0,0`. There was no receipt-bound prior app; no receipt-bound process
was relaunched.

After the final route, `com.fleet.boundarylabmanifestfull` was force-stopped
again idempotently and SystemUI was explicitly launched. Final read-only probes
showed:

- qemu PID `12827`, boot ID
  `84e6cabf-2f79-46e5-aadd-478ab535c5a7`, and only `emulator-5554` attached;
- target PID set `[]`;
- foreground
  `com.picoxr.systemui/com.picoxr.systemui.platform.MainActivity`;
- Guardian/VST/debug `1/1/1` and localmode absent; and
- stage `2`, safeguard `0`, center `0,0,0`, virtual-content flag `0`.

The MCP driver was closed, no further device command is pending, and
`emulator-5554` was released for the waiting chat.

## External evidence inventory

Heavy frames, logs, route state, and MCP responses remain outside the
repository. The repository stores only this summary and their hashes.

| Artifact under the external root (unless absolute) | SHA-256 |
| --- | --- |
| `002-fleet-build-full.json` | `f91c0ba955adde4ff5463185e702bda1729347a707fa6a78936b0f0e3ec1bd86` |
| native receipt `/Users/sushantsrikrish/.pico-mcp/run-receipts/native-v1/com.fleet.boundarylabmanifestfull/fe6024632eb3e772240f1aa7b3c1be13eca50c879678eb36b878d76b73a550e2.json` | `8975c51a799eee8832aa15a3116a41aa16ae461e3ca7b97417636a4d0dfe4fb1` |
| canonical `safety-pre-r4` tree, 7 files / 1,517 bytes | `528e677575e0107d66d5c5fe241b5915b763ea166f71f7f9d71bfb39459a8607` |
| `003-xr-recenter-probe.json` | `9aa6827feb8c2da480cce0e3a5a276fb4ec8523e1b5c63b10e96611437eafc7e` |
| `mcp-live-r8/009-direct-prepare-r1.json` | `2fbbe60345b9159f68fd047826b1e65097592c6acc45351a1443df39f6cbfd5e` |
| `mcp-live-r8/011-direct-pre-route-recenter.json` | `450720fb08fb58fbd426415796e77e148a6eb36ba5f41e92febd3c784602eb97` |
| `qemu-reset-camera.swift` (script bytes only; not execution proof) | `fcfe97da6c263b62dace9ccd8bf7d0d01108e8bc1bac88921bed8073ac1f79b6` |
| `replacement-route-r8/run.json` | `63c09a820ada5a699bab78fb457e162277ed561d22096b6cbd8fa91f99e1ae90` |
| `replacement-route-r8/route.json` | `9554da52112958030b2fc11320bdfd91998b6caa3b4f4b3fe589d6c64ec45aa9` |
| `replacement-route-r8/actions.jsonl` | `d2b75e6460b4a3795df8558943afce46c18b4f25636bdeb283d9289260366ff4` |
| `replacement-route-r8/adjudication.json` | `0176fdd517fdeb9a0fd951707554a786be5d0032d9bd5660f3d02dc5360ce368` |
| canonical `replacement-route-r8` tree, 50 files / 10,681,371 bytes | `2ae35ff97f7cf72d90175d9e670b3caf6bd8555d5673604cd031003c120722b6` |
| `mcp-live-r8/008-replacement-adjudicate-r8.json` | `39131428031dfdeb9b4fbed65cfa081eb5d0bc24fb652ddb3901e8b4c7d9bc4e` |
| `direct-route-r3/run.json` | `9c3c1431893c841442bcef49d059c8fefbd2c63de3eb7c80e0a0c772ef4f0ac5` |
| `direct-route-r3/route.json` | `eb45fe373614b937d4c5177277b9a47751e55f7f9fb4874d18301d6b7db640c6` |
| `direct-route-r3/actions.jsonl` | `b3bb9360ff8dd08bbf8d277a50772874ae214151dd8ddabd25fc4e0c13b9e0a8` |
| `direct-route-r3/adjudication.json` | `c1905e423263f513146fbd041985a6dd91333334c7570a05bdda9cc702b65e68` |
| canonical `direct-route-r3` tree, 47 files / 10,431,845 bytes | `bca14622abc5c8f91afd8ede774c9002d93b4cdde216644366cec77ed2194c2b` |
| `mcp-live-r9/009-direct-adjudicate-r3.json` | `d5bf8f697ab26839e294b4a5b4bea595fdc3d3597d7b2a918c4e5deab4cd849d` |
| operator summary `final-state-audit.json` | `bfa5e84b56c78777efc05dd9d710ca30020753f4de96c37d2c0b315dd28cd069` |

The action chains contain the exact per-action receipt payloads, capture
traces, HMD acquisition attempts, boundary-log identities, safety snapshots,
continuity probes, and final stop proofs. Both final `adjudicate` actions report
`structural_complete`; that status means the required exact SHA attestations
were complete, not that the tool elevated their evidence class.
The three canonical tree digests byte-sort relative regular-file paths, then
SHA-256 the concatenation of one
`relative-path<TAB>decimal-bytes<TAB>lowercase-file-sha256<LF>` record per
file. They bind names, sizes, and content for the complete retained external
trees without copying those bytes into the repository. `final-state-audit.json`
is an operator audit summary rather than raw command output; the product
restore records independently retain their raw safety and process/activity
proofs.

## Repository gates

Each completed test result below ran only after a fresh `npm run build`, so it
imported the then-current `dist/` output.

| Gate | Result |
| --- | --- |
| TypeScript build | PASS, exit 0. |
| `node --test test/worldlocomotion.mjs` | PASS: 414/414. |
| `test:emulator-restart` | PASS: 689 pass / 1 skip / 0 fail across 690 tests. This is the fake suite and did not touch the released emulator. |
| `test:conformance` | PASS: sample-conformance failures 0; boundary probe/experiment 69/69. |
| `test:docsmeta` | PASS: 137 links across 66 files, 0 failures; the worktree `.git/config` warning is non-failing. |
| `test:adoption-safety` | PASS: 48/0. |
| `test:distribution-adoption` | Accepted known baseline: 41 pass / exactly 2 known stale failures (Linux gate count 45 versus asserted 44; suite count 48 versus asserted 46). |
| `test:tarball` | PASS: installed full-surface server returned exactly 255 tools on macOS; Doors and the env-unset default each returned exactly 18. |
| `sync-metadata --check` | PASS: 0 stale, 0 warnings; truth remains 255 macOS / source-derived 252 on Linux and Windows / 18 Doors. |
| Protected paths | PASS: `benchmarks/**`, `test/agentbench-*`, `src/navigation.ts`, `src/boundaryexperiment.ts`, `test/navigationtarget.mjs`, and `src/doors.ts` are byte-untouched against `main`. |

## Comparison authority

The historical [L0 spike](../locomotion-spike-2026-09-02/L0.md) established
feasibility with a throwaway replacement-root guest. This CP2 report is the
product-route regression through the repository tool and generated bridge,
subject to the entry-chronology limitation above. The
[physical-walk CP3 result](../immersive-phase1-2026-08-31/CP3.md) remains the
comparison for ejection between authored route-gate labels 1 m and 2 m; those
labels were explicitly not calibrated physical distance. The
[Guardian-disable O0 result](../guardian-disable-2026-09-01/O0.md) remains the
authority that privileged disable keys are walled.
