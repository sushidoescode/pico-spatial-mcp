// v29.3 projectgen: the packaged-skeleton generator that replaced the machine-local template clone.
// Every assertion here is a way the tester build lane died or could die again:
//  - a canary missing from appskeleton/  -> tarball installs cannot scaffold (the original blocker)
//  - regex-incompatible strings.xml/manifest shapes -> every downstream rebrand silently breaks
//  - editor-asset sneaking back into gradle files -> resurrects the 420MB machine-local dependency
//  - a non-executable gradlew or missing wrapper jar -> build dies at ./gradlew
//  - a toolchain change rewriting the project's BOM -> the app silently builds against another SDK
// Run: npm run test:projectgen
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };

const { generateSpatialProject, verifySkeleton, SKELETON_ROOT, SKELETON_PACKAGE, SKELETON_CANARIES, MENU_BUNDLE_ASSET } =
  await import("../dist/projectgen.js");
const { readProjectSdkIdentity } = await import("../dist/projectidentity.js");
const { parseJavaProperties, serializeJavaProperty } = await import("../dist/toolchainselection.js");
const { applyToolsDirProperty } = await import("../dist/scaffold.js");

// A literal, valid SelectedToolchain (Task S1's shape). Generation must write THIS root into
// local.properties and report THIS selection back — and must not touch the project's BOM to do it.
const selected61 = {
  status: "ok",
  root: "/opt/pico/sdk",
  rootSource: "explicit",
  version: "6.1",
  reason: "explicit",
  files: { packer: { path: "/opt/pico/sdk/6.1/editor/spatialbundle/spatialbundle", sha256: "11".repeat(32) } },
  identity: "22".repeat(32),
};
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const SKELETON_CATALOG = path.join(SKELETON_ROOT, "gradle/libs.versions.toml");

// ---- payload integrity ----
const skel = verifySkeleton();
skel.ok ? ok(`skeleton payload complete (${SKELETON_CANARIES.length} canaries at ${SKELETON_ROOT})`)
        : fail(`skeleton payload missing: ${skel.missing.join(", ")}`);

fs.existsSync(MENU_BUNDLE_ASSET) && fs.statSync(MENU_BUNDLE_ASSET).size >= 45_000
  ? ok(`menu.bundle ships (${fs.statSync(MENU_BUNDLE_ASSET).size} bytes)`)
  : fail(`menu.bundle missing or truncated at ${MENU_BUNDLE_ASSET}`);

// The skeleton must never re-grow the machine-local module or ship a local.properties.
for (const [rel, needle] of [["settings.gradle.kts", "editor-asset"], ["app/build.gradle.kts", "editor-asset"]]) {
  const s = fs.readFileSync(path.join(SKELETON_ROOT, rel), "utf8");
  s.includes(needle) ? fail(`${rel} references ${needle} — the dropped module is creeping back`) : ok(`${rel} carries no ${needle} reference`);
}
fs.existsSync(path.join(SKELETON_ROOT, "local.properties"))
  ? fail("skeleton ships a local.properties — machine-specific by definition, must be generated")
  : ok("skeleton ships no local.properties");
// npm pack silently drops files named .gitignore; the payload must store them dot-less.
fs.existsSync(path.join(SKELETON_ROOT, "_gitignore")) && !fs.existsSync(path.join(SKELETON_ROOT, ".gitignore"))
  ? ok("gitignores stored dot-less (_gitignore) so npm pack cannot drop them")
  : fail("skeleton gitignore storage wrong: need _gitignore, not .gitignore (npm pack drops dotfile gitignores)");

