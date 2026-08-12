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
tick and the retained-mutation correction ([tracked claim](claims/claims.json#L2207-L2215)).

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
([tracked claims](claims/claims.json#L2195-L2215)). The scaffold constructs its scene inside
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
route, producing a `.bundle` for `AssetBundle.load` and `Entity.loadSuspend` at runtime. The one
looked-at end-to-end textured result in the tracked ledger used a Meshy GLB; there is no equivalent
looked-at GLTF result recorded here.

### Evidence

Evidence type/class: `source-derived` + `structural` + `vision_verified`.

As `source-derived` evidence, the bake implementation accepts GLB/GLTF as a top-level scene, packs
it, inspects the result for texture and material assets, and returns the bundle-load snippet
([bake implementation](../src/bundle.ts#L16-L55)); the raw-file failure remains a route-specific
diagnosis and lint rule ([diagnosis](../src/diagnose.ts#L88-L99),
[lint rule](../src/lint.ts#L229-L240)). As structural provenance, ledger
`com.picoagent.mrtable#0` records that its Meshy GLB followed that bake-and-load lane; its linked,
looked-at capture provides the `vision_verified` evidence that this particular table was visibly
textured ([tracked claim](claims/claims.json#L2114-L2131)).

### Does not prove

This does not show that every raw runtime glTF route universally renders black, compare USD and
glTF feature coverage or performance, or guarantee that an arbitrary model renders correctly
without asset validation and a looked-at frame.

## Q33 — What is emulator-only versus hardware-proven?

### Answer

The repository proves that the emulator's MR simulation supplies semantic planes and can visibly
seat app content against its simulated room. Controller-ray and head-tracked-depth rows remain
deferred, and there are no `device_verified` entries. The Full-Space Guardian issue is a partner
statement, not a measurement made by this repository.

### Evidence

Evidence type/class: `logcat` + `vision_verified` + `structural` + `partner-stated`.

Ledger `emulator-scene-understanding#0` records 43 planes from the emulator's MR simulation
([tracked claim](claims/claims.json#L2469-L2480)); `pico-emulator-scene-understanding#0` records the
later FLOOR/TABLE/CHAIR/DOOR/WINDOW semantics and the need to poll
([tracked claim](claims/claims.json#L2926-L2938)). Ledger `com.picoagent.mrtable#0` links the
looked-at textured table seated in that emulator environment
([tracked claim](claims/claims.json#L2114-L2131)). The public capability boundary keeps
controller-ray and head-tracked depth deferred ([capability boundary](../CAPABILITIES.md#L55-L63)),
while the hardware protocol says the ledger has zero device entries and has never run on Swan
([hardware boundary](DEVICE_VERIFICATION.md#L1-L18)). The stage schema labels the Guardian caveat
as partner-stated and unmeasured ([stage contract](../src/appspec.ts#L49-L54)).

### Does not prove

Emulator planes are not evidence of real-hardware scene understanding. These facts do not establish
complete emulator/device parity, an exhaustive unsupported-feature list, Guardian behavior, or any
Swan result.

## Q36 — What was actually proved about `pico-cli project create`?

### Answer

On 2026-08-01, a `pico-cli` 0.3.0 stage-template project using Spatial BOM 0.13.3 built in 41
seconds, launched through `verify_pico_apk`, and displayed its “Hello, Spatial SDK!” panel in a
looked-at emulator frame. Raw Gradle required explicit `JAVA_HOME` and `ANDROID_HOME`.

### Evidence

Evidence type/class: `structural` + `vision_verified`.

The dated interop run (internal runbook) structurally records the CLI and BOM versions,
command chain, build time, launch path, environment caveat, and ledger reference. Ledger
`com.vranywhere.cliproof#0` carries the looked-at capture and attestation for the displayed panel
([tracked claim](claims/claims.json#L2447-L2465)).

### Does not prove

This does not establish parity with the official samples, cross-host portability, behavior of a
newer CLI version, coverage of other templates, or that a generated project locates its own
toolchain.
