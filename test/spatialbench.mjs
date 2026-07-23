// v23 SpatialBench test: the headless tier scores the ENTIRE corpus deterministically, and the
// report renderer keeps the honesty framing (eye = auto_judged, skips marked not zeroed).
// v27.5 adds the optional perf axis: unit-tests the scoring decision (scorePerfAxis) headlessly —
// no emulator involved — plus keeps the axes-shape assertion tolerant of the new column.
// v27.8 adds RED contracts for panel-aware verification: dumpsys discovery must distinguish a real
// caption-backed panel from the immersive LaunchActivity, fleet expectations must come from the
// verification target (never the old blanket "2 objects"), and structural panel discovery must
// live on a separate panelReady axis that never becomes a visual-eye pass.
// Run: npm run test:bench
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as spatialbench from "../dist/spatialbench.js";
import * as fleetbuild from "../dist/fleetbuild.js";
import * as planner from "../dist/planner.js";
import * as webworkspace from "../dist/webworkspace.js";
import { scorePerfAxis } from "../dist/perfprobe.js";

const { headlessRows, renderBenchHtml } = spatialbench;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const { rows, briefsDir } = headlessRows();
if (rows.length >= 15) ok(`corpus loads (${rows.length} briefs from ${briefsDir})`);
else fail(`expected ≥15 corpus briefs, got ${rows.length}`);

const scoredRows = rows.filter((r) => !r.skipped);
const skippedRows = rows.filter((r) => r.skipped);
const perfect = scoredRows.filter((r) => r.score === 3 && r.max === 3).length;
if (perfect === scoredRows.length) ok(`headless tier: every pipeline brief scores 3/3 (planned+compiled+shape)`);
else fail(`headless regressions: ${scoredRows.filter((r) => r.score !== 3).map((r) => `${r.id}=${r.score}/${r.max} [${r.notes.join("; ")}]`).join(", ")}`);
if (skippedRows.every((r) => r.score === 0 && r.max === 0))
  ok(`headless tier: ${skippedRows.length} explicit external implementation(s) report 0/0 skipped`);
else fail(`skipped headless rows must be 0/0: ${skippedRows.map((r) => `${r.id}=${r.score}/${r.max}`).join(", ")}`);

if (rows.every((r) => r.booted === null && r.captured === null && r.panelReady === null && r.eye === null && r.perf === null)) ok("headless tier never claims emulator axes (booted/captured/panelReady/eye/perf stay null)");
else fail("headless tier leaked emulator-axis claims");

// renderer honesty: emulator axes render as —, skips marked, auto_judged framing present
const report = {
  generatedAt: "2026-07-14T00:00:00Z",
  tier: "headless",
  briefsDir,
  summary: { total: rows.length, aggregate: rows.reduce((a, r) => a + r.score, 0), maxAggregate: rows.reduce((a, r) => a + r.max, 0), skipped: [], escalations: [] },
  rows: [...rows.slice(0, 2), { ...rows[2], skipped: "needs an external asset", notes: [] }],
};
const html = renderBenchHtml(report);
if (html.includes("auto_judged") && html.includes("NOT vision_verified")) ok("report keeps the honesty framing (eye = auto_judged, not vision)");
else fail("honesty framing missing from the report");
if (html.includes('<span class="na">—</span>') && html.includes("skipped: needs an external asset")) ok("unrun axes render as — and skips are marked, not zeroed");
else fail("axis/skip rendering wrong");

if (html.includes("<th>perf</th>") && html.includes("NOT the spatial engine's 3D frame pacing")) ok("report gains a perf column + honestly scopes it to UI frames, not 3D pacing");
else fail("perf column/honesty framing missing from the report");

if (html.includes("<th>panelReady</th>") && /panelReady[^<]*(structural|WindowManager)/i.test(html)) ok("report has a structural panelReady axis separate from the eye");
else fail("panelReady column/honesty framing missing from the report");

