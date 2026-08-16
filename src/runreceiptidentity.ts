import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appSpecSchema } from "./appspec.js";

export type CanonicalIdentity = {
  algorithm: "sha256";
  sha256: string;
  bytes: number;
};

export type AuthoredAppSpecIdentity = CanonicalIdentity & {
  sourcePath: string;
};

export type GradleInputEntry = {
  path: string;
  bytes: number;
  sha256: string;
};

export type GradleInputIdentity = {
  schemaVersion: 1;
  projectDir: string;
  algorithm: "sha256";
  sha256: string;
  entryCount: number;
  totalBytes: number;
  entries: GradleInputEntry[];
};

export const GRADLE_INPUT_MAX_ENTRIES = 20_000;
export const GRADLE_INPUT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const GRADLE_INPUT_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const GRADLE_INPUT_MAX_DIRECTORIES = 20_000;
export const GRADLE_INPUT_MAX_DEPTH = 128;
export const GRADLE_INPUT_MAX_EVENT_SAMPLES = 8;
const GRADLE_INPUT_EVENT_SAMPLE_MAX_CHARS = 160;
const GRADLE_INPUT_WATCH_SETTLE_TIMEOUT_MS = 250;
const GRADLE_INPUT_WATCH_SETTLE_POLL_MS = 5;
const GRADLE_INPUT_WATCH_DRAIN_MAX_TURNS = 8;
const GRADLE_INPUT_WATCH_QUIET_TURNS = 2;

const ROOT_FILES = new Set([
  "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts",
  "gradle.properties", "gradlew", "gradlew.bat",
  "app/build.gradle", "app/build.gradle.kts", "app/proguard-rules.pro",
]);
const RECURSIVE_ROOTS = ["gradle", "buildSrc", "app/src", "app/libs", "libs"] as const;
const EXCLUDED_RECURSIVE_SEGMENTS = new Set([".gradle", ".git", ".idea"]);
const BUILDSRC_NON_INPUT_FILE_PATTERN = /^(?:local\.properties|readme(?:\..*)?|license(?:\..*)?|changelog(?:\..*)?|contributing(?:\..*)?|code_of_conduct(?:\..*)?)$/i;

function isExcludedRecursiveSubtree(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => EXCLUDED_RECURSIVE_SEGMENTS.has(segment))) return true;
  return segments[0] === "buildSrc" && segments[1] === "build";
}

function isDirectBuildSrcNonInputFilePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.length === 2
    && segments[0] === "buildSrc"
    && BUILDSRC_NON_INPUT_FILE_PATTERN.test(segments[1] ?? "");
}

function isExcludedGradleInputFile(relativePath: string): boolean {
  return isExcludedRecursiveSubtree(relativePath) || isDirectBuildSrcNonInputFilePath(relativePath);
}

