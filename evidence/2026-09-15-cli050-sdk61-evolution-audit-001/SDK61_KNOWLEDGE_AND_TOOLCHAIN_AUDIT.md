# SDK 6.1 toolchain and knowledge audit

Date: 2026-09-15. Repository: `/Users/sushantsrikrish/PICO-MCP`. Inspected source HEAD: `308c898e9c33975b5a21ecb78fed245fab17a0ed` (`Merge branch 'fix/space-program-request-list'`). The tree was clean at the initial assessment; the final read before saving this report showed only the concurrently prepared untracked `evidence/` directory. Mission Replay remains paused at its retained build068 checkpoint.

This is a bounded static audit and implementation handoff. The auditor read repository source, corresponding selected `dist` files, scripts and test definitions. The auditor did not invoke the CLI, query a knowledge provider, operate the emulator, install anything, execute a toolchain binary, build, run tests or edit application/MCP source. Saving this report is the sole authorized write in this follow-up. Proposed names and contracts below are recommendations, not implemented APIs or demonstrated test results.

Root independently confirmed that CLI 0.5.0 is published; the installed ambient package and MCP-managed cache remained 0.4.4 in the retained host observations. Root's fresh doctor selected host tools SDK 6.1 and reported spatialbundle `6.1.0.0-rls.25`, while preflight still reported an existing `sdk/0.13` directory. Host tools version, project BOM/resolved Maven artifacts, vault package revision and CLI version are separate identities. None establishes compatibility of the others merely by being installed.

## Assessment

Targeted compatibility work should suffice. The concrete gaps are inconsistent tool selection, incomplete propagation of project context, stale process-wide caches and declaration provenance that is not bound to the target project. The evidence does not justify a blanket SDK/BOM migration, global CLI replacement or changes to native safety gates.

The current shared toolchain resolver already recognizes `6.1`: `src/toolchain.ts:44` permits two- or three-component numeric directory names; `:61–68` compares numeric segments; `:88–91` picks the newest usable payload. The mixed doctor paths have a concrete source explanation, rather than establishing an invalid 6.1 installation: `src/preflight.ts:200–205` still appends `0.13` to `PICO_HOME` or checks the macOS default `sdk/0.13`, and checks only existence/mtime. The same legacy check is present in `dist/preflight.js:158–163`. Selected shared resolver behavior is also present in `dist/toolchain.js`; this is not explained solely by stale generated JavaScript.

## Work package 1 — Shared, injectable tool selection

### Existing implementation and findings

- `src/toolchain.ts:15–29`: `ToolsRoot` and `resolveToolsRoot(projectDir?)` implement `local.properties[spatial.tools.dir] → PICO_HOME → ~/Library/PICO/sdk`. Project properties are read with a single regular expression, not a complete Java-properties parser.
- `src/toolchain.ts:32–58`: `VersionInfo` and `listVersions` inspect version directories and extensionless `spatialbundle`/`emulator` files. Nonempty component directories and actual executable paths are separate fields. Directory reads can throw for malformed or unreadable entries.
- `src/toolchain.ts:80–91`: `pickVersion(root, requested?, need)` checks component availability only in the automatic-selection branch. A requested directory is returned at line 87 even if the requested component is absent. Some callers check the resulting executable; the shared selection contract itself does not enforce its stated requirement.
- `src/toolchain.ts:130–138`: `findAdb` invokes POSIX `which` first, then tries the selected emulator's bundled platform-tools. It does not share the explicit `PICO_ADB` precedence used by several other helpers.
- `src/toolchain.ts:157–212`: `validateToolchain` resolves one version with `need: "any"` and then executes packer/emulator version probes. It is not a side-effect-free filesystem resolver and should remain separate from one.
- `src/preflight.ts:145`, `:190–205`: the preflight ADB fallback and SDK payload check use `0.13`. An old directory can pass while a different version is selected elsewhere; a machine with only 6.1 can be misreported.
- `src/preflight.ts:40–68`: `PreflightIO` already supports injectable filesystem/command observations. Extend that seam rather than introducing actual-host reads into otherwise hermetic fixtures.

### Proposed contract

Extend the existing types/functions behind one shared resolver. Suggested new interfaces are `ToolchainSelectionRequest`, `ToolchainSelectionResult` and an injected filesystem/environment adapter. A request should distinguish the Android project root, optional explicit root/version, required component and discovery versus execution use. A result should identify:

- Canonical root and provenance: explicit request, project properties, environment or documented platform default.
- Requested version, selected version, selection reason and other discovered candidates.
- Component-specific executable/proto paths, structural availability and missing requirements.
- Explicit failure/ambiguity reasons, without presenting filesystem inspection as a successful binary probe.