// scorePerfAxis: the perf-axis decision function, headlessly testable without an emulator.
const budgetMs = 16.7;
const under = scorePerfAxis({ verdict: "smooth (60fps-class UI frames)", p95: 12.4 }, budgetMs);
if (under === 1) ok("scorePerfAxis: parsed data under budget -> 1");
else fail(`scorePerfAxis under-budget expected 1, got ${under}`);

const over = scorePerfAxis({ verdict: "janky", p95: 41.2 }, budgetMs);
if (over === 0) ok("scorePerfAxis: parsed data over budget -> 0");
else fail(`scorePerfAxis over-budget expected 0, got ${over}`);

const noData = scorePerfAxis({ verdict: "no-frame-data", p95: null }, budgetMs);
if (noData === null) ok("scorePerfAxis: no UI frame data -> null (skip, not a fail)");
else fail(`scorePerfAxis no-frame-data expected null, got ${noData}`);

// ── panel discovery: pure dumpsys fixture, no emulator ─────────────────────────────────────────────
// This is a sanitized slice of the live console run. The application has THREE ordinary windows,
// but only container 11 is a spatial panel: SystemUI owns a healthy caption-bar window whose
// captionBarContainerId points back to it. Container 10 is the immersive LaunchActivity and must not
// be counted; container 12's caption exists but is not shown, so it must also fail closed. The 48px
// SystemUI attachment is neither an app panel nor caption-backed.
const PANEL_DUMPSYS = `WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #0 Window{e1cbf4e u0 com.picoxr.systemui}:
    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false
      Surface: shown=true      mDrawState=HAS_DRAWN       mLastHidden=false
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[600, 208], windowEntityId=2364963612000423, isViewAttachment=true, isViewAttachmentDecoupled=true, parentContainerId=0, captionBarContainerId=11, isCaptionBarWindow=true}
        taskId [0], layerId [149], containerId [0]
  Window #1 Window{22bb296 u0 com.picoxr.systemui}:
    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false
      Surface: shown=true      mDrawState=HAS_DRAWN       mLastHidden=false
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[48, 48], windowEntityId=2364963612000328, isViewAttachment=true, isViewAttachmentDecoupled=true, parentContainerId=0, captionBarContainerId=0, isCaptionBarWindow=false}
        taskId [0], layerId [71], containerId [0]
  Window #2 Window{3b610c6 u0 com.fleet.console/.content.HudPanelActivity}:
    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false
      Surface: shown=true      mDrawState=HAS_DRAWN       mLastHidden=false
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[2560, 1440], windowEntityId=0, isViewAttachment=false, isViewAttachmentDecoupled=false, parentContainerId=0, captionBarContainerId=0, isCaptionBarWindow=false}
        taskId [24], layerId [143], containerId [11]
  Window #3 Window{7c35234 u0 com.fleet.console/com.fleet.console.platform.LaunchActivity}:
    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false
      Surface: shown=true      mDrawState=HAS_DRAWN       mLastHidden=false
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[2560, 1440], windowEntityId=0, isViewAttachment=false, isViewAttachmentDecoupled=false, parentContainerId=0, captionBarContainerId=0, isCaptionBarWindow=false}
        taskId [22], layerId [136], containerId [10]
  Window #4 Window{badca12 u0 com.picoxr.systemui}:
    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false
      Surface: shown=false     mDrawState=HAS_DRAWN       mLastHidden=false
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[600, 208], windowEntityId=2364963612000999, isViewAttachment=true, isViewAttachmentDecoupled=true, parentContainerId=0, captionBarContainerId=12, isCaptionBarWindow=true}
        taskId [0], layerId [151], containerId [0]
  Window #5 Window{badab12 u0 com.fleet.console/.content.BrokenPanelActivity}:
    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false
      Surface: shown=true      mDrawState=HAS_DRAWN       mLastHidden=false
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[2560, 1440], windowEntityId=0, isViewAttachment=false, isViewAttachmentDecoupled=false, parentContainerId=0, captionBarContainerId=0, isCaptionBarWindow=false}
        taskId [25], layerId [145], containerId [12]
`;

