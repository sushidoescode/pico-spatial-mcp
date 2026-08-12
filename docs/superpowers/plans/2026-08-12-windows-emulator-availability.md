# Windows Emulator Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine, from a real Windows execution and an attributable upstream response, whether PICO currently ships a Windows emulator bundle before changing any Windows emulator code.

**Architecture:** Add a manually dispatched Windows GitHub Actions probe that installs only the public `@picoxr/pico-cli` command into an ephemeral runner, reuses the repository's bounded `runPicoCliCommand` process-tree runner, and uploads one JSON evidence artifact. Record the result in a dated finding; if the CLI channel does not decisively identify a Windows bundle, ask Matt and Rik on a private-repository issue and stop the implementation lane pending their answer.

**Tech Stack:** GitHub Actions (`windows-latest`), Node.js 22, npm, `@picoxr/pico-cli`, Markdown evidence records, GitHub CLI.

## Global Constraints

- `sushidoescode/pico-spatial-mcp` remains PRIVATE; never change visibility or collaborator permissions.
- A Windows support statement requires a command that actually ran on Windows; macOS inspection is context only.
- “Verified” remains reserved for a looked-at rendered frame. This phase can earn only structural/source evidence and must never create a visual claim.
- Do not invoke `pico-cli emulator install` without `--help`; the probe may install the CLI in its disposable runner but must not download an emulator bundle.
- Bound every spawned command, cap its captured output, and preserve exit code, stdout, stderr, timeout state, CLI version, OS version, architecture, timestamp, workflow run, and commit SHA.
- Do not touch `src/toolchain.ts`, `src/emulator.ts`, `src/grpc.ts`, `src/cameradrive.ts`, `src/hostgui.ts`, tool counts, or platform-truth prose until this plan has produced a recorded answer.
- If the availability result is negative or still unknown after the two permitted routes, document the ceiling and stop; do not guess Windows paths or lifecycle behavior.

---

### Task 1: Bounded Windows Install-Channel Probe

**Files:**
- Create: `test/windows-emulator-probe.mjs`
- Create: `scripts/probe-windows-emulator.mjs`
- Create: `.github/workflows/windows-emulator-probe.yml`
- Test: `node --test test/windows-emulator-probe.mjs` locally and on `windows-latest`

**Interfaces:**
- Consumes: `runPicoCliCommand(command, args, options)` and `resolvePicoCliPath(env, platform)` from `dist/picocli.js`, plus the public npm package `@picoxr/pico-cli`.
- Produces: Actions artifact `windows-emulator-probe/windows-emulator-probe.json` with top-level fields `schemaVersion`, `observedAtUtc`, `commitSha`, `runner`, `npmLatest`, `cliInstall`, `cliVersion`, `emulatorInstallHelp`, and `emulatorStatus`.

- [ ] **Step 1: Write the failing report-contract test**

Create `test/windows-emulator-probe.mjs`. Import `collectWindowsEmulatorProbe` from `../scripts/probe-windows-emulator.mjs`; inject a deterministic clock, Windows runner environment, CLI resolver returning `C:\\npm\\pico-cli.CMD`, and a fake external-command boundary that records invocations and returns the complete `PicoCliCommandResult` shape. Assert the literal five-command sequence, 30/120-second bounds, 64-KiB cap, `--help` on the emulator-install call, runner identity, commit SHA, observation time, and preserved non-zero result fields. The expected command sequence must be hand-written literals, not built with the implementation's helpers.

- [ ] **Step 2: Run the test and observe RED**

Run:

```bash
node --test test/windows-emulator-probe.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/probe-windows-emulator.mjs`. Any syntax or assertion error is the wrong failure and must be corrected before implementation.

- [ ] **Step 3: Implement the minimal probe module**

Create `scripts/probe-windows-emulator.mjs` exporting:

```js
export async function collectWindowsEmulatorProbe({
  env = process.env,
  platform = process.platform,
  runCommand = runPicoCliCommand,
  resolveCli = resolvePicoCliPath,
  now = () => new Date(),
} = {})
```

