# Task 2 report — Deterministic gates

Branch `hc/t2-deterministic-gates`, worktree
`/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-hc-t2-2026-09-16`, based on `070e4a8`.

Status: **DONE_WITH_CONCERNS** (both gates are deterministic and green; the concerns are
disclosures, not defects — see *Concerns*).

Commits:

- `06c71ca` test: give test:claims a deterministic fixture ledger; live-ledger comparison is opt-in
- `fba0a6d` test: control the revision-lock capacity children's clock instead of racing the production budget
- (evidence commit, added last — see the end of this file)

---

## 1. What I implemented

### `test:claims` — a fixture ledger built through the real writer API

`test/claimspage.mjs` section 2 used to read the maintainer's real ledgers under
`~/.pico-mcp/ledgers` and demand that the tracked public snapshot match them exactly. That is host
state, so the gate was red here and would be red on any machine whose ledger corpus has moved past
the published snapshot.

Section 2 now builds a **whole ledger from scratch** in a `fs.mkdtempSync` directory pointed at by
`PICO_MCP_LEDGER_DIR` (read by `ledgerDirectory()` at call time), using the real writer API:

| app | rows |
| --- | --- |
| `com.fixture.alpha` | `compiles`, `logcat`, `structural`, `built_for_headset`, plus a fifth row retracted by `appendLedgerRetraction` (fixed `recordedAt`) |
| `com.fixture.beta` | `vision_verified` (`appendLedgerEntry`), `auto_judged` (`appendAutoJudgedEntry`), `usd_host_render` (`appendUsdHostRenderEntry` with a valid `UsdRenderMeasurement`) |
| `com.fixture.gamma` | `device_verified` (`appendDeviceVerifiedEntry` with **injected** identity/capture probes — no adb, no device), and a `vision_verified` row whose content-addressed bytes are replaced afterwards so `readLedger` downgrades it to `provenance-broken` |

That is **one row of every one of the nine evidence classes** `EVIDENCE_RANK` distinguishes, plus a
retraction. The generated manifest is compared against the committed
`test/fixtures/claims/expected-manifest.json` (289 lines), regenerated only by an explicit
`--update-fixture` argument that the gate never passes.

Determinism decisions, all forced by reading the real signatures rather than the brief's
illustrative ones:

- **All three inputs are tracked images**, so every hash in the expected file is fixed:
  `golden/showcase-6cards.golden.png` (2160×2158, sha `d66c11c7…`),
  `test/fixtures/media/valid-small.png` (64×64, sha `457aadfa…`),
  `test/fixtures/media/valid-dark.png` (64×64, sha `d4270cb3…`).
- **The `provenance-broken` row is produced by a hash *mismatch*, not a missing file.** Deleting or
  corrupting the artifact would make `checkProvenance` return a reason built from
  `validateCapture`'s `label`, i.e. the absolute CAS path inside the host temp dir. Overwriting the
  CAS entry with a *different but still structurally valid* image instead yields
  `"linked evidence no longer matches recorded capture metadata (expected sha256 457aadfa…, read
  d4270cb3…)"` — two hashes and no filesystem path. The whole `provenance` object is therefore
  compared exactly, not normalized.
- **Exactly two fields are normalized**, and a comment in the test says so: the ISO instants
  `verifyLiveDeviceLineage()` mints from the wall clock when a `device_verified` row is written
  (`deviceIdentity.identityObservedAt` and `deviceLineage.observedAt`). They are replaced by
  `<fixture-observed-at>` in *both* sides of the comparison, and a separate assertion checks there
  are exactly two of them and that both parse as real instants. Everything else — hashes, byte
  counts, dimensions, sequence numbers, evidence classes, `provenance`, `producerProvenance`,
  `deviceLineage`, `totals`, `deviceOutcomes`, `evidenceMeaning`, `evidenceRank` — is compared
  byte-for-byte. The committed file contains **no timestamp, host path, hostname or user name**
  (verified by grep, below).

Assertions in the new section: the two live-probe instants are real ISO timestamps; the fixture
manifest matches the committed file byte-for-byte; the retracted row never reaches the manifest;
`minEvidence=auto_judged` drops all six weaker classes (I added `provenance-broken` to the leak
list the brief supplied — it ranks below the cutoff and must also be dropped); the rendered HTML
surfaces every one of the five capture hashes verbatim (the brief's single-index form
`manifest.apps[0].claims[0].capture.sha256` would have thrown, because `apps[0]` is
`com.fixture.alpha` whose first row is `compiles` and carries no capture).

