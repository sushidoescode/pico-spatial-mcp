import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "node:path";
import { okJson } from "./util.js";
import { hostToolchainIO, isToolchainFailure } from "./toolchain.js";
import { resolveToolchain } from "./toolchainselection.js";
import type { RootSource, ToolchainIO, ToolComponent } from "./toolchainselection.js";

/**
 * toolchainwatch.ts — check whether the installed PICO toolchain is current.
 *
 * Polls the toolchain update channel the PICO Android Studio plugin reads, plus the public Maven
 * metadata, and diffs both against what is installed locally. Reports which advertised artifacts
 * are publicly downloadable and which are not, so an upgrade can be taken as soon as one is
 * available. Read-only: it fetches metadata and downloads nothing.
 *
 * WHICH install is "installed": the emulator and editor components of the SELECTED PICO toolchain,
 * resolved through the same component-valid selection every other operation runs, so $PICO_HOME, a
 * project's `spatial.tools.dir` and an explicit version pin all apply. Until the 38.0.0 fix wave
 * this module read `~/Library/PICO/sdk/0.13/emulator/package.xml` and the 0.13 editor's `version`
 * file from module-scope literals — so on a host carrying 0.13 beside 6.1 it reported the LEGACY
 * payload as installed, and the verdict below advertised an upgrade the host already had.
 *
 * The two components are selected SEPARATELY, and their answers are disclosed separately. A
 * selection is filtered by the components it is asked for, so a host that upgraded its emulator to
 * 6.1 and left its editor on 0.13 — two separately downloaded payloads, an ordinary state —
 * legitimately resolves two different installations. One shared `selection` field would then name
 * the wrong origin for one of the two versions it claims to account for.
 */
const TCC_URL = "https://lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-pico.spatial-plugin.emulator-default";
const MAVEN_BOM = "https://artifact.bytedance.com/repository/Volcengine/com/pico/spatial/bom/maven-metadata.xml";

/** Where ONE component's version was read from, or the selection layer's own structured refusal. */
export type ComponentSelection = { version: string; rootSource: RootSource } | { unavailable: string };

export interface InstalledToolchainVersions {
  /** The selected emulator installation's declared revision, or "unknown" when none declares one. */
  emulator: string;
  /** The selected editor installation's version, or "unknown" (the editor is macOS-only). */
  editor: string;
  /** The Gradle dependency line our scaffolds pin — an app-side fact, not an installed payload. */
  sdkMaven: string;
  /** Per component: the installation THAT component's version above was read from, or why none. */
  selection: { emulator: ComponentSelection; editor: ComponentSelection };
}

/**
 * One component's declared version and the installation it came from, read through `io`.
 *
 * Never throws and never guesses: a component that cannot be selected reports the selection layer's
 * own structured code, and a selected installation whose metadata file is absent or unparsable
 * reports "unknown" against the selection that was made.
 */
function installedComponent(
  io: ToolchainIO,
  component: ToolComponent,
  fileName: string,
  parse: (text: string) => string | null,
): { version: string; selection: ComponentSelection } {
  const selected = resolveToolchain({ required: [component] }, io);
  if (isToolchainFailure(selected)) return { version: "unknown", selection: { unavailable: selected.code } };

  const where: ComponentSelection = { version: selected.version, rootSource: selected.rootSource };
  // The component is in `required`, so a selection that succeeded carries it; `files` is a partial
  // record, and an absent entry is reported as an unknown version against a real selection rather
  // than as a selection failure that did not happen.
  const bin = selected.files[component]?.path;
  if (!bin) return { version: "unknown", selection: where };

  const P = io.platform === "win32" ? path.win32 : path.posix;
  const bytes = io.read(P.join(P.dirname(bin), fileName));
  if (!bytes) return { version: "unknown", selection: where };
  return { version: parse(bytes.toString("utf8")) ?? "unknown", selection: where };
}

/** What is installed, per component, read from each component's own selected installation. */
export function installedVersions(io: ToolchainIO = hostToolchainIO()): InstalledToolchainVersions {
  const emulator = installedComponent(io, "emulator", "package.xml", (xml) =>
    xml.match(/<revision>\s*<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/)?.slice(1, 4).join(".")
    ?? xml.match(/rev(?:ision)?[^0-9]*([0-9.]+)/i)?.[1] ?? null);
  const editor = installedComponent(io, "editor", "version", (text) => text.match(/[\d.]+/)?.[0] ?? null);

  return {
    emulator: emulator.version,
    editor: editor.version,
    sdkMaven: "6.0.0", // the gradle dependency line our scaffolds pin
    selection: { emulator: emulator.selection, editor: editor.selection },
  };
}

