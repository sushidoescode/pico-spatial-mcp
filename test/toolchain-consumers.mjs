// Task S2: the doctor and every pack/launch operation run the SAME component-valid selection.
//
// Run: npm run build && node --test test/toolchain-consumers.mjs
//
// Hermetic by construction. Every filesystem observation comes from toolchainIOFromTree (an
// in-memory tree), every command comes from an injected runner that records argv and returns a
// canned RunResult, and every version probe is an injected function. Nothing here spawns a
// process, reads ~/Library/PICO, or touches an emulator — the only host file this suite opens is
// the repository's own src/*.ts, for the fallback-literal scan at the end.

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolchainIOFromTree } from "./helpers/toolchain-fixture.mjs";
import {
  extractReportedVersion,
  isToolchainFailure,
  reportedVersionMatchesPin,
  prepareOperationToolchain,
  resolveOperationToolchain,
  toolchainProvenance,
  toolchainProvenanceLine,
  verifyOperationOverride,
} from "../dist/toolchain.js";
import { packAndInspectScene, resolveSceneToolchain } from "../dist/workflow.js";
import {
  inspectBundleReport,
  packerToolchain,
  resolveSchemaToolchain,
  schemaUsdDir,
} from "../dist/bundle.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const PACKER_A = "/sdk-a/6.0/editor/spatialbundle/spatialbundle";
const PACKER_B = "/sdk-b/6.1/editor/spatialbundle/spatialbundle";

/** Two Android projects pointing at two different SDK roots through their own local.properties. */
function twoProjectTree(extra = {}) {
  return {
    "/work/projA/settings.gradle": { bytes: "rootProject.name = 'a'\n" },
    "/work/projA/local.properties": { bytes: "spatial.tools.dir=/sdk-a\n" },
    [PACKER_A]: { bytes: "packer-six-zero", executable: true },
    "/work/projB/settings.gradle.kts": { bytes: 'rootProject.name = "b"\n' },
    "/work/projB/local.properties": { bytes: "spatial.tools.dir=/sdk-b\n" },
    [PACKER_B]: { bytes: "packer-six-one", executable: true },
    ...extra,
  };
}

/** A runner that records every (bin, args, opts) it is handed and never spawns anything. */
function recordingRunner(result = {}) {
  const calls = [];
  const run = async (bin, args, opts) => {
    calls.push({ bin, args: [...args], opts });
    return { code: 0, stdout: "Model Count: 3\nAsset Count: 7\n", stderr: "", timedOut: false, ...result };
  };
  return { run, calls };
}

function packDeps(toolchain, runner, { exists = () => true, sizeBytes = () => 2 * 1024 * 1024 } = {}) {
  const made = [];
  return {
    deps: { toolchain, run: runner.run, exists, mkdirp: (p) => made.push(p), sizeBytes },
    made,
  };
}

// ------------------------------------------------------------------ per-project selection

test("each Android project selects the packer its own local.properties points at", () => {
  const io = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: twoProjectTree() });

  const a = resolveOperationToolchain({ androidProjectRoot: "/work/projA", required: ["packer"], primary: "packer" }, io);
  const b = resolveOperationToolchain({ androidProjectRoot: "/work/projB", required: ["packer"], primary: "packer" }, io);

  assert.equal(a.bin, PACKER_A);
  assert.equal(a.selection.version, "6.0");
  assert.equal(a.selection.root, "/sdk-a");
  assert.equal(a.selection.rootSource, "local.properties");
  assert.equal(b.bin, PACKER_B);
  assert.equal(b.selection.version, "6.1");
  assert.equal(b.selection.root, "/sdk-b");
  assert.notEqual(a.selection.identity, b.selection.identity);
});

test("the argv every stage runs carries the project's own packer, captured without spawning", async () => {
  const io = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: twoProjectTree() });
  const cases = [
    { root: "/work/projA", packer: PACKER_A },
    { root: "/work/projB", packer: PACKER_B },
  ];
  for (const { root, packer } of cases) {
    const ctx = resolveOperationToolchain({ androidProjectRoot: root, required: ["packer"], primary: "packer" }, io);
    const runner = recordingRunner();
    const { deps } = packDeps(ctx, runner);
    const packed = await packAndInspectScene(deps, { sceneDir: `${root}/Scenes`, outBundle: "/out/x.bundle" });

    assert.ok(!("error" in packed), `pack failed for ${root}`);
    assert.equal(runner.calls.length, 2, "pack + inspect");
    assert.deepEqual(runner.calls.map((c) => c.bin), [packer, packer]);
    assert.deepEqual(runner.calls[0].args, [
      "pack", "-s", `${root}/Scenes`, "-o", "/out/x.bundle", "--formats", "usda", "--override-output", "--force-build",
    ]);
    assert.deepEqual(runner.calls[1].args, ["info", "--input", "/out/x.bundle"]);
    // The pre-existing bounded timeouts are part of the contract, not incidental.
    assert.equal(runner.calls[0].opts.timeoutMs, 600_000);
    assert.equal(runner.calls[1].opts.timeoutMs, 60_000);
    assert.equal(packed.models, "3");
    assert.equal(packed.assets, "7");
  }
});

test("a projectDir and --details reach the packer exactly as before", async () => {
  const io = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: twoProjectTree() });
  const ctx = resolveOperationToolchain({ androidProjectRoot: "/work/projA", required: ["packer"], primary: "packer" }, io);
  const runner = recordingRunner();
  const { deps } = packDeps(ctx, runner);
  await packAndInspectScene(deps, { sceneDir: "/s", projectDir: "/p.spatialproject", outBundle: "/o.bundle", details: true });
  assert.deepEqual(runner.calls[0].args, [
    "pack", "-s", "/s", "-o", "/o.bundle", "--formats", "usda", "--override-output", "--force-build", "-p", "/p.spatialproject",
  ]);
  assert.deepEqual(runner.calls[1].args, ["info", "--input", "/o.bundle", "--details"]);
});

// ------------------------------------------------------------- one selection for every stage

test("a multi-stage operation keeps its stage-1 selection when discovery changes underneath it", async () => {
  // One io whose tree is swapped out between stage 1 and stage 2. If any stage re-resolved, it
  // would pick up /sdk-b's 6.1 packer; the operation must keep running the binary it started on.
  const before = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: twoProjectTree() });
  const after = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: {
      "/work/projA/settings.gradle": { bytes: "rootProject.name = 'a'\n" },
      "/work/projA/local.properties": { bytes: "spatial.tools.dir=/sdk-b\n" },
      [PACKER_B]: { bytes: "packer-six-one", executable: true },
    },
  });
  let current = before;
  const mutableIO = {
    get platform() { return current.platform; },
    get home() { return current.home; },
    get env() { return current.env; },
    read: (p) => current.read(p),
    entries: (p) => current.entries(p),
    realpath: (p) => current.realpath(p),
    executable: (p) => current.executable(p),
  };

  const ctx = resolveOperationToolchain(
    { androidProjectRoot: "/work/projA", required: ["packer"], primary: "packer" },
    mutableIO,
  );
  assert.equal(ctx.bin, PACKER_A);

  const calls = [];
  const deps = {
    toolchain: ctx,
    run: async (bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      if (calls.length === 1) current = after; // the host's toolchain changes mid-operation
      return { code: 0, stdout: "Model Count: 1\nAsset Count: 1\n", stderr: "", timedOut: false };
    },
    exists: () => true,
    mkdirp: () => {},
    sizeBytes: () => 1024,
  };
  const packed = await packAndInspectScene(deps, { sceneDir: "/s", outBundle: "/o.bundle" });
  assert.ok(!("error" in packed));
  assert.deepEqual(calls.map((c) => c.bin), [PACKER_A, PACKER_A], "stage 2 must not re-resolve");

  // …and the tree really did change, so the assertion above is not vacuous.
  const afterSelection = resolveOperationToolchain(
    { androidProjectRoot: "/work/projA", required: ["packer"], primary: "packer" },
    mutableIO,
  );
  assert.equal(afterSelection.bin, PACKER_B);
});

