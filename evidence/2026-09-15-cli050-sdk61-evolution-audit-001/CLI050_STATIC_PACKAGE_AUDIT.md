# CLI 0.5.0 static package audit

Date: 2026-09-15. MCP source baseline: `308c898e`.

This follow-up reads the official `0.4.4` and `0.5.0` tarballs supplied by root, using Python `tarfile` in memory. It does not execute either CLI, a vendor script, setup, package installation, tests, builds or device operations. It writes only this report and targeted evidence excerpts. No entire distribution file was extracted to disk. Mission Replay stays paused.

Root separately verified tarball SHA-512 integrity and observed npm registry latest `0.5.0`, published `2026-09-10T04:15:42.541Z`. Root's separate [help index](RAW_HELP_INDEX_002.json) records 162 version/help invocations and the advertised command tree. Those observations are distinct from this source analysis.

The [31 targeted excerpts](CLI050_STATIC_EXCERPTS_001.json) contain exact archive member names, one-based line ranges, zero-based UTF-8 byte ranges, full-member SHA-256 and excerpt SHA-256. This matters because the JavaScript is minified: one source line can contain many functions. Excerpts can end mid-expression and are evidence snippets, not executable files. Nested profiler references use `outer-member.tgz!inner-member` notation.

## Immediate conclusion

A CLI version bump alone is insufficient. Two existing MCP invocations are inconsistent with `0.5.0` source: the knowledge child uses the removed spaced `mcp dev-knowledge` route, and performance diagnosis invokes `perf monitor run` although the new router explicitly permits `live`, not `monitor`.

| Priority | Finding | Required MCP work |
| --- | --- | --- |
| P0 | Knowledge route renamed; retained aliases are colon tokens. | Update `src/knowledge.ts` default args and the canary in `src/picoclimanaged.ts`; test child lifecycle and exact argv. |
| P0 | Performance router rejects `monitor`; live collection options and provisioning location changed. | Update `src/perfcli.ts`, corresponding canary/fixtures and failure classification; do not infer that installed package means profiler payload exists. |
| P1 | Crash watcher has an explicit total deadline and better package/PID correlation. | Pass its deadline, preserve a separate outer settlement bound, report measured coverage and revise stale wording. |
| P1 | Capture time limit and publication behavior changed. | Preserve intentional MCP limits, distinguish requested/clamped duration from actual media duration, validate artifacts and update version-specific wording. |
| P1 | New package-scoped JSON log snapshots and trace analyses reduce the need for custom low-level diagnosis. | Adapt a small number of existing MCP workflows; do not expose one new tool per command. |
| P1 | Official Editor bootstrap now owns production/revision workflows and bundle sidecars. | Prefer its authoring orchestration, while this MCP owns app integration and independently scoped evidence. |

## Knowledge routes: default client break

CLI `0.4.4`, `package/dist/index.js:109`, excerpt `K044`, registers:

```text
name: mcp dev-knowledge
aliases: mcp:dev-knowledge, mcp:spatial-knowledge, mcp spatial-knowledge
```

CLI `0.5.0`, `package/dist/index.js:93`, excerpt `K050`, registers:

```text
name: knowledge server
aliases: knowledge:server, mcp:dev-knowledge, mcp:spatial-knowledge
```

The retained colon aliases are individual argv tokens. They do not constitute a registration for the old two-token `mcp dev-knowledge` command. The old spaced `mcp spatial-knowledge` alias is also absent. Root's advertised help comparison independently reports removal of `mcp`, `mcp dev-knowledge` and `mcp doctor`.

The MCP currently launches `DEFAULT_KNOWLEDGE_ARGS = ["mcp", "dev-knowledge"]` (`src/knowledge.ts:24`, applied at `892` and `988`). Its acquisition canary also invokes that route (`src/picoclimanaged.ts:35`). Both need a deliberate version-aware or current-version migration to canonical `knowledge server`; tests must preserve the existing bounded generation retirement and exact executable identity checks.

`knowledge doctor` replaces `mcp doctor` in the new registration (`package/dist/index.js:52–53`, `KD050`). There is no retained `mcp:doctor` alias in that declaration. A stale prose reference to `mcp doctor` survives elsewhere in the new top-level doctor notes; that text is not a registered command.

