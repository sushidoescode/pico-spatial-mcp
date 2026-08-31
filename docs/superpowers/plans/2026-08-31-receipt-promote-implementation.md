# Receipt PROMOTE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved explicit one-hop `PROMOTE` operation so a native-v1 receipt can become a new audited portable receipt identity without changing native-v1 meaning or current-build/ship readiness.

**Architecture:** Add `action:"promote"` to the existing `record_verification` and `pico_record` tools, preserving the MCP tool inventories. A new TypeScript portability module owns strict schemas, domain-separated identities, native-lineage validation, portable historical selection, and resolver normalization; a packaged Python helper supplies the descriptor-relative `openat`/`mkdirat`/`linkat` operations that Node 22 on macOS was measured not to expose. Ledger record/report consume strict discriminated selectors and bindings, while current receipt and ship selection remain native-v1-only.

**Tech Stack:** TypeScript 5.7, Node.js 20+, Zod 3, Python 3 POSIX standard library helper, MCP SDK stdio tests, Node test runner.

**Spec:** `docs/superpowers/plans/2026-08-28-receipt-ledger-portability.md`

## Global Constraints

- Add or remove no MCP tool. Full/default/doors tool inventories must remain byte-for-byte identical by name and count.
- `pico.native-run-receipt` schema v1, its SHA-256 preimage, absolute artifact-path rules, file locations, native ledger binding shape, producer output, current validation, public native results, and `RunRevisionV1` remain unchanged.
- `PROMOTE` is explicit, one hop, and never calls ledger append/recording. It accepts only a native-v1 source and may leave only unreferenced immutable target objects on failure.
- Every source receipt, APK, effective AppSpec, and capture and every final target object is reopened and rehashed; missing, mismatched, noncanonical, symlinked, ambiguous, or corrupt input fails closed and is never overwritten.
- Portable record binding requires the exact portable receipt and promotion identities. It cannot fall back across kinds and can bind only through the existing private capability plus append-time capture hash recheck.
- Portable receipts are historical/report/record provenance only. They never clear current-build, release, signing, hardware, store, LOOK, or ship readiness.
- Preserve every row in the design's eleven-row back-compat/reader table, including native-only producers and revision-v1, public-reader stripping, absolute returned paths, and native-current-only ship.
- Promotion and portable reads use pinned, no-follow, descriptor-relative traversal and create-only hard-link publication. If those primitives or the packaged helper are unavailable, return PROMOTE unavailable and make no target write.
- Do not touch a real emulator, device, `~/.pico-mcp`, or archived evidence. All tests use temporary synthetic roots, `PICO_ADB=/usr/bin/false` unless a test supplies its own fixture command, and `PICO_MCP_CLI_POLICY=disabled`.
- Do not modify `benchmarks/**` or `test/agentbench-*`.

---

### Task 1: Strict portable identities and reusable native-lineage validation

**Files:**
- Create: `src/runreceiptportable.ts`
- Create: `test/runreceipt-portability.mjs`
- Modify: `src/runreceiptstore.ts`

**Interfaces:**
- Consumes: existing `NativeRunReceipt`, `ReceiptStoreOptions`, `canonicalJson`, `canonicalIdentity`, and `validateCaptureBuffer` contracts.
- Produces: exported `RootIdentity`, `PortableRunReceipt`, `PromotionManifest`, `NativeLedgerBinding`, `PortableLedgerBinding`, `ReceiptSelector`, `RunReceiptBinding`, `portableReceiptIdOf(payload)`, `promotionIdOf(core)`, `auditIdOf(value)`, and `validateNativeRunReceiptLineageSnapshot(input)`.

- [ ] **Step 1: Write failing strict-schema and identity tests**

  Add tests with hand-derived literal expectations for the three preimages:

  ```js
  sha256(Buffer.concat([Buffer.from("pico.portable-native-run-receipt/v1\0"), Buffer.from(canonicalJson(payload))]))
  sha256(Buffer.concat([Buffer.from("pico.run-receipt-promotion-core/v1\0"), Buffer.from(canonicalJson(core))]))
  sha256(Buffer.concat([Buffer.from("pico.run-receipt-promotion-audit/v1\0"), Buffer.from(canonicalJson({ promotionId, recordedAt, toolVersion }))]))
  ```

  Assert exact keys, lowercase SHA-256, unsigned decimal `deviceId`/`inode`, canonical POSIX `realPath`, millisecond-Z timestamps, semantic tool versions, three exact artifact roles, and rejection of extra keys. Name the production break each case catches in the test title.

- [ ] **Step 2: Build before the focused RED run**

  Run: `npm run build`

  Run: `node --test test/runreceipt-portability.mjs`

  Expected: FAIL because `dist/runreceiptportable.js` or its exports do not exist.

