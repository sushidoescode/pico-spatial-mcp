# SDK 6.1 Toolchain and Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP tool selection and declaration authority agree with explicit project context while preserving existing application dependencies and native guards.

**Architecture:** Resolve host tools through one injectable, component-aware contract and pass its immutable result through an operation. The SDK track owns reading declaration identity from local bytes and validating reviewed compatibility records against source, target and artifact hashes. The CLI adapter supplies root/workspace hints only; it neither supplies declaration authority nor chooses compatibility verdicts.

**Tech Stack:** TypeScript/Node ESM, existing Zod tool schemas, generated `dist`, Node assertion fixtures, existing Kotlin/Gradle project metadata.

**Spec:** [CLI/SDK evolution handoff](../../CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md).

## Global Constraints

- Source baseline: `308c898e9c33975b5a21ecb78fed245fab17a0ed`; inspect actual HEAD/status before implementation and preserve concurrent changes.
- Begin each fresh session with read-only `pico_doctor {}`. Its calibration failure does not prevent useful host-only implementation or tests.
- Preserve the exact managed CLI contract in AGENTS.md. No changes to the global CLI, PATH, host plugin wiring or utility setup as incidental effects of inspection, startup or registration.
- Mission Replay remains paused; no application migration, project BOM rewrite, APK installation or native operation belongs to this plan.
- SDK6.1 host selection versus legacy0.13 preflight is confirmed; CLI0.5.0 publication is confirmed, installed/cache observations remain0.4.4.
- Host SDK version, Maven BOM/resolved artifacts, vault package revision and CLI version are separate identities.
- Preserve historical 0.13.3 declaration provenance and the measured 6.0.0 mapping; do not extend its authority to6.1 without evidence.
- Preserve `lint.clean` semantics: vault and graph results remain advisory.
- No guessed CLI knowledge flags; the separate CLI plan owns acquisition/transport and provides root/workspace hints only. SDK-owned readers/verifiers establish declaration identity and authority.
- Never restart/move/resize the emulator, weaken health/visibility/identity guards, change Wing, kill unrelated processes, push or rewrite history.
- No emulator account sign-in or copying browser credentials for this work. An authentication-dependent optional service must be identified by its actual error; it does not block independent host work.
- Preserve typed MCP results, bounded execution, immutable artifacts, explicit target identity and the LOOK requirement. Exit zero, a help listing and a nonempty file cannot establish visual acceptance.
- Use fresh evidence paths and reviewable local commits. No release-version bump until the implementation scope and compatibility effect justify it.
- Build `dist` before every test cycle after source edits; tests import `dist` and no pretest rebuild exists.
- This document contains future actions, not executed tests; use fresh evidence identifiers and explicit staging for each local commit.
- Before executing an existing suite, inspect its effects and platform conditions; replace any runtime-dependent check here with its injected host fixture, and leave native acceptance open.

## File map and execution order

| Files | Responsibility |
| --- | --- |
| New `src/toolchainselection.ts`; existing `src/toolchain.ts` | Pure selection plus injected filesystem/environment discovery; preserve public adapter functions. |
| New `test/helpers/toolchain-fixture.mjs`, `test/toolchain-resolution.mjs` | Hermetic mixed-installation and platform tests, never execute fixture binaries. |
| `src/preflight.ts`, `src/bundle.ts`, `src/editor.ts`, `src/workflow.ts`, `src/editorexport.ts`, `src/bundlediff.ts` | Consume one resolved context rather than independent/legacy paths. |
| New `src/projectidentity.ts`; `src/projectgen.ts`, `src/scaffold.ts` | Read supported static dependency identities; generate selected roots without changing BOM. |
| `src/adb.ts`, `src/grpc.ts`, `src/vault.ts`, `src/toolchain.ts`; new `src/identitycache.ts` | Invalidate resource/JDK caches when configuration or selected bytes change; do not retain absent JDK discovery. |
| New `src/declarationcontext.ts`, `data/sdk-compatibility/index.v1.json`, `data/sdk-compatibility/basis/`; `src/vault.ts`, `src/vaultdiff.ts`, `src/lint.ts`, `src/doors.ts` | SDK-owned identity reading and reusable artifact-scoped mapping validation; packaged reviewed basis snapshots. |
| Existing `test/preflight.mjs`, `test/projectgen.mjs`, `test/vault.mjs`, `test/vaultdiff.mjs`, `test/lint.mjs`, `test/doors.mjs` | Regression integration; new test files below supply narrow isolated suites. |

Execute Tasks1–3 sequentially; Task4 can then be reviewed independently of Task5. Task6 integrates both and does not authorize runtime acceptance.

