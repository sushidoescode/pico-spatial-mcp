import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ensurePicoCli, runPicoCliCommand } from "../dist/picocli.js";

/**
 * probe-windows-emulator.mjs — bounded observation of the official emulator install channel on a
 * Windows runner, driven only by an explicitly validated managed pico-cli.
 *
 *   resolve --identity-out <new file>   Resolve/provision the exact registry version through the
 *                                       MCP's managed boundary (dist/picocli.js ensurePicoCli, the
 *                                       force-refresh health path) and record its identity. Never
 *                                       `npm install -g`, never PATH.
 *   probe --cli <abs path> --identity <file>
 *                                       Run the observations against exactly that executable. The
 *                                       probe refuses to start when the path is not absolute, does
 *                                       not equal the recorded executable, or its bytes do not hash
 *                                       to the recorded digest, and it stops dependent observations
 *                                       when `-v` disagrees with the requested version. There is no
 *                                       fallback to an ambient executable.
 *
 * The recorded results are observations. They do not establish Windows runtime compatibility.
 */

const OUTPUT_CAP_BYTES = 64 * 1024;
const STANDARD_TIMEOUT_MS = 30_000;
const PROBE_ARGUMENT_USAGE = "usage: probe-windows-emulator.mjs resolve --identity-out <path> | probe --cli <absolute path> --identity <path>";

function normalizeResult(command, arguments_, timeoutMs, result) {
  return {
    command,
    arguments: arguments_,
    timeoutMs,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.spawnError ?? null,
    outputTruncated: result.outputTruncated,
  };
}

function rejectedResult(error) {
  return {
    code: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    spawnError: error instanceof Error ? error.message : String(error),
    outputTruncated: false,
  };
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseReportedVersion(stdout) {
  return stdout.match(/pico-cli\/(\d+\.\d+\.\d+)(?=\s|$)/)?.[1] ?? null;
}

function validIdentity(identity) {
  return identity !== null && typeof identity === "object" && !Array.isArray(identity)
    && identity.schemaVersion === 1
    && typeof identity.version === "string" && /^\d+\.\d+\.\d+$/.test(identity.version)
    && typeof identity.executablePath === "string" && identity.executablePath.length > 0
    && typeof identity.executableSha256 === "string" && /^[a-f0-9]{64}$/.test(identity.executableSha256);
}

export function parseProbeArguments(argv) {
  const [mode, ...rest] = argv;
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--") || flags.has(flag)) throw new Error(PROBE_ARGUMENT_USAGE);
    flags.set(flag, value);
  }
  if (mode === "resolve" && flags.size === 1 && flags.has("--identity-out")) {
    return { mode: "resolve", identityOut: flags.get("--identity-out") };
  }
  if (mode === "probe" && flags.size === 2 && flags.has("--cli") && flags.has("--identity")) {
    return { mode: "probe", cliPath: flags.get("--cli"), identityPath: flags.get("--identity") };
  }
  throw new Error(PROBE_ARGUMENT_USAGE);
}

/**
 * Resolve the exact managed CLI through the normal managed boundary and persist its identity to a
 * fresh file. Only a managed `ok` result is accepted: an unavailable resolution or an external
 * policy is an error, never an excuse to look for an ambient executable.
 */
