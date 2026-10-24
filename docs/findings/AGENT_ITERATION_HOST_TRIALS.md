# Agent iteration host trials

These trials exercise installed agent hosts against an isolated, read-only conformance adapter in the candidate checkout. They do not activate the candidate in an installed host, operate an emulator, or extend the earlier native acceptance. The retained frame is the source-revision-3 recapture from [the native run](AGENT_ITERATION_NATIVE.md).

The adapter launches the actual candidate stdio server with a private fixture home, an empty tools directory, CLI operations disabled and the missing-file ADB sentinel. It exposes the candidate's original `pico_doctor` and `pico_interaction` schemas, but forwards only `pico_doctor {}` and `pico_interaction {"action":"describe"}`. Every other argument combination is refused before forwarding. A separate `host_probe` tool supplies a connection identity, an intentional error, a bounded wait, and historical PNG delivery through the production `interactionToolResult` formatter. The image's expected visible labels are absent from the prompt and response metadata.

This is admission through a restricted adapter, not acceptance of unrestricted candidate tools. A model's correct transcription demonstrates consumption of an inline historical image. It does not demonstrate a fresh capture, a human-visible host image viewer, physical input, or simulator parity.

## Results

| Host | Discovery, calls and image | Cancellation | Reconnect and consent |
| --- | --- | --- | --- |
| Codex CLI 0.164.0 | Initial default headless policy rejected doctor/describe; identity, intentional error and historical image passed. Two later runs with scoped invocation preapproval passed all five calls and correctly transcribed the image. | Leader-only SIGINT after `wait_started` closed the transport and aborted the handler. No `notifications/cancelled` arrived. Host exited 1; this is retained as the interrupted outcome. | A fresh host session after interruption succeeded with a new probe generation. Same-process reconnect and interactive consent remain unverified. |
| Claude Code 2.1.288 | All five calls passed after exact allow-once SDK permission replies. The selected model (`claude-opus-5-5`) correctly transcribed the historical image. | The normal SDK interrupt produced a matching MCP cancellation notification and handler cancellation after the wait started. | `mcp_reconnect` in the same host process produced a new initialization, generation and PID, followed by successful identity/describe. Per-call SDK consent ran; print mode does not exercise interactive workspace trust. |
| Gemini CLI 0.64.0 | Displayed the normal scratch-folder trust prompt. Existing Google sign-in was rejected as an unsupported client. Root stopped the session; zero tool calls. | Not runtime-tested. | Trust prompt was displayed but not accepted. Discovery, image consumption and reconnect remain unverified. No account migration or new login was attempted. |

[HOST_RESULTS.json](../../evidence/2026-10-24-agent-iteration-hosts/HOST_RESULTS.json) binds every run to its invocation, events, probe generations and image hashes. Root opened the same PNG and checked the transcribed labels. This is model/image-consumption evidence; no human host image viewer was visually inspected. The transcripts contain only the intended MCP calls and no filesystem/image fallback. Selected execution features were disabled, but Codex's metadata includes `node_repl_disabled:false`, so the report does not claim every possible built-in execution route was disabled.

The first Codex trial retains [host events](../../evidence/2026-10-24-agent-iteration-hosts/codex-01/host-events.jsonl), [the exact invocation](../../evidence/2026-10-24-agent-iteration-hosts/codex-01/invocation.json), and [its result](../../evidence/2026-10-24-agent-iteration-hosts/codex-01/result.json). The recorded error is `MCP tool call requires approval, but approval policy is never`. The broad candidate schemas correctly remain subject to host permission checks even when the adapter enforces a read-only subset.

The later Codex `approved` trials use two invocation-only `approval_mode="approve"` overrides behind the adapter's exact argument checks. These overrides are not added to the production host template. Their success establishes scoped preapproval, not interactive consent or approval for unrestricted mutation tools.

Claude's lifecycle-run prose incorrectly said the wait never started. The wire records are authoritative: request 3 started, `notifications/cancelled` arrived, and the handler logged cancellation before reconnect. The production-service regression now cancels after a simulated action was sent and its ACK was lost, requires a retained `in_doubt` record whose reason is `cancelled` before the deadline, and proves a second action sends nothing. Host prose must not override retained action evidence.

The original Claude image run retains its early cleanup `EPERM` errors. Subsequent runner validation distinguishes Darwin's dead process group using bounded process inspection; later real runs have no cleanup errors and confirm reaping/drain. Historical results were not rewritten to call them clean.

## Gemini startup incident

The untrusted workspace's update-disable settings were not active during startup. Gemini attempted a detached global npm update from 0.64.0 to 0.65.0, then reported failure. The matching npm log identifies the scratch working directory and EACCES/exit -13. Root stopped the owned CLI session without accepting folder trust or attempting authentication. The entry-point bytes, package version and fingerprinted settings files were unchanged afterward; the complete installed dependency tree had no before-image and is not claimed unchanged. No speculative rollback was performed.

