import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, expandHome } from "./util.js";
import { inspectAsset } from "./assetgate.js";

/**
 * worldenv.ts — v7.1 CUSTOM WORLD ENVIRONMENT loader (World Labs / Marble → a real world around the user).
 *
 * The default PICO home environments aren't enough — this loads a CUSTOM photoreal world (a Gaussian splat
 * or a mesh) as the app's environment, so the user stands inside their own scanned/generated world. It is
 * the highest-value "authored world" feature: it turns the whole app's backdrop into content.
 *
 * WHAT WAS ACTUALLY FAILING (empirically diagnosed on-device, 2026-07-02) — loading was never the problem:
 *   1. DELIVERY: a 27 MB splat shipped in APK assets gets zip-COMPRESSED by Android → the native mmap
 *      loader can't read it. FIX: FROM_STORAGE (adb push to the app's external files dir), which this tool
 *      wires by default. (If you must ship in-APK, add `aaptOptions { noCompress "spz","ply" }`.)
 *   2. CALIBRATION: the splat loads + renders fine, but the VIEWER isn't positioned inside it — Marble
 *      worlds are huge (this one is ~29×21×32 m) and the geometric bbox-center sits out in open air/sky, so
 *      you end up viewing the room as a distant block. FIX: place the viewer at the DENSITY-weighted
 *      centroid (mean of all splats — pulled toward the real geometry), with the floor from the Y
 *      distribution; this tool decodes those from the file and emits the transform. Then fine-tune with a
 *      capture→LOOK→adjust loop (yaw + translate) — the emulator's fixed forward camera (C2) limits the
 *      preview, but on a headset you just look around.
 *
 * PICO natively renders Gaussian splats (unlike visionOS) — VERIFIED: a 1.92M-point SPZ v2 deserializes and
 * renders. spatialbundle CANNOT pack splats → they ship raw. A MESH world (GLB) goes the bake path instead.
 */

type SplatInfo = {
  kind: "splat" | "mesh" | "unknown";
  format: string;
  numPoints: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] } | null;
  centroid: [number, number, number] | null; // density-weighted (mean) — the good viewer anchor
  floorY: number | null;                       // ~5th percentile of the up axis
  ceilingY: number | null;
  note: string;
};

const i24 = (buf: Buffer, o: number): number => { let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16); if (v & 0x800000) v -= 0x1000000; return v; };

/** Decode a Niantic SPZ (gzip) splat: header + positions → bbox, density centroid, floor/ceiling. */
function inspectSpz(file: string): SplatInfo {
  const raw = fs.readFileSync(file);
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x5053474e) return { kind: "unknown", format: "spz?", numPoints: null, bbox: null, centroid: null, floorY: null, ceilingY: null, note: `bad SPZ magic 0x${magic.toString(16)} (expected NGSP)` };
  const numPoints = buf.readUInt32LE(8);
  const fractionalBits = buf.readUInt8(13);
  const scale = 1 / (1 << fractionalBits);
  const off = 16;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], sum = [0, 0, 0];
  const ys: number[] = [];
  for (let p = 0; p < numPoints; p++) {
    const b = off + p * 9;
    for (let c = 0; c < 3; c++) { const v = i24(buf, b + c * 3) * scale; if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v; sum[c] += v; if (c === 1) ys.push(v); }
  }
  ys.sort((a, b) => a - b);
  const pct = (q: number) => ys[Math.min(ys.length - 1, Math.floor(q * ys.length))];
  return {
    kind: "splat", format: "spz", numPoints,
    bbox: { min: min as any, max: max as any, size: min.map((m, i) => max[i] - m) as any },
    centroid: sum.map((s) => Number((s / numPoints).toFixed(3))) as any,
    floorY: Number(pct(0.05).toFixed(3)), ceilingY: Number(pct(0.95).toFixed(3)),
    note: `SPZ v2, ${numPoints} points`,
  };
}

