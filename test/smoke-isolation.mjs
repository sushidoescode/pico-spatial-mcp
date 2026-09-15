/**
 * smoke-isolation — the proof that `npm run smoke` is hermetic.
 *
 * The default smoke used to read a personal Android Studio checkout out of `os.homedir()` and pack
 * a real bundle with the host's own SDK. That made the gate's result a property of the developer's
 * machine: CI passed only because an env flag downgraded the resulting failures to SKIP while their
 * error text still matched one regex, and the better a machine was set up, the more of smoke broke.
 *
 * So this suite runs the real `node test/smoke.mjs` twice with two different host homes — one empty,
 * one carrying a decoy SDK payload and a decoy Android project exactly where a host would put them —
 * and asserts the two runs produce the same checks with the same outcomes. The decoy payloads are
 * tripwires: they are executable stubs that record being run, so "smoke ignored them" is measured,
 * not inferred. The fixture programs smoke does drive keep an invocation log, which is asserted to
 * contain only fixture-serial device operations and fixture Gradle builds, and never an npm call.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE = path.join(repoRoot, "test", "smoke.mjs");

/** A host home with nothing in it: the shape a clean CI runner has. */
function emptyHome(root) {
  const home = path.join(root, "empty-home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * A host home set up the way a PICO developer's machine is: an SDK payload at the default tools
 * root and an Android Studio project next to it. Every binary is a tripwire that appends to
 * `tripwire`, so running one is detectable rather than merely suspected.
 */
function decoyHome(root, tripwire) {
  const home = path.join(root, "decoy-home");
  const sdk = path.join(home, "Library", "PICO", "sdk", "0.13");
  const project = path.join(home, "AndroidStudioProjects", "decoy-spatial-app");
  const bundleDir = path.join(project, "editor-asset", "build", "spatial", "bundle");
  const sceneDir = path.join(project, "editor-asset", "src", "main", "res3d", "DecoyPackContent", "Sources", "Scenes");
  for (const dir of [
    path.join(sdk, "editor", "spatialbundle"),
    path.join(sdk, "emulator", "system-images", "platform-tools"),
    bundleDir,
    sceneDir,
  ]) fs.mkdirSync(dir, { recursive: true });

  for (const binary of [
    path.join(sdk, "editor", "spatialbundle", "spatialbundle"),
    path.join(sdk, "emulator", "emulator"),
    path.join(sdk, "emulator", "system-images", "platform-tools", "adb"),
  ]) {
    fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> ${JSON.stringify(tripwire)}\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(binary, 0o755);
  }
  fs.writeFileSync(path.join(bundleDir, "decoy.bundle"), "decoy bundle bytes");
  fs.writeFileSync(path.join(project, "DecoyPackContent.spatialproject"), "{}");
  fs.writeFileSync(path.join(sceneDir, "Main.usda"), "#usda 1.0\n");
  return { home, toolsRoot: path.dirname(sdk) };
}

/**
 * Host variables that name a toolchain. They are stripped from smoke's own environment before it
 * runs, because leaving them in would collapse the axis this suite exists to vary: a PICO developer
 * has `PICO_HOME` set, so both runs would resolve the *same* real tools root, and a regression that
 * re-spread `process.env` into the server would produce identical check lists, never touch the
 * decoy, and pass. Stripped, the two runs differ on the tools root as well as the home — the decoy
 * run points `PICO_HOME` at its own tripwired SDK — so a leak resolves different toolchains and is
 * caught by the comparison or by the tripwire.
 */
const HOST_TOOLCHAIN_ENV = /^(?:PICO_|ANDROID_)|^JAVA_HOME$/;

export function smokeChildEnv(home, extra = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !HOST_TOOLCHAIN_ENV.test(key)),
  );
  return { ...inherited, HOME: home, USERPROFILE: home, ...extra };
}