export function isGradleInputPath(relativePath: string): boolean {
  if (!relativePath
    || path.posix.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return ROOT_FILES.has(relativePath)
    || (!isExcludedGradleInputFile(relativePath)
      && RECURSIVE_ROOTS.some((root) => relativePath.startsWith(`${root}/`)));
}

export function gradleInputManifestPathIssues(
  entries: ReadonlyArray<Pick<GradleInputEntry, "path">>,
): string[] {
  const issues: string[] = [];
  if (entries.length === 0) issues.push("Gradle input manifest must contain at least one entry");
  const outsideAllowlist = entries.map((entry) => entry.path).filter((entryPath) => !isGradleInputPath(entryPath));
  if (outsideAllowlist.length) {
    issues.push(`Gradle input entries must stay inside the exact V1 allowlist: ${outsideAllowlist.slice(0, 3).join(", ")}`);
  }
  if (!entries.some((entry) => /^app\/src\/(?:.+\/)?AndroidManifest\.xml$/.test(entry.path))) {
    issues.push("Gradle input manifest requires at least one Android manifest at app/src/**/AndroidManifest.xml");
  }
  if (!entries.some((entry) => /^app\/src\/.+\.(?:kt|java)$/.test(entry.path))) {
    issues.push("Gradle input manifest requires at least one Kotlin or Java source under app/src");
  }
  return issues;
}

export function assertGradleInputManifestPaths(
  entries: ReadonlyArray<Pick<GradleInputEntry, "path">>,
): void {
  const issues = gradleInputManifestPathIssues(entries);
  if (issues.length) throw new Error(issues.join("; "));
}

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`unsupported canonical JSON value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error("canonical JSON does not support cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("unsupported canonical JSON array type");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("canonical JSON does not support sparse arrays");
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== value.length) {
        throw new Error("canonical JSON arrays must have no extra properties");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("unsupported canonical JSON array accessor property");
        }
        result.push(canonicalValue(descriptor.value, ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("unsupported canonical JSON object type");
    }
    const result: Record<string, unknown> = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("unsupported canonical JSON symbol key");
    }
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error("unsupported canonical JSON property");
      }
      result[key] = canonicalValue(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value, new Set()));
  if (encoded === undefined) throw new Error("value has no canonical JSON encoding");
  return encoded;
}

export function canonicalIdentity(value: unknown): CanonicalIdentity {
  const canonical = canonicalJson(value);
  return {
    algorithm: "sha256",
    sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
    bytes: Buffer.byteLength(canonical),
  };
}

export function readAuthoredAppSpecIdentity(briefPath: string): AuthoredAppSpecIdentity {
  const sourcePath = fs.realpathSync(path.resolve(briefPath));
  const brief: unknown = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (
    brief === null ||
    typeof brief !== "object" ||
    Array.isArray(brief) ||
    !Object.hasOwn(brief, "spec")
  ) {
    throw new Error(`authored brief ${sourcePath} must contain .spec`);
  }
  const identity = canonicalIdentity(appSpecSchema.parse((brief as { spec: unknown }).spec));
  return { ...identity, sourcePath };
}

export function effectiveAppSpecIdentity(spec: unknown): CanonicalIdentity {
  return canonicalIdentity(spec);
}

function isWithinProject(projectRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(projectRealPath, candidateRealPath);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validateSelectedPath(
  projectRealPath: string,
  selectedPath: string,
): { stat: fs.Stats; realPath: string } {
  const stat = fs.lstatSync(selectedPath);
  let realPath: string;
  try {
    realPath = fs.realpathSync(selectedPath);
  } catch (error) {
    if (stat.isSymbolicLink()) throw new Error(`selected Gradle input is an unsupported symlink: ${selectedPath}`);
    throw error;
  }
  if (!isWithinProject(projectRealPath, realPath)) {
    throw new Error(`selected Gradle input escapes the real project root: ${selectedPath}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`selected Gradle input is an unsupported symlink: ${selectedPath}`);
  return { stat, realPath };
}

