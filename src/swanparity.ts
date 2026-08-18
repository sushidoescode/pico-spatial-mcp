import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, run } from "./util.js";
import { assertCanonicalAppKey, CANONICAL_APP_KEY_PATTERN, readLedger } from "./ledger.js";
import { classifyDeviceIdentity, probeDeviceIdentity as probeRawDeviceIdentity } from "./deviceidentity.js";
export { classifyDeviceIdentity } from "./deviceidentity.js";

/**
 * swanparity.ts — v5.9 SWAN ON-DEVICE PARITY: flip the "built-for-headset" column to device-verified.
 *
 * The single biggest honesty upgrade. `swan_verify_matrix` turns every C1–C4 built-for-Swan row into an
 * executable on-device re-test with its emulator baseline and expected device result, records the
 * emulator→device delta in a PARITY LEDGER. When a Swan is attached over USB it marks those rows
 * device_pending — the flip to device-vision-verified still requires the actual on-device vision pass +
 * a linked capture (recorded via record_verification), never auto-granted. With NO Swan today it returns the
 * matrix in `awaiting_swan` state (wired, cannot crash the loop). The C1–C4 catalogue IS the test plan
 * (emulator-simulated geometry → physical-room proof on Swan; broadcast-drive → real trigger;
 * emulator dimensions → a headset run to close the physical walls/ceiling gap).
 *
 * v31 closes two day-one defects:
 *  - HARDWARE-IDENTITY GATE: "any non-emulator serial" is not a Swan. A Quest 3 on this desk and the
 *    PICO emulator reattached over adb-over-TCP both present non-`emulator-` serials. The gate probes
 *    getprop identity and refuses anything that doesn't look like PICO hardware. When more than one
 *    plausible PICO is attached, callers must name the intended serial explicitly.
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
  scene_understanding: { cClass: "C1", emulatorBaseline: "emulator-simulated room: measured 43 semantic planes and 42–44 mesh anchors; not evidence about a physical room", deviceTest: "launch in a physical room, raycast onto a detected real plane, place a pin, capture", expectedOnDevice: "physical-room planes; the pin snaps ONTO a real surface (LOOK)" },
  world_anchor: { cClass: "C1", emulatorBaseline: "emulator persistence/re-localization behavior is unverified; no current measurement supports treating it as either working or a no-op", deviceTest: "create a world anchor, relaunch, confirm re-localization", expectedOnDevice: "anchor persists + re-localizes across sessions" },
  measured_room: { cClass: "C1", emulatorBaseline: "emulator-simulated planes/meshes are measurable, but do not prove dimensions of the user's physical room", deviceTest: "run scene mesh/plane capture in a physical room and measure walls/ceiling", expectedOnDevice: "physical-room mesh → real walls/ceiling measured (LOOK + values)" },
  controller_ray: { cClass: "C3", emulatorBaseline: "no 6DOF controller + gated trigger → broadcast-emulated select", deviceTest: "point the controller ray at an interactable, pull the trigger", expectedOnDevice: "the real controller ray selects; highlight moves (LOOK)" },
  hand_pinch: { cClass: "C3", emulatorBaseline: "hand tracking returns no hands", deviceTest: "pinch on a menu button / interactable", expectedOnDevice: "the pinch selects (LOOK)" },
  in_front_panel: { cClass: "C4", emulatorBaseline: "stage-vs-window dichotomy → no room + in-front Compose panel together", deviceTest: "open the in-front Compose panel over the scene, click a button", expectedOnDevice: "the panel renders in front + is clickable (LOOK)" },
};

const PARITY_DIR = path.join(os.homedir(), ".pico-mcp", "parity");
const parityPath = (app: string) => {
  assertCanonicalAppKey(app);
  return path.join(PARITY_DIR, `${app}.json`);
};
function loadLedgerEntries(app: string): any[] {
  assertCanonicalAppKey(app);
  try {
    return readLedger(app).effectiveEntries;
  } catch {
    return [];
  }
}

function builtForHeadsetFromLedger(app: string): string[] {
  return loadLedgerEntries(app)
    .filter((e: any) => e.evidenceType === "built_for_headset")
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
 * PICO markers are inferred from the emulator's own build strings. Until real Swan identity is
 * measured, an unrecognized device fails closed rather than accepting an override.
 */
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
  const raw = await probeRawDeviceIdentity(adb, serial);
  return { ...raw, ...classifyDeviceIdentity(raw.model, raw.fingerprint, raw.bootQemu) };
}

