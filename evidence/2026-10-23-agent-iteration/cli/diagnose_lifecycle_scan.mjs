// Reproduce only the existing read-only process-table command; never retain its environment data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  ["baseline-1157f33", path.join(directory, "baseline-lifecycle/dist/picocli.js")],
  ["candidate", path.resolve(directory, "../../../dist/picocli.js")],
];
const observations = [];
for (const [label, modulePath] of candidates) {
  const { runPicoCliCommand } = await import(pathToFileURL(modulePath));
  const started = Date.now();
  const result = await runPicoCliCommand("/bin/ps", ["eww", "-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "command="], {
    timeoutMs: 250,
    killGraceMs: 25,
    maxOutputBytes: 4 * 1024 * 1024,
    baseEnv: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
  });
  observations.push({ label, elapsedMs: Date.now() - started, code: result.code,
    signal: result.signal, timedOut: result.timedOut, outputTruncated: result.outputTruncated,
    stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
    spawnError: result.spawnError ?? null,
  });
}
const report = { schemaVersion: 1, observedAt: new Date().toISOString(),
  note: "Only process scan completion metadata retained; process commands and environments discarded in memory.",
  observations,
};
fs.writeFileSync(path.join(directory, "LIFECYCLE_SCAN_DIAGNOSIS.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
