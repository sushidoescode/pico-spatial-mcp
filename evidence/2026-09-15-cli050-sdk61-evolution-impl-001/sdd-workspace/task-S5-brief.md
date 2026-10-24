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

