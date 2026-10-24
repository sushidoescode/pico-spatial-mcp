# Final CLI consumer coverage audit

Date: 2026-09-15. MCP source baseline: `308c898e`.

Scope: `src/perftrace.ts`, `src/preflight.ts`, their directly used parser in `src/picocli.ts`, and `scripts/probe-windows-emulator.mjs`, compared with published CLI `0.5.0` and its bundled profiler `0.2.0`. Static source/archive reads only; no CLI, setup, install, build, test or device execution. Ten small [source excerpts](FINAL_CONSUMER_EXCERPTS_001.json) retain archive member names, line/UTF-8 byte offsets and hashes. Earlier evidence is unchanged.

| Consumer | Exact current invocation | Static compatibility result |
| --- | --- | --- |
| `perf_trace` record, `src/perftrace.ts:107–108` | `perf trace record -t SEC -o PATH -d SERIAL`, optionally `-a PKG` | Still declared by profiler `0.2.0`. `-a` now maps to canonical `--package`; use explicit long options for clarity. No device collection was proved. |
| `perf_trace` decode, `113` | `perf trace decode TRACE -f FORMAT -o PATH` | Positional file and `-f/-o` are still declared. Traceconv availability/download remains a separate runtime condition. |
| `perf_trace` load, `117` | `perf trace load TRACE` | Command is declared, but its default human output does not match the MCP's session parser. Required fix below. |
| `perf_trace` query, `121` | `perf trace query --session ID --sql SQL` | Args remain declared. Output is a profiler envelope; MCP currently assigns that whole envelope to `rows`. Required fix below. |
| Preflight, `src/preflight.ts:81,266` | `emulator status --format json` | Args and `tool_status` envelope remain compatible. Exit/status consistency and target tool identity need tightening; no emulator check was executed here. |
| Windows probe, `scripts/probe-windows-emulator.mjs:64–66` | `-v`; `emulator install --source auto --yes --help`; `emulator status --format json` | These args remain declared. The script records raw results and does not parse a device-list array or emulator envelope. It is an observation script, not proof of Windows runtime compatibility. |

## Required trace adapter corrections

All referenced profiler implementations are in `package/vendor/profiler-cli/pspp-profiler-cli-0.2.0.tgz!package/dist/index.js:2`; minification makes the byte references in the excerpts important.

The default load renderer emits `[TraceLoad] Session: <id>` (`TRACE_LOAD_HUMAN`, byte 104222). `parseTraceSessionId` in `src/perftrace.ts:41–58` understands JSON `sessionId`, `session_id`, `data.sessionId` and a textual `session id`/`sessionId` token. It does not recognize the default `Session:` label. Thus a successful load can currently return `sessionId:null` despite a usable session.

Prefer an explicit `--envelope` request for load and validate its success/action/data fields. The existing JSON branch can find `data.sessionId`, but should not extract an ID from a failure envelope or mismatched action. An optional text compatibility fallback must have a fixture for the actual labeled output; do not parse a guessed ID from arbitrary diagnostic prose.

Query declares `outputMode:"envelope"` (`TRACE_QUERY_SCHEMA`, byte 139888). Its successful action data is `{sessionId,rpcEndpoint,rows}` (`TRACE_QUERY_ROWS`, byte 141805). The shared renderer wraps it as `{success,exitCode,resource,action,data,error,formattedOutput}` (`TRACE_JSON_ENVELOPE`, byte 108380). This is the profiler's envelope, which differs from the top-level CLI `tool_status` envelope.

`src/perftrace.ts:200–205` currently sets `out.rows = JSON.parse(stdout)`, so a valid response places the entire envelope in `rows`. Correctly unwrap and validate the rows array, observed session, resource/action and success status. Keep raw output available and preserve an honest parse/unavailable state for malformed or truncated data.

Acceptance for the implementation checkpoint:

- Exact record/decode argv fixtures against the retained declarations; no unsupported new trace mode is needed.
- Load fixtures for explicit envelope success, failure, wrong action, missing ID and the actual human label if compatibility is kept.
- Query fixtures for success with zero/multiple rows, failure with data, wrong session/resource/action, malformed and truncated output.
- An empty successful rows array differs from unavailable rows or a failed command.
- Preserve bounded execution, stat-checked artifacts, original errors and the distinction between source compatibility and native trace proof.

## Preflight: compatible schema, insufficient consistency checks

CLI `0.5.0` still registers the status command and JSON format (`package/dist/index.js:81`, `EMULATOR_STATUS_ARGS`). Its result uses `tool_name:"emulator.status"`, `tool_status`, summary, data and errors (`index.js:85`, `EMULATOR_STATUS_RESULT`). The shared serializer in `package/dist/chunk-IRAF5R7A.js:12` retains this envelope and associates `SUCCESS:0`, `FAILED:3`, `PARTIAL:4` (`CLI_RESULT_SCHEMA`).

The MCP parser at `src/picocli.ts:897–913` recognizes these three statuses. `src/preflight.ts:273–277` already handles a `PARTIAL` envelope as a warning even with a nonzero process result. Preserve this behavior: exit 4 alone is not an unknown parsing failure.

However, `src/preflight.ts:271–272` marks a `SUCCESS` envelope as a pass even when `emulatorStatus.ok` is false; it merely appends nonzero-exit context. The consumer also does not check that `tool_name` is `emulator.status`. Tighten the consumer so a failed/timed-out/integrity-rejected execution or a different tool's JSON cannot produce a healthy row. Keep the generic parser reusable and validate expected tool identity at the call site. Include inconsistent SUCCESS/nonzero, wrong-tool, PARTIAL/4, FAILED/3, malformed, timeout and spawn-error fixtures.

A successful CLI status result means the CLI collected a process or ADB observation. It is not the application's visibility, liveness or visual acceptance gate. Keep independent emulator/device checks and project-specific requirements intact.

## Windows probe: observation limits

`emulator install [bundleVersion]` still declares `--source` and `-y/--yes` (`package/dist/index.js:81`, `EMULATOR_INSTALL_ARGS`). The probe appends `--help`; it does not request an actual emulator installation at that step.

The script itself first queries npm and performs a global CLI installation (`scripts/probe-windows-emulator.mjs:61–62`). It is mutating when executed and was not run in this audit. Its raw result recording at `11–23` retains exit code, timeout, stdout/stderr and truncation, so no CLI `0.5.0` JSON parser adjustment is required in this file.

Do not treat successful script completion as successful upgrade or Windows compatibility: the function continues recording after failed subprocesses. A future acceptance consumer must bind the installed/reported CLI version to the intended package and distinguish failed installation from a fallback executable already present on PATH. Preserve raw results for diagnosis. Actual Windows execution remains unproven here.

## Device-list JSON change is prospective for this scope

The earlier static audit showed a bare array in CLI `0.4.4` becoming `{devices:[...]}` in `0.5.0`. A targeted search of `src/`, `scripts/` and relevant tests found no production consumer parsing `pico-cli device list --format json`; only help-sweep fixtures referenced the command. None of the consumers above needs an array-to-object parsing patch for that change. Retain it as a future integration warning, not a claimed present defect.

This pass completes the requested consumer inventory. It adds required load/query parsing and preflight consistency work to the handoff; it does not establish provisioned profiler, emulator, Windows or visual acceptance.