export type PicoDeviceSelection = {
  status: "selected" | "no_candidate" | "requested_unavailable" | "unrecognized" | "ambiguous";
  selected: DeviceIdentity | null;
  identities: DeviceIdentity[];
  probeErrors: Array<{ serial: string; reason: string }>;
  reason: string;
};

/** Probe every online non-emulator candidate; never trust list order or an identity override. */
export async function selectPicoDevice(
  onlineSerials: string[],
  requestedSerial: string | undefined,
  probe: (serial: string) => Promise<DeviceIdentity>,
): Promise<PicoDeviceSelection> {
  const candidates = [...new Set(onlineSerials.filter((serial) => serial && !/^emulator-/i.test(serial)))];
  if (requestedSerial && !candidates.includes(requestedSerial)) {
    return { status: "requested_unavailable", selected: null, identities: [], probeErrors: [], reason: `requested deviceSerial '${requestedSerial}' is not an online non-emulator adb device` };
  }
  const toProbe = requestedSerial ? [requestedSerial] : candidates;
  if (!toProbe.length) return { status: "no_candidate", selected: null, identities: [], probeErrors: [], reason: "no online non-emulator adb device is attached" };
  const identities: DeviceIdentity[] = [];
  const probeErrors: Array<{ serial: string; reason: string }> = [];
  await Promise.all(toProbe.map(async (serial) => {
    try {
      identities.push(await probe(serial));
    } catch (error: any) {
      probeErrors.push({ serial, reason: error?.message ?? String(error) });
    }
  }));
  const recognized = identities.filter((identity) => identity.looksLikePico);
  if (requestedSerial) {
    const selected = recognized.find((identity) => identity.serial === requestedSerial) ?? null;
    return selected
      ? { status: "selected", selected, identities, probeErrors, reason: selected.reason }
      : { status: "unrecognized", selected: null, identities, probeErrors, reason: identities[0]?.reason ?? probeErrors[0]?.reason ?? `identity probe failed for '${requestedSerial}'` };
  }
  if (recognized.length === 1) return { status: "selected", selected: recognized[0], identities, probeErrors, reason: recognized[0].reason };
  if (recognized.length > 1) return { status: "ambiguous", selected: null, identities, probeErrors, reason: `${recognized.length} PICO-shaped devices are online (${recognized.map((identity) => identity.serial).join(", ")}); pass deviceSerial explicitly` };
  return { status: "unrecognized", selected: null, identities, probeErrors, reason: identities.length ? "no attached non-emulator identity looks like PICO hardware" : "all attached non-emulator identity probes failed" };
}

/**
 * Match ACTIVE device_verified entries to matrix features. Closure requires the exact structured
 * deviceFeature, explicit deviceOutcome:'pass', matching cClass, intact capture, and validated
 * lineage. Free-text claim polarity is intentionally irrelevant and can never close a row.
 */
