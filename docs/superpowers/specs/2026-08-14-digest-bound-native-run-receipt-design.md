# Digest-Bound Native Run Receipt v1 Design

**Date:** 2026-08-14  
**Programme:** [PICO MCP Evolution Programme](2026-08-14-pico-evolution-programme-design.md)  
**Base:** `91944f49454f926e13ec11194c2b3466d11e79a6` (`pico-evolution-2026-08-14`)  
**Status:** Approved focused design; implementation remains test-first and independently reviewed  
**Scope:** Native debug APKs produced by `fleet_build` on the existing POSIX/emulator lane

## Purpose

Create the first producer-written identity record that proves one exact fleet input became one
exact APK, that those APK bytes were installed as the expected package, that one live launch
session remained the foreground app while one exact frame was captured, and that all of those
facts belong to the same run.

The receipt is structural evidence. It never says what the captured pixels look like and never
creates or upgrades a trust-ledger evidence row by itself. A visual claim remains incomplete until
a human or vision-capable agent opens the exact receipt-bound capture, judges it, and records that
LOOK against the receipt.

## Non-goals

V1 does not establish:

- release signing, store readiness, or release APK behavior;
- web or hybrid deployment receipts;
- Swan or other physical-device behavior;
- hardware Safeguard or Guardian behavior;
- native Windows execution;
- rendered appearance, visual correctness, or a `vision_verified` claim;
- protection against a privileged local attacker who can rewrite every source, artifact, and
  receipt consistently; or
- reproducible builds across machines or toolchain versions.

## Chosen approach

The receipt is minted by an integrated fleet producer, not by an after-the-fact tool that accepts
caller-authored `built`, `installed`, or `launched` booleans. The producer owns the sequence from
pre-build identity through the post-capture continuity probes. It publishes a receipt only after
every mandatory observation succeeds.

This approach is preferred over:

1. a fleet finalizer, which would have to trust today’s optimistic record flags and mutable paths;
2. retrofitting `build_and_run` as the fleet producer, which would entangle its single-app behavior
   with fleet-specific semantic placement, generated assets, blocker recovery, and automated-eye
   sequencing.

The implementation may extract small shared probe or APK-resolution helpers, but it must not
change the completed managed-latest CLI track without a reproduced regression.

## Architecture

Four focused units share one explicit contract:

1. **Receipt identity and store** canonicalize JSON-domain values, hash source and artifacts,
   publish immutable receipt and APK snapshots, and revalidate them fail-closed.
2. **Fleet native-run producer** performs the build/install/launch/capture sequence and supplies
   only directly observed values to the receipt store.
3. **Ledger binding** optionally links a looked or measured image row to a validated receipt whose
   app and capture identity agree. It does not change the row’s evidence class.
4. **Ship reader** matches current native source/APK bytes to a valid receipt and then requires an
   effective, intact, receipt-linked LOOK row before clearing the native provenance blocker.

The first implementation should keep these responsibilities in focused modules rather than add
more receipt behavior to the already large `fleetbuild.ts` or `ledger.ts` files.

## Identity model

### AppSpec and source identity

V1 records three distinct source identities so authored intent, compiler input, and Gradle input
cannot be conflated:

1. **Authored normalized AppSpec** — parse the brief’s `spec` through `appSpecSchema`, apply schema
   defaults, canonicalize the parsed value, and record its SHA-256 and canonical byte length. Also
   retain the canonical brief path so a reader can parse and re-hash the current authored spec.
2. **Effective AppSpec** — after semantic-anchor resolution and the fleet package/app-name rewrite,
   canonicalize and hash the exact object passed to `buildLedger`. Store an immutable canonical
   snapshot so later run/resume work can address the historical compiler input without re-running
   semantic resolution under potentially changed code.
3. **Gradle input manifest** — immediately before Gradle starts, hash the exact project inputs from
   the bounded V1 allowlist below. The canonical manifest is an ordered array of
   `{path, bytes, sha256}` records using project-relative POSIX paths. Its identity is the SHA-256
   of the canonical array and includes `entryCount` and `totalBytes`.

The V1 Gradle-input allowlist is:

- existing root files `settings.gradle`, `settings.gradle.kts`, `build.gradle`,
  `build.gradle.kts`, `gradle.properties`, `gradlew`, and `gradlew.bat`;
- existing app files `app/build.gradle`, `app/build.gradle.kts`, and
  `app/proguard-rules.pro`; and
- every regular file below `gradle/`, `buildSrc/`, `app/src/`, `app/libs/`, and root `libs/`.