/** Numeric dotted-version comparison; a missing component counts as zero ("6.1" == "6.1.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().split(".").map((n) => Number(n) || 0);
  const pb = b.trim().split(".").map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The three-part dotted version an artifact name carries, or null. A date (`20260910`) is not a
 * version, `v.12.3` is not three parts, and nothing is guessed from a bare build number.
 */
export function parseArtifactVersion(name: string): string | null {
  const match = /(?:^|[_-])v?(\d+\.\d+\.\d+)(?=[_.-]|$)/.exec(name);
  return match ? match[1] : null;
}

export type ArtifactComparison = {
  name: string;
  source: "public" | "internal";
  component: "editor" | "emulator" | "other";
  version: string | null;
  installed: string | null;
  relation: "newer-than-installed" | "same-as-installed" | "older-than-installed" | "uncomparable";
};

export type ToolchainUpdateVerdict = {
  verdict: string;
  /** true: a public payload is newer than its installed component; false: none is; null: a 6.x-looking public payload could not be compared. */
  publicUpgradeAvailable: boolean | null;
  comparisons: ArtifactComparison[];
  /** Channel lines (osVersion/spatialSDK) above the installed major.minor line. */
  advertisedLines: Array<{ osVersion: string; spatialSDK: string }>;
};

/** The 38.0.0 heuristic for "this artifact belongs to the 6.x runtime line", kept only to decide what is worth comparing. */
const SIX_X_ARTIFACT = /swan_spaceos|(?:^|[_-])v?6\.\d/i;

/**
 * The verdict, derived by COMPARING each advertised editor/emulator payload's version with the
 * installed component it would replace. Until the 2026-09-16 native-acceptance pass the tool called
 * any 6.x-looking public artifact "a newer 6.x runtime" — on a host already on 6.1 with only 6.0.0
 * public payloads that advertised an upgrade the host was already past. Pure: no I/O.
 */