test("a deploying scene operation resolves the packer and the editor from ONE installation", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: {
      "/sdk/6.0/editor/spatialbundle/spatialbundle": { bytes: "old-packer", executable: true },
      "/sdk/6.0/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor": { bytes: "old-editor", executable: true },
      "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "new-packer", executable: true },
    },
  });
  // 6.1 has the newer packer but no editor payload, so a combined request must land on 6.0
  // rather than packing with 6.1 and then deploying a 6.0 ScenePreview APK.
  const both = resolveOperationToolchain({ toolsRoot: "/sdk", required: ["packer", "editor"], primary: "packer" }, io);
  assert.equal(both.selection.version, "6.0");
  assert.equal(both.bin, "/sdk/6.0/editor/spatialbundle/spatialbundle");
  assert.equal(both.selection.files.editor.path, "/sdk/6.0/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor");

  const packerOnly = resolveOperationToolchain({ toolsRoot: "/sdk", required: ["packer"], primary: "packer" }, io);
  assert.equal(packerOnly.selection.version, "6.1");
});

test("a deploying scene operation still packs when the host has no editor payload", async () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: { "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "packer", executable: true } },
  });
  const asked = [];
  const resolve = (request) => {
    asked.push([...request.required].sort().join("+"));
    return resolveOperationToolchain({ ...request, toolsRoot: "/sdk" }, io);
  };

  // ScenePreview may already be installed on the device; a missing host editor bundle must not
  // stop the pack the way a missing packer does.
  const ctx = await resolveSceneToolchain({ needEditor: true }, resolve);
  assert.ok(!("error" in ctx), JSON.stringify(ctx));
  assert.deepEqual(asked, ["editor+packer", "packer"], "the editor is preferred, then dropped");
  assert.equal(ctx.bin, "/sdk/6.1/editor/spatialbundle/spatialbundle");
  assert.equal(ctx.selection.files.editor, undefined);

  // A missing PACKER is still fatal — the fallback is not a general excuse.
  const emptyIO = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: {}, dirs: ["/sdk"] });
  const broken = await resolveSceneToolchain(
    { needEditor: true },
    (request) => resolveOperationToolchain({ ...request, toolsRoot: "/sdk" }, emptyIO),
  );
  assert.ok("error" in broken);
  assert.match(broken.error, /unavailable\//);
});

test("a deploying scene operation prefers one installation carrying BOTH payloads", async () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: {
      "/sdk/6.0/editor/spatialbundle/spatialbundle": { bytes: "p0", executable: true },
      "/sdk/6.0/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor": { bytes: "e0", executable: true },
      "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p1", executable: true },
    },
  });
  const resolve = (request) => resolveOperationToolchain({ ...request, toolsRoot: "/sdk" }, io);
  const deploying = await resolveSceneToolchain({ needEditor: true }, resolve);
  assert.equal(deploying.selection.version, "6.0", "pack and ScenePreview come from the same install");
  const compileOnly = await resolveSceneToolchain({ needEditor: false }, resolve);
  assert.equal(compileOnly.selection.version, "6.1");
});

// -------------------------------------------------------------------- the editor component

test("an editor request resolves the app bundle it launches, not the packer beside it", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: {
      "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "packer", executable: true },
      "/sdk/6.1/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor": { bytes: "editor", executable: true },
    },
  });
  const editor = resolveOperationToolchain({ toolsRoot: "/sdk", required: ["editor"], primary: "editor" }, io);
  assert.equal(editor.bin, "/sdk/6.1/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor");
  assert.equal(path.dirname(editor.bin), "/sdk/6.1/editor/Spatial Editor.app/Contents/MacOS");
});

test("a packer-only installation cannot satisfy an editor request", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: { "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "packer", executable: true } },
  });
  const editor = resolveOperationToolchain({ toolsRoot: "/sdk", required: ["editor"], primary: "editor" }, io);
  assert.ok(isToolchainFailure(editor));
  assert.equal(editor.code, "unavailable/component-missing");
  assert.match(editor.detail, /editor/);

  // Pinned to that same version, the failure names the exact payload it looked for — the path
  // that proves `editor` is not an alias for the packer sitting next to it.
  const pinned = resolveOperationToolchain({ toolsRoot: "/sdk", toolsVersion: "6.1", required: ["editor"], primary: "editor" }, io);
  assert.ok(isToolchainFailure(pinned));
  assert.equal(pinned.code, "unavailable/component-missing");
  assert.match(pinned.detail, /Spatial Editor\.app\/Contents\/MacOS\/Spatial Editor/);
});

test("the editor component is unsupported off macOS, and says so instead of naming a fake path", () => {
  for (const platform of ["linux", "win32"]) {
    const io = toolchainIOFromTree({
      platform,
      home: platform === "win32" ? "C:\\Users\\dev" : "/home/dev",
      env: {},
      files: platform === "win32"
        ? { "C:\\sdk\\6.1\\editor\\spatialbundle\\spatialbundle.exe": { bytes: "p", executable: true } }
        : { "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true } },
    });
    const result = resolveOperationToolchain(
      { toolsRoot: platform === "win32" ? "C:\\sdk" : "/sdk", required: ["editor"], primary: "editor" },
      io,
    );
    assert.ok(isToolchainFailure(result), platform);
    assert.equal(result.code, "unavailable/component-unsupported-platform", platform);
    assert.doesNotMatch(result.detail, /Spatial Editor\.app/, `${platform} must not name a macOS-only path`);
  }
});

// ------------------------------------------------------------------- androidProjectRoot input

test("a supplied androidProjectRoot must carry readable Android project metadata", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: {
      "/work/notaproject/README.md": { bytes: "# nothing here\n" },
      "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
    },
    dirs: ["/work/notaproject"],
  });
  const result = resolveOperationToolchain(
    { androidProjectRoot: "/work/notaproject", toolsRoot: "/sdk", required: ["packer"], primary: "packer" },
    io,
  );
  assert.ok(isToolchainFailure(result));
  assert.equal(result.code, "unavailable/android-project-unreadable");
  assert.match(result.detail, /settings\.gradle/);
});

test("androidProjectRoot is rejected BEFORE any packing happens", async () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: {},
    files: { "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true } },
  });
  const runner = recordingRunner();
  const result = resolveOperationToolchain(
    { androidProjectRoot: "/work/missing", toolsRoot: "/sdk", required: ["packer"], primary: "packer" },
    io,
  );
  assert.ok(isToolchainFailure(result));
  assert.equal(runner.calls.length, 0, "nothing may be packed before the project root is validated");
});