function lstatIfPresent(selectedPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(selectedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

type StableStat = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function stableStat(stat: fs.BigIntStats): StableStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameStableStat(left: StableStat, right: StableStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function hashOpenDescriptor(descriptor: number, bytes: number, filePath: string): string {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
    if (count === 0) throw new Error(`selected Gradle input ended while establishing continuity: ${filePath}`);
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  return digest.digest("hex");
}

function lstatStable(filePath: string): StableStat {
  return stableStat(fs.lstatSync(filePath, { bigint: true }));
}

export type GradleInputGenerationGuard = {
  assertUnchanged: () => Promise<void>;
  close: () => void;
};

export class GradleInputContinuityInconclusiveError extends Error {
  override readonly name = "GradleInputContinuityInconclusiveError";
}

export type GradleInputGuardOptions = Readonly<{
  maxDirectories?: number;
  maxDepth?: number;
  maxEventSamples?: number;
}>;

type GuardLimits = Readonly<{
  maxDirectories: number;
  maxDepth: number;
  maxEventSamples: number;
}>;

type ParentGeneration = {
  before: StableStat;
  selectedObserved: boolean;
  excludedObserved: boolean;
  ambiguousObserved: boolean;
};

type GuardState = {
  projectDir: string;
  limits: GuardLimits;
  trackedFiles: Array<{ path: string; descriptor: number; before: StableStat }>;
  trackedDirectories: Map<string, StableStat>;
  watchers: fs.FSWatcher[];
  parentGenerations: Map<string, ParentGeneration>;
  inconclusiveEventSamples: string[];
  definiteEventSamples: string[];
  inconclusiveEventsOmitted: boolean;
  definiteEventsOmitted: boolean;
  eventRevision: number;
  watchersClosed: boolean;
  closed: boolean;
};

function boundedGuardOption(name: string, value: number | undefined, ceiling: number): number {
  const resolved = value ?? ceiling;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new Error(`${name} must be an integer within 1..${ceiling}`);
  }
  return resolved;
}

function guardLimits(options: GradleInputGuardOptions = {}): GuardLimits {
  return {
    maxDirectories: boundedGuardOption("maxDirectories", options.maxDirectories, GRADLE_INPUT_MAX_DIRECTORIES),
    maxDepth: boundedGuardOption("maxDepth", options.maxDepth, GRADLE_INPUT_MAX_DEPTH),
    maxEventSamples: boundedGuardOption("maxEventSamples", options.maxEventSamples, GRADLE_INPUT_MAX_EVENT_SAMPLES),
  };
}

function rememberGuardEvent(
  state: GuardState,
  parent: ParentGeneration,
  classification: "selected" | "excluded" | "ambiguous",
  event: string,
  certainty: "inconclusive" | "definite" = "inconclusive",
): void {
  if (classification === "selected") parent.selectedObserved = true;
  else if (classification === "excluded") parent.excludedObserved = true;
  else parent.ambiguousObserved = true;
  state.eventRevision += 1;
  if (classification === "excluded") return;
  // Directory-watch filenames may be coalesced or attributed to a selected-looking sibling.
  // They invalidate this build attempt, but only retained identity checks or watcher failures
  // are definite enough to prevent the one bounded fresh-build retry.
  const samples = certainty === "definite" ? state.definiteEventSamples : state.inconclusiveEventSamples;
  if (samples.length < state.limits.maxEventSamples) {
    samples.push(event.slice(0, GRADLE_INPUT_EVENT_SAMPLE_MAX_CHARS));
  } else if (certainty === "definite") {
    state.definiteEventsOmitted = true;
  } else {
    state.inconclusiveEventsOmitted = true;
  }
}

function closeWatchers(state: GuardState, recordErrors: boolean): void {
  if (state.watchersClosed) return;
  state.watchersClosed = true;
  for (const watcher of state.watchers) {
    try {
      watcher.close();
    } catch (error) {
      if (recordErrors) {
        const parent = state.parentGenerations.values().next().value as ParentGeneration | undefined;
        if (parent) rememberGuardEvent(
          state,
          parent,
          "ambiguous",
          `watcher-close-error:${error instanceof Error ? error.message : String(error)}`,
          "definite",
        );
      }
    }
  }
}

function closeGuardState(state: GuardState): void {
  if (state.closed) return;
  state.closed = true;
  closeWatchers(state, false);
  for (const file of state.trackedFiles) {
    try { fs.closeSync(file.descriptor); } catch {}
  }
}

function watchDirectChildren(
  state: GuardState,
  directory: string,
  classifyName: (name: string) => "selected" | "excluded" | "ambiguous",
): void {
  if (!lstatIfPresent(directory)?.isDirectory()) return;
  const realDirectory = fs.realpathSync(directory);
  const parent: ParentGeneration = {
    before: lstatStable(realDirectory),
    selectedObserved: false,
    excludedObserved: false,
    ambiguousObserved: false,
  };
  state.parentGenerations.set(realDirectory, parent);
  const watcher = fs.watch(realDirectory, { persistent: false }, (eventType, filename) => {
    const name = filename === null ? "" : filename.toString();
    const directName = name.split(/[\\/]/, 1)[0];
    const classification = directName ? classifyName(directName) : "ambiguous";
    rememberGuardEvent(state, parent, classification, `${eventType}:${directName || "unknown"}`);
  });
  state.watchers.push(watcher);
  watcher.on("error", (error) => rememberGuardEvent(
    state,
    parent,
    "ambiguous",
    `watcher-error:${error.message}`,
    "definite",
  ));
  if (!sameStableStat(parent.before, lstatStable(realDirectory))) {
    rememberGuardEvent(state, parent, "ambiguous", "watcher-setup-parent-generation-changed");
  }
}

function createGuardState(projectDir: string, options: GradleInputGuardOptions): GuardState {
  const state: GuardState = {
    projectDir,
    limits: guardLimits(options),
    trackedFiles: [],
    trackedDirectories: new Map(),
    watchers: [],
    parentGenerations: new Map(),
    inconclusiveEventSamples: [],
    definiteEventSamples: [],
    inconclusiveEventsOmitted: false,
    definiteEventsOmitted: false,
    eventRevision: 0,
    watchersClosed: false,
    closed: false,
  };
  try {
    const appSelectedNames = new Set(["build.gradle", "build.gradle.kts", "proguard-rules.pro", "src", "libs"]);
    const projectSelectedNames = new Set([
      "app",
      ...[...ROOT_FILES].filter((relativePath) => !relativePath.includes("/")),
      ...RECURSIVE_ROOTS.filter((relativePath) => !relativePath.includes("/")),
    ]);
    watchDirectChildren(state, projectDir, (name) => projectSelectedNames.has(name) ? "selected" : "excluded");
    watchDirectChildren(
      state,
      path.join(projectDir, "app"),
      (name) => appSelectedNames.has(name)
        ? "selected"
        : "excluded",
    );
    watchDirectChildren(
      state,
      path.join(projectDir, "buildSrc"),
      (name) => {
        const relativePath = `buildSrc/${name}`;
        if (isExcludedRecursiveSubtree(relativePath)) return "excluded";
        if (isDirectBuildSrcNonInputFilePath(relativePath)) return "ambiguous";
        return "selected";
      },
    );
    return state;
  } catch (error) {
    closeGuardState(state);
    throw error;
  }
}

function hashSelectedFile(
  projectRealPath: string,
  filePath: string,
  expected: fs.Stats,
  guardState?: GuardState,
): { bytes: number; sha256: string } {
  if (!expected.isFile()) throw new Error(`selected Gradle input is not a regular file: ${filePath}`);
  if (expected.size > GRADLE_INPUT_MAX_FILE_BYTES) {
    throw new Error(`selected Gradle input exceeds the ${GRADLE_INPUT_MAX_FILE_BYTES}-byte file limit: ${filePath}`);
  }
  const descriptor = fs.openSync(filePath, "r");
  let retained = false;
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size ||
      opened.mtimeMs !== expected.mtimeMs ||
      opened.ctimeMs !== expected.ctimeMs
    ) {
      throw new Error(`selected Gradle input changed before hashing: ${filePath}`);
    }
    const before = stableStat(fs.fstatSync(descriptor, { bigint: true }));
    const sha256 = hashOpenDescriptor(descriptor, opened.size, filePath);
    const after = stableStat(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameStableStat(before, after)) {
      throw new Error(`selected Gradle input changed while hashing: ${filePath}`);
    }
    const current = validateSelectedPath(projectRealPath, filePath);
    if (!sameStableStat(before, lstatStable(current.realPath))) {
      throw new Error(`selected Gradle input path changed while hashing: ${filePath}`);
    }
    if (guardState) {
      guardState.trackedFiles.push({ path: filePath, descriptor, before });
      retained = true;
    }
    return { bytes: opened.size, sha256 };
  } finally {
    if (!retained) fs.closeSync(descriptor);
  }
}

