import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../benchmarks/spatial-agent-bench/lib/identity.mjs";
import { ANALYZER_CONSTANTS, analyzeKotlin, computeKotlinInputSetSha256, computeSelectedInputSetSha256,
  describeKotlinAnalyzer, verifyAnalyzerArtifact } from "../benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs";
import { loadSubmissionSources } from "../benchmarks/spatial-agent-bench/lib/source.mjs";
import { spawnFakeAnalyzer } from "./fixtures/agentbench/fake-analyzer.mjs";
import {
  UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS,
  writeEquivalentReopenProject,
  writeUncorrectedCheckpointProject,
} from "./helpers/agentbench-fixture.mjs";
const ROOT = path.resolve(import.meta.dirname, "..");
const BRIDGE = path.join(ROOT, "benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs");
const BUILD = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/build-analyzer.mjs");
const ANALYZER_DIR = path.dirname(BUILD);
const ARTIFACT = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-v1.jar");
const RECEIPT = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-build-receipt-v1.json");
const DOMAIN = path.join(ANALYZER_DIR, "domain-v1.json");
const JAVA_ROOT = path.join(ANALYZER_DIR, "src/main/java/com/agentbench/analyzer");
const ARTIFACTS = path.dirname(path.dirname(ARTIFACT));
const CLEAN_ENV = ["LANG=C", "LC_ALL=C", "TZ=UTC", "__CF_USER_TEXT_ENCODING=0x1F5:0x0:0x0"];
const RECEIPT_DOMAIN = Buffer.from("agentbench-analyzer-receipt-v1\0", "utf8");
const RULE_ORDER = Object.freeze([
  "spatial.project-entry", "spatial.container-topology", "spatial.entity-content", "spatial.ui-lifecycle",
  "ecs.component-clone", "ecs.system-query", "ecs.frame-update", "ecs.lifecycle",
  "state.single-source", "state.typed-handoff", "state.shared-read-write", "state.reopen-wiring",
  "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose", "plane.cleanup-errors",
]);
const WITNESS_KINDS = Object.freeze([
  "declaration", "callable_reference", "call", "argument", "property_read", "assignment",
  "condition", "loop", "lambda", "return", "type_reference", "catch",
]);
const PROOF_FORMS_BY_RULE = Object.freeze({
  "ecs.component-clone": ["expression-component-clone", "single-return-block-component-clone"],
  "ecs.frame-update": ["assign-delta-update", "plus-assign-delta-update"],
  "ecs.lifecycle": ["paired-system-lifecycle"],
  "ecs.system-query": ["hoisted-query-scene-update"],
  "plane.anchor-pose": ["same-anchor-pose-conversion"],
  "plane.cleanup-errors": ["paired-plane-cleanup-status"],
  "plane.retry-readiness": ["bounded-retained-load-retry"],
  "plane.semantic-fallback": ["dominating-semantic-plane-fallback"],
  "spatial.container-topology": ["direct-mixed-stage-open", "one-helper-mixed-stage-open", "two-helper-mixed-stage-open"],
  "spatial.entity-content": ["spatial-view-entity-attachment"],
  "spatial.project-entry": ["application-launch-root"],
  "spatial.ui-lifecycle": ["themed-window-and-disposable-stage"],
  "state.reopen-wiring": ["retained-state-close-reopen"],
  "state.shared-read-write": ["same-authority-read-write"],
  "state.single-source": ["shared-strong-authority"],
  "state.typed-handoff": ["typed-bundle-roundtrip"],
});
const ACCEPTED_ALTERNATIVES_BY_RULE = Object.freeze({
  "ecs.component-clone": {
    "expression-component-clone": ["positional-fields", "named-fields"],
    "single-return-block-component-clone": ["positional-fields", "named-fields"],
  },
  "ecs.frame-update": {
    "assign-delta-update": ["direct-transform", "pure-helper-transform"],
    "plus-assign-delta-update": ["direct-transform", "pure-helper-transform"],
  },
  "ecs.lifecycle": { "paired-system-lifecycle": ["direct-register-unregister"] },
  "ecs.system-query": { "hoisted-query-scene-update": ["direct-query-use", "pure-helper-query-use"] },
  "plane.anchor-pose": { "same-anchor-pose-conversion": ["direct-pose-conversion", "pure-helper-pose-conversion"] },
  "plane.cleanup-errors": { "paired-plane-cleanup-status": ["direct-cleanup", "unique-helper-cleanup"] },
  "plane.retry-readiness": { "bounded-retained-load-retry": ["bounded-for", "canonical-bounded-while"] },
  "plane.semantic-fallback": { "dominating-semantic-plane-fallback": ["inline-selectors", "unique-helper-selectors"] },
  "spatial.container-topology": {
    "direct-mixed-stage-open": ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"],
    "one-helper-mixed-stage-open": ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"],
    "two-helper-mixed-stage-open": ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"],
  },
  "spatial.entity-content": { "spatial-view-entity-attachment": ["direct-initial-entity", "unique-helper-initial-entity"] },
  "spatial.project-entry": { "application-launch-root": ["direct-launch-import", "aliased-launch-import"] },
  "spatial.ui-lifecycle": { "themed-window-and-disposable-stage": ["direct-theme-paired-dispose"] },
  "state.reopen-wiring": { "retained-state-close-reopen": ["standard-store-reopen", "equivalent-repository-reopen"] },
  "state.shared-read-write": { "same-authority-read-write": ["direct-container-summaries"] },
  "state.single-source": { "shared-strong-authority": ["top-level-val", "object-singleton", "companion-held-singleton"] },
  "state.typed-handoff": { "typed-bundle-roundtrip": ["direct-bundle-adapter", "unique-helper-bundle-adapter"] },
});
function followup2DeepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) followup2DeepFreeze(nested);
  }
  return value;
}
const MIGRATED_CANARY_SYMBOLS = followup2DeepFreeze([{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.Component","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"component","returnSource":null,"signature":"Component()","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.Component","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"component","returnSource":null,"signature":"open class Component","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.Component.clone","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"component","receiverKind":"instance","returnAbstractType":"component","returnSource":null,"signature":"clone(): Component","typeArguments":[]}]);
const FULL_BATCH2B_SYMBOLS = followup2DeepFreeze([{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"android.app.Application","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"android_application","returnSource":null,"signature":"Application()","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"android.app.Application","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"android_application","returnSource":null,"signature":"open class Application","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"android.app.Application.onCreate","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"android_application","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"onCreate(): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"android.os.BaseBundle","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"bundle","returnSource":null,"signature":"open class BaseBundle","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"key","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"android.os.BaseBundle.getBoolean","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"bundle","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"getBoolean(key: String): Boolean","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"key","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"android.os.BaseBundle.getInt","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"bundle","receiverKind":"instance","returnAbstractType":"int","returnSource":null,"signature":"getInt(key: String): Int","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"key","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"android.os.BaseBundle.getString","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"bundle","receiverKind":"instance","returnAbstractType":"string","returnSource":null,"signature":"getString(key: String): String?","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"key","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"boolean","hasDefault":false,"name":"value","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"android.os.BaseBundle.putBoolean","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"bundle","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"putBoolean(key: String, value: Boolean): Unit","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"key","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"int","hasDefault":false,"name":"value","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"android.os.BaseBundle.putInt","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"bundle","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"putInt(key: String, value: Int): Unit","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"key","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"string","hasDefault":false,"name":"value","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"android.os.BaseBundle.putString","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"bundle","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"putString(key: String, value: String?): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"android.os.Bundle","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"bundle","returnSource":null,"signature":"Bundle()","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"android.os.Bundle","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"bundle","returnSource":null,"signature":"class Bundle","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.foundation.layout.RowScope","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"row_scope","returnSource":null,"signature":"interface RowScope","typeArguments":[]},{"arguments":[{"abstractType":"float","hasDefault":true,"name":"fraction","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"androidx.compose.foundation.layout.fillMaxSize","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"modifier","receiverKind":"instance","returnAbstractType":"modifier","returnSource":null,"signature":"Modifier.fillMaxSize(fraction: Float = 1f): Modifier","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.CompositionLocal","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"composition_local","returnSource":null,"signature":"abstract class CompositionLocal<T>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"androidx.compose.runtime.CompositionLocal.current","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"composition_local","receiverKind":"instance","returnAbstractType":"spatial_navigator","returnSource":null,"signature":"current: T","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"effect","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"acquire_path","parameters":[],"receiverAbstractType":"disposable_effect_scope","receiverSource":null,"role":"disposable_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.DisposableEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"DisposableEffect(key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key2","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"effect","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":2,"invocationModel":"acquire_path","parameters":[],"receiverAbstractType":"disposable_effect_scope","receiverSource":null,"role":"disposable_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.DisposableEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"DisposableEffect(key1: Any?, key2: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key2","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key3","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"effect","position":3,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":3,"invocationModel":"acquire_path","parameters":[],"receiverAbstractType":"disposable_effect_scope","receiverSource":null,"role":"disposable_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.DisposableEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"DisposableEffect(key1: Any?, key2: Any?, key3: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"keys","position":0,"samInterfaceFqn":null,"variadic":true},{"abstractType":"callable","hasDefault":false,"name":"effect","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"acquire_path","parameters":[],"receiverAbstractType":"disposable_effect_scope","receiverSource":null,"role":"disposable_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.DisposableEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"DisposableEffect(vararg keys: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.DisposableEffectScope","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"disposable_effect_scope","returnSource":null,"signature":"class DisposableEffectScope","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"onDisposeEffect","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"cleanup_path","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"dispose_cleanup"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.DisposableEffectScope.onDispose","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"disposable_effect_scope","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"onDispose(onDisposeEffect: () -> Unit): DisposableEffectResult","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"block","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"launched_path","parameters":[],"receiverAbstractType":"coroutine_scope","receiverSource":null,"role":"launched_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.LaunchedEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"LaunchedEffect(key1: Any?, block: suspend CoroutineScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key2","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"block","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":2,"invocationModel":"launched_path","parameters":[],"receiverAbstractType":"coroutine_scope","receiverSource":null,"role":"launched_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.LaunchedEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"LaunchedEffect(key1: Any?, key2: Any?, block: suspend CoroutineScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key2","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key3","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"block","position":3,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":3,"invocationModel":"launched_path","parameters":[],"receiverAbstractType":"coroutine_scope","receiverSource":null,"role":"launched_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.LaunchedEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"LaunchedEffect(key1: Any?, key2: Any?, key3: Any?, block: suspend CoroutineScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"keys","position":0,"samInterfaceFqn":null,"variadic":true},{"abstractType":"callable","hasDefault":false,"name":"block","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"launched_path","parameters":[],"receiverAbstractType":"coroutine_scope","receiverSource":null,"role":"launched_effect"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.LaunchedEffect","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"LaunchedEffect(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.runtime.ProvidableCompositionLocal","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"composition_local","returnSource":null,"signature":"abstract class ProvidableCompositionLocal<T>","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"calculation","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"remembered_factory"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"androidx.compose.runtime.remember","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":null,"returnSource":null,"signature":"remember(calculation: () -> T): T","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"calculation","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"remembered_factory"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"androidx.compose.runtime.remember","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":null,"returnSource":null,"signature":"remember(key1: Any?, calculation: () -> T): T","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key2","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"calculation","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":2,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"remembered_factory"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"androidx.compose.runtime.remember","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":null,"returnSource":null,"signature":"remember(key1: Any?, key2: Any?, calculation: () -> T): T","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"key1","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key2","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"key3","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"calculation","position":3,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":3,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"remembered_factory"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"androidx.compose.runtime.remember","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":null,"returnSource":null,"signature":"remember(key1: Any?, key2: Any?, key3: Any?, calculation: () -> T): T","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"keys","position":0,"samInterfaceFqn":null,"variadic":true},{"abstractType":"callable","hasDefault":false,"name":"calculation","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"remembered_factory"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"androidx.compose.runtime.remember","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":null,"returnSource":null,"signature":"remember(vararg keys: Any?, calculation: () -> T): T","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":true,"name":"getContext","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"androidx.compose.runtime.rememberCoroutineScope","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"coroutine_scope","returnSource":null,"signature":"rememberCoroutineScope(getContext: () -> CoroutineContext = default): CoroutineScope","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.ui.Modifier","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"modifier","returnSource":null,"signature":"interface Modifier","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"androidx.compose.ui.Modifier.Companion","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"modifier","returnSource":null,"signature":"companion object : Modifier","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":true,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.container.SpatialViewContent","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_content","returnSource":null,"signature":"class SpatialViewContent","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":["immutable_iterable"],"effects":[],"fqn":"com.pico.spatial.core.container.SpatialViewEntityCollection","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"entity_collection","returnSource":null,"signature":"open class SpatialViewEntityCollection","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.container.SpatialViewEntityManager","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_content","returnSource":null,"signature":"interface SpatialViewEntityManager","typeArguments":[]},{"arguments":[{"abstractType":"entity","hasDefault":false,"name":"entity","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["place"],"fqn":"com.pico.spatial.core.container.SpatialViewEntityManager.addEntity","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"addEntity(entity: Entity): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.container.SpatialViewEntityManager.entities","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"entity_collection","returnSource":null,"signature":"entities: SpatialViewEntityCollection","typeArguments":[]},{"arguments":[{"abstractType":"entity","hasDefault":false,"name":"entity","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"com.pico.spatial.core.container.SpatialViewEntityManager.removeEntity","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"removeEntity(entity: Entity): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.container.SpatialViewEventManager","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_content","returnSource":null,"signature":"interface SpatialViewEventManager","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.container.SpatialViewEventManager.filter","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"filter: EventSourceFilter","typeArguments":[]},{"arguments":[{"abstractType":"java_class","hasDefault":false,"name":"eventType","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"on","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"java_class","hasDefault":true,"name":"componentType","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"subscriber","position":3,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["acquire"],"fqn":"com.pico.spatial.core.container.SpatialViewEventManager.subscribe","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"cancellable","returnSource":null,"signature":"subscribe(eventType: Class<T>, on: EventSource? = null, componentType: Class<out Component>? = null, subscriber: EventSubscriber<T>): Cancellable","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_content","returnSource":null,"signature":"interface SpatialCoordinateSpaceConverter","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"position","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertPosition","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"convertPosition(position: Vector3, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Vector3","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"position","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertPosition","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"convertPosition(position: Vector3, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Vector3","typeArguments":[]},{"arguments":[{"abstractType":"quat","hasDefault":false,"name":"rotation","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertRotation","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"quat","returnSource":null,"signature":"convertRotation(rotation: Quat, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Quat","typeArguments":[]},{"arguments":[{"abstractType":"quat","hasDefault":false,"name":"rotation","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertRotation","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"quat","returnSource":null,"signature":"convertRotation(rotation: Quat, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Quat","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"scale","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertScale","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"convertScale(scale: Vector3, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Vector3","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"scale","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertScale","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"convertScale(scale: Vector3, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Vector3","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"size","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertSize","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"convertSize(size: Vector3, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Vector3","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"size","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"from","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":false,"name":"to","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertSize","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"convertSize(size: Vector3, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Vector3","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.localSpatialCoordinateSpace","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_content","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"localSpatialCoordinateSpace: SpatialCoordinateSpace","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.Component","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"component","returnSource":null,"signature":"Component()","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.Component","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"component","returnSource":null,"signature":"open class Component","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.Component.clone","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"component","receiverKind":"instance","returnAbstractType":"component","returnSource":null,"signature":"clone(): Component","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.Entity","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"entity","returnSource":null,"signature":"Entity()","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.Entity","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"entity","returnSource":null,"signature":"open class Entity","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.Entity.ComponentSet","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"component_store","returnSource":null,"signature":"class ComponentSet","typeArguments":[]},{"arguments":[{"abstractType":"java_class","hasDefault":false,"name":"componentType","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.ecs.Entity.ComponentSet.get","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":"index_get","receiverAbstractType":"component_store","receiverKind":"instance","returnAbstractType":null,"returnSource":"class_of_argument","signature":"get(componentType: Class<T>): T?","typeArguments":[]},{"arguments":[{"abstractType":"component","hasDefault":false,"name":"component","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate","replace"],"fqn":"com.pico.spatial.core.ecs.Entity.ComponentSet.set","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"component_store","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"set(component: T): Unit","typeArguments":[]},{"arguments":[{"abstractType":"entity","hasDefault":false,"name":"entity","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["place"],"fqn":"com.pico.spatial.core.ecs.Entity.addChild","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"entity","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"addChild(entity: Entity): Boolean","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.ecs.Entity.components","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"entity","receiverKind":"instance","returnAbstractType":"component_store","returnSource":null,"signature":"components: ComponentSet","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"position","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"entity","hasDefault":false,"name":"baseEntity","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.ecs.Entity.convertPositionFrom","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"entity","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"convertPositionFrom(position: Vector3, baseEntity: Entity?): Vector3","typeArguments":[]},{"arguments":[{"abstractType":"quat","hasDefault":false,"name":"rotation","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"entity","hasDefault":false,"name":"baseEntity","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"com.pico.spatial.core.ecs.Entity.convertRotationFrom","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"entity","receiverKind":"instance","returnAbstractType":"quat","returnSource":null,"signature":"convertRotationFrom(rotation: Quat, baseEntity: Entity?): Quat","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.EntityQueryCondition","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"entity_query_condition","returnSource":null,"signature":"class EntityQueryCondition","typeArguments":[]},{"arguments":[{"abstractType":"java_class","hasDefault":false,"name":"componentClass","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.EntityQueryCondition.hasComponent","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"entity_query_condition","receiverKind":"declaring_type","returnAbstractType":"entity_query_condition","returnSource":null,"signature":"hasComponent(componentClass: Class<T>): EntityQueryCondition","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.Scene","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"scene","returnSource":null,"signature":"class Scene","typeArguments":[]},{"arguments":[{"abstractType":"entity_query_condition","hasDefault":false,"name":"conditions","position":0,"samInterfaceFqn":null,"variadic":true}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.ecs.Scene.queryEntity","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"scene","receiverKind":"instance","returnAbstractType":"entity_collection","returnSource":null,"signature":"queryEntity(vararg conditions: EntityQueryCondition): List<Entity>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.SceneUpdateContext","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"scene_update_context","returnSource":null,"signature":"class SceneUpdateContext","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.ecs.SceneUpdateContext.deltaTime","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"scene_update_context","receiverKind":"instance","returnAbstractType":"float","returnSource":null,"signature":"deltaTime: Float","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.ecs.SceneUpdateContext.scene","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"scene_update_context","receiverKind":"instance","returnAbstractType":"scene","returnSource":null,"signature":"scene: Scene","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.System","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"ecs_system","returnSource":null,"signature":"System()","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.System","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"ecs_system","returnSource":null,"signature":"abstract class System","typeArguments":[]},{"arguments":[{"abstractType":"scene_update_context","hasDefault":false,"name":"context","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.ecs.System.update","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"ecs_system","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"update(context: SceneUpdateContext): Unit","typeArguments":[]},{"arguments":[{"abstractType":"vector3","hasDefault":false,"name":"position","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"quat","hasDefault":false,"name":"rotation","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"vector3","hasDefault":false,"name":"scale","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.ecs.TransformComponent","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"transform_component","returnSource":null,"signature":"TransformComponent(position: Vector3, rotation: Quat, scale: Vector3)","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":["component"],"effects":[],"fqn":"com.pico.spatial.core.ecs.TransformComponent","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"transform_component","returnSource":null,"signature":"class TransformComponent","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read","mutate"],"fqn":"com.pico.spatial.core.ecs.TransformComponent.position","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"transform_component","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"position: Vector3","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.lifecycle.Cancellable","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"cancellable","returnSource":null,"signature":"interface Cancellable","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["release"],"fqn":"com.pico.spatial.core.lifecycle.Cancellable.cancel","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"cancellable","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"cancel(): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.math.Quat","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"quat","returnSource":null,"signature":"class Quat","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.math.Quat.identity","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"quat","receiverKind":"declaring_type","returnAbstractType":"quat","returnSource":null,"signature":"identity(): Quat","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.math.Transform","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"transform","returnSource":null,"signature":"class Transform","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.math.Transform.position","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"transform","receiverKind":"instance","returnAbstractType":"vector3","returnSource":null,"signature":"position: Vector3","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.math.Transform.quaternion","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"transform","receiverKind":"instance","returnAbstractType":"quat","returnSource":null,"signature":"quaternion: Quat","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.math.Vector2","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"vector2","returnSource":null,"signature":"class Vector2","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.math.Vector2.x","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"vector2","receiverKind":"instance","returnAbstractType":"float","returnSource":null,"signature":"x: Float","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.math.Vector2.y","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"vector2","receiverKind":"instance","returnAbstractType":"float","returnSource":null,"signature":"y: Float","typeArguments":[]},{"arguments":[{"abstractType":"float","hasDefault":true,"name":"x","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"float","hasDefault":true,"name":"y","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"float","hasDefault":true,"name":"z","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.core.math.Vector3","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"vector3","returnSource":null,"signature":"Vector3(x: Float = 0f, y: Float = 0f, z: Float = 0f)","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.core.math.Vector3","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"vector3","returnSource":null,"signature":"class Vector3","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.math.Vector3.x","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"vector3","receiverKind":"instance","returnAbstractType":"float","returnSource":null,"signature":"x: Float","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.math.Vector3.y","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"vector3","receiverKind":"instance","returnAbstractType":"float","returnSource":null,"signature":"y: Float","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.core.math.Vector3.z","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"vector3","receiverKind":"instance","returnAbstractType":"float","returnSource":null,"signature":"z: Float","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.sense.base.AnchorUpdate","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"anchor_update","returnSource":null,"signature":"class AnchorUpdate<T : Anchor>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.sense.base.SemanticLabelType","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"semantic_label","returnSource":null,"signature":"enum class SemanticLabelType","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.base.SemanticLabelType.FLOOR","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"semantic_label","receiverKind":"declaring_type","returnAbstractType":"semantic_label","returnSource":null,"signature":"FLOOR","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.base.SemanticLabelType.TABLE","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"semantic_label","receiverKind":"declaring_type","returnAbstractType":"semantic_label","returnSource":null,"signature":"TABLE","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.sense.plane.PlaneAnchor","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"plane_anchor","returnSource":null,"signature":"class PlaneAnchor","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.plane.PlaneAnchor.boundingBoxSize","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_anchor","receiverKind":"instance","returnAbstractType":"vector2","returnSource":null,"signature":"boundingBoxSize: Vector2","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.plane.PlaneAnchor.planeOrientation","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_anchor","receiverKind":"instance","returnAbstractType":"plane_orientation","returnSource":null,"signature":"planeOrientation: PlaneOrientation","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.plane.PlaneAnchor.semantics","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_anchor","receiverKind":"instance","returnAbstractType":"semantic_label","returnSource":null,"signature":"semantics: SemanticLabelType","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.plane.PlaneAnchor.transform","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_anchor","receiverKind":"instance","returnAbstractType":"transform","returnSource":null,"signature":"transform: Transform","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.sense.plane.PlaneOrientation","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"plane_orientation","returnSource":null,"signature":"enum class PlaneOrientation","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.plane.PlaneOrientation.HORIZONTAL_DOWNWARD","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_orientation","receiverKind":"declaring_type","returnAbstractType":"plane_orientation","returnSource":null,"signature":"HORIZONTAL_DOWNWARD","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.sense.plane.PlaneOrientation.HORIZONTAL_UPWARD","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_orientation","receiverKind":"declaring_type","returnAbstractType":"plane_orientation","returnSource":null,"signature":"HORIZONTAL_UPWARD","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.sense.plane.PlaneTrackingManager","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"plane_tracking_manager","returnSource":null,"signature":"object PlaneTrackingManager","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["load"],"fqn":"com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_tracking_manager","receiverKind":"object_instance","returnAbstractType":"plane_anchor_collection","returnSource":null,"signature":"loadAllAnchors(): Array<PlaneAnchor>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["acquire"],"fqn":"com.pico.spatial.sense.plane.PlaneTrackingManager.start","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_tracking_manager","receiverKind":"object_instance","returnAbstractType":"unit","returnSource":null,"signature":"start(): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["release"],"fqn":"com.pico.spatial.sense.plane.PlaneTrackingManager.stop","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_tracking_manager","receiverKind":"object_instance","returnAbstractType":"unit","returnSource":null,"signature":"stop(): Unit","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"subscriber","position":0,"samInterfaceFqn":"com.pico.spatial.sense.base.AnchorUpdateSubscriber","variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"possible_path","parameters":[{"abstractType":"anchor_update","position":0}],"receiverAbstractType":null,"receiverSource":null,"role":"anchor_update"}],"closedMemberSet":false,"conformsTo":[],"effects":["acquire"],"fqn":"com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_tracking_manager","receiverKind":"object_instance","returnAbstractType":"cancellable","returnSource":null,"signature":"subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"onClick","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"modifier","hasDefault":true,"name":"modifier","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"boolean","hasDefault":true,"name":"enabled","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"size","position":3,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"colors","position":4,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"leadingIcon","position":5,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"trailingIcon","position":6,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"contentPadding","position":7,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"shape","position":8,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"gap","position":9,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"interactionSource","position":10,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"content","position":11,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"user_action","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"button_click"},{"argumentPosition":11,"invocationModel":"possible_path","parameters":[],"receiverAbstractType":"row_scope","receiverSource":null,"role":"window_content"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.design.Button","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, size: ButtonSize = ButtonDefaults.Regular, colors: ButtonColors = ButtonDefaults.buttonColors(), leadingIcon: (@Composable () -> Unit)? = null, trailingIcon: (@Composable () -> Unit)? = null, contentPadding: PaddingValues = ButtonDefaults.paddingForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), shape: Shape = ButtonDefaults.shapeForButtonSize(size), gap: Dp = ButtonDefaults.gapForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), interactionSource: MutableInteractionSource = remember { MutableInteractionSource() }, content: @Composable RowScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":true,"name":"colorScheme","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"typography","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"content","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":2,"invocationModel":"possible_path","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"window_content"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.design.PicoTheme","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"PicoTheme(colorScheme: ColorScheme = systemColorScheme(LocalContext.current), typography: Typography? = null, content: @Composable () -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":false,"name":"text","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"modifier","hasDefault":true,"name":"modifier","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"color","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"autoSize","position":3,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontSize","position":4,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontStyle","position":5,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontWeight","position":6,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontFamily","position":7,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"letterSpacing","position":8,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"textDecoration","position":9,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"textAlign","position":10,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"lineHeight","position":11,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"overflow","position":12,"samInterfaceFqn":null,"variadic":false},{"abstractType":"boolean","hasDefault":true,"name":"softWrap","position":13,"samInterfaceFqn":null,"variadic":false},{"abstractType":"int","hasDefault":true,"name":"maxLines","position":14,"samInterfaceFqn":null,"variadic":false},{"abstractType":"int","hasDefault":true,"name":"minLines","position":15,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"inlineContent","position":16,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"onTextLayout","position":17,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"style","position":18,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.design.Text","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"Text(text: AnnotatedString, modifier: Modifier = Modifier, color: Color = Color.Unspecified, autoSize: TextAutoSize? = null, fontSize: TextUnit = TextUnit.Unspecified, fontStyle: FontStyle? = null, fontWeight: FontWeight? = null, fontFamily: FontFamily? = null, letterSpacing: TextUnit = TextUnit.Unspecified, textDecoration: TextDecoration? = null, textAlign: TextAlign = TextAlign.Unspecified, lineHeight: TextUnit = TextUnit.Unspecified, overflow: TextOverflow = TextOverflow.Clip, softWrap: Boolean = true, maxLines: Int = Int.MAX_VALUE, minLines: Int = 1, inlineContent: Map<String, InlineTextContent> = mapOf(), onTextLayout: ((TextLayoutResult) -> Unit)? = null, style: TextStyle = LocalTextStyle.current): Unit","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"text","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"modifier","hasDefault":true,"name":"modifier","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"color","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"autoSize","position":3,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontSize","position":4,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontStyle","position":5,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontWeight","position":6,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"fontFamily","position":7,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"letterSpacing","position":8,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"textDecoration","position":9,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"textAlign","position":10,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"lineHeight","position":11,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"overflow","position":12,"samInterfaceFqn":null,"variadic":false},{"abstractType":"boolean","hasDefault":true,"name":"softWrap","position":13,"samInterfaceFqn":null,"variadic":false},{"abstractType":"int","hasDefault":true,"name":"maxLines","position":14,"samInterfaceFqn":null,"variadic":false},{"abstractType":"int","hasDefault":true,"name":"minLines","position":15,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"onTextLayout","position":16,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"style","position":17,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.design.Text","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"Text(text: String, modifier: Modifier = Modifier, color: Color = Color.Unspecified, autoSize: TextAutoSize? = null, fontSize: TextUnit = TextUnit.Unspecified, fontStyle: FontStyle? = null, fontWeight: FontWeight? = null, fontFamily: FontFamily? = null, letterSpacing: TextUnit = TextUnit.Unspecified, textDecoration: TextDecoration? = null, textAlign: TextAlign = TextAlign.Unspecified, lineHeight: TextUnit = TextUnit.Unspecified, overflow: TextOverflow = TextOverflow.Clip, softWrap: Boolean = true, maxLines: Int = Int.MAX_VALUE, minLines: Int = 1, onTextLayout: ((TextLayoutResult) -> Unit)? = null, style: TextStyle = LocalTextStyle.current): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"attachment_panel_builder","returnSource":null,"signature":"interface AttachmentPanelBuilder","typeArguments":[]},{"arguments":[{"abstractType":"modifier","hasDefault":true,"name":"modifier","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":true,"name":"update","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":true,"name":"attachments","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"initial","position":3,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"possible_path","parameters":[{"abstractType":"spatial_content","position":0},{"abstractType":"spatial_view_attachments","position":1}],"receiverAbstractType":null,"receiverSource":null,"role":"spatial_update"},{"argumentPosition":2,"invocationModel":"possible_path","parameters":[],"receiverAbstractType":"attachment_panel_builder","receiverSource":null,"role":"spatial_attachments"},{"argumentPosition":3,"invocationModel":"possible_path","parameters":[{"abstractType":"spatial_content","position":0},{"abstractType":"spatial_view_attachments","position":1}],"receiverAbstractType":null,"receiverSource":null,"role":"spatial_initial"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.content.SpatialView","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.content.SpatialViewAttachments","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_view_attachments","returnSource":null,"signature":"interface SpatialViewAttachments","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"content","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"source_root","parameters":[],"receiverAbstractType":"spatial_container_scope","receiverSource":null,"role":"window_content"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_app_scope","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"SpatialAppScope.DefaultWindowContainer(content: @Composable WindowContainerScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"int","hasDefault":false,"name":"default","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"int","hasDefault":true,"name":"min","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"int","hasDefault":true,"name":"max","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.ui.foundation.dsl.Immersion","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"immersion","returnSource":null,"signature":"Immersion(default: Int, min: Int = 0, max: Int = 100): Immersion","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.dsl.Immersion","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"immersion","returnSource":null,"signature":"class Immersion","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.dsl.SpatialAppScope","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_app_scope","returnSource":null,"signature":"interface SpatialAppScope","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"id","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"immersion","hasDefault":true,"name":"immersion","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"brightness","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"upperLimbRenderMode","position":3,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"targetActivity","position":4,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"content","position":5,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":5,"invocationModel":"source_root","parameters":[],"receiverAbstractType":"spatial_container_scope","receiverSource":null,"role":"stage_content"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.dsl.Stage","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_app_scope","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"SpatialAppScope.Stage(id: String, immersion: Immersion? = null, brightness: Brightness? = null, upperLimbRenderMode: UpperLimbRenderMode? = null, targetActivity: Class<out ComponentActivity>? = null, content: @Composable StageScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"block","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"source_root","parameters":[],"receiverAbstractType":"spatial_app_scope","receiverSource":null,"role":"application_entry"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.foundation.dsl.launch","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"android_application","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"Application.launch(block: SpatialAppScope.() -> Unit): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["acquire"],"fqn":"com.pico.spatial.ui.foundation.dsl.registerSystem","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"registerSystem<T : System>(): Unit","typeArguments":["ecs_system"]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["release"],"fqn":"com.pico.spatial.ui.foundation.dsl.unregisterSystem","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"unregisterSystem<T : System>(): Unit","typeArguments":["ecs_system"]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.ui.platform.containers.LocalSpatialNavigator","kind":"top_level_property","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"composition_local","returnSource":null,"signature":"val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.platform.containers.SpatialContainerScope","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_container_scope","returnSource":null,"signature":"interface SpatialContainerScope","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_container_scope","receiverKind":"instance","returnAbstractType":"bundle","returnSource":null,"signature":"bundle: Bundle?","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":true,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_navigator","returnSource":null,"signature":"interface SpatialNavigator","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["close"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.closeStage","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"closeStage(): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["close"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.closeWindowContainer","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"closeWindowContainer(): Unit","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"id","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"string","hasDefault":true,"name":"tag","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["close"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.closeWindowContainer","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"closeWindowContainer(id: String, tag: String? = null): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.minimizeWindowContainer","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"minimizeWindowContainer(): Boolean","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"id","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"string","hasDefault":true,"name":"tag","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.minimizeWindowContainer","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"minimizeWindowContainer(id: String, tag: String? = null): Boolean","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"id","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"stage_style","hasDefault":true,"name":"style","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"bundle","hasDefault":true,"name":"bundle","position":2,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"upperLimbRenderMode","position":3,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["open"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.openStage","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"openStage(id: String, style: StageStyle? = null, bundle: Bundle? = null, upperLimbRenderMode: UpperLimbRenderMode = UpperLimbRenderMode.Default): OpenStageResult","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"id","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"string","hasDefault":true,"name":"tag","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"bundle","hasDefault":true,"name":"bundle","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["open"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.openWindowContainer","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"openWindowContainer(id: String, tag: String? = null, bundle: Bundle? = null): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.restoreWindowContainer","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"restoreWindowContainer(): Boolean","typeArguments":[]},{"arguments":[{"abstractType":"string","hasDefault":false,"name":"id","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"string","hasDefault":true,"name":"tag","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["mutate"],"fqn":"com.pico.spatial.ui.platform.containers.SpatialNavigator.restoreWindowContainer","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"spatial_navigator","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"restoreWindowContainer(id: String, tag: String? = null): Boolean","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.platform.containers.StageScope","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_container_scope","returnSource":null,"signature":"interface StageScope","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.platform.containers.StageStyle","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"stage_style","returnSource":null,"signature":"enum class StageStyle","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.ui.platform.containers.StageStyle.Full","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"stage_style","receiverKind":"declaring_type","returnAbstractType":"stage_style","returnSource":null,"signature":"Full","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"com.pico.spatial.ui.platform.containers.StageStyle.Mixed","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"stage_style","receiverKind":"declaring_type","returnAbstractType":"stage_style","returnSource":null,"signature":"Mixed","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.platform.containers.WindowContainerScope","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_container_scope","returnSource":null,"signature":"interface WindowContainerScope","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"com.pico.spatial.ui.platform.stub.SpatialLaunchActivity","kind":"constructor","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_launch_activity","returnSource":null,"signature":"SpatialLaunchActivity()","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"com.pico.spatial.ui.platform.stub.SpatialLaunchActivity","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"spatial_launch_activity","returnSource":null,"signature":"abstract class SpatialLaunchActivity","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.Function0","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"callable","returnSource":null,"signature":"interface Function0<out R>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.Function0.invoke","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":"invoke","receiverAbstractType":"callable","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"invoke(): R","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.Throwable","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"throwable","returnSource":null,"signature":"open class Throwable","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"kotlin.Throwable.message","kind":"member_property","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"throwable","receiverKind":"instance","returnAbstractType":"string","returnSource":null,"signature":"message: String?","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"block","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":"bundle","receiverSource":"call_receiver","role":"inline_block"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"kotlin.apply","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"bundle","receiverKind":"instance","returnAbstractType":"bundle","returnSource":null,"signature":"T.apply(block: T.() -> Unit): T","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.collections.Iterable","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"immutable_iterable","returnSource":null,"signature":"interface Iterable<out T>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":["immutable_iterable"],"effects":[],"fqn":"kotlin.collections.List","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"immutable_list","returnSource":null,"signature":"interface List<out E>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["construct"],"fqn":"kotlin.collections.emptyList","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"immutable_list","returnSource":null,"signature":"emptyList<T>(): List<T>","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"predicate","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"predicate_flow","parameters":[{"abstractType":"element_of_receiver","position":0}],"receiverAbstractType":null,"receiverSource":null,"role":"collection_predicate"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"kotlin.collections.filter","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"immutable_iterable","receiverKind":"instance","returnAbstractType":"immutable_iterable","returnSource":null,"signature":"Iterable<T>.filter(predicate: (T) -> Boolean): List<T>","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"kotlin.collections.firstOrNull","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"immutable_iterable","receiverKind":"instance","returnAbstractType":null,"returnSource":"element_of_receiver","signature":"Iterable<T>.firstOrNull(): T?","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"action","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"element_flow","parameters":[{"abstractType":"element_of_receiver","position":0}],"receiverAbstractType":null,"receiverSource":null,"role":"collection_element"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.collections.forEach","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"immutable_iterable","receiverKind":"instance","returnAbstractType":"unit","returnSource":null,"signature":"Iterable<T>.forEach(action: (T) -> Unit): Unit","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["readiness"],"fqn":"kotlin.collections.isEmpty","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"immutable_iterable","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"Collection<T>.isEmpty(): Boolean","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["readiness"],"fqn":"kotlin.collections.isNotEmpty","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"immutable_iterable","receiverKind":"instance","returnAbstractType":"boolean","returnSource":null,"signature":"Collection<T>.isNotEmpty(): Boolean","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"selector","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"selector_flow","parameters":[{"abstractType":"element_of_receiver","position":0}],"receiverAbstractType":null,"receiverSource":null,"role":"collection_selector"}],"closedMemberSet":false,"conformsTo":[],"effects":["read"],"fqn":"kotlin.collections.maxByOrNull","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"immutable_iterable","receiverKind":"instance","returnAbstractType":null,"returnSource":"element_of_receiver","signature":"Iterable<T>.maxByOrNull(selector: (T) -> R): T?","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"kotlin.collections.toList","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"plane_anchor_collection","receiverKind":"instance","returnAbstractType":"plane_anchor_collection","returnSource":null,"signature":"Array<out T>.toList(): List<T>","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"block","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"immediate_inline","parameters":[{"abstractType":"string","position":0}],"receiverAbstractType":null,"receiverSource":null,"role":"inline_block"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"kotlin.let","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"string","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"T.let(block: (T) -> R): R","typeArguments":[]},{"arguments":[{"abstractType":"float","hasDefault":false,"name":"x","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"kotlin.math.cos","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"float","returnSource":null,"signature":"cos(x: Float): Float","typeArguments":[]},{"arguments":[{"abstractType":"float","hasDefault":false,"name":"x","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"kotlin.math.sin","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"float","returnSource":null,"signature":"sin(x: Float): Float","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.ranges.IntProgression","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"integer_range","returnSource":null,"signature":"open class IntProgression","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.ranges.IntProgression.iterator","kind":"member_function","memberPrecedence":"sdk_member_wins","operatorForm":"iterator","receiverAbstractType":"integer_range","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"iterator(): IntIterator","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.ranges.IntRange","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"integer_range","returnSource":null,"signature":"class IntRange","typeArguments":[]},{"arguments":[{"abstractType":"float","hasDefault":false,"name":"minimumValue","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"kotlin.ranges.coerceAtLeast","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"float","receiverKind":"instance","returnAbstractType":"float","returnSource":null,"signature":"Float.coerceAtLeast(minimumValue: Float): Float","typeArguments":[]},{"arguments":[{"abstractType":"int","hasDefault":false,"name":"to","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":["convert"],"fqn":"kotlin.ranges.until","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"int","receiverKind":"instance","returnAbstractType":"integer_range","returnSource":null,"signature":"Int.until(to: Int): IntRange","typeArguments":[]},{"arguments":[{"abstractType":"int","hasDefault":false,"name":"times","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"action","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"element_flow","parameters":[{"abstractType":"int","position":0}],"receiverAbstractType":null,"receiverSource":null,"role":"collection_element"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlin.repeat","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"repeat(times: Int, action: (Int) -> Unit): Unit","typeArguments":[]},{"arguments":[{"abstractType":"callable","hasDefault":false,"name":"block","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":0,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":null,"receiverSource":null,"role":"inline_block"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"kotlin.runCatching","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":null,"returnSource":null,"signature":"runCatching(block: () -> R): Result<R>","typeArguments":[]},{"arguments":[{"abstractType":"spatial_app_scope","hasDefault":false,"name":"receiver","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"block","position":1,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":1,"invocationModel":"immediate_inline","parameters":[],"receiverAbstractType":"spatial_app_scope","receiverSource":"argument:0","role":"inline_block"}],"closedMemberSet":false,"conformsTo":[],"effects":["passthrough"],"fqn":"kotlin.with","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":null,"returnSource":null,"signature":"with(receiver: T, block: T.() -> R): R","typeArguments":[]},{"arguments":[],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlinx.coroutines.CoroutineScope","kind":"type","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"coroutine_scope","returnSource":null,"signature":"interface CoroutineScope","typeArguments":[]},{"arguments":[{"abstractType":"long","hasDefault":false,"name":"timeMillis","position":0,"samInterfaceFqn":null,"variadic":false}],"callbacks":[],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlinx.coroutines.delay","kind":"top_level_function","memberPrecedence":"not_applicable","operatorForm":null,"receiverAbstractType":null,"receiverKind":"none","returnAbstractType":"unit","returnSource":null,"signature":"delay(timeMillis: Long): Unit","typeArguments":[]},{"arguments":[{"abstractType":"opaque","hasDefault":true,"name":"context","position":0,"samInterfaceFqn":null,"variadic":false},{"abstractType":"opaque","hasDefault":true,"name":"start","position":1,"samInterfaceFqn":null,"variadic":false},{"abstractType":"callable","hasDefault":false,"name":"block","position":2,"samInterfaceFqn":null,"variadic":false}],"callbacks":[{"argumentPosition":2,"invocationModel":"launched_path","parameters":[],"receiverAbstractType":"coroutine_scope","receiverSource":"call_receiver","role":"coroutine_body"}],"closedMemberSet":false,"conformsTo":[],"effects":[],"fqn":"kotlinx.coroutines.launch","kind":"extension_function","memberPrecedence":"sdk_member_wins","operatorForm":null,"receiverAbstractType":"coroutine_scope","receiverKind":"instance","returnAbstractType":null,"returnSource":null,"signature":"CoroutineScope.launch(context: CoroutineContext = EmptyCoroutineContext, start: CoroutineStart = CoroutineStart.DEFAULT, block: suspend CoroutineScope.() -> Unit): Job","typeArguments":[]}]);
const NARROW_COLLECTION_COMPATIBILITY = followup2DeepFreeze([{"fromAbstractType":"plane_anchor_collection","producerSymbols":[{"fqn":"com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors","signature":"loadAllAnchors(): Array<PlaneAnchor>"},{"fqn":"kotlin.collections.toList","signature":"Array<out T>.toList(): List<T>"}],"toAbstractType":"immutable_iterable"}]);
const NULLABLE_RESULT_SYMBOLS = followup2DeepFreeze([{"fqn":"android.os.BaseBundle.getString","signature":"getString(key: String): String?"},{"fqn":"com.pico.spatial.core.ecs.Entity.ComponentSet.get","signature":"get(componentType: Class<T>): T?"},{"fqn":"com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle","signature":"bundle: Bundle?"},{"fqn":"kotlin.Throwable.message","signature":"message: String?"},{"fqn":"kotlin.collections.firstOrNull","signature":"Iterable<T>.firstOrNull(): T?"},{"fqn":"kotlin.collections.maxByOrNull","signature":"Iterable<T>.maxByOrNull(selector: (T) -> R): T?"}]);
const PHYSICAL_OWNER_RELATIONS = followup2DeepFreeze([{"childTypeFqn":"android.os.Bundle","childTypeSignature":"class Bundle","ownerTypeFqn":"android.os.BaseBundle","ownerTypeSignature":"open class BaseBundle","relationKind":"inherits"},{"childTypeFqn":"androidx.compose.runtime.ProvidableCompositionLocal","childTypeSignature":"abstract class ProvidableCompositionLocal<T>","ownerTypeFqn":"androidx.compose.runtime.CompositionLocal","ownerTypeSignature":"abstract class CompositionLocal<T>","relationKind":"inherits"},{"childTypeFqn":"com.pico.spatial.core.container.SpatialViewContent","childTypeSignature":"class SpatialViewContent","ownerTypeFqn":"com.pico.spatial.core.container.SpatialViewEntityManager","ownerTypeSignature":"interface SpatialViewEntityManager","relationKind":"delegates"},{"childTypeFqn":"com.pico.spatial.core.container.SpatialViewContent","childTypeSignature":"class SpatialViewContent","ownerTypeFqn":"com.pico.spatial.core.container.SpatialViewEventManager","ownerTypeSignature":"interface SpatialViewEventManager","relationKind":"delegates"},{"childTypeFqn":"com.pico.spatial.core.container.SpatialViewContent","childTypeSignature":"class SpatialViewContent","ownerTypeFqn":"com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter","ownerTypeSignature":"interface SpatialCoordinateSpaceConverter","relationKind":"delegates"},{"childTypeFqn":"com.pico.spatial.ui.platform.containers.StageScope","childTypeSignature":"interface StageScope","ownerTypeFqn":"com.pico.spatial.ui.platform.containers.SpatialContainerScope","ownerTypeSignature":"interface SpatialContainerScope","relationKind":"inherits"},{"childTypeFqn":"com.pico.spatial.ui.platform.containers.WindowContainerScope","childTypeSignature":"interface WindowContainerScope","ownerTypeFqn":"com.pico.spatial.ui.platform.containers.SpatialContainerScope","ownerTypeSignature":"interface SpatialContainerScope","relationKind":"inherits"},{"childTypeFqn":"kotlin.ranges.IntRange","childTypeSignature":"class IntRange","ownerTypeFqn":"kotlin.ranges.IntProgression","ownerTypeSignature":"open class IntProgression","relationKind":"inherits"}]);
const PHYSICAL_RESULT_TYPES = followup2DeepFreeze([{"physicalTypeFqn":"android.os.Bundle","physicalTypeSignature":"class Bundle","producerFqn":"android.os.Bundle","producerSignature":"Bundle()","semanticType":"bundle"},{"physicalTypeFqn":"androidx.compose.runtime.ProvidableCompositionLocal","physicalTypeSignature":"abstract class ProvidableCompositionLocal<T>","producerFqn":"com.pico.spatial.ui.platform.containers.LocalSpatialNavigator","producerSignature":"val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>","semanticType":"composition_local"},{"physicalTypeFqn":"android.os.Bundle","physicalTypeSignature":"class Bundle","producerFqn":"com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle","producerSignature":"bundle: Bundle?","semanticType":"bundle"},{"physicalTypeFqn":"kotlin.ranges.IntRange","physicalTypeSignature":"class IntRange","producerFqn":"kotlin.ranges.until","producerSignature":"Int.until(to: Int): IntRange","semanticType":"integer_range"}]);
const PHYSICAL_CALLBACK_PARAMETERS = followup2DeepFreeze([{"callableFqn":"com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate","callableSignature":"subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable","callbackArgumentPosition":0,"callbackParameterPosition":0,"physicalTypeFqn":"com.pico.spatial.sense.base.AnchorUpdate","physicalTypeSignature":"class AnchorUpdate<T : Anchor>","semanticType":"anchor_update"},{"callableFqn":"com.pico.spatial.ui.foundation.content.SpatialView","callableSignature":"SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit","callbackArgumentPosition":1,"callbackParameterPosition":0,"physicalTypeFqn":"com.pico.spatial.core.container.SpatialViewContent","physicalTypeSignature":"class SpatialViewContent","semanticType":"spatial_content"},{"callableFqn":"com.pico.spatial.ui.foundation.content.SpatialView","callableSignature":"SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit","callbackArgumentPosition":1,"callbackParameterPosition":1,"physicalTypeFqn":"com.pico.spatial.ui.foundation.content.SpatialViewAttachments","physicalTypeSignature":"interface SpatialViewAttachments","semanticType":"spatial_view_attachments"},{"callableFqn":"com.pico.spatial.ui.foundation.content.SpatialView","callableSignature":"SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit","callbackArgumentPosition":3,"callbackParameterPosition":0,"physicalTypeFqn":"com.pico.spatial.core.container.SpatialViewContent","physicalTypeSignature":"class SpatialViewContent","semanticType":"spatial_content"},{"callableFqn":"com.pico.spatial.ui.foundation.content.SpatialView","callableSignature":"SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit","callbackArgumentPosition":3,"callbackParameterPosition":1,"physicalTypeFqn":"com.pico.spatial.ui.foundation.content.SpatialViewAttachments","physicalTypeSignature":"interface SpatialViewAttachments","semanticType":"spatial_view_attachments"}]);
const PHYSICAL_CALLBACK_RECEIVERS = followup2DeepFreeze([{"callableFqn":"androidx.compose.runtime.DisposableEffect","callableSignature":"DisposableEffect(key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","callbackArgumentPosition":1,"physicalTypeFqn":"androidx.compose.runtime.DisposableEffectScope","physicalTypeSignature":"class DisposableEffectScope","semanticType":"disposable_effect_scope"},{"callableFqn":"androidx.compose.runtime.DisposableEffect","callableSignature":"DisposableEffect(key1: Any?, key2: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","callbackArgumentPosition":2,"physicalTypeFqn":"androidx.compose.runtime.DisposableEffectScope","physicalTypeSignature":"class DisposableEffectScope","semanticType":"disposable_effect_scope"},{"callableFqn":"androidx.compose.runtime.DisposableEffect","callableSignature":"DisposableEffect(key1: Any?, key2: Any?, key3: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","callbackArgumentPosition":3,"physicalTypeFqn":"androidx.compose.runtime.DisposableEffectScope","physicalTypeSignature":"class DisposableEffectScope","semanticType":"disposable_effect_scope"},{"callableFqn":"androidx.compose.runtime.DisposableEffect","callableSignature":"DisposableEffect(vararg keys: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit","callbackArgumentPosition":1,"physicalTypeFqn":"androidx.compose.runtime.DisposableEffectScope","physicalTypeSignature":"class DisposableEffectScope","semanticType":"disposable_effect_scope"},{"callableFqn":"androidx.compose.runtime.LaunchedEffect","callableSignature":"LaunchedEffect(key1: Any?, block: suspend CoroutineScope.() -> Unit): Unit","callbackArgumentPosition":1,"physicalTypeFqn":"kotlinx.coroutines.CoroutineScope","physicalTypeSignature":"interface CoroutineScope","semanticType":"coroutine_scope"},{"callableFqn":"androidx.compose.runtime.LaunchedEffect","callableSignature":"LaunchedEffect(key1: Any?, key2: Any?, block: suspend CoroutineScope.() -> Unit): Unit","callbackArgumentPosition":2,"physicalTypeFqn":"kotlinx.coroutines.CoroutineScope","physicalTypeSignature":"interface CoroutineScope","semanticType":"coroutine_scope"},{"callableFqn":"androidx.compose.runtime.LaunchedEffect","callableSignature":"LaunchedEffect(key1: Any?, key2: Any?, key3: Any?, block: suspend CoroutineScope.() -> Unit): Unit","callbackArgumentPosition":3,"physicalTypeFqn":"kotlinx.coroutines.CoroutineScope","physicalTypeSignature":"interface CoroutineScope","semanticType":"coroutine_scope"},{"callableFqn":"androidx.compose.runtime.LaunchedEffect","callableSignature":"LaunchedEffect(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit): Unit","callbackArgumentPosition":1,"physicalTypeFqn":"kotlinx.coroutines.CoroutineScope","physicalTypeSignature":"interface CoroutineScope","semanticType":"coroutine_scope"},{"callableFqn":"com.pico.spatial.ui.design.Button","callableSignature":"Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, size: ButtonSize = ButtonDefaults.Regular, colors: ButtonColors = ButtonDefaults.buttonColors(), leadingIcon: (@Composable () -> Unit)? = null, trailingIcon: (@Composable () -> Unit)? = null, contentPadding: PaddingValues = ButtonDefaults.paddingForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), shape: Shape = ButtonDefaults.shapeForButtonSize(size), gap: Dp = ButtonDefaults.gapForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), interactionSource: MutableInteractionSource = remember { MutableInteractionSource() }, content: @Composable RowScope.() -> Unit): Unit","callbackArgumentPosition":11,"physicalTypeFqn":"androidx.compose.foundation.layout.RowScope","physicalTypeSignature":"interface RowScope","semanticType":"row_scope"},{"callableFqn":"com.pico.spatial.ui.foundation.content.SpatialView","callableSignature":"SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit","callbackArgumentPosition":2,"physicalTypeFqn":"com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder","physicalTypeSignature":"interface AttachmentPanelBuilder","semanticType":"attachment_panel_builder"},{"callableFqn":"com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer","callableSignature":"SpatialAppScope.DefaultWindowContainer(content: @Composable WindowContainerScope.() -> Unit): Unit","callbackArgumentPosition":0,"physicalTypeFqn":"com.pico.spatial.ui.platform.containers.WindowContainerScope","physicalTypeSignature":"interface WindowContainerScope","semanticType":"spatial_container_scope"},{"callableFqn":"com.pico.spatial.ui.foundation.dsl.Stage","callableSignature":"SpatialAppScope.Stage(id: String, immersion: Immersion? = null, brightness: Brightness? = null, upperLimbRenderMode: UpperLimbRenderMode? = null, targetActivity: Class<out ComponentActivity>? = null, content: @Composable StageScope.() -> Unit): Unit","callbackArgumentPosition":5,"physicalTypeFqn":"com.pico.spatial.ui.platform.containers.StageScope","physicalTypeSignature":"interface StageScope","semanticType":"spatial_container_scope"},{"callableFqn":"com.pico.spatial.ui.foundation.dsl.launch","callableSignature":"Application.launch(block: SpatialAppScope.() -> Unit): Unit","callbackArgumentPosition":0,"physicalTypeFqn":"com.pico.spatial.ui.foundation.dsl.SpatialAppScope","physicalTypeSignature":"interface SpatialAppScope","semanticType":"spatial_app_scope"}]);
const COMPONENT_CANARY_SYMBOLS = MIGRATED_CANARY_SYMBOLS;
function liveDomainPhase() {
  const live = canonicalJson(JSON.parse(fs.readFileSync(DOMAIN, "utf8")).symbols);
  if (live === canonicalJson(MIGRATED_CANARY_SYMBOLS)) return "migrated";
  if (live === canonicalJson(FULL_BATCH2B_SYMBOLS)) return "full";
  throw new Error("domain-v1.json is neither the migrated-canary nor the FULL Batch 2B phase");
}
const EXPECTED_JAVA_SOURCES = Object.freeze([
  "AbstractInterpreter.java", "Main.java", "Protocol.java", "PsiIndex.java", "Rules.java",
].map((name) => `benchmarks/spatial-agent-bench/analyzer/src/main/java/com/agentbench/analyzer/${name}`));
const EXPECTED_JAR_ENTRIES = Object.freeze([
  "com/agentbench/analyzer/AbstractInterpreter.class",
  "com/agentbench/analyzer/Main.class",
  "com/agentbench/analyzer/Protocol$Parser.class",
  "com/agentbench/analyzer/Protocol.class",
  "com/agentbench/analyzer/PsiIndex$Edge.class",
  "com/agentbench/analyzer/PsiIndex$EdgeRole.class",
  "com/agentbench/analyzer/PsiIndex$FileUnit.class",
  "com/agentbench/analyzer/PsiIndex$ImportEntry.class",
  "com/agentbench/analyzer/PsiIndex$Node.class",
  "com/agentbench/analyzer/PsiIndex$NodeFlag.class",
  "com/agentbench/analyzer/PsiIndex$NodeKind.class",
  "com/agentbench/analyzer/PsiIndex$Program.class",
  "com/agentbench/analyzer/PsiIndex$Result.class",
  "com/agentbench/analyzer/PsiIndex$SnapshotRejected.class",
  "com/agentbench/analyzer/PsiIndex$Source.class",
  "com/agentbench/analyzer/PsiIndex$Token.class",
  "com/agentbench/analyzer/PsiIndex$TokenKind.class",
  "com/agentbench/analyzer/PsiIndex$WitnessKind.class",
  "com/agentbench/analyzer/PsiIndex$WitnessNode.class",
  "com/agentbench/analyzer/PsiIndex.class",
  "com/agentbench/analyzer/Rules$AlternativeSpec.class",
  "com/agentbench/analyzer/Rules$Analysis.class",
  "com/agentbench/analyzer/Rules$ArgumentSpec.class",
  "com/agentbench/analyzer/Rules$CallbackParameterSpec.class",
  "com/agentbench/analyzer/Rules$CallbackSpec.class",
  "com/agentbench/analyzer/Rules$Domain.class",
  "com/agentbench/analyzer/Rules$RuleSpec.class",
  "com/agentbench/analyzer/Rules$SymbolSpec.class",
  "com/agentbench/analyzer/Rules.class",
  "domain-v1.json",
]);
const SYMBOL_KINDS = new Set(["type", "constructor", "top_level_function", "member_function", "extension_function", "member_property", "top_level_property"]);
const MEMBER_PRECEDENCE = new Set(["not_applicable", "sdk_member_wins", "source_extension_if_no_sdk_member"]);
const RECEIVER_KINDS = new Set(["none", "instance", "declaring_type", "object_instance"]);
const CALLBACK_ROLES = new Set([
  "application_entry", "window_content", "stage_content", "launched_effect", "button_click", "coroutine_body",
  "disposable_effect", "dispose_cleanup", "spatial_initial", "spatial_attachments", "spatial_update",
  "collection_element", "collection_predicate", "collection_selector", "inline_block", "remembered_factory", "anchor_update",
]);
const INVOCATION_MODELS = new Set([
  "source_root", "possible_path", "user_action", "launched_path", "acquire_path", "cleanup_path",
  "element_flow", "predicate_flow", "selector_flow", "immediate_inline",
]);
const EFFECTS = new Set([
  "read", "mutate", "construct", "replace", "unknown_escape", "open", "close", "acquire", "release",
  "load", "readiness", "convert", "place", "status_assign", "passthrough",
]);
const ABSTRACT_TYPES = new Set([
  "boolean", "int", "long", "float", "double", "string", "unit", "java_class", "callable",
  "immutable_iterable", "immutable_list", "integer_range", "coroutine_scope", "android_application",
  "spatial_launch_activity", "bundle", "spatial_app_scope", "spatial_navigator", "stage_style", "spatial_content",
  "component", "component_store", "entity", "entity_collection", "entity_query_condition", "ecs_system", "scene",
  "scene_update_context", "transform_component", "vector3", "quat", "cancellable", "semantic_label", "plane_anchor",
  "plane_anchor_collection", "plane_geometry", "plane_orientation", "plane_tracking_manager", "immersion", "modifier",
  "opaque", "transform", "vector2", "throwable", "disposable_effect_scope", "composition_local",
  "spatial_container_scope", "kclass", "row_scope", "attachment_panel_builder", "spatial_view_attachments", "anchor_update",
]);
const RETURN_SOURCES = new Set(["element_of_receiver", "class_of_argument"]);
const OPERATOR_FORMS = new Set(["index_get", "index_set", "plus_assign", "plus", "iterator", "contains", "invoke", "compare_to", "equals"]);
const CALLBACK_PARAMETER_SENTINELS = new Set(["element_of_receiver"]);
const WITNESS_CAPS = Object.freeze([11, 16, 14, 12, 16, 11, 12, 11, 12, 24, 12, 24, 10, 25, 20, 22]);
const EXACT_CLONE_CANARY_KEY = Object.freeze({ fqn: "com.pico.spatial.core.ecs.Component.clone", signature: "clone(): Component" });
const FOLLOWUP2_FACT_KINDS = Object.freeze([
  "argument_binding", "callback_binding", "callback_parameter", "callback_receiver", "call_resolution",
  "callback_result", "cfg_edge", "closed_member_absence", "condition", "conformance", "definition", "def_use",
  "dominates", "effect", "escape", "function_binding", "implicit_receiver", "last_write", "loop_element",
  "loop_success", "nullable", "origin", "override", "paired_effect", "production_root", "reachable", "read",
  "retained_exit", "return_origin", "same_element", "same_origin", "strong_authority", "taint", "type",
  "type_argument", "witness_owner", "write",
]);
const PRIMITIVE_DOCTRINE = Object.freeze([
  { arity: 2, operandTypes: ["int", "long", "float", "double"], sameType: true, tokens: ["+", "-", "*", "/"], result: "same_numeric" },
  { arity: 1, operandTypes: ["int", "long", "float", "double"], sameType: true, tokens: ["-"], result: "same_numeric" },
  { arity: 2, operandTypes: ["int", "long", "float", "double"], sameType: true, tokens: ["<", "<=", ">", ">="], result: "boolean_numeric_compare" },
  { arity: 2, operandTypes: ["int", "long", "float", "double"], sameType: true, tokens: ["+="], result: "same_numeric_slot_write" },
  { arity: 2, operandTypes: ["boolean", "int", "long", "float", "double"], sameType: true, tokens: ["==", "!="], result: "boolean_primitive_equality" },
  { arity: 2, operandTypes: ["boolean"], sameType: true, tokens: ["&&", "||"], result: "boolean_short_circuit" },
  { arity: 1, operandTypes: ["boolean"], sameType: true, tokens: ["!"], result: "boolean_inverted" },
]);
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function exactKeys(value, keys, label) {
  assert.equal(value !== null && Object.getPrototypeOf(value) === Object.prototype, true, `${label} must be a plain object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys`);
}
function uniqueStrings(values, label) {
  assert.equal(Array.isArray(values) && values.length > 0, true, `${label} must be a nonempty array`);
  assert.equal(values.every((value) => typeof value === "string" && value.length > 0), true, `${label} strings`);
  assert.equal(new Set(values).size, values.length, `${label} uniqueness`);
}
function protocolFrame(value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([header, bytes]);
}
function framedResponse(bytes) {
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.equal(bytes.length >= 8, true, "response frame header");
  assert.equal(bytes.readBigUInt64BE(0), BigInt(bytes.length - 8), "response frame length");
  const text = bytes.subarray(8).toString("utf8");
  const value = JSON.parse(text);
  assert.equal(canonicalJson(value), text, "canonical response payload");
  return value;
}
function analyzeRequest(pathName, content) {
  const bytes = Buffer.from(content, "utf8");
  const file = { path: pathName, bytes: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString("base64") };
  const manifest = [{ path: file.path, bytes: file.bytes, sha256: file.sha256 }];
  return {
    protocolVersion: 1,
    subsetVersion: 1,
    command: "analyze",
    kotlinInputSetSha256: hash(canonicalJson(manifest)),
    files: [file],
  };
}
function followup2SyntheticWitness(pathName, content, startUtf16, endUtf16, kind = "declaration") {
  const fileSha256 = hash(Buffer.from(content, "utf8"));
  const textSha256 = hash(Buffer.from(content.slice(startUtf16, endUtf16), "utf8"));
  const identity = { path: pathName, fileSha256, startUtf16, endUtf16, kind, textSha256, structuralToken: true };
  return { nodeId: hash(Buffer.from(canonicalJson(identity), "utf8")), ...identity };
}
function temporaryDirectory(t, prefix) {
  const directory = path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomUUID()}`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}
function mode(stat) { return (stat.mode & 0o777).toString(8).padStart(4, "0"); }
function treeIdentity(root) {
  const entries = []; const counts = { entries: 0, files: 0, directories: 0, symlinks: 0, fileBytes: 0 };
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name); const itemPath = relative ? `${relative}/${name}` : name; const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) { entries.push({ path: itemPath, type: "symlink", mode: mode(stat), target: fs.readlinkSync(absolute) }); counts.symlinks += 1; }
      else if (stat.isDirectory()) { entries.push({ path: itemPath, type: "dir", mode: mode(stat) }); counts.directories += 1; visit(absolute, itemPath); }
      else {
        const bytes = fs.readFileSync(absolute);
        entries.push({ path: itemPath, type: "file", mode: mode(stat), bytes: bytes.length, sha256: hash(bytes) });
        counts.files += 1; counts.fileBytes += bytes.length;
      }
    }
  }
  visit(root); counts.entries = entries.length;
  return { ...counts, sha256: hash(canonicalJson(entries)) };
}
function sourceIndex(rows) {
  const files = rows.map((row) => Object.freeze({ path: row.path, absolutePath: path.join(ROOT, row.path), kind: row.kind ?? "kotlin", original: row.content, structural: row.content }));
  return Object.freeze({
    projectDir: ROOT, files: Object.freeze(files),
    totalBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.original), 0),
    facts: Object.freeze({ gradle: Object.freeze({}), manifest: Object.freeze({}) }),
    factEvidence: Object.freeze([]),
  });
}
const SEMANTIC_FAKE_SOURCE = `package fake.semantic

import com.pico.spatial.core.ecs.Component

class SignalPart(
    val active: Boolean = true,
    val phase: Int = 0,
    val marker: String = "🧭",
) : Component() {
    override fun clone(): SignalPart = SignalPart(active, phase, marker)
}
`;
const EXPRESSION_CLONE_SOURCE = `package canary.alpha

import com.pico.spatial.core.ecs.Component

class RelayPart(
    val active: Boolean = true,
    val phase: Int = 0,
) : Component() {
    override fun clone(): RelayPart = RelayPart(active, phase)
}
`;
const THREE_FIELD_OVER_CAP_CLONE_SOURCE = `package canary.alpha

import com.pico.spatial.core.ecs.Component

class RelayPart(
    val active: Boolean = true,
    val phase: Int = 0,
    val label: String = "idle",
) : Component() {
    override fun clone(): RelayPart = RelayPart(active, phase, label)
}
`;
const BLOCK_CLONE_SOURCE = `package renamed.beta

import com.pico.spatial.core.ecs.Component as SpatialComponent

class TelemetryShard(
    val ready: Boolean = true,
    val sweep: Float = 0f,
) : SpatialComponent() {
    override fun clone(): TelemetryShard {
        return TelemetryShard(ready = ready, sweep = sweep)
    }
}
`;
const DEFAULT_PACKAGE_SOURCE = `class DefaultRoot
fun answer(): Int = 42
`;
function assertCloneResponse(response, proofForm, paths) {
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  assert.equal(response.claims.length, 1);
  assert.equal(response.claims[0].ruleId, "ecs.component-clone");
  assert.equal(response.claims[0].proofForm, proofForm);
  assert.equal(response.claims[0].witnessNodeIds.length > 0, true);
  assert.equal(response.nodes.length > 0, true);
  assert.deepEqual(response.nodes.map((node) => node.nodeId), [...response.claims[0].witnessNodeIds].sort());
  assert.equal(response.nodes.every((node) => paths.has(node.path)), true);
  assert.equal(response.nodes.every((node) => node.structuralToken === true || node.kind === "argument"), true);
}
async function copiedBridge(t, scenarioRef, calls, artifactRoot = null) {
  const original = fs.readFileSync(BRIDGE, "utf8");
  const marker = "const spawnAnalyzer = spawnSync;";
  assert.equal(original.includes(marker), true, "bridge must retain the single copied-module spawn seam");
  const copied = path.join(path.dirname(BRIDGE), `.kotlin-analysis-test-${process.pid}-${crypto.randomUUID()}.mjs`);
  let source = original.replace(marker, "const spawnAnalyzer = globalThis.__agentbenchSpawnAnalyzer;");
  if (artifactRoot !== null) source = source.replace('const ARTIFACT_ROOT = path.join(ANALYZER_ROOT, ".artifacts/v1");', `const ARTIFACT_ROOT = ${JSON.stringify(artifactRoot)};`);
  fs.writeFileSync(copied, source);
  t.after(() => { delete globalThis.__agentbenchSpawnAnalyzer; fs.rmSync(copied, { force: true }); });
  globalThis.__agentbenchSpawnAnalyzer = (command, args, options) => {
    calls.count += 1;
    calls.records?.push({ command, args, options });
    return spawnFakeAnalyzer(scenarioRef.value, options);
  };
  return import(`${pathToFileURL(copied).href}?nonce=${crypto.randomUUID()}`);
}
function reSelfHash(receipt) {
  const without = structuredClone(receipt);
  delete without.receiptSha256;
  return { ...without, receiptSha256: hash(Buffer.concat([RECEIPT_DOMAIN, Buffer.from(canonicalJson(without))])) };
}
function replaceRoot(value, from, to) {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((entry) => replaceRoot(entry, from, to));
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceRoot(entry, from, to)]));
  return value;
}
function copyArtifact(t) {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(ARTIFACTS, ".test-artifact-")));
  const target = path.join(container, "v1");
  fs.mkdirSync(target, { mode: 0o700 });
  t.after(() => { makeTreeWritable(container); fs.rmSync(container, { recursive: true, force: true }); });
  for (const directory of ["runtime", "run-cwd", "run-home", "run-tmp"]) fs.mkdirSync(path.join(target, directory), { mode: 0o700 });
  fs.copyFileSync(ARTIFACT, path.join(target, "analyzer-v1.jar"));
  for (const name of fs.readdirSync(path.join(path.dirname(ARTIFACT), "runtime"))) {
    fs.copyFileSync(path.join(path.dirname(ARTIFACT), "runtime", name), path.join(target, "runtime", name));
  }
  const receipt = replaceRoot(JSON.parse(fs.readFileSync(RECEIPT, "utf8")), path.dirname(ARTIFACT), target);
  fs.writeFileSync(path.join(target, "analyzer-build-receipt-v1.json"), `${canonicalJson(reSelfHash(receipt))}\n`);
  for (const name of ["analyzer-v1.jar", "analyzer-build-receipt-v1.json"]) fs.chmodSync(path.join(target, name), 0o400);
  for (const name of fs.readdirSync(path.join(target, "runtime"))) fs.chmodSync(path.join(target, "runtime", name), 0o400);
  fs.chmodSync(path.join(target, "runtime"), 0o500);
  fs.chmodSync(target, 0o500);
  return target;
}
function makeTreeWritable(root) {
  const stat = fs.lstatSync(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeTreeWritable(path.join(root, name));
  } else if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(root, 0o600);
}
function analyzerReplica(t) {
  const replicaRoot = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, ".agentbench-test-replica-")));
  t.after(() => { makeTreeWritable(replicaRoot); fs.rmSync(replicaRoot, { recursive: true, force: true }); });
  const analyzer = path.join(replicaRoot, "benchmarks/spatial-agent-bench/analyzer");
  const lib = path.join(replicaRoot, "benchmarks/spatial-agent-bench/lib");
  fs.cpSync(ANALYZER_DIR, analyzer, { recursive: true, filter: (source) => !source.includes(`${path.sep}.artifacts`) });
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(BRIDGE, path.join(lib, "kotlin-analysis.mjs"));
  const artifact = path.join(analyzer, ".artifacts/v1");
  for (const directory of ["runtime", "run-cwd", "run-home", "run-tmp"]) fs.mkdirSync(path.join(artifact, directory), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(artifact), 0o700);
  fs.copyFileSync(ARTIFACT, path.join(artifact, "analyzer-v1.jar"));
  for (const name of fs.readdirSync(path.join(path.dirname(ARTIFACT), "runtime"))) {
    fs.copyFileSync(path.join(path.dirname(ARTIFACT), "runtime", name), path.join(artifact, "runtime", name));
  }
  const receipt = replaceRoot(JSON.parse(fs.readFileSync(RECEIPT, "utf8")), path.dirname(ARTIFACT), artifact);
  fs.writeFileSync(path.join(artifact, "analyzer-build-receipt-v1.json"), `${canonicalJson(reSelfHash(receipt))}\n`);
  for (const name of ["analyzer-v1.jar", "analyzer-build-receipt-v1.json"]) fs.chmodSync(path.join(artifact, name), 0o400);
  for (const name of fs.readdirSync(path.join(artifact, "runtime"))) fs.chmodSync(path.join(artifact, "runtime", name), 0o400);
  fs.chmodSync(path.join(artifact, "runtime"), 0o500);
  fs.chmodSync(artifact, 0o500);
  return { replicaRoot, analyzer, artifact, build: path.join(analyzer, "build-analyzer.mjs") };
}
async function copiedReplicaBridge(t, replica, scenarioRef, calls) {
  const production = path.join(replica.replicaRoot, "benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs");
  const copied = path.join(path.dirname(production), `.kotlin-analysis-test-${crypto.randomUUID()}.mjs`);
  const source = fs.readFileSync(production, "utf8").replace("const spawnAnalyzer = spawnSync;", "const spawnAnalyzer = globalThis.__agentbenchSpawnAnalyzer;");
  fs.writeFileSync(copied, source);
  t.after(() => { delete globalThis.__agentbenchSpawnAnalyzer; fs.rmSync(copied, { force: true }); });
  globalThis.__agentbenchSpawnAnalyzer = (_command, _args, options) => {
    calls.count += 1;
    return spawnFakeAnalyzer(scenarioRef.value, options);
  };
  return import(`${pathToFileURL(copied).href}?nonce=${crypto.randomUUID()}`);
}
function refreshReplicaReceipt(replica) {
  const receiptPath = path.join(replica.artifact, "analyzer-build-receipt-v1.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.sourceInputs = receipt.sourceInputs.map((row) => {
    const bytes = fs.readFileSync(path.join(replica.replicaRoot, ...row.path.split("/")));
    return { path: row.path, bytes: bytes.length, sha256: hash(bytes) };
  });
  receipt.analyzerSourceSha256 = hash(canonicalJson(receipt.sourceInputs));
  const byName = (name) => receipt.sourceInputs.find((row) => row.path.endsWith(`/${name}`)).sha256;
  receipt.domainSha256 = byName("domain-v1.json");
  receipt.dependencyManifestSha256 = byName("dependencies-v1.json");
  receipt.toolchainManifestSha256 = byName("toolchain-v1.json");
  receipt.bridgeSha256 = byName("kotlin-analysis.mjs");
  const toolchain = JSON.parse(fs.readFileSync(path.join(replica.analyzer, "toolchain-v1.json"), "utf8"));
  const platform = toolchain.platforms.find((row) => row.platform === process.platform && row.arch === process.arch && row.uid === process.getuid());
  receipt.jdk = { root: platform.jdk.home, version: platform.jdk.version, tree: platform.jdk.tree, diagnostics: platform.jdk.diagnostics };
  receipt.launch.java = path.join(platform.jdk.home, "bin/java");
  receipt.launch.environment.JAVA_HOME = platform.jdk.home;
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, `${canonicalJson(reSelfHash(receipt))}\n`);
  fs.chmodSync(receiptPath, 0o400);
}
function runScrubbedNode(script, args = []) {
  return spawnSync("/usr/bin/env", ["-i", ...CLEAN_ENV, "/usr/local/bin/node", script, ...args], { encoding: "utf8" });
}
function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}
function responseBoundary(response) {
  return {
    analysisStatus: response.analysisStatus,
    rejectionCode: response.rejectionCode,
    nodes: response.nodes,
    claims: response.claims,
  };
}
function assertAcceptedEmpty(response, label) {
  assert.deepEqual(responseBoundary(response), {
    analysisStatus: "accepted",
    rejectionCode: null,
    nodes: [],
    claims: [],
  }, label);
}
function assertRejectedEmpty(response, rejectionCode, label) {
  assert.deepEqual(responseBoundary(response), {
    analysisStatus: "rejected",
    rejectionCode,
    nodes: [],
    claims: [],
  }, label);
}
function extractClosedRegistry(source, name, language, label) {
  const opener = language === "java"
    ? `private static final Set<String> ${name} = Set.of(`
    : `const ${name} = new Set([`;
  const closer = language === "java" ? ");" : "]);";
  const start = source.indexOf(opener);
  assert.notEqual(start, -1, `${label} ${name} opener`);
  assert.equal(source.indexOf(opener, start + opener.length), -1, `${label} ${name} unique opener`);
  const bodyStart = start + opener.length;
  const end = source.indexOf(closer, bodyStart);
  assert.notEqual(end, -1, `${label} ${name} closer`);
  const body = source.slice(bodyStart, end);
  assert.equal(body.replaceAll(/"[a-z][a-z0-9_]*"/g, "").replaceAll(/[\s,]/g, ""), "",
    `${label} ${name} literal-only body`);
  return [...body.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
}
function followup2TempRoot(t, suffix) {
  const prefix = `agentbench-followup2-${suffix}-`;
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, prefix)));
  assert.equal(path.dirname(root), temporaryRoot, `${prefix} parent`);
  assert.equal(path.basename(root).startsWith(prefix), true, `${prefix} basename`);
  assert.equal(fs.lstatSync(root).isDirectory(), true, `${prefix} directory`);
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false, `${prefix} symlink`);
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    const stat = fs.lstatSync(root);
    assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true, `${prefix} cleanup target`);
    assert.equal(path.dirname(fs.realpathSync(root)), temporaryRoot, `${prefix} cleanup boundary`);
    assert.equal(path.basename(root).startsWith(prefix), true, `${prefix} cleanup prefix`);
    fs.rmSync(root, { recursive: true, force: true });
    removed = true;
    assert.equal(fs.existsSync(root), false, `${prefix} residue`);
  };
  t.after(cleanup);
  return { cleanup, prefix, root };
}
function followup2ReceiptClasspath(receipt) {
  return receipt.classpath.map((entry) => path.join(receipt.artifactRoot, ...entry.path.split("/"))).join(path.delimiter);
}
function compileFollowup2Probe(root, className, source) {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const sourceRoot = path.join(root, "source");
  const classes = path.join(root, "classes");
  const home = path.join(root, "home");
  const temporaryFiles = path.join(root, "tmp");
  for (const directory of [sourceRoot, classes, home, temporaryFiles]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(sourceRoot, ...className.split(".")) + ".java";
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcePath, source, { encoding: "utf8", mode: 0o600 });
  const classpath = followup2ReceiptClasspath(receipt);
  const environment = { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const compiled = spawnSync(path.join(receipt.jdk.root, "bin/javac"), [
    `-J-Duser.home=${home}`, `-J-Djava.io.tmpdir=${temporaryFiles}`, "--release", "17", "-encoding", "UTF-8",
    "-g:none", "-proc:none", "-classpath", classpath, "-d", classes, sourcePath,
  ], { cwd: sourceRoot, env: environment, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 8_388_608 });
  return { classes, className, classpath, compiled, environment, home, receipt, sourcePath, temporaryFiles };
}
function runFollowup2Probe(probe, root, resourceRoot = null, arguments_ = []) {
  const runtimeArgs = probe.receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${probe.home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${probe.temporaryFiles}`));
  const cpIndex = runtimeArgs.indexOf("-cp");
  assert.notEqual(cpIndex, -1, "receipt classpath argument");
  runtimeArgs[cpIndex + 1] = [probe.classes, resourceRoot, probe.classpath].filter(Boolean).join(path.delimiter);
  const mainIndex = runtimeArgs.indexOf("com.agentbench.analyzer.Main");
  assert.notEqual(mainIndex, -1, "receipt main argument");
  runtimeArgs.splice(mainIndex, runtimeArgs.length - mainIndex, probe.className, ...arguments_);
  return spawnSync(probe.receipt.launch.java, runtimeArgs, {
    cwd: root, env: probe.environment, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 16_777_216,
  });
}
function writeFollowup2DomainResource(root, label, domain) {
  const resource = path.join(root, "resources", label.replaceAll(/[^A-Za-z0-9_.-]+/g, "-"));
  fs.mkdirSync(resource, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(resource, "domain-v1.json"), canonicalJson(domain), { encoding: "utf8", mode: 0o600 });
  return resource;
}
function followup2Domain(symbols = FULL_BATCH2B_SYMBOLS) {
  const live = JSON.parse(fs.readFileSync(DOMAIN, "utf8"));
  return { ...live, symbols: structuredClone(symbols) };
}
async function copiedFollowup2DomainValidators(root) {
  const transformRoot = path.join(root, "validators");
  fs.mkdirSync(transformRoot, { recursive: true, mode: 0o700 });
  const buildSource = fs.readFileSync(BUILD, "utf8");
  const terminal = "try {\n  process.stdout.write(`${canonicalJson(main())}\\n`);\n} catch (error) {\n  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);\n  process.exitCode = 1;\n}\n";
  assert.equal(countOccurrences(buildSource, terminal), 1, "builder terminal main marker");
  const buildCopy = path.join(transformRoot, "build-validator.mjs");
  fs.writeFileSync(buildCopy, `${buildSource.replace(terminal, "")}\nexport function followup2ValidateDomain(value) {\n  validateDomain({ value, material: { bytes: Buffer.from(canonicalJson(value), "utf8") } });\n  return true;\n}\n`);
  const buildHarness = path.join(transformRoot, "build-validator-harness.mjs");
  fs.writeFileSync(buildHarness, `import { followup2ValidateDomain } from ${JSON.stringify(pathToFileURL(buildCopy).href)};\nlet input = "";\nprocess.stdin.setEncoding("utf8");\nfor await (const chunk of process.stdin) input += chunk;\nfollowup2ValidateDomain(JSON.parse(input));\nprocess.stdout.write("accepted");\n`);
  const bridgeSource = fs.readFileSync(BRIDGE, "utf8");
  const bridgeMarker = "function validateDomain(material) {";
  assert.equal(countOccurrences(bridgeSource, bridgeMarker), 1, "bridge validator marker");
  const bridgeCopy = path.join(transformRoot, "bridge-validator.mjs");
  fs.writeFileSync(bridgeCopy, `${bridgeSource}\nexport function followup2ValidateDomain(value) {\n  validateDomain({ bytes: Buffer.from(canonicalJson(value), "utf8") });\n  return true;\n}\nexport function followup2ValidateAccepted(response, request, domain) {\n  validateAcceptedSemantics(response, request, domain);\n  return true;\n}\n`);
  const bridge = await import(`${pathToFileURL(bridgeCopy).href}?nonce=${crypto.randomUUID()}`);
  const builder = (value) => {
    const result = spawnSync("/usr/bin/env", ["-i", ...CLEAN_ENV, "/usr/local/bin/node", buildHarness], {
      cwd: root, encoding: "utf8", input: canonicalJson(value), shell: false, timeout: 30_000, maxBuffer: 4_194_304,
    });
    if (result.status !== 0 || result.stderr !== "" || result.stdout !== "accepted") {
      throw new Error(result.stderr || result.stdout || `builder validator exit ${result.status}`);
    }
    return true;
  };
  return { builder, bridge: bridge.followup2ValidateDomain,
    bridgeAnalysis: bridge.followup2ValidateAccepted };
}
function followup2MutationDomain(name) {
  const value = followup2Domain();
  const row = (fqn, signature) => {
    const matches = value.symbols.filter((entry) => entry.fqn === fqn && entry.signature === signature);
    assert.equal(matches.length, 1, `${name} mutation row ${fqn} | ${signature}`);
    return matches[0];
  };
  const sortSymbols = () => value.symbols.sort((left, right) => Buffer.compare(
    Buffer.from(canonicalJson({ fqn: left.fqn, signature: left.signature })),
    Buffer.from(canonicalJson({ fqn: right.fqn, signature: right.signature })),
  ));
  const vector3 = row("com.pico.spatial.core.math.Vector3", "Vector3(x: Float = 0f, y: Float = 0f, z: Float = 0f)");
  const spatialView = row("com.pico.spatial.ui.foundation.content.SpatialView", "SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit");
  const filter = row("kotlin.collections.filter", "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>");
  const launch = row("com.pico.spatial.ui.foundation.dsl.launch", "Application.launch(block: SpatialAppScope.() -> Unit): Unit");
  const componentType = row("com.pico.spatial.core.ecs.Component", "open class Component");
  const componentClone = row(EXACT_CLONE_CANARY_KEY.fqn, EXACT_CLONE_CANARY_KEY.signature);
  const mutations = {
    accept_full: () => {},
    top_missing: () => { delete value.witnessKinds; },
    top_extra: () => { value.extra = null; },
    symbol_missing: () => { delete componentClone.receiverKind; },
    symbol_extra: () => { componentClone.extra = null; },
    argument_missing: () => { delete vector3.arguments[0].hasDefault; },
    argument_extra: () => { vector3.arguments[0].extra = null; },
    callback_missing: () => { delete spatialView.callbacks[0].parameters; },
    callback_extra: () => { spatialView.callbacks[0].extra = null; },
    parameter_missing: () => { delete spatialView.callbacks[0].parameters[0].abstractType; },
    parameter_extra: () => { spatialView.callbacks[0].parameters[0].extra = null; },
    argument_negative: () => { vector3.arguments[0].position = -1; },
    argument_sparse: () => { vector3.arguments[1].position = 2; },
    argument_boolean: () => { vector3.arguments[0].hasDefault = 1; },
    argument_null_name: () => { vector3.arguments[0].name = null; },
    variadic_default: () => { const target = value.symbols.find((entry) => entry.arguments.some((argument) => argument.variadic)); target.arguments.find((argument) => argument.variadic).hasDefault = true; },
    variadic_callback: () => { const target = value.symbols.find((entry) => entry.arguments.some((argument) => argument.variadic) && entry.callbacks.length); const callback = target.callbacks[0]; target.arguments[callback.argumentPosition].variadic = true; },
    opaque_receiver: () => { componentClone.receiverAbstractType = "opaque"; },
    opaque_return: () => { componentClone.returnAbstractType = "opaque"; },
    opaque_callback_receiver: () => { launch.callbacks[0].receiverAbstractType = "opaque"; },
    opaque_callback_parameter: () => { filter.callbacks[0].parameters[0].abstractType = "opaque"; },
    opaque_type_argument: () => { componentClone.typeArguments = ["opaque"]; },
    opaque_conformance: () => { componentType.conformsTo = ["opaque"]; },
    callback_bad_position: () => { spatialView.callbacks[0].argumentPosition = 99; },
    callback_duplicate_position: () => { spatialView.callbacks[1].argumentPosition = spatialView.callbacks[0].argumentPosition; },
    callback_parameter_sparse: () => { spatialView.callbacks[0].parameters[0].position = 1; },
    receiver_source_without_type: () => { launch.callbacks[0].receiverAbstractType = null; },
    receiver_type_bad_source: () => { launch.callbacks[0].receiverSource = "argument:99"; },
    receiver_kind_type: () => { componentType.receiverKind = "instance"; componentType.receiverAbstractType = "component"; },
    receiver_kind_none: () => { componentClone.receiverKind = "none"; },
    conformance_self: () => { componentType.conformsTo = ["component"]; },
    conformance_duplicate: () => { componentType.conformsTo = ["entity", "entity"]; },
    conformance_cycle: () => {
      componentType.conformsTo = ["entity"];
      row("com.pico.spatial.core.ecs.Entity", "open class Entity").conformsTo = ["component"];
    },
    conformance_depth_nine: () => {
      const existingTargets = new Set(value.symbols.flatMap((entry) => entry.conformsTo));
      const seen = new Set();
      const chain = value.symbols.filter((entry) => entry.kind === "type"
          && entry.returnAbstractType !== null && entry.conformsTo.length === 0
          && !existingTargets.has(entry.returnAbstractType)
          && !seen.has(entry.returnAbstractType) && (seen.add(entry.returnAbstractType) || true))
        .slice(0, 10);
      assert.equal(chain.length, 10, "depth-nine mutation type chain");
      for (let index = 0; index < 9; index++) {
        chain[index].conformsTo = [chain[index + 1].returnAbstractType];
      }
    },
    conformance_unsorted: () => { componentType.conformsTo = ["transform_component", "entity"]; },
    conformance_target_without_type: () => { row("android.app.Application", "open class Application").conformsTo = ["boolean"]; },
    duplicate_type_fqn_distinct_signature: () => { const extra = structuredClone(row("com.pico.spatial.sense.base.AnchorUpdate", "class AnchorUpdate<T : Anchor>")); extra.signature = "interface AlternateAnchorUpdate<T>"; value.symbols.push(extra); sortSymbols(); },
    closed_sparse: () => { componentType.closedMemberSet = true; },
    required_closure_false: () => { row("com.pico.spatial.ui.platform.containers.SpatialNavigator", "interface SpatialNavigator").closedMemberSet = false; },
    return_source_with_type: () => { filter.returnSource = "element_of_receiver"; },
    passthrough_with_return_source: () => { filter.returnSource = "element_of_receiver"; filter.returnAbstractType = null; },
    return_source_wrong_identity: () => { row("androidx.compose.runtime.DisposableEffectScope.onDispose", "onDispose(onDisposeEffect: () -> Unit): DisposableEffectResult").returnSource = "element_of_receiver"; },
    return_source_missing_exact: () => { row("kotlin.collections.firstOrNull", "Iterable<T>.firstOrNull(): T?").returnSource = null; },
    passthrough_extra_callback: () => { const target = row("kotlin.let", "T.let(block: (T) -> R): R"); target.arguments.push({ abstractType: "callable", hasDefault: false, name: "extra", position: 1, samInterfaceFqn: null, variadic: false }); target.callbacks.push({ argumentPosition: 1, invocationModel: "user_action", parameters: [], receiverAbstractType: null, receiverSource: null, role: "button_click" }); },
    bad_type_argument: () => { componentClone.typeArguments = ["not_a_type"]; },
    bad_operator_kind: () => { componentType.operatorForm = "plus"; },
    bad_operator: () => { componentClone.operatorForm = "not_an_operator"; },
    operator_wrong_identity: () => { row("com.pico.spatial.core.ecs.Entity.convertPositionFrom", "convertPositionFrom(position: Vector3, baseEntity: Entity?): Vector3").operatorForm = "plus"; },
    operator_missing_exact: () => { row("com.pico.spatial.core.ecs.Entity.ComponentSet.get", "get(componentType: Class<T>): T?").operatorForm = null; },
    element_sentinel_noncollection_flow: () => { row("kotlin.let", "T.let(block: (T) -> R): R").callbacks[0].parameters[0].abstractType = "element_of_receiver"; },
    immediate_parameter_incompatible: () => { row("kotlin.let", "T.let(block: (T) -> R): R").callbacks[0].parameters[0].abstractType = "int"; },
    sam_nonexact_fqn: () => { row("com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate", "subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable").arguments[0].samInterfaceFqn = "AnchorUpdateSubscriber"; },
    nullable_required_suffix_removed: () => { row("kotlin.Throwable.message", "message: String?").signature = "message: String"; sortSymbols(); },
    nullable_unlisted_suffix_added: () => { row("android.os.BaseBundle.getInt", "getInt(key: String): Int").signature = "getInt(key: String): Int?"; sortSymbols(); },
    residual_dot_member: () => { const residual = structuredClone(componentClone); residual.fqn = "com.pico.spatial.core.ecs.Component.nested.clone"; value.symbols.push(residual); sortSymbols(); },
    arguments_over_bound: () => { row("kotlin.math.cos", "cos(x: Float): Float").arguments = Array.from({ length: 20 }, (_, position) => ({ abstractType: "float", hasDefault: false, name: `a${position}`, position, samInterfaceFqn: null, variadic: false })); },
    callbacks_over_bound: () => { const target = row("kotlin.repeat", "repeat(times: Int, action: (Int) -> Unit): Unit"); for (let position = 2; position <= 4; position++) { target.arguments.push({ abstractType: "callable", hasDefault: false, name: `extra${position}`, position, samInterfaceFqn: null, variadic: false }); target.callbacks.push({ argumentPosition: position, invocationModel: "possible_path", parameters: [], receiverAbstractType: null, receiverSource: null, role: "inline_block" }); } },
    callback_parameters_over_bound: () => { filter.callbacks[0].parameters = [{ abstractType: "element_of_receiver", position: 0 }, { abstractType: "int", position: 1 }, { abstractType: "string", position: 2 }]; },
    generic_kotlin_array: () => { value.symbols.push({ arguments: [], callbacks: [], closedMemberSet: false, conformsTo: [], effects: [], fqn: "kotlin.Array", kind: "type", memberPrecedence: "not_applicable", operatorForm: null, receiverAbstractType: null, receiverKind: "none", returnAbstractType: "immutable_iterable", returnSource: null, signature: "class Array<T>", typeArguments: [] }); sortSymbols(); },
    canary_plus_one: () => { value.symbols = [...structuredClone(MIGRATED_CANARY_SYMBOLS), { arguments: [], callbacks: [], closedMemberSet: false, conformsTo: [], effects: [], fqn: "example.Unrelated", kind: "type", memberPrecedence: "not_applicable", operatorForm: null, receiverAbstractType: null, receiverKind: "none", returnAbstractType: "string", returnSource: null, signature: "class Unrelated", typeArguments: [] }]; sortSymbols(); },
    full_plus_unrelated_type: () => { value.symbols.push({ arguments: [], callbacks: [], closedMemberSet: false, conformsTo: [], effects: [], fqn: "example.FullExtra", kind: "type", memberPrecedence: "not_applicable", operatorForm: null, receiverAbstractType: null, receiverKind: "none", returnAbstractType: "string", returnSource: null, signature: "class FullExtra", typeArguments: [] }); sortSymbols(); },
    narrow_producer_identity_drift: () => { row("com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors", "loadAllAnchors(): Array<PlaneAnchor>").signature = "loadAllAnchors(): List<PlaneAnchor>"; sortSymbols(); },
    narrow_producer_semantic_drift: () => { row("com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors", "loadAllAnchors(): Array<PlaneAnchor>").returnAbstractType = "immutable_list"; },
    physical_owner_type_identity_drift: () => { row("android.os.BaseBundle", "open class BaseBundle").signature = "abstract class BaseBundle"; sortSymbols(); },
    physical_result_producer_identity_drift: () => { row("android.os.Bundle", "Bundle()").signature = "Bundle(capacity: Int = 0)"; sortSymbols(); },
    physical_result_semantic_drift: () => { row("com.pico.spatial.ui.platform.containers.LocalSpatialNavigator", "val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>").returnAbstractType = "spatial_navigator"; },
    duplicate_effect: () => { componentClone.effects = ["construct", "construct"]; },
    bad_effect: () => { componentClone.effects = ["invented"]; },
    identity_duplicate: () => { value.symbols.splice(value.symbols.indexOf(componentClone), 0, structuredClone(componentClone)); },
    identity_reversed: () => { [value.symbols[0], value.symbols[1]] = [value.symbols[1], value.symbols[0]]; },
    closure_missing_member: () => { value.symbols = value.symbols.filter((entry) => !(entry.fqn === "com.pico.spatial.ui.platform.containers.SpatialNavigator.closeStage")); },
    closure_phantom_member: () => { const phantom = structuredClone(componentClone); phantom.fqn = "com.pico.spatial.ui.platform.containers.SpatialNavigator.phantom"; phantom.signature = "phantom(): Component"; value.symbols.push(phantom); value.symbols.sort((left, right) => Buffer.compare(Buffer.from(canonicalJson({ fqn: left.fqn, signature: left.signature })), Buffer.from(canonicalJson({ fqn: right.fqn, signature: right.signature })))); },
    role_anchor_swapped: () => { spatialView.callbacks[1].role = "anchor_update"; },
    role_spatial_swapped: () => { const target = row("com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate", "subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable"); target.callbacks[0].role = "spatial_update"; },
  };
  assert.equal(Object.hasOwn(mutations, name), true, `known follow-up #2 mutation ${name}`);
  mutations[name]();
  return value;
}
const FOLLOWUP2_DOMAIN_MUTATION_MATRIX = Object.freeze([
  ["accept_full", true], ["top_missing", false], ["top_extra", false],
  ["symbol_missing", false], ["symbol_extra", false], ["argument_missing", false], ["argument_extra", false],
  ["callback_missing", false], ["callback_extra", false], ["parameter_missing", false], ["parameter_extra", false],
  ["argument_negative", false], ["argument_sparse", false], ["argument_boolean", false], ["argument_null_name", true],
  ["variadic_default", false], ["variadic_callback", false], ["opaque_receiver", false], ["opaque_return", false],
  ["opaque_callback_receiver", false], ["opaque_callback_parameter", false], ["opaque_type_argument", false],
  ["opaque_conformance", false], ["callback_bad_position", false], ["callback_duplicate_position", false],
  ["callback_parameter_sparse", false], ["receiver_source_without_type", false], ["receiver_type_bad_source", false],
  ["receiver_kind_type", false], ["receiver_kind_none", false], ["conformance_self", false],
  ["conformance_duplicate", false], ["conformance_cycle", false], ["conformance_depth_nine", false],
  ["conformance_unsorted", false],
  ["conformance_target_without_type", true], ["duplicate_type_fqn_distinct_signature", true],
  ["closed_sparse", false], ["required_closure_false", false], ["return_source_with_type", false],
  ["passthrough_with_return_source", false], ["return_source_wrong_identity", false],
  ["return_source_missing_exact", false], ["passthrough_extra_callback", false],
  ["bad_type_argument", false], ["bad_operator_kind", false], ["bad_operator", false],
  ["operator_wrong_identity", false], ["operator_missing_exact", false],
  ["element_sentinel_noncollection_flow", false], ["immediate_parameter_incompatible", false],
  ["sam_nonexact_fqn", false], ["nullable_required_suffix_removed", false],
  ["nullable_unlisted_suffix_added", false], ["residual_dot_member", false], ["arguments_over_bound", false],
  ["callbacks_over_bound", false], ["callback_parameters_over_bound", false],
  ["generic_kotlin_array", true], ["canary_plus_one", true], ["full_plus_unrelated_type", true],
  ["narrow_producer_identity_drift", true], ["narrow_producer_semantic_drift", true],
  ["physical_owner_type_identity_drift", true], ["physical_result_producer_identity_drift", true],
  ["physical_result_semantic_drift", true], ["duplicate_effect", false],
  ["bad_effect", false], ["identity_duplicate", false], ["identity_reversed", false], ["closure_missing_member", false],
  ["closure_phantom_member", false], ["role_anchor_swapped", false], ["role_spatial_swapped", false],
]);
const FOLLOWUP2_KERNEL_COVERAGE = Object.freeze([
  "H-A", "H-B", "H-C", "H-D", "H-E", "H-F", "H-G", "H-H", "H-I", "H-J", "H-K", "H-L",
  ...Array.from({ length: 26 }, (_, index) => `D${index + 1}`),
]);
const FOLLOWUP2_KERNEL_SYMBOLS = Object.freeze({
  anchorUpdateType: ["com.pico.spatial.sense.base.AnchorUpdate", "class AnchorUpdate<T : Anchor>"],
  applicationOnCreate: ["android.app.Application.onCreate", "onCreate(): Unit"],
  applicationLaunch: ["com.pico.spatial.ui.foundation.dsl.launch", "Application.launch(block: SpatialAppScope.() -> Unit): Unit"],
  attachmentPanelBuilderType: ["com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder", "interface AttachmentPanelBuilder"],
  attachmentsType: ["com.pico.spatial.ui.foundation.content.SpatialViewAttachments", "interface SpatialViewAttachments"],
  baseBundleType: ["android.os.BaseBundle", "open class BaseBundle"],
  bundleGetString: ["android.os.BaseBundle.getString", "getString(key: String): String?"],
  bundleGetBoolean: ["android.os.BaseBundle.getBoolean", "getBoolean(key: String): Boolean"],
  bundleGetInt: ["android.os.BaseBundle.getInt", "getInt(key: String): Int"],
  bundleConstructor: ["android.os.Bundle", "Bundle()"],
  bundlePutString: ["android.os.BaseBundle.putString", "putString(key: String, value: String?): Unit"],
  bundleType: ["android.os.Bundle", "class Bundle"],
  button: ["com.pico.spatial.ui.design.Button", "Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, size: ButtonSize = ButtonDefaults.Regular, colors: ButtonColors = ButtonDefaults.buttonColors(), leadingIcon: (@Composable () -> Unit)? = null, trailingIcon: (@Composable () -> Unit)? = null, contentPadding: PaddingValues = ButtonDefaults.paddingForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), shape: Shape = ButtonDefaults.shapeForButtonSize(size), gap: Dp = ButtonDefaults.gapForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), interactionSource: MutableInteractionSource = remember { MutableInteractionSource() }, content: @Composable RowScope.() -> Unit): Unit"],
  cancellableCancel: ["com.pico.spatial.core.lifecycle.Cancellable.cancel", "cancel(): Unit"],
  cancellableType: ["com.pico.spatial.core.lifecycle.Cancellable", "interface Cancellable"],
  coroutineScopeType: ["kotlinx.coroutines.CoroutineScope", "interface CoroutineScope"],
  compositionLocalCurrent: ["androidx.compose.runtime.CompositionLocal.current", "current: T"],
  compositionLocalType: ["androidx.compose.runtime.CompositionLocal", "abstract class CompositionLocal<T>"],
  defaultWindow: ["com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer", "SpatialAppScope.DefaultWindowContainer(content: @Composable WindowContainerScope.() -> Unit): Unit"],
  disposableEffect1: ["androidx.compose.runtime.DisposableEffect", "DisposableEffect(key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit"],
  disposableEffect2: ["androidx.compose.runtime.DisposableEffect", "DisposableEffect(key1: Any?, key2: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit"],
  disposableEffect3: ["androidx.compose.runtime.DisposableEffect", "DisposableEffect(key1: Any?, key2: Any?, key3: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit"],
  disposableEffectVararg: ["androidx.compose.runtime.DisposableEffect", "DisposableEffect(vararg keys: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit"],
  disposableScopeType: ["androidx.compose.runtime.DisposableEffectScope", "class DisposableEffectScope"],
  componentSetGet: ["com.pico.spatial.core.ecs.Entity.ComponentSet.get", "get(componentType: Class<T>): T?"],
  componentSetType: ["com.pico.spatial.core.ecs.Entity.ComponentSet", "class ComponentSet"],
  componentClone: ["com.pico.spatial.core.ecs.Component.clone", "clone(): Component"],
  componentType: ["com.pico.spatial.core.ecs.Component", "open class Component"],
  entityConstructor: ["com.pico.spatial.core.ecs.Entity", "Entity()"],
  entityComponents: ["com.pico.spatial.core.ecs.Entity.components", "components: ComponentSet"],
  entityConvertPosition: ["com.pico.spatial.core.ecs.Entity.convertPositionFrom", "convertPositionFrom(position: Vector3, baseEntity: Entity?): Vector3"],
  entityConvertRotation: ["com.pico.spatial.core.ecs.Entity.convertRotationFrom", "convertRotationFrom(rotation: Quat, baseEntity: Entity?): Quat"],
  filter: ["kotlin.collections.filter", "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>"],
  forEach: ["kotlin.collections.forEach", "Iterable<T>.forEach(action: (T) -> Unit): Unit"],
  emptyList: ["kotlin.collections.emptyList", "emptyList<T>(): List<T>"],
  firstOrNull: ["kotlin.collections.firstOrNull", "Iterable<T>.firstOrNull(): T?"],
  isNotEmpty: ["kotlin.collections.isNotEmpty", "Collection<T>.isNotEmpty(): Boolean"],
  isEmpty: ["kotlin.collections.isEmpty", "Collection<T>.isEmpty(): Boolean"],
  launchedEffect1: ["androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(key1: Any?, block: suspend CoroutineScope.() -> Unit): Unit"],
  launchedEffect2: ["androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(key1: Any?, key2: Any?, block: suspend CoroutineScope.() -> Unit): Unit"],
  launchedEffect3: ["androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(key1: Any?, key2: Any?, key3: Any?, block: suspend CoroutineScope.() -> Unit): Unit"],
  launchedEffectVararg: ["androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit): Unit"],
  coroutineLaunch: ["kotlinx.coroutines.launch", "CoroutineScope.launch(context: CoroutineContext = EmptyCoroutineContext, start: CoroutineStart = CoroutineStart.DEFAULT, block: suspend CoroutineScope.() -> Unit): Job"],
  maxByOrNull: ["kotlin.collections.maxByOrNull", "Iterable<T>.maxByOrNull(selector: (T) -> R): T?"],
  modifierFillMaxSize: ["androidx.compose.foundation.layout.fillMaxSize", "Modifier.fillMaxSize(fraction: Float = 1f): Modifier"],
  modifierType: ["androidx.compose.ui.Modifier", "interface Modifier"],
  modifierCompanionType: ["androidx.compose.ui.Modifier.Companion", "companion object : Modifier"],
  let: ["kotlin.let", "T.let(block: (T) -> R): R"],
  apply: ["kotlin.apply", "T.apply(block: T.() -> Unit): T"],
  remember0: ["androidx.compose.runtime.remember", "remember(calculation: () -> T): T"],
  localSpatialNavigator: ["com.pico.spatial.ui.platform.containers.LocalSpatialNavigator", "val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>"],
  onDispose: ["androidx.compose.runtime.DisposableEffectScope.onDispose", "onDispose(onDisposeEffect: () -> Unit): DisposableEffectResult"],
  picoTheme: ["com.pico.spatial.ui.design.PicoTheme", "PicoTheme(colorScheme: ColorScheme = systemColorScheme(LocalContext.current), typography: Typography? = null, content: @Composable () -> Unit): Unit"],
  providableCompositionLocalType: ["androidx.compose.runtime.ProvidableCompositionLocal", "abstract class ProvidableCompositionLocal<T>"],
  planeLoad: ["com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors", "loadAllAnchors(): Array<PlaneAnchor>"],
  planeBoundingBox: ["com.pico.spatial.sense.plane.PlaneAnchor.boundingBoxSize", "boundingBoxSize: Vector2"],
  planeOrientation: ["com.pico.spatial.sense.plane.PlaneAnchor.planeOrientation", "planeOrientation: PlaneOrientation"],
  planeOrientationType: ["com.pico.spatial.sense.plane.PlaneOrientation", "enum class PlaneOrientation"],
  planeOrientationDown: ["com.pico.spatial.sense.plane.PlaneOrientation.HORIZONTAL_DOWNWARD", "HORIZONTAL_DOWNWARD"],
  planeOrientationUp: ["com.pico.spatial.sense.plane.PlaneOrientation.HORIZONTAL_UPWARD", "HORIZONTAL_UPWARD"],
  planeSemantics: ["com.pico.spatial.sense.plane.PlaneAnchor.semantics", "semantics: SemanticLabelType"],
  semanticLabelType: ["com.pico.spatial.sense.base.SemanticLabelType", "enum class SemanticLabelType"],
  semanticFloor: ["com.pico.spatial.sense.base.SemanticLabelType.FLOOR", "FLOOR"],
  semanticTable: ["com.pico.spatial.sense.base.SemanticLabelType.TABLE", "TABLE"],
  planeTransform: ["com.pico.spatial.sense.plane.PlaneAnchor.transform", "transform: Transform"],
  planeManagerType: ["com.pico.spatial.sense.plane.PlaneTrackingManager", "object PlaneTrackingManager"],
  planeAnchorType: ["com.pico.spatial.sense.plane.PlaneAnchor", "class PlaneAnchor"],
  planeSubscribe: ["com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate", "subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable"],
  planeStart: ["com.pico.spatial.sense.plane.PlaneTrackingManager.start", "start(): Unit"],
  planeStop: ["com.pico.spatial.sense.plane.PlaneTrackingManager.stop", "stop(): Unit"],
  planeToList: ["kotlin.collections.toList", "Array<out T>.toList(): List<T>"],
  quatIdentity: ["com.pico.spatial.core.math.Quat.identity", "identity(): Quat"],
  quatType: ["com.pico.spatial.core.math.Quat", "class Quat"],
  repeat: ["kotlin.repeat", "repeat(times: Int, action: (Int) -> Unit): Unit"],
  rowScopeType: ["androidx.compose.foundation.layout.RowScope", "interface RowScope"],
  spatialAppScopeType: ["com.pico.spatial.ui.foundation.dsl.SpatialAppScope", "interface SpatialAppScope"],
  spatialContentType: ["com.pico.spatial.core.container.SpatialViewContent", "class SpatialViewContent"],
  spatialContentEntities: ["com.pico.spatial.core.container.SpatialViewEntityManager.entities", "entities: SpatialViewEntityCollection"],
  spatialContentEntityManagerType: ["com.pico.spatial.core.container.SpatialViewEntityManager", "interface SpatialViewEntityManager"],
  spatialContentEventFilter: ["com.pico.spatial.core.container.SpatialViewEventManager.filter", "filter: EventSourceFilter"],
  spatialContentEventManagerType: ["com.pico.spatial.core.container.SpatialViewEventManager", "interface SpatialViewEventManager"],
  spatialContentLocalSpace: ["com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.localSpatialCoordinateSpace", "localSpatialCoordinateSpace: SpatialCoordinateSpace"],
  spatialContentSpaceConverterType: ["com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter", "interface SpatialCoordinateSpaceConverter"],
  spatialEntityCollectionType: ["com.pico.spatial.core.container.SpatialViewEntityCollection", "open class SpatialViewEntityCollection"],
  entityType: ["com.pico.spatial.core.ecs.Entity", "open class Entity"],
  spatialContainerBundle: ["com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle", "bundle: Bundle?"],
  spatialContainerScopeType: ["com.pico.spatial.ui.platform.containers.SpatialContainerScope", "interface SpatialContainerScope"],
  spatialNavigatorCloseStage: ["com.pico.spatial.ui.platform.containers.SpatialNavigator.closeStage", "closeStage(): Unit"],
  spatialNavigatorType: ["com.pico.spatial.ui.platform.containers.SpatialNavigator", "interface SpatialNavigator"],
  spatialView: ["com.pico.spatial.ui.foundation.content.SpatialView", "SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit"],
  stage: ["com.pico.spatial.ui.foundation.dsl.Stage", "SpatialAppScope.Stage(id: String, immersion: Immersion? = null, brightness: Brightness? = null, upperLimbRenderMode: UpperLimbRenderMode? = null, targetActivity: Class<out ComponentActivity>? = null, content: @Composable StageScope.() -> Unit): Unit"],
  stageScopeType: ["com.pico.spatial.ui.platform.containers.StageScope", "interface StageScope"],
  windowScopeType: ["com.pico.spatial.ui.platform.containers.WindowContainerScope", "interface WindowContainerScope"],
  intProgressionIterator: ["kotlin.ranges.IntProgression.iterator", "iterator(): IntIterator"],
  intProgressionType: ["kotlin.ranges.IntProgression", "open class IntProgression"],
  intRangeType: ["kotlin.ranges.IntRange", "class IntRange"],
  until: ["kotlin.ranges.until", "Int.until(to: Int): IntRange"],
  textString: ["com.pico.spatial.ui.design.Text", "Text(text: String, modifier: Modifier = Modifier, color: Color = Color.Unspecified, autoSize: TextAutoSize? = null, fontSize: TextUnit = TextUnit.Unspecified, fontStyle: FontStyle? = null, fontWeight: FontWeight? = null, fontFamily: FontFamily? = null, letterSpacing: TextUnit = TextUnit.Unspecified, textDecoration: TextDecoration? = null, textAlign: TextAlign = TextAlign.Unspecified, lineHeight: TextUnit = TextUnit.Unspecified, overflow: TextOverflow = TextOverflow.Clip, softWrap: Boolean = true, maxLines: Int = Int.MAX_VALUE, minLines: Int = 1, onTextLayout: ((TextLayoutResult) -> Unit)? = null, style: TextStyle = LocalTextStyle.current): Unit"],
  throwableMessage: ["kotlin.Throwable.message", "message: String?"],
  throwableType: ["kotlin.Throwable", "open class Throwable"],
  transformComponentType: ["com.pico.spatial.core.ecs.TransformComponent", "class TransformComponent"],
  transformComponentConstructor: ["com.pico.spatial.core.ecs.TransformComponent", "TransformComponent(position: Vector3, rotation: Quat, scale: Vector3)"],
  transformComponentPosition: ["com.pico.spatial.core.ecs.TransformComponent.position", "position: Vector3"],
  transformPosition: ["com.pico.spatial.core.math.Transform.position", "position: Vector3"],
  systemType: ["com.pico.spatial.core.ecs.System", "abstract class System"],
  systemUpdate: ["com.pico.spatial.core.ecs.System.update", "update(context: SceneUpdateContext): Unit"],
  registerSystem: ["com.pico.spatial.ui.foundation.dsl.registerSystem", "registerSystem<T : System>(): Unit"],
  unregisterSystem: ["com.pico.spatial.ui.foundation.dsl.unregisterSystem", "unregisterSystem<T : System>(): Unit"],
  vector3Constructor: ["com.pico.spatial.core.math.Vector3", "Vector3(x: Float = 0f, y: Float = 0f, z: Float = 0f)"],
  vector3Type: ["com.pico.spatial.core.math.Vector3", "class Vector3"],
  with: ["kotlin.with", "with(receiver: T, block: T.() -> R): R"],
});
const followup2KernelCall = (name, textIncludes = undefined) => ({
  kind: "call", name, ...(textIncludes === undefined ? {} : { textIncludes, smallestSpan: true }),
});
const followup2KernelFunction = (name) => ({ kind: "function_decl", name });
const followup2KernelLambda = (marker) => ({ kind: "lambda", textIncludes: marker, smallestSpan: true });
const followup2KernelArgument = (marker) => ({ kind: "argument", textIncludes: marker, smallestSpan: true });
const followup2KernelName = (name, textIncludes = undefined) => ({ kind: "name_ref", name, ...(textIncludes === undefined ? {} : { textIncludes }) });
function followup2AssertArgumentMode(observed) {
  const owner = followup2KernelLambda("argument-owner-marker");
  const domainResolution = (call, symbol, label) => followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: call, owner, related: null, value: "domain", symbol,
  }, label);
  const domainArgument = (marker, call, position, symbol, label) => followup2ExpectKernelFact(observed, {
    kind: "argument_binding", subject: followup2KernelArgument(marker), owner: call,
    related: null, value: String(position), symbol,
  }, label);
  const vector = followup2KernelCall("Vector3", "303f");
  domainResolution(vector, FOLLOWUP2_KERNEL_SYMBOLS.vector3Constructor, "D8 named Vector3 resolution");
  domainArgument("z = 303f", vector, 2, FOLLOWUP2_KERNEL_SYMBOLS.vector3Constructor, "D8 out-of-order z");
  domainArgument("x = 101f", vector, 0, FOLLOWUP2_KERNEL_SYMBOLS.vector3Constructor, "D8 skipped-default x");

  const textCall = followup2KernelCall("Text", "concrete-text");
  domainResolution(textCall, FOLLOWUP2_KERNEL_SYMBOLS.textString, "D10 concrete String beats opaque Text");
  domainArgument("concrete-text", textCall, 0, FOLLOWUP2_KERNEL_SYMBOLS.textString, "D10 concrete Text argument");

  const fixed = followup2KernelCall("LaunchedEffect", "fixed-callback-marker");
  domainResolution(fixed, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffect1, "D10 fixed LaunchedEffect beats vararg");
  domainArgument("fixed-key", fixed, 0, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffect1, "D8 fixed key");
  domainArgument("fixed-callback-marker", fixed, 1, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffect1, "D8 fixed callback");

  const zeroVararg = followup2KernelCall("LaunchedEffect", "zero-vararg-marker");
  domainResolution(zeroVararg, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffectVararg, "H-I zero-value vararg");
  domainArgument("zero-vararg-marker", zeroVararg, 1, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffectVararg, "H-I zero-value callback position");
  const multiVararg = followup2KernelCall("LaunchedEffect", "multi-vararg-marker");
  domainResolution(multiVararg, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffectVararg, "H-I multi-value vararg");
  for (const marker of ["vararg-a", "vararg-b", "vararg-c", "vararg-d"]) {
    domainArgument(marker, multiVararg, 0, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffectVararg, `H-I ${marker} physical position`);
  }
  domainArgument("multi-vararg-marker", multiVararg, 1, FOLLOWUP2_KERNEL_SYMBOLS.launchedEffectVararg, "H-I multi-value callback position");

  const stage = followup2KernelCall("Stage", "named-stage");
  domainResolution(stage, FOLLOWUP2_KERNEL_SYMBOLS.stage, "D8 Stage named resolution");
  domainArgument("stage-content-marker", stage, 5, FOLLOWUP2_KERNEL_SYMBOLS.stage, "D8 Stage out-of-order content");
  domainArgument("named-stage", stage, 0, FOLLOWUP2_KERNEL_SYMBOLS.stage, "D8 Stage id");

  const typed = followup2KernelCall("registerSystem", "PrimarySystem");
  domainResolution(typed, FOLLOWUP2_KERNEL_SYMBOLS.registerSystem, "H-C explicit type argument resolution");
  followup2ExpectKernelFact(observed, {
    kind: "type_argument", subject: { kind: "type_ref", text: "PrimarySystem", within: typed }, owner: typed,
    related: { kind: "class_decl", name: "PrimarySystem" }, value: "ecs_system",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.registerSystem,
  }, "H-C exact source type argument");
  const untyped = followup2KernelCall("unregisterSystem", "PrimarySystem");
  domainResolution(untyped, FOLLOWUP2_KERNEL_SYMBOLS.unregisterSystem, "H-C unregister type argument resolution");
  followup2ExpectKernelFact(observed, {
    kind: "type_argument", subject: { kind: "type_ref", text: "PrimarySystem", within: untyped }, owner: untyped,
    related: { kind: "class_decl", name: "PrimarySystem" }, value: "ecs_system",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.unregisterSystem,
  }, "H-C exact unregister source type argument");

  followup2ExpectUnsupported(observed, followup2KernelCall("Vector3", "zero-survivor"), "unsupported", owner,
    "D10 zero surviving domain overload");
  followup2ExpectUnsupported(observed, followup2KernelCall("convertPosition", "fromSpace"), "ambiguous",
    followup2KernelLambda("fromSpace"),
    "D10 two surviving domain overloads");
  followup2ExpectUnsupported(observed, { kind: "call", name: "registerSystem", text: "registerSystem()" }, "unsupported", owner,
    "H-C missing type argument");
  followup2ExpectUnsupported(observed, followup2KernelCall("registerSystem", "SecondarySystem, TertiarySystem"), "unsupported", owner,
    "H-C extra type argument");
  followup2ExpectUnsupported(observed, followup2KernelCall("registerSystem", "ArgumentRoot"), "unsupported", owner,
    "H-C wrong type-argument bound");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: followup2KernelCall("launch", "argument-owner-marker"),
    owner: followup2KernelFunction("onCreate"), related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "D2 unrelated root launch survives argument negatives");
}
function followup2AssertInvocationMode(observed) {
  const callbackModel = ({ marker, call, container, model, role, symbol, label }) => {
    const lambda = followup2KernelLambda(marker);
    followup2ExpectKernelFact(observed, {
      kind: "callback_binding", subject: lambda, owner: call, related: followup2KernelArgument(marker),
      value: role, symbol,
    }, `${label} callback binding`);
    followup2ExpectKernelFact(observed, {
      kind: "production_root", subject: lambda, owner: container, related: call, value: role, symbol,
    }, `${label} production root`);
    followup2ExpectKernelFact(observed, {
      kind: "reachable", subject: lambda, owner: lambda, related: call, value: model,
    }, `${label} invocation model`);
  };
  const launchCall = followup2KernelCall("launch", "source-root-marker");
  const launchLambda = followup2KernelLambda("source-root-marker");
  callbackModel({
    marker: "source-root-marker", call: launchCall, container: followup2KernelFunction("onCreate"),
    model: "source_root", role: "application_entry", symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
    label: "source_root",
  });
  followup2ExpectKernelFact(observed, {
    kind: "callback_receiver", subject: launchLambda, owner: launchCall, related: null,
    value: "spatial_app_scope", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialAppScopeType,
  }, "H-B exact launch physical callback receiver");

  callbackModel({
    marker: "possible-path-marker", call: followup2KernelCall("PicoTheme", "possible-path-marker"),
    container: launchLambda, model: "possible_path", role: "window_content",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.picoTheme, label: "possible_path",
  });
  callbackModel({
    marker: "user-action-marker", call: followup2KernelCall("Button", "user-action-marker"),
    container: launchLambda, model: "user_action", role: "button_click",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.button, label: "user_action",
  });
  const buttonContent = followup2KernelLambda("button-content-marker");
  followup2ExpectKernelFact(observed, {
    kind: "callback_receiver", subject: buttonContent, owner: followup2KernelCall("Button", "button-content-marker"),
    related: null, value: "row_scope", symbol: FOLLOWUP2_KERNEL_SYMBOLS.rowScopeType,
  }, "H-L Button content physical receiver");
  callbackModel({
    marker: "launched-path-marker", call: followup2KernelCall("LaunchedEffect", "launched-path-marker"),
    container: launchLambda, model: "launched_path", role: "launched_effect",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.launchedEffect1, label: "launched_path",
  });
  followup2ExpectKernelFact(observed, {
    kind: "callback_receiver", subject: followup2KernelLambda("launched-path-marker"),
    owner: followup2KernelCall("LaunchedEffect", "launched-path-marker"), related: null,
    value: "coroutine_scope", symbol: FOLLOWUP2_KERNEL_SYMBOLS.coroutineScopeType,
  }, "H-L LaunchedEffect physical receiver");
  const acquireLambda = followup2KernelLambda("acquire-path-marker");
  callbackModel({
    marker: "acquire-path-marker", call: followup2KernelCall("DisposableEffect", "acquire-path-marker"),
    container: launchLambda, model: "acquire_path", role: "disposable_effect",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.disposableEffect1, label: "acquire_path",
  });
  followup2ExpectKernelFact(observed, {
    kind: "callback_receiver", subject: acquireLambda,
    owner: followup2KernelCall("DisposableEffect", "acquire-path-marker"), related: null,
    value: "disposable_effect_scope", symbol: FOLLOWUP2_KERNEL_SYMBOLS.disposableScopeType,
  }, "H-L DisposableEffect physical receiver");
  callbackModel({
    marker: "cleanup-path-marker", call: followup2KernelCall("onDispose", "cleanup-path-marker"),
    container: acquireLambda, model: "cleanup_path", role: "dispose_cleanup",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.onDispose, label: "cleanup_path",
  });
  callbackModel({
    marker: "element-flow-marker", call: followup2KernelCall("repeat", "element-flow-marker"),
    container: launchLambda, model: "element_flow", role: "collection_element",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.repeat, label: "element_flow",
  });
  callbackModel({
    marker: "predicate-flow-marker", call: followup2KernelCall("filter", "predicate-flow-marker"),
    container: launchLambda, model: "predicate_flow", role: "collection_predicate",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter, label: "predicate_flow",
  });
  callbackModel({
    marker: "selector-flow-marker", call: followup2KernelCall("maxByOrNull", "selector-flow-marker"),
    container: launchLambda, model: "selector_flow", role: "collection_selector",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.maxByOrNull, label: "selector_flow",
  });
  callbackModel({
    marker: "immediate-inline-marker", call: followup2KernelCall("let", "immediate-inline-marker"),
    container: launchLambda, model: "immediate_inline", role: "inline_block",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.let, label: "immediate_inline",
  });

  followup2ExpectNoKernelFact(observed, {
    kind: "reachable", subject: followup2KernelLambda("dead-callback-marker"),
  }, "dead enclosing call does not execute callback");
  followup2ExpectNoKernelFact(observed, {
    kind: "production_root", subject: followup2KernelLambda("dead-callback-marker"),
  }, "dead callback is not promoted to a root");
  followup2ExpectUnsupported(observed, followup2KernelCall("PicoTheme", "wrong-callback-value"),
    "unsupported", launchLambda, "wrong callback position/value");
  const wrongPositionCall = followup2KernelCall("PicoTheme", "wrong-position-marker");
  followup2ExpectUnsupported(observed, wrongPositionCall, "unsupported", launchLambda,
    "callable at wrong physical callback position");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_binding", subject: followup2KernelLambda("wrong-position-marker"),
  }, "wrong-position lambda has no callback binding");
  for (const kind of ["callback_binding", "production_root", "reachable"]) {
    followup2ExpectNoKernelFact(observed, {
      kind, subject: followup2KernelLambda("valid-position-marker"),
    }, `rejected call grants no ${kind} to otherwise valid callback`);
  }
  const wrongSymbolLambda = followup2KernelLambda("wrong-symbol-callback-marker");
  followup2ExpectUnsupported(observed, followup2KernelCall("Text", "wrong-symbol-callback-marker"),
    "unsupported", launchLambda, "callback attached to an unmodeled symbol position");
  for (const kind of ["callback_binding", "reachable"]) {
    followup2ExpectNoKernelFact(observed, { kind, subject: wrongSymbolLambda },
      `wrong-symbol lambda has no ${kind}`);
  }
  followup2ExpectNoKernelFact(observed, {
    kind: "reachable", subject: followup2KernelLambda("merely-declared-marker"),
  }, "merely declared lambda is not reachable");
  followup2ExpectKernelFact(observed, {
    kind: "function_binding", subject: { kind: "property_decl", name: "merelyDeclared" },
    owner: launchLambda, related: followup2KernelLambda("merely-declared-marker"), value: "lambda",
  }, "merely declared lambda is recognized without being executed");
  const roleCall = followup2KernelCall("roleSpelling", "role-spelling-marker");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: roleCall, owner: launchLambda,
    related: followup2KernelFunction("roleSpelling"), value: "source",
  }, "callback role spelling source call resolves independently");
  followup2ExpectKernelFact(observed, {
    kind: "argument_binding", subject: followup2KernelArgument("role-spelling-marker"), owner: roleCall,
    related: { kind: "parameter_decl", name: "anchor_update", within: followup2KernelFunction("roleSpelling") },
    value: "0",
  }, "callback role spelling source argument binds ordinarily");
  followup2ExpectNoKernelFact(observed, {
    kind: "reachable", subject: followup2KernelLambda("role-spelling-marker"),
  }, "callback role spelling grants no execution");
  for (const kind of ["callback_binding", "production_root"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: followup2KernelLambda("role-spelling-marker"),
  }, `callback role spelling grants no ${kind}`);

  const missingProducer = followup2KernelLambda("missing-producer-marker");
  followup2ExpectUnsupported(observed, missingProducer, "unsupported", launchLambda,
    "element callback without a producer", followup2KernelCall("filter", "missing-producer-marker"));
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_parameter", subject: { kind: "parameter_decl", name: "missing" },
  }, "missing producer supplies no callback parameter fact");
  const nonBoolean = followup2KernelLambda("non-boolean-predicate-marker");
  followup2ExpectUnsupported(observed, nonBoolean, "unknown_return", launchLambda,
    "predicate callback with non-Boolean result", followup2KernelCall("filter", "non-boolean-predicate-marker"));
  followup2ExpectNoKernelFact(observed, {
    kind: "return_origin", subject: followup2KernelCall("filter", "non-boolean-predicate-marker"),
  }, "non-Boolean predicate has no collection result");
  const escapedSelector = followup2KernelLambda("escaped-selector-marker");
  const selectorEscape = followup2KernelCall("escapeSelectorKey");
  const escapedKey = { kind: "property_decl", name: "escapedKey", within: escapedSelector };
  followup2ExpectUnsupported(observed, escapedSelector, "escape", launchLambda,
    "selector callback with escaped result", followup2KernelCall("maxByOrNull", "escaped-selector-marker"));
  followup2ExpectUnsupported(observed, selectorEscape, "escape", escapedSelector,
    "selector result origin crosses an unknown call");
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: selectorEscape, owner: escapedSelector,
    related: escapedKey, value: "unknown_call",
  }, "selector result exact escape boundary");
  followup2ExpectNoKernelFact(observed, {
    kind: "return_origin", subject: followup2KernelCall("maxByOrNull", "escaped-selector-marker"),
  }, "escaped selector has no selected result");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: launchCall, owner: followup2KernelFunction("onCreate"),
    related: null, value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "unrelated invocation negatives retain the production launch");
}
function followup2AssertCallbackAndFunctionMode(observed) {
  const onCreate = followup2KernelFunction("onCreate");
  const mainApp = followup2KernelFunction("mainApp");
  const mainAppParameter = { kind: "parameter_decl", name: "scope", within: mainApp };
  const launchReference = { kind: "callable_ref", text: "::mainApp" };
  const launchCall = followup2KernelCall("startSpatial", "::mainApp");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: launchReference, owner: launchCall,
    related: followup2KernelArgument("::mainApp"), value: "application_entry",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "H-B callable reference callback binding");
  followup2ExpectKernelFact(observed, {
    kind: "callback_receiver", subject: launchReference, owner: launchCall, related: mainAppParameter,
    value: "spatial_app_scope", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialAppScopeType,
  }, "H-B receiver-to-first-parameter callable reference adaptation");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: mainApp, owner: null, related: launchCall,
    value: "application_entry", symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "H-B callable reference promoted production root");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: mainApp, owner: mainApp, related: launchCall,
    value: "source_root",
  }, "H-B callable reference source root");

  const wrongReference = { kind: "callable_ref", text: "::wrongMain" };
  const wrongLaunch = followup2KernelCall("startSpatial", "::wrongMain");
  followup2ExpectUnsupported(observed, wrongReference,
    "unsupported", onCreate, "H-B callable reference extra required parameter", wrongLaunch);
  for (const kind of ["callback_binding", "callback_receiver"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: wrongReference,
  }, `H-B wrong callable adaptation has no ${kind}`);
  for (const kind of ["production_root", "reachable"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: followup2KernelFunction("wrongMain"),
  }, `H-B wrong callable target has no ${kind}`);
  const ambiguousReference = { kind: "callable_ref", text: "::ambiguousMain" };
  const ambiguousLaunch = followup2KernelCall("startSpatial", "::ambiguousMain");
  followup2ExpectUnsupported(observed, ambiguousReference,
    "ambiguous", onCreate, "H-B competing callable-reference adaptations", ambiguousLaunch);
  for (const kind of ["callback_binding", "callback_receiver"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: ambiguousReference,
  }, `H-B ambiguous callable adaptation has no ${kind}`);
  for (const kind of ["production_root", "reachable"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: followup2KernelFunction("ambiguousMain"),
  }, `H-B ambiguous callable target has no ${kind}`);

  const outerCoroutine = followup2KernelLambda("outer-coroutine-marker");
  const innerLaunch = followup2KernelCall("launchCoroutine", "call-receiver-marker");
  const innerLambda = followup2KernelLambda("call-receiver-marker");
  followup2ExpectKernelFact(observed, {
    kind: "callback_receiver", subject: innerLambda, owner: innerLaunch, related: outerCoroutine,
    value: "coroutine_scope", symbol: FOLLOWUP2_KERNEL_SYMBOLS.coroutineScopeType,
  }, "H-B call_receiver origin and physical identity");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: innerLaunch, owner: outerCoroutine, related: outerCoroutine,
    value: "callback", symbol: FOLLOWUP2_KERNEL_SYMBOLS.coroutineLaunch,
  }, "D7 callback receiver precedence");

  const withCall = followup2KernelCall("with", "argument-receiver-marker");
  const withLambda = followup2KernelLambda("argument-receiver-marker");
  followup2ExpectKernelFact(observed, {
    kind: "callback_receiver", subject: withLambda, owner: withCall, related: mainAppParameter,
    value: "spatial_app_scope", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialAppScopeType,
  }, "H-B argument:n receiver propagation");

  const letCall = followup2KernelCall("let", "let-propagation-marker");
  const letLambda = followup2KernelLambda("let-propagation-marker");
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: { kind: "parameter_decl", name: "letValue" }, owner: letLambda,
    related: { kind: "string_template", text: '"let-source"' }, value: "string",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "H-B sole immediate-inline receiver parameter propagation");
  const mergeDecision = {
    kind: "call", name: "isNotEmpty", within: { kind: "property_decl", name: "mergeDecision" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: mergeDecision, owner: mainApp, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.isNotEmpty,
  }, "D6 merge selector is an exact typed but value-unknown Boolean origin");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: mergeDecision, owner: mainApp, related: null, value: "boolean",
  }, "D6 merge selector exact Boolean type");

  const implicitLambda = followup2KernelLambda("implicit-it-marker");
  followup2ExpectSupported(observed, implicitLambda,
    "H-B direct implicit-it callback stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: implicitLambda, owner: implicitLambda,
    related: followup2KernelCall("loadAllAnchors", "loadAllAnchors"), value: "plane_anchor",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-B implicit-it element callback parameter");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: implicitLambda, owner: implicitLambda, related: null,
    value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeAnchorType,
  }, "H-B direct implicit-it callback receives the exact physical element type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: implicitLambda, owner: implicitLambda,
    related: followup2KernelCall("loadAllAnchors", "loadAllAnchors"), value: "collection_element",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-B implicit-it retains the exact element producer origin");
  followup2ExpectKernelFact(observed, {
    kind: "def_use", subject: { kind: "name_ref", name: "it", text: "it", within: implicitLambda },
    owner: implicitLambda, related: implicitLambda, value: "",
  }, "H-B implicit-it def-use");
  const shadowLambda = followup2KernelLambda("shadow-it-marker");
  const shadowProperty = { kind: "property_decl", name: "it", within: shadowLambda };
  const shadowUse = { kind: "name_ref", name: "it", text: "it", within: shadowLambda };
  followup2ExpectKernelFact(observed, {
    kind: "def_use", subject: shadowUse, owner: shadowLambda, related: shadowProperty, value: "",
  }, "H-B explicit it shadow binds lexically");
  followup2ExpectNoKernelFact(observed, {
    kind: "def_use", subject: shadowUse, related: shadowLambda,
  }, "H-B shadow suppresses implicit-it binding");
  followup2ExpectUnsupported(observed, followup2KernelCall("forEach", "shadow-it-marker"),
    "unsupported", mainApp, "H-B shadow rejects implicit-it callback shape");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_binding", subject: shadowLambda,
  }, "H-B shadow lambda has no callback binding");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_parameter", subject: shadowLambda,
  }, "H-B shadow lambda has no implicit callback parameter");
  const extraParameters = followup2KernelLambda("extra-parameter-marker");
  followup2ExpectUnsupported(observed, followup2KernelCall("forEach", "extra-parameter-marker"),
    "unsupported", mainApp, "H-B extra callback parameter");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_binding", subject: extraParameters,
  }, "H-B extra-parameter lambda has no callback binding");
  for (const name of ["first", "second"]) followup2ExpectNoKernelFact(observed, {
    kind: "callback_parameter", subject: { kind: "parameter_decl", name, within: extraParameters },
  }, `H-B extra-parameter lambda grants no ${name} callback parameter`);

  const subscribe = followup2KernelCall("subscribeAnchorUpdate", "anchor-sam-marker");
  const subscribeLambda = followup2KernelLambda("anchor-sam-marker");
  const anchorUpdateParameter = { kind: "parameter_decl", name: "anchorUpdate" };
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: anchorUpdateParameter,
    owner: subscribeLambda, related: null, value: "anchor_update",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.anchorUpdateType,
  }, "H-L exact anchor SAM physical callback parameter");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: anchorUpdateParameter, owner: subscribeLambda, related: null,
    value: "callback", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeSubscribe,
  }, "H-B explicit SDK callback parameter fresh origin");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: subscribeLambda, owner: subscribe,
    related: followup2KernelArgument("anchor-sam-marker"), value: "anchor_update",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeSubscribe,
  }, "H-B exact anchor SAM callable identity");
  const planeSpatialSwap = followup2KernelLambda("plane-spatial-role-swap-marker");
  followup2ExpectUnsupported(observed, followup2KernelCall("subscribeAnchorUpdate", "plane-spatial-role-swap-marker"),
    "unsupported", mainApp, "H-B Plane callback with SpatialView shape");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_binding", subject: planeSpatialSwap,
  }, "H-B Plane/SpatialView swap has no callback binding");
  for (const name of ["swappedContent", "swappedAttachments"]) followup2ExpectNoKernelFact(observed, {
    kind: "callback_parameter", subject: { kind: "parameter_decl", name, within: planeSpatialSwap },
  }, `H-B Plane/SpatialView swap grants no ${name} callback parameter`);

  for (const [marker, parameterName, semanticType, physical] of [
    ["spatial-update-marker", "updateContent", "spatial_content", FOLLOWUP2_KERNEL_SYMBOLS.spatialContentType],
    ["spatial-update-marker", "updateAttachments", "spatial_view_attachments", FOLLOWUP2_KERNEL_SYMBOLS.attachmentsType],
    ["spatial-initial-marker", "initialContent", "spatial_content", FOLLOWUP2_KERNEL_SYMBOLS.spatialContentType],
    ["spatial-initial-marker", "initialAttachments", "spatial_view_attachments", FOLLOWUP2_KERNEL_SYMBOLS.attachmentsType],
  ]) {
    const callback = followup2KernelLambda(marker);
    followup2ExpectKernelFact(observed, {
      kind: "callback_parameter", subject: { kind: "parameter_decl", name: parameterName }, owner: callback,
      related: null, value: semanticType, symbol: physical,
    }, `H-L ${parameterName} physical callback parameter`);
  }
  const spatialAnchorSwap = followup2KernelLambda("spatial-anchor-role-swap-marker");
  followup2ExpectUnsupported(observed, followup2KernelCall("SpatialView", "spatial-anchor-role-swap-marker"),
    "unsupported", mainApp, "H-B SpatialView update with anchor shape");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_binding", subject: spatialAnchorSwap,
  }, "H-B SpatialView/anchor swap has no callback binding");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_parameter",
    subject: { kind: "parameter_decl", name: "swappedUpdate", within: spatialAnchorSwap },
  }, "H-B SpatialView/anchor swap grants no callback parameter");

  const localProperty = { kind: "property_decl", name: "local" };
  const localLambda = followup2KernelLambda("local-lambda-result");
  followup2ExpectKernelFact(observed, {
    kind: "function_binding", subject: localProperty, owner: mainApp, related: localLambda,
    value: "lambda",
  }, "D6 immutable local lambda binding");
  const localInvoke = followup2KernelCall("local", "local-direct");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: localInvoke, owner: mainApp, related: localLambda,
    value: "function_value",
  }, "D6 direct immutable lambda invoke");
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: localInvoke, owner: mainApp,
    related: { kind: "name_ref", name: "localInput" }, value: "string",
  }, "D6 lambda invocation return origin");
  const passedLambda = { kind: "lambda", textIncludes: "passedInput" };
  followup2ExpectKernelFact(observed, {
    kind: "function_binding", subject: { kind: "property_decl", name: "passed" }, owner: mainApp,
    related: passedLambda, value: "lambda",
  }, "D6 immutable callback argument binding");
  const passedLet = {
    kind: "call", name: "let",
    within: { kind: "qualified", text: '"passed-source".let(passed)' },
  };
  const passedReference = { kind: "name_ref", name: "passed", within: passedLet };
  followup2ExpectSupported(observed, passedLet, "D6 bound let call stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: passedReference,
    owner: passedLet, related: followup2KernelArgument("passed"),
    value: "inline_block", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D6 immutable lambda passed to modeled callback");
  const passedInput = { kind: "parameter_decl", name: "passedInput", within: passedLambda };
  const passedSource = { kind: "string_template", text: '"passed-source"' };
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: passedInput, owner: passedLambda,
    related: passedSource, value: "string", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D6 bound lambda target receives the modeled callback parameter");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: passedInput, owner: passedLambda,
    related: passedSource, value: "derived", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D6 bound lambda target retains the immediate receiver origin");
  for (const kind of ["callback_parameter", "type", "origin"]) {
    followup2ExpectNoKernelFact(observed, { kind, subject: passedReference },
      `D6 passed callback reference cannot acquire a synthetic ${kind} fact`);
  }
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: passedLambda, owner: { kind: "property_decl", name: "passed" }, related: passedLet,
    value: "inline_block", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D6 passed lambda promoted for immediate execution");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: passedLambda, owner: passedLambda, related: passedLet,
    value: "immediate_inline",
  }, "D6 passed lambda summary executes");
  followup2ExpectKernelFact(observed, {
    kind: "callback_result", subject: passedReference, owner: passedLet,
    related: { kind: "name_ref", name: "passedInput", within: passedLambda }, value: "string",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D6 passed lambda result");

  const wrongPassedProperty = { kind: "property_decl", name: "wrongPassed" };
  const wrongPassedLambda = followup2KernelLambda("wrong-passed-lambda-marker");
  const wrongPassedCall = {
    kind: "call", name: "let",
    within: { kind: "qualified", text: '"wrong-passed-source".let(wrongPassed)' },
  };
  const wrongPassedReference = { kind: "name_ref", name: "wrongPassed", within: wrongPassedCall };
  followup2ExpectKernelFact(observed, {
    kind: "function_binding", subject: wrongPassedProperty, owner: mainApp,
    related: wrongPassedLambda, value: "lambda",
  }, "D6 wrong-arity bound lambda is still an exact immutable function binding");
  followup2ExpectUnsupported(observed, wrongPassedCall, "unsupported", mainApp,
    "D6 wrong-arity bound lambda rejects the modeled call");
  for (const kind of ["callback_binding", "callback_result"]) {
    followup2ExpectNoKernelFact(observed, { kind, subject: wrongPassedReference },
      `D6 wrong-arity bound callback grants no ${kind}`);
  }
  followup2ExpectNoKernelFact(observed, {
    kind: "production_root", subject: wrongPassedLambda,
  }, "D6 wrong-arity bound lambda is not promoted");
  for (const name of ["wrongPassedLeft", "wrongPassedRight"]) {
    followup2ExpectNoKernelFact(observed, {
      kind: "callback_parameter", subject: { kind: "parameter_decl", name, within: wrongPassedLambda },
    }, `D6 wrong-arity bound lambda grants no callback parameter to ${name}`);
  }

  const boundFilter = followup2KernelCall("filter", "boundElementPredicate");
  const boundFilterReference = {
    kind: "name_ref", name: "boundElementPredicate", within: boundFilter,
  };
  const boundElementLambda = followup2KernelLambda("bound-element-marker");
  followup2ExpectSupported(observed, boundFilter,
    "D6 bound collection callback call stays untainted");
  followup2ExpectSupported(observed, boundElementLambda,
    "H-B bound implicit-it callback stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "function_binding", subject: { kind: "property_decl", name: "boundElementPredicate" },
    owner: mainApp, related: boundElementLambda, value: "lambda",
  }, "D6 immutable implicit-it collection callback binding");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: boundFilter, owner: mainApp, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D6 bound collection callback owning call resolves exactly");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: boundFilterReference, owner: boundFilter,
    related: { kind: "argument", within: boundFilter }, value: "collection_predicate",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D6 bound implicit-it collection callback maps through its NAME_REF argument");
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: boundElementLambda, owner: boundElementLambda,
    related: followup2KernelCall("loadAllAnchors", "loadAllAnchors"), value: "plane_anchor",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-B bound implicit-it target receives the exact producer element");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: boundElementLambda, owner: boundElementLambda, related: null,
    value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeAnchorType,
  }, "H-B bound implicit-it target receives the exact physical element type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: boundElementLambda, owner: boundElementLambda,
    related: followup2KernelCall("loadAllAnchors", "loadAllAnchors"), value: "collection_element",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-B bound implicit-it target retains exact producer origin");
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: boundElementLambda, owner: boundElementLambda,
    related: followup2KernelCall("loadAllAnchors", "loadAllAnchors"), value: "plane_anchor",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D16 bound implicit-it target retains exact producer element identity");
  const boundElementIt = { kind: "name_ref", name: "it", within: boundElementLambda };
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: boundElementIt, owner: boundElementLambda, related: null,
    value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeAnchorType,
  }, "H-B bound implicit-it use receives the exact physical element type");
  followup2ExpectKernelFact(observed, {
    kind: "def_use", subject: boundElementIt,
    owner: boundElementLambda, related: boundElementLambda, value: "",
  }, "H-B bound implicit-it target binds its lexical it use");
  const boundElementResult = { kind: "binary", value: "==", within: boundElementLambda };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: boundElementResult, owner: boundElementLambda,
    related: null, value: "enum",
  }, "D12 bound implicit-it predicate uses exact enum equality");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: boundElementResult, owner: boundElementLambda,
    related: null, value: "boolean",
  }, "D19 bound implicit-it predicate has an exact Boolean result");
  followup2ExpectSupported(observed, boundElementResult,
    "D19 bound implicit-it enum predicate stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: boundElementLambda,
    owner: { kind: "property_decl", name: "boundElementPredicate" }, related: boundFilter,
    value: "collection_predicate", symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D6 bound collection target is promoted through the modeled call");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: boundElementLambda, owner: boundElementLambda,
    related: boundFilter, value: "predicate_flow",
  }, "D6 bound collection target summary executes");
  followup2ExpectKernelFact(observed, {
    kind: "callback_result", subject: boundFilterReference, owner: boundFilter,
    related: boundElementResult, value: "boolean", symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D6 bound collection callback returns its exact Boolean predicate");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_parameter", subject: boundFilterReference,
  }, "D6 bound callback NAME_REF never substitutes for its implicit-it target");

  const callableLet = {
    kind: "call", name: "let",
    within: { kind: "qualified", text: '"callable-reference-source".let(::letIdentity)' },
  };
  const callableLetReference = { kind: "callable_ref", text: "::letIdentity", within: callableLet };
  const callableLetArgument = { kind: "argument", within: callableLet };
  const letIdentity = followup2KernelFunction("letIdentity");
  const letIdentityParameter = { kind: "parameter_decl", name: "letIdentityValue", within: letIdentity };
  const callableLetSource = { kind: "string_template", text: '"callable-reference-source"' };
  followup2ExpectSupported(observed, callableLet,
    "H-B callable-reference let call stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: callableLet, owner: mainApp, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "H-B callable-reference let call resolves exactly");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: callableLetReference, owner: callableLet,
    related: callableLetArgument, value: "inline_block", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "H-B callable-reference let callback binding");
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: letIdentityParameter, owner: letIdentity,
    related: callableLetSource, value: "string", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "H-B callable-reference densely maps the modeled parameter onto the declaration");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: letIdentityParameter, owner: letIdentity, related: null, value: "string",
  }, "H-B callable-reference target parameter retains its exact source type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: letIdentityParameter, owner: letIdentity,
    related: callableLetSource, value: "derived", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "H-B callable-reference target parameter retains the receiver origin");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: letIdentity, owner: null, related: callableLet,
    value: "inline_block", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "H-B callable-reference let target is promoted exactly");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: letIdentity, owner: letIdentity, related: callableLet,
    value: "immediate_inline",
  }, "H-B callable-reference let target executes immediately");
  followup2ExpectKernelFact(observed, {
    kind: "callback_result", subject: callableLetReference, owner: callableLet,
    related: { kind: "name_ref", name: "letIdentityValue", within: letIdentity }, value: "string",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "H-B callable-reference let target returns its mapped parameter");

  followup2ExpectKernelFact(observed, {
    kind: "function_binding", subject: { kind: "property_decl", name: "reference", within: mainApp }, owner: mainApp,
    related: followup2KernelFunction("identity"), value: "callable_reference",
  }, "D6 unique callable-reference binding");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: followup2KernelCall("reference", "reference-direct"), owner: mainApp,
    related: followup2KernelFunction("identity"), value: "function_value",
  }, "D6 callable-reference invocation");

  const parameterLambda = followup2KernelLambda("parameter-lambda-result");
  followup2ExpectKernelFact(observed, {
    kind: "function_binding", subject: { kind: "parameter_decl", name: "function", within: followup2KernelFunction("invokeBound") },
    owner: followup2KernelFunction("invokeBound"), related: parameterLambda, value: "lambda",
  }, "D6 immutable function parameter reaching binding");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: followup2KernelCall("function", "value"),
    owner: followup2KernelFunction("invokeBound"), related: parameterLambda, value: "function_value",
  }, "D6 immutable function parameter invocation");

  for (const [name, marker, taint] of [
    ["reassigned", "reassigned-call", "unsupported"],
    ["capturing", "capture-call", "escape"],
    ["merged", "merge-call", "ambiguous"],
    ["escaped", "escaped-call", "escape"],
  ]) {
    followup2ExpectUnsupported(observed, followup2KernelCall(name), taint, mainApp, `D6 ${name} ${marker} negative`);
  }
  const capturingLambda = followup2KernelLambda("capture");
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: capturingLambda, owner: mainApp,
    related: { kind: "property_decl", name: "mutable" }, value: "mutable_capture",
  }, "D6 mutable capture exact escape boundary");
  const externalEscape = followup2KernelCall("externalSink");
  followup2ExpectUnsupported(observed, externalEscape, "escape", mainApp,
    "D6 external higher-order call escape");
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: externalEscape, owner: mainApp,
    related: { kind: "property_decl", name: "escaped" }, value: "argument",
  }, "D6 external higher-order exact argument escape");
  followup2ExpectUnsupported(observed, { kind: "call", name: "function", text: "function()" },
    "unsupported", followup2KernelFunction("unknownBinding"), "D6 unknown parameter binding");
  followup2ExpectUnsupported(observed, { kind: "callable_ref", text: "value::collide" },
    "ambiguous", followup2KernelFunction("ambiguousReference"), "D6 ambiguous callable-reference declaration");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: launchCall, owner: onCreate, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "D2 callback negatives retain callable-reference launch");
}
function followup2AssertOwnersCollectionsMode(observed) {
  const root = followup2KernelLambda("owner-mode-root");
  const initial = followup2KernelLambda("spatial-owner-marker");
  const stage = followup2KernelLambda("stage-owner-marker");
  const window = followup2KernelLambda("window-owner-marker");
  const domainResolution = (subject, owner, symbol, label) => followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject, owner, related: null, value: "domain", symbol,
  }, label);
  const ownerRelation = (subject, _owner, value, symbol, label) => followup2ExpectKernelFact(observed, {
    kind: "conformance", subject, owner: null, related: null, value, symbol,
  }, label);

  const bundleCall = { kind: "call", name: "Bundle", text: "Bundle()", within: root };
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: bundleCall, owner: root, related: null,
    value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleType,
  }, "H-E Bundle constructor physical result");
  const bundleValue = {
    kind: "name_ref", name: "bundleValue", within: { kind: "qualified", textIncludes: "owner-value" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: bundleValue, owner: root, related: null,
    value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleType,
  }, "D18 delegated Bundle subject retains its physical child key");
  const putString = followup2KernelCall("putString", "owner-value");
  domainResolution(putString, root, FOLLOWUP2_KERNEL_SYMBOLS.bundlePutString, "D18 Bundle inherited member resolution");
  ownerRelation(bundleValue,
    root, "bundle", FOLLOWUP2_KERNEL_SYMBOLS.baseBundleType, "D18 Bundle to BaseBundle edge");

  const localNavigator = {
    kind: "name_ref", name: "LocalSpatialNavigator",
    within: { kind: "qualified", text: "LocalSpatialNavigator.current" },
  };
  domainResolution(localNavigator, root, FOLLOWUP2_KERNEL_SYMBOLS.localSpatialNavigator,
    "H-H top-level LocalSpatialNavigator property");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: localNavigator, owner: root, related: null, value: "composition_local",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.providableCompositionLocalType,
  }, "H-E LocalSpatialNavigator physical result");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: localNavigator, owner: root, related: null, value: "retained",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.localSpatialNavigator,
  }, "H-H LocalSpatialNavigator stable top-level-property origin");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: localNavigator, owner: root, related: localNavigator, value: "read",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.localSpatialNavigator,
  }, "D20 targetless top-level-property read effect");
  followup2ExpectKernelFact(observed, {
    kind: "read", subject: localNavigator, owner: root, related: localNavigator, value: "",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.localSpatialNavigator,
  }, "D21 targetless top-level-property read capability");
  const current = { kind: "name_ref", name: "current", within: { kind: "qualified", text: "LocalSpatialNavigator.current" } };
  domainResolution(current, root, FOLLOWUP2_KERNEL_SYMBOLS.compositionLocalCurrent,
    "D18 CompositionLocal.current resolution");
  ownerRelation(localNavigator, root, "composition_local", FOLLOWUP2_KERNEL_SYMBOLS.compositionLocalType,
    "D18 ProvidableCompositionLocal to CompositionLocal edge");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: current, owner: root, related: null,
    value: "spatial_navigator", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorType,
  }, "H-E exact LocalSpatialNavigator current specialization");
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: current, owner: root, related: localNavigator,
    value: "spatial_navigator", symbol: FOLLOWUP2_KERNEL_SYMBOLS.compositionLocalCurrent,
  }, "H-E LocalSpatialNavigator producer specialization");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: current, owner: root, related: localNavigator,
    value: "derived", symbol: FOLLOWUP2_KERNEL_SYMBOLS.compositionLocalCurrent,
  }, "H-E LocalSpatialNavigator derived producer identity");

  for (const [propertyName, memberSymbol, ownerType, label] of [
    ["entities", FOLLOWUP2_KERNEL_SYMBOLS.spatialContentEntities, FOLLOWUP2_KERNEL_SYMBOLS.spatialContentEntityManagerType, "entity manager"],
    ["filter", FOLLOWUP2_KERNEL_SYMBOLS.spatialContentEventFilter, FOLLOWUP2_KERNEL_SYMBOLS.spatialContentEventManagerType, "event manager"],
    ["localSpatialCoordinateSpace", FOLLOWUP2_KERNEL_SYMBOLS.spatialContentLocalSpace, FOLLOWUP2_KERNEL_SYMBOLS.spatialContentSpaceConverterType, "coordinate converter"],
  ]) {
    const qualified = { kind: "qualified", text: `initialContent.${propertyName}` };
    const property = { kind: "name_ref", name: propertyName, within: qualified };
    const receiver = { kind: "name_ref", name: "initialContent", within: qualified };
    domainResolution(property, initial, memberSymbol, `D18 SpatialViewContent ${label} member`);
    ownerRelation(receiver, initial, "spatial_content", ownerType, `D18 SpatialViewContent ${label} edge`);
  }
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter",
    subject: { kind: "parameter_decl", name: "initialContent", within: initial }, owner: initial,
    related: null, value: "spatial_content", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialContentType,
  }, "D18 SpatialViewContent child key is supplied by the physical callback parameter");

  for (const [callback, label, childType] of [
    [stage, "StageScope", FOLLOWUP2_KERNEL_SYMBOLS.stageScopeType],
    [window, "WindowContainerScope", FOLLOWUP2_KERNEL_SYMBOLS.windowScopeType],
  ]) {
    const property = { kind: "name_ref", name: "bundle", within: callback };
    domainResolution(property, callback, FOLLOWUP2_KERNEL_SYMBOLS.spatialContainerBundle,
      `D18 ${label} inherited bundle member`);
    ownerRelation(callback, callback, "spatial_container_scope", FOLLOWUP2_KERNEL_SYMBOLS.spatialContainerScopeType,
      `D18 ${label} to SpatialContainerScope edge`);
    followup2ExpectKernelFact(observed, {
      kind: "callback_receiver", subject: callback,
      owner: label === "StageScope" ? followup2KernelCall("Stage", "stage-owner-marker")
        : followup2KernelCall("DefaultWindowContainer", "window-owner-marker"),
      related: null, value: "spatial_container_scope", symbol: childType,
    }, `H-L ${label} physical callback identity`);
    followup2ExpectKernelFact(observed, {
      kind: "type", subject: property, owner: callback, related: null,
      value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleType,
    }, `H-E ${label}.bundle physical result`);
  }

  const until = { kind: "binary", value: "until", within: { kind: "qualified", text: "(0 until 3).iterator()" } };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: until, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.until,
  }, "D19 exact until row");
  followup2ExpectSupported(observed, until, "D19 exact until stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: until, owner: root, related: null,
    value: "integer_range", symbol: FOLLOWUP2_KERNEL_SYMBOLS.intRangeType,
  }, "H-E until physical IntRange result");
  const iterator = followup2KernelCall("iterator", "iterator()");
  domainResolution(iterator, root, FOLLOWUP2_KERNEL_SYMBOLS.intProgressionIterator,
    "D18 IntRange inherited iterator member");
  followup2ExpectSupported(observed, iterator, "D18 exact inherited iterator stays untainted");
  ownerRelation(until, root, "integer_range", FOLLOWUP2_KERNEL_SYMBOLS.intProgressionType,
    "D18 IntRange to IntProgression edge");

  const load = followup2KernelCall("loadAllAnchors", "loadAllAnchors()");
  const loadQualified = { kind: "qualified", text: "PlaneTrackingManager.loadAllAnchors()" };
  const loadReceiver = { kind: "name_ref", name: "PlaneTrackingManager", within: loadQualified };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: load, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-G exact loadAllAnchors producer row");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: load, owner: root, related: null, value: "plane_anchor_collection",
  }, "H-G exact loadAllAnchors collection type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: load, owner: root, related: loadReceiver,
    value: "derived", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-G exact loadAllAnchors producer origin");
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: load, owner: root, related: loadReceiver,
    value: "plane_anchor_collection", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-G exact loadAllAnchors returned origin");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: load, owner: root, related: loadReceiver,
    value: "load", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-G exact loadAllAnchors load effect");
  const toList = { kind: "call", name: "toList", within: { kind: "property_decl", name: "anchors" } };
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: toList, owner: root, related: load,
    value: "plane_anchor_collection", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeToList,
  }, "H-G toList preserves exact load origin");
  followup2ExpectKernelFact(observed, {
    kind: "conformance", subject: toList, owner: null, related: null,
    value: "immutable_iterable", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeToList,
  }, "H-G exact narrow compatibility edge");
  const filterCall = followup2KernelCall("filter", "semantic-filter-marker");
  const filterLambda = followup2KernelLambda("semantic-filter-marker");
  const planeParameter = { kind: "parameter_decl", name: "plane" };
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: planeParameter, owner: filterLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-G filter element retains exact producer row");
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: planeParameter, owner: filterLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D16 filter element identity");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: planeParameter, owner: filterLambda, related: load,
    value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D16 filter element exact producer origin");
  followup2ExpectKernelFact(observed, {
    kind: "conformance", subject: load, owner: null, related: null,
    value: "immutable_iterable", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-G direct load narrow compatibility edge");
  const semantic = {
    kind: "binary", value: "==", textIncludes: "SemanticLabelType.TABLE", within: filterLambda,
  };
  const orientationUp = {
    kind: "binary", value: "==", textIncludes: "HORIZONTAL_UPWARD", within: filterLambda,
  };
  const orientationDown = {
    kind: "binary", value: "==", textIncludes: "HORIZONTAL_DOWNWARD", within: filterLambda,
  };
  const orientation = {
    kind: "binary", value: "||", textIncludes: "HORIZONTAL_DOWNWARD", within: filterLambda,
  };
  const areaProduct = { kind: "binary", value: "*", within: filterLambda };
  const area = { kind: "binary", value: ">", textIncludes: "boundingBoxSize", within: filterLambda };
  const semanticOrientationAnd = {
    kind: "binary", value: "&&", textIncludes: "HORIZONTAL_DOWNWARD", within: filterLambda,
    smallestSpan: true,
  };
  const areaAnd = {
    kind: "binary", value: "&&", textIncludes: "boundingBoxSize", within: filterLambda,
  };
  for (const [syntax, label] of [
    [semantic, "semantic equality"], [orientationUp, "upward orientation equality"],
    [orientationDown, "downward orientation equality"], [orientation, "orientation disjunction"],
    [areaProduct, "area multiplication"], [area, "area comparison"],
    [semanticOrientationAnd, "semantic/orientation conjunction"], [areaAnd, "area conjunction"],
  ]) followup2ExpectSupported(observed, syntax, `D19 positive filter ${label} stays untainted`);
  for (const [related, value] of [[semantic, "semantic"], [orientation, "orientation"], [area, "area"]]) {
    followup2ExpectKernelFact(observed, {
      kind: "same_element", subject: filterCall, owner: root, related, value,
    }, `same_element ${value}`);
  }
  const attackFilter = followup2KernelCall("filter", "or-attack-marker");
  const attackLambda = followup2KernelLambda("or-attack-marker");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: attackFilter, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D19 OR-separated attack still resolves the exact filter row");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: attackLambda, owner: attackFilter,
    related: followup2KernelArgument("or-attack-marker"), value: "collection_predicate",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D19 OR-separated attack executes the exact predicate callback");
  const attackedParameter = { kind: "parameter_decl", name: "attackedPlane", within: attackLambda };
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: attackedParameter, owner: attackLambda, related: load,
    value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D19 OR-separated attack retains one exact element origin");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: attackedParameter, owner: attackLambda, related: load,
    value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D19 OR-separated callback parameter retains its producer origin");
  for (const [syntax, label] of [
    [{ kind: "binary", value: "==", textIncludes: "SemanticLabelType.TABLE", within: attackLambda }, "semantic equality"],
    [{ kind: "binary", value: "==", textIncludes: "HORIZONTAL_UPWARD", within: attackLambda }, "orientation equality"],
    [{ kind: "binary", value: "*", within: attackLambda }, "area multiplication"],
    [{ kind: "binary", value: ">", within: attackLambda }, "area comparison"],
    [{ kind: "binary", value: "||", textIncludes: "HORIZONTAL_UPWARD", within: attackLambda, smallestSpan: true }, "first disjunction"],
    [{ kind: "binary", value: "||", textIncludes: "boundingBoxSize", within: attackLambda }, "outer disjunction"],
  ]) followup2ExpectSupported(observed, syntax, `D19 OR-separated ${label} stays untainted`);
  for (const dimension of ["semantic", "orientation", "area"]) followup2ExpectNoKernelFact(observed, {
    kind: "same_element", subject: attackFilter, value: dimension,
  }, `D19 OR-separated ${dimension} proof does not survive as a conjunction`);

  const mixedAreaFilter = followup2KernelCall("filter", "mixed-area-marker");
  const mixedAreaLambda = followup2KernelLambda("mixed-area-marker");
  const mixedAreaParameter = { kind: "parameter_decl", name: "mixedAreaPlane", within: mixedAreaLambda };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: mixedAreaFilter, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D19 mixed-origin area predicate still resolves the exact filter row");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: mixedAreaLambda, owner: mixedAreaFilter,
    related: followup2KernelArgument("mixed-area-marker"), value: "collection_predicate",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D19 mixed-origin area predicate executes its exact callback");
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: mixedAreaParameter, owner: mixedAreaLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D19 mixed-origin area predicate retains its exact element parameter");
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: mixedAreaParameter, owner: mixedAreaLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D19 mixed-origin area predicate retains its exact producer");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: mixedAreaParameter, owner: mixedAreaLambda,
    related: load, value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D19 mixed-origin area predicate retains its exact element origin");
  const mixedAreaBoundary = {
    kind: "binary", value: ">", textIncludes: "mixedAreaPlane.boundingBoxSize", within: mixedAreaLambda,
  };
  const mixedAreaProduct = { kind: "binary", value: "*", within: mixedAreaLambda };
  followup2ExpectSupported(observed, mixedAreaProduct,
    "D19 mixed-origin area multiplication is typed but identity-incompatible");
  followup2ExpectSupported(observed, mixedAreaBoundary,
    "D19 mixed-origin area comparison is typed but identity-incompatible");
  followup2ExpectKernelFact(observed, {
    kind: "callback_result", subject: mixedAreaLambda, owner: mixedAreaFilter,
    related: mixedAreaBoundary, value: "boolean", symbol: FOLLOWUP2_KERNEL_SYMBOLS.filter,
  }, "D19 mixed-origin area predicate still has a unique Boolean callback result");
  followup2ExpectNoKernelFact(observed, {
    kind: "same_element", subject: mixedAreaFilter, value: "area",
  }, "D19 one element operand plus a literal cannot prove same-element area");
  followup2ExpectNoKernelFact(observed, {
    kind: "dominates", related: mixedAreaBoundary, value: "area",
  }, "D19 mixed-origin area boundary cannot dominate a consumer");

  const constantSelector = followup2KernelCall("maxByOrNull", "constant-selection-marker");
  const constantSelectorLambda = followup2KernelLambda("constant-selection-marker");
  const constantChoice = {
    kind: "parameter_decl", name: "constantChoice", within: constantSelectorLambda,
  };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: constantSelector, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.maxByOrNull,
  }, "H-F constant selector still resolves the exact maxByOrNull row");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: constantSelectorLambda, owner: constantSelector,
    related: followup2KernelArgument("constant-selection-marker"), value: "collection_selector",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.maxByOrNull,
  }, "H-F constant selector executes its exact callback");
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: constantChoice, owner: constantSelectorLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-F constant selector retains its exact element parameter");
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: constantChoice, owner: constantSelectorLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-F constant selector retains its exact element producer");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: constantChoice, owner: constantSelectorLambda,
    related: load, value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-F constant selector retains its exact element origin");
  followup2ExpectKernelFact(observed, {
    kind: "callback_result", subject: constantSelectorLambda, owner: constantSelector,
    related: { kind: "literal", text: "17", within: constantSelectorLambda }, value: "int",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.maxByOrNull,
  }, "H-F constant selector has a unique typed but unrelated callback result");
  followup2ExpectNoKernelFact(observed, {
    kind: "same_element", subject: constantSelector, value: "selection",
  }, "H-F constant selector cannot prove same-element selection");
  followup2ExpectNoKernelFact(observed, {
    kind: "return_origin", subject: constantSelector,
  }, "H-F constant selector grants no selected-element return provenance");
  const readiness = followup2KernelCall("isNotEmpty", "isNotEmpty()");
  const readinessBranch = { kind: "if", textIncludes: "selection-marker" };
  const readinessReceiver = {
    kind: "name_ref", name: "filtered",
    within: { kind: "qualified", text: "filtered.isNotEmpty()" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: readiness, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.isNotEmpty,
  }, "D11 exact positive readiness row");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: readiness, owner: root, related: null, value: "boolean",
  }, "D11 exact positive readiness result type");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: readiness, owner: root, related: readinessReceiver,
    value: "readiness", symbol: FOLLOWUP2_KERNEL_SYMBOLS.isNotEmpty,
  }, "D20 exact positive readiness effect");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: readiness, owner: readinessBranch, related: readinessReceiver,
    value: "readiness_positive",
  }, "D11 exact positive readiness");
  const selectorCall = { kind: "call", name: "maxByOrNull", within: readinessBranch };
  const selectorLambda = {
    kind: "lambda", textIncludes: '"selection-marker"', within: selectorCall, smallestSpan: true,
  };
  const choiceParameter = { kind: "parameter_decl", name: "choice", within: selectorLambda };
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: choiceParameter, owner: selectorLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "H-G selector element retains exact producer row");
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: choiceParameter, owner: selectorLambda,
    related: load, value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D16 selector element identity");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: choiceParameter, owner: selectorLambda, related: load,
    value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeLoad,
  }, "D16 selector element exact producer origin");
  const selectionBoundary = { kind: "binary", value: "*", within: selectorLambda };
  followup2ExpectSupported(observed, selectionBoundary,
    "D19 same-element selector multiplication stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "same_element", subject: selectorCall, owner: root, related: selectionBoundary, value: "selection",
  }, "same_element selection");
  const transform = { kind: "name_ref", name: "transform", within: { kind: "safe_qualified", text: "selected?.transform" } };
  for (const [related, value] of [
    [readiness, "control"], [semantic, "semantic"], [orientation, "horizontal"], [area, "area"],
  ]) {
    followup2ExpectKernelFact(observed, {
      kind: "dominates", subject: transform, owner: root, related, value,
    }, `dominates ${value}`);
  }
  followup2ExpectKernelFact(observed, {
    kind: "same_origin", subject: transform, owner: root, related: selectorCall, value: "pose",
  }, "same_origin selected plane pose");

  const entityLoop = { kind: "for", textIncludes: "entity-element-marker" };
  const entityParameter = { kind: "parameter_decl", name: "entity", within: entityLoop };
  const entitiesOrigin = { kind: "name_ref", name: "entities", within: entityLoop };
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: entityParameter, owner: entityLoop, related: entitiesOrigin,
    value: "entity", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialContentEntities,
  }, "D16 entity-collection element identity");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: entityParameter, owner: initial, related: null,
    value: "entity", symbol: FOLLOWUP2_KERNEL_SYMBOLS.entityType,
  }, "D16 entity loop parameter type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: entityParameter, owner: initial, related: entitiesOrigin,
    value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialContentEntities,
  }, "D16 entity loop parameter exact producer origin");
  const rangeLoop = { kind: "for", textIncludes: "range-element-marker" };
  const rangeParameter = { kind: "parameter_decl", name: "index", within: rangeLoop };
  const rangeOrigin = { kind: "binary", value: "until", within: rangeLoop };
  followup2ExpectSupported(observed, rangeOrigin,
    "D19 D16 loop-range until stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "loop_element", subject: rangeParameter, owner: rangeLoop, related: rangeOrigin,
    value: "int", symbol: FOLLOWUP2_KERNEL_SYMBOLS.until,
  }, "D16 integer-range element identity");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: rangeParameter, owner: root, related: null,
    value: "int",
  }, "D16 integer loop parameter type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: rangeParameter, owner: root, related: rangeOrigin,
    value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.until,
  }, "D16 integer loop parameter exact producer origin");

  const negativeIsEmpty = followup2KernelCall("isEmpty", "isEmpty()");
  const negativeReadinessBranch = { kind: "if", textIncludes: "negative-readiness-marker" };
  const negativeReadinessReceiver = {
    kind: "name_ref", name: "filtered",
    within: { kind: "qualified", text: "filtered.isEmpty()" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: negativeIsEmpty, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.isEmpty,
  }, "D11 exact negative readiness row");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: negativeIsEmpty, owner: root, related: null, value: "boolean",
  }, "D11 exact negative readiness result type");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: negativeIsEmpty, owner: root, related: negativeReadinessReceiver,
    value: "readiness", symbol: FOLLOWUP2_KERNEL_SYMBOLS.isEmpty,
  }, "D20 exact negative readiness effect");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: negativeIsEmpty, owner: negativeReadinessBranch, related: negativeReadinessReceiver,
    value: "readiness_negative",
  }, "D11 exact negative readiness");
  const sourceReadinessSpelling = { kind: "call", name: "isNotEmpty", text: "isNotEmpty(anchors)" };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: sourceReadinessSpelling, owner: root,
    related: followup2KernelFunction("isNotEmpty"), value: "source",
  }, "D11 readiness spelling impostor is independently source-resolved");
  followup2ExpectNoKernelFact(observed, {
    kind: "condition", subject: sourceReadinessSpelling,
  }, "D11 source spelling supplies no readiness");
  followup2ExpectNoKernelFact(observed, {
    kind: "effect", subject: sourceReadinessSpelling, value: "readiness",
  }, "D20 source spelling supplies no readiness effect");

  const openReview = followup2KernelCall("openReviewPanel", "review-panel");
  const openReviewQualified = { kind: "qualified", textIncludes: "review-panel" };
  followup2ExpectKernelFact(observed, {
    kind: "closed_member_absence", subject: openReview, owner: null,
    related: { kind: "name_ref", name: "navigator", within: openReviewQualified },
    value: "openReviewPanel", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorType,
  }, "H-K exact closed-member absence");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: openReview, owner: root,
    related: followup2KernelFunction("openReviewPanel"), value: "source",
  }, "H-K source extension after proved absence");
  const contentReview = followup2KernelCall("ownerReview", "content-review");
  const contentReviewQualified = { kind: "qualified", textIncludes: "content-review" };
  const contentOrigin = { kind: "name_ref", name: "initialContent", within: contentReviewQualified };
  followup2ExpectKernelFact(observed, {
    kind: "closed_member_absence", subject: contentReview, owner: null, related: contentOrigin,
    value: "ownerReview", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialContentType,
  }, "H-K SpatialViewContent closed-member absence");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: contentReview, owner: initial,
    related: followup2KernelFunction("ownerReview"), value: "source",
  }, "H-K SpatialViewContent source extension after proved absence");
  const extension = followup2KernelFunction("openReviewPanel");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: { kind: "type_ref", text: "SpatialNavigator", within: extension },
    owner: extension, related: null, value: "spatial_navigator", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorType,
  }, "D17 extension receiver TYPE span");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: { kind: "type_ref", text: "Bundle", within: extension },
    owner: extension, related: null, value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleType,
  }, "D17 extension return TYPE span");
  const closeStage = followup2KernelCall("closeStage", "closeStage()");
  domainResolution(closeStage, root, FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorCloseStage,
    "H-K SDK member precedence over source extension");
  followup2ExpectNoKernelFact(observed, {
    kind: "closed_member_absence", subject: closeStage,
  }, "H-K existing SDK member has no absence fact");
  followup2ExpectNoKernelFact(observed, {
    kind: "closed_member_absence", subject: followup2KernelCall("phantomBundle", "phantom-bundle"),
  }, "H-K sparse Bundle has no closed-member absence authority");

  for (const [selector, owner, taint, label] of [
    [followup2KernelCall("phantomBundle", "phantom-bundle"), root, "unknown_receiver", "sparse Bundle closure"],
    [{ kind: "name_ref", name: "bundle", within: followup2KernelFunction("ambiguousOwner") }, followup2KernelFunction("ambiguousOwner"), "ambiguous", "diamond owner path"],
    [{ kind: "name_ref", name: "entities", within: followup2KernelFunction("wrongPhysicalOwner") }, followup2KernelFunction("wrongPhysicalOwner"), "unknown_receiver", "same-semantic wrong physical owner"],
    [{ kind: "name_ref", name: "bundle", within: followup2KernelFunction("phantomDelegatedOwner") }, followup2KernelFunction("phantomDelegatedOwner"), "unknown_receiver", "phantom delegated owner"],
    [{ kind: "name_ref", name: "current", within: followup2KernelFunction("wrongCurrent") }, followup2KernelFunction("wrongCurrent"), "unknown_return", "wrong composition-local producer"],
    [{ kind: "call", name: "toList", within: followup2KernelFunction("genericArray") }, followup2KernelFunction("genericArray"), "unknown_receiver", "generic Array narrow edge"],
  ]) {
    followup2ExpectUnsupported(observed, selector, taint, owner, label);
  }
  const genericArrayOwner = followup2KernelFunction("genericArray");
  const genericArrayToList = { kind: "call", name: "toList", within: genericArrayOwner };
  const genericArrayFilter = followup2KernelCall("filter", "generic-array-marker");
  const genericArrayLambda = followup2KernelLambda("generic-array-marker");
  const genericArrayParameter = {
    kind: "parameter_decl", name: "item", within: genericArrayLambda,
  };
  followup2ExpectNoKernelFact(observed, {
    kind: "conformance", subject: genericArrayToList,
  }, "H-G generic Array projection grants no narrow compatibility");
  followup2ExpectNoKernelFact(observed, {
    kind: "return_origin", subject: genericArrayToList,
  }, "H-G generic Array projection preserves no Plane producer");
  followup2ExpectUnsupported(observed, genericArrayFilter, "unknown_receiver", genericArrayOwner,
    "H-G generic Array dependent filter has no compatible receiver");
  followup2ExpectNoKernelFact(observed, {
    kind: "callback_binding", subject: genericArrayLambda,
  }, "H-G generic Array dependent filter grants no callback binding");
  for (const kind of ["callback_parameter", "loop_element", "origin", "type"]) {
    followup2ExpectNoKernelFact(observed, { kind, subject: genericArrayParameter },
      `H-G generic Array dependent callback grants no ${kind}`);
  }
  followup2ExpectNoKernelFact(observed, {
    kind: "conformance",
    subject: { kind: "name_ref", name: "content", within: followup2KernelFunction("phantomDelegatedOwner") },
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialContainerScopeType,
  }, "D18 phantom owner grants no invented conformance");
  for (const [marker, owner, taint, label] of [
    ["generic-list-marker", followup2KernelFunction("genericList"), "unsupported", "generic List element"],
    ["empty-list-marker", root, "unsupported", "emptyList element"],
    ["wrong-producer-marker", root, "unsupported", "same-shaped source producer"],
    ["lost-producer-marker", root, "escape", "escaped producer identity"],
  ]) {
    const lambda = followup2KernelLambda(marker);
    const parameter = { kind: "parameter_decl", within: lambda };
    followup2ExpectUnsupported(observed, lambda, taint, owner, label, followup2KernelCall("filter", marker));
    followup2ExpectNoKernelFact(observed, { kind: "callback_parameter", subject: parameter }, `${label} no callback parameter fact`);
    followup2ExpectNoKernelFact(observed, { kind: "loop_element", subject: parameter }, `${label} no element fact`);
  }
  const producerEscape = followup2KernelCall("unknownEscape", "escaped");
  const escapedCollection = { kind: "property_decl", name: "escaped" };
  followup2ExpectUnsupported(observed, producerEscape, "escape", root,
    "D16 unknown call escapes producer identity");
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: producerEscape, owner: root, related: escapedCollection,
    value: "unknown_call",
  }, "D16 unknown call exact producer escape");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: followup2KernelCall("launch", "owner-mode-root"),
    owner: followup2KernelFunction("onCreate"), related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "D2 owner/collection negatives preserve production root");
}
function followup2AssertPhysicalReceiverMode(observed) {
  const root = followup2KernelLambda("receiver-root-marker");
  const cases = [
    ["disposable-one-marker", "DisposableEffect", FOLLOWUP2_KERNEL_SYMBOLS.disposableEffect1,
      "disposable_effect", FOLLOWUP2_KERNEL_SYMBOLS.disposableScopeType],
    ["disposable-two-marker", "DisposableEffect", FOLLOWUP2_KERNEL_SYMBOLS.disposableEffect2,
      "disposable_effect", FOLLOWUP2_KERNEL_SYMBOLS.disposableScopeType],
    ["disposable-three-marker", "DisposableEffect", FOLLOWUP2_KERNEL_SYMBOLS.disposableEffect3,
      "disposable_effect", FOLLOWUP2_KERNEL_SYMBOLS.disposableScopeType],
    ["disposable-vararg-marker", "DisposableEffect", FOLLOWUP2_KERNEL_SYMBOLS.disposableEffectVararg,
      "disposable_effect", FOLLOWUP2_KERNEL_SYMBOLS.disposableScopeType],
    ["launched-one-marker", "LaunchedEffect", FOLLOWUP2_KERNEL_SYMBOLS.launchedEffect1,
      "launched_effect", FOLLOWUP2_KERNEL_SYMBOLS.coroutineScopeType],
    ["launched-two-marker", "LaunchedEffect", FOLLOWUP2_KERNEL_SYMBOLS.launchedEffect2,
      "launched_effect", FOLLOWUP2_KERNEL_SYMBOLS.coroutineScopeType],
    ["launched-three-marker", "LaunchedEffect", FOLLOWUP2_KERNEL_SYMBOLS.launchedEffect3,
      "launched_effect", FOLLOWUP2_KERNEL_SYMBOLS.coroutineScopeType],
    ["launched-vararg-marker", "LaunchedEffect", FOLLOWUP2_KERNEL_SYMBOLS.launchedEffectVararg,
      "launched_effect", FOLLOWUP2_KERNEL_SYMBOLS.coroutineScopeType],
    ["button-receiver-marker", "Button", FOLLOWUP2_KERNEL_SYMBOLS.button,
      "window_content", FOLLOWUP2_KERNEL_SYMBOLS.rowScopeType],
    ["attachments-receiver-marker", "SpatialView", FOLLOWUP2_KERNEL_SYMBOLS.spatialView,
      "spatial_attachments", FOLLOWUP2_KERNEL_SYMBOLS.attachmentPanelBuilderType],
    ["window-receiver-marker", "DefaultWindowContainer", FOLLOWUP2_KERNEL_SYMBOLS.defaultWindow,
      "window_content", FOLLOWUP2_KERNEL_SYMBOLS.windowScopeType],
    ["stage-receiver-marker", "Stage", FOLLOWUP2_KERNEL_SYMBOLS.stage,
      "stage_content", FOLLOWUP2_KERNEL_SYMBOLS.stageScopeType],
    ["receiver-root-marker", "launch", FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
      "application_entry", FOLLOWUP2_KERNEL_SYMBOLS.spatialAppScopeType],
  ];
  for (const [marker, callName, callable, role, physicalType] of cases) {
    const call = followup2KernelCall(callName, marker);
    const callback = followup2KernelLambda(marker);
    followup2ExpectKernelFact(observed, {
      kind: "call_resolution", subject: call,
      owner: callName === "launch" ? followup2KernelFunction("onCreate") : root,
      related: null, value: "domain", symbol: callable,
    }, `H-L ${marker} exact callable key`);
    followup2ExpectKernelFact(observed, {
      kind: "callback_binding", subject: callback, owner: call,
      related: followup2KernelArgument(marker), value: role, symbol: callable,
    }, `H-L ${marker} exact callback position`);
    followup2ExpectKernelFact(observed, {
      kind: "callback_receiver", subject: callback, owner: call, related: null,
      value: physicalType === FOLLOWUP2_KERNEL_SYMBOLS.coroutineScopeType ? "coroutine_scope"
        : physicalType === FOLLOWUP2_KERNEL_SYMBOLS.disposableScopeType ? "disposable_effect_scope"
        : physicalType === FOLLOWUP2_KERNEL_SYMBOLS.rowScopeType ? "row_scope"
        : physicalType === FOLLOWUP2_KERNEL_SYMBOLS.attachmentPanelBuilderType ? "attachment_panel_builder"
        : physicalType === FOLLOWUP2_KERNEL_SYMBOLS.spatialAppScopeType ? "spatial_app_scope"
        : "spatial_container_scope",
      symbol: physicalType,
    }, `H-L ${marker} exact physical receiver`);
  }
}
function followup2AssertSourceMappingMode(observed) {
  const owner = followup2KernelFunction("sourceUse");
  const declaration = followup2KernelFunction("sourceMap");
  const call = followup2KernelCall("sourceMap", "source-callback-marker");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: call, owner, related: declaration, value: "source",
  }, "D8 source mapper resolution");
  for (const [marker, parameterName, position] of [
    ["source-first", "first", 0], ["source-callback-marker", "callback", 2],
  ]) {
    followup2ExpectKernelFact(observed, {
      kind: "argument_binding", subject: followup2KernelArgument(marker), owner: call,
      related: { kind: "parameter_decl", name: parameterName, within: declaration },
      value: String(position),
    }, `D8 source mapper ${parameterName}`);
  }
  const invalid = followup2KernelCall("invalidMap", "invalid-callback-marker");
  followup2ExpectUnsupported(observed, invalid, "unsupported", owner,
    "D8 source mapper cannot skip required parameter");
  followup2ExpectNoKernelFact(observed, {
    kind: "argument_binding", subject: followup2KernelArgument("invalid-callback-marker"),
  }, "D8 invalid source mapper binds nothing");
  const ambiguous = followup2KernelCall("ambiguousMap", "ambiguous-source-marker");
  followup2ExpectUnsupported(observed, ambiguous, "ambiguous", owner,
    "D8 ambiguous source callback position");
  followup2ExpectNoKernelFact(observed, {
    kind: "argument_binding", subject: followup2KernelArgument("ambiguous-source-marker"),
  }, "D8 ambiguous source mapper binds nothing");
  const varargDeclaration = followup2KernelFunction("sourceVararg");
  for (const [marker, keyMarkers] of [
    ["source-zero-vararg-marker", []],
    ["source-two-vararg-marker", ["source-vararg-a", "source-vararg-b"]],
  ]) {
    const varargCall = followup2KernelCall("sourceVararg", marker);
    followup2ExpectKernelFact(observed, {
      kind: "call_resolution", subject: varargCall, owner, related: varargDeclaration, value: "source",
    }, `D8 source ${keyMarkers.length}-value variadic resolution`);
    for (const keyMarker of keyMarkers) followup2ExpectKernelFact(observed, {
      kind: "argument_binding", subject: followup2KernelArgument(keyMarker), owner: varargCall,
      related: { kind: "parameter_decl", name: "keys", within: varargDeclaration }, value: "0",
    }, `D8 source variadic binding ${keyMarker}`);
    followup2ExpectKernelFact(observed, {
      kind: "argument_binding", subject: followup2KernelArgument(marker), owner: varargCall,
      related: { kind: "parameter_decl", name: "callback", within: varargDeclaration }, value: "1",
    }, `D8 source ${keyMarkers.length}-value trailing callback position`);
  }
}
function followup2AssertReturnsNullableMode(observed) {
  const root = followup2KernelLambda("returns-root-marker");
  const load = followup2KernelCall("loadAllAnchors", "loadAllAnchors()");
  const first = followup2KernelCall("firstOrNull", "firstOrNull()");
  const maximum = followup2KernelCall("maxByOrNull", "nullable-max-marker");
  for (const [propertyName, marker, label] of [
    ["rememberChoice", "remember-choice", "remember multiple-result selector"],
    ["chooseAlternate", "subscription-choice", "safe-call merge selector"],
  ]) {
    const property = { kind: "property_decl", name: propertyName };
    const call = { kind: "call", name: "getBoolean", within: property };
    const receiver = {
      kind: "name_ref", name: "decisionBundle", within: { kind: "qualified", textIncludes: marker },
    };
    followup2ExpectKernelFact(observed, {
      kind: "call_resolution", subject: call, owner: root, related: null,
      value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleGetBoolean,
    }, `H-F ${label} exact domain read`);
    followup2ExpectKernelFact(observed, {
      kind: "type", subject: call, owner: root, related: null, value: "boolean",
    }, `H-F ${label} value-unknown Boolean type`);
    followup2ExpectKernelFact(observed, {
      kind: "effect", subject: call, owner: root, related: receiver,
      value: "read", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleGetBoolean,
    }, `H-F ${label} exact read effect`);
  }
  for (const [subject, owner, symbol, label] of [
    [first, root, FOLLOWUP2_KERNEL_SYMBOLS.firstOrNull, "firstOrNull"],
    [maximum, root, FOLLOWUP2_KERNEL_SYMBOLS.maxByOrNull, "maxByOrNull"],
  ]) {
    followup2ExpectKernelFact(observed, {
      kind: "nullable", subject, owner, related: null, value: "true", symbol,
    }, `D14 exact ${label} nullable result key`);
    followup2ExpectKernelFact(observed, {
      kind: "return_origin", subject, owner, related: load,
      value: "plane_anchor", symbol,
    }, `H-F exact ${label} element-of-receiver origin`);
    followup2ExpectKernelFact(observed, {
      kind: "type", subject, owner, related: null,
      value: "plane_anchor", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeAnchorType,
    }, `H-F exact ${label} result type`);
  }

  const applyCall = followup2KernelCall("apply", "apply-value");
  const applyReceiver = { kind: "call", name: "Bundle", within: { kind: "qualified", textIncludes: "apply-value" } };
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: applyCall, owner: root, related: applyReceiver,
    value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.apply,
  }, "H-F equal-receiver apply passthrough");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: applyCall, owner: root, related: applyReceiver,
    value: "derived", symbol: FOLLOWUP2_KERNEL_SYMBOLS.apply,
  }, "H-F apply retains receiver identity");

  const rememberCall = followup2KernelCall("remember", "remember-result-marker");
  const rememberLambda = followup2KernelLambda("remember-result-marker");
  const rememberedBundle = { kind: "call", name: "Bundle", within: rememberLambda };
  followup2ExpectKernelFact(observed, {
    kind: "callback_result", subject: rememberLambda, owner: rememberCall, related: rememberedBundle,
    value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.remember0,
  }, "H-F sole remember callback result");
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: rememberCall, owner: root, related: rememberedBundle,
    value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.remember0,
  }, "H-F remember passthrough origin");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: rememberCall, owner: root, related: rememberedBundle,
    value: "retained", symbol: FOLLOWUP2_KERNEL_SYMBOLS.remember0,
  }, "H-F remember retained result");
  followup2ExpectNoKernelFact(observed, {
    kind: "strong_authority", subject: rememberCall,
  }, "H-F remember alone is not strong authority");
  followup2ExpectUnsupported(observed, followup2KernelCall("remember", "bad-remember-marker"),
    "unknown_return", root, "H-F missing callback-result passthrough");

  const componentProperty = { kind: "property_decl", name: "component" };
  const index = { kind: "index_access", within: componentProperty };
  const entityConstruction = { kind: "call", name: "Entity", within: { kind: "property_decl", name: "entity" } };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: entityConstruction, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.entityConstructor,
  }, "H-F exact component-store owner construction");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: entityConstruction, owner: root, related: null,
    value: "entity", symbol: FOLLOWUP2_KERNEL_SYMBOLS.entityType,
  }, "H-F exact component-store owner physical type");
  const componentStoreQualified = { kind: "qualified", text: "entity.components", within: index };
  const componentStore = { kind: "name_ref", name: "components", within: componentStoreQualified };
  const componentStoreReceiver = { kind: "name_ref", name: "entity", within: componentStoreQualified };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: componentStore, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.entityComponents,
  }, "H-F exact component-store property row");
  followup2ExpectSupported(observed, componentStore, "H-F exact component-store property stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: componentStore, owner: root, related: null,
    value: "component_store", symbol: FOLLOWUP2_KERNEL_SYMBOLS.componentSetType,
  }, "H-F exact component-store physical result");
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: componentStore, owner: root, related: componentStoreReceiver,
    value: "component_store", symbol: FOLLOWUP2_KERNEL_SYMBOLS.entityComponents,
  }, "H-F exact component-store returned origin");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: componentStore, owner: root, related: componentStoreReceiver,
    value: "read", symbol: FOLLOWUP2_KERNEL_SYMBOLS.entityComponents,
  }, "D20 exact component-store read effect");
  followup2ExpectKernelFact(observed, {
    kind: "read", subject: componentStore, owner: root, related: componentStoreReceiver,
    value: "", symbol: FOLLOWUP2_KERNEL_SYMBOLS.entityComponents,
  }, "D21 exact component-store read capability");
  const classToken = { kind: "qualified", text: "TransformComponent::class.java", within: index };
  const classLiteral = { kind: "class_literal", within: classToken };
  const classType = { kind: "name_ref", name: "TransformComponent", within: classLiteral };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: classToken, owner: root, related: null, value: "class_token",
  }, "H-H atomic class token");
  followup2ExpectSupported(observed, classToken, "H-H atomic class token stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: classToken, owner: root, related: null, value: "java_class",
  }, "H-H atomic class-token result type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: classToken, owner: root, related: classType, value: "class_token",
  }, "H-H atomic class-token origin");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: index, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.componentSetGet,
  }, "H-H exact index-get row");
  followup2ExpectSupported(observed, index, "H-H exact index-get stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: index, owner: root, related: classToken,
    value: "transform_component", symbol: FOLLOWUP2_KERNEL_SYMBOLS.componentSetGet,
  }, "H-F class-of-argument lookup origin");
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: index, owner: root, related: null,
    value: "true", symbol: FOLLOWUP2_KERNEL_SYMBOLS.componentSetGet,
  }, "D14 exact component-get nullable result key");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: index, owner: root, related: null,
    value: "transform_component", symbol: FOLLOWUP2_KERNEL_SYMBOLS.transformComponentType,
  }, "H-F class-of-argument lookup type");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: index, owner: root,
    related: { kind: "property_decl", name: "component" }, value: "index",
  }, "D15 index uses nearest existing witness owner");

  const stage = followup2KernelLambda("nullable-stage-marker");
  const bundle = { kind: "name_ref", name: "bundle", within: stage };
  const getString = followup2KernelCall("getString", "safe-string-key");
  const getStringSafe = { kind: "safe_qualified", text: "stageBundle?.getString(\"safe-string-key\")" };
  const stageBundleReceiver = { kind: "name_ref", name: "stageBundle", within: getStringSafe };
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: bundle, owner: stage, related: null,
    value: "true", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialContainerBundle,
  }, "D14 exact bundle property nullable result key");
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: getString, owner: stage, related: null,
    value: "true", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleGetString,
  }, "D14 exact Bundle.getString nullable result key");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: getStringSafe, owner: getStringSafe,
    related: stageBundleReceiver, value: "nonnull",
  }, "D14 bundle safe-call nonnull branch");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: getString, owner: stage,
    related: stageBundleReceiver,
    value: "read", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleGetString,
  }, "D14 safe getString conditional read");
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: getStringSafe, owner: stage, related: getString,
    value: "true",
  }, "D14 inner safe getString nullable merge");
  followup2ExpectKernelFact(observed, {
    kind: "dominates", subject: getString, owner: stage, related: getStringSafe, value: "control",
  }, "D14 inner safe branch dominates getString effect");
  const outerSafe = { kind: "safe_qualified", textIncludes: "safe-let-marker", smallestSpan: true };
  const safeLet = followup2KernelCall("let", "safe-let-marker");
  const safeLetLambda = followup2KernelLambda("safe-let-marker");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: outerSafe, owner: outerSafe, related: getStringSafe, value: "nonnull",
  }, "D14 outer safe let nonnull branch");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: safeLet, owner: stage, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D14 chained safe let resolution");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: safeLetLambda, owner: safeLet,
    related: followup2KernelArgument("safe-let-marker"), value: "inline_block",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D14 chained safe let callback binding");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: safeLetLambda, owner: stage, related: safeLet,
    value: "inline_block", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D14 chained safe let callback promotion");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: safeLetLambda, owner: safeLetLambda, related: safeLet,
    value: "immediate_inline",
  }, "D14 chained safe let callback execution");
  const safeText = { kind: "name_ref", name: "text", within: safeLetLambda };
  followup2ExpectKernelFact(observed, {
    kind: "callback_parameter", subject: { kind: "parameter_decl", name: "text", within: safeLetLambda },
    owner: safeLetLambda, related: getStringSafe, value: "string", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D14 chained safe let parameter origin");
  followup2ExpectKernelFact(observed, {
    kind: "callback_result", subject: safeLetLambda, owner: safeLet, related: safeText,
    value: "string", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D14 chained safe let callback result");
  followup2ExpectKernelFact(observed, {
    kind: "return_origin", subject: safeLet, owner: stage, related: safeText,
    value: "string", symbol: FOLLOWUP2_KERNEL_SYMBOLS.let,
  }, "D14 chained safe let return origin");
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: outerSafe, owner: stage, related: safeLet, value: "true",
  }, "D14 outer safe let nullable merge");
  followup2ExpectKernelFact(observed, {
    kind: "dominates", subject: safeLet, owner: stage, related: outerSafe, value: "control",
  }, "D14 outer safe branch dominates let execution");
  const safeChainJoin = { kind: "string_template", text: '"safe-chain-join-marker"', within: stage };
  const safeEdge = (subject, related, value, label) => followup2ExpectKernelFact(observed, {
    kind: "cfg_edge", subject, owner: stage, related, value,
  }, label);
  safeEdge(stageBundleReceiver, getString, "true",
    "D14 inner safe nonnull branch enters getString");
  safeEdge(stageBundleReceiver, getStringSafe, "false",
    "D14 inner safe null branch reaches its composite merge");
  safeEdge(getString, getStringSafe, "fallthrough",
    "D14 inner selector completion reaches its composite merge");
  safeEdge(getStringSafe, safeLet, "true",
    "D14 outer safe nonnull branch enters let");
  safeEdge(getStringSafe, safeChainJoin, "false",
    "D14 outer safe null branch skips let");
  safeEdge(safeLet, safeChainJoin, "fallthrough",
    "D14 outer selector completion reaches the shared continuation");
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: stageBundleReceiver, related: safeLet, value: "false",
  }, "D14 inner null path cannot enter the outer selector");

  const message = { kind: "name_ref", name: "message", within: { kind: "catch", textIncludes: "throwable-message-marker" } };
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: message, owner: root, related: null,
    value: "true", symbol: FOLLOWUP2_KERNEL_SYMBOLS.throwableMessage,
  }, "D14 exact Throwable.message nullable result key");

  const safeCancel = { kind: "safe_qualified", text: "subscription?.cancel()" };
  const cancelCall = { kind: "call", name: "cancel", within: safeCancel };
  const cancelReceiver = { kind: "name_ref", name: "subscription", within: safeCancel };
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: safeCancel, owner: safeCancel, related: cancelReceiver, value: "nonnull",
  }, "D14 nullable cancellation nonnull branch");
  const subscriptionProperty = { kind: "property_decl", name: "subscription" };
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: subscriptionProperty, owner: root,
    related: { kind: "type_ref", text: "Cancellable?", within: subscriptionProperty }, value: "true",
  }, "D14 safe cancellation receiver derives from explicit nullable source type");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: cancelCall, owner: root, related: cancelReceiver,
    value: "release", symbol: FOLLOWUP2_KERNEL_SYMBOLS.cancellableCancel,
  }, "D14 nullable cancellation conditional release");
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: safeCancel, owner: root, related: cancelCall,
    value: "true",
  }, "D14 safe cancellation nullable merge");
  followup2ExpectKernelFact(observed, {
    kind: "dominates", subject: cancelCall, owner: root, related: safeCancel, value: "control",
  }, "D14 safe cancellation effect is conditionally dominated");

  const sourceSafe = { kind: "safe_qualified", text: "selection?.id" };
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: sourceSafe, owner: sourceSafe,
    related: { kind: "name_ref", name: "selection", within: sourceSafe }, value: "nonnull",
  }, "D14 source property safe-call branch");
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: sourceSafe, owner: root,
    related: { kind: "name_ref", name: "id", within: sourceSafe }, value: "true",
  }, "D14 source property nullable merge");
  followup2ExpectKernelFact(observed, {
    kind: "nullable", subject: { kind: "property_decl", name: "selection" }, owner: root,
    related: { kind: "type_ref", text: "Selection?" }, value: "true",
  }, "D14 explicit nullable source target");

  for (const [callName, marker, symbol] of [
    ["convertPositionFrom", "position-null-marker", FOLLOWUP2_KERNEL_SYMBOLS.entityConvertPosition],
    ["convertRotationFrom", "rotation-null-marker", FOLLOWUP2_KERNEL_SYMBOLS.entityConvertRotation],
  ]) {
    const call = followup2KernelCall(callName, marker);
    const nullArgument = { kind: "argument", name: "baseEntity", within: call };
    const nullLiteral = { kind: "literal", text: "null", within: nullArgument };
    followup2ExpectKernelFact(observed, {
      kind: "argument_binding", subject: nullArgument, owner: call, related: null,
      value: "1", symbol,
    }, `D14 exact ${callName} null row-position`);
    followup2ExpectKernelFact(observed, {
      kind: "nullable", subject: nullLiteral, owner: root, related: nullArgument,
      value: "true", symbol,
    }, `D14 ${callName} null literal`);
    followup2ExpectNoKernelFact(observed, {
      kind: "origin", subject: nullLiteral,
    }, `D14 ${callName} null creates no origin`);
  }

  followup2ExpectUnsupported(observed, followup2KernelCall("addChild", "wrong-null-marker"),
    "unsupported", root, "D14 wrong SDK null row");
  followup2ExpectUnsupported(observed, followup2KernelCall("convertPositionFrom", "wrong-position-null-marker"),
    "unsupported", root, "D14 null at wrong physical position on allowlisted row");
  const ordinary = { kind: "call", name: "cancel", within: { kind: "qualified", text: "subscription.cancel()" } };
  followup2ExpectUnsupported(observed, ordinary, "unknown_receiver", root,
    "D14 ordinary nullable qualification");
  const nonnullableSafe = { kind: "safe_qualified", text: "definite?.cancel()" };
  followup2ExpectUnsupported(observed, nonnullableSafe, "unknown_receiver", root,
    "D14 nonnullable safe receiver", { kind: "call", name: "cancel", within: nonnullableSafe });
  const ambiguousSafe = { kind: "safe_qualified", text: "ambiguousSubscription?.cancel()" };
  const ambiguousCancel = { kind: "call", name: "cancel", within: ambiguousSafe };
  followup2ExpectUnsupported(observed, ambiguousSafe, "ambiguous", root,
    "D14 ambiguous safe receiver", ambiguousCancel);
  followup2ExpectNoKernelFact(observed, {
    kind: "effect", subject: ambiguousCancel,
  }, "D14 ambiguous safe receiver grants no conditional effect");
  followup2ExpectNoKernelFact(observed, {
    kind: "condition", subject: ambiguousSafe,
  }, "D14 ambiguous safe receiver grants no branch condition");

  followup2ExpectUnsupported(observed, followup2KernelCall("apply", "mismatched-apply-marker"),
    "unknown_receiver", root, "H-F mismatched equal-receiver passthrough");
  for (const [marker, taint, label] of [
    ["multiple-remember-marker", "ambiguous", "multiple callback results"],
    ["escaped-remember-marker", "escape", "escaped callback result"],
  ]) {
    const call = followup2KernelCall("remember", marker);
    followup2ExpectUnsupported(observed, call, taint, root, `H-F ${label}`);
    followup2ExpectNoKernelFact(observed, {
      kind: "return_origin", subject: call,
    }, `H-F ${label} has no passthrough origin`);
    followup2ExpectNoKernelFact(observed, {
      kind: "origin", subject: call, value: "retained",
    }, `H-F ${label} has no retained origin`);
  }
  const escapedRememberLambda = followup2KernelLambda("escaped-remember-marker");
  const escapedRememberCall = followup2KernelCall("missingRememberEscape");
  followup2ExpectUnsupported(observed, escapedRememberCall, "escape", escapedRememberLambda,
    "H-F remember result crosses an unknown call");
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: escapedRememberCall, owner: escapedRememberLambda,
    related: { kind: "property_decl", name: "escapedRemember", within: escapedRememberLambda },
    value: "unknown_call",
  }, "H-F escaped remember exact origin escape");

  const wrongLookup = {
    kind: "index_access", within: { kind: "property_decl", name: "wrongComponent" },
  };
  followup2ExpectUnsupported(observed, wrongLookup, "unknown_return", root,
    "H-F mismatched class-of-argument source");
  followup2ExpectNoKernelFact(observed, {
    kind: "return_origin", subject: wrongLookup,
  }, "H-F mismatched class token has no store origin");
  const multipleLookup = { kind: "index_access", textIncludes: "multiple-class-source" };
  followup2ExpectUnsupported(observed, multipleLookup, "unsupported", root,
    "H-F multiple class-of-argument sources");
  const escapedLookup = { kind: "index_access", text: "entity.components[escapedToken]" };
  const tokenEscape = followup2KernelCall("missingTokenEscape");
  followup2ExpectUnsupported(observed, tokenEscape, "escape", root,
    "H-F class token crosses an unknown call");
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: tokenEscape, owner: root,
    related: { kind: "property_decl", name: "escapedToken" }, value: "unknown_call",
  }, "H-F escaped class token exact escape boundary");
  followup2ExpectUnsupported(observed, escapedLookup, "escape", root,
    "H-F escaped class-of-argument source");
  followup2ExpectNoKernelFact(observed, {
    kind: "return_origin", subject: escapedLookup,
  }, "H-F escaped class token has no store origin");
  followup2ExpectNoKernelFact(observed, {
    kind: "nullable", subject: followup2KernelCall("fakeGetString", "wrong-nullable-key"),
  }, "D14 same-shaped source result has no SDK nullability");
  followup2ExpectUnsupported(observed, followup2KernelCall("fakeGetString", "wrong-nullable-key"),
    "unknown_receiver", root, "D14 same-shaped sparse extension result");
  const sourceSpelling = followup2KernelCall("getString", "wrong-nullable-spelling");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: sourceSpelling, owner: root,
    related: followup2KernelFunction("getString"), value: "source",
  }, "D14 resolvable source spelling impostor");
  followup2ExpectNoKernelFact(observed, {
    kind: "nullable", subject: sourceSpelling,
  }, "D14 source spelling impostor has no SDK nullability");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: followup2KernelCall("launch", "returns-root-marker"),
    owner: followup2KernelFunction("onCreate"), related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "D2 nullable negatives preserve production launch");
}
function followup2AssertAuthorityEffectsMode(observed) {
  const root = followup2KernelLambda("effects-positive-root");
  const exactEffect = (subject, related, value, symbol, label, owner = root) => followup2ExpectKernelFact(observed, {
    kind: "effect", subject, owner, related, value, symbol,
  }, label);
  const exactPair = (acquire, release, owner, family, acquireSymbol, releaseSymbol, label) => {
    followup2ExpectKernelFact(observed, {
      kind: "paired_effect", subject: acquire, owner, related: release, value: family, symbol: acquireSymbol,
    }, `${label} acquisition pair`);
    followup2ExpectKernelFact(observed, {
      kind: "paired_effect", subject: release, owner, related: acquire, value: family, symbol: releaseSymbol,
    }, `${label} release pair`);
    followup2ExpectKernelFact(observed, {
      kind: "same_origin", subject: acquire, owner, related: release, value: "resource",
    }, `${label} acquisition resource identity`);
    followup2ExpectKernelFact(observed, {
      kind: "same_origin", subject: release, owner, related: acquire, value: "resource",
    }, `${label} release resource identity`);
  };

  const register = followup2KernelCall("registerSystem", "LifecycleSystem");
  const unregister = followup2KernelCall("unregisterSystem", "LifecycleSystem");
  exactEffect(register, null, "acquire", FOLLOWUP2_KERNEL_SYMBOLS.registerSystem,
    "D20 register acquire effect");
  exactEffect(unregister, null, "release", FOLLOWUP2_KERNEL_SYMBOLS.unregisterSystem,
    "D20 unregister release effect");
  exactPair(register, unregister, root, "ecs_system_lifecycle",
    FOLLOWUP2_KERNEL_SYMBOLS.registerSystem, FOLLOWUP2_KERNEL_SYMBOLS.unregisterSystem,
    "D20 ECS lifecycle");

  const startQualified = { kind: "qualified", text: "tracker.start()" };
  const stopQualified = { kind: "qualified", text: "tracker.stop()" };
  const start = { kind: "call", name: "start", within: startQualified };
  const stop = { kind: "call", name: "stop", within: stopQualified };
  const startReceiver = { kind: "name_ref", name: "tracker", within: startQualified };
  const stopReceiver = { kind: "name_ref", name: "tracker", within: stopQualified };
  exactEffect(start, startReceiver, "acquire", FOLLOWUP2_KERNEL_SYMBOLS.planeStart,
    "D20 plane start effect");
  exactEffect(stop, stopReceiver, "release", FOLLOWUP2_KERNEL_SYMBOLS.planeStop,
    "D20 plane stop effect");
  exactPair(start, stop, root, "plane_tracking",
    FOLLOWUP2_KERNEL_SYMBOLS.planeStart, FOLLOWUP2_KERNEL_SYMBOLS.planeStop,
    "D20 plane tracking");

  const transformConstruction = {
    kind: "call", name: "TransformComponent",
    within: { kind: "property_decl", name: "transformComponent" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: transformConstruction, owner: root, related: null,
    value: "transform_component", symbol: FOLLOWUP2_KERNEL_SYMBOLS.transformComponentType,
  }, "H-E exact TransformComponent physical type");
  followup2ExpectKernelFact(observed, {
    kind: "conformance", subject: transformConstruction, owner: null, related: null,
    value: "component", symbol: FOLLOWUP2_KERNEL_SYMBOLS.componentType,
  }, "H-E exact TransformComponent to Component compatibility");

  const subscribe = followup2KernelCall("subscribeAnchorUpdate", "paired-subscription-marker");
  const cancelQualified = { kind: "qualified", text: "subscription.cancel()" };
  const cancel = { kind: "call", name: "cancel", within: cancelQualified };
  const manager = { kind: "name_ref", name: "PlaneTrackingManager", within: { kind: "qualified", textIncludes: "paired-subscription-marker" } };
  const handle = { kind: "name_ref", name: "subscription", within: cancelQualified };
  exactEffect(subscribe, manager, "acquire", FOLLOWUP2_KERNEL_SYMBOLS.planeSubscribe,
    "D20 cancellable acquire effect");
  exactEffect(cancel, handle, "release", FOLLOWUP2_KERNEL_SYMBOLS.cancellableCancel,
    "D20 cancellable release effect");
  exactPair(subscribe, cancel, root, "cancellable_resource",
    FOLLOWUP2_KERNEL_SYMBOLS.planeSubscribe, FOLLOWUP2_KERNEL_SYMBOLS.cancellableCancel,
    "D20 cancellable resource");

  const readAccess = { kind: "name_ref", name: "position", within: { kind: "property_decl", name: "positionRead" } };
  const readReceiver = { kind: "name_ref", name: "transformComponent", within: { kind: "property_decl", name: "positionRead" } };
  exactEffect(readAccess, readReceiver, "read", FOLLOWUP2_KERNEL_SYMBOLS.transformComponentPosition,
    "D20 property getter read");
  followup2ExpectKernelFact(observed, {
    kind: "read", subject: readAccess, owner: root, related: readReceiver,
    value: "", symbol: FOLLOWUP2_KERNEL_SYMBOLS.transformComponentPosition,
  }, "D20 getter read capability");
  followup2ExpectNoKernelFact(observed, {
    kind: "write", subject: readAccess,
  }, "D20 getter-only operation has no write");

  const setter = { kind: "assignment", text: "transformComponent.position = Vector3(x = 202f)" };
  const setterReceiver = { kind: "name_ref", name: "transformComponent", within: setter };
  exactEffect(setter, setterReceiver, "mutate", FOLLOWUP2_KERNEL_SYMBOLS.transformComponentPosition,
    "D20 property setter mutation");
  followup2ExpectKernelFact(observed, {
    kind: "write", subject: setter, owner: root, related: setterReceiver,
    value: "", symbol: FOLLOWUP2_KERNEL_SYMBOLS.transformComponentPosition,
  }, "D20 setter write capability");
  followup2ExpectNoKernelFact(observed, {
    kind: "read", subject: setter,
  }, "D20 setter-only operation has no read");

  const compound = { kind: "assignment", text: "transformComponent.position += Vector3(x = 303f)" };
  const compoundReceiver = { kind: "name_ref", name: "transformComponent", within: compound };
  followup2ExpectSupported(observed, compound, "D20 exact property += stays untainted");
  for (const value of ["read", "mutate"]) exactEffect(
    compound, compoundReceiver, value, FOLLOWUP2_KERNEL_SYMBOLS.transformComponentPosition,
    `D20 compound property ${value}`);
  followup2ExpectKernelFact(observed, {
    kind: "read", subject: compound, owner: root, related: compoundReceiver,
    value: "", symbol: FOLLOWUP2_KERNEL_SYMBOLS.transformComponentPosition,
  }, "D20 compound read capability");
  followup2ExpectKernelFact(observed, {
    kind: "write", subject: compound, owner: root, related: compoundReceiver,
    value: "", symbol: FOLLOWUP2_KERNEL_SYMBOLS.transformComponentPosition,
  }, "D20 compound write capability");

  const getterOnlyLambda = followup2KernelLambda("getter-only-marker");
  followup2ExpectUnsupported(observed, { kind: "assignment", textIncludes: "909f", within: getterOnlyLambda },
    "unknown_effect", getterOnlyLambda, "D20 getter-only property assignment");
  for (const name of ["acquireResource", "releaseResource"]) followup2ExpectNoKernelFact(observed, {
    kind: "effect", subject: followup2KernelCall(name),
  }, `D20 helper spelling ${name} has no effect`);
  followup2ExpectNoKernelFact(observed, {
    kind: "effect", subject: {
      kind: "call", name: "start", within: { kind: "qualified", text: "unreachableTracker.start()" },
    },
  }, "D4 unreachable exact domain body has no effect");

  const helperRoot = followup2KernelLambda("source-helper-root");
  const helperLaunch = followup2KernelCall("launch", "source-helper-root");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: helperRoot, owner: followup2KernelFunction("onCreate"),
    related: helperLaunch, value: "application_entry", symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "D22 source helper enclosing production callback");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: helperRoot, owner: helperRoot, related: helperLaunch, value: "source_root",
  }, "D22 source helper enclosing reachable callback");
  const helperCall = { kind: "call", name: "relayManager", within: helperRoot };
  const helperDeclaration = followup2KernelFunction("relayManager");
  const helperArgument = { kind: "argument", within: helperCall };
  const helperOrigin = { kind: "name_ref", name: "PlaneTrackingManager", within: helperArgument };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: helperCall, owner: helperRoot,
    related: helperDeclaration, value: "source",
  }, "D22 accepted source helper resolution");
  followup2ExpectKernelFact(observed, {
    kind: "argument_binding", subject: helperArgument, owner: helperCall,
    related: { kind: "parameter_decl", name: "manager", within: helperDeclaration }, value: "0",
  }, "D22 source helper exact argument flow");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: helperCall, owner: helperRoot, related: helperOrigin, value: "acquire",
  }, "D22 reachable accepted source body effect summary");
  const innerStartQualified = { kind: "qualified", text: "manager.start()", within: helperDeclaration };
  const innerStart = { kind: "call", name: "start", within: innerStartQualified };
  const innerManager = { kind: "name_ref", name: "manager", within: innerStartQualified };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: innerStart, owner: helperDeclaration,
    related: null, value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeStart,
  }, "D22 source summary derives from exact reachable body row");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: innerStart, owner: helperDeclaration, related: innerManager,
    value: "acquire", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeStart,
  }, "D22 source summary retains inner row effect and receiver flow");
  followup2ExpectNoKernelFact(observed, {
    kind: "effect", subject: {
      kind: "call", name: "relayManager", within: followup2KernelFunction("unreachableHelper"),
    },
  }, "D22 unreachable equivalent source helper has no effect summary");

  const wrongType = followup2KernelLambda("wrong-type-pair-marker");
  const wrongTypeAcquire = followup2KernelCall("registerSystem", "WrongAcquireSystem");
  const wrongTypeRelease = followup2KernelCall("unregisterSystem", "WrongReleaseSystem");
  exactEffect(wrongTypeAcquire, null, "acquire", FOLLOWUP2_KERNEL_SYMBOLS.registerSystem,
    "D20 wrong-type acquisition still resolves", wrongType);
  exactEffect(wrongTypeRelease, null, "release", FOLLOWUP2_KERNEL_SYMBOLS.unregisterSystem,
    "D20 wrong-type release still resolves", wrongType);
  for (const call of [wrongTypeAcquire, wrongTypeRelease]) followup2ExpectNoKernelFact(observed, {
    kind: "paired_effect", subject: call,
  }, "D20 wrong ECS type has no pair");
  for (const [subject, related] of [
    [wrongTypeAcquire, wrongTypeRelease], [wrongTypeRelease, wrongTypeAcquire],
  ]) followup2ExpectNoKernelFact(observed, {
    kind: "same_origin", subject, related, value: "resource",
  }, "D20 wrong ECS type has no resource identity relation");

  const wrongOrigin = followup2KernelLambda("wrong-origin-pair-marker");
  const firstOrigin = followup2KernelCall("subscribeAnchorUpdate", "first-wrong-origin");
  const secondOrigin = followup2KernelCall("subscribeAnchorUpdate", "second-wrong-origin");
  const secondCancelQualified = { kind: "qualified", text: "secondHandle.cancel()" };
  const secondCancel = { kind: "call", name: "cancel", within: secondCancelQualified };
  const secondHandle = { kind: "name_ref", name: "secondHandle", within: secondCancelQualified };
  for (const [call, marker, label] of [
    [firstOrigin, "first-wrong-origin", "first"],
    [secondOrigin, "second-wrong-origin", "second"],
  ]) exactEffect(call, {
    kind: "name_ref", name: "PlaneTrackingManager",
    within: { kind: "qualified", textIncludes: marker },
  }, "acquire", FOLLOWUP2_KERNEL_SYMBOLS.planeSubscribe,
  `D20 ${label} cancellable origin acquisition`, wrongOrigin);
  exactEffect(secondCancel, secondHandle, "release", FOLLOWUP2_KERNEL_SYMBOLS.cancellableCancel,
    "D20 second cancellable release", wrongOrigin);
  exactPair(secondOrigin, secondCancel, wrongOrigin, "cancellable_resource",
    FOLLOWUP2_KERNEL_SYMBOLS.planeSubscribe, FOLLOWUP2_KERNEL_SYMBOLS.cancellableCancel,
    "D20 exact second cancellable origin");
  followup2ExpectNoKernelFact(observed, {
    kind: "paired_effect", subject: firstOrigin, related: secondCancel,
  }, "D20 first origin does not pair to second cancel");
  followup2ExpectNoKernelFact(observed, {
    kind: "paired_effect", subject: secondCancel, related: firstOrigin,
  }, "D20 second cancel does not pair to first origin");
  for (const [subject, related] of [
    [firstOrigin, secondCancel], [secondCancel, firstOrigin],
  ]) followup2ExpectNoKernelFact(observed, {
    kind: "same_origin", subject, related, value: "resource",
  }, "D20 distinct Cancellable origins have no resource identity relation");

  const wrongFamily = followup2KernelLambda("wrong-family-pair-marker");
  const wrongFamilyAcquire = followup2KernelCall("registerSystem", "WrongFamilySystem");
  const wrongFamilyStopQualified = { kind: "qualified", text: "wrongFamilyTracker.stop()" };
  const wrongFamilyRelease = { kind: "call", name: "stop", within: wrongFamilyStopQualified };
  const wrongFamilyReceiver = { kind: "name_ref", name: "wrongFamilyTracker", within: wrongFamilyStopQualified };
  exactEffect(wrongFamilyAcquire, null, "acquire", FOLLOWUP2_KERNEL_SYMBOLS.registerSystem,
    "D20 wrong-family ECS acquisition still resolves", wrongFamily);
  exactEffect(wrongFamilyRelease, wrongFamilyReceiver, "release", FOLLOWUP2_KERNEL_SYMBOLS.planeStop,
    "D20 wrong-family plane release still resolves", wrongFamily);
  for (const call of [wrongFamilyAcquire, wrongFamilyRelease]) followup2ExpectNoKernelFact(observed, {
    kind: "paired_effect", subject: call,
  }, "D20 wrong effect family has no pair");
  for (const [subject, related] of [
    [wrongFamilyAcquire, wrongFamilyRelease], [wrongFamilyRelease, wrongFamilyAcquire],
  ]) followup2ExpectNoKernelFact(observed, {
    kind: "same_origin", subject, related, value: "resource",
  }, "D20 wrong effect family has no resource identity relation");

  const foreignReference = { kind: "name_ref", name: "foreignCleanup", within: followup2KernelCall("onDispose", "foreignCleanup") };
  const foreignDispose = followup2KernelCall("onDispose", "foreignCleanup");
  const innerAcquire = followup2KernelLambda("inner-acquisition-marker");
  followup2ExpectUnsupported(observed, foreignReference, "unsupported", innerAcquire,
    "D5 cleanup under different acquisition owner", foreignDispose);
  followup2ExpectNoKernelFact(observed, {
    kind: "reachable", subject: followup2KernelLambda("foreign-cleanup-marker"),
  }, "D5 foreign cleanup target never executes");
  const outerAcquire = followup2KernelLambda("outer-acquisition-marker");
  const innerAcquireCall = followup2KernelCall("DisposableEffect", "inner-acquisition-marker");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: innerAcquireCall, owner: outerAcquire, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.disposableEffect1,
  }, "D5 rejected foreign cleanup preserves inner acquisition resolution");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: innerAcquire, owner: innerAcquireCall,
    related: followup2KernelArgument("inner-acquisition-marker"), value: "disposable_effect",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.disposableEffect1,
  }, "D5 rejected foreign cleanup preserves inner acquisition callback");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: innerAcquire, owner: outerAcquire, related: innerAcquireCall,
    value: "disposable_effect", symbol: FOLLOWUP2_KERNEL_SYMBOLS.disposableEffect1,
  }, "D5 inner acquisition remains a promoted execution root");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: innerAcquire, owner: innerAcquire, related: innerAcquireCall,
    value: "acquire_path",
  }, "D5 inner acquisition remains actively reachable");
  for (const marker of ["outer-valid-cleanup", "inner-valid-cleanup"]) followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: followup2KernelLambda(marker), owner: followup2KernelLambda(marker),
    related: followup2KernelCall("onDispose", marker), value: "cleanup_path",
  }, `D5 ${marker} control cleanup`);

  const retainedGetter = { kind: "property_decl", name: "retainedGetter" };
  const retainedOrigin = { kind: "name_ref", name: "retainedBacking", within: retainedGetter };
  followup2ExpectKernelFact(observed, {
    kind: "strong_authority", subject: retainedGetter, owner: retainedGetter,
    related: retainedOrigin, value: "top_level",
  }, "D1 retained getter strong authority");
  for (const [name, owner, value] of [
    ["objectStrong", { kind: "object_decl", name: "AuthorityObject" }, "object"],
    ["companionStrong", { kind: "companion_decl" }, "companion"],
  ]) {
    const property = { kind: "property_decl", name };
    followup2ExpectKernelFact(observed, {
      kind: "strong_authority", subject: property, owner,
      related: { kind: "name_ref", name: "retainedBacking", within: property }, value,
    }, `D1 ${value} retained authority`);
  }
  for (const name of ["freshGetter", "mutatedFreshGetter"]) followup2ExpectNoKernelFact(observed, {
    kind: "strong_authority", subject: { kind: "property_decl", name },
  }, `D1 ${name} stays weak`);
  for (const [propertyName, label] of [
    ["freshGetter", "fresh expression getter"],
    ["mutatedFreshGetter", "fresh block getter"],
  ]) {
    const property = { kind: "property_decl", name: propertyName };
    const construction = { kind: "call", name: "Bundle", text: "Bundle()", within: property };
    followup2ExpectKernelFact(observed, {
      kind: "call_resolution", subject: construction, owner: null, related: null,
      value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleConstructor,
    }, `D1 ${label} exact construction`);
    followup2ExpectKernelFact(observed, {
      kind: "origin", subject: construction, owner: null, related: null,
      value: "fresh", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleConstructor,
    }, `D1 ${label} fresh origin`);
    followup2ExpectKernelFact(observed, {
      kind: "effect", subject: construction, owner: null, related: null,
      value: "construct", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleConstructor,
    }, `D1 ${label} construct effect`);
  }
  const mutatedProperty = { kind: "property_decl", name: "mutatedFreshGetter" };
  const freshMutationQualified = { kind: "qualified", textIncludes: "mutated-fresh-key", within: mutatedProperty };
  const freshMutation = { kind: "call", name: "putString", within: freshMutationQualified };
  const freshMutationReceiver = { kind: "name_ref", name: "fresh", within: freshMutationQualified };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: freshMutation, owner: null, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundlePutString,
  }, "D1 mutated fresh getter exact mutation row");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: freshMutation, owner: null, related: freshMutationReceiver,
    value: "mutate", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundlePutString,
  }, "D1 mutated fresh getter keeps construction weak after exact mutation");
  followup2ExpectUnsupported(observed, { kind: "property_decl", name: "ambiguousAccessor" },
    "ambiguous", null, "D1 multiple accessor bodies", { kind: "property_decl", name: "ambiguousAccessor" });
  followup2ExpectUnsupported(observed, { kind: "property_decl", name: "missingAccessor" },
    "unknown_return", null, "D1 missing accessor-region candidate",
    { kind: "property_decl", name: "missingAccessor" });
  for (const kind of ["origin", "effect", "read", "strong_authority"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: { kind: "property_decl", name: "missingAccessor" },
  }, `D1 missing accessor grants no optimistic ${kind}`);

  for (const [functionName, typeName, symbol] of [
    ["onCreate", "EffectRoot", FOLLOWUP2_KERNEL_SYMBOLS.applicationOnCreate],
    ["update", "LifecycleSystem", FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate],
    ["clone", "LifecycleComponent", FOLLOWUP2_KERNEL_SYMBOLS.componentClone],
  ]) {
    const type = { kind: "class_decl", name: typeName };
    const member = { kind: "function_decl", name: functionName, within: type };
    followup2ExpectKernelFact(observed, {
      kind: "override", subject: member, owner: type, related: null, value: "", symbol,
    }, `D25 exact ${typeName}.${functionName} domain override`);
    followup2ExpectKernelFact(observed, {
      kind: "production_root", subject: member, owner: type, related: null,
      value: "direct", symbol,
    }, `D2 exact ${typeName}.${functionName} direct root`);
    followup2ExpectKernelFact(observed, {
      kind: "reachable", subject: member, owner: member, related: null, value: "direct",
    }, `D4 exact ${typeName}.${functionName} direct reachability`);
  }
  const sourceChild = { kind: "class_decl", name: "SourceChild" };
  const sourceOverride = { kind: "function_decl", name: "replace", within: sourceChild };
  followup2ExpectKernelFact(observed, {
    kind: "override", subject: sourceOverride, owner: sourceChild,
    related: { kind: "function_decl", name: "replace", within: { kind: "class_decl", name: "SourceBase" } },
    value: "",
  }, "D25 source-backed override replacement");
  followup2ExpectNoKernelFact(observed, {
    kind: "production_root", subject: sourceOverride,
  }, "D2 unrelated valid source override is not a root");
  const sameSpellingClone = { kind: "function_decl", name: "clone", within: { kind: "class_decl", name: "QuatLike" } };
  followup2ExpectNoKernelFact(observed, {
    kind: "override", subject: sameSpellingClone,
  }, "D3 same-spelling source clone is not the exact canary slot");
  followup2ExpectNoKernelFact(observed, {
    kind: "production_root", subject: sameSpellingClone,
  }, "D3 same-spelling source clone is not a root");

  const dataObject = followup2KernelNode(observed, { kind: "object_decl", name: "MetadataObject" }, "D26 data object node");
  assert.equal(dataObject.flags.includes("data"), false, "D26 data object is OBJECT without DATA");
  const sealedInterface = followup2KernelNode(observed, { kind: "interface_decl", name: "MetadataSealed" }, "D26 sealed interface node");
  assert.equal(sealedInterface.flags.includes("sealed"), true, "D26 sealed interface keeps SEALED");
  followup2ExpectNoKernelFact(observed, {
    subject: { kind: "annotation", textIncludes: "metadata-annotation" },
  }, "D26 annotation adds no semantic fact");
}
function followup2AssertAliasAmbiguityMode(observed) {
  const aliasPath = { pathEndsWith: "/a_alias.kt" };
  const aliasOwner = { kind: "function_decl", name: "aliasUse", ...aliasPath };
  const aliasedQualified = { kind: "qualified", text: "Tracker.start()", ...aliasPath };
  const tracker = { kind: "name_ref", name: "Tracker", text: "Tracker", within: aliasedQualified };
  const aliasedStart = { kind: "call", name: "start", within: aliasedQualified };
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: tracker, owner: aliasOwner, related: null,
    value: "plane_tracking_manager", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeManagerType,
  }, "D24 alias-only exact target type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: tracker, owner: aliasOwner, related: null,
    value: "retained", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeManagerType,
  }, "D24 alias-only exact target origin");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: aliasedStart,
    owner: aliasOwner, related: null, value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeStart,
  }, "D24 aliased qualifier member resolution");
  followup2ExpectSupported(observed, aliasedStart, "D24 aliased target stays untainted");
  const originalQualified = { kind: "qualified", text: "PlaneTrackingManager.stop()", ...aliasPath };
  const originalQualifier = {
    kind: "name_ref", name: "PlaneTrackingManager", within: originalQualified,
  };
  const originalStop = { kind: "call", name: "stop", within: originalQualified };
  followup2ExpectUnsupported(observed, originalStop,
    "unknown_receiver", aliasOwner, "D24 original qualifier hidden by alias");
  for (const kind of ["type", "origin"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: originalQualifier,
  }, `D24 hidden original qualifier grants no ${kind}`);
  for (const kind of ["call_resolution", "implicit_receiver", "effect"]) {
    followup2ExpectNoKernelFact(observed, { kind, subject: originalStop },
      `D24 hidden original member grants no ${kind}`);
  }
}
function followup2AssertControlFlowMode(observed) {
  const flowType = { kind: "class_decl", name: "FlowSystem" };
  const owner = { kind: "function_decl", name: "update", within: flowType };
  const edge = (subject, related, value, label, edgeOwner = owner) => followup2ExpectKernelFact(observed, {
    kind: "cfg_edge", subject, owner: edgeOwner, related, value,
  }, label);
  const stringNode = (text, within = undefined) => ({
    kind: "string_template", text: `"${text}"`, ...(within === undefined ? {} : { within }),
  });
  for (const [rootType, rootOwner, label] of [
    [flowType, owner, "FlowSystem"],
    [{ kind: "class_decl", name: "ReturnLoopSystem" }, {
      kind: "function_decl", name: "update", within: { kind: "class_decl", name: "ReturnLoopSystem" },
    }, "ReturnLoopSystem"],
  ]) {
    followup2ExpectKernelFact(observed, {
      kind: "override", subject: rootOwner, owner: rootType, related: null, value: "",
      symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
    }, `D2 ${label} exact override`);
    followup2ExpectKernelFact(observed, {
      kind: "production_root", subject: rootOwner, owner: rootType, related: null, value: "direct",
      symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
    }, `D2 ${label} direct root`);
    followup2ExpectKernelFact(observed, {
      kind: "reachable", subject: rootOwner, owner: rootOwner, related: null, value: "direct",
    }, `D4 ${label} direct reachability`);
  }

  const sequenceA = stringNode("sequence-a");
  const sequenceB = stringNode("sequence-b");
  edge(sequenceA, sequenceB, "fallthrough", "CFG direct sequence fallthrough");

  const branch = { kind: "if", textIncludes: "if-then-marker" };
  const branchCondition = { kind: "name_ref", name: "flag", within: branch };
  const thenEntry = stringNode("if-then-marker", branch);
  const elseEntry = stringNode("if-else-marker", branch);
  const branchJoin = stringNode("if-join-marker");
  edge(branchCondition, thenEntry, "true", "CFG if true edge");
  edge(branchCondition, elseEntry, "false", "CFG if false edge");
  edge(thenEntry, branchJoin, "fallthrough", "CFG then exit join");
  edge(elseEntry, branchJoin, "fallthrough", "CFG else exit join");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: branch, owner, related: sequenceB, value: "branch",
  }, "CFG IF boundary branch reachability");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: branchJoin, owner, related: null, value: "direct",
  }, "CFG if multi-predecessor join sentinel");
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: branch, related: branchJoin,
  }, "CFG composite IF has no invented direct join edge");

  const noElse = { kind: "if", textIncludes: "no-else-then-marker" };
  const noElseCondition = { kind: "name_ref", name: "flag", within: noElse };
  const noElseThen = stringNode("no-else-then-marker", noElse);
  const noElseJoin = stringNode("no-else-join-marker");
  edge(noElseCondition, noElseThen, "true", "CFG no-else true edge");
  edge(noElseCondition, noElseJoin, "false", "CFG no-else false-to-join");
  edge(noElseThen, noElseJoin, "fallthrough", "CFG no-else body-to-join");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: noElseJoin, owner, related: null, value: "direct",
  }, "CFG no-else multi-predecessor join sentinel");

  const choice = { kind: "when", textIncludes: "when-else-marker" };
  const choiceSubject = { kind: "name_ref", name: "selector", within: choice };
  const conditionOne = { kind: "literal", text: "1", within: choice };
  const conditionTwo = { kind: "literal", text: "2", within: choice };
  const elseBoundary = { kind: "when_entry", textIncludes: "when-else-marker" };
  const bodyOne = stringNode("when-one-marker", choice);
  const bodyTwo = stringNode("when-two-marker", choice);
  const bodyElse = stringNode("when-else-marker", choice);
  const whenJoin = stringNode("when-join-marker");
  edge(choiceSubject, conditionOne, "fallthrough", "CFG when subject evaluation");
  edge(conditionOne, bodyOne, "true", "CFG when first true");
  edge(conditionOne, conditionTwo, "false", "CFG when first false chain");
  edge(conditionTwo, bodyTwo, "true", "CFG when second true");
  edge(conditionTwo, elseBoundary, "false", "CFG when second false chain");
  edge(elseBoundary, bodyElse, "true", "CFG when else true edge");
  for (const [exit, label] of [[bodyOne, "first"], [bodyTwo, "second"], [bodyElse, "else"]]) {
    edge(exit, whenJoin, "fallthrough", `CFG when ${label} join`);
  }
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: choice, owner, related: noElseJoin, value: "branch",
  }, "CFG WHEN boundary branch reachability");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: whenJoin, owner, related: null, value: "direct",
  }, "CFG when multi-predecessor join sentinel");
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: choice, related: whenJoin,
  }, "CFG composite WHEN has no invented direct join edge");

  const elvisProperty = { kind: "property_decl", name: "elvisValue" };
  const elvis = { kind: "binary", value: "?:", within: elvisProperty };
  const elvisLeft = { kind: "name_ref", name: "nullable", within: elvis };
  const elvisRight = stringNode("elvis-right-marker", elvis);
  const elvisJoin = stringNode("elvis-join-marker");
  edge(elvisLeft, elvisJoin, "true", "CFG Elvis nonnull-to-continuation");
  edge(elvisLeft, elvisRight, "false", "CFG Elvis null-to-right");
  edge(elvisRight, elvisJoin, "fallthrough", "CFG Elvis right-to-continuation");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: elvis, owner, related: elvisProperty, value: "elvis",
  }, "D15 Elvis nearest declaration witness");
  followup2ExpectSupported(observed, elvis, "CFG exact Elvis boundary stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: elvisJoin, owner, related: null, value: "direct",
  }, "CFG Elvis multi-predecessor join sentinel");

  const attempt = { kind: "try", textIncludes: "finally-body-marker" };
  const tryBody = stringNode("try-body-marker", attempt);
  const firstCatch = { kind: "catch", textIncludes: "catch-one-marker" };
  const secondCatch = { kind: "catch", textIncludes: "catch-two-marker" };
  const catchOneBody = stringNode("catch-one-marker", firstCatch);
  const catchTwoBody = stringNode("catch-two-marker", secondCatch);
  const finallyBlock = {
    kind: "block", textIncludes: "finally-body-marker", within: attempt, smallestSpan: true,
  };
  const finallyBody = stringNode("finally-body-marker", finallyBlock);
  const tryJoin = stringNode("try-join-marker");
  edge(tryBody, finallyBlock, "finally", "CFG try normal exit enters structural finally block");
  edge(tryBody, firstCatch, "catch", "CFG conservative first catch dispatch");
  edge(firstCatch, catchOneBody, "true", "CFG first catch body");
  edge(firstCatch, secondCatch, "false", "CFG chained catch false edge");
  edge(secondCatch, catchTwoBody, "true", "CFG second catch body");
  edge(catchOneBody, finallyBlock, "finally", "CFG first catch enters structural finally block");
  edge(catchTwoBody, finallyBlock, "finally", "CFG second catch enters structural finally block");
  edge(finallyBody, tryJoin, "fallthrough", "CFG finally single continuation");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: finallyBlock, owner, related: null, value: "direct",
  }, "CFG finally multi-predecessor join sentinel");
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: attempt, related: tryJoin,
  }, "CFG composite TRY has no invented direct join edge");

  const plainAttempt = { kind: "try", textIncludes: "plain-try-marker" };
  const plainBody = stringNode("plain-try-marker", plainAttempt);
  const plainCatch = { kind: "catch", textIncludes: "plain-catch-marker" };
  const plainCatchBody = stringNode("plain-catch-marker", plainCatch);
  const plainJoin = stringNode("plain-try-join-marker");
  edge(plainBody, plainJoin, "fallthrough", "CFG plain try normal continuation");
  edge(plainBody, plainCatch, "catch", "CFG plain try catch dispatch");
  edge(plainCatch, plainCatchBody, "true", "CFG plain catch body");
  edge(plainCatchBody, plainJoin, "fallthrough", "CFG plain catch continuation");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: plainJoin, owner, related: null, value: "direct",
  }, "CFG plain try multi-predecessor join sentinel");

  for (const [functionName, marker] of [
    ["abruptFinally", "abrupt-finally-marker"], ["throwFinally", "throw-finally-marker"],
  ]) {
    const functionOwner = followup2KernelFunction(functionName);
    const rejectedTry = { kind: "try", textIncludes: marker };
    followup2ExpectUnsupported(observed, rejectedTry, "unknown_control", functionOwner,
      `CFG ${functionName} unsupported dependent try`);
  }
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: { kind: "return", within: { kind: "try", textIncludes: "abrupt-finally-marker" } },
    value: "return",
  }, "CFG return inside finally-protected try cannot bypass finally");
  const throwTry = { kind: "try", textIncludes: "throw-finally-marker" };
  const thrownConstruction = { kind: "call", name: "FlowFailure", within: throwTry };
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: thrownConstruction,
  }, "CFG explicit throw creates no optimistic catch/finally continuation");

  const forLoop = { kind: "for", textIncludes: "retainedForMarker" };
  const forRange = { kind: "binary", value: "until", within: forLoop };
  const forAssignment = { kind: "assignment", textIncludes: "retainedForMarker", within: forLoop };
  const forBreakBranch = { kind: "if", textIncludes: "forBreakCondition", within: forLoop };
  const forBreakCondition = { kind: "binary", value: "==", within: forBreakBranch };
  const realBreak = { kind: "break", within: forLoop };
  const forBodyEnd = stringNode("for-body-end-marker", forLoop);
  const forJoin = stringNode("for-join-marker");
  followup2ExpectSupported(observed, forRange, "CFG exact for-range until stays untainted");
  followup2ExpectSupported(observed, forBreakCondition,
    "CFG exact for-break equality stays untainted");
  edge(forRange, forAssignment, "true", "CFG for true edge");
  edge(forRange, forJoin, "false", "CFG for false exit");
  edge(forAssignment, forBreakCondition, "fallthrough", "CFG for body sequence");
  edge(forBreakCondition, realBreak, "true", "CFG for break condition true edge");
  edge(forBreakCondition, forBodyEnd, "false", "CFG for break condition false edge");
  edge(forBodyEnd, forRange, "loop", "CFG normal for body loops to range");
  edge(realBreak, forJoin, "break", "CFG real break exit");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: forLoop, owner,
    related: { kind: "property_decl", name: "forBreakCondition" }, value: "loop",
  }, "CFG FOR boundary loop reachability");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: forJoin, owner, related: null, value: "direct",
  }, "CFG FOR multi-predecessor exit join");
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: forLoop, related: forJoin,
  }, "CFG composite FOR has no invented direct join edge");
  followup2ExpectKernelFact(observed, {
    kind: "loop_success", subject: forLoop, owner, related: realBreak, value: "break",
  }, "D5 real break loop success");
  followup2ExpectKernelFact(observed, {
    kind: "retained_exit", subject: forAssignment, owner: forLoop, related: realBreak, value: "",
  }, "D5 retained assignment at real break");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: realBreak, owner, related: forLoop, value: "break",
  }, "D15 break nearest loop witness");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: forRange, owner, related: forLoop, value: "until",
  }, "D15 until nearest loop witness");

  const whileLoop = { kind: "while", textIncludes: "while-continue-marker" };
  const whileHead = { kind: "binary", value: "<", within: whileLoop };
  const whileEntry = stringNode("while-continue-marker", whileLoop);
  const continued = { kind: "continue", within: whileLoop };
  const whileJoin = stringNode("while-join-marker");
  edge(whileHead, whileEntry, "true", "CFG while true edge");
  edge(whileHead, whileJoin, "false", "CFG while false edge");
  const whileIncrement = { kind: "assignment", value: "+=", text: "continueCounter += 1" };
  followup2ExpectSupported(observed, whileHead,
    "CFG canonical while comparison stays untainted");
  followup2ExpectSupported(observed, whileIncrement,
    "CFG canonical while increment stays untainted");
  edge(whileEntry, whileIncrement, "fallthrough", "CFG while body enters canonical increment");
  edge(whileIncrement, continued, "fallthrough", "CFG canonical increment reaches continue");
  edge(continued, whileHead, "continue", "CFG continue to loop head");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: whileLoop, owner,
    related: { kind: "property_decl", name: "continueCounter" }, value: "loop",
  }, "CFG canonical WHILE boundary loop reachability");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: whileJoin, owner, related: whileHead, value: "direct",
  }, "CFG canonical WHILE exit reachability");
  followup2ExpectNoKernelFact(observed, {
    kind: "loop_success", subject: whileLoop,
  }, "D5 continue is not loop success");
  followup2ExpectNoKernelFact(observed, {
    kind: "retained_exit", subject: whileIncrement,
  }, "D5 continue-only loop cannot retain state at a success exit");

  const repeatCall = followup2KernelCall("repeat", "repeat-return-marker");
  const repeatLambda = followup2KernelLambda("repeat-return-marker");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: repeatCall, owner, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.repeat,
  }, "D5 exact repeat call resolution");
  followup2ExpectKernelFact(observed, {
    kind: "callback_binding", subject: repeatLambda, owner: repeatCall,
    related: followup2KernelArgument("repeat-return-marker"), value: "collection_element",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.repeat,
  }, "D5 exact repeat callback binding");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: repeatLambda, owner, related: repeatCall,
    value: "collection_element", symbol: FOLLOWUP2_KERNEL_SYMBOLS.repeat,
  }, "D5 exact repeat callback promotion");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: repeatLambda, owner: repeatLambda, related: repeatCall,
    value: "element_flow",
  }, "D5 exact repeat callback execution");
  const repeatReturn = { kind: "return", name: "repeat", flag: "labeled" };
  followup2ExpectSupported(observed, { kind: "binary", value: "==", within: repeatLambda },
    "CFG exact repeat return condition stays untainted");
  edge(repeatReturn, stringNode("repeat-join-marker"), "continue",
    "CFG return@repeat callback continuation", repeatLambda);
  followup2ExpectNoKernelFact(observed, {
    kind: "loop_success", subject: repeatCall,
  }, "D5 return@repeat is not success");
  const wrongReturnOwner = followup2KernelLambda("wrong-label-marker");
  const wrongReturn = { kind: "return", name: "wrong", within: wrongReturnOwner };
  followup2ExpectUnsupported(observed, wrongReturn,
    "unknown_control", wrongReturnOwner, "CFG wrong labeled return");
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: wrongReturn,
  }, "CFG wrong label creates no optimistic continuation");
  const ambiguousReturnOwner = followup2KernelLambda("ambiguous-label-marker");
  const ambiguousReturn = { kind: "return", name: "ambiguous", within: ambiguousReturnOwner };
  followup2ExpectUnsupported(observed, ambiguousReturn,
    "ambiguous", ambiguousReturnOwner, "CFG ambiguous labeled return");
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: ambiguousReturn,
  }, "CFG ambiguous label creates no optimistic continuation");

  const returnType = { kind: "class_decl", name: "ReturnLoopSystem" };
  const returnOwner = { kind: "function_decl", name: "update", within: returnType };
  const returnLoop = { kind: "while", textIncludes: "returnRetainedMarker" };
  const returnAssignment = { kind: "assignment", textIncludes: "returnRetainedMarker", within: returnLoop };
  const realReturn = { kind: "return", within: returnLoop };
  followup2ExpectSupported(observed, { kind: "binary", value: "<", within: returnLoop },
    "CFG returning canonical while comparison stays untainted");
  followup2ExpectSupported(observed, {
    kind: "assignment", value: "+=", text: "returnCounter += 1", within: returnLoop,
  }, "CFG returning canonical while increment stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "cfg_edge", subject: realReturn, owner: returnOwner, related: returnOwner, value: "return",
  }, "CFG direct callable return edge");
  followup2ExpectKernelFact(observed, {
    kind: "loop_success", subject: returnLoop, owner: returnOwner, related: realReturn, value: "return",
  }, "D5 real function-return loop success");
  followup2ExpectKernelFact(observed, {
    kind: "retained_exit", subject: returnAssignment, owner: returnLoop, related: realReturn, value: "",
  }, "D5 retained assignment at function return");

  const unknownControl = followup2KernelCall("missingControl");
  const unknownBranch = { kind: "if", textIncludes: "unknown-control-marker" };
  followup2ExpectUnsupported(observed, unknownControl, "unsupported", owner,
    "CFG unknown condition call");
  followup2ExpectUnsupported(observed, unknownBranch, "unknown_control", owner,
    "CFG unknown call invalidates dependent branch", unknownControl);
  followup2ExpectNoKernelFact(observed, {
    kind: "cfg_edge", subject: unknownControl,
  }, "CFG unknown condition has no optimistic branch edges");
}
function followup2AssertOperatorsMode(observed) {
  const type = { kind: "class_decl", name: "OperatorSystem" };
  const owner = { kind: "function_decl", name: "update", within: type };
  followup2ExpectKernelFact(observed, {
    kind: "override", subject: owner, owner: type, related: null, value: "",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
  }, "D19 operator root exact override");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: owner, owner: type, related: null, value: "direct",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
  }, "D19 operator root production reachability");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: owner, owner, related: null, value: "direct",
  }, "D19 operator root direct reachability");

  for (const [propertyName, literalText, abstractType] of [
    ["booleanLiteral", "true", "boolean"],
    ["intLiteral", "112233", "int"],
    ["longLiteral", "445566L", "long"],
    ["floatLiteral", "7.25f", "float"],
    ["doubleLiteral", "8.5", "double"],
  ]) {
    const property = { kind: "property_decl", name: propertyName };
    const literal = { kind: "literal", text: literalText, within: property };
    followup2ExpectKernelFact(observed, {
      kind: "type", subject: literal, owner, related: null, value: abstractType,
    }, `D19 closed ${abstractType} literal type`);
    followup2ExpectKernelFact(observed, {
      kind: "origin", subject: literal, owner, related: null, value: "literal",
    }, `D19 closed ${abstractType} literal origin`);
  }
  const stringProperty = { kind: "property_decl", name: "stringLiteral" };
  const stringLiteral = { kind: "string_template", text: '"primitive-string"', within: stringProperty };
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: stringLiteral, owner, related: null, value: "string",
  }, "D19 closed string literal type");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: stringLiteral, owner, related: null, value: "literal",
  }, "D19 closed string literal origin");

  const semanticInitializer = {
    kind: "name_ref", name: "TABLE",
    within: { kind: "property_decl", name: "semantic" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: semanticInitializer, owner, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticTable,
  }, "D12 exact semantic enum entry resolution");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: semanticInitializer, owner, related: null, value: "semantic_label",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticLabelType,
  }, "D12 exact semantic enum entry type");

  const enumBranch = { kind: "if", textIncludes: "enum-equal-marker" };
  const enumEquality = { kind: "binary", value: "==", within: enumBranch };
  const enumTested = { kind: "name_ref", name: "semantic", within: enumEquality };
  const enumEntry = { kind: "name_ref", name: "TABLE", within: enumEquality };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: enumEquality, owner, related: null, value: "enum",
  }, "D12 exact enum equality builtin");
  followup2ExpectSupported(observed, enumEquality, "D12 exact enum equality stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: enumEquality, owner, related: null, value: "boolean",
  }, "D12 exact enum equality Boolean result");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: enumEquality, owner: enumBranch, related: enumTested, value: "enum_equal",
  }, "D12 exact enum equality condition");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: enumEquality, owner, related: enumBranch, value: "equality",
  }, "D15 equality nearest branch witness");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: enumEntry, owner, related: enumEquality, value: "enum_entry",
  }, "D15 enum entry nearest equality dependency");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: enumEntry, owner, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticTable,
  }, "D12 equality RHS exact enum-entry resolution");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: enumEntry, owner, related: null, value: "semantic_label",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticLabelType,
  }, "D12 equality RHS exact enum-entry type");

  const enumNotBranch = { kind: "if", textIncludes: "enum-not-equal-marker" };
  const enumNotEquality = { kind: "binary", value: "!=", within: enumNotBranch };
  const enumNotEntry = { kind: "name_ref", name: "FLOOR", within: enumNotEquality };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: enumNotEquality, owner, related: null, value: "enum",
  }, "D12 exact enum inequality builtin");
  followup2ExpectSupported(observed, enumNotEquality, "D12 exact enum inequality stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: enumNotEquality, owner, related: null, value: "boolean",
  }, "D12 exact enum inequality Boolean result");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: enumNotEquality, owner: enumNotBranch,
    related: { kind: "name_ref", name: "semantic", within: enumNotEquality }, value: "enum_not_equal",
  }, "D12 exact enum inequality condition");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: enumNotEntry, owner, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticFloor,
  }, "D12 inequality RHS exact enum-entry resolution");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: enumNotEntry, owner, related: null, value: "semantic_label",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticLabelType,
  }, "D12 inequality RHS exact enum-entry type");

  const numericBranch = { kind: "if", textIncludes: "numeric-compare-marker" };
  const numericCompare = { kind: "binary", value: ">", within: numericBranch };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: numericCompare, owner, related: null, value: "primitive",
  }, "D19 numeric comparison builtin");
  followup2ExpectSupported(observed, numericCompare, "D19 greater-than builtin stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: numericCompare, owner, related: null, value: "boolean",
  }, "D19 greater-than Boolean result");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: numericCompare, owner: numericBranch,
    related: { kind: "name_ref", name: "integerValue", within: numericCompare }, value: "numeric_compare",
  }, "D19 numeric comparison condition");
  for (const [marker, token, label] of [
    ["less-than-marker", "<", "less-than"],
    ["less-equal-marker", "<=", "less-than-or-equal"],
    ["greater-equal-marker", ">=", "greater-than-or-equal"],
  ]) {
    const comparisonOwner = { kind: "if", textIncludes: marker };
    const comparison = { kind: "binary", value: token, within: comparisonOwner };
    const tested = { kind: "name_ref", name: "integerValue", within: comparison };
    followup2ExpectKernelFact(observed, {
      kind: "call_resolution", subject: comparison, owner, related: null, value: "primitive",
    }, `D19 ${label} primitive resolution`);
    followup2ExpectSupported(observed, comparison, `D19 ${label} builtin stays untainted`);
    followup2ExpectKernelFact(observed, {
      kind: "type", subject: comparison, owner, related: null, value: "boolean",
    }, `D19 ${label} Boolean result`);
    followup2ExpectKernelFact(observed, {
      kind: "condition", subject: comparison, owner: comparisonOwner,
      related: tested, value: "numeric_compare",
    }, `D19 ${label} numeric condition`);
  }

  const primitiveBranch = { kind: "if", textIncludes: "primitive-equality-marker" };
  const primitiveEquality = { kind: "binary", value: "==", within: primitiveBranch };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: primitiveEquality, owner, related: null, value: "primitive",
  }, "D19 primitive equality builtin");
  followup2ExpectSupported(observed, primitiveEquality, "D19 primitive equality stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: primitiveEquality, owner, related: null, value: "boolean",
  }, "D19 primitive equality Boolean result");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: primitiveEquality, owner, related: primitiveBranch, value: "equality",
  }, "D15 primitive equality nearest branch witness");
  const primitiveInequalityBranch = { kind: "if", textIncludes: "primitive-inequality-marker" };
  const primitiveInequality = { kind: "binary", value: "!=", within: primitiveInequalityBranch };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: primitiveInequality, owner, related: null, value: "primitive",
  }, "D19 primitive inequality builtin");
  followup2ExpectSupported(observed, primitiveInequality, "D19 primitive inequality stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: primitiveInequality, owner, related: null, value: "boolean",
  }, "D19 primitive inequality Boolean result");
  followup2ExpectKernelFact(observed, {
    kind: "witness_owner", subject: primitiveInequality, owner,
    related: primitiveInequalityBranch, value: "equality",
  }, "D15 primitive inequality nearest branch witness");

  const nullBranch = { kind: "if", textIncludes: "null-compare-marker" };
  const nullComparison = { kind: "binary", value: "!=", within: nullBranch };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: nullComparison, owner, related: null, value: "null",
  }, "D19 known-nullable null comparison builtin");
  followup2ExpectSupported(observed, nullComparison, "D19 nullable inequality stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: nullComparison, owner, related: null, value: "boolean",
  }, "D19 known-nullable inequality Boolean result");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: nullComparison, owner: nullBranch,
    related: { kind: "name_ref", name: "nullableValue", within: nullComparison }, value: "nonnull",
  }, "D19 known-nullable nonnull condition");
  const nullEqualBranch = { kind: "if", textIncludes: "null-equal-marker" };
  const nullEqual = { kind: "binary", value: "==", within: nullEqualBranch };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: nullEqual, owner, related: null, value: "null",
  }, "D19 known-nullable equality-to-null builtin");
  followup2ExpectSupported(observed, nullEqual, "D19 nullable equality stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: nullEqual, owner, related: null, value: "boolean",
  }, "D19 known-nullable equality Boolean result");
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: nullEqual, owner: nullEqualBranch,
    related: { kind: "name_ref", name: "nullableValue", within: nullEqual }, value: "null",
  }, "D19 known-nullable null condition");

  const booleanTrueBranch = { kind: "if", textIncludes: "boolean-true-condition-marker" };
  const booleanTrue = { kind: "name_ref", name: "booleanValue", within: booleanTrueBranch };
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: booleanTrue, owner: booleanTrueBranch,
    related: booleanTrue, value: "true",
  }, "D19 exact Boolean true condition polarity");
  const booleanFalseBranch = { kind: "if", textIncludes: "boolean-false-condition-marker" };
  const booleanNegation = { kind: "prefix", value: "!", within: booleanFalseBranch };
  const negatedBoolean = { kind: "name_ref", name: "booleanValue", within: booleanNegation };
  followup2ExpectKernelFact(observed, {
    kind: "condition", subject: booleanNegation, owner: booleanFalseBranch,
    related: negatedBoolean, value: "false",
  }, "D19 exact Boolean negation condition polarity");

  for (const [propertyName, value, typeValue] of [
    ["arithmetic", "+", "int"], ["subtraction", "-", "int"],
    ["multiplication", "*", "int"], ["division", "/", "int"],
    ["longArithmetic", "+", "long"], ["floatArithmetic", "+", "float"],
    ["doubleArithmetic", "+", "double"], ["negative", "-", "int"],
    ["negated", "!", "boolean"], ["conjunction", "&&", "boolean"],
    ["disjunction", "||", "boolean"],
  ]) {
    const property = { kind: "property_decl", name: propertyName };
    const syntax = propertyName === "negative" || value === "!"
      ? { kind: "prefix", value, within: property }
      : { kind: "binary", value, within: property };
    followup2ExpectKernelFact(observed, {
      kind: "call_resolution", subject: syntax, owner, related: null, value: "primitive",
    }, `D19 primitive ${propertyName} resolution`);
    followup2ExpectSupported(observed, syntax, `D19 primitive ${propertyName} stays untainted`);
    followup2ExpectKernelFact(observed, {
      kind: "type", subject: syntax, owner, related: null, value: typeValue,
    }, `D19 primitive ${propertyName} result type`);
    if (propertyName === "negative") {
      const immediateSource = { kind: "name_ref", name: "integerValue", within: syntax };
      followup2ExpectKernelFact(observed, {
        kind: "origin", subject: syntax, owner, related: immediateSource, value: "derived",
      }, `D19 primitive ${propertyName} derived input origin`);
    }
  }
  for (const [propertyName, continuationName, branchValue, skipValue] of [
    ["conjunction", "disjunction", "true", "false"],
    ["disjunction", "nullableValue", "false", "true"],
  ]) {
    const property = { kind: "property_decl", name: propertyName };
    const syntax = { kind: "binary", within: property };
    const left = { kind: "name_ref", name: "booleanValue", within: syntax };
    const right = { kind: "literal", within: syntax };
    const continuation = { kind: "property_decl", name: continuationName };
    followup2ExpectKernelFact(observed, {
      kind: "cfg_edge", subject: left, owner, related: right, value: branchValue,
    }, `D19 ${propertyName} short-circuit evaluates right branch`);
    followup2ExpectKernelFact(observed, {
      kind: "cfg_edge", subject: left, owner, related: continuation, value: skipValue,
    }, `D19 ${propertyName} short-circuit skip branch`);
    followup2ExpectKernelFact(observed, {
      kind: "cfg_edge", subject: right, owner, related: continuation, value: "fallthrough",
    }, `D19 ${propertyName} evaluated-right continuation`);
  }

  const increment = { kind: "assignment", value: "+=", text: "counter += 1" };
  const incrementTarget = { kind: "name_ref", name: "counter", within: increment };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: increment, owner, related: null, value: "primitive",
  }, "D19 canonical += increment");
  followup2ExpectSupported(observed, increment, "D19 canonical += stays untainted");
  followup2ExpectKernelFact(observed, {
    kind: "read", subject: increment, owner, related: incrementTarget, value: "",
  }, "D19 += reads target");
  followup2ExpectKernelFact(observed, {
    kind: "origin", subject: increment, owner,
    related: { kind: "literal", text: "1", within: increment }, value: "derived",
  }, "D19 += retains the exact increment operand");
  followup2ExpectKernelFact(observed, {
    kind: "write", subject: increment, owner, related: incrementTarget, value: "",
  }, "D19 += writes target");

  for (const [propertyName, kind, token, label] of [
    ["wrongSubtract", "binary", "-", "wrong-type subtraction"],
    ["wrongMultiply", "binary", "*", "wrong-type multiplication"],
    ["wrongDivision", "binary", "/", "wrong-type division"],
    ["wrongLogical", "binary", "&&", "wrong-type short-circuit conjunction"],
    ["wrongDisjunction", "binary", "||", "wrong-type short-circuit disjunction"],
    ["wrongUnaryMinus", "prefix", "-", "wrong-type unary minus"],
    ["wrongNegation", "prefix", "!", "wrong-type unary negation"],
  ]) {
    const selector = { kind, value: token, within: { kind: "property_decl", name: propertyName } };
    followup2ExpectUnsupported(observed, selector, "unknown_receiver", owner, `D19 ${label}`);
    for (const factKind of ["call_resolution", "type", "origin"]) {
      followup2ExpectNoKernelFact(observed, { kind: factKind, subject: selector },
        `D19 ${label} has no optimistic ${factKind}`);
    }
  }

  for (const [selector, taint, label] of [
    [{ kind: "binary", value: "+", within: { kind: "property_decl", name: "mixed" } }, "unknown_receiver", "mixed primitive operands"],
    [{ kind: "postfix", value: "++" }, "unknown_effect", "postfix increment"],
    [{ kind: "binary", value: "%", within: { kind: "property_decl", name: "remainder" } }, "unsupported", "unlisted remainder operator"],
    [{ kind: "binary", value: "+", within: { kind: "property_decl", name: "customSum" } }, "unknown_receiver", "custom overloaded plus"],
    [{ kind: "class_literal", within: { kind: "property_decl", name: "partialClass" } }, "unsupported", "non-atomic class token"],
    [{ kind: "binary", value: "==", within: { kind: "if", textIncludes: "wrong-enum-marker" } }, "unknown_receiver", "mismatched enum identity"],
    [{ kind: "binary", value: "==", within: { kind: "if", textIncludes: "custom-equals-marker" } }, "unknown_receiver", "generic equals dispatch"],
    [{ kind: "binary", value: "==", within: { kind: "if", textIncludes: "wrong-null-marker" } }, "unknown_receiver", "nonnull null comparison"],
  ]) {
    followup2ExpectUnsupported(observed, selector, taint, owner, `D19 ${label}`);
    for (const factKind of ["call_resolution", "type", "origin"]) {
      followup2ExpectNoKernelFact(observed, { kind: factKind, subject: selector },
        `D19 ${label} has no optimistic ${factKind}`);
    }
  }

  const wrongEnumBranch = { kind: "if", textIncludes: "wrong-enum-marker" };
  const wrongEnumEntry = { kind: "name_ref", name: "HORIZONTAL_UPWARD", within: wrongEnumBranch };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: wrongEnumEntry, owner, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeOrientationUp,
  }, "D12 mismatched enum still resolves its exact RHS entry");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: wrongEnumEntry, owner, related: null, value: "plane_orientation",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeOrientationType,
  }, "D12 mismatched enum RHS retains exact physical enum type");

  for (const [marker, taint, label] of [
    ["name-only-enum-marker", "unknown_receiver", "name-only enum spelling"],
    ["literal-only-enum-marker", "unknown_receiver", "literal-only enum spelling"],
    ["ambiguous-enum-marker", "ambiguous", "ambiguous enum origin"],
  ]) {
    const branchOwner = { kind: "if", textIncludes: marker };
    const equality = { kind: "binary", value: "==", within: branchOwner };
    followup2ExpectUnsupported(observed, equality, taint, owner, `D12 ${label}`);
    followup2ExpectNoKernelFact(observed, {
      kind: "condition", subject: equality,
    }, `D12 ${label} supplies no enum condition`);
  }

  const retryIterator = {
    kind: "call", name: "iterator", within: { kind: "qualified", text: "retryBounds.iterator()" },
  };
  followup2ExpectUnsupported(observed, retryIterator, "unknown_receiver", owner,
    "D19 RetryBounds naming cannot create a custom iterator builtin");
  const retryLoop = { kind: "for", textIncludes: "retry-bounds-marker" };
  const retryParameter = { kind: "parameter_decl", name: "retryItem", within: retryLoop };
  followup2ExpectNoKernelFact(observed, {
    kind: "loop_element", subject: retryParameter,
  }, "D19 custom RetryBounds supplies no loop element");
  followup2ExpectNoKernelFact(observed, {
    kind: "type", subject: retryParameter,
  }, "D19 custom RetryBounds supplies no primitive element type");
}
function followup2AssertProductionPathMode(observed) {
  const productionType = {
    kind: "class_decl", name: "ProductionSystem", pathEndsWith: "/Production.kt",
  };
  const productionUpdate = {
    kind: "function_decl", name: "update", within: productionType,
  };
  followup2ExpectKernelFact(observed, {
    kind: "override", subject: productionUpdate, owner: productionType, related: null, value: "",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
  }, "D4 src/main override admitted");
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: productionUpdate, owner: productionType, related: null,
    value: "direct", symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
  }, "D4 src/main declaration is a direct root");
  followup2ExpectKernelFact(observed, {
    kind: "reachable", subject: productionUpdate, owner: productionUpdate, related: null, value: "direct",
  }, "D4 src/main declaration is reachable");
  const productionAuthority = {
    kind: "property_decl", name: "productionAuthority", pathEndsWith: "/Production.kt",
  };
  followup2ExpectKernelFact(observed, {
    kind: "strong_authority", subject: productionAuthority, owner: productionAuthority,
    related: { kind: "name_ref", name: "productionBacking", within: productionAuthority }, value: "top_level",
  }, "D4 src/main retained getter supplies authority");

  const testType = {
    kind: "class_decl", name: "TestOnlySystem", pathEndsWith: "/TestOnly.kt",
  };
  const testUpdate = {
    kind: "function_decl", name: "update", within: testType,
  };
  followup2KernelNode(observed, testUpdate, "D4 selected src/test declaration remains real PSI input");
  followup2ExpectKernelFact(observed, {
    kind: "override", subject: testUpdate, owner: testType, related: null, value: "",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
  }, "D4 src/test declaration retains semantic override identity");
  for (const kind of ["production_root", "reachable"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: testUpdate,
  }, `D4 src/test update supplies no ${kind}`);
  followup2ExpectNoKernelFact(observed, {
    kind: "strong_authority",
    subject: { kind: "property_decl", name: "testAuthority", pathEndsWith: "/TestOnly.kt" },
  }, "D4 src/test retained getter supplies no authority");
  followup2ExpectNoKernelFact(observed, {
    kind: "effect",
    subject: { kind: "call", name: "start", pathEndsWith: "/TestOnly.kt" },
  }, "D4 unreachable src/test exact domain body supplies no effect");
}
function followup2AssertReceiverPrecedenceMode(observed) {
  const applicationType = { kind: "class_decl", name: "ReceiverApplication" };
  const onCreate = { kind: "function_decl", name: "onCreate", within: applicationType };
  const launch = followup2KernelCall("launch", "receiver-precedence-root");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: launch, owner: onCreate, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "H-D Application.launch exact resolution");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: launch, owner: onCreate, related: applicationType,
    value: "source_dispatch", symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, "D7 Application dispatch receiver");
  const superCall = {
    kind: "call", name: "onCreate", within: { kind: "qualified", text: "super.onCreate()" },
  };
  followup2ExpectUnsupported(observed, superCall, "unknown_receiver", onCreate,
    "D9 unmodeled super receiver is localized");
  for (const kind of ["call_resolution", "implicit_receiver", "effect"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: superCall,
  }, `D9 super call supplies no ${kind}`);
  const dependentCall = {
    kind: "call", name: "dependentCall",
    within: { kind: "qualified", text: "missingReceiver.dependentCall()" },
  };
  followup2ExpectUnsupported(observed, dependentCall, "unknown_receiver", onCreate,
    "D9 receiverless dependent qualified call");

  const navigatorHelper = followup2KernelFunction("navigatorHelper");
  const helperClose = { kind: "call", name: "closeStage", within: navigatorHelper };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: helperClose, owner: navigatorHelper, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorCloseStage,
  }, "H-D SpatialNavigator helper bare member resolution");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: helperClose, owner: navigatorHelper, related: navigatorHelper,
    value: "source_extension", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorCloseStage,
  }, "D7 SpatialNavigator helper extension receiver");
  const topLevel = followup2KernelFunction("topLevelNavigator");
  followup2ExpectUnsupported(observed, { kind: "call", name: "closeStage", within: topLevel },
    "unknown_receiver", topLevel, "D7 local navigator value is not an implicit receiver");

  const exercise = followup2KernelFunction("exercise");
  const callback = {
    kind: "lambda", textIncludes: 'Stage(id = "callback-precedence")',
    within: followup2KernelCall("with", "callback-precedence-marker"),
  };
  const callbackStage = followup2KernelCall("Stage", "callback-precedence-marker");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: callbackStage, owner: callback, related: callback,
    value: "callback", symbol: FOLLOWUP2_KERNEL_SYMBOLS.stage,
  }, "D7 callback receiver beats extension and dispatch");
  const explicitStage = followup2KernelCall("Stage", "explicit-precedence-marker");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: explicitStage, owner: callback, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.stage,
  }, "D7 explicit receiver resolves over active callback");
  followup2ExpectNoKernelFact(observed, {
    kind: "implicit_receiver", subject: explicitStage, related: callback, value: "callback",
  }, "D7 explicit receiver never falls back to callback receiver");
  const extensionStage = followup2KernelCall("Stage", "extension-precedence-marker");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: extensionStage, owner: exercise, related: exercise,
    value: "source_extension", symbol: FOLLOWUP2_KERNEL_SYMBOLS.stage,
  }, "D7 extension receiver beats same-depth dispatch");
  const dispatchOnly = followup2KernelFunction("dispatchOnly");
  const dispatchStage = followup2KernelCall("Stage", "dispatch-precedence-marker");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: dispatchStage, owner: dispatchOnly,
    related: { kind: "class_decl", name: "ScopeHost" }, value: "source_dispatch",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.stage,
  }, "D7 source dispatch fallback");

  const qualifierUse = followup2KernelFunction("qualifierUse");
  const domainStart = { kind: "call", name: "start", within: qualifierUse };
  const managerQualifier = {
    kind: "name_ref", name: "PlaneTrackingManager",
    within: { kind: "qualified", text: "PlaneTrackingManager.start()" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: domainStart, owner: qualifierUse, related: managerQualifier,
    value: "domain_qualifier", symbol: FOLLOWUP2_KERNEL_SYMBOLS.planeStart,
  }, "D7 exact domain object qualifier");
  const modifierCall = followup2KernelCall("fillMaxSize");
  const modifierQualifier = {
    kind: "name_ref", name: "Modifier",
    within: { kind: "qualified", text: "Modifier.fillMaxSize()" },
  };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: modifierCall, owner: qualifierUse, related: null, value: "domain",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.modifierFillMaxSize,
  }, "H-D audited domain companion projection");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: modifierQualifier, owner: qualifierUse, related: null, value: "modifier",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.modifierCompanionType,
  }, "H-D Modifier qualifier exact companion physical type");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: modifierCall, owner: qualifierUse, related: modifierQualifier,
    value: "domain_qualifier", symbol: FOLLOWUP2_KERNEL_SYMBOLS.modifierFillMaxSize,
  }, "D7 exact domain companion qualifier");
  const enumQualified = { kind: "qualified", text: "SemanticLabelType.TABLE" };
  const enumEntry = { kind: "name_ref", name: "TABLE", within: enumQualified };
  const enumQualifier = { kind: "name_ref", name: "SemanticLabelType", within: enumQualified };
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: enumEntry, owner: qualifierUse, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticTable,
  }, "H-D audited domain declaring-type member resolution");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: enumQualifier, owner: qualifierUse, related: null,
    value: "semantic_label", symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticLabelType,
  }, "H-D exact domain declaring-type qualifier identity");
  followup2ExpectKernelFact(observed, {
    kind: "implicit_receiver", subject: enumEntry, owner: qualifierUse, related: enumQualifier,
    value: "domain_qualifier", symbol: FOLLOWUP2_KERNEL_SYMBOLS.semanticTable,
  }, "D7 exact domain declaring-type qualifier");

  for (const [callName, related, label] of [
    ["objectHelper", { kind: "object_decl", name: "SourceObject" }, "object"],
    ["companionHelper", { kind: "companion_decl", within: { kind: "class_decl", name: "SourceQualifiers" } }, "companion"],
    ["instanceHelper", { kind: "property_decl", name: "instance" }, "class instance"],
  ]) {
    const call = { kind: "call", name: callName, within: qualifierUse };
    followup2ExpectKernelFact(observed, {
      kind: "call_resolution", subject: call, owner: qualifierUse,
      related: { kind: "function_decl", name: callName }, value: "source",
    }, `H-D exact source ${label} qualifier resolution`);
    followup2ExpectKernelFact(observed, {
      kind: "implicit_receiver", subject: call, owner: qualifierUse, related,
      value: "source_qualifier",
    }, `D7 exact source ${label} qualifier`);
  }
}
function followup2AssertDataflowMode(observed) {
  const type = { kind: "class_decl", name: "DataflowSystem" };
  const owner = { kind: "function_decl", name: "update", within: type };
  followup2ExpectKernelFact(observed, {
    kind: "production_root", subject: owner, owner: type, related: null, value: "direct",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.systemUpdate,
  }, "D6 dataflow direct root");
  const branchDecision = followup2KernelCall("getBoolean", "dataflow-branch");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: branchDecision, owner, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleGetBoolean,
  }, "D6 branch merge uses an exact value-unknown Boolean read");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: branchDecision, owner, related: null, value: "boolean",
  }, "D6 branch merge Boolean type");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: branchDecision, owner,
    related: { kind: "name_ref", name: "branchBundle", within: { kind: "qualified", textIncludes: "dataflow-branch" } },
    value: "read", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleGetBoolean,
  }, "D6 branch merge derives from the exact Bundle read row");

  const initial = { kind: "property_decl", name: "initial" };
  const initialValue = { kind: "literal", text: "101", within: initial };
  followup2ExpectKernelFact(observed, {
    kind: "definition", subject: initial, owner, related: initialValue, value: "",
  }, "D6 immutable local definition");
  const initialUse = { kind: "name_ref", name: "initial", within: { kind: "property_decl", name: "copy" } };
  for (const kind of ["def_use", "last_write"]) followup2ExpectKernelFact(observed, {
    kind, subject: initialUse, owner, related: initial, value: "",
  }, `D6 immutable local ${kind}`);

  const write202 = { kind: "assignment", text: "state = 202" };
  const value202 = { kind: "literal", text: "202", within: write202 };
  followup2ExpectKernelFact(observed, {
    kind: "definition", subject: write202, owner, related: value202, value: "",
  }, "D6 assignment definition identity");
  const afterUse = { kind: "name_ref", name: "state", within: { kind: "property_decl", name: "after" } };
  for (const kind of ["def_use", "last_write"]) followup2ExpectKernelFact(observed, {
    kind, subject: afterUse, owner, related: write202, value: "",
  }, `D6 unique preceding assignment ${kind}`);

  const thenBranch = { kind: "if", textIncludes: "branchRead" };
  const write303 = { kind: "assignment", text: "state = 303", within: thenBranch };
  const branchUse = { kind: "name_ref", name: "state", within: { kind: "property_decl", name: "branchRead" } };
  for (const kind of ["def_use", "last_write"]) followup2ExpectKernelFact(observed, {
    kind, subject: branchUse, owner, related: write303, value: "",
  }, `D6 path-local branch ${kind}`);
  const mergedUse = { kind: "name_ref", name: "state", within: { kind: "property_decl", name: "mergedRead" } };
  followup2ExpectUnsupported(observed, mergedUse, "ambiguous", owner,
    "D6 multiple reaching branch writes");
  for (const kind of ["def_use", "last_write"]) followup2ExpectNoKernelFact(observed, {
    kind, subject: mergedUse,
  }, `D6 ambiguous merge has no ${kind}`);

  const unknownCall = followup2KernelCall("missingMutation");
  const unknownOrigin = { kind: "property_decl", name: "unknownBundle" };
  followup2ExpectUnsupported(observed, unknownCall, "escape", owner,
    "D6 unknown concrete call escape");
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: unknownCall, owner, related: unknownOrigin, value: "unknown_call",
  }, "D6 unknown call exact escape category");
  const dependentMutation = followup2KernelCall("putString", "after-unknown-escape");
  followup2ExpectUnsupported(observed, dependentMutation, "escape", owner,
    "D6 escaped origin blocks dependent mutation");
  followup2ExpectNoKernelFact(observed, {
    kind: "effect", subject: dependentMutation,
  }, "D6 escaped origin grants no dependent effect");

  const propertyEscape = { kind: "assignment", text: "exportedBundle = propertyEscaped" };
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: propertyEscape, owner,
    related: { kind: "property_decl", name: "propertyEscaped" }, value: "property",
  }, "D6 property escape category");
  const returnOwner = followup2KernelFunction("returnEscape");
  const returned = { kind: "return", within: returnOwner };
  followup2ExpectKernelFact(observed, {
    kind: "escape", subject: returned, owner: returnOwner,
    related: { kind: "property_decl", name: "returnedBundle", within: returnOwner }, value: "return",
  }, "D6 return escape category");
}
const FOLLOWUP2_KERNEL_MODES = Object.freeze([
  {
    name: "alias-only-resolution",
    covers: ["D24"],
    assertions: followup2AssertAliasAmbiguityMode,
    sources: [
      {
        path: "modules/kernel/src/main/kotlin/a_alias.kt",
        content: `package followup2.kernel.aliases
import com.pico.spatial.sense.plane.PlaneTrackingManager as Tracker
fun aliasUse() {
  Tracker.start()
  PlaneTrackingManager.stop()
}
`,
      },
    ],
  },
  {
    name: "argument-mapping-ranking-and-type-arguments",
    covers: ["H-A", "H-C", "H-I", "D2", "D8", "D10"],
    assertions: followup2AssertArgumentMode,
    source: `package followup2.kernel.arguments
import android.app.Application
import androidx.compose.runtime.LaunchedEffect
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.foundation.content.SpatialView
import com.pico.spatial.ui.foundation.dsl.launch
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.foundation.dsl.registerSystem
import com.pico.spatial.ui.foundation.dsl.unregisterSystem
class ArgumentRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    launch {
      "argument-owner-marker"
      Vector3(z = 303f, x = 101f)
      Text(text = "concrete-text")
      LaunchedEffect("fixed-key") { "fixed-callback-marker" }
      LaunchedEffect { "zero-vararg-marker" }
      LaunchedEffect("vararg-a", "vararg-b", "vararg-c", "vararg-d") { "multi-vararg-marker" }
      Stage(content = { "stage-content-marker" }, id = "named-stage")
      registerSystem<PrimarySystem>()
      unregisterSystem<PrimarySystem>()
      registerSystem() // missing-type-argument
      registerSystem<SecondarySystem, TertiarySystem>()
      registerSystem<ArgumentRoot>()
      Vector3("zero-survivor")
      SpatialView(initial = { content, _ ->
        content.convertPosition(Vector3(), fromSpace, toSpace)
      })
    }
  }
}
class PrimarySystem : System() { override fun update(context: SceneUpdateContext) { Unit } }
class SecondarySystem : System() { override fun update(context: SceneUpdateContext) { Unit } }
class TertiarySystem : System() { override fun update(context: SceneUpdateContext) { Unit } }
`,
  },
  {
    name: "source-argument-mapping",
    covers: ["D8", "D10"],
    assertions: followup2AssertSourceMappingMode,
    source: `package followup2.kernel.sourcemap
fun sourceMap(first: String, skipped: Int = 7, callback: (String) -> Unit) { Unit }
fun invalidMap(first: String, required: Int, callback: () -> Unit) { Unit }
fun ambiguousMap(first: () -> Unit = { Unit }, second: () -> Unit = { Unit }) { Unit }
fun sourceVararg(vararg keys: String, callback: () -> Unit) { Unit }
fun sourceUse() {
  sourceMap("source-first") { sourceValue -> "source-callback-marker"; sourceValue }
  invalidMap("invalid-first") { "invalid-callback-marker" }
  ambiguousMap { "ambiguous-source-marker" }
  sourceVararg { "source-zero-vararg-marker" }
  sourceVararg("source-vararg-a", "source-vararg-b") { "source-two-vararg-marker" }
}
`,
  },
  {
    name: "ten-invocation-models-and-callback-negatives",
    covers: ["H-B", "H-L", "D2", "D5", "D16"],
    assertions: followup2AssertInvocationMode,
    source: `package followup2.kernel.invocation
import android.app.Application
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import com.pico.spatial.sense.plane.PlaneTrackingManager
import com.pico.spatial.ui.design.Button
import com.pico.spatial.ui.design.PicoTheme
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.foundation.dsl.launch
import kotlin.collections.emptyList
import kotlin.collections.filter
import kotlin.collections.maxByOrNull
import kotlin.collections.toList
import kotlin.let
import kotlin.repeat
class InvocationRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    launch {
      "source-root-marker"
      PicoTheme { "possible-path-marker" }
      Button(onClick = { "user-action-marker" }) { "button-content-marker" }
      LaunchedEffect("launch-key") { "launched-path-marker" }
      DisposableEffect("effect-key") {
        "acquire-path-marker"
        onDispose { "cleanup-path-marker" }
      }
      repeat(1) { iteration -> "element-flow-marker"; iteration }
      val anchors = PlaneTrackingManager.loadAllAnchors().toList()
      anchors.filter { predicateAnchor -> "predicate-flow-marker"; true }
      anchors.maxByOrNull { selectorAnchor -> "selector-flow-marker"; selectorAnchor.boundingBoxSize.x }
      "inline-value".let { inline -> "immediate-inline-marker"; inline }
      val merelyDeclared: () -> Unit = { "merely-declared-marker" }
      roleSpelling { "role-spelling-marker" }
      PicoTheme(content = "wrong-callback-value")
      PicoTheme(typography = { "wrong-position-marker" }, content = { "valid-position-marker" })
      Text(text = "wrong-symbol", onTextLayout = { "wrong-symbol-callback-marker" })
      emptyList().filter { missing -> "missing-producer-marker"; true }
      anchors.filter { wrong -> "non-boolean-predicate-marker"; 7 }
      anchors.maxByOrNull { escaped ->
        "escaped-selector-marker"
        val escapedKey = escaped.boundingBoxSize.x
        escapeSelectorKey(escapedKey)
        escapedKey
      }
    }
  }
}
fun neverCalled() { PicoTheme { "dead-callback-marker" } }
fun roleSpelling(anchor_update: () -> Unit) { Unit }
`,
  },
  {
    name: "callbacks-and-function-values",
    covers: ["H-B", "H-J", "H-L", "D2", "D6", "D7", "D16"],
    assertions: followup2AssertCallbackAndFunctionMode,
    source: `package followup2.kernel.callbacks
import android.app.Application
import androidx.compose.runtime.LaunchedEffect
import com.pico.spatial.sense.base.SemanticLabelType
import com.pico.spatial.sense.plane.PlaneTrackingManager
import com.pico.spatial.ui.foundation.content.SpatialView
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.launch as startSpatial
import kotlin.collections.forEach
import kotlin.collections.filter
import kotlin.collections.isNotEmpty
import kotlin.collections.toList
import kotlin.let
import kotlin.with
import kotlinx.coroutines.launch as launchCoroutine
class CallbackRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    startSpatial(::mainApp)
    startSpatial(::wrongMain)
    startSpatial(::ambiguousMain)
  }
}
fun mainApp(scope: SpatialAppScope) {
  val local: (String) -> String = { localInput -> "local-lambda-result"; localInput }
  local("local-direct")
  val passed: (String) -> String = { passedInput -> passedInput }
  "passed-source".let(passed)
  val wrongPassed: (String, String) -> String = { wrongPassedLeft, wrongPassedRight ->
    "wrong-passed-lambda-marker"
    wrongPassedLeft
  }
  "wrong-passed-source".let(wrongPassed)
  "callable-reference-source".let(::letIdentity)
  val reference: (String) -> String = ::identity
  reference("reference-direct")
  invokeBound({ parameterInput -> "parameter-lambda-result"; parameterInput }, "parameter-source")

  LaunchedEffect("outer-scope") {
    "outer-coroutine-marker"
    launchCoroutine { "call-receiver-marker" }
  }
  with(scope) { "argument-receiver-marker" }
  "let-source".let { letValue -> "let-propagation-marker"; letValue }

  val anchors = PlaneTrackingManager.loadAllAnchors().toList()
  val boundElementPredicate: (com.pico.spatial.sense.plane.PlaneAnchor) -> Boolean = {
    "bound-element-marker"
    it.semantics == SemanticLabelType.TABLE
  }
  anchors.filter(boundElementPredicate)
  anchors.forEach { "implicit-it-marker"; it.transform }
  anchors.forEach { val it = "shadow-it-marker"; it }
  anchors.forEach { first, second -> "extra-parameter-marker"; first }
  PlaneTrackingManager.subscribeAnchorUpdate { anchorUpdate -> "anchor-sam-marker"; anchorUpdate }
  PlaneTrackingManager.subscribeAnchorUpdate { swappedContent, swappedAttachments ->
    "plane-spatial-role-swap-marker"
  }
  SpatialView(
    update = { updateContent, updateAttachments -> "spatial-update-marker"; updateContent },
    initial = { initialContent, initialAttachments -> "spatial-initial-marker"; initialContent },
  )
  SpatialView(
    update = { swappedUpdate -> "spatial-anchor-role-swap-marker"; swappedUpdate },
    initial = { validContent, validAttachments -> validContent },
  )

  var reassigned: () -> String = { "first" }
  reassigned = { "second" }
  reassigned() // reassigned-call
  var mutable = 0
  val capturing: () -> String = { mutable += 1; "capture" }
  capturing() // capture-call
  val mergeDecision = anchors.isNotEmpty()
  val merged: () -> String = if (mergeDecision) ({ "left" }) else ({ "right" })
  merged() // merge-call
  val escaped: () -> String = { "escaped" }
  externalSink(escaped)
  escaped() // escaped-call
}
fun identity(value: String): String = value
fun letIdentity(letIdentityValue: String): String = letIdentityValue
fun invokeBound(function: (String) -> String, value: String): String = function(value) // unknown-binding-call
fun unknownBinding(function: () -> Unit) { function() /* unknown-binding-call */ }
fun wrongMain(scope: SpatialAppScope, required: String) { Unit }
fun SpatialAppScope.ambiguousMain(scope: SpatialAppScope) { Unit }
interface LeftCallable { fun collide(value: String): String }
interface RightCallable { fun collide(value: Int): String }
interface BothCallable : LeftCallable, RightCallable
fun ambiguousReference(value: BothCallable) { val reference = value::collide; reference("ambiguous") }
`,
  },
  {
    name: "physical-owners-collections-and-closure",
    covers: ["H-D", "H-E", "H-G", "H-H", "H-K", "H-L", "D2", "D7", "D11", "D12", "D16", "D17", "D18", "D19", "D25"],
    assertions: followup2AssertOwnersCollectionsMode,
    source: `package followup2.kernel.owners
import android.app.Application
import android.os.Bundle
import androidx.compose.runtime.ProvidableCompositionLocal
import com.pico.spatial.core.container.SpatialViewContent
import com.pico.spatial.core.container.SpatialViewEventManager
import com.pico.spatial.sense.base.SemanticLabelType
import com.pico.spatial.sense.plane.PlaneAnchor
import com.pico.spatial.sense.plane.PlaneOrientation
import com.pico.spatial.sense.plane.PlaneTrackingManager
import com.pico.spatial.ui.foundation.content.SpatialView
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.foundation.dsl.launch
import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator
import com.pico.spatial.ui.platform.containers.SpatialNavigator
import com.pico.spatial.ui.platform.containers.StageScope
import com.pico.spatial.ui.platform.containers.WindowContainerScope
import kotlin.collections.emptyList
import kotlin.collections.filter
import kotlin.collections.Iterable
import kotlin.collections.isEmpty
import kotlin.collections.isNotEmpty
import kotlin.collections.maxByOrNull
import kotlin.collections.toList
class OwnerRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    launch {
      "owner-mode-root"
      val bundleValue = Bundle()
      bundleValue.putString("owner-key", "owner-value")
      val navigator = LocalSpatialNavigator.current
      navigator.openReviewPanel("review-panel")
      navigator.closeStage()
      Stage(id = "owner-stage") {
        "stage-owner-marker"
        bundle
      }
      DefaultWindowContainer {
        "window-owner-marker"
        bundle
      }
      SpatialView(initial = { initialContent, initialAttachments ->
        "spatial-owner-marker"
        initialContent.filter
        initialContent.localSpatialCoordinateSpace
        initialContent.ownerReview("content-review")
        for (entity in initialContent.entities) {
          "entity-element-marker"
          entity
        }
      })
      (0 until 3).iterator()
      for (index in 0 until 3) {
        "range-element-marker"
        index
      }
      val loaded = PlaneTrackingManager.loadAllAnchors()
      val anchors = loaded.toList()
      val filtered = anchors.filter { plane ->
        "semantic-filter-marker"
        plane.semantics == SemanticLabelType.TABLE &&
          (plane.planeOrientation == PlaneOrientation.HORIZONTAL_UPWARD ||
            plane.planeOrientation == PlaneOrientation.HORIZONTAL_DOWNWARD) &&
          plane.boundingBoxSize.x * plane.boundingBoxSize.y > 0f
      }
      val attacked = anchors.filter { attackedPlane ->
        "or-attack-marker"
        attackedPlane.semantics == SemanticLabelType.TABLE ||
          attackedPlane.planeOrientation == PlaneOrientation.HORIZONTAL_UPWARD ||
          attackedPlane.boundingBoxSize.x * attackedPlane.boundingBoxSize.y > 0f
      }
      val mixedArea = anchors.filter { mixedAreaPlane ->
        "mixed-area-marker"
        mixedAreaPlane.boundingBoxSize.x * 17f > 0f
      }
      val constantSelected = anchors.maxByOrNull { constantChoice ->
        "constant-selection-marker"
        17
      }
      if (filtered.isNotEmpty()) {
        val selected = filtered.maxByOrNull { choice ->
          "selection-marker"
          choice.boundingBoxSize.x * choice.boundingBoxSize.y
        }
        selected?.transform
      }
      if (filtered.isEmpty()) { "negative-readiness-marker" }
      if (isNotEmpty(anchors)) { "spelling-readiness-marker" }
      emptyList().filter { empty -> "empty-list-marker"; true }
      fakeLoad().filter { wrong -> "wrong-producer-marker"; true }
      var escaped = anchors
      unknownEscape(escaped)
      escaped.filter { lost -> "lost-producer-marker"; true }
      bundleValue.phantomBundle("phantom-bundle")
    }
  }
}
fun SpatialNavigator.openReviewPanel(id: String): Bundle = Bundle()
fun SpatialNavigator.closeStage() { Unit }
fun SpatialViewContent.ownerReview(marker: String) { Unit }
fun Bundle.phantomBundle(marker: String) { Unit }
fun isNotEmpty(values: Iterable<PlaneAnchor>): Boolean { "readiness-spelling-marker"; return true }
fun fakeLoad(): List<PlaneAnchor> = emptyList()
interface BothScopes : StageScope, WindowContainerScope
fun ambiguousOwner(scope: BothScopes) { scope.bundle }
fun wrongPhysicalOwner(events: SpatialViewEventManager) { events.entities }
fun phantomDelegatedOwner(content: SpatialViewContent) { content.bundle }
fun wrongCurrent(other: ProvidableCompositionLocal<SpatialNavigator>) { other.current }
fun genericArray(values: Array<PlaneAnchor>) {
  values.toList().filter { item -> "generic-array-marker"; true }
}
fun genericList(values: List<PlaneAnchor>) {
  values.filter { item -> "generic-list-marker"; true }
}
`,
  },
  {
    name: "all-physical-callback-receiver-keys",
    covers: ["H-B", "H-L", "D8", "D10"],
    assertions: followup2AssertPhysicalReceiverMode,
    source: `package followup2.kernel.receivers
import android.app.Application
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import com.pico.spatial.ui.design.Button
import com.pico.spatial.ui.foundation.content.SpatialView
import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.foundation.dsl.launch
class ReceiverRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    launch {
      "receiver-root-marker"
      DisposableEffect("d1") { "disposable-one-marker"; onDispose { Unit } }
      DisposableEffect("d2a", "d2b") { "disposable-two-marker"; onDispose { Unit } }
      DisposableEffect("d3a", "d3b", "d3c") { "disposable-three-marker"; onDispose { Unit } }
      DisposableEffect("dva", "dvb", "dvc", "dvd") { "disposable-vararg-marker"; onDispose { Unit } }
      LaunchedEffect("l1") { "launched-one-marker" }
      LaunchedEffect("l2a", "l2b") { "launched-two-marker" }
      LaunchedEffect("l3a", "l3b", "l3c") { "launched-three-marker" }
      LaunchedEffect("lva", "lvb", "lvc", "lvd") { "launched-vararg-marker" }
      Button(onClick = { "button-click-control" }) { "button-receiver-marker" }
      SpatialView(
        attachments = { "attachments-receiver-marker" },
        initial = { content, attachments -> "initial-control-marker"; content },
      )
      DefaultWindowContainer { "window-receiver-marker" }
      Stage(id = "receiver-stage") { "stage-receiver-marker" }
    }
  }
}
`,
  },
  {
    name: "control-flow-joins-and-loop-exits",
    covers: ["D2", "D4", "D5", "D9", "D15", "D19"],
    assertions: followup2AssertControlFlowMode,
    source: `package followup2.kernel.cfg
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import kotlin.repeat
class FlowSystem : System() {
  override fun update(context: SceneUpdateContext) {
    val flag = true
    val selector = 1
    val nullable: String? = null
    "sequence-a"
    "sequence-b"
    if (flag) { "if-then-marker" } else { "if-else-marker" }
    "if-join-marker"
    if (flag) { "no-else-then-marker" }
    "no-else-join-marker"
    when (selector) {
      1 -> { "when-one-marker" }
      2 -> { "when-two-marker" }
      else -> { "when-else-marker" }
    }
    "when-join-marker"
    val elvisValue = nullable ?: "elvis-right-marker"
    "elvis-join-marker"
    try { "try-body-marker" }
    catch (first: Throwable) { "catch-one-marker" }
    catch (second: Throwable) { "catch-two-marker" }
    finally { "finally-body-marker" }
    "try-join-marker"
    try { "plain-try-marker" }
    catch (error: Throwable) { "plain-catch-marker" }
    "plain-try-join-marker"
    var retainedForMarker = 0
    val forBreakCondition = 1
    for (index in 0 until 3) {
      retainedForMarker = index
      if (index == forBreakCondition) break
      "for-body-end-marker"
    }
    "for-join-marker"
    var continueCounter = 0
    while (continueCounter < 2) {
      "while-continue-marker"
      continueCounter += 1
      continue
    }
    "while-join-marker"
    repeat(2) { iteration ->
      "repeat-return-marker"
      if (iteration == 0) return@repeat
    }
    "repeat-join-marker"
    if (missingControl()) { "unknown-control-marker" }
    repeat(1) {
      "wrong-label-marker"
      return@wrong
    }
    ambiguous@ repeat(1) {
      ambiguous@ repeat(1) {
        "ambiguous-label-marker"
        return@ambiguous
      }
    }
  }
}
class ReturnLoopSystem : System() {
  override fun update(context: SceneUpdateContext) {
    var returnCounter = 0
    var returnRetainedMarker = 0
    while (returnCounter < 2) {
      returnRetainedMarker = 1
      returnCounter += 1
      return
    }
  }
}
fun abruptFinally(): String {
  try { return "abrupt-return" }
  finally { "abrupt-finally-marker" }
}
fun throwFinally() {
  try { throw FlowFailure() }
  finally { "throw-finally-marker" }
}
class FlowFailure : Throwable()
`,
  },
  {
    name: "closed-enum-and-primitive-operators",
    covers: ["D2", "D4", "D12", "D15", "D19"],
    assertions: followup2AssertOperatorsMode,
    source: `package followup2.kernel.operators
import android.os.Bundle
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.sense.base.SemanticLabelType
import com.pico.spatial.sense.plane.PlaneOrientation
class OperatorSystem : System() {
  override fun update(context: SceneUpdateContext) {
    val booleanLiteral = true
    val intLiteral = 112233
    val longLiteral = 445566L
    val floatLiteral = 7.25f
    val doubleLiteral = 8.5
    val stringLiteral = "primitive-string"
    val bundle = Bundle()
    val booleanValue = bundle.getBoolean("boolean-value")
    val integerValue = bundle.getInt("integer-value")
    val semantic = SemanticLabelType.TABLE
    if (semantic == SemanticLabelType.TABLE) { "enum-equal-marker" }
    if (semantic != SemanticLabelType.FLOOR) { "enum-not-equal-marker" }
    if (integerValue > 0) { "numeric-compare-marker" }
    if (integerValue < 10) { "less-than-marker" }
    if (integerValue <= 10) { "less-equal-marker" }
    if (integerValue >= 0) { "greater-equal-marker" }
    if (booleanValue == true) { "primitive-equality-marker" }
    if (booleanValue != false) { "primitive-inequality-marker" }
    val arithmetic = integerValue + 1
    val subtraction = integerValue - 1
    val multiplication = integerValue * 2
    val division = integerValue / 2
    val longArithmetic = longLiteral + 1L
    val floatArithmetic = floatLiteral + 1.0f
    val doubleArithmetic = doubleLiteral + 1.0
    val negative = -integerValue
    val negated = !booleanValue
    val conjunction = booleanValue && true
    val disjunction = booleanValue || false
    val nullableValue = bundle.getString("nullable-value")
    if (nullableValue != null) { "null-compare-marker" }
    if (nullableValue == null) { "null-equal-marker" }
    if (booleanValue) { "boolean-true-condition-marker" }
    if (!booleanValue) { "boolean-false-condition-marker" }
    var counter = 0
    while (counter < 2) {
      counter += 1
    }
    val mixed = integerValue + 1f
    val wrongSubtract = stringLiteral - integerValue
    val wrongMultiply = stringLiteral * integerValue
    val wrongDivision = booleanValue / integerValue
    val wrongLogical = stringLiteral && booleanValue
    val wrongDisjunction = integerValue || booleanValue
    val wrongUnaryMinus = -stringLiteral
    val wrongNegation = !integerValue
    counter++
    val remainder = integerValue % 2
    val custom = CustomNumber()
    val customSum = custom + custom
    val partialClass = TransformComponent::class
    if (semantic == PlaneOrientation.HORIZONTAL_UPWARD) { "wrong-enum-marker" }
    if (semantic == TABLE) { "name-only-enum-marker" }
    if (semantic == "TABLE") { "literal-only-enum-marker" }
    val ambiguousSemantic = if (booleanValue) SemanticLabelType.TABLE else SemanticLabelType.FLOOR
    if (ambiguousSemantic == SemanticLabelType.TABLE) { "ambiguous-enum-marker" }
    if (custom == custom) { "custom-equals-marker" }
    if (stringLiteral == null) { "wrong-null-marker" }
    val retryBounds = RetryBounds()
    retryBounds.iterator()
    for (retryItem in retryBounds) { "retry-bounds-marker"; retryItem }
  }
}
class CustomNumber
class RetryBounds
`,
  },
  {
    name: "production-path-roots-and-authority",
    covers: ["D2", "D4"],
    assertions: followup2AssertProductionPathMode,
    sources: [
      {
        path: "modules/kernel/src/main/kotlin/Production.kt",
        content: `package followup2.kernel.production
import android.os.Bundle
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
val productionBacking: Bundle = Bundle()
val productionAuthority: Bundle get() = productionBacking
class ProductionSystem : System() {
  override fun update(context: SceneUpdateContext) { "production-path-marker" }
}
`,
      },
      {
        path: "modules/kernel/src/test/kotlin/TestOnly.kt",
        content: `package followup2.kernel.tests
import android.os.Bundle
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.sense.plane.PlaneTrackingManager
val testBacking: Bundle = Bundle()
val testAuthority: Bundle get() = testBacking
class TestOnlySystem : System() {
  override fun update(context: SceneUpdateContext) { PlaneTrackingManager.start() }
}
`,
      },
    ],
  },
  {
    name: "receiver-precedence-and-qualifiers",
    covers: ["H-D", "D7", "D9", "D18"],
    assertions: followup2AssertReceiverPrecedenceMode,
    source: `package followup2.kernel.precedence
import android.app.Application
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import com.pico.spatial.sense.base.SemanticLabelType
import com.pico.spatial.sense.plane.PlaneTrackingManager
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.foundation.dsl.launch
import com.pico.spatial.ui.platform.containers.SpatialNavigator
import kotlin.with
class ReceiverApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    missingReceiver.dependentCall()
    launch { "receiver-precedence-root" }
  }
}
fun SpatialNavigator.navigatorHelper() { closeStage() }
fun topLevelNavigator(navigator: SpatialNavigator) { closeStage() }
class ScopeHost : SpatialAppScope {
  fun SpatialAppScope.exercise(explicitScope: SpatialAppScope) {
    with(explicitScope) {
      Stage(id = "callback-precedence") { "callback-precedence-marker" }
      explicitScope.Stage(id = "explicit-precedence") { "explicit-precedence-marker" }
    }
    Stage(id = "extension-precedence") { "extension-precedence-marker" }
  }
  fun dispatchOnly() {
    Stage(id = "dispatch-precedence") { "dispatch-precedence-marker" }
  }
}
class SourceQualifiers {
  fun instanceHelper(marker: String): String = marker
  companion object {
    fun companionHelper(marker: String): String = marker
  }
}
object SourceObject {
  fun objectHelper(marker: String): String = marker
}
fun qualifierUse() {
  PlaneTrackingManager.start()
  Modifier.fillMaxSize()
  val table = SemanticLabelType.TABLE
  SourceObject.objectHelper("source-object-qualifier")
  SourceQualifiers.companionHelper("source-companion-qualifier")
  val instance = SourceQualifiers()
  instance.instanceHelper("source-class-qualifier")
}
`,
  },
  {
    name: "path-sensitive-definitions-and-escapes",
    covers: ["D4", "D6", "D20", "D22"],
    assertions: followup2AssertDataflowMode,
    source: `package followup2.kernel.dataflow
import android.os.Bundle
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
var exportedBundle: Bundle? = null
class DataflowSystem : System() {
  override fun update(context: SceneUpdateContext) {
    val initial = 101
    val copy = initial
    var state = 0
    state = 202
    val after = state
    val branchBundle = Bundle()
    val flag = branchBundle.getBoolean("dataflow-branch")
    if (flag) {
      state = 303
      val branchRead = state
    } else {
      state = 404
    }
    val mergedRead = state
    val unknownBundle = Bundle()
    missingMutation(unknownBundle)
    unknownBundle.putString("after-unknown-escape", "blocked")
    val propertyEscaped = Bundle()
    exportedBundle = propertyEscaped
    val returnedResult = returnEscape()
  }
}
fun returnEscape(): Bundle {
  val returnedBundle = Bundle()
  return returnedBundle
}
`,
  },
  {
    name: "authority-effects-pairs-overrides-and-metadata",
    covers: ["D1", "D2", "D3", "D4", "D5", "D9", "D20", "D21", "D22", "D25", "D26"],
    assertions: followup2AssertAuthorityEffectsMode,
    source: `package followup2.kernel.effects
import android.app.Application
import android.os.Bundle
import androidx.compose.runtime.DisposableEffect
import com.pico.spatial.core.ecs.Component
import com.pico.spatial.core.ecs.SceneUpdateContext
import com.pico.spatial.core.ecs.System
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.sense.plane.PlaneTrackingManager
import com.pico.spatial.ui.foundation.dsl.launch
import com.pico.spatial.ui.foundation.dsl.registerSystem
import com.pico.spatial.ui.foundation.dsl.unregisterSystem
import kotlin.collections.forEach
import kotlin.collections.toList
var retainedBacking: String = "retained-backing"
val retainedGetter: String get() = retainedBacking
val freshGetter: Bundle get() = Bundle()
val mutatedFreshGetter: Bundle
  get() {
    val fresh = Bundle()
    fresh.putString("mutated-fresh-key", "mutated-fresh-value")
    return fresh
  }
var ambiguousAccessor: String
  get() = retainedBacking
  set(value) { retainedBacking = value }
val missingAccessor: String
object AuthorityObject { val objectStrong: String get() = retainedBacking }
class AuthorityHolder {
  companion object { val companionStrong: String = retainedBacking }
}
@Deprecated("metadata-annotation") class AnnotatedMetadata
data object MetadataObject
sealed interface MetadataSealed
class EffectRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    launch {
      "effects-positive-root"
      registerSystem<LifecycleSystem>()
      unregisterSystem<LifecycleSystem>()
      val tracker = PlaneTrackingManager
      tracker.start()
      tracker.stop()
      val subscription = PlaneTrackingManager.subscribeAnchorUpdate { subscriptionUpdate ->
        "paired-subscription-marker"
        subscriptionUpdate
      }
      subscription.cancel()
      val transformComponent = TransformComponent(Vector3(), Quat.identity(), Vector3())
      val positionRead = transformComponent.position
      transformComponent.position = Vector3(x = 202f)
      transformComponent.position += Vector3(x = 303f)
      val anchors = PlaneTrackingManager.loadAllAnchors().toList()
      anchors.forEach { anchor ->
        "getter-only-marker"
        anchor.transform.position = Vector3(x = 909f)
      }
      acquireResource()
      releaseResource()
      DisposableEffect("outer-acquisition") {
        "outer-acquisition-marker"
        val foreignCleanup = { "foreign-cleanup-marker" }
        DisposableEffect("inner-acquisition") {
          "inner-acquisition-marker"
          onDispose(foreignCleanup)
          onDispose { "inner-valid-cleanup" }
        }
        onDispose { "outer-valid-cleanup" }
      }
    }
    launch {
      "wrong-type-pair-marker"
      registerSystem<WrongAcquireSystem>()
      unregisterSystem<WrongReleaseSystem>()
    }
    launch {
      "wrong-origin-pair-marker"
      val firstHandle = PlaneTrackingManager.subscribeAnchorUpdate { firstUpdate -> "first-wrong-origin"; firstUpdate }
      val secondHandle = PlaneTrackingManager.subscribeAnchorUpdate { secondUpdate -> "second-wrong-origin"; secondUpdate }
      secondHandle.cancel()
    }
    launch {
      "wrong-family-pair-marker"
      val wrongFamilyTracker = PlaneTrackingManager
      registerSystem<WrongFamilySystem>()
      wrongFamilyTracker.stop()
    }
    launch {
      "source-helper-root"
      relayManager(PlaneTrackingManager)
    }
  }
}
class LifecycleSystem : System() { override fun update(context: SceneUpdateContext) { Unit } }
class WrongAcquireSystem : System() { override fun update(context: SceneUpdateContext) { Unit } }
class WrongReleaseSystem : System() { override fun update(context: SceneUpdateContext) { Unit } }
class WrongFamilySystem : System() { override fun update(context: SceneUpdateContext) { Unit } }
class LifecycleComponent : Component() { override fun clone(): Component = LifecycleComponent() }
class QuatLike { fun clone(): QuatLike = this }
open class SourceBase { open fun replace(value: String): String = value }
class SourceChild : SourceBase() { override fun replace(value: String): String = value }
fun acquireResource() { Unit }
fun releaseResource() { Unit }
fun relayManager(manager: PlaneTrackingManager) { manager.start() }
fun unreachableHelper() { relayManager(PlaneTrackingManager) }
fun unreachableEffects() {
  val unreachableTracker = PlaneTrackingManager
  unreachableTracker.start()
}
`,
  },
  {
    name: "return-provenance-nullable-and-safe-calls",
    covers: ["H-F", "H-H", "D2", "D4", "D9", "D14", "D15", "D19"],
    assertions: followup2AssertReturnsNullableMode,
    source: `package followup2.kernel.returns
import android.app.Application
import android.os.Bundle
import androidx.compose.runtime.remember
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.lifecycle.Cancellable
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.sense.plane.PlaneTrackingManager
import com.pico.spatial.ui.foundation.dsl.Stage
import com.pico.spatial.ui.foundation.dsl.launch
import kotlin.Throwable
import kotlin.apply
import kotlin.collections.firstOrNull
import kotlin.collections.maxByOrNull
import kotlin.collections.toList
import kotlin.let
class ReturnRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    launch {
      "returns-root-marker"
      val applied = Bundle().apply { putString("apply-key", "apply-value") }
      Vector3().apply { "mismatched-apply-marker" }
      val remembered = remember { "remember-result-marker"; Bundle() }
      remember { "bad-remember-marker"; missingFactory() }
      val decisionBundle = Bundle()
      val rememberChoice = decisionBundle.getBoolean("remember-choice")
      remember { "multiple-remember-marker"; if (rememberChoice) Bundle() else Bundle() }
      remember {
        "escaped-remember-marker"
        val escapedRemember = Bundle()
        missingRememberEscape(escapedRemember)
        escapedRemember
      }
      val anchors = PlaneTrackingManager.loadAllAnchors().toList()
      val first = anchors.firstOrNull()
      val maximum = anchors.maxByOrNull { anchor -> "nullable-max-marker"; anchor.boundingBoxSize.x }
      val entity = Entity()
      val component = entity.components[TransformComponent::class.java]
      val wrongComponent = entity.components[Bundle::class.java]
      val multipleComponent = entity.components[
        TransformComponent::class.java,
        Bundle::class.java /* multiple-class-source */,
      ]
      val escapedToken = TransformComponent::class.java
      missingTokenEscape(escapedToken)
      val escapedComponent = entity.components[escapedToken]
      entity.convertPositionFrom(Vector3(), baseEntity = null /* position-null-marker */)
      entity.convertRotationFrom(Quat.identity(), baseEntity = null /* rotation-null-marker */)
      entity.convertPositionFrom(position = null /* wrong-position-null-marker */, baseEntity = entity)
      entity.addChild(null /* wrong-null-marker */)
      try { Bundle() } catch (error: Throwable) { "throwable-message-marker"; error.message }
      Stage(id = "nullable-stage") {
        "nullable-stage-marker"
        val stageBundle = bundle
        stageBundle?.getString("safe-string-key")?.let { text -> "safe-let-marker"; text }
        "safe-chain-join-marker"
      }
      val subscription: Cancellable? = PlaneTrackingManager.subscribeAnchorUpdate { subscriptionUpdate -> subscriptionUpdate }
      subscription?.cancel()
      subscription.cancel()
      val definite: Cancellable = PlaneTrackingManager.subscribeAnchorUpdate { definiteUpdate -> definiteUpdate }
      definite?.cancel()
      val alternate: Cancellable? = PlaneTrackingManager.subscribeAnchorUpdate { alternateUpdate -> alternateUpdate }
      val chooseAlternate = decisionBundle.getBoolean("subscription-choice")
      val ambiguousSubscription: Cancellable? = if (chooseAlternate) subscription else alternate
      ambiguousSubscription?.cancel()
      val selection: Selection? = Selection("selection-id")
      selection?.id
      applied.fakeGetString("wrong-nullable-key")
      getString("wrong-nullable-spelling")
    }
  }
}
class Selection(val id: String)
fun Bundle.fakeGetString(key: String): String = key
fun getString(key: String): String = key
`,
  },
]);
function followup2KernelNode(observed, selector, label) {
  assert.equal(selector !== null && typeof selector === "object", true, `${label} selector`);
  const within = selector.within === undefined
    ? null : followup2KernelNode(observed, selector.within, `${label} containing node`);
  let matches = observed.nodes.filter((node) => {
    if (within !== null && (node.path !== within.path || node.startUtf16 < within.startUtf16
      || node.endUtf16 > within.endUtf16 || node.id === within.id)) return false;
    if (selector.path !== undefined && node.path !== selector.path) return false;
    if (selector.pathEndsWith !== undefined && !node.path.endsWith(selector.pathEndsWith)) return false;
    if (selector.kind !== undefined && node.kind !== selector.kind) return false;
    if (selector.name !== undefined && node.name !== selector.name) return false;
    if (selector.value !== undefined && node.value !== selector.value) return false;
    if (selector.text !== undefined && node.text !== selector.text) return false;
    if (selector.textIncludes !== undefined && !node.text.includes(selector.textIncludes)) return false;
    if (selector.flag !== undefined && !node.flags.includes(selector.flag)) return false;
    return true;
  });
  if (selector.smallestSpan === true && matches.length > 1) {
    const minimumSpan = Math.min(...matches.map((node) => node.endUtf16 - node.startUtf16));
    matches = matches.filter((node) => node.endUtf16 - node.startUtf16 === minimumSpan);
  }
  assert.equal(matches.length, 1, `${label} must select one real Program node; got ${matches.length}`);
  return matches[0];
}
function followup2KernelNodeId(observed, selector, label) {
  if (selector === null) return -1;
  return followup2KernelNode(observed, selector, label).id;
}
function followup2ExpectedKernelFact(observed, spec, label) {
  assert.equal(typeof spec.kind, "string");
  assert.equal(typeof spec.value, "string");
  const [symbolFqn, symbolSignature] = spec.symbol ?? ["", ""];
  return {
    kind: spec.kind,
    ownerNodeId: followup2KernelNodeId(observed, spec.owner ?? null, `${label} owner`),
    relatedNodeId: followup2KernelNodeId(observed, spec.related ?? null, `${label} related`),
    subjectNodeId: followup2KernelNodeId(observed, spec.subject, `${label} subject`),
    symbolFqn,
    symbolSignature,
    value: spec.value,
  };
}
function followup2ExpectKernelFact(observed, spec, label) {
  const expected = followup2ExpectedKernelFact(observed, spec, label);
  const matches = observed.kernel.facts.filter((fact) => canonicalJson(fact) === canonicalJson(expected));
  assert.deepEqual(matches, [expected], `${label} exact kernel fact`);
  return expected;
}
function followup2ExpectNoKernelFact(observed, spec, label) {
  const subjectNodeId = spec.subject === undefined
    ? undefined : followup2KernelNodeId(observed, spec.subject, `${label} subject`);
  const relatedNodeId = spec.related === undefined
    ? undefined : followup2KernelNodeId(observed, spec.related, `${label} related`);
  const matches = observed.kernel.facts.filter((fact) => (subjectNodeId === undefined
    || fact.subjectNodeId === subjectNodeId)
    && (spec.kind === undefined || fact.kind === spec.kind)
    && (spec.value === undefined || fact.value === spec.value)
    && (relatedNodeId === undefined || fact.relatedNodeId === relatedNodeId)
    && (spec.symbol === undefined
      || (fact.symbolFqn === spec.symbol[0] && fact.symbolSignature === spec.symbol[1])));
  assert.deepEqual(matches, [], `${label} absent kernel fact`);
}
function followup2ExpectUnsupported(observed, selector, taintValue, owner, label, related = selector) {
  const subject = followup2KernelNode(observed, selector, `${label} unsupported subject`);
  assert.equal(observed.kernel.unsupportedNodeIds.includes(subject.id), true, `${label} unsupported node id`);
  followup2ExpectKernelFact(observed, {
    kind: "taint", subject: selector, owner, related, value: taintValue,
  }, `${label} taint`);
}
function followup2ExpectSupported(observed, selector, label) {
  const subject = followup2KernelNode(observed, selector, `${label} supported subject`);
  assert.equal(observed.kernel.unsupportedNodeIds.includes(subject.id), false, `${label} unsupported absence`);
  assert.deepEqual(observed.kernel.facts.filter((fact) => fact.kind === "taint"
    && fact.subjectNodeId === subject.id), [], `${label} taint absence`);
}
function followup2ValidateKernelObservation(observed, modeName, domainSymbols = FULL_BATCH2B_SYMBOLS) {
  exactKeys(observed, new Set(["kernel", "nodes"]), `${modeName} probe output`);
  assert.equal(Array.isArray(observed.nodes) && observed.nodes.length > 0, true, `${modeName} Program nodes`);
  const nodeIds = new Set();
  for (const [index, node] of observed.nodes.entries()) {
    exactKeys(node, new Set([
      "endUtf16", "fileId", "flags", "id", "kind", "name", "path", "startUtf16", "text", "value",
    ]), `${modeName} Program node ${index}`);
    assert.equal(node.id, index, `${modeName} canonical Program node id`);
    assert.equal(Number.isSafeInteger(node.fileId) && node.fileId >= 0, true);
    assert.equal(Number.isSafeInteger(node.startUtf16) && Number.isSafeInteger(node.endUtf16)
      && node.endUtf16 >= node.startUtf16, true);
    assert.equal(typeof node.path === "string" && node.path.length > 0, true);
    assert.equal(typeof node.kind === "string" && node.kind.length > 0, true);
    assert.equal(typeof node.name === "string" && typeof node.value === "string" && typeof node.text === "string", true);
    assert.equal(Array.isArray(node.flags) && new Set(node.flags).size === node.flags.length, true);
    nodeIds.add(node.id);
  }
  const { kernel } = observed;
  exactKeys(kernel, new Set(["facts", "kernelVersion", "unsupportedNodeIds"]), `${modeName} kernel`);
  assert.equal(kernel.kernelVersion, 1);
  assert.deepEqual(kernel.unsupportedNodeIds, [...new Set(kernel.unsupportedNodeIds)].sort((left, right) => left - right));
  assert.equal(kernel.unsupportedNodeIds.every((id) => nodeIds.has(id)), true);
  const canonicalFacts = kernel.facts.map(canonicalJson);
  assert.deepEqual(canonicalFacts, [...canonicalFacts].sort(), `${modeName} canonical fact order`);
  assert.equal(new Set(canonicalFacts).size, canonicalFacts.length, `${modeName} global fact uniqueness`);
  const fullSymbolIdentities = new Set(domainSymbols.map(({ fqn, signature }) => `${fqn}\0${signature}`));
  const domainSymbolKinds = new Map(domainSymbols.map(({ fqn, signature, kind }) => [
    `${fqn}\0${signature}`, kind,
  ]));
  const valueDomains = {
    callback_binding: CALLBACK_ROLES,
    callback_parameter: ABSTRACT_TYPES,
    callback_receiver: ABSTRACT_TYPES,
    call_resolution: new Set(["domain", "source", "primitive", "null", "enum", "class_token", "function_value"]),
    callback_result: ABSTRACT_TYPES,
    cfg_edge: new Set(["fallthrough", "true", "false", "loop", "break", "continue", "return", "catch", "finally"]),
    condition: new Set(["true", "false", "nonnull", "null", "readiness_positive", "readiness_negative", "enum_equal", "enum_not_equal", "numeric_compare"]),
    conformance: ABSTRACT_TYPES,
    definition: new Set([""]),
    def_use: new Set([""]),
    dominates: new Set(["control", "semantic", "horizontal", "area"]),
    effect: EFFECTS,
    escape: new Set(["argument", "return", "property", "unknown_call", "mutable_capture"]),
    function_binding: new Set(["lambda", "callable_reference"]),
    implicit_receiver: new Set(["callback", "source_extension", "source_dispatch", "domain_qualifier", "source_qualifier"]),
    last_write: new Set([""]),
    loop_element: ABSTRACT_TYPES,
    loop_success: new Set(["break", "return"]),
    nullable: new Set(["true", "false"]),
    origin: new Set(["fresh", "retained", "derived", "literal", "parameter", "property", "callback", "collection_element", "class_token"]),
    override: new Set([""]),
    paired_effect: new Set(["ecs_system_lifecycle", "plane_tracking", "cancellable_resource"]),
    production_root: new Set(["direct", ...CALLBACK_ROLES]),
    reachable: new Set(["direct", ...INVOCATION_MODELS, "branch", "loop"]),
    read: new Set([""]),
    retained_exit: new Set([""]),
    return_origin: ABSTRACT_TYPES,
    same_element: new Set(["semantic", "orientation", "area", "selection"]),
    same_origin: new Set(["authority", "navigation", "pose", "state", "resource"]),
    strong_authority: new Set(["top_level", "object", "companion"]),
    taint: new Set(["unsupported", "ambiguous", "escape", "limit", "unknown_receiver", "unknown_return", "unknown_effect", "unknown_control"]),
    type: ABSTRACT_TYPES,
    type_argument: ABSTRACT_TYPES,
    witness_owner: new Set(["break", "index", "elvis", "until", "equality", "enum_entry"]),
    write: new Set([""]),
  };
  const symbolForbidden = new Set([
    "cfg_edge", "condition", "definition", "def_use", "dominates", "escape", "function_binding",
    "last_write", "loop_success", "reachable", "retained_exit", "same_element", "same_origin",
    "strong_authority", "taint", "witness_owner",
  ]);
  const symbolRequired = new Set([
    "callback_binding", "callback_parameter", "callback_receiver", "callback_result",
    "closed_member_absence", "paired_effect", "production_root", "type_argument",
  ]);
  const multiplicities = new Map();
  for (const [index, fact] of kernel.facts.entries()) {
    exactKeys(fact, new Set([
      "kind", "ownerNodeId", "relatedNodeId", "subjectNodeId", "symbolFqn", "symbolSignature", "value",
    ]), `${modeName} fact ${index}`);
    assert.equal(FOLLOWUP2_FACT_KINDS.includes(fact.kind), true, `${modeName} fact kind`);
    assert.equal(nodeIds.has(fact.subjectNodeId), true, `${modeName} fact subject`);
    assert.equal(fact.ownerNodeId === -1 || nodeIds.has(fact.ownerNodeId), true, `${modeName} fact owner`);
    assert.equal(fact.relatedNodeId === -1 || nodeIds.has(fact.relatedNodeId), true, `${modeName} fact related`);
    assert.equal((fact.symbolFqn === "") === (fact.symbolSignature === ""), true);
    if (fact.kind === "argument_binding") {
      assert.match(fact.value, /^(?:0|[1-9][0-9]*)$/, `${modeName} canonical argument position`);
    } else if (fact.kind === "closed_member_absence") {
      assert.match(fact.value, /^[A-Za-z_][A-Za-z0-9_]*$/, `${modeName} closed member identifier`);
    } else {
      assert.equal(valueDomains[fact.kind].has(fact.value), true,
        `${modeName} fact ${index} closed ${fact.kind} value ${fact.value}`);
    }
    if (fact.kind === "closed_member_absence" || fact.kind === "conformance") {
      assert.equal(fact.ownerNodeId, -1, `${modeName} ${fact.kind} owner absence sentinel`);
    }
    if (fact.kind === "callback_parameter") {
      const subjectKind = observed.nodes[fact.subjectNodeId].kind;
      assert.equal(subjectKind === "parameter_decl" || subjectKind === "lambda", true,
        `${modeName} callback_parameter subject must be an explicit parameter or implicit-it lambda`);
      assert.notEqual(fact.ownerNodeId, -1, `${modeName} callback_parameter exact callback owner`);
      const ownerKind = observed.nodes[fact.ownerNodeId].kind;
      assert.equal(ownerKind === "lambda" || ownerKind === "function_decl", true,
        `${modeName} callback_parameter owner must be the executed lambda/function target`);
    }
    if (fact.kind === "loop_element") {
      const subjectKind = observed.nodes[fact.subjectNodeId].kind;
      assert.equal(subjectKind === "parameter_decl" || subjectKind === "lambda", true,
        `${modeName} loop_element subject must be an explicit parameter or implicit-it lambda`);
      assert.notEqual(fact.ownerNodeId, -1, `${modeName} loop_element exact loop/callback owner`);
      const ownerKind = observed.nodes[fact.ownerNodeId].kind;
      assert.equal(["for", "lambda", "function_decl"].includes(ownerKind), true,
        `${modeName} loop_element owner must be its exact loop/callback target`);
    }
    if (fact.kind === "type" && fact.relatedNodeId !== -1) {
      const relatedKind = observed.nodes[fact.relatedNodeId].kind;
      assert.equal(["class_decl", "interface_decl", "object_decl", "companion_decl"].includes(relatedKind), true,
        `${modeName} type related node must be an exact source type declaration`);
    }
    if (fact.kind === "type" && fact.symbolFqn !== "") {
      assert.equal(domainSymbolKinds.get(`${fact.symbolFqn}\0${fact.symbolSignature}`), "type",
        `${modeName} domain-backed type fact must cite an exact type row`);
    }
    if (symbolForbidden.has(fact.kind)) {
      assert.equal(fact.symbolFqn, "", `${modeName} ${fact.kind} symbol absence sentinel`);
    }
    if (symbolRequired.has(fact.kind)) {
      assert.notEqual(fact.symbolFqn, "", `${modeName} ${fact.kind} exact authorizing symbol`);
    }
    if (fact.kind === "call_resolution") {
      assert.equal(fact.symbolFqn !== "", fact.value === "domain",
        `${modeName} call_resolution symbol iff domain`);
    }
    if (fact.symbolFqn !== "") {
      assert.equal(fullSymbolIdentities.has(`${fact.symbolFqn}\0${fact.symbolSignature}`), true,
        `${modeName} fact ${index} exact live-domain symbol`);
    }
    assert.equal(typeof fact.value, "string", true);
    const multiplicityKey = `${fact.subjectNodeId}\0${fact.kind}`;
    multiplicities.set(multiplicityKey, (multiplicities.get(multiplicityKey) ?? 0) + 1);
  }
  for (const [key, count] of multiplicities) {
    const kind = key.slice(key.indexOf("\0") + 1);
    const cap = kind === "cfg_edge" ? 3 : kind === "conformance" ? 8
      : ["dominates", "effect", "same_element"].includes(kind) ? 4 : kind === "same_origin" ? 5 : 1;
    assert.equal(count <= cap, true, `${modeName} ${key} multiplicity ${count}/${cap}`);
  }
  assert.equal(kernel.facts.length <= 59 * Math.max(1, observed.nodes.length), true, `${modeName} fact bound`);
}
const FOLLOWUP2_KERNEL_DRIFT_SOURCE = `package followup2.kernel.physicaldrift
import android.app.Application
import android.os.Bundle
import com.pico.spatial.ui.foundation.dsl.launch
import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator
class PhysicalDriftRoot : Application() {
  override fun onCreate() {
    super.onCreate()
    launch {
      "physical-drift-root"
      val driftBundle = Bundle()
      driftBundle.putString("physical-drift-key", "physical-drift-value")
      val driftNavigator = LocalSpatialNavigator.current
      driftNavigator.closeStage()
    }
  }
}
`;
function followup2AssertPhysicalDriftControl(observed, label) {
  const application = { kind: "class_decl", name: "PhysicalDriftRoot" };
  const onCreate = { kind: "function_decl", name: "onCreate", within: application };
  const launch = followup2KernelCall("launch", "physical-drift-root");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: launch, owner: onCreate, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.applicationLaunch,
  }, `${label} unrelated launch survives`);
  followup2ExpectSupported(observed, launch, `${label} unrelated launch stays untainted`);
  return {
    root: followup2KernelLambda("physical-drift-root"),
    bundleCall: { kind: "call", name: "Bundle", within: { kind: "property_decl", name: "driftBundle" } },
    putString: followup2KernelCall("putString", "physical-drift-key"),
    putReceiver: {
      kind: "name_ref", name: "driftBundle",
      within: { kind: "qualified", textIncludes: "physical-drift-key" },
    },
    localNavigator: {
      kind: "name_ref", name: "LocalSpatialNavigator",
      within: { kind: "qualified", text: "LocalSpatialNavigator.current" },
    },
    current: {
      kind: "name_ref", name: "current",
      within: { kind: "qualified", text: "LocalSpatialNavigator.current" },
    },
    closeStage: followup2KernelCall("closeStage"),
  };
}
function followup2AssertPhysicalOwnerDrift(observed) {
  const { root, bundleCall, putString, putReceiver, closeStage } = followup2AssertPhysicalDriftControl(
    observed, "H-E physical-owner identity drift");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: bundleCall, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleConstructor,
  }, "H-E owner drift retains the exact child constructor");
  followup2ExpectKernelFact(observed, {
    kind: "type", subject: bundleCall, owner: root, related: null,
    value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleType,
  }, "H-E owner drift retains the exact child physical type");
  followup2ExpectUnsupported(observed, putString, "unknown_receiver", root,
    "H-E substituted physical owner rejects inherited member");
  followup2ExpectNoKernelFact(observed, {
    kind: "call_resolution", subject: putString,
  }, "H-E substituted physical owner grants no inherited resolution");
  followup2ExpectNoKernelFact(observed, {
    kind: "conformance", subject: putReceiver, value: "bundle",
  }, "H-E substituted physical owner grants no owner edge");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: closeStage, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorCloseStage,
  }, "H-E owner drift leaves unrelated physical-result routing intact");
  followup2ExpectSupported(observed, closeStage,
    "H-E owner drift leaves unrelated physical-result routing untainted");
}
function followup2AssertPhysicalProducerDrift(observed) {
  const { root, bundleCall, putString, closeStage } = followup2AssertPhysicalDriftControl(
    observed, "H-E physical-result producer identity drift");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: bundleCall, owner: root, related: null,
    value: "domain", symbol: ["android.os.Bundle", "Bundle(capacity: Int = 0)"],
  }, "H-E substituted producer row remains independently resolvable");
  followup2ExpectNoKernelFact(observed, {
    kind: "type", subject: bundleCall, value: "bundle", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundleType,
  }, "H-E substituted producer grants no exact physical-result mapping");
  followup2ExpectUnsupported(observed, putString, "unknown_receiver", root,
    "H-E missing physical-result producer key rejects dependent owner lookup");
  followup2ExpectNoKernelFact(observed, {
    kind: "call_resolution", subject: putString,
  }, "H-E missing producer key grants no dependent member resolution");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: closeStage, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.spatialNavigatorCloseStage,
  }, "H-E producer drift leaves unrelated navigator mapping intact");
  followup2ExpectSupported(observed, closeStage,
    "H-E producer drift leaves unrelated navigator mapping untainted");
}
function followup2AssertPhysicalSemanticDrift(observed) {
  const { root, putString, putReceiver, localNavigator, current, closeStage } = followup2AssertPhysicalDriftControl(
    observed, "H-E physical-result semantic drift");
  followup2ExpectUnsupported(observed, localNavigator, "unknown_return", root,
    "H-E same producer with substituted semantic result is fail-closed");
  followup2ExpectNoKernelFact(observed, {
    kind: "type", subject: localNavigator, value: "composition_local",
    symbol: FOLLOWUP2_KERNEL_SYMBOLS.providableCompositionLocalType,
  }, "H-E semantic drift grants no exact physical-result mapping");
  followup2ExpectUnsupported(observed, current, "unknown_receiver", root,
    "H-E semantic drift rejects dependent CompositionLocal member");
  followup2ExpectNoKernelFact(observed, {
    kind: "call_resolution", subject: current,
  }, "H-E semantic drift grants no current resolution");
  followup2ExpectUnsupported(observed, closeStage, "unknown_receiver", root,
    "H-E semantic drift rejects transitive navigator member");
  followup2ExpectNoKernelFact(observed, {
    kind: "call_resolution", subject: closeStage,
  }, "H-E semantic drift grants no closeStage resolution");
  followup2ExpectKernelFact(observed, {
    kind: "call_resolution", subject: putString, owner: root, related: null,
    value: "domain", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundlePutString,
  }, "H-E semantic drift leaves unrelated Bundle owner routing intact");
  followup2ExpectKernelFact(observed, {
    kind: "effect", subject: putString, owner: root, related: putReceiver,
    value: "mutate", symbol: FOLLOWUP2_KERNEL_SYMBOLS.bundlePutString,
  }, "H-E semantic drift leaves unrelated Bundle effect intact");
  followup2ExpectSupported(observed, putString,
    "H-E semantic drift leaves unrelated Bundle routing untainted");
}
const FOLLOWUP2_KERNEL_DRIFT_PROBES = Object.freeze([
  { mutation: "physical_owner_type_identity_drift", assertions: followup2AssertPhysicalOwnerDrift },
  { mutation: "physical_result_producer_identity_drift", assertions: followup2AssertPhysicalProducerDrift },
  { mutation: "physical_result_semantic_drift", assertions: followup2AssertPhysicalSemanticDrift },
]);
function runSnapshotBoundaryProbe(t) {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-snapshot-boundary-probe");
  const sourceRoot = path.join(temporary, "source");
  const classes = path.join(temporary, "classes");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  for (const directory of [sourceRoot, classes, home, temporaryFiles]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const constructorOne = `package followup.probe
class Box()
`;
  const constructorTwo = `package followup.probe
class Box() {
    constructor() : this()
}
`;
  const lambdaOne = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
}
`;
  const lambdaTwo = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
    consume { }
}
`;
  const siblingLocals = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { fun duplicate() = Unit }
    consume { fun duplicate() = Unit }
}
`;
  const constructorOwnerBoundary = `package followup.probe
class Box {
    constructor(value: Int) : this() {
        fun duplicate() = Unit
    }
    fun Box() {
        fun duplicate() = Unit
    }
}
`;
  const lambdaOwnerBoundary = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    fun duplicate() = Unit
    consume { fun duplicate() = Unit }
}
`;
  const probeSource = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.util.List;
public final class SnapshotBoundaryProbe {
  private SnapshotBoundaryProbe() {}
  private static PsiIndex.Source source(String content) {
    byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
    return new PsiIndex.Source("src/followup/Probe.kt", Protocol.sha256(bytes), content);
  }
  private static PsiIndex.Program snapshot(String content) {
    return PsiIndex.snapshot(List.of(source(content)));
  }
  private static String status(String content) {
    String rejectionCode = PsiIndex.analyze(List.of(source(content))).rejectionCode();
    return rejectionCode == null ? "accepted" : rejectionCode;
  }
  public static void main(String[] ignored) {
    String constructorOne = ${JSON.stringify(constructorOne)};
    String constructorTwo = ${JSON.stringify(constructorTwo)};
    String lambdaOne = ${JSON.stringify(lambdaOne)};
    String lambdaTwo = ${JSON.stringify(lambdaTwo)};
    String siblingLocals = ${JSON.stringify(siblingLocals)};
    String constructorOwnerBoundary = ${JSON.stringify(constructorOwnerBoundary)};
    String lambdaOwnerBoundary = ${JSON.stringify(lambdaOwnerBoundary)};
    System.out.print("constructorOne=" + snapshot(constructorOne).declarationCount() + "\\n"
        + "constructorTwo=" + snapshot(constructorTwo).declarationCount() + "\\n"
        + "lambdaOne=" + snapshot(lambdaOne).declarationCount() + "\\n"
        + "lambdaTwo=" + snapshot(lambdaTwo).declarationCount() + "\\n"
        + "constructorsStatus=" + status(constructorTwo) + "\\n"
        + "lambdasStatus=" + status(lambdaTwo) + "\\n"
        + "siblingLocalsStatus=" + status(siblingLocals) + "\\n"
        + "constructorOwnerStatus=" + status(constructorOwnerBoundary) + "\\n"
        + "lambdaOwnerStatus=" + status(lambdaOwnerBoundary) + "\\n");
  }
}
`;
  const probePath = path.join(sourceRoot, "com/agentbench/analyzer/SnapshotBoundaryProbe.java");
  fs.mkdirSync(path.dirname(probePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probePath, probeSource);
  const classpath = receipt.classpath
    .map((entry) => path.join(receipt.artifactRoot, ...entry.path.split("/")))
    .join(path.delimiter);
  const environment = {
    JAVA_HOME: receipt.jdk.root,
    HOME: home,
    TMPDIR: temporaryFiles,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  const compiled = spawnSync(path.join(receipt.jdk.root, "bin/javac"), [
    `-J-Duser.home=${home}`, `-J-Djava.io.tmpdir=${temporaryFiles}`, "--release", "17", "-encoding", "UTF-8",
    "-g:none", "-proc:none", "-classpath", classpath, "-d", classes, probePath,
  ], { cwd: sourceRoot, env: environment, shell: false, encoding: "utf8", maxBuffer: 4_194_304 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(compiled.stdout, "");
  assert.equal(compiled.stderr, "");
  const runtimeArgs = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = runtimeArgs.indexOf("-cp");
  runtimeArgs[cpIndex + 1] = `${classes}${path.delimiter}${classpath}`;
  const mainIndex = runtimeArgs.indexOf("com.agentbench.analyzer.Main");
  runtimeArgs[mainIndex] = "com.agentbench.analyzer.SnapshotBoundaryProbe";
  const executed = spawnSync(receipt.launch.java, runtimeArgs, {
    cwd: temporary,
    env: environment,
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4_194_304,
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stderr, "");
  const rows = Object.fromEntries(executed.stdout.trim().split("\n").map((row) => {
    const separator = row.indexOf("=");
    assert.equal(separator > 0, true, `probe row ${row}`);
    return [row.slice(0, separator), row.slice(separator + 1)];
  }));
  assert.deepEqual(Object.keys(rows), [
    "constructorOne", "constructorTwo", "lambdaOne", "lambdaTwo",
    "constructorsStatus", "lambdasStatus", "siblingLocalsStatus",
    "constructorOwnerStatus", "lambdaOwnerStatus",
  ]);
  assert.equal(Number(rows.constructorTwo) - Number(rows.constructorOne), 1,
    "the added KtConstructor remains in declarationCount");
  assert.equal(Number(rows.lambdaTwo) - Number(rows.lambdaOne), 1,
    "the added KtFunctionLiteral remains in declarationCount");
  assert.equal(rows.constructorsStatus, "accepted", "constructors do not enter the ambiguity map");
  assert.equal(rows.lambdasStatus, "accepted", "anonymous functions do not enter the ambiguity map");
  assert.equal(rows.siblingLocalsStatus, "ambiguous_index", "anonymous functions do not enter owner keys");
  assert.equal(rows.constructorOwnerStatus, "accepted", "constructors do not enter owner keys");
  assert.equal(rows.lambdaOwnerStatus, "ambiguous_index", "anonymous functions do not distinguish nested owners");
}
function runFollowup2ProofSelectionMatrix(root) {
  const witnessSource = `package followup2.kernel.selection\n${Array.from(
    { length: 40 }, (_, index) => `fun selectionWitness${index}(value: Int): Int = value + ${index}`,
  ).join("\n")}\n`;
  const source = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
public final class SelectionMatrixProbe {
  private static final String SOURCE = ${JSON.stringify(witnessSource)};
  private SelectionMatrixProbe() {}
  private static void selected(Map<String,String> value, String form, String alternative, String label) {
    if (!form.equals(value.get("proofForm")) || !alternative.equals(value.get("alternativeId"))
        || value.size() != 2) throw new AssertionError(label);
  }
  public static void main(String[] ignored) {
    byte[] bytes = SOURCE.getBytes(StandardCharsets.UTF_8);
    PsiIndex.Program program = PsiIndex.snapshot(List.of(new PsiIndex.Source(
        "modules/kernel/src/main/kotlin/SelectionWitnesses.kt", Protocol.sha256(bytes), SOURCE)));
    Rules.Domain domain = Rules.Domain.load();
    List<String> ids = new ArrayList<>(program.witnesses().stream().map(PsiIndex.WitnessNode::nodeId).toList());
    ids.sort(Protocol::compareUtf8);
    for (Rules.RuleSpec rule : domain.rules()) {
      String form = rule.proofForms().get(0);
      String alternative = rule.alternatives().get(0).alternativeIds().get(0);
      int cap = Rules.witnessCap(rule.ruleId());
      Rules.Analysis accepted = Rules.claimOrNull(
          program, domain, rule.ruleId(), form, alternative, ids.subList(0, cap));
      if (accepted == null || accepted.claims().size() != 1
          || accepted.claims().get(0).containsKey("alternativeId")
          || Protocol.canonicalJson(accepted.claims()).contains("alternativeId")) {
        throw new AssertionError("D23 alternative leaked or exact accepted claim missing");
      }
      Map<String,Boolean> complete = new LinkedHashMap<>();
      Map<String,List<String>> alternatives = new LinkedHashMap<>();
      for (String candidate : rule.proofForms()) {
        complete.put(candidate, candidate.equals(form));
        alternatives.put(candidate, candidate.equals(form) ? List.of(alternative) : List.of());
      }
      selected(Rules.selectProof(domain, rule.ruleId(), complete, alternatives),
          form, alternative, "D13 single selection");
    }
    Rules.RuleSpec multiForm = null; Rules.RuleSpec multiAlternative = null;
    int multiAlternativeIndex = -1;
    for (Rules.RuleSpec candidate : domain.rules()) {
      if (multiForm == null && candidate.proofForms().size() >= 2) multiForm = candidate;
      for (int index = 0; index < candidate.alternatives().size(); index++) {
        if (multiAlternative == null && candidate.alternatives().get(index).alternativeIds().size() >= 2) {
          multiAlternative = candidate; multiAlternativeIndex = index;
        }
      }
    }
    if (multiForm == null || multiAlternative == null) throw new AssertionError("selection authority missing");
    String firstForm = multiForm.proofForms().get(0), secondForm = multiForm.proofForms().get(1);
    String firstAlternative = multiForm.alternatives().get(0).alternativeIds().get(0);
    String secondAlternative = multiForm.alternatives().get(1).alternativeIds().get(0);
    Map<String,Boolean> complete = new LinkedHashMap<>();
    Map<String,List<String>> alternatives = new LinkedHashMap<>();
    for (String form : multiForm.proofForms()) { complete.put(form, false); alternatives.put(form, List.of()); }
    complete.put(secondForm, true); alternatives.put(firstForm, List.of(firstAlternative));
    alternatives.put(secondForm, List.of(secondAlternative));
    selected(Rules.selectProof(domain, multiForm.ruleId(), complete, alternatives),
        secondForm, secondAlternative, "D13 incomplete-first complete-second");
    for (String form : multiForm.proofForms()) { complete.put(form, false); alternatives.put(form, List.of()); }
    complete.put(firstForm, true);
    if (!Rules.selectProof(domain, multiForm.ruleId(), complete, alternatives).isEmpty()) {
      throw new AssertionError("D13 complete form without satisfied alternative");
    }
    complete.put(secondForm, true); alternatives.put(firstForm, List.of(firstAlternative));
    alternatives.put(secondForm, List.of(secondAlternative));
    selected(Rules.selectProof(domain, multiForm.ruleId(), complete, alternatives),
        firstForm, firstAlternative, "D13 multiple complete forms ignored domain order");
    complete = new LinkedHashMap<>(); alternatives = new LinkedHashMap<>();
    for (String form : multiAlternative.proofForms()) { complete.put(form, false); alternatives.put(form, List.of()); }
    String alternativeForm = multiAlternative.proofForms().get(multiAlternativeIndex);
    List<String> domainAlternatives = multiAlternative.alternatives().get(multiAlternativeIndex).alternativeIds();
    List<String> reversed = new ArrayList<>(domainAlternatives); java.util.Collections.reverse(reversed);
    complete.put(alternativeForm, true); alternatives.put(alternativeForm, reversed);
    selected(Rules.selectProof(domain, multiAlternative.ruleId(), complete, alternatives),
        alternativeForm, domainAlternatives.get(0), "D13 multiple alternatives ignored domain order");
    System.out.print("D13,D23");
  }
}
`;
  const probe = compileFollowup2Probe(root, "com.agentbench.analyzer.SelectionMatrixProbe", source);
  assert.equal(probe.compiled.status, 0, `SelectionMatrixProbe compile: ${probe.compiled.stderr}`);
  assert.equal(probe.compiled.stdout, "");
  assert.equal(probe.compiled.stderr, "");
  const resource = writeFollowup2DomainResource(root, "kernel-selection-full", followup2Domain());
  const executed = runFollowup2Probe(probe, root, resource);
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stderr, "");
  assert.equal(executed.stdout, "D13,D23");
  const residualResource = writeFollowup2DomainResource(
    root, "kernel-residual-dot-rejected", followup2MutationDomain("residual_dot_member"));
  const residual = runFollowup2Probe(probe, root, residualResource);
  assert.notEqual(residual.status, 0, "D3 residual-dot member derivation must fail domain loading");
  return Object.freeze(executed.stdout.split(","));
}
test("follow-up #2 schema freezes exact field sets registries canaries and caps", () => {
  const domainBytes = fs.readFileSync(DOMAIN);
  const domain = JSON.parse(domainBytes);
  assert.equal(domainBytes.toString("utf8"), canonicalJson(domain), "canonical live domain");
  exactKeys(domain, new Set([
    "acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule", "ruleOrder", "symbols", "witnessKinds",
  ]), "follow-up #2 domain");
  const symbolKeys = new Set([
    "arguments", "callbacks", "closedMemberSet", "conformsTo", "effects", "fqn", "kind", "memberPrecedence",
    "operatorForm", "receiverAbstractType", "receiverKind", "returnAbstractType", "returnSource", "signature", "typeArguments",
  ]);
  const argumentKeys = new Set(["abstractType", "hasDefault", "name", "position", "samInterfaceFqn", "variadic"]);
  const callbackKeys = new Set(["argumentPosition", "invocationModel", "parameters", "receiverAbstractType", "receiverSource", "role"]);
  const parameterKeys = new Set(["abstractType", "position"]);
  for (const [index, symbol] of FULL_BATCH2B_SYMBOLS.entries()) {
    exactKeys(symbol, symbolKeys, `FULL symbol ${index}`);
    for (const [position, argument] of symbol.arguments.entries()) exactKeys(argument, argumentKeys, `FULL symbol ${index} argument ${position}`);
    for (const [callbackIndex, callback] of symbol.callbacks.entries()) {
      exactKeys(callback, callbackKeys, `FULL symbol ${index} callback ${callbackIndex}`);
      for (const [position, parameter] of callback.parameters.entries()) exactKeys(parameter, parameterKeys, `FULL symbol ${index} callback ${callbackIndex} parameter ${position}`);
    }
  }
  assert.equal(FULL_BATCH2B_SYMBOLS.length, 175);
  assert.equal(hash(canonicalJson(FULL_BATCH2B_SYMBOLS)), "88e61320f227751c9a7f5469ac61581cd3736ba37292c41f859faa77bf48ff04");
  assert.deepEqual(FULL_BATCH2B_SYMBOLS[0] && { fqn: FULL_BATCH2B_SYMBOLS[0].fqn, signature: FULL_BATCH2B_SYMBOLS[0].signature },
    { fqn: "android.app.Application", signature: "Application()" });
  assert.deepEqual(FULL_BATCH2B_SYMBOLS.at(-1) && { fqn: FULL_BATCH2B_SYMBOLS.at(-1).fqn, signature: FULL_BATCH2B_SYMBOLS.at(-1).signature },
    { fqn: "kotlinx.coroutines.launch", signature: "CoroutineScope.launch(context: CoroutineContext = EmptyCoroutineContext, start: CoroutineStart = CoroutineStart.DEFAULT, block: suspend CoroutineScope.() -> Unit): Job" });
  assert.equal(NARROW_COLLECTION_COMPATIBILITY.length, 1);
  assert.equal(NULLABLE_RESULT_SYMBOLS.length, 6);
  assert.equal(PHYSICAL_OWNER_RELATIONS.length, 8);
  assert.equal(PHYSICAL_RESULT_TYPES.length, 4);
  assert.equal(PHYSICAL_CALLBACK_PARAMETERS.length, 5);
  assert.equal(PHYSICAL_CALLBACK_RECEIVERS.length, 13);
  assert.deepEqual(NARROW_COLLECTION_COMPATIBILITY[0], {
    fromAbstractType: "plane_anchor_collection",
    producerSymbols: [
      { fqn: "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors", signature: "loadAllAnchors(): Array<PlaneAnchor>" },
      { fqn: "kotlin.collections.toList", signature: "Array<out T>.toList(): List<T>" },
    ],
    toAbstractType: "immutable_iterable",
  });
  assert.deepEqual(WITNESS_CAPS.reduce((sum, cap) => sum + cap, 0), 252);
  assert.equal(Math.max(...WITNESS_CAPS), 25);
  assert.equal(WITNESS_CAPS.every((cap) => cap < ANALYZER_CONSTANTS.MAX_WITNESSES_PER_CLAIM), true);
  assert.deepEqual(EXACT_CLONE_CANARY_KEY, { fqn: "com.pico.spatial.core.ecs.Component.clone", signature: "clone(): Component" });
  assert.equal(PRIMITIVE_DOCTRINE.length, 7);
  assert.equal(FOLLOWUP2_FACT_KINDS.length, 37);
  const livePhase = [MIGRATED_CANARY_SYMBOLS, FULL_BATCH2B_SYMBOLS]
    .some((phase) => canonicalJson(domain.symbols) === canonicalJson(phase));
  assert.equal(livePhase, true, "live symbols must be exactly migrated-canary or FULL phase");
  const sourceRegistries = {
    SYMBOL_KINDS: [...SYMBOL_KINDS], MEMBER_PRECEDENCE: [...MEMBER_PRECEDENCE], RECEIVER_KINDS: [...RECEIVER_KINDS],
    CALLBACK_ROLES: [...CALLBACK_ROLES], INVOCATION_MODELS: [...INVOCATION_MODELS], EFFECTS: [...EFFECTS],
    ABSTRACT_TYPES: [...ABSTRACT_TYPES], RETURN_SOURCES: [...RETURN_SOURCES], OPERATOR_FORMS: [...OPERATOR_FORMS],
    CALLBACK_PARAMETER_SENTINELS: [...CALLBACK_PARAMETER_SENTINELS],
  };
  for (const [label, source, language] of [
    ["Rules.java", fs.readFileSync(path.join(JAVA_ROOT, "Rules.java"), "utf8"), "java"],
    ["build-analyzer.mjs", fs.readFileSync(BUILD, "utf8"), "javascript"],
    ["kotlin-analysis.mjs", fs.readFileSync(BRIDGE, "utf8"), "javascript"],
  ]) {
    for (const [name, expected] of Object.entries(sourceRegistries)) {
      assert.deepEqual(extractClosedRegistry(source, name, language, label), expected, `${label} ${name}`);
    }
  }
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  assert.deepEqual(receipt.build.jarEntries, EXPECTED_JAR_ENTRIES);
  assert.equal(EXPECTED_JAR_ENTRIES.length, 30);
  assert.equal(EXPECTED_JAR_ENTRIES.filter((entry) => entry === "com/agentbench/analyzer/Rules$CallbackParameterSpec.class").length, 1,
    "CallbackParameterSpec is the sole expected new JAR entry");
});
test("follow-up #2 domain validators share one cross-field rejection matrix", async (t) => {
  const temporary = followup2TempRoot(t, "domain-validators");
  try {
    const validators = await copiedFollowup2DomainValidators(temporary.root);
    const loaderSource = `package com.agentbench.analyzer;
public final class Followup2DomainLoadProbe {
  private Followup2DomainLoadProbe() {}
  public static void main(String[] ignored) {
    try { System.out.print("accepted:" + Rules.Domain.load().symbols().size()); }
    catch (RuntimeException rejected) { System.out.print("rejected"); }
  }
}
`;
    const probe = compileFollowup2Probe(temporary.root, "com.agentbench.analyzer.Followup2DomainLoadProbe", loaderSource);
    assert.equal(probe.compiled.status, 0, probe.compiled.stderr);
    assert.equal(probe.compiled.stdout, "");
    assert.equal(probe.compiled.stderr, "");
    for (const [name, expected] of FOLLOWUP2_DOMAIN_MUTATION_MATRIX) {
      const candidate = followup2MutationDomain(name);
      const bits = [];
      for (const validate of [validators.builder, validators.bridge]) {
        try { validate(structuredClone(candidate)); bits.push(true); } catch { bits.push(false); }
      }
      const resource = writeFollowup2DomainResource(temporary.root, `matrix-${name}`, candidate);
      const loaded = runFollowup2Probe(probe, temporary.root, resource);
      assert.equal(loaded.status, 0, `${name} Java loader launch: ${loaded.stderr}`);
      assert.equal(loaded.stderr, "", `${name} Java loader stderr`);
      bits.push(loaded.stdout.startsWith("accepted:"));
      assert.deepEqual(bits, [expected, expected, expected], `${name} validator parity`);
    }
  } finally {
    temporary.cleanup();
  }
  assert.equal(fs.existsSync(temporary.root), false);
});
test("follow-up #2 exact canary and FULL phases round-trip through the real Java Domain loader", (t) => {
  const temporary = followup2TempRoot(t, "domain-phases");
  try {
    const source = `package com.agentbench.analyzer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
public final class DomainPhaseProbe {
  private DomainPhaseProbe() {}
  private static Map<String,Object> argument(Rules.ArgumentSpec value) {
    Map<String,Object> row = new LinkedHashMap<>();
    row.put("abstractType", value.abstractType()); row.put("hasDefault", value.hasDefault()); row.put("name", value.name());
    row.put("position", value.position()); row.put("samInterfaceFqn", value.samInterfaceFqn()); row.put("variadic", value.variadic());
    return row;
  }
  private static Map<String,Object> parameter(Rules.CallbackParameterSpec value) {
    Map<String,Object> row = new LinkedHashMap<>(); row.put("abstractType", value.abstractType()); row.put("position", value.position()); return row;
  }
  private static Map<String,Object> callback(Rules.CallbackSpec value) {
    Map<String,Object> row = new LinkedHashMap<>();
    row.put("argumentPosition", value.argumentPosition()); row.put("invocationModel", value.invocationModel());
    row.put("parameters", value.parameters().stream().map(DomainPhaseProbe::parameter).toList());
    row.put("receiverAbstractType", value.receiverAbstractType()); row.put("receiverSource", value.receiverSource()); row.put("role", value.role());
    return row;
  }
  private static Map<String,Object> symbol(Rules.SymbolSpec value) {
    Map<String,Object> row = new LinkedHashMap<>();
    row.put("arguments", value.arguments().stream().map(DomainPhaseProbe::argument).toList());
    row.put("callbacks", value.callbacks().stream().map(DomainPhaseProbe::callback).toList());
    row.put("closedMemberSet", value.closedMemberSet()); row.put("conformsTo", value.conformsTo()); row.put("effects", value.effects());
    row.put("fqn", value.fqn()); row.put("kind", value.kind()); row.put("memberPrecedence", value.memberPrecedence());
    row.put("operatorForm", value.operatorForm()); row.put("receiverAbstractType", value.receiverAbstractType()); row.put("receiverKind", value.receiverKind());
    row.put("returnAbstractType", value.returnAbstractType()); row.put("returnSource", value.returnSource()); row.put("signature", value.signature());
    row.put("typeArguments", value.typeArguments()); return row;
  }
  private static void locked(Runnable mutation) { try { mutation.run(); } catch (UnsupportedOperationException expected) { return; } throw new AssertionError("mutable domain view"); }
  public static void main(String[] ignored) {
    Rules.Domain domain = Rules.Domain.load();
    Map<String,Object> proofs = new LinkedHashMap<>(); Map<String,Object> alternatives = new LinkedHashMap<>();
    for (Rules.RuleSpec rule : domain.rules()) {
      proofs.put(rule.ruleId(), rule.proofForms()); Map<String,Object> byForm = new LinkedHashMap<>();
      for (Rules.AlternativeSpec alternative : rule.alternatives()) byForm.put(alternative.proofForm(), alternative.alternativeIds());
      alternatives.put(rule.ruleId(), byForm);
    }
    Map<String,Object> root = new LinkedHashMap<>(); root.put("acceptedAlternativesByRule", alternatives);
    root.put("analyzerName", domain.analyzerName()); root.put("domainVersion", domain.domainVersion()); root.put("proofFormsByRule", proofs);
    root.put("ruleOrder", domain.ruleOrder()); root.put("symbols", domain.symbols().stream().map(DomainPhaseProbe::symbol).toList()); root.put("witnessKinds", domain.witnessKinds());
    locked(() -> domain.ruleOrder().add("x")); locked(() -> domain.witnessKinds().add("x")); locked(() -> domain.rules().add(null)); locked(() -> domain.symbols().add(null));
    Rules.RuleSpec rule = domain.rules().get(0); locked(() -> rule.proofForms().add("x")); locked(() -> rule.alternatives().add(null)); locked(() -> rule.alternatives().get(0).alternativeIds().add("x"));
    for (Rules.SymbolSpec nested : domain.symbols()) {
      locked(() -> nested.arguments().add(null)); locked(() -> nested.callbacks().add(null)); locked(() -> nested.typeArguments().add("x")); locked(() -> nested.conformsTo().add("x")); locked(() -> nested.effects().add("x"));
      for (Rules.CallbackSpec callback : nested.callbacks()) locked(() -> callback.parameters().add(null));
    }
    System.out.print(Protocol.canonicalJson(root));
  }
}
`;
    const probe = compileFollowup2Probe(temporary.root, "com.agentbench.analyzer.DomainPhaseProbe", source);
    assert.equal(probe.compiled.status, 0, `DomainPhaseProbe compile: ${probe.compiled.stderr}`);
    const live = JSON.parse(fs.readFileSync(DOMAIN, "utf8"));
    const phases = [["live", null, live], ["full", writeFollowup2DomainResource(temporary.root, "phase-full", followup2Domain()), followup2Domain()]];
    for (const [label, resource, expected] of phases) {
      const executed = runFollowup2Probe(probe, temporary.root, resource);
      assert.equal(executed.status, 0, `${label}: ${executed.stderr}`);
      assert.equal(executed.stderr, "", label);
      assert.deepEqual(JSON.parse(executed.stdout), expected, `${label} accessor round trip`);
    }
    for (const [name, accepted] of FOLLOWUP2_DOMAIN_MUTATION_MATRIX) {
      if (accepted) continue;
      const resource = writeFollowup2DomainResource(temporary.root, `phase-reject-${name}`, followup2MutationDomain(name));
      const executed = runFollowup2Probe(probe, temporary.root, resource);
      assert.notEqual(executed.status, 0, `${name} must fail the real loader`);
    }
  } finally {
    temporary.cleanup();
  }
  assert.equal(fs.existsSync(temporary.root), false);
});
test("follow-up #2 kernel fact seam proves H-A through H-L and D1 through D26 without emitters", (t) => {
  const temporary = followup2TempRoot(t, "kernel-facts");
  try {
    const selectionCoverage = runFollowup2ProofSelectionMatrix(temporary.root);
    assertRejectedEmpty(analyzeKotlin(sourceIndex([{
      path: "modules/kernel/src/main/kotlin/same/First.kt",
      content: "package followup2.kernel.same\nfun sameName(value: String): String = value\n",
    }, {
      path: "modules/kernel/src/test/kotlin/same/Second.kt",
      content: "package followup2.kernel.same\nfun sameName(value: String): String = value\n",
    }])), "ambiguous_index",
    "D4/D25 src/test remains indexed and unrelated same-name declarations reject at snapshot boundary");
    assertRejectedEmpty(analyzeKotlin(sourceIndex([{
      path: "modules/kernel/src/main/kotlin/aliases/Collision.kt",
      content: `package followup2.kernel.aliases
import com.pico.spatial.ui.foundation.dsl.registerSystem as collide
import com.pico.spatial.ui.foundation.dsl.unregisterSystem as collide
fun collision() { collide() }
`,
    }])), "incomplete_imports", "D24 duplicate aliases reject at exact snapshot boundary");
    assert.deepEqual([...new Set([
      ...FOLLOWUP2_KERNEL_MODES.flatMap((mode) => mode.covers), ...selectionCoverage,
    ])].sort(), [...FOLLOWUP2_KERNEL_COVERAGE].sort());
    const source = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
public final class KernelProbe {
  private KernelProbe() {}
  private static Map<String,Object> node(PsiIndex.Program program, PsiIndex.Node value, String content) {
    Map<String,Object> row = new LinkedHashMap<>();
    row.put("endUtf16", (long) value.endUtf16()); row.put("fileId", (long) value.fileId());
    row.put("flags", value.flags().stream().map(flag -> flag.name().toLowerCase(Locale.ROOT)).toList());
    row.put("id", (long) value.id()); row.put("kind", value.kind().name().toLowerCase(Locale.ROOT));
    row.put("name", value.name() == null ? "" : value.name()); row.put("path", program.file(value.fileId()).path());
    row.put("startUtf16", (long) value.startUtf16()); row.put("text", content.substring(value.startUtf16(), value.endUtf16()));
    row.put("value", value.value() == null ? "" : value.value());
    return row;
  }
  @SuppressWarnings({"rawtypes", "unchecked"})
  private static void immutable(Map<String,Object> kernel) {
    try { kernel.put("x", "x"); throw new AssertionError("mutable kernel"); } catch (UnsupportedOperationException expected) {}
    List facts = (List) kernel.get("facts");
    try { facts.add(Map.of()); throw new AssertionError("mutable facts"); } catch (UnsupportedOperationException expected) {}
    if (!facts.isEmpty()) try { ((Map) facts.get(0)).put("x", "x"); throw new AssertionError("mutable fact"); } catch (UnsupportedOperationException expected) {}
    List unsupported = (List) kernel.get("unsupportedNodeIds");
    try { unsupported.add(0L); throw new AssertionError("mutable unsupported ids"); } catch (UnsupportedOperationException expected) {}
  }
  public static void main(String[] arguments) {
    if (arguments.length < 3 || (arguments.length - 1) % 2 != 0) throw new AssertionError("source pairs");
    List<PsiIndex.Source> sources = new ArrayList<>(); List<String> contents = new ArrayList<>();
    for (int index = 1; index < arguments.length; index += 2) {
      String path = new String(Base64.getDecoder().decode(arguments[index]), StandardCharsets.UTF_8);
      String content = new String(Base64.getDecoder().decode(arguments[index + 1]), StandardCharsets.UTF_8);
      byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
      sources.add(new PsiIndex.Source(path, Protocol.sha256(bytes), content)); contents.add(content);
    }
    PsiIndex.Program program = PsiIndex.snapshot(sources);
    AbstractInterpreter interpreter = new AbstractInterpreter(program, Rules.Domain.load());
    Map<String,Object> kernel = interpreter.kernelFactsForTest();
    if (kernel != interpreter.kernelFactsForTest()) throw new AssertionError("kernel is not cached");
    immutable(kernel);
    Map<String,Object> output = new LinkedHashMap<>(); output.put("kernel", kernel);
    output.put("nodes", program.nodes().stream().map(value -> node(program, value, contents.get(value.fileId()))).toList());
    System.out.print(Protocol.canonicalJson(output));
  }
}
`;
    const probe = compileFollowup2Probe(temporary.root, "com.agentbench.analyzer.KernelProbe", source);
    assert.equal(probe.compiled.status, 0, `KernelProbe compile: ${probe.compiled.stderr}`);
    const resource = writeFollowup2DomainResource(temporary.root, "kernel-full", followup2Domain());
    for (const mode of FOLLOWUP2_KERNEL_MODES) {
      const sources = mode.sources ?? [{
        path: `modules/kernel/src/main/kotlin/${mode.name}.kt`,
        content: mode.source,
      }];
      assert.deepEqual(sources.map((entry) => entry.path), sources.map((entry) => entry.path).sort(), `${mode.name} source order`);
      const sourceArguments = sources.flatMap((entry) => [
        Buffer.from(entry.path, "utf8").toString("base64"),
        Buffer.from(entry.content, "utf8").toString("base64"),
      ]);
      const outputs = [];
      for (let iteration = 0; iteration < 2; iteration++) {
        const executed = runFollowup2Probe(probe, temporary.root, resource,
          [mode.name, ...sourceArguments]);
        assert.equal(executed.status, 0, `${mode.name}/${iteration}: ${executed.stderr}`);
        assert.equal(executed.stderr, "", mode.name);
        outputs.push(executed.stdout);
      }
      assert.equal(outputs[0], outputs[1], `${mode.name} deterministic fresh-JVM kernel`);
      const observed = JSON.parse(outputs[0]);
      followup2ValidateKernelObservation(observed, mode.name);
      assert.equal(typeof mode.assertions, "function", true, `${mode.name} behavioral assertions`);
      mode.assertions(observed);
    }
    const driftPath = "modules/kernel/src/main/kotlin/physical-drift.kt";
    const driftArguments = [
      Buffer.from(driftPath, "utf8").toString("base64"),
      Buffer.from(FOLLOWUP2_KERNEL_DRIFT_SOURCE, "utf8").toString("base64"),
    ];
    const mutationAcceptance = new Map(FOLLOWUP2_DOMAIN_MUTATION_MATRIX);
    for (const drift of FOLLOWUP2_KERNEL_DRIFT_PROBES) {
      assert.equal(mutationAcceptance.get(drift.mutation), true,
        `${drift.mutation} is a schema-accepted doctrine drift`);
      const driftDomain = followup2MutationDomain(drift.mutation);
      const driftResource = writeFollowup2DomainResource(
        temporary.root, `kernel-${drift.mutation}`, driftDomain);
      const outputs = [];
      for (let iteration = 0; iteration < 2; iteration++) {
        const executed = runFollowup2Probe(probe, temporary.root, driftResource,
          [drift.mutation, ...driftArguments]);
        assert.equal(executed.status, 0, `${drift.mutation}/${iteration}: ${executed.stderr}`);
        assert.equal(executed.stderr, "", drift.mutation);
        outputs.push(executed.stdout);
      }
      assert.equal(outputs[0], outputs[1], `${drift.mutation} deterministic fresh-JVM kernel`);
      const observed = JSON.parse(outputs[0]);
      followup2ValidateKernelObservation(observed, drift.mutation, driftDomain.symbols);
      drift.assertions(observed);
    }
  } finally {
    temporary.cleanup();
  }
  assert.equal(fs.existsSync(temporary.root), false);
});
test("follow-up #2 witness caps omit affected claims and reject impossible wire objects", async (t) => {
  const temporary = followup2TempRoot(t, "witness-caps");
  try {
    const witnessSource = `package followup2.caps\n${Array.from({ length: 40 }, (_, index) => `fun witness${index}(value: Int): Int = value + ${index}`).join("\n")}\n`;
    const source = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
public final class CapProbe {
  private static final String SOURCE = ${JSON.stringify(witnessSource)};
  private CapProbe() {}
  private static Map<String,Object> node(PsiIndex.Program program, String id) {
    PsiIndex.WitnessNode witness = program.witness(id); PsiIndex.FileUnit file = program.file(witness.fileId());
    Map<String,Object> row = new LinkedHashMap<>(); row.put("nodeId", witness.nodeId()); row.put("path", file.path()); row.put("fileSha256", file.sha256());
    row.put("startUtf16", (long) witness.startUtf16()); row.put("endUtf16", (long) witness.endUtf16());
    row.put("kind", witness.kind().name().toLowerCase(Locale.ROOT)); row.put("textSha256", witness.textSha256()); row.put("structuralToken", witness.structuralToken()); return row;
  }
  private static void rejectsImpossible(PsiIndex.Program program, String ruleId, String proofForm, List<String> ids) {
    List<Map<String,Object>> nodes = ids.stream().map(id -> node(program, id)).toList();
    Map<String,Object> digest = new LinkedHashMap<>(); digest.put("ruleId", ruleId); digest.put("proofForm", proofForm); digest.put("witnessNodeIds", ids);
    Map<String,Object> claim = new LinkedHashMap<>(digest); claim.put("witnessDigest", Protocol.sha256(Protocol.canonicalBytes(digest)));
    try { new Rules.Analysis(nodes, List.of(claim)); } catch (IllegalArgumentException expected) { return; }
    throw new AssertionError("Analysis accepted impossible over-cap claim " + ruleId);
  }
  public static void main(String[] ignored) {
    byte[] bytes = SOURCE.getBytes(StandardCharsets.UTF_8);
    PsiIndex.Program program = PsiIndex.snapshot(List.of(new PsiIndex.Source("modules/caps/src/main/kotlin/Witnesses.kt", Protocol.sha256(bytes), SOURCE)));
    Rules.Domain domain = Rules.Domain.load(); List<String> ids = new ArrayList<>(program.witnesses().stream().map(PsiIndex.WitnessNode::nodeId).toList()); ids.sort(Protocol::compareUtf8);
    List<Object> observed = new ArrayList<>();
    for (Rules.RuleSpec rule : domain.rules()) {
      int cap = Rules.witnessCap(rule.ruleId()); if (ids.size() <= cap) throw new AssertionError("insufficient witnesses");
      String form = rule.proofForms().get(0); String alternative = rule.alternatives().get(0).alternativeIds().get(0);
      Rules.Analysis accepted = Rules.claimOrNull(program, domain, rule.ruleId(), form, alternative, ids.subList(0, cap));
      Rules.Analysis omitted = Rules.claimOrNull(program, domain, rule.ruleId(), form, alternative, ids.subList(0, cap + 1));
      if (accepted == null || omitted != null || accepted.claims().size() != 1) throw new AssertionError("cap boundary");
      if (accepted.claims().get(0).containsKey("alternativeId")
          || Protocol.canonicalJson(accepted.claims()).contains("alternativeId")) {
        throw new AssertionError("alternativeId leaked into Analysis/wire");
      }
      rejectsImpossible(program, rule.ruleId(), form, ids.subList(0, cap + 1));
      Map<String,Boolean> complete = new LinkedHashMap<>(); Map<String,List<String>> alternatives = new LinkedHashMap<>();
      for (String candidate : rule.proofForms()) { complete.put(candidate, candidate.equals(form)); alternatives.put(candidate, candidate.equals(form) ? List.of(alternative) : List.of()); }
      Map<String,String> selected = Rules.selectProof(domain, rule.ruleId(), complete, alternatives);
      if (!form.equals(selected.get("proofForm")) || !alternative.equals(selected.get("alternativeId"))) throw new AssertionError("proof selection");
      observed.add((long) cap);
    }
    Rules.RuleSpec multiForm = null;
    Rules.RuleSpec multiAlternative = null;
    int multiAlternativeIndex = -1;
    for (Rules.RuleSpec candidate : domain.rules()) {
      if (multiForm == null && candidate.proofForms().size() >= 2) multiForm = candidate;
      for (int index = 0; index < candidate.alternatives().size(); index++) {
        if (multiAlternative == null && candidate.alternatives().get(index).alternativeIds().size() >= 2) {
          multiAlternative = candidate; multiAlternativeIndex = index;
        }
      }
    }
    if (multiForm == null || multiAlternative == null) throw new AssertionError("selection matrix authority missing");
    Map<String,Boolean> complete = new LinkedHashMap<>();
    Map<String,List<String>> alternatives = new LinkedHashMap<>();
    for (String form : multiForm.proofForms()) { complete.put(form, false); alternatives.put(form, List.of()); }
    String firstForm = multiForm.proofForms().get(0); String secondForm = multiForm.proofForms().get(1);
    String firstAlternative = multiForm.alternatives().get(0).alternativeIds().get(0);
    String secondAlternative = multiForm.alternatives().get(1).alternativeIds().get(0);
    complete.put(secondForm, true); alternatives.put(firstForm, List.of(firstAlternative)); alternatives.put(secondForm, List.of(secondAlternative));
    Map<String,String> secondSelected = Rules.selectProof(domain, multiForm.ruleId(), complete, alternatives);
    if (!secondForm.equals(secondSelected.get("proofForm")) || !secondAlternative.equals(secondSelected.get("alternativeId"))) {
      throw new AssertionError("incomplete-first complete-second selection");
    }
    for (String form : multiForm.proofForms()) { complete.put(form, false); alternatives.put(form, List.of()); }
    complete.put(firstForm, true);
    if (!Rules.selectProof(domain, multiForm.ruleId(), complete, alternatives).isEmpty()) {
      throw new AssertionError("complete form without satisfied alternative selected");
    }
    for (String form : multiForm.proofForms()) { complete.put(form, false); alternatives.put(form, List.of()); }
    complete.put(firstForm, true); complete.put(secondForm, true);
    alternatives.put(firstForm, List.of(firstAlternative)); alternatives.put(secondForm, List.of(secondAlternative));
    Map<String,String> orderedForms = Rules.selectProof(domain, multiForm.ruleId(), complete, alternatives);
    if (!firstForm.equals(orderedForms.get("proofForm")) || !firstAlternative.equals(orderedForms.get("alternativeId"))) {
      throw new AssertionError("multiple complete forms ignored domain order");
    }
    complete = new LinkedHashMap<>(); alternatives = new LinkedHashMap<>();
    for (String form : multiAlternative.proofForms()) { complete.put(form, false); alternatives.put(form, List.of()); }
    String alternativeForm = multiAlternative.proofForms().get(multiAlternativeIndex);
    List<String> domainAlternatives = multiAlternative.alternatives().get(multiAlternativeIndex).alternativeIds();
    List<String> reversedAlternatives = new ArrayList<>(domainAlternatives); java.util.Collections.reverse(reversedAlternatives);
    complete.put(alternativeForm, true); alternatives.put(alternativeForm, reversedAlternatives);
    Map<String,String> orderedAlternatives = Rules.selectProof(domain, multiAlternative.ruleId(), complete, alternatives);
    if (!domainAlternatives.get(0).equals(orderedAlternatives.get("alternativeId"))) {
      throw new AssertionError("multiple alternatives ignored domain order");
    }
    System.out.print(Protocol.canonicalJson(observed));
  }
}
`;
    const probe = compileFollowup2Probe(temporary.root, "com.agentbench.analyzer.CapProbe", source);
    assert.equal(probe.compiled.status, 0, `CapProbe compile: ${probe.compiled.stderr}`);
    const resource = writeFollowup2DomainResource(temporary.root, "caps-full", followup2Domain());
    const executed = runFollowup2Probe(probe, temporary.root, resource);
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(executed.stderr, "");
    assert.deepEqual(JSON.parse(executed.stdout), WITNESS_CAPS);
    assert.equal(WITNESS_CAPS.reduce((sum, cap) => sum + cap, 0), 252);
    const validators = await copiedFollowup2DomainValidators(temporary.root);
    const witnessPath = "modules/caps/src/main/kotlin/Witnesses.kt";
    const request = analyzeRequest(witnessPath, witnessSource);
    const availableNodes = Array.from({ length: 40 }, (_, index) => {
      const text = `witness${index}`; const start = witnessSource.indexOf(text);
      assert.notEqual(start, -1, text);
      return followup2SyntheticWitness(witnessPath, witnessSource, start, start + text.length);
    }).sort((left, right) => Buffer.compare(Buffer.from(left.nodeId), Buffer.from(right.nodeId)));
    for (const [ruleIndex, ruleId] of RULE_ORDER.entries()) {
      const nodes = availableNodes.slice(0, WITNESS_CAPS[ruleIndex] + 1);
      const witnessNodeIds = nodes.map((node) => node.nodeId);
      const proofForm = PROOF_FORMS_BY_RULE[ruleId][0];
      const digestMaterial = { ruleId, proofForm, witnessNodeIds };
      const response = { nodes, claims: [{ ...digestMaterial, witnessDigest: hash(Buffer.from(canonicalJson(digestMaterial), "utf8")) }] };
      assert.throws(() => validators.bridgeAnalysis(response, request, followup2Domain()), /witness|cap|limit/i, `${ruleId} bridge N+1`);
    }
    const blockPath = "modules/caps/src/main/kotlin/TelemetryShard.kt";
    const block = analyzeKotlin(sourceIndex([{ path: blockPath, content: BLOCK_CLONE_SOURCE }]));
    assertCloneResponse(block, "single-return-block-component-clone", new Set([blockPath]));
    assert.equal(block.claims[0].witnessNodeIds.length, 16);
    const overCapPath = "modules/caps/src/main/kotlin/RelayPart.kt";
    const overCap = analyzeKotlin(sourceIndex([{ path: overCapPath, content: THREE_FIELD_OVER_CAP_CLONE_SOURCE }]));
    assert.equal(overCap.analysisStatus, "accepted"); assert.equal(overCap.rejectionCode, null);
    assert.equal(overCap.claims.some((claim) => claim.ruleId === "ecs.component-clone"), false);
    assert.equal(overCap.nodes.length, 0, "omitted over-cap claim leaves no orphan nodes");
  } finally {
    temporary.cleanup();
  }
  assert.equal(fs.existsSync(temporary.root), false);
});
test("follow-up #2 minimally amended checkpoint is accepted with missing Batch 2B emitters", (t) => {
  const domain = JSON.parse(fs.readFileSync(DOMAIN, "utf8"));
  assert.equal([MIGRATED_CANARY_SYMBOLS, FULL_BATCH2B_SYMBOLS]
    .some((phase) => canonicalJson(domain.symbols) === canonicalJson(phase)), true, "checkpoint uses an exact authorized domain phase");
  const index = loadSubmissionSources(writeUncorrectedCheckpointProject(t));
  const response = analyzeKotlin(index);
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  const actual = response.claims.map((claim) => claim.ruleId);
  const expected = RULE_ORDER.filter((ruleId) => !UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS.includes(ruleId));
  assert.deepEqual(actual, actual.toSorted((left, right) => RULE_ORDER.indexOf(left) - RULE_ORDER.indexOf(right)));
  assert.equal(actual.every((ruleId) => expected.includes(ruleId)), true);
  if (liveDomainPhase() === "migrated") {
    assert.equal(actual.length < expected.length, true, "Batch 2B emitter set remains incomplete");
  } else {
    assert.deepEqual(actual, expected, "the complete Batch 2B emitter set claims every non-defect rule");
  }
});
test("domain bytes freeze the canonical closed subset-v1 vocabulary and clone canary", () => {
  const domainBytes = fs.readFileSync(DOMAIN);
  const domainText = domainBytes.toString("utf8");
  const domain = JSON.parse(domainText);
  assert.equal(domainText, canonicalJson(domain), "domain must be canonical UTF-8 JSON with no BOM, whitespace, or trailing LF");
  exactKeys(domain, new Set([
    "acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule",
    "ruleOrder", "symbols", "witnessKinds",
  ]), "domain");
  assert.equal(domain.analyzerName, "supported-subset-abstract-interpreter-v1");
  assert.equal(domain.domainVersion, 1);
  assert.deepEqual(domain.ruleOrder, RULE_ORDER);
  assert.deepEqual(domain.witnessKinds, WITNESS_KINDS);
  const sortedRules = [...RULE_ORDER].sort();
  assert.deepEqual(Object.keys(domain.proofFormsByRule), sortedRules);
  assert.deepEqual(Object.keys(domain.acceptedAlternativesByRule), sortedRules);
  assert.deepEqual(domain.proofFormsByRule, PROOF_FORMS_BY_RULE);
  assert.deepEqual(domain.acceptedAlternativesByRule, ACCEPTED_ALTERNATIVES_BY_RULE);
  assert.equal(Object.values(domain.acceptedAlternativesByRule).flatMap((forms) => Object.values(forms)).reduce((sum, alternatives) => sum + alternatives.length, 0), 50);
  for (const ruleId of RULE_ORDER) {
    const forms = domain.proofFormsByRule[ruleId];
    uniqueStrings(forms, `${ruleId} proof forms`);
    const alternatives = domain.acceptedAlternativesByRule[ruleId];
    exactKeys(alternatives, new Set(forms), `${ruleId} alternatives`);
    assert.deepEqual(Object.keys(alternatives), [...forms].sort(), `${ruleId} alternative key order`);
    for (const proofForm of forms) uniqueStrings(alternatives[proofForm], `${ruleId}/${proofForm} alternatives`);
  }
  assert.deepEqual(domain.proofFormsByRule["ecs.component-clone"], [
    "expression-component-clone", "single-return-block-component-clone",
  ]);
  assert.equal(Array.isArray(domain.symbols), true);
  const symbolIdentities = [];
  for (const [index, symbol] of domain.symbols.entries()) {
    exactKeys(symbol, new Set([
      "arguments", "callbacks", "closedMemberSet", "conformsTo", "effects", "fqn", "kind", "memberPrecedence",
      "operatorForm", "receiverAbstractType", "receiverKind", "returnAbstractType", "returnSource", "signature", "typeArguments",
    ]), `symbols[${index}]`);
    assert.equal(typeof symbol.fqn === "string" && symbol.fqn.length > 0, true);
    assert.equal(typeof symbol.signature === "string" && symbol.signature.length > 0, true);
    assert.equal(SYMBOL_KINDS.has(symbol.kind), true, `symbols[${index}].kind`);
    assert.equal(MEMBER_PRECEDENCE.has(symbol.memberPrecedence), true, `symbols[${index}].memberPrecedence`);
    assert.equal(RECEIVER_KINDS.has(symbol.receiverKind), true, `symbols[${index}].receiverKind`);
    for (const [label, abstractType] of [["receiver", symbol.receiverAbstractType], ["return", symbol.returnAbstractType]]) {
      assert.equal(abstractType === null || ABSTRACT_TYPES.has(abstractType), true, `symbols[${index}] ${label} abstract type`);
    }
    assert.equal(Array.isArray(symbol.arguments), true);
    assert.deepEqual(symbol.arguments.map((argument) => argument.position), symbol.arguments.map((_, position) => position));
    for (const argument of symbol.arguments) {
      exactKeys(argument, new Set(["abstractType", "hasDefault", "name", "position", "samInterfaceFqn", "variadic"]), "domain argument");
      assert.equal(ABSTRACT_TYPES.has(argument.abstractType), true);
      assert.equal(argument.name === null || (typeof argument.name === "string" && argument.name.length > 0), true);
      assert.equal(typeof argument.hasDefault, "boolean");
      assert.equal(typeof argument.variadic, "boolean");
      assert.equal(argument.samInterfaceFqn === null || (typeof argument.samInterfaceFqn === "string" && argument.samInterfaceFqn.length > 0), true);
    }
    assert.equal(Array.isArray(symbol.callbacks), true);
    for (const callback of symbol.callbacks) {
      exactKeys(callback, new Set(["argumentPosition", "invocationModel", "parameters", "receiverAbstractType", "receiverSource", "role"]), "domain callback");
      assert.equal(Number.isSafeInteger(callback.argumentPosition) && callback.argumentPosition >= 0, true);
      assert.equal(callback.argumentPosition < symbol.arguments.length, true);
      assert.equal(CALLBACK_ROLES.has(callback.role), true);
      assert.equal(INVOCATION_MODELS.has(callback.invocationModel), true);
      assert.equal(callback.receiverAbstractType === null || ABSTRACT_TYPES.has(callback.receiverAbstractType), true);
      assert.equal(callback.receiverSource === null || callback.receiverSource === "call_receiver" || /^argument:[0-9]+$/.test(callback.receiverSource), true);
      assert.deepEqual(callback.parameters.map((parameter) => parameter.position), callback.parameters.map((_, position) => position));
      for (const parameter of callback.parameters) {
        exactKeys(parameter, new Set(["abstractType", "position"]), "domain callback parameter");
        assert.equal(ABSTRACT_TYPES.has(parameter.abstractType) || CALLBACK_PARAMETER_SENTINELS.has(parameter.abstractType), true);
      }
    }
    assert.equal(typeof symbol.closedMemberSet, "boolean");
    assert.equal(Array.isArray(symbol.conformsTo) && symbol.conformsTo.every((type) => ABSTRACT_TYPES.has(type)), true);
    assert.equal(Array.isArray(symbol.typeArguments) && symbol.typeArguments.every((type) => ABSTRACT_TYPES.has(type)), true);
    assert.equal(symbol.returnSource === null || RETURN_SOURCES.has(symbol.returnSource), true);
    assert.equal(symbol.operatorForm === null || OPERATOR_FORMS.has(symbol.operatorForm), true);
    assert.equal(Array.isArray(symbol.effects), true);
    assert.equal(new Set(symbol.effects).size, symbol.effects.length);
    assert.equal(symbol.effects.every((effect) => EFFECTS.has(effect)), true);
    symbolIdentities.push(canonicalJson({ fqn: symbol.fqn, signature: symbol.signature }));
  }
  assert.deepEqual(symbolIdentities, [...new Set(symbolIdentities)].sort(), "canonical unique symbol order");
  const cloneRows = domain.symbols.filter((symbol) => symbol.fqn === "com.pico.spatial.core.ecs.Component"
    || symbol.fqn === "com.pico.spatial.core.ecs.Component.clone");
  assert.deepEqual(cloneRows, COMPONENT_CANARY_SYMBOLS, "clone canary must preserve the three exact audited Component rows");
  assert.equal([MIGRATED_CANARY_SYMBOLS, FULL_BATCH2B_SYMBOLS]
    .some((phase) => canonicalJson(domain.symbols) === canonicalJson(phase)), true, "exact authorized domain phase");
});
test("follow-up vocabulary mirrors the exact reviewed minimum across the domain-row transition", () => {
  const expectedRegistries = {
    SYMBOL_KINDS: [...SYMBOL_KINDS],
    MEMBER_PRECEDENCE: [...MEMBER_PRECEDENCE],
    RECEIVER_KINDS: [...RECEIVER_KINDS],
    CALLBACK_ROLES: [...CALLBACK_ROLES],
    INVOCATION_MODELS: [...INVOCATION_MODELS],
    EFFECTS: [...EFFECTS],
    ABSTRACT_TYPES: [...ABSTRACT_TYPES],
    RETURN_SOURCES: [...RETURN_SOURCES],
    OPERATOR_FORMS: [...OPERATOR_FORMS],
    CALLBACK_PARAMETER_SENTINELS: [...CALLBACK_PARAMETER_SENTINELS],
  };
  const productionSources = [
    ["Rules.java", fs.readFileSync(path.join(JAVA_ROOT, "Rules.java"), "utf8"), "java"],
    ["build-analyzer.mjs", fs.readFileSync(BUILD, "utf8"), "javascript"],
    ["kotlin-analysis.mjs", fs.readFileSync(BRIDGE, "utf8"), "javascript"],
  ];
  for (const [name, expected] of Object.entries(expectedRegistries)) {
    assert.equal(new Set(expected).size, expected.length, `${name} test literal uniqueness`);
    for (const [label, source, language] of productionSources) {
      const actual = extractClosedRegistry(source, name, language, label);
      assert.deepEqual(actual, expected, `${label} ${name} exact source order`);
      assert.deepEqual(new Set(actual), new Set(expected), `${label} ${name} exact membership`);
    }
  }

  const domainBytes = fs.readFileSync(DOMAIN);
  const domainText = domainBytes.toString("utf8");
  const domain = JSON.parse(domainText);
  assert.equal(domainText, canonicalJson(domain), "follow-up domain must remain canonical JSON");
  exactKeys(domain, new Set([
    "acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule",
    "ruleOrder", "symbols", "witnessKinds",
  ]), "follow-up domain");
  assert.equal(domain.analyzerName, "supported-subset-abstract-interpreter-v1");
  assert.equal(domain.domainVersion, 1);
  const cloneRows = domain.symbols.filter((symbol) => symbol.fqn === "com.pico.spatial.core.ecs.Component"
    || symbol.fqn === "com.pico.spatial.core.ecs.Component.clone");
  assert.deepEqual(cloneRows.map(canonicalJson), COMPONENT_CANARY_SYMBOLS.map(canonicalJson),
    "the exact three clone-canary rows survive every domain phase");
  assert.equal([MIGRATED_CANARY_SYMBOLS, FULL_BATCH2B_SYMBOLS]
    .some((phase) => canonicalJson(domain.symbols) === canonicalJson(phase)), true,
  "the live domain is exactly one authorized phase");
});
test("follow-up snapshot excludes anonymous declarations but preserves genuine ambiguity", (t) => {
  const acceptedCases = new Map([
    ["one anonymous lambda", `package followup.single
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
}
`],
    ["two sibling lambdas", `package followup.siblings
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
    consume { }
}
`],
    ["Button two-callback PSI shape", `package followup.button
fun Button(onClick: () -> Unit, content: () -> Unit) = Unit
fun host() {
    Button(onClick = { }) { }
}
`],
    ["anonymous lambdas under distinct named owners", `package followup.owners
fun consume(block: () -> Unit) = Unit
fun first() {
    consume { }
}
fun second() {
    consume { }
}
`],
    ["multiple constructor declarations", `package followup.constructors
class Box() {
    constructor() : this()
}
`],
  ]);
  for (const [label, content] of acceptedCases) {
    const fileName = label.replaceAll(/[^A-Za-z0-9]+/g, "-");
    assertAcceptedEmpty(analyzeKotlin(sourceIndex([{
      path: `src/followup/accepted/${fileName}.kt`,
      content,
    }])), label);
  }

  const rejectedCases = new Map([
    ["same-owner function/property collision", `package followup.collision
fun duplicate() = Unit
val duplicate = Unit
`],
    ["same-owner real-named overload pair", `package followup.overload
fun pick(value: Int) = value
fun pick(value: String) = value
`],
    ["same-named locals under sibling anonymous lambdas", `package followup.locals
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { fun duplicate() = Unit }
    consume { fun duplicate() = Unit }
}
`],
  ]);
  for (const [label, content] of rejectedCases) {
    const fileName = label.replaceAll(/[^A-Za-z0-9]+/g, "-");
    assertRejectedEmpty(analyzeKotlin(sourceIndex([{
      path: `src/followup/rejected/${fileName}.kt`,
      content,
    }])), "ambiguous_index", label);
  }

  const expressionPath = "modules/followup/src/main/kotlin/clone/RelayPart.kt";
  assertCloneResponse(
    analyzeKotlin(sourceIndex([{ path: expressionPath, content: EXPRESSION_CLONE_SOURCE }])),
    "expression-component-clone",
    new Set([expressionPath]),
  );
  const blockPath = "modules/followup/src/main/kotlin/clone/TelemetryShard.kt";
  assertCloneResponse(
    analyzeKotlin(sourceIndex([{ path: blockPath, content: BLOCK_CLONE_SOURCE }])),
    "single-return-block-component-clone",
    new Set([blockPath]),
  );

  const psiIndexSource = fs.readFileSync(path.join(JAVA_ROOT, "PsiIndex.java"), "utf8");
  assert.equal([...psiIndexSource.matchAll(/named\.getName\(\) != null/g)].length, 1,
    "exactly one outer getName accounting guard survives");
  assert.equal([...psiIndexSource.matchAll(/named\.getNameIdentifier\(\) != null/g)].length, 2,
    "exactly two real-identifier admission/owner guards exist");
  assert.match(psiIndexSource,
    /if \(element instanceof KtNamedDeclaration named && named\.getName\(\) != null\) \{\s+if \(\+\+declarationCount > Main\.MAX_DECLARATIONS\) throw new SnapshotRejected\("limit"\);\s+if \(named\.getNameIdentifier\(\) != null\) \{\s+String key = declarationKey\(file, named\);\s+if \(declarations\.putIfAbsent\(key, source\.path\(\)\) != null\) \{\s+throw new SnapshotRejected\("ambiguous_index"\);\s+\}\s+\}\s+\}/,
    "declarationCount remains outside the nested ambiguity-map admission gate");
  assert.match(psiIndexSource,
    /if \(parent instanceof KtNamedDeclaration named && named\.getNameIdentifier\(\) != null\) \{\s+owners\.push\(named\.getName\(\)\);\s+\}/,
    "only real-identifier declarations enter owner keys");
  runSnapshotBoundaryProbe(t);
});
test("follow-up snapshot recognizes exact if and while condition containers", () => {
  const controls = new Map([
    ["if bare name", "if (flag) Unit"],
    ["if call expression", "if (ready()) Unit"],
    ["if binary", "if (flag && other) Unit"],
    ["if qualified", "if (holder.ready) Unit"],
    ["if parenthesized", "if ((flag)) Unit"],
    ["while bare name", "while (flag) { break }"],
    ["while call expression", "while (ready()) { break }"],
    ["while binary", "while (flag && other) { break }"],
    ["while qualified", "while (holder.ready) { break }"],
    ["while parenthesized", "while ((flag)) { break }"],
  ]);
  for (const [label, control] of controls) {
    const content = `package followup.conditions
class Holder(val ready: Boolean)
fun ready(): Boolean = true
fun probe(flag: Boolean, other: Boolean, holder: Holder) {
    ${control}
}
`;
    assertAcceptedEmpty(analyzeKotlin(sourceIndex([{
      path: `src/followup/conditions/${label.replaceAll(/[^A-Za-z0-9]+/g, "-")}.kt`,
      content,
    }])), label);
  }
});
test("follow-up minimally amended checkpoint stays accepted across the Batch 2B transition", (t) => {
  const projectDir = writeUncorrectedCheckpointProject(t);
  const index = loadSubmissionSources(projectDir);
  const kotlinPaths = index.files.filter((file) => file.kind === "kotlin").map((file) => file.path);
  assert.deepEqual(kotlinPaths, [
    "app/src/main/java/com/agentbench/gallery/GalleryBundle.kt",
    "app/src/main/java/com/agentbench/gallery/GalleryStage.kt",
    "app/src/main/java/com/agentbench/gallery/GalleryState.kt",
    "app/src/main/java/com/agentbench/gallery/Main.kt",
    "app/src/main/java/com/agentbench/gallery/Orbit.kt",
    "app/src/main/java/com/agentbench/gallery/PlaneSession.kt",
    "app/src/main/java/com/agentbench/gallery/platform/LaunchActivity.kt",
    "app/src/main/java/com/agentbench/gallery/platform/SpatialApplication.kt",
    "app/src/test/java/com/agentbench/gallery/GalleryStateTest.kt",
  ], "the minimally amended checkpoint retains its exact nine Kotlin paths");
  const source = (pathName) => {
    const matches = index.files.filter((file) => file.path === pathName);
    assert.equal(matches.length, 1, pathName);
    return matches[0].original;
  };
  const state = source("app/src/main/java/com/agentbench/gallery/GalleryState.kt");
  assert.equal(countOccurrences(state, "val instance: BenchmarkStore get() = retained"), 1,
    "standard strong property");
  assert.equal(/\bfun\s+instance\s*\(/.test(state), false, "dead standard function is absent");
  const main = source("app/src/main/java/com/agentbench/gallery/Main.kt");
  assert.equal(main.includes('store.select("vase")'), false, "raw shared read/write defect");
  assert.equal(countOccurrences(main, "closeAndReopen("), 1,
    "raw close/reopen helper remains unreachable because only its declaration exists");
  assert.equal(main.includes("navigator.closeAndReopen(store)"), false, "raw reopen call remains absent");
  const plane = source("app/src/main/java/com/agentbench/gallery/PlaneSession.kt");
  assert.equal(countOccurrences(plane, "repeat(MAX_ANCHOR_RETRIES)"), 1, "raw retry loop");
  assert.equal(countOccurrences(plane, "return@repeat"), 1, "raw retry defect");
  assert.deepEqual(UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS, [
    "state.shared-read-write",
    "state.reopen-wiring",
    "plane.retry-readiness",
  ]);

  const equivalent = loadSubmissionSources(writeEquivalentReopenProject(t));
  const equivalentStates = equivalent.files.filter((file) =>
    file.path === "app/src/main/java/com/agentbench/gallery/GalleryState.kt");
  assert.equal(equivalentStates.length, 1);
  assert.equal(countOccurrences(equivalentStates[0].original,
    "fun current(): GallerySessionRepository = retained"), 1,
    "equivalent current() function remains independently named");

  const response = analyzeKotlin(index);
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  const observedRuleIds = response.claims.map((claim) => claim.ruleId);
  const completeRuleIds = RULE_ORDER
    .filter((ruleId) => !UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS.includes(ruleId));
  if (liveDomainPhase() === "migrated") {
    assert.deepEqual(observedRuleIds, ["ecs.component-clone"],
      "the migrated phase emits exactly the clone canary on the uncorrected checkpoint");
  } else {
    assert.deepEqual(observedRuleIds, completeRuleIds,
      "the FULL phase emits exactly the thirteen non-defect rules on the uncorrected checkpoint");
  }
  assert.equal(response.nodes.length > 0, true, "an emitted claim carries witness nodes");
});
test("domain build boundary rejects malformed noncanonical and closed-schema tracked bytes before publication", (t) => {
  const replica = analyzerReplica(t);
  const domainPath = path.join(replica.analyzer, "domain-v1.json");
  const canonical = fs.readFileSync(domainPath);
  const parsed = JSON.parse(canonical);
  const beforeJar = fs.readFileSync(path.join(replica.artifact, "analyzer-v1.jar"));
  const beforeReceipt = fs.readFileSync(path.join(replica.artifact, "analyzer-build-receipt-v1.json"));
  const withUnknownKey = structuredClone(parsed); withUnknownKey.surprise = true;
  const missingField = structuredClone(parsed); delete missingField.witnessKinds;
  const invalidEnum = structuredClone(parsed); invalidEnum.symbols[0].kind = "mystery_constructor";
  const invalidRegistry = structuredClone(parsed); invalidRegistry.proofFormsByRule["ecs.component-clone"] = ["expression-component-clone"];
  const attacks = [
    ["malformed", Buffer.from("{")],
    ["noncanonical whitespace", Buffer.concat([Buffer.from(" "), canonical])],
    ["duplicate key", Buffer.from(canonical.toString("utf8").replace('"domainVersion":1', '"domainVersion":1,"domainVersion":1'))],
    ["unknown field", Buffer.from(canonicalJson(withUnknownKey))],
    ["missing field", Buffer.from(canonicalJson(missingField))],
    ["closed enum", Buffer.from(canonicalJson(invalidEnum))],
    ["registry mismatch", Buffer.from(canonicalJson(invalidRegistry))],
  ];
  for (const [label, bytes] of attacks) {
    fs.writeFileSync(domainPath, bytes);
    assert.notEqual(runScrubbedNode(replica.build, ["verify"]).status, 0, `${label} verify`);
    const rejected = runScrubbedNode(replica.build, ["clean-build-twice"]);
    assert.notEqual(rejected.status, 0, `${label} clean build`);
    assert.match(rejected.stderr, /domain|canonical|JSON|schema|vocabulary|key|kind/i, label);
    assert.deepEqual(fs.readFileSync(path.join(replica.artifact, "analyzer-v1.jar")), beforeJar, `${label} JAR publication`);
    assert.deepEqual(fs.readFileSync(path.join(replica.artifact, "analyzer-build-receipt-v1.json")), beforeReceipt, `${label} receipt publication`);
    fs.writeFileSync(domainPath, canonical);
    assert.equal(runScrubbedNode(replica.build, ["verify"]).status, 0, `${label} restored verify`);
  }
});
test("analyzer artifact semantic handoff inventory binds five sources, 30 entries, and actual class references", () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const expectedInputs = [
    "benchmarks/spatial-agent-bench/analyzer/build-analyzer.mjs",
    "benchmarks/spatial-agent-bench/analyzer/dependencies-v1.json",
    "benchmarks/spatial-agent-bench/analyzer/domain-v1.json",
    ...EXPECTED_JAVA_SOURCES,
    "benchmarks/spatial-agent-bench/analyzer/toolchain-v1.json",
    "benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs",
  ].sort();
  assert.deepEqual(receipt.sourceInputs.map((row) => row.path), expectedInputs);
  assert.deepEqual(receipt.sourceInputs.filter((row) => row.path.endsWith(".java")).map((row) => row.path), EXPECTED_JAVA_SOURCES);
  for (const relative of EXPECTED_JAVA_SOURCES) assert.equal(fs.existsSync(path.join(ROOT, ...relative.split("/"))), true, relative);
  assert.deepEqual(receipt.build.jarEntries, EXPECTED_JAR_ENTRIES);
  assert.equal(Array.isArray(receipt.build.classReferences) && receipt.build.classReferences.length > 0, true);
  assert.deepEqual(receipt.build.classReferences, [...new Set(receipt.build.classReferences)].sort());
  assert.equal(hash(fs.readFileSync(path.join(JAVA_ROOT, "Protocol.java"))), "55adda83933f1c17a366689f5e311ef8f596a157f38ea33b1c8cd882e2bf1299");
});
test("semantic handoff fake accepts canonical witnesses and describe remains semantically empty", async (t) => {
  const scenario = { value: "semantic-valid" };
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, scenario, calls);
  const index = sourceIndex([{ path: "src/fake/Semantic.kt", content: SEMANTIC_FAKE_SOURCE }]);
  const first = bridge.analyzeKotlin(index);
  assertCloneResponse(first, "expression-component-clone", new Set(["src/fake/Semantic.kt"]));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.nodes[0]), true);
  assert.equal(Object.isFrozen(first.claims[0].witnessNodeIds), true);
  assertCloneResponse(bridge.analyzeKotlin(index), "expression-component-clone", new Set(["src/fake/Semantic.kt"]));
  assert.equal(calls.count, 1, "validated semantic bytes must be cacheable");
  scenario.value = "semantic-valid-mixed";
  const mixedPath = "src/fake/MixedSemantic.kt";
  const mixedSource = `${SEMANTIC_FAKE_SOURCE}\nfun literalBoundary(): Int = listOf(7).first()\n`;
  const mixed = bridge.analyzeKotlin(sourceIndex([{ path: mixedPath, content: mixedSource }]));
  assertCloneResponse(mixed, "expression-component-clone", new Set([mixedPath]));
  assert.equal(mixed.nodes.some((node) => node.structuralToken === true), true);
  const literal = mixed.nodes.find((node) => node.structuralToken === false && node.kind === "argument");
  assert.equal(literal !== undefined, true);
  assert.equal(mixedSource.slice(literal.startUtf16, literal.endUtf16), "7", "literal witness must be a real call-argument span");
  scenario.value = "describe-semantic";
  assert.throws(() => bridge.describeKotlinAnalyzer(), /describe|semantic|nodes/i);
  assert.equal(calls.count, 3);
});
test("semantic handoff validator rejects the full response node claim witness union and cache mutation matrix", async (t) => {
  const scenario = { value: "semantic-valid" };
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, scenario, calls);
  const faults = [
    ["semantic-unknown-response-key", /unknown|missing.*key/i],
    ["semantic-rejected-nodes", /rejected|nodes|semantic/i],
    ["semantic-rejected-claims", /rejected|claims|semantic/i],
    ["semantic-unknown-node-key", /node.*key|unknown|missing/i],
    ["semantic-missing-node-key", /node.*key|unknown|missing/i],
    ["semantic-unknown-node-kind", /node.*kind|witness.*kind/i],
    ["semantic-path-unnormalized", /path/i],
    ["semantic-path-unknown", /path|request file/i],
    ["semantic-file-hash", /file.*hash|sha256/i],
    ["semantic-span-negative", /span|offset|start/i],
    ["semantic-span-reversed", /span|offset|end/i],
    ["semantic-span-out-of-bounds", /span|bound|offset/i],
    ["semantic-surrogate-start", /surrogate|boundary/i],
    ["semantic-surrogate-end", /surrogate|boundary/i],
    ["semantic-text-hash", /text.*hash|substring/i],
    ["semantic-node-id", /node.*id|digest/i],
    ["semantic-node-order", /node.*order|sorted/i],
    ["semantic-node-duplicate", /node.*duplicate|unique|order/i],
    ["semantic-node-over-limit", /node.*limit|node.*bound|too many/i],
    ["semantic-unknown-claim-key", /claim.*key|unknown|missing/i],
    ["semantic-missing-claim-key", /claim.*key|unknown|missing/i],
    ["semantic-unknown-rule", /rule/i],
    ["semantic-unknown-proof", /proof/i],
    ["semantic-duplicate-claim", /claim.*duplicate|one claim|order/i],
    ["semantic-claim-order", /claim.*order|rule.*order/i],
    ["semantic-claim-over-limit", /claim.*limit|claim.*bound|too many/i],
    ["semantic-empty-witness-empty-catalog", /witness|empty/i],
    ["semantic-empty-catalog", /catalog|witness|node/i],
    ["semantic-witness-order", /witness.*order|sorted/i],
    ["semantic-witness-duplicate", /witness.*duplicate|unique|order/i],
    ["semantic-witness-unknown", /witness|catalog|node/i],
    ["semantic-witness-digest", /witness.*digest/i],
    ["semantic-witness-over-limit", /witness.*(?:limit|bound|cap)|too many/i],
    ["semantic-total-witness-over-limit", /total.*witness|witness.*(?:limit|bound|cap)|too many/i],
    ["semantic-literal-only", /literal|structural/i],
    ["semantic-nonstructural-nonargument", /nonstructural|literal|argument/i],
    ["semantic-structural-type", /structural.*boolean|structural.*type/i],
    ["semantic-union-orphan", /union|orphan|catalog/i],
    ["semantic-union-missing", /union|missing|catalog|witness/i],
  ];
  for (const [index, [fault, expected]] of faults.entries()) {
    const project = sourceIndex([{
      path: `src/fake/Mutation${String(index).padStart(2, "0")}.kt`,
      content: `${SEMANTIC_FAKE_SOURCE}\n// mutation ${index}\n`,
    }]);
    scenario.value = fault;
    assert.throws(() => bridge.analyzeKotlin(project), expected, fault);
    scenario.value = "semantic-valid";
    assertCloneResponse(bridge.analyzeKotlin(project), "expression-component-clone", new Set([project.files[0].path]));
  }
  assert.equal(calls.count, faults.length * 2, "invalid semantic bytes must never enter the cache");
});
test("semantic handoff real child proves expression and renamed block clone forms all-or-nothing", () => {
  const expressionPath = "modules/canary/src/main/kotlin/alpha/RelayPart.kt";
  const expression = analyzeKotlin(sourceIndex([{ path: expressionPath, content: EXPRESSION_CLONE_SOURCE }]));
  assertCloneResponse(expression, "expression-component-clone", new Set([expressionPath]));

  const blockPath = "modules/renamed/src/main/kotlin/beta/TelemetryShard.kt";
  const block = analyzeKotlin(sourceIndex([{ path: blockPath, content: BLOCK_CLONE_SOURCE }]));
  assertCloneResponse(block, "single-return-block-component-clone", new Set([blockPath]));

  const expressionZero = analyzeKotlin(sourceIndex([{
    path: "modules/canary/src/main/kotlin/negative/RelayPart.kt",
    content: EXPRESSION_CLONE_SOURCE.replace("RelayPart(active, phase)", "RelayPart()"),
  }]));
  assert.equal(expressionZero.analysisStatus, "accepted");
  assert.deepEqual(expressionZero.nodes, []);
  assert.deepEqual(expressionZero.claims, []);

  const blockZero = analyzeKotlin(sourceIndex([{
    path: "modules/renamed/src/main/kotlin/negative/TelemetryShard.kt",
    content: BLOCK_CLONE_SOURCE.replace("TelemetryShard(ready = ready, sweep = sweep)", "TelemetryShard()"),
  }]));
  assert.equal(blockZero.analysisStatus, "accepted");
  assert.deepEqual(blockZero.nodes, []);
  assert.deepEqual(blockZero.claims, []);

  const malformed = analyzeKotlin(sourceIndex([
    { path: expressionPath, content: EXPRESSION_CLONE_SOURCE },
    { path: "modules/canary/src/main/kotlin/Broken.kt", content: "package canary.broken\nfun broken( {\n" },
  ]));
  assert.equal(malformed.analysisStatus, "rejected");
  assert.equal(malformed.rejectionCode, "parse");
  assert.deepEqual(malformed.nodes, []);
  assert.deepEqual(malformed.claims, []);
});
test("semantic handoff clone canary rejects shadowed, parameterized, spread, and ineligible declarations", () => {
  const variants = new Map([
    ["class type parameter shadows imported Component", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "class RelayPart<Component>(")],
    ["clone type parameter shadows RelayPart", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone(): RelayPart", "override fun <RelayPart> clone(): RelayPart")],
    ["same-file Component typealias shadows import", EXPRESSION_CLONE_SOURCE
      .replace("import com.pico.spatial.core.ecs.Component\n", "import com.pico.spatial.core.ecs.Component\n\ntypealias Component = Substitute\n")],
    ["parameterized Component super call", EXPRESSION_CLONE_SOURCE
      .replace(": Component()", ": Component<String>()")],
    ["star-projected Component super call", EXPRESSION_CLONE_SOURCE
      .replace(": Component()", ": Component<*>()")],
    ["bare Component super type", EXPRESSION_CLONE_SOURCE
      .replace(": Component()", ": Component")],
    ["additional zero-argument super constructor", EXPRESSION_CLONE_SOURCE
      .replace("import com.pico.spatial.core.ecs.Component\n", "import com.pico.spatial.core.ecs.Component\n\nopen class Other\n")
      .replace(": Component()", ": Component(), Other()")],
    ["delegated super type", EXPRESSION_CLONE_SOURCE
      .replace("import com.pico.spatial.core.ecs.Component\n", "import com.pico.spatial.core.ecs.Component\n\ninterface Marker\nval marker = object : Marker {}\n")
      .replace(": Component()", ": Component(), Marker by marker")],
    ["parameterized clone return", EXPRESSION_CLONE_SOURCE
      .replace("clone(): RelayPart", "clone(): RelayPart<String>")],
    ["foreign qualified clone return", EXPRESSION_CLONE_SOURCE
      .replace("clone(): RelayPart", "clone(): foreign.RelayPart")],
    ["parameterized RelayPart constructor call", EXPRESSION_CLONE_SOURCE
      .replace("= RelayPart(active, phase)", "= RelayPart<String>(active, phase)")],
    ["star-projected RelayPart constructor call", EXPRESSION_CLONE_SOURCE
      .replace("= RelayPart(active, phase)", "= RelayPart<*>(active, phase)")],
    ["spread RelayPart constructor argument", EXPRESSION_CLONE_SOURCE
      .replace("RelayPart(active, phase)", "RelayPart(*active, phase)")],
    ["named spread RelayPart constructor argument", EXPRESSION_CLONE_SOURCE
      .replace("RelayPart(active, phase)", "RelayPart(active = *active, phase = phase)")],
    ["abstract candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "abstract class RelayPart(")],
    ["annotation candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "annotation class RelayPart(")],
    ["value candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "value class RelayPart(")],
    ["enum candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "enum class RelayPart(")
      .replace(") : Component() {", ") : Component() {\n    ;")],
    ["sealed candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "sealed class RelayPart(")],
    ["mutating initializer block", EXPRESSION_CLONE_SOURCE
      .replace(") : Component() {", ") : Component() {\n    init { active = !active }")],
    ["construction-time body property initializer", EXPRESSION_CLONE_SOURCE
      .replace(") : Component() {", ") : Component() {\n    val eager = phase.also { phase += 1 }")],
    ["construction-time delegated body property", EXPRESSION_CLONE_SOURCE
      .replace(") : Component() {", ") : Component() {\n    val eager by run { phase += 1; lazy { 0 } }")],
    ["context receiver on candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "context(String)\nclass RelayPart(")],
    ["context receiver on clone", EXPRESSION_CLONE_SOURCE
      .replace("    override fun clone(): RelayPart", "    context(String)\n    override fun clone(): RelayPart")],
    ["suspend clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "override suspend fun clone()")],
    ["private clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "private override fun clone()")],
    ["protected clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "protected override fun clone()")],
    ["internal clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "internal override fun clone()")],
    ["local nested candidate exclusion", `package canary.alpha

import com.pico.spatial.core.ecs.Component

fun host() {
    class RelayPart(
        val active: Boolean = true,
        val phase: Int = 0,
    ) : Component() {
        override fun clone(): RelayPart = RelayPart(active, phase)
    }
    fun competitor() {
        val RelayPart: (Boolean, Int) -> RelayPart = { active, phase ->
            RelayPart(active, phase)
        }
        RelayPart(true, 0)
    }
}`],
    ["wrong-labeled block return", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone(): RelayPart = RelayPart(active, phase)",
        "override fun clone(): RelayPart {\n        return@wrong RelayPart(active, phase)\n    }")],
  ]);
  for (const [name, content] of variants) {
    const response = analyzeKotlin(sourceIndex([{ path: `modules/canary/src/main/kotlin/negative/${name.replace(/[^A-Za-z0-9]+/g, "-")}.kt`, content }]));
    assert.equal(response.analysisStatus, "accepted", name);
    assert.equal(response.rejectionCode, null, name);
    assert.deepEqual(response.nodes, [], name);
    assert.deepEqual(response.claims, [], name);
  }
});
test("semantic handoff real child accepts a complete default-package source without claims", () => {
  const response = analyzeKotlin(sourceIndex([{
    path: "src/defaultpkg/DefaultRoot.kt",
    content: DEFAULT_PACKAGE_SOURCE,
  }]));
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  assert.deepEqual(response.nodes, []);
  assert.deepEqual(response.claims, []);
});
test("semantic handoff real analyzer accepts the exact 8388608-byte trivia-heavy boundary", () => {
  const rows = Array.from({ length: 8 }, (_, index) => {
    const prefix = `package stress.trivia${index}\n`;
    return {
      path: `src/stress/Trivia${index}.kt`,
      content: `${prefix}//${"x".repeat(1_048_576 - Buffer.byteLength(prefix) - 3)}\n`,
    };
  });
  assert.equal(rows.every((row) => Buffer.byteLength(row.content) === 1_048_576), true);
  const index = sourceIndex(rows);
  assert.equal(index.totalBytes, 8_388_608);
  const response = analyzeKotlin(index);
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  assert.deepEqual(response.nodes, []);
  assert.deepEqual(response.claims, []);
});
test("semantic handoff CatalogProbe compiles only against the receipt-bound frozen snapshot API", (t) => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-catalog-probe");
  const sourceRoot = path.join(temporary, "source");
  const classes = path.join(temporary, "classes");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  for (const directory of [sourceRoot, classes, home, temporaryFiles]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const catalogKotlin = `package catalog.matrix

import androidx.compose.runtime.Composable
import kotlin.String as Text

// catalog-trivia-line
/* catalog-trivia-block */
annotation class Marker(val name: String)
sealed interface SealedThing
open class Base
object Singleton

@Composable
fun composed() {
    targetLambda(1) { number -> number + 1 }
}

@Marker(name = "box")
data class Box<T>(
    val value: Int = 1,
    var text: Text = "idle",
) : Base(), Runnable {
    companion object { const val CONST: Int = 1 }
    override fun run() {}
    suspend fun suspending() = target()
    private fun hidden() {}
    fun body(arg: Int): Int {
        var local = arg
        local = local + 1
        local += 1
        val binary = local + 1
        val prefix = -binary
        local++
        val indexed = listOf<Int>(1)[0]
        val conditional = if (binary > 0) binary else 0
        val chosen = when (binary) {
            in 1..2 -> 1
            is Int -> 2
            else -> 0
        }
        try { target() } catch (error: Exception) { target() }
        outer@ for (item in listOf(1)) {
            if (item == 0) continue@outer else break@outer
        }
        while (local > 0) { local-- }
        do { local-- } while (local > 0)
        val callable = ::target
        val klass = Box::class
        val lambda: (Int) -> Int = { number -> number + 1 }
        val safe = text?.length
        val qualified = this.text.length
        val template = "value=$binary"
        val floating = 1.0f
        val truth = true
        val absent: Text? = null
        val fallback = absent ?: "fallback"
        val cast = text as Text
        val named = Box<Int>(value = 1, text = "named")
        val punctuation = 1; local = punctuation
        return target()
    }
}

fun target(): Int = 1
`;
  const probeSource = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
public final class CatalogProbe {
  private static final String LIMIT_PACKAGE = "package limits\\n";
  private static final int PSI_LINE_COMMENTS = 249_996;
  private static final int DECLARATION_LIMIT = 25_000;
  private static final int CALL_MAX_ACCEPTED = 71_425;
  private static final int CALL_LIMIT = 100_000;
  private static final int MAXIMAL_COMMENTS = 149_996;
  private static final String CATALOG = ${JSON.stringify(catalogKotlin)};
  private static final String DEFAULT_PACKAGE = ${JSON.stringify(DEFAULT_PACKAGE_SOURCE)};
  private CatalogProbe() {}

  private static final class Digest {
    private final MessageDigest value;
    Digest(String domain) {
      try { value = MessageDigest.getInstance("SHA-256"); }
      catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
      add(domain);
    }
    void add(String field) {
      if (field == null) { addLength(-1); return; }
      byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
      addLength(bytes.length);
      value.update(bytes);
    }
    void add(int field) { add(Integer.toString(field)); }
    void add(boolean field) { add(Boolean.toString(field)); }
    private void addLength(int length) {
      value.update((byte) (length >>> 24)); value.update((byte) (length >>> 16));
      value.update((byte) (length >>> 8)); value.update((byte) length);
    }
    String finish() { return hex(value.digest()); }
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.length * 2);
    for (byte item : bytes) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    return result.toString();
  }

  private static String sha256(String value) {
    try {
      MessageDigest raw = MessageDigest.getInstance("SHA-256");
      return hex(raw.digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
  }

  private static PsiIndex.Source source(String path, String content) {
    return new PsiIndex.Source(path, sha256(content), content);
  }

  private static List<PsiIndex.Source> one(String path, String content) {
    return List.of(source(path, content));
  }

  private static String comments(int count) { return LIMIT_PACKAGE + "//\\n".repeat(count); }

  private static String declarations(int count, int comments) {
    StringBuilder content = new StringBuilder(LIMIT_PACKAGE.length() + count * 14 + comments * 3);
    content.append(LIMIT_PACKAGE);
    for (int index = 0; index < count; index++) content.append("val p").append(index).append("=0\\n");
    content.append("//\\n".repeat(comments));
    return content.toString();
  }

  private static String calls(int count) {
    StringBuilder content = new StringBuilder(LIMIT_PACKAGE.length() + 16 + count * 4);
    content.append(LIMIT_PACKAGE).append("fun host(){");
    for (int index = 0; index < count; index++) content.append("f();");
    return content.append("}\\n").toString();
  }

  private static int compareEdges(PsiIndex.Edge left, PsiIndex.Edge right) {
    int order = Integer.compare(left.fromNodeId(), right.fromNodeId());
    if (order == 0) order = Integer.compare(left.role().ordinal(), right.role().ordinal());
    if (order == 0) order = Integer.compare(left.ordinal(), right.ordinal());
    if (order == 0) order = Integer.compare(left.toNodeId(), right.toNodeId());
    return order;
  }

  private static <E extends Enum<E>> String observed(E[] values, Set<E> present) {
    StringBuilder result = new StringBuilder();
    for (E value : values) {
      if (!present.contains(value)) continue;
      if (result.length() != 0) result.append(',');
      result.append(value.name());
    }
    return result.toString();
  }

  private static String filesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-files-v1");
    for (PsiIndex.FileUnit file : program.files()) {
      digest.add(file.id()); digest.add(file.path()); digest.add(file.sha256()); digest.add(file.utf16Length());
      digest.add(file.packageName()); digest.add(file.importIds().size());
      for (int id : file.importIds()) digest.add(id);
    }
    return digest.finish();
  }

  private static String importsHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-imports-v1");
    for (PsiIndex.ImportEntry entry : program.imports()) {
      digest.add(entry.id()); digest.add(entry.fileId()); digest.add(entry.fqName()); digest.add(entry.exposedName());
      digest.add(entry.alias()); digest.add(entry.syntaxNodeId()); digest.add(entry.witnessNodeId());
    }
    return digest.finish();
  }

  private static String tokensHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-tokens-v1");
    for (PsiIndex.Token token : program.tokens()) {
      digest.add(token.id()); digest.add(token.fileId()); digest.add(token.startUtf16()); digest.add(token.endUtf16());
      digest.add(token.kind().name()); digest.add(token.value()); digest.add(token.textSha256()); digest.add(token.structuralToken());
    }
    return digest.finish();
  }

  private static String nodesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-nodes-v1");
    for (PsiIndex.Node node : program.nodes()) {
      digest.add(node.id()); digest.add(node.fileId()); digest.add(node.kind().name()); digest.add(node.startUtf16());
      digest.add(node.endUtf16()); digest.add(node.firstTokenId()); digest.add(node.tokenCount()); digest.add(node.name());
      digest.add(node.value()); digest.add(node.flags().size());
      for (PsiIndex.NodeFlag flag : node.flags()) digest.add(flag.name());
      digest.add(node.witnessNodeId());
    }
    return digest.finish();
  }

  private static String edgesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-edges-v1");
    for (PsiIndex.Edge edge : program.edges()) {
      digest.add(edge.fromNodeId()); digest.add(edge.role().name()); digest.add(edge.ordinal()); digest.add(edge.toNodeId());
    }
    return digest.finish();
  }

  private static String witnessesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-witnesses-v1");
    for (PsiIndex.WitnessNode witness : program.witnesses()) {
      digest.add(witness.nodeId()); digest.add(witness.fileId()); digest.add(witness.startUtf16()); digest.add(witness.endUtf16());
      digest.add(witness.kind().name()); digest.add(witness.textSha256()); digest.add(witness.structuralToken());
    }
    return digest.finish();
  }

  private static String witnessIdentity(PsiIndex.WitnessNode witness, PsiIndex.FileUnit file) {
    String kind = witness.kind().name().toLowerCase(Locale.ROOT);
    String canonical = "{\\\"endUtf16\\\":" + witness.endUtf16()
        + ",\\\"fileSha256\\\":\\\"" + file.sha256() + "\\\",\\\"kind\\\":\\\"" + kind
        + "\\\",\\\"path\\\":\\\"" + file.path() + "\\\",\\\"startUtf16\\\":" + witness.startUtf16()
        + ",\\\"structuralToken\\\":" + witness.structuralToken()
        + ",\\\"textSha256\\\":\\\"" + witness.textSha256() + "\\\"}";
    return sha256(canonical);
  }

  private static int expectedFirstToken(PsiIndex.Program program, PsiIndex.Node node) {
    int index = 0;
    while (index < program.tokens().size()) {
      PsiIndex.Token token = program.tokens().get(index);
      if (token.fileId() > node.fileId() || (token.fileId() == node.fileId()
          && token.startUtf16() >= node.startUtf16())) break;
      index++;
    }
    return index;
  }

  private static String summarize(PsiIndex.Program program, List<PsiIndex.Source> sources) {
    int denseErrors = 0, hashErrors = 0, rangeErrors = 0, tokenSliceErrors = 0;
    int lexicalErrors = 0, edgeErrors = 0, importErrors = 0, witnessErrors = 0, triviaErrors = 0;
    EnumSet<PsiIndex.NodeKind> nodeKinds = EnumSet.noneOf(PsiIndex.NodeKind.class);
    EnumSet<PsiIndex.NodeFlag> nodeFlags = EnumSet.noneOf(PsiIndex.NodeFlag.class);
    EnumSet<PsiIndex.EdgeRole> edgeRoles = EnumSet.noneOf(PsiIndex.EdgeRole.class);
    EnumSet<PsiIndex.TokenKind> tokenKinds = EnumSet.noneOf(PsiIndex.TokenKind.class);
    EnumSet<PsiIndex.WitnessKind> witnessKinds = EnumSet.noneOf(PsiIndex.WitnessKind.class);
    TreeSet<String> operators = new TreeSet<>();
    Map<String, PsiIndex.Source> sourceByPath = new HashMap<>();
    for (PsiIndex.Source item : sources) sourceByPath.put(item.path(), item);
    int sourceBytes = 0, maxSourceBytes = 0;
    for (PsiIndex.Source item : sources) {
      int bytes = item.content().getBytes(StandardCharsets.UTF_8).length;
      sourceBytes += bytes; maxSourceBytes = Math.max(maxSourceBytes, bytes);
    }

    int expectedImport = 0;
    for (int index = 0; index < program.files().size(); index++) {
      PsiIndex.FileUnit file = program.files().get(index);
      PsiIndex.Source original = sourceByPath.get(file.path());
      if (file.id() != index) denseErrors++;
      if (original == null || !original.sha256().equals(file.sha256())
          || original.content().length() != file.utf16Length()) hashErrors++;
      for (int importId : file.importIds()) if (importId != expectedImport++) denseErrors++;
    }
    if (expectedImport != program.imports().size()) importErrors++;

    for (int index = 0; index < program.imports().size(); index++) {
      PsiIndex.ImportEntry entry = program.imports().get(index);
      if (entry.id() != index) denseErrors++;
      if (entry.fileId() < 0 || entry.fileId() >= program.files().size()
          || entry.syntaxNodeId() < 0 || entry.syntaxNodeId() >= program.nodes().size()) importErrors++;
      else {
        PsiIndex.Node syntax = program.nodes().get(entry.syntaxNodeId());
        if (syntax.fileId() != entry.fileId() || !entry.witnessNodeId().equals(syntax.witnessNodeId())) importErrors++;
      }
    }

    int priorFile = -1, priorEnd = -1;
    for (int index = 0; index < program.tokens().size(); index++) {
      PsiIndex.Token token = program.tokens().get(index);
      tokenKinds.add(token.kind());
      if (token.id() != index) denseErrors++;
      if (token.fileId() < 0 || token.fileId() >= program.files().size()) { rangeErrors++; continue; }
      PsiIndex.Source original = sourceByPath.get(program.files().get(token.fileId()).path());
      if (token.startUtf16() < 0 || token.endUtf16() <= token.startUtf16()
          || token.endUtf16() > original.content().length()) { rangeErrors++; continue; }
      String text = original.content().substring(token.startUtf16(), token.endUtf16());
      if (!text.equals(token.value()) || !sha256(text).equals(token.textSha256())) hashErrors++;
      boolean structural = token.kind() == PsiIndex.TokenKind.IDENTIFIER || token.kind() == PsiIndex.TokenKind.KEYWORD
          || token.kind() == PsiIndex.TokenKind.OPERATOR;
      if (structural != token.structuralToken()) hashErrors++;
      if (token.fileId() < priorFile || (token.fileId() == priorFile && token.startUtf16() < priorEnd)) rangeErrors++;
      priorFile = token.fileId(); priorEnd = token.endUtf16();
      if (token.value().isBlank() || token.value().contains("catalog-trivia")
          || (token.kind() != PsiIndex.TokenKind.OPERATOR && token.kind() != PsiIndex.TokenKind.STRING_LITERAL
          && Set.of("(", ")", "{", "}", "[", "]", ",", ":", ";", ".", "@").contains(token.value()))) triviaErrors++;
    }

    int[] fileRoots = new int[program.files().size()];
    int[] lexicalInbound = new int[program.nodes().size()];
    Set<String> nodeIdentities = new HashSet<>();
    for (int index = 0; index < program.nodes().size(); index++) {
      PsiIndex.Node node = program.nodes().get(index);
      nodeKinds.add(node.kind()); nodeFlags.addAll(node.flags());
      if (node.kind() == PsiIndex.NodeKind.ASSIGNMENT || node.kind() == PsiIndex.NodeKind.BINARY
          || node.kind() == PsiIndex.NodeKind.PREFIX || node.kind() == PsiIndex.NodeKind.POSTFIX) operators.add(node.value());
      if (node.id() != index) denseErrors++;
      if (node.fileId() < 0 || node.fileId() >= program.files().size()) { rangeErrors++; continue; }
      PsiIndex.FileUnit file = program.files().get(node.fileId());
      if (node.startUtf16() < 0 || node.endUtf16() < node.startUtf16() || node.endUtf16() > file.utf16Length()) rangeErrors++;
      if (!nodeIdentities.add(node.fileId() + ":" + node.startUtf16() + ":" + node.endUtf16() + ":" + node.kind())) denseErrors++;
      int first = expectedFirstToken(program, node), count = 0;
      while (first + count < program.tokens().size()) {
        PsiIndex.Token token = program.tokens().get(first + count);
        if (token.fileId() != node.fileId() || token.startUtf16() >= node.endUtf16()) break;
        if (token.startUtf16() < node.startUtf16() || token.endUtf16() > node.endUtf16()) tokenSliceErrors++;
        count++;
      }
      if (node.firstTokenId() != first || node.tokenCount() != count) tokenSliceErrors++;
      if (node.kind() == PsiIndex.NodeKind.FILE) fileRoots[node.fileId()]++;
    }
    for (int roots : fileRoots) if (roots != 1) lexicalErrors++;

    Map<String, Integer> nextOrdinal = new HashMap<>();
    PsiIndex.Edge prior = null;
    for (PsiIndex.Edge edge : program.edges()) {
      edgeRoles.add(edge.role());
      if (edge.fromNodeId() < 0 || edge.fromNodeId() >= program.nodes().size()
          || edge.toNodeId() < 0 || edge.toNodeId() >= program.nodes().size()) { edgeErrors++; continue; }
      if (prior != null && compareEdges(prior, edge) >= 0) edgeErrors++;
      PsiIndex.Node from = program.nodes().get(edge.fromNodeId()), to = program.nodes().get(edge.toNodeId());
      if (from.fileId() != to.fileId() || from.startUtf16() > to.startUtf16() || from.endUtf16() < to.endUtf16()) edgeErrors++;
      String slot = edge.fromNodeId() + ":" + edge.role();
      int expected = nextOrdinal.getOrDefault(slot, 0);
      if (edge.ordinal() != expected) edgeErrors++;
      nextOrdinal.put(slot, expected + 1);
      if (edge.role() == PsiIndex.EdgeRole.LEXICAL_OWNER) lexicalInbound[edge.toNodeId()]++;
      prior = edge;
    }
    for (PsiIndex.Node node : program.nodes()) {
      int expected = node.kind() == PsiIndex.NodeKind.FILE ? 0 : 1;
      if (lexicalInbound[node.id()] != expected) lexicalErrors++;
    }

    Set<String> witnessIds = new HashSet<>(), nodeWitnessIds = new HashSet<>();
    String priorWitness = null;
    for (PsiIndex.WitnessNode witness : program.witnesses()) {
      witnessKinds.add(witness.kind());
      if (!witnessIds.add(witness.nodeId()) || (priorWitness != null && priorWitness.compareTo(witness.nodeId()) >= 0)) witnessErrors++;
      if (witness.fileId() < 0 || witness.fileId() >= program.files().size()) { witnessErrors++; continue; }
      PsiIndex.FileUnit file = program.files().get(witness.fileId());
      PsiIndex.Source original = sourceByPath.get(file.path());
      if (witness.startUtf16() < 0 || witness.endUtf16() > original.content().length()
          || witness.endUtf16() <= witness.startUtf16()) { witnessErrors++; continue; }
      String text = original.content().substring(witness.startUtf16(), witness.endUtf16());
      if (!sha256(text).equals(witness.textSha256()) || !witnessIdentity(witness, file).equals(witness.nodeId())) witnessErrors++;
      if (!witness.structuralToken() && witness.kind() != PsiIndex.WitnessKind.ARGUMENT) witnessErrors++;
      priorWitness = witness.nodeId();
    }
    for (PsiIndex.Node node : program.nodes()) if (node.witnessNodeId() != null) {
      if (!nodeWitnessIds.add(node.witnessNodeId()) || !witnessIds.contains(node.witnessNodeId())) witnessErrors++;
    }
    if (!nodeWitnessIds.equals(witnessIds)) witnessErrors++;

    String filesHash = filesHash(program), importsHash = importsHash(program), tokensHash = tokensHash(program);
    String nodesHash = nodesHash(program), edgesHash = edgesHash(program), witnessesHash = witnessesHash(program);
    Digest whole = new Digest("catalog-program-v1");
    whole.add(program.psiNodeCount()); whole.add(program.declarationCount()); whole.add(program.callSiteCount());
    whole.add(filesHash); whole.add(importsHash); whole.add(tokensHash); whole.add(nodesHash); whole.add(edgesHash); whole.add(witnessesHash);
    StringBuilder importSummary = new StringBuilder();
    for (PsiIndex.ImportEntry entry : program.imports()) {
      if (importSummary.length() != 0) importSummary.append(';');
      importSummary.append(entry.fqName());
      if (entry.alias() != null) importSummary.append(" as ").append(entry.alias());
      importSummary.append("->").append(entry.exposedName());
    }
    List<String> rows = new ArrayList<>();
    rows.add("status=accepted"); rows.add("psi=" + program.psiNodeCount());
    rows.add("declarations=" + program.declarationCount()); rows.add("calls=" + program.callSiteCount());
    rows.add("files=" + program.files().size()); rows.add("imports=" + program.imports().size());
    rows.add("tokens=" + program.tokens().size()); rows.add("nodes=" + program.nodes().size());
    rows.add("edges=" + program.edges().size()); rows.add("witnesses=" + program.witnesses().size());
    rows.add("sourceFiles=" + sources.size()); rows.add("maxSourceBytes=" + maxSourceBytes); rows.add("sourceBytes=" + sourceBytes);
    rows.add("nodeKinds=" + observed(PsiIndex.NodeKind.values(), nodeKinds));
    rows.add("nodeFlags=" + observed(PsiIndex.NodeFlag.values(), nodeFlags));
    rows.add("edgeRoles=" + observed(PsiIndex.EdgeRole.values(), edgeRoles));
    rows.add("tokenKinds=" + observed(PsiIndex.TokenKind.values(), tokenKinds));
    rows.add("witnessKinds=" + observed(PsiIndex.WitnessKind.values(), witnessKinds));
    rows.add("operatorValues=" + String.join(",", operators)); rows.add("importSummary=" + importSummary);
    rows.add("closureDense=" + denseErrors); rows.add("closureHash=" + hashErrors); rows.add("closureRange=" + rangeErrors);
    rows.add("closureTokenSlice=" + tokenSliceErrors); rows.add("closureLexical=" + lexicalErrors);
    rows.add("closureEdge=" + edgeErrors); rows.add("closureImport=" + importErrors);
    rows.add("closureWitness=" + witnessErrors); rows.add("closureTrivia=" + triviaErrors);
    rows.add("filesSha256=" + filesHash); rows.add("importsSha256=" + importsHash); rows.add("tokensSha256=" + tokensHash);
    rows.add("nodesSha256=" + nodesHash); rows.add("edgesSha256=" + edgesHash); rows.add("witnessesSha256=" + witnessesHash);
    rows.add("programSha256=" + whole.finish());
    return String.join("\\n", rows);
  }

  private static void accepted(String path, String content) {
    List<PsiIndex.Source> sources = one(path, content);
    System.out.print(summarize(PsiIndex.snapshot(sources), sources));
  }

  private static void defaultPackage() {
    List<PsiIndex.Source> sources = one("src/defaultpkg/DefaultRoot.kt", DEFAULT_PACKAGE);
    PsiIndex.Program program = PsiIndex.snapshot(sources);
    if (program.files().size() != 1) throw new IllegalStateException("one default-package file required");
    System.out.print(summarize(program, sources) + "\\npackageName=" + program.files().get(0).packageName());
  }

  private static void rejected(String path, String content) {
    try {
      PsiIndex.snapshot(one(path, content));
      System.out.print("status=unexpected-acceptance");
    } catch (PsiIndex.SnapshotRejected rejected) {
      System.out.print("status=rejected\\ncode=" + rejected.rejectionCode());
    }
  }

  public static void main(String[] args) {
    if (args.length != 1) throw new IllegalArgumentException("one mode required");
    switch (args[0]) {
      case "catalog" -> accepted("src/catalog/Matrix.kt", CATALOG);
      case "default-package" -> defaultPackage();
      case "psi-n" -> accepted("src/limits/Psi.kt", comments(PSI_LINE_COMMENTS));
      case "psi-n-plus-one" -> rejected("src/limits/Psi.kt", comments(PSI_LINE_COMMENTS) + "/*x*/");
      case "declarations-n" -> accepted("src/limits/Declarations.kt", declarations(DECLARATION_LIMIT, 0));
      case "declarations-n-plus-one" -> rejected("src/limits/Declarations.kt", declarations(DECLARATION_LIMIT + 1, 0));
      case "calls-0" -> accepted("src/limits/Calls.kt", calls(0));
      case "calls-1" -> accepted("src/limits/Calls.kt", calls(1));
      case "calls-2" -> accepted("src/limits/Calls.kt", calls(2));
      case "calls-max" -> accepted("src/limits/Calls.kt", calls(CALL_MAX_ACCEPTED));
      case "calls-max-plus-one" -> rejected("src/limits/Calls.kt", calls(CALL_MAX_ACCEPTED + 1));
      case "calls-limit" -> rejected("src/limits/Calls.kt", calls(CALL_LIMIT));
      case "maximal" -> accepted("src/limits/Maximal.kt", declarations(DECLARATION_LIMIT, MAXIMAL_COMMENTS));
      case "maximal-plus-one" -> rejected("src/limits/Maximal.kt", declarations(DECLARATION_LIMIT, MAXIMAL_COMMENTS) + "/*x*/");
      default -> throw new IllegalArgumentException("unknown mode");
    }
  }
}
`;
  const psiIndexSource = fs.readFileSync(path.join(JAVA_ROOT, "PsiIndex.java"), "utf8");
  for (const [label, snippet] of [
    ["Program constructor validates copied catalogs", `            validateProgram(psiNodeCount, declarationCount, callSiteCount,
                files, imports, tokens, nodes, edges, witnesses);`],
    ["PSI count covers every value catalog", `        if (psiNodeCount < nodes.size() || psiNodeCount < tokens.size() || psiNodeCount < witnesses.size()) {
            throw new IllegalArgumentException("program catalogs exceed the PSI count");
        }`],
    ["call and declaration counters cover normalized catalogs", `        if (representedCalls != callSiteCount || representedDeclarations > declarationCount) {
            throw new IllegalArgumentException("program counters do not cover the normalized catalogs");
        }`],
    ["every file has exactly one root", `        for (int roots : fileRoots) if (roots != 1) throw new IllegalArgumentException("file root closure is invalid");`],
  ]) assert.equal(psiIndexSource.includes(snippet), true, label);
  for (const type of ["FileUnit", "ImportEntry", "Token", "Node", "Edge", "WitnessNode", "Program"]) {
    assert.equal(probeSource.includes(`new PsiIndex.${type}(`), false, `CatalogProbe must not construct ${type}`);
  }
  const probePath = path.join(sourceRoot, "com/agentbench/analyzer/CatalogProbe.java");
  fs.mkdirSync(path.dirname(probePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probePath, probeSource);
  const classpath = receipt.classpath.map((entry) => path.join(receipt.artifactRoot, ...entry.path.split("/"))).join(path.delimiter);
  const environment = { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const compiled = spawnSync(path.join(receipt.jdk.root, "bin/javac"), [
    `-J-Duser.home=${home}`, `-J-Djava.io.tmpdir=${temporaryFiles}`, "--release", "17", "-encoding", "UTF-8",
    "-g:none", "-proc:none", "-classpath", classpath, "-d", classes, probePath,
  ], { cwd: sourceRoot, env: environment, shell: false, encoding: "utf8", maxBuffer: 4_194_304 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(compiled.stdout, "");
  assert.equal(compiled.stderr, "");
  const baseRuntimeArgs = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = baseRuntimeArgs.indexOf("-cp");
  baseRuntimeArgs[cpIndex + 1] = `${classes}${path.delimiter}${classpath}`;
  const mainIndex = baseRuntimeArgs.indexOf("com.agentbench.analyzer.Main");
  baseRuntimeArgs[mainIndex] = "com.agentbench.analyzer.CatalogProbe";
  function run(mode) {
    const runtimeArgs = [...baseRuntimeArgs];
    runtimeArgs[mainIndex + 1] = mode;
    const executed = spawnSync(receipt.launch.java, runtimeArgs, {
      cwd: temporary, env: environment, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 4_194_304,
    });
    assert.equal(executed.status, 0, `${mode}: ${executed.stderr}`);
    assert.equal(executed.stderr, "", mode);
    return executed.stdout;
  }
  function stable(mode) {
    const first = run(mode);
    assert.equal(run(mode), first, `${mode} must be deterministic across fresh production-heap processes`);
    return first;
  }
  const defaultPackageRaw = stable("default-package");
  const results = {
    catalog: stable("catalog"),
    psiN: run("psi-n"),
    psiNPlusOne: run("psi-n-plus-one"),
    declarationsN: run("declarations-n"),
    declarationsNPlusOne: run("declarations-n-plus-one"),
    calls0: run("calls-0"),
    calls1: run("calls-1"),
    calls2: run("calls-2"),
    callsMax: run("calls-max"),
    callsMaxPlusOne: run("calls-max-plus-one"),
    callsLimit: run("calls-limit"),
    maximal: stable("maximal"),
    maximalPlusOne: run("maximal-plus-one"),
  };
  const fullNodeKinds = "FILE,CLASS_DECL,INTERFACE_DECL,OBJECT_DECL,COMPANION_DECL,FUNCTION_DECL,PROPERTY_DECL,PARAMETER_DECL,TYPE_REF,BLOCK,CALL,ARGUMENT,NAME_REF,THIS_REF,QUALIFIED,SAFE_QUALIFIED,CALLABLE_REF,CLASS_LITERAL,LAMBDA,ASSIGNMENT,BINARY,PREFIX,POSTFIX,INDEX_ACCESS,IF,WHEN,WHEN_ENTRY,TRY,CATCH,RETURN,BREAK,CONTINUE,FOR,WHILE,ANNOTATION,STRING_TEMPLATE,LITERAL";
  const fullNodeFlags = "DATA,SEALED,CONST,VAL,VAR,SUSPEND,OVERRIDE,PRIVATE,EXPRESSION_BODY,NAMED,SAFE,LABELED";
  const fullEdgeRoles = "FILE_MEMBER,LEXICAL_OWNER,RECEIVER,CALLEE,ARGUMENT,TYPE_ARGUMENT,PARAMETER,TYPE,ANNOTATION,SUPER_TYPE,DEFAULT_VALUE,INITIALIZER,BODY,CONDITION,THEN_BRANCH,ELSE_BRANCH,SUBJECT,ENTRY,LEFT,RIGHT,OPERAND,TARGET,VALUE,SELECTOR,INDEX,RANGE,LOOP_BODY,TRY_BODY,CATCH_CLAUSE,CATCH_BODY,RETURN_VALUE,LAMBDA_BODY,STRING_EXPRESSION";
  const fullTokenKinds = "IDENTIFIER,KEYWORD,OPERATOR,STRING_LITERAL,INTEGER_LITERAL,FLOAT_LITERAL,BOOLEAN_LITERAL,NULL_LITERAL";
  const fullWitnessKinds = "DECLARATION,CALLABLE_REFERENCE,CALL,ARGUMENT,PROPERTY_READ,ASSIGNMENT,CONDITION,LOOP,LAMBDA,RETURN,TYPE_REFERENCE,CATCH";
  const acceptedKeys = [
    "status", "psi", "declarations", "calls", "files", "imports", "tokens", "nodes", "edges", "witnesses",
    "sourceFiles", "maxSourceBytes", "sourceBytes", "nodeKinds", "nodeFlags", "edgeRoles", "tokenKinds",
    "witnessKinds", "operatorValues", "importSummary", "closureDense", "closureHash", "closureRange",
    "closureTokenSlice", "closureLexical", "closureEdge", "closureImport", "closureWitness", "closureTrivia",
    "filesSha256", "importsSha256", "tokensSha256", "nodesSha256", "edgesSha256", "witnessesSha256", "programSha256",
  ];
  function summary(value) {
    return Object.fromEntries(value.split("\n").map((row) => {
      const separator = row.indexOf("=");
      return [row.slice(0, separator), row.slice(separator + 1)];
    }));
  }
  const evidenceKeys = [
    "psi", "declarations", "calls", "files", "imports", "tokens", "nodes", "edges", "witnesses",
    "sourceFiles", "maxSourceBytes", "sourceBytes", "filesSha256", "importsSha256", "tokensSha256",
    "nodesSha256", "edgesSha256", "witnessesSha256", "programSha256",
  ];
  const measuredEvidence = {
    catalog: ["1017", "45", "8", "1", "2", "279", "236", "400", "132", "1", "1788", "1788", "35b425dc2a25af007dc253ab3a5e09f24203a4941c6ad6a7ab5cd970ee1caad9", "d9d745f7254c2cb0335c5942b495d34f2bcaa4b455b2c37b8428334dceb7005d", "1f061cb0fdc9863d602aa33f1fdf2f6f62492c613c3b76a494048331a24ce954", "033031403a3b76e11ba1f5f9b7a605c44d9d6456ddc1d3e54fbcac94124c721f", "ffd742d914f70f48096d297a9b3215fcd978db7536f63660b40563673afaabb9", "b70c52856f94dae1606095538fa53585d3ef673859ec5abe6f3306f32f0fdc0c", "553a2f2b28f332c7c9496fb394a9103b0e3e1cd811c771ca6eeffa515ef3e769"],
    psiN: ["500000", "0", "0", "1", "0", "2", "2", "1", "0", "1", "750003", "750003", "f8a8e567964e62f984e013d9460aad5065f4f1f8602fa024e041f5b6d80ef5f7", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "96ef13cffa319a66e584668d9cad67a1bba61cc89272c1fa46468dbcd31edd5e", "7303de69faee7dc68d9e96df2948f95b8d8ae508e684a6838644befcfb9bdbb1", "4e3a7b263a1823de738f9f6641261ec18a5f522aa5844b4f6714f089813c74f4", "d027b03b45b6d74e333138bff712d9ae956fea7b06f5e5b389207cf0e259b98c", "2e846a087a8c8a465154097485d5aa8c1413c7e5ae6bd231a18da53b83e20122"],
    declarationsN: ["200008", "25000", "0", "1", "0", "100002", "50002", "100001", "25000", "1", "313905", "313905", "7d3f06282cef2d78fd72e8abfa35540b2dc510020d2557e4625aa3660994f64f", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "21fae2c686cf27e7dec3a8f324f643426724b3feb573192181a26d2bc6b0cce3", "0cf3d417dd39a665d4f626fa80c5de07af566bdd2feeff9b2c759446fb776422", "dee1d9371f36eae9e184d12f6c40a41261d3ce2864cc15ff7fe548af312a4aa4", "2b32c6dabdc0935cf27080b5efbe0e77cc418a60c1b3f6ec86f1edb01b1c7bc7", "142f9c2c7854025e12ca9ecd32a9aec415a0cf096f53e7100fa18105a3ff2a07"],
    calls0: ["19", "1", "0", "1", "0", "4", "4", "5", "1", "1", "28", "28", "a8498f01b2f5bbf87a3e64a5893cd69e4ef6d8a020c1b2af28ec82926f63fca2", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "c1b757e3dcaab87b19f2223e0010b833d2ad0c8d287e2a2c4b5fa18b98342b5e", "4e014270700d35a15a7d1dba3faa0161bc7ec03021e87121aeec8db342ce12e2", "1e24cdb0611630ca9e692baced346bbb4857a38e6f30c7608656d4c6d0a834a8", "a3f84d1106d492fb586bebd50ff191474435f069a7d800adf4bc718b36a05d7b", "66b35eba2b809fd53241f90dd2802c6d7cbdabd04298804ffc1f82396100969e"],
    calls1: ["26", "1", "1", "1", "0", "5", "6", "8", "3", "1", "32", "32", "be091fa6d3b975857627390a44daf62d8f70f6baf5ce72c92254150a619ef99b", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "925ec2f55dce5cf7c09ebaf9c4bfa1989e73b36579b692be392407366fca99dc", "0963f516745bb40d08ee77f938d9a3cad2cecc6d353f79d0e8fc907d58011bc0", "0a8f4e85a903357a40bc539b31a6bf80016ff75075d5c7b14b1d85e525e57494", "e5f5dbf6511068dcba3391e7bb46c81d1d40220d92c4610c026213deecbd7a0c", "bdddf54634c8cbf428ae31092bc367a9293c06a15f1e0c504dc1efa60bb498b5"],
    calls2: ["33", "1", "2", "1", "0", "6", "8", "11", "5", "1", "36", "36", "3f9a42ed8b4048b186b4d528f649a0090bc4687532a75d9c1d5e5a921ab4ce0c", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "a472a49023246d29807e2eaca70b980ce28f7046daa9ff1666070e9bb9597171", "44f9e67db24314f384c33f26ba383031c5752668a46a4f21588f7b6232ebb9a3", "548740838dec9f4ed38fdcc7ef60841af69fe7a3ed46064f432bc852b4f91321", "38662cac6d000dc4b5d2927e9733c7e3a041450098dfd36a2265758ec3be9741", "bc483606cf0bc923ebbe956bc1dc5cdc06060d251272a1a79c8cfda7d1579445"],
    callsMax: ["499994", "1", "71425", "1", "0", "71429", "142854", "214280", "142851", "1", "285728", "285728", "d6937eec49ed6091c880d255eacf1cf3dc81fcc16bf09c48e4557df83d280e2a", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "7f55238e6d51c2ffc9fca22d1cb2c160ff15f5a07adc0e5e279f509537780231", "197ed3fcbaf02a39e33a87aede1532e3865d1b1039b102c09b0b47453ffdcfbb", "537ef41bc32466ccc9ded5438a442437c97cbca0aedbf50aa29ce475eafd0b78", "d3a5dfb8b0fbe5c05e76cd387c95ffd5712f28ba2eb0f2a593ac482c813487d0", "aedae1f34106ec10e589670b8bcabb812b7807fc33afc3f9a258c1dc17ed9fed"],
    maximal: ["500000", "25000", "0", "1", "0", "100002", "50002", "100001", "25000", "1", "763893", "763893", "b8734d5ae103a29390eff496709d64e63ac85a3b3852d1258257ea38f366288d", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "21fae2c686cf27e7dec3a8f324f643426724b3feb573192181a26d2bc6b0cce3", "fc5deab0da19bac91dcb8982b0d1cf69bd7b295e0ed8acacc32ba45e24496d17", "dee1d9371f36eae9e184d12f6c40a41261d3ce2864cc15ff7fe548af312a4aa4", "37abece485ac4ade0f14ece5b452b997d86b689174f676f9353c2a48a1a37318", "5e8c3f7684d60ff05aaacc08a195733e6f6062d50cd4f20b19838c473a39ff3c"],
  };
  for (const [label, value] of Object.entries(results)) {
    if (!value.startsWith("status=accepted")) continue;
    const item = summary(value);
    assert.deepEqual(Object.keys(item), acceptedKeys, `${label} exact summary keys/order`);
    for (const key of ["closureDense", "closureHash", "closureRange", "closureTokenSlice", "closureLexical",
      "closureEdge", "closureImport", "closureWitness", "closureTrivia"]) assert.equal(item[key], "0", `${label} ${key}`);
    assert.equal(Number(item.sourceFiles) <= ANALYZER_CONSTANTS.MAX_KOTLIN_FILES, true, `${label} files envelope`);
    assert.equal(Number(item.maxSourceBytes) <= ANALYZER_CONSTANTS.MAX_KOTLIN_FILE_BYTES, true, `${label} file-byte envelope`);
    assert.equal(Number(item.sourceBytes) <= ANALYZER_CONSTANTS.MAX_KOTLIN_TOTAL_BYTES, true, `${label} total-byte envelope`);
    for (const key of ["filesSha256", "importsSha256", "tokensSha256", "nodesSha256", "edgesSha256", "witnessesSha256", "programSha256"]) {
      assert.match(item[key], /^[a-f0-9]{64}$/, `${label} ${key}`);
    }
    assert.deepEqual(evidenceKeys.map((key) => item[key]), measuredEvidence[label], `${label} exact measured evidence`);
  }
  const catalog = summary(results.catalog);
  assert.equal(catalog.nodeKinds, fullNodeKinds);
  assert.equal(catalog.nodeFlags, fullNodeFlags);
  assert.equal(catalog.edgeRoles, fullEdgeRoles);
  assert.equal(catalog.tokenKinds, fullTokenKinds);
  assert.equal(catalog.witnessKinds, fullWitnessKinds);
  assert.equal(catalog.importSummary, "androidx.compose.runtime.Composable->Composable;kotlin.String as Text->Text");
  assert.equal(catalog.operatorValues, "+,++,+=,-,--,..,=,==,>,?:,as");
  const defaultPackage = summary(defaultPackageRaw);
  assert.equal(defaultPackage.status, "accepted");
  assert.equal(defaultPackage.packageName, "");
  assert.equal(defaultPackage.files, "1");
  assert.equal(Number(defaultPackage.nodes) > 0, true);
  assert.equal(defaultPackage.nodeKinds.split(",").includes("FILE"), true);
  for (const key of ["closureDense", "closureHash", "closureRange", "closureTokenSlice", "closureLexical",
    "closureEdge", "closureImport", "closureWitness", "closureTrivia"]) assert.equal(defaultPackage[key], "0", `default-package ${key}`);
  const calls0 = summary(results.calls0);
  const calls1 = summary(results.calls1);
  const calls2 = summary(results.calls2);
  assert.equal(Number(calls1.psi) - Number(calls0.psi), 7, "one fixed f(); row has seven measured PSI rows");
  assert.equal(Number(calls2.psi) - Number(calls1.psi), 7, "minimal-call PSI delta is deterministic");
  assert.equal(Number(calls1.calls) - Number(calls0.calls), 1);
  assert.equal(Number(calls2.calls) - Number(calls1.calls), 1);
  assert.equal(Number(calls1.declarations), 1);
  assert.equal(Number(calls2.declarations), 1);
  assert.equal(71_425 < ANALYZER_CONSTANTS.MAX_CALL_SITES, true);
  assert.equal(ANALYZER_CONSTANTS.MAX_CALL_SITES * 6 > ANALYZER_CONSTANTS.MAX_PSI_NODES, true,
    "each minimal f() has disjoint CALL, callee, argument-list, identifier, and two parenthesis PSI rows");
  assert.equal(Number(summary(results.callsMax).psi) + 7, ANALYZER_CONSTANTS.MAX_PSI_NODES + 1,
    "the next minimal call reaches the dominating PSI boundary first");
  assert.equal(71_426 < ANALYZER_CONSTANTS.MAX_CALL_SITES, true, "call counter is structurally shadowed");
  assert.equal(results.psiNPlusOne, "status=rejected\ncode=limit");
  assert.equal(results.declarationsNPlusOne, "status=rejected\ncode=limit");
  assert.equal(results.callsMaxPlusOne, "status=rejected\ncode=limit");
  assert.equal(results.callsLimit, "status=rejected\ncode=limit");
  assert.equal(results.maximalPlusOne, "status=rejected\ncode=limit");
  fs.rmSync(temporary, { recursive: true, force: true });
  assert.equal(fs.existsSync(probePath), false, "CatalogProbe.java residue");
  assert.equal(fs.existsSync(path.join(classes, "com/agentbench/analyzer/CatalogProbe.class")), false, "CatalogProbe.class residue");
});
test("semantic handoff Program rejects a copied import with a missing witness", (t) => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-import-witness-probe");
  const sourceRoot = path.join(temporary, "source");
  const classes = path.join(temporary, "classes");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  const probeClass = "com.agentbench.analyzer.ImportWitnessClosureProbe";
  const probeEntry = "com/agentbench/analyzer/ImportWitnessClosureProbe.class";
  const probePath = path.join(sourceRoot, "com/agentbench/analyzer/ImportWitnessClosureProbe.java");
  const compiledProbe = path.join(classes, probeEntry);
  const artifactBefore = fs.readFileSync(ARTIFACT);
  assert.equal(receipt.sourceInputs.some((row) => row.path.endsWith("/ImportWitnessClosureProbe.java")), false,
    "temporary import witness probe source must not be an analyzer input");
  assert.equal(receipt.build.jarEntries.includes(probeEntry), false,
    "temporary import witness probe class must not be an analyzer JAR entry");
  for (const directory of [sourceRoot, classes, home, temporaryFiles]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const importedKotlin = `package witness.closure

import kotlin.String

class ImportedRoot(val name: String)
`;
  const probeSource = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

public final class ImportWitnessClosureProbe {
  private static final String SOURCE = ${JSON.stringify(importedKotlin)};

  private ImportWitnessClosureProbe() {}

  private static String sha256(String value) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder result = new StringBuilder(digest.length * 2);
      for (byte item : digest) result.append(String.format("%02x", item & 0xff));
      return result.toString();
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }

  public static void main(String[] arguments) {
    PsiIndex.Source source = new PsiIndex.Source("src/witness/ImportedRoot.kt", sha256(SOURCE), SOURCE);
    PsiIndex.Program original = PsiIndex.snapshot(List.of(source));
    if (original.imports().size() != 1) throw new AssertionError("expected exactly one valid import");
    PsiIndex.ImportEntry imported = original.imports().get(0);
    if (imported.witnessNodeId() == null) throw new AssertionError("snapshot omitted the valid import witness");
    ArrayList<PsiIndex.ImportEntry> malformedImports = new ArrayList<>(original.imports());
    malformedImports.set(imported.id(), new PsiIndex.ImportEntry(
        imported.id(), imported.fileId(), imported.fqName(), imported.exposedName(), imported.alias(),
        imported.syntaxNodeId(), null));
    try {
      new PsiIndex.Program(
          original.psiNodeCount(), original.declarationCount(), original.callSiteCount(),
          original.files(), malformedImports, original.tokens(), original.nodes(), original.edges(),
          original.witnesses());
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("Program accepted an import whose witnessNodeId is null");
  }
}
`;
  fs.mkdirSync(path.dirname(probePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probePath, probeSource, { encoding: "utf8", mode: 0o600 });
  const classpath = receipt.classpath.map((entry) => path.join(receipt.artifactRoot, ...entry.path.split("/"))).join(path.delimiter);
  const environment = { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const compiled = spawnSync(path.join(receipt.jdk.root, "bin/javac"), [
    `-J-Duser.home=${home}`, `-J-Djava.io.tmpdir=${temporaryFiles}`, "--release", "17", "-encoding", "UTF-8",
    "-g:none", "-proc:none", "-classpath", classpath, "-d", classes, probePath,
  ], { cwd: sourceRoot, env: environment, shell: false, encoding: "utf8", maxBuffer: 4_194_304 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(compiled.stdout, "");
  assert.equal(compiled.stderr, "");
  const runtimeArgs = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = runtimeArgs.indexOf("-cp");
  runtimeArgs[cpIndex + 1] = `${classes}${path.delimiter}${classpath}`;
  const mainIndex = runtimeArgs.indexOf("com.agentbench.analyzer.Main");
  runtimeArgs.splice(mainIndex, runtimeArgs.length - mainIndex, probeClass);
  const executed = spawnSync(receipt.launch.java, runtimeArgs, {
    cwd: temporary, env: environment, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 4_194_304,
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, "");
  assert.equal(executed.stderr, "");
  assert.deepEqual(fs.readFileSync(ARTIFACT), artifactBefore, "temporary probe must not mutate the analyzer artifact");
  fs.rmSync(temporary, { recursive: true, force: true });
  assert.equal(fs.existsSync(probePath), false, "ImportWitnessClosureProbe.java residue");
  assert.equal(fs.existsSync(compiledProbe), false, "ImportWitnessClosureProbe.class residue");
});
test("domain invalid classpath resource fails closed without publishing or caching an analyzer", (t) => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-invalid-domain");
  const resource = path.join(temporary, "resource");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  for (const directory of [resource, home, temporaryFiles]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(resource, "domain-v1.json"), canonicalJson({
    analyzerName: "supported-subset-abstract-interpreter-v1", domainVersion: 1,
  }));
  const args = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = args.indexOf("-cp");
  args[cpIndex + 1] = `${resource}${path.delimiter}${args[cpIndex + 1]}`;
  const request = analyzeRequest("modules/domain/src/main/kotlin/Canary.kt", EXPRESSION_CLONE_SOURCE);
  const result = spawnSync(receipt.launch.java, args, {
    cwd: temporary,
    env: { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    shell: false,
    encoding: null,
    input: protocolFrame(request),
    timeout: 30_000,
    maxBuffer: 4_194_312,
  });
  assert.equal(result.status, 0, Buffer.from(result.stderr ?? "").toString("utf8"));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  const response = framedResponse(result.stdout);
  assert.equal(response.analysisStatus, "rejected");
  assert.equal(response.rejectionCode, "internal_uncertainty");
  assert.deepEqual(response.nodes, []);
  assert.deepEqual(response.claims, []);
});
test("analyzer artifact and self-hashed receipt bind the exact PSI toolchain", () => {
  const verified = verifyAnalyzerArtifact();
  assert.equal(fs.statSync(ARTIFACT).size, verified.analyzerJarBytes);
  assert.equal(hash(fs.readFileSync(ARTIFACT)), verified.analyzerJarSha256);
  assert.equal(hash(fs.readFileSync(RECEIPT)), verified.receiptFileSha256);
  assert.equal(verified.runtime.length, 7);
  assert.deepEqual(verified.runtime.map((row) => row.order), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(verified.classpath.length, 8);
  assert.equal(verified.jdkTreeSha256, "89b10d67dd49a0f809716313416a78734fb3ff466ab7b9a801eabdd1e10109d7");
  assert.equal(verified.nodeSha256, "c583851fc85e4618b2374cda13399d59d373ad7cebfc4b55160820b88dcce67b");
  for (const name of ["analyzer-v1.jar", "analyzer-build-receipt-v1.json", ...fs.readdirSync(path.join(path.dirname(ARTIFACT), "runtime")).map((entry) => `runtime/${entry}`)]) {
    const stat = fs.lstatSync(path.join(path.dirname(ARTIFACT), name));
    assert.equal(stat.mode & 0o777, 0o400, `${name} must be owner-read-only`);
    assert.equal(stat.nlink, 1, `${name} must have no hard-link alias`);
  }
  assert.throws(() => fs.appendFileSync(ARTIFACT, Buffer.from([0])), /EACCES|permission denied/i);
  const description = describeKotlinAnalyzer();
  assert.equal(description.analysisStatus, "accepted");
  assert.deepEqual(description.constants, ANALYZER_CONSTANTS);
  assert.deepEqual(description.nodes, []);
  assert.deepEqual(description.claims, []);
});
test("Kotlin input identities bind every selected .kt and .kts byte independently from other selected inputs", () => {
  const index = sourceIndex([
    { path: "app/build.gradle.kts", kind: "gradle", content: "plugins {}\n" },
    { path: "app/src/A.kt", content: "package sample\nclass A\n" },
    { path: "scripts/B.kts", content: "val b = 2\n" },
    { path: "app/src/main/AndroidManifest.xml", kind: "manifest", content: "<manifest/>\n" },
  ]);
  const kotlinRows = index.files.filter((file) => file.kind === "kotlin").map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.original),
    sha256: hash(Buffer.from(file.original)),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const selectedRows = index.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    bytes: Buffer.byteLength(file.original),
    sha256: hash(Buffer.from(file.original)),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  assert.equal(computeKotlinInputSetSha256(index), hash(canonicalJson(kotlinRows)));
  assert.equal(computeSelectedInputSetSha256(index), hash(canonicalJson(selectedRows)));
});
test("all-or-nothing PSI parsing accepts only complete .kt indexes and emits no semantic claims", () => {
  const accepted = analyzeKotlin(sourceIndex([
    { path: "src/One.kt", content: "package sample\nimport kotlin.String as Text\nclass One(val name: Text)\n" },
    { path: "src/Two.kt", content: "package sample\nfun answer(): Int = 42\n" },
  ]));
  assert.equal(accepted.analysisStatus, "accepted");
  assert.equal(accepted.rejectionCode, null);
  assert.deepEqual(accepted.nodes, []);
  assert.deepEqual(accepted.claims, []);
  for (const [name, rows, code] of [
    ["script only", [{ path: "scripts/Only.kts", content: "val x = 1\n" }], "unsupported_script"],
    ["mixed script", [{ path: "src/Ok.kt", content: "package sample\nclass Ok\n" }, { path: "scripts/No.kts", content: "val x = 1\n" }], "unsupported_script"],
    ["malformed competing file", [{ path: "src/Ok.kt", content: "package sample\nclass Ok\n" }, { path: "src/Broken.kt", content: "package sample\nfun broken( {\n" }], "parse"],
    ["ambiguous index", [{ path: "src/A.kt", content: "package sample\nclass Same\n" }, { path: "src/B.kt", content: "package sample\nclass Same\n" }], "ambiguous_index"],
    ["same-file ambiguous index", [{ path: "src/Duplicate.kt", content: "package sample\nclass Same\nclass Same\n" }], "ambiguous_index"],
    ["duplicate import alias", [{ path: "src/AliasCollision.kt", content: `package sample
import com.pico.spatial.ui.foundation.dsl.registerSystem as collide
import com.pico.spatial.ui.foundation.dsl.unregisterSystem as collide
fun use() { collide() }
` }], "incomplete_imports"],
    ["incomplete imports", [{ path: "src/Star.kt", content: "package sample\nimport kotlin.*\nclass Star\n" }], "incomplete_imports"],
  ]) {
    const result = analyzeKotlin(sourceIndex(rows));
    assert.equal(result.analysisStatus, "rejected", name);
    assert.equal(result.rejectionCode, code, name);
    assert.deepEqual(result.nodes, [], name);
    assert.deepEqual(result.claims, [], name);
    assert.equal(result.kotlinInputSetSha256, computeKotlinInputSetSha256(sourceIndex(rows)), name);
  }
});
test("protocol rejects integers outside the canonical safe range", (t) => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-protocol-safe-range");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  for (const directory of [home, temporaryFiles]) fs.mkdirSync(directory, { mode: 0o700 });
  const args = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const json = Buffer.from(`{"command":"analyze","files":[{"bytes":-9223372036854775808,"contentBase64":"","path":"src/Unsafe.kt","sha256":"${"0".repeat(64)}"}],"kotlinInputSetSha256":"${"0".repeat(64)}","protocolVersion":1,"subsetVersion":1}`, "utf8");
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(json.length));
  const result = spawnSync(receipt.launch.java, args, {
    cwd: temporary,
    env: { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    shell: false,
    encoding: "utf8",
    input: Buffer.concat([header, json]),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /safe range|invalid integer/i);
});
test("analyzer artifact rejects a rewritten JAR and self-hashed receipt transplant", async (t) => {
  const artifactRoot = copyArtifact(t);
  const scenario = { value: "accepted" };
  const bridge = await copiedBridge(t, scenario, { count: 0 }, artifactRoot);
  assert.equal(bridge.verifyAnalyzerArtifact().analyzerJarSha256, hash(fs.readFileSync(ARTIFACT)));
  const jarPath = path.join(artifactRoot, "analyzer-v1.jar");
  fs.chmodSync(jarPath, 0o600);
  fs.appendFileSync(jarPath, Buffer.from([0]));
  fs.chmodSync(jarPath, 0o400);
  const receiptPath = path.join(artifactRoot, "analyzer-build-receipt-v1.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const jarSha256 = hash(fs.readFileSync(jarPath));
  receipt.analyzerJar.bytes += 1;
  receipt.analyzerJar.sha256 = jarSha256;
  receipt.classpath[0] = { ...receipt.analyzerJar };
  receipt.classpathSha256 = hash(canonicalJson(receipt.classpath));
  receipt.build.cleanBuildJarSha256 = [jarSha256, jarSha256];
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, `${canonicalJson(reSelfHash(receipt))}\n`);
  fs.chmodSync(receiptPath, 0o400);
  assert.throws(() => bridge.verifyAnalyzerArtifact(), /JAR|toolchain|anchor|identity/i);
});
test("analyzer artifact rejects false receipt build vectors", async (t) => {
  const artifactRoot = copyArtifact(t);
  const bridge = await copiedBridge(t, { value: "accepted" }, { count: 0 }, artifactRoot);
  const receiptPath = path.join(artifactRoot, "analyzer-build-receipt-v1.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.build.childEnvironment.PATH = "/tmp/injected";
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, `${canonicalJson(reSelfHash(receipt))}\n`);
  fs.chmodSync(receiptPath, 0o400);
  assert.throws(() => bridge.verifyAnalyzerArtifact(), /build|environment|receipt/i);
});
test("build env verifier rejects noncanonical receipt bytes and forbidden sidecar capabilities", (t) => {
  const replica = analyzerReplica(t);
  const buildSource = fs.readFileSync(replica.build, "utf8");
  const reviewedJarStart = buildSource.indexOf("function assertReviewedJar(material, inspection) {");
  const reviewedJarEnd = buildSource.indexOf("\nfunction cleanBuild(", reviewedJarStart);
  assert.equal(reviewedJarStart >= 0 && reviewedJarEnd > reviewedJarStart, true, "assertReviewedJar source boundary");
  const reviewedJarSource = buildSource.slice(reviewedJarStart, reviewedJarEnd);
  const verifySemanticGuard = `    if ((name === "com/agentbench/analyzer/AbstractInterpreter.class"
        || name === "com/agentbench/analyzer/Rules.class"
        || name.startsWith("com/agentbench/analyzer/Rules$"))
        && (content.includes(Buffer.from("org/jetbrains/kotlin/")) || content.includes(Buffer.from("com/intellij/")))) {
      fail(\`semantic bytecode \${name} contains a PSI or Kotlin compiler reference\`);
    }`;
  assert.equal(reviewedJarSource.includes(verifySemanticGuard), true,
    "assertReviewedJar verify-only must apply the semantic-class raw-byte PSI/Kotlin compiler guard");
  assert.equal(runScrubbedNode(replica.build, ["verify"]).status, 0, "replica baseline must verify");
  const receiptPath = path.join(replica.artifact, "analyzer-build-receipt-v1.json");
  const canonical = fs.readFileSync(receiptPath, "utf8");
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, ` ${canonical}`);
  fs.chmodSync(receiptPath, 0o400);
  const malformed = runScrubbedNode(replica.build, ["verify"]);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /canonical JSON plus one LF/i);
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, canonical);
  fs.chmodSync(receiptPath, 0o400);
  const mainPath = path.join(replica.analyzer, "src/main/java/com/agentbench/analyzer/Main.java");
  const main = fs.readFileSync(mainPath, "utf8");
  for (const attack of [
    main.replace("private Main() {}", 'private Main() { java.nio.file.Files.exists(java.nio.file.Path.of("/")); }'),
    main.replace("import java.nio.ByteBuffer;", "import static java.lang.Runtime.getRuntime;\nimport java.nio.ByteBuffer;"),
    main.replace("private Main() {}", 'private Main() { try { Class.forName("java.lang.Runtime"); } catch (Exception ignored) {} }'),
    main.replace("private Main() {}", "private Main() { new java.util.Scanner(System.in); }"),
  ]) {
    fs.writeFileSync(mainPath, attack);
    const rejected = runScrubbedNode(replica.build, ["clean-build-twice"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /forbidden capability|unreviewed import|class-reference (?:inventory|bounds)/i);
  }
  fs.writeFileSync(mainPath, main);
  const interpreterPath = path.join(replica.analyzer, "src/main/java/com/agentbench/analyzer/AbstractInterpreter.java");
  const interpreter = fs.readFileSync(interpreterPath, "utf8");
  const psiAttack = interpreter.replace(
    "final class AbstractInterpreter {",
    "final class AbstractInterpreter {\n    private static final Class<?> FORBIDDEN_PSI = org.jetbrains.kotlin.psi.KtFile.class;",
  );
  assert.notEqual(psiAttack, interpreter, "semantic PSI attack seam");
  fs.writeFileSync(interpreterPath, psiAttack);
  const semanticRejected = runScrubbedNode(replica.build, ["clean-build-twice"]);
  assert.notEqual(semanticRejected.status, 0);
  assert.match(semanticRejected.stderr, /semantic bytecode.*PSI|PSI or Kotlin compiler reference/i);
});
test("analyzer artifact verification precedes local all-or-nothing limit rejection", async (t) => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(ARTIFACTS, ".test-missing-")));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const missing = path.join(container, "v1");
  const bridge = await copiedBridge(t, { value: "accepted" }, { count: 0 }, missing);
  const rows = Array.from({ length: 513 }, (_, index) => ({ path: `src/TooMany${String(index).padStart(3, "0")}.kt`, content: "package sample\nclass Tiny\n" }));
  assert.throws(() => bridge.analyzeKotlin(sourceIndex(rows)), /artifact|ENOENT|missing/i);
});
test("spawnSync protocol faults fail closed before any analyzer result is accepted", async (t) => {
  const scenario = { value: "accepted" };
  const calls = { count: 0, records: [] };
  const bridge = await copiedBridge(t, scenario, calls);
  const index = sourceIndex([
    { path: "src/First.kt", content: "package sample\nclass First\n" },
    { path: "src/Second.kt", content: "package sample\nclass Second\n" },
  ]);
  const faults = [
    ["hang", /timeout|timed out|ETIMEDOUT/i],
    ["nonzero", /status|exit/i],
    ["signal", /signal/i],
    ["stderr", /stderr/i],
    ["partial", /frame|length/i],
    ["trailing", /trailing|frame/i],
    ["invalid-utf8", /UTF-8/i],
    ["duplicate-key", /duplicate|canonical|missing/i],
    ["noncanonical-whitespace", /canonical/i],
    ["out-of-order-key", /out-of-order|canonical|missing/i],
    ["negative-zero", /canonical|integer/i],
    ["fraction", /canonical|integer/i],
    ["lone-surrogate", /surrogate|canonical/i],
    ["deep-json", /depth|canonical/i],
    ["oversize-header", /frame exceeds bound/i],
    ["non-buffer", /Buffers/i],
    ["unknown-key", /unknown.*key/i],
    ["wrong-version", /protocolVersion/i],
    ["wrong-digest", /digest|kotlinInputSetSha256/i],
    ["reordered-files", /file receipts|mismatch/i],
    ["missing-file", /file receipts|mismatch/i],
    ["extra-file", /file receipts|mismatch/i],
    ["impossible-status", /accepted.*rejection/i],
    ["impossible-constants", /constants/i],
    ["stdout-overflow", /buffer|ENOBUFS|stdout/i],
    ["stderr-overflow", /buffer|ENOBUFS|stderr/i],
  ];
  for (const [fault, expected] of faults) {
    scenario.value = fault;
    assert.throws(() => bridge.analyzeKotlin(index), expected, fault);
  }
  assert.equal(calls.count, faults.length);
  for (const { command, args, options } of calls.records) {
    const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
    assert.equal(command, receipt.launch.java);
    assert.deepEqual(args, receipt.launch.args);
    assert.equal(options.cwd, receipt.launch.cwd);
    assert.deepEqual(options.env, receipt.launch.environment);
    assert.equal(options.shell, false);
    assert.equal(options.encoding, null);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.maxBuffer, 4_194_312);
    assert.equal(Buffer.isBuffer(options.input), true);
    assert.equal(options.input.readBigUInt64BE(0), BigInt(options.input.length - 8));
  }
});
test("cache identity is bounded, input-keyed, and stores only validated response bytes", async (t) => {
  const scenario = { value: "accepted" };
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, scenario, calls);
  const make = (number) => sourceIndex([{ path: `src/Case${number}.kt`, content: `package sample\nclass Case${number}\n` }]);
  assert.equal(bridge.analyzeKotlin(make(0)).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(make(0)).analysisStatus, "accepted");
  assert.equal(calls.count, 1, "same validated identity must hit the cache");
  for (let index = 1; index <= 32; index += 1) bridge.analyzeKotlin(make(index));
  assert.equal(calls.count, 33);
  bridge.analyzeKotlin(make(0));
  assert.equal(calls.count, 34, "the oldest of 33 distinct entries must be evicted");
  scenario.value = "wrong-digest";
  assert.throws(() => bridge.analyzeKotlin(make(99)), /digest|kotlinInputSetSha256/i);
  scenario.value = "accepted";
  bridge.analyzeKotlin(make(99));
  assert.equal(calls.count, 36, "an invalid response must never populate the cache");
});
test("protocol and Kotlin input limits enforce exact N and N+1 boundaries", async (t) => {
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, { value: "accepted" }, calls);
  const fileCountN = Array.from({ length: 512 }, (_, index) => ({ path: `src/Count${index}.kt`, content: `class Count${index}\n` }));
  assert.equal(bridge.analyzeKotlin(sourceIndex(fileCountN)).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(sourceIndex([...fileCountN, { path: "src/Count512.kt", content: "class Count512\n" }])).rejectionCode, "limit");
  assert.equal(bridge.analyzeKotlin(sourceIndex([{ path: "a".repeat(4_093) + ".kt", content: "\n" }])).analysisStatus, "accepted");
  assert.throws(() => bridge.analyzeKotlin(sourceIndex([{ path: "a".repeat(4_094) + ".kt", content: "\n" }])), /path/i);
  assert.equal(bridge.analyzeKotlin(sourceIndex([{ path: "src/Bytes.kt", content: " ".repeat(1_048_576) }])).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(sourceIndex([{ path: "src/Bytes.kt", content: " ".repeat(1_048_577) }])).rejectionCode, "limit");
  const totalN = Array.from({ length: 8 }, (_, index) => ({ path: `src/Total${index}.kt`, content: " ".repeat(1_048_576) }));
  assert.equal(bridge.analyzeKotlin(sourceIndex(totalN)).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(sourceIndex([...totalN, { path: "src/Total8.kt", content: "x" }])).rejectionCode, "limit");
  assert.equal(calls.count, 4, "only exact-boundary requests reach the child");
});
test("cache byte budget evicts validated responses before the entry-count limit", async (t) => {
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, { value: "accepted" }, calls);
  const make = (variant) => sourceIndex(Array.from({ length: 512 }, (_, index) => ({
    path: `src/${variant}-${String(index).padStart(3, "0")}-${"p".repeat(3_400)}.kt`,
    content: `class C${variant}_${index}\n`,
  })));
  for (let index = 0; index < 10; index += 1) assert.equal(bridge.analyzeKotlin(make(index)).analysisStatus, "accepted");
  bridge.analyzeKotlin(make(0));
  assert.equal(calls.count, 11, "the 16 MiB byte budget must evict the oldest large validated response");
});
test("cache identity transition misses for receipt-only and JDK-only control changes", async (t) => {
  const replica = analyzerReplica(t);
  const calls = { count: 0 };
  const bridge = await copiedReplicaBridge(t, replica, { value: "accepted" }, calls);
  const input = sourceIndex([{ path: "src/Stable.kt", content: "class Stable\n" }]);
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(calls.count, 1);
  const toolchainPath = path.join(replica.analyzer, "toolchain-v1.json");
  const toolchain = JSON.parse(fs.readFileSync(toolchainPath, "utf8"));
  toolchain.cacheIdentityRevision = 1;
  fs.writeFileSync(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
  refreshReplicaReceipt(replica);
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(calls.count, 2, "a receipt-only identity transition must clear the old LRU");
  const fakeJdk = path.join(replica.replicaRoot, "cache-identity-jdk");
  for (const directory of ["bin", "lib/server"]) fs.mkdirSync(path.join(fakeJdk, directory), { recursive: true, mode: 0o755 });
  for (const [name, content, executable] of [
    ["release", "JAVA_VERSION=cache-identity\n", false], ["bin/java", "#!/bin/sh\nexit 0\n", true],
    ["bin/javac", "javac", true], ["bin/jar", "jar", true], ["lib/modules", "modules", false],
    ["lib/libjava.dylib", "libjava", false], ["lib/libjli.dylib", "libjli", false], ["lib/server/libjvm.dylib", "libjvm", false],
  ]) {
    const file = path.join(fakeJdk, ...name.split("/"));
    fs.writeFileSync(file, content, { mode: executable ? 0o755 : 0o644 });
    if (executable) fs.chmodSync(file, 0o755);
  }
  const diagnostics = ["release", "bin/java", "bin/javac", "bin/jar", "lib/modules", "lib/libjava.dylib", "lib/libjli.dylib", "lib/server/libjvm.dylib"].map((name) => {
    const bytes = fs.readFileSync(path.join(fakeJdk, ...name.split("/")));
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  toolchain.platforms[0].jdk = { home: fakeJdk, version: "cache-identity-jdk-v1", tree: treeIdentity(fakeJdk), diagnostics };
  fs.writeFileSync(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
  refreshReplicaReceipt(replica);
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(calls.count, 3, "a JDK-only executable identity transition must clear the old LRU");
});
test("build env rejects parent and Node-option injection before publishing", () => {
  const before = fs.readFileSync(RECEIPT);
  for (const args of [
    ["-i", ...CLEAN_ENV, "NODE_OPTIONS=", "/usr/local/bin/node", BUILD, "verify"],
    ["-i", ...CLEAN_ENV, "NODE_PATH=/tmp/injected", "/usr/local/bin/node", BUILD, "verify"],
    ["-i", ...CLEAN_ENV, "/usr/local/bin/node", "--no-warnings", BUILD, "verify"],
    ["-i", ...CLEAN_ENV, "/usr/local/bin/node", BUILD, "verify", "--dependency-root", "relative"],
  ]) {
    const result = spawnSync("/usr/bin/env", args, { encoding: "utf8" });
    assert.notEqual(result.status, 0, args.join(" "));
  }
  assert.deepEqual(fs.readFileSync(RECEIPT), before);
});
test("fake JDK proves successful javac and jar children receive only frozen env and argv", (t) => {
  const replica = analyzerReplica(t);
  const fakeJdk = path.join(replica.replicaRoot, "fake-jdk");
  const fakeDependencies = path.join(replica.replicaRoot, "fake-dependencies");
  const log = path.join(replica.replicaRoot, "child-log.jsonl");
  fs.mkdirSync(path.join(fakeJdk, "bin"), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(fakeJdk, "lib/server"), { recursive: true, mode: 0o755 });
  const toolSource = (tool) => `#!/usr/bin/perl\nuse strict; use warnings; use JSON::PP; use Cwd qw(getcwd); use File::Copy qw(copy);\nopen(my $fh, ">>", ${JSON.stringify(log)}) or die $!;\nmy $row={tool=>${JSON.stringify(tool)},argv=>[\@ARGV],cwd=>getcwd(),env=>{%ENV}};\nprint $fh encode_json($row), "\\n"; close($fh);\n${tool === "jar" ? `my $at=-1; for(my $i=0;$i<scalar(@ARGV);$i++){if($ARGV[$i] eq "--file"){$at=$i;last;}} exit(91) if $at<0; copy(${JSON.stringify(ARTIFACT)},$ARGV[$at+1]) or die $!;` : ""}\n`;
  for (const tool of ["java", "javac", "jar"]) {
    const file = path.join(fakeJdk, "bin", tool);
    fs.writeFileSync(file, toolSource(tool), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  for (const [name, content] of [["release", "JAVA_VERSION=fake\n"], ["lib/modules", "modules"], ["lib/libjava.dylib", "libjava"], ["lib/libjli.dylib", "libjli"], ["lib/server/libjvm.dylib", "libjvm"]]) {
    const file = path.join(fakeJdk, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, content);
  }
  const dependenciesPath = path.join(replica.analyzer, "dependencies-v1.json");
  const dependencies = JSON.parse(fs.readFileSync(dependenciesPath, "utf8"));
  for (const entry of dependencies.dependencies) {
    entry.relativeCachePath = `fake/${entry.order}.jar`;
    const source = path.join(fakeDependencies, "fake", `${entry.order}.jar`);
    fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`dependency-${entry.order}`);
    fs.writeFileSync(source, bytes);
    entry.bytes = bytes.length;
    entry.sha256 = hash(bytes);
  }
  fs.writeFileSync(dependenciesPath, `${JSON.stringify(dependencies, null, 2)}\n`);
  const diagnostics = ["release", "bin/java", "bin/javac", "bin/jar", "lib/modules", "lib/libjava.dylib", "lib/libjli.dylib", "lib/server/libjvm.dylib"].map((name) => {
    const bytes = fs.readFileSync(path.join(fakeJdk, ...name.split("/")));
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  const toolchainPath = path.join(replica.analyzer, "toolchain-v1.json");
  const toolchain = JSON.parse(fs.readFileSync(toolchainPath, "utf8"));
  toolchain.platforms[0].defaultDependencyRoot = fakeDependencies;
  toolchain.platforms[0].jdk = { home: fakeJdk, version: "fake-jdk-v1", tree: treeIdentity(fakeJdk), diagnostics };
  fs.writeFileSync(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
  const built = runScrubbedNode(replica.build, ["clean-build-twice"]);
  assert.equal(built.status, 0, built.stderr);
  const rows = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.tool), ["javac", "jar", "javac", "jar"]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.env).sort(), ["HOME", "JAVA_HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"]);
    assert.equal(row.env.JAVA_HOME, fakeJdk);
    assert.equal(row.env.LANG, "C"); assert.equal(row.env.LC_ALL, "C"); assert.equal(row.env.TZ, "UTC");
    assert.equal(path.isAbsolute(row.env.HOME), true); assert.equal(path.isAbsolute(row.env.TMPDIR), true);
    assert.equal(row.argv[0], `-J-Duser.home=${row.env.HOME}`);
    assert.equal(row.argv[1], `-J-Djava.io.tmpdir=${row.env.TMPDIR}`);
    assert.equal(row.cwd.endsWith(row.tool === "javac" ? "/source" : "/classes"), true);
    assert.equal(row.argv.some((value) => /JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|NODE_OPTIONS|PATH=/.test(value)), false);
  }
});
