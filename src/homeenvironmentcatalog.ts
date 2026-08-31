import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appSpecSchema } from "./appspec.js";
import { findBriefPath } from "./briefstore.js";
import { querySceneAnchorsOutputSchema } from "./sceneanchors.js";

const extentXyzSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const refreshExtentXyzSchema = z.tuple([
  z.number().positive().finite(),
  z.number().nonnegative().finite(),
  z.number().positive().finite(),
]);
const extentXzSchema = z.tuple([z.number().positive().finite(), z.number().positive().finite()]);
const rangeSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).refine(
  ([minimum, maximum]) => minimum <= maximum,
  "range minimum must not exceed maximum",
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const refreshSurfacesSchema = z.object({
  FLOOR: z.array(refreshExtentXyzSchema),
  TABLE: z.array(refreshExtentXyzSchema),
}).strict();
const extentClusterSchema = z.object({
  extentM: refreshExtentXyzSchema,
  presenceCountRange: rangeSchema.refine(
    ([, maximum]) => maximum > 0,
    "extent clusters must have been observed at least once",
  ),
}).strict();
const extentClustersSchema = z.object({
  FLOOR: z.array(extentClusterSchema).min(1),
  TABLE: z.array(extentClusterSchema).min(1),
}).strict();

const repositoryRelativePathSchema = z.string().min(1).refine((value) => {
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "path must be a normalized repository-relative path");

const refreshProvenanceSchema = z.object({
  provenanceVersion: z.literal(1),
  baseDatasetCommit: z.literal("7f74b2a0c2ca9aa40b192a93c68b01f04ec94af2"),
  evidence: z.array(z.object({
    tile: z.enum(["Livingroom Day", "Livingroom Night"]),
    role: z.enum(["selected_calibration_provenance", "stable_query"]),
    path: repositoryRelativePathSchema,
    sha256: sha256Schema,
  }).strict()).min(1),
}).strict();

export const fitRequirementSchema = z.object({
  label: z.enum(["TABLE", "FLOOR"]),
  minimumExtentM: extentXzSchema,
}).strict();
export type FitRequirement = z.infer<typeof fitRequirementSchema>;

const environmentSchema = z.object({
  tile: z.string().min(1),
  sceneId: z.string().min(1),
  measurementStatus: z.enum(["ready", "invalid_payload"]),
  automaticSelectionEligible: z.boolean(),
  exclusionReason: z.string().nullable(),
  acceptedInstantiations: z.number().int().nonnegative(),
  rawDiagnosticInstantiations: z.number().int().positive().optional(),
  totalAnchorCountRange: rangeSchema,
  histogramRanges: z.record(rangeSchema),
  surfaces: z.object({
    FLOOR: z.array(extentXyzSchema),
    TABLE: z.array(extentXyzSchema),
  }).strict(),
  guaranteedSurfaces: refreshSurfacesSchema.optional(),
  extentClusters: extentClustersSchema.optional(),
  selectedDialogSha256: sha256Schema,
  measuredClickPoint: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  queryEvidence: z.array(z.string().min(1)).min(1),
  rawDiagnostic: z.object({ sha256: sha256Schema, path: z.string().min(1) }).strict().optional(),
}).strict().superRefine((environment, ctx) => {
  if (environment.automaticSelectionEligible !== (environment.measurementStatus === "ready")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["automaticSelectionEligible"], message: "eligibility must match measurement status" });
  }
  if (environment.automaticSelectionEligible && environment.exclusionReason !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exclusionReason"], message: "eligible environments cannot have an exclusion reason" });
  }
  if (!environment.automaticSelectionEligible && !environment.exclusionReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exclusionReason"], message: "ineligible environments need an exclusion reason" });
  }
  const hasGuaranteedSurfaces = environment.guaranteedSurfaces !== undefined;
  const hasExtentClusters = environment.extentClusters !== undefined;
  if (hasGuaranteedSurfaces !== hasExtentClusters) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["guaranteedSurfaces"], message: "refresh surface fields must be present together" });
  }
  if ((hasGuaranteedSurfaces || hasExtentClusters) && !environment.automaticSelectionEligible) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["guaranteedSurfaces"], message: "ineligible environments cannot carry refresh surface fields" });
  }
  if (environment.guaranteedSurfaces && environment.extentClusters) {
    for (const label of ["FLOOR", "TABLE"] as const) {
      const surfaces = environment.surfaces[label];
      const clusters = environment.extentClusters[label];
      const sameExtent = (left: [number, number, number], right: [number, number, number]) =>
        left.every((value, component) => value === right[component]);
      if (
        surfaces.length !== clusters.length
        || surfaces.some((surface) => clusters.filter((cluster) => sameExtent(surface, cluster.extentM)).length !== 1)
        || clusters.some((cluster) => surfaces.filter((surface) => sameExtent(surface, cluster.extentM)).length !== 1)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["surfaces", label],
          message: "refreshed surfaces must exactly and uniquely match every extent cluster representative",
        });
      }
      const guaranteed = environment.guaranteedSurfaces[label];
      const requiredRepresentatives = clusters
        .filter((cluster) => cluster.presenceCountRange[0] > 0)
        .map((cluster) => cluster.extentM);
      if (
        guaranteed.length !== requiredRepresentatives.length
        || guaranteed.some((surface) => requiredRepresentatives.filter((candidate) => sameExtent(surface, candidate)).length !== 1)
        || requiredRepresentatives.some((representative) => guaranteed.filter((candidate) => sameExtent(representative, candidate)).length !== 1)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guaranteedSurfaces", label],
          message: "guaranteed surfaces must exactly and uniquely project clusters with positive minimum presence",
        });
      }
    }
  }
});
export type HomeEnvironment = z.infer<typeof environmentSchema>;

