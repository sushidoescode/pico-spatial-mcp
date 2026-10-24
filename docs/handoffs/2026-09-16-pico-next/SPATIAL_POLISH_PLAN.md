# PICO spatial UI polish implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans when available to implement this plan task-by-task. The user has requested autonomous execution through the companion prompt; do not reopen routine implementation approval menus.

**Goal:** Deliver a reusable, opt-in native SpatialUI polish skill and component kit with a working emulator/headset showcase.

**Architecture:** Add repository-owned skill resources and one canonical Kotlin library. A separate app consumes that library; existing generators stay compatible. Public native materials are the default, and measured optional enhancements stay behind an explicit quality setting.

**Tech stack:** TypeScript/Node MCP packaging, Kotlin/Compose/PICO SpatialUI from resolved SDK 6.1 artifacts, current verified CLI and MCP from Chat A.

**Spec:** [SPATIAL_POLISH_DESIGN.md](SPATIAL_POLISH_DESIGN.md).

## Global constraints

- Carry forward [Chat A's operating and device constraints](MCP_ACTIVATION_HANDOFF.md).
- Mission Replay stays paused. Root alone owns native operations across both chats.
- Read-only doctor first; actual active stack identity must match the accepted continuation.
- No vendor-cache edits, global default theme switch, new mandatory MCP door, or silent legacy-generator rewrite.
- Native material support and exact declarations precede implementation; do not invent an Apple glass API.
- Preserve evidence, correct target identity, explicit device routing, and all emulator health/retry requirements.
- No test may contact hardware during a fixture RED phase. Build before dist-importing tests.
- Use meaningful component/packaging/behavior tests; avoid tests that merely repeat token values or assert prose.
- Never represent structural, simulated-input or host-rendered evidence as observed device interaction.

## File map

Create in the MCP continuation worktree:
- skills/spatial-ui-polish/SKILL.md — concise trigger, routing and decision process.
- skills/spatial-ui-polish/references/native-glass-contract.md — supported materials, layer ownership, version caveats.
- skills/spatial-ui-polish/references/component-catalog.md — composition examples and state/semantics contracts.
- skills/spatial-ui-polish/references/acceptance.md — visual/motion/device evaluation and evidence limits.
- skills/spatial-ui-polish/references/sdk-source-map.json — exact API/dependency provenance.
- skills/spatial-ui-polish/CHANGELOG.md — skill/component compatibility changes.
- skills/spatial-ui-polish/resources/polish/build.gradle.kts — reusable Android library module.
- skills/spatial-ui-polish/resources/polish/src/main/kotlin/dev/local/picopolish/ — original components listed below.
- test/spatial-polish-package.mjs — artifact-contained resource and relative-reference checks.
- test/fixtures/spatial-polish/ — hermetic packaging and unsupported-version fixtures.
- docs/findings/SPATIAL_UI_POLISH_CHECKPOINT.md — current evidence and continuation.

Potentially modify only when needed:
- package.json allowlist/scripts, scripts/gate-inventory.mjs, .github/workflows/gates.yml.
- .claude-plugin/plugin.json, .codex-plugin/plugin.json, .cursor-plugin/plugin.json and metadata sync only where the host schema requires a skill declaration.
- SKILLS.md, DESIGN.md, docs/HOSTS.md for concise opt-in routing.
- scripts/verify-tarball.mjs if needed to verify shipped skill/module resources.

Demo path: reuse Chat A's isolated /Users/sushantsrikrish/AndroidStudioProjects/pico-ui-polish-lab when applicable. App package: dev.local.picouipolish.lab unless a collision required a fresh package. The demo settings include the canonical :polish module through an explicit local path setting; no user-specific absolute path ships inside the library. Document a portable vendoring procedure with version/hash provenance.

Do not modify src/components.ts's byte-compatible legacy card/menu/list generators, src/subwindow.ts, src/attachmentpanel.ts or appskeleton merely to make this new feature universal. Do not use the existing DemoPanel as the polished baseline without source/design review.

## Task 1 — establish capability and the execution base

Consumes: Chat A checkpoint, actual host/device identity and design spec.
Produces: source map, capability decision and safe project/module ownership.

- [ ] Read current repository rules, Chat A checkpoint, official applicable skills and local resolved SDK declarations.
- [ ] Create an isolated polish branch from Chat A's accepted result. Reconcile any newer changes; preserve f349eaf and its archive.
- [ ] Record exact plugin, SDK tools, Gradle/BOM, UI artifacts, sources and runtime identities.
- [ ] For each needed API record source archive hash, archive member/line citation, signature, effective default and runtime support limits. Specifically resolve WindowContainer material inheritance, Thin window behavior, foreground provision and built-in hover ownership.
- [ ] Classify effects as supported and native-tested, declared but untested, or unavailable. Native glass must not depend on custom refraction.
- [ ] Reserve fresh evidence identifiers and record which session owns native operations. If Chat A is unfinished, continue only independent host work until ownership transfers.
- [ ] Review the capability decision independently; commit the source map and bounded execution ledger.

The first task deliberately resolves API details before Kotlin implementation. Its output is the code-level dependency contract; subsequent tasks must cite it rather than guessing overloads from this planning document.

## Task 2 — evaluate and author the additive skill

Consumes: Task 1 source map and official design contract.
Produces: portable skill, concise references and baseline/evaluation evidence.

- [ ] Give a fresh agent four sandboxed tasks without the new skill: rounded glass button, secondary window, reduced-transparency settings screen, and a request for unsupported Apple-style refraction. Deny CLI/device execution in these fixture scenarios.
- [ ] Record actual omissions or contradictions; do not force an artificial failure if the baseline already succeeds.
- [ ] Write the skill using writing-skills/skill-creator guidance available in the target host. Trigger only for native SpatialUI polish; route whole-app scaffolding and scene authoring to the official workflows.
- [ ] Include the source-backed exceptions/caveats discovered in Task 1, original component recipes, evidence limits and reduced-settings decisions. Keep large references out of the entrypoint.
- [ ] Repeat matched tasks with the skill using fresh agents; compare API correctness, background ownership, semantics, legibility planning and honesty about unsupported effects.
- [ ] Require zero invented APIs, wrong-target commands, double-hover cases or unqualified device claims. Fix actual failures and re-evaluate only affected cases.
- [ ] Independently review usefulness and scope; commit the skill and evaluation results.

Do not copy vendor skills into the package or patch cache files. Explicitly report missing upstream dependencies instead of claiming they were loaded.

## Task 3 — implement the native theme and reusable surfaces

Consumes: capability map and skill contract.
Produces: one compiling :polish module, theme, surface and button family.

Owned Kotlin files:
- PolishOptions.kt — independent quality and accessibility policy.
- PolishTokens.kt — semantic product tokens and layout/motion defaults.
- PolishTheme.kt — complete verified PicoTheme role mapping.
- PolishSurface.kt — shaped inner surfaces with explicit material ownership.
- PolishButton.kt — native button wrappers preserving interaction/semantics.
- PolishWindowContent.kt — content composition only; no hidden container creation.

Proposed project-owned option contract (not a PICO API):

```kotlin
enum class PolishQuality { Native, Enhanced }
data class PolishOptions(
    val quality: PolishQuality = PolishQuality.Native,
    val reduceMotion: Boolean = false,
    val reduceTransparency: Boolean = false,
    val increaseContrast: Boolean = false,
)
```

- [ ] Resolve and pin the module's real build dependencies; configure a portable module reference in the demo.
- [ ] Write behavior tests for enabled/disabled clicks, loading suppression, selection semantics and option fallback before changing those behaviors.
- [ ] Implement theme and surface ownership using the mapped APIs; test ordinary-surface text without relying on inherited foreground.
- [ ] Wrap supported built-in buttons, using their existing hover/indication/haptics once. Keep enabled, loading, state and callbacks visible in the wrapper API.
- [ ] Render rounded material with a shared clip/border shape; ensure hit bounds match visible bounds.
- [ ] Make Enhanced fall back to Native when its prerequisite is unavailable. Every supported quality/accessibility combination remains usable; cover pairwise interactions and the combined reduced-motion/transparency/increased-contrast case.
- [ ] Compile and run applicable unit/Compose tests; run the official style verifier with the complete declared palette, not a no-colors bypass.
- [ ] Independently review source/API correctness and state behavior; commit.

Add targeted regression tests for black-on-dark ordinary Text, doubled hover, reduced-transparency ownership and disabled-action activation. A raster golden by itself does not prove these interaction behaviors.

## Task 4 — build the functional showcase and extend components

Consumes: Task 3 module.
Produces: two real app flows sharing the same components.

Additional Kotlin files in the module: PolishToolbar.kt, PolishControls.kt and PolishField.kt. Keep dialog/window lifecycle in the app. Use verified built-ins where a bespoke wrapper adds no value.

- [ ] Implement the library/browser flow with selection, toolbar, details and dismissible secondary surface.
- [ ] Implement the settings flow with real toggle/slider/edit operations, accent options and persisted reduced settings.
- [ ] Add stock/native-polished/optional-enhanced comparisons using identical content and geometry.
- [ ] Add development-only state gallery and stress cases: long text, larger text, bright/dark/detailed backgrounds and supported window sizes.
- [ ] Prove both flows share the module, not copied implementations. Preserve useful defaults for another app.
- [ ] Run functional state tests and style checks after building. Keep test controls out of exported components.
- [ ] Review layout and interactions independently; commit before native iteration.

## Task 5 — package, register and prove discovery

Consumes: versioned skill/module.
Produces: installable local package and host discovery evidence.

- [ ] Add the owned skills directory to package.json's explicit package allowlist. Verify source resources, references and module files survive pack/install.
- [ ] Add a hermetic package test that reads the installed artifact, parses SKILL.md metadata, resolves each relative reference inside the package, rejects escapes/missing resources and proves the module payload is included.
- [ ] Add a negative fixture with one missing referenced file and one unsupported SDK mapping; ensure diagnostics identify the specific defect without invoking native tools.
- [ ] Register the test using repository gate inventory/CI conventions; keep the fixture device pin enforced.
- [ ] Read each installed host's actual plugin schema/help and configure supported local skill discovery. Do not assume all three hosts share manifest keys.
- [ ] Run real skill discovery/invocation in available Claude/Codex/Cursor hosts with exact version/source receipts. Keep uninstalled/unavailable hosts pending.
- [ ] Bump/synchronize package metadata according to release rules, create a fresh archive and receipt, and preserve prior archives. Add documentation links only after their targets exist.
- [ ] Review packaging and routing; commit.

No new tool-count change should be required for this first skill release. If a new tool becomes necessary, justify its benefit before adding interface and metadata maintenance.

## Task 6 — native visual, interaction and performance iteration

Consumes: packaged skill/module and exact showcase build.
Produces: target-specific native comparisons, functional evidence and measured budgets.

- [ ] Establish actual physical model, ABI/runtime and explicit serial. Reuse Chat A's routing proof; inspect nested targets for any changed route.
- [ ] Use fresh package/APK/build identities. Build target-compatible variants from the same source when emulator and physical ABIs differ.
- [ ] Admit every emulator operation through the unchanged health/visibility gate. A held emulator does not prevent independent physical testing.
- [ ] On each target install/launch only the showcase and perform the real UI paths. Retain before/action/after captures and event correlation; debug state injection is supplemental only.
- [ ] Open every visual frame and inspect motion recordings. Review both eye outputs when the available capture route supports them; do not invent stereo verification from a single composited image.
- [ ] Ask the wearer only for observations automation cannot supply: depth/comfort, readability at actual viewing distance, reachability, input precision and haptic feel. Continue other work while feedback is pending.
- [ ] Exercise the acceptance matrix and performance protocol in the design spec. Retain all baseline/candidate samples, thermal context and unsupported metrics.
- [ ] Fix the largest demonstrated visual/interaction defect per iteration, keep a before/after comparison, and recheck affected scenarios. Remove optional effects that break readability or the budget.
- [ ] Obtain independent visual review with linked opened native captures. If the reviewer lacks image capability, label its review structural and leave visual judgment pending.
- [ ] Preserve blocked lanes and retry limits. Do not alter thresholds or fake device results to close the task.

Automation may install, launch and capture on the owned headset under the pasted prompt's authorization. Pairing, sign-in and wearing the headset remain user actions, not reasons to stop all useful work.

## Task 7 — release checkpoint and reuse proof

Consumes: reviewed implementation and native evidence.
Produces: a local reusable release candidate and concise adoption guide.

- [ ] Run appropriate final changed-code checks once; broaden only for a new failure or unresolved risk. Record exact revisions and evidence classes.
- [ ] Produce a fresh package/version receipt and confirm the demo's consumed module matches it.
- [ ] Write a minimal adoption recipe for a second app: dependencies, theme injection, container-background ownership, component usage, reduced settings and evidence requirements. Do not retrofit another app during this task.
- [ ] Record checkpoint details in docs/findings/SPATIAL_UI_POLISH_CHECKPOINT.md: module/skill version, source and APK hashes, API matrix, host discovery, emulator admission/hold, physical identity, screenshots/videos, frame statistics, wearer feedback and pending limits.
- [ ] Provide a small comparison set showing stock versus polished controls, a complete window, a secondary surface and reduced settings.
- [ ] Preserve the branch, worktrees, all prior releases and rollback. Do not push. Follow the companion prompt's local integration scope.
- [ ] End with “ready for motion review” when earned; reserve headset acceptance for actual device evidence and completed wearer observations.
