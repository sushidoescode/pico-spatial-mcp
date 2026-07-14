// v20 referring-expression suite: 20 natural-language references scored against the REAL
// ramen-world semantic scene (looked-at labels). Deterministic — doubles as a regression test
// for the label matcher AND a scored benchmark for the bench narrative. Two cases are DESIGNED
// honest misses (labels that don't exist in the scene must resolve to not-found, never guessed).
// Run: npm run test:referring
import fs from "node:fs";
import { resolveSemanticPlacement } from "../dist/semanticplace.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const SCENE_PATH = "/Users/sushantsrikrish/.pico-mcp/artifacts/ramen-v19-semantic-app.json";
if (!fs.existsSync(SCENE_PATH)) {
  console.log("  skip real ramen semantic scene not on this machine — suite skipped");
  process.exit(0);
}
const scene = JSON.parse(fs.readFileSync(SCENE_PATH, "utf8"));

// [expression, expected] — expected: cluster id | "not-found" | ["ambiguous", id]
const CASES = [
  ["neon sign", 8],
  ["the neon sign", 8],
  ["sign", 8],
  ["glowing neon sign", 8],
  ["menu board", 4],
  ["board", 4],
  ["menu display", 2],
  ["display", 2],
  ["the menu", ["ambiguous", null]], // matches menu board AND menu display equally — must SAY so
  ["paper lantern", 9],
  ["lantern", 9],
  ["hanging paper lantern", 9],
  ["ceiling", 6],
  ["ceiling beam", 7],
  ["beam", 7],
  ["neon trim", 3],
  ["trim", 3],
  ["neon", ["ambiguous", null]], // neon sign vs neon trim — ambiguity must be reported
  ["bar counter", "not-found"], // the counter never got a clean label — must NOT be guessed
  ["jukebox", "not-found"],
];

let score = 0;
for (const [expr, expected] of CASES) {
  const r = resolveSemanticPlacement(scene, { label: expr });
  if (expected === "not-found") {
    if (r.status === "not-found") { score++; ok(`"${expr}" → not-found (honest)`); }
    else fail(`"${expr}" expected not-found, got ${r.status} #${r.matched?.id} '${r.matched?.label}'`);
  } else if (Array.isArray(expected)) {
    if (r.status === "ambiguous") { score++; ok(`"${expr}" → ambiguous (reported, resolved to #${r.matched.id})`); }
    else fail(`"${expr}" expected ambiguous, got ${r.status} #${r.matched?.id}`);
  } else {
    if (r.status === "ok" && r.matched.id === expected) { score++; ok(`"${expr}" → #${expected} '${r.matched.label}'`); }
    else fail(`"${expr}" expected #${expected}, got ${r.status} #${r.matched?.id} '${r.matched?.label}'`);
  }
}
console.log(`\nReferring-expression score: ${score}/${CASES.length} (${Math.round((score / CASES.length) * 100)}%)`);
console.log(`Referring suite done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
