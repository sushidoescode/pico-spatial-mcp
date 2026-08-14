# Task 5 implementer report — safe version-agnostic CLI help sweep

Date: 2026-08-14

## Revision and scope

- Requested and verified base: `9ab96c3594cfd25478f2d057d02ab1bf622c46a6`.
- Result head: the Task 5 commit containing this report (`git rev-parse HEAD` is reported in the
  parent handoff because a commit cannot embed its own content-addressed hash).
- Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/pico-evolution-2026-08-14`.
- Changed scope is exactly `scripts/compare-picocli-surfaces.mjs`, `test/picocli-sweep.mjs`,
  `.github/workflows/picocli-compat.yml`, `package.json`, and this tracked report.
- Task 4's `test/helpers/picocli-managed-fixture.mjs` was not modified.
- No push, remote, visibility, permission, or global CLI/PATH mutation was performed.

## TDD evidence

The self-contained fake npm and fake versioned CLI tree were authored before the production script.
An initial `node --check` caught and corrected an unquoted hyphenated fixture key; this was a test
syntax error, not the feature RED. The syntax-valid requested RED was then witnessed with:

```text
node --test test/picocli-sweep.mjs
```

It exited 1 because `scripts/compare-picocli-surfaces.mjs` did not exist. The 18 declared leaf cases
reported five failures centered on the missing success path/depth evidence; negative failure cases
could already observe a nonzero child exit from the absent script and therefore passed. The failure
included `MODULE_NOT_FOUND` for the exact absent production path.

After the initial GREEN, self-review identified a missing signal boundary. A fake help process was
made to terminate by `SIGTERM`; the full focused run went RED because the comparison incorrectly
accepted a null exit code and emitted a report. The minimal production fix makes signal termination
fatal while continuing to hash ordinary numerical nonzero help exits.

The final focused/full suites cover:

- literal added, removed, changed, and unchanged arrays plus hand-derived SHA-256 values over exact
  retained `stdout` bytes followed by exact retained `stderr` bytes, including numerical nonzero help;
- exact ANSI-stripped `Commands:` section parsing, minimum positive indentation, next-section stop,
  duplicate rows, required/optional argument notation, conservative `_:-` command tokens including
  a colon-bearing command, command-like option rows, and nested trees;
- centralized CLI argv safety (`-v` or terminal `--help` only), top-level `setup` exclusion, and no
  `update --check`, with required safe visits to doctor, emulator, and device help paths;
- breadth-first queued/visited dedupe, maximum eight command tokens, and maximum 256 help invocations,
  both failing closed without a report;
- `latest` registry resolution, exact stable-version installs under separate owned temp prefixes,
  installed package/CLI version agreement, and rejection of duplicate/unknown flags, relative output,
  malformed/outage registry evidence, install failure, and version mismatch;
- fatal timeout, spawn error, signal termination, and output truncation; preexisting-output refusal;
  and cleanup of atomic report temporaries.
- identical owned-session cwd, `HOME`, `USERPROFILE`, uppercase/lowercase npm cache, npm user config,
  and XDG roots for every npm/CLI child, with both install prefixes beneath that session and the
  canonicalized session root absent after completion.

## Implementation

`compare-picocli-surfaces.mjs` accepts only the documented three flag/value pairs. It resolves only
the `to` value `latest`, validates the exact registry object, and installs both requested sides with:

```text
npm install --prefix <owned-temp-root> --no-save --package-lock=false --fund=false --audit=false @picoxr/pico-cli@<exact-version>
```

It executes no shell. Every CLI spawn crosses one centralized guard and is either exact `-v` or an
advertised command-token path ending in `--help`. Traversal is bounded, breadth-first, deterministic,
and excludes only the prohibited top-level `setup` subtree. Complete stdout and stderr buffers are
hashed without parser normalization. Timeout, spawn failure, signal, or capture truncation aborts the
comparison; a numerical nonzero help exit remains comparable data.

Before any child is started, the script creates one canonical owned session root. Every npm and CLI
child runs from its owned `cwd` with isolated `HOME`, `USERPROFILE`, uppercase/lowercase npm cache and
user-config variables, and XDG config/cache/data roots. The two requested package prefixes are
separate temp roots inside that session. Fixture control variables and the selected `PATH` are
otherwise preserved. The script recursively removes only that exact session root in `finally`.

The root report key is `pico-cli`; descendants are unprefixed paths such as `emulator status`. All
arrays are sorted. An output path must be absolute, have an existing parent, and not preexist. The
fully written and fsynced same-directory temporary is published without clobbering via an atomic hard
link, then removed. The report path is printed only after both trees and report publication complete.

`test:picocli` remains one existing `test:*` suite and now runs the sweep tests after the managed
tests. The repository still has 44 `test:*` suites plus `smoke`, preserving the published 45 gate
invocations. No other script changed.

The scheduled/manual Ubuntu workflow uses Node 22, `npm ci`, and the build before comparing `0.4.2`
to `latest`. Its summary distinguishes a complete report from unavailable/incomplete evidence. The
artifact upload is conditional on comparison success and requires the report to exist, so failed or
incomplete runs publish no comparison artifact. It is observational and does not alter product gates.

## Final verification

- `npm run build` — PASS (`tsc`, exit 0).
- Persistent-PTY `npm run test:picocli` — PASS: legacy lane `Failures: 0`; combined managed+sweep
  Node runner `76` tests, `76` pass, `0` fail, exit 0. This includes all Task 5 registry-outage and
  signal cases.
- Focused `node --test test/picocli-sweep.mjs` — PASS: `20` tests, `20` pass, `0` fail, exit 0,
  after the child-environment/cwd isolation and colon-token RED.
- Static package/workflow/script assertions — PASS: `STATIC_SAFETY_OK battery=45
  workflow=observational argv-guard=central shell=false`.
- Ruby YAML parse — PASS (`YAML_PARSE_OK`). `actionlint` was not installed, so no actionlint claim is
  made.
- `node --check` for both new `.mjs` files — PASS.
- `git diff --check` — PASS, no output.

## Fixture isolation incident

During one early focused GREEN run, the deliberate missing-npm case replaced the fake bin with an
empty directory but the harness still appended ambient `PATH`. That case could therefore resolve the
host npm and attempted the same exact non-global install under its owned temporary prefix before
failing in about one second. There were no global flags, setup/update-check, emulator, or device
commands, and the owned temp root was cleaned, but registry and npm-cache contact during that one
early run cannot be ruled out.

The flaw was found during the invocation-log audit. All fake npm/CLI scripts now have an absolute
Node shebang and every sweep test uses a fake-only `PATH`. Subsequent focused and full gates are
hermetic; the missing-npm case now returns a spawn failure in roughly 38 ms with no ambient fallback.
Accordingly this report does not claim that the entire implementation session had zero network
contact, only that the final tests enforce and demonstrate isolated fake execution.

## Assumptions and evidence limits

- The report describes the complete reachable advertised help-only tree, excluding the prohibited
  top-level `setup` subtree. It does not prove runtime compatibility, hidden aliases, setup-gated
  descendants, emulator/device behavior, or command side effects beyond help boundaries.
- No emulator, device, Swan, visual frame, or native Windows environment was exercised. No visual or
  device verification claim applies.
- The workflow is Ubuntu-only observational evidence. The implementation names a Windows `.cmd`
  package shim but Task 5 does not establish native Windows execution.
- Ordinary numerical nonzero help output is intentionally evidence; signal, timeout, spawn failure,
  and output truncation mean the tree is incomplete and prevent report publication.
- A preexisting output is deliberately preserved and causes a nonzero exit rather than being
  overwritten.

## Review fix round — total fail-closed Commands parsing

Review at `a3294e608f1b901b7670572af19d57286f00fc35` identified that minimum-indent
`Commands:` rows outside the accepted token grammar were silently omitted. End-to-end fake trees
confirmed `foo|f` and `foo.bar` each produced an exit-0 root-only report, and a valid row mixed with
an unsupported alias produced a partial exit-0 report. A peer-indented `Options:` heading was parsed
as the colon-bearing command `Options:` and hashed as an extra command.

The root cause was the parser's partial classification: it added regex matches and ignored every
non-match. Colon support also allowed a trailing colon, so it could not distinguish a section heading
from a command. The fix classifies every minimum-positive-indent peer row before traversal:

- exact `Options:`, `Arguments:`, `Positionals:`, `Examples:`, and `Global Options:` headings end the
  command section;
- command syntax is separated from a description at the first two-or-more-space column boundary;
- command tokens accept alphanumeric/underscore/hyphen segments and internal colon-separated
  segments, but no trailing colon, alias bar, dot, or other punctuation;
- suffix syntax accepts only bracketed required/optional argument notation; and
- any other peer row throws `unsupported advertised command grammar`, aborting before a partial child
  set is traversed or a report is published.

Deeper-indented wrapped descriptions remain prose. The adversarial success fixture includes alias and
dot text in both the description column and a wrapped description, proving those strings are not
misclassified as command grammar. The exact ANSI-stripped, unindented English `Commands:` heading
remains the only section start.

Review-round TDD and verification evidence:

- RED: `node --test --test-name-pattern='unsupported grammar|indented Options'
  test/picocli-sweep.mjs` — exit 1, `5` tests failed. The alias, dotted, and mixed cases each observed
  an incorrect exit 0; the indented heading case observed `commandCount:3` instead of `2`.
- Focused GREEN for the same command — `5/5` pass, exit 0.
- `node --test test/picocli-sweep.mjs` — `25/25` pass, exit 0.
- `npm run build` — PASS (`tsc`, exit 0).
- Persistent-PTY `npm run test:picocli` — PASS: legacy lane `Failures: 0`; combined managed+sweep
  runner `81/81` pass, `0` fail, exit 0.
- Static safety assertions — PASS: `STATIC_SAFETY_OK parser=total-fail-closed battery=45
  workflow=observational`.
- YAML parse — PASS (`YAML_PARSE_OK`); both new `.mjs` syntax checks pass.
- `git diff --check` — PASS, no output.
- The real managed root was absent before the fix round and after all gates
  (`REAL_ROOT_ABSENT_AFTER_GATES`).

This fix round used the existing fake-only PATH, isolated owned cwd/home/npm-cache session, and temp
install prefixes. It made no real npm/registry, global CLI, setup, update-check, emulator/device,
Swan, visual, native Windows, remote, permission, or visibility operation.
