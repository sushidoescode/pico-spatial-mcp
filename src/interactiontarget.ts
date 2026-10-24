import { z } from "zod";
import { canonicalIdentity } from "./runreceiptidentity.js";
import { probeDeviceIdentity } from "./deviceidentity.js";
import { parseInstalledApkPath, parsePid, parseProcStartTicks, parseRemoteSha256 } from "./nativefleetreceipt.js";
import { parseOnlineAdbSerials } from "./observation.js";
import { run } from "./util.js";

export const emulatorSerialSchema = z.string().regex(/^emulator-[0-9]{1,6}$/);
export const interactionPackageSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/).max(180);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const interactionTargetIdentitySchema = z.object({
  serial: emulatorSerialSchema,
  packageName: interactionPackageSchema,
  model: z.string().min(1).max(512),
  fingerprint: z.string().min(1).max(2048),
  bootQemu: z.literal("1"),
  bootId: z.string().uuid(),
  apkSha256: sha256Schema,
  pid: z.number().int().positive().safe(),
  pidStartTicks: z.string().regex(/^[0-9]{1,32}$/),
  appGeneration: z.string().uuid(),
}).strict();
export type InteractionTargetIdentity = z.infer<typeof interactionTargetIdentitySchema>;
export type InteractionTargetV1 = Readonly<InteractionTargetIdentity & {
  schemaVersion: 1;
  bindingSha256: string;
  observedAt: string;
  enforcementScope: "interaction-session-only";
}>;
export interface InteractionProbeBudget {deadlineEpochMs:number;signal?:AbortSignal;now?:()=>number}
function checkBudget(budget?:InteractionProbeBudget) {
  if(budget && (budget.signal?.aborted || (budget.now?.()??Date.now())>=budget.deadlineEpochMs)) throw new Error("target probe cancelled/deadline elapsed");
}
export interface InteractionTargetProbes {
  listOnlineSerials(budget?:InteractionProbeBudget): Promise<string[]>;
  probe(serial: string, packageName: string,budget?:InteractionProbeBudget): Promise<InteractionTargetIdentity>;
}

/** No discovery default: only the requested serial is probed, even in a mixed device list. */
export async function bindInteractionTarget(
  request: { serial: string; packageName: string; expectedApkSha256: string },
  probes: InteractionTargetProbes,
  budget?:InteractionProbeBudget,
): Promise<InteractionTargetV1> {
  const serial = emulatorSerialSchema.parse(request.serial);
  const packageName = interactionPackageSchema.parse(request.packageName);
  const expected = sha256Schema.parse(request.expectedApkSha256);
  checkBudget(budget);
  const online = await probes.listOnlineSerials(budget);
  checkBudget(budget);
  if (online.filter((s) => s === serial).length !== 1) throw new Error("explicit emulator is absent or ambiguous; no target fallback");
  const observed = interactionTargetIdentitySchema.parse(await probes.probe(serial, packageName,budget));
  checkBudget(budget);
  if (observed.serial !== serial || observed.packageName !== packageName || observed.apkSha256 !== expected) {
    throw new Error("target/package/installed APK differs from requested binding");
  }
  return Object.freeze({ ...observed, schemaVersion: 1, bindingSha256: canonicalIdentity(observed).sha256,
    observedAt: new Date().toISOString(), enforcementScope: "interaction-session-only" });
}

/** Lifecycle drift is interference evidence, never proof that an external writer was blocked. */
export async function revalidateInteractionTarget(target: InteractionTargetV1, probes: InteractionTargetProbes,budget?:InteractionProbeBudget): Promise<void> {
  const current = await bindInteractionTarget({ serial: target.serial, packageName: target.packageName, expectedApkSha256: target.apkSha256 }, probes,budget);
  if (current.bindingSha256 !== target.bindingSha256) throw new Error("target lifecycle changed; external/legacy interference is possible (not fenced)");
}

/** Reuses the raw device/receipt parsers and the existing Bridge readback. No launch or discovery. */
export function liveInteractionTargetProbes(adb: string, observe: (timeoutMs?: number) => Promise<{
  packageName: string; generation: string; pid: number; pidStartTicks: string;
}>): InteractionTargetProbes {
  const checked = async (args: string[],budget?:InteractionProbeBudget) => {
    checkBudget(budget);
    const remaining=budget?budget.deadlineEpochMs-(budget.now?.()??Date.now()):4_000;
    const r = await run(adb, args, { timeoutMs: Math.min(4_000,remaining), maxOutputBytes: 128 * 1024,signal:budget?.signal });
    checkBudget(budget);
    if (r.code !== 0 || r.timedOut) throw new Error(`target probe failed: ${r.stderr.slice(0, 500) || r.code}`);
    return r.stdout.trim();
  };
  return {
    async listOnlineSerials(budget) { return parseOnlineAdbSerials(await checked(["devices", "-l"],budget)); },
    async probe(serial, packageName,budget) {
      emulatorSerialSchema.parse(serial); interactionPackageSchema.parse(packageName);
      const shell = (args: string[]) => checked(["-s", serial, "shell", ...args],budget);
      const device = await probeDeviceIdentity(adb, serial,budget);
      if (device.bootQemu !== "1") throw new Error("requested target is not an observed emulator");
      const bootId = await shell(["cat", "/proc/sys/kernel/random/boot_id"]);
      const apkPath = parseInstalledApkPath(await shell(["pm", "path", packageName]));
      if (!apkPath || !/^\/[A-Za-z0-9_./=+@~-]+\.apk$/.test(apkPath)) throw new Error("single installed APK path not resolved");
      const apkSha256 = parseRemoteSha256(await shell(["sha256sum", apkPath]));
      const pid = parsePid(await shell(["pidof", packageName]));
      if (!pid) throw new Error("app is offline or has multiple processes");
      const pidStartTicks = parseProcStartTicks(await shell(["cat", `/proc/${pid}/stat`]));
      checkBudget(budget);
      const state = await observe(Math.min(4_000,budget?budget.deadlineEpochMs-(budget.now?.()??Date.now()):4_000));
      checkBudget(budget);
      if (state.packageName !== packageName || state.pid !== pid || state.pidStartTicks !== pidStartTicks) throw new Error("Bridge state belongs to a different app process");
      // Double read guards a restart midway through the multi-command identity probe.
      if (await shell(["cat", "/proc/sys/kernel/random/boot_id"]) !== bootId
        || parsePid(await shell(["pidof", packageName])) !== pid
        || parseProcStartTicks(await shell(["cat", `/proc/${pid}/stat`])) !== pidStartTicks) throw new Error("target changed during probe");
      return interactionTargetIdentitySchema.parse({ ...device, packageName, bootId, apkSha256, pid, pidStartTicks, appGeneration: state.generation });
    },
  };
}
