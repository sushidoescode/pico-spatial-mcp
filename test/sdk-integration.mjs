/**
 * sdk-integration — the host-toolchain lane the default smoke no longer owns.
 *
 * `validate_toolchain`, `emulator_list`, real bundle pack/inspect and SDK/proto discovery need an
 * installed PICO SDK and a real project, so they cannot be part of a gate that must mean the same
 * thing on every machine. They live here instead, behind three explicit absolute paths that the
 * operator types. Nothing is discovered: there is no "found an SDK, so run the real lane" branch,
 * which is exactly the behaviour that made the old smoke a property of the developer's machine.
 *
 * Two modes, one file:
 *
 *   node --test test/sdk-integration.mjs                      the gate: fixtures only, no SDK, no
 *                                                             server, no host project (test:sdk-integration)
 *   node test/sdk-integration.mjs run --project <abs dir> \   the real run, never a gate
 *        --bundle <abs file> --output <abs new dir>
 *
 * Mutations of the real run: it creates `--output` (and only that directory) and writes a packed
 * bundle plus `integration-report.json` inside it. `--output` must not already exist — a run never
 * overwrites earlier evidence. `--project` and `--bundle` are opened read-only. No device is
 * contacted beyond `emulator_list`'s read-only enumeration, and nothing is installed or launched.
 *
 * Every step yields `{check, status, reason}`. Absence of optional tooling is `skipped` with the
 * reason naming what was missing; it is never evidence that the step passed. A malformed project, a
 * tool crash, a schema mismatch or an unsuccessful pack is `fail`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const INTEGRATION_USAGE =
  "usage: node test/sdk-integration.mjs run --project <abs project dir> --bundle <abs bundle file> --output <abs new dir>";

const FLAGS = { "--project": "projectDir", "--bundle": "bundlePath", "--output": "outputDir" };

function usageError(reason) {
  return new Error(`${reason}\n${INTEGRATION_USAGE}`);
}

/**
 * The three paths the real run needs, all explicit and all absolute. There is no default, no
 * environment fallback and no discovery: a missing or relative path is an error, not a prompt to go
 * looking on the host.
 */
export function parseIntegrationArgs(argv) {
  const parsed = {};
  const list = [...argv];
  while (list.length) {
    const token = list.shift();
    const [flag, inlineValue] = token.startsWith("--") && token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];
    const key = FLAGS[flag];
    if (!key) throw usageError(`unknown argument ${token}`);
    if (parsed[key] !== undefined) throw usageError(`${flag} given more than once`);
    const value = inlineValue ?? list.shift();
    if (!value) throw usageError(`${flag} needs a value`);
    parsed[key] = value;
  }
  const missing = Object.entries(FLAGS).filter(([, key]) => parsed[key] === undefined).map(([flag]) => flag);
  if (missing.length) throw usageError(`missing required ${missing.length === 1 ? "argument" : "arguments"}: ${missing.join(", ")}`);
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (!path.isAbsolute(parsed[key])) throw usageError(`${flag} must be an absolute path, got ${parsed[key]}`);
  }
  return { projectDir: parsed.projectDir, bundlePath: parsed.bundlePath, outputDir: parsed.outputDir };
}

export const record = (check, status, reason) => ({ check, status, reason });

/**
 * Everything that must hold before a single tool is invoked, so a run that cannot mean anything
 * fails at its first step instead of halfway through a pack.
 *
 * `--output` is created with a non-recursive mkdir precisely so that an existing directory is an
 * error: earlier evidence is preserved rather than merged into or silently replaced.
 */
