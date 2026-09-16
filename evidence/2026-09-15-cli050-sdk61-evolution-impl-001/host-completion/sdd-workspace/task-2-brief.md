### Task 2: Deterministic gates — a fixture ledger for test:claims and a controlled clock for the revision-lock capacity test

**Files:**
- Create: `test/fixtures/claims/expected-manifest.json`
- Modify: `test/claimspage.mjs:185-212`
- Modify: `test/fixtures/runlock-child.mjs:241` (the `monotonicMs` dependency)
- Modify: `test/runrevision-locks.mjs:488-530` (`spawnCapacityChild`) and the test at `:2625`
- Test: same files (`test:claims`, `test:runrevision`)

**Interfaces:**
- Consumes: `buildClaimsManifest`, `renderClaimsHtml` from `dist/claimspage.js`; `appendLedgerEntry`, `appendAutoJudgedEntry`, `materializeCapture` from `dist/ledger.js`; `PICO_MCP_LEDGER_DIR` (read by `ledgerDirectory()` at call time).
- Produces: env `PICO_CLAIMS_LIVE_LEDGER=1` opts INTO the machine-specific live-ledger comparison (default: skipped with a printed line); env `PICO_RUNLOCK_CHILD_CLOCK_SCALE=<factor>` slows the child's monotonic clock (test-only dependency injection; production constants untouched).

- [ ] **Step 1: Write the fixture-ledger section** (replace lines 185-212 of `test/claimspage.mjs`)

```js
// 2) a FIXTURE ledger, built with the real writer API from deterministic inputs, so this gate has the
//    same answer on every host. The manifest never carries timestamps (only seq/claim/evidence/capture
//    identities), so the committed expected manifest is exact.
const fixtureLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-fixture-ledger-"));
const priorDir = process.env.PICO_MCP_LEDGER_DIR;
process.env.PICO_MCP_LEDGER_DIR = fixtureLedgerDir;
try {
  const golden = path.resolve("golden/showcase-6cards.golden.png");
  appendLedgerEntry("com.fixture.alpha", { claim: "alpha renders six cards", evidenceType: "vision_verified", attestation: "looked at the golden frame", artifactPath: golden });
  appendLedgerEntry("com.fixture.alpha", { claim: "alpha compiles", evidenceType: "compiles" });
  appendAutoJudgedEntry("com.fixture.beta", { claim: "beta panel centered", artifactPath: golden, score: 0.91 });
  // (use the exact writer signatures from dist/ledger.js — read them; include one entry of every class
  //  the manifest distinguishes, and one retraction via appendLedgerRetraction so withdrawn rows are exercised)
  const manifest = buildClaimsManifest({});
  const expectedPath = path.resolve("test/fixtures/claims/expected-manifest.json");
  if (process.argv.includes("--update-fixture")) fs.writeFileSync(expectedPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  if (JSON.stringify(manifest) === JSON.stringify(expected)) ok("fixture ledger generates the committed expected manifest byte-for-byte");
  else fail(`fixture manifest drifted from test/fixtures/claims/expected-manifest.json (re-run with --update-fixture ONLY after reviewing the diff)`);
  const strong = buildClaimsManifest({ minEvidence: "auto_judged" });
  const weakLeaked = Object.keys(strong.totals).some((t) => ["usd_host_render", "logcat", "structural", "compiles", "built_for_headset"].includes(t));
  if (!weakLeaked) ok("minEvidence=auto_judged drops weaker classes on the fixture ledger"); else fail("minEvidence filter leaked weaker evidence classes");
  const html = renderClaimsHtml(manifest, "2026-09-16T00:00:00.000Z");
  if (html.includes(manifest.apps[0].claims[0].capture.sha256)) ok("fixture HTML surfaces the capture hash verbatim"); else fail("fixture HTML lost the capture hash");
} finally {
  if (priorDir === undefined) delete process.env.PICO_MCP_LEDGER_DIR; else process.env.PICO_MCP_LEDGER_DIR = priorDir;
  fs.rmSync(fixtureLedgerDir, { recursive: true, force: true });
}

// 3) the machine-specific comparison against the maintainer's REAL ledgers is opt-in: it is host state,
//    not a property of the source, and regenerating the snapshot is a publication decision.
if (process.env.PICO_CLAIMS_LIVE_LEDGER === "1") {
  // … the previous block (lines 186-207) moves here unchanged …
} else {
  console.log("  skip live-ledger comparison (set PICO_CLAIMS_LIVE_LEDGER=1 on the ledger-owning machine to run it)");
}
```

Keep sections 1) and the tracked-snapshot consistency checks (lines 150-183: CAPABILITIES.md totals, HTML generated from JSON, withdrawn rows) exactly as they are.

- [ ] **Step 2: Run `PICO_ADB=/fixture/no/such/adb node test/claimspage.mjs --update-fixture` once to write the expected manifest, READ the JSON (no host paths, no timestamps, deterministic hashes), then run without the flag; expect PASS on a second run. Run `npm run --silent test:claims`; expect exit 0.**

- [ ] **Step 3: Commit.**

```bash
git add test/claimspage.mjs test/fixtures/claims/expected-manifest.json
git commit -m "test: give test:claims a deterministic fixture ledger; live-ledger comparison is opt-in"
```

- [ ] **Step 4: Slow the child clock in the capacity test** — in `test/fixtures/runlock-child.mjs` replace `monotonicMs: () => performance.now(),` with

```js
// A test-only clock. The production acquisition budget (ACQUIRE_BUDGET_MS in src/runlocks.ts) is not
// changed; the capacity tests scale the child's monotonic clock so a 15 s budget cannot expire inside a
// 16–18 s concurrent enrollment on a loaded host. Default scale 1 = wall clock.
const clockScale = Number(process.env.PICO_RUNLOCK_CHILD_CLOCK_SCALE ?? "1");
const clockOrigin = performance.now();
monotonicMs: () => clockOrigin + (performance.now() - clockOrigin) * (Number.isFinite(clockScale) && clockScale > 0 ? clockScale : 1),
```

and in `spawnCapacityChild` pass `env: { ...process.env, PICO_RUNLOCK_CHILD_CLOCK_SCALE: "0.01" }` to `fork`. Do NOT change `results.every(status === "acquired" || status === "limit-exceeded")` or the `<= 1 acquired` and exact-count assertions.

- [ ] **Step 5: Run `npm run --silent test:runrevision` three times in a row (log each); expect 327/327 each time. Commit.**

```bash
git commit -am "test: control the revision-lock capacity children's clock instead of racing the production budget"
```

---

