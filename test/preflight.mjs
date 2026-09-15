// v27-pre preflight_env: every non-pass check MUST carry a pointed fix. Run: npm run test:preflight
import fs from "node:fs";
import path from "node:path";
import {
  createManagedRuntimeHarness,
  publishManagedFixtureVersion,
} from "./helpers/picocli-managed-fixture.mjs";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const { runPreflightChecks } = await import("../dist/preflight.js");
const { detectJavaHome, gradleEnv } = await import("../dist/toolchain.js");
const { toolchainIOFromTree } = await import("./helpers/toolchain-fixture.mjs");

// A fully-broken fake environment: every runner fails.
const brokenIO = {
  nodeVersion: "v18.19.0",
  exec: () => ({ ok: false, stdout: "", stderr: "not found" }),
  readFile: () => null,
  statMtimeMs: () => null,
  now: () => 1_800_000_000_000,
  home: "/nonexistent-home",
  detectJavaHome: () => null,
};
const broken = runPreflightChecks(brokenIO);
const names = broken.map((c) => c.name);
for (const want of ["node", "adb", "emulator", "grpc", "accessibility", "calibration", "disk"]) {
  names.includes(want) ? ok(`check present: ${want}`) : fail(`missing check: ${want}`);
}
for (const c of broken) {
  if (c.status === "pass") { fail(`broken env produced a pass: ${c.name}`); continue; }
  if (typeof c.fix === "string" && c.fix.length > 10) ok(`${c.name} (${c.status}) carries a pointed fix`);
  else fail(`${c.name} (${c.status}) has no fix: ${JSON.stringify(c)}`);
}

// A healthy fake environment: node/adb/emulator/grpc/calibration/disk pass; accessibility may be unknown.
const bootAt = 1_800_000_000_000 - 60 * 60 * 1000; // emulator booted an hour ago
const healthyIO = {
  nodeVersion: "v20.11.0",
  exec: (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    if (line.includes("devices")) return { ok: true, stdout: "List of devices attached\nemulator-5554\tdevice\n" };
    if (line.includes("/proc/uptime")) return { ok: true, stdout: "3600.00 7200.00\n" };
    if (line.includes("df")) return { ok: true, stdout: "Filesystem 512-blocks Used Available Capacity\n/dev/disk 900000000 100000000 800000000 12%\n" };
    return { ok: true, stdout: "ok" };
  },
  readFile: (p) => p.endsWith("camera-calibration.json")
    ? JSON.stringify({ f: 1355.2, eyeHeight: 1.2, residualPx: 13.6, at: 1_800_000_000_000 - 30 * 60 * 1000 })
    : null,
  statMtimeMs: () => 1_800_000_000_000 - 30 * 60 * 1000,
  now: () => 1_800_000_000_000,
  home: "/fake-home",
  detectJavaHome: () => "/fake-home/jbr/Contents/Home",
};
const healthy = runPreflightChecks(healthyIO);
for (const name of ["node", "adb", "emulator", "calibration"]) {
  const c = healthy.find((x) => x.name === name);
  c && c.status === "pass" ? ok(`healthy env passes: ${name}`) : fail(`healthy env should pass ${name}: ${JSON.stringify(c)}`);
}
// v30: the Unity lane is optional — healthy fixture (statMtimeMs non-null everywhere) must PASS it,
// and the broken fixture is covered by the no-pass + fix-required loop above.
const unityLane = healthy.find((x) => x.name === "unity-lane");
unityLane && unityLane.status === "pass"
  ? ok("healthy env passes unity-lane")
  : fail(`unity-lane wrong on healthy env: ${JSON.stringify(unityLane)}`);