Preserve the existing project-properties/environment/default root precedence unless an explicit request overrides it. A requested version must satisfy its required component or fail; never silently fall back from an unavailable explicit pin. Detect conflicting explicit/project pins, invalid explicit roots and indistinguishable version aliases containing different payloads rather than silently switching tools. Host discovery may retain deterministic newest-usable selection with its reason reported. Project operations should receive one resolved selection consistently; a project version pin is a proposed feature, not an existing documented `local.properties` key identified by this audit. Do not invent an official Gradle pin property without verifying its declaration.

Replace preflight's legacy SDK existence check with the same structural selection result. Report missing build and emulator components separately instead of implying that a valid ADB proves a build SDK. No resolver inspection should provision SDK/CLI payloads or run repairs.

### Future tests

Add a hermetic `test/toolchain-resolution.mjs` and extend `test/preflight.mjs`. Cover only-6.1, coexisting 0.13/6.0/6.1, numerical ordering, requested missing component, empty/non-directory/unreadable payloads, invalid explicit roots, property/environment precedence, version aliases and contradictory pins. Existing `test/preflight.mjs:50` supplies a non-null mtime for every path in its healthy fixture; that fixture alone cannot detect wrong-version directory selection.

## Work package 2 — Carry project context through packers and scaffolding

### Existing implementation and findings

- `src/bundle.ts:12–16`: `getSpatialbundle(toolsVersion?)` resolves the host root without a project. `pack_bundle` accepts `projectDir` at `:70` and receives it at `:82`, but the selector call at `:83` receives only `toolsVersion`.
- `src/editor.ts:44–64`: `editorPaths(toolsVersion?)` also resolves without project context. The editor build operation receives `projectDir` at `:147` but selects paths with only the version at `:148`.
- `src/workflow.ts:100–111`: the workflow accepts `projectDir`, independently selects a host root, then passes the supplied project to the packer. The packer selection and project can therefore describe different installations.
- `src/editorexport.ts:19–22` and `src/bundlediff.ts:19`: separate resolver paths default to the 0.13 packer, with `PICO_SPATIALBUNDLE` override support. Corresponding legacy paths remain in `dist/editorexport.js:17` and `dist/bundlediff.js:16`.
- Independent ADB paths also remain, for example `src/verifyapk.ts:11`, `src/webbrowser.ts:10`, `src/webworkspace.ts:10`, `src/hybridbuild.ts:14`, `src/fleetbuild.ts:40`, `src/deploy.ts:19` and their generated counterparts. These need a common explicit/PATH/bundled selection policy, not a literal replacement of `0.13` with `6.1`.
- `src/projectgen.ts:136–152`: `GenerateOptions` and `GenerateResult` carry no tool-selection/provenance fields. `generateSpatialProject` writes the host-resolved tools root to `local.properties` at `:197–206`.
- `src/scaffold.ts:164–173`: the clone path overwrites a copied `spatial.tools.dir` with the host-resolved root. That is an implicit selection change at a project boundary.
- `appskeleton/gradle/libs.versions.toml:5` pins BOM `6.0.0`; the generator copies that file. Host tools installation must not silently change it.

### Proposed contract

Distinguish `androidProjectRoot` (where `local.properties` lives) from `spatialProjectDir` (the editor project passed to `spatialbundle -p`). Existing tool parameters sometimes mean the latter. Avoid blindly treating every `projectDir` as an Android root; use explicit context or bounded, validated ancestor discovery with an ambiguity result.

Pass an already-resolved selection object through each operation and record its packer/executable identity in the receipt. Maintain existing explicit binary overrides, but validate and disclose their identity and any conflict with a requested version. Do not select a newer executable at a later stage of the same operation because another installation appeared.

Add explicit selection/provenance fields to project generation. Decide the clone's destination host root through that same contract and disclose the resulting configuration rather than silently replacing a project setting. Keep host tool version, project BOM and actual resolved module versions separate. A static project identity extractor should report recognized version-catalog/direct dependency declarations separately from resolved dependency evidence; return unknown for dynamic or unsupported Gradle expressions.

`src/projectconfig.ts:27–40` already separates static and optional resolved configuration results but is not a general BOM identity resolver. `scripts/sdk-facts.mjs:20–23`, `:217–255` and `:676–688` can support later artifact measurements and alternate-BOM experiments, but it runs Gradle. It must not be called implicitly by a static inspector or be treated as a pure filesystem function. Its `--bom` mechanism changes dependency resolution through an init script; it is not permission to migrate the paused app.

### Future tests

