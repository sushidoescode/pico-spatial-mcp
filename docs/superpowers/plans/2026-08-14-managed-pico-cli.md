# Managed Latest PICO CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pico-spatial-mcp server runtime operation backed by pico-cli automatically use an exact, MCP-owned registry-latest CLI without modifying ambient/global installs, while preserving an honestly labeled cached fallback when freshness cannot be established.

**Architecture:** Add a focused `picoclimanaged.ts` module for policy parsing, immutable version discovery, exact-version provisioning, and freshness provenance. Keep process execution and wrapper failure classification in `picocli.ts`, which adapts the managed resolver to existing consumers. Version directories publish atomically from unique staging paths; there is no shared mutable current pointer.

**Tech Stack:** TypeScript/Node 20+, `node:fs`, `node:path`, `node:os`, `node:crypto`, existing `cross-spawn`, Node's built-in test runner, MCP SDK, Zod, GitHub Actions.

## Global Constraints

- Repository visibility remains private; do not change permissions, collaborators, remotes, or push anything.
- Base all work on branch `pico-evolution-2026-08-14` at or after design commit `1fbdda9`.
- Default policy is `managed-latest`; the default `pico_doctor {}` CLI inspection and
  `preflight_env` remain read-only and never contact npm or provision a package. The existing
  explicit `pico_doctor {calibrate:true}` route still performs its separately documented
  calibration work and is not relabeled read-only.
- Managed versions live under `~/.pico-mcp/cli/versions/<exact-version>/`; tests inject a temporary `managedRoot` and never write the real home store.
- The MCP server runtime, managed resolver, and new compatibility sweep never execute an argv
  containing `npm install -g`, `--global`, `pico-cli setup`, or `pico-cli update --check`.
- Never modify ambient/global pico-cli bytes or `PATH`.
- `managed-latest` may use a validated cached version only with `freshness:"unknown"` after a registry failure, or `freshness:"outdated"` after a known-newer install failure; it never claims latest without a successful registry check.
- `managed-cached`, `external`, and `disabled` perform no registry/install operation. `external` requires an absolute `PICO_MCP_CLI_PATH` and is never updated.
- Legacy `PICO_MCP_AUTOINSTALL_CLI=1` and `PICO_MCP_AUTOUPDATE_CLI=1` map to `managed-latest` through 37.x; conflict with another explicit policy is an error.
- CLI package installation and `pico-cli setup` remain separate. Setup-required output is structured `{path,args:["setup"]}` guidance only.
- Tool registration and `tools/list` remain network- and provisioning-free.
- Windows-compatible contracts remain gated, but no native Windows or emulator claim is made in
  this plan. The separately owned Windows evidence probe/workflow is not modified or cited as proof
  here; its current provisioning behavior is outside this server-runtime migration.
- A CLI command result is structural evidence only; no visual evidence class changes in this plan.

---

### Task 1: Managed policy and read-only store inspection

**Files:**
- Create: `src/picoclimanaged.ts`
- Modify: `test/picocli-autoinstall.mjs`
- Test: `test/picocli-autoinstall.mjs`

**Interfaces:**
- Consumes: no new production interface.
- Produces:

```ts
export const PICO_CLI_POLICY_ENV = "PICO_MCP_CLI_POLICY";
export const PICO_CLI_PATH_ENV = "PICO_MCP_CLI_PATH";
export const PICO_CLI_PACKAGE = "@picoxr/pico-cli";
export type PicoCliPolicy = "managed-latest" | "managed-cached" | "external" | "disabled";
export type PicoCliFreshness = "latest" | "outdated" | "unknown" | "cached" | "external";
export type ManagedPicoCliCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  outputTruncated: boolean;
};
export type ManagedPicoCliIO = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  now: () => number;
  randomUUID: () => string;
  run: (command: string, args: string[], options?: {
    timeoutMs?: number;
    killGraceMs?: number;
  }) => Promise<ManagedPicoCliCommandResult>;
};
export type ManagedPicoCliOptions = {
  managedRoot?: string;
  forceRefresh?: boolean;
  installTimeoutMs?: number;
  updateCheckTimeoutMs?: number;
  killGraceMs?: number;
};
export type PicoCliCompatibilityDiagnostic = {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  helpSha256: string;
};
export type PicoCliEnsureResult = /* discriminated union defined below */;
export function resolvePicoCliPolicy(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform):
  | { status: "ok"; policy: PicoCliPolicy; externalPath: string | null; deprecatedAliases: string[] }
  | { status: "invalid"; policy: null; externalPath: null; deprecatedAliases: string[]; note: string };
export async function inspectManagedPicoCli(
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<PicoCliEnsureResult>;
```

