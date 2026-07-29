// v30 unity lane: the packaged Unity skeleton + generator. Canary tier runs without Unity.
// Guards: payload completeness/non-emptiness, no machine-local leaks, windowed default has NO XR
// dep, the immersive overlay stays out of the base tree, _gitignore stored dot-less (npm pack
// drops .gitignore files), and the build entrypoint/log contracts the E2E greps for.
// Run: npm run test:unitygen
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SK = path.join(repo, "unityskeleton");

const CANARIES = [
  "Packages/manifest.json",
  "ProjectSettings/ProjectVersion.txt",
  "Assets/PicoAgent/picoagent-config.json",
  "Assets/PicoAgent/PicoAgentBridge.cs",
  "Assets/PicoAgent/SpatialAdapterSlot.cs",
  "Assets/Scripts/HelloSpatialRuntime.cs",
  "Assets/Plugins/Android/PicoDebugCmdReceiver.java",
  "Assets/Editor/PicoBuild.cs",
  "_immersive/Assets/Editor/PicoXrSetup.cs",
  "_immersive/Assets/Editor/ControllerlessManifestPatch.cs",
  "_gitignore",
];
for (const c of CANARIES) {
  const p = path.join(SK, c);
  fs.existsSync(p) && fs.statSync(p).size > 0 ? ok(`payload: ${c}`) : fail(`payload missing/empty: ${c}`);
}
if (failures === 0) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SK, "Packages/manifest.json"), "utf8"));
  manifest.dependencies["com.unity.ugui"] === "2.0.0"
    ? ok("ugui 2.0.0 declared (settling-test gotcha)") : fail("ugui dependency missing");
  !Object.keys(manifest.dependencies).some((k) => k.includes("openxr"))
    ? ok("windowed base has NO XR dependency") : fail("XR dep leaked into the windowed base manifest");
  /m_EditorVersion: 6000\.4\.9f1/.test(fs.readFileSync(path.join(SK, "ProjectSettings/ProjectVersion.txt"), "utf8"))
    ? ok("editor pinned 6000.4.9f1") : fail("ProjectVersion pin wrong");
  const buildCs = fs.readFileSync(path.join(SK, "Assets/Editor/PicoBuild.cs"), "utf8");
  buildCs.includes("public static void Apk()") ? ok("PicoBuild.Apk entrypoint present") : fail("PicoBuild.Apk missing");
  buildCs.includes("build-result.json") ? ok("build writes build-result.json") : fail("structured build result missing");
  !/using\s+UnityEngine\.XR|using\s+UnityEditor\.XR/.test(buildCs)
    ? ok("PicoBuild has no compile-time XR references (windowed-safe)") : fail("PicoBuild references XR types — breaks windowed compile");
  const bridge = fs.readFileSync(path.join(SK, "Assets/PicoAgent/PicoAgentBridge.cs"), "utf8");
  bridge.includes('"PicoAgentBridge"') && bridge.includes("OnDebugCmd")
    ? ok("bridge GameObject/UnitySendMessage contract") : fail("bridge contract drifted");
  const javaSrc = fs.readFileSync(path.join(SK, "Assets/Plugins/Android/PicoDebugCmdReceiver.java"), "utf8");
  javaSrc.includes(".DEBUG_CMD") && javaSrc.includes("RECEIVER_EXPORTED") && javaSrc.includes("UnitySendMessage")
    ? ok("java shim: DEBUG_CMD + exported + UnitySendMessage") : fail("java shim contract drifted");
  const leaks = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\/Users\/[A-Za-z0-9._-]+|AndroidStudioProjects/.test(fs.readFileSync(p, "utf8"))) leaks.push(path.relative(SK, p));
    }
  })(SK);
  leaks.length === 0 ? ok("no machine-local strings in the payload") : fail(`machine-local leak: ${leaks.join(", ")}`);
  fs.existsSync(path.join(SK, ".gitignore"))
    ? fail("payload carries a dotted .gitignore — npm pack drops it; store _gitignore") : ok("gitignore stored dot-less");
}

