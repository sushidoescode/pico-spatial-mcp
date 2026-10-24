// v26 vault-diff test: the drift engine against a LABELED fixture pair (agent-vault -> the
// deliberately-drifted agent-vault-next twin). Five drift classes, each asserted, plus the
// migration-hint text an upgrade brief would consume. Real-workspace enumeration asserts only
// on machines where pico-cli has materialized vaults. Run: npm run test:vaultdiff
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVaultIndex } from "../dist/vault.js";
import * as vaultdiff from "../dist/vaultdiff.js";

const {
  diffVaultIndexes,
  listVaultWorkspaces,
  registerVaultDiffTools,
  resolveVaultDiffRoot,
  vaultWorkspaceNote,
} = vaultdiff;

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const here = path.dirname(fileURLToPath(import.meta.url));
const from = loadVaultIndex(path.join(here, "fixtures", "agent-vault"));
const to = loadVaultIndex(path.join(here, "fixtures", "agent-vault-next"));
if (!from || !to) { fail("fixture vaults did not load"); process.exit(1); }

const d = diffVaultIndexes(from, to);
const changed = Object.fromEntries(d.typesChanged.map((t) => [t.type, t]));

// 1) type added
if (d.typesAdded.includes("com.pico.spatial.core.ecs.PhysicsJointComponent")) ok("typesAdded catches the new fixture type");
else fail(`typesAdded wrong: ${d.typesAdded.join(", ")}`);

// 2) type removed + hint
if (d.typesRemoved.includes("com.pico.spatial.core.ecs.PhysicsForceComponent")) ok("typesRemoved catches the deleted type");
else fail(`typesRemoved wrong: ${d.typesRemoved.join(", ")}`);
if (d.migrationHints.some((h) => h.includes("PhysicsForceComponent") && h.includes("no longer exists"))) ok("removed type carries a migration hint");
else fail("no hint for the removed type");

// 3) rename detected as remove+add with the 'likely renamed' hint
const entity = changed["com.pico.spatial.core.ecs.Entity"];
if (entity?.membersRemoved.includes("setName()") && entity?.membersAdded.includes("setDisplayName()")) ok("member rename shows as removed+added on Entity");
else fail(`Entity change wrong: ${JSON.stringify(entity)}`);
if (d.migrationHints.some((h) => h.includes("Entity.setName()") && h.includes("likely renamed to setDisplayName()"))) ok("1:1 member swap hints the likely rename");
else fail(`rename hint missing: ${d.migrationHints.filter((h) => h.includes("Entity")).join(" | ")}`);

// 4) ctor arity change: RigidBodyComponent 2-arg gone, 3-arg new
const rbc = changed["com.pico.spatial.core.ecs.RigidBodyComponent"];
if (rbc?.ctorAritiesRemoved.includes(2) && rbc?.ctorAritiesAdded.includes(3)) ok("ctor arity drift caught (2 removed, 3 added)");
else fail(`RigidBodyComponent ctor drift wrong: ${JSON.stringify(rbc)}`);
if (d.migrationHints.some((h) => h.includes("RigidBodyComponent no longer has a 2-arg constructor"))) ok("arity hint names the broken construction site");
else fail("arity hint missing");

// 5) member removed: angularDamping
if (rbc?.membersRemoved.includes("angularDamping")) ok("removed property caught (angularDamping)");
else fail(`membersRemoved wrong: ${JSON.stringify(rbc?.membersRemoved)}`);

// 6) unchanged types stay silent
if (!changed["com.pico.spatial.core.ecs.TransformComponent"]) ok("unchanged types produce no drift noise");
else fail("TransformComponent falsely reported as changed");

// 7) real workspaces (machine-dependent; skip cleanly elsewhere)
const ws = listVaultWorkspaces();
if (ws.length) {
  if (ws.some((w) => w.version === "0.13" && w.mdFiles > 0)) ok(`real workspaces enumerate (${ws.map((w) => `${w.version}:${w.mdFiles}md`).join(", ")})`);
  else fail(`workspace list looks wrong: ${JSON.stringify(ws)}`);
} else {
  console.log("  skip no materialized vaults on this machine — workspace assert skipped");
}