- [ ] **Step 1: Write policy tests that fail because the module does not exist**

Add imports and table-driven cases to `test/picocli-autoinstall.mjs`. Each expected value is a
literal, not computed by the production parser:

```js
import {
  inspectManagedPicoCli,
  resolvePicoCliPolicy,
  PICO_CLI_PATH_ENV,
  PICO_CLI_POLICY_ENV,
} from "../dist/picoclimanaged.js";

assert.deepEqual(resolvePicoCliPolicy({}, "linux"), {
  status: "ok",
  policy: "managed-latest",
  externalPath: null,
  deprecatedAliases: [],
});
assert.equal(resolvePicoCliPolicy({ [PICO_CLI_POLICY_ENV]: "disabled" }, "linux").policy, "disabled");
assert.equal(resolvePicoCliPolicy({ [PICO_CLI_POLICY_ENV]: "external" }, "linux").status, "invalid");
assert.equal(resolvePicoCliPolicy({
  [PICO_CLI_POLICY_ENV]: "external",
  [PICO_CLI_PATH_ENV]: "relative/pico-cli",
}, "linux").status, "invalid");
assert.equal(resolvePicoCliPolicy({
  [PICO_CLI_POLICY_ENV]: "managed-cached",
  PICO_MCP_AUTOUPDATE_CLI: "1",
}, "linux").status, "invalid");
for (const policy of [undefined, "managed-latest", "managed-cached", "disabled"]) {
  const env = {
    ...(policy ? { [PICO_CLI_POLICY_ENV]: policy } : {}),
    [PICO_CLI_PATH_ENV]: "/absolute/cli-that-must-not-be-used",
  };
  assert.equal(resolvePicoCliPolicy(env, "linux").status, "invalid");
}
```

Add a read-only inspection fixture with two published versions (`0.4.1`, `0.4.2`) and literal
`install.json`/package metadata. Assert that cached inspection selects validated `0.4.2`, reports
`freshness:"cached"`, invokes only its absolute shim with `-v`, and performs no npm call or write.
Add corrupt-record, mismatched-package-version, mismatched-`-v`, disabled, valid external, and
missing-cache cases.

- [ ] **Step 2: Build and run the focused test to verify RED**

Run:

```bash
npm run build
node --test test/picocli-autoinstall.mjs
```

Expected: the production build still succeeds because no production source imports the new module
yet; the focused test fails with `ERR_MODULE_NOT_FOUND` because `dist/picoclimanaged.js` does not
exist. This is the intended missing-feature failure.

- [ ] **Step 3: Implement policy parsing and immutable cached inspection**

Create `src/picoclimanaged.ts` with the exact policy names above. Define the result union with these
consumer-visible cores:

```ts
export type PicoCliEnsureResult =
  | {
      status: "ok";
      source: "managed" | "external";
      policy: Exclude<PicoCliPolicy, "disabled">;
      action: "present" | "installed" | "updated" | "cached" | "external";
      path: string;
      version: string;
      raw: string;
      latestVersion: string | null;
      checkedAt: string | null;
      freshness: PicoCliFreshness;
      deprecatedAliases: string[];
      compatibility?: PicoCliCompatibilityDiagnostic[];
      warning?: {
        failureClass: "latest-unknown" | "update-failed";
        note: string;
        outputTail?: string;
      };
    }
  | {
      status: "unavailable";
      source: "managed" | "external" | null;
      policy: PicoCliPolicy | null;
      action: "skipped";
      path: string | null;
      version: null;
      raw: string;
      latestVersion: string | null;
      checkedAt: string | null;
      freshness: PicoCliFreshness | null;
      failureClass: "cli-disabled" | "cli-missing" | "cli-unusable" | "latest-unknown" | "configuration";
      note: string;
      deprecatedAliases: string[];
    };
```

Use `path.join(options.managedRoot ?? path.join(io.homeDir, ".pico-mcp", "cli"), "versions")`.
For each stable-semver child directory, require:

```ts
type ManagedCliInstallRecord = {
  schemaVersion: 1;
  version: string;
  relativeCliPath: string;
  registryIntegrity: string | null;
  installedAt: string;
};
```

Reject absolute/traversing `relativeCliPath`. Require the package version from
`node_modules/@picoxr/pico-cli/package.json`, the directory name, `install.json.version`, and parsed
`pico-cli/<semver>` from the absolute shim's `-v` output to agree. Scan highest stable semver first.
Do not create the root during inspection.