export function checkIntegrationPrerequisites(args, { toolsRoot = null, spatialbundle = null, emulatorPayload = null } = {}) {
  const records = [];

  try {
    fs.accessSync(args.projectDir, fs.constants.R_OK);
    if (!fs.statSync(args.projectDir).isDirectory()) {
      records.push(record("project-readable", "fail", `--project is not a directory: ${args.projectDir}`));
    } else if (!fs.readdirSync(args.projectDir).some((entry) => entry.endsWith(".spatialproject"))) {
      records.push(record("project-readable", "fail", `--project holds no <Name>.spatialproject file: ${args.projectDir}`));
    } else {
      records.push(record("project-readable", "pass", args.projectDir));
    }
  } catch (error) {
    records.push(record("project-readable", "fail", `--project is not readable: ${error.message}`));
  }

  try {
    fs.accessSync(args.bundlePath, fs.constants.R_OK);
    records.push(fs.statSync(args.bundlePath).isFile()
      ? record("bundle-readable", "pass", args.bundlePath)
      : record("bundle-readable", "fail", `--bundle is not a file: ${args.bundlePath}`));
  } catch (error) {
    records.push(record("bundle-readable", "fail", `--bundle is not readable: ${error.message}`));
  }

  try {
    fs.mkdirSync(args.outputDir); // no recursive replacement; EEXIST preserves prior evidence
    records.push(record("output-fresh", "pass", args.outputDir));
  } catch (error) {
    records.push(record("output-fresh", "fail", error.code === "EEXIST"
      ? `--output already exists; choose a new directory so prior evidence is preserved: ${args.outputDir}`
      : `--output could not be created: ${error.message}`));
  }

  // The two optional payloads, reported separately because they gate different steps. Absent is a
  // labeled skip here and a labeled skip for everything downstream of it — never a failure, and
  // never silence that could be mistaken for a step having passed.
  const where = toolsRoot ?? "(unresolved tools root)";
  records.push(spatialbundle
    ? record("spatialbundle-available", "pass", spatialbundle)
    : record("spatialbundle-available", "skipped", `no spatialbundle payload under ${where}; scene-schema and bundle steps cannot run`));
  records.push(emulatorPayload
    ? record("emulator-payload-available", "pass", emulatorPayload)
    : record("emulator-payload-available", "skipped", `no emulator payload under ${where}; proto discovery cannot run`));

  return records;
}

/**
 * One tool call's outcome. An MCP error, a thrown call, or a result whose structuredContent does
 * not satisfy `expect` are all `fail` — a tool that answers with the wrong shape has not passed,
 * and a crash is never a skip.
 */
export function classifyToolOutcome(check, result, expect) {
  if (result instanceof Error) return record(check, "fail", `tool call threw: ${result.message}`);
  if (result?.isError) {
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return record(check, "fail", text.slice(0, 400) || "tool returned isError with no text");
  }
  if (expect && !expect(result)) {
    return record(check, "fail", `result did not match the expected contract: ${JSON.stringify(result?.structuredContent ?? result?.content ?? null).slice(0, 400)}`);
  }
  return record(check, "pass", "");
}

/** Every step a run performs once its prerequisites hold, in the order it performs them. */
export const INTEGRATION_STEPS = Object.freeze([
  "validate_toolchain", "emulator_list", "xr_grpc_describe",
  "scene_schemas", "inspect_bundle-supplied", "pack_bundle", "inspect_bundle-packed",
]);

/**
 * A run stopped by its prerequisites still reports every step it did not reach, as a skip naming
 * what stopped it. Omitting them would leave a reader unable to tell "not attempted" from "fine".
 */
export function blockedStepRecords(prerequisites) {
  const blockers = prerequisites.filter((entry) => entry.status === "fail").map((entry) => entry.check);
  if (blockers.length === 0) return [];
  return INTEGRATION_STEPS.map((check) => record(check, "skipped", `not attempted: ${blockers.join(", ")} failed`));
}

/**
 * Did this run create `--output` itself? Only then may it write into that directory. A refused
 * `--output` already holds an earlier run's evidence, and writing a report there would undo the
 * very guard that refused it.
 */
export function createdOutputDirectory(records) {
  return records.find((entry) => entry.check === "output-fresh")?.status === "pass";
}

/** A run is a pass only if nothing failed. Skips are reported, never counted as evidence. */
export function summarizeIntegration(records) {
  const counts = { pass: 0, fail: 0, skipped: 0 };
  for (const entry of records) counts[entry.status] += 1;
  return { status: counts.fail > 0 ? "fail" : "pass", counts, evidence: counts.pass > 0 && counts.fail === 0 };
}