// Managed inspection is richer than a successful/failed `-v` probe. The doctor must retain that
// evidence instead of rewriting every unavailable policy as "first use installs latest" and every
// runnable source as "managed cached". These literals are hand-authored result contracts; no
// production formatter/parser computes the expected rows.
const cliInspectionCases = [
  {
    label: "disabled",
    inspection: {
      status: "unavailable", source: null, policy: "disabled", action: "skipped", path: null,
      version: null, raw: "", latestVersion: null, checkedAt: null, freshness: null,
      failureClass: "cli-disabled", note: "PICO CLI use is disabled by PICO_MCP_CLI_POLICY=disabled.",
      deprecatedAliases: [],
    },
    wantStatus: "warn",
    wantDetail: /disabled by PICO_MCP_CLI_POLICY=disabled/i,
    wantFix: /change PICO_MCP_CLI_POLICY/i,
  },
  {
    label: "managed-cached empty",
    inspection: {
      status: "unavailable", source: "managed", policy: "managed-cached", action: "skipped", path: null,
      version: null, raw: "", latestVersion: null, checkedAt: null, freshness: null,
      failureClass: "cli-missing", note: "No validated managed pico-cli version is published in the local store.",
      deprecatedAliases: [],
    },
    wantStatus: "warn",
    wantDetail: /managed-cached.*No validated managed pico-cli/i,
    wantFix: /managed-latest.*restart.*ensure_pico_cli/i,
  },
  {
    label: "managed-latest corrupt immutable cache",
    inspection: {
      status: "unavailable", source: "managed", policy: "managed-latest", action: "skipped", path: null,
      version: null, raw: "", latestVersion: null, checkedAt: null, freshness: null,
      failureClass: "cli-missing",
      note: "No published managed pico-cli version passed content-bound immutable-store validation. After confirming no resolver is active, remove /isolated/versions/0.4.2 and retry.",
      deprecatedAliases: [],
    },
    wantStatus: "warn",
    wantDetail: /No published.*passed content-bound immutable-store validation/i,
    wantFix: /manual recovery.*inspection note.*ensure_pico_cli/i,
  },
  {
    label: "external unusable",
    inspection: {
      status: "unavailable", source: "external", policy: "external", action: "skipped",
      path: "/opt/pico/bin/pico-cli", version: null, raw: "bad external shim", latestVersion: null,
      checkedAt: null, freshness: null, failureClass: "cli-unusable",
      note: "Configured external pico-cli did not pass the bounded -v probe.", deprecatedAliases: [],
    },
    wantStatus: "warn",
    wantDetail: /external.*did not pass the bounded -v probe/i,
    wantFix: /PICO_MCP_CLI_PATH.*restart/i,
  },
  {
    label: "invalid configuration",
    inspection: {
      status: "unavailable", source: null, policy: null, action: "skipped", path: null,
      version: null, raw: "", latestVersion: null, checkedAt: null, freshness: null,
      failureClass: "configuration",
      note: "PICO_MCP_CLI_POLICY=external requires an absolute PICO_MCP_CLI_PATH.", deprecatedAliases: [],
    },
    wantStatus: "warn",
    wantDetail: /configuration.*requires an absolute PICO_MCP_CLI_PATH/i,
    wantFix: /correct the CLI policy configuration.*restart/i,
  },
];

for (const fixture of cliInspectionCases) {
  const row = runPreflightChecks({ ...healthyIO, picoCliInspection: fixture.inspection })
    .find((check) => check.name === "pico-cli");
  if (row?.status === fixture.wantStatus
      && JSON.stringify(row.inspection) === JSON.stringify(fixture.inspection)
      && fixture.wantDetail.test(row.detail)
      && fixture.wantFix.test(row.fix ?? "")
      && !/first CLI use|registry-latest|\bcurrent\b/i.test(`${row.detail} ${row.fix}`)) {
    ok(`pico-cli inspection remains policy-honest: ${fixture.label}`);
  } else {
    fail(`pico-cli inspection flattened or overclaimed (${fixture.label}): ${JSON.stringify(row)}`);
  }
}

const runnableInspectionCases = [
  {
    label: "managed cached",
    inspection: {
      status: "ok", source: "managed", policy: "managed-cached", action: "cached",
      path: "/isolated/versions/0.4.1/node_modules/.bin/pico-cli", version: "0.4.1",
      raw: "pico-cli/0.4.1", latestVersion: null, checkedAt: null, freshness: "cached",
      deprecatedAliases: [],
    },
  },
  {
    label: "external",
    inspection: {
      status: "ok", source: "external", policy: "external", action: "external",
      path: "/opt/pico/bin/pico-cli", version: "0.2.9", raw: "pico-cli/0.2.9",
      latestVersion: null, checkedAt: null, freshness: "external", deprecatedAliases: [],
    },
  },
];

for (const fixture of runnableInspectionCases) {
  const row = runPreflightChecks({ ...healthyIO, picoCliInspection: fixture.inspection })
    .find((check) => check.name === "pico-cli");
  if (row?.status === "pass"
      && row.fix === null
      && JSON.stringify(row.inspection) === JSON.stringify(fixture.inspection)
      && row.detail.includes(`policy=${fixture.inspection.policy}`)
      && row.detail.includes(`source=${fixture.inspection.source}`)
      && row.detail.includes(`freshness=${fixture.inspection.freshness}`)
      && !/registry-latest|\bcurrent\b/i.test(row.detail)) {
    ok(`runnable pico-cli inspection preserves provenance: ${fixture.label}`);
  } else {
    fail(`runnable pico-cli provenance flattened (${fixture.label}): ${JSON.stringify(row)}`);
  }
}

