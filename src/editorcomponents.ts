import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { okJson } from "./util.js";

/**
 * editorcomponents.ts — v9.6 the EDITOR COMPANION: custom ECS components the Spatial Editor renders.
 *
 * The editor (Qt6/QML "xBird") reads per-project custom component definitions: a `.Component/`
 * dir next to the .spatialproject holding `component.json` (registry) + `<Name>.spatialEditorComponent`
 * JSONs. The Inspector auto-renders typed property editors and hot-reloads on file change
 * (CustomComponentWrapper / InspectorController onFileChange). Schema keys verified as literal
 * strings in the 0.13.4 binary: componentName/packageName/displayName/properties/dataType/
 * defaultValue/elements. HONESTY: the editor-side render is verified structurally (files load,
 * editor opens clean) unless a GUI capture shows the component — the emit is C0, the Inspector
 * render claim stays structural until LOOKED at.
 */
const PROP_TYPES = ["bool", "string", "number", "vec3", "vec4", "quat", "uint32", "float3", "int3", "bool3"] as const;

export function registerEditorCustomComponentTools(server: McpServer) {
  server.registerTool(
    "emit_editor_components",
    {
      description:
        "Emit CUSTOM ECS COMPONENT SCHEMA definitions in the Spatial Editor's format: writes <projectRoot>/.Component/component.json + one <Name>.spatialEditorComponent JSON per component (schema keys verified as literal strings in the 0.13.4 editor binary: componentName/packageName/displayName/properties{displayName,dataType,defaultValue}). These are a valid, machine-readable description of a component's typed properties. HONEST STATUS (v9.6, tested): the files emit correctly and the editor OPENS CLEAN on the project (structural PASS), but the component does NOT yet appear in the editor's Add Component palette — that palette is componentList.json INSIDE the editor bundle (Contents/MacOS/inspectorconfigs/, a DIFFERENT schema: belongTo/fullCompName/pkgName/componentType), which is signature-covered and NOT a per-project drop-in. So this tool ships the SCHEMA half (useful as interchange / for a future editor build or a signed palette install); making it show in the GUI palette is an unsolved, bundle-level step. Do NOT claim the Inspector renders it without a GUI capture you LOOK at (I looked: only built-ins showed).",
      inputSchema: {
        projectRoot: z.string().describe("Dir containing the .spatialproject file."),
        components: z
          .array(
            z.object({
              componentName: z.string().describe("PascalCase name, e.g. GameStats"),
              packageName: z.string().describe("e.g. com.example.knockdownxr"),
              displayName: z.string().optional(),
              properties: z.array(
                z.object({
                  displayName: z.string(),
                  dataType: z.enum(PROP_TYPES),
                  defaultValue: z.any(),
                }),
              ),
            }),
          )
          .min(1),
      },
    },
    async ({ projectRoot, components }) => {
      const proj = fs.readdirSync(projectRoot).find((f) => f.endsWith(".spatialproject"));
      if (!proj) return okJson({ status: "error", error: `no .spatialproject in ${projectRoot}` });
      const compDir = path.join(projectRoot, ".Component");
      fs.mkdirSync(compDir, { recursive: true });
      const files: string[] = [];
      for (const c of components) {
        const def = {
          componentName: c.componentName,
          packageName: c.packageName,
          displayName: c.displayName ?? c.componentName,
          properties: c.properties.map((p) => ({ displayName: p.displayName, dataType: p.dataType, defaultValue: p.defaultValue })),
        };
        const fn = `${c.componentName}.spatialEditorComponent`;
        fs.writeFileSync(path.join(compDir, fn), JSON.stringify(def, null, 2));
        files.push(fn);
      }
      fs.writeFileSync(path.join(compDir, "component.json"), JSON.stringify({ components: files }, null, 2));
      return okJson({
        status: "ok",
        wrote: [".Component/component.json", ...files.map((f) => `.Component/${f}`)],
        verify: `STRUCTURAL only: the schema files emit + the editor opens clean. The component will NOT appear in the Add Component palette (that is componentList.json in the editor bundle, not a per-project file) — verified negative in v9.6. Treat these files as component-schema interchange, not a GUI palette install.`,
      });
    },
  );
}