function collectGradleInputIdentityInternal(
  projectDir: string,
  options: GradleInputGuardOptions,
  state?: GuardState,
): GradleInputIdentity {
  const projectRealPath = fs.realpathSync(path.resolve(projectDir));
  if (!fs.lstatSync(projectRealPath).isDirectory()) {
    throw new Error(`Gradle project is not a directory: ${projectRealPath}`);
  }
  if (state && state.projectDir !== projectRealPath) {
    throw new Error("Gradle input generation guard requires the canonical projectDir");
  }
  const limits = state?.limits ?? guardLimits(options);
  const entries: GradleInputEntry[] = [];
  let totalBytes = 0;
  let directoryCount = 0;

  const addFile = (selectedPath: string): void => {
    if (entries.length >= GRADLE_INPUT_MAX_ENTRIES) {
      throw new Error(`Gradle input manifest exceeds ${GRADLE_INPUT_MAX_ENTRIES} entries`);
    }
    const { stat, realPath } = validateSelectedPath(projectRealPath, selectedPath);
    const relativePath = path.relative(projectRealPath, realPath).split(path.sep).join("/");
    if (!isGradleInputPath(relativePath)) {
      throw new Error(`selected Gradle input is outside the exact V1 allowlist: ${relativePath}`);
    }
    if (totalBytes + stat.size > GRADLE_INPUT_MAX_TOTAL_BYTES) {
      throw new Error(`Gradle input manifest exceeds ${GRADLE_INPUT_MAX_TOTAL_BYTES} total bytes`);
    }
    const hashed = hashSelectedFile(projectRealPath, realPath, stat, state);
    entries.push({ path: relativePath, bytes: hashed.bytes, sha256: hashed.sha256 });
    totalBytes += hashed.bytes;
  };

  const pending: Array<{ selectedPath: string; depth: number }> = [];
  let discoveredWork = 0;
  const pendingWorkLimit = GRADLE_INPUT_MAX_ENTRIES + limits.maxDirectories;
  const enqueue = (selectedPath: string, depth: number): void => {
    const relativePath = path.relative(projectRealPath, selectedPath).split(path.sep).join("/");
    if (isExcludedRecursiveSubtree(relativePath)) return;
    discoveredWork += 1;
    if (discoveredWork > pendingWorkLimit) {
      throw new Error(`Gradle input traversal exceeds the bounded ${pendingWorkLimit}-entry pending-work ceiling`);
    }
    pending.push({ selectedPath, depth });
  };
  for (const relativeRoot of [...RECURSIVE_ROOTS].reverse()) {
    const selectedRoot = path.join(projectRealPath, ...relativeRoot.split("/"));
    if (lstatIfPresent(selectedRoot)) enqueue(selectedRoot, 0);
  }
  while (pending.length) {
    const { selectedPath, depth } = pending.pop()!;
    const relativePath = path.relative(projectRealPath, selectedPath).split(path.sep).join("/");
    if (isDirectBuildSrcNonInputFilePath(relativePath) && !fs.lstatSync(selectedPath).isDirectory()) {
      continue;
    }
    const selected = validateSelectedPath(projectRealPath, selectedPath);
    if (selected.stat.isFile()) {
      addFile(selected.realPath);
      continue;
    }
    if (!selected.stat.isDirectory()) {
      throw new Error(`selected Gradle input is not a regular file or directory: ${selectedPath}`);
    }
    if (depth > limits.maxDepth) {
      throw new Error(`Gradle input directory depth exceeds the ${limits.maxDepth} depth ceiling: ${selectedPath}`);
    }
    directoryCount += 1;
    if (directoryCount > limits.maxDirectories) {
      throw new Error(`Gradle input directory count exceeds the ${limits.maxDirectories} directory ceiling`);
    }
    const before = lstatStable(selected.realPath);
    const directory = fs.opendirSync(selected.realPath);
    try {
      let child: fs.Dirent | null;
      while ((child = directory.readSync()) !== null) {
        enqueue(path.join(selected.realPath, child.name), depth + 1);
      }
    } finally {
      directory.closeSync();
    }
    const after = lstatStable(selected.realPath);
    if (!sameStableStat(before, after)) {
      throw new Error(`selected Gradle input directory changed while collecting: ${selectedPath}`);
    }
    if (state && !state.parentGenerations.has(selected.realPath)) {
      state.trackedDirectories.set(selected.realPath, before);
    }
  }

  for (const relativePath of ROOT_FILES) {
    const selectedPath = path.join(projectRealPath, ...relativePath.split("/"));
    if (lstatIfPresent(selectedPath)) addFile(selectedPath);
  }

  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assertGradleInputManifestPaths(entries);
  const manifestIdentity = canonicalIdentity(entries);
  return {
    schemaVersion: 1,
    projectDir: projectRealPath,
    algorithm: "sha256",
    sha256: manifestIdentity.sha256,
    entryCount: entries.length,
    totalBytes,
    entries,
  };
}

