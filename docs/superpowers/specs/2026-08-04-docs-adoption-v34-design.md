# Docs-Adoption Wave v34 Design

**Date:** 2026-08-04

**Status:** Approved

**Scope:** All thirteen items in `.dev/handoffs/PROMPT_2026-08-04_DOCS_ADOPTION_WAVE.md`, filtered against the shipped v33.0/v33.1 state.

## Outcome

v34 turns the ecosystem-document findings into executable safety rails, grounded SDK codegen, multi-host distribution, and evidence-backed answers without reopening completed MR-first work. The full MCP grows from 234 to 239 tools; the doors facade stays at 16. Three coherent deterministic suites grow the checked battery from the truthful v33 baseline of 40 invocations to 43.

The five new tools are:

1. `verify_gradle_config`
2. `build_matrix_report`
3. `generate_subwindow_kotlin`
4. `generate_spatial_gestures_kotlin`
5. `knowledge_api`

Existing `preflight_lint`, `pico_fix`, `preflight_env`, `generate_spatial_ui`, metadata synchronization, and documentation are extended rather than shadowed by duplicate tools.

## Protected v33 baseline

These are invariants, not backlog:

- `meta.stageStyle` defaults to `"1"` (Mixed). Full (`"3"`) remains a first-class explicit opt-in.
- The MR archetypes and remix manifest reading shipped in `01e1269` remain intact.
- `BENCH_CORE` remains frozen and disjoint from `BENCH_MR`.
- `BENCH_MR` remains the current three-brief tier: `mrtable`, `mrpedestal`, and `mrknock`.
- `briefs/calib.json` stays pinned to Full because its calibration has not been proved on passthrough.
- Passthrough count checks remain advisory; only the authored-color lane may auto-pass an MR frame.
- The shipped v33 baseline is 234 tools, 16 doors, and 40 gate invocations. v34 metadata describes only counts that actually exist after integration.
- Existing residuals from the MR wave are not silently promoted into this wave. In particular, medium passthrough thresholds, mrpedestal boot axes, and the one-color hybrid escalation remain separate unless a touched code path requires a truthful correction.

One stale v33-facing description is corrected: the doors facade still says the calibrated eye cannot score passthrough frames. The authored-color lane has since proved that it can, subject to its explicit color/coverage gates.

## Architecture

### 1. Project configuration safety (`verify_gradle_config`)

`src/projectconfig.ts` owns pure parsing and a registered tool. Its default/static mode is read-only. It accepts a trusted project directory, optional module/configuration names, and an explicitly opt-in `resolveTransitives` switch.

The static pass:

- discovers Gradle Kotlin/Groovy files beneath the project without following escaping symlinks;
- verifies all four required PICO Compose-fork exclusions:
  - `androidx.compose.ui:ui`
  - `androidx.compose.ui:ui-graphics`
  - `androidx.compose.ui:ui-text`
  - `androidx.compose.foundation:foundation`
- flags direct declarations of those upstream artifacts;
- locates the launch Activity manifest metadata;
- classifies the metadata family as Stage, WindowContainer, mixed/ambiguous, or absent;
- scans Kotlin application roots for `DefaultStage` and `DefaultWindowContainer`;
- reports a mismatch only for source-grounded contradictions: Stage metadata with a WindowContainer root, or WindowContainer metadata with a Stage root. Ambiguous/multiple roots are warnings, not guessed errors.

The metadata families are grounded before implementation in the 0.13 vault pages `spatial-sdk_Manage Stages_Declare a Stage.md` (`pico.spatial.stage.*` + `DefaultStage`) and `spatial-sdk_Manage WindowContainers_Declare a WindowContainer.md` (`pico.spatial.windowcontainer.*` + `DefaultWindowContainer`). The scanner does not infer an undocumented winner when declarations are mixed.

