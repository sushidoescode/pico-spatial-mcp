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
const missingComposeExclusions = (audit) => audit.static.errors.filter((finding) => finding.code === "missing-compose-exclusion");
const assertAllComposeExclusionsMissing = (audit) => {
  const missing = missingComposeExclusions(audit);
  assert.equal(missing.length, MODULES.length);
  for (const [group, name] of MODULES) {
    assert(missing.some((finding) => finding.message.includes(`${group}:${name}`)), `missing finding for ${group}:${name}`);
  }
};

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

  const commentedExclusions = project(); dirs.push(commentedExclusions);
  writeFileSync(path.join(commentedExclusions, "app/build.gradle.kts"), `configurations.all { resolutionStrategy {
${exclusions().split("\n").map((line) => `// ${line}`).join("\n")}
} }
dependencies { }
`);
  check("commented-out Compose exclusions do not satisfy any required exclusion", () => {
    assertAllComposeExclusionsMissing(projectconfig.auditProjectConfig(commentedExclusions));
  });

  const defaultModuleScope = project(); dirs.push(defaultModuleScope);
  writeFileSync(path.join(defaultModuleScope, "app/build.gradle.kts"), "configurations.all { resolutionStrategy { } }\ndependencies { }\n");
  mkdirSync(path.join(defaultModuleScope, "feature"), { recursive: true });
  writeFileSync(path.join(defaultModuleScope, "feature/build.gradle.kts"), `configurations.all { resolutionStrategy {
${exclusions()}
} }
`);
  check("exclusions in an unrelated module do not satisfy the default app module", () => {
    assertAllComposeExclusionsMissing(projectconfig.auditProjectConfig(defaultModuleScope));
  });

  const rootSubprojectsScope = project(); dirs.push(rootSubprojectsScope);
  writeFileSync(path.join(rootSubprojectsScope, "app/build.gradle.kts"), "configurations.all { resolutionStrategy { } }\ndependencies { }\n");
  writeFileSync(path.join(rootSubprojectsScope, "build.gradle.kts"), `subprojects {
  configurations.all { resolutionStrategy {
${exclusions()}
  } }
}
`);
  check("root subprojects exclusions apply to the selected app module", () => {
    assert.equal(missingComposeExclusions(projectconfig.auditProjectConfig(rootSubprojectsScope)).length, 0);
  });

  const rootSubprojectsDependency = project(); dirs.push(rootSubprojectsDependency);
  writeFileSync(path.join(rootSubprojectsDependency, "build.gradle.kts"), `subprojects {
  dependencies { implementation("androidx.compose.ui:ui:1.7.0") }
}
`);
  check("a forbidden dependency in root subprojects configuration applies to app", () => {
    assert(projectconfig.auditProjectConfig(rootSubprojectsDependency).static.errors.some((x) => x.code === "forbidden-compose-direct"));
  });

  const rootOtherProjectScope = project(); dirs.push(rootOtherProjectScope);
  writeFileSync(path.join(rootOtherProjectScope, "app/build.gradle.kts"), "configurations.all { resolutionStrategy { } }\ndependencies { }\n");
  writeFileSync(path.join(rootOtherProjectScope, "build.gradle.kts"), `project(":feature") {
  configurations.all { resolutionStrategy {
${exclusions()}
  } }
}
`);
  check("root configuration for another project does not satisfy app", () => {
    assertAllComposeExclusionsMissing(projectconfig.auditProjectConfig(rootOtherProjectScope));
  });

  const rootOnlyDependency = project(); dirs.push(rootOnlyDependency);
  writeFileSync(path.join(rootOnlyDependency, "build.gradle.kts"), 'dependencies { implementation("androidx.compose.ui:ui:1.7.0") }\n');
  check("a dependency belonging only to the root project is not attributed to app", () => {
    assert(!projectconfig.auditProjectConfig(rootOnlyDependency).static.errors.some((x) => x.code === "forbidden-compose-direct"));
  });

  const selectedModuleScope = project(); dirs.push(selectedModuleScope);
  mkdirSync(path.join(selectedModuleScope, "feature"), { recursive: true });
  writeFileSync(path.join(selectedModuleScope, "feature/build.gradle.kts"), "configurations.all { resolutionStrategy { } }\n");
  await asyncCheck("exclusions in app do not satisfy an explicitly selected module", async () => {
    const out = await projectconfig.verifyGradleConfig({ projectDir: selectedModuleScope, module: "feature", resolveTransitives: false });
    assertAllComposeExclusionsMissing(out);
  });

  const direct = project({ dependency: 'implementation("androidx.compose.ui:ui:1.7.0")' }); dirs.push(direct);
  check("direct forbidden Compose dependency is an error", () => assert(projectconfig.auditProjectConfig(direct).static.errors.some((x) => /direct dependency/.test(x.message))));
  const allowedPrefixNeighbor = project({ dependency: 'implementation("androidx.compose.ui:ui-tooling:1.7.0")' }); dirs.push(allowedPrefixNeighbor);
  check("ui-tooling is not mistaken for the forbidden ui coordinate", () => {
    assert(!projectconfig.auditProjectConfig(allowedPrefixNeighbor).static.errors.some((x) => x.code === "forbidden-compose-direct"));
  });

  const stageWindow = project({ family: "stage", rootKind: "window" }); dirs.push(stageWindow);
  check("Stage metadata with WindowContainer root is an error", () => assert(projectconfig.auditProjectConfig(stageWindow).static.errors.some((x) => /Stage metadata.*WindowContainer/.test(x.message))));
  const windowStage = project({ family: "windowcontainer", rootKind: "stage" }); dirs.push(windowStage);
  check("WindowContainer metadata with Stage root is an error", () => assert(projectconfig.auditProjectConfig(windowStage).static.errors.some((x) => /WindowContainer metadata.*Stage/.test(x.message))));
  const matchingWindow = project({ family: "windowcontainer", rootKind: "window" }); dirs.push(matchingWindow);
  check("matching WindowContainer family passes", () => assert.equal(projectconfig.auditProjectConfig(matchingWindow).static.errors.length, 0));
  const ambiguous = project({ duplicateRoot: true }); dirs.push(ambiguous);
  check("multiple roots are warning ambiguity, not an invented error", () => assert(projectconfig.auditProjectConfig(ambiguous).static.warnings.some((x) => /multiple roots/i.test(x.message))));

  const mismatchNoiseCases = [
    ["an unused import", (dir) => writeFileSync(path.join(dir, "app/src/main/java/com/example/Noise.kt"), "import com.pico.spatial.ui.foundation.dsl.DefaultStage\n")],
    ["a comment", (dir) => writeFileSync(path.join(dir, "app/src/main/java/com/example/Noise.kt"), "// DefaultStage { this is not an application root }\n")],
    ["a test-only root", (dir) => {
      mkdirSync(path.join(dir, "app/src/test/java/com/example"), { recursive: true });
      writeFileSync(path.join(dir, "app/src/test/java/com/example/StageTest.kt"), "fun testFixture() { DefaultStage { } }\n");
    }],
    ["an unrelated module root", (dir) => {
      mkdirSync(path.join(dir, "feature/src/main/java/com/example"), { recursive: true });
      writeFileSync(path.join(dir, "feature/src/main/java/com/example/FeatureMain.kt"), "fun featureRoot() { DefaultStage { } }\n");
    }],
  ];
  for (const [label, addNoise] of mismatchNoiseCases) {
    const dir = project({ family: "stage", rootKind: "window" }); dirs.push(dir);
    addNoise(dir);
    check(`${label} does not suppress a genuine metadata/root mismatch`, () => {
      assert(projectconfig.auditProjectConfig(dir).static.errors.some((x) => x.code === "container-mode-mismatch"));
    });
  }

  const productionHelperRoot = project({ family: "stage", rootKind: "window" }); dirs.push(productionHelperRoot);
  writeFileSync(
    path.join(productionHelperRoot, "app/src/main/java/com/example/Noise.kt"),
    "fun helperPreview() { DefaultStage { } }\n",
  );
  check("a production helper container cannot disguise the actual mainApp mismatch", () => {
    const out = projectconfig.auditProjectConfig(productionHelperRoot);
    assert(out.static.errors.some((x) => x.code === "container-mode-mismatch"));
    assert(!out.static.warnings.some((x) => x.code === "duplicate-container-roots"));
  });

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

  const canonicalModule = project(); dirs.push(canonicalModule);
  mkdirSync(path.join(canonicalModule, "feature/src/main/java/com/example"), { recursive: true });
  mkdirSync(path.join(canonicalModule, "feature/src/main"), { recursive: true });
  writeFileSync(path.join(canonicalModule, "feature/build.gradle.kts"), `configurations.all { resolutionStrategy {
${exclusions()}
} }
`);
  writeFileSync(path.join(canonicalModule, "feature/src/main/AndroidManifest.xml"), manifest("stage"));
  writeFileSync(path.join(canonicalModule, "feature/src/main/java/com/example/Main.kt"), root("stage"));
  const canonicalArgs = path.join(canonicalModule, "gradle-args.txt");
  const canonicalWrapper = path.join(canonicalModule, "gradlew");
  writeFileSync(canonicalWrapper, `#!/bin/sh
