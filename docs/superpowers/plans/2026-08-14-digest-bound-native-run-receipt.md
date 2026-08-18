# Digest-Bound Native Run Receipt v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fleet_build` publish a content-addressed structural receipt that binds authored/effective AppSpec and generated source, the exact APK and installed bytes, one device launch session/PID/foreground interval, and one immutable capture; then require that receipt plus an exact linked LOOK before `ship_checklist` accepts current native bytes.

**Architecture:** Three new focused modules separate canonical input identity (`runreceiptidentity.ts`), immutable receipt/CAS storage and validation (`runreceiptstore.ts`), and the live fleet producer (`nativefleetreceipt.ts`). Existing fleet, Door, ledger, eye, and ship paths consume those modules without adding a new public MCP tool or changing the doors/full-surface tool counts.

**Tech Stack:** TypeScript/Node.js 20+, Zod, Node `crypto`/`fs`, MCP SDK, adb/Gradle/Android build tools behind injected command runners, Node’s built-in test runner with real temporary files.

## Global Constraints

- Work from reviewed commit `efbc1443b5c28809b62f16ae765d37362391e2bf`; do not rework the completed managed-latest CLI track without a reproduced regression.
- V1 covers native debug APKs produced through the existing POSIX `fleet_build` path. It makes no release/store, web, Swan, hardware Safeguard/Guardian, native-Windows, or rendered-appearance claim.
- The receipt kind is exactly `pico.native-run-receipt`, `schemaVersion` is exactly `1`, scope is exactly `fleet-native-debug`, and IDs/hashes are lowercase SHA-256 hex.
- Bind the normalized authored AppSpec, post-semantic/post-fleet effective AppSpec, bounded Gradle-input manifest, AGP-selected APK, successful installed-byte equality, package, device serial/fingerprint/boot, UUID session, component, PID/start identity, foreground-before/after, and exact capture/CAS identity.
- The default receipt root is `~/.pico-mcp/run-receipts`; tests override only with `PICO_MCP_RUN_RECEIPT_DIR`. Existing capture CAS remains below the ledger root and tests use `PICO_MCP_LEDGER_DIR`.
- Source bounds are 20,000 entries, 2 GiB total, and 512 MiB per file. APK maximum is 2 GiB. Receipt maximum is 2 MiB and per-app scan maximum is 4,096 candidates.
- Runtime deadlines are: Gradle 30 minutes, install five minutes, launch/capture 30 seconds, individual probes 20 seconds, PID/foreground polling 24 seconds at two-second intervals, with only the existing single disclosed foreground-blocker recovery.
- Receipt creation is structural and creates no ledger row. `vision_verified` still requires a human or vision-capable agent to open and judge the exact receipt capture; `device_verified` still requires its existing live non-emulator identity and same-serial capture path.
- `ship_checklist` clears only the native current-byte receipt blocker when a current-project-valid receipt and an effective intact receipt-linked LOOK row agree. Release/signing/store blockers remain.
- Every persistent artifact uses unique staging and create-only atomic publication. A failed run publishes no receipt and never overwrites a valid receipt/CAS object; harmless unreferenced immutable CAS objects may remain.
- Do not add a new public MCP tool. Keep doors at 18 and full surface at its current platform counts.
- Do not push, change visibility/permissions/remotes, absorb the separately owned Windows lane, or infer Windows/Swan/hardware/rendered evidence from fixtures.
- Final validation is exactly `npm run build`, `SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs`, and `git diff --check`; report the known local `scene_schemas` smoke failure rather than calling the battery green.

---

### Task 1: Canonical AppSpec and Gradle-input identities

**Files:**
- Create: `src/runreceiptidentity.ts`
- Create: `test/runreceipt-identity.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `canonicalJson(value: unknown): string`
- Produces: `canonicalIdentity(value: unknown): CanonicalIdentity`
- Produces: `readAuthoredAppSpecIdentity(briefPath: string): AuthoredAppSpecIdentity`
- Produces: `effectiveAppSpecIdentity(spec: unknown): CanonicalIdentity`
- Produces: `collectGradleInputIdentity(projectDir: string): GradleInputIdentity`
- `CanonicalIdentity = { algorithm: "sha256"; sha256: string; bytes: number }`
- `AuthoredAppSpecIdentity = CanonicalIdentity & { sourcePath: string }`
- `GradleInputEntry = { path: string; bytes: number; sha256: string }`
- `GradleInputIdentity = { schemaVersion: 1; projectDir: string; algorithm: "sha256"; sha256: string; entryCount: number; totalBytes: number; entries: GradleInputEntry[] }`

- [ ] **Step 1: Write failing canonical/source identity tests**

Create a Node test file that names the breaks it catches and derives expectations independently:

```js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  canonicalIdentity,
  readAuthoredAppSpecIdentity,
  effectiveAppSpecIdentity,
  collectGradleInputIdentity,
} from "../dist/runreceiptidentity.js";

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

test("canonical JSON sorts object keys but preserves array order", () => {
  const actual = canonicalJson({ z: [3, { b: 2, a: 1 }], a: true });
  const expected = '{"a":true,"z":[3,{"a":1,"b":2}]}';
  assert.equal(actual, expected);
  assert.deepEqual(canonicalIdentity({ z: [3, { b: 2, a: 1 }], a: true }), {
    algorithm: "sha256",
    sha256: sha(expected),
    bytes: Buffer.byteLength(expected),
  });
});

