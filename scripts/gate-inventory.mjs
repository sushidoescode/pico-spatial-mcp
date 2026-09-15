/**
 * gate-inventory — the one place that knows which gates exist, what each one actually runs, and
 * which CI runner owns it.
 *
 * Three sources used to have to agree by hand: the `&&`-joined command tail inside a package.json
 * script string, the `npm run` step in `.github/workflows/gates.yml`, and the counts published in
 * README.md and docs/COLLABORATORS.md. They drifted — `test:runrevision` was a real script that no
 * workflow lane ever ran, four revision suites regressing invisibly behind it, while the meta-gate
 * that should have caught that was itself red over stale numbers nobody re-derived.
 *
 * So the argv lives here, package.json only dispatches (`node scripts/run-gate.mjs <name>`), and
 * every published count is derived from `GATES`. Adding a gate is one edit: a new entry below, the
 * matching one-line script, and the workflow step for its host lane. `validateGateInventory` fails
 * if any of those three is missing, duplicated, unknown, or assigned to the wrong runner OS.
 *
 * Fields:
 *   host     — the CI lane that owns the gate. Exactly one; a gate is never run twice.
 *   scope    — what the gate loads, which decides whether it needs a fresh build:
 *                fixture            deterministic host-only suites; almost all import `dist/`
 *                installed-artifact packs and installs the tarball, so it needs current output too
 *                native-contract    a shell script compiling native sources; never loads `dist/`
 *   commands — the original argv, in order. One array per `&&` segment of the old script string;
 *              `run-gate` spawns each with `shell:false`, so no token is ever re-interpreted.
 */

export const GATE_HOSTS = Object.freeze(["linux", "windows", "macos"]);
export const GATE_SCOPES = Object.freeze(["fixture", "native-contract", "installed-artifact"]);

