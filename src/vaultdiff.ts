import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, okJson } from "./util.js";
import { loadVaultIndex, vaultRootForVersion, vaultSdkBase, type VaultIndex, type VaultType } from "./vault.js";
import { parsePackageRevision, readDeclarationIdentity } from "./declarationcontext.js";

/**
 * vaultdiff.ts — v26 THE MULTI-VERSION VAULT: workspaces + drift reports + migration hints.
 *
 * The CLI's separately provisioned utility payload materializes one agent-vault per SDK version
 * under ~/Library/PICO/sdk/<v>/. This module enumerates those workspaces and DIFFS two vault indexes — types added/removed,
 * members added/removed, constructor-arity changes, kind changes, enum-entry drift — and turns
 * each breaking change into a concrete migration hint. When 0.14/6.1 vaults land, `vault_diff
 * from:0.13 to:0.14` is the instant upgrade brief for spatial-sdk-update work.
 *
 * HONESTY: a drift report only speaks for what BOTH vaults declare. Only 0.13 is materialized
 * locally today — the diff engine is proven against a fixture drift pair in CI, clearly labeled
 * as fixtures, never presented as real SDK data.
 *
 * Task S5: workspace enumeration, the default root and explicit-version resolution all derive
 * from the one selected tools root (vault.ts `vaultSdkBase`). A workspace's `version` is the
 * DIRECTORY LABEL; its `packageRevision` is what package.xml declares — separate facts, reported
 * separately. A version argument is bounded to a numeric token; an explicit root is an explicitly
 * identified SOURCE; and a drift report between two declaration sets is never evidence that either
 * set is compatible with any project's target SDK.
 */

export interface VaultWorkspace {
  /** The directory label under the tools root — NOT a declared revision. */
  version: string;
  root: string;
  mdFiles: number;
  /** What `<root>/package.xml` declares, or null when it declares nothing readable. */
  packageRevision: string | null;
}

const MANAGED_SETUP_GUIDANCE = "Call ensure_pico_cli, then manually run its returned absolute path with args [\"setup\"]; the MCP never runs setup.";

export function vaultWorkspaceNote(workspaces: readonly VaultWorkspace[]): string {
  if (workspaces.length === 0) {
    return `no vault is materialized locally — vault_diff needs two; the diff engine is CI-proven against a labeled fixture pair. ${MANAGED_SETUP_GUIDANCE}`;
  }
  if (workspaces.length === 1) {
    return `only one vault is materialized locally — vault_diff needs two; the diff engine is CI-proven against a labeled fixture pair. ${MANAGED_SETUP_GUIDANCE}`;
  }
  return "diff any pair with vault_diff {from, to}.";
}

function declaredRevision(root: string): string | null {
  try {
    return parsePackageRevision(fs.readFileSync(path.join(root, "package.xml"), "utf8"));
  } catch {
    return null;
  }
}

export function listVaultWorkspaces(sdkBase?: string): VaultWorkspace[] {
  const base = sdkBase ?? vaultSdkBase();
  const out: VaultWorkspace[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return out;
  }
  for (const v of entries.sort()) {
    const root = path.join(base, v, "agent-vault");
    if (!fs.existsSync(path.join(root, "knowledge", "api-reference"))) continue;
    let mdFiles = 0;
    try {
      const walk = (d: string) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          if (f.isDirectory()) walk(path.join(d, f.name));
          else if (f.name.endsWith(".md")) mdFiles++;
        }
      };
      walk(path.join(root, "knowledge", "api-reference"));
    } catch { /* count stays partial */ }
    out.push({ version: v, root, mdFiles, packageRevision: declaredRevision(root) });
  }
  return out;
}

const fnNames = (t: VaultType) => new Set(t.functions.map((f) => f.name));
const propNames = (t: VaultType) => new Set(t.properties.map((p) => p.name));
const arities = (t: VaultType) => {
  const s = new Set<number>();
  for (const c of t.constructors) for (let n = c.minArity; n <= c.maxArity; n++) s.add(n);
  return s;
};
const setDiff = <T>(a: Set<T>, b: Set<T>) => [...a].filter((x) => !b.has(x));

export interface VaultDrift {
  typesAdded: string[];
  typesRemoved: string[];
  typesChanged: {
    type: string;
    kindChanged?: { from: string; to: string };
    membersAdded: string[];
    membersRemoved: string[];
    ctorAritiesAdded: number[];
    ctorAritiesRemoved: number[];
    enumEntriesAdded: string[];
    enumEntriesRemoved: string[];
  }[];
  migrationHints: string[];
  fromTypes: number;
  toTypes: number;
}

