/**
 * gate-inventory — one inventory owns every gate command and its host lane.
 *
 * Before this suite, three places had to agree by hand: the command tail inside a package.json
 * script string, the `npm run` step in gates.yml, and the prose counts in README/COLLABORATORS.
 * They drifted — `test:runrevision` existed as a script that no workflow lane ever ran, and the
 * meta-gate that should have caught it was itself red for stale numeric reasons. These tests drive
 * the inventory instead: `GATES` is the single declaration, `validateGateInventory` is the only
 * thing that decides whether package.json and gates.yml still agree with it, and every published
 * count is derived rather than typed.
 *
 * Deliberately no future totals are asserted here. Adding a gate must be one edit to `GATES`, and
 * the *shape* checks below (set equality, host agreement, no duplicates) must catch a forgotten
 * workflow lane without anyone updating a number in a test.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GATES,
  GATE_HOSTS,
  GATE_SCOPES,
  gateHostCounts,
  gateScriptCommand,
  gatesForHost,
  hostFamilyForRunner,
  parseWorkflowLanes,
  validateGateInventory,
} from "../scripts/gate-inventory.mjs";
import { STALE_BUILD_MESSAGE, gateLaunch, runArgv, runGate } from "../scripts/run-gate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readPackageJson = () => JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const readWorkflow = () => fs.readFileSync(path.join(repoRoot, ".github", "workflows", "gates.yml"), "utf8");

/** Insert a step at the end of the Linux `gates:` job, immediately before the next job header. */
function appendLinuxStep(workflow, name, script) {
  const inserted = workflow.replace(
    /^  vcam-native:\n/m,
    `      - name: ${name}\n        run: npm run ${script}\n\n  vcam-native:\n`,
  );
  assert.notEqual(inserted, workflow, "fixture mutation must actually change the workflow text");
  return inserted;
}

/** Append a step to the trailing macOS `vcam-native:` job. */
function appendMacosStep(workflow, name, script) {
  return `${workflow.replace(/\n*$/, "\n")}      - name: ${name}\n        run: npm run ${script}\n`;
}

// --------------------------------------------------------------------------------------------
// The inventory itself
// --------------------------------------------------------------------------------------------

test("GATES declares a host, a scope, and at least one argv array for every gate", () => {
  assert.ok(Object.keys(GATES).length > 0, "the inventory must not be empty");
  for (const [name, gate] of Object.entries(GATES)) {
    assert.ok(name === "smoke" || name.startsWith("test:"), `${name} is not a public gate name`);
    assert.ok(GATE_HOSTS.includes(gate.host), `${name}: unknown host ${gate.host}`);
    assert.ok(GATE_SCOPES.includes(gate.scope), `${name}: unknown scope ${gate.scope}`);
    assert.ok(Array.isArray(gate.commands) && gate.commands.length > 0, `${name}: no commands`);
    for (const argv of gate.commands) {
      assert.ok(Array.isArray(argv) && argv.length > 0, `${name}: empty argv`);
      for (const token of argv) assert.equal(typeof token, "string", `${name}: non-string argv token`);
      assert.ok(argv.every((token) => !token.includes("&&")), `${name}: a shell operator survived into argv`);
    }
  }
});

test("the repository's package.json and gates.yml agree with the inventory", () => {
  assert.deepEqual(validateGateInventory(readPackageJson(), readWorkflow()), []);
});

test("every public gate script is routed through run-gate, and nothing else is", () => {
  const scripts = readPackageJson().scripts;
  for (const name of Object.keys(GATES)) {
    assert.equal(scripts[name], gateScriptCommand(name), name);
  }
  for (const [name, body] of Object.entries(scripts)) {
    if (name === "smoke" || name.startsWith("test:")) continue;
    assert.doesNotMatch(body, /run-gate\.mjs/, `${name} is not a gate and must not be routed through run-gate`);
  }
  assert.equal(scripts.build, "node scripts/build-source.mjs", "build stays outside the gate inventory");
  assert.equal(scripts["sync:meta"], "node scripts/sync-metadata.mjs", "metadata stays outside the gate inventory");
  assert.equal(scripts.start, "node dist/index.js", "start stays outside the gate inventory");
});

test("the native Windows lane keeps its exact three constituent suites", () => {
  assert.equal(GATES["test:picocli-win"].host, "windows");
  assert.deepEqual(GATES["test:picocli-win"].commands, [[
    "node", "--test", "test/picocli-autoinstall.mjs",
    "test/buildrun-smoke-fixture.mjs", "test/run-battery.mjs",
  ]]);
});