The optional resolved pass runs the project's Gradle wrapper with a bounded `:<module>:dependencies --configuration <name>` call and parses any forbidden artifacts that remain in the resolved graph, including their visible parent chain. It is clearly described as potentially downloading dependencies, writing Gradle/project caches, and using the network; `preflight_lint` never invokes it implicitly. Static scanning never claims to discover arbitrary transitive dependencies. A missing wrapper, unavailable configuration, timeout, or offline resolution problem returns `resolved.status` as unavailable/error while preserving the static findings.

`preflight_lint` gains an optional `projectDir` path that invokes the same pure audit. Its existing content contract remains backward compatible. `pico_fix` recognizes Compose-fork and container-mode symptoms and returns the exact audit/fix path before generic build advice.

### 2. Known-good build matrix (`build_matrix_report`)

`src/buildmatrix.ts` extracts the packaged `appskeleton` files at call time rather than duplicating values in prose. It reports source paths and observed values for:

- compile/min/target SDK: 35
- Java/JVM target: 11
- AGP: 8.13.2
- Kotlin and Compose plugin: 2.0.0
- PICO BOM: 0.13.3
- ABI: arm64-v8a
- `spatialToolsVersion`: not declared by this skeleton

Every response says this is a measured known-good scaffold matrix, not PICO's support envelope. `docs/BUILD_MATRIX.md` carries the same values and is fixture-checked against the extractor so documentation cannot drift independently.

### 3. pico-cli structured status

`src/picocli.ts` exports a pure envelope parser for `tool_status: SUCCESS | PARTIAL | FAILED`. It preserves the payload and raw diagnostic text and rejects malformed/non-envelope JSON without guessing.

`preflight_env` keeps `pico-cli -v` as its bounded availability/version probe and uses only `pico-cli emulator status --format json` for structured status. Discovery on 2026-08-04 ran that exact command successfully and observed a `SUCCESS` envelope; implementation first records the full shape as a sanitized fixture and rechecks the command's `--help` contract. `PARTIAL` is operational but degraded; `FAILED` is an actionable failure. Neither top-level `pico-cli doctor` nor `pico-cli plugin doctor` is introduced anywhere.

### 4. Subwindow and cross-container generator

`generate_subwindow_kotlin` returns deterministic files plus required manifest notes for a Mixed-default two-container workspace:

- a `DefaultStage` primary root, preserving the repo's MR-first launch model;
- a secondary named `WindowContainer` with exact 0.13.3 `defaultSize`, `ContainerResizeType.ContentSize`, and first-child `Modifier.windowConstraints` usage;
- a source-grounded `Subwindow` attached to the WindowContainer as an augment;
- `LocalSpatialNavigator.current.openWindowContainer(id, tag, bundle)` and matching close calls;
- a stable tag and immutable initial Bundle payload read through `SpatialContainerScope.bundle`;
- explicit app-owned state/command guidance for ongoing updates, because reopening a reused tag with a new Bundle is not proved to refresh the existing instance.

This tool does not revise `panels[].placement: "world"`. SDK 0.13.3 source establishes Subwindow as an attached 360dp augment, not an arbitrary world-positioned panel. The current world-placement deferral therefore remains.

A checked-in demo spec/project fixture composes the generated container lane with a simple Mixed Stage. It stays outside both benchmark tiers until it becomes a stable regression workload.

### 5. Spatial gestures and physical units

`generate_spatial_gestures_kotlin` emits current 0.13.3 APIs for tap, drag, and scale:

- separate `pointerInput(Unit)` blocks because the gesture detectors consume events;
- `TargetEntity.hit(entity)` or a declared target strategy;
- `InteractableComponent` plus a primitive `CollisionComponent`;
- tap routed to the existing `select:<id>`/command channel;
- drag/scale callbacks exposed through the same dispatcher rather than creating a second interaction protocol;
- `LocalPhysicalLengthConverter.current`, `LengthUnit.Meters`, and `LengthUnit.Centimeters` at the UI-to-3D conversion boundary.

