# Changelog

Versions here key the plugin manifests (`/plugin update` uses them as its cache key).

## Unreleased

- **Receipt-bound in-app locomotion has positive product-route evidence through 16 m.** At live-tested branch head
  `d1435ef`, CP2 exercised the Full-stage-only `run_in_app_locomotion_route` sequence over
  productized `0/1/2/4/8/16 m` routes with Guardian active and `0 m` measured drift at every
  accepted baseline/waypoint HMD sample. Every settled frame was LOOKed, and matched cold launches
  compared explicit direct glide with root replacement on one boot. Both mechanisms rendered the
  same five nonzero endpoints, but only direct returned to the byte-exact zero baseline. Direct is
  therefore the default; replacement is not a proven fallback, and neither selection silently
  switches mechanisms. Product receipts remain structurally capped. The complete detailed
  released-state probe is not retained before the earliest build/install mutation, so the exact
  staged-entry chronology remains unverified; later same-boot and per-route safety evidence is
  stated separately.
- **Later locomotion orchestration hardening is fake-gated, not a second live run.** After CP2
  released the emulator, nested downstream-proof deadlines, strict handoff/completion guards,
  nested restoration-stage fences, pre/post immutable-action publication fences, filesystem-only
  idempotent audit repair, and three-state receipt-bound prior freshness evidence were added and
  exercised against rebuilt fakes. Post-link timing incidents remain explicit, as do the unclaimed
  crash-durability interval before directory fsync and the possible aggregate latency of per-process
  cleanup-only timeouts. No post-live emulator rerun occurred, and this hardening does not broaden
  the rendered-frame result above. Emergency-stop cleanup now requires an in-deadline successful
  stop receipt followed by exact target absence before nonce removal, never relabels a potentially
  moved baseline as zero, and gates terminal safe
  release on center `0,0,0` plus fenced audit publication. Same-package non-receipt prior relaunch
  declarations are rejected as non-convergent. The `0.02 m` translation threshold remains
  experimental, and quaternion telemetry still has no invented gate.

## 38.0.0 — 2026-09-15

The Unreleased entries above accumulated on main after 37.0.0 and ship with 38.0.0 as they stand.
Everything below is a compatibility-affecting change from the pico-cli 0.5 / Spatial SDK 6.1
checkpoint, [docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md](docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md).
That checkpoint is fixture- and host-executed evidence, not a native, visual or cross-platform
acceptance, and the same limit applies to every line here.

- **Knowledge argv is version-dependent.** The knowledge child launches `knowledge server` on
  pico-cli 0.5.x and `mcp dev-knowledge` on 0.4.x, selected per resolved version from retained
  help evidence; the 0.5.0 knowledge server's own data gap (it execs an external `graphify serve`)
  is reported as that server's, not as an MCP failure. An environment-classed knowledge refusal is
  worded for the knowledge operation, no longer as a profiler-payload problem.
- **`watch_crash` reports the observed window, not the requested one.** `watchedSec` is the
  elapsed time from a monotonic clock; new `observation`, `coverage` (`complete` / `partial` /
  `unknown`) and `assessment` fields, and `no-crash-detected` requires complete coverage AND a
  complete log scan. `device` is REQUIRED — in the input schema, not only in prose — with no
  default serial.
- **`perf_diagnose` (and the `pico_perf` door) dispatches `perf live run`** from capability
  evidence instead of `perf monitor run`, which 0.5.0's router rejects; a new result shape with
  measurement/capability semantics, and a SKIP / INSUFFICIENT_DATA report grades `missing`, never
  a passing budget.
- **Doors forward inner errors with `isError: true`.** `pico_look` reports a capture failure as an
  error instead of `{status:"ok"}`, and concurrent first door calls share one inner server. A test
  server injected with only a domain-lane `call` now refuses the two raw-lane doors (`pico_look`,
  `pico_verify_app`) instead of spawning the real inner server.
- **`verify_pico_apk` / `pico_verify_app` observe an explicitly named device.** New result shape
  (identity, capture provenance, a PID-scoped log, an immutable run directory — a structural
  observation, never a receipt); `serial` is REQUIRED in the input schema with no hardcoded
  emulator; the tool force-stops only the package it installs, never clears the global logcat,
  and never stops a foreign app.
- **`capture_frame` and `capture_record` require an explicit target** (`serial`; `device`,
  REQUIRED in the input schema) and write run-unique outputs under the observation root instead of
  a fixed shared path. `capture_record`'s description now states that `status` grades the recording
  call while `media` is the separate validation verdict (`unvalidated` = not inspected).
