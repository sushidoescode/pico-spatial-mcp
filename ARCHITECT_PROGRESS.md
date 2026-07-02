# Architect Engagement — v6.1 → v6.4 (branch `architect/hermetic-eye`)

Built ON `6.0.0` / `c963475`. Five gates green: `npm run build` · `smoke` · `test:lint` · `test:ledger` · **`test:eye`** (new). 138 tools. Four small, verified commits + this doc. **Not yet merged to main.**

## Phase 1 — Adversarial testing (what was real vs theater)
Full report: **`ADVERSARIAL_FINDINGS.md`**. Method: 37-agent adversarial workflow (6 seam-attackers → 31 skeptic-verifiers) + direct attacks through the real MCP tools over stdio. **29 CONFIRMED · 2 OVERSTATED · 0 refuted.**

The generation layer is real (plan+compile byte-stable; `build_and_run` honest). The **verification layer could be made to lie** — "over-claims are structurally impossible" was overstated. Proven-live over-claims (all now fixed): `record_verification` accepted any existing file (a `.txt`, `/etc/hosts`, a 0-byte file, a **directory**) as a `vision_verified` capture; `verify_app_spec` accepted any non-empty **string** as visual-PASS evidence; the C-class stamp was never reconciled (mislabel C3→C0 → "emulator-verified"); "N cards render" was verified from a frame that can't show N.

## Phase 2 — The leap (Hermetic Compiler + Trustworthy Automated Eye)

**v6.1 — honesty hardening** (`src/evidence.ts`, `ledger.ts`, `specverify.ts`, `planner.ts`, `capability.ts`). A `vision_verified` artifact must be a real PNG/JPEG (magic bytes + real dimensions) — the four spoofs are now rejected; the entry records a content sha256 for provenance and flags a frame reused across claims. `verify_app_spec` requires a real captured image (not a string) and reconciles the capability class (mislabel is a lint error + a structural backstop). Legacy `capability_report` downgrades an unlinked visual claim. *Re-running the attack harness: every attack now blocked; corpus CI still 1.0.*

**v6.2 — deterministic capture + the automated eye** (`src/eye.ts`, `test/eye.mjs`).
- **`capture_canonical`** — the `adb screencap` forward view is *byte-deterministic* (measured MAE=0 across kill+relaunch; the documented C2 drift is the GUI free-cam orbit, not this path). Returns a content sha256 and detects DRIFT vs an expected sha. "Same brief → same pixels" achieved by never moving the camera.
- **`visual_judge`** — MEASURES a real frame (object COUNT via connected-components, colors, coverage) against the acceptance predicate → PASS/FAIL/**ESCALATE** + confidence. New evidence class **`auto_judged`**, bucketed **separately** from `vision_verified` and never upgraded to it; low confidence/failed check escalates to a human. **Calibrated against the human-verified golden: 6-card golden → measures 6 → PASS conf 1.0.** Closes the "N cards render" over-claim by counting the cards.

**v6.3 — the wiring generator** (`src/assemble.ts`). `generate_app_wiring` emits the app-defining glue the audit found had no generator (`SceneComposition.kt` + `HomeStage.kt` + `Main.kt`), deterministically from the AppSpec; `compile_app_spec` lists it as a step. **Compile-verified against the real SDK 0.13.3** (`:app:compileDebugKotlin` exit 0, then restored). This closes the ledger→running-app gap.

**v6.4 — remaining honesty polish + fleet.** `regression_gate` PASS note no longer over-claims (+ a step-drift assist; golden regenerated to current 56 steps); `swan_verify_matrix` prose no longer claims an auto-flip on attach (marks `device_pending`; the flip still needs the on-device LOOK); `run_factory` surfaces `auto_judged` distinctly from `vision_verified`.

## Live acceptance run (one fresh, unseen brief, whole hardened pipeline)
"**8 planet tiles in a grid from a JSON catalog.**" plan → compile → `generate_app_wiring` → write → build → install → launch (logcat: `placed 8/8 items in GRID` → `built 8 cards` → ready). `capture_canonical` deterministic (drift=MATCH). `visual_judge` PASS, confidence 1.0, objectCount 8. **A human LOOKed** at `/tmp/pico-render/planetarium.png`: 8 tiles in a 3+3+2 grid, colors matching the JSON. Ledger `com.example.showroomxr.planetarium` = **1 vision_verified (human) + 1 auto_judged (measured), bucketed separately**. The showroomxr test app was restored to its multi-scene demo afterward.

## What remains (honest)
- **The full ≥10-unseen-brief unattended run.** The machinery is proven end-to-end on one fresh brief; the same loop scales. The wiring generator's strongest case is single-scene data-bound apps; multi-scene / non-data layouts have partial wiring.
- **A real PICO Swan device flip.** No hardware available; `swan_verify_matrix` is wired and marks `device_pending`. The flip to device-vision-verified still requires the on-device capture + `record_verification` (never auto-granted).

The soul is intact and stronger: trust is now a **measured, gated property** — a real frame for human vision, a calibrated measurement for the automated eye — with the two never conflated. A silent over-claim that used to be one string away is now structurally blocked.
