// THE DOORS test: PICO_MCP_SURFACE=doors exposes ONLY the intent facade — 15 tools (14 doors +
// validate_toolchain); the doors orchestrate the full surface through the internal child server.
// Run: npm run test:doors
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERIFY_APK_TEARDOWN_MS } from "../dist/verifyapk.js";
import { briefIdOf } from "../dist/doors.js";
import { innerFailureDetail } from "../dist/fleetbuild.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

// ── P0 (2026-08-01) unit checks — no server, no emulator ──
// The old brief-id hash accumulated a*31+code unbounded, overflowed to Infinity around ~205 chars,
// and every long brief collided on briefId 'doorNaN' (com.fleet.doorNaN then failed scaffold's
// lowercase package regex). briefIdOf must stay /^door\d+$/ at any length.
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/; // scaffold.ts's applicationId gate
const longBrief = "a grand museum hall of ancient artifacts with six pedestals, spinning relics, a docked start menu, and a scoreboard panel ".repeat(5).trim();
const longId = briefIdOf(longBrief);
if (longBrief.length >= 500 && /^door\d+$/.test(longId)) ok(`briefIdOf stays /^door\\d+$/ on a ${longBrief.length}-char brief (${longId})`);
else fail(`briefIdOf broke on a ${longBrief.length}-char brief: ${longId}`);
if (PACKAGE_RE.test(`com.fleet.${longId}`)) ok("com.fleet.<id> passes scaffold's package regex for the 500+ char brief");
else fail(`com.fleet.${longId} fails the package regex`);
if (briefIdOf(longBrief) === longId && briefIdOf(`${longBrief} with one more clause`) !== longId)
  ok("briefIdOf is deterministic and long briefs no longer all collide");
else fail("briefIdOf determinism/collision check failed");