test("macOS keeps both native CMIO contracts, and only those", () => {
  const macos = gatesForHost("macos");
  assert.deepEqual(macos.sort(), ["test:vcamreader-native", "test:vcamtransport-native"]);
  for (const name of macos) {
    assert.equal(GATES[name].scope, "native-contract", name);
  }
});

test("test:runrevision is a Linux gate, not an orphan script", () => {
  assert.equal(GATES["test:runrevision"].host, "linux");
  assert.deepEqual(GATES["test:runrevision"].commands, [[
    "node", "--test", "test/runrevision-contracts.mjs", "test/runrevision-store.mjs",
    "test/runrevision-locator.mjs", "test/runrevision-locks.mjs",
  ]]);
});

test("the build-freshness and plugin-bootstrap-freshness suites are named Linux fixture gates", () => {
  assert.deepEqual(GATES["test:buildfreshness"], {
    host: "linux",
    scope: "fixture",
    commands: [["node", "--test", "test/buildfreshness.mjs"]],
  });
  assert.deepEqual(GATES["test:plugin-bootstrap-freshness"], {
    host: "linux",
    scope: "fixture",
    commands: [["node", "--test", "test/plugin-bootstrap-freshness.mjs"]],
  });
});

test("multi-command gates keep every && tail as its own sequential argv array", () => {
  assert.deepEqual(GATES["test:lint"].commands[0], ["node", "test/lint.mjs"]);
  assert.equal(GATES["test:lint"].commands.length, 2, "the battery-runner contract must survive as its own command");
  assert.deepEqual(GATES["test:eye"].commands, [["node", "test/eye.mjs"], ["node", "test/usdrender.mjs"]]);
  assert.deepEqual(GATES["test:conformance"].commands, [
    ["node", "test/conformance.mjs"],
    ["node", "--test", "test/boundaryprobe.mjs", "test/boundaryexperiment.mjs"],
  ]);
  assert.deepEqual(GATES["test:picocli"].commands, [
    ["node", "test/picocli.mjs"],
    ["node", "--test", "test/picocli-autoinstall.mjs", "test/picocli-sweep.mjs"],
  ]);
  assert.deepEqual(GATES["test:bridge"].commands, [
    ["node", "test/mousebridge.mjs"],
    ["node", "--test", "test/sceneanchors.mjs", "test/homeenvironmentcatalog.mjs",
      "test/homeenvironmenthost.mjs", "test/homeenvironmentselector.mjs"],
  ]);
});

test("every argv target file that the inventory names exists in the checkout", () => {
  for (const [name, gate] of Object.entries(GATES)) {
    for (const argv of gate.commands) {
      for (const token of argv.slice(1)) {
        if (!/^(?:test|scripts)\//.test(token)) continue;
        assert.equal(fs.existsSync(path.join(repoRoot, token)), true, `${name}: ${token} does not exist`);
      }
    }
  }
});

// --------------------------------------------------------------------------------------------
// validateGateInventory: the four drift classes it must refuse
// --------------------------------------------------------------------------------------------

test("a gate the workflow stops invoking is reported as missing", () => {
  const missing = readWorkflow().replace("npm run test:runrevision", "npm run build");
  assert.match(validateGateInventory(readPackageJson(), missing).join("\n"), /test:runrevision/);
});

test("a gate invoked twice is reported as a duplicate", () => {
  const duplicated = appendLinuxStep(readWorkflow(), "Ledger again", "test:ledger");
  const findings = validateGateInventory(readPackageJson(), duplicated);
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0], /test:ledger/);
  assert.match(findings[0], /twice|duplicate|more than once/i);
});

test("a workflow step invoking an unknown gate is reported", () => {
  const unknown = appendLinuxStep(readWorkflow(), "Not a gate", "test:does-not-exist");
  const findings = validateGateInventory(readPackageJson(), unknown);
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0], /test:does-not-exist/);
  assert.match(findings[0], /unknown|does not declare|not in the inventory/i);
});

test("a gate run by a lane whose runner OS disagrees with its host is reported", () => {
  const workflow = readWorkflow();
  const moved = workflow.replace(
    /^      - name: Ledger fixtures[^\n]*\n        run: npm run test:ledger\n/m,
    "",
  );
  assert.notEqual(moved, workflow, "the Linux ledger step must be removable for this fixture");
  const findings = validateGateInventory(readPackageJson(), appendMacosStep(moved, "Ledger fixtures (moved)", "test:ledger"));
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0], /test:ledger/);
  assert.match(findings[0], /linux/);
  assert.match(findings[0], /macos/);
});