function runSmoke(home, extra = {}) {
  const result = spawnSync(process.execPath, [SMOKE], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: smokeChildEnv(home, extra),
  });
  const line = (result.stdout ?? "").split("\n").find((l) => l.startsWith("SMOKE_SUMMARY "));
  assert.ok(line, `smoke printed no SMOKE_SUMMARY line.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return { ...result, summary: JSON.parse(line.slice("SMOKE_SUMMARY ".length)) };
}

test("default smoke reports the same checks and outcomes whether or not the host home holds an SDK", { timeout: 600_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-smoke-isolation-"));
  const tripwire = path.join(root, "decoy-binary-invocations.log");
  try {
    const decoyTree = decoyHome(root, tripwire);
    assert.equal(fs.existsSync(path.join(decoyTree.toolsRoot, "0.13")), true,
      "the decoy tools root must hold a version directory, or a leak would resolve nothing");

    const empty = runSmoke(emptyHome(root));
    // The second run varies BOTH axes: a different home, and a PICO_HOME naming the decoy SDK.
    const decoy = runSmoke(decoyTree.home, { PICO_HOME: decoyTree.toolsRoot });

    for (const [label, run] of [["empty host home", empty], ["decoy host home", decoy]]) {
      assert.equal(run.status, 0, `${label}: smoke exited ${run.status}\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.summary.failures, 0, `${label}: ${JSON.stringify(run.summary.checks)}`);
      assert.ok(run.summary.checks.length > 0, `${label}: smoke recorded no checks`);
    }

    assert.deepEqual(
      decoy.summary.checks,
      empty.summary.checks,
      "smoke's check list and outcomes must not depend on the host home or the host PICO_HOME",
    );

    assert.equal(
      fs.existsSync(tripwire),
      false,
      `smoke executed a host SDK binary: ${fs.existsSync(tripwire) ? fs.readFileSync(tripwire, "utf8") : ""}`,
    );

    for (const [label, run] of [["empty host home", empty], ["decoy host home", decoy]]) {
      const { calls, npmCalls } = run.summary.fixture;
      assert.ok(calls.every(call => call.serial === 'fixture-serial' || call.kind === 'fixture-gradle'), `${label}: ${JSON.stringify(calls)}`);
      assert.equal(npmCalls.length, 0, `${label}: ${JSON.stringify(npmCalls)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default smoke cannot select host tooling: no host-home lookup and no environmental escape hatch", () => {
  // Asserted with includes() rather than a regex so a failure prints the claim, not the whole file.
  const source = fs.readFileSync(SMOKE, "utf8");
  assert.equal(source.includes("os.homedir()"), false, "smoke must not read the host home to locate a project or bundle");
  assert.equal(source.includes("SMOKE_SDK_OPTIONAL"), false, "the environmental skip flag is gone; smoke passes or fails on its own fixtures");
  assert.equal(source.includes("AndroidStudioProjects"), false, "smoke must not name a personal checkout");
  assert.equal(source.includes("process.env"), false,
    "smoke must build the server's environment explicitly, never spread the caller's");

  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "gates.yml"), "utf8");
  assert.equal(workflow.includes("SMOKE_SDK_OPTIONAL"), false, "CI must not carry an escape hatch for the smoke gate");
});

test("the child environment strips the host's toolchain variables and keeps only what is passed", () => {
  const env = smokeChildEnv("/fixture/home", { PICO_HOME: "/fixture/tools" });
  assert.equal(env.HOME, "/fixture/home");
  assert.equal(env.USERPROFILE, "/fixture/home");
  assert.equal(env.PICO_HOME, "/fixture/tools", "only an explicitly passed tools root survives");
  assert.deepEqual(
    Object.keys(env).filter((key) => /^(?:PICO_|ANDROID_)|^JAVA_HOME$/.test(key)),
    ["PICO_HOME"],
    "no host PICO_*, ANDROID_* or JAVA_HOME may reach the child",
  );
  assert.deepEqual(
    Object.keys(smokeChildEnv("/fixture/home")).filter((key) => /^(?:PICO_|ANDROID_)|^JAVA_HOME$/.test(key)),
    [],
    "with nothing passed, the child inherits no toolchain variable at all",
  );
});