- [ ] **Step 3: Implement exact schemas and domain-separated identity functions**

  Define the literal kinds, schema versions, limits, and paths from design lines 91-140. Every Zod object is `.strict()`. The domain helper hashes UTF-8 `domain`, one NUL byte, then `canonicalJson(value)`; no caller-provided identity is trusted.

- [ ] **Step 4: Extract one content validator without changing native-v1 behavior**

  Add this reusable contract in `src/runreceiptstore.ts`:

  ```ts
  export type NativeRunReceiptLineageSnapshot = {
    app: string;
    receiptId: string;
    receiptBytes: Buffer;
    sourceReceiptRoot: string;
    sourceLedgerRoot: string;
    apk: { sha256: string; bytes: number };
    effectiveAppSpecBytes: Buffer;
    capture: { ok: boolean; reason?: string; format?: "png" | "jpeg"; sha256?: string; bytes?: number; width?: number; height?: number };
  };

  export function validateNativeRunReceiptLineageSnapshot(input: NativeRunReceiptLineageSnapshot):
    | { status: "valid"; receipt: NativeRunReceipt; receiptFileSha256: string }
    | { status: "invalid"; receiptId: string; issues: string[] };
  ```

  It checks canonical receipt bytes plus one newline, strict native schema, filename/app/ID recomputation, exact source-root locator strings, APK/spec/capture facts, canonical effective spec, chronology, package/install/build/runtime/capture bindings, and receipt-file SHA-256. Refactor the existing historical native reader to feed its current snapshots into this function; retain all existing native tests and public shapes.

- [ ] **Step 5: Verify GREEN and native compatibility**

  Run: `npm run build`

  Run: `node --test test/runreceipt-portability.mjs test/runreceipt-store.mjs`

  Expected: all tests pass with the existing native fixture assertions unchanged.

- [ ] **Step 6: Commit**

  ```bash
  git add src/runreceiptportable.ts src/runreceiptstore.ts test/runreceipt-portability.mjs
  git commit -m "feat(receipts): define portable receipt identities"
  ```

### Task 2: Descriptor-safe one-hop promotion and portable historical reader

**Files:**
- Create: `scripts/receipt-portability-helper.py`
- Modify: `src/runreceiptportable.ts`
- Modify: `test/runreceipt-portability.mjs`

**Interfaces:**
- Consumes: Task 1 strict schemas, identity functions, native-lineage validator, and existing native historical reader.
- Produces: `promoteNativeRunReceipt(input): PromotionResult`, `readPortableRunReceipt(app, receiptId, promotionId, options): PortableRunReceiptValidation`, and an internal bounded JSON request/response protocol with helper operations `promote` and `inspect`.

- [ ] **Step 1: Write failing promotion, idempotence, rehash, and refusal tests**

  Use `createRunReceiptFixture` only under test-owned temporary roots. Cover these observable outcomes:

  ```js
  const promoted = await portable.promoteNativeRunReceipt({
    app: fixture.payload.app,
    sourceReceiptId: published.receiptId,
    sourceReceiptRoot: fs.realpathSync(fixture.rootDir),
    sourceLedgerRoot: fs.realpathSync(fixture.ledgerDir),
    targetReceiptRoot: fs.realpathSync(targetReceiptRoot),
    targetLedgerRoot: fs.realpathSync(targetLedgerRoot),
  });
  assert.equal(promoted.status, "promoted");
  assert.notEqual(promoted.portableReceiptId, published.receiptId);
  ```

  Assert source hashes are unchanged; target APK/spec/capture/lineage/portable/manifest bytes independently hash to their committed identities; manifest strict keys and all three IDs recompute; no target ledger row exists; exact rerun returns the first `recordedAt`/`auditId`; a portable ID used as a source is explicitly refused; deleting or mismatching each source object refuses; corrupting each final target object makes rerun and read fail closed.

- [ ] **Step 2: Build before the focused RED run**

  Run: `npm run build`

  Run: `node --test --test-name-pattern='PROMOTE|portable historical' test/runreceipt-portability.mjs`

  Expected: FAIL because promotion and portable reading are not implemented.

