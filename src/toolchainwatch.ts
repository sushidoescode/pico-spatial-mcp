import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { okJson } from "./util.js";

/**
 * toolchainwatch.ts — v14: WATCH the PICO toolchain update channel for the OS 6 drop.
 *
 * Research (2026-07-08) found the plugin's live update channel (a ByteDance TCC config endpoint,
 * extracted from the SpatialPlugin jar) with a STAGED 6.1.0 line: SDK 6.1.0, editor 6.1.0, and a
 * "swan_spaceos" 6.1.0 emulator — hosted NDA-internal, not yet public. This tool polls that channel
 * + public Maven and diffs against the installed toolchain, so the moment the 6.1.0 (or 0.13.6)
 * artifacts flip to a public CDN we know — the trigger to install + re-run swan_verify_matrix
 * (the Swan SpaceOS emulator may finally break the C4 immersive-compositing ceiling).
 */
const TCC_URL = "https://lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-pico.spatial-plugin.emulator-default";
const MAVEN_BOM = "https://artifact.bytedance.com/repository/Volcengine/com/pico/spatial/bom/maven-metadata.xml";

function installedVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const pkg = fs.readFileSync(path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/package.xml"), "utf8");
    out.emulator = pkg.match(/<revision>\s*<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/)?.slice(1, 4).join(".")
      ?? pkg.match(/rev(?:ision)?[^0-9]*([0-9.]+)/i)?.[1] ?? "0.13.x";
  } catch { out.emulator = "unknown"; }
  try {
    out.editor = fs.readFileSync(path.join(os.homedir(), "Library/PICO/sdk/0.13/editor/Spatial Editor.app/Contents/MacOS/version"), "utf8").match(/[\d.]+/)?.[0] ?? "unknown";
  } catch { out.editor = "unknown"; }
  out.sdkMaven = "0.13.3"; // the gradle dependency line our scaffolds pin
  return out;
}

export function registerToolchainWatchTools(server: McpServer) {
  server.registerTool(
    "check_toolchain_updates",
    {
      description:
        "Poll PICO's live toolchain UPDATE CHANNEL (the TCC config the Android Studio plugin reads — discovered 2026-07-08 with a STAGED 6.1.0 line: SDK 6.1.0 + editor 6.1.0 + a 'swan_spaceos' emulator) and public Maven, then diff against the installed toolchain. Reports: staged versions per (osVersion, package), whether each artifact URL is PUBLICLY downloadable yet (internal tosv.byted.org = NDA-only, lf-*.picoxr.com CDN = public), and the installed-vs-available delta. THE TRIGGER: when 6.1.0/0.13.6 flips public, install it and re-run swan_verify_matrix — the Swan SpaceOS emulator may break the C4 immersive ceiling. Read-only; no downloads.",
      inputSchema: {
        includeRaw: z.boolean().optional().describe("Include the raw channel package list (default false)."),
      },
    },
    async ({ includeRaw }) => {
      const installed = installedVersions();
      const result: any = { status: "ok", installed, channel: null, maven: null, publicNow: [], stagedInternal: [], verdict: "" };
      // 1. the update channel
      try {
        const res = await fetch(TCC_URL, { signal: AbortSignal.timeout(20_000) });
        const cfg: any = await res.json();
        // the config nests JSON-in-strings (sometimes multiple levels) — recursively unwrap so the
        // 6.1.0 package entries (which live inside stringified sub-configs) become scannable.
        const unwrap = (v: any, depth = 0): any => {
          if (depth > 6) return v;
          if (typeof v === "string") {
            const t = v.trim();
            if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
              try { return unwrap(JSON.parse(t), depth + 1); } catch { return v; }
            }
            return v;
          }
          if (Array.isArray(v)) return v.map((x) => unwrap(x, depth + 1));
          if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = unwrap(v[k], depth + 1); return o; }
          return v;
        };
        const text = JSON.stringify(unwrap(cfg));
        const pkgs: { key: string; rev: string; url: string; public: boolean }[] = [];
        const re = /"([\d.]+);(editor|emulator)[^"]*"\s*:\s*"?\{?[^{]*?"revision"\s*:\s*"([^"]+)"[\s\S]{0,400}?"url"\s*:\s*"([^"]+)"/g;
        // fallback: looser scan for zip URLs + revisions
        const zips = [...text.matchAll(/https?:\\?\/\\?\/[^"\\]+\.zip/g)].map((m) => m[0].replace(/\\\//g, "/"));
        const revs = [...text.matchAll(/"revision"\s*:\s*"([\d.]+)"/g)].map((m) => m[1]);
        const sdkMap = [...text.matchAll(/"osVersion"\s*:\s*"([\d.]+)"[^}]*?"spatialSDK"\s*:\s*"([\d.]+)"/g)].map((m) => ({ osVersion: m[1], spatialSDK: m[2] }));
        for (const z of zips) {
          const pub = !/tosv\.byted\.org|boei18n|internal/i.test(z);
          const entry = { url: z, public: pub, name: z.split("/").pop() ?? z };
          (pub ? result.publicNow : result.stagedInternal).push(entry);
        }
        result.channel = { fetched: true, sdkMap: sdkMap.length ? sdkMap : undefined, revisionsSeen: [...new Set(revs)].sort(), zipCount: zips.length };
        if (includeRaw) result.channel.raw = text.slice(0, 4000);
        void pkgs; void re;
      } catch (e: any) {
        result.channel = { fetched: false, error: String(e?.message ?? e).slice(0, 200) };
      }
      // 2. public Maven
      try {
        const res = await fetch(MAVEN_BOM, { signal: AbortSignal.timeout(20_000) });
        const xml = await res.text();
        result.maven = {
          latest: xml.match(/<latest>([^<]+)<\/latest>/)?.[1] ?? null,
          versions: [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]),
          lastUpdated: xml.match(/<lastUpdated>(\d+)<\/lastUpdated>/)?.[1] ?? null,
        };
      } catch (e: any) {
        result.maven = { error: String(e?.message ?? e).slice(0, 200) };
      }
      // 3. verdict — derive from the sdkMap + artifact names (not the schema-dependent revision scan)
      const sdk61 = (result.channel?.sdkMap ?? []).find((m: any) => m.osVersion?.startsWith("6"));
      const staged6 = result.stagedInternal.filter((p: any) => /swan_spaceos|_6\.\d/i.test(p.name));
      const mavenLatest = result.maven?.latest ?? "0.13.3";
      const public61 = result.publicNow.some((p: any) => /swan_spaceos|_6\.\d/i.test(p.name));
      result.verdict = public61
        ? "🚨 A 6.x/swan_spaceos artifact is PUBLICLY downloadable — install it and re-run swan_verify_matrix (potential C4 ceiling breaker)."
        : sdk61 || staged6.length
          ? `6.x IS STAGED but internal/NDA-only: sdkMap ${sdk61 ? `osVersion ${sdk61.osVersion} → SDK ${sdk61.spatialSDK}` : "n/a"}; ${staged6.length} swan/6.x artifact(s) on internal hosts (latest: ${staged6.slice(-1)[0]?.name ?? "?"}). Public Maven SDK: ${mavenLatest} (installed pin ${installed.sdkMaven}). Keep polling — the flip is the trigger.`
          : `No 6.x staged right now. Public Maven SDK: ${mavenLatest}; installed editor ${installed.editor}, emulator ${installed.emulator}.`;
      return okJson(result);
    },
  );
}
