### Task 6: Rebuild, regressions, independent review, final battery, fresh artifact and checkpoint

**Files:**
- Create: `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md`, `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/pico-spatial-mcp-38.0.0.tgz` (untracked) + `.receipt.json` (tracked), `evidence/…/host-completion/*.log`
- Modify: `CHANGELOG.md` (38.0.0 section: the six fixes), `docs/findings/CLI050_CAPABILITY_MATRIX.md` (pico_perf device), `AGENTS.md` (run-gate sentence if T1 did not already finish it)

- [ ] **Step 1: `npm run build`; run every gate T1–T5 touched (`test:lint`, `test:docsmeta`, `test:distribution-adoption`, `test:doors`, `test:sdkselection`, `test:observation`, `test:eye`, `test:tarball`, `test:claims`, `test:runrevision`, `test:buildfreshness`, `test:plugin-bootstrap-freshness`, `test:picocli`, `test:conformance`, `test:emulator-restart`, `test:preflight`) with logs under `evidence/…/host-completion/`.**
- [ ] **Step 2: Independent whole-pass review (read-only reviewer, fresh context) over `dfb3f2d..HEAD`; one fix wave if findings; one scoped re-review.**
- [ ] **Step 3: Full battery through `node scripts/run-battery.mjs "$PWD" evidence/…/release/host-completion/battery-38.0.0-host-completion.log` with NO `PICO_ADB` exported and a marker-writing tripwire `adb` first on `PATH`; expected 55/55 (no exceptions). Record the tripwire marker's absence.**
- [ ] **Step 4: `node scripts/verify-tarball.mjs --publish "$PWD/evidence/…/release/host-completion/pico-spatial-mcp-38.0.0.tgz"`; track the receipt; quote sha256/bytes/build identities; confirm the two earlier tarballs' hashes are unchanged.**
- [ ] **Step 5: Write `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md`: what changed per task with commits and tests; the battery; the artifact lineage (three 38.0.0 artifacts, each with receipt identities, the earlier two labeled superseded and byte-identical); the incident records referenced (not rewritten) with a sentence that the clearing mechanism is removed; precise remaining acceptance limits (profiler provisioning, host discovery, Linux/Windows `tools/list`, emulator LOOK, physical device; perf-lane default target retained by choice; `pico_look` default target retained by choice). Update CHANGELOG 38.0.0 and the capability matrix. Run `test:docsmeta`, `test:distribution-adoption`, `test:lint`; commit.**

---

## Self-review

- Spec coverage: item 1 → T1 (pin regardless of inherited value, blank fails closed, harness override, all doors through the seam with a `{}` test); item 2 → T2 (fixture ledger + opt-in live comparison, scaled child clock, no production constant changed); item 3 → T3 (fallback removed, fail closed, unique retained canonical/emulator-look paths, default target unchanged); item 4 → T4 (every implicit clear replaced, marker windows, explicit serial + logWindow in results, one explicit destructive clear left with a required serial, incident text untouched); item 5 → T5 (Node major + provenance, selected toolchain watch, perf device pass-through, historical references preserved); item 6 → T6.
- Type consistency: `gateChildEnv(gate, env, io)`, `HARNESS_ADB_VARIABLE`, `observationCapturePath(kind, fileName)`, `openLogWindow/readLogWindow/sliceAfterMarker/newLogMarker/LOG_WINDOW_TAG`, `verifyDependencies(...).provenance`, `installedVersions(io)` are used with the same names throughout.
- Placeholders: T4 Step 5 pins one `file:line` the implementer fills from the tree after Step 4 (the explicit clear's real line); T2 Step 1 tells the implementer to read the writer signatures in `dist/ledger.js` before finalizing the fixture entries. Both are deliberate reads of the tree, not deferred design.
