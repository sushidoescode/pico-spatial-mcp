// v27-pre preflight_env: every non-pass check MUST carry a pointed fix. Run: npm run test:preflight
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
};
const healthy = runPreflightChecks(healthyIO);
for (const name of ["node", "adb", "emulator", "calibration"]) {
  const c = healthy.find((x) => x.name === name);
  c && c.status === "pass" ? ok(`healthy env passes: ${name}`) : fail(`healthy env should pass ${name}: ${JSON.stringify(c)}`);
}

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

// MCP-level: the tool is registered on the full surface and returns the check array.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, PICO_MCP_SURFACE: "full" } });
const client = new Client({ name: "preflight-test", version: "0.0.0" });
await client.connect(transport);
const res = await client.callTool({ name: "preflight_env", arguments: {} });
const body = JSON.parse(res.content[0].text);
Array.isArray(body.checks) && body.checks.length >= 7 && ["ok", "problems"].includes(body.status)
  ? ok(`preflight_env registered (status: ${body.status}, ${body.checks.length} checks)`)
  : fail(`preflight_env bad shape: ${JSON.stringify(body).slice(0, 200)}`);
await client.close();

console.log(`\nPreflight test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