export const homeEnvironmentDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.literal("pico-emulator-6.0-home-environments-v1"),
  measurement: z.object({
    measuredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourcePath: z.string().min(1),
    capabilitySummarySha256: sha256Schema,
    selectionProvenanceSha256: sha256Schema,
    rangeBasis: z.string().min(1),
    refreshProcedure: z.object({
      procedureVersion: z.literal(1),
      requiredRuntime: z.object({ host: z.literal("macOS"), emulatorTitle: z.literal("PICO Emulator - 6.0.0"), serial: z.literal("emulator-5554") }).strict(),
      steps: z.tuple([
        z.literal("Cold boot emulator-5554 and record the runtime identity before measurement."),
        z.literal("Bind emulator-5554 to one QEMU window, validate the 552x440 Environment Preview dialog, and require all six accessible labels."),
        z.literal("For every tile, click its AX-layout-derived center only after the binding guards pass and capture the selected dialog hash."),
        z.literal("Use a current receipt-bound bridge app to obtain consecutive unfiltered non-empty reads before applying TABLE and FLOOR filters."),
        z.literal("Record complete histogram and total-anchor ranges plus every measured FLOOR and TABLE X/Y/Z extent; exclude invalid public payloads."),
      ]),
    }).strict(),
    refreshProvenance: refreshProvenanceSchema.optional(),
  }).strict(),
  runtime: z.object({
    host: z.literal("macOS"), emulatorTitle: z.literal("PICO Emulator - 6.0.0"), serial: z.literal("emulator-5554"),
    product: z.literal("swan"), model: z.literal("swan_arm64"), apiLevel: z.literal(36), fingerprint: z.string().min(1), bootId: z.string().min(1),
  }).strict(),
  classification: z.object({ extentToleranceM: z.literal(0.01), labels: z.tuple([z.literal("FLOOR"), z.literal("TABLE")]) }).strict(),
  picker: z.object({
    dialogTitle: z.literal("Environment Preview"),
    logicalDialogBounds: z.object({ x: z.number().int(), y: z.number().int(), width: z.literal(552), height: z.literal(440) }).strict(),
    contactSheet: z.literal("all-six-selected-contact-sheet.png"), contactSheetSha256: sha256Schema,
    selectionLog: z.literal("selection-scene-source.log"), selectionLogSha256: sha256Schema,
    accessibleLabels: z.tuple([z.literal("Bedroom Day"), z.literal("Bedroom Night"), z.literal("Livingroom Day"), z.literal("Livingroom Night"), z.literal("Mesume Day"), z.literal("Mesume Night")]),
    measuredTileCenterPoints: z.record(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
    measuredTileCenterPointsProvenance: z.object({
      derivation: z.literal("derived_from_committed_552x440_dialog_contact_sheet_and_ax_layout"),
      exactEmittedCgEventCoordinatesSeparatelyRecorded: z.literal(false),
      note: z.literal("CP1 recorded that target centers were derived from the AX layout; it did not separately record the exact emitted CGEvent coordinates."),
    }).strict(),
  }).strict(),
  environments: z.array(environmentSchema).length(6),
}).strict().superRefine((dataset, ctx) => {
  const tiles = dataset.environments.map((environment) => environment.tile);
  if (new Set(tiles).size !== tiles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["environments"], message: "environment tiles must be unique" });
  if (JSON.stringify(tiles) !== JSON.stringify(dataset.picker.accessibleLabels)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["environments"], message: "environment order must match picker labels" });
  }
  const refreshedTiles = new Set(dataset.environments
    .filter((environment) => environment.guaranteedSurfaces !== undefined || environment.extentClusters !== undefined)
    .map((environment) => environment.tile));
  const provenance = dataset.measurement.refreshProvenance;
  if (!provenance && refreshedTiles.size > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurement", "refreshProvenance"], message: "refresh surface fields require refresh provenance" });
  }
  if (provenance) {
    const evidencePaths = provenance.evidence.map((evidence) => evidence.path);
    if (new Set(evidencePaths).size !== evidencePaths.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurement", "refreshProvenance", "evidence"], message: "refresh evidence paths must be unique" });
    }
    const stableQueryTiles = new Set(provenance.evidence
      .filter((evidence) => evidence.role === "stable_query")
      .map((evidence) => evidence.tile));
    for (const tile of stableQueryTiles) {
      const environment = dataset.environments.find((entry) => entry.tile === tile);
      if (!environment?.guaranteedSurfaces || !environment.extentClusters) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["environments"], message: `stable query tile '${tile}' must carry both refresh surface fields` });
      }
    }
    for (const tile of refreshedTiles) {
      if (!stableQueryTiles.has(tile as "Livingroom Day" | "Livingroom Night")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurement", "refreshProvenance", "evidence"], message: `refreshed tile '${tile}' needs stable query provenance` });
      }
    }
  }
});
export type HomeEnvironmentDataset = z.infer<typeof homeEnvironmentDatasetSchema>;