- **`scaffold_spatial_app` refuses without a usable packer** instead of scaffolding blind, and
  preserves a project's declared BOM byte-for-byte.
- **An explicit `PICO_ADB` that names no usable file fails closed** with a structured error in
  every adb consumer; nothing falls through to a PATH or bundled candidate. adb resolves lazily,
  never at module load.
- **Component-valid toolchain selection.** Packer, emulator, adb, proto and editor are selected
  from one installation per operation (explicit root, then `spatial.tools.dir`, then `$PICO_HOME`,
  then the platform default) with structured `unavailable/*` and `ambiguous/*` failures and
  explicit provenance when a binary override is honoured. `install_editor_palette` now selects the
  editor bundle the same way (an explicit `editorApp` still wins) instead of re-signing a
  hardcoded 0.13 path.
- **The build script is source-bound.** `npm run build` publishes `dist/` wholesale through a
  staging rename and emits `dist/build-receipt.json`; `run-gate` refuses a gate whose `dist/` is
  stale; the plugin bootstrap rebuilds on source and dependency identity; smoke is hermetic; one
  inventory (`scripts/gate-inventory.mjs`) owns every gate and its CI lane; and every
  fixture/installed-artifact gate child runs under `PICO_ADB=/fixture/no/such/adb`, replacing
  whatever the shell inherited — a real adb, an empty string and whitespace are all discarded,
  never passed through. The one pass-through is `PICO_GATE_FIXTURE_ADB` naming an absolute
  executable fake; anything else in that variable refuses the gate (exit 2) before a child
  exists, a real adb included — an override whose realpath is an `adb` found in a directory on
  the caller's PATH, or up to three levels under `$PICO_HOME` or `~/Library/PICO`, is refused the
  same way, by filesystem reads alone. A blank value fails closed wherever it is read: `src/adb.ts`
  refuses an explicit adb that names no file and probes nothing else, the doctor's adb row applies
  the same rule instead of falling back to a PATH probe (so the emulator row cannot run
  `adb devices`), and the native fleet receipt reader resolves through the adapter rather than
  reading the variable as a string.
- **`--publish` is add-only.** `scripts/verify-tarball.mjs --publish <file>` takes a file path,
  refuses to replace an existing artifact or receipt, and never prunes a directory.
- **Shipped payload.** `data/sdk-compatibility` ships (a home-path-redacted derivative of
  `docs/SDK_6_0_0_DRIFT.md`, recorded as such), and vault lookups headline `target-verified` only
  on verified matches with explicit provenance.

The entries below land in the same 38.0.0 line from the 2026-09-16 host-only completion pass.
They carry the same evidence limit as everything above: fixture- and host-executed, never native,
visual, device, cross-platform or end-to-end.

- **Observation opens a marker window; nothing clears the device log.** `assert_scene`,
  `probe_planes`, the copilot snapshot loop, `build_and_run`, `pico_loop`, `wait_for_log`,
  `assert_logcat`'s `clearFirst` and the boundary experiment's prepare step all write one marker
  line and read a bounded dump sliced after it. A marker that is not in the dump is INCONCLUSIVE —
  never a match against the unscoped buffer. Wire contract: `assert_logcat` gains a `sinceMarker`
  input and its result gains `serial`, `logWindow` and `status:"inconclusive"`; `clearFirst` opens
  a window and erases nothing (kept for compatibility); `wait_for_log`'s matched result is now
  JSON (`{matched, elapsedSec, serial, logWindow, lines}`) instead of prose; `build_and_run`'s
  output gains required `serial` and `logWindow`. The one explicit destructive clear left,
  `logcat clear:true`, now REQUIRES an explicit serial — no sole-device resolution stands in for a
  named target on an irreversible operation.
- **Bounded reads are sized per caller: `maxLines`.** `assert_logcat` and `wait_for_log` take an
  optional `maxLines` (integer, 100..200000, default 20000); the module default stays 4000 for the
  short tag-filtered reads. It bounds the WINDOWED read only — the one `clearFirst` opens or
  `sinceMarker` names; an unwindowed read still dumps the whole buffer and the input is inert
  there. `pico_loop` passes 50000 because it writes its marker BEFORE a multi-minute `fleet_build`;
  `build_and_run` reads its settle-long correlation with 20000. logd applies `-t <n>` to the
  selected buffers BEFORE the client-side tag filter, so a chatty device can evict the marker from
  the tail: the result is then inconclusive (`pico_loop` maps it to `unmeasurable`), never a false
  pass. `assert_logcat`'s inconclusive result additionally carries `maxLines` and
  `dumps: {succeeded, lastError}`, so a dead adb is reported as the dump failure it is rather than
  as log eviction. The eviction rate on a real PICO device is unmeasured.
