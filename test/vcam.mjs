// v28.0 world-model virtual camera: deterministic host render + app->splat frame mapping.
// Run: npm run test:vcam
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let failures = 0;
const ok = (message) => console.log(`  ok   ${message}`);
const fail = (message) => { console.log(`  FAIL ${message}`); failures += 1; };
const skip = (message) => console.log(`  SKIP ${message}`);

const {
  appPoseToSplatPose,
  detectVirtualSurfaces,
  intrinsicsFromFov,
  registerVirtualCameraTools,
  renderVirtualFrame,
  selectForegroundPackage,
  virtualCameraFromApp,
} = await import("../dist/virtualcamera.js");
const { buildOccupancyGrid } = await import("../dist/occupancy.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-vcam-test-"));
const fakeSplat = path.join(tmpDir, "fixture.ply");
const worldConfigPath = path.join(tmpDir, "world.json");
const calibrationPath = path.join(tmpDir, "camera-calibration.json");
const fakeSpz = path.join(tmpDir, "fixture.spz");
fs.writeFileSync(fakeSplat, "fixture only");
fs.writeFileSync(fakeSpz, "not decoded");
fs.writeFileSync(worldConfigPath, JSON.stringify({
  splatPath: fakeSplat,
  offsetApplied: [0, 0.8, 0],
}));
fs.writeFileSync(calibrationPath, JSON.stringify({
  f: 1535.4,
  cx: 1097.6,
  cy: 955.3,
  width: 2160,
  height: 2158,
}));

try {
  const intrinsics = intrinsicsFromFov(400, 300, 90);
  assert.ok(Math.abs(intrinsics.f - 200) < 1e-9);
  assert.deepEqual(intrinsics, { f: intrinsics.f, cx: 200, cy: 150, width: 400, height: 300 });
  ok("fov intrinsics: f = 0.5 * width / tan(fov / 2)");
} catch (error) {
  fail(`fov intrinsics: ${error.message}`);
}

