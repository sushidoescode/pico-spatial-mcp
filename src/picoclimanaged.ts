import fs from "node:fs";
import path from "node:path";

export const PICO_CLI_POLICY_ENV = "PICO_MCP_CLI_POLICY";
export const PICO_CLI_PATH_ENV = "PICO_MCP_CLI_PATH";
export const PICO_CLI_PACKAGE = "@picoxr/pico-cli";

const LEGACY_POLICY_ALIASES = ["PICO_MCP_AUTOINSTALL_CLI", "PICO_MCP_AUTOUPDATE_CLI"] as const;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
    };

type ManagedCliInstallRecord = {
  schemaVersion: 1;
  version: string;
  relativeCliPath: string;
  registryIntegrity: string | null;
  installedAt: string;
};

type PicoCliPolicyResolution =
  | { status: "ok"; policy: PicoCliPolicy; externalPath: string | null; deprecatedAliases: string[] }
  | { status: "invalid"; policy: null; externalPath: null; deprecatedAliases: string[]; note: string };

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
): PicoCliEnsureResult {
  return {
    status: "unavailable", source, policy, action: "skipped", path: pathValue, version: null, raw,
    latestVersion: null, checkedAt: null, freshness: null, failureClass, note, deprecatedAliases,
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

  const managedRoot = options.managedRoot ?? path.join(io.homeDir, ".pico-mcp", "cli");
  const versionsRoot = path.join(managedRoot, "versions");
  let children: string[];
  try {
    children = fs.readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && stableSemver(entry.name) !== null)
      .map((entry) => entry.name)
      .sort((left, right) => compareStableSemver(right, left));
  } catch {
    return unavailable(policy.policy, "managed", "cli-missing", "No validated managed pico-cli version is published in the local store.", policy.deprecatedAliases);
  }

  for (const version of children) {
    const versionRoot = path.join(versionsRoot, version);
    const record = readInstallRecord(versionRoot);
    if (!record || record.version !== version || stableSemver(record.version) === null) continue;
    const cliPath = managedShimPath(versionRoot, record.relativeCliPath, io.platform);
    if (!cliPath || packageVersion(versionRoot) !== version) continue;
    try {
      if (!fs.statSync(cliPath).isFile()) continue;
      if (io.platform !== "win32") fs.accessSync(cliPath, fs.constants.X_OK);
    } catch {
      continue;
    }
    const command = await io.run(cliPath, ["-v"], { timeoutMs: options.installTimeoutMs, killGraceMs: options.killGraceMs });
    const raw = outputOf(command);
    if (command.code !== 0 || command.timedOut || command.spawnError || versionFromOutput(raw) !== version) continue;
    return {
      status: "ok", source: "managed", policy: policy.policy, action: "cached", path: cliPath, version, raw,
      latestVersion: null, checkedAt: null, freshness: "cached", deprecatedAliases: policy.deprecatedAliases,
    };
  }
  return unavailable(policy.policy, "managed", "cli-missing", "No published managed pico-cli version passed immutable-store validation.", policy.deprecatedAliases);
}
