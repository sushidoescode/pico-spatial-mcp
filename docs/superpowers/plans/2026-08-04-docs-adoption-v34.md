# Docs-Adoption Wave v34 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute Tasks 1–4 sequentially with task-scoped reviews. The controller owns Task 5 because emulator work and visual judgment must stay serialized.

**Goal:** Ship all thirteen docs-adoption backlog items as net-new v34 functionality without reopening or regressing the v33 MR-first pivot.

**Architecture:** Add two safety/report tools, two source-grounded SDK generators, and one persistent knowledge adapter. Extend the existing lint, SpatialUI, preflight, plugin, metadata, and documentation seams rather than creating parallel systems. Keep optional/externally mutating diagnostics explicit, and keep every evidence class no stronger than its proof.

**Tech stack:** TypeScript ESM, Node 22, MCP SDK, Zod, Kotlin code generation for PICO Spatial SDK 0.13.3, JSON plugin manifests, deterministic `.mjs` gates, Gradle/adb only in the serialized live phase.

## Global constraints

- Work only in `/Users/sushantsrikrish/PICO-MCP/.worktrees/docs-adoption-v34` on branch `docs-adoption-v34`.
- Follow strict red-green-refactor. Every new test names an observable break, uses hand-derived expectations, and is seen failing before implementation.
- Run focused tests while iterating. Before every commit, run the full current battery serially: every `test:*` script plus `smoke`.
- No concurrent dist builds, full batteries, Gradle builds, emulator launches, or edits in the shared worktree.
- Mixed (`stageStyle: "1"`) stays the default. Full (`"3"`) stays explicit.
- Do not modify `BENCH_CORE`, `BENCH_MR`, or `briefs/calib.json`.
- Preserve the v33 authored-color MR eye and its passthrough advisory count behavior.
- Never call top-level `pico-cli doctor` or `pico-cli plugin doctor`.
- Static preflight stays read-only. Resolved Gradle dependency analysis is opt-in and says it may write caches/use the network.
- All external processes are bounded. All live adb commands contain `-s emulator-5554`; never address serial `2G0YC5ZF7Z056Q`.
- Never claim a visual result until the capture has been opened and judged. Structural/codegen/compile proof remains structural.
- Update tool counts and gate counts only when the corresponding tools/suites exist. Intermediate commits may truthfully carry intermediate counts.

## Task 1: Make project configuration and build truth executable

**Backlog coverage:** 1, 2, 3, 4; plus the v33 stale doors wording.

**Files:**

- Create: `src/projectconfig.ts`
- Create: `src/buildmatrix.ts`
- Create: `test/adoption-safety.mjs`
- Create: `test/fixtures/picocli/emulator-status-success.json`
- Create: `test/fixtures/picocli/emulator-status-partial.json`
- Create: `test/fixtures/picocli/emulator-status-failed.json`
- Create: `docs/BUILD_MATRIX.md`
- Modify: `src/lint.ts`
- Modify: `src/picocli.ts`
- Modify: `src/preflight.ts`
- Modify: `src/diagnose.ts`
- Modify: `src/doors.ts`
- Modify: `src/index.ts`
- Modify: `src/capabilities.ts`
- Modify: `test/lint.mjs`
- Modify: `test/picocli.mjs`
- Modify: `test/preflight.mjs`
- Modify: `scripts/verify-tarball.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/gates.yml`
- Modify metadata-owned docs through `npm run sync:meta`

### Step 1: Capture the structured CLI contract safely

Run:

```bash
pico-cli emulator status --help
pico-cli emulator status --format json
```

Expected: bounded help and a JSON result envelope; no doctor command. Sanitize machine-specific fields into the three fixtures. Construct PARTIAL and FAILED fixtures from the same complete shape, changing only the status/payload needed to exercise those branches.

### Step 2: Write the failing safety suite

`test/adoption-safety.mjs` must exercise real exported behavior against temporary projects:

