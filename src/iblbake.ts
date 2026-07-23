import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, expandHome } from "./util.js";

/**
 * iblbake.ts — prepare_ibl_cubemap: author a BRIGHT prefiltered floating-point IBL cubemap (.ktx) so PBR METALS
 * SHINE with real studio reflections. Wraps Filament's `cmgen` (equirect → prefiltered R11F_G11F_B10F
 * cubemap with roughness mips — the exact format the PICO SDK ImageBasedLightComponent wants).
 *
 * WHY: the emulator's system IBL environment is DARK (metals reflect black), and the editor's shipped
 * SystemIbl_ibl_brightness.ktx is a DIM GRAYSCALE brightness map (darkens the scene). A proper bright
 * COLOR environment cubemap is what makes chrome/gold read as polished metal. VISION-VERIFIED on the emulator:
 * a cmgen studio cubemap + generate_ibl_kotlin(mode=local, intensityExponent≈6) → gold/chrome reflect
 * the softbox.
 */

function cmgenBin(): string | null {
  for (const c of [
    path.join(os.homedir(), ".pico-mcp", "bin", "cmgen"),
    "/usr/local/bin/cmgen",
    "/opt/homebrew/bin/cmgen",
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** ImageMagick args to author a studio/sky/neutral equirect (2:1). */
function presetArgs(preset: string, base: string, out: string): { first: string[]; overlay?: string[] } {
  const W = 1024, H = 512;
  if (preset === "sky") {
    return { first: ["-size", `${W}x${H}`, "gradient:#bfe0ff-#20304a", base],
             overlay: [base, "(", "-size", `${W}x50`, "xc:#fffdf5", ")", "-gravity", "North", "-geometry", `+0+${Math.round(H * 0.42)}`, "-composite", "-blur", "0x10", out] };
  }
  if (preset === "neutral") {
    return { first: ["-size", `${W}x${H}`, "gradient:#f0f0f2-#3a3a40", out] };
  }
  // studio (default): bright warm top (softbox) + cool mid + dark floor
  return { first: ["-size", `${W}x${H}`, "gradient:#fffaf2-#2a3040", base],
           overlay: [base, "(", "-size", `${W}x64`, "xc:#ffffff", ")", "-gravity", "North", "-geometry", "+0+80", "-composite",
                     "(", "-size", `${W}x40`, "xc:#e8ecff", ")", "-gravity", "North", "-geometry", "+0+300", "-composite", "-blur", "0x8", out] };
}

export function registerIblBakeTools(server: McpServer) {
  server.registerTool(
    "prepare_ibl_cubemap",
    {
      description:
        "Author a BRIGHT prefiltered floating-point IBL cubemap (.ktx) so PBR METALS SHINE with studio reflections — wraps Filament's cmgen (equirect → R11F_G11F_B10F cubemap w/ roughness mips, the format ImageBasedLightComponent wants). Provide your own equirect HDR/PNG, OR auto-generate an LDR procedural PNG (preset: studio | sky | neutral). Place the output .ktx under app assets, then wire it with generate_ibl_kotlin(mode='local', intensityExponent≈6) + tag the metallic meshes. VISION-VERIFIED recipe: cmgen studio cubemap → gold/chrome reflected the softbox on the emulator. Requires cmgen at ~/.pico-mcp/bin/cmgen (Filament release binary).",
      inputSchema: {
        outKtx: z.string().describe("Output .ktx path, e.g. <project>/app/src/main/assets/ibl/studio.ktx"),
        equirect: z.string().optional().describe("Path to an equirectangular (2:1) HDR/EXR/PNG env image. If omitted, one is auto-generated from `preset`."),
        preset: z.enum(["studio", "sky", "neutral"]).optional().describe("Auto-generated environment when no equirect is given (default studio)."),
        size: z.number().int().optional().describe("Cubemap face size in px (default 256)."),
      },
    },
    async ({ outKtx, equirect, preset, size }) => {
      const cmgen = cmgenBin();
      if (!cmgen) return fail("cmgen not found. Install the Filament cmgen binary to ~/.pico-mcp/bin/cmgen (from a github.com/google/filament release, e.g. filament-<ver>-mac.tgz → bin/cmgen).");
      const out = expandHome(outKtx);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iblbake-"));

      // 1. resolve the equirect env source
      let env = equirect ? expandHome(equirect) : "";
      if (!env) {
        const p = presetArgs(preset ?? "studio", path.join(tmp, "base.png"), path.join(tmp, "env.png"));
        const r1 = await run("magick", p.first, { timeoutMs: 30_000 });
        if (r1.code !== 0) return fail(`ImageMagick failed generating the ${preset ?? "studio"} env: ${r1.stderr || r1.stdout}`.slice(0, 400));
        if (p.overlay) {
          const r2 = await run("magick", p.overlay, { timeoutMs: 30_000 });
          if (r2.code !== 0) return fail(`ImageMagick overlay failed: ${r2.stderr || r2.stdout}`.slice(0, 400));
          env = path.join(tmp, "env.png");
        } else env = p.first[p.first.length - 1];
      }
      if (!fs.existsSync(env)) return fail(`equirect env not found: ${env}`);

      // 2. cmgen → prefiltered IBL cubemap. Deploy dir gets <base>_ibl.ktx + <base>_skybox.ktx + sh.
      const deploy = path.join(tmp, "ibl");
      const r = await run(cmgen, ["-x", deploy, "--format=ktx", `--size=${size ?? 256}`, "--quiet", env], { timeoutMs: 120_000 });
      const iblKtx = fs.existsSync(deploy) ? fs.readdirSync(deploy).find((f) => f.endsWith("_ibl.ktx")) : undefined;
      if (!iblKtx) {
        // some cmgen versions write <deploy>_ibl.ktx as a sibling
        const sib = fs.readdirSync(tmp).find((f) => f.endsWith("_ibl.ktx"));
        if (!sib) return fail(`cmgen produced no *_ibl.ktx. ${r.stderr || r.stdout}`.slice(0, 500));
        fs.copyFileSync(path.join(tmp, sib), out);
      } else {
        fs.copyFileSync(path.join(deploy, iblKtx), out);
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

      const bytes = fs.statSync(out).size;
      return okJson({
        status: "baked",
        ktx: out,
        bytes,
        source: equirect ? "provided-equirect" : `auto:${preset ?? "studio"}`,
        sourceRange: equirect ? "caller-provided (inspect the source to determine dynamic range)" : "procedural LDR PNG",
        wireUp: [
          `1. The .ktx is under assets (relative path e.g. 'ibl/${path.basename(out)}').`,
          `2. generate_ibl_kotlin(packageName=..., ktxAssetPath='ibl/${path.basename(out)}', mode='local', intensityExponent=6)`,
          `3. In SpatialView.initial: SceneIBL.applyLocal(root, listOf(<metallic meshes>)).`,
          `4. GOTCHA: the receiver replaces DIRECT lighting, so use a HIGH exponent (~6/64x) for bright reflective metals; stage mode darkens the whole scene, avoid it.`,
        ],
        note: "Prefiltered floating-point cubemap for ImageBasedLightComponent. Makes PBR metals (metallic≈1, low roughness) reflect the environment. The local+exp6 studio recipe was vision-verified previously; every new app still needs its own rendered LOOK.",
      });
    },
  );
}
