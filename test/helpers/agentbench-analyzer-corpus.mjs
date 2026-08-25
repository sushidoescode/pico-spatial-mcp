import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKELETON_DIR = fileURLToPath(new URL("../../appskeleton/", import.meta.url));
const VERSION_CATALOG_RELATIVE_PATH = path.join("gradle", "libs.versions.toml");
const VERSION_CATALOG_PATH = fileURLToPath(new URL(
  "../../benchmarks/spatial-agent-bench/fixtures/gradle/libs.versions.toml",
  import.meta.url,
));
const SHARED_TEST_PATH = "app/src/test/java/com/agentbench/corpus/CorpusCompileSmokeTest.kt";
const SHARED_TEST_SOURCE = `package com.agentbench.corpus

import org.junit.Test

class CorpusCompileSmokeTest {
    @Test
    fun compiles() = Unit
}
`;

function copySkeletonWithoutSharedCatalog(skeletonDir, projectDir) {
  const sharedCatalogPath = path.resolve(skeletonDir, VERSION_CATALOG_RELATIVE_PATH);
  fs.cpSync(skeletonDir, projectDir, {
    recursive: true,
    dereference: false,
    filter: (source) => path.resolve(source) !== sharedCatalogPath,
  });
}

const TOPOLOGY_PROOFS = Object.freeze([
  Object.freeze(["direct-mixed-stage-open", 0]),
  Object.freeze(["one-helper-mixed-stage-open", 1]),
  Object.freeze(["two-helper-mixed-stage-open", 2]),
]);
const TOPOLOGY_ALTERNATIVES = Object.freeze([
  "named-literal-stage-id",
  "named-const-stage-id",
  "named-source-symbol-stage-id",
  "positional-literal-stage-id",
  "positional-const-stage-id",
  "positional-source-symbol-stage-id",
]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileRow(relative, source) {
  const bytes = Buffer.from(source, "utf8");
  return Object.freeze({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
}

function upperCamel(value) {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
}

function topologySources(proofForm, depth, alternativeId, variant) {
  const match = /^(named|positional)-(literal|const|source-symbol)-stage-id$/.exec(alternativeId);
  if (match === null) throw new Error(`invalid topology alternative ${alternativeId}`);
  const [, argumentForm, originForm] = match;
  const stem = upperCamel(`${proofForm}-${alternativeId}-${variant}`);
  const packageName = `com.agentbench.corpus.topology.${proofForm.replaceAll("-", "_")}.${alternativeId.replaceAll("-", "_")}.${variant}`;
  const mainName = `${variant}Topology${stem}Main`;
  const idName = `${variant}Topology${stem}Id`;
  const otherIdName = `${variant}Topology${stem}OtherId`;
  const idLiteral = `${variant}-${depth}-${argumentForm}-${originForm}-stage`;
  const otherIdLiteral = `${variant}-${depth}-${argumentForm}-${originForm}-other-stage`;
  const idDeclaration = originForm === "literal"
    ? ""
    : originForm === "const"
      ? `private const val ${idName} = "${idLiteral}"\nprivate const val ${otherIdName} = "${otherIdLiteral}"\n\n`
      : `private val ${idName} = "${idLiteral}"\nprivate val ${otherIdName} = "${otherIdLiteral}"\n\n`;
  const idExpression = originForm === "literal" ? `"${idLiteral}"` : idName;
  const stageArgument = argumentForm === "named" ? `id = ${idExpression}` : idExpression;
  const navigator = `${variant}Navigator${stem}`;
  const helperOne = `${variant}Open${stem}One`;
  const helperTwo = `${variant}Open${stem}Two`;
  const nextNavigator = `${variant}NextNavigator${stem}`;
  const launchedBody = depth === 0
    ? `${navigator}.openStage(${idExpression}, StageStyle.Mixed, bundle)`
    : `${navigator}.${helperOne}(${idExpression}, bundle)`;
  const helpers = depth === 0 ? "" : depth === 1
    ? `
private suspend fun SpatialNavigator.${helperOne}(id: String, payload: Bundle?) {
    openStage(id, StageStyle.Mixed, payload)
}
`
    : `
private suspend fun SpatialNavigator.${helperOne}(id: String, payload: Bundle?) {
    val ${nextNavigator}: SpatialNavigator = this
    ${nextNavigator}.${helperTwo}(id, payload)
}

private suspend fun SpatialNavigator.${helperTwo}(id: String, payload: Bundle?) {
    openStage(id, StageStyle.Mixed, payload)
}
`;
  const mainSource = `package ${packageName}

import android.os.Bundle
import androidx.compose.runtime.LaunchedEffect
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator
import com.pico.spatial.ui.platform.containers.SpatialNavigator
import com.pico.spatial.ui.platform.containers.StageStyle

${idDeclaration}fun ${mainName}(scope: SpatialAppScope) = with(scope) {
    DefaultWindowContainer { Unit }
    Stage(${stageArgument}) {
        val ${navigator} = LocalSpatialNavigator.current
        LaunchedEffect(${navigator}) {
            ${launchedBody}
        }
    }
}
${helpers}`;
  const platformSource = `package ${packageName}.platform

import android.app.Application
import ${packageName}.${mainName}
import com.pico.spatial.ui.foundation.dsl.launch
import com.pico.spatial.ui.platform.stub.SpatialLaunchActivity

class ${stem}Application : Application() {
    override fun onCreate() {
        super.onCreate()
        launch(::${mainName})
    }
}

class ${stem}Activity : SpatialLaunchActivity()
`;
  return new Map([
    [`app/src/main/java/${packageName.replaceAll(".", "/")}/${stem}.kt`, mainSource],
    [`app/src/main/java/${packageName.replaceAll(".", "/")}/platform/${stem}Platform.kt`, platformSource],
    [SHARED_TEST_PATH, SHARED_TEST_SOURCE],
  ]);
}

function uiSources(variant) {
  const stem = upperCamel(`${variant}-ui-lifecycle`);
  const packageName = `com.agentbench.corpus.ui.${variant}`;
  const mainName = `${variant}UiLifecycleMain`;
  const windowName = `${variant}WindowContent`;
  const stageName = `${variant}StageContent`;
  const acquireName = `${variant}AcquireResource`;
  const releaseName = `${variant}ReleaseResource`;
  const mainSource = `package ${packageName}

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import com.pico.spatial.ui.design.PicoTheme
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage

fun ${mainName}(scope: SpatialAppScope) = with(scope) {
    DefaultWindowContainer {
        PicoTheme { ${windowName}() }
    }
    Stage(id = "${variant}-ui-stage") {
        ${stageName}()
    }
}

@Composable
private fun ${windowName}() = Unit

@Composable
private fun ${stageName}() {
    DisposableEffect("${variant}-effect-key") {
        ${acquireName}()
        onDispose {
            ${releaseName}()
        }
    }
}

private fun ${acquireName}() = Unit

private fun ${releaseName}() = Unit
`;
  return new Map([
    [`app/src/main/java/${packageName.replaceAll(".", "/")}/${stem}.kt`, mainSource],
    [SHARED_TEST_PATH, SHARED_TEST_SOURCE],
  ]);
}

const REMAINING_REQUIREMENTS = Object.freeze([
  Object.freeze(["spatial.project-entry", "application-launch-root", Object.freeze([
    "direct-launch-import", "aliased-launch-import",
  ])]),
  Object.freeze(["spatial.entity-content", "spatial-view-entity-attachment", Object.freeze([
    "direct-initial-entity", "unique-helper-initial-entity",
  ])]),
  Object.freeze(["ecs.component-clone", "expression-component-clone", Object.freeze([
    "positional-fields", "named-fields",
  ])]),
  Object.freeze(["ecs.component-clone", "single-return-block-component-clone", Object.freeze([
    "positional-fields", "named-fields",
  ])]),
  Object.freeze(["ecs.system-query", "hoisted-query-scene-update", Object.freeze([
    "direct-query-use", "pure-helper-query-use",
  ])]),
  Object.freeze(["ecs.frame-update", "assign-delta-update", Object.freeze([
    "direct-transform", "pure-helper-transform",
  ])]),
  Object.freeze(["ecs.frame-update", "plus-assign-delta-update", Object.freeze([
    "direct-transform", "pure-helper-transform",
  ])]),
  Object.freeze(["ecs.lifecycle", "paired-system-lifecycle", Object.freeze([
    "direct-register-unregister",
  ])]),
  Object.freeze(["state.single-source", "shared-strong-authority", Object.freeze([
    "top-level-val", "object-singleton", "companion-held-singleton",
  ])]),
  Object.freeze(["state.typed-handoff", "typed-bundle-roundtrip", Object.freeze([
    "direct-bundle-adapter", "unique-helper-bundle-adapter",
  ])]),
  Object.freeze(["state.shared-read-write", "same-authority-read-write", Object.freeze([
    "direct-container-summaries",
  ])]),
  Object.freeze(["state.reopen-wiring", "retained-state-close-reopen", Object.freeze([
    "standard-store-reopen", "equivalent-repository-reopen",
  ])]),
  Object.freeze(["plane.retry-readiness", "bounded-retained-load-retry", Object.freeze([
    "bounded-for", "canonical-bounded-while",
  ])]),
  Object.freeze(["plane.semantic-fallback", "dominating-semantic-plane-fallback", Object.freeze([
    "inline-selectors", "unique-helper-selectors",
  ])]),
  Object.freeze(["plane.anchor-pose", "same-anchor-pose-conversion", Object.freeze([
    "direct-pose-conversion", "pure-helper-pose-conversion",
  ])]),
  Object.freeze(["plane.cleanup-errors", "paired-plane-cleanup-status", Object.freeze([
    "direct-cleanup", "unique-helper-cleanup",
  ])]),
]);

function isolatedSources(ruleId, proofForm, alternativeId, variant) {
  const stem = upperCamel(`${ruleId}-${proofForm}-${alternativeId}-${variant}`);
  const packageName = `com.agentbench.corpus.${ruleId.replaceAll(/[.-]/g, "_")}.${proofForm.replaceAll("-", "_")}.${alternativeId.replaceAll("-", "_")}.${variant}`;
  const tag = `${variant}-${alternativeId}`;
  let source;

  if (ruleId === "spatial.project-entry") {
    const launchImport = alternativeId === "aliased-launch-import"
      ? "import com.pico.spatial.ui.foundation.dsl.launch as launchSpatial"
      : "import com.pico.spatial.ui.foundation.dsl.launch";
    const launchCall = alternativeId === "aliased-launch-import" ? "launchSpatial" : "launch";
    source = `package ${packageName}

import android.app.Application
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
${launchImport}
import com.pico.spatial.ui.platform.stub.SpatialLaunchActivity

fun ${stem}Root(scope: SpatialAppScope) = with(scope) {
    DefaultWindowContainer { Unit }
}

class ${stem}Application : Application() {
    override fun onCreate() {
        super.onCreate()
        ${launchCall}(::${stem}Root)
    }
}

class ${stem}Activity : SpatialLaunchActivity()
`;
  } else if (ruleId === "spatial.entity-content") {
    const helper = `${stem}InitialEntity`;
    const entitySetup = alternativeId === "unique-helper-initial-entity"
      ? `val root = ${helper}()`
      : `val root = Entity()
            root.components.set(TransformComponent(
                Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))`;
    const helperSource = alternativeId === "unique-helper-initial-entity" ? `
private fun ${helper}(): Entity {
    val entity = Entity()
    entity.components.set(TransformComponent(
        Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))
    return entity
}
` : "";
    source = `package ${packageName}

import androidx.compose.runtime.Composable
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.ui.foundation.content.SpatialView
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage

fun ${stem}Root(scope: SpatialAppScope) = with(scope) {
    Stage(id = "${tag}-entity-stage") { ${stem}Stage() }
}

@Composable
private fun ${stem}Stage() {
    SpatialView(
        initial = { content, _ ->
            ${entitySetup}
            content.addEntity(root)
        },
        attachments = {},
    )
}
${helperSource}`;
  } else if (ruleId === "ecs.component-clone") {
    const invocation = alternativeId === "named-fields"
      ? `${stem}Component(enabled = enabled, angle = angle)`
      : `${stem}Component(enabled, angle)`;
    const cloneBody = proofForm === "single-return-block-component-clone"
      ? `{
        return ${invocation}
    }`
      : `= ${invocation}`;
    source = `package ${packageName}

import com.pico.spatial.core.ecs.Component

class ${stem}Component(
    val enabled: Boolean = true,
    val angle: Float = ${variant === "alpha" ? "0f" : "1f"},
) : Component() {
    override fun clone(): ${stem}Component ${cloneBody}
}
`;
  } else if (ruleId === "ecs.system-query") {
    const queryUse = alternativeId === "pure-helper-query-use"
      ? `context.scene.${stem}Query(orbitQuery)`
      : "context.scene.queryEntity(orbitQuery)";
    const helperSource = alternativeId === "pure-helper-query-use" ? `
private fun Scene.${stem}Query(condition: EntityQueryCondition) = queryEntity(condition)
` : "";
    source = `package ${packageName}

import com.pico.spatial.core.ecs.EntityQueryCondition
import com.pico.spatial.core.ecs.Scene
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.core.ecs.TransformComponent

class ${stem}System : System() {
    private val orbitQuery = EntityQueryCondition.hasComponent(TransformComponent::class.java)

    override fun update(context: SceneUpdateContext) {
        ${queryUse}.forEach { _ -> Unit }
    }
}
${helperSource}`;
  } else if (ruleId === "ecs.frame-update") {
    const helperName = `${stem}Delta`;
    const transformExpression = proofForm === "plus-assign-delta-update"
      ? alternativeId === "pure-helper-transform"
        ? `transform.position += ${helperName}(context.deltaTime)`
        : "transform.position += Vector3(context.deltaTime, 0f, 0f)"
      : alternativeId === "pure-helper-transform"
        ? `transform.position = ${helperName}(transform.position, context.deltaTime)`
        : "transform.position = Vector3(transform.position.x + context.deltaTime, transform.position.y, transform.position.z)";
    const helperSource = alternativeId === "pure-helper-transform"
      ? proofForm === "plus-assign-delta-update"
        ? `
private fun ${helperName}(delta: Float): Vector3 = Vector3(delta, 0f, 0f)
`
        : `
private fun ${helperName}(position: Vector3, delta: Float): Vector3 =
    Vector3(position.x + delta, position.y, position.z)
`
      : "";
    source = `package ${packageName}

import com.pico.spatial.core.ecs.EntityQueryCondition
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.math.Vector3

class ${stem}System : System() {
    override fun update(context: SceneUpdateContext) {
        context.scene.queryEntity(
            EntityQueryCondition.hasComponent(TransformComponent::class.java),
        ).forEach { entity ->
            val transform = entity.components[TransformComponent::class.java] ?: return@forEach
            ${transformExpression}
        }
    }
}
${helperSource}`;
  } else if (ruleId === "ecs.lifecycle") {
    source = `package ${packageName}

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.foundation.dsl.registerSystem
import com.pico.spatial.ui.foundation.dsl.unregisterSystem

class ${stem}System : System() {
    override fun update(context: SceneUpdateContext) = Unit
}

fun ${stem}Root(scope: SpatialAppScope) = with(scope) {
    Stage(id = "${tag}-lifecycle-stage") { ${stem}Stage() }
}

@Composable
private fun ${stem}Stage() {
    DisposableEffect("${tag}-system") {
        registerSystem<${stem}System>()
        onDispose { unregisterSystem<${stem}System>() }
    }
}
`;
  } else if (ruleId === "state.single-source") {
    const authorityType = `${stem}Store`;
    let authorityDeclaration;
    let authorityExpression;
    let companionDeclaration;
    if (alternativeId === "top-level-val") {
      authorityDeclaration = `val ${stem}SharedStore = ${authorityType}()`;
      authorityExpression = `${stem}SharedStore`;
      companionDeclaration = "";
    } else if (alternativeId === "object-singleton") {
      authorityDeclaration = `object ${stem}Authority { val instance = ${authorityType}() }`;
      authorityExpression = `${stem}Authority.instance`;
      companionDeclaration = "";
    } else {
      authorityDeclaration = "";
      authorityExpression = `${authorityType}.instance`;
      companionDeclaration = `companion object { val instance = ${authorityType}() }`;
    }
    source = `package ${packageName}

import androidx.compose.runtime.Composable
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage

class ${authorityType} {
    val label: String = "${tag}-authority"
    ${companionDeclaration}
}

${authorityDeclaration}

fun ${stem}Root(scope: SpatialAppScope) = with(scope) {
    val authority = ${authorityExpression}
    DefaultWindowContainer { ${stem}Window(authority) }
    Stage(id = "${tag}-state-stage") { ${stem}Stage(authority) }
}

@Composable
private fun ${stem}Window(store: ${authorityType}) { Text(store.label) }

@Composable
private fun ${stem}Stage(store: ${authorityType}) { Text(store.label) }
`;
  } else if (ruleId === "state.typed-handoff") {
    const snapshot = `${stem}Snapshot`;
    const selection = `${stem}Selection`;
    const encodeBody = alternativeId === "unique-helper-bundle-adapter"
      ? `Bundle().apply { ${stem}Write(this, state) }`
      : `Bundle().apply {
        putString("${tag}-selection", state.selection?.id)
        putInt("${tag}-visits", state.visitCount)
        putBoolean("${tag}-paused", state.paused)
    }`;
    const decodeBody = alternativeId === "unique-helper-bundle-adapter"
      ? `${stem}Read(bundle)`
      : `${snapshot}(
        selection = bundle?.getString("${tag}-selection")?.let(::${selection}),
        visitCount = bundle?.getInt("${tag}-visits") ?: 0,
        paused = bundle?.getBoolean("${tag}-paused") ?: false,
    )`;
    const helperSource = alternativeId === "unique-helper-bundle-adapter" ? `
private fun ${stem}Write(bundle: Bundle, state: ${snapshot}) {
    bundle.putString("${tag}-selection", state.selection?.id)
    bundle.putInt("${tag}-visits", state.visitCount)
    bundle.putBoolean("${tag}-paused", state.paused)
}

private fun ${stem}Read(bundle: Bundle?): ${snapshot} = ${snapshot}(
    selection = bundle?.getString("${tag}-selection")?.let(::${selection}),
    visitCount = bundle?.getInt("${tag}-visits") ?: 0,
    paused = bundle?.getBoolean("${tag}-paused") ?: false,
)
` : "";
    source = `package ${packageName}

import android.os.Bundle
import com.pico.spatial.ui.platform.containers.SpatialNavigator
import com.pico.spatial.ui.platform.containers.StageStyle

data class ${selection}(val id: String)

data class ${snapshot}(
    val selection: ${selection}?,
    val visitCount: Int,
    val paused: Boolean,
)

object ${stem}BundleAdapter {
    fun encode(state: ${snapshot}): Bundle = ${encodeBody}

    fun decode(bundle: Bundle?): ${snapshot} = ${decodeBody}
}

suspend fun SpatialNavigator.${stem}Open(state: ${snapshot}) {
    val bundle = ${stem}BundleAdapter.encode(state)
    openStage("${tag}-typed-stage", StageStyle.Mixed, bundle)
}
${helperSource}`;
  } else if (ruleId === "state.shared-read-write") {
    source = `package ${packageName}

import androidx.compose.runtime.Composable
import com.pico.spatial.ui.design.Button
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage

class ${stem}Authority {
    private var selected: String? = null
    fun select(id: String) { selected = id }
    fun snapshot(): String? = selected
    fun restore(value: String?) { selected = value }
}

fun ${stem}Root(scope: SpatialAppScope, authority: ${stem}Authority) = with(scope) {
    DefaultWindowContainer { ${stem}Window(authority) }
    Stage(id = "${tag}-shared-stage") { ${stem}Stage(authority) }
}

@Composable
private fun ${stem}Window(authority: ${stem}Authority) {
    Text(authority.snapshot() ?: "none")
    Button(onClick = { authority.select("${tag}-selection") }) { Text("Select") }
}

@Composable
private fun ${stem}Stage(authority: ${stem}Authority) {
    val retained = authority.snapshot()
    authority.restore(retained)
}
`;
  } else if (ruleId === "state.reopen-wiring") {
    const equivalent = alternativeId === "equivalent-repository-reopen";
    const authority = equivalent ? `${stem}Repository` : `${stem}Store`;
    const snapshot = equivalent ? `${stem}SessionSnapshot` : `${stem}Snapshot`;
    const read = equivalent ? "currentSnapshot" : "snapshot";
    const open = equivalent ? `${stem}ShowMixedContainer` : `${stem}OpenStage`;
    const callbackArgument = equivalent
      ? `initialState = authority.${read}(),
        stateOwner = authority,
        stateOnReentry = authority::${read},`
      : `state = authority.${read}(),
        store = authority,
        restoreRetainedState = true,`;
    const openSignature = equivalent
      ? `initialState: ${snapshot}, stateOwner: ${authority}, stateOnReentry: () -> ${snapshot}`
      : `state: ${snapshot}, store: ${authority}, restoreRetainedState: Boolean`;
    const handoff = equivalent
      ? `val handoff = stateOnReentry()
    stateOwner.restore(handoff)`
      : `val handoff = if (restoreRetainedState) store.${read}() else state`;
    const encodedState = "handoff";
    source = `package ${packageName}

import android.os.Bundle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import com.pico.spatial.ui.design.Button
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator
import com.pico.spatial.ui.platform.containers.SpatialNavigator
import com.pico.spatial.ui.platform.containers.StageStyle
import kotlinx.coroutines.launch

data class ${snapshot}(val selection: String?, val visitCount: Int, val paused: Boolean) {
    companion object { fun empty() = ${snapshot}(null, 0, false) }
}

class ${authority} {
    private var retained = ${snapshot}.empty()
    fun ${read}(): ${snapshot} = retained
    fun restore(value: ${snapshot}) { retained = value }
}

fun ${stem}Root(scope: SpatialAppScope, authority: ${authority}) = with(scope) {
    DefaultWindowContainer { ${stem}Window(authority) }
}

@Composable
private fun ${stem}Window(authority: ${authority}) {
    val navigator = LocalSpatialNavigator.current
    val actionScope = rememberCoroutineScope()
    Button(onClick = {
        actionScope.launch { navigator.${stem}CloseAndReopen(authority) }
    }) { Text("Close and reopen") }
}

private suspend fun SpatialNavigator.${open}(${openSignature}) {
    ${handoff}
    val bundle = Bundle().apply {
        putString("selection", ${encodedState}.selection)
        putInt("visitCount", ${encodedState}.visitCount)
        putBoolean("paused", ${encodedState}.paused)
    }
    openStage("${tag}-reopen-stage", StageStyle.Mixed, bundle)
}

private suspend fun SpatialNavigator.${stem}CloseAndReopen(authority: ${authority}) {
    closeStage()
    val selection = authority.${read}().selection
    val visitCount = authority.${read}().visitCount
    val paused = authority.${read}().paused
    authority.restore(${snapshot}(selection, visitCount, paused))
    ${open}(
        ${callbackArgument}
    )
}
`;
  } else if (ruleId === "plane.retry-readiness") {
    const loop = alternativeId === "bounded-for"
      ? `for (attempt in 0 until ${variant === "alpha" ? "4" : "5"}) {
        val loaded = PlaneTrackingManager.loadAllAnchors().toList()
        candidates = loaded
        if (loaded.isNotEmpty()) break
        delay(25L)
    }`
      : `var attempt = 0
    while (attempt < ${variant === "alpha" ? "4" : "5"}) {
        val loaded = PlaneTrackingManager.loadAllAnchors().toList()
        candidates = loaded
        if (loaded.isNotEmpty()) break
        attempt += 1
        delay(25L)
    }`;
    source = `package ${packageName}

import com.pico.spatial.sense.plane.PlaneAnchor
import com.pico.spatial.sense.plane.PlaneTrackingManager
import kotlinx.coroutines.delay

suspend fun ${stem}LoadReadyAnchors(): List<PlaneAnchor> {
    PlaneTrackingManager.start()
    var candidates: List<PlaneAnchor> = emptyList()
    ${loop}
    return candidates
}
`;
  } else if (ruleId === "plane.semantic-fallback") {
    const predicate = (semantic) => `it.semantics == SemanticLabelType.${semantic} && (it.planeOrientation == PlaneOrientation.HORIZONTAL_UPWARD || it.planeOrientation == PlaneOrientation.HORIZONTAL_DOWNWARD) && it.boundingBoxSize.x * it.boundingBoxSize.y > 0f`;
    const body = alternativeId === "inline-selectors"
      ? `candidates.filter { ${predicate("TABLE")} }.maxByOrNull { it.boundingBoxSize.x * it.boundingBoxSize.y }
        ?: candidates.filter { ${predicate("FLOOR")} }.maxByOrNull { it.boundingBoxSize.x * it.boundingBoxSize.y }`
      : `${stem}Table(candidates) ?: ${stem}Floor(candidates)`;
    const helperSource = alternativeId === "unique-helper-selectors" ? `
private fun ${stem}Table(candidates: List<PlaneAnchor>): PlaneAnchor? =
    candidates.filter { ${predicate("TABLE")} }
        .maxByOrNull { it.boundingBoxSize.x * it.boundingBoxSize.y }

private fun ${stem}Floor(candidates: List<PlaneAnchor>): PlaneAnchor? =
    candidates.filter { ${predicate("FLOOR")} }
        .maxByOrNull { it.boundingBoxSize.x * it.boundingBoxSize.y }
` : "";
    source = `package ${packageName}

import com.pico.spatial.sense.base.SemanticLabelType
import com.pico.spatial.sense.plane.PlaneAnchor
import com.pico.spatial.sense.plane.PlaneOrientation
import com.pico.spatial.sense.plane.PlaneTrackingManager

suspend fun ${stem}SemanticFallback(): PlaneAnchor? {
    val candidates = PlaneTrackingManager.loadAllAnchors().toList()
    return ${body}
}
${helperSource}`;
  } else if (ruleId === "plane.anchor-pose") {
    const position = alternativeId === "pure-helper-pose-conversion"
      ? `${stem}Position(root, anchor)`
      : "root.convertPositionFrom(anchor.transform.position, null)";
    const rotation = alternativeId === "pure-helper-pose-conversion"
      ? `${stem}Rotation(root, anchor)`
      : "root.convertRotationFrom(anchor.transform.quaternion, null)";
    const helperSource = alternativeId === "pure-helper-pose-conversion" ? `
private fun ${stem}Position(root: Entity, anchor: PlaneAnchor): Vector3 =
    root.convertPositionFrom(anchor.transform.position, null)

private fun ${stem}Rotation(root: Entity, anchor: PlaneAnchor): Quat =
    root.convertRotationFrom(anchor.transform.quaternion, null)
` : "";
    source = `package ${packageName}

import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.sense.plane.PlaneAnchor

fun ${stem}Place(root: Entity, anchor: PlaneAnchor) {
    val position = ${position}
    val rotation = ${rotation}
    val spacing = anchor.boundingBoxSize.x.coerceAtLeast(0.1f) / ${variant === "alpha" ? "4f" : "5f"}
    val placed = Entity()
    placed.components.set(TransformComponent(
        Vector3(position.x + spacing, position.y, position.z),
        rotation,
        Vector3(1f, 1f, 1f),
    ))
    root.addChild(placed)
}
${helperSource}`;
  } else if (ruleId === "plane.cleanup-errors") {
    const cleanupBody = alternativeId === "unique-helper-cleanup"
      ? `${stem}Cancel()
        ${stem}Stop()`
      : `subscription?.cancel()
        subscription = null
        runCatching { PlaneTrackingManager.stop() }`;
    const helperSource = alternativeId === "unique-helper-cleanup" ? `
    private fun ${stem}Cancel() {
        subscription?.cancel()
        subscription = null
    }

    private fun ${stem}Stop() {
        runCatching { PlaneTrackingManager.stop() }
    }
` : "";
    source = `package ${packageName}

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import com.pico.spatial.core.lifecycle.Cancellable
import com.pico.spatial.sense.plane.PlaneTrackingManager
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage

sealed interface ${stem}Status {
    data object Searching : ${stem}Status
    data object NoSurface : ${stem}Status
    data object Placed : ${stem}Status
    data class Error(val message: String) : ${stem}Status
}

fun ${stem}Root(scope: SpatialAppScope) = with(scope) {
    Stage(id = "${tag}-cleanup-stage") { ${stem}Owner() }
}

@Composable
private fun ${stem}Owner() {
    val session = remember { ${stem}Session() }
    DisposableEffect(session) {
        session.startTracking()
        onDispose { session.cleanup() }
    }
}

class ${stem}Session {
    var status: ${stem}Status = ${stem}Status.Searching
        private set
    private var subscription: Cancellable? = null

    fun startTracking() {
        status = ${stem}Status.Searching
        try {
            subscription = PlaneTrackingManager.subscribeAnchorUpdate { _ -> }
            PlaneTrackingManager.start()
        } catch (error: Throwable) {
            status = ${stem}Status.Error(error.message ?: "${tag}-start-error")
            cleanup()
        }
    }

    fun markNoSurface() { status = ${stem}Status.NoSurface }

    fun markPlaced() { status = ${stem}Status.Placed }

    fun cleanup() {
        ${cleanupBody}
    }
${helperSource}}
`;
  } else {
    throw new Error(`unsupported corpus rule ${ruleId}`);
  }

  return new Map([
    [`app/src/main/java/${packageName.replaceAll(".", "/")}/${stem}.kt`, source],
    [SHARED_TEST_PATH, SHARED_TEST_SOURCE],
  ]);
}

function sortedRows(sources) {
  return [...sources.entries()]
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([relative, source]) => fileRow(relative, source));
}

const sourceByCaseId = new Map();
const mutableCases = [];
for (const [proofForm, depth] of TOPOLOGY_PROOFS) {
  for (const alternativeId of TOPOLOGY_ALTERNATIVES) {
    for (const variant of ["alpha", "beta"]) {
      const id = `topology.${proofForm}.${alternativeId}.${variant}`;
      const sources = topologySources(proofForm, depth, alternativeId, variant);
      sourceByCaseId.set(id, sources);
      mutableCases.push(Object.freeze({
        id,
        ruleId: "spatial.container-topology",
        proofForm,
        alternativeId,
        compileAggregateId: "cp1-spatial-emitters",
        kotlinFiles: Object.freeze(sortedRows(sources)),
      }));
    }
  }
}
for (const variant of ["alpha", "beta"]) {
  const id = `ui.themed-window-and-disposable-stage.direct-theme-paired-dispose.${variant}`;
  const sources = uiSources(variant);
  sourceByCaseId.set(id, sources);
  mutableCases.push(Object.freeze({
    id,
    ruleId: "spatial.ui-lifecycle",
    proofForm: "themed-window-and-disposable-stage",
    alternativeId: "direct-theme-paired-dispose",
    compileAggregateId: "cp1-spatial-emitters",
    kotlinFiles: Object.freeze(sortedRows(sources)),
  }));
}
for (const [ruleId, proofForm, alternativeIds] of REMAINING_REQUIREMENTS) {
  for (const alternativeId of alternativeIds) {
    for (const variant of ["alpha", "beta"]) {
      const id = `${ruleId}.${proofForm}.${alternativeId}.${variant}`;
      const sources = isolatedSources(ruleId, proofForm, alternativeId, variant);
      sourceByCaseId.set(id, sources);
      mutableCases.push(Object.freeze({
        id,
        ruleId,
        proofForm,
        alternativeId,
        compileAggregateId: "cp1-spatial-emitters",
        kotlinFiles: Object.freeze(sortedRows(sources)),
      }));
    }
  }
}

const aggregateSources = new Map();
for (const sources of sourceByCaseId.values()) {
  for (const [relative, source] of sources) {
    const prior = aggregateSources.get(relative);
    if (prior !== undefined && prior !== source) throw new Error(`corpus path collision: ${relative}`);
    aggregateSources.set(relative, source);
  }
}

export const POSITIVE_SUBSET_V1_CASES = Object.freeze(mutableCases);
export const POSITIVE_SUBSET_V1_COMPILE_AGGREGATES = Object.freeze([
  Object.freeze({
    id: "cp1-spatial-emitters",
    kotlinFiles: Object.freeze(sortedRows(aggregateSources)),
  }),
]);

function installSources(t, sources, prefix, { skeletonDir = SKELETON_DIR } = {}) {
  if (t === null || typeof t !== "object" || typeof t.after !== "function") {
    throw new TypeError("node:test context is required");
  }
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, prefix)));
  if (path.dirname(projectDir) !== temporaryRoot || fs.lstatSync(projectDir).isSymbolicLink()) {
    throw new Error("unsafe corpus temporary root");
  }
  t.after(() => {
    const stat = fs.lstatSync(projectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || path.dirname(fs.realpathSync(projectDir)) !== temporaryRoot) {
      throw new Error("unsafe corpus cleanup target");
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  copySkeletonWithoutSharedCatalog(skeletonDir, projectDir);
  fs.copyFileSync(VERSION_CATALOG_PATH, path.join(projectDir, VERSION_CATALOG_RELATIVE_PATH));
  for (const relative of [
    ".gradle", "app/build", "app/src/main/java", "app/src/test/java", "app/src/androidTest/java",
  ]) fs.rmSync(path.join(projectDir, relative), { recursive: true, force: true });
  for (const [relative, source] of sources) {
    const target = path.join(projectDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, { encoding: "utf8", mode: 0o600 });
  }
  return projectDir;
}

export function writePositiveSubsetCase(t, id, options) {
  const sources = sourceByCaseId.get(id);
  if (sources === undefined) throw new Error(`unknown positive subset case: ${id}`);
  return installSources(t, sources, "agentbench-cp1-case-", options);
}

export function writePositiveSubsetCompileAggregate(t, id, options) {
  if (id !== "cp1-spatial-emitters") throw new Error(`unknown positive subset aggregate: ${id}`);
  return installSources(t, aggregateSources, "agentbench-cp1-aggregate-", options);
}