The first live demo uses non-rigidbody targets so direct transform gestures do not conflict with physics ownership. It authors at least two distinct saturated colors for a meaningful MR color-key predicate. Compilation and command routing may earn structural evidence; native gesture behavior earns no stronger claim unless it is actually driven and observed.

### 6. SpatialUI vocabulary

`generate_spatial_ui` keeps its existing ordinary-composable card/menu/list contract and adds optional, source-grounded structures for:

- TitleBar
- Toolbar
- TabBar
- Sheet
- Snackbar
- Coachmark/CoachmarkBox
- SegmentControl

It does not emit or own a WindowContainer. Initial geometry, resize type, and root-child `windowConstraints` stay in `generate_subwindow_kotlin`, which composes the ordinary UI content inside its declared secondary container. This avoids reviving the known emulator-inert in-app attachment-panel path.

Before codegen is implemented, every emitted SDK symbol/signature is entered in a checked fixture with its vault documentation or official-sample citation and, where the vault omits composable functions, its exact installed 0.13.3 source-jar entry. The fixture covers Subwindow, LocalSpatialNavigator, Bundle access, windowConstraints, all three gesture detectors, TargetEntity, physical units, and each added component. Unsupported arbitrary component names fail validation instead of falling back to invented Compose.

### 7. Multi-host distribution

The source plugin adds the official-layout counterparts to the existing Claude files:

- `.agents/plugins/marketplace.json`
- `.codex-plugin/plugin.json`
- `.cursor-plugin/marketplace.json`
- `.cursor-plugin/plugin.json`
- `.github/plugin/marketplace.json`
- root `plugin.json` + `mcp.json` portable core
- `.mcp.claude.json` and `mcp.cursor.json` host MCP declarations

Payload manifests follow each current host's active discovery convention. Marketplace source paths are validated from the location of each marketplace file; they are not assumed from examples alone.

`scripts/plugin-bootstrap.mjs` resolves the repository from `import.meta.url`, uses `npm.cmd` on Windows and `npm` elsewhere, conditionally installs/builds, and then spawns `process.execPath dist/index.js` with inherited stdio while forwarding termination signals and the child's exit status. Review established that neither one shared relative launch nor one legacy-host token was portable. Root `plugin.json` + `mcp.json` therefore implement Agent Plugins 1.0.0 with `${PLUGIN_ROOT}` for Codex/Copilot; `.mcp.claude.json` uses Claude's documented `${CLAUDE_PLUGIN_ROOT}`; `mcp.cursor.json` uses a separate `${CURSOR_PLUGIN_ROOT}` declaration and remains structural until live-connected. The duplicate-prone root `.mcp.json` and shadowed `.github/plugin/plugin.json` are absent. Exact portable/Claude forms and the Cursor candidate must pass executable source smokes; unavailable host clients remain honestly documented as unverified. The Bash bootstrap may remain only as a compatibility shim during the transition; manifests prefer Node.

Metadata synchronization and docs-meta tests cover every host copy. Source-marketplace files need not enter the npm `files` allowlist unless tarball validation shows an npm-install use case requires them.

### 8. Knowledge graph adapter

`knowledge_api` is a lazy persistent MCP client over `pico-cli mcp spatial-knowledge`. Persistence is required so `switch_workspace` affects subsequent calls. Calls and startup have bounded timeouts; timeout/transport/protocol failure closes and resets the child so the next request can recover. A valid MCP tool response carrying `isError` is an application-level error, not a protocol failure: it normally returns `status: "error"` and preserves the current child and workspace; the explicit missing-graph form is `unavailable` and also preserves them. The installed provider's production-shaped plain-text `Error executing <action>:` response is classified by the same rule.

The action schema exposes all eight advertised tools without weakening their inputs:

- `query_graph(question, mode?, depth?, token_budget?, max_degree?, query_variants?, sort_by?)`
- `get_node(label)`
- `get_neighbors(label, relation_filter?)`
- `get_community(community_id)`
- `god_nodes(top_n?)`
- `graph_stats()`
- `shortest_path(source, target, max_hops?)`
- `switch_workspace(workspace)`

