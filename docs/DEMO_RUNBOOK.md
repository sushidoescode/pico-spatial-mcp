# Demo runbook — PICO meeting (week of Aug 3, 2026)

*The 25-minute arc, the T-24h rehearsal checklist, the per-step fallbacks, and the asks.
Every beat below was already proven at least once — the evidence line under each names the
ledger entry or measurement. Labels: **[live]** = verified by running it on this machine
(2026-08-01 unless dated), **[pending]** = staged in this evolution wave, confirm before the
demo. Nothing in this runbook may be claimed on stage beyond what its evidence line supports.*

---

## The arc (28 min, seven beats)

### 1. `pico_doctor` live (~2 min, the call itself is ~10 s)

Run it cold, on the doors surface. The pitch is one sentence: **every failure names its fix** —
it's a read-only preflight, and it's how we caught real toolchain issues we now report upstream.
Expect (and say out loud) the two honest soft flags: macOS Accessibility is unverifiable
read-only, and calibration freshness is checked against the current emulator boot.

*Evidence: `preflight_env`/`pico_doctor` green with two soft flags [live].*

### 2. Doors first-light — the MR brief (~10 min, the timed loop)

Short **Mixed-stage MR brief** — mrtable-style, e.g. *"a primitive table standing on my real
floor with bodies dropping onto it from a clickable menu"* → `pico_build_app` returns
`needs-authoring` + a scaffold (say why: the planner never guesses intent) → author the spec
(stageStyle `1` — the default) → `pico_build_app({brief, draftSpec})` → build → `pico_look` →
**actually LOOK at the frame on screen** → record it with `pico_record`, closing the honesty
loop in front of them.

- The two-step protocol is the design, not a failure — rehearse the narration for call one.
- **Narrate the escalation as the pitch, not an apology**: the calibrated eye cannot score
  passthrough frames (its checks were trained on a black void), so the Mixed build comes back
  `built-needs-look`/ESCALATE by construction — the machinery degrades safely instead of lying,
  and YOUR look on stage is the verification. That is the honesty contract working in front of
  them.
- `pico_record` is the doors ledger-write door (landed in v31; the doors surface is now
  16 tools — smoke-verified; pico_next answers 'what should I do now' from live local state).

*Evidence: the MR lane ran the exact brief unattended through `fleet_build` 2026-08-02 —
built 1 / installed 1 on the first pass, eye ESCALATE (confidence 0.5, correctly refused to
auto-PASS a passthrough frame), human LOOK confirmed the table seated in the passthrough room
with all three bodies settled on it — ledger `com.fleet.mrtable` seq 0–2 (1 vision_verified +
2 honest structural), capture sha `4f3a9c36…` [live]. The doors loop itself ran end-to-end
2026-08-01 on a fresh arcade brief — ledger `com.fleet.door48128` seq 0–2; the driven `start`
action bumped the HUD live [live]. First-light previously timed at ~10 min (2026-07-21).*

### 3. The interop beat (~4 min)

`pico-cli project create` (stage template, SDK BOM 0.13.3) → `gradlew assembleDebug` →
`verify_pico_apk` → the looked-at "Hello, Spatial SDK!" frame. The line that matters: **"your
toolchain scaffolds, ours verifies; install both."**

- Export `JAVA_HOME` before the gradle step — raw `gradlew` fails without it [live]; this is
  also one of the upstream reports (see the asks).

*Evidence: proven 2026-08-01, 41 s build — ledger `com.vranywhere.cliproof` seq 0
(vision_verified) [live].*

### 4. ROCKETSIM — the MR centerpiece (~5 min, pre-built — do NOT build this live)

Launch `com.picoagent.rocketsim` (project `~/AndroidStudioProjects/rocketsim-native`): the
Meshy table seated on the DETECTED floor by the v31 one-call `place_model_on_surface`, a
NASA-textured Blue Marble Earth (sha-pinned provenance) with an orbiting LROC Moon, and the
glass MISSION CONTROL web panel — two big LAUNCH/RESET buttons plus live PHASE/ALT/VEL
telemetry. Click LAUNCH (a real click on the web panel; CDP drives the same path headlessly)
and narrate the ~31 s mission: countdown → ignition → liftoff → a visible point-gravity ORBIT
around Earth → trans-lunar flyby → return → retro-burn → Falcon-9 touchdown ON the pad.

- Say the honest sentence out loud — it's the pitch: "guided simulation with integrated point
  gravity; the SDK's uniform-gravity rigid body cannot orbit, so the sim says exactly what it
  is on the panel footer."