- a skeleton-shaped project with all four exclusions passes static audit;
- each missing exclusion is named independently;
- a direct forbidden Compose artifact is an error;
- Stage metadata + `DefaultWindowContainer` is an error;
- WindowContainer metadata + `DefaultStage` is an error;
- matching families pass;
- mixed/duplicate roots are ambiguous warnings, not invented winners;
- an escaping symlink is refused;
- a fake executable Gradle wrapper prints a complete dependency tree and the parser reports a forbidden transitive artifact with its visible parent chain;
- `resolveTransitives: false` never launches the wrapper;
- a timeout/nonzero wrapper preserves static findings and returns resolved diagnostic status;
- build matrix extraction returns literal expected values and source paths;
- `spatialToolsVersion` is exactly `status: "not-declared"`, never guessed;
- SUCCESS/PARTIAL/FAILED envelopes normalize to operational/degraded/failed;
- malformed JSON and missing `tool_status` are explicit parse errors;
- the pico-fix decision helper routes Compose/container text to the new diagnostics;
- the stale doors description no longer says Mixed cannot be auto-scored.

Add `test:adoption-safety` to `package.json` and the CI workflow, then run:

```bash
npm run build
node test/adoption-safety.mjs
```

Expected RED: missing modules/exports or failed assertions for the unimplemented behavior. Record the command and representative failure in the task report.

### Step 3: Implement the pure project audit

In `src/projectconfig.ts`, export:

```ts
export const FORBIDDEN_COMPOSE_MODULES: readonly string[];
export function auditProjectConfig(projectDir: string): ProjectConfigAudit;
export function parseResolvedComposeGraph(text: string): ResolvedComposeFinding[];
export async function verifyGradleConfig(input: VerifyGradleConfigInput): Promise<VerifyGradleConfigResult>;
export function registerProjectConfigTools(server: McpServer): void;
```

Required result sections: `static`, `resolved`, `summary`, `evidence`, and `doesNotProve`. Use realpath containment and refuse escaping symlinks. Recognize metadata families from the documented prefixes `pico.spatial.stage.*` and `pico.spatial.windowcontainer.*`. Keep the resolved wrapper process opt-in, bounded, argument-separated, and explicit about cache/network mutation.

### Step 4: Integrate lint and pico-fix

- Add optional `projectDir` to `preflight_lint`; invoke only the static audit.
- Keep content lint backward compatible and keep optional knowledge work out of this task.
- Add source-backed diagnosis entries for Compose-fork conflicts and container-mode mismatch.
- Route `pico_fix` keywords before the generic build branch and return a `verify_gradle_config` next action.
- Extend lint fixtures only for content-level Gradle rules; project behavior remains in the new suite.

### Step 5: Implement the matrix extractor and page

In `src/buildmatrix.ts`, derive values from:

- `appskeleton/gradle/libs.versions.toml`
- `appskeleton/app/build.gradle.kts`

Register `build_matrix_report`. Return observed values, source files, extraction failures, and the exact caveat “known-good scaffold matrix, not the support envelope.” Create `docs/BUILD_MATRIX.md` from the same observed facts, including source links and contradiction context.

### Step 6: Implement the JSON envelope and preflight row

In `src/picocli.ts`, export a total `parsePicoCliEnvelope(raw)` function. Preserve `probePicoCli()` and `-v` semantics. In `src/preflight.ts`, after a successful `-v`, run `emulator status --format json` through the existing injected/bounded IO seam and classify:

- SUCCESS: pass;
- PARTIAL: pass or warn with explicit degraded detail, never failure;
- FAILED: warn with returned diagnostic/fix;
- malformed/unavailable: warn without inventing status.

Tests must verify the exact argv and that neither forbidden doctor command appears.

### Step 7: Register, count, document, and make GREEN

- Register both new tools in the full surface only; doors stay 16.
- Add capability rows with structural evidence ceilings.
- Set `EXPECTED_TOOLS` to 236.
- Correct the stale Mixed-eye doors copy using the shipped authored-color behavior.
- Run `npm run sync:meta` and `npm run test:docsmeta`.

Run focused GREEN:

```bash
npm run build
npm run test:adoption-safety
npm run test:lint
npm run test:picocli
npm run test:preflight
npm run smoke
```

Expected: all pass; smoke lists 236 full tools and 16 doors.

Then run the complete 41-invocation battery serially. Commit only after it passes:

```bash
git add src test docs package.json .github/workflows/gates.yml scripts/verify-tarball.mjs README.md QUICKSTART.md SKILLS.md CAPABILITIES.md plugin.json .claude-plugin
git commit -m "v34.1: make project configuration and build truth executable"
```

### Step 8: Self-review and report

Check mutations: remove one exclusion, swap a root, change PARTIAL to failed, hide `spatialToolsVersion`, or reintroduce a doctor argv; at least one test must fail for each. Write the SDD report with RED/GREEN evidence and the full battery result.

## Task 2: Generate the measured SpatialUI container and gesture lanes

