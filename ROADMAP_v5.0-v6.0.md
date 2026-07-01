# pico-spatial-mcp — THE AUTHORITATIVE v5.0 → v6.0 ROADMAP

This is the plan the next agent executes. It fuses around a single point of convergence — **a typed `AppSpec`
IR that is simultaneously the build plan AND the verification contract** — and sequences 10 phases so each
compounds the last. It **wraps the proven v4 spine** (the `autonomous_spatial_build` prompt, the `verify` gate,
the Workflow engine); it invents no new rendering primitives except where a load-bearing gap is found (see the
correction below). Every phase names the retained lessons it stands on and its emulator-vs-Swan verification bar.

Read alongside `HANDOFF.md`, `DESIGN.md` (§1/§9/§10/§11/§12), and the auto-memory.

---
## ⚠️ LOAD-BEARING CORRECTION (accept before planning anything)

ROADMAP.md §8's "✓ SHIPPED" markers for **v4.2–v4.4 are optimistic and WRONG**. The 49-module `src/` tree has
**no `layout.ts`, `interaction.ts`, `statemachine.ts`, `databinding.ts`, or `gaze.ts`**. The ONLY real interaction
primitive is `generate_game_menu_kotlin` + the mouse bridge. **A compiler cannot compose primitives that do not
exist.** Therefore v5.0's acceptance brief (6 shelved items, gaze-select, detail card, JSON) requires building
`generate_layout_kotlin`, `generate_interaction_kotlin`, and `generate_data_binding_kotlin` **as part of v5.0
scope** — this is the honest prerequisite, not a §8 assumption.

**First action of the v5.0 executor:** run the codegen method (research SDK 0.13.3 sigs → throwaway `gen/` pkg →
one `compileDebugKotlin`) on those three primitives BEFORE wiring the planner.

---
## (1) v5.0 — THE BRIEF-TO-APP COMPILER (the planning layer)

### Definition (one sentence)
v5.0 inserts a **PLAN → COMPILE → VERIFY-AGAINST-PLAN** tier above the existing v4 execution spine: a
natural-language brief (+ optional budget) becomes a typed, machine-checkable `AppSpec`; a driver walks that spec
node-by-node calling the existing `generate_*`/scaffold/bake/verify tools; and a plan-level gate scores the
*assembled app against its own spec*, deriving the honest verified-vs-Swan report directly from the results so
over-claims are structurally impossible.

**The LLM agent is the planner.** The new tools are a *typechecker + driver + reconciler*, not a bespoke planning
engine and not a second orchestrator — `compile_app_spec` runs INSIDE the existing Workflow engine. This keeps the
plan human-readable and debuggable, and makes "did I build what the brief asked?" an objective, reproducible question.

### The keystone: the `AppSpec` IR (`src/appspec.ts`, a zod schema)
The one new abstraction everything hangs off. Every node carries **its own acceptance predicate AND its C1–C4
capability class**, decided at plan time by a feasibility linter.

```
AppSpec {
  meta:   { appName, packageName, stageStyle, brief, budget?{iterations,timeMin,toolCalls} }
  scenes: [ { id, environment{kind:texturedMesh|splat|pano|procedural, asset?},
              lighting{rig:sun|fullRig|ibl, params},
              colliders{room{halfW,height,halfD,centerZ}, props[]},
              transitions[] } ]
  layouts:[ { id, sceneId, pattern:wall|grid|arc|shelf, count, surface:proxyRef } ]
  objects:[ { id, sceneId, source:model|quad|primitive, material, layoutRef|transform, dataBindRef?, anim? } ]
  data:   [ { id, source:json|gated_api, schema, bindsTo:[objectId] } ]
  interactions:[ { id, trigger:broadcast|gaze_dwell|controller_ray|grab|press,
                   target, action, stateMachine?, driveChannel:broadcast|controller } ]
  navigation:{ startScene, portals:[{from,to,trigger}] }
  verificationPlan:[ { claim, method:capture|assert_scene|dump_scene|baseline,
                       forwardFOVpose,           // REQUIRED (C2): where emulator_look must aim
                       capabilityClass:C0_emulator | C1|C2|C3|C4_headset_only,
                       reproHash } ]             // canonical camera pose + seed
  headsetLayer:[ codegen pieces for Swan (sense/plane, controller-ray, in-front panels, anchors) ]
}
```

