# pico-spatial-mcp

An MCP server that lets AI agents build **PICO XR spatial apps end-to-end on the emulator** — from a natural-language brief to a running, verified, shippable native app, no headset required. It authors scenes as text, compiles them through the real `spatialbundle`/Gradle toolchain, builds and deploys APKs, drives the PICO OS 6 emulator (lifecycle, adb, snapshots, an experimental gRPC XR layer), and — crucially — **verifies its own work by capturing rendered frames and looking at them.** It is **MR-first**: apps default to the **Mixed stage** (stageStyle `1`) — the passthrough home environment IS the environment, and content seats ON the real room (detected floors, tables, walls). A fully-virtual Full-Space app (stageStyle `3`) remains a first-class, fully-supported opt-in.

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
7. **Simulate camera access from a scanned room** — `virtual_camera_frame`, `virtual_camera_surfaces`, and `virtual_camera_from_app` render what a world-model camera would see and report camera-visible support surfaces from its semantic model. Separately, the emulator camera-HAL is now proven end-to-end (v29.1, `vision_verified`): an injected changing card reaches a CameraX app's preview *inside* the emulator via `-camera-back webcam1` — a simulation of camera access, explicitly not VST/passthrough ([evidence and boundaries](docs/VIRTUAL_CAMERA.md)).
8. **Query PICO's broader knowledge graph** — `knowledge_api` keeps one persistent
   `pico-cli mcp spatial-knowledge` session and exposes `query_graph`, `get_node`,
   `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, and
   `switch_workspace`. Graph answers are contextual evidence; `vault_api` remains the authority
   for exact SDK declarations and file/line citations. `preflight_lint` consults the graph only
   when `knowledgeSecondOpinion` is explicitly supplied, and that advisory never changes `clean`.

It is designed to **complement** `pico-cli` and the `pico-spatial-agentic-tools` plugin, not compete: your tooling guides and scaffolds; this adds the verified build/verify/ship loop and the world-model layer. Install both side by side.

## Vocabulary primer

None of this is PICO Spatial SDK vocabulary — it's this project's own layer on top of it. Five terms carry most of the weight:

| Term | What it means |
|---|---|
| **trust ledger** | An append-only log (`record_verification` / `ledger_report`) of every visual claim this tool has made, each entry naming its evidence class. It structurally rejects a `vision_verified` claim with no linked capture — you can't fake the strongest tier. |
| **the eye** | The calibrated auto-judge (`visual_judge` / `auto_judged` evidence) that scores a capture against an expected scene. It is a fast pre-check, not a replacement for a human/agent actually looking. |
| **evidence classes** | A ranked honesty scale for how a claim was checked, strongest first: **`device_verified`** (real PICO hardware — **none yet**, said honestly) > `vision_verified` (a human/agent LOOKED and the intended content is present) > `auto_judged` (the calibrated eye scored it) > `usd_host_render` (off-device USD preview) > `structural` (runtime/log proof; successful appearance unconfirmed — a linked looked-at negative finding can stay here rather than masquerade as render success) > `built_for_headset` (compiles and targets Swan-only capability, deferred honestly). Every capability in [CAPABILITIES.md](CAPABILITIES.md) is tagged with its strongest evidence on file. |
| **doors** (`PICO_MCP_SURFACE=doors`) | An intent-level facade of 16 tools (15 doors + `validate_toolchain`) over the full surface (239 tools on macOS; 236 on other hosts) — one door per developer intent (`pico_build_app`, `pico_look`, `pico_doctor`, …), each returning a `fix` field on failure. Recommended for a first session; the full surface stays available either way. |
| **gates** | The deterministic test-battery (`test/*.mjs`, mirrored in `.github/workflows/gates.yml`) that runs before every commit: lint fixtures, the ledger's over-claim rejection, doors-surface contract tests, occupancy/affordance solvers, the vault symbol checker, and more. All green is the bar for "this didn't regress." |

## 15-minute first light

The fastest way in is the doors surface: `pico_doctor` → `pico_build_app` (two-step: brief → scaffold you author against → build) → `pico_look` (and actually look at the capture). The first-light brief is **Mixed-stage MR** — a primitive table standing on your real floor with bodies dropping onto it (the mrtable lane, proven through the unattended fleet pipeline on 2026-08-02). Expect `built-needs-look` for that count-only frame: on high-coverage passthrough captures, count/not-black/dominant-color checks are advisory and contribute zero confidence. A scene with at least two distinct authored colors can score through the color-key lane at the default 0.8 confidence threshold; otherwise it escalates. Either way, YOUR look is what earns `vision_verified`; `auto_judged` is honestly weaker. This exact sequence was timed end-to-end on 2026-07-21 at ~10 minutes (including two first-run toolchain-fix detours you won't hit), cold clone, emulator pre-started as a documented pre-condition — see **[QUICKSTART.md](QUICKSTART.md)** for the walkthrough, the exact commands, and the two first-run gotchas (macOS Accessibility, calibration-after-restart) inline where they bite.

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

(`activity`, `expectLogcatContains`, and `settleSec` are optional overrides — see the tool description for defaults.) On the doors surface this is `pico_verify_app`. The evidence is honestly scoped: install + launch + process-alive + logcat scan is `structural`; a looked-at capture supports only the claim its pixels actually prove. Visible app content can become `vision_verified`; a black frame does not vision-verify the app's intended content — and the rule inverts on a Mixed-stage (passthrough) frame: a rich, plausible home-env frame is not evidence the APP rendered anything, so judge "expected content present", never "not black". Also know the capture-path rule before judging one: `adb screencap` sees the shell composite (2D panels, native Spatial SDK apps, the home environment) and is structurally blind to XR-runtime output, so a black screencap of an immersive XR app is a capture-path artifact, not a failure. Capture immersive apps through the emulator window (`gui_capture`). That rule is how the July-22 Unity settling test's "uniformly black" conclusion was retracted (v30.1): captured through the window, both Unity routes render their full-immersive scenes on this emulator, `vision_verified`.

## What it can do

**The MR lane, first.** Mixed-stage apps are the default product: the passthrough home environment renders behind your content, simulated planes with semantics (FLOOR/TABLE/WALL…) are detected on an open Stage, and models seat on them through the measured chain (`measure_model` → `bake_textured_model` → `generate_surface_placement_kotlin`, or one-call `place_model_on_surface`) — proven end-to-end by the mrtable and rocketsim apps. Full Space (stageStyle `3`) is the explicit opt-in for fully-virtual scenes, nothing removed.

**Two compile lanes, fused.**

- **Native Spatial SDK** (Kotlin / Filament): real rigid-body physics, clickable in-world menus, AAA fidelity (PBR, directional shadows, IBL metals, HDR emission, point lights), runtime animation, procedural set dressing, and **baked textured signage** — real text in-world the SDK can't draw at runtime.
- **Web** (the emulator's Chromium + WebView activities): live-DOM spatial panels, multi-panel workspaces, WebSpatial React apps, three.js / WebXR 3D scenes, and live-data monitors fed by real APIs.
- **Fused**: a web↔3D bridge (HTML buttons drive the native physics scene), a unified compiler that routes any brief to the right lane(s), and a one-command hybrid builder.

**Concept → shippable, end to end.** A brief becomes a scaffolded app → an authored scene → build & deploy → capture → fidelity score → iterate → a **signed release APK**, with a perf probe and an honest ship checklist along the way. Flagship demo: a playable neon bowling alley — set dressing, real-text marquee/scoreboard, and rigid-body pins — built entirely on the emulator.

**A verification loop as the crown jewel.** `capture_frame` + a look, the trust ledger (`record_verification` / `ledger_report`), a fidelity rubric, a deterministic multi-angle capture rig, a perf probe, and a **capability matrix** that reads the ledger into an honest report of what the tool can actually do and how it's known. A cross-builder contract (`verify_pico_apk`) lets a companion builder (e.g. a Unity MCP) hand over an APK for the same verify loop.

→ See **[CAPABILITIES.md](CAPABILITIES.md)** for the honest capability matrix — every category with its strongest evidence class.

## Honest limits (the emulator ceiling)

The PICO emulator renders bounded, eye-level content, floating spatial panels, **the Mixed-stage MR lane** (the passthrough home environment plus simulated semantic planes an app's content seats on — the product default) — and, corrected in v30.1, **full-immersive Unity VR**. Two MR-specific honesty notes: on high-coverage passthrough frames the calibrated auto-judge gives count/not-black/dominant-color checks zero confidence; a scene with at least two authored colors can use the color-key lane (default threshold 0.8), while other frames escalate to a human LOOK. That machine verdict is `auto_judged`, never `vision_verified`. Full Space (stageStyle `3`) carries a **partner-stated** caveat: Full-Space immersive apps hit a known Guardian-boundary issue on hardware (per Matt/PICO, fix in progress — reported to us, not measured by us). The July-22 Unity settling test's uniformly black captures were an `adb screencap` artifact, not a compositing failure: screencap reads the shell composite and is structurally blind to XR-runtime output (Unity's own log said so — `Skip Present To Main Screen: Yes`). Captured through the emulator window (`gui_capture`), both Unity routes — the PICO Integration SDK (`PXR_Loader`) and the OpenXR SDK, via the unchanged sha-pinned July-22 APK — fill the view with their intended immersive scenes, `vision_verified`. The honest residue: the 2026-07-02 **native-NDK and WebXR** immersive probes reported a compositor loading fallback in the GUI viewport and were never re-run through the corrected capture path — their status is **OPEN**, not negative and not settled. **Controller-ray input and head-tracked depth** remain deferred to a **6.1 emulator or PICO Swan hardware**, and flip only after direct looked-at evidence (`swan_verify_matrix`). WebSpatial spatial depth activates on **PICO OS 6** (the 2D projection is verifiable today). Programmatic head-pose driving is **gated** on this emulator build (GUI-only WASD, confirmed by pixel-diff probes) — `xr_input_status` reports the full map. Physics simulates on the emulator; the Unity build lane is `unity_scaffold_project` + `unity_build_apk` — see **[docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md)** for the capture-path rule, the retraction, and the exact evidence.

## Requirements

- macOS with the PICO build toolchain installed via the Android Studio **PICO Spatial Plugin**
  (JDK/Android SDK/Gradle/PICO build payloads under `~/Library/PICO/sdk/<version>/`, license accepted).
- A PICO emulator bundle, downloaded/updated either by the Spatial Editor/plugin flow or with
  `pico-cli emulator install --source auto --yes`, plus a PICO AVD created separately in Android
  Studio Device Manager (lives in `~/.pico/avd`). The CLI command installs only the emulator bundle;
  it does not create an AVD and does not install the JDK, Android SDK, Gradle, or PICO build SDK.
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

The source checkout also carries host-native plugin layouts for Codex
(`.agents/plugins` + `.codex-plugin`), Cursor (`.cursor-plugin`), and GitHub Copilot
(`.github/plugin`). Their schemas, paths, metadata, and a cold Node-bootstrap launch from a hostile
spaces/non-ASCII path are structurally tested. They have not all been live-installed in those host
clients, so this is not a live-loading claim; use the absolute plain-MCP registration in
[docs/HOSTS.md](docs/HOSTS.md) if a host does not launch source plugins from the repository root.

**Or as a plain MCP server:**

```bash
npm install && npm run build
claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

Or in any MCP client config:

```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/path/to/PICO-MCP/dist/index.js"] } } }
```

**Recommended for a first session — the doors surface** (16 tools instead of 239 on macOS / 236 on other hosts):

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
- **[docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md)** — the Unity/OpenXR lane: SDK choice, the buildable-today verify loop, the capture-path rule, and the v30.1 immersive-rendering retraction
- **[docs/VIRTUAL_CAMERA.md](docs/VIRTUAL_CAMERA.md)** — simulated camera frames and surface detection from scanned rooms, plus the bounded emulator camera-HAL result
- **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** — repo layout, gates, and standing invariants for anyone new to this codebase
- **[CAPABILITIES.md](CAPABILITIES.md)** — the honest capability matrix (categories + evidence)
- **[docs/ANSWERED_BY_MEASUREMENT.md](docs/ANSWERED_BY_MEASUREMENT.md)** — six narrow ecosystem questions answered only to the limit of tracked evidence
- **[DESIGN.md](DESIGN.md)** — architecture + correctness rules (runtime physics, PICO math API, editor MaterialX, the visual-ground-truth rule)
- **[PLUGINS.md](PLUGINS.md)** — plugin surfaces · **[SKILLS.md](SKILLS.md)** — agent reference
- **[docs/](docs/)** — worked examples (a ClaimSight native build, local open-weight models, the decompiled spatial interaction API) and **[examples/](examples/)** — reference scenes

## Testing

```bash
npm run smoke        # toolchain/bundle/proto tools against the real local install (no emulator boot)
npm run test:lint    # the retained-lessons lint rules fire on their fixtures
npm run test:ledger  # the trust ledger rejects an unlinked vision_verified claim
```

The full gate battery — 43 gate invocations (42 `test:` suites plus `smoke`), across Linux and macOS jobs, deterministic, no emulator boot — is mirrored in `.github/workflows/gates.yml` — see **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** for the complete list.

## Licensing

- This project: **Apache-2.0** (see `LICENSE`).
- It **wraps your locally installed, license-accepted PICO toolchain** — it contains and redistributes **no** PICO or Google SDK binaries. It discovers and invokes your own installation only, gates on your existing license-acceptance markers, and loads the emulator's gRPC `.proto` definitions from your local install at runtime.
- Known limits of the underlying surface: per-controller 6DOF pose injection and skeletal hand-tracking injection are not exposed by the emulator (controllers are keyboard-mapped; hand-tracking is GUI/webcam-bound).
