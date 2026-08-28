# Receipt/Ledger Portability Design

**Status:** design only; no source, receipt, ledger, or emulator changes

**Base:** `main` at `3c3ba58552d045935be3452a2756dc0b3d0a2c28`
**Decision:** preserve native receipt v1 unchanged. Add an explicit `PROMOTE` that emits a new,
path-free relocatable lineage projection and a hash-bound audit manifest after copying and
re-hashing every CAS object. Promotion never creates ledger evidence.

## Defect and invariants

Receipt v1 hashes every payload field into `receiptId` (`src/runreceiptstore.ts:605-617`), including
the absolute ledger CAS path. Historical validation derives
`<current-ledger-root>/artifacts/<capture-sha>.png` (`src/runreceiptstore.ts:674-675`), requires the
stored string to equal it, and validates only that derived path (`src/runreceiptstore.ts:798-808`).
`record_verification` resolves the receipt before `appendLedgerEntry` materializes the submitted
capture (`src/ledger.ts:1214-1231` versus `src/ledger.ts:619-639`). A receipt born under a session
`PICO_MCP_LEDGER_DIR` therefore fails under the default root with the observed pair of errors:
`capture artifactPath is not the exact ledger CAS path` and `capture CAS could not be validated`.

The repair must retain these trust properties:

- a caller cannot manufacture a trusted binding; the resolver must still mint the private
  capability and final ledger materialization must recheck the capture hash;
- receipt validation re-hashes canonical receipt bytes, APK, effective AppSpec, and structurally
  valid PNG bytes, including size/dimensions and all v1 cross-field bindings;
- a receipt never creates or upgrades `structural`, `auto_judged`, `vision_verified`, or
  `device_verified` evidence; device evidence still requires the live same-serial recapture;
- reads remain fail-closed, source history is never edited, and a failed transfer may leave only
  unreferenced immutable target objects; and
- a v1 `receiptId` always retains exactly its current absolute-path meaning.

## Options

| Option | Benefit | Cost / trust consequence |
| --- | --- | --- |
| 1. Native receipt v2 with root-relative CAS paths | One receipt can resolve below different configured roots after its bytes are copied. | This is a schema change, not a legal v1 relaxation. It provides no transfer audit and does not by itself fix the pre-materialize ordering. |
| 2. `PROMOTE` sidecar authorizes a new root for the original v1 ID | Existing ID and payload stay byte-identical; transfer is explicit and auditable. | The same v1 ID gains two validation meanings (native exact path versus sidecar-authorized path), making every consumer and diagnostic context-sensitive. |
| 3. `PROMOTE` emits a new relocatable projection ID (recommended) | V1 semantics stay immutable; the new identity honestly names derived provenance; every target byte and the transfer are revalidated. | Adds a derived schema, promotion manifest, normalized reader result, and versioned ledger/reference unions. |

### Option 1: root-relative native receipt v2

Never accept relative paths in v1: rewriting any v1 field changes its ID, while retaining the old ID
fails recomputation (`src/runreceiptstore.ts:763-767`). A v2 would use canonical POSIX strings for
only store-owned objects:

```text
source.effectiveAppSpec.artifactPath = artifacts/spec/<sha>.json
apk.artifactPath                     = artifacts/apk/<sha>.apk
capture.artifactPath                 = artifacts/<sha>.png
```

Each value must equal that exact grammar: no absolute path, empty segment, `.`, `..`, backslash,
alternate extension, normalization, or caller-selected subdirectory. Mutable provenance paths
(`projectDir`, authored spec, APK source, metadata, and unique source capture) remain historical or
current-project fields, not CAS locators. Store v2 below `native-v2/`; retain `native-v1/` and its
strict reader. Since APIs receive only `(app, receiptId)`, a unified lookup must search both bounded
directories, reject duplicate IDs/ambiguous files, and preserve the combined 4,096-candidate cap.

Root relativity alone is insufficient: the target CAS is absent when the resolver runs. The record
path would also have to snapshot the submitted image once, atomically materialize those exact bytes
in the current CAS, then resolve and bind the receipt, leaving at most an orphan CAS object on
rejection. This is content-safe but makes relocation implicit and unaudited.

Choosing v2 would also require a v1/v2 ledger-binding union, kind-aware report revalidation,
historical/current selection in `pico_next` and ship, and a new run-revision receipt-reference
version; public `receiptPath`/capture outputs remain resolved absolute paths. Root-relative CAS does
not make a moved project current: ship would still require the current project/source/APK/metadata
checks. A hybrid native-v2-plus-audit design must additionally distinguish native origin from
transfer; the separate derived kind below makes that provenance explicit.

