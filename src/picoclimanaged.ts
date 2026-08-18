import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PICO_CLI_POLICY_ENV = "PICO_MCP_CLI_POLICY";
export const PICO_CLI_PATH_ENV = "PICO_MCP_CLI_PATH";
export const PICO_CLI_PACKAGE = "@picoxr/pico-cli";

const LEGACY_POLICY_ALIASES = ["PICO_MCP_AUTOINSTALL_CLI", "PICO_MCP_AUTOUPDATE_CLI"] as const;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1_000;
const ABANDONED_STAGING_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const STAGING_OWNER_FILE = "staging-owner.json";
const PUBLICATION_SETTLE_MS = 2_000;
const PUBLICATION_POLL_MS = 25;
const CONTENT_IDENTITY_SCHEMA_VERSION = 1;
const INSTALL_RECORD_SCHEMA_VERSION = 2;
const CONTENT_IDENTITY_EXCLUDED_ROOT_ENTRIES = new Set(["install.json", "publication.json"]);
const CONTENT_IDENTITY_MAX_ENTRIES = 100_000;
const CONTENT_IDENTITY_MAX_DEPTH = 128;
const CONTENT_IDENTITY_MAX_PATH_BYTES = 64 * 1024 * 1024;
const CONTENT_IDENTITY_MAX_FILE_BYTES = 256 * 1024 * 1024;
const CONTENT_IDENTITY_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const CONTENT_IDENTITY_READ_CHUNK_BYTES = 64 * 1024;
const EXECUTABLE_IDENTITY_MAX_FILE_BYTES = 32 * 1024 * 1024;
const CONTROL_RECORD_MAX_BYTES = 1024 * 1024;
const COMPATIBILITY_CANARIES = [
  ["perf", "monitor", "run", "--help"],
  ["perf", "trace", "record", "--help"],
  ["perf", "trace", "decode", "--help"],
  ["perf", "trace", "load", "--help"],
  ["perf", "trace", "query", "--help"],
  ["app", "watch-crash", "--help"],
  ["capture", "record", "--help"],
  ["mcp", "dev-knowledge", "--help"],
  ["emulator", "status", "--help"],
] as const;

export type PicoCliPolicy = "managed-latest" | "managed-cached" | "external" | "disabled";
export type PicoCliFreshness = "latest" | "outdated" | "unknown" | "cached" | "external";

export type ManagedPicoCliCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  outputTruncated: boolean;
};

export type ManagedPicoCliIO = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  /** Opaque identity of the executable that this IO will run for the `npm` command. */
  npmCommandIdentity: string;
  now: () => number;
  randomUUID: () => string;
  run: (command: string, args: string[], options?: {
    timeoutMs?: number;
    killGraceMs?: number;
    beforeSpawn?: (deadlineMs: number) => string | null;
    afterSpawn?: (deadlineMs: number) => string | null;
  }) => Promise<ManagedPicoCliCommandResult>;
};

export type ManagedPicoCliOptions = {
  managedRoot?: string;
  forceRefresh?: boolean;
  installTimeoutMs?: number;
  updateCheckTimeoutMs?: number;
  killGraceMs?: number;
};

export type PicoCliCompatibilityDiagnostic = {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  helpSha256: string;
};

export type PicoCliEnsureResult =
  | {
      status: "ok";
      source: "managed" | "external";
      policy: Exclude<PicoCliPolicy, "disabled">;
      action: "present" | "installed" | "updated" | "cached" | "external";
      path: string;
      version: string;
      raw: string;
      latestVersion: string | null;
      checkedAt: string | null;
      freshness: PicoCliFreshness;
      deprecatedAliases: string[];
      compatibility?: PicoCliCompatibilityDiagnostic[];
      warning?: {
        failureClass: "latest-unknown" | "update-failed";
        note: string;
        outputTail?: string;
      };
    }
  | {
      status: "unavailable";
      source: "managed" | "external" | null;
      policy: PicoCliPolicy | null;
      action: "skipped";
      path: string | null;
      version: null;
      raw: string;
      latestVersion: string | null;
      checkedAt: string | null;
      freshness: PicoCliFreshness | null;
      failureClass: "cli-disabled" | "cli-missing" | "cli-unusable" | "latest-unknown" | "configuration";
      note: string;
      deprecatedAliases: string[];
      outputTail?: string;
    };

declare const managedPicoCliExecutionHandleBrand: unique symbol;

/**
 * Opaque in-process capability bound to one validated managed publication. The identity bytes and
 * validator remain private to this module; consumers can only ask this module to revalidate it.
 */
export type ManagedPicoCliExecutionHandle = {
  readonly [managedPicoCliExecutionHandleBrand]: "managed-pico-cli-execution";
};

type ManagedContentIdentity = {
  schemaVersion: 1;
  algorithm: "sha256";
  digest: string;
  entryCount: number;
  totalBytes: number;
};

type ManagedContentBinding = {
  contentManifestSchemaVersion: 1;
  contentManifestSha256: string;
  contentManifestEntryCount: number;
  contentManifestTotalBytes: number;
};

type ManagedCliInstallRecord = ManagedContentBinding & {
  schemaVersion: 2;
  version: string;
  relativeCliPath: string;
  registryIntegrity: string | null;
  installedAt: string;
};

type ManagedStagingOwnerRecord = {
  schemaVersion: 1;
  kind: "pico-managed-staging";
  version: string;
  token: string;
  ownerPid: number;
  createdAt: string;
};

type ManagedPublicationRecord = ManagedContentBinding & {
  schemaVersion: 2;
  kind: "pico-managed-publication";
  version: string;
  registryIntegrity: string | null;
  token: string;
  ownerPid: number;
  createdAt: string;
};

type PicoCliPolicyResolution =
  | { status: "ok"; policy: PicoCliPolicy; externalPath: string | null; deprecatedAliases: string[] }
  | { status: "invalid"; policy: null; externalPath: null; deprecatedAliases: string[]; note: string };

type ValidatedManagedCli = {
  path: string;
  version: string;
  raw: string;
  compatibility?: PicoCliCompatibilityDiagnostic[];
  executionHandle?: ManagedPicoCliExecutionHandle;
  executionBinding: ManagedPicoCliExecutionBinding;
};

type RegistryLatest = {
  version: string;
  integrity: string | null;
  checkedAt: string;
  fetchedAt: number;
};

type RegistryLatestResolution =
  | { status: "ok"; latest: RegistryLatest }
  | { status: "failure"; checkedAt: string; note: string; outputTail?: string };

type ManagedPublicationIdentity = {
  device: number;
  inode: number;
  links: number;
  size: number;
  bytesSha256: string;
  token: string;
};

type ManagedPicoCliExecutionBinding = {
  versionRoot: string;
  cliPath: string;
  version: string;
  platform: NodeJS.Platform;
  registryIntegrity: string | null;
  contentIdentity: ManagedContentIdentity;
  executableIdentity: ManagedExecutableIdentity;
  publicationIdentity?: ManagedPublicationIdentity;
};

const managedExecutionBindings = new WeakMap<object, ManagedPicoCliExecutionBinding>();
const managedResultHandles = new WeakMap<object, ManagedPicoCliExecutionHandle>();
const registryLatestCache = new Map<string, RegistryLatest>();
const registryCacheIdentityKey = crypto.randomBytes(32);

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function pathApiFor(platform: NodeJS.Platform): typeof path {
  return platform === "win32" ? path.win32 : path;
}

function stableSemver(value: string): string | null {
  return STABLE_SEMVER.test(value) ? value : null;
}

function compareStableSemver(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < 3; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a.length !== b.length) return a.length > b.length ? 1 : -1;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

function invalidPolicy(note: string, deprecatedAliases: string[]): PicoCliPolicyResolution {
  return { status: "invalid", policy: null, externalPath: null, deprecatedAliases, note };
}