New `knowledge pull [version]` and `knowledge list` declarations are retained in `KP050` (`index.js:50`). Pull advertises `--source auto|internal|cn|global`, `--platform`, `--projectRoot` and `--format`; it writes files and may use the network. Its project/global environment destination is explicit. List advertises installed versions. These may support SDK-version-aware knowledge discovery later, but do not prove that the required SDK 6.1 declaration payload is present or that an unqualified pull selects the intended project version.

Canary qualification: `hasCompleteCompatibility` (`src/picoclimanaged.ts:839–848`) checks that expected argv observations exist, not that every exit code was zero. Canary results are persisted at `1609–1631`. A successfully published CLI package therefore must not be described as semantically compatible merely because these diagnostics were recorded.

## Profiler: route, options, schema and payload changes

The tarball bundles change from `pspp-profiler-cli-0.1.0.tgz` to `pspp-profiler-cli-0.2.0.tgz`. Both nested archives were read in memory; their hashes are in the excerpt inventory.

`0.5.0` top-level `index.js:36–37`, excerpts `PERF_ROUTER050` and `PERF_ENV050`, defines the allowed resources/actions as:

```text
daemon: start, stop, status, list
session: list, close
doctor: check, install
live: run, start, stop
trace: record, stop, decode, load, query, analysis
```

Unknown resources/actions are rejected before normal delegation. `monitor` is not in this list. The `0.4.4` top-level wrapper forwarded args directly (`PERF_ENV044`); its bundled profiler also registers `live`, and occurrences of “monitor” in that profiler relate to implementation logging rather than a command registration. Do not retain `monitor` on the assumption that it is a hidden supported alias.

The MCP currently uses:

```text
perf monitor run --app PKG -d SEC --device SERIAL -o PATH
```

at `src/perfcli.ts:88`. Changing only `monitor` to `live` is incomplete. Nested profiler `0.2.0`, `package/dist/index.js:2`, excerpt `LIVE050`, establishes:

- `--package` is canonical; `--app` remains a deprecated alias that emits a warning.
- The duration shorthand changes from `-d` in `0.1.0` (`LIVE044`) to `-t` in `0.2.0`; use `--duration` to avoid ambiguity.
- Explicit `--output` requires `--save` or `--report-mode` in both inspected profiler versions. `--report-mode` implies saving.
- `--envelope` requires a fixed `--duration`; interactive output cannot be wrapped that way.
- `--package none` skips app metrics. This must never satisfy an app FPS acceptance criterion.

A source-derived replacement candidate is:

```text
perf live run --package PKG --duration SEC --device SERIAL --save --output PATH
```

This candidate has not been exercised against a device or provisioned profiler. Root's help run could list the `0.5.0` perf resources, but every child help request failed because profiler `0.2.0` was not provisioned; the `0.4.4` perf help similarly lacked profiler `0.1.0`. No deeper help/runtime proof was earned.

Provisioning resolution also changes. `PERF_ENV050` requires an absolute `PICO_HOME` unless `PICO_CLI_PROFILER_ENTRY_PATH` is explicitly provided. The old source resolved the profiler under its separate prefix/default `.local` location (`PERF_ENV044`). The new package can be runnable while its profiler is unavailable. Do not silently set an environment root or execute setup to conceal that difference.

Nested profiler report declarations change at `package/dist/src/live/reporter.d.ts:18` onward (`REPORT044`, `REPORT050`):

- `metadata.app` becomes `metadata.package`.
- `metadata.timeAlignment` describes `logcat-anchor-with-hb-fallback` and `heartbeatMs`.
- `diagnosis.result` adds `SKIP`.
- `diagnosis.category` adds `INSUFFICIENT_DATA`.

`PERF_SKIP050` retains the actual generation branch that returns `SKIP/INSUFFICIENT_DATA` when neither app nor Spatial Runtime FPS was collected. `src/perfcli.ts:132–145` currently returns schema data without validating target/report identity; the future adapter should validate the observed package and required measurement fields while retaining missing-counter distinctions. Keep `src/doors.ts:985–1015` and `scorePicoCliPerfAxis` aligned with missing app metrics; system/runtime FPS must not stand in for app FPS.

