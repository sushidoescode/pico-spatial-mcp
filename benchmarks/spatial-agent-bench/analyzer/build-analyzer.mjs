import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
const PINNED_NODE = Object.freeze({ path: "/usr/local/bin/node", version: "v22.14.0", bytes: 220_243_216, sha256: "c583851fc85e4618b2374cda13399d59d373ad7cebfc4b55160820b88dcce67b" });
const ORCHESTRATOR_ENV = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC", __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0" });
guardOrchestrator();
const ANALYZER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(ANALYZER_ROOT, "../../..");
const ARTIFACTS_ROOT = path.join(ANALYZER_ROOT, ".artifacts");
const PUBLISHED_ROOT = path.join(ARTIFACTS_ROOT, "v1");
const BRIDGE = path.join(ANALYZER_ROOT, "../lib/kotlin-analysis.mjs");
const SOURCE_PATHS = ["AbstractInterpreter.java", "Main.java", "Protocol.java", "PsiIndex.java", "Rules.java"]
  .map((name) => path.join(ANALYZER_ROOT, "src/main/java/com/agentbench/analyzer", name));
const CONFIG_PATHS = ["domain-v1.json", "dependencies-v1.json", "toolchain-v1.json"]
  .map((name) => path.join(ANALYZER_ROOT, name));
