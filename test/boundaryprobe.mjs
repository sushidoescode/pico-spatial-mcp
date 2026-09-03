import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appSpecSchema } from "../dist/appspec.js";
import { generateWiring } from "../dist/assemble.js";
import {
  BOUNDARY_MATRIX_DIFFERENCE_ALLOWLIST,
  BOUNDARY_MATRIX_IDS,
  buildBoundaryMatrix,
} from "../dist/boundarymatrix.js";
import { generateBoundaryLabFiles } from "../dist/boundaryprobe.js";
import { buildLedger } from "../dist/compiler.js";
import { generateContainerAppFiles } from "../dist/containers.js";
import { canonicalIdentity } from "../dist/runreceiptidentity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const canonicalPath = path.join(repoRoot, "briefs", "boundarylabmixed.json");
const expectedHashes = new Map([
  ["boundarylabmixed", { sha256: "b6443a1a679845613c2d6b974f7b1546deafbcda600c6ee460109615631c49ca", bytes: 1243 }],
  ["boundarylabmanifestfull", { sha256: "8cd9f0e6b2f5233e224e2d62c1ac706f5a8d7bf6ffc321a2017945cbeed46825", bytes: 1256 }],
  ["boundarylabdynamicfull", { sha256: "f8ffde4140793c953ef73bce6711a41207a4704ad9f50034b4eafa8dfbfca384", bytes: 1304 }],
]);
const scenePayloadHash = "ebee7e366e80b62c9ae8f44bfc07e8599d38b389b93cd1a0f3f2feff0e3c630e";
const expectedIds = ["boundarylabmixed", "boundarylabmanifestfull", "boundarylabdynamicfull"];

const clone = (value) => structuredClone(value);
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function readCanonical() {
  return JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
}

function row(matrix, id) {
  const found = matrix.find((candidate) => candidate.id === id);
  assert.ok(found, `missing matrix row ${id}`);
  return found;
}

function diffPaths(left, right, prefix = "") {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [prefix || "/"];
    if (left.length !== right.length) return [prefix || "/"];
    return left.flatMap((value, index) => diffPaths(value, right[index], `${prefix}/${index}`));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return [`${prefix}/${key}`];
      return diffPaths(left[key], right[key], `${prefix}/${key}`);
    });
  }
  return [prefix || "/"];
}

test("Boundary Lab materializes stable fleet identities, exact effective hashes, and one shared scene payload", () => {
  const canonical = readCanonical();
  const parsed = appSpecSchema.parse(canonical.spec);
  assert.equal(parsed.boundaryLab.variant, "manifest_mixed");
  assert.deepEqual(canonical.expected, {
    scenes: 1,
    layouts: 0,
    objects: 0,
    data: 0,
    interactions: 0,
    panels: 0,
    verifiableNowMin: 1,
    swanMin: 0,
  });
  assert.equal(parsed.verificationPlan.length, 1);
  assert.deepEqual(parsed.verificationPlan[0], {
    claim: "the route-specific Boundary Lab sentinel and the start of the high-contrast forward gate corridor are rendered in the forward field of view",
    method: "capture",
    capabilityClass: "C0_emulator",
    targetRef: "boundaryLab",
    forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -2.2 },
  });

  const matrix = buildBoundaryMatrix(canonical);
  const { variant: _variant, ...sharedBoundaryLab } = parsed.boundaryLab;
  const expectedScenePayload = {
    scenes: parsed.scenes,
    layouts: parsed.layouts,
    objects: parsed.objects,
    data: parsed.data,
    interactions: parsed.interactions,
    panels: parsed.panels,
    navigation: parsed.navigation,
    verificationPlan: parsed.verificationPlan,
    headsetLayer: parsed.headsetLayer,
    boundaryLab: sharedBoundaryLab,
  };
  assert.deepEqual(BOUNDARY_MATRIX_IDS, expectedIds);
  assert.deepEqual(matrix.map((candidate) => candidate.id), expectedIds);
  assert.deepEqual(matrix.map((candidate) => candidate.packageName), expectedIds.map((id) => `com.fleet.${id}`));
  assert.deepEqual(matrix.map((candidate) => candidate.spec.meta.appName), expectedIds.map((id) => `Fleet${id[0].toUpperCase()}${id.slice(1)}`));
  assert.deepEqual(matrix.map((candidate) => candidate.variant), ["manifest_mixed", "manifest_full", "dynamic_full"]);
  assert.deepEqual(matrix.map((candidate) => candidate.spec.meta.stageStyle), ["1", "3", "1"]);

  for (const candidate of matrix) {
    assert.deepEqual(candidate.effectiveSpecIdentity, {
      algorithm: "sha256",
      ...expectedHashes.get(candidate.id),
    });
    assert.equal(candidate.scenePayloadIdentity.sha256, scenePayloadHash);
    assert.deepEqual(candidate.scenePayloadIdentity, canonicalIdentity(expectedScenePayload));
    assert.deepEqual(candidate.entry, {
      id: candidate.id,
      brief: canonical.brief,
      spec: candidate.spec,
      expected: canonical.expected,
    });
    assert.deepEqual(appSpecSchema.parse(candidate.spec), candidate.spec);
  }

  assert.deepEqual(row(matrix, "boundarylabmixed").spec.meta.secondaryContainers, []);
  assert.deepEqual(row(matrix, "boundarylabmanifestfull").spec.meta.secondaryContainers, []);
  assert.deepEqual(row(matrix, "boundarylabdynamicfull").spec.meta.secondaryContainers, [
    { kind: "stage", id: "dynamic-full", style: "Full" },
  ]);
});