export function deviceVerifiedMatches(app: string): Record<string, { seq: number; claim: string; captureSha256: string | null; deviceSerial: string | null }> {
  assertCanonicalAppKey(app);
  const entries = loadLedgerEntries(app).filter((e: any) => e?.evidenceType === "device_verified" && e?.deviceLineage?.status === "validated");
  const out: Record<string, { seq: number; claim: string; captureSha256: string | null; deviceSerial: string | null }> = {};
  for (const [key, spec] of Object.entries(MATRIX)) {
    const hit = entries.find((e: any) => normalizeCClass(e.cClass) === spec.cClass && e.deviceFeature === key && e.deviceOutcome === "pass");
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
 * MERGE rows into the app's parity file. Features outside `rows` survive, but rows in this read are
 * authoritative: a retracted/missing/mismatched device capture must reopen a formerly closed row.
 */
export function mergeParityFile(app: string, rows: ParityRow[], swanAttached: boolean, deviceIdentity?: { serial: string; model: string; fingerprint: string }): { path: string; rows: ParityRow[] } {
  assertCanonicalAppKey(app);
  fs.mkdirSync(PARITY_DIR, { recursive: true });
  let prev: ParityRow[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(parityPath(app), "utf8"));
    prev = Array.isArray(j?.rows) ? j.rows : [];
  } catch {
    /* first run for this app */
  }
  const byFeature = new Map(prev.map((r) => [r.feature, r]));
  const explicit = new Set(rows.map((r) => r.feature));
  const activeDeviceProof = deviceVerifiedMatches(app);
  // An explicit subset is authoritative only for that subset, but cached strongest-tier rows still
  // have to be checked. If their active ledger proof vanished, reopen them even though the caller
  // did not ask for that feature in this invocation. Intact omitted proof is refreshed, not trusted
  // merely because it was cached.
  for (const [feature, cached] of byFeature) {
    if (explicit.has(feature) || cached.verifiedBy !== "device_verified") continue;
    if (activeDeviceProof[feature] && MATRIX[feature]) {
      byFeature.set(feature, buildParityRows(app, [feature], swanAttached ? (deviceIdentity?.serial ?? "attached-device") : null)[0]);
      continue;
    }
    const known = MATRIX[feature];
    const { captureSha256: _captureSha256, deviceSerial: _deviceSerial, closedByClaim: _closedByClaim, ...withoutProof } = cached;
    byFeature.set(feature, {
      ...withoutProof,
      ...(known ? { cClass: known.cClass, emulator: known.emulatorBaseline } : {}),
      device: swanAttached ? "pending_capture" : "awaiting_device",
      verifiedBy: swanAttached ? "swan_pending" : "built_for_headset",
    });
  }
  for (const r of rows) {
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
        "The emulator→device parity gate. Only an active device_verified row with exact structured deviceFeature, explicit deviceOutcome:'pass', matching cClass, intact bytes, live-probed non-emulator PICO identity, and same-serial screencap binding closes a feature. Free-text claim polarity is never inferred. Retraction, failed outcome, capture/hash failure, missing lineage, or omitted-subset cache refresh reopens it. No Swan hardware values have been measured in this repo.",
      inputSchema: {
        app: z.string().regex(CANONICAL_APP_KEY_PATTERN).describe("Canonical app/package parity key: lowercase ASCII letters, digits, dot, underscore, or hyphen; no paths or spaces."),
        features: z.array(z.enum(["scene_understanding", "world_anchor", "measured_room", "controller_ray", "hand_pinch", "in_front_panel"])).optional().describe("Headset features to re-test (default: derived from the trust ledger's built_for_headset rows, else all)."),
        deviceSerial: z.string().optional().describe("Explicit online adb serial. Required when more than one PICO-shaped candidate is attached; unrecognized identities fail closed."),
      },
    },
    async ({ app, features, deviceSerial }) => {
      const adb = resolveAdb();
      const devs = (await run(adb, ["devices"], { timeoutMs: 10_000 })).stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2 && parts[1] === "device")
        .map((parts) => parts[0]);
      const selection = await selectPicoDevice(devs, deviceSerial, (serial) => probeDeviceIdentity(adb, serial));
      const identity = selection.selected;
      const swan = identity?.serial ?? null;

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

      const status = swan
        ? "swan_attached"
        : selection.status === "ambiguous"
          ? "ambiguous_hardware"
          : selection.status === "no_candidate"
            ? "awaiting_swan"
            : "unrecognized_hardware";
      return okJson({
        status,
        swanSerial: swan,
        ...(identity ? { deviceIdentity: identity } : {}),
        deviceCandidates: selection.identities,
        ...(selection.probeErrors.length ? { identityProbeErrors: selection.probeErrors } : {}),
        app,
        matrix,
        parityLedger: merged.path,
        closedRows: closedCount,
        note:
          status === "swan_attached"
            ? `Swan ${swan} attached (${identity?.reason ?? "live PICO identity selected"}): run each deviceTest, capture + LOOK, then record_verification with evidenceType:"device_verified", the row's exact deviceFeature, explicit deviceOutcome, and deviceSerial:"${swan}" while the same stable frame is still live. The server re-probes identity and requires a fresh same-serial screencap to match the looked artifact byte-for-byte. That byte-equality workflow has not been exercised on moving Swan hardware and may require a stable frame.`
            : status === "ambiguous_hardware"
              ? `${selection.reason}. Re-run with deviceSerial naming the intended PICO; no list-order guess is made.`
            : status === "unrecognized_hardware"
              ? `${selection.reason}. Treating an unrecognized device as Swan hardware is refused; no override can mint or prepare device proof.`
              : "No Swan attached — matrix returned in awaiting_swan state (wired; flips to device-verified on first attach). Emulator side stays honest built-for-headset. This cannot crash the loop.",
      });
    },
  );
}
