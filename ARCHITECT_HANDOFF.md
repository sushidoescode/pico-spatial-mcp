# ARCHITECT HANDOFF — pico-spatial-mcp @ 6.0.0

**For:** a god-level architect / software engineer taking over `pico-spatial-mcp`.
**Your mandate has two halves:** (1) **break it** — put this build through rigorous, adversarial testing until you understand exactly where it is real and where it is theater; then (2) **transcend it** — take the honest core and build the thing this project has been circling but never reached.

Read this whole file, then `HANDOFF.md` (the v5.0 kickoff, now historical), `ROADMAP_v5.0-v6.0.md`, `DESIGN.md` (§1/§9/§10/§11/§12 are load-bearing), and the curated memory at `…/memory/MEMORY.md`. Then read the code — it is small and honest.

---

## PART 1 — THE HANDOFF (what exists, and how to trust it)

### What this is
An MCP server that lets an AI agent drive **native PICO XR spatial development end-to-end on the PICO OS6 emulator**: scaffold an app, author SDK-0.13.3 Kotlin via `generate_*` codegen tools, bake assets, build/install/launch, and — the part that matters — **verify by capturing a frame and LOOKING at it**. On top of that execution spine sits a **brief-to-app compiler** (v5.0) and a full robustness/reuse/scale stack (v5.1–v6.0).

