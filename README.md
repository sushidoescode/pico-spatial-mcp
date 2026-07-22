# pico-spatial-mcp

An MCP server that lets AI agents build **PICO XR spatial apps end-to-end on the emulator** — from a natural-language brief to a running, verified, shippable native app, no headset required. It authors scenes as text, compiles them through the real `spatialbundle`/Gradle toolchain, builds and deploys APKs, drives the PICO OS 6 emulator (lifecycle, adb, snapshots, an experimental gRPC XR layer), and — crucially — **verifies its own work by capturing rendered frames and looking at them.**

> ### The honesty invariant
> "Verified" means an agent or human **looked at a rendered frame** — never a compile, a log line, or a pixel heuristic. Every visual claim is recorded in a trust ledger that *structurally rejects* a `vision_verified` entry without a linked, looked-at capture. Honest deferral (`structural`, `built-for-Swan`, "I tried X and it failed") is always acceptable; a silent over-claim is the only unforgivable failure.

## For PICO reviewers: what you can use this for, today

Concrete jobs this tool does on a stock PICO OS 6 emulator install, each backed by ledger evidence you can audit:

1. **Verify any PICO APK you already have** — your own samples, pico-cli-scaffolded apps, Unity-built APKs. `verify_pico_apk` installs, launches, crash-checks, and captures a frame; the trust ledger records exactly how much was proven ([5-minute walkthrough below](#verify-your-apk-in-5-minutes)).
2. **Build demo and test apps from one-sentence briefs** — physics games, menu-driven scenes, live-data panels, hybrid web+3D apps — through the full `spatialbundle`/Gradle toolchain, unattended in batches (`fleet_build`), each capture judged and ledgered.
3. **Score a toolchain with SpatialBench** — the 6-axis conformance harness (`run_spatialbench`) runs any brief corpus through plan → compile → boot → capture → judge and emits a scored report; it works on apps OUR pipeline didn't build.
4. **World-model tooling for real scans** — a Gaussian-splat scan becomes a labeled semantic scene (OWL-v2), briefs anchor content to labeled real-world surfaces (`anchorTo`), free-space solving avoids even unlabeled geometry (occupancy grid), and placements come back with **measured error in centimeters** via the calibrated capture camera.
5. **Talk to a RUNNING app** — the live agent bridge spawns/moves/removes entities in a running spatial app, with every mutation verified by scene diff.
6. **Environment doctoring** — `pico_doctor` is a read-only preflight where every failing check carries the exact fix; it's how we caught (and report upstream) real toolchain issues.

It is designed to **complement** `pico-cli` and the `pico-spatial-agentic-tools` plugin, not compete: your tooling guides and scaffolds; this adds the verified build/verify/ship loop and the world-model layer. Install both side by side.

## Vocabulary primer

None of this is PICO Spatial SDK vocabulary — it's this project's own layer on top of it. Five terms carry most of the weight:

| Term | What it means |
|---|---|
| **trust ledger** | An append-only log (`record_verification` / `ledger_report`) of every visual claim this tool has made, each entry naming its evidence class. It structurally rejects a `vision_verified` claim with no linked capture — you can't fake the strongest tier. |
| **the eye** | The calibrated auto-judge (`visual_judge` / `auto_judged` evidence) that scores a capture against an expected scene. It is a fast pre-check, not a replacement for a human/agent actually looking. |
| **evidence classes** | A ranked honesty scale for how a claim was checked, strongest first: **`device_verified`** (real PICO hardware — **none yet**, said honestly) > `vision_verified` (a human/agent LOOKED at a rendered frame) > `auto_judged` (the calibrated eye scored it) > `usd_host_render` (off-device USD preview) > `structural` (installs/launches/no-crash, no visual claim) > `built_for_headset` (compiles and targets Swan-only capability, deferred honestly). Every capability in [CAPABILITIES.md](CAPABILITIES.md) is tagged with its strongest evidence on file. |
| **doors** (`PICO_MCP_SURFACE=doors`) | An intent-level facade of 13 tools (12 doors + `validate_toolchain`) over the full ~214-tool surface — one door per developer intent (`pico_build_app`, `pico_look`, `pico_doctor`, …), each returning a `fix` field on failure. Recommended for a first session; the full surface stays available either way. |
| **gates** | The deterministic test-battery (`test/*.mjs`, mirrored in `.github/workflows/gates.yml`) that runs before every commit: lint fixtures, the ledger's over-claim rejection, doors-surface contract tests, occupancy/affordance solvers, the vault symbol checker, and more. All green is the bar for "this didn't regress." |

## 15-minute first light

The fastest way in is the doors surface: `pico_doctor` → `pico_build_app` (two-step: brief → scaffold you author against → build) → `pico_look` (and actually look at the capture). This exact sequence was timed end-to-end on 2026-07-21 at ~10 minutes (including two first-run toolchain-fix detours you won't hit), cold clone, emulator pre-started as a documented pre-condition — see **[QUICKSTART.md](QUICKSTART.md)** for the walkthrough, the exact commands, and the two first-run gotchas (macOS Accessibility, calibration-after-restart) inline where they bite.

## Verify YOUR apk in 5 minutes

`verify_pico_apk` is a cross-builder handoff contract: point it at **any** PICO APK — including one you didn't build with this toolchain — and it installs, launches, asserts no crash, and captures a frame for you to look at.

```json
{
  "tool": "verify_pico_apk",
  "arguments": {
    "apkPath": "/absolute/path/to/your-sample.apk",
    "packageName": "com.yourorg.yourapp"
  }
}
```

(`activity`, `expectLogcatContains`, and `settleSec` are optional overrides — see the tool description for defaults.) On the doors surface this is `pico_verify_app`. The evidence is honestly scoped: install + launch + process-alive + logcat scan is `structural`; once you've looked at the returned capture and called `record_verification`, that specific claim becomes `vision_verified`. Immersive/OpenXR compositing, controller-ray input, and head-tracked depth stay `built_for_headset` on this emulator — they need real Swan hardware.

## What it can do

**Two compile lanes, fused.**

- **Native Spatial SDK** (Kotlin / Filament): real rigid-body physics, clickable in-world menus, AAA fidelity (PBR, directional shadows, IBL metals, HDR emission, point lights), runtime animation, procedural set dressing, and **baked textured signage** — real text in-world the SDK can't draw at runtime.
- **Web** (the emulator's Chromium + WebView activities): live-DOM spatial panels, multi-panel workspaces, WebSpatial React apps, three.js / WebXR 3D scenes, and live-data monitors fed by real APIs.
- **Fused**: a web↔3D bridge (HTML buttons drive the native physics scene), a unified compiler that routes any brief to the right lane(s), and a one-command hybrid builder.

**Concept → shippable, end to end.** A brief becomes a scaffolded app → an authored scene → build & deploy → capture → fidelity score → iterate → a **signed release APK**, with a perf probe and an honest ship checklist along the way. Flagship demo: a playable neon bowling alley — set dressing, real-text marquee/scoreboard, and rigid-body pins — built entirely on the emulator.

**A verification loop as the crown jewel.** `capture_frame` + a look, the trust ledger (`record_verification` / `ledger_report`), a fidelity rubric, a deterministic multi-angle capture rig, a perf probe, and a **capability matrix** that reads the ledger into an honest report of what the tool can actually do and how it's known. A cross-builder contract (`verify_pico_apk`) lets a companion builder (e.g. a Unity MCP) hand over an APK for the same verify loop.

→ See **[CAPABILITIES.md](CAPABILITIES.md)** for the honest capability matrix — every category with its strongest evidence class.

## Honest limits (the emulator ceiling)

The PICO emulator renders bounded, eye-level content and floating spatial panels — **not** boundless walk-around immersion. Full-immersive OpenXR frame compositing, controller-ray input, and head-tracked depth are **PICO Swan hardware**: the tool builds for them and defers them honestly (`built-for-Swan`), then flips each row to device-verified when a headset is attached (`swan_verify_matrix`). WebSpatial spatial depth activates on **PICO OS 6** (the 2D projection is verifiable today). Programmatic head-pose driving is **gated** on this emulator build (GUI-only WASD, confirmed by pixel-diff probes) — `xr_input_status` reports the full map. Immersive 3D composites into the host GUI window only, so spatial scenes are verified via host-composited captures + the spatial runtime logcat, not display-0 screenshots. Physics simulates on the emulator; the companion Unity MCP handles the Unity XR build lane — see **[docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md)** for the honest Unity/OpenXR story (what verifies today, and the open compositing question we'd love PICO's read on).

## Requirements

- macOS with the PICO Spatial toolchain installed via the Android Studio **PICO Spatial Plugin** (payloads under `~/Library/PICO/sdk/<version>/`, license accepted).
- A PICO AVD created via Android Studio Device Manager (lives in `~/.pico/avd`).
- `adb` on PATH (or the toolchain's bundled platform-tools are used).
- Node.js ≥ 20.

Run `pico_doctor` (doors surface) or `preflight_env` (full surface) first on any machine — it's a read-only check that names the exact fix for anything missing.

## Install

**The server is host-agnostic stdio MCP** — it runs identically under Claude Code, OpenAI
Codex CLI (verified), Cursor, Windsurf, VS Code Copilot, Gemini CLI, or any MCP client: see
**[docs/HOSTS.md](docs/HOSTS.md)** for every host's registration snippet, and **[AGENTS.md](AGENTS.md)**
for the host-neutral agent contract (Codex reads it natively). One honest model requirement:
the LOOK step needs a vision-capable model — text-only models use the auto-judge and escalate.

**As a Claude Code plugin** — the repo is a self-contained plugin marketplace:

```bash
claude plugin marketplace add sushidoescode/PICO-MCP   # or a local clone path
claude plugin install pico-spatial-mcp@pico-mcp
```

First launch auto-installs dependencies and builds (one-time, ~1 min; progress on stderr). Works alongside PICO's official `pico-spatial-agentic-tools` plugin — theirs guides the agent with skills + SDK knowledge, this one is the build/verify/ship toolchain.

**Or as a plain MCP server:**

```bash
npm install && npm run build
claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

Or in any MCP client config:

```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/path/to/PICO-MCP/dist/index.js"] } } }
```

**Recommended for a first session — the doors surface** (13 tools instead of ~214):

```bash
PICO_MCP_SURFACE=doors claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

## How agents use it

The server ships built-in prompts that drive the loop — the dev workflow and the autonomous build (brief → scaffold → author → build & run → **the verify gate: structural checks + a frame you LOOK at** → diagnose → iterate → ship). Two representative loops:

- **Inner loop** (fast, scene-only): edit scene text → `iterate_scene` (pack + inspect + preview + capture) → adjust → repeat.
- **Full app loop**: `emulator_boot` → `build_and_run` (build + install + launch + crash-check + capture) → drive interactions → `check_crash` / `wait_for_log` → `record_verification` on a frame you looked at.

The tools span emulator control (lifecycle, adb, snapshots, gRPC), text-first scene authoring + `spatialbundle`/Gradle compilation, the native + web codegen lanes, and the verification/ship suite. `scaffold_spatial_app` is the "start any project" entry point; the built-in `pico_spatial_dev_loop` prompt carries the full agent guidance. See **[QUICKSTART.md](QUICKSTART.md)** to get going, **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** for repo orientation, and **[SKILLS.md](SKILLS.md)** for the agent reference.

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** — the front door, with the proven first-run sequence
- **[ROADMAP.md](ROADMAP.md)** — where this is going, every line gate-labeled honestly
- **[docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md)** — the Unity/OpenXR lane: SDK choice, the buildable-today verify loop, the open compositing question
- **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** — repo layout, gates, and standing invariants for anyone new to this codebase
- **[CAPABILITIES.md](CAPABILITIES.md)** — the honest capability matrix (categories + evidence)
- **[DESIGN.md](DESIGN.md)** — architecture + correctness rules (runtime physics, PICO math API, editor MaterialX, the visual-ground-truth rule)
- **[PLUGINS.md](PLUGINS.md)** — plugin surfaces · **[SKILLS.md](SKILLS.md)** — agent reference
- **[docs/](docs/)** — worked examples (a ClaimSight native build, local open-weight models, the decompiled spatial interaction API) and **[examples/](examples/)** — reference scenes

## Testing

```bash
npm run smoke        # toolchain/bundle/proto tools against the real local install (no emulator boot)
npm run test:lint    # the retained-lessons lint rules fire on their fixtures
npm run test:ledger  # the trust ledger rejects an unlinked vision_verified claim
```

The full gate battery — 17 gated suites of the 20 test files, deterministic, no emulator boot — is mirrored in `.github/workflows/gates.yml` — see **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** for the complete list.

## Licensing

- This project: **Apache-2.0** (see `LICENSE`).
- It **wraps your locally installed, license-accepted PICO toolchain** — it contains and redistributes **no** PICO or Google SDK binaries. It discovers and invokes your own installation only, gates on your existing license-acceptance markers, and loads the emulator's gRPC `.proto` definitions from your local install at runtime.
- Known limits of the underlying surface: per-controller 6DOF pose injection and skeletal hand-tracking injection are not exposed by the emulator (controllers are keyboard-mapped; hand-tracking is GUI/webcam-bound).