- [ ] **Step 3: Implement the POSIX helper protocol**

  `scripts/receipt-portability-helper.py` must:

  - accept one bounded strict JSON request on stdin and emit one strict JSON result on stdout;
  - open each absolute already-resolved non-root store from `/` component-by-component using `os.open(..., dir_fd=..., O_DIRECTORY|O_NOFOLLOW)`, retaining and re-`fstat`ing every descriptor;
  - reject every root equality except identical source/target receipt roots, reject all non-equal ancestor/descendant pairs, and require distinct source/target ledger roots;
  - snapshot regular source files with before/after descriptor identity checks, stream APK bytes, fully validate the PNG structure, and rehash all four source objects;
  - walk/create descendants with `dir_fd`, use exclusive no-follow temporaries, `fsync`, create-only `os.link` with source/destination directory FDs, and never rename or overwrite;
  - publish target CAS, lineage copy, portable receipt, then manifest commit marker; resolve races by validating the winner and reuse the first valid audit timestamp;
  - reopen/reparse/rehash all final targets before success; and
  - implement `inspect` without opening recorded source roots, returning bounded canonical lineage/spec/portable/manifest bytes plus independently measured artifact facts and target root identities.

- [ ] **Step 4: Implement the TypeScript promotion and reader boundary**

  Resolve an absolute executable `python3` from an absolute environment override or absolute `PATH` component and the helper from `import.meta.url`; unsupported platforms/helper APIs return `{status:"unavailable", reason}` before writes. `promoteNativeRunReceipt` first calls the unchanged native historical validator with explicit source roots, detects a portable source for the explicit one-hop error, then asks the helper to revalidate/copy/publish. `readPortableRunReceipt` validates every returned byte and fact again with Task 1 schemas, all three IDs, recorded root identities, lineage file hash/source locators, target CAS facts, and native cross-field predicates.

- [ ] **Step 5: Verify GREEN**

  Run: `npm run build`

  Run: `node --test test/runreceipt-portability.mjs test/runreceipt-store.mjs`

  Expected: all promotion, corruption, idempotence, and native compatibility cases pass.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/receipt-portability-helper.py src/runreceiptportable.ts test/runreceipt-portability.mjs
  git commit -m "feat(receipts): publish audited one-hop promotions"
  ```

### Task 3: Strict portable ledger binding and explicit existing-tool actions

**Files:**
- Modify: `src/ledger.ts`
- Modify: `src/index.ts`
- Modify: `src/doors.ts`
- Modify: `src/runreceiptportable.ts`
- Modify: `test/runreceipt-portability.mjs`
- Modify: `test/runreceipt-ledger.mjs`

**Interfaces:**
- Consumes: `promoteNativeRunReceipt`, `ReceiptSelector`, strict native/portable binding union, and portable/native resolver functions.
- Produces: record resolver `(app, selector, artifactPath)`, report validator `(app, claimedBinding, artifactPath)`, `action:"promote"`, and optional `runReceiptPromotionId` on record calls.

- [ ] **Step 1: Write failing action and binding tests**

  Test that full `record_verification` and Door 13 `pico_record` forward the exact promote arguments and return portable/promotion/audit IDs plus target paths without creating an evidence row. Then record synthetic image evidence with both IDs and assert the exact seven-field portable binding:

  ```js
  {
    kind: "pico.portable-native-run-receipt",
    schemaVersion: 1,
    receiptId: promoted.portableReceiptId,
    sourceReceiptId: published.receiptId,
    promotionId: promoted.promotionId,
    auditId: promoted.auditId,
    captureSha256: fixture.payload.capture.sha256,
  }
  ```

  Assert report revalidation preserves every field; no validator strips the binding without leaking portable-only fields; caller-made bindings, promotion-only input, portable-without-promotion, native-with-promotion, wrong promotion, wrong image, and post-materialization hash change are rejected.

- [ ] **Step 2: Build before the focused RED run**

  Run: `npm run build`

  Run: `node --test --test-name-pattern='portable binding|promote action' test/runreceipt-portability.mjs test/runreceipt-ledger.mjs`

  Expected: FAIL because action and union binding support are absent.

- [ ] **Step 3: Replace optional-field normalization with strict discriminated unions**

  Preserve the native four-field object exactly. Add the portable seven-field parser. Record constructs one `ReceiptSelector` from public inputs and never falls back; report passes the complete claimed binding and requires the resolver to return the same union member with every field equal. `appendLedgerEntry` continues to accept only a private WeakSet capability and rechecks `captureSha256` after materialization.

- [ ] **Step 4: Add the explicit promote action without a new tool**

  Extend the existing action enum to `record|retract|promote`. The promote arm accepts exactly `app`, `sourceReceiptId`, `sourceReceiptRoot`, `sourceLedgerRoot`, `targetReceiptRoot`, and `targetLedgerRoot`; it rejects every record/retract field and returns before any ledger function. Inject promotion and the two resolver contracts from `src/index.ts` to avoid the existing `runreceiptstore`/`ledger` import cycle. Mirror the exact fields through `pico_record`; retain all 18 door names.

- [ ] **Step 5: Verify GREEN and legacy ledger behavior**

  Run: `npm run build`

  Run: `PICO_ADB=/usr/bin/false PICO_MCP_CLI_POLICY=disabled node --test test/runreceipt-portability.mjs test/runreceipt-ledger.mjs`

  Expected: portable cases and every native binding/private-capability case pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/ledger.ts src/index.ts src/doors.ts src/runreceiptportable.ts test/runreceipt-portability.mjs test/runreceipt-ledger.mjs
  git commit -m "feat(receipts): bind portable provenance through existing tools"
  ```