export function diffVaultIndexes(from: VaultIndex, to: VaultIndex): VaultDrift {
  const flat = (idx: VaultIndex) => {
    const m = new Map<string, VaultType>();
    for (const [pkg, types] of idx.packages) for (const [name, t] of types) m.set(`${pkg}.${name}`, t);
    return m;
  };
  const a = flat(from);
  const b = flat(to);
  const typesAdded = [...b.keys()].filter((k) => !a.has(k)).sort();
  const typesRemoved = [...a.keys()].filter((k) => !b.has(k)).sort();
  const typesChanged: VaultDrift["typesChanged"] = [];
  const hints: string[] = [];

  for (const t of typesRemoved) hints.push(`${t} no longer exists in ${to.sdkVersion ?? "the target vault"} — code referencing it must migrate (check ${to.sdkVersion ?? "target"} release notes for the replacement).`);

  for (const [fqn, ta] of a) {
    const tb = b.get(fqn);
    if (!tb) continue;
    const fa = fnNames(ta), fb = fnNames(tb);
    const pa = propNames(ta), pb = propNames(tb);
    const membersAdded = [...setDiff(fb, fa).map((n) => `${n}()`), ...setDiff(pb, pa)].sort();
    const membersRemoved = [...setDiff(fa, fb).map((n) => `${n}()`), ...setDiff(pa, pb)].sort();
    const ca = arities(ta), cb = arities(tb);
    const ctorAritiesAdded = setDiff(cb, ca).sort((x, y) => x - y);
    const ctorAritiesRemoved = setDiff(ca, cb).sort((x, y) => x - y);
    const ea = new Set(ta.enumEntries ?? []), eb = new Set(tb.enumEntries ?? []);
    const enumEntriesAdded = setDiff(eb, ea).sort();
    const enumEntriesRemoved = setDiff(ea, eb).sort();
    const kindChanged = ta.kind !== tb.kind ? { from: ta.kind, to: tb.kind } : undefined;
    if (membersAdded.length || membersRemoved.length || ctorAritiesAdded.length || ctorAritiesRemoved.length || enumEntriesAdded.length || enumEntriesRemoved.length || kindChanged) {
      typesChanged.push({ type: fqn, kindChanged, membersAdded, membersRemoved, ctorAritiesAdded, ctorAritiesRemoved, enumEntriesAdded, enumEntriesRemoved });
      for (const m of membersRemoved) {
        const rename = membersAdded.length === 1 && membersRemoved.length === 1 ? ` (likely renamed to ${membersAdded[0]})` : "";
        hints.push(`${fqn}.${m} was removed${rename} — call sites must change.`);
      }
      for (const n of ctorAritiesRemoved) hints.push(`${fqn} no longer has a ${n}-arg constructor (now: ${[...cb].sort((x, y) => x - y).join("/") || "none"}) — update construction sites.`);
      for (const e of enumEntriesRemoved) hints.push(`${fqn}.${e} enum entry was removed — exhaustive whens and mappings must drop it.`);
      if (kindChanged) hints.push(`${fqn} changed kind ${kindChanged.from} -> ${kindChanged.to} — instantiation/inheritance patterns may break.`);
    }
  }
  return { typesAdded, typesRemoved, typesChanged, migrationHints: hints, fromTypes: a.size, toTypes: b.size };
}

export type VaultDiffRoot = { status: "ok"; root: string; source: "explicit" | "version" } | { status: "error"; error: string };

/**
 * A spec with a path separator is an explicit vault root (an explicitly identified source);
 * anything else must be a NUMERIC version label under the selected tools root. `..`, labels with
 * separators smuggled in, or free text are refused rather than joined into a path.
 */