### Option 2: sidecar promotion of v1

`PROMOTE` can validate v1 under explicit source receipt/ledger roots, copy all objects to explicit
target roots, and publish a manifest authorizing the original ID at the target. The source stays
unchanged and later reads require both the original receipt and manifest.

This preserves the old ID but weakens identity clarity: a normal v1 read says the absolute
`capture.artifactPath` is authoritative, while a promoted read must deliberately ignore it and use
the sidecar's target object. A missing sidecar, wrong target root, or old server makes the same ID
invalid again. This option is acceptable only if compatibility forbids a new receipt ID.

### Option 3: audited, path-free relocatable lineage projection

Use `PROMOTE`, but publish a distinct `pico.portable-native-run-receipt` v1 instead of changing the
meaning of `pico.native-run-receipt` v1. The portable receipt is canonical JSON whose `receiptId` is
the domain-separated SHA-256 of its strict payload without `receiptId`. It contains no evidence class, LOOK, device
claim, or equivalence to an existing ledger row. These are the exact strict shapes (`Sha256` is 64
lowercase hex; `RootIdentity` is `{realPath,deviceId,inode}`):

```text
PortableReceipt = {
  kind:"pico.portable-native-run-receipt", schemaVersion:1, receiptId:Sha256, app:string,
  sourceReceipt:{kind:"pico.native-run-receipt", schemaVersion:1,
                 receiptId:Sha256, fileSha256:Sha256},
  artifacts:{
    apk:{store:"receipt", algorithm:"sha256", sha256:Sha256, bytes:int},
    effectiveAppSpec:{store:"receipt", algorithm:"sha256", sha256:Sha256, bytes:int},
    capture:{store:"ledger", algorithm:"sha256", sha256:Sha256, bytes:int,
             width:int, height:int, format:"png"}
  }
}
PromotionManifest = {
  kind:"pico.run-receipt-promotion", schemaVersion:1,
  promotionId:Sha256, auditId:Sha256,
  core:{app:string, portableReceiptId:Sha256, sourceReceiptId:Sha256,
        sourceRoots:{receipt:RootIdentity, ledger:RootIdentity},
        targetRoots:{receipt:RootIdentity, ledger:RootIdentity}, artifacts:PortableReceipt.artifacts},
  recordedAt:ISO8601, toolVersion:string
}
NativeLedgerBinding = {
  kind:"pico.native-run-receipt", schemaVersion:1,
  receiptId:Sha256, captureSha256:Sha256
}
PortableLedgerBinding = {
  kind:"pico.portable-native-run-receipt", schemaVersion:1,
  receiptId:Sha256, sourceReceiptId:Sha256, promotionId:Sha256,
  auditId:Sha256, captureSha256:Sha256
}
```

No extra keys are accepted. `deviceId`/`inode` are unsigned base-10 with no leading zero except `0`;
`realPath` is the resolved absolute POSIX path with no trailing slash except `/` (which is rejected as
a store root). `recordedAt` is exactly `YYYY-MM-DDTHH:mm:ss.sssZ`; non-caller `toolVersion` is at most
64 ASCII characters matching `^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`. Receipt/lineage files
retain the 2 MiB bound; manifests are at most 64 KiB and contain exactly three artifact roles with
the existing APK/spec/capture bounds.

Hash preimages are UTF-8 bytes of the literal domain, one NUL byte, then `canonicalJson(value)`:
portable ID uses domain `pico.portable-native-run-receipt/v1` and the strict receipt without
`receiptId`; promotion ID uses `pico.run-receipt-promotion-core/v1` and `core`; audit ID uses
`pico.run-receipt-promotion-audit/v1` and `{promotionId,recordedAt,toolVersion}`. The first
create-only writer fixes timestamp/audit ID at the deterministic promotion-ID path; exact rerun
validates and returns it rather than minting another.

Exact paths are:
`<receiptRoot>/portable-lineage-v1/<app>/<sourceReceiptId>.json`,
`<receiptRoot>/portable-v1/<app>/<portableReceiptId>.json`, and
`<receiptRoot>/promotions-v1/<app>/<promotionId>.json`; APK/spec/capture retain their existing
digest paths. The unchanged lineage copy never enters `native-v1/`.
The portable ID nevertheless commits transitively to the absolute locators inside the source v1 ID;
it is a relocatable lineage identity, not root-independent content deduplication.

