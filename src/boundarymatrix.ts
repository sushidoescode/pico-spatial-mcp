import { appSpecSchema, type AppSpec } from "./appspec.js";
import { canonicalIdentity, type CanonicalIdentity } from "./runreceiptidentity.js";

export const BOUNDARY_MATRIX_IDS = [
  "boundarylabmixed",
  "boundarylabmanifestfull",
  "boundarylabdynamicfull",
] as const;

export const BOUNDARY_MATRIX_DIFFERENCE_ALLOWLIST = [
  "/id",
  "/spec/boundaryLab/variant",
  "/spec/meta/appName",
  "/spec/meta/packageName",
  "/spec/meta/secondaryContainers",
  "/spec/meta/stageStyle",
] as const;

export type BoundaryLabVariant = "manifest_mixed" | "manifest_full" | "dynamic_full";
export type BoundaryMatrixId = (typeof BOUNDARY_MATRIX_IDS)[number];

export interface BoundaryBriefEntry {
  id: BoundaryMatrixId;
  brief: string;
  spec: AppSpec;
  expected: BoundaryExpectedShape;
}

export interface BoundaryExpectedShape {
  scenes: 1;
  layouts: 0;
  objects: 0;
  data: 0;
  interactions: 0;
  panels: 0;
  verifiableNowMin: 1;
  swanMin: 0;
}

export interface BoundaryMatrixRow {
  id: BoundaryMatrixId;
  packageName: string;
  variant: BoundaryLabVariant;
  spec: AppSpec;
  entry: BoundaryBriefEntry;
  effectiveSpecIdentity: CanonicalIdentity;
  scenePayloadIdentity: CanonicalIdentity;
}

interface CanonicalBoundaryBrief {
  id: string;
  brief: string;
  spec: unknown;
  expected: unknown;
}

const EXPECTED_SHAPE: BoundaryExpectedShape = {
  scenes: 1,
  layouts: 0,
  objects: 0,
  data: 0,
  interactions: 0,
  panels: 0,
  verifiableNowMin: 1,
  swanMin: 0,
};

const rows: ReadonlyArray<{
  id: BoundaryMatrixId;
  variant: BoundaryLabVariant;
  stageStyle: "1" | "3";
  secondaryContainers: AppSpec["meta"]["secondaryContainers"];
}> = [
  { id: "boundarylabmixed", variant: "manifest_mixed", stageStyle: "1", secondaryContainers: [] },
  { id: "boundarylabmanifestfull", variant: "manifest_full", stageStyle: "3", secondaryContainers: [] },
  {
    id: "boundarylabdynamicfull",
    variant: "dynamic_full",
    stageStyle: "1",
    secondaryContainers: [{ kind: "stage", id: "dynamic-full", style: "Full" }],
  },
];

function fleetAppName(id: string): string {
  return `Fleet${id[0].toUpperCase()}${id.slice(1)}`;
}

function scenePayload(spec: AppSpec): unknown {
  if (!spec.boundaryLab) throw new Error("Boundary Lab scene payload requires its generation profile");
  const { variant: _variant, ...sharedBoundaryLab } = spec.boundaryLab;
  return {
    scenes: spec.scenes,
    layouts: spec.layouts,
    objects: spec.objects,
    data: spec.data,
    interactions: spec.interactions,
    panels: spec.panels,
    navigation: spec.navigation,
    verificationPlan: spec.verificationPlan,
    headsetLayer: spec.headsetLayer,
    boundaryLab: sharedBoundaryLab,
  };
}

function differencePaths(left: unknown, right: unknown, prefix = ""): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return [prefix || "/"];
    return left.flatMap((value, index) => differencePaths(value, right[index], `${prefix}/${index}`));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    return keys.flatMap((key) => Object.hasOwn(leftRecord, key) && Object.hasOwn(rightRecord, key)
      ? differencePaths(leftRecord[key], rightRecord[key], `${prefix}/${key}`)
      : [`${prefix}/${key}`]);
  }
  return [prefix || "/"];
}

function parseCanonical(value: unknown): { brief: string; spec: AppSpec; expected: BoundaryExpectedShape } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("canonical Boundary Lab brief must be an object");
  }
  const candidate = value as Partial<CanonicalBoundaryBrief>;
  if (candidate.id !== "boundarylabmixed" || typeof candidate.brief !== "string" || !candidate.brief.trim()) {
    throw new Error("canonical Boundary Lab brief must use non-empty id boundarylabmixed");
  }
  const spec = appSpecSchema.parse(candidate.spec);
  if (!spec.boundaryLab || spec.boundaryLab.variant !== "manifest_mixed") {
    throw new Error("canonical Boundary Lab AppSpec must be the manifest_mixed row");
  }
  if (spec.meta.brief !== candidate.brief) {
    throw new Error("canonical Boundary Lab entry brief and spec.meta.brief must be identical");
  }
  if (canonicalIdentity(candidate.expected).sha256 !== canonicalIdentity(EXPECTED_SHAPE).sha256) {
    throw new Error("canonical Boundary Lab expected shape must declare one scene, no generic nodes, and one C0 verification");
  }
  return { brief: candidate.brief, spec, expected: structuredClone(EXPECTED_SHAPE) };
}

/** Pure matched-matrix expansion. The caller owns persistence; this function never touches a store. */
export function buildBoundaryMatrix(canonicalBrief: unknown): BoundaryMatrixRow[] {
  const canonical = parseCanonical(canonicalBrief);
  const sourcePayloadIdentity = canonicalIdentity(scenePayload(canonical.spec));
  const matrix = rows.map((definition) => {
    const draft = structuredClone(canonical.spec);
    draft.meta.appName = fleetAppName(definition.id);
    draft.meta.packageName = `com.fleet.${definition.id}`;
    draft.meta.stageStyle = definition.stageStyle;
    draft.meta.secondaryContainers = structuredClone(definition.secondaryContainers);
    if (!draft.boundaryLab) throw new Error("canonical Boundary Lab profile disappeared during cloning");
    draft.boundaryLab.variant = definition.variant;
    const spec = appSpecSchema.parse(draft);
    const effectiveSpecIdentity = canonicalIdentity(spec);
    const scenePayloadIdentity = canonicalIdentity(scenePayload(spec));
    if (scenePayloadIdentity.sha256 !== sourcePayloadIdentity.sha256 || scenePayloadIdentity.bytes !== sourcePayloadIdentity.bytes) {
      throw new Error(`Boundary Lab row ${definition.id} changed the shared scene payload`);
    }
    const entry: BoundaryBriefEntry = {
      id: definition.id,
      brief: canonical.brief,
      spec,
      expected: structuredClone(canonical.expected),
    };
    return {
      id: definition.id,
      packageName: spec.meta.packageName,
      variant: definition.variant,
      spec,
      entry,
      effectiveSpecIdentity,
      scenePayloadIdentity,
    };
  });
  const canonicalEntry = matrix[0].entry;
  const allowed = new Set<string>(BOUNDARY_MATRIX_DIFFERENCE_ALLOWLIST);
  for (const candidate of matrix.slice(1)) {
    const unexpected = differencePaths(canonicalEntry, candidate.entry).filter((path) => !allowed.has(path));
    if (unexpected.length > 0) {
      throw new Error(`Boundary Lab row ${candidate.id} changed non-allowlisted path(s): ${unexpected.join(", ")}`);
    }
  }
  return matrix;
}