export async function resolveManagedProbeCli({
  ensure = () => ensurePicoCli({ forceRefresh: true }),
  hashFile = sha256File,
  identityOut,
  now = () => new Date(),
} = {}) {
  if (typeof identityOut !== "string" || identityOut.length === 0) throw new Error("resolve requires --identity-out <path>");
  const ensured = await ensure({ forceRefresh: true });
  if (ensured.status !== "ok") {
    throw new Error(`managed pico-cli resolution failed (${ensured.failureClass}): ${ensured.note}`);
  }
  if (ensured.source !== "managed") {
    throw new Error(`the Windows probe requires a managed pico-cli resolution, got source=${ensured.source}`);
  }
  const identity = {
    schemaVersion: 1,
    resolvedAt: now().toISOString(),
    policy: ensured.policy,
    source: ensured.source,
    action: ensured.action,
    freshness: ensured.freshness,
    version: ensured.version,
    latestVersion: ensured.latestVersion,
    checkedAt: ensured.checkedAt,
    executablePath: ensured.path,
    executableSha256: hashFile(ensured.path),
    capabilities: ensured.capabilities?.identity ?? null,
  };
  fs.mkdirSync(path.dirname(identityOut), { recursive: true });
  fs.writeFileSync(identityOut, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return identity;
}

export async function collectWindowsEmulatorProbe({
  env = process.env,
  platform = process.platform,
  runCommand = runPicoCliCommand,
  cliPath,
  identity,
  hashFile = sha256File,
  now = () => new Date(),
} = {}) {
  if (platform !== "win32") {
    throw new Error("The Windows emulator probe must run on a Windows runner.");
  }
  if (typeof cliPath !== "string" || !path.win32.isAbsolute(cliPath)) {
    throw new Error("The Windows emulator probe requires an absolute --cli path; it never resolves an ambient executable.");
  }
  if (!validIdentity(identity)) {
    throw new Error("The Windows emulator probe requires the identity file written by `resolve`.");
  }
  if (identity.executablePath !== cliPath) {
    throw new Error(`--cli ${cliPath} does not equal the resolved identity executable ${identity.executablePath}.`);
  }

  const run = async (command, arguments_, timeoutMs) => {
    try {
      return normalizeResult(
        command,
        arguments_,
        timeoutMs,
        await runCommand(command, arguments_, { env, timeoutMs, maxOutputBytes: OUTPUT_CAP_BYTES }),
      );
    } catch (error) {
      return normalizeResult(command, arguments_, timeoutMs, rejectedResult(error));
    }
  };

  let observedSha256 = null;
  try {
    observedSha256 = hashFile(cliPath);
  } catch (error) {
    observedSha256 = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const integrity = { expectedSha256: identity.executableSha256, observedSha256, ok: observedSha256 === identity.executableSha256 };
  let versionCheck = { requested: identity.version, reported: null, ok: false };
  let skipped = null;
  let cliVersion = null;
  let emulatorInstallHelp = null;
  let emulatorStatus = null;

  if (!integrity.ok) {
    skipped = "integrity-mismatch";
  } else {
    cliVersion = await run(cliPath, ["-v"], STANDARD_TIMEOUT_MS);
    const reported = cliVersion.exitCode === 0 && !cliVersion.timedOut && !cliVersion.spawnError
      ? parseReportedVersion(cliVersion.stdout)
      : null;
    versionCheck = { requested: identity.version, reported, ok: reported === identity.version };
    if (!versionCheck.ok) {
      skipped = "version-mismatch";
    } else {
      emulatorInstallHelp = await run(cliPath, ["emulator", "install", "--source", "auto", "--yes", "--help"], STANDARD_TIMEOUT_MS);
      emulatorStatus = await run(cliPath, ["emulator", "status", "--format", "json"], STANDARD_TIMEOUT_MS);
    }
  }

  return {
    schemaVersion: 2,
    observedAtUtc: now().toISOString(),
    commitSha: env.PICO_WINDOWS_PROBE_SHA ?? null,
    workflow: {
      name: env.GITHUB_WORKFLOW ?? null,
      runId: env.GITHUB_RUN_ID ?? null,
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
      job: env.GITHUB_JOB ?? null,
      repository: env.GITHUB_REPOSITORY ?? null,
      serverUrl: env.GITHUB_SERVER_URL ?? null,
      runUrl: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`
        : null,
    },
    runner: {
      os: env.RUNNER_OS ?? null,
      image: env.ImageOS ?? null,
      architecture: env.RUNNER_ARCH ?? null,
      osVersion: env.ImageVersion ?? null,
      node: process.version,
    },
    npm: { calls: 0, globalInstall: false },
    cli: {
      targeting: "explicit-absolute-path",
      executablePath: cliPath,
      requested: identity,
      integrity,
      versionCheck,
      skipped,
    },
    cliVersion,
    emulatorInstallHelp,
    emulatorStatus,
  };
}

async function main() {
  const args = parseProbeArguments(process.argv.slice(2));
  if (args.mode === "resolve") {
    const identity = await resolveManagedProbeCli({ identityOut: args.identityOut });
    process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
    return;
  }
  const outputPath = process.env.PICO_WINDOWS_PROBE_OUT;
  if (!outputPath) {
    throw new Error("PICO_WINDOWS_PROBE_OUT is required when running the Windows emulator probe.");
  }
  const identity = JSON.parse(fs.readFileSync(args.identityPath, "utf8"));
  const report = await collectWindowsEmulatorProbe({ cliPath: args.cliPath, identity });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json, { encoding: "utf8", flag: "wx" });
  process.stdout.write(json);
  if (report.cli.skipped) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