// Both packages own otherwise healthy caption-backed panels. Filtering com.foo must never accept
// com.foobar merely because the former is a string prefix of the latter.
const PACKAGE_COLLISION_DUMPSYS = `WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #0 Window{ca21001 u0 com.picoxr.systemui}:
    mHasSurface=true isReadyForDisplay()=true
      Surface: shown=true
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[600, 208], windowEntityId=2101, isViewAttachment=true, isViewAttachmentDecoupled=true, parentContainerId=0, captionBarContainerId=21, isCaptionBarWindow=true}
        taskId [0], layerId [201], containerId [0]
  Window #1 Window{fa21001 u0 com.foo/.PanelActivity}:
    mHasSurface=true isReadyForDisplay()=true
      Surface: shown=true
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[1280, 720], windowEntityId=0, isViewAttachment=false, isViewAttachmentDecoupled=false, parentContainerId=0, captionBarContainerId=0, isCaptionBarWindow=false}
        taskId [31], layerId [202], containerId [21]
  Window #2 Window{ca22002 u0 com.picoxr.systemui}:
    mHasSurface=true isReadyForDisplay()=true
      Surface: shown=true
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[600, 208], windowEntityId=2202, isViewAttachment=true, isViewAttachmentDecoupled=true, parentContainerId=0, captionBarContainerId=22, isCaptionBarWindow=true}
        taskId [0], layerId [203], containerId [0]
  Window #3 Window{fa22002 u0 com.foobar/.PanelActivity}:
    mHasSurface=true isReadyForDisplay()=true
      Surface: shown=true
    isOnScreen=true
    isVisible=true
        SpaceWindowAttributes{type=0, size=[1280, 720], windowEntityId=0, isViewAttachment=false, isViewAttachmentDecoupled=false, parentContainerId=0, captionBarContainerId=0, isCaptionBarWindow=false}
        taskId [32], layerId [204], containerId [22]
`;

if (typeof webworkspace.parseSpatialPanels !== "function") {
  fail("parseSpatialPanels export missing (pure list_spatial_panels discovery contract)");
} else {
  const expectedHud = "com.fleet.console.content.HudPanelActivity";
  const discovered = webworkspace.parseSpatialPanels(PANEL_DUMPSYS, {
    packageFilter: "com.fleet.console",
    expectedActivities: [expectedHud],
  });
  const panels = discovered?.panels ?? [];
  if (discovered?.status === "ok" && panels.length === 1 && /HudPanelActivity/.test(panels[0].name ?? panels[0].activity ?? ""))
    ok("panel discovery joins caption container 11 and returns only HudPanelActivity");
  else fail(`panel discovery should return exactly HudPanelActivity: ${JSON.stringify(discovered)}`);
  if (Number(panels[0]?.containerId) === 11) ok("panel discovery exposes the app's real containerId=11");
  else fail(`panel discovery lost containerId=11: ${JSON.stringify(panels[0])}`);
  if (!panels.some((p) => /LaunchActivity/.test(p.name ?? p.activity ?? "")) && !panels.some((p) => p.size?.[0] === 48))
    ok("panel discovery excludes LaunchActivity container 10 and 48px SystemUI attachments");
  else fail(`panel discovery leaked a stage/attachment: ${JSON.stringify(panels)}`);
  if (!panels.some((p) => /BrokenPanelActivity/.test(p.name ?? p.activity ?? "")))
    ok("panel discovery rejects an app whose caption window is not shown");
  else fail(`unhealthy caption qualified as panel evidence: ${JSON.stringify(panels)}`);
  if (panels[0]?.activity === expectedHud && discovered.expectationMet === true && discovered.matchedActivities?.includes(expectedHud))
    ok("shorthand .Activity normalizes to and satisfies a fully-qualified expected activity");
  else fail(`shorthand activity did not satisfy expectedActivities: ${JSON.stringify(discovered)}`);
  if (panels[0]?.visible === true && panels[0]?.captionBacked === true)
    ok("panel discovery emits normalized visible + captionBacked signals");
  else fail(`normalized panel readiness signals missing: ${JSON.stringify(panels[0])}`);

  const missingExpected = "com.fleet.console.content.MissingPanelActivity";
  const missing = webworkspace.parseSpatialPanels(PANEL_DUMPSYS, {
    packageFilter: "com.fleet.console",
    expectedActivities: [missingExpected],
  });
  if (missing.expectationMet === false && missing.missingActivities?.includes(missingExpected) && (missing.matchedActivities?.length ?? 0) === 0)
    ok("missing expected activity yields expectationMet=false plus missingActivities");
  else fail(`missing expected activity was not reported fail-closed: ${JSON.stringify(missing)}`);

  const exactPackage = webworkspace.parseSpatialPanels(PACKAGE_COLLISION_DUMPSYS, { packageFilter: "com.foo" });
  if (exactPackage.status === "ok" && exactPackage.panels?.length === 1 && exactPackage.panels[0]?.package === "com.foo")
    ok("package filtering is exact: com.foo does not match com.foobar");
  else fail(`package filter admitted prefix collision: ${JSON.stringify(exactPackage)}`);

  for (const [label, text] of [["empty", ""], ["adb error", "error: device 'emulator-5554' not found"]]) {
    const bad = webworkspace.parseSpatialPanels(text, { packageFilter: "com.fleet.console" });
    if (bad?.status === "error" && (bad.panels?.length ?? 0) === 0) ok(`panel discovery fails closed on ${label} input`);
    else fail(`panel discovery must fail closed on ${label} input: ${JSON.stringify(bad)}`);
  }
}