Selected roots must remain below the real project root. Symbolic links and non-regular selected
entries are rejected rather than followed. The manifest is bounded to 20,000 entries, 2 GiB total
input bytes, and 512 MiB per file. At least one Android manifest and one Kotlin or Java source file
must be present. Build outputs, `.gradle`, `.git`, `.idea`, `local.properties`, and arbitrary
project documentation are outside the allowlist.

Changing the current authored spec or any selected Gradle input breaks current-source validation,
even when the old APK and historical receipt still exist. This is intentional fail-closed
invalidation, not a claim that every selected byte affected Gradle’s output.

### APK identity

The producer must:

1. run the exact scoped task `:app:assembleDebug` and require exit code zero with no timeout;
2. resolve exactly one APK through AGP `output-metadata.json` using the requested variant and
   effective package name;
3. record the metadata file path and SHA-256;
4. stream an APK no larger than 2 GiB from one open descriptor into a unique CAS staging file while
   hashing it, require unchanged descriptor metadata before/after the copy, publish those bytes
   create-only under the receipt store’s APK CAS, and install from that immutable CAS path;
5. require the AGP `applicationId`, effective AppSpec package, receipt app, installed package,
   launched component, and observed foreground package to agree.

APK package/version inspection is recorded when Android SDK tooling returns it successfully.
Signing identity is recorded only when `apksigner verify --print-certs` succeeds. An unavailable
optional inspection is represented as `{status:"unavailable", reason}` and cannot be rendered as
an inspected fact. If an available inspection reports a package different from the required
package, receipt production fails.

V1 does not label a debug certificate as release signing or store readiness.

### Install identity

`adb install -r <immutable-apk-cas-path>` must exit zero, not time out, and return a positive
`Success` acknowledgement. The producer records a digest of the bounded command output rather
than trusting a later caller summary.

After installation, the producer requires exactly one installed base APK for the expected package
from `pm path`, measures it with `toybox sha256sum`, and requires that remote digest to equal the
local APK digest. The receipt records the remote path, digest, package, method, completion time,
and acknowledgement digest. Failure or ambiguity cannot mint a receipt.

### Device and launch-session identity

Every producer run creates a random UUID `sessionId` before launch. The receipt binds it to:

- the explicit adb serial;
- observed `ro.product.model`, `ro.build.fingerprint`, and `ro.boot.qemu` values;
- the device boot ID read from `/proc/sys/kernel/random/boot_id`;
- the exact launched component;
- a positive launch acknowledgement digest and timestamp;
- one numeric PID; and
- that PID’s process-start field from `/proc/<pid>/stat`.

The emulator serial and emulator-shaped fingerprint are valid structural identity for this V1
lane. They are not hardware identity and cannot produce `device_verified` evidence.

The producer polls within explicit time bounds for one live PID and the expected foreground
component. A missing PID, multiple ambiguous PIDs, PID restart, process-start mismatch, launch
failure, or foreground mismatch is a terminal receipt-production failure.

V1 uses a 30-minute Gradle deadline, five-minute install deadline, 30-second launch and capture
deadlines, 20-second individual identity/foreground probe deadlines, and a 24-second bounded
PID/foreground poll with two-second intervals. Fleet’s existing single disclosed
foreground-blocker stop/relaunch is the only retry; a second failure is terminal.

### Capture identity

The capture path is unique per run; fleet must stop overwriting `forward.png`. The producer:

1. observes the expected package/component, PID, and PID-start identity;
2. captures PNG bytes with `adb exec-out screencap -p`;
3. observes the same foreground and process identities again;
4. validates the exact in-memory PNG bytes, including format, dimensions, length, and SHA-256;
5. atomically writes the unique source capture and materializes the same in-memory bytes into the
   existing ledger capture CAS; and
6. records the source path, CAS path, capture time, hash, byte length, dimensions, and the complete
   before/after observations.

The receipt binds the bytes captured between the two continuity probes. Re-reading a mutable
capture pathname after measurement is not an acceptable producer path.

## Receipt schema and storage

The JSON envelope has these top-level fields:

```json
{
  "kind": "pico.native-run-receipt",
  "schemaVersion": 1,
  "receiptId": "<64 lowercase hex>",
  "createdAt": "<ISO-8601>",
  "scope": "fleet-native-debug",
  "app": "com.fleet.example",
  "source": {},
  "build": {},
  "apk": {},
  "install": {},
  "runtime": {},
  "capture": {}
}
```

The detailed sections contain the identities specified above. Mandatory observation fields do not
use `null`, `unknown`, inferred, or optimistic values. Optional APK inspection uses its explicit
status union.

