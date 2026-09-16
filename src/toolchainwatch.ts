import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "node:path";
import { okJson } from "./util.js";
import { hostToolchainIO, isToolchainFailure, resolveOperationToolchain } from "./toolchain.js";
import type { RootSource, ToolchainIO, UnusableToolchain } from "./toolchainselection.js";

/**
 * toolchainwatch.ts — check whether the installed PICO toolchain is current.
 *
 * Polls the toolchain update channel the PICO Android Studio plugin reads, plus the public Maven
 * metadata, and diffs both against what is installed locally. Reports which advertised artifacts
 * are publicly downloadable and which are not, so an upgrade can be taken as soon as one is
 * available. Read-only: it fetches metadata and downloads nothing.
 *
 * WHICH install is "installed": the emulator and editor components of the SELECTED PICO toolchain,
 * resolved through the same per-call selection every other operation runs, so $PICO_HOME, a
 * project's `spatial.tools.dir` and an explicit version pin all apply. Until the 38.0.0 fix wave
 * this module read `~/Library/PICO/sdk/0.13/emulator/package.xml` and the 0.13 editor's `version`
 * file from module-scope literals — so on a host carrying 0.13 beside 6.1 it reported the LEGACY
 * payload as installed, and the verdict below advertised an upgrade the host already had.
 */
const TCC_URL = "https://lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-pico.spatial-plugin.emulator-default";
const MAVEN_BOM = "https://artifact.bytedance.com/repository/Volcengine/com/pico/spatial/bom/maven-metadata.xml";

export interface InstalledToolchainVersions {
  /** The selected installation's emulator revision, or "unknown" when nothing declares one. */
  emulator: string;
  /** The selected installation's Spatial Editor version, or "unknown" (macOS-only component). */
  editor: string;
  /** The Gradle dependency line our scaffolds pin — an app-side fact, not an installed payload. */
  sdkMaven: string;
  /** Where the two versions above were read from, or the selection layer's own refusal. */
  selection: { version: string; rootSource: RootSource } | { unavailable: string };
}

/** The declared version of a component of the SELECTED installation, never a guessed one. */
function readInstalledVersion(io: ToolchainIO, bin: string, fileName: string, parse: (text: string) => string | null): string {
  const P = io.platform === "win32" ? path.win32 : path.posix;
  const bytes = io.read(P.join(P.dirname(bin), fileName));
  if (!bytes) return "unknown";
  return parse(bytes.toString("utf8")) ?? "unknown";
}

/**
 * What is installed, read from the selected installation through `io`. Never throws: a component
 * that cannot be selected, or whose metadata file is absent, is "unknown" rather than a guess.
 */
export function installedVersions(io: ToolchainIO = hostToolchainIO()): InstalledToolchainVersions {
  const emulator = resolveOperationToolchain({ required: ["emulator"], primary: "emulator" }, io);
  const editor = resolveOperationToolchain({ required: ["editor"], primary: "editor" }, io);

  const out: InstalledToolchainVersions = {
    emulator: isToolchainFailure(emulator) ? "unknown" : readInstalledVersion(io, emulator.bin, "package.xml", (xml) =>
      xml.match(/<revision>\s*<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/)?.slice(1, 4).join(".")
      ?? xml.match(/rev(?:ision)?[^0-9]*([0-9.]+)/i)?.[1] ?? null),
    editor: isToolchainFailure(editor) ? "unknown" : readInstalledVersion(io, editor.bin, "version", (text) => text.match(/[\d.]+/)?.[0] ?? null),
    sdkMaven: "6.0.0", // the gradle dependency line our scaffolds pin
    selection: { unavailable: "unavailable/not-resolved" },
  };

  // The emulator is the cross-platform component, so it names the selection when it resolved; the
  // editor answers for it on a host that carries one and no emulator. When neither does, the
  // selection layer's own structured code is reported instead of an invented location.
  const named = !isToolchainFailure(emulator) ? emulator : !isToolchainFailure(editor) ? editor : null;
  if (named?.selection) out.selection = { version: named.selection.version, rootSource: named.selection.rootSource };
  else out.selection = { unavailable: ((isToolchainFailure(emulator) ? emulator : editor) as UnusableToolchain).code };
  return out;
}

export function registerToolchainWatchTools(server: McpServer) {
  server.registerTool(
    "check_toolchain_updates",
    {
      description:
        "Check whether your installed PICO toolchain is current. Polls the update channel the PICO Android Studio plugin reads plus public Maven metadata, then diffs both against your local install. Reports the advertised versions per (osVersion, package), which artifacts are publicly downloadable, and the installed-vs-available delta — so you can take an upgrade as soon as one is available to you. 'installed' is the emulator and editor of the SELECTED toolchain ($PICO_HOME / spatial.tools.dir / the newest usable version), never a hardcoded location, and `installed.selection` discloses which installation was read (or the structured unavailable/* reason none could be). Read-only: fetches metadata, downloads nothing.",
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
        const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
        // <latest> lags <release> in this repository — it read 0.12.2 while <release> was 0.13.3,
        // which made the verdict advertise a version OLDER than the installed pin. Prefer <release>,
        // then the highest published version, and only then <latest>.
        const byVersion = (a: string, b: string) =>
          a.split(".").map(Number).reduce((acc, n, i) => acc || n - (Number(b.split(".")[i]) || 0), 0);
        const release = xml.match(/<release>([^<]+)<\/release>/)?.[1] ?? null;
        const highest = versions.length ? [...versions].sort(byVersion).pop()! : null;
        result.maven = {
          latest: release ?? highest ?? xml.match(/<latest>([^<]+)<\/latest>/)?.[1] ?? null,
          release,
          versions,
          lastUpdated: xml.match(/<lastUpdated>(\d+)<\/lastUpdated>/)?.[1] ?? null,
        };
      } catch (e: any) {
        result.maven = { error: String(e?.message ?? e).slice(0, 200) };
      }
      // 3. verdict — derive from the sdkMap + artifact names (not the schema-dependent revision scan)
      const sdk61 = (result.channel?.sdkMap ?? []).find((m: any) => m.osVersion?.startsWith("6"));
      const staged6 = result.stagedInternal.filter((p: any) => /swan_spaceos|_6\.\d/i.test(p.name));
      const mavenLatest = result.maven?.latest ?? "6.0.0";
      const public61 = result.publicNow.some((p: any) => /swan_spaceos|_6\.\d/i.test(p.name));
      result.verdict = public61
        ? `A newer 6.x runtime is publicly downloadable — install it, then re-run your verification matrix against it.`
        : sdk61 || staged6.length
          ? `A newer 6.x line is advertised on the channel but is not publicly downloadable from here, so there is nothing to install yet. Public Maven SDK: ${mavenLatest} (installed pin ${installed.sdkMaven}). Re-run this check periodically.`
          : `Nothing newer advertised. Public Maven SDK: ${mavenLatest}; installed editor ${installed.editor}, emulator ${installed.emulator}.`;
      return okJson(result);
    },
  );
}