test("canonical JSON rejects values that cannot have one portable identity", () => {
  for (const value of [undefined, NaN, Infinity, { a: undefined }, new Date(0)]) {
    assert.throws(() => canonicalJson(value), /canonical|JSON|unsupported|finite/i);
  }
  const sparse = [];
  sparse[1] = "x";
  assert.throws(() => canonicalJson(sparse), /sparse/i);
});
```

Add temporary brief/project fixtures and assertions that:

- `readAuthoredAppSpecIdentity` parses `.spec` through `appSpecSchema`, includes defaults, uses the real canonical source path, and changes when the authored spec changes;
- `effectiveAppSpecIdentity` changes on the fleet package rewrite;
- the Gradle manifest contains the exact sorted V1 allowlist and hand-derived per-file hashes;
- adding `README.md`, `.idea/x`, `local.properties`, or `app/build/x` does not change it;
- changing `app/src/main/AndroidManifest.xml`, Kotlin source, wrapper properties, or an asset changes it;
- a selected symlink, special entry, project-root escape, missing Android manifest, or missing Kotlin/Java source fails closed.

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
npm run build && node --test test/runreceipt-identity.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/runreceiptidentity.js`.

- [ ] **Step 3: Implement the minimal identity module**

Use exact constants and deterministic traversal:

```ts
export const GRADLE_INPUT_MAX_ENTRIES = 20_000;
export const GRADLE_INPUT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const GRADLE_INPUT_MAX_FILE_BYTES = 512 * 1024 * 1024;

const ROOT_FILES = new Set([
  "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts",
  "gradle.properties", "gradlew", "gradlew.bat",
  "app/build.gradle", "app/build.gradle.kts", "app/proguard-rules.pro",
]);
const RECURSIVE_ROOTS = ["gradle", "buildSrc", "app/src", "app/libs", "libs"] as const;

export function canonicalIdentity(value: unknown): CanonicalIdentity {
  const canonical = canonicalJson(value);
  return {
    algorithm: "sha256",
    sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
    bytes: Buffer.byteLength(canonical),
  };
}
```

Traversal must use `lstat`, reject symlinks/non-regular selected entries, compare every selected
real path with the project real path, hash files by stream or bounded chunks, convert separators to
`/`, sort by relative path, and hash the canonical entries array. `readAuthoredAppSpecIdentity`
must parse the brief JSON, require `.spec`, call `appSpecSchema.parse`, and hash the parsed value.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```bash
npm run build && node --test test/runreceipt-identity.mjs
```

Expected: all receipt-identity tests PASS with pristine output.

- [ ] **Step 5: Add the focused package script and verify it**

Add:

```json
"test:runreceipt": "node --test test/runreceipt-identity.mjs"
```

Run:

```bash
npm run build && npm run test:runreceipt && git diff --check
```

Expected: build and focused tests exit 0; diff check is clean.

- [ ] **Step 6: Commit measured Task 1 claims**

```bash
git add src/runreceiptidentity.ts test/runreceipt-identity.mjs package.json
git commit -m "feat(receipt): add canonical fleet input identities" \
  -m "Tests: npm run build; npm run test:runreceipt; git diff --check. Structural fixtures only; no native run or visual claim."
```

---

### Task 2: Immutable receipt schema, CAS publication, and readers

**Files:**
- Create: `src/runreceiptstore.ts`
- Create: `test/helpers/runreceipt-fixture.mjs`
- Create: `test/runreceipt-store.mjs`
- Modify: `src/ledger.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 `CanonicalIdentity`, `GradleInputIdentity`, `canonicalJson`, `canonicalIdentity`, `readAuthoredAppSpecIdentity`, `collectGradleInputIdentity`
- Consumes: existing capture validation/CAS; export existing `materializeCaptureBytes` from `src/ledger.ts` without weakening its validation or atomic behavior
- Produces: `RUN_RECEIPT_KIND = "pico.native-run-receipt"`, `RUN_RECEIPT_SCHEMA_VERSION = 1`, `RUN_RECEIPT_SCOPE = "fleet-native-debug"`
- Produces: `NATIVE_RECEIPT_DIRECTORY = "native-v1"`, `APK_ARTIFACT_DIRECTORY = "artifacts/apk"`, and `SPEC_ARTIFACT_DIRECTORY = "artifacts/spec"`
- Produces: `runReceiptDirectory(): string`
- Produces: `publishApkArtifact(sourcePath: string, options?: ReceiptStoreOptions): Promise<ApkArtifact>`
- Produces: `publishEffectiveSpecArtifact(spec: unknown, options?: ReceiptStoreOptions): PublishedSpecArtifact`
- Produces: `publishNativeRunReceipt(payload: NativeRunReceiptPayload, options?: ReceiptStoreOptions): PublishedNativeRunReceipt`
- Produces: `readNativeRunReceipt(app: string, receiptId: string, options?: ReadReceiptOptions): NativeRunReceiptValidation`
- Produces: `findHistoricalNativeRunReceipt(app: string, options?: ReceiptStoreOptions): NativeRunReceiptSelection`
- Produces: `findCurrentNativeRunReceipt(app: string, projectDir: string, options?: ReceiptStoreOptions): NativeRunReceiptSelection`
- Produces: `validateNativeRunReceiptCaptureBinding(app: string, receiptId: string, artifactPath: string, options?: ReceiptStoreOptions): ReceiptCaptureBindingResult`

```ts
export interface ReceiptStoreOptions {
  rootDir?: string;
  ledgerDir?: string;
}

export interface ApkArtifact {
  sourcePath: string;
  artifactPath: string;
  sha256: string;
  bytes: number;
}

export interface PublishedSpecArtifact extends CanonicalIdentity {
  artifactPath: string;
}