`preflight_lint` gains an opt-in `knowledgeSecondOpinion` query. Graph results are advisory and never make `clean` false by themselves. `vault_api` remains authoritative for exact symbol declarations and file/line citations; the graph is broader contextual evidence. Missing pico-cli, missing graph data, or a timeout returns `status: "unavailable"` and does not break deterministic lint.

### 9. Emulator installation route

Preflight fixes, README, and QUICKSTART describe both emulator acquisition routes. The new CLI route is grounded in live help:

`pico-cli emulator install [bundleVersion] --source <auto|internal|cn|global> --yes`

The text explicitly says this downloads/updates an emulator bundle; it does not create an AVD and does not install the JDK/Android SDK needed to build apps. No installation is performed automatically by a read-only preflight tool.

### 10. Answers by measurement

`docs/ANSWERED_BY_MEASUREMENT.md` contains only Q5, Q23, Q24, Q25, Q33, and Q36. Each entry includes:

- the narrow answer;
- evidence class/type;
- a stable repository or ledger/handoff citation;
- a “does not prove” boundary.

Q23/Q24 do not pretend the repo has measured a complete ownership or threading contract. Q25 distinguishes raw runtime GLB failure from the proved bake-to-bundle lane. Q33 preserves emulator/device and partner-stated Guardian caveats. Q36 is dated to the 2026-08-01 pico-cli project-create observation.

## Error and safety behavior

- All filesystem tools reject paths outside the selected project/root after realpath checks and avoid following escaping symlinks.
- All external processes have bounded timeouts and bounded captured output.
- No top-level pico-cli doctor command is called.
- Live adb calls always include `-s emulator-5554`; serial `2G0YC5ZF7Z056Q` is never addressed.
- Emulator builds and launches are serialized. Known full-space incumbents are explicitly force-stopped before a launch.
- Generated Kotlin is passed through `preflight_lint` before build.
- Unavailable optional evidence degrades honestly rather than becoming either PASS or failure.

## Testing and verification

Implementation follows red-green-refactor. Three new registered suites cover the coherent slices:

1. `test:adoption-safety` — Gradle/config audit, build matrix extraction, JSON envelopes, pico_fix wiring.
2. `test:spatialui-adoption` — deterministic Kotlin output, exact imports/signatures, constraint/component vocabulary, command bridge, and demo fixture.
3. `test:distribution-adoption` — executable host-manifest/relative-path validation, Node bootstrap behavior, all eight knowledge schemas, timeout/unavailable behavior, emulator-install preflight behavior, and measurement citation-target resolution.

Existing suites are extended where their existing invariant is the better owner. Package scripts and `.github/workflows/gates.yml` remain exact mirrors. The resulting battery is 42 `test:*` scripts plus smoke = 43 invocations, and metadata is synchronized only after the count is real.

Runtime validation:

1. Run `pico_doctor`; recalibrate only immediately before live visual work if reported stale.
2. Generate and lint the two-container/gesture demo in a disposable external project.
3. Build, install, and launch only on `emulator-5554`, one app at a time.
4. Capture the Stage and panel/subwindow views.
5. Open every claimed capture with a vision-capable viewer and judge the visible result.
6. Record `vision_verified` only for what the capture visibly proves; use structural evidence for compilation, Bundle wiring, inventory, and command routing.
7. Run smoke and all 42 deterministic suites before each implementation commit that claims green.

## Commit slices

1. `v34.0: design the stale-filtered docs-adoption wave`
2. `v34.1: make project configuration and build truth executable`
3. `v34.2: generate the measured SpatialUI container and gesture lanes`
4. `v34.3: distribute and query the richer PICO knowledge surface`
5. `v34.4: publish measurement answers and live adoption evidence`

The final handoff is `.dev/handoffs/HANDOFF_2026-08-04_DOCS_ADOPTION.md` and records shipped behavior, exact evidence, honest deferrals, tool/gate counts, and every retained fact.
