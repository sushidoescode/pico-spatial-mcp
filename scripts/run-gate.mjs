/**
 * run-gate — run one gate from the inventory, and refuse to run it against stale build output.
 *
 * `npm run test:<name>` now dispatches here instead of carrying its own `&&`-joined command line.
 * Two things follow. First, the argv lives in one place (`scripts/gate-inventory.mjs`), so a
 * workflow lane, a battery run and a developer shell all execute the identical commands. Second,
 * the repository's most expensive trap gets closed at the point of use: tests import `dist/`, and
 * nothing rebuilds it, so editing `src/` and running a suite used to produce byte-identical output
 * because the suite never saw the change. A gate whose scope depends on emitted output now fails
 * before spawning anything, with the fix in the message.
 *
 * `native-contract` gates are the documented exception: they compile native sources through a shell
 * script and never load `dist/`, so a stale TypeScript build is not their problem and checking it
 * would only produce a confusing failure.
 *
 * Every command is spawned with `shell:false` and inherited stdio, in order, bounded by
 * GATE_TIMEOUT_MS. The first nonzero exit is returned and the rest of the gate does not run.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBuild } from "./build-identity.mjs";
import { GATES } from "./gate-inventory.mjs";
import { npmLaunch } from "./plugin-bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Upper bound for one gate command. The slowest tracked gates (the tarball pack/install and the
 * revision-store concurrency suites) run in minutes, not tens of minutes; 30 minutes is a hang
 * detector, not a budget. A child killed by this limit fails the gate rather than being reported
 * as a pass with no output.
 */
export const GATE_TIMEOUT_MS = 30 * 60 * 1000;

export const STALE_BUILD_MESSAGE = "Build output is stale; run npm run build first.";

/**
 * How a single argv becomes a spawn. `node` and `sh` are executables and are spawned directly;
 * `npm` is not an executable on Windows, so it keeps the one audited launch path this repository
 * already uses for it. No gate currently invokes npm — this exists so that one day adding such a
 * gate cannot quietly become the shape that breaks the Windows lane.
 */
export function gateLaunch(argv, platform = process.platform, env = process.env) {
  if (argv[0] !== "npm") return { command: argv[0], args: argv.slice(1) };
  return npmLaunch(argv.slice(1), platform, env);
}

/**
 * Run one argv array to completion. Resolves with its exit code; a child that cannot start, errors,
 * or is killed (including by the timeout) resolves nonzero rather than rejecting, so the caller
 * always sees a code and the remaining commands in that gate are skipped the same way.
 */
export function runArgv(argv, {
  root = repoRoot,
  env = process.env,
  timeoutMs = GATE_TIMEOUT_MS,
  platform = process.platform,
  spawnChild = spawn,
} = {}) {
  return new Promise((resolve) => {
    const printable = argv.join(" ");
    let settled = false;
    const settle = (code) => { if (!settled) { settled = true; resolve(code); } };

    let launch;
    try {
      launch = gateLaunch(argv, platform, env);
    } catch (error) {
      process.stderr.write(`[run-gate] refused to launch ${printable}: ${error.message}\n`);
      settle(1);
      return;
    }

    let child;
    try {
      child = spawnChild(launch.command, launch.args, {
        cwd: root,
        env,
        shell: false,
        stdio: "inherit",
        timeout: timeoutMs,
      });
    } catch (error) {
      process.stderr.write(`[run-gate] ${printable} could not start: ${error.message}\n`);
      settle(1);
      return;
    }

    child.on("error", (error) => {
      process.stderr.write(`[run-gate] ${printable} failed: ${error.message}\n`);
      settle(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`[run-gate] ${printable} was terminated by ${signal} (limit ${Math.round(timeoutMs / 1000)}s)\n`);
        settle(1);
        return;
      }
      settle(Number.isInteger(code) ? code : 1);
    });
  });
}

/**
 * Run every command of one gate, in order. Returns the first nonzero exit code, or 0.
 * Throws only for an unknown gate name or a stale build — both are the caller's mistake, and both
 * happen before any child exists.
 */
export async function runGate(name, {
  root = repoRoot,
  env = process.env,
  gates = GATES,
  verify = verifyBuild,
  timeoutMs = GATE_TIMEOUT_MS,
  platform = process.platform,
  spawnChild = spawn,
} = {}) {
  const gate = gates[name];
  if (!gate) {
    throw new Error(`unknown gate ${name}; scripts/gate-inventory.mjs owns every gate name`);
  }

  if (gate.scope !== "native-contract") {
    const freshness = verify(root);
    if (!freshness.current) {
      const reasons = (freshness.reasons ?? []).map((reason) => `\n  - ${reason}`).join("");
      throw new Error(`${STALE_BUILD_MESSAGE} ${name} (scope ${gate.scope}) reads emitted output.${reasons}`);
    }
  }

  for (const argv of gate.commands) {
    const exit = await runArgv(argv, { root, env, timeoutMs, platform, spawnChild });
    if (exit !== 0) return exit;
  }
  return 0;
}

export async function runGateCli(args = process.argv.slice(2), root = repoRoot) {
  const [name, ...rest] = args;
  if (!name || rest.length) {
    process.stderr.write("usage: node scripts/run-gate.mjs <gate-name>\n");
    return 2;
  }
  try {
    return await runGate(name, { root, env: process.env });
  } catch (error) {
    process.stderr.write(`[run-gate] ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGateCli();
}