// ── fleet predicate: derive the visual expectation from the verification target ────────────────────
const dashboardSpec = JSON.parse(fs.readFileSync(path.join(ROOT, "briefs", "dashboard.json"), "utf8")).spec;
const dashboardClaim = dashboardSpec.verificationPlan[0];
if ((dashboardSpec.panels?.length ?? 0) === 0) ok("audited corpus premise: dashboard declares 0 panels");
else fail(`dashboard must remain a stage-only 0-panel control, got ${dashboardSpec.panels?.length ?? 0}`);
if (typeof fleetbuild.deriveVisualExpectation !== "function") {
  fail("deriveVisualExpectation export missing (fleet must not use blanket minObjects=2)");
} else {
  const expectation = fleetbuild.deriveVisualExpectation(dashboardSpec, dashboardClaim);
  if (expectation?.minObjects === 6 && expectation?.maxObjects === 6 && expectation?.notMostlyBlack === true)
    ok("dashboard visual expectation is exactly 6 objects from target layout 'tiles'");
  else fail(`dashboard expectation must be min=max=6, not the old 2..3: ${JSON.stringify(expectation)}`);
  const objectExpectation = fleetbuild.deriveVisualExpectation(dashboardSpec, { ...dashboardClaim, targetRef: "metrics" });
  if (objectExpectation?.minObjects === 6 && objectExpectation?.maxObjects === 6)
    ok("visual expectation follows object 'metrics' through layoutRef to the exact 6-slot layout");
  else fail(`object.layoutRef expectation must also be min=max=6: ${JSON.stringify(objectExpectation)}`);
}

// ── planner: panels are real C0 AppSpec targets, not unresolved refs ────────────────────────────────
const consoleSpec = JSON.parse(fs.readFileSync(path.join(ROOT, "briefs", "console.json"), "utf8")).spec;
if ((consoleSpec.panels?.length ?? 0) === 1) ok("audited corpus premise: console declares exactly 1 panel");
else fail(`console must remain the 1-panel corpus case, got ${consoleSpec.panels?.length ?? 0}`);

