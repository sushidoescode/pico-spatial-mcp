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

