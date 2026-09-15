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
  for (const name of ["bundle.ts", "editorexport.ts", "bundlediff.ts", "workflow.ts", "editor.ts"]) {
    const text = fs.readFileSync(path.join(repoRoot, "src", name), "utf8");
    assert.match(text, /resolveOperationToolchain/, `${name} must resolve through ./toolchain.js`);
  }
});