try {
  const pose = appPoseToSplatPose(
    { position: [1, 2, 3], target: [1, 2, 2] },
    [0, 0.8, 0],
  );
  assert.deepEqual(pose, { position: [1, 1.2, 3], target: [1, 1.2, 2] });
  ok("app-frame pose subtracts the occupancy/world offset to reach raw-splat space");
} catch (error) {
  fail(`app->splat mapping: ${error.message}`);
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let capturedConfig;
const fakeExec = async (_python, args, options) => {
  assert.equal(options.timeout, 10 * 60 * 1000);
  capturedConfig = JSON.parse(args[1]);
  fs.mkdirSync(path.dirname(capturedConfig.views[0].out), { recursive: true });
  fs.writeFileSync(capturedConfig.views[0].out, ONE_PIXEL_PNG);
  return {
    stdout: JSON.stringify({ points: 42, views: [{ ...capturedConfig.views[0], pointsRendered: 24 }] }),
    stderr: "",
  };
};

try {
  const rendered = await renderVirtualFrame({
    worldConfig: worldConfigPath,
    position: [1, 2, 3],
    target: [1, 2, 2],
    width: 400,
    height: 300,
    fovDeg: 90,
    exec: fakeExec,
  });
  assert.deepEqual(capturedConfig.views[0].C, [1, 1.2, 3]);
  assert.deepEqual(capturedConfig.views[0].T, [1, 1.2, 2]);
  assert.equal(capturedConfig.splat, fakeSplat);
  assert.equal(rendered.pointsRendered, 24);
  assert.ok(Math.abs(rendered.intrinsics.f - 200) < 1e-9);
  assert.match(rendered.honesty, /host-side synthetic/i);
  ok("render config uses the resolved splat, mapped pose, timeout, and explicit honesty label");
} catch (error) {
  fail(`render config: ${error.stack ?? error.message}`);
}

try {
  const rendered = await renderVirtualFrame({
    worldConfig: worldConfigPath,
    position: [0, 1.8, 0],
    yawDeg: 0,
    pitchDeg: 0,
    calibratedIntrinsics: true,
    calibrationPath,
    exec: fakeExec,
  });
  assert.deepEqual(rendered.intrinsics, {
    f: 1535.4,
    cx: 1097.6,
    cy: 955.3,
    width: 2160,
    height: 2158,
  });
  assert.equal(capturedConfig.f, 1535.4);
  assert.equal(capturedConfig.cx, 1097.6);
  assert.equal(capturedConfig.cy, 955.3);
  assert.deepEqual(capturedConfig.views[0].T.map((v) => +v.toFixed(6)), [0, 1, -1]);
  ok("calibrated mode loads persisted f/cx/cy and yaw 0 faces app-frame -Z");
} catch (error) {
  fail(`calibrated intrinsics: ${error.stack ?? error.message}`);
}

try {
  await assert.rejects(
    renderVirtualFrame({
      worldConfig: worldConfigPath,
      position: [0, 1.8, 0],
      yawDeg: 0,
      calibratedIntrinsics: true,
      calibrationPath,
      width: 1080,
      height: 2158,
      exec: fakeExec,
    }),
    /preserve the calibration aspect ratio/i,
  );
  await assert.rejects(
    renderVirtualFrame({ worldConfig: worldConfigPath, position: [0, 1, 0], target: [0, 1, 0], exec: fakeExec }),
    /target must differ/i,
  );
  await assert.rejects(
    renderVirtualFrame({ worldConfig: worldConfigPath, position: [0, 1, 0], target: [0, 2, 0], exec: fakeExec }),
    /parallel to world up/i,
  );
  await assert.rejects(
    renderVirtualFrame({ splatPath: fakeSpz, position: [0, 1, 0], yawDeg: 0, exec: fakeExec }),
    /requires a decoded \.ply.*SPZ is not supported/i,
  );
  ok("calibrated resizes preserve aspect; degenerate looks and unsupported SPZ fail closed");
} catch (error) {
  fail(`camera contract validation: ${error.stack ?? error.message}`);
}

// v29.2: the CMIO transport needs raw 1280x720 BGRA, not a 1280x1280 PNG.
// renderVirtualFrame fails closed on a missing splat before it ever builds the renderer config
// (resolveWorld's existsSync gate), so the fixture must actually exist for exec to be reached.
// It lives in this file's own mkdtemp directory rather than at a fixed /tmp path this process does
// not own — a hardcoded /tmp/fake.ply is both a collision between concurrent runs and an
// unconditional unlink of a path that may belong to something else.
const fakePlyPath = path.join(tmpDir, "fake.ply");
fs.writeFileSync(fakePlyPath, "fixture only");
const bgraCalls = [];
const bgraFakeExec = async (file, args) => { bgraCalls.push(JSON.parse(args[1])); return { stdout: '{"views":[{"pointsRendered":123}]}' }; };
try {
  await renderVirtualFrame({
    splatPath: fakePlyPath, position: [0, 1.6, 0], target: [0, 1.6, -1],
    width: 1280, height: 720, fovDeg: 70, emitBgra: true, exec: bgraFakeExec,
  });
} catch { /* the existence gate fails with a fake exec; the config is what we assert */ }
try { fs.unlinkSync(fakePlyPath); } catch {}
const cfg = bgraCalls[0] ?? {};
cfg.emitBgra === true ? ok("emitBgra reaches the renderer config") : fail(`emitBgra missing: ${JSON.stringify(cfg)}`);
typeof cfg.views?.[0]?.bgraOut === "string" && cfg.views[0].bgraOut.endsWith(".bgra")
  ? ok("a per-view bgraOut path is supplied") : fail(`bgraOut missing: ${JSON.stringify(cfg.views)}`);
cfg.W === 1280 && cfg.H === 720 ? ok("720p is passed through, not the 1280x1280 default") : fail(`bad dims: ${cfg.W}x${cfg.H}`);

// Direct MCP regression: registration and strict/cross-field schemas are part of the delivered API.
try {
  const server = new McpServer({ name: "vcam-input-test", version: "0.0.0" });
  registerVirtualCameraTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vcam-input-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "virtual_camera_frame"));
  assert.ok(listed.tools.some((tool) => tool.name === "virtual_camera_surfaces"));
  const typo = await client.callTool({
    name: "virtual_camera_frame",
    arguments: { splatPath: fakeSplat, position: [0, 1, 0], yawDeg: 0, widht: 400 },
  });
  const conflictingPose = await client.callTool({
    name: "virtual_camera_frame",
    arguments: { splatPath: fakeSplat, position: [0, 1, 0], target: [0, 1, -1], yawDeg: 0 },
  });
  const objectConfig = await client.callTool({
    name: "virtual_camera_frame",
    arguments: { worldConfig: { splatPath: fakeSpz, offsetApplied: [0, 0.8, 0] }, position: [0, 1, 0], yawDeg: 0 },
  });
  const surfaceTypo = await client.callTool({
    name: "virtual_camera_surfaces",
    arguments: { semanticScenePath: worldConfigPath, position: [0, 1, 0], yawDeg: 0, minVisiblePercent: 50 },
  });
  await client.close();
  const textOf = (result) => (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.equal(typo.isError, true);
  assert.match(textOf(typo), /widht/);
  assert.equal(conflictingPose.isError, true);
  assert.match(textOf(conflictingPose), /position\+target OR yawDeg\/pitchDeg/);
  assert.notEqual(objectConfig.isError, true);
  assert.match(textOf(objectConfig), /SPZ is not supported/);
  assert.equal(surfaceTypo.isError, true);
  assert.match(textOf(surfaceTypo), /minVisiblePercent/);
  ok("MCP registers both virtual-camera tools, passes strict object configs, and rejects typo/conflicting-pose inputs");
} catch (error) {
  fail(`MCP registration/schema: ${error.stack ?? error.message}`);
}

