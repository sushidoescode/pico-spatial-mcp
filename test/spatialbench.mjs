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
import { buildLedger } from "../dist/compiler.js";
import { generateWiring } from "../dist/assemble.js";
import { appSpecSchema, iblKtxAssetPathSchema } from "../dist/appspec.js";
import { buildTemplateDraft } from "../dist/templates.js";
import { scorePerfAxis } from "../dist/perfprobe.js";

const { headlessRows, renderBenchHtml } = spatialbench;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const { rows, briefsDir } = headlessRows();
// v37 flagship: Swan Mission Table joins the headless corpus — 27 total.
if (rows.length >= 27) ok(`corpus loads (${rows.length} briefs from ${briefsDir})`);
else fail(`expected ≥27 corpus briefs, got ${rows.length}`);

const scoredRows = rows.filter((r) => !r.skipped);
const skippedRows = rows.filter((r) => r.skipped);
const skippedIds = skippedRows.map((r) => r.id).sort();
const perfect = scoredRows.filter((r) => r.score === 3 && r.max === 3).length;
if (scoredRows.length === rows.length - 1 && perfect === scoredRows.length) ok(`headless tier: every pipeline brief scores 3/3 (planned+compiled+shape)`);
else fail(`headless regressions: ${scoredRows.filter((r) => r.score !== 3).map((r) => `${r.id}=${r.score}/${r.max} [${r.notes.join("; ")}]`).join(", ")}`);
if (
  JSON.stringify(skippedIds) === JSON.stringify(["camerapeek"]) &&
  skippedRows.every((r) => r.score === 0 && r.max === 0 && /hand-authored-classic-android/.test(r.skipped))
)
  ok(`headless tier: only camerapeek is the explicit 0/0 external implementation`);
else fail(`skipped headless rows must be 0/0: ${skippedRows.map((r) => `${r.id}=${r.score}/${r.max}`).join(", ")}`);

if (rows.every((r) => r.booted === null && r.captured === null && r.panelReady === null && r.eye === null && r.perf === null)) ok("headless tier never claims emulator axes (booted/captured/panelReady/eye/perf stay null)");
else fail("headless tier leaked emulator-axis claims");

if (Array.isArray(spatialbench.BENCH_CORE) && spatialbench.BENCH_CORE.includes("ambient"))
  ok("the default full SpatialBench core includes the self-contained ambient IBL conformance brief");
else fail(`default SpatialBench core lost ambient: ${JSON.stringify(spatialbench.BENCH_CORE)}`);

// v32 MR tier: additive alongside BENCH_CORE — core membership is FROZEN for league continuity.
const EXPECTED_CORE = ["crystals", "boutique", "knockdown", "gallery", "console", "dashboard", "ambient", "affordance"];
if (JSON.stringify([...spatialbench.BENCH_CORE]) === JSON.stringify(EXPECTED_CORE))
  ok("BENCH_CORE membership is unchanged by the MR tier (league-table continuity)");
else fail(`BENCH_CORE membership changed: ${JSON.stringify(spatialbench.BENCH_CORE)}`);
if (
  Array.isArray(spatialbench.BENCH_MR) &&
  JSON.stringify([...spatialbench.BENCH_MR]) === JSON.stringify(["mrtable", "mrpedestal", "mrknock"]) &&
  !spatialbench.BENCH_MR.some((id) => spatialbench.BENCH_CORE.includes(id))
)
  ok("BENCH_MR is the additive Mixed-stage tier (mrtable + mrpedestal + mrknock), disjoint from core");
else fail(`BENCH_MR tier wrong: ${JSON.stringify(spatialbench.BENCH_MR)}`);
const mrRows = headlessRows([...spatialbench.BENCH_MR]).rows;
if (mrRows.length === 3 && mrRows.every((r) => !r.skipped && r.score === 3 && r.max === 3))
  ok("every MR-tier brief scores 3/3 headless (planned+compiled+shape)");
else fail(`MR-tier headless regressions: ${mrRows.map((r) => `${r.id}=${r.score}/${r.max} [${r.notes.join("; ")}]`).join(", ")}`);
const mrStageStyles = spatialbench.BENCH_MR.map((id) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "briefs", `${id}.json`), "utf8")).spec?.meta?.stageStyle; } catch { return null; }
});
if (mrStageStyles.every((s) => s === "1")) ok("every BENCH_MR brief declares stageStyle '1' (Mixed) explicitly");
else fail(`BENCH_MR briefs must declare stageStyle '1': ${JSON.stringify(mrStageStyles)}`);

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

