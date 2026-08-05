# Task 2 report — measured SpatialUI container and gesture lanes

## Delivered

- Added `generate_subwindow_kotlin` as a pure generator and full-surface MCP tool. It returns one replacement `Main.kt` with an executable ownership contract, retains the caller's safe named primary composable in one `DefaultStage`, declares one named secondary `WindowContainer`, carries an initial id/tag/Bundle snapshot, reads the receiver-owned `bundle`, applies receiver-only `windowConstraints` to the first root child, and emits an attached `Subwindow`. Mixed remains a caller-owned AndroidManifest style-1 contract recorded in `manifestNotes`; the generator does not edit or verify it. The default stub needs no secondary manifest declaration; an optional custom Activity must use the same DSL id and remain separate from launcher metadata.
- Added `generate_spatial_gestures_kotlin` as a pure generator and full-surface MCP tool. It emits three separate target-filtered pointer-input blocks, an `InteractableComponent`, the exact five-argument primitive `CollisionComponent`, a concrete `select:<id>` tap route, caller-owned drag/scale callbacks, and a full x/y/z Density px-to-dp-to-meters boundary represented as `Vector3`. A converter-derived 20-centimeter interaction size exercises the other current unit spelling without hand conversion.
- Extended `generate_spatial_ui` with source-grounded `titleBar`, `toolbar`, `tabBar`, `sheet`, `snackbarHost`, `coachmark`, and `segmentControl` variants. Imports are variant-conditional; Toolbar/TabBar remain root/container augments; Sheet/SnackbarHost/Coachmark require a secondary-window spec. Expanded callbacks are explicitly no-op structural placeholders. The generator owns no Stage/WindowContainer, and its expanded header says compilation and a LOOK remain pending.
- Preserved legacy card/menu/list output byte-for-byte with fixed SHA-256 goldens. Added the repo-only, explicitly non-executable structural recipe `examples/docs-adoption-workbench.json`, with retained `HomeStage()` generator args, two saturated target specifications, replayable tool arguments, a complete missing-integration checklist, caller-applied Mixed manifest contract, LOOK-gated visual claims, no benchmark membership, and deliberate npm-package exclusion.
- Registered the two tools, added structural capability rows, tarball/smoke anchors, package/CI parity, and synchronized the public surface to 238 tools, 16 doors, and 42 gate invocations (41 `test:` scripts plus smoke).

## SDK 0.13.3 provenance

`test/fixtures/sdk-adoption-provenance.json` records stable Maven coordinates and source-jar entries for every adoption symbol. The primary local sources were:

- `com.pico.spatial.ui:design:0.13.3`: `windows/Subwindow.kt`, `windows/Toolbar.kt`, `windows/TabBar.kt`, `windows/Sheets.kt`, `windows/Snackbar.kt`, `windows/Coachmark.kt`, `TitleBar.kt`, and `SegmentControls.kt`.
- `com.pico.spatial.ui:foundation:0.13.3`: `dsl/SpatialAppScope.kt`, `dsl/Stage.kt`, `dsl/WindowContainer.kt`, `dsl/WindowContainerSize.kt`, `geometry/Offset3D.kt`, and the tap/drag/scale detector plus `TargetEntity` sources under `gesture/`.
- `com.pico.spatial.ui:platform:0.13.3`: `containers/SpatialNavigator.kt`, `containers/SpatialContainerScope.kt`, `resize/ContainerResizeType.kt`, `resize/WindowConstraintsModifier.kt`, `PhysicalLengthConverter.kt`, and `VolumeViewPointManager.kt`.
- `com.pico.spatial.core:core:0.13.3`: `ecs/InteractableComponent.kt`, `ecs/CollisionComponent.kt`, `ecs/Entity.kt`, and the primitive shape/material sources.
- `androidx.core:core-ktx:1.13.0`: `core-ktx-1.13.0-sources.jar!/androidx/core/os/Bundle.kt`, alongside the Android platform `android/os/Bundle.java` contract.

The independent source audit confirmed that every cited PICO jar entry exists and that the final DSL receivers, both `WindowContainer` and `windowConstraints` overload families, detector signatures, `dragAmount`, converter calls, five-argument collision constructor, Subwindow default offset behavior, and seven component call shapes match 0.13.3. The fixture contains no abbreviated `...` declarations.

## TDD and invariant evidence

- Initial RED: `npm run build && node test/spatialui-adoption.mjs` failed with `ERR_MODULE_NOT_FOUND` for `dist/subwindow.js` before either generator existed.
- Subsequent literal RED/GREEN cycles covered `SpatialAppScope` ownership, replacement-Main semantics, retained primary content, receiver-only `bundle`/`windowConstraints`, keyword/segment/numeric validation, C0/C1/U+2028/U+2029 Kotlin-string escaping (`U+000C` as `\u000c`), comment-control sanitization, pointer-input dependency keys, 3-axis physical drag conversion, exact provenance, recipe/Mixed honesty, expanded-header honesty, conditional imports, empty TabBar/SegmentControl rejection, WindowContainer-only variants, theme composition, lint cleanliness, and capability metadata.
- Protected hashes remained exact throughout: `src/spatialbench.ts` = `e096b8648154bc6f3bfdb701b82d78ece8442ca10464c7423d62a37cf642fb49`; `briefs/calib.json` = `b9b76f5fe63afa0fb8f30721f0f548ae5082b77a611f4e1410b4466abcda9179`. Tests also pin the exact `BENCH_CORE` and `BENCH_MR` arrays and prove the demo is absent.
- The scoped independent re-review approved all original Important findings and follow-up Kotlin control-character checks, with no remaining Critical or Important blocker.

## Verification

- Focused verification passed after review hardening: build, `test:spatialui-adoption`, lint, copilot, docs metadata, and smoke. Smoke listed exactly 238 tools.
- Final serialized battery passed `BATTERY 42/42 COMPLETE PASS=42 FAIL=0`: smoke followed by every one of the 41 current `test:` scripts, including clean tarball installation and both native virtual-camera suites. The installed tarball listed 238 tools and contained both new anchors; the doors surface exposed exactly 16 tools. Raw output was captured under `/tmp/pico-task2-final-battery.PWRfNJ` to avoid echoing local discovery data.
- `npm run sync:meta` reported `tools=238 doors=16`; the metadata check and gate-count parity check passed.

## Honest deferrals

- No emulator/device mutation, disposable-app build, native gesture drive, capture, or visual judgment was performed in Task 2. No appearance claim was recorded.
- Subwindow remains an SDK-owned fixed-width, match-container-height attached augment; it does not establish arbitrary world lock. Generated source and lint evidence do not establish Kotlin compilation, runtime behavior, pixel rendering, or interaction success.
- TabBar/SegmentItem actions, Sheet dismissal, and Snackbar presentation remain caller-owned placeholders. `SnackbarHost` alone does not invoke `SnackbarHostState.show`. Task 5 must compile the disposable recipe and LOOK at linked captures before raising any evidence class.
