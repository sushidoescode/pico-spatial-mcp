# Managed CLI final-review integrity remediation

Date: 2026-08-14

## Revision and scope

- Starting revision and merge base: `528ddb9f907038539720e9a5dfcf942b7be681c5`.
- Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/pico-evolution-2026-08-14`.
- Production scope: `src/picoclimanaged.ts` and the narrow managed-runner callback seam in
  `src/picocli.ts`.
- Test scope: `test/picocli-autoinstall.mjs` and
  `test/helpers/picocli-managed-fixture.mjs`.
- No package version or dependency metadata changed.
- No push, merge, remote mutation, permission change, or repository-visibility change was
  performed.

## Reproduced review findings and TDD evidence

The initial final-review findings were reproduced before production changes. Focused tests showed
that the managed exact install omitted `--ignore-scripts`; a fixture postinstall marker could run;
legacy/incomplete records were accepted; and same-version changes to shim bytes, package metadata,
dependency bytes, or an in-root shim symlink target were not bound to the publication.

The first independent review then reproduced three additional consistency failures before their
fixes:

- the executable identity could change at the validation/run boundary before the later full-tree
  consistency check observed it;
- default managed-latest omitted exact manual recovery paths when registry lookup failed and only
  invalid legacy cache entries existed; and
- queued relative-path strings were retained before the advertised path-byte budget charged them.

A second review reproduced that a synchronous pre-spawn guard could exceed the nominal command
budget and still launch the child; that post-spawn validation necessarily occurs after process
creation; and that a digest stored only in excluded `install.json` lacked an independent publication
binding. Focused RED cases then required a slow pre-spawn guard to refuse process creation with
`timedOut: true`, required post-spawn timing to be reported accurately, and required the hard-linked
publication claim to retain the original content binding even if `install.json` was rewritten.

The final review found one false public error string: a post-spawn timeout said it happened before
process creation. A focused RED captured that exact message; the phase-specific GREEN now states
that post-spawn exhaustion occurred after process creation. After that change, the independent
review reported no remaining blocking correctness finding in this four-file slice at that point.

## Implementation

Exact managed installs now pass:

```text
npm install --prefix <staging> --no-save --package-lock=false --ignore-scripts --fund=false
  --audit=false @picoxr/pico-cli@<exact-version>
