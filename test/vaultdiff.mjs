// v26 vault-diff test: the drift engine against a LABELED fixture pair (agent-vault -> the
// deliberately-drifted agent-vault-next twin). Five drift classes, each asserted, plus the
// migration-hint text an upgrade brief would consume. Real-workspace enumeration asserts only
// on machines where pico-cli has materialized vaults. Run: npm run test:vaultdiff
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVaultIndex } from "../dist/vault.js";
import * as vaultdiff from "../dist/vaultdiff.js";

const {
  diffVaultIndexes,
  listVaultWorkspaces,
  registerVaultDiffTools,
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

console.log(`\nVault-diff test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