// Fleet must route verification by the target's node kind, not blindly send verificationPlan[0]
// to the calibrated stage eye. In particular, an OS panel is structural runtime evidence; it is
// not stage geometry and a visual_judge PASS cannot be manufactured for it from the forward frame.
const routePanelOnly = {
  meta: { packageName: "com.example.panelonly" },
  scenes: [{ id: "empty" }],
  layouts: [],
  objects: [],
  panels: [{ id: "status", kind: "hud" }],
  verificationPlan: [],
};
const routePanelClaimOnly = {
  ...routePanelOnly,
  objects: [{ id: "decor", sceneId: "empty", source: "cube" }],
  verificationPlan: [{ claim: "status is ready", method: "capture", targetRef: "status" }],
};
if (typeof fleetbuild.deriveVerificationRoute !== "function") {
  fail("deriveVerificationRoute export missing (panel targets must bypass the stage eye)");
} else {
  const panelOnlyRoute = fleetbuild.deriveVerificationRoute(routePanelOnly);
  const panelClaimRoute = fleetbuild.deriveVerificationRoute(routePanelClaimOnly);
  const hybridRoute = fleetbuild.deriveVerificationRoute(consoleSpec);
  const target = (claim) => claim?.targetRef ?? null;
  const panelTargets = (route) => route?.panelTargetIds ?? route?.panelTargets?.map((p) => p.id ?? p.targetRef) ?? route?.panelClaims?.map(target) ?? [];

  if (panelOnlyRoute?.mode === "panel-structural" && panelOnlyRoute?.stageEyeClaim == null && panelTargets(panelOnlyRoute).includes("status"))
    ok("panel-only spec routes to panel-structural evidence with no stage eye");
  else fail(`panel-only spec must not invent a stage-eye claim: ${JSON.stringify(panelOnlyRoute)}`);

  if (panelClaimRoute?.mode === "panel-structural" && panelClaimRoute?.stageEyeClaim == null && panelTargets(panelClaimRoute).includes("status"))
    ok("a verification plan containing only a panel target bypasses the stage eye");
  else fail(`panel-target-only verification plan must be structural: ${JSON.stringify(panelClaimRoute)}`);

  if (hybridRoute?.mode === "hybrid" && target(hybridRoute?.stageEyeClaim) === "tiles" && panelTargets(hybridRoute).includes("sys"))
    ok("hybrid console routes tiles to the stage eye and sys to panel evidence");
  else fail(`hybrid route must split tiles from sys: ${JSON.stringify(hybridRoute)}`);
}

const panelClaim = {
  claim: "the SYSTEM panel is on stage",
  method: "capture",
  capabilityClass: "C0_emulator",
  targetRef: "sys",
  forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -2.5 },
};
const consoleWithPanelClaim = { ...consoleSpec, verificationPlan: [...consoleSpec.verificationPlan, panelClaim] };
if (planner.computeNodeClass(consoleWithPanelClaim, panelClaim) === "C0_emulator") ok("panel targetRef 'sys' computes to C0_emulator");
else fail(`panel targetRef 'sys' should compute C0_emulator, got ${planner.computeNodeClass(consoleWithPanelClaim, panelClaim)}`);
const panelLint = planner.lintSpec(consoleWithPanelClaim);
if (!panelLint.warnings.some((w) => /targetRef 'sys'.*resolves to no spec node/.test(w))) ok("lint recognizes console panel targetRef 'sys'");
else fail(`lint still calls panel targetRef 'sys' unresolved: ${panelLint.warnings.join("; ")}`);

