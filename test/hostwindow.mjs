import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

const host = await import("../dist/hostwindow.js").catch(() => ({}));
const binding = { qemuWindowId: 7, qemuWindowOwnerPid: 99 };
const window = (id, ownerPid, ownerName, x, y, width = 100, height = 100) => ({
  windowId: id, ownerPid, ownerName, x, y, width, height, alpha: 1, layer: 0,
});
const qemu = window(7, 99, "qemu-system-aarch64", 100, 100);
const desktopSnapshot = JSON.parse(fs.readFileSync(new URL("./fixtures/host-window-snapshot.json", import.meta.url), "utf8"));
const desktopBinding = { qemuWindowId: 25257, qemuWindowOwnerPid: 92857 };

function simulatedHost(t, platform) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (command, args) => {
    calls.push({ command, args });
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    process.kill = () => true;
    queueMicrotask(() => {
      if (command === "swift") process.stdout.emit("data", Buffer.from(JSON.stringify(desktopSnapshot)));
      else process.stderr.emit("data", Buffer.from("unexpected command was intercepted by test"));
      process.emit("close", command === "swift" ? 0 : 1);
    });
    return process;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
  return { calls, probe: (...args) => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    try { return host.probeHostWindow(...args); }
    finally { Object.defineProperty(process, "platform", originalPlatform); }
  } };
}

test("off-macOS host observation is not applicable and runs no host commands", async (t) => {
  for (const platform of ["linux", "win32"]) await t.test(platform, async (t) => {
    const { calls, probe } = simulatedHost(t, platform);
    const result = await probe("emulator-5554");
    assert.equal(result.status, "not_applicable");
    assert.equal(host.hostWindowPrecondition(result), null);
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
    assert.deepEqual(calls, []);
  });
});

test("a bound macOS probe runs one window snapshot and records its duration without rediscovery", async (t) => {
  const { calls, probe } = simulatedHost(t, "darwin");
  const result = await probe("emulator-5554", { ...desktopBinding, discoveredSerial: "emulator-5554" });
  assert.equal(result.status, "ok");
  assert.equal(result.occluded, false);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "swift");
  assert.equal(calls[0].args[0], "-e");
});

test("an unbound macOS probe reports unavailable without rediscovery or a second compile", async (t) => {
  const { calls, probe } = simulatedHost(t, "darwin");
  const result = await probe("emulator-5554");
  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /bound.*window/i);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.deepEqual(calls, []);
});

test("desktop snapshot ignores Dock, menu layers, qemu child windows, and invalid helpers", () => {
  const result = host.evaluateHostWindowOcclusion(desktopBinding, desktopSnapshot);
  assert.equal(result.status, "ok");
  assert.equal(result.occluded, false);
  assert.equal(result.frontmost, true);
  assert.deepEqual(result.overlappingOwners, []);
  assert.equal(host.hostWindowPrecondition(result), null);
});

test("desktop snapshot still detects another process's layer-zero occluder with known or absent alpha", () => {
  for (const alpha of [1, undefined]) {
    const snapshot = structuredClone(desktopSnapshot);
    const occluder = { ...window(415, 415, "Terminal", 100, 100, 500, 500), alpha };
    if (alpha === undefined) delete occluder.alpha;
    snapshot.windows.unshift(occluder);
    const result = host.evaluateHostWindowOcclusion(desktopBinding, snapshot);
    assert.equal(result.status, "ok");
    assert.equal(result.occluded, true);
    assert.deepEqual(result.overlappingOwners, ["Terminal"]);
    assert.equal(host.hostWindowPrecondition(result).code, "host_window_occluded");
  }
});

test("an absent qemu alpha is opaque while invalid target geometry remains unavailable", () => {
  const snapshot = structuredClone(desktopSnapshot);
  const target = snapshot.windows.find((entry) => entry.windowId === desktopBinding.qemuWindowId);
  delete target.alpha;
  assert.equal(host.evaluateHostWindowOcclusion(desktopBinding, snapshot).occluded, false);
  target.width = 0;
  assert.equal(host.evaluateHostWindowOcclusion(desktopBinding, snapshot).status, "unavailable");
});

test("host window probe reports only visible intersections above the exact bound window", () => {
  assert.equal(typeof host.evaluateHostWindowOcclusion, "function");
  const result = host.evaluateHostWindowOcclusion(binding, {
    frontmostOwnerPid: 12,
    windows: [window(1, 12, "Google Chrome", 150, 150), window(2, 12, "Google Chrome", 160, 160),
      window(3, 13, "Terminal", 200, 100), { ...window(4, 14, "Invisible", 110, 110), alpha: 0 },
      qemu, window(5, 15, "Behind", 100, 100)],
  });
  assert.equal(result.occluded, true);
  assert.equal(result.frontmost, false);
  assert.deepEqual(result.overlappingOwners, ["Google Chrome"]);
  assert.equal(host.hostWindowPrecondition(result).code, "host_window_occluded");
  assert.match(host.hostWindowPrecondition(result).detail, /Google Chrome/);
});

test("host window probe accepts a frontmost unoccluded bound window", () => {
  assert.equal(typeof host.evaluateHostWindowOcclusion, "function");
  const result = host.evaluateHostWindowOcclusion(binding, { frontmostOwnerPid: 99, windows: [qemu, window(1, 12, "Chrome", 100, 100)] });
  assert.equal(result.occluded, false);
  assert.equal(result.frontmost, true);
  assert.deepEqual(result.overlappingOwners, []);
  assert.equal(host.hostWindowPrecondition(result), null);
});

test("host window probe refuses missing or reused window identity instead of reporting clear", () => {
  assert.equal(typeof host.evaluateHostWindowOcclusion, "function");
  for (const windows of [[], [{ ...qemu, ownerPid: 98 }]]) {
    const result = host.evaluateHostWindowOcclusion(binding, { frontmostOwnerPid: 99, windows });
    assert.equal(result.status, "no_window");
    assert.equal(result.occluded, null);
    assert.equal(result.frontmost, false);
    assert.equal(host.hostWindowPrecondition(result).code, "host_window_unavailable");
  }
});
