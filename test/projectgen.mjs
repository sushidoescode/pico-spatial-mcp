// v29.3 projectgen: the packaged-skeleton generator that replaced the machine-local template clone.
// Every assertion here is a way the tester build lane died or could die again:
//  - a canary missing from appskeleton/  -> tarball installs cannot scaffold (the original blocker)
//  - regex-incompatible strings.xml/manifest shapes -> every downstream rebrand silently breaks
//  - editor-asset sneaking back into gradle files -> resurrects the 420MB machine-local dependency
//  - a non-executable gradlew or missing wrapper jar -> build dies at ./gradlew
// Run: npm run test:projectgen
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };

const { generateSpatialProject, verifySkeleton, SKELETON_ROOT, SKELETON_PACKAGE, SKELETON_CANARIES, MENU_BUNDLE_ASSET } =
  await import("../dist/projectgen.js");

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

// Load-bearing gradle facts (handoff-verified): Compose excludes + .bundle noCompress + arm64 + SDK 35.
const appGradle = fs.readFileSync(path.join(SKELETON_ROOT, "app/build.gradle.kts"), "utf8");
for (const needle of ['exclude("androidx.compose.ui", "ui")', 'noCompress += listOf(".bundle")', 'abiFilters.add("arm64-v8a")', "compileSdk = 35"]) {
  appGradle.includes(needle) ? ok(`app gradle keeps load-bearing line: ${needle}`) : fail(`app gradle LOST load-bearing line: ${needle}`);
}
const settings = fs.readFileSync(path.join(SKELETON_ROOT, "settings.gradle.kts"), "utf8");
(settings.match(/artifact\.bytedance\.com\/repository\/Volcengine/g) ?? []).length === 2
  ? ok("both ByteDance Maven repos present (pluginManagement + dependencyResolutionManagement)")
  : fail("settings.gradle.kts must cite the ByteDance Maven repo in BOTH repo blocks — PICO SDK will not resolve otherwise");

// ---- generation, in a hostile path (space + non-ASCII, same rationale as verify-tarball [M6]) ----
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "projectgen é "));
try {
  const dst = path.join(sandbox, "hello-native");
  const r = generateSpatialProject({ targetDir: dst, packageName: "com.test.hello", appName: "Hello & Co", stageStyle: "3" });
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
    ? ok("stage.style set to 3 in the regex-compatible shape") : fail("manifest stage.style wrong or shape drifted");
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
  try { generateSpatialProject({ targetDir: dst, packageName: "com.test.hello", appName: "X", stageStyle: "3" }); } catch { threw = true; }
  threw ? ok("refuses an existing targetDir") : fail("overwrote an existing targetDir");
  threw = false;
  try { generateSpatialProject({ targetDir: path.join(sandbox, "bad"), packageName: "NotAPackage", appName: "X", stageStyle: "3" }); } catch { threw = true; }
  threw ? ok("rejects an invalid package name") : fail("accepted an invalid package name");

  // determinism: two runs, identical trees (local.properties included — machine-derived but stable)
  const dst2 = path.join(sandbox, "hello2-native");
  generateSpatialProject({ targetDir: dst2, packageName: "com.test.hello", appName: "Hello & Co", stageStyle: "3", rootProjectName: "hello-native" });
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
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nProjectgen test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
