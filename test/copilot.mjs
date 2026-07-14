// v25 live-copilot test: the host-side halves that must never regress — bridge-line parsing
// (the ack/dump protocol) and scene diffing (the copilot's verification). Pure functions, CI-safe.
// The live path (spawn→move→remove against a running app) was emulator-proven and ledgered.
// Run: npm run test:copilot
import { parseBridgeLine, diffSnapshots } from "../dist/copilot.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

// 1) parse a real ack line (values with folded spaces, tag echo)
const ack = parseBridgeLine("07-14 00:31:41.7 8531 8531 I AgentBridge: AGENTBRIDGE| event=spawned tag=t9 id=copilot_orb pos=0.05,1.35,-1.95");
if (ack?.event === "spawned" && ack.fields.tag === "t9" && ack.fields.pos === "0.05,1.35,-1.95") ok("ack line parses (event + tag + fields)");
else fail(`ack parse wrong: ${JSON.stringify(ack)}`);

// 2) entity dump line parses; non-bridge lines return null
const ent = parseBridgeLine("I AgentBridge: AGENTBRIDGE| event=entity d=1 name=crate children=0 pos=0.73,1.0,-1.97 scale=1.0,1.0,1.0 comps=CollisionComponent,TransformComponent");
if (ent?.event === "entity" && ent.fields.name === "crate" && ent.fields.d === "1") ok("entity dump line parses");
else fail(`entity parse wrong: ${JSON.stringify(ent)}`);
if (parseBridgeLine("random logcat noise without the marker") === null) ok("non-bridge lines are ignored");
else fail("noise line parsed as a bridge event");

// 3) diff: added + removed + moved with delta meters; sub-epsilon moves ignored
const before = [
  { name: "SceneRoot", depth: 0, pos: [0, 0, 0], comps: "" },
  { name: "crate", depth: 1, pos: [0.73, 1.0, -1.97], comps: "" },
  { name: "oldPanel", depth: 1, pos: [1, 1, -1], comps: "" },
  { name: "jitter", depth: 1, pos: [0, 1, -2], comps: "" },
];
const after = [
  { name: "SceneRoot", depth: 0, pos: [0, 0, 0], comps: "" },
  { name: "crate", depth: 1, pos: [0.73, 1.4, -1.97], comps: "" }, // moved +0.4y
  { name: "copilot_orb", depth: 1, pos: [-0.25, 1.5, -1.95], comps: "" }, // added
  { name: "jitter", depth: 1, pos: [0, 1.0001, -2], comps: "" }, // sub-epsilon: NOT a move
];
const d = diffSnapshots(before, after);
if (d.added.length === 1 && d.added[0].name === "copilot_orb") ok("diff reports the added entity");
else fail(`added wrong: ${JSON.stringify(d.added)}`);
if (d.removed.length === 1 && d.removed[0].name === "oldPanel") ok("diff reports the removed entity");
else fail(`removed wrong: ${JSON.stringify(d.removed)}`);
if (d.moved.length === 1 && d.moved[0].name === "crate" && Math.abs(d.moved[0].deltaM - 0.4) < 1e-6) ok(`diff reports the move with delta ${d.moved[0].deltaM}m; 0.1mm jitter ignored`);
else fail(`moved wrong: ${JSON.stringify(d.moved)}`);

console.log(`\nCopilot test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
