# HANDOFF — PICO-MCP, for the next chat

Read this WHOLE file, then the auto-memory (`…/memory/MEMORY.md` index + `game-menu-demo.md` +
`pico-mcp-project.md`), then `ROADMAP_v5.0-v6.0.md` (the authoritative plan) + `DESIGN.md`
(§1/§9/§10/§11/§12 are the load-bearing correctness rules).

---
## ▶ WHERE WE ARE (2026-07-01 — v4.10.0 SHIPPED: the in-world menu + Mac mouse bridge arc is complete)

**MCP @ `4.10.0`** (`package.json` + `src/index.ts` agree), **~104 distinct tools + 2 prompts**, `npm run smoke`
→ `Failures: 0`. **Git clean + fully pushed** — `HEAD == origin/main == 4bd71cc` ("v4.10.0: grid-snap placement
+ face-the-user tilt"), working tree empty, `main…origin/main` in sync. 49 `src/*.ts` modules (107 `registerTool`
names; the project rounds to "~104"). Node ≥20, TS/ESM. Build `tsc`; verify `npm run build && npm run smoke`.

**⚠ README is ONE ARC STALE** — its header still says "v4.7 / 106 tools". The code is v4.10. Fix the README header
when you next touch docs (low priority; the ROADMAP + this file are current).

**THE v4.6→v4.10 ARC (the most recent 8 commits) — an interactive in-world GAME MENU + a Mac MOUSE BRIDGE:**
- **`generate_game_menu_kotlin`** (`src/menu.ts`) — AAA in-world game menu: 3D pressable buttons (raised glassy
  caps that PLUNGE on press), hover-preview, color-matched flash, **grab-to-move around the room** with grid-snap
  + a gentle face-the-user tilt. One `select(action)` entry point, driven by a `DEBUG_CMD` broadcast on the
  emulator and by gaze/controller/pinch on a headset. **Vision-verified across all 4 demo apps** (orrery / gravity
  / showroom / portal).
- **`tools/mouse_menu_bridge.py`** + **`setup_mouse_bridge`/`install_bridge_launcher`** (`src/mousebridge.ts`) — a
  host-side **Quartz event-tap** that lets a real Mac mouse CLICK / HOVER / DRAG the in-world menu on the emulator.
  It maps screen → emulator-window → device framebuffer → nearest button (a **scene-color-robust 4-colour-bar-stack
  detector**), then fires the app's `DEBUG_CMD` channel. This is the answer to C3 (the emulator has no
  controller/gaze pointer). **Verified end-to-end**: a real `cliclick` on PAUSE → broadcast → the in-world
  highlight moved to PAUSE. `install_bridge_launcher` preloads one-click Android Studio run configs + Gradle tasks
  + a global `pico-bridge` command into every project (and `scaffold_spatial_app` auto-installs them).

The full journey (every gotcha) is in memory `game-menu-demo.md`. The ladder beneath: v3.x editor X-ray / Agent
Bridge / visual-verify suite → v4.0 the autonomous `autonomous_spatial_build` loop (brief-general, GalleryXR
acceptance demo vision-verified) → v4.5 the full SDK content ladder (lighting/IBL/particles/video/tween+orbit/
display+portal/rigidbody+anchor, all compile-verified vs SDK 0.13.3).

---
## ▶ HOW TO RUN + VERIFY IT

**The loop (an agent runs this):**
1. `validate_toolchain` — preflight the local PICO SDK (tools root, spatialbundle/emulator/adb, AVDs, license, protos).
2. `emulator_list` / `emulator_boot` — ensure a PICO OS6 emulator is up.
3. `scaffold_spatial_app` — clone the template, rename package/tree, set stage, install scene → a fresh
   immediately-buildable app (also preloads the bridge launcher).
4. Author content by emitting SDK-0.13.3 Kotlin via the `generate_*` codegen tools: environment → colliders →
   lighting/richness → UI/menu; inject `generate_agent_bridge` for headless control.
5. `build_and_run` — compile/install/relaunch, wait for `FirstFrameRelease`, check crash, auto-emit the
   `capability_report` matrix.
6. **THE `verify` GATE (mandatory pre-ship)** — structural `assert_scene` (Agent Bridge `dump_scene` + `assert_logcat`
   markers) + visual `verify_visual`/`capture_frame` that you **actually LOOK at**. Any FAIL → `diagnose(symptom=…)`
   → loop back to authoring.
7. SHIP — `generate_headset_readiness_codegen` + `swan_bring_up_checklist` + the honest `capability_report`;
   `deploy_to_device` stays dormant until a Swan is attached.