export interface PublishedNativeRunReceipt {
  receipt: NativeRunReceipt;
  receiptId: string;
  receiptPath: string;
}

export type NativeRunReceiptSelection =
  | { status: "valid"; receipt: NativeRunReceipt; receiptPath: string; rejectedCandidates: Array<{ receiptId: string; issues: string[] }> }
  | { status: "none"; rejectedCandidates: Array<{ receiptId: string; issues: string[] }> }
  | { status: "invalid-store"; issues: string[] };

export type ReceiptCaptureBindingResult =
  | { status: "valid"; binding: { kind: "pico.native-run-receipt"; schemaVersion: 1; receiptId: string; captureSha256: string } }
  | { status: "invalid"; reason: string };
```

The exact receipt shape is:

```ts
export interface NativeRunReceiptPayload {
  kind: "pico.native-run-receipt";
  schemaVersion: 1;
  createdAt: string;
  scope: "fleet-native-debug";
  app: string;
  source: {
    authoredAppSpec: AuthoredAppSpecIdentity;
    effectiveAppSpec: CanonicalIdentity & { artifactPath: string };
    gradleInputs: GradleInputIdentity;
  };
  build: {
    task: ":app:assembleDebug";
    outcome: "success";
    startedAt: string;
    finishedAt: string;
    outputMetadata: { path: string; sha256: string; bytes: number };
  };
  apk: {
    sourcePath: string;
    artifactPath: string;
    sha256: string;
    bytes: number;
    packageName: string;
    manifestInspection:
      | { status: "inspected"; tool: string; packageName: string; versionCode: string; versionName: string }
      | { status: "unavailable"; reason: string };
    signingInspection:
      | { status: "inspected"; tool: "apksigner"; certificateSha256: string[] }
      | { status: "unavailable"; reason: string };
  };
  install: {
    status: "success";
    method: "adb-install-replace";
    completedAt: string;
    packageName: string;
    remoteApkPath: string;
    remoteApkSha256: string;
    acknowledgementSha256: string;
  };
  runtime: {
    sessionId: string;
    serial: string;
    model: string;
    fingerprint: string;
    bootQemu: string;
    bootId: string;
    component: string;
    launchedAt: string;
    launchAcknowledgementSha256: string;
    pid: number;
    pidStartTicks: string;
  };
  capture: {
    capturedAt: string;
    sourcePath: string;
    artifactPath: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    format: "png";
    before: RuntimeCaptureObservation;
    after: RuntimeCaptureObservation;
  };
}

export interface RuntimeCaptureObservation {
  observedAt: string;
  foregroundPackage: string;
  foregroundComponent: string;
  pid: number;
  pidStartTicks: string;
}

export type NativeRunReceipt = NativeRunReceiptPayload & { receiptId: string };
```

- [ ] **Step 1: Write failing real-filesystem store tests**

Create a helper that writes one valid 64×64 PNG, one bounded APK byte fixture, one brief/project
tree, output metadata, effective spec, and a literal valid payload. Tests must exercise the real
filesystem and assert consumer-visible results:

```js
test("receipt ID binds every payload section and canonical file bytes", async () => {
  const first = publishNativeRunReceipt(validPayload);
  const parsed = JSON.parse(fs.readFileSync(first.receiptPath, "utf8"));
  assert.equal(parsed.receiptId, first.receiptId);
  assert.match(first.receiptId, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(first.receiptPath, "utf8"), canonicalJson(parsed) + "\n");

  for (const mutate of payloadMutations) {
    const changed = publishNativeRunReceipt(mutate(structuredClone(validPayload)));
    assert.notEqual(changed.receiptId, first.receiptId);
  }
});
```

Use literal mutations for package, install digest, serial, fingerprint, boot ID, session ID, PID,
PID start ticks, foreground before, foreground after, and capture hash. Add tests that:

- APK/spec/receipt publication is create-only and a corrupt preexisting hash target is rejected;
- receipt, APK, and spec publication land exactly at
  `<root>/native-v1/<canonical-app>/<receiptId>.json`,
  `<root>/artifacts/apk/<apk-sha256>.apk`, and
  `<root>/artifacts/spec/<effective-appspec-sha256>.json`; unsafe app keys cannot create paths;
- historical-core validation detects receipt canonical/ID/file-name tampering, APK-CAS change,
  effective-spec change, capture-CAS change, and malformed schema/unknown keys;
- current-project validation additionally detects authored spec, Gradle input, source APK, project
  real-path, and AGP metadata changes;
- historical validation remains valid after current source paths move while current validation does not;
- scan overflow, malformed candidate, and deterministic newest-valid selection are explicit;
- wrong app/receipt/capture bindings are rejected and a valid exact binding returns only
  `{kind,schemaVersion,receiptId,captureSha256}`.

- [ ] **Step 2: Run store tests to verify RED**

Run:

```bash
npm run build && node --test test/runreceipt-store.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/runreceiptstore.js`.

- [ ] **Step 3: Implement strict schemas and immutable artifact publication**

Use strict Zod schemas for the interfaces above, the existing canonicalizer, and exact constants:

```ts
export const RUN_RECEIPT_KIND = "pico.native-run-receipt" as const;
export const RUN_RECEIPT_SCHEMA_VERSION = 1 as const;
export const RUN_RECEIPT_SCOPE = "fleet-native-debug" as const;
export const RUN_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
export const RUN_RECEIPT_MAX_PER_APP = 4_096;
export const APK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const NATIVE_RECEIPT_DIRECTORY = "native-v1" as const;
export const APK_ARTIFACT_DIRECTORY = "artifacts/apk" as const;
export const SPEC_ARTIFACT_DIRECTORY = "artifacts/spec" as const;