`record_verification`/`pico_record` retain `runReceiptId` and add optional
`runReceiptPromotionId`. Native v1 uses only the former; a portable receipt requires both. A
promotion ID without a receipt ID, a promotion ID with native v1, a portable ID without its matching
promotion ID, cross-kind fallback, and any source/artifact mismatch are rejected. The resolver adds
`auditId` to the exact binding above. Existing four-field native-v1 bindings remain unchanged.

The internal contracts are strict discriminated unions. `ReceiptSelector` is either
`{kind:"pico.native-run-receipt",schemaVersion:1,receiptId}` or
`{kind:"pico.portable-native-run-receipt",schemaVersion:1,receiptId,promotionId}`. The record
resolver receives `(app, selector, artifactPath)` and returns
`{status:"valid",binding:NativeLedgerBinding|PortableLedgerBinding,receiptRuntime}` or an invalid
reason; no normalized optional-field object is accepted. The report validator receives
`(app, claimedBinding, artifactPath)`, where `claimedBinding` is the complete strict binding union,
and must return the same union member with every field byte-equal. Report parsing first validates the
persisted exact shape, then compares every returned binding field and the ledger capture hash before
preserving linkage. Only a resolver result held in the private capability can reach append.

Because `PROMOTE` commits the target capture before a record attempt, portable resolution can retain
today's resolve-before-append order: the resolver validates the target CAS, and append then checks
that the supplied/materialized bytes have the same digest.

This option best preserves the trust model: it does not relax a single v1 acceptance rule, it makes
the derivation visible in the identity and ledger binding, and it requires durable target bytes plus
an audit record before the receipt is usable.

## Exact `PROMOTE` and read rules

`PROMOTE({app, sourceReceiptId, sourceReceiptRoot, sourceLedgerRoot, targetReceiptRoot,
targetLedgerRoot})` is the only writer for the three portable namespaces. It is never implicit in
`record_verification`, and it returns the portable/promotion/audit IDs plus target-resolved paths.

1. Require `app` to match both the source receipt and
   `^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$`, one source native-v1 ID, and explicit source/target
   receipt and ledger roots. All four roots must already exist; promotion never provisions them. Each
   supplied absolute path must equal its resolved path. Walk it descriptor-relative from the platform
   anchor, reject a symlink at any component, keep the directory open, and record real path/device/inode.
   Source and target ledger roots must differ. Source/target receipt roots may be exactly identical;
   every other equality or non-equal ancestor/descendant relationship among the four roots is rejected.
   Recheck descriptor identity through manifest commit. Never infer a source root from a receipt.
2. Run the unchanged historical native-v1 validator with the explicit source roots. Additionally
   snapshot the capture through `O_NOFOLLOW` (current `readCaptureBytes` follows a final symlink),
   validate the in-memory PNG, and match hash, bytes, dimensions, and format. Snapshot APK, spec, and
   receipt through bounded, descriptor-relative, no-follow reads with before/after identity checks;
   stream the APK. A portable receipt is not a legal source in this schema version.
3. Recompute the v1 receipt ID and receipt-file hash. Re-run schema strictness, canonical newline,
   effective-spec canonical identity, package/install/APK bindings, chronology, and runtime/capture
   continuity. Promotion is historical-core only; it cannot claim that project files or a process
   are current.
4. Derive every target CAS name from its role and verified digest. Walk or create every descendant
   component relative to pinned directory descriptors (`openat`/`mkdirat` semantics), rejecting
   symlinks and non-directories at every hop; never reopen a validated child by an absolute path.
   Create and flush an exclusive no-follow temporary in the final directory, publish it with a
   create-only descriptor-relative hard link (`linkat` semantics), then flush that directory.
   Ordinary rename is prohibited because it can overwrite. Keep and re-`fstat` all traversed
   directory descriptors through publication. If the runtime/platform cannot provide these measured
   no-follow, descriptor-relative, no-overwrite primitives, `PROMOTE` is unavailable and fails closed.
   Re-hash and re-parse every final target; an existing mismatch is corruption, never overwritten.
5. Publish in dependency order: target CAS objects, unchanged source-receipt lineage copy, portable
   receipt, then promotion manifest as the commit marker. Until the final manifest is valid, readers
   reject the portable receipt. The manifest path is its deterministic `promotionId`; racing or exact
   repeat publishers must revalidate/reuse it. Interruption may leave only unreferenced immutable
   objects. V1 promotion is deliberately one hop: promoting a portable receipt is rejected rather
   than silently creating a provenance chain with underspecified identity or availability rules.
   Each lineage, portable, and manifest file must be exactly `canonicalJson(parsed) + "\n"`; reject
   duplicate-key or other noncanonical encodings. Success requires reopening the final files and
   recomputing file hashes, embedded/filename IDs, `promotionId`, and `auditId`.