test("Boundary Lab variants differ only through the reviewed matrix allowlist", () => {
  const matrix = buildBoundaryMatrix(readCanonical());
  assert.deepEqual(BOUNDARY_MATRIX_DIFFERENCE_ALLOWLIST, [
    "/id",
    "/spec/boundaryLab/variant",
    "/spec/meta/appName",
    "/spec/meta/packageName",
    "/spec/meta/secondaryContainers",
    "/spec/meta/stageStyle",
  ]);

  const mixed = row(matrix, "boundarylabmixed").entry;
  const full = row(matrix, "boundarylabmanifestfull").entry;
  const dynamic = row(matrix, "boundarylabdynamicfull").entry;
  assert.deepEqual(diffPaths(mixed, full).sort(), [
    "/id",
    "/spec/boundaryLab/variant",
    "/spec/meta/appName",
    "/spec/meta/packageName",
    "/spec/meta/stageStyle",
  ]);
  const dynamicDiffs = diffPaths(mixed, dynamic).sort();
  assert.deepEqual(dynamicDiffs, BOUNDARY_MATRIX_DIFFERENCE_ALLOWLIST.filter((candidate) => candidate !== "/spec/meta/stageStyle"));
  assert.ok(dynamicDiffs.every((candidate) => BOUNDARY_MATRIX_DIFFERENCE_ALLOWLIST.includes(candidate)));

  const contentKeys = ["scenes", "layouts", "objects", "data", "interactions", "panels", "navigation", "verificationPlan", "headsetLayer"];
  for (const key of contentKeys) {
    assert.deepEqual(full.spec[key], mixed.spec[key], `${key} drifted in manifest Full`);
    assert.deepEqual(dynamic.spec[key], mixed.spec[key], `${key} drifted in dynamic Full`);
  }
});

test("Boundary Lab schema rejects contradictory routes, styles, containers, gates, axes, and sentinel text", () => {
  const matrix = buildBoundaryMatrix(readCanonical());
  const mixed = row(matrix, "boundarylabmixed").spec;
  const full = row(matrix, "boundarylabmanifestfull").spec;
  const dynamic = row(matrix, "boundarylabdynamicfull").spec;

  const rejected = [
    Object.assign(clone(mixed), { meta: { ...mixed.meta, stageStyle: "3" } }),
    Object.assign(clone(full), { meta: { ...full.meta, stageStyle: "1" } }),
    Object.assign(clone(dynamic), { meta: { ...dynamic.meta, stageStyle: "3" } }),
    Object.assign(clone(dynamic), { meta: { ...dynamic.meta, rootContainer: "windowContainer" } }),
    Object.assign(clone(dynamic), { meta: { ...dynamic.meta, secondaryContainers: [] } }),
    Object.assign(clone(dynamic), { meta: { ...dynamic.meta, secondaryContainers: [{ kind: "stage", id: "wrong", style: "Full" }] } }),
    Object.assign(clone(dynamic), { meta: { ...dynamic.meta, secondaryContainers: [{ kind: "stage", id: "dynamic-full", style: "Mixed" }] } }),
    Object.assign(clone(mixed), { meta: { ...mixed.meta, secondaryContainers: [{ kind: "stage", id: "dynamic-full", style: "Full" }] } }),
    Object.assign(clone(mixed), { boundaryLab: { ...mixed.boundaryLab, gateSequenceM: [1, 2, 4, 8, 16, 64] } }),
    Object.assign(clone(mixed), { boundaryLab: { ...mixed.boundaryLab, requiredTraversalM: 16 } }),
    Object.assign(clone(mixed), { boundaryLab: { ...mixed.boundaryLab, axes: ["forward", "left", "backward", "right"] } }),
    Object.assign(clone(mixed), { boundaryLab: { ...mixed.boundaryLab, sentinels: { ...mixed.boundaryLab.sentinels, dynamicFull: "FULL" } } }),
    Object.assign(clone(mixed), { boundaryLab: { ...mixed.boundaryLab, surprise: true } }),
  ];
  for (const candidate of rejected) assert.equal(appSpecSchema.safeParse(candidate).success, false);
});