- **Canonical LOOK captures are retained, not overwritten.** `capture_canonical` and
  `emulator_look` default to run-unique paths under the observation store instead of one fixed
  shared file, so a new capture can never destroy the frame a previous LOOK judged. Their default
  TARGET is unchanged this checkpoint.
- **`--publish` has no replacing primitive left to reach for.** Where atomic non-replacing
  publication (a hard link) is unavailable, `scripts/verify-tarball.mjs --publish` fails closed
  with `PUBLISH_NO_ATOMIC_PUBLICATION`; the replacing-rename fallback is removed from the
  publication IO itself, not merely unused.
- **Build receipts gain `nodeMajor`; `verifyDependencies()` gains `provenance`.** Hidden-lockfile
  adoption never crosses a Node major and never turns unknown provenance into a verified
  installation identity: a receipt from another major, one with no readable `nodeMajor`, and one
  that is present but unreadable or wrong-shaped all reinstall instead of adopting, and none of
  them reports `npm-ci` provenance it did not earn. The same rule makes an `IDENTITY_SCHEMA_VERSION`
  bump cost every host one `npm ci` instead of a free adoption — deliberate, and recorded here so
  it is not rediscovered as a regression.
- **`check_toolchain_updates` reports per-component `installed.selection`** (`{emulator, editor}`)
  resolved through the same component-valid selection every other operation runs. A host whose
  emulator and editor legitimately resolve to different installations is no longer misreported
  through one shared field.
- **Explicit device selection reaches the perf lane.** The `pico_perf` door accepts `device` and
  forwards it; `perf_diagnose` and the door report `requestedDevice` on every outcome — success,
  SKIP and failure — so the profiled target is named whether the caller chose it or the wrapper's
  documented default did. That default (`DEFAULT_PERF_DEVICE`) is unchanged this checkpoint.
- **`NativeFleetFailureStage` gains `adb-resolution`.** A new member of a persisted `…V1` receipt
  union (type-only; no stored receipt changes shape). It is reachable only for callers that omit
  `adbPath`; `fleet_build` passes `ADB()` eagerly, so its own throw remains the user-visible
  refusal there.
- **Two required gates are deterministic without weakened assertions.** `test:claims` builds a
  fixture ledger through the real writer API and compares a byte-for-byte expected manifest; the
  tracked-snapshot consistency checks are unchanged, the real ledgers and the public claims page
  are untouched, and the live-ledger comparison is opt-in with `PICO_CLAIMS_LIVE_LEDGER=1` on the
  ledger-owning machine. `test:runrevision`'s capacity children run under an explicit test-only
  clock scale (`PICO_RUNLOCK_CHILD_CLOCK_SCALE`, read by `test/fixtures/runlock-child.mjs`)
  instead of a wall-clock timing assumption; no production limit, budget or assertion changed.

## 37.0.0 — 2026-08-14

- **Managed registry-latest pico-cli is now the default.** The first real CLI-backed operation
  resolves the registry version and installs that exact package into an immutable MCP-owned cache;
  it does not replace or invoke an ambient global CLI and does not change `PATH`. The result exposes
  its absolute path, selected/latest versions, `checkedAt`, policy, action, and freshness.
- **Read-only boundaries remain explicit.** Startup, tool registration and `tools/list`,
  `preflight_env`, and default `pico_doctor {}` do not contact npm, provision a package, or write
  the managed store. `pico_doctor {calibrate:true}` remains the separately documented mutating
  exception. Setup remains a manual user-run command; the MCP never runs setup or `update --check`.
- **Honest fallback and migration.** Registry failure may reuse a validated cache only as
  `freshness:"unknown"`; failure to install a known-newer version reports
  `freshness:"outdated"`. `managed-cached`, absolute-path `external`, and `disabled` are explicit
  escape hatches. The deprecated `PICO_MCP_AUTOINSTALL_CLI=1` and
  `PICO_MCP_AUTOUPDATE_CLI=1` aliases map to `managed-latest` through 37.x and never install
  globally; the deprecated `ensure_pico_cli {update:...}` input is inert while the health tool
  force-refreshes.