/** Parse a PLY header + (splat) float positions → same info. Detects splat (f_dc/opacity/scale/rot) vs mesh (faces). */
function inspectPly(file: string): SplatInfo {
  const buf = fs.readFileSync(file);
  const headerEnd = buf.indexOf("end_header");
  if (headerEnd < 0) return { kind: "unknown", format: "ply?", numPoints: null, bbox: null, centroid: null, floorY: null, ceilingY: null, note: "no end_header" };
  const header = buf.toString("ascii", 0, headerEnd);
  const dataStart = buf.indexOf("\n", headerEnd) + 1;
  const isSplat = /property\s+float\s+(f_dc_0|opacity|scale_0|rot_0)/.test(header);
  const hasFaces = /element\s+face\s+\d+/.test(header);
  const vm = header.match(/element\s+vertex\s+(\d+)/);
  const numPoints = vm ? parseInt(vm[1], 10) : null;
  if (hasFaces && !isSplat) return { kind: "mesh", format: "ply-mesh", numPoints, bbox: null, centroid: null, floorY: null, ceilingY: null, note: "MESH ply (has faces) — spatialbundle can't pack .ply; export GLB from Marble or convert." };
  if (!isSplat) return { kind: "unknown", format: "ply", numPoints, bbox: null, centroid: null, floorY: null, ceilingY: null, note: "PLY is neither a recognized splat nor a mesh." };
  // splat PLY: binary_little_endian, properties in header order; x,y,z are the first 3 floats.
  const binary = /format\s+binary_little_endian/.test(header);
  if (!binary) return { kind: "splat", format: "ply-ascii", numPoints, bbox: null, centroid: null, floorY: null, ceilingY: null, note: "ASCII splat PLY — provide binary_little_endian for bbox decode (loading still works)." };
  const props = [...header.matchAll(/property\s+\w+\s+(\w+)/g)].map((m) => m[1]);
  const stride = props.length * 4; // all float32
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], sum = [0, 0, 0];
  const ys: number[] = [];
  const n = numPoints ?? 0;
  for (let p = 0; p < n; p++) {
    const b = dataStart + p * stride;
    if (b + 12 > buf.length) break;
    for (let c = 0; c < 3; c++) { const v = buf.readFloatLE(b + c * 4); if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v; sum[c] += v; if (c === 1) ys.push(v); }
  }
  ys.sort((a, b) => a - b);
  const pct = (q: number) => ys[Math.min(ys.length - 1, Math.floor(q * ys.length))];
  return {
    kind: "splat", format: "ply-splat", numPoints,
    bbox: { min: min as any, max: max as any, size: min.map((m, i) => max[i] - m) as any },
    centroid: sum.map((s) => Number((s / n).toFixed(3))) as any,
    floorY: Number(pct(0.05).toFixed(3)), ceilingY: Number(pct(0.95).toFixed(3)),
    note: `splat PLY, ${n} points`,
  };
}

export function inspectWorld(file: string): SplatInfo {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === ".spz") return inspectSpz(file);
    if (ext === ".ply") return inspectPly(file);
    if (ext === ".glb" || ext === ".gltf") {
      // A textured MESH renders CRISP (unlike splats, which are soft on the emulator GPU) — the clean path.
      // Pull the real bbox so we can calibrate the viewer into the room.
      const a = inspectAsset(file);
      const bbox = a.bbox ? { min: a.bbox.min, max: a.bbox.max, size: a.bbox.min.map((m, i) => a.bbox!.max[i] - m) as [number, number, number] } : null;
      return { kind: "mesh", format: ext.slice(1), numPoints: a.triangles, bbox, centroid: bbox ? (bbox.min.map((m, i) => (m + bbox.max[i]) / 2) as [number, number, number]) : null, floorY: bbox ? bbox.min[1] : null, ceilingY: bbox ? bbox.max[1] : null, note: `MESH (${a.triangles} tris) — the CLEAN path: bake → texturedMesh env + lighting.` };
    }
    return { kind: "unknown", format: ext, numPoints: null, bbox: null, centroid: null, floorY: null, ceilingY: null, note: `unsupported extension ${ext}` };
  } catch (e: any) {
    return { kind: "unknown", format: ext, numPoints: null, bbox: null, centroid: null, floorY: null, ceilingY: null, note: `inspect failed: ${e?.message ?? e}` };
  }
}

