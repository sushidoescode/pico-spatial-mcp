# ⚡ Quickstart — pico-spatial-mcp

Build native PICO XR spatial apps from natural-language briefs, with **verified** results
(the agent looks at rendered frames — it never claims what it hasn't seen). Apps are
**MR-first**: the default is the Mixed stage (stageStyle `1`) — your real room is the
environment and content seats on it; a fully-virtual Full-Space app (stageStyle `3`) is an
explicit, fully-supported opt-in.

This is the proven first-run path, on the doors surface (`PICO_MCP_SURFACE=doors` — 16
intent-level tools instead of the full surface: 240 tools on macOS, 237 on other hosts). It's the exact sequence a from-docs-only run on a fresh clone
followed on 2026-07-21.

## 1. Register (once)

```bash
git clone <this repo> ~/PICO-MCP && cd ~/PICO-MCP && npm ci && npm run build
claude mcp add pico-spatial-mcp --scope user --env PICO_MCP_SURFACE=doors -- node ~/PICO-MCP/dist/index.js
```

Requirements: macOS, the PICO SDK 0.13 build payload from the Android Studio PICO Spatial Plugin,
Android Studio (its JBR/Android SDK/Gradle and Device Manager), a PICO AVD, and the emulator bundle.
Download/update that bundle through the Spatial Editor/plugin flow or with
`pico-cli emulator install --source auto --yes`. The CLI command does not create an AVD and does not
install the JDK, Android SDK, Gradle, or PICO build SDK. Optional: ImageMagick (`brew install imagemagick`),
Blender (custom menu panels), and Filament cmgen (IBL).

## 2. Start the emulator (pre-condition, outside the timed path)

If the emulator bundle is missing or stale, download/update it with the Spatial Editor/plugin flow
or `pico-cli emulator install --source auto --yes`; that command still does not create the AVD or
install the build toolchain. Create/select the AVD in Android Studio Device Manager. Then open the
PICO **Spatial Editor** app (it boots the emulator), or run `scripts/restart-emulator.sh` for a CLI
cold-restart. Do this *before* the flow below — it isn't part of the 15-minute bar.

## 3. The proven flow

Start `claude` in the repo (or point any MCP client at the registered server) and run these in
order:

1. **`pico_doctor`** — the read-only preflight. It checks node, adb, emulator/AVD state, gRPC
   reachability, macOS Accessibility, camera-calibration freshness, and disk headroom (7 checks).
   Every failing check carries the exact fix. Run this first, always — on a fresh environment two
   checks routinely come back `warn`/`unknown` rather than `fail`, and that's expected (see the
   gotchas below).

2. **`pico_build_app({ brief })`** — describe what you want, e.g. *"a primitive table standing on
   my real floor with bodies dropping onto it from a clickable menu"* (the Mixed-stage MR lane —
   the default; for a fully-virtual scene like *"three spinning crystals over a stone floor"*,
   declare `meta.stageStyle: "3"` in the spec you author). The first call returns
   `needs-authoring` + a scaffold AppSpec. **This is by design** — the planner never guesses your
   intent from prose; it hands you a scaffold to author against (objects, layout, counts,
   animation, menu).

3. **Adapt the scaffold** to your brief, then re-call **`pico_build_app({ brief, draftSpec })`**
   with the adapted spec. The pipeline now builds → installs → launches on the emulator → captures
   a frame → judges it, and returns:
   - `status: "verified"` — the calibrated eye's verdict was `PASS` (an automated pre-check, not a
     substitute for looking).
   - `status: "built-needs-look"` — it built and installed; **you look at the returned `capture`
     path yourself** before claiming anything works. This is the normal outcome for a novel brief,
     not a failure. On high-coverage passthrough frames, count/not-black/dominant-color checks are
     advisory and contribute zero confidence. If the expected scene declares at least two distinct
     authored colors, the color-key lane can auto-score at its default 0.8 confidence threshold;
     otherwise the judge escalates to your look. An `auto_judged` result remains weaker than a
     looked-at `vision_verified` result either way.
   - `status: "failed"` — read `notes`; asset-gated briefs name the missing prerequisite, build
     errors name the file. Feed the error text into `pico_fix` for the matched retained lesson.

