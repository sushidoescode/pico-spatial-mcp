# Task 2 review — Deterministic gates (fixture ledger + controlled clock)

Base 070e4a8 → Head c13fea6. Reviewed the full diff, the current working tree at HEAD (which
equals c13fea6), and two files outside the diff (`src/runlocks.ts`, `src/ledger.ts`) to check two
named risks. No tests were re-run; no git/mutating commands were run.

## Spec Compliance

- ✅ Spec compliant. Both required behaviors — a fixture ledger for `test:claims` and a controlled
  clock for `test:runrevision`'s capacity test — are implemented as specified. The tracked-snapshot
  checks, production constants, and existing assertions are preserved unchanged, both gates are
  green, and `test:runrevision` was run three consecutive times as required.
- ⚠️ Cannot verify from diff: the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer
  on each commit. The diff's commit list shows only one-line subjects (`c13fea6`, `fba0a6d`,
  `06c71ca`); full commit message bodies/trailers are not part of the diff content, and I was
  instructed not to re-run git commands to inspect them directly.

### Verified point-by-point

1. Fixture ledger built through the real writer API (`appendLedgerEntry`, `appendAutoJudgedEntry`,
   `appendUsdHostRenderEntry`, `appendDeviceVerifiedEntry`, `appendLedgerRetraction`, all imported
   from `dist/ledger.js`) from three tracked PNGs — test/claimspage.mjs:1967 (import), 194-322 (body).
   **Named-risk check ("does the fixture ledger writer path create anything outside the temp
   directory?"):** `ledgerDirectory()` resolves from `PICO_MCP_LEDGER_DIR` at call time
   (src/ledger.ts:231-234) and the CAS artifact store is nested under it
   (`artifactsDir = path.join(ledgerDirectory(), "artifacts")`, src/ledger.ts:525). The test sets
   `PICO_MCP_LEDGER_DIR` to a `mkdtempSync` dir before any writer call (test/claimspage.mjs:194-196)
   and restores/removes it in `finally` (test/claimspage.mjs:324-327). Every write from this test is
   structurally confined to that temp dir; nothing reaches `~/.pico-mcp`.
2. `appendDeviceVerifiedEntry` (test/claimspage.mjs:268-279) is called with injected `probe`/
   `captureProbe` functions that override its adb-calling defaults
   (`probeDeviceIdentity(resolveDeviceAdb(), serial)`, src/ledger.ts:837-838) — confirmed no adb or
   device is reachable from this test.
3. `test/fixtures/claims/expected-manifest.json` (289 lines, read in full) contains only hashes,
   integers, fixed strings, and two `<fixture-observed-at>` placeholders — no timestamps, host
   paths, hostnames, or usernames. Independently confirms the report's grep claim.
4. Normalization is confined to exactly two keys, named in a comment at test/claimspage.mjs:288-290,
   and separately asserted to be exactly 2 real ISO instants at test/claimspage.mjs:293-299. See
   Minor #1 for the one caveat on how narrowly this is enforced.
5. Tracked-snapshot consistency checks (CAPABILITIES.md totals, HTML generated from JSON, withdrawn
   rows) are byte-identical: the diff's first hunk for test/claimspage.mjs only touches old lines
   1-17 (header/imports); the next hunk starts at old line 175, so nothing between is touched.
6. Live-ledger comparison is opt-in behind `PICO_CLAIMS_LIVE_LEDGER=1`; default path prints a skip
   line — test/claimspage.mjs:332-360. `docs/claims/*`, `CAPABILITIES.md`, `~/.pico-mcp`, and
   `src/**` are absent from the diff entirely.
7. `ACQUIRE_BUDGET_MS` in src/runlocks.ts is absent from the diff — unchanged. **Named-risk check
   ("does anything other than the acquisition budget consume `monotonicMs` in a way a 0.01 scale
   would distort — lease ages, heartbeats, stale-owner detection?"):** every `monotonicMs()` call
   site in src/runlocks.ts (lines 115, 1038, 1060, 1229, 1513, 1562 — read directly at
   src/runlocks.ts:1024-1067 and 1551-1566) is either a `now >= deadline` fail check or the
   `Atomics.wait(..., Math.max(1, Math.min(8, deadline - now)))` poll interval, capped at 8ms
   regardless of scale. No lease-age, heartbeat, or stale-owner check reads this clock; owner
   liveness is PID-based (`ownerIsLive`/`processIdentityIsLive`), not elapsed-time-based. Clean.
8. Both capacity spawners get the clock-scale env — test/runrevision-locks.mjs:494-497
   (`spawnCapacityChild`) and :538-541 (`spawnCapacityAbaChild`), matching the brief's "controller
   ruling." The third fork, `spawnAtBarrier` (line 441), is untouched.
9. No assertion in test/runrevision-locks.mjs changed — the diff only adds the
   `CAPACITY_CHILD_CLOCK_SCALE` constant and two `env:` lines; no removed/modified assertion lines
   appear anywhere in the diff for this file.
10. `clockScale` guard (test/fixtures/runlock-child.mjs:234, 248) correctly defaults to 1 (wall
    clock) for undefined/NaN/zero/negative input (`Number.isFinite(clockScale) && clockScale > 0`),
    and the resulting clock stays monotonically non-decreasing for any accepted scale.
11. No new gate registered — scripts/gate-inventory.mjs is absent from the diff. `test:claims` still
    maps to a bare `node test/claimspage.mjs` (scripts/gate-inventory.mjs:115), no argv, so
    `--update-fixture` (test/claimspage.mjs:303) cannot fire from a normal gate run.
12. `test:claims` and `test:runrevision` green via `npm run --silent <gate>` — confirmed against the
    evidence logs (below). `test:runrevision` ran three consecutive times as required.
13. All 14 new evidence log files are `new file mode 100644` — nothing existing under `evidence/`
    is modified or deleted.
14. `package.json` is absent from the diff — version unchanged.
15. No fetch/network call and no reachable adb invocation in the new test code.

### Evidence-log cross-check (independently re-derived from the diff, not just trusted from the report)

| log | claim | what I found |
| --- | --- | --- |
| `00-test-claims-BEFORE.log` | RED, host-state reason | `FAIL tracked public claims snapshot is stale…`, `Failures: 1` — confirmed, matches exactly. |
| `01`/`02-test-claims-run*.log` | GREEN, fixture asserts pass | `Failures: 0` both; all 6 new fixture assertions `ok`; `skip live-ledger comparison…` printed. Confirmed. |
| `03-test-runrevision-BEFORE.log` | baseline 327/327, capacity test 14,800ms/15,000ms | `tests 327 / pass 327 / fail 0`; capacity test `14800.170125ms`. Confirmed. |
| `04-…RED-clockscale-2.log` | reproduces the race with scale=2 | `status:"run-busy"` vs `"acquired"`, `AssertionError`, exit 1, `11902.236833ms`. Confirmed, exact text match. |
| `05-…GREEN-clockscale-0.01.log` | same focused test passes at 0.01 | `pass 1`, `fail 0`, `15223.413542ms`. Confirmed. |
| `06-run1/2/3` | three full 327/327/0 runs; capacity test 16,640/17,964/15,536ms | Independently grepped: run1 `327/327/0` @119141ms total, capacity 16640.41ms; run2 `327/327/0` @118437ms, capacity 17963.59ms; run3 `327/327/0` @116293ms, capacity 15535.53ms. All three capacity times exceed the raw 15,000ms budget, exactly as claimed — real load-bearing evidence for the fix, not cosmetic. |
| `08`/`09`/`11` (lint/docsmeta/distribution-adoption) | all green, "extra" checks | `test:lint` 57/57 pass (all listed checks `ok`, no `FAIL`); `test:docsmeta` 26/26; `test:distribution-adoption` 43/43. Confirmed — and these three logs are exactly where my first (looser) grep pass mis-attributed extra `ℹ tests N` blocks to `06-run3` before I re-scoped the check to that file's exact diff-line range and found run3 clean at a single 327/327/0 block. Noting this so the number "57/26/43" doesn't look unexplained: it's these three later gates' own node:test summaries, not a hidden problem in run3. |

No `FAIL`/`✖` marker appears anywhere in the evidence section outside the two expected/explained
ones (`00-BEFORE`, `04-RED`) and a handful of `ok …FAIL…` lines that are test *descriptions*
mentioning the word "FAIL", not failures.

## Strengths

- TDD evidence is real and checks out under independent re-derivation, not just report narrative:
  every number in the report's timing table (14,800 / 16,640 / 17,964 / 15,536 ms) matches the raw
  log content exactly, and the RED→GREEN clock-scale reproduction (scale 2 fails with `run-busy`,
  scale 0.01 passes) is genuine mechanism proof, not just a plausibility argument.
- Two concrete, non-trivial risks — production timing logic outside the acquisition budget, and
  fixture-writer path containment — both came back clean under direct inspection of
  `src/runlocks.ts` and `src/ledger.ts` (files intentionally left outside the diff).
- Went beyond the brief's illustrative pseudocode with correct, justified improvements: added
  `provenance-broken` to the `minEvidence` leak-check list (test/claimspage.mjs:315) since it's the
  weakest class in `evidenceRank` and the brief's illustrative list omitted it; replaced the brief's
  single-index HTML assertion (which would have thrown, since `apps[0].claims[0]` is a `compiles`
  row with no `capture`) with an assertion over every capture-bearing row
  (test/claimspage.mjs:320-322).
- `com.fixture.gamma`'s `device_verified` row is honestly labeled a schema fixture in both its claim
  text and attestation (test/claimspage.mjs:268-279), and its device probes are injected rather than
  defaulted, so nothing about "no real device was touched" depends on trust.
- Self-review is candid and technically accurate: all 5 disclosed "Concerns" and the one
  "deliberately not fixed" item in the report check out under my independent verification; nothing
  was glossed over or oversold.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

None.

### Minor (Nice to Have)

1. **`normalize()` matches by bare key name, not by path** (test/claimspage.mjs:292): the
   `JSON.stringify` replacer replaces any key literally named `identityObservedAt` or `observedAt`
   anywhere in the manifest tree, rather than only `deviceIdentity.identityObservedAt` and
   `deviceLineage.observedAt` specifically. In the current schema this is safe — grepping
   `src/claimspage.ts` and `src/ledger.ts` confirms those two exact key names are produced nowhere
   else in the claims-manifest shape, and the test separately asserts exactly 2 such instants exist
   (test/claimspage.mjs:293-299, both parsed as real ISO timestamps) — but that count-assertion only
   reads the two *known* paths, so it would not catch a hypothetical future field elsewhere in the
   manifest also named `observedAt` being silently neutralized by the same replacer. A path-scoped
   normalizer (or asserting the replacer's total substitution count) would close this gap. Not
   blocking against today's verified schema.
2. **`recorded()` doesn't guard chained `.entry` access on rejection**
   (test/claimspage.mjs:198-201): if the `alpha/withdrawn` writer call (line 217) were ever rejected,
   `withdrawn.entry.seq` (line 219) throws an uncaught `TypeError` rather than failing cleanly — the
   diagnostic `FAIL fixture writer 'alpha/withdrawn' was rejected: …` line prints first, `finally`
   still removes the temp dir, and the process still exits non-zero, so the failure stays loud, just
   not clean. Self-disclosed by the implementer as an intentional YAGNI call for an unreachable state
   given fixed, well-formed inputs; I agree it isn't worth a defensive branch.
3. **Cosmetic:** the evidence commit's message reportedly says "twelve logs" where 14 files were
   actually added; self-disclosed and corrected in the report's own text, no effect on gate
   behavior or file content.

## Assessment

**Task quality:** Approved

**Reasoning:** Every explicit constraint in the brief — deterministic fixture ledger via the real
writer API, unchanged tracked-snapshot checks, opt-in live-ledger comparison, unchanged
`ACQUIRE_BUDGET_MS` and unchanged assertions, both capacity spawners scaled, no new gate, three
green `test:runrevision` runs — is independently verified against the diff and the current working
tree, including the two most consequential named risks (production timing logic beyond the
acquisition budget, and fixture-writer path containment), both of which came back clean. No
assertion was weakened, no production constant changed, and every evidence-log number I
cross-checked (two claims runs, three runrevision runs, the RED/GREEN clock-scale reproduction)
matches the report exactly. Findings are Minor only.
