import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * generate_home_env_proxy — a FAKED hit-test against the PICO default home environment (the system
 * bedroom). Native scene-understanding (sense/plane) returns 0 planes on the emulator (C1), so real
 * arbitrary-surface hit-test is headset-only. BUT the home env is a KNOWN, FIXED virtual room, so we
 * place an INVISIBLE collider proxy at its surface coords (floor y=0 + bed box + walls) and
 * Scene.rayCast lands pins ON those surfaces — pins visually stick to the real home-env floor/bed/wall.
 *
 * Returns the calibrated `room` + `shapes` to feed generate_collider_kotlin (the proven invisible
 * box-collider + PhysicsWorld + rayCast path). Then rayCast the gaze ray → place a pin at the hit.
 *
 * CALIBRATION provenance: floor y=0 is VISION-VERIFIED (a pin at y≈0 sits on the home-env floor,
 * 2026-06-20 GalleryXR capture). The bed/wall boxes are first-pass estimates from captures — refine
 * by place→capture→LOOK→adjust (the home env is stable, so calibrate once).
 */
export function registerHomeEnvProxyTools(server: McpServer) {
  server.registerTool(
    "generate_home_env_proxy",
    {
      description:
        "Faked hit-test against the PICO DEFAULT HOME ENVIRONMENT (the system bedroom): returns a calibrated invisible collider proxy (floor y=0 [vision-verified] + a bed box + the room walls) to feed generate_collider_kotlin, so Scene.rayCast lands pins ON the home-env floor/bed/walls — pins visually stick to the surfaces you see. Real arbitrary-surface scene-understanding stays headset-only (C1); this works because the home env is a KNOWN fixed room. Refine the bed/wall boxes by capture→LOOK→adjust.",
      inputSchema: {
        includeBed: z.boolean().optional().describe("Include the bed-surface box (default true)."),
        includeRoom: z.boolean().optional().describe("Include the 6-wall room (floor/ceiling/walls) AABB (default true)."),
        bedTopY: z.number().optional().describe("Calibrated bed-surface height in m (default 0.5)."),
      },
    },
    async ({ includeBed, includeRoom, bedTopY }) => {
      const bedTop = bedTopY ?? 0.5;
      // Calibrated home-env bedroom layout (first-pass from GalleryXR captures; floor y=0 verified).
      const room = includeRoom === false ? undefined : {
        halfW: 2.8,        // side walls ~±2.8m
        height: 2.6,       // ceiling ~2.6m; FLOOR at y=0 (VISION-VERIFIED)
        halfD: 2.8,        // front/back walls
        centerZ: -1.2,     // room centered ~1.2m ahead of the user
        thickness: 0.12,   // wall thickness (proven collider value)
      };
      // The bed as a box; top surface at bedTop so a rayCast hit lands a pin ON the mattress.
      // Format matches generate_collider_kotlin's shapeSpec: { kind, name, pos:{x,y,z}, size:{x,y,z} }.
      const shapes = includeBed === false ? [] : [{
        kind: "box",
        name: "HomeEnvBed",
        pos: { x: 0, y: bedTop / 2, z: -1.8 },     // bed centered ~1.8m ahead
        size: { x: 1.9, y: bedTop, z: 2.2 },       // box from floor up to bedTop
      }];

      return okJson({
        room,
        shapes,
        colliderCall: {
          tool: "generate_collider_kotlin",
          args: { packageName: "<your.app>.content", room, shapes, rayCastHelper: true },
          note: "Feed `room` + `shapes` to generate_collider_kotlin → it emits SpatialColliders.kt with PhysicsWorldComponent + INVISIBLE box colliders + a rayCast helper. Attach it in SpatialView.initial (attachPhysicsWorld THEN attachColliders), then place pins at `rayCast(gazeOrigin, gazeDir).position`.",
        },
        hitTestNote:
          "FAKED HIT-TEST: cast the HMD gaze ray (or controller ray on Swan) against these invisible proxy colliders; the nearest hit = where the user is 'pointing' at the home-env floor/bed/wall → place the pin there with its normal. Floor (y=0) is the reliable anchor.",
        calibration: {
          floor: "y=0 — VISION-VERIFIED (a pin at y≈0.03 sits on the home-env floor).",
          bed: `top y=${bedTop}, center (0,*,-1.8), size (1.9,*,2.2) — first-pass estimate; refine by capture→LOOK→adjust.`,
          walls: "halfW/halfD 2.8, height 2.6 — first-pass; refine if pins miss the visible walls.",
          stability: "The home env is a fixed environment, so calibrate once; the same proxy works on a headset showing the home env (no passthrough).",
        },
        honest:
          "This is NOT native scene-understanding (C1 headset-only). It's a pre-modeled proxy of the KNOWN home env — it ONLY matches the default home bedroom, not an arbitrary real room. On Swan with passthrough you'd use sense/plane (generate_scene_understanding_kotlin) instead.",
      });
    },
  );
}
