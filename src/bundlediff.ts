import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, expandHome } from "./util.js";
import {
  isToolchainFailure,
  resolveOperationToolchain,
  toolchainProvenance,
  toolchainProvenanceLine,
  verifyOperationOverride,
  type OperationToolchain,
} from "./toolchain.js";

/**
 * bundle_content_diff — a DETERMINISTIC content-change signal for .bundle files. The bundle FILE is
 * non-deterministic (its md5 changes on every rebuild — embeds a timestamp), so md5 can't tell you
 * if the baked CONTENT changed. `spatialbundle info` lists the cooked models/assets/deps by
 * name/type/path (no timestamps) — diffing that fingerprint IS deterministic. Use it to verify an
 * edit actually changed the bake (vs editor_project_diff's editor-cache md5).
 */

/**
 * Both sides of the diff are inspected with the SAME binary from ONE selection — a fingerprint
 * compared across two different packers would report content changes that are really tool
 * changes. The hardcoded 0.13 fallback this replaces could differ from the packer that produced
 * either bundle.
 */
async function packerToolchain(): Promise<OperationToolchain | { error: string }> {
  const prepared = resolveOperationToolchain({ required: ["packer"], primary: "packer", allowBinaryOverride: true });
  if (isToolchainFailure(prepared)) return { error: `${prepared.code}: ${prepared.detail}` };
  const verified = await verifyOperationOverride(prepared);
  if (isToolchainFailure(verified)) return { error: `${verified.code}: ${verified.detail}` };
  return verified;
}

interface Info { exportVersion: string | null; modelCount: number | null; assetCount: number | null; fingerprint: string[]; raw: string; }

async function bundleInfo(sb: string, bundle: string): Promise<Info | { error: string }> {
  if (!fs.existsSync(bundle)) return { error: `bundle not found: ${bundle}` };
  const r = await run(sb, ["info", "-i", bundle], { timeoutMs: 30_000 });
  if (r.code !== 0 || !/Bundle Info|Model|Asset/.test(r.stdout)) return { error: `spatialbundle info failed (code ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}` };
  const out = r.stdout;
  const grab = (re: RegExp) => out.match(re)?.[1] ?? null;
  // Normalize per-build-volatile identifiers so identical CONTENT -> identical fingerprint:
  // the MaterialCache hash suffix and shadergraph GUIDs regenerate every build (not content-derived),
  // and Asset Name carries an absolute project path. Collapsing them leaves the semantic content
  // (model/material/asset NAMES, types, prim paths). NOTE: this therefore detects STRUCTURAL changes
  // (assets/models added/removed) — not value tweaks inside an existing asset (e.g. a color), which
  // the info output doesn't expose anyway.
  const norm = (l: string): string => {
    let s = l
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<guid>")
      .replace(/[0-9a-f]{32}/gi, "<hash>");
    const m = s.match(/^(Name:|Path:|Asset Name:|Asset Path:)\s*(\S.*)$/);
    if (m && m[2].includes("/")) s = `${m[1]} ${m[2].split("/").pop()}`;
    return s;
  };
  // fingerprint = sorted set of normalized content lines (names/types/paths), dropping separators.
  const fingerprint = Array.from(new Set(
    out.split("\n").map((l) => l.trim()).filter((l) =>
      l && !/^=+$/.test(l) && /^(Name:|Path:|Asset Name:|Asset Type:|Asset Path:|Asset ContentType:|Depends:)/.test(l),
    ).map(norm),
  )).sort();
  return {
    exportVersion: grab(/Bundle ExportVersion:\s*(\S+)/),
    modelCount: grab(/Model Count:\s*(\d+)/) ? parseInt(grab(/Model Count:\s*(\d+)/)!, 10) : null,
    assetCount: grab(/Asset Count:\s*(\d+)/) ? parseInt(grab(/Asset Count:\s*(\d+)/)!, 10) : null,
    fingerprint,
    raw: out,
  };
}

export function registerBundleDiffTools(server: McpServer) {
  server.registerTool(
    "bundle_content_diff",
    {
      description:
        "Deterministically diff the COOKED CONTENT of two .bundle files via `spatialbundle info` (cooked models/assets/deps by name/type/path — no timestamps). This is the reliable 'did the bake change' signal that bundle md5 can't give (the bundle file is non-deterministic). Returns added/removed content lines + model/asset counts + whether content is identical.",
      inputSchema: {
        bundleA: z.string().describe("Baseline .bundle path (~ expanded)."),
        bundleB: z.string().describe("Current .bundle path to compare."),
        maxLines: z.number().int().positive().optional().describe("Cap on reported added/removed lines (default 60)."),
      },
    },
    async ({ bundleA, bundleB, maxLines }) => {
      const ctx = await packerToolchain();
      if ("error" in ctx) return fail(`bundle_content_diff: ${ctx.error}`);
      const sb = ctx.bin;
      const a = await bundleInfo(sb, expandHome(bundleA));
      const b = await bundleInfo(sb, expandHome(bundleB));
      if ("error" in a) return fail(`bundleA: ${a.error}`);
      if ("error" in b) return fail(`bundleB: ${b.error}`);
      const setA = new Set(a.fingerprint), setB = new Set(b.fingerprint);
      const cap = maxLines ?? 60;
      const added = b.fingerprint.filter((l) => !setA.has(l));
      const removed = a.fingerprint.filter((l) => !setB.has(l));
      return okJson({
        contentIdentical: added.length === 0 && removed.length === 0,
        counts: {
          models: { a: a.modelCount, b: b.modelCount },
          assets: { a: a.assetCount, b: b.assetCount },
          fingerprintLines: { a: a.fingerprint.length, b: b.fingerprint.length },
        },
        exportVersion: { a: a.exportVersion, b: b.exportVersion },
        ...toolchainProvenance(ctx),
        inspectedWith: toolchainProvenanceLine(ctx),
        added: added.slice(0, cap),
        removed: removed.slice(0, cap),
        ...(added.length > cap || removed.length > cap ? { truncated: { added: added.length, removed: removed.length } } : {}),
        note: "Deterministic fingerprint from `spatialbundle info` with per-build ids (MaterialCache hash, shadergraph GUIDs, abs paths) normalized out. Detects STRUCTURAL changes (models/assets added/removed) — NOT value tweaks inside an existing asset (the info output doesn't expose those). The bundle FILE md5 is NOT a content signal (non-deterministic build).",
      });
    },
  );
}