// fleet_build's scaffold-failure note must surface the zod issue that names the root cause
// (the 150-char cut hid the doorNaN package rejection) and keep raw payloads to 600 chars.
const zodish = 'MCP error -32602: Invalid arguments for tool scaffold_spatial_app: [{"validation":"regex","code":"invalid_string","message":"Invalid","path":["packageName"]}]';
if (innerFailureDetail(zodish) === "packageName: Invalid") ok("innerFailureDetail surfaces the first zod issue as path: message");
else fail(`innerFailureDetail zod parse broken: ${innerFailureDetail(zodish)}`);
const longDetail = innerFailureDetail({ created: false, detail: "x".repeat(900) });
if (longDetail.length === 600 && longDetail.includes('"created":false')) ok("innerFailureDetail keeps 600 chars of an unparseable payload (was 150)");
else fail(`innerFailureDetail slice wrong: len ${longDetail.length}`);

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, PICO_MCP_SURFACE: "doors" } });
const client = new Client({ name: "doors-test", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const DOORS = ["pico_build_app", "pico_scan_world", "pico_place", "pico_look", "pico_verify_app", "pico_measure", "pico_perf", "pico_sdk", "pico_doctor", "pico_ship", "pico_capabilities", "pico_fix", "pico_record", "pico_emulator"];
const expected = [...DOORS, "validate_toolchain"].sort();
if (JSON.stringify(tools) === JSON.stringify(expected)) ok(`doors surface exposes exactly ${expected.length} tools`);
else fail(`surface mismatch — got [${tools.join(", ")}]`);

// a door that orchestrates through the child server (vault lookup — fast, no emulator needed)
const sdk = await client.callTool({ name: "pico_sdk", arguments: { symbol: "RigidBodyComponent" } });
const sdkOut = JSON.parse(sdk.content[0].text);
if (sdkOut.status === "ok" || sdkOut.status === "unavailable") ok(`pico_sdk orchestrates the inner server (status: ${sdkOut.status})`);
else fail(`pico_sdk unexpected: ${JSON.stringify(sdkOut).slice(0, 120)}`);

// error path carries a fix pointer
const fx = await client.callTool({ name: "pico_place", arguments: { semanticScenePath: "/nonexistent.json", label: "counter" } });
const fxOut = JSON.parse(fx.content[0].text);
if (fxOut.status === "error" && fxOut.fix) ok("door errors carry a fix pointer");
else fail(`expected fix-pointing error, got ${JSON.stringify(fxOut).slice(0, 120)}`);

// DOOR 1 two-step contract: a brief-only call hands back the scaffold to author, never a dead end
// (v27-pre first-light finding: the old door misreported the planner's scaffold handoff as plan-failed)
const ba = await client.callTool({ name: "pico_build_app", arguments: { brief: "three spinning crystals over a stone floor with a start menu" } });
const baOut = JSON.parse(ba.content[0].text);
if (baOut.status === "needs-authoring" && baOut.scaffold?.meta && /draftSpec/.test(baOut.fix ?? ""))
  ok("pico_build_app brief-only call returns the scaffold + the draftSpec re-call fix");
else fail(`pico_build_app two-step broken: ${JSON.stringify(baOut).slice(0, 160)}`);

// v27.6: the scaffold is archetype-steered — a crystals brief should hand back a grid+spin display
// scaffold (briefs/crystals.json's shape), not the old one-size-fits-all card shelf.
const hasGridLayout = (baOut.scaffold?.layouts ?? []).some((l) => l.pattern === "grid");
const hasSpinAnim = (baOut.scaffold?.objects ?? []).some((o) => o.anim && o.anim.property === "rotation");
if (hasGridLayout && hasSpinAnim) ok("crystals-brief scaffold has a grid layout + a spin anim (display archetype fired)");
else fail(`crystals-brief scaffold missing grid/anim: ${JSON.stringify(baOut.scaffold).slice(0, 300)}`);

// DOOR 12 takes FREE TEXT — never leaks the diagnose enum's schema error at the caller
const pf = await client.callTool({ name: "pico_fix", arguments: { error: "e: HomeStage.kt:52:65 Unresolved reference 'resetScene'." } });
const pfOut = JSON.parse(pf.content[0].text);
if (pfOut.matchedSymptom === "build_failed" && pfOut.diagnosis && !/invalid_enum_value/i.test(JSON.stringify(pfOut)))
  ok("pico_fix maps free text to a KB symptom (build_failed) without schema leakage");
else fail(`pico_fix free-text handling broken: ${JSON.stringify(pfOut).slice(0, 160)}`);

// pico_doctor carries the preflight checks, each non-pass with a fix pointer
const doc = await client.callTool({ name: "pico_doctor", arguments: {} });
const docOut = JSON.parse(doc.content[0].text);
const checks = docOut?.preflight?.checks;
if (Array.isArray(checks) && checks.length >= 7 && checks.every((c) => c.status === "pass" || (typeof c.fix === "string" && c.fix.length > 10)))
  ok(`pico_doctor surfaces ${checks.length} preflight checks, all fix-pointed`);
else fail(`pico_doctor preflight missing/unfixed: ${JSON.stringify(docOut).slice(0, 200)}`);

// DOOR 14 restart is advisory-only: it returns the documented cold-restart command, never runs it
const emuRestart = await client.callTool({ name: "pico_emulator", arguments: { action: "restart" } });
const emuOut = JSON.parse(emuRestart.content[0].text);
if (emuOut.status === "manual-restart-required" && /restart-emulator\.sh/.test(emuOut.fix ?? "") && /recalibrate/i.test(emuOut.fix ?? ""))
  ok("pico_emulator restart returns the cold-restart command + recalibration reminder (not executed)");
else fail(`pico_emulator restart broken: ${JSON.stringify(emuOut).slice(0, 200)}`);

// DOOR 13 closes the LOOK -> record loop on the doors surface with the ledger's honesty gate intact
const recordApp = "pico-doors-record-fixture";
const rec = await client.callTool({ name: "pico_record", arguments: { app: recordApp, claim: "doors-surface fixture claim", evidenceType: "structural", report: true } });
const recOut = JSON.parse(rec.content[0].text);
if (recOut.status === "recorded" && recOut.report?.capabilityReport)
  ok("pico_record records a structural claim and returns the ledger-generated report");
else fail(`pico_record broken: ${JSON.stringify(recOut).slice(0, 200)}`);
const overclaim = await client.callTool({ name: "pico_record", arguments: { app: recordApp, claim: "it renders", evidenceType: "vision_verified" } });
const overOut = JSON.parse(overclaim.content[0].text);
if (overOut.status === "rejected" && /artifactPath/.test(overOut.reason ?? ""))
  ok("pico_record passes the ledger's vision_verified rejection through untouched");
else fail(`pico_record upgraded an over-claim: ${JSON.stringify(overOut).slice(0, 200)}`);
try { fs.rmSync(path.join(os.homedir(), ".pico-mcp", "ledgers", `${recordApp}.json`), { force: true }); } catch { /* ignore */ }

await client.close();

// v27.8 Unity hello-XR finding: an immersive container tears down asynchronously. Re-launching
// immediately after force-stop is rejected with "current full space don't allow start fullscreen",
// even for the SAME package. Exercise the real verify_pico_apk tool with a fake adb that only
// admits the launch after the tested two-second handoff window.
const verifyTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pico-verifyapk-race-"));
const fakeAdb = path.join(verifyTmp, "adb");
const fakeState = path.join(verifyTmp, "state.json");
const fixturePng = path.resolve("golden/showcase-6cards.golden.png");
const fixturePackage = `com.example.immersive.fixture${process.pid}`;
const rejectPackage = `com.example.immersive.reject${process.pid}`;
const blockedPackage = `com.example.immersive.blocked${process.pid}`;
fs.writeFileSync(fakeAdb, `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.VERIFYAPK_FAKE_STATE;
const args = process.argv.slice(2).join(" ");
const read = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } };
const write = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
if (args.includes(" install -r ")) process.stdout.write("Success\\n");
else if (args.includes(" am force-stop ")) {
  if (args.includes("com.example.incumbent")) write({ ...read(), incumbentStopped: true });
  else write({ ...read(), forcedAt: Date.now(), alive: false });
}
else if (args.includes(" logcat -c")) process.exit(0);
else if (args.includes(" dumpsys activity activities")) process.stdout.write("    topResumedActivity=ActivityRecord{1a2b3c u0 com.example.incumbent/.MainActivity t42}\\n");
else if (args.includes(" am start ")) {
  const state = read();
  if (args.includes(".blocked")) {
    // am start reports success while the incumbent full-space app blocks the real start; only
    // logcat shows the block. The app comes alive only after the incumbent is force-stopped.
    write({ ...state, alive: !!state.incumbentStopped, blockedLaunches: (state.blockedLaunches || 0) + 1 });
    process.stdout.write("Starting: Intent\\n");
  } else {
    const internalForceStop = args.includes(" am start -S ");
    const launchAfterMs = internalForceStop ? 0 : Date.now() - (state.forcedAt ?? Date.now());
    const forcedRejection = args.includes(".reject");
    const alive = !internalForceStop && !forcedRejection && launchAfterMs >= 1900;
    write({ ...state, launchAfterMs, alive, internalForceStop, forcedRejection });
    process.stdout.write(alive ? "Starting: Intent\\n" : "Warning: current full space don't allow start fullscreen\\n");
  }
}
else if (args.includes(" pidof ")) {
  if (read().alive) process.stdout.write("4242\\n"); else process.exit(1);
}
else if (args.includes(" logcat -d")) {
  const state = read();
  if (state.blockedLaunches && !state.incumbentStopped) process.stdout.write("E ContainerManager: current full space don't allow start fullscreen\\n");
  else process.stdout.write("UNITY_HELLO_XR status=ready\\n");
}
else if (args.includes(" exec-out screencap -p")) process.stdout.write(fs.readFileSync(process.env.VERIFYAPK_FAKE_PNG));
`);
fs.chmodSync(fakeAdb, 0o755);

const verifyTransport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    PICO_MCP_SURFACE: "full",
    PICO_ADB: fakeAdb,
    VERIFYAPK_FAKE_STATE: fakeState,
    VERIFYAPK_FAKE_PNG: fixturePng,
  },
});
const verifyClient = new Client({ name: "verifyapk-race-test", version: "0.0.0" });
await verifyClient.connect(verifyTransport);
const verify = await verifyClient.callTool({
  name: "verify_pico_apk",
  arguments: {
    apkPath: path.join(verifyTmp, "fixture.apk"),
    packageName: fixturePackage,
    activity: "com.example.MainActivity",
    expectLogcatContains: "UNITY_HELLO_XR status=",
    settleSec: 0,
  },
});
const verifyOut = JSON.parse(verify.content[0].text);
const launchAfterMs = JSON.parse(fs.readFileSync(fakeState, "utf8")).launchAfterMs;
if (VERIFY_APK_TEARDOWN_MS === 2000 && verifyOut.status === "ok" && verifyOut.processAlive === true && launchAfterMs >= 1900)
  ok(`verify_pico_apk waits for immersive teardown before relaunch (${launchAfterMs}ms)`);
