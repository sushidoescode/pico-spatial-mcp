// v5.1 fixture test: every retained-lessons rule must FIRE on its positive fixture
// and STAY SILENT on its negative fixture. Run: npm run test:lint
import fs from "node:fs";
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

// Space Program retained lessons: both findings are warning-only and carry their own
// matching/non-matching fixtures. Keep these named assertions in addition to the generic loop so
// deleting or renaming either rule cannot make the fixture count look green by omission.
for (const [id, requiredText] of [
  ["dynamic-full-stage-emulator-safety", ["runtime stage style 2", "safety transition", "manifest-declared style-1 DefaultStage", "hardware", "Safeguard"]],
  ["defaultstage-windowcontainer-metadata", ["DefaultStage", "pico.spatial.windowcontainer"]],
]) {
  const rule = BUILTIN_RULES.find((candidate) => candidate.id === id);
  if (!rule) { fail(`${id}: requested retained-lesson rule is missing`); continue; }
  if (rule.severity !== "warn") fail(`${id}: must remain advisory (severity warn)`);
  const guidance = `${rule.message} ${rule.fix}`;
  for (const text of requiredText) {
    if (!guidance.includes(text)) fail(`${id}: guidance is missing ${JSON.stringify(text)}`);
  }
  const matching = runLint(rule.positiveFixture, "any", [rule]);
  const nonMatching = runLint(rule.negativeFixture, "any", [rule]);
  if (matching.length !== 1) fail(`${id}: matching fixture should emit exactly one warning`);
  if (nonMatching.length !== 0) fail(`${id}: non-matching fixture must remain clean`);
  if (id === "dynamic-full-stage-emulator-safety") {
    const laterFull = runLint("spatialNavigator.openStage(SpatialContainers.ID_MAIN, StageStyle.Mixed)\nval style = StageStyle.Full", "kotlin", [rule]);
    if (laterFull.length !== 0) fail(`${id}: StageStyle.Full after the completed call must remain clean`);
    const nestedMultiline = runLint("spatialNavigator.openStage(\n  resolveStage(containerId(\"full\")),\n  StageStyle.Full,\n)", "kotlin", [rule]);
    if (nestedMultiline.length !== 1) fail(`${id}: two-level nested multiline arguments should emit exactly one warning`);
  }
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

// --------------------------------------------------------------------------------------------
// Repo self-consistency lint: the PUBLISHED size of the gate battery must match reality.
//
// This number has drifted three times — it was corrected earlier in the v29.2 arc and re-broken by
// two later tasks that each added a gate — because nothing asserted it. Three sources have to
// agree: the `test:` scripts in package.json, the `npm run test:` invocations in gates.yml (the
// file that actually gates main), and the count stated in README.md and docs/COLLABORATORS.md.
// Set equality, not just cardinality: equal counts with a different membership would mean a gate
// exists that CI never runs, which is the failure the "mirrored 1:1" claim is about.
// --------------------------------------------------------------------------------------------
{
  const repoRoot = new URL("../", import.meta.url);
  const read = (relative) => fs.readFileSync(new URL(relative, repoRoot), "utf8");

  const scriptNames = Object.keys(JSON.parse(read("package.json")).scripts)
    .filter((name) => name.startsWith("test:"))
    .sort();
  const gatesYml = read(".github/workflows/gates.yml");
  const gateNames = [...gatesYml.matchAll(/npm run (test:[A-Za-z0-9:_-]+)/g)]
    .map((match) => match[1])
    .sort();

  const onlyInPackage = scriptNames.filter((name) => !gateNames.includes(name));
  const onlyInGates = gateNames.filter((name) => !scriptNames.includes(name));
  if (onlyInPackage.length) fail(`battery: package.json declares gates that gates.yml never runs: ${onlyInPackage.join(", ")}`);
  if (onlyInGates.length) fail(`battery: gates.yml runs scripts package.json does not declare: ${onlyInGates.join(", ")}`);
  if (new Set(gateNames).size !== gateNames.length) {
    fail(`battery: gates.yml invokes the same gate twice: ${gateNames.join(", ")}`);
  }
  if (!/npm run smoke/.test(gatesYml)) fail("battery: gates.yml no longer runs smoke");

  // `smoke` is the one gate invocation that is not a `test:` script.
  const suiteCount = scriptNames.length;
  const invocationCount = suiteCount + 1;
  const CLAIM = /(\d+) gate invocations \((\d+) `test:` suites plus `smoke`\)/;
  for (const doc of ["README.md", "docs/COLLABORATORS.md"]) {
    const claim = CLAIM.exec(read(doc));
    if (!claim) {
      fail(`battery: ${doc} no longer states the gate-battery size in the checked form ` +
           `"<N> gate invocations (<M> \`test:\` suites plus \`smoke\`)"`);
      continue;
    }
    if (Number(claim[1]) !== invocationCount || Number(claim[2]) !== suiteCount) {
      fail(`battery: ${doc} claims ${claim[1]} invocations / ${claim[2]} suites; ` +
           `package.json + gates.yml say ${invocationCount} / ${suiteCount}`);
    }
  }
  if (!failures) {
    console.log(`\n  ok   published gate-battery size agrees across package.json, gates.yml, README.md, and docs/COLLABORATORS.md (${invocationCount} invocations / ${suiteCount} test: suites)`);
  }
}

console.log(`\nLint fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
