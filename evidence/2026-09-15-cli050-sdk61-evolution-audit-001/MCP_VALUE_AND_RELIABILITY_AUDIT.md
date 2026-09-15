# MCP value and reliability audit

Date: 2026-09-15. Source baseline supplied by root: `308c898e`.

Scope: read-only source audit for a future implementation handoff. This audit performed no production edits, builds, tests, CLI execution, registry requests or device operations. Mission Replay remains paused. The line references below identify this source baseline; they are not runtime verification.

Root subsequently confirmed that npm registry latest is CLI `0.5.0`, published `2026-09-10T04:15:42.541Z`, and downloaded the `0.4.4` and `0.5.0` tarballs with verified SHA-512 integrity. Those are root's separate acquisition findings. This report makes no new CLI feature or runtime-compatibility claim from that version information.

## Recommended role

The MCP's strongest role remains workflow orchestration, exact SDK knowledge, retained diagnostics and evidence integrity around official CLI operations. Adding one MCP tool for every CLI command would add maintenance and tool-selection cost without comparable value.

| Capability | Delegate to CLI | Retain or strengthen in MCP |
| --- | --- | --- |
| Package installation, launch, crash watching, recording | Prefer confirmed official CLI command contracts; adapt existing wrappers to the new version. | Explicit target selection, bounded execution, immutable artifacts, process/session continuity and scoped conclusions. |
| Performance sampling and diagnosis | Existing `perf monitor run` integration already delegates measurement and diagnosis: `src/perfcli.ts:63–145`. | Acceptance thresholds, before/after comparisons and missing-measurement handling: `src/doors.ts:985–1015`. Preserve the distinction between app FPS and system/compositor FPS. |
| Environment/package health | CLI supplies its own package/utility state where confirmed. | Aggregate Android/JDK/build payloads, host visibility, calibration, install identity and actionable failures. Keep the default doctor read-only. |
| SDK discovery and lookup | Use new CLI SDK discovery or knowledge facilities only after confirming actual contracts. | Exact installed declaration provenance, selected project SDK version, version mismatch disclosure and retained SDK lessons. `pico_sdk` currently advertises vault `0.13.3` and skeleton `6.0.0` at `src/doors.ts:475`. |
| Capture and visual verification | CLI produces capture artifacts where its output surface is appropriate. | Decode and validate artifacts, bind exact bytes to the observed run, distinguish shell/host/immersive views, require a LOOK and retain negative evidence. |
| Build and repair orchestration | CLI handles authoritative underlying build operations where suitable. | Two-step authored AppSpec, bounded repairs, failure classification, receipts, shipping scope and incomplete-state handling. |
| Emulator lifecycle | Use current official lifecycle commands after compatibility checks. | User constraints, visibility/health gates and honest diagnostic guidance. Do not broaden implicit recovery mutations. |

The matrix intentionally leaves new CLI capability adoption conditional on the separate package/help investigation. It does not assume that CLI `0.5.0` replaces any current MCP observation or validation requirement.

## Five bounded improvements

### 1. Refresh existing CLI adapters against the confirmed new contract

Priority: compatibility prerequisite.

`src/picoclitools.ts:12–20`, `117`, `204` and `src/perfcli.ts:104` retain verification claims from CLI `0.3.0`/`0.4.2`. Compare the new help and output with current explicit argv; update only changed behavior. Preserve `src/picocli.ts:650–661` execution integrity and bounded process settlement.

The current wrappers provide useful evidence boundaries already:

- `src/picoclitools.ts:88–127` distinguishes acquisition/invocation failures and returns provenance and the CLI's own output.
- `src/picoclitools.ts:216–241` checks that a recording is a nonempty regular file rather than accepting exit zero alone.
- `src/perfcli.ts:118–145` requires a parseable report and returns a bounded selection of jank windows plus the persisted report path.
- `src/perfcli.ts:156–171` distinguishes unavailable app-frame counters from a failed performance target.

