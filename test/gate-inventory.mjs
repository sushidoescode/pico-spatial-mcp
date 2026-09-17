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
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_NO_ADB,
  GATES,
  GATE_HOSTS,
  GATE_SCOPES,
  HARNESS_ADB_VARIABLE,
  gateChildEnv,
  gateHostCounts,
  gateScriptCommand,
  gatesForHost,
  hostFamilyForRunner,
  parseWorkflowLanes,
  validateGateInventory,
} from "../scripts/gate-inventory.mjs";
import {
  GATE_KILL_GRACE_MS,
  GATE_TIMEOUT_MS,
  STALE_BUILD_MESSAGE,
  gateLaunch,
  runArgv,
  runGate,
} from "../scripts/run-gate.mjs";

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
    ["node", "--test", "test/picocli-autoinstall.mjs", "test/picocli-sweep.mjs", "test/picocli-childenv.mjs"],
    ["node", "--test", "test/cliobservations.mjs"],
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
    child.kill = () => {};
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
    // The caller's env plus the hermeticity default: test:eye is a fixture gate and the caller
    // set no PICO_ADB, so the child gets FIXTURE_NO_ADB (the cases below take that apart).
    assert.deepEqual(call.options.env, { PICO_FIXTURE: "1", PICO_ADB: FIXTURE_NO_ADB });
    assert.equal(
      call.options.timeout,
      undefined,
      "the runner owns the SIGTERM->SIGKILL ladder; spawn's one-signal timeout is not a bound",
    );
  }
  assert.ok(GATE_TIMEOUT_MS > 0 && GATE_KILL_GRACE_MS > 0, "both rungs of the bound must be positive");
});

// --------------------------------------------------------------------------------------------
// run-gate: the PICO_ADB hermeticity barrier is applied, not remembered
// --------------------------------------------------------------------------------------------
//
// The 38.0.0 checkpoint's every recorded run exported PICO_ADB=/fixture/no/such/adb by hand, and
// three RED-phase runs reached real hardware before that ruling existed. These cases pin the
// barrier as run-gate behaviour: every fixture or installed-artifact child runs under the literal,
// whatever PICO_ADB the caller's shell inherited (a real adb, an empty string, whitespace — the
// first enforced version let a caller-set value through, and src/adb.ts read an empty one as
// unset); the ONE pass-through is PICO_GATE_FIXTURE_ADB naming an executable fake, validated
// before any spawn; a native-contract child is untouched; and nothing here writes process.env.

test("FIXTURE_NO_ADB is the exact literal the checkpoint's runs exported, and names no file", () => {
  assert.equal(FIXTURE_NO_ADB, "/fixture/no/such/adb");
  assert.equal(fs.existsSync(FIXTURE_NO_ADB), false, "the barrier only works because src/adb.ts cannot find this file");
});

test("a fixture gate child gets PICO_ADB=FIXTURE_NO_ADB when the caller set none", async () => {
  const record = [];
  const callerEnv = { PATH: "/usr/bin" };
  const exit = await runGate("test:ledger", { root: repoRoot, env: callerEnv, spawnChild: fakeSpawn(record), verify: fresh });
  assert.equal(exit, 0);
  assert.equal(record.length, 1);
  assert.deepEqual(record[0].options.env, { PATH: "/usr/bin", PICO_ADB: FIXTURE_NO_ADB });
  assert.deepEqual(callerEnv, { PATH: "/usr/bin" }, "the caller's env object must not be written");
});

test("an installed-artifact gate child gets the same default", async () => {
  const record = [];
  const exit = await runGate("test:tarball", { root: repoRoot, env: { PATH: "/usr/bin" }, spawnChild: fakeSpawn(record), verify: fresh });
  assert.equal(exit, 0);
  assert.equal(record.length, GATES["test:tarball"].commands.length, "every command of the gate ran");
  for (const call of record) assert.equal(call.options.env.PICO_ADB, FIXTURE_NO_ADB);
});

test("an inherited PICO_ADB is replaced by the pin, whatever it holds: a real adb, empty, or whitespace", async () => {
  // The first enforced barrier let a caller-set value through ("the caller's choice"), which
  // re-opened the same door from any shell that had exported a real adb — and src/adb.ts read an
  // EMPTY value as unset and walked PATH. Neither is the caller's choice inside a fixture gate.
  for (const inherited of ["/opt/fixture/own-adb", "", "   ", "\t"]) {
    const record = [];
    const callerEnv = { PATH: "/usr/bin", PICO_ADB: inherited };
    const exit = await runGate("test:ledger", { root: repoRoot, env: callerEnv, spawnChild: fakeSpawn(record), verify: fresh });
    assert.equal(exit, 0, JSON.stringify(inherited));
    assert.deepEqual(record[0].options.env, { PATH: "/usr/bin", PICO_ADB: FIXTURE_NO_ADB }, JSON.stringify(inherited));
    assert.deepEqual(callerEnv, { PATH: "/usr/bin", PICO_ADB: inherited }, "the caller's env object is not written");
  }
});