// v32 MR default: the raw skeleton bakes stage.style "1" (Mixed) so an un-substituted skeleton
// matches the product default, in the exact shape the substitution regex rewrites (the "3" opt-in
// substitution is asserted on a generated project below).
const skelManifest = fs.readFileSync(path.join(SKELETON_ROOT, "app/src/main/AndroidManifest.xml"), "utf8");
/(pico\.spatial\.stage\.style"\s*\n?\s*android:value=")1(")/.test(skelManifest)
  ? ok("skeleton bakes stage.style 1 (Mixed — the MR default) in the regex-substitutable shape")
  : fail("skeleton manifest must bake stage.style 1 (Mixed default) in the regex-rewritable shape");

// Load-bearing gradle facts (handoff-verified): Compose excludes + .bundle noCompress + arm64 + SDK 35.
const appGradle = fs.readFileSync(path.join(SKELETON_ROOT, "app/build.gradle.kts"), "utf8");
for (const needle of ['exclude("androidx.compose.ui", "ui")', 'noCompress += listOf(".bundle")', 'abiFilters.add("arm64-v8a")', "compileSdk = 35"]) {
  appGradle.includes(needle) ? ok(`app gradle keeps load-bearing line: ${needle}`) : fail(`app gradle LOST load-bearing line: ${needle}`);
}
const settings = fs.readFileSync(path.join(SKELETON_ROOT, "settings.gradle.kts"), "utf8");
(settings.match(/artifact\.bytedance\.com\/repository\/Volcengine/g) ?? []).length === 2
  ? ok("both ByteDance Maven repos present (pluginManagement + dependencyResolutionManagement)")
  : fail("settings.gradle.kts must cite the ByteDance Maven repo in BOTH repo blocks — PICO SDK will not resolve otherwise");

// The generator is a file copier, not a build. Nothing in it may shell out — a generator that
// runs Gradle to learn a version would make scaffolding depend on a resolvable network.
const projectgenSource = fs.readFileSync(path.join(SKELETON_ROOT, "..", "src/projectgen.ts"), "utf8")
  .split("\n").filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("/*")).join("\n");
// ("gradlew" itself appears here as a file the generator COPIES and chmods, never as one it runs.)
for (const banned of ["child_process", "execFile", "execSync", "spawn(", "spawnSync", "sdk-facts", "./gradlew"]) {
  projectgenSource.includes(banned)
    ? fail(`src/projectgen.ts must not reference ${banned} — generation never runs Gradle or any other process`)
    : ok(`src/projectgen.ts spawns nothing (${banned})`);
}