Reject any `platform` other than `win32`. Execute the five literal commands from Step 1 in order. Pass `{ env, timeoutMs, maxOutputBytes: 64 * 1024 }` to every runner call; use 120,000 ms only for npm's CLI install and 30,000 ms elsewhere. Resolve the installed CLI only after npm install. Normalize each command result to `{ command, arguments, exitCode, signal, timedOut, stdout, stderr, spawnError, outputTruncated }`, retaining non-zero results instead of throwing. The returned report must match the `Produces` interface above and include `runner.os`, `runner.image`, `runner.architecture`, `runner.osVersion`, and `runner.node`.

When executed as the main module, require `PICO_WINDOWS_PROBE_OUT`, call the exported function, create only that output file's parent directory, write pretty JSON with a trailing newline, and print the same JSON. Do not execute the main path when imported by the test.

- [ ] **Step 4: Run the focused test and observe GREEN**

Run:

```bash
node --test test/windows-emulator-probe.mjs
```

Expected: all probe-contract tests pass with pristine output.

- [ ] **Step 5: Add a manual Windows workflow**

Create `.github/workflows/windows-emulator-probe.yml` with this content:

```yaml
name: windows-emulator-probe

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  probe:
    runs-on: windows-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Verify the probe contract
        run: node --test test/windows-emulator-probe.mjs
      - name: Probe the official emulator install channel
        env:
          PICO_WINDOWS_PROBE_OUT: ${{ runner.temp }}\windows-emulator-probe.json
          PICO_WINDOWS_PROBE_SHA: ${{ github.sha }}
        run: node scripts/probe-windows-emulator.mjs
      - name: Upload the bounded evidence record
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: windows-emulator-probe
          path: ${{ runner.temp }}\windows-emulator-probe.json
          retention-days: 30
          if-no-files-found: error
```

- [ ] **Step 6: Validate the workflow and script statically before push**

Run:

```bash
git diff --check
npx --yes prettier@3.6.2 --check .github/workflows/windows-emulator-probe.yml
node --check scripts/probe-windows-emulator.mjs
git diff -- test/windows-emulator-probe.mjs scripts/probe-windows-emulator.mjs .github/workflows/windows-emulator-probe.yml
```

Expected: no whitespace errors, YAML formatting passes, and the diff contains no emulator-install invocation lacking `--help`.

- [ ] **Step 7: Commit the probe for review**

Run:

```bash
git add docs/superpowers/plans/2026-08-12-windows-emulator-availability.md test/windows-emulator-probe.mjs scripts/probe-windows-emulator.mjs .github/workflows/windows-emulator-probe.yml
git commit -m "probe(windows): measure the emulator install channel"
```

Expected: the task commit is reviewable on the isolated branch. Do not push until the task review is clean.

---

### Task 2: Run and Classify the Windows Evidence

**Files:**
- Read: downloaded `windows-emulator-probe.json`
- Create: `docs/findings/WINDOWS_EMULATOR_AVAILABILITY_2026-08-12.md`

**Interfaces:**
- Consumes: the exact artifact emitted by Task 1 and its GitHub Actions run URL.
- Produces: one of `available`, `not-advertised`, or `inconclusive`, with quoted command diagnostics kept below the repository’s disclosure limits and a SHA-256 digest of the raw JSON artifact.

- [ ] **Step 1: Dispatch the probe at the pushed SHA**

Run:

```bash
git push origin HEAD:main
gh workflow run windows-emulator-probe.yml --repo sushidoescode/pico-spatial-mcp --ref main
gh run list --repo sushidoescode/pico-spatial-mcp --workflow windows-emulator-probe.yml --limit 1 --json databaseId,headSha,status,conclusion,url
```

Wait for that exact run with:

```bash
windows_probe_run_id="$(gh run list --repo sushidoescode/pico-spatial-mcp --workflow windows-emulator-probe.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$windows_probe_run_id" --repo sushidoescode/pico-spatial-mcp --exit-status
```

Expected: the workflow completes and the reported `headSha` equals the pushed commit.

- [ ] **Step 2: Download and inspect the evidence artifact**

Create a task-scoped temporary directory and download the artifact with:

```bash
windows_probe_artifacts="$(mktemp -d)"
gh run download "$windows_probe_run_id" --repo sushidoescode/pico-spatial-mcp --name windows-emulator-probe --dir "$windows_probe_artifacts"
shasum -a 256 "$windows_probe_artifacts/windows-emulator-probe.json"
jq . "$windows_probe_artifacts/windows-emulator-probe.json"
```

