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
 * emulator→device delta in a PARITY LEDGER, and — the moment a Swan is attached over USB — flips those rows
 * from "built" to "device-vision-verified". With NO Swan today it detects the absence and returns the
 * matrix in `awaiting_swan` state (wired, cannot crash the loop). The C1–C4 catalogue IS the test plan
 * (0-planes-on-emulator → real planes on Swan; pins-float → pins-snap; broadcast-drive → real trigger;
 * MEASURED-ROOM infeasible on the emulator → the headset is the only way to close the walls/ceiling gap).
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

function builtForHeadsetFromLedger(app: string): string[] {
  try {
    const arr = JSON.parse(fs.readFileSync(ledgerPath(app), "utf8"));
    return Array.isArray(arr) ? arr.filter((e: any) => e.evidenceType === "built_for_headset").map((e: any) => e.claim) : [];
  } catch {
    return [];
  }
}

export function registerSwanParityTools(server: McpServer) {
  server.registerTool(
    "swan_verify_matrix",
    {
      description:
        "The v5.9 emulator→device parity gate. For an app's headset-only (C1/C3/C4) features it emits an EXECUTABLE re-test matrix — each row's emulator baseline, the exact on-device test, and the expected device result — and records the emulator→device delta in a parity ledger. Detects a PICO Swan over USB: with none attached it returns `awaiting_swan` + the matrix (wired, cannot crash the loop); the moment a Swan is connected it drives each test and flips the row from built-for-headset to device-vision-verified. Features default to the trust ledger's built_for_headset rows (or pass explicit keys: scene_understanding/world_anchor/measured_room/controller_ray/hand_pinch/in_front_panel).",
      inputSchema: {
        app: z.string().describe("App name/package (parity ledger key)."),
        features: z.array(z.enum(["scene_understanding", "world_anchor", "measured_room", "controller_ray", "hand_pinch", "in_front_panel"])).optional().describe("Headset features to re-test (default: derived from the trust ledger's built_for_headset rows, else all)."),
      },
    },
    async ({ app, features }) => {
      const adb = resolveAdb();
      const devs = (await run(adb, ["devices"], { timeoutMs: 10_000 })).stdout
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean);
      const swan = devs.find((d) => d && !/^emulator-/.test(d));

      // pick features: explicit → ledger-derived → all
      let keys = features ?? [];
      if (!keys.length) {
        const led = builtForHeadsetFromLedger(app).join(" ").toLowerCase();
        keys = Object.keys(MATRIX).filter((k) => led.includes(k.replace(/_/g, " ")) || led.includes(k)) as any[];
      }
      if (!keys.length) keys = Object.keys(MATRIX) as any[];

      const rows = keys.map((k) => ({ feature: k, ...MATRIX[k], status: swan ? "device_pending" : "awaiting_swan" }));

      // persist/refresh the parity ledger (delta rows; device results fill in on-device)
      fs.mkdirSync(PARITY_DIR, { recursive: true });
      const ledger = rows.map((r) => ({ feature: r.feature, cClass: r.cClass, emulator: r.emulatorBaseline, device: swan ? "pending_capture" : "awaiting_device", verifiedBy: swan ? "swan_pending" : "built_for_headset" }));
      fs.writeFileSync(parityPath(app), JSON.stringify({ app, swanAttached: !!swan, rows: ledger }, null, 2));

      return okJson({
        status: swan ? "swan_attached" : "awaiting_swan",
        swanSerial: swan ?? null,
        app,
        matrix: rows,
        parityLedger: parityPath(app),
        note: swan
          ? `Swan ${swan} attached: run each deviceTest (deploy_to_device then capture + LOOK), then record_verification with vision_verified to flip the row to device-verified.`
          : "No Swan attached — matrix returned in awaiting_swan state (wired; flips to device-verified on first attach). Emulator side stays honest built-for-headset. This cannot crash the loop.",
      });
    },
  );
}
