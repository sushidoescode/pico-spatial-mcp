# Task S2 — Make doctor and pack operations use the same selection

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-sdk-2026-09-15` (branch `track/cli050-sdk`)
Commit: `7b41699` — `fix: bind doctor and packers to selected project tools`
Base: `07e1246` (S1 + fix round 1). Not pushed. Trailer verified on the commit object.

## What I implemented

### `src/preflight.ts` — the `pico-sdk` row comes from the structural selection

`PreflightIO` gains three injected fields, all optional so existing fixtures keep working:

- `toolchainInspection?: ToolchainSelection` — the packer (build-SDK) selection. This is the field
  the brief's snippet sets.
- `emulatorInspection?: ToolchainSelection` — a **separate** structural request, per controller
  resolution 1, so a 6.1-packer/6.0-emulator host reports each component's own version and root
  instead of collapsing to one "unavailable".
- `adbInspection?: ToolchainSelection` — see the ADB note below.

`defaultIO()` computes all three with `resolveHostToolchain({required:[…]})` **before**
`runPreflightChecks` runs. Nothing is launched to produce them; version probing stays in
`validate_toolchain`.

The row itself (`picoSdkCheck`):

| state | status | detail |
| --- | --- | --- |
| packer ok | `pass` | `packer 6.1 from PICO_HOME /sdk; emulator 6.0 from PICO_HOME /sdk` |
| packer unavailable/ambiguous | `fail` | the resolver's own code + detail for both components |
| no inspection injected (fixtures only) | `unknown` | says so, and carries a pointed fix |

The legacy `statMtimeMs(<PICO_HOME|home>/…/0.13)` check is **deleted**, so an existing empty `0.13`
directory can no longer make an unavailable selection pass. The detail can only ever contain a
version the resolver actually selected, which is what makes the brief's `doesNotMatch(/0\.13/)`
assertion a real gate rather than a coincidence.

Side finding worth recording: the old row read `process.env.PICO_HOME` directly, so the *fixture*
rows in `test/preflight.mjs` were reporting this host's real `PICO_HOME` path
(`/Users/sushantsrikrish/Library/PICO/sdk/0.13`) — visible in the RED output below. That leak is
gone; the row is now purely a function of its injected input.

### `src/toolchain.ts` — the operation-scoped seam (new, ~230 lines)

Consumers import all of this from `toolchain.ts`; `toolchainselection.ts` stays pure.

- `resolveOperationToolchain(request, io = hostToolchainIO())` — **structural and process-free**:
  validates any supplied `androidProjectRoot`, resolves the component-valid selection, and
  identifies an explicit `$PICO_SPATIALBUNDLE` override by reading its bytes. Returns
  `OperationToolchain { selection, selectionUnavailable, binaryOverride, bin, component,
  pinnedVersion }` or a structured `UnusableToolchain`.
- `verifyOperationOverride(context, probe = defaultOverrideProbe)` — the only async part, and the
  only thing that can launch anything. It runs **only** when an explicit pin *and* an explicit
  override are both present, through `run(bin, ["--version"], {timeoutMs: 15_000})`, the same
  bounded boundary `validateToolchain` already uses.
- `toolchainProvenance(ctx)` / `toolchainProvenanceLine(ctx)` — what every result discloses.
- `ANDROID_PROJECT_MARKERS`, `ANDROID_PROJECT_ROOT_DESCRIPTION`, `isToolchainFailure`,
  `extractReportedVersion`, `reportedVersionMatchesPin`.

New structured codes (documented in the contract comment in `toolchainselection.ts` where they
belong to the resolver, and in `toolchain.ts` where they belong to the seam):

| Trigger | Code |
| --- | --- |
| `androidProjectRoot` supplied but carries no readable `settings.gradle(.kts)`/`build.gradle(.kts)` | `unavailable/android-project-unreadable` |
| `$PICO_SPATIALBUNDLE` is not an executable file, or cannot be read to identify it | `unavailable/override-unusable` |
| explicit pin + override that reports no version of its own | `unavailable/override-version-unverified` |
| explicit pin + override that reports a different version | `unavailable/override-version-conflict` |
| a required component is not published for this platform | `unavailable/component-unsupported-platform` |

A version is **never** inferred from a filename: `extractReportedVersion` reads the first dotted
numeric run out of the tool's own output, and `reportedVersionMatchesPin` compares only the
components the pin names (`6.1` matches `6.1.0.0-rls.25`, not `6.10.0`).

### `src/toolchainselection.ts` — the explicit `editor` component

Per the controller ruling on S1 deferred item (d). `ToolComponent` gains `"editor"`, laid out at
`editor/Spatial Editor.app/Contents/MacOS/Spatial Editor`, executable, `platforms: ["darwin"]`.
`ComponentLayout` gained `fixedIsExecutable` and `platforms`; `componentFile` honours both;
`selectInstallation` rejects a platform-unsupported component up front with
`unavailable/component-unsupported-platform` **and probes nothing** — so a Linux host is told the
component does not exist there rather than being handed a macOS-only path it could never have.

This is what lets `editorPaths` request the payload it actually launches instead of asking for the
packer sitting next to it.

### The six consumers

| File | Change |
| --- | --- |
| `src/bundle.ts` | `getSpatialbundle` → `packerToolchain()` (async, one selection + override verification). `pack_bundle` gains `androidProjectRoot`; its success text now names the exact binary and toolchain identity. `bakeTexturedModel`'s result carries `toolchain` (+`binaryOverride`). |
| `src/editor.ts` | `editorPaths` resolves `required:["editor"]`; `macosDir = dirname(bin)`. `build_spatial_project` gains `androidProjectRoot` and discloses provenance in both the success and failure bodies. |
| `src/workflow.ts` | New exported `packAndInspectScene(deps, opts)` runs BOTH stages against `deps.toolchain.bin`; `hostScenePackDeps` is the host runner; `resolveSceneToolchain` resolves once up front. `iterate_scene`/`verify_scene` gain `androidProjectRoot` and provenance. |
| `src/editorexport.ts` | 0.13 fallback removed; one selection for pack + info; provenance in the result. |
| `src/bundlediff.ts` | 0.13 fallback removed; **both sides of the diff are inspected with the same binary** (a fingerprint compared across two packers would report tool changes as content changes). |
| `src/preflight.ts` | above. |

Argv, timeouts and every existing guard are byte-preserved. `packAndInspectScene` rebuilds exactly
the previous argv (`pack -s … -o … --formats usda --override-output --force-build [-p …]` at
600 s; `info --input … [--details]` at 60 s) and the consumer suite asserts both the argv arrays
and the two timeout values so a later edit cannot quietly drift them.

## Controller resolutions — how each was satisfied

1. **Separate packer/emulator reporting** — two structural requests in `defaultIO()`; the row's
   detail names each component's own version and root source; the legacy existence/mtime check is
   deleted. Tested with a 6.1-packer/6.0-emulator fixture and a packer-only fixture.
2. **`androidProjectRoot`** — a genuinely new optional input on `pack_bundle`,
   `build_spatial_project`, `iterate_scene`, `verify_scene`. The existing `projectDir` parameters
   are untouched, and one test asserts the packer still receives `-p <projectDir>` while the
   Android root never reaches its argv.
3. **Result provenance** — `toolchain: SelectedToolchain` (or `toolchain: null` +
   `toolchainUnavailable` when an override alone carries the operation), plus `binaryOverride:
   {file, reportedVersion}` when `$PICO_SPATIALBUNDLE` is set. Structural inspection never launches
   the override; a probe spy asserts zero calls through `resolveOperationToolchain` and through
   `verifyOperationOverride` when there is no pin.
4. **One selection per workflow** — proved with captured-argv runners: projectA →
   `/sdk-a/6.0/…`, projectB → `/sdk-b/6.1/…`, and a workflow whose discovery tree is swapped
   between stage 1 and stage 2 still runs `/sdk-a/6.0/…` for both stages. That last test also
   re-resolves against the mutated tree afterwards and asserts it *would* now return
   `/sdk-b/6.1/…`, so the assertion is not vacuous.
5. **`editorexport` / `bundlediff`** — literals removed, override kept through the shared
   identity-disclosing path, and a source-scan test asserts no `src/*.ts` non-comment line still
   contains `sdk/0.13/editor/spatialbundle`.
6. **TDD order** — RED against the legacy path first (below), then implementation.

## TDD evidence

### RED — the preflight block against the legacy path

`npm run build && node test/preflight.mjs`, with `test/preflight.mjs`'s S2 block added and
`src/preflight.ts` untouched:

```
  FAIL pico-sdk row did not report the injected 6.1 selection: {"name":"pico-sdk","status":"pass","detail":"/Users/sushantsrikrish/Library/PICO/sdk/0.13","fix":null}
  FAIL pico-sdk row does not name the root source: {"name":"pico-sdk","status":"pass","detail":"/Users/sushantsrikrish/Library/PICO/sdk/0.13","fix":null}
  FAIL unavailable selection did not fail the pico-sdk row: {"name":"pico-sdk","status":"pass","detail":"/Users/sushantsrikrish/Library/PICO/sdk/0.13","fix":null}
  FAIL split 6.1/6.0 install was not reported per component: {"name":"pico-sdk","status":"pass","detail":"/Users/sushantsrikrish/Library/PICO/sdk/0.13","fix":null}
  FAIL packer-only host mis-reported: {"name":"pico-sdk","status":"pass","detail":"/Users/sushantsrikrish/Library/PICO/sdk/0.13","fix":null}
  FAIL pico-sdk row without an inspection is wrong: {"name":"pico-sdk","status":"pass","detail":"/Users/sushantsrikrish/Library/PICO/sdk/0.13","fix":null}

Preflight test done. Failures: 6
```

Every failure shows the same thing: the injected selection was ignored, the row passed
unconditionally, and the detail named `0.13` — including the host-env leak described above.

### RED — the S1 suite after `editor` became a real component

`node --test test/toolchain-resolution.mjs`:

```
✖ every contract failure code is reachable with its documented trigger
✖ an out-of-union component is a structured result, not a TypeError
  actual: 'unavailable/component-missing'  expected: 'unavailable/component-unknown'
ℹ tests 44  ℹ pass 42  ℹ fail 2
```

S1 had used the string `"editor"` as its canonical *out-of-union* example. Making `editor` a real
component is exactly what those two tests were measuring, so I retargeted them to
`"spatialbundle"` / `"scenepreview"` (still not components) and updated the expected legal-set
string to `adb, editor, emulator, packer, proto`. The assertions are unchanged in strength.

### RED — one over-strict assertion of my own

`a packer-only installation cannot satisfy an editor request` asserted the detail matched
`/Spatial Editor/`, but the *automatic* (unpinned) branch of S1's `component-missing` message does
not name the expected path — only the pinned branch does. Rather than edit S1's message, I split
the test: the unpinned case asserts the code, and a pinned case asserts the exact payload path
`Spatial Editor.app/Contents/MacOS/Spatial Editor`, which is the assertion that actually proves
`editor` is not an alias for the packer.

### GREEN

```
$ npm run build                                    # tsc, strict, clean
$ node --test test/toolchain-consumers.mjs         # ℹ tests 24  pass 24  fail 0
$ node test/preflight.mjs                          # Preflight test done. Failures: 0
$ node --test test/toolchain-resolution.mjs        # ℹ tests 48  pass 48  fail 0
$ node test/projectgen.mjs                         # Projectgen test done. Failures: 0
$ node test/doors.mjs                              # Doors test done. Failures: 0
$ npm run test:prompts                             # ℹ tests 3  pass 3  fail 0
```

`test:prompts` needed **no** fixture change: it asserts tool *names* per surface, not input
schemas, so the four new `androidProjectRoot` fields do not touch it. `test/doors.mjs` passes
unchanged, so the extended schemas still register on both surfaces.

## What `test/toolchain-consumers.mjs` covers (24 cases)

Per-project selection and captured argv (2 projects × 2 stages, argv + timeouts asserted);
`projectDir`/`--details` argv parity; the stage-1-selection-survives-a-changing-tree case; the
deploying-operation editor preference and its fallback; the `editor` component (app bundle, not
the packer; `component-missing` when absent; `component-unsupported-platform` on linux/win32 with
no macOS path named); `androidProjectRoot` (all four markers, unreadable root, empty root,
rejected before anything packs, distinct from `projectDir`); the override (bytes-identity, never
launched structurally, carries the operation with no installed toolchain, non-executable and
absent refusals, opt-in-only and packer-only, `override-version-unverified`,
`override-version-conflict`, agreeing case records the reported version); the version helpers; and
two source scans (no `sdk/0.13/editor/spatialbundle` in any `src/*.ts` non-comment line; all five
packer consumers reference `resolveOperationToolchain`).

**Hermeticity**: every filesystem observation comes from `toolchainIOFromTree`, every command from
an injected recording runner, every version probe from an injected function. No process is
spawned, no emulator is touched, and `~/Library/PICO` is never read. The only host files the suite
opens are the repository's own `src/*.ts`, for the two source scans.

## Files changed

```
 src/bundle.ts                 |  46 +++-
 src/bundlediff.ts             |  36 ++-
 src/editor.ts                 |  50 +++-
 src/editorexport.ts           |  32 ++-
 src/preflight.ts              |  88 +++++--
 src/toolchain.ts              | 234 ++++++++++++++++++
 src/toolchainselection.ts     |  43 +++-
 src/workflow.ts               | 190 +++++++++++---
 test/preflight.mjs            |  85 +++++++
 test/smoke.mjs                |   6 +-
 test/toolchain-consumers.mjs  | 563 ++++++++++++++++++++++++++++++++++++++++++  (new)
 test/toolchain-resolution.mjs |  79 +++++-
 12 files changed, 1347 insertions(+), 105 deletions(-)
```

Nothing outside the ownership boundary: no `package.json`, `package-lock.json`, `.gitignore`,
`.github/**`, `scripts/**`, `test/distribution-adoption.mjs`, `README.md`, `AGENTS.md`,
`src/picocli*.ts`, `src/knowledge.ts`, `src/doors.ts`, `src/vault*.ts`, `src/lint.ts`,
`src/adb.ts`, `src/grpc.ts`, `src/projectgen.ts`, `src/scaffold.ts`, and the JDK cache in
`src/toolchain.ts` (lines untouched).

**Shared-file discipline**: my `src/preflight.ts` hunks sit in the `PreflightIO` seam (~40–68),
the SDK-payload/ADB region (~145–205) and one new helper block; the `emulator status --format
json` consumer region (~260–280) is untouched and unreformatted. My `test/preflight.mjs` additions
are one clearly delimited block appended at the end (immediately before the file's terminal
`console.log`/`process.exit`, which is the only position where it actually executes).

## New / changed test files needing CI registration

- **`test/toolchain-consumers.mjs`** (new) — `node --test test/toolchain-consumers.mjs`, requires
  `npm run build` first (imports `dist/`). No `package.json` script added, per the ownership
  ruling; I1 should register it alongside `test/toolchain-resolution.mjs`.
- `test/toolchain-resolution.mjs` — still unregistered from S1; now 48 cases.

## Tool-schema changes

Four tools gain **one optional string input each**, `androidProjectRoot`, with the shared
description from `toolchain.ts`:

| Tool | Existing inputs kept | New |
| --- | --- | --- |
| `pack_bundle` | `sceneDir, output, projectDir, formats, compressTextures, forceBuild, incremental, extraArgs, toolsVersion` | `androidProjectRoot` |
| `build_spatial_project` | `projectDir, outputDir, resultName, specialScenes, timeoutSec, toolsVersion` | `androidProjectRoot` |
| `iterate_scene` | `sceneDir, projectDir, workName, serial, deploy, toolsVersion` | `androidProjectRoot` |
| `verify_scene` | `sceneDir, projectDir, expectMeshNames, minMeshes, toolsVersion` | `androidProjectRoot` |

No input was renamed or had its meaning changed. Result bodies gain `toolchain` (and
`toolchainUnavailable` / `binaryOverride` when applicable); `build_and_run`'s declared
`outputSchema` is untouched, and no other tool declares one.

## Self-review findings

- **Completeness** — every brief checkbox and all six controller resolutions have at least one
  test. The brief's snippet is used verbatim.
- **A regression I introduced and then fixed.** My first cut had `iterate_scene {deploy:true}`
  require `["packer","editor"]` outright, which would refuse to pack on a host whose editor app
  bundle is gone — even though ScenePreview is frequently already installed on the device and the
  old code degraded gracefully (it skipped the install when the APK was missing). `resolveSceneToolchain`
  now *prefers* one install carrying both and falls back to packer-only, with the fallback taken
  before stage 1, never between stages. Two tests pin both halves, including that a missing
  **packer** is still fatal.
- **A text-coupled CI gate I found by reading, not by a failing test.** `test/smoke.mjs` keys its
  `SMOKE_SDK_OPTIONAL` SKIP on `/No (spatialbundle binary|emulator payload) found under/`. My
  consumers now fail with the resolver's structured code instead of that sentence, so on CI (no
  SDK) `pack_bundle`/`inspect_bundle`/`scene_schemas` would have flipped from SKIP to hard FAIL. I
  widened the matcher to also accept `unavailable/(component-missing|root-unavailable|
  version-missing|unsupported-default-root|component-unsupported-platform)` — the codes that
  genuinely mean "this host has no PICO toolchain" — and deliberately **excluded** `override-*`
  and `android-project-*`, which are caller errors that must fail even on an SDK-less machine. I
  did **not** run `npm run smoke`: it is non-hermetic, hardcodes a personal Claimsight checkout,
  and would run the real packer, which this task is forbidden to do. **R4 owns removing
  `SMOKE_SDK_OPTIONAL` entirely — please hand this hunk to that task if you would rather it land
  there.**
- **No path launches a binary during structural inspection.** `resolveOperationToolchain` is
  synchronous and reaches only `io.read/entries/realpath/executable`; the host `executable` is
  `fs.accessSync(X_OK)`, a permission check, not an exec. The only probe lives in
  `verifyOperationOverride` and is gated on pin+override. Asserted with a spy.
- **Discipline** — no new abstractions beyond the one seam the brief asks for; no persistent pin
  format; no registry or provisioning; `androidProjectRoot` added to exactly the four tools
  resolution 2 names; `test/helpers/toolchain-fixture.mjs` left untouched (the mutable-tree proxy
  lives in the test that needs it).
- **File size** — `src/toolchain.ts` is now 520 lines and holds three concerns (host IO, legacy
  adapters, the operation seam) plus the JDK cache that S4 owns. It is still coherent, but if S4's
  work pushes it further, splitting the operation seam into its own module is the natural cut.
  I did not restructure it here.

## Concerns

1. **Behaviour change — `$PICO_SPATIALBUNDLE` is now honoured by `pack_bundle`,
   `bake_textured_model`, `inspect_bundle`, `scene_schemas`, `iterate_scene` and `verify_scene`,
   which previously ignored it.** Only `editorexport`/`bundlediff` honoured it before. I made it
   uniform because resolution 3 speaks of "operations that pack/launch" generally, because one
   code path is the point of the task, and because the `override-version-*` codes the brief
   mandates are otherwise unreachable (neither `editorexport` nor `bundlediff` has a version
   input, so neither can ever supply the explicit pin those codes require). **If the controller
   wants the override kept to its two original tools, flip `allowBinaryOverride` to `false` in
   `bundle.ts`'s `packerToolchain` and `workflow.ts`'s `resolveSceneToolchain` — the seam already
   gates on that flag and the tests for it are per-call.** The override is now also *stricter*:
   it must be executable, not merely exist.
2. **Behaviour change — a deploying `iterate_scene` prefers an install carrying both the packer
   and the editor.** On a 6.1-packer/6.0-editor host it packs with 6.0 rather than 6.1, so that
   the bundle and the ScenePreview APK come from one installation. That is the intended fix, but
   it is a real change in which packer runs.
3. **Cost of the doctor's structural requests — unmeasured.** `preflight_env` now sha256s the
   selected packer, emulator and adb payloads on every run. That is O(payload size) per run and
   the packer is the large one. I could not measure it without pointing a probe at the real SDK
   install, which this dispatch forbids; the production-harness section of `test/preflight.mjs`
   exercises that path and completes without timing out, which is weak evidence only. If this
   matters, the cheap fix is a selection whose identity is computed lazily — but the brief types
   the injected field as `ToolchainSelection`, which carries `identity`, so I did not change it.
4. **The doctor's `adb` row still keeps `~/Library/PICO/sdk/0.13/…` as its LAST candidate.** I
   added `adbInspection` so the selected adb is tried before it (PATH remains first, and every
   candidate is still confirmed by running `adb version`), rather than deleting the legacy path
   and breaking a host that really does carry 0.13. `src/adb.ts` itself is S4's and untouched.
5. **`validate_toolchain` still reports through the legacy `pickVersion(need:"any")` adapter,** so
   it continues to under-report split installs (S1 deferred item (c)). Resolution 1 required the
   *doctor's SDK row* to come from the structural selection, which it now does; `validateToolchain`
   is the version-*probing* report and the brief told me to keep probing separate. Migrating it is
   a small follow-up: `required:["packer"]` and `required:["emulator"]` resolved separately, then
   probe each.
6. **S1 deferred items, status:** (a) `resolveToolsRoot` swallowing `ambiguous/property-conflict`
   — my five migrated consumers no longer use it, so they now surface that code honestly;
   `validateToolchain`, `adb.ts`, `grpc.ts`, `emulator.ts`, `projectgen.ts` and `scaffold.ts` still
   do (not my files). (b) relative `spatial.tools.dir` and `pickVersion` returning null — my
   consumers branch on `isToolchainFailure` and never dereference; the unmigrated ones already use
   `sel?.` guards, so nothing crashes. (c) see concern 5. (d) done — the `editor` component.
7. **`editor_export_bundle`, `bundle_content_diff`, `bake_textured_model`, `inspect_bundle`,
   `scene_schemas`, `create_scene_project` and `preview_scene` did NOT get `androidProjectRoot`.**
   Resolution 2 names pack_bundle, the editor build and the workflow; I kept to that. They resolve
   against `$PICO_HOME`/default as before.
8. **Cross-platform behaviour is fixture-only.** The `component-unsupported-platform` and Windows
   cases are proven against simulated trees on a macOS host. This is not evidence of real
   Linux/Windows filesystem, casing or permission behaviour.
9. **No native, device or visual evidence** is claimed. Nothing here was run against the real SDK,
   a packer, an editor or an emulator. The recommended native follow-up, when a task is allowed
   to touch the host install, is a read-only `preflight_env` and a single `pack_bundle` against a
   throwaway scene, checking that the `pico-sdk` row and the pack result name the same version,
   root source and toolchain identity.

---

# Fix round 1

Commit: `d708fdb` — `fix: disclose packer overrides and keep scene_schemas on installed data`
(on top of `7b41699`, branch `track/cli050-sdk`, not pushed). Trailer verified on the commit
object. The Important finding is fixed; ledgered Minor items (DRY wrappers, empty-string root,
adb-row tests) were left alone per instruction.

## Finding 1 — the newly-honoured override was invisible, and `scene_schemas` should not take it

The reviewer is right on both halves, and the second half is the more serious one.

**`scene_schemas` never executes anything.** It derives `usdDir = dirname(bin)/usd` and reads USD
schema files that ship *inside* the installation. `$PICO_SPATIALBUNDLE` names a packer to **run**,
not an installation to **read from**, so honouring it there silently relocated the "authoritative
grammar" to whatever directory happened to sit beside that binary — or, on a host that had the
variable set for the historical `editorexport`/`bundlediff` reason, turned a working tool into
`No PICO schema.usda files found under /opt/custom/usd`. That is a regression I introduced in
`7b41699` by making the override uniform without asking what each tool actually does with `bin`.
The secondary defect follows from the same mistake: with a `toolsVersion` pin *and* the override
set, this read-only lookup started spawning `$PICO_SPATIALBUNDLE --version`.

**`inspect_bundle` does run the packer**, so the override legitimately applies — but it reported a
bundle's decoded contents with nothing in the output naming the binary that read the bytes. In a
repo whose contract is that provenance is never implied, that is exactly the failure mode the
provenance fields exist to prevent.

### What changed

`src/bundle.ts`:

- `packerToolchain` is now exported and takes `PackerToolchainOptions` with an explicit
  `allowBinaryOverride` (**default `true`**, so every tool that actually runs the packer —
  `pack_bundle`, `bake_textured_model`, `inspect_bundle` — is behaviourally unchanged), plus
  optional `io` / `probe` parameters that **tests** inject and production never passes.
- `resolveSchemaToolchain(opts, io?, probe?)` = `packerToolchain({...opts, allowBinaryOverride:
  false})`, with the reasoning in the doc comment. `scene_schemas` uses it, and
  `schemaUsdDir(ctx)` replaces the inline `path.join(path.dirname(sb.bin), "usd")`.
- `inspectBundleReport(info, manifest, ctx)` builds `inspect_bundle`'s body and appends a
  `# toolchain\nInspected with <provenance line>` section. Its failure body names the binary too
  (`spatialbundle info failed (exit N) using …`).
- `scene_schemas` also appends `# toolchain\nRead from <provenance line>`, so the caller can see
  which installation the grammar came from. (Not required by the finding; it is the same
  "never imply provenance" rule applied to the tool the finding was about.)

Extracting three small functions rather than testing through a live MCP server keeps the suite
hermetic: exercising the real handlers would mean spawning a server and letting `inspect_bundle`
actually `run()` a fixture binary, which this task is forbidden to do. The extraction follows the
module's existing convention (`workflow.ts` already exports `parseAssembleTask`,
`resolveAssembledApk`, `launchResultSucceeded`, `analyzePackageRuntimeLogs` for the same reason).

### The audit the controller asked for

Every `allowBinaryOverride: true` call site, and whether its results disclose which binary ran:

| Call site | Runs the override? | Success disclosure | Failure disclosure |
| --- | --- | --- | --- |
| `bakeTexturedModel` | yes | `...toolchainProvenance(sb)` | inherits pack error text |
| `pack_bundle` | yes | `Packed with <line>` | prints the full `Command: <bin> <args>` |
| `inspect_bundle` | yes | **added** `# toolchain` section | **added** `using <line>` |
| `scene_schemas` | **no longer** | **added** `# toolchain` section | n/a (root/version errors) |
| `iterate_scene` | yes | `report` spreads `toolchainProvenance(ctx)` | `pack failed with <line>` |
| `verify_scene` | yes | result spreads `toolchainProvenance(ctx)` | `compile FAILED with <line>` |
| `editor_export_bundle` | yes | spread + `packedWith` | **added** to pack + `assertPhysics` failures |
| `bundle_content_diff` | yes | spread + `inspectedWith` | **added** to both per-bundle failures |
| `editorPaths` (`editor.ts`) | n/a — `primary: "editor"`, the seam gates the override on `primary === "packer"` | spread + `Built with <line>` | `Built with <line>` |

Only `inspect_bundle` was missing disclosure on the success path. The four failure-body additions
in `editorexport`/`bundlediff` are the same rule applied consistently; both tools already ran the
override before S2, so this is disclosure being added to pre-existing behaviour, not new
behaviour.

### Tests added (`test/toolchain-consumers.mjs`, 24 → 28)

1. `scene_schemas reads beside the INSTALLED packer and never spawns, even with the override set`
   — with `PICO_SPATIALBUNDLE` **and** `PICO_HOME` in the injected env: `binaryOverride === null`,
   `bin` is the installed packer, `schemaUsdDir` is `/sdk/6.1/editor/spatialbundle/usd` and
   explicitly **not** `dirname(OVERRIDE)/usd`, the probe spy is never called — repeated with a
   `toolsVersion: "6.1"` pin to cover the secondary spawn defect — and the provenance line names
   the installation without mentioning `PICO_SPATIALBUNDLE`.
2. `inspect_bundle's body names the binary that decoded the bundle` — the body still contains both
   original sections, plus `# toolchain`, the override path, and the override's sha256 prefix;
   repeated with a null manifest so the "not extractable" branch keeps its provenance.
3. `a packer operation that RUNS the binary still honours the override by default` — guards the
   other direction, so the fix cannot drift into disabling the override everywhere.
4. `every tool result that can run the override discloses which binary ran` — a source audit over
   `bundle.ts`, `workflow.ts`, `editorexport.ts`, `bundlediff.ts`, so a future packer consumer
   cannot report tool output anonymously.

### RED evidence for this round

The two new gate tests were run against the reviewed defect (restored by flipping
`resolveSchemaToolchain` back to `allowBinaryOverride: true` and deleting the `# toolchain`
section from `inspectBundleReport`, then rebuilding):

```
$ npm run build && node --test test/toolchain-consumers.mjs
✖ scene_schemas reads beside the INSTALLED packer and never spawns, even with the override set
  AssertionError [ERR_ASSERTION]: the override must not redirect a data-file lookup
    actual: { file: { path: '/opt/custom/spatialbundle', sha256: '24cd52707ef0f6fd07b614f7904fc0933e57ebe5d4d219a80c5423865118aa88' }, reportedVersion: null }
✖ inspect_bundle's body names the binary that decoded the bundle
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /# toolchain/
ℹ tests 28  ℹ pass 26  ℹ fail 2
```

The first failure is the reviewer's finding reproduced exactly: the schema lookup carrying the
override binary. The fixed source was then restored and rebuilt.

One RED of my own first: the three new tests initially failed with
`unavailable/root-unavailable: PICO tools root /fixture/Library/PICO/sdk …` because `packerToolchain`
takes no `toolsRoot` (unlike `resolveOperationToolchain`, which every earlier test passes one to).
Fixed by making the fixture discoverable the way a real host is, through `PICO_HOME` in the
injected env — which is also the more faithful fixture.

### GREEN — exact commands and output

```
$ npm run build
> pico-spatial-mcp@37.0.0 build
> tsc
                                            (clean, no output)

$ node --test test/toolchain-consumers.mjs
ℹ tests 28
ℹ pass 28
ℹ fail 0

$ node test/preflight.mjs
Preflight test done. Failures: 0

$ node test/doors.mjs
Doors test done. Failures: 0

$ node --test test/toolchain-resolution.mjs      # regression, not requested
ℹ tests 48
ℹ pass 48
ℹ fail 0

$ npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # filtered to the changed files
no unused locals in the three changed files
```

### Files changed this round

```
 src/bundle.ts                | 85 ++++++++++++++++++++++++++++++++++++-------
 src/bundlediff.ts            |  4 +--
 src/editorexport.ts          |  6 ++--
 test/toolchain-consumers.mjs | 86 ++++++++++++++++++++++++++++++++++++++++++++
 4 files changed, 162 insertions(+), 19 deletions(-)
```

No new files; `test/toolchain-consumers.mjs` is still the one suite needing CI registration
(now 28 cases).

## Notes for the controller

- **Concern 1 in the original report is now partly resolved, and partly sharper.** The reviewer's
  finding is the concrete evidence that making the override uniform has per-tool consequences: it
  is correct for anything that *runs* the packer and wrong for anything that *reads beside* it.
  `allowBinaryOverride` is now the explicit switch that records which of the two a tool is, so if
  you still want the override narrowed back to `editorexport`/`bundlediff` only, it is a one-value
  change per call site with tests that already pin both directions.
- **Full sweep for the same class of defect** (a path derived from a resolved binary's directory).
  `grep -rni "path.dirname(" src/*.ts | grep -i bin` returns five sites:
  `bundle.ts:77` (`schemaUsdDir` — the one just fixed); `editor.ts:70` (`macosDir`) and
  `workflow.ts:250` (the ScenePreview APK), both derived from the **editor** component's path —
  `editor.ts` resolves `primary: "editor"`, and `workflow.ts` reads
  `ctx.selection.files.editor.path`, never `ctx.bin` — so the packer override cannot reach either,
  because the seam gates it on `primary === "packer"`; and `emulator.ts:18,145`, which still uses
  the legacy `pickVersion` path and has no override at all. No remaining site can be redirected by
  `$PICO_SPATIALBUNDLE`.
- Still unverified, unchanged from the original report: no native, device or visual evidence; the
  cost of the doctor's structural hashing is unmeasured; cross-platform behaviour is fixture-only.