// Real renderer smoke: self-skips in CI or on hosts without the scanned ramen world + numpy venv.
const ramenOccupancy = path.join(os.homedir(), ".pico-mcp/artifacts/ramen-v19.occupancy.json");
const picoPython = path.join(os.homedir(), ".pico/venv/bin/python");
let realReady = fs.existsSync(ramenOccupancy) && fs.existsSync(picoPython);
if (realReady) {
  try {
    const world = JSON.parse(fs.readFileSync(ramenOccupancy, "utf8"));
    realReady = typeof world.source === "string" && fs.existsSync(world.source);
  } catch {
    realReady = false;
  }
}

if (!realReady) {
  skip("real render: ramen occupancy/splat or ~/.pico numpy venv unavailable");
} else {
  try {
    const rendererPath = path.resolve("scripts/py/splat_perspective.py");
    const projectionCode = [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('splat_perspective',sys.argv[1])",
      "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "a=m.project_box([0,0,-5],[1,1,1],[0,0,0],[0,0,-1],640,640,90)",
      "b=m.project_box([0,0,-5],[1,1,1],[0,0,0],[0,0,-1],640,640,90,320,300,310)",
      "print(json.dumps([a,b]))",
    ].join(";");
    const projected = JSON.parse(execFileSync(picoPython, ["-c", projectionCode, rendererPath], { encoding: "utf8" }));
    assert.deepEqual(projected, [[284, 284, 355, 355], [264, 274, 335, 345]]);
    ok("renderer box projection honors centered and calibrated principal points");

    const options = {
      worldConfig: ramenOccupancy,
      position: [0.034, 1.896, 0.147],
      yawDeg: 0,
      pitchDeg: 0,
      width: 640,
      height: 640,
      fovDeg: 70,
      maxPoints: 500_000,
    };
    const first = await renderVirtualFrame(options);
    const firstBytes = fs.readFileSync(first.imagePath);
    const second = await renderVirtualFrame(options);
    const secondBytes = fs.readFileSync(second.imagePath);
    const width = firstBytes.readUInt32BE(16);
    const height = firstBytes.readUInt32BE(20);
    assert.equal(firstBytes.subarray(1, 4).toString("ascii"), "PNG");
    assert.ok(firstBytes.length > 50 * 1024, `PNG only ${firstBytes.length} bytes`);
    assert.deepEqual([width, height], [640, 640]);
    assert.equal(
      crypto.createHash("sha256").update(firstBytes).digest("hex"),
      crypto.createHash("sha256").update(secondBytes).digest("hex"),
    );
    ok(`real ramen render is a deterministic 640x640 PNG (${(firstBytes.length / 1024).toFixed(1)} KB)`);

    // v29.2: raw BGRA sibling — real-renderer coverage. The fake-exec test above only proves the
    // config is *constructed*; it never runs Python, so it cannot catch a bad channel order, a
    // wrong byte count, or a byte-count gate that silently stops checking. This block does.
    const bgraOptions = { ...options, width: 1280, height: 720, emitBgra: true };
    const bgraRendered = await renderVirtualFrame(bgraOptions);
    assert.ok(bgraRendered.bgraPath && fs.existsSync(bgraRendered.bgraPath), "bgraPath must exist");
    const bgraBytes = fs.readFileSync(bgraRendered.bgraPath);
    assert.equal(bgraBytes.length, 1280 * 720 * 4, `expected exactly ${1280 * 720 * 4} bytes, got ${bgraBytes.length}`);
    assert.match(bgraRendered.bgraSha256, /^[0-9a-f]{64}$/, "bgraSha256 must be 64 lowercase hex chars");
    assert.equal(
      crypto.createHash("sha256").update(bgraBytes).digest("hex"),
      bgraRendered.bgraSha256,
      "returned bgraSha256 must match the file's actual hash",
    );
    ok(`real ramen render emits an exact ${bgraBytes.length}-byte BGRA sibling (bgraSha256 ${bgraRendered.bgraSha256.slice(0, 12)}…)`);

    // Channel order: decode the PNG's own pixel(0,0) via PIL (this repo has no in-process PNG
    // decoder — that's the whole reason the raw sibling exists) and check the raw file's first
    // 3 bytes are that RGB triple REVERSED, with an opaque 4th byte. A swapped channel order
    // would pass every size/hash check above and only show up as wrong colors on-device later.
    const pixelCheckCode = [
      "import sys, json",
      "from PIL import Image",
      "png_path, bgra_path = sys.argv[1], sys.argv[2]",
      "img = Image.open(png_path).convert('RGB')",
      "r, g, b = img.getpixel((0, 0))",
      "fh = open(bgra_path, 'rb')",
      "raw4 = list(fh.read(4))",
      "fh.close()",
      "print(json.dumps({'rgb': [r, g, b], 'raw4': raw4}))",
    ].join(";");
    const pixelCheck = JSON.parse(execFileSync(
      picoPython,
      ["-c", pixelCheckCode, bgraRendered.imagePath, bgraRendered.bgraPath],
      { encoding: "utf8" },
    ));
    const [pr, pg, pb] = pixelCheck.rgb;
    // Degeneracy guard: if R happened to equal B, [pb,pg,pr,255] and [pr,pg,pb,255] are the SAME
    // array and the assertion below becomes a tautology that passes identically for correct BGRA
    // and for RGBA wrongly passed through. It discriminates today only incidentally (this pose
    // gives rgb≈(28,32,26)); a world or pose change could quiet it with no failure signal.
    assert.notEqual(
      pr, pb,
      `pixel(0,0) has R == B (${pr}), so the channel-order check below cannot distinguish BGRA from RGBA — pick a pixel or pose where they differ`,
    );
    assert.deepEqual(
      pixelCheck.raw4,
      [pb, pg, pr, 255],
      `expected BGRA [${pb},${pg},${pr},255] from PNG rgb (${pr},${pg},${pb}), got ${JSON.stringify(pixelCheck.raw4)}`,
    );
    ok(`BGRA channel order verified against the PNG's own pixel(0,0): rgb=(${pr},${pg},${pb}) -> raw [${pixelCheck.raw4.join(",")}]`);

    // Cluster refusal: emitBgra + non-empty clusters must refuse to write the raw sibling rather
    // than silently drawing box overlays into what's supposed to be the PNG's exact pixel sibling.
    // renderVirtualFrame never sets clusters (Task 7's own design note), so this invokes the
    // renderer script directly with a raw config, the same way renderVirtualFrame's exec does.
    const refusalSplat = JSON.parse(fs.readFileSync(ramenOccupancy, "utf8")).source;
    const refusalOut = path.join(tmpDir, "cluster-refusal.png");
    const refusalBgraOut = path.join(tmpDir, "cluster-refusal.bgra");
    const refusalConfig = {
      splat: refusalSplat,
      maxPts: 5000,
      W: 64,
      H: 64,
      fov: 70,
      emitBgra: true,
      clusters: [{ id: 0, center: [0, 0, -1], size: [1, 1, 1] }],
      views: [{ name: "cluster-refusal", C: [0, 0, 0], T: [0, 0, -1], out: refusalOut, bgraOut: refusalBgraOut }],
    };
    let refusalError = null;
    try {
      execFileSync(picoPython, [rendererPath, JSON.stringify(refusalConfig)], { encoding: "utf8" });
    } catch (error) {
      refusalError = error;
    }
    assert.ok(refusalError, "emitBgra + non-empty clusters must fail the renderer process, not succeed");
    assert.match(String(refusalError.stderr ?? ""), /clusters must be empty/i);
    assert.ok(!fs.existsSync(refusalBgraOut), "the raw sibling must not be written when clusters are present");
    ok("emitBgra + clusters refuses to write the raw sibling instead of silently mismatching the PNG");
  } catch (error) {
    fail(`real render: ${error.stack ?? error.message}`);
  }
}

