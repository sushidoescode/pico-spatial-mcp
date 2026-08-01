import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, run } from "./util.js";

/**
 * swanparity.ts — v5.9 SWAN ON-DEVICE PARITY: flip the "built-for-headset" column to device-verified.
 *
 * The single biggest honesty upgrade. `swan_verify_matrix` turns every C1–C4 built-for-Swan row into an
 * executable on-device re-test with its emulator baseline and expected device result, records the
 * emulator→device delta in a PARITY LEDGER. When a Swan is attached over USB it marks those rows
 * device_pending — the flip to device-vision-verified still requires the actual on-device vision pass +
 * a linked capture (recorded via record_verification), never auto-granted. With NO Swan today it returns the
 * matrix in `awaiting_swan` state (wired, cannot crash the loop). The C1–C4 catalogue IS the test plan
 * (0-planes-on-emulator → real planes on Swan; pins-float → pins-snap; broadcast-drive → real trigger;
 * MEASURED-ROOM infeasible on the emulator → the headset is the only way to close the walls/ceiling gap).
 *
 * v31 closes two day-one defects:
 *  - HARDWARE-IDENTITY GATE: "any non-emulator serial" is not a Swan. A Quest 3 on this desk and the
 *    PICO emulator reattached over adb-over-TCP both present non-`emulator-` serials. The gate probes
 *    getprop identity and demands an explicit assumeSwan override for anything that doesn't look like
 *    PICO hardware.
 *  - PARITY CLOSURE: the tool now reads `device_verified` trust-ledger entries back and marks matched
 *    rows closed, MERGING with the existing parity file instead of overwriting — so a closed row is
 *    structurally reachable (and never reopened by a later run with weaker evidence).
 */