6. Never change pre-existing source file bytes/metadata or rename/delete source objects. In a shared
   receipt root, create only the disjoint target namespaces; the root directory's metadata change is
   the disclosed exception. Do not copy ledger events, synthesize an attestation, relink an old LOOK,
   or call `record_verification`. Exact rerun is idempotent only after every target revalidates.
7. The original roots are authoritative only during promotion. Later portable historical reads never
   reopen them. Using the same pinned-descriptor rules, require requested IDs, fields, filenames, and
   `app` to agree; verify canonical bytes/newlines, strict schemas, all three domain-separated IDs,
   and the copied v1 file hash/ID. Its three stored CAS locator strings must still equal the exact
   paths derived from the manifest's recorded source roots and v1 digests, but are not dereferenced.
   Re-hash/re-parse the target APK, effective spec, and capture; match every receipt, portable, and
   manifest digest/size/dimension/format field; then rerun every v1 chronology, schema, and cross-field
   predicate. Mutable historical provenance strings remain hash-bound but are not reopened, just as
   native historical mode never reopens them. Require the manifest target identities to equal the
   current target roots. Later original-source deletion or drift is irrelevant; lineage, manifest,
   or target drift fails closed. Any defect strips the binding in derived output exactly as today
   while intact independent image evidence keeps its earned class.
8. Binding still requires the submitted image snapshot SHA-256 and the final target ledger capture
   SHA-256 to equal both source and portable capture identities. The resolver returns a private
   capability; the ledger rechecks it after materialization. `device_verified` still live-probes the
   same non-emulator identity and requires byte-identical recapture.
9. Portable v1 is historical/report/record provenance only. `findCurrentNativeRunReceipt` and
   `ship_checklist` do not select it, because current validation reopens the original project,
   authored spec, source APK, and AGP metadata paths (`src/runreceiptstore.ts:822-897`). Designing a
   target-project remap is separate work. Promotion clears no current-build, release, signing,
   hardware, store, or LOOK boundary.
10. Keep the existing 4,096 native-candidate limit; separately cap portable receipts and manifests
    at 4,096 each and all three scanned namespaces at 12,288 total. Report every malformed candidate.
    Historical selection groups by source native ID: a valid native receipt at the current roots wins
    over its projections; otherwise exactly one valid projection may match the current target root.
    Multiple matches are an invalid-store ambiguity. Across groups, preserve `createdAt` descending
    then source receipt ID ascending. Record uses explicit IDs and never falls back between kinds.

## Back-compat and reader enumeration

| Reader / consumer | Existing behavior that must remain | Portable addition |
| --- | --- | --- |
| `src/runreceiptstore.ts:733-810,899-907` | Historical/current v1 parsing, absolute exact-path checks, canonical ID, CAS and cross-field validation. | Separate historical-only portable parser/validator; do not add a v1 fallback. |
| `src/runreceiptstore.ts:910-995` | `findHistorical`, `findCurrent`, and capture binding scan/resolve v1 exactly. | Historical search includes the bounded portable namespace; current selection remains native-v1-only. Normalize only after kind-specific validation. |
| `src/index.ts:305-308`; `src/ledger.ts:976-1092,1203-1231` | Full-surface record and report revalidate native-v1 bindings and strip invalid persisted bindings. | Version-discriminated portable binding requiring `promotionId`; retain private capability and hash recheck. |
| `src/doors.ts:670,688-733` | `pico_next` revalidates ledger bindings and selects a historical receipt; `pico_record` delegates to the full record tool. | Return target-resolved absolute paths plus both portable/promotion IDs. |
| `src/ship.ts:71,100-138` | Revalidate ledger rows, select current v1 bytes, and require an exact linked positive LOOK. | Revalidate portable ledger bindings for honest reporting, but never use a portable candidate to clear current native readiness. |
| `src/claimspage.ts:55`; `src/eval.ts:34`; `src/capabilityreport.ts:56`; `src/factory.ts:44`; `src/swanparity.ts:57` | Call `readLedger` without a receipt validator, so linkage is deliberately stripped while independently intact image evidence remains usable. | Continue stripping both native and portable linkage. Test that portable-only fields do not leak and public summaries remain compatible. |
| `src/nativefleetreceipt.ts:922-999` | Materialize CAS objects before publishing a native-v1 receipt. This is a producer, not a persisted-receipt reader. | Keep producer output native v1; portable files can be authored only by explicit `PROMOTE`. |
| `src/fleetbuild.ts:150-175`; `src/doors.ts:351-366` | Consume/return the producer's in-memory receipt ID, receipt path, and capture path. | Keep public paths absolute resolved outputs; do not put them into portable identity. Native producer remains v1 in this change. |
| `src/runrevisiontypes.ts:940-978,1009-1031,1284-1354`; `src/runlocks.ts:2289-2312` | Persisted public receipt triples require absolute paths; run-revision v1 receipt refs require native schema v1 and recovery parses them read-only. | Leave `RunRevisionV1` byte/schema semantics unchanged; add a new versioned portable ref/revision before persisting portable IDs. |
| `test/runreceipt-store.mjs`, `test/nativefleetreceipt.mjs`, `test/runreceipt-ledger.mjs`, `test/runreceipt-ship.mjs` | Direct v1 reader, producer, ledger, and ship compatibility corpus. | Add two-root promotion, corruption, partial-publication, selection, binding, and portable-ship rejection cases. |
| `test/fleetreceipt.mjs`, `test/semanticplace.mjs`, `test/runrevision-contracts.mjs` | Public receipt summaries and strict persisted reference/triple contracts. | Prove old fixtures remain byte-valid and new portable references require their new version. |