// v34.1: after a healthy `-v`, preflight also consumes pico-cli's structured, read-only status.
const picoCalls = [];
const structuredStatusIO = { ...healthyIO, exec: (cmd, args) => {
  picoCalls.push([cmd, args]);
  if (cmd === "pico-cli" && args[0] === "-v") return { ok: true, stdout: "pico-cli/0.3.0\n" };
  if (cmd === "pico-cli" && args.join(" ") === "emulator status --format json") return { ok: true, stdout: '{"tool_status":"SUCCESS","data":{},"errors":[]}' };
  return healthyIO.exec(cmd, args);
} };
const structuredStatus = runPreflightChecks(structuredStatusIO).find((c) => c.name === "pico-cli-emulator-status");
structuredStatus?.status === "pass" && picoCalls.some(([cmd, args]) => cmd === "pico-cli" && args.join(" ") === "emulator status --format json") && !picoCalls.some(([cmd, args]) => cmd === "pico-cli" && /doctor/.test(args.join(" ")))
  ? ok("pico-cli structured status is read-only, exact-argv, and never a doctor probe")
  : fail(`structured pico-cli status wrong: ${JSON.stringify({ structuredStatus, picoCalls })}`);
const nestedFixIO = { ...healthyIO, exec: (cmd, args) => {
  if (cmd === "pico-cli" && args[0] === "-v") return { ok: true, stdout: "pico-cli/0.3.0\n" };
  if (cmd === "pico-cli" && args.join(" ") === "emulator status --format json") return { ok: true, stdout: JSON.stringify({ tool_status: "FAILED", errors: [{ fix: "Start the Spatial Editor" }], checks: [{ nextAction: "Retry after boot" }] }) };
  return healthyIO.exec(cmd, args);
} };
const nestedFix = runPreflightChecks(nestedFixIO).find((c) => c.name === "pico-cli-emulator-status");
nestedFix?.fix === "Start the Spatial Editor"
  ? ok("nested pico-cli returned remediation is surfaced with deterministic precedence")
  : fail(`nested pico-cli remediation was hidden: ${JSON.stringify(nestedFix)}`);

// pico-cli uses a non-zero process exit for a valid FAILED tool envelope. The envelope remains the
// authoritative diagnosis: preserve its structured payload, surface its exact nested remediation,
// and retain the process exit only as supplemental context after the structured result.
const failedEnvelopeRemediation = "pico-cli emulator install --source auto --yes";
const failedEnvelopeIO = { ...healthyIO, exec: (cmd, args) => {
  if (cmd === "pico-cli" && args[0] === "-v") return { ok: true, stdout: "pico-cli/0.3.0\n" };
  if (cmd === "pico-cli" && args.join(" ") === "emulator status --format json") {
    return {
      ok: false,
      stdout: JSON.stringify({
        tool_status: "FAILED",
        summary: "The emulator status check found a missing bundle.",
        errors: [{
          code: "EMULATOR_BUNDLE_MISSING",
          diagnostic: "No installed emulator payload matched the configured SDK.",
          recovery: { nextAction: failedEnvelopeRemediation },
        }],
      }),
      stderr: "pico-cli exited with code 23",
    };
  }
  return healthyIO.exec(cmd, args);
} };
const failedEnvelopeRow = runPreflightChecks(failedEnvelopeIO).find((c) => c.name === "pico-cli-emulator-status");
const failedEnvelopeDetail = failedEnvelopeRow?.detail ?? "";
const structuredFailureAt = failedEnvelopeDetail.indexOf("pico-cli structured emulator status: failed");
const exitContextAt = failedEnvelopeDetail.indexOf("pico-cli exited with code 23");
failedEnvelopeRow?.status === "warn"
  && failedEnvelopeRow.fix === failedEnvelopeRemediation
  && failedEnvelopeDetail.includes("EMULATOR_BUNDLE_MISSING")
  && failedEnvelopeDetail.includes("No installed emulator payload matched the configured SDK.")
  && structuredFailureAt >= 0
  && exitContextAt > structuredFailureAt
  ? ok("non-zero pico-cli exit preserves its valid FAILED envelope and exact nested remediation")
  : fail(`non-zero structured pico-cli failure was flattened: ${JSON.stringify(failedEnvelopeRow)}`);

