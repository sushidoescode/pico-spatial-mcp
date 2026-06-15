import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, fail, expandHome } from "./util.js";
import { resolveProjectRoot, decodeEditorProject } from "./editorproject.js";

/**
 * v3.2 headless editor tools (the recon's "buildable now" set — no GUI, no editor running):
 *  - decode_editor_settings: parse the UserSettings ECS files (decode_editor_project skips them).
 *  - editor_project_diff: snapshot a decode, then report the structural delta after an edit/build.
 *  - editor_op: apply a whitelisted file LEVER (EditorEnvSettings / EditorContainerSettings) — the
 *    honest "editor_op" (the editor has NO scripting/RPC; the only headless authoring is file-edit
 *    + re-build). Whether the headless build CONSUMES these settings is an open question, so pair
 *    with editor_project_diff after a rebuild to confirm any effect.
 */

const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };
const statSize = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

function settingsSummary(root: string) {
  const us = path.join(root, "UserSettings");
  const env = readJson(path.join(us, "EditorEnvSettings.json"));
  const cont = readJson(path.join(us, "EditorContainerSettings.json"));
  const envV = env?.vectors?.__elements?.[0];
  const contV = cont?.vectors?.__elements?.[0];
  const vec = (v: any) => (v ? { x: v.x, y: v.y, z: v.z, ...(v.w !== undefined ? { w: v.w } : {}) } : null);
  const others = ["EditorSceneSettings.yaml", "EditorUserSettings.yaml", "EditorViewportSettings.yaml", "history.json"]
    .filter((f) => exists(path.join(us, f)))
    .map((f) => ({ name: f, bytes: statSize(path.join(us, f)), scope: "per-user (gitignored)" }));
  return {
    present: exists(us),
    environment: envV
      ? { environmentIdx: envV.environmentIdx, intensityExponent: envV.intensityExponent, rotation: envV.rotation, useColor: envV.useColor, skyboxColor: vec(envV.skyboxColor), sceneGuid: envV.sceneGuid }
      : null,
    container: contV
      ? { containerType: contV.containerType, planeSize: vec(contV.planeSize), volumeSize: vec(contV.volumeSize), unitType: contV.unitType, showUISample: contV.showUISample }
      : null,
    otherFiles: others,
    note: "EditorEnvSettings.json + EditorContainerSettings.json are git-committed (shared, editable levers); the .yaml/history are per-user. Whether the headless --ide_noGraphics build CONSUMES these (vs only the GUI at open time) is UNVERIFIED.",
  };
}

// ---- structural diff between two decode_editor_project objects ----
function diffDecode(a: any, b: any): string[] {
  const d: string[] = [];
  if (a?.project?.version !== b?.project?.version) d.push(`project.version: ${a?.project?.version} -> ${b?.project?.version}`);
  // scenes by name
  const sa = new Map<string, any>((a?.scenes?.files ?? []).map((s: any) => [s.name, s]));
  const sb = new Map<string, any>((b?.scenes?.files ?? []).map((s: any) => [s.name, s]));
  for (const n of sb.keys()) if (!sa.has(n)) d.push(`scene ADDED: ${n}`);
  for (const n of sa.keys()) if (!sb.has(n)) d.push(`scene REMOVED: ${n}`);
  for (const n of sb.keys()) {
    if (!sa.has(n)) continue;
    const x = sa.get(n), y = sb.get(n);
    const cmpList = (k: string) => {
      const xs = new Set<string>(x[k] ?? []), ys = new Set<string>(y[k] ?? []);
      const added = [...ys].filter((v) => !xs.has(v)), removed = [...xs].filter((v) => !ys.has(v));
      if (added.length) d.push(`${n}.${k} +[${added.join(", ")}]`);
      if (removed.length) d.push(`${n}.${k} -[${removed.join(", ")}]`);
    };
    cmpList("materials"); cmpList("components"); cmpList("componentIds"); cmpList("assetReferences");
    if (x.meshes !== y.meshes) d.push(`${n}.meshes: ${x.meshes} -> ${y.meshes}`);
  }
  // assets by type
  const at = (o: any) => o?.assets?.byType ?? {};
  const types = new Set([...Object.keys(at(a)), ...Object.keys(at(b))]);
  for (const t of types) {
    const ca = at(a)[t]?.count ?? 0, cb = at(b)[t]?.count ?? 0;
    if (ca !== cb) d.push(`assets.${t}: ${ca} -> ${cb}`);
  }
  // baked
  if (a?.cacheData?.bundleCache?.targetMd5 !== b?.cacheData?.bundleCache?.targetMd5)
    d.push(`editor cache re-baked (BundleCache targetMd5 ${a?.cacheData?.bundleCache?.targetMd5} -> ${b?.cacheData?.bundleCache?.targetMd5}) — this is the EDITOR's cache (changes on an editor re-save); NOTE the Gradle editor-asset bundle build is non-deterministic so its raw md5 is not a content signal`);
  if (a?.cacheData?.materialCache?.distinctMaterials !== b?.cacheData?.materialCache?.distinctMaterials)
    d.push(`materialCache.distinctMaterials: ${a?.cacheData?.materialCache?.distinctMaterials} -> ${b?.cacheData?.materialCache?.distinctMaterials}`);
  return d;
}