test("every accepted Android project marker is honoured, and an empty root is refused", () => {
  for (const marker of ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"]) {
    const io = toolchainIOFromTree({
      platform: "darwin",
      home: "/fixture",
      env: {},
      files: {
        [`/work/p/${marker}`]: { bytes: "// marker\n" },
        "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
      },
    });
    const ok = resolveOperationToolchain({ androidProjectRoot: "/work/p", toolsRoot: "/sdk", required: ["packer"], primary: "packer" }, io);
    assert.ok(!isToolchainFailure(ok), `${marker} should be accepted`);
    const blank = resolveOperationToolchain({ androidProjectRoot: "   ", toolsRoot: "/sdk", required: ["packer"], primary: "packer" }, io);
    assert.ok(isToolchainFailure(blank));
    assert.equal(blank.code, "unavailable/android-project-unreadable");
  }
});

test("androidProjectRoot is a different input from the .spatialproject projectDir", async () => {
  // The packer still receives -p <projectDir>; androidProjectRoot only chose the toolchain.
  const io = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: twoProjectTree() });
  const ctx = resolveOperationToolchain({ androidProjectRoot: "/work/projB", required: ["packer"], primary: "packer" }, io);
  const runner = recordingRunner();
  const { deps } = packDeps(ctx, runner);
  await packAndInspectScene(deps, { sceneDir: "/s", projectDir: "/work/projB/app/src/main/res3d/Demo", outBundle: "/o.bundle" });
  assert.equal(runner.calls[0].bin, PACKER_B);
  assert.ok(runner.calls[0].args.includes("/work/projB/app/src/main/res3d/Demo"));
  assert.ok(!runner.calls[0].args.includes("/work/projB"), "the Android root is not passed to the packer");
});

// ------------------------------------------------------------------- PICO_SPATIALBUNDLE override

const OVERRIDE = "/opt/custom/spatialbundle";
const OVERRIDE_BYTES = "custom-packer-bytes";
const OVERRIDE_SHA = crypto.createHash("sha256").update(Buffer.from(OVERRIDE_BYTES, "utf8")).digest("hex");

function overrideIO(extraFiles = {}, env = { PICO_SPATIALBUNDLE: OVERRIDE }) {
  return toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env,
    files: {
      [OVERRIDE]: { bytes: OVERRIDE_BYTES, executable: true },
      "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "installed-packer", executable: true },
      ...extraFiles,
    },
  });
}

test("an explicit override is disclosed by its bytes and is never launched to inspect it", async () => {
  const io = overrideIO();
  const probe = { calls: 0, fn: async () => { probe.calls += 1; return "spatialbundle 9.9.9"; } };

  const ctx = resolveOperationToolchain(
    { toolsRoot: "/sdk", required: ["packer"], primary: "packer", allowBinaryOverride: true },
    io,
  );
  assert.equal(ctx.bin, OVERRIDE);
  assert.deepEqual(ctx.binaryOverride, { file: { path: OVERRIDE, sha256: OVERRIDE_SHA }, reportedVersion: null });
  assert.equal(probe.calls, 0, "structural inspection launches nothing");
  // The installed toolchain is still disclosed next to the override that displaced it.
  assert.equal(ctx.selection.version, "6.1");

  // With no explicit pin there is nothing to verify, so still nothing is launched.
  const verified = await verifyOperationOverride(ctx, probe.fn);
  assert.equal(probe.calls, 0);
  assert.equal(verified.binaryOverride.reportedVersion, null);

  const provenance = toolchainProvenance(verified);
  assert.equal(provenance.toolchain.version, "6.1");
  assert.equal(provenance.binaryOverride.file.sha256, OVERRIDE_SHA);
  assert.match(toolchainProvenanceLine(verified), /PICO_SPATIALBUNDLE/);
});

test("an override carries the operation even when the host has no installed toolchain", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: { PICO_SPATIALBUNDLE: OVERRIDE },
    files: { [OVERRIDE]: { bytes: OVERRIDE_BYTES, executable: true } },
  });
  const ctx = resolveOperationToolchain(
    { toolsRoot: "/sdk", required: ["packer"], primary: "packer", allowBinaryOverride: true },
    io,
  );
  assert.ok(!isToolchainFailure(ctx));
  assert.equal(ctx.bin, OVERRIDE);
  assert.equal(ctx.selection, null);
  assert.equal(ctx.selectionUnavailable.code, "unavailable/root-unavailable");
  const provenance = toolchainProvenance(ctx);
  assert.equal(provenance.toolchain, null);
  assert.equal(provenance.toolchainUnavailable.code, "unavailable/root-unavailable");
});

test("a non-executable or unreadable override is refused instead of being handed to spawn", () => {
  const notExecutable = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: { PICO_SPATIALBUNDLE: OVERRIDE },
    files: {
      [OVERRIDE]: { bytes: OVERRIDE_BYTES },
      "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "installed", executable: true },
    },
  });
  const result = resolveOperationToolchain(
    { toolsRoot: "/sdk", required: ["packer"], primary: "packer", allowBinaryOverride: true },
    notExecutable,
  );
  assert.ok(isToolchainFailure(result));
  assert.equal(result.code, "unavailable/override-unusable");

  const absent = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    env: { PICO_SPATIALBUNDLE: "/opt/nope/spatialbundle" },
    files: { "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "installed", executable: true } },
  });
  const missing = resolveOperationToolchain(
    { toolsRoot: "/sdk", required: ["packer"], primary: "packer", allowBinaryOverride: true },
    absent,
  );
  assert.ok(isToolchainFailure(missing));
  assert.equal(missing.code, "unavailable/override-unusable");
});

test("an override is only consulted when the operation opted in, and only for the packer", () => {
  const io = overrideIO();
  const noOptIn = resolveOperationToolchain({ toolsRoot: "/sdk", required: ["packer"], primary: "packer" }, io);
  assert.equal(noOptIn.binaryOverride, null);
  assert.equal(noOptIn.bin, "/sdk/6.1/editor/spatialbundle/spatialbundle");

  const editorIO = overrideIO({
    "/sdk/6.1/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor": { bytes: "editor", executable: true },
  });
  const editorCtx = resolveOperationToolchain(
    { toolsRoot: "/sdk", required: ["editor"], primary: "editor", allowBinaryOverride: true },
    editorIO,
  );
  assert.equal(editorCtx.binaryOverride, null, "$PICO_SPATIALBUNDLE never redirects the editor binary");
  assert.equal(editorCtx.bin, "/sdk/6.1/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor");
});

test("an explicit pin whose override reports no version fails as override-version-unverified", async () => {
  const io = overrideIO();
  const ctx = resolveOperationToolchain(
    { toolsRoot: "/sdk", toolsVersion: "6.1", required: ["packer"], primary: "packer", allowBinaryOverride: true },
    io,
  );
  assert.equal(ctx.pinnedVersion, "6.1");
  const probes = [];
  const result = await verifyOperationOverride(ctx, async (bin) => { probes.push(bin); return "usage: spatialbundle <command>"; });
  assert.deepEqual(probes, [OVERRIDE], "the probe runs the override, inside the operation");
  assert.ok(isToolchainFailure(result));
  assert.equal(result.code, "unavailable/override-version-unverified");
  assert.doesNotMatch(result.detail, /spatialbundle-6\.1/, "a filename is never evidence of a version");
});