function resolveAdb(): string {
  const c = [process.env.PICO_ADB, path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb"), "/opt/homebrew/bin/adb", "adb"].filter(Boolean) as string[];
  for (const x of c) if (x === "adb" || fs.existsSync(x)) return x;
  return "adb";
}

// The C1–C4 re-test catalogue: each headset-only capability, its emulator baseline, and the device test.
const MATRIX: Record<string, { cClass: string; emulatorBaseline: string; deviceTest: string; expectedOnDevice: string }> = {
  scene_understanding: { cClass: "C1", emulatorBaseline: "PlaneTrackingManager RUNNING but 0 planes → pins float", deviceTest: "launch, raycast onto a detected plane, place a pin, capture", expectedOnDevice: "real planes; the pin snaps ONTO a physical surface (LOOK)" },
  world_anchor: { cClass: "C1", emulatorBaseline: "world tracking returns nothing (anchor no-ops)", deviceTest: "create a world anchor, relaunch, confirm re-localization", expectedOnDevice: "anchor persists + re-localizes across sessions" },
  measured_room: { cClass: "C1", emulatorBaseline: "home bedroom is a Unity black box → geometry unmeasurable; only floor y=0 vision-verified", deviceTest: "run scene mesh/plane capture, measure walls/ceiling", expectedOnDevice: "real room mesh → walls/ceiling measured (closes the emulator gap)" },
  controller_ray: { cClass: "C3", emulatorBaseline: "no 6DOF controller + gated trigger → broadcast-emulated select", deviceTest: "point the controller ray at an interactable, pull the trigger", expectedOnDevice: "the real controller ray selects; highlight moves (LOOK)" },
  hand_pinch: { cClass: "C3", emulatorBaseline: "hand tracking returns no hands", deviceTest: "pinch on a menu button / interactable", expectedOnDevice: "the pinch selects (LOOK)" },
  in_front_panel: { cClass: "C4", emulatorBaseline: "stage-vs-window dichotomy → no room + in-front Compose panel together", deviceTest: "open the in-front Compose panel over the scene, click a button", expectedOnDevice: "the panel renders in front + is clickable (LOOK)" },
};

const PARITY_DIR = path.join(os.homedir(), ".pico-mcp", "parity");
const parityPath = (app: string) => path.join(PARITY_DIR, `${app.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
const ledgerPath = (app: string) => path.join(os.homedir(), ".pico-mcp", "ledgers", `${app.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

function loadLedgerEntries(app: string): any[] {
  try {
    const arr = JSON.parse(fs.readFileSync(ledgerPath(app), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function builtForHeadsetFromLedger(app: string): string[] {
  return loadLedgerEntries(app)
    .filter((e: any) => e.evidenceType === "built_for_headset" && !e.retracted)
    .map((e: any) => String(e.claim ?? ""));
}

/** Fold underscores/hyphens/slashes into spaces + lowercase, so "controller-ray select" matches "controller_ray". */
export function normalizeFeatureText(s: string): string {
  return s.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The ledger's cClass enum ("C4_headset_only"/"C0_emulator") vs the matrix's short class ("C4"/"C0"). */
export function normalizeCClass(c?: string | null): string {
  return (c ?? "").replace(/_headset_only$/, "").replace(/_emulator$/, "");
}

/**
 * v31 hardware-identity classifier. Grounded in values MEASURED on this machine (2026-08-01):
 *   - the PICO emulator's own fingerprint is "Pico/swan_oversea/pico_spaceos_oversea_emulator_arm64:…:user/test-keys"
 *     with ro.boot.qemu=1 and model "SDK Spaceos Oversea built for arm64" — so PICO-ish strings alone
 *     must NOT pass; emulator/qemu markers veto FIRST (this is exactly what adb-over-TCP reattach looks like);
 *   - a Meta Quest 3 over USB reported model "Quest 3", fingerprint "oculus/eureka/eureka:14/…".
 * Real Swan hardware getprop values are UNVERIFIED (none has ever been attached to this rig) — the
 * PICO markers are inferred from the emulator's own build strings, which is why the tools take an
 * explicit assumeSwan override instead of hard-failing on an unrecognized device.
 */
export function classifyDeviceIdentity(model: string, fingerprint: string, bootQemu?: string): { looksLikePico: boolean; reason: string } {
  const m = (model ?? "").trim();
  const f = (fingerprint ?? "").trim();
  if ((bootQemu ?? "").trim() === "1" || /emulator|qemu/i.test(m) || /emulator|qemu/i.test(f))
    return { looksLikePico: false, reason: "emulator markers present (ro.boot.qemu=1 or 'emulator' in model/fingerprint) — this is an emulator (e.g. reattached over adb-over-TCP), not hardware" };
  if (!m && !f) return { looksLikePico: false, reason: "identity probe returned nothing (device offline/unauthorized?) — cannot confirm PICO hardware" };
  if (/pico|swan/i.test(m) || /pico|swan/i.test(f)) return { looksLikePico: true, reason: `model '${m}' / fingerprint '${f.slice(0, 60)}' carry PICO hardware markers` };
  return { looksLikePico: false, reason: `model '${m}' does not look like PICO hardware (a phone or another vendor's headset — a Quest 3 was the live example)` };
}

export interface DeviceIdentity {
  serial: string;
  model: string;
  fingerprint: string;
  bootQemu: string;
  looksLikePico: boolean;
  reason: string;
}

/** Probe a serial's hardware identity via getprop. Exported for deploy_to_device + the TCP rehearsal. */
export async function probeDeviceIdentity(adb: string, serial: string): Promise<DeviceIdentity> {
  const prop = async (name: string) => (await run(adb, ["-s", serial, "shell", "getprop", name], { timeoutMs: 10_000 })).stdout.trim();
  const model = await prop("ro.product.model");
  const fingerprint = await prop("ro.build.fingerprint");
  const bootQemu = await prop("ro.boot.qemu");
  return { serial, model, fingerprint, bootQemu, ...classifyDeviceIdentity(model, fingerprint, bootQemu) };
}

/**
 * Match ACTIVE (non-retracted) device_verified trust-ledger entries to matrix features. The contract
 * (documented in the tool description): an entry closes feature K when its cClass (normalized —
 * C4_headset_only ↔ C4) equals K's cClass AND its normalized claim contains K's keyword with
 * underscores/hyphens/spaces folded together (so "controller-ray select fires" closes controller_ray).
 */
export function deviceVerifiedMatches(app: string): Record<string, { seq: number; claim: string; captureSha256: string | null; deviceSerial: string | null }> {
  const entries = loadLedgerEntries(app).filter((e: any) => e?.evidenceType === "device_verified" && !e?.retracted);
  const out: Record<string, { seq: number; claim: string; captureSha256: string | null; deviceSerial: string | null }> = {};
  for (const [key, spec] of Object.entries(MATRIX)) {
    const kw = normalizeFeatureText(key);
    const hit = entries.find((e: any) => normalizeCClass(e.cClass) === spec.cClass && normalizeFeatureText(String(e.claim ?? "")).includes(kw));
    if (hit) out[key] = { seq: hit.seq, claim: hit.claim, captureSha256: hit.capture?.sha256 ?? null, deviceSerial: hit.deviceSerial ?? null };
  }
  return out;
}

export interface ParityRow {
  feature: string;
  cClass: string;
  emulator: string;
  device: string;
  verifiedBy: string;
  captureSha256?: string | null;
  deviceSerial?: string | null;
  closedByClaim?: string;
}

/** Build parity rows for `keys`: ledger-closed rows come back device_verified (with capture sha + serial). */
export function buildParityRows(app: string, keys: string[], swanSerial: string | null): ParityRow[] {
  const closed = deviceVerifiedMatches(app);
  return keys.map((k) => {
    const m = MATRIX[k];
    const c = closed[k];
    if (c) return { feature: k, cClass: m.cClass, emulator: m.emulatorBaseline, device: "device_verified", verifiedBy: "device_verified", captureSha256: c.captureSha256, deviceSerial: c.deviceSerial, closedByClaim: c.claim };
    return { feature: k, cClass: m.cClass, emulator: m.emulatorBaseline, device: swanSerial ? "pending_capture" : "awaiting_device", verifiedBy: swanSerial ? "swan_pending" : "built_for_headset" };
  });
}

/**
 * MERGE rows into the app's parity file (never overwrite): a row already closed (device_verified) on
 * disk is kept over any weaker replacement, and features from earlier runs outside `rows` survive.
 */
export function mergeParityFile(app: string, rows: ParityRow[], swanAttached: boolean, deviceIdentity?: { serial: string; model: string; fingerprint: string }): { path: string; rows: ParityRow[] } {
  fs.mkdirSync(PARITY_DIR, { recursive: true });
  let prev: ParityRow[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(parityPath(app), "utf8"));
    prev = Array.isArray(j?.rows) ? j.rows : [];
  } catch {
    /* first run for this app */
  }
  const byFeature = new Map(prev.map((r) => [r.feature, r]));
  for (const r of rows) {
    const old = byFeature.get(r.feature);
    if (old?.verifiedBy === "device_verified" && r.verifiedBy !== "device_verified") continue; // never reopen a closed row
    byFeature.set(r.feature, r);
  }
  const merged = [...byFeature.values()];
  fs.writeFileSync(parityPath(app), JSON.stringify({ app, swanAttached, ...(deviceIdentity ? { deviceIdentity } : {}), rows: merged }, null, 2));
  return { path: parityPath(app), rows: merged };
}

export function registerSwanParityTools(server: McpServer) {
  server.registerTool(
    "swan_verify_matrix",
    {
      description:
        "The v5.9 emulator→device parity gate. For an app's headset-only (C1/C3/C4) features it emits an EXECUTABLE re-test matrix — each row's emulator baseline, the exact on-device test, and the expected device result — and records the emulator→device delta in a parity ledger. HARDWARE-IDENTITY GATE (v31): a non-emulator serial is probed via getprop (ro.product.model + ro.build.fingerprint + ro.boot.qemu, all included in the result); anything that doesn't look like PICO hardware — a phone, a Quest, or the emulator reattached over adb-over-TCP — is NOT treated as a Swan unless you pass assumeSwan:true. PARITY CLOSURE: active device_verified trust-ledger entries are matched to matrix features (match contract: entry cClass equals the row's cClass with C4_headset_only↔C4 normalized, AND the entry's claim contains the feature keyword with underscores/hyphens/spaces folded — e.g. 'controller-ray select fires' closes controller_ray); matched rows flip to device_verified carrying the capture sha256 + deviceSerial, and results MERGE into the existing parity file — a closed row is never reopened by a later run. The flip still only ever comes from record_verification evidence, never auto-granted. Features default to the trust ledger's built_for_headset rows (or pass explicit keys: scene_understanding/world_anchor/measured_room/controller_ray/hand_pinch/in_front_panel).",
      inputSchema: {
        app: z.string().describe("App name/package (parity ledger key)."),
        features: z.array(z.enum(["scene_understanding", "world_anchor", "measured_room", "controller_ray", "hand_pinch", "in_front_panel"])).optional().describe("Headset features to re-test (default: derived from the trust ledger's built_for_headset rows, else all)."),
        assumeSwan: z.boolean().optional().describe("Override the hardware-identity gate: treat a non-emulator serial as the Swan even though its getprop identity does not look like PICO hardware. The probe result is still recorded."),
      },
    },
    async ({ app, features, assumeSwan }) => {
      const adb = resolveAdb();
      const devs = (await run(adb, ["devices"], { timeoutMs: 10_000 })).stdout
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean);
      const candidate = devs.find((d) => d && !/^emulator-/.test(d)) ?? null;
      const identity = candidate ? await probeDeviceIdentity(adb, candidate) : null;
      const swan = candidate && (identity?.looksLikePico || assumeSwan) ? candidate : null;

      // pick features: explicit → ledger-derived (built_for_headset ∪ already-closed) → all
      let keys: string[] = features ?? [];
      if (!keys.length) {
        const led = builtForHeadsetFromLedger(app).map(normalizeFeatureText).join(" | ");
        keys = Object.keys(MATRIX).filter((k) => led.includes(normalizeFeatureText(k)));
        for (const k of Object.keys(deviceVerifiedMatches(app))) if (!keys.includes(k)) keys.push(k);
      }
      if (!keys.length) keys = Object.keys(MATRIX);

      const rows = buildParityRows(app, keys, swan);
      const merged = mergeParityFile(app, rows, !!swan, identity ? { serial: identity.serial, model: identity.model, fingerprint: identity.fingerprint } : undefined);
      const closedCount = merged.rows.filter((r) => r.verifiedBy === "device_verified").length;

      const matrix = rows.map((r) => ({
        feature: r.feature,
        ...MATRIX[r.feature],
        status: r.verifiedBy === "device_verified" ? "device_verified" : swan ? "device_pending" : "awaiting_swan",
        ...(r.verifiedBy === "device_verified" ? { captureSha256: r.captureSha256, deviceSerial: r.deviceSerial, closedByClaim: r.closedByClaim } : {}),
      }));

      const status = swan ? "swan_attached" : candidate ? "unrecognized_hardware" : "awaiting_swan";
      return okJson({
        status,
        swanSerial: swan,
        ...(identity ? { deviceIdentity: identity } : {}),
        app,
        matrix,
        parityLedger: merged.path,
        closedRows: closedCount,
        note:
          status === "swan_attached"
            ? `Swan ${swan} attached (${identity?.looksLikePico ? identity.reason : "assumeSwan override — identity did NOT look like PICO hardware: " + identity?.reason}): run each deviceTest (deploy_to_device then capture + LOOK), then record_verification with evidenceType: "device_verified" (same honesty bar as vision_verified — a LOOKED-at capture + attestation — plus real-hardware identity) to flip the row to device-verified.`
            : status === "unrecognized_hardware"
              ? `Non-emulator serial ${candidate} is attached but its identity does not look like PICO hardware: ${identity?.reason}. Treating it as a Swan would put on-device claims on the wrong machine. If you are CERTAIN it is PICO hardware (e.g. a pre-release build with unexpected props), re-run with assumeSwan:true — the probe result is recorded either way.`
              : "No Swan attached — matrix returned in awaiting_swan state (wired; flips to device-verified on first attach). Emulator side stays honest built-for-headset. This cannot crash the loop.",
      });
    },
  );
}