export function runReceiptDirectory(): string {
  return process.env.PICO_MCP_RUN_RECEIPT_DIR
    ? path.resolve(process.env.PICO_MCP_RUN_RECEIPT_DIR)
    : path.join(os.homedir(), ".pico-mcp", "run-receipts");
}
```

Construct receipt/app paths only from the existing canonical app-key grammar. Convert the two
artifact directory constants into path segments at the call site; never treat a caller string as a
relative artifact directory. Tests assert the exact platform-native paths beneath the temporary
root and the exact lowercase hash filenames.

APK publication must stream one open descriptor to a unique same-directory staging file, hash as
it copies, verify size/mtime/inode stability with `fstat` before and after, `fsync`, create-only
link, re-hash any racing existing target, then unlink staging in `finally`. Spec/receipt publication
uses canonical bytes with the same create-only contract. Receipt ID hashes canonical payload before
`receiptId` is added.

- [ ] **Step 4: Implement historical and current readers**

Use a discriminated result instead of exceptions at the public boundary:

```ts
export type NativeRunReceiptValidation =
  | { status: "valid"; mode: "historical" | "current"; receipt: NativeRunReceipt; receiptPath: string }
  | { status: "invalid"; mode: "historical" | "current"; receiptId: string; issues: string[] };

export interface ReadReceiptOptions extends ReceiptStoreOptions {
  mode?: "historical" | "current";
  projectDir?: string;
}
```

Historical mode re-hashes canonical receipt, APK CAS, spec CAS, and capture CAS/metadata and checks
all cross-field relationships. Current mode first passes historical mode, then compares real
project path and re-computes authored spec, Gradle manifest, source APK, and AGP metadata.
`findHistoricalNativeRunReceipt` and `findCurrentNativeRunReceipt` report invalid candidates instead
of dropping them, sort valid matches by `createdAt` descending then `receiptId`, and return no match
explicitly.

- [ ] **Step 5: Run store and existing ledger tests to verify GREEN**

Update the script:

```json
"test:runreceipt": "node --test test/runreceipt-identity.mjs test/runreceipt-store.mjs"
```

Run:

```bash
npm run build && npm run test:runreceipt && npm run test:ledger && git diff --check
```

Expected: all focused and ledger tests pass with no warnings.

- [ ] **Step 6: Commit measured Task 2 claims**

```bash
git add src/runreceiptstore.ts src/ledger.ts test/helpers/runreceipt-fixture.mjs test/runreceipt-store.mjs package.json
git commit -m "feat(receipt): publish and revalidate immutable run receipts" \
  -m "Tests: npm run build; npm run test:runreceipt; npm run test:ledger; git diff --check. Hermetic structural artifacts only; no native run or LOOK claim."
```

---

### Task 3: Fail-closed native fleet producer

**Files:**
- Create: `src/nativefleetreceipt.ts`
- Create: `test/nativefleetreceipt.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 identities; Task 2 artifact/receipt publishers; existing `resolveAssembledApk`, `materializeCaptureBytes`, `RunResult`, and binary runner result shape
- Produces: `produceNativeFleetReceipt(input: ProduceNativeFleetReceiptInput, deps?: NativeFleetReceiptDependencies): Promise<ProduceNativeFleetReceiptResult>`
- Produces: pure parsers `parseInstalledApkPath`, `parseRemoteSha256`, `parsePid`, `parseProcStartTicks`, and `parseForegroundActivity`

```ts
export interface ProduceNativeFleetReceiptInput {
  briefPath: string;
  effectiveSpec: unknown;
  projectDir: string;
  packageName: string;
  task: ":app:assembleDebug";
  serial: string;
  component: string;
  captureDir: string;
  settleMs: number;
  afterInstall?: () => Promise<{ status: "ok" } | { status: "failed"; reason: string }>;
}

export interface NativeFleetReceiptDependencies {
  runText: typeof run;
  runBinary: typeof runBinary;
  adbPath: string;
  gradleEnv: Record<string, string | undefined>;
  now: () => Date;
  randomUUID: () => string;
  sleep: (ms: number) => Promise<void>;
  inspectApk: (apkPath: string, projectDir: string) => Promise<{
    manifestInspection: NativeRunReceiptPayload["apk"]["manifestInspection"];
    signingInspection: NativeRunReceiptPayload["apk"]["signingInspection"];
  }>;
}

export type NativeFleetFailureStage =
  | "source-identity" | "build" | "apk-resolution" | "apk-publication" | "apk-inspection"
  | "install" | "installed-byte-identity" | "after-install" | "device-identity" | "launch"
  | "pid" | "foreground" | "capture" | "capture-publication" | "receipt-publication";

export type ProduceNativeFleetReceiptResult =
  | { status: "recorded"; built: true; installed: true; receipt: PublishedNativeRunReceipt }
  | { status: "failed"; stage: NativeFleetFailureStage; built: boolean; installed: boolean; reason: string; completedStages: string[] };
```

- [ ] **Step 1: Write failing parser and producer tests**

Use real temp source/APK/receipt/CAS files and fake only external command execution. Each fake result
must include the complete `RunResult` shape. Assert production output and published side effects,
not the fake itself.

