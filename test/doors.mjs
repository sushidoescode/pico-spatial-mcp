// THE DOORS test: PICO_MCP_SURFACE=doors exposes ONLY the intent facade — 18 tools (16 doors +
// validate_toolchain + ensure_pico_cli); the doors orchestrate the full surface through the
// internal child server.
// Run: npm run test:doors
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERIFY_APK_TEARDOWN_MS } from "../dist/verifyapk.js";
import * as doorsModule from "../dist/doors.js";
import * as plannerModule from "../dist/planner.js";
import { innerFailureDetail } from "../dist/fleetbuild.js";
import { createManagedRuntimeHarness } from "./helpers/picocli-managed-fixture.mjs";

const {
  briefIdOf,
  loopFailureSignature,
  loopCriteriaInEvidenceSafeOrder,
  loopSpecMutated,
  loopRepairSelection,
  loopUnmeasurableFix,
  loopVisualOutcome,
  loopNeedsLookHonesty,
  loopAcceptanceEvidence,
  isPositiveLookedEntry,
  buildAppDoorStatus,
} = doorsModule;
const { replanMutationStatus } = plannerModule;

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

if (isPositiveLookedEntry({ evidenceType: "vision_verified" })
    && isPositiveLookedEntry({ evidenceType: "device_verified", deviceOutcome: "pass", deviceFeature: "controller_ray", deviceLineage: { status: "validated" } })
    && !isPositiveLookedEntry({ evidenceType: "device_verified", deviceOutcome: "fail", deviceFeature: "controller_ray", deviceLineage: { status: "validated" } })
    && !isPositiveLookedEntry({ evidenceType: "device_verified", deviceOutcome: "pass", deviceFeature: "controller_ray" }))
  ok("pico_next treats device PASS as positive proof and preserves device FAIL as negative evidence");
else fail("pico_next blurs a device-verified failure into positive visual proof");

// The governing rule reserves "verified" for a frame somebody LOOKED at. Door 1's calibrated eye
// is useful auto_judged evidence, but its PASS cannot mint a human-seen status string.
if (typeof buildAppDoorStatus !== "function") {
  fail("pico_build_app has no evidence-scoped status helper");
} else {
  const receipt = { status: "recorded", receiptId: "a".repeat(64), receiptPath: "/tmp/receipt.json", capturePath: "/tmp/frame.png" };
  const recordedPass = buildAppDoorStatus({ built: true, installed: true, artifact: "/tmp/frame.png", receipt, verdict: "PASS", visualLedger: { status: "recorded" } });
  const unrecordedPass = buildAppDoorStatus({ built: true, installed: true, artifact: "/tmp/frame.png", receipt, verdict: "PASS", visualLedger: { status: "rejected" } });
  const noCapture = buildAppDoorStatus({ built: true, installed: true, verdict: "ESCALATE" });
  const notInstalled = buildAppDoorStatus({ built: true, installed: false });
  const unboundCapture = buildAppDoorStatus({ built: true, installed: true, artifact: "/tmp/mutable.png", verdict: "PASS", visualLedger: { status: "recorded" } });
  if (recordedPass === "auto-judged-needs-look"
      && unrecordedPass === "built-needs-look"
      && noCapture === "built-no-capture"
      && notInstalled === "built-not-installed"
      && unboundCapture === "built-no-capture"
      && ![recordedPass, unrecordedPass, noCapture, notInstalled].includes("verified"))
    ok("pico_build_app requires a receipt-bound capture and never labels an unlooked calibrated-eye result verified");
  else fail(`pico_build_app status overclaims sight: ${JSON.stringify({ recordedPass, unrecordedPass, noCapture, notInstalled, unboundCapture })}`);
}

