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
  now: () => number;
  randomUUID: () => string;
  run: (command: string, args: string[], options?: {
    timeoutMs?: number;
    killGraceMs?: number;
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

type ManagedCliInstallRecord = {
  schemaVersion: 1;
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

type ManagedPublicationRecord = {
  schemaVersion: 1;
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

let registryLatestCache: RegistryLatest | null = null;

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

function readInstallRecord(versionRoot: string): ManagedCliInstallRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(versionRoot, "install.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Partial<ManagedCliInstallRecord>;
    if (record.schemaVersion !== 1 || typeof record.version !== "string" || typeof record.relativeCliPath !== "string"
      || (record.registryIntegrity !== null && typeof record.registryIntegrity !== "string") || typeof record.installedAt !== "string") return null;
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
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json"), "utf8"));
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
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(versionRoot, "compatibility.json"), "utf8"));
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
    || record.relativeCliPath !== relativeCliPath || packageVersion(versionRoot) !== version) return null;
  const cliPath = managedShimPath(versionRoot, record.relativeCliPath, io.platform);
  if (!cliPath) return null;
  try {
    if (!fs.statSync(cliPath).isFile()) return null;
    if (io.platform !== "win32") fs.accessSync(cliPath, fs.constants.X_OK);
  } catch {
    return null;
  }
  const command = await io.run(cliPath, ["-v"], { timeoutMs: options.installTimeoutMs, killGraceMs: options.killGraceMs });
  const raw = outputOf(command);
  if (command.code !== 0 || command.timedOut || command.spawnError || versionFromOutput(raw) !== version) return null;
  const compatibility = readCompatibility(versionRoot, version);
  return { path: cliPath, version, raw, ...(compatibility ? { compatibility } : {}) };
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
  const publicationPath = path.join(versionRoot, "publication.json");
  if (fs.existsSync(publicationPath)) {
    const publication = readPublicationRecord(publicationPath);
    if (!publication || publication.version !== version || publication.registryIntegrity !== registryIntegrity) return null;
  }
  const validated = await validateManagedVersion(versionRoot, version, options, io);
  return validated && hasCompleteCompatibility(validated.compatibility) ? validated : null;
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
  return {
    status: "ok", source: "managed", policy, action, path: validated.path, version: validated.version,
    raw: validated.raw, latestVersion, checkedAt, freshness, deprecatedAliases,
    ...(validated.compatibility ? { compatibility: validated.compatibility } : {}),
  };
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
  return {
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
}

async function newestValidatedVersion(
  versionsRoot: string,
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
  accept: (version: string) => boolean = () => true,
): Promise<ValidatedManagedCli | null> {
  for (const version of publishedVersions(versionsRoot)) {
    if (!accept(version)) continue;
    const validated = await validateManagedVersion(path.join(versionsRoot, version), version, options, io);
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
    const stat = fs.lstatSync(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const bytes = fs.readFileSync(recordPath);
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

function readPublicationRecord(recordPath: string): ManagedPublicationRecord | null {
  try {
    const stat = fs.lstatSync(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    if (keys.join("\0") !== ["createdAt", "kind", "ownerPid", "registryIntegrity", "schemaVersion", "token", "version"].join("\0")) return null;
    const record = parsed as Partial<ManagedPublicationRecord>;
    const createdAtMs = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN;
    if (record.schemaVersion !== 1 || record.kind !== "pico-managed-publication"
      || typeof record.version !== "string" || stableSemver(record.version) === null
      || (record.registryIntegrity !== null && typeof record.registryIntegrity !== "string")
      || typeof record.token !== "string" || record.token.length === 0 || record.token.length > 256
      || typeof record.ownerPid !== "number" || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0
      || !Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== record.createdAt) return null;
    return record as ManagedPublicationRecord;
  } catch {
    return null;
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

async function resolveRegistryLatest(
  options: ManagedPicoCliOptions,
  io: ManagedPicoCliIO,
): Promise<RegistryLatestResolution> {
  const now = io.now();
  if (!options.forceRefresh && registryLatestCache && now >= registryLatestCache.fetchedAt
    && now - registryLatestCache.fetchedAt < REGISTRY_CACHE_TTL_MS) return { status: "ok", latest: registryLatestCache };
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
    registryLatestCache = {
      version: record.version,
      integrity: record["dist.integrity"] as string | null,
      checkedAt,
      fetchedAt: now,
    };
    return { status: "ok", latest: registryLatestCache };
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

function finalizePublicationClaim(
  publicationClaim: string,
  target: string,
  expectedIdentity: { dev: number; ino: number },
  expectedRecord: ManagedPublicationRecord,
): { status: "ok" } | { status: "failure"; note: string } {
  const publicationRecordPath = path.join(target, "publication.json");
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
    const movedStat = fs.lstatSync(publicationRecordPath);
    const movedRecord = readPublicationRecord(publicationRecordPath);
    if (movedStat.dev === expectedIdentity.dev && movedStat.ino === expectedIdentity.ino
      && movedRecord?.token === expectedRecord.token && movedRecord.version === expectedRecord.version
      && movedRecord.registryIntegrity === expectedRecord.registryIntegrity) return { status: "ok" };
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
    const claimExists = fs.existsSync(publicationClaim);
    if (fs.existsSync(target) && !claimExists) {
      const winner = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
      if (winner) return winner;
      return null;
    }
    if (!claimExists) break;
    await new Promise((resolve) => setTimeout(resolve, PUBLICATION_POLL_MS));
  }
  return fs.existsSync(target)
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
    const validated = await validateManagedVersion(versionRoot, version, options, io);
    if (validated) return managedOk(validated, policy.policy, "cached", null, null, "cached", policy.deprecatedAliases);
  }
  return unavailable(policy.policy, "managed", "cli-missing", "No published managed pico-cli version passed immutable-store validation.", policy.deprecatedAliases);
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
    return unavailable(
      "managed-latest",
      "managed",
      "latest-unknown",
      registryResolution.note,
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
  if (fs.existsSync(target)) {
    const existing = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
    if (existing) {
      return managedOk(existing, "managed-latest", "present", registry.version, registry.checkedAt, "latest", policy.deprecatedAliases);
    }
    return await knownFailure(
      `Published managed pico-cli ${registry.version} failed immutable-store validation and will not be overwritten.`,
    );
  }

  const staging = path.join(stagingRoot, io.randomUUID());
  const publicationClaim = path.join(versionsRoot, `.${registry.version}.publish`);
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
      "--fund=false", "--audit=false", `${PICO_CLI_PACKAGE}@${registry.version}`,
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
    if (!stagedCliPath || packageVersion(staging) !== registry.version) {
      return await knownFailure(
        "The staged managed pico-cli package metadata or canonical shim was incomplete.",
        commandOutputTail(install),
      );
    }
    try {
      if (!fs.statSync(stagedCliPath).isFile()) throw new Error("canonical shim is not a file");
      if (io.platform !== "win32") fs.accessSync(stagedCliPath, fs.constants.X_OK);
    } catch {
      return await knownFailure(
        "The staged managed pico-cli canonical shim was not executable.",
        commandOutputTail(install),
      );
    }
    const stagedProbe = await io.run(stagedCliPath, ["-v"], {
      timeoutMs: options.installTimeoutMs,
      killGraceMs: options.killGraceMs,
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
      });
      compatibility.push({
        argv,
        exitCode: result.code,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
        helpSha256: crypto.createHash("sha256").update(`${result.stdout}${result.stderr}`).digest("hex"),
      });
    }

    writeFsyncedJson(path.join(staging, "install.json"), {
      schemaVersion: 1,
      version: registry.version,
      relativeCliPath,
      registryIntegrity: registry.integrity,
      installedAt: registry.checkedAt,
    } satisfies ManagedCliInstallRecord);
    writeFsyncedJson(path.join(staging, "compatibility.json"), {
      schemaVersion: 1,
      version: registry.version,
      diagnostics: compatibility,
    });

    try {
      publicationClaimDescriptor = fs.openSync(publicationClaim, "wx");
      publicationClaimRecord = {
        schemaVersion: 1,
        kind: "pico-managed-publication",
        version: registry.version,
        registryIntegrity: registry.integrity,
        token: crypto.randomUUID(),
        ownerPid: process.pid,
        createdAt: registry.checkedAt,
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

    if (fs.existsSync(target)) {
      const winner = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
      return await knownFailure(
        `${winner
          ? `A complete managed pico-cli ${registry.version} target appeared after this resolver acquired its claim.`
          : `Concurrent managed pico-cli ${registry.version} publication failed validation and will not be overwritten.`} `
          + publicationClaimFailureNote(registry.version, publicationClaim),
      );
    }

    try {
      fs.renameSync(staging, target);
      ownsStaging = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const collision = ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "") && fs.existsSync(target);
      if (!collision) throw error;
      const winner = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
      return await knownFailure(
        `${winner
          ? `A complete managed pico-cli ${registry.version} target collided after this resolver acquired its claim.`
          : `Concurrent managed pico-cli ${registry.version} publication failed validation and will not be overwritten.`} `
          + publicationClaimFailureNote(registry.version, publicationClaim),
      );
    }

    fsyncDirectoryWhereSupported(versionsRoot);
    const published = await validateLatestPublishedVersion(target, registry.version, registry.integrity, options, io);
    if (!published) {
      return await knownFailure("The atomically published managed pico-cli failed immutable-store validation.");
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
      return await knownFailure("The finalized managed pico-cli publication record failed immutable-store validation.");
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
