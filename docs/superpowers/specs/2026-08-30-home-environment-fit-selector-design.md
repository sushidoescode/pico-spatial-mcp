# Home Environment Fit Selector Design

**Status:** Approved 2026-08-30, with no release/version bump.

## Goal

Add one full-surface MCP tool, `select_home_environment`, that ranks PICO Emulator 6.0 home
environments by whether an MR application's required support surfaces fit, optionally drives the
macOS Environment Preview picker, and reports a successful switch only after receipt-bound live
mesh classification uniquely identifies the requested environment.

The doors surface remains exactly 18 tools. The package and manifest version remains `37.0.0`.

## Evidence basis

The CP1 evidence is committed at `467be88516f79d9aced0b81c288c72bef0c2dd5f` under
`docs/evidence/home-environments/2026-08-29-pico-emulator-6.0/`.

PICO Emulator 6.0.0 exposes six Environment Preview tiles: Bedroom Day/Night, Livingroom
Day/Night, and Mesume Day/Night. All six report the guest scene context `XiataAncientPath`.
Therefore scene ID is a coarse Default Space consistency signal only and is never an environment
identity signal. The gRPC XrOptions route is prohibited for this feature.

Mesume Day is ineligible for ranking and automatic selection because its stable raw bridge payload
contains one zero-geometry anchor and the public `query_scene_anchors` parser returns
`invalid_payload`. WALL_ART counts are retained as advisory evidence, but WALL_ART extents are not
scored until a future recon measures them.

## Public tool contract

The tool accepts exactly one requirement source:

```ts
type FitRequirement = {
  label: "TABLE" | "FLOOR";
  minimumExtentM: [widthM: number, depthM: number];
};

type RequirementSource =
  | { requirements: FitRequirement[]; briefId?: never }
  | { briefId: string; requirements?: never };
```

Dimensions are ordered SDK-local X/Z dimensions. The selector does not silently rotate a footprint,
matching the current mission-table runtime implementation.

The operation is explicit:

```ts
type SelectorAction = "rank" | "switch" | "verify";

type RuntimeInput = {
  serial: string;
  packageName: string;
  expectedBuildReceiptId: string;
  expectedStageStyle: "Mixed" | "Full";
};

type VerificationBaseline = {
  datasetId: string;
  datasetContentSha256: string;
  serial: string;
  packageName: string;
  expectedBuildReceiptId: string;
  bootId: string;
  snapshotId: string;
};
```

`rank` is static and needs no runtime input. `switch` requires `runtime`; it records a receipt-bound
pre-switch baseline before any host click. If guarded host automation is unavailable, it returns
that baseline with `manual_switch_required`, and a human can click the proposed tile. `verify`
requires the same runtime identity plus the returned baseline. Both the public dataset receipt and
baseline carry `datasetContentSha256`, the strict canonical SHA-256 of the complete parsed dataset.
A missing digest or a baseline from different contents is `invalid_request` before live work, even
when the v1 dataset ID and legacy provenance fields are unchanged.

Public statuses are:

- `ranked`: static ranking completed.
- `no_fit`: no eligible environment satisfies the requested support-surface requirements.
- `invalid_request`: the requirement source, brief, runtime, or baseline is unusable.
- `manual_switch_required`: a target was proposed but no host click was attempted because an
  automation guard failed or the host is unsupported.
- `selected_verified`: the guarded host selection and the complete live verification chain passed.
- `verification_failed`: a host action was attempted or a post-switch verification was requested,
  but identity could not be uniquely confirmed.

Every result includes the dataset identity/provenance, normalized requirements, ranked candidates
with fit evidence, selected target or null, action/verification receipts, and
`evidenceCeiling: "structural"`. The tool makes no visual claim.

## Packaged capability dataset

The runtime dataset is `assets/home-environments/pico-emulator-6.0.v1.json`. `assets` is already in
the `package.json` `files` allowlist, so no new top-level package entry is needed. The directory must
contain exactly the versioned JSON file—no caches, temporary captures, or generated interpreter
artifacts.

The file carries:

- schema and dataset IDs;
- emulator version/title, measurement date, guest identity, and CP1 source commit/path/hashes;
- picker dialog geometry, accessible label inventory, measured tile click points, and selected-dialog
  SHA-256 for each tile;
- complete observed histogram ranges and total-anchor ranges;
- measured FLOOR/TABLE X/Y/Z extents, with every refreshed `surfaces` tuple exactly and uniquely
  paired to one extent-cluster representative; every cluster must have a positive observed maximum,
  and `guaranteedSurfaces` is the exact duplicate-free projection of clusters whose minimum is
  positive;
- eligibility and exclusion reason for every environment;
- extent tolerance and the exact refresh procedure.

`scripts/verify-tarball.mjs` must parse the installed dataset, validate its dataset ID, confirm that
Mesume Day remains explicitly excluded, and assert the dataset directory contains only the expected
JSON. `npm run test:tarball` is the shipping proof.

## Requirement derivation and ranking

Explicit requirements are simultaneous hard requirements. For each label, a refreshed candidate
uses its best measured extent-cluster representative; an extension-absent legacy v1 candidate uses
its best `surfaces` extent. It computes:

```text
fitRatio = min(surfaceWidth / requiredWidth, surfaceDepth / requiredDepth)
```

A label fits when `fitRatio >= 1`; a candidate fits when every explicit label fits. Candidate score
is the minimum label fit ratio, followed by the sum of fit ratios, followed by stable dataset order.
Mesume Day never enters the candidate set.

For `briefId`, the selector resolves the existing user/corpus brief stores through `findBriefPath`,
accepts only a safe brief ID, parses `.spec` through `appSpecSchema`, and requires
`roomExperience.kind === "swanMissionTable"`.

The derived preference tiers mirror `MissionTablePlacement`:

1. TABLE surfaces inside `tableExtentRangeM` are preferred. Their score is the runtime scale:
   `min(1, width * maxTableFillFraction / targetWidth, depth * maxTableFillFraction / targetDepth)`.
2. FLOOR surfaces inside `floorExtentRangeM` are fallback candidates only when no TABLE candidate
   fits.
3. WALL_ART is reported as advisory and does not eliminate or identify an environment.

Static ranking is a proposal from the catalog's complete measured-potential extent-cluster
representatives, not a guarantee about the next instantiation. Legacy `surfaces` are used only when
an entry has no refresh. The 0.782631×0.464378 m table measured for both Livingroom Day and
Livingroom Night yields the same mission-table scale of approximately 0.774 for the 0.68×0.42 m
target at 0.7 fill. Both therefore rank in the preferred tier, with stable dataset order putting Day
first. Both also expose the measured-potential 6.867676×4.439027 m FLOOR representative. The
refreshed Day observations falsify any guaranteed FLOOR or TABLE presence, so a switch or verify
result must independently establish the globally ranked preferred TABLE tier in its current
receipt-bound mesh.

## Guarded macOS selection

Host automation is an injectable, separately tested component. Production performs this sequence:

1. Reject non-macOS with `manual_switch_required` before any GUI action.
2. Bind the exact requested adb serial through discovery qemu PID to exactly one main qemu window,
   reusing `selectQemuWindowBinding`. Never choose the largest window and never address another adb
   serial.
3. Focus only the bound qemu PID.
4. Use macOS Accessibility to find and press the `select_scene_button` control. If the control is
   absent or Accessibility fails, return manual switching instructions; do not fall back to an
   unguarded toolbar coordinate.
5. Correlate exactly one CoreGraphics/Accessibility dialog owned by the same PID, with heading
   `Environment Preview`, logical bounds 552×440, and all six exact accessible labels in their
   measured positions.
6. Focus the bound process and issue one left-button CGEvent at the target's dataset-relative dialog
   point. This coordinate lane is allowed only after every preceding identity/geometry guard passes.
7. Capture the bound dialog window and require its SHA-256 to equal the target's measured selected
   dialog hash. A click acknowledgment or purple-border assumption alone is never success.
8. Close only the identified dialog through its Accessibility close control and verify that the same
   PID/window disappears.

Host selection is merely an action receipt. It never identifies the active environment.

## Live switch verification and fail-closed identity