const explicitSourceSchema = z.object({ requirements: z.array(fitRequirementSchema).min(1) }).strict().superRefine((source, ctx) => {
  if (new Set(source.requirements.map((requirement) => requirement.label)).size !== source.requirements.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements"], message: "requirements must not duplicate labels" });
  }
});
const briefSourceSchema = z.object({ briefId: z.string() }).strict();
export const fitRequestInputSchema = z.union([explicitSourceSchema, briefSourceSchema]);
export type FitRequestInput = z.infer<typeof fitRequestInputSchema>;

const explicitFitRequestSchema = z.object({ kind: z.literal("explicit"), requirements: z.array(fitRequirementSchema).min(1) }).strict();
const missionFitRequestSchema = z.object({
  kind: z.literal("swanMissionTable"),
  preferred: z.object({ requirement: fitRequirementSchema, targetFootprintM: extentXzSchema, maxTableFillFraction: z.number().positive().max(1), maximumExtentM: extentXzSchema }).strict(),
  fallback: z.object({ requirement: fitRequirementSchema, maximumExtentM: extentXzSchema }).strict(),
  advisories: z.array(z.object({ label: z.literal("WALL_ART"), minimumExtentM: extentXzSchema, maximumExtentM: extentXzSchema }).strict()).length(1),
}).strict();
export const fitRequestSchema = z.union([explicitFitRequestSchema, missionFitRequestSchema]);
export type FitRequest = z.infer<typeof fitRequestSchema>;

const fitEvidenceSchema = z.object({ requirement: fitRequirementSchema, surfaceExtentM: extentXzSchema, fitRatio: z.number().nonnegative() }).strict();
export type FitEvidence = z.infer<typeof fitEvidenceSchema>;
const candidateSchema = z.object({
  tile: z.string(), fits: z.array(fitEvidenceSchema).min(1), minimumFitRatio: z.number().nonnegative(), sumFitRatios: z.number().nonnegative(), contentScale: z.number().positive().max(1).nullable(), tier: z.enum(["explicit", "preferred", "fallback"]),
}).strict();
export type HomeEnvironmentCandidate = z.infer<typeof candidateSchema>;
export const homeEnvironmentRankResultSchema = z.object({
  status: z.enum(["ranked", "no_fit"]), datasetId: z.literal("pico-emulator-6.0-home-environments-v1"), candidates: z.array(candidateSchema), selectedTarget: z.string().nullable(),
}).strict();
export type HomeEnvironmentRankResult = z.infer<typeof homeEnvironmentRankResultSchema>;