**The mouse bridge:** run the global **`pico-bridge`** command (installed per-project) or `setup_mouse_bridge`. It
auto-targets the FOREGROUND app, raises the (often-occluded) emulator window, and lets your Mac mouse click the
in-world menu. Run the Python with `-u` for live click logs (stdout is block-buffered when redirected). venv lives
at `~/.pico-bridge/venv`; needs macOS Input-Monitoring/Accessibility.

**Launch is FLAKY** — the stable pattern: **force-stop ALL other `com.example.*` spatial apps FIRST** (a prior app
owning the full-space stage makes yours exit immediately: `"current full space don't allow start fullscreen"` /
`VM exiting result code 0`), then `am force-stop; sleep 1.5; am start` OR
`adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1` wrapped in a 4-try retry polling `pidof`. The
first `am start` after `adb install -r` reliably tears the stage down. **A failed build silently leaves a STALE
apk running** — always confirm `BUILD SUCCESSFUL` + PID up + the ready-log before reading captures; correlated
`dump_scene`+capture is the tiebreaker.

**The 4 EMULATOR CEILINGS (they still hold — never pretend otherwise):**
- **C1** — no native scene-understanding / hand-tracking on the emulator (0 planes / 0 mesh → pins FLOAT). Real
  surfaces are headset-only. Workaround: `generate_home_env_proxy` (invisible collider proxy of the known home
  bedroom; floor y=0 is the only vision-verified anchor).
- **C2** — the free camera is DECOUPLED, uncontrollable-by-keys, and DRIFTS (~3px/sec); the screencap view ≠ the
  app's HMD view. `adb exec-out screencap` = the clean guest HMD framebuffer (shows content, byte-stable);
  macOS host-capture = the qemu window (drifting free cam, for the Spatial Editor GUI only). Orbit the cam ONLY via
  `emulator_look` (a CGEvent RIGHT-drag). **When a capture looks wrong, suspect the camera FIRST** (navigate before
  blaming content).
- **C3** — no controller / gaze pointer; the trigger is GUI-gated → 2D clicks don't raycast. **This is why the
  mouse bridge exists.** Headless drive = `app_broadcast` (`<pkg>.DEBUG_CMD`/`AGENT_CMD`).
- **C4** — stage-vs-window dichotomy (no room + pins + in-front Compose panels together). We stay in the
  broadcast-driven ECS world (UI as in-world textured quads) so the bridge keeps working.

---
## ▶ THE NON-NEGOTIABLE PRINCIPLES (the soul of the project — keep them or you break it)

1. **HONEST vision-verification.** A feature is NOT "verified" until you have **captured a frame and SEEN it render
   correctly with your own vision**. `BUILD SUCCESSFUL`, `smoke 0`, logcat markers, and `dump_scene entities=N`
   prove EXISTENCE, never APPEARANCE. **"I didn't look" == "unverified."** The user has caught over-claims at least
   twice and is right each time — structural/logcat proof is necessary, never sufficient. **Honest deferral
   (C1/C3/C4 → built-for-Swan) is always fine; silent over-claim is the only hard failure.**
   - Transient animations: temporarily make them slow + non-returning (hold), capture the held state, then restore.
   - A same-colour flash over a same-colour button is INVISIBLE → brighten the flash tint toward white to see it.
   - MAE numeric diff under-weights small objects → **vision is the verdict, the diff is an assist**. ImageMagick
     full-frame `compare` on 2160² TIMES OUT → crop + montage + LOOK.
2. **Respect the C1–C4 ceilings** (above), and tag every claim by ceiling.
3. **Code-generate the headset-only parts so they light up on the PICO Swan.** Verify-what's-verifiable now; flag
   headset-only honestly. The big "built-for-headset" column is pre-built code awaiting a device, NOT a gap.
4. **Learning-retention.** The curated auto-memory (`…/memory/`) is the SOURCE OF TRUTH — dense, gotcha-rich,
   hand-curated. Keep it curated; never let it drift into a second auto-captured store. Update MEMORY.md +
   game-menu-demo.md + pico-mcp-project.md with every new hard-won fact.
5. **Method discipline.** Research SDK 0.13.3 signatures from the REAL sources
   (`~/.gradle/caches/modules-2/files-2.1/com.pico.spatial.core/core/0.13.3/*/core-0.13.3-sources.jar`; math types
   are in the **foundation** jar, not core) BEFORE codegen → generate into a throwaway `gen/` pkg → ONE
   `compileDebugKotlin` → then vision-verify on a real build. Do NOT invent formats. Apply edits SERIALLY (parallel
   agents clobbered `HomeStage.kt` once — fan out READ-ONLY, or give each an isolated worktree). `JAVA_HOME` must be
   the Android Studio JBR.

---
## ▶▶▶ NEXT SESSION STARTS HERE <<< — BUILD v5.0 (the brief-to-app compiler)

