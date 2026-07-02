import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * layoutplan.ts — v5.8 `plan_layout_and_camera`: layout intelligence + camera planning.
 *
 * Computes an analytical layout's slots (mirrors SceneLayout's math), checks them against the KNOWN
 * home-env bed AABB so N-item scenes don't place cards IN THE BED (the retained home-env-proxy lesson;
 * floor y=0 is the only vision-verified anchor), and plans the `emulator_look` sweep so verify_app_spec can
 * SEE every object (content outside the forward FOV can't be captured — C2). Advisory: the free cam is
 * driven by RELATIVE drags, so the sweep is a count + azimuth span, not absolute poses.
 */

// Conservative AABB of the PICO home-env bed/platform (vision-calibrated; floor y=0).
const BED = { xMin: -1.25, xMax: 1.25, yMin: 0, yMax: 0.75, zMin: -3.6, zMax: -0.5 };

function slots(pattern: string, count: number, p: any): { x: number; y: number; z: number }[] {
  const spacing = p.spacing ?? 0.6, cy = p.centerY ?? 1.4, cz = p.centerZ ?? -2.5;
  const out: { x: number; y: number; z: number }[] = [];
  if (pattern === "arc") {
    const radius = p.radius ?? 2.5, span = p.arcSpanDeg ?? 90;
    const step = count > 1 ? span / (count - 1) : 0, start = -span / 2;
    for (let i = 0; i < count; i++) {
      const a = ((start + i * step) * Math.PI) / 180;
      out.push({ x: radius * Math.sin(a), y: cy, z: -radius * Math.cos(a) });
    }
  } else if (pattern === "grid" || pattern === "shelf") {
    const cols = pattern === "grid" ? p.columns ?? 3 : Math.ceil(count / (p.shelves ?? 2));
    const rows = Math.ceil(count / cols);
    const startX = (-(cols - 1) * spacing) / 2, startY = cy + ((rows - 1) * spacing) / 2;
    for (let i = 0; i < count; i++) out.push({ x: startX + (i % cols) * spacing, y: startY - Math.floor(i / cols) * spacing, z: cz });
  } else {
    const startX = (-(count - 1) * spacing) / 2;
    for (let i = 0; i < count; i++) out.push({ x: startX + i * spacing, y: cy, z: cz });
  }
  return out;
}

const inBed = (s: { x: number; y: number; z: number }) => s.x >= BED.xMin && s.x <= BED.xMax && s.y >= BED.yMin && s.y <= BED.yMax && s.z >= BED.zMin && s.z <= BED.zMax;

export function registerLayoutPlanTools(server: McpServer) {
  server.registerTool(
    "plan_layout_and_camera",
    {
      description:
        "Plan an N-item layout intelligently: compute the slots (mirrors SceneLayout math), flag any that land IN THE HOME-ENV BED (so cards aren't sunk into the bed — floor y=0 is the only vision-verified anchor) with a suggested fix, and plan the emulator_look sweep verify_app_spec needs to SEE every object (azimuth span + capture count; content outside the forward FOV can't be captured, C2). Advisory poses (the free cam takes relative drags). Use before compile to size the layout + before verify to know how many capture angles to sweep.",
      inputSchema: {
        pattern: z.enum(["wall", "grid", "arc", "shelf"]),
        count: z.number().int(),
        params: z.record(z.any()).optional().describe("radius/spacing/columns/shelves/centerY/centerZ/arcSpanDeg."),
        onHomeEnv: z.boolean().optional().describe("If true (default), check slots against the home-env bed AABB."),
      },
    },
    async ({ pattern, count, params, onHomeEnv }) => {
      const p = params ?? {};
      const sl = slots(pattern, count, p);
      const collisions = onHomeEnv === false ? [] : sl.map((s, i) => ({ i, s })).filter((e) => inBed(e.s));
      // azimuth (deg) of each slot from forward -Z; plan the sweep to cover the span.
      const az = sl.map((s) => (Math.atan2(s.x, -s.z) * 180) / Math.PI);
      const minAz = Math.min(...az), maxAz = Math.max(...az);
      const span = maxAz - minAz;
      const FOV = 55; // usable forward FOV degrees per capture
      const captures = Math.max(1, Math.ceil((span + 1e-6) / FOV));
      const sweep = Array.from({ length: captures }, (_, k) => ({ yawDeg: Math.round(minAz + (span * (k + 0.5)) / captures), pitchDeg: 0, targetZ: Math.round((sl[0]?.z ?? -2.5) * 10) / 10 }));
      const advice: string[] = [];
      if (collisions.length) advice.push(`${collisions.length} slot(s) land in the home-env bed — raise centerY to >=1.1 or move centerZ beyond ${BED.zMin}.`);
      if (captures > 1) advice.push(`objects span ${Math.round(span)}° — verify needs ${captures} capture angles (sweep emulator_look across the azimuth range).`);
      if (!advice.length) advice.push("layout fits the forward FOV over the floor — a single forward capture sees all objects.");
      return okJson({ pattern, count, slots: sl, bedCollisions: collisions, azimuthSpanDeg: Math.round(span), cameraSweep: sweep, captureCount: captures, advice });
    },
  );
}