### Task 1: Define component-valid project/host selection

**Files:** Create `src/toolchainselection.ts`, `test/helpers/toolchain-fixture.mjs`, `test/toolchain-resolution.mjs`; modify `src/toolchain.ts:15–91`.
**Interfaces:** Produce these exported types and functions; existing `resolveToolsRoot`, `listVersions`, `pickVersion` become compatibility adapters.

```ts
export type ToolComponent = "packer" | "emulator" | "adb" | "proto";
export type RootSource = "explicit" | "local.properties" | "PICO_HOME" | "default";
export interface ToolchainRequest {
  androidProjectRoot?: string; toolsRoot?: string; toolsVersion?: string;
  projectToolsVersion?: string; required: readonly ToolComponent[];
}
export interface FileIdentity { path: string; sha256: string }
export interface SelectedToolchain {
  status: "ok"; root: string; rootSource: RootSource; version: string;
  reason: "explicit" | "project-pin" | "newest-usable";
  files: Partial<Record<ToolComponent, FileIdentity>>; identity: string;
}
export type ToolchainSelection = SelectedToolchain | {
  status: "unavailable" | "ambiguous"; code: string; detail: string;
};
export interface ToolchainIO {
  platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv;
  read(path: string): Buffer | null; entries(path: string): string[] | null;
  realpath(path: string): string | null; executable(path: string): boolean;
}
export function resolveToolchain(request: ToolchainRequest, io?: ToolchainIO): ToolchainSelection;
export function executableNames(name: "adb" | "emulator" | "spatialbundle", platform: NodeJS.Platform): string[];
```

- [ ] Add `toolchainIOFromTree({platform, home, env, files})` to the fixture helper; `files` maps absolute paths to `{bytes: string, executable?: boolean}`. Implement deterministic `entries`, `realpath`, `read` and `executable` without host filesystem access; expose attempted reads for assertions.
- [ ] Add the regression below, plus numeric6.10>6.9 ordering, split/missing components, unreadable/non-directory entries and absent explicit roots.

```js
const io = toolchainIOFromTree({platform:"darwin", home:"/fixture", env:{}, files:{
  "/fixture/Library/PICO/sdk/6.1/editor/spatialbundle/spatialbundle": {bytes:"six-one", executable:true},
  "/fixture/Library/PICO/sdk/6.0/emulator/emulator": {bytes:"six-zero", executable:true}
}});
assert.equal(resolveToolchain({toolsVersion:"6.1", required:["emulator"]}, io).status, "unavailable");
assert.equal(resolveToolchain({required:["packer"]}, io).version, "6.1");
assert.equal(resolveToolchain({toolsVersion:"6.1", projectToolsVersion:"6.0", required:["packer"]}, io).status, "ambiguous");
```

- [ ] Run `npm run build`, then `node --test test/toolchain-resolution.mjs`; retain the initial failure. Missing export is an acceptable first failure; before completion retain a behavioral failure against the legacy requested-version component behavior too.
- [ ] Implement explicit root → project `spatial.tools.dir` → `PICO_HOME` → documented platform default. Explicit roots/pins fail closed; never fall back from an unavailable request. Automatic selection needs every requested component in the same installation.
- [ ] Parse Java-properties continuations/escapes and report conflicting duplicate selection properties. Resolve relative project values against the Android root; canonicalize aliases. Treat equal numeric versions with different payloads as ambiguous; an exact explicit directory name disambiguates them.
- [ ] Validate version tokens as numeric two/three-component labels; reject separators/traversal. Handle missing/unreadable directories as structured unavailable results. Hash only selected required files for identity; no subprocess, registry or provisioning in this module.
- [ ] Add platform fixtures: explicit Windows drive/UNC roots and `.exe`, Linux explicit roots, macOS default, spaces, escaped backslashes/colon, case-insensitive Windows environment keys. `executableNames("adb","win32")` must return `["adb.exe"]`; unsupported default PICO layouts return `unsupported-default-root`, never an invented path.
- [ ] Rebuild and run the narrow test file; assert a request needing both packer/emulator cannot silently mix6.0/6.1. Commit only Task1 files with `fix: unify component-aware PICO tool selection`.

The resolver's externally asserted failure codes are part of the contract:

| Trigger | Status/code |
| --- | --- |
| Explicit version lacks a required component | `unavailable/component-missing` |
| Requested version directory does not exist | `unavailable/version-missing` |
| Explicit root is absent or unreadable | `unavailable/root-unavailable` |
| Explicit request contradicts supplied project pin | `ambiguous/version-conflict` |
| Equal numeric versions contain different required bytes | `ambiguous/version-alias-conflict` |
| Platform has no verified default root | `unavailable/unsupported-default-root` |

