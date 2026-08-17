import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";
export const ANALYZER_CONSTANTS = deepFreeze({
  ANALYZER_PROTOCOL_VERSION: 1, ANALYZER_SUBSET_VERSION: 1,
  MAX_KOTLIN_FILES: 512, MAX_KOTLIN_FILE_BYTES: 1_048_576, MAX_KOTLIN_TOTAL_BYTES: 8_388_608,
  MAX_REQUEST_JSON_BYTES: 52_428_800, MAX_RESPONSE_JSON_BYTES: 4_194_304, MAX_STDERR_BYTES: 4_194_304,
  MAX_PATH_UTF8_BYTES: 4_096, MAX_JSON_DEPTH: 16, MAX_PSI_NODES: 500_000, MAX_DECLARATIONS: 25_000,
  MAX_CALL_SITES: 100_000, MAX_CFG_BLOCKS_PER_CALLABLE: 4_096, MAX_CALL_DEPTH: 8, MAX_FIXPOINT_ITERATIONS: 32,
  MAX_RESPONSE_NODES: 256, MAX_CLAIMS: 16, MAX_WITNESSES_PER_CLAIM: 32, MAX_TOTAL_WITNESSES: 256,
  CACHE_MAX_ENTRIES: 32, CACHE_MAX_ENCODED_BYTES: 16_777_216, ANALYZER_TIMEOUT_MS: 30_000,
});
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(MODULE_DIRECTORY, "kotlin-analysis.mjs");
const ANALYZER_ROOT = path.resolve(MODULE_DIRECTORY, "../analyzer");
const ARTIFACT_ROOT = path.join(ANALYZER_ROOT, ".artifacts/v1");
const ARTIFACTS_ROOT = path.dirname(ARTIFACT_ROOT);
const RECEIPT_PATH = path.join(ARTIFACT_ROOT, "analyzer-build-receipt-v1.json");
const DOMAIN_PATH = path.join(ANALYZER_ROOT, "domain-v1.json");
const DEPENDENCIES_PATH = path.join(ANALYZER_ROOT, "dependencies-v1.json");
const TOOLCHAIN_PATH = path.join(ANALYZER_ROOT, "toolchain-v1.json");
const BUILD_PATH = path.join(ANALYZER_ROOT, "build-analyzer.mjs");
const JAVA_ROOT = path.join(ANALYZER_ROOT, "src/main/java/com/agentbench/analyzer");
const REPOSITORY_ROOT = path.resolve(ANALYZER_ROOT, "../../..");
const UTF8 = new TextDecoder("utf-8", { fatal: true });
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
const PROOF_FORMS_BY_RULE = deepFreeze({
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
const ACCEPTED_ALTERNATIVES_BY_RULE = deepFreeze({
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
const DOMAIN_KEYS = new Set(["acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule", "ruleOrder", "symbols", "witnessKinds"]);
const SYMBOL_KEYS = new Set(["arguments", "callbacks", "effects", "fqn", "kind", "memberPrecedence", "receiverAbstractType", "returnAbstractType", "signature"]);
const ARGUMENT_KEYS = new Set(["abstractType", "name", "position"]);
const CALLBACK_KEYS = new Set(["argumentPosition", "invocationModel", "role"]);
const SYMBOL_KINDS = new Set(["type", "constructor", "top_level_function", "member_function", "extension_function", "member_property"]);
const MEMBER_PRECEDENCE = new Set(["not_applicable", "sdk_member_wins", "source_extension_if_no_sdk_member"]);
const CALLBACK_ROLES = new Set([
  "application_entry", "window_content", "stage_content", "launched_effect", "button_click", "coroutine_body",
  "disposable_effect", "dispose_cleanup", "spatial_initial", "spatial_attachments", "spatial_update",
  "collection_element", "collection_predicate", "collection_selector", "inline_block", "remembered_factory",
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
]);
const REQUIRED_COMPONENT_SYMBOLS = deepFreeze([
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
  "java/lang/Enum",
  "org/jetbrains/kotlin/cli/jvm/compiler/KotlinCoreEnvironment", "org/jetbrains/kotlin/com/intellij/openapi/util/Disposer",
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
    "org.jetbrains.kotlin.cli.common.CLIConfigurationKeys", "org.jetbrains.kotlin.cli.common.messages.MessageCollector",
    "org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles", "org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment",
    "org.jetbrains.kotlin.com.intellij.openapi.Disposable", "org.jetbrains.kotlin.com.intellij.openapi.util.Disposer",
    "org.jetbrains.kotlin.com.intellij.openapi.util.TextRange", "org.jetbrains.kotlin.com.intellij.psi.PsiElement",
    "org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement", "org.jetbrains.kotlin.com.intellij.psi.tree.IElementType",
    "org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil", "org.jetbrains.kotlin.config.CommonConfigurationKeys",
    "org.jetbrains.kotlin.config.CompilerConfiguration", "org.jetbrains.kotlin.lexer.KtTokens",
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
const RESPONSE_KEYS = new Set(["protocolVersion", "subsetVersion", "command", "analysisStatus", "rejectionCode", "kotlinInputSetSha256", "files", "constants", "nodes", "claims"]);
const NODE_KEYS = new Set(["nodeId", "path", "fileSha256", "startUtf16", "endUtf16", "kind", "textSha256", "structuralToken"]);
const CLAIM_KEYS = new Set(["ruleId", "proofForm", "witnessNodeIds", "witnessDigest"]);
const REJECTION_CODES = new Set(["parse", "unsupported_script", "ambiguous_index", "incomplete_imports", "limit", "internal_uncertainty"]);
const CACHE = new Map();
let cacheBytes = 0;
let cacheAnchor = null;
const spawnAnalyzer = spawnSync;
function fail(message) { throw new Error(`Kotlin analyzer rejected: ${message}`); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}
function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++index >= value.length || value.charCodeAt(index) < 0xdc00 || value.charCodeAt(index) > 0xdfff) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function canonicalJson(value, depth = 0) {
  if (depth > ANALYZER_CONSTANTS.MAX_JSON_DEPTH) fail("canonical JSON depth exceeds bound");
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("canonical JSON number is not a safe integer");
    return String(value);
  }
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) fail("canonical JSON string contains a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail("canonical JSON array is sparse or decorated");
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort(compareCodePoints).map((key) => `${canonicalJson(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  }
  fail("canonical JSON contains unsupported data");
}
class JsonParser {
  constructor(source) { this.source = source; this.index = 0; }
  value(depth = 0) {
    if (depth > ANALYZER_CONSTANTS.MAX_JSON_DEPTH || this.index >= this.source.length) fail("invalid canonical JSON value");
    const character = this.source[this.index];
    if (character === '"') return this.string();
    if (character === "[") return this.array(depth);
    if (character === "{") return this.object(depth);
    for (const [literal, value] of [["null", null], ["true", true], ["false", false]]) {
      if (this.source.startsWith(literal, this.index)) { this.index += literal.length; return value; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(this.source.slice(this.index));
    if (!match || match[0] === "-0") fail("invalid canonical JSON integer");
    this.index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number)) fail("canonical JSON integer exceeds safe range");
    return number;
  }
  string() {
    const start = this.index++;
    let escaped = false;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (!escaped && code === 0x22) {
        this.index += 1;
        try {
          const value = JSON.parse(this.source.slice(start, this.index));
          if (hasLoneSurrogate(value)) fail("canonical JSON string contains a lone surrogate");
          return value;
        } catch { fail("invalid canonical JSON string"); }
      }
      if (!escaped && code < 0x20) fail("unescaped canonical JSON control character");
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      this.index += 1;
    }
    fail("unterminated canonical JSON string");
  }
  array(depth) {
    this.index += 1; const values = [];
    if (this.take("]")) return values;
    while (true) { values.push(this.value(depth + 1)); if (this.take("]")) return values; this.require(","); }
  }
  object(depth) {
    this.index += 1; const values = {}; let previous = null;
    if (this.take("}")) return values;
    while (true) {
      if (this.source[this.index] !== '"') fail("canonical JSON object key is not a string");
      const key = this.string();
      if (previous !== null && compareCodePoints(previous, key) >= 0) fail("duplicate or out-of-order canonical JSON key");
      previous = key; this.require(":"); values[key] = this.value(depth + 1);
      if (this.take("}")) return values; this.require(",");
    }
  }
  take(character) { if (this.source[this.index] === character) { this.index += 1; return true; } return false; }
  require(character) { if (!this.take(character)) fail(`canonical JSON expected ${character}`); }
}
function parseCanonicalJson(bytes, label = "response") {
  let source; try { source = UTF8.decode(bytes); } catch { fail(`${label} is not valid UTF-8`); }
  const parser = new JsonParser(source); const value = parser.value();
  if (parser.index !== source.length || canonicalJson(value) !== source) fail(`${label} JSON is not canonical`);
  return value;
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
function trustedAncestors(target) {
  let current = path.resolve(target); const allowedOwners = new Set([0, process.getuid()]);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !allowedOwners.has(stat.uid) || (stat.mode & 0o002) !== 0) fail(`${target} has an untrusted path component ${current}`);
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function trustedFile(file, label = file) {
  trustedAncestors(file); const material = stableFile(file, label);
  if (fs.lstatSync(file).nlink !== 1) fail(`${label} has a hard-link alias`);
  return material;
}
function stableJson(file) { const material = trustedFile(file); let value; try { value = JSON.parse(UTF8.decode(material.bytes)); } catch { fail(`${path.basename(file)} is not strict UTF-8 JSON`); } return Object.freeze({ value, material }); }
function mode(stat) { return (stat.mode & 0o777).toString(8).padStart(4, "0"); }
function jdkTreeIdentity(root) {
  trustedAncestors(root);
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) fail("JDK root is not canonical");
  const entries = []; const counts = { entries: 0, files: 0, directories: 0, symlinks: 0, fileBytes: 0 };
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const absolute = path.join(directory, name); const itemPath = relative ? `${relative}/${name}` : name; const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute); const logical = path.resolve(path.dirname(absolute), target); const resolved = fs.realpathSync(absolute);
        if (!(logical === root || logical.startsWith(`${root}${path.sep}`)) || !(resolved === root || resolved.startsWith(`${root}${path.sep}`))) fail(`JDK symlink escapes its root: ${itemPath}`);
        entries.push({ path: itemPath, type: "symlink", mode: mode(stat), target }); counts.symlinks += 1;
      }
      else if (stat.isDirectory()) { entries.push({ path: itemPath, type: "dir", mode: mode(stat) }); counts.directories += 1; visit(absolute, itemPath); }
      else if (stat.isFile()) {
        const file = stableFile(absolute, `JDK ${itemPath}`);
        entries.push({ path: itemPath, type: "file", mode: mode(stat), bytes: file.size, sha256: file.sha256 });
        counts.files += 1; counts.fileBytes += file.size;
      } else fail(`JDK contains special file ${itemPath}`);
    }
  }
  visit(root); counts.entries = entries.length;
  return Object.freeze({ ...counts, sha256: sha256(canonicalJson(entries)) });
}
function exact(value, expected, label) { if (canonicalJson(value) !== canonicalJson(expected)) fail(`${label} mismatch`); }
function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}
function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a nonempty string array`);
  const seen = new Set();
  for (const entry of value) {
    nonemptyString(entry, label);
    if (seen.has(entry)) fail(`${label} must be unique`);
    seen.add(entry);
  }
  return value;
}
function nullableEnum(value, values, label) {
  if (value !== null && !values.has(value)) fail(`${label} is outside the closed vocabulary`);
}
function validateDomain(material) {
  const domain = parseCanonicalJson(material.bytes, "analyzer domain");
  exactKeys(domain, DOMAIN_KEYS, "analyzer domain");
  if (domain.analyzerName !== "supported-subset-abstract-interpreter-v1" || domain.domainVersion !== 1) fail("analyzer domain identity mismatch");
  exact(domain.ruleOrder, RULE_ORDER, "analyzer domain ruleOrder");
  exact(domain.witnessKinds, WITNESS_KINDS, "analyzer domain witnessKinds");
  exact(domain.proofFormsByRule, PROOF_FORMS_BY_RULE, "analyzer domain proof-form vocabulary");
  exact(domain.acceptedAlternativesByRule, ACCEPTED_ALTERNATIVES_BY_RULE, "analyzer domain alternative vocabulary");
  if (!Array.isArray(domain.symbols)) fail("analyzer domain symbols must be an array");
  const identities = [];
  const byIdentity = new Map();
  for (let index = 0; index < domain.symbols.length; index += 1) {
    const symbol = domain.symbols[index];
    exactKeys(symbol, SYMBOL_KEYS, `analyzer domain symbol ${index}`);
    nonemptyString(symbol.fqn, `analyzer domain symbol ${index} fqn`);
    nonemptyString(symbol.signature, `analyzer domain symbol ${index} signature`);
    if (!SYMBOL_KINDS.has(symbol.kind)) fail(`analyzer domain symbol ${index} kind is outside the closed vocabulary`);
    if (!MEMBER_PRECEDENCE.has(symbol.memberPrecedence)) fail(`analyzer domain symbol ${index} memberPrecedence is outside the closed vocabulary`);
    nullableEnum(symbol.receiverAbstractType, ABSTRACT_TYPES, `analyzer domain symbol ${index} receiverAbstractType`);
    nullableEnum(symbol.returnAbstractType, ABSTRACT_TYPES, `analyzer domain symbol ${index} returnAbstractType`);
    if (!Array.isArray(symbol.arguments)) fail(`analyzer domain symbol ${index} arguments must be an array`);
    for (let position = 0; position < symbol.arguments.length; position += 1) {
      const argument = symbol.arguments[position];
      exactKeys(argument, ARGUMENT_KEYS, `analyzer domain symbol ${index} argument ${position}`);
      if (argument.position !== position) fail(`analyzer domain symbol ${index} argument positions must be dense and zero based`);
      if (argument.name !== null) nonemptyString(argument.name, `analyzer domain symbol ${index} argument ${position} name`);
      if (!ABSTRACT_TYPES.has(argument.abstractType)) fail(`analyzer domain symbol ${index} argument ${position} abstractType is outside the closed vocabulary`);
    }
    if (!Array.isArray(symbol.callbacks)) fail(`analyzer domain symbol ${index} callbacks must be an array`);
    const callbackPositions = new Set();
    for (let callbackIndex = 0; callbackIndex < symbol.callbacks.length; callbackIndex += 1) {
      const callback = symbol.callbacks[callbackIndex];
      exactKeys(callback, CALLBACK_KEYS, `analyzer domain symbol ${index} callback ${callbackIndex}`);
      if (!Number.isSafeInteger(callback.argumentPosition) || callback.argumentPosition < 0 || callback.argumentPosition >= symbol.arguments.length) {
        fail(`analyzer domain symbol ${index} callback argumentPosition is invalid`);
      }
      if (callbackPositions.has(callback.argumentPosition)) fail(`analyzer domain symbol ${index} callback argumentPosition is duplicated`);
      callbackPositions.add(callback.argumentPosition);
      if (!CALLBACK_ROLES.has(callback.role)) fail(`analyzer domain symbol ${index} callback role is outside the closed vocabulary`);
      if (!INVOCATION_MODELS.has(callback.invocationModel)) fail(`analyzer domain symbol ${index} callback invocationModel is outside the closed vocabulary`);
    }
    if (!Array.isArray(symbol.effects)) fail(`analyzer domain symbol ${index} effects must be an array`);
    const effects = new Set();
    for (const effect of symbol.effects) {
      if (!EFFECTS.has(effect)) fail(`analyzer domain symbol ${index} effect is outside the closed vocabulary`);
      if (effects.has(effect)) fail(`analyzer domain symbol ${index} effects must be unique`);
      effects.add(effect);
    }
    const identity = canonicalJson({ fqn: symbol.fqn, signature: symbol.signature });
    if (identities.length > 0 && Buffer.compare(Buffer.from(identities.at(-1)), Buffer.from(identity)) >= 0) fail("analyzer domain symbols must be UTF-8 sorted and unique");
    identities.push(identity); byIdentity.set(identity, symbol);
  }
  for (const required of REQUIRED_COMPONENT_SYMBOLS) {
    const identity = canonicalJson({ fqn: required.fqn, signature: required.signature });
    if (!byIdentity.has(identity) || canonicalJson(byIdentity.get(identity)) !== canonicalJson(required)) fail(`analyzer domain clone-canary symbol mismatch for ${required.fqn} ${required.signature}`);
  }
  return deepFreeze(domain);
}
function validateJavaSourceCapabilities(javaSources) {
  const sourceNames = javaSources.map((source) => path.basename(source)).sort(compare);
  exact(sourceNames, [...ALLOWED_IMPORTS_BY_SOURCE.keys()].sort(compare), "source import policy five-source inventory");
  const forbiddenText = [
    "ProcessBuilder", "ProcessHandle", "Runtime.getRuntime", "Runtime.exec", "ClassLoader", "Class.forName",
    "getClassLoader", "loadClass", "java.net.", "javax.net.", "java.nio.file.", "java.io.File", "java.lang.reflect",
    "java.lang.invoke", "javax.script", "javax.tools", "kotlin.script", "K2JVMCompiler", "KotlinCompileDaemon",
  ];
  for (const source of javaSources) {
    const text = trustedFile(source, `analyzer source ${path.basename(source)}`).bytes.toString("utf8");
    const sourceName = path.basename(source); const allowedImports = ALLOWED_IMPORTS_BY_SOURCE.get(sourceName); const imports = [];
    for (const match of text.matchAll(/^import\s+(static\s+)?([^;]+);$/gm)) {
      if (match[1] || !allowedImports.has(match[2])) fail(`analyzer source contains unreviewed import ${match[0]}`);
      imports.push(match[2]);
    }
    if (imports.length !== new Set(imports).size) fail(`${sourceName} contains a duplicate import`);
    if ((sourceName === "AbstractInterpreter.java" || sourceName === "Rules.java")
        && (text.includes("org.jetbrains.kotlin") || text.includes("com.intellij"))) fail(`${sourceName} contains a PSI or Kotlin compiler reference`);
    for (const token of forbiddenText) if (text.includes(token)) fail(`analyzer source contains forbidden capability ${token}`);
  }
}
function validateDirectory(directory, empty = false, expectedMode = null) {
  trustedAncestors(directory); const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) fail(`${directory} is not a canonical runner-owned directory`);
  if (expectedMode !== null && (stat.mode & 0o777) !== expectedMode) fail(`${directory} mode mismatch`);
  if (empty && fs.readdirSync(directory).length !== 0) fail(`${directory} must be empty`);
}
function runnerFile(file, label, expectedMode = 0o400) {
  const material = trustedFile(file, label); const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== expectedMode) fail(`${label} publication mode or owner mismatch`);
  return material;
}
function inspectJar(bytes) {
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) if (bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  if (eocd < 0 || eocd + 22 !== bytes.length || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
      || bytes.readUInt16LE(eocd + 20) !== 0) fail("thin JAR end record is invalid");
  const count = bytes.readUInt16LE(eocd + 10);
  if (bytes.readUInt16LE(eocd + 8) !== count) fail("thin JAR split entry count is invalid");
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  let expectedLocalOffset = 0;
  const entries = [];
  const contents = new Map();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) fail("thin JAR central directory is invalid");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = UTF8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameBytes));
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
function validateReviewedJar(material, domain) {
  const inspection = inspectJar(material.bytes);
  exact(inspection.entries, EXPECTED_JAR_ENTRIES, "reviewed thin JAR entries");
  const embedded = inspection.contents.get("domain-v1.json");
  if (!embedded || !embedded.equals(domain.material.bytes)) fail("embedded analyzer domain mismatch");
  const forbidden = ["java/lang/ProcessBuilder", "java/lang/ProcessHandle", "java/lang/ClassLoader", "java/io/File", "java/nio/file/", "java/net/", "javax/net/", "javax/script/", "javax/tools/", "java/lang/reflect/", "kotlin/script", "K2JVMCompiler", "KotlinCompileDaemon", "loadClass", "forName"];
  const references = new Set();
  for (const [name, content] of inspection.contents) if (name.endsWith(".class")) {
    for (const token of forbidden) if (content.includes(Buffer.from(token))) fail(`analyzer bytecode ${name} contains forbidden capability ${token}`);
    const classNames = classReferences(content);
    if (classNames.includes("java/lang/Runtime")) fail(`analyzer bytecode ${name} contains forbidden capability java/lang/Runtime`);
    if ((name === "com/agentbench/analyzer/AbstractInterpreter.class" || name === "com/agentbench/analyzer/Rules.class" || name.startsWith("com/agentbench/analyzer/Rules$"))
        && ["org/jetbrains/kotlin/", "com/intellij/"].some((token) => content.includes(Buffer.from(token)))) {
      fail(`semantic analyzer bytecode ${name} references PSI`);
    }
    for (const reference of classNames) references.add(reference);
  }
  const actual = [...references].sort(compare);
  const missing = [...REQUIRED_CLASS_REFERENCES].filter((reference) => !references.has(reference));
  const surplus = actual.filter((reference) => !ALLOWED_CLASS_REFERENCES.has(reference));
  if (missing.length > 0 || surplus.length > 0) fail(`analyzer bytecode class-reference capability bounds mismatch: missing=${canonicalJson(missing.sort(compare))} surplus=${canonicalJson(surplus)}`);
  return { ...inspection, classReferences: actual };
}
function classReferences(bytes) {
  if (bytes.length < 10 || bytes.readUInt32BE(0) !== 0xcafebabe) fail("invalid analyzer class file");
  const pool = new Array(bytes.readUInt16BE(8));
  let cursor = 10;
  for (let index = 1; index < pool.length; index += 1) {
    const tag = bytes.readUInt8(cursor++);
    if (tag === 1) { const length = bytes.readUInt16BE(cursor); cursor += 2; pool[index] = { tag, value: UTF8.decode(bytes.subarray(cursor, cursor + length)) }; cursor += length; }
    else if (tag === 7) { pool[index] = { tag, name: bytes.readUInt16BE(cursor) }; cursor += 2; }
    else if (new Set([3, 4, 9, 10, 11, 12, 17, 18]).has(tag)) cursor += 4;
    else if (new Set([5, 6]).has(tag)) { cursor += 8; index += 1; }
    else if (new Set([8, 16, 19, 20]).has(tag)) cursor += 2;
    else if (tag === 15) cursor += 3;
    else fail(`unsupported analyzer class constant-pool tag ${tag}`);
  }
  return pool.filter((entry) => entry?.tag === 7).map((entry) => pool[entry.name]?.value ?? fail("invalid analyzer class reference"));
}
function repositoryRelative(file) { return path.relative(REPOSITORY_ROOT, file).split(path.sep).join("/"); }
function verifyAnalyzerArtifactUnlocked() {
  validateDirectory(ARTIFACT_ROOT, false, 0o500);
  const expectedTop = ["analyzer-build-receipt-v1.json", "analyzer-v1.jar", "run-cwd", "run-home", "run-tmp", "runtime"].sort(compare);
  exact(fs.readdirSync(ARTIFACT_ROOT).sort(compare), expectedTop, "artifact root entries");
  for (const name of ["run-cwd", "run-home", "run-tmp"]) validateDirectory(path.join(ARTIFACT_ROOT, name), true, 0o700);
  validateDirectory(path.join(ARTIFACT_ROOT, "runtime"), false, 0o500);
  const receiptFile = runnerFile(RECEIPT_PATH, "analyzer receipt");
  let receipt;
  try { receipt = JSON.parse(UTF8.decode(receiptFile.bytes)); } catch { fail("analyzer receipt is not strict UTF-8 JSON"); }
  if (`${canonicalJson(receipt)}\n` !== receiptFile.bytes.toString("utf8")) fail("analyzer receipt file is not canonical");
  const receiptSha256 = receipt.receiptSha256;
  const withoutHash = { ...receipt };
  delete withoutHash.receiptSha256;
  if (!HASH.test(receiptSha256) || receiptDigest(withoutHash) !== receiptSha256) fail("analyzer receipt self-hash mismatch");
  const domainMaterial = trustedFile(DOMAIN_PATH);
  const domain = Object.freeze({ value: validateDomain(domainMaterial), material: domainMaterial });
  const dependencies = stableJson(DEPENDENCIES_PATH);
  const toolchain = stableJson(TOOLCHAIN_PATH);
  if (receipt.artifactRoot !== ARTIFACT_ROOT || receipt.analyzerName !== "supported-subset-abstract-interpreter-v1"
      || receipt.protocolVersion !== 1 || receipt.subsetVersion !== 1 || receipt.domainVersion !== 1) fail("receipt version or locator mismatch");
  const javaSources = [...ALLOWED_IMPORTS_BY_SOURCE.keys()].map((name) => path.join(JAVA_ROOT, name)).sort(compare);
  validateJavaSourceCapabilities(javaSources);
  const inputPaths = [...javaSources, DOMAIN_PATH, DEPENDENCIES_PATH, TOOLCHAIN_PATH, BUILD_PATH, BRIDGE_PATH].sort(compare);
  const sourceInputs = inputPaths.map((file) => { const row = trustedFile(file); return { path: repositoryRelative(file), bytes: row.size, sha256: row.sha256 }; });
  exact(receipt.sourceInputs, sourceInputs, "receipt source inputs");
  if (receipt.analyzerSourceSha256 !== sha256(canonicalJson(sourceInputs)) || receipt.domainSha256 !== domain.material.sha256
      || receipt.dependencyManifestSha256 !== dependencies.material.sha256 || receipt.toolchainManifestSha256 !== toolchain.material.sha256
      || receipt.bridgeSha256 !== trustedFile(BRIDGE_PATH).sha256) fail("receipt tracked-input digest mismatch");
  const platform = toolchain.value.platforms.find((row) => row.platform === process.platform && row.arch === process.arch && row.uid === process.getuid());
  if (!platform) fail("no allowed runtime toolchain row");
  exact(receipt.node, { ...platform.node, execArgv: [], environment: platform.orchestratorEnvironment }, "receipt Node identity");
  const node = trustedFile(platform.node.path, "pinned Node");
  if (node.size !== platform.node.bytes || node.sha256 !== platform.node.sha256) fail("pinned Node bytes mismatch");
  if (receipt.jdk.root !== platform.jdk.home || receipt.jdk.version !== platform.jdk.version) fail("receipt JDK locator mismatch");
  const jdkTree = jdkTreeIdentity(receipt.jdk.root);
  exact(jdkTree, platform.jdk.tree, "complete JDK tree");
  exact(receipt.jdk.tree, jdkTree, "receipt JDK tree");
  exact(receipt.jdk.diagnostics, platform.jdk.diagnostics, "receipt JDK diagnostics");
  for (const expected of platform.jdk.diagnostics) {
    const file = trustedFile(path.join(receipt.jdk.root, ...expected.path.split("/")), `JDK ${expected.path}`);
    if (file.size !== expected.bytes || file.sha256 !== expected.sha256) fail(`JDK ${expected.path} mismatch`);
  }
  if (!path.isAbsolute(receipt.dependencyRoot) || path.resolve(receipt.dependencyRoot) !== receipt.dependencyRoot) fail("receipt dependency root is not absolute and normalized");
  validateDirectory(receipt.dependencyRoot);
  for (const entry of dependencies.value.dependencies) {
    const source = trustedFile(path.join(receipt.dependencyRoot, ...entry.relativeCachePath.split("/")), `dependency source ${entry.coordinate}`);
    if (source.size !== entry.bytes || source.sha256 !== entry.sha256) fail(`dependency source ${entry.coordinate} mismatch`);
  }
  const analyzerJar = runnerFile(path.join(ARTIFACT_ROOT, "analyzer-v1.jar"), "analyzer JAR");
  const inspection = validateReviewedJar(analyzerJar, domain);
  exact(receipt.analyzerJar, { path: "analyzer-v1.jar", bytes: analyzerJar.size, sha256: analyzerJar.sha256 }, "analyzer JAR identity");
  const runtime = dependencies.value.dependencies.map((entry, index) => {
    if (entry.order !== index + 1) fail("dependency order mismatch");
    const artifact = runnerFile(path.join(ARTIFACT_ROOT, "runtime", entry.artifactName), entry.artifactName);
    if (artifact.size !== entry.bytes || artifact.sha256 !== entry.sha256) fail(`${entry.artifactName} mismatch`);
    return { order: entry.order, coordinate: entry.coordinate, path: `runtime/${entry.artifactName}`, bytes: entry.bytes, sha256: entry.sha256 };
  });
  exact(fs.readdirSync(path.join(ARTIFACT_ROOT, "runtime")).sort(compare), runtime.map((row) => path.basename(row.path)), "runtime file set");
  exact(receipt.runtime, runtime, "receipt runtime classpath");
  const classpath = [{ path: "analyzer-v1.jar", bytes: analyzerJar.size, sha256: analyzerJar.sha256 }, ...runtime];
  exact(receipt.classpath, classpath, "receipt classpath");
  if (receipt.classpathSha256 !== sha256(canonicalJson(classpath))) fail("receipt classpath digest mismatch");
  if (receipt.build.cleanBuildJarSha256.length !== 2 || receipt.build.cleanBuildJarSha256.some((value) => value !== analyzerJar.sha256)) fail("two-build JAR identity mismatch");
  exact(receipt.build, {
    childEnvironmentNames: ["HOME", "JAVA_HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"],
    childEnvironment: { JAVA_HOME: "$PINNED_JDK", HOME: "$BUILD_HOME", TMPDIR: "$BUILD_TMP", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    javacArgs: ["-J-Duser.home=$BUILD_HOME", "-J-Djava.io.tmpdir=$BUILD_TMP", "--release", "17", "-encoding", "UTF-8", "-g:none", "-proc:none", "-classpath", "$ORDERED_SEVEN_JARS", "-d", "$CLASSES", "$SORTED_ABSOLUTE_JAVA_SOURCES"],
    jarArgs: ["-J-Duser.home=$BUILD_HOME", "-J-Djava.io.tmpdir=$BUILD_TMP", "--create", "--no-manifest", "--file", "$ANALYZER_JAR", "--date=1980-01-01T00:00:02Z", "@$SORTED_RELATIVE_ENTRY_FILE"],
    cleanBuildJarSha256: [analyzerJar.sha256, analyzerJar.sha256],
    classReferences: inspection.classReferences,
    jarEntries: inspection.entries,
  }, "receipt build vectors");
  const runCwd = path.join(ARTIFACT_ROOT, "run-cwd");
  const runHome = path.join(ARTIFACT_ROOT, "run-home");
  const runTmp = path.join(ARTIFACT_ROOT, "run-tmp");
  const cp = classpath.map((entry) => path.join(ARTIFACT_ROOT, ...entry.path.split("/"))).join(path.delimiter);
  const java = path.join(receipt.jdk.root, "bin/java");
  const args = ["-Xms32m", "-Xmx512m", "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8", "-Duser.language=en", "-Duser.country=US", "-Duser.timezone=UTC", `-Duser.home=${runHome}`, `-Djava.io.tmpdir=${runTmp}`, "-Dkotlin.environment.keepalive=false", "-cp", cp, "com.agentbench.analyzer.Main", "analyze"];
  const environment = { JAVA_HOME: receipt.jdk.root, HOME: runHome, TMPDIR: runTmp, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const launch = { java, args, mainClass: "com.agentbench.analyzer.Main", cwd: runCwd, environment, shell: false };
  const bounds = { maxRequestJsonBytes: 52_428_800, maxResponseJsonBytes: 4_194_304, maxStderrBytes: 4_194_304, timeoutMs: 30_000, maxBuffer: 4_194_312, cacheMaxEntries: 32, cacheMaxEncodedBytes: 16_777_216 };
  exact(receipt.launch, launch, "runtime launch");
  exact(receipt.bounds, bounds, "protocol bounds");
  const expectedWithoutHash = {
    receiptVersion: 1, analyzerName: "supported-subset-abstract-interpreter-v1", protocolVersion: 1, subsetVersion: 1, domainVersion: 1,
    artifactRoot: ARTIFACT_ROOT, sourceInputs, analyzerSourceSha256: sha256(canonicalJson(sourceInputs)), domainSha256: domain.material.sha256,
    dependencyManifestSha256: dependencies.material.sha256, toolchainManifestSha256: toolchain.material.sha256, bridgeSha256: trustedFile(BRIDGE_PATH).sha256,
    node: { ...platform.node, execArgv: [], environment: platform.orchestratorEnvironment }, dependencyRoot: receipt.dependencyRoot,
    jdk: { root: platform.jdk.home, version: platform.jdk.version, tree: jdkTree, diagnostics: platform.jdk.diagnostics },
    build: receipt.build, analyzerJar: { path: "analyzer-v1.jar", bytes: analyzerJar.size, sha256: analyzerJar.sha256 }, runtime, classpath,
    classpathSha256: sha256(canonicalJson(classpath)), launch, bounds,
  };
  exact(withoutHash, expectedWithoutHash, "complete receipt");
  return deepFreeze({ receiptSha256, receiptFileSha256: receiptFile.sha256, analyzerJarBytes: analyzerJar.size, analyzerJarSha256: analyzerJar.sha256, runtime, classpath, classpathSha256: receipt.classpathSha256, jdkTreeSha256: jdkTree.sha256, nodeSha256: platform.node.sha256, domainSha256: domain.material.sha256, domain: domain.value, bridgeSha256: receipt.bridgeSha256, launch: receipt.launch });
}
function validatePath(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > ANALYZER_CONSTANTS.MAX_PATH_UTF8_BYTES
      || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) fail("invalid source path");
  if (value.split("/").some((part) => part === "" || part === "." || part === "..") || path.posix.normalize(value) !== value) fail("invalid source path segments");
  return value;
}
function inputRows(index) {
  if (!index || !Array.isArray(index.files)) fail("source index is invalid");
  return index.files.map((file) => {
    if (!file || typeof file.original !== "string" || !new Set(["kotlin", "gradle", "manifest"]).has(file.kind)) fail("source index file is invalid");
    if (hasLoneSurrogate(file.original)) fail("source file contains a lone surrogate");
    const bytes = Buffer.from(file.original, "utf8");
    return { path: validatePath(file.path), kind: file.kind, bytes: bytes.length, sha256: sha256(bytes), content: bytes };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}
export function computeKotlinInputSetSha256(index) { const manifest = inputRows(index).filter((row) => row.kind === "kotlin").map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest })); return sha256(canonicalJson(manifest)); }
export function computeSelectedInputSetSha256(index) { const manifest = inputRows(index).map(({ path, kind, bytes, sha256: digest }) => ({ path, kind, bytes, sha256: digest })); return sha256(canonicalJson(manifest)); }
function localLimitResponse(command, digest, files) { return deepFreeze({ protocolVersion: 1, subsetVersion: 1, command, analysisStatus: "rejected", rejectionCode: "limit", kotlinInputSetSha256: digest, files, constants: null, nodes: [], claims: [] }); }
function frame(bytes) {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([header, bytes]);
}
function exactKeys(value, keys, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) fail(`${label} has an unknown or missing key`);
}
function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function splitSurrogateBoundary(source, offset) {
  if (offset <= 0 || offset >= source.length) return false;
  const left = source.charCodeAt(offset - 1); const right = source.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}
