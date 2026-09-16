# pico-cli 0.5 capability matrix — what this MCP routes, and what it deliberately does not

Companion to [CLI050_IMPLEMENTATION_CHECKPOINT.md](CLI050_IMPLEMENTATION_CHECKPOINT.md).
Written at release **38.0.0**, integration head `c40180b` plus this checkpoint's commits.

This page answers one question for every capability area pico-cli 0.5 added: **does this server
delegate to it, compose around it, or have no execution integration at all — and on what evidence?**
It is not a command reference. It adds no tool; no tool was added for any CLI command in this
checkpoint, and none should be. The MCP's unit of surface is a user intent, not a CLI subcommand.

## Evidence classes used on this page

| Class | What it means here | What it can never establish |
|---|---|---|
| `source-inspected` | A declaration was read out of the official package's own JavaScript, from the tarballs retained under `evidence/2026-09-15-cli050-sdk61-evolution-audit-001/`. Nothing was extracted to disk and nothing was executed. | That the command behaves as declared. |
| `help-observed` | A bounded `--help` ran and its stdout/stderr bytes were retained with sha256 under `evidence/2026-09-15-cli050-sdk61-evolution-audit-001/raw-help-002/`. Cited by invocation number. | That the underlying operation works. Exit zero on `--help` is a registration fact. |
| `fixture-tested` | A suite in `test/` exercises the path against injected inputs or a fake CLI. | Anything about a real CLI, device, emulator or SDK payload. |
| `host-executed` | A command really ran on this macOS host and its result is recorded. | Cross-platform behavior. |
| `native/visual` | A rendered frame was captured and looked at. | — |

**No row on this page is `native/visual`.** No capability below was exercised against a real
device, a real emulator, or a provisioned profiler payload in this checkpoint.

## Availability on this host — read this before reading the matrix

| Fact | Value | Class |
|---|---|---|
| Registry `latest` for `@picoxr/pico-cli` when the audit ran | `0.5.0` | `host-executed` (`evidence/2026-09-15-cli050-sdk61-evolution-audit-001/REGISTRY_001.json`, `dist-tags.latest`) |
| Version actually present in this host's MCP-owned cache at session start | `0.4.4`, freshness reported as *cached* (no registry lookup was made) | `host-executed` (read-only `pico_doctor {}` at session start, recorded in the plan ledger) |
| Where the 0.5.0 declarations on this page come from | The official `0.5.0` package, read in memory from its retained tarball; plus 0.5.0 `--help` bytes retained during the audit | `source-inspected`, `help-observed` |

So: **every 0.5-only capability below is a declaration this repository has read, not a command this
host has run through its managed CLI.** The MCP's route selection is written to be *version-aware*
rather than latest-assuming, which is why both lines appear in the table below.

## The command-tree delta the routing is built on

`0.4.4` declares 69 commands; `0.5.0` declares 91. Twenty-five added, three removed
(`evidence/2026-09-15-cli050-sdk61-evolution-audit-001/HELP_COMPARISON_002.json`, `source-inspected`):

- **Added:** `knowledge`, `knowledge doctor|list|pull|server`; `perf daemon|doctor|live|session|trace`;
  `plugin install|uninstall`; `project context`; `spatialml` and its `doctor|model|model inspect|model visualize|onboard|pipeline|pipeline install|pipeline search|pipeline verify|setup` tree; `editor sync`.
- **Removed:** `mcp`, `mcp dev-knowledge`, `mcp doctor`.

The three removals are the load-bearing ones: the MCP's knowledge child launched
`mcp dev-knowledge`, a route that **does not exist on 0.5.x**. The retained colon aliases
(`mcp:dev-knowledge`, `mcp:spatial-knowledge`) are single argv tokens and are not a registration of
the old two-token spaced command.

## The matrix

`Integration` is one of:

- **delegates** — the MCP runs this CLI route itself, from capability evidence bound to the exact
  resolved executable.
- **composes** — the MCP owns an equivalent intent with its own implementation and consumes the
  CLI's artifacts or answers where useful, rather than shelling out.