test("an override that disagrees with the pin fails as override-version-conflict", async () => {
  const io = overrideIO();
  const ctx = resolveOperationToolchain(
    { toolsRoot: "/sdk", toolsVersion: "6.1", required: ["packer"], primary: "packer", allowBinaryOverride: true },
    io,
  );
  const result = await verifyOperationOverride(ctx, async () => "spatialbundle 6.0.0.0-rls.9");
  assert.ok(isToolchainFailure(result));
  assert.equal(result.code, "unavailable/override-version-conflict");
  assert.match(result.detail, /6\.0\.0\.0/);
  assert.match(result.detail, /6\.1/);
});

test("an override that agrees with the pin is accepted and records the version it reported", async () => {
  const io = overrideIO();
  const ctx = resolveOperationToolchain(
    { toolsRoot: "/sdk", toolsVersion: "6.1", required: ["packer"], primary: "packer", allowBinaryOverride: true },
    io,
  );
  const result = await verifyOperationOverride(ctx, async () => "spatialbundle 6.1.0.0-rls.25");
  assert.ok(!isToolchainFailure(result));
  assert.equal(result.binaryOverride.reportedVersion, "6.1.0.0");
  assert.match(toolchainProvenanceLine(result), /6\.1\.0\.0/);
});

test("version reporting helpers read the tool's output, never a path", () => {
  assert.equal(extractReportedVersion("spatialbundle 6.1.0.0-rls.25"), "6.1.0.0");
  assert.equal(extractReportedVersion("no version here"), null);
  assert.equal(extractReportedVersion(""), null);
  assert.ok(reportedVersionMatchesPin("6.1", "6.1.0.0"));
  assert.ok(reportedVersionMatchesPin("6.1.0", "6.1.0.0"));
  assert.ok(!reportedVersionMatchesPin("6.1", "6.10.0"));
  assert.ok(!reportedVersionMatchesPin("6.1.1", "6.1.0"));
  assert.ok(!reportedVersionMatchesPin("latest", "6.1.0"));
});

// ------------------------------------------- overrides are disclosed, and never redirect a read

const INSTALLED_PACKER = "/sdk/6.1/editor/spatialbundle/spatialbundle";

const OVERRIDE_ENV = { PICO_SPATIALBUNDLE: OVERRIDE, PICO_HOME: "/sdk" };

test("scene_schemas reads beside the INSTALLED packer and never spawns, even with the override set", async () => {
  const io = overrideIO({}, OVERRIDE_ENV);
  const probe = { calls: 0, fn: async () => { probe.calls += 1; return "spatialbundle 6.1.0.0"; } };

  // $PICO_SPATIALBUNDLE names a packer to RUN. scene_schemas runs nothing — it reads USD schema
  // files that ship inside the installation — so the override must not move where it reads from.
  const ctx = await resolveSchemaToolchain({}, io, probe.fn);
  assert.ok(!("error" in ctx), JSON.stringify(ctx));
  assert.equal(ctx.binaryOverride, null, "the override must not redirect a data-file lookup");
  assert.equal(ctx.bin, INSTALLED_PACKER);
  assert.equal(schemaUsdDir(ctx), "/sdk/6.1/editor/spatialbundle/usd");
  assert.notEqual(schemaUsdDir(ctx), path.join(path.dirname(OVERRIDE), "usd"));
  assert.equal(probe.calls, 0, "a schema lookup launches nothing");

  // The secondary defect: a version pin plus an override used to make this lookup spawn
  // `$PICO_SPATIALBUNDLE --version`. With the override off there is nothing to verify.
  const pinned = await resolveSchemaToolchain({ toolsVersion: "6.1" }, io, probe.fn);
  assert.ok(!("error" in pinned));
  assert.equal(pinned.bin, INSTALLED_PACKER);
  assert.equal(probe.calls, 0, "a pinned schema lookup still launches nothing");

  // And it still reports which installation the grammar came from.
  assert.match(toolchainProvenanceLine(pinned), /packer 6\.1 from PICO_HOME \/sdk/);
  assert.doesNotMatch(toolchainProvenanceLine(pinned), /PICO_SPATIALBUNDLE/);
});

