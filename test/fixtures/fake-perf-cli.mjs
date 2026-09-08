import fs from "node:fs";

const [configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
fs.appendFileSync(config.logPath, JSON.stringify(args) + "\n");

if (args.join(" ") === "-v") {
  console.log("pico-cli/" + config.cliVersion + " (perf fixture)");
} else if (args.join(" ") === "perf -V") {
  if (config.versionError) {
    console.error(config.versionError);
    process.exit(1);
  }
  console.log(config.profilerVersion ?? config.versionOutput ?? "Usage: perf [options] [command]");
} else if (args.join(" ") === "perf monitor run --help") {
  console.log(config.legacyHelp ?? "Usage: perf monitor run [options]\n  --app <package>\n  -d, --duration <seconds>\n  --device <serial>\n  -o, --output <path>");
} else if (args[0] === "perf" && args[2] === "run") {
  if (config.runMode && args[1] !== config.runMode) {
    console.error("error: unknown command '" + args[1] + "'");
    process.exit(1);
  }
  if (config.runMode === "live" && !args.includes("--save")) {
    console.error("-o, --output <path> requires --save");
    process.exit(1);
  }
  if (config.runError) {
    console.error(config.runError);
    process.exit(1);
  }
  const reportPath = args[args.indexOf("-o") + 1];
  if (config.reportMode !== "missing") {
    fs.writeFileSync(reportPath, config.reportMode === "malformed" ? "{" : JSON.stringify({
      metadata: { app: args[args.indexOf("--app") + 1], durationSeconds: Number(args[args.indexOf("-d") + 1]), totalSamples: 1 },
      diagnosis: { result: "PASS", category: "NO_ISSUE", suggestion: "" },
      summary: { sysFps: { avg: 59.97, min: 59, p5: 60 }, appCpu: { avg: 4.85, max: 24 }, appFps: { avg: 0, p5: 0 } },
      rawData: [{ appFps: null, sysFps: 60, appCpu: "4.85%" }],
      jankWindows: [],
    }));
  }
} else {
  console.error("unexpected fixture command: " + JSON.stringify(args));
  process.exit(2);
}