Canonical JSON recursively sorts object keys, preserves array order, accepts only JSON-domain
primitives, and rejects `undefined`, non-finite numbers, sparse arrays, custom prototypes, and
unsupported values. `receiptId` is the SHA-256 of the canonical envelope with `receiptId` omitted.
The on-disk file is the canonical complete envelope followed by one newline.

The default root is `~/.pico-mcp/run-receipts`; hermetic tests may override it with
`PICO_MCP_RUN_RECEIPT_DIR`. Paths are:

```text
<root>/native-v1/<canonical-app>/<receiptId>.json
<root>/artifacts/apk/<apk-sha256>.apk
<root>/artifacts/spec/<effective-appspec-sha256>.json
<ledger-root>/artifacts/<capture-sha256>.png
```

Publication uses a same-directory unique staging file, descriptor flush, create-only atomic link,
and directory flush. A concurrent identical publisher may reuse an existing byte-identical object.
An existing target with different bytes is corruption and is never overwritten. A failed producer
does not replace or delete an earlier valid receipt.

## Reader contract

Receipt reading is fail-closed and returns either a validated receipt or explicit issues. It has
two named modes.

**Historical-core validation**:

- bounds each receipt to 2 MiB, parses it, and rejects an app directory with more than 4,096
  candidates rather than silently truncating it;
- rejects unknown kind/schema, malformed fields, non-canonical bytes, and a filename/ID mismatch;
- recomputes `receiptId` from canonical content;
- re-hashes the APK CAS, effective-AppSpec snapshot, and capture CAS;
- revalidates the capture CAS bytes, metadata, and image structure;
- requires every package/component/install/runtime/capture cross-field relationship to agree; and
- reports each missing or changed value without silently selecting a different artifact.

Historical-core validation can therefore prove that stored receipt, APK-CAS, effective-AppSpec
snapshot, and capture-CAS artifacts remain intact after a project moves.

**Current-project validation** first requires historical-core validation and then re-hashes the
receipt’s current APK source, bounded Gradle-input tree, authored AppSpec, and AGP output metadata.
It also requires the supplied project’s real path to equal the recorded project real path. This is
the mode used by `ship_checklist`.

A receipt is historical structural provenance, not a promise that its PID is still alive when
read later.

Readers scan only the canonical app directory, ignore no corrupt candidate silently, and select
the newest fully valid current match by `createdAt` with `receiptId` as the deterministic
tie-breaker.

## Fleet integration

`fleet_build` retains its high-level behavior but delegates the critical native run to the
producer. A per-brief result gains:

```json
{
  "receipt": {
    "status": "recorded",
    "receiptId": "...",
    "receiptPath": "...",
    "capturePath": "...",
    "captureSha256": "...",
    "evidenceType": "structural",
    "lookRequired": true
  }
}
```

`built` and `installed` are set only from checked producer outcomes. A brief is not concluded for
the top-level fleet status unless receipt production succeeds. The existing calibrated eye runs
only after receipt publication and receives the receipt-bound unique capture. An eye PASS may
record `auto_judged`, but that remains a separate producer event and never becomes
`vision_verified`.

Panel activity checks happen after the receipt’s stage capture, as they do today. V1 binds the
native stage launch and stage capture, not the later panel-time capture. A panel-structural route
may still receive a native receipt for its successfully installed foreground stage shell, but the
receipt proves neither panel readiness nor panel pixels.

## Ledger binding

`record_verification` receives a new optional `runReceiptId` for record actions. When present, the
server loads the canonical receipt for the same app and requires:

- a currently valid historical receipt core;
- an image-grounded evidence type;
- the supplied artifact bytes to equal the receipt capture SHA-256; and
- the materialized ledger capture SHA-256 to equal the same receipt capture SHA-256.

The ledger row stores only a validated binding:

```json
{
  "runReceipt": {
    "kind": "pico.native-run-receipt",
    "schemaVersion": 1,
    "receiptId": "...",
    "captureSha256": "..."
  }
}
```

Caller `extra` data cannot inject or overwrite this object. Retraction semantics remain unchanged.
A receipt-linked ledger row keeps the evidence class actually earned by its producer. In
particular:

- a receipt alone creates no ledger row;
- `structural` remains structural;
- `auto_judged` remains auto-judged and producer-only;
- `vision_verified` still requires an attestation describing the exact opened frame; and
- `device_verified` still requires the existing same-serial live hardware probe and cannot be
  earned from an emulator receipt.