// ── baked IBL conformance: a REAL cubemap must reach the APK, and local mode must receive props ──
const ambientEntry = JSON.parse(fs.readFileSync(path.join(ROOT, "briefs", "ambient.json"), "utf8"));
const ambientSpec = appSpecSchema.parse(ambientEntry.spec);
const ambientScene = ambientSpec.scenes?.[0];
const ambientLayout = ambientSpec.layouts?.[0];
const ambientObject = ambientSpec.objects?.[0];
const ambientClaim = ambientSpec.verificationPlan?.[0];
const ambientKtxRel = ambientScene?.lighting?.params?.ktxAssetPath;
const ambientKtx = typeof ambientKtxRel === "string" ? path.join(ROOT, "briefs", ambientKtxRel) : "";

if (
  ambientSpec.meta?.stageStyle === "3" &&
  ambientScene?.lighting?.rig === "ibl" &&
  ambientScene?.lighting?.params?.mode === "local" &&
  ambientScene?.lighting?.params?.intensityExponent === 8 &&
  ambientLayout?.count === 3 &&
  ambientLayout?.params?.radius === 2.2 &&
  ambientLayout?.params?.arcSpanDeg === 32 &&
  ambientObject?.layoutRef === ambientLayout?.id &&
  ambientClaim?.targetRef === ambientLayout?.id &&
  ambientEntry.expected?.layouts === 1
) ok("ambient is a Full-stage, 3-receiver local-IBL conformance brief with a layout-backed eye target");
else fail(`ambient IBL conformance contract missing: ${JSON.stringify({ meta: ambientSpec.meta, lighting: ambientScene?.lighting, layout: ambientLayout, object: ambientObject, claim: ambientClaim, expected: ambientEntry.expected })}`);

