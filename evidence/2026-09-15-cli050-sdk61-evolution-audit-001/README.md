# CLI 0.5 / SDK 6.1 evolution audit evidence

Planning checkpoint for `/Users/sushantsrikrish/PICO-MCP`, audited source `308c898e9c33975b5a21ecb78fed245fab17a0ed` (`main`, package 37.0.0). This directory contains audit observations and plans, not completed implementation acceptance.

Start with the [handoff](../../docs/CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md), [master plan](../../docs/superpowers/plans/2026-09-15-cli050-sdk61-evolution.md), and [fresh-chat prompt](../../docs/CLI_050_SDK61_FRESH_CHAT_PROMPT_2026-09-15.md).

## Evidence inventory

| Files | What they establish |
|---|---|
| [PICO_DOCTOR_001.json](PICO_DOCTOR_001.json) | First operational tool call, read-only. Cached CLI 0.4.4, installed SDK 6.1, inconsistent legacy SDK path, stale calibration. Does not bind the running MCP's compiled bytes to audited source HEAD. |
| [REGISTRY_001.json](REGISTRY_001.json), [RELEASE_IDENTITY_001.json](RELEASE_IDENTITY_001.json) | Exact public registry response, fetch time, release versions, tarball URLs, SHA256 and verified SHA512 SRI. Signature metadata is retained; no independent signing-key/signature verification is claimed. |
| `CLI_PACKAGE_*.json`, `PACKAGE_INVENTORY_*.json`, `CLI_README_*.md` | Small exact members and archive inventory from the two published packages. No lifecycle script was run. The unchanged README is less current than actual registrations/help. |
| [HELP_COMPARISON_001.json](HELP_COMPARISON_001.json), [HELP_COMPARISON_RUN_001.json](HELP_COMPARISON_RUN_001.json) | Unmodified repository comparator, exact 0.4.4 → 0.5.0. Hash-only report; original scratch installation removed by the existing script. |
| [HELP_COMPARISON_002.json](HELP_COMPARISON_002.json), [HELP_COMPARISON_RUN_002.json](HELP_COMPARISON_RUN_002.json) | Follow-up to retain raw observations and diagnose the first report. Audit-only comparator copy adds output/status recording; original production script unchanged. |
| [RAW_HELP_INDEX_002.json](RAW_HELP_INDEX_002.json), `raw-help-002/` | 162 version/help invocations, with raw streams, exit/status, time and hashes. Zero timeouts/truncations. Six nonzero profiler utility failures remain visible. |
| [CLI050_STATIC_PACKAGE_AUDIT.md](CLI050_STATIC_PACKAGE_AUDIT.md), [CLI050_STATIC_EXCERPTS_001.json](CLI050_STATIC_EXCERPTS_001.json) | 31 byte-range/member-hash-checked source excerpts: canonical knowledge/perf changes, watcher deadline, capture behavior, report schema, Editor delegation and conditional authentication. |
| [FINAL_CONSUMER_COVERAGE_AUDIT.md](FINAL_CONSUMER_COVERAGE_AUDIT.md), [FINAL_CONSUMER_EXCERPTS_001.json](FINAL_CONSUMER_EXCERPTS_001.json) | Ten further checked excerpts for trace contracts and emulator status; Windows probe/global-install limitation and prospective device-list format change. |
| [SDK61_KNOWLEDGE_AND_TOOLCHAIN_AUDIT.md](SDK61_KNOWLEDGE_AND_TOOLCHAIN_AUDIT.md) | Source findings and proposed resolver, cache and exact-declaration authority work. |
| [MCP_VALUE_AND_RELIABILITY_AUDIT.md](MCP_VALUE_AND_RELIABILITY_AUDIT.md) | Workflow value, external APK identity, capture integrity, inner-server concurrency and observation coverage. |
| [RELEASE_AND_GATE_AUDIT.md](RELEASE_AND_GATE_AUDIT.md) | Build freshness, suite inventory, release artifacts, docs/CI parity and actual-host limitations. |
| [PICO_FIX_001.json](PICO_FIX_001.json), [PICO_FIX_HELP_UTILITIES_002.json](PICO_FIX_HELP_UTILITIES_002.json) | Retained diagnostic routing. The latter matched an old interactive-hang lesson with outdated setup/doctor examples; these were not executed or treated as current CLI authority. |
| [DOCUMENT_REVIEW_001.md](DOCUMENT_REVIEW_001.md) | Independent plan review and resolved integration gaps. |
| `AUDIT_VALIDATION_001.json`, `EVIDENCE_MANIFEST_001.json` | Final scoped document/link/source checks and file hashes. These are not MCP regression or native results. |

The two comparator run stdout/stderr files are retained even when empty. Both executions installed packages into isolated scratch prefixes with npm lifecycle scripts disabled. Their version/help calls did not start an app, profiler, Editor workflow, knowledge server or emulator. Child help errors indicate absent optional utilities, not evidence that they were installed or exercised.

## Limits and preserved negative observations

- Help traversal visited 69 paths for 0.4.4 and 91 for 0.5.0, including parent groups. There were 25 additions and three removed advertised paths. All common raw-help hashes changed; formatting/description changes contribute, so this is not 66 separate semantic breakages.
- The original comparator marks its guarded operation set as help-only even though it also permits two `-v` version checks. The index reports those explicitly.
- 0.4.4 `perf --help` exited 1: utilities 0.1.0 unavailable. In 0.5.0, `perf daemon`, `doctor`, `live`, `session` and `trace` child help exited 3: utilities 0.2.0 unavailable. The deeper profiler tree was not observable in that environment. Vendored source inspection fills syntax knowledge, not runtime proof.
- No setup/calibration, emulator input/lifecycle change, account login, browser credential access, CLI activation/global install, app build, MCP regression battery or native visual verification was performed. `pico_doctor` itself made read-only environment/status observations.
- The host Firecrawl command was absent, so public npm registry retrieval used Python HTTP. Earlier browser retrieval failures and shell-glob misses did not cause package/environment repair. The actual successful registry response and every help failure are retained.
- Mission Replay remains paused at its separate recorded checkpoint. Its native hold/retry rules are not reset by this audit.

## Local archive preservation

The official CLI tarballs are deliberately excluded from Git by the repository's `*.tgz` rule, and remain in this directory:

| Archive | Bytes | SHA256 |
|---|---:|---|
| `picoxr-pico-cli-0.4.4.tgz` | 37,470,411 | `0eabffe9b6a92c9a96fe61ea38f3213b0971216f0db7c4d19f9da46660ba9524` |
| `picoxr-pico-cli-0.5.0.tgz` | 38,104,171 | `a2afe604b3435a83debe1a42706fa4fe0b9e14d026c857873e8fc21f6ac68642` |

Use the exact registry URL/SRI in `RELEASE_IDENTITY_001.json` if another machine needs those archives. Keep all existing local bytes. Freshly downloaded replacement artifacts need new evidence identifiers and integrity checks; do not overwrite these.
