import assert from "node:assert/strict";
import test from "node:test";

const host = await import("../dist/hostwindow.js").catch(() => ({}));
const binding = { qemuWindowId: 7, qemuWindowOwnerPid: 99 };
const window = (id, ownerPid, ownerName, x, y, width = 100, height = 100) => ({
  windowId: id, ownerPid, ownerName, x, y, width, height, alpha: 1, layer: 0,
});
const qemu = window(7, 99, "qemu-system-aarch64", 100, 100);

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
