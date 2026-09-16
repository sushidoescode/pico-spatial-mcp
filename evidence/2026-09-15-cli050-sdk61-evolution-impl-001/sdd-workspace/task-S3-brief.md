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

