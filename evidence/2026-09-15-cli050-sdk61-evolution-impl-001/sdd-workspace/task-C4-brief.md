## C4: Align the perf command and report contract

**Files:** modify `src/perfcli.ts`, `src/perftrace.ts`, `src/picocli.ts`, `src/clicapabilities.ts`; extend `test/picocli.mjs` and benchmark fixtures in `test/spatialbench.mjs`.

**Interface:** preserve `runPerfDiagnose` and `scorePicoCliPerfAxis` unless a documented compatibility change is necessary. Add explicit report identity/completeness rather than assuming any parsed JSON object is a useful measurement.

- [ ] Read both CLI package/consumer audits and exact vendored 0.2.0 options. The source-derived candidate is `perf live run --package PKG --duration SEC --device SERIAL --save --output PATH`; current `perf monitor run --app … -o …` is rejected. Reconcile absolute `PICO_HOME` or explicit profiler-entry configuration with the actual utility layout, separately from SDK tools-root selection. Do not silently set a guessed root, derive flags from names, or reuse a 0.3 report shape.
- [ ] Add a fake CLI that rejects `monitor`, captures argv, and writes representative 0.2.0 report fixtures only when the supported save/output arguments are passed. Mark fixtures synthetic and cite the published schema used to construct them.

```js
assert.deepEqual(capturedRun.args, ["perf", "live", "run", "--package", "com.example.fixture",
  "--duration", "15", "--device", "fixture-serial", "--save", "--output", reportPath]);
```
- [ ] Cover missing file, empty JSON object, malformed JSON, mismatched package/serial when available, stale pre-existing output, unknown report version, `SKIP`, `INSUFFICIENT_DATA`, and missing counters. Include the existing observable score boundary:

```js
assert.equal(scorePicoCliPerfAxis({status: "ok", summary: {}}, 16.7).perf, null);
assert.equal(scorePicoCliPerfAxis({status: "ok", summary: {appFps: {p5: 0, avg: 0}}}, 16.7).perf, null);
```

- [ ] Implement capability-based argv and a validated adapter for each actually supported report version. Retain the entire raw report with a hash, producer version and input identity; return a bounded view. Preserve official diagnosis states and distinguish unavailable from failed measurement.
- [ ] Correct trace load/query contracts. Request the supported load `--envelope`, validate successful `data.sessionId`, and unwrap query `data.rows` after validating success/resource/action/session identity. Retain backward parsing only for a separately identified legacy contract; default new human-readable `[TraceLoad] Session: ID` output is not a JSON session result.

```js
// Representative envelope fixture; bind its shape to the published vendor schema.
const queryEnvelope = {success:true, exitCode:0, resource:"trace", action:"query",
  data:{sessionId:"fixture-session", rpcEndpoint:"http://127.0.0.1:19001", rows:[{value:1}]}};
assert.deepEqual(validatedQueryResult.rows, queryEnvelope.data.rows);
assert.notDeepEqual(validatedQueryResult.rows, queryEnvelope);
```

- [ ] Add load/query regressions for successful envelopes, `success:false` with exit/error metadata, empty or malformed output, truncated JSON, wrong session and legacy output. Keep record/decode argv that still matches the actual declarations; capture raw streams and session/report identity. Do not add new trace analysis execution merely because the CLI advertises it.
- [ ] Propagate missing/partial measurement status into SpatialBench and doors acceptance. Never equate compositor/PxrMetric output with app FPS, absent GPU data with idle GPU, or an insufficient-data result with a passing budget.
- [ ] Build; run `npm run test:picocli`, `npm run test:bench` and affected doors fixtures. If provisioned profiler help or native sampling remains unavailable, retain that limit while completing the host adapter and tests; do not run utility setup automatically. Commit this deliverable.