// Calibration STALER than the emulator boot => fail with the recalibrate fix (the dies-on-restart gotcha).
const staleIO = { ...healthyIO, readFile: (p) => p.endsWith("camera-calibration.json")
  ? JSON.stringify({ f: 1355.2, at: bootAt - 24 * 60 * 60 * 1000 }) : null };
const stale = runPreflightChecks(staleIO).find((x) => x.name === "calibration");
stale && stale.status === "fail" && /calibrate_capture_camera/.test(stale.fix)
  ? ok("stale calibration fails with the recalibrate fix")
  : fail(`stale calibration mishandled: ${JSON.stringify(stale)}`);

// Calibration on file but the emulator is DOWN => freshness can't be assessed => unknown, not pass.
const emulatorDownIO = { ...healthyIO, exec: (cmd, args) => {
  const line = [cmd, ...args].join(" ");
  if (line.includes("devices")) return { ok: true, stdout: "List of devices attached\n" };
  return healthyIO.exec(cmd, args);
} };
const calWithEmuDown = runPreflightChecks(emulatorDownIO).find((x) => x.name === "calibration");
calWithEmuDown && calWithEmuDown.status === "unknown" && typeof calWithEmuDown.fix === "string" && calWithEmuDown.fix.length > 0
  ? ok("calibration on file + emulator down => unknown with a fix")
  : fail(`calibration with emulator down mishandled: ${JSON.stringify(calWithEmuDown)}`);

// Real writers persist `at` as an ISO STRING (metricverify.ts:138 — at: new Date().toISOString()).
// A stale ISO calibration MUST fail exactly like a stale epoch one; string<number coerces to NaN.
const staleIsoIO = { ...healthyIO, readFile: (p) => p.endsWith("camera-calibration.json")
  ? JSON.stringify({ f: 1355.2, at: new Date(bootAt - 24 * 60 * 60 * 1000).toISOString() }) : null };
const staleIso = runPreflightChecks(staleIsoIO).find((x) => x.name === "calibration");
staleIso && staleIso.status === "fail" && /calibrate_capture_camera/.test(staleIso.fix)
  ? ok("stale ISO-string calibration fails with the recalibrate fix")
  : fail(`stale ISO calibration mishandled: ${JSON.stringify(staleIso)}`);

// A FRESH ISO calibration (written after boot) must still pass.
// Override statMtimeMs to be stale: only correct ISO parsing yields pass; fallback to mtime would fail.
const freshIsoIO = { ...healthyIO, readFile: (p) => p.endsWith("camera-calibration.json")
  ? JSON.stringify({ f: 1355.2, at: new Date(1_800_000_000_000 - 30 * 60 * 1000).toISOString() }) : null, statMtimeMs: () => bootAt - 24 * 60 * 60 * 1000 };
const freshIso = runPreflightChecks(freshIsoIO).find((x) => x.name === "calibration");
freshIso && freshIso.status === "pass"
  ? ok("fresh ISO-string calibration passes")
  : fail(`fresh ISO calibration mishandled: ${JSON.stringify(freshIso)}`);

// Unparseable `at` must fall back to file mtime rather than silently passing.
const garbageAtIO = { ...healthyIO, readFile: (p) => p.endsWith("camera-calibration.json")
  ? JSON.stringify({ f: 1355.2, at: "not-a-date" }) : null, statMtimeMs: () => bootAt - 60 * 60 * 1000 };
const garbageAt = runPreflightChecks(garbageAtIO).find((x) => x.name === "calibration");
garbageAt && garbageAt.status === "fail"
  ? ok("unparseable calibration `at` falls back to mtime and reports stale")
  : fail(`garbage calibration at mishandled: ${JSON.stringify(garbageAt)}`);

// MCP-level Task 4 contract: a fresh child captures HOME at import time. Empty-store preflight is
// read-only (no root creation/npm), while a published cache is addressed by its absolute shim.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
async function productionPreflight(harness) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: { ...harness.env, PICO_MCP_SURFACE: "full" },
  });
  const client = new Client({ name: "preflight-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "preflight_env", arguments: {} });
    return JSON.parse(res.content[0].text);
  } finally {
    await client.close();
  }
}