// ── virtual_camera_surfaces ────────────────────────────────────────────────────────────────────
const syntheticScene = {
  floorY: 0,
  bounds: { min: [-3, 0, -6], max: [3, 3, 1] },
  objects: [
    { id: 1, label: "wooden table", center: [0, 0.45, -3], size: [1.5, 0.9, 1] },
    { id: 2, label: "outside table", center: [6, 0.5, -3], size: [1, 1, 1] },
    { id: 3, label: "mostly outside table", center: [20, 0.5, -5], size: [40, 1, 1] },
  ],
};
const wallPoints = [];
for (let ix = 0; ix <= 160; ix++)
  for (let iy = 0; iy <= 80; iy++)
    for (let iz = 0; iz <= 8; iz++) wallPoints.push(-2 + ix * 0.025, iy * 0.025, 0.7 + iz * 0.025);
const wallGrid = buildOccupancyGrid(new Float32Array(wallPoints), {
  cell: 0.05,
  minPointsPerCell: 1,
  trim: false,
});

try {
  const visible = detectVirtualSurfaces({
    scene: syntheticScene,
    occupancy: wallGrid,
    position: [0, 1.4, 0],
    target: [0, 0.9, -3],
    width: 640,
    height: 480,
    fovDeg: 70,
  });
  const floor = visible.surfaces.find((surface) => surface.label === "floor");
  const table = visible.surfaces.find((surface) => surface.label === "wooden table");
  assert.ok(floor && floor.visibleFraction > 0 && floor.losClear === true);
  assert.ok(table && table.visibleFraction > 0 && table.losClear === true);
  assert.deepEqual(table.extent, [1.5, 0, 1]);
  assert.ok(table.distanceM > 2 && table.distanceM < 4);
  assert.ok(!visible.surfaces.some((surface) => surface.label === "outside table"));
  const highThreshold = detectVirtualSurfaces({
    scene: syntheticScene,
    position: [0, 1.4, 0],
    target: [0, 0.9, -3],
    width: 640,
    height: 480,
    fovDeg: 70,
    minVisibleFraction: 0.5,
  });
  assert.ok(!highThreshold.surfaces.some((surface) => surface.label === "mostly outside table"));
  assert.ok(highThreshold.surfaces.every((surface) => surface.losClear === null));

  const yawOutside = detectVirtualSurfaces({
    scene: {
      objects: [{ id: 9, label: "yaw outside table", center: [0, 0.9, -0.7], size: [0.2, 0.2, 0.2] }],
    },
    position: [0, 1, 0],
    target: [Math.SQRT1_2, 1, -Math.SQRT1_2],
    width: 640,
    height: 480,
    fovDeg: 60,
  });
  assert.ok(!yawOutside.surfaces.some((surface) => surface.label === "yaw outside table"));

  const occluded = detectVirtualSurfaces({
    scene: syntheticScene,
    occupancy: wallGrid,
    position: [0, 1.4, 1.5],
    target: [0, 0.9, -3],
    width: 640,
    height: 480,
    fovDeg: 70,
  });
  assert.equal(occluded.surfaces.find((surface) => surface.label === "wooden table")?.losClear, false);
  assert.match(visible.honesty, /structural evidence/i);
  ok("surface simulation reports honest coverage/geometry/LOS and rejects arbitrary-yaw phantom corners");
} catch (error) {
  fail(`surface simulation: ${error.stack ?? error.message}`);
}