New trace analysis commands are documented and declared in the vendor package, `README.md:216–234`, excerpt `TRACE_ANALYSIS050`. These include process counters, app/runtime jank and slow-frame analyses, app busy-running frames, frame overviews and `report.overview`. The overview command returns compact execution metadata and writes detailed data into an HTML report. The source/declarations are grounds for a future adapter, not proof that trace collection or SQL analysis works on this host. Favor a bounded existing `perf_trace` extension with retained report artifacts over recreating those analyses in this MCP.

## Crash watcher: the stale “indefinite stream” assumption

`0.4.4` already had an internal 30-second monitoring loop after waiting for a PID (`index.js:27–28`, `WATCH044`). Its help exposed no monitor-duration flag. Thus “no duration flag” did not imply “streams indefinitely.”

`0.5.0` adds `--monitor-timeout`, default 30 seconds, described as total wall-clock time for process discovery and crash signals (`index.js:47`, `WATCH_ARGS050`). Its handler establishes a deadline before device resolution; launch, PID wait, sleep and final log collection consume that shared budget (`index.js:50`, `WATCH050`).

The handler distinguishes confirmed correlated crash evidence from process restart/exit without correlated crash evidence. That is a useful authoritative primitive. It still may return early with no PID, and source inspection alone does not establish the observed duration of any real run.

`src/picoclitools.ts:29–33`, `60–63` and `134` therefore need revised version-aware wording. Pass the CLI deadline for `0.5.0`, while retaining the MCP's separate hard process-settlement bound. Measure actual elapsed time; do not label the requested duration as observed. Reconcile old watcher-output fixtures with new confirmed-crash/restart/exit wording rather than treating all process exits as crashes.

## Capture: time limit and safer file publication

Old capture code rejects a requested duration above 180 seconds (`index.js:27`, `CAPTURE044`). The new declaration advertises up to 1,800 seconds (`index.js:47`, `CAPTURE_ARGS050`) and the handler clamps requests to its maximum (`index.js:50`, `CAPTURE050`).

Important limit: the inspected new handler still invokes one `screenrecord --time-limit` operation. It is not a segmented recorder. Its returned `actualDurationSec` is the clamped requested value, not a measured container duration. No long recording was attempted in this audit. The maximum is advertised/source behavior, not confirmed device media support.

The new handler uses cancellable inherited execution, pulls into a temporary partial file, checks MP4 header shape, publishes to the requested path and attempts remote/local cleanup. The old handler also checked MP4 header shape; neither check establishes decoded frame content, FPS or duration.

The MCP's current 180-second maximum can remain an intentional product bound (`src/picoclitools.ts:185`) rather than automatically expanding to 30 minutes. Update version claims, accept valid cancellation/cleanup failures and retain independent container/visual validation. Keep explicit output paths immutable at the MCP evidence layer; the CLI's replacement behavior does not itself preserve prior captures.

## Structured logs and failure shape changes

The new `app logcat` declaration adds `--package` and `--format plain|json` for snapshots (`index.js:47`, `LOG050`). JSON follow mode is rejected; plain follow is bounded by a long timeout/cleanup. The `--clear` flag remains explicitly mutating. Package-scoped snapshots can replace some ad hoc log scraping, while MCP still needs exact observed PID, window bounds, raw retention and package attribution.

`device list --format json` changes from a bare array to `{ devices: [...] }` in the inspected implementations (`DEVICE_JSON044`, `DEVICE_JSON050`, `index.js:24` and `47`). Audit consumers before reusing old JSON parsing. This report does not claim that other command envelopes changed identically.

`0.5.0` top-level failures can emit a structured failure result under `--format json`, and source maps usage errors to exit 2 and other generic command errors to exit 3 (`index.js:188`, `ERROR050`). Runtime error handling should preserve the envelope and original exit code.

