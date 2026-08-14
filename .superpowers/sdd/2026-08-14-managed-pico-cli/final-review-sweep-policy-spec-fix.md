# Final-review sweep grammar, policy gate and normative spec remediation

Date: 2026-08-14

## Scope and evidence boundary

- Review base: `3f81cd016938344d095afc73ca2214457b668d1d`.
- Owned production/gate files: `scripts/compare-picocli-surfaces.mjs`,
  `test/picocli-sweep.mjs`, and `test/distribution-adoption.mjs`.
- Owned normative document:
  `docs/superpowers/specs/2026-08-14-managed-pico-cli-design.md`.
- The implementation and gate runs recorded here used fake npm/fake pico-cli fixtures or local
  tarball packaging. They made no registry request, package download, real/global pico-cli, setup,
  update-check, emulator, device, Swan, native-Windows execution, rendered-frame LOOK, remote,
  permission or visibility change.
- During independent review of `012470d`, the reviewer reported one bounded npm self-update
  metadata GET under a temporary home. That network request is not implementation evidence; it had
  no pico-cli or managed-store impact. No package update or global install claim is made from it.

## RED evidence and root causes

The two behavior gaps were reproduced before their implementations changed:

1. The sweep parser compared command headings before trimming and accepted command headings only at
   indentation zero. An indented nested `Subcommands:` heading was consequently accepted as a leaf,
   while an indented supported `Commands:` heading silently omitted its advertised child. The
   focused RED run reported both subtests failed: the unsupported heading returned exit 0 and the
   supported heading omitted literal `app build`.
2. The operational-policy scanner reserved managed-mode tokens and matched a finite collection of
   setup/update/PATH sentences, but did not model alternate resolution claims. A focused mutation
   appended five claims, including the exact `External mode is the default.` sentence and a claim
   whose `external` and `default mode` tokens were split across a Markdown line wrap. The first RED
   run reported four single-line claims as accepted; a second RED isolated the wrapped evasion.

The production mutation caught by the sweep tests is removal of indentation normalization (or a
return to zero-indent-only heading comparison). The gate mutation caught by the policy test is
removal of structural alternate-resolution classification. Expected values are hand-authored
literals and the scripts/doc scanner are exercised as real child/gate behavior.

## Implementation

- Help lines now retain their original bytes for command parsing but also carry a trimmed heading
  token and explicit indentation. Supported `Commands:` and `Available Commands:` headings are
  recognized at a controlled indentation; their rows must be deeper than the heading. Any
  command-section-like heading at any indentation that is not one of those two exact headings fails
  closed before report publication.
- The operational-policy gate now classifies clauses structurally: any external, disabled, ambient
  or global resolution token combined with default/mode/policy/resolution/resolver context is
  rejected outside the byte-exact canonical block. This does not depend on enumerating linking
  verbs. Existing exact-block, setup/update, managed-mode, fallback and PATH gates remain in place.
- The normative managed-store design now matches production schema 2. It documents the sibling
  publication claim and in-version hard link, both record shapes and their shared content binding,
  deterministic manifest coverage/exclusions/bounds, `--ignore-scripts`, atomic publication and
  manual fail-closed recovery, pre/post execution checks, and the same-user, check-to-launch,
  synchronous-callback and native-Windows limits.

## Verification record

- Focused sweep GREEN after implementation: 7 tests, 7 pass, 0 fail.
- Focused policy mutation GREEN after implementation: 1 test, 1 pass, 0 fail.
- Complete `node --test test/picocli-sweep.mjs`: 44 tests, 44 pass, 0 fail.
- Complete `npm run test:distribution-adoption`: 42 tests, 42 pass, 0 fail.
- `node --check` on the sweep script and both changed test files: exit 0.
- Owned-file `git diff --check`: exit 0, no output.
- The real managed-root sentinel `/Users/sushantsrikrish/.pico-mcp/cli` was absent around the runs.

A first shared `npm run build` attempt occurred while the independently owned managed-execution
remediation was deliberately converting its registry cache singleton to a keyed `Map`; TypeScript
reported that transient mixed state. This report does not count that attempt as build evidence.
The final build and post-commit gates are recorded below after the sibling slice restores a stable
shared tree.

## Final shared-tree verification

After the sibling managed-execution lane restored its keyed registry-cache implementation, the
shared tree was verified serially again:

- `npm run build` — PASS (`tsc`, exit 0).
- `node --test test/picocli-sweep.mjs` — PASS: 44 tests, 44 pass, 0 fail.
- `npm run test:distribution-adoption` after the final build — PASS: 42 tests, 42 pass, 0 fail.
- `node --check` on all three changed JavaScript files — PASS, exit 0.
- Owned-file `git diff --check` — PASS, no output.
- Real managed-root sentinel — `/Users/sushantsrikrish/.pico-mcp/cli` absent before and after the
  final commands.

## Independent-review fix round

Review of `012470d` found two residual gate problems. Both were reproduced before the fix:

1. Under an indented supported heading, a command row at the heading's own indentation caused the
   parser to return `recognizedHeading:true` with no commands and publish a truncated report. The
   RED fixture observed exit 0 and no `app build` traversal.
2. The structural policy context was too broad: the exact benign sentences `External contributors
   can run these commands locally.`, `The external documentation lists CLI commands for
   troubleshooting.`, and `Global search indexes installation examples.` were rejected. The RED
   positive-control test stopped at the first unwanted exception.

The sweep now accepts only a known section boundary at the heading indentation; any other
same-indent line fails closed, while a lower-indent line ends the containing section. The policy
classifier now requires actual default/mode/policy/resolution framing, so its existing alternate
default mutations still fail while all three benign controls pass.

Focused GREEN after the review fix:

- Heading/parser group — PASS: 8 tests, 8 pass, 0 fail.
- Policy rejection plus positive-control group — PASS: 2 tests, 2 pass, 0 fail.
- `npm run build` — PASS (`tsc`, exit 0).
- Complete sweep — PASS: 45 tests, 45 pass, 0 fail.
- JavaScript syntax checks and owned-file `git diff --check` — PASS, no output.
- Real managed-root sentinel — absent before and after each command.

The complete distribution run executed 43 tests: 41 passed and exactly two failed. Both failures
were the concurrently assigned knowledge-lifecycle battery adoption already present in the shared
worktree: the live Linux assignment was 43 while the still-owned assertion expected 42, and the
live `test:` count was 45 while the still-owned assertion expected 44. The two tests were left for
that sibling to update after this file's review-fix commit, as coordinated; this run is not called
green. No sweep or policy test failed.