const ramenSemantic = path.join(os.homedir(), ".pico-mcp/artifacts/ramen-v19-semantic-app.json");
if (!fs.existsSync(ramenSemantic) || !fs.existsSync(ramenOccupancy)) {
  skip("real surfaces: ramen semantic/occupancy artifacts unavailable");
} else {
  try {
    const report = detectVirtualSurfaces({
      semanticScenePath: ramenSemantic,
      occupancyPath: ramenOccupancy,
      position: [0.034, 1.896, 0.147],
      yawDeg: 0,
      pitchDeg: 0,
      calibratedIntrinsics: true,
      calibrationPath,
    });
    const floor = report.surfaces.find((surface) => surface.label === "floor");
    assert.ok(floor);
    assert.ok(floor.visibleFraction > 0.25 && floor.visibleFraction < 0.4);
    assert.ok(floor.detectedPatchVisibleFraction >= 0.5);
    assert.equal(floor.losClear, false);
    ok(`real ramen floor reports honest whole-surface visibility ${floor.visibleFraction} (detected patches ${floor.detectedPatchVisibleFraction}; center LOS blocked)`);
  } catch (error) {
    fail(`real surfaces: ${error.stack ?? error.message}`);
  }
}

// ── virtual_camera_from_app ────────────────────────────────────────────────────────────────
const appCapturePath = path.join(tmpDir, "app-capture.png");
const appVirtualPath = path.join(tmpDir, "app-virtual.png");
const appComparisonPath = path.join(tmpDir, "app-comparison.png");
for (const imagePath of [appCapturePath, appVirtualPath, appComparisonPath]) {
  fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
}