**Backlog coverage:** 5, 6, 7, 8, 9.

**Files:**

- Create: `src/subwindow.ts`
- Create: `src/spatialgestures.ts`
- Create: `test/spatialui-adoption.mjs`
- Create: `test/fixtures/sdk-adoption-provenance.json`
- Create: `examples/docs-adoption-workbench.json`
- Modify: `src/components.ts`
- Modify: `src/index.ts`
- Modify: `src/capabilities.ts`
- Modify: `examples/README.md`
- Modify: `scripts/verify-tarball.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/gates.yml`
- Modify metadata-owned docs through `npm run sync:meta`

### Step 1: Build the provenance fixture before codegen

Read the 0.13 vault documentation and exact source-jar entries for every emitted symbol. The fixture records `symbol`, `import`, `signature`, `sdkVersion`, and `source` for at least:

- `Subwindow`, `SubwindowPlacement`, `ViewPoint`, `DpOffset3D`;
- `DefaultStage`, `WindowContainer`, `LocalSpatialNavigator`, `SpatialContainerScope.bundle`, Bundle/bundleOf;
- `ContainerResizeType.ContentSize`, default size, and both `windowConstraints` overload families;
- `detectSpatialTapGesture`, `detectSpatialDragGesture`, `detectSpatialScaleGesture`, `TargetEntity`;
- `InteractableComponent`, primitive `CollisionComponent`;
- `LocalPhysicalLengthConverter`, `LengthUnit.Meters`, `LengthUnit.Centimeters`;
- TitleBar, Toolbar, TabBar, Sheet, Snackbar, Coachmark/CoachmarkBox, and SegmentControl current call shapes.

Use vault/sample documentation where available and exact jar paths where composable functions are absent from the vault API reference. Do not implement an item whose current signature is not grounded; report the precise blocker instead of guessing.

### Step 2: Write the failing SDK suite

The suite must verify observable generator outputs using literal assertions:

- `generateSubwindowFiles` emits a Mixed `DefaultStage` and one named secondary WindowContainer;
- opening carries exact id/tag/initial Bundle and closing uses the same identity;
- the secondary root reads `bundle`, owns `defaultSize`, and applies `windowConstraints` to its first child;
- emitted Subwindow is attached and its note explicitly denies arbitrary world lock;
- no output changes `panels[].placement: "world"`, `BENCH_CORE`, `BENCH_MR`, or calibration;
- gesture output uses three separate pointer-input blocks, all three detectors, and TargetEntity filtering;
- target setup contains Interactable + primitive collision;
- tap reaches the `select:<id>`/command path;
- physical conversion uses `LengthUnit.Meters`/`.Centimeters`, not stale uppercase names or hand conversion;
- every requested expanded UI kind emits its current source-grounded component;
- unsupported component names fail validation;
- generated Kotlin passes `preflight_lint` without error findings;
- the demo JSON is Mixed, contains two distinct saturated target colors, and is outside benchmark arrays.

Add `test:spatialui-adoption` to package/CI and run:

```bash
npm run build
node test/spatialui-adoption.mjs
```

Expected RED: missing modules/variants.

### Step 3: Implement `generate_subwindow_kotlin`

Export a pure `generateSubwindowFiles(input)` and register the MCP tool. Inputs include package, primary/secondary identifiers, stable tag, payload key/value defaults, initial size/constraints, subwindow side, and component content. Output is `{files, manifestNotes, evidence, doesNotProve}`.

The primary launch root stays `DefaultStage`; the secondary WindowContainer is programmatically opened. Bundle is documented and generated as immutable launch args; ongoing changes use the existing command/app-state channel. Description and emitted comments say Subwindow is an attached augment and does not prove world lock or pixel rendering.

### Step 4: Implement `generate_spatial_gestures_kotlin`

Export a pure generator and registered tool. Use separate pointer-input blocks and exact detector callback signatures. Target a non-rigidbody Entity with InteractableComponent and primitive CollisionComponent. Route tap to the existing command dispatcher; expose drag/scale through named callbacks in that same lane. Convert only at the UI/scene boundary using the physical converter.

### Step 5: Extend ordinary SpatialUI components

Extend the existing `panelSpec` discriminated union and `emitPanel` behavior for the source-proved component kinds. Preserve card/menu/list output byte-for-byte for existing inputs. Do not make `generate_spatial_ui` own a WindowContainer or promise emulator rendering; container constraints stay in `generate_subwindow_kotlin`.

