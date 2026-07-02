import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, expandHome } from "./util.js";
import { analyzeFrame } from "./eye.js";
import { appendLedgerEntry } from "./ledger.js";

/**
 * usdrender.ts — v7.4 OFF-DEVICE USD RENDERER (the C2-killer for USD-authored content).
 *
 * Renders a USD scene (a procedural asset, a generate_composition_scene, any .usd/.usda/.usdc/.usdz) to a
 * PNG on the Mac HOST via the installed `usdrecord` (Apple USD Tools) + Hydra Storm — deterministic, HD,
 * sub-second, NO emulator, NO build. It composes a lighting rig (dome + distant key light) around the
 * asset so the render is clean and even (usdrecord's default camera-light blows out flat faces). Records a
 * DISTINCT `usd_host_render` evidence class.
 *
 * THE SOUL CONSTRAINT (why this is a new class, never `vision_verified`): a Storm render is NOT the on-
 * device PICO Filament render — different renderer, materials, lighting. It verifies scene COMPOSITION /
 * geometry / layout / color deterministically (great for pre-checking a generated asset before the
 * expensive bake→build→emulator cycle), NOT device appearance. It is bucketed separately in every report
 * and NEVER upgraded to device vision_verified. It only covers USD-authored content (not Kotlin-built scenes).
 */

function usdrecordBin(): string {
  for (const c of ["/usr/bin/usdrecord", "/usr/local/bin/usdrecord", "usdrecord"]) {
    if (c === "usdrecord" || fs.existsSync(c)) return c;
  }
  return "usdrecord";
}

/** Build a render-rig USDA that references the asset and adds even dome+distant lighting. */
function renderRig(assetPath: string, domeIntensity: number, keyIntensity: number, keyRotXYZ: [number, number, number]): string {
  return [
    `#usda 1.0`,
    `(`,
    `    upAxis = "Y"`,
    `    defaultPrim = "Rig"`,
    `)`,
    `def Xform "Rig"`,
    `{`,
    `    def "Content" (`,
    `        references = @${assetPath}@`,
    `    )`,
    `    {`,
    `    }`,
    `    # A textureless DomeLight = uniform ambient fill (intentional; usdrecord warns "no texture asset path",`,
    `    # which is benign per the OpenUSD spec). For an equirect-lit world, add inputs:texture:file (format="latlong").`,
    `    def DomeLight "Dome"`,
    `    {`,
    `        float inputs:intensity = ${domeIntensity}`,
    `    }`,
    `    def DistantLight "Key"`,
    `    {`,
    `        float inputs:intensity = ${keyIntensity}`,
    `        float inputs:angle = 5`,
    `        double3 xformOp:rotateXYZ = (${keyRotXYZ[0]}, ${keyRotXYZ[1]}, ${keyRotXYZ[2]})`,
    `        uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

export function registerUsdRenderTools(server: McpServer) {
  server.registerTool(
    "render_usd_offscreen",
    {
      description:
        "Render a USD scene (.usd/.usda/.usdc/.usdz — a procedural asset, a composition, etc.) to a PNG OFF-DEVICE on the Mac host via usdrecord + Hydra Storm: deterministic, HD, sub-second, NO emulator, NO build. Composes an even dome+distant light rig so the render is clean (usdrecord's default camera-light blows out flat faces). Returns the PNG path, a content sha256, and objective measurements (object count / colors / coverage via the same analyzer the automated eye uses). Optionally records a `usd_host_render` ledger entry — a DISTINCT evidence class: it verifies scene COMPOSITION/geometry/color, NOT the on-device Filament appearance, and is NEVER conflated with device vision_verified. Use it to PRE-CHECK a generated asset/composition fast, before the expensive bake→build→emulator cycle. (Meshes should be doubleSided or have correct outward normals, or backfaces render dark.)",
      inputSchema: {
        assetPath: z.string().describe("Path to the USD file (.usd/.usda/.usdc/.usdz)."),
        outPath: z.string().optional().describe("Output PNG path (default /tmp/usdrender/<name>.png)."),
        width: z.number().int().optional().describe("Image width px (default 800)."),
        complexity: z.enum(["low", "medium", "high", "veryhigh"]).optional().describe("Refinement (default high)."),
        domeIntensity: z.number().optional().describe("Dome (ambient) light intensity (default 450)."),
        keyIntensity: z.number().optional().describe("Distant key light intensity (default 700)."),
        keyRotation: z.array(z.number()).length(3).optional().describe("Key light euler rotation [x,y,z] deg (default [-40,30,0])."),
        camera: z.string().optional().describe("Camera prim path/name in the asset (default: usdrecord auto-frames the geometry)."),
        app: z.string().optional().describe("If set with record=true, records a `usd_host_render` ledger entry for this app."),
        claim: z.string().optional().describe("The composition claim being verified (for the ledger)."),
        record: z.boolean().optional().describe("Record a `usd_host_render` ledger entry (default false)."),
      },
    },
    async ({ assetPath, outPath, width, complexity, domeIntensity, keyIntensity, keyRotation, camera, app, claim, record }) => {
      const asset = expandHome(assetPath);
      if (!fs.existsSync(asset)) return fail(`asset not found: ${asset}`);
      const bin = usdrecordBin();
      const out = expandHome(outPath ?? path.join(os.tmpdir(), "usdrender", `${path.basename(asset).replace(/\.[^.]+$/, "")}.png`));
      fs.mkdirSync(path.dirname(out), { recursive: true });

      // Compose the render rig (absolute asset ref so it resolves from the temp dir).
      const rigDir = fs.mkdtempSync(path.join(os.tmpdir(), "usdrig-"));
      const rigPath = path.join(rigDir, "rig.usda");
      fs.writeFileSync(rigPath, renderRig(asset, domeIntensity ?? 450, keyIntensity ?? 700, (keyRotation as [number, number, number]) ?? [-40, 30, 0]));

      const args = ["--complexity", complexity ?? "high", "--imageWidth", String(width ?? 800), "--disableCameraLight"];
      if (camera) args.push("--camera", camera);
      args.push(rigPath, out);
      const r = await run(bin, args, { timeoutMs: 60_000 });
      try { fs.rmSync(rigDir, { recursive: true, force: true }); } catch {}
      if (!fs.existsSync(out)) return fail(`usdrecord produced no image. ${r.stderr || r.stdout}`.slice(0, 600));

      const buf = fs.readFileSync(out);
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const measurements = await analyzeFrame(out).catch(() => null);

      let ledger: any;
      if (record && app) {
        ledger = appendLedgerEntry(app, {
          claim: claim ?? `USD composition of ${path.basename(asset)} renders off-device`,
          evidenceType: "usd_host_render",
          artifactPath: out,
          attestation: `off-device Storm render (${width ?? 800}px); measured objectCount=${measurements?.objectCount}, coverage=${measurements?.nonBlackCoverage?.toFixed?.(3)}, colors=${JSON.stringify(measurements?.dominantColors?.slice(0, 4))}`,
        });
      }
      return okJson({
        status: "rendered",
        path: out,
        sha256: sha,
        bytes: buf.length,
        measurements,
        ...(ledger ? { ledger } : {}),
        note: "OFF-DEVICE Storm render — verifies COMPOSITION/geometry/color deterministically, NOT the on-device Filament appearance. Distinct `usd_host_render` class; NEVER conflate with device vision_verified. LOOK at it to pre-check a generated asset before baking/building.",
      });
    },
  );
}