export function registerEditorV32Tools(server: McpServer) {
  server.registerTool(
    "decode_editor_settings",
    {
      description:
        "Parse a Spatial-Editor project's UserSettings ECS files (which decode_editor_project skips): EditorEnvSettings.json (skyboxColor/useColor/environmentIdx/intensityExponent/rotation) and EditorContainerSettings.json (containerType/planeSize/volumeSize/unitType), plus the per-user YAMLs. These are the file LEVERS editor_op edits.",
      inputSchema: {
        projectDir: z.string().describe("SpatialPackContent dir or an Android project root (~ expanded)."),
      },
    },
    async ({ projectDir }) => {
      const root = resolveProjectRoot(projectDir);
      if (!root || !exists(root)) return fail(`Project path not found: ${expandHome(projectDir)}`);
      return okJson({ projectRoot: root, settings: settingsSummary(root) });
    },
  );

  server.registerTool(
    "editor_project_diff",
    {
      description:
        "Snapshot a project's decode, then report the STRUCTURAL delta after an edit or build (scenes/prims/materials/components/asset-refs added/removed, assets by type, and whether the bundle was REBUILT via targetMd5). First call (no baseline) saves a snapshot; later calls diff against it. This is how a headless editor_op verifies its effect.",
      inputSchema: {
        projectDir: z.string().describe("SpatialPackContent dir or Android project root."),
        baselinePath: z.string().optional().describe("Where the snapshot JSON lives (default /tmp/pico-render/<name>.editor-baseline.json)."),
        snapshot: z.boolean().optional().describe("Force (re)save the baseline instead of diffing."),
      },
    },
    async ({ projectDir, baselinePath, snapshot }) => {
      const root = resolveProjectRoot(projectDir);
      if (!root || !exists(root)) return fail(`Project path not found: ${expandHome(projectDir)}`);
      const base = expandHome(baselinePath ?? `/tmp/pico-render/${path.basename(root)}.editor-baseline.json`);
      fs.mkdirSync(path.dirname(base), { recursive: true });
      const current = decodeEditorProject(root, 50);
      if (snapshot || !exists(base)) {
        fs.writeFileSync(base, JSON.stringify(current, null, 2));
        return okJson({ action: "baseline_saved", baselinePath: base, note: "Make your edit/build, then call editor_project_diff again to see the delta." });
      }
      const prev = readJson(base);
      const deltas = diffDecode(prev, current);
      return okJson({ action: "diff", baselinePath: base, changed: deltas.length > 0, deltas: deltas.length ? deltas : ["(no structural changes detected)"] });
    },
  );

  server.registerTool(
    "editor_op",
    {
      description:
        "Apply a whitelisted editor FILE LEVER headlessly (the honest editor_op — the editor has no scripting/RPC; file-edit + rebuild is the only headless authoring path). op=set_skybox_color (EditorEnvSettings skyboxColor+useColor), set_environment (environmentIdx+intensityExponent), set_stage_size (EditorContainerSettings planeSize/volumeSize). Edits the committed ECS JSON and returns before/after. NOTE: whether the headless build consumes these is UNVERIFIED — pair with editor_project_diff after a rebuild to confirm the effect (and back up the file; this mutates it).",
      inputSchema: {
        projectDir: z.string().describe("SpatialPackContent dir or Android project root."),
        op: z.enum(["set_skybox_color", "set_environment", "set_stage_size"]).describe("Which file lever to apply."),
        rgb: z.array(z.number()).optional().describe("set_skybox_color: [r,g,b] 0..1."),
        environmentIdx: z.number().optional().describe("set_environment: environment index."),
        intensityExponent: z.number().optional().describe("set_environment: IBL intensity exponent."),
        planeSize: z.array(z.number()).optional().describe("set_stage_size: [x,y,z]."),
        volumeSize: z.array(z.number()).optional().describe("set_stage_size: [x,y,z]."),
      },
    },
    async ({ projectDir, op, rgb, environmentIdx, intensityExponent, planeSize, volumeSize }) => {
      const root = resolveProjectRoot(projectDir);
      if (!root || !exists(root)) return fail(`Project path not found: ${expandHome(projectDir)}`);
      const us = path.join(root, "UserSettings");
      const setVec = (t: any, a: number[]) => { if (t) { t.x = a[0]; t.y = a[1]; t.z = a[2]; } };
      const editJson = (file: string, mutate: (v: any) => void) => {
        const fp = path.join(us, file);
        const obj = readJson(fp);
        const v0 = obj?.vectors?.__elements?.[0];
        if (!v0) return { ok: false, error: `${file} missing or has no vectors.__elements[0]` };
        const before = JSON.parse(JSON.stringify(v0));
        if (!exists(fp + ".bak")) fs.copyFileSync(fp, fp + ".bak");
        mutate(v0);
        fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
        return { ok: true, file, before, after: v0 };
      };
      let res: any;
      if (op === "set_skybox_color") {
        if (!rgb || rgb.length !== 3) return fail("set_skybox_color needs rgb [r,g,b].");
        res = editJson("EditorEnvSettings.json", (v) => {
          if (v.skyboxColor) { v.skyboxColor.x = rgb[0]; v.skyboxColor.y = rgb[1]; v.skyboxColor.z = rgb[2]; if (v.skyboxColor.w === undefined) v.skyboxColor.w = 1; }
          v.useColor = true;
        });
      } else if (op === "set_environment") {
        res = editJson("EditorEnvSettings.json", (v) => {
          if (environmentIdx !== undefined) v.environmentIdx = environmentIdx;
          if (intensityExponent !== undefined) v.intensityExponent = intensityExponent;
        });
      } else if (op === "set_stage_size") {
        res = editJson("EditorContainerSettings.json", (v) => {
          if (planeSize?.length === 3) setVec(v.planeSize, planeSize);
          if (volumeSize?.length === 3) setVec(v.volumeSize, volumeSize);
        });
      }
      if (!res?.ok) return fail(res?.error ?? "edit failed");
      return okJson({
        op, ...res,
        verify: "Re-run the headless build, then editor_project_diff to see if it changed the bake. A .bak of the file was saved. Effect on the headless build is UNVERIFIED.",
      });
    },
  );
}
