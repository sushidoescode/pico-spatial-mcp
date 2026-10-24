import { run, runBinary } from "./util.js";
import { adbExecutable } from "./adb.js";

/** Raw adb identity captured at the same time as a device verification. */
export interface DeviceLineageInput {
  serial?: unknown;
  model?: unknown;
  fingerprint?: unknown;
  bootQemu?: unknown;
}

export interface ValidatedDeviceLineage {
  serial: string;
  model: string;
  fingerprint: string;
  bootQemu: string;
  identityClass: "pico-hardware-shaped";
}

export interface ProbedDeviceIdentity {
  serial: string;
  model: string;
  fingerprint: string;
  bootQemu: string;
}

export interface RecordedDeviceLineageInput extends DeviceLineageInput {
  source?: unknown;
  observedAt?: unknown;
  captureSource?: unknown;
  deviceCaptureSha256?: unknown;
  artifactSha256?: unknown;
}

export type DeviceIdentityProbe = (serial: string) => Promise<ProbedDeviceIdentity>;
export type DeviceCaptureProbe = (serial: string) => Promise<Buffer>;

/**
 * Classify raw Android identity. Real Swan values have not been measured in this repository, so
 * this deliberately claims only that the supplied identity is PICO-shaped and lacks known
 * emulator markers. It is a provenance gate, not device attestation or remote authentication.
 */
export function classifyDeviceIdentity(model: string, fingerprint: string, bootQemu?: string): { looksLikePico: boolean; reason: string } {
  const m = (model ?? "").trim();
  const f = (fingerprint ?? "").trim();
  if ((bootQemu ?? "").trim() === "1" || /emulator|qemu/i.test(m) || /emulator|qemu/i.test(f))
    return { looksLikePico: false, reason: "emulator markers present (ro.boot.qemu=1 or 'emulator'/'qemu' in model/fingerprint)" };
  if (!m && !f) return { looksLikePico: false, reason: "identity probe returned no model or fingerprint" };
  if (/pico|swan/i.test(m) || /pico|swan/i.test(f)) return { looksLikePico: true, reason: `model '${m}' / fingerprint '${f.slice(0, 60)}' carry PICO hardware markers` };
  return { looksLikePico: false, reason: `model '${m}' and fingerprint '${f.slice(0, 60)}' do not identify PICO hardware` };
}

/** Validate that a strongest-tier ledger row carries enough raw identity to reject known emulators. */
export function validateDeviceLineage(input: DeviceLineageInput): { ok: true; lineage: ValidatedDeviceLineage } | { ok: false; reason: string } {
  const missing: string[] = [];
  if (typeof input.serial !== "string" || !input.serial.trim()) missing.push("deviceSerial");
  if (typeof input.model !== "string" || !input.model.trim()) missing.push("deviceModel");
  if (typeof input.fingerprint !== "string" || !input.fingerprint.trim()) missing.push("deviceFingerprint");
  // An empty getprop value is meaningful on hardware; absence of the field is not.
  if (typeof input.bootQemu !== "string") missing.push("deviceBootQemu");
  if (missing.length) return { ok: false, reason: `missing hardware-lineage field(s): ${missing.join(", ")}` };

  const serial = (input.serial as string).trim();
  const model = (input.model as string).trim();
  const fingerprint = (input.fingerprint as string).trim();
  const bootQemu = (input.bootQemu as string).trim();
  if (/^emulator-/i.test(serial)) return { ok: false, reason: `serial '${serial}' is emulator-shaped` };
  const classified = classifyDeviceIdentity(model, fingerprint, bootQemu);
  if (!classified.looksLikePico) return { ok: false, reason: classified.reason };
  return { ok: true, lineage: { serial, model, fingerprint, bootQemu, identityClass: "pico-hardware-shaped" } };
}

