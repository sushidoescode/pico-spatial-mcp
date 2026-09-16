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

