import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKELETON_DIR = fileURLToPath(new URL("../../appskeleton/", import.meta.url));
const VERSION_CATALOG = fs.readFileSync(path.join(SKELETON_DIR, "gradle/libs.versions.toml"), "utf8");

function replace(from, to) {
  return (files) => {
    const matches = Object.values(files).reduce((total, source) => total + source.split(from).length - 1, 0);
    if (matches !== 1) throw new Error(`fixture replacement expected exactly one occurrence of ${JSON.stringify(from)}, found ${matches}`);
    return Object.fromEntries(Object.entries(files).map(([name, source]) => [name, source.replace(from, to)]));
  };
}

function applicationSource({ equivalent = false } = {}) {
  if (equivalent) {
    return `package com.agentbench.gallery

import android.os.Bundle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.pico.spatial.ui.design.PicoTheme
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.Immersion
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator
import com.pico.spatial.ui.platform.containers.SpatialNavigator
import com.pico.spatial.ui.platform.containers.StageStyle

val museumSessionRepository: GallerySessionRepository = GallerySessionRepository.current()

fun mainApp(scope: SpatialAppScope) = with(scope) {
    DefaultWindowContainer {
        PicoTheme { GalleryWindow(museumSessionRepository) }
    }
    Stage(
        id = SpatialContainers.ID_GALLERY,
        immersion = Immersion(default = 100, min = 0, max = 100),
    ) {
        GalleryStage(bundle, museumSessionRepository)
    }
}

object SpatialContainers {
    const val ID_GALLERY = "GalleryStage"
}

@Composable
private fun GalleryWindow(stateOwner: GallerySessionRepository) {
    val navigator = LocalSpatialNavigator.current
    val state = stateOwner.currentSnapshot()
    Text("Selected: \${state.selection?.id ?: "none"}; visits: \${state.visitCount}")
    LaunchedEffect(navigator) {
        showMixedContainer(
            initialState = museumSessionRepository.currentSnapshot(),
            stateOwner = museumSessionRepository,
            stateOnReentry = museumSessionRepository::currentSnapshot,
        )
    }
}

private suspend fun SpatialNavigator.showMixedContainer(
    initialState: GallerySessionSnapshot,
    stateOwner: GallerySessionRepository,
    stateOnReentry: () -> GallerySessionSnapshot,
) {
    val reentry = stateOnReentry()
    stateOwner.restore(reentry)
    val bundle = Bundle().apply {
        putString("selection", initialState.selection?.id)
        putInt("visitCount", initialState.visitCount)
        putBoolean("paused", initialState.paused)
    }
    openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)
}

private suspend fun SpatialNavigator.closeAndReopenEquivalent(stateOwner: GallerySessionRepository) {
    closeStage()
    val selection = museumSessionRepository.currentSnapshot().selection
    val visitCount = museumSessionRepository.currentSnapshot().visitCount
    val paused = museumSessionRepository.currentSnapshot().paused
    stateOwner.restore(GallerySessionSnapshot(selection, visitCount, paused))
    showMixedContainer(stateOwner.currentSnapshot(), stateOwner, stateOwner::currentSnapshot)
}
`;
  }

  return `package com.agentbench.gallery

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.pico.spatial.ui.design.PicoTheme
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.Immersion
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator
import com.pico.spatial.ui.platform.containers.SpatialNavigator
import com.pico.spatial.ui.platform.containers.StageStyle

val sharedStore = BenchmarkStore.instance

fun mainApp(scope: SpatialAppScope) = with(scope) {
    DefaultWindowContainer {
        PicoTheme { GalleryWindow(sharedStore) }
    }
    Stage(
        id = SpatialContainers.ID_GALLERY,
        immersion = Immersion(default = 100, min = 0, max = 100),
    ) {
        GalleryStage(bundle, sharedStore)
    }
}

object SpatialContainers {
    const val ID_GALLERY = "GalleryStage"
}

@Composable
private fun GalleryWindow(store: BenchmarkStore) {
    val navigator = LocalSpatialNavigator.current
    val state = store.snapshot()
    Text("Selected: \${state.selection?.id ?: "none"}; visits: \${state.visitCount}")
    LaunchedEffect(navigator) {
        navigator.openGalleryStage(
            state = sharedStore.snapshot(),
            store = sharedStore,
            restoreRetainedState = true,
        )
    }
}

private suspend fun SpatialNavigator.openGalleryStage(
    state: GallerySnapshot,
    store: BenchmarkStore,
    restoreRetainedState: Boolean,
) {
    val handoff = if (restoreRetainedState) store.snapshot() else state
    val bundle = GalleryBundle.encode(handoff)
    openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)
}

private suspend fun SpatialNavigator.closeAndReopen(store: BenchmarkStore) {
    closeStage()
    val selection = sharedStore.snapshot().selection
    val visitCount = sharedStore.snapshot().visitCount
    val paused = sharedStore.snapshot().paused
    store.restore(GallerySnapshot(selection, visitCount, paused))
    openGalleryStage(store.snapshot(), store, true)
}
`;
}

