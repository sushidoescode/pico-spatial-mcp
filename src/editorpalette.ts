import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";

const run = promisify(execFile);

/**
 * editorpalette.ts — v10.9 (P5 SOLVED): register a component in the Spatial Editor's Add Component palette.
 *
 * The palette is componentList.json INSIDE the (signed) editor bundle
 * (Contents/MacOS/inspectorconfigs/). v9.6 emitted the per-project SCHEMA files but the palette
 * ignored them; v10.9 adds the missing half: append a ThirdParty/PLUGIN entry to componentList.json
 * and ad-hoc re-sign the bundle. VISION-VERIFIED: 'GameStats' appears under a project section in the
 * Add Component dialog. This MODIFIES + RE-SIGNS an installed app — opt-in, with a full backup + restore.
 */
const EDITOR = path.join(os.homedir(), "Library/PICO/sdk/0.13/editor/Spatial Editor.app");

export function registerEditorPaletteTools(server: McpServer) {
  server.registerTool(
    "install_editor_palette",
    {
      description:
        "Register custom components in the PICO Spatial Editor's Add Component PALETTE (v10.9, VISION-VERIFIED). This is the second half of emit_editor_components: it appends ThirdParty/PLUGIN entries to componentList.json INSIDE the editor bundle and ad-hoc re-signs the app, so the components appear in the Add Component dialog (under a project section, above 'General'). ⚠️ MODIFIES + RE-SIGNS the installed Spatial Editor.app — it makes a full .BACKUP once (restore=true reverts). Requires the user to have authorized bundle modification. macOS only. After install, launch the editor on a project and open Add Component to see them.",
      inputSchema: {
        components: z
          .array(z.object({ shortName: z.string(), fullCompName: z.string(), pkgName: z.string(), desc: z.string().optional() }))
          .optional()
          .describe("Components to add to the palette (shortName shows in the list). Omit with restore=true."),
        restore: z.boolean().optional().describe("Revert the editor bundle from the .BACKUP (undo all palette edits + re-sign)."),
        editorApp: z.string().optional().describe("Path to Spatial Editor.app (default the SDK 0.13 location)."),
      },
    },
    async ({ components, restore, editorApp }) => {
      const app = editorApp ?? EDITOR;
      const backup = `${app}.BACKUP`;
      const clPath = path.join(app, "Contents/MacOS/inspectorconfigs/componentList.json");
      if (!fs.existsSync(app)) return okJson({ status: "error", error: `editor not found at ${app}` });

      if (restore) {
        if (!fs.existsSync(backup)) return okJson({ status: "error", error: "no .BACKUP to restore from" });
        await run("rm", ["-rf", app]);
        await run("cp", ["-R", backup, app]);
        return okJson({ status: "ok", restored: true, note: "editor reverted to the pristine backup (original signature)." });
      }
      if (!components?.length) return okJson({ status: "error", error: "provide components (or restore=true)" });

      // 1. one-time full backup (the restore path)
      const madeBackup = !fs.existsSync(backup);
      if (madeBackup) await run("cp", ["-R", app, backup]);

      // 2. append to the palette (idempotent by shortName)
      const cl = JSON.parse(fs.readFileSync(clPath, "utf8"));
      const before = cl.components.length;
      for (const c of components) {
        if (cl.components.some((e: any) => e.shortName === c.shortName)) continue;
        cl.components.push({
          belongTo: "ThirdParty",
          iconPath: "/usr/share/icons/thirdparty-component.png",
          shortName: c.shortName,
          fullCompName: c.fullCompName,
          pkgName: c.pkgName,
          desc: c.desc ?? `${c.fullCompName} (MCP-emitted)`,
          componentType: "PLUGIN",
        });
      }
      fs.writeFileSync(clPath, JSON.stringify(cl, null, 1));

      // 3. ad-hoc re-sign (content changed)
      await run("codesign", ["--force", "--deep", "-s", "-", app], { timeout: 300_000 });

      return okJson({
        status: "ok",
        added: cl.components.length - before,
        paletteEntries: cl.components.length,
        backup: madeBackup ? backup : "(existing)",
        verify: "Launch the editor on a project, select an entity, Add Component — the new components appear under the project section (vision-verified with GameStats). Undo with restore=true.",
        honesty: "This modifies + re-signs an installed app. The .BACKUP is the full restore path.",
      });
    },
  );
}