4. **`pico_look`** (or open the capture path `pico_build_app` returned) — actually look at the
   image. That look is what turns a claim into `vision_verified`; record it with
   `record_verification` if you want it in the trust ledger.

## Clicking the in-world menu (baked in — no manual step)

When a built app has a GameMenu, `fleet_build` **auto-starts the mouse bridge** as a detached
background process — move your Mac mouse over a menu button in the emulator window and click;
hover previews the selection. No terminal command needed (the old manual `pico-bridge` step is
gone). Manage it with `mouse_bridge_start` / `mouse_bridge_status` / `mouse_bridge_stop`; opt
out of auto-start with `PICO_MCP_NO_AUTOBRIDGE=1`. One-time macOS grant if the status log says
"could not create event tap": System Settings → Privacy & Security → **Input Monitoring** →
enable the app hosting this MCP.

## Two first-run gotchas

- **macOS Accessibility.** Free-cam drags (`emulator_look`) go through synthetic CGEvents; without
  your terminal/IDE granted Accessibility, they're **silently dropped** — no error, the camera just
  never moves. Detect it by taking two captures around a sweep and md5-comparing them: identical
  bytes means the drag didn't happen. Fix: System Settings → Privacy & Security → Accessibility →
  enable your terminal/IDE.
- **Calibration dies on emulator cold restart.** `pico_measure` / `measure_placement` need a camera
  calibration that predates the *current* emulator boot — a cold restart shifts the principal point
  (seen: ~300px in one recorded case) and invalidates the old one. `pico_doctor` reports this
  honestly as `warn`/`fail` when stale. Fix: run `fleet_build(['calib'])` then
  `calibrate_capture_camera` once per emulator boot, before any `pico_measure` call.

## Timing

Timed 2026-07-21, cold clone, emulator pre-started: the full first-light run (clone → build →
doctor → two-step `pico_build_app` → look) completed in **~10 minutes**, including two toolchain
fix detours a collaborator on the current repo will never hit (the underlying bugs are already
fixed on `main`). A clean-docs replay against the fixed repo re-measures the honest headline
number — treat ~10 minutes as an upper bound, not a promise.

## What it can build (all verified on the emulator)

**Mixed-stage MR apps first** — content seated on the passthrough room's detected surfaces
(floor/table/wall planes with semantics; the measured `measure_model` → `bake_textured_model` →
`generate_surface_placement_kotlin` chain, or one-call `place_model_on_surface`), proven by the
mrtable and rocketsim apps · real rigid-body **physics** (strikes, drops) · clickable in-world
**menus** (custom labels; your Mac mouse clicks them) · **live-text scoreboards/HUDs** and full
**web-content panels** (live JS DOM) · AAA fidelity (PBR, shadows, shining IBL metals, animation)
· procedural props incl. lathe silhouettes · custom World-Labs worlds · multi-scene apps ·
fully-virtual Full-Space (stageStyle `3`) scenes as the explicit opt-in. The `com.pico.hooks` gradle plugin
lints scenes in every build; `fleet_build` builds brief batches unattended with an honest
auto-judge. Immersive Unity VR renders on the emulator too (v30.1 — capture it via `gui_capture`;
adb screencap is blind to XR-runtime output). Controller-ray input and head-tracked depth stay
PICO Swan / 6.1 territory, and every claim above is backed by a looked-at frame.

## The full surface

The doors surface is 16 tools; the full server exposes 239 on macOS (237 on other hosts, where four
host-GUI tools collapse to one explanatory stub). Remove `PICO_MCP_SURFACE=doors` (or
just add the full-surface server alongside) to get everything — codegen for every SDK subsystem,
the fleet/asset/editor pipelines, and the raw building blocks the doors orchestrate internally.
The doors stay available either way. See **[SKILLS.md](SKILLS.md)** for the agent reference and
**[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** for repo orientation.
