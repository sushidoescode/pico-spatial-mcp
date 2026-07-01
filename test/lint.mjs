// v5.1 fixture test: every retained-lessons rule must FIRE on its positive fixture
// and STAY SILENT on its negative fixture. Run: npm run test:lint
import { BUILTIN_RULES, runLint } from "../dist/lint.js";

let failures = 0;
const fail = (msg) => { console.log(`  FAIL ${msg}`); failures++; };

console.log(`Testing ${BUILTIN_RULES.length} built-in lint rules (positive + negative fixtures each)...\n`);
for (const rule of BUILTIN_RULES) {
  if (!rule.positiveFixture) { fail(`${rule.id}: no positiveFixture`); continue; }
  if (rule.negativeFixture === undefined) { fail(`${rule.id}: no negativeFixture`); continue; }
  // Run each rule IN ISOLATION so unrelated rules don't pollute the result.
  const pos = runLint(rule.positiveFixture, "any", [rule]);
  const neg = runLint(rule.negativeFixture, "any", [rule]);
  const posFired = pos.some((v) => v.ruleId === rule.id);
  const negFired = neg.some((v) => v.ruleId === rule.id);
  if (!posFired) fail(`${rule.id}: positive fixture did NOT trigger the rule`);
  if (negFired) fail(`${rule.id}: negative fixture WRONGLY triggered the rule`);
  if (posFired && !negFired) console.log(`  ok   ${rule.id} [${rule.severity}]`);
}

// A tiny integration check: a multi-gotcha Kotlin blob should surface several errors at once.
const dirty = [
  'primvars:displayColor = [(1,0,0)]',
  'entity.components.set(CollisionComponent())',
  'val hit = scene.rayCast(o, d, 10f, CollisionCastHitMode.CLOSEST, g, null).results.firstOrNull()',
  'entity.components.set(TextComponent("hi"))',
].join("\n");
const found = runLint(dirty, "kotlin").map((v) => v.ruleId);
for (const id of ["displayColor-flat-white", "collisioncomponent-no-arg", "collisioncasthitmode-closest", "text-component", "raycast-without-physicsworld"]) {
  if (!found.includes(id)) fail(`integration: expected '${id}' in a dirty blob, got [${found.join(", ")}]`);
}
console.log(`\n  ok   integration blob surfaced ${found.length} violations`);

console.log(`\nLint fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