- **none** — no execution integration. Deliberate, with the reason stated.

| CLI 0.5 capability | MCP user intent | Integration | Route / mechanism | Evidence |
|---|---|---|---|---|
| `knowledge server` | `knowledge_api` (graph context) | **delegates** | `src/knowledge.ts` launches the CLI's knowledge MCP child. Argv is selected per resolved package version: `["knowledge","server"]` on 0.5.x, `["mcp","dev-knowledge"]` on 0.4.x (`src/clicapabilities.ts` route table). | `source-inspected` (excerpts K044/K050); `help-observed` (0.5.0 invocation 136, `knowledge server --help`, exit 0, stdout sha256 `95956385…`); `fixture-tested` (`test:knowledge-lifecycle`) |
| `knowledge doctor` | — | **none** | Replaces the removed `mcp doctor`. The MCP's own readiness answer is `pico_doctor` / `preflight_env`, which are read-only and do not shell out to a CLI doctor. | `source-inspected` (excerpt KD050, `package/dist/index.js:52–53`); `help-observed` (0.5.0 `knowledge doctor --help`) |
| `knowledge list`, `knowledge pull` | `vault_api` (authoritative SDK declarations) | **none** | `pull` writes files and may use the network; its project-vs-global destination is explicit. The MCP's declaration authority is the agent vault plus `data/sdk-compatibility`, which is version-pinned and hash-verified. Adopting `pull` would make an unqualified network fetch part of a lookup. A future integration would have to bind the pulled revision to a declared SDK version first. | `source-inspected` (excerpt KP050, `index.js:50`); `help-observed` |
| `perf live run` | `perf_diagnose`, and the `pico_perf` door | **delegates** | `src/perfcli.ts` dispatches `["perf","live","run"]` on 0.5.x with the 0.2.0 profiler's option spellings (`--package`, `--duration`, `--device`, `--output` only paired with `--save`). On 0.4.x there is **no** live route and the wrapper refuses with the family gate's answer rather than inventing one. **Explicit device selection (host completion, 2026-09-16):** the `pico_perf` door now accepts an optional `device` and forwards it to `perf_diagnose`, which passes it through to `--device`; both report the target as `requestedDevice` on every outcome — success, SKIP and failure — so the profiled device is named whether the caller chose it or the wrapper's default did. The default target itself (`DEFAULT_PERF_DEVICE` = `emulator-5554`, `src/perfcli.ts:74`) is **retained by ruling** this checkpoint and stays listed as a known gap. | `source-inspected` (PERF_ROUTER050, LIVE050 in the vendored profiler `0.2.0`); `fixture-tested` (`test:picocli`). **Not `help-observed`:** every 0.5.0 perf child observation (invocations 137–141) exited 3 at the utilities gate, so provisioned profiler help has never been seen. |
| `perf trace record|decode|load|query` | `perf_trace` | **delegates** | Four routes with per-profiler-version option tables; `--envelope` is a global program option and must precede the resource token. | `source-inspected` (TRACE_* excerpts); `fixture-tested`. No retained exit-0 help on either line. |
| `perf daemon`, `perf doctor`, `perf session` | — | **none** | Not needed by either wrapper's intent; adding them would be one tool per subcommand. | `source-inspected` (HELP_COMPARISON_002 added list) |
| `app watch-crash` | `watch_crash` | **delegates** | `["app","watch-crash"]` on both lines. 0.5.x advertises `--monitor-timeout <seconds>`; the requested window is handed to the CLI **only** on a line whose retained help advertises that flag. | `help-observed` (0.5.0 invocation 096, exit 0; 0.4.4 invocation 025, exit 0); `fixture-tested` (`test:picocli`) |
| `capture record` | `capture_record` | **delegates** | `["capture","record"]` on both lines, 1–180 s. | `help-observed` (0.5.0 invocation 097; 0.4.4 invocation 026); `fixture-tested` |
| `project context doctor` | `pico_doctor`, and the host-routing docs | **none** | Inspects and (with `--fix`) repairs project-local agent-context routing for a named Agent Host. Running it would rewrite host plugin wiring in the user's project — the exact class of change this repository's contract forbids as an incidental effect. Host registration stays documentation (`docs/HOSTS.md`), performed by the user. | `help-observed` (0.5.0 invocation 157: `--agent-tool`, `--source`, `--fix`, `--format`) |
| `plugin install`, `plugin uninstall` | — | **none** | `plugin install` requires `--agent-tool`, `--scope` and `--platform`, and installs or repairs Agent Host plugin resources globally or project-locally. Same reason as above, and stronger: it targets the user's Claude/Codex/Cursor/Copilot/Trae installation. | `help-observed` (0.5.0 invocation 144, exit 0) |
| `spatialml onboard|setup|doctor|model|pipeline` | — | **none** | A whole SDK-onboarding, model-inspection and pipeline-package family new in 0.5.0. `onboard` "routes to the owning SDK workflow"; `setup` configures an existing Native OpenXR/Unity/Kotlin project; `model` shells to `pyspatialml`; `pipeline` searches the PICO Pipeline Zoo. None of it is reachable from this server's build/verify/ship intents today, and `setup`/`pipeline install` mutate a user project or install packages. Recorded as an integration candidate, not a gap. | `help-observed` (0.5.0 invocations 086, 151 and the `spatialml *` tree) |
| `editor bootstrap` + the managed workflow Controller | `pico_build_app` / app integration | **none** (consume artifacts only) | See the review below. | `source-inspected` (BOOTSTRAP050, EDITOR_* excerpts) |
| `editor sync` | — | **none** | Added in 0.5.0; not inspected beyond its presence in the added-command list. | `source-inspected` |