// Receipt identity is part of the delivered MCP-door contract, not merely a fleet implementation
// detail. Exercise the real registered Door 1 and pico_loop handlers with an injected inner-tool
// execution lane so this test cannot start Gradle, adb, an emulator, or a device.
if (doorsModule.registerDoorTools.length < 2) {
  fail("pico_build_app/pico_loop registration has no injected inner-call seam for receipt tests");
} else {
  const receiptHome = fs.mkdtempSync(path.join(os.tmpdir(), "pico-door-receipt-"));
  const previousHome = process.env.HOME;
  process.env.HOME = receiptHome;
  const receiptCapture = path.join(receiptHome, "ledger", "artifacts", `${"a".repeat(64)}.png`);
  const receiptId = "b".repeat(64);
  const receiptPath = path.join(receiptHome, "run-receipts", `${receiptId}.json`);
  const fleetResult = {
    id: "fixture",
    built: true,
    installed: true,
    concluded: true,
    verdict: "ESCALATE",
    artifact: receiptCapture,
    receipt: {
      status: "recorded",
      receiptId,
      receiptPath,
      capturePath: receiptCapture,
      sourceCapturePath: path.join(receiptHome, "captures", "unique.png"),
      captureSha256: "a".repeat(64),
      evidenceType: "structural",
      lookRequired: true,
    },
    visualChecks: [],
    visualJudgeNote: "fixture escalation",
    visualLedger: null,
    notes: [],
  };
  let injectedFleetResult = fleetResult;
  let injectedRecordArgs = null;
  const injectedCall = async (name, args) => {
    if (name === "plan_app_spec") return { status: "ok", spec: { meta: { packageName: "com.example.fixture" } } };
    if (name === "fleet_build") return { status: "ok", results: [injectedFleetResult] };
    if (name === "record_verification") { injectedRecordArgs = args; return { status: "recorded", entry: { evidenceType: args.evidenceType } }; }
    throw new Error(`unexpected injected door call: ${name}`);
  };
  const receiptServer = new McpServer({ name: "door-receipt-test", version: "0.0.0" });
  doorsModule.registerDoorTools(receiptServer, { call: injectedCall });
  const [receiptClientTransport, receiptServerTransport] = InMemoryTransport.createLinkedPair();
  const receiptClient = new Client({ name: "door-receipt-test", version: "0.0.0" });
  await receiptServer.connect(receiptServerTransport);
  await receiptClient.connect(receiptClientTransport);
  try {
    const built = await receiptClient.callTool({
      name: "pico_build_app",
      arguments: { brief: "receipt fixture", draftSpec: { meta: { packageName: "com.example.fixture" } } },
    });
    const builtOut = JSON.parse(built.content[0].text);
    if (builtOut.receiptId === receiptId && builtOut.receiptPath === receiptPath && builtOut.capture === receiptCapture)
      ok("pico_build_app returns the fleet receipt identity and exact receipt-bound capture");
    else fail(`pico_build_app dropped or rewrote fleet receipt identity: ${JSON.stringify(builtOut).slice(0, 360)}`);

    const record = await receiptClient.callTool({
      name: "pico_record",
      arguments: {
        app: "com.example.fixture",
        claim: "synthetic Door receipt-forwarding fixture",
        evidenceType: "vision_verified",
        artifactPath: receiptCapture,
        attestation: "Synthetic forwarding text only; no rendered LOOK is claimed.",
        runReceiptId: receiptId,
      },
    });
    const recordOut = JSON.parse(record.content[0].text);
    if (recordOut.status === "recorded" && injectedRecordArgs?.runReceiptId === receiptId
        && injectedRecordArgs?.artifactPath === receiptCapture && injectedRecordArgs?.evidenceType === "vision_verified")
      ok("pico_record forwards the build receipt ID with the exact looked-capture record request");
    else fail(`pico_record dropped receipt binding fields: ${JSON.stringify({ recordOut, injectedRecordArgs }).slice(0, 420)}`);

    const looped = await receiptClient.callTool({
      name: "pico_loop",
      arguments: { goal: "receipt loop fixture", draftSpec: { meta: { packageName: "com.example.fixture" } }, acceptance: [{ kind: "visual" }], budget: { iterations: 1 } },
    });
    const loopedOut = JSON.parse(looped.content[0].text);
    if (loopedOut.status === "built-needs-look" && loopedOut.receiptId === receiptId
        && loopedOut.receiptPath === receiptPath && loopedOut.capture === receiptCapture
        && loopedOut.remainingLookObligation?.[0]?.artifact === receiptCapture)
      ok("pico_loop carries the last fleet receipt identity and exact capture through its exit");
    else fail(`pico_loop dropped or rewrote fleet receipt identity: ${JSON.stringify(loopedOut).slice(0, 420)}`);

    injectedFleetResult = { ...fleetResult, concluded: false, artifact: null, receipt: null, notes: ["after-install failed"] };
    const receiptless = await receiptClient.callTool({
      name: "pico_loop",
      arguments: { goal: "receiptless loop fixture", draftSpec: { meta: { packageName: "com.example.fixture" } }, acceptance: [{ kind: "visual" }], budget: { iterations: 1 }, onFail: "stop" },
    });
    const receiptlessOut = JSON.parse(receiptless.content[0].text);
    if (receiptlessOut.status === "failed" && receiptlessOut.capture === null
        && receiptlessOut.receiptId === null && receiptlessOut.receiptPath === null)
      ok("pico_loop cannot accept a receiptless run and returns explicit null receipt identity");
    else fail(`pico_loop treated a receiptless run as concluded: ${JSON.stringify(receiptlessOut).slice(0, 420)}`);
  } finally {
    await receiptClient.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(receiptHome, { recursive: true, force: true });
  }
}

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