Do not add a persistent project pin format in Task1: `projectToolsVersion` is an explicit caller input. A later durable pin format needs a documented schema and its own compatibility review; no official Gradle property is inferred here.

### Task 2: Make doctor and pack operations use the same selection

**Files:** Modify the six consumers in the file map and `src/preflight.ts:40–68,145–205`; create `test/toolchain-consumers.mjs`; extend `test/preflight.mjs`.
**Interfaces:** Consume `resolveToolchain`/`SelectedToolchain`; produce optional `androidProjectRoot` context in relevant tool schemas and `toolchain: SelectedToolchain` result provenance.

- [ ] Add injected `toolchainInspection?: ToolchainSelection` to `PreflightIO`; production computes the structural result before `runPreflightChecks`. Keep version probing separate and preserve all existing native checks.
- [ ] Add a preflight fixture with6.1 selected and no0.13 directory; assert the SDK row reports6.1 and the selected root source. An existing empty0.13 directory must not make an unavailable selection pass.

```js
const checks = runPreflightChecks({...healthyIO, toolchainInspection:{
  status:"ok", root:"/sdk", rootSource:"PICO_HOME", version:"6.1",
  reason:"newest-usable", files:{packer:{path:"/sdk/6.1/packer",sha256:"a".repeat(64)}}, identity:"b".repeat(64)
}});
assert.match(checks.find(x=>x.name==="pico-sdk").detail, /6\.1/);
assert.doesNotMatch(checks.find(x=>x.name==="pico-sdk").detail, /0\.13/);
```

- [ ] Run `npm run build`, then `node test/preflight.mjs`; retain the wrong legacy path failure before implementing the row mapping.
- [ ] Change `getSpatialbundle`/`editorPaths` and workflow setup to consume one selection. Add `androidProjectRoot` separately from existing `.spatialproject` parameters; do not rename their meanings silently. A supplied explicit Android root must contain readable project metadata or return unavailable before packing.
- [ ] Preserve `PICO_SPATIALBUNDLE` override behavior via an explicit binary identity: validate existence/executability and disclose it. If its declared/version-probed identity conflicts with an explicit pin, refuse the pack; never guess its version from its filename.
- [ ] Extend operation provenance with `binaryOverride?: {file: FileIdentity; reportedVersion: string | null}`. Structural inspection never launches an override; actual packing may use its existing bounded version-probe boundary. An explicit pin with unknown override version fails as `override-version-unverified`; a mismatch fails as `override-version-conflict`.
- [ ] Add registration/runner fixtures to `test/toolchain-consumers.mjs` that capture argv without spawning: projectA uses `/sdk-a/6.0/packer`, projectB uses `/sdk-b/6.1/packer`, and a multi-stage workflow uses the same selection even if discovery changes after its first stage.
- [ ] Replace independent0.13 packer selection in `editorexport` and `bundlediff`. Keep a source scan assertion against those specific executable fallback literals; historical documentation is outside that assertion.
- [ ] Rebuild; run `node --test test/toolchain-consumers.mjs` and `node test/preflight.mjs`. Commit Task2 files with `fix: bind doctor and packers to selected project tools`.

### Task 3: Preserve project dependency identity during generation

**Files:** Create `src/projectidentity.ts`, `test/projectidentity.mjs`; modify `src/projectgen.ts:136–218`, `src/scaffold.ts:164–173`, `test/projectgen.mjs`.
**Interfaces:** Produce the static context below; Task5 consumes it. Generation accepts optional `toolchain?: SelectedToolchain` and returns the selection plus unchanged template BOM provenance.

```ts
export interface ProjectSdkIdentity {
  projectRoot: string; fingerprint: string;
  declaredBom: string | null; resolvedArtifacts: readonly {coordinate:string; sha256:string}[];
  status: "declared" | "resolved" | "unknown"; reasons: readonly string[];
}
export function readProjectSdkIdentity(projectRoot: string): ProjectSdkIdentity;
```

- [ ] Build temp-project fixtures for `libs.versions.toml` alias and literal Gradle BOM declarations. `readProjectSdkIdentity` supports these exact forms; dynamic providers, multiple conflicting declarations or missing metadata return unknown with file-specific reasons, without running Gradle.
- [ ] Add this regression to `test/projectgen.mjs` using its existing temporary destination and generator setup.