A later source change may invalidate current ship binding without erasing the historical fact that
someone looked at an intact capture. The ledger therefore preserves visual evidence while the ship
reader independently rejects stale source/APK provenance.

## Ship-checklist behavior

For the native or hybrid-native lane, `ship_checklist` searches for a current matching V1 receipt.
It clears the existing “no verified build receipt” blocker only when:

1. the receipt passes current-source, current-APK, receipt, install, runtime, and capture integrity
   checks; and
2. `readLedger(app).effectiveEntries` contains an intact `vision_verified` row or qualifying
   positive `device_verified` row whose validated `runReceipt.receiptId` and capture SHA-256 equal
   that receipt.

Retracted rows, provenance-broken rows, unlinked rows, `structural`, `compiles`, `logcat`,
`built_for_headset`, `auto_judged`, and `usd_host_render` do not satisfy the LOOK gate.

V1 may add a ready item saying that the current debug APK bytes are bound to a successful
install/session and an exact looked capture. It does not clear the release APK/signing/store
blockers, so the overall production verdict may remain `NOT READY`. The checklist must name the
selected receipt ID and any failed integrity dimension.

## Error and recovery behavior

Every stage has a named failure class: source identity, build, APK resolution, APK inspection,
install, installed-byte identity, launch, PID, foreground, capture, CAS publication, or receipt
publication. External-command failures retain command, exit/timeout state, and a bounded output
tail. They are not diagnosed by guesswork.

The producer returns the completed stages and exact failure but publishes no receipt until all
mandatory observations are present. It can leave an unreferenced, immutable APK/spec/capture CAS
object from a run that failed at a later stage; a later identical run may safely reuse that object.
Staging paths are unique and removed in `finally`. Interrupted work cannot replace a valid CAS
object or receipt. Recovery never silently relaunches beyond the fleet’s one existing, disclosed
foreground-blocker recovery, never changes the requested package, and never weakens a receipt
requirement.

## Test strategy

Implementation follows red-green-refactor. Hermetic tests use temporary project, receipt, and
ledger roots plus injected command runners and capture bytes. The focused suite must prove:

- canonical AppSpec, effective AppSpec, source-manifest, receipt, APK, and capture identity;
- stable receipt IDs for identical canonical content and different IDs for every bound field;
- replacement of AppSpec/source, APK, package, install digest, serial, fingerprint, boot/session,
  PID/start identity, foreground observation, capture, or receipt breaks validation;
- build failure/timeout, unresolved or ambiguous APK, install failure, remote APK mismatch, launch
  failure, missing/restarted PID, foreground loss, invalid/missing capture, and publication
  corruption cannot mint a receipt;
- atomic create-only publication preserves an earlier valid receipt and leaves no published partial
  object;
- receipt creation alone leaves every ledger evidence bucket unchanged;
- `record_verification` rejects wrong-app, wrong-receipt, and wrong-capture links while preserving
  the actual evidence class for a valid link;
- retracted, broken, unlinked, automated, and structural rows cannot clear the ship LOOK gate;
- current source or APK drift blocks ship readiness even when historical visual evidence remains;
  and
- an intact matching receipt plus an intact receipt-linked LOOK row clears only the native receipt
  blocker, not release/store/hardware claims.

Focused tests must verify their RED state before production code is written. Final validation runs:

```text
npm run build
SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs
git diff --check
```

Any live emulator run is reported separately with its exact serial, observed fingerprint, SDK,
receipt ID, and capture path. A rendered LOOK claim is reported only after opening and judging that
exact receipt-bound image. macOS fixtures do not establish native-Windows behavior, and no Swan or
hardware claim is inferred.

## Acceptance mapping

- **AppSpec/source bound:** three explicit source identities; current re-hash required by ship.
- **APK bound:** AGP-selected immutable bytes, local and CAS hashes, optional inspected metadata.
- **Install bound:** positive install acknowledgement plus remote installed-APK hash equality.
- **Package bound:** effective spec, AGP metadata, optional APK inspection, installed package,
  component, and foreground observations agree.
- **Device/session/PID bound:** serial, fingerprint, boot identity, UUID session, PID, and process
  start identity are in the receipt ID.
- **Foreground bound:** matching observations bracket the captured bytes.
- **Capture bound:** validated in-memory PNG bytes are stored in ledger CAS and re-hashed on read.
- **No visual promotion:** receipt output and persistence are structural; only a separate exact-frame
  LOOK can create `vision_verified`.
- **Ship fails closed:** current bytes require both a valid receipt and a matching intact effective
  LOOK row.
