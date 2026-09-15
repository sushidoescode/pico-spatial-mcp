import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";
import {
  isToolchainFailure,
  resolveOperationToolchain,
  toolchainProvenance,
  type OperationToolchain,
} from "./toolchain.js";
import type { ToolchainIO, UnusableToolchain } from "./toolchainselection.js";

const run = promisify(execFile);

/**
 * editorpalette.ts — v10.9 (P5 SOLVED): register a component in the Spatial Editor's Add Component palette.
 *
 * The palette is componentList.json INSIDE the (signed) editor bundle
 * (Contents/MacOS/inspectorconfigs/). v9.6 emitted the per-project SCHEMA files but the palette
 * ignored them; v10.9 adds the missing half: append a ThirdParty/PLUGIN entry to componentList.json
 * and ad-hoc re-sign the bundle. VISION-VERIFIED: 'GameStats' appears under a project section in the
 * Add Component dialog. This MODIFIES + RE-SIGNS an installed app — opt-in, with a full backup + restore.
 *
 * Which bundle: the `editor` component of the SELECTED PICO toolchain — the same per-call selection
 * `src/editor.ts` runs (`resolveOperationToolchain({ required: ["editor"], primary: "editor" })`),
 * so $PICO_HOME, a project's `spatial.tools.dir` and an explicit version pin all apply. Until the
 * 38.0.0 fix wave this module held a module-scope constant naming `~/Library/PICO/sdk/0.13/…`, so on
 * a host carrying 0.13 beside 6.1 it re-signed the legacy bundle while every other editor operation
 * launched the selected one. An explicit `editorApp` is honoured as an explicit path and wins over
 * selection, exactly as an explicit override does elsewhere.
 */

/** The palette file, relative to the app bundle root. */
const PALETTE_RELATIVE = path.join("Contents", "MacOS", "inspectorconfigs", "componentList.json");

export interface EditorPaletteDependencies {
  /** Selection IO. Tests inject an in-memory tree so no real editor bundle is ever selected or touched. */
  io?: ToolchainIO;
}

export interface EditorPaletteApp {
  /** The app bundle root (`…/Spatial Editor.app`) this call operates on. */
  app: string;
  source: "explicit" | "selected";
  /** The selection that named the bundle; null when an explicit `editorApp` carried the call. */
  toolchain: OperationToolchain | null;
}

/**
 * Resolve the bundle ONCE per call. An explicit `editorApp` is an explicit path; otherwise the
 * selected installation's `editor` component decides, and when nothing is selectable the selection
 * layer's own structured `unavailable/*` failure is returned as-is — no path is invented.
 */
export function resolveEditorPaletteApp(editorApp: string | undefined, io?: ToolchainIO): EditorPaletteApp | UnusableToolchain {
  const explicit = (editorApp ?? "").trim();
  if (explicit) return { app: explicit, source: "explicit", toolchain: null };
  const prepared = resolveOperationToolchain({ required: ["editor"], primary: "editor" }, io);
  if (isToolchainFailure(prepared)) return prepared;
  // `bin` is `<app>/Contents/MacOS/Spatial Editor`; the bundle root is two directories above it.
  return { app: path.resolve(path.dirname(prepared.bin), "..", ".."), source: "selected", toolchain: prepared };
}

export function registerEditorPaletteTools(server: McpServer, deps: EditorPaletteDependencies = {}) {
  server.registerTool(
    "install_editor_palette",
    {
      description:
        "Register custom components in the PICO Spatial Editor's Add Component PALETTE (v10.9, VISION-VERIFIED). This is the second half of emit_editor_components: it appends ThirdParty/PLUGIN entries to componentList.json INSIDE the editor bundle and ad-hoc re-signs the app, so the components appear in the Add Component dialog (under a project section, above 'General'). ⚠️ MODIFIES + RE-SIGNS the installed Spatial Editor.app — it makes a full .BACKUP once (restore=true reverts). Requires the user to have authorized bundle modification. macOS only. The bundle is the `editor` component of the SELECTED PICO toolchain (the same selection every editor operation runs) unless editorApp names one explicitly; the result discloses which bundle was used and where the selection came from. After install, launch the editor on a project and open Add Component to see them.",
      inputSchema: {
        components: z
          .array(z.object({ shortName: z.string(), fullCompName: z.string(), pkgName: z.string(), desc: z.string().optional() }))
          .optional()
          .describe("Components to add to the palette (shortName shows in the list). Omit with restore=true."),
        restore: z.boolean().optional().describe("Revert the editor bundle from the .BACKUP (undo all palette edits + re-sign)."),
        editorApp: z.string().optional().describe("Explicit path to a Spatial Editor.app bundle. Honoured as an explicit path: it wins over selection. Default: the `editor` component of the selected PICO toolchain ($PICO_HOME / spatial.tools.dir / the newest usable version), never a hardcoded location; when nothing is selectable the structured unavailable/* selection failure is returned."),
      },
    },
    async ({ components, restore, editorApp }) => {
      const resolved = resolveEditorPaletteApp(editorApp, deps.io);
      // The selection layer's own failure shape ({status:"unavailable", code, detail}), verbatim.
      if (isToolchainFailure(resolved)) return okJson(resolved);
      const { app, source, toolchain } = resolved;
      const provenance = { editorApp: app, editorAppSource: source, ...(toolchain ? toolchainProvenance(toolchain) : {}) };
      const backup = `${app}.BACKUP`;
      const clPath = path.join(app, PALETTE_RELATIVE);
      if (!fs.existsSync(app)) return okJson({ status: "error", error: `editor not found at ${app}`, ...provenance });

      if (restore) {
        if (!fs.existsSync(backup)) return okJson({ status: "error", error: "no .BACKUP to restore from", ...provenance });
        await run("rm", ["-rf", app]);
        await run("cp", ["-R", backup, app]);
        return okJson({ status: "ok", restored: true, note: "editor reverted to the pristine backup (original signature).", ...provenance });
      }
      if (!components?.length) return okJson({ status: "error", error: "provide components (or restore=true)", ...provenance });

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
        ...provenance,
      });
    },
  );
}