Extend `test/projectgen.mjs` with two projects using different roots, consistent generated provenance, BOM preservation, explicit override conflicts and Java-properties path serialization. Add handler fixtures proving bundle/editor/workflow stages receive the same resolved project selection. Existing `test/projectgen.mjs:109–110` checks that `spatial.tools.dir` is present, not that it is the right selection.

`test/provision.mjs:73–105` can invoke the real installed packer when available. Do not use it as the hermetic resolver fixture suite or casually run it in a read-only phase. It remains useful later for an explicitly scoped real packer check.

## Work package 3 — Revalidate caches after selection or payload changes

### Concrete cache boundaries

- `src/adb.ts:6–15`: one module-level `cachedAdb` is returned before reconsidering root, environment, selected version or file existence.
- `src/grpc.ts:29–52`: `loadProto(toolsVersion?)` returns the first `loaded` proto at line 32 before resolving a later requested version. A long-lived MCP process can therefore reuse an old schema even when its caller requests another tools version.
- `src/toolchain.ts:103–121`: `cachedJavaHome` stores both success and absence without an environment/file-identity key. Although not a 6.1-specific regression, the same resolver contract should avoid stale discovery after configuration changes.
- `src/vault.ts:456–494`: successful vault indexes are memoized only by root string. Replacing declarations/package metadata at the same path leaves the previous index in memory. The deliberate choice not to cache missing vaults permanently is valuable and should be retained.

### Proposed contract and tests

Key ADB/proto caches by the resolved selection and relevant file identity; revalidate before reuse. A proto key must include the schema files needed for loading, not merely the selected directory label. Canonicalize root aliases before caching. Vault caching needs a package/API-file fingerprint or equivalent explicit invalidation that detects same-path replacement, including source removals. Avoid hashing every large payload gratuitously; define exactly which identity fields make reuse valid, and strengthen to content hashes for retained provenance where needed.

Add fixtures that switch root/version requests within one process, change the environment, remove or replace a cached executable/proto, replace a vault at the same path and provision an initially missing vault. Extend `test/vault.mjs` and add hermetic ADB/proto cache tests. Existing endpoint-binding tests in `test/observation.mjs` and `test/navigation.mjs` must continue to enforce serial/discovery/token/process identity independently of schema caching.

Do not replace the existing knowledge child lifecycle machinery as a side effect. `src/knowledge.ts:955–977` already retires a child when its CLI path/version/source identity changes and blocks replacement when retirement is unproved. `:1126–1144` resolves CLI identity before use. Preserve its bounded ownership/retirement behavior and corresponding `test/knowledge-lifecycle.mjs` coverage. Graph context remains distinct from exact SDK declaration authority.

## Work package 4 — Bind declaration authority to the target project

### Existing implementation and findings

- `src/vault.ts:458–459`: `defaultVaultRoot` uses `PICO_AGENT_VAULT` or the macOS 0.13 vault, independently of the shared tools root.
- `src/vault.ts:478–486`: `sdkVersion` is parsed from the vault's `package.xml`; it is optional metadata. This is a package revision, not independently proven target Maven/BOM compatibility.
- `src/vault.ts:508–533`: `searchVaultDocs` correctly returns secondary prose evidence. Preserve its weaker evidence class.
- `src/vault.ts:775–785`: provenance explicitly identifies the 0.13.3 default and measured 6.0.0 drift document. `src/doors.ts:475` exposes the same historical baseline. These are useful disclosures, not 6.1 compatibility evidence.
- `src/vault.ts:810–815`: explicit `sdkVersion` builds a macOS-default path instead of resolving from the project/environment root.
- `src/vaultdiff.ts:37–59`, `:134–137`: workspace enumeration and version-to-root conversion independently use the macOS SDK base. Explicit paths are supported, but the default/root contract is inconsistent.
- `src/lint.ts:934–965`: the tool accepts `projectDir` but calls `loadVaultIndex()` without project context at line 949. The success language at lines 955–961 can describe a default-vault lookup without establishing that its declarations match the project's SDK.
- `src/lint.ts:942–943`, `:967` and `:986–991`: vault and graph stages are deliberately advisory and must not change `clean`; preserve this separation.

### Proposed contract

Unify `defaultVaultRoot`, `loadVaultIndex`, `searchVaultDocs`, `listVaultWorkspaces` and `vaultdiff.resolveRoot` behind a declaration-context result. Suggested fields include target project/BOM/resolved artifact identity, selected vault root, vault package revision, source fingerprints, compatibility status and the evidence establishing that status.

Do not equate a host directory named `6.1`, a vault `package.xml` revision and Maven BOM `6.1.x`. Establish the relationship through a retained compatibility mapping or matching artifact declarations. Unknown or mismatched context must prevent `vault_api` from presenting a declaration as authoritative for that target. An explicitly requested historical lookup can still return clearly labeled historical declarations. Missing/unknown provenance must not become a claim that the symbol does not exist in the target SDK.