// ── DOOR 16 pico_loop unit checks (no server) ──
// The no-progress detector compares consecutive failure SIGNATURES: same criteria failing with the
// same first-line details ⇒ the loop is not moving and must stop honestly instead of burning budget.
{
  const failing = [
    { kind: "visual", status: "fail", detail: "verdict FAIL: expected >=2 objects, saw 0\nsecond line varies " + Math.random() },
    { kind: "logcat", status: "fail", detail: "no match for 'rayCast HIT' within 20s" },
  ];
  const sigA = loopFailureSignature(failing);
  const sigB = loopFailureSignature([
    { kind: "visual", status: "fail", detail: "verdict FAIL: expected >=2 objects, saw 0\nDIFFERENT tail, same first line" },
    { kind: "logcat", status: "fail", detail: "no match for 'rayCast HIT' within 20s" },
  ]);
  if (sigA === sigB && typeof sigA === "string" && sigA.length > 0)
    ok("loopFailureSignature is stable across varying detail tails (first-line normalized)");
  else fail(`loopFailureSignature unstable: ${sigA} vs ${sigB}`);
  // Jittering measurements are the SAME wall: digits are normalized so a re-measured p5 (or a
  // varying count/pid) cannot defeat the two-identical-failures stop.
  const jitterA = loopFailureSignature([{ kind: "perf", status: "fail", detail: "appFps p5=43.2 below floor 60" }]);
  const jitterB = loopFailureSignature([{ kind: "perf", status: "fail", detail: "appFps p5=41.7 below floor 60" }]);
  if (jitterA === jitterB) ok("loopFailureSignature collapses jittering measurements (digit-normalized)");
  else fail(`jittering p5 defeats the no-progress detector: ${jitterA} vs ${jitterB}`);
  const sigC = loopFailureSignature([{ kind: "visual", status: "fail", detail: "verdict FAIL: frame is uniformly black" }]);
  if (sigC !== sigA) ok("loopFailureSignature distinguishes genuinely different failures");
  else fail("loopFailureSignature collides different failures");
  if (loopFailureSignature([{ kind: "structural", status: "pass" }]) === "")
    ok("loopFailureSignature is empty when nothing failed (passes never count as a signature)");
  else fail("loopFailureSignature should ignore passing criteria");
}

// A structural assert clears logcat to isolate its Agent Bridge dump. Therefore launch-time
// logcat criteria must be consumed first even when the caller supplied structural first. Keep
// relative order stable within the logcat and non-logcat groups so the exit report stays legible.
if (typeof loopCriteriaInEvidenceSafeOrder !== "function") {
  fail("pico_loop has no evidence-safe criterion ordering helper");
} else {
  const ordered = loopCriteriaInEvidenceSafeOrder([
    { kind: "structural", minEntities: 3 },
    { kind: "visual" },
    { kind: "logcat", pattern: "APP_READY" },
    { kind: "perf", minAppFpsP5: 60 },
    { kind: "logcat", pattern: "rayCast HIT" },
  ]);
  const order = ordered.map((criterion) => `${criterion.kind}:${criterion.pattern ?? "-"}`).join("|");
  if (order === "logcat:APP_READY|logcat:rayCast HIT|structural:-|visual:-|perf:-")
    ok("pico_loop consumes launch logcat before structural asserts can clear it");
  else fail(`mixed criteria remain order-dependent: ${order}`);
}

// replan_spec may mutate only verification metadata (for example the forward capture pose), for
// which recompileSubtree is legitimately empty. Progress is the spec delta, not a subtree count.
if (typeof loopSpecMutated !== "function") {
  fail("pico_loop has no full-spec mutation detector");
} else {
  const before = { verificationPlan: [{ claim: "hero", method: "capture", forwardFOVpose: { yawDeg: 30, pitchDeg: 0, targetZ: -2 } }] };
  const after = structuredClone(before);
  after.verificationPlan[0].forwardFOVpose.yawDeg = 0;
  if (loopSpecMutated(before, after) && !loopSpecMutated(before, structuredClone(before)))
    ok("pico_loop treats a camera-pose-only replan as real progress");
  else fail("pico_loop still equates empty recompileSubtree with an unchanged spec");
}

// replan_spec used to call an advisory-only changes[] entry "patched" even when the returned
// AppSpec was byte-for-byte unchanged. The status must describe an actual spec mutation.
if (typeof replanMutationStatus !== "function") {
  fail("replan_spec has no actual-mutation status helper");
} else {
  const alreadyLit = { scenes: [{ id: "main", lighting: { rig: "sun" } }] };
  const changed = structuredClone(alreadyLit);
  changed.scenes[0].lighting.rig = "fullRig";
  if (replanMutationStatus(alreadyLit, structuredClone(alreadyLit)) === "unchanged"
      && replanMutationStatus(alreadyLit, changed) === "patched")
    ok("replan_spec reports patched only when the AppSpec actually changes");
  else fail("replan_spec still treats advisory prose as an AppSpec patch");
}