try {
  const calls = {};
  const surfaceReport = {
    surfaces: [{ label: "floor", visibleFraction: 0.31, losClear: false }],
    honesty: "simulated scene understanding from scanned geometry — structural evidence",
  };
  const result = await virtualCameraFromApp({
    serial: "emulator-5554",
    worldConfig: worldConfigPath,
    semanticScenePath: worldConfigPath,
    occupancyPath: worldConfigPath,
    calibrationPath,
    outDir: tmpDir,
    captureApp: async (options) => {
      calls.capture = {
        packageName: options.packageName,
        serial: options.serial,
        outPath: options.outPath,
      };
      return { packageName: "com.example.ramenlos", capturePath: appCapturePath, foregroundVerified: true };
    },
    renderFrame: async (options) => {
      calls.render = {
        position: [...options.position],
        yawDeg: options.yawDeg,
        pitchDeg: options.pitchDeg,
        calibratedIntrinsics: options.calibratedIntrinsics,
        calibrationPath: options.calibrationPath,
        maxPoints: options.maxPoints,
      };
      return {
        imagePath: appVirtualPath,
        pose: { position: options.position, yawDeg: options.yawDeg, pitchDeg: options.pitchDeg },
        honesty: "host-side synthetic render; usd_host_render at best",
      };
    },
    detectSurfaces: (options) => {
      calls.surfaces = {
        position: [...options.position],
        yawDeg: options.yawDeg,
        pitchDeg: options.pitchDeg,
        calibratedIntrinsics: options.calibratedIntrinsics,
        calibrationPath: options.calibrationPath,
      };
      return surfaceReport;
    },
    composeFrames: async (options) => {
      calls.compose = {
        emulatorCapturePath: options.emulatorCapturePath,
        virtualFramePath: options.virtualFramePath,
        outDir: options.outDir,
        packageName: options.packageName,
      };
      return { imagePath: appComparisonPath };
    },
  });

  const derivedPosition = [0.034, 1.896, 0.147];
  assert.equal(calls.capture.packageName, undefined);
  assert.equal(calls.capture.serial, "emulator-5554");
  assert.equal(path.dirname(calls.capture.outPath), tmpDir);
  for (const cameraCall of [calls.render, calls.surfaces]) {
    assert.deepEqual(cameraCall.position, derivedPosition);
    assert.equal(cameraCall.yawDeg, 0);
    assert.equal(cameraCall.pitchDeg, 20);
    assert.equal(cameraCall.calibratedIntrinsics, true);
    assert.equal(cameraCall.calibrationPath, calibrationPath);
  }
  assert.deepEqual(calls.render.position, calls.surfaces.position);
  assert.equal(calls.render.yawDeg, calls.surfaces.yawDeg);
  assert.equal(calls.render.pitchDeg, calls.surfaces.pitchDeg);
  assert.equal(calls.render.maxPoints, 1_500_000);
  assert.equal(calls.compose.emulatorCapturePath, appCapturePath);
  assert.equal(calls.compose.virtualFramePath, appVirtualPath);
  assert.equal(calls.compose.outDir, tmpDir);
  assert.equal(calls.compose.packageName, "com.example.ramenlos");

  assert.equal(result.packageName, "com.example.ramenlos");
  assert.equal(result.serial, "emulator-5554");
  assert.equal(result.foregroundVerified, true);
  assert.equal(result.emulatorCapturePath, appCapturePath);
  assert.equal(result.virtualFramePath, appVirtualPath);
  assert.deepEqual(result.surfaces, surfaceReport);
  assert.equal(result.sideBySidePath, appComparisonPath);
  assert.deepEqual(result.pose.position, derivedPosition);
  assert.equal(result.pose.yawDeg, 0);
  assert.equal(result.pose.pitchDeg, 20);
  assert.equal(result.poseAssumed, true);
  assert.match(result.poseSource, /position.*derived/i);
  assert.match(result.poseSource, /orientation.*(?:assumed|calibrated)|(?:assumed|calibrated).*orientation/i);
  assert.match(result.poseSource, /(?:not|no).*live head pose|live head pose.*(?:not|unavailable)/i);
  assert.match(result.honesty, /emulatorCapturePath.*real adb display capture/i);
  assert.match(result.honesty, /virtualFramePath.*host-side synthetic/i);
  assert.match(result.honesty, /usd_host_render.*at best/i);
  assert.match(result.honesty, /(?:no|not).*head pose.*measured|head pose.*(?:not|never) measured/i);
  ok("from-app default uses the derived pose consistently and labels every artifact/evidence boundary");
} catch (error) {
  fail(`from-app deterministic orchestration: ${error.stack ?? error.message}`);
}