export function resolvePicoCliPolicy(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PicoCliPolicyResolution {
  const explicitValue = envValue(env, PICO_CLI_POLICY_ENV, platform);
  const externalPath = envValue(env, PICO_CLI_PATH_ENV, platform);
  const deprecatedAliases = LEGACY_POLICY_ALIASES.filter((name) => envValue(env, name, platform) === "1");
  const validPolicies: PicoCliPolicy[] = ["managed-latest", "managed-cached", "external", "disabled"];
  if (explicitValue !== undefined && !validPolicies.includes(explicitValue as PicoCliPolicy)) {
    return invalidPolicy(`${PICO_CLI_POLICY_ENV} must be managed-latest, managed-cached, external, or disabled.`, deprecatedAliases);
  }
  const policy = (explicitValue ?? "managed-latest") as PicoCliPolicy;
  if (deprecatedAliases.length > 0 && explicitValue !== undefined && policy !== "managed-latest") {
    return invalidPolicy(`${deprecatedAliases.join(" and ")}=1 conflicts with ${PICO_CLI_POLICY_ENV}=${policy}.`, deprecatedAliases);
  }
  if (policy === "external") {
    if (!externalPath || !pathApiFor(platform).isAbsolute(externalPath)) {
      return invalidPolicy(`${PICO_CLI_POLICY_ENV}=external requires an absolute ${PICO_CLI_PATH_ENV}.`, deprecatedAliases);
    }
    return { status: "ok", policy, externalPath, deprecatedAliases };
  }
  if (externalPath !== undefined) {
    return invalidPolicy(`${PICO_CLI_PATH_ENV} is valid only when ${PICO_CLI_POLICY_ENV}=external.`, deprecatedAliases);
  }
  return { status: "ok", policy, externalPath: null, deprecatedAliases };
}

function unavailable(
  policy: PicoCliPolicy | null,
  source: "managed" | "external" | null,
  failureClass: Extract<PicoCliEnsureResult, { status: "unavailable" }>["failureClass"],
  note: string,
  deprecatedAliases: string[],
  pathValue: string | null = null,
  raw = "",
  provenance: { latestVersion?: string | null; checkedAt?: string | null; outputTail?: string } = {},
): PicoCliEnsureResult {
  return {
    status: "unavailable", source, policy, action: "skipped", path: pathValue, version: null, raw,
    latestVersion: provenance.latestVersion ?? null,
    checkedAt: provenance.checkedAt ?? null,
    freshness: null,
    failureClass,
    note,
    deprecatedAliases,
    ...(provenance.outputTail ? { outputTail: provenance.outputTail } : {}),
  };
}

function sameObservedStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readBoundedRegularFileWithStat(
  file: string,
  maxBytes = CONTROL_RECORD_MAX_BYTES,
): { bytes: Buffer; stat: fs.Stats } | null {
  let descriptor: number | undefined;
  try {
    const pathStat = fs.lstatSync(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size < 0 || pathStat.size > maxBytes) return null;
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !sameObservedStat(pathStat, before)) return null;
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    return sameObservedStat(before, after) ? { bytes, stat: before } : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* the read already failed closed */ }
    }
  }
}

function readBoundedRegularFile(file: string, maxBytes = CONTROL_RECORD_MAX_BYTES): Buffer | null {
  return readBoundedRegularFileWithStat(file, maxBytes)?.bytes ?? null;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

type ManagedContentManifestPath = {
  absolutePath: string;
  relativePath: string;
};

type ManagedContentIdentityLimits = {
  maxEntries: number;
  maxDepth: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

const DEFAULT_CONTENT_IDENTITY_LIMITS: ManagedContentIdentityLimits = {
  maxEntries: CONTENT_IDENTITY_MAX_ENTRIES,
  maxDepth: CONTENT_IDENTITY_MAX_DEPTH,
  maxPathBytes: CONTENT_IDENTITY_MAX_PATH_BYTES,
  maxFileBytes: CONTENT_IDENTITY_MAX_FILE_BYTES,
  maxTotalBytes: CONTENT_IDENTITY_MAX_TOTAL_BYTES,
};

function collectManagedContentPaths(
  versionRoot: string,
  realRoot: string,
  limits: ManagedContentIdentityLimits,
  deadlineMs = Number.POSITIVE_INFINITY,
): ManagedContentManifestPath[] {
  const discovered: ManagedContentManifestPath[] = [];
  const pending: Array<ManagedContentManifestPath & { depth: number }> = [{
    absolutePath: versionRoot,
    relativePath: ".",
    depth: 0,
  }];
  let pathBytes = Buffer.byteLength(".", "utf8");
  while (pending.length > 0) {
    if (Date.now() >= deadlineMs) throw new Error("managed content identity check exhausted its deadline");
    const current = pending.pop() as ManagedContentManifestPath & { depth: number };
    const before = fs.lstatSync(current.absolutePath);
    const currentRealPath = fs.realpathSync(current.absolutePath);
    if (!pathIsWithin(realRoot, currentRealPath)) throw new Error(`managed content path escaped its version root: ${current.relativePath}`);
    discovered.push({ absolutePath: current.absolutePath, relativePath: current.relativePath });
    if (discovered.length > limits.maxEntries || pathBytes > limits.maxPathBytes) {
      throw new Error("managed content manifest exceeded its path or entry bound");
    }
    if (!before.isDirectory() || before.isSymbolicLink()) continue;

    const children: Array<{ name: string; relativePath: string }> = [];
    const directory = fs.opendirSync(current.absolutePath);
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (current.relativePath === "." && CONTENT_IDENTITY_EXCLUDED_ROOT_ENTRIES.has(entry.name)) continue;
        const relativePath = current.relativePath === "." ? entry.name : `${current.relativePath}/${entry.name}`;
        pathBytes += Buffer.byteLength(relativePath, "utf8");
        if (pathBytes > limits.maxPathBytes) {
          throw new Error("managed content manifest exceeded its path bound");
        }
        children.push({ name: entry.name, relativePath });
        if (discovered.length + pending.length + children.length > limits.maxEntries) {
          throw new Error("managed content manifest exceeded its entry bound");
        }
      }
    } finally {
      directory.closeSync();
    }
    const after = fs.lstatSync(current.absolutePath);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameObservedStat(before, after)) {
      throw new Error(`managed content directory changed during traversal: ${current.relativePath}`);
    }
    if (children.length > 0 && current.depth >= limits.maxDepth) {
      throw new Error("managed content manifest exceeded its depth bound");
    }
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      pending.push({
        absolutePath: path.join(current.absolutePath, child.name),
        relativePath: child.relativePath,
        depth: current.depth + 1,
      });
    }
  }
  discovered.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return discovered;
}

function updateContentManifestHeader(hash: crypto.Hash, value: Record<string, string | number>): void {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  hash.update(Buffer.from(`${bytes.length}:`, "ascii"));
  hash.update(bytes);
  hash.update(Buffer.from([0]));
}

/**
 * Test-fixture support for publishing a cache tree that obeys the production content-binding
 * contract. Production callers should use resolveManagedPicoCli rather than constructing records.
 */