### Step 6: Add the demo recipe and make GREEN

`examples/docs-adoption-workbench.json` is a generator recipe, not a benchmark brief. It names the two tool calls, Mixed stage, two saturated colors, expected structural checks, and visual claims requiring a LOOK. Document it in `examples/README.md`.

- Register two new tools; set `EXPECTED_TOOLS` to 238.
- Add structural capability rows.
- Sync metadata; the battery becomes 41 `test:*` suites + smoke = 42.

Run focused GREEN:

```bash
npm run build
npm run test:spatialui-adoption
npm run test:lint
npm run test:copilot
npm run test:docsmeta
npm run smoke
```

Then run the complete 42-invocation battery serially and commit:

```bash
git add src test examples docs package.json .github/workflows/gates.yml scripts/verify-tarball.mjs README.md QUICKSTART.md SKILLS.md CAPABILITIES.md plugin.json .claude-plugin
git commit -m "v34.2: generate the measured SpatialUI container and gesture lanes"
```

### Step 7: Self-review and report

Mutation check: collapse gesture blocks, change TargetEntity, remove the Bundle read, use uppercase units, make the Stage Full, or claim world lock; tests must catch each. Report grounded source paths and any component honestly deferred due to signature ambiguity.

## Task 3: Distribute and query the richer PICO knowledge surface

**Backlog coverage:** 10, 11, 12.

**Files:**

- Create: `src/knowledge.ts`
- Create: `scripts/plugin-bootstrap.mjs`
- Create: `.agents/plugins/marketplace.json`
- Create: `.codex-plugin/plugin.json`
- Create: `.cursor-plugin/marketplace.json`
- Create: `.cursor-plugin/plugin.json`
- Create: `.github/plugin/marketplace.json`
- Create: `.github/plugin/plugin.json`
- Create: `test/distribution-adoption.mjs`
- Create: `test/fixtures/fake-knowledge-server.mjs`
- Modify: `.mcp.json`
- Modify: `scripts/plugin-bootstrap.sh`
- Modify: `scripts/sync-metadata.mjs`
- Modify: `test/docsmeta.mjs`
- Modify: `src/lint.ts`
- Modify: `src/preflight.ts`
- Modify: `src/index.ts`
- Modify: `src/capabilities.ts`
- Modify: `PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md` if tracked; otherwise update the tracked plugin-facing equivalent and public docs
- Modify: `README.md`
- Modify: `QUICKSTART.md`
- Modify: `GETTING_STARTED.md`
- Modify: `docs/HOSTS.md`
- Modify: `scripts/verify-tarball.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/gates.yml`

### Step 1: Ground and validate host formats

Read the plugin-creator references before editing manifests. Compare every new file with the cached official PICO plugin. Validate the repo-root relative source paths from the marketplace file locations; do not invent host root environment variables.

### Step 2: Write the failing distribution suite

The suite must execute behavior, not grep prose:

- parse every host manifest/marketplace and resolve each declared skills/MCP path to a real repo artifact;
- verify metadata identity/version consistency across host copies;
- run the Node bootstrap's exported decision helpers from a path containing spaces/non-ASCII;
- verify `npm.cmd` on Windows and `npm` elsewhere;
- verify install/build is skipped only when both runtime prerequisites exist;
- verify child argv, inherited stdio contract, signal forwarding, and exit propagation with injected real child processes;
- start the fake MCP server over stdio through the production knowledge client;
- call all eight actions with complete real-shaped payloads;
- prove `switch_workspace` persists into a later graph call;
- prove timeouts/protocol failures reset the child and return unavailable;
- prove missing pico-cli degrades without affecting lint `clean`;
- prove opt-in lint calls `query_graph` and labels it advisory;
- prove preflight's emulator acquisition fix exposes the verified install command while saying it does not create an AVD/toolchain;
- resolve every new measurement/document citation target.

Add `test:distribution-adoption` to package/CI and run:

```bash
npm run build
node test/distribution-adoption.mjs
```

Expected RED: absent host files/bootstrap/knowledge module.

### Step 3: Implement the Node bootstrap and manifests

`scripts/plugin-bootstrap.mjs` exports pure decision helpers and a main path. Resolve root from `import.meta.url`; run bounded npm install/build only when needed; then spawn `process.execPath dist/index.js` with inherited stdio, forward SIGINT/SIGTERM, and propagate exit status. Keep the shell file only as a Node-invoking compatibility shim.

