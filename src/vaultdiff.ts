import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { loadVaultIndex, type VaultIndex, type VaultType } from "./vault.js";

/**
 * vaultdiff.ts — v26 THE MULTI-VERSION VAULT: workspaces + drift reports + migration hints.
 *
 * `pico-cli setup` materializes one agent-vault per SDK version under ~/Library/PICO/sdk/<v>/.
 * This module enumerates those workspaces and DIFFS two vault indexes — types added/removed,
 * members added/removed, constructor-arity changes, kind changes, enum-entry drift — and turns
 * each breaking change into a concrete migration hint. When 0.14/6.1 vaults land, `vault_diff
 * from:0.13 to:0.14` is the instant upgrade brief for spatial-sdk-update work.
 *
 * HONESTY: a drift report only speaks for what BOTH vaults declare. Only 0.13 is materialized
 * locally today — the diff engine is proven against a fixture drift pair in CI, clearly labeled
 * as fixtures, never presented as real SDK data.
 */

export interface VaultWorkspace { version: string; root: string; mdFiles: number }

export function listVaultWorkspaces(sdkBase?: string): VaultWorkspace[] {
  const base = sdkBase ?? path.join(os.homedir(), "Library", "PICO", "sdk");
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
    out.push({ version: v, root, mdFiles });
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

function resolveRoot(spec: string): string {
  // a version like "0.13" resolves under the SDK base; anything with a path separator is a root
  if (spec.includes("/") || spec.includes(path.sep)) return spec.replace(/^~\//, `${os.homedir()}/`);
  return path.join(os.homedir(), "Library", "PICO", "sdk", spec, "agent-vault");
}

export function registerVaultDiffTools(server: McpServer) {
  server.tool(
    "vault_workspaces",
    "v26: list the agent-vault WORKSPACES materialized on this machine (~/Library/PICO/sdk/<version>/agent-vault) — one per SDK version that `pico-cli setup` has installed. Feed two versions to vault_diff for a drift report; pass a version to vault_api to query that SDK's declarations.",
    {},
    async () => {
      const ws = listVaultWorkspaces();
      return okJson({
        status: "ok",
        workspaces: ws,
        note: ws.length <= 1 ? "only one vault is materialized locally — vault_diff needs two (a second appears when pico-cli setup installs the next SDK; the diff engine is CI-proven against a labeled fixture pair)." : `diff any pair with vault_diff {from, to}.`,
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
      const fromRoot = resolveRoot(from);
      const toRoot = resolveRoot(to);
      const a = loadVaultIndex(fromRoot);
      if (!a) return okJson({ status: "error", error: `no loadable vault at ${fromRoot} — see vault_workspaces for what's materialized.` });
      const b = loadVaultIndex(toRoot);
      if (!b) return okJson({ status: "error", error: `no loadable vault at ${toRoot} — see vault_workspaces for what's materialized.` });
      const d = diffVaultIndexes(a, b);
      return okJson({
        status: "ok",
        from: { root: fromRoot, sdkVersion: a.sdkVersion, types: d.fromTypes },
        to: { root: toRoot, sdkVersion: b.sdkVersion, types: d.toTypes },
        summary: { typesAdded: d.typesAdded.length, typesRemoved: d.typesRemoved.length, typesChanged: d.typesChanged.length, hints: d.migrationHints.length },
        typesAdded: d.typesAdded.slice(0, 100),
        typesRemoved: d.typesRemoved.slice(0, 100),
        typesChanged: d.typesChanged.slice(0, 100),
        migrationHints: d.migrationHints.slice(0, maxHints),
      });
    },
  );
}
