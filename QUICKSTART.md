# ⚡ Quickstart — pico-spatial-mcp

Build native PICO XR spatial apps from natural-language briefs, with **verified** results
(the agent looks at rendered frames — it never claims what it hasn't seen).

This is the proven first-run path, on the doors surface (`PICO_MCP_SURFACE=doors` — 13
intent-level tools instead of the full ~214). It's the exact sequence a cold, unassisted run
followed on 2026-07-21.

## 1. Register (once)

```bash
git clone <this repo> ~/PICO-MCP && cd ~/PICO-MCP && npm ci && npm run build
PICO_MCP_SURFACE=doors claude mcp add pico-spatial-mcp --scope user -- node ~/PICO-MCP/dist/index.js
```

Requirements: macOS, the PICO SDK 0.13 (Spatial Editor + emulator), Android Studio (its JBR),
ImageMagick (`brew install imagemagick`). Optional: Blender (custom menu panels), Filament cmgen (IBL).

## 2. Start the emulator (pre-condition, outside the timed path)

Open the PICO **Spatial Editor** app (it boots the emulator), or run `scripts/restart-emulator.sh`
for a CLI cold-restart. Either way, do this *before* you start the flow below — it isn't part of
the 15-minute bar.

## 3. The proven flow

Start `claude` in the repo (or point any MCP client at the registered server) and run these in
order:

1. **`pico_doctor`** — the read-only preflight. It checks node, adb, emulator/AVD state, gRPC
   reachability, macOS Accessibility, camera-calibration freshness, and disk headroom (7 checks).
   Every failing check carries the exact fix. Run this first, always — on a fresh environment two
   checks routinely come back `warn`/`unknown` rather than `fail`, and that's expected (see the
   gotchas below).

2. **`pico_build_app({ brief })`** — describe what you want, e.g. *"three spinning crystals over a
   stone floor with a start menu."* The first call returns `needs-authoring` + a scaffold AppSpec.
   **This is by design** — the planner never guesses your intent from prose; it hands you a
   scaffold to author against (objects, layout, counts, animation, menu).

3. **Adapt the scaffold** to your brief, then re-call **`pico_build_app({ brief, draftSpec })`**
   with the adapted spec. The pipeline now builds → installs → launches on the emulator → captures
   a frame → judges it, and returns:
   - `status: "verified"` — the calibrated eye's verdict was `PASS` (an automated pre-check, not a
     substitute for looking).
   - `status: "built-needs-look"` — it built and installed; **you look at the returned `capture`
     path yourself** before claiming anything works. This is the normal outcome for a novel brief,
     not a failure.
   - `status: "failed"` — read `notes`; asset-gated briefs name the missing prerequisite, build
     errors name the file. Feed the error text into `pico_fix` for the matched retained lesson.

4. **`pico_look`** (or open the capture path `pico_build_app` returned) — actually look at the
   image. That look is what turns a claim into `vision_verified`; record it with
   `record_verification` if you want it in the trust ledger.

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

Real rigid-body **physics** (strikes, drops) · clickable in-world **menus** (custom labels; your
Mac mouse clicks them) · **live-text scoreboards/HUDs** and full **web-content panels** (live JS
DOM) · AAA fidelity (PBR, shadows, shining IBL metals, animation) · procedural props incl. lathe
silhouettes · custom World-Labs worlds · multi-scene apps. The `com.pico.hooks` gradle plugin
lints scenes in every build; `fleet_build` builds brief batches unattended with an honest
auto-judge. Boundless walk-around immersion is PICO Swan hardware territory — the emulator's
strength is bounded, eye-level content, and every claim above is backed by a looked-at frame.

## The full surface

The doors surface is 13 tools; the full server exposes ~214. Remove `PICO_MCP_SURFACE=doors` (or
just add the full-surface server alongside) to get everything — codegen for every SDK subsystem,
the fleet/asset/editor pipelines, and the raw building blocks the doors orchestrate internally.
The doors stay available either way. See **[SKILLS.md](SKILLS.md)** for the agent reference and
**[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** for repo orientation.
