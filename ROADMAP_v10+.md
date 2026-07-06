# 🗺️ ROADMAP v10+ — building the highest-caliber PICO MCP

**This document is the model-agnostic continuation plan.** It is written so ANY capable model
(Sonnet, Opus, Haiku, or a future session with no memory) can pick up the work mid-stream and
continue at full quality. Read the WORKING RULES first — they are what makes this project good.

---

## 0) WORKING RULES (non-negotiable — read before any phase)

1. **The honesty invariant (the soul):** "verified" means an agent or human LOOKED at a rendered
   frame. Never claim a visual works without a capture you inspected. Honest deferral
   (`structural`, `built-for-Swan`, "I tried X and it failed") is always acceptable; a silent
   over-claim is the only unforgivable failure. `record_verification` enforces this — use it.
2. **Small verified steps.** One capability → verify live on the emulator → ledger entry →
   commit → push. Never batch unverified work.
3. **Keep every gate green** before each commit:
   `npm run build && npm run smoke && npm run test:lint && npm run test:ledger && npm run test:eye && npm run test:assetgate && npm run test:worldenv`
   plus `regression_gate(mode='check')` when briefs/generators change (re-save the golden with
   `mode='save'` only after intentional corpus growth).
4. **Every gotcha becomes executable knowledge:** a fixture-backed lint rule (`record_lesson` /
   src/lint.ts), a `diagnose` symptom, or a memory/DESIGN.md entry. Never re-derive.
5. **The capture ground truth:** `adb exec-out screencap` (capture_frame / capture_canonical) IS
   the byte-deterministic composited immersive forward view. The GUI free-cam (gui_capture)
   DRIFTS (C2). Keep hero content at eye level (y≈1.3, z≈-2.7…-3.3) and plain-forward-capture.
   Panels spawn at the dock, OFF the forward view — sweep with `emulator_look` to see them
   (dark panels need a ~3% brightness threshold to find in a sweep).
6. **The physics rulebook (R1–R5, all verified):** create bodies with ALL components in ONE batch;
   never destroy+respawn live bodies; never destroy a physics-world root (poisons later worlds —
   reset = `enabled=false` + rebuild ~3s later); never teleport live bodies (jump/timestep becomes
   velocity) and kinematic flips are no-ops; no `CollisionDetectionMode.CONTINUOUS`; expect ~2s
   engine batch epochs (velocity fires next epoch; read-backs lag — trust frames).
   `diagnose(symptom=physics_not_simulating)` has the full entry.