Section 3 is the previous real-ledger block, moved unchanged behind `PICO_CLAIMS_LIVE_LEDGER=1`.
The default prints `skip live-ledger comparison (set PICO_CLAIMS_LIVE_LEDGER=1 on the
ledger-owning machine to run it)`. **I did not run it with that variable set** — the requirement is
only that the gate no longer depends on the user's ledgers.

The tracked-snapshot consistency checks (CAPABILITIES.md totals, HTML generated from JSON,
withdrawn rows kept out; old lines 150–183) are byte-identical — visible in the diff as untouched
context.

### `test:runrevision` — a controlled clock for the capacity children

`test/fixtures/runlock-child.mjs`: `monotonicMs` was `() => performance.now()`. It is now a
test-only scaled clock driven by `PICO_RUNLOCK_CHILD_CLOCK_SCALE` (default `1` = wall clock, so
every other child command is unaffected):

```js
const clockScale = Number(process.env.PICO_RUNLOCK_CHILD_CLOCK_SCALE ?? "1");
const clockOrigin = performance.now();
…
monotonicMs: () => clockOrigin + (performance.now() - clockOrigin) * (Number.isFinite(clockScale) && clockScale > 0 ? clockScale : 1),
```

`test/runrevision-locks.mjs`: both capacity spawners — `spawnCapacityChild` **and**
`spawnCapacityAbaChild`, per the controller ruling, since both drive the same 4,095-residue setup —
now `fork` with `env: { ...process.env, PICO_RUNLOCK_CHILD_CLOCK_SCALE: CAPACITY_CHILD_CLOCK_SCALE }`
where `CAPACITY_CHILD_CLOCK_SCALE = "0.01"`. The third `fork` in that file (`spawnAtBarrier`, line
442) is deliberately untouched. `ACQUIRE_BUDGET_MS` in `src/runlocks.ts` is unchanged, and no
assertion in the affected tests was touched — the `every(acquired || limit-exceeded)`, `<= 1
acquired` and exact 4,096/12,288 count assertions are all as they were.

I checked every `monotonicMs()` call site in `src/runlocks.ts` before scaling: lines 1038, 1060,
1513 and 1562 are all either a `now >= deadline` comparison or the poll interval of
`Atomics.wait(WAIT_WORD, 0, 0, Math.max(1, Math.min(8, deadline - now)))`, which is capped at 8 ms
regardless of scale. No age or heartbeat computation reads that clock (the fixture already freezes
`nowUtc` at `2026-08-16T12:34:56.000Z`, and liveness uses `process.kill(pid, 0)`), so scaling
changes only how much wall time fits inside the budget. **No assertion broke under the scaled
clock** — nothing to report under that clause of the brief.

## 2. TDD evidence, per step

**Step 1–2 (claims).** Before any edit, the gate was red for exactly the host-state reason:
`00-test-claims-BEFORE.log` ends `FAIL tracked public claims snapshot is stale against the current
effective ledger read` / `Failures: 1`, with the 15 preceding checks green. After the edit I ran
`node test/claimspage.mjs --update-fixture` once, **read the generated JSON** (all 289 lines) and
grepped it for host-specific content:

```
grep -nEi 'sushant|/Users/|/var/folders|/private/|/tmp|<hostname>|[0-9]{4}-[0-9]{2}-[0-9]{2}T'
  → NO host paths / hostnames / usernames / ISO timestamps found
```

Then two consecutive gate runs without the flag: `01-…run1.log` and `02-…run2.log`, both exit 0,
both `Failures: 0`. The second run is the one that proves the *committed* fixture matches, since
each run uses a fresh `mkdtemp` directory — path independence is proven by construction.

**Step 4–5 (runrevision).** The baseline was **green but by 200 ms**:
`03-test-runrevision-BEFORE.log` shows 327/327, and inside it the capacity test
`concurrent cross-process enrollment cannot cross exact lock namespace or aggregate capacity` took
**14,800 ms of the 15,000 ms `ACQUIRE_BUDGET_MS`** — a 1.3 % margin. I could not make that race fail
on demand by loading the host, so I proved the mechanism directly instead: with
`CAPACITY_CHILD_CLOCK_SCALE` temporarily set to `"2"` (a child clock running twice as fast — exactly
what a 2× loaded host looks like to the budget), the focused test fails with the real failure mode:

```
AssertionError [ERR_ASSERTION]: [{"kind":"capacity-result","status":"run-busy",
  "detail":"a live capacity enrollment still owns its unpublished staging leaf"},
 {"kind":"capacity-result","status":"acquired"}]     (04-…RED-clockscale-2.log, exit 1)
```

