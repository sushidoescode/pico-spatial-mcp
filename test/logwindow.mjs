/**
 * Marker-correlated bounded log windows (host completion T4, 2026-09-16).
 *
 * Incident 3 of docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md: ~20 irreversible global log
 * clears of the user's emulator, run by an observation path that cleared the buffer "to scope its
 * own scan". src/logwindow.ts replaces every such clear with a marker written into the device's
 * main buffer and a bounded dump sliced to the lines AFTER that marker. A read whose marker is not
 * in the dump is INCONCLUSIVE — never an empty window, never a match against the unscoped buffer.
 *
 * Pure unit tests here take an AdbRunner closure and never spawn anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sliceAfterMarker, openLogWindow, readLogWindow, LOG_WINDOW_TAG } from "../dist/logwindow.js";

test("sliceAfterMarker returns only lines after the marker line", () => {
  const out = ["old 1", "old 2", `09-16 00:00:00.000  1  1 I ${LOG_WINDOW_TAG}: pico-mcp-window-abc`, "new 1", "new 2"].join("\n");
  assert.deepEqual(sliceAfterMarker(out, "pico-mcp-window-abc"), { markerSeen: true, lines: ["new 1", "new 2"] });
});

test("a missing marker is reported, never silently treated as an empty window", () => {
  assert.deepEqual(sliceAfterMarker("a\nb\n", "pico-mcp-window-zzz"), { markerSeen: false, lines: [] });
});

test("openLogWindow writes exactly one `log -t pico-mcp <marker>` and never a clear", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const window = await openLogWindow(run, "fixture-serial");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["-s", "fixture-serial", "shell", "log", "-t"]);
  assert.equal(calls[0][5], LOG_WINDOW_TAG);
  assert.equal(calls[0][6], window.marker);
  assert.ok(!calls.some((a) => a.includes("-c")));
});

test("readLogWindow always includes the marker tag in its filter and bounds the dump", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: `x\nI ${LOG_WINDOW_TAG}: m1\nAgentBridge: dump_begin\n`, stderr: "" }; };
  const result = await readLogWindow(run, { serial: "fixture-serial", marker: "m1", openedAt: "t" }, { tags: ["AgentBridge"], maxLines: 500 });
  assert.equal(result.markerSeen, true);
  assert.deepEqual(result.lines, ["AgentBridge: dump_begin"]);
  assert.ok(calls[0].includes("-d") && calls[0].includes("-t") && calls[0].includes("500"));
  assert.ok(calls[0].includes("AgentBridge:V") && calls[0].includes(`${LOG_WINDOW_TAG}:V`) && calls[0].includes("*:S"));
  assert.ok(!calls[0].includes("-c"));
});
