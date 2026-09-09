import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createBoundCameraActionAdapter, keyHold, registerCameraDriveTools } from "../dist/cameradrive.js";
import { registerDeployTools } from "../dist/deploy.js";
import { registerEyeTools } from "../dist/eye.js";
import { registerUsdRenderTools } from "../dist/usdrender.js";
import { registerDoorTools } from "../dist/doors.js";
import { createLiveInAppLocomotionDependencies } from "../dist/worldlocomotion.js";

function denyLiveEffects(t) {
  const calls = [];
  const deny = (name) => () => {
    calls.push(name);
    throw new Error(`unexpected live effect: ${name}`);
  };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  }
  for (const name of ["connect", "createConnection", "createServer"]) {
    t.mock.method(net, name, deny(`net.${name}`));
  }
  t.mock.method(net.Socket.prototype, "connect", deny("net.Socket.connect"));
  t.mock.method(net.Server.prototype, "listen", deny("net.Server.listen"));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(calls, [], "dependency admission must attempt zero real spawns or sockets");
  });
  return calls;
}

const cameraDependencies = {
  platform: "darwin",
  // Plausible fake discovery must never unlock the omitted production action lanes.
  bindWindow: async () => ({ ok: true, binding: {
    discoveryFile: "/fixture/discovery/pid_99.ini", discoveredSerial: "emulator-5554",
    address: "127.0.0.1:8554", qemuPid: 99, tokenPresent: false,
    onlineEmulatorSerials: ["emulator-5554"], bindingMethod: "discovery-pid-window",
    qemuWindowOwnerPid: 99, qemuWindowId: 7,
    qemuWindowX: 100, qemuWindowY: 100, qemuWindowWidth: 720, qemuWindowHeight: 720, qemuWindowScale: 2,
  } }),
  probeHostWindow: async () => ({ status: "ok", occluded: false, frontmost: true,
    overlappingOwners: [], observedAt: "2026-09-09T00:00:00.000Z", qemuWindowId: 7,
    qemuWindowOwnerPid: 99, durationMs: 0, detail: "injected fixture" }),
  focus: async () => null,
  applyMoves: async () => ({ error: null, actionReceipts: [] }),
  settleCapture: async () => { throw new Error("capture is outside this registration test"); },
  writeShrunk: async () => { throw new Error("image output is outside this registration test"); },
};

test("camera registration rejects every incomplete dependency set before exposing handlers or live effects", (t) => {
  denyLiveEffects(t);
  for (const missing of Object.keys(cameraDependencies)) {
    const injected = { ...cameraDependencies };
    delete injected[missing];
    const handlers = new Map();
    assert.throws(
      () => registerCameraDriveTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, injected),
      (error) => error instanceof Error && error.message.includes("registerCameraDriveTools") && error.message.includes(missing),
      `omitting ${missing} must throw synchronously and identify the missing key`,
    );
    assert.equal(handlers.size, 0, "incomplete injection must not expose a handler");
  }
});

test("camera registration names every missing key and rejects explicit undefined dependencies", (t) => {
  denyLiveEffects(t);
  const server = { registerTool: () => { throw new Error("must reject before registration"); } };
  assert.throws(() => registerCameraDriveTools(server, { platform: "darwin", bindWindow: cameraDependencies.bindWindow }), (error) =>
    ["probeHostWindow", "focus", "applyMoves", "settleCapture", "writeShrunk"].every((key) => error.message.includes(key)));
  assert.throws(() => registerCameraDriveTools(server, { ...cameraDependencies, applyMoves: undefined }), /applyMoves/);
});

test("prototype-held camera dependencies cannot be mistaken for absent injection", (t) => {
  denyLiveEffects(t);
  const partial = Object.create({ platform: "darwin", bindWindow: cameraDependencies.bindWindow });
  let registrations = 0;
  const server = { registerTool: () => { registrations++; } };
  assert.throws(() => registerCameraDriveTools(server, partial), /registerCameraDriveTools.*probeHostWindow.*applyMoves/);
  assert.equal(registrations, 0);
  registerCameraDriveTools(server, Object.create(cameraDependencies));
  assert.equal(registrations, 2, "a complete prototype-held dependency set stays injectable");
});

test("complete camera injection handles no-capture motion without production processes or sockets", async (t) => {
  denyLiveEffects(t);
  const handlers = new Map();
  registerCameraDriveTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, cameraDependencies);
  const result = await handlers.get("capture_orbit")({ serial: "emulator-5554", moves: [{ key: "w" }], capture: false });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /moves applied \(no capture requested\)/);
});