// Generic structural/perf failures have no safe AppSpec mutation. They must not be laundered into
// build_failed (which replan_spec cannot repair). A missing logcat marker is also not repairable
// without an explicit action/trigger contract: changing an interaction cannot itself emit a line.
if (typeof loopRepairSelection !== "function") {
  fail("pico_loop has no repairability-aware failure selection");
} else {
  const selected = loopRepairSelection([
    { kind: "logcat", status: "fail", detail: "no logcat match for 'rayCast HIT' within 20s" },
    { kind: "structural", status: "fail", detail: '[{"check":"entity present: hero","pass":false}]' },
    { kind: "perf", status: "fail", detail: "appFps p5=43 below floor 60; GPU diagnosis unavailable" },
  ]);
  const unsupportedKinds = selected.unsupported.map((outcome) => outcome.kind).join(",");
  if (selected.failures.length === 0 && unsupportedKinds === "logcat,structural,perf")
    ok("pico_loop keeps undriven logcat/structural/perf failures manual");
  else fail(`pico_loop repair selection is still a one-shot build_failed dead end: ${JSON.stringify(selected)}`);

  const measuredBlack = loopVisualOutcome("FAIL", "/tmp/black.png", [], [
    { name: "notMostlyBlack", score: 0, hardFail: true, detail: "coverage 0.001 (MOSTLY BLACK)" },
  ]);
  const blackRepair = loopRepairSelection([measuredBlack]);
  if (blackRepair.failures[0]?.symptom === "not_rendering" && /notMostlyBlack/.test(measuredBlack.detail ?? ""))
    ok("pico_loop preserves fleet-shaped eye checks and repairs only a measured black/empty frame");
  else fail(`fleet eye details cannot reach a supported repair: ${JSON.stringify({ measuredBlack, blackRepair })}`);

  const colorAbsent = loopVisualOutcome("FAIL", "/tmp/color.png", [], [
    { name: "colorKeyCount", score: 0, hardFail: true, detail: "0/4 authored colors detected" },
  ]);
  const unsupportedVisual = loopRepairSelection([colorAbsent]);
  const unsupportedLog = loopRepairSelection([{ kind: "logcat", status: "fail", detail: "no logcat match for 'rayCast HIT' within 20s" }]);
  if (!unsupportedVisual.failures.length && unsupportedVisual.unsupported.length === 1
      && !unsupportedLog.failures.length && unsupportedLog.unsupported.length === 1)
    ok("pico_loop does not invent camera or interaction repairs from unsupported measured failures");
  else fail(`unsupported visual/logcat failures were assigned speculative repairs: ${JSON.stringify({ unsupportedVisual, unsupportedLog })}`);
}

// Unmeasurable is a class, not a diagnosis. Only a measured perf setup refusal earns the
// separately mutating setup remedy; structural/logcat/runtime gaps must keep their own lane.
if (typeof loopUnmeasurableFix !== "function") {
  fail("pico_loop has no provenance-aware unmeasurable-remedy helper");
} else {
  const structural = loopUnmeasurableFix([
    { kind: "structural", status: "unmeasurable", detail: "Agent Bridge unavailable" },
  ]);
  const perfRuntime = loopUnmeasurableFix([
    { kind: "perf", status: "unmeasurable", detail: "no app 3D frames", failureClass: "runtime" },
  ]);
  const perfSetup = loopUnmeasurableFix([
    { kind: "perf", status: "unmeasurable", detail: "utility payload absent", failureClass: "setup-required" },
  ]);
  if (!/ensure_pico_cli|args \["setup"\]/i.test(`${structural}\n${perfRuntime}`)
      && /ensure_pico_cli/i.test(perfSetup)
      && /args \["setup"\]/i.test(perfSetup))
    ok("pico_loop recommends CLI setup only for an explicitly classified perf setup refusal");
  else fail(`pico_loop applies setup to unrelated unmeasurable lanes: ${JSON.stringify({ structural, perfRuntime, perfSetup })}`);
}

