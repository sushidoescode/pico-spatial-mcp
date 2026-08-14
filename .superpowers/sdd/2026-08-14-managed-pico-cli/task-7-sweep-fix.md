# Task 7 help-sweep fix report

Date: 2026-08-14

## Revision and scope

- Clean starting revision: `6676ef1c3239b10006f3a2e331ee368ebcf62de4`.
- Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/pico-evolution-2026-08-14`.
- Changed scope: `scripts/compare-picocli-surfaces.mjs`, `test/picocli-sweep.mjs`, and this report.
- No finding/evidence file or retained Task 7 proof root was touched.

## Root causes and TDD evidence

The registry resolver parsed `Buffer.concat([stdout, stderr])` as JSON. A successful real npm can
write valid package metadata to stdout and an upgrade notice to stderr, so the unrelated notice
made valid registry evidence look malformed. The existing nonzero-command error path already
retained both streams for diagnostics; only successful JSON decoding used the wrong input.

RED was witnessed with the fake-only command:

```text
node --test --test-name-pattern='resolves latest' test/picocli-sweep.mjs
```

The new `latest registry JSON is parsed from stdout despite an npm notice on stderr` case failed
with status 1 and `npm registry lookup returned malformed JSON`; the surrounding group reported
11 passing and 2 failing test records because the failed nested case also failed its parent. The
minimal fix parses stdout only. Separate cases prove malformed stdout still aborts without a report
and a nonzero registry lookup retains a unique stderr marker in the surfaced error.

The help parser extracted exactly one token and treated everything after it as argument notation.
Consequently the real advertised shape `sync component  Sync ...` failed before traversal instead
of producing `sync component --help`.

RED was witnessed before parser implementation with:

```text
node --test --test-name-pattern='multi-token advertised' test/picocli-sweep.mjs
```

It exited 1 on `unsupported advertised command grammar: "sync component  Sync component data ..."`.
That same end-to-end test now requires separate argv tokens, the exact report key `sync component`,
argument-notation stripping, a single visit when the same path is advertised directly and through
its ancestor, and exclusion of a multi-token path beginning with `setup`.

## Implementation and safety review

`advertisedCommands` is now a total parser returning arrays of one through eight safe command
tokens. The complete syntax column must consist of that token sequence followed only by the
previously supported angle/bracket argument notation. Unsupported punctuation, aliases in the
first or a later token, and overlong paths abort before any valid sibling is traversed. Descriptions
remain outside the syntax column and never enter argv.

The breadth-first queue concatenates returned token arrays and continues to deduplicate serialized
paths. The existing total section handling, eight-token cumulative depth bound, 256-invocation
bound, no-clobber report publication, root-`setup` exclusion, centralized terminal-`--help`/`-v`
guard, and `update --check` rejection remain in place. Hash input remains exact stdout followed by
exact stderr; the registry change does not alter CLI help hashing.

All tests use the self-contained fake npm and fake pico-cli processes with a fake-only `PATH` and
owned temporary homes/prefixes. The npm command used to launch repository scripts performed no
registry/install operation. No real registry/network request, real pico-cli, setup, update-check,
emulator, device, Swan, native Windows, rendered-frame LOOK, remote, visibility, or permission
operation occurred.

## Verification

- `npm run build` — PASS (`tsc`, exit 0).
- `node --test test/picocli-sweep.mjs` — PASS: 34 tests, 34 pass, 0 fail.
- `npm run test:picocli` — PASS: legacy lane `Failures: 0`; combined managed/sweep runner 90 tests,
  90 pass, 0 fail.
- `node --check scripts/compare-picocli-surfaces.mjs` — PASS.
- `node --check test/picocli-sweep.mjs` — PASS.
- `git diff --check` — PASS, no output.
- Real managed-root sentinel — `/Users/sushantsrikrish/.pico-mcp/cli` absent after all gates.

These are hermetic structural tests only. They do not add live registry, real CLI, emulator/device,
native Windows, or visual evidence.
