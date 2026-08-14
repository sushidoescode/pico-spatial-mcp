# pico-spatial-mcp

An MCP server that lets AI agents build **PICO XR spatial apps end-to-end on the emulator** — from a natural-language brief to a running native app and an evidence-scoped readiness report, no headset required. It authors scenes as text, compiles them through the real `spatialbundle`/Gradle toolchain, builds and deploys APKs, drives the PICO OS 6 emulator (lifecycle, adb, snapshots, an experimental gRPC XR layer), and — crucially — **verifies visual claims only after a rendered frame is captured and looked at.** The current ship checklist fails closed because no digest-bound receipt yet ties current APK/web bytes to build, install/deploy, session, and looked-frame evidence; it does not claim production readiness from file existence. It is **MR-first**: apps default to the **Mixed stage** (stageStyle `1`) — the passthrough home environment IS the environment, and content seats ON the real room (detected floors, tables, walls). A fully-virtual Full-Space app (stageStyle `3`) remains a first-class, fully-supported opt-in.

> ### The honesty invariant
> "Verified" means an agent or human **looked at a rendered frame** — never a compile, a log line, or a pixel heuristic. Every visual claim is recorded in a trust ledger that *structurally rejects* a `vision_verified` entry without a linked, looked-at capture. New image-grounded writes snapshot those bytes into content-addressed storage, and readers re-hash linked evidence; missing or changed proof is reported as `provenance-broken`, never as verified. Honest deferral (`structural`, `built-for-Swan`, "I tried X and it failed") is always acceptable; a silent over-claim is the only unforgivable failure.

## Install in two minutes

The server is **plain stdio MCP** — it works in any MCP-capable host; the plugin marketplaces are
per-host conveniences on top of the same engine. While this repo is invite-only, every path below
requires your GitHub access.

**Claude Code** (plugin marketplace):

```bash
claude plugin marketplace add sushidoescode/pico-spatial-mcp
claude plugin install pico-spatial-mcp@pico-mcp
```

**OpenAI Codex CLI**:

```bash
git clone https://github.com/sushidoescode/pico-spatial-mcp ~/PICO-MCP
cd ~/PICO-MCP && npm ci && npm run build
codex mcp add pico-spatial --env PICO_MCP_SURFACE=doors -- node "$HOME/PICO-MCP/dist/index.js"
```

**Any other MCP host** (Cursor, Windsurf, VS Code Copilot, Gemini CLI, …) — register the same
stdio command; substitute your absolute clone path:

```json
{ "mcpServers": { "pico-spatial": {
    "command": "node", "args": ["/abs/path/PICO-MCP/dist/index.js"],
    "env": { "PICO_MCP_SURFACE": "doors" } } } }
```

Per-host detail and per-host verification status: [docs/HOSTS.md](docs/HOSTS.md). First call:
`pico_doctor {}` — read-only, names the exact fix for anything missing; the explicit
`{calibrate:true}` workflow is the mutating exception described below. No PICO SDK or emulator yet?
The doctor, SDK-knowledge, codegen, and lint lanes work on any machine.

> **AI agents landing in this repo:** read [AGENTS.md](AGENTS.md) first — the machine-oriented
> contract for driving this server (registration, surfaces, and the honesty rule).

## Managed pico-cli policy

<!-- pico-mcp-managed-cli-policy:start -->
`managed-latest` is the default. Resolution is lazy on the first real CLI-backed operation.
Server startup, tool registration and `tools/list`, `preflight_env`, and the default
`pico_doctor {}` inspect only an existing cache: they make no npm request, provision nothing, and
write nothing to the managed store. The explicit `pico_doctor {calibrate:true}` exception is
mutating because it runs the separately documented calibration workflow.

Each exact version is published as an immutable MCP-owned cache entry. The ambient global CLI and
`PATH` remain untouched. A successful registry lookup reports registry-latest as of `checkedAt`.
If that lookup fails, a validated cached fallback is labeled `unknown`; if a known-newer install
fails, it is labeled `outdated`. Neither fallback is ever called latest.

Set `PICO_MCP_CLI_POLICY` only when the default is not appropriate:

- `managed-latest` — lazily resolve and, on first CLI use, provision the exact registry version.
- `managed-cached` — use only a validated cached version, without registry or install work.
- `external` — run only the absolute `PICO_MCP_CLI_PATH`; it is never updated by the MCP.
- `disabled` — turn off CLI-backed operations.