const emptyManaged = createManagedRuntimeHarness();
const emptyBody = await productionPreflight(emptyManaged);
const emptyCli = emptyBody.checks?.find((row) => row.name === "pico-cli");
if (Array.isArray(emptyBody.checks)
    && emptyBody.checks.length >= 7
    && ["ok", "problems"].includes(emptyBody.status)
    && emptyCli?.status === "warn"
    && /first CLI use/i.test(`${emptyCli.detail} ${emptyCli.fix}`)
    && !fs.existsSync(emptyManaged.managedRoot)
    && emptyManaged.calls().filter((call) => call.role === "npm").length === 0)
  ok(`preflight_env is managed-store read-only when empty (status: ${emptyBody.status})`);
else fail(`preflight_env empty managed-store contract broken: ${JSON.stringify({ emptyBody, calls: emptyManaged.calls(), rootExists: fs.existsSync(emptyManaged.managedRoot) }).slice(0, 500)}`);

for (const policyCase of [
  { label: "disabled", policy: "disabled", wantPolicy: "disabled", wantStatus: "unavailable" },
  { label: "managed-cached empty", policy: "managed-cached", wantPolicy: "managed-cached", wantStatus: "unavailable" },
  { label: "invalid external config", policy: "external", cliPath: "relative/not-allowed", wantPolicy: null, wantStatus: "unavailable" },
]) {
  const harness = createManagedRuntimeHarness();
  harness.env.PICO_MCP_CLI_POLICY = policyCase.policy;
  if (policyCase.cliPath) harness.env.PICO_MCP_CLI_PATH = policyCase.cliPath;
  const beforeHome = fs.readdirSync(harness.home).sort();
  const body = await productionPreflight(harness);
  const row = body.checks?.find((check) => check.name === "pico-cli");
  if (row?.inspection?.status === policyCase.wantStatus
      && row.inspection.policy === policyCase.wantPolicy
      && harness.calls().every((call) => call.role !== "npm")
      && JSON.stringify(fs.readdirSync(harness.home).sort()) === JSON.stringify(beforeHome)) {
    ok(`preflight_env remains read-only and policy-honest: ${policyCase.label}`);
  } else {
    fail(`preflight_env policy case mutated or flattened (${policyCase.label}): ${JSON.stringify({ row, calls: harness.calls(), beforeHome, afterHome: fs.readdirSync(harness.home).sort() }).slice(0, 600)}`);
  }
  fs.rmSync(harness.root, { recursive: true, force: true });
}

{
  const harness = createManagedRuntimeHarness();
  const externalCli = path.join(harness.root, process.platform === "win32" ? "external-pico-cli.cmd" : "external-pico-cli");
  if (process.platform === "win32") {
    fs.writeFileSync(externalCli, "@echo off\r\nif \"%1\"==\"-v\" (echo pico-cli/0.2.9& exit /b 0)\r\necho {\"tool_status\":\"SUCCESS\",\"data\":{},\"errors\":[]}& exit /b 0\r\n");
  } else {
    fs.writeFileSync(externalCli, "#!/bin/sh\nif [ \"$1\" = \"-v\" ]; then printf 'pico-cli/0.2.9\\n'; else printf '{\"tool_status\":\"SUCCESS\",\"data\":{},\"errors\":[]}\\n'; fi\n", { mode: 0o755 });
  }
  harness.env.PICO_MCP_CLI_POLICY = "external";
  harness.env.PICO_MCP_CLI_PATH = externalCli;
  const beforeHome = fs.readdirSync(harness.home).sort();
  const body = await productionPreflight(harness);
  const row = body.checks?.find((check) => check.name === "pico-cli");
  if (row?.inspection?.status === "ok"
      && row.inspection.policy === "external"
      && row.inspection.source === "external"
      && row.inspection.freshness === "external"
      && harness.calls().every((call) => call.role !== "npm")
      && JSON.stringify(fs.readdirSync(harness.home).sort()) === JSON.stringify(beforeHome)) {
    ok("preflight_env probes configured external CLI read-only without relabeling it managed/latest");
  } else {
    fail(`preflight_env external inspection mutated or flattened: ${JSON.stringify({ row, calls: harness.calls() }).slice(0, 600)}`);
  }
  fs.rmSync(harness.root, { recursive: true, force: true });
}