Acceptance:

- Retain version-specific fixtures for supported commands and relevant malformed, error and partial outputs.
- Run existing wrapper suites after rebuilding `dist`.
- No optimistic fallback when a response shape or flag drifts.
- New CLI capabilities enter the matrix only after their actual contract is confirmed.
- Keep raw report paths available while summaries remain bounded.

Measure command compatibility and adapter failures directly. Do not assert semantic compatibility from help-only compatibility or a version string.

### 2. Unify package-targeted observation for external APK verification

Priority: evidence correctness and removal of surprising side effects.

`pico_verify_app` promises calibrated-eye judgment at `src/doors.ts:442`, but `verify_pico_apk` performs no eye judgment or receipt publication. Its actual path is an install, launch, process/log check and screenshot.

Concrete source findings:

- `src/verifyapk.ts:11–12` hardcodes legacy ADB and `emulator-5554`.
- `src/verifyapk.ts:64` clears global logcat.
- `src/verifyapk.ts:110` treats any global `FATAL` token as a crash without package attribution.
- `src/verifyapk.ts:131` can stop a foreign foreground incumbent.
- `src/verifyapk.ts:149–155` overwrites `/tmp/pico-render/verifyapk/<package>.png`; capture validation is only a byte-length check greater than 1,000.
- `src/verifyapk.ts:161` can return `status:ok` even when capture failed, because its status expression tests install, launch, process existence and crash detection only.

The stronger fleet-native implementation already observes installed digest (`src/nativefleetreceipt.ts:568–609`), boot identity (`638–652`), PID/start-time and foreground continuity (`851` onward) and immutable capture publication (`998–1011`). Extract shared target/session/capture observations while preserving the stronger behavior.

Do not fabricate a fleet build receipt for an externally built APK. Current receipt scope is explicitly `fleet-native-debug` in `src/runreceiptstore.ts:24`, and its producer requires a brief, effective spec, project and build task (`src/nativefleetreceipt.ts:45–55`). An external APK route needs an honestly separate observation scope. Sharing validation helpers does not justify claiming unobserved build inputs.

The hardware deploy route is a further consolidation candidate, not proof that hardware has been exercised. `src/deploy.ts:90–114` already checks PID continuity before and after capture and validates image bytes; `116–119` scopes the claim to process health and distinguishes unavailable capture. Keep its explicit PICO device identity gate.

Acceptance:

- Invalid PNG, wrong APK, foreign foreground, changed boot/PID/start-time and capture substitution all fail closed.
- Repeated runs preserve different immutable artifacts.
- Ordinary verification neither stops foreign processes nor clears global logcat.
- A capture failure remains visibly distinct from a run with an admitted capture.
- External APK observations cannot clear fleet build, release or hardware claims.
- Update the existing test that explicitly requires foreign incumbent termination (`test/doors.mjs:731–748`) to exercise the changed, explicit behavior and the protected default.

Success measures: zero false app attribution in injected failure cases; no overwritten evidence across repeated runs; one reusable observation core rather than independently drifting checks. Do not reduce required identity observations merely to lower latency.

### 3. Make doors initialization single-flight and preserve typed inner results

Priority: bounded orchestration reliability and host cost.

`inner()` tests its cache at `src/doors.ts:244`, waits for `client.connect` at `264`, then stores the cache at `276`. Concurrent first calls can therefore create multiple full servers. This is a source-derived race risk, not a reproduced live incident in this audit.

Its adapter retains only text at `src/doors.ts:267–269`, discarding `structuredContent`, `isError` and non-text content blocks. Registered doors then return `okJson` at `335`, and exceptions become a JSON `status:error` payload at `337`. Preserve the distinctions that downstream callers need when adapting this boundary; do not silently reinterpret failure or discard artifact content.

Existing tests demonstrate sequential reuse only (`test/doors.mjs:482–495`). Add a concurrent cold-start regression and use the existing injected dependencies where appropriate.