- **`6.0.0`**, `HEAD == origin/main == c963475`, working tree clean, fully pushed.
- **72 `src/*.ts` modules · 138 `registerTool` sites (~135 distinct tools) · 4 prompts.**
- **Gates (all green):** `npm run build` (tsc, zero errors) · `npm run smoke` (spawns the server, lists tools, exercises non-emulator tools — `Failures: 0`) · `npm run test:lint` (every lint rule's +/- fixture) · `npm run test:ledger` (the honesty gate). Node ≥20, TS/ESM.
- **Emulator:** `emulator-5554` (PICO SDK 0.13 under `~/Library/PICO/sdk`). Test app: `~/AndroidStudioProjects/showroomxr-native` (currently a multi-scene demo). JBR: `/Applications/Android Studio.app/Contents/jbr/Contents/Home`.

### The architecture in one breath
`AppSpec` (a zod IR — the keystone, `src/appspec.ts`) is **simultaneously the build plan and the verification contract**. Every node carries its own acceptance predicate + a C1–C4 capability class + (for visual claims) a required forward-FOV camera pose. Around it:

- **Plan** (`planner.ts`): `plan_app_spec` validates + feasibility-lints a draft AppSpec, stamps each node's C-class, and previews emulator-vs-Swan. `replan_spec` mutates the spec on failure.
- **Compile** (`compiler.ts`): `compile_app_spec` walks the spec → a **BuildLedger** (spec node → exact existing tool call → target file → C-class). It is a *driver + reconciler*, **not** a monolith — the agent (via the `brief_to_app` prompt) executes the ledger through the real `generate_*`/scaffold/bake/build tools.
- **Verify** (`specverify.ts`): `verify_app_spec` is the plan-level gate. It **never auto-passes a visual claim** and **rejects a `vision_verified` verdict submitted without a linked capture**.
- **The three primitives it composes** (`layout.ts`, `interaction.ts`, `databinding.ts`) — analytical layout, raycast+broadcast interaction, JSON→tinted-quad binding — all compile-verified against the real SDK.
- **The stack on top:** `lint.ts` (executable retained-lesson rules) · `critique.ts` (frame→defect→replan self-repair) · `ledger.ts` (**the trust ledger — over-claims structurally impossible**) · `stack.ts` (isolated worktrees) · `eval.ts` (brief corpus scorecard) · `gate.ts` (regression gate + `repro.lock.json`) · `templates.ts`/`remix.ts` (reuse) · `router.ts`/`composition.ts` (multi-scene) · `layoutplan.ts`/`interactables.ts`/`catalog.ts` (data-at-scale) · `swanparity.ts` (the device flip) · `factory.ts` (the fleet).

### The soul — the four non-negotiables (do NOT break these; they are the whole point)
1. **Honest vision-verification.** A feature is verified only when an agent has captured a frame and **SEEN it render correctly**. `BUILD SUCCESSFUL`, `smoke 0`, logcat markers, `dump_scene entities=N` prove EXISTENCE, never APPEARANCE. From v5.3 this is enforced in the DATA MODEL: `record_verification` rejects a `vision_verified` claim without a linked, on-disk capture + attestation, and every report is generated from the ledger. **Honest deferral is always fine; a silent over-claim is the only hard failure.** The prior human caught over-claims twice — that pressure is why the ledger exists.
2. **The four emulator ceilings (C1–C4).** C1: no native scene-understanding/hand-tracking (0 planes → pins float). C2: the free camera is decoupled, drifts, and only takes relative drags — **there is no absolute pose**. C3: no controller/gaze pointer (broadcast-drive instead). C4: stage-vs-window dichotomy. Every AppSpec node is C-classed at plan time so the honest split is structural.
3. **Code-generate the headset-only parts** so they light up on the PICO Swan. Verify-what's-verifiable now; flag the rest built-for-Swan.
4. **Learning retention.** The curated `MEMORY.md` is the source of truth — dense, gotcha-rich, hand-distilled. Every hard-won fact goes back into it.

### How to verify the claims yourself (do this first — trust nothing)
- `npm run build && npm run smoke && npm run test:lint && npm run test:ledger` → all zero.
- Exercise the compiler tier headless (no emulator): `plan_app_spec` a draft, `compile_app_spec` it, `verify_app_spec` it, `run_brief_suite`, `run_factory` — all deterministic.
- **The honest evidence trail:** `ledger_report(app="com.example.showroomxr")` returns **7 vision-verified claims, each with a linked capture path in `/tmp/pico-render/`, 0 structural-only, 1 built-for-Swan.** Open those PNGs. Four distinct apps were vision-verified across the arc: a gem showcase, a 9-tile spice grid, a traffic-light status dashboard, and a lobby→gallery multi-scene switch.
- The emulator loop: boot `emulator-5554`, then follow the `brief_to_app` prompt.

### The honest gaps — where a god-level tester WILL draw blood (named on purpose)
I am telling you these so you don't waste a day discovering them, and so you can see the shape of the real work.

1. **C2 is the Achilles heel of the entire philosophy.** The whole project rests on "vision is the verdict," yet the only eye is a decoupled free camera that drifts (~3px/s), can't be posed absolutely, and takes blind relative drags. I "find" content by an ImageMagick coverage-threshold sweep — a hack. Golden-frame regression (`gate.ts`) is therefore fragile: it works only from a locked AVD snapshot at a canonical pose, and even then the pixel layer isn't truly deterministic. **The verification layer is the bottleneck, not the generation layer.**
2. **The "compiler" is agent-in-the-loop, not hermetic.** `compile_app_spec` emits a *ledger*; a human-or-agent then hand-wires the emitted Kotlin into `SpatialView.initial`/`HomeStage.kt` and drives the build. `ProductShowcase.kt` / `MultiSceneDemo.kt` in the test app are **hand-authored glue**. There is no single call that takes a brief to a running, verified app. That gap between "ledger" and "running app" is real.
3. **Verification doesn't scale past one agent's attention.** "LOOK at every frame" is O(human/agent-attention). The factory can plan/compile a fleet headless, but the vision pass is still one pair of eyes at a time. There is no automated, *calibrated* visual judge.
4. **Swan is 100% unverified.** Every C1/C3/C4 claim is code-for-headset. `swan_verify_matrix` is wired and dormant; no hardware has ever run it. The single biggest unknown in the whole system.
5. **Reproducibility is real at the IR layer, aspirational at the pixel layer.** Plan+compile are byte-stable (generators are analytical, no RNG — verified). But `spatialbundle` is non-deterministic and the camera drifts, so golden *frames* are only meaningful under a snapshot+pose lock.
6. **Coarse edges:** `remix_app` infers structure from *filenames*, not a Kotlin AST. The interactable registry is *colour-keyed* (a workaround for the absent world→screen projection — C2 again). `import_model_catalog` produces a data-node stub that nothing yet consumes end-to-end in a built app. Scale is tested to ~9 items; frame-budget/perf at 100s is unmeasured. Most tools have smoke+fixture coverage, not property-based/replay tests.

None of these are hidden. They are the frontier.

---

## PART 2 — THE CHALLENGE (the leap)

> ### Build **the Hermetic Spatial Compiler** and give it a **Trustworthy Automated Eye.**
> Turn this agent-in-the-loop studio into a system where **one invocation takes a natural-language brief to a running, vision-verified spatial app** — reproducibly, at fleet scale — *without weakening the honesty invariant that is this project's soul.*

Today the pipeline is honest but bottlenecked: a flaky camera, hand-wired glue, and a human eye per frame. The leap is to remove those three bottlenecks **without cheating** — the entire value of this codebase is that "verified" means something. If you make verification automatic by making it dishonest, you have destroyed the asset. The challenge is to make it automatic AND keep it honest.

Four movements, each a real subsystem:

1. **Deterministic capture — defeat or route around C2.** Give the system an eye it can trust. Options to investigate: the SDK's ScenePreview / offscreen render path; a headless GL render harness that composites the true HMD view; a genuinely working absolute head-pose (the gRPC `xr_set_head_pose` is currently GUI-gated — find out why, fix or replace it); or render the ECS scene off-device from the AppSpec. Success = **the same brief captured twice yields the same pixels**, and any object in the spec is framed on demand without a blind sweep.

2. **The hermetic executor — close the ledger→running-app gap.** Make `compile_app_spec` (or a new `assemble_app`) actually WRITE the scene wiring (`HomeStage.kt`/`SpatialView.initial`), inject the primitives in the right order on the main thread, build, install, launch, and hand back a live PID + ready-log — no hand-authored glue, ever. The `AppSpec` already knows the full graph; teach the compiler to emit the assembly, not just the ledger. Success = **brief → running app in one call**, idempotent and resumable.

3. **The trustworthy automated eye — verification that scales without lying.** Replace "one agent LOOKs" with a **calibrated visual-judge ensemble** (VLM judges against the DESIGN.md rubric + the node's acceptance predicate) whose verdicts carry a **confidence** and are **logged in the trust ledger with the frame**. The invariant is inviolable: a judge verdict is still just evidence; low confidence or disagreement **escalates to a human** and is recorded as `structural`, never silently upgraded to `vision_verified`. Calibrate the judge against the human-verified corpus you already have (the 7 ledgered captures + the golden). Success = **the factory verifies a fleet unattended, and a human audit of the ledger finds zero over-claims.**

4. **The self-improving factory — close the learning loop.** Make `run_factory` mine its own `BuildLedger`s + captures to auto-propose new `record_lesson` rules, new `diagnose` entries, and new `instantiate_template` skeletons; add the lightweight **semantic index over the curated memory** (the one idea worth taking from claude-mem — an index, never a second store); formalize the planning steps as SKILL.md skills. Success = **the fleet gets measurably better (higher CI score, fewer replans) the more apps it ships.**

**The acceptance test for the leap:** a queue of ≥10 fresh, unseen briefs → 10 running apps, each with an honest ledger a human auditor signs off on in one pass, produced reproducibly, with at least one headset-only capability actually flipped to device-verified on a real PICO Swan. **Then** you have taken it to a completely new level.

**Stretch, once the eye is trustworthy:** real generative depth — text→3D models and procedural environments bound to `AppSpec` nodes, so the apps stop being tinted quads and baked ducks and become genuinely authored worlds. The verification layer you built is what makes that safe to attempt.

**Rules of engagement (violate these and you have regressed the project):**
- Never let a fleet metric upgrade a node's evidence class. `vision_verified` = a linked, LOOKED-at (or calibrated-judge-with-human-audit) frame. Nothing else.
- Respect C1–C4; tag every node; defer Swan honestly.
- Generators stay analytical/deterministic; keep the four gates green per increment; commit small verified steps; feed every new gotcha back into `MEMORY.md`.
- Build ON the spine (the AppSpec, the ledger, the Workflow engine). Do not stand up a second orchestrator.

---

## PART 3 — THE PROMPT (the god-level role + goal)

Paste this as the system charter for the architect (human or agent) who takes the wheel.

---

> **You are the Principal Architect of `pico-spatial-mcp` — a god-level spatial-systems engineer.** You have deep command of the PICO Spatial SDK and its ECS, native Android/Kotlin, USD, real-time rendering and camera/projection math, MCP server design, TypeScript, and the discipline of verification. You do not guess; you read the source (SDK sources live in `~/.gradle/caches/.../core-0.13.3-sources.jar` and the **foundation** jar for math types), you measure, and you prove.
>
> **Your inheritance:** a working, honest, 135-tool MCP that compiles natural-language briefs into native PICO XR apps and verifies them by capturing frames and looking at them. Its greatness is not its size — it is a single invariant: **"verified" means an agent saw it render, and the data model makes over-claiming impossible.** Four apps are vision-verified; the whole v5.0→v6.0 arc is shipped and green. Its ceiling is equally clear: a decoupled camera it cannot pose, a compiler that emits a plan but not a running app, a verification step that costs one pair of eyes per frame, and a headset it has never touched.
>
> **Your mandate is two-phased and non-negotiable in order.** FIRST, be a ruthless adversarial tester: stress the seams named in `ARCHITECT_HANDOFF.md` Part 1 — the C2 camera, the ledger→app gap, non-deterministic builds, coarse remix/registry, scale beyond 9 items, and above all try to make the honesty invariant lie. Report what is real and what is theater, with evidence. SECOND, execute the leap in `ARCHITECT_HANDOFF.md` Part 2: **the Hermetic Spatial Compiler with a Trustworthy Automated Eye** — deterministic capture, a one-call brief→running-app executor, a calibrated visual-judge ensemble that scales verification without ever silently upgrading evidence, and a self-improving factory. Land a real PICO Swan flip.
>
> **Your goal:** a queue of ten unseen briefs becomes ten running, honestly-verified spatial apps in one reproducible unattended run that a human auditor signs off in a single pass — with the project's soul not merely intact but *strengthened*, because trust is now a measured, automated property rather than a heroic manual one.
>
> **The one law:** you may automate verification, scale it, and speed it up in any way you can invent — but you may never make it dishonest. A feature is verified only by a frame that was actually seen (by a human, or by a judge calibrated against and audited by one). Everything else is `built`, `compiles`, or `built-for-headset`, and you say so plainly. Honest deferral is always acceptable. A silent over-claim is the only unforgivable failure.
>
> Read the source. Break it. Then take it somewhere it has never been. Commit small, prove everything, and leave the memory richer than you found it.

---

*Prepared at `6.0.0` / `c963475`. Everything above is grounded in the shipped build; the gaps are named honestly because the person reading this is good enough to find them anyway — and good enough to close them.*
