# Task 7 sweep boundedness and grammar remediation

Date: 2026-08-14

## Revision and scope

- Clean starting revision: `528ddb9f907038539720e9a5dfcf942b7be681c5`.
- Owned production scope: `scripts/compare-picocli-surfaces.mjs`.
- Owned test scope: `test/picocli-sweep.mjs`.
- No workflow, measured finding, generated surface report, managed resolver, global CLI, retained proof
  root, remote, visibility, or permission state was changed.

## Review findings reproduced before implementation

The exact-install fixture allowed the prior eight-argument npm command and simulated a package
postinstall side effect when `--ignore-scripts` was absent. The new exact-argv assertion failed on
the missing flag before production changed.

The root-help fixture then demonstrated two separate incompleteness bugs: `Available Commands:` was
silently reduced to a root-only report, while root help with no command heading or an unrecognized
`Subcommands:` heading incorrectly published a successful root-only report. A separate nested-leaf
case already passed, proving that only the root needs an explicit recognized heading.

Finally, a fake CLI spawned a detached descendant that inherited its stdout/stderr and then hung.
With a 1.5-second command timeout, the old runner remained blocked on `close` until the enclosing
four-second test-process timeout killed the sweep, and it emitted no sweep timeout diagnostic.

## Implementation

- Scratch installs now use the exact non-global argv
  `npm install --prefix <root> --ignore-scripts --no-save --package-lock=false --fund=false
  --audit=false @picoxr/pico-cli@<exact-version>`.
- Both exact root headings, `Commands:` and `Available Commands:`, are recognized. Missing or
  unrecognized root headings fail closed before a report is written; nested heading-less leaves
  remain valid.
- Timeout and output-cap aborts snapshot inspectable POSIX descendants, signal descendant
  processes/groups plus the CLI process group, escalate after a bounded grace, destroy held stdio,
  and settle without waiting for descendant-held pipes. Windows retains the absolute `taskkill.exe
  /pid <pid> /t /f` tree-kill path with a hard fallback; this was not run on a native Windows host.
- Captured child output, spawn errors, signals, timeout state, and output-cap state survive forced
  settlement and remain visible in failure diagnostics.
- The centralized `-v`/terminal-`--help` guard, top-level setup exclusion, `update --check`
  rejection, grammar/depth/count limits, exact help hashing, and no-clobber atomic report write are
  unchanged.

## Verification record

Fresh pre-commit verification:

- `npm run build` — PASS (`tsc`, exit 0).
- `node --test test/picocli-sweep.mjs` — PASS: 41 tests, 41 pass, 0 fail.
- `node --check scripts/compare-picocli-surfaces.mjs` — PASS.
- `node --check test/picocli-sweep.mjs` — PASS.
- `git diff --check -- scripts/compare-picocli-surfaces.mjs test/picocli-sweep.mjs` — PASS,
  no output.
- Real managed-root sentinel — `/Users/sushantsrikrish/.pico-mcp/cli` absent.

An aggregate `npm run test:picocli` was also attempted while sibling final-review remediations were
still deliberately RED in the shared worktree. Its legacy lane passed with `Failures: 0`, but the
combined runner reported 105 tests, 89 pass and 16 fail. Fifteen failures were in the concurrently
edited managed-integrity suite; the sweep descendant case also used an initially too-short 300 ms
fixture startup allowance and did not create its descendant under aggregate load. That fixture was
then corrected to a 1.5-second command timeout with an independently bounded four-second enclosing
process, and the complete 41-test sweep passed fresh afterward. This report does not call the dirty
shared aggregate green; the parent will rerun it after the sibling lane reaches GREEN.

All sweep tests use only owned fake npm and fake CLI processes with a fake-only `PATH`; no
registry/network, real npm install, real pico-cli, setup, update-check, emulator, device, Swan,
native Windows, or rendered-frame LOOK is involved.

## Independent-review fix round

Review of commit `52815a4bb54661641a95bd6509fdecfaa10800a1` found two remaining incomplete
boundaries. Both were reproduced before the fix:

- A fake help process spawned a detached inherited-stdio descendant, exceeded the output cap, and
  exited immediately. The sweep failed and settled, but the detached PID remained alive because
  the parent had already been reparented before the PPID snapshot.
- Root help advertised `app`; `app --help` then used an unsupported `Subcommands:` heading. The
  sweep accepted that command as a leaf and published an incomplete report instead of failing.

Each `runBounded` invocation now receives a child-only ownership assignment containing the sweep
PID plus 192 random bits. On POSIX abort, the runner retains its direct process-group and PPID-tree
cleanup and additionally performs a bounded `ps eww` scan for that exact inherited assignment.
Only exact matching PIDs above 1 are retained; the sweep and its parent are excluded, more than 256
matches are treated as a collision and discarded, and both scan time and output bytes are capped.
The environment listing is parsed only in memory and is never printed or included in diagnostics.
This recovers detached descendants even after their parent exits without broad name-based killing.

The help parser now treats command-section-like headings as grammar at every visited command path.
Only exact `Commands:` and `Available Commands:` headings are supported. An unsupported heading
such as `Subcommands:` fails closed before traversal or report publication, while a genuinely
heading-less nested leaf remains valid.

Fix-round verification:

- `node --test --test-name-pattern='recognizes the advertised root|timeout, spawn failure'
  test/picocli-sweep.mjs` — PASS three consecutive times: 14 tests, 14 pass, 0 fail on each run.
- `npm run build` — PASS (`tsc`, exit 0).
- `node --test test/picocli-sweep.mjs` — PASS: 43 tests, 43 pass, 0 fail.
- `node --check scripts/compare-picocli-surfaces.mjs` — PASS.
- `node --check test/picocli-sweep.mjs` — PASS.
- `git diff --check -- scripts/compare-picocli-surfaces.mjs test/picocli-sweep.mjs` — PASS,
  no output.
- Real managed-root sentinel — `/Users/sushantsrikrish/.pico-mcp/cli` absent.

The shared aggregate was not rerun or claimed green in this fix round; the parent will rerun it
after the sibling lanes are integrated. The POSIX ownership scan and reparented-child cleanup were
exercised on this macOS host. Native Windows behavior remains unverified. No registry/network,
real npm install, real pico-cli, setup, update-check, emulator, device, Swan, or rendered-frame
LOOK was used.