`classifyPicoCliFailure` (`src/picocli.ts:941–949`) currently recognizes “unknown command/option/argument” and “not installed ... pico-cli setup.” It misses the new router text `Unknown perf subcommand` and the `PICO_HOME is not set` provisioning condition. Add precise fixtures and preserve unknown errors honestly; do not blanket-map every exit 3 to missing setup.

## Official Editor workflow and MCP differentiation

`editor bootstrap` remains the gateway command. Its `0.5.0` contract now explicitly identifies default and conditional side effects, including schema-probe processes and possible owner cleanup (`index.js:93`, `BOOTSTRAP050`). It must not be invoked as a supposedly inert metadata read.

The new `package/dist/bootstrapServer-B3YYM5NL.js:30` contains a managed production/revision Controller absent from the old monolithic index's tool definitions. Its declarations include:

- `start_editor_workflow`, `resume_editor_workflow`, `wait_editor_workflow`, `advance_editor_workflow` and status/cancel.
- Agent manifest, scene plan, scene mutation, supplemental evidence and visual review submission.
- Explicit user decision submission and bounded retry gates.

`EDITOR_WAIT050` describes polling and persisted state inside the Controller to avoid Agent round trips. `EDITOR_START050` requires revisions of completed managed scenes to retain their base run and inherited ownership. These are source-declared capabilities, not measured speedups or proven Editor behavior.

`pack_editor_bundle` (`bootstrapServer-B3YYM5NL.js:33`, `EDITOR_PACK050`) declares a stable package result and co-located `<bundleName>.scenes.json`. It can derive the bundle path under a target app's `app/src/main/assets`, accepts explicit scene files, and has bounded polling options. This is a strong future integration point: delegate Editor authoring, then validate bundle/sidecar contents and bind app build evidence independently.

Switching Editor GUI/headless mode is not a harmless window toggle. `EDITOR_MODES050` describes saving, closing and restarting the managed Editor session. That lifecycle must honor task constraints and must not be mixed with emulator permission assumptions.

The new setup workspace source (`setup-workspace-OIBTXTPV.js:12`, `SETUP_REVIEW050`) shows review/apply planning with a rechecked action list and local-context confirmation. The hidden `--bind-mcp-to-local-cli` option is explicitly labeled test automation for a validated SpatialCraft checkout (`index.js:172`, `LOCAL_BIND050`). It is not a general instruction to bind this independent MCP to arbitrary local source, and this audit did not run it.

## Authentication scope

No `auth`, `login` or `logout` command registration was found in the audited top-level JavaScript command definitions of either package. The new bootstrap contains a specific `EDITOR_API_KEY_REQUIRED` branch for model generation (`bootstrapServer-B3YYM5NL.js:17`, `EDITOR_AUTH050`). It requests API key configuration in Editor and an explicit retry decision.

That conditional model-generation requirement is not evidence of a CLI-upgrade sign-in requirement or an emulator sign-in requirement. This audit did not access credentials or test authentication. Do not generalize absence of a top-level login command into a claim that every optional provider or operation is account-free.

## Implementation acceptance to carry into the fresh chat

1. Update canonical knowledge/performance routes and exact invocation fixtures together with their canaries. Preserve bounded knowledge-child retirement and executable integrity.
2. Distinguish package availability, help compatibility, utility provisioning and actual runtime behavior in status/reporting.
3. Exercise the new watcher deadline, early exit and error classification using deterministic fake subprocesses. Retain full-window versus partial-window distinctions.
4. Validate profiler report package identity, missing metrics, SKIP and both supported schema versions where compatibility is retained.
5. Prefer official package-scoped logs and trace analyses for measurement. Keep MCP summaries bounded and artifacts inspectable.
6. Integrate Editor workflow or bundle-sidecar paths only where the intended app workflow benefits; do not add a parallel production Controller.
7. Perform separately authorized, healthy native validation before any capture, performance or hardware claim. This report supplies source evidence and candidate changes only.

The earlier [MCP value audit](MCP_VALUE_AND_RELIABILITY_AUDIT.md) remains applicable. This package audit replaces its conditional CLI examples with concrete source findings, while preserving all earlier evidence and its no-runtime-validation qualification.
