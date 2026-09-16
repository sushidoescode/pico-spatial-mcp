# Scoped re-review of fix wave FIX1 (commits 8ef62e4..8729bbd)

You are the independent reviewer of ONE fix wave on the PICO-MCP branch `cli050-sdk61-evolution-2026-09-15`,
worktree `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15`. Read-only on the
tree: no edits, no commits, no emulator/device/MCP/`pico_doctor`/managed-CLI/npm-registry activity, no
calibration. If you run any test, export `PICO_ADB=/fixture/no/such/adb` and run it through
`npm run --silent <gate>`; never run a test that could reach a device.

## Inputs
1. Findings being fixed: `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/final-review-report.md`
   (Important 1–9 and the Minors) — the authoritative list.
2. The controller's dispositions (which items are FIX / DISCLOSE ONLY / LEAVE): ledger
   `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/progress.md`, sections "Post-final-review controller
   plan" and "Final whole-branch review → fix wave FIX1"; and the brief `task-FIX1-brief.md`.
3. The implementer's report: `task-FIX1-report.md`.
4. The diff package: `review-FIX1-8ef62e4..8729bbd.diff` (same directory) — or `git diff 8ef62e4..8729bbd`.
5. Repo contract: `AGENTS.md` (byte-pinned policy block; vocabulary rule in `test/distribution-adoption.mjs`).

## What to check (every item, with file:line evidence)
- Each Important 1–9 and each FIX-marked Minor: is the disposition implemented as ruled — not more, not
  less? For DISCLOSE ONLY items (I4, I6b toolchainwatch): is the disclosure present, accurate and complete
  (I6c: every residual `0.13` literal in `src/` listed — verify with your own grep)?
- I7 (run-gate default): caller-set `PICO_ADB` always wins; native-contract untouched; `process.env` not
  mutated; unit tests real (through the injected `spawnChild`), gates.yml workflow-level env present and the
  inventory/workflow parser tests still pass; the AGENTS/CHECKPOINT text now describes the enforced default
  truthfully (direct `node --test` still needs the export).
- I8 (doors seam): a call-only `dependencies` makes `doorCallRaw` reject BEFORE `inner()`; the test proves it
  on `pico_look` and `pico_verify_app`; no other lane behavior changed.
- I9 (required serial/device): schema now `z.string()`; handler refusals kept; tests assert the SDK
  validation-error shape; door schemas mirror the inner contract; the [M11] tarball canary still passes.
- I6a (editorpalette migration): selection through `resolveOperationToolchain` with the editor component;
  explicit `editorApp` wins; structured unavailable error from the selection layer; the test never touches a
  real editor bundle.
- Docs: AGENTS.md sentence (I1) outside markers with no policy vocabulary; CHANGELOG 38.0.0 section placed
  and scoped as ruled, existing entries untouched; checkpoint edits (I2, I3, I4, log sentences, distributable
  section) true against the tree; REVIEW.md correction dated and visible, nothing else rewritten;
  `.claude/rules/*.md` true.
- Evidence honesty: the report's battery/tripwire/receipt claims match the logs under
  `evidence/…/fix-wave/` and `release/final/`; F1's tarball sha256
  `941e402bb2c234c444e31c62c9bc9dc2c69055ac3aeee48c960e870e100f36d6` unchanged; the new receipt's identities
  quoted correctly; no native/visual/device/cross-platform claim anywhere; `test:claims` reported red, not hidden.
- Regressions: anything the wave broke or weakened (a loosened assertion, a skipped gate, a changed count
  without derivation).

## Output
Write `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/task-FIX1-review-report.md` and return it: per
finding "addressed / partially / not addressed / regressed" with evidence; NEW issues (Important/Minor);
final verdict "clean" or "fix round needed" with the exact list for a fix round.
