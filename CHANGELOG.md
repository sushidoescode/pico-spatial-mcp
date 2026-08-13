# Changelog

Versions here key the plugin manifests (`/plugin update` uses them as its cache key).

## Audit corrections — 2026-08-12
- **Battery-evidence correction.** The six commit messages `cca05be`, `178295a`,
  `8153156`, `d94e6cf`, `f10a0b2`, and `bf65ab2` said all 44 `test:` suites were
  green locally. That evidence was incomplete: the fail-fast runner stopped on `smoke` at
  invocation 1/45 because of the known environmental `scene_schemas` failure, so those runs
  did not execute the remaining 44 invocations. An independent later audit ran all 44
  remaining invocations and observed exit 0 from each. The later outcomes were green; the
  earlier commit-message claims were not earned by the cited runs. The tracked battery runner
  now executes every invocation and prints an aggregate pass/fail summary before setting its
  exit code.

## 36.6.0 — 2026-08-12
- **Typed outputSchema wave 2** (2026-07-28 revision lane, vetting optimization #3): the
  five JSON-contract CLI/doctor tools — `perf_diagnose`, `perf_trace`, `watch_crash`,
  `capture_record`, `preflight_env` — now advertise typed output contracts and return
  SDK-validated `structuredContent` on every non-error branch (ok / failed / unavailable).
  The de-facto CLI-wrapper core (status / failureClass / note / outputTail /
  outputTruncated / honesty / cliProvisioning) is declared once (`cliWrapperContractShape`)
  and the honesty rules ride in the schema descriptions (stat-checked artifacts, "exit 0 is
  not evidence", appFps-zeros semantics, crash-scan partiality). All five live-validated on
  this machine against the real 0.3.0 CLI across ok, failed, duration-cap, and
  artifact-stat branches; ten tools now carry typed contracts (smoke asserts the list).
- **First live `accepted` exit for `pico_loop`** (evidence, no code change): a stage-3
  color-keyed crystals build reached `accepted`/`auto_judged` in 35 s; the follow-up LOOK
  found the procedural environment rendered BLACK behind correctly-rendered crystals —
  recorded `vision_verified` with the gap in the attestation (ledger
  com.fleet.door802332). Candidate lesson: stage-3 `procedural` environment renders black
  — needs a diagnose/replan lesson once root-caused.

## 36.5.1 — 2026-08-12
- **`pico_loop`: an eye ESCALATE is a look obligation, not a defect** — found by the first
  live loop run (crystals brief on the emulator): the eye escalated (high-coverage
  passthrough frames are machine-unjudgeable by design), and the loop wrongly treated that
  as a repairable failure. New `needs-look` criterion state: verdict PASS = pass, FAIL =
  repairable, anything else = needs-look; once everything measurable passes the loop exits
  **`built-needs-look`** with the capture in `remainingLookObligation` — repair never
  mutates an app nothing has judged wrong. Live-verified twice on the emulator (26 s):
  before the fix the same goal dead-ended no-progress; after it, built-needs-look with the
  capture handed over. The capture was then LOOKED at and the three-crystals claim recorded
  `vision_verified` with an honest attestation (spin/menu/stone-floor explicitly unproven).

## 36.5.0 — 2026-08-12
- **Perf loop lane in `pico_loop`** (the 2026-08-12 call's second lane): a perf acceptance
  criterion now makes the loop a measure→fix→re-measure cycle with the evidence kept —
  every iteration's pico-cli appFps numbers (p5/p10/p50/avg, jank-window count, report
  path) are recorded into the iteration's trust-ledger claim and returned as `perfTrend`
  on every exit (before→after, labeled structural: numbers moved, not looks). A perf
  failure carries pico-cli's own diagnosis-engine verdict and the report path — grounded
  repair, never a guess from code structure. Honest residue: a live loop-to-acceptance
  perf run needs a perf-measurable session (emulator appFps is often the no_3d_frame
  case; real-device evidence pending Swan hardware).

## 36.4.0 — 2026-08-12
- **`pico_loop` (door 16)** — the declarative build→verify→repair loop, shipped after the
  2026-08-12 PICO call confirmed the Loop Engineering reading (the summer's agentic-loop
  practice) and deferred loop placement to this project's recommendation: the loop runs
  inside the server as one declarative call, and the host can still drive the
  verify/diagnose/repair primitives itself. State a goal + acceptance criteria
  (structural / visual / logcat / perf) + a `meta.budget`-shaped budget; the loop plans,
  builds through the fleet pipeline, machine-checks every criterion, and repairs via
  retained lessons (`replan_spec`) until accepted or honestly stopped. Exit bar per the
  call: a strong, clear auto-judge — the loop self-exits at the `auto_judged` ceiling and
  returns a `remainingLookObligation`; the human/vision LOOK stays mandatory before any
  `vision_verified` claim. No-progress detector (two consecutive identical failure
  signatures ⇒ stop), unmeasurable-criterion honesty (a lane that cannot be measured stops
  the loop instead of silently passing), one structural trust-ledger entry per iteration.
  Doors surface is now 18 tools (16 doors + 2); full surface 249 on macOS / 246 elsewhere.

## 36.3.0 — 2026-08-12
- **Default surface is now `doors`** (the 2026-08-12 tool vetting's #1 finding): with
  `PICO_MCP_SURFACE` unset the server registers the 17-tool intent facade instead of the
  full surface (248 tools on macOS / 245 elsewhere, ~88.5k tokens of registrations). Docs
  and every host config already said `doors`; the code now matches. **Migration:** set
  `PICO_MCP_SURFACE=full` to keep the old env-unset behavior — nothing is removed, and
  the doors' inner orchestration is unaffected (it always pinned `full` explicitly).
  Plugin installs (Claude Code, Cursor, Codex, portable) launch env-less and therefore
  now get the doors surface by default. Gated: env-unset assertions in `test:doors` and
  the tarball verifier. The flip's adversarial review found four internal self-spawns
  (fleet_build, build_hybrid_experience, ingest_marble_world, semantic splat) whose SDK
  child env never inherits the variable — each now pins `PICO_MCP_SURFACE=full`
  explicitly, and a static `test:doors` guard keeps future self-spawns pinned.
- **Typed outputSchema on the five highest-value tools** (2026-07-28 MCP revision lane,
  live on SDK v1): `validate_toolchain`, `capability_report`, `diagnose`,
  `build_and_run`, `verify` now advertise typed output contracts and return matching
  `structuredContent` on every non-error call (SDK-enforced server-side). The honesty
  split is in the schemas: `build_and_run.rendered` is a logcat marker, `verify.visual`
  only ever counts frames captured — appearance has no machine field because looking is
  the agent's job. Smoke asserts the contract on all five and round-trips three live.
- **pico-cli 0.4.2 re-verification** (measured 2026-08-12, sandboxed npm install; see
  ANSWERED_BY_MEASUREMENT Q37): 0.4.x gates the perf family behind one-time
  `pico-cli setup` — new `not-provisioned` failure class carries that exact remedy;
  `app watch-crash` still has no duration flag (kill-bound stays required);
  `capture record` flags byte-identical; `mcp spatial-knowledge` renamed
  `dev-knowledge` (old name still works as a hidden alias); 0.4.2 `doctor` returns
  JSON in ~10s (the 0.3.0 hang is fixed upstream; the sub-second `-v` probe stays).

## 36.2.0 — 2026-08-11
- Public-launch readiness wave: canonical repo slug everywhere
  (`sushidoescode/pico-spatial-mcp`), maintainer identity (README Maintainer section,
  package.json author/repository/bugs, NOTICE), `.env.example`.
- Lazy bounded pico-cli auto-provisioning (opt-in via `PICO_MCP_AUTOINSTALL_CLI=1`,
  default OFF; doctor commands never invoked) + dedicated Windows CI lane.
- Plugin cold-start: bootstrap now runs `npm ci` only when node_modules is missing and
  `tsc` only when dist/ is missing (Claude Code pre-installs deps; first launch drops
  to a ~15 s build).
- Docs corrected against the shipped code: doors-surface calibration via
  `pico_doctor {calibrate:true}` (no surface switch), 14 preflight checks, degraded-mode
  (no SDK/emulator) statement, tarball-vs-repo link hygiene.
- CI hardening: gate-battery uniqueness fix, headless-runner fixes for the tarball
  spaced-path probe and the CMIO zero-device topology, node 20/22 matrix, npm cache,
  concurrency + timeouts.

## Earlier
- See git history (`v27` … `v36.1`): brief-to-verified-APK lanes, vision-verified trust
  ledger, world-model ingest, agent-vault SDK validation, doors surface, emulator drive.