7. **Key environment facts:** emulator-5554 via
   `~/Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb`; JAVA_HOME =
   `/Applications/Android Studio.app/Contents/jbr/Contents/Home`; test apps =
   `~/AndroidStudioProjects/showroomxr-native` (the bowling demo — DO NOT overwrite, it's the
   user's video demo) and `knockdownxr-native` (the pipeline-generated app — safe scratch).
   Scaffold new apps from `galleryxr-native`. Full-immersive OpenXR compositing is Swan-hardware
   only; live-text = a 2D panel ACTIVITY (an app's own WindowContainer never opens on the
   emulator). Session memory lives at
   `~/.claude/projects/-Users-sushantsrikrish-PICO-MCP/memory/` (MEMORY.md is the index).
8. **The acceptance-loop pattern** (use for every new capability):
   emit via the MCP (node scratch script → `dist/index.js` stdio client) → write files → gradle
   `assembleDebug` → install → launch → settle ~10s → `capture` → **LOOK** → drive (broadcast) →
   capture → LOOK → `record_verification` → gates → commit.

---

## 1) PHASE MAP (ordered by value; each phase is independently landable)

### P1 — The cold dry-run (the usefulness acceptance test)   [HIGH VALUE, LOW RISK]
**Goal:** prove a FRESH agent (no session memory) turns a physics-game brief into a working app
using only the registered MCP tools + prompts.
**How:** register the MCP (`claude mcp add pico-spatial-mcp --scope user -- node
~/PICO-MCP/dist/index.js`), open a fresh `claude` session in an EMPTY directory, paste:
*"Build me a physics knockdown game for the PICO emulator: throw a ball at racked targets from a
clickable menu, with a live THROWS scoreboard. Build it, run it, and show me a captured frame
proving the strike."* Watch which tools it reaches for.
**DoD:** the fresh agent lands template→plan→compile→build→verified strike without human steering.
Every point where it stumbles = a routing defect → fix the tool description/prompt it should have
followed, then re-run. Record results in `DRY_RUN.md` (append a "cold run log" section).
**Why first:** this is the only test of the product as users experience it.

### P2 — Unattended fleet BUILD (the factory's real promise)   [HIGH VALUE, MEDIUM EFFORT]
**Goal:** `run_factory` gains an optional `buildTop: N` mode — actually scaffold/build/launch/
capture/auto_judge the N highest-value briefs end-to-end on the emulator, unattended.
**How:** compose existing tools (scaffold_spatial_app → execute the ledger like the v9.1/v9.2
live acceptances did → build_and_run → capture_canonical → visual_judge → ledger). Serialize
builds (one emulator). Store per-brief artifacts under `/tmp/pico-render/fleet/<brief>/`.
**DoD:** `run_factory({buildTop: 3})` produces 3 installed apps + auto_judged captures + a fleet
dashboard where `totalAutoJudgedInLedger ≥ 3`, unattended. Escalate any judge-fail to a LOOK.
**Files:** src/factory.ts (extend), reuse src/assemble.ts + deploy.ts. Keep the honesty split:
auto_judged ≠ vision_verified.

### P3 — Web-content panels (the biggest content unlock left)   [HIGH VALUE, LOW EFFORT]
**Goal:** ANY web content (dashboards, charts, docs, video) as a floating spatial panel — a
`WebPanelActivity` (WebView) in the proven 2D-panel-activity path.
**How:** extend `generate_panel_compose_kotlin` (or a sibling `generate_web_panel_kotlin`) to emit
a WebView activity (manifest entry + INTERNET permission note + a `panel:url=<...>` DEBUG_CMD).
Spike it on knockdownxr first: hand-add the activity, load a live page, sweep, LOOK.
**DoD:** a capture showing real web content rendered in-world; then the generator + AppSpec
`panels[].kind='web'` + compiler/wiring plumbing; suite still 15/15.
**Risk:** WebView in the panel task may need hardware-acceleration flags; INTERNET permission.

### P4 — Richer procedural props (visual depth beyond primitives)   [MEDIUM VALUE]
**Goal:** real silhouettes — bowling pins (lathe profile), bottles, arches — as baked USD/bundle
props the pipeline can place, replacing capsules where the brief implies a real object.
**How:** extend src/procedural.ts (v7.0 already generates procedural USD props behind the
structural gate) with a lathe/revolve generator; bake via the existing bake path; verify via
render_usd_offscreen (seconds) then live capture. Physics keeps the capsule COLLIDER (colliders
stay primitive — R-rules) while the MODEL becomes the lathe mesh.
**DoD:** the knockdown/bowling scene renders recognizable pins (LOOKED at), physics unchanged.

### P5 — Editor Add-Component palette (the open thread)   [MEDIUM VALUE, HIGH RISK]
**Goal:** make `emit_editor_components` components actually appear in the editor GUI.
**The known gap:** the palette is `componentList.json` INSIDE the signed bundle
(`Spatial Editor.app/Contents/MacOS/inspectorconfigs/`), not per-project.
**Spike order:** (a) back up the app; edit componentList.json in place; ad-hoc re-sign
(`codesign --force --deep -s - "Spatial Editor.app"`); launch; LOOK at Add Component.
(b) If Gatekeeper blocks, try `xattr -dr com.apple.quarantine` + re-sign. (c) If the palette
loads but the schema mismatches, iterate on the entry shape ({belongTo:'ThirdParty',
componentType:'PLUGIN', pkgName matching the .spatialEditorComponent packageName}).
**DoD:** GameStats visible in the Add Component dialog (screenshot LOOKED at) → then wrap as an
opt-in tool `install_editor_palette` (WARN: modifies the app bundle; keep a restore path).
**Honesty:** if (a)–(c) all fail, record the negative and close the thread as bundle-gated.

### P6 — Interaction depth   [MEDIUM VALUE]
- **Custom menu rows:** generate_game_menu_kotlin already takes {action,rowPx} — bake custom
  4-row panel textures (bake_textured_model of a labeled panel) so briefs get domain buttons
  ("THROW/RESET/NEXT/INFO"), not just start/pause/resume/reset. DoD: a custom-labeled menu
  vision-verified + mouse-bridge clickable.
- **Data-driven mouse bridge:** wire the v5.8 interactable registry into the bridge for arbitrary
  scenes (INTERACTABLES| logcat marker → clickable map).
- **Head-pose gaze emulation:** spike whether xr head-rotation RPCs now apply on 0.13.1+ (past
  finding: gated). If still gated, keep broadcast-gaze and close.

### P7 — CI + distribution (make it a product)   [MEDIUM VALUE, LOW RISK]
- GitHub Actions: run build + all 6 headless gates + `run_brief_suite` on every push (no emulator
  needed — these are exactly the deterministic tiers). DoD: a green badge on main.
- `npx`-able install + a QUICKSTART.md (the DRY_RUN.md one-liner front and center).
- Optional: publish to an MCP registry / npm when the user asks (outward-facing — ASK FIRST).

### P8 — Swan hardware day-one (standing, blocked on hardware)
When a PICO Swan attaches over USB: `swan_verify_matrix` drives every C1–C4 row → flips
built-for-Swan → device-verified via deploy_to_device + captures. The bowling/knockdown apps and
the OpenXR native app (`~/AndroidStudioProjects/pico-openxr-env`) are the day-one test content.

---

## 2) STANDING BACKLOG (pick up opportunistically)
- Skeletal animation (deferred since v4.5) — editor-authored clips on baked models.
- Spatial audio playback verification — test whether emulator host audio carries ObjectAudio.
- text_to_3d (v7.0, flagged) — deepen with a real hosted API when a key is provided.
- ✅ Multi-scene + physics: SceneRouter.registerPhysics(id, builder) — go() disables (R3-safe) instead of destroying; SDK compile-verified.
- MEMORY.md hygiene: keep the index under ~24KB (one-liners; details in topic files).

## 3) HOW TO HAND OFF MID-PHASE
Commit whatever is verified with an honest message ("P3 spike: WebView renders, generator not yet
written"). Update this file's phase status line. Leave the emulator with showroomxr (bowling)
installed and untouched. If a capture was LOOKED at, its ledger entry must exist before the commit.

**Phase status (update on every landing):**
- P1 cold dry-run: ✅ RUN + SUCCESS (2026-07-06, a fresh Sonnet agent, zero context: template→plan→compile→build→verified strike + live scoreboard; 6 stumbles logged in DRY_RUN.md, each fixed — incl. the new diagnose launch_blocked symptom)
- P2 fleet build: ✅ SHIPPED + FIRST UNATTENDED RUN (fleet_build: 3/3 briefs scaffolded+built+installed unattended; studio auto_judged PASS conf 1.0; console ESCALATE→human LOOK confirmed content; knockdown ESCALATE correctly caught a not-foreground capture after a launch_blocked recovery — the guard fired twice and auto-recovered; post-recovery settle + foreground check added)
- P3 web panels: ✅ SHIPPED (vision-verified: a WebView spatial panel with a LIVE JS DOM — a setInterval counter ticked 42→130 in-world; generate_panel_compose_kotlin kind='web' + AppSpec panels[].kind='web' + compiler route; suite 15/15)
- P4 lathe props: ✅ GENERATOR SHIPPED + HOST-RENDER LOOKED (pin/bottle lathe silhouettes; usd_host_render recorded). Remaining nicety: live device swap into the bowling scene.
- P5 editor palette: ✅ SOLVED (v10.9, user-authorized): install_editor_palette appends a ThirdParty/PLUGIN entry to the bundle's componentList.json + ad-hoc re-signs — GameStats appears in the Add Component dialog (vision-verified). Opt-in with a full .BACKUP restore. Editor custom components are now end-to-end (schema + palette).
- P6 interaction depth: ✅ SHIPPED (a: bake_menu_panel — custom-labeled menus, vision-verified in-world with working rows + bridge-compatible colors; c: head-pose spike CLOSED honestly — events accepted, view unchanged, MAE 0: still GUI-gated, broadcast-gaze remains the path). Remaining nicety: (b) registry-driven mouse bridge for arbitrary scenes.
- P7 CI/distribution: ✅ CI + QUICKSTART SHIPPED (gates.yml green on main: build + smoke [SMOKE_SDK_OPTIONAL] + lint/ledger/eye/assetgate/worldenv; eye calibration skips on IM builds that can't measure — strict locally). Remaining: QUICKSTART front-matter + optional registry publish (ASK THE USER first).
- P8 Swan: PARTIALLY CHARACTERIZED — WebXR session+pose layer works headlessly (v10.10); immersive FRAME compositing + WebSpatial spatial activation await OS6/Swan hardware.
- P9 web workspace: ✅ SHIPPED (generate_web_workspace: N named WebView panels, each own task/spatial container, driven by-name via PANEL_CMD; list_spatial_panels reads the on-stage map. Proven: 3 panels live -> close:chart destroyed that container -> count dropped to 2. Gotcha: manifest receiver needs -p targeting. Visual note: shell ghosts non-focused stacked panels; single-panel solid render already vision-verified v10.10.)
- P10 WebSpatial: ✅ SHIPPED (generate_webspatial_app: real React+@webspatial/react-sdk project + a 2D-projection preview.html; the projection is vision-verified via headless Chrome (Ops Console, 3 depth panels); spatial depth = new built_for_os6 evidence class).
- Unity: DECISION MADE — build in the Unity MCP; add verify_pico_apk here as the shared deploy/verify contract (backlog)

**The workspace frame (v10.8):** /tmp/pico-render/ws-0.png — four surfaces in one composited view (game + custom menu + live HUD + live-DOM web panel), vision-verified. The stack in a single capture.

---

## 4) THE WEB LANE (v10.10 — a second content path, verified)

The emulator's Chromium 138 (SpaceBrowser) is a full WebXR/WebGL2/WebGPU runtime, CDP-drivable
headlessly with NO APK build. Shipped: `drive_browser`, `webxr_probe` (both vision/structural
verified). This opens a phase ladder:

### P9 — Web workspace orchestration   [HIGH VALUE, LOW EFFORT]
- `generate_web_workspace` — N NAMED web-panel activities (extend panelcompose kind='web' to a
  parameterized class name per panel; own taskAffinity/singleTask/exported each) + a broadcast
  drive channel (`panel:url:<name>`, `panel:js:<name>`, `panel:open/close:<name>`).
- `list_spatial_panels` — parse `dumpsys window windows` SpaceWindowAttributes/containerId into a
  {package, task, containerId} map (know what panels are on stage).
- DoD: 3 named web panels co-present in one capture, each independently URL/JS-driven.

### P10 — WebSpatial compile target   [MEDIUM VALUE, FORWARD-LOOKING]
- `generate_webspatial_app` — AppSpec → a React + @webspatial/react-sdk project (enable-xr,
  --xr-back, initScene, xr_main_scene manifest), reusing the layout/data planners. It runs as a
  plain 2D website today (verify the 2D projection in host/desktop Chromium via the eye) and
  activates spatially on PICO OS 6 — a new evidence class `built_for_os6` (mirrors awaiting_swan).
- DoD: a generated WebSpatial app's 2D build auto_judged in a headless Chromium; spatial behavior
  deferred honestly to OS 6.

### P8 (refined) — Swan/OS6 day-one
WebXR immersive FRAME compositing + WebSpatial spatial activation are the OS6/Swan re-tests
(the session+pose layer already works headlessly — that half is characterized now).

## 5) THE UNITY QUESTION (architecture decision)

The user maintains a SEPARATE Unity MCP for building XR projects and asks whether PICO Swan
Unity-plugin VR support belongs here or there. **Recommendation: BUILD stays in the Unity MCP;
this MCP owns DEPLOY + VERIFY + the honesty ledger — the shared crown jewel.** Rationale:
- A Unity VR app renders via the immersive OpenXR compositor, which does NOT composite on this
  emulator (hardware-only — same gate as native immersive + WebXR frames). So a Unity XR app
  cannot be VISUALLY verified on the emulator regardless of which tool builds it. Building it here
  would duplicate Unity tooling for zero added verifiability.
- What this MCP uniquely has: capture_frame + the calibrated eye + the trust ledger +
  deploy_to_device + swan_verify_matrix (the parity path). That's the reusable asset.
- Clean seam: expose a thin `verify_pico_apk(apkPath, packageName, expectations)` here — install +
  launch + structural assert on the emulator (does it boot/not-crash/log-XR-init) + record the
  honest matrix (structural on emulator, device-verified on Swan). The Unity MCP builds the APK
  and hands it to this contract. One verification loop, two builders.
- So: do NOT bake Unity BUILD into pico-spatial-mcp. DO (later) add `verify_pico_apk` as the shared
  deploy/verify contract both tools call. (Backlog — build when the Unity MCP can emit an APK.)

**P11 web↔3D bridge SHIPPED (v10.13):** generate_web_bridge_kotlin — an HTML control panel (WebView + addJavascriptInterface Native.send) routes web-button clicks to the native scene dispatchDebugCommand. Vision-verified: BOWL CONTROL panel in-world + its THROW button drove the physics scene (log chain).

**P12 unified compiler SHIPPED (v10.14):** compile_spatial_experience — the front door. A brief routes to native/web/hybrid with an ordered plan across the whole toolkit + honesty classes. Verified: bowling->native, dashboard->web, game+controls->hybrid, three.js->web (all correct).

**P13 live-data spatial SHIPPED (v10.15):** generate_live_data_panel — a floating panel polls a JSON URL and updates live. Verified via CDP DOM read: changed served data on disk -> panel displayed the new values within the poll interval (21C/NOMINAL -> 88C/CRITICAL).

**P14 web-3D SHIPPED (v10.16):** generate_web3d_scene — three.js scenes (orbit/grid/torusfield, PBR+lighting+animation+OrbitControls+Enter-VR) in the emulator Chromium. Vision-verified: a GALAXY orrery (glowing sun + 6 orbiting PBR spheres on tilted rings) renders + runs live in-emulator (canvas+gl+ready). three.js co-served (no runtime CDN). BONUS: P13 upgraded to vision-verified (LIVE METRICS panel seen solid in-world).

**P15 capability matrix SHIPPED (v10.17):** capability_matrix — reads the whole trust ledger into an honest matrix (14 categories, all vision_verified, 21 apps, 40 looked-at captures). Generated CAPABILITIES.md. THE FULL P10-P15 ARC IS COMPLETE.

---

## 6) v11 ARC — depth, autonomy, real-world (P16-P20)

### P16 — interactive web-3D  ✅ SHIPPED (v10.18)
generate_web3d_scene gains interactivity: raycast pointer selection (click -> highlight + label),
a window.Scene3D {select(i), data(values), count, selected} JS API, #select=N deep-link. Vision-
verified: select(2) enlarged + labeled EARTH in the SOLAR orrery.

### P17 — build_hybrid_experience  ✅ SHIPPED (v10.19)
One command executes what compile_spatial_experience PLANS: from a brief, scaffold a native 3D
scene + a web control panel (bridge) + a web info/HUD panel, build/install/launch unattended,
open all surfaces, capture the composited workspace. DoD: a brief -> a running hybrid app +
a workspace capture, unattended.

### P18 — real-world data connectors  ✅ SHIPPED (v10.20)
connect_data_source: bind a REAL external API (weather / github / a system feed) to a live panel
(P13) or a data-driven 3D scene (Scene3D.data). DoD: real API values render live in a spatial panel.

### P19 — cross-lane experience templates
A library of COMPLETE buildable experiences composing multiple capabilities: 'spatial dashboard'
(web workspace + live data), 'physics arcade' (native game + menu + scoreboard), 'product
configurator' (interactive web-3D + control panel), 'data command deck' (3D viz + live panels).

### P20 — the ship path
Package + deploy + an honest ship checklist: APK build/sign for native; a hostable PWA bundle
(manifest + service worker) for web/WebSpatial; the checklist names what's verified vs
Swan/OS6-deferred.

**v11 status:** P16-P18 shipped; P19-P20 next. P17 vision-verified: build_hybrid_experience({appName:"BowlDeck"}) -> a complete hybrid app (physics scene + THROW/RESET web control panel composited) built + launched unattended.
