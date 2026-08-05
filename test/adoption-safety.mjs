// v34.1 adoption safety: project configuration, build truth, and pico-cli structured status.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { fail(`${m}: ${e.message}`); } };
const asyncCheck = async (m, fn) => { try { await fn(); ok(m); } catch (e) { fail(`${m}: ${e.message}`); } };

const projectconfig = await import("../dist/projectconfig.js");
const buildmatrix = await import("../dist/buildmatrix.js");
const { parsePicoCliEnvelope } = await import("../dist/picocli.js");
const { picoFixDecision } = await import("../dist/doors.js");

const MODULES = [
  ["androidx.compose.ui", "ui"],
  ["androidx.compose.ui", "ui-graphics"],
  ["androidx.compose.ui", "ui-text"],
  ["androidx.compose.foundation", "foundation"],
];
const exclusions = (omit = -1) => MODULES.filter((_, i) => i !== omit)
  .map(([group, name]) => `exclude("${group}", "${name}")`).join("\n");
const manifest = (family = "stage") => `<?xml version="1.0"?><manifest><application><activity android:name=".MainActivity">\n<meta-data android:name="pico.spatial.${family}.id" android:value="main"/>\n</activity></application></manifest>`;
const root = (kind = "stage") => kind === "stage"
  ? "fun mainApp() { DefaultStage { } }"
  : "fun mainApp() { DefaultWindowContainer { } }";