// Public setup guidance must never send an agent through an ambient PATH command. The no/one
// workspace branch is a pure result contract so this stays hermetic even when the host has several
// real SDK vaults materialized.
const registered = {};
registerVaultDiffTools({ tool(name, description, _schema, handler) {
  registered[name] = { description, handler };
} });
const publicDescription = registered.vault_workspaces?.description ?? "";
const publicNote = typeof vaultWorkspaceNote === "function" ? vaultWorkspaceNote([]) : "missing formatter export";
const singletonNote = typeof vaultWorkspaceNote === "function"
  ? vaultWorkspaceNote([{ version: "fixture", root: "/fixture", mdFiles: 1 }])
  : "missing formatter export";
const returnedWorkspaceResult = JSON.parse((await registered.vault_workspaces.handler()).content[0].text);
const returnedNote = returnedWorkspaceResult.note ?? "";
if (!/pico-cli\s+setup/i.test(`${publicDescription}\n${publicNote}\n${returnedNote}`)
    && /no vault is materialized locally/i.test(publicNote)
    && /only one vault is materialized locally/i.test(singletonNote)
    && /ensure_pico_cli/i.test(publicNote)
    && /returned absolute path/i.test(publicNote)
    && /args \["setup"\]/i.test(publicNote)
    && returnedNote === vaultWorkspaceNote(returnedWorkspaceResult.workspaces)) {
  ok("vault_workspaces public schema/result routes setup through the managed absolute path");
} else {
  fail(`vault_workspaces exposes bare, inaccurate, or incomplete setup guidance: ${JSON.stringify({ publicDescription, publicNote, singletonNote, returnedNote })}`);
}

