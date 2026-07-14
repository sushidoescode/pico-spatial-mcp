import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

const run = promisify(execFile);

/**
 * metricverify.ts — v20 THE LEDGER GETS ERROR BARS.
 *
 * Upgrades "vision-verified" from *someone looked* to *measured*: color-keyed content is detected
 * in a deterministic forward capture, the expected world position is projected through a
 * CALIBRATED pinhole model of the emulator capture camera, and the placement error comes back in
 * pixels and meters — numbers the trust ledger can carry.
 *
 * Camera model (deterministic forward capture only): eye at (0, eyeHeight, 0) looking -Z, square
 * pixels, principal point at image center. u = cx + f·x/(-z); v = cy − f·(y−eyeHeight)/(-z).
 * Calibrated EMPIRICALLY from a scene of color cubes at known positions (briefs/calib.json) —
 * never assumed. Calibration persists to ~/.pico-mcp/camera-calibration.json with residuals.
 *
 * HONESTY: measurements are only as good as the calibration (residuals reported, stored, and
 * echoed into every measurement); valid ONLY for the deterministic forward capture (the free-cam
 * orbit drifts); detection is saturation-keyed so muted environment colors can't false-match.
 * Python (PIL+numpy in the pico venv) does detection; all geometry is deterministic node math.
 */

const CALIB_PATH = path.join(os.homedir(), ".pico-mcp", "camera-calibration.json");

function resolvePython(): string | null {
  const candidates = [process.env.PICO_PY, path.join(os.homedir(), ".pico/venv/bin/python"), "python3"];
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (c === "python3" || fs.existsSync(c)) return c;
    } catch { /* next */ }
  }
  return null;
}

async function detect(capturePath: string, keys: Record<string, [number, number, number]>) {
  const py = resolvePython();
  if (!py) throw new Error("no python with PIL+numpy found (PICO_PY / ~/.pico/venv) — required for color-key detection");
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../scripts/py/detect_colorkey.py");
  const { stdout } = await run(py, [script, capturePath, JSON.stringify(keys)], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout) as { detections: Record<string, { centroid: [number, number]; bboxCenter: [number, number]; bbox: [number, number, number, number]; pixels: number } | null>; width: number; height: number };
}

const to255 = (c: number[]) => c.map((v) => (v <= 1 ? Math.round(v * 255) : Math.round(v))) as [number, number, number];

interface Calib { f: number; eyeHeight: number; cx: number; cy: number; width: number; height: number; residualPx: number; solvedFrom: string; at: string; }