/** Steps whose only prerequisite is a live server; they carry no SDK requirement of their own. */
function serverOnlySteps(client) {
  return [
    ["validate_toolchain", () => client.callTool({ name: "validate_toolchain", arguments: {} }),
      (r) => Array.isArray(r.structuredContent?.problems)],
    ["emulator_list", () => client.callTool({ name: "emulator_list", arguments: {} }), null],
  ];
}

async function runIntegration(argv) {
  const args = parseIntegrationArgs(argv);
  for (const input of [args.projectDir, args.bundlePath]) fs.accessSync(input, fs.constants.R_OK);

  const { resolveToolsRoot, pickVersion } = await import("../dist/toolchain.js");
  const { root: toolsRoot } = resolveToolsRoot(args.projectDir);
  const spatialbundle = pickVersion(toolsRoot, undefined, "editor")?.spatialbundle ?? null;
  const emulatorPayload = pickVersion(toolsRoot, undefined, "emulator")?.emulatorBin ?? null;

  const records = checkIntegrationPrerequisites(args, { toolsRoot, spatialbundle, emulatorPayload });
  const blocked = records.some((entry) => entry.status === "fail");

  if (blocked) {
    records.push(...blockedStepRecords(records));
  } else {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "sdk-integration", version: "0.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "dist", "index.js")],
      env: { ...process.env, PICO_MCP_SURFACE: "full" },
    }));
    try {
      for (const [check, call, expect] of serverOnlySteps(client)) {
        records.push(classifyToolOutcome(check, await call().catch((error) => error), expect));
      }
      records.push(emulatorPayload
        ? classifyToolOutcome("xr_grpc_describe", await client.callTool({ name: "xr_grpc_describe", arguments: {} }).catch((e) => e), null)
        : record("xr_grpc_describe", "skipped", "no emulator payload on this host; proto discovery has nothing to read"));

      if (!spatialbundle) {
        for (const check of ["scene_schemas", "inspect_bundle-supplied", "pack_bundle", "inspect_bundle-packed"]) {
          records.push(record(check, "skipped", "no spatialbundle payload on this host"));
        }
      } else {
        records.push(classifyToolOutcome("scene_schemas", await client.callTool({ name: "scene_schemas", arguments: {} }).catch((e) => e), null));
        const packed = path.join(args.outputDir, "integration.bundle");
        records.push(classifyToolOutcome(
          "inspect_bundle-supplied",
          await client.callTool({ name: "inspect_bundle", arguments: { bundlePath: args.bundlePath } }).catch((e) => e),
          null,
        ));
        records.push(classifyToolOutcome(
          "pack_bundle",
          await client.callTool({
            name: "pack_bundle",
            arguments: { sceneDir: path.join(args.projectDir, "Sources", "Scenes"), projectDir: args.projectDir, output: packed, forceBuild: true },
          }).catch((e) => e),
          () => fs.existsSync(packed),
        ));
        records.push(fs.existsSync(packed)
          ? classifyToolOutcome("inspect_bundle-packed", await client.callTool({ name: "inspect_bundle", arguments: { bundlePath: packed } }).catch((e) => e), null)
          : record("inspect_bundle-packed", "fail", "pack produced no bundle to inspect"));
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  const summary = summarizeIntegration(records);
  if (createdOutputDirectory(records)) {
    fs.writeFileSync(path.join(args.outputDir, "integration-report.json"), `${JSON.stringify({ args, toolsRoot, spatialbundle, emulatorPayload, records, summary }, null, 2)}\n`);
  }
  for (const entry of records) console.log(`${entry.status.padEnd(7)} ${entry.check}${entry.reason ? ` — ${entry.reason}` : ""}`);
  console.log(`\nSDK integration ${summary.status}: ${summary.counts.pass} pass, ${summary.counts.fail} fail, ${summary.counts.skipped} skipped`);
  process.exit(summary.status === "fail" ? 1 : 0);
}

// --------------------------------------------------------------------------- fixtures-only gate

function registerUnitTests() {
  test("the CLI names all three required paths and accepts nothing implicit", () => {
    assert.throws(() => parseIntegrationArgs([]), /--project.*--bundle.*--output/);
    assert.throws(() => parseIntegrationArgs(["--project", "/abs/p", "--bundle", "/abs/b"]), /missing required argument: --output/);
    assert.throws(() => parseIntegrationArgs(["--project", "relative/p", "--bundle", "/abs/b", "--output", "/abs/o"]), /--project must be an absolute path/);
    assert.throws(() => parseIntegrationArgs(["--project", "/abs/p", "--bundle", "/abs/b", "--output", "out"]), /--output must be an absolute path/);
    assert.throws(() => parseIntegrationArgs(["--sdk", "/abs/s"]), /unknown argument --sdk/);
    assert.throws(() => parseIntegrationArgs(["--project", "/a", "--project", "/b", "--bundle", "/c", "--output", "/d"]), /--project given more than once/);
    assert.throws(() => parseIntegrationArgs(["--project"]), /--project needs a value/);

    assert.deepEqual(
      parseIntegrationArgs(["--project", "/abs/p", "--bundle", "/abs/b", "--output", "/abs/o"]),
      { projectDir: "/abs/p", bundlePath: "/abs/b", outputDir: "/abs/o" },
    );
    assert.deepEqual(
      parseIntegrationArgs(["--output=/abs/o", "--bundle=/abs/b", "--project=/abs/p"]),
      { projectDir: "/abs/p", bundlePath: "/abs/b", outputDir: "/abs/o" },
    );
  });

  test("prerequisites accept a well-formed fixture project and create the output directory fresh", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-sdkint-ok-"));
    try {
      const args = fixtureArgs(root);
      const records = checkIntegrationPrerequisites(args, {
        toolsRoot: "/fixture/tools",
        spatialbundle: "/fixture/tools/6.1/editor/spatialbundle/spatialbundle",
        emulatorPayload: "/fixture/tools/6.1/emulator/emulator",
      });
      assert.deepEqual(records.map((r) => [r.check, r.status]), [
        ["project-readable", "pass"],
        ["bundle-readable", "pass"],
        ["output-fresh", "pass"],
        ["spatialbundle-available", "pass"],
        ["emulator-payload-available", "pass"],
      ]);
      assert.equal(fs.existsSync(args.outputDir), true);
      assert.equal(createdOutputDirectory(records), true);
      assert.equal(summarizeIntegration(records).status, "pass");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an existing output directory is a failure, and its prior evidence survives", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-sdkint-eexist-"));
    try {
      const args = fixtureArgs(root);
      fs.mkdirSync(args.outputDir);
      const priorEvidence = path.join(args.outputDir, "earlier-run.json");
      fs.writeFileSync(priorEvidence, "{\"kept\":true}");

      const records = checkIntegrationPrerequisites(args, { toolsRoot: "/fixture/tools", spatialbundle: "/fixture/sb" });
      const output = records.find((r) => r.check === "output-fresh");
      assert.equal(output.status, "fail");
      assert.match(output.reason, /already exists.*prior evidence is preserved/);
      assert.equal(fs.readFileSync(priorEvidence, "utf8"), "{\"kept\":true}");
      assert.equal(summarizeIntegration(records).status, "fail");
      assert.equal(createdOutputDirectory(records), false, "a refused --output must not be written into");

      const blocked = blockedStepRecords(records);
      assert.deepEqual(blocked.map((r) => r.check), [...INTEGRATION_STEPS]);
      assert.equal(blocked.every((r) => r.status === "skipped" && /not attempted: output-fresh failed/.test(r.reason)), true);
      assert.deepEqual(blockedStepRecords([record("output-fresh", "pass", "")]), [],
        "a run whose prerequisites hold reports real step outcomes, not blocked skips");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed or unreadable input is a failure, never a skip", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-sdkint-bad-"));
    try {
      const args = fixtureArgs(root);
      fs.rmSync(path.join(args.projectDir, "Fixture.spatialproject"));
      fs.rmSync(args.bundlePath);
      const records = checkIntegrationPrerequisites(args, { toolsRoot: "/fixture/tools", spatialbundle: "/fixture/sb", emulatorPayload: "/fixture/emu" });
      const byCheck = Object.fromEntries(records.map((r) => [r.check, r]));
      assert.equal(byCheck["project-readable"].status, "fail");
      assert.match(byCheck["project-readable"].reason, /no <Name>\.spatialproject file/);
      assert.equal(byCheck["bundle-readable"].status, "fail");
      assert.deepEqual(
        records.filter((r) => r.status === "skipped"),
        [],
        "a malformed input is a failure; with both payloads present nothing here may be a skip",
      );
      assert.equal(summarizeIntegration(records).status, "fail");

      const notADir = { ...args, projectDir: args.bundlePath };
      fs.writeFileSync(args.bundlePath, "bytes");
      assert.equal(checkIntegrationPrerequisites(notADir, {}).find((r) => r.check === "project-readable").reason.includes("not a directory"), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing optional tooling is a labeled skip that never counts as evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-sdkint-skip-"));
    try {
      const records = checkIntegrationPrerequisites(fixtureArgs(root), { toolsRoot: "/fixture/tools", spatialbundle: null, emulatorPayload: null });
      const sb = records.find((r) => r.check === "spatialbundle-available");
      assert.equal(sb.status, "skipped");
      assert.match(sb.reason, /no spatialbundle payload under \/fixture\/tools/);
      const emu = records.find((r) => r.check === "emulator-payload-available");
      assert.equal(emu.status, "skipped");
      assert.match(emu.reason, /no emulator payload under \/fixture\/tools/);
      assert.equal(summarizeIntegration(records).status, "pass", "a missing optional payload is not a failure");

      assert.deepEqual(summarizeIntegration([record("a", "skipped", "")]), {
        status: "pass", counts: { pass: 0, fail: 0, skipped: 1 }, evidence: false,
      });
      assert.deepEqual(summarizeIntegration([record("a", "pass", ""), record("b", "skipped", "")]), {
        status: "pass", counts: { pass: 1, fail: 0, skipped: 1 }, evidence: true,
      });
      assert.deepEqual(summarizeIntegration([record("a", "pass", ""), record("b", "fail", "boom")]), {
        status: "fail", counts: { pass: 1, fail: 1, skipped: 0 }, evidence: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tool error, a thrown call, and a schema mismatch are each a failure", () => {
    assert.deepEqual(
      classifyToolOutcome("validate_toolchain", { structuredContent: { problems: [] } }, (r) => Array.isArray(r.structuredContent?.problems)),
      record("validate_toolchain", "pass", ""),
    );
    assert.equal(classifyToolOutcome("pack_bundle", { isError: true, content: [{ type: "text", text: "spatialbundle pack failed (exit 19)" }] }, null).status, "fail");
    assert.match(classifyToolOutcome("pack_bundle", { isError: true, content: [{ type: "text", text: "spatialbundle pack failed (exit 19)" }] }, null).reason, /exit 19/);
    assert.equal(classifyToolOutcome("emulator_list", new Error("transport closed"), null).status, "fail");
    const mismatch = classifyToolOutcome("validate_toolchain", { structuredContent: { problems: "not an array" } }, (r) => Array.isArray(r.structuredContent?.problems));
    assert.equal(mismatch.status, "fail");
    assert.match(mismatch.reason, /did not match the expected contract/);
  });

  test("the explicit run mode is documented and is not a gate", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assert.equal(pkg.scripts["test:sdk-integration"], "node scripts/run-gate.mjs test:sdk-integration",
      "the gate runs this file's fixtures only");
    // includes(), not match(): a regex failure here would print the whole README as the diff.
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    assert.equal(readme.includes("node test/sdk-integration.mjs run"), true,
      "README must carry the explicit run command");
    for (const flag of ["--project", "--bundle", "--output"]) {
      assert.equal(readme.includes(flag), true, `README must document ${flag}`);
    }
    const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "gates.yml"), "utf8");
    assert.equal(workflow.includes("sdk-integration.mjs run"), false, "the host run must never be wired into CI");
  });
}

function fixtureArgs(root) {
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "Sources", "Scenes"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "Fixture.spatialproject"), "{}");
  const bundlePath = path.join(root, "supplied.bundle");
  fs.writeFileSync(bundlePath, "bundle bytes");
  return { projectDir, bundlePath, outputDir: path.join(root, "out") };
}

if (process.argv[2] === "run") {
  // A bad invocation prints its reason and the usage line, not a stack trace, and exits before any
  // server is spawned or any directory is created.
  try {
    await runIntegration(process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
} else registerUnitTests();