Create exact Codex/Cursor/Copilot payload and marketplace manifests. Point all to the shared `.mcp.json`, which uses a relative Node bootstrap and no `${CLAUDE_PLUGIN_ROOT}`. Extend metadata sync/checks for every copy. A cold source-plugin smoke from a hostile temporary path must pass before claiming that host layout; unavailable host clients remain documented as structurally validated, not live-installed.

### Step 4: Implement persistent `knowledge_api`

In `src/knowledge.ts`, provide:

```ts
export type KnowledgeAction = "query_graph" | "get_node" | "get_neighbors" | "get_community" | "god_nodes" | "graph_stats" | "shortest_path" | "switch_workspace";
export class KnowledgeBridge { call(action: KnowledgeAction, input: unknown): Promise<KnowledgeResult>; close(): Promise<void>; }
export function registerKnowledgeTools(server: McpServer): void;
```

Use a lazy persistent MCP `Client`/`StdioClientTransport` launched as `pico-cli mcp spatial-knowledge`. Validate the exact eight input schemas discovered on 2026-08-04. Bound startup/calls, cap returned text, close/reset on error, and preserve switch-workspace state. Register one `knowledge_api` tool with action-specific validation and clear unavailable results.

Add optional `knowledgeSecondOpinion` to `preflight_lint`. Only `query_graph` participates automatically, only when explicitly requested. Return it in a separate advisory block; never let it change `clean` or override `vault_api` exact-symbol truth.

### Step 5: Add the emulator bundle route

Update preflight structured fixes and public docs using the verified command:

```text
pico-cli emulator install [bundleVersion] --source <auto|internal|cn|global> --yes
```

Keep JDK/Android SDK/Gradle requirements distinct. Say explicitly that `install` downloads/updates a bundle but does not create an AVD. Do not auto-run installation from preflight.

### Step 6: Register, count, make GREEN, and commit

- Register `knowledge_api`; set `EXPECTED_TOOLS` to 239.
- Expand the plugin-facing knowledge table from two to all eight actions.
- Add capability/evidence notes.
- Sync all metadata; final battery becomes 42 `test:*` suites + smoke = 43.

Run focused GREEN:

```bash
npm run build
npm run test:distribution-adoption
npm run test:lint
npm run test:preflight
npm run test:docsmeta
npm run test:tarball
npm run smoke
```

Run the complete 43-invocation battery serially and commit:

```bash
git add .agents .codex-plugin .cursor-plugin .github/plugin .mcp.json scripts src test docs README.md QUICKSTART.md GETTING_STARTED.md package.json .github/workflows/gates.yml SKILLS.md CAPABILITIES.md plugin.json .claude-plugin
git commit -m "v34.3: distribute and query the richer PICO knowledge surface"
```

### Step 7: Self-review and report

Mutation check: wrong marketplace path, Bash-only command, lost child exit, per-call knowledge process, missing eighth action, graph result changing lint clean, or emulator text implying AVD creation. Each behavior must be covered.

## Task 4: Publish answers by measurement and close documentation truth

**Backlog coverage:** 13 and cross-wave documentation/count integration.

**Files:**

- Create: `docs/ANSWERED_BY_MEASUREMENT.md`
- Modify: `README.md`
- Modify: `SKILLS.md`
- Modify: `CAPABILITIES.md`
- Modify: `docs/COLLABORATORS.md`
- Modify: `docs/HOSTS.md`
- Modify: `docs/DEMO_RUNBOOK.md` only if a stable adoption link belongs there
- Modify: `test/distribution-adoption.mjs` only for behavior/citation-resolution gaps found RED
- Modify metadata-owned files through `npm run sync:meta`

### Step 1: Inventory stable evidence

Use tracked repository evidence plus the local trust ledgers/handoffs. Do not cite gitignored drafts as public authority. For each question, record a narrow answer, evidence type/class, stable citation, and “does not prove” boundary:

- Q5: arm64-v8a is the known-good scaffold ABI; no broader device ABI support claim.
- Q23: measured AssetBundle reuse/entity instancing and explicit app-owned teardown facts; no complete SDK ownership table.
- Q24: measured main-thread retained-entity mutation and broadcast marshaling; no complete threading contract.
- Q25: raw runtime GLB failure versus proved bake-to-bundle lane.
- Q33: CAPABILITIES emulator/device split, simulated planes, device deferrals, and partner-stated Full Space Guardian caveat.
- Q36: dated 2026-08-01 pico-cli project-create proof.