### The two routes that changed meaning, not just spelling

1. **Knowledge.** The MCP previously hardcoded `["mcp","dev-knowledge"]`. On 0.5.x that command does
   not exist, so the knowledge child would have failed to start. It is now selected from the
   resolved package's version. Separately, and worth stating plainly: the 0.5.0 knowledge server
   **execs an external `graphify serve`** — the graph tool declarations are not in the published
   package, so what ships is the degraded no-graph server. The MCP reports that as a **data gap in
   the server's own answer**, not as an MCP failure (`source-inspected`, verified against both
   tarballs in memory during task C2).
2. **Performance.** The MCP previously invoked `perf monitor run`. The 0.5.0 router explicitly
   permits `live`, not `monitor`, so that argv is rejected by the new router. The wrapper now
   dispatches `perf live run` from capability evidence, and on a 0.4.x line — where no live route
   exists at all — it refuses rather than substituting a different command. The 2026-09-16
   host-only completion pass added explicit device selection to this lane: `pico_perf` takes an
   optional `device`, `perf_diagnose` forwards it, and every outcome reports `requestedDevice`.
   The lane's default target is unchanged and remains a disclosed gap, not a fix.

## Review of the official 0.5 Editor bootstrap workflow controller

Read from the 0.5.0 package source (`source-inspected`; excerpts BOOTSTRAP050, EDITOR_START050,
EDITOR_WAIT050, EDITOR_PACK050, EDITOR_MODES050, EDITOR_AUTH050, LOCAL_BIND050 in
`evidence/2026-09-15-cli050-sdk61-evolution-audit-001/CLI050_STATIC_EXCERPTS_001.json`). Nothing was
launched; no Editor session was started at any point in this checkpoint.

What 0.5.0 declares:

- `editor bootstrap` is still the gateway, but its 0.5.0 contract now names **default and
  conditional side effects**, including schema-probe processes and possible owner cleanup. It must
  not be treated as an inert metadata read.
- `package/dist/bootstrapServer-*.js` carries a managed production/revision **Controller** absent
  from the old monolithic index: `start_editor_workflow`, `resume_editor_workflow`,
  `wait_editor_workflow`, `advance_editor_workflow`, status/cancel, plus agent manifest, scene plan,
  scene mutation, supplemental evidence and **visual review submission**, with explicit user-decision
  submission and bounded retry gates.