test("materialization script accepts an injected writer and never needs the real user store in tests", async () => {
  const script = await import(pathToFileURL(path.join(repoRoot, "scripts", "materialize-boundary-matrix.mjs")));
  const writes = [];
  const result = script.materializeBoundaryMatrix({
    canonicalBriefPath: canonicalPath,
    writeBrief(id, payload) {
      const destination = `/injected-user-store/${id}.json`;
      writes.push({ id, payload, destination });
      return destination;
    },
  });
  assert.deepEqual(writes.map((write) => write.id), expectedIds);
  assert.deepEqual(writes.map((write) => write.destination), expectedIds.map((id) => `/injected-user-store/${id}.json`));
  assert.deepEqual(result.map((item) => item.path), writes.map((write) => write.destination));
  assert.deepEqual(writes.map((write) => write.payload), buildBoundaryMatrix(readCanonical()).map((candidate) => candidate.entry));
});

test("Boundary Lab codegen emits a batched off-main enclosure and legible four-axis metre gates", () => {
  const matrix = buildBoundaryMatrix(readCanonical());
  const enclosureBodies = [];
  for (const candidate of matrix) {
    const files = generateBoundaryLabFiles(candidate.spec, candidate.packageName);
    const world = files.find((file) => file.path.endsWith("/content/BoundaryLabScene.kt"))?.content;
    assert.ok(world);
    assert.match(world, /CoroutineScope\(SupervisorJob\(\) \+ Dispatchers\.Default\)/);
    assert.match(world, /check\(Looper\.myLooper\(\) != Looper\.getMainLooper\(\)\)/);
    assert.match(world, /withContext\(Dispatchers\.Main\.immediate\)/);
    assert.match(world, /chunked\(ATTACH_BATCH_SIZE\)/);
    assert.match(world, /yield\(\)/);
    assert.match(world, /MeshResource\.createBox\(Vector3\(1f, 1f, 1f\)\)/);
    assert.match(world, /AtomicReference<ResourceOwner>\(ResourceOwner\.BUILD\)/);
    assert.match(world, /fun adoptBySession\(\): Boolean = owner\.compareAndSet\(ResourceOwner\.BUILD, ResourceOwner\.SESSION\)/);
    assert.match(world, /fun closeByBuild\(\) = closeIfOwned\(ResourceOwner\.BUILD\)/);
    assert.match(world, /fun closeBySession\(\) = closeIfOwned\(ResourceOwner\.SESSION\)/);
    assert.match(world, /if \(!owner\.compareAndSet\(expected, ResourceOwner\.CLOSED\)\) return/);
    assert.match(world, /resources\.adoptBySession\(\)/);
    assert.match(world, /resources\.closeByBuild\(\)/);
    assert.match(world, /resources\.closeBySession\(\)/);
    assert.match(world, /Sparse wire\/grid geometry preserves passthrough pixels/);
    assert.match(world, /val lineOrdinal = \(index \+ 1\)\.toString\(\)/);
    assert.match(world, /val cornerOrdinal = \(xIndex \* edges\.size \+ zIndex \+ 1\)\.toString\(\)/);
    assert.doesNotMatch(
      world,
      /HIGH_CONTRAST_ENCLOSURE \+ "_[^"]*" \+ (?:offset|x|z)(?:\s|,|\+)/,
      "Entity.setName rejects signed/decimal coordinate spellings; names must use safe ordinals",
    );
    assert.match(world, /GATES\.forEachIndexed \{ index, gateSpec -> add \{ gate\(root, resources, gateSpec, index\) \} \}/);
    assert.doesNotMatch(world, /GATES\.forEachIndexed \{ index, gate -> add \{ gate\(root, resources, gate, index\) \} \}/);
    assert.doesNotMatch(world, /Vector3\(80f, 0\.06f, 80f\)/);
    assert.match(world, /IdentityHashMap<Entity, Session>/);
    assert.match(world, /ownedChildren\.asReversed\(\)/);
    assert.match(world, /root\.removeChild\(entity\)/);
    assert.match(world, /entity\.destroy\(true\)/);
    assert.match(world, /NonCancellable \+ Dispatchers\.Default/);
    assert.ok(world.indexOf("ownedChildren.asReversed()") < world.lastIndexOf("resources.closeBySession()"));
    assert.match(world, /Vector3\(0f, 6f, offset\.toFloat\(\)\)/);
    assert.match(world, /Vector3\(offset\.toFloat\(\), 6f, 0f\)/);
    for (const axis of ["FORWARD", "BACKWARD", "LEFT", "RIGHT"]) assert.match(world, new RegExp(`Axis\\.${axis}`));
    for (const distance of [1, 2, 4, 8, 16, 32]) assert.match(world, new RegExp(`Gate\\(${distance}f,`));
    assert.match(world, /HIGH_CONTRAST_ENCLOSURE/);
    assert.match(world, /Text\(sentinel/);
    assert.match(world, /BoundaryGatePanel\(gate, sentinel\)/);
    assert.match(world, /private fun BoundaryGatePanel\(gate: BoundaryLabScene\.Gate, sentinel: String\)/);
    assert.match(world, /Text\(sentinel, style = type\.bodyLarge/);
    assert.match(world, /gate\.distanceM\.toInt\(\)\.toString\(\) \+ " m · " \+ gate\.axis\.label/);
    assert.match(world, /MANIFEST MIXED ROOT/);
    assert.match(world, /MANIFEST FULL/);
    assert.match(world, /DYNAMIC FULL/);
    enclosureBodies.push(world.slice(world.indexOf("    private suspend fun enclosure"), world.indexOf("    private fun gate")));
  }
  assert.equal(new Set(enclosureBodies).size, 1, "matched rows must emit byte-identical enclosure geometry");
});

test("F2 owns an authenticated idempotent direct-open route while release has no receiver, logs, or open", () => {
  const dynamic = row(buildBoundaryMatrix(readCanonical()), "boundarylabdynamicfull");
  const files = generateBoundaryLabFiles(dynamic.spec, dynamic.packageName);
  const bySuffix = (suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
  const root = bySuffix("/content/BoundaryProbeRoot.kt");
  const debug = bySuffix("/src/debug/java/com/fleet/boundarylabdynamicfull/agent/BoundaryProbe.kt");
  const receiver = bySuffix("/src/debug/java/com/fleet/boundarylabdynamicfull/agent/BoundaryProbeReceiver.kt");
  const release = bySuffix("/src/release/java/com/fleet/boundarylabdynamicfull/agent/BoundaryProbe.kt");
  const manifest = bySuffix("/src/debug/AndroidManifest.xml");
  assert.ok(root && debug && receiver && release && manifest);

  assert.match(manifest, /android:name="\.agent\.BoundaryProbeReceiver"/);
  assert.match(manifest, /android:exported="true"/);
  assert.match(manifest, /android:permission="android\.permission\.DUMP"/);
  assert.doesNotMatch(manifest, /intent-filter/);
  assert.match(receiver, /intent\.component\?\.className/);
  assert.match(receiver, /BoundaryProbe\.acceptExplicitCommand\(intent/);
  assert.match(receiver, /val accepted = BoundaryProbe\.acceptExplicitCommand/);
  assert.match(receiver, /if \(isOrderedBroadcast\)/);
  assert.match(receiver, /Activity\.RESULT_OK/);
  assert.match(receiver, /Activity\.RESULT_CANCELED/);
  assert.match(receiver, /setResultData\(if \(accepted\) "accepted" else "rejected"\)/);

  assert.match(debug, /PICO_BOUNDARY_PROBE_V1 /);
  assert.match(debug, /const val RECEIVER_CLASS = "com\.fleet\.boundarylabdynamicfull\.agent\.BoundaryProbeReceiver"/);
  assert.match(debug, /fun bindLaunchIntent\(intent: Intent\)/);
  assert.match(debug, /intent\.getStringExtra\(EXTRA_SESSION_ID\)/);
  assert.match(debug, /intent\.getStringExtra\(EXTRA_CAPABILITY\)/);
  assert.match(debug, /intent\.getLongExtra\(EXTRA_GENERATION/);
  assert.match(debug, /if \(boundSessionId != null\) return/);
  assert.match(debug, /activeGeneration = null/);
  assert.match(debug, /mutableStateOf<OpenRequest\?>\(null\)/);
  assert.match(debug, /mutableStateOf<CloseRequest\?>\(null\)/);
  assert.match(debug, /enum class RouteState \{ IDLE, OPEN_PENDING, OPENING, OPEN, CLOSE_PENDING, CLOSING \}/);
  assert.match(debug, /enum class ObservationOwner \{ MANIFEST_ROOT, DYNAMIC_FULL \}/);
  assert.match(debug, /fun claimDynamicObservationOwner\(\): Boolean/);
  assert.match(debug, /fun releaseDynamicObservationOwner\(\)/);
  assert.match(debug, /if \(observationOwner == ObservationOwner\.MANIFEST_ROOT\) emit\("lifecycle"/);
  assert.match(debug, /if \(observationOwner == ObservationOwner\.MANIFEST_ROOT\) emit\("focus"/);
  assert.match(debug, /if \(observationOwner != ObservationOwner\.DYNAMIC_FULL\) return/);
  assert.match(debug, /dynamicStageActive/);
  assert.match(debug, /returnedCycle/);
  assert.match(debug, /stageOpenReturnedGeneration/);
  const dynamicClaimBlock = debug.slice(debug.indexOf("fun claimDynamicObservationOwner"), debug.indexOf("fun releaseDynamicObservationOwner"));
  assert.match(dynamicClaimBlock, /if \(routeState == RouteState\.OPENING\) routeState = RouteState\.OPEN/);
  assert.match(dynamicClaimBlock, /dynamicStageActive = true/);
  assert.doesNotMatch(dynamicClaimBlock, /stage_open_returned/);
  const dynamicReleaseBlock = debug.slice(debug.indexOf("fun releaseDynamicObservationOwner"), debug.indexOf("fun claimOpen"));
  assert.match(dynamicReleaseBlock, /dynamicStageActive = false/);
  assert.match(dynamicReleaseBlock, /if \(routeState == RouteState\.OPEN\) returnedCycle = true/);
  const openReturnedBlock = debug.slice(debug.indexOf("fun stageOpenReturned"), debug.indexOf("fun explicitCloseRequested"));
  assert.match(openReturnedBlock, /routeState == RouteState\.OPENING \|\| routeState == RouteState\.OPEN/);
  assert.match(openReturnedBlock, /stageOpenReturnedGeneration != request\.generation/);
  assert.match(openReturnedBlock, /stageOpenReturnedGeneration = request\.generation/);
  assert.match(openReturnedBlock, /emit\("stage_open_returned"/);
  assert.doesNotMatch(debug, /dynamic_stage_mounted|manifest_root_return_rearmed/);
  const emittedKinds = new Set([...debug.matchAll(/emit\("([^"]+)"/g)].map((match) => match[1]));
  if (/emit\(kind = "command_received"/.test(debug)) emittedKinds.add("command_received");
  assert.deepEqual([...emittedKinds].sort(), [
    "command_received",
    "explicit_close_requested",
    "explicit_close_returned",
    "focus",
    "lifecycle",
    "stage_open_requested",
    "stage_open_returned",
  ]);
  assert.match(debug, /@Synchronized\s+fun claimOpen\(request: OpenRequest\): Boolean/);
  assert.match(debug, /@Synchronized\s+fun claimClose\(request: CloseRequest\): Boolean/);
  assert.match(debug, /val canOpen = !dynamicStageActive && \(routeState == RouteState\.IDLE \|\| \(routeState == RouteState\.OPEN && returnedCycle\)\)/);
  assert.match(debug, /if \(command == COMMAND_OPEN && !canOpen\) return false/);
  assert.match(debug, /if \(command == COMMAND_CLOSE && \(routeState != RouteState\.OPEN \|\| !dynamicStageActive\)\) return false/);
  assert.match(debug, /openRequest = null/);
  assert.match(debug, /closeRequest = null/);
  assert.match(debug, /routeState = RouteState\.OPENING/);
  assert.match(debug, /routeState = RouteState\.CLOSING/);
  assert.doesNotMatch(debug, /rootPausedAfterOpen|rootFocusLostAfterOpen|rootResumedAfterOpen|rootFocusRegainedAfterOpen|rearmAfterManifestRootReturn/);
  const claimOpenBlock = debug.slice(debug.indexOf("fun claimOpen"), debug.indexOf("fun claimClose"));
  const claimCloseBlock = debug.slice(debug.indexOf("fun claimClose"), debug.indexOf("fun stageOpenRequested"));
  assert.doesNotMatch(claimOpenBlock, /openRequest = null/, "claimOpen must not invalidate its own LaunchedEffect key");
  assert.doesNotMatch(claimCloseBlock, /closeRequest = null/, "claimClose must not invalidate its own LaunchedEffect key");
  assert.match(debug, /MessageDigest\.isEqual/);
  assert.match(debug, /intent\.action != ACTION/);
  assert.match(debug, /componentClass != RECEIVER_CLASS/);
  assert.match(debug, /session != boundSessionId/);
  assert.match(debug, /generation != nextGeneration/);
  assert.match(debug, /stageId != STAGE_ID/);
  assert.match(debug, /constantTimeEquals\(capability, boundCapability/);
  assert.match(debug, /if \(capability\.length !in 32\.\.256\) return false/);
  assert.match(debug, /nextGeneration = generation \+ 1/);
  assert.match(debug, /if \(command != COMMAND_OPEN && command != COMMAND_CLOSE\) return false/);
  assert.match(debug, /kind = "command_received"/);
  assert.match(debug, /Log\.i\(TAG, PREFIX \+ event\.toString\(\)\)/);
  assert.doesNotMatch(debug, /boundCapability[^\n]*(Log\.|emit\()/);
  const stateMutationAt = debug.indexOf("nextGeneration = generation + 1");
  assert.ok(stateMutationAt > debug.indexOf("if (intent.action != ACTION) return false"));
  assert.ok(stateMutationAt > debug.indexOf("if (!constantTimeEquals(capability"));
  assert.ok(debug.indexOf("openRequest = OpenRequest", stateMutationAt) > stateMutationAt);
  assert.ok(debug.indexOf("closeRequest = CloseRequest", stateMutationAt) > stateMutationAt);

  assert.match(root, /val openRequest = BoundaryProbe\.openRequest/);
  assert.match(root, /BoundaryProbe\.bindLaunchIntent\(activity\.intent\)/);
  assert.match(root, /LaunchedEffect\(openRequest\?\.generation\)/);
  assert.match(root, /if \(!BoundaryProbe\.claimOpen\(request\)\) return@LaunchedEffect/);
  assert.match(root, /navigator\.openStage\(SpatialContainers\.ID_DYNAMIC_FULL, StageStyle\.Full\)/);
  assert.match(root, /BoundaryProbe\.stageOpenRequested/);
  assert.match(root, /BoundaryProbe\.stageOpenReturned/);
  assert.match(root, /LifecycleEventObserver/);
  assert.match(root, /OnWindowFocusChangeListener/);
  assert.doesNotMatch(root, /OpenDynamicFullOnEnter/);
  assert.doesNotMatch(root, /event == Lifecycle\.Event\.ON_PAUSE[^\n]*closeStage/);
  assert.equal(root.match(/navigator\.openStage\(/g)?.length, 1);
  assert.equal(root.match(/navigator\.closeStage\(\)/g)?.length, 1);
  assert.ok(root.indexOf("BoundaryProbe.claimOpen(request)") < root.indexOf("navigator.openStage("));
  assert.match(root, /remember \{ AtomicReference<Entity\?>\(null\) \}/);
  assert.match(root, /sceneRoot\.getAndSet\(null\)\?\.let \{ BoundaryLabScene\.release\(it\) \}/);
  assert.match(root, /sceneRoot\.set\(root\)/);
  assert.doesNotMatch(root, /var sceneRoot by remember \{ mutableStateOf<Entity\?>\(null\) \}/);
  const manifestRootBlock = root.slice(root.indexOf("fun BoundaryProbeRoot()"), root.indexOf("/** Secondary Full content"));
  const fullStageBlock = root.slice(root.indexOf("fun BoundaryFullStage()"));
  assert.doesNotMatch(manifestRootBlock, /closeRequest|claimClose|navigator\.closeStage/);
  const openEffectBlock = manifestRootBlock.slice(manifestRootBlock.indexOf("LaunchedEffect(openRequest?.generation)"), manifestRootBlock.indexOf("    HomeStage()"));
  assert.match(openEffectBlock, /withContext\(NonCancellable\) \{/);
  assert.ok(openEffectBlock.indexOf("withContext(NonCancellable)") < openEffectBlock.indexOf("BoundaryProbe.stageOpenRequested(request)"));
  assert.ok(openEffectBlock.indexOf("BoundaryProbe.stageOpenRequested(request)") < openEffectBlock.indexOf("navigator.openStage("));
  assert.ok(openEffectBlock.indexOf("navigator.openStage(") < openEffectBlock.indexOf("BoundaryProbe.stageOpenReturned(request)"));
  assert.match(manifestRootBlock, /BoundaryProbe\.lifecycle\(event\.name\)/);
  assert.match(manifestRootBlock, /BoundaryProbe\.focus\(focused\)/);
  assert.match(fullStageBlock, /val closeRequest = BoundaryProbe\.closeRequest/);
  assert.match(fullStageBlock, /if \(!BoundaryProbe\.claimClose\(request\)\) return@LaunchedEffect/);
  assert.match(fullStageBlock, /BoundaryProbe\.explicitCloseRequested/);
  assert.match(fullStageBlock, /navigator\.closeStage\(\)/);
  assert.match(fullStageBlock, /BoundaryProbe\.explicitCloseReturned/);
  const closeEffectBlock = fullStageBlock.slice(fullStageBlock.indexOf("LaunchedEffect(closeRequest?.generation)"), fullStageBlock.indexOf("    SpatialView("));
  assert.match(closeEffectBlock, /withContext\(NonCancellable\) \{/);
  assert.ok(closeEffectBlock.indexOf("withContext(NonCancellable)") < closeEffectBlock.indexOf("BoundaryProbe.explicitCloseRequested(request)"));
  assert.ok(closeEffectBlock.indexOf("BoundaryProbe.explicitCloseRequested(request)") < closeEffectBlock.indexOf("navigator.closeStage()"));
  assert.ok(closeEffectBlock.indexOf("navigator.closeStage()") < closeEffectBlock.indexOf("BoundaryProbe.explicitCloseReturned(request)"));
  assert.match(fullStageBlock, /BoundaryProbe\.claimDynamicObservationOwner\(\)/);
  assert.match(fullStageBlock, /BoundaryProbe\.dynamicLifecycle\(event\.name\)/);
  assert.match(fullStageBlock, /BoundaryProbe\.dynamicFocus\(focused\)/);
  assert.match(fullStageBlock, /BoundaryProbe\.releaseDynamicObservationOwner\(\)/);
  assert.match(fullStageBlock, /LifecycleEventObserver/);
  assert.match(fullStageBlock, /OnWindowFocusChangeListener/);
  assert.ok(fullStageBlock.indexOf("BoundaryProbe.claimClose(request)") < fullStageBlock.indexOf("navigator.closeStage()"));
  const lifecycleBlock = root.slice(root.indexOf("LifecycleEventObserver"), root.indexOf("LaunchedEffect(openRequest"));
  assert.doesNotMatch(lifecycleBlock, /navigator\.closeStage\(\)/);

  assert.doesNotMatch(release, /BroadcastReceiver|Log\.|openStage|closeStage|PICO_BOUNDARY_PROBE_V1/);
  assert.match(release, /fun acceptExplicitCommand\(intent: Intent, componentClass: String\): Boolean = false/);
  assert.match(release, /fun claimDynamicObservationOwner\(\): Boolean = false/);
  assert.match(release, /fun releaseDynamicObservationOwner\(\) \{ Unit \}/);
  assert.match(release, /fun dynamicLifecycle\(event: String\) \{ Unit \}/);
  assert.match(release, /fun dynamicFocus\(focused: Boolean\) \{ Unit \}/);
  assert.equal(files.some((file) => file.path.includes("/src/main/") && file.content.includes("BoundaryProbeReceiver")), false);
  assert.equal(files.some((file) => file.path.includes("/src/release/") && file.content.includes("BoundaryProbeReceiver")), false);
  assert.equal(debug.match(/RECEIVER_CLASS/g)?.length, 2);
});

test("F2 uses the existing container lowering and does not invoke its automatic lifecycle helper", () => {
  const dynamic = row(buildBoundaryMatrix(readCanonical()), "boundarylabdynamicfull");
  const ledger = buildLedger(dynamic.spec, "/tmp/fleet-boundarylabdynamicfull-native");
  const containerSteps = ledger.filter((step) => step.tool === "generate_container_app_kotlin");
  assert.equal(containerSteps.length, 1);
  const step = containerSteps[0];
  assert.equal(step.args.root, "stage");
  assert.equal(step.args.rootContent, "BoundaryProbeRoot()");
  assert.equal(step.args.rootContentImport, "com.fleet.boundarylabdynamicfull.content.BoundaryProbeRoot");
  assert.deepEqual(step.args.containers, [{
    kind: "stage",
    id: "dynamic-full",
    style: "Full",
    content: "BoundaryFullStage()",
    contentImport: "com.fleet.boundarylabdynamicfull.content.BoundaryFullStage",
  }]);
  assert.equal(ledger.filter((candidate) => candidate.tool === "generate_app_wiring").length, 1);

  const loweredMain = generateContainerAppFiles(step.args).files["Main.kt"];
  assert.match(loweredMain, /DefaultStage \{ PicoTheme \{ BoundaryProbeRoot\(\) \} \}/);
  assert.match(loweredMain, /Stage\(/);
  assert.match(loweredMain, /id = SpatialContainers\.ID_DYNAMIC_FULL/);
  assert.match(loweredMain, /PicoTheme \{ BoundaryFullStage\(\) \}/);
  assert.doesNotMatch(loweredMain.match(/DefaultStage[^\n]*/)?.[0] ?? "", /OpenDynamicFullOnEnter/);
});

test("assembly adds Boundary Lab files and hooks without changing unrelated wiring or ledgers", () => {
  const matrix = buildBoundaryMatrix(readCanonical());
  const mixed = row(matrix, "boundarylabmixed");
  const full = row(matrix, "boundarylabmanifestfull");
  const dynamic = row(matrix, "boundarylabdynamicfull");

  for (const candidate of matrix) {
    const files = generateWiring(candidate.spec);
    const composition = files.find((file) => file.path.endsWith("/content/SceneComposition.kt"))?.content ?? "";
    const home = files.find((file) => file.path.endsWith("/content/HomeStage.kt"))?.content ?? "";
    assert.match(composition, /BoundaryLabScene\.build\(root\)/);
    assert.match(home, /rememberBoundaryPanelSizes\(\)/);
    assert.match(home, /boundaryLabPanels\(boundaryPanelSizes/);
    assert.match(home, candidate.variant === "manifest_full"
      ? /attachments\.seatBoundaryLabPanels\(worldRoot\)/
      : /attachments\.seatBoundaryLabPanels\(content\)/);
    assert.ok(files.some((file) => file.path.endsWith("/content/BoundaryLabScene.kt")));
  }
  assert.match(generateWiring(mixed.spec).find((file) => file.path.endsWith("/content/BoundaryLabScene.kt")).content, /ROOT_SENTINEL = "MANIFEST MIXED ROOT"/);
  assert.match(generateWiring(full.spec).find((file) => file.path.endsWith("/content/BoundaryLabScene.kt")).content, /ROOT_SENTINEL = "MANIFEST FULL"/);
  for (const manifestRow of [mixed, full]) {
    const files = generateWiring(manifestRow.spec);
    assert.equal(files.some((file) => file.path.includes("/src/debug/") || file.path.includes("/src/release/")), false);
    assert.equal(files.some((file) => file.path.endsWith("/content/BoundaryProbeRoot.kt")), false);
  }
  const dynamicFiles = generateWiring(dynamic.spec);
  const dynamicHome = dynamicFiles.find((file) => file.path.endsWith("/content/HomeStage.kt"))?.content ?? "";
  const dynamicRoot = dynamicFiles.find((file) => file.path.endsWith("/content/BoundaryProbeRoot.kt"))?.content ?? "";
  assert.match(dynamicHome, /boundaryLabPanels\(boundaryPanelSizes, BoundaryLabScene\.ROOT_SENTINEL\)/);
  assert.match(dynamicRoot, /boundaryLabPanels\(panelSizes, BoundaryLabScene\.DYNAMIC_FULL_SENTINEL\)/);
  assert.equal(dynamicFiles.filter((file) => file.path.endsWith("/content/BoundaryProbeRoot.kt")).length, 1);

  const unrelated = JSON.parse(fs.readFileSync(path.join(repoRoot, "briefs", "mrpedestal.json"), "utf8"));
  const unrelatedSpec = appSpecSchema.parse(unrelated.spec);
  assert.equal(sha(generateWiring(unrelatedSpec)), "18449b8cbaabd0c59e2747a1a8788993d038193422c9f1643760442b68b0bd96");
  assert.equal(sha(buildLedger(unrelatedSpec, "/tmp/non-boundary-stability")), "48e2e8d6d0d7c09b2edeb9447517449f1f0e4b7182d1d2d023d42d74a45263ca");
});