function project({ omit = -1, dependency = "", family = "stage", rootKind = "stage", duplicateRoot = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pico-adoption-safety-"));
  const app = path.join(dir, "app");
  mkdirSync(path.join(app, "src/main/java/com/example"), { recursive: true });
  mkdirSync(path.join(app, "src/main"), { recursive: true });
  writeFileSync(path.join(app, "build.gradle.kts"), `configurations.all { resolutionStrategy {\n${exclusions(omit)}\n} }\ndependencies {\n${dependency}\n}`);
  writeFileSync(path.join(app, "src/main/AndroidManifest.xml"), manifest(family));
  writeFileSync(path.join(app, "src/main/java/com/example/Main.kt"), `${root(rootKind)}\n${duplicateRoot ? root(rootKind === "stage" ? "window" : "stage") : ""}`);
  return dir;
}

const dirs = [];
try {
  const good = project(); dirs.push(good);
  const audit = projectconfig.auditProjectConfig(good);
  check("skeleton-shaped project passes static config audit", () => assert.equal(audit.static.errors.length, 0));

  for (let i = 0; i < MODULES.length; i++) {
    const dir = project({ omit: i }); dirs.push(dir);
    const out = projectconfig.auditProjectConfig(dir);
    const id = `${MODULES[i][0]}:${MODULES[i][1]}`;
    check(`missing Compose exclusion is named: ${id}`, () => assert(out.static.errors.some((x) => x.message.includes(id))));
  }

  const direct = project({ dependency: 'implementation("androidx.compose.ui:ui:1.7.0")' }); dirs.push(direct);
  check("direct forbidden Compose dependency is an error", () => assert(projectconfig.auditProjectConfig(direct).static.errors.some((x) => /direct dependency/.test(x.message))));

  const stageWindow = project({ family: "stage", rootKind: "window" }); dirs.push(stageWindow);
  check("Stage metadata with WindowContainer root is an error", () => assert(projectconfig.auditProjectConfig(stageWindow).static.errors.some((x) => /Stage metadata.*WindowContainer/.test(x.message))));
  const windowStage = project({ family: "windowcontainer", rootKind: "stage" }); dirs.push(windowStage);
  check("WindowContainer metadata with Stage root is an error", () => assert(projectconfig.auditProjectConfig(windowStage).static.errors.some((x) => /WindowContainer metadata.*Stage/.test(x.message))));
  const matchingWindow = project({ family: "windowcontainer", rootKind: "window" }); dirs.push(matchingWindow);
  check("matching WindowContainer family passes", () => assert.equal(projectconfig.auditProjectConfig(matchingWindow).static.errors.length, 0));
  const ambiguous = project({ duplicateRoot: true }); dirs.push(ambiguous);
  check("multiple roots are warning ambiguity, not an invented error", () => assert(projectconfig.auditProjectConfig(ambiguous).static.warnings.some((x) => /multiple roots/i.test(x.message))));

  const outside = mkdtempSync(path.join(os.tmpdir(), "pico-adoption-outside-")); dirs.push(outside);
  const escaping = project(); dirs.push(escaping);
  symlinkSync(outside, path.join(escaping, "escape"));
  check("escaping symlink is refused", () => assert(projectconfig.auditProjectConfig(escaping).static.errors.some((x) => /symlink/i.test(x.message))));
  const unrelated = project(); dirs.push(unrelated);
  writeFileSync(path.join(unrelated, "app/build.gradle.kts"), `fun unused() {\n${exclusions()}\n}\ndependencies { }`);
  check("exclusions outside global resolution scope do not satisfy the contract", () => assert(projectconfig.auditProjectConfig(unrelated).static.errors.some((x) => /Missing required exclusion/.test(x.message))));
  const groovy = project(); dirs.push(groovy);
  writeFileSync(path.join(groovy, "app/build.gradle.kts"), `configurations.all {\n resolutionStrategy {\n${MODULES.map(([g,n]) => `exclude group: '${g}', module: '${n}'`).join("\n")}\n }\n}\n`);
  check("canonical Groovy global exclusions satisfy the contract", () => assert.equal(projectconfig.auditProjectConfig(groovy).static.errors.length, 0));
  const mixedMeta = project(); dirs.push(mixedMeta);
  writeFileSync(path.join(mixedMeta, "app/src/main/AndroidManifest.xml"), manifest("stage").replace("</activity>", '<meta-data android:name="pico.spatial.windowcontainer.id" android:value="secondary"/></activity>'));
  check("mixed metadata is warning-only ambiguity", () => assert(projectconfig.auditProjectConfig(mixedMeta).static.warnings.some((x) => /Both pico\.spatial/.test(x.message))));

  const graph = "+--- com.example:wrapper:1.0\n|    \\--- androidx.compose.ui:ui:1.7.0\n";
  check("resolved Compose graph retains the parent chain", () => {
    const finding = projectconfig.parseResolvedComposeGraph(graph)[0];
    assert.equal(finding.artifact, "androidx.compose.ui:ui");
    assert.deepEqual(finding.parentChain, ["com.example:wrapper"]);
  });
  const resolved = project(); dirs.push(resolved);
  const wrapper = path.join(resolved, "gradlew");
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' '${graph.replace(/'/g, "'\\''")}'\n`); chmodSync(wrapper, 0o755);
  await asyncCheck("opt-in resolved verification finds a transitive forbidden artifact", async () => {
    const out = await projectconfig.verifyGradleConfig({ projectDir: resolved, resolveTransitives: true, timeoutMs: 2_000 });
    assert.equal(out.resolved.status, "ok");
    assert.equal(out.resolved.findings[0].artifact, "androidx.compose.ui:ui");
    assert.equal(out.resolved.findings[0].parentChain[0], "com.example:wrapper");
  });
  await asyncCheck("resolveTransitives:false does not execute the wrapper", async () => {
    writeFileSync(wrapper, "#!/bin/sh\nexit 42\n");
    const out = await projectconfig.verifyGradleConfig({ projectDir: resolved, resolveTransitives: false });
    assert.equal(out.resolved.status, "not-requested");
  });
  await asyncCheck("timeout preserves the static result and reports timeout", async () => {
    writeFileSync(path.join(resolved, "app/build.gradle.kts"), 'implementation("androidx.compose.ui:ui:1.7.0")');
    writeFileSync(wrapper, "#!/bin/sh\nsleep 2\n"); chmodSync(wrapper, 0o755);
    const out = await projectconfig.verifyGradleConfig({ projectDir: resolved, resolveTransitives: true, timeoutMs: 1_000 });
    assert.equal(out.resolved.status, "timeout");
    assert(out.static.errors.some((x) => /direct dependency/.test(x.message)));
  });
  await asyncCheck("non-zero Gradle preserves the static result and reports failure", async () => {
    writeFileSync(wrapper, "#!/bin/sh\necho bad >&2\nexit 9\n"); chmodSync(wrapper, 0o755);
    const out = await projectconfig.verifyGradleConfig({ projectDir: resolved, resolveTransitives: true, timeoutMs: 2_000 });
    assert.equal(out.resolved.status, "failed");
    assert(out.static.errors.some((x) => /direct dependency/.test(x.message)));
  });

  const matrix = buildmatrix.extractBuildMatrix();
  check("build matrix extracts literal skeleton facts", () => {
    assert.equal(matrix.observed.minSdk, "35");
    assert.equal(matrix.observed.agp, "8.13.2");
    assert.equal(matrix.observed.bom, "0.13.3");
    assert(matrix.sourceFiles.every((p) => p.includes("appskeleton")));
    assert.equal(matrix.observed.abi, "arm64-v8a");
    assert.equal(matrix.extractionFailures.length, 0);
    assert(matrix.caveat.includes("known-good scaffold matrix, not the support envelope"));
  });
  check("BUILD_MATRIX literals stay aligned with the extractor", () => {
    const doc = readFileSync(new URL("../docs/BUILD_MATRIX.md", import.meta.url), "utf8");
    for (const [key, fact] of Object.entries(matrix.observed)) {
      if (key === "spatialToolsVersion") assert(doc.includes("`not-declared`"));
      else assert(doc.includes(fact), `missing matrix fact ${key}: ${fact}`);
    }
    assert(doc.includes("appskeleton/app/build.gradle.kts"));
    assert(doc.includes("appskeleton/gradle/libs.versions.toml"));
    assert(doc.includes("known-good scaffold matrix, not the support envelope"));
  });
  check("spatialToolsVersion is exactly not-declared", () => assert.equal(matrix.observed.spatialToolsVersion.status, "not-declared"));

  for (const [name, outcome] of [["success", "operational"], ["partial", "degraded"], ["failed", "failed"]]) {
    const raw = readFileSync(new URL(`./fixtures/picocli/emulator-status-${name}.json`, import.meta.url), "utf8");
    check(`${name.toUpperCase()} envelope normalizes honestly`, () => assert.equal(parsePicoCliEnvelope(raw).outcome, outcome));
  }
  check("malformed envelope is an explicit parse error", () => assert.equal(parsePicoCliEnvelope("{bad").status, "invalid"));
  check("missing tool_status is an explicit parse error", () => assert.equal(parsePicoCliEnvelope('{"data":{}}').status, "invalid"));
  check("envelope preserves bounded full diagnostic payload", () => { const p = parsePicoCliEnvelope('{"tool_status":"FAILED","summary":"no boot","data":{"nextAction":"boot emulator"},"errors":[{"fix":"open editor"}]}'); assert.equal(p.envelope.data.nextAction, "boot emulator"); assert(p.raw.includes("open editor")); });
  check("pico_fix routes Compose and container failures before generic Gradle", () => {
    assert.equal(picoFixDecision("Gradle found androidx.compose.ui:ui and an exclusion is missing").symptom, "compose_fork_conflict");
    assert.equal(picoFixDecision("DefaultWindowContainer does not match pico.spatial.stage.id").symptom, "container_mode_mismatch");
  });
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

console.log(`\nAdoption safety test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