```js
test("successful producer binds installed bytes and brackets one exact capture", async () => {
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "recorded");
  assert.equal(out.receipt.receipt.install.remoteApkSha256, fixture.apkSha256);
  assert.equal(out.receipt.receipt.runtime.pid, 4242);
  assert.equal(out.receipt.receipt.capture.before.pidStartTicks, "987654");
  assert.equal(out.receipt.receipt.capture.after.pidStartTicks, "987654");
  assert.equal(out.receipt.receipt.capture.before.foregroundPackage, fixture.packageName);
  assert.equal(out.receipt.receipt.capture.after.foregroundPackage, fixture.packageName);
  assert.equal(out.receipt.receipt.capture.artifactPath, fixture.expectedCaptureCasPath);
});
```

Table-drive one mutation per failure stage: Gradle nonzero/timeout; missing/ambiguous metadata APK;
APK publication/inspection package mismatch; install nonzero/no `Success`; `pm path` missing/multiple;
remote digest mismatch; after-install failure; missing fingerprint/boot ID; launch negative ack; no or
multiple PID; malformed/restarted PID start ticks; wrong foreground before/after; binary capture
failure; invalid PNG; CAS corruption; receipt publication failure. Assert no receipt file exists and
the returned `built`/`installed` flags reflect only completed checked stages.

Add parser tests with literal Android outputs, including `/proc/<pid>/stat` names containing spaces
and parentheses, package-prefix collisions, and malformed hashes/PIDs.

- [ ] **Step 2: Run producer tests to verify RED**

Run:

```bash
npm run build && node --test test/nativefleetreceipt.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/nativefleetreceipt.js`.

- [ ] **Step 3: Implement the producer sequence**

The order is fixed:

```ts
// identity -> build -> resolve/snapshot/inspect APK -> install -> installed hash -> optional
// afterInstall -> device/boot identity -> force-stop -> launch -> PID -> foreground -> settle ->
// before observation -> exact binary capture -> after observation -> capture CAS -> receipt publish
```

Use `:app:assembleDebug`, `resolveAssembledApk`, install the APK CAS path, and require exact
`com.fleet.*` app/package/component/foreground agreement. Generate the unique source capture as
`<captureDir>/<sessionId>.png`; atomically write the exact `runBinary` bytes and pass those same
bytes to `materializeCaptureBytes`. Require `settleMs` to be finite and within `0..180000`, and
sleep exactly that interval after foreground acquisition and before the bracketing observations.
Preserve the existing pre-launch sweep by force-stopping only packages returned by
`pm list packages com.fleet` before the first launch.

Default APK inspection resolves Android SDK tools from `ANDROID_SDK_ROOT`, `ANDROID_HOME`, or
project `local.properties`; successful manifest/signing parses populate inspected unions, tool
absence/nonzero becomes explicit unavailable, and a successfully inspected wrong package fails.

Each error includes command/stage, timeout/exit state, and at most the final 64 KiB/60 lines of
text. Do not infer a cause. Implement only one explicit blocker force-stop/relaunch and record the
recovery in `completedStages`.

- [ ] **Step 4: Run focused producer/store tests to verify GREEN**

Update:

```json
"test:runreceipt": "node --test test/runreceipt-identity.mjs test/runreceipt-store.mjs test/nativefleetreceipt.mjs"
```

Run:

```bash
npm run build && npm run test:runreceipt && git diff --check
```

Expected: all receipt tests pass with pristine output.

- [ ] **Step 5: Commit measured Task 3 claims**

```bash
git add src/nativefleetreceipt.ts test/nativefleetreceipt.mjs package.json
git commit -m "feat(receipt): observe one fail-closed native fleet run" \
  -m "Tests: npm run build; npm run test:runreceipt; git diff --check. Injected adb/Gradle fixtures only; no live emulator, Windows, hardware, or visual claim."
```

---

### Task 4: Integrate receipt production into fleet and run doors

**Files:**
- Modify: `src/fleetbuild.ts`
- Modify: `src/doors.ts`
- Create: `test/fleetreceipt.mjs`
- Modify: `test/semanticplace.mjs`
- Modify: `test/doors.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 3 producer/result
- Produces: exported `runFleetReceiptStage(input: RunFleetReceiptStageInput, deps: RunFleetReceiptStageDependencies): Promise<FleetReceiptStageResult>` adapter used by `fleet_build` and focused integration tests
- Produces: per-brief `receipt` result with `status`, `receiptId`, `receiptPath`, immutable-CAS `capturePath`, unique diagnostic `sourceCapturePath`, `captureSha256`, `evidenceType:"structural"`, and `lookRequired:true`
- Produces: Door 1 and `pico_loop` output fields `receiptId` and `receiptPath`; their `capture` is the unique receipt-bound capture

```ts
export interface RunFleetReceiptStageInput {
  nativeRun: ProduceNativeFleetReceiptInput;
  visualJudgeInput: null | {
    claim: string;
    expect: Record<string, unknown>;
    app: string;
    record: true;
    cClass: "C0_emulator";
  };
}

export interface RunFleetReceiptStageDependencies {
  nativeRun: NativeFleetReceiptDependencies;
  visualJudge: (input: Record<string, unknown>) => Promise<Record<string, any>>;
}