test("a package script with no host assignment is reported", () => {
  const pkg = readPackageJson();
  pkg.scripts["test:orphan"] = "node scripts/run-gate.mjs test:orphan";
  const findings = validateGateInventory(pkg, readWorkflow());
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0], /test:orphan/);
  assert.match(findings[0], /host|assign|inventory/i);
});

test("an inventory entry with no package script is reported", () => {
  const pkg = readPackageJson();
  delete pkg.scripts["test:ledger"];
  const findings = validateGateInventory(pkg, readWorkflow());
  assert.ok(findings.some((finding) => /test:ledger/.test(finding) && /package\.json/.test(finding)), findings.join("\n"));
});

test("a lane whose runner OS cannot be recognized is reported rather than silently trusted", () => {
  const workflow = readWorkflow().replace("runs-on: macos-latest", "runs-on: solaris-latest");
  const findings = validateGateInventory(readPackageJson(), workflow);
  assert.ok(findings.some((finding) => /solaris-latest/.test(finding)), findings.join("\n"));
});

// --------------------------------------------------------------------------------------------
// Workflow parsing and derived counts
// --------------------------------------------------------------------------------------------

test("workflow lanes carry their job name, runner, host family, and gate invocations", () => {
  const lanes = parseWorkflowLanes(readWorkflow());
  assert.deepEqual(lanes.map((lane) => lane.job), ["picocli-windows", "gates", "vcam-native"]);
  assert.deepEqual(lanes.map((lane) => lane.host), ["windows", "linux", "macos"]);
  const windows = lanes.find((lane) => lane.job === "picocli-windows");
  assert.deepEqual(windows.gates, ["test:picocli-win"], "npm ci / npm run build are not gate invocations");
  const linux = lanes.find((lane) => lane.job === "gates");
  assert.ok(linux.gates.includes("smoke"));
  assert.ok(linux.gates.includes("test:runrevision"));
});

test("runner labels map to host families, and an unknown label maps to null", () => {
  assert.equal(hostFamilyForRunner("ubuntu-latest"), "linux");
  assert.equal(hostFamilyForRunner("ubuntu-22.04"), "linux");
  assert.equal(hostFamilyForRunner("windows-latest"), "windows");
  assert.equal(hostFamilyForRunner("macos-14"), "macos");
  assert.equal(hostFamilyForRunner("solaris-latest"), null);
  assert.equal(hostFamilyForRunner(undefined), null);
});

test("published counts are derived from the inventory, never typed", () => {
  const counts = gateHostCounts();
  assert.deepEqual(Object.keys(counts).sort(), ["linux", "macos", "windows"]);
  assert.equal(
    counts.linux + counts.windows + counts.macos,
    Object.keys(GATES).length,
    "every gate belongs to exactly one host lane",
  );
  assert.equal(gatesForHost("windows").length, counts.windows);
});

test("the shape checks survive a synthetic inventory, so no repository total is baked in", () => {
  const gates = {
    smoke: { host: "linux", scope: "fixture", commands: [["node", "smoke.mjs"]] },
    "test:only": { host: "macos", scope: "native-contract", commands: [["sh", "native.sh"]] },
  };
  const pkg = { scripts: { smoke: gateScriptCommand("smoke"), "test:only": gateScriptCommand("test:only") } };
  const workflow = [
    "jobs:",
    "  linux:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm run smoke",
    "  mac:",
    "    runs-on: macos-latest",
    "    steps:",
    "      - run: npm run test:only",
    "",
  ].join("\n");
  assert.deepEqual(validateGateInventory(pkg, workflow, gates), []);
  assert.deepEqual(gateHostCounts(gates), { linux: 1, windows: 0, macos: 1 });
});

// --------------------------------------------------------------------------------------------
// run-gate: freshness first, then argv arrays, sequentially
// --------------------------------------------------------------------------------------------

function fakeSpawn(record, outcomes = []) {
  return (command, args, options) => {
    record.push({ command, args, options });
    const child = new EventEmitter();
    const outcome = outcomes.shift() ?? { code: 0 };
    queueMicrotask(() => {
      if (outcome.error) child.emit("error", outcome.error);
      else child.emit("close", outcome.code ?? 0, outcome.signal ?? null);
    });
    return child;
  };
}

const fresh = () => ({ current: true, reasons: [] });

