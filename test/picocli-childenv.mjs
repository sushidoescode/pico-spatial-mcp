// Every pico-cli child must run without FORCE_COLOR and with NO_COLOR, unless the caller says
// otherwise. Claude Code exports FORCE_COLOR=1 to the MCP server and so to every CLI probe it
// spawns; pico-cli 0.5.0 then styles its help with ANSI SGR, and those bytes are what discovery
// retains (2026-09-16 native-acceptance finding).
import test from "node:test";
import assert from "node:assert/strict";

const { cliChildEnvironment } = await import("../dist/picocli.js");

test("FORCE_COLOR is dropped and NO_COLOR set for CLI children; everything else passes through", () => {
  const env = cliChildEnvironment({ PATH: "/bin", FORCE_COLOR: "1", HOME: "/h" }, { PICO_PROBE: "y" });
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.PICO_PROBE, "y");
});

test("an explicit override still wins, and a caller's own NO_COLOR is kept", () => {
  assert.equal(cliChildEnvironment({ FORCE_COLOR: "1" }, { FORCE_COLOR: "1" }).FORCE_COLOR, "1");
  assert.equal(cliChildEnvironment({ NO_COLOR: "0" }).NO_COLOR, "0");
});

test("the base environment object is not mutated", () => {
  const base = { FORCE_COLOR: "1" };
  cliChildEnvironment(base);
  assert.equal(base.FORCE_COLOR, "1");
});