type QuerySceneAnchorsOutput = z.infer<typeof querySceneAnchorsOutputSchema>;
export type HomeEnvironmentClassificationStatus = "unique" | "no_match" | "ambiguous" | "terminal_status" | "incomplete_requested_labels" | "extent_mismatch";
export type HomeEnvironmentClassificationPredicates = {
  bridgeStatus: QuerySceneAnchorsOutput["status"];
  missingRequestedLabels: string[];
  /** Compatibility name: true means the live surfaces satisfy the dataset's allowed cluster observation ranges. */
  surfaceExtentMultisetsMatch: boolean | null;
  requirementsFit: boolean | null;
};
export type HomeEnvironmentClassificationResult = {
  status: HomeEnvironmentClassificationStatus;
  environment: HomeEnvironment | null;
  histogramMatches: string[];
  predicates: HomeEnvironmentClassificationPredicates;
};

const DATASET_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "home-environments", "pico-emulator-6.0.v1.json");
const BRIEF_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function loadPackagedHomeEnvironmentDataset(): HomeEnvironmentDataset {
  return homeEnvironmentDatasetSchema.parse(JSON.parse(fs.readFileSync(DATASET_PATH, "utf8")));
}

export function deriveFitRequest(input: FitRequestInput): FitRequest {
  const source = fitRequestInputSchema.parse(input);
  if ("requirements" in source) return explicitFitRequestSchema.parse({ kind: "explicit", requirements: source.requirements });
  if (!BRIEF_ID.test(source.briefId)) throw new Error("briefId must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
  const briefPath = findBriefPath(source.briefId);
  if (!briefPath) throw new Error(`brief '${source.briefId}' not found`);
  const brief = JSON.parse(fs.readFileSync(briefPath, "utf8")) as { spec?: unknown };
  const spec = appSpecSchema.parse(brief.spec);
  if (!spec.roomExperience || spec.roomExperience.kind !== "swanMissionTable") {
    throw new Error(`brief '${source.briefId}' must declare roomExperience.kind 'swanMissionTable'`);
  }
  const room = spec.roomExperience;
  return missionFitRequestSchema.parse({
    kind: "swanMissionTable",
    preferred: { requirement: { label: room.tableLabel, minimumExtentM: room.tableExtentRangeM.min }, targetFootprintM: room.targetFootprintM, maxTableFillFraction: room.maxTableFillFraction, maximumExtentM: room.tableExtentRangeM.max },
    fallback: { requirement: { label: room.fallbackLabel, minimumExtentM: room.floorExtentRangeM.min }, maximumExtentM: room.floorExtentRangeM.max },
    advisories: [{ label: room.panelLabel, minimumExtentM: room.wallArtExtentRangeM.min, maximumExtentM: room.wallArtExtentRangeM.max }],
  });
}

function bestFit(environment: HomeEnvironment, requirement: FitRequirement, maximumExtentM?: [number, number]): FitEvidence | null {
  let best: FitEvidence | null = null;
  const measuredPotential = environment.extentClusters
    ? environment.extentClusters[requirement.label].map((cluster) => cluster.extentM)
    : environment.surfaces[requirement.label];
  for (const extent of measuredPotential) {
    const surfaceExtentM: [number, number] = [extent[0], extent[2]];
    if (maximumExtentM && (surfaceExtentM[0] > maximumExtentM[0] || surfaceExtentM[1] > maximumExtentM[1])) continue;
    const fitRatio = Math.min(surfaceExtentM[0] / requirement.minimumExtentM[0], surfaceExtentM[1] / requirement.minimumExtentM[1]);
    if (!best || fitRatio > best.fitRatio) best = { requirement, surfaceExtentM, fitRatio };
  }
  return best;
}

function sortCandidates(candidates: HomeEnvironmentCandidate[]): HomeEnvironmentCandidate[] {
  return candidates.sort((left, right) => right.minimumFitRatio - left.minimumFitRatio || right.sumFitRatios - left.sumFitRatios);
}

function result(dataset: HomeEnvironmentDataset, candidates: HomeEnvironmentCandidate[]): HomeEnvironmentRankResult {
  return homeEnvironmentRankResultSchema.parse({ status: candidates.length ? "ranked" : "no_fit", datasetId: dataset.datasetId, candidates, selectedTarget: candidates[0]?.tile ?? null });
}

export function rankHomeEnvironments(datasetInput: HomeEnvironmentDataset, requestInput: FitRequest): HomeEnvironmentRankResult {
  const dataset = homeEnvironmentDatasetSchema.parse(datasetInput);
  const request = fitRequestSchema.parse(requestInput);
  const eligible = dataset.environments.filter((environment) => environment.automaticSelectionEligible);
  if (request.kind === "explicit") {
    const candidates = eligible.flatMap((environment) => {
      const fits = request.requirements.map((requirement) => bestFit(environment, requirement));
      if (fits.some((fit) => !fit || fit.fitRatio < 1)) return [];
      const present = fits as FitEvidence[];
      return [{ tile: environment.tile, fits: present, minimumFitRatio: Math.min(...present.map((fit) => fit.fitRatio)), sumFitRatios: present.reduce((sum, fit) => sum + fit.fitRatio, 0), contentScale: null, tier: "explicit" as const }];
    });
    return result(dataset, sortCandidates(candidates));
  }
  const preferred = eligible.flatMap((environment) => {
    const fit = bestFit(environment, request.preferred.requirement, request.preferred.maximumExtentM);
    if (!fit || fit.fitRatio < 1) return [];
    const [width, depth] = fit.surfaceExtentM;
    const [targetWidth, targetDepth] = request.preferred.targetFootprintM;
    const contentScale = Math.min(1, width * request.preferred.maxTableFillFraction / targetWidth, depth * request.preferred.maxTableFillFraction / targetDepth);
    return [{ tile: environment.tile, fits: [fit], minimumFitRatio: fit.fitRatio, sumFitRatios: fit.fitRatio, contentScale, tier: "preferred" as const }];
  }).sort((left, right) => right.contentScale - left.contentScale);
  if (preferred.length) return result(dataset, preferred);
  const fallback = eligible.flatMap((environment) => {
    const fit = bestFit(environment, request.fallback.requirement, request.fallback.maximumExtentM);
    if (!fit || fit.fitRatio < 1) return [];
    return [{ tile: environment.tile, fits: [fit], minimumFitRatio: fit.fitRatio, sumFitRatios: fit.fitRatio, contentScale: null, tier: "fallback" as const }];
  });
  return result(dataset, sortCandidates(fallback));
}

const ADVISORY_IDENTITY_LABEL = "WALL_ART";

function rangeContains([minimum, maximum]: [number, number], value: number): boolean {
  return minimum <= value && value <= maximum;
}

function completeHistogramFits(ranges: Record<string, [number, number]>, observed: Record<string, number>): boolean {
  const labels = new Set([...Object.keys(ranges), ...Object.keys(observed)]);
  return [...labels].every((label) => label === ADVISORY_IDENTITY_LABEL || rangeContains(ranges[label] ?? [0, 0], observed[label] ?? 0));
}

function observedExtents(query: QuerySceneAnchorsOutput, label: "FLOOR" | "TABLE"): [number, number, number][] {
  return query.anchors.flatMap((anchor) => anchor.labels.includes(label) ? [[...anchor.boundsM] as [number, number, number]] : []);
}

type ExtentCluster = { extentM: [number, number, number]; presenceCountRange: [number, number] };

function withinExtentTolerance(measured: number, observed: number, tolerance: number): boolean {
  return observed >= measured - tolerance && observed <= measured + tolerance;
}

function allowedExtentClusters(environment: HomeEnvironment, label: "FLOOR" | "TABLE"): ExtentCluster[] {
  if (environment.extentClusters) return environment.extentClusters[label];
  return environment.surfaces[label].map((extent) => ({ extentM: extent, presenceCountRange: [1, 1] }));
}

function extentClusterRangesMatch(clusters: ExtentCluster[], observed: [number, number, number][], tolerance: number): boolean {
  const counts = clusters.map(() => 0);
  for (const extent of observed) {
    const matchingClusters = clusters.flatMap((cluster, index) =>
      cluster.extentM.every((measured, component) => withinExtentTolerance(measured, extent[component], tolerance))
        ? [index]
        : [],
    );
    if (matchingClusters.length !== 1) return false;
    counts[matchingClusters[0]] += 1;
  }
  return counts.every((count, index) => rangeContains(clusters[index].presenceCountRange, count));
}

function hasFit(extents: [number, number, number][], requirement: FitRequirement, maximumExtentM?: [number, number]): boolean {
  return extents.some(([x, , z]) => x >= requirement.minimumExtentM[0] && z >= requirement.minimumExtentM[1]
    && (!maximumExtentM || (x <= maximumExtentM[0] && z <= maximumExtentM[1])));
}

function requirementsFit(dataset: HomeEnvironmentDataset, query: QuerySceneAnchorsOutput, request: FitRequest): boolean {
  if (request.kind === "explicit") {
    return request.requirements.every((requirement) => hasFit(observedExtents(query, requirement.label), requirement));
  }
  const rankedTier = rankHomeEnvironments(dataset, request).candidates[0]?.tier;
  if (rankedTier === "preferred") {
    return hasFit(observedExtents(query, request.preferred.requirement.label), request.preferred.requirement, request.preferred.maximumExtentM);
  }
  if (rankedTier === "fallback") {
    return hasFit(observedExtents(query, request.fallback.requirement.label), request.fallback.requirement, request.fallback.maximumExtentM);
  }
  return false;
}

function predicates(bridgeStatus: QuerySceneAnchorsOutput["status"], missingRequestedLabels: string[] = [], surfaceExtentMultisetsMatch: boolean | null = null, requirementsFitResult: boolean | null = null): HomeEnvironmentClassificationPredicates {
  return { bridgeStatus, missingRequestedLabels, surfaceExtentMultisetsMatch, requirementsFit: requirementsFitResult };
}

export function classifyObservedHomeEnvironment(dataset: HomeEnvironmentDataset, queryInput: QuerySceneAnchorsOutput, requirementsInput: FitRequest): HomeEnvironmentClassificationResult {
  const query = querySceneAnchorsOutputSchema.parse(queryInput);
  const requirements = fitRequestSchema.parse(requirementsInput);
  if (query.status !== "ready") {
    return { status: "terminal_status", environment: null, histogramMatches: [], predicates: predicates(query.status) };
  }

  const eligible = dataset.environments.filter((environment) => environment.automaticSelectionEligible);
  const histogramMatches = eligible.filter((environment) =>
    rangeContains(environment.totalAnchorCountRange, query.totalAnchorCount)
    && completeHistogramFits(environment.histogramRanges, query.histogram),
  );
  const basePredicates = predicates(query.status);
  if (histogramMatches.length !== 1) {
    return {
      status: histogramMatches.length === 0 ? "no_match" : "ambiguous",
      environment: null,
      histogramMatches: histogramMatches.map((environment) => environment.tile),
      predicates: basePredicates,
    };
  }

  const missingRequestedLabels = dataset.classification.labels.filter((label) => !query.requestedLabels.includes(label));
  if (missingRequestedLabels.length) {
    return {
      status: "incomplete_requested_labels",
      environment: null,
      histogramMatches: histogramMatches.map((environment) => environment.tile),
      predicates: predicates(query.status, missingRequestedLabels),
    };
  }

  const environment = histogramMatches[0];
  const surfaceExtentMultisetsMatch = dataset.classification.labels.every((label) =>
    extentClusterRangesMatch(allowedExtentClusters(environment, label), observedExtents(query, label), dataset.classification.extentToleranceM),
  );
  if (!surfaceExtentMultisetsMatch) {
    return {
      status: "extent_mismatch",
      environment: null,
      histogramMatches: [environment.tile],
      predicates: predicates(query.status, [], false, null),
    };
  }
  const liveRequirementsFit = requirementsFit(dataset, query, requirements);
  if (!liveRequirementsFit) {
    return {
      status: "extent_mismatch",
      environment: null,
      histogramMatches: [environment.tile],
      predicates: predicates(query.status, [], true, false),
    };
  }
  return {
    status: "unique",
    environment,
    histogramMatches: [environment.tile],
    predicates: predicates(query.status, [], true, true),
  };
}
