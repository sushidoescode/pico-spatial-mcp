import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";

const run = promisify(execFile);
const FONT = fs.existsSync("/System/Library/Fonts/Supplemental/Arial Bold.ttf")
  ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
  : "/System/Library/Fonts/Helvetica.ttc"; // font FILE paths — name lookups fail on some magick builds

/**
 * signage.ts — v13 (the TEXTURE lever): generate emissive NEON SIGNAGE textures with ImageMagick.
 *
 * The edgeDetail finding: flat-shaded emissive GEOMETRY can't move the fidelity edgeDetail metric
 * no matter how dense — that needs TEXTURE (fine surface detail). This also closes the real-TEXT
 * gap (the native SDK has no runtime TextComponent). A signage PNG bakes onto a backdrop plane via
 * bake_textured_model -> a spatialbundle -> a textured mesh in the scene (crisp text + fine detail
 * at any scale). Host-side generation is verifiable NOW by LOOKING at the PNG (no emulator needed);
 * the in-world bake is verified on-device. Styles: marquee (framed title + tagline), grid (neon
 * lattice), scoreboard (LANE/FRAME/SCORE rows). Transparent background so it composites as a sign.
 */
export function registerSignageTools(server: McpServer) {
  server.registerTool(
    "generate_signage_texture",
    {
      description:
        "Generate an emissive NEON SIGNAGE texture PNG with ImageMagick — the TEXTURE lever for fidelity edgeDetail (flat-shaded geometry can't move it; surface detail can) AND real TEXT (the native SDK has no runtime TextComponent). Styles: 'marquee' (a framed glowing TITLE + tagline), 'grid' (a neon lattice/circuit pattern for fine detail), 'scoreboard' (LANE/FRAME/SCORE rows). Writes a transparent-background PNG at outPath. VERIFY NOW by LOOKING at the PNG (host-side, no emulator). To put it in-world: bake_textured_model(modelPath=<a plane GLB textured with this PNG>, outBundle=assets/sign.bundle) then load it on the backdrop (raw GLB renders black — bake first). Returns {file, width, height, style, next}.",
      inputSchema: {
        outPath: z.string().describe("Output .png path, e.g. /tmp/sign/strike.png"),
        style: z.enum(["marquee", "grid", "scoreboard"]).describe("Signage style."),
        title: z.string().optional().describe("marquee: the big glowing word (e.g. 'STRIKE!'). scoreboard: the header."),
        tagline: z.string().optional().describe("marquee: small line under the title."),
        rows: z.array(z.object({ label: z.string(), value: z.string() })).optional().describe("scoreboard: the LANE/FRAME/SCORE rows."),
        accent: z.string().optional().describe("Neon hex color (default #ff2d95 magenta)."),
        accent2: z.string().optional().describe("Second neon hex for the glow/grid (default #22e0ff cyan)."),
        width: z.number().optional().describe("Texture width px (default 1024; use POT for GPU)."),
        height: z.number().optional().describe("Texture height px (default 512)."),
      },
    },
    async ({ outPath, style, title, tagline, rows, accent, accent2, width, height }) => {
      const W = width ?? 1024, H = height ?? 512;
      const A = accent ?? "#ff2d95", A2 = accent2 ?? "#22e0ff";
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const errors: string[] = [];
      const mag = async (args: string[]) => { try { await run("magick", args, { timeout: 90_000 }); } catch (e: any) { errors.push(String(e?.stderr ?? e?.message ?? e).slice(0, 200)); } };

      if (style === "grid") {
        // a neon lattice: two colors of thin lines on transparent — pure fine detail for edgeDetail
        const step = Math.round(W / 16);
        await mag([
          "-size", `${W}x${H}`, "xc:none",
          "-fill", "none", "-stroke", A2, "-strokewidth", "3",
          ...Array.from({ length: Math.ceil(W / step) + 1 }, (_, i) => ["-draw", `line ${i * step},0 ${i * step},${H}`]).flat(),
          "-stroke", A, "-strokewidth", "3",
          ...Array.from({ length: Math.ceil(H / step) + 1 }, (_, i) => ["-draw", `line 0,${i * step} ${W},${i * step}`]).flat(),
          // node dots at intersections
          "-stroke", "none", "-fill", "#ffffff",
          ...Array.from({ length: Math.ceil(W / step) + 1 }, (_, i) => Array.from({ length: Math.ceil(H / step) + 1 }, (_2, j) => ["-draw", `circle ${i * step},${j * step} ${i * step + 4},${j * step}`]).flat()).flat(),
          outPath,
        ]);
      } else if (style === "scoreboard") {
        const rws = rows ?? [{ label: "LANE 1", value: "READY" }, { label: "FRAME", value: "1 / 10" }, { label: "SCORE", value: "0" }, { label: "STRIKES", value: "0" }];
        const args = ["-size", `${W}x${H}`, "xc:none",
          "-fill", "none", "-stroke", A2, "-strokewidth", "6", "-draw", `roundrectangle 8,8 ${W - 8},${H - 8} 28,28`,
          "-stroke", "none", "-fill", A2, "-font", FONT, "-pointsize", `${Math.round(H / 8)}`, "-gravity", "north", "-annotate", `+0+${Math.round(H / 20)}`, (title ?? "SCOREBOARD").toUpperCase(),
        ];
        const rowH = (H - H / 4) / rws.length;
        rws.forEach((r, i) => {
          const y = Math.round(H / 4 + i * rowH);
          args.push("-fill", "#cfe0ff", "-pointsize", `${Math.round(H / 12)}`, "-gravity", "northwest", "-annotate", `+${Math.round(W / 12)}+${y}`, r.label.toUpperCase());
          args.push("-fill", "#ffffff", "-gravity", "northeast", "-annotate", `+${Math.round(W / 12)}+${y}`, r.value.toUpperCase());
        });
        args.push(outPath);
        await mag(args);
      } else {
        // marquee: framed glowing title + tagline, double-stroke glow via a blurred underlay
        const glow = outPath.replace(/\.png$/, ".glow.png");
        await mag(["-size", `${W}x${H}`, "xc:none",
          "-fill", A, "-font", FONT, "-pointsize", `${Math.round(H / 3)}`, "-gravity", "center", "-annotate", "+0-20", (title ?? "STRIKE!").toUpperCase(),
          "-blur", "0x18", glow]);
        await mag([glow,
          "-fill", "none", "-stroke", A2, "-strokewidth", "8", "-draw", `roundrectangle 14,14 ${W - 14},${H - 14} 32,32`,
          "-stroke", "none", "-fill", "#ffffff", "-font", FONT, "-pointsize", `${Math.round(H / 3)}`, "-gravity", "center", "-annotate", "+0-20", (title ?? "STRIKE!").toUpperCase(),
          "-fill", A2, "-pointsize", `${Math.round(H / 12)}`, "-gravity", "south", "-annotate", `+0+${Math.round(H / 12)}`, (tagline ?? "NEON STRIKE ALLEY").toUpperCase(),
          outPath]);
        try { fs.unlinkSync(glow); } catch { /* ignore */ }
      }

      const ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 500;
      return okJson({
        status: ok ? "ok" : "error",
        file: outPath, width: W, height: H, style,
        errors: errors.length ? errors : undefined,
        next: "LOOK at the PNG to verify (host-side). In-world: texture a plane GLB with it, bake_textured_model -> assets/sign.bundle, load on the backdrop (raw GLB renders black — bake first). Real TEXT + fine detail the native SDK can't draw at runtime.",
        honesty: ok ? "The PNG is generated + host-verifiable now; the in-world render is device-verified after baking." : "generation failed — is ImageMagick installed? (brew install imagemagick)",
      });
    },
  );
}