try {
  await assert.rejects(
    () => virtualCameraFromApp({
      packageName: "com.example.ramenlos",
      serial: "emulator-5554",
      worldConfig: worldConfigPath,
      semanticScenePath: worldConfigPath,
      assumeSpawnPose: false,
    }),
    /assumeSpawnPose.*false.*(?:explicit )?position|(?:explicit )?position.*required/i,
  );
  ok("from-app fails closed when pose assumption is disabled without an explicit position");
} catch (error) {
  fail(`from-app missing explicit pose: ${error.stack ?? error.message}`);
}

try {
  const multiDisplay = [
    "Display #0:",
    "  topResumedActivity=ActivityRecord{aaa u0 com.picoxr.launcher/.MainActivity t3}",
    "Display #2:",
    "  topResumedActivity=ActivityRecord{bbb u0 com.fleet.ramenlos/.platform.LaunchActivity t21}",
    "ResumedActivity: ActivityRecord{aaa u0 com.picoxr.launcher/.MainActivity t3}",
  ].join("\n");
  assert.equal(selectForegroundPackage(multiDisplay, "com.fleet.ramenlos"), "com.fleet.ramenlos");
  assert.equal(selectForegroundPackage(multiDisplay), "com.fleet.ramenlos");
  assert.throws(
    () => selectForegroundPackage(`${multiDisplay}\ntopResumedActivity=ActivityRecord{ccc u0 com.fleet.dashboard/.platform.LaunchActivity t19}`),
    /multiple.*fleet|ambiguous/i,
  );
  ok("from-app foreground selection searches all resumed displays and fails closed on ambiguous fleet apps");
} catch (error) {
  fail(`from-app multi-display foreground: ${error.stack ?? error.message}`);
}