const cachedManaged = createManagedRuntimeHarness();
const published = publishManagedFixtureVersion(cachedManaged, cachedManaged.managedRoot, "0.4.2");
const cachedBody = await productionPreflight(cachedManaged);
const cachedCli = cachedBody.checks?.find((row) => row.name === "pico-cli");
const cachedStatus = cachedBody.checks?.find((row) => row.name === "pico-cli-emulator-status");
const cachedCalls = cachedManaged.calls();
if (cachedCli?.status === "pass"
    && cachedStatus?.status === "pass"
    && cachedCalls.some((call) => call.role === "managed-cli" && call.args.join(" ") === "0.4.2 -v")
    && cachedCalls.some((call) => call.role === "managed-cli" && call.args.join(" ") === "0.4.2 emulator status --format json")
    && cachedCalls.filter((call) => call.role === "npm").length === 0
    && published.shimPath.includes(path.join("versions", "0.4.2")))
  ok("preflight_env inspects cached managed CLI and emulator status without registry/install");
else fail(`preflight_env cached managed-store contract broken: ${JSON.stringify({ cachedCli, cachedStatus, cachedCalls }).slice(0, 500)}`);

fs.rmSync(emptyManaged.root, { recursive: true, force: true });
fs.rmSync(cachedManaged.root, { recursive: true, force: true });

// ===========================================================================================
// Task S2 block — the pico-sdk row comes from the injected structural toolchain selection.
// (Appended as one delimited block; the CLI track appends its own after this one.)
// ===========================================================================================
{
  // The brief's regression, verbatim: a host whose selection is 6.1 must not be described
  // through the legacy hardcoded 0.13 directory.
  const checks = runPreflightChecks({...healthyIO, toolchainInspection:{
    status:"ok", root:"/sdk", rootSource:"PICO_HOME", version:"6.1",
    reason:"newest-usable", files:{packer:{path:"/sdk/6.1/packer",sha256:"a".repeat(64)}}, identity:"b".repeat(64)
  }});
  const row = checks.find((x) => x.name === "pico-sdk");
  if (row && row.status === "pass" && /6\.1/.test(row.detail) && !/0\.13/.test(row.detail)) {
    ok("pico-sdk row reports the SELECTED version, not the legacy 0.13 directory");
  } else {
    fail(`pico-sdk row did not report the injected 6.1 selection: ${JSON.stringify(row)}`);
  }
  if (row && /PICO_HOME/.test(row.detail)) ok("pico-sdk row names the selected root source");
  else fail(`pico-sdk row does not name the root source: ${JSON.stringify(row)}`);
}

{
  // An existing (empty) 0.13 directory used to be the whole check. statMtimeMs() returning a
  // number for EVERY path is exactly that machine; an unavailable selection must still fail.
  const checks = runPreflightChecks({...healthyIO, toolchainInspection:{
    status:"unavailable", code:"unavailable/component-missing",
    detail:"No toolchain under /fake-home/Library/PICO/sdk provides every required component (packer); inspected 0.13",
  }});
  const row = checks.find((x) => x.name === "pico-sdk");
  if (row && row.status === "fail" && /component-missing/.test(row.detail) && typeof row.fix === "string" && row.fix.length > 10) {
    ok("an empty 0.13 directory no longer makes an unavailable selection pass");
  } else {
    fail(`unavailable selection did not fail the pico-sdk row: ${JSON.stringify(row)}`);
  }
}

{
  // Split install: the packer is 6.1 and the emulator payload is 6.0. Each component reports its
  // OWN version instead of the pair collapsing to one "unavailable".
  const checks = runPreflightChecks({...healthyIO,
    toolchainInspection:{
      status:"ok", root:"/sdk", rootSource:"local.properties", version:"6.1", reason:"newest-usable",
      files:{packer:{path:"/sdk/6.1/editor/spatialbundle/spatialbundle",sha256:"c".repeat(64)}}, identity:"d".repeat(64),
    },
    emulatorInspection:{
      status:"ok", root:"/sdk", rootSource:"local.properties", version:"6.0", reason:"newest-usable",
      files:{emulator:{path:"/sdk/6.0/emulator/emulator",sha256:"e".repeat(64)}}, identity:"f".repeat(64),
    },
  });
  const row = checks.find((x) => x.name === "pico-sdk");
  if (row && row.status === "pass" && /packer 6\.1/.test(row.detail) && /emulator 6\.0/.test(row.detail)) {
    ok("pico-sdk row reports packer and emulator versions separately");
  } else {
    fail(`split 6.1/6.0 install was not reported per component: ${JSON.stringify(row)}`);
  }
}