test("a native-contract gate child gets no PICO_ADB default", async () => {
  const record = [];
  const callerEnv = { PATH: "/usr/bin" };
  const exit = await runGate("test:vcamtransport-native", {
    root: repoRoot,
    env: callerEnv,
    spawnChild: fakeSpawn(record),
    verify: () => ({ current: false, reasons: ["stale"] }),
  });
  assert.equal(exit, 0);
  assert.equal(record[0].options.env, callerEnv, "a shell contract runs under exactly the env it was handed");
  assert.equal("PICO_ADB" in record[0].options.env, false);
});

test("the default is built into the child env, never written to process.env", async () => {
  const before = process.env.PICO_ADB;
  const record = [];
  const env = {};
  await runGate("test:ledger", { root: repoRoot, env, spawnChild: fakeSpawn(record), verify: fresh });
  assert.equal(record[0].options.env.PICO_ADB, FIXTURE_NO_ADB);
  assert.equal(process.env.PICO_ADB, before, "runGate must not export the pin into its own process");
  assert.deepEqual(env, {}, "the env object the caller passed must stay as it was");
  assert.notEqual(gateChildEnv(GATES["test:ledger"], env), env, "a fixture gate gets a fresh env object");
  assert.equal(gateChildEnv(GATES["test:vcamtransport-native"], env), env, "a native-contract gate gets the very same object");
});

test("an inherited real PICO_ADB is replaced by the fixture pin in fixture gates", () => {
  const env = { PATH: "/usr/bin", PICO_ADB: "/opt/homebrew/bin/adb" };
  const child = gateChildEnv(GATES["test:eye"], env);
  assert.equal(child.PICO_ADB, FIXTURE_NO_ADB);
  assert.equal(env.PICO_ADB, "/opt/homebrew/bin/adb", "the caller's env object is not written");
});

test("an empty or whitespace PICO_ADB is replaced, never passed through", () => {
  for (const value of ["", "   ", "\t"]) {
    assert.equal(gateChildEnv(GATES["test:eye"], { PICO_ADB: value }).PICO_ADB, FIXTURE_NO_ADB, JSON.stringify(value));
  }
});

test("installed-artifact gates are pinned exactly like fixture gates", () => {
  assert.equal(gateChildEnv(GATES["test:tarball"], { PICO_ADB: "/real/adb" }).PICO_ADB, FIXTURE_NO_ADB);
});

test("native-contract gates get the identical env object and no pin", () => {
  const env = { PATH: "/usr/bin", PICO_ADB: "/real/adb" };
  assert.equal(gateChildEnv(GATES["test:vcamtransport-native"], env), env);
});

test("the harness override passes an explicit fake executable through as PICO_ADB", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fake-adb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "adb");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 66\n", { mode: 0o755 });
  const child = gateChildEnv(GATES["test:eye"], { PICO_ADB: "/real/adb", [HARNESS_ADB_VARIABLE]: fake });
  assert.equal(child.PICO_ADB, fake);
  assert.equal(child[HARNESS_ADB_VARIABLE], fake, "the override variable itself is kept so the child can see why");
});

test("an invalid harness override refuses to spawn the gate instead of falling back", () => {
  // Relative, nonexistent, a directory (passes X_OK, is not a file), and blank: none may quietly
  // become the pin or pass through — the harness asked for a fake and did not get one.
  for (const bad of ["relative/adb", "/no/such/fake-adb", os.tmpdir(), "", "   "]) {
    assert.throws(() => gateChildEnv(GATES["test:eye"], { [HARNESS_ADB_VARIABLE]: bad }), (error) => error.code === "GATE_FIXTURE_ADB_INVALID", bad);
  }
});

// The hatch must not hand a REAL adb through (fix wave FW1, Minor 4). "Absolute + executable" is
// satisfied by /opt/homebrew/bin/adb just as well as by a fake, and the variable's name plus the fix
// text were the whole guard. Now the override's realpath is compared — filesystem reads only, never
// a spawn — against every adb/adb.exe found directly in a directory on the CALLER env's PATH, up to
// three levels under $PICO_HOME, or up to three levels under ~/Library/PICO (HOME from the caller
// env), and a match is refused with the same code. Every case below builds its own PATH, PICO_HOME
// and HOME in temp directories; none reads the host's PATH.
function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate-hatch-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const writeFakeAdb = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 66\n", { mode: 0o755 });
  return file;
};
const isRealAdbRefusal = (error) => error.code === "GATE_FIXTURE_ADB_INVALID" && /must not be a real adb/.test(error.message);