/** Every gate, in the order the battery runs them. @type {Readonly<Record<string, {host: "linux"|"windows"|"macos", commands: string[][], scope: "fixture"|"native-contract"|"installed-artifact"}>>} */
export const GATES = Object.freeze({
  smoke: { host: "linux", scope: "fixture", commands: [["node", "test/smoke.mjs"]] },
  "test:tarball": { host: "linux", scope: "installed-artifact", commands: [["node", "scripts/verify-tarball.mjs"]] },
  "test:smoke-isolation": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/smoke-isolation.mjs"]] },
  "test:sdk-integration": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/sdk-integration.mjs"]] },
  "test:lint": { host: "linux", scope: "fixture", commands: [["node", "test/lint.mjs"], ["node", "--test", "test/run-battery.mjs", "test/gate-inventory.mjs"]] },
  "test:projectgen": { host: "linux", scope: "fixture", commands: [["node", "test/projectgen.mjs"]] },
  "test:unitygen": { host: "linux", scope: "fixture", commands: [["node", "test/unitygen.mjs"]] },
  "test:surfaceplace": { host: "linux", scope: "fixture", commands: [["node", "test/surfaceplace.mjs"]] },
  "test:vault": { host: "linux", scope: "fixture", commands: [["node", "test/vault.mjs"]] },
  "test:semantic": { host: "linux", scope: "fixture", commands: [["node", "test/semanticplace.mjs"]] },
  "test:ledger": { host: "linux", scope: "fixture", commands: [["node", "test/ledger.mjs"]] },
  "test:eye": { host: "linux", scope: "fixture", commands: [["node", "test/eye.mjs"], ["node", "test/usdrender.mjs"]] },
  "test:assetgate": { host: "linux", scope: "fixture", commands: [["node", "test/assetgate.mjs"]] },
  "test:worldenv": { host: "linux", scope: "fixture", commands: [["node", "test/worldenv.mjs"]] },
  "test:referring": { host: "linux", scope: "fixture", commands: [["node", "test/referring.mjs"]] },
  "test:doors": { host: "linux", scope: "fixture", commands: [["node", "test/doors.mjs"]] },
  "test:prompts": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/prompts.mjs"]] },
  "test:archetype": { host: "linux", scope: "fixture", commands: [["node", "test/archetype.mjs"]] },
  "test:claims": { host: "linux", scope: "fixture", commands: [["node", "test/claimspage.mjs"]] },
  "test:bench": { host: "linux", scope: "fixture", commands: [["node", "test/spatialbench.mjs"]] },
  "test:affordance": { host: "linux", scope: "fixture", commands: [["node", "test/affordance.mjs"]] },
  "test:occupancy": { host: "linux", scope: "fixture", commands: [["node", "test/occupancy.mjs"]] },
  "test:copilot": { host: "linux", scope: "fixture", commands: [["node", "test/copilot.mjs"]] },
  "test:vaultdiff": { host: "linux", scope: "fixture", commands: [["node", "test/vaultdiff.mjs"]] },
  "test:preflight": { host: "linux", scope: "fixture", commands: [["node", "test/preflight.mjs"]] },
  "test:provision": { host: "linux", scope: "fixture", commands: [["node", "test/provision.mjs"]] },
  "test:bridge": { host: "linux", scope: "fixture", commands: [["node", "test/mousebridge.mjs"], ["node", "--test", "test/sceneanchors.mjs", "test/homeenvironmentcatalog.mjs", "test/homeenvironmenthost.mjs", "test/homeenvironmentselector.mjs"]] },
  "test:vcam": { host: "linux", scope: "fixture", commands: [["node", "test/vcam.mjs"]] },
  "test:vcamtransport": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/vcamtransport.mjs"]] },
  "test:vcamboundary": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/vcamboundary.mjs"]] },
  "test:vcamreader": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/vcamreader.mjs"]] },
  "test:vcamthroughput": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/vcamthroughput.mjs"]] },
  "test:vcammaterialize": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/vcammaterialize.mjs"]] },
  "test:vcamtransport-native": { host: "macos", scope: "native-contract", commands: [["sh", "scripts/test-cmio-camera-writer.sh"]] },
  "test:vcamreader-native": { host: "macos", scope: "native-contract", commands: [["sh", "scripts/test-cmio-camera-reader.sh"]] },
  "test:briefroute": { host: "linux", scope: "fixture", commands: [["node", "test/briefroute.mjs"]] },
  "test:emulator-restart": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/emulator.mjs", "test/restart-emulator.mjs", "test/observation.mjs", "test/navigation.mjs", "test/runtimecontinuity.mjs", "test/navigationtarget.mjs", "test/worldlocomotion.mjs"]] },
  "test:modelmeasure": { host: "linux", scope: "fixture", commands: [["node", "test/modelmeasure.mjs"]] },
  "test:docsmeta": { host: "linux", scope: "fixture", commands: [["node", "test/docsmeta.mjs"]] },
  "test:picocli": { host: "linux", scope: "fixture", commands: [["node", "test/picocli.mjs"], ["node", "--test", "test/picocli-autoinstall.mjs", "test/picocli-sweep.mjs"]] },
  "test:runreceipt": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/runreceipt-identity.mjs", "test/runreceipt-store.mjs", "test/nativefleetreceipt.mjs", "test/fleetreceipt.mjs", "test/runreceipt-ledger.mjs", "test/runreceipt-ship.mjs", "test/runreceipt-portability.mjs"]] },
  "test:runrevision": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/runrevision-contracts.mjs", "test/runrevision-store.mjs", "test/runrevision-locator.mjs", "test/runrevision-locks.mjs"]] },
  "test:swan": { host: "linux", scope: "fixture", commands: [["node", "test/swan.mjs"]] },
  "test:placeonsurface": { host: "linux", scope: "fixture", commands: [["node", "test/placeonsurface.mjs"]] },
  "test:menuactions": { host: "linux", scope: "fixture", commands: [["node", "test/menuactions.mjs"]] },
  "test:adoption-safety": { host: "linux", scope: "fixture", commands: [["node", "test/adoption-safety.mjs"]] },
  "test:spatialui-adoption": { host: "linux", scope: "fixture", commands: [["node", "test/spatialui-adoption.mjs"]] },
  "test:distribution-adoption": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/distribution-adoption.mjs"]] },
  "test:knowledge-lifecycle": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/knowledge-lifecycle.mjs"]] },
  "test:conformance": { host: "linux", scope: "fixture", commands: [["node", "test/conformance.mjs"], ["node", "--test", "test/boundaryprobe.mjs", "test/boundaryexperiment.mjs"]] },
  "test:buildfreshness": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/buildfreshness.mjs"]] },
  "test:plugin-bootstrap-freshness": { host: "linux", scope: "fixture", commands: [["node", "--test", "test/plugin-bootstrap-freshness.mjs"]] },
  "test:picocli-win": { host: "windows", scope: "fixture", commands: [["node", "--test", "test/picocli-autoinstall.mjs", "test/buildrun-smoke-fixture.mjs", "test/run-battery.mjs"]] },
});

/** A package script is a gate iff it is named like one; `build`, `prepack`, `sync:meta` are not. */
export function isGateScriptName(name) {
  return name === "smoke" || String(name).startsWith("test:");
}

/** The only body a gate script may have: dispatch to the inventory, never repeat the argv. */
export function gateScriptCommand(name) {
  return `node scripts/run-gate.mjs ${name}`;
}