{
  // A packer-only host is still buildable; the missing emulator payload is disclosed, not hidden.
  const checks = runPreflightChecks({...healthyIO,
    toolchainInspection:{
      status:"ok", root:"/sdk", rootSource:"PICO_HOME", version:"6.1", reason:"newest-usable",
      files:{packer:{path:"/sdk/6.1/editor/spatialbundle/spatialbundle",sha256:"c".repeat(64)}}, identity:"d".repeat(64),
    },
    emulatorInspection:{ status:"unavailable", code:"unavailable/component-missing", detail:"no emulator payload under /sdk" },
  });
  const row = checks.find((x) => x.name === "pico-sdk");
  if (row && row.status === "pass" && /packer 6\.1/.test(row.detail) && /emulator unavailable/.test(row.detail)) {
    ok("pico-sdk row discloses a missing emulator payload without failing the build SDK");
  } else {
    fail(`packer-only host mis-reported: ${JSON.stringify(row)}`);
  }
}

{
  // Fixtures that describe no structural inspection get an honest "unknown", never a pass and
  // never a silent 0.13 claim.
  const row = runPreflightChecks(healthyIO).find((x) => x.name === "pico-sdk");
  if (row && row.status === "unknown" && !/0\.13/.test(row.detail) && typeof row.fix === "string" && row.fix.length > 10) {
    ok("pico-sdk row is unknown (not pass) when no structural selection was supplied");
  } else {
    fail(`pico-sdk row without an inspection is wrong: ${JSON.stringify(row)}`);
  }
}

// ── Task S4: the adb row's candidate ordering, provenance and override validation ─────────────
// S2 gave this row an adbInspection but shipped no assertions for it. The precedence the adapter
// in src/adb.ts implements is explicit $PICO_ADB -> PATH -> the SELECTED toolchain's bundled
// platform-tools, with the legacy 0.13 location retained only as a last candidate; the row must
// agree, and an override that does not answer `adb version` must never be reported as the answer.
{
  const SELECTED = "/sdk/6.1/emulator/system-images/platform-tools/adb";
  const adbInspection = {
    status: "ok", root: "/sdk", rootSource: "PICO_HOME", version: "6.1", reason: "newest-usable",
    files: { adb: { path: SELECTED, sha256: "a".repeat(64) } }, identity: "b".repeat(64),
  };
  // `working` names every candidate this fake machine answers `adb version` for.
  const adbIO = (working, extra = {}) => {
    const probed = [];
    return {
      io: {
        ...healthyIO,
        adbInspection,
        // Declared explicitly so these rows never read this HOST's $PICO_ADB: without it a
        // developer machine that exports one would silently change which candidates are probed.
        adbOverride: null,
        exec: (cmd, args) => {
          if (args[0] === "version") { probed.push(cmd); return { ok: working.includes(cmd), stdout: working.includes(cmd) ? "Android Debug Bridge version 1.0.41" : "", stderr: "" }; }
          return healthyIO.exec(cmd, args);
        },
        ...extra,
      },
      probed,
    };
  };

  {
    const { io, probed } = adbIO(["/opt/pinned/adb", "adb", SELECTED], { adbOverride: "/opt/pinned/adb" });
    const row = runPreflightChecks(io).find((x) => x.name === "adb");
    row && row.status === "pass" && /\/opt\/pinned\/adb/.test(row.detail) && /PICO_ADB|explicit/i.test(row.detail)
      ? ok("adb row reports an explicit PICO_ADB with its provenance")
      : fail(`explicit PICO_ADB not reported: ${JSON.stringify(row)}`);
    // Fail-closed precedence: when an override is configured it is the ONLY candidate, so the row
    // can never report an adb that src/adb.ts would refuse to run.
    JSON.stringify(probed) === JSON.stringify(["/opt/pinned/adb"])
      ? ok("adb row probes the explicit override and nothing else")
      : fail(`override was not the only probe: ${JSON.stringify(probed)}`);
  }

  {
    const { io, probed } = adbIO(["adb", SELECTED]);
    const row = runPreflightChecks(io).find((x) => x.name === "adb");
    row && row.status === "pass" && /^adb\b/.test(row.detail) && /PATH/i.test(row.detail)
      ? ok("adb row prefers PATH over the bundled payload")
      : fail(`PATH-first ordering not reported: ${JSON.stringify(row)}`);
    probed.indexOf("adb") < probed.indexOf(SELECTED) || !probed.includes(SELECTED)
      ? ok("adb row probes PATH before the selected payload")
      : fail(`candidate order wrong: ${JSON.stringify(probed)}`);
  }

  {
    const { io, probed } = adbIO([SELECTED]);
    const row = runPreflightChecks(io).find((x) => x.name === "adb");
    row && row.status === "pass" && row.detail.startsWith(SELECTED)
      ? ok("adb row falls back to the SELECTED toolchain's bundled adb")
      : fail(`bundled fallback not reported: ${JSON.stringify(row)}`);
    !/0\.13/.test(probed.slice(0, probed.indexOf(SELECTED) + 1).join(" "))
      ? ok("the legacy 0.13 path is not probed before the selected payload")
      : fail(`0.13 probed too early: ${JSON.stringify(probed)}`);
  }

  {
    // An override whose bytes do not answer `adb version` FAILS CLOSED: it is never replaced by a
    // PATH adb the operator did not ask for. A working PATH adb is present here precisely so the
    // row cannot pass by falling through to it.
    const { io, probed } = adbIO(["adb", SELECTED], { adbOverride: "/opt/broken/adb" });
    const row = runPreflightChecks(io).find((x) => x.name === "adb");
    row && row.status === "fail" && /\/opt\/broken\/adb/.test(row.detail) && /never replaced/i.test(row.detail)
      && typeof row.fix === "string" && /unset it/i.test(row.fix)
      ? ok("an unusable PICO_ADB fails closed and is disclosed")
      : fail(`invalid override mishandled: ${JSON.stringify(row)}`);
    JSON.stringify(probed) === JSON.stringify(["/opt/broken/adb"])
      ? ok("a rejected override stops the probe: no PATH or bundled candidate is consulted")
      : fail(`fallback was probed after a rejected override: ${JSON.stringify(probed)}`);
  }

  {
    // With NO override configured the row still lists every candidate it tried.
    const { io } = adbIO([]);
    const row = runPreflightChecks(io).find((x) => x.name === "adb");
    row && row.status === "fail" && /\badb\b/.test(row.detail) && /\/sdk\/6\.1\//.test(row.detail) && /0\.13/.test(row.detail)
      && typeof row.fix === "string" && row.fix.length > 10
      ? ok("a failing adb row with no override lists every probed candidate and carries a fix")
      : fail(`adb failure detail incomplete: ${JSON.stringify(row)}`);
  }
}

