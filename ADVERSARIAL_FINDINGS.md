# Adversarial Findings — pico-spatial-mcp @ 6.0.0

**Author:** Principal Architect (Phase 1 of the ARCHITECT_HANDOFF mandate).
**Method:** direct attacks through the real MCP tools over stdio + a 37-agent adversarial workflow (6 seam-attackers → 31 independent skeptic-verifiers). **Verdict tally: 29 CONFIRMED, 2 OVERSTATED, 0 refuted.** Every finding below quotes a real command's output or a `file:line`. Fairness is explicit: what genuinely works is credited.

> **Bottom line.** The generation layer is real and honest; the *verification* layer — the project's soul — is weaker than it advertises. "Over-claims are structurally impossible" is overstated: the trust ledger only proves *a path resolves*, not *a frame was seen*, and the keystone plan-level pipeline trusts an author-supplied capability class verbatim. Two CRITICAL and several HIGH holes let a `vision_verified` claim be recorded that no eye ever saw. None are hidden malice — they are the exact frontier Part 2 exists to close — but until closed, the invariant can lie.

---

## CRITICAL — the honesty invariant can be made to lie

### C1. `record_verification` accepts ANY existing file as "the capture you LOOKED at"
`ledger.ts:62` gates a `vision_verified` entry on `fs.existsSync(artifactPath)` — it proves a path *resolves*, nothing about the pixels.

**Proven live** (attack harness over stdio, `com.attacker.fake` ledger):
- `artifactPath` = a **plain .txt file** → `status: recorded`, `vision_verified`.
- `artifactPath` = **`/etc/hosts`** → `recorded`, `vision_verified`.
- `artifactPath` = a **0-byte `.png`** (`touch`) → `recorded`, `vision_verified`.
- `artifactPath` = a **directory** (`os.tmpdir()`) → `recorded`, `vision_verified`.

`ledger_report(com.attacker.fake)` then returns **"4 visually verified, 0 structural/logcat only"** — four fabricated claims presented as seen-rendering, none linked to a real frame. **Impact:** the ledger the whole ship report is generated from can be fully spoofed; `factory.ts:31` `totalVisionVerifiedInLedger` inherits the lie.

### C2. `verify_app_spec` accepts any non-empty *string* as visual-PASS evidence
`specverify.ts:90` — the over-claim guard is `if (visualMethod && !r.evidence)`. Any truthy string passes; **no file need even exist.**

**Proven live:** a valid AppSpec, one `capture` node, submitted `evidence: "yep looks great lol"` →
`status: PASS · specSatisfaction: 1 · visualClaims {total:1,passed:1}` and the node reported `vision_verified`. Verifier (`verify:scale`) CONFIRMED: "line 90 is the ONLY guard — any truthy evidence string reaches `visualPass++`." **Impact:** the plan-level gate the project markets as its keystone can be passed with a shrug string. This is *weaker* than the ledger (C1) — it doesn't even check the path.

### C3. The C-class stamp is never reconciled — mislabel C3→C0 and Swan-only work reports as emulator-verified
`planner.ts` / `specverify.ts` trust `verificationNode.capabilityClass` **verbatim**. A Swan-only controller-ray (truly C3) or `homeEnvProxy` (truly C1) node relabelled `C0_emulator` sails through `verify_app_spec` as an emulator visual claim — with **zero lint warning** — *even though `plan_app_spec` internally computes the true class and prints it in `emulatorVsSwanPreview.builtForSwan`.* Verifier CONFIRMED (theater). **Impact:** the honest emulator-vs-Swan split — the point of C1–C4 — is defeated by a one-word edit; headset-only capability can be claimed as verified-on-emulator.

### C4. "N cards render" is verified by one forward frame that cannot show N (scale over-claim)
`verify_app_spec` never counts rendered items, and `plan_layout_and_camera` *advises `captures=1`* even when items span 90°+ or fall out of FOV. So "100 cards render" can be stamped `vision_verified` from a frame showing 6. Verifier CONFIRMED (critical). **Impact:** the over-claim scales — the more items, the bigger the lie, with the system's own advice enabling it.

---

## HIGH — real weaknesses / partial theater

