# Questions answered by measurement

This page answers only the ecosystem questions for which this repository has narrow, tracked
evidence. Configuration, source-derived contracts, runtime logs, looked-at emulator frames, and
partner statements remain visibly distinct. A successful build or log is never presented as a
visual result, and emulator evidence is never presented as hardware evidence.

## Q5 — Which ABI is known good?

### Answer

The packaged Android scaffold declares `arm64-v8a`. That is the ABI in this repository's
known-good scaffold matrix.

### Evidence

Evidence type/class: `configuration`.

The [build matrix](BUILD_MATRIX.md#L1-L15) labels itself as one known-good scaffold matrix rather
than a support envelope. Its ABI value comes from the scaffold's
[`abiFilters.add("arm64-v8a")`](../appskeleton/app/build.gradle.kts#L19), which is also protected by
the [project-generation invariant](../test/projectgen.mjs#L49-L52).

### Does not prove

This does not establish the SDK's complete ABI support envelope, make `arm64-v8a` an SDK-wide
requirement, or show that another ABI succeeds or fails.

## Q23 — Who owns resources and teardown?

### Answer

The narrow pattern implemented here is to retain one app-owned `AssetBundle` while creating
multiple entities from it, retain and mutate resources used for repeated updates, and explicitly
destroy app-owned entities during teardown. A `close()` duty is asserted only for resource types
whose tracked API surface explicitly exposes it.

### Evidence

Evidence type/class: `source-derived` + `structural`.

The tracked Entity API accepts an `AssetBundle` in repeated `load`/`loadSuspend` calls and exposes
`destroy(boolean)` ([Entity signatures](spatial-interaction-api.md#L502-L550)). The scaffold's
`DemoPlacer` holds one bundle for the placer, loads each marker from that bundle, and destroys the
placed entities when clearing them ([shared bundle](../appskeleton/app/src/main/java/com/example/spatialapp/content/DemoPlacer.kt#L24-L34),
[instance and teardown path](../appskeleton/app/src/main/java/com/example/spatialapp/content/DemoPlacer.kt#L69-L97)).
The API inventory marks `ShapeResource` and `PhysicsMaterialResource` as explicitly closeable
([shape resource](spatial-interaction-api.md#L333-L350),
[physics material](spatial-interaction-api.md#L461-L469)). Ledger
`com.picoagent.mrtable#6` records the runtime failure caused by rebuilding meshes and materials per
tick and the retained-mutation correction ([tracked claims snapshot](claims/claims.json)).

### Does not prove

This is not a complete SDK ownership or reference-count table. It does not settle who closes every
bundle, subscription, controller, or native resource, and it does not imply that every scene tree
has the same teardown rules.

## Q24 — What threading rule is measured?

### Answer

In the measured paths here, blocking and network work runs off the main thread before Entity,
component, and hierarchy mutation is marshaled to Main. The repository's broadcast generators
encode binder-thread callbacks as off-main and post them before touching ECS state.

### Evidence

Evidence type/class: `structural` + `source-derived`.

Ledger `com.picoagent.mrtable#5` structurally records, through its runtime-log attestation, HTTP on
`Dispatchers.IO` followed by ECS application on Main; `com.picoagent.mrtable#6` structurally records
the main-thread resource-rebuild ANR and retained-resource fix
([tracked claims snapshot](claims/claims.json)). The scaffold constructs its scene inside
[`withContext(Dispatchers.Main)`](../appskeleton/app/src/main/java/com/example/spatialapp/content/HomeStage.kt#L28-L45).
Generated model loading performs bundle work on IO before Main-thread attachment
([model load path](../src/databinding.ts#L190-L218)), and the interaction generator explicitly
marshals binder-thread broadcasts through the main looper
([broadcast path](../src/interaction.ts#L101-L107)).

### Does not prove

This is not a complete threading contract for every SDK method or callback. It does not establish
that every non-ECS call is safe from an arbitrary thread, and the source-encoded broadcast contract
is not an independent runtime measurement of every callback path.

## Q25 — What GLB/glTF runtime route is proven?

### Answer

The bake implementation structurally accepts both GLB and GLTF as inputs to a `spatialbundle`
route, producing a `.bundle` for `AssetBundle.load` and `Entity.loadSuspend` at runtime. A historical
attestation says a Meshy GLB was visibly textured after that route, but its retained capture is
missing or no longer hash-bound and the current reader downgrades the row to `provenance-broken`.
There is therefore no current visual proof here for either a GLB or GLTF result.

### Evidence

Evidence type/class: `source-derived` + `structural`.

The historical visual attestation is retained only with `provenance-broken` status.

As `source-derived` evidence, the bake implementation accepts GLB/GLTF as a top-level scene, packs
it, inspects the result for texture and material assets, and returns the bundle-load snippet
([bake implementation](../src/bundle.ts#L16-L55)); the raw-file failure remains a route-specific
diagnosis and lint rule ([diagnosis](../src/diagnose.ts#L88-L99),
[lint rule](../src/lint.ts#L229-L240)). Ledger `com.picoagent.mrtable#0` records that its Meshy GLB
followed that bake-and-load lane and retains the historical looked-at attestation, but the current
snapshot reports broken pixel provenance rather than visual proof
([tracked claims snapshot](claims/claims.json)).

### Does not prove

This does not show that every raw runtime glTF route universally renders black, compare USD and
glTF feature coverage or performance, or guarantee that an arbitrary model renders correctly
without asset validation and a looked-at frame.

## Q33 — What is emulator-only versus hardware-proven?

### Answer

The repository's logs show that the emulator's MR simulation supplies semantic planes, while code
and structural records exercise collider/ray placement against them. A historical looked-at
attestation says app content was seated in the simulated room, but its retained capture provenance
is currently broken, so it is not current visual proof. Controller-ray and head-tracked-depth rows
remain deferred, and there is no effective real-hardware `device_verified` entry. The Full-Space
Guardian issue remains a partner statement rather than a hardware measurement made by this
repository. A 2026-09-01 emulator experiment did observe two manifest-Full apps yielding to PICO
system home by their second replay waypoint while a manifest-Mixed control retained through its
authored 32 m gate. The dynamic-Full row failed closed before movement, so this is not a completed
dynamic-versus-manifest comparison or a Guardian cause measurement.

### Evidence

Evidence type/class: `logcat` + `structural` + `partner-stated`.

The new route frames were individually LOOKed, but the staged experiment records their ceiling as
`vision_verified_eligible`; it does not silently promote them into the trust ledger.

The historical visual attestation is retained only with `provenance-broken` status.

Ledger `emulator-scene-understanding#0` records 43 planes from the emulator's MR simulation;
`pico-emulator-scene-understanding#0` records the later FLOOR/TABLE/CHAIR/DOOR/WINDOW semantics and
the need to poll ([tracked claims snapshot](claims/claims.json)). Ledger
`com.picoagent.mrtable#0` retains the historical looked-at seating attestation but is currently
`provenance-broken`, not visual proof. The public capability boundary keeps
controller-ray and head-tracked depth deferred ([capability boundary](../CAPABILITIES.md#L55-L63)),
while the hardware protocol says there is no effective real-hardware device proof and no Swan run
([hardware boundary](DEVICE_VERIFICATION.md#L1-L18)). The stage schema labels the Guardian caveat
as partner-stated and unmeasured ([stage contract](../src/appspec.ts#L49-L54)).
The staged M0/F1/F2/E1 receipts, every retained frame digest, recovery sequence, and configuration
limits are in the [Phase-1 boundary report](evidence/immersive-phase1-2026-08-31/CP3.md).

### Does not prove

Emulator planes are not evidence of real-hardware scene understanding. These facts do not establish
complete emulator/device parity, an exhaustive unsupported-feature list, Guardian behavior, a
dynamic-entry cause, calibrated physical distance, or any Swan result.

## Q36 — What was actually proved about `pico-cli project create`?

### Answer

On 2026-08-01, a `pico-cli` 0.3.0 stage-template project using Spatial BOM 0.13.3 built in 41
seconds and launched through `verify_pico_apk`. A historical attestation says its “Hello, Spatial
SDK!” panel was visible, but the retained capture provenance is currently broken. Raw Gradle
required explicit `JAVA_HOME` and `ANDROID_HOME`.

### Evidence

Evidence type/class: `structural`.

The historical visual attestation is retained only with `provenance-broken` status.

The dated interop run (internal runbook) structurally records the CLI and BOM versions,
command chain, build time, launch path, environment caveat, and ledger reference. Ledger
`com.vranywhere.cliproof#0` retains the looked-at attestation for the displayed panel, but the
current reader cannot validate its linked bytes
([tracked claims snapshot](claims/claims.json)).

### Does not prove

This does not establish parity with the official samples, cross-host portability, behavior of a
newer CLI version, coverage of other templates, or that a generated project locates its own
toolchain.

## Q37 — What changed between pico-cli 0.3.0 and 0.4.2?

### Answer

On 2026-08-12, the npm registry reported `@picoxr/pico-cli@0.4.2` as `latest`; 0.4.1 and
0.4.2 were both published on 2026-08-08. A scratch-prefix 0.4.2 install was compared with
the installed global 0.3.0. The measurement deliberately targeted fifteen named `--help` surfaces,
not a complete command-by-command or semantic diff: root, `perf`, `perf monitor`,
`perf trace`, `perf daemon`, `app`, `capture`, `emulator`, `device`, `files`, `log`, `mcp`,
`plugin`, `project`, and `doctor`, plus selected second-level help and bounded behavior
probes.

The registry still reported 0.4.2 as latest when checked on 2026-08-14. Both statements are dated
observations, not a timeless version claim.

Executed probes established that: (1) every tested 0.4.2 `perf` shape, including
`perf --help`, exits 1 with "Perf utilities 0.1.0 are not installed" until the one-time
`pico-cli setup`; (2) `mcp spatial-knowledge --help` remains a working hidden alias for the
renamed `mcp dev-knowledge` command (exit 0); (3) unknown top-level and tested unknown
subcommands exit 1 with "Error: Unknown command" on both versions; (4) 0.3.0
`perf daemon status` still exits 0 while its JSON reports `success:false`; and (5) 0.4.2
`doctor --format json` completes with a structured JSON envelope and process exit 0 rather
than hanging. The original run took 9.7s; independent repetitions on the same machine took
2.956–7.256s. Process exit 0 means the command returned, not that every doctor check passed.

Help output and packaged-source inspection, rather than execution of the affected command
bodies, established the remaining visible deltas: `files rm` defaults change from
recursive=true/force=true to false/false; `app watch-crash` still has no duration flag and
adds `--launch-timeout`; `app install` gains `-r/--replace`, `--downgrade`, `-t/--test`, and
`-g/--grant-permissions`; and new `update`, `editor`, and `web` families appear. Contrary to
the original sweep text, `app launch --help` is not byte-identical: 0.4.2 adds an Examples
block. The byte-identical subset is `capture record`, `capture screenshot`, `emulator
status`, `app stop`, `app list`, and `device`; `log` gains `-d/--device`.

The wider help-only review also found deltas omitted from the initial summary: root `shell`
and `device shell` gain `-d/--device`; `setup` gains `--platform spatial|unity` and
constrained tool/plugin choices; `plugin doctor` gains `--fix` and constrained choices;
`plugin update` gains constrained choices; `project create` makes name/package/template
required, adds `--sdk-type spatial|unity` and Unity templates, and revises `--force` and its
examples; emulator start/create/install source choices drop `internal` and add
`beta_cn|beta_global`; and the `plugin --help` doctor description changes. `update --check`
is non-installing but not host-read-only: packaged-source inspection shows it writes
`~/.pico/update-check.json`; it was not executed during the independent audit. These
additions correct the targeted inventory; they do not turn it into a complete release diff.

### Evidence

Evidence type/class: `structural`. Exit/timing statements above come from bounded child
processes. Flag, default, registration, and help-text statements come from verbatim `--help`
captures and packaged-source inspection; destructive, installing, updating, and indefinitely
running command bodies were not invoked. No rendered frames were involved.

Detailed targeted sweep record and per-family findings:
[findings/PICOCLI_042_SWEEP_2026-08-12.md](findings/PICOCLI_042_SWEEP_2026-08-12.md).
Code carrying the dated claims: `src/picocli.ts` (`setup-required` classification, doctor
re-measurement), `src/perftrace.ts`, `src/picoclitools.ts`, `src/knowledge.ts`.

### Does not prove

This is not a complete 0.3.0-to-0.4.2 diff. It does not verify the 0.4.2 perf-family flag
surface behind the setup gate (`pico-cli setup` mutates the machine and was not run), runtime
behavior for help/source-only deltas, end-to-end behavior against a device or emulator, that
the `spatial-knowledge` alias survives future releases, or 0.4.2 `doctor` behavior on machines
unlike this one (macOS arm64, Node v25.8.1).