test("a fake adb in a directory on no lookup path passes the hatch", (t) => {
  const fake = writeFakeAdb(path.join(tempDir(t, "fake"), "adb"));
  const env = { PATH: tempDir(t, "bin"), HOME: tempDir(t, "home"), PICO_HOME: tempDir(t, "picohome"), PICO_ADB: "/real/adb", [HARNESS_ADB_VARIABLE]: fake };
  assert.equal(gateChildEnv(GATES["test:eye"], env).PICO_ADB, fake);
});

test("the same fake placed first on the caller's PATH is refused as a real adb", (t) => {
  const bin = tempDir(t, "pathbin");
  const onPath = writeFakeAdb(path.join(bin, "adb"));
  const env = { PATH: [bin, tempDir(t, "other")].join(path.delimiter), HOME: tempDir(t, "home"), [HARNESS_ADB_VARIABLE]: onPath };
  assert.throws(() => gateChildEnv(GATES["test:eye"], env), (error) => isRealAdbRefusal(error) && /PATH/.test(error.message) && error.message.includes(onPath));
  // …and adb.exe is an adb too
  const winBin = tempDir(t, "winbin");
  const exe = writeFakeAdb(path.join(winBin, "adb.exe"));
  assert.throws(() => gateChildEnv(GATES["test:eye"], { PATH: winBin, HOME: tempDir(t, "home2"), [HARNESS_ADB_VARIABLE]: exe }), isRealAdbRefusal);
});

test("a symlink to a PATH adb is refused by realpath, not by spelling", (t) => {
  const bin = tempDir(t, "pathbin");
  const onPath = writeFakeAdb(path.join(bin, "adb"));
  const link = path.join(tempDir(t, "links"), "definitely-a-fake-adb");
  fs.symlinkSync(onPath, link);
  assert.throws(
    () => gateChildEnv(GATES["test:eye"], { PATH: bin, HOME: tempDir(t, "home"), [HARNESS_ADB_VARIABLE]: link }),
    (error) => isRealAdbRefusal(error) && error.message.includes(fs.realpathSync(onPath)),
  );
});

test("an adb up to three levels under $PICO_HOME or ~/Library/PICO is refused; deeper is not searched", (t) => {
  const picoHome = tempDir(t, "picohome");
  const home = tempDir(t, "home");
  const emptyBin = tempDir(t, "bin");
  const three = writeFakeAdb(path.join(picoHome, "a", "b", "adb"));
  assert.throws(
    () => gateChildEnv(GATES["test:eye"], { PATH: emptyBin, HOME: home, PICO_HOME: picoHome, [HARNESS_ADB_VARIABLE]: three }),
    (error) => isRealAdbRefusal(error) && /PICO_HOME/.test(error.message),
  );
  const four = writeFakeAdb(path.join(picoHome, "a", "b", "c", "adb"));
  assert.equal(gateChildEnv(GATES["test:eye"], { PATH: emptyBin, HOME: home, PICO_HOME: picoHome, [HARNESS_ADB_VARIABLE]: four }).PICO_ADB, four, "the walk is bounded at three levels");
  // ~/Library/PICO/sdk/platform-tools/adb is three levels under ~/Library/PICO
  const library = writeFakeAdb(path.join(home, "Library", "PICO", "sdk", "platform-tools", "adb"));
  assert.throws(
    () => gateChildEnv(GATES["test:eye"], { PATH: emptyBin, HOME: home, [HARNESS_ADB_VARIABLE]: library }),
    (error) => isRealAdbRefusal(error) && /Library\/PICO/.test(error.message),
  );
});

test("native-contract gates are untouched by the hatch hardening", (t) => {
  const bin = tempDir(t, "pathbin");
  const onPath = writeFakeAdb(path.join(bin, "adb"));
  const env = { PATH: bin, PICO_ADB: "/real/adb", [HARNESS_ADB_VARIABLE]: onPath };
  assert.equal(gateChildEnv(GATES["test:vcamtransport-native"], env), env, "a shell contract runs under exactly the env it was handed");
});