test("inspect_bundle's body names the binary that decoded the bundle", async () => {
  const io = overrideIO({}, OVERRIDE_ENV);
  const ctx = await packerToolchain({}, io);
  assert.ok(!("error" in ctx));
  assert.equal(ctx.bin, OVERRIDE, "inspect_bundle RUNS the packer, so the override applies here");

  const body = inspectBundleReport("Model Count: 2\nAsset Count: 5", "{\"schemaVersion\":1}", ctx);
  assert.match(body, /# spatialbundle info/);
  assert.match(body, /Model Count: 2/);
  assert.match(body, /# BundleInfo\.json/);
  assert.match(body, /schemaVersion/);
  // The caller never named this binary in the request; the result must say it was used.
  assert.match(body, /# toolchain/);
  assert.ok(body.includes(OVERRIDE), "the override path must appear in the result");
  assert.ok(body.includes(OVERRIDE_SHA.slice(0, 12)), "the override's byte identity must appear too");

  // An absent manifest is still reported honestly, and provenance survives it.
  const noManifest = inspectBundleReport("Model Count: 0", null, ctx);
  assert.match(noManifest, /not extractable/);
  assert.ok(noManifest.includes(OVERRIDE));
});

test("a packer operation that RUNS the binary still honours the override by default", async () => {
  const io = overrideIO({}, OVERRIDE_ENV);
  const ctx = await packerToolchain({}, io);
  assert.equal(ctx.bin, OVERRIDE);
  assert.equal(ctx.binaryOverride.file.sha256, OVERRIDE_SHA);
  // …and the opt-out is explicit, not a default that silently drifted.
  const optedOut = await packerToolchain({ allowBinaryOverride: false }, io);
  assert.equal(optedOut.bin, INSTALLED_PACKER);
  assert.equal(optedOut.binaryOverride, null);
});

test("every tool result that can run the override discloses which binary ran", () => {
  // A source-level audit, so a new packer consumer cannot report tool output anonymously.
  const cases = [
    ["bundle.ts", /toolchainProvenance\(sb\)/, /toolchainProvenanceLine\(/],
    ["workflow.ts", /toolchainProvenance\(ctx\)/, /toolchainProvenanceLine\(ctx\)/],
    ["editorexport.ts", /toolchainProvenance\(ctx\)/, /toolchainProvenanceLine\(ctx\)/],
    ["bundlediff.ts", /toolchainProvenance\(ctx\)/, /toolchainProvenanceLine\(ctx\)/],
  ];
  for (const [name, spread, line] of cases) {
    const text = fs.readFileSync(path.join(repoRoot, "src", name), "utf8");
    assert.match(text, spread, `${name} must spread structured provenance into a result`);
    assert.match(text, line, `${name} must name the binary in a text result`);
  }
});

// --------------------------------------------------------------- no independent 0.13 fallback

test("no src/*.ts still carries the hardcoded 0.13 spatialbundle fallback", () => {
  const srcDir = path.join(repoRoot, "src");
  const offenders = [];
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith(".ts")) continue;
    const text = fs.readFileSync(path.join(srcDir, name), "utf8");
    // The executable fallback literal only — prose and comments about the defect are fine, and
    // historical documentation is outside this scan entirely.
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
      if (/sdk\/0\.13\/editor\/spatialbundle/.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "every packer consumer must select its binary, not hardcode 0.13");
});

test("the packer consumers import the shared selection rather than rebuilding one", () => {
  // S4 extracted the resolve+verify pair the four packer wrappers each held a copy of into
  // `prepareOperationToolchain`, so reaching the seam through THAT satisfies this gate too. What
  // must never come back is a consumer resolving (or, worse, hardcoding) a binary of its own.
  for (const name of ["bundle.ts", "editorexport.ts", "bundlediff.ts", "workflow.ts", "editor.ts"]) {
    const text = fs.readFileSync(path.join(repoRoot, "src", name), "utf8");
    assert.match(text, /(?:resolve|prepare)OperationToolchain/, `${name} must resolve through ./toolchain.js`);
  }
});

test("the extracted helper still performs BOTH halves for every packer wrapper", async () => {
  // The step a copy-paste refactor is most likely to drop is the override VERIFICATION, which is
  // what stops an unverified $PICO_SPATIALBUNDLE from packing under a version pin it fails. Prove
  // it survives through the shared helper, in both directions.
  const io = toolchainIOFromTree({
    platform: "darwin", home: "/fixture",
    env: { PICO_SPATIALBUNDLE: "/opt/custom/spatialbundle" },
    files: {
      "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "packer-6.1", executable: true },
      "/opt/custom/spatialbundle": { bytes: "override-bytes", executable: true },
    },
  });
  const request = { toolsRoot: "/sdk", toolsVersion: "6.1", required: ["packer"], primary: "packer", allowBinaryOverride: true };
  const conflict = await prepareOperationToolchain(request, { io, probe: async () => "spatialbundle 6.0.0" });
  assert.match(conflict.error ?? "", /override-version-conflict/);
  const agreeing = await prepareOperationToolchain(request, { io, probe: async () => "spatialbundle 6.1.0-rls.7" });
  assert.equal(agreeing.binaryOverride?.reportedVersion, "6.1.0");
  // and the resolve half still flattens a structural failure to the same `code: detail` shape
  const missing = await prepareOperationToolchain({ ...request, toolsVersion: "9.9" }, { io, probe: async () => "" });
  assert.match(missing.error ?? "", /^unavailable\/[a-z-]+: /);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Task S6 — the operation matrix.
//
// Every row below runs on ONE host that carries BOTH a legacy 0.13 payload and a 6.1 payload, so
// a fallback to the legacy location would silently succeed instead of failing loudly. Each row
// asserts the same three things: the operation uses the SELECTED 6.1 identity, the captured
// runner/exec log contains no legacy launch (no 0.13 packer path, no `which`/`command -v` lookup,
// and no bare `adb` once an explicit override is set), and a failed or missing selection is
// reported as itself rather than degraded to some other binary.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import os from "node:os";
const { resolveToolchain } = await import("../dist/toolchainselection.js");
const { runPreflightChecks } = await import("../dist/preflight.js");
const { adbExecutable, clearAdbResolutionCache, resolveAdbExecutable } = await import("../dist/adb.js");
const { clearProtoCache, loadProto } = await import("../dist/grpc.js");
const { registerVaultTools } = await import("../dist/vault.js");
const { registerLintTools } = await import("../dist/lint.js");

const S6_ROOT = "/sdk";
const S6_PACKER = "/sdk/6.1/editor/spatialbundle/spatialbundle";
const S6_EDITOR = "/sdk/6.1/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor";
const S6_ADB = "/sdk/6.1/emulator/system-images/platform-tools/adb";
const S6_LEGACY_PACKER = "/sdk/0.13/editor/spatialbundle/spatialbundle";
const S6_LEGACY_ADB = "/sdk/0.13/emulator/system-images/platform-tools/adb";

/** A host carrying a complete 0.13 install AND a complete 6.1 install under one root. */
function mixedHostFiles(extra = {}) {
  const files = {};
  for (const version of ["0.13", "6.1"]) {
    files[`${S6_ROOT}/${version}/editor/spatialbundle/spatialbundle`] = { bytes: `packer-${version}`, executable: true };
    files[`${S6_ROOT}/${version}/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor`] = { bytes: `editor-${version}`, executable: true };
    files[`${S6_ROOT}/${version}/emulator/emulator`] = { bytes: `emulator-${version}`, executable: true };
    files[`${S6_ROOT}/${version}/emulator/system-images/platform-tools/adb`] = { bytes: `adb-${version}`, executable: true };
    files[`${S6_ROOT}/${version}/emulator/lib/emulator_controller.proto`] = { bytes: `proto-${version}` };
  }
  return { ...files, ...extra };
}

const mixedHostIO = (env = { PICO_HOME: S6_ROOT }, extra = {}) =>
  toolchainIOFromTree({ platform: "darwin", home: "/fixture", env, files: mixedHostFiles(extra) });

/** A launch log entry that would mean a legacy fallback ran. */
const LEGACY_LAUNCH = /\/0\.13\/|(?:^|\s)which(?:\s|$)|command -v|(?:^|\s)where(?:\s|$)/;

test("S6 matrix: every packer/editor consumer runs the SELECTED 6.1 binary on a host that also carries 0.13", async () => {
  const io = mixedHostIO();
  const probe = { calls: 0, fn: async () => { probe.calls += 1; return "spatialbundle 6.1.0"; } };
  const bound = (request) => resolveOperationToolchain(request, io);

  const rows = [
    ["resolveOperationToolchain — the structural base every consumer shares", async () => bound({ required: ["packer"], primary: "packer" })],
    ["packerToolchain — inspect_bundle / bake_textured_model", async () => packerToolchain({}, io, probe.fn)],
    ["resolveSchemaToolchain — scene_schemas (a data lookup, never a launch)", async () => resolveSchemaToolchain({}, io, probe.fn)],
    ["resolveSceneToolchain — iterate_scene (packer only)", async () => resolveSceneToolchain({}, bound, probe.fn)],
    ["resolveSceneToolchain — deploying scene operation (packer + editor)", async () => resolveSceneToolchain({ needEditor: true }, bound, probe.fn)],
    // editor_export_bundle and bundle_diff hold no injectable seam of their own: both build the
    // SAME request and hand it to the shared helper (pinned by source text below), so the helper
    // under that exact request is the honest row for them.
    ["prepareOperationToolchain — editor_export_bundle / bundle_diff request", async () =>
      prepareOperationToolchain({ required: ["packer"], primary: "packer", allowBinaryOverride: true }, { io, probe: probe.fn })],
  ];

  for (const [name, run] of rows) {
    const ctx = await run();
    assert.ok(!("error" in ctx) && !isToolchainFailure(ctx), `${name}: ${JSON.stringify(ctx)}`);
    assert.equal(ctx.bin, S6_PACKER, `${name} must run the selected 6.1 packer`);
    assert.equal(ctx.selection.version, "6.1", name);
    assert.equal(ctx.selection.root, S6_ROOT, name);
    assert.equal(ctx.selection.rootSource, "PICO_HOME", name);
    assert.equal(ctx.selection.reason, "newest-usable", name);
    assert.ok(!LEGACY_LAUNCH.test(ctx.bin), `${name} reached the legacy payload: ${ctx.bin}`);
    assert.notEqual(ctx.bin, S6_LEGACY_PACKER, name);
  }
  assert.equal(probe.calls, 0, "no row launched a version probe: none of them carries a pin or an override");

  // The editor component of the same installation, for the row that launches the app bundle.
  const editor = resolveOperationToolchain({ required: ["packer", "editor"], primary: "editor" }, io);
  assert.equal(editor.bin, S6_EDITOR);
  assert.equal(editor.selection.version, "6.1");

  // And the argv every stage actually runs, captured without spawning.
  const runner = recordingRunner();
  const { deps } = packDeps(await packerToolchain({}, io, probe.fn), runner);
  const packed = await packAndInspectScene(deps, { sceneDir: "/work/Scenes", outBundle: "/out/matrix.bundle" });
  assert.ok(!("error" in packed), JSON.stringify(packed));
  assert.deepEqual([...new Set(runner.calls.map((c) => c.bin))], [S6_PACKER]);
  for (const call of runner.calls) {
    assert.ok(!LEGACY_LAUNCH.test([call.bin, ...call.args].join(" ")), `a legacy launch reached the runner: ${call.bin} ${call.args.join(" ")}`);
  }
  assert.equal(probe.calls, 0, "packing without a pin still launches no version probe");
});

test("S6 matrix: the preflight pico-sdk and adb rows read the selection, and their captured exec log launches nothing legacy", () => {
  const io = mixedHostIO();
  const inspections = {
    toolchainInspection: resolveToolchain({ required: ["packer"] }, io),
    emulatorInspection: resolveToolchain({ required: ["emulator"] }, io),
    adbInspection: resolveToolchain({ required: ["adb"] }, io),
  };
  assert.equal(inspections.toolchainInspection.version, "6.1");

  const preflightIO = (exec, extra = {}) => ({
    nodeVersion: "v20.11.0",
    exec,
    readFile: () => null,
    statMtimeMs: () => null,
    now: () => 1_800_000_000_000,
    home: "/fixture",
    detectJavaHome: () => "/fixture/jbr/Contents/Home",
    javaHomeEnv: "/fixture/jbr/Contents/Home",
    adbOverride: null,
    ...inspections,
    ...extra,
  });

  // (a) no explicit override, nothing on PATH: the row lands on the SELECTED toolchain's bundled
  //     adb and the legacy 0.13 location — still a last candidate — is never reached.
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { ok: cmd === S6_ADB, stdout: "Android Debug Bridge version 35.0.0", stderr: "" };
  };
  const checks = runPreflightChecks(preflightIO(exec));
  const adbRow = checks.find((c) => c.name === "adb");
  assert.equal(adbRow.status, "pass");
  assert.ok(adbRow.detail.includes(S6_ADB), adbRow.detail);
  assert.match(adbRow.detail, /bundled platform-tools of the selected 6\.1 toolchain/);
  assert.ok(!calls.some((line) => LEGACY_LAUNCH.test(line)), calls.join(" | "));
  assert.ok(!calls.some((line) => line.includes("0.13")), calls.join(" | "));

  const sdkRow = checks.find((c) => c.name === "pico-sdk");
  assert.equal(sdkRow.status, "pass");
  assert.match(sdkRow.detail, /packer 6\.1 from PICO_HOME \/sdk/);
  assert.match(sdkRow.detail, /emulator 6\.1/);
  assert.ok(!/0\.13/.test(sdkRow.detail), sdkRow.detail);

  // (b) an explicit $PICO_ADB that does not answer: the row FAILS closed and nothing else is
  //     probed — no bare `adb`, no bundled candidate, no legacy path.
  const pinnedCalls = [];
  const pinnedExec = (cmd, args) => { pinnedCalls.push([cmd, ...args].join(" ")); return { ok: false, stdout: "", stderr: "not found" }; };
  const pinnedRow = runPreflightChecks(preflightIO(pinnedExec, { adbOverride: "/opt/pinned/adb" })).find((c) => c.name === "adb");
  assert.equal(pinnedRow.status, "fail");
  assert.match(pinnedRow.detail, /nothing else was probed/);
  const adbProbes = pinnedCalls.filter((line) => /adb/.test(line));
  assert.deepEqual(adbProbes, ["/opt/pinned/adb version"]);
  assert.ok(!pinnedCalls.some((line) => LEGACY_LAUNCH.test(line)), pinnedCalls.join(" | "));
});

test("S6 matrix: adb and the emulator proto schema follow the selected installation; adb resolution spawns nothing", (t) => {
  // adb — both payloads installed, nothing on PATH.
  const io = mixedHostIO({ PICO_HOME: S6_ROOT, PATH: "/usr/bin:/bin" });
  clearAdbResolutionCache();
  const resolved = resolveAdbExecutable(io);
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.source, "bundled");
  assert.equal(resolved.path, S6_ADB);
  assert.notEqual(resolved.path, S6_LEGACY_ADB);
  assert.ok(resolved.probed.every((p) => path.posix.isAbsolute(p)), `a bare name or shell lookup leaked into ${JSON.stringify(resolved.probed)}`);
  assert.ok(!resolved.probed.some((p) => LEGACY_LAUNCH.test(p)), JSON.stringify(resolved.probed));
  assert.equal(adbExecutable(io), S6_ADB);

  // …and with an explicit override set, the bare `adb` last resort is never reached.
  const pinned = mixedHostIO(
    { PICO_ADB: "/opt/pinned/adb", PICO_HOME: S6_ROOT, PATH: "/usr/bin" },
    { "/usr/bin/adb": { bytes: "path-adb", executable: true } },
  );
  clearAdbResolutionCache();
  const refused = resolveAdbExecutable(pinned);
  assert.equal(refused.status, "unavailable");
  assert.deepEqual(refused.probed, ["/opt/pinned/adb"], "an explicit override fails closed; nothing else is probed");
  assert.throws(() => adbExecutable(pinned), /PICO_ADB/);
  clearAdbResolutionCache();

  // proto — the schema cache is keyed on the SELECTED payload, so a 0.13 install beside 6.1 is
  // never the answer and a second request for the other version is not served from the first.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s6-proto-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writeProto = (version, extraRpc = "") => {
    const libDir = path.join(root, version, "emulator", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(root, version, "emulator", "emulator"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(libDir, "emulator_types.proto"), 'syntax = "proto3";\npackage android.emulation.control;\nmessage Empty {}\nmessage EmulatorStatus { string version = 1; }\n');
    fs.writeFileSync(
      path.join(libDir, "emulator_controller.proto"),
      `syntax = "proto3";\npackage android.emulation.control;\nimport "emulator_types.proto";\nservice EmulatorController {\n  rpc getStatus (Empty) returns (EmulatorStatus) {}\n${extraRpc}}\n`,
    );
  };
  writeProto("0.13");
  writeProto("6.1", "  rpc sendXrHeadPose (Empty) returns (Empty) {}\n");

  const priorHome = process.env.PICO_HOME;
  process.env.PICO_HOME = root;
  try {
    clearProtoCache();
    const selected = loadProto();
    assert.ok(!("error" in selected), selected.error);
    assert.ok(selected.protoPath.includes(`${path.sep}6.1${path.sep}`), `the default request served ${selected.protoPath}`);
    const legacy = loadProto("0.13");
    assert.ok(!("error" in legacy), legacy.error);
    assert.ok(legacy.protoPath.includes(`${path.sep}0.13${path.sep}`), legacy.protoPath);
    assert.notEqual(selected.protoPath, legacy.protoPath);
    assert.ok(loadProto("6.1").protoPath.includes(`${path.sep}6.1${path.sep}`), "the 6.1 request was served the cached 0.13 schema");
  } finally {
    if (priorHome === undefined) delete process.env.PICO_HOME; else process.env.PICO_HOME = priorHome;
    clearProtoCache();
  }
});

test("S6 matrix: vault and lint answers follow the selected tools root and stay historical without reviewed evidence", async (t) => {
  // A vault materialized under a version-labelled directory is still whatever package.xml says it
  // is. Both labels below carry a 0.13.3 payload, so a consumer that read the LABEL would report
  // "6.1" for one of them.
  const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s6-tools-"));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s6-project-"));
  t.after(() => { for (const d of [toolsRoot, projectDir]) fs.rmSync(d, { recursive: true, force: true }); });
  const fixtureVault = path.join(repoRoot, "test", "fixtures", "agent-vault");
  for (const label of ["0.13", "6.1"]) {
    const vaultRoot = path.join(toolsRoot, label, "agent-vault");
    const apiDir = path.join(vaultRoot, "knowledge", "api-reference");
    fs.mkdirSync(apiDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(fixtureVault, "knowledge", "api-reference"))) {
      fs.copyFileSync(path.join(fixtureVault, "knowledge", "api-reference", f), path.join(apiDir, f));
    }
    fs.writeFileSync(path.join(vaultRoot, "package.xml"), "<package><revision><major>0</major><minor>13</minor><micro>3</micro></revision></package>\n");
  }
  fs.mkdirSync(path.join(projectDir, "gradle"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "gradle", "libs.versions.toml"), '[versions]\nbom = "6.0.0"\n\n[libraries]\nbom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }\n');

  const priorHome = process.env.PICO_HOME;
  const priorVault = process.env.PICO_AGENT_VAULT;
  process.env.PICO_HOME = toolsRoot;
  delete process.env.PICO_AGENT_VAULT;
  try {
    const vaultHandlers = {};
    registerVaultTools({ registerTool: (name, _meta, fn) => { vaultHandlers[name] = fn; } });
    const lintHandlers = {};
    registerLintTools(
      { registerTool: (name, _meta, fn) => { lintHandlers[name] = fn; } },
      { call: async () => ({ status: "unavailable", action: "query_graph", error: "not exercised here" }) },
    );

    // vault_api, selecting the 6.1-labelled workspace under the SELECTED tools root.
    const answer = JSON.parse((await vaultHandlers.vault_api({ symbol: "Entity", sdkVersion: "6.1", projectRoot: projectDir })).content[0].text);
    assert.equal(answer.vaultSelection.root, path.join(toolsRoot, "6.1", "agent-vault"), JSON.stringify(answer.vaultSelection));
    assert.equal(answer.vaultSelection.source, "version");
    assert.equal(answer.vaultProvenance.packageRevision, "0.13.3", "a 6.1 DIRECTORY LABEL is not a 6.1 package revision");
    assert.equal(answer.lookup, "historical");
    assert.deepEqual(answer.verifiedMatches, []);
    assert.deepEqual(answer.incompatibleMatches, []);
    assert.equal(answer.target.declaredBom, "6.0.0");
    assert.equal(answer.compatibilityIndex.status, "present");
    assert.equal(answer.compatibilityIndex.records, 0);
    assert.notEqual(answer.declarationContext.status, "target-compatible");

    // preflight_lint's advisory vault block: the default vault root is derived from the SELECTED
    // tools root, not from a hardcoded home location.
    const lint = JSON.parse((await lintHandlers.preflight_lint({
      content: "import com.pico.spatial.core.ecs.Entity\nval e = Entity()\n",
      kind: "kotlin",
      projectDir,
    })).content[0].text);
    assert.equal(lint.vault.status, "ok", JSON.stringify(lint.vault).slice(0, 300));
    // declarationIdentity.root is the CANONICAL root the reader resolved, so compare canonically.
    assert.equal(lint.vault.declarationIdentity.root, fs.realpathSync(path.join(toolsRoot, "0.13", "agent-vault")));
    assert.equal(lint.vault.declarationIdentity.packageRevision, "0.13.3");
    assert.equal(lint.vault.target.declaredBom, "6.0.0");
    assert.equal(lint.vault.declarationContext.status, "unknown");
    assert.equal(lint.vault.compatibilityIndex.status, "present");
    assert.equal(lint.vault.compatibilityIndex.records, 0);
    assert.equal(lint.clean, lint.violations.length === 0 && lint.counts.projectErrors === 0, "the vault linkage must not enter `clean`");
  } finally {
    if (priorHome === undefined) delete process.env.PICO_HOME; else process.env.PICO_HOME = priorHome;
    if (priorVault !== undefined) process.env.PICO_AGENT_VAULT = priorVault;
  }
});