```js
const before = fs.readFileSync(path.join(SKELETON_ROOT,"gradle/libs.versions.toml"));
const generated = generateSpatialProject({...options, toolchain: selected61});
assert.deepEqual(fs.readFileSync(path.join(generated.created,"gradle/libs.versions.toml")), before);
assert.equal(readProjectSdkIdentity(generated.created).declaredBom, "6.0.0");
assert.equal(generated.toolchain.version, "6.1");
```

- [ ] Define `selected61` as a literal valid `SelectedToolchain` and `options` using the current test's package/stage/destination fixture. Run `npm run build`, then `node test/projectgen.mjs` and `node --test test/projectidentity.mjs`; retain the missing generation-provenance failure.
- [ ] Implement static identity from a bounded allowlist of project files, with canonical root plus file hashes. `resolvedArtifacts` stays empty unless explicitly provided as verified resolved evidence by a separate boundary; a version catalog alone yields `declared`.
- [ ] Resolve selection before writing a new project, serialize `local.properties` correctly, and retain the chosen selection in `GenerateResult`. In cloning, apply that explicit destination selection and report the changed root; do not opportunistically replace the BOM or dependency repository.
- [ ] Compare generated catalog bytes and template fingerprint; reject an invalid selection before creating the destination. Test path escaping and two projects on different roots. Existing package renaming/resource escaping tests must remain intact.
- [ ] Rebuild and run both Task3 tests. Commit only Task3 files with `fix: preserve project BOM while recording toolchain selection`.

### Task 4: Invalidate ADB, proto, vault and JDK caches

**Files:** Create `src/identitycache.ts`, `test/toolchain-cache.mjs`; modify `src/adb.ts:6–15`, `src/grpc.ts:29–52`, `src/vault.ts:456–494`, `src/toolchain.ts:103–127`; extend `test/preflight.mjs`.
**Interfaces:** Consume `SelectedToolchain.identity`/`FileIdentity`; export the focused cache primitive below. `loadProto` keys on selected proto plus imported schema bytes, not a version label alone.

For JDK discovery, add optional injected context to existing functions: `detectJavaHome(io?: ToolchainIO): string | null` and `gradleEnv(io?: ToolchainIO): Record<string, string | undefined>`. No-argument callers retain current behavior and precedence; both functions use the same context. This does not add a new PATH lookup or execute Java.

Direct ADB consumer batches, each checked by the captured-runner suite before its own review:

- Capture/observation: `src/capture.ts`, `src/deviceidentity.ts`, `src/emulatorlook.ts`, `src/eye.ts`, `src/sense.ts`, `src/assertscene.ts`.
- Build/deploy/perf: `src/deploy.ts`, `src/fleetbuild.ts`, `src/hybridbuild.ts`, `src/perfprobe.ts`, `src/verifyapk.ts`.
- Workspace/parity: `src/webbrowser.ts`, `src/webworkspace.ts`, `src/swanparity.ts`.

Change executable resolution only in these batches. Preserve each operation's target guards, capture/receipt requirements, timeout boundaries and command arguments; the separate evidence plan owns other behavioral defects.

```ts
export class IdentityCache<T> {
  get(key: string, load: () => T): T;
  clear(): void;
}
```

- [ ] Implement fixtures for same-process root/version switches and replacement/removal of a selected binary/proto. Use injected schema loaders and ADB runners; no fixture opens a device connection.

```js
const cache = new IdentityCache(); let loads = 0;
assert.equal(cache.get("old-bytes", () => ++loads), 1);
assert.equal(cache.get("old-bytes", () => ++loads), 1);
assert.equal(cache.get("new-bytes", () => ++loads), 2);
```

- [ ] Run `npm run build`, then `node --test test/toolchain-cache.mjs`; retain failure. Add an integration case proving `loadProto` for6.1 does not return a previously loaded6.0 schema before selecting the minimal fix.
- [ ] Implement a one-entry identity cache; only publish values after successful `load`. Errors and unavailable selections are not cacheable. Resolve/revalidate file identities before lookup, including transitive `.proto` imports within the selected library directory.
- [ ] Make `adbPath` consume the selected context with one common explicit/PATH/bundled precedence. Preserve explicit `PICO_ADB`; validate its bytes and expose provenance rather than assuming a bundled SDK version. Migrate direct fallback users through the same adapter in bounded consumer batches.
- [ ] For `loadVaultIndex`, compute a stable key from canonical root, package metadata and sorted declaration filenames/content hashes. Preserve absent-then-provisioned behavior; remove stale successful entries on changed/removal input. Do not cache a historical declaration index as target compatibility.
- [ ] Add same-process JDK fixtures for changing `JAVA_HOME`, replacing/removing its `bin/java`, changing its executable permission, and an absent JDK becoming present. Include unchanged-environment replacement of Android Studio's bundled JBR and higher-priority `JAVA_HOME` appearing after a fallback was selected.

