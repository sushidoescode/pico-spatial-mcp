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
  intrinsicsFromFov,
  registerVirtualCameraTools,
  renderVirtualFrame,
} = await import("../dist/virtualcamera.js");

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
  await client.close();
  const textOf = (result) => (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.equal(typo.isError, true);
  assert.match(textOf(typo), /widht/);
  assert.equal(conflictingPose.isError, true);
  assert.match(textOf(conflictingPose), /position\+target OR yawDeg\/pitchDeg/);
  assert.notEqual(objectConfig.isError, true);
  assert.match(textOf(objectConfig), /SPZ is not supported/);
  ok("MCP registers virtual_camera_frame, passes strict object configs, and rejects typo/conflicting-pose inputs");
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
  } catch (error) {
    fail(`real render: ${error.stack ?? error.message}`);
  }
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\nVirtual-camera test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