const unused = () => { throw new Error("dependency use is outside this registration test"); };
const registrationCases = [
  ["registerDeployTools", registerDeployTools, {
    runFn: unused, runBinaryFn: unused, probeDeviceIdentityFn: unused, resolveAdbFn: unused, sleepFn: unused,
  }],
  ["registerEyeTools", registerEyeTools, {
    sendXrRecenterFn: unused, runBinaryFn: unused, analyzeFrameFn: unused, analyzeColorKeysFn: unused, resolveAdbFn: unused,
  }],
  ["registerUsdRenderTools", registerUsdRenderTools, {
    runFn: unused, analyzeFrameFn: unused, appendUsdHostRenderEntryFn: unused, usdrecordBinFn: unused,
  }],
];
for (const [owner, register, complete] of registrationCases) {
  test(`${owner} rejects incomplete injections before exposing handlers or live effects`, (t) => {
    denyLiveEffects(t);
    for (const missing of Object.keys(complete)) {
      const injected = { ...complete };
      delete injected[missing];
      let registrations = 0;
      assert.throws(() => register({ registerTool: () => { registrations++; } }, injected), (error) =>
        error instanceof Error && error.message.includes(owner) && error.message.includes(missing));
      assert.equal(registrations, 0);
    }
    let registrations = 0;
    register({ registerTool: () => { registrations++; } }, complete);
    assert.ok(registrations > 0, "complete dependency injection remains supported");
  });
}

test("door injection cannot fall through a missing call to the live inner server", (t) => {
  denyLiveEffects(t);
  for (const incomplete of [{ call: undefined }, { unrelated: unused }]) {
    let registrations = 0;
    assert.throws(() => registerDoorTools({ registerTool: () => { registrations++; } }, incomplete), /registerDoorTools.*call/);
    assert.equal(registrations, 0);
  }
});

test("every registered door uses its complete injected callback before any live transport", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-door-injection-"));
  const semanticScenePath = path.join(root, "scene.json");
  fs.writeFileSync(semanticScenePath, JSON.stringify({ objects: [], floorY: 0, bounds: {} }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    ["pico_build_app", { brief: "fixture app" }, "plan_app_spec"],
    ["pico_scan_world", { splatPath: "/fixture/world.ply" }, "semantic_splat_scan"],
    ["pico_place", { semanticScenePath, label: "table" }, "resolve_semantic_placement"],
    ["pico_look", {}, "capture_canonical"],
    ["pico_verify_app", { apkPath: "/fixture/app.apk", packageName: "com.fixture.app" }, "verify_pico_apk"],
    ["pico_measure", { capturePath: "/fixture/frame.png", targets: [{ name: "table", colorKey: [1, 0, 0], expectedPosition: [0, 0, 0] }] }, "measure_placement"],
    ["pico_perf", { packageName: "com.fixture.app", durationSec: 5 }, "perf_diagnose"],
    ["pico_sdk", { symbol: "Stage" }, "vault_api"],
    ["pico_doctor", {}, "validate_toolchain"],
    ["pico_ship", { app: "com.fixture.app" }, "ship_checklist"],
    ["pico_capabilities", {}, "capability_matrix"],
    ["pico_fix", { error: "not rendering" }, "diagnose"],
    ["pico_record", { app: "com.fixture.app", claim: "fixture", evidenceType: "structural" }, "record_verification"],
    ["pico_emulator", { action: "boot" }, "emulator_boot"],
    ["pico_next", {}, "preflight_env"],
    ["pico_loop", { goal: "fixture app", acceptance: [{ kind: "structural" }] }, "plan_app_spec"],
  ];
  for (const [doorName, input, expectedTool] of cases) {
    await t.test(doorName, async (child) => {
      denyLiveEffects(child);
      const handlers = new Map();
      const calls = [];
      registerDoorTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, {
        call: (name, args) => {
          calls.push({ name, args });
          // A synchronous callback failure stops before any later local artifact or ledger
          // work, including the optional probes whose asynchronous failures are tolerated.
          throw new Error("injected door boundary reached");
        },
      });
      const response = await handlers.get(doorName)(input);
      assert.deepEqual(calls.map((call) => call.name), [expectedTool]);
      assert.equal(JSON.parse(response.content[0].text).error, "injected door boundary reached");
    });
  }
});