// ---- generation, in a hostile path (space + non-ASCII, same rationale as verify-tarball [M6]) ----
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "projectgen é "));
try {
  const dst = path.join(sandbox, "hello-native");
  const r = generateSpatialProject({ targetDir: dst, packageName: "com.test.hello", appName: "Hello & Co", stageStyle: "3", toolchain: selected61 });
  r.filesWritten >= 46 ? ok(`generated ${r.filesWritten} files`) : fail(`only ${r.filesWritten} files generated`);

  // structure
  const mustExist = [
    "settings.gradle.kts", "gradlew", "gradle/wrapper/gradle-wrapper.jar", ".gitignore", "app/.gitignore",
    "local.properties", "app/src/main/AndroidManifest.xml",
    "app/src/main/java/com/test/hello/Main.kt",
    "app/src/main/java/com/test/hello/content/HomeStage.kt",
    "app/src/main/java/com/test/hello/platform/LaunchActivity.kt",
    "app/src/main/java/com/test/hello/agent/AgentBridgeInitProvider.kt",
    "app/src/main/res/drawable/icon_3d_layer_0.png",
    "app/src/main/res/mipmap-xxxhdpi/ic_spatial_launcher.png",
  ];
  for (const relPath of mustExist) {
    fs.existsSync(path.join(dst, relPath)) ? ok(`emits ${relPath}`) : fail(`MISSING in generated project: ${relPath}`);
  }
  (fs.statSync(path.join(dst, "gradlew")).mode & 0o111) ? ok("gradlew is executable") : fail("gradlew lost its exec bit");
  fs.statSync(path.join(dst, "gradle/wrapper/gradle-wrapper.jar")).size >= 40_000
    ? ok("wrapper jar intact") : fail("wrapper jar truncated");

  // no residue of the skeleton package or old branding anywhere
  const residue = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if ([".kt", ".kts", ".xml", ".toml", ".properties", ".pro", ".json", ".md"].includes(path.extname(e.name))) {
        const s = fs.readFileSync(p, "utf8");
        for (const bad of [SKELETON_PACKAGE, "galleryxr", "claimsight"]) if (s.includes(bad)) residue.push(`${path.relative(dst, p)}: ${bad}`);
      }
    }
  })(dst);
  residue.length ? fail(`package residue: ${residue.slice(0, 4).join("; ")}`) : ok("no skeleton-package/branding residue in any text file");

  // substitutions land AND keep the regex-rewritable shapes the rest of the toolchain depends on
  const strings = fs.readFileSync(path.join(dst, "app/src/main/res/values/strings.xml"), "utf8");
  strings.includes("<string name=\"app_name\">Hello &amp; Co</string>")
    ? ok("app_name set + XML-escaped") : fail(`app_name wrong: ${strings}`);
  /(<string name="app_name">)[^<]*(<\/string>)/.test(strings) && /(<string name="homepage_title">)[^<]*(<\/string>)/.test(strings)
    ? ok("strings.xml keeps the scaffold-rewritable shape") : fail("strings.xml shape no longer matches the rebrand regexes");
  const manifest = fs.readFileSync(path.join(dst, "app/src/main/AndroidManifest.xml"), "utf8");
  /(pico\.spatial\.stage\.style"\s*\n?\s*android:value=")3(")/.test(manifest)
    ? ok("stage.style substituted to 3 (the Full opt-in flips the baked Mixed default) in the regex-compatible shape")
    : fail("manifest stage.style wrong or shape drifted");
  manifest.includes("${applicationId}.agentbridge") ? ok("AgentBridgeInitProvider provider entry survives") : fail("agent bridge provider entry lost");
  const lp = fs.readFileSync(path.join(dst, "local.properties"), "utf8");
  /spatial\.tools\.dir=/.test(lp) ? ok("local.properties generated with spatial.tools.dir") : fail(`local.properties missing spatial.tools.dir: ${lp}`);
  const settingsOut = fs.readFileSync(path.join(dst, "settings.gradle.kts"), "utf8");
  settingsOut.includes('rootProject.name = "hello-native"') ? ok("rootProject.name set from target dir") : fail("rootProject.name not set");

  // the default HomeStage must stay bundle-free: a fresh project renders with zero external assets
  const hs = fs.readFileSync(path.join(dst, "app/src/main/java/com/test/hello/content/HomeStage.kt"), "utf8");
  !hs.includes("AssetBundle.load") ? ok("default HomeStage loads no asset bundles") : fail("default HomeStage regressed to loading a bundle");

  // guardrails
  let threw = false;
  try { generateSpatialProject({ targetDir: dst, packageName: "com.test.hello", appName: "X", stageStyle: "3", toolchain: selected61 }); } catch { threw = true; }
  threw ? ok("refuses an existing targetDir") : fail("overwrote an existing targetDir");
  threw = false;
  try { generateSpatialProject({ targetDir: path.join(sandbox, "bad"), packageName: "NotAPackage", appName: "X", stageStyle: "3", toolchain: selected61 }); } catch { threw = true; }
  threw ? ok("rejects an invalid package name") : fail("accepted an invalid package name");

  // determinism: two runs, identical trees (local.properties included — machine-derived but stable)
  const dst2 = path.join(sandbox, "hello2-native");
  generateSpatialProject({ targetDir: dst2, packageName: "com.test.hello", appName: "Hello & Co", stageStyle: "3", rootProjectName: "hello-native", toolchain: selected61 });
  const list = (root) => {
    const outFiles = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else outFiles.push(path.relative(root, p));
      }
    })(root);
    return outFiles.sort();
  };
  const a = list(dst).filter((f) => !f.endsWith("pico-bridge.sh") && !f.endsWith("redeploy.sh"));
  const b = list(dst2).filter((f) => !f.endsWith("pico-bridge.sh") && !f.endsWith("redeploy.sh"));
  JSON.stringify(a) === JSON.stringify(b) ? ok(`deterministic file list (${a.length} files)`) : fail("two generations produced different file lists");
  const diff = a.filter((f) => !fs.readFileSync(path.join(dst, f)).equals(fs.readFileSync(path.join(dst2, f))));
  diff.length === 0 ? ok("deterministic bytes across runs") : fail(`nondeterministic content: ${diff.slice(0, 5).join(", ")}`);

  // ---- Task S3: the toolchain selection is recorded; the project's BOM is not touched ----

  // The explicit selection is used AS-IS: its root is what lands in local.properties, and the
  // whole selection comes back in the result so a caller can say which tools it generated against.
  const lp1 = fs.readFileSync(path.join(dst, "local.properties"), "utf8");
  const props1 = parseJavaProperties(lp1);
  (props1.find((e) => e.key === "spatial.tools.dir")?.value === selected61.root)
    ? ok("local.properties carries the supplied selection's root verbatim")
    : fail(`spatial.tools.dir is not the supplied root: ${lp1}`);
  JSON.stringify(r.toolchain) === JSON.stringify(selected61)
    ? ok("GenerateResult returns the exact selection it generated against")
    : fail(`GenerateResult.toolchain drifted: ${JSON.stringify(r.toolchain)}`);
  (r.templateBom && r.templateBom.declaredBom === "6.0.0" && r.templateBom.catalogSha256 === sha256(fs.readFileSync(SKELETON_CATALOG)))
    ? ok("GenerateResult reports the template BOM and the copied catalog's hash")
    : fail(`templateBom wrong: ${JSON.stringify(r.templateBom)}`);

  // Java Properties escaping: a root with spaces, a Windows drive letter, backslashes, a '#' and a
  // non-ASCII character must survive a round trip through the parser Gradle's Properties.load mirrors.
  const hostileRoots = [
    "C:\\Program Files\\PICO\\sdk",
    "/Volumes/Team Drive/PICO #1/sdk",
    "/Users/té st/Library/PICO/sdk",
    "\\\\build\\share\\pico=tools",
  ];
  let escapedOk = 0;
  for (const [i, hostileRoot] of hostileRoots.entries()) {
    const hostileDst = path.join(sandbox, `escaping-${i}`);
    generateSpatialProject({
      targetDir: hostileDst,
      packageName: "com.test.hello",
      appName: "Hello & Co",
      stageStyle: "3",
      toolchain: { ...selected61, root: hostileRoot },
    });
    const raw = fs.readFileSync(path.join(hostileDst, "local.properties"), "utf8");
    const value = parseJavaProperties(raw).find((e) => e.key === "spatial.tools.dir")?.value;
    const expected = hostileRoot.split(path.sep).join("/");
    if (value === expected && raw.split("\n").filter((l) => l.startsWith("spatial.tools.dir")).length === 1) escapedOk += 1;
    else fail(`local.properties does not round-trip ${JSON.stringify(hostileRoot)}: value=${JSON.stringify(value)} raw=${JSON.stringify(raw)}`);
  }
  escapedOk === hostileRoots.length ? ok(`local.properties round-trips ${escapedOk} hostile tool roots (spaces, drive letters, '#', non-ASCII)`) : null;
  serializeJavaProperty("a b:c=d#e!f\\g", " lead\ttab é") === "a\\ b\\:c\\=d\\#e\\!f\\\\g=\\ lead\\ttab \\u00e9"
    ? ok("serializeJavaProperty escapes keys and values per Properties.store")
    : fail(`serializeJavaProperty wrong: ${JSON.stringify(serializeJavaProperty("a b:c=d#e!f\\g", " lead\ttab é"))}`);

  // The serializer is only useful if it is the exact inverse of the parser Gradle mirrors.
  const roundTrips = [
    ["spatial.tools.dir", "C:\\Program Files\\PICO\\sdk"],
    ["spatial.tools.dir", "/Volumes/Team Drive/PICO #1/sdk"],
    ["spatial.tools.dir", " /leading/space"],
    ["spatial.tools.dir", "/trailing/backslash\\"],
    ["spatial.tools.dir", "/ünïcode/路径/sdk"],
    ["spatial.tools.dir", "/has=equals:and!bang#hash"],
    ["key with space", "value"],
    ["key:with=separators", "a\tb\nc"],
    ["", ""],
  ];
  let tripped = 0;
  for (const [key, value] of roundTrips) {
    const line = serializeJavaProperty(key, value);
    const parsed = parseJavaProperties(line);
    if (line.includes("\n") || parsed.length !== 1 || parsed[0].key !== key || parsed[0].value !== value)
      fail(`serialize/parse round trip lost ${JSON.stringify([key, value])}: line=${JSON.stringify(line)} parsed=${JSON.stringify(parsed)}`);
    else tripped += 1;
  }
  tripped === roundTrips.length ? ok(`serializeJavaProperty round-trips through parseJavaProperties (${tripped} cases)`) : null;

  // An unusable selection must be refused BEFORE the destination exists.
  const rejectDst = path.join(sandbox, "rejected");
  let rejected = false;
  try {
    generateSpatialProject({ targetDir: rejectDst, packageName: "com.test.hello", appName: "X", stageStyle: "3", toolchain: { status: "unavailable", code: "unavailable/component-missing", detail: "no packer" } });
  } catch { rejected = true; }
  (rejected && !fs.existsSync(rejectDst))
    ? ok("an invalid selection is refused before the destination is created")
    : fail(`invalid selection not refused before creating ${rejectDst} (threw=${rejected}, exists=${fs.existsSync(rejectDst)})`);

  // With no selection supplied, generation resolves ONE host selection up front — and a host with
  // no usable toolchain is a structured failure, again before anything is written.
  const savedPicoHome = process.env.PICO_HOME;
  try {
    const emptyRoot = path.join(sandbox, "empty-sdk");
    fs.mkdirSync(emptyRoot, { recursive: true });
    process.env.PICO_HOME = emptyRoot;
    const hostFailDst = path.join(sandbox, "host-fail");
    let hostFailed = null;
    try { generateSpatialProject({ targetDir: hostFailDst, packageName: "com.test.hello", appName: "X", stageStyle: "3" }); }
    catch (e) { hostFailed = e; }
    (hostFailed && !fs.existsSync(hostFailDst) && /unavailable\//.test(hostFailed.message))
      ? ok("an unresolvable host toolchain fails structurally before the destination is created")
      : fail(`host-resolution failure not structural: ${hostFailed?.message} exists=${fs.existsSync(hostFailDst)}`);

    const fakeRoot = path.join(sandbox, "fake-sdk");
    const packer = path.join(fakeRoot, "6.1", "editor", "spatialbundle", "spatialbundle");
    fs.mkdirSync(path.dirname(packer), { recursive: true });
    fs.writeFileSync(packer, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // never executed — presence + x-bit only
    process.env.PICO_HOME = fakeRoot;
    const hostDst = path.join(sandbox, "host-resolved");
    const hostGen = generateSpatialProject({ targetDir: hostDst, packageName: "com.test.hello", appName: "X", stageStyle: "3" });
    const hostValue = parseJavaProperties(fs.readFileSync(path.join(hostDst, "local.properties"), "utf8")).find((e) => e.key === "spatial.tools.dir")?.value;
    (hostGen.toolchain.status === "ok" && hostGen.toolchain.version === "6.1" && hostValue === fakeRoot.split(path.sep).join("/"))
      ? ok("with no selection supplied, generation resolves the host toolchain once and writes that root")
      : fail(`host resolution wrong: ${JSON.stringify(hostGen.toolchain)} value=${hostValue}`);
  } finally {
    if (savedPicoHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = savedPicoHome;
  }

  // Cloning applies the same explicit destination selection and REPORTS the change it made.
  const cloneCases = [
    ["sdk.dir=/x\nspatial.tools.dir=/old/pico/sdk\n", "/old/pico/sdk"],
    ["sdk.dir=/x\n", null],
    ["", null],
    ["sdk.dir=/x\nspatial.tools.dir=C\\:\\\\Old PICO\\\\sdk\n", "C:\\Old PICO\\sdk"],
    // Gradle reads all of these as the same key; a literal-text rewrite leaves duplicates behind.
    ["sdk.dir=/x\nspatial\\.tools\\.dir : /colon/separated\n", "/colon/separated"],
    ["sdk.dir=/x\nspatial.tools.dir /whitespace/separated\n", "/whitespace/separated"],
    ["sdk.dir=/x\nspatial.tools.dir=/continued/\\\n  tail\n", "/continued/tail"],
    ["# spatial.tools.dir=/commented/out\nsdk.dir=/x\n", null],
    ["sdk.dir=/x\nspatial.tools.dir=/a\nspatial.tools.dir=/b\n", null],
    ["sdk.dir=/x\nspatial.tools.dir=/same\nspatial.tools.dir=/same\n", "/same"],
  ];
  let cloneOk = 0;
  for (const [existing, previous] of cloneCases) {
    const applied = applyToolsDirProperty(existing, "/Volumes/New PICO/sdk");
    const parsed = parseJavaProperties(applied.content);
    const toolsValues = parsed.filter((e) => e.key === "spatial.tools.dir").map((e) => e.value);
    if (
      applied.previousToolsDir === previous &&
      applied.appliedToolsDir === "/Volumes/New PICO/sdk" &&
      toolsValues.length === 1 &&
      toolsValues[0] === "/Volumes/New PICO/sdk" &&
      (!existing.includes("sdk.dir=/x") || parsed.some((e) => e.key === "sdk.dir" && e.value === "/x"))
    ) cloneOk += 1;
    else fail(`clone local.properties wrong for ${JSON.stringify(existing)}: ${JSON.stringify(applied)}`);
  }
  cloneOk === cloneCases.length ? ok(`clone reports {previousToolsDir, appliedToolsDir} across ${cloneOk} local.properties shapes and keeps sdk.dir`) : null;

  // The toolchain selection must not reach the project's dependency identity at all: the SAME
  // project generated on a DIFFERENT root against a DIFFERENT toolchain has the same declared
  // BOM and the same fingerprint, and differs only in the canonical root it is reported under.
  const otherDst = path.join(sandbox, "second-root");
  const otherGen = generateSpatialProject({
    targetDir: otherDst,
    packageName: "com.test.hello",
    appName: "Hello & Co",
    stageStyle: "3",
    rootProjectName: "hello-native",
    toolchain: { ...selected61, root: "/opt/other/sdk", version: "6.0", identity: "33".repeat(32) },
  });
  const idA = readProjectSdkIdentity(dst);
  const idB = readProjectSdkIdentity(otherDst);
  (idA.declaredBom === "6.0.0" && idB.declaredBom === "6.0.0" && idA.fingerprint === idB.fingerprint && idA.projectRoot !== idB.projectRoot)
    ? ok("a different toolchain on a different root leaves the declared BOM and fingerprint identical")
    : fail(`cross-root identity drifted: ${JSON.stringify(idA)} vs ${JSON.stringify(idB)}`);
  (otherGen.templateBom.catalogSha256 === r.templateBom.catalogSha256 && otherGen.toolchain.version === "6.0" && r.toolchain.version === "6.1")
    ? ok("two different toolchain selections produce the same catalog bytes")
    : fail("the catalog hash changed with the toolchain selection");
  // ...and a project generated with a *different* package name is a different identity, so the
  // assertion above is not vacuous.
  const renamedDst = path.join(sandbox, "renamed-identity");
  generateSpatialProject({ targetDir: renamedDst, packageName: "com.other.app", appName: "Other", stageStyle: "1", rootProjectName: "hello-native", toolchain: selected61 });
  const idC = readProjectSdkIdentity(renamedDst);
  (idC.fingerprint !== idA.fingerprint && idC.declaredBom === "6.0.0")
    ? ok("a renamed project is a different fingerprint but the same declared BOM")
    : fail(`renaming did not change the fingerprint: ${JSON.stringify(idC)}`);

  // The Task S3 regression, verbatim.
  const before = fs.readFileSync(path.join(SKELETON_ROOT,"gradle/libs.versions.toml"));
  const options = { targetDir: path.join(sandbox, "bom-identity"), packageName: "com.test.hello", appName: "Hello & Co", stageStyle: "3" };
  const generated = generateSpatialProject({...options, toolchain: selected61});
  assert.deepEqual(fs.readFileSync(path.join(generated.created,"gradle/libs.versions.toml")), before);
  assert.equal(readProjectSdkIdentity(generated.created).declaredBom, "6.0.0");
  assert.equal(generated.toolchain.version, "6.1");
  ok("generation preserves the project BOM byte-for-byte while recording the 6.1 selection");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nProjectgen test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