export function managedContentIdentityForFixture(
  versionRootValue: string,
  limitOverrides: Partial<ManagedContentIdentityLimits> = {},
  deadlineMs = Number.POSITIVE_INFINITY,
): ManagedContentIdentity {
  if (Date.now() >= deadlineMs) throw new Error("managed content identity check exhausted its deadline");
  const limits = { ...DEFAULT_CONTENT_IDENTITY_LIMITS, ...limitOverrides };
  for (const [name, value] of Object.entries(limits)) {
    const ceiling = DEFAULT_CONTENT_IDENTITY_LIMITS[name as keyof ManagedContentIdentityLimits];
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw new Error(`managed content identity ${name} must be a positive safe integer no larger than ${ceiling}`);
    }
  }
  const versionRoot = path.resolve(versionRootValue);
  const rootStat = fs.lstatSync(versionRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("managed version root was not a real directory");
  const realRoot = fs.realpathSync(versionRoot);
  const entries = collectManagedContentPaths(versionRoot, realRoot, limits, deadlineMs);
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(CONTENT_IDENTITY_READ_CHUNK_BYTES);
  let totalBytes = 0;

  for (const entry of entries) {
    if (Date.now() >= deadlineMs) throw new Error("managed content identity check exhausted its deadline");
    const before = fs.lstatSync(entry.absolutePath);
    const mode = (before.mode & 0o7777).toString(8).padStart(4, "0");
    const currentRealPath = fs.realpathSync(entry.absolutePath);
    if (!pathIsWithin(realRoot, currentRealPath)) throw new Error(`managed content path escaped its version root: ${entry.relativePath}`);
    if (before.isDirectory() && !before.isSymbolicLink()) {
      updateContentManifestHeader(hash, { path: entry.relativePath, type: "directory", mode });
      continue;
    }
    if (before.isSymbolicLink()) {
      const targetBytes = fs.readlinkSync(entry.absolutePath, { encoding: "buffer" });
      const target = targetBytes.toString("utf8");
      if (!Buffer.from(target, "utf8").equals(targetBytes)) throw new Error(`managed symlink target was not UTF-8: ${entry.relativePath}`);
      const lexicalTarget = path.resolve(path.dirname(entry.absolutePath), target);
      if (!pathIsWithin(versionRoot, lexicalTarget) || !pathIsWithin(realRoot, currentRealPath)) {
        throw new Error(`managed symlink target escaped its version root: ${entry.relativePath}`);
      }
      totalBytes += targetBytes.length;
      if (totalBytes > limits.maxTotalBytes) throw new Error("managed content manifest exceeded its byte bound");
      updateContentManifestHeader(hash, {
        path: entry.relativePath,
        type: "symlink",
        mode,
        links: before.nlink,
        targetBytes: targetBytes.toString("base64"),
      });
      const after = fs.lstatSync(entry.absolutePath);
      if (!after.isSymbolicLink() || !sameObservedStat(before, after)) {
        throw new Error(`managed symlink changed during hashing: ${entry.relativePath}`);
      }
      continue;
    }
    if (!before.isFile() || before.size < 0 || before.size > limits.maxFileBytes) {
      throw new Error(`managed content entry was unsupported or oversized: ${entry.relativePath}`);
    }
    totalBytes += before.size;
    if (totalBytes > limits.maxTotalBytes) throw new Error("managed content manifest exceeded its byte bound");
    const fileHash = crypto.createHash("sha256");
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(entry.absolutePath, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || !sameObservedStat(before, opened)) {
        throw new Error(`managed content file identity changed before hashing: ${entry.relativePath}`);
      }
      let offset = 0;
      while (offset < opened.size) {
        if (Date.now() >= deadlineMs) throw new Error("managed content identity check exhausted its deadline");
        const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
        if (count <= 0) throw new Error(`managed content file ended during hashing: ${entry.relativePath}`);
        fileHash.update(chunk.subarray(0, count));
        offset += count;
      }
      const after = fs.fstatSync(descriptor);
      if (!sameObservedStat(opened, after)) throw new Error(`managed content file changed during hashing: ${entry.relativePath}`);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    updateContentManifestHeader(hash, {
      path: entry.relativePath,
      type: "file",
      mode,
      links: before.nlink,
      size: before.size,
      contentSha256: fileHash.digest("hex"),
    });
  }

  const afterEntries = collectManagedContentPaths(versionRoot, realRoot, limits, deadlineMs).map((entry) => entry.relativePath);
  if (entries.length !== afterEntries.length
    || entries.some((entry, index) => entry.relativePath !== afterEntries[index])) {
    throw new Error("managed content paths changed during hashing");
  }
  return {
    schemaVersion: CONTENT_IDENTITY_SCHEMA_VERSION,
    algorithm: "sha256",
    digest: hash.digest("hex"),
    entryCount: entries.length,
    totalBytes,
  };
}

const managedContentIdentity = managedContentIdentityForFixture;

function contentBinding(identity: ManagedContentIdentity): ManagedContentBinding {
  return {
    contentManifestSchemaVersion: identity.schemaVersion,
    contentManifestSha256: identity.digest,
    contentManifestEntryCount: identity.entryCount,
    contentManifestTotalBytes: identity.totalBytes,
  };
}

function validManagedContentBinding(value: Partial<ManagedContentBinding>): value is ManagedContentBinding {
  return value.contentManifestSchemaVersion === CONTENT_IDENTITY_SCHEMA_VERSION
    && typeof value.contentManifestSha256 === "string" && /^[a-f0-9]{64}$/.test(value.contentManifestSha256)
    && typeof value.contentManifestEntryCount === "number" && Number.isSafeInteger(value.contentManifestEntryCount)
    && value.contentManifestEntryCount > 0 && value.contentManifestEntryCount <= CONTENT_IDENTITY_MAX_ENTRIES
    && typeof value.contentManifestTotalBytes === "number" && Number.isSafeInteger(value.contentManifestTotalBytes)
    && value.contentManifestTotalBytes >= 0 && value.contentManifestTotalBytes <= CONTENT_IDENTITY_MAX_TOTAL_BYTES;
}

function contentIdentityFromBinding(binding: ManagedContentBinding): ManagedContentIdentity {
  return {
    schemaVersion: binding.contentManifestSchemaVersion,
    algorithm: "sha256",
    digest: binding.contentManifestSha256,
    entryCount: binding.contentManifestEntryCount,
    totalBytes: binding.contentManifestTotalBytes,
  };
}

function sameManagedContentIdentity(left: ManagedContentIdentity, right: ManagedContentIdentity): boolean {
  return left.schemaVersion === right.schemaVersion && left.algorithm === right.algorithm
    && left.digest === right.digest && left.entryCount === right.entryCount && left.totalBytes === right.totalBytes;
}

type ManagedExecutableIdentity = {
  canonicalType: "file" | "symlink";
  canonicalMode: string;
  canonicalLinks: number;
  canonicalSize: number;
  canonicalTargetBase64: string | null;
  realRelativePath: string;
  realMode: string;
  realLinks: number;
  realSize: number;
  realContentSha256: string;
};