// Only an actual ESCALATE verdict may be described as the calibrated eye escalating. A missing,
// unknown, or skipped verdict still creates an honest LOOK obligation, but it is not evidence that
// the eye ran or classified the frame.
if (typeof loopVisualOutcome !== "function" || typeof loopNeedsLookHonesty !== "function") {
  fail("pico_loop has no verdict-aware needs-look classifier");
} else {
  const escalated = loopVisualOutcome("ESCALATE", "/tmp/escalated.png", []);
  const unscored = loopVisualOutcome(undefined, "/tmp/unscored.png", []);
  const escalatedHonesty = loopNeedsLookHonesty([escalated]);
  const unscoredHonesty = loopNeedsLookHonesty([unscored]);
  if (escalated.status === "needs-look" && escalated.machineVerdict === "ESCALATE"
      && /ESCALATEd/.test(escalatedHonesty) && !/ESCALATEd/.test(unscoredHonesty)
      && /unscored/.test(unscoredHonesty))
    ok("pico_loop distinguishes an eye ESCALATE from an unscored look obligation");
  else fail(`needs-look reason overclaims the eye verdict: ${JSON.stringify({ escalated, unscored, escalatedHonesty, unscoredHonesty })}`);
}

if (typeof loopAcceptanceEvidence !== "function") {
  fail("pico_loop has no evidence-derived acceptance ceiling");
} else {
  const structuralOnly = loopAcceptanceEvidence([{ kind: "structural", status: "pass", detail: "3 entities" }], "FAIL");
  const recordedVisualPass = loopAcceptanceEvidence(
    [{ kind: "visual", status: "pass", machineVerdict: "PASS", recordedEvidence: true }],
    "PASS",
    { status: "recorded" },
  );
  const rejectedVisualPass = loopAcceptanceEvidence(
    [{ kind: "visual", status: "pass", machineVerdict: "PASS", recordedEvidence: false }],
    "PASS",
    { status: "rejected", reason: "corrupt ledger" },
  );
  if (structuralOnly.ceiling === "structural" && /did not include a visual PASS/.test(structuralOnly.honesty)
      && recordedVisualPass.ceiling === "auto_judged"
      && rejectedVisualPass.ceiling === "structural"
      && /not durably recorded/i.test(rejectedVisualPass.honesty))
    ok("pico_loop earns auto_judged only from a durably recorded visual PASS");
  else fail(`acceptance ceiling is not durable-evidence-derived: ${JSON.stringify({ structuralOnly, recordedVisualPass, rejectedVisualPass })}`);
}

const managedHarness = createManagedRuntimeHarness();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...managedHarness.env, PICO_MCP_SURFACE: "doors" },
});
const client = new Client({ name: "doors-test", version: "0.0.0" });
await client.connect(transport);

const toolDefinitions = (await client.listTools()).tools;
const tools = toolDefinitions.map((t) => t.name).sort();
const DOORS = ["pico_build_app", "pico_scan_world", "pico_place", "pico_look", "pico_verify_app", "pico_measure", "pico_perf", "pico_sdk", "pico_doctor", "pico_ship", "pico_capabilities", "pico_fix", "pico_record", "pico_emulator", "pico_next", "pico_loop"];
const expected = [...DOORS, "validate_toolchain", "ensure_pico_cli"].sort();
if (JSON.stringify(tools) === JSON.stringify(expected)) ok(`doors surface exposes exactly ${expected.length} tools`);
else fail(`surface mismatch — got [${tools.join(", ")}]`);

const picoShipDefinition = toolDefinitions.find((tool) => tool.name === "pico_ship");
const picoShipSchema = picoShipDefinition?.inputSchema;
if (picoShipSchema?.properties?.app?.pattern === "^[a-z0-9][a-z0-9._-]{0,199}$"
    && JSON.stringify(picoShipSchema?.properties?.lane?.enum) === JSON.stringify(["native", "web", "hybrid"])
    && picoShipSchema?.properties?.projectDir?.type === "string"
    && !picoShipSchema?.properties?.packageName
    && picoShipSchema?.required?.includes("app")
    && !picoShipSchema?.required?.includes("projectDir")
    && /digest-bound|receipt/i.test(picoShipDefinition?.description ?? "")
    && /release|signing|store/i.test(picoShipDefinition?.description ?? ""))
  ok("pico_ship exposes the exact app/lane/projectDir checklist contract and debug-only receipt boundary");
else fail(`pico_ship schema or receipt boundary drifted: ${JSON.stringify(picoShipDefinition)}`);

const picoRecordSchema = toolDefinitions.find((tool) => tool.name === "pico_record")?.inputSchema;
const picoRecordDescription = toolDefinitions.find((tool) => tool.name === "pico_record")?.description ?? "";
const picoRecordEvidenceTypes = picoRecordSchema?.properties?.evidenceType?.enum ?? [];
if (picoRecordSchema?.properties?.app?.pattern === "^[a-z0-9][a-z0-9._-]{0,199}$"
    && !picoRecordEvidenceTypes.includes("auto_judged")
    && !picoRecordEvidenceTypes.includes("usd_host_render")
    && picoRecordSchema?.properties?.deviceFeature?.pattern === "^[a-z0-9]+(?:_[a-z0-9]+)*$"
    && JSON.stringify(picoRecordSchema?.properties?.deviceOutcome?.enum) === JSON.stringify(["pass", "fail"])
    && picoRecordSchema?.properties?.runReceiptId?.pattern === "^[a-f0-9]{64}$"
    && /pico_build_app|receipt/i.test(picoRecordSchema?.properties?.runReceiptId?.description ?? "")
    && /exact|capture/i.test(picoRecordDescription))
  ok("pico_record advertises canonical keys, caller-recordable tiers, structured device outcomes, and exact receipt binding");