function requestSource(request, node) {
  const matches = request.files.filter((file) => file.path === node.path);
  if (matches.length !== 1) fail("node path does not resolve to exactly one request file");
  const file = matches[0];
  if (node.fileSha256 !== file.sha256) fail("node file sha256 does not match the request file hash");
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.toString("base64") !== file.contentBase64 || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) fail("request file bytes do not match their receipt");
  let source; try { source = UTF8.decode(bytes); } catch { fail("request file is not valid UTF-8"); }
  return source;
}
function validateNode(node, request, previousNodeId, index) {
  exactKeys(node, NODE_KEYS, `node ${index}`);
  if (!HASH.test(node.nodeId)) fail(`node ${index} nodeId is not a lowercase SHA-256 digest`);
  validatePath(node.path);
  if (!HASH.test(node.fileSha256)) fail(`node ${index} file sha256 is invalid`);
  if (!HASH.test(node.textSha256)) fail(`node ${index} text hash is invalid`);
  if (!WITNESS_KINDS.includes(node.kind)) fail(`node ${index} witness kind is outside the closed vocabulary`);
  if (typeof node.structuralToken !== "boolean") fail(`node ${index} structuralToken must be a boolean`);
  if (previousNodeId !== null && compareUtf8(previousNodeId, node.nodeId) >= 0) fail("node catalog must be UTF-8 sorted and unique");
  const source = requestSource(request, node);
  if (!Number.isSafeInteger(node.startUtf16) || !Number.isSafeInteger(node.endUtf16)
      || node.startUtf16 < 0 || node.endUtf16 <= node.startUtf16 || node.endUtf16 > source.length) fail(`node ${index} UTF-16 span is out of bounds or reversed`);
  if (splitSurrogateBoundary(source, node.startUtf16) || splitSurrogateBoundary(source, node.endUtf16)) fail(`node ${index} UTF-16 span splits a surrogate boundary`);
  const textSha256 = sha256(Buffer.from(source.slice(node.startUtf16, node.endUtf16), "utf8"));
  if (textSha256 !== node.textSha256) fail(`node ${index} text hash does not match the exact substring`);
  const identity = { path: node.path, fileSha256: node.fileSha256, startUtf16: node.startUtf16, endUtf16: node.endUtf16,
    kind: node.kind, textSha256: node.textSha256, structuralToken: node.structuralToken };
  if (sha256(Buffer.from(canonicalJson(identity), "utf8")) !== node.nodeId) fail(`node ${index} node ID digest mismatch`);
  if (!node.structuralToken && node.kind !== "argument") fail(`node ${index} nonstructural literal witness kind must be argument`);
}
function validateAcceptedSemantics(response, request, domain) {
  if (response.nodes.length > ANALYZER_CONSTANTS.MAX_RESPONSE_NODES) fail("response node catalog exceeds the node limit");
  if (response.claims.length > ANALYZER_CONSTANTS.MAX_CLAIMS) fail("response claim list exceeds the claim limit");
  let previousNodeId = null;
  const nodes = new Map();
  for (let index = 0; index < response.nodes.length; index += 1) {
    const node = response.nodes[index];
    validateNode(node, request, previousNodeId, index);
    previousNodeId = node.nodeId; nodes.set(node.nodeId, node);
  }
  let previousRuleIndex = -1; let totalWitnesses = 0;
  const union = new Set();
  for (let index = 0; index < response.claims.length; index += 1) {
    const claim = response.claims[index];
    exactKeys(claim, CLAIM_KEYS, `claim ${index}`);
    const ruleIndex = domain.ruleOrder.indexOf(claim.ruleId);
    if (ruleIndex < 0) fail(`claim ${index} rule is outside the closed domain`);
    if (ruleIndex <= previousRuleIndex) fail("claims must contain at most one claim per rule in domain rule order");
    previousRuleIndex = ruleIndex;
    if (typeof claim.proofForm !== "string" || !domain.proofFormsByRule[claim.ruleId].includes(claim.proofForm)) fail(`claim ${index} proof form is outside the rule domain`);
    if (!Array.isArray(claim.witnessNodeIds) || claim.witnessNodeIds.length < 1
        || claim.witnessNodeIds.length > ANALYZER_CONSTANTS.MAX_WITNESSES_PER_CLAIM) fail(`claim ${index} witness list is empty or exceeds the witness limit`);
    let previousWitness = null; let hasStructural = false;
    for (const witnessNodeId of claim.witnessNodeIds) {
      if (!HASH.test(witnessNodeId)) fail(`claim ${index} witness node ID is invalid`);
      if (previousWitness !== null && compareUtf8(previousWitness, witnessNodeId) >= 0) fail(`claim ${index} witness IDs must be UTF-8 sorted and unique`);
      previousWitness = witnessNodeId;
      const node = nodes.get(witnessNodeId);
      if (!node) fail(`claim ${index} witness does not resolve into the node catalog`);
      if (node.structuralToken) hasStructural = true;
      else if (node.kind !== "argument") fail(`claim ${index} nonstructural literal witness must have argument kind`);
      union.add(witnessNodeId);
    }
    if (!hasStructural) fail(`claim ${index} requires at least one structural witness; literal-only claims are invalid`);
    totalWitnesses += claim.witnessNodeIds.length;
    if (totalWitnesses > ANALYZER_CONSTANTS.MAX_TOTAL_WITNESSES) fail("total witness reference sum exceeds the witness limit");
    if (!HASH.test(claim.witnessDigest)) fail(`claim ${index} witness digest is invalid`);
    const digestMaterial = { ruleId: claim.ruleId, proofForm: claim.proofForm, witnessNodeIds: claim.witnessNodeIds };
    if (sha256(Buffer.from(canonicalJson(digestMaterial), "utf8")) !== claim.witnessDigest) fail(`claim ${index} witness digest mismatch`);
  }
  const expectedCatalog = [...union].sort(compareUtf8);
  const actualCatalog = response.nodes.map((node) => node.nodeId);
  if (canonicalJson(actualCatalog) !== canonicalJson(expectedCatalog)) fail("node catalog must equal the exact sorted claim-witness union; orphan or missing catalog node");
}
function validateResponse(bytes, request, domain) {
  const response = parseCanonicalJson(bytes, "response");
  exactKeys(response, RESPONSE_KEYS, "response");
  if (response.protocolVersion !== 1 || response.subsetVersion !== 1 || response.command !== request.command) fail("response protocolVersion/subsetVersion/command mismatch");
  if (response.kotlinInputSetSha256 !== request.kotlinInputSetSha256) fail("response kotlinInputSetSha256 digest mismatch");
  const receipts = request.files.map(({ path, bytes: count, sha256: digest }) => ({ path, bytes: count, sha256: digest }));
  exact(response.files, receipts, "response file receipts");
  if (!Array.isArray(response.nodes) || !Array.isArray(response.claims)) fail("response nodes and claims must be arrays");
  if (request.command === "describe") {
    if (response.analysisStatus !== "accepted" || response.rejectionCode !== null) fail("describe response status is impossible");
    exact(response.constants, ANALYZER_CONSTANTS, "describe constants");
    if (response.nodes.length !== 0 || response.claims.length !== 0) fail("describe response must not contain semantic nodes or claims");
  } else {
    if (response.constants !== null) fail("analyze constants must be null");
    if (!new Set(["accepted", "rejected"]).has(response.analysisStatus)) fail("response analysisStatus is invalid");
    if (response.analysisStatus === "accepted") {
      if (response.rejectionCode !== null) fail("accepted response has a rejection code");
      validateAcceptedSemantics(response, request, domain);
    } else {
      if (!REJECTION_CODES.has(response.rejectionCode)) fail("rejected response has an invalid code");
      if (response.nodes.length !== 0 || response.claims.length !== 0) fail("rejected response must not contain semantic nodes or claims");
    }
  }
  return deepFreeze(response);
}
function invoke(request, verified) {
  const requestBytes = Buffer.from(canonicalJson(request), "utf8");
  if (requestBytes.length > ANALYZER_CONSTANTS.MAX_REQUEST_JSON_BYTES) fail("request JSON exceeds bound");
  let result;
  try {
    for (const name of ["run-cwd", "run-home", "run-tmp"]) validateDirectory(path.join(ARTIFACT_ROOT, name), true, 0o700);
    result = spawnAnalyzer(verified.launch.java, verified.launch.args, {
      cwd: verified.launch.cwd, env: verified.launch.environment, shell: false, input: frame(requestBytes), encoding: null,
      timeout: ANALYZER_CONSTANTS.ANALYZER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: ANALYZER_CONSTANTS.MAX_RESPONSE_JSON_BYTES + 8,
    });
  } finally {
    clearRuntimeDirectories();
  }
  if (result.error) fail(`spawnSync failed: ${result.error.code ?? result.error.message}`);
  if (result.signal) fail(`analyzer terminated by signal ${result.signal}`);
  if (result.status !== 0) fail(`analyzer exit status ${result.status}`);
  if (!Buffer.isBuffer(result.stderr) || !Buffer.isBuffer(result.stdout)) fail("spawnSync stdout/stderr must be Buffers");
  const stderr = result.stderr;
  const stdout = result.stdout;
  if (stderr.length > ANALYZER_CONSTANTS.MAX_STDERR_BYTES) fail("analyzer stderr exceeds bound");
  if (stderr.length !== 0) fail("analyzer wrote stderr on success");
  if (stdout.length < 8) fail("partial response frame");
  const length = stdout.readBigUInt64BE(0);
  if (length > BigInt(ANALYZER_CONSTANTS.MAX_RESPONSE_JSON_BYTES)) fail("response frame exceeds bound");
  if (BigInt(stdout.length - 8) !== length) fail(BigInt(stdout.length - 8) > length ? "trailing response frame bytes" : "partial response frame payload");
  const json = Buffer.from(stdout.subarray(8));
  const value = validateResponse(json, request, verified.domain);
  return { value, json };
}
function clearRuntimeDirectories() {
  for (const name of ["run-cwd", "run-home", "run-tmp"]) {
    const directory = path.join(ARTIFACT_ROOT, name);
    for (const entry of fs.readdirSync(directory)) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
    validateDirectory(directory, true, 0o700);
  }
}
function cacheKey(parts) {
  const framed = [];
  for (const part of parts) { const bytes = Buffer.from(String(part)); framed.push(frame(bytes)); }
  return sha256(Buffer.concat(framed));
}
function cacheGet(key, request, domain) {
  const bytes = CACHE.get(key);
  if (!bytes) return null;
  try {
    const value = validateResponse(Buffer.from(bytes), request, domain);
    CACHE.delete(key); CACHE.set(key, bytes);
    return value;
  } catch (error) {
    CACHE.delete(key); cacheBytes -= bytes.length;
    throw error;
  }
}
function cachePut(key, bytes) {
  if (bytes.length > ANALYZER_CONSTANTS.CACHE_MAX_ENCODED_BYTES) return;
  const prior = CACHE.get(key);
  if (prior) { CACHE.delete(key); cacheBytes -= prior.length; }
  CACHE.set(key, Buffer.from(bytes)); cacheBytes += bytes.length;
  while (CACHE.size > ANALYZER_CONSTANTS.CACHE_MAX_ENTRIES || cacheBytes > ANALYZER_CONSTANTS.CACHE_MAX_ENCODED_BYTES) {
    const oldest = CACHE.keys().next().value;
    const removed = CACHE.get(oldest); CACHE.delete(oldest); cacheBytes -= removed.length;
  }
}
export function analyzeKotlin(index) {
  const allRows = inputRows(index);
  return withPublicationLock(() => {
    const verified = verifyAnalyzerArtifactUnlocked();
    const kotlin = allRows.filter((row) => row.kind === "kotlin");
    const files = kotlin.map(({ path, bytes, sha256: digest, content }) => ({ path, bytes, sha256: digest, contentBase64: content.toString("base64") }));
    const manifest = files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest }));
    const digest = sha256(canonicalJson(manifest));
    const receipts = manifest.map((row) => ({ ...row }));
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    if (files.length > ANALYZER_CONSTANTS.MAX_KOTLIN_FILES || files.some((file) => file.bytes > ANALYZER_CONSTANTS.MAX_KOTLIN_FILE_BYTES)
        || totalBytes > ANALYZER_CONSTANTS.MAX_KOTLIN_TOTAL_BYTES) return localLimitResponse("analyze", digest, receipts);
    const request = { protocolVersion: 1, subsetVersion: 1, command: "analyze", kotlinInputSetSha256: digest, files };
    const anchor = canonicalJson([verified.receiptSha256, verified.jdkTreeSha256, verified.bridgeSha256, 1, 1]);
    if (cacheAnchor !== anchor) { CACHE.clear(); cacheBytes = 0; cacheAnchor = anchor; }
    const key = cacheKey([verified.receiptSha256, verified.analyzerJarSha256, verified.classpathSha256, verified.jdkTreeSha256, verified.domainSha256, verified.bridgeSha256, 1, 1, digest]);
    const cached = cacheGet(key, request, verified.domain);
    if (cached) return cached;
    const analyzed = invoke(request, verified);
    cachePut(key, analyzed.json);
    return analyzed.value;
  });
}
export function describeKotlinAnalyzer() {
  return withPublicationLock(() => {
    const verified = verifyAnalyzerArtifactUnlocked(); const digest = sha256(canonicalJson([]));
    return invoke({ protocolVersion: 1, subsetVersion: 1, command: "describe", kotlinInputSetSha256: digest, files: [] }, verified).value;
  });
}
function withPublicationLock(action) {
  validateDirectory(ARTIFACTS_ROOT, false, 0o700);
  const lock = path.join(ARTIFACTS_ROOT, ".publication-lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { fail(`artifact publication is busy: ${error.code ?? error.message}`); }
  try { return action(); } finally { fs.rmdirSync(lock); }
}
export function verifyAnalyzerArtifact() { return withPublicationLock(verifyAnalyzerArtifactUnlocked); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested); Object.freeze(value);
  }
  return value;
}
