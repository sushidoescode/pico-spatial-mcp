import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { materializeCaptureBytes } from "./ledger.js";
import {
  collectGradleInputIdentity,
  readAuthoredAppSpecIdentity,
} from "./runreceiptidentity.js";
import {
  publishApkArtifact,
  publishEffectiveSpecArtifact,
  publishNativeRunReceipt,
  type NativeRunReceiptPayload,
  type PublishedNativeRunReceipt,
} from "./runreceiptstore.js";
import { gradleEnv as defaultGradleEnv } from "./toolchain.js";
import {
  run,
  runBinary,
  sleep as defaultSleep,
  type RunOptions,
  type RunResult,
} from "./util.js";
import { resolveAssembledApk } from "./workflow.js";

const COMMAND_TAIL_BYTES = 64 * 1024;
const COMMAND_TAIL_LINES = 60;
const TEXT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const CAPTURE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const OUTPUT_METADATA_MAX_BYTES = 2 * 1024 * 1024;
const PID_FOREGROUND_ATTEMPTS = 12;
const PID_FOREGROUND_WINDOW_MS = 24_000;
const POLL_INTERVAL_MS = 2_000;
const PRE_LAUNCH_SETTLE_MS = 2_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FLEET_PACKAGE_PATTERN = /^com\.fleet\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

type BinaryRunResult = Awaited<ReturnType<typeof runBinary>>;

export interface ProduceNativeFleetReceiptInput {
  briefPath: string;
  effectiveSpec: unknown;
  projectDir: string;
  packageName: string;
  task: ":app:assembleDebug";
  serial: string;
  component: string;
  captureDir: string;
  settleMs: number;
  afterInstall?: () => Promise<{ status: "ok" } | { status: "failed"; reason: string }>;
}

export interface NativeFleetReceiptDependencies {
  runText: typeof run;
  runBinary: typeof runBinary;
  adbPath: string;
  gradleEnv: Record<string, string | undefined>;
  now: () => Date;
  monotonicNow: () => number;
  randomUUID: () => string;
  sleep: (ms: number) => Promise<void>;
  inspectApk: (apkPath: string, projectDir: string) => Promise<{
    manifestInspection: NativeRunReceiptPayload["apk"]["manifestInspection"];
    signingInspection: NativeRunReceiptPayload["apk"]["signingInspection"];
  }>;
}

export type NativeFleetFailureStage =
  | "source-identity" | "build" | "apk-resolution" | "apk-publication" | "apk-inspection"
  | "install" | "installed-byte-identity" | "after-install" | "device-identity" | "launch"
  | "pid" | "foreground" | "capture" | "capture-publication" | "receipt-publication";

export type ProduceNativeFleetReceiptResult =
  | { status: "recorded"; built: true; installed: true; receipt: PublishedNativeRunReceipt }
  | { status: "failed"; stage: NativeFleetFailureStage; built: boolean; installed: boolean; reason: string; completedStages: string[] };

type ForegroundActivity = { packageName: string; component: string };
type RemoteDigestLine = { sha256: string; path: string };

class StageFailure extends Error {
  constructor(readonly stage: NativeFleetFailureStage, message: string) {
    super(message);
  }
}

function nonemptyLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseInstalledApkPath(output: string): string | null {
  const paths = nonemptyLines(output).map((line) => /^package:(\S+)$/.exec(line)?.[1]).filter((value): value is string => Boolean(value));
  return paths.length === 1 && nonemptyLines(output).length === 1 ? paths[0] : null;
}

function parseRemoteDigestLine(output: string): RemoteDigestLine | null {
  const lines = nonemptyLines(output);
  if (lines.length !== 1) return null;
  const match = /^([A-Fa-f0-9]{64})\s+(\S+)$/.exec(lines[0]);
  return match ? { sha256: match[1].toLowerCase(), path: match[2] } : null;
}

export function parseRemoteSha256(output: string): string | null {
  return parseRemoteDigestLine(output)?.sha256 ?? null;
}

export function parsePid(output: string): number | null {
  const value = output.trim();
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseProcStartTicks(output: string): string | null {
  const value = output.trim();
  if (!/^\d+\s+\(/.test(value)) return null;
  const closing = value.lastIndexOf(") ");
  if (closing < 0) return null;
  const fields = value.slice(closing + 2).trim().split(/\s+/);
  if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19])) return null;
  return fields[19];
}

function foregroundActivities(output: string): ForegroundActivity[] {
  return [...output.matchAll(
    /(?:topResumedActivity=|mResumedActivity:\s*|ResumedActivity:\s*)ActivityRecord\{\S+\s+u\d+\s+([A-Za-z][A-Za-z0-9_.]*)\/([A-Za-z0-9_.$]+)/g,
  )].map((match) => ({
    packageName: match[1],
    component: `${match[1]}/${match[2]}`,
  }));
}

export function parseForegroundActivity(output: string): ForegroundActivity | null {
  const activities = foregroundActivities(output);
  return activities.length === 1 ? activities[0] : null;
}

function boundedTail(output: string): string {
  let bytes = Buffer.from(output, "utf8");
  if (bytes.length > COMMAND_TAIL_BYTES) bytes = bytes.subarray(bytes.length - COMMAND_TAIL_BYTES);
  const lines = bytes.toString("utf8").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-COMMAND_TAIL_LINES).join("\n");
}

