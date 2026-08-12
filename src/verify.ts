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
      // Typed contract (2026-07-28 revision lane, works on SDK v1). The honesty split is the
      // schema: structural status is machine truth about EXISTENCE; the visual half only ever
      // reports frames CAPTURED — appearance has no machine field here because looking is the
      // agent's job (groundTruthRule says so in-band).
      outputSchema: {
        structural: z.object({
          status: z.enum(["pass", "fail", "error", "skipped"]),
          error: z.string().optional().describe("Present when status=error (e.g. Agent Bridge unreachable)."),
          entityCount: z.number().optional(),
          componentsSeen: z.array(z.string()).optional(),
          results: z.array(z.object({
            check: z.string(),
            pass: z.boolean(),
            detail: z.string().optional(),
          }).passthrough()).optional(),
        }).passthrough(),
        visual: z.object({
          status: z.enum(["captured", "error", "skipped"]),
          framesCaptured: z.number().optional(),
          error: z.string().optional(),
          baselineDiffs: z.array(z.object({ frame: z.number(), diff: z.number().nullable() })).optional()
            .describe("Coarse perceptual diffs vs baselineDir, when one was given."),
        }).passthrough(),
        groundTruthRule: z.string(),
      },
    },
    async (args) => {
      const content: any[] = [];
      const GROUND_TRUTH_RULE =
        "structural proves the scene graph EXISTS; the frames prove it RENDERS/looks right. " +
        "You MUST look at the frames — a structural PASS alone is NOT \"verified\". Grade with capability_report.";

      // --- structural (assert_scene core) ---
      let structLine = "skipped";
      let structDetail = "";
      let structural: Record<string, unknown> = { status: "skipped" };
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
          structural = { status: "error", error: a.error };
        } else {
          structLine = a.pass ? "PASS" : "FAIL";
          structural = {
            status: a.pass ? "pass" : "fail",
            entityCount: a.scene.entityCount,
            componentsSeen: a.scene.componentsSeen,
            results: a.results.map((r: any) => ({ check: r.check, pass: r.pass, ...(r.detail ? { detail: r.detail } : {}) })),
          };
          structDetail =
            `\nStructural (${a.scene.entityCount} entities, comps: ${a.scene.componentsSeen.join(",")}):\n` +
            a.results.map((r: any) => `  ${r.pass ? "OK " : "FAIL"} ${r.check}${r.detail ? ` · ${r.detail}` : ""}`).join("\n");
        }
      }

      // --- visual (verify_visual core) ---
      let visualLine = "skipped";
      let visualDetail = "";
      let visual: Record<string, unknown> = { status: "skipped" };
      if (!args.skipVisual) {
        const sw = await sweepFrames({ serial: args.serial, steps: args.steps, stepDx: args.stepDx, baselineDir: args.baselineDir });
        if (sw.error) {
          visualLine = `ERROR (${sw.error})`;
          visual = { status: "error", error: sw.error };
        } else {
          visualLine = `${sw.frames.length} frames captured — LOOK at the images below`;
          visual = {
            status: "captured",
            framesCaptured: sw.frames.length,
            ...(args.baselineDir ? { baselineDiffs: sw.frames.map((f) => ({ frame: f.i, diff: f.diff ?? null })) } : {}),
          };
          content.push(...(await framesToImageContent(sw.frames, args.maxReturned ?? 4)));
          if (args.baselineDir) visualDetail = "\nVisual diffs vs baseline (coarse): " + sw.frames.map((f) => `f${f.i}=${f.diff ?? "n/a"}`).join(" ");
        }
      }

      content.unshift({
        type: "text",
        text:
          `# verify — STRUCTURAL: ${structLine}  |  VISUAL: ${visualLine}\n` +
          `GROUND-TRUTH RULE: ${GROUND_TRUTH_RULE}`,
      });
      content.push({ type: "text", text: (structDetail + visualDetail).trim() || "(no detail)" });
      return { content, structuredContent: { structural, visual, groundTruthRule: GROUND_TRUTH_RULE } };
    },
  );
}