- The OS places the web panel; from the fixed forward pose it can occlude the scene — use
  `panel:hide`/`panel:show` DEBUG_CMDs for clean flight views (the app auto-opens the panel
  after seating).
- Full Space entry animation: plane queries poll for a reason — give the app ~2.5 s before
  expecting the table.
- **Placement is a demo moment (v3)**: the whole installation — table, pad, rocket, planets,
  trajectory — is one movable root. Nudge/rotate/reseat from the panel's TABLE PLACEMENT
  cluster (real clicks), or OPTION+drag with `tools/table_drag_bridge.py`
  (`BRIDGE_PKG=com.picoagent.rocketsim`; needs Input Monitoring). Height re-derives from the
  detected floor on every move; placement is rejected (greyed, LOCKED IN FLIGHT) mid-mission.
  A mission flown from a moved+rotated pose landed dead-center on the relocated pad
  (ledger seq 25–32, 2026-08-02).
- Fallback: full-mission videos `rocketsim_v2_fullmission_frameseq.mp4` (default pose) and
  `rocketsim_v3_movedpos_fullmission_frameseq.mp4` (moved pose, 62 real frames).

*Evidence: ledger `com.picoagent.rocketsim` seq 9–19 [live, 2026-08-02] — composition, panel,
CDP click, mid-orbit, flyby, landing burn, reset all vision_verified with linked captures;
NASA texture shas recorded seq 17.*

### 4b. MISSION TOWER — the live-data MR centerpiece (~4 min, pre-built)

Launch `com.picoagent.missiontower` (project `~/AndroidStudioProjects/missiontower-native`): a
Tripo-asset airport diorama (triaged + Blender-decimated from 80 MB raw to 26 MB shipped) seated
adaptively on the detected floor — verified at ×2.0 in the atrium and ×1.56 in the bedroom, same
binary — with four bundle-instanced airliners flying full guided lifecycles under
separation-is-law choreography (altitude bands, in-trail gaps, runway lock with visible
GO-AROUND flashes; measured session minimum 0.50 m world). The TOWER CONTROL panel carries the
SIMULATION launch bar, a world-metre radar with trails, phase-chipped flight strips, and
per-strip LIVE/SIM chips.