function commandDescription(command: string, args: string[]): string {
  return JSON.stringify([command, ...args]);
}

function commandFailure(
  label: string,
  command: string,
  args: string[],
  result: RunResult | BinaryRunResult,
  detail: string,
): string {
  const output = typeof result.stdout === "string"
    ? `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`
    : result.stderr;
  const tail = boundedTail(output);
  return `${label}: command=${commandDescription(command, args)} exit=${String(result.code)} timedOut=${result.timedOut}; ${detail}${tail ? `\n${tail}` : ""}`;
}

function assertTextSuccess(
  stage: NativeFleetFailureStage,
  label: string,
  command: string,
  args: string[],
  result: RunResult,
): void {
  if (result.code !== 0 || result.timedOut) {
    throw new StageFailure(stage, commandFailure(label, command, args, result, "command did not complete successfully"));
  }
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resultText(result: RunResult): string {
  return `${result.stdout}${result.stderr}`;
}

function realEffectivePackage(spec: unknown): unknown {
  return spec !== null && typeof spec === "object" && !Array.isArray(spec)
    ? (spec as { meta?: { packageName?: unknown } }).meta?.packageName
    : undefined;
}

function fileSnapshot(filePath: string, maxBytes: number): { path: string; bytes: Buffer; sha256: string } {
  const realPath = fs.realpathSync(path.resolve(filePath));
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`'${realPath}' is not a regular file`);
    if (before.size > BigInt(maxBytes)) throw new Error(`'${realPath}' exceeds the ${maxBytes}-byte limit`);
    const length = Number(before.size);
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const count = fs.readSync(descriptor, bytes, offset, length - offset, null);
      if (count === 0) throw new Error(`'${realPath}' ended while being read`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error(`'${realPath}' changed while being read`);
    }
    return { path: realPath, bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeUniqueCapture(targetPath: string, bytes: Buffer, randomUUID: () => string): string {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(targetPath)) throw new Error(`capture target '${targetPath}' already exists; refusing to overwrite it`);
  const stagingPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(stagingPath, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(stagingPath, targetPath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(stagingPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return fs.realpathSync(targetPath);
}

function parseLocalPropertiesSdk(projectDir: string): string | null {
  const propertiesPath = path.join(projectDir, "local.properties");
  let text: string;
  try {
    text = fs.readFileSync(propertiesPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const line = text.split(/\r?\n/).find((entry) => /^\s*sdk\.dir\s*=/.test(entry));
  if (!line) return null;
  const value = line.slice(line.indexOf("=") + 1).trim()
    .replace(/\\:/g, ":")
    .replace(/\\\\/g, "\\");
  return value ? path.resolve(projectDir, value) : null;
}

function newestBuildTool(sdkRoot: string, tool: "aapt2" | "apksigner"): string | null {
  const buildTools = path.join(sdkRoot, "build-tools");
  let versions: string[];
  try {
    versions = fs.readdirSync(buildTools, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return null;
  }
  for (const version of versions) {
    const candidate = path.join(buildTools, version, process.platform === "win32" ? `${tool}.bat` : tool);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveAndroidSdk(projectDir: string): string | null {
  for (const candidate of [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME, parseLocalPropertiesSdk(projectDir)]) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return fs.realpathSync(candidate);
  }
  return null;
}

async function defaultInspectApk(
  apkPath: string,
  projectDir: string,
  runText: typeof run,
): Promise<{
  manifestInspection: NativeRunReceiptPayload["apk"]["manifestInspection"];
  signingInspection: NativeRunReceiptPayload["apk"]["signingInspection"];
}> {
  const sdkRoot = resolveAndroidSdk(projectDir);
  if (!sdkRoot) {
    return {
      manifestInspection: { status: "unavailable", reason: "Android SDK root was not found in ANDROID_SDK_ROOT, ANDROID_HOME, or project local.properties" },
      signingInspection: { status: "unavailable", reason: "Android SDK root was not found in ANDROID_SDK_ROOT, ANDROID_HOME, or project local.properties" },
    };
  }

  const aapt2 = newestBuildTool(sdkRoot, "aapt2");
  let manifestInspection: NativeRunReceiptPayload["apk"]["manifestInspection"];
  if (!aapt2) {
    manifestInspection = { status: "unavailable", reason: `aapt2 was not found below '${path.join(sdkRoot, "build-tools")}'` };
  } else {
    const args = ["dump", "badging", apkPath];
    const result = await runText(aapt2, args, { timeoutMs: 30_000, maxOutputBytes: COMMAND_TAIL_BYTES });
    if (result.code !== 0 || result.timedOut) {
      manifestInspection = { status: "unavailable", reason: commandFailure("aapt2 inspection", aapt2, args, result, "inspection did not complete successfully") };
    } else {
      const packageMatch = /^package:\s+name='([^']+)'(?:\s+versionCode='([^']+)')?(?:\s+versionName='([^']+)')?/m.exec(result.stdout);
      manifestInspection = packageMatch?.[1] && packageMatch[2] && packageMatch[3]
        ? { status: "inspected", tool: "aapt2", packageName: packageMatch[1], versionCode: packageMatch[2], versionName: packageMatch[3] }
        : { status: "unavailable", reason: "aapt2 completed successfully but returned no complete package/version identity" };
    }
  }

  const apksigner = newestBuildTool(sdkRoot, "apksigner");
  let signingInspection: NativeRunReceiptPayload["apk"]["signingInspection"];
  if (!apksigner) {
    signingInspection = { status: "unavailable", reason: `apksigner was not found below '${path.join(sdkRoot, "build-tools")}'` };
  } else {
    const args = ["verify", "--print-certs", apkPath];
    const result = await runText(apksigner, args, { timeoutMs: 30_000, maxOutputBytes: COMMAND_TAIL_BYTES });
    if (result.code !== 0 || result.timedOut) {
      signingInspection = { status: "unavailable", reason: commandFailure("apksigner inspection", apksigner, args, result, "inspection did not complete successfully") };
    } else {
      const digests = [...result.stdout.matchAll(/certificate SHA-256 digest:\s*([A-Fa-f0-9:]+)/g)]
        .map((match) => match[1].replace(/:/g, "").toLowerCase())
        .filter((digest) => HASH_PATTERN.test(digest));
      signingInspection = digests.length
        ? { status: "inspected", tool: "apksigner", certificateSha256: [...new Set(digests)] }
        : { status: "unavailable", reason: "apksigner completed successfully but returned no SHA-256 certificate digest" };
    }
  }
  return { manifestInspection, signingInspection };
}

function stageReason(stage: NativeFleetFailureStage, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `[${stage}] ${message}`;
}

function fleetPackages(output: string): string[] {
  const packages = nonemptyLines(output)
    .map((line) => /^package:([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value))
    .filter((value) => FLEET_PACKAGE_PATTERN.test(value));
  return [...new Set(packages)];
}

export async function produceNativeFleetReceipt(
  input: ProduceNativeFleetReceiptInput,
  deps?: NativeFleetReceiptDependencies,
): Promise<ProduceNativeFleetReceiptResult> {
  const runText = deps?.runText ?? run;
  const resolvedDeps: NativeFleetReceiptDependencies = {
    runText,
    runBinary: deps?.runBinary ?? runBinary,
    adbPath: deps?.adbPath ?? process.env.PICO_ADB ?? "adb",
    gradleEnv: deps?.gradleEnv ?? defaultGradleEnv(),
    now: deps?.now ?? (() => new Date()),
    monotonicNow: deps?.monotonicNow ?? (() => performance.now()),
    randomUUID: deps?.randomUUID ?? (() => crypto.randomUUID()),
    sleep: deps?.sleep ?? defaultSleep,
    inspectApk: deps?.inspectApk ?? ((apkPath, projectDir) => defaultInspectApk(apkPath, projectDir, runText)),
  };
  const completedStages: string[] = [];
  let built = false;
  let installed = false;

  try {
    let projectDir: string;
    let authoredAppSpec: NativeRunReceiptPayload["source"]["authoredAppSpec"];
    let effectiveAppSpec: NativeRunReceiptPayload["source"]["effectiveAppSpec"];
    let gradleInputs: NativeRunReceiptPayload["source"]["gradleInputs"];
    try {
      if (input.task !== ":app:assembleDebug") throw new Error("task must be exactly ':app:assembleDebug'");
      if (!FLEET_PACKAGE_PATTERN.test(input.packageName)) throw new Error(`packageName '${input.packageName}' must be an exact lowercase com.fleet.* package`);
      if (!Number.isFinite(input.settleMs) || input.settleMs < 0 || input.settleMs > 180_000) {
        throw new Error("settleMs must be finite and within 0..180000 milliseconds");
      }
      if (!input.serial.trim()) throw new Error("serial must be non-empty");
      const componentParts = input.component.split("/");
      if (componentParts.length !== 2 || componentParts[0] !== input.packageName || !componentParts[1]) {
        throw new Error(`component '${input.component}' must exactly name an activity in ${input.packageName}`);
      }
      if (realEffectivePackage(input.effectiveSpec) !== input.packageName) {
        throw new Error("effective AppSpec packageName must exactly match packageName");
      }
      projectDir = fs.realpathSync(path.resolve(input.projectDir));
      authoredAppSpec = readAuthoredAppSpecIdentity(input.briefPath);
      effectiveAppSpec = publishEffectiveSpecArtifact(input.effectiveSpec);
      gradleInputs = collectGradleInputIdentity(projectDir);
    } catch (error) {
      throw new StageFailure("source-identity", error instanceof Error ? error.message : String(error));
    }
    completedStages.push("source-identity");

    const buildStartedAt = resolvedDeps.now().toISOString();
    const gradlew = path.join(projectDir, "gradlew");
    const buildArgs = [input.task, "--console=plain"];
    const buildResult = await resolvedDeps.runText(gradlew, buildArgs, {
      cwd: projectDir,
      env: resolvedDeps.gradleEnv,
      timeoutMs: 1_800_000,
      maxOutputBytes: TEXT_OUTPUT_LIMIT,
    });
    assertTextSuccess("build", "Gradle build", gradlew, buildArgs, buildResult);
    const buildFinishedAt = resolvedDeps.now().toISOString();
    built = true;
    completedStages.push("build");

    let resolvedApk: ReturnType<typeof resolveAssembledApk>;
    let outputMetadata: ReturnType<typeof fileSnapshot>;
    try {
      resolvedApk = resolveAssembledApk(projectDir, input.task, input.packageName);
      if (!resolvedApk.apk || !resolvedApk.metadataPath) throw new Error(resolvedApk.reason ?? "AGP output metadata did not resolve one APK");
      outputMetadata = fileSnapshot(resolvedApk.metadataPath, OUTPUT_METADATA_MAX_BYTES);
    } catch (error) {
      throw new StageFailure("apk-resolution", error instanceof Error ? error.message : String(error));
    }
    completedStages.push("apk-resolution");

    let apk: Awaited<ReturnType<typeof publishApkArtifact>>;
    try {
      apk = await publishApkArtifact(resolvedApk.apk!);
    } catch (error) {
      throw new StageFailure("apk-publication", error instanceof Error ? error.message : String(error));
    }
    completedStages.push("apk-publication");

    let inspection: Awaited<ReturnType<NativeFleetReceiptDependencies["inspectApk"]>>;
    try {
      inspection = await resolvedDeps.inspectApk(apk.artifactPath, projectDir);
      if (inspection.manifestInspection.status === "inspected" && inspection.manifestInspection.packageName !== input.packageName) {
        throw new Error(`inspected APK package '${inspection.manifestInspection.packageName}' does not match '${input.packageName}'`);
      }
    } catch (error) {
      throw new StageFailure("apk-inspection", error instanceof Error ? error.message : String(error));
    }
    completedStages.push("apk-inspection");

    const installArgs = ["-s", input.serial, "install", "-r", apk.artifactPath];
    const installResult = await resolvedDeps.runText(resolvedDeps.adbPath, installArgs, {
      timeoutMs: 300_000,
      maxOutputBytes: COMMAND_TAIL_BYTES,
    });
    if (installResult.code !== 0 || installResult.timedOut || !/(?:^|\r?\n)Success(?:\r?\n|$)/.test(resultText(installResult))) {
      throw new StageFailure("install", commandFailure(
        "APK install",
        resolvedDeps.adbPath,
        installArgs,
        installResult,
        "required a zero exit, no timeout, and an exact Success line",
      ));
    }
    installed = true;
    const installCompletedAt = resolvedDeps.now().toISOString();
    const installAcknowledgementSha256 = sha256Text(resultText(installResult));
    completedStages.push("install");

    type InstalledApkIdentity = { path: string; sha256: string };
    const probeInstalledApkIdentity = async (requiredPath?: string): Promise<InstalledApkIdentity> => {
      const pmPathArgs = ["-s", input.serial, "shell", "pm", "path", input.packageName];
      const pmPathResult = await resolvedDeps.runText(resolvedDeps.adbPath, pmPathArgs, {
        timeoutMs: 20_000,
        maxOutputBytes: COMMAND_TAIL_BYTES,
      });
      assertTextSuccess("installed-byte-identity", "installed APK path", resolvedDeps.adbPath, pmPathArgs, pmPathResult);
      const observedPath = parseInstalledApkPath(pmPathResult.stdout);
      if (!observedPath) {
        throw new StageFailure("installed-byte-identity", commandFailure(
          "installed APK path",
          resolvedDeps.adbPath,
          pmPathArgs,
          pmPathResult,
          "expected exactly one installed base APK path",
        ));
      }
      const remoteDigestArgs = ["-s", input.serial, "shell", "toybox", "sha256sum", observedPath];
      const remoteDigestResult = await resolvedDeps.runText(resolvedDeps.adbPath, remoteDigestArgs, {
        timeoutMs: 20_000,
        maxOutputBytes: COMMAND_TAIL_BYTES,
      });
      assertTextSuccess("installed-byte-identity", "installed APK digest", resolvedDeps.adbPath, remoteDigestArgs, remoteDigestResult);
      const observedDigest = parseRemoteDigestLine(remoteDigestResult.stdout);
      if (!observedDigest || observedDigest.path !== observedPath || observedDigest.sha256 !== apk.sha256) {
        throw new StageFailure("installed-byte-identity", commandFailure(
          "installed APK digest",
          resolvedDeps.adbPath,
          remoteDigestArgs,
          remoteDigestResult,
          `expected one sha256sum for '${observedPath}' equal to immutable APK CAS sha256 ${apk.sha256}`,
        ));
      }
      if (requiredPath !== undefined && observedPath !== requiredPath) {
        throw new StageFailure("installed-byte-identity", commandFailure(
          "installed APK path continuity",
          resolvedDeps.adbPath,
          pmPathArgs,
          pmPathResult,
          `expected the installed base APK path to remain exactly '${requiredPath}'`,
        ));
      }
      return { path: observedPath, sha256: observedDigest.sha256 };
    };
    const installedApkIdentity = await probeInstalledApkIdentity();
    const remoteApkPath = installedApkIdentity.path;
    const remoteDigest = { sha256: installedApkIdentity.sha256 };
    completedStages.push("installed-byte-identity");

    if (input.afterInstall) {
      let afterInstall: Awaited<ReturnType<NonNullable<ProduceNativeFleetReceiptInput["afterInstall"]>>>;
      try {
        afterInstall = await input.afterInstall();
      } catch (error) {
        throw new StageFailure("after-install", `afterInstall threw: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (afterInstall.status !== "ok") throw new StageFailure("after-install", afterInstall.reason);
      completedStages.push("after-install");
    } else {
      completedStages.push("after-install:skipped");
    }

    const readProperty = async (propertyArgs: string[], label: string): Promise<string> => {
      const args = ["-s", input.serial, "shell", ...propertyArgs];
      const result = await resolvedDeps.runText(resolvedDeps.adbPath, args, { timeoutMs: 20_000, maxOutputBytes: COMMAND_TAIL_BYTES });
      assertTextSuccess("device-identity", label, resolvedDeps.adbPath, args, result);
      const value = result.stdout.trim();
      if (!value) {
        throw new StageFailure("device-identity", commandFailure(label, resolvedDeps.adbPath, args, result, "required a non-empty observed value"));
      }
      return value;
    };
    const model = await readProperty(["getprop", "ro.product.model"], "device model");
    const fingerprint = await readProperty(["getprop", "ro.build.fingerprint"], "device fingerprint");
    const bootQemu = await readProperty(["getprop", "ro.boot.qemu"], "device boot-qemu property");
    const bootId = await readProperty(["cat", "/proc/sys/kernel/random/boot_id"], "device boot ID");
    const requireSameBootId = async (boundary: string): Promise<void> => {
      const observedBootId = await readProperty(["cat", "/proc/sys/kernel/random/boot_id"], `${boundary} device boot ID`);
      if (observedBootId !== bootId) {
        throw new StageFailure(
          "device-identity",
          `${boundary} device boot ID changed: expected '${bootId}', observed '${observedBootId}'`,
        );
      }
    };
    const runtimeSessionId = resolvedDeps.randomUUID();
    if (!runtimeSessionId.trim()) throw new StageFailure("device-identity", "randomUUID returned an empty session identity");
    completedStages.push("device-identity");

    const packageListArgs = ["-s", input.serial, "shell", "pm", "list", "packages", "com.fleet"];
    const packageList = await resolvedDeps.runText(resolvedDeps.adbPath, packageListArgs, {
      timeoutMs: 20_000,
      maxOutputBytes: COMMAND_TAIL_BYTES,
    });
    assertTextSuccess("launch", "pre-launch fleet package sweep", resolvedDeps.adbPath, packageListArgs, packageList);
    for (const packageName of fleetPackages(packageList.stdout)) {
      const stopArgs = ["-s", input.serial, "shell", "am", "force-stop", packageName];
      const stopResult = await resolvedDeps.runText(resolvedDeps.adbPath, stopArgs, {
        timeoutMs: 20_000,
        maxOutputBytes: COMMAND_TAIL_BYTES,
      });
      assertTextSuccess("launch", `pre-launch force-stop ${packageName}`, resolvedDeps.adbPath, stopArgs, stopResult);
    }
    await resolvedDeps.sleep(PRE_LAUNCH_SETTLE_MS);
    completedStages.push("pre-launch-sweep");

    type PollDeadline = { deadlineMs: number };
    const startPollDeadline = (): PollDeadline => {
      const startedMs = resolvedDeps.monotonicNow();
      if (!Number.isFinite(startedMs)) throw new StageFailure("launch", "monotonic clock returned a non-finite value");
      return { deadlineMs: startedMs + PID_FOREGROUND_WINDOW_MS };
    };
    const remainingPollMs = (deadline: PollDeadline): number => {
      const observedMs = resolvedDeps.monotonicNow();
      if (!Number.isFinite(observedMs)) throw new StageFailure("pid", "monotonic clock returned a non-finite value");
      return Math.max(0, Math.floor(deadline.deadlineMs - observedMs));
    };
    type LaunchIdentity = {
      launchedAt: string;
      acknowledgementSha256: string;
      result: RunResult;
      pollDeadline: PollDeadline;
    };
    const launchOnce = async (): Promise<LaunchIdentity> => {
      await requireSameBootId("before activity launch");
      const args = ["-s", input.serial, "shell", "am", "start", "-n", input.component];
      const result = await resolvedDeps.runText(resolvedDeps.adbPath, args, {
        timeoutMs: 30_000,
        maxOutputBytes: COMMAND_TAIL_BYTES,
      });
      const output = resultText(result);
      if (
        result.code !== 0 || result.timedOut
        || /(?:^|\b)(?:Error|Exception|No activities found|device offline|aborted)(?:\b|:)/i.test(output)
        || !/(?:Starting:|Warning: Activity not started|Status: ok)/i.test(output)
      ) {
        throw new StageFailure("launch", commandFailure(
          "activity launch",
          resolvedDeps.adbPath,
          args,
          result,
          "required a positive activity-start acknowledgement",
        ));
      }
      return {
        launchedAt: resolvedDeps.now().toISOString(),
        acknowledgementSha256: sha256Text(output),
        result,
        pollDeadline: startPollDeadline(),
      };
    };

    type PidIdentity = { pid: number; pidStartTicks: string };
    const pollPidIdentity = async (deadline: PollDeadline): Promise<PidIdentity> => {
      const pidArgs = ["-s", input.serial, "shell", "pidof", input.packageName];
      let lastResult: RunResult = { code: 1, stdout: "", stderr: "", timedOut: false };
      for (let attempt = 0; attempt < PID_FOREGROUND_ATTEMPTS; attempt += 1) {
        const pidTimeoutMs = Math.min(20_000, remainingPollMs(deadline));
        if (pidTimeoutMs <= 0) break;
        lastResult = await resolvedDeps.runText(resolvedDeps.adbPath, pidArgs, {
          timeoutMs: pidTimeoutMs,
          maxOutputBytes: COMMAND_TAIL_BYTES,
        });
        if (lastResult.timedOut) assertTextSuccess("pid", "PID probe", resolvedDeps.adbPath, pidArgs, lastResult);
        if (lastResult.code === 0 && lastResult.stdout.trim()) {
          const pid = parsePid(lastResult.stdout);
          if (!pid) {
            throw new StageFailure("pid", commandFailure(
              "PID probe",
              resolvedDeps.adbPath,
              pidArgs,
              lastResult,
              "expected exactly one positive numeric PID",
            ));
          }
          const statArgs = ["-s", input.serial, "shell", "cat", `/proc/${pid}/stat`];
          const statTimeoutMs = Math.min(20_000, remainingPollMs(deadline));
          if (statTimeoutMs <= 0) break;
          const statResult = await resolvedDeps.runText(resolvedDeps.adbPath, statArgs, {
            timeoutMs: statTimeoutMs,
            maxOutputBytes: COMMAND_TAIL_BYTES,
          });
          assertTextSuccess("pid", "PID start identity", resolvedDeps.adbPath, statArgs, statResult);
          const pidStartTicks = parseProcStartTicks(statResult.stdout);
          if (!pidStartTicks) {
            throw new StageFailure("pid", commandFailure(
              "PID start identity",
              resolvedDeps.adbPath,
              statArgs,
              statResult,
              "could not parse Linux proc stat field 22 after the final process-name parenthesis",
            ));
          }
          return { pid, pidStartTicks };
        }
        if (lastResult.code !== 0 && lastResult.code !== 1) {
          assertTextSuccess("pid", "PID probe", resolvedDeps.adbPath, pidArgs, lastResult);
        }
        if (attempt + 1 >= PID_FOREGROUND_ATTEMPTS) break;
        const remainingMs = remainingPollMs(deadline);
        const sleepMs = Math.min(POLL_INTERVAL_MS, remainingMs);
        if (sleepMs <= 0 || sleepMs >= remainingMs) break;
        await resolvedDeps.sleep(sleepMs);
      }
      throw new StageFailure("pid", commandFailure(
        "PID probe",
        resolvedDeps.adbPath,
        pidArgs,
        lastResult,
        `no live PID identity appeared within the ${PID_FOREGROUND_WINDOW_MS}-millisecond overall PID/foreground poll window`,
      ));
    };

    type ForegroundPoll = { activity?: ForegroundActivity; lastResult: RunResult };
    const pollForeground = async (deadline: PollDeadline): Promise<ForegroundPoll> => {
      const args = ["-s", input.serial, "shell", "dumpsys", "activity", "activities"];
      let lastResult: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false };
      let lastActivity: ForegroundActivity | undefined;
      for (let attempt = 0; attempt < PID_FOREGROUND_ATTEMPTS; attempt += 1) {
        const timeoutMs = Math.min(20_000, remainingPollMs(deadline));
        if (timeoutMs <= 0) break;
        lastResult = await resolvedDeps.runText(resolvedDeps.adbPath, args, {
          timeoutMs,
          maxOutputBytes: TEXT_OUTPUT_LIMIT,
        });
        assertTextSuccess("foreground", "foreground probe", resolvedDeps.adbPath, args, lastResult);
        const activity = parseForegroundActivity(lastResult.stdout);
        if (activity) lastActivity = activity;
        if (activity?.packageName === input.packageName && activity.component === input.component) {
          return { activity, lastResult };
        }
        if (activity?.packageName === input.packageName && activity.component !== input.component) break;
        if (foregroundActivities(lastResult.stdout).length > 1) break;
        if (attempt + 1 >= PID_FOREGROUND_ATTEMPTS) break;
        const remainingMs = remainingPollMs(deadline);
        const sleepMs = Math.min(POLL_INTERVAL_MS, remainingMs);
        if (sleepMs <= 0 || sleepMs >= remainingMs) break;
        await resolvedDeps.sleep(sleepMs);
      }
      return { activity: lastActivity, lastResult };
    };

    let launchIdentity = await launchOnce();
    completedStages.push("launch");
    let pidIdentity = await pollPidIdentity(launchIdentity.pollDeadline);
    completedStages.push("pid");
    let foreground = await pollForeground(launchIdentity.pollDeadline);
    if (!foreground.activity || foreground.activity.packageName !== input.packageName || foreground.activity.component !== input.component) {
      const blocker = foreground.activity?.packageName !== input.packageName ? foreground.activity?.packageName : undefined;
      if (blocker) {
        const stopArgs = ["-s", input.serial, "shell", "am", "force-stop", blocker];
        const stopResult = await resolvedDeps.runText(resolvedDeps.adbPath, stopArgs, {
          timeoutMs: 20_000,
          maxOutputBytes: COMMAND_TAIL_BYTES,
        });
        assertTextSuccess("foreground", `foreground blocker force-stop ${blocker}`, resolvedDeps.adbPath, stopArgs, stopResult);
        completedStages.push(`foreground-recovery:blocker=${blocker}`);
        await resolvedDeps.sleep(PRE_LAUNCH_SETTLE_MS);
        launchIdentity = await launchOnce();
        completedStages.push("launch-recovery");
        pidIdentity = await pollPidIdentity(launchIdentity.pollDeadline);
        completedStages.push("pid-recovery");
        foreground = await pollForeground(launchIdentity.pollDeadline);
      }
    }
    if (!foreground.activity || foreground.activity.packageName !== input.packageName || foreground.activity.component !== input.component) {
      const args = ["-s", input.serial, "shell", "dumpsys", "activity", "activities"];
      throw new StageFailure("foreground", commandFailure(
        "foreground probe",
        resolvedDeps.adbPath,
        args,
        foreground.lastResult,
        `required exact foreground component '${input.component}'`,
      ));
    }
    completedStages.push("foreground");

    await resolvedDeps.sleep(input.settleMs);
    completedStages.push("settle");

    const observe = async (): Promise<NativeRunReceiptPayload["capture"]["before"]> => {
      const pidArgs = ["-s", input.serial, "shell", "pidof", input.packageName];
      const pidResult = await resolvedDeps.runText(resolvedDeps.adbPath, pidArgs, {
        timeoutMs: 20_000,
        maxOutputBytes: COMMAND_TAIL_BYTES,
      });
      assertTextSuccess("pid", "capture PID continuity", resolvedDeps.adbPath, pidArgs, pidResult);
      const observedPid = parsePid(pidResult.stdout);
      if (observedPid !== pidIdentity.pid) {
        throw new StageFailure("pid", commandFailure(
          "capture PID continuity",
          resolvedDeps.adbPath,
          pidArgs,
          pidResult,
          `expected the single launch PID ${pidIdentity.pid}`,
        ));
      }
      const statArgs = ["-s", input.serial, "shell", "cat", `/proc/${pidIdentity.pid}/stat`];
      const statResult = await resolvedDeps.runText(resolvedDeps.adbPath, statArgs, {
        timeoutMs: 20_000,
        maxOutputBytes: COMMAND_TAIL_BYTES,
      });
      assertTextSuccess("pid", "capture PID-start continuity", resolvedDeps.adbPath, statArgs, statResult);
      const observedStartTicks = parseProcStartTicks(statResult.stdout);
      if (observedStartTicks !== pidIdentity.pidStartTicks) {
        throw new StageFailure("pid", commandFailure(
          "capture PID-start continuity",
          resolvedDeps.adbPath,
          statArgs,
          statResult,
          `expected PID start ticks ${pidIdentity.pidStartTicks}`,
        ));
      }
      const foregroundArgs = ["-s", input.serial, "shell", "dumpsys", "activity", "activities"];
      const foregroundResult = await resolvedDeps.runText(resolvedDeps.adbPath, foregroundArgs, {
        timeoutMs: 20_000,
        maxOutputBytes: TEXT_OUTPUT_LIMIT,
      });
      assertTextSuccess("foreground", "capture foreground continuity", resolvedDeps.adbPath, foregroundArgs, foregroundResult);
      const observedForeground = parseForegroundActivity(foregroundResult.stdout);
      if (observedForeground?.packageName !== input.packageName || observedForeground.component !== input.component) {
        throw new StageFailure("foreground", commandFailure(
          "capture foreground continuity",
          resolvedDeps.adbPath,
          foregroundArgs,
          foregroundResult,
          `required exact foreground component '${input.component}'`,
        ));
      }
      return {
        observedAt: resolvedDeps.now().toISOString(),
        foregroundPackage: observedForeground.packageName,
        foregroundComponent: observedForeground.component,
        pid: observedPid,
        pidStartTicks: observedStartTicks,
      };
    };

    await probeInstalledApkIdentity(remoteApkPath);
    await requireSameBootId("before capture");
    const before = await observe();
    completedStages.push("before-observation");
    const captureArgs = ["-s", input.serial, "exec-out", "screencap", "-p"];
    const captureResult = await resolvedDeps.runBinary(resolvedDeps.adbPath, captureArgs, {
      timeoutMs: 30_000,
      maxOutputBytes: CAPTURE_OUTPUT_LIMIT,
    });
    if (captureResult.code !== 0 || captureResult.timedOut) {
      throw new StageFailure("capture", commandFailure(
        "binary screencap",
        resolvedDeps.adbPath,
        captureArgs,
        captureResult,
        "capture command did not complete successfully",
      ));
    }
    const captureBytes = Buffer.from(captureResult.stdout);
    const capturedAt = resolvedDeps.now().toISOString();
    completedStages.push("capture");
    await probeInstalledApkIdentity(remoteApkPath);
    await requireSameBootId("after capture");
    const after = await observe();
    completedStages.push("after-observation");

    let capture: ReturnType<typeof materializeCaptureBytes>;
    let captureSourcePath: string;
    try {
      const uniqueCapturePath = path.join(path.resolve(input.captureDir), `${runtimeSessionId}.png`);
      captureSourcePath = writeUniqueCapture(uniqueCapturePath, captureBytes, resolvedDeps.randomUUID);
      capture = materializeCaptureBytes(captureSourcePath, captureBytes);
    } catch (error) {
      throw new StageFailure("capture-publication", error instanceof Error ? error.message : String(error));
    }
    completedStages.push("capture-publication");

    let receipt: PublishedNativeRunReceipt;
    try {
      const payload: NativeRunReceiptPayload = {
        kind: "pico.native-run-receipt",
        schemaVersion: 1,
        createdAt: resolvedDeps.now().toISOString(),
        scope: "fleet-native-debug",
        app: input.packageName,
        source: { authoredAppSpec, effectiveAppSpec, gradleInputs },
        build: {
          task: input.task,
          outcome: "success",
          startedAt: buildStartedAt,
          finishedAt: buildFinishedAt,
          outputMetadata: {
            path: outputMetadata.path,
            sha256: outputMetadata.sha256,
            bytes: outputMetadata.bytes.length,
          },
        },
        apk: {
          ...apk,
          packageName: input.packageName,
          manifestInspection: inspection.manifestInspection,
          signingInspection: inspection.signingInspection,
        },
        install: {
          status: "success",
          method: "adb-install-replace",
          completedAt: installCompletedAt,
          packageName: input.packageName,
          remoteApkPath,
          remoteApkSha256: remoteDigest.sha256,
          acknowledgementSha256: installAcknowledgementSha256,
        },
        runtime: {
          sessionId: runtimeSessionId,
          serial: input.serial,
          model,
          fingerprint,
          bootQemu,
          bootId,
          component: input.component,
          launchedAt: launchIdentity.launchedAt,
          launchAcknowledgementSha256: launchIdentity.acknowledgementSha256,
          pid: pidIdentity.pid,
          pidStartTicks: pidIdentity.pidStartTicks,
        },
        capture: {
          capturedAt,
          sourcePath: captureSourcePath,
          artifactPath: capture.artifactPath,
          sha256: capture.capture.sha256,
          bytes: capture.capture.bytes,
          width: capture.capture.width,
          height: capture.capture.height,
          format: "png",
          before,
          after,
        },
      };
      receipt = publishNativeRunReceipt(payload);
    } catch (error) {
      throw new StageFailure("receipt-publication", error instanceof Error ? error.message : String(error));
    }
    completedStages.push("receipt-publication");
    return { status: "recorded", built: true, installed: true, receipt };
  } catch (error) {
    const failure = error instanceof StageFailure
      ? error
      : new StageFailure("receipt-publication", error instanceof Error ? error.message : String(error));
    return {
      status: "failed",
      stage: failure.stage,
      built,
      installed,
      reason: stageReason(failure.stage, failure),
      completedStages: [...completedStages],
    };
  }
}
