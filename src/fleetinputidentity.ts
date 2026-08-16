import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appSpecSchema } from "./appspec.js";
import { canonicalJson, collectGradleInputIdentity } from "./runreceiptidentity.js";
import type {
  BriefGenerationV1,
  ProjectInputGenerationV1,
  ProjectLocatorV1,
  RunTargetV1,
  TargetGenerationV1,
} from "./runrevisiontypes.js";

const LOCATOR_MAX_COMPONENTS = 64;
const LOCATOR_MAX_PATH_BYTES = 16 * 1024;
const COMPATIBILITY_BRIEF_MAX_BYTES = 3 * 1024 * 1024;
const ORIGINAL_BRIEF_MAX_BYTES = 256 * 1024;
const GENERATION_REASON_MAX_BYTES = 64 * 1024;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]*)$/;
const READ_BUFFER_BYTES = 64 * 1024;

export type ProjectLocatorFailureStatusV1 =
  | "invalid-store"
  | "limit-exceeded"
  | "external-state-conflict"
  | "target-conflict";

export class ProjectLocatorError extends Error {
  readonly status: ProjectLocatorFailureStatusV1;

  constructor(status: ProjectLocatorFailureStatusV1, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectLocatorError";
    this.status = status;
  }
}

type StableStat = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type StableDirectory = Readonly<{
  requestedPath: string;
  physicalPath: string;
  device: string;
  inode: string;
  stat: StableStat;
}>;

type StableResolution = Readonly<{
  requestedPath: string;
  physicalPath: string;
  anchor: StableDirectory;
  missingSuffix: string[];
}>;

type StableAbsenceToken = Readonly<{
  parentRequestedPath: string;
  parentPhysicalPath: string;
  anchorRequestedPath: string;
  anchorPhysicalPath: string;
  missingSuffix: readonly string[];
  stat: StableStat;
}>;

type StableLeafRead =
  | Readonly<{ status: "absent"; token: StableAbsenceToken }>
  | Readonly<{ status: "observed"; bytes: Buffer; token: StableStat }>;

type BriefStabilityToken =
  | Readonly<{ status: "absent"; absence: StableAbsenceToken }>
  | Readonly<{ status: "observed"; filePath: string; stat: StableStat }>;

type CompatibilityBriefObservation = Readonly<{
  generation: BriefGenerationV1;
  token: BriefStabilityToken;
}>;

export type FleetInputIdentityBoundaryV1 =
  | Readonly<{ kind: "directory-descriptor-opened"; requestedPath: string; physicalPath: string }>
  | Readonly<{ kind: "brief-absence-first-observed"; filePath: string }>
  | Readonly<{ kind: "brief-before-descriptor-open"; filePath: string }>
  | Readonly<{ kind: "brief-descriptor-opened"; filePath: string }>
  | Readonly<{ kind: "brief-large-allocation"; filePath: string; bytes: number }>
  | Readonly<{ kind: "brief-read"; filePath: string; bytes: number }>
  | Readonly<{ kind: "brief-parse"; filePath: string; bytes: number }>
  | Readonly<{ kind: "brief-hash"; filePath: string; bytes: number }>
  | Readonly<{ kind: "project-absence-first-observed"; physicalProjectDir: string }>
  | Readonly<{ kind: "project-identity-collected"; physicalProjectDir: string }>;

export type FleetInputIdentityObserverDependenciesV1 = Readonly<{
  onBoundary?(event: FleetInputIdentityBoundaryV1): void;
}>;

export type FleetInputIdentityObserversV1 = Readonly<{
  resolveProjectLocator(requestedProjectsRoot: string, briefId: string): ProjectLocatorV1;
  revalidateProjectLocator(locator: ProjectLocatorV1): ProjectLocatorV1;
  observeTargetGeneration(target: RunTargetV1): TargetGenerationV1;
  readCompatibilityBrief(target: RunTargetV1): BriefGenerationV1;
}>;

type ObservationContext = Readonly<{
  boundary(event: FleetInputIdentityBoundaryV1): void;
}>;

const DEFAULT_OBSERVATION_CONTEXT: ObservationContext = Object.freeze({
  boundary: () => undefined,
});

