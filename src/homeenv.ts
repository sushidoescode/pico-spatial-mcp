import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * ⚠️ LARGELY OBSOLETE as of 2026-07-28 — PREFER REAL PLANES.
 * This tool exists because we believed the emulator had no scene understanding. It does. A Spatial
 * SDK app in FULL SPACE (an OPEN Stage) receives 43 real planes with BED/WALL/CEILING/CABINET
 * semantics and metre bounding boxes from PICO's built-in MR simulation (ledger
 * emulator-scene-understanding seq 0). Use generate_scene_understanding_kotlin and real
 * PlaneAnchors instead of the hand-calibrated boxes below wherever the app can hold a Stage.
 * The hand-guessed room here is also the wrong size: it assumes ~5.6 x 5.6 m; the real simulated
 * bedroom is ~4.9 x 2.9 m.
 * Kept only as a fallback for app shapes that genuinely cannot enter Full Space.
 *
 * generate_home_env_proxy — a legacy FAKED hit-test against the PICO default home environment (the
 * system bedroom). Native scene understanding is now preferred: an open Stage receives roughly 43
 * simulated semantic planes and 42–44 mesh anchors on the emulator. This proxy remains only for app
 * shapes that cannot hold an open Stage or for explicit fixed-room calibration experiments. It
 * places an INVISIBLE collider proxy at estimated surface coords (floor y=0 + bed box + walls), so
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
        "LEGACY fixed-room proxy for an app that cannot use an open Stage: returns estimated invisible floor/bed/wall box colliders for the PICO default bedroom. Prefer generate_scene_understanding_kotlin whenever possible; emulator runtime probes measured roughly 43 simulated semantic planes and 42–44 mesh anchors. This proxy is not native scene understanding and must be calibrated by capture→LOOK→adjust.",
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
          "This is NOT native scene understanding. It is an estimated proxy of one fixed emulator bedroom and does not generalize to an arbitrary room. Prefer sense/plane on an open emulator Stage for simulated surfaces; Swan is still required to prove behavior against a user's physical room.",
      });
    },
  );

  // ── calibrate_home_env ─────────────────────────────────────────────────────
  // The fallback version of the "measure the room" idea. The scene-provider source asset is not
  // available to this repo, but the runtime now exposes simulated plane/mesh geometry on an open
  // Stage. Use this visual proxy calibration only when that native lane cannot be used: place a
  // marker at a proxy face → capture_frame → LOOK →
  // does it sit ON the visible surface? → feed back a per-face delta → this tool returns the adjusted
  // generate_home_env_proxy room box + a per-face confidence map (vision-verified vs first-pass).
  const FACE = z.enum(["floor", "ceiling", "wallFront", "wallBack", "wallLeft", "wallRight"]);
  server.registerTool(
    "calibrate_home_env",
    {
      description:
        "Vision-calibrate the LEGACY fixed-room proxy when an app cannot use native scene understanding. An open emulator Stage now exposes simulated plane/mesh geometry and is the preferred measured lane. This fallback returns six proxy faces with probe positions, a per-face looked/not-looked confidence map, and an adjusted box from caller-supplied visual deltas; it does not claim those estimates are runtime scene measurements.",
      inputSchema: {
        room: z.object({
          halfW: z.number(), height: z.number(), halfD: z.number(), centerZ: z.number(), thickness: z.number().optional(),
        }).partial().optional().describe("Override the current proxy room box (defaults to the generate_home_env_proxy calibration: halfW 2.8, height 2.6, halfD 2.8, centerZ -1.2, thickness 0.12)."),
        observations: z.array(z.object({
          face: FACE,
          status: z.enum(["ok", "too-far", "too-close"]).describe("ok = marker sits ON the visible surface. too-far = the real surface is BEYOND the marker (marker floats in front of it) → grow. too-close = the surface is NEARER (marker is past/behind it) → shrink."),
          deltaMeters: z.number().optional().describe("How far to move this face along its outward normal (default 0.25 for too-far, -0.25 for too-close; sign auto-applied from status if omitted)."),
          note: z.string().optional(),
        })).optional().describe("Per-face vision observations from the capture→LOOK step. Drives the proposed room adjustment + tags faces vision-verified."),
        verifiedFaces: z.array(FACE).optional().describe("Faces already vision-confirmed in prior iterations (carries calibration state across stateless calls; floor is always verified)."),
        probeInset: z.number().optional().describe("How far inside a face to place its probe marker so it visibly rests on the surface (default 0.04m)."),
      },
    },
    async ({ room, observations, verifiedFaces, probeInset }) => {
      const cur = {
        halfW: room?.halfW ?? 2.8,
        height: room?.height ?? 2.6,
        halfD: room?.halfD ?? 2.8,
        centerZ: room?.centerZ ?? -1.2,
        thickness: room?.thickness ?? 0.12,
      };
      const inset = probeInset ?? 0.04;
      const r2 = (n: number) => Math.round(n * 1000) / 1000;
      const obs = observations ?? [];
      const obsFor = (f: string) => obs.find((o) => o.face === f);
      // signed outward delta per face (outward = away from room interior), from status or explicit deltaMeters
      const outwardDelta = (f: string): number => {
        const o = obsFor(f);
        if (!o || o.status === "ok") return 0;
        if (o.deltaMeters !== undefined) return o.deltaMeters;
        return o.status === "too-far" ? 0.25 : -0.25;
      };

      // Geometry of the 6 faces of the proxy room (interior surfaces the user sees).
      const cz = cur.centerZ, h = cur.height, hw = cur.halfW, hd = cur.halfD;
      const frontZ = cz - hd, backZ = cz + hd; // front = far (-Z), back = behind (+Z)
      const faces = [
        { name: "floor",     fixed: "y=0",            center: { x: 0, y: 0, z: cz },            inward: { x: 0, y: 1, z: 0 },  probe: { x: 0, y: inset, z: cz },                controls: "y=0 (FIXED ANCHOR — never changes)" },
        { name: "ceiling",   fixed: `y=${r2(h)}`,     center: { x: 0, y: h, z: cz },            inward: { x: 0, y: -1, z: 0 }, probe: { x: 0, y: r2(h - inset), z: cz },        controls: "height" },
        { name: "wallFront", fixed: `z=${r2(frontZ)}`,center: { x: 0, y: h / 2, z: frontZ },    inward: { x: 0, y: 0, z: 1 },  probe: { x: 0, y: r2(h / 2), z: r2(frontZ + inset) }, controls: "halfD & centerZ" },
        { name: "wallBack",  fixed: `z=${r2(backZ)}`, center: { x: 0, y: h / 2, z: backZ },     inward: { x: 0, y: 0, z: -1 }, probe: { x: 0, y: r2(h / 2), z: r2(backZ - inset) },  controls: "halfD & centerZ" },
        { name: "wallLeft",  fixed: `x=${r2(-hw)}`,   center: { x: -hw, y: h / 2, z: cz },      inward: { x: 1, y: 0, z: 0 },  probe: { x: r2(-hw + inset), y: r2(h / 2), z: cz },   controls: "halfW (X-symmetric)" },
        { name: "wallRight", fixed: `x=${r2(hw)}`,    center: { x: hw, y: h / 2, z: cz },       inward: { x: -1, y: 0, z: 0 }, probe: { x: r2(hw - inset), y: r2(h / 2), z: cz },    controls: "halfW (X-symmetric)" },
      ];

      // Confidence map: floor is always vision-verified; otherwise verified if in verifiedFaces or this run's obs is "ok".
      const verifiedSet = new Set<string>(["floor", ...(verifiedFaces ?? [])]);
      for (const o of obs) if (o.status === "ok") verifiedSet.add(o.face);
      const confidence: Record<string, string> = {};
      for (const f of faces) confidence[f.name] = verifiedSet.has(f.name) ? "vision-verified" : "first-pass";

      // Propose an adjusted room from the observed deltas (front/back & left/right math).
      const dCeil = outwardDelta("ceiling");
      const dFront = outwardDelta("wallFront"), dBack = outwardDelta("wallBack");
      const dLeft = outwardDelta("wallLeft"), dRight = outwardDelta("wallRight");
      const proposed = {
        halfW: r2(hw + (dLeft + dRight) / 2),
        height: r2(h + dCeil),
        halfD: r2(hd + (dFront + dBack) / 2),
        centerZ: r2(cz + (dBack - dFront) / 2),
        thickness: cur.thickness,
      };
      const changed = JSON.stringify(proposed) !== JSON.stringify(cur);
      const warnings: string[] = [];
      if (dLeft !== dRight && (dLeft !== 0 || dRight !== 0))
        warnings.push("wallLeft and wallRight deltas differ, but the proxy room is X-symmetric (no centerX) — halfW used the average; add a centerX field to generate_home_env_proxy if you need an off-center X.");

      return okJson({
        currentRoom: cur,
        faces,
        confidenceMap: confidence,
        proposedRoom: changed ? proposed : undefined,
        proposedDiff: changed
          ? { halfW: `${cur.halfW}→${proposed.halfW}`, height: `${cur.height}→${proposed.height}`, halfD: `${cur.halfD}→${proposed.halfD}`, centerZ: `${cur.centerZ}→${proposed.centerZ}` }
          : "no observations supplied → no change; this call returns the current faces + probe pins to start the loop.",
        warnings: warnings.length ? warnings : undefined,
        loop: [
          "1. Generate the proxy colliders: generate_home_env_proxy → generate_collider_kotlin (room=currentRoom), build_and_run.",
          "2. For each non-verified face: place a small visible marker at faces[i].probe (e.g. a pin entity at that world pos, or rayCast a ray toward faces[i].center and pin the hit), then capture_frame + emulator_look to FACE it.",
          "3. LOOK: does the marker sit flush ON the visible surface? If yes → observation {face, status:'ok'} (tags it vision-verified). If it floats in front of the real surface → 'too-far'. If it's sunk past/behind the surface → 'too-close'.",
          "4. Call calibrate_home_env again with room=currentRoom, observations=[...], verifiedFaces=[...] → it returns proposedRoom. Feed proposedRoom back into generate_home_env_proxy/generate_collider_kotlin.",
          "5. Repeat until every face is vision-verified. The home env is fixed, so calibrate once.",
        ],
        honest:
          "These returned wall/ceiling values are VISION-CALIBRATED proxy estimates, not native scene measurements. The original scene-provider asset is not retained here, but an open emulator Stage now supplies simulated plane/mesh geometry; use generate_scene_understanding_kotlin for that measured runtime lane. This proxy matches only the default bedroom. Swan remains necessary to verify a user's physical room.",
      });
    },
  );
}