Expected: `runner.os` is `Windows`, `commitSha` matches, every requested command has a bounded result, and no command invocation installed an emulator payload.

- [ ] **Step 3: Apply the evidence classification rule**

Classify exactly as follows:

```text
available       = Windows help/status output explicitly identifies a Windows emulator bundle or a Windows-specific obtainable payload.
not-advertised  = Windows help/status explicitly says win32 is unsupported, no compatible artifact exists, or the channel is macOS-only.
inconclusive    = the command exists but generic help/status neither identifies nor denies a Windows payload, or the channel is unavailable/auth-gated.
```

Do not translate `not-advertised` into “PICO has no Windows emulator anywhere”; it means only that the tested official CLI channel did not advertise one at the observed version and time.

- [ ] **Step 4: Write the measured finding**

Create `docs/findings/WINDOWS_EMULATOR_AVAILABILITY_2026-08-12.md` with sections `Evidence boundary`, `Commands and observations`, `Answer`, and `Consequence for this lane`. The evidence boundary must include the concrete run URL, commit SHA, Windows runner image, CLI version, artifact SHA-256, and the sentence `Evidence class: structural/source only; no emulator was booted and no frame was rendered or looked at.` The command table must include all four non-install observations; `Answer` must contain exactly one classification term from Step 3 followed by a claim scoped to the observed channel. The committed document must contain no placeholder tokens.

---

### Task 3: Resolve or Stop at the Availability Gate

**Files:**
- Modify: `docs/findings/WINDOWS_EMULATOR_AVAILABILITY_2026-08-12.md`
- Optionally create: one private GitHub issue (external repository state, no source file)

**Interfaces:**
- Consumes: Task 2’s classification.
- Produces: either an attributable path to a real Windows emulator-machine test, or an explicit documented ceiling that stops this lane.

- [ ] **Step 1: Branch only on the recorded classification**

If `available`, do not write any path constant yet. Record the exact next prerequisite: a Windows machine on which that bundle is installed and booted so install root, AVD home, discovery directory, binary names, flags, and process behavior can be observed empirically.

If `not-advertised` or `inconclusive`, create a private-repository issue with `gh issue create --repo sushidoescode/pico-spatial-mcp --title "Windows emulator bundle availability: upstream confirmation needed" --body "$windows_issue_body"`. Define `windows_issue_body` immediately beforehand from the concrete Actions run URL and classification. The body must ask `@mattbelland` whether a Windows PICO OS 6 emulator bundle exists and where it is officially installed, ask `@rikturnbull` whether the Windows Spatial plugin offers or installs an emulator payload, link `docs/findings/WINDOWS_EMULATOR_AVAILABILITY_2026-08-12.md`, and explicitly say no permissions or visibility changes are requested.

- [ ] **Step 2: Commit the finding**

Run:

```bash
git add docs/findings/WINDOWS_EMULATOR_AVAILABILITY_2026-08-12.md
git commit -m "docs(windows): record the measured emulator availability ceiling"
git push origin HEAD:main
```

Expected: the commit claims no more than the Windows artifact proves.

- [ ] **Step 3: Verify the normal four-job gate at both pushed commits**

For each pushed SHA, run:

```bash
windows_gate_sha="$(git rev-parse HEAD)"
windows_gate_run_id="$(gh run list --repo sushidoescode/pico-spatial-mcp --workflow gates.yml --commit "$windows_gate_sha" --json databaseId --jq '.[0].databaseId')"
gh run watch "$windows_gate_run_id" --repo sushidoescode/pico-spatial-mcp --exit-status
gh run view "$windows_gate_run_id" --repo sushidoescode/pico-spatial-mcp --json jobs
```

Expected: `picocli-windows`, both Node matrix instances of `gates`, and `vcam-native` all conclude `success`.

- [ ] **Step 4: Enforce the programme stop/continue rule**

If no emulator is both officially obtainable and available for a real Windows machine-run, stop. Do not start path resolution, lifecycle, gRPC, capture, tool-count, or CI-widening changes. If a real Windows machine becomes available with the bundle installed, write a new implementation plan from its measured filesystem/process/discovery evidence before editing product code.
