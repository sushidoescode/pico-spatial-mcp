# pico-cli 0.4.2 re-verification sweep — 2026-08-12

Referenced by docs/ANSWERED_BY_MEASUREMENT.md Q37. Evidence class: `structural` (verbatim
`--help` captures, packaged-source inspection, and exit codes/timings from bounded `spawnSync`
runs; nothing here involves a rendered frame).

## Method

- Installed: `pico-cli/0.3.0 (public) darwin-arm64 node-v25.8.1` (global, untouched).
- Candidate: `@picoxr/pico-cli@0.4.2`, observed as npm `latest` on 2026-08-12; 0.4.1 and
  0.4.2 were both published on 2026-08-08. It was installed into a session scratchpad prefix;
  the machine's global install was not modified.
- Exactly fifteen named `--help` surfaces were targeted per version, not a complete
  command-by-command or semantic diff: `pico-cli --help`, `perf --help`,
  `perf monitor --help`, `perf trace --help`, `perf daemon --help`,
  `app --help`, `capture --help`, `emulator --help`, `device --help`, `files --help`,
  `log --help`, `mcp --help`, `plugin --help`, `project --help`, and `doctor --help`.
  Selected second-level help and bounded behavior probes supplemented them.
- Executed behavior probes covered the perf setup gate, version output, unknown-command
  exits, `perf daemon status`, the renamed command and hidden alias through their `--help`
  paths, and `doctor --format json`. Flag/default/registration claims for commands that could
  mutate a host or device came from help output and packaged-source inspection; their command
  bodies were not run.
- A later independent help-only review widened coverage across registered command paths in
  both packages. It found omissions in the initial targeted summary; those corrections are
  recorded below without retroactively describing the initial sweep as exhaustive.
- `pico-cli setup` was NOT run (it mutates the machine); everything behind the 0.4.x
  utilities gate is explicitly unverified.

## Findings

1. **Perf family gated behind `pico-cli setup` (0.4.2).** Every tested `perf ...` shape —
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
   watch_crash kill-bound remains required. This is a help/source finding; the indefinitely
   running watcher was not started.
4. **Help equality is narrower than initially reported.** `capture record`, `capture
   screenshot`, `emulator status`, `app stop`, `app list`, and `device` are byte-identical to
   0.3.0. `app launch` is **not** byte-identical: 0.4.2 adds an Examples block explaining
   that launch waits for process creation and app-specific readiness must be polled
   separately. `log` gains `-d, --device`. `capture record` keeps `-t` 1–180s.
5. **`files rm` defaults fixed upstream:** recursive and force both default `true` on
   0.3.0, both `false` on 0.4.2. Help and parser registration establish the defaults; no
   remote deletion was attempted.
6. **`app install` gains** `-r/--replace`, `--downgrade`, `-t/--test`,
   `-g/--grant-permissions`. Help and source wiring establish the flags; no APK was installed.
7. **`doctor` returned within the bounded 0.4.2 probes:** `doctor --format json` returned a
   structured JSON envelope (tool_status/summary/data.checks with per-check nextAction strings)
   in 9.7s, exit 0, on this machine. The earlier 0.3.0 measurement (≥90s, 2026-08-01) was not
   repeated in this sweep. Independent repetitions on the same machine completed in
   2.956–7.256s, also exit 0. The returned envelope can itself have `tool_status: FAILED`;
   process exit 0 proves completion, not a healthy environment. The `-v` probe stays as the
   per-call gate because
   it is consistently sub-second while doctor timing varies, and it works on both measured
   versions.
8. **Additional visible 0.4.2 command/help deltas (targeted, not exhaustive):**
   - New root families are `update`, `editor`, and `web`. `editor --help` lists
     bootstrap/doctor/install/pack/start/status/stop/sync component/uninstall; `web` lists
     launch/setup. `project context doctor` adds project-context inspection.
   - `doctor` gains `--platform spatial|unity`,
     `--tool codex|traecli|claude-code|cursor|copilot|all`, `--project`, and `--fix`.
   - `update --check` writes `~/.pico/update-check.json` after an npm registry request, so it
     is non-installing but not host-read-only. This is from packaged-source inspection; the
     command was not executed during the independent audit. Its help says "without modifying
     the installation", and `update` also gains `-y`.
   - Root `shell` and `device shell` gain `-d/--device`.
   - `setup` gains `--platform spatial|unity` plus constrained tool/plugin choices.
   - `plugin doctor` gains `--fix` plus constrained tool/plugin choices; `plugin update`
     gains constrained choices, and the parent `plugin --help` doctor description changes.
   - `project create` now marks name/package/template required, adds
     `--sdk-type spatial|unity` and Unity templates, and revises `--force` and examples.
   - Emulator start/create/install source choices drop `internal` and add
     `beta_cn|beta_global`.
   These items are help/source findings. Their updating, setup, plugin-repair, project-create,
   shell, and emulator command bodies were not executed.
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

A complete 0.3.0-to-0.4.2 diff; runtime behavior for help/source-only deltas; end-to-end 0.4.2
behavior against a device/emulator; the perf surface behind the setup gate; alias longevity;
doctor timing on other machines/platforms.