export function toolchainUpdateVerdict(input: {
  installed: Pick<InstalledToolchainVersions, "emulator" | "editor" | "sdkMaven">;
  publicNow: Array<{ name: string }>;
  stagedInternal: Array<{ name: string }>;
  sdkMap: Array<{ osVersion: string; spatialSDK: string }>;
  mavenLatest: string | null;
}): ToolchainUpdateVerdict {
  const { installed, publicNow, stagedInternal, sdkMap, mavenLatest } = input;
  const known = (version: string | undefined): string | null => (version && /^\d+(?:\.\d+)*$/.test(version.trim()) ? version.trim() : null);
  const componentOf = (name: string): ArtifactComparison["component"] =>
    /editor/i.test(name) ? "editor" : /emulator/i.test(name) ? "emulator" : "other";
  const installedFor = (component: ArtifactComparison["component"]): string | null =>
    component === "editor" ? known(installed.editor) : component === "emulator" ? known(installed.emulator) : null;
  const compare = (name: string, source: ArtifactComparison["source"]): ArtifactComparison => {
    const component = componentOf(name);
    const version = parseArtifactVersion(name);
    const installedVersion = installedFor(component);
    let relation: ArtifactComparison["relation"] = "uncomparable";
    if (component !== "other" && version !== null && installedVersion !== null) {
      const d = compareVersions(version, installedVersion);
      relation = d > 0 ? "newer-than-installed" : d < 0 ? "older-than-installed" : "same-as-installed";
    }
    return { name, source, component, version, installed: installedVersion, relation };
  };
  const comparisons = [
    ...publicNow.map((p) => compare(p.name, "public")),
    ...stagedInternal.map((p) => compare(p.name, "internal")),
  ];
  const publicRuntime = comparisons.filter((c) => c.source === "public" && c.component !== "other");
  const newerPublic = publicRuntime.filter((c) => c.relation === "newer-than-installed");
  const uncomparablePublic = publicRuntime.filter((c) => c.relation === "uncomparable" && SIX_X_ARTIFACT.test(c.name));
  const newerInternal = comparisons.filter((c) => c.source === "internal" && c.component !== "other" && c.relation === "newer-than-installed");
  const installedTop = [known(installed.editor), known(installed.emulator)].filter((v): v is string => v !== null).sort(compareVersions).pop() ?? null;
  const installedLine = installedTop ? installedTop.split(".").slice(0, 2).join(".") : null;
  const advertisedLines = sdkMap.filter((line) =>
    installedLine !== null && /^\d+\.\d+/.test(line.osVersion) && compareVersions(line.osVersion, installedLine) > 0);

  const installedText = `installed editor ${installed.editor}, emulator ${installed.emulator}`;
  const maven = `Public Maven SDK: ${mavenLatest ?? "unknown"} (scaffold pin ${installed.sdkMaven}).`;
  let verdict: string;
  let publicUpgradeAvailable: boolean | null;
  if (newerPublic.length) {
    publicUpgradeAvailable = true;
    verdict = `A newer PICO toolchain payload is publicly downloadable: ${newerPublic.map((c) => `${c.component} ${c.version} (installed ${c.installed})`).join(", ")} — install it, then re-run your verification matrix against it. ${maven}`;
  } else if (uncomparablePublic.length) {
    publicUpgradeAvailable = null;
    verdict = `A publicly downloadable payload looks like a 6.x runtime but its version could not be compared with the installed toolchain (${uncomparablePublic.map((c) => c.name).join(", ")}; ${installedText}). Inspect it before installing anything. ${maven}`;
  } else {
    publicUpgradeAvailable = false;
    const publicSix = publicRuntime.filter((c) => c.version !== null && SIX_X_ARTIFACT.test(c.name));
    const internalNote = advertisedLines.length || newerInternal.length
      ? ` The channel also advertises ${advertisedLines.length ? `the ${advertisedLines.map((l) => `${l.osVersion} line (spatialSDK ${l.spatialSDK})`).join(" and ")}` : "a newer payload"}${newerInternal.length ? ` with internal-only artifacts (${newerInternal.map((c) => `${c.name} = ${c.component} ${c.version}`).join(", ")})` : ""}, newer than the installed line but not downloadable from here.`
      : "";
    if (publicSix.length) {
      verdict = `Publicly downloadable 6.x payloads (${publicSix.map((c) => `${c.component} ${c.version}`).join(", ")}) are not newer than the installed toolchain (editor ${installed.editor}, emulator ${installed.emulator}); nothing public to install.${internalNote} ${maven}`;
    } else if (internalNote) {
      verdict = `Nothing newer is publicly downloadable (${installedText}).${internalNote} ${maven}`;
    } else {
      verdict = `Nothing newer advertised. ${maven.replace(/\.$/, "")}; ${installedText}.`;
    }
  }
  return { verdict, publicUpgradeAvailable, comparisons, advertisedLines };
}

export function registerToolchainWatchTools(server: McpServer) {
  server.registerTool(
    "check_toolchain_updates",
    {
      description:
        "Check whether your installed PICO toolchain is current. Polls the update channel the PICO Android Studio plugin reads plus public Maven metadata, then diffs both against your local install. Reports the advertised versions per (osVersion, package), which artifacts are publicly downloadable, and the installed-vs-available delta as explicit per-artifact comparisons (`comparisons`, `publicUpgradeAvailable`, `advertisedLines`) — a payload is called newer only when its parsed version is above the installed component it would replace. 'installed' is the emulator and editor of the SELECTED toolchain ($PICO_HOME / spatial.tools.dir / the newest usable version), never a hardcoded location. Each component is selected on its own, so `installed.selection.emulator` and `installed.selection.editor` each disclose the installation THAT version was read from (or the structured unavailable/* reason none could be) — on a host that upgraded one payload and not the other they legitimately differ. Read-only: fetches metadata, downloads nothing.",
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
      // 3. verdict — every advertised editor/emulator payload is COMPARED with the installed
      // component before anything is called newer; the comparisons are returned beside the prose.
      const outcome = toolchainUpdateVerdict({
        installed,
        publicNow: result.publicNow,
        stagedInternal: result.stagedInternal,
        sdkMap: result.channel?.sdkMap ?? [],
        mavenLatest: result.maven?.latest ?? null,
      });
      result.verdict = outcome.verdict;
      result.publicUpgradeAvailable = outcome.publicUpgradeAvailable;
      result.comparisons = outcome.comparisons;
      result.advertisedLines = outcome.advertisedLines;
      return okJson(result);
    },
  );
}