function stateSource({ equivalent = false } = {}) {
  const repository = equivalent ? "GallerySessionRepository" : "BenchmarkStore";
  const snapshot = equivalent ? "GallerySessionSnapshot" : "GallerySnapshot";
  const singleton = equivalent ? "current" : "instance";
  const snapshotMethod = equivalent ? "currentSnapshot" : "snapshot";
  return `package com.agentbench.gallery

data class GallerySelection(val id: String)

data class ${snapshot}(
    val selection: GallerySelection?,
    val visitCount: Int,
    val paused: Boolean,
) {
    companion object {
        fun empty() = ${snapshot}(null, 0, false)
    }
}

class ${repository} {
    private var selection: GallerySelection? = null
    private var visitCount: Int = 0
    private var paused: Boolean = false

    fun select(selectedId: String) {
        selection = GallerySelection(selectedId)
        visitCount += 1
    }

    fun setPaused(value: Boolean) {
        paused = value
    }

    fun ${snapshotMethod}(): ${snapshot} = ${snapshot}(selection, visitCount, paused)

    fun restore(snapshot: ${snapshot}) {
        selection = snapshot.selection
        visitCount = snapshot.visitCount
        paused = snapshot.paused
    }

    fun closeContainer() = Unit

    fun reopenContainer(): ${snapshot} = ${snapshotMethod}()

    companion object {
        private val retained = ${repository}()
        ${equivalent ? `fun ${singleton}(): ${repository} = retained` : ""}
        ${equivalent ? "" : "val instance: BenchmarkStore get() = retained"}
    }
}
`;
}

function galleryBundleSource({ equivalent = false } = {}) {
  const repository = equivalent ? "GallerySessionRepository" : "BenchmarkStore";
  const snapshot = equivalent ? "GallerySessionSnapshot" : "GallerySnapshot";
  return `package com.agentbench.gallery

import android.os.Bundle

object GalleryBundle {
    fun encode(state: ${snapshot}): Bundle = Bundle().apply {
        putString("selection", state.selection?.id)
        putInt("visitCount", state.visitCount)
        putBoolean("paused", state.paused)
    }

    fun decode(bundle: Bundle?): ${snapshot} = ${snapshot}(
        selection = bundle?.getString("selection")?.let(::GallerySelection),
        visitCount = bundle?.getInt("visitCount") ?: 0,
        paused = bundle?.getBoolean("paused") ?: false,
    )

    fun restore(bundle: Bundle?, stageStore: ${repository}) {
        stageStore.restore(decode(bundle))
    }
}
`;
}

const ORBIT_SOURCE = `package com.agentbench.gallery

import com.pico.spatial.core.ecs.Component
import com.pico.spatial.core.ecs.EntityQueryCondition
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.math.Vector3
import kotlin.math.cos
import kotlin.math.sin

class OrbitComponent(
    var enabled: Boolean = true,
    var angle: Float = 0f,
) : Component() {
    override fun clone(): OrbitComponent = OrbitComponent(enabled, angle)
}

class OrbitSystem : System() {
    private val orbitQuery = EntityQueryCondition.hasComponent(OrbitComponent::class.java)

    override fun update(context: SceneUpdateContext) {
        context.scene.queryEntity(orbitQuery).forEach { entity ->
            val orbit = entity.components[OrbitComponent::class.java] ?: return@forEach
            val transform = entity.components[TransformComponent::class.java] ?: return@forEach
            orbit.angle += context.deltaTime
            transform.position = Vector3(cos(orbit.angle), transform.position.y, sin(orbit.angle))
        }
    }
}
`;

