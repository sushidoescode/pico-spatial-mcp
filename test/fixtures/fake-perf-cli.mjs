import fs from "node:fs";

const [configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
fs.appendFileSync(config.logPath, JSON.stringify(args) + "\n");

// Parser facts retained in docs/evidence/perfcli-0.1.0-help-2026-09-08.txt:
// bare -V output; removed monitor rejects without --help but --help returns root help;
// --app is required before output validation. The captured help excerpts are truncated;
// the complete command groups and --save/--report-mode rule reflect the supplied 0.1.0 surface.
// Report data below is synthetic: it does not establish live sampling behavior.
const ROOT_HELP = `Usage: perf [global-options] <command> [command-options]

PICO Spatial Profiler CLI

Options:
  -V, --version   output the version number
  -v, --verbose   Verbose output
  --debug         Debug mode
  --envelope      Output a machine-readable JSON envelope
  --daemon        Run as daemon (internal use)
  --port <port>   Daemon listen port (internal use) (default: "9500")
  -h, --help      display help for command

Commands:
  daemon          Manage the daemon process
  session         Manage sessions
  doctor
  live
  trace
  help [command]  display help for command`;
const LEGACY_HELP = "Usage: perf monitor run [options]\n  --app <package>\n  -d, --duration <seconds>\n  --device <serial>\n  -o, --output <path>";
const LIVE_HELP = `Usage: perf live run [options]

Run foreground live performance collection (Ctrl+C to stop)

Options:
  --app <package_name>      Target app package name
  --adb <path>              Path to adb executable
  --device <device_id>      Device ID to connect
  -o, --output <path>       Explicit report file path (requires --save or --report-mode)
  -d, --duration <seconds>  Run for a fixed duration, then stop automatically
  --debug-app-fps          Print APP FPS parser/aggregator diagnostics
  --report-mode            Implies --save
  --save                   Save a report
  -h, --help               display help for command`;
const embedded = config.cliVersion === "0.3.0" && config.profilerVersion === undefined && config.versionOutput === undefined;
const runMode = config.runMode ?? (embedded ? "monitor" : "live");

if (args.join(" ") === "-v") {
  console.log("pico-cli/" + config.cliVersion + " (perf fixture)");
} else if (args.join(" ") === "perf -V") {
  if (config.versionError) {
    console.error(config.versionError);
    process.exit(1);
  }
  console.log(config.profilerVersion ?? config.versionOutput ?? "0.1.0");
} else if (args.join(" ") === "perf --help") {
  console.log(ROOT_HELP);
} else if (args.join(" ") === "perf monitor run --help") {
  console.log(config.legacyHelp ?? (embedded ? LEGACY_HELP : ROOT_HELP));
} else if (args.join(" ") === "perf live run --help") {
  console.log(LIVE_HELP);
} else if (args[0] === "perf" && args[2] === "run") {
  if (args[1] !== runMode) {
    console.error("error: unknown command '" + args[1] + "'");
    if (args[1] === "monitor") console.error("(Did you mean doctor?)");
    process.exit(1);
  }
  if (!args.includes("--app")) {
    console.error("error: required option '--app <package_name>' not specified");
    process.exit(1);
  }
  const outputFlag = args.includes("-o") ? "-o" : "--output";
  if (runMode === "live" && args.includes(outputFlag) && !args.includes("--save") && !args.includes("--report-mode")) {
    console.error("`-o, --output <path>` requires `--save` (or `--report-mode`, which implies save).");
    process.exit(1);
  }
  if (config.runError) {
    console.error(config.runError);
    process.exit(1);
  }
  const reportPath = args.includes(outputFlag) ? args[args.indexOf(outputFlag) + 1] : null;
  if (reportPath && config.reportMode !== "missing") {
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
