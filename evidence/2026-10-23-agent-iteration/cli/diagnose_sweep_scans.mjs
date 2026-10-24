// Read-only reproduction of the existing sweep runner's bounded process scans.
// Process command/environment contents never leave memory and are never retained.
import { spawnSync } from "node:child_process";

const report = [];
for (const kind of ["ancestry", "ownership"]) {
  const args = kind === "ancestry"
    ? ["-A", "-o", "pid=,ppid="]
    : ["eww", "-A", "-o", "pid=", "-o", "command="];
  const started = Date.now();
  const result = spawnSync("/bin/ps", args, {
    encoding: "utf8", timeout: 250, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  report.push({
    kind,
    elapsedMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
    complete: !result.error && result.status === 0,
  });
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  note: "No process command, environment, or identifiers retained; bounded scan metadata only.",
  report,
}, null, 2) + "\n");
