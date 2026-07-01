import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema } from "./appspec.js";

/**
 * remix.ts — v5.6 REMIX: turn an existing app into an AppSpec, then re-plan the DIFF to a new brief.
 *
 * remix_app decodes an existing native app (best-effort: its applicationId from build.gradle.kts + the
 * content Kotlin the loop authored — SceneLayout/SceneDataBinding/SceneInteraction/SpatialColliders/
 * lighting/environment/headset) into an approximate CURRENT AppSpec. Given a proposed NEW AppSpec for the
 * new brief, it computes the node-level DIFF (added / removed / changed) and the exact recompile set — so a
 * remix recompiles + re-verifies ONLY the changed nodes, not the whole app. It reads AUTHORED content
 * (never a bundle md5); package rename stays the caller's job (keep local.properties sdk.dir + the
 * SpatialDemo log tag). Headset-only features carry their capability class forward.
 */

function findGradlePackage(projectDir: string): string | null {
  for (const rel of ["app/build.gradle.kts", "app/build.gradle"]) {
    const p = path.join(projectDir, rel);
    try {
      const txt = fs.readFileSync(p, "utf8");
      const m = /applicationId\s*=\s*"([^"]+)"/.exec(txt) || /namespace\s*=\s*"([^"]+)"/.exec(txt);
      if (m) return m[1];
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function listContentKt(projectDir: string, pkg: string): string[] {
  const root = path.join(projectDir, "app/src/main/java", pkg.replace(/\./g, "/"), "content");
  try {
    return fs.readdirSync(root).filter((f) => f.endsWith(".kt"));
  } catch {
    return [];
  }
}

// Infer a coarse AppSpec from which content files the loop authored.
function inferSpec(projectDir: string): { spec: any; evidence: string[] } {
  const pkg = findGradlePackage(projectDir) ?? "com.example.app";
  const kt = listContentKt(projectDir, pkg);
  const has = (n: string) => kt.some((f) => f.toLowerCase().includes(n));
  const evidence = [`package=${pkg}`, `content=[${kt.join(", ")}]`];

  const env = has("meshenvironment") ? "texturedMesh" : has("splatenvironment") ? "splat" : has("homeenvproxy") ? "homeEnvProxy" : "procedural";
  const rig = has("lightingrig") || has("fulllighting") ? "fullRig" : has("scenelighting") || has("lighting") ? "sun" : "none";
  const scene: any = { id: "main", environment: { kind: env }, lighting: { rig }, colliders: has("collider") ? { room: { halfW: 2.5, height: 2.5, halfD: 2.5, centerZ: -2 }, props: [] } : { props: [] } };

  const spec: any = { meta: { appName: pkg.split(".").pop() ?? "app", packageName: pkg, stageStyle: "3", brief: "(decoded from existing app)" }, scenes: [scene], navigation: { startScene: "main" } };
  if (has("scenelayout")) spec.layouts = [{ id: "layout1", sceneId: "main", pattern: "shelf", count: 6 }];
  if (has("databinding")) spec.data = [{ id: "data1", source: "json", asset: "data/items.json", bindsTo: ["objects1"] }];
  if (has("scenelayout")) spec.objects = [{ id: "objects1", sceneId: "main", source: "quad", layoutRef: "layout1", ...(has("databinding") ? { dataBindRef: "data1" } : {}) }];
  if (has("sceneinteraction")) spec.interactions = [{ id: "select", trigger: "gaze_dwell", target: "objects1", action: "showDetail", driveChannel: "broadcast" }];
  if (has("headsetreadiness")) spec.headsetLayer = [{ feature: "controller-ray / headset-only paths", capabilityClass: "C3", tool: "generate_headset_readiness_codegen" }];
  return { spec, evidence };
}

// node-level diff between two specs (by section + id)
function diffSpecs(cur: any, next: any) {
  const sections = ["scenes", "layouts", "objects", "data", "interactions"] as const;
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const s of sections) {
    const c = new Map((cur[s] ?? []).map((n: any) => [n.id, JSON.stringify(n)]));
    const n = new Map((next[s] ?? []).map((x: any) => [x.id, JSON.stringify(x)]));
    for (const id of n.keys()) if (!c.has(id)) added.push(`${s}/${id}`);
    for (const id of c.keys()) if (!n.has(id)) removed.push(`${s}/${id}`);
    for (const id of n.keys()) if (c.has(id) && c.get(id) !== n.get(id)) changed.push(`${s}/${id}`);
  }
  return { added, removed, changed, recompile: [...added, ...changed] };
}

export function registerRemixTools(server: McpServer) {
  server.registerTool(
    "remix_app",
    {
      description:
        "Remix an existing native app to a new brief. Decodes the app (its applicationId + the content Kotlin the loop authored) into an approximate CURRENT AppSpec; if you pass a proposedSpec (the new brief's AppSpec, e.g. from instantiate_template), it returns the node-level DIFF (added/removed/changed) + the exact recompile set — so you recompile + re-verify ONLY the changed nodes, not the whole app. Reads authored content (never a bundle md5). Remember to re-grep/rename the package + keep local.properties sdk.dir + the SpatialDemo log tag; headset-only features carry their class forward.",
      inputSchema: {
        existingProjectDir: z.string().describe("Path to the existing Android project (e.g. ~/AndroidStudioProjects/showroomxr-native)."),
        newBrief: z.string().describe("The new brief to remix toward."),
        proposedSpec: z.any().optional().describe("Optional new-brief AppSpec (from instantiate_template/plan_app_spec). If given, returns the diff + recompile set."),
      },
    },
    async ({ existingProjectDir, newBrief, proposedSpec }) => {
      if (!fs.existsSync(existingProjectDir)) return okJson({ status: "error", error: `project not found: ${existingProjectDir}` });
      const { spec: current, evidence } = inferSpec(existingProjectDir);
      if (proposedSpec === undefined) {
        return okJson({ status: "decoded", newBrief, currentSpec: current, evidence, next: "Author the new-brief AppSpec (instantiate_template or plan_app_spec), then call remix_app again with proposedSpec to get the diff + recompile set." });
      }
      const parsed = appSpecSchema.safeParse(proposedSpec);
      if (!parsed.success) return okJson({ status: "invalid_proposed", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const diff = diffSpecs(current, parsed.data);
      return okJson({
        status: "diffed",
        newBrief,
        currentSpec: current,
        diff,
        recompileOnly: diff.recompile,
        note: `Remix: recompile + re-verify only [${diff.recompile.join(", ") || "nothing changed"}]; ${diff.removed.length} node(s) removed. Rename the package + keep local.properties sdk.dir + the SpatialDemo tag.`,
      });
    },
  );
}