function observationContext(
  dependencies: FleetInputIdentityObserverDependenciesV1,
): ObservationContext {
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    fail("fleet input identity observer dependencies must be an object");
  }
  if (dependencies.onBoundary !== undefined && typeof dependencies.onBoundary !== "function") {
    fail("fleet input identity onBoundary dependency must be a function");
  }
  const onBoundary = dependencies.onBoundary;
  return Object.freeze({
    boundary: onBoundary === undefined
      ? DEFAULT_OBSERVATION_CONTEXT.boundary
      : (event: FleetInputIdentityBoundaryV1): void => onBoundary(event),
  });
}

function fail(message: string): never {
  throw new Error(message);
}

function failLimit(message: string): never {
  throw new ProjectLocatorError("limit-exceeded", message);
}

function locatorFailure(
  status: Exclude<ProjectLocatorFailureStatusV1, "limit-exceeded">,
  error: unknown,
): never {
  if (error instanceof ProjectLocatorError && error.status === "limit-exceeded") throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new ProjectLocatorError(status, message, error);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableStat(stat: fs.BigIntStats): StableStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameStableStat(left: StableStat, right: StableStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function pathComponents(absolutePath: string): string[] {
  const root = path.parse(absolutePath).root;
  const relative = path.relative(root, absolutePath);
  return relative === "" ? [] : relative.split(path.sep);
}

function safeComponent(component: string, label: string): string {
  if (
    component.length === 0
    || component === "."
    || component === ".."
    || component.includes("/")
    || component.includes("\\")
    || component.includes("\0")
  ) {
    fail(`${label} contains an unsafe path component`);
  }
  return component;
}

function boundedCanonicalPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be a non-empty canonical absolute path`);
  }
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`${label} must be a canonical absolute path`);
  }
  if (Buffer.byteLength(value) > LOCATOR_MAX_PATH_BYTES) {
    failLimit(`${label} exceeds the 16 KiB path limit`);
  }
  const components = pathComponents(value);
  if (components.length > LOCATOR_MAX_COMPONENTS) {
    failLimit(`${label} exceeds the 64-component limit`);
  }
  for (const component of components) safeComponent(component, label);
  return value;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const expected = new Set(keys);
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !expected.has(key))) {
    fail(`${label} has unknown or missing keys`);
  }
  return object;
}

function stableDirectory(requestedPath: string, context: ObservationContext): StableDirectory {
  const requestedBefore = stableStat(fs.lstatSync(requestedPath, { bigint: true }));
  const physicalPath = boundedCanonicalPath(
    path.resolve(fs.realpathSync(requestedPath)),
    "physical locator path",
  );
  const descriptor = fs.openSync(
    physicalPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    context.boundary({ kind: "directory-descriptor-opened", requestedPath, physicalPath });
    const beforeStats = fs.fstatSync(descriptor, { bigint: true });
    if (!beforeStats.isDirectory()) fail(`locator component is not a directory: ${requestedPath}`);
    const before = stableStat(beforeStats);
    const physicalBefore = stableStat(fs.lstatSync(physicalPath, { bigint: true }));
    if (!sameStableStat(before, physicalBefore)) {
      fail(`locator component changed before observation: ${requestedPath}`);
    }

    const physicalAfterPath = path.resolve(fs.realpathSync(requestedPath));
    const requestedAfter = stableStat(fs.lstatSync(requestedPath, { bigint: true }));
    const after = stableStat(fs.fstatSync(descriptor, { bigint: true }));
    const physicalAfter = stableStat(fs.lstatSync(physicalPath, { bigint: true }));
    if (
      physicalAfterPath !== physicalPath
      || !sameStableStat(requestedBefore, requestedAfter)
      || !sameStableStat(before, after)
      || !sameStableStat(before, physicalAfter)
    ) {
      fail(`locator component changed during stable observation: ${requestedPath}`);
    }
    return {
      requestedPath,
      physicalPath,
      device: String(before.dev),
      inode: String(before.ino),
      stat: before,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function walkToDeepestExisting(requestedPath: string, context: ObservationContext): StableResolution {
  const root = path.parse(requestedPath).root;
  let current = root;
  let deepestExisting = root;
  const missingSuffix: string[] = [];
  for (const component of pathComponents(requestedPath)) {
    if (missingSuffix.length > 0) {
      missingSuffix.push(component);
      continue;
    }
    const candidate = path.join(current, component);
    try {
      fs.lstatSync(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      missingSuffix.push(component);
      continue;
    }
    deepestExisting = candidate;
    current = candidate;
  }
  const anchor = stableDirectory(deepestExisting, context);
  const physicalPath = missingSuffix.length === 0
    ? anchor.physicalPath
    : path.join(anchor.physicalPath, ...missingSuffix);
  boundedCanonicalPath(physicalPath, "physical locator path");
  return { requestedPath, physicalPath, anchor, missingSuffix };
}

function sameResolution(left: StableResolution, right: StableResolution): boolean {
  return left.requestedPath === right.requestedPath
    && left.physicalPath === right.physicalPath
    && left.anchor.requestedPath === right.anchor.requestedPath
    && left.anchor.physicalPath === right.anchor.physicalPath
    && left.anchor.device === right.anchor.device
    && left.anchor.inode === right.anchor.inode
    && left.missingSuffix.length === right.missingSuffix.length
    && left.missingSuffix.every((component, index) => component === right.missingSuffix[index]);
}

function stableResolution(requestedPath: string, context: ObservationContext): StableResolution {
  const first = walkToDeepestExisting(requestedPath, context);
  const second = walkToDeepestExisting(requestedPath, context);
  if (!sameResolution(first, second)) {
    fail(`locator path changed during stable ancestor walk: ${requestedPath}`);
  }
  return first;
}

function safeBriefId(briefId: unknown): string {
  if (typeof briefId !== "string" || briefId.length === 0) {
    fail("briefId must be a non-empty bounded string");
  }
  if (Buffer.byteLength(briefId) > 64 * 1024) failLimit("briefId exceeds its 64 KiB bound");
  safeComponent(briefId, "briefId");
  return briefId;
}

function projectLeaf(briefId: string): string {
  return safeComponent(`fleet-${safeBriefId(briefId)}-native`, "project leaf");
}

function ensureResolutionStable(
  expected: StableResolution,
  actual: StableResolution,
  label: string,
): void {
  if (!sameResolution(expected, actual)) fail(`${label} changed during locator resolution`);
}

function resolveProjectLocatorWithContext(
  requestedProjectsRoot: string,
  briefId: string,
  context: ObservationContext,
): ProjectLocatorV1 {
  try {
    const requestedRoot = boundedCanonicalPath(path.resolve(requestedProjectsRoot), "requestedProjectsRoot");
    const requestedProject = boundedCanonicalPath(
      path.join(requestedRoot, projectLeaf(briefId)),
      "requestedProjectDir",
    );

    const root = stableResolution(requestedRoot, context);
    const project = stableResolution(requestedProject, context);
    ensureResolutionStable(root, stableResolution(requestedRoot, context), "projects root");
    ensureResolutionStable(project, stableResolution(requestedProject, context), "project path");

    const physicalRoot = boundedCanonicalPath(root.physicalPath, "physicalProjectsRoot");
    const physicalProject = boundedCanonicalPath(project.physicalPath, "physicalProjectDir");
    if (!within(physicalRoot, physicalProject) || physicalProject === physicalRoot) {
      fail("physical project resolves outside the physical projects root");
    }

    return {
      kind: "pico.project-locator",
      schemaVersion: 1,
      requestedProjectsRoot: requestedRoot,
      physicalProjectsRoot: physicalRoot,
      requestedProjectDir: requestedProject,
      physicalProjectDir: physicalProject,
      anchor: {
        requestedPath: project.anchor.requestedPath,
        physicalPath: project.anchor.physicalPath,
        device: project.anchor.device,
        inode: project.anchor.inode,
      },
      missingSuffix: [...project.missingSuffix],
    };
  } catch (error) {
    locatorFailure("target-conflict", error);
  }
}

export function resolveProjectLocator(requestedProjectsRoot: string, briefId: string): ProjectLocatorV1 {
  return resolveProjectLocatorWithContext(requestedProjectsRoot, briefId, DEFAULT_OBSERVATION_CONTEXT);
}

function checkedLocator(value: ProjectLocatorV1): ProjectLocatorV1 {
  const object = exactKeys(value, [
    "kind", "schemaVersion", "requestedProjectsRoot", "physicalProjectsRoot",
    "requestedProjectDir", "physicalProjectDir", "anchor", "missingSuffix",
  ], "project locator");
  if (object.kind !== "pico.project-locator" || object.schemaVersion !== 1) {
    fail("project locator kind or schemaVersion is invalid");
  }
  const requestedProjectsRoot = boundedCanonicalPath(object.requestedProjectsRoot, "requestedProjectsRoot");
  const physicalProjectsRoot = boundedCanonicalPath(object.physicalProjectsRoot, "physicalProjectsRoot");
  const requestedProjectDir = boundedCanonicalPath(object.requestedProjectDir, "requestedProjectDir");
  const physicalProjectDir = boundedCanonicalPath(object.physicalProjectDir, "physicalProjectDir");
  const anchorObject = exactKeys(
    object.anchor,
    ["requestedPath", "physicalPath", "device", "inode"],
    "project locator anchor",
  );
  const requestedAnchor = boundedCanonicalPath(anchorObject.requestedPath, "anchor requestedPath");
  const physicalAnchor = boundedCanonicalPath(anchorObject.physicalPath, "anchor physicalPath");
  if (
    typeof anchorObject.device !== "string"
    || !DECIMAL_IDENTITY.test(anchorObject.device)
    || typeof anchorObject.inode !== "string"
    || !DECIMAL_IDENTITY.test(anchorObject.inode)
  ) {
    fail("project locator anchor device/inode must be unsigned decimal strings");
  }
  if (!Array.isArray(object.missingSuffix) || object.missingSuffix.length > LOCATOR_MAX_COMPONENTS) {
    failLimit("project locator missing suffix exceeds the 64-component limit");
  }
  const missingSuffix = object.missingSuffix.map((component) => {
    if (typeof component !== "string") fail("project locator missing suffix must contain strings");
    return safeComponent(component, "project locator missing suffix");
  });
  if (!within(requestedProjectsRoot, requestedProjectDir) || requestedProjectDir === requestedProjectsRoot) {
    fail("requested project escapes its requested projects root");
  }
  if (!within(physicalProjectsRoot, physicalProjectDir) || physicalProjectDir === physicalProjectsRoot) {
    fail("physical project escapes its physical projects root");
  }
  if (path.join(requestedAnchor, ...missingSuffix) !== requestedProjectDir) {
    fail("project locator requested anchor/suffix projection is inconsistent");
  }
  if (path.join(physicalAnchor, ...missingSuffix) !== physicalProjectDir) {
    fail("project locator physical anchor/suffix projection is inconsistent");
  }
  return {
    kind: "pico.project-locator",
    schemaVersion: 1,
    requestedProjectsRoot,
    physicalProjectsRoot,
    requestedProjectDir,
    physicalProjectDir,
    anchor: {
      requestedPath: requestedAnchor,
      physicalPath: physicalAnchor,
      device: anchorObject.device,
      inode: anchorObject.inode,
    },
    missingSuffix,
  };
}

function verifyStoredAnchor(locator: ProjectLocatorV1, context: ObservationContext): void {
  const observed = stableResolution(locator.anchor.requestedPath, context);
  if (
    observed.missingSuffix.length !== 0
    || observed.physicalPath !== locator.anchor.physicalPath
    || observed.anchor.device !== locator.anchor.device
    || observed.anchor.inode !== locator.anchor.inode
  ) {
    fail("stored locator anchor physical path/device/inode changed");
  }
}

function revalidateProjectLocatorWithContext(
  locator: ProjectLocatorV1,
  context: ObservationContext,
): ProjectLocatorV1 {
  let checked: ProjectLocatorV1;
  try {
    checked = checkedLocator(locator);
  } catch (error) {
    locatorFailure("invalid-store", error);
  }
  try {
    verifyStoredAnchor(checked, context);
    const root = stableResolution(checked.requestedProjectsRoot, context);
    if (root.physicalPath !== checked.physicalProjectsRoot) {
      fail("stored locator physical projects root changed");
    }
    const project = stableResolution(checked.requestedProjectDir, context);
    if (project.physicalPath !== checked.physicalProjectDir) {
      fail("stored locator physical project prediction changed");
    }
    verifyStoredAnchor(checked, context);
    const rootAfter = stableResolution(checked.requestedProjectsRoot, context);
    const projectAfter = stableResolution(checked.requestedProjectDir, context);
    if (
      rootAfter.physicalPath !== checked.physicalProjectsRoot
      || projectAfter.physicalPath !== checked.physicalProjectDir
    ) {
      fail("stored locator changed during revalidation");
    }
    return checked;
  } catch (error) {
    locatorFailure("external-state-conflict", error);
  }
}

export function revalidateProjectLocator(locator: ProjectLocatorV1): ProjectLocatorV1 {
  return revalidateProjectLocatorWithContext(locator, DEFAULT_OBSERVATION_CONTEXT);
}

export function applicationResourceKey(app: string, serial: "emulator-5554"): string {
  if (typeof app !== "string" || app.length === 0 || Buffer.byteLength(app) > 64 * 1024) {
    fail("application resource app must be a non-empty bounded string");
  }
  if (serial !== "emulator-5554") fail("application resource serial must be emulator-5554");
  return sha256(canonicalJson({
    kind: "pico.application-resource",
    schemaVersion: 1,
    app,
    serial,
  }));
}

export function projectResourceKey(physicalProjectDir: string): string {
  const canonicalProject = boundedCanonicalPath(physicalProjectDir, "physicalProjectDir");
  return sha256(canonicalJson({
    kind: "pico.physical-project-resource",
    schemaVersion: 1,
    physicalProjectDir: canonicalProject,
  }));
}

function checkedTarget(target: RunTargetV1): RunTargetV1 {
  if (target === null || typeof target !== "object") fail("run target must be an object");
  const briefId = safeBriefId(target.briefId);
  if (typeof target.briefInput !== "string" || Buffer.byteLength(target.briefInput) > ORIGINAL_BRIEF_MAX_BYTES) {
    fail("target briefInput exceeds the 256 KiB bound");
  }
  if (target.app !== `com.fleet.${briefId}` || target.executionSerial !== "emulator-5554") {
    fail("target application identity is inconsistent");
  }
  const briefPath = boundedCanonicalPath(target.briefPath, "target briefPath");
  if (path.basename(briefPath) !== `${briefId}.json`) fail("target briefPath does not match briefId");
  if (target.projectDir !== target.projectLocator.requestedProjectDir) {
    fail("target projectDir does not match its locator");
  }
  if (path.basename(target.projectDir) !== projectLeaf(briefId)) {
    fail("target project mapping does not match its briefId");
  }
  if (target.resourceKey !== applicationResourceKey(target.app, target.executionSerial)) {
    fail("target application resource key is inconsistent");
  }
  if (target.projectResourceKey !== projectResourceKey(target.projectLocator.physicalProjectDir)) {
    fail("target project resource key is inconsistent");
  }
  return target;
}

function confirmStableLeafAbsence(
  filePath: string,
  label: string,
  context: ObservationContext,
): StableAbsenceToken {
  const token = (parent: StableResolution, stat: StableStat): StableAbsenceToken => ({
    parentRequestedPath: parent.requestedPath,
    parentPhysicalPath: parent.physicalPath,
    anchorRequestedPath: parent.anchor.requestedPath,
    anchorPhysicalPath: parent.anchor.physicalPath,
    missingSuffix: [...parent.missingSuffix],
    stat,
  });
  const requestedParent = path.dirname(filePath);
  const parent = stableResolution(requestedParent, context);
  if (parent.missingSuffix.length > 0) {
    const parentAfter = stableResolution(requestedParent, context);
    ensureResolutionStable(parent, parentAfter, `${label} parent`);
    try {
      fs.lstatSync(filePath);
      fail(`${label} appeared during absence observation: ${filePath}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    ensureResolutionStable(parent, stableResolution(requestedParent, context), `${label} parent`);
    return token(parent, parent.anchor.stat);
  }

  const descriptor = fs.openSync(
    parent.physicalPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    const beforeStats = fs.fstatSync(descriptor, { bigint: true });
    if (!beforeStats.isDirectory()) fail(`${label} parent is not a directory`);
    const before = stableStat(beforeStats);
    const pathBefore = stableStat(fs.lstatSync(parent.physicalPath, { bigint: true }));
    if (!sameStableStat(before, pathBefore)) {
      fail(`${label} parent changed before absence observation`);
    }
    try {
      fs.lstatSync(filePath);
      fail(`${label} appeared during absence observation: ${filePath}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const after = stableStat(fs.fstatSync(descriptor, { bigint: true }));
    const pathAfter = stableStat(fs.lstatSync(parent.physicalPath, { bigint: true }));
    const parentAfter = stableResolution(requestedParent, context);
    if (
      !sameStableStat(before, after)
      || !sameStableStat(before, pathAfter)
      || parentAfter.missingSuffix.length !== 0
      || parentAfter.physicalPath !== parent.physicalPath
      || parentAfter.anchor.device !== parent.anchor.device
      || parentAfter.anchor.inode !== parent.anchor.inode
    ) {
      fail(`${label} parent changed during stable absence observation`);
    }
    return token(parent, before);
  } finally {
    fs.closeSync(descriptor);
  }
}

function stableReadLeaf(
  filePath: string,
  maxBytes: number,
  context: ObservationContext,
): StableLeafRead {
  let pathBeforeStats: fs.BigIntStats;
  try {
    pathBeforeStats = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      context.boundary({ kind: "brief-absence-first-observed", filePath });
      return {
        status: "absent",
        token: confirmStableLeafAbsence(filePath, "compatibility brief", context),
      };
    }
    throw error;
  }
  if (pathBeforeStats.isSymbolicLink()) fail(`compatibility brief is a symbolic link: ${filePath}`);
  if (!pathBeforeStats.isFile()) fail(`compatibility brief is not a regular file: ${filePath}`);
  if (pathBeforeStats.nlink !== 1n) fail(`compatibility brief must have one link: ${filePath}`);
  if (pathBeforeStats.size > BigInt(maxBytes)) {
    fail(`compatibility brief exceeds the ${maxBytes}-byte (3 MiB) size limit`);
  }

  context.boundary({ kind: "brief-before-descriptor-open", filePath });
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    context.boundary({ kind: "brief-descriptor-opened", filePath });
    const descriptorBeforeStats = fs.fstatSync(descriptor, { bigint: true });
    if (!descriptorBeforeStats.isFile()) fail(`compatibility brief is not a regular file: ${filePath}`);
    if (descriptorBeforeStats.nlink !== 1n) fail(`compatibility brief must have one link: ${filePath}`);
    if (descriptorBeforeStats.size > BigInt(maxBytes)) {
      fail(`compatibility brief exceeds the ${maxBytes}-byte (3 MiB) size limit`);
    }
    const pathBefore = stableStat(pathBeforeStats);
    const descriptorBefore = stableStat(descriptorBeforeStats);
    if (!sameStableStat(pathBefore, descriptorBefore)) {
      fail(`compatibility brief changed before stable read: ${filePath}`);
    }

    const size = Number(descriptorBeforeStats.size);
    context.boundary({ kind: "brief-large-allocation", filePath, bytes: size });
    const bytes = Buffer.alloc(size);
    const chunk = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, Math.max(1, size)));
    let offset = 0;
    if (size > 0) context.boundary({ kind: "brief-read", filePath, bytes: size });
    while (offset < size) {
      const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (count === 0) fail(`compatibility brief ended during stable read: ${filePath}`);
      chunk.copy(bytes, offset, 0, count);
      offset += count;
    }

    const descriptorAfter = stableStat(fs.fstatSync(descriptor, { bigint: true }));
    let pathAfter: StableStat;
    try {
      pathAfter = stableStat(fs.lstatSync(filePath, { bigint: true }));
    } catch (error) {
      if (isMissing(error)) fail(`compatibility brief path disappeared during stable read: ${filePath}`);
      throw error;
    }
    if (!sameStableStat(descriptorBefore, descriptorAfter) || !sameStableStat(descriptorBefore, pathAfter)) {
      fail(`compatibility brief was replaced or changed during stable read: ${filePath}`);
    }
    return { status: "observed", bytes, token: descriptorBefore };
  } finally {
    fs.closeSync(descriptor);
  }
}

function observeCompatibilityBriefWithContext(
  target: RunTargetV1,
  context: ObservationContext,
): CompatibilityBriefObservation {
  const checked = checkedTarget(target);
  const leaf = stableReadLeaf(checked.briefPath, COMPATIBILITY_BRIEF_MAX_BYTES, context);
  if (leaf.status === "absent") {
    return {
      generation: { status: "absent" },
      token: { status: "absent", absence: leaf.token },
    };
  }
  const bytes = leaf.bytes;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("compatibility brief is not valid UTF-8");
  }
  let raw: unknown;
  try {
    context.boundary({ kind: "brief-parse", filePath: checked.briefPath, bytes: bytes.length });
    raw = JSON.parse(text);
  } catch {
    fail("compatibility brief contains malformed JSON");
  }
  const object = exactKeys(raw, ["id", "brief", "spec"], "compatibility brief payload");
  if (object.id !== checked.briefId) fail("compatibility brief id does not match target");
  if (object.brief !== checked.briefInput) fail("compatibility brief must equal the exact raw target brief bytes");
  const parsedSpec = appSpecSchema.safeParse(object.spec);
  if (!parsedSpec.success) fail(`compatibility brief AppSpec is invalid: ${parsedSpec.error.message}`);
  const canonical = Buffer.from(canonicalJson({
    id: checked.briefId,
    brief: checked.briefInput,
    spec: parsedSpec.data,
  }), "utf8");
  if (!canonical.equals(bytes)) fail("compatibility brief bytes are not the strict canonical payload");
  context.boundary({ kind: "brief-hash", filePath: checked.briefPath, bytes: bytes.length });
  return {
    generation: { status: "observed", bytes: bytes.length, sha256: sha256(bytes) },
    token: { status: "observed", filePath: checked.briefPath, stat: leaf.token },
  };
}

function readCompatibilityBriefWithContext(
  target: RunTargetV1,
  context: ObservationContext,
): BriefGenerationV1 {
  return observeCompatibilityBriefWithContext(target, context).generation;
}

export function readCompatibilityBrief(target: RunTargetV1): BriefGenerationV1 {
  return readCompatibilityBriefWithContext(target, DEFAULT_OBSERVATION_CONTEXT);
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length <= GENERATION_REASON_MAX_BYTES) return raw;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = GENERATION_REASON_MAX_BYTES; length >= GENERATION_REASON_MAX_BYTES - 3; length -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, length));
    } catch {
      // A UTF-8 code point can cross the byte boundary by at most three continuation bytes.
    }
  }
  return "project generation observation failed";
}

function unobservableProject(error: unknown): ProjectInputGenerationV1 {
  const reason = boundedReason(error);
  return { status: "unobservable", reason, reasonSha256: sha256(reason) };
}

function observedProjectGeneration(
  physicalProjectDir: string,
  context: ObservationContext,
): ProjectInputGenerationV1 {
  const descriptor = fs.openSync(
    physicalProjectDir,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    const beforeStats = fs.fstatSync(descriptor, { bigint: true });
    if (!beforeStats.isDirectory()) fail("physical project is not a directory");
    const before = stableStat(beforeStats);
    const pathBefore = stableStat(fs.lstatSync(physicalProjectDir, { bigint: true }));
    if (!sameStableStat(before, pathBefore)) fail("physical project changed before generation collection");

    const identity = collectGradleInputIdentity(physicalProjectDir);
    context.boundary({ kind: "project-identity-collected", physicalProjectDir });

    const after = stableStat(fs.fstatSync(descriptor, { bigint: true }));
    const pathAfter = stableStat(fs.lstatSync(physicalProjectDir, { bigint: true }));
    const physicalAfter = path.resolve(fs.realpathSync(physicalProjectDir));
    if (
      physicalAfter !== physicalProjectDir
      || !sameStableStat(before, after)
      || !sameStableStat(before, pathAfter)
    ) {
      fail("physical project changed during generation collection");
    }
    if (identity.projectDir !== physicalProjectDir || identity.schemaVersion !== 1 || identity.algorithm !== "sha256") {
      fail("receipt Gradle input identity does not match the physical project");
    }
    return {
      status: "observed",
      directory: {
        physicalPath: physicalProjectDir,
        device: String(before.dev),
        inode: String(before.ino),
      },
      identity: {
        kind: "pico.gradle-input-generation",
        schemaVersion: 1,
        policy: "pico-native-receipt-gradle-input-v1",
        projectDir: identity.projectDir,
        algorithm: "sha256",
        sha256: identity.sha256,
        entryCount: identity.entryCount,
        totalBytes: identity.totalBytes,
      },
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameBriefGeneration(left: BriefGenerationV1, right: BriefGenerationV1): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "absent" || right.status === "absent") return true;
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function sameStableAbsence(left: StableAbsenceToken, right: StableAbsenceToken): boolean {
  return left.parentRequestedPath === right.parentRequestedPath
    && left.parentPhysicalPath === right.parentPhysicalPath
    && left.anchorRequestedPath === right.anchorRequestedPath
    && left.anchorPhysicalPath === right.anchorPhysicalPath
    && left.missingSuffix.length === right.missingSuffix.length
    && left.missingSuffix.every((component, index) => component === right.missingSuffix[index])
    && sameStableStat(left.stat, right.stat);
}

function sameBriefObservation(
  left: CompatibilityBriefObservation,
  right: CompatibilityBriefObservation,
): boolean {
  if (!sameBriefGeneration(left.generation, right.generation) || left.token.status !== right.token.status) {
    return false;
  }
  if (left.token.status === "absent" && right.token.status === "absent") {
    return sameStableAbsence(left.token.absence, right.token.absence);
  }
  if (left.token.status === "observed" && right.token.status === "observed") {
    return left.token.filePath === right.token.filePath && sameStableStat(left.token.stat, right.token.stat);
  }
  return false;
}

type ObservedProjectGeneration = Extract<ProjectInputGenerationV1, { status: "observed" }>;

function sameObservedProjectGeneration(
  left: ObservedProjectGeneration,
  right: ObservedProjectGeneration,
): boolean {
  return left.directory.physicalPath === right.directory.physicalPath
    && left.directory.device === right.directory.device
    && left.directory.inode === right.directory.inode
    && left.identity.kind === right.identity.kind
    && left.identity.schemaVersion === right.identity.schemaVersion
    && left.identity.policy === right.identity.policy
    && left.identity.projectDir === right.identity.projectDir
    && left.identity.algorithm === right.identity.algorithm
    && left.identity.sha256 === right.identity.sha256
    && left.identity.entryCount === right.identity.entryCount
    && left.identity.totalBytes === right.identity.totalBytes;
}

function coherentTargetGeneration(
  target: RunTargetV1,
  locator: ProjectLocatorV1,
  brief: CompatibilityBriefObservation,
  project: ProjectInputGenerationV1,
  context: ObservationContext,
): TargetGenerationV1 {
  const briefAfter = observeCompatibilityBriefWithContext(target, context);
  if (!sameBriefObservation(brief, briefAfter)) {
    fail("compatibility brief generation changed across project generation observation");
  }
  if (project.status === "observed") {
    const projectAfter = observedProjectGeneration(locator.physicalProjectDir, context);
    if (projectAfter.status !== "observed" || !sameObservedProjectGeneration(project, projectAfter)) {
      fail("selected Gradle input generation changed across target generation observation");
    }
  } else if (project.status === "absent") {
    try {
      fs.lstatSync(locator.physicalProjectDir);
      fail("physical project appeared across target generation observation");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    confirmStableLeafAbsence(locator.physicalProjectDir, "physical project", context);
  }
  const finalLocator = revalidateProjectLocatorWithContext(locator, context);
  if (
    finalLocator.requestedProjectDir !== locator.requestedProjectDir
    || finalLocator.physicalProjectDir !== locator.physicalProjectDir
  ) {
    fail("project locator changed across target generation observation");
  }
  return { brief: brief.generation, project };
}

function observeTargetGenerationWithContext(
  target: RunTargetV1,
  context: ObservationContext,
): TargetGenerationV1 {
  const checked = checkedTarget(target);
  const locator = revalidateProjectLocatorWithContext(checked.projectLocator, context);
  const brief = observeCompatibilityBriefWithContext(checked, context);
  let project: ProjectInputGenerationV1;
  try {
    const stat = fs.lstatSync(locator.physicalProjectDir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("physical project is not a no-follow directory");
  } catch (error) {
    if (isMissing(error)) {
      context.boundary({
        kind: "project-absence-first-observed",
        physicalProjectDir: locator.physicalProjectDir,
      });
      confirmStableLeafAbsence(
        locator.physicalProjectDir,
        "physical project",
        context,
      );
      return coherentTargetGeneration(checked, locator, brief, { status: "absent" }, context);
    }
    return coherentTargetGeneration(checked, locator, brief, unobservableProject(error), context);
  }
  try {
    project = observedProjectGeneration(locator.physicalProjectDir, context);
  } catch (error) {
    project = unobservableProject(error);
  }
  return coherentTargetGeneration(checked, locator, brief, project, context);
}

export function observeTargetGeneration(target: RunTargetV1): TargetGenerationV1 {
  return observeTargetGenerationWithContext(target, DEFAULT_OBSERVATION_CONTEXT);
}

/** Test-only semantic race seam. This factory is intentionally absent from package/index barrels. */
export function createFleetInputIdentityObserversForTest(
  dependencies: FleetInputIdentityObserverDependenciesV1 = {},
): FleetInputIdentityObserversV1 {
  const context = observationContext(dependencies);
  return Object.freeze({
    resolveProjectLocator: (requestedProjectsRoot: string, briefId: string): ProjectLocatorV1 =>
      resolveProjectLocatorWithContext(requestedProjectsRoot, briefId, context),
    revalidateProjectLocator: (locator: ProjectLocatorV1): ProjectLocatorV1 =>
      revalidateProjectLocatorWithContext(locator, context),
    observeTargetGeneration: (target: RunTargetV1): TargetGenerationV1 =>
      observeTargetGenerationWithContext(target, context),
    readCompatibilityBrief: (target: RunTargetV1): BriefGenerationV1 =>
      readCompatibilityBriefWithContext(target, context),
  });
}