/** `ubuntu-latest` -> `linux`. An unrecognized runner label returns null rather than a guess. */
export function hostFamilyForRunner(runsOn) {
  const label = String(runsOn ?? "").toLowerCase();
  if (label.includes("ubuntu") || label.includes("linux")) return "linux";
  if (label.includes("windows")) return "windows";
  if (label.includes("macos") || label.includes("mac-")) return "macos";
  return null;
}

/** This process's host family, in the same vocabulary the inventory assigns gates to. */
export function hostFamilyForPlatform(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

export function gatesForHost(host, gates = GATES) {
  return Object.entries(gates).filter(([, gate]) => gate.host === host).map(([name]) => name);
}

export function gateHostCounts(gates = GATES) {
  const counts = { linux: 0, windows: 0, macos: 0 };
  for (const gate of Object.values(gates)) {
    if (gate.host in counts) counts[gate.host] += 1;
  }
  return counts;
}

/**
 * The published battery size, derived. `smoke` is the one invocation that is not a `test:` suite,
 * so invocations is always suites + 1 as long as that stays true — which the shape checks assert
 * rather than assume.
 */
export function gateInventoryCounts(gates = GATES) {
  const names = Object.keys(gates);
  return {
    invocations: names.length,
    suites: names.filter((name) => name.startsWith("test:")).length,
    hosts: gateHostCounts(gates),
  };
}

/**
 * Every job in a GitHub Actions workflow, with the gate invocations it runs.
 *
 * Deliberately a text parse, not a YAML dependency: jobs are the 2-space keys under `jobs:`, and a
 * gate invocation is `npm run <gate-shaped name>` on a non-comment line. `npm ci` and
 * `npm run build` are not gates, so they are simply not gate-shaped and never appear here, and a
 * commented-out step is not an invocation either.
 */
export function parseWorkflowLanes(workflow) {
  const jobsBlock = /^jobs:[ \t]*\n([\s\S]*)$/m.exec(String(workflow ?? ""))?.[1] ?? "";
  const headers = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
  return headers.map((header, index) => {
    const body = jobsBlock.slice(header.index + header[0].length, headers[index + 1]?.index ?? jobsBlock.length);
    const runsOn = /^[ \t]*runs-on:[ \t]*(\S+)[ \t]*$/m.exec(body)?.[1] ?? null;
    const gates = body.split("\n")
      .filter((line) => !/^[ \t]*#/.test(line))
      .flatMap((line) => [...line.matchAll(/npm run ([A-Za-z0-9:._-]+)/g)].map((match) => match[1]))
      .filter(isGateScriptName);
    return { job: header[1], runsOn, host: hostFamilyForRunner(runsOn), gates };
  });
}

/**
 * Does package.json + gates.yml still describe exactly this inventory? Returns one human-readable
 * finding per disagreement and never throws, so a caller can print all of them at once.
 */
export function validateGateInventory(packageJson, workflow, gates = GATES) {
  const findings = [];
  const scripts = packageJson?.scripts ?? {};
  const scriptNames = Object.keys(scripts).filter(isGateScriptName);
  const gateNames = Object.keys(gates);

  for (const name of scriptNames) {
    if (!gateNames.includes(name)) {
      findings.push(`package.json declares the gate script ${name}, which the inventory does not assign to a host lane`);
    }
  }
  for (const name of gateNames) {
    if (!scriptNames.includes(name)) {
      findings.push(`the inventory declares ${name}, which package.json does not expose as a script`);
    }
  }

  const lanes = parseWorkflowLanes(workflow);
  for (const lane of lanes) {
    if (lane.host === null) {
      findings.push(`workflow job ${lane.job} runs on ${lane.runsOn ?? "an unstated runner"}, which is not a host family the inventory assigns gates to`);
    }
  }

  const invocations = new Map();
  for (const lane of lanes) {
    for (const name of lane.gates) {
      if (!invocations.has(name)) invocations.set(name, []);
      invocations.get(name).push(lane);
    }
  }

  for (const [name, where] of invocations) {
    if (gateNames.includes(name)) continue;
    findings.push(`workflow job ${where[0].job} invokes ${name}, which is unknown to the inventory`);
  }

  for (const name of gateNames) {
    const where = invocations.get(name) ?? [];
    if (where.length === 0) {
      findings.push(`${name} is assigned to ${gates[name].host} but no workflow lane ever invokes it`);
      continue;
    }
    if (where.length > 1) {
      findings.push(`${name} is invoked more than once: ${where.map((lane) => lane.job).join(", ")}`);
    }
    for (const lane of where) {
      if (lane.host !== null && lane.host !== gates[name].host) {
        findings.push(`${name} is assigned to ${gates[name].host} but workflow job ${lane.job} runs it on ${lane.host}`);
      }
    }
  }

  return findings;
}
