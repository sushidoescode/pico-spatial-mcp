# pico-cli 0.4.2 re-verification sweep — 2026-08-12

Referenced by docs/ANSWERED_BY_MEASUREMENT.md Q37. Evidence class: `structural` (verbatim
`--help` captures + exit codes from bounded `spawnSync` runs; nothing here involves a rendered
frame).

## Method

- Installed: `pico-cli/0.3.0 (public) darwin-arm64 node-v25.8.1` (global, untouched).
- Candidate: `@picoxr/pico-cli@0.4.2` (npm latest; 0.4.1 and 0.4.2 both published 2026-08-08),
  installed into a session scratchpad prefix — the machine's global install was not modified.
- Fifteen `--help` surfaces captured per version (root + perf/perf monitor/perf trace/
  perf daemon/app/capture/emulator/device/files/log/mcp/plugin/project/doctor), plus
  second-level probes and behavior checks, every spawn bounded (20s, SIGKILL).
- `pico-cli setup` was NOT run (it mutates the machine); everything behind the 0.4.x
  utilities gate is explicitly unverified.

## Findings

1. **Perf family gated behind `pico-cli setup` (0.4.2).** Every `perf ...` invocation —
   including `perf --help` — exits 1 with `Error: Perf utilities 0.1.0 are not installed.
   Run \`pico-cli setup\` to install.` On 0.3.0 the full perf tree responds normally.
   → `classifyPicoCliFailure` now returns `not-provisioned` for this signature; wrapper
   notes carry the exact remedy and state that the wrapper never runs setup itself.
   The 0.4.2 perf flag surface BEHIND the gate is unverified.
2. **`mcp spatial-knowledge` → `mcp dev-knowledge`.** 0.4.2's `mcp --help` lists only
   `dev-knowledge`; `mcp spatial-knowledge --help` still exits 0 and prints the
   dev-knowledge usage — a working hidden alias. `knowledge_api` keeps invoking the alias
   (0.3.0-compatible); a future removal fails loudly with the CLI's own words.
3. **`app watch-crash`: still NO duration flag on 0.4.2.** Adds only
   `--launch-timeout <seconds>` (default 30; wait for the process to appear). The
   watch_crash kill-bound remains required.
4. **`capture record` / `capture screenshot` / `emulator status` / `app launch|stop|list` /
   `device` / `log` (bar one flag): help surfaces byte-identical to 0.3.0.** `log` gains
   `-d, --device`. `capture record` keeps `-t` 1–180s.
5. **`files rm` defaults fixed upstream:** recursive and force both default `true` on
   0.3.0, both `false` on 0.4.2.
6. **`app install` gains** `-r/--replace`, `--downgrade`, `-t/--test`,
   `-g/--grant-permissions`.
7. **`doctor` no longer hangs on 0.4.2:** `doctor --format json` returned a structured
   JSON envelope (tool_status/summary/data.checks with per-check nextAction strings) in
   9.7s, exit 0, on this machine. The 0.3.0 measurement (≥90s hang, 2026-08-01) stands for
   0.3.0. The `-v` probe stays: sub-second beats ~10s for a per-call gate, and 0.3.0
   remains the common install.
8. **New 0.4.2 command families:** `update` (`--check` read-only, `-y`), `editor`
   (bootstrap/doctor/install — Spatial Editor lifecycle + a "gateway MCP server"),
   `web` (launch/setup), `project context doctor` (`--project`, `--plugin`). `doctor`
   gains `--platform spatial|unity`, `--tool codex|traecli|claude-code|cursor|copilot|all`,
   `--project`, `--fix`.
9. **Exit codes re-measured:** unknown top-level and unknown subcommands exit **1** with
   `Error: Unknown command: ...` on BOTH versions. (The earlier inventory note that unknown
   commands "exit 0 with help text" did not reproduce in these shapes; 0.3.0 prints the
   root help on unknown families but still exits 1.) `perf daemon status` with the daemon
   down still exits **0** on 0.3.0 (JSON `success:false`) — the core reason
   `classifyPicoCliFailure` never trusts exit codes alone. On 0.4.2 the same command hits
   the utilities gate (exit 1) on an un-setup machine.
10. **`-v` output shape unchanged:** `pico-cli/0.4.2 (public) darwin-arm64 node-v25.8.1` —
    version parsing in `probePicoCli` holds across 0.4.x.

## Code changes carried

`src/picocli.ts` (not-provisioned class + dated comments), `src/perfcli.ts`,
`src/perftrace.ts`, `src/picoclitools.ts` (three-way failure notes + dual-version claims),
`src/knowledge.ts` (alias note), `src/preflight.ts` (doctor re-measurement note),
`test/picocli.mjs` (classifier cases).

## Not proven

End-to-end 0.4.2 behavior against a device/emulator; the perf surface behind the setup
gate; alias longevity; doctor timing on other machines/platforms.