`run-busy` is neither `acquired` nor `limit-exceeded`, so `results.every(...)` fails — the gate goes
red for load, not for a capacity defect. Restoring `"0.01"` makes the same focused test pass
(`05-…GREEN-clockscale-0.01.log`, exit 0).

The post-fix full runs make the margin concrete: the same test took **16,640 ms / 17,964 ms /
15,536 ms** of wall time across the three runs. All three exceed the 15,000 ms budget, so **two of
three (arguably all three) would have failed without this change.** The race was imminent, not
theoretical.

## 3. Tests and results

Every command below was run with `PICO_ADB=/fixture/no/such/adb` exported.

| gate | result |
| --- | --- |
| `npm run build` | exit 0 (`build-source: published 190 file(s)`) — run before every test that imports `../dist` |
| `npm run --silent test:claims` ×2 (steps 2) | exit 0, `Failures: 0` both times |
| `npm run --silent test:claims` (final, post-commit) | exit 0, `Failures: 0` |
| `npm run --silent test:runrevision` run 1 | exit 0 — **tests 327 / pass 327 / fail 0** |
| `npm run --silent test:runrevision` run 2 | exit 0 — **tests 327 / pass 327 / fail 0** |
| `npm run --silent test:runrevision` run 3 | exit 0 — **tests 327 / pass 327 / fail 0** |
| `npm run --silent test:lint` | exit 0 |
| `npm run --silent test:docsmeta` | exit 0 |
| `npm run --silent test:distribution-adoption` (extra, not required) | exit 0 — 43/43. Ran it because it is the meta-gate AGENTS.md warns is self-red; it is green here and I did not regress it. |

Baseline (pre-change) for the record: `test:claims` exit 1 (1 failure);
`test:runrevision` exit 0, 327/327 with the 14.8 s / 15.0 s capacity margin described above.

## 4. Files changed

| file | change |
| --- | --- |
| `test/claimspage.mjs` | +194/−23. New section 2 (fixture ledger), section 3 gated on `PICO_CLAIMS_LIVE_LEDGER=1`, two new imports (`node:crypto`, five writers from `../dist/ledger.js`), header comment updated. Sections 1 and the tracked-snapshot checks unchanged. |
| `test/fixtures/claims/expected-manifest.json` | new, 289 lines — the committed expected manifest. |
| `test/fixtures/runlock-child.mjs` | +8/−1. Scaled `monotonicMs` plus its explanatory comment. |
| `test/runrevision-locks.mjs` | +8. `CAPACITY_CHILD_CLOCK_SCALE` constant + comment, and the `env` pin on both capacity spawners. |