```js
const jdkIO = (home, executable) => toolchainIOFromTree({platform:"darwin", home:"/fixture",
  env:{JAVA_HOME:home}, files:{[`${home}/bin/java`]:{bytes:"fixture-java", executable}}});
assert.equal(detectJavaHome(jdkIO("/jdk-a", true)), "/jdk-a");
assert.equal(detectJavaHome(jdkIO("/jdk-b", true)), "/jdk-b");
assert.equal(detectJavaHome(jdkIO("/jdk-b", false)), null);
assert.equal(detectJavaHome(jdkIO("/jdk-b", true)), "/jdk-b");
assert.deepEqual(gradleEnv(jdkIO("/jdk-a", true)), {JAVA_HOME:"/jdk-a"});
```

- [ ] Retain the behavioral failure against the existing unkeyed `cachedJavaHome` before fixing it. Remove this cheap discovery cache and revalidate the ordered candidate files each call; never cache `null`. Preserve `JAVA_HOME` followed by the existing bundled-JBR candidates, including the user-home candidate. Replacing/removing a path or retargeting a symlink must be observed without restarting MCP; source comments must not imply an unimplemented `/usr/libexec/java_home` fallback.
- [ ] Extend `test/preflight.mjs` so JDK inspection and `gradleEnv` receive identical injected context after environment/path changes. Rebuild; run `node --test test/toolchain-cache.mjs` and `node test/preflight.mjs`. These fixture assertions execute neither Java nor Gradle.
- [ ] Extend `test/vault.mjs` with successful same-path replacement and missing-then-created vaults. Keep current endpoint/serial safety covered by `test/observation.mjs` and `test/navigation.mjs`; do not edit knowledge-process retirement logic.
- [ ] Rebuild; run Task4 cache tests, `node test/vault.mjs`, `node --test test/observation.mjs test/navigation.mjs`. Commit bounded cache changes with `fix: invalidate selected SDK resource caches`.

### Task 5: Make declaration authority explicit and versioned

**Files:** Create `src/declarationcontext.ts`, `data/sdk-compatibility/index.v1.json`, `data/sdk-compatibility/basis/sdk-6.0.0-drift.md`, `data/sdk-compatibility/basis/sdk-adoption-provenance.json`, `test/declarationcontext.mjs`; modify `src/vault.ts:458–537,775–880`, `src/vaultdiff.ts:37–59,134–175`, `src/lint.ts:934–965`, `src/doors.ts:474–475`. Coordinate the `package.json.files` addition and installed-package verifier in Task6 with the release owner.
**Interfaces:** Consume `ProjectSdkIdentity` plus CLI root/workspace hints. The SDK track owns `readDeclarationIdentity` and `loadVerifiedCompatibilityEvidence`; no caller/provider JSON may assert authority.

Import `FileIdentity`/`ToolchainIO` from `toolchainselection.ts` and `ProjectSdkIdentity` from `projectidentity.ts`. Export result types for consumers; keep record validation, private acceptance branding and the fixed package-owned index path inside this module. Neither reader invokes the CLI, Gradle or a service.

```ts
export interface DeclarationIdentity {
  root: string; packageRevision: string | null; fingerprint: string;
  authority: "declarations" | "prose"; sources: readonly FileIdentity[];
}
export type DeclarationIdentityResult = {status:"ok"; identity:DeclarationIdentity}
  | {status:"unavailable"; code:string; detail:string};
export interface DeclarationIO extends Pick<ToolchainIO,"read"|"entries"|"realpath"> {
  artifactPath(coordinate:string, sha256:string): string | null;
}
export interface CompatibilityRecordV1 {
  schemaVersion:1; id:string; declarationFingerprint:string;
  packageRevision:string; targetBom:string;
  sourceFiles:readonly FileIdentity[]; // root-relative declaration paths; no user-project paths
  artifacts:readonly {side:"source"|"target"; coordinate:string; sha256:string}[];
  signatures:readonly {symbol:string; sourceSha256:string; targetSha256:string}[];
  symbols:readonly string[]; verdict:"compatible"|"incompatible"; basis:readonly FileIdentity[];
}
declare const verified: unique symbol; // module-private; also enforce runtime WeakSet membership
export type VerifiedCompatibilityEvidence = CompatibilityRecordV1 & {
  readonly [verified]:true; record:FileIdentity;
  binding:{projectRoot:string; projectFingerprint:string; artifactsFingerprint:string};
};
export interface CompatibilityLoadResult {
  accepted:readonly VerifiedCompatibilityEvidence[];
  rejected:readonly {path:string; code:string; detail:string}[];
}
export interface DeclarationContext {
  source: DeclarationIdentity; target: ProjectSdkIdentity | null;
  status: "target-compatible" | "historical" | "unknown" | "incompatible";
  evidencePaths: readonly string[]; verifiedSymbols:readonly string[];
}
export function readDeclarationIdentity(root:string, io?:DeclarationIO): DeclarationIdentityResult;
export function loadVerifiedCompatibilityEvidence(paths:readonly string[], source:DeclarationIdentity,
  target:ProjectSdkIdentity, io?:DeclarationIO): CompatibilityLoadResult;
export function resolveDeclarationContext(source: DeclarationIdentity, target: ProjectSdkIdentity | null,
  evidence: readonly VerifiedCompatibilityEvidence[]): DeclarationContext;
```