export function resolveVaultDiffRoot(spec: string): VaultDiffRoot {
  if (spec.includes("/") || spec.includes(path.sep)) {
    // An explicit root must stand on its own: a relative spec would resolve against whatever the
    // server's working directory happens to be, which is a location nobody named.
    const expanded = expandHome(spec);
    if (!path.isAbsolute(expanded)) {
      return { status: "error", error: `${JSON.stringify(spec)} is neither a numeric SDK version label (0.13, 6.1.0) under ${vaultSdkBase()} nor an absolute agent-vault root path (relative roots are not resolved)` };
    }
    return { status: "ok", root: path.resolve(expanded), source: "explicit" };
  }
  // Not trimmed: whitespace is a rejected character in a version label (the toolchain resolver's rule), never something to tidy away.
  const root = vaultRootForVersion(spec);
  if (!root) {
    return { status: "error", error: `${JSON.stringify(spec)} is neither a numeric SDK version label (0.13, 6.1.0) under ${vaultSdkBase()} nor an absolute agent-vault root path` };
  }
  return { status: "ok", root, source: "version" };
}

/** The identity summary a drift endpoint reports per side: what the bytes declare, labeled historical. */
function identitySummary(root: string) {
  const read = readDeclarationIdentity(root);
  return read.status === "ok"
    ? { status: "ok" as const, packageRevision: read.identity.packageRevision, authority: read.identity.authority, fingerprint: read.identity.fingerprint, sourceCount: read.identity.sources.length }
    : { status: "unavailable" as const, code: read.code, detail: read.detail };
}

export function registerVaultDiffTools(server: McpServer) {
  server.tool(
    "vault_workspaces",
    "v26: list the agent-vault WORKSPACES materialized on this machine (~/Library/PICO/sdk/<version>/agent-vault) — one per SDK version supplied by the CLI's separately provisioned utility payload. Feed two versions to vault_diff for a drift report; pass a version to vault_api to query that SDK's declarations.",
    {},
    async () => {
      const ws = listVaultWorkspaces();
      return okJson({
        status: "ok",
        base: vaultSdkBase(),
        workspaces: ws,
        note: vaultWorkspaceNote(ws),
        authority: "historical",
        authorityNote: "`version` is the directory label under the tools root; `packageRevision` is what each workspace's package.xml declares. Neither is evidence about any project's target SDK.",
      });
    },
  );

  server.tool(
    "vault_diff",
    "v26 DRIFT REPORT: diff two agent-vault indexes (SDK versions or explicit vault roots) — types added/removed, members added/removed, constructor-arity changes, enum-entry drift, kind changes — each breaking change paired with a concrete MIGRATION HINT (the instant upgrade brief for spatial-sdk-update work). HONESTY: speaks only for what both vaults declare; renames are flagged as 'likely' only when exactly one member was removed and one added.",
    {
      from: z.string().describe("Source SDK version ('0.13') or an explicit agent-vault root path."),
      to: z.string().describe("Target SDK version or vault root."),
      maxHints: z.number().int().min(1).max(200).default(60),
    },
    async ({ from, to, maxHints }) => {
      const fromSel = resolveVaultDiffRoot(from);
      if (fromSel.status !== "ok") return okJson({ status: "error", error: `from: ${fromSel.error}` });
      const toSel = resolveVaultDiffRoot(to);
      if (toSel.status !== "ok") return okJson({ status: "error", error: `to: ${toSel.error}` });
      const fromRoot = fromSel.root;
      const toRoot = toSel.root;
      const a = loadVaultIndex(fromRoot);
      if (!a) return okJson({ status: "error", error: `no loadable vault at ${fromRoot} — see vault_workspaces for what's materialized.` });
      const b = loadVaultIndex(toRoot);
      if (!b) return okJson({ status: "error", error: `no loadable vault at ${toRoot} — see vault_workspaces for what's materialized.` });
      const d = diffVaultIndexes(a, b);
      return okJson({
        status: "ok",
        authority: "historical",
        authorityNote: "A drift report compares what two declaration sets declare. It is not evidence that either set is compatible with any project's target SDK; that requires a reviewed compatibility record (vault_api with projectRoot).",
        from: { root: fromRoot, source: fromSel.source, sdkVersion: a.sdkVersion, types: d.fromTypes, identity: identitySummary(fromRoot) },
        to: { root: toRoot, source: toSel.source, sdkVersion: b.sdkVersion, types: d.toTypes, identity: identitySummary(toRoot) },
        summary: { typesAdded: d.typesAdded.length, typesRemoved: d.typesRemoved.length, typesChanged: d.typesChanged.length, hints: d.migrationHints.length },
        typesAdded: d.typesAdded.slice(0, 100),
        typesRemoved: d.typesRemoved.slice(0, 100),
        typesChanged: d.typesChanged.slice(0, 100),
        migrationHints: d.migrationHints.slice(0, maxHints),
      });
    },
  );
}