export function loadCalibration(): Calib | null {
  try {
    return JSON.parse(fs.readFileSync(CALIB_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** Project a world point through the calibrated forward camera. Returns null behind the eye. */
export function project(p: [number, number, number], cal: Calib): [number, number] | null {
  const d = -p[2];
  if (d <= 0.05) return null;
  return [cal.cx + (cal.f * p[0]) / d, cal.cy - (cal.f * (p[1] - cal.eyeHeight)) / d];
}

const vec3 = z.array(z.number()).length(3);

export function registerMetricVerifyTools(server: McpServer) {
  server.registerTool(
    "calibrate_capture_camera",
    {
      description:
        "Solve the emulator forward-capture camera model EMPIRICALLY from a capture of color-keyed cubes at KNOWN app-space positions (build briefs/calib.json via fleet_build first). Detects each cube's pixel centroid (saturation-keyed), solves focal length from the horizontal offsets and eye height from the verticals (least squares), reports per-marker residuals, and persists ~/.pico-mcp/camera-calibration.json for measure_placement. HONESTY: residuals are stored and echoed into every later measurement; recalibrate after any emulator/renderer update AND after every emulator cold restart — the v24 run measured a 299px cy shift across one restart (the free-cam default pose moved), which silently corrupts every meter figure until recalibration.",
      inputSchema: {
        capturePath: z.string().describe("The calibration capture (deterministic forward frame)."),
        markers: z.array(z.object({
          name: z.string(),
          colorKey: vec3.describe("Marker color as [r,g,b] (0-1 or 0-255)."),
          position: vec3.describe("KNOWN app-space position [x,y,z] (z negative = ahead)."),
        })).min(3).describe("At least 3 markers; include off-center x AND differing y for a solvable system."),
      },
    },
    async ({ capturePath, markers }) => {
      if (!fs.existsSync(capturePath)) return okJson({ status: "error", error: `capture not found: ${capturePath}` });
      let det;
      try {
        det = await detect(capturePath, Object.fromEntries(markers.map((m) => [m.name, to255(m.colorKey)])));
      } catch (e) {
        return okJson({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
      const seen = markers.filter((m) => det.detections[m.name]);
      if (seen.length < 3) {
        return okJson({ status: "error", error: `only ${seen.length}/${markers.length} markers detected — need ≥3`, detections: det.detections });
      }
      // v20.1: FULL linear least squares over (cx, cy, f, f*h) — the principal point is NOT
      // assumed centered, and markers at TWO depths make eye height separable from cy.
      // u_i = cx + f*x_i/d_i ; v_i = cy - f*y_i/d_i + (f*h)/d_i  — linear in (cx, cy, a=f, b=f*h).
      const rows: number[][] = [];
      const rhs: number[] = [];
      for (const m of seen) {
        const [x, y, zz] = m.position as [number, number, number];
        const d = -zz;
        const pt = det.detections[m.name]!.bboxCenter;
        rows.push([1, 0, x / d, 0]); rhs.push(pt[0]);          // cx + a*(x/d) = u
        rows.push([0, 1, -y / d, 1 / d]); rhs.push(pt[1]);     // cy - a*(y/d) + b*(1/d) = v
      }
      // normal equations AtA z = At rhs, z = [cx, cy, a, b]
      const AtA = Array.from({ length: 4 }, () => new Array(4).fill(0));
      const Atb = new Array(4).fill(0);
      for (let r = 0; r < rows.length; r++) {
        for (let i = 0; i < 4; i++) {
          Atb[i] += rows[r][i] * rhs[r];
          for (let j = 0; j < 4; j++) AtA[i][j] += rows[r][i] * rows[r][j];
        }
      }
      // gaussian elimination
      const M = AtA.map((row, i) => [...row, Atb[i]]);
      for (let col = 0; col < 4; col++) {
        let piv = col;
        for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        [M[col], M[piv]] = [M[piv], M[col]];
        if (Math.abs(M[col][col]) < 1e-9) return okJson({ status: "error", error: "degenerate calibration geometry — need markers spread in x, y AND depth" });
        for (let r = 0; r < 4; r++) {
          if (r === col) continue;
          const k = M[r][col] / M[col][col];
          for (let c2 = col; c2 < 5; c2++) M[r][c2] -= k * M[col][c2];
        }
      }
      const [cxS, cyS, f, b] = [M[0][4] / M[0][0], M[1][4] / M[1][1], M[2][4] / M[2][2], M[3][4] / M[3][3]];
      const eyeHeight = b / f;
      const fEst = [f];
      const hEst = [eyeHeight];
      const cal: Calib = { f: Math.round(f * 10) / 10, eyeHeight: Math.round(eyeHeight * 1000) / 1000, cx: Math.round(cxS * 10) / 10, cy: Math.round(cyS * 10) / 10, width: det.width, height: det.height, residualPx: 0, solvedFrom: capturePath, at: new Date().toISOString() };
      const residuals = seen.map((m) => {
        const exp = project(m.position as [number, number, number], cal)!;
        const got = det.detections[m.name]!.bboxCenter;
        return { name: m.name, residualPx: Math.round(Math.hypot(exp[0] - got[0], exp[1] - got[1]) * 10) / 10 };
      });
      cal.residualPx = Math.round(Math.max(...residuals.map((r) => r.residualPx)) * 10) / 10;
      fs.mkdirSync(path.dirname(CALIB_PATH), { recursive: true });
      fs.writeFileSync(CALIB_PATH, JSON.stringify(cal, null, 2));
      return okJson({ status: "ok", calibration: cal, fEstimates: fEst.map((v) => Math.round(v * 10) / 10), eyeHeightEstimates: hEst.map((v) => Math.round(v * 1000) / 1000), residuals, note: "Persisted — measure_placement now reports px AND meter errors against this model." });
    },
  );

  server.registerTool(
    "measure_placement",
    {
      description:
        "MEASURE a placement instead of just looking: detect color-keyed content in a deterministic forward capture, project its EXPECTED world position through the calibrated camera (calibrate_capture_camera first), and report the error in pixels and meters-at-depth, plus IoU between the detected pixels and the projected expected 3D box. This is the ledger's error bar: attach the returned numbers to a vision_verified record. Targets behind the eye or off-frame are reported as such, never guessed.",
      inputSchema: {
        capturePath: z.string(),
        targets: z.array(z.object({
          name: z.string(),
          colorKey: vec3,
          expectedPosition: vec3.describe("Where the pipeline placed it (app space)."),
          expectedSize: vec3.optional().describe("Full extents — enables projected-box IoU."),
        })).min(1),
      },
    },
    async ({ capturePath, targets }) => {
      if (!fs.existsSync(capturePath)) return okJson({ status: "error", error: `capture not found: ${capturePath}` });
      const cal = loadCalibration();
      if (!cal) return okJson({ status: "uncalibrated", error: "no camera calibration — run calibrate_capture_camera on a calib-brief capture first." });
      let det;
      try {
        det = await detect(capturePath, Object.fromEntries(targets.map((t) => [t.name, to255(t.colorKey)])));
      } catch (e) {
        return okJson({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
      const results = targets.map((t) => {
        const p = t.expectedPosition as [number, number, number];
        const expPx = project(p, cal);
        const d = det.detections[t.name];
        if (!expPx) return { name: t.name, status: "expected-behind-camera" as const };
        if (!d) return { name: t.name, status: "not-detected" as const, expectedPx: expPx.map((v) => Math.round(v)) };
        const errPx = Math.hypot(d.bboxCenter[0] - expPx[0], d.bboxCenter[1] - expPx[1]);
        const metersPerPx = -p[2] / cal.f;
        let iou: number | null = null;
        if (t.expectedSize) {
          const [sx, sy, sz] = t.expectedSize as [number, number, number];
          const corners: [number, number][] = [];
          for (const dx of [-sx / 2, sx / 2]) for (const dy of [-sy / 2, sy / 2]) for (const dz of [-sz / 2, sz / 2]) {
            const c = project([p[0] + dx, p[1] + dy, p[2] + dz], cal);
            if (c) corners.push(c);
          }
          if (corners.length === 8) {
            const ex = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
            const db = d.bbox;
            const ix = Math.max(0, Math.min(ex[2], db[2]) - Math.max(ex[0], db[0]));
            const iy = Math.max(0, Math.min(ex[3], db[3]) - Math.max(ex[1], db[1]));
            const inter = ix * iy;
            const union = (ex[2] - ex[0]) * (ex[3] - ex[1]) + (db[2] - db[0]) * (db[3] - db[1]) - inter;
            iou = union > 0 ? Math.round((inter / union) * 1000) / 1000 : 0;
          }
        }
        return {
          name: t.name,
          status: "measured" as const,
          detectedPx: d.bboxCenter,
          expectedPx: expPx.map((v) => Math.round(v)),
          errorPx: Math.round(errPx * 10) / 10,
          errorMetersAtDepth: Math.round(errPx * metersPerPx * 1000) / 1000,
          ...(iou !== null ? { iou } : {}),
          pixels: d.pixels,
        };
      });
      return okJson({ status: "ok", calibration: { f: cal.f, eyeHeight: cal.eyeHeight, cx: cal.cx, cy: cal.cy, residualPx: cal.residualPx }, results, note: `errors include calibration residual (±${cal.residualPx}px); valid only for the deterministic forward capture.` });
    },
  );
}