function stageSource({ equivalent = false } = {}) {
  const repository = equivalent ? "GallerySessionRepository" : "BenchmarkStore";
  const stageStore = equivalent ? "stateOwner" : "stageStore";
  return `package com.agentbench.gallery

import android.os.Bundle
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.ui.foundation.content.SpatialView
import com.pico.spatial.ui.foundation.dsl.registerSystem
import com.pico.spatial.ui.foundation.dsl.unregisterSystem

@Composable
fun GalleryStage(bundle: Bundle?, ${stageStore}: ${repository}) {
    val retainedState = GalleryBundle.decode(bundle)
    ${stageStore}.restore(retainedState)
    ${stageStore}.select(retainedState.selection?.id ?: "vase")
    ${stageStore}.setPaused(retainedState.paused)
    val planeSession = remember { PlaneSession() }

    DisposableEffect(planeSession) {
        registerSystem<OrbitSystem>()
        planeSession.startTracking()
        onDispose {
            planeSession.stopTrackingAndUnsubscribe()
            unregisterSystem<OrbitSystem>()
        }
    }

    SpatialView(
        modifier = Modifier.fillMaxSize(),
        initial = { content, _ ->
            val root = Entity()
            root.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))
            val orbiting = Entity()
            orbiting.components.set(OrbitComponent(enabled = true, angle = 0f))
            orbiting.components.set(TransformComponent(Vector3(0f, 1f, -1f), Quat.identity(), Vector3(1f, 1f, 1f)))
            root.addChild(orbiting)
            content.addEntity(root)
            planeSession.loadAndPlace(root)
        },
        attachments = {},
    )
}
`;
}

const PLANE_SOURCE = `package com.agentbench.gallery

import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.lifecycle.Cancellable
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.sense.base.SemanticLabelType
import com.pico.spatial.sense.plane.PlaneAnchor
import com.pico.spatial.sense.plane.PlaneOrientation
import com.pico.spatial.sense.plane.PlaneTrackingManager
import kotlinx.coroutines.delay

private const val MAX_ANCHOR_RETRIES = 4

sealed interface SurfaceStatus {
    data object Searching : SurfaceStatus
    data object NoSurface : SurfaceStatus
    data class Placed(val semantic: SemanticLabelType) : SurfaceStatus
    data class Error(val message: String) : SurfaceStatus
}

class PlaneSession {
    var state: SurfaceStatus = SurfaceStatus.Searching
        private set
    private var subscription: Cancellable? = null
    private var candidates: List<PlaneAnchor> = emptyList()

    fun startTracking() {
        state = SurfaceStatus.Searching
        try {
            subscription = PlaneTrackingManager.subscribeAnchorUpdate { _ -> }
            PlaneTrackingManager.start()
        } catch (error: Throwable) {
            state = SurfaceStatus.Error(error.message ?: "plane tracking start failed")
            stopTrackingAndUnsubscribe()
        }
    }

    suspend fun loadAndPlace(root: Entity) {
        try {
            repeat(MAX_ANCHOR_RETRIES) {
                candidates = PlaneTrackingManager.loadAllAnchors().toList()
                if (candidates.isNotEmpty()) return@repeat
                delay(25L)
            }
            val anchor = horizontalTablePlane() ?: horizontalFloorPlane()
            if (anchor == null) {
                state = SurfaceStatus.NoSurface
                return
            }
            val convertedPosition = root.convertPositionFrom(anchor.transform.position, null)
            val convertedRotation = root.convertRotationFrom(anchor.transform.quaternion, null)
            val placed = Entity()
            val spacing = anchor.boundingBoxSize.x.coerceAtLeast(0.1f) / 4f
            placed.components.set(TransformComponent(
                Vector3(convertedPosition.x + spacing, convertedPosition.y, convertedPosition.z),
                convertedRotation,
                Vector3(1f, 1f, 1f),
            ))
            root.addChild(placed)
            state = SurfaceStatus.Placed(anchor.semantics)
        } catch (error: Throwable) {
            state = SurfaceStatus.Error(error.message ?: "anchor loading failed")
        }
    }

    private fun horizontalTablePlane(): PlaneAnchor? = candidates
        .filter { it.semantics == SemanticLabelType.TABLE && isHorizontal(it) && area(it) > 0f }
        .maxByOrNull(::area)

    private fun horizontalFloorPlane(): PlaneAnchor? = candidates
        .filter { it.semantics == SemanticLabelType.FLOOR && isHorizontal(it) && area(it) > 0f }
        .maxByOrNull(::area)

    private fun isHorizontal(anchor: PlaneAnchor): Boolean =
        anchor.planeOrientation == PlaneOrientation.HORIZONTAL_UPWARD ||
            anchor.planeOrientation == PlaneOrientation.HORIZONTAL_DOWNWARD

    private fun area(anchor: PlaneAnchor): Float = anchor.boundingBoxSize.x * anchor.boundingBoxSize.y

    fun stopTrackingAndUnsubscribe() {
        subscription?.cancel()
        subscription = null
        runCatching { PlaneTrackingManager.stop() }
    }
}
`;