export interface FleetReceiptStageResult {
  built: boolean;
  installed: boolean;
  concluded: boolean;
  artifact: string | null;
  receipt: null | {
    status: "recorded";
    receiptId: string;
    receiptPath: string;
    capturePath: string;
    sourceCapturePath: string;
    captureSha256: string;
    evidenceType: "structural";
    lookRequired: true;
  };
  verdict: string | null;
  confidence?: number;
  visualChecks: unknown[];
  visualJudgeNote: string | null;
  visualLedger: unknown | null;
  visualJudgeArtifact: string | null;
  nativeFailure?: { stage: NativeFleetFailureStage; reason: string; completedStages: string[] };
}
```

- [ ] **Step 1: Write failing fleet/door integration tests**

Use the real Task 3 producer with temporary source/artifacts and injected external runners. Verify:

```js
test("fleet stage judges only the receipt-bound unique capture", async () => {
  const result = await runFleetReceiptStage(fixture.input, fixture.deps);
  assert.equal(result.receipt.evidenceType, "structural");
  assert.equal(result.receipt.lookRequired, true);
  assert.equal(result.artifact, result.receipt.capturePath);
  assert.notEqual(path.basename(result.artifact), "forward.png");
  assert.equal(result.visualJudgeArtifact, result.receipt.capturePath);
});

test("a failed receipt stage cannot be reported as a concluded fleet run", async () => {
  const result = await runFleetReceiptStage(fixture.input, failingDeps);
  assert.equal(result.receipt, null);
  assert.equal(result.concluded, false);
  assert.equal(result.verdict, null);
});
```

Add MCP-door assertions that `pico_build_app` and `pico_loop` return the receipt ID/path and exact
capture supplied by fleet. Replace the existing `semanticplace.mjs` source-order assertion with a
behavioral test of the exported adapter: successful after-install splat delivery precedes launch;
failed delivery returns stage `after-install` and produces no receipt.

- [ ] **Step 2: Run integration tests to verify RED**

Run:

```bash
npm run build && node --test test/fleetreceipt.mjs
```

Expected: FAIL because `runFleetReceiptStage` and receipt fields do not exist.

- [ ] **Step 3: Replace optimistic fleet build/install/capture flags with producer results**

Refactor only the existing `fleetbuild.ts` section beginning at build/install/launch. Preserve
semantic placement, code generation, IBL/data/splat preparation, visual expectations, panel checks,
the single blocker recovery behavior, and best-effort menu mouse-bridge startup. Pass splat delivery
as the exact `afterInstall` hook. Start the best-effort bridge after a receipt is recorded and before
returning the fleet result; it does not alter or recapture the receipt-bound frame.

On producer success:

```ts
rec.built = true;
rec.installed = true;
rec.artifact = produced.receipt.receipt.capture.artifactPath;
rec.receipt = {
  status: "recorded",
  receiptId: produced.receipt.receiptId,
  receiptPath: produced.receipt.receiptPath,
  capturePath: produced.receipt.receipt.capture.artifactPath,
  sourceCapturePath: produced.receipt.receipt.capture.sourcePath,
  captureSha256: produced.receipt.receipt.capture.sha256,
  evidenceType: "structural",
  lookRequired: true,
};
```

Run `visual_judge` only against immutable `rec.receipt.capturePath`. Receipt publication must happen first;
judge PASS/FAIL/ESCALATE does not change the receipt. Top-level `isConcluded` requires a recorded
receipt plus the existing verification-route conclusion.

- [ ] **Step 4: Thread receipt identity through Door 1 and current loop output**

Door 1 returns `receiptId`, `receiptPath`, and the receipt capture. `pico_loop` keeps
`lastReceiptId/lastReceiptPath` beside `lastCapture` and returns them from every exit after a run.
Descriptions and honesty text must say the receipt is structural and the exact returned capture
still requires a LOOK.

Do not implement revision/resume yet; this task only exposes the stable primitive later work will
consume.

- [ ] **Step 5: Run focused and affected suites to verify GREEN**

Update `test:runreceipt` to include `test/fleetreceipt.mjs`, then run:

```bash
npm run build
npm run test:runreceipt
npm run test:semantic
npm run test:doors
npm run test:bench
git diff --check
```

Expected: all commands exit 0 with no warnings.

- [ ] **Step 6: Commit measured Task 4 claims**

```bash
git add src/fleetbuild.ts src/doors.ts test/fleetreceipt.mjs test/semanticplace.mjs test/doors.mjs package.json
git commit -m "feat(receipt): emit receipt-bound fleet captures" \
  -m "Tests: npm run build; npm run test:runreceipt; npm run test:semantic; npm run test:doors; npm run test:bench; git diff --check. Hermetic integration only unless the report names a separate live receipt/capture."
```

---

### Task 5: Bind exact LOOK rows to receipts without evidence promotion

**Files:**
- Modify: `src/ledger.ts`
- Modify: `src/index.ts`
- Modify: `src/doors.ts`
- Create: `test/runreceipt-ledger.mjs`
- Modify: `test/ledger.mjs`
- Modify: `test/doors.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 `validateNativeRunReceiptCaptureBinding`
- Produces: `ValidatedRunReceiptBinding = { kind:"pico.native-run-receipt"; schemaVersion:1; receiptId:string; captureSha256:string }`
- Produces: optional `runReceiptId` input on full-surface `record_verification` and Door `pico_record`
- Produces: optional immutable `runReceipt: ValidatedRunReceiptBinding` on a recorded ledger row
- `registerLedgerTools` receives an injected `resolveRunReceiptBinding` dependency from `src/index.ts`; `ledger.ts` does not import the store and therefore introduces no receipt/ledger module cycle

- [ ] **Step 1: Write failing public-boundary ledger tests**

Spawn the real full-surface MCP against temporary receipt/ledger roots. Publish a valid receipt
fixture but do not create a ledger row. Assert `ledger_report` has zero entries and every evidence
bucket remains empty.

Then call:

```js
const recorded = await callJson("record_verification", {
  app,
  claim: "the exact receipt frame contains the observed fixture",
  evidenceType: "vision_verified",
  artifactPath: receipt.capture.artifactPath,
  attestation: "I opened the exact receipt-bound fixture image and observed its pixels.",
  runReceiptId: receipt.receiptId,
});
assert.equal(recorded.status, "recorded");
assert.deepEqual(recorded.entry.runReceipt, {
  kind: "pico.native-run-receipt",
  schemaVersion: 1,
  receiptId: receipt.receiptId,
  captureSha256: receipt.capture.sha256,
});
```

Add wrong-app, missing receipt, tampered receipt core, wrong artifact bytes, non-image evidence,
retraction mixed fields, and caller `extra` injection tests. Verify valid structural rows without a
receipt remain supported but cannot gain a run binding. Verify a valid binding preserves exactly
the requested evidence class and does not turn structural/auto-judged into vision evidence.

- [ ] **Step 2: Run ledger-binding tests to verify RED**

Run:

```bash
npm run build && node --test test/runreceipt-ledger.mjs
```

Expected: FAIL because `runReceiptId` is ignored/rejected and no validated binding is stored.

- [ ] **Step 3: Add the injected resolver and protected ledger field**

Use an explicit dependency:

```ts
export interface LedgerToolDependencies {
  resolveRunReceiptBinding?: (
    app: string,
    receiptId: string,
    artifactPath: string,
  ) => ReceiptCaptureBindingResult;
}

export type RegisterLedgerTools = (server: McpServer, deps?: LedgerToolDependencies) => void;
```

Resolve before append, then make `appendLedgerEntry`/`appendDeviceVerifiedEntry` compare the
materialized final capture SHA with `binding.captureSha256` before whitelisting `runReceipt` onto
the row. `extra` can never supply the binding. Existing producer-only receipt symbols and device
lineage gates remain unchanged.

Wire `src/index.ts` with `validateNativeRunReceiptCaptureBinding`. Add `runReceiptId` to record-only
field mutual-exclusion checks and to `pico_record` forwarding/schema. Door examples/descriptions
must tell the caller to pass the receipt returned by `pico_build_app` after looking at its exact
capture.

- [ ] **Step 4: Run ledger, doors, and receipt suites to verify GREEN**

Update the focused script to include `test/runreceipt-ledger.mjs`, then run:

```bash
npm run build
npm run test:runreceipt
npm run test:ledger
npm run test:doors
git diff --check
```

Expected: all commands exit 0 and existing unbound ledger behavior remains compatible.

- [ ] **Step 5: Commit measured Task 5 claims**

```bash
git add src/ledger.ts src/index.ts src/doors.ts test/runreceipt-ledger.mjs test/ledger.mjs test/doors.mjs package.json
git commit -m "feat(receipt): bind exact looked frames to run receipts" \
  -m "Tests: npm run build; npm run test:runreceipt; npm run test:ledger; npm run test:doors; git diff --check. Synthetic PNG LOOK text is fixture data only; no real rendered LOOK or hardware claim."
```

---

### Task 6: Make ship readiness consume current receipt plus linked LOOK

**Files:**
- Modify: `src/ship.ts`
- Modify: `src/doors.ts`
- Modify: `README.md`
- Modify: `SKILLS.md`
- Modify: `CAPABILITIES.md`
- Modify: `QUICKSTART.md`
- Create: `test/runreceipt-ship.mjs`
- Modify: `test/ledger.mjs`
- Modify: `test/doors.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 `findHistoricalNativeRunReceipt` and `findCurrentNativeRunReceipt`; Task 5 effective ledger `runReceipt` binding
- Produces: `ship_checklist` receipt summary containing selected ID/path, current validation status,
  rejected candidate issues, and linked LOOK sequence/evidence type when present
- Produces: Door 10 `pico_ship` forwards the same app/lane/projectDir contract and returns that
  receipt summary without dropping IDs, rejected-candidate issues, or remaining blockers
- Produces: `pico_next` reads the newest historical receipt for capture/ID rather than assuming mutable `forward.png`, and recommends `pico_record` with `runReceiptId`

```ts
export type NativeShipReceiptSummary =
  | {
      status: "accepted-current-bytes";
      receiptId: string;
      receiptPath: string;
      apkSha256: string;
      captureSha256: string;
      linkedLook: { seq: number; evidenceType: "vision_verified" | "device_verified" };
      rejectedCandidates: Array<{ receiptId: string; issues: string[] }>;
    }
  | {
      status: "needs-linked-look";
      receiptId: string;
      receiptPath: string;
      apkSha256: string;
      captureSha256: string;
      rejectedCandidates: Array<{ receiptId: string; issues: string[] }>;
    }
  | { status: "no-current-receipt"; rejectedCandidates: Array<{ receiptId: string; issues: string[] }> }
  | { status: "invalid-store"; issues: string[] };