// ── Task S5: workspace labels are not revisions; version arguments are bounded; drift is historical ──
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s5-vaults-"));
  try {
    const fixtureApi = path.join(here, "fixtures", "agent-vault", "knowledge", "api-reference");
    for (const label of ["0.13", "6.1"]) {
      const apiDir = path.join(base, label, "agent-vault", "knowledge", "api-reference");
      fs.mkdirSync(apiDir, { recursive: true });
      for (const f of fs.readdirSync(fixtureApi)) fs.copyFileSync(path.join(fixtureApi, f), path.join(apiDir, f));
    }
    // only the 0.13 workspace declares a revision; the 6.1 DIRECTORY LABEL must not become one
    fs.writeFileSync(path.join(base, "0.13", "agent-vault", "package.xml"), "<package><revision><major>0</major><minor>13</minor><micro>3</micro></revision></package>\n");
    fs.writeFileSync(path.join(base, "stray.txt"), "not a workspace\n");

    const ws = listVaultWorkspaces(base);
    if (JSON.stringify(ws.map((w) => w.version)) === JSON.stringify(["0.13", "6.1"])) ok("S5: workspaces enumerate under the given base by directory label");
    else fail(`S5: workspace labels wrong: ${JSON.stringify(ws)}`);
    if (ws[0]?.packageRevision === "0.13.3" && ws[1]?.packageRevision === null) ok("S5: packageRevision comes from package.xml only — the 6.1 label declares nothing");
    else fail(`S5: packageRevision inferred or missing: ${JSON.stringify(ws)}`);

    const version = resolveVaultDiffRoot("0.13");
    const explicit = resolveVaultDiffRoot(path.join(base, "0.13", "agent-vault"));
    const home = resolveVaultDiffRoot("~/agent-vault-alias");
    const bad = ["../etc", "0.13/../../etc", "relative/agent-vault", "latest", "6.1.x", "", " 0.13 ", "0.13\n"].map((spec) => [spec, resolveVaultDiffRoot(spec)]);
    if (version.status === "ok" && version.source === "version" && version.root.endsWith(path.join("0.13", "agent-vault")) && !version.root.includes("..")) ok("S5: a numeric label resolves to <tools root>/<label>/agent-vault");
    else fail(`S5: numeric label resolution wrong: ${JSON.stringify(version)}`);
    if (explicit.status === "ok" && explicit.source === "explicit" && explicit.root === path.join(base, "0.13", "agent-vault")) ok("S5: an explicit root is an explicitly identified source");
    else fail(`S5: explicit root wrong: ${JSON.stringify(explicit)}`);
    if (home.status === "ok" && home.source === "explicit" && home.root === path.join(os.homedir(), "agent-vault-alias")) ok("S5: ~/ explicit roots expand to the home directory");
    else fail(`S5: ~ expansion wrong: ${JSON.stringify(home)}`);
    const escaped = bad.filter(([, r]) => r.status !== "error" || !/numeric SDK version label/.test(r.error));
    if (escaped.length === 0) ok("S5: traversal, relative roots, free text, and padded labels are refused as version arguments");
    else fail(`S5: version argument accepted: ${JSON.stringify(escaped)}`);
    const relativeRoot = resolveVaultDiffRoot("0.13/../../etc");
    if (relativeRoot.status === "error" && /absolute agent-vault root/.test(relativeRoot.error)) ok("S5: a relative spec with separators is neither a version nor an acceptable explicit root");
    else fail(`S5: relative root handling wrong: ${JSON.stringify(relativeRoot)}`);

    const tools = {};
    registerVaultDiffTools({ tool(name, _description, _schema, handler) { tools[name] = handler; } });
    const badFrom = JSON.parse((await tools.vault_diff({ from: "../x", to: "0.13", maxHints: 5 })).content[0].text);
    if (badFrom.status === "error" && /from:/.test(badFrom.error) && /numeric SDK version label/.test(badFrom.error)) ok("S5: vault_diff refuses a traversal version argument before touching the filesystem");
    else fail(`S5: vault_diff traversal handling wrong: ${JSON.stringify(badFrom)}`);
    const fixtureFrom = path.join(here, "fixtures", "agent-vault");
    const fixtureTo = path.join(here, "fixtures", "agent-vault-next");
    const drift = JSON.parse((await tools.vault_diff({ from: fixtureFrom, to: fixtureTo, maxHints: 5 })).content[0].text);
    if (drift.status === "ok" && drift.authority === "historical" && /not evidence/.test(drift.authorityNote ?? "")) ok("S5: a drift report is labeled historical and disclaims target authority");
    else fail(`S5: drift authority label missing: ${JSON.stringify({ status: drift.status, authority: drift.authority, authorityNote: drift.authorityNote })}`);
    if (drift.from?.source === "explicit" && drift.from.identity?.status === "unavailable" && /package-xml/.test(drift.from.identity.code) && drift.to?.identity?.status === "unavailable") ok("S5: each side reports its declaration identity — the fixtures declare no revision");
    else fail(`S5: per-side identity wrong: ${JSON.stringify({ from: drift.from, to: drift.to })}`);
    const declared = JSON.parse((await tools.vault_diff({ from: path.join(base, "0.13", "agent-vault"), to: fixtureTo, maxHints: 5 })).content[0].text);
    if (declared.status === "ok" && declared.from.identity?.status === "ok" && declared.from.identity.packageRevision === "0.13.3" && declared.from.identity.authority === "declarations") ok("S5: a side with package.xml reports its declared revision");
    else fail(`S5: declared-side identity wrong: ${JSON.stringify(declared.from)}`);
    const workspaces = JSON.parse((await tools.vault_workspaces()).content[0].text);
    if (typeof workspaces.base === "string" && workspaces.authority === "historical" && /directory label/.test(workspaces.authorityNote ?? "")) ok("S5: vault_workspaces names its base and separates labels from declared revisions");
    else fail(`S5: vault_workspaces authority fields missing: ${JSON.stringify(workspaces).slice(0, 300)}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

console.log(`\nVault-diff test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