[The startup result](../../evidence/2026-10-24-agent-iteration-hosts/gemini-startup-result.json) preserves these limits. Workspace settings alone are insufficient to guarantee pre-trust startup behavior. Existing settings contained no migration-trigger keys and no old background logs were eligible for deletion, but those prechecks did not prevent the updater. Startup can also update `~/.gemini/state.json` tip/nudge counters; current state and its backup are retained, without a pre-run identity claim. [The source review](../../evidence/2026-10-24-agent-iteration-hosts/gemini-startup-source-review.json) records the npm failure on `mkdir /usr/local/lib/node_modules/@google` and the limits of potential guards. Do not rerun this interactive lane under the preservation requirement without a verified pre-trust guard and supported authentication. This is a host-isolation finding, not a PICO runtime failure.

## Reproduction and evidence boundaries

Build the candidate before running the fixture gate or manual probes. The finite manual runner accepts an output directory that must not exist, an absolute retained PNG path, and its SHA-256:

```sh
npm run build
python3 scripts/run-host-conformance.py codex /absolute/new-output \
  /absolute/retained.png SHA256
python3 scripts/run-host-conformance.py claude /absolute/another-output \
  /absolute/retained.png SHA256
python3 scripts/run-host-conformance.py codex /absolute/approved-output \
  /absolute/retained.png SHA256 approved
python3 scripts/run-host-conformance.py claude /absolute/lifecycle-output \
  /absolute/retained.png SHA256 lifecycle
python3 scripts/run-host-conformance.py codex /absolute/cancel-output \
  /absolute/retained.png SHA256 cancel
```

These POSIX commands require Python 3 with `waitid(WNOWAIT)`, use existing host authentication and can make model requests. They leave installed MCP configuration in place. Claude's SDK path answers only exact allowlisted per-call requests once and never saves a permission rule; print mode does not prove the interactive workspace trust dialog. Codex's initial path intentionally records its default headless admission behavior. Do not infer request cancellation from a closed process or an aborted handler: require a matching inbound `notifications/cancelled` in the probe's wire log. A new client process is a restart, not automatic same-client reconnect. The cancel trial can exit nonzero when the interrupted host does; inspect its evidence instead of treating that exit as a passed end-to-end test.

The runner bounds host time, output, stdin and post-exit stream draining. It keeps its newly launched leader unreaped until owned-group cleanup finishes, so its process-group ID cannot be reused for an unrelated process. Ten synthetic cleanup cases run through the existing interaction gate, including an orphaned pipe holder, closed streams with a live leader, parser/tick exceptions, blocked stdin and survival of an unrelated sentinel process. The manual model trials are not a CI gate.

## Packaging correction

An initial packaging run put `TMPDIR` inside this worktree. npm walked to the ancestor package root, changing only the candidate's package manifests and dependency directory instead of installing into the empty test sandbox. The failed files and exact payload were retained; the clean pre-test manifests were restored from `02d4b5f`, then the worktree's locked dependencies were restored. [The incident record](../../evidence/2026-10-24-agent-iteration-hosts/packaging-isolation-incident.json) identifies those bytes and logs.

The tarball verifier now passes `--prefix sandbox` explicitly and checks both checkout manifests after npm returns, including failure paths. The nested-directory regression passed with both manifests unchanged. That run proves install isolation only: Node could still resolve a missing dependency from an ancestor checkout. Final standalone acceptance therefore ran outside any ancestor package or `node_modules`, and passed separately with unchanged checkout metadata. The first `npm run test:tarball -- --publish ...` attempt was refused by the gate runner before a test child existed; the verified payload was instead copied from the normal gate and matched to its recorded digest.

The [artifact manifest](../../evidence/2026-10-24-agent-iteration-hosts/ARTIFACTS.json) selects the exact standalone-checked local tarball, SHA-256 `bb4671fe2c9f6f6a5d1df0485ce55590c9edcad833487a4cb46c589721fc0499`. Older and failed/partial artifacts remain retained. Production server source and its build-input/output identities are unchanged by this host follow-up; the payload adds the manual host harness and packaging guard. No version bump, release or installed MCP activation occurred.

[Final validation](../../evidence/2026-10-24-agent-iteration-hosts/VALIDATION.json) records build-before-test execution, interaction **85/85** including the ten Python cleanup cases, lint **63/63**, docs **26/26**, and the nested-install/standalone tarball checks. The standalone gate also passed its eleven publication-helper cases. This is scoped validation; the previously documented broader gate failures were not rerun, and a full battery pass is not claimed.

[Independent review](../../evidence/2026-10-24-agent-iteration-hosts/REVIEW_RESULT.json) found no remaining material source, host-report or artifact findings. The reviewer inspected code and retained traces without running tests, hosts or native operations. Root ran the checks and inspected the historical frame.

The probe and its fixture regression are [host-conformance-probe.mjs](../../scripts/host-conformance-probe.mjs) and [interactionhost.mjs](../../test/interactionhost.mjs). Source identities and official contract references are retained in [SOURCES.json](../../evidence/2026-10-24-agent-iteration-hosts/SOURCES.json). No host configuration here certifies native ownership or grants permission to select a physical device.