test("a stale build fails the gate before any child is spawned", async () => {
  const record = [];
  await assert.rejects(
    () => runGate("test:ledger", {
      root: repoRoot,
      env: {},
      spawnChild: fakeSpawn(record),
      verify: () => ({ current: false, reasons: ["the source input identity changed since the build (aaa -> bbb)"] }),
    }),
    (error) => {
      assert.ok(error.message.startsWith(STALE_BUILD_MESSAGE), error.message);
      assert.match(error.message, /source input identity changed/);
      return true;
    },
  );
  assert.deepEqual(record, [], "a stale build must prevent every child, not just the first");
});

test("an installed-artifact gate is freshness-checked too", async () => {
  const record = [];
  await assert.rejects(
    () => runGate("test:tarball", {
      root: repoRoot,
      env: {},
      spawnChild: fakeSpawn(record),
      verify: () => ({ current: false, reasons: ["dist/ does not exist; run npm run build"] }),
    }),
    new RegExp(STALE_BUILD_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.deepEqual(record, []);
});

test("a native-contract gate skips the freshness check, because it never loads dist/", async () => {
  const record = [];
  let asked = 0;
  const exit = await runGate("test:vcamtransport-native", {
    root: repoRoot,
    env: {},
    spawnChild: fakeSpawn(record),
    verify: () => { asked += 1; return { current: false, reasons: ["stale"] }; },
  });
  assert.equal(exit, 0);
  assert.equal(asked, 0, "a shell contract must not be gated on TypeScript output");
  assert.deepEqual(record.map((call) => [call.command, ...call.args]), [["sh", "scripts/test-cmio-camera-writer.sh"]]);
});

test("commands run sequentially, with no shell, inheriting stdio, in the given root", async () => {
  const record = [];
  const exit = await runGate("test:eye", {
    root: "/tmp/some checkout",
    env: { PICO_FIXTURE: "1" },
    spawnChild: fakeSpawn(record),
    verify: fresh,
  });
  assert.equal(exit, 0);
  assert.deepEqual(record.map((call) => [call.command, ...call.args]), [
    ["node", "test/eye.mjs"],
    ["node", "test/usdrender.mjs"],
  ]);
  for (const call of record) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.stdio, "inherit");
    assert.equal(call.options.cwd, "/tmp/some checkout");
    assert.deepEqual(call.options.env, { PICO_FIXTURE: "1" });
    assert.equal(typeof call.options.timeout, "number");
    assert.ok(call.options.timeout > 0, "every gate child must be bounded");
  }
});

test("the first nonzero exit propagates and stops the remaining commands", async () => {
  const record = [];
  const exit = await runGate("test:conformance", {
    root: repoRoot,
    env: {},
    spawnChild: fakeSpawn(record, [{ code: 3 }]),
    verify: fresh,
  });
  assert.equal(exit, 3);
  assert.equal(record.length, 1, "a failed command must not be followed by the rest of the gate");
});

test("a spawn error and a killed child are both nonzero, and stop the gate", async () => {
  const errored = [];
  assert.equal(
    await runGate("test:eye", { root: repoRoot, env: {}, verify: fresh, spawnChild: fakeSpawn(errored, [{ error: new Error("ENOENT") }]) }),
    1,
  );
  assert.equal(errored.length, 1);

  const killed = [];
  assert.equal(
    await runGate("test:eye", { root: repoRoot, env: {}, verify: fresh, spawnChild: fakeSpawn(killed, [{ code: null, signal: "SIGTERM" }]) }),
    1,
  );
  assert.equal(killed.length, 1);
});

test("an unknown gate name is refused by name", async () => {
  await assert.rejects(() => runGate("test:not-a-gate", { root: repoRoot, verify: fresh }), /test:not-a-gate/);
});

test("runArgv resolves nonzero without throwing when the child cannot start", async () => {
  const record = [];
  assert.equal(
    await runArgv(["node", "missing.mjs"], {
      root: repoRoot,
      env: {},
      spawnChild: fakeSpawn(record, [{ error: new Error("spawn failed") }]),
    }),
    1,
  );
});

test("only npm goes through the Windows launch shim; node and sh are spawned directly", () => {
  assert.deepEqual(gateLaunch(["node", "--test", "test/eye.mjs"], "win32", {}), {
    command: "node",
    args: ["--test", "test/eye.mjs"],
  });
  assert.deepEqual(gateLaunch(["sh", "scripts/x.sh"], "linux", {}), { command: "sh", args: ["scripts/x.sh"] });
  assert.deepEqual(gateLaunch(["npm", "run", "build"], "linux", {}), { command: "npm", args: ["run", "build"] });
  assert.deepEqual(gateLaunch(["npm", "run", "build"], "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd run build"],
  });
});
