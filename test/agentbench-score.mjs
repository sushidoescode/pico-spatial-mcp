import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../benchmarks/spatial-agent-bench/lib/identity.mjs";
import { RULE_DEFINITIONS, TEST_EXECUTION_STREAM_MAX_BYTES } from "../benchmarks/spatial-agent-bench/lib/contract.mjs";
import { analyzeKotlin } from "../benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs";
import { loadSubmissionSources } from "../benchmarks/spatial-agent-bench/lib/source.mjs";
import { scoreSubmission } from "../benchmarks/spatial-agent-bench/lib/score.mjs";
import * as batch2bFixture from "./helpers/agentbench-fixture.mjs";
import {
  writeAndroidStyleProject,
  writeCompleteProject,
  writeEquivalentReopenProject,
  writeUncorrectedCheckpointProject,
} from "./helpers/agentbench-fixture.mjs";
import {
  parseFreshJUnitResults,
  runTrustedJUnitExecution,
  snapshotJUnitResults,
} from "./helpers/agentbench-junit.mjs";

const BUILD_RECEIPT = "a".repeat(64);
const PASSING_BUILD = Object.freeze({ status: "pass", receiptSha256: BUILD_RECEIPT });
const RULE_IDS = Object.freeze(RULE_DEFINITIONS.map(([id]) => id));
const HARDENED_BATCH2B_RULE_IDS = Object.freeze([
  "spatial.container-topology",
  "spatial.ui-lifecycle",
  "ecs.lifecycle",
  "state.shared-read-write",
  "state.reopen-wiring",
  "plane.retry-readiness",
  "plane.semantic-fallback",
]);
const FIXTURE_PROJECT_PATHS = Object.freeze([
  "gradle/libs.versions.toml",
  "app/build.gradle.kts",
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/com/agentbench/gallery/Main.kt",
  "app/src/main/java/com/agentbench/gallery/GalleryState.kt",
  "app/src/main/java/com/agentbench/gallery/GalleryBundle.kt",
  "app/src/main/java/com/agentbench/gallery/Orbit.kt",
  "app/src/main/java/com/agentbench/gallery/GalleryStage.kt",
  "app/src/main/java/com/agentbench/gallery/PlaneSession.kt",
  "app/src/main/java/com/agentbench/gallery/platform/SpatialApplication.kt",
  "app/src/main/java/com/agentbench/gallery/platform/LaunchActivity.kt",
  "app/src/test/java/com/agentbench/gallery/GalleryStateTest.kt",
]);
const RULE_ATTACK_SPECS = Object.freeze([
  Object.freeze({ ruleId: "spatial.project-entry", path: "app/src/main/java/com/agentbench/gallery/platform/SpatialApplication.kt", from: "launch(::mainApp)", to: "Unit", expectedFalseRuleIds: Object.freeze(["spatial.project-entry"]) }),
  Object.freeze({ ruleId: "spatial.container-topology", path: "app/src/main/java/com/agentbench/gallery/Main.kt", from: "StageStyle.Mixed", to: "StageStyle.Full", expectedFalseRuleIds: Object.freeze(["spatial.container-topology"]) }),
  Object.freeze({ ruleId: "spatial.entity-content", path: "app/src/main/java/com/agentbench/gallery/GalleryStage.kt", from: "content.addEntity(root)", to: "content.addEntity(Entity())", expectedFalseRuleIds: Object.freeze(["spatial.entity-content"]) }),
  Object.freeze({ ruleId: "spatial.ui-lifecycle", path: "app/src/main/java/com/agentbench/gallery/Main.kt", from: "PicoTheme { GalleryWindow(sharedStore) }", to: "GalleryWindow(sharedStore)", expectedFalseRuleIds: Object.freeze(["spatial.ui-lifecycle"]) }),
  Object.freeze({ ruleId: "ecs.component-clone", path: "app/src/main/java/com/agentbench/gallery/Orbit.kt", from: "OrbitComponent(enabled, angle)", to: "OrbitComponent()", expectedFalseRuleIds: Object.freeze(["ecs.component-clone"]) }),
  Object.freeze({ ruleId: "ecs.system-query", path: "app/src/main/java/com/agentbench/gallery/Orbit.kt", from: "EntityQueryCondition.hasComponent(OrbitComponent::class.java)", to: "EntityQueryCondition.never()", expectedFalseRuleIds: Object.freeze(["ecs.system-query"]) }),
  Object.freeze({ ruleId: "ecs.frame-update", path: "app/src/main/java/com/agentbench/gallery/Orbit.kt", from: "context.deltaTime", to: "0.016f", expectedFalseRuleIds: Object.freeze(["ecs.frame-update"]) }),
  Object.freeze({ ruleId: "ecs.lifecycle", path: "app/src/main/java/com/agentbench/gallery/GalleryStage.kt", from: "unregisterSystem<OrbitSystem>()", to: "registerSystem<OrbitSystem>()", expectedFalseRuleIds: Object.freeze(["ecs.lifecycle"]) }),
  Object.freeze({ ruleId: "state.single-source", path: "app/src/main/java/com/agentbench/gallery/Main.kt", from: "val sharedStore = BenchmarkStore.instance", to: "val sharedStore: BenchmarkStore get() = BenchmarkStore()", expectedFalseRuleIds: Object.freeze(["state.single-source", "state.shared-read-write", "state.reopen-wiring"]) }),
  Object.freeze({ ruleId: "state.typed-handoff", path: "app/src/main/java/com/agentbench/gallery/GalleryState.kt", from: "data class GallerySnapshot(", to: "class GallerySnapshot(", expectedFalseRuleIds: Object.freeze(["state.typed-handoff"]) }),
  Object.freeze({ ruleId: "state.shared-read-write", path: "app/src/main/java/com/agentbench/gallery/Main.kt", from: "store.select(\"vase\")", to: "Unit", expectedFalseRuleIds: Object.freeze(["state.shared-read-write"]) }),
  Object.freeze({ ruleId: "state.reopen-wiring", path: "app/src/main/java/com/agentbench/gallery/Main.kt", from: "restoreRetainedState = true", to: "restoreRetainedState = false", expectedFalseRuleIds: Object.freeze(["state.reopen-wiring"]) }),
  Object.freeze({ ruleId: "plane.retry-readiness", path: "app/src/main/java/com/agentbench/gallery/PlaneSession.kt", from: "MAX_ANCHOR_RETRIES = 4", to: "MAX_ANCHOR_RETRIES = 1", expectedFalseRuleIds: Object.freeze(["plane.retry-readiness"]) }),
  Object.freeze({ ruleId: "plane.semantic-fallback", path: "app/src/main/java/com/agentbench/gallery/PlaneSession.kt", from: "?: horizontalFloorPlane()", to: "?: null", expectedFalseRuleIds: Object.freeze(["plane.semantic-fallback"]) }),
  Object.freeze({ ruleId: "plane.anchor-pose", path: "app/src/main/java/com/agentbench/gallery/PlaneSession.kt", from: "root.convertPositionFrom(anchor.transform.position, null)", to: "Vector3(0f, 1f, 0f)", expectedFalseRuleIds: Object.freeze(["plane.anchor-pose"]) }),
  Object.freeze({ ruleId: "plane.cleanup-errors", path: "app/src/main/java/com/agentbench/gallery/GalleryStage.kt", from: "planeSession.stopTrackingAndUnsubscribe()", to: "Unit", expectedFalseRuleIds: Object.freeze(["plane.cleanup-errors"]) }),
]);
const PUBLIC_BASE_VECTORS = Object.freeze({
  correctedStandard: Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  correctedEquivalent: Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  uncorrected: Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, false, false,
    false, true, true, true,
  ]),
  rejected: Object.freeze([
    false, false, false, false,
    false, false, false, false,
    false, false, false, false,
    false, false, false, false,
  ]),
  equivalentCallbackAttack: Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, false,
    true, true, true, true,
  ]),
});
const PUBLIC_ATTACK_VECTORS = Object.freeze({
  "spatial.project-entry": Object.freeze([
    false, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  "spatial.container-topology": Object.freeze([
    true, false, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  "spatial.entity-content": Object.freeze([
    true, true, false, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  "spatial.ui-lifecycle": Object.freeze([
    true, true, true, false,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  "ecs.component-clone": Object.freeze([
    true, true, true, true,
    false, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  "ecs.system-query": Object.freeze([
    true, true, true, true,
    true, false, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  "ecs.frame-update": Object.freeze([
    true, true, true, true,
    true, true, false, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  "ecs.lifecycle": Object.freeze([
    true, true, true, true,
    true, true, true, false,
    true, true, true, true,
    true, true, true, true,
  ]),
  "state.single-source": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    false, true, false, false,
    true, true, true, true,
  ]),
  "state.typed-handoff": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, false, true, true,
    true, true, true, true,
  ]),
  "state.shared-read-write": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, false, true,
    true, true, true, true,
  ]),
  "state.reopen-wiring": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, false,
    true, true, true, true,
  ]),
  "plane.retry-readiness": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    false, true, true, true,
  ]),
  "plane.semantic-fallback": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, false, true, true,
  ]),
  "plane.anchor-pose": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, false, true,
  ]),
  "plane.cleanup-errors": Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, false,
  ]),
});
const PROJECTION_BOUNDARY_PATH = "app/src/main/java/com/agentbench/gallery/ProjectionBoundary.kt";
const PROJECTION_LINE_512 = `val ${"é".repeat(252)} = 1`;
const PROJECTION_LINE_513 = `val a${"é".repeat(252)} = 1`;
const PUBLIC_PROJECTION_BOUNDARY_VECTORS = Object.freeze({
  exact512: Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  exact513: Object.freeze([
    true, true, true, true,
    false, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
});
const PUBLIC_TYPED_FACT_BOUNDARY_VECTORS = Object.freeze({
  exact512: Object.freeze([
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
  exact513: Object.freeze([
    true, false, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ]),
});
const PUBLIC_DISCONNECTED_ATTACK_EXPECTATIONS = Object.freeze({
  "spatial.project-entry": Object.freeze({
    pass: Object.freeze([
      false, false, true, true,
      true, true, true, true,
      true, true, false, false,
      false, true, true, true,
    ]),
    falseIds: Object.freeze(["spatial.project-entry", "spatial.container-topology", "state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness"]),
    axes: Object.freeze({ spatialNative: 2, ecs: 4, statePassing: 2, planarTracking: 3 }),
    score: 11,
  }),
  "spatial.container-topology": Object.freeze({
    pass: Object.freeze([
      true, false, true, true,
      true, true, true, true,
      true, true, false, false,
      false, true, true, true,
    ]),
    falseIds: Object.freeze(["spatial.container-topology", "state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness"]),
    axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 2, planarTracking: 3 }),
    score: 12,
  }),
  "spatial.container-topology.full-decoy": Object.freeze({
    pass: Object.freeze([
      true, false, true, true,
      true, true, true, true,
      true, false, false, false,
      false, true, true, true,
    ]),
    falseIds: Object.freeze(["spatial.container-topology", "state.typed-handoff", "state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness"]),
    axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 1, planarTracking: 3 }),
    score: 11,
  }),
  "ecs.frame-update": Object.freeze({
    pass: Object.freeze([
      true, true, true, true,
      true, true, false, true,
      true, true, false, false,
      false, true, true, true,
    ]),
    falseIds: Object.freeze(["ecs.frame-update", "state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness"]),
    axes: Object.freeze({ spatialNative: 4, ecs: 3, statePassing: 2, planarTracking: 3 }),
    score: 12,
  }),
  "ecs.lifecycle": Object.freeze({
    pass: Object.freeze([
      true, true, true, true,
      true, true, true, false,
      true, true, false, false,
      false, true, true, true,
    ]),
    falseIds: Object.freeze(["ecs.lifecycle", "state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness"]),
    axes: Object.freeze({ spatialNative: 4, ecs: 3, statePassing: 2, planarTracking: 3 }),
    score: 12,
  }),
  "plane.retry-readiness": Object.freeze({
    pass: Object.freeze([
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
      false, true, true, true,
    ]),
    falseIds: Object.freeze(["plane.retry-readiness"]),
    axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 3 }),
    score: 15,
  }),
  "plane.retry-readiness.disconnected-load": Object.freeze({
    pass: Object.freeze([
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
      false, false, true, true,
    ]),
    falseIds: Object.freeze(["plane.retry-readiness", "plane.semantic-fallback"]),
    axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 2 }),
    score: 14,
  }),
  "plane.semantic-fallback": Object.freeze({
    pass: Object.freeze([
      true, true, true, true,
      true, true, true, true,
      true, true, false, false,
      false, false, true, true,
    ]),
    falseIds: Object.freeze(["state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness", "plane.semantic-fallback"]),
    axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 2, planarTracking: 2 }),
    score: 12,
  }),
  "plane.semantic-fallback.placement-bypass": Object.freeze({
    pass: Object.freeze([
      true, true, true, true,
      true, true, true, true,
      true, true, false, false,
      false, false, false, true,
    ]),
    falseIds: Object.freeze(["state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose"]),
    axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 2, planarTracking: 1 }),
    score: 11,
  }),
  "state.reopen-wiring": Object.freeze({
    pass: Object.freeze([
      true, true, true, true,
      true, true, true, true,
      true, true, true, false,
      true, true, true, true,
    ]),
    falseIds: Object.freeze(["state.reopen-wiring"]),
    axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 3, planarTracking: 4 }),
    score: 15,
  }),
});
const PUBLIC_DISCONNECTED_ATTACK_INVENTORY = Object.freeze([
  Object.freeze(["manifest classes do not match implementation", "spatial.project-entry", "spatial.project-entry"]),
  Object.freeze(["declared and opened Stage IDs differ", "spatial.container-topology", "spatial.container-topology"]),
  Object.freeze(["a matching-ID Full decoy cannot hide a wrong-ID Mixed open", "spatial.container-topology", "spatial.container-topology.full-decoy"]),
  Object.freeze(["an unused correct-ID Mixed helper cannot hide the invoked wrong-ID helper", "spatial.container-topology", "spatial.container-topology"]),
  Object.freeze(["deltaTime is observed but a fixed timestep drives motion", "ecs.frame-update", "ecs.frame-update"]),
  Object.freeze(["deltaTime appears only in a helper after the fixed-timestep update", "ecs.frame-update", "ecs.frame-update"]),
  Object.freeze(["System unregister is outside the owning effect", "ecs.lifecycle", "ecs.lifecycle"]),
  Object.freeze(["unregister spelling cannot impersonate registration", "ecs.lifecycle", "ecs.lifecycle"]),
  Object.freeze(["registration hidden inside an uncalled nested lambda", "ecs.lifecycle", "ecs.lifecycle"]),
  Object.freeze(["anchor loading is outside an empty retry loop", "plane.retry-readiness", "plane.retry-readiness.disconnected-load"]),
  Object.freeze(["retry readiness tests stale candidates instead of the loaded anchors", "plane.retry-readiness", "plane.retry-readiness.disconnected-load"]),
  Object.freeze(["loaded anchors are overwritten before the readiness check", "plane.retry-readiness", "plane.retry-readiness.disconnected-load"]),
  Object.freeze(["TABLE/FLOOR selection is unconstrained while checks live in an unused helper", "plane.semantic-fallback", "plane.semantic-fallback"]),
  Object.freeze(["placement bypasses otherwise constrained fallback helpers", "plane.semantic-fallback", "plane.semantic-fallback.placement-bypass"]),
  Object.freeze(["semantic, orientation, and area checks inspect different anchors", "plane.semantic-fallback", "plane.semantic-fallback"]),
  Object.freeze(["called area helper is constant while multiplication is unused", "plane.semantic-fallback", "plane.semantic-fallback"]),
  Object.freeze(["close path constructs a replacement state authority", "state.reopen-wiring", "state.reopen-wiring"]),
  Object.freeze(["retained field reads are outside the close/reopen path", "state.reopen-wiring", "state.reopen-wiring"]),
  Object.freeze(["retained field reads are ignored by restore", "state.reopen-wiring", "state.reopen-wiring"]),
]);
const PUBLIC_ATTACK_EXPECTATIONS = Object.freeze([
  Object.freeze({ ruleId: "spatial.project-entry", pass: PUBLIC_ATTACK_VECTORS["spatial.project-entry"], falseIds: Object.freeze(["spatial.project-entry"]), axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "spatial.container-topology", pass: PUBLIC_ATTACK_VECTORS["spatial.container-topology"], falseIds: Object.freeze(["spatial.container-topology"]), axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "spatial.entity-content", pass: PUBLIC_ATTACK_VECTORS["spatial.entity-content"], falseIds: Object.freeze(["spatial.entity-content"]), axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "spatial.ui-lifecycle", pass: PUBLIC_ATTACK_VECTORS["spatial.ui-lifecycle"], falseIds: Object.freeze(["spatial.ui-lifecycle"]), axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "ecs.component-clone", pass: PUBLIC_ATTACK_VECTORS["ecs.component-clone"], falseIds: Object.freeze(["ecs.component-clone"]), axes: Object.freeze({ spatialNative: 4, ecs: 3, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "ecs.system-query", pass: PUBLIC_ATTACK_VECTORS["ecs.system-query"], falseIds: Object.freeze(["ecs.system-query"]), axes: Object.freeze({ spatialNative: 4, ecs: 3, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "ecs.frame-update", pass: PUBLIC_ATTACK_VECTORS["ecs.frame-update"], falseIds: Object.freeze(["ecs.frame-update"]), axes: Object.freeze({ spatialNative: 4, ecs: 3, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "ecs.lifecycle", pass: PUBLIC_ATTACK_VECTORS["ecs.lifecycle"], falseIds: Object.freeze(["ecs.lifecycle"]), axes: Object.freeze({ spatialNative: 4, ecs: 3, statePassing: 4, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "state.single-source", pass: PUBLIC_ATTACK_VECTORS["state.single-source"], falseIds: Object.freeze(["state.single-source", "state.shared-read-write", "state.reopen-wiring"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 1, planarTracking: 4 }), score: 13 }),
  Object.freeze({ ruleId: "state.typed-handoff", pass: PUBLIC_ATTACK_VECTORS["state.typed-handoff"], falseIds: Object.freeze(["state.typed-handoff"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 3, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "state.shared-read-write", pass: PUBLIC_ATTACK_VECTORS["state.shared-read-write"], falseIds: Object.freeze(["state.shared-read-write"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 3, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "state.reopen-wiring", pass: PUBLIC_ATTACK_VECTORS["state.reopen-wiring"], falseIds: Object.freeze(["state.reopen-wiring"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 3, planarTracking: 4 }), score: 15 }),
  Object.freeze({ ruleId: "plane.retry-readiness", pass: PUBLIC_ATTACK_VECTORS["plane.retry-readiness"], falseIds: Object.freeze(["plane.retry-readiness"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 3 }), score: 15 }),
  Object.freeze({ ruleId: "plane.semantic-fallback", pass: PUBLIC_ATTACK_VECTORS["plane.semantic-fallback"], falseIds: Object.freeze(["plane.semantic-fallback"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 3 }), score: 15 }),
  Object.freeze({ ruleId: "plane.anchor-pose", pass: PUBLIC_ATTACK_VECTORS["plane.anchor-pose"], falseIds: Object.freeze(["plane.anchor-pose"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 3 }), score: 15 }),
  Object.freeze({ ruleId: "plane.cleanup-errors", pass: PUBLIC_ATTACK_VECTORS["plane.cleanup-errors"], falseIds: Object.freeze(["plane.cleanup-errors"]), axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 3 }), score: 15 }),
]);
const POSITIVE_SUBSET_REQUIREMENTS = Object.freeze([
  ["ecs.component-clone", "expression-component-clone", ["positional-fields", "named-fields"]],
  ["ecs.component-clone", "single-return-block-component-clone", ["positional-fields", "named-fields"]],
  ["ecs.frame-update", "assign-delta-update", ["direct-transform", "pure-helper-transform"]],
  ["ecs.frame-update", "plus-assign-delta-update", ["direct-transform", "pure-helper-transform"]],
  ["ecs.lifecycle", "paired-system-lifecycle", ["direct-register-unregister"]],
  ["ecs.system-query", "hoisted-query-scene-update", ["direct-query-use", "pure-helper-query-use"]],
  ["plane.anchor-pose", "same-anchor-pose-conversion", ["direct-pose-conversion", "pure-helper-pose-conversion"]],
  ["plane.cleanup-errors", "paired-plane-cleanup-status", ["direct-cleanup", "unique-helper-cleanup"]],
  ["plane.retry-readiness", "bounded-retained-load-retry", ["bounded-for", "canonical-bounded-while"]],
  ["plane.semantic-fallback", "dominating-semantic-plane-fallback", ["inline-selectors", "unique-helper-selectors"]],
  ["spatial.container-topology", "direct-mixed-stage-open", ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"]],
  ["spatial.container-topology", "one-helper-mixed-stage-open", ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"]],
  ["spatial.container-topology", "two-helper-mixed-stage-open", ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"]],
  ["spatial.entity-content", "spatial-view-entity-attachment", ["direct-initial-entity", "unique-helper-initial-entity"]],
  ["spatial.project-entry", "application-launch-root", ["direct-launch-import", "aliased-launch-import"]],
  ["spatial.ui-lifecycle", "themed-window-and-disposable-stage", ["direct-theme-paired-dispose"]],
  ["state.reopen-wiring", "retained-state-close-reopen", ["standard-store-reopen", "equivalent-repository-reopen"]],
  ["state.shared-read-write", "same-authority-read-write", ["direct-container-summaries"]],
  ["state.single-source", "shared-strong-authority", ["top-level-val", "object-singleton", "companion-held-singleton"]],
  ["state.typed-handoff", "typed-bundle-roundtrip", ["direct-bundle-adapter", "unique-helper-bundle-adapter"]],
].map(([ruleId, proofForm, alternativeIds]) => Object.freeze({
  ruleId,
  proofForm,
  alternativeIds: Object.freeze(alternativeIds),
})));
const UNCORRECTED_CLAIM_RULE_IDS_BY_PHASE = Object.freeze({
  migrated: Object.freeze(["ecs.component-clone"]),
  full: Object.freeze([
    "spatial.project-entry",
    "spatial.container-topology",
    "spatial.entity-content",
    "spatial.ui-lifecycle",
    "ecs.component-clone",
    "ecs.system-query",
    "ecs.frame-update",
    "ecs.lifecycle",
    "state.single-source",
    "state.typed-handoff",
    "plane.semantic-fallback",
    "plane.anchor-pose",
    "plane.cleanup-errors",
  ]),
});
const FULL_CORPUS_CLAIM_RULE_IDS_BY_RULE = Object.freeze({
  "spatial.project-entry": Object.freeze(["spatial.project-entry"]),
  "spatial.container-topology": Object.freeze(["spatial.project-entry", "spatial.container-topology"]),
  "spatial.entity-content": Object.freeze(["spatial.entity-content"]),
  "spatial.ui-lifecycle": Object.freeze(["spatial.ui-lifecycle"]),
  "ecs.component-clone": Object.freeze(["ecs.component-clone"]),
  "ecs.system-query": Object.freeze(["ecs.system-query"]),
  "ecs.frame-update": Object.freeze(["ecs.frame-update"]),
  "ecs.lifecycle": Object.freeze(["ecs.lifecycle"]),
  "state.single-source": Object.freeze(["state.single-source"]),
  "state.typed-handoff": Object.freeze(["state.typed-handoff"]),
  "state.shared-read-write": Object.freeze(["state.shared-read-write"]),
  "state.reopen-wiring": Object.freeze(["state.reopen-wiring"]),
  "plane.retry-readiness": Object.freeze(["plane.retry-readiness"]),
  "plane.semantic-fallback": Object.freeze(["plane.semantic-fallback"]),
  "plane.anchor-pose": Object.freeze(["plane.anchor-pose"]),
  "plane.cleanup-errors": Object.freeze(["plane.cleanup-errors"]),
});
const V5_ELIGIBLE_CLONE_SOURCE = `package cp2.v5

import com.pico.spatial.core.ecs.Component

class ProductionPathClone(
    val enabled: Boolean = true,
    val phase: Int = 0,
) : Component() {
    override fun clone(): ProductionPathClone = ProductionPathClone(enabled, phase)
}
`;

function v10ConditionSource(control) {
  return `package followup.conditions
class Holder(val ready: Boolean)
fun ready(): Boolean = true
fun probe(flag: Boolean, other: Boolean, holder: Holder) {
    ${control}
}
`;
}

function v10Fixture(id, files, analysisStatus = "accepted", rejectionCode = null) {
  return Object.freeze({
    id,
    files: Object.freeze(files.map(([relative, content]) => Object.freeze({ path: relative, content }))),
    expected: Object.freeze({
      analysisStatus,
      rejectionCode,
      nodes: Object.freeze([]),
      claims: Object.freeze([]),
    }),
  });
}

const V10_ACCEPTED_EMPTY_FIXTURES = Object.freeze([
  v10Fixture("one-anonymous-lambda", [["src/followup/accepted/one-anonymous-lambda.kt", `package followup.single
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
}
`]]),
  v10Fixture("two-sibling-lambdas", [["src/followup/accepted/two-sibling-lambdas.kt", `package followup.siblings
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
    consume { }
}
`]]),
  v10Fixture("Button-two-callback-PSI-shape", [["src/followup/accepted/Button-two-callback-PSI-shape.kt", `package followup.button
fun Button(onClick: () -> Unit, content: () -> Unit) = Unit
fun host() {
    Button(onClick = { }) { }
}
`]]),
  v10Fixture("anonymous-lambdas-under-distinct-named-owners", [["src/followup/accepted/anonymous-lambdas-under-distinct-named-owners.kt", `package followup.owners
fun consume(block: () -> Unit) = Unit
fun first() {
    consume { }
}
fun second() {
    consume { }
}
`]]),
  v10Fixture("multiple-constructor-declarations", [["src/followup/accepted/multiple-constructor-declarations.kt", `package followup.constructors
class Box() {
    constructor() : this()
}
`]]),
  v10Fixture("if-bare-name", [["src/followup/conditions/if-bare-name.kt", v10ConditionSource("if (flag) Unit")]]),
  v10Fixture("if-call-expression", [["src/followup/conditions/if-call-expression.kt", v10ConditionSource("if (ready()) Unit")]]),
  v10Fixture("if-binary", [["src/followup/conditions/if-binary.kt", v10ConditionSource("if (flag && other) Unit")]]),
  v10Fixture("if-qualified", [["src/followup/conditions/if-qualified.kt", v10ConditionSource("if (holder.ready) Unit")]]),
  v10Fixture("if-parenthesized", [["src/followup/conditions/if-parenthesized.kt", v10ConditionSource("if ((flag)) Unit")]]),
  v10Fixture("while-bare-name", [["src/followup/conditions/while-bare-name.kt", v10ConditionSource("while (flag) { break }")]]),
  v10Fixture("while-call-expression", [["src/followup/conditions/while-call-expression.kt", v10ConditionSource("while (ready()) { break }")]]),
  v10Fixture("while-binary", [["src/followup/conditions/while-binary.kt", v10ConditionSource("while (flag && other) { break }")]]),
  v10Fixture("while-qualified", [["src/followup/conditions/while-qualified.kt", v10ConditionSource("while (holder.ready) { break }")]]),
  v10Fixture("while-parenthesized", [["src/followup/conditions/while-parenthesized.kt", v10ConditionSource("while ((flag)) { break }")]]),
]);
const V10_REJECTED_EMPTY_FIXTURES = Object.freeze([
  v10Fixture("src-test-remains-indexed-for-ambiguity", [
    ["modules/kernel/src/main/kotlin/same/First.kt", "package followup2.kernel.same\nfun sameName(value: String): String = value\n"],
    ["modules/kernel/src/test/kotlin/same/Second.kt", "package followup2.kernel.same\nfun sameName(value: String): String = value\n"],
  ], "rejected", "ambiguous_index"),
  v10Fixture("duplicate-import-aliases", [["modules/kernel/src/main/kotlin/aliases/Collision.kt", `package followup2.kernel.aliases
import com.pico.spatial.ui.foundation.dsl.registerSystem as collide
import com.pico.spatial.ui.foundation.dsl.unregisterSystem as collide
fun collision() { collide() }
`]], "rejected", "incomplete_imports"),
  v10Fixture("same-owner-function-property-collision", [["src/followup/rejected/same-owner-function-property-collision.kt", `package followup.collision
fun duplicate() = Unit
val duplicate = Unit
`]], "rejected", "ambiguous_index"),
  v10Fixture("same-owner-real-named-overload-pair", [["src/followup/rejected/same-owner-real-named-overload-pair.kt", `package followup.overload
fun pick(value: Int) = value
fun pick(value: String) = value
`]], "rejected", "ambiguous_index"),
  v10Fixture("same-named-locals-under-sibling-anonymous-lambdas", [["src/followup/rejected/same-named-locals-under-sibling-anonymous-lambdas.kt", `package followup.locals
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { fun duplicate() = Unit }
    consume { fun duplicate() = Unit }
}
`]], "rejected", "ambiguous_index"),
]);

function assertDeepFrozen(value) {
  if (value && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const nested of Object.values(value)) assertDeepFrozen(nested);
  }
}

function changeOne(from, to) {
  return (files) => {
    const count = Object.values(files).reduce((sum, source) => sum + source.split(from).length - 1, 0);
    assert.equal(count, 1, `expected one test mutation occurrence of ${from}`);
    return Object.fromEntries(Object.entries(files).map(([name, source]) => [name, source.replace(from, to)]));
  };
}

function ruleById(score, id) {
  return score.rules.find((rule) => rule.id === id);
}

function claimRuleIds(response) {
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  return response.claims.map((claim) => claim.ruleId);
}

function analyzerRuleVector(response) {
  const claimed = new Set(response.claims.map((claim) => claim.ruleId));
  return RULE_IDS.map((ruleId) => claimed.has(ruleId));
}

function assertPublicScoreVector(score, expected, label) {
  assert.deepEqual(score.rules.map((rule) => rule.pass), expected.pass, `${label}: Boolean vector`);
  assert.deepEqual(score.rules.flatMap((rule) => rule.pass ? [] : [rule.id]), expected.falseIds, `${label}: false-ID vector`);
  assert.deepEqual(score.structuralAxes, expected.axes, `${label}: axis vector`);
  assert.equal(score.structuralScore, expected.score, `${label}: structural score`);
  assert.equal(score.buildQualifiedStructuralScore, expected.score, `${label}: qualified structural score`);
  if (expected.evidenceLengths !== undefined) {
    assert.deepEqual(score.rules.map((rule) => rule.evidence.length), expected.evidenceLengths, `${label}: evidence-length vector`);
  }
  for (const rule of score.rules) {
    if (rule.pass) assert.match(rule.reason, /^supported-subset-v1 witness:/, `${label}/${rule.id}: passing reason`);
    else assert.equal(rule.evidence.length, 0, `${label}/${rule.id}: failed evidence`);
  }
}

function mixedTypedConjunctions(index, response) {
  const ruleIds = new Set(claimRuleIds(response));
  const claimsByRule = new Map(response.claims.map((claim) => [claim.ruleId, claim]));
  const { gradle, manifest } = index.facts;
  const applicationId = gradle.applicationIds.length === 1 ? gradle.applicationIds[0] : null;
  const applicationName = applicationId && manifest.applicationName?.startsWith(".")
    ? `${applicationId}${manifest.applicationName}`
    : manifest.applicationName;
  const activityName = applicationId && manifest.activities.length === 1 && manifest.activities[0].startsWith(".")
    ? `${applicationId}${manifest.activities[0]}`
    : manifest.activities[0];
  function uniqueDeclarationWitness(expectedFqn, exactHeader) {
    const separator = expectedFqn.lastIndexOf(".");
    if (separator <= 0) return null;
    const packageName = expectedFqn.slice(0, separator);
    const matches = response.nodes.filter((node) => {
      if (node.kind !== "declaration") return false;
      const source = index.files.find((file) => file.kind === "kotlin" && file.path === node.path);
      if (!source || !source.original.startsWith(`package ${packageName}\n`)) return false;
      return source.original.slice(node.startUtf16, node.endUtf16).startsWith(exactHeader);
    });
    return matches.length === 1 ? matches[0].nodeId : null;
  }
  const applicationWitness = applicationName === null
    ? null
    : uniqueDeclarationWitness(applicationName, "class SpatialApplication : Application()");
  const activityWitness = activityName === null
    ? null
    : uniqueDeclarationWitness(activityName, "class LaunchActivity : SpatialLaunchActivity()");
  const projectEntryWitnesses = new Set(claimsByRule.get("spatial.project-entry")?.witnessNodeIds ?? []);
  const topologyWitnesses = new Set(claimsByRule.get("spatial.container-topology")?.witnessNodeIds ?? []);
  const projectEntry = ruleIds.has("spatial.project-entry")
    && gradle.pluginIds.includes("com.android.application")
    && gradle.versions.bom === "0.13.3"
    && gradle.moduleCoordinates.includes("com.pico.spatial.ui:foundation")
    && applicationId !== null
    && applicationName === "com.agentbench.gallery.platform.SpatialApplication"
    && activityName === "com.agentbench.gallery.platform.LaunchActivity"
    && applicationWitness !== null
    && activityWitness !== null
    && projectEntryWitnesses.has(applicationWitness)
    && projectEntryWitnesses.has(activityWitness);
  const ownedMetadata = manifest.metadata.filter((row) => row.scope === "activity" && row.activityName === ".platform.LaunchActivity");
  const metadataByName = new Map(ownedMetadata.map((row) => [row.name, row]));
  const containerTopology = ruleIds.has("spatial.container-topology")
    && manifest.activities.length === 1
    && activityName === "com.agentbench.gallery.platform.LaunchActivity"
    && activityWitness !== null
    && topologyWitnesses.has(activityWitness)
    && metadataByName.get("pico.spatial.windowcontainer.id")?.value === "BenchmarkWindow"
    && metadataByName.get("pico.spatial.windowcontainer.id")?.resource === null
    && metadataByName.get("pico.spatial.windowcontainer.style")?.value === "1"
    && metadataByName.get("pico.spatial.windowcontainer.style")?.resource === null
    && metadataByName.get("pico.spatial.windowcontainer.defaultsize")?.value === "1280x720"
    && metadataByName.get("pico.spatial.windowcontainer.defaultsize")?.resource === null;
  return Object.freeze({ projectEntry, containerTopology });
}

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function readFixtureProjectFiles(projectDir) {
  return Object.fromEntries(FIXTURE_PROJECT_PATHS.map((relative) => [
    relative,
    fs.readFileSync(path.join(projectDir, relative), "utf8"),
  ]));
}

function snapshotFixtureBytes(projectDir) {
  const rows = [];
  function walk(relative) {
    const directory = path.join(projectDir, relative);
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      assert.equal(entry.isSymbolicLink(), false, `${child}: fixture snapshot symlink`);
      if (entry.isDirectory()) walk(child);
      else {
        assert.equal(entry.isFile(), true, `${child}: fixture snapshot special file`);
        rows.push(Object.freeze({ path: child, bytes: fs.readFileSync(path.join(projectDir, child)) }));
      }
    }
  }
  walk("");
  rows.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return Object.freeze(rows);
}

function copySharedSkeletonToScratch(t, prefix) {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const sharedSkeletonDir = path.resolve(import.meta.dirname, "..", "appskeleton");
  const catalogRelativePath = path.join("gradle", "libs.versions.toml");
  const sharedCatalogPath = path.join(sharedSkeletonDir, catalogRelativePath);
  fs.cpSync(sharedSkeletonDir, projectDir, {
    recursive: true,
    dereference: false,
    filter: (source) => path.resolve(source) !== sharedCatalogPath,
  });
  fs.copyFileSync(
    path.resolve(import.meta.dirname, "..", "benchmarks/spatial-agent-bench/fixtures/gradle/libs.versions.toml"),
    path.join(projectDir, catalogRelativePath),
  );
  return projectDir;
}

function replaceFixturePathOnce(relative, from, to) {
  return (files) => {
    assert.equal(Object.hasOwn(files, relative), true, `missing fixture path ${relative}`);
    assert.equal(occurrenceCount(files[relative], from), 1, `${relative}: expected one occurrence of ${from}`);
    return { ...files, [relative]: files[relative].replace(from, to) };
  };
}

function appendFixturePath(relative, suffix) {
  return (files) => {
    assert.equal(Object.hasOwn(files, relative), true, `missing fixture path ${relative}`);
    return { ...files, [relative]: `${files[relative]}${suffix}` };
  };
}

function composeFixtureMutations(...mutations) {
  return (files) => mutations.reduce((current, mutate) => mutate(current), files);
}

function writeLegacyScoreProject(t, mutate = (files) => files) {
  const projectDir = writeUncorrectedCheckpointProject(t);
  const files = mutate(readFixtureProjectFiles(projectDir));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.resolve(projectDir, relative);
    assert.equal(target.startsWith(`${projectDir}${path.sep}`), true, `legacy fixture path ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, "utf8");
  }
  return projectDir;
}

function writeLegacyEquivalentScoreProject(t, mutate = (files) => files) {
  const planePath = "app/src/main/java/com/agentbench/gallery/PlaneSession.kt";
  const orbitPath = "app/src/main/java/com/agentbench/gallery/Orbit.kt";
  const mainPath = "app/src/main/java/com/agentbench/gallery/Main.kt";
  const correctedRetry = `            for (attempt in 0 until MAX_ANCHOR_RETRIES) {
                val loaded = PlaneTrackingManager.loadAllAnchors().toList()
                candidates = loaded
                if (loaded.isNotEmpty()) break
                delay(25L)
            }`;
  const rawRetry = `            repeat(MAX_ANCHOR_RETRIES) {
                candidates = PlaneTrackingManager.loadAllAnchors().toList()
                if (candidates.isNotEmpty()) return@repeat
                delay(25L)
            }`;
  const correctedClose = `private suspend fun SpatialNavigator.closeAndReopenEquivalent(stateOwner: GallerySessionRepository) {
    closeStage()
    showMixedContainer(
        initialState = GallerySessionSnapshot.empty(),
        stateOwner = stateOwner,
        stateOnReentry = museumSessionRepository::currentSnapshot,
    )
}`;
  const legacyClose = `private suspend fun SpatialNavigator.closeAndReopenEquivalent(stateOwner: GallerySessionRepository) {
    closeStage()
    showMixedContainer(
        initialState = museumSessionRepository.currentSnapshot(),
        stateOwner = museumSessionRepository,
        stateOnReentry = museumSessionRepository::currentSnapshot,
    )
    val selection = museumSessionRepository.currentSnapshot().selection
    val visitCount = museumSessionRepository.currentSnapshot().visitCount
    val paused = museumSessionRepository.currentSnapshot().paused
    stateOwner.restore(GallerySessionSnapshot(selection, visitCount, paused))
}`;
  return writeEquivalentReopenProject(t, composeFixtureMutations(
    replaceFixturePathOnce(
      orbitPath,
      "private val orbitQuery: EntityQueryCondition = EntityQueryCondition.hasComponent(OrbitComponent::class.java)",
      "private val orbitQuery = EntityQueryCondition.hasComponent(OrbitComponent::class.java)",
    ),
    replaceFixturePathOnce(planePath, correctedRetry, rawRetry),
    replaceFixturePathOnce(mainPath, correctedClose, legacyClose),
    mutate,
  ));
}

function analyzeProject(projectDir) {
  const index = loadSubmissionSources(projectDir);
  return Object.freeze({ index, response: analyzeKotlin(index) });
}

function writeIsolatedKotlinProject(t, files, prefix) {
  assert.equal(Array.isArray(files), true, `${prefix}: files`);
  assert.equal(files.length > 0, true, `${prefix}: empty file vector`);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, prefix)));
  assert.equal(path.dirname(projectDir), temporaryRoot, `${prefix}: temporary parent`);
  t.after(() => {
    if (!fs.existsSync(projectDir)) return;
    assert.equal(fs.lstatSync(projectDir).isSymbolicLink(), false, `${prefix}: cleanup root symlink`);
    assert.equal(fs.realpathSync(projectDir), projectDir, `${prefix}: cleanup root identity`);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  const seen = new Set();
  for (const [index, file] of files.entries()) {
    assert.deepEqual(Object.keys(file), ["path", "content"], `${prefix}/${index}: file schema`);
    assertNormalizedCorpusPath(file.path, `${prefix}/${index}`);
    assert.equal(typeof file.content, "string", `${prefix}/${file.path}: content type`);
    assert.equal(seen.has(file.path), false, `${prefix}: duplicate path ${file.path}`);
    seen.add(file.path);
    const target = path.join(projectDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { encoding: "utf8", mode: 0o600 });
  }
  return projectDir;
}

function analysisResponseVector(response) {
  return {
    analysisStatus: response.analysisStatus,
    rejectionCode: response.rejectionCode,
    nodes: response.nodes,
    claims: response.claims,
  };
}

function assertExactRuleIdVector(ruleIds, label) {
  assert.equal(Array.isArray(ruleIds), true, `${label}: vector type`);
  assert.deepEqual(ruleIds, RULE_IDS.filter((ruleId) => ruleIds.includes(ruleId)),
    `${label}: exact ordered unique known-rule vector`);
  return ruleIds;
}

function exactPhaseClaimRuleIds(phaseTable, phase, label) {
  assert.deepEqual(Object.keys(phaseTable), ["migrated", "full"], `${label}: exact phase table`);
  assert.equal(Object.hasOwn(phaseTable, phase), true, `${label}: known phase`);
  return assertExactRuleIdVector(phaseTable[phase], `${label}/${phase}`);
}

function assertAcceptedClaimIds(response, expectedRuleIds, label = "analysis") {
  assert.equal(response.analysisStatus, "accepted", label);
  assert.equal(response.rejectionCode, null, label);
  assert.deepEqual(response.claims.map((claim) => claim.ruleId), expectedRuleIds, label);
  assert.equal(new Set(response.claims.map((claim) => claim.ruleId)).size, response.claims.length, `${label}: duplicate claim`);
  const nodeIds = response.nodes.map((node) => node.nodeId);
  assert.equal(new Set(nodeIds).size, nodeIds.length, `${label}: duplicate node`);
  const validatedNodeIds = new Set(nodeIds);
  const claimedNodeIds = new Set();
  for (const claim of response.claims) {
    assert.equal(typeof claim.proofForm, "string", `${label}/${claim.ruleId}: proof form type`);
    assert.notEqual(claim.proofForm.length, 0, `${label}/${claim.ruleId}: empty proof form`);
    assert.equal(Array.isArray(claim.witnessNodeIds), true, `${label}/${claim.ruleId}: witness list`);
    assert.equal(claim.witnessNodeIds.length > 0, true, `${label}/${claim.ruleId}: empty witness list`);
    assert.equal(new Set(claim.witnessNodeIds).size, claim.witnessNodeIds.length, `${label}/${claim.ruleId}: duplicate witness`);
    for (const nodeId of claim.witnessNodeIds) {
      assert.equal(validatedNodeIds.has(nodeId), true, `${label}/${claim.ruleId}: unknown witness ${nodeId}`);
      claimedNodeIds.add(nodeId);
    }
  }
  assert.deepEqual(nodeIds, [...claimedNodeIds].sort(), `${label}: catalog must be the ordered claim-witness union`);
}

function assertRejectedWithoutSemantics(response, rejectionCode, label) {
  assert.equal(response.analysisStatus, "rejected", label);
  assert.equal(response.rejectionCode, rejectionCode, label);
  assert.deepEqual(response.nodes, [], label);
  assert.deepEqual(response.claims, [], label);
}

function assertOnlyRuleIdsAbsent(response, absentRuleIds, label) {
  const absent = new Set(absentRuleIds);
  assertAcceptedClaimIds(response, RULE_IDS.filter((ruleId) => !absent.has(ruleId)), label);
}

let batch2bCorpusModulePromise;
async function loadBatch2bCorpusModule() {
  batch2bCorpusModulePromise ??= import("./helpers/agentbench-analyzer-corpus.mjs")
    .catch((loadError) => Object.freeze({ loadError }));
  return batch2bCorpusModulePromise;
}

function requireBatch2bExport(namespace, name, expectedType) {
  const detail = namespace.loadError instanceof Error ? ` (${namespace.loadError.message})` : "";
  assert.equal(typeof namespace[name], expectedType, `missing Batch2B export ${name}${detail}`);
  return namespace[name];
}

function listKotlinFiles(projectDir) {
  const paths = [];
  function walk(relative) {
    const directory = path.join(projectDir, relative);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      assert.equal(entry.isSymbolicLink(), false, `${child}: materialized corpus path must not be a symlink`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".kt")) paths.push(child);
    }
  }
  walk("");
  return paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function assertNormalizedCorpusPath(relative, label) {
  assert.equal(typeof relative, "string", `${label}: path type`);
  assert.equal(relative.length > 0, true, `${label}: empty path`);
  assert.equal(relative, relative.normalize("NFC"), `${label}: path must be NFC`);
  assert.equal(path.posix.normalize(relative), relative, `${label}: path must be normalized`);
  assert.equal(path.posix.isAbsolute(relative), false, `${label}: absolute path`);
  assert.equal(relative.includes("\\"), false, `${label}: backslash path`);
  assert.equal(relative.split("/").includes(".."), false, `${label}: parent traversal`);
  assert.equal(relative.endsWith(".kt"), true, `${label}: expected Kotlin source`);
}

function assertKotlinFileRows(rows, label) {
  assert.equal(Array.isArray(rows), true, `${label}: kotlinFiles must be an array`);
  assert.equal(rows.length > 0, true, `${label}: empty Kotlin closure`);
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(Object.keys(row), ["path", "bytes", "sha256"], `${label}/${index}: schema`);
    assertNormalizedCorpusPath(row.path, `${label}/${index}`);
    assert.equal(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 1_048_576, true, `${label}/${row.path}: byte bound`);
    assert.match(row.sha256, /^[0-9a-f]{64}$/, `${label}/${row.path}: hash`);
    assert.equal(seen.has(row.path), false, `${label}: duplicate path ${row.path}`);
    seen.add(row.path);
  }
}

function assertMaterializedKotlinFiles(projectDir, rows, label) {
  assert.deepEqual(listKotlinFiles(projectDir), rows.map((row) => row.path).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))), `${label}: exact stored Kotlin paths`);
  const sources = new Map();
  for (const row of rows) {
    const bytes = fs.readFileSync(path.join(projectDir, row.path));
    assert.equal(bytes.length, row.bytes, `${label}/${row.path}: stored byte count`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), row.sha256, `${label}/${row.path}: stored hash`);
    sources.set(row.path, bytes.toString("utf8"));
  }
  return sources;
}

function assertDeclarationNamespacesIsolated(sources, label) {
  const declarations = new Set();
  const modifiers = "(?:(?:public|private|internal|protected|expect|actual|open|final|abstract|sealed|data|enum|annotation|value|inline|tailrec|suspend|operator|infix|external|const|lateinit)\\s+)*";
  const declarationPattern = new RegExp(
    `^${modifiers}(?:(?:class|interface|object|val|var|typealias)\\s+([A-Za-z_][A-Za-z0-9_]*)|fun\\s+(?:[A-Za-z_][A-Za-z0-9_.?<>]*\\.)?([A-Za-z_][A-Za-z0-9_]*))`,
    "gm",
  );
  for (const [relative, source] of sources) {
    const packageName = /^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*$/m.exec(source)?.[1];
    assert.equal(typeof packageName, "string", `${label}/${relative}: explicit package`);
    let count = 0;
    for (const match of source.matchAll(declarationPattern)) {
      const declaration = `${packageName}.${match[1] ?? match[2]}`;
      assert.equal(declarations.has(declaration), false, `${label}: colliding declaration ${declaration}`);
      declarations.add(declaration);
      count += 1;
    }
    assert.equal(count > 0, true, `${label}/${relative}: no top-level declaration`);
  }
}

function corpusFileIdentity(row) {
  return `${row.path}\0${row.bytes}\0${row.sha256}`;
}

function assertCorrectedFixtureShape(projectDir, equivalent) {
  const main = fs.readFileSync(path.join(projectDir, "app/src/main/java/com/agentbench/gallery/Main.kt"), "utf8");
  const plane = fs.readFileSync(path.join(projectDir, "app/src/main/java/com/agentbench/gallery/PlaneSession.kt"), "utf8");
  for (const requiredImport of [
    "import androidx.compose.runtime.rememberCoroutineScope",
    "import com.pico.spatial.ui.design.Button",
    "import kotlinx.coroutines.launch",
  ]) assert.equal(occurrenceCount(main, requiredImport), 1, `${requiredImport}: corrected import`);
  assert.equal(main.includes(`val actionScope = rememberCoroutineScope()`), true);
  assert.equal(main.includes(`Button(onClick = { ${equivalent ? "stateOwner" : "store"}.select("vase") }) { Text("Select vase") }`), true);
  assert.equal(main.includes(`actionScope.launch { navigator.${equivalent ? "closeAndReopenEquivalent(stateOwner)" : "closeAndReopen(store)"} }`), true);
  assert.equal(plane.includes(`for (attempt in 0 until MAX_ANCHOR_RETRIES) {
                val loaded = PlaneTrackingManager.loadAllAnchors().toList()
                candidates = loaded
                if (loaded.isNotEmpty()) break
                delay(25L)
            }`), true, "corrected retry must retain and test one loaded origin");
  assert.equal(plane.includes("return@repeat"), false, "corrected retry must not retain the raw repeat control flow");
  if (equivalent) {
    for (const forbidden of ["sharedStore", "openGalleryStage", "restoreRetainedState"]) assert.equal(main.includes(forbidden), false, `equivalent fixture contains ${forbidden}`);
    assert.equal(main.includes(`val launchSnapshot: () -> GallerySessionSnapshot = { stateOwner.currentSnapshot() }`), true);
    assert.equal(main.includes(`initialState = launchSnapshot(),
            stateOwner = stateOwner,
            stateOnReentry = launchSnapshot,`), true);
    assert.equal(occurrenceCount(main, "museumSessionRepository::currentSnapshot"), 1, "equivalent decisive callback seam");
    assert.equal(main.includes(`initialState = GallerySessionSnapshot.empty(),
        stateOwner = stateOwner,
        stateOnReentry = museumSessionRepository::currentSnapshot,`), true);
    assert.equal(main.includes("val reentry = stateOnReentry()"), true);
    assert.equal(main.includes("stateOwner.restore(reentry)"), true);
    assert.equal(
      main.includes("GalleryBundle.encode(reentry)") || ["reentry.selection", "reentry.visitCount", "reentry.paused"].every((field) => main.includes(field)),
      true,
      "equivalent reopen must encode the callback result",
    );
  } else {
    assert.equal(main.includes(`state = store.snapshot(),
            store = store,
            restoreRetainedState = false,`), true, "standard initial open must use the literal false mode");
    assert.equal(occurrenceCount(main, "restoreRetainedState = true"), 1, "standard decisive reopen seam");
    assert.equal(main.includes(`state = GallerySnapshot.empty(),
        store = store,
        restoreRetainedState = true,`), true);
    assert.equal(main.includes("val handoff = if (restoreRetainedState) store.snapshot() else state"), true);
    assert.equal(main.includes("GalleryBundle.encode(handoff)"), true);
  }
}

function observedSubmission(status) {
  const hash = (character) => character.repeat(64);
  const counts = status === "pass"
    ? { testCount: 1, passedCount: 1, failureCount: 0, errorCount: 0, skippedCount: 0 }
    : status === "fail"
      ? { testCount: 1, passedCount: 0, failureCount: 1, errorCount: 0, skippedCount: 0 }
      : { testCount: 0, passedCount: 0, failureCount: 0, errorCount: 0, skippedCount: 0 };
  const hasXml = status === "pass" || status === "fail";
  const observed = status !== "not_run";
  const record = {
    evidenceClass: "submission_test",
    status,
    ...counts,
    preBuildResultsSha256: observed ? hash("b") : null,
    resultFiles: hasXml ? [{ path: "app/build/test-results/testDebugUnitTest/TEST-gallery.xml", bytes: 123, sha256: hash("c") }] : [],
    testExecutionReceiptSha256: observed ? hash("d") : null,
    receiptSha256: null,
  };
  if (observed) {
    const body = { ...record };
    delete body.receiptSha256;
    record.receiptSha256 = crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
  }
  return record;
}

// Phase discriminator. This file cannot import `liveDomainPhase` or the frozen canary constant —
// nothing is exported from test/agentbench-kotlin-analysis.mjs — so the phase is derived here from
// the tracked domain's own content. It admits only an exact canonical symbol-vector digest, never
// a row count or canary-membership predicate: either weaker shape admits unintended states.
const TRACKED_DOMAIN_PATH = path.resolve(
  import.meta.dirname, "../benchmarks/spatial-agent-bench/analyzer/domain-v1.json");
const DOMAIN_SYMBOL_PHASE_BY_SHA256 = Object.freeze({
  "2ef2253fe7619607f9dd470d48fbc52343c1c54aa081338c08067cd5f08a9f58": "migrated",
  "88e61320f227751c9a7f5469ac61581cd3736ba37292c41f859faa77bf48ff04": "full",
});
function classifyDomainPhase(symbols) {
  const digest = crypto.createHash("sha256").update(canonicalJson(symbols), "utf8").digest("hex");
  const phase = DOMAIN_SYMBOL_PHASE_BY_SHA256[digest];
  if (phase === undefined) {
    throw new Error("domain-v1.json symbols are neither the migrated-canary nor FULL Batch 2B phase");
  }
  return phase;
}
function liveDomainPhase() {
  const symbols = JSON.parse(fs.readFileSync(TRACKED_DOMAIN_PATH, "utf8")).symbols;
  return classifyDomainPhase(symbols);
}

test("domain phase classification rejects empty partial reordered and unknown symbol vectors", () => {
  const migrated = [
    {
      arguments: [], callbacks: [], closedMemberSet: false, conformsTo: [], effects: ["construct"],
      fqn: "com.pico.spatial.core.ecs.Component", kind: "constructor", memberPrecedence: "not_applicable",
      operatorForm: null, receiverAbstractType: null, receiverKind: "none", returnAbstractType: "component",
      returnSource: null, signature: "Component()", typeArguments: [],
    },
    {
      arguments: [], callbacks: [], closedMemberSet: false, conformsTo: [], effects: [],
      fqn: "com.pico.spatial.core.ecs.Component", kind: "type", memberPrecedence: "not_applicable",
      operatorForm: null, receiverAbstractType: null, receiverKind: "none", returnAbstractType: "component",
      returnSource: null, signature: "open class Component", typeArguments: [],
    },
    {
      arguments: [], callbacks: [], closedMemberSet: false, conformsTo: [], effects: ["construct"],
      fqn: "com.pico.spatial.core.ecs.Component.clone", kind: "member_function", memberPrecedence: "sdk_member_wins",
      operatorForm: null, receiverAbstractType: "component", receiverKind: "instance", returnAbstractType: "component",
      returnSource: null, signature: "clone(): Component", typeArguments: [],
    },
  ];
  assert.equal(classifyDomainPhase(migrated), "migrated");
  for (const candidate of [
    [],
    migrated.slice(0, 2),
    migrated.toReversed(),
    [...migrated, { ...migrated[0], fqn: "com.example.Unknown" }],
  ]) {
    assert.throws(() => classifyDomainPhase(candidate), /neither the migrated-canary nor FULL Batch 2B phase/);
  }
});

test("CP2 phase-scoped score oracles bind exact claim vectors", () => {
  assertDeepFrozen(UNCORRECTED_CLAIM_RULE_IDS_BY_PHASE);
  assertDeepFrozen(FULL_CORPUS_CLAIM_RULE_IDS_BY_RULE);
  assert.deepEqual(Object.keys(UNCORRECTED_CLAIM_RULE_IDS_BY_PHASE), ["migrated", "full"]);
  assert.deepEqual(
    exactPhaseClaimRuleIds(UNCORRECTED_CLAIM_RULE_IDS_BY_PHASE, "migrated", "uncorrected fixture"),
    ["ecs.component-clone"],
  );
  assert.deepEqual(
    exactPhaseClaimRuleIds(UNCORRECTED_CLAIM_RULE_IDS_BY_PHASE, "full", "uncorrected fixture"),
    RULE_IDS.filter((ruleId) => ![
      "state.shared-read-write",
      "state.reopen-wiring",
      "plane.retry-readiness",
    ].includes(ruleId)),
  );
  assert.deepEqual(Object.keys(FULL_CORPUS_CLAIM_RULE_IDS_BY_RULE), RULE_IDS);
  for (const ruleId of RULE_IDS) {
    const expected = ruleId === "spatial.container-topology"
      ? ["spatial.project-entry", "spatial.container-topology"]
      : [ruleId];
    assert.deepEqual(
      assertExactRuleIdVector(FULL_CORPUS_CLAIM_RULE_IDS_BY_RULE[ruleId], `FULL corpus/${ruleId}`),
      expected,
      `${ruleId}: exact isolated corpus vector`,
    );
  }
  assert.deepEqual(FULL_CORPUS_CLAIM_RULE_IDS_BY_RULE["spatial.ui-lifecycle"], ["spatial.ui-lifecycle"],
    "UI stays singleton after the reviewed platform-source removal");

  const ownedSource = fs.readFileSync(new URL(import.meta.url), "utf8");
  const directClaimCardinalityAssertion = new RegExp(
    String.raw`assert\.(?:equal|notEqual|ok)\(\s*(?:response\.claims|claimRuleIds\([^)]*\))\.length\b`,
    "g",
  );
  assert.deepEqual([...ownedSource.matchAll(directClaimCardinalityAssertion)].map((match) => match[0]), [],
    "phase-scoped claim expectations must use an exact vector, never direct claim cardinality");
  assert.match(ownedSource,
    /exactPhaseClaimRuleIds\(\s*UNCORRECTED_CLAIM_RULE_IDS_BY_PHASE, phase, "uncorrected fixture"\)/,
    "uncorrected fixture must select its exact phase vector through the guarded table");
  assert.match(ownedSource,
    /FULL_CORPUS_CLAIM_RULE_IDS_BY_RULE\[row\.ruleId\]/,
    "FULL corpus cases must select exact vectors through the guarded rule map");
});

test("uncorrected fixture preserves the thirteen-claim subset-v1 oracle", (t) => {
  assert.equal(typeof batch2bFixture.writeUncorrectedCheckpointProject, "function");
  assert.deepEqual(batch2bFixture.UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS, [
    "state.shared-read-write",
    "state.reopen-wiring",
    "plane.retry-readiness",
  ]);
  const projectDir = batch2bFixture.writeUncorrectedCheckpointProject(t);
  const index = loadSubmissionSources(projectDir);
  const response = analyzeKotlin(index);
  const falseIds = new Set(batch2bFixture.UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS);
  const expectedPositiveIds = RULE_DEFINITIONS.map(([id]) => id).filter((id) => !falseIds.has(id));
  const phase = liveDomainPhase();
  const expectedPhaseIds = exactPhaseClaimRuleIds(
    UNCORRECTED_CLAIM_RULE_IDS_BY_PHASE, phase, "uncorrected fixture");
  // The false-rule projection is phase-independent: it is a statement about RULE_DEFINITIONS and
  // the frozen false-id list, not about what the analyzer emitted.
  assert.deepEqual(
    RULE_DEFINITIONS.map(([id]) => expectedPositiveIds.includes(id)).flatMap((passed, index) => passed ? [] : [RULE_DEFINITIONS[index][0]]),
    batch2bFixture.UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS,
  );
  assertAcceptedClaimIds(response, expectedPhaseIds, `uncorrected fixture/${phase}`);
  if (phase === "full") {
    assert.deepEqual(expectedPhaseIds, expectedPositiveIds,
      "FULL phase literal is exactly the thirteen non-defect rules");
    assert.deepEqual(mixedTypedConjunctions(index, response), { projectEntry: true, containerTopology: true });
    const hardened = new Set(claimRuleIds(response));
    for (const id of ["spatial.container-topology", "ecs.lifecycle", "plane.semantic-fallback"]) assert.equal(hardened.has(id), true, id);
    for (const id of ["state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness"]) assert.equal(hardened.has(id), false, id);
  }
});

test("V5 production-path filtering distinguishes byte-identical eligible clone sources", (t) => {
  const mainPath = "modules/v5/src/main/kotlin/cp2/v5/ProductionPathClone.kt";
  const testPath = "modules/v5/src/test/kotlin/cp2/v5/ProductionPathClone.kt";
  const mainDir = writeIsolatedKotlinProject(t, [
    { path: mainPath, content: V5_ELIGIBLE_CLONE_SOURCE },
  ], "agentbench-cp2-v5-main-");
  const testDir = writeIsolatedKotlinProject(t, [
    { path: testPath, content: V5_ELIGIBLE_CLONE_SOURCE },
  ], "agentbench-cp2-v5-test-");
  const mainBytes = fs.readFileSync(path.join(mainDir, mainPath));
  const testBytes = fs.readFileSync(path.join(testDir, testPath));
  assert.deepEqual(mainBytes, Buffer.from(V5_ELIGIBLE_CLONE_SOURCE, "utf8"), "main source exact bytes");
  assert.deepEqual(testBytes, Buffer.from(V5_ELIGIBLE_CLONE_SOURCE, "utf8"), "test source exact bytes");
  assert.deepEqual(mainBytes, testBytes, "V5 source bytes differ only by production/test path eligibility");

  const mainResponse = analyzeProject(mainDir).response;
  assertAcceptedClaimIds(mainResponse, ["ecs.component-clone"], "V5 /src/main/ clone");
  assert.deepEqual(
    mainResponse.nodes.map((node) => node.nodeId),
    [...new Set(mainResponse.claims.flatMap((claim) => claim.witnessNodeIds))].sort(),
    "V5 /src/main/ nodes are exactly the clone witness union",
  );
  const testResponse = analyzeProject(testDir).response;
  assert.deepEqual(analysisResponseVector(testResponse), {
    analysisStatus: "accepted",
    rejectionCode: null,
    nodes: [],
    claims: [],
  }, "V5 byte-identical /src/test/ source is exactly semantically empty");
});

test("V10 historical empty fixtures retain exact accepted and rejected response vectors", async (t) => {
  assertDeepFrozen(V10_ACCEPTED_EMPTY_FIXTURES);
  assertDeepFrozen(V10_REJECTED_EMPTY_FIXTURES);
  assert.deepEqual(V10_ACCEPTED_EMPTY_FIXTURES.map(({ id }) => id), [
    "one-anonymous-lambda",
    "two-sibling-lambdas",
    "Button-two-callback-PSI-shape",
    "anonymous-lambdas-under-distinct-named-owners",
    "multiple-constructor-declarations",
    "if-bare-name",
    "if-call-expression",
    "if-binary",
    "if-qualified",
    "if-parenthesized",
    "while-bare-name",
    "while-call-expression",
    "while-binary",
    "while-qualified",
    "while-parenthesized",
  ], "exact fifteen accepted-empty historical fixtures");
  assert.deepEqual(V10_REJECTED_EMPTY_FIXTURES.map(({ id }) => id), [
    "src-test-remains-indexed-for-ambiguity",
    "duplicate-import-aliases",
    "same-owner-function-property-collision",
    "same-owner-real-named-overload-pair",
    "same-named-locals-under-sibling-anonymous-lambdas",
  ], "exact five rejected-empty historical fixtures");

  for (const fixture of [...V10_ACCEPTED_EMPTY_FIXTURES, ...V10_REJECTED_EMPTY_FIXTURES]) {
    await t.test(fixture.id, (t) => {
      const projectDir = writeIsolatedKotlinProject(t, fixture.files, "agentbench-cp2-v10-");
      assert.deepEqual(
        fixture.files.map((file) => fs.readFileSync(path.join(projectDir, file.path), "utf8")),
        fixture.files.map((file) => file.content),
        `${fixture.id}: exact source bytes`,
      );
      assert.deepEqual(
        analysisResponseVector(analyzeProject(projectDir).response),
        fixture.expected,
        `${fixture.id}: exact status/code/nodes/claims vector`,
      );
    });
  }
});

test("corrected subset forms emit all sixteen claims from the exact standard and equivalent seams", (t) => {
  for (const [name, writer, equivalent] of [
    ["standard", writeCompleteProject, false],
    ["equivalent", writeEquivalentReopenProject, true],
  ]) {
    const projectDir = writer(t);
    assertCorrectedFixtureShape(projectDir, equivalent);
    const { response } = analyzeProject(projectDir);
    assertAcceptedClaimIds(response, RULE_IDS, `${name} corrected fixture`);
  }
});

test("benchmark fixture output is independent of shared skeleton catalog bytes", async (t) => {
  const corpus = await loadBatch2bCorpusModule();
  const writeCase = requireBatch2bExport(corpus, "writePositiveSubsetCase", "function");
  const writeAggregate = requireBatch2bExport(corpus, "writePositiveSubsetCompileAggregate", "function");
  const controlSkeleton = copySharedSkeletonToScratch(t, "agentbench-catalog-control-");
  const mutatedSkeleton = copySharedSkeletonToScratch(t, "agentbench-catalog-mutated-");
  const canaryPath = "benchmark-skeleton-copy-canary.txt";
  const canaryBytes = Buffer.from("scratch skeleton override reached\n", "utf8");
  const mutationTargetPath = "shared-catalog-mutation-target.toml";
  const mutationTargetBytes = Buffer.from('[versions]\nbom = "6.0.0"\n', "utf8");
  for (const skeletonDir of [controlSkeleton, mutatedSkeleton]) {
    fs.writeFileSync(path.join(skeletonDir, canaryPath), canaryBytes);
    fs.writeFileSync(path.join(skeletonDir, mutationTargetPath), mutationTargetBytes);
  }
  fs.rmSync(path.join(mutatedSkeleton, "gradle/libs.versions.toml"));
  fs.symlinkSync(`../${mutationTargetPath}`, path.join(mutatedSkeleton, "gradle/libs.versions.toml"));

  const identity = (files) => files;
  const writers = Object.freeze([
    Object.freeze(["uncorrected", (context, skeletonDir) => writeUncorrectedCheckpointProject(context, { skeletonDir })]),
    Object.freeze(["complete", (context, skeletonDir) => writeCompleteProject(context, identity, { skeletonDir })]),
    Object.freeze(["equivalent", (context, skeletonDir) => writeEquivalentReopenProject(context, identity, { skeletonDir })]),
    Object.freeze(["android-style", (context, skeletonDir) => writeAndroidStyleProject(context, { skeletonDir })]),
    Object.freeze(["cp1-case", (context, skeletonDir) => writeCase(
      context,
      "topology.direct-mixed-stage-open.named-literal-stage-id.alpha",
      { skeletonDir },
    )]),
    Object.freeze(["cp1-aggregate", (context, skeletonDir) => writeAggregate(
      context,
      "cp1-spatial-emitters",
      { skeletonDir },
    )]),
  ]);
  const pairs = writers.map(([name, writeFixture]) => Object.freeze({
    name,
    control: snapshotFixtureBytes(writeFixture(t, controlSkeleton)),
    mutated: snapshotFixtureBytes(writeFixture(t, mutatedSkeleton)),
  }));

  assert.deepEqual(
    pairs.map(({ name, control, mutated }) => Object.freeze({
      name,
      control: control.find(({ path: relative }) => relative === canaryPath)?.bytes,
      mutated: mutated.find(({ path: relative }) => relative === canaryPath)?.bytes,
    })),
    writers.map(([name]) => Object.freeze({ name, control: canaryBytes, mutated: canaryBytes })),
    "exact scratch-skeleton override canary vector",
  );
  assert.deepEqual(
    pairs.map(({ name, control, mutated }) => Object.freeze({ name, control, mutated })),
    pairs.map(({ name, control }) => Object.freeze({ name, control, mutated: control })),
    "exact sorted fixture path/byte vectors",
  );
  assert.deepEqual(
    pairs.flatMap(({ name, control, mutated }) => [
      [name, "control", crypto.createHash("sha256").update(
        control.find(({ path: relative }) => relative === "gradle/libs.versions.toml")?.bytes ?? Buffer.alloc(0),
      ).digest("hex")],
      [name, "mutated", crypto.createHash("sha256").update(
        mutated.find(({ path: relative }) => relative === "gradle/libs.versions.toml")?.bytes ?? Buffer.alloc(0),
      ).digest("hex")],
    ]),
    writers.flatMap(([name]) => [
      [name, "control", "45f21462ffe2746dac3fff54200a5c995692fc6a481ab3f12dd2a43ab9637cd3"],
      [name, "mutated", "45f21462ffe2746dac3fff54200a5c995692fc6a481ab3f12dd2a43ab9637cd3"],
    ]),
    "exact pinned 0.13.3 catalog hash vector",
  );
});

test("subset forms freeze exact RULE_ATTACKS and equivalent reopen path-scoped seams", (t) => {
  const attacks = batch2bFixture.RULE_ATTACKS;
  assert.equal(Array.isArray(attacks), true, "missing Batch2B export RULE_ATTACKS");
  assertDeepFrozen(attacks);
  assert.deepEqual(attacks.map(({ ruleId }) => ruleId), RULE_IDS);
  assert.equal(attacks.length, RULE_ATTACK_SPECS.length);

  const projectDir = writeCompleteProject(t);
  assertCorrectedFixtureShape(projectDir, false);
  const fixtureFiles = readFixtureProjectFiles(projectDir);
  for (const [index, attack] of attacks.entries()) {
    const spec = RULE_ATTACK_SPECS[index];
    assert.deepEqual(Object.keys(attack), ["ruleId", "expectedFalseRuleIds", "apply"], `${spec.ruleId}: row schema`);
    assert.equal(attack.ruleId, spec.ruleId);
    assert.deepEqual(attack.expectedFalseRuleIds, spec.expectedFalseRuleIds, `${spec.ruleId}: expected vector`);
    assert.equal(typeof attack.apply, "function", `${spec.ruleId}: apply`);
    assert.equal(Object.values(fixtureFiles).reduce((count, source) => count + occurrenceCount(source, spec.from), 0), 1, `${spec.ruleId}: globally unique seam`);
    assert.equal(occurrenceCount(fixtureFiles[spec.path], spec.from), 1, `${spec.ruleId}: target seam`);

    const changed = attack.apply(fixtureFiles);
    assert.deepEqual(Object.keys(changed), Object.keys(fixtureFiles), `${spec.ruleId}: path set`);
    assert.deepEqual(
      Object.keys(changed).filter((relative) => changed[relative] !== fixtureFiles[relative]),
      [spec.path],
      `${spec.ruleId}: isolated path`,
    );
    assert.equal(changed[spec.path], fixtureFiles[spec.path].replace(spec.from, spec.to), `${spec.ruleId}: exact replacement`);

    const wrongPath = "app/src/main/java/com/agentbench/gallery/GalleryBundle.kt";
    const missingAtTarget = {
      ...fixtureFiles,
      [spec.path]: fixtureFiles[spec.path].replace(spec.from, "__removed_attack_seam__"),
      [wrongPath]: `${fixtureFiles[wrongPath]}\n${spec.from}\n`,
    };
    assert.throws(() => attack.apply(missingAtTarget), /path|seam|occurrence|exactly one|replacement/i, `${spec.ruleId}: wrong-path seam must reject`);
    assert.throws(() => attack.apply({
      ...fixtureFiles,
      [wrongPath]: `${fixtureFiles[wrongPath]}\n${spec.from}\n`,
    }), /path|seam|occurrence|exactly one|replacement/i, `${spec.ruleId}: duplicate seam must reject`);
  }

  const equivalentAttack = batch2bFixture.EQUIVALENT_REOPEN_ATTACK;
  assert.equal(equivalentAttack && typeof equivalentAttack === "object", true, "missing Batch2B export EQUIVALENT_REOPEN_ATTACK");
  assertDeepFrozen(equivalentAttack);
  assert.deepEqual(Object.keys(equivalentAttack), ["ruleId", "expectedFalseRuleIds", "apply"]);
  assert.equal(equivalentAttack.ruleId, "state.reopen-wiring");
  assert.deepEqual(equivalentAttack.expectedFalseRuleIds, ["state.reopen-wiring"]);
  assert.equal(typeof equivalentAttack.apply, "function");
  const equivalentDir = writeEquivalentReopenProject(t);
  assertCorrectedFixtureShape(equivalentDir, true);
  const equivalentFiles = readFixtureProjectFiles(equivalentDir);
  const equivalentPath = "app/src/main/java/com/agentbench/gallery/Main.kt";
  const equivalentFrom = "museumSessionRepository::currentSnapshot";
  const equivalentTo = "GallerySessionSnapshot::empty";
  assert.equal(Object.values(equivalentFiles).reduce((count, source) => count + occurrenceCount(source, equivalentFrom), 0), 1);
  const equivalentChanged = equivalentAttack.apply(equivalentFiles);
  assert.deepEqual(Object.keys(equivalentChanged).filter((relative) => equivalentChanged[relative] !== equivalentFiles[relative]), [equivalentPath]);
  assert.equal(equivalentChanged[equivalentPath], equivalentFiles[equivalentPath].replace(equivalentFrom, equivalentTo));
  assert.throws(() => equivalentAttack.apply({
    ...equivalentFiles,
    "app/src/main/java/com/agentbench/gallery/GalleryBundle.kt": `${equivalentFiles["app/src/main/java/com/agentbench/gallery/GalleryBundle.kt"]}\n${equivalentFrom}\n`,
  }), /path|seam|occurrence|exactly one|replacement/i);
});

test("round 4 adversarial forms omit only the affected semantic claim", async (t) => {
  const baseline = analyzeProject(writeCompleteProject(t)).response;
  assertAcceptedClaimIds(baseline, RULE_IDS, "round 4 positive prerequisite");
  const planePath = "app/src/main/java/com/agentbench/gallery/PlaneSession.kt";
  const mainPath = "app/src/main/java/com/agentbench/gallery/Main.kt";
  const stagePath = "app/src/main/java/com/agentbench/gallery/GalleryStage.kt";
  const cases = [
    ["correct open reachable only through an unused helper", "spatial.container-topology", composeFixtureMutations(
      replaceFixturePathOnce(mainPath, "openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)", "openStage(\"DifferentStage\", StageStyle.Mixed, bundle)"),
      appendFixturePath(mainPath, "\nprivate suspend fun SpatialNavigator.unusedCorrectOpen(bundle: android.os.Bundle) { openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle) }\nprivate suspend fun SpatialNavigator.unusedCaller(bundle: android.os.Bundle) { unusedCorrectOpen(bundle) }\n"),
    )],
    ["registration only in an uncalled local function", "ecs.lifecycle", replaceFixturePathOnce(
      stagePath,
      "        registerSystem<OrbitSystem>()",
      "        fun neverRegister() = registerSystem<OrbitSystem>()",
    )],
    ["isEmpty is not readiness", "plane.retry-readiness", replaceFixturePathOnce(
      planePath,
      "if (loaded.isNotEmpty()) break",
      "if (loaded.isEmpty()) break",
    )],
    ["semantic orientation and area predicates are OR-separated", "plane.semantic-fallback", composeFixtureMutations(
      replaceFixturePathOnce(
        planePath,
        ".filter { it.semantics == SemanticLabelType.TABLE && isHorizontal(it) && area(it) > 0f }",
        ".filter { it.semantics == SemanticLabelType.TABLE || isHorizontal(it) || area(it) > 0f }",
      ),
      replaceFixturePathOnce(
        planePath,
        ".filter { it.semantics == SemanticLabelType.FLOOR && isHorizontal(it) && area(it) > 0f }",
        ".filter { it.semantics == SemanticLabelType.FLOOR || isHorizontal(it) || area(it) > 0f }",
      ),
    )],
    ["constrained fallback result is ignored", "plane.semantic-fallback", replaceFixturePathOnce(
      planePath,
      "val anchor = horizontalTablePlane() ?: horizontalFloorPlane()",
      "val ignored = horizontalTablePlane() ?: horizontalFloorPlane()\n            val anchor = candidates.firstOrNull()",
    )],
    ["correct restore is followed by a constant overwrite", "state.reopen-wiring", replaceFixturePathOnce(
      mainPath,
      "store.restore(GallerySnapshot(selection, visitCount, paused))",
      "store.restore(GallerySnapshot(selection, visitCount, paused))\n    store.restore(GallerySnapshot(null, 0, false))",
    )],
  ];
  for (const [name, ruleId, mutate] of cases) await t.test(name, (t) => {
    const response = analyzeProject(writeCompleteProject(t, mutate)).response;
    assertOnlyRuleIdsAbsent(response, [ruleId], name);
  });
});

test("baseline attacks fail closed for reachability resolution control flow and whole-program boundaries", async (t) => {
  const baseline = analyzeProject(writeCompleteProject(t)).response;
  assertAcceptedClaimIds(baseline, RULE_IDS, "baseline-attack positive prerequisite");
  const mainPath = "app/src/main/java/com/agentbench/gallery/Main.kt";
  const stagePath = "app/src/main/java/com/agentbench/gallery/GalleryStage.kt";
  const planePath = "app/src/main/java/com/agentbench/gallery/PlaneSession.kt";
  const correctedRetry = `for (attempt in 0 until MAX_ANCHOR_RETRIES) {
                val loaded = PlaneTrackingManager.loadAllAnchors().toList()
                candidates = loaded
                if (loaded.isNotEmpty()) break
                delay(25L)
            }`;
  const rawRepeatRetry = `repeat(MAX_ANCHOR_RETRIES) {
                candidates = PlaneTrackingManager.loadAllAnchors().toList()
                if (candidates.isNotEmpty()) return@repeat
                delay(25L)
            }`;
  const depthHelpers = Array.from({ length: 10 }, (_, index) => {
    const body = index === 9
      ? "openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)"
      : `depth${index + 1}(bundle)`;
    return `private suspend fun SpatialNavigator.depth${index}(bundle: android.os.Bundle) { ${body} }`;
  }).join("\n");
  const acceptedCases = [
    ["return at repeat is not retained-value loop success", ["plane.retry-readiness"], replaceFixturePathOnce(planePath, correctedRetry, rawRepeatRetry)],
    ["close and reopen helper is unreachable", ["state.reopen-wiring"], replaceFixturePathOnce(mainPath, "actionScope.launch { navigator.closeAndReopen(store) }", "Unit")],
    ["Window is read-only", ["state.shared-read-write"], replaceFixturePathOnce(mainPath, "Button(onClick = { store.select(\"vase\") })", "Button(onClick = { Unit })")],
    ["SDK registration name is lexically shadowed", ["ecs.lifecycle"], replaceFixturePathOnce(
      stagePath,
      "        registerSystem<OrbitSystem>()",
      "        fun <T> registerSystem() = Unit\n        registerSystem<OrbitSystem>()",
    )],
    ["unknown receiver and member do not attach the entity", ["spatial.entity-content"], replaceFixturePathOnce(stagePath, "content.addEntity(root)", "unknownContent.addEntity(root)")],
    ["unknown source extension has no SDK attachment effect", ["spatial.entity-content"], composeFixtureMutations(
      replaceFixturePathOnce(stagePath, "content.addEntity(root)", "content.publishEntity(root)"),
      appendFixturePath(stagePath, "\nprivate fun Any.publishEntity(entity: Entity) = Unit\n"),
    )],
    ["custom iterator operators do not establish a bounded integer range", ["plane.retry-readiness", "plane.semantic-fallback"], composeFixtureMutations(
      replaceFixturePathOnce(planePath, "0 until MAX_ANCHOR_RETRIES", "RetryBounds()"),
      appendFixturePath(planePath, "\nprivate class RetryBounds { operator fun iterator(): Iterator<Int> = emptyList<Int>().iterator() }\n"),
    )],
    ["shared authority escapes through an unknown call", ["state.single-source", "state.shared-read-write", "state.reopen-wiring"], replaceFixturePathOnce(
      mainPath,
      "fun mainApp(scope: SpatialAppScope) = with(scope) {",
      "fun mainApp(scope: SpatialAppScope) = with(scope) {\n    externalAuthoritySink(sharedStore)",
    )],
    ["recursive helper does not make a reachable mixed open", ["spatial.container-topology", "state.typed-handoff", "state.reopen-wiring"], composeFixtureMutations(
      replaceFixturePathOnce(mainPath, "openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)", "recursiveMixedOpen(bundle)"),
      appendFixturePath(mainPath, "\nprivate suspend fun SpatialNavigator.recursiveMixedOpen(bundle: android.os.Bundle) { recursiveMixedOpen(bundle) }\n"),
    )],
    ["call depth overflow does not make a reachable mixed open", ["spatial.container-topology", "state.typed-handoff", "state.reopen-wiring"], composeFixtureMutations(
      replaceFixturePathOnce(mainPath, "openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)", "depth0(bundle)"),
      appendFixturePath(mainPath, `\n${depthHelpers}\n`),
    )],
  ];
  for (const [name, absentRuleIds, mutate] of acceptedCases) await t.test(name, (t) => {
    const response = analyzeProject(writeCompleteProject(t, mutate)).response;
    assertOnlyRuleIdsAbsent(response, absentRuleIds, name);
  });

  const rejectedCases = [
    ["Kotlin script", "unsupported_script", (files) => ({ ...files, "app/src/main/java/com/agentbench/gallery/Unsupported.kts": "val unsupported = 1\n" })],
    ["malformed competing Kotlin", "parse", (files) => ({ ...files, "app/src/main/java/com/agentbench/gallery/Broken.kt": "package com.agentbench.gallery\nfun broken( {\n" })],
    ["overload ambiguity", "ambiguous_index", composeFixtureMutations(
      replaceFixturePathOnce(stagePath, "content.addEntity(root)", "publishEntity(root)"),
      appendFixturePath(stagePath, "\nprivate fun publishEntity(entity: Entity) = Unit\nprivate fun publishEntity(entity: Any) = Unit\n"),
    )],
    ["whole-graph declaration limit", "limit", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/DeclarationLimit.kt": `package com.agentbench.gallery.limit\n${Array.from({ length: 25_001 }, (_, index) => `class Declaration${index}`).join("\n")}\n`,
    })],
  ];
  for (const [name, rejectionCode, mutate] of rejectedCases) await t.test(name, (t) => {
    const response = analyzeProject(writeCompleteProject(t, mutate)).response;
    assertRejectedWithoutSemantics(response, rejectionCode, name);
  });
});

test("CP1 positive subset corpus freezes exact closures aggregates and spatial emitter forms", async (t) => {
  const corpus = await loadBatch2bCorpusModule();
  const cases = requireBatch2bExport(corpus, "POSITIVE_SUBSET_V1_CASES", "object");
  const aggregates = requireBatch2bExport(corpus, "POSITIVE_SUBSET_V1_COMPILE_AGGREGATES", "object");
  const writeCase = requireBatch2bExport(corpus, "writePositiveSubsetCase", "function");
  const writeAggregate = requireBatch2bExport(corpus, "writePositiveSubsetCompileAggregate", "function");
  assert.equal(Array.isArray(cases), true);
  assert.equal(Array.isArray(aggregates), true);
  const phase = liveDomainPhase();
  const cp1Requirements = POSITIVE_SUBSET_REQUIREMENTS.filter(({ ruleId }) =>
    ruleId === "spatial.container-topology" || ruleId === "spatial.ui-lifecycle");
  const activeRequirements = phase === "migrated" ? cp1Requirements : POSITIVE_SUBSET_REQUIREMENTS;
  if (phase === "migrated") {
    assert.equal(cases.length, 38, "CP1 exact positive case count");
    assert.equal(aggregates.length, 1, "CP1 exact compile aggregate count");
    assert.equal(aggregates[0].kotlinFiles.length, 77, "CP1 exact aggregate Kotlin file count");
  } else {
    assert.equal(cases.length >= 100 && cases.length <= 128, true, "FULL positive case count");
    assert.equal(aggregates.length >= 1 && aggregates.length <= 8, true, "FULL compile aggregate count");
  }
  assertDeepFrozen(cases);
  assertDeepFrozen(aggregates);

  const caseIds = new Set();
  const aggregateIds = new Set();
  const aggregateById = new Map();
  for (const [index, aggregate] of aggregates.entries()) {
    assert.deepEqual(Object.keys(aggregate), ["id", "kotlinFiles"], `aggregate ${index}: schema`);
    assert.match(aggregate.id, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, `aggregate ${index}: id`);
    assert.equal(aggregate.id, aggregate.id.normalize("NFC"));
    assert.equal(aggregateIds.has(aggregate.id), false, `duplicate aggregate ${aggregate.id}`);
    aggregateIds.add(aggregate.id);
    aggregateById.set(aggregate.id, aggregate);
    assertKotlinFileRows(aggregate.kotlinFiles, `aggregate ${aggregate.id}`);
    assert.equal(aggregate.kotlinFiles.length <= 512, true, `${aggregate.id}: analyzer file bound`);
    assert.equal(aggregate.kotlinFiles.reduce((sum, row) => sum + row.bytes, 0) <= 8_388_608, true, `${aggregate.id}: analyzer total-byte bound`);
  }

  const allowedTuples = new Set(activeRequirements.flatMap(({ ruleId, proofForm, alternativeIds }) =>
    alternativeIds.map((alternativeId) => `${ruleId}\0${proofForm}\0${alternativeId}`)));
  const tupleCounts = new Map();
  const closureIdentitiesByTuple = new Map();
  const pathIdentities = new Map();
  const aggregateIdentityCounts = new Map();
  for (const aggregate of aggregates) for (const row of aggregate.kotlinFiles) {
    const identity = corpusFileIdentity(row);
    aggregateIdentityCounts.set(identity, (aggregateIdentityCounts.get(identity) ?? 0) + 1);
  }

  const caseIdentities = new Set();
  for (const [index, row] of cases.entries()) {
    assert.deepEqual(Object.keys(row), ["id", "ruleId", "proofForm", "alternativeId", "compileAggregateId", "kotlinFiles"], `case ${index}: schema`);
    assert.match(row.id, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, `case ${index}: id`);
    assert.equal(row.id, row.id.normalize("NFC"));
    assert.equal(caseIds.has(row.id), false, `duplicate case ${row.id}`);
    caseIds.add(row.id);
    assert.equal(RULE_IDS.includes(row.ruleId), true, `${row.id}: known rule`);
    const tuple = `${row.ruleId}\0${row.proofForm}\0${row.alternativeId}`;
    assert.equal(allowedTuples.has(tuple), true, `${row.id}: unknown proof/alternative tuple`);
    tupleCounts.set(tuple, (tupleCounts.get(tuple) ?? 0) + 1);
    const closureIdentity = canonicalJson(row.kotlinFiles.map(({ bytes, sha256 }) => ({ bytes, sha256 }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256, "en") || left.bytes - right.bytes));
    const tupleClosures = closureIdentitiesByTuple.get(tuple) ?? new Set();
    tupleClosures.add(closureIdentity);
    closureIdentitiesByTuple.set(tuple, tupleClosures);
    assert.equal(aggregateById.has(row.compileAggregateId), true, `${row.id}: missing aggregate ${row.compileAggregateId}`);
    assertKotlinFileRows(row.kotlinFiles, `case ${row.id}`);
    for (const file of row.kotlinFiles) {
      const identity = corpusFileIdentity(file);
      caseIdentities.add(identity);
      assert.equal(aggregateIdentityCounts.get(identity), 1, `${row.id}/${file.path}: exact one-aggregate byte closure`);
      const prior = pathIdentities.get(file.path);
      if (prior !== undefined) assert.equal(prior, `${file.bytes}\0${file.sha256}`, `${file.path}: reused support bytes differ`);
      else pathIdentities.set(file.path, `${file.bytes}\0${file.sha256}`);
    }

    const projectDir = writeCase(t, row.id);
    const sources = assertMaterializedKotlinFiles(projectDir, row.kotlinFiles, `case ${row.id}`);
    assertDeclarationNamespacesIsolated(sources, `case ${row.id}`);
    if (phase === "full" && row.ruleId === "spatial.ui-lifecycle") {
      assert.deepEqual(
        row.kotlinFiles.filter(({ path: relative }) => /\/platform\//.test(`/${relative}`)).map(({ path: relative }) => relative),
        [],
        `${row.id}: reviewed platform-source removal keeps the UI closure isolated`,
      );
    }
    if (phase === "full" || HARDENED_BATCH2B_RULE_IDS.includes(row.ruleId)) {
      const response = analyzeProject(projectDir).response;
      const expectedRuleIds = phase === "migrated"
        ? assertExactRuleIdVector([], `positive case ${row.id}/migrated`)
        : assertExactRuleIdVector(
          FULL_CORPUS_CLAIM_RULE_IDS_BY_RULE[row.ruleId], `positive case ${row.id}/full`);
      assertAcceptedClaimIds(response, expectedRuleIds, `positive case ${row.id}`);
      if (phase === "full") {
        const ownedClaim = response.claims.find((claim) => claim.ruleId === row.ruleId);
        assert.equal(ownedClaim?.proofForm, row.proofForm, `${row.id}: exact proof form`);
      }
    }
  }
  assert.equal(caseIds.size, cases.length);
  assert.deepEqual([...tupleCounts.keys()].sort(), [...allowedTuples].sort(), "exact active tuple vector");
  for (const requirement of activeRequirements) for (const alternativeId of requirement.alternativeIds) {
    const tuple = `${requirement.ruleId}\0${requirement.proofForm}\0${alternativeId}`;
    assert.equal(tupleCounts.get(tuple), 2, `${tuple}: exact independently named pair`);
    assert.equal(closureIdentitiesByTuple.get(tuple)?.size, 2,
      `${tuple}: pair must have distinct path-independent byte closures`);
  }
  for (const [identity, count] of aggregateIdentityCounts) {
    assert.equal(count, 1, `${identity}: aggregate byte row must be unique`);
    assert.equal(caseIdentities.has(identity), true, `${identity}: orphan aggregate source`);
  }
  if (phase === "full") {
    assert.equal(tupleCounts.get("plane.retry-readiness\0bounded-retained-load-retry\0bounded-for"), 2);
    assert.equal(tupleCounts.get("plane.retry-readiness\0bounded-retained-load-retry\0canonical-bounded-while"), 2);
  }

  for (const aggregate of aggregates) {
    const projectDir = writeAggregate(t, aggregate.id);
    const sources = assertMaterializedKotlinFiles(projectDir, aggregate.kotlinFiles, `aggregate ${aggregate.id}`);
    assertDeclarationNamespacesIsolated(sources, `aggregate ${aggregate.id}`);
    const testRows = aggregate.kotlinFiles.filter((row) => /\/src\/test\//.test(`/${row.path}`));
    assert.equal(testRows.length, 1, `${aggregate.id}: exactly one JVM test source`);
    assert.equal(occurrenceCount(sources.get(testRows[0].path), "@Test"), 1, `${aggregate.id}: exactly one compile-smoke test`);
    assert.equal(aggregate.kotlinFiles.some((row) => /\/src\/androidTest\//.test(`/${row.path}`)), false, `${aggregate.id}: no instrumentation test`);
  }
  assert.throws(() => writeCase(t, "missing-positive-subset-case"), /case|unknown|missing|id/i);
  assert.throws(() => writeAggregate(t, "missing-positive-subset-aggregate"), /aggregate|unknown|missing|id/i);
});

test("complete Kotlin rejection returns the exact all-false public vector", (t) => {
  const projectDir = writeLegacyScoreProject(t);
  const scriptPath = path.join(projectDir, "app/src/main/java/com/agentbench/gallery/Rejected.kts");
  fs.writeFileSync(scriptPath, "val rejectedScript = true\n", "utf8");
  const response = analyzeKotlin(loadSubmissionSources(projectDir));
  assert.equal(response.analysisStatus, "rejected");
  assert.equal(response.rejectionCode, "unsupported_script");
  assert.deepEqual(response.nodes, []);
  assert.deepEqual(response.claims, []);
  assert.deepEqual(analyzerRuleVector(response), [
    false, false, false, false,
    false, false, false, false,
    false, false, false, false,
    false, false, false, false,
  ]);

  const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
  assert.deepEqual(score.rules.map((rule) => rule.pass), PUBLIC_BASE_VECTORS.rejected);
  assert.deepEqual(score.rules.flatMap((rule) => rule.pass ? [] : [rule.id]), [
    "spatial.project-entry", "spatial.container-topology", "spatial.entity-content", "spatial.ui-lifecycle",
    "ecs.component-clone", "ecs.system-query", "ecs.frame-update", "ecs.lifecycle",
    "state.single-source", "state.typed-handoff", "state.shared-read-write", "state.reopen-wiring",
    "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose", "plane.cleanup-errors",
  ]);
  assert.deepEqual(score.rules.map((rule) => rule.evidence.length), [
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  assert.deepEqual(score.structuralAxes, {
    spatialNative: 0,
    ecs: 0,
    statePassing: 0,
    planarTracking: 0,
  });
  assert.equal(score.structuralScore, 0);
  assert.equal(score.buildQualifiedStructuralScore, 0);
  for (const rule of score.rules) assert.equal(rule.reason, "supported-subset-v1 rejected: unsupported_script");
});

test("uncorrected checkpoint returns the exact thirteen-point public vector", (t) => {
  const projectDir = writeUncorrectedCheckpointProject(t);
  const response = analyzeKotlin(loadSubmissionSources(projectDir));
  assert.deepEqual(analyzerRuleVector(response), [
    true, true, true, true,
    true, true, true, true,
    true, true, false, false,
    false, true, true, true,
  ], "uncorrected checkpoint: independent analyzer vector");
  const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
  assertPublicScoreVector(score, {
    pass: PUBLIC_BASE_VECTORS.uncorrected,
    falseIds: ["state.shared-read-write", "state.reopen-wiring", "plane.retry-readiness"],
    axes: { spatialNative: 4, ecs: 4, statePassing: 2, planarTracking: 3 },
    score: 13,
    evidenceLengths: [12, 15, 7, 9, 6, 4, 5, 5, 8, 13, 0, 0, 0, 8, 6, 15],
  }, "uncorrected checkpoint");
});

test("perfect structural fixture returns the exact rubric-v2 result contract", (t) => {
  const projectDir = writeCompleteProject(t);

  const first = scoreSubmission({ projectDir, build: PASSING_BUILD });
  const second = scoreSubmission({ projectDir, build: PASSING_BUILD });
  const response = analyzeKotlin(loadSubmissionSources(projectDir));

  assertDeepFrozen(PUBLIC_BASE_VECTORS);
  assert.deepEqual(first.rules.map(({ id }) => id), RULE_DEFINITIONS.map(([id]) => id));
  assertPublicScoreVector(first, {
    pass: PUBLIC_BASE_VECTORS.correctedStandard,
    falseIds: [],
    axes: { spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 4 },
    score: 16,
    evidenceLengths: [12, 15, 7, 9, 6, 4, 5, 5, 8, 13, 11, 17, 6, 8, 6, 15],
  }, "corrected standard");
  assert.deepEqual(analyzerRuleVector(response), [
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ], "corrected standard: independent analyzer vector");
  assert.deepEqual(first.rules.map(({ rubricVersion }) => rubricVersion), [
    2, 2, 2, 2,
    2, 2, 2, 2,
    2, 2, 2, 2,
    2, 2, 2, 2,
  ]);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first.visual, { status: "not_performed", captureSha256: null });
  assert.equal(first.runtimeProtocolReceipts.runStatus, "not_run");
  assertDeepFrozen(first);
});

test("declaration header decoding ignores class literals in a witnessed class body", (t) => {
  const projectDir = writeCompleteProject(t, replaceFixturePathOnce(
    "app/src/main/java/com/agentbench/gallery/platform/LaunchActivity.kt",
    "class LaunchActivity : SpatialLaunchActivity()",
    `class LaunchActivity : SpatialLaunchActivity() {
    private fun reflectedType() = LaunchActivity::class.java
    private class NestedMarker
}`,
  ));
  const response = analyzeKotlin(loadSubmissionSources(projectDir));
  assert.deepEqual(analyzerRuleVector(response), [
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ], "class-literal body: independent analyzer vector");

  const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
  assertPublicScoreVector(score, {
    pass: [
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
    ],
    falseIds: [],
    axes: { spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 4 },
    score: 16,
  }, "class-literal body");
});

test("rule evidence retains exact source and typed-fact provenance without conflating evidence classes", (t) => {
  const projectDir = writeCompleteProject(t);
  const index = loadSubmissionSources(projectDir);
  const score = scoreSubmission({ projectDir, build: PASSING_BUILD });

  for (const [ruleIndex, [id, , evidenceClass]] of RULE_DEFINITIONS.entries()) {
    const scored = score.rules[ruleIndex];
    assert.equal(scored.id, id);
    assert.equal(scored.evidenceClass, evidenceClass);
    assert.equal(scored.pass, true);
    assert.equal(scored.evidence.length > 0, true);
    if (evidenceClass === "source") assert.equal(scored.evidence.every((row) => row.evidenceClass === "source"), true);
    else {
      assert.equal(scored.evidence.some((row) => row.evidenceClass === "source"), true);
      assert.equal(scored.evidence.some((row) => row.evidenceClass === "typed_fact"), true);
    }
    for (const row of scored.evidence) {
      assert.equal(pathIsRegular(projectDir, row.path), true);
      if (row.evidenceClass === "source") {
        const source = index.files.find((file) => file.path === row.path);
        assert.equal(source.structural.split(/\r?\n/)[row.line - 1].trim(), row.excerpt);
      } else {
        const fact = { ...row };
        delete fact.evidenceClass;
        assert.equal(index.factEvidence.some((candidate) => canonicalJson(candidate) === canonicalJson(fact)), true);
      }
    }
  }
  assert.equal(score.rules.flatMap((rule) => rule.evidence).some((row) => row.evidenceClass === "submission_test" || row.evidenceClass === "app_self_reported_protocol"), false);
});

function pathIsRegular(projectDir, relative) {
  return fs.statSync(`${projectDir}/${relative}`).isFile();
}

test("unused 0.13.3 catalog aliases and typed-looking Kotlin prose do not satisfy project entry", (t) => {
  const projectDir = writeCompleteProject(t, (files) => {
    const changed = changeOne('bom = "0.13.3"', 'bom = "0.13.2"\nunusedBom = "0.13.3"')(files);
    changed["app/src/main/java/com/agentbench/gallery/Bait.kt"] = `package com.agentbench.gallery
// implementation(platform("com.pico.spatial:bom:0.13.3"))
val fakeBuildLog = "implementation platform com.pico.spatial:bom:0.13.3 fun mainApp launch(::mainApp)"
`;
    return changed;
  });

  assert.deepEqual(analyzerRuleVector(analyzeKotlin(loadSubmissionSources(projectDir))), [
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ], "BOM fact attack: independent analyzer vector");
  const score = scoreSubmission({ projectDir, build: PASSING_BUILD });

  assertPublicScoreVector(score, {
    pass: PUBLIC_ATTACK_VECTORS["spatial.project-entry"],
    falseIds: ["spatial.project-entry"],
    axes: { spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 },
    score: 15,
  }, "BOM fact attack");
});

test("application-scoped, wrong-owner, and stale Stage metadata cannot replace launch-activity window facts", async (t) => {
  const cases = [
    ["application scope", (manifest) => manifest.replace(
      /            <meta-data android:name="pico\.spatial\.windowcontainer[\s\S]*?defaultsize" android:value="1280x720" \/>\n/,
      "",
    ).replace("        </activity>", `        </activity>
        <meta-data android:name="pico.spatial.windowcontainer.id" android:value="BenchmarkWindow" />
        <meta-data android:name="pico.spatial.windowcontainer.style" android:value="1" />
        <meta-data android:name="pico.spatial.windowcontainer.defaultsize" android:value="1280x720" />`)],
    ["wrong owner", (manifest) => manifest.replace(
      /            <meta-data android:name="pico\.spatial\.windowcontainer[\s\S]*?defaultsize" android:value="1280x720" \/>\n/,
      `        </activity>
        <activity android:name=".platform.OtherActivity">
            <meta-data android:name="pico.spatial.windowcontainer.id" android:value="BenchmarkWindow" />
            <meta-data android:name="pico.spatial.windowcontainer.style" android:value="1" />
            <meta-data android:name="pico.spatial.windowcontainer.defaultsize" android:value="1280x720" />
        </activity>
        <activity android:name=".platform.UnusedActivity">\n`,
    )],
    ["stale Stage metadata", (manifest) => manifest
      .replaceAll("pico.spatial.windowcontainer", "pico.spatial.stage")],
  ];

  for (const [name, alter] of cases) await t.test(name, (t) => {
    const projectDir = writeCompleteProject(t, (files) => ({
      ...files,
      "app/src/main/AndroidManifest.xml": alter(files["app/src/main/AndroidManifest.xml"]),
    }));
    assert.deepEqual(analyzerRuleVector(analyzeKotlin(loadSubmissionSources(projectDir))), [
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
    ], `${name}: independent analyzer vector`);
    const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
    assertPublicScoreVector(score, {
      pass: PUBLIC_ATTACK_VECTORS["spatial.container-topology"],
      falseIds: ["spatial.container-topology"],
      axes: { spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 },
      score: 15,
    }, name);
  });
});

test("mixed bindings reject unrelated manifest classes and ambiguous valid component tuples", async (t) => {
  const cases = [
    ["unrelated component declarations", (manifest) => manifest
      .replace(".platform.SpatialApplication", ".missing.MissingApplication")
      .replace(".platform.LaunchActivity", ".missing.MissingActivity")],
    ["duplicate valid launch activity", (manifest) => manifest.replace(
      "    </application>",
      `        <activity android:name=".platform.LaunchActivity" />
    </application>`,
    )],
  ];
  for (const [name, mutateManifest] of cases) await t.test(name, (t) => {
    const projectDir = writeCompleteProject(t, (files) => ({
      ...files,
      "app/src/main/AndroidManifest.xml": mutateManifest(files["app/src/main/AndroidManifest.xml"]),
    }));
    assert.deepEqual(analyzerRuleVector(analyzeKotlin(loadSubmissionSources(projectDir))), [
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
    ], `${name}: independent analyzer vector`);
    const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
    assertPublicScoreVector(score, {
      pass: [
        false, false, true, true,
        true, true, true, true,
        true, true, true, true,
        true, true, true, true,
      ],
      falseIds: ["spatial.project-entry", "spatial.container-topology"],
      axes: { spatialNative: 2, ecs: 4, statePassing: 4, planarTracking: 4 },
      score: 14,
    }, name);
    assert.equal(ruleById(score, "spatial.project-entry").reason, "supported-subset-v1 typed binding incomplete");
    assert.equal(ruleById(score, "spatial.container-topology").reason, "supported-subset-v1 typed binding incomplete");
  });
});

test("conflicting activity metadata fails closed before scoring", (t) => {
  const projectDir = writeCompleteProject(t, (files) => ({
    ...files,
    "app/src/main/AndroidManifest.xml": files["app/src/main/AndroidManifest.xml"].replace(
      '<meta-data android:name="pico.spatial.windowcontainer.style" android:value="1" />',
      `<meta-data android:name="pico.spatial.windowcontainer.style" android:value="1" />
            <meta-data android:name="pico.spatial.windowcontainer.style" android:value="2" />`,
    ),
  }));

  assert.throws(() => scoreSubmission({ projectDir, build: PASSING_BUILD }), /metadata|conflict|duplicate/i);
});

test("exact rule attack vectors bind public score to independent analyzer expectations", async (t) => {
  assertDeepFrozen(PUBLIC_ATTACK_VECTORS);
  assertDeepFrozen(PUBLIC_ATTACK_EXPECTATIONS);
  assert.deepEqual(PUBLIC_ATTACK_EXPECTATIONS.map(({ ruleId }) => ruleId), [
    "spatial.project-entry", "spatial.container-topology", "spatial.entity-content", "spatial.ui-lifecycle",
    "ecs.component-clone", "ecs.system-query", "ecs.frame-update", "ecs.lifecycle",
    "state.single-source", "state.typed-handoff", "state.shared-read-write", "state.reopen-wiring",
    "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose", "plane.cleanup-errors",
  ]);
  const attacksById = new Map(batch2bFixture.RULE_ATTACKS.map((attack) => [attack.ruleId, attack]));
  for (const expected of PUBLIC_ATTACK_EXPECTATIONS) await t.test(expected.ruleId, (t) => {
    const attack = attacksById.get(expected.ruleId);
    assert.equal(typeof attack?.apply, "function", `${expected.ruleId}: fixture attack`);
    const projectDir = writeCompleteProject(t, attack.apply);
    const response = analyzeKotlin(loadSubmissionSources(projectDir));
    const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
    assert.deepEqual(analyzerRuleVector(response), expected.pass, `${expected.ruleId}: independent analyzer vector`);
    assertPublicScoreVector(score, expected, expected.ruleId);
  });
});

test("independently named typed reentry callback scores sixteen and its callback mutation flips only reopen wiring", (t) => {
  const positiveDir = writeEquivalentReopenProject(t);
  const positive = scoreSubmission({ projectDir: positiveDir, build: PASSING_BUILD });
  const sourceText = positiveDir && fs.readFileSync(`${positiveDir}/app/src/main/java/com/agentbench/gallery/Main.kt`, "utf8");
  assert.equal(sourceText.includes("sharedStore"), false);
  assert.equal(sourceText.includes("openGalleryStage"), false);
  assert.equal(sourceText.includes("restoreRetainedState"), false);
  assertPublicScoreVector(positive, {
    pass: PUBLIC_BASE_VECTORS.correctedEquivalent,
    falseIds: [],
    axes: { spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 4 },
    score: 16,
    evidenceLengths: [12, 15, 7, 9, 6, 4, 5, 5, 7, 13, 11, 18, 6, 8, 6, 15],
  }, "corrected equivalent");
  assert.deepEqual(analyzerRuleVector(analyzeKotlin(loadSubmissionSources(positiveDir))), [
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
    true, true, true, true,
  ], "corrected equivalent: independent analyzer vector");

  const mutatedDir = writeEquivalentReopenProject(t, changeOne(
    "museumSessionRepository::currentSnapshot",
    "GallerySessionSnapshot::empty",
  ));
  const mutated = scoreSubmission({ projectDir: mutatedDir, build: PASSING_BUILD });
  assert.deepEqual(analyzerRuleVector(analyzeKotlin(loadSubmissionSources(mutatedDir))), [
    true, true, true, true,
    true, true, true, true,
    true, true, true, false,
    true, true, true, true,
  ], "equivalent callback attack: independent analyzer vector");
  assertPublicScoreVector(mutated, {
    pass: PUBLIC_BASE_VECTORS.equivalentCallbackAttack,
    falseIds: ["state.reopen-wiring"],
    axes: { spatialNative: 4, ecs: 4, statePassing: 3, planarTracking: 4 },
    score: 15,
    evidenceLengths: [12, 15, 7, 9, 6, 4, 5, 5, 7, 13, 11, 0, 6, 8, 6, 15],
  }, "equivalent callback attack");
});

test("disconnected structural vocabulary cannot satisfy relational rubric conjunctions", async (t) => {
  const cases = [
    ["manifest classes do not match implementation", "spatial.project-entry", (files) => ({
      ...files,
      "app/src/main/AndroidManifest.xml": files["app/src/main/AndroidManifest.xml"]
        .replace(".platform.SpatialApplication", ".missing.MissingApplication")
        .replace(".platform.LaunchActivity", ".missing.MissingActivity"),
    })],
    ["declared and opened Stage IDs differ", "spatial.container-topology", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Main.kt": files["app/src/main/java/com/agentbench/gallery/Main.kt"]
        .replace("openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)", "openStage(\"DifferentStage\", StageStyle.Mixed, bundle)"),
    })],
    ["a matching-ID Full decoy cannot hide a wrong-ID Mixed open", "spatial.container-topology", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Main.kt": files["app/src/main/java/com/agentbench/gallery/Main.kt"]
        .replace("openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)", "openStage(SpatialContainers.ID_GALLERY, StageStyle.Full, bundle)\n    openStage(\"DifferentStage\", StageStyle.Mixed, bundle)"),
    }), "spatial.container-topology.full-decoy"],
    ["an unused correct-ID Mixed helper cannot hide the invoked wrong-ID helper", "spatial.container-topology", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Main.kt": files["app/src/main/java/com/agentbench/gallery/Main.kt"]
        .replace("openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle)", "openStage(\"DifferentStage\", StageStyle.Mixed, bundle)")
        .concat("\nprivate suspend fun SpatialNavigator.unusedCorrectOpen(bundle: android.os.Bundle) { openStage(SpatialContainers.ID_GALLERY, StageStyle.Mixed, bundle) }\n"),
    })],
    ["deltaTime is observed but a fixed timestep drives motion", "ecs.frame-update", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Orbit.kt": files["app/src/main/java/com/agentbench/gallery/Orbit.kt"]
        .replace("orbit.angle += context.deltaTime", "val measuredDelta = context.deltaTime\n            orbit.angle += 0.016f"),
    })],
    ["deltaTime appears only in a helper after the fixed-timestep update", "ecs.frame-update", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Orbit.kt": files["app/src/main/java/com/agentbench/gallery/Orbit.kt"]
        .replace("orbit.angle += context.deltaTime", "orbit.angle += 0.016f")
        .replace("    }\n}\n", "    }\n\n    private fun unrelatedDelta(context: SceneUpdateContext, orbit: OrbitComponent) {\n        orbit.angle += context.deltaTime\n    }\n}\n"),
    })],
    ["System unregister is outside the owning effect", "ecs.lifecycle", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/GalleryStage.kt": files["app/src/main/java/com/agentbench/gallery/GalleryStage.kt"]
        .replace("            unregisterSystem<OrbitSystem>()", "            Unit")
        .concat("\nprivate fun unrelatedCleanup() { unregisterSystem<OrbitSystem>() }\n"),
    })],
    ["unregister spelling cannot impersonate registration", "ecs.lifecycle", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/GalleryStage.kt": files["app/src/main/java/com/agentbench/gallery/GalleryStage.kt"]
        .replace("        registerSystem<OrbitSystem>()", "        Unit"),
    })],
    ["registration hidden inside an uncalled nested lambda", "ecs.lifecycle", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/GalleryStage.kt": files["app/src/main/java/com/agentbench/gallery/GalleryStage.kt"]
        .replace("        registerSystem<OrbitSystem>()", "        val unusedRegistration = { registerSystem<OrbitSystem>() }"),
    })],
    ["anchor loading is outside an empty retry loop", "plane.retry-readiness", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": files["app/src/main/java/com/agentbench/gallery/PlaneSession.kt"]
        .replace(`for (attempt in 0 until MAX_ANCHOR_RETRIES) {
                val loaded = PlaneTrackingManager.loadAllAnchors().toList()
                candidates = loaded
                if (loaded.isNotEmpty()) break
                delay(25L)
            }`, `for (attempt in 0 until MAX_ANCHOR_RETRIES) { Unit }
            val loaded = PlaneTrackingManager.loadAllAnchors().toList()
            candidates = loaded
            if (loaded.isNotEmpty()) Unit
            delay(25L)`),
    }), "plane.retry-readiness.disconnected-load"],
    ["retry readiness tests stale candidates instead of the loaded anchors", "plane.retry-readiness", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": files["app/src/main/java/com/agentbench/gallery/PlaneSession.kt"]
        .replace("val loaded = PlaneTrackingManager.loadAllAnchors().toList()", "PlaneTrackingManager.loadAllAnchors().toList()\n                val loaded = candidates"),
    }), "plane.retry-readiness.disconnected-load"],
    ["loaded anchors are overwritten before the readiness check", "plane.retry-readiness", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": files["app/src/main/java/com/agentbench/gallery/PlaneSession.kt"]
        .replace("candidates = loaded\n                if (loaded.isNotEmpty()) break", "candidates = loaded\n                candidates = emptyList()\n                if (candidates.isNotEmpty()) break"),
    }), "plane.retry-readiness.disconnected-load"],
    ["TABLE/FLOOR selection is unconstrained while checks live in an unused helper", "plane.semantic-fallback", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": files["app/src/main/java/com/agentbench/gallery/PlaneSession.kt"]
        .replace(`private fun horizontalTablePlane(): PlaneAnchor? = candidates
        .filter { it.semantics == SemanticLabelType.TABLE && isHorizontal(it) && area(it) > 0f }
        .maxByOrNull(::area)`, "private fun horizontalTablePlane(): PlaneAnchor? = candidates.firstOrNull()")
        .replace(`private fun horizontalFloorPlane(): PlaneAnchor? = candidates
        .filter { it.semantics == SemanticLabelType.FLOOR && isHorizontal(it) && area(it) > 0f }
        .maxByOrNull(::area)`, "private fun horizontalFloorPlane(): PlaneAnchor? = candidates.firstOrNull()")
        .concat(`
private fun unusedSemanticBait(candidates: List<PlaneAnchor>) {
    candidates.filter { it.semantics == SemanticLabelType.TABLE && isHorizontal(it) && area(it) > 0f }
    candidates.filter { it.semantics == SemanticLabelType.FLOOR && isHorizontal(it) && area(it) > 0f }
}
`),
    })],
    ["placement bypasses otherwise constrained fallback helpers", "plane.semantic-fallback", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": files["app/src/main/java/com/agentbench/gallery/PlaneSession.kt"]
        .replace("val anchor = horizontalTablePlane() ?: horizontalFloorPlane()", "val anchor = candidates.firstOrNull()")
        .concat("\nprivate fun unusedFallback(session: PlaneSession) = session.horizontalTablePlane() ?: session.horizontalFloorPlane()\n"),
    }), "plane.semantic-fallback.placement-bypass"],
    ["semantic, orientation, and area checks inspect different anchors", "plane.semantic-fallback", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": files["app/src/main/java/com/agentbench/gallery/PlaneSession.kt"]
        .replaceAll("isHorizontal(it) && area(it)", "isHorizontal(otherAnchor) && area(otherAnchor)")
        .concat("\nprivate val otherAnchor: PlaneAnchor get() = error(\"bait\")\n"),
    })],
    ["called area helper is constant while multiplication is unused", "plane.semantic-fallback", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/PlaneSession.kt": files["app/src/main/java/com/agentbench/gallery/PlaneSession.kt"]
        .replace("private fun area(anchor: PlaneAnchor): Float = anchor.boundingBoxSize.x * anchor.boundingBoxSize.y", "private fun area(anchor: PlaneAnchor): Float = 1f\n\n    private fun unusedArea(anchor: PlaneAnchor): Float = anchor.boundingBoxSize.x * anchor.boundingBoxSize.y"),
    })],
    ["close path constructs a replacement state authority", "state.reopen-wiring", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Main.kt": files["app/src/main/java/com/agentbench/gallery/Main.kt"]
        .replace("    closeStage()", "    closeStage()\n    val replacementStore = BenchmarkStore()")
        .replace("val selection = store.snapshot().selection", "val selection = replacementStore.snapshot().selection")
        .replace("val visitCount = store.snapshot().visitCount", "val visitCount = replacementStore.snapshot().visitCount")
        .replace("val paused = store.snapshot().paused", "val paused = replacementStore.snapshot().paused")
        .replace("store.restore(GallerySnapshot(selection, visitCount, paused))", "replacementStore.restore(GallerySnapshot(selection, visitCount, paused))")
        .replace("store = store,", "store = replacementStore,"),
    })],
    ["retained field reads are outside the close/reopen path", "state.reopen-wiring", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Main.kt": files["app/src/main/java/com/agentbench/gallery/Main.kt"]
        .replace("val selection = store.snapshot().selection", "val selection: GallerySelection? = null")
        .replace("val visitCount = store.snapshot().visitCount", "val visitCount = 0")
        .replace("val paused = store.snapshot().paused", "val paused = false")
        .concat("\nprivate fun unrelatedReads(store: BenchmarkStore) {\n    store.snapshot().selection\n    store.snapshot().visitCount\n    store.snapshot().paused\n}\n"),
    })],
    ["retained field reads are ignored by restore", "state.reopen-wiring", (files) => ({
      ...files,
      "app/src/main/java/com/agentbench/gallery/Main.kt": files["app/src/main/java/com/agentbench/gallery/Main.kt"]
        .replace("store.restore(GallerySnapshot(selection, visitCount, paused))", "store.restore(GallerySnapshot(null, 0, false))"),
    })],
  ];
  const correctedRuleIds = Object.freeze(["plane.retry-readiness", "state.reopen-wiring"]);
  assertDeepFrozen(PUBLIC_DISCONNECTED_ATTACK_EXPECTATIONS);
  assertDeepFrozen(PUBLIC_DISCONNECTED_ATTACK_INVENTORY);
  assert.deepEqual(cases.map(([name, ruleId, , expectationKey = ruleId]) => [name, ruleId, expectationKey]), PUBLIC_DISCONNECTED_ATTACK_INVENTORY, "disconnected attacks: exact ordered 19-case inventory");
  const legacyBaseline = scoreSubmission({ projectDir: writeLegacyScoreProject(t), build: PASSING_BUILD });
  const correctedBaseline = scoreSubmission({ projectDir: writeCompleteProject(t), build: PASSING_BUILD });
  assert.deepEqual(legacyBaseline.rules.map((rule) => rule.pass), PUBLIC_BASE_VECTORS.uncorrected, "disconnected attacks: exact legacy baseline vector");
  assert.deepEqual(correctedBaseline.rules.map((rule) => rule.pass), PUBLIC_BASE_VECTORS.correctedStandard, "disconnected attacks: exact corrected baseline vector");
  assert.deepEqual(cases.filter(([, ruleId]) => {
    const baseline = correctedRuleIds.includes(ruleId) ? correctedBaseline : legacyBaseline;
    return ruleById(baseline, ruleId).pass === false;
  }).map(([name]) => name), [], "disconnected attacks: exact non-falsifiable case-name vector");
  for (const [name, ruleId, mutate, expectationKey = ruleId] of cases) await t.test(name, (t) => {
    const writer = correctedRuleIds.includes(ruleId) ? writeCompleteProject : writeLegacyScoreProject;
    const checkedMutation = (files) => {
      const changed = mutate(files);
      assert.notDeepEqual(changed, files, `${name}: mutation changes fixture bytes`);
      return changed;
    };
    const score = scoreSubmission({ projectDir: writer(t, checkedMutation), build: PASSING_BUILD });
    assertPublicScoreVector(score, PUBLIC_DISCONNECTED_ATTACK_EXPECTATIONS[expectationKey], name);
  });
});

test("equivalent reopen wiring is independent of callback parameter names", (t) => {
  const projectDir = writeEquivalentReopenProject(t, (files) => ({
    ...files,
    "app/src/main/java/com/agentbench/gallery/Main.kt": files["app/src/main/java/com/agentbench/gallery/Main.kt"]
      .replaceAll("initialState", "launchSnapshot")
      .replaceAll("stateOwner", "repositoryOwner")
      .replaceAll("stateOnReentry", "reentrySnapshot"),
  }));
  const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
  assert.equal(score.structuralScore, 16);
  assert.equal(ruleById(score, "state.reopen-wiring").pass, true);
});

test("Android drawing substitutes and masked vocabulary earn no spatial-native source point", (t) => {
  const projectDir = writeAndroidStyleProject(t);
  const kotlinPath = `${projectDir}/app/src/main/java/com/agentbench/gallery/Main.kt`;
  fs.appendFileSync(kotlinPath, `
// DefaultWindowContainer { PicoTheme { SpatialView(Entity()) } }
val fakeLog = "fun mainApp launch(::mainApp) Stage openStage StageStyle.Mixed"
`, "utf8");
  const manifestPath = `${projectDir}/app/src/main/AndroidManifest.xml`;
  fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").replace(
    "    </application>",
    `        <meta-data android:name="fake.source" android:value="DefaultWindowContainer PicoTheme SpatialView Entity StageStyle.Mixed" />
    </application>`,
  ));
  const catalogPath = `${projectDir}/gradle/libs.versions.toml`;
  fs.writeFileSync(catalogPath, fs.readFileSync(catalogPath, "utf8").replace(
    "[libraries]",
    'fakeSource = "DefaultWindowContainer PicoTheme SpatialView Entity StageStyle.Mixed"\n\n[libraries]',
  ));

  const score = scoreSubmission({ projectDir, build: PASSING_BUILD });

  assert.deepEqual(score.rules.slice(0, 4).map((rule) => rule.pass), [false, false, false, false]);
});

test("submission-test outcomes remain separate from structural and runtime evidence", (t) => {
  const projectDir = writeCompleteProject(t);
  const baseline = scoreSubmission({ projectDir, build: PASSING_BUILD });
  for (const status of ["pass", "fail", "execution_failed", "no_source", "not_run"]) {
    const scored = scoreSubmission({
      projectDir,
      build: PASSING_BUILD,
      submissionTests: observedSubmission(status),
    });
    assert.equal(scored.submissionTests.status, status);
    assert.deepEqual(scored.rules, baseline.rules);
    assert.deepEqual(scored.structuralAxes, baseline.structuralAxes);
    assert.equal(scored.structuralScore, 16);
    assert.equal(scored.buildQualifiedStructuralScore, 16);
    assert.equal(scored.runtimeProtocolReceipts.runStatus, "not_run");
    assert.equal(scored.rules.flatMap((rule) => rule.evidence).some((row) => row.evidenceClass !== "source" && row.evidenceClass !== "typed_fact"), false);
  }
});

test("failed and unrun builds retain structural diagnostics but qualify them to zero", (t) => {
  const projectDir = writeCompleteProject(t);
  const failed = scoreSubmission({ projectDir, build: { status: "fail", receiptSha256: "e".repeat(64) } });
  assert.equal(failed.structuralScore, 16);
  assert.equal(failed.buildQualifiedStructuralScore, 0);
  assert.equal(failed.submissionTests.status, "not_run_build_failed");
  assert.equal(failed.runtimeProtocolReceipts.runStatus, "not_run_build_failed");

  const notRun = scoreSubmission({ projectDir, build: { status: "not_run", receiptSha256: null } });
  assert.equal(notRun.structuralScore, 16);
  assert.equal(notRun.buildQualifiedStructuralScore, 0);
  assert.equal(notRun.submissionTests.status, "not_run");
  assert.equal(notRun.runtimeProtocolReceipts.runStatus, "not_run");

  assert.throws(() => scoreSubmission({ projectDir, build: { status: "pass", receiptSha256: null } }), /receipt/i);
  const inconsistent = { ...observedSubmission("pass"), testCount: 2 };
  assert.throws(() => scoreSubmission({ projectDir, build: PASSING_BUILD, submissionTests: inconsistent }), /count|receipt/i);
});

test("scoring input rejects protocol, runtime, behavior, accessors, symbols, and exotic prototypes", (t) => {
  const projectDir = writeCompleteProject(t);
  for (const key of ["runtimeProtocolReceipts", "runtime", "behavior"]) {
    assert.throws(() => scoreSubmission({ projectDir, build: PASSING_BUILD, [key]: {} }), /unknown|keys/i);
  }

  let getterCalled = false;
  const accessor = { build: PASSING_BUILD };
  Object.defineProperty(accessor, "projectDir", { enumerable: true, get() { getterCalled = true; return projectDir; } });
  assert.throws(() => scoreSubmission(accessor), /data property/i);
  assert.equal(getterCalled, false);

  const symbol = { projectDir, build: PASSING_BUILD };
  symbol[Symbol("forged")] = true;
  assert.throws(() => scoreSubmission(symbol), /symbol/i);
  assert.throws(() => scoreSubmission(Object.assign(Object.create(null), { projectDir, build: PASSING_BUILD })), /plain object|prototype/i);
  assert.throws(() => scoreSubmission(Object.assign(Object.create({}), { projectDir, build: PASSING_BUILD })), /plain object|prototype/i);
});

async function importForgedScorer(t, injection, { forbidAdaptation = false, poisonProjection = false } = {}) {
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbench-forged-scorer-"));
  t.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));
  const libraryDir = path.resolve(import.meta.dirname, "../benchmarks/spatial-agent-bench/lib");
  for (const name of ["contract.mjs", "source.mjs"]) {
    fs.copyFileSync(path.join(libraryDir, name), path.join(moduleDir, name));
  }
  for (const [name, exported] of [["rules-spatial.mjs", "evaluateSpatialRules"], ["rules-state-plane.mjs", "evaluateStatePlaneRules"]]) {
    if (forbidAdaptation) {
      fs.writeFileSync(path.join(moduleDir, name), `
let adaptationCallCount = 0;
export function ${exported}() {
  adaptationCallCount += 1;
  throw new Error("rule adaptation reached forged analyzer response");
}
export function getAdaptationCallCount() { return adaptationCallCount; }
`);
    } else {
      fs.copyFileSync(path.join(libraryDir, name), path.join(moduleDir, name));
    }
  }
  fs.writeFileSync(path.join(moduleDir, "identity.mjs"), `export { canonicalIdentity, canonicalJson } from ${JSON.stringify(pathToFileURL(path.resolve(libraryDir, "../../../dist/runreceiptidentity.js")).href)};\n`);
  const realAnalyzerUrl = pathToFileURL(path.join(libraryDir, "kotlin-analysis.mjs")).href;
  fs.writeFileSync(path.join(moduleDir, "kotlin-analysis.mjs"), `
import crypto from "node:crypto";
import { canonicalJson } from "./identity.mjs";
import { ANALYZER_CONSTANTS, analyzeKotlin as analyzeRealKotlin } from ${JSON.stringify(realAnalyzerUrl)};
export { ANALYZER_CONSTANTS };
let analyzeCallCount = 0;
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const digest = (value) => crypto.createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
const textDigest = (value) => crypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const nodeIdentity = (node) => ({
  path: node.path,
  fileSha256: node.fileSha256,
  startUtf16: node.startUtf16,
  endUtf16: node.endUtf16,
  kind: node.kind,
  textSha256: node.textSha256,
  structuralToken: node.structuralToken,
});
function refreshClaims(response) {
  for (const claim of response.claims) {
    claim.witnessNodeIds.sort(compareUtf8);
    claim.witnessDigest = digest({ ruleId: claim.ruleId, proofForm: claim.proofForm, witnessNodeIds: claim.witnessNodeIds });
  }
}
function retainClaimUnion(response) {
  const retained = new Set(response.claims.flatMap((claim) => claim.witnessNodeIds));
  response.nodes = response.nodes.filter((node) => retained.has(node.nodeId)).sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
}
function dropClaim(response, ruleId) {
  response.claims = response.claims.filter((claim) => claim.ruleId !== ruleId);
  retainClaimUnion(response);
}
function rekeyNode(response, nodeIndex, changes) {
  const node = response.nodes[nodeIndex];
  const priorId = node.nodeId;
  Object.assign(node, changes);
  node.nodeId = digest(nodeIdentity(node));
  for (const claim of response.claims) claim.witnessNodeIds = claim.witnessNodeIds.map((nodeId) => nodeId === priorId ? node.nodeId : nodeId);
  refreshClaims(response);
  response.nodes.sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
  return node;
}
export function analyzeKotlin(index) {
  analyzeCallCount += 1;
  const response = structuredClone(analyzeRealKotlin(index));
  ${injection}
  return response;
}
export function getAnalyzeCallCount() { return analyzeCallCount; }
`, "utf8");
  const scoreSource = fs.readFileSync(path.join(libraryDir, "score.mjs"), "utf8")
    .replace(
      "function projectedSourceEvidence(witnesses) {",
      `let projectionCallCount = 0;
function projectedSourceEvidence(witnesses) {
  projectionCallCount += 1;
  ${poisonProjection ? 'throw new Error("public source projection reached poisoned boundary");' : ""}`,
    );
  const adaptationExports = forbidAdaptation ? `
export { getAdaptationCallCount as getSpatialAdaptationCallCount } from "./rules-spatial.mjs";
export { getAdaptationCallCount as getStatePlaneAdaptationCallCount } from "./rules-state-plane.mjs";
` : "";
  fs.writeFileSync(path.join(moduleDir, "score.mjs"), `${scoreSource}
export { getAnalyzeCallCount } from "./kotlin-analysis.mjs";
export function getProjectionCallCount() { return projectionCallCount; }
${adaptationExports}`);
  return import(`${pathToFileURL(path.join(moduleDir, "score.mjs")).href}?${Date.now()}-${Math.random()}`);
}

test("late catalog union forgery is rejected before public source projection or adaptation", async (t) => {
  const projectDir = writeCompleteProject(t);
  const forged = await importForgedScorer(t, `
    const counts = new Map();
    for (const claim of response.claims) for (const nodeId of claim.witnessNodeIds) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
    const orphan = response.nodes.find((node) => counts.get(node.nodeId) === 1);
    const owner = response.claims.find((claim) => claim.witnessNodeIds.includes(orphan.nodeId));
    owner.witnessNodeIds = owner.witnessNodeIds.filter((nodeId) => nodeId !== orphan.nodeId);
    refreshClaims(response);
  `, { forbidAdaptation: true, poisonProjection: true });
  assert.throws(
    () => forged.scoreSubmission({ projectDir, build: PASSING_BUILD }),
    { name: "Error", message: "public analyzer provenance rejected: node catalog is not the exact claim-witness union" },
  );
  assert.equal(forged.getAnalyzeCallCount(), 1);
  assert.equal(forged.getProjectionCallCount(), 0);
  assert.equal(forged.getSpatialAdaptationCallCount(), 0);
  assert.equal(forged.getStatePlaneAdaptationCallCount(), 0);
});

test("chain-consistent forged proof form is rejected before public source projection or adaptation", async (t) => {
  const projectDir = writeCompleteProject(t);
  const forged = await importForgedScorer(t, `
    response.claims[0].proofForm = "forged-public-proof-form";
    refreshClaims(response);
  `, { forbidAdaptation: true, poisonProjection: true });
  assert.throws(
    () => forged.scoreSubmission({ projectDir, build: PASSING_BUILD }),
    { name: "Error", message: "public analyzer provenance rejected: claim 0 proof form is outside the public rule domain" },
  );
  assert.equal(forged.getAnalyzeCallCount(), 1);
  assert.equal(forged.getProjectionCallCount(), 0);
  assert.equal(forged.getSpatialAdaptationCallCount(), 0);
  assert.equal(forged.getStatePlaneAdaptationCallCount(), 0);
});

test("the public scorer calls the analyzer once and never falls back when exact claims are absent", async (t) => {
  const cases = [
    ["source claim absent", "spatial.entity-content", 'dropClaim(response, "spatial.entity-content");', [
      true, true, false, true,
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
    ]],
    ["typed facts cannot replace claim", "spatial.project-entry", 'dropClaim(response, "spatial.project-entry");', [
      false, true, true, true,
      true, true, true, true,
      true, true, true, true,
      true, true, true, true,
    ]],
  ];
  for (const [name, ruleId, injection, pass] of cases) await t.test(name, async (t) => {
    const projectDir = writeCompleteProject(t);
    const forged = await importForgedScorer(t, injection);
    const score = forged.scoreSubmission({ projectDir, build: PASSING_BUILD });
    assert.equal(forged.getAnalyzeCallCount(), 1, `${name}: one analyzer call`);
    assert.deepEqual(score.rules.map((rule) => rule.pass), pass, `${name}: literal public vector`);
    assert.equal(ruleById(score, ruleId).reason, "supported-subset-v1 claim absent");
    assert.deepEqual(ruleById(score, ruleId).evidence, []);
  });
});

test("witness provenance rejects forged response receipts spans nodes digests order and catalog before adaptation", async (t) => {
  const projectDir = writeCompleteProject(t, (files) => ({
    ...files,
    "app/src/main/java/com/agentbench/gallery/Surrogate.kt": "package com.agentbench.gallery\nfun surrogateBait() = \"left 😀 right\"\n",
  }));
  const mutations = [
    ["response shape", 'response.forged = true;'],
    ["Kotlin input digest", 'response.kotlinInputSetSha256 = "0".repeat(64);'],
    ["file receipt", 'response.files[0].sha256 = "0".repeat(64);'],
    ["node path", 'response.nodes[0].path = "app/src/main/java/Forged.kt";'],
    ["file hash", 'response.nodes[0].fileSha256 = "0".repeat(64);'],
    ["UTF-16 bounds", 'response.nodes[0].startUtf16 = -1;'],
    ["surrogate boundary", `
      const file = index.files.find((candidate) => candidate.path.endsWith("/Surrogate.kt"));
      const split = file.original.indexOf("😀") + 1;
      rekeyNode(response, 0, {
        path: file.path,
        fileSha256: textDigest(file.original),
        startUtf16: split,
        endUtf16: split + 1,
        textSha256: textDigest(file.original.slice(split, split + 1)),
      });
    `],
    ["substring hash", 'response.nodes[0].textSha256 = "0".repeat(64);'],
    ["node ID", 'response.nodes[0].nodeId = "0".repeat(64);'],
    ["closed witness kind", 'response.nodes[0].kind = "forged_kind";'],
    ["nonstructural kind", 'const indexOfStructuralKind = response.nodes.findIndex((node) => node.kind !== "argument"); rekeyNode(response, indexOfStructuralKind, { structuralToken: false });'],
    ["witness reference", 'response.claims[0].witnessNodeIds[0] = "0".repeat(64);'],
    ["witness digest", 'response.claims[0].witnessDigest = "0".repeat(64);'],
    ["claim order", 'response.claims = [response.claims[1], response.claims[0], ...response.claims.slice(2)];'],
    ["orphan catalog node", `
      const counts = new Map();
      for (const claim of response.claims) for (const nodeId of claim.witnessNodeIds) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
      const orphan = response.nodes.find((node) => counts.get(node.nodeId) === 1);
      const owner = response.claims.find((claim) => claim.witnessNodeIds.includes(orphan.nodeId));
      owner.witnessNodeIds = owner.witnessNodeIds.filter((nodeId) => nodeId !== orphan.nodeId);
      refreshClaims(response);
    `],
  ];
  for (const [name, injection] of mutations) await t.test(name, async (t) => {
    const forged = await importForgedScorer(t, injection, { forbidAdaptation: true });
    assert.throws(
      () => forged.scoreSubmission({ projectDir, build: PASSING_BUILD }),
      /public analyzer provenance rejected/,
      `${name}: validation must precede adapters`,
    );
    assert.equal(forged.getAnalyzeCallCount(), 1, `${name}: one analyzer call`);
  });
});

test("witness provenance rejects a chain-consistent structural-mask forgery before adaptation", async (t) => {
  const corpus = await loadBatch2bCorpusModule();
  const writeCase = requireBatch2bExport(corpus, "writePositiveSubsetCase", "function");
  const projectDir = writeCase(t, "topology.direct-mixed-stage-open.named-literal-stage-id.alpha");
  const forged = await importForgedScorer(t, `
    const literalIndex = response.nodes.findIndex((node) => node.kind === "argument" && node.structuralToken === false);
    if (literalIndex < 0) throw new Error("missing real nonstructural literal witness");
    const literal = response.nodes[literalIndex];
    const file = index.files.find((candidate) => candidate.path === literal.path);
    const line = file.structural.slice(0, literal.startUtf16).split(/\\r?\\n/).length;
    if (file.structural.slice(literal.startUtf16, literal.endUtf16).trim() !== "") throw new Error("literal span was not wholly masked");
    if (file.structural.split(/\\r?\\n/)[line - 1].trim() === "") throw new Error("literal attack line must retain surrounding structural code");
    rekeyNode(response, literalIndex, { structuralToken: true });
  `, { forbidAdaptation: true });
  assert.throws(
    () => forged.scoreSubmission({ projectDir, build: PASSING_BUILD }),
    /public analyzer provenance rejected: structural witness span is wholly masked/,
  );
  assert.equal(forged.getAnalyzeCallCount(), 1);
});

test("validated witnesses with an empty public line fail only their unrepresentable claim", async (t) => {
  const corpus = await loadBatch2bCorpusModule();
  const writeCase = requireBatch2bExport(corpus, "writePositiveSubsetCase", "function");
  const projectDir = writeCase(t, "topology.direct-mixed-stage-open.named-literal-stage-id.alpha");
  const baitPath = path.join(projectDir, "app/src/main/java/com/agentbench/corpus/MaskedBait.kt");
  fs.mkdirSync(path.dirname(baitPath), { recursive: true });
  fs.writeFileSync(baitPath, "package com.agentbench.corpus\nfun maskedBait() {\n    \"masked-only\"\n}\n", "utf8");
  const forged = await importForgedScorer(t, `
    const literalIndex = response.nodes.findIndex((node) => node.kind === "argument" && node.structuralToken === false);
    const file = index.files.find((candidate) => candidate.path.endsWith("/MaskedBait.kt"));
    const startUtf16 = file.original.indexOf("masked-only") - 1;
    const witnessText = file.original.slice(startUtf16, startUtf16 + 13);
    rekeyNode(response, literalIndex, {
      path: file.path,
      fileSha256: textDigest(file.original),
      startUtf16,
      endUtf16: startUtf16 + witnessText.length,
      textSha256: textDigest(witnessText),
      structuralToken: false,
    });
  `);
  const score = forged.scoreSubmission({ projectDir, build: PASSING_BUILD });
  assert.deepEqual(score.rules.map((rule) => rule.pass), [
    false, false, false, false,
    false, false, false, false,
    false, false, false, false,
    false, false, false, false,
  ]);
  assert.equal(ruleById(score, "spatial.project-entry").reason, "supported-subset-v1 typed binding incomplete");
  assert.equal(ruleById(score, "spatial.container-topology").reason, "supported-subset-v1 witness unrepresentable");
  assert.deepEqual(ruleById(score, "spatial.container-topology").evidence, []);
  assert.equal(forged.getAnalyzeCallCount(), 1);
});

test("validated projected structural lines enforce the exact 512-byte UTF-8 boundary", async (t) => {
  assert.equal(Buffer.byteLength(PROJECTION_LINE_512, "utf8"), 512);
  assert.equal(Buffer.byteLength(PROJECTION_LINE_513, "utf8"), 513);
  assertDeepFrozen(PUBLIC_PROJECTION_BOUNDARY_VECTORS);
  const projectDir = writeCompleteProject(t, (files) => ({
    ...files,
    [PROJECTION_BOUNDARY_PATH]: `package com.agentbench.gallery\n${PROJECTION_LINE_512}\n${PROJECTION_LINE_513}\n`,
  }));
  const cases = [
    Object.freeze({
      name: "exactly 512 bytes",
      boundaryLine: PROJECTION_LINE_512,
      pass: PUBLIC_PROJECTION_BOUNDARY_VECTORS.exact512,
      falseIds: Object.freeze([]),
      axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 4 }),
      score: 16,
      evidenceLengths: Object.freeze([12, 15, 7, 9, 6, 4, 5, 5, 8, 13, 11, 17, 6, 8, 6, 15]),
      cloneReason: "supported-subset-v1 witness: expression-component-clone",
      cloneProjection: Object.freeze([Object.freeze({
        evidenceClass: "source",
        path: PROJECTION_BOUNDARY_PATH,
        line: 2,
        excerpt: PROJECTION_LINE_512,
      })]),
    }),
    Object.freeze({
      name: "exactly 513 bytes",
      boundaryLine: PROJECTION_LINE_513,
      pass: PUBLIC_PROJECTION_BOUNDARY_VECTORS.exact513,
      falseIds: Object.freeze(["ecs.component-clone"]),
      axes: Object.freeze({ spatialNative: 4, ecs: 3, statePassing: 4, planarTracking: 4 }),
      score: 15,
      evidenceLengths: Object.freeze([12, 15, 7, 9, 0, 4, 5, 5, 8, 13, 11, 17, 6, 8, 6, 15]),
      cloneReason: "supported-subset-v1 witness unrepresentable",
      cloneProjection: Object.freeze([]),
    }),
  ];
  for (const boundary of cases) await t.test(boundary.name, async (t) => {
    const forged = await importForgedScorer(t, `
      const owner = response.claims.find((claim) => claim.ruleId === "ecs.component-clone");
      const referenceCounts = new Map();
      for (const claim of response.claims) for (const nodeId of claim.witnessNodeIds) {
        referenceCounts.set(nodeId, (referenceCounts.get(nodeId) ?? 0) + 1);
      }
      const ownerNodes = owner.witnessNodeIds.map((nodeId) => response.nodes.find((node) => node.nodeId === nodeId));
      const ownerLineKeys = ownerNodes.map((node) => {
        const source = index.files.find((file) => file.path === node.path);
        const line = source.structural.slice(0, node.startUtf16).split(/\\r?\\n/).length;
        return JSON.stringify([node.path, line]);
      });
      const ownerLineCounts = new Map();
      for (const key of ownerLineKeys) ownerLineCounts.set(key, (ownerLineCounts.get(key) ?? 0) + 1);
      const candidate = ownerNodes.find((node, nodeIndex) => referenceCounts.get(node.nodeId) === 1 && ownerLineCounts.get(ownerLineKeys[nodeIndex]) === 1);
      if (!candidate) throw new Error("missing uniquely projected component-clone witness");
      const file = index.files.find((source) => source.path === ${JSON.stringify(PROJECTION_BOUNDARY_PATH)});
      const boundaryLine = ${JSON.stringify(boundary.boundaryLine)};
      const startUtf16 = file.original.indexOf(boundaryLine);
      if (startUtf16 < 0) throw new Error("missing exact projection boundary line");
      const nodeIndex = response.nodes.findIndex((node) => node.nodeId === candidate.nodeId);
      rekeyNode(response, nodeIndex, {
        path: file.path,
        fileSha256: textDigest(file.original),
        startUtf16,
        endUtf16: startUtf16 + boundaryLine.length,
        textSha256: textDigest(boundaryLine),
        structuralToken: true,
      });
    `);
    const score = forged.scoreSubmission({ projectDir, build: PASSING_BUILD });
    assertPublicScoreVector(score, boundary, boundary.name);
    const clone = ruleById(score, "ecs.component-clone");
    assert.equal(clone.reason, boundary.cloneReason);
    assert.deepEqual(
      clone.evidence.filter((row) => row.path === PROJECTION_BOUNDARY_PATH),
      boundary.cloneProjection,
    );
    assert.equal(forged.getAnalyzeCallCount(), 1);
    assert.equal(forged.getProjectionCallCount(), 16);
  });
});

function exactUtf8Padding(targetBytes, glyph, remainderCharacter) {
  const glyphBytes = Buffer.byteLength(glyph, "utf8");
  assert.equal(glyphBytes > 1, true, "typed-fact boundary: multibyte padding glyph");
  assert.equal(Buffer.byteLength(remainderCharacter, "utf8"), 1, "typed-fact boundary: one-byte remainder glyph");
  const padding = `${glyph.repeat(Math.floor(targetBytes / glyphBytes))}${remainderCharacter.repeat(targetBytes % glyphBytes)}`;
  assert.equal(Buffer.byteLength(padding, "utf8"), targetBytes, "typed-fact boundary: exact multibyte padding bytes");
  return padding;
}

function writeTypedFactBoundaryProject(t, targetBytes, { maskedComment = false } = {}) {
  const projectDir = writeCompleteProject(t);
  const before = loadSubmissionSources(projectDir);
  const fact = before.factEvidence.find((row) => row.kind === "manifest.metadata"
    && row.value === "pico.spatial.windowcontainer.defaultsize");
  assert.notEqual(fact, undefined, "typed-fact boundary: default-size fact");
  const file = before.files.find((row) => row.path === fact.path);
  assert.notEqual(file, undefined, "typed-fact boundary: manifest source");
  const structuralLine = file.structural.split(/\r?\n/)[fact.line - 1].trim();
  const baseStructuralBytes = Buffer.byteLength(structuralLine, "utf8");
  const manifestPath = path.join(projectDir, fact.path);
  const lines = fs.readFileSync(manifestPath, "utf8").split("\n");
  const originalLine = lines[fact.line - 1];
  if (maskedComment) {
    const commentPayloadBytes = targetBytes - Buffer.byteLength(originalLine.trim(), "utf8") - Buffer.byteLength("<!---->", "utf8");
    assert.equal(commentPayloadBytes >= 0, true, "typed-fact boundary: nonnegative comment payload");
    lines[fact.line - 1] = `${originalLine}<!--${exactUtf8Padding(commentPayloadBytes, "é", "x")}-->`;
  } else {
    const paddingBytes = targetBytes - Buffer.byteLength(structuralLine, "utf8");
    assert.equal(paddingBytes >= 0, true, "typed-fact boundary: nonnegative padding");
    const closeOffset = originalLine.lastIndexOf("/>");
    assert.equal(closeOffset >= 0, true, "typed-fact boundary: self-closing metadata line");
    lines[fact.line - 1] = `${originalLine.slice(0, closeOffset)}${exactUtf8Padding(paddingBytes, "\u2003", " ")}${originalLine.slice(closeOffset)}`;
  }
  fs.writeFileSync(manifestPath, lines.join("\n"), "utf8");

  const after = loadSubmissionSources(projectDir);
  const finalFact = after.factEvidence.find((row) => row.kind === "manifest.metadata"
    && row.value === "pico.spatial.windowcontainer.defaultsize");
  assert.notEqual(finalFact, undefined, "typed-fact boundary: final default-size fact");
  const finalFile = after.files.find((row) => row.path === finalFact.path);
  assert.notEqual(finalFile, undefined, "typed-fact boundary: final manifest source");
  const finalStructuralExcerpt = finalFile.structural.split(/\r?\n/)[finalFact.line - 1].trim();
  assert.equal(Buffer.byteLength(finalFact.excerpt, "utf8"), targetBytes, "typed-fact boundary: original excerpt bytes");
  const structuralBytes = Buffer.byteLength(finalStructuralExcerpt, "utf8");
  if (maskedComment) assert.equal(structuralBytes, baseStructuralBytes, "typed-fact boundary: comment is absent after masking");
  else assert.equal(structuralBytes, targetBytes, "typed-fact boundary: masked excerpt bytes");
  return Object.freeze({ projectDir, fact: finalFact, structuralBytes });
}

test("typed-fact evidence enforces the exact 512-byte UTF-8 boundary without throwing", async (t) => {
  assertDeepFrozen(PUBLIC_TYPED_FACT_BOUNDARY_VECTORS);
  const cases = Object.freeze([
    Object.freeze({
      name: "exactly 512 bytes",
      bytes: 512,
      pass: PUBLIC_TYPED_FACT_BOUNDARY_VECTORS.exact512,
      falseIds: Object.freeze([]),
      axes: Object.freeze({ spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 4 }),
      score: 16,
      reason: "supported-subset-v1 witness: one-helper-mixed-stage-open",
    }),
    Object.freeze({
      name: "exactly 513 structural bytes",
      bytes: 513,
      pass: PUBLIC_TYPED_FACT_BOUNDARY_VECTORS.exact513,
      falseIds: Object.freeze(["spatial.container-topology"]),
      axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 }),
      score: 15,
      reason: "supported-subset-v1 typed-fact evidence unrepresentable",
    }),
    Object.freeze({
      name: "exactly 513 public bytes with a masked comment",
      bytes: 513,
      maskedComment: true,
      pass: PUBLIC_TYPED_FACT_BOUNDARY_VECTORS.exact513,
      falseIds: Object.freeze(["spatial.container-topology"]),
      axes: Object.freeze({ spatialNative: 3, ecs: 4, statePassing: 4, planarTracking: 4 }),
      score: 15,
      reason: "supported-subset-v1 typed-fact evidence unrepresentable",
    }),
  ]);
  assertDeepFrozen(cases);
  for (const boundary of cases) await t.test(boundary.name, (t) => {
    const { projectDir, fact } = writeTypedFactBoundaryProject(t, boundary.bytes, { maskedComment: boundary.maskedComment ?? false });
    const score = scoreSubmission({ projectDir, build: PASSING_BUILD });
    assertPublicScoreVector(score, boundary, `typed-fact ${boundary.name}`);
    const topology = ruleById(score, "spatial.container-topology");
    assert.equal(topology.reason, boundary.reason);
    if (boundary.bytes === 512) {
      const row = topology.evidence.find((candidate) => candidate.evidenceClass === "typed_fact"
        && candidate.kind === "manifest.metadata"
        && candidate.value === "pico.spatial.windowcontainer.defaultsize");
      assert.notEqual(row, undefined, "typed-fact 512: exact metadata row");
      assert.equal(row.excerpt, fact.excerpt, "typed-fact 512: untruncated canonical excerpt");
      assert.equal(Buffer.byteLength(row.excerpt, "utf8"), 512, "typed-fact 512: public bytes");
    } else {
      assert.deepEqual(topology.evidence, [], "typed-fact 513: claim-local empty evidence");
    }
  });
});

function junitProject(t) {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbench-junit-project-")));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function fakeGradle(t, source) {
  const runnerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbench-gradle-runner-")));
  t.after(() => fs.rmSync(runnerDir, { recursive: true, force: true }));
  const executable = path.join(runnerDir, "gradle");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  const expectedGradleSha256 = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  return { executable, expectedGradleSha256 };
}

async function executeFake(t, projectDir, source = "") {
  const runner = fakeGradle(t, source);
  return runTrustedJUnitExecution({
    projectDir,
    gradleExecutable: runner.executable,
    expectedGradleSha256: runner.expectedGradleSha256,
  });
}

function resultDirectory(projectDir) {
  const directory = path.join(projectDir, "app/build/test-results/testDebugUnitTest");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function xmlSuite({ tests = 1, failures = 0, errors = 0, skipped = 0, body = '<testcase name="state" classname="GalleryStateTest" time="0.01" />' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="GalleryStateTest" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="0.01">${body}</testsuite>\n`;
}

function writeResult(projectDir, name, xml) {
  const target = path.join(resultDirectory(projectDir), name);
  fs.writeFileSync(target, xml, "utf8");
  return target;
}

test("trusted JUnit execution verifies the runner and passes explicit resolved JDK/Android SDK environment", async (t) => {
  const projectDir = junitProject(t);
  const execution = await executeFake(t, projectDir, `
const record = {
  args: process.argv.slice(2),
  javaHome: process.env.JAVA_HOME,
  androidHome: process.env.ANDROID_HOME,
  androidSdkRoot: process.env.ANDROID_SDK_ROOT,
};
process.stdout.write(JSON.stringify(record));
`);
  const record = JSON.parse(Buffer.from(execution.stdout).toString("utf8"));
  assert.deepEqual(record.args, ["--offline", "--no-daemon", "--no-configuration-cache", "--console=plain", ":app:testDebugUnitTest"]);
  assert.equal(path.isAbsolute(record.javaHome), true);
  assert.equal(path.isAbsolute(record.androidHome), true);
  assert.equal(record.androidHome, record.androidSdkRoot);
  assert.equal(fs.realpathSync(record.javaHome), record.javaHome);
  assert.equal(fs.realpathSync(record.androidHome), record.androidHome);
  assert.equal(execution.receipt.stdoutBytes, execution.stdout.byteLength);
  assert.equal(execution.receipt.stderrBytes, 0);
  assert.match(execution.receipt.launcherSha256, /^[a-f0-9]{64}$/);

  const wrongHash = fakeGradle(t, "process.exit(0)");
  await assert.rejects(() => runTrustedJUnitExecution({ projectDir, gradleExecutable: wrongHash.executable, expectedGradleSha256: "0".repeat(64) }), /hash|digest/i);
  const symlink = path.join(path.dirname(wrongHash.executable), "linked-gradle");
  fs.symlinkSync(wrongHash.executable, symlink);
  await assert.rejects(() => runTrustedJUnitExecution({ projectDir, gradleExecutable: symlink, expectedGradleSha256: wrongHash.expectedGradleSha256 }), /symlink|canonical|regular/i);
});

test("trusted JUnit execution enforces the inclusive stream cap independently and before receipt minting", async (t) => {
  const projectDir = junitProject(t);
  for (const stream of ["stdout", "stderr"]) await t.test(`${stream} exact cap`, async (t) => {
    const execution = await executeFake(t, projectDir, `process.${stream}.write(Buffer.alloc(${TEST_EXECUTION_STREAM_MAX_BYTES}, 120));`);
    assert.equal(execution[stream].byteLength, TEST_EXECUTION_STREAM_MAX_BYTES);
    assert.equal(execution.receipt[`${stream}Bytes`], TEST_EXECUTION_STREAM_MAX_BYTES);
    assert.equal(execution.receipt[`${stream}Sha256`], crypto.createHash("sha256").update(execution[stream]).digest("hex"));
  });

  for (const stream of ["stdout", "stderr"]) await t.test(`${stream} cap plus one`, async (t) => {
    await assert.rejects(() => executeFake(t, projectDir, `process.${stream}.write(Buffer.alloc(${TEST_EXECUTION_STREAM_MAX_BYTES + 1}, 120));`), /exceeds|limit|overflow/i);
  });

  for (const stream of ["stdout", "stderr"]) await t.test(`${stream} multi-chunk overflow`, async (t) => {
    await assert.rejects(() => executeFake(t, projectDir, `
process.${stream}.write(Buffer.alloc(${TEST_EXECUTION_STREAM_MAX_BYTES - 1}, 120), () => {
  process.${stream}.write(Buffer.from("yz"));
});
`), /exceeds|limit|overflow/i);
  });
});

test("fresh JUnit parsing normalizes pass, fail, execution failure, and exact no-source outcomes", async (t) => {
  await t.test("pass", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    writeResult(projectDir, "TEST-pass.xml", xmlSuite());
    const result = parseFreshJUnitResults({ projectDir, before, execution });
    assert.deepEqual([result.status, result.testCount, result.passedCount, result.failureCount, result.errorCount, result.skippedCount], ["pass", 1, 1, 0, 0, 0]);
    assert.equal(result.resultFiles.length, 1);
    assert.equal(result.preBuildResultsSha256, before.sha256);
    const { receiptSha256, ...receiptBody } = result;
    assert.equal(receiptSha256, crypto.createHash("sha256").update(canonicalJson(receiptBody)).digest("hex"));
  });

  await t.test("pass tolerates unrelated Gradle tasks that are legitimately no-source", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, 'process.stdout.write("> Task :app:mergeDebugNativeDebugMetadata NO-SOURCE\\n> Task :app:testDebugUnitTest\\n");');
    writeResult(projectDir, "TEST-pass.xml", xmlSuite());
    const result = parseFreshJUnitResults({ projectDir, before, execution });
    assert.deepEqual([result.status, result.testCount, result.passedCount], ["pass", 1, 1]);
  });

  await t.test("fail keeps failures, errors, and skips separate", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, "process.exitCode = 1;");
    writeResult(projectDir, "TEST-fail.xml", xmlSuite({
      tests: 3,
      failures: 1,
      errors: 1,
      skipped: 1,
      body: '<testcase name="failure" classname="C"><failure message="failed" /></testcase><testcase name="error" classname="C"><error message="errored" /></testcase><testcase name="skip" classname="C"><skipped /></testcase>',
    }));
    const result = parseFreshJUnitResults({ projectDir, before, execution });
    assert.deepEqual([result.status, result.testCount, result.passedCount, result.failureCount, result.errorCount, result.skippedCount], ["fail", 3, 0, 1, 1, 1]);
  });

  await t.test("execution_failed", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, "process.exitCode = 2;");
    const result = parseFreshJUnitResults({ projectDir, before, execution });
    assert.deepEqual([result.status, result.testCount, result.resultFiles.length], ["execution_failed", 0, 0]);
  });

  await t.test("no_source", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, 'process.stdout.write("> Task :app:testDebugUnitTest NO-SOURCE\\n");');
    const result = parseFreshJUnitResults({ projectDir, before, execution });
    assert.deepEqual([result.status, result.testCount, result.resultFiles.length], ["no_source", 0, 0]);
  });
});

test("fresh JUnit parsing rejects stale, ambiguous, unbranded, and byte-mismatched evidence", async (t) => {
  await t.test("zero exit without XML or exact no-source", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /ambiguous|fresh|source/i);
  });

  await t.test("fresh all-pass XML with nonzero exit", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, "process.exitCode = 1;");
    writeResult(projectDir, "TEST-pass.xml", xmlSuite());
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /exit|contradict|ambiguous/i);
  });

  await t.test("no-source with fresh XML", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, 'process.stdout.write("> Task :app:testDebugUnitTest NO-SOURCE\\n");');
    writeResult(projectDir, "TEST-pass.xml", xmlSuite());
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /source|XML|contradict/i);
  });

  await t.test("duplicate target outcome lines with fresh XML", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, 'process.stdout.write("> Task :app:testDebugUnitTest\\n> Task :app:testDebugUnitTest\\n");');
    writeResult(projectDir, "TEST-pass.xml", xmlSuite());
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /outcome|duplicate|contradict|ambiguous/i);
  });

  await t.test("stale XML", async (t) => {
    const projectDir = junitProject(t);
    writeResult(projectDir, "TEST-stale.xml", xmlSuite());
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /stale|fresh/i);
  });

  await t.test("unbranded execution", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution: { receipt: execution.receipt, stdout: execution.stdout, stderr: execution.stderr } }), /brand|trusted|execution/i);
  });

  await t.test("mutated output bytes", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, 'process.stdout.write("x");');
    execution.stdout[0] = 121;
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /stdout|bytes|hash|digest/i);
  });

  await t.test("fatal UTF-8 Gradle output", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, "process.stdout.write(Buffer.from([0xff]));");
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /UTF-8|output/i);
  });

  for (const output of [
    "> Task :other:testDebugUnitTest NO-SOURCE\n",
    "prefix > Task :app:testDebugUnitTest NO-SOURCE\n",
    "\u001b[31m> Task :app:testDebugUnitTest NO-SOURCE\u001b[0m\n",
    "> Task :app:testDebugUnitTest NO-SOURCE\n> Task :app:testDebugUnitTest NO-SOURCE\n",
  ]) await t.test(`spoofed outcome ${JSON.stringify(output)}`, async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir, `process.stdout.write(${JSON.stringify(output)});`);
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /outcome|source|control|ambiguous/i);
  });
});

