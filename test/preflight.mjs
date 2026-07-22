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

console.log(`\nPreflight test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