function executableFileIdentity(file: string, deadlineMs: number): {
  mode: string;
  links: number;
  size: number;
  contentSha256: string;
} {
  if (Date.now() >= deadlineMs) throw new Error("managed executable identity check exhausted its deadline");
  const pathStat = fs.lstatSync(file);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size < 0
    || pathStat.size > EXECUTABLE_IDENTITY_MAX_FILE_BYTES) {
    throw new Error("managed executable target was not a bounded regular file");
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameObservedStat(pathStat, opened)) {
      throw new Error("managed executable target changed before hashing");
    }
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(CONTENT_IDENTITY_READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      if (Date.now() >= deadlineMs) throw new Error("managed executable identity check exhausted its deadline");
      const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (count <= 0) throw new Error("managed executable target ended during hashing");
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (!sameObservedStat(opened, after)) throw new Error("managed executable target changed during hashing");
    return {
      mode: (opened.mode & 0o7777).toString(8).padStart(4, "0"),
      links: opened.nlink,
      size: opened.size,
      contentSha256: hash.digest("hex"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function managedExecutableIdentity(
  versionRoot: string,
  cliPath: string,
  version: string,
  platform: NodeJS.Platform,
  deadlineMs = Number.POSITIVE_INFINITY,
): ManagedExecutableIdentity {
  if (Date.now() >= deadlineMs) throw new Error("managed executable identity check exhausted its deadline");
  const realRoot = fs.realpathSync(versionRoot);
  const canonical = fs.lstatSync(cliPath);
  if ((!canonical.isFile() && !canonical.isSymbolicLink()) || packageVersion(versionRoot) !== version) {
    throw new Error("managed executable shim or package identity was invalid");
  }
  const canonicalTarget = canonical.isSymbolicLink()
    ? fs.readlinkSync(cliPath, { encoding: "buffer" })
    : null;
  const realCliPath = fs.realpathSync(cliPath);
  if (!pathIsWithin(realRoot, realCliPath)) throw new Error("managed executable escaped its version root");
  const realFile = executableFileIdentity(realCliPath, deadlineMs);
  const afterCanonical = fs.lstatSync(cliPath);
  if (!sameObservedStat(canonical, afterCanonical)) throw new Error("managed executable shim changed during identity capture");
  if (platform !== "win32") fs.accessSync(cliPath, fs.constants.X_OK);
  return {
    canonicalType: canonical.isSymbolicLink() ? "symlink" : "file",
    canonicalMode: (canonical.mode & 0o7777).toString(8).padStart(4, "0"),
    canonicalLinks: canonical.nlink,
    canonicalSize: canonical.size,
    canonicalTargetBase64: canonicalTarget?.toString("base64") ?? null,
    realRelativePath: path.relative(realRoot, realCliPath).split(path.sep).join("/"),
    realMode: realFile.mode,
    realLinks: realFile.links,
    realSize: realFile.size,
    realContentSha256: realFile.contentSha256,
  };
}

function managedExecutableGuard(
  versionRoot: string,
  cliPath: string,
  version: string,
  expectedIdentity: ManagedExecutableIdentity,
  platform: NodeJS.Platform,
  deadlineMs: number,
): string | null {
  try {
    const observedIdentity = managedExecutableIdentity(versionRoot, cliPath, version, platform, deadlineMs);
    return JSON.stringify(observedIdentity) === JSON.stringify(expectedIdentity)
      ? null
      : "managed pico-cli executable identity changed before process execution";
  } catch (error) {
    return `managed pico-cli executable identity check could not complete: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function readInstallRecord(versionRoot: string): ManagedCliInstallRecord | null {
  try {
    const bytes = readBoundedRegularFile(path.join(versionRoot, "install.json"));
    if (!bytes) return null;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    if (keys.join("\0") !== [
      "contentManifestEntryCount", "contentManifestSchemaVersion", "contentManifestSha256",
      "contentManifestTotalBytes", "installedAt", "registryIntegrity", "relativeCliPath", "schemaVersion", "version",
    ].join("\0")) return null;
    const record = parsed as Partial<ManagedCliInstallRecord>;
    const installedAtMs = typeof record.installedAt === "string" ? Date.parse(record.installedAt) : Number.NaN;
    if (record.schemaVersion !== INSTALL_RECORD_SCHEMA_VERSION
      || typeof record.version !== "string" || typeof record.relativeCliPath !== "string"
      || (record.registryIntegrity !== null && typeof record.registryIntegrity !== "string")
      || !Number.isFinite(installedAtMs) || new Date(installedAtMs).toISOString() !== record.installedAt
      || !validManagedContentBinding(record)) return null;
    return record as ManagedCliInstallRecord;
  } catch {
    return null;
  }
}

function managedShimPath(versionRoot: string, relativeCliPath: string, platform: NodeJS.Platform): string | null {
  const pathApi = pathApiFor(platform);
  if (!relativeCliPath || path.posix.isAbsolute(relativeCliPath) || path.win32.isAbsolute(relativeCliPath)
    || relativeCliPath.split(/[\\/]+/).some((part) => !part || part === "..")) return null;
  const resolvedRoot = pathApi.resolve(versionRoot);
  const absolute = pathApi.resolve(resolvedRoot, relativeCliPath);
  const rootPrefix = resolvedRoot.endsWith(pathApi.sep) ? resolvedRoot : `${resolvedRoot}${pathApi.sep}`;
  return absolute.startsWith(rootPrefix) ? absolute : null;
}

function canonicalRelativeCliPath(platform: NodeJS.Platform): string {
  const pathApi = pathApiFor(platform);
  return pathApi.join("node_modules", ".bin", platform === "win32" ? "pico-cli.cmd" : "pico-cli");
}

function packageVersion(versionRoot: string): string | null {
  try {
    const bytes = readBoundedRegularFile(path.join(versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json"));
    if (!bytes) return null;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const packageJson = parsed as { name?: unknown; version?: unknown };
    return packageJson.name === PICO_CLI_PACKAGE && typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function outputOf(result: ManagedPicoCliCommandResult): string {
  return `${result.stdout}${result.stderr}`.trim();
}

function versionFromOutput(raw: string): string | null {
  const match = raw.match(/pico-cli\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?=\s|$)/);
  return match ? match[0].slice("pico-cli/".length) : null;
}

function readCompatibility(versionRoot: string, version: string): PicoCliCompatibilityDiagnostic[] | undefined {
  try {
    const bytes = readBoundedRegularFile(path.join(versionRoot, "compatibility.json"));
    if (!bytes) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as { schemaVersion?: unknown; version?: unknown; diagnostics?: unknown };
    if (record.schemaVersion !== 1 || record.version !== version || !Array.isArray(record.diagnostics)) return undefined;
    const diagnostics: PicoCliCompatibilityDiagnostic[] = [];
    for (const item of record.diagnostics) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const diagnostic = item as Partial<PicoCliCompatibilityDiagnostic>;
      if (!Array.isArray(diagnostic.argv) || !diagnostic.argv.every((arg) => typeof arg === "string")
        || (diagnostic.exitCode !== null && typeof diagnostic.exitCode !== "number")
        || typeof diagnostic.timedOut !== "boolean" || typeof diagnostic.outputTruncated !== "boolean"
        || typeof diagnostic.helpSha256 !== "string") return undefined;
      diagnostics.push(diagnostic as PicoCliCompatibilityDiagnostic);
    }
    return diagnostics;
  } catch {
    return undefined;
  }
}

async function validateManagedVersion(
  versionRoot: string,
  version: string,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<ValidatedManagedCli | null> {
  const record = readInstallRecord(versionRoot);
  const relativeCliPath = canonicalRelativeCliPath(io.platform);
  if (!record || record.version !== version || stableSemver(record.version) === null
    || record.relativeCliPath !== relativeCliPath) return null;
  const cliPath = managedShimPath(versionRoot, record.relativeCliPath, io.platform);
  if (!cliPath) return null;
  const recordedContentIdentity = contentIdentityFromBinding(record);
  let observedContentIdentity: ManagedContentIdentity;
  let executableIdentity: ManagedExecutableIdentity;
  try {
    observedContentIdentity = managedContentIdentity(versionRoot);
    if (!sameManagedContentIdentity(observedContentIdentity, recordedContentIdentity)) return null;
    executableIdentity = managedExecutableIdentity(versionRoot, cliPath, version, io.platform);
  } catch {
    return null;
  }
  const executionGuard = (deadlineMs: number) => managedExecutableGuard(
    versionRoot,
    cliPath,
    version,
    executableIdentity,
    io.platform,
    deadlineMs,
  );
  const command = await io.run(cliPath, ["-v"], {
    timeoutMs: options.installTimeoutMs,
    killGraceMs: options.killGraceMs,
    beforeSpawn: executionGuard,
    afterSpawn: executionGuard,
  });
  const raw = outputOf(command);
  if (command.code !== 0 || command.timedOut || command.spawnError || versionFromOutput(raw) !== version) return null;
  const compatibility = readCompatibility(versionRoot, version);
  try {
    observedContentIdentity = managedContentIdentity(versionRoot);
    if (!sameManagedContentIdentity(observedContentIdentity, recordedContentIdentity)) return null;
  } catch {
    return null;
  }
  return {
    path: cliPath,
    version,
    raw,
    ...(compatibility ? { compatibility } : {}),
    executionBinding: {
      versionRoot,
      cliPath,
      version,
      platform: io.platform,
      registryIntegrity: record.registryIntegrity,
      contentIdentity: observedContentIdentity,
      executableIdentity,
    },
  };
}

function hasCompleteCompatibility(diagnostics: PicoCliCompatibilityDiagnostic[] | undefined): boolean {
  if (!diagnostics || diagnostics.length !== COMPATIBILITY_CANARIES.length) return false;
  const expected = new Set(COMPATIBILITY_CANARIES.map((argv) => JSON.stringify(argv)));
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify(diagnostic.argv);
    if (!expected.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
}

async function validateLatestPublishedVersion(
  versionRoot: string,
  version: string,
  registryIntegrity: string | null,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<ValidatedManagedCli | null> {
  const record = readInstallRecord(versionRoot);
  if (!record || record.registryIntegrity !== registryIntegrity) return null;
  if (!validatePublicationState(versionRoot, version, registryIntegrity)) return null;
  const validated = await validateManagedVersion(versionRoot, version, options, io);
  return validated && hasCompleteCompatibility(validated.compatibility)
    && validatePublicationState(versionRoot, version, registryIntegrity) ? bindManagedExecution(validated) : null;
}

async function validateOwnedUnfinalizedVersion(
  versionRoot: string,
  version: string,
  registryIntegrity: string | null,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<ValidatedManagedCli | null> {
  const record = readInstallRecord(versionRoot);
  if (!record || record.registryIntegrity !== registryIntegrity) return null;
  const validated = await validateManagedVersion(versionRoot, version, options, io);
  return validated && hasCompleteCompatibility(validated.compatibility) ? validated : null;
}

async function validateCachedPublishedVersion(
  versionRoot: string,
  version: string,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<ValidatedManagedCli | null> {
  const record = readInstallRecord(versionRoot);
  if (!record || !validatePublicationState(versionRoot, version, record.registryIntegrity)) return null;
  const validated = await validateManagedVersion(versionRoot, version, options, io);
  return validated && validatePublicationState(versionRoot, version, record.registryIntegrity)
    ? bindManagedExecution(validated)
    : null;
}

function publishedVersions(versionsRoot: string): string[] {
  try {
    return fs.readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && stableSemver(entry.name) !== null)
      .map((entry) => entry.name)
      .sort((left, right) => compareStableSemver(right, left));
  } catch {
    return [];
  }
}

function managedOk(
  validated: ValidatedManagedCli,
  policy: "managed-latest" | "managed-cached",
  action: "present" | "installed" | "updated" | "cached",
  latestVersion: string | null,
  checkedAt: string | null,
  freshness: "latest" | "cached",
  deprecatedAliases: string[],
): PicoCliEnsureResult {
  if (!validated.executionHandle) throw new Error("managed pico-cli result lacked its execution binding");
  const result: PicoCliEnsureResult = {
    status: "ok", source: "managed", policy, action, path: validated.path, version: validated.version,
    raw: validated.raw, latestVersion, checkedAt, freshness, deprecatedAliases,
    ...(validated.compatibility ? { compatibility: validated.compatibility } : {}),
  };
  managedResultHandles.set(result, validated.executionHandle);
  return result;
}

function commandOutputTail(result: ManagedPicoCliCommandResult): string | undefined {
  const output = [result.stdout, result.stderr, result.spawnError].filter((part) => part && part.trim()).join("\n").trim();
  return output ? output.slice(-4_000) : undefined;
}

function managedFallback(
  cached: ValidatedManagedCli,
  knownLatest: string | null,
  checkedAt: string,
  note: string,
  outputTail: string | undefined,
  deprecatedAliases: string[],
): PicoCliEnsureResult {
  if (!cached.executionHandle) throw new Error("managed pico-cli fallback lacked its execution binding");
  const result: PicoCliEnsureResult = {
    status: "ok",
    source: "managed",
    policy: "managed-latest",
    action: "cached",
    path: cached.path,
    version: cached.version,
    raw: cached.raw,
    latestVersion: knownLatest,
    checkedAt,
    freshness: knownLatest ? "outdated" : "unknown",
    deprecatedAliases,
    ...(cached.compatibility ? { compatibility: cached.compatibility } : {}),
    warning: {
      failureClass: knownLatest ? "update-failed" : "latest-unknown",
      note,
      ...(outputTail ? { outputTail } : {}),
    },
  };
  managedResultHandles.set(result, cached.executionHandle);
  return result;
}

async function newestValidatedVersion(
  versionsRoot: string,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
  accept: (version: string) => boolean = () => true,
): Promise<ValidatedManagedCli | null> {
  for (const version of publishedVersions(versionsRoot)) {
    if (!accept(version)) continue;
    const validated = await validateCachedPublishedVersion(path.join(versionsRoot, version), version, options, io);
    if (validated) return validated;
  }
  return null;
}

function readStagingOwner(recordPath: string): {
  record: ManagedStagingOwnerRecord;
  bytes: Buffer;
  stat: fs.Stats;
  createdAtMs: number;
} | null {
  try {
    const bounded = readBoundedRegularFileWithStat(recordPath);
    if (!bounded) return null;
    const { bytes, stat } = bounded;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    if (keys.join("\0") !== ["createdAt", "kind", "ownerPid", "schemaVersion", "token", "version"].join("\0")) return null;
    const record = parsed as Partial<ManagedStagingOwnerRecord>;
    const createdAtMs = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN;
    if (record.schemaVersion !== 1 || record.kind !== "pico-managed-staging"
      || typeof record.version !== "string" || stableSemver(record.version) === null
      || typeof record.token !== "string" || record.token.length === 0 || record.token.length > 256
      || typeof record.ownerPid !== "number" || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0
      || !Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== record.createdAt) return null;
    return { record: record as ManagedStagingOwnerRecord, bytes, stat, createdAtMs };
  } catch {
    return null;
  }
}

function readPublicationRecord(recordPath: string): { record: ManagedPublicationRecord; stat: fs.Stats; bytes: Buffer } | null {
  try {
    const bounded = readBoundedRegularFileWithStat(recordPath);
    if (!bounded) return null;
    const { bytes, stat } = bounded;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    if (keys.join("\0") !== [
      "contentManifestEntryCount", "contentManifestSchemaVersion", "contentManifestSha256",
      "contentManifestTotalBytes", "createdAt", "kind", "ownerPid", "registryIntegrity",
      "schemaVersion", "token", "version",
    ].join("\0")) return null;
    const record = parsed as Partial<ManagedPublicationRecord>;
    const createdAt = record.createdAt;
    const createdAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    if (record.schemaVersion !== 2 || record.kind !== "pico-managed-publication"
      || typeof record.version !== "string" || stableSemver(record.version) === null
      || (record.registryIntegrity !== null && typeof record.registryIntegrity !== "string")
      || typeof record.token !== "string" || record.token.length === 0 || record.token.length > 256
      || typeof record.ownerPid !== "number" || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0
      || !validManagedContentBinding(record)
      || !Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) return null;
    return { record: record as ManagedPublicationRecord, stat, bytes };
  } catch {
    return null;
  }
}

function pathEntryExists(entryPath: string): boolean {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

function publicationRecordMatches(
  candidate: { record: ManagedPublicationRecord },
  version: string,
  registryIntegrity: string | null,
  contentIdentity: ManagedContentIdentity,
): boolean {
  return candidate.record.version === version && candidate.record.registryIntegrity === registryIntegrity
    && sameManagedContentIdentity(contentIdentityFromBinding(candidate.record), contentIdentity);
}

function validatedPublicationIdentity(
  versionRoot: string,
  version: string,
  registryIntegrity: string | null,
): ManagedPublicationIdentity | null {
  const install = readInstallRecord(versionRoot);
  if (!install) return null;
  const contentIdentity = contentIdentityFromBinding(install);
  const publicationPath = path.join(versionRoot, "publication.json");
  const claimPath = path.join(path.dirname(versionRoot), `.${version}.publish`);
  const claimExists = pathEntryExists(claimPath);
  const publicationExists = pathEntryExists(publicationPath);
  if (!claimExists || !publicationExists) return null;
  const publication = publicationExists ? readPublicationRecord(publicationPath) : null;
  if (!publication || !publicationRecordMatches(publication, version, registryIntegrity, contentIdentity)) return null;
  const claim = readPublicationRecord(claimPath);
  if (claim === null || !publicationRecordMatches(claim, version, registryIntegrity, contentIdentity)
    || claim.stat.dev !== publication.stat.dev || claim.stat.ino !== publication.stat.ino
    || claim.record.token !== publication.record.token || !claim.bytes.equals(publication.bytes)) return null;
  return {
    device: publication.stat.dev,
    inode: publication.stat.ino,
    links: publication.stat.nlink,
    size: publication.stat.size,
    bytesSha256: crypto.createHash("sha256").update(publication.bytes).digest("hex"),
    token: publication.record.token,
  };
}

function validatePublicationState(versionRoot: string, version: string, registryIntegrity: string | null): boolean {
  return validatedPublicationIdentity(versionRoot, version, registryIntegrity) !== null;
}

function sameManagedPublicationIdentity(
  left: ManagedPublicationIdentity,
  right: ManagedPublicationIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.links === right.links
    && left.size === right.size && left.bytesSha256 === right.bytesSha256 && left.token === right.token;
}

function bindManagedExecution(validated: ValidatedManagedCli): ValidatedManagedCli | null {
  const publicationIdentity = validatedPublicationIdentity(
    validated.executionBinding.versionRoot,
    validated.version,
    validated.executionBinding.registryIntegrity,
  );
  if (!publicationIdentity) return null;
  const token = Object.freeze(Object.create(null)) as ManagedPicoCliExecutionHandle;
  managedExecutionBindings.set(token, { ...validated.executionBinding, publicationIdentity });
  return { ...validated, executionHandle: token };
}

/** Return the opaque execution capability attached to an in-process managed resolver result. */
export function managedPicoCliExecutionHandle(result: PicoCliEnsureResult): ManagedPicoCliExecutionHandle | null {
  return result.status === "ok" && result.source === "managed"
    ? managedResultHandles.get(result) ?? null
    : null;
}

/**
 * Revalidate the complete content binding plus exact publication and executable snapshots. The
 * caller supplies its command deadline so a managed launch fails closed when validation exhausts
 * the remaining budget.
 */
export function validateManagedPicoCliExecution(
  handle: ManagedPicoCliExecutionHandle,
  deadlineMs: number,
): string | null {
  const binding = managedExecutionBindings.get(handle);
  if (!binding) return "managed pico-cli execution handle was missing or did not originate from this resolver process";
  try {
    if (Date.now() >= deadlineMs) throw new Error("managed publication identity check exhausted its deadline");
    const record = readInstallRecord(binding.versionRoot);
    if (!record || record.version !== binding.version || record.registryIntegrity !== binding.registryIntegrity
      || !sameManagedContentIdentity(contentIdentityFromBinding(record), binding.contentIdentity)) {
      throw new Error("managed install record changed after resolution");
    }
    const beforePublication = validatedPublicationIdentity(
      binding.versionRoot,
      binding.version,
      binding.registryIntegrity,
    );
    if (!beforePublication || !binding.publicationIdentity
      || !sameManagedPublicationIdentity(beforePublication, binding.publicationIdentity)) {
      throw new Error("managed publication identity changed after resolution");
    }
    const contentIdentity = managedContentIdentity(binding.versionRoot, {}, deadlineMs);
    if (!sameManagedContentIdentity(contentIdentity, binding.contentIdentity)) {
      throw new Error("managed publication content changed after resolution");
    }
    const executableIdentity = managedExecutableIdentity(
      binding.versionRoot,
      binding.cliPath,
      binding.version,
      binding.platform,
      deadlineMs,
    );
    if (JSON.stringify(executableIdentity) !== JSON.stringify(binding.executableIdentity)) {
      throw new Error("managed pico-cli executable identity changed after resolution");
    }
    const afterPublication = validatedPublicationIdentity(
      binding.versionRoot,
      binding.version,
      binding.registryIntegrity,
    );
    if (!afterPublication || !sameManagedPublicationIdentity(afterPublication, binding.publicationIdentity)) {
      throw new Error("managed publication identity changed during execution validation");
    }
    if (Date.now() >= deadlineMs) throw new Error("managed publication identity check exhausted its deadline");
    return null;
  } catch (error) {
    return `managed pico-cli publication identity could not be revalidated: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function ownerPidIsDefinitelyDead(ownerPid: number): boolean {
  if (ownerPid === process.pid) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

function cleanupAbandonedStaging(stagingRoot: string, now: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".cleanup-")) continue;
    const candidate = path.join(stagingRoot, entry.name);
    try {
      const candidateStat = fs.lstatSync(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) continue;
      const owner = readStagingOwner(path.join(candidate, STAGING_OWNER_FILE));
      if (!owner || now - owner.createdAtMs <= ABANDONED_STAGING_AGE_MS
        || !ownerPidIsDefinitelyDead(owner.record.ownerPid)) continue;

      const cleanupPath = path.join(stagingRoot, `.cleanup-${process.pid}-${crypto.randomUUID()}`);
      fs.renameSync(candidate, cleanupPath);
      const movedStat = fs.lstatSync(cleanupPath);
      const movedOwner = readStagingOwner(path.join(cleanupPath, STAGING_OWNER_FILE));
      const sameDirectory = movedStat.dev === candidateStat.dev && movedStat.ino === candidateStat.ino;
      const sameOwner = movedOwner !== null
        && movedOwner.stat.dev === owner.stat.dev && movedOwner.stat.ino === owner.stat.ino
        && movedOwner.record.token === owner.record.token && movedOwner.bytes.equals(owner.bytes);
      if (!sameDirectory || !sameOwner) continue;
      // Node cannot bind recursive deletion to the verified directory identity. The unique
      // quarantine is the terminal automatic action; retained entries require manual recovery.
    } catch {
      // Another resolver may own or have moved this staging entry; never broaden cleanup.
    }
  }
}

function opaqueRegistryEnvironmentIdentity(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const entries = Object.entries(env)
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value ?? null] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey < rightKey
      ? -1
      : leftKey > rightKey
        ? 1
        : String(leftValue).localeCompare(String(rightValue)));
  return crypto.createHmac("sha256", registryCacheIdentityKey)
    .update(JSON.stringify(entries), "utf8")
    .digest("hex");
}

function registryLatestCacheKey(io: ManagedPicoCliIO): string {
  return JSON.stringify([
    io.platform,
    opaqueRegistryEnvironmentIdentity(io.env, io.platform),
    io.npmCommandIdentity,
  ]);
}

async function resolveRegistryLatest(
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<RegistryLatestResolution> {
  const now = io.now();
  const cacheKey = registryLatestCacheKey(io);
  const cached = registryLatestCache.get(cacheKey);
  if (!options.forceRefresh && cached && now >= cached.fetchedAt
    && now - cached.fetchedAt < REGISTRY_CACHE_TTL_MS) return { status: "ok", latest: cached };
  const checkedAt = new Date(now).toISOString();
  const registry = await io.run("npm", [
    "view", `${PICO_CLI_PACKAGE}@latest`, "version", "dist.integrity", "--json",
  ], { timeoutMs: options.updateCheckTimeoutMs });
  if (registry.code !== 0 || registry.timedOut || registry.spawnError) {
    const reason = registry.timedOut
      ? "timed out"
      : registry.spawnError
        ? "could not start npm"
        : `exited with code ${registry.code}`;
    return {
      status: "failure",
      checkedAt,
      note: `The bounded npm registry latest check ${reason}.`,
      ...(commandOutputTail(registry) ? { outputTail: commandOutputTail(registry) } : {}),
    };
  }
  try {
    const parsed: unknown = JSON.parse(registry.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("registry response was not an object");
    const keys = Object.keys(parsed).sort();
    if (keys.length !== 2 || keys[0] !== "dist.integrity" || keys[1] !== "version") throw new Error("registry response fields were invalid");
    const record = parsed as { version?: unknown; "dist.integrity"?: unknown };
    if (typeof record.version !== "string" || stableSemver(record.version) === null
      || (record["dist.integrity"] !== null && typeof record["dist.integrity"] !== "string")) throw new Error("registry response metadata was invalid");
    const latest: RegistryLatest = {
      version: record.version,
      integrity: record["dist.integrity"] as string | null,
      checkedAt,
      fetchedAt: now,
    };
    registryLatestCache.set(cacheKey, latest);
    return { status: "ok", latest };
  } catch {
    return {
      status: "failure",
      checkedAt,
      note: "The bounded npm registry latest check returned malformed or invalid metadata.",
      ...(commandOutputTail(registry) ? { outputTail: commandOutputTail(registry) } : {}),
    };
  }
}

function publicationClaimFailureNote(version: string, publicationClaim: string): string {
  return `Managed pico-cli ${version} publication claim ${publicationClaim} remains but no complete winner validates. `
    + `If the claim is abandoned, remove ${publicationClaim} manually only after confirming no managed resolver process is active, then retry.`;
}

function immutableVersionRecoveryNote(versionRoot: string, version: string): string {
  const publicationClaim = path.join(path.dirname(versionRoot), `.${version}.publish`);
  return `After confirming no managed resolver process is active, remove both ${versionRoot} and ${publicationClaim} manually `
    + `(whichever entries are present), then retry so the MCP can install and content-bind fresh bytes.`;
}

function immutableStoreRecoveryNote(versionsRoot: string, versions: string[]): string {
  if (versions.length === 0) return "";
  return ` No published managed pico-cli version passed content-bound immutable-store validation. ${versions
    .map((version) => immutableVersionRecoveryNote(path.join(versionsRoot, version), version))
    .join(" ")}`;
}

function finalizePublicationClaim(
  publicationClaim: string,
  target: string,
  expectedIdentity: { dev: number; ino: number },
  expectedRecord: ManagedPublicationRecord,
): { status: "ok" } | { status: "failure"; note: string } {
  const publicationRecordPath = path.join(target, "publication.json");
  const expectedBytes = Buffer.from(`${JSON.stringify(expectedRecord)}\n`, "utf8");
  try {
    fs.linkSync(publicationClaim, publicationRecordPath);
  } catch (error) {
    return {
      status: "failure",
      note: `Managed pico-cli ${expectedRecord.version} publication claim finalization failed without replacing either path. `
        + `Preserve ${publicationClaim} and ${publicationRecordPath}; inspect both and remove only confirmed abandoned records `
        + `after confirming no managed resolver process is active, then retry: `
        + `${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    fsyncDirectoryWhereSupported(target);
    fsyncDirectoryWhereSupported(path.dirname(publicationClaim));
  } catch (error) {
    return {
      status: "failure",
      note: `Managed pico-cli ${expectedRecord.version} publication claim finalization was linked but not durably synced. `
        + `The records are preserved at ${publicationClaim} and ${publicationRecordPath}; inspect them manually and retry `
        + `only after confirming no managed resolver process is active: `
        + `${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const source = readPublicationRecord(publicationClaim);
    const destination = readPublicationRecord(publicationRecordPath);
    if (source && destination
      && source.stat.dev === expectedIdentity.dev && source.stat.ino === expectedIdentity.ino
      && destination.stat.dev === expectedIdentity.dev && destination.stat.ino === expectedIdentity.ino
      && source.stat.dev === destination.stat.dev && source.stat.ino === destination.stat.ino
      && source.record.token === expectedRecord.token && destination.record.token === expectedRecord.token
      && source.record.version === expectedRecord.version && destination.record.version === expectedRecord.version
      && source.record.registryIntegrity === expectedRecord.registryIntegrity
      && destination.record.registryIntegrity === expectedRecord.registryIntegrity
      && source.bytes.equals(destination.bytes) && source.bytes.equals(expectedBytes)) return { status: "ok" };
  } catch { /* the failure below preserves whichever path remains */ }
  return {
    status: "failure",
    note: `Managed pico-cli ${expectedRecord.version} publication claim finalization observed an ownership replacement. `
      + `Both ${publicationClaim} and ${publicationRecordPath} are preserved; inspect them manually and retry only after confirming no managed resolver process is active.`,
  };
}

async function waitForPublishedWinner(
  target: string,
  publicationClaim: string,
  registry: RegistryLatest,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<ValidatedManagedCli | null> {
  const deadline = Date.now() + PUBLICATION_SETTLE_MS;
  while (Date.now() < deadline) {
    const claimExists = pathEntryExists(publicationClaim);
    if (pathEntryExists(target) && !claimExists) {
      const winner = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
      if (winner) return winner;
      return null;
    }
    if (!claimExists) break;
    await new Promise((resolve) => setTimeout(resolve, PUBLICATION_POLL_MS));
  }
  return pathEntryExists(target)
    ? validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io)
    : null;
}

function writeFsyncedJson(file: string, value: unknown): void {
  const descriptor = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectoryWhereSupported(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!code || !["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function inspectExternal(
  policy: Extract<PicoCliPolicyResolution, { status: "ok" }>,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<PicoCliEnsureResult> {
  const cliPath = policy.externalPath as string;
  const result = await io.run(cliPath, ["-v"], { timeoutMs: options.installTimeoutMs, killGraceMs: options.killGraceMs });
  const raw = outputOf(result);
  const version = versionFromOutput(raw);
  if (result.code !== 0 || result.timedOut || result.spawnError || !version) {
    return unavailable("external", "external", "cli-unusable", "Configured external pico-cli did not pass the bounded -v probe.", policy.deprecatedAliases, cliPath, raw);
  }
  return {
    status: "ok", source: "external", policy: "external", action: "external", path: cliPath, version, raw,
    latestVersion: null, checkedAt: null, freshness: "external", deprecatedAliases: policy.deprecatedAliases,
  };
}

export async function inspectManagedPicoCli(
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<PicoCliEnsureResult> {
  const policy = resolvePicoCliPolicy(io.env, io.platform);
  if (policy.status === "invalid") return unavailable(null, null, "configuration", policy.note, policy.deprecatedAliases);
  if (policy.policy === "disabled") {
    return unavailable("disabled", null, "cli-disabled", "PICO CLI use is disabled by PICO_MCP_CLI_POLICY=disabled.", policy.deprecatedAliases);
  }
  if (policy.policy === "external") return inspectExternal(policy, options, io);

  const managedRoot = path.resolve(options.managedRoot ?? path.join(io.homeDir, ".pico-mcp", "cli"));
  const versionsRoot = path.join(managedRoot, "versions");
  const children = publishedVersions(versionsRoot);
  if (children.length === 0) {
    return unavailable(policy.policy, "managed", "cli-missing", "No validated managed pico-cli version is published in the local store.", policy.deprecatedAliases);
  }

  for (const version of children) {
    const versionRoot = path.join(versionsRoot, version);
    const validated = await validateCachedPublishedVersion(versionRoot, version, options, io);
    if (validated) return managedOk(validated, policy.policy, "cached", null, null, "cached", policy.deprecatedAliases);
  }
  return unavailable(
    policy.policy,
    "managed",
    "cli-missing",
    immutableStoreRecoveryNote(versionsRoot, children).trimStart(),
    policy.deprecatedAliases,
  );
}

export async function resolveManagedPicoCli(
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<PicoCliEnsureResult> {
  const policy = resolvePicoCliPolicy(io.env, io.platform);
  if (policy.status === "invalid" || policy.policy !== "managed-latest") {
    return inspectManagedPicoCli(options, io);
  }

  const root = path.resolve(options.managedRoot ?? path.join(io.homeDir, ".pico-mcp", "cli"));
  const versionsRoot = path.join(root, "versions");
  const stagingRoot = path.join(root, "staging");
  cleanupAbandonedStaging(stagingRoot, io.now());

  const registryResolution = await resolveRegistryLatest(options, io);
  if (registryResolution.status === "failure") {
    const cached = await newestValidatedVersion(versionsRoot, options, io);
    if (cached) {
      return managedFallback(
        cached,
        null,
        registryResolution.checkedAt,
        registryResolution.note,
        registryResolution.outputTail,
        policy.deprecatedAliases,
      );
    }
    const rejectedVersions = publishedVersions(versionsRoot);
    return unavailable(
      "managed-latest",
      "managed",
      "latest-unknown",
      `${registryResolution.note}${immutableStoreRecoveryNote(versionsRoot, rejectedVersions)}`,
      policy.deprecatedAliases,
      null,
      "",
      { checkedAt: registryResolution.checkedAt, outputTail: registryResolution.outputTail },
    );
  }

  const registry = registryResolution.latest;
  const hadLowerValidated = await newestValidatedVersion(
    versionsRoot,
    options,
    io,
    (version) => compareStableSemver(version, registry.version) < 0,
  ) !== null;
  const knownFailure = async (note: string, outputTail?: string): Promise<PicoCliEnsureResult> => {
    const currentFallback = await newestValidatedVersion(
      versionsRoot,
      options,
      io,
      (version) => compareStableSemver(version, registry.version) < 0,
    );
    if (currentFallback) {
      return managedFallback(
        currentFallback,
        registry.version,
        registry.checkedAt,
        note,
        outputTail,
        policy.deprecatedAliases,
      );
    }
    return unavailable("managed-latest", "managed", "cli-unusable", note, policy.deprecatedAliases, null, "", {
      latestVersion: registry.version,
      checkedAt: registry.checkedAt,
      outputTail,
    });
  };

  const target = path.join(versionsRoot, registry.version);
  const publicationClaim = path.join(versionsRoot, `.${registry.version}.publish`);
  if (pathEntryExists(target)) {
    const existing = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
    if (existing) {
      return managedOk(existing, "managed-latest", "present", registry.version, registry.checkedAt, "latest", policy.deprecatedAliases);
    }
    return await knownFailure(
      `Published managed pico-cli ${registry.version} failed content-bound immutable-store validation and will not be overwritten. `
        + immutableVersionRecoveryNote(target, registry.version)
        + (pathEntryExists(publicationClaim) ? ` ${publicationClaimFailureNote(registry.version, publicationClaim)}` : ""),
    );
  }

  const staging = path.join(stagingRoot, io.randomUUID());
  let ownsStaging = false;
  let publicationClaimDescriptor: number | undefined;
  let publicationClaimIdentity: { dev: number; ino: number } | undefined;
  let publicationClaimRecord: ManagedPublicationRecord | undefined;
  try {
    fs.mkdirSync(versionsRoot, { recursive: true });
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.mkdirSync(staging);
    ownsStaging = true;
    writeFsyncedJson(path.join(staging, STAGING_OWNER_FILE), {
      schemaVersion: 1,
      kind: "pico-managed-staging",
      version: registry.version,
      token: crypto.randomUUID(),
      ownerPid: process.pid,
      createdAt: new Date(io.now()).toISOString(),
    } satisfies ManagedStagingOwnerRecord);
    fsyncDirectoryWhereSupported(staging);

    const install = await io.run("npm", [
      "install", "--prefix", staging, "--no-save", "--package-lock=false",
      "--ignore-scripts", "--fund=false", "--audit=false", `${PICO_CLI_PACKAGE}@${registry.version}`,
    ], { timeoutMs: options.installTimeoutMs, killGraceMs: options.killGraceMs });
    if (install.code !== 0 || install.timedOut || install.spawnError) {
      const note = install.timedOut
        ? "The exact managed pico-cli package install timed out."
        : install.spawnError
          ? "The exact managed pico-cli package install could not start npm."
          : `The exact managed pico-cli package install exited with code ${install.code}.`;
      return await knownFailure(
        note,
        commandOutputTail(install),
      );
    }

    const relativeCliPath = canonicalRelativeCliPath(io.platform);
    const stagedCliPath = managedShimPath(staging, relativeCliPath, io.platform);
    if (!stagedCliPath) {
      return await knownFailure(
        "The staged managed pico-cli package metadata or canonical shim was incomplete.",
        commandOutputTail(install),
      );
    }
    let stagedExecutableIdentity: ManagedExecutableIdentity;
    try {
      managedContentIdentity(staging);
      stagedExecutableIdentity = managedExecutableIdentity(staging, stagedCliPath, registry.version, io.platform);
    } catch {
      return await knownFailure(
        "The staged managed pico-cli package tree or canonical shim failed bounded containment validation.",
        commandOutputTail(install),
      );
    }
    const stagedExecutionGuard = (deadlineMs: number) => managedExecutableGuard(
      staging,
      stagedCliPath,
      registry.version,
      stagedExecutableIdentity,
      io.platform,
      deadlineMs,
    );
    const stagedProbe = await io.run(stagedCliPath, ["-v"], {
      timeoutMs: options.installTimeoutMs,
      killGraceMs: options.killGraceMs,
      beforeSpawn: stagedExecutionGuard,
      afterSpawn: stagedExecutionGuard,
    });
    const stagedRaw = outputOf(stagedProbe);
    if (stagedProbe.code !== 0 || stagedProbe.timedOut || stagedProbe.spawnError
      || versionFromOutput(stagedRaw) !== registry.version) {
      return await knownFailure(
        "The staged managed pico-cli did not report the exact requested version.",
        commandOutputTail(stagedProbe),
      );
    }

    const compatibility: PicoCliCompatibilityDiagnostic[] = [];
    for (const canary of COMPATIBILITY_CANARIES) {
      const argv = [...canary];
      const result = await io.run(stagedCliPath, argv, {
        timeoutMs: options.updateCheckTimeoutMs,
        killGraceMs: options.killGraceMs,
        beforeSpawn: stagedExecutionGuard,
        afterSpawn: stagedExecutionGuard,
      });
      compatibility.push({
        argv,
        exitCode: result.code,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
        helpSha256: crypto.createHash("sha256").update(`${result.stdout}${result.stderr}`).digest("hex"),
      });
    }

    writeFsyncedJson(path.join(staging, "compatibility.json"), {
      schemaVersion: 1,
      version: registry.version,
      diagnostics: compatibility,
    });
    const contentIdentity = managedContentIdentity(staging);
    writeFsyncedJson(path.join(staging, "install.json"), {
      schemaVersion: INSTALL_RECORD_SCHEMA_VERSION,
      version: registry.version,
      relativeCliPath,
      registryIntegrity: registry.integrity,
      installedAt: registry.checkedAt,
      ...contentBinding(contentIdentity),
    } satisfies ManagedCliInstallRecord);
    fsyncDirectoryWhereSupported(staging);

    try {
      publicationClaimDescriptor = fs.openSync(publicationClaim, "wx");
      publicationClaimRecord = {
        schemaVersion: 2,
        kind: "pico-managed-publication",
        version: registry.version,
        registryIntegrity: registry.integrity,
        token: crypto.randomUUID(),
        ownerPid: process.pid,
        createdAt: registry.checkedAt,
        ...contentBinding(contentIdentity),
      };
      fs.writeFileSync(publicationClaimDescriptor, `${JSON.stringify(publicationClaimRecord)}\n`, "utf8");
      fs.fsyncSync(publicationClaimDescriptor);
      const claimStat = fs.fstatSync(publicationClaimDescriptor);
      publicationClaimIdentity = { dev: claimStat.dev, ino: claimStat.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const winner = await waitForPublishedWinner(target, publicationClaim, registry, options, io);
      if (!winner) {
        return await knownFailure(publicationClaimFailureNote(registry.version, publicationClaim));
      }
      return managedOk(
        winner, "managed-latest", hadLowerValidated ? "updated" : "installed",
        registry.version, registry.checkedAt, "latest", policy.deprecatedAliases,
      );
    }

    if (pathEntryExists(target)) {
      const winner = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
      return await knownFailure(
        `${winner
          ? `A complete managed pico-cli ${registry.version} target appeared after this resolver acquired its claim.`
          : `Concurrent managed pico-cli ${registry.version} publication failed validation and will not be overwritten.`} `
          + `${immutableVersionRecoveryNote(target, registry.version)} `
          + publicationClaimFailureNote(registry.version, publicationClaim),
      );
    }

    try {
      fs.renameSync(staging, target);
      ownsStaging = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const collision = ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "") && pathEntryExists(target);
      if (!collision) throw error;
      const winner = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
      return await knownFailure(
        `${winner
          ? `A complete managed pico-cli ${registry.version} target collided after this resolver acquired its claim.`
          : `Concurrent managed pico-cli ${registry.version} publication failed validation and will not be overwritten.`} `
          + `${immutableVersionRecoveryNote(target, registry.version)} `
          + publicationClaimFailureNote(registry.version, publicationClaim),
      );
    }

    fsyncDirectoryWhereSupported(versionsRoot);
    const published = await validateOwnedUnfinalizedVersion(target, registry.version, registry.integrity, options, io);
    if (!published) {
      return await knownFailure(
        `The atomically published managed pico-cli failed content-bound immutable-store validation. `
          + immutableVersionRecoveryNote(target, registry.version),
      );
    }
    if (!publicationClaimIdentity || !publicationClaimRecord) {
      return await knownFailure(publicationClaimFailureNote(registry.version, publicationClaim));
    }
    const finalized = finalizePublicationClaim(
      publicationClaim,
      target,
      publicationClaimIdentity,
      publicationClaimRecord,
    );
    if (finalized.status === "failure") return await knownFailure(finalized.note);
    const finalizedPublication = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
    if (!finalizedPublication) {
      return await knownFailure(
        `The finalized managed pico-cli publication record failed content-bound immutable-store validation. `
          + immutableVersionRecoveryNote(target, registry.version),
      );
    }
    return managedOk(
      finalizedPublication, "managed-latest", hadLowerValidated ? "updated" : "installed",
      registry.version, registry.checkedAt, "latest", policy.deprecatedAliases,
    );
  } catch (error) {
    const primary = `Managed pico-cli provisioning failed: ${error instanceof Error ? error.message : String(error)}`;
    return await knownFailure(publicationClaimDescriptor === undefined
      ? primary
      : `${primary} ${publicationClaimFailureNote(registry.version, publicationClaim)}`);
  } finally {
    if (publicationClaimDescriptor !== undefined) {
      try { fs.closeSync(publicationClaimDescriptor); } catch { /* preserve the primary result */ }
    }
    if (ownsStaging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* preserve the primary failure */ }
    }
  }
}