const RECEIPT_NAME = "analyzer-build-receipt-v1.json";
const HASH = /^[a-f0-9]{64}$/;
const RECEIPT_DOMAIN = Buffer.from("agentbench-analyzer-receipt-v1\0", "utf8");
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
  "com/agentbench/analyzer/Rules$CallbackSpec.class",
  "com/agentbench/analyzer/Rules$Domain.class",
  "com/agentbench/analyzer/Rules$RuleSpec.class",
  "com/agentbench/analyzer/Rules$SymbolSpec.class",
  "com/agentbench/analyzer/Rules.class",
  "domain-v1.json",
]);
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
const SYMBOL_KINDS = new Set(["type", "constructor", "top_level_function", "member_function", "extension_function", "member_property"]);
const MEMBER_PRECEDENCE = new Set(["not_applicable", "sdk_member_wins", "source_extension_if_no_sdk_member"]);
const CALLBACK_ROLES = new Set([
  "application_entry", "window_content", "stage_content", "launched_effect", "button_click", "coroutine_body",
  "disposable_effect", "dispose_cleanup", "spatial_initial", "spatial_attachments", "spatial_update",
  "collection_element", "collection_predicate", "collection_selector",
]);
const INVOCATION_MODELS = new Set([
  "source_root", "possible_path", "user_action", "launched_path", "acquire_path", "cleanup_path",
  "element_flow", "predicate_flow", "selector_flow",
]);
const EFFECTS = new Set([
  "read", "mutate", "construct", "replace", "unknown_escape", "open", "close", "acquire", "release",
  "load", "readiness", "convert", "place", "status_assign",
]);
const ABSTRACT_TYPES = new Set([
  "boolean", "int", "long", "float", "double", "string", "unit", "java_class", "callable",
  "immutable_iterable", "immutable_list", "integer_range", "coroutine_scope", "android_application",
  "spatial_launch_activity", "bundle", "spatial_app_scope", "spatial_navigator", "stage_style", "spatial_content",
  "component", "component_store", "entity", "entity_collection", "entity_query_condition", "ecs_system", "scene",
  "scene_update_context", "transform_component", "vector3", "quat", "cancellable", "semantic_label", "plane_anchor",
  "plane_anchor_collection", "plane_geometry", "plane_orientation", "plane_tracking_manager",
]);
const CANARY_SYMBOLS = Object.freeze([
  { arguments: [], callbacks: [], effects: ["construct"], fqn: "com.pico.spatial.core.ecs.Component", kind: "constructor", memberPrecedence: "not_applicable", receiverAbstractType: null, returnAbstractType: "component", signature: "Component()" },
  { arguments: [], callbacks: [], effects: [], fqn: "com.pico.spatial.core.ecs.Component", kind: "type", memberPrecedence: "not_applicable", receiverAbstractType: null, returnAbstractType: "component", signature: "open class Component" },
  { arguments: [], callbacks: [], effects: ["construct"], fqn: "com.pico.spatial.core.ecs.Component.clone", kind: "member_function", memberPrecedence: "sdk_member_wins", receiverAbstractType: "component", returnAbstractType: "component", signature: "clone(): Component" },
]);
const REQUIRED_CLASS_REFERENCES = new Set([
  "com/agentbench/analyzer/AbstractInterpreter", "com/agentbench/analyzer/Main", "com/agentbench/analyzer/Protocol", "com/agentbench/analyzer/Protocol$Parser",
  "com/agentbench/analyzer/PsiIndex", "com/agentbench/analyzer/PsiIndex$Edge", "com/agentbench/analyzer/PsiIndex$EdgeRole", "com/agentbench/analyzer/PsiIndex$FileUnit",
  "com/agentbench/analyzer/PsiIndex$ImportEntry", "com/agentbench/analyzer/PsiIndex$Node", "com/agentbench/analyzer/PsiIndex$NodeFlag", "com/agentbench/analyzer/PsiIndex$NodeKind",
  "com/agentbench/analyzer/PsiIndex$Program", "com/agentbench/analyzer/PsiIndex$Result", "com/agentbench/analyzer/PsiIndex$SnapshotRejected", "com/agentbench/analyzer/PsiIndex$Source",
  "com/agentbench/analyzer/PsiIndex$Token", "com/agentbench/analyzer/PsiIndex$TokenKind", "com/agentbench/analyzer/PsiIndex$WitnessKind", "com/agentbench/analyzer/PsiIndex$WitnessNode",
  "com/agentbench/analyzer/Rules", "com/agentbench/analyzer/Rules$AlternativeSpec", "com/agentbench/analyzer/Rules$Analysis", "com/agentbench/analyzer/Rules$ArgumentSpec",
  "com/agentbench/analyzer/Rules$CallbackSpec", "com/agentbench/analyzer/Rules$Domain", "com/agentbench/analyzer/Rules$RuleSpec", "com/agentbench/analyzer/Rules$SymbolSpec",
  "java/lang/Enum", "org/jetbrains/kotlin/cli/jvm/compiler/KotlinCoreEnvironment", "org/jetbrains/kotlin/com/intellij/openapi/util/Disposer",
  "org/jetbrains/kotlin/psi/KtFile", "org/jetbrains/kotlin/psi/KtPsiFactory",
]);
const ALLOWED_CLASS_REFERENCES = new Set([
  "[B", "[I", "[Lcom/agentbench/analyzer/PsiIndex$EdgeRole;", "[Lcom/agentbench/analyzer/PsiIndex$NodeFlag;", "[Lcom/agentbench/analyzer/PsiIndex$NodeKind;",
  "[Lcom/agentbench/analyzer/PsiIndex$TokenKind;", "[Lcom/agentbench/analyzer/PsiIndex$WitnessKind;", "[Ljava/lang/String;", "[Lorg/jetbrains/kotlin/com/intellij/psi/PsiElement;",
  "[Lorg/jetbrains/kotlin/psi/KtStringTemplateEntry;", "[Lorg/jetbrains/kotlin/psi/KtWhenCondition;",
  "com/agentbench/analyzer/AbstractInterpreter", "com/agentbench/analyzer/Main", "com/agentbench/analyzer/Protocol", "com/agentbench/analyzer/Protocol$Parser",
  "com/agentbench/analyzer/PsiIndex", "com/agentbench/analyzer/PsiIndex$Edge", "com/agentbench/analyzer/PsiIndex$EdgeRole", "com/agentbench/analyzer/PsiIndex$FileUnit",
  "com/agentbench/analyzer/PsiIndex$ImportEntry", "com/agentbench/analyzer/PsiIndex$Node", "com/agentbench/analyzer/PsiIndex$NodeFlag", "com/agentbench/analyzer/PsiIndex$NodeKind",
  "com/agentbench/analyzer/PsiIndex$Program", "com/agentbench/analyzer/PsiIndex$Result", "com/agentbench/analyzer/PsiIndex$SnapshotRejected", "com/agentbench/analyzer/PsiIndex$Source",
  "com/agentbench/analyzer/PsiIndex$Token", "com/agentbench/analyzer/PsiIndex$TokenKind", "com/agentbench/analyzer/PsiIndex$WitnessKind", "com/agentbench/analyzer/PsiIndex$WitnessNode",
  "com/agentbench/analyzer/Rules", "com/agentbench/analyzer/Rules$AlternativeSpec", "com/agentbench/analyzer/Rules$Analysis", "com/agentbench/analyzer/Rules$ArgumentSpec",
  "com/agentbench/analyzer/Rules$CallbackSpec", "com/agentbench/analyzer/Rules$Domain", "com/agentbench/analyzer/Rules$RuleSpec", "com/agentbench/analyzer/Rules$SymbolSpec",
  "java/io/IOException", "java/io/InputStream", "java/io/OutputStream", "java/io/PrintStream", "java/lang/Boolean", "java/lang/Byte", "java/lang/Character", "java/lang/Class", "java/lang/Enum", "java/lang/IllegalArgumentException", "java/lang/IllegalStateException", "java/lang/Integer", "java/lang/Long", "java/lang/Math", "java/lang/Number", "java/lang/NumberFormatException", "java/lang/Object", "java/lang/Record", "java/lang/RuntimeException", "java/lang/Short", "java/lang/String", "java/lang/StringBuilder", "java/lang/System", "java/lang/Throwable", "java/lang/invoke/LambdaMetafactory", "java/lang/invoke/MethodHandles", "java/lang/invoke/MethodHandles$Lookup", "java/lang/invoke/StringConcatFactory", "java/lang/runtime/ObjectMethods", "java/nio/ByteBuffer", "java/nio/CharBuffer", "java/nio/charset/CharacterCodingException", "java/nio/charset/Charset", "java/nio/charset/CharsetDecoder", "java/nio/charset/CodingErrorAction", "java/nio/charset/StandardCharsets", "java/security/MessageDigest", "java/security/NoSuchAlgorithmException", "java/util/ArrayDeque", "java/util/ArrayList", "java/util/Base64", "java/util/Base64$Decoder", "java/util/Base64$Encoder", "java/util/Collection", "java/util/Comparator", "java/util/HashMap", "java/util/HashSet", "java/util/HexFormat", "java/util/IdentityHashMap", "java/util/Iterator", "java/util/LinkedHashMap", "java/util/List", "java/util/Map", "java/util/Map$Entry", "java/util/Objects", "java/util/Set", "java/util/regex/Matcher", "java/util/regex/Pattern",
  "org/jetbrains/kotlin/cli/common/CLIConfigurationKeys", "org/jetbrains/kotlin/cli/common/messages/MessageCollector", "org/jetbrains/kotlin/cli/common/messages/MessageCollector$Companion", "org/jetbrains/kotlin/cli/jvm/compiler/EnvironmentConfigFiles", "org/jetbrains/kotlin/cli/jvm/compiler/KotlinCoreEnvironment",
  "org/jetbrains/kotlin/com/intellij/lang/ASTNode", "org/jetbrains/kotlin/com/intellij/openapi/Disposable", "org/jetbrains/kotlin/com/intellij/openapi/util/Disposer", "org/jetbrains/kotlin/com/intellij/openapi/util/TextRange", "org/jetbrains/kotlin/com/intellij/psi/PsiElement", "org/jetbrains/kotlin/com/intellij/psi/PsiErrorElement", "org/jetbrains/kotlin/com/intellij/psi/tree/IElementType", "org/jetbrains/kotlin/com/intellij/psi/tree/TokenSet", "org/jetbrains/kotlin/com/intellij/psi/util/PsiTreeUtil",
  "org/jetbrains/kotlin/config/CommonConfigurationKeys", "org/jetbrains/kotlin/config/CompilerConfiguration", "org/jetbrains/kotlin/lexer/KtTokens", "org/jetbrains/kotlin/name/FqName", "org/jetbrains/kotlin/name/Name",
  "org/jetbrains/kotlin/psi/KtAnnotated", "org/jetbrains/kotlin/psi/KtAnnotationEntry", "org/jetbrains/kotlin/psi/KtArrayAccessExpression", "org/jetbrains/kotlin/psi/KtBinaryExpression", "org/jetbrains/kotlin/psi/KtBinaryExpressionWithTypeRHS", "org/jetbrains/kotlin/psi/KtBlockExpression", "org/jetbrains/kotlin/psi/KtBreakExpression", "org/jetbrains/kotlin/psi/KtCallExpression", "org/jetbrains/kotlin/psi/KtCallableReferenceExpression", "org/jetbrains/kotlin/psi/KtCatchClause", "org/jetbrains/kotlin/psi/KtClass", "org/jetbrains/kotlin/psi/KtClassLiteralExpression", "org/jetbrains/kotlin/psi/KtClassOrObject", "org/jetbrains/kotlin/psi/KtConstantExpression", "org/jetbrains/kotlin/psi/KtConstructorCalleeExpression", "org/jetbrains/kotlin/psi/KtContinueExpression", "org/jetbrains/kotlin/psi/KtDotQualifiedExpression", "org/jetbrains/kotlin/psi/KtDoubleColonExpression", "org/jetbrains/kotlin/psi/KtExpression", "org/jetbrains/kotlin/psi/KtExpressionWithLabel", "org/jetbrains/kotlin/psi/KtFile", "org/jetbrains/kotlin/psi/KtForExpression", "org/jetbrains/kotlin/psi/KtIfExpression", "org/jetbrains/kotlin/psi/KtImportDirective", "org/jetbrains/kotlin/psi/KtLabeledExpression", "org/jetbrains/kotlin/psi/KtLambdaExpression", "org/jetbrains/kotlin/psi/KtModifierListOwner", "org/jetbrains/kotlin/psi/KtNameReferenceExpression", "org/jetbrains/kotlin/psi/KtNamedDeclaration", "org/jetbrains/kotlin/psi/KtNamedFunction", "org/jetbrains/kotlin/psi/KtNullableType", "org/jetbrains/kotlin/psi/KtObjectDeclaration", "org/jetbrains/kotlin/psi/KtOperationReferenceExpression", "org/jetbrains/kotlin/psi/KtPackageDirective", "org/jetbrains/kotlin/psi/KtParameter", "org/jetbrains/kotlin/psi/KtParenthesizedExpression", "org/jetbrains/kotlin/psi/KtPostfixExpression", "org/jetbrains/kotlin/psi/KtPrefixExpression", "org/jetbrains/kotlin/psi/KtProperty", "org/jetbrains/kotlin/psi/KtPsiFactory", "org/jetbrains/kotlin/psi/KtQualifiedExpression", "org/jetbrains/kotlin/psi/KtReturnExpression", "org/jetbrains/kotlin/psi/KtSafeQualifiedExpression", "org/jetbrains/kotlin/psi/KtSimpleNameExpression", "org/jetbrains/kotlin/psi/KtStringTemplateEntry", "org/jetbrains/kotlin/psi/KtStringTemplateExpression", "org/jetbrains/kotlin/psi/KtSuperTypeCallEntry", "org/jetbrains/kotlin/psi/KtSuperTypeListEntry", "org/jetbrains/kotlin/psi/KtThisExpression", "org/jetbrains/kotlin/psi/KtTryExpression", "org/jetbrains/kotlin/psi/KtTypeElement", "org/jetbrains/kotlin/psi/KtTypeProjection", "org/jetbrains/kotlin/psi/KtTypeReference", "org/jetbrains/kotlin/psi/KtUnaryExpression", "org/jetbrains/kotlin/psi/KtUserType", "org/jetbrains/kotlin/psi/KtValueArgument", "org/jetbrains/kotlin/psi/KtValueArgumentName", "org/jetbrains/kotlin/psi/KtWhenCondition", "org/jetbrains/kotlin/psi/KtWhenConditionInRange", "org/jetbrains/kotlin/psi/KtWhenConditionIsPattern", "org/jetbrains/kotlin/psi/KtWhenConditionWithExpression", "org/jetbrains/kotlin/psi/KtWhenEntry", "org/jetbrains/kotlin/psi/KtWhenExpression", "org/jetbrains/kotlin/psi/KtWhileExpressionBase", "org/jetbrains/kotlin/psi/ValueArgument", "org/jetbrains/kotlin/resolve/ImportPath",
]);
const ALLOWED_IMPORTS_BY_SOURCE = new Map([
  ["AbstractInterpreter.java", new Set([
    "java.util.ArrayList", "java.util.HashMap", "java.util.List", "java.util.Map",
  ])],
  ["Main.java", new Set([
    "java.nio.ByteBuffer", "java.nio.charset.CharacterCodingException", "java.nio.charset.CodingErrorAction", "java.nio.charset.StandardCharsets",
    "java.util.ArrayList", "java.util.Base64", "java.util.LinkedHashMap", "java.util.List", "java.util.Map", "java.util.Set", "java.util.regex.Pattern",
  ])],
  ["Protocol.java", new Set([
    "java.io.IOException", "java.io.InputStream", "java.io.OutputStream", "java.nio.ByteBuffer",
    "java.nio.charset.CharacterCodingException", "java.nio.charset.CodingErrorAction", "java.nio.charset.StandardCharsets",
    "java.security.MessageDigest", "java.security.NoSuchAlgorithmException", "java.util.ArrayList", "java.util.Arrays",
    "java.util.Comparator", "java.util.LinkedHashMap", "java.util.List", "java.util.Map",
  ])],
  ["PsiIndex.java", new Set([
    "java.nio.charset.StandardCharsets", "java.util.ArrayDeque", "java.util.ArrayList", "java.util.HashMap", "java.util.HashSet",
    "java.util.IdentityHashMap", "java.util.List", "java.util.Map", "java.util.Objects", "java.util.Set",
    "org.jetbrains.kotlin.cli.common.CLIConfigurationKeys",
    "org.jetbrains.kotlin.cli.common.messages.MessageCollector", "org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles",
    "org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment", "org.jetbrains.kotlin.com.intellij.openapi.Disposable",
    "org.jetbrains.kotlin.com.intellij.openapi.util.Disposer", "org.jetbrains.kotlin.com.intellij.openapi.util.TextRange",
    "org.jetbrains.kotlin.com.intellij.psi.PsiElement", "org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement",
    "org.jetbrains.kotlin.com.intellij.psi.tree.IElementType", "org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil",
    "org.jetbrains.kotlin.config.CommonConfigurationKeys", "org.jetbrains.kotlin.config.CompilerConfiguration", "org.jetbrains.kotlin.lexer.KtTokens",
    "org.jetbrains.kotlin.psi.KtAnnotated", "org.jetbrains.kotlin.psi.KtAnnotationEntry",
    "org.jetbrains.kotlin.psi.KtArrayAccessExpression", "org.jetbrains.kotlin.psi.KtBinaryExpression",
    "org.jetbrains.kotlin.psi.KtBinaryExpressionWithTypeRHS", "org.jetbrains.kotlin.psi.KtBlockExpression",
    "org.jetbrains.kotlin.psi.KtBreakExpression", "org.jetbrains.kotlin.psi.KtCallExpression",
    "org.jetbrains.kotlin.psi.KtCallableReferenceExpression", "org.jetbrains.kotlin.psi.KtCatchClause",
    "org.jetbrains.kotlin.psi.KtClass", "org.jetbrains.kotlin.psi.KtClassLiteralExpression",
    "org.jetbrains.kotlin.psi.KtClassOrObject", "org.jetbrains.kotlin.psi.KtConstantExpression",
    "org.jetbrains.kotlin.psi.KtConstructorCalleeExpression", "org.jetbrains.kotlin.psi.KtContinueExpression",
    "org.jetbrains.kotlin.psi.KtDotQualifiedExpression", "org.jetbrains.kotlin.psi.KtDoubleColonExpression",
    "org.jetbrains.kotlin.psi.KtExpression", "org.jetbrains.kotlin.psi.KtExpressionWithLabel",
    "org.jetbrains.kotlin.psi.KtFile", "org.jetbrains.kotlin.psi.KtForExpression",
    "org.jetbrains.kotlin.psi.KtIfExpression", "org.jetbrains.kotlin.psi.KtImportDirective",
    "org.jetbrains.kotlin.psi.KtLabeledExpression", "org.jetbrains.kotlin.psi.KtLambdaExpression",
    "org.jetbrains.kotlin.psi.KtModifierListOwner", "org.jetbrains.kotlin.psi.KtNameReferenceExpression",
    "org.jetbrains.kotlin.psi.KtNamedDeclaration", "org.jetbrains.kotlin.psi.KtNamedFunction",
    "org.jetbrains.kotlin.psi.KtNullableType", "org.jetbrains.kotlin.psi.KtObjectDeclaration",
    "org.jetbrains.kotlin.psi.KtPackageDirective", "org.jetbrains.kotlin.psi.KtParameter",
    "org.jetbrains.kotlin.psi.KtParenthesizedExpression", "org.jetbrains.kotlin.psi.KtPostfixExpression",
    "org.jetbrains.kotlin.psi.KtPrefixExpression", "org.jetbrains.kotlin.psi.KtProperty",
    "org.jetbrains.kotlin.psi.KtPsiFactory", "org.jetbrains.kotlin.psi.KtQualifiedExpression",
    "org.jetbrains.kotlin.psi.KtReturnExpression", "org.jetbrains.kotlin.psi.KtSafeQualifiedExpression",
    "org.jetbrains.kotlin.psi.KtStringTemplateEntry", "org.jetbrains.kotlin.psi.KtStringTemplateExpression",
    "org.jetbrains.kotlin.psi.KtSuperTypeCallEntry", "org.jetbrains.kotlin.psi.KtSuperTypeListEntry", "org.jetbrains.kotlin.psi.KtThisExpression",
    "org.jetbrains.kotlin.psi.KtTryExpression", "org.jetbrains.kotlin.psi.KtTypeElement",
    "org.jetbrains.kotlin.psi.KtTypeProjection", "org.jetbrains.kotlin.psi.KtTypeReference",
    "org.jetbrains.kotlin.psi.KtUnaryExpression", "org.jetbrains.kotlin.psi.KtUserType",
    "org.jetbrains.kotlin.psi.KtValueArgument", "org.jetbrains.kotlin.psi.KtValueArgumentName",
    "org.jetbrains.kotlin.psi.KtWhenCondition", "org.jetbrains.kotlin.psi.KtWhenConditionInRange",
    "org.jetbrains.kotlin.psi.KtWhenConditionIsPattern", "org.jetbrains.kotlin.psi.KtWhenConditionWithExpression",
    "org.jetbrains.kotlin.psi.KtWhenEntry", "org.jetbrains.kotlin.psi.KtWhenExpression",
    "org.jetbrains.kotlin.psi.KtWhileExpressionBase", "org.jetbrains.kotlin.resolve.ImportPath",
  ])],
  ["Rules.java", new Set([
    "java.io.IOException", "java.io.InputStream", "java.util.ArrayList", "java.util.HashMap",
    "java.util.LinkedHashMap", "java.util.List", "java.util.Map", "java.util.Set",
  ])],
]);
function fail(message) { throw new Error(`analyzer build rejected: ${message}`); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("receipt contains a non-canonical number");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("receipt contains unsupported data");
}
function isPlainObject(value) { return value !== null && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, expected, label) {
  if (!isPlainObject(value) || canonicalJson(Object.keys(value).sort(compare)) !== canonicalJson([...expected].sort(compare))) {
    fail(`${label} keys mismatch`);
  }
}
function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
}
function validateUniqueStrings(value, allowlist, label) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) fail(`${label} must be a unique string array`);
  for (const entry of value) {
    nonemptyString(entry, label);
    if (allowlist && !allowlist.has(entry)) fail(`${label} contains an unknown value`);
  }
}
function validateDomain(domain) {
  if (!domain.material.bytes.equals(Buffer.from(canonicalJson(domain.value), "utf8"))) {
    fail("domain-v1.json is not canonical JSON without trailing bytes");
  }
  const value = domain.value;
  exactKeys(value, new Set([
    "acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule",
    "ruleOrder", "symbols", "witnessKinds",
  ]), "domain");
  if (value.analyzerName !== "supported-subset-abstract-interpreter-v1" || value.domainVersion !== 1) fail("domain identity mismatch");
  if (canonicalJson(value.ruleOrder) !== canonicalJson(RULE_ORDER)) fail("domain rule order mismatch");
  if (canonicalJson(value.witnessKinds) !== canonicalJson(WITNESS_KINDS)) fail("domain witness vocabulary mismatch");
  if (canonicalJson(value.proofFormsByRule) !== canonicalJson(PROOF_FORMS_BY_RULE)) fail("domain proof-form vocabulary mismatch");
  if (canonicalJson(value.acceptedAlternativesByRule) !== canonicalJson(ACCEPTED_ALTERNATIVES_BY_RULE)) fail("domain alternative vocabulary mismatch");
  if (!Array.isArray(value.symbols)) fail("domain symbols must be an array");
  const identities = [];
  for (const [symbolIndex, symbol] of value.symbols.entries()) {
    const label = `domain symbols[${symbolIndex}]`;
    exactKeys(symbol, new Set([
      "arguments", "callbacks", "effects", "fqn", "kind", "memberPrecedence",
      "receiverAbstractType", "returnAbstractType", "signature",
    ]), label);
    nonemptyString(symbol.fqn, `${label} fqn`);
    nonemptyString(symbol.signature, `${label} signature`);
    if (!SYMBOL_KINDS.has(symbol.kind)) fail(`${label} kind is unknown`);
    if (!MEMBER_PRECEDENCE.has(symbol.memberPrecedence)) fail(`${label} member precedence is unknown`);
    for (const [typeLabel, abstractType] of [["receiver", symbol.receiverAbstractType], ["return", symbol.returnAbstractType]]) {
      if (abstractType !== null && !ABSTRACT_TYPES.has(abstractType)) fail(`${label} ${typeLabel} abstract type is unknown`);
    }
    if (!Array.isArray(symbol.arguments)) fail(`${label} arguments must be an array`);
    for (const [argumentIndex, argument] of symbol.arguments.entries()) {
      exactKeys(argument, new Set(["abstractType", "name", "position"]), `${label} argument`);
      if (argument.position !== argumentIndex) fail(`${label} argument positions must be dense and ordered`);
      if (argument.name !== null) nonemptyString(argument.name, `${label} argument name`);
      if (!ABSTRACT_TYPES.has(argument.abstractType)) fail(`${label} argument abstract type is unknown`);
    }
    if (!Array.isArray(symbol.callbacks)) fail(`${label} callbacks must be an array`);
    const callbackPositions = new Set();
    for (const callback of symbol.callbacks) {
      exactKeys(callback, new Set(["argumentPosition", "invocationModel", "role"]), `${label} callback`);
      if (!Number.isSafeInteger(callback.argumentPosition) || callback.argumentPosition < 0
          || callback.argumentPosition >= symbol.arguments.length || callbackPositions.has(callback.argumentPosition)) {
        fail(`${label} callback position is invalid or duplicated`);
      }
      callbackPositions.add(callback.argumentPosition);
      if (!CALLBACK_ROLES.has(callback.role) || !INVOCATION_MODELS.has(callback.invocationModel)) fail(`${label} callback vocabulary is unknown`);
    }
    validateUniqueStrings(symbol.effects, EFFECTS, `${label} effects`);
    identities.push(canonicalJson({ fqn: symbol.fqn, signature: symbol.signature }));
  }
  if (canonicalJson(identities) !== canonicalJson([...new Set(identities)].sort(compare))) fail("domain symbols are not sorted uniquely");
  for (const canary of CANARY_SYMBOLS) {
    const actual = value.symbols.find((symbol) => symbol.fqn === canary.fqn && symbol.signature === canary.signature);
    if (!actual || canonicalJson(actual) !== canonicalJson(canary)) fail(`domain clone canary symbol mismatch: ${canary.fqn} ${canary.signature}`);
  }
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function receiptDigest(value) { return sha256(Buffer.concat([RECEIPT_DOMAIN, Buffer.from(canonicalJson(value), "utf8")])); }
function sameStat(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function stableFile(file, label = file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(file) !== file) fail(`${label} is not a canonical regular file`);
  const bytes = fs.readFileSync(file); const after = fs.lstatSync(file);
  if (!sameStat(before, after) || bytes.length !== before.size) fail(`${label} changed while read`);
  return Object.freeze({ bytes, size: bytes.length, sha256: sha256(bytes) });
}
function guardOrchestrator() {
  const keys = Object.keys(process.env).sort(compare);
  const expectedKeys = Object.keys(ORCHESTRATOR_ENV).sort(compare);
  if (canonicalJson(keys) !== canonicalJson(expectedKeys)) fail("orchestrator environment names do not match the four-name allowlist");
  for (const key of expectedKeys) if (process.env[key] !== ORCHESTRATOR_ENV[key]) fail(`orchestrator environment ${key} mismatch`);
  if (process.execArgv.length !== 0 || Object.hasOwn(process.env, "NODE_OPTIONS") || Object.hasOwn(process.env, "NODE_PATH")) {
    fail("Node preload or exec options are forbidden");
  }
  if (process.execPath !== PINNED_NODE.path || fs.realpathSync(process.execPath) !== PINNED_NODE.path || process.version !== PINNED_NODE.version) {
    fail("Node executable identity mismatch");
  }
  const node = stableFile(PINNED_NODE.path, "pinned Node");
  if (node.size !== PINNED_NODE.bytes || node.sha256 !== PINNED_NODE.sha256) fail("Node bytes mismatch");
}
function loadJson(file) {
  const material = stableFile(file); try { return { value: JSON.parse(material.bytes.toString("utf8")), material }; } catch { fail(`${path.basename(file)} is not valid JSON`); }
}
function ensureAbsoluteOverride(value, label) {
  if (!path.isAbsolute(value)) fail(`${label} must be absolute`);
  const resolved = path.resolve(value);
  if (resolved !== value) fail(`${label} must be normalized`);
  return value;
}
function parseArguments() {
  const command = process.argv[2];
  if (!new Set(["build", "verify", "clean-build-twice"]).has(command)) fail("expected build, verify, or clean-build-twice");
  const options = {};
  for (let index = 3; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!value || !new Set(["--dependency-root", "--jdk-root"]).has(flag) || Object.hasOwn(options, flag)) fail("unknown or incomplete option");
    options[flag] = ensureAbsoluteOverride(value, flag);
  }
  return { command, dependencyRoot: options["--dependency-root"], jdkRoot: options["--jdk-root"] };
}
function mode(stat) { return (stat.mode & 0o777).toString(8).padStart(4, "0"); }
function treeIdentity(root) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) fail("JDK root is not canonical");
  const entries = [];
  const counts = { entries: 0, files: 0, directories: 0, symlinks: 0, fileBytes: 0 };
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const absolute = path.join(directory, name);
      const itemPath = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const logical = path.resolve(path.dirname(absolute), target);
        const resolved = fs.realpathSync(absolute);
        if (!(logical === root || logical.startsWith(`${root}${path.sep}`)) || !(resolved === root || resolved.startsWith(`${root}${path.sep}`))) fail(`JDK symlink escapes its root: ${itemPath}`);
        entries.push({ path: itemPath, type: "symlink", mode: mode(stat), target });
        counts.symlinks += 1;
      } else if (stat.isDirectory()) {
        entries.push({ path: itemPath, type: "dir", mode: mode(stat) });
        counts.directories += 1;
        visit(absolute, itemPath);
      } else if (stat.isFile()) {
        const file = stableFile(absolute, `JDK ${itemPath}`);
        entries.push({ path: itemPath, type: "file", mode: mode(stat), bytes: file.size, sha256: file.sha256 });
        counts.files += 1;
        counts.fileBytes += file.size;
      } else fail(`JDK contains special file ${itemPath}`);
    }
  }
  visit(root);
  counts.entries = entries.length;
  return Object.freeze({ ...counts, sha256: sha256(canonicalJson(entries)) });
}
function assertIdentity(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) fail(`${label} ${key} mismatch`);
}
function assertFileIdentity(actual, expected, label) {
  if (actual.size !== expected.bytes || actual.sha256 !== expected.sha256) fail(`${label} bytes or sha256 mismatch`);
}
function platformMaterial(arguments_) {
  const toolchain = loadJson(CONFIG_PATHS[2]);
  const dependencies = loadJson(CONFIG_PATHS[1]);
  const domain = loadJson(CONFIG_PATHS[0]);
  validateDomain(domain);
  if (toolchain.value.schemaVersion !== 1 || dependencies.value.schemaVersion !== 1 || domain.value.domainVersion !== 1) fail("manifest version mismatch");
  const row = toolchain.value.platforms.find((entry) => entry.platform === process.platform && entry.arch === process.arch && entry.uid === process.getuid());
  if (!row) fail("no reviewed toolchain row for this platform/architecture/uid");
  assertIdentity(PINNED_NODE, row.node, "toolchain Node");
  if (canonicalJson(row.orchestratorEnvironment) !== canonicalJson(ORCHESTRATOR_ENV)) fail("toolchain environment mismatch");
  const dependencyRoot = arguments_.dependencyRoot ?? row.defaultDependencyRoot;
  const jdkRoot = arguments_.jdkRoot ?? row.jdk.home;
  if (!path.isAbsolute(dependencyRoot) || fs.realpathSync(dependencyRoot) !== dependencyRoot || !fs.lstatSync(dependencyRoot).isDirectory()) fail("dependency root is not canonical");
  const jdkTree = treeIdentity(jdkRoot);
  assertIdentity(jdkTree, row.jdk.tree, "JDK tree");
  const diagnostics = row.jdk.diagnostics.map((expected) => {
    const file = stableFile(path.join(jdkRoot, ...expected.path.split("/")), `JDK ${expected.path}`);
    assertFileIdentity(file, expected, `JDK ${expected.path}`);
    return { ...expected };
  });
  const runtime = dependencies.value.dependencies.map((entry, index) => {
    if (entry.order !== index + 1 || entry.artifactName.slice(0, 2) !== String(index + 1).padStart(2, "0")) fail("dependency order mismatch");
    if (!HASH.test(entry.sha256) || entry.relativeCachePath.startsWith("/") || entry.relativeCachePath.includes("..")) fail("dependency manifest path/hash invalid");
    const source = path.join(dependencyRoot, ...entry.relativeCachePath.split("/"));
    const file = stableFile(source, entry.coordinate);
    assertFileIdentity(file, entry, entry.coordinate);
    return Object.freeze({ ...entry, source });
  });
  return Object.freeze({ row, dependencyRoot, jdkRoot, jdkTree, diagnostics, runtime, toolchain, dependencies, domain });
}
function childEnvironment(jdkRoot, home, temporary) {
  return Object.freeze({ JAVA_HOME: jdkRoot, HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C", TZ: "UTC" });
}
function runTool(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, shell: false, encoding: null, maxBuffer: 4_194_304 });
  if (result.error || result.signal || result.status !== 0 || result.stderr.length !== 0) {
    const diagnostic = Buffer.from(result.stderr ?? "").toString("utf8").replace(/[\r\n]+/g, " ").slice(0, 1_000);
    fail(`${path.basename(command)} failed (${result.error?.code ?? result.signal ?? result.status ?? "unknown"}): ${diagnostic}`);
  }
  if (result.stdout.length !== 0) fail(`${path.basename(command)} wrote unexpected stdout`);
}
function copyStable(source, target) {
  const before = stableFile(source);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  const after = stableFile(target);
  if (before.size !== after.size || before.sha256 !== after.sha256) fail("staged file identity mismatch");
}
function listFiles(root, relative = "") {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort(compare)) {
    const child = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, child));
    if (stat.isDirectory() && !stat.isSymbolicLink()) result.push(...listFiles(root, child));
    else if (stat.isFile() && !stat.isSymbolicLink()) result.push(child);
    else fail("class staging contains a symlink or special file");
  }
  return result;
}
function scanSourceCapabilities(javaSources) {
  const sourceNames = javaSources.map((source) => path.basename(source)).sort(compare);
  if (canonicalJson(sourceNames) !== canonicalJson([...ALLOWED_IMPORTS_BY_SOURCE.keys()].sort(compare))) fail("source import policy does not cover the exact five-source inventory");
  const forbiddenText = [
    "ProcessBuilder", "ProcessHandle", "Runtime.getRuntime", "Runtime.exec", "ClassLoader", "Class.forName",
    "getClassLoader", "loadClass", "java.net.", "javax.net.", "java.nio.file.", "java.io.File", "java.lang.reflect",
    "java.lang.invoke", "javax.script", "javax.tools", "kotlin.script", "K2JVMCompiler", "KotlinCompileDaemon",
  ];
  for (const source of javaSources) {
    const text = stableFile(source).bytes.toString("utf8");
    const sourceName = path.basename(source);
    const allowedImports = ALLOWED_IMPORTS_BY_SOURCE.get(sourceName);
    const imports = [];
    for (const match of text.matchAll(/^import\s+(static\s+)?([^;]+);$/gm)) {
      if (match[1] || !allowedImports.has(match[2])) fail(`sidecar source contains unreviewed import ${match[0]}`);
      imports.push(match[2]);
    }
    if (imports.length !== new Set(imports).size) fail(`${sourceName} contains a duplicate import`);
    if ((sourceName === "AbstractInterpreter.java" || sourceName === "Rules.java")
        && (text.includes("org.jetbrains.kotlin") || text.includes("com.intellij"))) fail(`${sourceName} contains a PSI or Kotlin compiler reference`);
    for (const token of forbiddenText) if (text.includes(token)) fail(`sidecar source contains forbidden capability ${token}`);
  }
}
function scanClassCapabilities(classesRoot) {
  const forbiddenBytes = [
    "java/lang/ProcessBuilder", "java/lang/ProcessHandle", "java/lang/ClassLoader",
    "java/io/File", "java/nio/file/", "java/net/", "javax/net/", "javax/script/", "javax/tools/",
    "java/lang/reflect/", "kotlin/script", "K2JVMCompiler", "KotlinCompileDaemon", "loadClass", "forName",
  ].map((value) => Buffer.from(value));
  for (const relative of listFiles(classesRoot).filter((name) => name.endsWith(".class"))) {
    const bytes = stableFile(path.join(classesRoot, relative)).bytes;
    for (const token of forbiddenBytes) if (bytes.includes(token)) fail(`sidecar bytecode contains forbidden capability ${token}`);
    if (classReferences(bytes).includes("java/lang/Runtime")) fail("sidecar bytecode contains forbidden capability java/lang/Runtime");
    if ((relative === "com/agentbench/analyzer/AbstractInterpreter.class"
        || relative === "com/agentbench/analyzer/Rules.class"
        || relative.startsWith("com/agentbench/analyzer/Rules$"))
        && (bytes.includes(Buffer.from("org/jetbrains/kotlin/")) || bytes.includes(Buffer.from("com/intellij/")))) {
      fail(`semantic bytecode ${relative} contains a PSI or Kotlin compiler reference`);
    }
  }
}
function classReferences(bytes) {
  if (bytes.length < 10 || bytes.readUInt32BE(0) !== 0xcafebabe) fail("invalid analyzer class file");
  const pool = new Array(bytes.readUInt16BE(8));
  let cursor = 10;
  for (let index = 1; index < pool.length; index += 1) {
    const tag = bytes.readUInt8(cursor++);
    if (tag === 1) { const length = bytes.readUInt16BE(cursor); cursor += 2; pool[index] = { tag, value: bytes.subarray(cursor, cursor + length).toString("utf8") }; cursor += length; }
    else if (tag === 7) { pool[index] = { tag, name: bytes.readUInt16BE(cursor) }; cursor += 2; }
    else if (new Set([3, 4, 9, 10, 11, 12, 17, 18]).has(tag)) cursor += 4;
    else if (new Set([5, 6]).has(tag)) { cursor += 8; index += 1; }
    else if (new Set([8, 16, 19, 20]).has(tag)) cursor += 2;
    else if (tag === 15) cursor += 3;
    else fail(`unsupported analyzer class constant-pool tag ${tag}`);
  }
  return pool.filter((entry) => entry?.tag === 7).map((entry) => pool[entry.name]?.value ?? fail("invalid analyzer class reference"));
}
function inspectJar(bytes) {
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0 || eocd + 22 !== bytes.length || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
      || bytes.readUInt16LE(eocd + 20) !== 0) fail("thin JAR has an invalid end record");
  const count = bytes.readUInt16LE(eocd + 10);
  if (bytes.readUInt16LE(eocd + 8) !== count) fail("thin JAR split entry count is invalid");
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  let expectedLocalOffset = 0;
  const entries = [];
  const contents = new Map();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) fail("thin JAR central directory is invalid");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");
    if (!name || name.endsWith("/") || name.startsWith("/") || name.split("/").includes("..") || contents.has(name)
        || localOffset !== expectedLocalOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50
        || bytes.readUInt16LE(cursor + 4) !== 20 || bytes.readUInt16LE(cursor + 6) !== 20 || flags !== 0x0808 || method !== 8
        || bytes.readUInt16LE(cursor + 12) !== 1 || bytes.readUInt16LE(cursor + 14) !== 33
        || bytes.readUInt16LE(cursor + 34) !== 0 || bytes.readUInt16LE(cursor + 36) !== 0 || bytes.readUInt32LE(cursor + 38) !== 0) fail("thin JAR entry metadata is invalid or duplicated");
    const localNameBytes = bytes.readUInt16LE(localOffset + 26);
    const localExtraBytes = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes);
    const centralName = bytes.subarray(cursor + 46, cursor + 46 + nameBytes);
    const centralExtra = bytes.subarray(cursor + 46 + nameBytes, cursor + 46 + nameBytes + extraBytes);
    const localExtra = bytes.subarray(localOffset + 30 + localNameBytes, localOffset + 30 + localNameBytes + localExtraBytes);
    if (bytes.readUInt16LE(localOffset + 4) !== 20 || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method
        || bytes.readUInt16LE(localOffset + 10) !== 1 || bytes.readUInt16LE(localOffset + 12) !== 33 || !localName.equals(centralName)
        || !localExtra.equals(centralExtra) || !(extraBytes === 0 || (extraBytes === 4 && centralExtra.equals(Buffer.from([0xfe, 0xca, 0, 0]))))) fail("thin JAR local metadata mismatch");
    const dataStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const compressed = bytes.subarray(dataStart, dataStart + compressedBytes);
    const content = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : fail("thin JAR compression is unsupported");
    if (content.length !== uncompressedBytes) fail("thin JAR entry length mismatch");
    const descriptor = dataStart + compressedBytes;
    if (bytes.readUInt32LE(descriptor) !== 0x08074b50 || bytes.readUInt32LE(descriptor + 4) !== bytes.readUInt32LE(cursor + 16)
        || bytes.readUInt32LE(descriptor + 8) !== compressedBytes || bytes.readUInt32LE(descriptor + 12) !== uncompressedBytes) fail("thin JAR data descriptor mismatch");
    expectedLocalOffset = descriptor + 16;
    entries.push(name); contents.set(name, content);
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (expectedLocalOffset !== centralOffset || cursor !== centralOffset + centralBytes || cursor !== eocd) fail("thin JAR central-directory extent mismatch");
  return { entries, contents };
}
function assertReviewedJar(material, inspection) {
  if (canonicalJson(inspection.entries) !== canonicalJson(EXPECTED_JAR_ENTRIES)) fail("thin JAR entries do not match the reviewed Batch2A inventory");
  const embeddedDomain = inspection.contents.get("domain-v1.json");
  if (!embeddedDomain || sha256(embeddedDomain) !== material.domain.material.sha256) fail("thin JAR embedded domain mismatch");
  const references = new Set();
  for (const [name, content] of inspection.contents) {
    if (!name.endsWith(".class")) continue;
    for (const token of ["java/lang/ProcessBuilder", "java/lang/ProcessHandle", "java/lang/ClassLoader", "java/io/File", "java/nio/file/", "java/net/", "javax/net/", "javax/script/", "javax/tools/", "java/lang/reflect/", "kotlin/script", "K2JVMCompiler", "KotlinCompileDaemon", "loadClass", "forName"]) {
      if (content.includes(Buffer.from(token))) fail(`thin JAR bytecode ${name} contains forbidden capability ${token}`);
    }
    const classNames = classReferences(content);
    if (classNames.includes("java/lang/Runtime")) fail(`thin JAR bytecode ${name} contains forbidden capability java/lang/Runtime`);
    if ((name === "com/agentbench/analyzer/AbstractInterpreter.class"
        || name === "com/agentbench/analyzer/Rules.class"
        || name.startsWith("com/agentbench/analyzer/Rules$"))
        && (content.includes(Buffer.from("org/jetbrains/kotlin/")) || content.includes(Buffer.from("com/intellij/")))) {
      fail(`semantic bytecode ${name} contains a PSI or Kotlin compiler reference`);
    }
    for (const reference of classNames) references.add(reference);
  }
  const actual = [...references].sort(compare);
  const missing = [...REQUIRED_CLASS_REFERENCES].filter((reference) => !references.has(reference)).sort(compare);
  const surplus = actual.filter((reference) => !ALLOWED_CLASS_REFERENCES.has(reference));
  if (missing.length !== 0 || surplus.length !== 0) {
    fail(`thin JAR bytecode class-reference bounds mismatch: missing=${canonicalJson(missing)} surplus=${canonicalJson(surplus)} actual=${canonicalJson(actual)}`);
  }
  return Object.freeze(actual);
}
function cleanBuild(buildRoot, material) {
  const stagedSource = path.join(buildRoot, "source");
  const classes = path.join(buildRoot, "classes");
  const buildHome = path.join(buildRoot, "home");
  const buildTmp = path.join(buildRoot, "tmp");
  for (const directory of [stagedSource, classes, buildHome, buildTmp]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const javaSources = SOURCE_PATHS.map((source) => {
    const relative = path.relative(ANALYZER_ROOT, source);
    const target = path.join(stagedSource, relative);
    copyStable(source, target);
    return target;
  }).sort(compare);
  scanSourceCapabilities(javaSources);
  const classpath = material.runtime.map((entry) => entry.source).join(path.delimiter);
  const environment = childEnvironment(material.jdkRoot, buildHome, buildTmp);
  runTool(path.join(material.jdkRoot, "bin/javac"), [
    `-J-Duser.home=${buildHome}`, `-J-Djava.io.tmpdir=${buildTmp}`,
    "--release", "17", "-encoding", "UTF-8", "-g:none", "-proc:none",
    "-classpath", classpath, "-d", classes, ...javaSources,
  ], { cwd: stagedSource, env: environment });
  copyStable(CONFIG_PATHS[0], path.join(classes, "domain-v1.json"));
  scanClassCapabilities(classes);
  const entries = listFiles(classes);
  if (!entries.includes("domain-v1.json") || entries.some((entry) => entry !== "domain-v1.json" && !entry.endsWith(".class"))) fail("thin JAR staging has an unexpected entry");
  const argumentFile = path.join(buildRoot, "jar-entries.txt");
  fs.writeFileSync(argumentFile, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  const jar = path.join(buildRoot, "analyzer-v1.jar");
  runTool(path.join(material.jdkRoot, "bin/jar"), [
    `-J-Duser.home=${buildHome}`, `-J-Djava.io.tmpdir=${buildTmp}`,
    "--create", "--no-manifest", "--file", jar, "--date=1980-01-01T00:00:02Z", `@${argumentFile}`,
  ], { cwd: classes, env: environment });
  const identity = stableFile(jar);
  const inspection = inspectJar(identity.bytes);
  const references = assertReviewedJar(material, inspection);
  return Object.freeze({ jar, bytes: identity.size, sha256: identity.sha256, entries: inspection.entries, classReferences: references });
}
function relativeRepositoryPath(file) {
  const relative = path.relative(REPOSITORY_ROOT, file).split(path.sep).join("/");
  if (relative.startsWith("../") || relative === "..") fail("receipt input escapes repository");
  return relative;
}
function sourceInputs() {
  return [...SOURCE_PATHS, ...CONFIG_PATHS, fileURLToPath(import.meta.url), BRIDGE].sort(compare).map((file) => {
    const material = stableFile(file);
    return { path: relativeRepositoryPath(file), bytes: material.size, sha256: material.sha256 };
  });
}
function receiptWithoutHash(material, jar, buildHashes) {
  const runtime = material.runtime.map((entry) => ({ order: entry.order, coordinate: entry.coordinate, path: `runtime/${entry.artifactName}`, bytes: entry.bytes, sha256: entry.sha256 }));
  const classpath = [{ path: "analyzer-v1.jar", bytes: jar.bytes, sha256: jar.sha256 }, ...runtime];
  const runCwd = path.join(PUBLISHED_ROOT, "run-cwd");
  const runHome = path.join(PUBLISHED_ROOT, "run-home");
  const runTmp = path.join(PUBLISHED_ROOT, "run-tmp");
  const java = path.join(material.jdkRoot, "bin/java");
  const runtimeArgs = [
    "-Xms32m", "-Xmx512m", "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8",
    "-Duser.language=en", "-Duser.country=US", "-Duser.timezone=UTC",
    `-Duser.home=${runHome}`, `-Djava.io.tmpdir=${runTmp}`, "-Dkotlin.environment.keepalive=false",
    "-cp", classpath.map((entry) => path.join(PUBLISHED_ROOT, ...entry.path.split("/"))).join(path.delimiter),
    "com.agentbench.analyzer.Main", "analyze",
  ];
  const inputs = sourceInputs();
  return {
    receiptVersion: 1,
    analyzerName: "supported-subset-abstract-interpreter-v1",
    protocolVersion: 1,
    subsetVersion: 1,
    domainVersion: 1,
    artifactRoot: PUBLISHED_ROOT,
    sourceInputs: inputs,
    analyzerSourceSha256: sha256(canonicalJson(inputs)),
    domainSha256: material.domain.material.sha256,
    dependencyManifestSha256: material.dependencies.material.sha256,
    toolchainManifestSha256: material.toolchain.material.sha256,
    bridgeSha256: stableFile(BRIDGE).sha256,
    node: { ...PINNED_NODE, execArgv: [], environment: { ...ORCHESTRATOR_ENV } },
    dependencyRoot: material.dependencyRoot,
    jdk: { root: material.jdkRoot, version: material.row.jdk.version, tree: { ...material.jdkTree }, diagnostics: material.diagnostics },
    build: {
      childEnvironmentNames: ["HOME", "JAVA_HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"],
      childEnvironment: { JAVA_HOME: "$PINNED_JDK", HOME: "$BUILD_HOME", TMPDIR: "$BUILD_TMP", LANG: "C", LC_ALL: "C", TZ: "UTC" },
      javacArgs: ["-J-Duser.home=$BUILD_HOME", "-J-Djava.io.tmpdir=$BUILD_TMP", "--release", "17", "-encoding", "UTF-8", "-g:none", "-proc:none", "-classpath", "$ORDERED_SEVEN_JARS", "-d", "$CLASSES", "$SORTED_ABSOLUTE_JAVA_SOURCES"],
      jarArgs: ["-J-Duser.home=$BUILD_HOME", "-J-Djava.io.tmpdir=$BUILD_TMP", "--create", "--no-manifest", "--file", "$ANALYZER_JAR", "--date=1980-01-01T00:00:02Z", "@$SORTED_RELATIVE_ENTRY_FILE"],
      cleanBuildJarSha256: buildHashes,
      jarEntries: jar.entries,
      classReferences: jar.classReferences,
    },
    analyzerJar: { path: "analyzer-v1.jar", bytes: jar.bytes, sha256: jar.sha256 },
    runtime,
    classpath,
    classpathSha256: sha256(canonicalJson(classpath)),
    launch: {
      java,
      args: runtimeArgs,
      mainClass: "com.agentbench.analyzer.Main",
      cwd: runCwd,
      environment: { JAVA_HOME: material.jdkRoot, HOME: runHome, TMPDIR: runTmp, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      shell: false,
    },
    bounds: {
      maxRequestJsonBytes: 52_428_800, maxResponseJsonBytes: 4_194_304, maxStderrBytes: 4_194_304,
      timeoutMs: 30_000, maxBuffer: 4_194_312, cacheMaxEntries: 32, cacheMaxEncodedBytes: 16_777_216,
    },
  };
}
function publish(material, first, second, refuseExisting) {
  if (first.sha256 !== second.sha256 || first.bytes !== second.bytes) fail("clean analyzer builds are not byte-identical");
  if (refuseExisting && fs.existsSync(PUBLISHED_ROOT)) fail("published artifact already exists");
  const stage = fs.mkdtempSync(path.join(ARTIFACTS_ROOT, ".publish-"));
  copyStable(first.jar, path.join(stage, "analyzer-v1.jar"));
  fs.mkdirSync(path.join(stage, "runtime"), { mode: 0o700 });
  for (const entry of material.runtime) copyStable(entry.source, path.join(stage, "runtime", entry.artifactName));
  for (const directory of ["run-cwd", "run-home", "run-tmp"]) fs.mkdirSync(path.join(stage, directory), { mode: 0o700 });
  const withoutHash = receiptWithoutHash(material, first, [first.sha256, second.sha256]);
  const receipt = { ...withoutHash, receiptSha256: receiptDigest(withoutHash) };
  fs.writeFileSync(path.join(stage, RECEIPT_NAME), `${canonicalJson(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  for (const file of ["analyzer-v1.jar", RECEIPT_NAME]) fs.chmodSync(path.join(stage, file), 0o400);
  for (const file of fs.readdirSync(path.join(stage, "runtime"))) fs.chmodSync(path.join(stage, "runtime", file), 0o400);
  fs.chmodSync(path.join(stage, "runtime"), 0o500);
  fs.chmodSync(stage, 0o500);
  if (fs.existsSync(PUBLISHED_ROOT)) {
    const backup = path.join(ARTIFACTS_ROOT, `.previous-${crypto.randomUUID()}`);
    fs.renameSync(PUBLISHED_ROOT, backup);
    try { fs.renameSync(stage, PUBLISHED_ROOT); }
    catch (error) { fs.renameSync(backup, PUBLISHED_ROOT); throw error; }
    makeTreeWritable(backup);
    fs.rmSync(backup, { recursive: true, force: true });
  } else fs.renameSync(stage, PUBLISHED_ROOT);
  return verifyPublished(material);
}
function verifyPublished(material) {
  if (!fs.existsSync(PUBLISHED_ROOT) || fs.realpathSync(PUBLISHED_ROOT) !== PUBLISHED_ROOT || fs.lstatSync(PUBLISHED_ROOT).isSymbolicLink()) fail("published root is missing or non-canonical");
  const rootStat = fs.lstatSync(PUBLISHED_ROOT);
  if (rootStat.uid !== process.getuid() || mode(rootStat) !== "0500") fail("published root owner or mode mismatch");
  const expectedTop = [RECEIPT_NAME, "analyzer-v1.jar", "run-cwd", "run-home", "run-tmp", "runtime"].sort(compare);
  if (canonicalJson(fs.readdirSync(PUBLISHED_ROOT).sort(compare)) !== canonicalJson(expectedTop)) fail("published root has unexpected entries");
  for (const directory of ["run-cwd", "run-home", "run-tmp"]) {
    const absolute = path.join(PUBLISHED_ROOT, directory);
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || mode(stat) !== "0700" || fs.readdirSync(absolute).length !== 0) fail(`${directory} publication metadata mismatch`);
  }
  const runtimeStat = fs.lstatSync(path.join(PUBLISHED_ROOT, "runtime"));
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== process.getuid() || mode(runtimeStat) !== "0500") fail("runtime directory owner or mode mismatch");
  const runtimeNames = fs.readdirSync(path.join(PUBLISHED_ROOT, "runtime")).sort(compare);
  if (canonicalJson(runtimeNames) !== canonicalJson(material.runtime.map((entry) => entry.artifactName))) fail("runtime classpath file set mismatch");
  for (const entry of material.runtime) {
    const absolute = path.join(PUBLISHED_ROOT, "runtime", entry.artifactName);
    const file = stableFile(absolute);
    const stat = fs.lstatSync(absolute);
    if (stat.uid !== process.getuid() || stat.nlink !== 1 || mode(stat) !== "0400") fail(`${entry.artifactName} publication metadata mismatch`);
    assertFileIdentity(file, entry, entry.artifactName);
  }
  const jarPath = path.join(PUBLISHED_ROOT, "analyzer-v1.jar");
  const jarFile = stableFile(jarPath);
  const jarStat = fs.lstatSync(jarPath);
  if (jarStat.uid !== process.getuid() || jarStat.nlink !== 1 || mode(jarStat) !== "0400") fail("analyzer JAR publication metadata mismatch");
  const inspection = inspectJar(jarFile.bytes);
  const classReferences = assertReviewedJar(material, inspection);
  const receiptPath = path.join(PUBLISHED_ROOT, RECEIPT_NAME);
  const receiptFile = stableFile(receiptPath);
  const receiptStat = fs.lstatSync(receiptPath);
  if (receiptStat.uid !== process.getuid() || receiptStat.nlink !== 1 || mode(receiptStat) !== "0400") fail("receipt publication metadata mismatch");
  let receipt;
  const receiptText = receiptFile.bytes.toString("utf8");
  if (!Buffer.from(receiptText, "utf8").equals(receiptFile.bytes)) fail("receipt is not valid UTF-8");
  try { receipt = JSON.parse(receiptText); } catch { fail("receipt is not JSON"); }
  if (receiptText !== `${canonicalJson(receipt)}\n`) fail("receipt bytes are not canonical JSON plus one LF");
  const { receiptSha256, ...withoutHash } = receipt;
  if (!HASH.test(receiptSha256) || receiptSha256 !== receiptDigest(withoutHash)) fail("receipt self-hash mismatch");
  const jar = { bytes: jarFile.size, sha256: jarFile.sha256, entries: inspection.entries, classReferences };
  const expected = receiptWithoutHash(material, jar, [jar.sha256, jar.sha256]);
  if (canonicalJson(withoutHash) !== canonicalJson(expected)) fail("receipt or current analyzer identity mismatch");
  return Object.freeze({ command: "verify", analyzerJarSha256: jar.sha256, receiptSha256, receiptFileSha256: receiptFile.sha256, jdkTreeSha256: material.jdkTree.sha256, classpathSha256: receipt.classpathSha256 });
}
function removeBuild(directory) {
  if (path.dirname(directory) !== ARTIFACTS_ROOT || !path.basename(directory).startsWith(".build-")) fail("refusing broad temporary cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
}
function makeTreeWritable(root) {
  const stat = fs.lstatSync(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeTreeWritable(path.join(root, name));
  } else if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(root, 0o600);
  else fail("refusing to remove a publication containing a symlink or special file");
}
function main() {
  const arguments_ = parseArguments();
  fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(ARTIFACTS_ROOT);
  if (fs.realpathSync(ARTIFACTS_ROOT) !== ARTIFACTS_ROOT || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid() || mode(parentStat) !== "0700") fail("artifact parent is non-canonical");
  const lock = path.join(ARTIFACTS_ROOT, ".publication-lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { fail(`artifact publication is busy: ${error.code ?? error.message}`); }
  try {
    const material = platformMaterial(arguments_);
    if (arguments_.command === "verify") return verifyPublished(material);
    const firstRoot = fs.mkdtempSync(path.join(ARTIFACTS_ROOT, ".build-a-"));
    const secondRoot = fs.mkdtempSync(path.join(ARTIFACTS_ROOT, ".build-b-"));
    try {
      const first = cleanBuild(firstRoot, material);
      const second = cleanBuild(secondRoot, material);
      return publish(material, first, second, arguments_.command === "build");
    } finally {
      removeBuild(firstRoot);
      removeBuild(secondRoot);
    }
  } finally {
    fs.rmdirSync(lock);
  }
}
try {
  process.stdout.write(`${canonicalJson(main())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