- `pack_editor_bundle` declares a stable package result and a co-located `<bundleName>.scenes.json`
  sidecar, can derive the bundle path under a target app's `app/src/main/assets`, accepts explicit
  scene files, and has bounded polling options.
- GUI/headless mode switching is **not** a window toggle: it saves, closes and restarts the managed
  Editor session.
- Model generation has an `EDITOR_API_KEY_REQUIRED` branch. That is a conditional provider
  requirement, not evidence of a CLI-wide or emulator sign-in requirement. No credential was used or
  tested here.

**The integration rule, stated so it can be enforced:**

> Consume the Editor's **manifest and review artifacts** for app integration — validate the bundle
> and its `.scenes.json` sidecar, and bind them to independently earned app build evidence. Do not
> build a parallel production Controller inside this MCP, and do not launch `editor bootstrap` as if
> it were a read.
>
> **An Editor decision is not app evidence and is not native evidence.** The Controller can submit a
> "visual review" and mark a workflow complete. That is the Editor's judgement about authored
> content. This repository's acceptance rule is unchanged and unrelated: a frame captured from a
> running app, looked at by someone, and hash-bound to the claim. An Editor-side approval never
> satisfies it, and must never be recorded through `record_verification` as though it had.

`--bind-mcp-to-local-cli` (`index.js:172`, LOCAL_BIND050) is explicitly labelled test automation for
a validated SpatialCraft checkout. It is not an instruction to bind this independent MCP to arbitrary
local source, and it was not run.

## Dated retained lessons: the version-scope rule

During the audit, `pico_fix` was called with the perf-utilities error text. It returned no
diagnosis-KB symptom match, but the retained-lessons lint fired a **warning** from a dated rule
(`evidence/2026-09-15-cli050-sdk61-evolution-audit-001/PICO_FIX_HELP_UTILITIES_002.json`,
`host-executed`):

```
ruleId   pico-cli-interactive-hangs   severity warn   learned: true
message  Top-level `pico-cli doctor`, `pico-cli plugin update`, `pico-cli plugin doctor`, and bare
         `pico-cli setup` hang when run non-interactively from an agent (interactive prompts/
         spinners, no output). Verified 2026-07-12: all hung with empty output files; sub-doctors
         returned instantly.
fix      Use the non-interactive surfaces: `pico-cli setup --tool claude-code --yes`,
         `pico-cli emulator doctor --format json`, `pico-cli mcp doctor`,
         `pico-cli device list --format json`. …
```

The rule matched on keywords. Its *fix* recommends `pico-cli mcp doctor` — a command **0.5.0
removed**. It was read and **not applied**; nothing in this checkpoint runs it.

The rule was **not deleted**, and the user's local lesson store was not modified. A lesson is dated
evidence of what was true on a CLI line at a point in time, and deleting it would destroy the record
of a real hang. The rule for reading one:

> **A retained lesson is scoped to the CLI version it was verified against. Its `message` stays
> valid as history; its `fix` is a command contract only for that line.** A keyword match is a
> prompt to re-check the current version's registration — never authority to run the command it
> names. Before acting on a lesson's `fix`, confirm each command it names still exists in the
> resolved package's registration (that is what the route table in `src/clicapabilities.ts` does for
> the routes this server actually dispatches).

Concretely: this lesson was verified 2026-07-12 against a 0.3.x/0.4.x line. On 0.5.0, `mcp doctor`
is gone and `knowledge doctor` replaced it. Applying the lesson's fix verbatim on a 0.5.x host would
run a command that does not exist.

## What this page does not establish

- That any 0.5.0 command works. No 0.5.0 command was executed through the managed CLI on this host;
  the active cached version here is 0.4.4.
- That any delegated route succeeds end to end. The perf and trace routes in particular have **no
  retained exit-0 help on either line** — every perf help observation exited at the CLI's utilities
  gate, because the profiler payload is not provisioned on this host.
- Anything about Windows or Linux, about a physical device, or about a rendered frame.