```

Publication records are schema 2. Both fsynced `install.json` and the separately created,
hard-linked claim/`publication.json` record bind the same manifest schema, SHA-256, entry count, and
total content bytes. Inspection validates the two record bindings, the claim/publication inode and
bytes, and a freshly recomputed full-tree identity before selecting or invoking a cached version.
The tree is recomputed again after each version probe. Installation validates the staged tree before
probing, revalidates the executable around each version/help invocation, computes the final tree
identity after compatibility diagnostics are written, and validates the published/finalized winner.

The deterministic manifest covers the exact version root, installed package, dependencies,
canonical shim, regular-file contents, modes, symlink bytes and resolved containment. Only the two
named root control records needed to avoid circularity, `install.json` and `publication.json`, are
excluded. Traversal uses `lstat`, realpath containment, sorted relative paths, no-follow bounded file
reads where supported, before/after stat checks, and explicit limits: 100,000 entries, depth 128,
64 MiB of retained relative-path bytes, 256 MiB per file, and 1 GiB total content bytes.

Immediately adjacent synchronous runner callbacks compare a bounded executable snapshot containing
the canonical shim type/mode/link count/size/raw symlink target, contained real target path and
mode/link count/size/SHA-256, executable access on POSIX, and exact package version. A failed or
budget-exhausted pre-spawn check refuses process creation. A failed post-spawn check terminates and
reports the child, but is explicitly detection rather than prevention. The existing full-tree
validation remains on both sides of each managed command.

Each public default `ensurePicoCli` and `inspectPicoCliCached` call now captures one complete process
environment snapshot and derives its default home/root from that same snapshot. Every child in a
multi-command managed resolution receives that exact base environment. Ensure-flight coalescing
includes a SHA-256 digest of the complete sorted environment entries, so calls with different
snapshots do not share a promise and no raw environment values enter the key. A fresh-child test
imports under one temporary home, switches to a second fake-only runtime home and environment,
changes the process environment while resolution is pending, and overlaps disabled and
managed-latest calls for one explicit root. It requires the call-time root, stable child environment,
separate policy outcomes, and read-only inspection of a third home.

Invalid schema-1 records, incomplete schema-2 records, content drift, publication-binding drift,
out-of-root symlinks, and package/dependency drift all fail closed before ordinary executable
probing. Results name the exact version root and adjacent publication claim and instruct the user to
remove both only after confirming that no managed resolver process is active, then retry.

## Compatibility consequence and known limits

Previously published schema-1 managed cache entries are intentionally not migrated in place. They
fail closed and require the explicit manual two-path recovery above so new bytes can be installed and
bound. This is a cache migration consequence, not a project or global CLI mutation.

The records detect uncoordinated local byte/path drift; they are consistency metadata rather than an
external source of truth. Cross-platform Node process launch cannot bind execution to an already
opened descriptor, so a small filesystem check-to-launch race remains. Post-spawn validation reports
and terminates observed drift but cannot establish that a process had no immediate effect.
Synchronous filesystem callbacks receive and check the command deadline, but JavaScript cannot
preempt a blocking synchronous OS call.

No native Windows host was available. Windows shim, path, and process behavior remains fixture-only;
the POSIX executable/symlink cases were exercised on macOS. No Swan hardware, real registry, real
npm install, real/global pico-cli, `pico-cli setup`, `update --check`, emulator, device, or rendered
frame was used. No visual or device verification claim applies.

## Real-home fixture incident and recovery

During the first final gate sequence, the real managed-root sentinel found a 24 KiB fixture tree at
`/Users/sushantsrikrish/.pico-mcp/cli`, created at 09:14:05 PDT. Work stopped immediately and the
tree was inspected read-only. Its records named `sha512-runtime-fixture`, its owner process had
exited, and its shim referred to a deleted `pico managed runtime` temporary driver; this established
that it was test-fixture data rather than a real registry/npm installation.

The parent validated the exact tree and moved it intact to
`/tmp/pico-integrity-real-home-quarantine.YSiMBi/cli`; the real managed root was then absent. The
cause was an independent review scratch process that imported the managed adapter before applying a
temporary runtime environment, then invoked the default resolver. The old adapter combined its
import-time real home with the later fake npm/CLI environment. The call-time snapshot regression and
implementation above close that data-consistency split. No real registry, real npm package, global
CLI, setup, emulator, or device was used in the incident. The quarantine remains preserved for
inspection and was not modified by this task.

## Final verification

All final gates ran sequentially with the real managed-root sentinel checked before and after every
command:

- `npm run build` — PASS (`tsc`, exit 0).
- Focused fake-only lifecycle/publication-manifest/deadline/environment gate — PASS: 21 tests,
  21 pass, 0 fail.
- `node --test test/picocli-autoinstall.mjs` — PASS: 76 tests, 76 pass, 0 fail.
- Two additional complete managed-suite runs with the dot reporter — PASS, exit 0 each; three
  consecutive final-state managed-suite executions passed in total.
- `npm run test:picocli` — PASS: legacy lane `Failures: 0`; combined managed/sweep TAP 119 tests,
  119 pass, 0 fail.
- `node test/preflight.mjs` — PASS: `Failures: 0`.
- `npm run test:distribution-adoption` — PASS: 42 tests, 42 pass, 0 fail.
- `node --check test/picocli-autoinstall.mjs` and
  `node --check test/helpers/picocli-managed-fixture.mjs` — PASS.
- `git diff --check` on the owned code/tests/report — PASS, no output.
- Real managed-root sentinel — `/Users/sushantsrikrish/.pico-mcp/cli` absent after all final gates.

All final command behavior used isolated temporary roots and fake npm/pico-cli processes. No live
registry/CLI, setup, emulator, device, or rendered-frame claim was involved.