- [ ] Read the actual historical inputs before creating records. `test/fixtures/sdk-adoption-provenance.json` has `sdkVersion`, artifact-coordinate map and entries containing symbol/import/signature/artifact/source-entry strings; it has no artifact hashes, local vault fingerprint or target mapping. `docs/SDK_6_0_0_DRIFT.md:249` reports three changed public method signatures; `:728` supplies old/new artifact hashes; `:777` limits the static measurement. Neither grants whole-vault6.0 compatibility or any6.1 authority.
- [ ] Build declaration fixtures using `toolchainIOFromTree` and adapt it to `DeclarationIO` with an explicit coordinate/hash→path table. Define `/vault/package.xml`, one `knowledge/api-reference/*.md` file, `/project/gradle/libs.versions.toml` and tiny labeled source/target artifact files; compute hashes from those fixture bytes. No synthetic fixture is labeled a real SDK measurement.

```js
const read = readDeclarationIdentity("/vault", io); assert.equal(read.status,"ok");
const rejected = loadVerifiedCompatibilityEvidence(["/caller/claims-compatible.json"], read.identity, target, io);
assert.equal(rejected.accepted.length,0);
assert.equal(rejected.rejected[0].code,"record-not-reviewed");
assert.equal(resolveDeclarationContext(read.identity, target, rejected.accepted).status,"unknown");
assert.equal(readDeclarationIdentity("/missing-vault", io).status,"unavailable");
```

- [ ] Run `npm run build`, then `node --test test/declarationcontext.mjs`; retain failure. Add same-root byte replacement, missing/malformed revision metadata, unreadable files, root escape and directory-only hints. Identity reading canonically sorts relative filenames and hashes actual package/API bytes; no revision is inferred from a directory label. Missing metadata yields unavailable for declaration authority; prose-only roots remain prose and cannot authorize target declarations.
- [ ] Implement the reader with existing bounded filesystem conventions; reject symlink escapes, duplicate canonical entries or files changed during reading. Record canonical root separately from a deterministic content fingerprint over root-relative package/API filenames and exact hashes; identical declaration installations at different roots must match. Retain reader-created identities privately. Acquisition hints are never trusted fingerprints.
- [ ] Create a package-owned index with schema `{schemaVersion:1, records:FileIdentity[], historicalReferences:FileIdentity[]}` at a fixed module-relative path. `records` starts empty until complete reviewed mappings exist. Copy the historical document/fixture byte-for-byte into the two `basis/` paths above; hash those packaged snapshots and preserve the source originals unchanged. Only records listed by relative path and exact SHA256 in this reviewed index are candidates; caller paths cannot add trust anchors.
- [ ] Implement `loadVerifiedCompatibilityEvidence` with strict schema/field/hash checks and nonempty exact symbol/signature scope; reject wildcards and version ranges. Artifact identifiers use `group:artifact:version[:classifier]@extension`. Reject unindexed records as `record-not-reviewed`; unknown schema as `record-schema`; altered record/basis/input bytes as `evidence-hash`; missing artifacts as `artifact-unavailable`; wrong source/artifact-set/revision/BOM as `context-mismatch`; unresolved project identity as `target-unresolved`.
- [ ] Reviewed records bind declaration content, source/target artifact coordinates and hashes, target BOM and scoped signature hashes. They contain no project root, target project file list or project fingerprint. Normalize the SDK set by sorted full coordinates/hashes for `com.pico.spatial*` groups and any explicitly identified Compose-fork coordinates; unrelated application dependencies do not enter this set, while unexpected SDK modules prevent an exact match. Both artifact bytes and reviewed signature derivation/basis must verify. Different applications using the same exact resolved SDK reuse one record without a package update.
- [ ] After record verification, re-read the current project files/identity and construct a private `binding` containing its canonical root, current fingerprint and normalized artifact-set fingerprint. Acceptance is specific to that current project state even though the record is reusable. Before using an accepted result, compare its binding with a fresh current project identity; changes invalidate reuse and require loading again. All runtime basis references resolve inside packaged reviewed data, independent of checkout-only docs/test paths.
- [ ] Historical records require a separately reviewed, retained derivation linking local vault declarations to the historical source artifacts and scoped target signatures. Preserve the document's real core hashes (0.13.3 binary `29b5ec6bdc85238d61914990fdafd2d00b535bf49bc2d018a08ff17f3071dcd0`;6.0.0 binary `92bc5d19b048d9c083681e550e86dc6aaafddf75731a4989f5a8e8165d3db5df`) as historical inputs only. If complete local vault/target/file linkage cannot be verified, retain references and return unknown rather than manufacturing an accepted mapping.
- [ ] Add an indexed fixture record with exact source/target/artifact/basis hashes; assert acceptance only after every byte is available. Mutate each bound file independently and assert rejection; test unindexed caller JSON, changed index entry, changed revision, missing artifact, wrong target, broad symbols and declared-only BOM. Test source013→target61 without a reviewed mapping remains unknown even when all version strings are syntactically valid.
- [ ] Add two temp-project fixtures with different canonical roots/config bytes and fingerprints but identical resolved SDK artifacts; use one indexed record for both. Then change one target artifact and separately change project configuration without changing artifacts: the former rejects mapping applicability; the latter rejects old binding reuse but allows fresh verification with the same reusable mapping.