test("S6 matrix: failed and missing selections are reported as themselves, never degraded to another binary", async () => {
  const probe = async () => "spatialbundle 6.1.0";
  const cases = [
    {
      name: "no installation at all",
      io: toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: { PICO_HOME: "/sdk" }, files: {} }),
      request: { required: ["packer"], primary: "packer" },
      code: /^unavailable\/root-unavailable$/,
    },
    {
      name: "an installation with no packer payload",
      io: toolchainIOFromTree({
        platform: "darwin", home: "/fixture", env: { PICO_HOME: "/sdk" },
        files: { "/sdk/6.1/emulator/emulator": { bytes: "emulator-only", executable: true } },
      }),
      request: { required: ["packer"], primary: "packer" },
      code: /^unavailable\/component-missing$/,
    },
    {
      name: "a pin that is not installed",
      io: mixedHostIO(),
      request: { toolsVersion: "9.9", required: ["packer"], primary: "packer" },
      code: /^unavailable\/[a-z-]+$/,
    },
    {
      name: "the editor component off macOS",
      io: toolchainIOFromTree({
        platform: "linux", home: "/fixture", env: { PICO_HOME: "/sdk" },
        files: { "/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "packer", executable: true } },
      }),
      request: { required: ["editor"], primary: "editor" },
      code: /^unavailable\//,
    },
  ];

  for (const { name, io, request, code } of cases) {
    const structural = resolveOperationToolchain(request, io);
    assert.ok(isToolchainFailure(structural), `${name}: expected a structured failure, got ${JSON.stringify(structural)}`);
    assert.match(structural.code, code, name);
    assert.ok(structural.detail.length > 10, `${name}: a refusal must say why`);
    assert.ok(!("bin" in structural), `${name}: a failure must carry no binary to run`);

    // The shared helper flattens it to the same `code: detail` shape, still with no binary.
    const prepared = await prepareOperationToolchain({ ...request, allowBinaryOverride: true }, { io, probe });
    assert.ok("error" in prepared, `${name}: ${JSON.stringify(prepared)}`);
    assert.match(prepared.error, /^unavailable\/[a-z-]+: /, name);
    assert.ok(!prepared.error.includes(S6_LEGACY_PACKER), `${name} named the legacy payload as a fallback`);
  }

  // An explicit override is the ONE thing that carries an operation past a missing selection, and
  // it is disclosed rather than silently substituted.
  const overrideIo = toolchainIOFromTree({
    platform: "darwin", home: "/fixture",
    env: { PICO_HOME: "/sdk", PICO_SPATIALBUNDLE: "/opt/custom/spatialbundle" },
    files: { "/opt/custom/spatialbundle": { bytes: "override", executable: true } },
  });
  const carried = resolveOperationToolchain({ required: ["packer"], primary: "packer", allowBinaryOverride: true }, overrideIo);
  assert.equal(carried.bin, "/opt/custom/spatialbundle");
  assert.equal(carried.selection, null);
  assert.equal(carried.selectionUnavailable.code, "unavailable/root-unavailable");
  assert.equal(toolchainProvenance(carried).toolchain, null);
});