### Step 2: Write the page and expose it

Create `docs/ANSWERED_BY_MEASUREMENT.md` with only those six questions. Link it from README/SKILLS/CAPABILITIES where useful. Keep measured, structural, source-derived, and partner-stated evidence visibly distinct.

### Step 3: Verify citation behavior and metadata

Run:

```bash
npm run build
npm run test:distribution-adoption
npm run sync:meta
npm run test:docsmeta
npm run smoke
```

Expected: every relative citation resolves, counts are 239 tools / 16 doors / 43 invocations, and no stale 220+/234/40 current-state claim survives outside historical context.

Run the complete 43-invocation battery serially and commit:

```bash
git add docs README.md SKILLS.md CAPABILITIES.md test plugin.json .claude-plugin .codex-plugin .cursor-plugin .github/plugin .agents package.json .github/workflows/gates.yml scripts/verify-tarball.mjs
git commit -m "v34.4: publish the questions answered by measurement"
```

### Step 4: Self-review and report

Mutation check: remove a citation target, turn a narrow fact into a complete-contract claim, call partner-stated device behavior measured, or erase an emulator/device caveat. The citation resolver catches broken targets; review catches semantic overclaims.

## Task 5: Run serialized live proof, final review, and handoff

**Controller-owned. Do not delegate emulator execution or final visual judgment.**

**Files:**

- Modify tool descriptions/docs only if live evidence changes the honest ceiling
- Create local: `.dev/handoffs/HANDOFF_2026-08-04_DOCS_ADOPTION.md`
- Update local trust ledgers only through `record_verification`

### Step 1: Recheck environment and calibrate only when needed

Run:

```bash
node .dev/call-tool.mjs pico_doctor '{}'
```

from the main repo helper if the ignored `.dev` helper is absent in the worktree. If calibration is stale immediately before capture, run the documented calibration tool against `emulator-5554`. Do not guess fixes; feed errors to `pico_fix`.

### Step 2: Generate a disposable adoption demo

Outside the repository, scaffold a fresh Mixed app. Drive the new subwindow and gesture tools, write every returned file, merge only documented manifest entries, and run `preflight_lint` plus `verify_gradle_config` static mode. Use at least two saturated authored target colors.

### Step 3: Build and launch safely

Explicitly force-stop, on `emulator-5554` only:

- `com.picoagent.missiontower`
- `com.picoagent.rocketsim`
- installed `com.fleet.*` incumbents resolved from an emulator-only package list

Build/install/launch one app at a time with a long bounded MCP client. Capture the Stage and panel/subwindow views. Attempt only supported emulator/mouse bridge gesture driving; never translate absence into a Swan claim.

### Step 4: LOOK and record the earned evidence

Open every capture with vision. Record:

- visible Mixed scene/content and attached panel/subwindow only if actually seen;
- structural evidence for generated signatures, Bundle wiring, container inventory, and command routing;
- native gesture behavior only if an input is driven and its visible state change is observed.

Record `vision_verified` only with linked captures. If Subwindow/container behavior fails or is invisible, record the failure/defer write-up with paths and logs instead of weakening the criterion.

### Step 5: Live knowledge and plugin smokes

Boundedly call `knowledge_api` for `graph_stats`, `query_graph`, and a `switch_workspace`/follow-up sequence; close the child. Run source-plugin cold smokes for hosts actually available. Report unavailable host clients as structurally validated only.

### Step 6: Whole-branch review and fixes

Request a broad review of `7254287..HEAD` for spec compliance, code quality, security, evidence honesty, and v33 regression. Resolve every Critical/Important finding with focused tests and scoped re-review.

### Step 7: Final verification and handoff

Run from a clean worktree:

```bash
git diff --check
npm run build
```

Then run all 42 `test:*` scripts plus smoke serially. Confirm `BATTERY 43/43 PASS`, 239 full tools, 16 doors, clean metadata, and a clean `git status` except the intentionally ignored local handoff/ledger artifacts.

Write `.dev/handoffs/HANDOFF_2026-08-04_DOCS_ADOPTION.md` in the main repo's local handoff store with:

- commits and counts;
- all thirteen shipped mappings;
- exact live commands and capture paths;
- ledger app/sequence entries;
- measured versus structural versus source-derived facts;
- honest deferrals and known residuals;
- retained v33 invariants.

Use `superpowers:finishing-a-development-branch` to present integration choices. Do not merge into main without the user's explicit choice.
