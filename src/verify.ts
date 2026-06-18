import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAssertScene } from "./assertscene.js";
import { sweepFrames, framesToImageContent } from "./verifyvisual.js";

/**
 * verify — the trustworthy verification GATE: runs STRUCTURAL truth (assert_scene via the Agent
 * Bridge) AND VISUAL ground truth (verify_visual orbit-sweep) in one call, and returns both — the
 * structural pass/fail PLUS the rendered frames for the agent to LOOK at. This is the honest "is it
 * actually working" check the autonomous loop should call before claiming done: structural proves
 * EXISTENCE, the frames prove APPEARANCE. Neither alone is sufficient.
 */
export function registerVerifyTools(server: McpServer) {
  server.registerTool(
    "verify",
    {
      description:
        "The verification GATE: combine STRUCTURAL truth (assert_scene — Agent Bridge dump_scene + assertions) and VISUAL ground truth (verify_visual — orbit-sweep capture) in one call. Returns the structural pass/fail AND the rendered frames to LOOK at. Use before claiming a build works: structural = exists, frames = looks right; you must inspect the images, not just the pass flag. Requires generate_agent_bridge injected for the structural half (visual half works regardless).",
      inputSchema: {
        applicationId: z.string().describe("App id for the structural half, e.g. com.example.spatialdemo."),
        serial: z.string().optional().describe("adb device serial (default emulator-5554)."),
        tag: z.string().optional().describe("Agent Bridge logcat tag (default AgentBridge)."),
        entitiesPresent: z.array(z.string()).optional().describe("Structural: entity names that must be present."),
        minEntities: z.number().int().optional().describe("Structural: minimum entity count."),
        componentsPresent: z.array(z.string()).optional().describe("Structural: component class names that must be present."),
        steps: z.number().int().min(1).max(6).optional().describe("Visual: frames in the orbit sweep (default 3)."),
        stepDx: z.number().optional().describe("Visual: per-step yaw px (default 340)."),
        baselineDir: z.string().optional().describe("Visual: optional baseline frame dir for a coarse perceptual diff."),
        maxReturned: z.number().int().min(1).max(6).optional().describe("Visual: max frames returned as images (default 4)."),
        skipStructural: z.boolean().optional(),
        skipVisual: z.boolean().optional(),
      },
    },
    async (args) => {
      const content: any[] = [];

      // --- structural (assert_scene core) ---
      let structLine = "skipped";
      let structDetail = "";
      if (!args.skipStructural) {
        const a = await runAssertScene({
          applicationId: args.applicationId,
          serial: args.serial,
          tag: args.tag,
          entitiesPresent: args.entitiesPresent,
          minEntities: args.minEntities,
          componentsPresent: args.componentsPresent,
        });
        if ("error" in a) {
          structLine = `ERROR (${a.error})`;
        } else {
          structLine = a.pass ? "PASS" : "FAIL";
          structDetail =
            `\nStructural (${a.scene.entityCount} entities, comps: ${a.scene.componentsSeen.join(",")}):\n` +
            a.results.map((r: any) => `  ${r.pass ? "OK " : "FAIL"} ${r.check}${r.detail ? ` · ${r.detail}` : ""}`).join("\n");
        }
      }

      // --- visual (verify_visual core) ---
      let visualLine = "skipped";
      let visualDetail = "";
      if (!args.skipVisual) {
        const sw = await sweepFrames({ serial: args.serial, steps: args.steps, stepDx: args.stepDx, baselineDir: args.baselineDir });
        if (sw.error) {
          visualLine = `ERROR (${sw.error})`;
        } else {
          visualLine = `${sw.frames.length} frames captured — LOOK at the images below`;
          content.push(...(await framesToImageContent(sw.frames, args.maxReturned ?? 4)));
          if (args.baselineDir) visualDetail = "\nVisual diffs vs baseline (coarse): " + sw.frames.map((f) => `f${f.i}=${f.diff ?? "n/a"}`).join(" ");
        }
      }

      content.unshift({
        type: "text",
        text:
          `# verify — STRUCTURAL: ${structLine}  |  VISUAL: ${visualLine}\n` +
          `GROUND-TRUTH RULE: structural proves the scene graph EXISTS; the frames prove it RENDERS/looks right. ` +
          `You MUST look at the frames — a structural PASS alone is NOT "verified". Grade with capability_report.`,
      });
      content.push({ type: "text", text: (structDetail + visualDetail).trim() || "(no detail)" });
      return { content };
    },
  );
}