- **Compatibility observation, not a release guarantee.** 0.4.2 was registry latest when checked
  on 2026-08-14. The version-agnostic compatibility sweep traverses the complete reachable
  advertised help-only tree except the prohibited top-level setup subtree. It does not establish
  semantic compatibility, hidden aliases, perf behavior behind setup, emulator/device behavior,
  native Windows behavior, or visual evidence. A user/PICO-team v1.0 date remains unverified
  planning input rather than repository-verified release evidence.

## Audit corrections — 2026-08-12
- **Trust-ledger provenance correction.** New image-grounded entries copy their validated bytes
  into a ledger-owned content-addressed store; every reader re-hashes those stored bytes and
  reports missing, malformed, or changed evidence as `provenance-broken`, never as visual proof.
  Retractions are now append-only events. The local `com.fleet.door448144` ledger retracts seq 2:
  an independent pixel review judged its attestation accurate and conservative, but the mutable
  fleet path had overwritten the recorded bytes, so the cryptographic binding—not the looking—
  failed. The intact door802 capture was materialized into the store; its inconsistent machine
  summary row was retracted and replaced as a CAS-backed historical correction. Because no
  contemporaneous producer receipt survives, readers downgrade that replacement to `structural`
  rather than retaining `auto_judged`.
- **Strongest-tier device provenance correction.** New `device_verified` rows cannot be minted
  from caller-supplied identity strings or an arbitrary image. `record_verification` probes the
  supplied adb serial's model/fingerprint/qemu marker live, rejects emulator/non-PICO shapes, and
  requires a fresh screencap from that same serial to be byte-identical to the already-LOOKED
  artifact. Legacy rows without both live-probe and capture-binding metadata downgrade to
  `vision_verified` at most; they cannot close Swan parity. CI tests use explicitly injected
  identity/capture fixtures and prove only the schema flow—no Swan hardware was available.
  `ship_checklist` now fails closed: current native or web bytes are not considered production
  ready until a digest-bound receipt links them to a successful build/install or deploy/session
  and the looked frame. File existence is reported only as deferred path evidence.
- **Battery-evidence correction.** The six commit messages `cca05be`, `178295a`,
  `8153156`, `d94e6cf`, `f10a0b2`, and `bf65ab2` said all 44 `test:` suites were
  green locally. That evidence was incomplete: the fail-fast runner stopped on `smoke` at
  invocation 1/45 because of the known environmental `scene_schemas` failure, so those runs
  did not execute the remaining 44 invocations. An independent later audit ran all 44
  remaining invocations and observed exit 0 from each. The later outcomes were green; the
  earlier commit-message claims were not earned by the cited runs. The tracked battery runner
  now executes every invocation and prints an aggregate pass/fail summary before setting its
  exit code.
- **Schema-token measurement correction.** The earlier approximate registration figures came
  from the characters ÷ 4 heuristic, not a tokenizer. An independent audit measured compact
  `JSON.stringify(result.tools)` arrays returned by `tools/list`, using `tiktoken` 0.13.0 and
  `o200k_base`: doors was **5,029**
  tokens, the rejected uncommitted workbench snapshot was **28,208**, and full was **86,927**.
  The rejected snapshot was **32.45%** of full by this method. These are raw MCP schema-payload
  measurements, not the total host context after host-specific wrapping or other prompt content.
- **Tool-count provenance correction.** Full registered **249 tools on macOS** and **246 on
  Linux** in measured runs. The corresponding Windows count of 246 was source-derived; no
  native Windows `tools/list` measurement was performed. The rejected workbench snapshot
  registered 90 tools on macOS; its 87-tool non-macOS count was source-derived, not
  native-host-measured.
- **Rejected workbench wave.** The uncommitted 90-tool middle surface was dropped after audit:
  its advertised compiler/capability/prompt paths named tools the surface did not register, so it
  was not capability-closed. Repairing that architecture would have erased the context saving
  that justified the tier. No workbench surface or workbench metadata is shipped.
- **Loop-evidence correction.** The performance ledger entry cited by `d94e6cf` retains p5 and
  average values, not the complete `perfTrend` implied by that commit message. The
  `built-needs-look` evidence cited by `f10a0b2` established a capture obligation, but an
  unscored or skipped eye result was not evidence that the calibrated eye itself escalated.