The content, menu, and interaction ladders are complete. **v5.0 is the next big thing: the planning layer** — turn
a natural-language brief into a planned, authored, built, verified spatial app with far less human steering. The
full plan is in **`ROADMAP_v5.0-v6.0.md`** — read it, it is authoritative. Highlights:

- **⚠ LOAD-BEARING CORRECTION (accept before planning anything):** ROADMAP §8's "✓ SHIPPED" markers for v4.2–v4.4
  are WRONG. There is **no `layout.ts`, `interaction.ts`, `statemachine.ts`, `databinding.ts`, or `gaze.ts`** in
  `src/`. The only real interaction primitive is `generate_game_menu_kotlin` + the mouse bridge. **A compiler
  cannot compose primitives that don't exist.** So the v5.0 acceptance brief (6 shelved items, gaze-select, detail
  card, JSON) REQUIRES first building `generate_layout_kotlin`, `generate_interaction_kotlin`,
  `generate_data_binding_kotlin` (use the codegen method above). This is honest v5.0 scope, not an assumption.
- **v5.0 keystone:** a typed `AppSpec` IR (`src/appspec.ts`, a zod schema) that is simultaneously the build plan
  AND the verification contract — every node carries its own acceptance predicate + its C1–C4 capability class +
  a required forward-FOV camera pose (C2). New thin tools over the existing spine: `list_capabilities`,
  `plan_app_spec`, `compile_app_spec`, `verify_app_spec`, `replan_spec`; new prompt `brief_to_app` that WRAPS (does
  not replace) `autonomous_spatial_build` v4 as the per-node executor.
- **Acceptance test:** the §8 hard brief run with ZERO human tool-sequencing, twice reproducibly, plus a second
  unseen brief — with ≥ the 6 shelf items + one detail card **vision-verified from a frame actually LOOKED at**.
- **Then keep executing the 10 phases** (v5.1 lint engine → v5.2 self-repair → v5.3 trust ledger + stacked
  worktrees → v5.4 eval corpus → v5.5 regression gates → v5.6 templates+remix → v5.7 multi-scene +
  `generate_composition_scene` → v5.8 data-at-scale + generalized interaction → v5.9 Swan on-device parity →
  v6.0 the autonomous spatial factory). Robustness before breadth before hardware before fleet.

---
## ▶ ACTION ITEM — agent-tooling changes (from the plugin research; see ROADMAP appendix)

- **Superpowers (obra/superpowers) → ADOPT-PARTIALLY, now.** Cherry-pick `brainstorm` / `write-plan` /
  `execute-plan` + `verification-before-completion` + the SKILL.md authoring format to bootstrap v5.0's planning
  layer. **Reframe its mandatory TDD as your existing compile+vision gate** (you can't write a failing unit test
  for "3 cyan orbs over the bed"). Do NOT run its orchestrator against your Workflow engine.
- **claude-mem (thedotmack/claude-mem) → SKIP.** Your curated MEMORY.md already delivers high-signal cross-session
  recall; auto-capture duplicates it, lowers signal, and bloats context. If recall ever falls short, borrow only
  the IDEA (a lightweight semantic index over the per-fact files) — not the plugin (planned in v6.0).
- **gstack → CLARIFY the referent, then situational.** If it's garrytan/gstack (role-framework + browser daemon),
  SKIP (it duplicates your bespoke memory + orchestration; borrow only the reflection-on-failure loop). If it's
  git-stacking (stacked diffs), ADOPT-PARTIALLY only when you move to PR-based review (folded into v5.3 as
  `stack_new`/`stack_verify`/`stack_land`).

---
## ▶ POINTERS
- **`ROADMAP_v5.0-v6.0.md`** — the authoritative v5.0 → v6.0 plan (read first).
- `DESIGN.md` — §1 materials-not-displayColor, §9 runtime physics, §10 PICO math API, §11 editor MaterialX,
  §12 the visual-ground-truth rule.
- `ROADMAP.md` §8 (the v4.1→v5.0 map — but see the LOAD-BEARING CORRECTION), `ROADMAP_v3.1-v4.0.md` §7.
- `SKILLS.md` — the agent reference.
- Memory: `/Users/sushantsrikrish/.claude/projects/-Users-sushantsrikrish-PICO-MCP/memory/`
  — `MEMORY.md` (index), `game-menu-demo.md` (the v4.6→v4.10 menu+bridge journey, every gotcha),
  `pico-mcp-project.md` (goal + walls).
- Load-bearing code: `src/menu.ts`, `src/mousebridge.ts`, `tools/mouse_menu_bridge.py`, `src/prompts.ts`
  (the `autonomous_spatial_build` v4 loop the planner will drive).