```js
const a = loadVerifiedCompatibilityEvidence([recordPath], source, projectA, io).accepted[0];
const b = loadVerifiedCompatibilityEvidence([recordPath], source, projectB, io).accepted[0];
assert.equal(a.record.sha256,b.record.sha256);
assert.notEqual(a.binding.projectFingerprint,b.binding.projectFingerprint);
assert.equal(loadVerifiedCompatibilityEvidence([recordPath], source, changedArtifactProject, io).accepted.length,0);
assert.equal(resolveDeclarationContext(source, projectB, [a]).status,"unknown");
```

- [ ] `resolveDeclarationContext` accepts only privately branded loader results, validated at runtime; no target means historical, no applicable verified record means unknown, conflicting applicable records mean incompatible. Populate `verifiedSymbols`; a lookup outside that set remains unknown even when another symbol has a compatible mapping. Prose never grants declaration authority.
- [ ] Unify vault workspace enumeration/default/explicit version resolution with the selected root. Treat an explicit vault path as an explicitly identified source, not proof of target compatibility. Preserve historical lookup and `documented-only`; unknown target authority must not report target symbol absence.
- [ ] `vault_api` and the door accept project/source hints and optional reviewed-record paths, then call the SDK-owned reader/loader. Never accept caller-created `DeclarationIdentity` or a compatibility boolean in public schemas. Keep historical lookup clearly labeled; report unavailable identity, unknown target linkage and incompatible scoped signatures distinctly. Bound version strings against path traversal.
- [ ] In `preflight_lint`, use project identity when supplied; keep mismatched/unknown vault results in the advisory block and avoid successful target-validation wording. `clean` remains derived from existing violations/project errors only.
- [ ] Preserve `docs/SDK_6_0_0_DRIFT.md` and `test/fixtures/sdk-adoption-provenance.json` as historical evidence. Add new measured mapping records only after separate artifact verification; never relabel them6.1. Update current metadata tests without deleting historical provenance assertions.
- [ ] Rebuild; run `node --test test/declarationcontext.mjs`, then `node test/vault.mjs`, `node test/vaultdiff.mjs`, `node test/lint.mjs`, `node test/doors.mjs`. Commit Task5 files with `fix: bind SDK declaration authority to explicit provenance`.

### Task 6: Seal the static compatibility boundary and hand off runtime checks

**Files:** Extend `test/toolchain-consumers.mjs`, `test/declarationcontext.mjs`; create `scripts/verify-sdk-compatibility-payload.mjs`, `test/declarationcontext-installed.mjs`; coordinate edits to `package.json.files` and `scripts/verify-tarball.mjs` with the release owner. Add result notes to fresh `evidence/<date>-sdk61-selection-001/REVIEW.md` during execution.
**Interfaces:** Consume Task1 selection, Task3 project identity and Task5 declaration context; no new transport or acquisition API.