- [ ] **Step 4: Rebuild and verify GREEN**

Run:

```bash
npm run build
node --test test/picocli-autoinstall.mjs
```

Expected: policy and cached-inspection cases pass; no fixture log contains an npm call.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/picoclimanaged.ts test/picocli-autoinstall.mjs
git commit -m "feat(cli): add managed policy and cached inspection"
```

---

### Task 2: Exact-version provisioning and atomic publication

**Files:**
- Modify: `src/picoclimanaged.ts`
- Create: `test/helpers/picocli-managed-fixture.mjs`
- Modify: `test/picocli-autoinstall.mjs`
- Test: `test/picocli-autoinstall.mjs`

**Interfaces:**
- Consumes: Task 1's policy, store validation, result union, `ManagedPicoCliIO` and options.
- Produces:

```ts
export async function resolveManagedPicoCli(
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<PicoCliEnsureResult>;
```

- [ ] **Step 1: Extract the existing fake command driver into a reusable real-process fixture**

Move the fake npm/CLI setup from `test/picocli-autoinstall.mjs` into
`test/helpers/picocli-managed-fixture.mjs`. Its fake npm must implement the production argv:

```text
npm view @picoxr/pico-cli@latest version dist.integrity --json
npm install --prefix <unique-staging> --no-save --package-lock=false --fund=false --audit=false @picoxr/pico-cli@<exact-version>
```

The `view` response is a literal object:

```json
{"version":"0.4.2","dist.integrity":"sha512-fixture"}
```

The `install` branch writes a complete fake package, absolute shim, and package metadata beneath the
received prefix. Preserve the existing Windows `.cmd`, output-capping, timeout, and descendant-kill
fixtures.

- [ ] **Step 2: Rebuild and verify the fixture-only refactor remains GREEN**

Run:

```bash
npm run build
node --test test/picocli-autoinstall.mjs
```

Expected: every pre-existing pico-cli provisioning/process test still passes. This checkpoint
separates a mechanical fixture move from the behavioral RED that follows.

- [ ] **Step 3: Write cold-install and update tests before resolver implementation**

Add tests that call `resolveManagedPicoCli` with a temporary `managedRoot` and real fake child
processes. Assert literal outcomes:

```js
assert.equal(cold.status, "ok");
assert.equal(cold.action, "installed");
assert.equal(cold.source, "managed");
assert.equal(cold.version, "0.4.2");
assert.equal(cold.latestVersion, "0.4.2");
assert.equal(cold.freshness, "latest");
assert.equal(cold.checkedAt, "2026-08-14T12:00:00.000Z");
assert.ok(path.isAbsolute(cold.path));
```

Assert the fake global CLI and `PATH` are byte-for-byte unchanged. Assert the npm install argv has
`--prefix`, the exact package suffix `@0.4.2`, and none of `-g`, `--global`, `setup`, or
`update --check`. Assert the final directory contains complete `install.json` and package metadata,
and `staging` exposes no published partial version.

Add a stale `0.4.1` case whose registry returns `0.4.2`; expect `action:"updated"` and execution of
the `0.4.2` absolute shim.

Add a canary case proving a newly installed version receives only bounded help calls for the exact
families this repository wraps (`perf monitor run`, `perf trace record/decode/load/query`,
`app watch-crash`, `capture record`, `mcp dev-knowledge`, and `emulator status`). Every canary argv
must end in `--help`. Assert its exit/timing/truncation fields and SHA-256 of complete retained help
bytes are stored in `compatibility.json` before publication and returned by `ensure_pico_cli` as
diagnostics. A failed help canary is diagnostic; it does not relabel package activation as failed.

- [ ] **Step 4: Run focused tests to verify RED**

Run:

```bash
npm run build
node --test --test-name-pattern="cold managed|stale managed" test/picocli-autoinstall.mjs
```

Expected: failure because `resolveManagedPicoCli` is not exported/implemented.

- [ ] **Step 5: Implement registry parsing, staging install, verification, and publish**

In `src/picoclimanaged.ts`, implement this sequence:

```ts
const checkedAt = new Date(io.now()).toISOString();
const registry = await io.run("npm", [
  "view", `${PICO_CLI_PACKAGE}@latest`, "version", "dist.integrity", "--json",
], { timeoutMs: options.updateCheckTimeoutMs });
// Parse exactly {version:string,"dist.integrity":string|null}; reject arrays/unparsed semver.

const staging = path.join(root, "staging", io.randomUUID());
const install = await io.run("npm", [
  "install", "--prefix", staging, "--no-save", "--package-lock=false",
  "--fund=false", "--audit=false", `${PICO_CLI_PACKAGE}@${latestVersion}`,
], { timeoutMs: options.installTimeoutMs, killGraceMs: options.killGraceMs });
```

After install exit 0, validate the staged absolute shim with `-v`, run the bounded help-only
compatibility canaries above, then write and fsync `install.json` and `compatibility.json` inside
staging before renaming the complete staging directory to `versions/<version>`. Require
`relativeCliPath` to equal the platform's canonical package shim path, not merely any safe relative
path. If publication
loses to another process (`EEXIST`/`ENOTEMPTY` or platform equivalent), validate and reuse the
winner. Never overwrite an existing version directory. Fsync the versions directory where
supported. Remove only this call's staging directory on handled failure.

Determine `installed` versus `updated` from whether any lower validated managed version existed
before provisioning. Cache a successful registry result in-process for one hour, but honor
`forceRefresh:true`.

- [ ] **Step 6: Run focused and existing pico-cli tests to verify GREEN**

Run:

```bash
npm run build
node --test test/picocli-autoinstall.mjs
node test/picocli.mjs
```

Expected: all existing process-bound, Windows shim, parser, perf-classification, cold-install, and
update cases pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/picoclimanaged.ts test/picocli-autoinstall.mjs test/helpers/picocli-managed-fixture.mjs
git commit -m "feat(cli): provision exact managed latest versions"
```

---

### Task 3: Fallback, corruption, and cross-process convergence

**Files:**
- Modify: `src/picoclimanaged.ts`
- Modify: `test/helpers/picocli-managed-fixture.mjs`
- Modify: `test/picocli-autoinstall.mjs`
- Test: `test/picocli-autoinstall.mjs`

**Interfaces:**
- Consumes/produces: Task 2's `resolveManagedPicoCli`; no new public interface.

- [ ] **Step 1: Write failure and convergence tests first**

Add independent cases for these literal contracts:

```js
assert.deepEqual(registryDown.warning?.failureClass, "latest-unknown");
assert.equal(registryDown.status, "ok");
assert.equal(registryDown.version, "0.4.1");
assert.equal(registryDown.freshness, "unknown");

assert.equal(noRegistryNoCache.status, "unavailable");
assert.equal(noRegistryNoCache.failureClass, "latest-unknown");

assert.equal(updateFailed.status, "ok");
assert.equal(updateFailed.version, "0.4.1");
assert.equal(updateFailed.freshness, "outdated");
assert.equal(updateFailed.warning?.failureClass, "update-failed");
```

Add cases for npm timeout, npm unavailable, malformed registry JSON, successful npm exit without a
shim, mismatched staged `-v`, corrupt install record, package version mismatch, shim mutation, and a
seven-day-old abandoned staging directory. Assert every failure preserves a prior validated version
and never publishes the bad candidate.

Add a child-process convergence test: launch at least 12 Node workers against one managed root and
one fake registry version. Each worker must return `status:"ok"`, the same absolute version path,
and `version:"0.4.2"`; the final store must contain exactly one complete `versions/0.4.2` directory
and no worker may report success against a partial tree.

- [ ] **Step 2: Run the new cases to verify RED**

Run:

```bash
npm run build
node --test --test-name-pattern="fallback|corrupt|concurrent managed" test/picocli-autoinstall.mjs
```

Expected: one or more cases fail because Task 2 does not yet implement every fallback/cleanup race.
Confirm the failure names the intended branch, not fixture syntax.

- [ ] **Step 3: Implement the minimal fallback and convergence behavior**

Return a validated cache as a successful result with a warning rather than a failed result:

```ts
return {
  ...cached,
  status: "ok",
  action: "cached",
  latestVersion: knownLatest,
  checkedAt,
  freshness: knownLatest ? "outdated" : "unknown",
  warning: {
    failureClass: knownLatest ? "update-failed" : "latest-unknown",
    note,
    ...(tail ? { outputTail: tail } : {}),
  },
};
```

If no version validates, return `unavailable` with the originating classified failure. Clean only
staging directories whose own `install.json`/mtime is older than seven days; never delete any
published version. Treat publication collisions as contention only after validating the winner.

- [ ] **Step 4: Verify all managed tests pass repeatedly**

Run:

```bash
npm run build
for run in 1 2 3; do node --test test/picocli-autoinstall.mjs || exit 1; done
```

Expected: three clean runs, including all concurrent workers and timeout settlement.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/picoclimanaged.ts test/picocli-autoinstall.mjs test/helpers/picocli-managed-fixture.mjs
git commit -m "fix(cli): fail honestly around managed update drift"
```

---

### Task 4: Replace global provisioning across health, wrappers, knowledge, and doctors

**Files:**
- Modify: `src/picocli.ts`
- Modify: `src/picoclihealth.ts`
- Modify: `src/preflight.ts`
- Modify: `src/knowledge.ts`
- Modify: `src/perfcli.ts`
- Modify: `src/perftrace.ts`
- Modify: `src/picoclitools.ts`
- Modify: `src/doors.ts`
- Modify: `test/picocli.mjs`
- Modify: `test/picocli-autoinstall.mjs`
- Modify: `test/doors.mjs`
- Modify: `test/preflight.mjs`
- Modify: `test/distribution-adoption.mjs`
- Test: `test/picocli.mjs`, `test/picocli-autoinstall.mjs`, `test/doors.mjs`, `test/preflight.mjs`, `test/distribution-adoption.mjs`

**Interfaces:**
- Consumes: `resolveManagedPicoCli`, `inspectManagedPicoCli`, `PicoCliEnsureResult`.
- Produces/re-exports from `src/picocli.ts`:

```ts
export { PICO_CLI_POLICY_ENV, PICO_CLI_PATH_ENV } from "./picoclimanaged.js";
export type { PicoCliEnsureResult } from "./picoclimanaged.js";
export type PicoCliProvenance = Pick<Extract<PicoCliEnsureResult, {status:"ok"}>,
  "source" | "policy" | "path" | "version" | "latestVersion" | "checkedAt" | "freshness" | "action" | "warning"
>;
export function picoCliProvenance(result: Extract<PicoCliEnsureResult, {status:"ok"}>): PicoCliProvenance;
export function ensurePicoCli(options?: ManagedPicoCliOptions): Promise<PicoCliEnsureResult>;
export function inspectPicoCliCached(options?: ManagedPicoCliOptions): Promise<PicoCliEnsureResult>;
```

- [ ] **Step 1: Write MCP-visible behavior tests before changing consumers**

Add tests proving:

1. a CLI wrapper with default env provisions/uses the managed absolute path and returns a `picoCli`
   provenance object even when `action:"present"`;
2. MCP startup plus `tools/list` makes zero npm calls and creates no managed root;
3. `preflight_env`/default `pico_doctor {}` with an empty managed root performs zero npm calls/writes and warns
   that first CLI use will provision it;
4. preflight with a valid cached version may run its absolute `-v` and `emulator status` without a
   registry/install call;
5. `knowledge_api` starts `mcp dev-knowledge` using the managed absolute shim, and a newly activated
   version retires/restarts an older knowledge child;
6. `ensure_pico_cli` forces refresh and returns managed policy/freshness; legacy `{update:true}` is
   accepted but no longer controls whether updates happen;
7. doors no longer recycle its inner server because `PATH` changed.

Use observable child logs/result JSON, not source-text assertions. Example wrapper assertions:

```js
assert.equal(out.status, "ok");
assert.equal(out.picoCli.source, "managed");
assert.equal(out.picoCli.version, "0.4.2");
assert.equal(out.picoCli.latestVersion, "0.4.2");
assert.equal(out.picoCli.freshness, "latest");
assert.ok(path.isAbsolute(out.picoCli.path));
```

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
npm run build
node test/picocli.mjs
node --test test/picocli-autoinstall.mjs
node test/preflight.mjs
node test/doors.mjs
```

Expected: new assertions fail because consumers still use ambient/global provisioning and omit
managed freshness provenance.

- [ ] **Step 3: Adapt `picocli.ts` to the managed resolver**

Keep the existing bounded `runPicoCliCommand`, output cap, timeout/tree-kill, semver, envelope, and
failure classifiers. Extend `PicoCliFailureClass` with the managed policy/setup/freshness branches
used by the result union (`setup-required`, `latest-unknown`, `update-failed`, `cli-disabled`, and
`configuration`) rather than collapsing them into generic execution failure. Delete global-prefix
exposure and all `npm install -g` logic. Re-export `PICO_CLI_PACKAGE` from the managed module so
there is one package-name authority. Construct
production IO once:

```ts
const managedIo: ManagedPicoCliIO = {
  env: process.env,
  platform: process.platform,
  homeDir: os.homedir(),
  now: () => Date.now(),
  randomUUID,
  run: (command, args, options) => runPicoCliCommand(command, args, options),
};

export function ensurePicoCli(options: ManagedPicoCliOptions = {}) {
  return resolveManagedPicoCli(options, managedIo);
}

export function inspectPicoCliCached(options: ManagedPicoCliOptions = {}) {
  return inspectManagedPicoCli(options, managedIo);
}
```

Preserve in-process promise coalescing for identical/weak calls without allowing a non-refresh call
to suppress `forceRefresh:true`. `picoCliFromEnsure` returns a probe only for `status:"ok"` and uses
the managed absolute path. Extend `cliWrapperContractShape` with `picoCli` provenance and structured
`setupCommand`.

- [ ] **Step 4: Update health tool and every wrapper result**

`ensure_pico_cli` calls `ensurePicoCli({forceRefresh:true})`; retain deprecated `update` input. In
perf, trace, crash, recording, and knowledge results, include:

```ts
const ready = picoCliFromEnsure(ensured);
const provenance = ensured.status === "ok"
  ? { picoCli: picoCliProvenance(ensured) }
  : {};
```

On setup refusal, return:

```ts
{
  failureClass: "setup-required",
  setupCommand: { path: ready.path, args: ["setup"] },
  note: "The managed CLI is current, but this utility payload is not provisioned. Run the returned command manually, then retry.",
}
```

Never invoke that command.

- [ ] **Step 5: Keep doctors read-only and knowledge bound to the resolved absolute command**

Change `defaultBoundedIO()` to call the exported `inspectPicoCliCached()` adapter rather than
`probePicoCliBounded()`. A missing cache becomes a warning; it is not provisioned. For a valid cache,
run emulator status through its absolute path.

For production `KnowledgeBridge`, resolve the managed CLI before first start and store the actual
command path on `KnowledgeSession`. If a later call resolves a different path/version, retire the
old session before constructing `StdioClientTransport`. Custom injected `command` options bypass
managed provisioning unchanged.

Remove the global-`PATH` mutation/recycle path from `doors.ts`; inner servers inherit policy variables
and independently read the same immutable managed store.

- [ ] **Step 6: Run focused integration gates**

Run:

```bash
npm run build
npm run test:picocli
npm run test:preflight
npm run test:doors
npm run test:briefroute
node --test --test-name-pattern="KnowledgeBridge" test/distribution-adoption.mjs
```

Expected: all pass, with no test touching the real managed root or global CLI.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/picocli.ts src/picoclihealth.ts src/preflight.ts src/knowledge.ts src/perfcli.ts src/perftrace.ts src/picoclitools.ts src/doors.ts test/picocli.mjs test/picocli-autoinstall.mjs test/preflight.mjs test/doors.mjs test/distribution-adoption.mjs
git commit -m "feat(cli): route wrappers through managed latest"
```

---

### Task 5: Version-agnostic safe CLI surface sweep

**Files:**
- Create: `scripts/compare-picocli-surfaces.mjs`
- Create: `test/picocli-sweep.mjs`
- Create: `.github/workflows/picocli-compat.yml`
- Modify: `package.json`
- Test: `test/picocli-sweep.mjs`

**Interfaces:**
- Produces CLI:

```text
node scripts/compare-picocli-surfaces.mjs --from <semver> --to <semver|latest> --output <absolute-json-path>
```

- Produces JSON:

```ts
type PicoCliSurfaceReport = {
  schemaVersion: 1;
  generatedAt: string;
  from: { requested: string; version: string; commandCount: number };
  to: { requested: string; version: string; commandCount: number };
  addedCommands: string[];
  removedCommands: string[];
  changedHelp: Array<{ command: string; fromSha256: string; toSha256: string }>;
  unchangedCommands: string[];
  safety: { setupInvoked: false; nonHelpCommandsInvoked: false };
};
```

- [ ] **Step 1: Write parser and end-to-end fake-tree tests first**

Build two fake CLIs whose root and nested `--help` outputs expose literal command trees. Include one
added command, one removed command, one changed help body, an options section that must not be parsed
as commands, and a command with required/optional argument notation. Run the script as a child and
assert the exact JSON arrays and hashes.

Add a fake that logs every invocation. Assert only `-v` and argv ending in `--help` occur, recursion
stops at depth 8 or 256 commands, and no argv enters the `setup` subtree or invokes `update --check`.
Help for `doctor`, emulator, and device-related command paths is allowed and required when those
paths appear in the advertised command tree; the terminal `--help` is the safety boundary.

- [ ] **Step 2: Run sweep tests to verify RED**

Run:

```bash
node --test test/picocli-sweep.mjs
```

Expected: failure because `scripts/compare-picocli-surfaces.mjs` does not exist.

- [ ] **Step 3: Implement safe scratch installs and recursive help enumeration**

Parse only the indented entries between a `Commands:` heading and the next unindented section. Strip
argument notation to obtain a command token, visit each token path once, and call only:

```js
["-v"]
[...commandTokens, "--help"]
```

For real npm packages, create a temporary root per requested version and use the same exact,
non-global install shape as the managed resolver. Resolve `latest` to an exact version first. Hash
complete stdout/stderr help bytes with SHA-256. Sort all report arrays lexicographically. Write the
report atomically, print its path, and set nonzero exit only for invocation/install/report errors—not
for an expected surface difference.

- [ ] **Step 4: Add package and scheduled/manual workflow integration**

Change `test:picocli` without adding another `test:*` script, preserving the 45-invocation battery:

```json
"test:picocli": "node test/picocli.mjs && node --test test/picocli-autoinstall.mjs test/picocli-sweep.mjs"
```

Add `.github/workflows/picocli-compat.yml` with `schedule` and `workflow_dispatch`. It runs Node 22,
installs dependencies, builds, compares `0.4.2` with `latest`, uploads the JSON artifact, and writes a
step summary. It never runs setup or a device command. This separate observational workflow does not
change or weaken the four product gates.

- [ ] **Step 5: Verify fake sweep and existing CLI gate**

Run:

```bash
npm run build
npm run test:picocli
```

Expected: all parser, fake command-tree, managed provisioning, wrapper, and legacy classifier cases
pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add scripts/compare-picocli-surfaces.mjs test/picocli-sweep.mjs .github/workflows/picocli-compat.yml package.json
git commit -m "test(cli): compare arbitrary safe help surfaces"
```

---

### Task 6: Public policy, migration, and distribution gates

**Files:**
- Modify: `README.md`
- Modify: `GETTING_STARTED.md`
- Modify: `SKILLS.md`
- Modify: `AGENTS.md`
- Modify: `TESTERS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/HOSTS.md`
- Modify: `docs/ANSWERED_BY_MEASUREMENT.md`
- Modify: `docs/findings/PICOCLI_042_SWEEP_2026-08-12.md`
- Modify: `test/distribution-adoption.mjs`
- Test: `test/distribution-adoption.mjs`, `test/docsmeta.mjs`

**Interfaces:**
- Consumes: final policy/result fields from Tasks 1–5.
- Produces: no production interface.

- [ ] **Step 1: Add behavior-backed distribution assertions before documentation edits**

Extend `test/distribution-adoption.mjs` by launching an installed/tarball server against fake npm and
a temporary home. Assert that the documented default actually produces a managed absolute CLI,
leaves a fake global CLI and `PATH` unchanged, keeps doctor read-only, and returns explicit
freshness. Do not grep for one exact prose sentence.

Add a documentation consistency table scoped to the managed-CLI policy sections. Extract only
`PICO_MCP_CLI_*`, the two deprecated `PICO_MCP_AUTO*CLI` names, and the four policy literals; require
those tokens to belong to this literal supported set without treating unrelated settings such as
`PICO_MCP_SURFACE` as CLI policy:

```js
new Set([
  "managed-latest", "managed-cached", "external", "disabled",
  "PICO_MCP_CLI_POLICY", "PICO_MCP_CLI_PATH",
  "PICO_MCP_AUTOINSTALL_CLI", "PICO_MCP_AUTOUPDATE_CLI",
]);
```

Within the current MCP operational documents listed in this task, assert there is no affirmative
global-provisioning instruction for the MCP and no claim that it runs setup. Do not sweep or rewrite
dated historical findings owned by the separate Windows programme merely because they record what
that probe did. Manual setup guidance must identify it as user-run.

- [ ] **Step 2: Run distribution gate to verify RED**

Run:

```bash
npm run build
npm run test:distribution-adoption
```

Expected: new behavior/docs assertions fail against the old opt-in/global-install wording.

- [ ] **Step 3: Update public documentation and dated findings**

Document:

- `managed-latest` is default and lazy on first real CLI use;
- default `pico_doctor {}` CLI inspection, `preflight_env`, and tool registration are
  npm-network/provisioning-free; preserve the explicit mutating `pico_doctor {calibrate:true}`
  exception;
- versions are MCP-owned and global CLI/PATH remain untouched;
- cached fallback is labeled unknown/outdated and never called latest;
- `managed-cached`, `external`, and `disabled` escape hatches;
- legacy env aliases remain through 37.x and never install globally;
- setup remains a manual, separate provisioning step;
- `0.4.2` was registry latest observed on 2026-08-14, not a timeless value;
- the v1.0 date is user/PICO-team planning input, not repository-verified release evidence;
- the compatibility sweep is help-only and version-agnostic.

Record the behavioral change and migration in CHANGELOG without claiming a native Windows run,
emulator success, perf success behind setup, or visual evidence.

- [ ] **Step 4: Verify public metadata and distribution adoption**

Run:

```bash
npm run test:docsmeta
npm run test:distribution-adoption
npm run test:lint
git diff --check
```

Expected: all pass; public links resolve and all measured/version claims retain dates and evidence
boundaries.

- [ ] **Step 5: Commit Task 6**

```bash
git add README.md GETTING_STARTED.md SKILLS.md AGENTS.md TESTERS.md CHANGELOG.md docs/HOSTS.md docs/ANSWERED_BY_MEASUREMENT.md docs/findings/PICOCLI_042_SWEEP_2026-08-12.md test/distribution-adoption.mjs
git commit -m "docs(cli): make managed latest the honest default"
```

---

### Task 7: Real scratch-prefix proof and complete verification

**Files:**
- Create: `docs/findings/PICOCLI_MANAGED_LATEST_2026-08-14.md`
- Modify only if generated evidence requires correction: files from Tasks 1–6
- Test: complete battery and focused live scratch proof

**Interfaces:**
- Consumes: all prior tasks.
- Produces: dated measured finding; no new runtime interface.

- [ ] **Step 1: Prove real registry latest in an isolated home without setup**

Create a temporary home with `mktemp -d`. Invoke `ensure_pico_cli` through the built MCP with
`PICO_MCP_CLI_POLICY=managed-latest`, that temporary `HOME`, and no ambient `pico-cli` in the test
`PATH` beyond the Node/npm prerequisites. Record the returned path/version/latestVersion/check time
and verify:

```text
<managed-absolute-pico-cli> -v
<managed-absolute-pico-cli> --help
```

Do not run `setup`, `doctor`, `plugin doctor`, `update --check`, an emulator operation, or a device
operation. Verify the real global pico-cli's pre/post path, version, and SHA are unchanged.

- [ ] **Step 2: Run the real version-agnostic help sweep**

Run:

```bash
node scripts/compare-picocli-surfaces.mjs \
  --from 0.4.2 \
  --to latest \
  --output "$(pwd)/docs/findings/picocli-managed-latest-surface-2026-08-14.json"
```

If latest is still 0.4.2, report zero differences. If it changed, report the generated difference
without interpreting compatibility beyond the help bytes. Never weaken a test to accommodate a
new surface.

- [ ] **Step 3: Write the measured finding**

Create `docs/findings/PICOCLI_MANAGED_LATEST_2026-08-14.md` containing exact commands, host/Node
version, registry response, managed path, global pre/post identity, setup-not-run statement, sweep
result, and explicit unverified boundaries: no perf utilities behind setup, no emulator behavior,
no native Windows, no Swan, and no rendered-frame LOOK.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npm run build
npm run test:picocli
npm run test:preflight
npm run test:doors
npm run test:distribution-adoption
npm run test:docsmeta
SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs
git diff --check
```

Expected local result: all deterministic suites pass; the complete battery may report only the
already-baselined environmental `scene_schemas` smoke failure. Any additional failure blocks
completion.

- [ ] **Step 5: Commit the measured evidence**

```bash
git add docs/findings/PICOCLI_MANAGED_LATEST_2026-08-14.md docs/findings/picocli-managed-latest-surface-2026-08-14.json
git commit -m "docs(cli): record managed latest scratch proof"
```

The commit body must state the exact tests and the exact battery summary. It must explicitly say no
setup, emulator LOOK, Swan, or native Windows run occurred.

---

## Final branch review

After Task 7, generate one review package from design commit `1fbdda9` through `HEAD`. The final
reviewer must check spec compliance, global/ambient isolation, atomic publication, fallback honesty,
doctor read-only behavior, knowledge-child version switching, wrapper provenance, safe sweep
boundedness, docs consistency, and whether each test catches a real behavior mutation. Resolve all
Critical/Important findings through the subagent fix loop before branch handoff.