test("run-gate refuses a harness override that is an adb on the caller's PATH: exit 2, the fix says never a real adb, nothing spawned", async (t) => {
  const bin = tempDir(t, "pathbin");
  const onPath = writeFakeAdb(path.join(bin, "adb"));
  const record = [];
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  let exit;
  try {
    exit = await runGate("test:ledger", {
      root: repoRoot,
      env: { PATH: bin, HOME: tempDir(t, "home"), [HARNESS_ADB_VARIABLE]: onPath },
      spawnChild: fakeSpawn(record),
      verify: fresh,
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(exit, 2);
  assert.deepEqual(record, [], "a real adb in the hatch must prevent every child");
  const printed = stderr.join("");
  assert.match(printed, /must not be a real adb/);
  assert.match(printed, /unset PICO_GATE_FIXTURE_ADB or point it at an executable fake — never a real adb/);
});

test("run-gate hands a valid harness override to the child as PICO_ADB, replacing the inherited value", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-gate-fake-adb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "adb");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 66\n", { mode: 0o755 });
  const record = [];
  const exit = await runGate("test:ledger", {
    root: repoRoot,
    env: { PATH: "/usr/bin", PICO_ADB: "/real/adb", [HARNESS_ADB_VARIABLE]: fake },
    spawnChild: fakeSpawn(record),
    verify: fresh,
  });
  assert.equal(exit, 0);
  assert.deepEqual(record[0].options.env, { PATH: "/usr/bin", PICO_ADB: fake, [HARNESS_ADB_VARIABLE]: fake });
});

test("run-gate refuses a gate whose harness override is invalid: exit 2, the fix printed, nothing spawned", async () => {
  const record = [];
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  let exit;
  try {
    exit = await runGate("test:ledger", {
      root: repoRoot,
      env: { PATH: "/usr/bin", [HARNESS_ADB_VARIABLE]: "/no/such/fake-adb" },
      spawnChild: fakeSpawn(record),
      verify: fresh,
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(exit, 2);
  assert.deepEqual(record, [], "an invalid override must prevent every child, not just the first");
  const printed = stderr.join("");
  assert.match(printed, /PICO_GATE_FIXTURE_ADB="\/no\/such\/fake-adb"/);
  assert.match(printed, /unset PICO_GATE_FIXTURE_ADB or point it at an executable fake — never a real adb/);
});

test("gates.yml carries the same literal at workflow level, covering the one raw node --test step", () => {
  const workflow = readWorkflow();
  const jobsAt = workflow.indexOf("\njobs:\n");
  assert.ok(jobsAt > 0, "gates.yml must declare jobs:");
  const beforeJobs = workflow.slice(0, jobsAt + 1);
  assert.match(beforeJobs, new RegExp(`^env:\\n  PICO_ADB: ${FIXTURE_NO_ADB.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n`, "m"),
    "a workflow-level env: block must pin PICO_ADB to FIXTURE_NO_ADB before the first job");
  // The raw step this exists for is still raw (it is not a named gate, so run-gate cannot pin it).
  assert.match(workflow, /run: node --test test\/homeenvironmenthost\.mjs/);
  // …and adding the block did not confuse the lane parser.
  assert.deepEqual(parseWorkflowLanes(workflow).map((lane) => lane.job), ["picocli-windows", "gates", "vcam-native"]);
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

test("a real child that ignores SIGTERM is still bounded: SIGKILL lands after the grace", async () => {
  // Node's `timeout` option sends one SIGTERM and then waits forever, so this fixture — which
  // installs a SIGTERM handler and holds the loop open — would hang the lane under it. The runner's
  // own ladder must escalate, and the gate must settle nonzero within timeout + grace.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "run-gate-stubborn-"));
  const stubborn = path.join(scratch, "ignores-sigterm.mjs");
  fs.writeFileSync(stubborn, [
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1_000);",
    "",
  ].join("\n"));

  try {
    const started = Date.now();
    const exit = await runArgv(["node", stubborn], { root: scratch, env: process.env, timeoutMs: 300, graceMs: 700 });
    const elapsed = Date.now() - started;
    assert.equal(exit, 1, "a timed-out child must fail its gate");
    assert.ok(elapsed >= 300, `must not settle before the timeout (took ${elapsed}ms)`);
    assert.ok(elapsed < 300 + 700 + 6_000, `must settle inside timeout + grace + slack (took ${elapsed}ms)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a timed-out gate stops before its remaining commands", async () => {
  const record = [];
  const stalls = () => {
    record.push({});
    const child = new EventEmitter();
    child.kill = (signal) => { if (signal === "SIGKILL") child.emit("close", null, "SIGKILL"); };
    return child;
  };
  const exit = await runGate("test:eye", {
    root: repoRoot, env: {}, verify: fresh, timeoutMs: 10, graceMs: 10, spawnChild: stalls,
  });
  assert.equal(exit, 1);
  assert.equal(record.length, 1, "the second command must not run after the first was killed");
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