printf '%s\\n' "$@" > "${canonicalArgs}"
`); chmodSync(canonicalWrapper, 0o755);
  await asyncCheck("a canonical :module input produces exactly one Gradle path separator", async () => {
    const out = await projectconfig.verifyGradleConfig({ projectDir: canonicalModule, module: ":feature", resolveTransitives: true, timeoutMs: 2_000 });
    assert.equal(out.resolved.status, "ok");
    assert.deepEqual(readFileSync(canonicalArgs, "utf8").trim().split("\n"), [
      ":feature:dependencies", "--configuration", "debugRuntimeClasspath", "--console=plain",
    ]);
  });
  await asyncCheck("an invalid module path never executes the Gradle wrapper", async () => {
    writeFileSync(canonicalArgs, "");
    const out = await projectconfig.verifyGradleConfig({ projectDir: canonicalModule, module: "feature::nested", resolveTransitives: true, timeoutMs: 2_000 });
    assert.equal(out.resolved.status, "unavailable");
    assert.equal(readFileSync(canonicalArgs, "utf8"), "");
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
    assert.equal(matrix.observed.bom, "6.0.0");
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
  check("BUILD_MATRIX named rows exactly bind ordered fields and source links", () => {
    const doc = readFileSync(new URL("../docs/BUILD_MATRIX.md", import.meta.url), "utf8");
    const rows = buildmatrix.buildMatrixMarkdownRows(matrix);
    let cursor = -1;
    for (const row of rows) {
      const next = doc.indexOf(row);
      assert(next > cursor, `missing or out-of-order canonical row: ${row}`);
      cursor = next;
    }
  });
  check("spatialToolsVersion is exactly not-declared", () => assert.equal(matrix.observed.spatialToolsVersion.status, "not-declared"));
  await asyncCheck("build_matrix_report describes the PICO Spatial BOM field it actually returns", async () => {
    let registration;
    buildmatrix.registerBuildMatrixTools({
      registerTool(name, metadata, handler) { registration = { name, metadata, handler }; },
    });
    assert.equal(registration.name, "build_matrix_report");
    assert.match(registration.metadata.description, /PICO Spatial BOM/);
    assert.doesNotMatch(registration.metadata.description, /Compose BOM/);
    const response = await registration.handler({});
    const returned = JSON.parse(response.content[0].text);
    for (const [label, field] of [
      ["SDK", "compileSdk"], ["Java", "javaTarget"], ["AGP", "agp"], ["Kotlin", "kotlin"],
      ["PICO Spatial BOM", "bom"], ["ABI", "abi"], ["spatial-tools", "spatialToolsVersion"],
    ]) {
      assert.match(registration.metadata.description, new RegExp(label, "i"));
      assert(Object.hasOwn(returned.observed, field), `description names ${label} but response omits observed.${field}`);
    }
    assert.equal(returned.observed.bom, matrix.observed.bom);
  });

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