else fail(`pico_record advertises calls its inner ledger rejects: ${JSON.stringify(picoRecordSchema)}`);

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

// v31.3: the scaffold response NAMES the archetype + WHY (the matched keywords) so the author can override.
if (baOut.archetype === "display" && /matched keyword/.test(baOut.archetypeWhy ?? "") && /crystal/.test(baOut.archetypeWhy ?? ""))
  ok("needs-authoring names the archetype + the matched keyword(s) that steered it");
else fail(`archetype/why missing from needs-authoring: ${JSON.stringify({ archetype: baOut.archetype, archetypeWhy: baOut.archetypeWhy })}`);

// v31.3 schema hints: an invalid draftSpec comes back as plan-failed with, per zod issue, the failing
// path, the expected shape, and a known-good example fragment lifted from the brief's own scaffold.
const bad = await client.callTool({ name: "pico_build_app", arguments: { brief: "three spinning crystals over a stone floor with a start menu", draftSpec: { meta: { appName: "CrystalsXR" } } } });
const badOut = JSON.parse(bad.content[0].text);
const hint = (badOut.detail?.issues ?? []).find((i) => i.path === "meta.packageName");
if (badOut.status === "plan-failed" && hint && /expected string/.test(hint.expected ?? "") && hint.example === "com.example.showcasexr")
  ok("plan-failed schema hints carry path + expected shape + known-good example fragment");
else fail(`plan-failed schema hints missing: ${JSON.stringify(badOut).slice(0, 300)}`);

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

const doctorCli = checks?.find((check) => check.name === "pico-cli");
if (doctorCli?.status === "warn"
    && /first CLI use/i.test(`${doctorCli.detail} ${doctorCli.fix}`)
    && doctorCli.inspection?.status === "unavailable"
    && doctorCli.inspection?.policy === "managed-latest"
    && doctorCli.inspection?.source === "managed"
    && doctorCli.inspection?.freshness === null
    && /No validated managed pico-cli/i.test(doctorCli.inspection?.note ?? "")
    && !fs.existsSync(managedHarness.managedRoot)
    && managedHarness.calls().filter((call) => call.role === "npm").length === 0)
  ok("default pico_doctor is managed-store read-only and explains lazy first use");
else fail(`default pico_doctor provisioned or hid the managed-first-use warning: ${JSON.stringify({ doctorCli, calls: managedHarness.calls(), rootExists: fs.existsSync(managedHarness.managedRoot) }).slice(0, 400)}`);

// Task 4: managed activation never mutates PATH, so the already-running full-surface inner server
// must survive an ensure call. The fake node proxy logs each inner dist/index.js lifetime.
const innerStartsBeforeEnsure = managedHarness.calls().filter((call) => call.role === "node-proxy" && call.args.some((arg) => /dist[/\\]index\.js$/.test(arg))).length;
const ensuredManaged = JSON.parse((await client.callTool({ name: "ensure_pico_cli", arguments: { update: false } })).content[0].text);
const sdkAfterEnsure = JSON.parse((await client.callTool({ name: "pico_sdk", arguments: { symbol: "RigidBodyComponent" } })).content[0].text);
const innerStartsAfterEnsure = managedHarness.calls().filter((call) => call.role === "node-proxy" && call.args.some((arg) => /dist[/\\]index\.js$/.test(arg))).length;
if (ensuredManaged.status === "ok"
    && ensuredManaged.source === "managed"
    && sdkAfterEnsure.status !== "error"
    && innerStartsBeforeEnsure === 1
    && innerStartsAfterEnsure === 1
    && managedHarness.calls().every((call) => !call.args.includes("-g") && !call.args.includes("--global")))
  ok("doors keeps one inner-server lifetime across managed ensure without PATH mutation");
else fail(`doors recycled or globally provisioned its inner server: ${JSON.stringify({ ensuredManaged, innerStartsBeforeEnsure, innerStartsAfterEnsure, calls: managedHarness.calls() }).slice(0, 600)}`);

