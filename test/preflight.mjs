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

console.log(`\nPreflight test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