Acceptance:

- Concurrent cold calls create exactly one child.
- Failed initialization clears the pending state; a later retry works.
- Structured success, structured failure, text-only failure and image/resource results preserve their distinctions.
- Existing door response consumers keep a deliberate compatible shape or receive an explicitly documented migration.
- No extra tools are needed to repair this orchestration boundary.

Success measures: one inner process under concurrent first use; cold/warm latency, process count and serialized response bytes recorded before and after. Set an optimization target only after measuring the baseline; do not invent a percentage speedup.

### 4. Report actual diagnostic coverage and preserve bounded raw evidence

Priority: truthful duration and inspectable diagnostic evidence.

`watch_crash` accepts an early clean CLI exit at `src/picoclitools.ts:107–109` but reports the requested duration as `watchedSec` at `133`. A one-second clean exit can therefore return `watchedSec:30`; `endedBy` distinguishes CLI exit, but the duration field itself does not report observed elapsed time.

The keyword scan operates on captured output, with truncation honestly disclosed at `src/picoclitools.ts:139–141`. Add actual elapsed coverage and a retained output artifact/digest so users can examine the underlying observation without enlarging every MCP response.

Acceptance:

- Early exit never presents the full requested window as observed.
- Timeout, forced settlement, failure and truncated output remain distinct.
- A marker outside the returned tail is either found in retained complete evidence or explicitly unassessed.
- Output summaries remain bounded regardless of raw log volume.
- The output identifies actual start/end observation bounds and requested duration separately.

Success measures: elapsed-window assertions against a controlled fake CLI; complete versus partial scan attribution; bounded response byte count; original output retained without rewriting. A quiet bounded observation must never become a continuous crash-free claim.

### 5. Consolidate capture attribution and wording around measured behavior

Priority: capture correctness; prerequisite to evaluating a new CLI capture route.

`src/capture.ts:37` labels ADB capture as the rendered immersive frame generally. `src/verifyapk.ts:184` still says immersive applications return black, while that module's introduction records contrary observations at `23–25`. `capture_record` checks only nonempty regular-file existence (`src/picoclitools.ts:216–241`), which is correctly qualified in its result but insufficient to establish a valid playable recording.

Keep platform-specific capture routes, and share artifact validation and attribution. Replace universal capture claims with the observed capture source and explicit limits. If the new CLI provides a better capture route, adopt it only after checking the relevant renderer/runtime combination. A CLI-produced shell capture and a host-window capture must not become interchangeable evidence merely because both are PNG files.

Acceptance:

- Invalid containers do not become successful validated recordings.
- Valid black images remain inconclusive rather than rendering failures.
- Every artifact identifies its capture source, dimensions/duration when validated, digest and LOOK obligation.
- No visual evidence tier is created automatically from command success.
- Existing capture-producing entry points use consistent qualification of shell, host and immersive views.

Success measures: known-valid/invalid image and video fixtures classified accurately; no universal black-frame inference; bounded metadata output with retained original artifacts. Native visual acceptance remains a separate step when authorized and healthy.

## Protections to preserve

The ledger's strongest protections provide substantive MCP value beyond CLI command access:

- Immutable looked-at captures: `src/ledger.ts:520` onward.
- Rejection of caller-invented hardware provenance: `src/ledger.ts:633–667`.
- Same-serial live capture comparison: `src/ledger.ts:880–892`.
- Append-only correction/retraction semantics: `src/ledger.ts:918` onward.
- Receipt-linked shipping scope: `src/doors.ts:524–533`.
- Distinct measured machine judgment and caller LOOK obligations: `src/doors.ts:303–317`, `371–378` and `src/eye.ts:25–43`.

Consolidation must not weaken these boundaries or reinterpret prior evidence under a stronger tier. The future implementation should prove its improvements with targeted fixtures and measured output/process behavior, then perform separately scoped native validation where authorized. This audit itself supplies source findings and an implementation plan, not those acceptance results.