else fail(`verify_pico_apk raced immersive teardown: ${JSON.stringify({ verifyOut, launchAfterMs }).slice(0, 300)}`);

const rejected = await verifyClient.callTool({
  name: "verify_pico_apk",
  arguments: {
    apkPath: path.join(verifyTmp, "fixture.apk"),
    packageName: rejectPackage,
    activity: "com.example.MainActivity",
    settleSec: 0,
  },
});
const rejectedOut = JSON.parse(rejected.content[0].text);
if (rejectedOut.status === "attention" && rejectedOut.launched === false
    && rejectedOut.errors.some((error) => error.includes("current full space don't allow start fullscreen")))
  ok("verify_pico_apk reports the full-space rejection as a structured launch error");
else fail(`verify_pico_apk hid the full-space rejection: ${JSON.stringify(rejectedOut).slice(0, 300)}`);

// v31 incumbent recovery: the launch "succeeds" while the incumbent full-space app blocks the real
// start (only logcat shows it). verify_pico_apk must force-stop the incumbent, wait out the
// container teardown, relaunch ONCE, and record the recovery — mirroring fleet_build's
// launch_blocked path.
const blocked = await verifyClient.callTool({
  name: "verify_pico_apk",
  arguments: {
    apkPath: path.join(verifyTmp, "fixture.apk"),
    packageName: blockedPackage,
    activity: "com.example.MainActivity",
    settleSec: 0,
  },
});
const blockedOut = JSON.parse(blocked.content[0].text);
const blockedState = JSON.parse(fs.readFileSync(fakeState, "utf8"));
if (blockedOut.status === "ok" && blockedOut.processAlive === true && blockedState.incumbentStopped === true
    && (blockedOut.recoveryNotes ?? []).some((n) => n.includes("com.example.incumbent") && n.includes("relaunched once")))
  ok("verify_pico_apk force-stops the full-space incumbent and relaunches once (recovery recorded)");
else fail(`verify_pico_apk incumbent recovery broken: ${JSON.stringify({ blockedOut, blockedState }).slice(0, 400)}`);

await verifyClient.close();
for (const packageName of [fixturePackage, rejectPackage, blockedPackage]) {
  const artifact = path.join("/tmp/pico-render/verifyapk", `${packageName}.png`);
  try { fs.unlinkSync(artifact); } catch {}
}
fs.rmSync(verifyTmp, { recursive: true, force: true });

console.log(`\nDoors test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