- **Legacy `capability_report` is fully ungated** (`capability.ts`): emits a "👁️ Visually verified — seen rendering (agent vision)" section from a caller-supplied `status` with `evidence` **optional/null**, and is **still referenced by the shipping prompt**. A second, older over-claim path beside the ledger. *(theater)*
- **`generate_interactable_registry_kotlin` logs an `INTERACTABLES|` marker that nothing consumes** — `grep INTERACTABLES tools/mouse_menu_bridge.py` = 0; the only bridge is the hardcoded 4-button menu color detector. The "generalized, data-driven mouse bridge" is a marker logged into the void. *(theater)*
- **`import_model_catalog` dataNodeStub is a dead end** — it bakes real bundles, but its documented consumer `generate_data_binding_kotlin` takes no items and emits tinted-quad code that never loads a per-item bundle (`databinding.ts:30-35` inputSchema = `{packageName,cardWidth,cardHeight,defaultColor}` only). Real models never reach a running app end-to-end. *(partial)*
- **`remix_app` is filename-lexical, never parses Kotlin** (`remix.ts:47` `f.toLowerCase().includes(n)`): misclassified a real multi-scene app as single-scene and a data-binding file as a layout in tests. Worse, its diff can emit a **false `unchanged`**, letting a remix skip re-verifying a node that changed while **carrying its prior `vision_verified` forward**. *(partial)*
- **`regression_gate` cannot detect compiler/ledger drift** — the committed `golden/scorecard.json` is **already stale (49 steps vs live 50** after the v5.7 router step) yet `mode=check` returns **PASS**; it compares only per-brief pass booleans + aggregate score, never ledger shape/steps/args/C-classes. *(partial)*
- **`run_brief_suite` 6/6 is near-circular** (`eval.ts:79`): grades a spec's own `array.length`s against hand-authored `expected` counts *in the same file*; the NL `brief` is never read. It catches structural breakage (fair credit) but the "6/6" is largely grading its own homework. *(partial)*
- **`run_factory` "ready_to_build" ≠ built** (`factory.ts:49-55`): = `zod-valid + 0 lint errors + ledger.length>0`, and `buildLedger` unconditionally pushes ≥3 steps, so *any* valid spec is "ready_to_build" though nothing was compiled or run. *(partial)*
- **Arc/grid layout packs unbounded overlap with no warning** — N=100 arc → 4 cm center spacing vs 0.5 m cards (12.6× overlap); N=100 grid → 88/100 slots outside the room (y from −8.5 m to +11.3 m). `plan_layout_and_camera` flags only the one hardcoded home-env BED AABB. *(partial; the bed-only scope is honestly documented — severity softened per OVERSTATED verdict)*

## MEDIUM / LOW (summarized)
- `verify_app_spec` `specSatisfaction` + gate note count evidence-less **logcat asserts** as "vision-verified with linked evidence."
- `regression_gate` PASS note says "scorecard matches golden and frames are identical" when the scorecard does **not** match and **zero** frames were compared; MAE path is ImageMagick-gated and degrades to `UNKNOWN` (still PASS) if `magick` is missing. *(theater / low)*
- `run_factory` dashboard leads with green plan/compile metrics beside `totalVisionVerifiedInLedger:0` — inviting a reader to mistake a plan-passing fleet for verified apps. *(fairness: fields say "verifiable" not "verified"; framing risk, not silent over-claim — per OVERSTATED verdict)*
- `swan_verify_matrix` description says it "drives each test and flips to device-vision-verified," but code only marks `device_pending` (honest in code); its device detection treats **any** non-emulator adb serial (incl. offline/unauthorized) as a Swan.
- `ProductShowcase.kt` (the MEMORY-celebrated v5.0 acceptance demo) is **orphaned dead code** — `HomeStage.kt:33` runs `MultiSceneDemo` instead — yet HomeStage's doc still says "via ProductShowcase." Acceptance artifact and shipped app have drifted.
- No perf/draw-call/poly/frame-budget model exists anywhere (`grep` = 0 hits): a 500-quad app is planned/compiled/"verified" identically to a 6-quad one.

---

## What is REAL and honest (credit where due)
- **`plan_app_spec` + `compile_app_spec` are genuinely byte-stable** across independent cold processes (AppSpec sha `1e847ab8a488`, BuildLedger sha `75c5e8d7e058` identical twice). No RNG/`Date.now`/key-order hazard in the generator path.
- **The `adb screencap` eye is fully deterministic** — I measured it: 3 repeated captures byte-identical (same md5), and **kill+relaunch → MAE = 0** (identical pixels). Content renders in the forward FOV at the default pose; the documented C2 "drift" is a property of the GUI free-cam orbit, **not** this path. *This is the foundation the deterministic-capture leap stands on.*
- **`build_and_run` is a real install→launch→observe tool** and honestly refuses to claim vision (`workflow.ts:221` "build_and_run did NOT look at the frame → nothing is vision_verified").
- **`critique_capture` heuristics cannot flip a node to PASS** — honest by construction (assists only).
- **The trust-ledger *shape* is right** — `built_for_headset`/`structural`/`compiles` record honestly; the gate just needs to actually validate the artifact (C1) and reconcile the class (C3).
- **Data-binding runtime scales linearly** — O(n) loop, O(1)/O(n) lookups, no hidden cap.

---

## The through-line
Every CRITICAL/HIGH-theater finding is one theme: **the system checks that a *token* exists (a path, a string, a self-declared class) and treats that as proof a *frame was seen*.** The fix is not to abandon the ledger — its shape is right — but to make each gate verify the thing it claims: the artifact is a real image bound to this app+claim, the evidence is a real capture path, the capability class is the *computed* one, and the item count matches. That is Phase 2, and it *strengthens* the soul rather than compromising it.