test("S6 matrix: the same mixed host on win32 and linux FIXTURES selects the 6.1 payload published for that platform", async () => {
  // Fixture-only evidence. An in-memory tree proves the selection LOGIC is platform-correct; it
  // is not a claim that this server has been run on Windows or Linux, and no native payload,
  // process or path was touched here.
  const probe = async () => "spatialbundle 6.1.0";

  // win32: `.exe` payloads, a drive root, and a legacy 0.13 install beside the 6.1 one.
  const winFiles = {};
  for (const version of ["0.13", "6.1"]) {
    winFiles[`C:\\sdk\\${version}\\editor\\spatialbundle\\spatialbundle.exe`] = { bytes: `packer-${version}`, executable: true };
    winFiles[`C:\\sdk\\${version}\\emulator\\emulator.exe`] = { bytes: `emulator-${version}`, executable: true };
    winFiles[`C:\\sdk\\${version}\\emulator\\system-images\\platform-tools\\adb.exe`] = { bytes: `adb-${version}`, executable: true };
    winFiles[`C:\\sdk\\${version}\\emulator\\lib\\emulator_controller.proto`] = { bytes: `proto-${version}` };
  }
  const winIO = toolchainIOFromTree({ platform: "win32", home: "C:\\Users\\dev", env: { PICO_HOME: "C:\\sdk" }, files: winFiles });
  const win = await packerToolchain({}, winIO, probe);
  assert.ok(!("error" in win), JSON.stringify(win));
  assert.equal(win.bin, "C:\\sdk\\6.1\\editor\\spatialbundle\\spatialbundle.exe");
  assert.equal(win.selection.version, "6.1");
  clearAdbResolutionCache();
  const winAdb = resolveAdbExecutable(winIO);
  assert.equal(winAdb.status, "ok");
  assert.equal(winAdb.path, "C:\\sdk\\6.1\\emulator\\system-images\\platform-tools\\adb.exe");
  // The macOS-only editor app bundle is not published for win32, and is refused rather than faked.
  assert.ok(isToolchainFailure(resolveOperationToolchain({ required: ["editor"], primary: "editor" }, winIO)));
  clearAdbResolutionCache();

  // linux: bare names, an explicit root (Linux has no documented default root to invent).
  const linuxFiles = {};
  for (const version of ["0.13", "6.1"]) {
    linuxFiles[`/opt/pico/${version}/editor/spatialbundle/spatialbundle`] = { bytes: `packer-${version}`, executable: true };
    linuxFiles[`/opt/pico/${version}/emulator/emulator`] = { bytes: `emulator-${version}`, executable: true };
    linuxFiles[`/opt/pico/${version}/emulator/system-images/platform-tools/adb`] = { bytes: `adb-${version}`, executable: true };
    linuxFiles[`/opt/pico/${version}/emulator/lib/emulator_controller.proto`] = { bytes: `proto-${version}` };
  }
  const linuxIO = toolchainIOFromTree({ platform: "linux", home: "/home/dev", env: { PICO_HOME: "/opt/pico" }, files: linuxFiles });
  const linux = await packerToolchain({}, linuxIO, probe);
  assert.ok(!("error" in linux), JSON.stringify(linux));
  assert.equal(linux.bin, "/opt/pico/6.1/editor/spatialbundle/spatialbundle");
  assert.equal(linux.selection.version, "6.1");
  clearAdbResolutionCache();
  const linuxAdb = resolveAdbExecutable(linuxIO);
  assert.equal(linuxAdb.status, "ok");
  assert.equal(linuxAdb.path, "/opt/pico/6.1/emulator/system-images/platform-tools/adb");
  assert.ok(isToolchainFailure(resolveOperationToolchain({ required: ["editor"], primary: "editor" }, linuxIO)));
  clearAdbResolutionCache();
});