// DOOR 14 restart is advisory-only: it returns the documented cold-restart command, never runs it
const emuRestart = await client.callTool({ name: "pico_emulator", arguments: { action: "restart" } });
const emuOut = JSON.parse(emuRestart.content[0].text);
if (emuOut.status === "manual-restart-required" && /restart-emulator\.sh/.test(emuOut.fix ?? "") && /recalibrate/i.test(emuOut.fix ?? ""))
  ok("pico_emulator restart returns the cold-restart command + recalibration reminder (not executed)");
else fail(`pico_emulator restart broken: ${JSON.stringify(emuOut).slice(0, 200)}`);

// DOOR 15 pico_next: reads real local state and recommends a REAL door — never executes it.
const nx = await client.callTool({ name: "pico_next", arguments: {} });
const nxOut = JSON.parse(nx.content[0].text);
if (typeof nxOut.situation === "string" && nxOut.situation.length > 20
    && nxOut.nextAction && DOORS.includes(nxOut.nextAction.door)
    && typeof nxOut.nextAction.why === "string" && nxOut.nextAction.why.length > 10
    && "argsExample" in nxOut.nextAction
    && Array.isArray(nxOut.alternatives) && nxOut.alternatives.every((a) => DOORS.includes(a.door)))
  ok(`pico_next returns a nextAction naming a real door (${nxOut.nextAction.door}) + ${nxOut.alternatives.length} alternative(s)`);
else fail(`pico_next broken: ${JSON.stringify(nxOut).slice(0, 300)}`);

// DOOR 13 closes the LOOK -> record loop on the doors surface with the ledger's honesty gate intact
const recordApp = "pico-doors-record-fixture";
const rec = await client.callTool({ name: "pico_record", arguments: { app: recordApp, claim: "doors-surface fixture claim", evidenceType: "structural", report: true } });
const recOut = JSON.parse(rec.content[0].text);
if (recOut.status === "recorded" && recOut.report?.capabilityReport)
  ok("pico_record records a structural claim and returns the ledger-generated report");
else fail(`pico_record broken: ${JSON.stringify(recOut).slice(0, 200)}`);
const retract = await client.callTool({
  name: "pico_record",
  arguments: {
    app: recordApp,
    action: "retract",
    targetSeq: recOut.entry?.seq,
    retractionReason: "door correction-lane fixture",
    report: true,
  },
});
const retractOut = JSON.parse(retract.content[0].text);
if (retractOut.status === "recorded" && retractOut.event?.retracts === recOut.entry?.seq
    && retractOut.report?.entryCount === 0
    && retractOut.report?.history?.some((event) => event.seq === recOut.entry?.seq && event.claim === "doors-surface fixture claim"))
  ok("pico_record appends a retraction while retaining immutable claim history");
else fail(`pico_record retraction lane broken: ${JSON.stringify(retractOut).slice(0, 300)}`);
const overclaim = await client.callTool({ name: "pico_record", arguments: { app: recordApp, claim: "it renders", evidenceType: "vision_verified" } });
const overOut = JSON.parse(overclaim.content[0].text);
if (overOut.status === "rejected" && /artifactPath/.test(overOut.reason ?? ""))
  ok("pico_record passes the ledger's vision_verified rejection through untouched");
else fail(`pico_record upgraded an over-claim: ${JSON.stringify(overOut).slice(0, 200)}`);
const mixedAction = await client.callTool({
  name: "pico_record",
  arguments: {
    app: recordApp,
    action: "retract",
    claim: "this must not be accepted as both a claim and correction",
    evidenceType: "structural",
    targetSeq: recOut.entry?.seq,
    retractionReason: "mutually exclusive action fixture",
  },
});
const mixedActionOut = JSON.parse(mixedAction.content[0].text);
if (mixedActionOut.status === "rejected" && /mutually exclusive/.test(mixedActionOut.reason ?? ""))
  ok("pico_record rejects mixed record/retract fields without appending either action");
else fail(`pico_record accepted mixed record/retract fields: ${JSON.stringify(mixedActionOut).slice(0, 240)}`);
const mixedReceiptAction = await client.callTool({
  name: "pico_record",
  arguments: {
    app: recordApp,
    action: "retract",
    targetSeq: recOut.entry?.seq,
    retractionReason: "receipt IDs are record-only",
    runReceiptId: "a".repeat(64),
  },
});
const mixedReceiptActionOut = JSON.parse(mixedReceiptAction.content[0].text);
if (mixedReceiptActionOut.status === "rejected" && /mutually exclusive|record-only|runReceiptId/.test(mixedReceiptActionOut.reason ?? ""))
  ok("pico_record rejects runReceiptId on the retraction lane");
else fail(`pico_record accepted a receipt ID on the retraction lane: ${JSON.stringify(mixedReceiptActionOut).slice(0, 240)}`);
try { fs.rmSync(path.join(managedHarness.home, ".pico-mcp", "ledgers", `${recordApp}.json`), { force: true }); } catch { /* ignore */ }