test("JUnit snapshots and XML parsing fail closed on filesystem and XML boundary attacks", async (t) => {
  await t.test("symlink and special result files", async (t) => {
    const projectDir = junitProject(t);
    const directory = resultDirectory(projectDir);
    const outside = path.join(projectDir, "outside.xml");
    fs.writeFileSync(outside, xmlSuite());
    fs.symlinkSync(outside, path.join(directory, "TEST-link.xml"));
    assert.throws(() => snapshotJUnitResults(projectDir), /symlink|regular/i);
    fs.unlinkSync(path.join(directory, "TEST-link.xml"));
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path.join(directory, "TEST-pipe.xml")]);
      assert.throws(() => snapshotJUnitResults(projectDir), /special|regular/i);
    }
  });

  await t.test("caller snapshots retain file-count, total-byte, and XML-path bounds", async (t) => {
    const projectDir = junitProject(t);
    const execution = await executeFake(t, projectDir, "process.exitCode = 1;");
    const row = (index, bytes = 0, suffix = ".xml") => ({
      path: `app/build/test-results/testDebugUnitTest/TEST-${String(index).padStart(3, "0")}${suffix}`,
      bytes,
      sha256: "0".repeat(64),
      device: "1",
      inode: String(index + 1),
      mtimeMs: 1,
      ctimeMs: 1,
    });
    const snapshot = (files) => ({ sha256: crypto.createHash("sha256").update(canonicalJson(files)).digest("hex"), files });
    const tooMany = Array.from({ length: 257 }, (_, index) => row(index));
    assert.throws(() => parseFreshJUnitResults({ projectDir, before: snapshot(tooMany), execution }), /256|files|bound/i);
    const tooLarge = Array.from({ length: 9 }, (_, index) => row(index, 2 * 1024 * 1024));
    assert.throws(() => parseFreshJUnitResults({ projectDir, before: snapshot(tooLarge), execution }), /16 MiB|total|bytes|bound/i);
    const nonXml = [row(0, 0, ".txt")];
    assert.throws(() => parseFreshJUnitResults({ projectDir, before: snapshot(nonXml), execution }), /XML|path/i);
  });

  const malformed = [
    ["DOCTYPE", '<!DOCTYPE testsuite><testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="x" /></testsuite>'],
    ["entity reference", '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="a&amp;b" /></testsuite>'],
    ["CDATA", '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="x"><![CDATA[x]]></testcase></testsuite>'],
    ["processing instruction", '<testsuite tests="1" failures="0" errors="0" skipped="0"><?run x?><testcase name="x" /></testsuite>'],
    ["multiple roots", '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="x" /></testsuite><testsuite tests="0" failures="0" errors="0" skipped="0" />'],
    ["zero tests", '<testsuite tests="0" failures="0" errors="0" skipped="0" />'],
    ["count mismatch", '<testsuite tests="2" failures="0" errors="0" skipped="0"><testcase name="x" /></testsuite>'],
    ["depth", `<testsuite tests="1" failures="0" errors="0" skipped="0">${"<group>".repeat(32)}<testcase name="x" />${"</group>".repeat(32)}</testsuite>`],
    ["attributes", `<testsuite tests="1" failures="0" errors="0" skipped="0" ${Array.from({ length: 61 }, (_, index) => `a${index}="x"`).join(" ")}><testcase name="x" /></testsuite>`],
    ["XInclude", '<testsuite tests="1" failures="0" errors="0" skipped="0" xmlns:xi="http://www.w3.org/2001/XInclude"><testcase name="x" /><xi:include href="file:///etc/passwd" /></testsuite>'],
    ["stylesheet", '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="x" /><stylesheet href="https://example.invalid/style.xsl" /></testsuite>'],
    ["schema", '<testsuite tests="1" failures="0" errors="0" skipped="0" schemaLocation="file:///tmp/schema.xsd"><testcase name="x" /></testsuite>'],
    ["prefixed relative schema", '<testsuite xmlns:xsi="urn:test" xsi:schemaLocation="relative.xsd" tests="1" failures="0" errors="0" skipped="0"><testcase name="x" /></testsuite>'],
    ["filesystem source", '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="x" src="/etc/passwd" /></testsuite>'],
  ];
  for (const [name, xml] of malformed) await t.test(name, async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    writeResult(projectDir, "TEST-malformed.xml", xml);
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /XML|DOCTYPE|entity|CDATA|processing|root|test|count|depth|attribute|bound/i);
  });

  await t.test("fatal UTF-8 XML", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    fs.writeFileSync(path.join(resultDirectory(projectDir), "TEST-invalid-utf8.xml"), Buffer.from([0xff]));
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /UTF-8|XML/i);
  });

  await t.test("per-file byte bound", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    writeResult(projectDir, "TEST-large.xml", "x".repeat(2 * 1024 * 1024 + 1));
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /2 MiB|bytes|large|bound/i);
  });

  await t.test("file-count bound", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    for (let index = 0; index < 257; index += 1) writeResult(projectDir, `TEST-${String(index).padStart(3, "0")}.xml`, xmlSuite());
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /256|files|bound/i);
  });

  await t.test("total result byte bound", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    for (let index = 0; index < 9; index += 1) writeResult(projectDir, `TEST-large-${index}.xml`, "x".repeat(2 * 1024 * 1024));
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /16 MiB|total|bytes|bound/i);
  });

  await t.test("testcase-count bound", async (t) => {
    const projectDir = junitProject(t);
    const before = snapshotJUnitResults(projectDir);
    const execution = await executeFake(t, projectDir);
    writeResult(projectDir, "TEST-many.xml", `<testsuite tests="100001" failures="0" errors="0" skipped="0">${"<testcase/>".repeat(100_001)}</testsuite>`);
    assert.throws(() => parseFreshJUnitResults({ projectDir, before, execution }), /100000|100,000|test cases|bound/i);
  });
});