Pass project declaration context into the advisory lint stage. On mismatch or unknown compatibility, report a separate unavailable/incompatible knowledge result and avoid target-validity language; do not alter the retained-lessons `clean` calculation or turn a vault coverage gap into an app defect. Keep `documented-only` for prose, and graph responses as context-only.

Preserve the existing 0.13.3 and measured 6.0.0 evidence. Do not rewrite labels in `docs/SDK_6_0_0_DRIFT.md` or `test/fixtures/sdk-adoption-provenance.json` to imply 6.1 measurements. New target claims need new provenance and appropriate declaration/compile evidence.

### Future tests

Extend `test/vault.mjs`, `test/vaultdiff.mjs`, `test/lint.mjs` and relevant `test/doors.mjs` contracts. Cover matching, mismatched and unknown revisions; explicit historical lookup; environment/project roots; same-path replacement; missing-then-provisioned vaults; prose-only results; and lint's unchanged advisory boundary. `test/vault.mjs:15–59` currently asserts the historical 0.13.3/6.0.0 disclosure across result variants and the door metadata; preserve that historical truth while adding target-specific provenance. Existing fixtures are labeled data, not new native validation.

## Work package 5 — Platform-aware roots and path handling

`src/toolchain.ts:11–13` defaults to macOS SDK/AVD/discovery locations, `:47–48` assumes extensionless tools, and `:132` invokes POSIX `which`. `src/editor.ts:48–61` assumes a macOS `.app` layout. `src/projectgen.ts:112–123` has Android SDK candidates for macOS/Linux/Windows, but this does not establish PICO tools discovery on those platforms.

Introduce platform-aware path and executable handling in the shared selection adapter. `src/picocli.ts:62–85` provides an existing JS-based PATH/PATHEXT approach, including Windows case-insensitive environment lookup and avoiding POSIX `which`. Reuse a common low-level utility where appropriate rather than coupling generic SDK discovery to CLI provisioning.

Use only verified/documented PICO install roots. Where a platform layout is unverified, accept an explicit validated root or return unsupported/unknown with clear provenance; do not invent a native default based on the Android SDK's layout. Explicit paths and property values need correct Java-properties parsing/serialization, spaces, drive letters and UNC handling.

Future hermetic tests should cover Windows drive/UNC paths, `.exe`/PATHEXT, quoted PATH entries, case-insensitive PATH keys, escaped Java-properties values, Linux explicit roots, macOS defaults, symlink/canonical aliases and paths containing spaces. Such tests prove path handling, not native Windows/Linux/PICO compatibility. Existing Windows CLI/build-run fixture coverage can supply patterns, but is not already coverage of these SDK resolver contracts.

## CLI boundary and retained validation limits

The confirmed CLI release does not require a production hard-pin replacement: `src/picoclimanaged.ts:10` accepts stable semver including 0.5.0; `:263` defaults to `managed-latest`. `src/picoclimanaged.ts:1415–1444` inspects only existing published cache entries and labels them cached. Registry resolution is separate at `:1447–1462`. `src/picocli.ts:887–889` exposes that cache inspection; `src/picoclihealth.ts:23` provides explicit force refresh. A doctor reporting cached 0.4.4 is therefore expected and does not itself demonstrate a broken update path.

`scripts/compare-picocli-surfaces.mjs:36–56` supports exact 0.4.4-to-0.5.0 comparison; `:369–385` uses isolated exact package installations and verifies the reported version; `:466–476` traverses advertised help and excludes setup. `test/picocli-sweep.mjs:1` explicitly uses fake npm/CLI processes. A later real sweep establishes advertised command/help compatibility only; machine envelopes and selected read-only command behavior require separate bounded checks. This auditor performed none of those runtime checks.

Root's observed calibration predating the new emulator boot is a valid independent failure: `src/preflight.ts:322–342` implements that freshness rule. Do not attribute it to the SDK path bug, silently reuse old camera measurements or weaken the native gate. Native measurement/acceptance remains a separately authorized phase after current calibration and visibility/health requirements are met.

After future source edits, build `dist` before running the relevant tests: the repository's tests import generated JavaScript and have no automatic pretest rebuild. Do not hand-edit `dist` or treat unchanged generated output as validation of a TypeScript change. Broader release/build/native gates belong to the separate release handoff; this report claims no compilation, test pass, CLI 0.5 execution or SDK 6.1 native compatibility. Mission Replay's existing source, BOM, APKs and evidence remain paused and preserved.