test("an inherited complete door callback supplies the capture result without a live inner server", async (t) => {
  denyLiveEffects(t);
  const handlers = new Map();
  const calls = [];
  registerDoorTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, Object.create({
    call: async (name, args) => {
      calls.push({ name, args });
      return { status: "captured", path: "/fixture/injected-capture.png" };
    },
  }));
  const response = await handlers.get("pico_look")({});
  assert.deepEqual(calls, [{ name: "capture_canonical", args: {} }]);
  assert.deepEqual(JSON.parse(response.content[0].text), { status: "captured", path: "/fixture/injected-capture.png" });
});

test("bound camera adapter rejects partial action transports before a fake binding can unlock live input", (t) => {
  denyLiveEffects(t);
  const complete = { focusQemu: unused, keyHold: unused, rightDrag: unused };
  for (const missing of Object.keys(complete)) {
    const injected = { ...complete, revalidateWindow: cameraDependencies.bindWindow };
    delete injected[missing];
    assert.throws(() => createBoundCameraActionAdapter("emulator-5554", null, injected), (error) =>
      error instanceof Error && error.message.includes("createBoundCameraActionAdapter") && error.message.includes(missing));
  }
  assert.equal(typeof createBoundCameraActionAdapter("emulator-5554", null, complete).applyRelativeAction, "function");
});

test("prototype-held camera actions cannot fall back through the optional revalidation hook", (t) => {
  denyLiveEffects(t);
  const partial = Object.create({ keyHold: unused, revalidateWindow: cameraDependencies.bindWindow });
  assert.throws(() => createBoundCameraActionAdapter("emulator-5554", null, partial), /createBoundCameraActionAdapter.*focusQemu.*rightDrag/);
  const complete = Object.create({ focusQemu: unused, keyHold: unused, rightDrag: unused });
  assert.equal(typeof createBoundCameraActionAdapter("emulator-5554", null, complete).applyRelativeAction, "function");
});

test("key hold refuses incomplete transport injection synchronously before constructing a gRPC client", (t) => {
  denyLiveEffects(t);
  let connections = 0;
  const complete = {
    getClient: () => { connections++; throw new Error("must reject before client construction"); },
    unary: unused,
    sleep: unused,
    monotonicNs: () => 1n,
  };
  for (const missing of Object.keys(complete)) {
    const injected = { ...complete };
    delete injected[missing];
    // The old async implementation can reject later; retain that promise so the
    // failing synchronous-admission assertion never leaves an unhandled rejection.
    assert.throws(() => {
      const pending = keyHold("emulator-5554", "w", 100, injected);
      pending.catch(() => {});
    }, (error) => error instanceof Error && error.message.includes("keyHold") && error.message.includes(missing));
  }
  assert.equal(connections, 0, "incomplete injection must never construct a client");
});

test("live locomotion factory rejects incomplete runners before resolving adb or constructing transports", (t) => {
  denyLiveEffects(t);
  let resolutions = 0;
  const complete = {
    resolveAdb: () => { resolutions++; return "/fixture/injected-adb"; },
    runText: unused,
    runBytes: unused,
    sleep: unused,
    monotonicNs: () => 1n,
  };
  for (const missing of Object.keys(complete)) {
    const injected = { ...complete };
    delete injected[missing];
    assert.throws(() => createLiveInAppLocomotionDependencies(injected), (error) =>
      error instanceof Error && error.message.includes("createLiveInAppLocomotionDependencies") && error.message.includes(missing));
  }
  assert.equal(resolutions, 0, "dependency completeness must be checked before adb resolution");
  assert.equal(typeof createLiveInAppLocomotionDependencies(complete).requestLocomotion, "function");
  assert.equal(resolutions, 1);
});

test("default door callback shares a pending connection across parallel probes and retries after failure", async (t) => {
  denyLiveEffects(t);
  let connections = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    connections++;
    await new Promise((resolve) => setImmediate(resolve));
    throw new Error("injected connection refusal");
  });
  const handlers = new Map();
  registerDoorTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) });
  for (const expectedConnections of [1, 2]) {
    const response = await handlers.get("pico_doctor")({});
    assert.equal(JSON.parse(response.content[0].text).error, "injected connection refusal");
    assert.equal(connections, expectedConnections,
      "one pending connection must serve the three initial probes; a later invocation can retry its refusal");
  }
});
