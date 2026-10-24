# CLI contracts for the agent iteration candidate

The candidate retains the official CLI's WorkflowRun lifecycle authority. Its scenario records can refer to a successful `workflow run read <run-id> --format json` observation; they do not allocate CLI run IDs, change revisions, resume work or implement a second workflow scheduler.

The read-only host observations use the already cached public `@picoxr/pico-cli` 0.6.1 binary. [The raw observation index](../../evidence/2026-10-23-agent-iteration/cli/READ_ONLY_CONTRACTS.json) records the absolute binary, working directory, command arguments, timing, separate streams and SHA-256 values. Every command was version/help discovery or workflow list/describe. Neither a workflow nor a native target was started. [Additional PTY observations](../../evidence/2026-10-23-agent-iteration/cli/PTY_OPERATION_FOLLOWUP.json) and [source member identities](../../evidence/2026-10-23-agent-iteration/cli/SOURCE_IDENTITIES.json) preserve the comparison. The fixtures copy these bytes, not fabricated successful runtime results.

| Artifact | SHA-256 |
| --- | --- |
| CLI package.json, 1,205 bytes | `44c2ba62b978d28b62f7f22471f7b9a23c20011008371d7ec3435d5072913144` |
| CLI dist/index.js, 944,008 bytes | `6daf24579469fd00e69d7e389f241fc6efec6ffde526dea0e4949fe7a38e4542` |
| Registered Workflow catalog, 152,968 bytes | `e48fd8a14f7fb58c9d1590693b360ea57854f87cc1ea96ae57a03c5d1083c6f4` |
| WorkflowRun public schema member | `81d7463024aff91949b2718cbe4486a9ec582b733cbb9a114da743ac031b2c7e` |

`workflow list --format json` returns a raw array with four identifiers: `spatial-3d-generation`, `spatial-codegen-workflow`, `spatial-design-to-app`, and `spatial-editor-workflow`. The inspected `workflow describe spatial-design-to-app --format json` returns `pico-workflow-description/v1`, workflow version 1.0.0, contract version 1.0.0, input/output contracts and runtime declarations. These are installed declarations, not successful Workflow runs.

The CLI publishes different JSON contracts. Workflow list is an array; describe and run read are raw objects. Root/module diagnostic commands may return a `tool-result` object with `tool_name` and `tool_status`. A `PARTIAL` result with exit 4 stays partial; an exit/status disagreement, malformed JSON or a mismatched command shape cannot become success. The adapter does not claim complete semantic validation of terminal WorkflowResult output.

Exact `app install`, `app stop` and `app launch` leaf help also completed through pipes. [The lifecycle leaf observations](../../evidence/2026-10-23-agent-iteration/cli/APP_LIFECYCLE_LEAF_HELP.json) advertise explicit `--device` on each route. Install uses a positional APK plus `--replace`; launch uses a positional package and optional `--activity`. These leaves advertise no JSON format flag. Launch promises process creation, then requires separate app readiness checks. Only help was invoked.

## Pipe output and capability migration

On this macOS host, workflow/app/emulator group help and four profiler child helps exited 0 after exactly 512 stdout bytes, ending mid-line. Their stderr streams separately contained the color-setting warning. Equivalent stdout PTY calls completed. The runner's 1 MiB capture bound was not reached. This reproduces incomplete producer output; it does not establish its root cause or a portable fix. Production discovery continues to use pipes. It now requires a complete options/help declaration and a terminating newline before a matching usage line can authorize a route. Stderr cannot supply stdout's missing newline.

Exact 0.6.1 declarations were reconciled separately. Its profiler is bundled 0.2.1. Its four truncated pipe observations remain unknown even though their retained PTY help declares the routes. Unknown later versions are candidates for help discovery only; they inherit no positive option or duration-flag declaration.

Capability report schema 2 binds package identity plus a versioned digest of selected configuration and utility inputs. The digest includes relevant environment selectors, the nearest project `.pico-env.json` or the selected home record, the PICO configuration file, selected profiler roots/explicit entry, and the selected graphify executable. File reads and tree traversal have byte, depth, entry and time bounds; unreadable or raced input prevents reuse. A harmless cwd change with the same selection does not invalidate the report. A different selected config or utility does. Child guards inspect the actual launch cwd/environment, including the knowledge subprocess.