if (typeof fleetbuild.inspectIblKtx !== "function" || typeof fleetbuild.provisionIblAssets !== "function") {
  fail("fleet exports inspectIblKtx + provisionIblAssets (real cubemap validation/staging contract)");
} else {
  const info = ambientKtx ? fleetbuild.inspectIblKtx(ambientKtx) : { ok: false, error: "missing ktxAssetPath" };
  if (
    info.ok === true &&
    info.version === 1 &&
    info.width === 256 &&
    info.height === 256 &&
    info.faces === 6 &&
    info.mipLevels > 1 &&
    info.internalFormat === 0x8c3a &&
    /^[a-f0-9]{64}$/.test(info.sha256 ?? "")
  ) ok("committed ambient asset is a cmgen-style 256² R11F_G11F_B10F cubemap with six faces + roughness mips");
  else fail(`ambient KTX is missing or not a real prefiltered cubemap: ${JSON.stringify(info)}`);

  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ibl-provision-test-"));
  try {
    const projectDir = path.join(tmp, "fleet-ambient-native");
    const staged = fleetbuild.provisionIblAssets(ambientSpec, { briefsDir: path.join(ROOT, "briefs"), projectDir });
    const copied = ambientKtxRel ? path.join(projectDir, "app/src/main/assets", ambientKtxRel) : "";
    const sourceBytes = ambientKtx && fs.existsSync(ambientKtx) ? fs.readFileSync(ambientKtx) : null;
    const copiedBytes = copied && fs.existsSync(copied) ? fs.readFileSync(copied) : null;
    if (staged.ok === true && staged.assets?.length === 1 && sourceBytes && copiedBytes && sourceBytes.equals(copiedBytes))
      ok("fleet stages the corpus KTX byte-identically under the declared APK asset path");
    else fail(`fleet KTX staging failed: ${JSON.stringify(staged)}`);

    const traversalSpec = structuredClone(ambientSpec);
    traversalSpec.scenes[0].lighting.params.ktxAssetPath = "../escape.ktx";
    const traversal = fleetbuild.provisionIblAssets(traversalSpec, { briefsDir: path.join(ROOT, "briefs"), projectDir: path.join(tmp, "bad-project") });
    if (traversal.ok === false && /safe relative.*\.ktx/i.test(traversal.errors?.join(" ") ?? "") && !fs.existsSync(path.join(tmp, "bad-project/app/src/main/escape.ktx")))
      ok("IBL provisioning rejects traversal instead of writing outside app assets");
    else fail(`IBL traversal did not fail closed: ${JSON.stringify(traversal)}`);

    const fakeDir = path.join(tmp, "fake-briefs");
    fs.mkdirSync(path.join(fakeDir, "ibl"), { recursive: true });
    const fake = Buffer.from(fs.readFileSync(ambientKtx).subarray(0, 64));
    fake.writeUInt32LE(0, 60); // valid cmgen header, but no key/value or image payload follows
    fs.writeFileSync(path.join(fakeDir, "ibl", "studio.ktx"), fake);
    const fakeResult = fleetbuild.provisionIblAssets(ambientSpec, { briefsDir: fakeDir, projectDir: path.join(tmp, "fake-project") });
    if (fakeResult.ok === false && /payload|truncated|imageSize/i.test(fakeResult.errors?.join(" ") ?? ""))
      ok("a metadata-only KTX cannot spoof six baked faces + a roughness mip chain");
    else fail(`metadata-only KTX passed provisioning: ${JSON.stringify(fakeResult)}`);

    const malformedMetadata = Buffer.from(fs.readFileSync(ambientKtx));
    malformedMetadata.writeUInt32LE(0xffffffff, 64); // first keyAndValueByteSize exceeds the declared 320-byte metadata block
    const malformedMetadataPath = path.join(tmp, "malformed-metadata.ktx");
    fs.writeFileSync(malformedMetadataPath, malformedMetadata);
    const malformedMetadataInfo = fleetbuild.inspectIblKtx(malformedMetadataPath);
    if (malformedMetadataInfo.ok === false && /metadata|key.?value|entry/i.test(malformedMetadataInfo.error ?? ""))
      ok("KTX validation walks metadata entries instead of trusting only the outer byte count");
    else fail(`malformed KTX metadata entry passed: ${JSON.stringify(malformedMetadataInfo)}`);

    const hostile = Buffer.alloc(72);
    fs.readFileSync(ambientKtx).subarray(0, 64).copy(hostile);
    hostile.writeUInt32LE(2, 36);
    hostile.writeUInt32LE(2, 40);
    hostile.writeUInt32LE(6, 52);
    hostile.writeUInt32LE(2, 56);
    hostile.writeUInt32LE(0, 60);
    hostile.writeUInt32LE(0xfffffffd, 64);
    hostile.writeUInt32LE(0xfffffffd, 68);
    const hostilePath = path.join(tmp, "hostile-overflow.ktx");
    fs.writeFileSync(hostilePath, hostile);
    const hostileInfo = fleetbuild.inspectIblKtx(hostilePath);
    if (hostileInfo.ok === false && /payload|imageSize|size/i.test(hostileInfo.error ?? ""))
      ok("supported-format KTX payload sizing rejects uint32 values before padding arithmetic");
    else fail(`supported-format KTX arithmetic spoof passed: ${JSON.stringify(hostileInfo)}`);

    const generic = Buffer.alloc(64 + (4 + 24) * 2);
    hostile.copy(generic, 0, 0, 64);
    generic.writeUInt32LE(0xdeadbeef, 16);
    generic.writeUInt32LE(0xdeadbeef, 28);
    generic.writeUInt32LE(0x1907, 32);
    generic.writeUInt32LE(1, 64);
    generic.fill(0xaa, 68, 92);
    generic.writeUInt32LE(1, 92);
    generic.fill(0xbb, 96, 120);
    const genericPath = path.join(tmp, "generic-format.ktx");
    fs.writeFileSync(genericPath, generic);
    const genericInfo = fleetbuild.inspectIblKtx(genericPath);
    if (genericInfo.ok === false && /format|R11F|unsupported/i.test(genericInfo.error ?? ""))
      ok("IBL validation accepts only the cmgen R11F_G11F_B10F payload shape it can prove");
    else fail(`unsupported generic KTX format passed: ${JSON.stringify(genericInfo)}`);

    const hugeDimensions = Buffer.alloc(120);
    const sourceHeader = fs.readFileSync(ambientKtx).subarray(0, 64);
    sourceHeader.copy(hugeDimensions);
    hugeDimensions.writeUInt32LE(0x80000000, 36);
    hugeDimensions.writeUInt32LE(0x80000000, 40);
    hugeDimensions.writeUInt32LE(2, 56);
    hugeDimensions.writeUInt32LE(4, 64);
    hugeDimensions.writeUInt32LE(4, 92);
    const hugeDimensionsPath = path.join(tmp, "huge-dimensions.ktx");
    fs.writeFileSync(hugeDimensionsPath, hugeDimensions);
    const hugeDimensionsInfo = fleetbuild.inspectIblKtx(hugeDimensionsPath);
    if (hugeDimensionsInfo.ok === false && /dimension|8192|power-of-two|size/i.test(hugeDimensionsInfo.error ?? ""))
      ok("KTX validation caps dimensions before mip arithmetic can wrap signed integers");
    else fail(`huge-dimension KTX passed: ${JSON.stringify(hugeDimensionsInfo)}`);

    const oversizedPath = path.join(tmp, "oversized.ktx");
    fs.writeFileSync(oversizedPath, sourceHeader);
    fs.truncateSync(oversizedPath, 256 * 1024 * 1024 + 1);
    const oversizedInfo = fleetbuild.inspectIblKtx(oversizedPath);
    if (oversizedInfo.ok === false && /limit|exceeds|size/i.test(oversizedInfo.error ?? ""))
      ok("KTX validation rejects oversized files before synchronous read/hash work");
    else fail(`oversized KTX did not hit resource cap: ${JSON.stringify(oversizedInfo)}`);

    const spacedSpec = structuredClone(ambientSpec);
    spacedSpec.scenes[0].lighting.params.ktxAssetPath = ` ${ambientKtxRel} `;
    const spaced = fleetbuild.provisionIblAssets(spacedSpec, { briefsDir: path.join(ROOT, "briefs"), projectDir: path.join(tmp, "spaced-project") });
    if (spaced.ok === false && /canonical|whitespace|safe relative/i.test(spaced.errors?.join(" ") ?? ""))
      ok("IBL provisioning rejects a path whose staged spelling would differ from generated runtime Kotlin");
    else fail(`whitespace-mismatched KTX path passed: ${JSON.stringify(spaced)}`);

    const interpolationDir = path.join(tmp, "interpolation-briefs");
    fs.mkdirSync(path.join(interpolationDir, "ibl"), { recursive: true });
    fs.copyFileSync(ambientKtx, path.join(interpolationDir, "ibl", "$foo.ktx"));
    const interpolationSpec = structuredClone(ambientSpec);
    interpolationSpec.scenes[0].lighting.params.ktxAssetPath = "ibl/$foo.ktx";
    const interpolation = fleetbuild.provisionIblAssets(interpolationSpec, { briefsDir: interpolationDir, projectDir: path.join(tmp, "interpolation-project") });
    if (interpolation.ok === false && /safe|Kotlin|asset path/i.test(interpolation.errors?.join(" ") ?? ""))
      ok("IBL provisioning rejects Kotlin interpolation characters in an otherwise valid asset path");
    else fail(`Kotlin-interpolated KTX path provisioned: ${JSON.stringify(interpolation)}`);

    const outside = path.join(tmp, "outside-assets");
    const linkedProject = path.join(tmp, "linked-project");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(linkedProject, "app/src/main/assets"), { recursive: true });
    fs.symlinkSync(outside, path.join(linkedProject, "app/src/main/assets/ibl"), "dir");
    const linked = fleetbuild.provisionIblAssets(ambientSpec, { briefsDir: path.join(ROOT, "briefs"), projectDir: linkedProject });
    if (linked.ok === false && /symbolic link|symlink|safe/i.test(linked.errors?.join(" ") ?? "") && !fs.existsSync(path.join(outside, "studio.ktx")))
      ok("IBL provisioning rejects a symlinked destination parent instead of escaping app assets");
    else fail(`symlinked IBL destination escaped or passed: ${JSON.stringify(linked)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const fleetSource = fs.readFileSync(path.join(ROOT, "src", "fleetbuild.ts"), "utf8");
const provisionCallAt = fleetSource.indexOf("const iblAssets = provisionIblAssets(spec");
const ledgerCallAt = fleetSource.indexOf("const steps = buildLedger(spec", provisionCallAt);
if (provisionCallAt >= 0 && ledgerCallAt > provisionCallAt)
  ok("fleet_build invokes IBL validation/staging before code generation and build");
else fail("fleet_build call site no longer provisions IBL assets before its compile ledger");

const ambientIblStep = buildLedger(ambientSpec, "/tmp/fleet-ambient-native").find((s) => s.tool === "generate_ibl_kotlin");
if (
  ambientIblStep?.args?.ktxAssetPath === "ibl/studio.ktx" &&
  ambientIblStep?.args?.mode === "local" &&
  ambientIblStep?.args?.intensityExponent === 8
) ok("ambient compile ledger carries the exact local IBL asset + exponent contract");
else fail(`ambient compile ledger lost IBL params: ${JSON.stringify(ambientIblStep)}`);

const compositionOf = (spec) => generateWiring(spec).find((f) => f.path.endsWith("/SceneComposition.kt"))?.content ?? "";
const localComposition = compositionOf(ambientSpec);
const propsAt = localComposition.indexOf("val props = SceneLayout.place");
const localAt = localComposition.indexOf("SceneIBL.applyLocal(root, props)");
if (propsAt >= 0 && localAt > propsAt && !localComposition.includes("SceneIBL.applyStage(root)"))
  ok("mode=local wires the IBL receiver after procedural props exist, with no unresolved applyStage call");
else fail(`local IBL wiring is invalid or ordered before receivers: ${localComposition}`);

const stageSpec = structuredClone(ambientSpec);
stageSpec.scenes[0].lighting.params = { ...(stageSpec.scenes[0].lighting.params ?? {}), mode: "stage" };
const stageComposition = compositionOf(stageSpec);
if (stageComposition.includes("SceneIBL.applyStage(root)") && !stageComposition.includes("SceneIBL.applyLocal(root, props)"))
  ok("mode=stage keeps the existing scene-wide IBL wiring path");
else fail(`stage IBL wiring regressed: ${stageComposition}`);

const bothSpec = structuredClone(ambientSpec);
bothSpec.scenes[0].lighting.params = { ...(bothSpec.scenes[0].lighting.params ?? {}), mode: "both" };
const bothComposition = compositionOf(bothSpec);
if (bothComposition.includes("SceneIBL.applyStage(root)") && bothComposition.indexOf("SceneIBL.applyLocal(root, props)") > bothComposition.indexOf("val props = SceneLayout.place"))
  ok("mode=both applies stage IBL and then attaches local receivers");
else fail(`both-mode IBL wiring is incomplete: ${bothComposition}`);

const modelIblSpec = structuredClone(ambientSpec);
modelIblSpec.objects[0].source = "model";
modelIblSpec.objects[0].dataBindRef = "catalog";
modelIblSpec.data = [{ id: "catalog", source: "json", asset: "data/items.json", bindsTo: [modelIblSpec.objects[0].id] }];
const modelIblComposition = compositionOf(appSpecSchema.parse(modelIblSpec));
const dataBindingGeneratorSource = fs.readFileSync(path.join(ROOT, "src", "databinding.ts"), "utf8");
const fallbackCallbackCount = dataBindingGeneratorSource.match(/onModelLoaded\?\.invoke\(placeholder\)/g)?.length ?? 0;
if (/onModelLoaded\s*=\s*\{[^}]*SceneIBL\.applyLocal\(root, listOf\(it\)\)/s.test(modelIblComposition) && !modelIblComposition.includes("SceneIBL.applyLocal(root, cards)") && fallbackCallbackCount >= 2)
  ok("async model IBL targets loaded geometry and the generator invokes the same receiver callback for missing/failed-model placeholders");
else fail(`async model local-IBL receiver wiring is wrong: ${modelIblComposition}`);

const templateAmbientSpec = appSpecSchema.parse(buildTemplateDraft("ambient", {
  appName: "TemplateAmbient",
  packageName: "com.example.templateambient",
  brief: "template ambient regression",
}));
const templateAmbientComposition = compositionOf(templateAmbientSpec);
if (templateAmbientSpec.layouts.length === 1 && templateAmbientComposition.includes("val props = SceneLayout.place") && templateAmbientComposition.includes("SceneIBL.applyLocal(root, props)"))
  ok("ambient template places a real procedural receiver before applying its declared local IBL");
else fail(`ambient template still emits no IBL receiver: ${templateAmbientComposition}`);

const physicsDataIblSpec = structuredClone(modelIblSpec);
physicsDataIblSpec.objects[0].source = "quad";
physicsDataIblSpec.scenes[0].physics = { gravity: [0, -9.81, 0] };
physicsDataIblSpec.objects[0].body = { mode: "dynamic", shape: "sphere", dims: [0.2], mass: 1 };
const physicsDataIblComposition = compositionOf(appSpecSchema.parse(physicsDataIblSpec));
if (/SceneIBL\.applyLocal\(root, .*bodies/s.test(physicsDataIblComposition))
  ok("local IBL includes physics bodies even when the scene also has data-backed cards");
else fail(`data+physics local-IBL bodies are unlit: ${physicsDataIblComposition}`);

const conflictingIblSpec = structuredClone(ambientSpec);
const secondIblScene = structuredClone(conflictingIblSpec.scenes[0]);
secondIblScene.id = "second";
secondIblScene.lighting.params.mode = "stage";
conflictingIblSpec.scenes.push(secondIblScene);
const conflictingIbl = appSpecSchema.safeParse(conflictingIblSpec);
if (!conflictingIbl.success && /IBL|lighting|mode|configuration/i.test(conflictingIbl.error.issues.map((issue) => issue.message).join(" ")))
  ok("AppSpec rejects contradictory multi-scene IBL configs that would overwrite SceneIBL.kt");
else fail(`contradictory multi-scene IBL config did not fail closed: ${JSON.stringify(conflictingIbl)}`);

const invalidIblCases = [
  { label: "missing asset path", params: { mode: "local", intensityExponent: 8 } },
  { label: "null asset path", params: { ktxAssetPath: null, mode: "local", intensityExponent: 8 } },
  { label: "Kotlin interpolation path", params: { ktxAssetPath: "ibl/$foo.ktx", mode: "local", intensityExponent: 8 } },
  { label: "invalid mode", params: { ktxAssetPath: "ibl/studio.ktx", mode: "bogus", intensityExponent: 8 } },
  { label: "null mode", params: { ktxAssetPath: "ibl/studio.ktx", mode: null, intensityExponent: 8 } },
  { label: "out-of-range exponent", params: { ktxAssetPath: "ibl/studio.ktx", mode: "local", intensityExponent: 25 } },
  { label: "null exponent", params: { ktxAssetPath: "ibl/studio.ktx", mode: "local", intensityExponent: null } },
];
const invalidIblAccepted = invalidIblCases.filter(({ params }) => {
  const candidate = structuredClone(ambientSpec);
  candidate.scenes[0].lighting.params = params;
  return appSpecSchema.safeParse(candidate).success;
});
if (invalidIblAccepted.length === 0 && !iblKtxAssetPathSchema.safeParse("ibl/$foo.ktx").success)
  ok("AppSpec and the reusable generator path schema reject missing, unsafe, null, invalid, and out-of-range IBL parameters");
else fail(`invalid IBL params passed AppSpec validation: ${invalidIblAccepted.map((entry) => entry.label).join(", ")}`);

const duplicateSceneLayoutSpec = structuredClone(ambientSpec);
duplicateSceneLayoutSpec.layouts.push({ id: "badges", sceneId: "corner", pattern: "grid", count: 2, params: { columns: 2 } });
duplicateSceneLayoutSpec.objects.push({ id: "badges", sceneId: "corner", source: "primitive", layoutRef: "badges" });
const duplicateSceneLayout = appSpecSchema.safeParse(duplicateSceneLayoutSpec);
if (!duplicateSceneLayout.success && /one layout per scene|multiple layouts|layout/i.test(duplicateSceneLayout.error.issues.map((issue) => issue.message).join(" ")))
  ok("AppSpec fails closed on multiple layouts in one scene instead of silently compiling only the first");
else fail(`same-scene multiple layouts still pass silently: ${JSON.stringify(duplicateSceneLayout)}`);

const sharedIblSpec = structuredClone(ambientSpec);
const sharedIblScene = structuredClone(sharedIblSpec.scenes[0]);
sharedIblScene.id = "second";
sharedIblSpec.scenes.push(sharedIblScene);
const sharedIblParsed = appSpecSchema.parse(sharedIblSpec);
const sharedIblSteps = buildLedger(sharedIblParsed, "/tmp/fleet-ambient-native").filter((step) => step.tool === "generate_ibl_kotlin");
if (sharedIblSteps.length === 1) ok("identical multi-scene IBL config generates SceneIBL.kt exactly once");
else fail(`identical multi-scene IBL generated ${sharedIblSteps.length} colliding files`);

const multiDataLessSpec = structuredClone(sharedIblSpec);
multiDataLessSpec.layouts.push({
  id: "second-heroes",
  sceneId: "second",
  pattern: "arc",
  count: 2,
  params: { radius: 2, arcSpanDeg: 20, centerY: 1.4 },
});
multiDataLessSpec.objects.push({
  id: "second-polished-heroes",
  sceneId: "second",
  source: "primitive",
  material: { mode: "pbr", metallic: 0.8, roughness: 0.3 },
  layoutRef: "second-heroes",
});
const multiDataLessComposition = compositionOf(appSpecSchema.parse(multiDataLessSpec));
const proceduralPlacements = multiDataLessComposition.match(/SceneLayout\.place\(c, \d+, .*makeProp\(i\)/g) ?? [];
const multiLayoutSteps = buildLedger(appSpecSchema.parse(multiDataLessSpec), "/tmp/fleet-ambient-native").filter((step) => step.tool === "generate_layout_kotlin");
if (
  proceduralPlacements.length === 2 &&
  multiLayoutSteps.length === 1 &&
  multiDataLessComposition.includes("SceneLayout.radius = 2.2f") &&
  multiDataLessComposition.includes("SceneLayout.arcSpanDeg = 32f") &&
  multiDataLessComposition.includes("SceneLayout.radius = 2f") &&
  multiDataLessComposition.includes("SceneLayout.arcSpanDeg = 20f") &&
  !multiDataLessComposition.includes("emptyList().size") &&
  !multiDataLessComposition.includes("SceneDataBinding.makeCard(emptyList()")
)
  ok("multi-scene data-less layouts place procedural props without an unresolved SceneDataBinding dependency");
else fail(`multi-scene data-less layout wiring/collision is invalid: ${JSON.stringify({ steps: multiLayoutSteps.length, composition: multiDataLessComposition })}`);

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

  const missionSpec = JSON.parse(fs.readFileSync(path.join(ROOT, "briefs", "swanmissiontable.json"), "utf8")).spec;
  const missionRoute = fleetbuild.deriveVerificationRoute(missionSpec);
  const missionPanels = fleetbuild.generatedPanels(missionSpec, "com.fleet.swanmissiontable");
  const missionRow = rows.find((row) => row.id === "swanmissiontable");
  const missionExpectation = fleetbuild.deriveVisualExpectation(missionSpec, missionRoute?.stageEyeClaim);
  const missionPalette = missionExpectation?.authoredColors ?? [];
  const distinctMissionColors = new Set(missionPalette.map((entry) => JSON.stringify(entry.color))).size;
  const missionKotlin = generateWiring(appSpecSchema.parse(missionSpec))
    .find((file) => file.path.endsWith("/MissionTableExperience.kt"))?.content ?? "";
  const generatedRgb = [...missionKotlin.matchAll(/Color4\((\d+(?:\.\d+)?)f, (\d+(?:\.\d+)?)f, (\d+(?:\.\d+)?)f, 1f\)/g)]
    .map((match) => match.slice(1, 4).map(Number));
  const paletteMatchesRuntime = missionPalette.every((entry) =>
    Array.isArray(entry.color) && entry.color.length === 3 && entry.color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1) &&
    generatedRgb.some((generated) => generated.every((channel, index) => Math.abs(channel - entry.color[index]) < 1e-6)));
  if (
    missionRoute?.mode === "stage-eye" &&
    target(missionRoute?.stageEyeClaim) === "missionDeck" &&
    missionRoute?.panelTargetIds?.length === 0 &&
    missionPanels?.activities?.length === 0 &&
    missionPanels?.mappings?.length === 0 &&
    fleetbuild.structuralPanelCount(missionSpec) === 0 &&
    missionRow?.expectedPanels === 0
  )
    ok("scene-attached mission panel remains stage geometry and never becomes HudPanelActivity/panelReady work");
  else fail(`scene attachment routing leaked into OS-panel evidence: ${JSON.stringify({ missionRoute, missionPanels, missionRow })}`);

  if (missionPalette.length >= 4 && distinctMissionColors >= 4 && paletteMatchesRuntime)
    ok(`mission eye expectation carries ${missionPalette.length} authored colors that match the generated diorama`);
  else fail(`mission passthrough eye lacks a distinct runtime-matched authored palette: ${JSON.stringify({ missionPalette, distinctMissionColors, generatedRgb })}`);
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
