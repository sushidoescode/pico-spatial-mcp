import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePicoCliPath, runPicoCliCommand } from "../dist/picocli.js";

const OUTPUT_CAP_BYTES = 64 * 1024;
const STANDARD_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 120_000;

function normalizeResult(command, arguments_, result) {
  return {
    command,
    arguments: arguments_,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.spawnError ?? null,
    outputTruncated: result.outputTruncated,
  };
}

export async function collectWindowsEmulatorProbe({
  env = process.env,
  platform = process.platform,
  runCommand = runPicoCliCommand,
  resolveCli = resolvePicoCliPath,
  now = () => new Date(),
} = {}) {
  if (platform !== "win32") {
    throw new Error("The Windows emulator probe must run on a Windows runner.");
  }

  const run = async (command, arguments_, timeoutMs) => normalizeResult(
    command,
    arguments_,
    await runCommand(command, arguments_, { env, timeoutMs, maxOutputBytes: OUTPUT_CAP_BYTES }),
  );
  const npmLatest = await run("npm", ["view", "@picoxr/pico-cli", "version", "--json"], STANDARD_TIMEOUT_MS);
  const cliInstall = await run("npm", ["install", "-g", "@picoxr/pico-cli"], INSTALL_TIMEOUT_MS);
  const cliPath = resolveCli(env, platform) ?? "pico-cli";
  const cliVersion = await run(cliPath, ["-v"], STANDARD_TIMEOUT_MS);
  const emulatorInstallHelp = await run(cliPath, ["emulator", "install", "--help"], STANDARD_TIMEOUT_MS);
  const emulatorStatus = await run(cliPath, ["emulator", "status", "--format", "json"], STANDARD_TIMEOUT_MS);

  return {
    schemaVersion: 1,
    observedAtUtc: now().toISOString(),
    commitSha: env.PICO_WINDOWS_PROBE_SHA ?? null,
    runner: {
      os: env.RUNNER_OS ?? null,
      image: env.ImageOS ?? null,
      architecture: env.RUNNER_ARCH ?? null,
      osVersion: env.ImageVersion ?? null,
      node: process.version,
    },
    npmLatest,
    cliInstall,
    cliVersion,
    emulatorInstallHelp,
    emulatorStatus,
  };
}

async function main() {
  const outputPath = process.env.PICO_WINDOWS_PROBE_OUT;
  if (!outputPath) {
    throw new Error("PICO_WINDOWS_PROBE_OUT is required when running the Windows emulator probe.");
  }
  const report = await collectWindowsEmulatorProbe();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, json, "utf8");
  process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