**Why per-node C-class is the honesty engine:** a controller-ray interaction is stamped `C3 → built-for-Swan` and
a gaze-dwell interaction is stamped `C0 → broadcast-drivable-emulator` *at plan time*, so the plan already knows
what it can prove now vs. only build-for-Swan. `verificationPlan` requires a **forward-FOV pose** for every visual
claim (honoring C2 — content outside the forward view can't be captured), or the claim must be tagged headset-only
rather than faked.

### New tools (thin glue over the existing ladder)
| Tool (new module) | Role |
|---|---|
| **`list_capabilities`** (`src/capabilities.ts`) | Machine-readable capability manifest auto-derived from the tool registry: each `generate_*` tool, what it authors, params, and its verification ceiling. The planner plans *against this menu* so it cannot plan what tools can't build. |
| **`plan_app_spec`** (`src/planner.ts`) | Brief (+budget) → validated `AppSpec` + rationale. Seeds from templates (v5.6), fills nodes from the manifest, runs the **C1–C4 feasibility + gotcha linter** (v5.1), assigns each node its verification method + C-class + forward-FOV pose, orders by dependency, flags budget overflow. Side-effect-free — inspect/edit the plan before executing. (Superpowers' `write-plan`, XR-tuned.) |
| **`compile_app_spec`** (`src/compiler.ts`) | Walks the spec topologically driving the *existing* spine: `scaffold_spatial_app` → env/`bake_textured_model` → `generate_collider_kotlin`+PhysicsWorld → lighting/richness → `generate_layout_kotlin` → objects → `generate_interaction_kotlin`/`generate_state_machine_kotlin` → `generate_data_binding_kotlin` → UI/`generate_game_menu_kotlin` → inject `generate_agent_bridge` → `build_and_run`. Emits a **BuildLedger** (spec node → exact tool call → artifact path → compile/run status). Idempotent + resumable. **Edits app files SERIALLY itself** (the parallel-writer clobber lesson); any fan-out is READ-ONLY SDK-signature research. |
| **`verify_app_spec`** (`src/specverify.ts`) | The plan-level gate. Per `verificationPlan` node: aims the free cam via `emulator_look` to the forward-FOV pose, runs `capture_frame`/`assert_scene`/`verify_baseline`, classifies by C-class, returns per-node **PASS / LOOK / FAIL / DEFERRED-SWAN** + a **spec-satisfaction score** (fraction of C0 claims actually vision-verified). **Never auto-passes a visual claim** — hands the frame back to be LOOKED at. Auto-derives `capability_report`. |
| **`replan_spec`** (`src/planner.ts`) | On any FAIL, calls `diagnose(symptom)` and patches the **spec** (swap asset, move a slot out of the bed, downgrade a C3 interaction to broadcast), then re-`compile_app_spec` only the failed subtree. |

### New prompt: `brief_to_app` (`src/prompts.ts`, the v5 spine)
BRIEF → `list_capabilities` → `plan_app_spec` (+ show the honest emulator-vs-Swan preview) → review the AppSpec →
`compile_app_spec` (drives the v4 loop per node) → `verify_app_spec` (plan-level gate) → `replan_spec` loop until
every node has a verdict or is honestly deferred → SHIP (spec-completion report + `swan_bring_up_checklist` derived
from the C1/C3/C4 nodes + auto-derived `capability_report`). **Wraps, does not replace** `autonomous_spatial_build`
v4, which becomes the per-node executor. Inherits every non-negotiable: the ground-truth rule, the C1–C4 ceilings,
serial edits, SDK getter discipline.

### Concrete unattended acceptance test (Definition of Done)
The §8 hard brief, run with **zero human tool-sequencing**:
> **"An interactive product showcase: 6 items on shelves, gaze to select, a detail card per item, sourced from a
> JSON catalog."**

The single `brief_to_app` invocation must:
1. produce an `AppSpec` with 6 shelf objects (shelf layout), a `gaze_dwell` interaction classified
   **C0_emulator (broadcast-dwell)**, a `controller_ray` path classified **C3 headset-only**, and a JSON `data` node;
2. `compile_app_spec` + `build_and_run` clean (BUILD SUCCESSFUL + PID up + ready-log confirmed — never read
   captures off a stale APK);
3. `verify_app_spec` returns per-node verdicts with **≥ the 6 shelf items + one detail card vision-verified from a
   frame actually LOOKED at**, and the card text matches the JSON entry after a `select(item3)` broadcast (test the
   state with ~3s settle, not a rapid broadcast→capture);
4. emit the auto-derived verified-vs-Swan report (arc/shelf layout + card update = vision-verified; controller-ray
   select + native-surface anchoring = built-for-Swan);
5. **Reliability gate:** run TWICE from a clean AVD snapshot → SAME AppSpec + SAME ledger verdicts, with the
   gaze(C0)/controller(C3) split correct;
6. **Generality gate:** the same run passes on a SECOND unseen brief (e.g., "calm wellness corner" / "constellation
   planetarium") with no code change.

**The honest gate it must pass:** a fresh agent, reading ONLY the captures `verify_app_spec` returns, can confirm
each visible claim. If any visible node lacks a LOOKED-at capture, the run FAILS. **Honest deferral (C1/C3/C4 →
built-for-Swan) is fine; silent over-claim is the only hard failure.** That asymmetry is the whole point.

---
## (2) THE DEFINITIVE 10-PHASE PLAN (v5.1 → v6.0)

**Arc:** harden the compiler → make it trustworthy → measure it → lock it → reuse it → scale scope → reach real
Swan → run it as a fleet. Robustness before breadth before hardware before fleet.

---
### v5.1 — Retained-lessons LINT ENGINE
- **Theme:** every hard-won MEMORY.md gotcha becomes an executable, fixture-backed lint rule the planner runs
  BEFORE codegen — the loop can never repeat a solved mistake.
- **Build:** `preflight_lint` + `record_lesson` (`src/lint.ts`), extending the `diagnose` KB. Rules:
  `displayColor`-flat-white; `createStaticMesh`/`createConvexMesh` colliders don't register;
  `PhysicsWorldComponent` required on-device; `CollisionComponent` 5-arg ctor only; `cornerRadius ≤ thickness/2`;
  billboard-tilt ≤ 12°; additive-bob-fights-drag; `ParticleComponent` has no ctor;
  `StageEnvironmentLightingComponent` inactive in MIXED; force-stop-other-`com.example.*`-first; `JAVA_HOME`=JBR;
  never-raw-md5-bundle-diff; scaffold-keeps-`SpatialDemo`-tag; `.quaternion.rotateVector` not `.rotation`.
  `record_lesson` appends a NEW rule+fixture whenever `diagnose` resolves a novel failure.
- **Stands on:** the entire LESSONS digest; the `diagnose` gotcha encyclopedia; the codegen method.
- **Verification bar:** genuinely **test-verifiable** (rare here) — each rule ships a positive+negative fixture.
  Built apps still need vision. No Swan dependency.
- **Depends on:** nothing (build first).
- **DoD:** every current MEMORY.md gotcha is an executable rule with a fixture; a planted violation is caught pre-build.

### v5.2 — SELF-REPAIRING COMPILER (critique → replan, budget-bounded)
- **Theme:** turn a LOOKED-at frame into a defect list and auto-repair only the failed subtree, within a budget.
- **Build:** `critique_capture(image, claim, rubric)` (`src/critique.ts`) — a structured vision-rubric pass mapping
  defects to DESIGN.md rules; harden `replan_spec` to ingest `diagnose` + critique output and mutate the AppSpec
  (dim clusters → emissive/UNLIT rig; slot-in-bed → move; raw-GLB-black → baked bundle), then recompile ONLY the
  failed subtree. Bounded by a retry/edit budget. The transient-verify trick (slow/hold → capture → restore)
  becomes a schedulable step.
- **Stands on:** the self-correcting loop already caught real generator bugs in the v4.0 demo; `diagnose`'s
  symptom→fix KB; the stale-APK tiebreaker; MAE-under-weights → vision-is-the-verdict.
- **Verification bar:** fully **emulator-vision** — auto-repair proven by a before/after capture pair LOOKED at.
- **Depends on:** v5.0 (spec + replan), v5.1 (lint rules feed the fixes).
- **DoD:** a brief with a planted defect (unlit clusters / raw-GLB env) auto-repairs to a passing vision-verified
  frame within the iteration budget, unattended.

### v5.3 — TRUST LEDGER + honest-claim enforcement (+ safe stacked-worktree landing)
- **Theme:** make over-claims structurally impossible; land multi-generator changes safely.
- **Build:** a machine-readable `verification_ledger` per app/per node:
  `{claim, evidenceType (compiles|logcat|structural|vision_verified|built_for_headset), artifactPath (the frame
  LOOKED at), cClass, reproHash, timestamp}`. `capability_report` + the ship report are **GENERATED from it**, and
  the schema **forbids** recording `vision_verified` without a linked capture artifact + LOOK attestation. Fold in
  `stack_new`/`stack_verify`/`stack_land` (thin `gh` + git-worktree wrappers over `EnterWorktree`/`ExitWorktree`)
  so each spec-node/generator change lands in its OWN worktree, passes its OWN node-verify, and stacks into a
  reviewable, independently-revertable chain — and parallel agents get ISOLATED worktrees.
- **Stands on:** the honest-verification soul; the repeated over-claim reality-checks; parallel-agents-clobbered-
  `HomeStage.kt` → isolated worktrees.
- **Verification bar:** ledger schema + landing gate are **process/test-verifiable**; vision entries still require
  the linked artifact.
- **Depends on:** v5.0, v5.2.
- **DoD:** no report can emit "verified" for a node lacking a linked, LOOKED-at frame (a test proves an unlinked
  claim is rejected); a multi-generator change lands as a stack of small, independently-green, reversible commits.

### v5.4 — EVAL CORPUS + scorecard (brief-generality as a distribution)
- **Theme:** measure brief-generality as a distribution, not one anecdote.
- **Build:** a curated `briefs/` corpus (gallery, inspection, dashboard, ambient, showcase, multi-scene narrative),
  each with an expected AppSpec shape + expected C-classes; `run_brief_suite` (`src/eval.ts`) plans→compiles→
  verifies each headless and emits a scorecard (planned/built/vision-PASS/LOOK/FAIL/Swan-only/wall-clock/tool-calls)
  + a **batched montage** for one-pass LOOK review (reads the v5.3 ledger).
- **Stands on:** brief-generality already proven (GalleryXR); crop+montage+LOOK (full-frame compare times out);
  MAE-under-weights → vision is the verdict.
- **Verification bar:** structural fully automatic; visual nodes batched into montages for a single LOOK per run.
  Emulator-verifiable.
- **Depends on:** v5.3 (reads the ledger).
- **DoD:** a ≥6-brief suite runs unattended and yields a stable scorecard; a broken generator visibly drops the score.

### v5.5 — REGRESSION GATES + reproducibility lockdown
- **Theme:** block ship on any regression; make diffs meaningful.
- **Build:** `regression_gate` (`src/gate.ts`) — compares the current scorecard + committed **golden frames** (via
  `verify_baseline` 3-band MAE + montage) against goldens and blocks ship on any regression. Reproducibility: pin
  the SDK 0.13.3 hash, `snapshot_save` a golden AVD state, seed all generator randomness, and force a **canonical
  `emulator_look` pose** before every golden capture.
- **Stands on:** `verify_baseline`'s 3-band verdict + `capture_frame` byte-stability; **C2 free-cam drifts →
  canonical pose is mandatory** or diffs are meaningless; non-deterministic bundle build → `bundle_content_diff`,
  never md5.
- **Verification bar:** MAE numeric assist + montage LOOK; canonical pose makes the diff meaningful. Emulator-verifiable.
- **Depends on:** v5.4.
- **DoD:** golden frames + scorecard committed; a deliberately-broken generator is caught before merge.

### v5.6 — TEMPLATES + remix
- **Theme:** reuse — parameterized AppSpec skeletons + "remix an existing app to a new brief."
- **Build:** `list_templates`/`instantiate_template(name, brief)` (`src/templates.ts`) — gallery / inspection /
  dashboard / ambient / showcase skeletons; `remix_app(existingProjectDir, newBrief)` — decode an existing app
  (`decode_editor_project` + read its authored Kotlin) into an AppSpec, re-plan the DIFF to the new brief,
  recompile only changed nodes, re-verify only affected nodes.
- **Stands on:** the v4.0 proof the loop is brief-general; scaffold-keeps-`SpatialDemo`-tag (remix must re-grep/
  rename correctly, keep `local.properties sdk.dir`); after-editor-resave-DIFF-the-USDA (remix diffs authored
  content, never md5).
- **Verification bar:** emulator-vision — a template/remix output is a full app that passes `verify_app_spec`; any
  headset-only feature carries its `verifiedBy:swan` tag forward.
- **Depends on:** v5.0 (AppSpec), v5.5 (regression-gated).
- **DoD:** four distinct briefs → four vision-verified apps via templates, plus one successful remix of GalleryXR
  into a fresh brief.

### v5.7 — MULTI-SCENE orchestration + `generate_composition_scene`
- **Theme:** compose multiple scenes with real navigation/transitions.
- **Build:** the deferred v4.8 `generate_composition_scene` (`src/composition.ts`, USD references/overrides
  extending `compose_scene`); `generate_scene_router_kotlin` (`src/router.ts`) — a scene-graph state machine that
  tears down/loads scenes and drives `generate_portal_kotlin`/`generate_display_controllers_kotlin` transitions;
  extend AppSpec `navigation` execution in `compile_app_spec`; per-scene camera plans in `verify_app_spec`.
- **Stands on:** stage-vs-window C4 → transitions stay in-ECS/broadcast-driven so the mouse bridge keeps working;
  **the editor silently DROPS hand-authored `over` blocks on re-save → diff the USDA** (critical for composition);
  "test each state INDIVIDUALLY with ~3s settle, or use `dump_scene` for ground truth"; additive-bob-fights-moved-
  transform → reset per-scene state.
- **Verification bar:** emulator-vision for **both** scenes (drive the transition via `app_broadcast`, capture each
  scene individually with settle); portal *gaze/controller* activation = Swan-codegen (C3), broadcast traversal =
  emulator-verified.
- **Depends on:** v5.6 (templates give scene skeletons).
- **DoD:** a 2–3-scene app (lobby → gallery → detail) switches scenes via broadcast with each scene vision-verified
  in one unattended run.

### v5.8 — DATA-DRIVEN AT SCALE + generalized interaction depth
- **Theme:** N-item data-bound scenes + interaction beyond the menu.
- **Build:** mature `generate_data_binding_kotlin` (bundled JSON / gated API → N cards via
  `generate_layout_kotlin`) + `import_model_catalog` batch-bake so N items are DISTINCT textured models; **layout
  intelligence + camera planning** (collision-aware auto-layout over the home-env proxy — don't place in the bed —
  plus auto-generated `emulator_look` sweeps so `verify_app_spec` can SEE every object); **generalize
  `mouse_menu_bridge.py`** from the 4-colour-bar detector to a spec-emitted **interactable registry** (the app
  publishes clickable bboxes via the Agent Bridge; the bridge reads them instead of pattern-matching colours);
  `generate_interaction_kotlin` gaze-dwell + hover/select state change.
- **Stands on:** `bake_textured_model` is the ONLY textured path (never runtime-load GLB; astc flag LAST);
  image-textures-on-hand-authored-materials-pack-black; button-rows-computed-analytically (layout math from
  geometry, never eyeballed); the entire mouse-bridge journey (coalescing sender — never blocking-broadcast per
  event; auto-target the FOREGROUND app; ~15° tilt tolerance; redetect-per-click for C2 drift; children-of-panel
  highlights); **C3 is why the bridge exists.**
- **Verification bar:** emulator-vision — "N JSON items → N laid-out cards/models" proven by a `verify_visual`
  sweep/montage; a real Mac click via the generalized bridge selects an interactable → broadcast → vision-verified
  state change; live API fetch is code-verified + one gated call, flagged network-gated; controller-ray + pinch =
  Swan-codegen (C3).
- **Depends on:** v5.7 (multi-scene detail cards), the layout/interaction/data primitives built in v5.0.
- **DoD:** the north-star showcase runs at scale — swap the JSON catalog (3→9 items) and the scene re-lays-out and
  re-verifies ONLY the layout+card nodes; a non-menu interactable is clicked via the bridge and its selection is
  vision-verified.

### v5.9 — SWAN on-device parity (flip built-for-headset → device-verified)
- **Theme:** the single biggest honesty upgrade — flip the whole "built-for-headset" column to device-verified.
- **Build:** wake `deploy_to_device` (dormant) into a real USB-Swan path; `swan_verify_matrix` — auto-runs the
  headset-only re-tests the codegen already emitted (`generate_scene_understanding_kotlin` real plane pins,
  `generate_persistent_anchor_kotlin` world anchors, controller-ray select, in-front Compose panels); a Swan-side
  capture path (headset screenshot/record) feeding the SAME `verify_app_spec` so `verifiedBy:swan` claims become
  **actually verified**, not just built. A PARITY ledger records each C1–C4 row's emulator→device delta;
  `swan_bring_up_checklist` becomes executable, driven by the ledger's `built_for_headset` rows.
- **Stands on:** the ENTIRE C1–C4 catalogue is the test plan (0-planes-on-emulator → real planes on Swan;
  pins-float → pins-snap; broadcast-drive → real controller trigger); `generate_headset_readiness_codegen`;
  `home_env_proxy` (faked hit-test) vs real scene-understanding; **MEASURED-ROOM infeasible on emulator (Unity
  black box)** → the headset is the ONLY way to close the walls/ceiling gap.
- **Verification bar:** emulator side already covered (v5.5); headset-only rows are code-generated-for-Swan until a
  device attaches, then **FLIP to device-vision-verified** with the parity delta recorded. **Gated on Swan
  hardware arriving.**
- **Depends on:** v5.3 (the ledger it flips), v5.5 (the emulator baseline). Hardware-gated.
- **DoD:** an app's full matrix is emulator-verified now AND has a one-command Swan bring-up that auto-fills the
  headset-only rows (≥ native-surface pin placement flipped to device-verified) on first device attach.

### v6.0 — THE AUTONOMOUS SPATIAL FACTORY (fleet scale, the north star)
- **Theme:** the studio ships apps, not demos — a queue of briefs → verified, ledgered, regression-gated,
  Swan-ready apps unattended.
- **Build:** a `factory` prompt/tool taking a QUEUE of briefs (or a product-spec doc); for each: plan → compile →
  verify-per-node → self-heal (v5.2, budgeted) → land as a stacked, ledgered, regression-gated app (v5.3/5.5) →
  Swan-verify when hardware present (v5.9); runs `run_brief_suite` as CI; retains every new lesson (`record_lesson`,
  v5.1) and mines BuildLedgers to auto-propose new `diagnose` KB entries + template skeletons (reflection-on-failure
  — the one pattern worth borrowing from garrytan/gstack); a lightweight **semantic index over the curated per-fact
  memory** (the ONLY idea worth taking from claude-mem — an index, NOT a second store); formalizes the planning
  steps as **SKILL.md skills** (`brainstorm → write-spec → execute-spec → verify-spec` — the Superpowers
  cherry-pick, vision gate reframed AS "the test", skipping rigid TDD); emits a fleet dashboard.
  `autonomous_spatial_build_v6` becomes the single top-level entry, deprecating hand-sequencing.
- **Stands on:** ALL prior phases; the original v2.0 refrain "ClaimSight is example output #1 of many" and "brief +
  budget → shippable verified app", now realized with trust as a MEASURED property.
- **Verification bar:** the benchmark suite is the verdict — each brief's claims are either emulator-vision-verified
  or Swan-vision-verified (v5.9), with **zero un-LOOKED-at "works" claims**. NO aggregate over-claim — a fleet
  metric can't upgrade any node's evidence class.
- **Depends on:** all of v5.1–v5.9.
- **DoD:** a queue of ≥3 fresh unseen briefs becomes 3 verified, ledgered, regression-gated, Swan-ready apps
  unattended, each with an honest verified-vs-built report and a reproducible fleet dashboard.

---
### Why this sequence (the compounding chain)
v5.1 lint feeds → v5.2 self-repair (fixes drawn from executable rules) → records into v5.3 trust ledger
(over-claim now impossible; safe landing) → read by v5.4 scorecard (generality as a distribution) → locked by v5.5
regression (canonical-pose goldens) → reused by v5.6 templates/remix → which give v5.7 multi-scene skeletons →
whose scenes consume v5.8 data + generalized interaction → whose full apps deploy to v5.9 Swan (headset rows flip
to verified) → v6.0 factory runs the entire pipeline at fleet scale, retaining every lesson. **Robustness
(5.1–5.5) before breadth (5.6–5.8) before hardware (5.9) before fleet (6.0)** — a self-repairing, trustworthy
single-app compiler is worth more than a multi-scene one that can't verify itself.

---
## (3) PRINCIPLES CARRIED THROUGH ALL PHASES (never bend)

1. **Honest verification is the soul.** A feature is NOT "verified" until an agent has captured a frame and SEEN it
   render correctly. `BUILD SUCCESSFUL`, `smoke 0`, logcat markers, and `dump_scene entities=N` prove EXISTENCE,
   never APPEARANCE. "I didn't look" == "unverified." From v5.3 on, this is enforced in the DATA MODEL: the ledger
   **forbids** a `vision_verified` claim without a linked, LOOKED-at artifact, and every report is DERIVED from the
   ledger — so over-claims (which the user has caught at least twice) become structurally impossible. **Honest
   deferral is always acceptable; silent over-claim is the only hard failure.**

2. **Respect the 4 emulator ceilings; tag every node.** Every AppSpec node carries a C-class decided at plan time.
   **C1** no native scene-understanding/hand-tracking on the emulator (pins float — use `home_env_proxy`; real
   surfaces are Swan-only). **C2** the free camera is decoupled, drifts, and screencap≠HMD view — every visual
   claim needs a forward-FOV pose and a canonical pose before golden captures; when a capture looks wrong, suspect
   the camera FIRST. **C3** no controller/gaze pointer — this is WHY the mouse bridge exists; broadcast-drive on
   emulator, controller/pinch built-for-Swan. **C4** stage-vs-window dichotomy — stay in the broadcast-driven ECS
   world so the bridge keeps working.

3. **Learning-retention: never repeat a solved mistake.** Every hard-won gotcha becomes an executable lint rule
   (v5.1), and `record_lesson` grows the KB from each novel `diagnose` resolution. The curated MEMORY.md stays the
   source of truth — index it semantically (v6.0), never duplicate it into a competing store.

4. **Code-generate the headset-only parts so they light up on Swan; verify-what's-verifiable now, flag
   headset-only honestly.** The large "built-for-headset" column is not a gap — it's pre-built code awaiting
   v5.9's device parity pass, which flips those rows from built to device-vision-verified. MEASURED-ROOM stays
   infeasible on the emulator (Unity black box); the headset is the only path to walls/ceiling.

5. **Method discipline.** Research SDK 0.13.3 signatures from the real sources BEFORE codegen → generate into a
   throwaway pkg → one `compileDebugKotlin` → then vision-verify on a real build. Edits applied SERIALLY (or in
   isolated worktrees) — parallel agents fan out READ-ONLY. Confirm BUILD SUCCESSFUL + PID + ready-log before
   trusting any capture. `npm run build && npm run smoke` at 0 failures per increment. Build ON the existing spine
   (the v4 prompt, the verify gate, the Workflow engine) — do NOT stand up a second orchestrator.

---
## Appendix — agent-plugin recommendation (Superpowers / claude-mem / gstack)

- **Superpowers (obra/superpowers) → ADOPT-PARTIALLY (highest value).** A composable SKILLS framework +
  methodology (`brainstorm → write-plan → execute-plan`, verification-before-completion, subagent review,
  git-worktrees, the SKILL.md authoring format). Cherry-pick `brainstorm`/`write-plan`/`execute-plan` +
  verification-before-completion + the SKILL.md format to seed v5.0's planning layer and v6.0's skills. **Reframe
  its mandatory TDD as your existing compile+vision gate** (you can't write a failing unit test for "3 cyan orbs
  over the bed"). Do NOT run its orchestrator against your Workflow engine.

- **claude-mem (thedotmack/claude-mem) → SKIP.** An auto-capture + vector-recall memory plugin. It's the biggest
  overlap with your genuine strength — the curated, hand-distilled MEMORY.md already delivers high-signal
  cross-session retention; auto-captured transcripts are lower-signal, run a second competing store, and bloat
  context. If recall ever falls short, borrow only the IDEA — a lightweight semantic index over the existing
  per-fact files (planned in v6.0) — not the plugin.

- **gstack → CLARIFY the referent first.** Most likely **garrytan/gstack** (a generic Claude Code role-framework +
  browser daemon + its own memory/orchestration) → **SKIP wholesale**; it duplicates your bespoke, XR-tuned memory
  + planning + QA for little XR payoff, and its QA doesn't understand vision-verification. Borrow only the
  parallel-persona review + reflection-on-failure loop (into the Workflow engine / v6.0). If instead you meant
  **git-stacking** (ghstack / Graphite / Bendzae-gstack) → **ADOPT-PARTIALLY / situational**, only when you move to
  a PR-based review flow — folded into v5.3 as `stack_new`/`stack_verify`/`stack_land` over the available
  worktree tools.

**Overall:** Superpowers adopt-partially now (seed the planner, keep your vision gate as "the test"); claude-mem
skip (curated memory wins; borrow only a semantic index later); gstack clarify (skip the role-framework; adopt
git-stacking only under PR review).