- **The live beat**: daytime SFO gives dense LIVE traffic — real callsigns with LIVE chips
  (AAL3295 on approach was rendered in-room, ledger seq 4). Launch the app FRESH on demo day:
  anonymous OpenSky credits (~400/day) reset daily, and an overnight poller exhausts them
  (measured: fail #257). If rate-limited, the truthful 429 banner + auto-SIM fallback IS a
  demo beat — it proved itself in the wild, ledger seq 22.
- Reseat/move from the panel's placement cluster; placement locks (greyed, "FOLLOWED AIRCRAFT
  ON FINAL") while a followed aircraft is on final — show it.
- Full-cycle video fallback: `/tmp/pico-render/missiontower/v2/missiontower_v2_fullcycle_frameseq.mp4`.

*Evidence: ledger `com.picoagent.missiontower` seq 0–22 [live, 2026-08-03/04] — seat, panel v2,
separation money shot, touchdown, GO-AROUND flash, moved-with-traffic, atrium ×2.0 reseat +
wild 429 fallback all vision_verified with linked captures; seq 11 properly retracted.*

**Fallback beat — MR tabletop** (if rocketsim misbehaves): the 2026-07-29 tabletop app —
detected FLOOR, physics settling, live Kraken feed, web panel driving native physics; same
v30 lane narration (`measure_model` → `bake_textured_model` →
`generate_surface_placement_kotlin`). Evidence: ledger seq 12 [live, 2026-07-30].

### 5. Capabilities + claims — the honesty close (~3 min)

`pico_capabilities` (doors) / `capability_matrix` (full) live, then the regenerated claims page
(`docs/claims/index.html` — every vision/device row carries the capture's sha256). **End on the
v30.1 retraction as the proof the ledger is real**: we published "immersive doesn't composite",
a user challenged it, we re-measured, and the retraction is on the record with vision_verified
evidence — the system is built so that story is cheap to tell and impossible to fake.

*Evidence: live matrix 2026-08-01 — 14 categories, 69 apps, 208 ledger entries
(109 vision_verified); claims page regenerated same day [live].*

### 6. The asks (~2 min)

See [the asks](#the-asks) below — hand over the list, don't improvise it.

---

## T-24h checklist (run all of it, in this order)

1. **Cold-restart the emulator** — `scripts/restart-emulator.sh` (kills qemu + relaunches with
   the explicit AVD/sysdir env the wrapper normally provides). Run `test:emulator-restart` here
   too — it was deliberately skipped in the 2026-08-01 gate-battery baseline to protect the live
   session.
2. **Recalibrate the capture camera** — calibration DIES on a cold restart (principal point has
   shifted ~300 px in one recorded case): `fleet_build(['calib'])` then
   `calibrate_capture_camera`. `pico_doctor` confirms freshness.
3. **Accessibility md5 two-capture test** — take two captures around an `emulator_look` sweep
   and md5-compare: identical bytes = the drag was silently dropped → System Settings → Privacy
   & Security → Accessibility for the terminal/IDE hosting the server. There is no read-only
   probe for this; the two-capture test is the check.
4. **Input Monitoring** — the mouse bridge needs it for menu clicks (beat 2's `start` press and
   the tabletop drag). If `mouse_bridge_status`'s log says "could not create event tap":
   System Settings → Privacy & Security → Input Monitoring.
5. **Run the full gate battery** — all green is the bar (35 invocations incl. `smoke` and
   `test:tarball` in the 2026-08-01 baseline; the count may have grown this wave).
6. **Record the fallback videos** — none exist today [review, 2026-08-01]. Record one per live
   beat: the doors loop, the interop beat, the MR tabletop — via `pico-cli capture record` or
   adb `screenrecord` — plus **one `gui_capture`-path clip of immersive Unity** (the retraction
   exhibit). A demo that falls back to a recording stays honest; a demo that improvises does not.
7. **Dry-run the full arc once, timed**, with the fallback videos on disk.

---

## Per-step fallbacks (the four failure modes we have actually hit)

**Emulator window buried** (clicks land on other apps; mouse-bridge log fills with
`click (not over a menu button)`): raise it —
`osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "qemu") to true'`.
Seen live 2026-07-29: qemu was at window position 8 behind VS Code/Chrome.

**Modal `FullSpaceAppManagerDialog`** (com.picoxr.systemui "Back to Home", appears after
closing an app): synthetic clicks do NOT dismiss it — `cliclick` and `adb shell input keyevent
BACK` both fail on spatial dialogs. It needs a **real user click** through the raised emulator
window. Don't panic-restart: `SpatialRuntimeService: Watchdog … lastRenderTime` advancing
proves the app behind it is still rendering.

**`launch_blocked`** (launch "ok" but `pidof` empty, no crash — a stale foreground app blocks
the start; the full-space incumbent case was hit live 2026-08-01 through `verify_pico_apk`,
which does not yet auto-recover): inspect with
`adb shell dumpsys activity activities | grep topResumedActivity`, `am force-stop <blocker>`,
then relaunch your app with `am start -S`. `fleet_build` does this automatically — worst case,
route the beat through it. Escalation: if force-stopping everything still strands the shell,
cold-restart the emulator (checklist step 1) and recalibrate (step 2).

**Frozen viewport mirror** (an animated scene, byte-identical screencaps): detect with two
screencaps ~3 s apart + md5 — identical bytes on a scene you KNOW animates means the 2D mirror
froze, not the app. Remedy: `adb reboot`, wait for boot + settle, relaunch. Do not iterate on
the app — the captures were stale, not the scene.

---

## The asks

Hand these over explicitly (items 1–2 are drafted in
`.dev/drafts/2026-07-28-pico-ask-spatialadapter.md` — **send it before the meeting** so they
arrive with answers):

1. **SpatialAdapter Unity package IDs + delivery** — the scaffold's slot is wired and waiting;
   wiring is a config fill, not a rebuild.
2. **A reachable mirror of the 6.1 emulator** — the day we have it, the sha-pinned immersive
   tests re-run and the OPEN native-NDK/WebXR rows get settled one way or the other.
3. **Swan hardware time** — for the first `device_verified` ledger entry; the protocol and
   evidence ask-list are already shipped ([DEVICE_VERIFICATION.md](DEVICE_VERIFICATION.md)).
4. **Publish blessing** — npm + marketplace listing stay blessing-gated on our roadmap; nothing
   goes public before their go-ahead.
5. **pico-cli bug reports** (early-access 0.3.0, both measured [live]): `pico-cli doctor` hangs
   ≥90 s with zero output and `pico-cli plugin doctor` timed out at 45 s (`emulator status` and
   `mcp doctor` return instantly — use those as probes); and `pico-cli project create` emits a
   project whose raw `gradlew` fails unless `JAVA_HOME` is exported — a one-line env note in
   their template would close it.
