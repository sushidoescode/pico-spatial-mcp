// v5.1 fixture test: every retained-lessons rule must FIRE on its positive fixture
// and STAY SILENT on its negative fixture. Run: npm run test:lint
import fs from "node:fs";
import { BUILTIN_RULES, runLint } from "../dist/lint.js";
import { gateInventoryCounts, validateGateInventory } from "../scripts/gate-inventory.mjs";

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
  ["dynamic-full-stage-emulator-safety", ["runtime style 3", "manifest-declared", "spatialNavigator.openStage(StageStyle.Full)", "ejected to Home", "walks beyond the boundary", "Fabian's note attributed this to runtime style 2", "did not reproduce", "manifest-declared style-1 DefaultStage", "hardware", "Safeguard"]],
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
    const quotedCall = runLint('val docs = "spatialNavigator.openStage(ID, StageStyle.Full)"', "kotlin", [rule]);
    if (quotedCall.length !== 0) fail(`${id}: a quoted call example must remain clean`);
    const nestedComment = runLint("/* outer comment\n  /* nested comment */\n  spatialNavigator.openStage(ID, StageStyle.Full)\n*/", "kotlin", [rule]);
    if (nestedComment.length !== 0) fail(`${id}: a call inside a nested block comment must remain clean`);
    const laterMatchingCall = runLint("spatialNavigator.openStage(SpatialContainers.ID_MAIN, StageStyle.Mixed)\nspatialNavigator.openStage(SpatialContainers.ID_FULL, StageStyle.Full)", "kotlin", [rule]);
    if (laterMatchingCall.length !== 1 || laterMatchingCall[0].line !== 2 || !laterMatchingCall[0].match?.includes("ID_FULL")) {
      fail(`${id}: warning location must identify the matching call, not an earlier safe call`);
    }
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

const nestedCommentedGotcha = runLint("/* outer /* nested */ primvars:displayColor */", "kotlin");
if (nestedCommentedGotcha.some((v) => v.ruleId === "displayColor-flat-white")) {
  fail("nested Kotlin block comments must not expose a lint token after the inner close");
}

// --------------------------------------------------------------------------------------------
// Repo self-consistency lint: the PUBLISHED size of the gate battery must match reality.
//
// This number drifted three times — corrected in the v29.2 arc, re-broken by two later tasks that
// each added a gate — because nothing asserted it, and the last drift hid a real hole: a `test:`
// script no workflow lane ran at all. `scripts/gate-inventory.mjs` is now the single declaration;
// `validateGateInventory` is the only thing that decides whether package.json and gates.yml still
// agree with it (set equality both ways, no duplicates, and a lane whose runner OS matches the
// assigned host). The published counts below are DERIVED from that inventory, never typed, so a
// new gate cannot leave a stale number behind.
// --------------------------------------------------------------------------------------------
{
  const repoRoot = new URL("../", import.meta.url);
  const read = (relative) => fs.readFileSync(new URL(relative, repoRoot), "utf8");

  for (const finding of validateGateInventory(JSON.parse(read("package.json")), read(".github/workflows/gates.yml"))) {
    fail(`battery: ${finding}`);
  }

  const { invocations, suites, hosts } = gateInventoryCounts();
  const CLAIM = /(\d+) gate invocations \((\d+) `test:` suites plus `smoke`\)/;
  for (const doc of ["README.md", "docs/COLLABORATORS.md"]) {
    const claim = CLAIM.exec(read(doc));
    if (!claim) {
      fail(`battery: ${doc} no longer states the gate-battery size in the checked form ` +
           `"<N> gate invocations (<M> \`test:\` suites plus \`smoke\`)"`);
      continue;
    }
    if (Number(claim[1]) !== invocations || Number(claim[2]) !== suites) {
      fail(`battery: ${doc} claims ${claim[1]} invocations / ${claim[2]} suites; ` +
           `the gate inventory says ${invocations} / ${suites}`);
    }
  }
  if (!failures) {
    console.log(`\n  ok   published gate-battery size agrees across scripts/gate-inventory.mjs, package.json, gates.yml, README.md, and docs/COLLABORATORS.md (${invocations} invocations / ${suites} test: suites; linux ${hosts.linux}, windows ${hosts.windows}, macos ${hosts.macos})`);
  }
}

console.log(`\nLint fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