// ── Task S4: JDK inspection and gradleEnv answer from ONE injected context ────────────────────
{
  const jdkIO = (home, executable) => toolchainIOFromTree({
    platform: "darwin", home: "/fixture",
    env: { JAVA_HOME: home }, files: { [`${home}/bin/java`]: { bytes: "fixture-java", executable } },
  });
  for (const [home, executable, expected] of [["/jdk-a", true, "/jdk-a"], ["/jdk-b", true, "/jdk-b"], ["/jdk-b", false, null]]) {
    const context = jdkIO(home, executable);
    const detected = detectJavaHome(context);
    const injected = gradleEnv(context);
    const row = runPreflightChecks({ ...healthyIO, detectJavaHome: () => detectJavaHome(context), javaHomeEnv: context.env.JAVA_HOME ?? null })
      .find((x) => x.name === "jdk");
    detected === expected
      ? ok(`jdk inspection follows the injected context (${home}, executable=${executable})`)
      : fail(`jdk inspection ignored the injected context: got ${JSON.stringify(detected)}, want ${JSON.stringify(expected)}`);
    JSON.stringify(injected) === JSON.stringify(expected ? { JAVA_HOME: expected } : {})
      ? ok(`gradleEnv agrees with the same context (${home})`)
      : fail(`gradleEnv disagreed with detectJavaHome: ${JSON.stringify(injected)} vs ${JSON.stringify(detected)}`);
    const rowAgrees = expected ? row.status === "pass" && row.detail.includes(expected) : row.status === "fail";
    rowAgrees
      ? ok(`the jdk row reports exactly what the Gradle lane would get (${home})`)
      : fail(`jdk row disagrees with the build lane: ${JSON.stringify(row)}`);
  }
  const declared = jdkIO("/jdk-a", true);
  const declaredRow = runPreflightChecks({ ...healthyIO, detectJavaHome: () => detectJavaHome(declared), javaHomeEnv: "/jdk-a" }).find((x) => x.name === "jdk");
  /JAVA_HOME=\/jdk-a/.test(declaredRow?.detail ?? "")
    ? ok("the jdk row names JAVA_HOME as the source when the injected environment declares it")
    : fail(`jdk row source wrong: ${JSON.stringify(declaredRow)}`);
}

console.log(`\nPreflight test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