- [ ] Add a combined fixture: host tools6.1, project BOM6.0.0, historical vault0.13.3 and a second project with unknown/dynamic BOM. Assert truthful independent versions, no project write, and no target authority without matching compatibility evidence.
- [ ] Add an operation matrix covering preflight, packer workflows, ADB/proto cache selection and vault/lint responses; use captured fake runner calls and verify no legacy fallback launches occur. Keep failed/missing selection cases independently asserted.
- [ ] Read the current main handoff and CLI adapter plan. CLI supplies root/workspace hints only; SDK calls `readDeclarationIdentity` then `loadVerifiedCompatibilityEvidence` and owns authority. Test a fabricated CLI version/fingerprint cannot bypass local-byte checks; unsupported transport stays unavailable. This plan does not call advertised or removed CLI paths.
- [ ] Coordinate adding only `data/sdk-compatibility` to `package.json.files`: the current allowlist excludes `data/`, `docs/` and `test/`. Include the index, actual reviewed records and all transitively required basis snapshots/hashes; do not ship the entire source documentation or fixture tree. Preserve originals and verify each basis copy's hash against its historical source during packaging.
- [ ] Export `verifySdkCompatibilityPayload(packageRoot)` from `scripts/verify-sdk-compatibility-payload.mjs`; it checks the installed index and every referenced record/basis byte and returns `{ok:boolean, checked:FileIdentity[], errors:string[]}`. Resolve from `packageRoot`/module URLs, never cwd or a source checkout. The release owner's installed-tarball gate must invoke this canary on the extracted package and fail if required data is missing or altered.
- [ ] Add `test/declarationcontext-installed.mjs`: run the same canary from an unrelated cwd against a relocated package fixture without `docs/` or `test/`; assert identical hashes and successful historical-reference loading. Fixture lifecycle: remove a required basis file, assert unavailable/failure; restore its exact bytes and assert fresh loading recovers in the same process. A previously accepted mapping must not survive a changed/missing packaged basis. No CLI, provider, Java or native process is started.
- [ ] Run `node --test test/declarationcontext-installed.mjs` after rebuilding. Let the release track run the actual immutable tarball/install lifecycle and canary; do not run the current broad `test:tarball` blindly from this SDK task. An empty production mapping list is valid, but a missing index or declared historical basis is not.
- [ ] Run `npm run build`, then the narrow new suites with `node --test test/toolchain-resolution.mjs test/toolchain-consumers.mjs test/projectidentity.mjs test/toolchain-cache.mjs test/declarationcontext.mjs`.
- [ ] Run affected existing host suites once: `node test/preflight.mjs`, `node test/projectgen.mjs`, `node test/vault.mjs`, `node test/vaultdiff.mjs`, `node test/lint.mjs`, `node test/doors.mjs`. Repeat only for new changes/failures.
- [ ] Coordinate `package.json`/CI registration with the release owner so these suites run in the existing host gate; do not independently alter byte-pinned policy text or create an unregistered test script.
- [ ] Record source SHA, exact commands, failures and final results. Explicitly distinguish hermetic platform fixtures from native platform support, structural payload discovery from binary compatibility, and provider help from semantic knowledge behavior.
- [ ] Commit only reviewed integration tests/evidence with `test: cover mixed SDK selection and declaration provenance`. Return to the root for separately authorized real CLI/toolchain checks; do not run `test/provision.mjs`, broad smoke, emulator calibration or SDK6.1 native acceptance from this plan.

Record separate capability rows for structural6.1 selection, explicit-component refusal, project-BOM preservation, cache replacement, historical lookup, target-matched authority and each platform fixture. A passing row must link its exact test/fixture result, not a generic suite name. Real host binary probes, artifact resolution and native acceptance start as unexecuted rows and stay so until independently evidenced.

## Completion conditions and self-review

- [ ] Every explicit unavailable component pin fails closed; project operations use one selected identity and preserve BOM bytes.
- [ ] Mixed installations, platform paths and same-process cache changes have hermetic evidence; no platform default is invented.
- [ ] Historical declarations remain accessible and labeled; target authority requires exact provenance and lint advisory semantics remain unchanged.
- [ ] All plan interface names/types match across tasks; the main handoff link exists and conflicts are resolved before execution. CLI inputs are hints only; SDK owns both identity reading and accepted/rejected compatibility validation.
- [ ] No app migration, CLI/device action or runtime compatibility claim is included in the completed static checkpoint.