function modelTestSource({ equivalent = false } = {}) {
  const repository = equivalent ? "GallerySessionRepository" : "BenchmarkStore";
  const singleton = equivalent ? `${repository}.current()` : `${repository}()`;
  const snapshot = equivalent ? "currentSnapshot" : "snapshot";
  return `package com.agentbench.gallery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GalleryStateTest {
    @Test
    fun twoSelectionsCloseAndReopenRetainVisitsAndPause() {
        val repository = ${singleton}
        repository.select("vase")
        repository.select("mask")
        repository.setPaused(true)
        repository.closeContainer()

        val reopened = repository.reopenContainer()

        assertEquals("mask", reopened.selection?.id)
        assertEquals(2, reopened.visitCount)
        assertTrue(reopened.paused)
        assertEquals(reopened, repository.${snapshot}())
    }
}
`;
}

function manifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:name=".platform.SpatialApplication" android:theme="@style/Theme.SpatialApp">
        <activity
            android:name=".platform.LaunchActivity"
            android:exported="true"
            android:theme="@style/Theme.SpatialApp">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <meta-data android:name="pico.spatial.windowcontainer.id" android:value="BenchmarkWindow" />
            <meta-data android:name="pico.spatial.windowcontainer.style" android:value="1" />
            <meta-data android:name="pico.spatial.windowcontainer.defaultsize" android:value="1280x720" />
        </activity>
    </application>
</manifest>
`;
}

const APPLICATION_CLASS = `package com.agentbench.gallery.platform

import android.app.Application
import com.agentbench.gallery.mainApp
import com.pico.spatial.ui.foundation.dsl.launch

class SpatialApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        launch(::mainApp)
    }
}
`;

const ACTIVITY_CLASS = `package com.agentbench.gallery.platform

import com.pico.spatial.ui.platform.stub.SpatialLaunchActivity

class LaunchActivity : SpatialLaunchActivity()
`;

function fixtureBuildFile() {
  return `plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.agentbench.gallery"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.agentbench.gallery"
        minSdk = 35
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions { jvmTarget = "11" }
    buildFeatures { compose = true }
}

tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    reports.junitXml.includeSystemOutLog.set(false)
    reports.junitXml.includeSystemErrLog.set(false)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(platform(libs.bom))
    implementation(libs.core)
    implementation(libs.platform)
    implementation(libs.foundation)
    implementation(libs.design)
    implementation(libs.sense)
    implementation(libs.tracking)
    implementation(libs.androidx.annotation)
    testImplementation(libs.junit)
}