// DOOR 16 pico_loop — cheap paths only (no gradle, no emulator):
// (a) an invalid draftSpec must come back plan-failed with a fix pointer BEFORE any build attempt;
const loopBad = await client.callTool({ name: "pico_loop", arguments: { goal: "three spinning crystals over a stone floor", draftSpec: { meta: { appName: "LoopBad" } }, acceptance: [{ kind: "visual" }] } });
const loopBadOut = JSON.parse(loopBad.content[0].text);
if (loopBadOut.status === "plan-failed" && loopBadOut.fix && loopBadOut.iterations === 0)
  ok("pico_loop invalid draftSpec → plan-failed with fix, zero build iterations");
else fail(`pico_loop plan-failed path broken: ${JSON.stringify(loopBadOut).slice(0, 200)}`);
// (b) empty acceptance is a schema-level rejection — a loop with no exit criteria cannot run honestly.
const loopNoAcc = await client.callTool({ name: "pico_loop", arguments: { goal: "anything", acceptance: [] } });
if (loopNoAcc.isError && /acceptance/i.test(loopNoAcc.content?.[0]?.text ?? ""))
  ok("pico_loop rejects an empty acceptance list at the schema");
else fail(`pico_loop accepted an empty acceptance list: ${JSON.stringify(loopNoAcc).slice(0, 160)}`);
// (c) a logcat criterion without a pattern is caught by the handler pre-flight BEFORE any build.
const loopNoPat = await client.callTool({ name: "pico_loop", arguments: { goal: "three spinning crystals over a stone floor", acceptance: [{ kind: "logcat" }] } });
const loopNoPatOut = JSON.parse(loopNoPat.content[0].text);
if (loopNoPatOut.status === "invalid-acceptance" && loopNoPatOut.iterations === 0 && /pattern/.test(loopNoPatOut.fix ?? ""))
  ok("pico_loop pre-flights a patternless logcat criterion (invalid-acceptance, zero builds)");
else fail(`pico_loop patternless-logcat pre-flight broken: ${JSON.stringify(loopNoPatOut).slice(0, 200)}`);

await client.close();
fs.rmSync(managedHarness.root, { recursive: true, force: true });

// v36.3 default-surface flip: with PICO_MCP_SURFACE UNSET, the server must serve the doors
// surface — the docs told every host to set doors while the code defaulted to full, so one
// missed env var exposed the 86,927-token full `tools/list` schema payload (o200k_base,
// measured 2026-08-12).
// Delete both surface vars so an inherited shell/CI value cannot mask the coded default.
{
  const defaultEnv = { ...process.env };
  delete defaultEnv.PICO_MCP_SURFACE;
  delete defaultEnv.PICO_MCP_OUTER_SURFACE;
  const defaultTransport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: defaultEnv });
  const defaultClient = new Client({ name: "doors-default-test", version: "0.0.0" });
  await defaultClient.connect(defaultTransport);
  const defaultTools = (await defaultClient.listTools()).tools.map((t) => t.name).sort();
  if (JSON.stringify(defaultTools) === JSON.stringify(expected))
    ok(`PICO_MCP_SURFACE unset serves the doors surface (${expected.length} tools) — full stays explicit opt-in`);
  else fail(`env-unset default is not the doors surface — got ${defaultTools.length} tools`);
  await defaultClient.close();
}

// Static guard for the v36.3 flip: every src/ self-spawn of the server must pin PICO_MCP_SURFACE
// explicitly. The SDK's child env is a whitelist — the variable never inherits — so an unpinned
// StdioClientTransport spawn of index.js silently serves the doors surface and full-surface inner
// calls die tool-not-found (found live in fleetbuild/hybridbuild/marbleingest/semanticsplat by the
// 2026-08-12 adversarial review of this flip).
{
  const srcDir = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const content = fs.readFileSync(new URL(file, srcDir), "utf8");
    for (const m of content.matchAll(/new StdioClientTransport\(\{[\s\S]{0,400}?\}\)/g)) {
      if (!/index\.js/.test(m[0])) continue; // pico-cli child MCP servers etc. are not self-spawns
      // doors.ts pins through its named childEnv object (built with PICO_MCP_SURFACE: "full").
      if (!/PICO_MCP_SURFACE|childEnv/.test(m[0])) offenders.push(`src/${file}`);
    }
  }
  if (offenders.length === 0) ok("every src/ self-spawn of the server pins PICO_MCP_SURFACE explicitly");
  else fail(`self-spawns without a surface pin (doors-by-default breaks their inner calls): ${offenders.join(", ")}`);
}

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