- **Loop-behavior correction.** `pico_loop` now consumes launch logcat before structural probes
  can clear it, detects progress from the complete AppSpec rather than `recompileSubtree`, and
  sends only failures with a concrete retained-lesson mutation to `replan_spec`. Unsupported
  structural/logcat/perf failures stop as `manual-repair-required` instead of being mislabeled
  `build_failed`. Its look-obligation output now distinguishes an explicit eye `ESCALATE` from an
  absent or unknown score. A no-op retained lesson returns `manual-repair-required`, and
  `replan_spec` says `patched` only when the returned AppSpec actually changed. Fleet output now
  separates a measured eye PASS from a successfully recorded `auto_judged` row; a rejected ledger
  write cannot produce an `auto_judged` loop ceiling or a false “recorded” note.
- **Door-status correction.** `pico_build_app` no longer returns the literal status `verified`
  from a calibrated-eye PASS. A durably recorded machine PASS is
  `auto-judged-needs-look`; other captured builds are `built-needs-look`, and install/capture
  gaps are named separately. Only the later human/agent LOOK can earn `vision_verified`.
- **Ledger-reader and correction-lane correction.** The existing `record_verification` and
  `pico_record` tools can append mutually exclusive retraction events without increasing either
  surface's tool count. The eval/factory reports preserve `device_verified` as a distinct strongest
  tier and also expose the combined human-looked total, rather than undercounting device proof.
- **Typed-contract correction.** `capability_report` accepts its advertised `auto_judged` and
  `usd_host_render` inputs only so it can return an explicit structural downgrade; only
  `visual_judge` and `render_usd_offscreen` can mint those producer-backed tiers. Smoke coverage calls
  the `verify` and `build_and_run` non-error structured-output paths; the latter uses hermetic fake
  Gradle/adb programs and does not install an APK or boot an emulator.
- **Build/run and web-package truth hardening.** `build_and_run` now invokes the scoped assemble
  task, derives `applicationId` from AGP output metadata, requires a positive launch result and live
  PID, and scopes post-launch logs to that PID. The implementation is explicitly POSIX-host-only;
  the native Windows contract remains unexecuted and unmeasured. `package_web_pwa` validates the
  caller's existing HTML plus a 512px icon and returns `scaffolded`; it does not describe the output
  as installed, hosted, or otherwise ship-ready.

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
  mutates an app nothing has judged wrong. The loop was exercised twice on the emulator (26 s):
  before the fix the same goal dead-ended no-progress; after it, built-needs-look with the
  capture handed over. The capture was then LOOKED at and the three-crystals claim recorded
  `vision_verified` with an honest attestation (spin/menu/stone-floor explicitly unproven). That
  visual row is now retracted because its original mutable bytes cannot be recovered; the
  attestation was judged accurate, but its cryptographic binding failed (see the audit correction).

## 36.5.0 — 2026-08-12
- **Perf loop lane in `pico_loop`** (the 2026-08-12 call's second lane): a perf acceptance
  criterion measures, optionally applies a matching retained-lesson repair, and re-measures.
  The iteration ledger claim retains the measured p5 and average plus the report path; the returned
  `perfTrend` carries the broader before→after report (labeled structural: numbers moved, not
  looks). A perf failure carries pico-cli's own diagnosis-engine verdict and the report path, but
  without a concrete retained mutation it now stops `manual-repair-required`. Honest residue: a live loop-to-acceptance
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
  Doors surface is now 18 tools (16 doors + 2); full surface measured 249 tools on macOS and
  246 on Linux. The Windows count of 246 was source-derived, not native-host-measured.

## 36.3.0 — 2026-08-12
- **Default surface is now `doors`** (the 2026-08-12 tool vetting's #1 finding): with
  `PICO_MCP_SURFACE` unset the server registers the 17-tool intent facade instead of the
  full surface (248 tools on macOS / 245 on Linux; the Windows count was source-derived).
  The then-published ~88.5k registration estimate used characters ÷ 4 rather than a tokenizer. Docs
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
  `pico-cli setup` — the current `setup-required` failure class carries that exact remedy;
  `app watch-crash` still has no duration flag (kill-bound stays required);
  `capture record` flags byte-identical; `mcp spatial-knowledge` renamed
  `dev-knowledge` (the old name worked as a hidden alias in that measurement; production now
  invokes the advertised name); 0.4.2 `doctor` returned JSON in
  2.956–9.7s on this machine. The earlier ≥90s 0.3.0 observation was not repeated, so this does
  not establish an upstream fix; the sub-second `-v` probe stays.

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
