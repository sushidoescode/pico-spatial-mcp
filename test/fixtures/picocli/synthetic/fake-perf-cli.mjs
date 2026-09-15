// Synthetic fake pico-cli perf surface. NOT retained CLI output — see README.md in this directory
// for the exact archive members every decision and message below was transcribed from.
//
// It is used as the injected run seam of collectPerfLive / runPerfTrace, so no process is spawned
// and no real pico-cli, profiler or device is involved. It reproduces only what those wrappers
// depend on:
//   * the 0.5.0 router allow-list and its rejection text  (CLI 0.5.0 package/dist/index.js:36-37,
//     excerpts PERF_ROUTER050 / PERF_ENV050) — `perf monitor run` is refused, never silently run;
//   * LiveRunAction's own validation (profiler 0.2.0 package/dist/index.js:2, excerpt LIVE050):
//     --package required, --app a deprecated alias, and an explicit --output requires --save
//     (or --report-mode). A report file is therefore written ONLY when save/output were passed.
//   * the utilities gate and the PICO_HOME gate texts (PERF_ENV050) for the refusal classes.
import fs from "node:fs";
import path from "node:path";

/** The allow-list the 0.5.0 router validates against before any delegation (PERF_ROUTER050). */
export const PERF_ROUTER_ALLOW_LIST = {
  daemon: ["start", "stop", "status", "list"],
  session: ["list", "close"],
  doctor: ["check", "install"],
  live: ["run", "start", "stop"],
  trace: ["record", "stop", "decode", "load", "query", "analysis"],
};

/** The router skips flags when it reads the resource/action pair; only --port consumes a value. */
function resourceAction(args) {
  const tokens = [];
  for (let i = 0; i < args.length && tokens.length < 2; i += 1) {
    const token = args[i];
    if (token === undefined || token === "--") break;
    if (token.startsWith("-")) {
      if (token === "--port") i += 1;
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const result = (code, { stdout = "", stderr = "" } = {}) => ({
  code, signal: null, stdout, stderr, timedOut: false, outputTruncated: false,
});

/**
 * @param {object} options
 * @param {string} [options.reportFixture] absolute path of the synthetic report this fake writes
 *   when (and only when) the supported save/output arguments were passed.
 * @param {"success"|"setup-required"|"environment"|"stale-output"} [options.mode]
 * @param {(args: string[]) => object|null} [options.traceReply] scripted reply for perf trace argv.
 */
export function createFakePerfCli({ reportFixture = null, mode = "success", traceReply = null } = {}) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args: [...args], opts: { ...opts } });
    if (args[0] !== "perf") return result(2, { stderr: `fake perf cli only serves \`perf\`, got ${JSON.stringify(args[0])}` });
    const forwarded = args.slice(1);
    const [resource, action] = resourceAction(forwarded);

    // The router validates BEFORE resolving PICO_HOME or the profiler entry (PERF_ENV050 calls
    // lC(e) first), so an unknown subcommand is refused even on an unprovisioned host.
    if (resource !== undefined && !Object.hasOwn(PERF_ROUTER_ALLOW_LIST, resource)) {
      return result(3, {
        stderr: `Unknown perf subcommand: ${resource}. Expected one of: ${Object.keys(PERF_ROUTER_ALLOW_LIST).join(", ")}. `
          + "Run `pico-cli perf --help` to see available commands.\n",
      });
    }
    const actions = PERF_ROUTER_ALLOW_LIST[resource] ?? [];
    if (action !== undefined && !actions.includes(action)) {
      return result(3, {
        stderr: `Unknown perf ${resource} action: ${action}. Expected one of: ${actions.join(", ")}. `
          + `Run \`pico-cli perf ${resource} --help\` to see available actions.\n`,
      });
    }
    if (mode === "setup-required") {
      return result(3, { stderr: "Error: Perf utilities 0.2.0 are not installed. Run `pico-cli setup` to install.\n" });
    }
    if (mode === "environment") {
      return result(3, { stderr: "Error: [warn] PICO_HOME is not set. Set PICO_HOME or run pico-cli setup to install primer before running perf.\n" });
    }

    if (resource === "trace") {
      return traceReply ? traceReply([...args]) : result(0, { stdout: "" });
    }

    if (resource === "live" && action === "run") {
      const pkg = optionValue(forwarded, "--package") ?? optionValue(forwarded, "--app");
      if (!pkg) return result(1, { stderr: "Error: Missing required option: --package <package_name>\n" });
      const output = optionValue(forwarded, "--output") ?? optionValue(forwarded, "-o");
      const save = forwarded.includes("--save");
      const reportMode = forwarded.includes("--report-mode");
      if (output && !save && !reportMode) {
        return result(1, { stderr: "Error: `-o, --output <path>` requires `--save` (or `--report-mode`, which implies save).\n" });
      }
      const envelope = forwarded.includes("--envelope");
      const duration = optionValue(forwarded, "--duration") ?? optionValue(forwarded, "-t");
      if (envelope && duration === undefined) {
        return result(1, { stderr: "Error: `perf live run --envelope` requires --duration. Interactive live output cannot be wrapped in an envelope.\n" });
      }
      // resolveLiveReportOutputPath: a path is written only when save/report-mode asked for one.
      let written = null;
      if ((save || reportMode) && reportFixture) {
        written = output ?? path.join("reports", "live-report-fixture.json");
        fs.mkdirSync(path.dirname(written), { recursive: true });
        fs.writeFileSync(written, fs.readFileSync(reportFixture));
      }
      return result(0, {
        stdout: `Collecting performance data for ${pkg} over ${duration ?? "?"} seconds...\n`
          + "Collection finished. Processing data...\n"
          + (written ? `Report successfully saved to: ${written}\n` : ""),
      });
    }
    return result(0, { stdout: "" });
  };
  return { calls, run };
}