`switch` and `verify` use a current receipt-bound bridge app. They query labels TABLE, FLOOR, and
WALL_ART through the existing `executeQuerySceneAnchors` checks: exact serial, receipt/APK/PID,
stage/root, unfiltered stability reads, and lossless external geometry publication.

The live chain is:

1. observe a current Default Space `WorldSpaceDB getSpace` context;
2. obtain the pre-switch receipt-bound mesh snapshot and baseline identity;
3. mark the exact emulator log and perform (or wait for) the host selection;
4. obtain the first later current Default Space WorldSpaceDB observation;
5. obtain a fresh receipt-bound mesh snapshot;
6. require the same serial, package, receipt, boot ID, and coarse scene context;
7. require a changed pre/post snapshot ID;
8. classify the post-switch complete histogram against every eligible measured histogram range;
9. require exactly one histogram match and complete requested-label coverage;
10. require every live FLOOR/TABLE anchor to map to exactly one target cluster by X/Y/Z and require
    every cluster count to fall inside its allowed presence range within dataset tolerance;
11. only then evaluate fit: explicit requirements remain simultaneous, while a mission request must
    satisfy the tier selected by global static ranking (preferred TABLE when that tier exists, or
    fallback FLOOR only when the static tier is fallback);
12. require the uniquely classified environment to be the proposed target.

Classification treats every histogram range as the observed range, including singleton ranges. A
new instantiation outside all measured ranges fails closed until the recon dataset is refreshed.
Missing labels are counts of zero; an unmeasured extra label also prevents a range match.

Most importantly, if two environments' measured histogram ranges both accept the observed
histogram, verification stops as ambiguous. Surface extents, scene ID, selected-dialog hash, and
dataset order cannot break an identity tie. Zero matches, multiple matches, the wrong unique match,
an unchanged snapshot, any terminal bridge status, or any runtime identity drift yields
`verification_failed`.

The public predicate remains named `surfaceExtentMultisetsMatch` for compatibility. It reports the
dataset's allowed surface observation: `true` only after the unique candidate's cluster ranges pass,
`false` for a post-unique cluster mismatch, and `null` before extent evaluation.
`requirementsFit` remains `null` until those cluster checks pass, then reports the live explicit or
globally ranked mission-tier result. Neither predicate is evaluated to resolve histogram ambiguity.

## Registration, counts, and metadata

`registerHomeEnvironmentSelectorTools(server)` is called only inside
`if (!doorsSurfaceActive())`. Expected post-change surfaces are:

- macOS full: 252, measured through installed-tarball `tools/list`;
- Linux full: 249, runtime relationship derived from the existing three-tool macOS host delta;
- Windows full: published/source-derived 249 until a native measurement exists;
- doors/default: 18.

The count chain updates exact literals, appends historical macOS count 251 to
`PUBLISHED_COUNTS`, runs `npm run sync:meta`, and reviews every stamped hunk. `package.json` and all
manifest versions remain exactly `37.0.0`; this feature wave is not a release.

No new npm script is added. The new tests join the existing `test:bridge` script.

## CP3 acceptance

After CP2 passes, use the tool against `emulator-5554` only and uniquely verify Livingroom Day.
Then launch `com.fleet.swanmissiontable` fresh through a new receipt, monitor 60 seconds for absence
of ANR/error dialogs, and capture a settled frame that visibly places the diorama on the table at a
believable scale. The panel must show the TABLE anchor route and must not show
`label_absent`→FLOOR. The looked-at capture path, SHA-256, verbatim eye verdict, panel text, live
classification, and monitor log are committed as CP3 evidence.

No snapshot save/load, gate save, calibration, or physical-device action is permitted.

## Honest remaining boundaries

- Host automation is proved only for this macOS/PICO Emulator 6.0 geometry and Accessibility lane.
- Mesume Day stays unselectable until the public lossless query accepts every anchor.
- WALL_ART extent fit stays unscored.
- Singleton observed ranges may reject valid future re-instantiations; that is an intentional
  fail-closed outcome, not permission to infer from the clicked tile.
- Mesh semantics and extents remain structural evidence; rendered placement requires LOOK.