Every existing native-v1 receipt, filename, ID, absolute path, ledger binding, public result, and run
revision remains readable under its original rules when its original configured roots remain
available. Promotion creates new target files, a new portable ID, and an explicit `sourceReceiptId`;
it never rewrites an old receipt or silently treats an old LOOK as linked to the new ID. Older
servers do not recognize the portable kind/version but continue to read all old data.

## Required future tests

- Reproduce the supplied two-root rejection, then show promotion plus an explicit subsequent record
  succeeds while every pre-existing source object hash remains unchanged.
- Corrupt each source/target artifact, receipt, manifest field, ID, root binding, and final CAS name;
  each case must fail closed. Cover symlinks, traversal, duplicate IDs, root aliases, limits, races,
  child-directory symlink swaps, existing-target collisions, and interruption before every
  publication boundary.
- Prove promotion alone writes no ledger row and earns no evidence. Prove wrong capture, caller-made
  binding, device mismatch, broken target provenance, and retraction retain today's behavior. After
  commit, deleting/drifting original roots must not break historical reads; lineage/target drift must.
- Prove exact rerun returns the first manifest, competing/double manifests fail ambiguity checks,
  a portable source is explicitly rejected, and portable receipts never clear ship.
- Run all existing receipt/ledger/ship/revision suites against untouched v1 fixtures. Add a clean
  Windows test rather than treating POSIX `fsync`/no-follow behavior as established there.

## Unverified assumptions

- The supplied error and cited code establish the defect; no golden-wave receipt, ledger, or CAS
  file was inspected because those files are explicitly out of scope.
- “Promote a receipt + its CAS artifacts” is assumed to include the APK and effective-AppSpec CAS in
  the receipt root plus the capture CAS in the ledger root, but not ledger events.
- Source roots and all source artifacts are assumed to remain available for the first promotion.
- V1 promotion is assumed to need only the native-v1-source-to-target case. Recursive export of a
  portable projection is future design work, not an implicit manifest-chain feature.
- Real path plus device/inode is the proposed root identity; stability across remounts and filesystems
  with weak inode semantics is unverified. A stable per-root UUID has no designed lifecycle.
- The current local trust model has no signature or authenticated producer; it excludes an attacker
  able to rewrite receipt, CAS, and audit data consistently. Promotion cannot add authenticity that
  native v1 does not possess.
- SHA-256 collision resistance, create-only local filesystem semantics, and POSIX directory durability
  are assumed. A native helper or equivalent platform abstraction may be required because the needed
  descriptor-relative operations are not established for the current runtime. Native Windows and
  network/removable filesystems are unverified.
- Promotion intentionally rejects symlink-backed roots/captures, so a symlink that current v1 accepts
  is unpromotable. This is a security tightening and compatibility limitation, not native-v1 evidence.
- Whether later native producers should emit path-free receipts directly is a separate migration;
  this design keeps producer output v1 and uses the portable kind only for sanctioned promotion.