### Task 4: Historical selection, golden recapture regression, and release gates

**Files:**
- Modify: `src/runreceiptportable.ts`
- Modify: `src/doors.ts`
- Modify: `src/ship.ts`
- Modify: `test/runreceipt-portability.mjs`
- Modify: `test/runreceipt-ship.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: validated native candidates, validated portable receipt/manifest pairs, union report validator, and existing current-native selector.
- Produces: `findHistoricalRunReceipt(app, options)` normalized historical selection and portable-aware `pico_next` output with resolved target paths and both IDs.

- [ ] **Step 1: Write the failing golden-recapture and ship/current tests**

  Model the original failure with a session receipt/ledger root and a distinct durable receipt/ledger root. Under a server configured for the durable roots, first assert native recording rejects the session receipt; call explicit promote; then assert an explicit record/report succeeds with the portable binding. Delete the synthetic source roots and prove report/historical reading still succeeds. Assert `findCurrentNativeRunReceipt` returns no current receipt, `ship_checklist` remains `no-current-receipt`, and no release/signing/store/LOOK boundary changes.

  Add `pico_next` assertions for target-resolved `capture`, `receiptId`, `promotionId`, and the record recommendation's `runReceiptPromotionId`. Add ambiguity/cap tests for native 4,096, portable 4,096, manifest 4,096, and combined 12,288 candidate rules without allocating artifact payloads.

- [ ] **Step 2: Build before the focused RED run**

  Run: `npm run build`

  Run: `PICO_ADB=/usr/bin/false PICO_MCP_CLI_POLICY=disabled node --test --test-name-pattern='golden recapture|portable.*ship|portable historical selection' test/runreceipt-portability.mjs test/runreceipt-ship.mjs`

  Expected: FAIL because combined historical selection and `pico_next` portable output are absent.

- [ ] **Step 3: Implement bounded normalized historical selection**

  Keep `findHistoricalNativeRunReceipt` and `findCurrentNativeRunReceipt` public behavior unchanged. The new combined selector scans native, portable, and manifest namespaces under separate 4,096 caps and a 12,288 total cap, records every malformed candidate, groups by source native ID, prefers a valid native receipt at current roots within its group, rejects multiple valid projections as store ambiguity, then sorts group winners by lineage `createdAt` descending and source ID ascending. It returns absolute resolved target paths; explicit record never uses this fallback.

- [ ] **Step 4: Wire historical consumers while keeping ship native-current-only**

  `pico_next` and its ledger validation use the union resolver and combined historical selector. Its state and suggested `pico_record` arguments include `promotionId` only for portable provenance. `ship_checklist` uses the union report validator so portable ledger linkage is reported honestly, but it still calls only `findCurrentNativeRunReceipt` and requires a native-kind linked LOOK for acceptance.

- [ ] **Step 5: Include the new fixture in the existing receipt gate**

  Append `test/runreceipt-portability.mjs` to the existing `test:runreceipt` command. Do not add a new `test:` script, change a manifest version, run `sync:meta`, or modify tool-count serialization files.

- [ ] **Step 6: Run fresh verification**

  Run in this order:

  ```bash
  npm run build
  PICO_ADB=/usr/bin/false PICO_MCP_CLI_POLICY=disabled npm run test:runreceipt
  npm run test:docsmeta
  npm run test:adoption-safety
  npm run test:distribution-adoption
  npm run test:runrevision
  npm run test:tarball
  ```

  Required results: build exit 0; receipt suite and all new tests zero failures with exact counts recorded; docsmeta 0; adoption-safety 48/0; distribution-adoption exactly 41 pass/2 known failures; revision suites zero failures; tarball retains 252 full tools on macOS and 18 default/doors tools. Recompute SHA-256 for every `benchmarks/**` and `test/agentbench-*` file and compare to the branch-start snapshot.

- [ ] **Step 7: Commit**

  ```bash
  git add src/runreceiptportable.ts src/doors.ts src/ship.ts test/runreceipt-portability.mjs test/runreceipt-ship.mjs package.json
  git commit -m "test(receipts): lock portable historical-only provenance"
  ```