```

- [ ] **Step 1: Write failing ship-consumer tests**

Exercise the real MCP ship tool with temporary current project, receipt, and ledger roots:

```js
test("ship accepts current debug bytes only with one exact receipt-linked LOOK", async () => {
  const ship = await callJson("ship_checklist", { app, lane: "native", projectDir });
  assert.equal(ship.receipt.status, "accepted-current-bytes");
  assert.equal(ship.receipt.receiptId, receipt.receiptId);
  assert.equal(ship.receipt.linkedLook.seq, lookedSeq);
  assert.ok(!ship.blockers.some((line) => /no verified build receipt/i.test(line)));
  assert.match(ship.verdict, /^NOT READY/); // release/store blockers remain
});
```

Add tests where each of the following prevents acceptance: no receipt, valid receipt without LOOK,
unlinked historical LOOK, wrong receipt ID, wrong capture hash, auto-judged/structural/USD/logcat row,
retracted LOOK, provenance-broken LOOK, current AppSpec/source drift, APK drift, AGP metadata drift,
receipt/capture CAS tamper, wrong project path, or unreadable receipt directory. Verify corrupt older
candidates are disclosed and do not silently disappear when a newer valid candidate is selected.
Call Door 10 `pico_ship` for both the accepted-current-bytes fixture and a drifted fixture; assert
its returned `receipt`, `ready`, `deferred`, `blockers`, and `verdict` equal the underlying
`ship_checklist` result rather than a Door-authored approximation.

- [ ] **Step 2: Run ship tests to verify RED**

Run:

```bash
npm run build && node --test test/runreceipt-ship.mjs
```

Expected: FAIL because `ship_checklist` still always reports the missing future receipt blocker.

- [ ] **Step 3: Implement receipt-aware native ship evaluation**

Keep existing ledger provenance/device handling and web/hybrid boundaries. For native:

```ts
const selection = findCurrentNativeRunReceipt(app, pdir);
const linkedLook = selection.status === "valid"
  ? entries.find((entry) =>
      (entry.evidenceType === "vision_verified" || isPassingDeviceEvidence(entry)) &&
      entry.runReceipt?.receiptId === selection.receipt.receiptId &&
      entry.runReceipt?.captureSha256 === selection.receipt.capture.sha256 &&
      entry.capture?.sha256 === selection.receipt.capture.sha256)
  : undefined;
```

Only the valid-selection-plus-linked-look branch adds a ready item and removes the native receipt
blocker. Name receipt ID, APK SHA, capture SHA, and ledger sequence. Always retain debug scope and
release/signing/store blockers. Surface selection/candidate issues as blockers or explicit audit
warnings; never fall back to file existence as proof.

- [ ] **Step 4: Update Door next-step behavior and documentation**

Update Door 10’s description to name digest-bound debug receipt plus linked LOOK semantics and to
preserve the release/store boundary. Its handler remains a transparent `ship_checklist` call.

`pico_next` must find receipt capture/ID, classify `built-needs-look` only from a valid historical
receipt, and recommend:

```json
{
  "door": "pico_record",
  "argsExample": {
    "app": "com.fleet.<id>",
    "claim": "<what was actually observed>",
    "evidenceType": "vision_verified",
    "artifactPath": "<receipt capture path>",
    "runReceiptId": "<receipt id>",
    "attestation": "<what was actually seen>"
  }
}
```

Update user documentation to replace “future/no receipt yet” statements with the exact v1 scope,
receipt fields returned by fleet/Door 1, exact-frame LOOK workflow, and remaining release/web/
hardware/Windows boundaries. Do not change generated claims pages or historical claim data.

- [ ] **Step 5: Run all focused consumer/documentation tests to verify GREEN**

Update `test:runreceipt` to include `test/runreceipt-ship.mjs`, then run:

```bash
npm run build
npm run test:runreceipt
npm run test:ledger
npm run test:doors
npm run test:docsmeta
git diff --check
```

Expected: every command exits 0; documentation links and metadata have zero failures.

- [ ] **Step 6: Commit measured Task 6 claims**

```bash
git add src/ship.ts src/doors.ts README.md SKILLS.md CAPABILITIES.md QUICKSTART.md test/runreceipt-ship.mjs test/ledger.mjs test/doors.mjs package.json
git commit -m "feat(receipt): gate native ship bytes on linked looked evidence" \
  -m "Tests: npm run build; npm run test:runreceipt; npm run test:ledger; npm run test:doors; npm run test:docsmeta; git diff --check. Hermetic receipt/ledger fixtures only unless separately stated; no release, Swan, Windows, hardware, or rendered LOOK claim."
```

---

## Whole-interface verification and independent review

- [ ] **Step 1: Run the complete required validation from the reviewed Task 6 HEAD**

```bash
npm run build
SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs
git diff --check
git status --short --branch
```

Record exact exit codes and battery invocation totals. The known local `scene_schemas` absence is a
reported battery failure, not a green suite. A macOS `test:picocli-win` fixture pass is not native
Windows evidence.

- [ ] **Step 2: Run an independent whole-range review**

Review the complete range `efbc1443b5c28809b62f16ae765d37362391e2bf..HEAD` against the approved
design and this plan. The reviewer must independently inspect:

- all seven required identity relationships;
- tamper/failure/atomicity coverage;
- no receipt-to-visual promotion;
- ledger retraction/provenance behavior;
- current-byte ship matching;
- compatibility of Door 1, Door 10 `pico_ship`, `pico_loop`, `pico_record`, and `pico_next`;
- unchanged managed-latest/Windows/public-surface boundaries; and
- whether measured commit claims match the commands actually run.

Fix every Critical/Important finding through one reviewed fix wave. Deferred Minor findings are
recorded explicitly rather than silently dropped.

- [ ] **Step 3: Optional live emulator receipt measurement, only if preflight permits**

Run default `pico_doctor {}` first. Do not calibrate unless a later metric/roam task requires it.
If disk/toolchain/emulator checks safely permit one bounded fleet run, run one self-contained brief,
retain its exact receipt ID/path/capture, re-run historical/current validation, and open the exact
receipt capture with vision before making any visual statement. If live execution is deferred, say
so and report only hermetic structural proof.

- [ ] **Step 4: Commit any independently reviewed fix/docs wave with exact evidence**

The commit body lists only commands that ran and exact outcomes. It explicitly says whether a live
receipt was minted and whether its capture was opened. It never infers Swan, hardware,
native-Windows, release/store, or rendered LOOK evidence.