Nothing else. In particular `docs/claims/claims.json`, `docs/claims/index.html`, `CAPABILITIES.md`,
`src/**` and everything under `~/.pico-mcp` are untouched — `git status --short docs/claims
CAPABILITIES.md` is empty, and `find ~/.pico-mcp/ledgers -mmin -60` returned nothing (that
directory's mtime is still Sep 14 04:01).

## 5. Self-review findings

- **Completeness.** Both gates are deterministic and green; the tracked-snapshot checks are
  byte-identical; the real ledgers and public claims are untouched; `ACQUIRE_BUDGET_MS` and every
  affected assertion are unchanged. No new gate was registered (the fixture JSON is data).
- **`--update-fixture` cannot fire from a gate run.** `run-gate` invokes
  `node test/claimspage.mjs` with no extra argv, so a gate can never silently rewrite its own
  expectation; regenerating is an explicit, manual act.
- **`env: {...process.env, …}` replaces inheritance with an explicit copy.** Because
  `process.env` is spread first, the children still receive everything the parent had — including
  the `PICO_ADB=/fixture/no/such/adb` that `run-gate` pins — plus the one new key. (The runlock
  children never touch adb regardless.)
- **`clockScale` is guarded against junk.** `undefined` → 1, `"abc"` → NaN → 1, `""` → 0 → 1,
  negative → 1. The resulting clock is still monotonically increasing for any accepted scale.
- **Minor, deliberately not fixed:** `withdrawn.entry.seq` would throw a `TypeError` if that one
  writer call were ever rejected. The `recorded()` helper prints a clean
  `FAIL fixture writer 'alpha/withdrawn' was rejected: …` line *before* the throw, the `finally`
  still removes the temp directory, and the process still exits non-zero — the failure stays loud
  and diagnostic. Adding a defensive branch for an unreachable state is the kind of thing YAGNI
  argues against; noting it instead, per the brief's instruction for large test files.
- **`test/runrevision-locks.mjs` (2,934 lines) got minimal edits only** — one constant with a
  comment and one line inside each of two spawners. No restructuring.
- **Honesty of the fixture rows.** `com.fixture.gamma`'s `device_verified` row is a *schema*
  fixture: the identity and screencap probes are injected functions, no adb and no device were
  touched, and its claim and attestation say so verbatim (same wording discipline as the existing
  `test/swan.mjs` fixtures). Likewise the `auto_judged` and `usd_host_render` rows state in their
  attestations that no judge and no renderer ran. The ledger lives in a temp directory that the
  `finally` deletes; none of it reaches `docs/claims` or `~/.pico-mcp`.

## 6. Concerns

1. **The runrevision fix is preventive on this host, and I want that stated plainly.** The gate was
   already green here before my change (327/327). I did not observe a natural red; I reproduced the
   exact failure mode by turning the new knob the wrong way (scale `2`), and I measured that the
   post-fix runs of the affected test occupy 15.5–18.0 s against a 15.0 s budget. That is strong
   circumstantial evidence the race is real and close, but it is not "I saw the gate fail on its
   own".
2. **One evidence class is reachable only through a wall-clock timestamp.** `device_verified` is the
   sole reason any normalization exists at all. If a reviewer would rather have a 100 %-exact
   fixture than cover the ninth class, dropping the `com.fixture.gamma` device row removes both
   normalized fields and the `deviceOutcomes`/`deviceIdentity` coverage with it. I judged the
   coverage worth two normalized instants; that is a reversible call.
3. **`npm ci` was required.** The worktree had no `node_modules`, so nothing could build. I ran
   `npm ci --prefer-offline --no-audit --no-fund`, which resolved entirely from the local npm cache
   in 450 ms (129 packages). This is the repo's own devDependencies, local to the worktree — every
   other worktree has its own `node_modules` — and is unrelated to the managed pico-cli store, the
   global CLI or `PATH`, none of which were touched.
4. **Scaling the child clock by 0.01 makes the effective budget 1,500 s of wall time.** A genuine
   deadlock inside the capacity path would now be caught by the node test runner's 180 s `timeout`
   option rather than by the acquisition budget. The budget-expiry path itself is still exercised at
   scale 1 by every non-capacity child command, and the failure signal stays loud either way.
5. **I did not exercise `PICO_CLAIMS_LIVE_LEDGER=1`.** By instruction. So the moved block is
   unchanged-by-inspection and by lint, not by execution. It is the same code that ran green in the
   baseline log (its first two assertions passed there; only the tracked-snapshot comparison failed,
   which is the host-state fact that motivated the move).

## 7. Exact log paths

All under
`/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-hc-t2-2026-09-16/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-2/`:

| file | what it is |
| --- | --- |
| `00-test-claims-BEFORE.log` | RED baseline, exit 1 — stale tracked snapshot vs the real ledgers |
| `01-test-claims-run1.log` | first green gate run after the fixture ledger |
| `02-test-claims-run2.log` | second green gate run — proves the committed fixture matches |
| `03-test-runrevision-BEFORE.log` | baseline 327/327, capacity test at 14,800 ms of the 15,000 ms budget |
| `04-runrevision-capacity-RED-clockscale-2.log` | reproduced failure with the knob at `"2"` — `status:"run-busy"`, exit 1 |
| `05-runrevision-capacity-GREEN-clockscale-0.01.log` | same focused test green at `"0.01"`, exit 0 |
| `06-test-runrevision-run1.log` / `run2` / `run3` | the three required gate runs, 327/327 each |
| `07-npm-build.log` | `npm run build`, exit 0 |
| `08-test-lint.log` | `test:lint`, exit 0 |
| `09-test-docsmeta.log` | `test:docsmeta`, exit 0 |
| `10-test-claims-final.log` | final `test:claims` after both commits, exit 0 |
| `11-test-distribution-adoption.log` | extra meta-gate check, 43/43 |

That is **14 files** (the `06-…` row covers three). These are `*.log` files in a repo that gitignores
them; they are added with `git add -f` in the third commit on this branch, `c13fea6`.

**Correction, disclosed rather than amended:** the body of `c13fea6` says "twelve logs". The correct
count is fourteen — I counted the report's 12 table rows instead of the files, since the three
`test:runrevision` runs share one row. `git show --stat c13fea6` says `14 files changed`, so the
commit's own diffstat is right and only the prose sentence is wrong. I did **not** `git commit
--amend` to fix it, because the brief forbids rewriting history without qualification; recording the
error here is the honest remedy. If the controller would rather have a clean message, the amend is
trivial and the commit is unpushed.