configurations.all {
    resolutionStrategy {
        exclude("androidx.compose.ui", "ui")
        exclude("androidx.compose.ui", "ui-graphics")
        exclude("androidx.compose.ui", "ui-text")
        exclude("androidx.compose.foundation", "foundation")
    }
}
`;
}

function completeFiles(options = {}) {
  return {
    "gradle/libs.versions.toml": VERSION_CATALOG,
    "app/build.gradle.kts": fixtureBuildFile(),
    "app/src/main/AndroidManifest.xml": manifest(),
    "app/src/main/java/com/agentbench/gallery/Main.kt": applicationSource(options),
    "app/src/main/java/com/agentbench/gallery/GalleryState.kt": stateSource(options),
    "app/src/main/java/com/agentbench/gallery/GalleryBundle.kt": galleryBundleSource(options),
    "app/src/main/java/com/agentbench/gallery/Orbit.kt": ORBIT_SOURCE,
    "app/src/main/java/com/agentbench/gallery/GalleryStage.kt": stageSource(options),
    "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": PLANE_SOURCE,
    "app/src/main/java/com/agentbench/gallery/platform/SpatialApplication.kt": APPLICATION_CLASS,
    "app/src/main/java/com/agentbench/gallery/platform/LaunchActivity.kt": ACTIVITY_CLASS,
    "app/src/test/java/com/agentbench/gallery/GalleryStateTest.kt": modelTestSource(options),
  };
}

function installProject(t, files) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbench-fixture-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.cpSync(SKELETON_DIR, projectDir, { recursive: true, dereference: false });
  for (const relative of [".gradle", "app/build", "app/src/main/java", "app/src/test/java", "app/src/androidTest/java"]) {
    fs.rmSync(path.join(projectDir, relative), { recursive: true, force: true });
  }
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(projectDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, "utf8");
  }
  return fs.realpathSync(projectDir);
}

export const UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS = Object.freeze([
  "state.shared-read-write",
  "state.reopen-wiring",
  "plane.retry-readiness",
]);

export function writeUncorrectedCheckpointProject(t) {
  return installProject(t, completeFiles());
}

export function writeCompleteProject(t, mutate = (files) => files) {
  const files = mutate(completeFiles());
  return installProject(t, files);
}

export function writeEquivalentReopenProject(t, mutate = (files) => files) {
  const files = mutate(completeFiles({ equivalent: true }));
  return installProject(t, files);
}

export function writeAndroidStyleProject(t) {
  const files = completeFiles();
  files["app/src/main/java/com/agentbench/gallery/Main.kt"] = `package com.agentbench.gallery

import android.app.Activity
import android.graphics.Canvas
import android.opengl.GLSurfaceView
import android.view.View

class MainActivity : Activity() {
    fun draw(canvas: Canvas, view: View, surface: GLSurfaceView) = Unit
}
`;
  for (const relative of Object.keys(files)) {
    if (relative.endsWith(".kt") && !relative.endsWith("Main.kt")) delete files[relative];
  }
  return installProject(t, files);
}

export const RULE_MUTATIONS = Object.freeze([
  { ruleId: "spatial.project-entry", apply: replace("fun mainApp", "fun notMainApp") },
  { ruleId: "spatial.container-topology", apply: replace("StageStyle.Mixed", "StageStyle.Full") },
  { ruleId: "spatial.entity-content", apply: replace("SpatialView(", "AndroidView(") },
  { ruleId: "spatial.ui-lifecycle", apply: replace("DefaultWindowContainer {\n        PicoTheme", "DefaultWindowContainer {\n        MaterialTheme") },
  { ruleId: "ecs.component-clone", apply: replace("OrbitComponent(enabled, angle)", "OrbitComponent()") },
  { ruleId: "ecs.system-query", apply: replace("private val orbitQuery = EntityQueryCondition.hasComponent(OrbitComponent::class.java)", "private val orbitQuery = EntityQueryCondition.never()") },
  { ruleId: "ecs.frame-update", apply: replace("context.deltaTime", "0.016f") },
  { ruleId: "ecs.lifecycle", apply: replace("unregisterSystem<OrbitSystem>()", "registerSystem<OrbitSystem>()") },
  { ruleId: "state.single-source", apply: replace("val sharedStore = BenchmarkStore.instance", "val sharedStore = BenchmarkStore()") },
  { ruleId: "state.typed-handoff", apply: replace("GallerySelection(selectedId)", "selectedId") },
  { ruleId: "state.shared-read-write", apply: replace("GalleryStage(bundle, sharedStore)", "GalleryStage(bundle, BenchmarkStore())") },
  { ruleId: "state.reopen-wiring", apply: replace("restoreRetainedState = true", "restoreRetainedState = false") },
  { ruleId: "plane.retry-readiness", apply: replace("repeat(MAX_ANCHOR_RETRIES)", "repeat(1)") },
  { ruleId: "plane.semantic-fallback", apply: replace("?: horizontalFloorPlane()", "?: null") },
  { ruleId: "plane.anchor-pose", apply: replace("root.convertPositionFrom(anchor.transform.position, null)", "Vector3(0f, 1f, 0f)") },
  { ruleId: "plane.cleanup-errors", apply: replace("planeSession.stopTrackingAndUnsubscribe()", "Unit") },
]);