Through 37.x, the deprecated aliases `PICO_MCP_AUTOINSTALL_CLI=1` and
`PICO_MCP_AUTOUPDATE_CLI=1` map to `managed-latest`; they never install globally and conflict with
another explicit policy. `ensure_pico_cli` is the force-refresh health path. Its deprecated
`update` input is inert and accepted only for compatibility.

Package activation and utility setup are separate. Call `ensure_pico_cli`, then manually run its
returned absolute path with args `["setup"]` if the CLI reports an unprovisioned utility payload.
The MCP never runs setup. It also never runs `update --check`, because that command writes a local
update cache; freshness comes from the registry lookup instead.

`0.4.2` was registry latest on 2026-08-14, an observed value rather than a timeless pin. A v1.0
date supplied by the user/PICO team is planning input, not repository-verified release evidence.
The compatibility sweep is version-agnostic and covers the complete reachable advertised
help-only tree except the prohibited top-level setup subtree. It does not establish semantic
compatibility, hidden-alias longevity, perf provisioning, emulator/device/Windows behavior, or
visual evidence.
<!-- pico-mcp-managed-cli-policy:end -->

## What you can use this for, today

Concrete jobs this tool does on a stock PICO OS 6 emulator install, each backed by ledger evidence you can audit:

1. **Verify any PICO APK you already have** — your own samples, pico-cli-scaffolded apps, Unity-built APKs. `verify_pico_apk` installs, launches, crash-checks, and captures a frame; the trust ledger records exactly how much was proven ([5-minute walkthrough below](#verify-your-apk-in-5-minutes)).
2. **Build demo and test apps from one-sentence briefs** — physics games, menu-driven scenes, live-data panels, hybrid web+3D apps — through the full `spatialbundle`/Gradle toolchain, unattended in batches (`fleet_build`). The result separates an eye verdict from whether the corresponding ledger write actually succeeded.
3. **Score a toolchain with SpatialBench** — the 6-axis conformance harness (`run_spatialbench`) runs any brief corpus through plan → compile → boot → capture → judge and emits a scored report; it works on apps OUR pipeline didn't build.
4. **World-model tooling for real scans** — a Gaussian-splat scan becomes a labeled semantic scene (OWL-v2), briefs anchor content to labeled real-world surfaces (`anchorTo`), free-space solving avoids even unlabeled geometry (occupancy grid), and placements come back with **measured error in centimeters** via the calibrated capture camera.
5. **Talk to a RUNNING app** — the live agent bridge spawns/moves/removes entities in a running spatial app, with mutations checked structurally by scene diff.
6. **Environment doctoring** — default `pico_doctor {}` is a read-only preflight where every failing check carries the exact fix; `pico_doctor {calibrate:true}` is the explicit mutating calibration exception. It's how we caught (and report upstream) real toolchain issues.
7. **Simulate camera access from a scanned room** — `virtual_camera_frame`, `virtual_camera_surfaces`, and `virtual_camera_from_app` render what a world-model camera would see and report camera-visible support surfaces from its semantic model. Separately, the emulator camera-HAL is now proven end-to-end (v29.1, `vision_verified`): an injected changing card reaches a CameraX app's preview *inside* the emulator via `-camera-back webcam1` — a simulation of camera access, explicitly not VST/passthrough ([evidence and boundaries](docs/VIRTUAL_CAMERA.md)).
8. **Query PICO's broader knowledge graph** — `knowledge_api` keeps one persistent
   `pico-cli mcp dev-knowledge` session and exposes `query_graph`, `get_node`,
   `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, and
   `switch_workspace`. Graph answers are contextual evidence; `vault_api` remains the authority
   for exact SDK declarations and file/line citations. `preflight_lint` consults the graph only
   when `knowledgeSecondOpinion` is explicitly supplied, and that advisory never changes `clean`.

It is designed to **complement** `pico-cli` and the `pico-spatial-agentic-tools` plugin, not compete: your tooling guides and scaffolds; this adds the evidence-scoped build/verify/handoff loop and the world-model layer. Install both side by side.

## Vocabulary primer

None of this is PICO Spatial SDK vocabulary — it's this project's own layer on top of it. Five terms carry most of the weight:

| Term | What it means |
|---|---|
| **trust ledger** | An append-only log (`record_verification` / `ledger_report`) of every visual claim this tool has made. New image-evidence writes are copied to a hash-addressed store, and linked evidence is revalidated on read; absent or changed bytes become `provenance-broken`. `device_verified` additionally requires a live non-emulator PICO identity probe and byte equality with a fresh screencap from that same serial. |
| **the eye** | The calibrated auto-judge (`visual_judge` / `auto_judged` evidence) that scores a capture against an expected scene. It is a fast pre-check, not a replacement for a human/agent actually looking. |
| **evidence classes** | Strongest first: **`device_verified`** (LOOKED frame + live PICO identity + exact same-serial screencap match; **none from real hardware yet**) > `vision_verified` (a human/agent LOOKED and intended content is present) > `auto_judged` > `usd_host_render` > `structural` > `built_for_headset`. `auto_judged` and `usd_host_render` can be minted only by their measured producer tools, with a receipt bound to the stored artifact; caller-authored or legacy rows without that receipt read as `structural`. Legacy device rows missing the new lineage read as `vision_verified` at most, if their image provenance is otherwise intact. |
| **doors** (`PICO_MCP_SURFACE=doors`, and the default when the variable is unset since v36.3) | An intent-level facade of 18 tools (16 intent doors + `validate_toolchain` + `ensure_pico_cli`) over the full surface (249 tools on macOS and 246 on Linux are runtime-measured; on Windows, the published 246-tool count is source-derived because no native Windows `tools/list` measurement has run — the `PICO_MCP_SURFACE=full` opt-in) — one door per developer intent (`pico_build_app`, `pico_look`, `pico_doctor`, …), each returning a `fix` field on failure. Recommended for a first session; the full surface stays available either way. |
| **gates** | The deterministic test battery (`test/*.mjs`, mirrored in `.github/workflows/gates.yml`) maintainers are required to run before claiming a change is green: lint fixtures, the ledger's over-claim rejection, doors-surface contract tests, occupancy/affordance solvers, the vault symbol checker, and more. The aggregate result—not merely starting the runner—is the evidence. |

## 15-minute first light

The fastest way in is the doors surface: `pico_doctor` → `pico_build_app` (two-step: brief → scaffold you author against → build) → `pico_look` (and actually look at the capture). The first-light brief is **Mixed-stage MR** — a primitive table standing on your real floor with bodies dropping onto it (the mrtable lane was structurally exercised through the unattended fleet pipeline on 2026-08-02; consult the current ledger report for its visual-evidence status). Expect `built-needs-look` for that count-only frame: on high-coverage passthrough captures, count/not-black/dominant-color checks are advisory and contribute zero confidence. A scene with at least two distinct authored colors can score through the color-key lane at the default 0.8 confidence threshold; otherwise it escalates. Either way, YOUR look is what earns `vision_verified`; `auto_judged` is honestly weaker. This exact sequence was timed end-to-end on 2026-07-21 at ~10 minutes (including two first-run toolchain-fix detours fixed on the measured revision), cold clone, emulator pre-started as a documented pre-condition — see **[QUICKSTART.md](QUICKSTART.md)** for the walkthrough, the exact commands, and the two first-run gotchas (macOS Accessibility, calibration-after-restart) inline where they bite.

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

(`activity`, `expectLogcatContains`, and `settleSec` are optional overrides — see the tool
description for defaults.) On the doors surface this is `pico_verify_app`. The evidence is honestly
scoped: install + launch + process-alive + logcat scan is `structural`; a looked-at capture supports
only the claim its pixels actually prove. Visible app content can become `vision_verified`; a black
frame does not vision-verify the app's intended content — and the rule inverts on a Mixed-stage
(passthrough) frame: a rich, plausible home-env frame is not evidence the APP rendered anything,
so judge “expected content present,” never merely “not black.” Historical emulator runs produced
black `adb screencap` frames while the host window showed XR-runtime content, but a later
same-moment OpenXR run did not reproduce that asymmetry. **A black adb frame is inconclusive:** it
can be a capture-path artifact or a real rendering failure. Use an alternate
capture path such as `gui_capture`, LOOK at it, and do not conclude either success or failure from
the black adb frame alone.

## What it can do

**The MR lane, first.** Mixed-stage apps are the default product: the passthrough home environment renders behind your content, simulated planes with semantics (FLOOR/TABLE/WALL…) are detected on an open Stage, and models seat on them through the measured chain (`measure_model` → `bake_textured_model` → `generate_surface_placement_kotlin`, or one-call `place_model_on_surface`). The mrtable and rocketsim apps exercised that chain structurally; their historical visual attestations do not substitute for an intact, revalidated capture today. Full Space (stageStyle `3`) is the explicit opt-in for fully-virtual scenes, nothing removed.

**Two compile lanes, fused.**

- **Native Spatial SDK** (Kotlin / Filament): real rigid-body physics, clickable in-world menus, AAA fidelity (PBR, directional shadows, IBL metals, HDR emission, point lights), runtime animation, procedural set dressing, and **baked textured signage** — real text in-world the SDK can't draw at runtime.
- **Web** (the emulator's Chromium + WebView activities): live-DOM spatial panels, multi-panel workspaces, WebSpatial React apps, three.js / WebXR 3D scenes, and live-data monitors fed by real APIs.
- **Fused**: a web↔3D bridge (HTML buttons drive the native physics scene), a unified compiler that routes any brief to the right lane(s), and a one-command hybrid builder.

**Concept → evidence-scoped handoff, end to end.** A brief becomes a scaffolded app → an authored scene → build & deploy → capture → fidelity score → iterate → an honest ship checklist. A release path is reported, but production readiness remains blocked until current bytes are digest-bound to successful build/install or deploy/session evidence and the looked-at frame. Flagship demo: a playable neon bowling alley — set dressing, real-text marquee/scoreboard, and rigid-body pins — built entirely on the emulator.

**A verification loop as the crown jewel.** `capture_frame` + a look, the trust ledger (`record_verification` / `ledger_report`), a fidelity rubric, a deterministic multi-angle capture rig, a perf probe, and a **capability matrix** that reads the ledger into an honest report of what the tool can actually do and how it's known. A cross-builder contract (`verify_pico_apk`) lets a companion builder (e.g. a Unity MCP) hand over an APK for the same verify loop.

→ See **[CAPABILITIES.md](CAPABILITIES.md)** for the honest capability matrix — every category with its strongest evidence class.

## Honest limits (the emulator ceiling)

The PICO emulator renders bounded, eye-level content, floating spatial panels, and **the Mixed-stage
MR lane** (the home environment plus simulated semantic planes an app's content seats on — the
product default). Two MR-specific honesty notes: on high-coverage passthrough frames the calibrated
auto-judge gives count/not-black/dominant-color checks zero confidence; a scene with at least two
authored colors can use the color-key lane (default threshold 0.8), while other frames escalate to
a human LOOK. That machine verdict is `auto_judged`, never `vision_verified`. Full Space
(`stageStyle 3`) carries a **partner-stated** caveat: Full-Space immersive apps hit a known
Guardian-boundary issue on hardware (per PICO, fix in progress — reported to us, not measured by
us). **Partner-reported workaround (Fabian, 2026-08-12, emulator 6.0.0 + Spatial SDK 6.0.0, an
editor-authored museum world):** the dynamic Full-stage route walked out, while the same world in a
manifest-declared `DefaultStage` with `pico.spatial.stage.style=1` stayed visible during extended
WASD movement. This machine has not replicated that editor-world comparison, and the hardware
route still requires Safeguard validation. Historical host-window looks recorded full-immersive
Unity output, but their retained pixel provenance is not uniformly intact today; consult the
current generated claims snapshot rather than treating that history as current proof. Black adb
captures are inconclusive and require an alternate capture path plus a LOOK. The 2026-07-02
**native-NDK and WebXR** immersive probes remain **OPEN**, not negative or settled. **Controller-ray
input and head-tracked depth** remain deferred to a **6.1 emulator or PICO Swan hardware**, and
flip only after direct looked-at evidence (`swan_verify_matrix`). WebSpatial spatial depth activates
on **PICO OS 6**. Programmatic head-pose driving is gated on this emulator build; `xr_input_status`
reports the current map. Physics simulates on the emulator; the Unity build lane is
`unity_scaffold_project` + `unity_build_apk` — see
**[docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md)** for the dated measurements and evidence limits.

## Requirements

- macOS with the PICO build toolchain installed via the Android Studio **PICO Spatial Plugin**
  (JDK/Android SDK/Gradle/PICO build payloads under `~/Library/PICO/sdk/<version>/`, license accepted).
- A PICO emulator bundle, downloaded/updated either by the Spatial Editor/plugin flow or with
  `pico-cli emulator install --source auto --yes`, plus a PICO AVD created separately in Android
  Studio Device Manager (lives in `~/.pico/avd`). The CLI command installs only the emulator bundle;
  it does not create an AVD and does not install the JDK, Android SDK, Gradle, or PICO build SDK.
- `adb` on PATH (or the toolchain's bundled platform-tools are used).
- Node.js ≥ 20.

Run default `pico_doctor {}` (doors surface) or `preflight_env` (full surface) first on any machine — it is a read-only check that names the exact fix for anything missing. The explicit `pico_doctor {calibrate:true}` route mutates calibration state.

**Without the PICO SDK or emulator** the server still installs and runs: tool listing, `pico_doctor`,
SDK knowledge lookups (agent-vault), codegen/scaffolding, lint, and all documentation tools work
anywhere; build/run/capture lanes report exactly which payload is missing and how to get it.
macOS and Linux have runtime-measured full-surface counts of 249 and 246 respectively. The Windows
246 count is source-derived: no native Windows `tools/list` measurement has run. The native
host-GUI capture/input lane is macOS-only; a Windows/x64 emulator bundle is source-advertised but
has not been installed or booted by this repository, so Windows emulator control remains unmeasured.

## Install

**The server is host-agnostic stdio MCP.** Its absolute plain-MCP registration was historically
live-verified in Claude Code and OpenAI Codex CLI; Cursor, Windsurf, VS Code Copilot, Gemini CLI,
and other clients use their standard MCP configurations and are not all independently live-verified.
See **[docs/HOSTS.md](docs/HOSTS.md)** for every host's registration snippet, and
**[AGENTS.md](AGENTS.md)** for the host-neutral agent contract (Codex reads it natively). One honest
model requirement: the LOOK step needs a vision-capable model — text-only models use the auto-judge
and escalate.

**As a Claude Code plugin** — the repo is a self-contained plugin marketplace:

```bash
claude plugin marketplace add sushidoescode/pico-spatial-mcp   # or a local clone path
claude plugin install pico-spatial-mcp@pico-mcp
```

The launcher auto-installs dependencies and builds when needed (one-time, ~1 min; progress on
stderr). Claude's dedicated `${CLAUDE_PLUGIN_ROOT}` manifest invocation is cold-started as a real
MCP process from an unrelated working directory in the executable distribution suite. That proves
the launcher contract, not a post-change live install in Claude Code; an earlier revision's Claude
plugin route and the absolute plain-MCP Claude/Codex registrations were live-verified. It works
alongside PICO's official `pico-spatial-agentic-tools` plugin — theirs guides the agent with skills
+ SDK knowledge, this one is the build/verify/ship toolchain.

The source checkout also carries a portable Agent Plugins core (`plugin.json` + `mcp.json`) for
Codex and Copilot, host presentation/marketplace overlays (`.agents/plugins`, `.codex-plugin`, and
`.github/plugin`), and a Cursor-specific payload (`.cursor-plugin` + `mcp.cursor.json`). The
portable core uses `${PLUGIN_ROOT}`; Claude uses its documented `${CLAUDE_PLUGIN_ROOT}` contract in
a separate MCP config. Both tokenized launcher forms are process-tested from a hostile
spaces/non-ASCII working directory. Cursor's `${CURSOR_PLUGIN_ROOT}` declaration gets the same
test-side launcher smoke, but remains structural until a current Cursor client expands it and
connects the tools live.
The current host-native layouts have not been live-installed after this launcher change, so this is
not a live-loading claim; use the absolute plain-MCP registration in
[docs/HOSTS.md](docs/HOSTS.md) where the host-native route is not yet proven.

**Or as a plain MCP server:**

```bash
npm install && npm run build
claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

Or in any MCP client config:

```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/path/to/PICO-MCP/dist/index.js"] } } }
```

**Recommended for a first session — the doors surface** (18 tools instead of 249 on macOS and 246
on Linux, both runtime-measured; on Windows, the published 246-tool count is source-derived because
no native Windows `tools/list` measurement has run. Since v36.3 this is also the
default when `PICO_MCP_SURFACE` is unset, so the env below simply pins it —
`PICO_MCP_SURFACE=full` opts into everything):

```bash
PICO_MCP_SURFACE=doors claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

## How agents use it

The server ships built-in prompts that drive the loop — the dev workflow and the bounded autonomous build (brief → scaffold → author → build & run → **the verify gate: structural checks + a frame you LOOK at** → diagnose → apply a retained lesson when one exists, otherwise stop for manual repair → evidence-scoped ship checklist). Two representative loops:

- **Inner loop** (fast, scene-only): edit scene text → `iterate_scene` (pack + inspect + preview + capture) → adjust → repeat.
- **Full app loop**: `emulator_boot` → `build_and_run` (build + install + launch + crash-check + capture) → drive interactions → `check_crash` / `wait_for_log` → `record_verification` on a frame you looked at.

The tools span emulator control (lifecycle, adb, snapshots, gRPC), text-first scene authoring + `spatialbundle`/Gradle compilation, the native + web codegen lanes, and the verification/ship suite. `scaffold_spatial_app` is the "start any project" entry point; the built-in `pico_spatial_dev_loop` prompt carries the full agent guidance. See **[QUICKSTART.md](QUICKSTART.md)** to get going, **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** for repo orientation, and **[SKILLS.md](SKILLS.md)** for the agent reference.

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** — the front door, with the proven first-run sequence
- **[ROADMAP.md](ROADMAP.md)** — where this is going, every line gate-labeled honestly
- **[docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md)** — the Unity/OpenXR lane: SDK choice, dated capture-path measurements, and current evidence limits
- **[docs/VIRTUAL_CAMERA.md](docs/VIRTUAL_CAMERA.md)** — simulated camera frames and surface detection from scanned rooms, plus the bounded emulator camera-HAL result
- **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** — repo layout, gates, and standing invariants for anyone new to this codebase
- **[CAPABILITIES.md](CAPABILITIES.md)** — the honest capability matrix (categories + evidence)
- **[docs/ANSWERED_BY_MEASUREMENT.md](docs/ANSWERED_BY_MEASUREMENT.md)** — seven narrow ecosystem questions answered only to the limit of tracked evidence
- **[DESIGN.md](DESIGN.md)** — architecture + correctness rules (runtime physics, PICO math API, editor MaterialX, the visual-ground-truth rule)
- **[PLUGINS.md](PLUGINS.md)** — plugin surfaces · **[SKILLS.md](SKILLS.md)** — agent reference
- **[docs/](docs/)** — worked examples (a ClaimSight native build, local open-weight models, the decompiled spatial interaction API) and **[examples/](examples/)** — reference scenes

## Testing

```bash
npm run smoke        # toolchain/bundle/proto tools against the real local install (no emulator boot)
                     # no PICO SDK installed? prefix SMOKE_SDK_OPTIONAL=1 — SDK-dependent probes skip
npm run test:lint    # the retained-lessons lint rules fire on their fixtures
npm run test:ledger  # the trust ledger rejects an unlinked vision_verified claim
```

The full gate battery has 46 gate invocations (45 `test:` suites plus `smoke`). CI assigns 43 to
each Linux matrix run, one to native Windows (`test:picocli-win`), and two to native macOS (the
CMIO writer/reader suites). The Windows lane checks the smoke fixture's `.cmd`/`.bat` wrapper
selection but does **not** execute or claim a native `build_and_run` success path. All gates are
deterministic and boot no emulator — see **[docs/COLLABORATORS.md](docs/COLLABORATORS.md)** for the
complete list.

## Maintainer

Built and maintained by **Sushant Srikrishnan** ([@sushidoescode](https://github.com/sushidoescode)).
Bugs, feature requests, and feedback: [GitHub Issues](https://github.com/sushidoescode/pico-spatial-mcp/issues).

## Licensing

- This project: **Apache-2.0** (see `LICENSE`).
- It **wraps your locally installed, license-accepted PICO toolchain** — it contains and redistributes **no** PICO or Google SDK binaries. It discovers and invokes your own installation only, gates on your existing license-acceptance markers, and loads the emulator's gRPC `.proto` definitions from your local install at runtime.
- Known limits of the underlying surface: per-controller 6DOF pose injection and skeletal hand-tracking injection are not exposed by the emulator (controllers are keyboard-mapped; hand-tracking is GUI/webcam-bound).
