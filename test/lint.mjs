// v5.1 fixture test: every retained-lessons rule must FIRE on its positive fixture
// and STAY SILENT on its negative fixture. Run: npm run test:lint
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_RULES, registerLintTools, runLint } from "../dist/lint.js";

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


// ── Task S5: the advisory vault block carries explicit declaration authority; `clean` is untouched ──
// A project root hint makes preflight_lint read the vault's declaration identity and the project's
// declared identity (statically) and verify reviewed evidence between them. Without a verified
// linkage the vault findings are HISTORICAL symbol lookups and are labeled so; `clean` still comes
// from violations and project errors only.
{
  const handlers = {};
  registerLintTools(
    { registerTool: (name, _metadata, fn) => { handlers[name] = fn; } },
    { call: async () => ({ status: "unavailable", action: "query_graph", error: "second opinion is not exercised here" }) },
  );
  const here = path.dirname(fileURLToPath(import.meta.url));
  const FIXTURE = path.join(here, "fixtures", "agent-vault");
  const lint = async (args) => JSON.parse((await handlers.preflight_lint(args)).content[0].text);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s5-lint-project "));
  const sandboxVault = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s5-lint-vault-"));
  const priorVault = process.env.PICO_AGENT_VAULT;
  const noTargetValidation = (text) => !/is target-verified|target-compatible|validated against the project|validates the project/i.test(text ?? "");
  try {
    fs.mkdirSync(path.join(projectDir, "gradle"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "gradle", "libs.versions.toml"), '[versions]\nbom = "6.1.0"\n\n[libraries]\nbom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }\n');
    const apiDir = path.join(sandboxVault, "knowledge", "api-reference");
    fs.mkdirSync(apiDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(FIXTURE, "knowledge", "api-reference"))) fs.copyFileSync(path.join(FIXTURE, "knowledge", "api-reference", f), path.join(apiDir, f));
    fs.writeFileSync(path.join(sandboxVault, "package.xml"), "<package><revision><major>0</major><minor>13</minor><micro>3</micro></revision></package>\n");

    const kotlinClean = "import com.pico.spatial.core.ecs.Entity\nval e = Entity()\n";
    const kotlinUnknown = "import com.pico.spatial.core.ecs.FrobnicatorComponent\nval f = FrobnicatorComponent()\n";

    // (a) fixture vault without package.xml: identity unavailable, findings still advisory, clean untouched
    process.env.PICO_AGENT_VAULT = FIXTURE;
    const noRevision = await lint({ content: kotlinUnknown, kind: "kotlin", projectDir });
    if (noRevision.vault?.status === "ok" && noRevision.vault.findings.length === 1 && noRevision.vault.declarationIdentity?.status === "unavailable" && /package-xml/.test(noRevision.vault.declarationIdentity.code)) console.log("  ok   S5: vault findings stay advisory beside an unavailable declaration identity that names package.xml");
    else fail(`S5: unavailable-identity vault block wrong: ${JSON.stringify(noRevision.vault).slice(0, 400)}`);
    if (noRevision.vault?.target?.declaredBom === "6.1.0" && noRevision.vault.target.status === "declared") console.log("  ok   S5: the project identity is read from projectDir and reported in the advisory block");
    else fail(`S5: target identity missing from the vault block: ${JSON.stringify(noRevision.vault?.target)}`);
    if (noRevision.vault?.declarationContext?.status === "unavailable" && /HISTORICAL/.test(noRevision.vault.authorityNote) && /target linkage is unavailable/.test(noRevision.vault.authorityNote) && noTargetValidation(noRevision.vault.note) && noTargetValidation(noRevision.vault.authorityNote)) console.log("  ok   S5: unavailable linkage is stated without any target-validation wording");
    else fail(`S5: linkage wording wrong: ${JSON.stringify({ context: noRevision.vault?.declarationContext, note: noRevision.vault?.note, authorityNote: noRevision.vault?.authorityNote })}`);
    if (noRevision.clean === (noRevision.violations.length === 0 && noRevision.counts.projectErrors === 0)) console.log("  ok   S5: clean is derived from violations and project errors only (vault linkage does not enter)");
    else fail(`S5: clean drifted: ${JSON.stringify({ clean: noRevision.clean, violations: noRevision.violations.length, projectErrors: noRevision.counts.projectErrors })}`);
    const noProject = await lint({ content: kotlinUnknown, kind: "kotlin" });
    if (noProject.clean === true && noProject.vault.findings.length === 1 && noProject.vault.target === null && noProject.vault.declarationContext?.status === "unavailable") console.log("  ok   S5: without a project hint an unknown-symbol finding still leaves clean true and reports no target");
    else fail(`S5: no-project vault block wrong: ${JSON.stringify({ clean: noProject.clean, vault: noProject.vault }).slice(0, 400)}`);
    const withViolation = await lint({ content: `${kotlinClean}entity.components.set(CollisionComponent())\n`, kind: "kotlin" });
    if (withViolation.clean === false && withViolation.violations.length > 0) console.log("  ok   S5: a retained-lessons violation still makes clean false, independent of the vault block");
    else fail(`S5: violation no longer gates clean: ${JSON.stringify({ clean: withViolation.clean, violations: withViolation.violations.length })}`);

    // (b) a vault WITH package.xml: identity ok, 0.13.3 -> 6.1.0 linkage unknown, labeled historical
    process.env.PICO_AGENT_VAULT = sandboxVault;
    const declared = await lint({ content: kotlinClean, kind: "kotlin", projectDir });
    if (declared.vault?.declarationIdentity?.status === "ok" && declared.vault.declarationIdentity.packageRevision === "0.13.3" && declared.vault.declarationContext?.status === "unknown") console.log("  ok   S5: a declared 0.13.3 vault against a 6.1.0 project reports unknown linkage");
    else fail(`S5: declared vault linkage wrong: ${JSON.stringify({ identity: declared.vault?.declarationIdentity, context: declared.vault?.declarationContext })}`);
    if (/HISTORICAL declaration lookups \(package revision 0\.13\.3\)/.test(declared.vault?.authorityNote) && /target linkage is unknown/.test(declared.vault.authorityNote) && /HISTORICAL agent-vault api-reference/.test(declared.vault.note) && noTargetValidation(declared.vault.note)) console.log("  ok   S5: the no-findings note calls the lookup historical, not a target SDK validation");
    else fail(`S5: historical wording wrong: ${JSON.stringify({ note: declared.vault?.note, authorityNote: declared.vault?.authorityNote })}`);
    if (JSON.stringify(declared.vault?.declarationContext?.rejected) === "[]" && JSON.stringify(declared.vault?.declarationContext?.verifiedSymbols) === "[]") console.log("  ok   S5: the packaged index has no records, so nothing is verified and nothing is rejected");
    else fail(`S5: evidence lists wrong: ${JSON.stringify(declared.vault?.declarationContext)}`);
    if (declared.clean === (declared.violations.length === 0 && declared.counts.projectErrors === 0)) console.log("  ok   S5: clean semantics unchanged with a declared vault and a project hint");
    else fail("S5: clean drifted with a declared vault");
  } finally {
    if (priorVault === undefined) delete process.env.PICO_AGENT_VAULT;
    else process.env.PICO_AGENT_VAULT = priorVault;
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(sandboxVault, { recursive: true, force: true });
  }
}

console.log(`\nLint fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
