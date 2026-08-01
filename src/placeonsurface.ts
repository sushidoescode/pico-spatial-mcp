import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, okJson } from "./util.js";
import { measureModel, type ModelMeasurement } from "./modelmeasure.js";
import { bakeTexturedModel } from "./bundle.js";
import { surfacePlacementKotlin } from "./surfaceplace.js";

/**
 * placeonsurface.ts — v31 `place_model_on_surface`: ONE CALL from a GLB on disk to the wired MR
 * placement Kotlin.
 *
 * The three steps it chains are each individually proven (measure_model / bake_textured_model /
 * generate_surface_placement_kotlin), and the composed recipe ran end-to-end in the real mrtable
 * app: ledger com.picoagent.mrtable seq 10-11 — the generated placement object built into the app
 * and RE-SEATED itself after a COLD emulator restart (planes=40 after 7 retries, FLOOR at y=0.40),
 * LOOKed at. What kept going wrong before this tool was the HANDOFF between the steps: the measured
 * size/baseLift were retyped by hand into the generator, and the bundle's model name was guessed.
 * This orchestrator wires measure -> bake -> generate so those numbers can never be transcribed
 * wrong: modelSize/baseLift come from the file, modelName/bundle come from the bake.
 *
 * composeSurfacePlacement is PURE (measurement + bake info -> Kotlin) so the composition is
 * deterministically testable without the spatialbundle toolchain; the tool wraps it with the real
 * measure + bake.
 */

const SEMANTICS = ["FLOOR", "TABLE", "WALL"] as const;

export interface ComposeOptions {
  packageName: string;
  semantic: (typeof SEMANTICS)[number];
  objectName?: string;
  /** Extra metres ABOVE the surface, added to the measured baseLift (default 0). */
  offset?: number;
  collider?: "boxTop" | "boxFull" | "none";
  pollSeconds?: number;
}

/** Deterministic: same measurement + bake info + options -> byte-identical output. */
export function composeSurfacePlacement(
  measured: ModelMeasurement,
  bake: { bundle: string; modelName: string },
  o: ComposeOptions,
) {
  const objectName =
    o.objectName ?? `${o.semantic.charAt(0)}${o.semantic.slice(1).toLowerCase()}Placement`;
  const baseLift = +(measured.baseLift + (o.offset ?? 0)).toFixed(4);
  const bundleAsset = `asset://${path.basename(bake.bundle)}`;
  const kotlin = surfacePlacementKotlin({
    packageName: o.packageName,
    objectName,
    bundleAsset,
    modelName: bake.modelName,
    semantic: o.semantic,
    modelSize: measured.size,
    // The label is a convenience; the measured baseLift below is what the generator uses.
    originAt: measured.originAt === "bottom" ? "bottom" : "center",
    baseLift,
    collider: o.collider ?? "boxTop",
    pollSeconds: o.pollSeconds ?? 20,
  });
  return {
    kotlin,
    objectName,
    bundleAsset,
    baseLift,
    targetPath: `app/src/main/java/${o.packageName.replace(/\./g, "/")}/${objectName}.kt`,
    usage: `${objectName}.seat(sceneRoot) { sceneRoot.addChild(it) }  // inside SpatialView.initial, Dispatchers.Main, after the scene loads`,
  };
}