// ── SpatialBench policy: panel readiness is structural and independent from the visual eye ──────────
if (typeof spatialbench.scorePanelReadyEvidence !== "function") {
  fail("scorePanelReadyEvidence export missing (structural panelReady-axis policy)");
} else {
  const expectedActivity = "com.fleet.console.content.HudPanelActivity";
  const healthyDiscovery = {
    status: "ok",
    evidenceType: "structural",
    panels: [{
      name: `com.fleet.console/${expectedActivity}`,
      activity: expectedActivity,
      containerId: 11,
      captionBarContainerId: 11,
      captionBacked: true,
      ready: true,
      hasSurface: true,
      surfaceShown: true,
      onScreen: true,
      wmVisible: true,
      captionReady: true,
    }],
  };
  const noPanel = spatialbench.scorePanelReadyEvidence({ expectedActivity: null, discovery: healthyDiscovery });
  if (noPanel === null) ok("panelReady stays null when the AppSpec expects no panel");
  else fail(`no-panel brief must not gain a panelReady score: ${JSON.stringify(noPanel)}`);

  const structuralReady = spatialbench.scorePanelReadyEvidence({ expectedActivity, discovery: healthyDiscovery });
  if (structuralReady === 1) ok("healthy caption-backed expected activity scores panelReady=1 (structural)");
  else fail(`healthy expected panel should score panelReady=1: ${JSON.stringify(structuralReady)}`);

  const unhealthyDiscovery = {
    ...healthyDiscovery,
    panels: [{ ...healthyDiscovery.panels[0], wmVisible: false }],
  };
  const unhealthy = spatialbench.scorePanelReadyEvidence({ expectedActivity, discovery: unhealthyDiscovery });
  if (unhealthy === 0) ok("a discovered but non-visible panel fails panelReady closed");
  else fail(`non-visible panel must score panelReady=0: ${JSON.stringify(unhealthy)}`);

  const stageOnly = spatialbench.scorePanelReadyEvidence({
    expectedActivity,
    discovery: {
      status: "ok",
      evidenceType: "structural",
      panels: [{
        name: "com.fleet.console/com.fleet.console.platform.LaunchActivity",
        activity: "com.fleet.console.platform.LaunchActivity",
        containerId: 10,
        captionBarContainerId: null,
        captionBacked: false,
        ready: true,
        hasSurface: true,
        surfaceShown: true,
        onScreen: true,
        wmVisible: true,
        captionReady: false,
      }],
    },
  });
  if (stageOnly === 0) ok("a healthy immersive LaunchActivity cannot impersonate panelReady evidence");
  else fail(`stage-only discovery must score panelReady=0: ${JSON.stringify(stageOnly)}`);

  const discoveryError = spatialbench.scorePanelReadyEvidence({ expectedActivity, discovery: { status: "error", panels: [] } });
  if (discoveryError === 0) ok("panel discovery error fails panelReady closed");
  else fail(`panel discovery error must score panelReady=0: ${JSON.stringify(discoveryError)}`);

  const twoNodesOneWindow = spatialbench.scorePanelReadyEvidence({
    expectedActivities: [expectedActivity],
    expectedPanelCount: 2,
    nodeMappings: [
      { nodeId: "left", activity: expectedActivity, kind: "hud" },
      { nodeId: "right", activity: expectedActivity, kind: "hud" },
    ],
    discovery: healthyDiscovery,
  });
  if (twoNodesOneWindow === 0) ok("two declared HUD panels cannot be satisfied by one shared runtime window");
  else fail(`2 panel nodes mapped to 1 activity/window must score panelReady=0, got ${JSON.stringify(twoNodesOneWindow)}`);

  const panelStructuralFleetResult = {
    built: true,
    installed: true,
    artifact: "/dev/null",
    verdict: "PASS",
    verificationRoute: {
      mode: "panel-structural",
      stageEyeClaim: null,
      panelTargetIds: ["sys"],
    },
    panelEvidence: {
      evidenceType: "structural",
      status: "ok",
      expectedActivities: [expectedActivity],
      nodeMappings: [{ nodeId: "sys", activity: expectedActivity, kind: "hud" }],
      discovery: healthyDiscovery,
    },
    notes: [],
  };
  if (typeof spatialbench.applyFleetRuntimeEvidence !== "function") {
    fail("applyFleetRuntimeEvidence export missing (panel-only scoring must exclude the eye axis)");
  } else {
    const base = {
      ...rows.find((r) => r.id === "console"),
      expectedPanels: 1,
      notes: [],
    };
    const scored = spatialbench.applyFleetRuntimeEvidence(base, panelStructuralFleetResult);
    if (scored?.booted === 1 && scored?.captured === 1 && scored?.panelReady === 1 && scored?.eye === null && scored?.score === 6 && scored?.max === 6)
      ok("panel-structural fleet evidence scores 6/6 with panelReady separate and eye excluded");
    else fail(`panel-structural runtime must be 6/6 with eye=null, not a visual pass: ${JSON.stringify(scored)}`);
  }

  // The error path must use the same route policy as a successful fleet result. An MCP timeout
  // means all attempted runtime axes fail, but it still cannot create an eye axis for a spec whose
  // only runtime target is a separate panel window. The stage-eye control locks the other branch.
  if (typeof spatialbench.applyFleetRuntimeFailure !== "function") {
    fail("applyFleetRuntimeFailure export missing (timeout scoring must preserve panel-only routing)");
  } else {
    const timeout = new Error("MCP request timed out after 600000ms");
    const panelFailureBase = {
      ...rows.find((r) => r.id === "console"),
      expectedPanels: 1,
      verificationRoute: { mode: "panel-structural", stageEyeClaim: null, panelTargetIds: ["sys"] },
      notes: [],
    };
    const panelFailure = spatialbench.applyFleetRuntimeFailure(panelFailureBase, timeout);
    if (panelFailure?.booted === 0 && panelFailure?.captured === 0 && panelFailure?.panelReady === 0 && panelFailure?.eye === null && panelFailure?.score === 3 && panelFailure?.max === 6)
      ok("panel-structural timeout scores runtime failures without adding an eye axis");
    else fail(`panel-structural timeout must score 3/6 with eye=null: ${JSON.stringify(panelFailure)}`);

    const stageFailureBase = {
      ...rows.find((r) => r.id === "dashboard"),
      expectedPanels: 0,
      verificationRoute: { mode: "stage-eye", stageEyeClaim: dashboardClaim, panelTargetIds: [] },
      notes: [],
    };
    const stageFailure = spatialbench.applyFleetRuntimeFailure(stageFailureBase, timeout);
    if (stageFailure?.booted === 0 && stageFailure?.captured === 0 && stageFailure?.panelReady === null && stageFailure?.eye === 0 && stageFailure?.score === 3 && stageFailure?.max === 6)
      ok("stage-eye timeout retains the failed eye axis and its 6-point maximum");
    else fail(`stage-eye timeout control must score 3/6 with eye=0: ${JSON.stringify(stageFailure)}`);
  }

  // The generic visual judge currently false-fails the visibly correct SYSTEM panel as mostly-black.
  // panelReady therefore carries structural evidence only; a report may show panelReady=1 while eye
  // remains null, and must never copy the structural score into eye.
  const structuralReport = {
    generatedAt: "2026-07-22T00:00:00Z",
    tier: "full",
    briefsDir,
    summary: { total: 1, aggregate: 6, maxAggregate: 6, skipped: [], escalations: [] },
    rows: [{ ...rows.find((r) => r.id === "console"), booted: 1, captured: 1, panelReady: 1, eye: null, score: 6, max: 6, notes: ["panelReady: structural WindowManager evidence; appearance unconfirmed"] }],
  };
  const structuralHtml = renderBenchHtml(structuralReport);
  const consoleRow = structuralHtml.match(/<tr><td>console<\/td>.*?<\/tr>/s)?.[0] ?? "";
  if (consoleRow.includes('<span class="y">●</span>') && consoleRow.includes('<span class="na">—</span>'))
    ok("report can show panelReady=1 while eye remains unscored");
  else fail(`report conflated structural panelReady with eye: ${consoleRow}`);
  if (consoleRow.includes("<b>6/6</b>") && !consoleRow.includes("<b>5/5</b>")) ok("fabricated panel-structural report fixture has internally consistent 6/6 arithmetic");
  else fail(`panel-structural report fixture has inconsistent score/max: ${consoleRow}`);
}

console.log(`\nSpatialBench test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