// ── generation tier: generateUnityProject over the payload (still no Unity needed) ──────────────
{
  const os = await import("node:os");
  const { generateUnityProject, verifyUnitySkeleton, UNITY_SKELETON_CANARIES } = await import("../dist/unitygen.js");
  verifyUnitySkeleton().ok ? ok(`verifyUnitySkeleton ok (${UNITY_SKELETON_CANARIES.length} canaries)`) : fail("verifyUnitySkeleton not ok");
  const sandbox = fs.mkdtempSync(path.join(os.default.tmpdir(), "unitygen é "));
  try {
    const dst = path.join(sandbox, "hello-unity");
    const r = generateUnityProject({ targetDir: dst, packageName: "com.test.unityhello", productName: "UnityHello" });
    r.mode === "windowed" ? ok("default mode windowed") : fail(`default mode ${r.mode}`);
    r.buildEntry === "PicoBuild.Apk" ? ok("buildEntry contract") : fail(`buildEntry ${r.buildEntry}`);
    const cfg = JSON.parse(fs.readFileSync(path.join(dst, "Assets/PicoAgent/picoagent-config.json"), "utf8"));
    cfg.packageName === "com.test.unityhello" && cfg.productName === "UnityHello" && cfg.immersive === false
      ? ok("config substituted") : fail(`config wrong: ${JSON.stringify(cfg)}`);
    const m = JSON.parse(fs.readFileSync(path.join(dst, "Packages/manifest.json"), "utf8"));
    !Object.keys(m.dependencies).some((k) => k.includes("openxr")) ? ok("windowed scaffold has no XR dep") : fail("XR dep in windowed scaffold");
    fs.existsSync(path.join(dst, ".gitignore")) ? ok("emits .gitignore from _gitignore") : fail(".gitignore missing");
    !fs.existsSync(path.join(dst, "_immersive")) && !fs.existsSync(path.join(dst, "Assets/Editor/PicoXrSetup.cs"))
      ? ok("no immersive overlay in windowed scaffold") : fail("immersive overlay leaked into windowed scaffold");

    const dst2 = path.join(sandbox, "hello-immersive");
    generateUnityProject({ targetDir: dst2, packageName: "com.test.unityimm", productName: "UnityImm", immersive: true });
    const m2 = JSON.parse(fs.readFileSync(path.join(dst2, "Packages/manifest.json"), "utf8"));
    m2.dependencies["com.unity.xr.openxr.picoxr"] ===
      "https://github.com/Pico-Developer/PICO-Unity-OpenXR-SDK.git#3aa3e62bff41df618529eeb60ff02c29a515dafe"
      ? ok("immersive adds the pinned XR git dep verbatim") : fail("immersive XR dep wrong");
    fs.existsSync(path.join(dst2, "Assets/Editor/PicoXrSetup.cs")) && fs.existsSync(path.join(dst2, "Assets/Editor/ControllerlessManifestPatch.cs"))
      ? ok("immersive overlay files land in Assets/Editor") : fail("immersive overlay not applied");
    JSON.parse(fs.readFileSync(path.join(dst2, "Assets/PicoAgent/picoagent-config.json"), "utf8")).immersive === true
      ? ok("immersive flag lands in config") : fail("immersive flag missing from config");

    const dst3 = path.join(sandbox, "hello-adapter");
    generateUnityProject({ targetDir: dst3, packageName: "com.test.unityad", productName: "UnityAd",
      spatialAdapter: { registry: { name: "PICO", url: "https://example.invalid/upm", scopes: ["com.pico"] },
        dependencies: { "com.pico.spatial.unity": "0.1.0" } } });
    const m3 = JSON.parse(fs.readFileSync(path.join(dst3, "Packages/manifest.json"), "utf8"));
    m3.scopedRegistries?.[0]?.url === "https://example.invalid/upm" ? ok("adapter registry injected") : fail("adapter registry missing");
    m3.dependencies["com.pico.spatial.unity"] === "0.1.0" ? ok("adapter dependency injected") : fail("adapter dep missing");
    JSON.parse(fs.readFileSync(path.join(dst3, "Assets/PicoAgent/picoagent-config.json"), "utf8")).extraDefines.includes("PICO_SPATIAL_ADAPTER")
      ? ok("adapter define lands in config extraDefines") : fail("adapter define missing");

    let threw = false;
    try { generateUnityProject({ targetDir: dst, packageName: "com.test.unityhello", productName: "X" }); } catch { threw = true; }
    threw ? ok("refuses existing targetDir") : fail("overwrote existing targetDir");
    threw = false;
    try { generateUnityProject({ targetDir: path.join(sandbox, "bad"), packageName: "NotAPackage", productName: "X" }); } catch { threw = true; }
    threw ? ok("rejects invalid packageName") : fail("accepted invalid packageName");

    const dstA = path.join(sandbox, "det-a"), dstB = path.join(sandbox, "det-b");
    generateUnityProject({ targetDir: dstA, packageName: "com.test.det", productName: "Det" });
    generateUnityProject({ targetDir: dstB, packageName: "com.test.det", productName: "Det" });
    const list = (root) => { const out = []; (function w(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p = path.join(d,e.name); e.isDirectory()? w(p): out.push(path.relative(root,p)); } })(root); return out.sort(); };
    const la = list(dstA), lb = list(dstB);
    JSON.stringify(la) === JSON.stringify(lb) && la.every((f) => fs.readFileSync(path.join(dstA,f)).equals(fs.readFileSync(path.join(dstB,f))))
      ? ok(`deterministic (${la.length} files)`) : fail("nondeterministic generation");
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

console.log(`\nUnitygen test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