try {
  const makeCall = (packageName) => {
    const comparisonPath = path.join(tmpDir, `${packageName}-comparison.png`);
    return virtualCameraFromApp({
      packageName,
      serial: "emulator-5554",
      worldConfig: worldConfigPath,
      semanticScenePath: worldConfigPath,
      position: [0, 1.8, 0],
      yawDeg: 45,
      outDir: tmpDir,
      captureApp: async (options) => {
        fs.writeFileSync(options.outPath, ONE_PIXEL_PNG);
        return { packageName, capturePath: options.outPath, foregroundVerified: true };
      },
      renderFrame: async () => ({ imagePath: appVirtualPath }),
      detectSurfaces: () => ({ surfaces: [] }),
      composeFrames: async () => {
        fs.writeFileSync(comparisonPath, ONE_PIXEL_PNG);
        return { imagePath: comparisonPath };
      },
    });
  };
  const [first, second] = await Promise.all([
    makeCall("com.example.concurrenta"),
    makeCall("com.example.concurrentb"),
  ]);
  assert.notEqual(first.emulatorCapturePath, second.emulatorCapturePath);
  for (const result of [first, second]) {
    assert.equal(result.poseAssumed, false);
    assert.equal(result.orientationAssumed, true);
    assert.match(result.poseSource, /yaw.*caller/i);
    assert.match(result.poseSource, /pitch.*(?:default|assum)/i);
  }
  ok("from-app isolates concurrent captures and reports partial yaw/pitch provenance honestly");
} catch (error) {
  fail(`from-app concurrency/orientation provenance: ${error.stack ?? error.message}`);
}

try {
  const server = new McpServer({ name: "vcam-from-app-input-test", version: "0.0.0" });
  registerVirtualCameraTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vcam-from-app-input-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "virtual_camera_from_app"));
    const typo = await client.callTool({
      name: "virtual_camera_from_app",
      arguments: {
        packageName: "com.example.ramenlos",
        serial: "emulator-5554",
        worldConfig: worldConfigPath,
        semanticScenePath: worldConfigPath,
        packagName: "com.example.typo",
      },
    });
    const conflictingPose = await client.callTool({
      name: "virtual_camera_from_app",
      arguments: {
        packageName: "com.example.ramenlos",
        serial: "emulator-5554",
        worldConfig: worldConfigPath,
        semanticScenePath: worldConfigPath,
        assumeSpawnPose: false,
        position: [0, 1.8, 0],
        target: [0, 1.8, -1],
        yawDeg: 0,
      },
    });
    const textOf = (result) => (result.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert.equal(typo.isError, true);
    assert.match(textOf(typo), /packagName/);
    assert.equal(conflictingPose.isError, true);
    assert.match(textOf(conflictingPose), /position\+target OR yawDeg\/pitchDeg/);
  } finally {
    await client.close();
  }
  ok("MCP registers virtual_camera_from_app and rejects unknown/conflicting-pose inputs");
} catch (error) {
  fail(`from-app MCP registration/schema: ${error.stack ?? error.message}`);
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\nVirtual-camera test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