/** A persisted strongest-tier row must say that the raw values came from the live probe path. */
export function validateRecordedDeviceLineage(input: RecordedDeviceLineageInput): { ok: true; lineage: ValidatedDeviceLineage; observedAt: string; captureSha256: string } | { ok: false; reason: string } {
  const raw = validateDeviceLineage(input);
  if (!raw.ok) return raw;
  if (input.source !== "adb-live-probe") return { ok: false, reason: "missing adb-live-probe provenance marker" };
  if (typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) return { ok: false, reason: "missing or invalid live-probe timestamp" };
  if (input.captureSource !== "adb-exec-out-screencap") return { ok: false, reason: "missing live adb screencap provenance marker" };
  if (typeof input.deviceCaptureSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.deviceCaptureSha256)) return { ok: false, reason: "missing live device-capture sha256" };
  if (input.deviceCaptureSha256 !== input.artifactSha256) return { ok: false, reason: "stored artifact sha256 does not match the live device-capture sha256" };
  return { ok: true, lineage: raw.lineage, observedAt: input.observedAt, captureSha256: input.deviceCaptureSha256 };
}

/** THE shared adb lookup (src/adb.ts): explicit $PICO_ADB -> PATH -> the SELECTED toolchain's
 *  bundled platform-tools, identity-keyed so a replaced adb is observed without a restart. */
export function resolveDeviceAdb(): string {
  return adbExecutable();
}

/** Probe raw identity directly from one currently attached adb serial. */
export async function probeDeviceIdentity(adb: string, serial: string, budget?: {deadlineEpochMs:number;signal?:AbortSignal}): Promise<ProbedDeviceIdentity> {
  const prop = async (name: string) => {
    const remaining = budget ? budget.deadlineEpochMs - Date.now() : 10_000;
    if (remaining <= 0 || budget?.signal?.aborted) throw new Error("identity probe cancelled/deadline elapsed");
    const result = await run(adb, ["-s", serial, "shell", "getprop", name], { timeoutMs: Math.min(budget ? 4_000 : 10_000,remaining), signal:budget?.signal });
    if (result.code !== 0 || result.timedOut) throw new Error(`adb identity probe '${name}' failed for '${serial}' (exit ${result.code}${result.timedOut ? ", timeout" : ""}): ${result.stderr.trim() || "no stderr"}`);
    return result.stdout.trim();
  };
  return {
    serial,
    model: await prop("ro.product.model"),
    fingerprint: await prop("ro.build.fingerprint"),
    bootQemu: await prop("ro.boot.qemu"),
  };
}

/** Capture the exact current framebuffer bytes from one currently attached adb serial. */
export async function probeDeviceCapture(adb: string, serial: string): Promise<Buffer> {
  const result = await runBinary(adb, ["-s", serial, "exec-out", "screencap", "-p"], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut) throw new Error(`adb screencap failed for '${serial}' (exit ${result.code}${result.timedOut ? ", timeout" : ""}): ${result.stderr.trim() || "no stderr"}`);
  return result.stdout;
}

/**
 * Mint ledger lineage from an observed probe, never from caller strings. Optional caller identity
 * fields are comparison guards: a mismatch rejects instead of recording the probed device under a
 * different expected identity. The probe parameter is injected so CI can test this flow without
 * claiming that its fixtures came from hardware.
 */
export async function verifyLiveDeviceLineage(
  expected: DeviceLineageInput,
  probe: DeviceIdentityProbe,
): Promise<{ ok: true; lineage: ValidatedDeviceLineage; source: "adb-live-probe"; observedAt: string } | { ok: false; reason: string }> {
  if (typeof expected.serial !== "string" || !expected.serial.trim()) return { ok: false, reason: "device_verified requires deviceSerial so adb can probe that exact device" };
  let observed: ProbedDeviceIdentity;
  try {
    observed = await probe(expected.serial.trim());
  } catch (error: any) {
    return { ok: false, reason: `live adb identity probe failed: ${error?.message ?? String(error)}` };
  }
  if (observed.serial.trim() !== expected.serial.trim()) return { ok: false, reason: `live probe returned serial '${observed.serial}' for requested serial '${expected.serial}'` };
  for (const [field, wanted, got] of [
    ["deviceModel", expected.model, observed.model],
    ["deviceFingerprint", expected.fingerprint, observed.fingerprint],
    ["deviceBootQemu", expected.bootQemu, observed.bootQemu],
  ] as Array<[string, unknown, string]>) {
    if (typeof wanted === "string" && wanted.trim() !== got.trim()) return { ok: false, reason: `${field} did not match the live adb probe` };
  }
  const checked = validateDeviceLineage(observed);
  if (!checked.ok) return checked;
  return { ok: true, lineage: checked.lineage, source: "adb-live-probe", observedAt: new Date().toISOString() };
}
