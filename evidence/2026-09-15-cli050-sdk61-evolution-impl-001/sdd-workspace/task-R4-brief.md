### Task 4: Make default smoke hermetic and host integration explicit

**Files:** Modify `test/smoke.mjs`, `test/helpers/buildrun-smoke-fixture.mjs`, `test/buildrun-smoke-fixture.mjs`, `.github/workflows/gates.yml:49–52`, `README.md:312–323`; create `test/sdk-integration.mjs`, `test/smoke-isolation.mjs`; coordinate `GATES` edits with Task 3.

**Interfaces:** Export `parseIntegrationArgs(argv): {projectDir:string,bundlePath:string,outputDir:string}` from `test/sdk-integration.mjs`. Its CLI requires all three absolute, explicit paths; output must be a new task directory. Default `smoke` never selects integration by detecting a locally installed SDK.

- [ ] Add a fixture invocation log to the fake Gradle/adb programs and a fake npm that rejects calls. Exercise smoke with fake binaries and verify only documented fixture operations occur; fail if any real project/package/device is targeted.
```js
assert.throws(() => parseIntegrationArgs([]), /--project.*--bundle.*--output/);
assert.ok(calls.every(call => call.serial === 'fixture-serial' || call.kind === 'fixture-gradle'));
assert.equal(npmCalls.length, 0);
```
- [ ] Run `node --test test/smoke-isolation.mjs` and preserve the expected current Claimsight/host-probe failure.
- [ ] Remove Claimsight constants, `SMOKE_SDK_OPTIONAL`, and the error-text skip regex from default smoke. Keep registration/output-schema/pure-tool checks and the existing fake build success path. Move `validate_toolchain`, `emulator_list`, real bundle pack/inspect, and SDK/proto discovery into explicit integration.
- [ ] Keep the default server invocation under explicit fixture SDK/CLI settings; use the existing fake `PICO_HOME` and fixture serial pattern. Assert startup and pure-tool checks make no registry/npm/setup/device calls. Do not repurpose the user's home variables or alter their CLI policy.
```js
const args = parseIntegrationArgs(process.argv.slice(2));
for (const input of [args.projectDir, args.bundlePath]) fs.accessSync(input, fs.constants.R_OK);
fs.mkdirSync(args.outputDir); // no recursive replacement; EEXIST preserves prior evidence
```
- [ ] Integration must check prerequisites before invocation and return explicit pass/fail/skipped records with reasons. A supplied malformed project, tool crash, schema mismatch, or unsuccessful pack is a failure; absence of optional tooling is a labeled skip, never success evidence.
- [ ] Remove CI's `SMOKE_SDK_OPTIONAL` escape hatch. Run `npm run build`, `node --test test/smoke-isolation.mjs`, `npm run smoke`, and the existing fixture suite. Default smoke must behave identically whether a host SDK/Claimsight checkout exists.
- [ ] Document the explicit integration command and its mutations; do not execute it against paused Mission Replay. Commit with `git commit -m "test: isolate smoke from personal SDK projects"`.