function generationGuard(state: GuardState): GradleInputGenerationGuard {
  const waitForWatcherQuiet = async (): Promise<boolean> => {
    let observedRevision = state.eventRevision;
    let quietTurns = 0;
    for (let turn = 0; turn < GRADLE_INPUT_WATCH_DRAIN_MAX_TURNS; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      if (state.eventRevision === observedRevision) {
        quietTurns += 1;
        if (quietTurns >= GRADLE_INPUT_WATCH_QUIET_TURNS) return true;
      } else {
        observedRevision = state.eventRevision;
        quietTurns = 0;
      }
    }
    return false;
  };

  const sealAndDrainWatchers = async (): Promise<string[]> => {
    const inconclusive: string[] = [];
    const isClassified = (generation: ParentGeneration): boolean => generation.selectedObserved
      || generation.excludedObserved
      || generation.ambiguousObserved;
    const changedUnclassifiedParents = (): ParentGeneration[] => [...state.parentGenerations]
      .filter(([directory, generation]) => {
        if (isClassified(generation)) return false;
        try {
          return !sameStableStat(generation.before, lstatStable(directory));
        } catch {
          return false;
        }
      })
      .map(([, generation]) => generation);
    const settleDeadline = process.hrtime.bigint()
      + BigInt(GRADLE_INPUT_WATCH_SETTLE_TIMEOUT_MS) * 1_000_000n;
    let observedRevision = state.eventRevision;
    let quietTurns = 0;
    let settled = false;
    while (process.hrtime.bigint() < settleDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, GRADLE_INPUT_WATCH_SETTLE_POLL_MS));
      if (state.eventRevision === observedRevision) quietTurns += 1;
      else {
        observedRevision = state.eventRevision;
        quietTurns = 0;
      }
      if (quietTurns >= GRADLE_INPUT_WATCH_QUIET_TURNS && changedUnclassifiedParents().length === 0) {
        settled = true;
        break;
      }
    }
    if (!settled) inconclusive.push("watcher callbacks did not settle before the bounded deadline");
    closeWatchers(state, true);
    if (!await waitForWatcherQuiet()) inconclusive.push("watcher callback drain did not quiesce after close");
    return inconclusive;
  };

  return {
    close: () => closeGuardState(state),
    assertUnchanged: async (): Promise<void> => {
      const inconclusive = await sealAndDrainWatchers();
      const issues: string[] = [];
      let issuesOmitted = false;
      const addIssue = (issue: string): void => {
        if (issues.length < GRADLE_INPUT_MAX_EVENT_SAMPLES) issues.push(issue);
        else issuesOmitted = true;
      };
      for (const event of state.definiteEventSamples) addIssue(`watcher integrity failure (${event})`);
      if (state.definiteEventsOmitted) addIssue("additional watcher integrity failures omitted");
      if (state.inconclusiveEventsOmitted) inconclusive.push("additional uncorroborated watcher callbacks omitted");
      for (const event of state.inconclusiveEventSamples) {
        inconclusive.push(`watcher callback without exact selected-path corroboration (${event})`);
      }
      for (const file of state.trackedFiles) {
        try {
          const after = stableStat(fs.fstatSync(file.descriptor, { bigint: true }));
          const current = validateSelectedPath(state.projectDir, file.path);
          const currentStable = stableStat(fs.lstatSync(current.realPath, { bigint: true }));
          if (!sameStableStat(file.before, after) || !sameStableStat(file.before, currentStable)) {
            addIssue(`selected file generation changed: ${path.relative(state.projectDir, file.path).split(path.sep).join("/")}`);
          }
        } catch (error) {
          addIssue(`selected file continuity could not be checked: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const [directory, before] of state.trackedDirectories) {
        try {
          if (!sameStableStat(before, lstatStable(directory))) {
            addIssue(`selected directory membership changed: ${path.relative(state.projectDir, directory).split(path.sep).join("/")}`);
          }
        } catch (error) {
          addIssue(`selected directory continuity could not be checked: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const [directory, parent] of state.parentGenerations) {
        try {
          if (!sameStableStat(parent.before, lstatStable(directory))) {
            const relativePath = path.relative(state.projectDir, directory).split(path.sep).join("/") || ".";
            inconclusive.push(`watched parent generation changed without exact selected-path corroboration: ${relativePath}`);
          }
        } catch (error) {
          addIssue(`watched parent continuity could not be checked: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (issuesOmitted) issues.push("additional Gradle input continuity issues omitted");
      if (issues.length) throw new Error(`Gradle input generation continuity failed: ${issues.join("; ")}`);
      if (inconclusive.length) {
        throw new GradleInputContinuityInconclusiveError(
          `Gradle input generation continuity was inconclusive: ${inconclusive.slice(0, GRADLE_INPUT_MAX_EVENT_SAMPLES).join("; ")}`,
        );
      }
    },
  };
}

/**
 * Collect and guard one input generation. Watchers are live before collection, the descriptors
 * used to hash selected files stay open, and directory generations come from that same bounded
 * iterative traversal.
 */
export function collectGuardedGradleInputIdentity(
  projectDir: string,
  options: GradleInputGuardOptions = {},
): { identity: GradleInputIdentity; guard: GradleInputGenerationGuard } {
  const projectRealPath = fs.realpathSync(path.resolve(projectDir));
  if (!fs.lstatSync(projectRealPath).isDirectory()) {
    throw new Error(`Gradle project is not a directory: ${projectRealPath}`);
  }
  const state = createGuardState(projectRealPath, options);
  try {
    const identity = collectGradleInputIdentityInternal(projectRealPath, options, state);
    return { identity, guard: generationGuard(state) };
  } catch (error) {
    closeGuardState(state);
    throw error;
  }
}

export function guardGradleInputGeneration(
  identity: GradleInputIdentity,
  options: GradleInputGuardOptions = {},
): GradleInputGenerationGuard {
  assertGradleInputManifestPaths(identity.entries);
  const guarded = collectGuardedGradleInputIdentity(identity.projectDir, options);
  if (canonicalJson(guarded.identity) !== canonicalJson(identity)) {
    guarded.guard.close();
    throw new Error("selected Gradle input changed while establishing continuity");
  }
  return guarded.guard;
}

export function collectGradleInputIdentity(projectDir: string): GradleInputIdentity {
  return collectGradleInputIdentityInternal(projectDir, {});
}