export function registerPlaceOnSurfaceTools(server: McpServer) {
  server.registerTool(
    "place_model_on_surface",
    {
      description:
        "ONE CALL from a .glb/.gltf on disk to Kotlin that seats it on a DETECTED real-world surface — chains the proven v30 steps measure_model -> bake_textured_model -> generate_surface_placement_kotlin so their numbers are wired, never retyped: modelSize/baseLift come straight from the file's accessors, modelName/bundle come from the bake. The underlying recipe is emulator-proven end-to-end (ledger com.picoagent.mrtable seq 10-11: the generated placement built into the real mrtable app and re-seated itself after a COLD restart — planes=40 after 7 retries, FLOOR at y=0.40 — LOOKed at); this orchestrator is that same chain composed, and the bake step RUNS the local spatialbundle toolchain (not a dry run). Emits the 6-trap seating object: polls for planes, takes height from the plane (never a constant), converts anchor space, applies the MEASURED base lift, attaches a PRIMITIVE box collider + PhysicsWorldComponent, and seats a FLOOR model in FRONT of the user. Returns the wired Kotlin + baked bundle + insertion instructions + measured dims/baseLift. REQUIRES Full Space (an open Stage; a WindowContainer returns 0 planes); stage style 1 (Mixed) shows the real room behind the model.",
      inputSchema: {
        modelPath: z.string().describe("Absolute path to the .glb/.gltf to measure + bake + seat."),
        semantic: z.enum(SEMANTICS).describe("Target plane label: FLOOR / TABLE / WALL."),
        packageName: z.string().describe("Kotlin package for the emitted object, e.g. com.example.app.content"),
        modelName: z.string().optional().describe("Override the model name inside the bundle (default: what bake_textured_model reports)."),
        offset: z.number().optional().describe("Extra metres ABOVE the surface, added to the measured baseLift (default 0)."),
        objectName: z.string().optional().describe("Generated object name (default <Semantic>Placement, e.g. FloorPlacement)."),
        projectDir: z.string().optional().describe("Android project root: bakes the bundle directly into <projectDir>/app/src/main/assets/. Omit to bake next to the model and copy yourself."),
        collider: z.enum(["boxTop", "boxFull", "none"]).default("boxTop").describe("boxTop = a slab across the model's top; boxFull = whole bbox; none."),
      },
    },
    async ({ modelPath, semantic, packageName, modelName, offset, objectName, projectDir, collider }) => {
      const measured = measureModel(modelPath);
      if ("error" in measured) return fail(`measure step failed: ${measured.error}`);

      const stem = path.basename(modelPath, path.extname(modelPath)).toLowerCase().replace(/[^a-z0-9_]/g, "_");
      const outBundle = projectDir
        ? path.join(projectDir, "app/src/main/assets", `${stem}.bundle`)
        : path.join(path.dirname(modelPath), `${stem}.bundle`);
      const bake = await bakeTexturedModel({ modelPath, outBundle });
      if ("error" in bake) return fail(`bake step failed (measurement succeeded): ${bake.error}`);

      const composed = composeSurfacePlacement(
        measured,
        { bundle: bake.bundle, modelName: modelName ?? bake.modelName },
        { packageName, semantic, objectName, offset, collider },
      );
      return okJson({
        ...composed,
        measured: {
          size: measured.size,
          min: measured.min,
          max: measured.max,
          baseLift: measured.baseLift,
          originAt: measured.originAt,
          warnings: measured.warnings,
        },
        bake: {
          bundle: bake.bundle,
          modelName: modelName ?? bake.modelName,
          sizeMB: bake.sizeMB,
          rendersTextured: bake.rendersTextured,
          note: bake.note,
        },
        insertion: [
          `1. Write kotlin to ${composed.targetPath}.`,
          projectDir
            ? `2. The baked bundle is already at ${bake.bundle} (inside app/src/main/assets/).`
            : `2. Copy ${bake.bundle} into app/src/main/assets/ so ${composed.bundleAsset} resolves.`,
          `3. Call ${composed.usage}`,
          "4. Stage style 1 (Mixed) or 2 (Progressive) to see the real room behind the model; Full Space is REQUIRED either way.",
        ],
        verify: [
          "logcat 'SURFACE| planes=N after R retries' then 'SURFACE| seated <model> on " + semantic + " at (x,y,z)'.",
          "LOOK at a capture — a model resting on a real surface is the only proof the height was right.",
          "Raycast down onto it to prove the collider is queryable, not merely attached.",
        ],
      });
    },
  );
}