test("S6 matrix: the ONE legacy `which adb` probe left in the server is bounded to validate_toolchain and does not spread", () => {
  // Honest scoping for the rows above. The matrix proves that the operations it exercises launch
  // no legacy fallback; it does NOT claim the whole server is free of one. `validateToolchain`'s
  // own `findAdb()` still shells out to `which adb` and then a version-joined platform-tools path,
  // ignoring $PICO_ADB entirely — a deferred S4 item, not this task's to change. What must not
  // happen is a SECOND consumer picking that habit back up, so the residue is pinned here by
  // count and by location.
  const offenders = [];
  for (const name of fs.readdirSync(path.join(repoRoot, "src")).filter((n) => n.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(repoRoot, "src", name), "utf8");
    text.split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
      if (/run\(\s*"which"\s*,\s*\[\s*"adb"/.test(line)) offenders.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, ["toolchain.ts:483"], "a `which adb` probe appeared outside validate_toolchain's findAdb()");

  // …and it has exactly one caller, which is validate_toolchain's report.
  const toolchainSource = fs.readFileSync(path.join(repoRoot, "src", "toolchain.ts"), "utf8");
  const callSites = toolchainSource.split("\n").filter((line) => /\bfindAdb\(/.test(line) && !/export async function findAdb/.test(line));
  assert.equal(callSites.length, 1, `findAdb() gained a caller: ${callSites.join(" | ")}`);
  assert.match(callSites[0], /const adb = await findAdb\(root, sel\?\.version\)/);
  // Nothing else may IMPORT it. (`src/preflight.ts` has a same-named local helper of its own; it
  // walks io.exec over the selection-derived candidates and never shells out, so a name match
  // there is not a use of this probe.)
  const importers = fs.readdirSync(path.join(repoRoot, "src"))
    .filter((n) => n.endsWith(".ts") && n !== "toolchain.ts")
    .filter((n) => /import\s*\{[^}]*\bfindAdb\b[^}]*\}\s*from\s*"\.\/toolchain\.js"/s.test(fs.readFileSync(path.join(repoRoot, "src", n), "utf8")));
  assert.deepEqual(importers, [], "no module outside src/toolchain.ts may reach the legacy adb probe");
});