/** Auto-calibration: place the viewer at the density centroid, floor under the eye, facing the interior (yaw 180). */
function autoCalibrate(info: SplatInfo, eyeHeight: number, yawDeg: number): { translate: { x: number; y: number; z: number }; rotationEuler: { x: number; y: number; z: number }; scale: number; floorY: number } {
  const c = info.centroid ?? [0, 0, 0];
  const floorY = info.floorY ?? (info.bbox ? info.bbox.min[1] : 0);
  // yaw about Y: for 180, Ry·(x,y,z)=(-x,y,-z). General: rotate c by yaw, then translate so it lands at the viewer eye.
  const rad = (yawDeg * Math.PI) / 180;
  const rx = c[0] * Math.cos(rad) + c[2] * Math.sin(rad);
  const rz = -c[0] * Math.sin(rad) + c[2] * Math.cos(rad);
  // put the centroid's floor at y=0 under the viewer (raise the world by the centroid-to-floor drop), eye stays at eyeHeight
  return {
    translate: { x: Number((-rx).toFixed(3)), y: Number((-floorY).toFixed(3)), z: Number((-rz).toFixed(3)) },
    rotationEuler: { x: 0, y: yawDeg, z: 0 },
    scale: 1,
    floorY,
  };
}

export function registerWorldEnvTools(server: McpServer) {
  server.registerTool(
    "import_world_environment",
    {
      description:
        "Load a CUSTOM photoreal world (World Labs / Marble) as the app's environment — the user stands inside their own scanned/generated world instead of a default home env. Handles the two things that actually break custom-world loading (empirically diagnosed): (1) DELIVERY — ships the splat FROM_STORAGE (adb push) so Android doesn't zip-compress it (which breaks the native loader); (2) CALIBRATION — decodes the file's bbox + DENSITY-weighted centroid + floor, and emits an auto-calibrated transform that places the viewer inside the real geometry (not out in the open air). Accepts a Gaussian splat (.spz / .ply-splat — rendered natively, VERIFIED 1.92M pts) or a MESH (.glb → bake path; .ply-mesh → export GLB from Marble). Returns the inspection, the adb push command, the generate_environment_kotlin call with the calibrated transform, and the capture→LOOK→adjust fine-tune loop. Splats have no collision → also emit a floor box-collider for interaction.",
      inputSchema: {
        assetPath: z.string().describe("Path to the world file (.spz / .ply / .glb)."),
        packageName: z.string().describe("The app's applicationId, e.g. com.example.myapp."),
        contentPackage: z.string().optional().describe("Kotlin content package (default <packageName>.content)."),
        eyeHeight: z.number().optional().describe("Standing eye height in m (default 1.6)."),
        yawDeg: z.number().optional().describe("Facing yaw about Y (default 180 — faces the interior for Marble; try 0/90/270 in the LOOK loop)."),
        scale: z.number().optional().describe("Uniform world scale override (default 1 — Marble is metric)."),
      },
    },
    async ({ assetPath, packageName, contentPackage, eyeHeight, yawDeg, scale }) => {
      const file = expandHome(assetPath);
      if (!fs.existsSync(file)) return okJson({ status: "error", error: `file not found: ${file}` });
      const info = inspectWorld(file);
      const cpkg = contentPackage ?? `${packageName}.content`;
      const eye = eyeHeight ?? 1.6;
      const yaw = yawDeg ?? 180;
      const base = path.basename(file);
      const shortName = base.replace(/[^A-Za-z0-9._-]/g, "_");

      if (info.kind === "mesh") {
        const isGlb = info.format === "glb" || info.format === "gltf";
        if (!isGlb) {
          return okJson({ status: "mesh_ply", inspection: info, note: "A MESH .ply cannot be baked (spatialbundle takes only usda/usdc/usdz/usd/gltf/glb). Export the HIGH-QUALITY MESH as GLB from Marble, or convert .ply→.glb, then re-run." });
        }
        // Calibrate the viewer into the room from the real bbox: floor to y=0, room centered on the viewer.
        // v7.5: default to a LARGE immersion scale (~2.2×) so the world is a big walkable space, not a small
        // "blob" — combined with the generated HomeStage's SpatialView(Modifier.fillMaxSize()), which un-bounds
        // the 3D region (a default-size SpatialView node compresses the scene into a small portal-like volume).
        const immScale = scale ?? 2.2;
        const stem = shortName.replace(/\.(glb|gltf)$/i, "");
        const bb = info.bbox;
        const cal = bb
          ? { translate: { x: Number((-immScale * ((bb.min[0] + bb.max[0]) / 2)).toFixed(3)), y: Number((-immScale * bb.min[1]).toFixed(3)), z: Number((-immScale * ((bb.min[2] + bb.max[2]) / 2)).toFixed(3)) }, rotationEuler: { x: 0, y: yaw === 180 ? 0 : yaw, z: 0 }, scale: immScale }
          : { translate: { x: 0, y: 0, z: 0 }, rotationEuler: { x: 0, y: 0, z: 0 }, scale: immScale };
        // Find an equirect pano in the same folder (Marble names it "<world>_pano.png"; the mesh may be renamed,
        // so scan the dir rather than name-match). Prefer a name-adjacent one, else any *_pano image.
        const dir = path.dirname(file);
        let panoSibling: string | undefined;
        try {
          const panos = fs.readdirSync(dir).filter((n) => /_pano\.(png|jpe?g)$/i.test(n) || /\bpano\b.*\.(png|jpe?g)$/i.test(n)).map((n) => path.join(dir, n));
          const base = stem.replace(/_textured$/, "").toLowerCase();
          panoSibling = panos.find((p) => path.basename(p).toLowerCase().startsWith(base)) ?? panos[0];
        } catch {}
        return okJson({
          status: "mesh_ready",
          inspection: info,
          recommendation: "USE THIS (the mesh), not the splat, for a CLEAN render: a textured mesh renders crisp geometry+textures on the emulator, while a Gaussian splat renders as soft blobs there (no quality knobs; splats are for headset fidelity). VERIFIED: the mesh renders a clean, recognizable room; the splat of the same world renders as fog.",
          fullSurroundOption: {
            note: "A mesh/splat is a BOUNDED VOLUME — it can render as a small 'blob' you PORTAL into (bounded, floating in the home env). For a TRUE FULL SURROUND (no blob, seamless in every direction, exactly like the home environment), render the equirect PANO as a SKYBOX instead. Tradeoff: the skybox has no depth/parallax (it's at infinity); the mesh has depth but is bounded. For the best of both, load the skybox AND the mesh inside it.",
            recommended: !!panoSibling,
            panoFound: panoSibling ?? null,
            skyboxSteps: panoSibling
              ? [
                  `A1. STAGE: magick "${panoSibling}" -resize 4096x2048 <project>/app/src/main/assets/world_pano.png`,
                  `A2. ENV: generate_environment_kotlin(packageName="${cpkg}", kind="skybox", assetFileName="world_pano.png") → SkyboxEnvironment.kt`,
                  `A3. WIRE: SpatialView(Modifier.fillMaxSize()); in initial → SkyboxEnvironment.load { content.addEntity(it) }. Or set AppSpec scene.environment.kind="pano", baseColorImage="world_pano.png" and let generate_app_wiring compose it.`,
                  `A4. VERIFY: build_and_run → capture_frame → LOOK: the pano fills EVERY direction, no bounded blob. VERIFIED on emulator.`,
                ]
              : ["Export the equirect PANORAMA from Marble (a *_pano.png), then use generate_environment_kotlin(kind='skybox') for a full surround."],
          },
          immersionFix: "If you keep the MESH (for depth): it's scaled ~2.2× to a LARGE walkable space (not a tiny blob), and the generated HomeStage uses SpatialView(Modifier.fillMaxSize()). But a mesh is still a bounded volume — the SKYBOX above is the way to fully surround the viewer with no blob.",
          calibration: cal,
          steps: [
            `1. BAKE: bake_textured_model(modelPath="${file}", outBundle="<project>/app/src/main/assets/${stem}.bundle")`,
            `2. ENV: generate_environment_kotlin(packageName="${cpkg}", kind="texturedMesh", assetFileName="${stem}.glb", baseColorImage="${stem}.png", delivery="assets", translate=${JSON.stringify(cal.translate)}, rotationEuler=${JSON.stringify(cal.rotationEuler)}, scale=${cal.scale})`,
            `3. LIGHT IT (REQUIRED — the baked PBR material is BLACK without lights): generate_lighting_kotlin(packageName="${cpkg}", sunLux=3000, iblScale=4.0) → SceneLighting.apply(root) in SpatialView.initial. This is what makes a photoscan read bright/clean.`,
            `4. WIRE: in SpatialView.initial (main thread): SceneLighting.apply(root); MeshEnvironment.load { content.addEntity(it) }. Or set AppSpec scene.environment.kind="texturedMesh" + lighting.rig="sun" and let generate_app_wiring compose it.`,
            `5. VERIFY: build_and_run → capture_canonical → LOOK. If dark, raise iblScale/sunLux; if you're outside the room or facing a wall, nudge calibration.translate / rotationEuler.y.`,
          ],
          note: `Placed viewer at the room center, floor (y=${info.floorY}) lifted to 0. ${info.numPoints} triangles. This is the polished/clean path.`,
        });
      }
      if (info.kind !== "splat" || !info.bbox) {
        return okJson({ status: "cannot_calibrate", inspection: info, note: info.note + " — loading may still work; provide a binary splat .spz/.ply for auto-calibration." });
      }

      const cal = autoCalibrate(info, eye, yaw);
      const filesDir = `/sdcard/Android/data/${packageName}/files`;
      const perf = info.numPoints && info.numPoints > 1_500_000
        ? `HEAVY: ${info.numPoints} splats — fine on device, may jank the emulator. Consider a Marble 'lightweight' (~500k) export for the emulator.`
        : `${info.numPoints} splats.`;
      const meshSibling = path.join(path.dirname(file), path.basename(file).replace(/(_?splat)?\.(spz|ply)$/i, "") + "_textured.glb");
      return okJson({
        status: "splat_ready",
        cleanRenderWarning: `Gaussian splats render as SOFT/FOGGY BLOBS on the emulator GPU (verified) and can't be quality-tuned — they look their best on a real headset. For a CLEAN, polished render on the emulator, prefer the Marble TEXTURED MESH export (a *_textured.glb)${fs.existsSync(meshSibling) ? ` — found one next to this file: ${meshSibling} → re-run import_world_environment on it.` : " and re-run import_world_environment on it."} Use the splat only if you specifically want splat fidelity on-device.`,
        inspection: info,
        calibration: {
          ...cal,
          rationale: `Placed the viewer at the DENSITY centroid ${JSON.stringify(info.centroid)} (the real geometry, not the bbox-center out in the sky), floor at y≈${info.floorY} lifted to 0, facing yaw ${yaw}. Fine-tune with the LOOK loop.`,
        },
        steps: [
          `1. DELIVER (avoids APK compression): adb -s <serial> push "${file}" ${filesDir}/${shortName}`,
          `2. GENERATE the loader: generate_environment_kotlin(packageName="${cpkg}", kind="splat", assetFileName="${shortName}", delivery="storage", translate=${JSON.stringify(cal.translate)}, rotationEuler=${JSON.stringify(cal.rotationEuler)}, scale=${cal.scale})`,
          `3. WIRE it in SpatialView.initial: capture externalFilesPath = context.getExternalFilesDir(null)?.absolutePath, then SplatEnvironment.load(externalFilesPath) { content.addEntity(it) }.`,
          `4. COLLISION (splats have none): generate_collider_kotlin with a floor box at y=0 (size ~${info.bbox.size[0].toFixed(0)}×0.1×${info.bbox.size[2].toFixed(0)}) so objects/pins can sit on the world floor.`,
          `5. VERIFY (capture→LOOK→adjust): build_and_run → capture_canonical → LOOK. If you face a wall/empty, adjust yawDeg (0/90/180/270); if too high/low, nudge translate.y; if outside, the centroid placement is your best start.`,
        ],
        perf,
        diagnostics: {
          "loads but renders black / nothing": "Shipped in APK assets → Android compressed it. Use delivery='storage' (adb push) OR aaptOptions noCompress. This tool defaults to storage.",
          "loads but you see it as a distant block / from outside": "Viewer at the bbox-center (open air). Use the density-centroid transform above; nudge translate toward the room.",
          "upside down / sideways": "Coordinate frame — adjust rotationEuler (try x=180 for a Y-flip, or yaw 0/90/180/270).",
          "world too big/small": "Set scale (Marble is usually metric=1; scanned worlds vary).",
          "ANR / very slow on emulator": "Too many splats for the emulator GPU — use a lightweight export; full res is fine on a headset.",
        },
        note: "PICO renders Gaussian splats NATIVELY (VERIFIED). The whole point: your custom world becomes the app backdrop. Final eye-level framing is a per-world LOOK loop (inherent), best confirmed on a headset where you look around freely.",
      });
    },
  );
}