Schema 1 remains parseable for inspection and retained evidence, but cannot authorize dispatch. No old report is rewritten into a schema-2 claim. A fresh, complete discovery must establish the additional binding. Reports explicitly carry `evidenceScope: help-only`, `runtimeTested: false`, and `visuallyReviewed: false`.

An external CLI with a discoverable package binds its package and containing dependency tree within the stated limits; changing an imported helper invalidates that evidence. A standalone executable with no discoverable package carries `executionScope: standalone-entry`. That narrower identity does not establish the dependency closure of an arbitrary script. Help and identity checks also do not establish runtime readiness, hidden aliases or hardware behavior.

## Read-only Workflow references

[cliworkflowreference.ts](../../src/cliworkflowreference.ts) accepts an absolute retained process receipt, not a scenario-authored revision. The receipt must name `workflow.run.read`, the exact argument vector and CLI identity, exit 0, no timeout/truncation, and a SHA-256-bound stdout file retained beside or below the receipt. Canonical containment also rejects a symlink escape. The stdout must parse as a public WorkflowRun v1 with the expected run ID and revision.

`createCliWorkflowReference` records the CLI revision it read. `verifyCliWorkflowReference` reopens both files, verifies hashes and the CLI identity, and rechecks the run/revision. Altering a local reference, output, receipt path or source bytes invalidates it. These are local provenance checks, not a cryptographic signature against an actor able to replace all evidence. Verification establishes a retained historical read, not the current live run revision. A later CLI lifecycle operation must obtain its own fresh official read and follow the CLI concurrency contract. The module contains no CLI lifecycle mutation or dispatch.

## Proof boundaries

| Capability | Implemented | Host fixture evidence | Actual CLI observation | Native / rendered proof |
| --- | --- | --- | --- | --- |
| Incomplete help refusal | Yes | Classification and retained streams | 0.6.1 pipe/PTY comparison | Not applicable |
| Utility/config identity and migration | Yes | Same-version file/config drift; schema-1 refusal | Exact cached package identity | Runtime utility behavior unverified |
| Workflow list/describe parsing | Yes | Retained real command outputs | Both commands ran read-only | No workflow execution |
| WorkflowRun reference validation | Yes | Synthetic valid/invalid read receipts | CLI public schema inspected | No actual run was read or changed |
| Native app action / replay | Separate interaction slice | Reported by its own fixtures | No native CLI operation here | Unverified by this work |
| Hand/controller input | No | None | None | Unverified |

Run `npm run build` before `npm run test:picocli`. The existing gate provides the fixture-ADB barrier. Direct fixture commands must explicitly set `PICO_ADB=/fixture/no/such/adb`. The baseline failure and later test outputs are retained under the observation directory; green fixtures do not establish emulator or simulator parity.

The focused final checks used root build 3 (`199` files, reported source digest prefix `d4bc281bb376`). [The test evidence manifest](../../evidence/2026-10-23-agent-iteration/cli/TEST_EVIDENCE.json) gives every command, outcome and log hash, including failed intermediate attempts. The new contract suite passed 11/11; the legacy CLI suite reported zero failures; both targeted knowledge tests passed. The broad asynchronous run exposed two old fixture expectations, which were corrected and passed their targeted rerun. Its remaining failure is the preexisting sweep cleanup case described below.

```sh
npm run build
PICO_ADB=/fixture/no/such/adb node --test test/picocli-agent-contracts.mjs
PICO_ADB=/fixture/no/such/adb node test/picocli.mjs
PICO_ADB=/fixture/no/such/adb node --test --test-name-pattern='managed knowledge checks|managed knowledge transport spawns' test/knowledge-lifecycle.mjs
```

The sweep's detached-child output-cap cleanup test fails on this host in both the candidate and an isolated copy of main `1157f33`. The sweep script and test are byte-identical across those copies, and main's capability module was compiled into that isolated copy. Its bounded global process-environment scan exceeds 4 MiB and returns `ENOBUFS`; after the fast fixture parent exits, the runner has neither a surviving parent link nor a complete token scan to rediscover its detached child. The fixture's own cleanup removes its child. [Sanitized scan metadata](../../evidence/2026-10-23-agent-iteration/cli/SWEEP_SCAN_DIAGNOSIS.json) retains only status, byte counts and timing, with no process commands or environments. This existing runner is unchanged by the candidate; the failure remains reported rather than reclassified as passing.
