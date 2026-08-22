package com.agentbench.analyzer;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class AbstractInterpreter {
    private static final String CLONE_FQN = "com.pico.spatial.core.ecs.Component.clone";
    private static final String CLONE_SIGNATURE = "clone(): Component";
    private static final String COMPONENT_FQN = "com.pico.spatial.core.ecs.Component";
    private static final String COMPONENT_TYPE_SIGNATURE = "open class Component";
    private static final String COMPONENT_CONSTRUCTOR_SIGNATURE = "Component()";
    private static final String CLONE_RULE_ID = "ecs.component-clone";
    private static final String WINDOW_FQN = "com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer";
    private static final String WINDOW_SIGNATURE = "SpatialAppScope.DefaultWindowContainer(content: @Composable WindowContainerScope.() -> Unit): Unit";
    private static final String THEME_FQN = "com.pico.spatial.ui.design.PicoTheme";
    private static final String THEME_SIGNATURE = "PicoTheme(colorScheme: ColorScheme = systemColorScheme(LocalContext.current), typography: Typography? = null, content: @Composable () -> Unit): Unit";
    private static final String STAGE_FQN = "com.pico.spatial.ui.foundation.dsl.Stage";
    private static final String STAGE_SIGNATURE = "SpatialAppScope.Stage(id: String, immersion: Immersion? = null, brightness: Brightness? = null, upperLimbRenderMode: UpperLimbRenderMode? = null, targetActivity: Class<out ComponentActivity>? = null, content: @Composable StageScope.() -> Unit): Unit";
    private static final String DISPOSABLE_EFFECT_FQN = "androidx.compose.runtime.DisposableEffect";
    private static final String DISPOSABLE_EFFECT_SIGNATURE = "DisposableEffect(key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit";
    private static final String DISPOSABLE_SCOPE_FQN = "androidx.compose.runtime.DisposableEffectScope";
    private static final String DISPOSABLE_SCOPE_SIGNATURE = "class DisposableEffectScope";
    private static final String ON_DISPOSE_FQN = "androidx.compose.runtime.DisposableEffectScope.onDispose";
    private static final String ON_DISPOSE_SIGNATURE = "onDispose(onDisposeEffect: () -> Unit): DisposableEffectResult";
    private static final String STAGE_SCOPE_FQN = "com.pico.spatial.ui.platform.containers.StageScope";
    private static final String STAGE_SCOPE_SIGNATURE = "interface StageScope";
    private static final String WINDOW_SCOPE_FQN = "com.pico.spatial.ui.platform.containers.WindowContainerScope";
    private static final String WINDOW_SCOPE_SIGNATURE = "interface WindowContainerScope";
    private static final String APPLICATION_TYPE_FQN = "android.app.Application";
    private static final String APPLICATION_TYPE_SIGNATURE = "open class Application";
    private static final String ON_CREATE_FQN = "android.app.Application.onCreate";
    private static final String ON_CREATE_SIGNATURE = "onCreate(): Unit";
    private static final String LAUNCH_FQN = "com.pico.spatial.ui.foundation.dsl.launch";
    private static final String LAUNCH_SIGNATURE = "Application.launch(block: SpatialAppScope.() -> Unit): Unit";
    private static final String SPATIAL_SCOPE_FQN = "com.pico.spatial.ui.foundation.dsl.SpatialAppScope";
    private static final String SPATIAL_SCOPE_SIGNATURE = "interface SpatialAppScope";
    private static final String WITH_FQN = "kotlin.with";
    private static final String WITH_SIGNATURE = "with(receiver: T, block: T.() -> R): R";
    private static final String LAUNCHED_EFFECT_FQN = "androidx.compose.runtime.LaunchedEffect";
    private static final String LAUNCHED_EFFECT_SIGNATURE = "LaunchedEffect(key1: Any?, block: suspend CoroutineScope.() -> Unit): Unit";
    private static final String OPEN_STAGE_FQN = "com.pico.spatial.ui.platform.containers.SpatialNavigator.openStage";
    private static final String OPEN_STAGE_SIGNATURE = "openStage(id: String, style: StageStyle? = null, bundle: Bundle? = null, upperLimbRenderMode: UpperLimbRenderMode = UpperLimbRenderMode.Default): OpenStageResult";
    private static final String MIXED_FQN = "com.pico.spatial.ui.platform.containers.StageStyle.Mixed";
    private static final String MIXED_SIGNATURE = "Mixed";
    private static final String BUNDLE_TYPE_FQN = "android.os.Bundle";
    private static final String BUNDLE_TYPE_SIGNATURE = "class Bundle";
    private static final String STAGE_BUNDLE_FQN = "com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle";
    private static final String STAGE_BUNDLE_SIGNATURE = "bundle: Bundle?";
    private static final String LOCAL_NAVIGATOR_FQN = "com.pico.spatial.ui.platform.containers.LocalSpatialNavigator";
    private static final String LOCAL_NAVIGATOR_SIGNATURE = "val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>";
    private static final String CURRENT_FQN = "androidx.compose.runtime.CompositionLocal.current";
    private static final String CURRENT_SIGNATURE = "current: T";
    private static final String NAVIGATOR_TYPE_FQN = "com.pico.spatial.ui.platform.containers.SpatialNavigator";
    private static final String NAVIGATOR_TYPE_SIGNATURE = "interface SpatialNavigator";
    private static final String ACTIVITY_TYPE_FQN = "com.pico.spatial.ui.platform.stub.SpatialLaunchActivity";
    private static final String ACTIVITY_TYPE_SIGNATURE = "abstract class SpatialLaunchActivity";
    private static final List<String> FACT_KINDS = List.of(
        "argument_binding", "callback_binding", "callback_parameter", "callback_receiver",
        "call_resolution", "callback_result", "cfg_edge", "closed_member_absence", "condition",
        "conformance", "definition", "def_use", "dominates", "effect", "escape",
        "function_binding", "implicit_receiver", "last_write", "loop_element", "loop_success",
        "nullable", "origin", "override", "paired_effect", "production_root", "reachable",
        "read", "retained_exit", "return_origin", "same_element", "same_origin",
        "strong_authority", "taint", "type", "type_argument", "witness_owner", "write");
    private static final List<String> SEMANTIC_TYPES = List.of(
        "boolean", "int", "long", "float", "double", "string", "unit", "java_class",
        "callable", "immutable_iterable", "immutable_list", "integer_range", "coroutine_scope",
        "android_application", "spatial_launch_activity", "bundle", "spatial_app_scope",
        "spatial_navigator", "stage_style", "spatial_content", "component", "component_store",
        "entity", "entity_collection", "entity_query_condition", "ecs_system", "scene",
        "scene_update_context", "transform_component", "vector3", "quat", "cancellable",
        "semantic_label", "plane_anchor", "plane_anchor_collection", "plane_geometry",
        "plane_orientation", "plane_tracking_manager", "immersion", "modifier", "transform",
        "vector2", "throwable", "disposable_effect_scope", "composition_local",
        "spatial_container_scope", "kclass", "row_scope", "attachment_panel_builder",
        "spatial_view_attachments", "anchor_update");
    private static final List<String> CALLBACK_ROLES = List.of(
        "application_entry", "window_content", "stage_content", "launched_effect", "button_click",
        "coroutine_body", "disposable_effect", "dispose_cleanup", "spatial_initial",
        "spatial_attachments", "spatial_update", "collection_element", "collection_predicate",
        "collection_selector", "inline_block", "remembered_factory", "anchor_update");
    private static final List<String> EFFECT_VALUES = List.of(
        "read", "mutate", "construct", "replace", "unknown_escape", "open", "close",
        "acquire", "release", "load", "readiness", "convert", "place", "status_assign",
        "passthrough");
    private static final List<String> PHYSICAL_OWNER_RELATIONS = List.of(
        "android.os.Bundle\nclass Bundle\nandroid.os.BaseBundle\nopen class BaseBundle\ninherits",
        "androidx.compose.runtime.ProvidableCompositionLocal\nabstract class ProvidableCompositionLocal<T>\nandroidx.compose.runtime.CompositionLocal\nabstract class CompositionLocal<T>\ninherits",
        "com.pico.spatial.core.container.SpatialViewContent\nclass SpatialViewContent\ncom.pico.spatial.core.container.SpatialViewEntityManager\ninterface SpatialViewEntityManager\ndelegates",
        "com.pico.spatial.core.container.SpatialViewContent\nclass SpatialViewContent\ncom.pico.spatial.core.container.SpatialViewEventManager\ninterface SpatialViewEventManager\ndelegates",
        "com.pico.spatial.core.container.SpatialViewContent\nclass SpatialViewContent\ncom.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter\ninterface SpatialCoordinateSpaceConverter\ndelegates",
        "com.pico.spatial.ui.platform.containers.StageScope\ninterface StageScope\ncom.pico.spatial.ui.platform.containers.SpatialContainerScope\ninterface SpatialContainerScope\ninherits",
        "com.pico.spatial.ui.platform.containers.WindowContainerScope\ninterface WindowContainerScope\ncom.pico.spatial.ui.platform.containers.SpatialContainerScope\ninterface SpatialContainerScope\ninherits",
        "kotlin.ranges.IntRange\nclass IntRange\nkotlin.ranges.IntProgression\nopen class IntProgression\ninherits");

    private final PsiIndex.Program program;
    private final Rules.Domain domain;
    private final Map<Integer, List<PsiIndex.Edge>> outgoing;
    private final Map<Integer, Integer> lexicalOwners;
    private final Map<Integer, List<Integer>> arithmeticInputs;
    private final Map<String, Object> kernel;
    private final Map<String, String> selectedAlternativesForTest;

    AbstractInterpreter(PsiIndex.Program program, Rules.Domain domain) {
        if (program == null || domain == null) throw new IllegalArgumentException("interpreter input is null");
        this.program = program;
        this.domain = domain;
        Map<Integer, List<PsiIndex.Edge>> mutableOutgoing = new HashMap<>();
        Map<Integer, Integer> mutableOwners = new HashMap<>();
        for (PsiIndex.Edge edge : program.edges()) {
            mutableOutgoing.computeIfAbsent(edge.fromNodeId(), ignored -> new ArrayList<>()).add(edge);
            if (edge.role() == PsiIndex.EdgeRole.LEXICAL_OWNER
                    && mutableOwners.put(edge.toNodeId(), edge.fromNodeId()) != null) {
                throw new IllegalArgumentException("duplicate lexical owner");
            }
        }
        Map<Integer, List<PsiIndex.Edge>> frozen = new HashMap<>();
        for (Map.Entry<Integer, List<PsiIndex.Edge>> entry : mutableOutgoing.entrySet()) {
            frozen.put(entry.getKey(), List.copyOf(entry.getValue()));
        }
        this.outgoing = Map.copyOf(frozen);
        this.lexicalOwners = Map.copyOf(mutableOwners);
        this.arithmeticInputs = new HashMap<>();
        this.kernel = buildKernel();
        this.selectedAlternativesForTest = new HashMap<>();
    }

    Rules.Analysis analyze() {
        selectedAlternativesForTest.clear();
        List<Rules.Analysis> parts = new ArrayList<>();
        parts.add(analyzeProjectEntry());
        parts.add(analyzeContainerTopology());
        parts.add(analyzeEntityContent());
        parts.add(analyzeUiLifecycle());
        parts.add(analyzeComponentClone());
        parts.add(analyzeSystemQuery());
        parts.add(analyzeFrameUpdate());
        parts.add(analyzeEcsLifecycle());
        parts.add(analyzeSingleSource());
        parts.add(analyzeTypedHandoff());
        parts.add(analyzeSharedReadWrite());
        parts.add(analyzeReopenWiring());
        parts.add(analyzeRetryReadiness());
        parts.add(analyzeSemanticFallback());
        parts.add(analyzeAnchorPose());
        parts.add(analyzeCleanupErrors());
        return Rules.combine(parts);
    }

    String selectedAlternativeForTest(String ruleId) {
        return selectedAlternativesForTest.get(ruleId);
    }

    private Rules.Analysis analyzeComponentClone() {
        Rules.SymbolSpec cloneSymbol = domain.symbol(CLONE_FQN, CLONE_SIGNATURE);
        Rules.SymbolSpec componentType = domain.symbol(COMPONENT_FQN, COMPONENT_TYPE_SIGNATURE);
        Rules.SymbolSpec componentConstructor = domain.symbol(COMPONENT_FQN, COMPONENT_CONSTRUCTOR_SIGNATURE);
        domain.symbol(componentType.fqn(), componentType.signature());
        domain.symbol(componentConstructor.fqn(), componentConstructor.signature());
        domain.symbol(cloneSymbol.fqn(), cloneSymbol.signature());
        Rules.RuleSpec cloneRule = domain.rule(CLONE_RULE_ID);
        Rules.Analysis match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.CLASS_DECL) continue;
            Rules.Analysis candidate = analyzeClass(node, componentType.fqn(), "clone", cloneRule);
            if (candidate == null) continue;
            if (match != null) return Rules.emptyAnalysis();
            match = candidate;
        }
        return match == null ? Rules.emptyAnalysis() : match;
    }

    Map<String, Object> kernelFactsForTest() {
        return kernel;
    }

    private Map<String, Object> buildKernel() {
        List<Map<String, Object>> facts = new ArrayList<>();
        Map<String, Boolean> factKeys = new HashMap<>();
        Map<String, Integer> multiplicities = new HashMap<>();
        Map<Integer, Boolean> unsupported = new HashMap<>();

        seedTypesAndOrigins(facts, factKeys, multiplicities, unsupported);
        seedDefinitions(facts, factKeys, multiplicities, unsupported);
        seedControlFlow(facts, factKeys, multiplicities, unsupported);
        seedOverridesAndRoots(facts, factKeys, multiplicities, unsupported);
        seedFunctionBindings(facts, factKeys, multiplicities, unsupported);
        seedEscapes(facts, factKeys, multiplicities, unsupported);
        resolveCalls(facts, factKeys, multiplicities, unsupported);
        seedUnresolvedCallFailures(facts, factKeys, multiplicities, unsupported);
        seedPassthroughFailures(facts, factKeys, multiplicities, unsupported);
        seedParameterOrigins(facts, factKeys, multiplicities, unsupported);
        seedPrimitiveFlow(facts, factKeys, multiplicities, unsupported);
        promoteCallbacks(facts, factKeys, multiplicities, unsupported);
        resolveCalls(facts, factKeys, multiplicities, unsupported);
        seedPrimitiveFailures(facts, factKeys, multiplicities, unsupported);
        seedReadsWritesAndAuthority(facts, factKeys, multiplicities, unsupported);
        seedRetainedExits(facts, factKeys, multiplicities, unsupported);
        seedPairedEffects(facts, factKeys, multiplicities, unsupported);
        seedIdentityAndDominance(facts, factKeys, multiplicities, unsupported);

        facts.sort((left, right) -> Protocol.compareUtf8(
            Protocol.canonicalJson(left), Protocol.canonicalJson(right)));
        long maximum = 59L * Math.max(1, program.nodes().size());
        if (facts.size() > maximum) throw new IllegalArgumentException("kernel fact bound exceeded");
        List<Long> unsupportedIds = new ArrayList<>();
        for (PsiIndex.Node node : program.nodes()) {
            if (unsupported.containsKey(node.id())) unsupportedIds.add((long) node.id());
        }
        if (unsupportedIds.size() > program.nodes().size()) {
            throw new IllegalArgumentException("kernel unsupported bound exceeded");
        }
        return Map.copyOf(Map.of(
            "kernelVersion", 1L,
            "facts", List.copyOf(facts),
            "unsupportedNodeIds", List.copyOf(unsupportedIds)));
    }

    private void addFact(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported,
            String kind, PsiIndex.Node subject, PsiIndex.Node owner, PsiIndex.Node related,
            String value, Rules.SymbolSpec symbol) {
        addFact(facts, factKeys, multiplicities, unsupported, kind, subject,
            owner == null ? -1 : owner.id(), related == null ? -1 : related.id(), value, symbol);
    }

    private void addFact(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported,
            String kind, PsiIndex.Node subject, PsiIndex.Node owner, int relatedId,
            String value, Rules.SymbolSpec symbol) {
        addFact(facts, factKeys, multiplicities, unsupported, kind, subject,
            owner == null ? -1 : owner.id(), relatedId, value, symbol);
    }

    private void addFact(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported,
            String kind, PsiIndex.Node subject, int ownerId, int relatedId,
            String value, Rules.SymbolSpec symbol) {
        if (kind.equals("conformance")) {
            ownerId = -1;
            if (relatedId >= 0 && !isTypeDeclaration(program.node(relatedId))) relatedId = -1;
        } else if (kind.equals("closed_member_absence")) {
            ownerId = -1;
        } else if (kind.equals("type") && relatedId >= 0
                && !isTypeDeclaration(program.node(relatedId))) {
            relatedId = -1;
        }
        if (kind.equals("reachable") || kind.equals("condition")) symbol = null;
        if (subject == null || value == null || ownerId < -1 || relatedId < -1
                || ownerId >= program.nodes().size() || relatedId >= program.nodes().size()) {
            throw new IllegalArgumentException("invalid kernel fact");
        }
        if (subject.id() < 0 || subject.id() >= program.nodes().size()
                || program.node(subject.id()) != subject || !FACT_KINDS.contains(kind)
                || !validFactValue(kind, value)) {
            throw new IllegalArgumentException("invalid kernel fact grammar");
        }
        String symbolFqn = symbol == null ? "" : symbol.fqn();
        String symbolSignature = symbol == null ? "" : symbol.signature();
        if (symbol != null && domainSymbolOrNull(symbolFqn, symbolSignature) != symbol) {
            throw new IllegalArgumentException("kernel symbol is outside domain");
        }
        if (!validFactShape(kind, ownerId, relatedId, value, symbol)) {
            throw new IllegalArgumentException("invalid kernel fact shape");
        }
        Map<String, Object> row = Map.copyOf(Map.of(
            "kind", kind,
            "ownerNodeId", (long) ownerId,
            "relatedNodeId", (long) relatedId,
            "subjectNodeId", (long) subject.id(),
            "symbolFqn", symbolFqn,
            "symbolSignature", symbolSignature,
            "value", value));
        String canonical = Protocol.canonicalJson(row);
        if (factKeys.containsKey(canonical)) return;
        String countKey = kind + "\n" + subject.id();
        int count = multiplicities.getOrDefault(countKey, 0) + 1;
        if (count > factLimit(kind)) {
            unsupported.put(subject.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported, subject, ownerId,
                subject.id(), "limit");
            return;
        }
        multiplicities.put(countKey, count);
        factKeys.put(canonical, Boolean.TRUE);
        facts.add(row);
    }

    private void addTaint(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported,
            PsiIndex.Node subject, int ownerId, int relatedId, String value) {
        if (subject == null || !validFactValue("taint", value)
                || ownerId < -1 || relatedId < -1 || ownerId >= program.nodes().size()
                || relatedId >= program.nodes().size()) {
            throw new IllegalArgumentException("invalid kernel taint");
        }
        Map<String, Object> row = Map.copyOf(Map.of(
            "kind", "taint",
            "ownerNodeId", (long) ownerId,
            "relatedNodeId", (long) relatedId,
            "subjectNodeId", (long) subject.id(),
            "symbolFqn", "",
            "symbolSignature", "",
            "value", value));
        String canonical = Protocol.canonicalJson(row);
        String countKey = "taint\n" + subject.id();
        if (!factKeys.containsKey(canonical) && multiplicities.getOrDefault(countKey, 0) == 0) {
            multiplicities.put(countKey, 1);
            factKeys.put(canonical, Boolean.TRUE);
            facts.add(row);
        }
    }

    private void replaceTaint(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported,
            PsiIndex.Node subject, int ownerId, int relatedId, String value) {
        for (int index = facts.size() - 1; index >= 0; index--) {
            Map<String, Object> fact = facts.get(index);
            if (!"taint".equals(fact.get("kind"))
                    || !Long.valueOf(subject.id()).equals(fact.get("subjectNodeId"))) continue;
            factKeys.remove(Protocol.canonicalJson(fact));
            facts.remove(index);
        }
        multiplicities.remove("taint\n" + subject.id());
        addTaint(facts, factKeys, multiplicities, unsupported,
            subject, ownerId, relatedId, value);
    }

    private void clearRecoverableCallFailure(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported, PsiIndex.Node call) {
        clearFailureValues(facts, factKeys, multiplicities, unsupported,
            call, List.of("unknown_receiver", "unsupported"));
    }

    private void clearFailureValues(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported, PsiIndex.Node subject,
            List<String> recoverableValues) {
        boolean retainedFailure = false;
        boolean removed = false;
        for (int index = facts.size() - 1; index >= 0; index--) {
            Map<String, Object> fact = facts.get(index);
            if (!"taint".equals(fact.get("kind"))
                    || !Long.valueOf(subject.id()).equals(fact.get("subjectNodeId"))) continue;
            String value = (String) fact.get("value");
            if (!recoverableValues.contains(value)) {
                retainedFailure = true;
                continue;
            }
            factKeys.remove(Protocol.canonicalJson(fact));
            facts.remove(index);
            removed = true;
        }
        if (removed) multiplicities.remove("taint\n" + subject.id());
        if (!retainedFailure) unsupported.remove(subject.id());
    }

    private boolean validFactValue(String kind, String value) {
        if (kind.equals("argument_binding")) return value.matches("0|[1-9][0-9]*");
        if (kind.equals("callback_binding")) return CALLBACK_ROLES.contains(value);
        if (kind.equals("callback_parameter") || kind.equals("callback_receiver")
                || kind.equals("callback_result") || kind.equals("conformance")
                || kind.equals("loop_element") || kind.equals("return_origin")
                || kind.equals("type") || kind.equals("type_argument")) {
            return SEMANTIC_TYPES.contains(value);
        }
        if (kind.equals("call_resolution")) return List.of(
            "domain", "source", "primitive", "null", "enum", "class_token", "function_value")
            .contains(value);
        if (kind.equals("cfg_edge")) return List.of(
            "fallthrough", "true", "false", "loop", "break", "continue", "return", "catch",
            "finally").contains(value);
        if (kind.equals("closed_member_absence")) {
            return value.matches("[A-Za-z_][A-Za-z0-9_]*");
        }
        if (kind.equals("condition")) return List.of(
            "true", "false", "nonnull", "null", "readiness_positive", "readiness_negative",
            "enum_equal", "enum_not_equal", "numeric_compare").contains(value);
        if (kind.equals("dominates")) return List.of(
            "control", "semantic", "horizontal", "area").contains(value);
        if (kind.equals("effect")) return EFFECT_VALUES.contains(value);
        if (kind.equals("escape")) return List.of(
            "argument", "return", "property", "unknown_call", "mutable_capture").contains(value);
        if (kind.equals("function_binding")) return List.of(
            "lambda", "callable_reference").contains(value);
        if (kind.equals("implicit_receiver")) return List.of(
            "callback", "source_extension", "source_dispatch", "domain_qualifier",
            "source_qualifier").contains(value);
        if (kind.equals("loop_success")) return value.equals("break") || value.equals("return");
        if (kind.equals("nullable")) return value.equals("true") || value.equals("false");
        if (kind.equals("origin")) return List.of(
            "fresh", "retained", "derived", "literal", "parameter", "property", "callback",
            "collection_element", "class_token").contains(value);
        if (kind.equals("paired_effect")) return List.of(
            "ecs_system_lifecycle", "plane_tracking", "cancellable_resource").contains(value);
        if (kind.equals("production_root")) {
            return value.equals("direct") || CALLBACK_ROLES.contains(value);
        }
        if (kind.equals("reachable")) return List.of(
            "direct", "source_root", "possible_path", "user_action", "launched_path",
            "acquire_path", "cleanup_path", "immediate_inline", "element_flow", "predicate_flow",
            "selector_flow", "branch", "loop").contains(value);
        if (kind.equals("same_element")) return List.of(
            "semantic", "orientation", "area", "selection").contains(value);
        if (kind.equals("same_origin")) return List.of(
            "authority", "navigation", "pose", "state", "resource").contains(value);
        if (kind.equals("strong_authority")) return List.of(
            "top_level", "object", "companion").contains(value);
        if (kind.equals("taint")) return List.of(
            "unsupported", "ambiguous", "escape", "limit", "unknown_receiver", "unknown_return",
            "unknown_effect", "unknown_control").contains(value);
        if (kind.equals("witness_owner")) return List.of(
            "break", "index", "elvis", "until", "equality", "enum_entry").contains(value);
        return List.of("definition", "def_use", "last_write", "override", "read",
            "retained_exit", "write").contains(kind) && value.isEmpty();
    }

    private boolean validFactShape(String kind, int ownerId, int relatedId, String value,
            Rules.SymbolSpec symbol) {
        if (kind.equals("call_resolution")) return value.equals("domain") == (symbol != null);
        if (kind.equals("callback_binding") || kind.equals("paired_effect")
                || kind.equals("retained_exit")) return ownerId >= 0 && relatedId >= 0;
        if (kind.equals("cfg_edge") || kind.equals("definition") || kind.equals("def_use")
                || kind.equals("last_write") || kind.equals("witness_owner")) return relatedId >= 0;
        if (kind.equals("closed_member_absence")) {
            return ownerId == -1 && relatedId >= 0 && symbol != null && symbol.kind().equals("type");
        }
        if (kind.equals("conformance")) {
            return ownerId == -1 && (relatedId == -1 || isTypeDeclaration(program.node(relatedId)))
                && symbol != null;
        }
        if (kind.equals("reachable") || kind.equals("condition")) return symbol == null;
        if (kind.equals("production_root") && value.equals("direct")) {
            return relatedId == -1 && symbol != null;
        }
        if (kind.equals("reachable") && value.equals("direct")) return relatedId == -1;
        return true;
    }

    private int factLimit(String kind) {
        if (kind.equals("cfg_edge")) return 3;
        if (kind.equals("conformance")) return 8;
        if (kind.equals("dominates") || kind.equals("effect") || kind.equals("same_element")) return 4;
        if (kind.equals("same_origin")) return 5;
        return 1;
    }

    private boolean hasKernelFact(String kind, int subjectNodeId, String fqn, String signature) {
        Object rawFacts = kernel.get("facts");
        if (!(rawFacts instanceof List<?> facts)) return false;
        for (Object raw : facts) {
            if (!(raw instanceof Map<?, ?> fact)) continue;
            if (kind.equals(fact.get("kind")) && Long.valueOf(subjectNodeId).equals(fact.get("subjectNodeId"))
                    && fqn.equals(fact.get("symbolFqn")) && signature.equals(fact.get("symbolSignature"))) {
                return true;
            }
        }
        return false;
    }

    private void seedTypesAndOrigins(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            PsiIndex.Node owner = enclosingCallable(node);
            if (node.kind() == PsiIndex.NodeKind.TYPE_REF) {
                Rules.SymbolSpec physical = typeSymbolForReference(node);
                String type = physical == null ? primitiveType(node) : physical.returnAbstractType();
                if (type != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "type", node, owner, -1, type, physical);
                if (isExplicitNullable(node)) addFact(facts, factKeys, multiplicities, unsupported,
                    "nullable", node, owner, -1, "true", null);
            } else if (node.kind() == PsiIndex.NodeKind.LITERAL) {
                String type = literalType(node);
                if (type != null) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, type, null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", node, owner, -1, "literal", null);
                }
            } else if (node.kind() == PsiIndex.NodeKind.STRING_TEMPLATE) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "type", node, owner, -1, "string", null);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "origin", node, owner, -1, "literal", null);
            } else if (node.kind() == PsiIndex.NodeKind.NAME_REF && node.name() != null) {
                String imported = importedFqn(node.fileId(), node.name());
                Rules.SymbolSpec qualifier = imported == null ? null : typeSymbolByFqn(imported);
                if ("androidx.compose.ui.Modifier".equals(imported)
                        && isQualifiedReceiver(node)) qualifier = typeSymbolExact(
                    "androidx.compose.ui.Modifier.Companion", "companion object : Modifier");
                if (qualifier != null) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, qualifier.returnAbstractType(), qualifier);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", node, owner, -1, "retained", qualifier);
                    addDirectConformance(node, owner, qualifier, facts, factKeys, multiplicities, unsupported);
                }
            }
        }
        for (PsiIndex.Node declaration : program.nodes()) {
            if (!isDeclarationKind(declaration.kind())) continue;
            PsiIndex.Node owner = enclosingCallable(declaration);
            PsiIndex.Node typeNode = declarationTypeNode(declaration, false);
            String type = typeNode == null ? null : factValue(facts, "type", typeNode.id());
            Rules.SymbolSpec physical = typeNode == null ? null : typeSymbolForReference(typeNode);
            if (type == null && isTypeDeclaration(declaration)) {
                PsiIndex.Node superType = one(declaration, PsiIndex.EdgeRole.SUPER_TYPE);
                Rules.SymbolSpec inherited = superType == null ? null : typeSymbolForReference(superType);
                if (inherited != null) {
                    type = inherited.returnAbstractType();
                    physical = inherited;
                }
            }
            if (type != null) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "type", declaration, owner, physical == null ? -1 : typeNode == null ? -1 : typeNode.id(),
                    type, physical);
                addDirectConformance(declaration, owner, physical,
                    facts, factKeys, multiplicities, unsupported);
            }
            if (typeNode != null && isExplicitNullableTarget(declaration, typeNode)) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "nullable", declaration, owner, typeNode, "true", null);
                PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
                if (isNullLiteral(initializer)) addFact(facts, factKeys, multiplicities, unsupported,
                    "nullable", initializer, owner, declaration, "true", null);
            }
        }
    }

    private void seedParameterOrigins(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node parameter : program.nodes()) {
            if (parameter.kind() != PsiIndex.NodeKind.PARAMETER_DECL
                    || enclosingLambda(parameter) != null
                    || hasFact(facts, "origin", parameter.id())) continue;
            addFact(facts, factKeys, multiplicities, unsupported,
                "origin", parameter, enclosingCallable(parameter), -1, "parameter", null);
        }
    }

    private void seedDefinitions(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            PsiIndex.Node owner = enclosingCallable(node);
            if ((node.kind() == PsiIndex.NodeKind.PARAMETER_DECL
                    || node.kind() == PsiIndex.NodeKind.PROPERTY_DECL) && node.name() != null) {
                PsiIndex.Node value = node.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                    ? one(node, PsiIndex.EdgeRole.INITIALIZER) : node;
                if (value != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "definition", node, owner, value, "", null);
            } else if (node.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
                PsiIndex.Node target = one(node, PsiIndex.EdgeRole.TARGET);
                PsiIndex.Node value = one(node, PsiIndex.EdgeRole.VALUE);
                if (target != null && target.name() != null && value != null) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "definition", node, owner, value, "", null);
                }
            }
        }
        for (PsiIndex.Node use : program.nodes()) {
            if (use.kind() != PsiIndex.NodeKind.NAME_REF || use.name() == null
                    || isAssignmentTarget(use)) continue;
            PsiIndex.Node owner = enclosingCallable(use);
            PsiIndex.Node declaration = findLexicalDeclaration(use, use.name());
            if (declaration == null || declaration.id() == use.id()) continue;
            PsiIndex.Node reaching = declaration;
            int reachingStart = declaration.startUtf16();
            List<PsiIndex.Node> conditionalWrites = new ArrayList<>();
            for (PsiIndex.Node assignment : program.nodes()) {
                if (assignment.kind() != PsiIndex.NodeKind.ASSIGNMENT
                        || assignment.fileId() != use.fileId()
                        || assignment.startUtf16() >= use.startUtf16()) continue;
                PsiIndex.Node assignmentOwner = enclosingCallable(assignment);
                if (owner == null ? assignmentOwner != null
                        : assignmentOwner == null || assignmentOwner.id() != owner.id()) continue;
                PsiIndex.Node target = one(assignment, PsiIndex.EdgeRole.TARGET);
                if (target == null || !use.name().equals(target.name())) continue;
                PsiIndex.Node targetDeclaration = findLexicalDeclaration(target, target.name());
                if (targetDeclaration == null || targetDeclaration.id() != declaration.id()) continue;
                PsiIndex.Node region = conditionalRegion(assignment);
                if (region == null || isWithin(use, region)) {
                    if (assignment.startUtf16() > reachingStart) {
                        reaching = assignment;
                        reachingStart = assignment.startUtf16();
                    }
                } else conditionalWrites.add(assignment);
            }
            boolean ambiguous = false;
            for (PsiIndex.Node assignment : conditionalWrites) {
                if (assignment.startUtf16() > reachingStart) ambiguous = true;
            }
            if (ambiguous) {
                unsupported.put(use.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    use, owner == null ? -1 : owner.id(), use.id(), "ambiguous");
                continue;
            }
            addFact(facts, factKeys, multiplicities, unsupported,
                "def_use", use, owner, reaching, "", null);
            addFact(facts, factKeys, multiplicities, unsupported,
                "last_write", use, owner, reaching, "", null);
            PsiIndex.Node typed = reaching.kind() == PsiIndex.NodeKind.ASSIGNMENT
                ? one(reaching, PsiIndex.EdgeRole.VALUE) : reaching;
            String type = typeOf(facts, typed);
            boolean boundFunctionReference = "callable".equals(type)
                && relatedNodeForFact(facts, "function_binding", declaration.id()) != null;
            if (type != null && !boundFunctionReference) addFact(facts, factKeys, multiplicities, unsupported,
                "type", use, owner, -1, type, symbolForFact(facts, "type", typed.id()));
        }
    }

    private boolean isAssignmentTarget(PsiIndex.Node node) {
        Integer ownerId = node == null ? null : lexicalOwners.get(node.id());
        if (ownerId == null) return false;
        PsiIndex.Node owner = program.node(ownerId);
        if (owner.kind() == PsiIndex.NodeKind.ASSIGNMENT
                && isTarget(owner, PsiIndex.EdgeRole.TARGET, node)) return true;
        return (owner.kind() == PsiIndex.NodeKind.QUALIFIED
                || owner.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED)
            && isTarget(owner, PsiIndex.EdgeRole.SELECTOR, node)
            && isAssignmentTarget(owner);
    }

    private PsiIndex.Node conditionalRegion(PsiIndex.Node node) {
        PsiIndex.Node current = node;
        Integer ownerId = lexicalOwners.get(current.id());
        while (ownerId != null) {
            PsiIndex.Node owner = program.node(ownerId);
            Integer parentId = lexicalOwners.get(owner.id());
            PsiIndex.Node parent = parentId == null ? null : program.node(parentId);
            if (owner.kind() == PsiIndex.NodeKind.BLOCK && parent != null
                    && (parent.kind() == PsiIndex.NodeKind.IF
                        || parent.kind() == PsiIndex.NodeKind.WHEN_ENTRY
                        || parent.kind() == PsiIndex.NodeKind.FOR
                        || parent.kind() == PsiIndex.NodeKind.WHILE)) return owner;
            if (owner.kind() == PsiIndex.NodeKind.WHEN_ENTRY) return owner;
            if (owner.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || owner.kind() == PsiIndex.NodeKind.LAMBDA) return null;
            current = owner;
            ownerId = parentId;
        }
        return null;
    }

    private void seedOverridesAndRoots(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node type : program.nodes()) {
            if (!isTypeDeclaration(type)) continue;
            for (PsiIndex.Node member : lexicalChildren(type)) {
                if (member.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                        || !member.flags().contains(PsiIndex.NodeFlag.OVERRIDE) || member.name() == null) continue;
                List<Rules.SymbolSpec> domainSlots = new ArrayList<>();
                List<PsiIndex.Node> sourceSlots = new ArrayList<>();
                for (PsiIndex.Node superReference : targets(type, PsiIndex.EdgeRole.SUPER_TYPE)) {
                    Rules.SymbolSpec superType = typeSymbolForReference(superReference);
                    if (superType != null) domainSlots.addAll(inheritedSlots(superType, member));
                    PsiIndex.Node sourceType = sourceTypeDeclaration(superReference);
                    if (sourceType != null) sourceSlots.addAll(sourceInheritedSlots(sourceType, member));
                }
                if (domainSlots.size() + sourceSlots.size() != 1) {
                    if (!domainSlots.isEmpty() || !sourceSlots.isEmpty()) {
                        unsupported.put(member.id(), Boolean.TRUE);
                        addTaint(facts, factKeys, multiplicities, unsupported,
                            member, type.id(), member.id(), "ambiguous");
                    }
                    continue;
                }
                if (domainSlots.isEmpty()) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "override", member, type, sourceSlots.get(0), "", null);
                    continue;
                }
                Rules.SymbolSpec slot = domainSlots.get(0);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "override", member, type, -1, "", slot);
                if (!isProductionPath(type.fileId()) || !isDirectRootSlot(slot, type, member)) continue;
                addFact(facts, factKeys, multiplicities, unsupported,
                    "production_root", member, type, -1, "direct", slot);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "reachable", member, member, -1, "direct", null);
                markLexicallyReachable(member, member, "direct", facts, factKeys, multiplicities, unsupported);
            }
        }
    }

    private List<Rules.SymbolSpec> inheritedSlots(Rules.SymbolSpec superType, PsiIndex.Node member) {
        List<Rules.SymbolSpec> matches = new ArrayList<>();
        String prefix = superType.fqn() + "." + member.name();
        for (Rules.SymbolSpec candidate : domain.symbols()) {
            if (!candidate.fqn().equals(prefix) || !candidate.kind().equals("member_function")
                    || !superType.returnAbstractType().equals(candidate.receiverAbstractType())
                    || !domainOverrideSignatureMatches(member, candidate)) continue;
            matches.add(candidate);
        }
        return matches;
    }

    private boolean domainOverrideSignatureMatches(PsiIndex.Node member, Rules.SymbolSpec slot) {
        List<PsiIndex.Node> parameters = targets(member, PsiIndex.EdgeRole.PARAMETER);
        if (parameters.size() != slot.arguments().size()) return false;
        for (int index = 0; index < parameters.size(); index++) {
            String actual = declaredSemanticType(parameters.get(index));
            if (actual == null || !actual.equals(slot.arguments().get(index).abstractType())) return false;
        }
        String result = declaredFunctionResult(member);
        if (result != null) return result.equals(slot.returnAbstractType());
        PsiIndex.Node resultType = declarationTypeNode(member, false);
        PsiIndex.Node sourceResult = sourceTypeDeclaration(resultType);
        return sourceResult != null && sourceAbstractConformancePathCount(
            sourceResult, slot.returnAbstractType(), 0, new HashMap<>()) == 1;
    }

    private int sourceAbstractConformancePathCount(PsiIndex.Node source, String required,
            int depth, Map<Integer, Boolean> active) {
        if (source == null || required == null || depth >= 8
                || active.put(source.id(), Boolean.TRUE) != null) return 0;
        int paths = 0;
        for (PsiIndex.Node superType : targets(source, PsiIndex.EdgeRole.SUPER_TYPE)) {
            Rules.SymbolSpec physical = typeSymbolForReference(superType);
            if (physical != null) paths += conformancePathCountFromPhysical(
                physical, required, depth + 1, new HashMap<>());
            else paths += sourceAbstractConformancePathCount(
                sourceTypeDeclaration(superType), required, depth + 1, active);
            if (paths > 1) break;
        }
        active.remove(source.id());
        return Math.min(paths, 2);
    }

    private List<PsiIndex.Node> sourceInheritedSlots(PsiIndex.Node superType, PsiIndex.Node member) {
        List<PsiIndex.Node> matches = new ArrayList<>();
        for (PsiIndex.Node candidate : lexicalChildren(superType)) {
            if (candidate.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !member.name().equals(candidate.name())
                    || candidate.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                    || !(containsToken(candidate, "open") || one(candidate, PsiIndex.EdgeRole.BODY) == null)
                    || !sourceOverrideSignatureMatches(member, candidate)) continue;
            matches.add(candidate);
        }
        return matches;
    }

    private boolean sourceOverrideSignatureMatches(PsiIndex.Node member, PsiIndex.Node slot) {
        List<PsiIndex.Node> actual = targets(member, PsiIndex.EdgeRole.PARAMETER);
        List<PsiIndex.Node> required = targets(slot, PsiIndex.EdgeRole.PARAMETER);
        if (actual.size() != required.size()) return false;
        for (int index = 0; index < actual.size(); index++) {
            String actualType = declaredSemanticType(actual.get(index));
            String requiredType = declaredSemanticType(required.get(index));
            if (actualType == null || !actualType.equals(requiredType)) return false;
        }
        String actualResult = declaredFunctionResult(member);
        String requiredResult = declaredFunctionResult(slot);
        return actualResult != null && actualResult.equals(requiredResult);
    }

    private String declaredFunctionResult(PsiIndex.Node function) {
        PsiIndex.Node type = declarationTypeNode(function, false);
        if (type != null) {
            Rules.SymbolSpec physical = typeSymbolForReference(type);
            return physical == null ? primitiveType(type) : physical.returnAbstractType();
        }
        return function.flags().contains(PsiIndex.NodeFlag.EXPRESSION_BODY) ? null : "unit";
    }

    private boolean isDirectRootSlot(Rules.SymbolSpec slot, PsiIndex.Node type, PsiIndex.Node member) {
        if (slot.fqn().equals("android.app.Application.onCreate")
                && slot.signature().equals("onCreate(): Unit")) {
            return member.name().equals("onCreate") && targets(member, PsiIndex.EdgeRole.PARAMETER).isEmpty();
        }
        if (slot.fqn().equals("com.pico.spatial.core.ecs.System.update")
                && slot.signature().equals("update(context: SceneUpdateContext): Unit")) {
            List<PsiIndex.Node> parameters = targets(member, PsiIndex.EdgeRole.PARAMETER);
            return member.name().equals("update") && parameters.size() == 1
                && "scene_update_context".equals(declaredSemanticType(parameters.get(0)));
        }
        if (slot.fqn().equals(CLONE_FQN) && slot.signature().equals(CLONE_SIGNATURE)) {
            return member.name().equals("clone") && targets(member, PsiIndex.EdgeRole.PARAMETER).isEmpty()
                && isTypeDeclaration(type);
        }
        return false;
    }

    private void markLexicallyReachable(PsiIndex.Node root, PsiIndex.Node owner, String value,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            if (node.id() == root.id() || !isWithin(node, root)) continue;
            PsiIndex.Node nestedCallable = enclosingCallable(node);
            if (nestedCallable != null && nestedCallable.id() != root.id()) continue;
            int incoming = incomingCfgPredecessor(node, facts);
            if (incoming == -2 && blockedByTerminalSibling(node)) continue;
            PsiIndex.Node predecessor = incoming >= 0 ? program.node(incoming)
                : incoming == -1 ? null : lexicalPredecessor(node, root);
            String reach = node.kind() == PsiIndex.NodeKind.IF || node.kind() == PsiIndex.NodeKind.WHEN
                ? "branch" : node.kind() == PsiIndex.NodeKind.FOR || node.kind() == PsiIndex.NodeKind.WHILE
                ? "loop" : value;
            addFact(facts, factKeys, multiplicities, unsupported,
                "reachable", node, owner, predecessor, reach, null);
        }
    }

    private int incomingCfgPredecessor(PsiIndex.Node node,
            List<Map<String, Object>> facts) {
        int match = -2;
        for (Map<String, Object> fact : facts) {
            if (!fact.get("kind").equals("cfg_edge")
                    || !fact.get("relatedNodeId").equals((long) node.id())) continue;
            int subject = ((Long) fact.get("subjectNodeId")).intValue();
            if (match >= 0 && match != subject) return -1;
            match = subject;
        }
        return match;
    }

    private boolean blockedByTerminalSibling(PsiIndex.Node node) {
        Integer ownerId = lexicalOwners.get(node.id());
        if (ownerId == null) return false;
        List<PsiIndex.Node> siblings = lexicalChildren(program.node(ownerId));
        for (int index = 1; index < siblings.size(); index++) {
            if (siblings.get(index).id() == node.id()) return isTerminal(siblings.get(index - 1));
        }
        return false;
    }

    private void seedControlFlow(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            PsiIndex.Node owner = enclosingCallable(node);
            if (node.kind() == PsiIndex.NodeKind.BLOCK) {
                List<PsiIndex.Node> children = lexicalChildren(node);
                for (int index = 0; index + 1 < children.size(); index++) {
                    PsiIndex.Node predecessor = children.get(index);
                    if (!isTerminal(predecessor) && !hasStructuredControlFlow(predecessor)) addFact(
                        facts, factKeys, multiplicities, unsupported,
                        "cfg_edge", predecessor, owner, firstBoundary(children.get(index + 1)),
                        "fallthrough", null);
                }
            } else if (node.kind() == PsiIndex.NodeKind.IF) {
                PsiIndex.Node condition = one(node, PsiIndex.EdgeRole.CONDITION);
                PsiIndex.Node thenBranch = one(node, PsiIndex.EdgeRole.THEN_BRANCH);
                PsiIndex.Node elseBranch = one(node, PsiIndex.EdgeRole.ELSE_BRANCH);
                PsiIndex.Node continuation = nextBoundary(node);
                if (condition == null || thenBranch == null) {
                    unsupported.put(node.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), node.id(), "unknown_control");
                    continue;
                }
                List<PsiIndex.Node> unknownCalls = definitelyUnknownCalls(condition, facts);
                if (!unknownCalls.isEmpty()) {
                    unsupported.put(node.id(), Boolean.TRUE);
                    PsiIndex.Node decisive = unknownCalls.size() == 1 ? unknownCalls.get(0) : node;
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), decisive.id(),
                        unknownCalls.size() == 1 ? "unknown_control" : "ambiguous");
                    continue;
                }
                addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", condition, owner, firstBoundary(thenBranch), "true", null);
                PsiIndex.Node falseTarget = elseBranch == null ? continuation : firstBoundary(elseBranch);
                if (falseTarget != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", condition, owner, falseTarget, "false", null);
                if (continuation != null) {
                    PsiIndex.Node thenExit = normalExit(thenBranch);
                    PsiIndex.Node elseExit = elseBranch == null ? null : normalExit(elseBranch);
                    if (thenExit != null) addFact(facts, factKeys, multiplicities, unsupported,
                        "cfg_edge", thenExit, owner, continuation, "fallthrough", null);
                    if (elseExit != null) addFact(facts, factKeys, multiplicities, unsupported,
                        "cfg_edge", elseExit, owner, continuation, "fallthrough", null);
                }
            } else if (node.kind() == PsiIndex.NodeKind.WHILE || node.kind() == PsiIndex.NodeKind.FOR) {
                if (node.kind() == PsiIndex.NodeKind.WHILE
                        && !isCanonicalBoundedWhile(node, facts)) {
                    unsupported.put(node.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), node.id(), "unknown_control");
                    continue;
                }
                PsiIndex.Node head = node.kind() == PsiIndex.NodeKind.WHILE
                    ? one(node, PsiIndex.EdgeRole.CONDITION) : one(node, PsiIndex.EdgeRole.RANGE);
                PsiIndex.Node body = one(node, PsiIndex.EdgeRole.LOOP_BODY);
                PsiIndex.Node continuation = nextBoundary(node);
                if (head == null || body == null) {
                    unsupported.put(node.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), node.id(), "unknown_control");
                    continue;
                }
                addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", head, owner, firstBoundary(body), "true", null);
                if (continuation != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", head, owner, continuation, "false", null);
                PsiIndex.Node exit = normalExit(body);
                if (exit != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", exit, owner, head, "loop", null);
                List<PsiIndex.Node> successfulExits = new ArrayList<>();
                for (PsiIndex.Node descendant : program.nodes()) {
                    if (!isWithin(descendant, node)) continue;
                    if (descendant.kind() == PsiIndex.NodeKind.BREAK && continuation != null) {
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "cfg_edge", descendant, owner, continuation, "break", null);
                        successfulExits.add(descendant);
                        addWitnessOwner(facts, factKeys, multiplicities, unsupported,
                            descendant, owner, node, "break");
                    } else if (descendant.kind() == PsiIndex.NodeKind.CONTINUE) {
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "cfg_edge", descendant, owner, head, "continue", null);
                    } else if (descendant.kind() == PsiIndex.NodeKind.RETURN
                            && !descendant.flags().contains(PsiIndex.NodeFlag.LABELED)
                            && enclosingCallable(descendant) == owner) {
                        successfulExits.add(descendant);
                    }
                }
                if (successfulExits.size() == 1) {
                    PsiIndex.Node success = successfulExits.get(0);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "loop_success", node, owner, success,
                        success.kind() == PsiIndex.NodeKind.BREAK ? "break" : "return", null);
                } else if (successfulExits.size() > 1) {
                    unsupported.put(node.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), node.id(), "ambiguous");
                }
            } else if (node.kind() == PsiIndex.NodeKind.RETURN) {
                PsiIndex.Node returnOwner = enclosingCallable(node);
                if (returnOwner != null && !node.flags().contains(PsiIndex.NodeFlag.LABELED)
                        && !isFinallyProtectedExit(node, returnOwner)) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "cfg_edge", node, returnOwner, returnOwner, "return", null);
                } else if (returnOwner != null && node.flags().contains(PsiIndex.NodeFlag.LABELED)) {
                    List<PsiIndex.Node> callbacks = matchingLabeledCallbacks(node);
                    if (callbacks.size() == 1) {
                        PsiIndex.Node continuation = nextBoundary(callbacks.get(0));
                        if (continuation != null) addFact(facts, factKeys, multiplicities, unsupported,
                            "cfg_edge", node, returnOwner, continuation, "continue", null);
                    } else {
                        unsupported.put(node.id(), Boolean.TRUE);
                        addTaint(facts, factKeys, multiplicities, unsupported,
                            node, returnOwner.id(), node.id(),
                            callbacks.isEmpty() ? "unknown_control" : "ambiguous");
                    }
                }
            } else if (node.kind() == PsiIndex.NodeKind.TRY) {
                seedTryFlow(node, owner, facts, factKeys, multiplicities, unsupported);
            } else if (node.kind() == PsiIndex.NodeKind.WHEN) {
                seedWhenFlow(node, owner, facts, factKeys, multiplicities, unsupported);
            } else if (node.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
                PsiIndex.Node receiver = one(node, PsiIndex.EdgeRole.RECEIVER);
                PsiIndex.Node selector = one(node, PsiIndex.EdgeRole.SELECTOR);
                PsiIndex.Node continuation = safeMergeBoundary(node);
                if (receiver != null && selector != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", receiver, owner, selector, "true", null);
                if (receiver != null && continuation != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", receiver, owner, continuation, "false", null);
                PsiIndex.Node selectorExit = normalExit(selector);
                if (selectorExit != null && continuation != null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", selectorExit, owner, continuation, "fallthrough", null);
            } else if (node.kind() == PsiIndex.NodeKind.BINARY
                    && ("&&".equals(node.value()) || "||".equals(node.value()))) {
                PsiIndex.Node left = one(node, PsiIndex.EdgeRole.LEFT);
                PsiIndex.Node right = one(node, PsiIndex.EdgeRole.RIGHT);
                PsiIndex.Node continuation = nextBoundary(node);
                if (left != null && right != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", left, owner, right, "&&".equals(node.value()) ? "true" : "false", null);
                if (left != null && continuation != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", left, owner, continuation, "&&".equals(node.value()) ? "false" : "true", null);
                PsiIndex.Node rightExit = normalExit(right);
                if (rightExit != null && continuation != null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", rightExit, owner, continuation, "fallthrough", null);
            } else if (node.kind() == PsiIndex.NodeKind.BINARY && "?:".equals(node.value())) {
                PsiIndex.Node left = one(node, PsiIndex.EdgeRole.LEFT);
                PsiIndex.Node right = one(node, PsiIndex.EdgeRole.RIGHT);
                PsiIndex.Node continuation = nextBoundary(node);
                if (left == null || right == null) {
                    unsupported.put(node.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), node.id(), "unknown_control");
                    continue;
                }
                if (continuation != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", left, owner, continuation, "true", null);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", left, owner, firstBoundary(right), "false", null);
                PsiIndex.Node rightExit = normalExit(right);
                if (rightExit != null && continuation != null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "cfg_edge", rightExit, owner, continuation, "fallthrough", null);
                addWitnessOwner(facts, factKeys, multiplicities, unsupported,
                    node, owner, nearestWitnessOwner(node), "elvis");
            }
        }
    }

    private boolean isFinallyProtectedExit(PsiIndex.Node exit, PsiIndex.Node callable) {
        for (PsiIndex.Node attempt : program.nodes()) {
            if (attempt.kind() != PsiIndex.NodeKind.TRY
                    || enclosingCallable(attempt) != callable) continue;
            PsiIndex.Node body = one(attempt, PsiIndex.EdgeRole.TRY_BODY);
            List<PsiIndex.Node> catches = targets(attempt, PsiIndex.EdgeRole.CATCH_CLAUSE);
            if (finallyBlock(attempt, body, catches) == null) continue;
            if (body != null && isWithin(exit, body)) return true;
            for (PsiIndex.Node clause : catches) {
                if (isWithin(exit, clause)) return true;
            }
        }
        return false;
    }

    private PsiIndex.Node safeMergeBoundary(PsiIndex.Node qualified) {
        Integer ownerId = qualified == null ? null : lexicalOwners.get(qualified.id());
        if (ownerId != null) {
            PsiIndex.Node owner = program.node(ownerId);
            if (owner.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                    && isTarget(owner, PsiIndex.EdgeRole.RECEIVER, qualified)) return qualified;
        }
        return nextBoundary(qualified);
    }

    private void seedWhenFlow(PsiIndex.Node choice, PsiIndex.Node owner,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        List<PsiIndex.Node> entries = targets(choice, PsiIndex.EdgeRole.ENTRY);
        PsiIndex.Node continuation = nextBoundary(choice);
        PsiIndex.Node subject = one(choice, PsiIndex.EdgeRole.SUBJECT);
        if (entries.isEmpty()) {
            unsupported.put(choice.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                choice, owner == null ? -1 : owner.id(), choice.id(), "unknown_control");
            return;
        }
        List<PsiIndex.Node> boundaries = new ArrayList<>();
        for (int index = 0; index < entries.size(); index++) {
            PsiIndex.Node entry = entries.get(index);
            List<PsiIndex.Node> conditions = targets(entry, PsiIndex.EdgeRole.CONDITION);
            boolean lastElse = conditions.isEmpty() && index + 1 == entries.size();
            if ((!lastElse && conditions.size() != 1) || conditions.isEmpty() && !lastElse) {
                unsupported.put(choice.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    choice, owner == null ? -1 : owner.id(), entry.id(), "unknown_control");
                return;
            }
            boundaries.add(lastElse ? entry : conditions.get(0));
        }
        if (subject != null) addFact(facts, factKeys, multiplicities, unsupported,
            "cfg_edge", subject, owner, boundaries.get(0), "fallthrough", null);
        for (int index = 0; index < entries.size(); index++) {
            PsiIndex.Node entry = entries.get(index);
            PsiIndex.Node boundary = boundaries.get(index);
            PsiIndex.Node body = one(entry, PsiIndex.EdgeRole.BODY);
            if (body == null) {
                unsupported.put(choice.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    choice, owner == null ? -1 : owner.id(), entry.id(), "unknown_control");
                return;
            }
            addFact(facts, factKeys, multiplicities, unsupported,
                "cfg_edge", boundary, owner, firstBoundary(body), "true", null);
            if (index + 1 < entries.size()) addFact(facts, factKeys, multiplicities, unsupported,
                "cfg_edge", boundary, owner, boundaries.get(index + 1), "false", null);
            PsiIndex.Node exit = normalExit(body);
            if (exit != null && continuation != null) addFact(facts, factKeys, multiplicities, unsupported,
                "cfg_edge", exit, owner, continuation, "fallthrough", null);
        }
    }

    private void seedTryFlow(PsiIndex.Node attempt, PsiIndex.Node owner,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        PsiIndex.Node body = one(attempt, PsiIndex.EdgeRole.TRY_BODY);
        List<PsiIndex.Node> catches = targets(attempt, PsiIndex.EdgeRole.CATCH_CLAUSE);
        PsiIndex.Node finallyBlock = finallyBlock(attempt, body, catches);
        PsiIndex.Node continuation = nextBoundary(attempt);
        if (body == null) return;
        if (containsToken(attempt, "finally") && finallyBlock == null) {
            unsupported.put(attempt.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                attempt, owner == null ? -1 : owner.id(), attempt.id(), "unknown_control");
            return;
        }
        PsiIndex.Node bodyExit = normalExit(body);
        PsiIndex.Node normalTarget = finallyBlock == null ? continuation : finallyBlock;
        boolean bodyThrows = containsThrowToken(body, List.of());
        if (bodyExit != null && normalTarget != null && !bodyThrows) addFact(
            facts, factKeys, multiplicities, unsupported,
            "cfg_edge", bodyExit, owner, normalTarget, finallyBlock == null ? "fallthrough" : "finally", null);
        if (!catches.isEmpty()) addFact(facts, factKeys, multiplicities, unsupported,
            "cfg_edge", firstBoundary(body), owner, catches.get(0), "catch", null);
        for (int index = 0; index < catches.size(); index++) {
            PsiIndex.Node clause = catches.get(index);
            PsiIndex.Node catchBody = one(clause, PsiIndex.EdgeRole.CATCH_BODY);
            if (catchBody != null) addFact(facts, factKeys, multiplicities, unsupported,
                "cfg_edge", clause, owner, firstBoundary(catchBody), "true", null);
            if (index + 1 < catches.size()) addFact(facts, factKeys, multiplicities, unsupported,
                "cfg_edge", clause, owner, catches.get(index + 1), "false", null);
            PsiIndex.Node exit = catchBody == null ? null : normalExit(catchBody);
            boolean catchThrows = catchBody != null && containsThrowToken(catchBody, List.of());
            if (exit != null && normalTarget != null && !catchThrows) addFact(
                facts, factKeys, multiplicities, unsupported,
                "cfg_edge", exit, owner, normalTarget, finallyBlock == null ? "fallthrough" : "finally", null);
        }
        if (finallyBlock != null && continuation != null) {
            PsiIndex.Node exit = normalExit(finallyBlock);
            if (exit != null) addFact(facts, factKeys, multiplicities, unsupported,
                "cfg_edge", exit, owner, continuation, "fallthrough", null);
        }
        if (finallyBlock != null && hasAbruptTryExit(attempt, body, catches, owner)) {
            unsupported.put(attempt.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                attempt, owner == null ? -1 : owner.id(), attempt.id(), "unknown_control");
        }
        if (containsThrowToken(body, catches)) {
            unsupported.put(attempt.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                attempt, owner == null ? -1 : owner.id(), attempt.id(), "unknown_control");
        }
    }

    private boolean hasAbruptTryExit(PsiIndex.Node attempt, PsiIndex.Node body,
            List<PsiIndex.Node> catches, PsiIndex.Node owner) {
        for (PsiIndex.Node node : program.nodes()) {
            boolean inProtectedRegion = isWithin(node, body);
            for (PsiIndex.Node clause : catches) inProtectedRegion |= isWithin(node, clause);
            if (!inProtectedRegion || enclosingCallable(node) != owner) continue;
            if (node.kind() == PsiIndex.NodeKind.RETURN || node.kind() == PsiIndex.NodeKind.BREAK
                    || node.kind() == PsiIndex.NodeKind.CONTINUE) return true;
        }
        return false;
    }

    private boolean containsThrowToken(PsiIndex.Node body, List<PsiIndex.Node> catches) {
        for (PsiIndex.Token token : program.tokens()) {
            if (token.kind() != PsiIndex.TokenKind.KEYWORD || !token.value().equals("throw")) continue;
            if (token.fileId() == body.fileId() && token.startUtf16() >= body.startUtf16()
                    && token.endUtf16() <= body.endUtf16()) return true;
            for (PsiIndex.Node clause : catches) {
                if (token.fileId() == clause.fileId() && token.startUtf16() >= clause.startUtf16()
                        && token.endUtf16() <= clause.endUtf16()) return true;
            }
        }
        return false;
    }

    private void addWitnessOwner(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported,
            PsiIndex.Node syntax, PsiIndex.Node owner, PsiIndex.Node witnessOwner, String value) {
        if (syntax.witnessNodeId() == null && witnessOwner != null && witnessOwner.witnessNodeId() != null) {
            addFact(facts, factKeys, multiplicities, unsupported,
                "witness_owner", syntax, owner, witnessOwner, value, null);
        }
    }

    private void seedFunctionBindings(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.PROPERTY_DECL || node.name() == null
                    || !node.flags().contains(PsiIndex.NodeFlag.VAL)) continue;
            PsiIndex.Node value = one(node, PsiIndex.EdgeRole.INITIALIZER);
            if (value == null) continue;
            PsiIndex.Node summary = value.kind() == PsiIndex.NodeKind.LAMBDA ? value
                : value.kind() == PsiIndex.NodeKind.CALLABLE_REF ? uniqueReferencedCallable(value) : null;
            if (value.kind() == PsiIndex.NodeKind.CALLABLE_REF && summary == null
                    && referencedCallableCount(value) > 1) {
                unsupported.put(value.id(), Boolean.TRUE);
                PsiIndex.Node owner = enclosingCallable(value);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    value, owner == null ? -1 : owner.id(), value.id(), "ambiguous");
                continue;
            }
            PsiIndex.Node mutableCapture = summary == null ? null : mutableCaptureOrigin(summary);
            if (mutableCapture != null) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "escape", summary, enclosingCallable(node), mutableCapture, "mutable_capture", null);
                continue;
            }
            if (summary == null || functionBindingEscapes(node, value, facts)) continue;
            addFact(facts, factKeys, multiplicities, unsupported,
                "function_binding", node, enclosingCallable(node), summary,
                value.kind() == PsiIndex.NodeKind.LAMBDA ? "lambda" : "callable_reference", null);
        }
        for (PsiIndex.Node parameter : program.nodes()) {
            if (parameter.kind() != PsiIndex.NodeKind.PARAMETER_DECL
                    || !"callable".equals(declaredSemanticType(parameter))) continue;
            PsiIndex.Node declaration = enclosingCallable(parameter);
            if (declaration == null || declaration.kind() != PsiIndex.NodeKind.FUNCTION_DECL) continue;
            int position = targets(declaration, PsiIndex.EdgeRole.PARAMETER).indexOf(parameter);
            PsiIndex.Node summary = null;
            String bindingKind = null;
            boolean ambiguous = false;
            for (PsiIndex.Node call : program.nodes()) {
                if (call.kind() != PsiIndex.NodeKind.CALL || !declaration.name().equals(call.name())) continue;
                Map<Integer, List<PsiIndex.Node>> mapped = mapSourceArguments(call, declaration, facts);
                List<PsiIndex.Node> arguments = mapped == null ? null : mapped.get(position);
                if (arguments == null || arguments.size() != 1) continue;
                PsiIndex.Node value = argumentValue(arguments.get(0));
                PsiIndex.Node candidate = value.kind() == PsiIndex.NodeKind.LAMBDA ? value
                    : value.kind() == PsiIndex.NodeKind.CALLABLE_REF ? uniqueReferencedCallable(value) : null;
                if (candidate == null || summary != null && summary.id() != candidate.id()) {
                    ambiguous = true;
                    break;
                }
                summary = candidate;
                bindingKind = value.kind() == PsiIndex.NodeKind.LAMBDA ? "lambda" : "callable_reference";
            }
            if (!ambiguous && summary != null) addFact(facts, factKeys, multiplicities, unsupported,
                "function_binding", parameter, declaration, summary, bindingKind, null);
        }
        removeBoundFunctionReferenceTypes(facts, factKeys, multiplicities);
    }

    private void removeBoundFunctionReferenceTypes(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities) {
        for (int index = facts.size() - 1; index >= 0; index--) {
            Map<String, Object> fact = facts.get(index);
            if (!"type".equals(fact.get("kind")) || !"callable".equals(fact.get("value"))) continue;
            PsiIndex.Node subject = program.node(((Long) fact.get("subjectNodeId")).intValue());
            if (subject == null || subject.kind() != PsiIndex.NodeKind.NAME_REF) continue;
            PsiIndex.Node binding = relatedNodeForFact(facts, "def_use", subject.id());
            if (binding == null || !hasFact(facts, "function_binding", binding.id())) continue;
            factKeys.remove(Protocol.canonicalJson(fact));
            multiplicities.remove("type\n" + subject.id());
            facts.remove(index);
        }
    }

    private PsiIndex.Node mutableCaptureOrigin(PsiIndex.Node summary) {
        if (summary == null || summary.kind() != PsiIndex.NodeKind.LAMBDA) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node use : program.nodes()) {
            if (use.kind() != PsiIndex.NodeKind.NAME_REF || !isWithin(use, summary)) continue;
            PsiIndex.Node captured = findLexicalDeclaration(use, use.name());
            if (captured == null || isWithin(captured, summary)
                    || !captured.flags().contains(PsiIndex.NodeFlag.VAR)) continue;
            if (match != null && match.id() != captured.id()) return null;
            match = captured;
        }
        return match;
    }

    private int referencedCallableCount(PsiIndex.Node reference) {
        if (reference == null || reference.name() == null) return 0;
        int count = 0;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !reference.name().equals(candidate.name())) continue;
            if (candidate.fileId() == reference.fileId()
                    || program.file(candidate.fileId()).packageName().equals(
                        program.file(reference.fileId()).packageName())) count++;
        }
        return count;
    }

    private boolean functionBindingEscapes(PsiIndex.Node binding, PsiIndex.Node summary,
            List<Map<String, Object>> facts) {
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
                PsiIndex.Node target = one(node, PsiIndex.EdgeRole.TARGET);
                if (target != null && binding.name().equals(target.name())
                        && enclosingCallable(node) == enclosingCallable(binding)) return true;
            }
            if (node.kind() == PsiIndex.NodeKind.CALL && !hasCallableAuthority(node)) {
                for (PsiIndex.Node argument : uniqueTargets(node, PsiIndex.EdgeRole.ARGUMENT)) {
                    PsiIndex.Node value = argumentValue(argument);
                    if (value == null || value.kind() != PsiIndex.NodeKind.NAME_REF
                            || !binding.name().equals(value.name())) continue;
                    PsiIndex.Node declaration = findLexicalDeclaration(value, value.name());
                    if (declaration != null && declaration.id() == binding.id()) return true;
                }
            }
            if (summary.kind() == PsiIndex.NodeKind.LAMBDA && node.kind() == PsiIndex.NodeKind.NAME_REF
                    && isWithin(node, summary)) {
                PsiIndex.Node captured = findLexicalDeclaration(node, node.name());
                if (captured != null && !isWithin(captured, summary)
                        && captured.flags().contains(PsiIndex.NodeFlag.VAR)) return true;
            }
        }
        return false;
    }

    private void seedEscapes(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            PsiIndex.Node owner = enclosingCallable(node);
            if (node.kind() == PsiIndex.NodeKind.CALL && !hasCallableAuthority(node)) {
                PsiIndex.Node escaped = null;
                for (PsiIndex.Node argument : uniqueTargets(node, PsiIndex.EdgeRole.ARGUMENT)) {
                    PsiIndex.Node origin = unknownCallEscapeOrigin(
                        argumentValue(argument), facts);
                    if (origin == null) continue;
                    if (escaped != null && escaped.id() != origin.id()) {
                        escaped = null;
                        break;
                    }
                    escaped = origin;
                }
                if (escaped != null) {
                    String category = "callable".equals(typeOf(facts, escaped))
                        ? "argument" : "unknown_call";
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "escape", node, owner, escaped, category, null);
                    unsupported.put(node.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), node.id(), "escape");
                }
            } else if (node.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
                PsiIndex.Node target = one(node, PsiIndex.EdgeRole.TARGET);
                PsiIndex.Node value = one(node, PsiIndex.EdgeRole.VALUE);
                PsiIndex.Node targetDeclaration = target == null ? null
                    : findLexicalDeclaration(target, target.name());
                PsiIndex.Node origin = localValueOrigin(value, facts);
                if (targetDeclaration != null && origin != null && owner != null
                        && enclosingCallable(targetDeclaration) == null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "escape", node, owner, origin, "property", null);
            } else if (node.kind() == PsiIndex.NodeKind.RETURN) {
                PsiIndex.Node origin = localValueOrigin(one(node, PsiIndex.EdgeRole.RETURN_VALUE), facts);
                if (origin != null && owner != null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "escape", node, owner, origin, "return", null);
            }
        }
    }

    private PsiIndex.Node unknownCallEscapeOrigin(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        PsiIndex.Node local = localValueOrigin(value, facts);
        if (local != null) return local;
        PsiIndex.Node declaration = value;
        if (value != null && value.kind() == PsiIndex.NodeKind.NAME_REF
                && value.name() != null) {
            declaration = relatedNodeForFact(facts, "def_use", value.id());
            if (declaration == null) {
                declaration = findLexicalDeclaration(value, value.name());
            }
        } else if (value != null && (value.kind() == PsiIndex.NodeKind.QUALIFIED
                || value.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED)) {
            declaration = stateQualifiedAuthorityProperty(value, facts);
        }
        return declaration != null
                && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                && isProductionPath(declaration.fileId())
                && declaration.flags().contains(PsiIndex.NodeFlag.VAL)
                && !declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                && authorityOwner(declaration) != null
            ? declaration : null;
    }

    private boolean hasCallableAuthority(PsiIndex.Node call) {
        if (call == null || call.name() == null) return true;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if ((symbol.kind().equals("constructor") || symbol.kind().endsWith("function"))
                    && terminalFqnName(symbol.fqn()).equals(call.name())) return true;
        }
        for (PsiIndex.Node declaration : program.nodes()) {
            if (declaration.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    && call.name().equals(declaration.name())) return true;
        }
        return false;
    }

    private PsiIndex.Node localValueOrigin(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null) return null;
        PsiIndex.Node origin = relatedNodeForFact(facts, "def_use", value.id());
        if (origin == null && value.kind() == PsiIndex.NodeKind.NAME_REF) {
            origin = findLexicalDeclaration(value, value.name());
        }
        if (origin == null && value.kind() == PsiIndex.NodeKind.PROPERTY_DECL) origin = value;
        if (origin == null || origin.kind() != PsiIndex.NodeKind.PROPERTY_DECL) return null;
        return enclosingCallable(origin) == null ? null : origin;
    }

    private PsiIndex.Node escapedOrigin(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        PsiIndex.Node origin = localValueOrigin(value, facts);
        if (origin == null) return null;
        for (Map<String, Object> fact : facts) {
            if (!"escape".equals(fact.get("kind"))) continue;
            if (((Long) fact.get("relatedNodeId")).intValue() == origin.id()) return origin;
        }
        return null;
    }

    private boolean exactRetainedReadinessEscape(PsiIndex.Node call,
            PsiIndex.Node receiver, List<Map<String, Object>> facts) {
        if (call == null || receiver == null || !"isNotEmpty".equals(call.name())
                || !uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT).isEmpty()
                || receiver.kind() != PsiIndex.NodeKind.NAME_REF) return false;
        PsiIndex.Node origin = localValueOrigin(receiver, facts);
        if (origin == null || !origin.flags().contains(PsiIndex.NodeFlag.VAL)
                || origin.flags().contains(PsiIndex.NodeFlag.VAR)
                || !"plane_anchor_collection".equals(typeOf(facts, receiver))
                || exactCollectionProducerOrigin(receiver, facts) == null) return false;
        PsiIndex.Node branch = conditionOwner(call);
        PsiIndex.Node loop = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.FOR
                    && candidate.kind() != PsiIndex.NodeKind.WHILE
                    || !isWithin(call, candidate)) continue;
            if (loop != null && loop.id() != candidate.id()) return false;
            loop = candidate;
        }
        PsiIndex.Node success = loop == null
            ? null : relatedNodeForFact(facts, "loop_success", loop.id());
        PsiIndex.Node thenBranch = branch == null
            ? null : one(branch, PsiIndex.EdgeRole.THEN_BRANCH);
        if (branch == null || branch.kind() != PsiIndex.NodeKind.IF
                || success == null || thenBranch == null
                || success.id() != thenBranch.id() && !isWithin(success, thenBranch)) return false;
        PsiIndex.Node assignment = null;
        for (Map<String, Object> fact : facts) {
            if (!"escape".equals(fact.get("kind"))
                    || !Long.valueOf(origin.id()).equals(fact.get("relatedNodeId"))) continue;
            if (!"property".equals(fact.get("value"))) return false;
            PsiIndex.Node candidate = program.node(
                ((Long) fact.get("subjectNodeId")).intValue());
            if (candidate.kind() != PsiIndex.NodeKind.ASSIGNMENT
                    || assignment != null && assignment.id() != candidate.id()) return false;
            assignment = candidate;
        }
        PsiIndex.Node targetDeclaration = assignment == null
            ? null : planeAssignmentTargetDeclaration(assignment, facts);
        PsiIndex.Node value = assignment == null
            ? null : one(assignment, PsiIndex.EdgeRole.VALUE);
        PsiIndex.Node retained = loop == null || success == null ? null
            : planeRetryRetainedExit(loop, success, facts);
        if (retained == null && loop != null && success != null) {
            retained = planeRetryRetainedCandidate(loop, success, facts);
        }
        if (assignment == null || !isWithin(assignment, loop)
                || localValueOrigin(value, facts) != origin
                || targetDeclaration == null
                || !targetDeclaration.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || !targetDeclaration.flags().contains(PsiIndex.NodeFlag.VAR)
                || !"plane_anchor".equals(
                    declaredCollectionElementType(targetDeclaration, facts))) return false;
        PsiIndex.Node callable = enclosingFunctionDeclaration(loop);
        PsiIndex.Node targetType = enclosingTypeDeclaration(targetDeclaration);
        return callable != null && targetType != null
            && enclosingTypeDeclaration(callable) == targetType
            && retained == assignment
            && lexicalPredecessor(branch, loop) == assignment;
    }

    private void resolveCalls(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (int pass = 0; pass < 8; pass++) {
            int priorSize = facts.size();
            propagateInferredTypes(facts, factKeys, multiplicities, unsupported);
            for (PsiIndex.Node call : program.nodes()) {
                if (call.kind() != PsiIndex.NodeKind.CALL || call.name() == null) continue;
                resolveOneCall(call, facts, factKeys, multiplicities, unsupported);
            }
            resolveProperties(facts, factKeys, multiplicities, unsupported);
            resolveSourceProperties(facts, factKeys, multiplicities, unsupported);
            seedPrimitiveFlow(facts, factKeys, multiplicities, unsupported);
            resolveSyntheticOperators(facts, factKeys, multiplicities, unsupported);
            promoteCallbacks(facts, factKeys, multiplicities, unsupported);
            applyReachableDomainEffects(facts, factKeys, multiplicities, unsupported);
            applyReachableSourceEffects(facts, factKeys, multiplicities, unsupported);
            if (facts.size() == priorSize) break;
        }
    }

    private void seedUnresolvedCallFailures(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL
                    || !factBoolean(facts, "reachable", call.id())
                    || hasFact(facts, "call_resolution", call.id())
                    || hasFact(facts, "taint", call.id())
                    || hasCallableAuthority(call)) continue;
            unsupported.put(call.id(), Boolean.TRUE);
            PsiIndex.Node owner = enclosingCallable(call);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "unsupported");
        }
    }

    private void resolveOneCall(PsiIndex.Node call, List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        PsiIndex.Node explicitReceiver = resolvedReceiver(call);
        PsiIndex.Node callee = one(call, PsiIndex.EdgeRole.CALLEE);
        PsiIndex.Node receiverEscape = escapedOrigin(explicitReceiver, facts);
        boolean retainedReadiness = receiverEscape != null
            && exactRetainedReadinessEscape(call, explicitReceiver, facts);
        if (retainedReadiness) clearFailureValues(
            facts, factKeys, multiplicities, unsupported, call, List.of("escape"));
        if ((receiverEscape != null && !retainedReadiness)
                || escapedOrigin(callee, facts) != null) {
            unsupported.put(call.id(), Boolean.TRUE);
            PsiIndex.Node owner = enclosingCallable(call);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "escape");
            PsiIndex.Node callbackValue = uniqueMappedCallbackValue(call, facts);
            if (callbackValue != null) {
                unsupported.put(callbackValue.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    callbackValue, owner == null ? -1 : owner.id(), call.id(), "escape");
            }
            return;
        }
        if (hasFact(facts, "call_resolution", call.id())) {
            if ("function_value".equals(factValue(facts, "call_resolution", call.id()))) {
                PsiIndex.Node bound = relatedNodeForFact(facts, "call_resolution", call.id());
                if (bound != null) {
                    bindFunctionInvocation(call, bound, facts, factKeys, multiplicities, unsupported);
                    applyFunctionValueResult(call, bound, facts, factKeys, multiplicities, unsupported);
                }
                return;
            }
            Rules.SymbolSpec resolved = symbolForFact(facts, "call_resolution", call.id());
            if (resolved != null) {
                Map<Integer, List<PsiIndex.Node>> rebound = mapDomainArguments(call, resolved, facts);
                if (rebound != null) {
                    PsiIndex.Node reboundReceiver = resolvedReceiver(call);
                    if (reboundReceiver == null && !resolved.receiverKind().equals("none")) {
                        reboundReceiver = implicitReceiver(call, resolved, facts);
                    }
                    bindDomainArguments(call, resolved, rebound, reboundReceiver,
                        facts, factKeys, multiplicities, unsupported);
                    applyDomainResult(call, resolved, rebound, reboundReceiver,
                        facts, factKeys, multiplicities, unsupported);
                }
            }
            return;
        }
        PsiIndex.Node owner = enclosingCallable(call);
        List<PsiIndex.Node> sourceCandidates = sourceCallableCandidates(call, facts);
        List<PsiIndex.Node> ordinaryDeclarations = new ArrayList<>();
        List<PsiIndex.Node> ordinarySources = new ArrayList<>();
        List<PsiIndex.Node> extensionSources = new ArrayList<>();
        for (PsiIndex.Node declaration : sourceCandidates) {
            boolean sourceExtension = declarationTypeNode(declaration, true) != null;
            Integer declarationOwnerId = lexicalOwners.get(declaration.id());
            PsiIndex.Node declarationOwner = declarationOwnerId == null
                ? null : program.node(declarationOwnerId);
            boolean sourceMember = isTypeDeclaration(declarationOwner);
            if (explicitReceiver != null && !sourceExtension && !sourceMember) continue;
            if (!sourceExtension) ordinaryDeclarations.add(declaration);
            if (mapSourceArguments(call, declaration, facts) == null) continue;
            if (!sourceExtension) ordinarySources.add(declaration);
            else extensionSources.add(declaration);
        }
        if (ordinarySources.size() == 1) {
            resolveSourceCall(call, ordinarySources.get(0), false,
                facts, factKeys, multiplicities, unsupported);
            return;
        } else if (ordinarySources.size() > 1) {
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "ambiguous");
            return;
        }
        if (!ordinaryDeclarations.isEmpty()) {
            boolean ambiguous = ordinaryDeclarations.size() > 1
                || sourceTrailingCallbackPositionCount(
                    call, ordinaryDeclarations.get(0), facts) > 1;
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(),
                ambiguous ? "ambiguous" : "unsupported");
            return;
        }

        PsiIndex.Node functionValue = functionValueDeclaration(call, facts);
        if (functionValue != null) {
            PsiIndex.Node bound = relatedNodeForFact(facts, "function_binding", functionValue.id());
            Rules.SymbolSpec invoke = domainSymbolOrNull("kotlin.Function0.invoke", "invoke(): R");
            if (bound != null && invoke != null && targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT).isEmpty()
                    && functionInvocationMatches(call, bound, facts)) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "call_resolution", call, owner, bound, "function_value", null);
                bindFunctionInvocation(call, bound, facts, factKeys, multiplicities, unsupported);
                if (factBoolean(facts, "reachable", call.id())) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "reachable", bound, bound, call, "immediate_inline", invoke);
                    markLexicallyReachable(bound, bound, "immediate_inline",
                        facts, factKeys, multiplicities, unsupported);
                }
                applyFunctionValueResult(call, bound, facts, factKeys, multiplicities, unsupported);
                return;
            }
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(),
                functionValueFailure(functionValue, facts));
            return;
        }

        if (hasAmbiguousImport(call.fileId(), call.name())) {
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "ambiguous");
            return;
        }
        if (qualifiedParent(call) == null && isHiddenByAlias(call.fileId(), call.name())) {
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "unsupported");
            return;
        }

        List<Rules.SymbolSpec> candidates = domainCandidates(call, facts);
        List<Rules.SymbolSpec> accepted = new ArrayList<>();
        List<Rules.SymbolSpec> potential = new ArrayList<>();
        boolean receiverCandidateSeen = false;
        boolean onlyReceiverCandidates = !candidates.isEmpty();
        for (Rules.SymbolSpec candidate : candidates) {
            if ("none".equals(candidate.receiverKind())) onlyReceiverCandidates = false;
            if (!receiverMatches(call, candidate, facts)) continue;
            receiverCandidateSeen = true;
            if (mapDomainArguments(call, candidate, facts, true) != null) potential.add(candidate);
            if (mapDomainArguments(call, candidate, facts) != null) accepted.add(candidate);
        }
        if (accepted.size() > 1) {
            int minimumOpaque = Integer.MAX_VALUE;
            for (Rules.SymbolSpec candidate : accepted) minimumOpaque = Math.min(
                minimumOpaque, opaqueBindingCount(call, candidate, facts));
            List<Rules.SymbolSpec> concrete = new ArrayList<>();
            for (Rules.SymbolSpec candidate : accepted) if (
                    opaqueBindingCount(call, candidate, facts) == minimumOpaque) concrete.add(candidate);
            accepted = concrete;
            boolean hasFixed = false;
            for (Rules.SymbolSpec candidate : accepted) if (variadicArgument(candidate) == null) hasFixed = true;
            if (hasFixed) {
                List<Rules.SymbolSpec> fixed = new ArrayList<>();
                for (Rules.SymbolSpec candidate : accepted) if (variadicArgument(candidate) == null) fixed.add(candidate);
                accepted = fixed;
            }
        }
        if (accepted.isEmpty() && potential.size() == 2) {
            unsupported.put(call.id(), Boolean.TRUE);
            replaceTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "ambiguous");
            return;
        }
        if (accepted.isEmpty() && extensionSources.size() == 1
                && sourceExtensionAllowed(call, extensionSources.get(0), candidates, facts)) {
            resolveSourceCall(call, extensionSources.get(0), true,
                facts, factKeys, multiplicities, unsupported);
            return;
        }
        if (accepted.isEmpty() && extensionSources.size() > 1) {
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "ambiguous");
            return;
        }
        if (accepted.size() != 1) {
            if (!candidates.isEmpty() || qualifiedParent(call) != null) {
                PsiIndex.Node dependent = qualifiedParent(call) != null
                    && qualifiedParent(call).kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                    ? qualifiedParent(call) : call;
                unsupported.put(dependent.id(), Boolean.TRUE);
                replaceTaint(facts, factKeys, multiplicities, unsupported,
                    dependent, owner == null ? -1 : owner.id(), call.id(),
                    accepted.size() > 1 ? "ambiguous"
                        : dependent.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                            && safeReceiverOriginPathCount(
                                one(dependent, PsiIndex.EdgeRole.RECEIVER), facts) > 1
                            ? "ambiguous"
                        : memberOwnerAmbiguous(call, candidates, facts) ? "ambiguous"
                        : receiverCandidateSeen ? "unsupported"
                        : onlyReceiverCandidates ? "unknown_receiver"
                        : qualifiedParent(call) != null ? "unknown_receiver" : "unsupported");
            }
            return;
        }
        Rules.SymbolSpec symbol = accepted.get(0);
        Map<Integer, List<PsiIndex.Node>> mapped = mapDomainArguments(call, symbol, facts);
        clearRecoverableCallFailure(facts, factKeys, multiplicities, unsupported, call);
        addFact(facts, factKeys, multiplicities, unsupported,
            "call_resolution", call, owner, -1, "domain", symbol);
        PsiIndex.Node receiver = resolvedReceiver(call);
        if (receiver != null && isDomainQualifier(receiver, symbol, facts)) addFact(
            facts, factKeys, multiplicities, unsupported,
            "implicit_receiver", call, owner, receiver, "domain_qualifier", symbol);
        if (receiver == null && !"none".equals(symbol.receiverKind())) {
            PsiIndex.Node implicit = implicitReceiver(call, symbol, facts);
            if (implicit != null) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "implicit_receiver", call, owner, implicit,
                    implicit.kind() == PsiIndex.NodeKind.LAMBDA
                        && hasFact(facts, "callback_receiver", implicit.id())
                        ? "callback"
                    : implicit.kind() == PsiIndex.NodeKind.CLASS_DECL
                        || implicit.kind() == PsiIndex.NodeKind.OBJECT_DECL
                        || implicit.kind() == PsiIndex.NodeKind.COMPANION_DECL
                        ? "source_dispatch" : "source_extension", symbol);
                receiver = implicit;
            }
        }
        PsiIndex.Node qualified = qualifiedParent(call);
        if (qualified != null && qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
            clearRecoverableCallFailure(
                facts, factKeys, multiplicities, unsupported, qualified);
        }
        if (qualified != null && qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) addFact(
            facts, factKeys, multiplicities, unsupported,
            "condition", qualified, qualified, receiver, "nonnull", null);
        addOwnerConformance(call, receiver, symbol,
            facts, factKeys, multiplicities, unsupported);
        bindDomainArguments(call, symbol, mapped, receiver, facts, factKeys, multiplicities, unsupported);
        applyDomainResult(call, symbol, mapped, receiver, facts, factKeys, multiplicities, unsupported);
        if (symbol.fqn().equals("kotlin.ranges.until")
                && symbol.signature().equals("Int.until(to: Int): IntRange")) addWitnessOwner(
            facts, factKeys, multiplicities, unsupported,
            call, owner, nearestWitnessOwner(call), "until");
        boolean accessorEffect = !symbol.effects().isEmpty()
            && enclosingAuthorityProperty(call) != null;
        if (factBoolean(facts, "reachable", call.id()) || accessorEffect) {
            applyEffects(call, symbol, mapped, receiver, facts, factKeys, multiplicities, unsupported);
        }
    }

    private int opaqueBindingCount(PsiIndex.Node call, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        Map<Integer, List<PsiIndex.Node>> mapped = mapDomainArguments(call, symbol, facts);
        if (mapped == null) return Integer.MIN_VALUE;
        int count = 0;
        for (Rules.ArgumentSpec spec : symbol.arguments()) {
            if (spec.abstractType().equals("opaque")) count += mapped.getOrDefault(
                spec.position(), List.of()).size();
        }
        return count;
    }

    private PsiIndex.Node uniqueMappedCallbackValue(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (Rules.SymbolSpec candidate : domainCandidates(call, facts)) {
            Map<Integer, List<PsiIndex.Node>> mapped = mapDomainArguments(call, candidate, facts);
            if (mapped == null) continue;
            for (Rules.CallbackSpec callback : candidate.callbacks()) {
                List<PsiIndex.Node> arguments = mapped.get(callback.argumentPosition());
                if (arguments == null || arguments.size() != 1) continue;
                PsiIndex.Node value = argumentValue(arguments.get(0));
                if (value == null) continue;
                if (match != null && match.id() != value.id()) return null;
                match = value;
            }
        }
        return match;
    }

    private void resolveSourceCall(PsiIndex.Node call, PsiIndex.Node declaration,
            boolean sourceExtension, List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        PsiIndex.Node owner = enclosingCallable(call);
        Map<Integer, List<PsiIndex.Node>> mapped = mapSourceArguments(call, declaration, facts);
        if (mapped == null) return;
        clearRecoverableCallFailure(facts, factKeys, multiplicities, unsupported, call);
        addFact(facts, factKeys, multiplicities, unsupported,
            "call_resolution", call, owner, declaration, "source", null);
        bindSourceArguments(call, declaration, mapped, facts, factKeys, multiplicities, unsupported);
        if (!sourceExtension) {
            PsiIndex.Node qualifier = sourceQualifierOrigin(
                resolvedReceiver(call), declaration, facts);
            if (qualifier != null) addFact(facts, factKeys, multiplicities, unsupported,
                "implicit_receiver", call, owner, qualifier, "source_qualifier", null);
        }
        if (sourceExtension) {
            PsiIndex.Node receiver = resolvedReceiver(call);
            if (receiver == null) receiver = implicitSourceReceiver(call, declaration, facts);
            Rules.SymbolSpec closed = physicalTypeForOrigin(receiver, facts);
            addFact(facts, factKeys, multiplicities, unsupported,
                "closed_member_absence", call, owner, receiver, call.name(), closed);
            if (resolvedReceiver(call) == null && receiver != null) addFact(
                facts, factKeys, multiplicities, unsupported,
                "implicit_receiver", call, owner, receiver, "source_extension", null);
        }
        String result = declaredSemanticType(declaration);
        if (result != null) addFact(facts, factKeys, multiplicities, unsupported,
            "type", call, owner, declaration, result, typeSymbolByAbstract(result));
        if (result != null && isNullableFact(facts, declaration)) addFact(
            facts, factKeys, multiplicities, unsupported,
            "nullable", call, owner, declaration, "true", null);
        PsiIndex.Node returnOrigin = sourceReturnOrigin(declaration);
        if (returnOrigin != null && result != null) addFact(facts, factKeys, multiplicities, unsupported,
            "return_origin", call, owner, returnOrigin, result, null);
    }

    private List<Rules.SymbolSpec> domainCandidates(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        List<Rules.SymbolSpec> result = new ArrayList<>();
        PsiIndex.Node qualified = qualifiedParent(call);
        PsiIndex.Node receiver = resolvedReceiver(call);
        String importedFqn = importedFqn(call.fileId(), call.name());
        boolean hiddenByAlias = isHiddenByAlias(call.fileId(), call.name());
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!(symbol.kind().equals("constructor") || symbol.kind().equals("top_level_function")
                    || symbol.kind().equals("member_function")
                    || symbol.kind().equals("extension_function"))
                    || symbol.operatorForm() != null) continue;
            String terminal = terminalFqnName(symbol.fqn());
            boolean explicit = importedFqn != null && (symbol.fqn().equals(importedFqn)
                || symbol.kind().equals("constructor") && symbol.fqn().equals(importedFqn));
            boolean unqualified = qualified == null && importedFqn == null && !hiddenByAlias
                && terminal.equals(call.name()) && isDefaultImported(symbol.fqn());
            boolean member = qualified != null && terminal.equals(call.name())
                && !"none".equals(symbol.receiverKind());
            boolean implicitMember = qualified == null && importedFqn == null
                && terminal.equals(call.name()) && !"none".equals(symbol.receiverKind());
            if (explicit || unqualified || member || implicitMember) result.add(symbol);
        }
        if (importedFqn != null) {
            List<Rules.SymbolSpec> exact = new ArrayList<>();
            for (Rules.SymbolSpec candidate : result) {
                if (candidate.fqn().equals(importedFqn)) exact.add(candidate);
            }
            return exact;
        }
        return result;
    }

    private void resolveProperties(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node access : program.nodes()) {
            if (access.kind() != PsiIndex.NodeKind.NAME_REF || access.name() == null
                    || hasFact(facts, "call_resolution", access.id())
                    || isCalleeOrTypeName(access) || hasFact(facts, "def_use", access.id())) continue;
            PsiIndex.Node qualified = qualifiedSelectorParent(access);
            PsiIndex.Node receiver = qualified == null ? null : one(qualified, PsiIndex.EdgeRole.RECEIVER);
            String imported = importedFqn(access.fileId(), access.name());
            if (hasAmbiguousImport(access.fileId(), access.name())) {
                unsupported.put(access.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    access, enclosingCallable(access) == null ? -1 : enclosingCallable(access).id(),
                    access.id(), "ambiguous");
                continue;
            }
            if (qualified == null && isHiddenByAlias(access.fileId(), access.name())) {
                unsupported.put(access.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    access, enclosingCallable(access) == null ? -1 : enclosingCallable(access).id(),
                    access.id(), "unsupported");
                continue;
            }
            List<Rules.SymbolSpec> accepted = new ArrayList<>();
            Map<Rules.SymbolSpec, PsiIndex.Node> acceptedReceivers = new HashMap<>();
            for (Rules.SymbolSpec symbol : domain.symbols()) {
                if (!(symbol.kind().equals("member_property")
                        || symbol.kind().equals("top_level_property"))) continue;
                boolean named = terminalFqnName(symbol.fqn()).equals(access.name());
                boolean exposed = symbol.kind().equals("member_property") ? named
                    : imported != null ? symbol.fqn().equals(imported)
                    : named && symbol.fqn().substring(0, symbol.fqn().lastIndexOf('.')).equals(
                        program.file(access.fileId()).packageName());
                if (!exposed) continue;
                if (symbol.kind().equals("top_level_property")) {
                    if (qualified == null) accepted.add(symbol);
                } else if (propertyReceiverMatches(qualified, receiver, symbol, facts)) {
                    accepted.add(symbol);
                    acceptedReceivers.put(symbol, receiver);
                } else if (qualified == null) {
                    PsiIndex.Node implicit = implicitReceiver(access, symbol, facts);
                    if (implicit != null) {
                        accepted.add(symbol);
                        acceptedReceivers.put(symbol, implicit);
                    }
                }
            }
            if (accepted.size() != 1) {
                if (!accepted.isEmpty() || imported != null || qualified != null) {
                    PsiIndex.Node dependent = qualified != null
                        && qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED ? qualified : access;
                    unsupported.put(dependent.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        dependent, enclosingCallable(access) == null ? -1 : enclosingCallable(access).id(),
                        access.id(), accepted.size() > 1 ? "ambiguous"
                            : dependent.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                                && safeReceiverOriginPathCount(receiver, facts) > 1
                                ? "ambiguous"
                            : memberPropertyOwnerAmbiguous(receiver, access.name(), facts) ? "ambiguous"
                            : qualified != null ? "unknown_receiver" : "unsupported");
                }
                continue;
            }
            Rules.SymbolSpec symbol = accepted.get(0);
            if (qualified == null && symbol.kind().equals("member_property")) {
                receiver = acceptedReceivers.get(symbol);
            }
            if (isCompositionLocalCurrent(symbol)
                    && !hasExactLocalSpatialNavigatorProducer(receiver, facts)) {
                unsupported.put(access.id(), Boolean.TRUE);
                PsiIndex.Node owner = enclosingCallable(access);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    access, owner == null ? -1 : owner.id(), access.id(), "unknown_return");
                continue;
            }
            PsiIndex.Node owner = enclosingCallable(access);
            clearRecoverableCallFailure(
                facts, factKeys, multiplicities, unsupported, access);
            addFact(facts, factKeys, multiplicities, unsupported,
                "call_resolution", access, owner, -1, "domain", symbol);
            if (receiver != null && isDomainQualifier(receiver, symbol, facts)) addFact(
                facts, factKeys, multiplicities, unsupported,
                "implicit_receiver", access, owner, receiver, "domain_qualifier", symbol);
            if (qualified == null && receiver != null && symbol.kind().equals("member_property")) addFact(
                facts, factKeys, multiplicities, unsupported,
                "implicit_receiver", access, owner, receiver,
                receiver.kind() == PsiIndex.NodeKind.LAMBDA
                    && hasFact(facts, "callback_receiver", receiver.id())
                    ? "callback"
                : receiver.kind() == PsiIndex.NodeKind.CLASS_DECL
                    || receiver.kind() == PsiIndex.NodeKind.OBJECT_DECL
                    || receiver.kind() == PsiIndex.NodeKind.COMPANION_DECL
                    ? "source_dispatch" : "source_extension", symbol);
            if (qualified != null && qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
                clearRecoverableCallFailure(
                    facts, factKeys, multiplicities, unsupported, qualified);
            }
            if (qualified != null && qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) addFact(
                facts, factKeys, multiplicities, unsupported,
                "condition", qualified, qualified, receiver, "nonnull", null);
            addOwnerConformance(access, receiver, symbol,
                facts, factKeys, multiplicities, unsupported);
            applyDomainResult(access, symbol, Map.of(), receiver,
                facts, factKeys, multiplicities, unsupported);
            PsiIndex.Node assignment = propertyAssignment(access);
            boolean compound = assignment != null && !"=".equals(assignment.value());
            if (factBoolean(facts, "reachable", access.id())
                    && (assignment == null || compound)) applyPropertyRead(
                access, symbol, receiver, facts, factKeys, multiplicities, unsupported);
        }
    }

    private PsiIndex.Node qualifiedSelectorParent(PsiIndex.Node selector) {
        Integer ownerId = lexicalOwners.get(selector.id());
        if (ownerId == null) return null;
        PsiIndex.Node owner = program.node(ownerId);
        if ((owner.kind() != PsiIndex.NodeKind.QUALIFIED
                && owner.kind() != PsiIndex.NodeKind.SAFE_QUALIFIED)
                || !isTarget(owner, PsiIndex.EdgeRole.SELECTOR, selector)) return null;
        return owner;
    }

    private boolean propertyReceiverMatches(PsiIndex.Node qualified, PsiIndex.Node receiver,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        if (qualified == null || receiver == null) return false;
        if (qualified.kind() == PsiIndex.NodeKind.QUALIFIED
                && nullableReceiverAtUse(facts, receiver, qualified)) return false;
        if (qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                && (!isNullableFact(facts, receiver)
                    || safeReceiverOriginPathCount(receiver, facts) != 1)) return false;
        return receiverTypeMatches(receiver, symbol, facts);
    }

    private void applyPropertyRead(PsiIndex.Node access, Rules.SymbolSpec symbol,
            PsiIndex.Node receiver, List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        if (!symbol.effects().contains("read")) {
            unsupported.put(access.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                access, enclosingCallable(access) == null ? -1 : enclosingCallable(access).id(),
                access.id(), "unknown_effect");
            return;
        }
        PsiIndex.Node target = receiver == null ? access : receiver;
        addFact(facts, factKeys, multiplicities, unsupported,
            "effect", access, enclosingCallable(access), target, "read", symbol);
        addFact(facts, factKeys, multiplicities, unsupported,
            "read", access, enclosingCallable(access), target, "", symbol);
    }

    private void resolveSourceProperties(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node access : program.nodes()) {
            if (access.kind() != PsiIndex.NodeKind.NAME_REF || access.name() == null
                    || hasFact(facts, "call_resolution", access.id())) continue;
            PsiIndex.Node qualified = qualifiedSelectorParent(access);
            if (qualified == null) continue;
            PsiIndex.Node receiver = one(qualified, PsiIndex.EdgeRole.RECEIVER);
            PsiIndex.Node sourceType = sourceTypeForValue(receiver, facts);
            PsiIndex.Node declaration = sourcePropertyDeclaration(sourceType, access.name());
            if (declaration == null) continue;
            PsiIndex.Node owner = enclosingCallable(access);
            if (qualified.kind() == PsiIndex.NodeKind.QUALIFIED
                    && nullableReceiverAtUse(facts, receiver, qualified)
                    || qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                        && (!isNullableFact(facts, receiver)
                            || safeReceiverOriginPathCount(receiver, facts) != 1)) {
                unsupported.put(qualified.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    qualified, owner == null ? -1 : owner.id(), access.id(),
                    safeReceiverOriginPathCount(receiver, facts) > 1
                        ? "ambiguous" : "unknown_receiver");
                continue;
            }
            String type = declaredSemanticType(declaration);
            if (type == null) continue;
            clearRecoverableCallFailure(
                facts, factKeys, multiplicities, unsupported, access);
            addFact(facts, factKeys, multiplicities, unsupported,
                "call_resolution", access, owner, declaration, "source", null);
            if (qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
                clearRecoverableCallFailure(
                    facts, factKeys, multiplicities, unsupported, qualified);
            }
            if (qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) addFact(
                facts, factKeys, multiplicities, unsupported,
                "condition", qualified, qualified, receiver, "nonnull", null);
            addFact(facts, factKeys, multiplicities, unsupported,
                "type", access, owner, sourceTypeDeclaration(declarationTypeNode(declaration, false)),
                type, typeSymbolByAbstract(type));
            addFact(facts, factKeys, multiplicities, unsupported,
                "origin", access, owner, declaration, "property", null);
            addFact(facts, factKeys, multiplicities, unsupported,
                "return_origin", access, owner, declaration, type, null);
            addFact(facts, factKeys, multiplicities, unsupported,
                "read", access, owner, receiver, "", null);
        }
    }

    private PsiIndex.Node sourcePropertyDeclaration(PsiIndex.Node sourceType, String name) {
        if (sourceType == null || name == null) return null;
        PsiIndex.Node match = null;
        List<PsiIndex.Node> members = new ArrayList<>(lexicalChildren(sourceType));
        for (PsiIndex.Node parameter : targets(sourceType, PsiIndex.EdgeRole.PARAMETER)) {
            if (!members.contains(parameter)) members.add(parameter);
        }
        for (PsiIndex.Node candidate : members) {
            boolean property = candidate.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                || candidate.kind() == PsiIndex.NodeKind.PARAMETER_DECL
                    && (candidate.flags().contains(PsiIndex.NodeFlag.VAL)
                        || candidate.flags().contains(PsiIndex.NodeFlag.VAR));
            if (!property || !name.equals(candidate.name())) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private boolean sourceExtensionAllowed(PsiIndex.Node call, PsiIndex.Node declaration,
            List<Rules.SymbolSpec> domainCandidates, List<Map<String, Object>> facts) {
        PsiIndex.Node receiver = resolvedReceiver(call);
        if (receiver == null) receiver = implicitSourceReceiver(call, declaration, facts);
        if (receiver == null) return false;
        String required = typeOf(facts, declarationTypeNode(declaration, true));
        if (compatibilityPathCount(typeOf(facts, receiver), required, receiver, facts) != 1) return false;
        Rules.SymbolSpec physical = physicalTypeForOrigin(receiver, facts);
        if (physical == null || !physical.closedMemberSet()) return false;
        for (Rules.SymbolSpec candidate : domainCandidates) {
            if (!candidate.kind().startsWith("member_") || !terminalFqnName(candidate.fqn()).equals(call.name())) continue;
            if (mapDomainArguments(call, candidate, facts) != null && receiverMatches(call, candidate, facts)) return false;
        }
        return call.name().matches("[A-Za-z_][A-Za-z0-9_]*");
    }

    private PsiIndex.Node implicitSourceReceiver(PsiIndex.Node call,
            PsiIndex.Node declaration, List<Map<String, Object>> facts) {
        String required = typeOf(facts, declarationTypeNode(declaration, true));
        Integer owner = lexicalOwners.get(call.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            String actual = candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                ? typeOf(facts, declarationTypeNode(candidate, true)) : typeOf(facts, candidate);
            if (compatibilityPathCount(actual, required, candidate, facts) == 1) return candidate;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private Map<Integer, List<PsiIndex.Node>> mapDomainArguments(PsiIndex.Node call,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        return mapDomainArguments(call, symbol, facts, false);
    }

    private Map<Integer, List<PsiIndex.Node>> mapDomainArguments(PsiIndex.Node call,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts, boolean allowUnknown) {
        List<PsiIndex.Node> arguments = uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT);
        Map<Integer, List<PsiIndex.Node>> mapped = new HashMap<>();
        int frontier = 0;
        int activeVariadic = -1;
        for (int argumentIndex = 0; argumentIndex < arguments.size(); argumentIndex++) {
            PsiIndex.Node argument = arguments.get(argumentIndex);
            PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
            if (value == null) return null;
            int position = -1;
            if (argument.flags().contains(PsiIndex.NodeFlag.NAMED)) {
                for (Rules.ArgumentSpec spec : symbol.arguments()) {
                    if (spec.name() != null && spec.name().equals(argument.name())) position = spec.position();
                }
                if (position < 0 || mapped.containsKey(position)) return null;
            } else if (isCallableValue(value, facts) && argumentIndex + 1 == arguments.size()) {
                List<Integer> callbackPositions = new ArrayList<>();
                for (Rules.CallbackSpec callback : symbol.callbacks()) {
                    int callbackPosition = callback.argumentPosition();
                    if (callbackPosition < frontier || mapped.containsKey(callbackPosition)
                            || !canSkipDomainArguments(symbol, mapped, frontier, callbackPosition)
                            || !argumentCompatible(call, value, symbol,
                                symbol.arguments().get(callbackPosition), facts, allowUnknown)) continue;
                    callbackPositions.add(callbackPosition);
                }
                if (callbackPositions.size() != 1) return null;
                position = callbackPositions.get(0);
            }
            if (position < 0) {
                if (activeVariadic >= 0) position = activeVariadic;
                else {
                    while (frontier < symbol.arguments().size() && mapped.containsKey(frontier)) frontier++;
                    if (frontier >= symbol.arguments().size()) return null;
                    position = frontier;
                    if (symbol.arguments().get(position).variadic()) {
                        activeVariadic = position;
                        frontier = position + 1;
                    } else frontier++;
                }
            }
            Rules.ArgumentSpec spec = symbol.arguments().get(position);
            if (!argumentCompatible(call, value, symbol, spec, facts, allowUnknown)) return null;
            List<PsiIndex.Node> values = mapped.computeIfAbsent(position, ignored -> new ArrayList<>());
            if (!spec.variadic() && !values.isEmpty()) return null;
            values.add(argument);
        }
        for (Rules.ArgumentSpec spec : symbol.arguments()) {
            if (!mapped.containsKey(spec.position()) && !spec.hasDefault() && !spec.variadic()) return null;
        }
        if (!typeArgumentsMatch(call, symbol, facts)) return null;
        return mapped;
    }

    private boolean canSkipDomainArguments(Rules.SymbolSpec symbol,
            Map<Integer, List<PsiIndex.Node>> mapped, int frontier, int target) {
        for (int position = frontier; position < target; position++) {
            if (mapped.containsKey(position)) continue;
            Rules.ArgumentSpec skipped = symbol.arguments().get(position);
            if (!skipped.hasDefault() && !skipped.variadic()) return false;
        }
        return true;
    }

    private boolean argumentCompatible(PsiIndex.Node call, PsiIndex.Node value,
            Rules.SymbolSpec symbol, Rules.ArgumentSpec spec, List<Map<String, Object>> facts) {
        return argumentCompatible(call, value, symbol, spec, facts, false);
    }

    private boolean argumentCompatible(PsiIndex.Node call, PsiIndex.Node value,
            Rules.SymbolSpec symbol, Rules.ArgumentSpec spec, List<Map<String, Object>> facts,
            boolean allowUnknown) {
        if (isNullLiteral(value)) return allowsNull(symbol, spec.position());
        String actual = typeOf(facts, value);
        if (actual == null && value.kind() == PsiIndex.NodeKind.NAME_REF) {
            PsiIndex.Node declaration = findLexicalDeclaration(value, value.name());
            actual = declaration == null ? null : typeOf(facts, declaration);
        }
        if (spec.abstractType().equals("callable") && isCallableValue(value, facts)) {
            actual = "callable";
        }
        if (spec.abstractType().equals("opaque")) return actual == null || !actual.equals("callable");
        if (actual == null) return allowUnknown;
        if (!compatibleType(actual, spec.abstractType(), value, facts)) return false;
        Rules.CallbackSpec callback = callbackAt(symbol, spec.position());
        if (callback != null && !callbackShapeCompatible(value, symbol, callback, facts)) return false;
        if (spec.samInterfaceFqn() != null && !(spec.samInterfaceFqn().equals(
                "com.pico.spatial.sense.base.AnchorUpdateSubscriber")
                && symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate")
                && symbol.signature().equals("subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable")
                && spec.position() == 0 && callback != null)) return false;
        return true;
    }

    private boolean callbackShapeCompatible(PsiIndex.Node value, Rules.SymbolSpec symbol,
            Rules.CallbackSpec callback, List<Map<String, Object>> facts) {
        if (value.kind() == PsiIndex.NodeKind.LAMBDA) {
            List<PsiIndex.Node> parameters = targets(value, PsiIndex.EdgeRole.PARAMETER);
            return parameters.size() == callback.parameters().size()
                || parameters.isEmpty() && callback.parameters().size() == 1 && implicitItAvailable(value);
        }
        if (value.kind() == PsiIndex.NodeKind.CALLABLE_REF) {
            return uniqueReferencedCallable(value) != null;
        }
        if (value.kind() == PsiIndex.NodeKind.NAME_REF) {
            PsiIndex.Node binding = findLexicalDeclaration(value, value.name());
            PsiIndex.Node target = binding == null ? null
                : relatedNodeForFact(facts, "function_binding", binding.id());
            if (target == null) return false;
            List<PsiIndex.Node> parameters = targets(target, PsiIndex.EdgeRole.PARAMETER);
            return parameters.size() == callback.parameters().size()
                || target.kind() == PsiIndex.NodeKind.LAMBDA && parameters.isEmpty()
                    && callback.parameters().size() == 1 && implicitItAvailable(target);
        }
        return false;
    }

    private boolean typeArgumentsMatch(PsiIndex.Node call, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> actual = targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT);
        if (actual.size() != symbol.typeArguments().size()) return false;
        for (int index = 0; index < actual.size(); index++) {
            String type = typeOf(facts, actual.get(index));
            PsiIndex.Node source = sourceTypeDeclaration(actual.get(index));
            if (type == null && source != null) type = declaredSemanticType(source);
            if (type == null || !compatibleType(type, symbol.typeArguments().get(index), actual.get(index), facts)) {
                return false;
            }
        }
        return true;
    }

    private void bindDomainArguments(PsiIndex.Node call, Rules.SymbolSpec symbol,
            Map<Integer, List<PsiIndex.Node>> mapped, PsiIndex.Node receiver,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (Rules.ArgumentSpec spec : symbol.arguments()) {
            for (PsiIndex.Node argument : mapped.getOrDefault(spec.position(), List.of())) {
                PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "argument_binding", argument, call, -1, Integer.toString(spec.position()), symbol);
                if (isNullLiteral(value) && allowsNull(symbol, spec.position())) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "nullable", value, enclosingCallable(call), argument, "true", symbol);
            }
        }
        for (PsiIndex.Node typeArgument : targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT)) {
            int index = targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT).indexOf(typeArgument);
            PsiIndex.Node declaration = sourceTypeDeclaration(typeArgument);
            addFact(facts, factKeys, multiplicities, unsupported,
                "type_argument", typeArgument, call, declaration,
                symbol.typeArguments().get(index), symbol);
        }
        for (Rules.CallbackSpec callback : symbol.callbacks()) {
            List<PsiIndex.Node> arguments = mapped.get(callback.argumentPosition());
            if (arguments == null || arguments.size() != 1) continue;
            PsiIndex.Node argument = arguments.get(0);
            PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
            if (value == null || !isCallableValue(value, facts)) continue;
            PsiIndex.Node executionTarget = callbackExecutionTarget(value, callback, symbol, facts);
            if (executionTarget == null || !callbackParameterTypesMatchInvocation(
                    value, executionTarget, callback, receiver, facts)) continue;
            clearFailureValues(facts, factKeys, multiplicities, unsupported,
                argument, List.of("limit"));
            addFact(facts, factKeys, multiplicities, unsupported,
                "callback_binding", value, call, argument, callback.role(), symbol);
            PsiIndex.Node callbackReceiver = callbackReceiverOrigin(callback, receiver, mapped, facts);
            Rules.SymbolSpec receiverPhysical = callback.receiverSource() == null
                ? callbackReceiverPhysical(symbol, callback)
                : physicalTypeForOrigin(callbackReceiver, facts);
            if (callbackReceiver == null && value.kind() == PsiIndex.NodeKind.CALLABLE_REF
                    && callback.receiverSource() == null
                    && callback.receiverAbstractType() != null) callbackReceiver = adaptedReceiverParameter(
                value, callback, facts);
            if (callback.receiverAbstractType() != null && receiverPhysical != null) addFact(
                facts, factKeys, multiplicities, unsupported,
                "callback_receiver", value, call, callbackReceiver,
                callback.receiverAbstractType(), receiverPhysical);
            PsiIndex.Node parameterOwner = value;
            List<PsiIndex.Node> parameters = targets(value, PsiIndex.EdgeRole.PARAMETER);
            if (value.kind() == PsiIndex.NodeKind.NAME_REF) {
                PsiIndex.Node target = callbackExecutionTarget(value, callback, symbol, facts);
                if (target != null) {
                    parameterOwner = target;
                    parameters = targets(target, PsiIndex.EdgeRole.PARAMETER);
                }
            } else if (value.kind() == PsiIndex.NodeKind.CALLABLE_REF) {
                PsiIndex.Node target = uniqueReferencedCallable(value);
                List<PsiIndex.Node> adapted = adaptedCallbackParameters(value, callback, facts);
                if (target != null && adapted != null) {
                    parameterOwner = target;
                    parameters = adapted;
                }
            }
            if (parameterOwner.kind() == PsiIndex.NodeKind.LAMBDA && parameters.isEmpty()
                    && callback.parameters().size() == 1
                    && implicitItAvailable(parameterOwner)) parameters = List.of(parameterOwner);
            if (parameters.size() == callback.parameters().size()) {
                for (int index = 0; index < parameters.size(); index++) {
                    Rules.CallbackParameterSpec parameter = callback.parameters().get(index);
                    String parameterType = parameter.abstractType();
                    PsiIndex.Node origin = null;
                    Rules.SymbolSpec physical = callbackParameterPhysical(symbol, callback, index);
                    Rules.SymbolSpec parameterSymbol = physical == null ? symbol : physical;
                    if (parameterType.equals("element_of_receiver")) {
                        parameterType = elementTypeForOrigin(receiver, facts);
                        Rules.SymbolSpec producer = exactCollectionProducer(receiver, facts);
                        PsiIndex.Node producerOrigin = exactCollectionProducerOrigin(receiver, facts);
                        origin = producerOrigin == null
                            ? representativeOrigin(receiver, facts) : producerOrigin;
                        if (producer != null && producerOrigin != null) parameterSymbol = producer;
                    } else if (callback.invocationModel().equals("immediate_inline")
                            && callback.receiverAbstractType() == null && parameters.size() == 1
                            && receiver != null && compatibleType(typeOf(facts, receiver), parameterType, receiver, facts)) {
                        origin = receiver;
                    }
                    if (parameterType != null) {
                        PsiIndex.Node parameterNode = parameters.get(index);
                        Rules.SymbolSpec parameterTypePhysical = physical == null
                            ? typeSymbolByAbstract(parameterType) : physical;
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "callback_parameter", parameterNode, parameterOwner, origin,
                            parameterType, parameterSymbol);
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "type", parameterNode, parameterOwner, origin,
                            parameterType, parameterTypePhysical);
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "origin", parameterNode, parameterOwner, origin,
                            origin == null ? "callback" : parameter.abstractType().equals("element_of_receiver")
                                ? "collection_element" : "derived",
                            parameter.abstractType().equals("element_of_receiver")
                                ? parameterSymbol : symbol);
                        if (parameter.abstractType().equals("element_of_receiver")) addFact(
                            facts, factKeys, multiplicities, unsupported,
                            "loop_element", parameterNode, parameterOwner, origin,
                            parameterType, parameterSymbol);
                        if (parameterNode.id() == parameterOwner.id()) bindImplicitItUses(
                            parameterOwner, facts, factKeys, multiplicities, unsupported);
                    }
                }
            }
            PsiIndex.Node resultTarget = callbackExecutionTarget(value, callback, symbol, facts);
            PsiIndex.Node result = callbackResult(resultTarget);
            String resultType = result == null ? null : typeOf(facts, result);
            if (result != null && resultType != null) addFact(facts, factKeys, multiplicities, unsupported,
                "callback_result", value, call, result, resultType, symbol);
        }
    }

    private void bindImplicitItUses(PsiIndex.Node lambda,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node use : program.nodes()) {
            if (use.kind() != PsiIndex.NodeKind.NAME_REF || use.name() == null
                    || !use.name().equals("it") || !isWithin(use, lambda)
                    || qualifiedSelectorParent(use) != null) continue;
            PsiIndex.Node declaration = findLexicalDeclaration(use, "it");
            if (declaration != null && declaration.id() != lambda.id()) continue;
            addFact(facts, factKeys, multiplicities, unsupported,
                "def_use", use, lambda, lambda, "", null);
            String type = factValue(facts, "callback_parameter", lambda.id());
            if (type != null) {
                Rules.SymbolSpec physical = symbolForFact(
                    facts, "callback_parameter", lambda.id());
                if (physical == null || !physical.kind().equals("type")) {
                    physical = typeSymbolByAbstract(type);
                }
                addFact(facts, factKeys, multiplicities, unsupported,
                    "type", use, lambda, lambda, type, physical);
            }
        }
    }

    private void promoteCallbacks(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL) continue;
            Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", call.id());
            if (symbol == null) continue;
            Map<Integer, List<PsiIndex.Node>> mapped = mapDomainArguments(call, symbol, facts);
            if (mapped == null) continue;
            boolean reachable = factBoolean(facts, "reachable", call.id());
            PsiIndex.Node receiver = resolvedReceiver(call);
            if (receiver == null && !symbol.receiverKind().equals("none")) {
                receiver = implicitReceiver(call, symbol, facts);
            }
            for (Rules.CallbackSpec callback : symbol.callbacks()) {
                List<PsiIndex.Node> arguments = mapped.get(callback.argumentPosition());
                if (arguments == null || arguments.size() != 1) continue;
                PsiIndex.Node argument = arguments.get(0);
                PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
                if (value == null) continue;
                PsiIndex.Node target = callbackExecutionTarget(value, callback, symbol, facts);
                String failure = callbackFailure(call, value, target, callback, symbol,
                    mapped, receiver, facts);
                if (failure != null) {
                    unsupported.put(value.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        value, enclosingCallable(call) == null ? -1 : enclosingCallable(call).id(),
                        call.id(), failure);
                    continue;
                }
                clearFailureValues(facts, factKeys, multiplicities, unsupported,
                    value, List.of("unknown_receiver", "unknown_return", "unsupported"));
                if (!reachable) continue;
                PsiIndex.Node result = callbackResult(target);
                String resultType = result == null ? null : typeOf(facts, result);
                if (result != null && resultType != null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "callback_result", value, call, result, resultType, symbol);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "production_root", target, ownerDeclaration(target), call, callback.role(), symbol);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "reachable", target, target, call, callback.invocationModel(), symbol);
                markLexicallyReachable(target, target, callback.invocationModel(),
                    facts, factKeys, multiplicities, unsupported);
            }
            // Callback results are often typed by the primitive/property pass immediately
            // before promotion. Reconcile the enclosing result in this same pass so a deep
            // predicate does not need a ninth global fixpoint iteration merely to preserve
            // its exact collection producer.
            if (reachable) applyDomainResult(call, symbol, mapped, receiver,
                facts, factKeys, multiplicities, unsupported);
        }
        propagateInferredTypes(facts, factKeys, multiplicities, unsupported);
        reconcilePlaneSelectorCallbacks(
            facts, factKeys, multiplicities, unsupported);
    }

    private void reconcilePlaneSelectorCallbacks(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        Rules.SymbolSpec filter = domainSymbolOrNull(
            "kotlin.collections.filter",
            "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>");
        Rules.SymbolSpec selector = domainSymbolOrNull(
            "kotlin.collections.maxByOrNull",
            "Iterable<T>.maxByOrNull(selector: (T) -> R): T?");
        if (filter == null || selector == null) return;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL
                    || !terminalFqnName(selector.fqn()).equals(call.name())) continue;
            PsiIndex.Node receiver = resolvedReceiver(call);
            PsiIndex.Node filterCall = directCall(receiver);
            if (filterCall == null
                    || !exactDomainResolution(filterCall, filter, facts)) continue;
            resolveOneCall(call, facts, factKeys, multiplicities, unsupported);
        }
    }

    private String callbackFailure(PsiIndex.Node call, PsiIndex.Node value, PsiIndex.Node target,
            Rules.CallbackSpec callback, Rules.SymbolSpec symbol,
            Map<Integer, List<PsiIndex.Node>> mapped, PsiIndex.Node receiver,
            List<Map<String, Object>> facts) {
        if (target == null) return value.kind() == PsiIndex.NodeKind.CALLABLE_REF
            && callableReferenceAdaptationCount(value, callback, facts) > 1
            ? "ambiguous" : "unsupported";
        if (!callbackParameterTypesMatchInvocation(
                value, target, callback, receiver, facts)) return "unsupported";
        if (callback.receiverAbstractType() != null) {
            PsiIndex.Node propagated = callbackReceiverOrigin(callback, receiver, mapped, facts);
            Rules.SymbolSpec physical = callback.receiverSource() == null
                ? callbackReceiverPhysical(symbol, callback) : physicalTypeForOrigin(propagated, facts);
            if (physical == null || callback.receiverSource() != null
                    && compatibilityPathCount(typeOf(facts, propagated),
                        callback.receiverAbstractType(), propagated, facts) != 1) return "unknown_receiver";
        }
        String model = callback.invocationModel();
        if (model.equals("source_root") || model.equals("possible_path")
                || model.equals("user_action") || model.equals("launched_path")
                || model.equals("acquire_path") || model.equals("immediate_inline")) return null;
        if (model.equals("cleanup_path")) {
            PsiIndex.Node acquisition = activeAcquisitionOwner(call, facts);
            PsiIndex.Node targetAcquisition = activeAcquisitionOwner(target, facts);
            return acquisition == null || targetAcquisition == null
                    || acquisition.id() != targetAcquisition.id()
                ? "unsupported" : null;
        }
        if (model.equals("element_flow") || model.equals("predicate_flow")
                || model.equals("selector_flow")) {
            boolean repeat = symbol.fqn().equals("kotlin.repeat")
                && symbol.signature().equals("repeat(times: Int, action: (Int) -> Unit): Unit")
                && mapped.get(0) != null && mapped.get(0).size() == 1
                && "int".equals(typeOf(facts, one(mapped.get(0).get(0), PsiIndex.EdgeRole.VALUE)));
            if (!repeat && elementTypeForOrigin(receiver, facts) == null) return "unsupported";
            if (model.equals("element_flow")) return null;
            PsiIndex.Node result = callbackResult(target);
            String resultType = typeOf(facts, result);
            if (model.equals("predicate_flow")) return "boolean".equals(resultType)
                ? null : "unknown_return";
            if (callbackResultEscapes(target, facts)) return "escape";
            return result != null && resultType != null && !callbackHasUnknownCall(target, facts)
                ? null : "unknown_return";
        }
        return "unsupported";
    }

    private boolean callbackResultEscapes(PsiIndex.Node callback,
            List<Map<String, Object>> facts) {
        PsiIndex.Node origin = localValueOrigin(callbackResult(callback), facts);
        if (origin == null) return false;
        for (Map<String, Object> fact : facts) {
            if (fact.get("kind").equals("escape")
                    && fact.get("relatedNodeId").equals((long) origin.id())) return true;
        }
        return false;
    }

    private PsiIndex.Node callbackExecutionTarget(PsiIndex.Node value,
            Rules.CallbackSpec callback, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        if (value.kind() == PsiIndex.NodeKind.LAMBDA) return value;
        if (value.kind() == PsiIndex.NodeKind.CALLABLE_REF) {
            PsiIndex.Node declaration = uniqueReferencedCallable(value);
            return declaration != null
                && callableReferenceAdaptationCount(value, callback, facts) == 1
                ? declaration : null;
        }
        if (value.kind() == PsiIndex.NodeKind.NAME_REF) {
            PsiIndex.Node binding = findLexicalDeclaration(value, value.name());
            return binding == null ? null : relatedNodeForFact(facts, "function_binding", binding.id());
        }
        return null;
    }

    private int callableReferenceAdaptationCount(PsiIndex.Node reference,
            Rules.CallbackSpec callback, List<Map<String, Object>> facts) {
        PsiIndex.Node declaration = uniqueReferencedCallable(reference);
        if (declaration == null) return 0;
        List<PsiIndex.Node> parameters = targets(declaration, PsiIndex.EdgeRole.PARAMETER);
        PsiIndex.Node extensionType = declarationTypeNode(declaration, true);
        boolean extensionCompatible = callback.receiverAbstractType() != null
            && extensionType != null && compatibleType(typeOf(facts, extensionType),
                callback.receiverAbstractType(), extensionType, facts);
        boolean firstParameterCompatible = callback.receiverAbstractType() != null
            && !parameters.isEmpty() && compatibleType(declaredSemanticType(parameters.get(0)),
                callback.receiverAbstractType(), parameters.get(0), facts);
        if (extensionCompatible && firstParameterCompatible) return 2;
        int adaptations = 0;
        if (callback.receiverAbstractType() == null && extensionType == null
                && callbackParameterTypesMatch(parameters, callback, facts)) adaptations++;
        if (extensionCompatible
                && callbackParameterTypesMatch(parameters, callback, facts)) adaptations++;
        if (firstParameterCompatible && extensionType == null
                && callbackParameterTypesMatch(parameters.subList(1, parameters.size()),
                    callback, facts)) adaptations++;
        return adaptations;
    }

    private List<PsiIndex.Node> adaptedCallbackParameters(PsiIndex.Node reference,
            Rules.CallbackSpec callback, List<Map<String, Object>> facts) {
        if (callableReferenceAdaptationCount(reference, callback, facts) != 1) return null;
        PsiIndex.Node declaration = uniqueReferencedCallable(reference);
        if (declaration == null) return null;
        List<PsiIndex.Node> parameters = targets(declaration, PsiIndex.EdgeRole.PARAMETER);
        PsiIndex.Node extensionType = declarationTypeNode(declaration, true);
        if (callback.receiverAbstractType() != null && extensionType == null
                && !parameters.isEmpty() && compatibleType(
                    declaredSemanticType(parameters.get(0)), callback.receiverAbstractType(),
                    parameters.get(0), facts)) {
            return List.copyOf(parameters.subList(1, parameters.size()));
        }
        return List.copyOf(parameters);
    }

    private boolean callbackParameterTypesMatch(List<PsiIndex.Node> parameters,
            Rules.CallbackSpec callback, List<Map<String, Object>> facts) {
        if (parameters.size() != callback.parameters().size()) return false;
        for (int index = 0; index < parameters.size(); index++) {
            String required = callback.parameters().get(index).abstractType();
            String actual = declaredSemanticType(parameters.get(index));
            if (required.equals("element_of_receiver")) {
                if (actual == null) return false;
            } else if (actual == null || !compatibleType(
                    actual, required, parameters.get(index), facts)) return false;
        }
        return true;
    }

    private boolean callbackParameterTypesMatchInvocation(PsiIndex.Node value,
            PsiIndex.Node target, Rules.CallbackSpec callback, PsiIndex.Node receiver,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> parameters = value.kind() == PsiIndex.NodeKind.CALLABLE_REF
            ? adaptedCallbackParameters(value, callback, facts)
            : targets(target, PsiIndex.EdgeRole.PARAMETER);
        if (parameters == null) return false;
        if (target.kind() == PsiIndex.NodeKind.LAMBDA && parameters.isEmpty()
                && callback.parameters().size() == 1
                && implicitItAvailable(target)) parameters = List.of(target);
        if (parameters.size() != callback.parameters().size()) return false;
        for (int index = 0; index < parameters.size(); index++) {
            String required = callback.parameters().get(index).abstractType();
            if (required.equals("element_of_receiver")) {
                required = elementTypeForOrigin(receiver, facts);
                if (required == null) return false;
            }
            String actual = parameters.get(index).kind() == PsiIndex.NodeKind.LAMBDA
                ? null : declaredSemanticType(parameters.get(index));
            if (actual != null && !compatibleType(
                    actual, required, parameters.get(index), facts)) return false;
        }
        return true;
    }

    private PsiIndex.Node uniqueReferencedCallable(PsiIndex.Node reference) {
        if (reference == null || reference.name() == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || candidate.name() == null || !candidate.name().equals(reference.name())) continue;
            boolean visible = candidate.fileId() == reference.fileId()
                || program.file(candidate.fileId()).packageName().equals(
                    program.file(reference.fileId()).packageName());
            if (!visible) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private PsiIndex.Node activeAcquisitionOwner(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        Integer owner = lexicalOwners.get(call.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.LAMBDA
                    && "acquire_path".equals(factValue(facts, "reachable", candidate.id()))) {
                return candidate;
            }
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private boolean callbackHasUnknownCall(PsiIndex.Node callback,
            List<Map<String, Object>> facts) {
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() == PsiIndex.NodeKind.CALL && isWithin(node, callback)
                    && !hasFact(facts, "call_resolution", node.id())) return true;
        }
        return false;
    }

    private void applyReachableDomainEffects(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            if (!factBoolean(facts, "reachable", node.id())) continue;
            Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", node.id());
            if (symbol == null) continue;
            if (node.kind() == PsiIndex.NodeKind.CALL) {
                Map<Integer, List<PsiIndex.Node>> mapped = mapDomainArguments(node, symbol, facts);
                if (mapped == null) continue;
                PsiIndex.Node receiver = resolvedReceiver(node);
                if (receiver == null && !symbol.receiverKind().equals("none")) {
                    receiver = implicitReceiver(node, symbol, facts);
                }
                applyEffects(node, symbol, mapped, receiver,
                    facts, factKeys, multiplicities, unsupported);
            } else if (node.kind() == PsiIndex.NodeKind.NAME_REF
                    && (symbol.kind().equals("member_property")
                    || symbol.kind().equals("top_level_property"))) {
                PsiIndex.Node qualified = qualifiedSelectorParent(node);
                applyPropertyRead(node, symbol,
                    qualified == null ? null : one(qualified, PsiIndex.EdgeRole.RECEIVER),
                    facts, factKeys, multiplicities, unsupported);
            }
        }
    }

    private void applyReachableSourceEffects(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL
                    || !"source".equals(factValue(facts, "call_resolution", call.id()))
                    || !factBoolean(facts, "reachable", call.id())) continue;
            PsiIndex.Node declaration = relatedNodeForFact(facts, "call_resolution", call.id());
            if (declaration == null) continue;
            Map<Integer, List<PsiIndex.Node>> mapped = mapSourceArguments(call, declaration, facts);
            if (mapped == null) continue;
            PsiIndex.Node summarizedParameter = null;
            PsiIndex.Node summarizedBodyCall = null;
            Rules.SymbolSpec summarizedRow = null;
            String summarizedEffect = null;
            boolean invalid = false;
            for (PsiIndex.Node bodyCall : program.nodes()) {
                if (bodyCall.kind() != PsiIndex.NodeKind.CALL || !isWithin(bodyCall, declaration)) continue;
                Rules.SymbolSpec row = symbolForFact(facts, "call_resolution", bodyCall.id());
                if (row == null) {
                    invalid = true;
                    break;
                }
                if (row.effects().isEmpty()) continue;
                PsiIndex.Node target = resolvedReceiver(bodyCall);
                PsiIndex.Node parameter = target == null ? null
                    : relatedNodeForFact(facts, "def_use", target.id());
                if (parameter == null && target != null) parameter = findLexicalDeclaration(target, target.name());
                if (parameter == null || parameter.kind() != PsiIndex.NodeKind.PARAMETER_DECL
                        || !isWithin(parameter, declaration)) {
                    invalid = true;
                    break;
                }
                for (String effect : row.effects()) {
                    if (effect.equals("passthrough")) continue;
                    if (summarizedEffect != null) {
                        invalid = true;
                        break;
                    }
                    summarizedParameter = parameter;
                    summarizedBodyCall = bodyCall;
                    summarizedRow = row;
                    summarizedEffect = effect;
                }
                if (invalid) break;
            }
            if (invalid || summarizedParameter == null || summarizedEffect == null) continue;
            List<PsiIndex.Node> parameters = targets(declaration, PsiIndex.EdgeRole.PARAMETER);
            int position = parameters.indexOf(summarizedParameter);
            List<PsiIndex.Node> arguments = mapped.get(position);
            if (position < 0 || arguments == null || arguments.size() != 1) continue;
            PsiIndex.Node target = argumentValue(arguments.get(0));
            if (target != null) addFact(facts, factKeys, multiplicities, unsupported,
                "effect", call, enclosingCallable(call), target, summarizedEffect, null);
            if (summarizedBodyCall != null && summarizedRow != null) {
                Map<Integer, List<PsiIndex.Node>> bodyMapped = mapDomainArguments(
                    summarizedBodyCall, summarizedRow, facts);
                if (bodyMapped != null) {
                    PsiIndex.Node bodyReceiver = resolvedReceiver(summarizedBodyCall);
                    if (bodyReceiver == null && !summarizedRow.receiverKind().equals("none")) {
                        bodyReceiver = implicitReceiver(summarizedBodyCall, summarizedRow, facts);
                    }
                    applyEffects(summarizedBodyCall, summarizedRow, bodyMapped, bodyReceiver,
                        facts, factKeys, multiplicities, unsupported);
                }
            }
        }
    }

    private void resolveSyntheticOperators(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node syntax : program.nodes()) {
            if (hasFact(facts, "call_resolution", syntax.id())) continue;
            String form = syntheticOperatorForm(syntax);
            boolean until = syntax.kind() == PsiIndex.NodeKind.BINARY
                && "until".equals(syntax.value());
            if (form == null && !until) continue;
            PsiIndex.Node receiver = syntheticReceiver(syntax, form);
            List<PsiIndex.Node> values = syntheticValues(syntax, form);
            boolean escaped = escapedOrigin(receiver, facts) != null;
            for (PsiIndex.Node value : values) if (escapedOrigin(value, facts) != null) escaped = true;
            if (escaped) {
                unsupported.put(syntax.id(), Boolean.TRUE);
                PsiIndex.Node owner = enclosingCallable(syntax);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    syntax, owner == null ? -1 : owner.id(), syntax.id(), "escape");
                continue;
            }
            List<Rules.SymbolSpec> accepted = new ArrayList<>();
            for (Rules.SymbolSpec candidate : domain.symbols()) {
                if (until) {
                    if (!candidate.fqn().equals("kotlin.ranges.until")
                            || !candidate.signature().equals("Int.until(to: Int): IntRange")) continue;
                } else if (!form.equals(candidate.operatorForm())) continue;
                if (!receiverTypeMatches(receiver, candidate, facts)
                        || !syntheticArgumentsMatch(candidate, values, facts)) continue;
                accepted.add(candidate);
            }
            if (accepted.size() != 1) {
                if (accepted.isEmpty() && deferredBuiltinSyntax(syntax, facts)) continue;
                if (accepted.isEmpty() && isAmbiguousEnumEquality(syntax, facts)) {
                    unsupported.put(syntax.id(), Boolean.TRUE);
                    PsiIndex.Node owner = enclosingCallable(syntax);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        syntax, owner == null ? -1 : owner.id(), syntax.id(), "ambiguous");
                    continue;
                }
                if (!accepted.isEmpty() || receiver != null) {
                    unsupported.put(syntax.id(), Boolean.TRUE);
                    boolean invalidIndexArity = syntax.kind() == PsiIndex.NodeKind.INDEX_ACCESS
                        && targets(syntax, PsiIndex.EdgeRole.INDEX).size() != 1;
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        syntax, enclosingCallable(syntax) == null ? -1 : enclosingCallable(syntax).id(),
                        syntax.id(), accepted.size() > 1 ? "ambiguous"
                            : invalidIndexArity ? "unsupported" : "unknown_receiver");
                }
                continue;
            }
            Rules.SymbolSpec symbol = accepted.get(0);
            clearRecoverableCallFailure(
                facts, factKeys, multiplicities, unsupported, syntax);
            Map<Integer, List<PsiIndex.Node>> mapped = new HashMap<>();
            for (int index = 0; index < values.size(); index++) {
                PsiIndex.Node value = values.get(index);
                mapped.put(index, List.of(value));
                addFact(facts, factKeys, multiplicities, unsupported,
                    "argument_binding", value, syntax, -1, Integer.toString(index), symbol);
            }
            addFact(facts, factKeys, multiplicities, unsupported,
                "call_resolution", syntax, enclosingCallable(syntax), -1, "domain", symbol);
            addOwnerConformance(syntax, receiver, symbol,
                facts, factKeys, multiplicities, unsupported);
            applyDomainResult(syntax, symbol, mapped, receiver,
                facts, factKeys, multiplicities, unsupported);
            if (factBoolean(facts, "reachable", syntax.id())) applyEffects(
                syntax, symbol, mapped, receiver, facts, factKeys, multiplicities, unsupported);
            if (syntax.kind() == PsiIndex.NodeKind.INDEX_ACCESS) addWitnessOwner(
                facts, factKeys, multiplicities, unsupported,
                syntax, enclosingCallable(syntax), nearestWitnessOwner(syntax), "index");
            if (until) addWitnessOwner(facts, factKeys, multiplicities, unsupported,
                syntax, enclosingCallable(syntax), nearestWitnessOwner(syntax), "until");
        }
    }

    private boolean deferredBuiltinSyntax(PsiIndex.Node syntax,
            List<Map<String, Object>> facts) {
        if (syntax.kind() == PsiIndex.NodeKind.ASSIGNMENT && "+=".equals(syntax.value())) {
            PsiIndex.Node target = one(syntax, PsiIndex.EdgeRole.TARGET);
            PsiIndex.Node value = one(syntax, PsiIndex.EdgeRole.VALUE);
            if (propertySymbolForTarget(target, facts) != null) return true;
            String targetType = typeOf(facts, target);
            return isNumeric(targetType) && targetType.equals(typeOf(facts, value));
        }
        if (syntax.kind() != PsiIndex.NodeKind.BINARY) return false;
        PsiIndex.Node left = one(syntax, PsiIndex.EdgeRole.LEFT);
        PsiIndex.Node right = one(syntax, PsiIndex.EdgeRole.RIGHT);
        String leftType = typeOf(facts, left);
        String rightType = typeOf(facts, right);
        String operator = syntax.value();
        if ("+".equals(operator)) return isNumeric(leftType) && leftType.equals(rightType);
        if (List.of("<", "<=", ">", ">=").contains(operator)) {
            return isNumeric(leftType) && leftType.equals(rightType);
        }
        if (!"==".equals(operator) && !"!=".equals(operator)) return false;
        if (leftType != null && leftType.equals(rightType) && isPrimitiveComparable(leftType)) return true;
        if (leftType != null && isNullableFact(facts, left) && isNullLiteral(right)
                || rightType != null && isNullableFact(facts, right) && isNullLiteral(left)) return true;
        return enumEntryOperand(left, right, facts) != null;
    }

    private String syntheticOperatorForm(PsiIndex.Node syntax) {
        if (syntax.kind() == PsiIndex.NodeKind.INDEX_ACCESS) {
            Integer ownerId = lexicalOwners.get(syntax.id());
            if (ownerId != null) {
                PsiIndex.Node owner = program.node(ownerId);
                if (owner.kind() == PsiIndex.NodeKind.ASSIGNMENT
                        && isTarget(owner, PsiIndex.EdgeRole.TARGET, syntax)) return "index_set";
            }
            return "index_get";
        }
        if (syntax.kind() == PsiIndex.NodeKind.ASSIGNMENT && "+=".equals(syntax.value())) {
            return "plus_assign";
        }
        if (syntax.kind() == PsiIndex.NodeKind.CALL && "iterator".equals(syntax.name())) return "iterator";
        if (syntax.kind() != PsiIndex.NodeKind.BINARY) return null;
        if ("+".equals(syntax.value())) return "plus";
        if ("in".equals(syntax.value()) || "!in".equals(syntax.value())) return "contains";
        if (List.of("<", "<=", ">", ">=").contains(syntax.value())) return "compare_to";
        if ("==".equals(syntax.value()) || "!=".equals(syntax.value())) return "equals";
        return null;
    }

    private PsiIndex.Node syntheticReceiver(PsiIndex.Node syntax, String form) {
        if (syntax.kind() == PsiIndex.NodeKind.INDEX_ACCESS) return one(syntax, PsiIndex.EdgeRole.RECEIVER);
        if (syntax.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
            PsiIndex.Node target = one(syntax, PsiIndex.EdgeRole.TARGET);
            return target != null && target.kind() == PsiIndex.NodeKind.INDEX_ACCESS
                ? one(target, PsiIndex.EdgeRole.RECEIVER) : target;
        }
        if (syntax.kind() == PsiIndex.NodeKind.CALL) return resolvedReceiver(syntax);
        if ("contains".equals(form)) return one(syntax, PsiIndex.EdgeRole.RIGHT);
        return one(syntax, PsiIndex.EdgeRole.LEFT);
    }

    private List<PsiIndex.Node> syntheticValues(PsiIndex.Node syntax, String form) {
        List<PsiIndex.Node> values = new ArrayList<>();
        if (syntax.kind() == PsiIndex.NodeKind.INDEX_ACCESS) {
            values.addAll(targets(syntax, PsiIndex.EdgeRole.INDEX));
        } else if (syntax.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
            PsiIndex.Node target = one(syntax, PsiIndex.EdgeRole.TARGET);
            if (target != null && target.kind() == PsiIndex.NodeKind.INDEX_ACCESS) {
                values.addAll(targets(target, PsiIndex.EdgeRole.INDEX));
            }
            PsiIndex.Node value = one(syntax, PsiIndex.EdgeRole.VALUE);
            if (value != null) values.add(value);
        } else if (syntax.kind() == PsiIndex.NodeKind.BINARY) {
            PsiIndex.Node value = "contains".equals(form)
                ? one(syntax, PsiIndex.EdgeRole.LEFT) : one(syntax, PsiIndex.EdgeRole.RIGHT);
            if (value != null) values.add(value);
        }
        return values;
    }

    private boolean syntheticArgumentsMatch(Rules.SymbolSpec symbol, List<PsiIndex.Node> values,
            List<Map<String, Object>> facts) {
        if (values.size() > symbol.arguments().size()) return false;
        for (int index = 0; index < values.size(); index++) {
            Rules.ArgumentSpec argument = symbol.arguments().get(index);
            PsiIndex.Node value = values.get(index);
            if (isNullLiteral(value)) {
                if (!allowsNull(symbol, index)) return false;
            } else if (argument.abstractType().equals("opaque")) {
                if (isCallableValue(value, facts)) return false;
            } else if (!compatibleType(typeOf(facts, value), argument.abstractType(), value, facts)) return false;
        }
        for (int index = values.size(); index < symbol.arguments().size(); index++) {
            Rules.ArgumentSpec argument = symbol.arguments().get(index);
            if (!argument.hasDefault() && !argument.variadic()) return false;
        }
        return true;
    }

    private void applyDomainResult(PsiIndex.Node call, Rules.SymbolSpec symbol,
            Map<Integer, List<PsiIndex.Node>> mapped, PsiIndex.Node receiver,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        PsiIndex.Node owner = enclosingCallable(call);
        for (Rules.CallbackSpec callback : symbol.callbacks()) {
            if (!callback.invocationModel().equals("predicate_flow")
                    && !callback.invocationModel().equals("selector_flow")) continue;
            List<PsiIndex.Node> arguments = mapped.get(callback.argumentPosition());
            PsiIndex.Node value = arguments == null || arguments.size() != 1
                ? null : argumentValue(arguments.get(0));
            PsiIndex.Node target = value == null ? null
                : callbackExecutionTarget(value, callback, symbol, facts);
            if (value == null || callbackFailure(call, value, target, callback, symbol,
                    mapped, receiver, facts) != null) return;
            if (callback.invocationModel().equals("selector_flow")) {
                PsiIndex.Node resultOrigin = representativeOrigin(callbackResult(target), facts);
                PsiIndex.Node parameterOrigin = representativeOrigin(
                    callbackElementParameter(target, facts), facts);
                if (resultOrigin == null || parameterOrigin == null
                        || resultOrigin.id() != parameterOrigin.id()) return;
            }
        }
        String type = symbol.returnAbstractType();
        PsiIndex.Node origin = receiver;
        String originValue = symbol.effects().contains("construct") ? "fresh"
            : symbol.effects().contains("acquire") && "cancellable".equals(type) ? "fresh"
            : symbol.kind().equals("top_level_property") ? "retained" : "derived";
        if (symbol.returnSource() != null && symbol.returnSource().equals("element_of_receiver")) {
            type = elementTypeForOrigin(receiver, facts);
            PsiIndex.Node producerOrigin = exactCollectionProducerOrigin(receiver, facts);
            origin = producerOrigin == null
                ? representativeOrigin(receiver, facts) : producerOrigin;
        } else if (symbol.returnSource() != null && symbol.returnSource().equals("class_of_argument")) {
            PsiIndex.Node source = null;
            int sourceCount = 0;
            for (List<PsiIndex.Node> arguments : mapped.values()) {
                for (PsiIndex.Node argument : arguments) {
                    PsiIndex.Node value = argumentValue(argument);
                    if ("java_class".equals(typeOf(facts, value))) {
                        source = value;
                        sourceCount++;
                    }
                }
            }
            if (sourceCount != 1) source = null;
            Rules.SymbolSpec sourceType = classTokenTargetType(source, facts);
            type = sourceType == null || conformancePathCountFromPhysical(
                    sourceType, "component", 0, new HashMap<>()) != 1
                ? null : sourceType.returnAbstractType();
            origin = source;
        } else if (symbol.effects().contains("passthrough")) {
            if (symbol.returnAbstractType() != null && receiver != null
                    && compatibleType(typeOf(facts, receiver), symbol.returnAbstractType(), receiver, facts)) {
                PsiIndex.Node producerOrigin = exactCollectionProducerOrigin(receiver, facts);
                origin = producerOrigin == null
                    ? representativeOrigin(receiver, facts) : producerOrigin;
            } else if (symbol.returnAbstractType() == null && symbol.callbacks().size() == 1
                    && symbol.callbacks().get(0).invocationModel().equals("immediate_inline")) {
                PsiIndex.Node callback = uniqueCallbackResult(call, facts);
                if (callback == null || escapedOrigin(callback, facts) != null
                        || callbackHasUnknownCall(callback, facts)) type = null;
                else {
                    type = typeOf(facts, callback);
                    origin = callback;
                    if (symbol.fqn().equals("androidx.compose.runtime.remember")) originValue = "retained";
                }
            } else type = null;
        }
        if (symbol.fqn().equals("kotlin.collections.toList")
                && "plane_anchor_collection".equals(typeOf(facts, receiver))) {
            type = "plane_anchor_collection";
            PsiIndex.Node producerOrigin = exactCollectionProducerOrigin(receiver, facts);
            origin = producerOrigin == null ? receiver : producerOrigin;
        }
        Rules.SymbolSpec physical = physicalResultType(symbol);
        if (requiresExactPhysicalResult(symbol) && physical == null) {
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "unknown_return");
            return;
        }
        if (physical == null) physical = typeSymbolByAbstract(type);
        if (type != null) {
            addFact(facts, factKeys, multiplicities, unsupported,
                "type", call, owner, -1, type, physical);
            addFact(facts, factKeys, multiplicities, unsupported,
                "origin", call, owner, origin, originValue, symbol);
            addFact(facts, factKeys, multiplicities, unsupported,
                "return_origin", call, owner, origin, type, symbol);
            if (isNullableResult(symbol)) addFact(facts, factKeys, multiplicities, unsupported,
                "nullable", call, owner, -1, "true", symbol);
            addDirectConformance(call, owner, physical,
                facts, factKeys, multiplicities, unsupported);
            if (type.equals("plane_anchor_collection") && symbol.fqn().equals(
                    "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors")
                    && symbol.signature().equals("loadAllAnchors(): Array<PlaneAnchor>")) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "conformance", call, -1, -1, "immutable_iterable", symbol);
            }
            if (type.equals("plane_anchor_collection") && symbol.fqn().equals("kotlin.collections.toList")) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "conformance", call, owner, receiver, "immutable_iterable", symbol);
            }
        } else if (symbol.returnSource() != null || symbol.effects().contains("passthrough")
                && symbol.returnAbstractType() != null) {
            unsupported.put(call.id(), Boolean.TRUE);
            addTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), "unknown_return");
        }
    }

    private void seedPassthroughFailures(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL
                    || hasFact(facts, "return_origin", call.id())) continue;
            Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", call.id());
            if (symbol == null || symbol.returnAbstractType() != null
                    || !symbol.effects().contains("passthrough")
                    || symbol.callbacks().size() != 1
                    || !symbol.callbacks().get(0).invocationModel().equals("immediate_inline")) continue;
            Rules.CallbackSpec callback = symbol.callbacks().get(0);
            Map<Integer, List<PsiIndex.Node>> mapped = mapDomainArguments(call, symbol, facts);
            List<PsiIndex.Node> arguments = mapped == null ? null
                : mapped.get(callback.argumentPosition());
            PsiIndex.Node value = arguments == null || arguments.size() != 1
                ? null : argumentValue(arguments.get(0));
            PsiIndex.Node target = value == null ? null
                : callbackExecutionTarget(value, callback, symbol, facts);
            PsiIndex.Node result = callbackResult(target);
            String failure = result != null && (result.kind() == PsiIndex.NodeKind.IF
                    || result.kind() == PsiIndex.NodeKind.WHEN) ? "ambiguous"
                : target != null && callbackResultEscapes(target, facts) ? "escape"
                : "unknown_return";
            unsupported.put(call.id(), Boolean.TRUE);
            PsiIndex.Node owner = enclosingCallable(call);
            replaceTaint(facts, factKeys, multiplicities, unsupported,
                call, owner == null ? -1 : owner.id(), call.id(), failure);
        }
    }

    private void applyEffects(PsiIndex.Node call, Rules.SymbolSpec symbol,
            Map<Integer, List<PsiIndex.Node>> mapped, PsiIndex.Node receiver,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        PsiIndex.Node owner = enclosingCallable(call);
        PsiIndex.Node target = receiver;
        if (target == null) {
            for (Rules.ArgumentSpec argument : symbol.arguments()) {
                if (argument.abstractType().equals("opaque") || callbackAt(symbol, argument.position()) != null) continue;
                List<PsiIndex.Node> values = mapped.get(argument.position());
                if (values != null && !values.isEmpty()) {
                    target = argumentValue(values.get(0));
                    if (target != null) break;
                }
            }
        }
        for (String effect : symbol.effects()) {
            if (effect.equals("passthrough") && target == null) target = uniqueCallbackResult(call, facts);
            boolean targetlessPair = (symbol.fqn().equals("com.pico.spatial.ui.foundation.dsl.registerSystem")
                    && symbol.signature().equals("registerSystem<T : System>(): Unit")
                    || symbol.fqn().equals("com.pico.spatial.ui.foundation.dsl.unregisterSystem")
                    && symbol.signature().equals("unregisterSystem<T : System>(): Unit"))
                && targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT).size() == 1;
            if (target == null && !effect.equals("construct") && !targetlessPair) {
                unsupported.put(call.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    call, owner == null ? -1 : owner.id(), call.id(), "unknown_effect");
                continue;
            }
            if (effect.equals("readiness") && !(symbol.fqn().equals("kotlin.collections.isNotEmpty")
                    && symbol.signature().equals("Collection<T>.isNotEmpty(): Boolean")
                    || symbol.fqn().equals("kotlin.collections.isEmpty")
                    && symbol.signature().equals("Collection<T>.isEmpty(): Boolean"))) {
                unsupported.put(call.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    call, owner == null ? -1 : owner.id(), call.id(), "unknown_effect");
                continue;
            }
            addFact(facts, factKeys, multiplicities, unsupported,
                "effect", call, owner, target, effect, symbol);
            if (effect.equals("read")) addFact(facts, factKeys, multiplicities, unsupported,
                "read", call, owner, target, "", symbol);
            else if (effect.equals("mutate") || effect.equals("replace") || effect.equals("status_assign")) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "write", call, owner, target, "", symbol);
            } else if (effect.equals("unknown_escape")) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "escape", call, owner, target, "unknown_call", symbol);
            }
            PsiIndex.Node conditionOwner = effect.equals("readiness") ? conditionOwner(call) : null;
            if (conditionOwner != null && target != null) addFact(
                facts, factKeys, multiplicities, unsupported,
                "condition", call, conditionOwner, target,
                symbol.fqn().equals("kotlin.collections.isNotEmpty")
                    ? "readiness_positive" : "readiness_negative", symbol);
        }
    }

    private PsiIndex.Node argumentValue(PsiIndex.Node argument) {
        if (argument == null) return null;
        PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
        return value == null ? argument : value;
    }

    private void seedPrimitiveFlow(List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            PsiIndex.Node owner = enclosingCallable(node);
            if (node.kind() == PsiIndex.NodeKind.BINARY) {
                PsiIndex.Node left = one(node, PsiIndex.EdgeRole.LEFT);
                PsiIndex.Node right = one(node, PsiIndex.EdgeRole.RIGHT);
                String leftType = typeOf(facts, left);
                String rightType = typeOf(facts, right);
                String operator = node.value();
                if (left == null || right == null || operator == null) continue;
                if (isNumeric(leftType) && leftType.equals(rightType)
                        && (operator.equals("+") || operator.equals("-")
                        || operator.equals("*") || operator.equals("/"))) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    arithmeticInputs.put(node.id(), List.of(left.id(), right.id()));
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "primitive", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, leftType, null);
                } else if (isNumeric(leftType) && leftType.equals(rightType)
                        && (operator.equals("<") || operator.equals("<=")
                        || operator.equals(">") || operator.equals(">="))) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "primitive", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, "boolean", null);
                    PsiIndex.Node conditionOwner = conditionOwner(node);
                    if (conditionOwner != null) addFact(facts, factKeys, multiplicities, unsupported,
                        "condition", node, conditionOwner, left, "numeric_compare", null);
                } else if (leftType != null && leftType.equals(rightType)
                        && isPrimitiveComparable(leftType)
                        && (operator.equals("==") || operator.equals("!="))) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "primitive", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, "boolean", null);
                    addEqualityWitnessOwner(
                        facts, factKeys, multiplicities, unsupported, node, owner);
                } else if ((operator.equals("==") || operator.equals("!="))
                        && (leftType != null && isNullableFact(facts, left) && isNullLiteral(right)
                        || rightType != null && isNullableFact(facts, right) && isNullLiteral(left))) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    PsiIndex.Node tested = isNullLiteral(left) ? right : left;
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "null", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, "boolean", null);
                    PsiIndex.Node conditionOwner = conditionOwner(node);
                    if (conditionOwner != null) addFact(facts, factKeys, multiplicities, unsupported,
                        "condition", node, conditionOwner, tested,
                        operator.equals("==") ? "null" : "nonnull", null);
                } else if ((operator.equals("==") || operator.equals("!="))
                        && enumEntryOperand(left, right, facts) != null) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    PsiIndex.Node entry = enumEntryOperand(left, right, facts);
                    PsiIndex.Node tested = entry.id() == left.id() ? right : left;
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "enum", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, "boolean", null);
                    PsiIndex.Node conditionOwner = conditionOwner(node);
                    if (conditionOwner != null) addFact(facts, factKeys, multiplicities, unsupported,
                        "condition", node, conditionOwner, tested,
                        operator.equals("==") ? "enum_equal" : "enum_not_equal", null);
                    addEqualityWitnessOwner(
                        facts, factKeys, multiplicities, unsupported, node, owner);
                    PsiIndex.Node entrySubject = entry.kind() == PsiIndex.NodeKind.QUALIFIED
                        ? one(entry, PsiIndex.EdgeRole.SELECTOR) : entry;
                    if (entrySubject != null) addFact(
                        facts, factKeys, multiplicities, unsupported,
                        "witness_owner", entrySubject, owner, node, "enum_entry", null);
                } else if ("boolean".equals(leftType) && "boolean".equals(rightType)
                        && (operator.equals("&&") || operator.equals("||"))) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "primitive", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, "boolean", null);
                } else if (operator.equals("%")) {
                    unsupported.put(node.id(), Boolean.TRUE);
                    addTaint(facts, factKeys, multiplicities, unsupported,
                        node, owner == null ? -1 : owner.id(), node.id(), "unsupported");
                }
            } else if (node.kind() == PsiIndex.NodeKind.PREFIX) {
                PsiIndex.Node operand = one(node, PsiIndex.EdgeRole.OPERAND);
                String type = typeOf(facts, operand);
                if ("-".equals(node.value()) && isNumeric(type)) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "primitive", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, type, null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", node, owner, operand, "derived", null);
                } else if ("!".equals(node.value()) && "boolean".equals(type)) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "primitive", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, owner, -1, "boolean", null);
                    PsiIndex.Node branch = conditionOwner(node);
                    if (branch != null) addFact(facts, factKeys, multiplicities, unsupported,
                        "condition", node, branch, operand, "false", null);
                }
            } else if (node.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
                PsiIndex.Node target = one(node, PsiIndex.EdgeRole.TARGET);
                PsiIndex.Node value = one(node, PsiIndex.EdgeRole.VALUE);
                String targetType = typeOf(facts, target);
                String valueType = typeOf(facts, value);
                Rules.SymbolSpec property = propertySymbolForTarget(target, facts);
                if (property != null) {
                    PsiIndex.Node receiver = propertyReceiverForTarget(target);
                    boolean compound = !"=".equals(node.value());
                    boolean allowed = property.effects().contains("mutate")
                        && (!compound || property.effects().contains("read"));
                    if (!allowed) {
                        unsupported.put(node.id(), Boolean.TRUE);
                        addTaint(facts, factKeys, multiplicities, unsupported,
                            node, owner == null ? -1 : owner.id(), node.id(), "unknown_effect");
                    } else {
                        clearRecoverableCallFailure(
                            facts, factKeys, multiplicities, unsupported, node);
                        if (compound) {
                            addFact(facts, factKeys, multiplicities, unsupported,
                                "effect", node, owner, receiver, "read", property);
                            addFact(facts, factKeys, multiplicities, unsupported,
                                "read", node, owner, receiver, "", property);
                        }
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "effect", node, owner, receiver, "mutate", property);
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "write", node, owner, receiver, "", property);
                    }
                } else if ("+=".equals(node.value()) && isNumeric(targetType) && targetType.equals(valueType)) {
                    clearRecoverableCallFailure(
                        facts, factKeys, multiplicities, unsupported, node);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "call_resolution", node, owner, -1, "primitive", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "read", node, owner, target, "", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "write", node, owner, target, "", null);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", node, owner, value, "derived", null);
                } else if ("=".equals(node.value()) && target != null && value != null
                        && target.kind() != PsiIndex.NodeKind.QUALIFIED
                        && target.kind() != PsiIndex.NodeKind.SAFE_QUALIFIED
                        && (targetType == null || valueType == null || compatibleType(valueType, targetType, value, facts))) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "write", node, owner, target, "", null);
                }
            } else if (node.kind() == PsiIndex.NodeKind.QUALIFIED && isAtomicClassToken(node)) {
                PsiIndex.Node classLiteral = one(node, PsiIndex.EdgeRole.RECEIVER);
                PsiIndex.Node typeReference = one(classLiteral, PsiIndex.EdgeRole.RECEIVER);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "call_resolution", node, owner, -1, "class_token", null);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "type", node, owner, -1, "java_class", null);
                addFact(facts, factKeys, multiplicities, unsupported,
                    "origin", node, owner, typeReference, "class_token", null);
            } else if (node.kind() == PsiIndex.NodeKind.CLASS_LITERAL
                    && !isWithinAtomicClassToken(node)) {
                unsupported.put(node.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    node, owner == null ? -1 : owner.id(), node.id(), "unsupported");
            } else if (node.kind() == PsiIndex.NodeKind.POSTFIX
                    && ("++".equals(node.value()) || "--".equals(node.value()))) {
                unsupported.put(node.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    node, owner == null ? -1 : owner.id(), node.id(), "unknown_effect");
            } else if (node.kind() == PsiIndex.NodeKind.INDEX_ACCESS) {
                addWitnessOwner(facts, factKeys, multiplicities, unsupported,
                    node, owner, nearestWitnessOwner(node), "index");
            } else if (node.kind() == PsiIndex.NodeKind.FOR) {
                PsiIndex.Node parameter = one(node, PsiIndex.EdgeRole.PARAMETER);
                PsiIndex.Node range = one(node, PsiIndex.EdgeRole.RANGE);
                String element = elementType(typeOf(facts, range));
                if (parameter != null && element != null) {
                    PsiIndex.Node producerOrigin = range;
                    if (range.kind() == PsiIndex.NodeKind.QUALIFIED
                            || range.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
                        PsiIndex.Node selector = one(range, PsiIndex.EdgeRole.SELECTOR);
                        if (selector != null && symbolForFact(
                                facts, "return_origin", selector.id()) != null) producerOrigin = selector;
                    }
                    Rules.SymbolSpec producer = symbolForFact(
                        facts, "return_origin", producerOrigin.id());
                    if (producer == null) producer = symbolForFact(facts, "return_origin", range.id());
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "loop_element", parameter, node, producerOrigin, element,
                        producer);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", parameter, owner, -1, element, typeSymbolByAbstract(element));
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", parameter, owner, producerOrigin, "collection_element", producer);
                }
            }
            if (node.kind() == PsiIndex.NodeKind.NAME_REF
                    && "boolean".equals(typeOf(facts, node))) {
                PsiIndex.Node branch = conditionOwner(node);
                if (branch != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "condition", node, branch, node, "true", null);
            } else if (node.kind() == PsiIndex.NodeKind.LITERAL
                    && "boolean".equals(literalType(node))) {
                PsiIndex.Node branch = conditionOwner(node);
                if (branch != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "condition", node, branch, node,
                    containsToken(node, "true") ? "true" : "false", null);
            }
        }
    }

    private void addEqualityWitnessOwner(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported, PsiIndex.Node syntax, PsiIndex.Node owner) {
        PsiIndex.Node boundary = conditionOwner(syntax);
        if (boundary != null && boundary.id() != syntax.id()) {
            addFact(facts, factKeys, multiplicities, unsupported,
                "witness_owner", syntax, owner, boundary, "equality", null);
            return;
        }
        addWitnessOwner(facts, factKeys, multiplicities, unsupported,
            syntax, owner, nearestWitnessOwner(syntax), "equality");
    }

    private void seedPrimitiveFailures(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            if (hasFact(facts, "call_resolution", node.id())
                    || hasFact(facts, "taint", node.id())) continue;
            boolean closedSyntax = node.kind() == PsiIndex.NodeKind.BINARY
                    && List.of("-", "*", "/", "&&", "||").contains(node.value())
                || node.kind() == PsiIndex.NodeKind.PREFIX
                    && List.of("-", "!").contains(node.value());
            if (!closedSyntax) continue;
            unsupported.put(node.id(), Boolean.TRUE);
            PsiIndex.Node owner = enclosingCallable(node);
            addTaint(facts, factKeys, multiplicities, unsupported,
                node, owner == null ? -1 : owner.id(), node.id(), "unknown_receiver");
        }
    }

    private PsiIndex.Node propertyAssignment(PsiIndex.Node access) {
        PsiIndex.Node qualified = qualifiedSelectorParent(access);
        PsiIndex.Node target = qualified == null ? access : qualified;
        Integer ownerId = lexicalOwners.get(target.id());
        if (ownerId == null) return null;
        PsiIndex.Node owner = program.node(ownerId);
        return owner.kind() == PsiIndex.NodeKind.ASSIGNMENT
                && isTarget(owner, PsiIndex.EdgeRole.TARGET, target) ? owner : null;
    }

    private Rules.SymbolSpec propertySymbolForTarget(PsiIndex.Node target,
            List<Map<String, Object>> facts) {
        PsiIndex.Node selector = target != null && (target.kind() == PsiIndex.NodeKind.QUALIFIED
                || target.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED)
            ? one(target, PsiIndex.EdgeRole.SELECTOR) : target;
        Rules.SymbolSpec symbol = selector == null ? null
            : symbolForFact(facts, "call_resolution", selector.id());
        return symbol != null && (symbol.kind().equals("member_property")
            || symbol.kind().equals("top_level_property")) ? symbol : null;
    }

    private PsiIndex.Node propertyReceiverForTarget(PsiIndex.Node target) {
        return target != null && (target.kind() == PsiIndex.NodeKind.QUALIFIED
            || target.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED)
            ? one(target, PsiIndex.EdgeRole.RECEIVER) : target;
    }

    private PsiIndex.Node enumEntryOperand(PsiIndex.Node left, PsiIndex.Node right,
            List<Map<String, Object>> facts) {
        String leftType = typeOf(facts, left);
        String rightType = typeOf(facts, right);
        if (left == null || right == null || leftType == null || !leftType.equals(rightType)) return null;
        boolean leftEntry = isExactEnumEntry(left, facts);
        boolean rightEntry = isExactEnumEntry(right, facts);
        return leftEntry == rightEntry ? null : leftEntry ? left : right;
    }

    private boolean isAmbiguousEnumEquality(PsiIndex.Node syntax,
            List<Map<String, Object>> facts) {
        if (syntax == null || syntax.kind() != PsiIndex.NodeKind.BINARY
                || !("==".equals(syntax.value()) || "!=".equals(syntax.value()))) return false;
        PsiIndex.Node left = one(syntax, PsiIndex.EdgeRole.LEFT);
        PsiIndex.Node right = one(syntax, PsiIndex.EdgeRole.RIGHT);
        return ambiguousEnumValue(left, facts) && isExactEnumEntry(right, facts)
            || ambiguousEnumValue(right, facts) && isExactEnumEntry(left, facts);
    }

    private boolean ambiguousEnumValue(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null || value.kind() != PsiIndex.NodeKind.NAME_REF
                || value.name() == null) return false;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
        if (declaration == null) declaration = findLexicalDeclaration(value, value.name());
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.PROPERTY_DECL) return false;
        PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
        List<PsiIndex.Node> alternatives = new ArrayList<>();
        if (initializer != null && initializer.kind() == PsiIndex.NodeKind.IF) {
            PsiIndex.Node thenBranch = one(initializer, PsiIndex.EdgeRole.THEN_BRANCH);
            PsiIndex.Node elseBranch = one(initializer, PsiIndex.EdgeRole.ELSE_BRANCH);
            if (thenBranch != null) alternatives.add(branchResult(thenBranch));
            if (elseBranch != null) alternatives.add(branchResult(elseBranch));
        } else if (initializer != null && initializer.kind() == PsiIndex.NodeKind.WHEN) {
            for (PsiIndex.Node entry : targets(initializer, PsiIndex.EdgeRole.ENTRY)) {
                PsiIndex.Node body = one(entry, PsiIndex.EdgeRole.BODY);
                if (body != null) alternatives.add(branchResult(body));
            }
        } else return false;
        String identity = null;
        boolean distinct = false;
        int count = 0;
        for (PsiIndex.Node alternative : alternatives) {
            if (alternative == null || !isExactEnumEntry(alternative, facts)) return false;
            PsiIndex.Node selector = alternative.kind() == PsiIndex.NodeKind.QUALIFIED
                ? one(alternative, PsiIndex.EdgeRole.SELECTOR) : alternative;
            Rules.SymbolSpec symbol = selector == null ? null
                : symbolForFact(facts, "call_resolution", selector.id());
            if (symbol == null) return false;
            String current = symbol.fqn() + "\n" + symbol.signature();
            if (identity != null && !identity.equals(current)) distinct = true;
            if (identity == null) identity = current;
            count++;
        }
        return count >= 2 && distinct;
    }

    private PsiIndex.Node branchResult(PsiIndex.Node branch) {
        PsiIndex.Node result = branch.kind() == PsiIndex.NodeKind.BLOCK
            ? normalExit(branch) : branch;
        return result != null && result.kind() == PsiIndex.NodeKind.RETURN
            ? one(result, PsiIndex.EdgeRole.RETURN_VALUE) : result;
    }

    private boolean isExactEnumEntry(PsiIndex.Node node, List<Map<String, Object>> facts) {
        PsiIndex.Node selector = node.kind() == PsiIndex.NodeKind.QUALIFIED
            ? one(node, PsiIndex.EdgeRole.SELECTOR) : node;
        Rules.SymbolSpec symbol = selector == null ? null
            : symbolForFact(facts, "call_resolution", selector.id());
        if (symbol == null || !symbol.kind().equals("member_property")
                || !symbol.receiverKind().equals("declaring_type")) return false;
        Rules.SymbolSpec owner = memberOwnerType(symbol);
        return owner != null && owner.signature().startsWith("enum class ");
    }

    private void seedReadsWritesAndAuthority(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            PsiIndex.Node owner = enclosingCallable(node);
            if (node.kind() == PsiIndex.NodeKind.NAME_REF && node.name() != null
                    && !isCalleeOrTypeName(node)) {
                PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", node.id());
                if (declaration != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "read", node, owner, declaration, "", null);
            }
            if (node.kind() != PsiIndex.NodeKind.PROPERTY_DECL || node.name() == null
                    || !isProductionPath(node.fileId())) continue;
            PsiIndex.Node authorityOwner = authorityOwner(node);
            if (authorityOwner == null) continue;
            List<PsiIndex.Node> origins = propertyOrigins(node);
            if (origins.size() != 1) {
                unsupported.put(node.id(), Boolean.TRUE);
                addTaint(facts, factKeys, multiplicities, unsupported,
                    node, -1, node.id(), origins.isEmpty() ? "unknown_return" : "ambiguous");
                continue;
            }
            if (!node.flags().contains(PsiIndex.NodeFlag.VAL)) continue;
            PsiIndex.Node source = origins.get(0);
            if (isFreshConstruction(source, facts)) continue;
            addFact(facts, factKeys, multiplicities, unsupported,
                "origin", node, authorityOwner, source, "retained", null);
            String kind = authorityOwner.kind() == PsiIndex.NodeKind.OBJECT_DECL ? "object"
                : authorityOwner.kind() == PsiIndex.NodeKind.COMPANION_DECL ? "companion" : "top_level";
            addFact(facts, factKeys, multiplicities, unsupported,
                "strong_authority", node, authorityOwner, source, kind, null);
        }
    }

    private void seedRetainedExits(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node loop : program.nodes()) {
            if (loop.kind() != PsiIndex.NodeKind.FOR && loop.kind() != PsiIndex.NodeKind.WHILE) continue;
            PsiIndex.Node success = relatedNodeForFact(facts, "loop_success", loop.id());
            if (success == null) continue;
            PsiIndex.Node retained = planeRetryRetainedCandidate(loop, success, facts);
            if (retained != null) addFact(facts, factKeys, multiplicities, unsupported,
                "retained_exit", retained, loop, success, "", null);
        }
    }

    private PsiIndex.Node planeRetryRetainedCandidate(PsiIndex.Node loop,
            PsiIndex.Node success, List<Map<String, Object>> facts) {
        PsiIndex.Node retained = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.ASSIGNMENT || !isWithin(candidate, loop)
                    || candidate.startUtf16() >= success.startUtf16()
                    || isCanonicalLoopIncrement(loop, candidate, facts)) continue;
            if (retained == null || candidate.startUtf16() > retained.startUtf16()) {
                retained = candidate;
            }
        }
        return retained;
    }

    private boolean isCanonicalLoopIncrement(PsiIndex.Node loop, PsiIndex.Node assignment,
            List<Map<String, Object>> facts) {
        if (loop.kind() != PsiIndex.NodeKind.WHILE || !"+=".equals(assignment.value())
                || !isExactIntegerOne(one(assignment, PsiIndex.EdgeRole.VALUE))) return false;
        PsiIndex.Node condition = one(loop, PsiIndex.EdgeRole.CONDITION);
        PsiIndex.Node target = one(assignment, PsiIndex.EdgeRole.TARGET);
        if (condition == null || condition.kind() != PsiIndex.NodeKind.BINARY
                || target == null || target.kind() != PsiIndex.NodeKind.NAME_REF) return false;
        PsiIndex.Node left = one(condition, PsiIndex.EdgeRole.LEFT);
        PsiIndex.Node right = one(condition, PsiIndex.EdgeRole.RIGHT);
        PsiIndex.Node counter = left != null && left.kind() == PsiIndex.NodeKind.NAME_REF ? left
            : right != null && right.kind() == PsiIndex.NodeKind.NAME_REF ? right : null;
        if (counter == null || !target.name().equals(counter.name())) return false;
        PsiIndex.Node counterDeclaration = relatedNodeForFact(facts, "def_use", counter.id());
        if (counterDeclaration == null) {
            counterDeclaration = findLexicalDeclaration(counter, counter.name());
        }
        PsiIndex.Node targetDeclaration = findLexicalDeclaration(target, target.name());
        return counterDeclaration != null && targetDeclaration != null
            && counterDeclaration.id() == targetDeclaration.id();
    }

    private void seedPairedEffects(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        List<PsiIndex.Node> acquisitions = new ArrayList<>();
        List<PsiIndex.Node> releases = new ArrayList<>();
        for (PsiIndex.Node node : program.nodes()) {
            Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", node.id());
            if (symbol == null) continue;
            if (hasEffect(facts, node, "acquire")) acquisitions.add(node);
            if (hasEffect(facts, node, "release")) releases.add(node);
        }
        for (PsiIndex.Node acquisition : acquisitions) {
            Rules.SymbolSpec acquireSymbol = symbolForFact(facts, "call_resolution", acquisition.id());
            String family = pairFamily(acquireSymbol, "acquire");
            String key = pairKey(acquisition, acquireSymbol, family, facts);
            PsiIndex.Node lifecycleOwner = lifecycleOwner(acquisition, facts);
            if (family == null || key == null || lifecycleOwner == null) continue;
            PsiIndex.Node match = null;
            for (PsiIndex.Node release : releases) {
                Rules.SymbolSpec releaseSymbol = symbolForFact(facts, "call_resolution", release.id());
                PsiIndex.Node releaseOwner = lifecycleOwner(release, facts);
                if (!family.equals(pairFamily(releaseSymbol, "release"))
                        || !key.equals(pairKey(release, releaseSymbol, family, facts))
                        || releaseOwner == null || releaseOwner.id() != lifecycleOwner.id()) continue;
                if (match != null) {
                    match = null;
                    break;
                }
                match = release;
            }
            if (match == null) continue;
            Rules.SymbolSpec releaseSymbol = symbolForFact(facts, "call_resolution", match.id());
            addFact(facts, factKeys, multiplicities, unsupported,
                "paired_effect", acquisition, lifecycleOwner, match, family, acquireSymbol);
            addFact(facts, factKeys, multiplicities, unsupported,
                "paired_effect", match, lifecycleOwner, acquisition, family, releaseSymbol);
        }
    }

    private void seedIdentityAndDominance(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        List<PsiIndex.Node> semanticSubjects = identitySubjects(facts);
        for (PsiIndex.Node node : semanticSubjects) {
            PsiIndex.Node pair = relatedNodeForFact(facts, "paired_effect", node.id());
            if (pair != null) addFact(facts, factKeys, multiplicities, unsupported,
                "same_origin", node, lifecycleOwner(node, facts), pair, "resource", null);

            Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", node.id());
            String elementDimension = elementDimension(symbol);
            if (elementDimension != null && !elementDimension.equals("selection")) {
                PsiIndex.Node callback = enclosingLambda(node);
                PsiIndex.Node parameter = callbackElementParameter(callback, facts);
                PsiIndex.Node receiver = node.kind() == PsiIndex.NodeKind.CALL
                    ? resolvedReceiver(node) : qualifiedSelectorParent(node) == null ? null
                    : one(qualifiedSelectorParent(node), PsiIndex.EdgeRole.RECEIVER);
                PsiIndex.Node receiverOrigin = representativeOrigin(receiver, facts);
                PsiIndex.Node parameterOrigin = representativeOrigin(parameter, facts);
                PsiIndex.Node invocation = callbackInvocation(callback, facts);
                Rules.SymbolSpec invocationSymbol = invocation == null ? null
                    : symbolForFact(facts, "call_resolution", invocation.id());
                if (parameter != null && invocationSymbol != null
                        && invocationSymbol.fqn().equals("kotlin.collections.filter")
                        && invocationSymbol.signature().equals(
                            "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>")
                        && predicateDimensionSurvives(callback, elementDimension, parameter, facts)
                        && receiverOrigin != null && parameterOrigin != null
                        && receiverOrigin.id() == parameterOrigin.id()) {
                    PsiIndex.Node decisive = elementDimension.equals("orientation")
                        ? enclosingBinary(node, "||") : enclosingComparison(node);
                    if (invocation != null && decisive != null) addFact(
                        facts, factKeys, multiplicities, unsupported,
                        "same_element", invocation, enclosingCallable(invocation), decisive,
                        elementDimension, null);
                }
            }
            if (elementDimension != null && elementDimension.equals("selection")) {
                PsiIndex.Node callback = callbackExpressionForCall(node, facts);
                PsiIndex.Node result = callback == null ? null
                    : relatedNodeForFact(facts, "callback_result", callback.id());
                PsiIndex.Node parameter = callbackElementParameter(callback, facts);
                PsiIndex.Node receiverOrigin = representativeOrigin(resolvedReceiver(node), facts);
                PsiIndex.Node parameterOrigin = representativeOrigin(parameter, facts);
                PsiIndex.Node resultOrigin = representativeOrigin(result, facts);
                if (result != null && receiverOrigin != null && parameterOrigin != null
                        && resultOrigin != null
                        && receiverOrigin.id() == parameterOrigin.id()
                        && resultOrigin.id() == parameterOrigin.id()) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "same_element", node, enclosingCallable(node), result, "selection", null);
            }
            PsiIndex.Node readinessControl = isExactPlaneTransform(symbol)
                ? exactReadinessControl(node, facts) : null;
            PsiIndex.Node control = readinessControl == null
                ? nearestControlBoundary(node) : readinessControl;
            if (control != null && (node.kind() == PsiIndex.NodeKind.CALL
                    || node.kind() == PsiIndex.NodeKind.ASSIGNMENT
                    || hasFact(facts, "effect", node.id()))) addFact(
                facts, factKeys, multiplicities, unsupported,
                "dominates", node, enclosingCallable(node), control, "control", null);

            if (isExactPlaneTransform(symbol)) {
                PsiIndex.Node receiver = qualifiedSelectorParent(node) == null ? null
                    : one(qualifiedSelectorParent(node), PsiIndex.EdgeRole.RECEIVER);
                PsiIndex.Node selector = exactInitializerCall(receiver,
                    "kotlin.collections.maxByOrNull",
                    "Iterable<T>.maxByOrNull(selector: (T) -> R): T?", facts);
                if (selector != null) {
                    PsiIndex.Node receiverOrigin = representativeOrigin(receiver, facts);
                    PsiIndex.Node selectorOrigin = representativeOrigin(selector, facts);
                    if (receiverOrigin != null && selectorOrigin != null
                            && receiverOrigin.id() == selectorOrigin.id()) {
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "same_origin", node, enclosingCallable(node), selector, "pose", null);
                        propagateElementDominance(node, selector, facts, factKeys,
                            multiplicities, unsupported);
                    }
                }
            }
        }
        seedSourcePredicateDimensions(
            facts, factKeys, multiplicities, unsupported);
        Map<String, List<PsiIndex.Node>> originGroups = new HashMap<>();
        for (PsiIndex.Node left : semanticSubjects) {
            Rules.SymbolSpec leftSymbol = symbolForFact(facts, "call_resolution", left.id());
            String dimension = originDimension(leftSymbol, facts, left);
            if (dimension == null) continue;
            PsiIndex.Node leftTarget = effectRepresentative(left, facts);
            if (leftTarget == null) continue;
            originGroups.computeIfAbsent(dimension + "\n" + leftTarget.id(),
                ignored -> new ArrayList<>()).add(left);
        }
        for (Map.Entry<String, List<PsiIndex.Node>> entry : originGroups.entrySet()) {
            List<PsiIndex.Node> group = entry.getValue();
            if (group.size() != 2) continue;
            String dimension = entry.getKey().substring(0, entry.getKey().indexOf('\n'));
            addFact(facts, factKeys, multiplicities, unsupported,
                "same_origin", group.get(0), enclosingCallable(group.get(0)), group.get(1), dimension, null);
            addFact(facts, factKeys, multiplicities, unsupported,
                "same_origin", group.get(1), enclosingCallable(group.get(1)), group.get(0), dimension, null);
        }
    }

    private void seedSourcePredicateDimensions(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        Rules.SymbolSpec filter = domainSymbolOrNull(
            "kotlin.collections.filter",
            "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>");
        Rules.SymbolSpec plane = typeSymbolExact(
            "com.pico.spatial.sense.plane.PlaneAnchor", "class PlaneAnchor");
        if (filter == null || plane == null) return;
        for (PsiIndex.Node invocation : program.nodes()) {
            if (invocation.kind() != PsiIndex.NodeKind.CALL
                    || !exactDomainResolution(invocation, filter, facts)) continue;
            PsiIndex.Node callback = callbackExpressionForCall(invocation, facts);
            PsiIndex.Node callbackParameter = callbackElementParameter(callback, facts);
            PsiIndex.Node result = callbackResult(callback);
            if (callback == null || callback.kind() != PsiIndex.NodeKind.LAMBDA
                    || callbackParameter == null || result == null
                    || !"plane_anchor".equals(typeOf(facts, callbackParameter))
                    || physicalTypeForOrigin(callbackParameter, facts) != plane) continue;
            for (String dimension : List.of("orientation", "area")) {
                PsiIndex.Node decisive = null;
                boolean ambiguous = false;
                for (PsiIndex.Node call : program.nodes()) {
                    if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, result)) continue;
                    PsiIndex.Node helper = exactSourceTarget(call, facts);
                    PsiIndex.Node helperResult = sourceReturnOrigin(helper);
                    List<PsiIndex.Node> parameters = helper == null
                        ? List.of() : targets(helper, PsiIndex.EdgeRole.PARAMETER);
                    PsiIndex.Node parameter = parameters.size() == 1 ? parameters.get(0) : null;
                    Map<Integer, List<PsiIndex.Node>> mapping = helper == null
                        ? null : mapSourceArguments(call, helper, facts);
                    PsiIndex.Node argument = mappedArgument(mapping, 0);
                    PsiIndex.Node value = argumentValue(argument);
                    PsiIndex.Node valueOrigin = representativeOrigin(value, facts);
                    PsiIndex.Node callbackOrigin = representativeOrigin(callbackParameter, facts);
                    if (!planePureDimensionHelper(helper, parameter, dimension, plane, facts)
                            || helperResult == null
                            || valueOrigin == null || callbackOrigin == null
                            || valueOrigin.id() != callbackOrigin.id()
                            || !expressionProvesDimension(
                                helperResult, dimension, parameter, facts)) continue;
                    PsiIndex.Node candidate = dimension.equals("orientation")
                        ? helperResult : enclosingComparison(call);
                    if (candidate == null || decisive != null && decisive.id() != candidate.id()) {
                        ambiguous = true;
                        break;
                    }
                    decisive = candidate;
                }
                if (!ambiguous && decisive != null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "same_element", invocation, enclosingCallable(invocation), decisive,
                    dimension, null);
            }
        }
    }

    private boolean planePureDimensionHelper(PsiIndex.Node helper,
            PsiIndex.Node parameter, String dimension, Rules.SymbolSpec plane,
            List<Map<String, Object>> facts) {
        String expectedResult = dimension.equals("orientation") ? "boolean"
            : dimension.equals("area") ? "float" : null;
        if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                || !helper.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || !helper.flags().contains(PsiIndex.NodeFlag.EXPRESSION_BODY)
                || !isProductionPath(helper.fileId()) || hasAnyTaint(helper, facts)
                || callbackHasUnknownCall(helper, facts)
                || !expectedResult.equals(declaredSemanticType(helper))
                || parameter == null || !"plane_anchor".equals(declaredSemanticType(parameter))
                || typeSymbolForReference(declarationTypeNode(parameter, false)) != plane) return false;
        for (PsiIndex.Node node : program.nodes()) {
            if (!isWithin(node, helper)) continue;
            if (node.kind() == PsiIndex.NodeKind.ASSIGNMENT
                    || node.kind() == PsiIndex.NodeKind.RETURN
                    || node.kind() == PsiIndex.NodeKind.IF
                    || node.kind() == PsiIndex.NodeKind.WHEN
                    || node.kind() == PsiIndex.NodeKind.FOR
                    || node.kind() == PsiIndex.NodeKind.WHILE
                    || node.kind() == PsiIndex.NodeKind.TRY) return false;
            if (node.kind() == PsiIndex.NodeKind.CALL) return false;
        }
        return true;
    }

    private List<PsiIndex.Node> identitySubjects(List<Map<String, Object>> facts) {
        List<PsiIndex.Node> subjects = new ArrayList<>();
        Map<Integer, Boolean> seen = new HashMap<>();
        for (Map<String, Object> fact : facts) {
            String kind = (String) fact.get("kind");
            if (!kind.equals("call_resolution") && !kind.equals("effect")
                    && !kind.equals("paired_effect")) continue;
            int subject = ((Long) fact.get("subjectNodeId")).intValue();
            if (seen.put(subject, Boolean.TRUE) == null) subjects.add(program.node(subject));
        }
        return subjects;
    }

    private boolean predicateDimensionSurvives(PsiIndex.Node callback, String dimension,
            PsiIndex.Node parameter, List<Map<String, Object>> facts) {
        PsiIndex.Node result = callbackResult(callback);
        return result != null && expressionProvesDimension(result, dimension, parameter, facts);
    }

    private boolean expressionProvesDimension(PsiIndex.Node expression, String dimension,
            PsiIndex.Node parameter, List<Map<String, Object>> facts) {
        if (expression == null) return false;
        if (expression.kind() == PsiIndex.NodeKind.BINARY) {
            PsiIndex.Node left = one(expression, PsiIndex.EdgeRole.LEFT);
            PsiIndex.Node right = one(expression, PsiIndex.EdgeRole.RIGHT);
            if ("||".equals(expression.value())) return expressionProvesDimension(
                left, dimension, parameter, facts) && expressionProvesDimension(
                right, dimension, parameter, facts);
            if ("&&".equals(expression.value())) return expressionProvesDimension(
                left, dimension, parameter, facts) || expressionProvesDimension(
                right, dimension, parameter, facts);
            if (dimension.equals("area") && List.of("+", "-", "*", "/").contains(
                    expression.value())) {
                PsiIndex.Node expressionOrigin = representativeOrigin(expression, facts);
                PsiIndex.Node parameterOrigin = representativeOrigin(parameter, facts);
                return expressionOrigin != null && parameterOrigin != null
                    && expressionOrigin.id() == parameterOrigin.id()
                    && containsElementDimension(expression, dimension, parameter, facts);
            }
        } else if (expression.kind() == PsiIndex.NodeKind.PREFIX
                && "!".equals(expression.value())) {
            return expressionProvesDimension(one(expression, PsiIndex.EdgeRole.OPERAND),
                dimension, parameter, facts);
        }
        Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", expression.id());
        if (dimension.equals(elementDimension(symbol))) {
            PsiIndex.Node qualified = qualifiedSelectorParent(expression);
            PsiIndex.Node receiver = qualified == null ? resolvedReceiver(expression)
                : one(qualified, PsiIndex.EdgeRole.RECEIVER);
            PsiIndex.Node receiverOrigin = representativeOrigin(receiver, facts);
            PsiIndex.Node parameterOrigin = representativeOrigin(parameter, facts);
            if (receiverOrigin != null && parameterOrigin != null
                    && receiverOrigin.id() == parameterOrigin.id()) return true;
        }
        for (PsiIndex.Node child : lexicalChildren(expression)) {
            if (expressionProvesDimension(child, dimension, parameter, facts)) return true;
        }
        return false;
    }

    private boolean containsElementDimension(PsiIndex.Node expression, String dimension,
            PsiIndex.Node parameter, List<Map<String, Object>> facts) {
        if (expression == null) return false;
        Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", expression.id());
        if (dimension.equals(elementDimension(symbol))) {
            PsiIndex.Node qualified = qualifiedSelectorParent(expression);
            PsiIndex.Node receiver = qualified == null ? resolvedReceiver(expression)
                : one(qualified, PsiIndex.EdgeRole.RECEIVER);
            PsiIndex.Node receiverOrigin = representativeOrigin(receiver, facts);
            PsiIndex.Node parameterOrigin = representativeOrigin(parameter, facts);
            if (receiverOrigin != null && parameterOrigin != null
                    && receiverOrigin.id() == parameterOrigin.id()) return true;
        }
        for (PsiIndex.Node child : lexicalChildren(expression)) {
            if (containsElementDimension(child, dimension, parameter, facts)) return true;
        }
        return false;
    }

    private boolean hasEffect(List<Map<String, Object>> facts, PsiIndex.Node subject, String effect) {
        for (Map<String, Object> fact : facts) {
            if (fact.get("kind").equals("effect") && fact.get("value").equals(effect)
                    && fact.get("subjectNodeId").equals((long) subject.id())) return true;
        }
        return false;
    }

    private String pairFamily(Rules.SymbolSpec symbol, String effect) {
        if (symbol == null) return null;
        if ((effect.equals("acquire") && symbol.fqn().equals("com.pico.spatial.ui.foundation.dsl.registerSystem")
                && symbol.signature().equals("registerSystem<T : System>(): Unit")
                || effect.equals("release") && symbol.fqn().equals("com.pico.spatial.ui.foundation.dsl.unregisterSystem")
                && symbol.signature().equals("unregisterSystem<T : System>(): Unit"))) return "ecs_system_lifecycle";
        if ((effect.equals("acquire") && symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneTrackingManager.start")
                && symbol.signature().equals("start(): Unit")
                || effect.equals("release") && symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneTrackingManager.stop")
                && symbol.signature().equals("stop(): Unit"))) return "plane_tracking";
        if ((effect.equals("acquire") && "cancellable".equals(symbol.returnAbstractType())
                || effect.equals("release") && symbol.fqn().equals("com.pico.spatial.core.lifecycle.Cancellable.cancel")
                && symbol.signature().equals("cancel(): Unit"))) return "cancellable_resource";
        return null;
    }

    private String pairKey(PsiIndex.Node call, Rules.SymbolSpec symbol, String family,
            List<Map<String, Object>> facts) {
        if (family == null) return null;
        if (family.equals("ecs_system_lifecycle")) {
            List<PsiIndex.Node> typeArguments = targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT);
            if (typeArguments.size() != 1) return null;
            PsiIndex.Node declaration = sourceTypeDeclaration(typeArguments.get(0));
            Rules.SymbolSpec physical = typeSymbolForReference(typeArguments.get(0));
            if (declaration != null) return "source:" + declaration.id();
            return physical == null ? null : "domain:" + physical.fqn() + "\n" + physical.signature();
        }
        if (family.equals("plane_tracking")) {
            PsiIndex.Node target = resolvedReceiver(call);
            if (target == null) target = implicitReceiver(call, symbol, facts);
            PsiIndex.Node representative = representativeOrigin(target, facts);
            return representative == null ? null : "origin:" + representative.id();
        }
        if (hasEffect(facts, call, "acquire")) return "origin:" + call.id();
        PsiIndex.Node representative = representativeOrigin(resolvedReceiver(call), facts);
        return representative == null ? null : "origin:" + representative.id();
    }

    private PsiIndex.Node lifecycleOwner(PsiIndex.Node node, List<Map<String, Object>> facts) {
        PsiIndex.Node acquisition = activeAcquisitionOwner(node, facts);
        return acquisition == null ? enclosingCallable(node) : acquisition;
    }

    private String elementDimension(Rules.SymbolSpec symbol) {
        if (symbol == null) return null;
        if (symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneAnchor.semantics")
                && symbol.signature().equals("semantics: SemanticLabelType")) return "semantic";
        if (symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneAnchor.planeOrientation")
                && symbol.signature().equals("planeOrientation: PlaneOrientation")) return "orientation";
        if (symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneAnchor.boundingBoxSize")
                && symbol.signature().equals("boundingBoxSize: Vector2")) return "area";
        if (symbol.fqn().equals("kotlin.collections.maxByOrNull")
                && symbol.signature().equals("Iterable<T>.maxByOrNull(selector: (T) -> R): T?")) return "selection";
        return null;
    }

    private PsiIndex.Node callbackElementParameter(PsiIndex.Node callback,
            List<Map<String, Object>> facts) {
        if (callback == null) return null;
        PsiIndex.Node parameterOwner = callback.kind() == PsiIndex.NodeKind.CALLABLE_REF
            ? uniqueReferencedCallable(callback) : callback;
        if (parameterOwner == null) return null;
        for (Map<String, Object> fact : facts) {
            if (!fact.get("kind").equals("callback_parameter")
                    || !fact.get("ownerNodeId").equals((long) parameterOwner.id())) continue;
            long subject = (Long) fact.get("subjectNodeId");
            return program.node((int) subject);
        }
        return null;
    }

    private PsiIndex.Node enclosingComparison(PsiIndex.Node node) {
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.BINARY
                    && ("==".equals(candidate.value()) || "!=".equals(candidate.value())
                    || "<".equals(candidate.value()) || "<=".equals(candidate.value())
                    || ">".equals(candidate.value()) || ">=".equals(candidate.value()))) return candidate;
            if (candidate.kind() == PsiIndex.NodeKind.LAMBDA) return null;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private PsiIndex.Node enclosingBinary(PsiIndex.Node node, String operator) {
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.BINARY
                    && operator.equals(candidate.value())) return candidate;
            if (candidate.kind() == PsiIndex.NodeKind.LAMBDA) return null;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private PsiIndex.Node callbackInvocation(PsiIndex.Node callback,
            List<Map<String, Object>> facts) {
        if (callback == null) return null;
        Integer match = null;
        for (Map<String, Object> fact : facts) {
            if (!fact.get("kind").equals("callback_binding")
                    || !fact.get("subjectNodeId").equals((long) callback.id())) continue;
            int owner = ((Long) fact.get("ownerNodeId")).intValue();
            if (owner < 0 || match != null && match != owner) return null;
            match = owner;
        }
        return match == null ? null : program.node(match);
    }

    private PsiIndex.Node callbackExpressionForCall(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        if (call == null) return null;
        Integer match = null;
        for (Map<String, Object> fact : facts) {
            if (!fact.get("kind").equals("callback_binding")
                    || !fact.get("ownerNodeId").equals((long) call.id())) continue;
            int subject = ((Long) fact.get("subjectNodeId")).intValue();
            if (match != null && match != subject) return null;
            match = subject;
        }
        return match == null ? null : program.node(match);
    }

    private boolean isExactPlaneTransform(Rules.SymbolSpec symbol) {
        return symbol != null
            && symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneAnchor.transform")
            && symbol.signature().equals("transform: Transform");
    }

    private PsiIndex.Node exactInitializerCall(PsiIndex.Node use, String fqn, String signature,
            List<Map<String, Object>> facts) {
        if (use == null) return null;
        PsiIndex.Node declaration = use.kind() == PsiIndex.NodeKind.NAME_REF
            ? relatedNodeForFact(facts, "def_use", use.id()) : null;
        if (declaration == null && use.kind() == PsiIndex.NodeKind.NAME_REF) {
            declaration = findLexicalDeclaration(use, use.name());
        }
        PsiIndex.Node initializer = declaration == null ? use
            : one(declaration, PsiIndex.EdgeRole.INITIALIZER);
        if (initializer == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.CALL
                    || !(candidate.id() == initializer.id() || isWithin(candidate, initializer))) continue;
            Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", candidate.id());
            if (symbol == null || !symbol.fqn().equals(fqn)
                    || !symbol.signature().equals(signature)) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private void propagateElementDominance(PsiIndex.Node consumer, PsiIndex.Node selector,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        PsiIndex.Node filter = exactInitializerCall(resolvedReceiver(selector),
            "kotlin.collections.filter",
            "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>", facts);
        if (filter == null) return;
        for (Map<String, Object> fact : new ArrayList<>(facts)) {
            if (!fact.get("kind").equals("same_element")
                    || !fact.get("subjectNodeId").equals((long) filter.id())) continue;
            int related = ((Long) fact.get("relatedNodeId")).intValue();
            if (related < 0) continue;
            String value = (String) fact.get("value");
            String dominance = value.equals("orientation") ? "horizontal" : value;
            if (!List.of("semantic", "horizontal", "area").contains(dominance)) continue;
            addFact(facts, factKeys, multiplicities, unsupported,
                "dominates", consumer, enclosingCallable(consumer), program.node(related), dominance, null);
        }
    }

    private PsiIndex.Node nearestControlBoundary(PsiIndex.Node node) {
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) return candidate;
            PsiIndex.Node condition = candidate.kind() == PsiIndex.NodeKind.IF
                || candidate.kind() == PsiIndex.NodeKind.WHILE
                ? one(candidate, PsiIndex.EdgeRole.CONDITION)
                : candidate.kind() == PsiIndex.NodeKind.FOR
                ? one(candidate, PsiIndex.EdgeRole.RANGE) : null;
            if (condition != null) return condition;
            if (candidate.kind() == PsiIndex.NodeKind.WHEN_ENTRY) {
                List<PsiIndex.Node> conditions = targets(candidate, PsiIndex.EdgeRole.CONDITION);
                if (conditions.size() == 1) return conditions.get(0);
            }
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private PsiIndex.Node exactReadinessControl(PsiIndex.Node node,
            List<Map<String, Object>> facts) {
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node control = program.node(owner);
            if (control.kind() == PsiIndex.NodeKind.IF
                    || control.kind() == PsiIndex.NodeKind.WHILE) {
                PsiIndex.Node match = null;
                for (Map<String, Object> fact : facts) {
                    if (!"condition".equals(fact.get("kind"))
                            || !Long.valueOf(control.id()).equals(fact.get("ownerNodeId"))) continue;
                    String value = (String) fact.get("value");
                    if (!value.equals("readiness_positive")
                            && !value.equals("readiness_negative")) continue;
                    int subjectId = ((Long) fact.get("subjectNodeId")).intValue();
                    PsiIndex.Node candidate = program.node(subjectId);
                    if (match != null && match.id() != candidate.id()) return null;
                    match = candidate;
                }
                if (match != null) return match;
            }
            owner = lexicalOwners.get(control.id());
        }
        return null;
    }

    private PsiIndex.Node conditionOwner(PsiIndex.Node condition) {
        if (condition == null) return null;
        Integer owner = lexicalOwners.get(condition.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.IF
                    || candidate.kind() == PsiIndex.NodeKind.WHILE) {
                PsiIndex.Node expected = one(candidate, PsiIndex.EdgeRole.CONDITION);
                if (expected != null && (expected.id() == condition.id()
                        || isWithin(condition, expected))) return candidate;
            } else if (candidate.kind() == PsiIndex.NodeKind.WHEN_ENTRY) {
                for (PsiIndex.Node expected : targets(candidate, PsiIndex.EdgeRole.CONDITION)) {
                    if (expected.id() == condition.id() || isWithin(condition, expected)) return candidate;
                }
            }
            if (candidate.kind() == PsiIndex.NodeKind.LAMBDA
                    || candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL) return null;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private String originDimension(Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts, PsiIndex.Node node) {
        if (symbol == null || !hasFact(facts, "effect", node.id())) return null;
        if (symbol.receiverAbstractType() != null
                && symbol.receiverAbstractType().equals("spatial_navigator")) return "navigation";
        if (symbol.effects().contains("convert") || symbol.receiverAbstractType() != null
                && (symbol.receiverAbstractType().equals("transform")
                || symbol.receiverAbstractType().equals("vector3")
                || symbol.receiverAbstractType().equals("quat"))) return "pose";
        if (symbol.effects().contains("acquire") || symbol.effects().contains("release")) return "resource";
        if (symbol.effects().contains("mutate") || symbol.effects().contains("replace")
                || symbol.effects().contains("status_assign")) return "state";
        return null;
    }

    private PsiIndex.Node effectRepresentative(PsiIndex.Node effect,
            List<Map<String, Object>> facts) {
        PsiIndex.Node target = relatedNodeForFact(facts, "effect", effect.id());
        return representativeOrigin(target, facts);
    }

    private List<PsiIndex.Node> sourceCallableCandidates(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> members = sourceMemberCandidates(call, facts);
        if (!members.isEmpty()) return members;
        List<PsiIndex.Node> lexical = new ArrayList<>();
        List<PsiIndex.Node> sameFile = new ArrayList<>();
        List<PsiIndex.Node> samePackage = new ArrayList<>();
        List<PsiIndex.Node> imported = new ArrayList<>();
        String packageName = program.file(call.fileId()).packageName();
        String importedFqn = importedFqn(call.fileId(), call.name());
        PsiIndex.Node callOwner = enclosingCallable(call);
        for (PsiIndex.Node declaration : program.nodes()) {
            if (declaration.name() == null || !(declaration.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || declaration.kind() == PsiIndex.NodeKind.CLASS_DECL)) continue;
            String declarationPackage = program.file(declaration.fileId()).packageName();
            String declarationFqn = declarationPackage.isEmpty() ? declaration.name()
                : declarationPackage + "." + declaration.name();
            boolean directName = declaration.name().equals(call.name());
            boolean importedName = importedFqn != null && importedFqn.equals(declarationFqn);
            if (!directName && !importedName) continue;
            if (declaration.kind() == PsiIndex.NodeKind.FUNCTION_DECL && isWithin(call, declaration)) continue;
            PsiIndex.Node declarationOwner = enclosingCallable(declaration);
            if (directName && declaration.fileId() == call.fileId()
                    && declarationOwner != null && declarationOwner == callOwner
                    && declaration.id() < call.id()) lexical.add(declaration);
            else if (directName && declaration.fileId() == call.fileId()
                    && isTopLevel(declaration)) sameFile.add(declaration);
            else if (directName && declarationPackage.equals(packageName)
                    && isTopLevel(declaration)) samePackage.add(declaration);
            else if (importedName && isTopLevel(declaration)) imported.add(declaration);
        }
        if (!lexical.isEmpty()) return lexical;
        if (!sameFile.isEmpty()) return sameFile;
        if (!samePackage.isEmpty()) return samePackage;
        return imported;
    }

    private List<PsiIndex.Node> sourceMemberCandidates(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> matches = new ArrayList<>();
        PsiIndex.Node receiver = resolvedReceiver(call);
        boolean implicitDispatch = receiver == null && qualifiedParent(call) == null;
        PsiIndex.Node sourceType = implicitDispatch
            ? enclosingTypeDeclaration(call) : sourceTypeForValue(receiver, facts);
        if (sourceType == null || call.name() == null) return matches;
        PsiIndex.Node receiverDeclaration = sourceValueDeclaration(receiver, facts);
        List<PsiIndex.Node> containers = new ArrayList<>();
        if (implicitDispatch || sourceType.kind() == PsiIndex.NodeKind.OBJECT_DECL) {
            containers.add(sourceType);
        }
        else if (receiverDeclaration != null && isTypeDeclaration(receiverDeclaration)) {
            for (PsiIndex.Node child : lexicalChildren(sourceType)) {
                if (child.kind() == PsiIndex.NodeKind.COMPANION_DECL) containers.add(child);
            }
        } else containers.add(sourceType);
        for (PsiIndex.Node container : containers) {
            for (PsiIndex.Node candidate : lexicalChildren(container)) {
                if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                        && call.name().equals(candidate.name())
                        && (implicitDispatch
                            || !candidate.flags().contains(PsiIndex.NodeFlag.PRIVATE))) {
                    matches.add(candidate);
                }
            }
        }
        return matches;
    }

    private PsiIndex.Node sourceValueDeclaration(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null) return null;
        if (isTypeDeclaration(value)) return value;
        if (value.kind() != PsiIndex.NodeKind.NAME_REF || value.name() == null) return null;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
        return declaration == null ? findLexicalDeclaration(value, value.name()) : declaration;
    }

    private PsiIndex.Node sourceQualifierOrigin(PsiIndex.Node receiver,
            PsiIndex.Node declaration, List<Map<String, Object>> facts) {
        if (receiver == null || declaration == null) return null;
        Integer ownerId = lexicalOwners.get(declaration.id());
        if (ownerId == null) return null;
        PsiIndex.Node declarationOwner = program.node(ownerId);
        if (declarationOwner.kind() == PsiIndex.NodeKind.OBJECT_DECL
                || declarationOwner.kind() == PsiIndex.NodeKind.COMPANION_DECL) return declarationOwner;
        if (declarationOwner.kind() != PsiIndex.NodeKind.CLASS_DECL) return null;
        PsiIndex.Node receiverDeclaration = sourceValueDeclaration(receiver, facts);
        return receiverDeclaration != null
                && receiverDeclaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
            ? receiverDeclaration : null;
    }

    private Map<Integer, List<PsiIndex.Node>> mapSourceArguments(PsiIndex.Node call,
            PsiIndex.Node declaration, List<Map<String, Object>> facts) {
        List<PsiIndex.Node> parameters = targets(declaration, PsiIndex.EdgeRole.PARAMETER);
        List<PsiIndex.Node> arguments = uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT);
        Map<Integer, List<PsiIndex.Node>> mapped = new HashMap<>();
        int frontier = 0;
        int activeVariadic = -1;
        for (int argumentIndex = 0; argumentIndex < arguments.size(); argumentIndex++) {
            PsiIndex.Node argument = arguments.get(argumentIndex);
            PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
            if (value == null) return null;
            int position = -1;
            if (argument.flags().contains(PsiIndex.NodeFlag.NAMED)) {
                for (int index = 0; index < parameters.size(); index++) {
                    if (parameters.get(index).name() != null && parameters.get(index).name().equals(argument.name())) {
                        position = index;
                    }
                }
                if (position < 0 || mapped.containsKey(position)) return null;
            } else if (isCallableValue(value, facts) && argumentIndex + 1 == arguments.size()) {
                List<Integer> callablePositions = new ArrayList<>();
                for (int index = frontier; index < parameters.size(); index++) {
                    if (mapped.containsKey(index) || !isSourceCallableParameter(parameters.get(index))
                            || !canSkipSourceParameters(parameters, mapped, frontier, index)) continue;
                    callablePositions.add(index);
                }
                if (callablePositions.size() != 1) return null;
                position = callablePositions.get(0);
            }
            if (position < 0) {
                if (activeVariadic >= 0) position = activeVariadic;
                else {
                    while (frontier < parameters.size() && mapped.containsKey(frontier)) frontier++;
                    if (frontier >= parameters.size()) return null;
                    position = frontier;
                    if (isSourceVariadic(parameters.get(position))) {
                        activeVariadic = position;
                        frontier = position + 1;
                    } else frontier++;
                }
            }
            if (position < 0 || position >= parameters.size()
                    || !sourceArgumentCompatible(parameters.get(position), value, facts)) return null;
            List<PsiIndex.Node> values = mapped.computeIfAbsent(position, ignored -> new ArrayList<>());
            if (!isSourceVariadic(parameters.get(position)) && !values.isEmpty()) return null;
            values.add(argument);
        }
        for (int index = 0; index < parameters.size(); index++) {
            if (!mapped.containsKey(index) && !isSourceVariadic(parameters.get(index))
                    && one(parameters.get(index), PsiIndex.EdgeRole.DEFAULT_VALUE) == null) return null;
        }
        return mapped;
    }

    private boolean canSkipSourceParameters(List<PsiIndex.Node> parameters,
            Map<Integer, List<PsiIndex.Node>> mapped, int frontier, int target) {
        for (int index = frontier; index < target; index++) {
            if (mapped.containsKey(index)) continue;
            PsiIndex.Node parameter = parameters.get(index);
            if (!isSourceVariadic(parameter)
                    && one(parameter, PsiIndex.EdgeRole.DEFAULT_VALUE) == null) return false;
        }
        return true;
    }

    private int sourceTrailingCallbackPositionCount(PsiIndex.Node call,
            PsiIndex.Node declaration, List<Map<String, Object>> facts) {
        List<PsiIndex.Node> parameters = targets(declaration, PsiIndex.EdgeRole.PARAMETER);
        List<PsiIndex.Node> arguments = uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT);
        if (arguments.isEmpty()) return 0;
        PsiIndex.Node trailing = arguments.get(arguments.size() - 1);
        PsiIndex.Node trailingValue = one(trailing, PsiIndex.EdgeRole.VALUE);
        if (trailing.flags().contains(PsiIndex.NodeFlag.NAMED)
                || !isCallableValue(trailingValue, facts)) return 0;
        Map<Integer, List<PsiIndex.Node>> mapped = new HashMap<>();
        int frontier = 0;
        int activeVariadic = -1;
        for (int argumentIndex = 0; argumentIndex + 1 < arguments.size(); argumentIndex++) {
            PsiIndex.Node argument = arguments.get(argumentIndex);
            PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
            if (value == null) return 0;
            int position = -1;
            if (argument.flags().contains(PsiIndex.NodeFlag.NAMED)) {
                for (int index = 0; index < parameters.size(); index++) {
                    if (parameters.get(index).name() != null
                            && parameters.get(index).name().equals(argument.name())) position = index;
                }
                if (position < 0 || mapped.containsKey(position)) return 0;
            } else if (activeVariadic >= 0) position = activeVariadic;
            else {
                while (frontier < parameters.size() && mapped.containsKey(frontier)) frontier++;
                if (frontier >= parameters.size()) return 0;
                position = frontier;
                if (isSourceVariadic(parameters.get(position))) {
                    activeVariadic = position;
                    frontier = position + 1;
                } else frontier++;
            }
            if (!sourceArgumentCompatible(parameters.get(position), value, facts)) return 0;
            List<PsiIndex.Node> values = mapped.computeIfAbsent(position, ignored -> new ArrayList<>());
            if (!isSourceVariadic(parameters.get(position)) && !values.isEmpty()) return 0;
            values.add(argument);
        }
        int count = 0;
        for (int index = frontier; index < parameters.size(); index++) {
            if (mapped.containsKey(index) || !isSourceCallableParameter(parameters.get(index))
                    || !canSkipSourceParameters(parameters, mapped, frontier, index)) continue;
            count++;
        }
        return count;
    }

    private boolean sourceArgumentCompatible(PsiIndex.Node parameter, PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        String required = declaredSemanticType(parameter);
        String actual = typeOf(facts, value);
        if (isNullLiteral(value)) {
            PsiIndex.Node type = declarationTypeNode(parameter, false);
            return type != null && isExplicitNullableTarget(parameter, type);
        }
        if (isSourceCallableParameter(parameter)) {
            return isCallableValue(value, facts)
                && sourceCallbackShapeCompatible(parameter, value, facts);
        }
        return required == null || actual == null || compatibleType(actual, required, value, facts);
    }

    private boolean isSourceCallableParameter(PsiIndex.Node parameter) {
        PsiIndex.Node type = declarationTypeNode(parameter, false);
        return isStructuralFunctionType(type);
    }

    private boolean sourceCallbackShapeCompatible(PsiIndex.Node parameter, PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        int expected = sourceCallableArity(parameter);
        if (expected < 0) return false;
        PsiIndex.Node target = value;
        if (value.kind() == PsiIndex.NodeKind.CALLABLE_REF) target = uniqueReferencedCallable(value);
        else if (value.kind() == PsiIndex.NodeKind.NAME_REF) {
            PsiIndex.Node binding = findLexicalDeclaration(value, value.name());
            target = binding == null ? null
                : relatedNodeForFact(facts, "function_binding", binding.id());
        }
        if (target == null) return false;
        List<PsiIndex.Node> actual = targets(target, PsiIndex.EdgeRole.PARAMETER);
        return actual.size() == expected || target.kind() == PsiIndex.NodeKind.LAMBDA
            && actual.isEmpty() && expected == 1 && implicitItAvailable(target);
    }

    private int sourceCallableArity(PsiIndex.Node parameter) {
        PsiIndex.Node type = declarationTypeNode(parameter, false);
        if (!isStructuralFunctionType(type)) return -1;
        int parameters = 0;
        for (PsiIndex.Node child : lexicalChildren(type)) {
            if (child.kind() == PsiIndex.NodeKind.PARAMETER_DECL) parameters++;
        }
        return parameters;
    }

    private boolean isSourceVariadic(PsiIndex.Node parameter) {
        return containsToken(parameter, "vararg");
    }

    private void bindSourceArguments(PsiIndex.Node call, PsiIndex.Node declaration,
            Map<Integer, List<PsiIndex.Node>> mapped, List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        List<PsiIndex.Node> parameters = targets(declaration, PsiIndex.EdgeRole.PARAMETER);
        for (Map.Entry<Integer, List<PsiIndex.Node>> entry : mapped.entrySet()) {
            PsiIndex.Node parameter = parameters.get(entry.getKey());
            for (PsiIndex.Node argument : entry.getValue()) {
                addFact(facts, factKeys, multiplicities, unsupported,
                    "argument_binding", argument, call, parameter, Integer.toString(entry.getKey()), null);
                PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
                PsiIndex.Node type = declarationTypeNode(parameter, false);
                if (isNullLiteral(value) && isExplicitNullableTarget(parameter, type)) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "nullable", value, enclosingCallable(call), parameter, "true", null);
            }
        }
    }

    private void propagateInferredTypes(List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
                PsiIndex.Node initializer = one(node, PsiIndex.EdgeRole.INITIALIZER);
                String type = typeOf(facts, initializer);
                if (type != null && factValue(facts, "type", node.id()) == null) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "type", node, enclosingCallable(node), initializer, type,
                    symbolForFact(facts, "type", initializer.id()));
                if (initializer != null && isNullableFact(facts, initializer)
                        && !isNullLiteral(initializer)) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "nullable", node, enclosingCallable(node), initializer, "true", null);
            } else if (node.kind() == PsiIndex.NodeKind.NAME_REF && node.name() != null) {
                PsiIndex.Node declaration = findLexicalDeclaration(node, node.name());
                String type = typeOf(facts, declaration);
                boolean boundFunctionReference = "callable".equals(type)
                    && declaration != null
                    && relatedNodeForFact(facts, "function_binding", declaration.id()) != null;
                if (factValue(facts, "type", node.id()) == null
                        && type != null && !boundFunctionReference) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "type", node, enclosingCallable(node), declaration, type,
                    symbolForFact(facts, "type", declaration.id()));
                if (declaration != null && isNullableFact(facts, declaration)) addFact(
                    facts, factKeys, multiplicities, unsupported,
                    "nullable", node, enclosingCallable(node), declaration, "true",
                    symbolForFact(facts, "nullable", declaration.id()));
            } else if (node.kind() == PsiIndex.NodeKind.ARGUMENT) {
                PsiIndex.Node value = one(node, PsiIndex.EdgeRole.VALUE);
                String type = typeOf(facts, value);
                if (type != null) addFact(facts, factKeys, multiplicities, unsupported,
                    "type", node, enclosingCallable(node), value, type,
                    symbolForFact(facts, "type", value.id()));
            } else if (node.kind() == PsiIndex.NodeKind.QUALIFIED
                    || node.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
                PsiIndex.Node selector = one(node, PsiIndex.EdgeRole.SELECTOR);
                String type = typeOf(facts, selector);
                if (type != null) {
                    Rules.SymbolSpec physical = symbolForFact(facts, "type", selector.id());
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, enclosingCallable(node), -1, type, physical);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", node, enclosingCallable(node), selector, "derived",
                        symbolForFact(facts, "return_origin", selector.id()));
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "return_origin", node, enclosingCallable(node), selector, type,
                        symbolForFact(facts, "return_origin", selector.id()));
                    if (node.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                            || isNullableFact(facts, selector)) addFact(
                        facts, factKeys, multiplicities, unsupported,
                        "nullable", node, enclosingCallable(node), selector, "true", null);
                }
            } else if (node.kind() == PsiIndex.NodeKind.BINARY
                    && "?:".equals(node.value())) {
                PsiIndex.Node left = one(node, PsiIndex.EdgeRole.LEFT);
                PsiIndex.Node right = one(node, PsiIndex.EdgeRole.RIGHT);
                String leftType = typeOf(facts, left);
                String rightType = typeOf(facts, right);
                Rules.SymbolSpec leftPhysical = left == null
                    ? null : symbolForFact(facts, "type", left.id());
                if (left != null && right != null && right.kind() == PsiIndex.NodeKind.RETURN
                        && enclosingCallable(right) == enclosingCallable(node)
                        && leftType != null && isNullableFact(facts, left)
                        && factValue(facts, "type", node.id()) == null) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, enclosingCallable(node), left, leftType, leftPhysical);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", node, enclosingCallable(node), left, "derived", leftPhysical);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "return_origin", node, enclosingCallable(node), left, leftType, leftPhysical);
                } else if (left != null && right != null && isNullLiteral(right)
                        && leftType != null && isNullableFact(facts, left)
                        && factValue(facts, "type", node.id()) == null) {
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, enclosingCallable(node), left, leftType, leftPhysical);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "nullable", node, enclosingCallable(node), left, "true", leftPhysical);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "origin", node, enclosingCallable(node), left, "derived", leftPhysical);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "return_origin", node, enclosingCallable(node), left, leftType, leftPhysical);
                } else if (left != null && right != null && leftType != null
                        && leftType.equals(rightType) && isNullableFact(facts, left)
                        && isNullableFact(facts, right)
                        && factValue(facts, "type", node.id()) == null) {
                    Rules.SymbolSpec rightPhysical = symbolForFact(facts, "type", right.id());
                    if (leftPhysical == null || leftPhysical != rightPhysical) continue;
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "type", node, enclosingCallable(node), left, leftType, leftPhysical);
                    addFact(facts, factKeys, multiplicities, unsupported,
                        "nullable", node, enclosingCallable(node), -1, "true", null);
                    PsiIndex.Node leftOrigin = representativeOrigin(left, facts);
                    PsiIndex.Node rightOrigin = representativeOrigin(right, facts);
                    if (leftOrigin != null && rightOrigin != null
                            && leftOrigin.id() == rightOrigin.id()) {
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "origin", node, enclosingCallable(node), leftOrigin,
                            "derived", leftPhysical);
                        addFact(facts, factKeys, multiplicities, unsupported,
                            "return_origin", node, enclosingCallable(node), leftOrigin,
                            leftType, leftPhysical);
                    }
                }
            }
        }
    }

    private boolean isArgumentValue(PsiIndex.Node node) {
        Integer ownerId = node == null ? null : lexicalOwners.get(node.id());
        if (ownerId == null) return false;
        PsiIndex.Node owner = program.node(ownerId);
        return owner.kind() == PsiIndex.NodeKind.ARGUMENT
            && isTarget(owner, PsiIndex.EdgeRole.VALUE, node);
    }

    private void addDirectConformance(PsiIndex.Node subject, PsiIndex.Node owner,
            Rules.SymbolSpec physical, List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        if (subject == null || physical == null || !physical.kind().equals("type")) return;
        for (String target : physical.conformsTo()) addFact(
            facts, factKeys, multiplicities, unsupported,
            "conformance", subject, owner, -1, target, typeSymbolByAbstract(target));
    }

    private Rules.SymbolSpec domainSymbolOrNull(String fqn, String signature) {
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!symbol.fqn().equals(fqn) || !symbol.signature().equals(signature)) continue;
            if (match != null) return null;
            match = symbol;
        }
        return match;
    }

    private Rules.SymbolSpec typeSymbolExact(String fqn, String signature) {
        Rules.SymbolSpec symbol = domainSymbolOrNull(fqn, signature);
        return symbol != null && symbol.kind().equals("type") ? symbol : null;
    }

    private Rules.SymbolSpec typeSymbolByFqn(String fqn) {
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!symbol.kind().equals("type") || !symbol.fqn().equals(fqn)) continue;
            if (match != null) return null;
            match = symbol;
        }
        return match;
    }

    private Rules.SymbolSpec typeSymbolByAbstract(String abstractType) {
        if (abstractType == null) return null;
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!symbol.kind().equals("type") || !abstractType.equals(symbol.returnAbstractType())) continue;
            if (match != null) return null;
            match = symbol;
        }
        return match;
    }

    private Rules.SymbolSpec typeSymbolForReference(PsiIndex.Node rawReference) {
        if (rawReference == null || rawReference.kind() != PsiIndex.NodeKind.TYPE_REF) return null;
        PsiIndex.Node reference = one(rawReference, PsiIndex.EdgeRole.TYPE);
        if (reference == null || reference.kind() != PsiIndex.NodeKind.TYPE_REF) reference = rawReference;
        String name = reference.name();
        if (name == null) name = rawReference.name();
        if (name == null) return null;
        String imported = importedFqn(reference.fileId(), name);
        if (imported != null) return typeSymbolByFqn(imported);
        if (hasAmbiguousImport(reference.fileId(), name)
                || isHiddenByAlias(reference.fileId(), name)) return null;
        if (name.equals("Throwable")) return typeSymbolByFqn("kotlin.Throwable");
        if (name.equals("List")) return typeSymbolByFqn("kotlin.collections.List");
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!symbol.kind().equals("type") || !terminalFqnName(symbol.fqn()).equals(name)) continue;
            if (match != null) return null;
            match = symbol;
        }
        return match;
    }

    private PsiIndex.Node sourceTypeDeclaration(PsiIndex.Node reference) {
        if (reference == null || reference.name() == null) return null;
        String imported = importedFqn(reference.fileId(), reference.name());
        if (hasAmbiguousImport(reference.fileId(), reference.name())
                || isHiddenByAlias(reference.fileId(), reference.name())) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (!isTypeDeclaration(candidate) || candidate.name() == null) continue;
            String packageName = program.file(candidate.fileId()).packageName();
            String candidateFqn = packageName.isEmpty() ? candidate.name()
                : packageName + "." + candidate.name();
            boolean visible = imported != null ? imported.equals(candidateFqn)
                : candidate.name().equals(reference.name())
                    && packageName.equals(program.file(reference.fileId()).packageName());
            if (!visible) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private String primitiveType(PsiIndex.Node typeReference) {
        if (typeReference == null) return null;
        String name = typeReference.value() == null ? typeReference.name() : typeReference.value();
        if ("Boolean".equals(name)) return "boolean";
        if ("Int".equals(name)) return "int";
        if ("Long".equals(name)) return "long";
        if ("Float".equals(name)) return "float";
        if ("Double".equals(name)) return "double";
        if ("String".equals(name)) return "string";
        if ("Unit".equals(name)) return "unit";
        if ("Class".equals(name)) return "java_class";
        if ("KClass".equals(name)) return "kclass";
        if (isStructuralFunctionType(typeReference)) return "callable";
        return null;
    }

    private boolean isStructuralFunctionType(PsiIndex.Node typeReference) {
        if (typeReference == null || typeReference.kind() != PsiIndex.NodeKind.TYPE_REF
                || typeReference.name() != null || typeReference.value() != null) return false;
        int results = 0;
        for (PsiIndex.Node child : lexicalChildren(typeReference)) {
            if (child.kind() == PsiIndex.NodeKind.TYPE_REF) results++;
            else if (child.kind() == PsiIndex.NodeKind.PARAMETER_DECL
                    && targets(child, PsiIndex.EdgeRole.TYPE).size() != 1) return false;
        }
        return results == 1;
    }

    private String literalType(PsiIndex.Node literal) {
        if (literal == null || literal.tokenCount() == 0) return null;
        for (int index = literal.firstTokenId(); index < literal.firstTokenId() + literal.tokenCount(); index++) {
            PsiIndex.Token token = program.tokens().get(index);
            if (token.kind() == PsiIndex.TokenKind.BOOLEAN_LITERAL) return "boolean";
            if (token.kind() == PsiIndex.TokenKind.INTEGER_LITERAL) {
                String value = token.value();
                return value.endsWith("L") || value.endsWith("l") ? "long" : "int";
            }
            if (token.kind() == PsiIndex.TokenKind.FLOAT_LITERAL) {
                String value = token.value();
                return value.endsWith("f") || value.endsWith("F") ? "float" : "double";
            }
        }
        return null;
    }

    private boolean isNullLiteral(PsiIndex.Node node) {
        if (node == null || node.kind() != PsiIndex.NodeKind.LITERAL) return false;
        for (int index = node.firstTokenId(); index < node.firstTokenId() + node.tokenCount(); index++) {
            if (program.tokens().get(index).kind() == PsiIndex.TokenKind.NULL_LITERAL) return true;
        }
        return false;
    }

    private boolean isAtomicClassToken(PsiIndex.Node node) {
        if (node == null || node.kind() != PsiIndex.NodeKind.QUALIFIED) return false;
        PsiIndex.Node selector = one(node, PsiIndex.EdgeRole.SELECTOR);
        PsiIndex.Node classLiteral = one(node, PsiIndex.EdgeRole.RECEIVER);
        if (selector == null || selector.kind() != PsiIndex.NodeKind.NAME_REF
                || !"java".equals(selector.name()) || classLiteral == null
                || classLiteral.kind() != PsiIndex.NodeKind.CLASS_LITERAL) return false;
        PsiIndex.Node typeSource = one(classLiteral, PsiIndex.EdgeRole.RECEIVER);
        if (typeSource == null || typeSource.kind() != PsiIndex.NodeKind.TYPE_REF
                && typeSource.kind() != PsiIndex.NodeKind.NAME_REF) return false;
        return classTokenDomainType(typeSource) != null
            || sourceTypeDeclaration(typeSource) != null;
    }

    private boolean isWithinAtomicClassToken(PsiIndex.Node classLiteral) {
        Integer ownerId = classLiteral == null ? null : lexicalOwners.get(classLiteral.id());
        return ownerId != null && isAtomicClassToken(program.node(ownerId));
    }

    private Rules.SymbolSpec classTokenTargetType(PsiIndex.Node token,
            List<Map<String, Object>> facts) {
        if (!isAtomicClassToken(token)) return null;
        PsiIndex.Node classLiteral = one(token, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node typeSource = one(classLiteral, PsiIndex.EdgeRole.RECEIVER);
        Rules.SymbolSpec physical = classTokenDomainType(typeSource);
        if (physical != null) return physical;
        PsiIndex.Node source = sourceTypeDeclaration(typeSource);
        return source == null ? null : physicalTypeForOrigin(source, facts);
    }

    private Rules.SymbolSpec classTokenDomainType(PsiIndex.Node typeSource) {
        if (typeSource == null) return null;
        if (typeSource.kind() == PsiIndex.NodeKind.TYPE_REF) {
            return typeSymbolForReference(typeSource);
        }
        if (typeSource.kind() != PsiIndex.NodeKind.NAME_REF || typeSource.name() == null
                || hasAmbiguousImport(typeSource.fileId(), typeSource.name())
                || isHiddenByAlias(typeSource.fileId(), typeSource.name())) return null;
        String imported = importedFqn(typeSource.fileId(), typeSource.name());
        return imported == null ? null : typeSymbolByFqn(imported);
    }

    private boolean isExplicitNullable(PsiIndex.Node typeReference) {
        return containsToken(typeReference, "?");
    }

    private boolean isExplicitNullableTarget(PsiIndex.Node declaration,
            PsiIndex.Node typeReference) {
        if (declaration == null || typeReference == null
                || !isTarget(declaration, PsiIndex.EdgeRole.TYPE, typeReference)) return false;
        if (isExplicitNullable(typeReference)) return true;
        int lastCataloguedEnd = -1;
        for (int index = typeReference.firstTokenId();
                index < typeReference.firstTokenId() + typeReference.tokenCount(); index++) {
            PsiIndex.Token token = program.tokens().get(index);
            if (token.fileId() == typeReference.fileId()
                    && token.startUtf16() >= typeReference.startUtf16()
                    && token.endUtf16() <= typeReference.endUtf16()) {
                lastCataloguedEnd = Math.max(lastCataloguedEnd, token.endUtf16());
            }
        }
        return lastCataloguedEnd >= typeReference.startUtf16()
            && lastCataloguedEnd + 1 == typeReference.endUtf16();
    }

    private boolean containsToken(PsiIndex.Node node, String value) {
        if (node == null) return false;
        for (int index = node.firstTokenId(); index < node.firstTokenId() + node.tokenCount(); index++) {
            if (program.tokens().get(index).value().equals(value)) return true;
        }
        return false;
    }

    private PsiIndex.Node declarationTypeNode(PsiIndex.Node declaration, boolean receiver) {
        List<PsiIndex.Node> types = targets(declaration, PsiIndex.EdgeRole.TYPE);
        if (types.isEmpty()) return null;
        if (declaration.kind() == PsiIndex.NodeKind.PARAMETER_DECL) return receiver ? null : types.get(0);
        int nameStart = declarationNameStart(declaration);
        PsiIndex.Node receiverType = null;
        PsiIndex.Node returnType = null;
        for (PsiIndex.Node type : types) {
            if (nameStart >= 0 && type.endUtf16() <= nameStart) receiverType = type;
            else returnType = type;
        }
        return receiver ? receiverType : returnType;
    }

    private int declarationNameStart(PsiIndex.Node declaration) {
        if (declaration.name() == null) return -1;
        for (int index = declaration.firstTokenId(); index < declaration.firstTokenId() + declaration.tokenCount(); index++) {
            PsiIndex.Token token = program.tokens().get(index);
            if (token.kind() == PsiIndex.TokenKind.IDENTIFIER && token.value().equals(declaration.name())) {
                return token.startUtf16();
            }
        }
        return -1;
    }

    private String declaredSemanticType(PsiIndex.Node declaration) {
        if (declaration == null) return null;
        PsiIndex.Node type = declarationTypeNode(declaration, false);
        if (type != null) {
            Rules.SymbolSpec physical = typeSymbolForReference(type);
            return physical == null ? primitiveType(type) : physical.returnAbstractType();
        }
        if (isTypeDeclaration(declaration)) {
            Rules.SymbolSpec physical = typeSymbolForReference(one(declaration, PsiIndex.EdgeRole.SUPER_TYPE));
            return physical == null ? null : physical.returnAbstractType();
        }
        return null;
    }

    private String typeOf(List<Map<String, Object>> facts, PsiIndex.Node node) {
        if (node == null) return null;
        String value = factValue(facts, "type", node.id());
        if (value != null) return value;
        if (node.kind() == PsiIndex.NodeKind.TYPE_REF) {
            Rules.SymbolSpec physical = typeSymbolForReference(node);
            return physical == null ? primitiveType(node) : physical.returnAbstractType();
        }
        if (node.kind() == PsiIndex.NodeKind.LITERAL) return literalType(node);
        if (node.kind() == PsiIndex.NodeKind.STRING_TEMPLATE) return "string";
        if (node.kind() == PsiIndex.NodeKind.LAMBDA || node.kind() == PsiIndex.NodeKind.CALLABLE_REF) {
            return "callable";
        }
        return declaredSemanticType(node);
    }

    private String factValue(List<Map<String, Object>> facts, String kind, int subjectId) {
        String match = null;
        for (Map<String, Object> fact : facts) {
            if (!kind.equals(fact.get("kind")) || !Long.valueOf(subjectId).equals(fact.get("subjectNodeId"))) continue;
            String value = (String) fact.get("value");
            if (match != null && !match.equals(value)) return null;
            match = value;
        }
        return match;
    }

    private boolean hasFact(List<Map<String, Object>> facts, String kind, int subjectId) {
        for (Map<String, Object> fact : facts) {
            if (kind.equals(fact.get("kind")) && Long.valueOf(subjectId).equals(fact.get("subjectNodeId"))) return true;
        }
        return false;
    }

    private boolean factBoolean(List<Map<String, Object>> facts, String kind, int subjectId) {
        return hasFact(facts, kind, subjectId);
    }

    private boolean isNullableFact(List<Map<String, Object>> facts, PsiIndex.Node node) {
        return node != null && "true".equals(factValue(facts, "nullable", node.id()));
    }

    private boolean nullableReceiverAtUse(List<Map<String, Object>> facts,
            PsiIndex.Node receiver, PsiIndex.Node use) {
        return isNullableFact(facts, receiver)
            && !hasExactExitingNullGuard(receiver, use, facts);
    }

    private boolean hasExactExitingNullGuard(PsiIndex.Node receiver, PsiIndex.Node use,
            List<Map<String, Object>> facts) {
        if (receiver == null || receiver.kind() != PsiIndex.NodeKind.NAME_REF
                || receiver.name() == null || use == null) return false;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", receiver.id());
        if (declaration == null) {
            declaration = findLexicalDeclaration(receiver, receiver.name());
        }
        PsiIndex.Node callable = enclosingCallable(use);
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !declaration.flags().contains(PsiIndex.NodeFlag.VAL)
                || declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                || enclosingCallable(declaration) != callable) return false;
        for (PsiIndex.Node guard : program.nodes()) {
            if (guard.kind() != PsiIndex.NodeKind.IF || enclosingCallable(guard) != callable
                    || guard.startUtf16() <= declaration.startUtf16()
                    || guard.startUtf16() >= use.startUtf16()
                    || one(guard, PsiIndex.EdgeRole.ELSE_BRANCH) != null) continue;
            PsiIndex.Node condition = one(guard, PsiIndex.EdgeRole.CONDITION);
            PsiIndex.Node branch = one(guard, PsiIndex.EdgeRole.THEN_BRANCH);
            PsiIndex.Node tested = condition == null
                ? null : relatedNodeForFact(facts, "condition", condition.id());
            PsiIndex.Node testedDeclaration = tested == null ? null
                : relatedNodeForFact(facts, "def_use", tested.id());
            if (testedDeclaration == null && tested != null
                    && tested.kind() == PsiIndex.NodeKind.NAME_REF) {
                testedDeclaration = findLexicalDeclaration(tested, tested.name());
            }
            PsiIndex.Node block = lexicalOwner(guard);
            PsiIndex.Node useStatement = directChildWithin(use, block);
            if (condition == null || condition.kind() != PsiIndex.NodeKind.BINARY
                    || !"==".equals(condition.value())
                    || !"null".equals(factValue(facts, "condition", condition.id()))
                    || testedDeclaration != declaration || branch == null
                    || normalExit(branch) != null || block == null
                    || block.kind() != PsiIndex.NodeKind.BLOCK
                    || useStatement == null || useStatement.startUtf16() <= guard.startUtf16()) continue;
            int returns = 0;
            for (PsiIndex.Node candidate : program.nodes()) {
                if (candidate.kind() != PsiIndex.NodeKind.RETURN
                        || !isWithin(candidate, branch)) continue;
                if (enclosingCallable(candidate) != callable || candidate.name() != null) {
                    returns = 2;
                    break;
                }
                returns++;
            }
            if (returns == 1) return true;
        }
        return false;
    }

    private PsiIndex.Node directChildWithin(PsiIndex.Node node, PsiIndex.Node ancestor) {
        if (node == null || ancestor == null) return null;
        PsiIndex.Node current = node;
        Integer owner = lexicalOwners.get(current.id());
        while (owner != null) {
            if (owner == ancestor.id()) return current;
            current = program.node(owner);
            owner = lexicalOwners.get(current.id());
        }
        return null;
    }

    private PsiIndex.Node relatedNodeForFact(List<Map<String, Object>> facts, String kind, int subjectId) {
        Integer match = null;
        for (Map<String, Object> fact : facts) {
            if (!kind.equals(fact.get("kind")) || !Long.valueOf(subjectId).equals(fact.get("subjectNodeId"))) continue;
            int id = ((Long) fact.get("relatedNodeId")).intValue();
            if (id < 0) continue;
            if (match != null && match != id) return null;
            match = id;
        }
        return match == null ? null : program.node(match);
    }

    private Rules.SymbolSpec symbolForFact(List<Map<String, Object>> facts, String kind, int subjectId) {
        Rules.SymbolSpec match = null;
        for (Map<String, Object> fact : facts) {
            if (!kind.equals(fact.get("kind")) || !Long.valueOf(subjectId).equals(fact.get("subjectNodeId"))) continue;
            String fqn = (String) fact.get("symbolFqn");
            String signature = (String) fact.get("symbolSignature");
            if (fqn.isEmpty()) continue;
            Rules.SymbolSpec symbol = domainSymbolOrNull(fqn, signature);
            if (match != null && match != symbol) return null;
            match = symbol;
        }
        return match;
    }

    private String definitionKey(PsiIndex.Node owner, String name) {
        return (owner == null ? -1 : owner.id()) + "\n" + name;
    }

    private PsiIndex.Node findLexicalDeclaration(PsiIndex.Node use, String name) {
        if (use == null || name == null) return null;
        if (qualifiedSelectorParent(use) != null) return null;
        PsiIndex.Node callable = enclosingCallable(use);
        PsiIndex.Node containingType = enclosingTypeDeclaration(use);
        PsiIndex.Node match = null;
        int best = -1;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.id() >= use.id() || candidate.name() == null || !candidate.name().equals(name)
                    || !(candidate.kind() == PsiIndex.NodeKind.PARAMETER_DECL
                    || candidate.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                    || candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || isTypeDeclaration(candidate))) continue;
            PsiIndex.Node candidateCallable = enclosingCallable(candidate);
            boolean capturedDeclaration = capturedDeclarationVisible(
                candidate, use, candidateCallable);
            PsiIndex.Node candidateOwner = lexicalOwner(candidate);
            boolean visibleMemberProperty = candidate.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                && candidateOwner != null && candidateOwner == containingType;
            boolean visible = candidateCallable == callable || capturedDeclaration || isTopLevel(candidate)
                && program.file(candidate.fileId()).packageName().equals(program.file(use.fileId()).packageName())
                || visibleMemberProperty;
            if (!visible) continue;
            if (candidate.id() > best) {
                best = candidate.id();
                match = candidate;
            }
        }
        return match;
    }

    private PsiIndex.Node enclosingTypeDeclaration(PsiIndex.Node node) {
        Integer ownerId = node == null ? null : lexicalOwners.get(node.id());
        while (ownerId != null) {
            PsiIndex.Node owner = program.node(ownerId);
            if (isTypeDeclaration(owner)) return owner;
            ownerId = lexicalOwners.get(owner.id());
        }
        return null;
    }

    private PsiIndex.Node lexicalOwner(PsiIndex.Node node) {
        Integer ownerId = node == null ? null : lexicalOwners.get(node.id());
        return ownerId == null ? null : program.node(ownerId);
    }

    private boolean capturedDeclarationVisible(PsiIndex.Node candidate, PsiIndex.Node use,
            PsiIndex.Node candidateCallable) {
        if (candidateCallable == null || !isWithin(use, candidateCallable)) return false;
        if (candidate.kind() == PsiIndex.NodeKind.PARAMETER_DECL) return true;
        if (candidate.kind() != PsiIndex.NodeKind.PROPERTY_DECL) return false;
        Integer owner = lexicalOwners.get(candidate.id());
        while (owner != null) {
            PsiIndex.Node scope = program.node(owner);
            if (scope.kind() == PsiIndex.NodeKind.BLOCK) return isWithin(use, scope);
            if (scope.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || scope.kind() == PsiIndex.NodeKind.LAMBDA) return false;
            owner = lexicalOwners.get(scope.id());
        }
        return false;
    }

    private boolean functionInvocationMatches(PsiIndex.Node call, PsiIndex.Node summary,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> arguments = uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT);
        List<PsiIndex.Node> parameters = targets(summary, PsiIndex.EdgeRole.PARAMETER);
        if (arguments.size() != parameters.size()) return false;
        for (int index = 0; index < arguments.size(); index++) {
            PsiIndex.Node value = argumentValue(arguments.get(index));
            String required = declaredSemanticType(parameters.get(index));
            if (required != null && !compatibleType(typeOf(facts, value), required, value, facts)) return false;
        }
        return true;
    }

    private void bindFunctionInvocation(PsiIndex.Node call, PsiIndex.Node summary,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        List<PsiIndex.Node> arguments = uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT);
        List<PsiIndex.Node> parameters = targets(summary, PsiIndex.EdgeRole.PARAMETER);
        if (arguments.size() != parameters.size()) return;
        for (int index = 0; index < arguments.size(); index++) {
            PsiIndex.Node argument = arguments.get(index);
            PsiIndex.Node value = argumentValue(argument);
            PsiIndex.Node parameter = parameters.get(index);
            addFact(facts, factKeys, multiplicities, unsupported,
                "argument_binding", argument, call, parameter, Integer.toString(index), null);
            String type = typeOf(facts, value);
            if (type != null && factValue(facts, "type", parameter.id()) == null) addFact(
                facts, factKeys, multiplicities, unsupported,
                "type", parameter, summary, -1, type, symbolForFact(facts, "type", value.id()));
        }
    }

    private void applyFunctionValueResult(PsiIndex.Node call, PsiIndex.Node summary,
            List<Map<String, Object>> facts, Map<String, Boolean> factKeys,
            Map<String, Integer> multiplicities, Map<Integer, Boolean> unsupported) {
        PsiIndex.Node result = callbackResult(summary);
        String resultType = typeOf(facts, result);
        if (result == null || resultType == null) return;
        PsiIndex.Node owner = enclosingCallable(call);
        addFact(facts, factKeys, multiplicities, unsupported,
            "type", call, owner, -1, resultType, typeSymbolByAbstract(resultType));
        addFact(facts, factKeys, multiplicities, unsupported,
            "return_origin", call, owner, result, resultType, null);
    }

    private String functionValueFailure(PsiIndex.Node binding,
            List<Map<String, Object>> facts) {
        if (binding.flags().contains(PsiIndex.NodeFlag.VAR)) return "unsupported";
        PsiIndex.Node initializer = one(binding, PsiIndex.EdgeRole.INITIALIZER);
        if (initializer != null && (initializer.kind() == PsiIndex.NodeKind.IF
                || initializer.kind() == PsiIndex.NodeKind.WHEN)) return "ambiguous";
        for (Map<String, Object> fact : facts) {
            if (!"escape".equals(fact.get("kind"))) continue;
            int subject = ((Long) fact.get("subjectNodeId")).intValue();
            int related = ((Long) fact.get("relatedNodeId")).intValue();
            if (related == binding.id() || initializer != null && subject == initializer.id()) return "escape";
        }
        return "unsupported";
    }

    private PsiIndex.Node functionValueDeclaration(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        PsiIndex.Node callee = one(call, PsiIndex.EdgeRole.CALLEE);
        if (callee == null || callee.kind() != PsiIndex.NodeKind.NAME_REF) return null;
        PsiIndex.Node declaration = findLexicalDeclaration(callee, callee.name());
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                && declaration.kind() != PsiIndex.NodeKind.PARAMETER_DECL) return null;
        if (!"callable".equals(typeOf(facts, declaration))
                && !"callable".equals(declaredSemanticType(declaration))) return null;
        return declaration;
    }

    private PsiIndex.Node sourceReturnOrigin(PsiIndex.Node declaration) {
        PsiIndex.Node body = one(declaration, PsiIndex.EdgeRole.BODY);
        if (body == null) return null;
        if (declaration.flags().contains(PsiIndex.NodeFlag.EXPRESSION_BODY)) return body;
        if (body.kind() != PsiIndex.NodeKind.BLOCK) return null;
        List<PsiIndex.Node> statements = lexicalChildren(body);
        if (statements.isEmpty()) return null;
        PsiIndex.Node exit = statements.get(statements.size() - 1);
        if (exit.kind() != PsiIndex.NodeKind.RETURN
                || enclosingCallable(exit) != declaration) return null;
        int returns = 0;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() == PsiIndex.NodeKind.RETURN
                    && enclosingCallable(candidate) == declaration) returns++;
        }
        return returns == 1 ? one(exit, PsiIndex.EdgeRole.RETURN_VALUE) : null;
    }

    private PsiIndex.Node callbackResult(PsiIndex.Node callback) {
        if (callback == null) return null;
        PsiIndex.Node body = callback.kind() == PsiIndex.NodeKind.LAMBDA
            ? one(callback, PsiIndex.EdgeRole.LAMBDA_BODY) : one(callback, PsiIndex.EdgeRole.BODY);
        if (body == null) return null;
        PsiIndex.Node exit = normalExit(body);
        if (exit == null) return body.kind() == PsiIndex.NodeKind.BLOCK ? null : body;
        if (exit.kind() == PsiIndex.NodeKind.RETURN) return one(exit, PsiIndex.EdgeRole.RETURN_VALUE);
        return exit;
    }

    private PsiIndex.Node uniqueCallbackResult(PsiIndex.Node call, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (Map<String, Object> fact : facts) {
            if (!"callback_result".equals(fact.get("kind"))
                    || !Long.valueOf(call.id()).equals(fact.get("ownerNodeId"))) continue;
            int id = ((Long) fact.get("relatedNodeId")).intValue();
            if (id < 0) continue;
            if (match != null && match.id() != id) return null;
            match = program.node(id);
        }
        return match;
    }

    private PsiIndex.Node enclosingCallable(PsiIndex.Node node) {
        if (node == null) return null;
        if (node.kind() == PsiIndex.NodeKind.FUNCTION_DECL || node.kind() == PsiIndex.NodeKind.LAMBDA) return node;
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || candidate.kind() == PsiIndex.NodeKind.LAMBDA) return candidate;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private PsiIndex.Node enclosingLambda(PsiIndex.Node node) {
        Integer owner = node == null ? null : lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.LAMBDA) return candidate;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private PsiIndex.Node ownerDeclaration(PsiIndex.Node node) {
        if (node == null) return null;
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || candidate.kind() == PsiIndex.NodeKind.LAMBDA
                    || isTypeDeclaration(candidate) || candidate.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
                return candidate;
            }
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private PsiIndex.Node lexicalPredecessor(PsiIndex.Node node, PsiIndex.Node root) {
        PsiIndex.Node current = node;
        Integer ownerId = lexicalOwners.get(current.id());
        while (ownerId != null) {
            PsiIndex.Node owner = program.node(ownerId);
            List<PsiIndex.Node> children = lexicalChildren(owner);
            for (int index = 1; index < children.size(); index++) {
                if (children.get(index).id() == current.id()) return children.get(index - 1);
            }
            if (owner.id() == root.id()) return root;
            current = owner;
            ownerId = lexicalOwners.get(current.id());
        }
        return root;
    }

    private PsiIndex.Node nextBoundary(PsiIndex.Node node) {
        PsiIndex.Node current = node;
        Integer ownerId = lexicalOwners.get(current.id());
        while (ownerId != null) {
            PsiIndex.Node owner = program.node(ownerId);
            List<PsiIndex.Node> siblings = lexicalChildren(owner);
            for (int index = 0; index + 1 < siblings.size(); index++) {
                if (siblings.get(index).id() == current.id()) return firstBoundary(siblings.get(index + 1));
            }
            if (owner.kind() == PsiIndex.NodeKind.FUNCTION_DECL || owner.kind() == PsiIndex.NodeKind.LAMBDA) return null;
            current = owner;
            ownerId = lexicalOwners.get(current.id());
        }
        return null;
    }

    private PsiIndex.Node firstBoundary(PsiIndex.Node node) {
        if (node == null) return null;
        if (node.kind() == PsiIndex.NodeKind.BLOCK) {
            List<PsiIndex.Node> children = lexicalChildren(node);
            return children.isEmpty() ? node : firstBoundary(children.get(0));
        }
        if (node.kind() == PsiIndex.NodeKind.IF || node.kind() == PsiIndex.NodeKind.WHILE) {
            PsiIndex.Node condition = one(node, PsiIndex.EdgeRole.CONDITION);
            return condition == null ? node : condition;
        }
        if (node.kind() == PsiIndex.NodeKind.FOR) {
            PsiIndex.Node range = one(node, PsiIndex.EdgeRole.RANGE);
            return range == null ? node : range;
        }
        if (node.kind() == PsiIndex.NodeKind.WHEN) {
            PsiIndex.Node subject = one(node, PsiIndex.EdgeRole.SUBJECT);
            if (subject != null) return subject;
            List<PsiIndex.Node> entries = targets(node, PsiIndex.EdgeRole.ENTRY);
            if (!entries.isEmpty()) {
                List<PsiIndex.Node> conditions = targets(entries.get(0), PsiIndex.EdgeRole.CONDITION);
                return conditions.isEmpty() ? entries.get(0) : conditions.get(0);
            }
        }
        if (node.kind() == PsiIndex.NodeKind.TRY) {
            PsiIndex.Node body = one(node, PsiIndex.EdgeRole.TRY_BODY);
            return body == null ? node : firstBoundary(body);
        }
        if (node.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
            PsiIndex.Node receiver = one(node, PsiIndex.EdgeRole.RECEIVER);
            return receiver == null ? node : firstBoundary(receiver);
        }
        if (node.kind() == PsiIndex.NodeKind.BINARY && ("&&".equals(node.value())
                || "||".equals(node.value()) || "?:".equals(node.value()))) {
            PsiIndex.Node left = one(node, PsiIndex.EdgeRole.LEFT);
            return left == null ? node : firstBoundary(left);
        }
        return node;
    }

    private boolean hasStructuredControlFlow(PsiIndex.Node node) {
        if (node == null) return false;
        if (node.kind() == PsiIndex.NodeKind.IF || node.kind() == PsiIndex.NodeKind.WHEN
                || node.kind() == PsiIndex.NodeKind.TRY || node.kind() == PsiIndex.NodeKind.FOR
                || node.kind() == PsiIndex.NodeKind.WHILE
                || node.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) return true;
        return node.kind() == PsiIndex.NodeKind.BINARY && ("&&".equals(node.value())
            || "||".equals(node.value()) || "?:".equals(node.value()));
    }

    private boolean isCanonicalBoundedWhile(PsiIndex.Node loop,
            List<Map<String, Object>> facts) {
        PsiIndex.Node condition = one(loop, PsiIndex.EdgeRole.CONDITION);
        PsiIndex.Node body = one(loop, PsiIndex.EdgeRole.LOOP_BODY);
        if (condition == null || condition.kind() != PsiIndex.NodeKind.BINARY || body == null
                || !List.of("<", "<=", ">", ">=").contains(condition.value())) return false;
        PsiIndex.Node left = one(condition, PsiIndex.EdgeRole.LEFT);
        PsiIndex.Node right = one(condition, PsiIndex.EdgeRole.RIGHT);
        PsiIndex.Node counter = left != null && left.kind() == PsiIndex.NodeKind.NAME_REF
            && right != null && "int".equals(literalType(right)) ? left
            : right != null && right.kind() == PsiIndex.NodeKind.NAME_REF
            && left != null && "int".equals(literalType(left)) ? right : null;
        if (counter == null || counter.name() == null) return false;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", counter.id());
        if (declaration == null) declaration = findLexicalDeclaration(counter, counter.name());
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                || declaration.startUtf16() >= loop.startUtf16()
                || enclosingCallable(declaration) != enclosingCallable(loop)
                || !"int".equals(literalType(one(declaration, PsiIndex.EdgeRole.INITIALIZER)))) {
            return false;
        }
        int increments = 0;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (!isWithin(candidate, body)) continue;
            if (candidate.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
                PsiIndex.Node target = one(candidate, PsiIndex.EdgeRole.TARGET);
                if (target == null || target.kind() != PsiIndex.NodeKind.NAME_REF
                        || !counter.name().equals(target.name())) continue;
                PsiIndex.Node targetDeclaration = findLexicalDeclaration(target, target.name());
                if (targetDeclaration == null || targetDeclaration.id() != declaration.id()) continue;
                if (!"+=".equals(candidate.value())
                        || !isExactIntegerOne(one(candidate, PsiIndex.EdgeRole.VALUE))) return false;
                increments++;
            } else if (candidate.kind() == PsiIndex.NodeKind.PREFIX
                    || candidate.kind() == PsiIndex.NodeKind.POSTFIX) {
                PsiIndex.Node operand = one(candidate, PsiIndex.EdgeRole.OPERAND);
                if (operand != null && counter.name().equals(operand.name())) return false;
            }
        }
        return increments == 1;
    }

    private boolean isExactIntegerOne(PsiIndex.Node node) {
        if (node == null || node.kind() != PsiIndex.NodeKind.LITERAL) return false;
        int matches = 0;
        for (int index = node.firstTokenId(); index < node.firstTokenId() + node.tokenCount(); index++) {
            PsiIndex.Token token = program.tokens().get(index);
            if (token.kind() == PsiIndex.TokenKind.INTEGER_LITERAL) {
                if (!"1".equals(token.value())) return false;
                matches++;
            }
        }
        return matches == 1;
    }

    private PsiIndex.Node normalExit(PsiIndex.Node node) {
        if (node == null || isTerminal(node)) return null;
        if (node.kind() == PsiIndex.NodeKind.BLOCK) {
            List<PsiIndex.Node> children = lexicalChildren(node);
            return children.isEmpty() ? node : normalExit(children.get(children.size() - 1));
        }
        return node;
    }

    private boolean isTerminal(PsiIndex.Node node) {
        return node != null && (node.kind() == PsiIndex.NodeKind.RETURN
            || node.kind() == PsiIndex.NodeKind.BREAK || node.kind() == PsiIndex.NodeKind.CONTINUE);
    }

    private PsiIndex.Node finallyBlock(PsiIndex.Node attempt, PsiIndex.Node body,
            List<PsiIndex.Node> catches) {
        PsiIndex.Node match = null;
        int after = body == null ? attempt.startUtf16() : body.endUtf16();
        for (PsiIndex.Node clause : catches) after = Math.max(after, clause.endUtf16());
        for (PsiIndex.Node child : lexicalChildren(attempt)) {
            if (child.kind() != PsiIndex.NodeKind.BLOCK || child.id() == (body == null ? -1 : body.id())
                    || child.startUtf16() < after) continue;
            boolean catchBody = false;
            for (PsiIndex.Node clause : catches) if (isWithin(child, clause)) catchBody = true;
            if (catchBody || match != null) return null;
            match = child;
        }
        return match;
    }

    private List<PsiIndex.Node> definitelyUnknownCalls(PsiIndex.Node condition,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> result = new ArrayList<>();
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.CALL
                    || !(candidate.id() == condition.id() || isWithin(candidate, condition))
                    || hasCallableAuthority(candidate)) continue;
            PsiIndex.Node callee = one(candidate, PsiIndex.EdgeRole.CALLEE);
            PsiIndex.Node binding = callee == null || callee.kind() != PsiIndex.NodeKind.NAME_REF
                ? null : findLexicalDeclaration(callee, callee.name());
            if (binding != null && ("callable".equals(typeOf(facts, binding))
                    || "callable".equals(declaredSemanticType(binding)))) continue;
            result.add(candidate);
        }
        return result;
    }

    private List<PsiIndex.Node> matchingLabeledCallbacks(PsiIndex.Node returned) {
        List<PsiIndex.Node> matches = new ArrayList<>();
        if (returned == null || returned.name() == null) return matches;
        Integer owner = lexicalOwners.get(returned.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.LAMBDA) {
                PsiIndex.Node call = enclosingCallbackCall(candidate);
                String explicit = explicitCallLabel(call);
                if (call != null && returned.name().equals(
                        explicit == null ? call.name() : explicit)) matches.add(candidate);
            }
            owner = lexicalOwners.get(owner);
        }
        return matches;
    }

    private PsiIndex.Node enclosingCallbackCall(PsiIndex.Node callback) {
        Integer owner = callback == null ? null : lexicalOwners.get(callback.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.CALL) return candidate;
            if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || candidate.kind() == PsiIndex.NodeKind.LAMBDA) return null;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private String explicitCallLabel(PsiIndex.Node call) {
        if (call == null || !call.flags().contains(PsiIndex.NodeFlag.LABELED)) return null;
        int lower = Math.max(0, call.firstTokenId() - 3);
        for (int index = call.firstTokenId() - 1; index >= lower; index--) {
            PsiIndex.Token token = program.tokens().get(index);
            if (token.fileId() != call.fileId()) break;
            if (token.kind() == PsiIndex.TokenKind.IDENTIFIER) return token.value();
        }
        return null;
    }

    private PsiIndex.Node nearestWitnessOwner(PsiIndex.Node node) {
        PsiIndex.Node current = node;
        while (current != null) {
            if (current.witnessNodeId() != null) return current;
            Integer owner = lexicalOwners.get(current.id());
            current = owner == null ? null : program.node(owner);
        }
        return null;
    }

    private PsiIndex.Node qualifiedParent(PsiIndex.Node call) {
        Integer owner = lexicalOwners.get(call.id());
        if (owner == null) return null;
        PsiIndex.Node candidate = program.node(owner);
        if (candidate.kind() != PsiIndex.NodeKind.QUALIFIED
                && candidate.kind() != PsiIndex.NodeKind.SAFE_QUALIFIED) return null;
        PsiIndex.Node selector = one(candidate, PsiIndex.EdgeRole.SELECTOR);
        return selector != null && selector.id() == call.id() ? candidate : null;
    }

    private boolean isQualifiedReceiver(PsiIndex.Node node) {
        Integer ownerId = node == null ? null : lexicalOwners.get(node.id());
        if (ownerId == null) return false;
        PsiIndex.Node owner = program.node(ownerId);
        return (owner.kind() == PsiIndex.NodeKind.QUALIFIED
                || owner.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED)
            && isTarget(owner, PsiIndex.EdgeRole.RECEIVER, node);
    }

    private boolean isDomainQualifier(PsiIndex.Node receiver, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        if (receiver == null || receiver.kind() != PsiIndex.NodeKind.NAME_REF
                || receiver.name() == null || symbol == null) return false;
        String imported = importedFqn(receiver.fileId(), receiver.name());
        Rules.SymbolSpec physical = physicalTypeForOrigin(receiver, facts);
        if (imported == null || physical == null) return false;
        if (imported.equals("androidx.compose.ui.Modifier")) {
            return physical.fqn().equals("androidx.compose.ui.Modifier.Companion")
                && physical.signature().equals("companion object : Modifier");
        }
        return symbol.receiverKind().equals("declaring_type")
            || symbol.receiverKind().equals("object_instance");
    }

    private PsiIndex.Node resolvedReceiver(PsiIndex.Node call) {
        PsiIndex.Node qualified = qualifiedParent(call);
        return qualified == null ? null : one(qualified, PsiIndex.EdgeRole.RECEIVER);
    }

    private boolean receiverMatches(PsiIndex.Node call, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        PsiIndex.Node receiver = resolvedReceiver(call);
        if ("none".equals(symbol.receiverKind())) return receiver == null;
        if (receiver == null) {
            if (qualifiedParent(call) != null) return false;
            receiver = implicitReceiver(call, symbol, facts);
            return receiver != null && receiverTypeMatches(receiver, symbol, facts);
        }
        PsiIndex.Node qualified = qualifiedParent(call);
        if (qualified != null && qualified.kind() == PsiIndex.NodeKind.QUALIFIED
                && nullableReceiverAtUse(facts, receiver, qualified)) return false;
        if (qualified != null && qualified.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
                && (!isNullableFact(facts, receiver)
                    || safeReceiverOriginPathCount(receiver, facts) != 1)) return false;
        return receiverTypeMatches(receiver, symbol, facts);
    }

    private int safeReceiverOriginPathCount(PsiIndex.Node receiver,
            List<Map<String, Object>> facts) {
        if (receiver == null) return 0;
        PsiIndex.Node source = receiver;
        if (receiver.kind() == PsiIndex.NodeKind.NAME_REF && receiver.name() != null) {
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", receiver.id());
            if (declaration == null) declaration = findLexicalDeclaration(receiver, receiver.name());
            if (declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
                PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
                int retainedPaths = retainedSafeReceiverOriginPathCount(declaration, facts);
                if (retainedPaths >= 0) return retainedPaths;
                if (initializer != null) source = initializer;
            }
        }
        List<PsiIndex.Node> origins = new ArrayList<>();
        if (!collectSafeReceiverOrigins(
                source, facts, origins, 0, new HashMap<>())) return 2;
        return Math.min(origins.size(), 2);
    }

    private int retainedSafeReceiverOriginPathCount(PsiIndex.Node declaration,
            List<Map<String, Object>> facts) {
        PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
        PsiIndex.Node declaredType = declarationTypeNode(declaration, false);
        Rules.SymbolSpec physical = declaredType == null
            ? null : typeSymbolForReference(declaredType);
        PsiIndex.Node ownerType = enclosingTypeDeclaration(declaration);
        if (!declaration.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || !declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                || initializer == null || !isNullLiteral(initializer)
                || physical == null || ownerType == null) return -1;
        List<PsiIndex.Node> origins = new ArrayList<>();
        for (PsiIndex.Node assignment : program.nodes()) {
            if (assignment.kind() != PsiIndex.NodeKind.ASSIGNMENT
                    || planeAssignmentTargetDeclaration(assignment, facts) != declaration) continue;
            PsiIndex.Node value = one(assignment, PsiIndex.EdgeRole.VALUE);
            if (!"=".equals(assignment.value()) || !isWithin(assignment, ownerType)
                    || value == null) return 2;
            if (isNullLiteral(value)) continue;
            if (physicalTypeForOrigin(value, facts) != physical
                    || !collectSafeReceiverOrigins(
                        value, facts, origins, 0, new HashMap<>())) return 2;
            if (origins.size() > 1) return 2;
        }
        return origins.size();
    }

    private boolean collectSafeReceiverOrigins(PsiIndex.Node source,
            List<Map<String, Object>> facts, List<PsiIndex.Node> origins,
            int depth, Map<Integer, Boolean> active) {
        if (source == null || depth >= 8
                || active.put(source.id(), Boolean.TRUE) != null) return false;
        if (isNullLiteral(source)) return true;
        if (source.kind() == PsiIndex.NodeKind.IF) {
            PsiIndex.Node thenBranch = branchResult(one(source, PsiIndex.EdgeRole.THEN_BRANCH));
            PsiIndex.Node elseBranch = branchResult(one(source, PsiIndex.EdgeRole.ELSE_BRANCH));
            return thenBranch != null && elseBranch != null
                && collectSafeReceiverOrigins(
                    thenBranch, facts, origins, depth + 1, new HashMap<>(active))
                && collectSafeReceiverOrigins(
                    elseBranch, facts, origins, depth + 1, new HashMap<>(active));
        }
        if (source.kind() == PsiIndex.NodeKind.WHEN) {
            List<PsiIndex.Node> entries = targets(source, PsiIndex.EdgeRole.ENTRY);
            if (entries.isEmpty()) return false;
            for (PsiIndex.Node entry : entries) {
                PsiIndex.Node result = branchResult(one(entry, PsiIndex.EdgeRole.BODY));
                if (result == null || !collectSafeReceiverOrigins(
                        result, facts, origins, depth + 1, new HashMap<>(active))) return false;
            }
            return true;
        }
        PsiIndex.Node representative = representativeOrigin(source, facts);
        if (representative == null) return false;
        addUniqueNode(origins, representative);
        return origins.size() <= 2;
    }

    private boolean receiverTypeMatches(PsiIndex.Node receiver, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        String actual = receiver.kind() == PsiIndex.NodeKind.LAMBDA
            ? factValue(facts, "callback_receiver", receiver.id()) : typeOf(facts, receiver);
        if (receiver.kind() == PsiIndex.NodeKind.FUNCTION_DECL) {
            PsiIndex.Node extensionType = declarationTypeNode(receiver, true);
            if (extensionType != null) actual = typeOf(facts, extensionType);
        }
        if (actual == null && receiver.kind() == PsiIndex.NodeKind.NAME_REF) {
            String imported = importedFqn(receiver.fileId(), receiver.name());
            Rules.SymbolSpec qualifier = imported == null ? null : typeSymbolByFqn(imported);
            actual = qualifier == null ? null : qualifier.returnAbstractType();
        }
        if (!symbol.kind().startsWith("member_")) {
            return compatibilityPathCount(actual, symbol.receiverAbstractType(), receiver, facts) == 1;
        }
        int ownerPaths = memberOwnerPathCount(receiver, symbol, facts);
        if (ownerPaths != 1) return false;
        return true;
    }

    private int memberOwnerPathCount(PsiIndex.Node receiver, Rules.SymbolSpec member,
            List<Map<String, Object>> facts) {
        Rules.SymbolSpec owner = memberOwnerType(member);
        if (receiver == null || owner == null || member.receiverAbstractType() == null
                || !member.receiverAbstractType().equals(owner.returnAbstractType())) return 0;
        Rules.SymbolSpec physical = physicalTypeForOrigin(receiver, facts);
        if (physical != null) return physicalOwnerPathCount(physical, owner, 0, new HashMap<>());
        PsiIndex.Node source = sourceTypeForValue(receiver, facts);
        return sourceOwnerPathCount(source, owner, 0, new HashMap<>());
    }

    private PsiIndex.Node sourceTypeForValue(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null) return null;
        if (isTypeDeclaration(value)) return value;
        PsiIndex.Node declaration = value.kind() == PsiIndex.NodeKind.NAME_REF
            ? sourceValueDeclaration(value, facts) : value;
        if (declaration == null) return null;
        if (isTypeDeclaration(declaration)) return declaration;
        PsiIndex.Node type = declarationTypeNode(declaration, false);
        PsiIndex.Node sourceType = sourceTypeDeclaration(type);
        if (sourceType != null) return sourceType;
        PsiIndex.Node initializer = declaration == null ? null
            : one(declaration, PsiIndex.EdgeRole.INITIALIZER);
        PsiIndex.Node constructed = initializer == null ? null
            : relatedNodeForFact(facts, "call_resolution", initializer.id());
        if (constructed != null && isTypeDeclaration(constructed)) return constructed;
        PsiIndex.Node componentSource = sourceComponentTypeFromInitializer(initializer, facts);
        if (componentSource != null) return componentSource;
        Rules.SymbolSpec producer = initializer == null
            ? null : symbolForFact(facts, "call_resolution", initializer.id());
        if (producer == null || !producer.effects().contains("passthrough")
                || !hasExactTaint(initializer, "unknown_return", facts)) return null;
        Map<Integer, List<PsiIndex.Node>> mapping = mapDomainArguments(
            initializer, producer, facts);
        PsiIndex.Node match = null;
        for (Rules.CallbackSpec callback : producer.callbacks()) {
            if (!"remembered_factory".equals(callback.role())) continue;
            PsiIndex.Node lambda = mappedLambda(mapping, callback.argumentPosition());
            PsiIndex.Node result = directCall(callbackResult(lambda));
            PsiIndex.Node candidate = exactSourceTarget(result, facts);
            if (candidate == null || !isTypeDeclaration(candidate)) continue;
            if (match != null && match.id() != candidate.id()) return null;
            match = candidate;
        }
        return match;
    }

    private PsiIndex.Node sourceComponentTypeFromInitializer(PsiIndex.Node initializer,
            List<Map<String, Object>> facts) {
        Rules.SymbolSpec get = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.ComponentSet.get",
            "get(componentType: Class<T>): T?");
        if (initializer == null || get == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node access : program.nodes()) {
            if (access.kind() != PsiIndex.NodeKind.INDEX_ACCESS
                    || !isWithin(access, initializer)
                    || !exactDomainResolution(access, get, facts)) continue;
            List<PsiIndex.Node> indices = targets(access, PsiIndex.EdgeRole.INDEX);
            PsiIndex.Node token = indices.size() == 1 ? indices.get(0) : null;
            if (!isAtomicClassToken(token)) continue;
            PsiIndex.Node classLiteral = one(token, PsiIndex.EdgeRole.RECEIVER);
            PsiIndex.Node typeSource = classLiteral == null
                ? null : one(classLiteral, PsiIndex.EdgeRole.RECEIVER);
            PsiIndex.Node candidate = sourceTypeDeclaration(typeSource);
            Rules.SymbolSpec physical = physicalTypeForOrigin(candidate, facts);
            if (candidate == null || physical == null
                    || conformancePathCountFromPhysical(
                        physical, "component", 0, new HashMap<>()) != 1) continue;
            if (match != null && match.id() != candidate.id()) return null;
            match = candidate;
        }
        return match;
    }

    private int sourceOwnerPathCount(PsiIndex.Node source, Rules.SymbolSpec owner,
            int depth, Map<Integer, Boolean> active) {
        if (source == null || depth >= 8 || active.put(source.id(), Boolean.TRUE) != null) return 0;
        int paths = 0;
        for (PsiIndex.Node superType : targets(source, PsiIndex.EdgeRole.SUPER_TYPE)) {
            Rules.SymbolSpec physical = typeSymbolForReference(superType);
            if (physical != null) paths += physicalOwnerPathCount(
                physical, owner, depth + 1, new HashMap<>());
            else paths += sourceOwnerPathCount(
                sourceTypeDeclaration(superType), owner, depth + 1, active);
            if (paths > 1) break;
        }
        active.remove(source.id());
        return Math.min(paths, 2);
    }

    private boolean memberOwnerAmbiguous(PsiIndex.Node call,
            List<Rules.SymbolSpec> candidates, List<Map<String, Object>> facts) {
        PsiIndex.Node receiver = resolvedReceiver(call);
        if (receiver == null) return false;
        for (Rules.SymbolSpec candidate : candidates) {
            if (candidate.kind().startsWith("member_")
                    && memberOwnerPathCount(receiver, candidate, facts) > 1) return true;
        }
        return false;
    }

    private boolean memberPropertyOwnerAmbiguous(PsiIndex.Node receiver, String name,
            List<Map<String, Object>> facts) {
        if (receiver == null || name == null) return false;
        for (Rules.SymbolSpec candidate : domain.symbols()) {
            if (!candidate.kind().equals("member_property")
                    || !terminalFqnName(candidate.fqn()).equals(name)) continue;
            if (memberOwnerPathCount(receiver, candidate, facts) > 1) return true;
        }
        return false;
    }

    private PsiIndex.Node implicitReceiver(PsiIndex.Node call, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        Integer owner = lexicalOwners.get(call.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if ((candidate.kind() == PsiIndex.NodeKind.LAMBDA
                    || candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || isTypeDeclaration(candidate))
                    && receiverTypeMatches(candidate, symbol, facts)) return candidate;
            owner = lexicalOwners.get(owner);
        }
        return null;
    }

    private boolean compatibleType(String actual, String required, PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        return compatibilityPathCount(actual, required, origin, facts) == 1;
    }

    private int compatibilityPathCount(String actual, String required, PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        if (actual == null || required == null) return 0;
        if (actual.equals(required)) return 1;
        if (actual.equals("plane_anchor_collection") && required.equals("immutable_iterable")) {
            return exactCollectionProducer(origin, facts) == null ? 0 : 1;
        }
        Rules.SymbolSpec physical = physicalTypeForOrigin(origin, facts);
        if (physical != null) {
            return conformancePathCountFromPhysical(physical, required, 0, new HashMap<>());
        }
        return conformancePathCount(actual, required, 0, new HashMap<>());
    }

    private int conformancePathCountFromPhysical(Rules.SymbolSpec physical, String required,
            int depth, Map<String, Boolean> active) {
        if (physical == null || depth >= 8) return 0;
        if (required.equals(physical.returnAbstractType())) return 1;
        String key = physical.fqn() + "\n" + physical.signature();
        if (active.put(key, Boolean.TRUE) != null) return 0;
        int paths = 0;
        for (String target : physical.conformsTo()) {
            paths += conformancePathCount(target, required, depth + 1, new HashMap<>());
            if (paths > 1) break;
        }
        active.remove(key);
        return Math.min(paths, 2);
    }

    private int conformancePathCount(String actual, String required, int depth,
            Map<String, Boolean> active) {
        if (actual.equals(required)) return 1;
        if (depth >= 8 || active.put(actual, Boolean.TRUE) != null) return 0;
        List<String> nextTypes = new ArrayList<>();
        for (Rules.SymbolSpec type : domain.symbols()) {
            if (!type.kind().equals("type") || !actual.equals(type.returnAbstractType())) continue;
            for (String target : type.conformsTo()) if (!nextTypes.contains(target)) nextTypes.add(target);
        }
        int paths = 0;
        for (String target : nextTypes) {
            paths += conformancePathCount(target, required, depth + 1, active);
            if (paths > 1) break;
        }
        active.remove(actual);
        return Math.min(paths, 2);
    }

    private Rules.SymbolSpec physicalTypeForOrigin(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        return physicalTypeForOrigin(origin, facts, 0, new HashMap<>());
    }

    private Rules.SymbolSpec physicalTypeForOrigin(PsiIndex.Node origin,
            List<Map<String, Object>> facts, int depth, Map<Integer, Boolean> active) {
        if (origin == null || depth >= 8 || active.put(origin.id(), Boolean.TRUE) != null) return null;
        Rules.SymbolSpec direct = uniquePhysicalFactSymbol(origin, facts);
        if (direct != null) return direct;
        if (origin.kind() == PsiIndex.NodeKind.FUNCTION_DECL) {
            PsiIndex.Node extensionType = declarationTypeNode(origin, true);
            Rules.SymbolSpec extensionPhysical = typeSymbolForReference(extensionType);
            if (extensionPhysical != null) return extensionPhysical;
        }
        if (origin.kind() == PsiIndex.NodeKind.NAME_REF && origin.name() != null) {
            String imported = importedFqn(origin.fileId(), origin.name());
            Rules.SymbolSpec importedType = imported == null ? null : typeSymbolByFqn(imported);
            if (importedType != null) return importedType;
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", origin.id());
            if (declaration == null) declaration = findLexicalDeclaration(origin, origin.name());
            if (declaration != null && declaration.id() != origin.id()) {
                Rules.SymbolSpec fromDeclaration = physicalTypeForOrigin(
                    declaration, facts, depth + 1, active);
                if (fromDeclaration != null) return fromDeclaration;
            }
        }
        PsiIndex.Node related = relatedNodeForFact(facts, "origin", origin.id());
        if (related == null) related = relatedNodeForFact(facts, "return_origin", origin.id());
        if (related != null && related.id() != origin.id()) {
            return physicalTypeForOrigin(related, facts, depth + 1, active);
        }
        return null;
    }

    private Rules.SymbolSpec uniquePhysicalFactSymbol(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        Rules.SymbolSpec match = null;
        for (String kind : List.of("type", "callback_receiver", "callback_parameter")) {
            Rules.SymbolSpec candidate = symbolForFact(facts, kind, origin.id());
            if (candidate == null || !candidate.kind().equals("type")) continue;
            String semantic = factValue(facts, kind, origin.id());
            if (semantic == null || !semantic.equals(candidate.returnAbstractType())) return null;
            if (match != null && (!match.fqn().equals(candidate.fqn())
                    || !match.signature().equals(candidate.signature()))) return null;
            match = candidate;
        }
        return match;
    }

    private Rules.SymbolSpec memberOwnerType(Rules.SymbolSpec member) {
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec candidate : domain.symbols()) {
            if (!candidate.kind().equals("type")
                    || !member.fqn().startsWith(candidate.fqn() + ".")) continue;
            if (match == null || candidate.fqn().length() > match.fqn().length()) match = candidate;
            else if (candidate.fqn().length() == match.fqn().length()) return null;
        }
        return match;
    }

    private int physicalOwnerPathCount(Rules.SymbolSpec child, Rules.SymbolSpec owner,
            int depth, Map<String, Boolean> active) {
        if (child == null || owner == null || depth > 8) return 0;
        String childKey = child.fqn() + "\n" + child.signature();
        String ownerKey = owner.fqn() + "\n" + owner.signature();
        if (childKey.equals(ownerKey)) return 1;
        if (active.put(childKey, Boolean.TRUE) != null) return 0;
        int paths = 0;
        for (String encoded : PHYSICAL_OWNER_RELATIONS) {
            String[] fields = encoded.split("\n", -1);
            if (!fields[0].equals(child.fqn()) || !fields[1].equals(child.signature())) continue;
            Rules.SymbolSpec next = typeSymbolExact(fields[2], fields[3]);
            paths += physicalOwnerPathCount(next, owner, depth + 1, active);
            if (paths > 1) break;
        }
        active.remove(childKey);
        return Math.min(paths, 2);
    }

    private void addOwnerConformance(PsiIndex.Node access, PsiIndex.Node receiver,
            Rules.SymbolSpec member, List<Map<String, Object>> facts,
            Map<String, Boolean> factKeys, Map<String, Integer> multiplicities,
            Map<Integer, Boolean> unsupported) {
        if (receiver == null || !member.kind().startsWith("member_")) return;
        Rules.SymbolSpec physical = physicalTypeForOrigin(receiver, facts);
        Rules.SymbolSpec owner = memberOwnerType(member);
        if (physical == null || owner == null || physical == owner) return;
        if (physicalOwnerPathCount(physical, owner, 0, new HashMap<>()) == 1) addFact(
            facts, factKeys, multiplicities, unsupported,
            "conformance", receiver, enclosingCallable(access), -1,
            owner.returnAbstractType(), owner);
    }

    private Rules.ArgumentSpec variadicArgument(Rules.SymbolSpec symbol) {
        for (Rules.ArgumentSpec argument : symbol.arguments()) if (argument.variadic()) return argument;
        return null;
    }

    private Rules.CallbackSpec callbackAt(Rules.SymbolSpec symbol, int position) {
        for (Rules.CallbackSpec callback : symbol.callbacks()) {
            if (callback.argumentPosition() == position) return callback;
        }
        return null;
    }

    private boolean isCallableValue(PsiIndex.Node value, List<Map<String, Object>> facts) {
        if (value == null) return false;
        if (value.kind() == PsiIndex.NodeKind.LAMBDA || value.kind() == PsiIndex.NodeKind.CALLABLE_REF) return true;
        if (value.kind() != PsiIndex.NodeKind.NAME_REF) return false;
        PsiIndex.Node binding = findLexicalDeclaration(value, value.name());
        return binding != null && ("callable".equals(typeOf(facts, binding))
                || "callable".equals(declaredSemanticType(binding)))
            && relatedNodeForFact(facts, "function_binding", binding.id()) != null;
    }

    private List<PsiIndex.Node> uniqueTargets(PsiIndex.Node from, PsiIndex.EdgeRole role) {
        List<PsiIndex.Node> result = new ArrayList<>();
        Map<Integer, Boolean> seen = new HashMap<>();
        for (PsiIndex.Node target : targets(from, role)) {
            if (seen.put(target.id(), Boolean.TRUE) == null) result.add(target);
        }
        return result;
    }

    private boolean allowsNull(Rules.SymbolSpec symbol, int position) {
        return position == 1 && (symbol.fqn().equals("com.pico.spatial.core.ecs.Entity.convertPositionFrom")
            && symbol.signature().equals("convertPositionFrom(position: Vector3, baseEntity: Entity?): Vector3")
            || symbol.fqn().equals("com.pico.spatial.core.ecs.Entity.convertRotationFrom")
            && symbol.signature().equals("convertRotationFrom(rotation: Quat, baseEntity: Entity?): Quat"));
    }

    private boolean isNullableResult(Rules.SymbolSpec symbol) {
        return symbol.fqn().equals("android.os.BaseBundle.getString")
                && symbol.signature().equals("getString(key: String): String?")
            || symbol.fqn().equals("com.pico.spatial.core.ecs.Entity.ComponentSet.get")
                && symbol.signature().equals("get(componentType: Class<T>): T?")
            || symbol.fqn().equals("com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle")
                && symbol.signature().equals("bundle: Bundle?")
            || symbol.fqn().equals("kotlin.Throwable.message")
                && symbol.signature().equals("message: String?")
            || symbol.fqn().equals("kotlin.collections.firstOrNull")
                && symbol.signature().equals("Iterable<T>.firstOrNull(): T?")
            || symbol.fqn().equals("kotlin.collections.maxByOrNull")
                && symbol.signature().equals("Iterable<T>.maxByOrNull(selector: (T) -> R): T?");
    }

    private String elementType(String producerType) {
        if ("entity_collection".equals(producerType)) return "entity";
        if ("plane_anchor_collection".equals(producerType)) return "plane_anchor";
        if ("integer_range".equals(producerType)) return "int";
        return null;
    }

    private String elementTypeForOrigin(PsiIndex.Node producer,
            List<Map<String, Object>> facts) {
        String type = typeOf(facts, producer);
        if ("plane_anchor_collection".equals(type)
                || exactCollectionProducer(producer, facts) != null
                || exactRetainedMemberCollectionProducer(producer, facts) != null) {
            return "plane_anchor";
        }
        return elementType(type);
    }

    private PsiIndex.Node exactRetainedMemberCollectionProducer(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        return exactRetainedMemberCollectionProducer(origin, facts, 0);
    }

    private PsiIndex.Node exactRetainedMemberCollectionProducer(PsiIndex.Node origin,
            List<Map<String, Object>> facts, int depth) {
        if (origin == null || depth > 1) return null;
        Rules.SymbolSpec filter = domainSymbolOrNull(
            "kotlin.collections.filter",
            "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>");
        PsiIndex.Node filterCall = directCall(origin);
        if (filterCall != null && filter != null
                && exactDomainResolution(filterCall, filter, facts)) {
            return depth == 0 ? exactRetainedMemberCollectionProducer(
                resolvedReceiver(filterCall), facts, depth + 1) : null;
        }
        if (origin.kind() != PsiIndex.NodeKind.NAME_REF || origin.name() == null
                || qualifiedSelectorParent(origin) != null) return null;
        PsiIndex.Node helper = enclosingFunctionDeclaration(origin);
        if (helper != null && helper.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                && isProductionPath(helper.fileId())) {
            PsiIndex.Node entryCall = null;
            for (PsiIndex.Node call : program.nodes()) {
                if (call.kind() != PsiIndex.NodeKind.CALL
                        || exactSourceTarget(call, facts) != helper) continue;
                if (entryCall != null) return null;
                entryCall = call;
            }
            PsiIndex.Node fallback = entryCall == null
                ? null : enclosingBinary(entryCall, "?:");
            Rules.SymbolSpec load = domainSymbolOrNull(
                "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors",
                "loadAllAnchors(): Array<PlaneAnchor>");
            PsiIndex.Node expected = fallback == null || load == null
                ? null : planeUniqueDomainCallInFile(fallback.fileId(), load, facts);
            PsiIndex.Node producer = planeExactSelectorCollectionProducer(
                origin, entryCall, fallback, expected, facts);
            if (producer != null) return producer;
        }
        return planeDirectRetainedMemberCollectionProducer(origin, facts);
    }

    private PsiIndex.Node planeDirectRetainedMemberCollectionProducer(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", origin.id());
        if (declaration == null) {
            declaration = findLexicalDeclaration(origin, origin.name());
        }
        PsiIndex.Node caller = enclosingFunctionDeclaration(origin);
        PsiIndex.Node ownerType = declaration == null
            ? null : enclosingTypeDeclaration(declaration);
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !declaration.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || !declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                || !"plane_anchor".equals(declaredCollectionElementType(declaration, facts))
                || caller == null || ownerType == null
                || enclosingTypeDeclaration(caller) != ownerType
                || !isProductionPath(caller.fileId())) return null;
        PsiIndex.Node assignment = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.ASSIGNMENT
                    || !isWithin(candidate, ownerType)
                    || planeAssignmentTargetDeclaration(candidate, facts) != declaration) continue;
            if (assignment != null) return null;
            assignment = candidate;
        }
        PsiIndex.Node value = assignment == null
            ? null : one(assignment, PsiIndex.EdgeRole.VALUE);
        PsiIndex.Node producer = exactCollectionProducerOrigin(value, facts);
        Rules.SymbolSpec load = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors",
            "loadAllAnchors(): Array<PlaneAnchor>");
        PsiIndex.Node expected = load == null
            ? null : planeUniqueDomainCallInFile(origin.fileId(), load, facts);
        return assignment != null && producer != null && expected != null
                && producer.id() == expected.id()
                && enclosingFunctionDeclaration(assignment) == caller
                && planeExactRetainedForProducer(
                    assignment, producer, origin, caller, facts)
            ? producer : null;
    }

    private String declaredCollectionElementType(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        if (origin == null) return null;
        if (origin.kind() == PsiIndex.NodeKind.QUALIFIED
                || origin.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
            PsiIndex.Node selector = one(origin, PsiIndex.EdgeRole.SELECTOR);
            if (selector != null && selector.id() != origin.id()) {
                return declaredCollectionElementType(selector, facts);
            }
        }
        PsiIndex.Node declaration = origin;
        if (origin.kind() == PsiIndex.NodeKind.NAME_REF && origin.name() != null) {
            declaration = relatedNodeForFact(facts, "def_use", origin.id());
            if (declaration == null) declaration = findLexicalDeclaration(origin, origin.name());
        }
        if (declaration != null && (declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                || declaration.kind() == PsiIndex.NodeKind.PARAMETER_DECL)) {
            PsiIndex.Node declaredType = declarationTypeNode(declaration, false);
            Rules.SymbolSpec list = declaredType == null ? null : typeSymbolForReference(declaredType);
            if (list != null && (list.fqn().equals("kotlin.collections.List")
                    && list.signature().equals("interface List<out E>")
                    || list.fqn().equals("kotlin.collections.Iterable")
                    && list.signature().equals("interface Iterable<out T>"))) {
                Rules.SymbolSpec plane = typeSymbolExact(
                    "com.pico.spatial.sense.plane.PlaneAnchor", "class PlaneAnchor");
                PsiIndex.Node match = null;
                for (PsiIndex.Node child : lexicalChildren(declaredType)) {
                    if (child.kind() != PsiIndex.NodeKind.TYPE_REF
                            || typeSymbolForReference(child) != plane) continue;
                    if (match != null) return null;
                    match = child;
                }
                if (match != null) return "plane_anchor";
            }
        }
        Rules.SymbolSpec filter = symbolForFact(facts, "call_resolution", origin.id());
        if (filter != null && filter.fqn().equals("kotlin.collections.filter")
                && filter.signature().equals(
                    "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>")) {
            String receiverElement = declaredCollectionElementType(
                resolvedReceiver(origin), facts);
            if (receiverElement != null) return receiverElement;
            PsiIndex.Node callback = callbackExpressionForCall(origin, facts);
            PsiIndex.Node parameter = callbackElementParameter(callback, facts);
            if ("plane_anchor".equals(typeOf(facts, parameter))) return "plane_anchor";
        }
        return null;
    }

    private Rules.SymbolSpec exactCollectionProducer(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        PsiIndex.Node boundary = exactCollectionProducerOrigin(origin, facts);
        return boundary == null ? null
            : symbolForFact(facts, "call_resolution", boundary.id());
    }

    private PsiIndex.Node exactCollectionProducerOrigin(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        return exactCollectionProducerOrigin(origin, facts, 0, new HashMap<>());
    }

    private PsiIndex.Node exactCollectionProducerOrigin(PsiIndex.Node origin,
            List<Map<String, Object>> facts, int depth, Map<Integer, Boolean> active) {
        if (origin == null || depth >= 8 || active.put(origin.id(), Boolean.TRUE) != null) return null;
        Rules.SymbolSpec resolution = symbolForFact(facts, "call_resolution", origin.id());
        if (origin.kind() == PsiIndex.NodeKind.CALL && resolution != null && resolution.fqn().equals(
                "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors")
                && resolution.signature().equals(
                    "loadAllAnchors(): Array<PlaneAnchor>")) return origin;
        List<PsiIndex.Node> candidates = collectionOriginCandidates(origin, facts);
        if (candidates.isEmpty()) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : candidates) {
            PsiIndex.Node producer = exactCollectionProducerOrigin(
                candidate, facts, depth + 1, new HashMap<>(active));
            if (producer == null || match != null && match.id() != producer.id()) return null;
            match = producer;
        }
        return match;
    }

    private List<PsiIndex.Node> collectionOriginCandidates(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> candidates = new ArrayList<>();
        for (String kind : List.of("origin", "return_origin", "def_use", "definition")) {
            PsiIndex.Node candidate = relatedNodeForFact(facts, kind, origin.id());
            if (candidate == null || candidate.id() == origin.id()) continue;
            addUniqueNode(candidates, candidate);
        }
        if (origin.kind() == PsiIndex.NodeKind.PARAMETER_DECL) {
            for (Map<String, Object> fact : facts) {
                if (!"argument_binding".equals(fact.get("kind"))
                        || !Long.valueOf(origin.id()).equals(fact.get("relatedNodeId"))) continue;
                int argumentId = ((Long) fact.get("subjectNodeId")).intValue();
                PsiIndex.Node value = argumentValue(program.node(argumentId));
                if (value != null) addUniqueNode(candidates, value);
            }
        }
        if (origin.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                || origin.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
            PsiIndex.Node structural = origin.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                ? one(origin, PsiIndex.EdgeRole.INITIALIZER)
                : one(origin, PsiIndex.EdgeRole.VALUE);
            if (structural != null && structural.id() != origin.id()) addUniqueNode(candidates, structural);
        }
        return candidates;
    }

    private PsiIndex.Node enclosingFunctionDeclaration(PsiIndex.Node node) {
        if (node == null) return null;
        if (node.kind() == PsiIndex.NodeKind.FUNCTION_DECL) return node;
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL) return candidate;
            owner = lexicalOwners.get(candidate.id());
        }
        return null;
    }

    private void addUniqueNode(List<PsiIndex.Node> nodes, PsiIndex.Node candidate) {
        for (PsiIndex.Node node : nodes) if (node.id() == candidate.id()) return;
        nodes.add(candidate);
    }

    private PsiIndex.Node representativeOrigin(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        return representativeOrigin(origin, facts, 0, new HashMap<>());
    }

    private PsiIndex.Node representativeOrigin(PsiIndex.Node origin,
            List<Map<String, Object>> facts, int depth, Map<Integer, Boolean> active) {
        if (origin == null || depth >= 8 || active.put(origin.id(), Boolean.TRUE) != null) return origin;
        Rules.SymbolSpec producer = symbolForFact(facts, "return_origin", origin.id());
        if (producer != null && producer.fqn().equals(
                "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors")
                && producer.signature().equals("loadAllAnchors(): Array<PlaneAnchor>")) return origin;
        List<Integer> arithmetic = arithmeticInputs.get(origin.id());
        if (arithmetic != null && arithmetic.size() == 2) {
            PsiIndex.Node left = representativeOrigin(program.node(arithmetic.get(0)), facts,
                depth + 1, new HashMap<>());
            PsiIndex.Node right = representativeOrigin(program.node(arithmetic.get(1)), facts,
                depth + 1, new HashMap<>());
            return left != null && right != null && left.id() == right.id() ? left : origin;
        }
        if ("fresh".equals(factValue(facts, "origin", origin.id()))) return origin;
        if (origin.kind() == PsiIndex.NodeKind.NAME_REF && origin.name() != null) {
            PsiIndex.Node definition = relatedNodeForFact(facts, "def_use", origin.id());
            if (definition != null) {
                PsiIndex.Node value = relatedNodeForFact(facts, "definition", definition.id());
                if (value == null && definition.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
                    value = one(definition, PsiIndex.EdgeRole.INITIALIZER);
                }
                if (value != null) return representativeOrigin(value, facts, depth + 1, active);
                return representativeOrigin(definition, facts, depth + 1, active);
            }
        }
        PsiIndex.Node related = relatedNodeForFact(facts, "origin", origin.id());
        if (related != null && related.id() != origin.id()) {
            return representativeOrigin(related, facts, depth + 1, active);
        }
        return origin;
    }

    private boolean implicitItAvailable(PsiIndex.Node lambda) {
        for (PsiIndex.Node node : program.nodes()) {
            if (!isWithin(node, lambda) || node.name() == null || !node.name().equals("it")) continue;
            if (node.kind() == PsiIndex.NodeKind.PARAMETER_DECL
                    || node.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                    || node.kind() == PsiIndex.NodeKind.FUNCTION_DECL) return false;
        }
        return true;
    }

    private PsiIndex.Node callbackReceiverOrigin(Rules.CallbackSpec callback,
            PsiIndex.Node receiver, Map<Integer, List<PsiIndex.Node>> mapped,
            List<Map<String, Object>> facts) {
        if (callback.receiverSource() == null) return null;
        if (callback.receiverSource().equals("call_receiver")) {
            return exactCallbackReceiverOrigin(receiver, facts);
        }
        if (!callback.receiverSource().startsWith("argument:")) return null;
        int position;
        try {
            position = Integer.parseInt(callback.receiverSource().substring("argument:".length()));
        } catch (NumberFormatException invalid) {
            return null;
        }
        List<PsiIndex.Node> arguments = mapped.get(position);
        PsiIndex.Node value = arguments == null || arguments.size() != 1 ? null
            : one(arguments.get(0), PsiIndex.EdgeRole.VALUE);
        return exactCallbackReceiverOrigin(value, facts);
    }

    private PsiIndex.Node exactCallbackReceiverOrigin(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null || value.kind() != PsiIndex.NodeKind.NAME_REF) return value;
        return relatedNodeForFact(facts, "def_use", value.id());
    }

    private Rules.SymbolSpec callbackReceiverPhysical(Rules.SymbolSpec symbol,
            Rules.CallbackSpec callback) {
        String fqn = symbol.fqn();
        String signature = symbol.signature();
        int position = callback.argumentPosition();
        if (fqn.equals("com.pico.spatial.ui.foundation.dsl.launch")
                && signature.equals("Application.launch(block: SpatialAppScope.() -> Unit): Unit")
                && position == 0) return typeSymbolExact(
            "com.pico.spatial.ui.foundation.dsl.SpatialAppScope", "interface SpatialAppScope");
        if (fqn.equals("com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer")
                && signature.equals("SpatialAppScope.DefaultWindowContainer(content: @Composable WindowContainerScope.() -> Unit): Unit")
                && position == 0) return typeSymbolExact(
            "com.pico.spatial.ui.platform.containers.WindowContainerScope", "interface WindowContainerScope");
        if (fqn.equals("com.pico.spatial.ui.foundation.dsl.Stage")
                && signature.equals("SpatialAppScope.Stage(id: String, immersion: Immersion? = null, brightness: Brightness? = null, upperLimbRenderMode: UpperLimbRenderMode? = null, targetActivity: Class<out ComponentActivity>? = null, content: @Composable StageScope.() -> Unit): Unit")
                && position == 5) return typeSymbolExact(
            "com.pico.spatial.ui.platform.containers.StageScope", "interface StageScope");
        if (fqn.equals("com.pico.spatial.ui.design.Button")
                && signature.equals("Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, size: ButtonSize = ButtonDefaults.Regular, colors: ButtonColors = ButtonDefaults.buttonColors(), leadingIcon: (@Composable () -> Unit)? = null, trailingIcon: (@Composable () -> Unit)? = null, contentPadding: PaddingValues = ButtonDefaults.paddingForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), shape: Shape = ButtonDefaults.shapeForButtonSize(size), gap: Dp = ButtonDefaults.gapForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), interactionSource: MutableInteractionSource = remember { MutableInteractionSource() }, content: @Composable RowScope.() -> Unit): Unit")
                && position == 11) return typeSymbolExact(
            "androidx.compose.foundation.layout.RowScope", "interface RowScope");
        if (fqn.equals("com.pico.spatial.ui.foundation.content.SpatialView")
                && signature.equals("SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit")
                && position == 2) return typeSymbolExact(
            "com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder", "interface AttachmentPanelBuilder");
        if (fqn.equals("androidx.compose.runtime.DisposableEffect")
                && isExactDisposableReceiver(signature, position)
                && callback.receiverAbstractType().equals("disposable_effect_scope")) return typeSymbolExact(
            "androidx.compose.runtime.DisposableEffectScope", "class DisposableEffectScope");
        if (fqn.equals("androidx.compose.runtime.LaunchedEffect")
                && isExactLaunchedReceiver(signature, position)
                && callback.receiverAbstractType().equals("coroutine_scope")) return typeSymbolExact(
            "kotlinx.coroutines.CoroutineScope", "interface CoroutineScope");
        return null;
    }

    private boolean isExactDisposableReceiver(String signature, int position) {
        return position == 1 && (signature.equals(
                "DisposableEffect(key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit")
                || signature.equals(
                "DisposableEffect(vararg keys: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit"))
            || position == 2 && signature.equals(
                "DisposableEffect(key1: Any?, key2: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit")
            || position == 3 && signature.equals(
                "DisposableEffect(key1: Any?, key2: Any?, key3: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit");
    }

    private boolean isExactLaunchedReceiver(String signature, int position) {
        return position == 1 && (signature.equals(
                "LaunchedEffect(key1: Any?, block: suspend CoroutineScope.() -> Unit): Unit")
                || signature.equals(
                "LaunchedEffect(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit): Unit"))
            || position == 2 && signature.equals(
                "LaunchedEffect(key1: Any?, key2: Any?, block: suspend CoroutineScope.() -> Unit): Unit")
            || position == 3 && signature.equals(
                "LaunchedEffect(key1: Any?, key2: Any?, key3: Any?, block: suspend CoroutineScope.() -> Unit): Unit");
    }

    private PsiIndex.Node adaptedReceiverParameter(PsiIndex.Node reference,
            Rules.CallbackSpec callback, List<Map<String, Object>> facts) {
        PsiIndex.Node target = uniqueReferencedCallable(reference);
        if (target == null) return null;
        List<PsiIndex.Node> parameters = targets(target, PsiIndex.EdgeRole.PARAMETER);
        if (parameters.isEmpty()) return null;
        PsiIndex.Node first = parameters.get(0);
        return compatibleType(declaredSemanticType(first), callback.receiverAbstractType(), first, facts)
            ? first : null;
    }

    private Rules.SymbolSpec callbackParameterPhysical(Rules.SymbolSpec symbol,
            Rules.CallbackSpec callback, int position) {
        if (symbol.fqn().equals("com.pico.spatial.ui.foundation.content.SpatialView")
                && symbol.signature().equals("SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit")
                && (callback.argumentPosition() == 1 || callback.argumentPosition() == 3)) {
            if (position == 0) return typeSymbolExact(
                "com.pico.spatial.core.container.SpatialViewContent", "class SpatialViewContent");
            if (position == 1) return typeSymbolExact(
                "com.pico.spatial.ui.foundation.content.SpatialViewAttachments", "interface SpatialViewAttachments");
        }
        if (symbol.fqn().equals("com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate")
                && symbol.signature().equals("subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable")
                && callback.argumentPosition() == 0 && position == 0) return typeSymbolExact(
            "com.pico.spatial.sense.base.AnchorUpdate", "class AnchorUpdate<T : Anchor>");
        return null;
    }

    private Rules.SymbolSpec physicalResultType(Rules.SymbolSpec symbol) {
        if (symbol.fqn().equals("android.os.Bundle") && symbol.signature().equals("Bundle()")
                && "bundle".equals(symbol.returnAbstractType())) return exactPhysicalType(
            "android.os.Bundle", "class Bundle", "bundle");
        if (symbol.fqn().equals("com.pico.spatial.ui.platform.containers.LocalSpatialNavigator")
                && symbol.signature().equals("val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>")
                && "composition_local".equals(symbol.returnAbstractType())) {
            return exactPhysicalType("androidx.compose.runtime.ProvidableCompositionLocal",
                "abstract class ProvidableCompositionLocal<T>", "composition_local");
        }
        if (symbol.fqn().equals("com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle")
                && symbol.signature().equals("bundle: Bundle?")
                && "bundle".equals(symbol.returnAbstractType())) return exactPhysicalType(
            "android.os.Bundle", "class Bundle", "bundle");
        if (symbol.fqn().equals("kotlin.ranges.until")
                && symbol.signature().equals("Int.until(to: Int): IntRange")
                && "integer_range".equals(symbol.returnAbstractType())) return exactPhysicalType(
            "kotlin.ranges.IntRange", "class IntRange", "integer_range");
        return null;
    }

    private boolean isCompositionLocalCurrent(Rules.SymbolSpec symbol) {
        return symbol != null
            && symbol.fqn().equals("androidx.compose.runtime.CompositionLocal.current")
            && symbol.signature().equals("current: T")
            && "spatial_navigator".equals(symbol.returnAbstractType());
    }

    private boolean isLocalSpatialNavigatorProducer(Rules.SymbolSpec symbol) {
        return symbol != null
            && symbol.fqn().equals(
                "com.pico.spatial.ui.platform.containers.LocalSpatialNavigator")
            && symbol.signature().equals(
                "val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>")
            && "composition_local".equals(symbol.returnAbstractType());
    }

    private boolean hasExactLocalSpatialNavigatorProducer(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        return hasExactLocalSpatialNavigatorProducer(
            origin, facts, 0, new HashMap<>());
    }

    private boolean hasExactLocalSpatialNavigatorProducer(PsiIndex.Node origin,
            List<Map<String, Object>> facts, int depth, Map<Integer, Boolean> active) {
        if (origin == null || depth >= 8
                || active.put(origin.id(), Boolean.TRUE) != null) return false;
        for (String kind : List.of("call_resolution", "origin", "return_origin")) {
            if (isLocalSpatialNavigatorProducer(symbolForFact(facts, kind, origin.id()))) return true;
        }
        List<PsiIndex.Node> candidates = new ArrayList<>();
        for (String kind : List.of("origin", "return_origin", "def_use", "definition")) {
            PsiIndex.Node candidate = relatedNodeForFact(facts, kind, origin.id());
            if (candidate != null && candidate.id() != origin.id()) addUniqueNode(candidates, candidate);
        }
        if (origin.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
            PsiIndex.Node initializer = one(origin, PsiIndex.EdgeRole.INITIALIZER);
            if (initializer != null && initializer.id() != origin.id()) {
                addUniqueNode(candidates, initializer);
            }
        }
        if (candidates.size() != 1) return false;
        return hasExactLocalSpatialNavigatorProducer(
            candidates.get(0), facts, depth + 1, active);
    }

    private boolean requiresExactPhysicalResult(Rules.SymbolSpec symbol) {
        return symbol.fqn().equals("android.os.Bundle") && symbol.signature().equals("Bundle()")
            || symbol.fqn().equals("com.pico.spatial.ui.platform.containers.LocalSpatialNavigator")
                && symbol.signature().equals(
                    "val LocalSpatialNavigator: ProvidableCompositionLocal<SpatialNavigator>")
            || symbol.fqn().equals("com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle")
                && symbol.signature().equals("bundle: Bundle?")
            || symbol.fqn().equals("kotlin.ranges.until")
                && symbol.signature().equals("Int.until(to: Int): IntRange");
    }

    private Rules.SymbolSpec exactPhysicalType(String fqn, String signature, String semantic) {
        Rules.SymbolSpec type = typeSymbolExact(fqn, signature);
        return type != null && type.kind().equals("type")
            && semantic.equals(type.returnAbstractType()) ? type : null;
    }

    private String importedFqn(int fileId, String exposedName) {
        if (exposedName == null) return null;
        String match = null;
        int count = 0;
        for (int importId : program.file(fileId).importIds()) {
            PsiIndex.ImportEntry entry = program.imports().get(importId);
            if (!entry.exposedName().equals(exposedName)) continue;
            count++;
            match = entry.fqName();
        }
        return count == 1 ? match : null;
    }

    private boolean hasAmbiguousImport(int fileId, String exposedName) {
        if (exposedName == null) return false;
        int count = 0;
        for (int importId : program.file(fileId).importIds()) {
            if (program.imports().get(importId).exposedName().equals(exposedName)) count++;
        }
        return count > 1;
    }

    private boolean isHiddenByAlias(int fileId, String writtenName) {
        if (writtenName == null) return false;
        for (int importId : program.file(fileId).importIds()) {
            PsiIndex.ImportEntry entry = program.imports().get(importId);
            if (!entry.exposedName().equals(writtenName)
                    && terminalFqnName(entry.fqName()).equals(writtenName)) return true;
        }
        return false;
    }

    private String terminalFqnName(String fqn) {
        int separator = fqn.lastIndexOf('.');
        return separator < 0 ? fqn : fqn.substring(separator + 1);
    }

    private boolean isDefaultImported(String fqn) {
        return fqn.equals("kotlin.with") || fqn.equals("kotlin.apply") || fqn.equals("kotlin.let")
            || fqn.equals("kotlin.runCatching") || fqn.equals("kotlin.repeat")
            || fqn.equals("kotlin.collections.emptyList") || fqn.equals("kotlin.collections.toList")
            || fqn.equals("kotlin.collections.isEmpty") || fqn.equals("kotlin.collections.isNotEmpty")
            || fqn.equals("kotlin.collections.forEach") || fqn.equals("kotlin.collections.filter")
            || fqn.equals("kotlin.collections.maxByOrNull") || fqn.equals("kotlin.collections.firstOrNull")
            || fqn.equals("kotlin.ranges.until") || fqn.equals("kotlin.ranges.coerceAtLeast");
    }

    private boolean isNumeric(String type) {
        return "int".equals(type) || "long".equals(type) || "float".equals(type) || "double".equals(type);
    }

    private boolean isPrimitiveComparable(String type) {
        return "boolean".equals(type) || isNumeric(type);
    }

    private boolean isCalleeOrTypeName(PsiIndex.Node node) {
        Integer ownerId = lexicalOwners.get(node.id());
        if (ownerId == null) return false;
        PsiIndex.Node owner = program.node(ownerId);
        return isTarget(owner, PsiIndex.EdgeRole.CALLEE, node)
            || isTarget(owner, PsiIndex.EdgeRole.TYPE, node)
            || isTarget(owner, PsiIndex.EdgeRole.TYPE_ARGUMENT, node);
    }

    private boolean isTarget(PsiIndex.Node from, PsiIndex.EdgeRole role, PsiIndex.Node target) {
        for (PsiIndex.Node candidate : targets(from, role)) if (candidate.id() == target.id()) return true;
        return false;
    }

    private PsiIndex.Node authorityOwner(PsiIndex.Node property) {
        Integer ownerId = lexicalOwners.get(property.id());
        if (ownerId == null) return null;
        PsiIndex.Node owner = program.node(ownerId);
        if (owner.kind() == PsiIndex.NodeKind.FILE) return property;
        if (owner.kind() == PsiIndex.NodeKind.OBJECT_DECL || owner.kind() == PsiIndex.NodeKind.COMPANION_DECL) return owner;
        return null;
    }

    private PsiIndex.Node enclosingAuthorityProperty(PsiIndex.Node node) {
        Integer owner = node == null ? null : lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                    || candidate.kind() == PsiIndex.NodeKind.LAMBDA) return null;
            if (candidate.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                    && authorityOwner(candidate) != null
                    && isProductionPath(candidate.fileId())) return candidate;
            owner = lexicalOwners.get(candidate.id());
        }
        return null;
    }

    private List<PsiIndex.Node> propertyOrigins(PsiIndex.Node property) {
        List<PsiIndex.Node> origins = new ArrayList<>();
        PsiIndex.Node initializer = one(property, PsiIndex.EdgeRole.INITIALIZER);
        if (initializer != null) {
            origins.add(initializer);
            return origins;
        }
        for (PsiIndex.Node child : lexicalChildren(property)) {
            if (child.kind() == PsiIndex.NodeKind.TYPE_REF || child.kind() == PsiIndex.NodeKind.ANNOTATION) continue;
            if (child.kind() == PsiIndex.NodeKind.BLOCK) {
                PsiIndex.Node exit = normalExit(child);
                if (exit != null && exit.kind() == PsiIndex.NodeKind.RETURN) exit = one(exit, PsiIndex.EdgeRole.RETURN_VALUE);
                child = exit;
            }
            if (child == null) continue;
            boolean duplicate = false;
            for (PsiIndex.Node origin : origins) if (origin.id() == child.id()) duplicate = true;
            if (!duplicate) origins.add(child);
        }
        return origins;
    }

    private boolean isFreshConstruction(PsiIndex.Node node, List<Map<String, Object>> facts) {
        if (node == null) return true;
        if (node.kind() == PsiIndex.NodeKind.NAME_REF && node.name() != null) {
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", node.id());
            if (declaration == null) declaration = findLexicalDeclaration(node, node.name());
            if (declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                    && authorityOwner(declaration) != null) return false;
        }
        PsiIndex.Node call = directCall(node);
        PsiIndex.Node target = call == null ? null : exactSourceTarget(call, facts);
        if (target != null && target.kind() == PsiIndex.NodeKind.CLASS_DECL) return true;
        PsiIndex.Node representative = representativeOrigin(node, facts);
        if (representative == null) representative = node;
        if ("fresh".equals(factValue(facts, "origin", representative.id()))) return true;
        Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", representative.id());
        return symbol != null && symbol.effects().contains("construct");
    }

    private boolean isProductionPath(int fileId) {
        String path = program.file(fileId).path().replace('\\', '/');
        return ("/" + path).contains("/src/main/");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> kernelFacts() {
        Object raw = kernel.get("facts");
        if (!(raw instanceof List<?>)) throw new IllegalArgumentException("kernel facts are absent");
        return (List<Map<String, Object>>) raw;
    }

    private boolean exactFact(List<Map<String, Object>> facts, String kind,
            PsiIndex.Node subject, PsiIndex.Node owner, PsiIndex.Node related,
            String value, Rules.SymbolSpec symbol) {
        if (subject == null) return false;
        long ownerId = owner == null ? -1L : owner.id();
        long relatedId = related == null ? -1L : related.id();
        String fqn = symbol == null ? "" : symbol.fqn();
        String signature = symbol == null ? "" : symbol.signature();
        int count = 0;
        for (Map<String, Object> fact : facts) {
            if (kind.equals(fact.get("kind"))
                    && Long.valueOf(subject.id()).equals(fact.get("subjectNodeId"))
                    && Long.valueOf(ownerId).equals(fact.get("ownerNodeId"))
                    && Long.valueOf(relatedId).equals(fact.get("relatedNodeId"))
                    && value.equals(fact.get("value"))
                    && fqn.equals(fact.get("symbolFqn"))
                    && signature.equals(fact.get("symbolSignature"))) count++;
        }
        return count == 1;
    }

    private boolean exactDomainResolution(PsiIndex.Node call, Rules.SymbolSpec symbol,
            List<Map<String, Object>> facts) {
        return exactFact(facts, "call_resolution", call, enclosingCallable(call), null,
            "domain", symbol);
    }

    private PsiIndex.Node exactSourceTarget(PsiIndex.Node call,
            List<Map<String, Object>> facts) {
        PsiIndex.Node target = relatedNodeForFact(facts, "call_resolution", call.id());
        return target != null && exactFact(facts, "call_resolution", call,
            enclosingCallable(call), target, "source", null) ? target : null;
    }

    private boolean hasExactTaint(PsiIndex.Node node, String expected,
            List<Map<String, Object>> facts) {
        List<String> values = new ArrayList<>();
        for (Map<String, Object> fact : facts) {
            if ("taint".equals(fact.get("kind"))
                    && Long.valueOf(node.id()).equals(fact.get("subjectNodeId"))) {
                values.add((String) fact.get("value"));
            }
        }
        return values.equals(List.of(expected));
    }

    private boolean hasAnyTaint(PsiIndex.Node node, List<Map<String, Object>> facts) {
        return hasFact(facts, "taint", node.id());
    }

    private Map<Integer, List<PsiIndex.Node>> reviewedDomainMapping(PsiIndex.Node call,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        List<Rules.SymbolSpec> candidates = domainCandidates(call, facts);
        if (candidates.size() != 1 || candidates.get(0) != symbol
                || !receiverMatches(call, symbol, facts)) return null;
        Map<Integer, List<PsiIndex.Node>> potential = mapDomainArguments(call, symbol, facts, true);
        if (potential == null) return null;
        Map<Integer, List<PsiIndex.Node>> strict = mapDomainArguments(call, symbol, facts);
        if (strict != null) {
            return exactDomainResolution(call, symbol, facts) && !hasAnyTaint(call, facts)
                ? strict : null;
        }
        return !hasFact(facts, "call_resolution", call.id())
                && hasExactTaint(call, "unsupported", facts) ? potential : null;
    }

    private PsiIndex.Node mappedArgument(Map<Integer, List<PsiIndex.Node>> mapping, int position) {
        if (mapping == null) return null;
        List<PsiIndex.Node> values = mapping.get(position);
        return values != null && values.size() == 1
                && values.get(0).kind() == PsiIndex.NodeKind.ARGUMENT ? values.get(0) : null;
    }

    private PsiIndex.Node mappedLambda(Map<Integer, List<PsiIndex.Node>> mapping, int position) {
        PsiIndex.Node argument = mappedArgument(mapping, position);
        PsiIndex.Node value = argument == null ? null : one(argument, PsiIndex.EdgeRole.VALUE);
        return value != null && value.kind() == PsiIndex.NodeKind.LAMBDA ? value : null;
    }

    private PsiIndex.Node directCall(PsiIndex.Node statement) {
        if (statement == null) return null;
        if (statement.kind() == PsiIndex.NodeKind.CALL) return statement;
        if (statement.kind() != PsiIndex.NodeKind.QUALIFIED) return null;
        PsiIndex.Node selector = one(statement, PsiIndex.EdgeRole.SELECTOR);
        return selector != null && selector.kind() == PsiIndex.NodeKind.CALL ? selector : null;
    }

    private List<PsiIndex.Node> directCalls(PsiIndex.Node callable) {
        if (callable == null) return null;
        PsiIndex.Node body = callable.kind() == PsiIndex.NodeKind.LAMBDA
            ? one(callable, PsiIndex.EdgeRole.LAMBDA_BODY)
            : one(callable, PsiIndex.EdgeRole.BODY);
        if (body == null) return null;
        List<PsiIndex.Node> statements = body.kind() == PsiIndex.NodeKind.BLOCK
            ? lexicalChildren(body) : List.of(body);
        List<PsiIndex.Node> calls = new ArrayList<>();
        for (PsiIndex.Node statement : statements) {
            PsiIndex.Node call = directCall(statement);
            if (call == null || enclosingCallable(call) != callable) return null;
            calls.add(call);
        }
        return calls;
    }

    private List<PsiIndex.Node> directCleanupCalls(PsiIndex.Node callable) {
        if (callable == null) return null;
        PsiIndex.Node body = callable.kind() == PsiIndex.NodeKind.LAMBDA
            ? one(callable, PsiIndex.EdgeRole.LAMBDA_BODY)
            : one(callable, PsiIndex.EdgeRole.BODY);
        if (body == null) return null;
        List<PsiIndex.Node> statements = body.kind() == PsiIndex.NodeKind.BLOCK
            ? lexicalChildren(body) : List.of(body);
        List<PsiIndex.Node> calls = new ArrayList<>();
        for (PsiIndex.Node statement : statements) {
            PsiIndex.Node call = directCall(statement);
            if (call != null && enclosingCallable(call) == callable) {
                calls.add(call);
                continue;
            }
            if (statement.kind() != PsiIndex.NodeKind.NAME_REF
                    || !"Unit".equals(statement.name())
                    || statement.value() != null
                    || findLexicalDeclaration(statement, statement.name()) != null
                    || cleanupUnitIsShadowed(statement)
                    || sourceTypeDeclaration(statement) != null
                    || importedFqn(statement.fileId(), statement.name()) != null
                    || hasAmbiguousImport(statement.fileId(), statement.name())) return null;
        }
        return calls;
    }

    private boolean cleanupUnitIsShadowed(PsiIndex.Node use) {
        if (use == null) return false;
        PsiIndex.Node useType = enclosingTypeDeclaration(use);
        String usePackage = program.file(use.fileId()).packageName();
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                    || !"Unit".equals(candidate.name())) continue;
            if (isTopLevel(candidate)
                    && usePackage.equals(program.file(candidate.fileId()).packageName())) return true;
            Integer ownerId = lexicalOwners.get(candidate.id());
            if (useType != null && ownerId != null && ownerId == useType.id()) return true;
        }
        return false;
    }

    private boolean isDirectStatement(PsiIndex.Node call, PsiIndex.Node callable) {
        if (call == null || callable == null) return false;
        PsiIndex.Node body = callable.kind() == PsiIndex.NodeKind.LAMBDA
            ? one(callable, PsiIndex.EdgeRole.LAMBDA_BODY)
            : one(callable, PsiIndex.EdgeRole.BODY);
        if (body == null) return false;
        for (PsiIndex.Node statement : body.kind() == PsiIndex.NodeKind.BLOCK
                ? lexicalChildren(body) : List.of(body)) {
            PsiIndex.Node direct = directCall(statement);
            if (direct != null && direct.id() == call.id()) return true;
        }
        return false;
    }

    private PsiIndex.Node uniqueDirectResolvedCall(PsiIndex.Node callable,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        List<PsiIndex.Node> calls = directCalls(callable);
        if (calls == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : calls) {
            if (!exactDomainResolution(call, symbol, facts)) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node uniqueDirectSourceCall(PsiIndex.Node callable,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> calls = directCalls(callable);
        if (calls == null || calls.size() != 1) return null;
        PsiIndex.Node call = calls.get(0);
        PsiIndex.Node target = exactSourceTarget(call, facts);
        return target != null && isProductionPath(call.fileId())
                && isProductionPath(target.fileId()) ? call : null;
    }

    // CP2 spatial/ECS emitter section. These stubs are replaced independently after the
    // contemporaneous exact-vector RED; keeping the slots live makes every focused probe use the
    // same sixteen-part combiner topology.
    private Rules.Analysis analyzeProjectEntry() {
        Rules.SymbolSpec applicationType = typeSymbolExact(
            "android.app.Application", "open class Application");
        Rules.SymbolSpec onCreate = domainSymbolOrNull(
            "android.app.Application.onCreate", "onCreate(): Unit");
        Rules.SymbolSpec launch = domainSymbolOrNull(
            "com.pico.spatial.ui.foundation.dsl.launch",
            "Application.launch(block: SpatialAppScope.() -> Unit): Unit");
        Rules.SymbolSpec spatialScope = typeSymbolExact(
            "com.pico.spatial.ui.foundation.dsl.SpatialAppScope", "interface SpatialAppScope");
        Rules.SymbolSpec with = domainSymbolOrNull(
            "kotlin.with", "with(receiver: T, block: T.() -> R): R");
        Rules.SymbolSpec window = domainSymbolOrNull(
            "com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer",
            "SpatialAppScope.DefaultWindowContainer(content: @Composable WindowContainerScope.() -> Unit): Unit");
        Rules.SymbolSpec activityType = typeSymbolExact(
            "com.pico.spatial.ui.platform.stub.SpatialLaunchActivity",
            "abstract class SpatialLaunchActivity");
        if (applicationType == null || onCreate == null || launch == null
                || spatialScope == null || with == null || window == null || activityType == null
                || !callbackShape(launch, 0, "application_entry", "spatial_app_scope")) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        PsiIndex.Node activity = uniqueLaunchActivity(facts, activityType);
        PsiIndex.Node activitySuper = activity == null
            ? null : cp2seExactSuperReference(activity, activityType, facts);
        if (activitySuper == null) return Rules.emptyAnalysis();

        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node application : program.nodes()) {
            if (application.kind() != PsiIndex.NodeKind.CLASS_DECL
                    || !isProductionPath(application.fileId())
                    || !exactFact(facts, "type", application, null, null,
                        "android_application", applicationType)) continue;
            PsiIndex.Node applicationSuper = cp2seExactSuperReference(
                application, applicationType, facts);
            PsiIndex.Node entry = cp2seUniqueProductionRoot(application, onCreate, facts);
            if (applicationSuper == null || entry == null) continue;

            PsiIndex.Node launchCall = null;
            PsiIndex.Node launchReference = null;
            PsiIndex.ImportEntry launchImport = null;
            for (PsiIndex.Node call : directStatementCallsLoose(entry)) {
                Map<Integer, List<PsiIndex.Node>> mapping =
                    cp2seReviewedLaunchMapping(call, launch, spatialScope, facts);
                PsiIndex.Node argument = mappedArgument(mapping, 0);
                PsiIndex.Node value = argument == null ? null : one(argument, PsiIndex.EdgeRole.VALUE);
                PsiIndex.ImportEntry imported = cp2seExactImport(call, launch.fqn());
                if (mapping == null || value == null
                        || value.kind() != PsiIndex.NodeKind.CALLABLE_REF || imported == null) continue;
                if (launchCall != null) {
                    launchCall = null;
                    launchReference = null;
                    launchImport = null;
                    break;
                }
                launchCall = call;
                launchReference = value;
                launchImport = imported;
            }
            PsiIndex.Node root = cp2seReferencedRoot(launchReference, spatialScope, facts);
            PsiIndex.Node withCall = root == null ? null : one(root, PsiIndex.EdgeRole.BODY);
            Map<Integer, List<PsiIndex.Node>> withMap = withCall == null
                || withCall.kind() != PsiIndex.NodeKind.CALL
                || !exactDomainResolution(withCall, with, facts)
                ? null : mapDomainArguments(withCall, with, facts);
            PsiIndex.Node receiverArgument = mappedArgument(withMap, 0);
            PsiIndex.Node receiverValue = receiverArgument == null
                ? null : one(receiverArgument, PsiIndex.EdgeRole.VALUE);
            PsiIndex.Node rootLambda = mappedLambda(withMap, 1);
            List<PsiIndex.Node> parameters = root == null
                ? List.of() : targets(root, PsiIndex.EdgeRole.PARAMETER);
            PsiIndex.Node parameter = parameters.size() == 1 ? parameters.get(0) : null;
            PsiIndex.Node receiverDeclaration = receiverValue == null
                ? null : relatedNodeForFact(facts, "def_use", receiverValue.id());
            PsiIndex.Node windowCall = uniqueDirectResolvedCall(rootLambda, window, facts);
            if (launchCall == null || root == null || !isTopLevel(root)
                    || !isProductionPath(root.fileId()) || parameter == null
                    || receiverDeclaration != parameter || rootLambda == null || windowCall == null
                    || !exactFact(facts, "type", parameter, root, null,
                        "spatial_app_scope", spatialScope)) continue;

            String alternative = launchImport.exposedName().equals(terminalFqnName(launch.fqn()))
                ? "direct-launch-import" : "aliased-launch-import";
            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(application, witnesses)
                && addWitness(applicationSuper, witnesses)
                && addWitness(activity, witnesses)
                && addWitness(activitySuper, witnesses)
                && addWitness(launchImport, witnesses)
                && addWitness(launchCall, witnesses)
                && addWitness(launchReference, witnesses)
                && addWitness(root, witnesses)
                && addWitness(withCall, witnesses)
                && addWitness(rootLambda, witnesses)
                && addWitness(windowCall, witnesses);
            if (!valid) continue;
            Rules.Analysis candidate = cp2seClaim(
                "spatial.project-entry", "application-launch-root", alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("spatial.project-entry", matchAlternative);
        return match;
    }
    private Rules.Analysis analyzeEntityContent() {
        Rules.SymbolSpec stage = domainSymbolOrNull(
            "com.pico.spatial.ui.foundation.dsl.Stage", STAGE_SIGNATURE);
        Rules.SymbolSpec spatialView = domainSymbolOrNull(
            "com.pico.spatial.ui.foundation.content.SpatialView",
            "SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit");
        Rules.SymbolSpec contentType = typeSymbolExact(
            "com.pico.spatial.core.container.SpatialViewContent", "class SpatialViewContent");
        Rules.SymbolSpec entityConstructor = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity", "Entity()");
        Rules.SymbolSpec entityType = typeSymbolExact(
            "com.pico.spatial.core.ecs.Entity", "open class Entity");
        Rules.SymbolSpec components = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.components", "components: ComponentSet");
        Rules.SymbolSpec set = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.ComponentSet.set", "set(component: T): Unit");
        Rules.SymbolSpec transform = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.TransformComponent",
            "TransformComponent(position: Vector3, rotation: Quat, scale: Vector3)");
        Rules.SymbolSpec addEntity = domainSymbolOrNull(
            "com.pico.spatial.core.container.SpatialViewEntityManager.addEntity",
            "addEntity(entity: Entity): Unit");
        if (stage == null || spatialView == null || contentType == null
                || entityConstructor == null || entityType == null || components == null
                || set == null || transform == null || addEntity == null
                || !callbackShape(stage, 5, "stage_content", "spatial_container_scope")
                || !cp2seHasCallback(spatialView, 3, "spatial_initial", null, 2)) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node stageCall : program.nodes()) {
            if (stageCall.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(stageCall.fileId())) continue;
            Map<Integer, List<PsiIndex.Node>> stageMap =
                reviewedDomainMapping(stageCall, stage, facts);
            PsiIndex.Node stageLambda = mappedLambda(stageMap, 5);
            PsiIndex.Node stageContentCall = uniqueDirectSourceCall(stageLambda, facts);
            PsiIndex.Node stageContent = stageContentCall == null
                ? null : exactSourceTarget(stageContentCall, facts);
            if (stageLambda == null || stageContent == null
                    || stageContent.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || callbackResult(stageLambda) != stageContentCall) continue;

            PsiIndex.Node viewCall = cp2seUniqueDomainCallInCallable(
                stageContent, spatialView, facts, true);
            Map<Integer, List<PsiIndex.Node>> viewMap = viewCall == null
                ? null : mapDomainArguments(viewCall, spatialView, facts);
            PsiIndex.Node initialArgument = mappedArgument(viewMap, 3);
            PsiIndex.Node initialLambda = mappedLambda(viewMap, 3);
            List<PsiIndex.Node> initialParameters = initialLambda == null
                ? List.of() : targets(initialLambda, PsiIndex.EdgeRole.PARAMETER);
            PsiIndex.Node content = initialParameters.size() == 2
                ? initialParameters.get(0) : null;
            if (initialArgument == null || initialLambda == null || content == null
                    || !exactFact(facts, "callback_binding", initialLambda, viewCall,
                        initialArgument, "spatial_initial", spatialView)
                    || !exactFact(facts, "callback_parameter", content, initialLambda, null,
                        "spatial_content", contentType)) continue;

            PsiIndex.Node addCall = cp2seUniqueDomainCallInCallable(
                initialLambda, addEntity, facts, true);
            Map<Integer, List<PsiIndex.Node>> addMap = addCall == null
                ? null : mapDomainArguments(addCall, addEntity, facts);
            PsiIndex.Node attachedArgument = mappedArgument(addMap, 0);
            PsiIndex.Node attachedValue = attachedArgument == null
                ? null : one(attachedArgument, PsiIndex.EdgeRole.VALUE);
            PsiIndex.Node root = cp2seDeclarationForUse(attachedValue, facts);
            PsiIndex.Node addReceiver = addCall == null ? null : resolvedReceiver(addCall);
            PsiIndex.Node receiverDeclaration = cp2seDeclarationForUse(addReceiver, facts);
            if (root == null || root.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                    || !root.flags().contains(PsiIndex.NodeFlag.VAL)
                    || root.flags().contains(PsiIndex.NodeFlag.VAR)
                    || enclosingCallable(root) != initialLambda
                    || receiverDeclaration != content
                    || !cp2seExactDeclaredEffect(addCall, addEntity, "place", facts)) continue;

            List<PsiIndex.Node> setup = cp2seEntitySetup(root, initialLambda, entityConstructor,
                entityType, components, set, transform, facts);
            if (setup == null) continue;
            String alternative = setup.size() == 4
                ? "direct-initial-entity" : "unique-helper-initial-entity";
            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(stageCall, witnesses)
                && addWitness(stageContentCall, witnesses)
                && addWitness(viewCall, witnesses)
                && addWitness(initialArgument, witnesses)
                && addWitness(initialLambda, witnesses)
                && addWitness(content, witnesses)
                && addWitness(root, witnesses)
                && addWitness(setup.get(1), witnesses)
                && addWitness(setup.get(2), witnesses)
                && addWitness(setup.get(3), witnesses)
                && addWitness(addCall, witnesses)
                && addWitness(attachedArgument, witnesses);
            if (setup.size() == 6) {
                valid &= addWitness(setup.get(4), witnesses)
                    && addWitness(setup.get(5), witnesses);
            }
            if (!valid) continue;
            Rules.Analysis candidate = cp2seClaim("spatial.entity-content",
                "spatial-view-entity-attachment", alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("spatial.entity-content", matchAlternative);
        return match;
    }
    private Rules.Analysis analyzeSystemQuery() {
        Rules.SymbolSpec systemType = typeSymbolExact(
            "com.pico.spatial.core.ecs.System", "abstract class System");
        Rules.SymbolSpec update = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.System.update",
            "update(context: SceneUpdateContext): Unit");
        Rules.SymbolSpec contextType = typeSymbolExact(
            "com.pico.spatial.core.ecs.SceneUpdateContext", "class SceneUpdateContext");
        Rules.SymbolSpec sceneType = typeSymbolExact(
            "com.pico.spatial.core.ecs.Scene", "class Scene");
        Rules.SymbolSpec sceneProperty = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.SceneUpdateContext.scene", "scene: Scene");
        Rules.SymbolSpec conditionType = typeSymbolExact(
            "com.pico.spatial.core.ecs.EntityQueryCondition", "class EntityQueryCondition");
        Rules.SymbolSpec hasComponent = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.EntityQueryCondition.hasComponent",
            "hasComponent(componentClass: Class<T>): EntityQueryCondition");
        Rules.SymbolSpec queryEntity = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Scene.queryEntity",
            "queryEntity(vararg conditions: EntityQueryCondition): List<Entity>");
        Rules.SymbolSpec forEach = domainSymbolOrNull(
            "kotlin.collections.forEach", "Iterable<T>.forEach(action: (T) -> Unit): Unit");
        if (systemType == null || update == null || contextType == null || sceneType == null
                || sceneProperty == null || conditionType == null || hasComponent == null
                || queryEntity == null || forEach == null
                || !cp2seHasCallback(forEach, 0, "collection_element", null, 1)) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node system : program.nodes()) {
            if (system.kind() != PsiIndex.NodeKind.CLASS_DECL
                    || !isProductionPath(system.fileId())
                    || !exactFact(facts, "type", system, null, null,
                        "ecs_system", systemType)) continue;
            PsiIndex.Node systemSuper = cp2seExactSuperReference(system, systemType, facts);
            PsiIndex.Node updateMethod = cp2seUniqueProductionRoot(system, update, facts);
            List<PsiIndex.Node> updateParameters = updateMethod == null
                ? List.of() : targets(updateMethod, PsiIndex.EdgeRole.PARAMETER);
            PsiIndex.Node context = updateParameters.size() == 1
                ? updateParameters.get(0) : null;
            if (systemSuper == null || updateMethod == null || context == null
                    || !exactFact(facts, "type", context, updateMethod, null,
                        "scene_update_context", contextType)) continue;

            List<PsiIndex.Node> queryDefinition = cp2seQueryDefinition(
                system, hasComponent, conditionType, facts);
            if (queryDefinition == null) continue;
            PsiIndex.Node queryProperty = queryDefinition.get(0);
            List<PsiIndex.Node> queryPath = cp2seConsumedQueryPath(updateMethod, context,
                queryProperty, sceneType, sceneProperty, conditionType, queryEntity, forEach, facts);
            if (queryPath == null) continue;
            String alternative = queryPath.size() == 2
                ? "direct-query-use" : "pure-helper-query-use";
            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(system, witnesses)
                && addWitness(systemSuper, witnesses)
                && addWitness(queryProperty, witnesses)
                && addWitness(queryDefinition.get(1), witnesses)
                && addWitness(queryDefinition.get(2), witnesses)
                && addWitness(updateMethod, witnesses)
                && addWitness(queryPath.get(0), witnesses)
                && addWitness(queryPath.get(1), witnesses);
            if (queryPath.size() == 5) {
                valid &= addWitness(queryPath.get(2), witnesses)
                    && addWitness(queryPath.get(3), witnesses)
                    && addWitness(queryPath.get(4), witnesses);
            }
            if (!valid) continue;
            Rules.Analysis candidate = cp2seClaim("ecs.system-query",
                "hoisted-query-scene-update", alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("ecs.system-query", matchAlternative);
        return match;
    }
    private Rules.Analysis analyzeFrameUpdate() {
        Rules.SymbolSpec systemType = typeSymbolExact(
            "com.pico.spatial.core.ecs.System", "abstract class System");
        Rules.SymbolSpec update = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.System.update",
            "update(context: SceneUpdateContext): Unit");
        Rules.SymbolSpec contextType = typeSymbolExact(
            "com.pico.spatial.core.ecs.SceneUpdateContext", "class SceneUpdateContext");
        Rules.SymbolSpec sceneType = typeSymbolExact(
            "com.pico.spatial.core.ecs.Scene", "class Scene");
        Rules.SymbolSpec sceneProperty = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.SceneUpdateContext.scene", "scene: Scene");
        Rules.SymbolSpec delta = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.SceneUpdateContext.deltaTime", "deltaTime: Float");
        Rules.SymbolSpec queryEntity = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Scene.queryEntity",
            "queryEntity(vararg conditions: EntityQueryCondition): List<Entity>");
        Rules.SymbolSpec forEach = domainSymbolOrNull(
            "kotlin.collections.forEach", "Iterable<T>.forEach(action: (T) -> Unit): Unit");
        Rules.SymbolSpec entityType = typeSymbolExact(
            "com.pico.spatial.core.ecs.Entity", "open class Entity");
        Rules.SymbolSpec components = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.components", "components: ComponentSet");
        Rules.SymbolSpec componentGet = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.ComponentSet.get",
            "get(componentType: Class<T>): T?");
        Rules.SymbolSpec transformType = typeSymbolExact(
            "com.pico.spatial.core.ecs.TransformComponent", "class TransformComponent");
        Rules.SymbolSpec position = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.TransformComponent.position", "position: Vector3");
        Rules.SymbolSpec vectorType = typeSymbolExact(
            "com.pico.spatial.core.math.Vector3", "class Vector3");
        Rules.SymbolSpec vector = domainSymbolOrNull(
            "com.pico.spatial.core.math.Vector3",
            "Vector3(x: Float = 0f, y: Float = 0f, z: Float = 0f)");
        if (systemType == null || update == null || contextType == null || sceneType == null
                || sceneProperty == null || delta == null || queryEntity == null || forEach == null
                || entityType == null || components == null || componentGet == null
                || transformType == null || position == null || vectorType == null || vector == null
                || !cp2seHasCallback(forEach, 0, "collection_element", null, 1)) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node system : program.nodes()) {
            if (system.kind() != PsiIndex.NodeKind.CLASS_DECL
                    || !isProductionPath(system.fileId())
                    || !exactFact(facts, "type", system, null, null,
                        "ecs_system", systemType)) continue;
            PsiIndex.Node updateMethod = cp2seUniqueProductionRoot(system, update, facts);
            List<PsiIndex.Node> parameters = updateMethod == null
                ? List.of() : targets(updateMethod, PsiIndex.EdgeRole.PARAMETER);
            PsiIndex.Node context = parameters.size() == 1 ? parameters.get(0) : null;
            if (context == null || !exactFact(facts, "type", context, updateMethod, null,
                    "scene_update_context", contextType)) continue;
            List<PsiIndex.Node> frame = cp2seFramePath(updateMethod, context, sceneType,
                sceneProperty, delta, queryEntity, forEach, entityType, components,
                componentGet, transformType, position, vectorType, vector, facts);
            if (frame == null) continue;
            PsiIndex.Node assignment = frame.get(6);
            String proofForm = "=".equals(assignment.value())
                ? "assign-delta-update" : "plus-assign-delta-update";
            String alternative = frame.size() == 11
                ? "pure-helper-transform" : "direct-transform";
            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(updateMethod, witnesses)
                && addWitness(frame.get(0), witnesses)
                && addWitness(frame.get(1), witnesses)
                && addWitness(frame.get(2), witnesses)
                && addWitness(frame.get(3), witnesses)
                && addWitness(frame.get(4), witnesses)
                && addWitness(frame.get(7), witnesses)
                && addWitness(frame.get(8), witnesses)
                && addWitness(assignment, witnesses);
            if (frame.size() == 11) {
                valid &= addWitness(frame.get(9), witnesses)
                    && addWitness(frame.get(10), witnesses);
            }
            if (!valid) continue;
            Rules.Analysis candidate = cp2seClaim(
                "ecs.frame-update", proofForm, alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("ecs.frame-update", matchAlternative);
        return match;
    }
    private Rules.Analysis analyzeEcsLifecycle() {
        Rules.SymbolSpec stage = domainSymbolOrNull(
            "com.pico.spatial.ui.foundation.dsl.Stage", STAGE_SIGNATURE);
        Rules.SymbolSpec effect = domainSymbolOrNull(
            "androidx.compose.runtime.DisposableEffect",
            "DisposableEffect(key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit");
        Rules.SymbolSpec disposableScope = typeSymbolExact(
            "androidx.compose.runtime.DisposableEffectScope", "class DisposableEffectScope");
        Rules.SymbolSpec dispose = domainSymbolOrNull(
            "androidx.compose.runtime.DisposableEffectScope.onDispose",
            "onDispose(onDisposeEffect: () -> Unit): DisposableEffectResult");
        Rules.SymbolSpec register = domainSymbolOrNull(
            "com.pico.spatial.ui.foundation.dsl.registerSystem",
            "registerSystem<T : System>(): Unit");
        Rules.SymbolSpec unregister = domainSymbolOrNull(
            "com.pico.spatial.ui.foundation.dsl.unregisterSystem",
            "unregisterSystem<T : System>(): Unit");
        Rules.SymbolSpec systemType = typeSymbolExact(
            "com.pico.spatial.core.ecs.System", "abstract class System");
        if (stage == null || effect == null || disposableScope == null || dispose == null
                || register == null || unregister == null || systemType == null
                || !callbackShape(stage, 5, "stage_content", "spatial_container_scope")
                || !callbackShape(effect, 1, "disposable_effect", "disposable_effect_scope")
                || !callbackShape(dispose, 0, "dispose_cleanup", null)) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        for (PsiIndex.Node stageCall : program.nodes()) {
            if (stageCall.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(stageCall.fileId())) continue;
            Map<Integer, List<PsiIndex.Node>> stageMap =
                reviewedDomainMapping(stageCall, stage, facts);
            PsiIndex.Node stageLambda = mappedLambda(stageMap, 5);
            PsiIndex.Node stageContentCall = uniqueDirectSourceCall(stageLambda, facts);
            PsiIndex.Node stageContent = stageContentCall == null
                ? null : exactSourceTarget(stageContentCall, facts);
            if (stageContent == null || callbackResult(stageLambda) != stageContentCall) continue;
            PsiIndex.Node effectCall = cp2seUniqueDomainCallInCallable(
                stageContent, effect, facts, true);
            Map<Integer, List<PsiIndex.Node>> effectMap = effectCall == null
                ? null : mapDomainArguments(effectCall, effect, facts);
            PsiIndex.Node effectArgument = mappedArgument(effectMap, 1);
            PsiIndex.Node effectLambda = mappedLambda(effectMap, 1);
            if (effectLambda == null || !exactFact(facts, "callback_binding", effectLambda,
                    effectCall, effectArgument, "disposable_effect", effect)
                    || !exactFact(facts, "callback_receiver", effectLambda, effectCall, null,
                        "disposable_effect_scope", disposableScope)) continue;

            List<PsiIndex.Node> effectCalls = directCalls(effectLambda);
            PsiIndex.Node registerCall = cp2seUniqueResolvedCall(effectCalls, register, facts);
            PsiIndex.Node disposeCall = callbackResult(effectLambda);
            if (effectCalls == null || registerCall == null || disposeCall == null
                    || effectCalls.get(effectCalls.size() - 1) != disposeCall
                    || !exactDomainResolution(disposeCall, dispose, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> disposeMap =
                mapDomainArguments(disposeCall, dispose, facts);
            PsiIndex.Node cleanupArgument = mappedArgument(disposeMap, 0);
            PsiIndex.Node cleanupLambda = mappedLambda(disposeMap, 0);
            List<PsiIndex.Node> cleanupCalls = directCleanupCalls(cleanupLambda);
            PsiIndex.Node unregisterCall =
                cp2seUniqueResolvedCall(cleanupCalls, unregister, facts);
            if (cleanupLambda == null || unregisterCall == null
                    || !exactFact(facts, "callback_binding", cleanupLambda, disposeCall,
                        cleanupArgument, "dispose_cleanup", dispose)) continue;

            List<PsiIndex.Node> registerTypes =
                targets(registerCall, PsiIndex.EdgeRole.TYPE_ARGUMENT);
            List<PsiIndex.Node> unregisterTypes =
                targets(unregisterCall, PsiIndex.EdgeRole.TYPE_ARGUMENT);
            PsiIndex.Node registeredSystem = registerTypes.size() == 1
                ? sourceTypeDeclaration(registerTypes.get(0)) : null;
            PsiIndex.Node unregisteredSystem = unregisterTypes.size() == 1
                ? sourceTypeDeclaration(unregisterTypes.get(0)) : null;
            PsiIndex.Node systemSuper = registeredSystem == null
                ? null : cp2seExactSuperReference(registeredSystem, systemType, facts);
            if (registeredSystem == null || registeredSystem != unregisteredSystem
                    || !isProductionPath(registeredSystem.fileId()) || systemSuper == null
                    || !exactFact(facts, "type", registeredSystem, null, null,
                        "ecs_system", systemType)
                    || !cp2seExactDeclaredEffect(
                        registerCall, register, "acquire", facts)
                    || !cp2seExactDeclaredEffect(
                        unregisterCall, unregister, "release", facts)) continue;

            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(stageCall, witnesses)
                && addWitness(effectCall, witnesses)
                && addWitness(effectLambda, witnesses)
                && addWitness(registerCall, witnesses)
                && addWitness(registerTypes.get(0), witnesses)
                && addWitness(cleanupLambda, witnesses)
                && addWitness(unregisterCall, witnesses)
                && addWitness(unregisterTypes.get(0), witnesses)
                && addWitness(disposeCall, witnesses);
            if (!valid) continue;
            Rules.Analysis candidate = cp2seClaim("ecs.lifecycle",
                "paired-system-lifecycle", "direct-register-unregister", witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("ecs.lifecycle", "direct-register-unregister");
        return match;
    }

    private Rules.Analysis cp2seClaim(String ruleId, String proofForm,
            String alternative, List<String> witnesses) {
        Rules.RuleSpec rule = domain.rule(ruleId);
        Map<String, Boolean> complete = new HashMap<>();
        Map<String, List<String>> alternatives = new HashMap<>();
        for (String candidate : rule.proofForms()) {
            boolean selected = candidate.equals(proofForm);
            complete.put(candidate, selected);
            alternatives.put(candidate, selected ? List.of(alternative) : List.of());
        }
        Map<String, String> selected = Rules.selectProof(
            domain, ruleId, complete, alternatives);
        if (!proofForm.equals(selected.get("proofForm"))
                || !alternative.equals(selected.get("alternativeId"))) return null;
        return Rules.claimOrNull(program, domain, ruleId, proofForm, alternative, witnesses);
    }

    private boolean cp2seExactDeclaredEffect(PsiIndex.Node call, Rules.SymbolSpec symbol,
            String effect, List<Map<String, Object>> facts) {
        return call != null && exactDomainResolution(call, symbol, facts)
            && !hasAnyTaint(call, facts) && symbol.effects().contains(effect);
    }

    private PsiIndex.Node cp2seExactSuperReference(PsiIndex.Node declaration,
            Rules.SymbolSpec type, List<Map<String, Object>> facts) {
        List<PsiIndex.Node> supers = targets(declaration, PsiIndex.EdgeRole.SUPER_TYPE);
        if (supers.size() != 1 || typeSymbolForReference(supers.get(0)) != type) return null;
        return exactFact(facts, "type", supers.get(0), enclosingCallable(supers.get(0)), null,
            type.returnAbstractType(), type) ? supers.get(0) : null;
    }

    private PsiIndex.Node cp2seUniqueProductionRoot(PsiIndex.Node owner,
            Rules.SymbolSpec slot, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node child : lexicalChildren(owner)) {
            if (child.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !exactFact(facts, "production_root", child, owner, null,
                        "direct", slot)) continue;
            if (match != null) return null;
            match = child;
        }
        return match;
    }

    private PsiIndex.ImportEntry cp2seExactImport(PsiIndex.Node call, String fqn) {
        if (call == null || call.name() == null) return null;
        PsiIndex.ImportEntry match = null;
        for (int importId : program.file(call.fileId()).importIds()) {
            PsiIndex.ImportEntry candidate = program.imports().get(importId);
            if (!candidate.fqName().equals(fqn)
                    || !candidate.exposedName().equals(call.name())) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private PsiIndex.Node cp2seReferencedRoot(PsiIndex.Node reference,
            Rules.SymbolSpec spatialScope, List<Map<String, Object>> facts) {
        if (reference == null || reference.kind() != PsiIndex.NodeKind.CALLABLE_REF) return null;
        PsiIndex.Node target = uniqueReferencedCallable(reference);
        if (target == null) target = importedCallable(reference, spatialScope, facts);
        if (target == null || target.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                || !isProductionPath(target.fileId()) || !isTopLevel(target)) return null;
        List<PsiIndex.Node> parameters = targets(target, PsiIndex.EdgeRole.PARAMETER);
        return parameters.size() == 1 && exactFact(facts, "type", parameters.get(0), target,
            null, "spatial_app_scope", spatialScope) ? target : null;
    }

    private Map<Integer, List<PsiIndex.Node>> cp2seReviewedLaunchMapping(PsiIndex.Node call,
            Rules.SymbolSpec launch, Rules.SymbolSpec spatialScope,
            List<Map<String, Object>> facts) {
        Map<Integer, List<PsiIndex.Node>> strict = reviewedDomainMapping(call, launch, facts);
        if (strict != null) return strict;
        List<Rules.SymbolSpec> candidates = domainCandidates(call, facts);
        List<PsiIndex.Node> arguments = uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT);
        if (candidates.size() != 1 || candidates.get(0) != launch
                || !receiverMatches(call, launch, facts)
                || hasFact(facts, "call_resolution", call.id())
                || !hasExactTaint(call, "unsupported", facts)
                || cp2seExactImport(call, launch.fqn()) == null
                || !callbackShape(launch, 0, "application_entry", "spatial_app_scope")
                || !targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT).isEmpty()
                || arguments.size() != 1) return null;
        PsiIndex.Node argument = arguments.get(0);
        PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
        if (argument.flags().contains(PsiIndex.NodeFlag.NAMED)
                || value == null || value.kind() != PsiIndex.NodeKind.CALLABLE_REF
                || !hasFact(facts, "reachable", call.id())
                || !hasFact(facts, "reachable", value.id())
                || cp2seReferencedRoot(value, spatialScope, facts) == null) return null;
        return Map.of(0, List.of(argument));
    }

    private boolean cp2seHasCallback(Rules.SymbolSpec symbol, int position,
            String role, String receiverType, int parameterCount) {
        int matches = 0;
        for (Rules.CallbackSpec callback : symbol.callbacks()) {
            if (callback.argumentPosition() != position || !callback.role().equals(role)) continue;
            boolean receiverMatches = receiverType == null
                ? callback.receiverAbstractType() == null
                : receiverType.equals(callback.receiverAbstractType());
            if (receiverMatches && callback.parameters().size() == parameterCount) matches++;
        }
        return matches == 1;
    }

    private PsiIndex.Node cp2seUniqueDomainCallInCallable(PsiIndex.Node callable,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts, boolean direct) {
        if (callable == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || enclosingCallable(call) != callable
                    || direct && !isDirectStatement(call, callable)
                    || !exactDomainResolution(call, symbol, facts)) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node cp2seUniqueResolvedCall(List<PsiIndex.Node> calls,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        if (calls == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : calls) {
            if (!exactDomainResolution(call, symbol, facts)) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node cp2seDeclarationForUse(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null || value.kind() != PsiIndex.NodeKind.NAME_REF
                || value.name() == null || hasAnyTaint(value, facts)) return null;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
        if (declaration == null) declaration = findLexicalDeclaration(value, value.name());
        return declaration;
    }

    private List<PsiIndex.Node> cp2seEntitySetup(PsiIndex.Node root,
            PsiIndex.Node initialLambda, Rules.SymbolSpec entityConstructor,
            Rules.SymbolSpec entityType, Rules.SymbolSpec components, Rules.SymbolSpec set,
            Rules.SymbolSpec transform, List<Map<String, Object>> facts) {
        PsiIndex.Node initializer = one(root, PsiIndex.EdgeRole.INITIALIZER);
        PsiIndex.Node initializerCall = directCall(initializer);
        PsiIndex.Node owner = initialLambda;
        PsiIndex.Node entity = root;
        PsiIndex.Node entityCall = null;
        PsiIndex.Node helper = null;
        PsiIndex.Node helperCall = null;
        if (initializerCall != null
                && exactDomainResolution(initializerCall, entityConstructor, facts)) {
            entityCall = initializerCall;
        } else {
            helperCall = initializerCall;
            helper = helperCall == null ? null : exactSourceTarget(helperCall, facts);
            if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isProductionPath(helper.fileId()) || !isTopLevel(helper)
                    || !targets(helper, PsiIndex.EdgeRole.PARAMETER).isEmpty()
                    || hasAnyTaint(helperCall, facts)
                    || cp2seSourceCallCount(helper, facts) != 1) return null;
            PsiIndex.Node declaredType = one(helper, PsiIndex.EdgeRole.TYPE);
            PsiIndex.Node returned = sourceReturnOrigin(helper);
            entity = cp2seDeclarationForUse(returned, facts);
            if (declaredType == null || typeSymbolForReference(declaredType) != entityType
                    || entity == null || entity.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                    || enclosingCallable(entity) != helper
                    || !entity.flags().contains(PsiIndex.NodeFlag.VAL)
                    || entity.flags().contains(PsiIndex.NodeFlag.VAR)
                    || callbackHasUnknownCall(helper, facts)) return null;
            entityCall = directCall(one(entity, PsiIndex.EdgeRole.INITIALIZER));
            owner = helper;
        }
        if (entityCall == null || !exactDomainResolution(entityCall, entityConstructor, facts)
                || !exactFact(facts, "type", entityCall, owner, null,
                    "entity", entityType)) return null;

        PsiIndex.Node setCall = null;
        PsiIndex.Node transformCall = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || enclosingCallable(call) != owner
                    || !isDirectStatement(call, owner)
                    || !exactDomainResolution(call, set, facts)) continue;
            PsiIndex.Node componentStore = resolvedReceiver(call);
            if (propertySymbolForTarget(componentStore, facts) != components) continue;
            PsiIndex.Node entityReceiver = propertyReceiverForTarget(componentStore);
            if (cp2seDeclarationForUse(entityReceiver, facts) != entity) continue;
            Map<Integer, List<PsiIndex.Node>> setMap = mapDomainArguments(call, set, facts);
            PsiIndex.Node componentArgument = mappedArgument(setMap, 0);
            PsiIndex.Node componentValue = componentArgument == null
                ? null : one(componentArgument, PsiIndex.EdgeRole.VALUE);
            PsiIndex.Node candidateTransform = directCall(componentValue);
            if (candidateTransform == null
                    || !exactDomainResolution(candidateTransform, transform, facts)
                    || !cp2seExactDeclaredEffect(call, set, "replace", facts)) continue;
            if (setCall != null) return null;
            setCall = call;
            transformCall = candidateTransform;
        }
        if (setCall == null) return null;
        List<PsiIndex.Node> result = new ArrayList<>();
        result.add(entity);
        result.add(entityCall);
        result.add(setCall);
        result.add(transformCall);
        if (helper != null) {
            result.add(helper);
            result.add(helperCall);
        }
        return List.copyOf(result);
    }

    private int cp2seSourceCallCount(PsiIndex.Node target,
            List<Map<String, Object>> facts) {
        int count = 0;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() == PsiIndex.NodeKind.CALL
                    && exactSourceTarget(call, facts) == target) count++;
        }
        return count;
    }

    private List<PsiIndex.Node> cp2seQueryDefinition(PsiIndex.Node system,
            Rules.SymbolSpec hasComponent, Rules.SymbolSpec conditionType,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> matches = new ArrayList<>();
        for (PsiIndex.Node child : lexicalChildren(system)) {
            if (child.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                    || !child.flags().contains(PsiIndex.NodeFlag.VAL)
                    || child.flags().contains(PsiIndex.NodeFlag.VAR)) continue;
            PsiIndex.Node call = directCall(one(child, PsiIndex.EdgeRole.INITIALIZER));
            Map<Integer, List<PsiIndex.Node>> mapping = call == null
                || !exactDomainResolution(call, hasComponent, facts)
                ? null : mapDomainArguments(call, hasComponent, facts);
            PsiIndex.Node argument = mappedArgument(mapping, 0);
            PsiIndex.Node classToken = argument == null
                ? null : one(argument, PsiIndex.EdgeRole.VALUE);
            PsiIndex.Node classLiteral = classToken == null
                ? null : one(classToken, PsiIndex.EdgeRole.RECEIVER);
            Rules.SymbolSpec component = classTokenTargetType(classToken, facts);
            if (classToken == null || classLiteral == null
                    || classLiteral.kind() != PsiIndex.NodeKind.CLASS_LITERAL || component == null
                    || conformancePathCountFromPhysical(
                        component, "component", 0, new HashMap<>()) != 1
                    || !exactFact(facts, "type", child, enclosingCallable(child), null,
                        "entity_query_condition", conditionType)) continue;
            matches.add(child);
            matches.add(call);
            matches.add(classLiteral);
        }
        return matches.size() == 3 ? List.copyOf(matches) : null;
    }

    private List<PsiIndex.Node> cp2seConsumedQueryPath(PsiIndex.Node update,
            PsiIndex.Node context, PsiIndex.Node queryProperty, Rules.SymbolSpec sceneType,
            Rules.SymbolSpec sceneProperty, Rules.SymbolSpec conditionType,
            Rules.SymbolSpec queryEntity, Rules.SymbolSpec forEach,
            List<Map<String, Object>> facts) {
        List<List<PsiIndex.Node>> matches = new ArrayList<>();
        for (PsiIndex.Node terminal : program.nodes()) {
            if (terminal.kind() != PsiIndex.NodeKind.CALL || enclosingCallable(terminal) != update
                    || !isDirectStatement(terminal, update)) continue;
            PsiIndex.Node producerCall = directCall(resolvedReceiver(terminal));
            Map<Integer, List<PsiIndex.Node>> iterationMap =
                mapDomainArguments(terminal, forEach, facts);
            PsiIndex.Node actionArgument = mappedArgument(iterationMap, 0);
            PsiIndex.Node action = mappedLambda(iterationMap, 0);
            List<PsiIndex.Node> candidate;
            if (producerCall != null
                    && exactDomainResolution(producerCall, queryEntity, facts)) {
                if (action == null || !exactDomainResolution(terminal, forEach, facts)
                        || !exactFact(facts, "callback_binding", action, terminal,
                            actionArgument, "collection_element", forEach)) continue;
                PsiIndex.Node queryArgument = cp2seExactQueryArgument(
                    producerCall, queryProperty, queryEntity, facts);
                if (queryArgument == null || !cp2seExactSceneReceiver(
                        resolvedReceiver(producerCall), context, sceneType,
                        sceneProperty, facts)) continue;
                candidate = List.of(producerCall, queryArgument);
            } else {
                candidate = cp2seHelperQueryPath(producerCall, context, queryProperty,
                    sceneType, sceneProperty, conditionType, queryEntity, facts);
                if (candidate == null || !cp2seReviewedForEachAfterHelper(
                        terminal, producerCall, actionArgument, action, forEach, facts)) continue;
            }
            matches.add(candidate);
        }
        return matches.size() == 1 ? matches.get(0) : null;
    }

    private boolean cp2seReviewedForEachAfterHelper(PsiIndex.Node terminal,
            PsiIndex.Node helperCall, PsiIndex.Node actionArgument, PsiIndex.Node action,
            Rules.SymbolSpec forEach, List<Map<String, Object>> facts) {
        if (helperCall == null || actionArgument == null || action == null
                || action.kind() != PsiIndex.NodeKind.LAMBDA
                || directCall(resolvedReceiver(terminal)) != helperCall
                || hasFact(facts, "call_resolution", terminal.id())
                || !hasExactTaint(terminal, "unknown_receiver", facts)
                || callbackHasUnknownCall(action, facts)) return false;
        List<Rules.SymbolSpec> candidates = domainCandidates(terminal, facts);
        if (candidates.size() != 1 || candidates.get(0) != forEach
                || mapDomainArguments(terminal, forEach, facts) == null) return false;
        List<PsiIndex.Node> parameters = targets(action, PsiIndex.EdgeRole.PARAMETER);
        return parameters.size() == 1;
    }

    private PsiIndex.Node cp2seExactQueryArgument(PsiIndex.Node queryCall,
            PsiIndex.Node expectedDeclaration, Rules.SymbolSpec queryEntity,
            List<Map<String, Object>> facts) {
        Map<Integer, List<PsiIndex.Node>> mapping =
            mapDomainArguments(queryCall, queryEntity, facts);
        PsiIndex.Node argument = mappedArgument(mapping, 0);
        PsiIndex.Node value = argument == null ? null : one(argument, PsiIndex.EdgeRole.VALUE);
        return cp2seDeclarationForUse(value, facts) == expectedDeclaration ? argument : null;
    }

    private boolean cp2seExactSceneReceiver(PsiIndex.Node value, PsiIndex.Node context,
            Rules.SymbolSpec sceneType, Rules.SymbolSpec sceneProperty,
            List<Map<String, Object>> facts) {
        if (value == null || propertySymbolForTarget(value, facts) != sceneProperty
                || !exactFact(facts, "type", value, enclosingCallable(value), null,
                    "scene", sceneType)) return false;
        return cp2seDeclarationForUse(propertyReceiverForTarget(value), facts) == context;
    }

    private List<PsiIndex.Node> cp2seHelperQueryPath(PsiIndex.Node helperCall,
            PsiIndex.Node context, PsiIndex.Node queryProperty, Rules.SymbolSpec sceneType,
            Rules.SymbolSpec sceneProperty, Rules.SymbolSpec conditionType,
            Rules.SymbolSpec queryEntity, List<Map<String, Object>> facts) {
        PsiIndex.Node helper = cp2seReviewedSceneExtensionTarget(
            helperCall, sceneType, facts);
        if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                || !isTopLevel(helper) || !isProductionPath(helper.fileId())
                || cp2seReviewedSceneExtensionCallCount(helper, sceneType, facts) != 1
                || callbackHasUnknownCall(helper, facts)) return null;
        PsiIndex.Node extensionType = declarationTypeNode(helper, true);
        List<PsiIndex.Node> parameters = targets(helper, PsiIndex.EdgeRole.PARAMETER);
        if (extensionType == null || typeSymbolForReference(extensionType) != sceneType
                || parameters.size() != 1
                || !exactFact(facts, "type", parameters.get(0), helper, null,
                    "entity_query_condition", conditionType)
                || !cp2seExactSceneReceiver(resolvedReceiver(helperCall), context,
                    sceneType, sceneProperty, facts)) return null;
        Map<Integer, List<PsiIndex.Node>> sourceMap = mapSourceArguments(helperCall, helper, facts);
        PsiIndex.Node helperArgument = mappedArgument(sourceMap, 0);
        PsiIndex.Node helperValue = helperArgument == null
            ? null : one(helperArgument, PsiIndex.EdgeRole.VALUE);
        if (cp2seDeclarationForUse(helperValue, facts) != queryProperty) return null;
        PsiIndex.Node queryCall = directCall(sourceReturnOrigin(helper));
        if (queryCall == null || !exactDomainResolution(queryCall, queryEntity, facts)) return null;
        PsiIndex.Node queryArgument = cp2seExactQueryArgument(
            queryCall, parameters.get(0), queryEntity, facts);
        return queryArgument == null ? null
            : List.of(queryCall, queryArgument, helper, helperCall, helperArgument);
    }

    private PsiIndex.Node cp2seReviewedSceneExtensionTarget(PsiIndex.Node call,
            Rules.SymbolSpec sceneType, List<Map<String, Object>> facts) {
        if (call == null || call.kind() != PsiIndex.NodeKind.CALL || call.name() == null) return null;
        PsiIndex.Node resolved = exactSourceTarget(call, facts);
        if (resolved != null) return resolved;
        if (hasFact(facts, "call_resolution", call.id())
                || !hasExactTaint(call, "unknown_receiver", facts)) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : sourceCallableCandidates(call, facts)) {
            PsiIndex.Node extensionType = declarationTypeNode(candidate, true);
            if (candidate.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || extensionType == null || typeSymbolForReference(extensionType) != sceneType
                    || mapSourceArguments(call, candidate, facts) == null) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private int cp2seReviewedSceneExtensionCallCount(PsiIndex.Node helper,
            Rules.SymbolSpec sceneType, List<Map<String, Object>> facts) {
        int count = 0;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() == PsiIndex.NodeKind.CALL
                    && cp2seReviewedSceneExtensionTarget(call, sceneType, facts) == helper) count++;
        }
        return count;
    }

    private List<PsiIndex.Node> cp2seFramePath(PsiIndex.Node update,
            PsiIndex.Node context, Rules.SymbolSpec sceneType, Rules.SymbolSpec sceneProperty,
            Rules.SymbolSpec delta, Rules.SymbolSpec queryEntity, Rules.SymbolSpec forEach,
            Rules.SymbolSpec entityType, Rules.SymbolSpec components,
            Rules.SymbolSpec componentGet, Rules.SymbolSpec transformType,
            Rules.SymbolSpec position, Rules.SymbolSpec vectorType, Rules.SymbolSpec vector,
            List<Map<String, Object>> facts) {
        List<List<PsiIndex.Node>> matches = new ArrayList<>();
        for (PsiIndex.Node terminal : program.nodes()) {
            if (terminal.kind() != PsiIndex.NodeKind.CALL || enclosingCallable(terminal) != update
                    || !isDirectStatement(terminal, update)
                    || !exactDomainResolution(terminal, forEach, facts)) continue;
            PsiIndex.Node queryCall = directCall(resolvedReceiver(terminal));
            Map<Integer, List<PsiIndex.Node>> queryMap = queryCall == null
                || !exactDomainResolution(queryCall, queryEntity, facts)
                ? null : mapDomainArguments(queryCall, queryEntity, facts);
            if (queryMap == null || queryMap.getOrDefault(0, List.of()).isEmpty()
                    || !cp2seExactSceneReceiver(resolvedReceiver(queryCall), context,
                        sceneType, sceneProperty, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> loopMap =
                mapDomainArguments(terminal, forEach, facts);
            PsiIndex.Node actionArgument = mappedArgument(loopMap, 0);
            PsiIndex.Node action = mappedLambda(loopMap, 0);
            List<PsiIndex.Node> actionParameters = action == null
                ? List.of() : targets(action, PsiIndex.EdgeRole.PARAMETER);
            PsiIndex.Node element = actionParameters.size() == 1
                ? actionParameters.get(0) : null;
            if (action == null || element == null
                    || !exactFact(facts, "callback_binding", action, terminal,
                        actionArgument, "collection_element", forEach)
                    || !"entity".equals(typeOf(facts, element))
                    || physicalTypeForOrigin(element, facts) != entityType) continue;
            List<PsiIndex.Node> retrieval = cp2seTransformRetrieval(action, element,
                components, componentGet, transformType, facts);
            if (retrieval == null) continue;
            PsiIndex.Node transform = retrieval.get(0);
            PsiIndex.Node assignment = cp2seTransformAssignment(
                action, transform, position, facts);
            if (assignment == null) continue;
            List<PsiIndex.Node> flow = cp2seFrameFlow(action, assignment, transform,
                context, delta, position, vectorType, vector, facts);
            if (flow == null) continue;
            List<PsiIndex.Node> candidate = new ArrayList<>();
            candidate.add(terminal);
            candidate.add(action);
            candidate.add(element);
            candidate.add(transform);
            candidate.add(retrieval.get(2));
            candidate.add(retrieval.get(1));
            candidate.add(assignment);
            candidate.addAll(flow);
            matches.add(List.copyOf(candidate));
        }
        return matches.size() == 1 ? matches.get(0) : null;
    }

    private List<PsiIndex.Node> cp2seTransformRetrieval(PsiIndex.Node action,
            PsiIndex.Node element, Rules.SymbolSpec components, Rules.SymbolSpec componentGet,
            Rules.SymbolSpec transformType, List<Map<String, Object>> facts) {
        List<PsiIndex.Node> match = null;
        PsiIndex.Node body = one(action, PsiIndex.EdgeRole.LAMBDA_BODY);
        List<PsiIndex.Node> statements = body != null && body.kind() == PsiIndex.NodeKind.BLOCK
            ? lexicalChildren(body) : body == null ? List.of() : List.of(body);
        for (PsiIndex.Node child : statements) {
            if (child.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                    || !child.flags().contains(PsiIndex.NodeFlag.VAL)
                    || child.flags().contains(PsiIndex.NodeFlag.VAR)) continue;
            PsiIndex.Node initializer = one(child, PsiIndex.EdgeRole.INITIALIZER);
            if (initializer == null || initializer.kind() != PsiIndex.NodeKind.BINARY
                    || !"?:".equals(initializer.value())) continue;
            PsiIndex.Node get = null;
            for (PsiIndex.Node node : program.nodes()) {
                if (node.kind() != PsiIndex.NodeKind.INDEX_ACCESS
                        || !isWithin(node, initializer)
                        || !exactDomainResolution(node, componentGet, facts)) continue;
                if (get != null) {
                    get = null;
                    break;
                }
                get = node;
            }
            PsiIndex.Node store = get == null ? null : one(get, PsiIndex.EdgeRole.RECEIVER);
            PsiIndex.Node entity = store == null
                || propertySymbolForTarget(store, facts) != components
                ? null : propertyReceiverForTarget(store);
            List<PsiIndex.Node> indices = get == null
                ? List.of() : targets(get, PsiIndex.EdgeRole.INDEX);
            PsiIndex.Node classToken = indices.size() == 1 ? indices.get(0) : null;
            PsiIndex.Node classLiteral = classToken == null
                ? null : one(classToken, PsiIndex.EdgeRole.RECEIVER);
            if (cp2seDeclarationForUse(entity, facts) != element
                    || classTokenTargetType(classToken, facts) != transformType
                    || classLiteral == null
                    || classLiteral.kind() != PsiIndex.NodeKind.CLASS_LITERAL
                    || !"transform_component".equals(typeOf(facts, child))
                    || physicalTypeForOrigin(child, facts) != transformType) continue;
            if (match != null) return null;
            match = List.of(child, get, classLiteral);
        }
        return match;
    }

    private PsiIndex.Node cp2seTransformAssignment(PsiIndex.Node action,
            PsiIndex.Node transform, Rules.SymbolSpec position,
            List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.ASSIGNMENT || enclosingCallable(node) != action
                    || !("=".equals(node.value()) || "+=".equals(node.value()))) continue;
            PsiIndex.Node target = one(node, PsiIndex.EdgeRole.TARGET);
            if (propertySymbolForTarget(target, facts) != position
                    || cp2seDeclarationForUse(propertyReceiverForTarget(target), facts) != transform
                    || !hasEffect(facts, node, "mutate")) continue;
            if (match != null) return null;
            match = node;
        }
        return match;
    }

    private List<PsiIndex.Node> cp2seFrameFlow(PsiIndex.Node action,
            PsiIndex.Node assignment, PsiIndex.Node transform, PsiIndex.Node context,
            Rules.SymbolSpec delta, Rules.SymbolSpec position,
            Rules.SymbolSpec vectorType, Rules.SymbolSpec vector,
            List<Map<String, Object>> facts) {
        PsiIndex.Node value = one(assignment, PsiIndex.EdgeRole.VALUE);
        PsiIndex.Node valueCall = directCall(value);
        if (valueCall != null && exactDomainResolution(valueCall, vector, facts)) {
            PsiIndex.Node deltaRead = cp2seUniqueDeltaRead(value, context, delta, facts);
            if (deltaRead != null && ("+=".equals(assignment.value())
                    || cp2seContainsDomainMember(value, transform, position, facts))) {
                return List.of(deltaRead, valueCall);
            }
            List<PsiIndex.Node> carried = cp2sePriorDeltaState(
                action, assignment, value, context, delta, facts);
            if (carried != null) return carried;
        }
        PsiIndex.Node helper = valueCall == null ? null : exactSourceTarget(valueCall, facts);
        if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                || !isTopLevel(helper) || !isProductionPath(helper.fileId())
                || cp2seSourceCallCount(helper, facts) != 1 || hasAnyTaint(valueCall, facts)
                || callbackHasUnknownCall(helper, facts)) return null;
        PsiIndex.Node declaredType = one(helper, PsiIndex.EdgeRole.TYPE);
        PsiIndex.Node returned = sourceReturnOrigin(helper);
        PsiIndex.Node returnedCall = directCall(returned);
        if (declaredType == null || typeSymbolForReference(declaredType) != vectorType
                || returnedCall == null || !exactDomainResolution(returnedCall, vector, facts)) return null;
        List<PsiIndex.Node> parameters = targets(helper, PsiIndex.EdgeRole.PARAMETER);
        Map<Integer, List<PsiIndex.Node>> sourceMap = mapSourceArguments(valueCall, helper, facts);
        PsiIndex.Node deltaRead = null;
        PsiIndex.Node deltaParameter = null;
        PsiIndex.Node positionParameter = null;
        for (int index = 0; index < parameters.size(); index++) {
            PsiIndex.Node argument = mappedArgument(sourceMap, index);
            PsiIndex.Node argumentValue = argument == null
                ? null : one(argument, PsiIndex.EdgeRole.VALUE);
            PsiIndex.Node candidateDelta = cp2seUniqueDeltaRead(
                argumentValue, context, delta, facts);
            if (candidateDelta != null) {
                if (deltaRead != null) return null;
                deltaRead = candidateDelta;
                deltaParameter = parameters.get(index);
            }
            if (cp2seExactPositionRead(argumentValue, transform, position, facts)) {
                if (positionParameter != null) return null;
                positionParameter = parameters.get(index);
            }
        }
        if (deltaRead == null || deltaParameter == null
                || !cp2seContainsParameter(returned, deltaParameter, facts)
                || "=".equals(assignment.value()) && (positionParameter == null
                    || !cp2seContainsParameter(returned, positionParameter, facts))) return null;
        return List.of(deltaRead, assignment, helper, valueCall);
    }

    private PsiIndex.Node cp2seUniqueDeltaRead(PsiIndex.Node expression,
            PsiIndex.Node context, Rules.SymbolSpec delta,
            List<Map<String, Object>> facts) {
        if (expression == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))
                    || !exactDomainResolution(node, delta, facts)
                    || cp2seDeclarationForUse(resolvedReceiver(node), facts) != context) continue;
            if (match != null) return null;
            match = node;
        }
        return match;
    }

    private boolean cp2seContainsDomainMember(PsiIndex.Node expression,
            PsiIndex.Node receiverDeclaration, Rules.SymbolSpec member,
            List<Map<String, Object>> facts) {
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))
                    || propertySymbolForTarget(node, facts) != member) continue;
            if (cp2seDeclarationForUse(propertyReceiverForTarget(node), facts)
                    == receiverDeclaration) return true;
        }
        return false;
    }

    private boolean cp2seExactPositionRead(PsiIndex.Node expression,
            PsiIndex.Node transform, Rules.SymbolSpec position,
            List<Map<String, Object>> facts) {
        return expression != null && propertySymbolForTarget(expression, facts) == position
            && cp2seDeclarationForUse(propertyReceiverForTarget(expression), facts) == transform;
    }

    private boolean cp2seContainsParameter(PsiIndex.Node expression,
            PsiIndex.Node parameter, List<Map<String, Object>> facts) {
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))
                    || node.kind() != PsiIndex.NodeKind.NAME_REF) continue;
            if (cp2seDeclarationForUse(node, facts) == parameter) return true;
        }
        return false;
    }

    private List<PsiIndex.Node> cp2sePriorDeltaState(PsiIndex.Node action,
            PsiIndex.Node transformAssignment, PsiIndex.Node transformValue,
            PsiIndex.Node context, Rules.SymbolSpec delta,
            List<Map<String, Object>> facts) {
        List<PsiIndex.Node> match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.ASSIGNMENT || enclosingCallable(node) != action
                    || node.startUtf16() >= transformAssignment.startUtf16()
                    || !"+=".equals(node.value())) continue;
            PsiIndex.Node deltaRead = cp2seUniqueDeltaRead(
                one(node, PsiIndex.EdgeRole.VALUE), context, delta, facts);
            List<PsiIndex.Node> source = cp2seSourceMemberIdentity(
                one(node, PsiIndex.EdgeRole.TARGET), facts);
            if (deltaRead == null || source == null
                    || !cp2seContainsSourceMember(transformValue, source, facts)) continue;
            if (match != null) return null;
            match = List.of(deltaRead, node);
        }
        return match;
    }

    private List<PsiIndex.Node> cp2seSourceMemberIdentity(PsiIndex.Node access,
            List<Map<String, Object>> facts) {
        if (access == null || access.kind() != PsiIndex.NodeKind.QUALIFIED) return null;
        PsiIndex.Node receiver = one(access, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node selector = one(access, PsiIndex.EdgeRole.SELECTOR);
        PsiIndex.Node member = selector == null ? null : exactSourceTarget(selector, facts);
        PsiIndex.Node receiverDeclaration = cp2seDeclarationForUse(receiver, facts);
        return member == null || receiverDeclaration == null
            ? null : List.of(member, receiverDeclaration);
    }

    private boolean cp2seContainsSourceMember(PsiIndex.Node expression,
            List<PsiIndex.Node> identity, List<Map<String, Object>> facts) {
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))) continue;
            List<PsiIndex.Node> candidate = cp2seSourceMemberIdentity(node, facts);
            if (candidate != null && candidate.get(0) == identity.get(0)
                    && candidate.get(1) == identity.get(1)) return true;
        }
        return false;
    }

    private boolean callbackShape(Rules.SymbolSpec symbol, int position,
            String role, String receiverType) {
        if (symbol == null || symbol.callbacks().size() != 1) return false;
        Rules.CallbackSpec callback = symbol.callbacks().get(0);
        return callback.argumentPosition() == position && callback.role().equals(role)
            && (receiverType == null ? callback.receiverAbstractType() == null
                : receiverType.equals(callback.receiverAbstractType()))
            && callback.receiverSource() == null && callback.parameters().isEmpty();
    }

    private Rules.Analysis analyzeUiLifecycle() {
        Rules.SymbolSpec windowSymbol = domainSymbolOrNull(WINDOW_FQN, WINDOW_SIGNATURE);
        Rules.SymbolSpec themeSymbol = domainSymbolOrNull(THEME_FQN, THEME_SIGNATURE);
        Rules.SymbolSpec stageSymbol = domainSymbolOrNull(STAGE_FQN, STAGE_SIGNATURE);
        Rules.SymbolSpec effectSymbol = domainSymbolOrNull(DISPOSABLE_EFFECT_FQN, DISPOSABLE_EFFECT_SIGNATURE);
        Rules.SymbolSpec disposeSymbol = domainSymbolOrNull(ON_DISPOSE_FQN, ON_DISPOSE_SIGNATURE);
        Rules.SymbolSpec disposableScope = typeSymbolExact(DISPOSABLE_SCOPE_FQN, DISPOSABLE_SCOPE_SIGNATURE);
        Rules.SymbolSpec windowScope = typeSymbolExact(WINDOW_SCOPE_FQN, WINDOW_SCOPE_SIGNATURE);
        Rules.SymbolSpec stageScope = typeSymbolExact(STAGE_SCOPE_FQN, STAGE_SCOPE_SIGNATURE);
        if (windowSymbol == null || themeSymbol == null || stageSymbol == null
                || effectSymbol == null || disposeSymbol == null || disposableScope == null
                || windowScope == null || stageScope == null
                || !callbackShape(windowSymbol, 0, "window_content", "spatial_container_scope")
                || !callbackShape(themeSymbol, 2, "window_content", null)
                || !callbackShape(stageSymbol, 5, "stage_content", "spatial_container_scope")
                || !callbackShape(effectSymbol, 1, "disposable_effect", "disposable_effect_scope")
                || !callbackShape(disposeSymbol, 0, "dispose_cleanup", null)) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node window : program.nodes()) {
            if (window.kind() != PsiIndex.NodeKind.CALL || !isProductionPath(window.fileId())
                    || !exactDomainResolution(window, windowSymbol, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> windowMap = mapDomainArguments(window, windowSymbol, facts);
            PsiIndex.Node windowArgument = mappedArgument(windowMap, 0);
            PsiIndex.Node windowLambda = mappedLambda(windowMap, 0);
            PsiIndex.Node root = enclosingLambda(window);
            if (windowLambda == null || root == null
                    || !exactFact(facts, "callback_binding", windowLambda, window, windowArgument,
                        "window_content", windowSymbol)
                    || !exactFact(facts, "callback_receiver", windowLambda, window, null,
                        "spatial_container_scope", windowScope)
                    || !exactFact(facts, "implicit_receiver", window, root, root,
                        "callback", windowSymbol)) continue;

            PsiIndex.Node theme = uniqueDirectResolvedCall(windowLambda, themeSymbol, facts);
            Map<Integer, List<PsiIndex.Node>> themeMap = theme == null
                ? null : mapDomainArguments(theme, themeSymbol, facts);
            PsiIndex.Node themeArgument = mappedArgument(themeMap, 2);
            PsiIndex.Node themeLambda = mappedLambda(themeMap, 2);
            if (themeLambda == null || !exactFact(facts, "callback_binding", themeLambda,
                    theme, themeArgument, "window_content", themeSymbol)) continue;
            PsiIndex.Node windowContent = uniqueDirectSourceCall(themeLambda, facts);
            if (windowContent == null || callbackResult(themeLambda) != windowContent) continue;

            PsiIndex.Node stage = null;
            Map<Integer, List<PsiIndex.Node>> stageMap = null;
            List<PsiIndex.Node> rootCalls = directCalls(root);
            if (rootCalls == null) continue;
            for (PsiIndex.Node call : rootCalls) {
                Map<Integer, List<PsiIndex.Node>> candidateMap = reviewedDomainMapping(call, stageSymbol, facts);
                if (candidateMap == null) continue;
                if (stage != null) {
                    stage = null;
                    break;
                }
                stage = call;
                stageMap = candidateMap;
            }
            PsiIndex.Node stageLambda = mappedLambda(stageMap, 5);
            if (stage == null || mappedArgument(stageMap, 0) == null || stageLambda == null) continue;
            PsiIndex.Node stageContent = uniqueDirectSourceCall(stageLambda, facts);
            PsiIndex.Node stageOwner = stageContent == null ? null : exactSourceTarget(stageContent, facts);
            if (stageOwner == null || callbackResult(stageLambda) != stageContent) continue;

            PsiIndex.Node effect = null;
            for (PsiIndex.Node node : program.nodes()) {
                if (node.kind() != PsiIndex.NodeKind.CALL || enclosingCallable(node) != stageOwner
                        || !isDirectStatement(node, stageOwner)
                        || !exactDomainResolution(node, effectSymbol, facts)) continue;
                if (effect != null) {
                    effect = null;
                    break;
                }
                effect = node;
            }
            Map<Integer, List<PsiIndex.Node>> effectMap = effect == null
                ? null : mapDomainArguments(effect, effectSymbol, facts);
            PsiIndex.Node keyArgument = mappedArgument(effectMap, 0);
            PsiIndex.Node effectArgument = mappedArgument(effectMap, 1);
            PsiIndex.Node effectLambda = mappedLambda(effectMap, 1);
            if (effectLambda == null || keyArgument == null
                    || !exactFact(facts, "callback_binding", effectLambda, effect, effectArgument,
                        "disposable_effect", effectSymbol)
                    || !exactFact(facts, "callback_receiver", effectLambda, effect, null,
                        "disposable_effect_scope", disposableScope)) continue;

            List<PsiIndex.Node> effectCalls = directStatementCallsLoose(effectLambda);
            PsiIndex.Node dispose = callbackResult(effectLambda);
            int disposeCount = 0;
            if (effectCalls != null) {
                for (PsiIndex.Node call : effectCalls) {
                    if (exactDomainResolution(call, disposeSymbol, facts)) disposeCount++;
                }
            }
            if (effectCalls == null || effectCalls.size() < 2 || disposeCount != 1 || dispose == null
                    || effectCalls.get(effectCalls.size() - 1) != dispose
                    || !exactDomainResolution(dispose, disposeSymbol, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> disposeMap = mapDomainArguments(dispose, disposeSymbol, facts);
            PsiIndex.Node disposeArgument = mappedArgument(disposeMap, 0);
            PsiIndex.Node cleanupLambda = mappedLambda(disposeMap, 0);
            List<PsiIndex.Node> cleanupCalls = directCleanupCalls(cleanupLambda);
            if (cleanupLambda == null || cleanupCalls == null || cleanupCalls.isEmpty()
                    || !exactFact(facts, "callback_binding", cleanupLambda, dispose, disposeArgument,
                        "dispose_cleanup", disposeSymbol)
                    || !exactFact(facts, "implicit_receiver", dispose, effectLambda, effectLambda,
                        "callback", disposeSymbol)) continue;

            Map<String, Boolean> complete = Map.of(
                "themed-window-and-disposable-stage", Boolean.TRUE);
            Map<String, List<String>> alternatives = Map.of(
                "themed-window-and-disposable-stage", List.of("direct-theme-paired-dispose"));
            Map<String, String> selected = Rules.selectProof(
                domain, "spatial.ui-lifecycle", complete, alternatives);
            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(window, witnesses) && addWitness(theme, witnesses)
                && addWitness(windowContent, witnesses) && addWitness(stageContent, witnesses)
                && addWitness(effect, witnesses) && addWitness(keyArgument, witnesses);
            for (int index = 0; valid && index + 1 < effectCalls.size(); index++) {
                valid = addWitness(effectCalls.get(index), witnesses);
            }
            valid &= addWitness(dispose, witnesses);
            for (PsiIndex.Node cleanup : cleanupCalls) if (valid) valid = addWitness(cleanup, witnesses);
            if (!valid) continue;
            Rules.Analysis candidate = Rules.claimOrNull(program, domain, "spatial.ui-lifecycle",
                selected.get("proofForm"), selected.get("alternativeId"), witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = selected.get("alternativeId");
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("spatial.ui-lifecycle", matchAlternative);
        return match;
    }

    // CP2 state emitter section.
    private Rules.Analysis analyzeSingleSource() {
        Rules.SymbolSpec window = domainSymbolOrNull(WINDOW_FQN, WINDOW_SIGNATURE);
        Rules.SymbolSpec stage = domainSymbolOrNull(STAGE_FQN, STAGE_SIGNATURE);
        if (window == null || stage == null
                || !callbackShape(window, 0, "window_content", "spatial_container_scope")
                || !callbackShape(stage, 5, "stage_content", "spatial_container_scope")) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        List<Map<String, Object>> matches = stateAuthorityContainerMatches(facts, window, stage);
        if (matches.size() != 1) return Rules.emptyAnalysis();
        Map<String, Object> match = matches.get(0);
        String alternative = (String) match.get("alternative");
        Map<String, Boolean> complete = Map.of("shared-strong-authority", Boolean.TRUE);
        Map<String, List<String>> alternatives = Map.of(
            "shared-strong-authority", List.of(alternative));
        Map<String, String> selected = Rules.selectProof(
            domain, "state.single-source", complete, alternatives);
        if (!"shared-strong-authority".equals(selected.get("proofForm"))
                || !alternative.equals(selected.get("alternativeId"))) {
            return Rules.emptyAnalysis();
        }

        List<String> witnesses = new ArrayList<>();
        boolean valid = addWitness((PsiIndex.Node) match.get("authority"), witnesses)
            && addWitness((PsiIndex.Node) match.get("originWitness"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowContainer"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowCall"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowArgument"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowTarget"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageContainer"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageCall"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageArgument"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageTarget"), witnesses);
        if (!valid) return Rules.emptyAnalysis();
        Rules.Analysis claim = Rules.claimOrNull(program, domain, "state.single-source",
            "shared-strong-authority", alternative, witnesses);
        if (claim == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("state.single-source", alternative);
        return claim;
    }

    private List<Map<String, Object>> stateAuthorityContainerMatches(
            List<Map<String, Object>> facts, Rules.SymbolSpec window, Rules.SymbolSpec stage) {
        List<Map<String, Object>> matches = new ArrayList<>();
        for (PsiIndex.Node windowContainer : program.nodes()) {
            if (windowContainer.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(windowContainer.fileId())
                    || !exactDomainResolution(windowContainer, window, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> windowMap = mapDomainArguments(
                windowContainer, window, facts);
            PsiIndex.Node windowLambda = mappedLambda(windowMap, 0);
            PsiIndex.Node root = enclosingCallable(windowContainer);
            if (windowLambda == null || root == null) continue;
            for (PsiIndex.Node stageContainer : program.nodes()) {
                if (stageContainer.kind() != PsiIndex.NodeKind.CALL
                        || !isProductionPath(stageContainer.fileId())
                        || enclosingCallable(stageContainer) != root) continue;
                Map<Integer, List<PsiIndex.Node>> stageMap = reviewedDomainMapping(
                    stageContainer, stage, facts);
                PsiIndex.Node stageLambda = mappedLambda(stageMap, 5);
                if (stageLambda == null) continue;
                List<Map<String, Object>> windowUses = stateAuthorityUses(windowLambda, facts);
                List<Map<String, Object>> stageUses = stateAuthorityUses(stageLambda, facts);
                for (Map<String, Object> windowUse : windowUses) {
                    for (Map<String, Object> stageUse : stageUses) {
                        PsiIndex.Node windowAuthority = (PsiIndex.Node) windowUse.get("authority");
                        PsiIndex.Node stageAuthority = (PsiIndex.Node) stageUse.get("authority");
                        String windowAlternative = (String) windowUse.get("alternative");
                        if (windowAuthority.id() != stageAuthority.id()
                                || !windowAlternative.equals(stageUse.get("alternative"))) continue;
                        Map<String, Object> candidate = new HashMap<>();
                        candidate.putAll(windowUse);
                        candidate.put("windowContainer", windowContainer);
                        candidate.put("windowCall", windowUse.get("call"));
                        candidate.put("windowArgument", windowUse.get("argument"));
                        candidate.put("windowTarget", windowUse.get("target"));
                        candidate.put("stageContainer", stageContainer);
                        candidate.put("stageCall", stageUse.get("call"));
                        candidate.put("stageArgument", stageUse.get("argument"));
                        candidate.put("stageTarget", stageUse.get("target"));
                        matches.add(Map.copyOf(candidate));
                    }
                }
            }
        }
        return matches;
    }

    private List<Map<String, Object>> stateAuthorityUses(PsiIndex.Node containerLambda,
            List<Map<String, Object>> facts) {
        List<Map<String, Object>> uses = new ArrayList<>();
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, containerLambda)
                    || !isProductionPath(call.fileId()) || hasAnyTaint(call, facts)) continue;
            PsiIndex.Node target = exactSourceTarget(call, facts);
            if (target == null || target.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isProductionPath(target.fileId())) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(call, target, facts);
            if (mapping == null) continue;
            for (Map.Entry<Integer, List<PsiIndex.Node>> entry : mapping.entrySet()) {
                PsiIndex.Node argument = mappedArgument(mapping, entry.getKey());
                PsiIndex.Node value = argument == null ? null
                    : one(argument, PsiIndex.EdgeRole.VALUE);
                Map<String, Object> authority = stateAuthorityForValue(
                    value, facts, 0, new HashMap<>());
                if (authority == null) continue;
                Map<String, Object> use = new HashMap<>(authority);
                use.put("call", call);
                use.put("argument", argument);
                use.put("target", target);
                uses.add(Map.copyOf(use));
            }
        }
        return uses;
    }

    private Map<String, Object> stateAuthorityForValue(PsiIndex.Node value,
            List<Map<String, Object>> facts, int depth, Map<Integer, Boolean> active) {
        if (value == null || depth >= 8 || active.put(value.id(), Boolean.TRUE) != null) return null;
        if (value.kind() == PsiIndex.NodeKind.NAME_REF && value.name() != null) {
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
            if (declaration == null) declaration = findLexicalDeclaration(value, value.name());
            Map<String, Object> direct = stateAuthorityDeclaration(declaration, facts);
            if (direct != null) return direct;
            if (declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                    && declaration.flags().contains(PsiIndex.NodeFlag.VAL)
                    && !declaration.flags().contains(PsiIndex.NodeFlag.VAR)) {
                List<PsiIndex.Node> origins = propertyOrigins(declaration);
                if (origins.size() != 1
                        || stateAuthorityEscapes(declaration, origins.get(0), facts)) return null;
                return stateAuthorityForValue(origins.get(0), facts, depth + 1, active);
            }
        }
        if (value.kind() == PsiIndex.NodeKind.QUALIFIED
                || value.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
            PsiIndex.Node selector = one(value, PsiIndex.EdgeRole.SELECTOR);
            PsiIndex.Node property = stateQualifiedAuthorityProperty(value, facts);
            Map<String, Object> direct = stateAuthorityDeclaration(property, facts);
            if (direct != null) return direct;
            if (selector != null) {
                Map<String, Object> nested = stateAuthorityForValue(
                    selector, facts, depth + 1, active);
                if (nested != null) return nested;
            }
            return stateAuthorityForValue(one(value, PsiIndex.EdgeRole.RECEIVER),
                facts, depth + 1, active);
        }
        PsiIndex.Node call = directCall(value);
        if (call != null) {
            PsiIndex.Node target = exactSourceTarget(call, facts);
            PsiIndex.Node returned = target == null ? null : sourceReturnOrigin(target);
            if (returned != null) {
                Map<String, Object> result = stateAuthorityForValue(
                    returned, facts, depth + 1, active);
                if (result != null) return result;
            }
        }
        PsiIndex.Node representative = representativeOrigin(value, facts);
        return representative != null && representative.id() != value.id()
            ? stateAuthorityForValue(representative, facts, depth + 1, active) : null;
    }

    private Map<String, Object> stateAuthorityDeclaration(PsiIndex.Node property,
            List<Map<String, Object>> facts) {
        if (property == null || property.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !isProductionPath(property.fileId())
                || !property.flags().contains(PsiIndex.NodeFlag.VAL)
                || property.flags().contains(PsiIndex.NodeFlag.VAR)) return null;
        PsiIndex.Node owner = authorityOwner(property);
        List<PsiIndex.Node> origins = propertyOrigins(property);
        if (owner == null || origins.size() != 1) return null;
        PsiIndex.Node origin = origins.get(0);
        boolean initializer = one(property, PsiIndex.EdgeRole.INITIALIZER) != null;
        if (!initializer && isFreshConstruction(origin, facts)) return null;
        String factKind = owner.kind() == PsiIndex.NodeKind.OBJECT_DECL ? "object"
            : owner.kind() == PsiIndex.NodeKind.COMPANION_DECL ? "companion" : "top_level";
        String alternative = owner.kind() == PsiIndex.NodeKind.OBJECT_DECL ? "object-singleton"
            : owner.kind() == PsiIndex.NodeKind.COMPANION_DECL
                ? "companion-held-singleton" : "top-level-val";
        boolean exactStrong = exactFact(facts, "strong_authority", property,
            owner, origin, factKind, null);
        if (hasFact(facts, "strong_authority", property.id()) && !exactStrong) return null;
        if (stateAuthorityEscapes(property, origin, facts)) return null;
        PsiIndex.Node originWitness = origin.witnessNodeId() != null ? origin
            : origin.kind() == PsiIndex.NodeKind.QUALIFIED
                ? stateQualifiedAuthorityProperty(origin, facts) : null;
        if (originWitness == null || originWitness.witnessNodeId() == null) return null;
        return Map.of(
            "authority", property,
            "origin", origin,
            "originWitness", originWitness,
            "alternative", alternative);
    }

    private PsiIndex.Node stateQualifiedAuthorityProperty(PsiIndex.Node qualified,
            List<Map<String, Object>> facts) {
        PsiIndex.Node selector = one(qualified, PsiIndex.EdgeRole.SELECTOR);
        if (selector == null || selector.name() == null) return null;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", selector.id());
        if (declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
            return declaration;
        }
        PsiIndex.Node receiver = one(qualified, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node container = sourceTypeForValue(receiver, facts);
        if (container == null && receiver != null) container = sourceTypeDeclaration(receiver);
        if (container == null) return null;
        List<PsiIndex.Node> owners = new ArrayList<>();
        owners.add(container);
        if (container.kind() == PsiIndex.NodeKind.CLASS_DECL) {
            for (PsiIndex.Node child : lexicalChildren(container)) {
                if (child.kind() == PsiIndex.NodeKind.COMPANION_DECL) owners.add(child);
            }
        }
        PsiIndex.Node match = null;
        for (PsiIndex.Node owner : owners) {
            for (PsiIndex.Node child : lexicalChildren(owner)) {
                if (child.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                        || !selector.name().equals(child.name())) continue;
                if (match != null) return null;
                match = child;
            }
        }
        return match;
    }

    private boolean stateAuthorityEscapes(PsiIndex.Node property, PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        for (Map<String, Object> fact : facts) {
            String kind = (String) fact.get("kind");
            String value = (String) fact.get("value");
            if (!"escape".equals(kind) && !("effect".equals(kind)
                    && ("replace".equals(value) || "unknown_escape".equals(value)))) continue;
            int subjectId = ((Long) fact.get("subjectNodeId")).intValue();
            int relatedId = ((Long) fact.get("relatedNodeId")).intValue();
            if (stateAuthorityEndpoint(subjectId, property, origin, facts)
                    || stateAuthorityEndpoint(relatedId, property, origin, facts)) return true;
        }
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(call.fileId())
                    || hasCallableAuthority(call)) continue;
            for (PsiIndex.Node argument : uniqueTargets(call, PsiIndex.EdgeRole.ARGUMENT)) {
                PsiIndex.Node value = argumentValue(argument);
                if (value == null) continue;
                if (stateAuthorityEndpoint(value.id(), property, origin, facts)) return true;
                PsiIndex.Node declaration = value.kind() == PsiIndex.NodeKind.NAME_REF
                    ? relatedNodeForFact(facts, "def_use", value.id()) : null;
                if (declaration == null && value.kind() == PsiIndex.NodeKind.NAME_REF
                        && value.name() != null) {
                    declaration = findLexicalDeclaration(value, value.name());
                }
                if (declaration != null && declaration.id() == property.id()) return true;
            }
        }
        return false;
    }

    private boolean stateAuthorityEndpoint(int nodeId, PsiIndex.Node property,
            PsiIndex.Node origin, List<Map<String, Object>> facts) {
        if (nodeId < 0) return false;
        if (nodeId == property.id() || nodeId == origin.id()) return true;
        PsiIndex.Node representative = representativeOrigin(program.node(nodeId), facts);
        return representative != null && (representative.id() == property.id()
            || representative.id() == origin.id());
    }

    private Rules.Analysis analyzeTypedHandoff() {
        Rules.SymbolSpec bundleType = typeSymbolExact(BUNDLE_TYPE_FQN, BUNDLE_TYPE_SIGNATURE);
        Rules.SymbolSpec bundleConstructor = domainSymbolOrNull("android.os.Bundle", "Bundle()");
        Rules.SymbolSpec apply = domainSymbolOrNull(
            "kotlin.apply", "T.apply(block: T.() -> Unit): T");
        Rules.SymbolSpec putString = domainSymbolOrNull(
            "android.os.BaseBundle.putString", "putString(key: String, value: String?): Unit");
        Rules.SymbolSpec putInt = domainSymbolOrNull(
            "android.os.BaseBundle.putInt", "putInt(key: String, value: Int): Unit");
        Rules.SymbolSpec putBoolean = domainSymbolOrNull(
            "android.os.BaseBundle.putBoolean", "putBoolean(key: String, value: Boolean): Unit");
        Rules.SymbolSpec getString = domainSymbolOrNull(
            "android.os.BaseBundle.getString", "getString(key: String): String?");
        Rules.SymbolSpec getInt = domainSymbolOrNull(
            "android.os.BaseBundle.getInt", "getInt(key: String): Int");
        Rules.SymbolSpec getBoolean = domainSymbolOrNull(
            "android.os.BaseBundle.getBoolean", "getBoolean(key: String): Boolean");
        Rules.SymbolSpec openStage = domainSymbolOrNull(OPEN_STAGE_FQN, OPEN_STAGE_SIGNATURE);
        if (bundleType == null || bundleConstructor == null || apply == null
                || putString == null || putInt == null || putBoolean == null
                || getString == null || getInt == null || getBoolean == null
                || openStage == null || !stateTypedApplyShape(apply)) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        List<Map<String, Object>> matches = new ArrayList<>();
        for (PsiIndex.Node snapshot : program.nodes()) {
            Map<String, PsiIndex.Node> fields = stateTypedSnapshotFields(snapshot);
            if (fields == null) continue;
            List<Map<String, Object>> encoders = stateTypedEncoders(snapshot, fields, facts,
                bundleType, bundleConstructor, apply, putString, putInt, putBoolean, openStage);
            List<Map<String, Object>> decoders = stateTypedDecoders(snapshot, fields, facts,
                bundleType, getString, getInt, getBoolean);
            for (Map<String, Object> encoder : encoders) {
                for (Map<String, Object> decoder : decoders) {
                    if (!stateTypedKeysAgree(encoder, decoder)) continue;
                    Map<String, Object> match = new HashMap<>();
                    match.put("snapshot", snapshot);
                    match.put("selectionField", fields.get("selection"));
                    match.put("intField", fields.get("int"));
                    match.put("booleanField", fields.get("boolean"));
                    match.putAll(encoder);
                    match.putAll(decoder);
                    boolean helper = encoder.containsKey("encoderHelper")
                        || decoder.containsKey("decoderHelper");
                    match.put("alternative", helper
                        ? "unique-helper-bundle-adapter" : "direct-bundle-adapter");
                    matches.add(Map.copyOf(match));
                }
            }
        }
        if (matches.size() != 1) return Rules.emptyAnalysis();
        Map<String, Object> match = matches.get(0);
        String alternative = (String) match.get("alternative");
        Map<String, String> selected = Rules.selectProof(domain, "state.typed-handoff",
            Map.of("typed-bundle-roundtrip", Boolean.TRUE),
            Map.of("typed-bundle-roundtrip", List.of(alternative)));
        if (!"typed-bundle-roundtrip".equals(selected.get("proofForm"))
                || !alternative.equals(selected.get("alternativeId"))) {
            return Rules.emptyAnalysis();
        }
        List<String> witnesses = new ArrayList<>();
        boolean valid = addWitness((PsiIndex.Node) match.get("snapshot"), witnesses)
            && addWitness((PsiIndex.Node) match.get("selectionField"), witnesses)
            && addWitness((PsiIndex.Node) match.get("intField"), witnesses)
            && addWitness((PsiIndex.Node) match.get("booleanField"), witnesses)
            && addWitness((PsiIndex.Node) match.get("openCall"), witnesses)
            && addWitness((PsiIndex.Node) match.get("bundleArgument"), witnesses)
            && addWitness((PsiIndex.Node) match.get("encoder"), witnesses)
            && addWitness((PsiIndex.Node) match.get("decoder"), witnesses)
            && addWitness((PsiIndex.Node) match.get("constructor"), witnesses);
        if (valid && match.containsKey("encoderHelper")) {
            valid = addWitness((PsiIndex.Node) match.get("encoderHelper"), witnesses);
        }
        if (valid && match.containsKey("decoderHelper")) {
            valid = addWitness((PsiIndex.Node) match.get("decoderHelper"), witnesses);
        }
        for (PsiIndex.Node call : stateTypedNodeList(match, "putCalls")) {
            if (valid) valid = addWitness(call, witnesses);
        }
        for (PsiIndex.Node call : stateTypedNodeList(match, "getCalls")) {
            if (valid) valid = addWitness(call, witnesses);
        }
        if (!valid) return Rules.emptyAnalysis();
        Rules.Analysis claim = Rules.claimOrNull(program, domain, "state.typed-handoff",
            "typed-bundle-roundtrip", alternative, witnesses);
        if (claim == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("state.typed-handoff", alternative);
        return claim;
    }

    private boolean stateTypedApplyShape(Rules.SymbolSpec apply) {
        if (apply == null || apply.callbacks().size() != 1) return false;
        Rules.CallbackSpec callback = apply.callbacks().get(0);
        return callback.argumentPosition() == 0
            && "inline_block".equals(callback.role())
            && "immediate_inline".equals(callback.invocationModel())
            && "bundle".equals(callback.receiverAbstractType())
            && "call_receiver".equals(callback.receiverSource())
            && callback.parameters().isEmpty();
    }

    private Map<String, PsiIndex.Node> stateTypedSnapshotFields(PsiIndex.Node snapshot) {
        if (snapshot == null || snapshot.kind() != PsiIndex.NodeKind.CLASS_DECL
                || !snapshot.flags().contains(PsiIndex.NodeFlag.DATA)
                || !isProductionPath(snapshot.fileId())) return null;
        List<PsiIndex.Node> parameters = targets(snapshot, PsiIndex.EdgeRole.PARAMETER);
        if (parameters.size() != 3) return null;
        Map<String, PsiIndex.Node> fields = new HashMap<>();
        for (PsiIndex.Node parameter : parameters) {
            if (!parameter.flags().contains(PsiIndex.NodeFlag.VAL)
                    || parameter.flags().contains(PsiIndex.NodeFlag.VAR)) return null;
            PsiIndex.Node type = one(parameter, PsiIndex.EdgeRole.TYPE);
            String primitive = primitiveType(type);
            boolean nullable = isExplicitNullableTarget(parameter, type);
            String key;
            if ("int".equals(primitive) && !nullable) key = "int";
            else if ("boolean".equals(primitive) && !nullable) key = "boolean";
            else if (primitive == null && nullable
                    && sourceTypeDeclaration(type) != null) key = "selection";
            else return null;
            if (fields.put(key, parameter) != null) return null;
        }
        return fields.size() == 3 ? Map.copyOf(fields) : null;
    }

    private List<Map<String, Object>> stateTypedEncoders(PsiIndex.Node snapshot,
            Map<String, PsiIndex.Node> fields, List<Map<String, Object>> facts,
            Rules.SymbolSpec bundleType, Rules.SymbolSpec bundleConstructor,
            Rules.SymbolSpec apply, Rules.SymbolSpec putString, Rules.SymbolSpec putInt,
            Rules.SymbolSpec putBoolean, Rules.SymbolSpec openStage) {
        List<Map<String, Object>> encoders = new ArrayList<>();
        for (PsiIndex.Node openCall : program.nodes()) {
            if (openCall.kind() != PsiIndex.NodeKind.CALL || !isProductionPath(openCall.fileId())) continue;
            Map<Integer, List<PsiIndex.Node>> openMap = reviewedDomainMapping(
                openCall, openStage, facts);
            PsiIndex.Node bundleArgument = mappedArgument(openMap, 2);
            PsiIndex.Node value = bundleArgument == null ? null
                : one(bundleArgument, PsiIndex.EdgeRole.VALUE);
            Map<String, Object> encoder = stateTypedEncoderFromValue(value, snapshot, fields,
                facts, bundleType, bundleConstructor, apply, putString, putInt, putBoolean,
                0, new HashMap<>());
            if (encoder == null) continue;
            Map<String, Object> result = new HashMap<>(encoder);
            result.put("openCall", openCall);
            result.put("bundleArgument", bundleArgument);
            encoders.add(Map.copyOf(result));
        }
        return encoders;
    }

    private Map<String, Object> stateTypedEncoderFromValue(PsiIndex.Node value,
            PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            List<Map<String, Object>> facts, Rules.SymbolSpec bundleType,
            Rules.SymbolSpec bundleConstructor, Rules.SymbolSpec apply,
            Rules.SymbolSpec putString, Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean,
            int depth, Map<Integer, Boolean> active) {
        if (value == null || depth > 6 || active.put(value.id(), Boolean.TRUE) != null) return null;
        if (value.kind() == PsiIndex.NodeKind.NAME_REF && value.name() != null) {
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
            if (declaration == null) declaration = findLexicalDeclaration(value, value.name());
            if (declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                    && declaration.flags().contains(PsiIndex.NodeFlag.VAL)
                    && !declaration.flags().contains(PsiIndex.NodeFlag.VAR)) {
                PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
                return stateTypedEncoderFromValue(initializer, snapshot, fields, facts,
                    bundleType, bundleConstructor, apply, putString, putInt, putBoolean,
                    depth + 1, active);
            }
        }
        PsiIndex.Node call = directCall(value);
        if (call == null && value.kind() == PsiIndex.NodeKind.CALL) call = value;
        if (call == null) return null;
        PsiIndex.Node target = exactSourceTarget(call, facts);
        if (target != null && target.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                && isProductionPath(target.fileId())
                && mapSourceArguments(call, target, facts) != null) {
            Map<String, Object> encoder = stateTypedEncoderFunction(target, snapshot, fields,
                facts, bundleType, bundleConstructor, apply, putString, putInt, putBoolean);
            if (encoder != null) return encoder;
        }
        PsiIndex.Node lambda = stateTypedApplyLambda(
            call, bundleConstructor, apply, facts);
        if (lambda == null) return null;
        Map<String, Object> operations = stateTypedPutOperations(lambda, snapshot, fields,
            facts, putString, putInt, putBoolean);
        if (operations == null) {
            operations = stateTypedPutHelper(lambda, snapshot, fields, facts,
                putString, putInt, putBoolean);
        }
        if (operations == null) return null;
        Map<String, Object> result = new HashMap<>(operations);
        PsiIndex.Node encoder = enclosingCallable(call);
        if (encoder == null || !isProductionPath(encoder.fileId())) return null;
        result.put("encoder", encoder);
        return Map.copyOf(result);
    }

    private Map<String, Object> stateTypedEncoderFunction(PsiIndex.Node encoder,
            PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            List<Map<String, Object>> facts, Rules.SymbolSpec bundleType,
            Rules.SymbolSpec bundleConstructor, Rules.SymbolSpec apply,
            Rules.SymbolSpec putString, Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        PsiIndex.Node declaredType = one(encoder, PsiIndex.EdgeRole.TYPE);
        if (declaredType == null || typeSymbolForReference(declaredType) != bundleType
                || isExplicitNullable(declaredType)) return null;
        int snapshotParameters = 0;
        for (PsiIndex.Node parameter : targets(encoder, PsiIndex.EdgeRole.PARAMETER)) {
            PsiIndex.Node type = one(parameter, PsiIndex.EdgeRole.TYPE);
            if (sourceTypeDeclaration(type) == snapshot) snapshotParameters++;
        }
        if (snapshotParameters != 1) return null;
        PsiIndex.Node resultValue = sourceReturnOrigin(encoder);
        PsiIndex.Node applyCall = directCall(resultValue);
        PsiIndex.Node lambda = stateTypedApplyLambda(
            applyCall, bundleConstructor, apply, facts);
        if (lambda == null) return null;
        Map<String, Object> operations = stateTypedPutOperations(lambda, snapshot, fields,
            facts, putString, putInt, putBoolean);
        if (operations == null) {
            operations = stateTypedPutHelper(lambda, snapshot, fields, facts,
                putString, putInt, putBoolean);
        }
        if (operations == null) return null;
        Map<String, Object> result = new HashMap<>(operations);
        result.put("encoder", encoder);
        return Map.copyOf(result);
    }

    private PsiIndex.Node stateTypedApplyLambda(PsiIndex.Node applyCall,
            Rules.SymbolSpec bundleConstructor, Rules.SymbolSpec apply,
            List<Map<String, Object>> facts) {
        if (applyCall == null || !exactDomainResolution(applyCall, apply, facts)) return null;
        PsiIndex.Node receiver = resolvedReceiver(applyCall);
        PsiIndex.Node constructor = directCall(receiver);
        if (constructor == null && receiver != null
                && receiver.kind() == PsiIndex.NodeKind.CALL) constructor = receiver;
        if (constructor == null || !exactDomainResolution(constructor, bundleConstructor, facts)) return null;
        Map<Integer, List<PsiIndex.Node>> mapping = mapDomainArguments(applyCall, apply, facts);
        return mappedLambda(mapping, 0);
    }

    private Map<String, Object> stateTypedPutOperations(PsiIndex.Node callable,
            PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            List<Map<String, Object>> facts, Rules.SymbolSpec putString,
            Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        Map<String, Object> result = new HashMap<>();
        List<PsiIndex.Node> calls = new ArrayList<>();
        for (String key : List.of("selection", "int", "boolean")) {
            Rules.SymbolSpec symbol = key.equals("selection") ? putString
                : key.equals("int") ? putInt : putBoolean;
            List<PsiIndex.Node> matches = stateTypedDomainCallsWithin(callable, symbol, facts);
            if (matches.size() != 1) return null;
            PsiIndex.Node call = matches.get(0);
            Map<Integer, List<PsiIndex.Node>> mapping =
                reviewedDomainMapping(call, symbol, facts);
            PsiIndex.Node keyArgument = mappedArgument(mapping, 0);
            PsiIndex.Node valueArgument = mappedArgument(mapping, 1);
            String literal = keyArgument == null ? null
                : atomicString(one(keyArgument, PsiIndex.EdgeRole.VALUE));
            PsiIndex.Node value = valueArgument == null ? null
                : one(valueArgument, PsiIndex.EdgeRole.VALUE);
            if (literal == null || !stateTypedFieldReferenced(
                    value, fields.get(key), snapshot, facts)) return null;
            result.put(key + "Key", literal);
            calls.add(call);
        }
        if (((String) result.get("selectionKey")).equals(result.get("intKey"))
                || ((String) result.get("selectionKey")).equals(result.get("booleanKey"))
                || ((String) result.get("intKey")).equals(result.get("booleanKey"))) return null;
        result.put("putCalls", List.copyOf(calls));
        return Map.copyOf(result);
    }

    private Map<String, Object> stateTypedPutHelper(PsiIndex.Node callable,
            PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            List<Map<String, Object>> facts, Rules.SymbolSpec putString,
            Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        Map<String, Object> match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, callable)
                    || hasAnyTaint(call, facts)) continue;
            PsiIndex.Node helper = exactSourceTarget(call, facts);
            if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isProductionPath(helper.fileId())
                    || mapSourceArguments(call, helper, facts) == null) continue;
            Map<String, Object> operations = stateTypedPutOperations(helper, snapshot, fields,
                facts, putString, putInt, putBoolean);
            if (operations == null || match != null) return null;
            Map<String, Object> candidate = new HashMap<>(operations);
            candidate.put("encoderHelper", helper);
            match = Map.copyOf(candidate);
        }
        return match;
    }

    private List<Map<String, Object>> stateTypedDecoders(PsiIndex.Node snapshot,
            Map<String, PsiIndex.Node> fields, List<Map<String, Object>> facts,
            Rules.SymbolSpec bundleType, Rules.SymbolSpec getString,
            Rules.SymbolSpec getInt, Rules.SymbolSpec getBoolean) {
        List<Map<String, Object>> decoders = new ArrayList<>();
        for (PsiIndex.Node decoder : program.nodes()) {
            if (decoder.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || decoder.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                    || !isProductionPath(decoder.fileId())) continue;
            PsiIndex.Node type = one(decoder, PsiIndex.EdgeRole.TYPE);
            if (sourceTypeDeclaration(type) != snapshot) continue;
            int bundleParameters = 0;
            for (PsiIndex.Node parameter : targets(decoder, PsiIndex.EdgeRole.PARAMETER)) {
                PsiIndex.Node parameterType = one(parameter, PsiIndex.EdgeRole.TYPE);
                if (typeSymbolForReference(parameterType) == bundleType) bundleParameters++;
            }
            if (bundleParameters != 1) continue;
            Map<String, Object> candidate = stateTypedDecodeResult(sourceReturnOrigin(decoder),
                decoder, snapshot, fields, facts, getString, getInt, getBoolean, false);
            if (candidate != null) decoders.add(candidate);
        }
        return decoders;
    }

    private Map<String, Object> stateTypedDecodeResult(PsiIndex.Node resultValue,
            PsiIndex.Node decoder, PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            List<Map<String, Object>> facts, Rules.SymbolSpec getString,
            Rules.SymbolSpec getInt, Rules.SymbolSpec getBoolean, boolean helperDepth) {
        PsiIndex.Node call = directCall(resultValue);
        if (call == null && resultValue != null
                && resultValue.kind() == PsiIndex.NodeKind.CALL) call = resultValue;
        if (call == null) return null;
        PsiIndex.Node target = exactSourceTarget(call, facts);
        if (target == snapshot) {
            Map<String, Object> reads = stateTypedReadOperations(call, snapshot, fields,
                facts, getString, getInt, getBoolean);
            if (reads == null) return null;
            Map<String, Object> candidate = new HashMap<>(reads);
            candidate.put("decoder", decoder);
            candidate.put("constructor", call);
            return Map.copyOf(candidate);
        }
        if (helperDepth || target == null || target.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                || !isProductionPath(target.fileId())
                || mapSourceArguments(call, target, facts) == null) return null;
        PsiIndex.Node type = one(target, PsiIndex.EdgeRole.TYPE);
        if (sourceTypeDeclaration(type) != snapshot) return null;
        Map<String, Object> nested = stateTypedDecodeResult(sourceReturnOrigin(target),
            decoder, snapshot, fields, facts, getString, getInt, getBoolean, true);
        if (nested == null) return null;
        Map<String, Object> candidate = new HashMap<>(nested);
        candidate.put("decoderHelper", target);
        return Map.copyOf(candidate);
    }

    private Map<String, Object> stateTypedReadOperations(PsiIndex.Node constructor,
            PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            List<Map<String, Object>> facts, Rules.SymbolSpec getString,
            Rules.SymbolSpec getInt, Rules.SymbolSpec getBoolean) {
        Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(
            constructor, snapshot, facts);
        if (mapping == null || mapping.size() != 3) return null;
        Map<String, Object> result = new HashMap<>();
        List<PsiIndex.Node> calls = new ArrayList<>();
        List<PsiIndex.Node> parameters = targets(snapshot, PsiIndex.EdgeRole.PARAMETER);
        for (int position = 0; position < parameters.size(); position++) {
            PsiIndex.Node field = parameters.get(position);
            String key = field.id() == fields.get("selection").id() ? "selection"
                : field.id() == fields.get("int").id() ? "int" : "boolean";
            Rules.SymbolSpec symbol = key.equals("selection") ? getString
                : key.equals("int") ? getInt : getBoolean;
            PsiIndex.Node argument = mappedArgument(mapping, position);
            PsiIndex.Node value = argument == null ? null
                : one(argument, PsiIndex.EdgeRole.VALUE);
            List<PsiIndex.Node> resolved = stateTypedDomainCallsWithin(value, symbol, facts);
            if (resolved.size() != 1) return null;
            PsiIndex.Node getCall = resolved.get(0);
            Map<Integer, List<PsiIndex.Node>> getMap = mapDomainArguments(getCall, symbol, facts);
            PsiIndex.Node keyArgument = mappedArgument(getMap, 0);
            String literal = keyArgument == null ? null
                : atomicString(one(keyArgument, PsiIndex.EdgeRole.VALUE));
            if (literal == null) return null;
            result.put(key + "Key", literal);
            calls.add(getCall);
        }
        result.put("getCalls", List.copyOf(calls));
        return Map.copyOf(result);
    }

    private List<PsiIndex.Node> stateTypedDomainCallsWithin(PsiIndex.Node owner,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        List<PsiIndex.Node> calls = new ArrayList<>();
        if (owner == null) return calls;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.CALL
                    || node.id() != owner.id() && !isWithin(node, owner)
                    || reviewedDomainMapping(node, symbol, facts) == null) continue;
            calls.add(node);
        }
        return calls;
    }

    private boolean stateTypedFieldReferenced(PsiIndex.Node value, PsiIndex.Node field,
            PsiIndex.Node snapshot, List<Map<String, Object>> facts) {
        if (value == null || field == null || field.name() == null) return false;
        int count = 0;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.NAME_REF || node.name() == null
                    || !node.name().equals(field.name())
                    || node.id() != value.id() && !isWithin(node, value)) continue;
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", node.id());
            boolean exact = declaration == field;
            Integer ownerId = lexicalOwners.get(node.id());
            PsiIndex.Node owner = ownerId == null ? null : program.node(ownerId);
            if (!exact && owner != null && (owner.kind() == PsiIndex.NodeKind.QUALIFIED
                    || owner.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED)
                    && one(owner, PsiIndex.EdgeRole.SELECTOR) == node) {
                PsiIndex.Node receiver = one(owner, PsiIndex.EdgeRole.RECEIVER);
                PsiIndex.Node receiverType = sourceTypeForValue(receiver, facts);
                if (receiverType == null) receiverType = stateTypedBoundResultType(receiver, facts);
                exact = receiverType == snapshot;
            }
            if (exact) count++;
        }
        return count == 1;
    }

    private PsiIndex.Node stateTypedBoundResultType(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        PsiIndex.Node call = directCall(value);
        if (call == null && value != null && value.kind() == PsiIndex.NodeKind.NAME_REF) {
            PsiIndex.Node declaration = sourceValueDeclaration(value, facts);
            PsiIndex.Node initializer = declaration == null ? null
                : one(declaration, PsiIndex.EdgeRole.INITIALIZER);
            call = directCall(initializer);
        }
        if (call == null) return null;
        PsiIndex.Node target = exactSourceTarget(call, facts);
        if (target == null) {
            PsiIndex.Node bound = relatedNodeForFact(facts, "call_resolution", call.id());
            if (bound != null && exactFact(facts, "call_resolution", call,
                    enclosingCallable(call), bound, "function_value", null)) target = bound;
        }
        return target != null && target.kind() == PsiIndex.NodeKind.FUNCTION_DECL
            ? sourceTypeDeclaration(one(target, PsiIndex.EdgeRole.TYPE)) : null;
    }

    private boolean stateTypedKeysAgree(Map<String, Object> encoder,
            Map<String, Object> decoder) {
        return encoder.get("selectionKey").equals(decoder.get("selectionKey"))
            && encoder.get("intKey").equals(decoder.get("intKey"))
            && encoder.get("booleanKey").equals(decoder.get("booleanKey"));
    }

    @SuppressWarnings("unchecked")
    private List<PsiIndex.Node> stateTypedNodeList(Map<String, Object> match, String key) {
        Object value = match.get(key);
        return value instanceof List<?> ? (List<PsiIndex.Node>) value : List.of();
    }

    private Rules.Analysis analyzeSharedReadWrite() {
        Rules.SymbolSpec window = domainSymbolOrNull(WINDOW_FQN, WINDOW_SIGNATURE);
        Rules.SymbolSpec stage = domainSymbolOrNull(STAGE_FQN, STAGE_SIGNATURE);
        if (window == null || stage == null
                || !callbackShape(window, 0, "window_content", "spatial_container_scope")
                || !callbackShape(stage, 5, "stage_content", "spatial_container_scope")) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        List<Map<String, Object>> matches = stateSharedContainerMatches(facts, window, stage);
        if (matches.size() != 1) return Rules.emptyAnalysis();
        Map<String, Object> match = matches.get(0);
        String proofForm = "same-authority-read-write";
        String alternative = "direct-container-summaries";
        Map<String, String> selected = Rules.selectProof(domain, "state.shared-read-write",
            Map.of(proofForm, Boolean.TRUE), Map.of(proofForm, List.of(alternative)));
        if (!proofForm.equals(selected.get("proofForm"))
                || !alternative.equals(selected.get("alternativeId"))) {
            return Rules.emptyAnalysis();
        }
        List<String> witnesses = new ArrayList<>();
        boolean valid = addWitness((PsiIndex.Node) match.get("origin"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowContainer"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowCall"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowTarget"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowRead"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowWrite"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageContainer"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageCall"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageTarget"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageRead"), witnesses)
            && addWitness((PsiIndex.Node) match.get("stageWrite"), witnesses);
        if (!valid) return Rules.emptyAnalysis();
        Rules.Analysis claim = Rules.claimOrNull(program, domain, "state.shared-read-write",
            proofForm, alternative, witnesses);
        if (claim == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("state.shared-read-write", alternative);
        return claim;
    }

    private List<Map<String, Object>> stateSharedContainerMatches(
            List<Map<String, Object>> facts, Rules.SymbolSpec window, Rules.SymbolSpec stage) {
        List<Map<String, Object>> matches = new ArrayList<>();
        for (PsiIndex.Node windowContainer : program.nodes()) {
            if (windowContainer.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(windowContainer.fileId())
                    || !exactDomainResolution(windowContainer, window, facts)) continue;
            PsiIndex.Node root = enclosingCallable(windowContainer);
            PsiIndex.Node windowLambda = mappedLambda(
                mapDomainArguments(windowContainer, window, facts), 0);
            if (root == null || windowLambda == null) continue;
            for (PsiIndex.Node stageContainer : program.nodes()) {
                if (stageContainer.kind() != PsiIndex.NodeKind.CALL
                        || enclosingCallable(stageContainer) != root
                        || !isProductionPath(stageContainer.fileId())) continue;
                PsiIndex.Node stageLambda = mappedLambda(
                    reviewedDomainMapping(stageContainer, stage, facts), 5);
                if (stageLambda == null) continue;
                List<Map<String, Object>> windowUses = stateSharedUses(windowLambda, facts);
                List<Map<String, Object>> stageUses = stateSharedUses(stageLambda, facts);
                for (Map<String, Object> windowUse : windowUses) {
                    for (Map<String, Object> stageUse : stageUses) {
                        PsiIndex.Node windowOrigin = (PsiIndex.Node) windowUse.get("origin");
                        PsiIndex.Node stageOrigin = (PsiIndex.Node) stageUse.get("origin");
                        PsiIndex.Node windowType = (PsiIndex.Node) windowUse.get("authorityType");
                        PsiIndex.Node stageType = (PsiIndex.Node) stageUse.get("authorityType");
                        if (windowOrigin.id() != stageOrigin.id()
                                || windowType.id() != stageType.id()
                                || !stateRetainedOriginAccepted(windowOrigin, facts)
                                || isWithin(windowOrigin, windowLambda)
                                || isWithin(stageOrigin, stageLambda)
                                || stateSharedOriginEscapes(windowOrigin, facts)) continue;
                        Map<String, Object> candidate = new HashMap<>();
                        candidate.put("origin", windowOrigin);
                        candidate.put("windowContainer", windowContainer);
                        candidate.put("windowCall", windowUse.get("call"));
                        candidate.put("windowTarget", windowUse.get("target"));
                        candidate.put("windowRead", windowUse.get("read"));
                        candidate.put("windowWrite", windowUse.get("write"));
                        candidate.put("stageContainer", stageContainer);
                        candidate.put("stageCall", stageUse.get("call"));
                        candidate.put("stageTarget", stageUse.get("target"));
                        candidate.put("stageRead", stageUse.get("read"));
                        candidate.put("stageWrite", stageUse.get("write"));
                        matches.add(Map.copyOf(candidate));
                    }
                }
            }
        }
        return matches;
    }

    private List<Map<String, Object>> stateSharedUses(PsiIndex.Node containerLambda,
            List<Map<String, Object>> facts) {
        List<Map<String, Object>> uses = new ArrayList<>();
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, containerLambda)
                    || !isProductionPath(call.fileId()) || hasAnyTaint(call, facts)) continue;
            PsiIndex.Node target = exactSourceTarget(call, facts);
            if (target == null || target.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isProductionPath(target.fileId())) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(call, target, facts);
            if (mapping == null) continue;
            List<PsiIndex.Node> parameters = targets(target, PsiIndex.EdgeRole.PARAMETER);
            for (int position = 0; position < parameters.size(); position++) {
                PsiIndex.Node parameter = parameters.get(position);
                PsiIndex.Node authorityType = sourceTypeDeclaration(
                    one(parameter, PsiIndex.EdgeRole.TYPE));
                if (authorityType == null || authorityType.kind() != PsiIndex.NodeKind.CLASS_DECL) continue;
                PsiIndex.Node argument = mappedArgument(mapping, position);
                PsiIndex.Node value = argument == null ? null
                    : one(argument, PsiIndex.EdgeRole.VALUE);
                PsiIndex.Node origin = stateSharedValueOrigin(
                    value, facts, 0, new HashMap<>());
                Map<String, PsiIndex.Node> summary = stateSharedSummary(
                    target, parameter, authorityType, facts);
                if (origin == null || summary == null) continue;
                Map<String, Object> use = new HashMap<>();
                use.put("origin", origin);
                use.put("authorityType", authorityType);
                use.put("call", call);
                use.put("target", target);
                use.put("read", summary.get("read"));
                use.put("write", summary.get("write"));
                uses.add(Map.copyOf(use));
            }
        }
        return uses;
    }

    private PsiIndex.Node stateSharedValueOrigin(PsiIndex.Node value,
            List<Map<String, Object>> facts, int depth, Map<Integer, Boolean> active) {
        if (value == null || depth >= 8 || active.put(value.id(), Boolean.TRUE) != null) return null;
        if (value.kind() == PsiIndex.NodeKind.NAME_REF && value.name() != null) {
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
            if (declaration == null) declaration = findLexicalDeclaration(value, value.name());
            if (declaration != null && declaration.kind() == PsiIndex.NodeKind.PARAMETER_DECL) {
                return declaration;
            }
            if (declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
                PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
                if (stateAuthorityDeclaration(declaration, facts) != null) return declaration;
                return initializer == null ? null : stateSharedValueOrigin(
                    initializer, facts, depth + 1, active);
            }
        }
        if (value.kind() == PsiIndex.NodeKind.QUALIFIED
                || value.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED) {
            PsiIndex.Node property = stateQualifiedAuthorityProperty(value, facts);
            if (property != null) return property;
        }
        PsiIndex.Node call = directCall(value);
        if (call != null) {
            PsiIndex.Node target = exactSourceTarget(call, facts);
            PsiIndex.Node returned = target == null ? null : sourceReturnOrigin(target);
            PsiIndex.Node origin = returned == null ? null : stateSharedValueOrigin(
                returned, facts, depth + 1, active);
            return origin == null ? call : origin;
        }
        PsiIndex.Node representative = representativeOrigin(value, facts);
        return representative != null && representative.id() != value.id()
            ? stateSharedValueOrigin(representative, facts, depth + 1, active) : value;
    }

    private Map<String, PsiIndex.Node> stateSharedSummary(PsiIndex.Node container,
            PsiIndex.Node authorityParameter, PsiIndex.Node authorityType,
            List<Map<String, Object>> facts) {
        PsiIndex.Node read = null;
        PsiIndex.Node write = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, container)
                    || hasAnyTaint(call, facts)) continue;
            PsiIndex.Node receiver = resolvedReceiver(call);
            PsiIndex.Node receiverOrigin = stateSharedValueOrigin(
                receiver, facts, 0, new HashMap<>());
            if (receiverOrigin == null || receiverOrigin.id() != authorityParameter.id()) continue;
            PsiIndex.Node method = exactSourceTarget(call, facts);
            if (method == null || method.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || stateSharedDeclarationOwner(method) != authorityType) continue;
            if (read == null && stateSharedMethodHasFact(method, authorityType, facts, "read")) {
                read = call;
            }
            if (write == null && stateSharedMethodHasFact(method, authorityType, facts, "write")) {
                write = call;
            }
        }
        return read != null && write != null ? Map.of("read", read, "write", write) : null;
    }

    private boolean stateSharedMethodHasFact(PsiIndex.Node method,
            PsiIndex.Node authorityType, List<Map<String, Object>> facts, String kind) {
        for (Map<String, Object> fact : facts) {
            if (!kind.equals(fact.get("kind"))
                    || !Long.valueOf(method.id()).equals(fact.get("ownerNodeId"))) continue;
            int subjectId = ((Long) fact.get("subjectNodeId")).intValue();
            int relatedId = ((Long) fact.get("relatedNodeId")).intValue();
            PsiIndex.Node property = stateSharedOwnedProperty(subjectId, authorityType, facts);
            if (property == null) property = stateSharedOwnedProperty(
                relatedId, authorityType, facts);
            if (property != null) return true;
        }
        return false;
    }

    private PsiIndex.Node stateSharedOwnedProperty(int nodeId,
            PsiIndex.Node authorityType, List<Map<String, Object>> facts) {
        if (nodeId < 0) return null;
        PsiIndex.Node node = program.node(nodeId);
        PsiIndex.Node declaration = node.kind() == PsiIndex.NodeKind.PROPERTY_DECL ? node
            : node.kind() == PsiIndex.NodeKind.NAME_REF
                ? relatedNodeForFact(facts, "def_use", node.id()) : null;
        if (declaration == null && node.kind() == PsiIndex.NodeKind.NAME_REF) {
            declaration = findLexicalDeclaration(node, node.name());
        }
        if (declaration == null && node.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
            PsiIndex.Node target = one(node, PsiIndex.EdgeRole.TARGET);
            if (target != null && target.kind() == PsiIndex.NodeKind.NAME_REF) {
                declaration = relatedNodeForFact(facts, "def_use", target.id());
                if (declaration == null) {
                    declaration = findLexicalDeclaration(target, target.name());
                }
            }
        }
        return declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                && stateSharedDeclarationOwner(declaration) == authorityType
            ? declaration : null;
    }

    private PsiIndex.Node stateSharedDeclarationOwner(PsiIndex.Node declaration) {
        Integer ownerId = declaration == null ? null : lexicalOwners.get(declaration.id());
        if (ownerId == null) return null;
        PsiIndex.Node owner = program.node(ownerId);
        return owner.kind() == PsiIndex.NodeKind.CLASS_DECL
                || owner.kind() == PsiIndex.NodeKind.OBJECT_DECL
            ? owner : null;
    }

    private boolean stateSharedOriginEscapes(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        for (Map<String, Object> fact : facts) {
            String kind = (String) fact.get("kind");
            String value = (String) fact.get("value");
            if (!"escape".equals(kind) && !("effect".equals(kind)
                    && ("replace".equals(value) || "unknown_escape".equals(value)))) continue;
            for (String key : List.of("subjectNodeId", "relatedNodeId")) {
                int nodeId = ((Long) fact.get(key)).intValue();
                if (nodeId < 0) continue;
                PsiIndex.Node representative = stateSharedValueOrigin(
                    program.node(nodeId), facts, 0, new HashMap<>());
                if (representative != null && representative.id() == origin.id()) return true;
            }
        }
        return false;
    }

    private boolean stateRetainedOriginAccepted(PsiIndex.Node origin,
            List<Map<String, Object>> facts) {
        if (origin == null) return false;
        if (origin.kind() == PsiIndex.NodeKind.PARAMETER_DECL) return true;
        if (origin.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                && authorityOwner(origin) != null) {
            return stateAuthorityDeclaration(origin, facts) != null;
        }
        return origin.kind() == PsiIndex.NodeKind.OBJECT_DECL;
    }

    private Rules.Analysis analyzeReopenWiring() {
        Rules.SymbolSpec window = domainSymbolOrNull(WINDOW_FQN, WINDOW_SIGNATURE);
        Rules.SymbolSpec button = domainSymbolOrNull("com.pico.spatial.ui.design.Button",
            "Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, size: ButtonSize = ButtonDefaults.Regular, colors: ButtonColors = ButtonDefaults.buttonColors(), leadingIcon: (@Composable () -> Unit)? = null, trailingIcon: (@Composable () -> Unit)? = null, contentPadding: PaddingValues = ButtonDefaults.paddingForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), shape: Shape = ButtonDefaults.shapeForButtonSize(size), gap: Dp = ButtonDefaults.gapForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), interactionSource: MutableInteractionSource = remember { MutableInteractionSource() }, content: @Composable RowScope.() -> Unit): Unit");
        Rules.SymbolSpec rememberScope = domainSymbolOrNull("androidx.compose.runtime.rememberCoroutineScope",
            "rememberCoroutineScope(getContext: () -> CoroutineContext = default): CoroutineScope");
        Rules.SymbolSpec coroutineScope = typeSymbolExact(
            "kotlinx.coroutines.CoroutineScope", "interface CoroutineScope");
        Rules.SymbolSpec coroutineLaunch = domainSymbolOrNull("kotlinx.coroutines.launch",
            "CoroutineScope.launch(context: CoroutineContext = EmptyCoroutineContext, start: CoroutineStart = CoroutineStart.DEFAULT, block: suspend CoroutineScope.() -> Unit): Job");
        Rules.SymbolSpec localNavigator = domainSymbolOrNull(
            LOCAL_NAVIGATOR_FQN, LOCAL_NAVIGATOR_SIGNATURE);
        Rules.SymbolSpec current = domainSymbolOrNull(CURRENT_FQN, CURRENT_SIGNATURE);
        Rules.SymbolSpec navigatorType = typeSymbolExact(
            NAVIGATOR_TYPE_FQN, NAVIGATOR_TYPE_SIGNATURE);
        Rules.SymbolSpec closeStage = domainSymbolOrNull(
            "com.pico.spatial.ui.platform.containers.SpatialNavigator.closeStage", "closeStage(): Unit");
        Rules.SymbolSpec openStage = domainSymbolOrNull(OPEN_STAGE_FQN, OPEN_STAGE_SIGNATURE);
        Rules.SymbolSpec putString = domainSymbolOrNull(
            "android.os.BaseBundle.putString", "putString(key: String, value: String?): Unit");
        Rules.SymbolSpec putInt = domainSymbolOrNull(
            "android.os.BaseBundle.putInt", "putInt(key: String, value: Int): Unit");
        Rules.SymbolSpec putBoolean = domainSymbolOrNull(
            "android.os.BaseBundle.putBoolean", "putBoolean(key: String, value: Boolean): Unit");
        if (window == null || button == null || rememberScope == null || coroutineScope == null
                || coroutineLaunch == null || localNavigator == null || current == null
                || navigatorType == null || closeStage == null || openStage == null
                || putString == null || putInt == null || putBoolean == null
                || !stateReopenButtonShape(button) || coroutineLaunch.callbacks().size() != 1
                || coroutineLaunch.callbacks().get(0).argumentPosition() != 2
                || !"coroutine_body".equals(coroutineLaunch.callbacks().get(0).role())
                || !"launched_path".equals(coroutineLaunch.callbacks().get(0).invocationModel())
                || !"coroutine_scope".equals(
                    coroutineLaunch.callbacks().get(0).receiverAbstractType())) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        List<Map<String, Object>> matches = stateReopenMatches(facts, window, button,
            rememberScope, coroutineScope, coroutineLaunch, localNavigator, current,
            navigatorType, closeStage, openStage, putString, putInt, putBoolean);
        if (matches.size() != 1) return Rules.emptyAnalysis();
        Map<String, Object> match = matches.get(0);
        String proofForm = "retained-state-close-reopen";
        String alternative = (String) match.get("alternative");
        Map<String, String> selected = Rules.selectProof(domain, "state.reopen-wiring",
            Map.of(proofForm, Boolean.TRUE), Map.of(proofForm, List.of(alternative)));
        if (!proofForm.equals(selected.get("proofForm"))
                || !alternative.equals(selected.get("alternativeId"))) {
            return Rules.emptyAnalysis();
        }
        List<String> witnesses = new ArrayList<>();
        boolean valid = addWitness((PsiIndex.Node) match.get("windowContainer"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowCall"), witnesses)
            && addWitness((PsiIndex.Node) match.get("windowTarget"), witnesses)
            && addWitness((PsiIndex.Node) match.get("button"), witnesses)
            && addWitness((PsiIndex.Node) match.get("clickLambda"), witnesses)
            && addWitness((PsiIndex.Node) match.get("scopeProperty"), witnesses)
            && addWitness((PsiIndex.Node) match.get("scopeProducer"), witnesses)
            && addWitness((PsiIndex.Node) match.get("launch"), witnesses)
            && addWitness((PsiIndex.Node) match.get("launchLambda"), witnesses)
            && addWitness((PsiIndex.Node) match.get("helperCall"), witnesses)
            && addWitness((PsiIndex.Node) match.get("helper"), witnesses)
            && addWitness((PsiIndex.Node) match.get("close"), witnesses);
        if (valid && Boolean.TRUE.equals(match.get("callbackOnly"))) {
            valid = addWitness((PsiIndex.Node) match.get("reopenCall"), witnesses)
                && addWitness((PsiIndex.Node) match.get("reopenTarget"), witnesses)
                && addWitness((PsiIndex.Node) match.get("seam"), witnesses)
                && addWitness((PsiIndex.Node) match.get("handoff"), witnesses)
                && addWitness((PsiIndex.Node) match.get("handoffLocal"), witnesses)
                && addWitness((PsiIndex.Node) match.get("callbackRestore"), witnesses);
            PsiIndex.Node bundleCall = (PsiIndex.Node) match.get("bundleCall");
            if (valid && bundleCall != null) valid = addWitness(bundleCall, witnesses);
            for (PsiIndex.Node bundleWitness : stateTypedNodeList(match, "bundleWitnesses")) {
                if (valid) valid = addWitness(bundleWitness, witnesses);
            }
            if (valid) valid = addWitness((PsiIndex.Node) match.get("openCall"), witnesses);
        } else if (valid) {
            valid = addWitness((PsiIndex.Node) match.get("selectionRead"), witnesses)
                && addWitness((PsiIndex.Node) match.get("intRead"), witnesses)
                && addWitness((PsiIndex.Node) match.get("booleanRead"), witnesses)
                && addWitness((PsiIndex.Node) match.get("restore"), witnesses)
                && addWitness((PsiIndex.Node) match.get("restoreConstructor"), witnesses)
                && addWitness((PsiIndex.Node) match.get("reopenCall"), witnesses)
                && addWitness((PsiIndex.Node) match.get("reopenTarget"), witnesses)
                && addWitness((PsiIndex.Node) match.get("seam"), witnesses)
                && addWitness((PsiIndex.Node) match.get("handoff"), witnesses)
                && addWitness((PsiIndex.Node) match.get("openCall"), witnesses);
        }
        if (!valid) return Rules.emptyAnalysis();
        Rules.Analysis claim = Rules.claimOrNull(program, domain, "state.reopen-wiring",
            proofForm, alternative, witnesses);
        if (claim == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("state.reopen-wiring", alternative);
        return claim;
    }

    private boolean stateReopenButtonShape(Rules.SymbolSpec button) {
        if (button == null || button.callbacks().size() != 2) return false;
        Rules.CallbackSpec click = button.callbacks().get(0);
        Rules.CallbackSpec content = button.callbacks().get(1);
        return click.argumentPosition() == 0 && click.role().equals("button_click")
            && click.invocationModel().equals("user_action")
            && click.receiverAbstractType() == null && click.receiverSource() == null
            && click.parameters().isEmpty()
            && content.argumentPosition() == 11 && content.role().equals("window_content")
            && content.invocationModel().equals("possible_path")
            && "row_scope".equals(content.receiverAbstractType())
            && content.receiverSource() == null && content.parameters().isEmpty();
    }

    private List<Map<String, Object>> stateReopenMatches(List<Map<String, Object>> facts,
            Rules.SymbolSpec window, Rules.SymbolSpec button, Rules.SymbolSpec rememberScope,
            Rules.SymbolSpec coroutineScope, Rules.SymbolSpec coroutineLaunch,
            Rules.SymbolSpec localNavigator, Rules.SymbolSpec current,
            Rules.SymbolSpec navigatorType, Rules.SymbolSpec closeStage,
            Rules.SymbolSpec openStage, Rules.SymbolSpec putString,
            Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        List<Map<String, Object>> matches = new ArrayList<>();
        for (PsiIndex.Node windowContainer : program.nodes()) {
            if (windowContainer.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(windowContainer.fileId())
                    || !exactDomainResolution(windowContainer, window, facts)) continue;
            PsiIndex.Node windowLambda = mappedLambda(
                mapDomainArguments(windowContainer, window, facts), 0);
            if (windowLambda == null) continue;
            for (PsiIndex.Node windowCall : program.nodes()) {
                if (windowCall.kind() != PsiIndex.NodeKind.CALL || !isWithin(windowCall, windowLambda)
                        || hasAnyTaint(windowCall, facts)) continue;
                PsiIndex.Node windowTarget = exactSourceTarget(windowCall, facts);
                if (windowTarget == null || windowTarget.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                        || !isProductionPath(windowTarget.fileId())) continue;
                Map<Integer, List<PsiIndex.Node>> windowMap = mapSourceArguments(
                    windowCall, windowTarget, facts);
                if (windowMap == null) continue;
                List<PsiIndex.Node> windowParameters = targets(
                    windowTarget, PsiIndex.EdgeRole.PARAMETER);
                for (int position = 0; position < windowParameters.size(); position++) {
                    PsiIndex.Node windowParameter = windowParameters.get(position);
                    PsiIndex.Node authorityType = sourceTypeDeclaration(
                        one(windowParameter, PsiIndex.EdgeRole.TYPE));
                    if (authorityType == null || authorityType.kind() != PsiIndex.NodeKind.CLASS_DECL) continue;
                    PsiIndex.Node argument = mappedArgument(windowMap, position);
                    PsiIndex.Node rootOrigin = argument == null ? null : stateSharedValueOrigin(
                        one(argument, PsiIndex.EdgeRole.VALUE), facts, 0, new HashMap<>());
                    if (rootOrigin == null || !stateRetainedOriginAccepted(rootOrigin, facts)
                            || stateSharedOriginEscapes(rootOrigin, facts)) continue;
                    List<Map<String, Object>> paths = stateReopenButtonPaths(windowTarget,
                        windowParameter, rootOrigin, authorityType, facts, button, rememberScope,
                        coroutineScope, coroutineLaunch, localNavigator, current, navigatorType,
                        closeStage, openStage, putString, putInt, putBoolean);
                    for (Map<String, Object> path : paths) {
                        Map<String, Object> match = new HashMap<>(path);
                        match.put("windowContainer", windowContainer);
                        match.put("windowCall", windowCall);
                        match.put("windowTarget", windowTarget);
                        matches.add(Map.copyOf(match));
                    }
                }
            }
        }
        return matches;
    }

    private List<Map<String, Object>> stateReopenButtonPaths(PsiIndex.Node windowTarget,
            PsiIndex.Node windowParameter, PsiIndex.Node rootOrigin,
            PsiIndex.Node authorityType, List<Map<String, Object>> facts,
            Rules.SymbolSpec button, Rules.SymbolSpec rememberScope,
            Rules.SymbolSpec coroutineScope, Rules.SymbolSpec coroutineLaunch,
            Rules.SymbolSpec localNavigator, Rules.SymbolSpec current,
            Rules.SymbolSpec navigatorType, Rules.SymbolSpec closeStage,
            Rules.SymbolSpec openStage, Rules.SymbolSpec putString,
            Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        List<Map<String, Object>> matches = new ArrayList<>();
        for (PsiIndex.Node buttonCall : program.nodes()) {
            if (buttonCall.kind() != PsiIndex.NodeKind.CALL || !isWithin(buttonCall, windowTarget)) continue;
            Map<Integer, List<PsiIndex.Node>> buttonMap = reviewedDomainMapping(
                buttonCall, button, facts);
            PsiIndex.Node clickArgument = mappedArgument(buttonMap, 0);
            PsiIndex.Node clickLambda = mappedLambda(buttonMap, 0);
            if (clickLambda == null || !exactFact(facts, "callback_binding", clickLambda,
                    buttonCall, clickArgument, "button_click", button)) continue;
            for (PsiIndex.Node launchCall : program.nodes()) {
                if (launchCall.kind() != PsiIndex.NodeKind.CALL || !isWithin(launchCall, clickLambda)) continue;
                Map<Integer, List<PsiIndex.Node>> launchMap = reviewedDomainMapping(
                    launchCall, coroutineLaunch, facts);
                PsiIndex.Node launchArgument = mappedArgument(launchMap, 2);
                PsiIndex.Node launchLambda = mappedLambda(launchMap, 2);
                Map<String, PsiIndex.Node> scope = stateReopenScope(
                    resolvedReceiver(launchCall), facts, rememberScope, coroutineScope);
                if (launchLambda == null || scope == null
                        || !exactFact(facts, "callback_binding", launchLambda, launchCall,
                            launchArgument, "coroutine_body", coroutineLaunch)) continue;
                for (PsiIndex.Node helperCall : program.nodes()) {
                    if (helperCall.kind() != PsiIndex.NodeKind.CALL
                            || !isWithin(helperCall, launchLambda) || hasAnyTaint(helperCall, facts)) continue;
                    PsiIndex.Node helper = exactSourceTarget(helperCall, facts);
                    if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                            || !helper.flags().contains(PsiIndex.NodeFlag.SUSPEND)
                            || !isProductionPath(helper.fileId())) continue;
                    PsiIndex.Node extensionType = declarationTypeNode(helper, true);
                    if (typeSymbolForReference(extensionType) != navigatorType
                            || stateReopenNavigator(resolvedReceiver(helperCall), facts,
                                localNavigator, current, navigatorType) == null) continue;
                    Map<Integer, List<PsiIndex.Node>> helperMap = mapSourceArguments(
                        helperCall, helper, facts);
                    if (helperMap == null) continue;
                    List<PsiIndex.Node> helperParameters = targets(helper, PsiIndex.EdgeRole.PARAMETER);
                    for (int helperPosition = 0; helperPosition < helperParameters.size(); helperPosition++) {
                        PsiIndex.Node helperParameter = helperParameters.get(helperPosition);
                        if (sourceTypeDeclaration(one(helperParameter, PsiIndex.EdgeRole.TYPE))
                                != authorityType) continue;
                        PsiIndex.Node mapped = mappedArgument(helperMap, helperPosition);
                        PsiIndex.Node mappedOrigin = mapped == null ? null : stateSharedValueOrigin(
                            one(mapped, PsiIndex.EdgeRole.VALUE), facts, 0, new HashMap<>());
                        if (mappedOrigin == null || mappedOrigin.id() != windowParameter.id()) continue;
                        Map<String, Object> analysis = stateReopenHelper(helper, helperParameter,
                            rootOrigin, authorityType, facts, closeStage, openStage,
                            navigatorType, putString, putInt, putBoolean);
                        if (analysis == null) continue;
                        Map<String, Object> match = new HashMap<>(analysis);
                        match.put("button", buttonCall);
                        match.put("clickLambda", clickLambda);
                        match.put("scopeProperty", scope.get("property"));
                        match.put("scopeProducer", scope.get("producer"));
                        match.put("launch", launchCall);
                        match.put("launchLambda", launchLambda);
                        match.put("helperCall", helperCall);
                        match.put("helper", helper);
                        matches.add(Map.copyOf(match));
                    }
                }
            }
        }
        return matches;
    }

    private Map<String, PsiIndex.Node> stateReopenScope(PsiIndex.Node receiver,
            List<Map<String, Object>> facts, Rules.SymbolSpec rememberScope,
            Rules.SymbolSpec coroutineScope) {
        if (receiver == null || receiver.kind() != PsiIndex.NodeKind.NAME_REF) return null;
        PsiIndex.Node property = relatedNodeForFact(facts, "def_use", receiver.id());
        if (property == null || property.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !property.flags().contains(PsiIndex.NodeFlag.VAL)
                || property.flags().contains(PsiIndex.NodeFlag.VAR)) return null;
        PsiIndex.Node producer = one(property, PsiIndex.EdgeRole.INITIALIZER);
        PsiIndex.Node call = directCall(producer);
        if (call == null && producer != null && producer.kind() == PsiIndex.NodeKind.CALL) call = producer;
        if (call == null || !exactDomainResolution(call, rememberScope, facts)
                || !exactFact(facts, "type", property, enclosingCallable(property), null,
                    "coroutine_scope", coroutineScope)) return null;
        return Map.of("property", property, "producer", call);
    }

    private PsiIndex.Node stateReopenNavigator(PsiIndex.Node receiver,
            List<Map<String, Object>> facts, Rules.SymbolSpec localNavigator,
            Rules.SymbolSpec current, Rules.SymbolSpec navigatorType) {
        if (receiver == null || receiver.kind() != PsiIndex.NodeKind.NAME_REF) return null;
        PsiIndex.Node property = relatedNodeForFact(facts, "def_use", receiver.id());
        if (property == null || property.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !property.flags().contains(PsiIndex.NodeFlag.VAL)
                || property.flags().contains(PsiIndex.NodeFlag.VAR)
                || !exactFact(facts, "type", property, enclosingCallable(property), null,
                    "spatial_navigator", navigatorType)) return null;
        PsiIndex.Node initializer = one(property, PsiIndex.EdgeRole.INITIALIZER);
        if (initializer == null || initializer.kind() != PsiIndex.NodeKind.QUALIFIED) return null;
        PsiIndex.Node source = one(initializer, PsiIndex.EdgeRole.RECEIVER);
        return source != null && exactDomainResolution(source, localNavigator, facts)
                && exactQualifiedResult(initializer, current, "spatial_navigator", facts)
            ? property : null;
    }

    private Map<String, Object> stateReopenHelper(PsiIndex.Node helper,
            PsiIndex.Node authorityParameter, PsiIndex.Node rootOrigin,
            PsiIndex.Node authorityType, List<Map<String, Object>> facts,
            Rules.SymbolSpec closeStage, Rules.SymbolSpec openStage,
            Rules.SymbolSpec navigatorType, Rules.SymbolSpec putString,
            Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        List<PsiIndex.Node> closes = stateTypedDomainCallsWithin(helper, closeStage, facts);
        if (closes.size() != 1) return null;
        PsiIndex.Node close = closes.get(0);
        Map<String, Object> reads = stateReopenRetainedReads(
            helper, authorityParameter, rootOrigin, authorityType, facts);
        if (reads != null) {
            PsiIndex.Node snapshot = (PsiIndex.Node) reads.get("snapshot");
            Map<String, PsiIndex.Node> fields = stateReopenSnapshotFields(snapshot);
            Map<String, Object> restore = stateReopenRestore(helper, authorityParameter,
                rootOrigin, authorityType, snapshot, fields, reads, facts);
            PsiIndex.Node restoreCall = restore == null
                ? null : (PsiIndex.Node) restore.get("restore");
            Map<String, Object> reopen = restoreCall == null ? null : stateReopenFinalCall(
                helper, authorityParameter, rootOrigin, authorityType, snapshot, fields,
                restoreCall, facts, openStage, navigatorType,
                putString, putInt, putBoolean);
            if (reopen != null
                    && close.startUtf16() < ((PsiIndex.Node) reads.get("firstRead")).startUtf16()
                    && ((PsiIndex.Node) reads.get("lastRead")).startUtf16()
                        < restoreCall.startUtf16()
                    && restoreCall.startUtf16()
                        < ((PsiIndex.Node) reopen.get("reopenCall")).startUtf16()) {
                Map<String, Object> result = new HashMap<>(reads);
                result.remove("firstRead");
                result.remove("lastRead");
                result.putAll(restore);
                result.putAll(reopen);
                result.put("close", close);
                return Map.copyOf(result);
            }
        }
        Map<String, Object> reopen = stateReopenCallbackOnlyFinalCall(helper,
            authorityParameter, rootOrigin, authorityType, close, facts,
            openStage, navigatorType, putString, putInt, putBoolean);
        if (reopen == null) return null;
        Map<String, Object> result = new HashMap<>(reopen);
        result.put("close", close);
        return Map.copyOf(result);
    }

    private Map<String, Object> stateReopenCallbackOnlyFinalCall(PsiIndex.Node helper,
            PsiIndex.Node authorityParameter, PsiIndex.Node rootOrigin,
            PsiIndex.Node authorityType, PsiIndex.Node close,
            List<Map<String, Object>> facts, Rules.SymbolSpec openStage,
            Rules.SymbolSpec navigatorType, Rules.SymbolSpec putString,
            Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        Map<String, Object> match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, helper)
                    || call.startUtf16() <= close.startUtf16() || hasAnyTaint(call, facts)) continue;
            PsiIndex.Node target = stateReopenExtensionTarget(
                call, helper, navigatorType, facts);
            if (target == null || target.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || stateSharedDeclarationOwner(target) == authorityType
                    || typeSymbolForReference(declarationTypeNode(target, true)) != navigatorType) {
                continue;
            }
            PsiIndex.Node openCall = stateReopenUniqueOpenStage(target, openStage, facts);
            if (openCall == null) continue;
            Map<String, Object> equivalent = stateReopenEquivalent(call, target,
                authorityParameter, rootOrigin, authorityType, null, null, facts,
                openCall, putString, putInt, putBoolean);
            if (equivalent == null || match != null) return null;
            Map<String, Object> candidate = new HashMap<>(equivalent);
            candidate.put("callbackOnly", Boolean.TRUE);
            match = Map.copyOf(candidate);
        }
        return match;
    }

    private Map<String, PsiIndex.Node> stateReopenSnapshotFields(PsiIndex.Node snapshot) {
        if (snapshot == null || snapshot.kind() != PsiIndex.NodeKind.CLASS_DECL
                || !isProductionPath(snapshot.fileId())) return null;
        List<PsiIndex.Node> parameters = targets(snapshot, PsiIndex.EdgeRole.PARAMETER);
        if (parameters.size() != 3) return null;
        Map<String, PsiIndex.Node> fields = new HashMap<>();
        for (PsiIndex.Node parameter : parameters) {
            if (!parameter.flags().contains(PsiIndex.NodeFlag.VAL)
                    || parameter.flags().contains(PsiIndex.NodeFlag.VAR)) return null;
            PsiIndex.Node type = one(parameter, PsiIndex.EdgeRole.TYPE);
            String primitive = primitiveType(type);
            boolean nullable = isExplicitNullableTarget(parameter, type);
            String key;
            if ("int".equals(primitive) && !nullable) key = "int";
            else if ("boolean".equals(primitive) && !nullable) key = "boolean";
            else if (nullable && ("string".equals(primitive)
                    || primitive == null && sourceTypeDeclaration(type) != null)) key = "selection";
            else return null;
            if (fields.put(key, parameter) != null) return null;
        }
        return fields.size() == 3 ? Map.copyOf(fields) : null;
    }

    private Map<String, Object> stateReopenRetainedReads(PsiIndex.Node helper,
            PsiIndex.Node authorityParameter, PsiIndex.Node rootOrigin,
            PsiIndex.Node authorityType, List<Map<String, Object>> facts) {
        Map<String, Object> result = new HashMap<>();
        PsiIndex.Node snapshot = null;
        PsiIndex.Node first = null;
        PsiIndex.Node last = null;
        for (PsiIndex.Node local : program.nodes()) {
            if (local.kind() != PsiIndex.NodeKind.PROPERTY_DECL || !isWithin(local, helper)
                    || !local.flags().contains(PsiIndex.NodeFlag.VAL)) continue;
            PsiIndex.Node initializer = one(local, PsiIndex.EdgeRole.INITIALIZER);
            if (initializer == null) continue;
            for (PsiIndex.Node readCall : program.nodes()) {
                if (readCall.kind() != PsiIndex.NodeKind.CALL
                        || readCall.id() != initializer.id() && !isWithin(readCall, initializer)) continue;
                PsiIndex.Node method = exactSourceTarget(readCall, facts);
                if (method == null || method.kind() != PsiIndex.NodeKind.FUNCTION_DECL) continue;
                if (stateSharedDeclarationOwner(method) != authorityType) continue;
                if (!stateReopenReceiverMatches(resolvedReceiver(readCall),
                        authorityParameter, rootOrigin, facts)) continue;
                if (!stateSharedMethodHasFact(method, authorityType, facts, "read")) continue;
                PsiIndex.Node candidateSnapshot = sourceTypeDeclaration(
                    one(method, PsiIndex.EdgeRole.TYPE));
                Map<String, PsiIndex.Node> fields = stateReopenSnapshotFields(candidateSnapshot);
                String key = stateReopenFieldKey(initializer, candidateSnapshot, fields, facts);
                if (key == null || result.containsKey(key + "Read")
                        || snapshot != null && snapshot.id() != candidateSnapshot.id()) return null;
                snapshot = candidateSnapshot;
                result.put(key + "Read", readCall);
                result.put(key + "Local", local);
                if (first == null || readCall.startUtf16() < first.startUtf16()) first = readCall;
                if (last == null || readCall.startUtf16() > last.startUtf16()) last = readCall;
            }
        }
        if (snapshot == null || !result.containsKey("selectionRead")
                || !result.containsKey("intRead") || !result.containsKey("booleanRead")) return null;
        result.put("snapshot", snapshot);
        result.put("firstRead", first);
        result.put("lastRead", last);
        return Map.copyOf(result);
    }

    private String stateReopenFieldKey(PsiIndex.Node value, PsiIndex.Node snapshot,
            Map<String, PsiIndex.Node> fields, List<Map<String, Object>> facts) {
        if (value == null || snapshot == null || fields == null) return null;
        String match = null;
        for (String key : List.of("selection", "int", "boolean")) {
            if (!stateTypedFieldReferenced(value, fields.get(key), snapshot, facts)) continue;
            if (match != null) return null;
            match = key;
        }
        return match;
    }

    private boolean stateReopenReceiverMatches(PsiIndex.Node receiver,
            PsiIndex.Node authorityParameter, PsiIndex.Node rootOrigin,
            List<Map<String, Object>> facts) {
        PsiIndex.Node origin = stateSharedValueOrigin(receiver, facts, 0, new HashMap<>());
        return origin != null && (origin.id() == authorityParameter.id()
            || origin.id() == rootOrigin.id());
    }

    private Map<String, Object> stateReopenRestore(PsiIndex.Node helper,
            PsiIndex.Node authorityParameter, PsiIndex.Node rootOrigin,
            PsiIndex.Node authorityType, PsiIndex.Node snapshot,
            Map<String, PsiIndex.Node> fields, Map<String, Object> reads,
            List<Map<String, Object>> facts) {
        Map<String, Object> match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, helper)) continue;
            PsiIndex.Node method = exactSourceTarget(call, facts);
            if (method == null || method.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || stateSharedDeclarationOwner(method) != authorityType
                    || !stateReopenReceiverMatches(resolvedReceiver(call),
                        authorityParameter, rootOrigin, facts)
                    || !stateSharedMethodHasFact(method, authorityType, facts, "write")) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(call, method, facts);
            if (mapping == null) continue;
            PsiIndex.Node constructor = null;
            for (Map.Entry<Integer, List<PsiIndex.Node>> entry : mapping.entrySet()) {
                PsiIndex.Node argument = mappedArgument(mapping, entry.getKey());
                PsiIndex.Node value = argument == null ? null : one(argument, PsiIndex.EdgeRole.VALUE);
                PsiIndex.Node candidate = directCall(value);
                if (candidate != null && exactSourceTarget(candidate, facts) == snapshot) {
                    if (constructor != null) constructor = null;
                    else constructor = candidate;
                }
            }
            if (constructor == null || !stateReopenConstructorUses(
                    constructor, snapshot, fields, reads, facts)) continue;
            if (match != null) return null;
            match = Map.of("restore", call, "restoreConstructor", constructor);
        }
        return match;
    }

    private boolean stateReopenConstructorUses(PsiIndex.Node constructor,
            PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            Map<String, Object> reads, List<Map<String, Object>> facts) {
        Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(
            constructor, snapshot, facts);
        List<PsiIndex.Node> parameters = targets(snapshot, PsiIndex.EdgeRole.PARAMETER);
        if (mapping == null || mapping.size() != parameters.size()) return false;
        for (int position = 0; position < parameters.size(); position++) {
            PsiIndex.Node field = parameters.get(position);
            String key = field.id() == fields.get("selection").id() ? "selection"
                : field.id() == fields.get("int").id() ? "int" : "boolean";
            PsiIndex.Node argument = mappedArgument(mapping, position);
            PsiIndex.Node value = argument == null ? null : one(argument, PsiIndex.EdgeRole.VALUE);
            if (!stateReopenRefersTo(value, (PsiIndex.Node) reads.get(key + "Local"), facts)) {
                return false;
            }
        }
        return true;
    }

    private boolean stateReopenRefersTo(PsiIndex.Node value, PsiIndex.Node declaration,
            List<Map<String, Object>> facts) {
        if (value == null || declaration == null) return false;
        int count = 0;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.NAME_REF
                    || node.id() != value.id() && !isWithin(node, value)) continue;
            if (relatedNodeForFact(facts, "def_use", node.id()) == declaration) count++;
        }
        return count == 1;
    }

    private Map<String, Object> stateReopenFinalCall(PsiIndex.Node helper,
            PsiIndex.Node authorityParameter, PsiIndex.Node rootOrigin,
            PsiIndex.Node authorityType, PsiIndex.Node snapshot,
            Map<String, PsiIndex.Node> fields, PsiIndex.Node restore,
            List<Map<String, Object>> facts, Rules.SymbolSpec openStage,
            Rules.SymbolSpec navigatorType, Rules.SymbolSpec putString,
            Rules.SymbolSpec putInt, Rules.SymbolSpec putBoolean) {
        Map<String, Object> match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, helper)
                    || call.startUtf16() <= restore.startUtf16() || hasAnyTaint(call, facts)) continue;
            PsiIndex.Node target = stateReopenExtensionTarget(
                call, helper, navigatorType, facts);
            if (target == null || target.kind() != PsiIndex.NodeKind.FUNCTION_DECL) continue;
            if (stateSharedDeclarationOwner(target) == authorityType) continue;
            if (typeSymbolForReference(declarationTypeNode(target, true)) != navigatorType) continue;
            if (stateReopenAuthorityWriteBetween(helper, authorityParameter, rootOrigin,
                    authorityType, restore, call, facts)) continue;
            PsiIndex.Node openCall = stateReopenUniqueOpenStage(target, openStage, facts);
            if (openCall == null) continue;
            Map<String, Object> standard = stateReopenStandard(call, target, authorityParameter,
                rootOrigin, authorityType, snapshot, facts, openCall);
            Map<String, Object> equivalent = standard == null ? stateReopenEquivalent(call, target,
                authorityParameter, rootOrigin, authorityType, snapshot, fields, facts,
                openCall, putString, putInt, putBoolean) : null;
            Map<String, Object> candidate = standard == null ? equivalent : standard;
            if (candidate == null || match != null) return null;
            match = candidate;
        }
        return match;
    }

    private boolean stateReopenAuthorityWriteBetween(PsiIndex.Node helper,
            PsiIndex.Node authorityParameter, PsiIndex.Node rootOrigin,
            PsiIndex.Node authorityType, PsiIndex.Node restore,
            PsiIndex.Node reopen, List<Map<String, Object>> facts) {
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL
                    || enclosingCallable(call) != helper
                    || call.startUtf16() <= restore.startUtf16()
                    || call.startUtf16() >= reopen.startUtf16()) continue;
            PsiIndex.Node method = exactSourceTarget(call, facts);
            if (method == null || method.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || stateSharedDeclarationOwner(method) != authorityType
                    || !stateReopenReceiverMatches(resolvedReceiver(call),
                        authorityParameter, rootOrigin, facts)
                    || !stateSharedMethodHasFact(
                        method, authorityType, facts, "write")) continue;
            return true;
        }
        return false;
    }

    private PsiIndex.Node stateReopenExtensionTarget(PsiIndex.Node call,
            PsiIndex.Node context, Rules.SymbolSpec navigatorType,
            List<Map<String, Object>> facts) {
        PsiIndex.Node exact = exactSourceTarget(call, facts);
        if (exact != null) return exact;
        if (call == null || context == null || navigatorType == null
                || hasFact(facts, "call_resolution", call.id()) || hasAnyTaint(call, facts)
                || resolvedReceiver(call) != null || enclosingCallable(call) != context
                || typeSymbolForReference(declarationTypeNode(context, true)) != navigatorType) {
            return null;
        }
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : sourceCallableCandidates(call, facts)) {
            if (candidate.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isTopLevel(candidate) || !isProductionPath(candidate.fileId())
                    || typeSymbolForReference(declarationTypeNode(candidate, true)) != navigatorType
                    || mapSourceArguments(call, candidate, facts) == null) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private PsiIndex.Node stateReopenUniqueOpenStage(PsiIndex.Node target,
            Rules.SymbolSpec openStage, List<Map<String, Object>> facts) {
        List<PsiIndex.Node> calls = stateTypedDomainCallsWithin(target, openStage, facts);
        return calls.size() == 1 ? calls.get(0) : null;
    }

    private Map<String, Object> stateReopenStandard(PsiIndex.Node reopenCall,
            PsiIndex.Node target, PsiIndex.Node authorityParameter,
            PsiIndex.Node rootOrigin, PsiIndex.Node authorityType,
            PsiIndex.Node snapshot, List<Map<String, Object>> facts,
            PsiIndex.Node openCall) {
        List<PsiIndex.Node> parameters = targets(target, PsiIndex.EdgeRole.PARAMETER);
        PsiIndex.Node booleanParameter = null;
        PsiIndex.Node targetAuthority = null;
        PsiIndex.Node targetSnapshot = null;
        int booleanCount = 0;
        int authorityCount = 0;
        int snapshotCount = 0;
        for (PsiIndex.Node parameter : parameters) {
            PsiIndex.Node type = one(parameter, PsiIndex.EdgeRole.TYPE);
            if ("boolean".equals(primitiveType(type))) {
                booleanCount++;
                booleanParameter = parameter;
            } else if (sourceTypeDeclaration(type) == authorityType) {
                authorityCount++;
                targetAuthority = parameter;
            } else if (sourceTypeDeclaration(type) == snapshot) {
                snapshotCount++;
                targetSnapshot = parameter;
            }
        }
        if (booleanCount != 1 || authorityCount != 1 || snapshotCount != 1) return null;
        Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(reopenCall, target, facts);
        int booleanPosition = parameters.indexOf(booleanParameter);
        int authorityPosition = parameters.indexOf(targetAuthority);
        PsiIndex.Node booleanArgument = mappedArgument(mapping, booleanPosition);
        PsiIndex.Node authorityArgument = mappedArgument(mapping, authorityPosition);
        PsiIndex.Node authorityOrigin = authorityArgument == null ? null : stateSharedValueOrigin(
            one(authorityArgument, PsiIndex.EdgeRole.VALUE), facts, 0, new HashMap<>());
        if (!Boolean.TRUE.equals(stateReopenBoolean(booleanArgument == null ? null
                : one(booleanArgument, PsiIndex.EdgeRole.VALUE)))
                || authorityOrigin == null || authorityOrigin.id() != authorityParameter.id()) return null;
        PsiIndex.Node handoff = null;
        for (PsiIndex.Node branch : program.nodes()) {
            if (branch.kind() != PsiIndex.NodeKind.IF || !isWithin(branch, target)) continue;
            PsiIndex.Node condition = one(branch, PsiIndex.EdgeRole.CONDITION);
            PsiIndex.Node thenBranch = one(branch, PsiIndex.EdgeRole.THEN_BRANCH);
            PsiIndex.Node elseBranch = one(branch, PsiIndex.EdgeRole.ELSE_BRANCH);
            if (!stateReopenRefersTo(condition, booleanParameter, facts)) continue;
            if (!stateReopenBranchReadsAuthority(thenBranch, targetAuthority,
                    authorityType, snapshot, facts)) continue;
            if (!stateReopenRefersTo(elseBranch, targetSnapshot, facts)) continue;
            if (handoff != null) return null;
            handoff = branch;
        }
        if (handoff == null) return null;
        PsiIndex.Node handoffLocal = stateReopenLocalInitializedBy(handoff, target);
        if (handoffLocal == null) return null;
        return Map.of(
            "alternative", "standard-store-reopen",
            "reopenCall", reopenCall,
            "reopenTarget", target,
            "seam", booleanArgument,
            "handoff", handoffLocal,
            "openCall", openCall);
    }

    private Boolean stateReopenBoolean(PsiIndex.Node value) {
        if (value == null || value.kind() != PsiIndex.NodeKind.LITERAL) return null;
        Boolean result = null;
        for (int index = value.firstTokenId(); index < value.firstTokenId() + value.tokenCount(); index++) {
            PsiIndex.Token token = program.tokens().get(index);
            if (token.kind() != PsiIndex.TokenKind.BOOLEAN_LITERAL) continue;
            if (result != null) return null;
            result = Boolean.valueOf(token.value());
        }
        return result;
    }

    private boolean stateReopenBranchReadsAuthority(PsiIndex.Node branch,
            PsiIndex.Node authorityParameter, PsiIndex.Node authorityType,
            PsiIndex.Node snapshot, List<Map<String, Object>> facts) {
        if (branch == null) return false;
        int count = 0;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL
                    || call.id() != branch.id() && !isWithin(call, branch)) continue;
            PsiIndex.Node method = exactSourceTarget(call, facts);
            if (method == null || stateSharedDeclarationOwner(method) != authorityType
                    || sourceTypeDeclaration(one(method, PsiIndex.EdgeRole.TYPE)) != snapshot) continue;
            PsiIndex.Node origin = stateSharedValueOrigin(
                resolvedReceiver(call), facts, 0, new HashMap<>());
            if (origin != null && origin.id() == authorityParameter.id()) count++;
        }
        return count == 1;
    }

    private Map<String, Object> stateReopenEquivalent(PsiIndex.Node reopenCall,
            PsiIndex.Node target, PsiIndex.Node authorityParameter,
            PsiIndex.Node rootOrigin, PsiIndex.Node authorityType,
            PsiIndex.Node snapshot, Map<String, PsiIndex.Node> fields,
            List<Map<String, Object>> facts, PsiIndex.Node openCall,
            Rules.SymbolSpec putString, Rules.SymbolSpec putInt,
            Rules.SymbolSpec putBoolean) {
        List<PsiIndex.Node> parameters = targets(target, PsiIndex.EdgeRole.PARAMETER);
        PsiIndex.Node callbackParameter = null;
        PsiIndex.Node targetAuthority = null;
        int callbackCount = 0;
        int authorityCount = 0;
        for (PsiIndex.Node parameter : parameters) {
            PsiIndex.Node type = one(parameter, PsiIndex.EdgeRole.TYPE);
            if ("callable".equals(primitiveType(type))) {
                callbackCount++;
                callbackParameter = parameter;
            } else if (sourceTypeDeclaration(type) == authorityType) {
                authorityCount++;
                targetAuthority = parameter;
            }
        }
        if (callbackCount != 1 || authorityCount != 1) return null;
        Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(reopenCall, target, facts);
        if (mapping == null) return null;
        PsiIndex.Node callbackArgument = mappedArgument(mapping, parameters.indexOf(callbackParameter));
        PsiIndex.Node authorityArgument = mappedArgument(mapping, parameters.indexOf(targetAuthority));
        PsiIndex.Node reference = callbackArgument == null ? null
            : one(callbackArgument, PsiIndex.EdgeRole.VALUE);
        PsiIndex.Node boundReceiver = reference == null ? null
            : one(reference, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node referenced = reference == null ? null : uniqueReferencedCallable(reference);
        PsiIndex.Node authorityOrigin = authorityArgument == null ? null : stateSharedValueOrigin(
            one(authorityArgument, PsiIndex.EdgeRole.VALUE), facts, 0, new HashMap<>());
        if (reference == null || reference.kind() != PsiIndex.NodeKind.CALLABLE_REF) return null;
        PsiIndex.Node referencedSnapshot = referenced == null ? null
            : sourceTypeDeclaration(one(referenced, PsiIndex.EdgeRole.TYPE));
        if (referenced == null || stateSharedDeclarationOwner(referenced) != authorityType
                || referencedSnapshot == null) return null;
        if (snapshot == null) snapshot = referencedSnapshot;
        else if (referencedSnapshot != snapshot) return null;
        Map<String, PsiIndex.Node> derivedFields = stateReopenSnapshotFields(snapshot);
        if (derivedFields == null) return null;
        if (fields == null) fields = derivedFields;
        else for (String key : List.of("selection", "int", "boolean")) {
            if (fields.get(key) != derivedFields.get(key)) return null;
        }
        if (authorityOrigin == null || authorityOrigin.id() != authorityParameter.id()) return null;
        if (!stateReopenReceiverMatches(boundReceiver,
                authorityParameter, rootOrigin, facts)) return null;
        PsiIndex.Node invocation = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, target)
                    || functionValueDeclaration(call, facts) != callbackParameter) continue;
            if (invocation != null) return null;
            invocation = call;
        }
        PsiIndex.Node handoff = stateReopenLocalInitializedBy(invocation, target);
        if (handoff == null) return null;
        PsiIndex.Node callbackRestore = stateReopenCallbackRestore(
            target, targetAuthority, authorityType, handoff, facts);
        Map<String, Object> bundle = stateReopenCallbackBundle(
            target, handoff, snapshot, fields, facts,
            putString, putInt, putBoolean);
        PsiIndex.Node bundleFirst = bundle == null
            ? null : (PsiIndex.Node) bundle.get("bundleFirst");
        PsiIndex.Node bundleLast = bundle == null
            ? null : (PsiIndex.Node) bundle.get("bundleLast");
        if (callbackRestore == null || bundleFirst == null || bundleLast == null
                || invocation.fileId() != target.fileId()
                || callbackRestore.fileId() != target.fileId()
                || bundleFirst.fileId() != target.fileId()
                || bundleLast.fileId() != target.fileId()
                || openCall.fileId() != target.fileId()
                || invocation.startUtf16() >= callbackRestore.startUtf16()
                || callbackRestore.startUtf16() >= bundleFirst.startUtf16()
                || bundleLast.startUtf16() >= openCall.startUtf16()) return null;
        Map<String, Object> result = new HashMap<>(bundle);
        result.put("alternative", "equivalent-repository-reopen");
        result.put("reopenCall", reopenCall);
        result.put("reopenTarget", target);
        result.put("seam", reference);
        result.put("handoff", invocation);
        result.put("handoffLocal", handoff);
        result.put("callbackRestore", callbackRestore);
        result.put("openCall", openCall);
        return Map.copyOf(result);
    }

    private PsiIndex.Node stateReopenLocalInitializedBy(PsiIndex.Node value,
            PsiIndex.Node callable) {
        if (value == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node property : program.nodes()) {
            if (property.kind() != PsiIndex.NodeKind.PROPERTY_DECL || !isWithin(property, callable)
                    || !property.flags().contains(PsiIndex.NodeFlag.VAL)) continue;
            PsiIndex.Node initializer = one(property, PsiIndex.EdgeRole.INITIALIZER);
            if (initializer == null || initializer.id() != value.id()
                    && !isWithin(value, initializer)) continue;
            if (match != null) return null;
            match = property;
        }
        return match;
    }

    private PsiIndex.Node stateReopenCallbackRestore(PsiIndex.Node target,
            PsiIndex.Node authorityParameter, PsiIndex.Node authorityType,
            PsiIndex.Node handoff, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, target)) continue;
            PsiIndex.Node method = exactSourceTarget(call, facts);
            PsiIndex.Node receiver = stateSharedValueOrigin(
                resolvedReceiver(call), facts, 0, new HashMap<>());
            if (method == null || stateSharedDeclarationOwner(method) != authorityType
                    || receiver == null || receiver.id() != authorityParameter.id()
                    || !stateSharedMethodHasFact(method, authorityType, facts, "write")) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(call, method, facts);
            if (mapping == null) continue;
            boolean uses = false;
            for (Integer position : mapping.keySet()) {
                PsiIndex.Node argument = mappedArgument(mapping, position);
                if (stateReopenRefersTo(argument == null ? null
                        : one(argument, PsiIndex.EdgeRole.VALUE), handoff, facts)) uses = true;
            }
            if (!uses) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private Map<String, Object> stateReopenCallbackBundle(PsiIndex.Node target,
            PsiIndex.Node handoff, PsiIndex.Node snapshot,
            Map<String, PsiIndex.Node> fields, List<Map<String, Object>> facts,
            Rules.SymbolSpec putString, Rules.SymbolSpec putInt,
            Rules.SymbolSpec putBoolean) {
        boolean direct = true;
        List<PsiIndex.Node> directCalls = new ArrayList<>();
        for (Map.Entry<String, Rules.SymbolSpec> entry : Map.of(
                "selection", putString, "int", putInt, "boolean", putBoolean).entrySet()) {
            List<PsiIndex.Node> calls = stateTypedDomainCallsWithin(target, entry.getValue(), facts);
            if (calls.size() != 1) {
                direct = false;
                break;
            }
            Map<Integer, List<PsiIndex.Node>> mapping = reviewedDomainMapping(
                calls.get(0), entry.getValue(), facts);
            if (mapping == null) {
                direct = false;
                break;
            }
            PsiIndex.Node argument = mappedArgument(mapping, 1);
            PsiIndex.Node value = argument == null ? null : one(argument, PsiIndex.EdgeRole.VALUE);
            if (!stateReopenRefersTo(value, handoff, facts)) {
                direct = false;
                break;
            }
            if (!stateTypedFieldReferenced(
                    value, fields.get(entry.getKey()), snapshot, facts)) {
                direct = false;
                break;
            }
            directCalls.add(calls.get(0));
        }
        if (direct) {
            directCalls.sort((left, right) -> Integer.compare(
                left.startUtf16(), right.startUtf16()));
            return Map.of(
                "bundleFirst", directCalls.get(0),
                "bundleLast", directCalls.get(directCalls.size() - 1),
                "bundleWitnesses", List.copyOf(directCalls));
        }

        Rules.SymbolSpec bundleType = typeSymbolExact(BUNDLE_TYPE_FQN, BUNDLE_TYPE_SIGNATURE);
        Rules.SymbolSpec bundleConstructor = domainSymbolOrNull("android.os.Bundle", "Bundle()");
        Rules.SymbolSpec apply = domainSymbolOrNull(
            "kotlin.apply", "T.apply(block: T.() -> Unit): T");
        if (bundleType == null || bundleConstructor == null || apply == null
                || !stateTypedApplyShape(apply)) return null;
        Map<String, Object> match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, target)) continue;
            PsiIndex.Node encoder = exactSourceTarget(call, facts);
            Map<String, Object> encoderProof = encoder == null
                ? null : stateTypedEncoderFunction(encoder, snapshot, fields, facts,
                    bundleType, bundleConstructor, apply,
                    putString, putInt, putBoolean);
            if (encoder == null || encoder.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || encoderProof == null) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(call, encoder, facts);
            if (mapping == null) continue;
            List<PsiIndex.Node> parameters = targets(encoder, PsiIndex.EdgeRole.PARAMETER);
            int snapshotPosition = -1;
            for (int position = 0; position < parameters.size(); position++) {
                PsiIndex.Node parameterType = one(parameters.get(position), PsiIndex.EdgeRole.TYPE);
                if (sourceTypeDeclaration(parameterType) != snapshot) continue;
                if (snapshotPosition >= 0) {
                    snapshotPosition = -1;
                    break;
                }
                snapshotPosition = position;
            }
            PsiIndex.Node argument = snapshotPosition < 0
                ? null : mappedArgument(mapping, snapshotPosition);
            PsiIndex.Node value = argument == null
                ? null : one(argument, PsiIndex.EdgeRole.VALUE);
            if (!stateReopenRefersTo(value, handoff, facts)) continue;
            if (match != null) return null;
            Map<String, Object> candidate = new HashMap<>();
            candidate.put("bundleCall", call);
            candidate.put("bundleFirst", call);
            candidate.put("bundleLast", call);
            candidate.put("bundleWitnesses", stateTypedNodeList(
                encoderProof, "putCalls"));
            match = Map.copyOf(candidate);
        }
        return match;
    }

    private Rules.Analysis analyzeContainerTopology() {
        Rules.SymbolSpec applicationType = typeSymbolExact(APPLICATION_TYPE_FQN, APPLICATION_TYPE_SIGNATURE);
        Rules.SymbolSpec onCreate = domainSymbolOrNull(ON_CREATE_FQN, ON_CREATE_SIGNATURE);
        Rules.SymbolSpec launch = domainSymbolOrNull(LAUNCH_FQN, LAUNCH_SIGNATURE);
        Rules.SymbolSpec spatialScope = typeSymbolExact(SPATIAL_SCOPE_FQN, SPATIAL_SCOPE_SIGNATURE);
        Rules.SymbolSpec with = domainSymbolOrNull(WITH_FQN, WITH_SIGNATURE);
        Rules.SymbolSpec window = domainSymbolOrNull(WINDOW_FQN, WINDOW_SIGNATURE);
        Rules.SymbolSpec stage = domainSymbolOrNull(STAGE_FQN, STAGE_SIGNATURE);
        Rules.SymbolSpec launched = domainSymbolOrNull(LAUNCHED_EFFECT_FQN, LAUNCHED_EFFECT_SIGNATURE);
        Rules.SymbolSpec openStage = domainSymbolOrNull(OPEN_STAGE_FQN, OPEN_STAGE_SIGNATURE);
        Rules.SymbolSpec mixed = domainSymbolOrNull(MIXED_FQN, MIXED_SIGNATURE);
        Rules.SymbolSpec bundleType = typeSymbolExact(BUNDLE_TYPE_FQN, BUNDLE_TYPE_SIGNATURE);
        Rules.SymbolSpec stageBundle = domainSymbolOrNull(STAGE_BUNDLE_FQN, STAGE_BUNDLE_SIGNATURE);
        Rules.SymbolSpec localNavigator = domainSymbolOrNull(LOCAL_NAVIGATOR_FQN, LOCAL_NAVIGATOR_SIGNATURE);
        Rules.SymbolSpec current = domainSymbolOrNull(CURRENT_FQN, CURRENT_SIGNATURE);
        Rules.SymbolSpec navigatorType = typeSymbolExact(NAVIGATOR_TYPE_FQN, NAVIGATOR_TYPE_SIGNATURE);
        Rules.SymbolSpec activityType = typeSymbolExact(ACTIVITY_TYPE_FQN, ACTIVITY_TYPE_SIGNATURE);
        if (applicationType == null || onCreate == null || launch == null || spatialScope == null
                || with == null || window == null || stage == null || launched == null
                || openStage == null || mixed == null || bundleType == null || stageBundle == null
                || localNavigator == null || current == null || navigatorType == null || activityType == null
                || !callbackShape(stage, 5, "stage_content", "spatial_container_scope")
                || !callbackShape(launched, 1, "launched_effect", "coroutine_scope")) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        List<PsiIndex.Node> root = topologyRoot(
            facts, applicationType, onCreate, launch, spatialScope, with, window, stage, activityType);
        if (root == null) return Rules.emptyAnalysis();
        PsiIndex.Node windowLambda = root.get(3);
        PsiIndex.Node stageCall = root.get(4);
        PsiIndex.Node stageIdArgument = root.get(5);
        PsiIndex.Node stageLambda = root.get(6);
        PsiIndex.Node activity = root.get(7);

        List<PsiIndex.Node> launchedCalls = new ArrayList<>();
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.CALL
                    || !exactDomainResolution(node, launched, facts)) continue;
            if (compositionReachable(windowLambda, node, facts, new HashMap<>(), 0)
                    || compositionReachable(stageLambda, node, facts, new HashMap<>(), 0)) {
                launchedCalls.add(node);
            }
        }
        if (launchedCalls.size() != 1) return Rules.emptyAnalysis();
        PsiIndex.Node launchedCall = launchedCalls.get(0);
        Map<Integer, List<PsiIndex.Node>> launchedMap = mapDomainArguments(launchedCall, launched, facts);
        PsiIndex.Node launchedKey = mappedArgument(launchedMap, 0);
        PsiIndex.Node launchedArgument = mappedArgument(launchedMap, 1);
        PsiIndex.Node launchedLambda = mappedLambda(launchedMap, 1);
        if (launchedKey == null || launchedLambda == null
                || !exactFact(facts, "callback_binding", launchedLambda, launchedCall, launchedArgument,
                    "launched_effect", launched)
                || navigatorOrigin(launchedKey, facts, localNavigator, current, navigatorType) == null) {
            return Rules.emptyAnalysis();
        }

        List<Map<String, Object>> paths = new ArrayList<>();
        collectOpenStagePaths(launchedLambda, openStage, facts, new ArrayList<>(),
            new ArrayList<>(), new HashMap<>(), paths);
        if (paths.size() != 1) return Rules.emptyAnalysis();
        Map<String, Object> path = paths.get(0);
        PsiIndex.Node openCall = (PsiIndex.Node) path.get("openCall");
        @SuppressWarnings("unchecked")
        List<PsiIndex.Node> helperCalls = (List<PsiIndex.Node>) path.get("helperCalls");
        @SuppressWarnings("unchecked")
        List<PsiIndex.Node> helperDeclarations = (List<PsiIndex.Node>) path.get("helperDeclarations");
        @SuppressWarnings("unchecked")
        Map<Integer, List<PsiIndex.Node>> openMap =
            (Map<Integer, List<PsiIndex.Node>>) path.get("openMap");
        if (helperCalls.size() != helperDeclarations.size() || helperCalls.size() > 2
                || openMap.size() != 3 || !openMap.containsKey(0)
                || !openMap.containsKey(1) || !openMap.containsKey(2)) {
            return Rules.emptyAnalysis();
        }
        PsiIndex.Node openIdArgument = mappedArgument(openMap, 0);
        PsiIndex.Node styleArgument = mappedArgument(openMap, 1);
        PsiIndex.Node bundleArgument = mappedArgument(openMap, 2);
        PsiIndex.Node styleValue = styleArgument == null ? null : one(styleArgument, PsiIndex.EdgeRole.VALUE);
        if (openIdArgument == null || styleArgument == null || bundleArgument == null
                || !exactQualifiedResult(styleValue, mixed, "stage_style", facts)) {
            return Rules.emptyAnalysis();
        }

        PsiIndex.Node stageOrigin = traceIdOrigin(
            one(stageIdArgument, PsiIndex.EdgeRole.VALUE), helperCalls, helperDeclarations, facts, 0);
        PsiIndex.Node openOrigin = traceIdOrigin(
            one(openIdArgument, PsiIndex.EdgeRole.VALUE), helperCalls, helperDeclarations, facts, 0);
        String originKind;
        String stageLiteral = atomicString(stageOrigin);
        String openLiteral = atomicString(openOrigin);
        if (stageLiteral != null && stageLiteral.equals(openLiteral)) {
            originKind = "literal";
        } else if (stageOrigin != null && stageOrigin == openOrigin
                && stageOrigin.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                && stageOrigin.flags().contains(PsiIndex.NodeFlag.VAL)
                && !stageOrigin.flags().contains(PsiIndex.NodeFlag.VAR)
                && atomicString(one(stageOrigin, PsiIndex.EdgeRole.INITIALIZER)) != null) {
            originKind = stageOrigin.flags().contains(PsiIndex.NodeFlag.CONST) ? "const" : "source-symbol";
        } else return Rules.emptyAnalysis();

        PsiIndex.Node bundleOrigin = traceBundleOrigin(one(bundleArgument, PsiIndex.EdgeRole.VALUE),
            helperCalls, helperDeclarations, facts, bundleType, stageBundle, 0);
        if (bundleOrigin == null) return Rules.emptyAnalysis();
        String argumentKind;
        if (stageIdArgument.flags().contains(PsiIndex.NodeFlag.NAMED)
                && "id".equals(stageIdArgument.name())) argumentKind = "named";
        else if (!stageIdArgument.flags().contains(PsiIndex.NodeFlag.NAMED)) argumentKind = "positional";
        else return Rules.emptyAnalysis();
        String proofForm = switch (helperCalls.size()) {
            case 0 -> "direct-mixed-stage-open";
            case 1 -> "one-helper-mixed-stage-open";
            case 2 -> "two-helper-mixed-stage-open";
            default -> throw new IllegalArgumentException("topology helper depth");
        };
        String alternative = argumentKind + "-" + originKind + "-stage-id";
        Map<String, Boolean> complete = new HashMap<>();
        Map<String, List<String>> alternatives = new HashMap<>();
        for (String form : domain.rule("spatial.container-topology").proofForms()) {
            boolean selected = form.equals(proofForm);
            complete.put(form, selected);
            alternatives.put(form, selected ? List.of(alternative) : List.of());
        }
        Map<String, String> selected = Rules.selectProof(
            domain, "spatial.container-topology", complete, alternatives);
        if (!proofForm.equals(selected.get("proofForm"))
                || !alternative.equals(selected.get("alternativeId"))) return Rules.emptyAnalysis();

        List<String> witnesses = new ArrayList<>();
        boolean valid = addWitness(activity, witnesses) && addWitness(stageCall, witnesses)
            && addWitness(stageIdArgument, witnesses) && addWitness(stageLambda, witnesses);
        if (!originKind.equals("literal")) valid &= addWitness(stageOrigin, witnesses);
        valid &= addWitness(launchedCall, witnesses) && addWitness(openCall, witnesses)
            && addWitness(openIdArgument, witnesses) && addWitness(styleArgument, witnesses)
            && addWitness(bundleArgument, witnesses) && addWitness(bundleOrigin, witnesses);
        for (int index = 0; valid && index < helperCalls.size(); index++) {
            valid = addWitness(helperCalls.get(index), witnesses)
                && addWitness(helperDeclarations.get(index), witnesses);
        }
        if (!valid) return Rules.emptyAnalysis();
        Rules.Analysis claim = Rules.claimOrNull(program, domain, "spatial.container-topology",
            proofForm, alternative, witnesses);
        if (claim == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("spatial.container-topology", alternative);
        return claim;
    }

    private List<PsiIndex.Node> topologyRoot(List<Map<String, Object>> facts,
            Rules.SymbolSpec applicationType, Rules.SymbolSpec onCreate, Rules.SymbolSpec launch,
            Rules.SymbolSpec spatialScope, Rules.SymbolSpec with, Rules.SymbolSpec window,
            Rules.SymbolSpec stage, Rules.SymbolSpec activityType) {
        List<List<PsiIndex.Node>> roots = new ArrayList<>();
        for (PsiIndex.Node entry : program.nodes()) {
            if (entry.kind() != PsiIndex.NodeKind.FUNCTION_DECL || !isProductionPath(entry.fileId())) continue;
            Integer ownerId = lexicalOwners.get(entry.id());
            PsiIndex.Node application = ownerId == null ? null : program.node(ownerId);
            if (application == null || application.kind() != PsiIndex.NodeKind.CLASS_DECL
                    || !exactFact(facts, "production_root", entry, application, null, "direct", onCreate)
                    || !exactFact(facts, "type", application, null, null,
                        "android_application", applicationType)) continue;
            PsiIndex.Node launchCall = null;
            PsiIndex.Node reference = null;
            boolean invalidLaunch = false;
            for (PsiIndex.Node call : directStatementCallsLoose(entry)) {
                Map<Integer, List<PsiIndex.Node>> launchMap =
                    cp2seReviewedLaunchMapping(call, launch, spatialScope, facts);
                PsiIndex.Node launchArgument = mappedArgument(launchMap, 0);
                PsiIndex.Node value = launchArgument == null
                    ? null : one(launchArgument, PsiIndex.EdgeRole.VALUE);
                if (launchMap == null || !hasFact(facts, "reachable", call.id())) continue;
                if (value == null || value.kind() != PsiIndex.NodeKind.CALLABLE_REF
                        || !hasFact(facts, "reachable", value.id()) || launchCall != null) {
                    launchCall = null;
                    reference = null;
                    invalidLaunch = true;
                    break;
                }
                launchCall = call;
                reference = value;
            }
            PsiIndex.Node main = reference == null
                ? invalidLaunch ? null : canonicalTopologyRoot(spatialScope, facts)
                : importedCallable(reference, spatialScope, facts);
            if (main == null) continue;
            PsiIndex.Node withCall = one(main, PsiIndex.EdgeRole.BODY);
            if (withCall == null || withCall.kind() != PsiIndex.NodeKind.CALL
                    || !exactDomainResolution(withCall, with, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> withMap = mapDomainArguments(withCall, with, facts);
            PsiIndex.Node receiverArgument = mappedArgument(withMap, 0);
            PsiIndex.Node receiverValue = receiverArgument == null
                ? null : one(receiverArgument, PsiIndex.EdgeRole.VALUE);
            PsiIndex.Node rootLambda = mappedLambda(withMap, 1);
            List<PsiIndex.Node> parameters = targets(main, PsiIndex.EdgeRole.PARAMETER);
            PsiIndex.Node parameter = parameters.size() == 1 ? parameters.get(0) : null;
            PsiIndex.Node receiverDeclaration = receiverValue == null ? null
                : relatedNodeForFact(facts, "def_use", receiverValue.id());
            if (rootLambda == null || parameter == null || receiverDeclaration != parameter
                    || !exactFact(facts, "type", parameter, main, null,
                        "spatial_app_scope", spatialScope)) continue;

            PsiIndex.Node windowCall = null;
            PsiIndex.Node windowLambda = null;
            PsiIndex.Node stageCall = null;
            PsiIndex.Node stageId = null;
            PsiIndex.Node stageLambda = null;
            for (PsiIndex.Node call : directStatementCallsLoose(rootLambda)) {
                if (exactDomainResolution(call, window, facts)) {
                    Map<Integer, List<PsiIndex.Node>> mapping = mapDomainArguments(call, window, facts);
                    PsiIndex.Node candidateLambda = mappedLambda(mapping, 0);
                    if (candidateLambda == null || windowCall != null) {
                        windowCall = null;
                        windowLambda = null;
                        break;
                    }
                    windowCall = call;
                    windowLambda = candidateLambda;
                }
                Map<Integer, List<PsiIndex.Node>> mapping = reviewedDomainMapping(call, stage, facts);
                if (mapping != null) {
                    PsiIndex.Node candidateId = mappedArgument(mapping, 0);
                    PsiIndex.Node candidateLambda = mappedLambda(mapping, 5);
                    if (candidateId == null || candidateLambda == null || stageCall != null) {
                        stageCall = null;
                        stageId = null;
                        stageLambda = null;
                        break;
                    }
                    stageCall = call;
                    stageId = candidateId;
                    stageLambda = candidateLambda;
                }
            }
            PsiIndex.Node activity = uniqueLaunchActivity(facts, activityType);
            if (windowCall != null && stageCall != null && activity != null) {
                roots.add(List.of(main, rootLambda, windowCall, windowLambda,
                    stageCall, stageId, stageLambda, activity));
            }
        }
        return roots.size() == 1 ? roots.get(0) : null;
    }

    private PsiIndex.Node canonicalTopologyRoot(Rules.SymbolSpec spatialScope,
            List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !"mainApp".equals(candidate.name())
                    || !isTopLevel(candidate) || !isProductionPath(candidate.fileId())) continue;
            List<PsiIndex.Node> parameters = targets(candidate, PsiIndex.EdgeRole.PARAMETER);
            if (parameters.size() != 1 || !exactFact(facts, "type", parameters.get(0), candidate,
                    null, "spatial_app_scope", spatialScope)) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private PsiIndex.Node importedCallable(PsiIndex.Node reference, Rules.SymbolSpec spatialScope,
            List<Map<String, Object>> facts) {
        if (reference.name() == null) return null;
        PsiIndex.ImportEntry imported = null;
        for (int importId : program.file(reference.fileId()).importIds()) {
            PsiIndex.ImportEntry candidate = program.imports().get(importId);
            if (!candidate.exposedName().equals(reference.name())) continue;
            if (imported != null) return null;
            imported = candidate;
        }
        if (imported == null) return null;
        int separator = imported.fqName().lastIndexOf('.');
        if (separator <= 0 || !imported.fqName().substring(separator + 1).equals(reference.name())) return null;
        String packageName = imported.fqName().substring(0, separator);
        PsiIndex.Node match = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.FUNCTION_DECL || !isTopLevel(candidate)
                    || !reference.name().equals(candidate.name())
                    || !packageName.equals(program.file(candidate.fileId()).packageName())
                    || !isProductionPath(candidate.fileId())) continue;
            List<PsiIndex.Node> parameters = targets(candidate, PsiIndex.EdgeRole.PARAMETER);
            if (parameters.size() != 1 || !exactFact(facts, "type", parameters.get(0), candidate,
                    null, "spatial_app_scope", spatialScope)) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }

    private PsiIndex.Node uniqueLaunchActivity(List<Map<String, Object>> facts,
            Rules.SymbolSpec activityType) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.CLASS_DECL || !isProductionPath(node.fileId())
                    || !exactFact(facts, "type", node, null, null,
                        "spatial_launch_activity", activityType)) continue;
            if (match != null) return null;
            match = node;
        }
        return match;
    }

    private List<PsiIndex.Node> directStatementCallsLoose(PsiIndex.Node callable) {
        if (callable == null) return List.of();
        PsiIndex.Node body = callable.kind() == PsiIndex.NodeKind.LAMBDA
            ? one(callable, PsiIndex.EdgeRole.LAMBDA_BODY) : one(callable, PsiIndex.EdgeRole.BODY);
        if (body == null) return List.of();
        List<PsiIndex.Node> calls = new ArrayList<>();
        for (PsiIndex.Node statement : body.kind() == PsiIndex.NodeKind.BLOCK
                ? lexicalChildren(body) : List.of(body)) {
            PsiIndex.Node call = directCall(statement);
            if (call != null && enclosingCallable(call) == callable) calls.add(call);
        }
        return calls;
    }

    private boolean compositionReachable(PsiIndex.Node callable, PsiIndex.Node target,
            List<Map<String, Object>> facts, Map<Integer, Boolean> visited, int depth) {
        if (callable == null || target == null || depth > 8
                || visited.put(callable.id(), Boolean.TRUE) != null) return false;
        for (PsiIndex.Node call : directStatementCallsLoose(callable)) {
            if (call.id() == target.id()) return true;
            PsiIndex.Node source = exactSourceTarget(call, facts);
            if (source != null && !hasAnyTaint(call, facts)
                    && compositionReachable(source, target, facts,
                        new HashMap<>(visited), depth + 1)) return true;
            Rules.SymbolSpec symbol = symbolForFact(facts, "call_resolution", call.id());
            if (symbol == null || !exactDomainResolution(call, symbol, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapDomainArguments(call, symbol, facts);
            for (Rules.CallbackSpec callback : symbol.callbacks()) {
                PsiIndex.Node nested = mappedLambda(mapping, callback.argumentPosition());
                if (nested != null && compositionReachable(nested, target, facts,
                        new HashMap<>(visited), depth + 1)) return true;
            }
        }
        return false;
    }

    private PsiIndex.Node navigatorOrigin(PsiIndex.Node keyArgument,
            List<Map<String, Object>> facts, Rules.SymbolSpec localNavigator,
            Rules.SymbolSpec current, Rules.SymbolSpec navigatorType) {
        PsiIndex.Node value = one(keyArgument, PsiIndex.EdgeRole.VALUE);
        PsiIndex.Node declaration = value == null ? null : relatedNodeForFact(facts, "def_use", value.id());
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !declaration.flags().contains(PsiIndex.NodeFlag.VAL)
                || declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                || !exactFact(facts, "type", declaration, enclosingCallable(declaration), null,
                    "spatial_navigator", navigatorType)) return null;
        PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
        if (initializer == null || initializer.kind() != PsiIndex.NodeKind.QUALIFIED) return null;
        PsiIndex.Node receiver = one(initializer, PsiIndex.EdgeRole.RECEIVER);
        return receiver != null && exactDomainResolution(receiver, localNavigator, facts)
                && exactFact(facts, "origin", receiver, enclosingCallable(receiver), null,
                    "retained", localNavigator)
                && exactQualifiedResult(initializer, current, "spatial_navigator", facts)
            ? declaration : null;
    }

    private boolean exactQualifiedResult(PsiIndex.Node value, Rules.SymbolSpec symbol,
            String returnType, List<Map<String, Object>> facts) {
        if (value == null || value.kind() != PsiIndex.NodeKind.QUALIFIED
                || hasAnyTaint(value, facts)) return false;
        PsiIndex.Node receiver = one(value, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node selector = one(value, PsiIndex.EdgeRole.SELECTOR);
        return receiver != null && selector != null && !hasAnyTaint(selector, facts)
            && exactDomainResolution(selector, symbol, facts)
            && exactFact(facts, "origin", selector, enclosingCallable(selector), receiver,
                "derived", symbol)
            && exactFact(facts, "origin", value, enclosingCallable(value), selector,
                "derived", symbol)
            && exactFact(facts, "return_origin", value, enclosingCallable(value), selector,
                returnType, symbol);
    }

    private void collectOpenStagePaths(PsiIndex.Node callable, Rules.SymbolSpec openStage,
            List<Map<String, Object>> facts, List<PsiIndex.Node> helperCalls,
            List<PsiIndex.Node> helperDeclarations, Map<Integer, Boolean> visited,
            List<Map<String, Object>> matches) {
        if (callable == null || visited.put(callable.id(), Boolean.TRUE) != null || matches.size() > 1) return;
        for (PsiIndex.Node call : directStatementCallsLoose(callable)) {
            Map<Integer, List<PsiIndex.Node>> openMap = reviewedDomainMapping(call, openStage, facts);
            if (openMap != null) {
                Map<String, Object> match = new HashMap<>();
                match.put("helperCalls", List.copyOf(helperCalls));
                match.put("helperDeclarations", List.copyOf(helperDeclarations));
                match.put("openCall", call);
                match.put("openMap", openMap);
                matches.add(Map.copyOf(match));
                continue;
            }
            if (helperCalls.size() >= 2 || hasAnyTaint(call, facts)) continue;
            PsiIndex.Node declaration = exactSourceTarget(call, facts);
            if (declaration == null || declaration.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isProductionPath(declaration.fileId())
                    || mapSourceArguments(call, declaration, facts) == null) continue;
            List<PsiIndex.Node> nextCalls = new ArrayList<>(helperCalls);
            List<PsiIndex.Node> nextDeclarations = new ArrayList<>(helperDeclarations);
            nextCalls.add(call);
            nextDeclarations.add(declaration);
            collectOpenStagePaths(declaration, openStage, facts, nextCalls, nextDeclarations,
                new HashMap<>(visited), matches);
        }
    }

    private String atomicString(PsiIndex.Node node) {
        if (node == null || node.kind() != PsiIndex.NodeKind.STRING_TEMPLATE || node.tokenCount() < 3) return null;
        StringBuilder raw = new StringBuilder();
        for (int index = node.firstTokenId(); index < node.firstTokenId() + node.tokenCount(); index++) {
            PsiIndex.Token token = program.tokens().get(index);
            if (token.kind() != PsiIndex.TokenKind.STRING_LITERAL) return null;
            raw.append(token.value());
        }
        String text = raw.toString();
        if (text.length() < 3 || text.charAt(0) != '"' || text.charAt(text.length() - 1) != '"') return null;
        String value = text.substring(1, text.length() - 1);
        return value.isEmpty() || value.indexOf('\\') >= 0 || value.indexOf('$') >= 0 ? null : value;
    }

    private PsiIndex.Node sourceProperty(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null) return null;
        if (value.kind() == PsiIndex.NodeKind.NAME_REF && value.name() != null) {
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
            if (declaration == null) declaration = findLexicalDeclaration(value, value.name());
            return declaration;
        }
        if (value.kind() != PsiIndex.NodeKind.QUALIFIED) return null;
        PsiIndex.Node receiver = one(value, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node selector = one(value, PsiIndex.EdgeRole.SELECTOR);
        if (receiver == null || selector == null || receiver.kind() != PsiIndex.NodeKind.NAME_REF
                || selector.kind() != PsiIndex.NodeKind.NAME_REF
                || receiver.name() == null || selector.name() == null) return null;
        PsiIndex.Node container = null;
        String packageName = program.file(value.fileId()).packageName();
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.OBJECT_DECL || !isTopLevel(candidate)
                    || !receiver.name().equals(candidate.name())
                    || !packageName.equals(program.file(candidate.fileId()).packageName())) continue;
            if (container != null) return null;
            container = candidate;
        }
        if (container == null) return null;
        PsiIndex.Node property = null;
        for (PsiIndex.Node child : lexicalChildren(container)) {
            if (child.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                    || !selector.name().equals(child.name())) continue;
            if (property != null) return null;
            property = child;
        }
        return property;
    }

    private PsiIndex.Node traceIdOrigin(PsiIndex.Node value, List<PsiIndex.Node> helperCalls,
            List<PsiIndex.Node> helperDeclarations, List<Map<String, Object>> facts, int depth) {
        if (value == null || depth > 6) return null;
        if (atomicString(value) != null) return value;
        PsiIndex.Node declaration = sourceProperty(value, facts);
        if (declaration == null) return null;
        if (declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
            return declaration.flags().contains(PsiIndex.NodeFlag.VAL)
                    && !declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                    && atomicString(one(declaration, PsiIndex.EdgeRole.INITIALIZER)) != null
                ? declaration : null;
        }
        if (declaration.kind() != PsiIndex.NodeKind.PARAMETER_DECL) return null;
        for (int index = 0; index < helperDeclarations.size(); index++) {
            PsiIndex.Node helper = helperDeclarations.get(index);
            List<PsiIndex.Node> parameters = targets(helper, PsiIndex.EdgeRole.PARAMETER);
            int position = parameters.indexOf(declaration);
            if (position < 0) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(helperCalls.get(index), helper, facts);
            PsiIndex.Node argument = mappedArgument(mapping, position);
            return argument == null ? null : traceIdOrigin(one(argument, PsiIndex.EdgeRole.VALUE),
                helperCalls, helperDeclarations, facts, depth + 1);
        }
        return null;
    }

    private PsiIndex.Node traceBundleOrigin(PsiIndex.Node value, List<PsiIndex.Node> helperCalls,
            List<PsiIndex.Node> helperDeclarations, List<Map<String, Object>> facts,
            Rules.SymbolSpec bundleType, Rules.SymbolSpec stageBundle, int depth) {
        if (value == null || depth > 6 || isNullLiteral(value)) return null;
        if (exactDomainResolution(value, stageBundle, facts)
                && exactFact(facts, "type", value, enclosingCallable(value), null,
                    "bundle", bundleType)) return value;
        PsiIndex.Node declaration = sourceProperty(value, facts);
        if (declaration == null) return null;
        if (declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
            PsiIndex.Node initializer = one(declaration, PsiIndex.EdgeRole.INITIALIZER);
            if (!declaration.flags().contains(PsiIndex.NodeFlag.VAL)
                    || declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                    || initializer == null
                    || !exactBundleTypeFact(
                        declaration, enclosingCallable(declaration), facts, bundleType)) return null;
            PsiIndex.Node traced = traceBundleOrigin(initializer, helperCalls,
                helperDeclarations, facts, bundleType, stageBundle, depth + 1);
            return traced != null || exactSourceBundleProducer(initializer, facts, bundleType)
                ? declaration : null;
        }
        if (declaration.kind() != PsiIndex.NodeKind.PARAMETER_DECL) return null;
        for (int index = 0; index < helperDeclarations.size(); index++) {
            PsiIndex.Node helper = helperDeclarations.get(index);
            List<PsiIndex.Node> parameters = targets(helper, PsiIndex.EdgeRole.PARAMETER);
            int position = parameters.indexOf(declaration);
            if (position < 0) continue;
            Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(helperCalls.get(index), helper, facts);
            PsiIndex.Node argument = mappedArgument(mapping, position);
            return argument == null ? null : traceBundleOrigin(one(argument, PsiIndex.EdgeRole.VALUE),
                helperCalls, helperDeclarations, facts, bundleType, stageBundle, depth + 1);
        }
        return null;
    }

    private boolean exactSourceBundleProducer(PsiIndex.Node value,
            List<Map<String, Object>> facts, Rules.SymbolSpec bundleType) {
        PsiIndex.Node call = directCall(value);
        PsiIndex.Node declaration = call == null ? null : exactSourceTarget(call, facts);
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                || !isProductionPath(declaration.fileId()) || hasAnyTaint(value, facts)
                || hasAnyTaint(call, facts)) return false;
        PsiIndex.Node declaredType = one(declaration, PsiIndex.EdgeRole.TYPE);
        PsiIndex.Node result = sourceReturnOrigin(declaration);
        if (declaredType == null || typeSymbolForReference(declaredType) != bundleType
                || isExplicitNullable(declaredType) || result == null || isNullLiteral(result)
                || result.kind() == PsiIndex.NodeKind.IF || result.kind() == PsiIndex.NodeKind.WHEN
                || result.kind() == PsiIndex.NodeKind.TRY || hasAnyTaint(result, facts)
                || !exactFact(facts, "type", declaration, enclosingCallable(declaration), null,
                    "bundle", bundleType)
                || !exactBundleTypeFact(call, enclosingCallable(call), facts, bundleType)
                || !exactBundleTypeFact(value, enclosingCallable(value), facts, bundleType)
                || !exactFact(facts, "return_origin", call, enclosingCallable(call), result,
                    "bundle", null)) return false;
        return value.id() == call.id() || exactFact(facts, "return_origin", value,
            enclosingCallable(value), call, "bundle", null);
    }

    private boolean exactBundleTypeFact(PsiIndex.Node subject, PsiIndex.Node owner,
            List<Map<String, Object>> facts, Rules.SymbolSpec bundleType) {
        return exactFact(facts, "type", subject, owner, null, "bundle", bundleType)
            || exactFact(facts, "type", subject, owner, null, "bundle", null);
    }

    // CP2 plane emitter section.
    private Rules.Analysis analyzeRetryReadiness() {
        Rules.SymbolSpec start = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneTrackingManager.start", "start(): Unit");
        Rules.SymbolSpec load = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors",
            "loadAllAnchors(): Array<PlaneAnchor>");
        Rules.SymbolSpec until = domainSymbolOrNull(
            "kotlin.ranges.until", "Int.until(to: Int): IntRange");
        Rules.SymbolSpec ready = domainSymbolOrNull(
            "kotlin.collections.isNotEmpty", "Collection<T>.isNotEmpty(): Boolean");
        if (start == null || load == null || until == null || ready == null) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node loop : program.nodes()) {
            if (!isProductionPath(loop.fileId())
                    || loop.kind() != PsiIndex.NodeKind.FOR
                    && loop.kind() != PsiIndex.NodeKind.WHILE) continue;
            String alternative;
            PsiIndex.Node head;
            if (loop.kind() == PsiIndex.NodeKind.FOR) {
                head = one(loop, PsiIndex.EdgeRole.RANGE);
                if (head == null || head.kind() != PsiIndex.NodeKind.BINARY
                        || !exactDomainResolution(head, until, facts)
                        || !planeRetryZero(one(head, PsiIndex.EdgeRole.LEFT))
                        || !planeRetryMultipleBound(one(head, PsiIndex.EdgeRole.RIGHT), facts)) continue;
                alternative = "bounded-for";
            } else {
                head = one(loop, PsiIndex.EdgeRole.CONDITION);
                if (!isCanonicalBoundedWhile(loop, facts)
                        || !planeRetryMultipleBound(planeRetryComparisonBound(head), facts)) continue;
                alternative = "canonical-bounded-while";
            }
            PsiIndex.Node success = relatedNodeForFact(facts, "loop_success", loop.id());
            PsiIndex.Node retained = planeRetryRetainedExit(loop, success, facts);
            PsiIndex.Node retainedValue = retained == null
                ? null : one(retained, PsiIndex.EdgeRole.VALUE);
            PsiIndex.Node producer = exactCollectionProducerOrigin(retainedValue, facts);
            if (success == null || retained == null || producer == null
                    || !exactDomainResolution(producer, load, facts)) continue;

            PsiIndex.Node readiness = null;
            PsiIndex.Node readinessBranch = null;
            for (PsiIndex.Node call : program.nodes()) {
                if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, loop)
                        || !exactDomainResolution(call, ready, facts)) continue;
                PsiIndex.Node branch = conditionOwner(call);
                PsiIndex.Node receiver = resolvedReceiver(call);
                PsiIndex.Node readinessProducer = exactCollectionProducerOrigin(receiver, facts);
                PsiIndex.Node thenBranch = branch == null
                    ? null : one(branch, PsiIndex.EdgeRole.THEN_BRANCH);
                if (branch == null || branch.kind() != PsiIndex.NodeKind.IF
                        || thenBranch == null || success.id() != thenBranch.id()
                            && !isWithin(success, thenBranch)
                        || readinessProducer == null
                        || readinessProducer.id() != producer.id()) continue;
                if (readiness != null) {
                    readiness = null;
                    break;
                }
                readiness = call;
                readinessBranch = branch;
            }
            PsiIndex.Node trackingStart = planeUniqueDomainCallInFile(
                loop.fileId(), start, facts);
            if (readiness == null || trackingStart == null) continue;

            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(enclosingCallable(loop), witnesses)
                && addWitness(trackingStart, witnesses)
                && addWitness(loop, witnesses)
                && addWitness(retained, witnesses)
                && addWitness(producer, witnesses)
                && addWitness(readiness, witnesses)
                && planeAddProofWitness(readinessBranch, witnesses);
            if (!valid) continue;
            Rules.Analysis candidate = planeClaim(
                "plane.retry-readiness", "bounded-retained-load-retry",
                alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("plane.retry-readiness", matchAlternative);
        return match;
    }

    private Rules.Analysis analyzeSemanticFallback() {
        Rules.SymbolSpec load = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneTrackingManager.loadAllAnchors",
            "loadAllAnchors(): Array<PlaneAnchor>");
        Rules.SymbolSpec filter = domainSymbolOrNull(
            "kotlin.collections.filter",
            "Iterable<T>.filter(predicate: (T) -> Boolean): List<T>");
        Rules.SymbolSpec selector = domainSymbolOrNull(
            "kotlin.collections.maxByOrNull",
            "Iterable<T>.maxByOrNull(selector: (T) -> R): T?");
        Rules.SymbolSpec table = domainSymbolOrNull(
            "com.pico.spatial.sense.base.SemanticLabelType.TABLE", "TABLE");
        Rules.SymbolSpec floor = domainSymbolOrNull(
            "com.pico.spatial.sense.base.SemanticLabelType.FLOOR", "FLOOR");
        Rules.SymbolSpec upward = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneOrientation.HORIZONTAL_UPWARD",
            "HORIZONTAL_UPWARD");
        Rules.SymbolSpec downward = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneOrientation.HORIZONTAL_DOWNWARD",
            "HORIZONTAL_DOWNWARD");
        if (load == null || filter == null || selector == null || table == null
                || floor == null || upward == null || downward == null) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node fallback : program.nodes()) {
            if (fallback.kind() != PsiIndex.NodeKind.BINARY || !"?:".equals(fallback.value())
                    || !isProductionPath(fallback.fileId())
                    || !planeFallbackConsumed(fallback, facts)) continue;
            PsiIndex.Node loaded = planeUniqueDomainCallInFile(fallback.fileId(), load, facts);
            if (loaded == null) continue;
            PsiIndex.Node left = one(fallback, PsiIndex.EdgeRole.LEFT);
            PsiIndex.Node right = one(fallback, PsiIndex.EdgeRole.RIGHT);
            List<PsiIndex.Node> tablePath = planeSelectorPath(
                left, fallback, loaded, table, filter, selector, upward, downward, facts);
            List<PsiIndex.Node> floorPath = planeSelectorPath(
                right, fallback, loaded, floor, filter, selector, upward, downward, facts);
            if (tablePath == null || floorPath == null
                    || tablePath.get(0).id() == floorPath.get(0).id()) continue;
            boolean inline = tablePath.get(5) == null && floorPath.get(5) == null;
            boolean helper = tablePath.get(5) != null && floorPath.get(5) != null;
            if (!inline && !helper) continue;
            String alternative = inline ? "inline-selectors" : "unique-helper-selectors";

            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(enclosingCallable(fallback), witnesses)
                && addWitness(loaded, witnesses);
            for (List<PsiIndex.Node> path : List.of(tablePath, floorPath)) {
                for (PsiIndex.Node node : path) {
                    if (valid && node != null) valid = planeAddProofWitness(node, witnesses);
                }
            }
            if (!valid) continue;
            Rules.Analysis candidate = planeClaim(
                "plane.semantic-fallback", "dominating-semantic-plane-fallback",
                alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("plane.semantic-fallback", matchAlternative);
        return match;
    }
    private Rules.Analysis analyzeAnchorPose() {
        Rules.SymbolSpec convertPosition = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.convertPositionFrom",
            "convertPositionFrom(position: Vector3, baseEntity: Entity?): Vector3");
        Rules.SymbolSpec convertRotation = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.convertRotationFrom",
            "convertRotationFrom(rotation: Quat, baseEntity: Entity?): Quat");
        Rules.SymbolSpec planeTransform = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneAnchor.transform", "transform: Transform");
        Rules.SymbolSpec transformPosition = domainSymbolOrNull(
            "com.pico.spatial.core.math.Transform.position", "position: Vector3");
        Rules.SymbolSpec transformRotation = domainSymbolOrNull(
            "com.pico.spatial.core.math.Transform.quaternion", "quaternion: Quat");
        Rules.SymbolSpec geometry = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneAnchor.boundingBoxSize",
            "boundingBoxSize: Vector2");
        Rules.SymbolSpec vector = domainSymbolOrNull(
            "com.pico.spatial.core.math.Vector3",
            "Vector3(x: Float = 0f, y: Float = 0f, z: Float = 0f)");
        Rules.SymbolSpec vectorX = domainSymbolOrNull(
            "com.pico.spatial.core.math.Vector3.x", "x: Float");
        Rules.SymbolSpec vectorY = domainSymbolOrNull(
            "com.pico.spatial.core.math.Vector3.y", "y: Float");
        Rules.SymbolSpec vectorZ = domainSymbolOrNull(
            "com.pico.spatial.core.math.Vector3.z", "z: Float");
        Rules.SymbolSpec component = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.TransformComponent",
            "TransformComponent(position: Vector3, rotation: Quat, scale: Vector3)");
        Rules.SymbolSpec components = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.components", "components: ComponentSet");
        Rules.SymbolSpec set = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.ComponentSet.set", "set(component: T): Unit");
        Rules.SymbolSpec addChild = domainSymbolOrNull(
            "com.pico.spatial.core.ecs.Entity.addChild", "addChild(entity: Entity): Boolean");
        if (convertPosition == null || convertRotation == null || planeTransform == null
                || transformPosition == null || transformRotation == null || geometry == null
                || vector == null || vectorX == null || vectorY == null || vectorZ == null
                || component == null || components == null || set == null || addChild == null) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node componentCall : program.nodes()) {
            if (componentCall.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(componentCall.fileId())
                    || !exactDomainResolution(componentCall, component, facts)) continue;
            PsiIndex.Node owner = enclosingCallable(componentCall);
            Map<Integer, List<PsiIndex.Node>> componentMap = mapDomainArguments(
                componentCall, component, facts);
            PsiIndex.Node positionArgument = mappedArgument(componentMap, 0);
            PsiIndex.Node rotationArgument = mappedArgument(componentMap, 1);
            PsiIndex.Node vectorCall = directCall(argumentValue(positionArgument));
            Map<Integer, List<PsiIndex.Node>> vectorMap = vectorCall == null
                ? null : mapDomainArguments(vectorCall, vector, facts);
            if (owner == null || owner.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || owner.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                    || vectorCall == null || !exactDomainResolution(vectorCall, vector, facts)
                    || vectorMap == null || rotationArgument == null) continue;
            PsiIndex.Node xValue = argumentValue(mappedArgument(vectorMap, 0));
            PsiIndex.Node yValue = argumentValue(mappedArgument(vectorMap, 1));
            PsiIndex.Node zValue = argumentValue(mappedArgument(vectorMap, 2));
            PsiIndex.Node xReceiver = planeUniqueMemberReceiver(xValue, vectorX, facts);
            PsiIndex.Node yReceiver = planeUniqueMemberReceiver(yValue, vectorY, facts);
            PsiIndex.Node zReceiver = planeUniqueMemberReceiver(zValue, vectorZ, facts);
            PsiIndex.Node positionResult = planeSameValueDeclaration(
                xReceiver, yReceiver, zReceiver, facts);
            PsiIndex.Node rotationResult = planeValueDeclaration(
                argumentValue(rotationArgument), facts);
            List<PsiIndex.Node> positionPath = planePoseConversionPath(
                positionResult, convertPosition, planeTransform, transformPosition, facts);
            List<PsiIndex.Node> rotationPath = planePoseConversionPath(
                rotationResult, convertRotation, planeTransform, transformRotation, facts);
            if (positionPath == null || rotationPath == null
                    || positionPath.get(3).id() != rotationPath.get(3).id()
                    || positionPath.get(4).id() != rotationPath.get(4).id()) continue;
            boolean direct = positionPath.get(2) == null && rotationPath.get(2) == null;
            boolean helper = positionPath.get(2) != null && rotationPath.get(2) != null
                && positionPath.get(2).id() != rotationPath.get(2).id();
            if (!direct && !helper
                    || !planeExpressionHasMemberFrom(xValue, geometry,
                        positionPath.get(4), facts, 0)) continue;

            PsiIndex.Node setCall = planeUniqueContainingCall(
                componentCall, set, owner, facts);
            PsiIndex.Node addCall = planeUniqueDomainCallInCallable(owner, addChild, facts);
            PsiIndex.Node placedAtSet = setCall == null ? null
                : planeMemberReceiver(resolvedReceiver(setCall), components, facts);
            Map<Integer, List<PsiIndex.Node>> addMap = addCall == null
                ? null : mapDomainArguments(addCall, addChild, facts);
            PsiIndex.Node placedAtAdd = argumentValue(mappedArgument(addMap, 0));
            PsiIndex.Node rootAtAdd = addCall == null ? null : resolvedReceiver(addCall);
            if (setCall == null || addCall == null || placedAtSet == null || placedAtAdd == null
                    || !planeSameOrigin(placedAtSet, placedAtAdd, facts)
                    || !planeSameOrigin(rootAtAdd, positionPath.get(3), facts)) continue;

            String alternative = direct
                ? "direct-pose-conversion" : "pure-helper-pose-conversion";
            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(owner, witnesses)
                && addWitness(positionResult, witnesses)
                && addWitness(rotationResult, witnesses)
                && addWitness(positionPath.get(0), witnesses)
                && addWitness(rotationPath.get(0), witnesses)
                && planeAddProofWitness(positionPath.get(5), witnesses)
                && planeAddProofWitness(rotationPath.get(5), witnesses)
                && planeAddProofWitness(xValue, witnesses)
                && addWitness(vectorCall, witnesses)
                && addWitness(componentCall, witnesses)
                && addWitness(setCall, witnesses)
                && addWitness(addCall, witnesses);
            if (helper) {
                valid &= addWitness(positionPath.get(2), witnesses)
                    && addWitness(rotationPath.get(2), witnesses);
            }
            if (!valid) continue;
            Rules.Analysis candidate = planeClaim(
                "plane.anchor-pose", "same-anchor-pose-conversion",
                alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("plane.anchor-pose", matchAlternative);
        return match;
    }
    private Rules.Analysis analyzeCleanupErrors() {
        Rules.SymbolSpec effect = domainSymbolOrNull(
            DISPOSABLE_EFFECT_FQN, DISPOSABLE_EFFECT_SIGNATURE);
        Rules.SymbolSpec dispose = domainSymbolOrNull(ON_DISPOSE_FQN, ON_DISPOSE_SIGNATURE);
        Rules.SymbolSpec subscribe = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate",
            "subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable");
        Rules.SymbolSpec start = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneTrackingManager.start", "start(): Unit");
        Rules.SymbolSpec cancel = domainSymbolOrNull(
            "com.pico.spatial.core.lifecycle.Cancellable.cancel", "cancel(): Unit");
        Rules.SymbolSpec stop = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneTrackingManager.stop", "stop(): Unit");
        Rules.SymbolSpec runCatching = domainSymbolOrNull(
            "kotlin.runCatching", "runCatching(block: () -> R): Result<R>");
        Rules.SymbolSpec disposableScope = typeSymbolExact(
            DISPOSABLE_SCOPE_FQN, DISPOSABLE_SCOPE_SIGNATURE);
        if (effect == null || dispose == null || subscribe == null || start == null
                || cancel == null || stop == null || runCatching == null
                || disposableScope == null
                || !callbackShape(effect, 1, "disposable_effect", "disposable_effect_scope")
                || !callbackShape(dispose, 0, "dispose_cleanup", null)) {
            return Rules.emptyAnalysis();
        }
        List<Map<String, Object>> facts = kernelFacts();
        Rules.Analysis match = null;
        String matchAlternative = null;
        for (PsiIndex.Node effectCall : program.nodes()) {
            if (effectCall.kind() != PsiIndex.NodeKind.CALL
                    || !isProductionPath(effectCall.fileId())
                    || !exactDomainResolution(effectCall, effect, facts)) continue;
            Map<Integer, List<PsiIndex.Node>> effectMap = mapDomainArguments(
                effectCall, effect, facts);
            PsiIndex.Node key = argumentValue(mappedArgument(effectMap, 0));
            PsiIndex.Node effectArgument = mappedArgument(effectMap, 1);
            PsiIndex.Node effectLambda = mappedLambda(effectMap, 1);
            if (effectLambda == null || key == null
                    || !exactFact(facts, "callback_binding", effectLambda, effectCall,
                        effectArgument, "disposable_effect", effect)
                    || !exactFact(facts, "callback_receiver", effectLambda, effectCall,
                        null, "disposable_effect_scope", disposableScope)) continue;
            PsiIndex.Node disposeCall = cp2seUniqueResolvedCall(
                directStatementCallsLoose(effectLambda), dispose, facts);
            Map<Integer, List<PsiIndex.Node>> disposeMap = disposeCall == null
                ? null : mapDomainArguments(disposeCall, dispose, facts);
            PsiIndex.Node disposeArgument = mappedArgument(disposeMap, 0);
            PsiIndex.Node cleanupLambda = mappedLambda(disposeMap, 0);
            if (disposeCall == null || cleanupLambda == null
                    || callbackResult(effectLambda) != disposeCall
                    || !exactFact(facts, "callback_binding", cleanupLambda, disposeCall,
                        disposeArgument, "dispose_cleanup", dispose)) continue;

            PsiIndex.Node acquisitionCall = null;
            PsiIndex.Node acquisition = null;
            for (PsiIndex.Node call : directStatementCallsLoose(effectLambda)) {
                PsiIndex.Node target = exactSourceTarget(call, facts);
                if (target == null
                        || planeUniqueDomainCallInCallable(target, subscribe, facts) == null
                        || planeUniqueDomainCallInCallable(target, start, facts) == null) continue;
                if (acquisitionCall != null) {
                    acquisitionCall = null;
                    acquisition = null;
                    break;
                }
                acquisitionCall = call;
                acquisition = target;
            }
            PsiIndex.Node cleanupCall = null;
            PsiIndex.Node cleanup = null;
            for (PsiIndex.Node call : directStatementCallsLoose(cleanupLambda)) {
                PsiIndex.Node target = exactSourceTarget(call, facts);
                if (target == null) continue;
                if (cleanupCall != null) {
                    cleanupCall = null;
                    cleanup = null;
                    break;
                }
                cleanupCall = call;
                cleanup = target;
            }
            if (acquisitionCall == null || acquisition == null
                    || cleanupCall == null || cleanup == null
                    || !planeSameOrigin(key, resolvedReceiver(acquisitionCall), facts)
                    || !planeSameOrigin(resolvedReceiver(acquisitionCall),
                        resolvedReceiver(cleanupCall), facts)) continue;

            List<PsiIndex.Node> acquirePath = planeCleanupAcquirePath(
                acquisition, cleanup, subscribe, start, facts);
            List<PsiIndex.Node> releasePath = planeCleanupReleasePath(
                cleanup, cancel, stop, runCatching,
                acquirePath == null ? null : acquirePath.get(0), facts);
            if (acquirePath == null || releasePath == null) continue;
            boolean direct = releasePath.get(4) == null && releasePath.get(5) == null;
            boolean helper = releasePath.get(4) != null && releasePath.get(5) != null
                && releasePath.get(4).id() != releasePath.get(5).id();
            if (!direct && !helper) continue;
            String alternative = direct ? "direct-cleanup" : "unique-helper-cleanup";

            List<String> witnesses = new ArrayList<>();
            boolean valid = addWitness(effectCall, witnesses)
                && addWitness(acquisitionCall, witnesses)
                && addWitness(acquirePath.get(3), witnesses)
                && addWitness(acquirePath.get(1), witnesses)
                && addWitness(acquirePath.get(2), witnesses)
                && addWitness(acquirePath.get(4), witnesses)
                && addWitness(disposeCall, witnesses)
                && addWitness(cleanupCall, witnesses)
                && addWitness(cleanup, witnesses)
                && addWitness(releasePath.get(0), witnesses)
                && addWitness(releasePath.get(2), witnesses)
                && addWitness(releasePath.get(3), witnesses)
                && addWitness(releasePath.get(1), witnesses)
                && addWitness(acquirePath.get(5), witnesses)
                && addWitness(acquirePath.get(6), witnesses)
                && addWitness(acquirePath.get(7), witnesses)
                && addWitness(acquirePath.get(8), witnesses);
            if (helper) {
                valid &= addWitness(releasePath.get(4), witnesses)
                    && addWitness(releasePath.get(5), witnesses)
                    && addWitness(releasePath.get(6), witnesses)
                    && addWitness(releasePath.get(7), witnesses);
            }
            if (!valid) continue;
            Rules.Analysis candidate = planeClaim(
                "plane.cleanup-errors", "paired-plane-cleanup-status",
                alternative, witnesses);
            if (candidate == null || match != null) return Rules.emptyAnalysis();
            match = candidate;
            matchAlternative = alternative;
        }
        if (match == null) return Rules.emptyAnalysis();
        selectedAlternativesForTest.put("plane.cleanup-errors", matchAlternative);
        return match;
    }

    private Rules.Analysis planeClaim(String ruleId, String proofForm,
            String alternativeId, List<String> witnesses) {
        Map<String, String> selected = Rules.selectProof(
            domain, ruleId,
            Map.of(proofForm, Boolean.TRUE),
            Map.of(proofForm, List.of(alternativeId)));
        if (selected.size() != 2) return null;
        return Rules.claimOrNull(program, domain, ruleId,
            selected.get("proofForm"), selected.get("alternativeId"), witnesses);
    }

    private boolean planeAddProofWitness(PsiIndex.Node node,
            List<String> witnesses) {
        if (node == null) return false;
        if (node.witnessNodeId() != null) return addWitness(node, witnesses);
        for (PsiIndex.Node candidate : program.nodes()) {
            if (isWithin(candidate, node) && candidate.witnessNodeId() != null) {
                return addWitness(candidate, witnesses);
            }
        }
        return false;
    }

    private PsiIndex.Node planeUniqueDomainCallInFile(int fileId,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.fileId() != fileId || node.kind() != PsiIndex.NodeKind.CALL
                    || !exactDomainResolution(node, symbol, facts)) continue;
            if (match != null) return null;
            match = node;
        }
        return match;
    }

    private PsiIndex.Node planeRetryRetainedExit(PsiIndex.Node loop,
            PsiIndex.Node success, List<Map<String, Object>> facts) {
        if (success == null) return null;
        PsiIndex.Node match = null;
        for (Map<String, Object> fact : facts) {
            if (!"retained_exit".equals(fact.get("kind"))
                    || !Long.valueOf(loop.id()).equals(fact.get("ownerNodeId"))
                    || !Long.valueOf(success.id()).equals(fact.get("relatedNodeId"))
                    || !"".equals(fact.get("value"))) continue;
            PsiIndex.Node candidate = program.node(
                ((Long) fact.get("subjectNodeId")).intValue());
            if (match != null && match.id() != candidate.id()) return null;
            match = candidate;
        }
        return match;
    }

    private boolean planeRetryZero(PsiIndex.Node node) {
        Integer value = planeRetryIntegerLiteral(node);
        return value != null && value == 0;
    }

    private boolean planeRetryMultipleBound(PsiIndex.Node node,
            List<Map<String, Object>> facts) {
        Integer value = planeRetryIntegerLiteral(node);
        if (value != null) return value > 1;
        if (node == null || node.kind() != PsiIndex.NodeKind.NAME_REF) return false;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", node.id());
        if (declaration == null) declaration = findLexicalDeclaration(node, node.name());
        return declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
            && declaration.flags().contains(PsiIndex.NodeFlag.CONST)
            && planeRetryMultipleBound(one(declaration, PsiIndex.EdgeRole.INITIALIZER), facts);
    }

    private boolean planeRetryPositiveBound(PsiIndex.Node node,
            List<Map<String, Object>> facts) {
        Integer value = planeRetryIntegerLiteral(node);
        if (value != null) return value > 0;
        if (node == null || node.kind() != PsiIndex.NodeKind.NAME_REF) return false;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", node.id());
        if (declaration == null) declaration = findLexicalDeclaration(node, node.name());
        return declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
            && declaration.flags().contains(PsiIndex.NodeFlag.CONST)
            && planeRetryPositiveBound(one(declaration, PsiIndex.EdgeRole.INITIALIZER), facts);
    }

    private Integer planeRetryIntegerLiteral(PsiIndex.Node node) {
        if (node == null || node.kind() != PsiIndex.NodeKind.LITERAL
                || !"int".equals(literalType(node))) return null;
        String raw = node.value();
        if (raw == null) return null;
        try {
            return Integer.valueOf(raw.replace("_", ""));
        } catch (NumberFormatException invalid) {
            return null;
        }
    }

    private PsiIndex.Node planeRetryComparisonBound(PsiIndex.Node comparison) {
        if (comparison == null || comparison.kind() != PsiIndex.NodeKind.BINARY) return null;
        PsiIndex.Node left = one(comparison, PsiIndex.EdgeRole.LEFT);
        PsiIndex.Node right = one(comparison, PsiIndex.EdgeRole.RIGHT);
        if (left != null && left.kind() == PsiIndex.NodeKind.NAME_REF) return right;
        if (right != null && right.kind() == PsiIndex.NodeKind.NAME_REF) return left;
        return null;
    }

    private List<PsiIndex.Node> planeSelectorPath(PsiIndex.Node expression,
            PsiIndex.Node fallback, PsiIndex.Node loaded,
            Rules.SymbolSpec semanticEntry, Rules.SymbolSpec filter,
            Rules.SymbolSpec selector, Rules.SymbolSpec upward,
            Rules.SymbolSpec downward, List<Map<String, Object>> facts) {
        PsiIndex.Node entryCall = directCall(expression);
        if (entryCall == null || hasAnyTaint(entryCall, facts)) return null;
        PsiIndex.Node helperCall = null;
        PsiIndex.Node selectorCall = entryCall;
        if (!exactDomainResolution(selectorCall, selector, facts)) {
            PsiIndex.Node helper = exactSourceTarget(entryCall, facts);
            PsiIndex.Node returned = helper == null ? null : sourceReturnOrigin(helper);
            selectorCall = directCall(returned);
            if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isProductionPath(helper.fileId()) || selectorCall == null
                    || hasAnyTaint(helper, facts) || hasAnyTaint(selectorCall, facts)
                    || !exactDomainResolution(selectorCall, selector, facts)) return null;
            helperCall = entryCall;
        }
        PsiIndex.Node filterCall = exactInitializerCall(resolvedReceiver(selectorCall),
            filter.fqn(), filter.signature(), facts);
        PsiIndex.Node collection = filterCall == null
            ? null : resolvedReceiver(filterCall);
        if (planeExactSelectorCollectionProducer(
                collection, entryCall, fallback, loaded, facts) == null) return null;
        PsiIndex.Node semantic = planeUniqueRelatedFact(
            filterCall, "same_element", "semantic", facts);
        PsiIndex.Node orientation = planeUniqueRelatedFact(
            filterCall, "same_element", "orientation", facts);
        PsiIndex.Node area = planeUniqueRelatedFact(
            filterCall, "same_element", "area", facts);
        PsiIndex.Node selection = planeUniqueRelatedFact(
            selectorCall, "same_element", "selection", facts);
        if (filterCall == null || semantic == null || orientation == null || area == null
                || selection == null
                || !planeContainsExactSymbol(semantic, semanticEntry, facts)
                || !planeContainsExactSymbol(orientation, upward, facts)
                || !planeContainsExactSymbol(orientation, downward, facts)
                || !planePositiveAreaBoundary(area)) return null;
        List<PsiIndex.Node> path = new ArrayList<>();
        path.add(selectorCall);
        path.add(filterCall);
        path.add(semantic);
        path.add(orientation);
        path.add(area);
        path.add(helperCall);
        return path;
    }

    private PsiIndex.Node planeExactSelectorCollectionProducer(PsiIndex.Node receiver,
            PsiIndex.Node entryCall, PsiIndex.Node fallback, PsiIndex.Node expected,
            List<Map<String, Object>> facts) {
        PsiIndex.Node direct = exactCollectionProducerOrigin(receiver, facts);
        if (direct != null) return expected != null && direct.id() == expected.id()
            ? direct : null;
        if (receiver == null || receiver.kind() != PsiIndex.NodeKind.NAME_REF
                || receiver.name() == null || qualifiedSelectorParent(receiver) != null
                || entryCall == null || fallback == null || expected == null) return null;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", receiver.id());
        if (declaration == null) {
            declaration = findLexicalDeclaration(receiver, receiver.name());
        }
        PsiIndex.Node helper = enclosingFunctionDeclaration(receiver);
        PsiIndex.Node caller = enclosingFunctionDeclaration(entryCall);
        PsiIndex.Node ownerType = declaration == null
            ? null : enclosingTypeDeclaration(declaration);
        if (declaration == null || declaration.kind() != PsiIndex.NodeKind.PROPERTY_DECL
                || !declaration.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || !declaration.flags().contains(PsiIndex.NodeFlag.VAR)
                || !"plane_anchor".equals(declaredCollectionElementType(declaration, facts))
                || helper == null || !helper.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || exactSourceTarget(entryCall, facts) != helper
                || caller == null || ownerType == null
                || enclosingTypeDeclaration(helper) != ownerType
                || enclosingTypeDeclaration(caller) != ownerType
                || !isWithin(entryCall, fallback)) return null;
        int helperCalls = 0;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() == PsiIndex.NodeKind.CALL
                    && exactSourceTarget(call, facts) == helper) helperCalls++;
        }
        if (helperCalls != 1) return null;

        PsiIndex.Node assignment = null;
        for (PsiIndex.Node candidate : program.nodes()) {
            if (candidate.kind() != PsiIndex.NodeKind.ASSIGNMENT
                    || !isWithin(candidate, ownerType)
                    || planeAssignmentTargetDeclaration(candidate, facts) != declaration) continue;
            if (assignment != null) return null;
            assignment = candidate;
        }
        PsiIndex.Node value = assignment == null
            ? null : one(assignment, PsiIndex.EdgeRole.VALUE);
        PsiIndex.Node producer = exactCollectionProducerOrigin(value, facts);
        PsiIndex.Node lambda = assignment == null ? null : enclosingLambda(assignment);
        PsiIndex.Node repeatCall = lambda == null ? null : callbackInvocation(lambda, facts);
        Rules.SymbolSpec repeat = domainSymbolOrNull(
            "kotlin.repeat", "repeat(times: Int, action: (Int) -> Unit): Unit");
        Map<Integer, List<PsiIndex.Node>> mapping = repeatCall == null || repeat == null
            ? null : mapDomainArguments(repeatCall, repeat, facts);
        PsiIndex.Node countArgument = mappedArgument(mapping, 0);
        PsiIndex.Node repeatLambda = mappedLambda(mapping, 1);
        PsiIndex.Node body = lambda == null ? null : one(lambda, PsiIndex.EdgeRole.LAMBDA_BODY);
        PsiIndex.Node predecessor = lexicalPredecessor(fallback, caller);
        if (assignment == null || producer == null || producer.id() != expected.id()
                || enclosingFunctionDeclaration(assignment) != caller) return null;
        if (repeatCall != null && exactDomainResolution(repeatCall, repeat, facts)
                && repeatLambda == lambda
                && planeRetryPositiveBound(argumentValue(countArgument), facts)
                && firstBoundary(body) == assignment
                && directCall(predecessor) == repeatCall) return producer;
        return planeExactRetainedForProducer(
            assignment, producer, fallback, caller, facts) ? producer : null;
    }

    private boolean planeExactRetainedForProducer(PsiIndex.Node assignment,
            PsiIndex.Node producer, PsiIndex.Node consumer, PsiIndex.Node caller,
            List<Map<String, Object>> facts) {
        PsiIndex.Node loop = planeNearestAncestor(assignment, PsiIndex.NodeKind.FOR);
        Rules.SymbolSpec until = domainSymbolOrNull(
            "kotlin.ranges.until", "Int.until(to: Int): IntRange");
        PsiIndex.Node range = loop == null ? null : one(loop, PsiIndex.EdgeRole.RANGE);
        PsiIndex.Node body = loop == null ? null : one(loop, PsiIndex.EdgeRole.LOOP_BODY);
        PsiIndex.Node value = one(assignment, PsiIndex.EdgeRole.VALUE);
        PsiIndex.Node local = localValueOrigin(value, facts);
        PsiIndex.Node initializer = local == null
            ? null : one(local, PsiIndex.EdgeRole.INITIALIZER);
        PsiIndex.Node localProducer = exactCollectionProducerOrigin(initializer, facts);
        if (loop == null || until == null || range == null
                || range.kind() != PsiIndex.NodeKind.BINARY
                || !exactDomainResolution(range, until, facts)
                || !planeRetryZero(one(range, PsiIndex.EdgeRole.LEFT))
                || !planeRetryPositiveBound(one(range, PsiIndex.EdgeRole.RIGHT), facts)
                || enclosingFunctionDeclaration(loop) != caller
                || !planeEarlierSiblingInCallable(loop, consumer, caller)
                || body == null || local == null
                || !local.flags().contains(PsiIndex.NodeFlag.VAL)
                || local.flags().contains(PsiIndex.NodeFlag.VAR)
                || !isWithin(local, body)
                || firstBoundary(body) != local
                || lexicalPredecessor(assignment, loop) != local
                || localProducer == null
                || localProducer.id() != producer.id()) return false;
        return true;
    }

    private boolean planeEarlierSiblingInCallable(PsiIndex.Node earlier,
            PsiIndex.Node nested, PsiIndex.Node callable) {
        if (earlier == null || nested == null || callable == null
                || enclosingFunctionDeclaration(earlier) != callable
                || enclosingFunctionDeclaration(nested) != callable) return false;
        Integer statementOwnerId = lexicalOwners.get(earlier.id());
        if (statementOwnerId == null) return false;
        PsiIndex.Node current = nested;
        Integer ownerId = lexicalOwners.get(current.id());
        while (ownerId != null && !ownerId.equals(statementOwnerId)) {
            PsiIndex.Node owner = program.node(ownerId);
            if (owner.id() == callable.id()) return false;
            current = owner;
            ownerId = lexicalOwners.get(current.id());
        }
        if (ownerId == null) return false;
        List<PsiIndex.Node> siblings = lexicalChildren(program.node(statementOwnerId));
        int earlierIndex = -1;
        int nestedIndex = -1;
        for (int index = 0; index < siblings.size(); index++) {
            if (siblings.get(index).id() == earlier.id()) earlierIndex = index;
            if (siblings.get(index).id() == current.id()) nestedIndex = index;
        }
        return earlierIndex >= 0 && nestedIndex > earlierIndex;
    }

    private PsiIndex.Node planeUniqueRelatedFact(PsiIndex.Node subject, String kind,
            String value, List<Map<String, Object>> facts) {
        if (subject == null) return null;
        PsiIndex.Node match = null;
        for (Map<String, Object> fact : facts) {
            if (!kind.equals(fact.get("kind")) || !value.equals(fact.get("value"))
                    || !Long.valueOf(subject.id()).equals(fact.get("subjectNodeId"))) continue;
            int relatedId = ((Long) fact.get("relatedNodeId")).intValue();
            if (relatedId < 0) return null;
            PsiIndex.Node candidate = program.node(relatedId);
            if (match != null && match.id() != candidate.id()) return null;
            match = candidate;
        }
        return match;
    }

    private boolean planeContainsExactSymbol(PsiIndex.Node expression,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        if (expression == null || symbol == null) return false;
        int matches = 0;
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))) continue;
            Rules.SymbolSpec observed = symbolForFact(facts, "call_resolution", node.id());
            if (observed == symbol) matches++;
        }
        return matches == 1;
    }

    private boolean planePositiveAreaBoundary(PsiIndex.Node boundary) {
        if (boundary == null || boundary.kind() != PsiIndex.NodeKind.BINARY
                || !">".equals(boundary.value())) return false;
        PsiIndex.Node zero = one(boundary, PsiIndex.EdgeRole.RIGHT);
        if (zero == null || zero.kind() != PsiIndex.NodeKind.LITERAL) return false;
        String value = zero.value();
        return "0".equals(value) || "0f".equalsIgnoreCase(value)
            || "0.0".equals(value) || "0.0f".equalsIgnoreCase(value);
    }

    private boolean planeFallbackConsumed(PsiIndex.Node fallback,
            List<Map<String, Object>> facts) {
        PsiIndex.Node owner = enclosingCallable(fallback);
        if (owner == null || owner.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                || owner.flags().contains(PsiIndex.NodeFlag.PRIVATE)) return false;
        PsiIndex.Node property = null;
        Integer ownerId = lexicalOwners.get(fallback.id());
        while (ownerId != null) {
            PsiIndex.Node candidate = program.node(ownerId);
            if (candidate.kind() == PsiIndex.NodeKind.PROPERTY_DECL) {
                property = candidate;
                break;
            }
            if (candidate.id() == owner.id()) break;
            ownerId = lexicalOwners.get(candidate.id());
        }
        if (property == null) {
            PsiIndex.Node returned = sourceReturnOrigin(owner);
            return returned != null && (returned.id() == fallback.id()
                || isWithin(fallback, returned));
        }
        Rules.SymbolSpec transform = domainSymbolOrNull(
            "com.pico.spatial.sense.plane.PlaneAnchor.transform", "transform: Transform");
        if (transform == null) return false;
        for (PsiIndex.Node access : program.nodes()) {
            if (enclosingCallable(access) != owner
                    || symbolForFact(facts, "call_resolution", access.id()) != transform) continue;
            PsiIndex.Node qualified = qualifiedSelectorParent(access);
            PsiIndex.Node receiver = qualified == null
                ? null : one(qualified, PsiIndex.EdgeRole.RECEIVER);
            PsiIndex.Node declaration = receiver == null
                ? null : relatedNodeForFact(facts, "def_use", receiver.id());
            if (declaration == null && receiver != null
                    && receiver.kind() == PsiIndex.NodeKind.NAME_REF) {
                declaration = findLexicalDeclaration(receiver, receiver.name());
            }
            if (declaration != null && declaration.id() == property.id()) return true;
        }
        return false;
    }

    private PsiIndex.Node planeUniqueMemberReceiver(PsiIndex.Node expression,
            Rules.SymbolSpec member, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        if (expression == null) return null;
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))
                    || symbolForFact(facts, "call_resolution", node.id()) != member) continue;
            PsiIndex.Node qualified = qualifiedSelectorParent(node);
            PsiIndex.Node receiver = qualified == null
                ? null : one(qualified, PsiIndex.EdgeRole.RECEIVER);
            if (receiver == null || match != null && match.id() != receiver.id()) return null;
            match = receiver;
        }
        return match;
    }

    private PsiIndex.Node planeValueDeclaration(PsiIndex.Node value,
            List<Map<String, Object>> facts) {
        if (value == null || value.kind() != PsiIndex.NodeKind.NAME_REF) return null;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", value.id());
        if (declaration == null) declaration = findLexicalDeclaration(value, value.name());
        return declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
            ? declaration : null;
    }

    private PsiIndex.Node planeSameValueDeclaration(PsiIndex.Node first,
            PsiIndex.Node second, PsiIndex.Node third, List<Map<String, Object>> facts) {
        PsiIndex.Node left = planeValueDeclaration(first, facts);
        PsiIndex.Node middle = planeValueDeclaration(second, facts);
        PsiIndex.Node right = planeValueDeclaration(third, facts);
        return left != null && middle != null && right != null
                && left.id() == middle.id() && left.id() == right.id() ? left : null;
    }

    private List<PsiIndex.Node> planePoseConversionPath(PsiIndex.Node result,
            Rules.SymbolSpec conversion, Rules.SymbolSpec planeTransform,
            Rules.SymbolSpec terminal, List<Map<String, Object>> facts) {
        PsiIndex.Node initializer = result == null
            ? null : one(result, PsiIndex.EdgeRole.INITIALIZER);
        PsiIndex.Node entry = directCall(initializer);
        if (entry == null || hasAnyTaint(entry, facts)) return null;
        PsiIndex.Node conversionCall = entry;
        PsiIndex.Node helper = null;
        if (!exactDomainResolution(conversionCall, conversion, facts)) {
            helper = exactSourceTarget(entry, facts);
            PsiIndex.Node returned = helper == null ? null : sourceReturnOrigin(helper);
            conversionCall = directCall(returned);
            if (helper == null || helper.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                    || !isProductionPath(helper.fileId()) || returned == null
                    || conversionCall == null || hasAnyTaint(helper, facts)
                    || hasAnyTaint(conversionCall, facts)
                    || !exactDomainResolution(conversionCall, conversion, facts)) return null;
        }
        Map<Integer, List<PsiIndex.Node>> conversionMap = mapDomainArguments(
            conversionCall, conversion, facts);
        PsiIndex.Node sourceArgument = mappedArgument(conversionMap, 0);
        PsiIndex.Node baseArgument = mappedArgument(conversionMap, 1);
        PsiIndex.Node sourceValue = argumentValue(sourceArgument);
        if (sourceArgument == null || baseArgument == null
                || !isNullLiteral(argumentValue(baseArgument))
                || !planeContainsExactSymbol(sourceValue, terminal, facts)) return null;
        PsiIndex.Node transformRead = planeUniqueResolvedNode(
            sourceValue, planeTransform, facts);
        PsiIndex.Node transformQualified = transformRead == null
            ? null : qualifiedSelectorParent(transformRead);
        PsiIndex.Node anchor = transformQualified == null
            ? null : one(transformQualified, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node root = resolvedReceiver(conversionCall);
        if (anchor == null || root == null) return null;
        if (helper != null) {
            root = planeMappedHelperOrigin(root, helper, entry, facts);
            anchor = planeMappedHelperOrigin(anchor, helper, entry, facts);
        } else {
            root = representativeOrigin(root, facts);
            anchor = representativeOrigin(anchor, facts);
        }
        if (root == null || anchor == null) return null;
        List<PsiIndex.Node> path = new ArrayList<>();
        path.add(entry);
        path.add(conversionCall);
        path.add(helper);
        path.add(root);
        path.add(anchor);
        path.add(transformRead);
        return path;
    }

    private PsiIndex.Node planeMappedHelperOrigin(PsiIndex.Node inner,
            PsiIndex.Node helper, PsiIndex.Node call, List<Map<String, Object>> facts) {
        if (inner == null || inner.kind() != PsiIndex.NodeKind.NAME_REF) return null;
        PsiIndex.Node parameter = relatedNodeForFact(facts, "def_use", inner.id());
        if (parameter == null) parameter = findLexicalDeclaration(inner, inner.name());
        List<PsiIndex.Node> parameters = targets(helper, PsiIndex.EdgeRole.PARAMETER);
        int position = parameters.indexOf(parameter);
        Map<Integer, List<PsiIndex.Node>> mapping = mapSourceArguments(call, helper, facts);
        PsiIndex.Node argument = position < 0 ? null : mappedArgument(mapping, position);
        return representativeOrigin(argumentValue(argument), facts);
    }

    private PsiIndex.Node planeUniqueResolvedNode(PsiIndex.Node expression,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        if (expression == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))
                    || symbolForFact(facts, "call_resolution", node.id()) != symbol) continue;
            if (match != null) return null;
            match = node;
        }
        return match;
    }

    private boolean planeExpressionHasMemberFrom(PsiIndex.Node expression,
            Rules.SymbolSpec member, PsiIndex.Node expected,
            List<Map<String, Object>> facts, int depth) {
        if (expression == null || expected == null || depth > 5) return false;
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))) continue;
            if (symbolForFact(facts, "call_resolution", node.id()) == member) {
                PsiIndex.Node qualified = qualifiedSelectorParent(node);
                PsiIndex.Node receiver = qualified == null
                    ? null : one(qualified, PsiIndex.EdgeRole.RECEIVER);
                if (planeSameOrigin(receiver, expected, facts)) return true;
            }
        }
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))
                    || node.kind() != PsiIndex.NodeKind.NAME_REF) continue;
            PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", node.id());
            if (declaration == null) declaration = findLexicalDeclaration(node, node.name());
            PsiIndex.Node initializer = declaration == null
                ? null : one(declaration, PsiIndex.EdgeRole.INITIALIZER);
            if (initializer != null && planeExpressionHasMemberFrom(
                    initializer, member, expected, facts, depth + 1)) return true;
        }
        return false;
    }

    private boolean planeSameOrigin(PsiIndex.Node left, PsiIndex.Node right,
            List<Map<String, Object>> facts) {
        PsiIndex.Node leftOrigin = representativeOrigin(left, facts);
        PsiIndex.Node rightOrigin = representativeOrigin(right, facts);
        return leftOrigin != null && rightOrigin != null
            && leftOrigin.id() == rightOrigin.id();
    }

    private PsiIndex.Node planeUniqueContainingCall(PsiIndex.Node nested,
            Rules.SymbolSpec symbol, PsiIndex.Node owner,
            List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || enclosingCallable(call) != owner
                    || !isWithin(nested, call)
                    || !exactDomainResolution(call, symbol, facts)) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node planeUniqueDomainCallInCallable(PsiIndex.Node callable,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || enclosingCallable(call) != callable
                    || !exactDomainResolution(call, symbol, facts)) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node planeMemberReceiver(PsiIndex.Node expression,
            Rules.SymbolSpec member, List<Map<String, Object>> facts) {
        PsiIndex.Node access = planeUniqueResolvedNode(expression, member, facts);
        PsiIndex.Node qualified = access == null ? null : qualifiedSelectorParent(access);
        return qualified == null ? null : one(qualified, PsiIndex.EdgeRole.RECEIVER);
    }

    private List<PsiIndex.Node> planeCleanupAcquirePath(PsiIndex.Node acquisition,
            PsiIndex.Node cleanup, Rules.SymbolSpec subscribe, Rules.SymbolSpec start,
            List<Map<String, Object>> facts) {
        PsiIndex.Node subscribeCall = planeUniqueDomainCallInCallable(
            acquisition, subscribe, facts);
        PsiIndex.Node startCall = planeUniqueDomainCallInCallable(
            acquisition, start, facts);
        PsiIndex.Node subscriptionAssignment = planeNearestAncestor(
            subscribeCall, PsiIndex.NodeKind.ASSIGNMENT);
        PsiIndex.Node subscriptionProperty = planeAssignmentTargetDeclaration(
            subscriptionAssignment, facts);
        Map<Integer, List<PsiIndex.Node>> subscribeMap = subscribeCall == null
            ? null : mapDomainArguments(subscribeCall, subscribe, facts);
        PsiIndex.Node subscribeArgument = mappedArgument(subscribeMap, 0);
        PsiIndex.Node subscribeLambda = mappedLambda(subscribeMap, 0);
        if (subscribeCall == null || startCall == null || subscriptionAssignment == null
                || subscriptionProperty == null || subscribeLambda == null
                || !exactFact(facts, "callback_binding", subscribeLambda, subscribeCall,
                    subscribeArgument, "anchor_update", subscribe)) return null;

        PsiIndex.Node sessionType = planeEnclosingType(acquisition);
        List<PsiIndex.Node> status = planeStatusFamily(sessionType, facts);
        if (status == null) return null;
        PsiIndex.Node statusProperty = planeStatusProperty(
            sessionType, status.get(0));
        if (statusProperty == null) return null;
        PsiIndex.Node searching = planeStatusAssignment(
            acquisition, statusProperty, status.get(1), facts);
        PsiIndex.Node noSurface = planeStatusAssignment(
            sessionType, statusProperty, status.get(2), facts);
        PsiIndex.Node placed = planeStatusAssignment(
            sessionType, statusProperty, status.get(3), facts);
        PsiIndex.Node startTry = planeNearestAncestor(startCall, PsiIndex.NodeKind.TRY);
        if (startTry == null) return null;
        PsiIndex.Node acceptedCatch = null;
        PsiIndex.Node error = null;
        for (PsiIndex.Node candidate : targets(startTry, PsiIndex.EdgeRole.CATCH_CLAUSE)) {
            PsiIndex.Node candidateError = planeStatusAssignment(
                candidate, statusProperty, status.get(4), facts);
            PsiIndex.Node catchCleanup = planeUniqueSourceCallTo(candidate, cleanup, facts);
            if (candidateError == null || catchCleanup == null) continue;
            if (acceptedCatch != null) return null;
            acceptedCatch = candidate;
            error = candidateError;
        }
        if (searching == null || noSurface == null || placed == null
                || acceptedCatch == null || error == null) return null;
        List<PsiIndex.Node> path = new ArrayList<>();
        path.add(subscriptionProperty);
        path.add(subscribeCall);
        path.add(startCall);
        path.add(subscriptionAssignment);
        path.add(acceptedCatch);
        path.add(searching);
        path.add(noSurface);
        path.add(placed);
        path.add(error);
        return path;
    }

    private List<PsiIndex.Node> planeCleanupReleasePath(PsiIndex.Node cleanup,
            Rules.SymbolSpec cancel, Rules.SymbolSpec stop, Rules.SymbolSpec runCatching,
            PsiIndex.Node subscriptionProperty, List<Map<String, Object>> facts) {
        if (cleanup == null || subscriptionProperty == null) return null;
        PsiIndex.Node cancelCall = planeUniqueDomainCallWithin(cleanup, cancel, facts);
        PsiIndex.Node stopCall = planeUniqueDomainCallWithin(cleanup, stop, facts);
        PsiIndex.Node cancelHelper = null;
        PsiIndex.Node stopHelper = null;
        PsiIndex.Node cancelHelperCall = null;
        PsiIndex.Node stopHelperCall = null;
        if (cancelCall == null || stopCall == null) {
            for (PsiIndex.Node call : directStatementCallsLoose(cleanup)) {
                PsiIndex.Node target = exactSourceTarget(call, facts);
                if (target == null || target.kind() != PsiIndex.NodeKind.FUNCTION_DECL
                        || !isProductionPath(target.fileId()) || hasAnyTaint(target, facts)) continue;
                PsiIndex.Node candidateCancel = planeUniqueDomainCallWithin(target, cancel, facts);
                PsiIndex.Node candidateStop = planeUniqueDomainCallWithin(target, stop, facts);
                if (candidateCancel != null && candidateStop != null) return null;
                if (candidateCancel != null) {
                    if (cancelHelper != null) return null;
                    cancelHelper = target;
                    cancelHelperCall = call;
                    cancelCall = candidateCancel;
                } else if (candidateStop != null) {
                    if (stopHelper != null) return null;
                    stopHelper = target;
                    stopHelperCall = call;
                    stopCall = candidateStop;
                }
            }
        }
        boolean direct = cancelCall != null && stopCall != null
            && cancelHelper == null && stopHelper == null;
        boolean helper = cancelCall != null && stopCall != null
            && cancelHelper != null && stopHelper != null;
        if (!direct && !helper) return null;
        PsiIndex.Node cancelOwner = cancelHelper == null ? cleanup : cancelHelper;
        PsiIndex.Node nullAssignment = planeUniqueNullAssignment(
            cancelOwner, subscriptionProperty, facts);
        PsiIndex.Node cancelReceiver = resolvedReceiver(cancelCall);
        PsiIndex.Node cancelDeclaration = cancelReceiver == null ? null
            : relatedNodeForFact(facts, "def_use", cancelReceiver.id());
        if (cancelDeclaration == null && cancelReceiver != null
                && cancelReceiver.kind() == PsiIndex.NodeKind.NAME_REF) {
            cancelDeclaration = findLexicalDeclaration(cancelReceiver, cancelReceiver.name());
        }
        PsiIndex.Node run = planeUniqueContainingDomainCall(
            stopCall, runCatching, facts);
        Map<Integer, List<PsiIndex.Node>> runMap = run == null
            ? null : mapDomainArguments(run, runCatching, facts);
        PsiIndex.Node runArgument = mappedArgument(runMap, 0);
        PsiIndex.Node runLambda = mappedLambda(runMap, 0);
        if (nullAssignment == null || cancelDeclaration == null
                || cancelDeclaration.id() != subscriptionProperty.id()
                || runLambda == null || !isWithin(stopCall, runLambda)
                || !exactFact(facts, "callback_binding", runLambda, run,
                    runArgument, "inline_block", runCatching)) return null;
        List<PsiIndex.Node> path = new ArrayList<>();
        path.add(cancelCall);
        path.add(stopCall);
        path.add(nullAssignment);
        path.add(run);
        path.add(cancelHelper);
        path.add(stopHelper);
        path.add(cancelHelperCall);
        path.add(stopHelperCall);
        return path;
    }

    private PsiIndex.Node planeUniqueDomainCallWithin(PsiIndex.Node scope,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        if (scope == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, scope)
                    || !exactDomainResolution(call, symbol, facts)) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node planeUniqueContainingDomainCall(PsiIndex.Node nested,
            Rules.SymbolSpec symbol, List<Map<String, Object>> facts) {
        if (nested == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(nested, call)
                    || !exactDomainResolution(call, symbol, facts)) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node planeNearestAncestor(PsiIndex.Node node,
            PsiIndex.NodeKind kind) {
        Integer owner = node == null ? null : lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (candidate.kind() == kind) return candidate;
            if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL) return null;
            owner = lexicalOwners.get(candidate.id());
        }
        return null;
    }

    private PsiIndex.Node planeAssignmentTargetDeclaration(PsiIndex.Node assignment,
            List<Map<String, Object>> facts) {
        PsiIndex.Node target = assignment == null
            ? null : one(assignment, PsiIndex.EdgeRole.TARGET);
        if (target == null) return null;
        PsiIndex.Node receiver = target.kind() == PsiIndex.NodeKind.QUALIFIED
                || target.kind() == PsiIndex.NodeKind.SAFE_QUALIFIED
            ? one(target, PsiIndex.EdgeRole.SELECTOR) : target;
        if (receiver == null || receiver.kind() != PsiIndex.NodeKind.NAME_REF) return null;
        PsiIndex.Node declaration = relatedNodeForFact(facts, "def_use", receiver.id());
        if (declaration == null) declaration = findLexicalDeclaration(receiver, receiver.name());
        return declaration != null && declaration.kind() == PsiIndex.NodeKind.PROPERTY_DECL
            ? declaration : null;
    }

    private PsiIndex.Node planeEnclosingType(PsiIndex.Node node) {
        Integer owner = node == null ? null : lexicalOwners.get(node.id());
        while (owner != null) {
            PsiIndex.Node candidate = program.node(owner);
            if (isTypeDeclaration(candidate)) return candidate;
            owner = lexicalOwners.get(candidate.id());
        }
        return null;
    }

    private List<PsiIndex.Node> planeStatusFamily(PsiIndex.Node sessionType,
            List<Map<String, Object>> facts) {
        if (sessionType == null) return null;
        List<PsiIndex.Node> match = null;
        for (PsiIndex.Node status : program.nodes()) {
            if (status.fileId() != sessionType.fileId()
                    || status.kind() != PsiIndex.NodeKind.INTERFACE_DECL
                    || !status.flags().contains(PsiIndex.NodeFlag.SEALED)) continue;
            List<PsiIndex.Node> current = new ArrayList<>();
            current.add(status);
            for (String name : List.of("Searching", "NoSurface", "Placed", "Error")) {
                PsiIndex.Node member = null;
                for (PsiIndex.Node child : lexicalChildren(status)) {
                    if (!name.equals(child.name()) || !isTypeDeclaration(child)
                            || !planeHasSourceSupertype(child, status)) continue;
                    if (member != null) {
                        member = null;
                        break;
                    }
                    member = child;
                }
                if (member == null) {
                    current.clear();
                    break;
                }
                current.add(member);
            }
            if (current.size() != 5) continue;
            if (match != null) return null;
            match = current;
        }
        return match;
    }

    private boolean planeHasSourceSupertype(PsiIndex.Node member,
            PsiIndex.Node status) {
        for (PsiIndex.Node superType : targets(member, PsiIndex.EdgeRole.SUPER_TYPE)) {
            PsiIndex.Node source = sourceTypeDeclaration(superType);
            if (source != null && source.id() == status.id()) return true;
        }
        return false;
    }

    private PsiIndex.Node planeStatusProperty(PsiIndex.Node sessionType,
            PsiIndex.Node status) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node child : lexicalChildren(sessionType)) {
            if (child.kind() != PsiIndex.NodeKind.PROPERTY_DECL) continue;
            PsiIndex.Node type = declarationTypeNode(child, false);
            PsiIndex.Node source = type == null ? null : sourceTypeDeclaration(type);
            if (source == null || source.id() != status.id()) continue;
            if (match != null) return null;
            match = child;
        }
        return match;
    }

    private PsiIndex.Node planeStatusAssignment(PsiIndex.Node scope,
            PsiIndex.Node statusProperty, PsiIndex.Node statusMember,
            List<Map<String, Object>> facts) {
        if (scope == null || statusProperty == null || statusMember == null) return null;
        PsiIndex.Node match = null;
        for (PsiIndex.Node assignment : program.nodes()) {
            if (assignment.kind() != PsiIndex.NodeKind.ASSIGNMENT
                    || !isWithin(assignment, scope)
                    || planeAssignmentTargetDeclaration(assignment, facts) != statusProperty
                    || !planeExpressionTargetsSource(
                        one(assignment, PsiIndex.EdgeRole.VALUE), statusMember, facts)) continue;
            if (match != null) return null;
            match = assignment;
        }
        return match;
    }

    private boolean planeExpressionTargetsSource(PsiIndex.Node expression,
            PsiIndex.Node declaration, List<Map<String, Object>> facts) {
        if (expression == null) return false;
        int matches = 0;
        for (PsiIndex.Node node : program.nodes()) {
            if (!(node.id() == expression.id() || isWithin(node, expression))) continue;
            PsiIndex.Node target = relatedNodeForFact(facts, "call_resolution", node.id());
            if (target != null && target.id() == declaration.id()) matches++;
        }
        if (matches == 1) return true;
        if (matches != 0 || expression.kind() != PsiIndex.NodeKind.QUALIFIED
                || declaration.name() == null) return false;
        Integer ownerId = lexicalOwners.get(declaration.id());
        PsiIndex.Node sourceOwner = ownerId == null ? null : program.node(ownerId);
        PsiIndex.Node receiver = one(expression, PsiIndex.EdgeRole.RECEIVER);
        PsiIndex.Node selector = one(expression, PsiIndex.EdgeRole.SELECTOR);
        if (sourceOwner == null || sourceValueDeclaration(receiver, facts) != sourceOwner
                || selector == null || !declaration.name().equals(selector.name())
                || hasFact(facts, "call_resolution", selector.id())
                || !hasExactTaint(selector, "unknown_receiver", facts)) return false;
        if (declaration.kind() == PsiIndex.NodeKind.OBJECT_DECL) {
            return selector.kind() == PsiIndex.NodeKind.NAME_REF;
        }
        return declaration.kind() == PsiIndex.NodeKind.CLASS_DECL
            && selector.kind() == PsiIndex.NodeKind.CALL
            && mapSourceArguments(selector, declaration, facts) != null;
    }

    private PsiIndex.Node planeUniqueSourceCallTo(PsiIndex.Node scope,
            PsiIndex.Node target, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node call : program.nodes()) {
            if (call.kind() != PsiIndex.NodeKind.CALL || !isWithin(call, scope)
                    || exactSourceTarget(call, facts) != target) continue;
            if (match != null) return null;
            match = call;
        }
        return match;
    }

    private PsiIndex.Node planeUniqueNullAssignment(PsiIndex.Node scope,
            PsiIndex.Node property, List<Map<String, Object>> facts) {
        PsiIndex.Node match = null;
        for (PsiIndex.Node assignment : program.nodes()) {
            if (assignment.kind() != PsiIndex.NodeKind.ASSIGNMENT
                    || !isWithin(assignment, scope)
                    || planeAssignmentTargetDeclaration(assignment, facts) != property
                    || !isNullLiteral(one(assignment, PsiIndex.EdgeRole.VALUE))) continue;
            if (match != null) return null;
            match = assignment;
        }
        return match;
    }

    private Rules.Analysis analyzeClass(PsiIndex.Node klass, String componentFqn, String cloneName,
            Rules.RuleSpec cloneRule) {
        if (klass.name() == null || !isTopLevel(klass) || !isProductionPath(klass.fileId())) return null;
        List<PsiIndex.Node> superTypes = targets(klass, PsiIndex.EdgeRole.SUPER_TYPE);
        if (superTypes.size() != 1) return null;
        PsiIndex.Node componentType = superTypes.get(0);
        PsiIndex.ImportEntry componentImport = componentImport(componentType, klass, componentFqn);
        if (componentImport == null || !targets(klass, PsiIndex.EdgeRole.ARGUMENT).isEmpty()
                || hasUnsupportedClassShape(klass) || hasConstructorCompetitor(klass)) return null;

        List<PsiIndex.Node> parameters = targets(klass, PsiIndex.EdgeRole.PARAMETER);
        List<PsiIndex.Node> retained = new ArrayList<>();
        for (PsiIndex.Node parameter : parameters) {
            if (parameter.kind() != PsiIndex.NodeKind.PARAMETER_DECL || parameter.name() == null
                    || one(parameter, PsiIndex.EdgeRole.TYPE) == null
                    || one(parameter, PsiIndex.EdgeRole.DEFAULT_VALUE) == null) return null;
            if (parameter.flags().contains(PsiIndex.NodeFlag.VAL)
                    || parameter.flags().contains(PsiIndex.NodeFlag.VAR)) retained.add(parameter);
        }
        if (retained.isEmpty()) return null;

        PsiIndex.Node clone = null;
        for (PsiIndex.Node child : lexicalChildren(klass)) {
            if (child.kind() != PsiIndex.NodeKind.FUNCTION_DECL || !cloneName.equals(child.name())) continue;
            if (clone != null) return null;
            clone = child;
        }
        if (clone == null || !clone.flags().contains(PsiIndex.NodeFlag.OVERRIDE)
                || clone.flags().contains(PsiIndex.NodeFlag.SUSPEND)
                || clone.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || !targets(clone, PsiIndex.EdgeRole.PARAMETER).isEmpty()) return null;
        if (!hasKernelFact("override", clone.id(), CLONE_FQN, CLONE_SIGNATURE)
                || !hasKernelFact("production_root", clone.id(), CLONE_FQN, CLONE_SIGNATURE)) return null;
        List<PsiIndex.Node> returnTypes = targets(clone, PsiIndex.EdgeRole.TYPE);
        if (returnTypes.size() != 1 || !klass.name().equals(returnTypes.get(0).name())
                || !klass.name().equals(returnTypes.get(0).value())) return null;

        PsiIndex.Node body = one(clone, PsiIndex.EdgeRole.BODY);
        if (body == null || hasUnsupportedCloneModifier(clone, body)
                || cloneRule.proofForms().size() != 2 || cloneRule.alternatives().size() != 2) return null;
        int proofIndex;
        PsiIndex.Node returned = null;
        PsiIndex.Node call;
        if (body.kind() == PsiIndex.NodeKind.CALL
                && clone.flags().contains(PsiIndex.NodeFlag.EXPRESSION_BODY)) {
            proofIndex = 0;
            call = body;
        } else if (body.kind() == PsiIndex.NodeKind.BLOCK
                && !clone.flags().contains(PsiIndex.NodeFlag.EXPRESSION_BODY)) {
            List<PsiIndex.Node> statements = lexicalChildren(body);
            if (statements.size() != 1 || statements.get(0).kind() != PsiIndex.NodeKind.RETURN
                    || statements.get(0).flags().contains(PsiIndex.NodeFlag.LABELED)) return null;
            returned = statements.get(0);
            call = one(returned, PsiIndex.EdgeRole.RETURN_VALUE);
            if (call == null || call.kind() != PsiIndex.NodeKind.CALL) return null;
            proofIndex = 1;
        } else return null;
        String proofForm = cloneRule.proofForms().get(proofIndex);
        Rules.AlternativeSpec alternatives = cloneRule.alternatives().get(proofIndex);
        if (!alternatives.proofForm().equals(proofForm) || alternatives.alternativeIds().size() != 2
                || !klass.name().equals(call.name())
                || !targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT).isEmpty()) return null;
        PsiIndex.Node callee = one(call, PsiIndex.EdgeRole.CALLEE);
        if (callee == null || callee.kind() != PsiIndex.NodeKind.NAME_REF
                || !klass.name().equals(callee.name())) return null;

        List<PsiIndex.Node> arguments = targets(call, PsiIndex.EdgeRole.ARGUMENT);
        if (arguments.isEmpty()) return null;
        boolean named = arguments.get(0).flags().contains(PsiIndex.NodeFlag.NAMED);
        for (PsiIndex.Node argument : arguments) {
            if (argument.kind() != PsiIndex.NodeKind.ARGUMENT
                    || argument.flags().contains(PsiIndex.NodeFlag.NAMED) != named) return null;
        }
        if (named) {
            if (!matchesNamed(arguments, retained)) return null;
        } else if (!matchesPositional(arguments, parameters, retained)) return null;
        String alternative = alternatives.alternativeIds().get(named ? 1 : 0);
        Map<String, Boolean> completeByProof = new HashMap<>();
        Map<String, List<String>> alternativesByProof = new HashMap<>();
        for (String candidate : cloneRule.proofForms()) {
            boolean selected = candidate.equals(proofForm);
            completeByProof.put(candidate, selected);
            alternativesByProof.put(candidate, selected ? List.of(alternative) : List.of());
        }
        Map<String, String> selected = Rules.selectProof(
            domain, cloneRule.ruleId(), completeByProof, alternativesByProof);
        if (!proofForm.equals(selected.get("proofForm"))
                || !alternative.equals(selected.get("alternativeId"))) return null;

        List<String> witnessIds = new ArrayList<>();
        if (!addWitness(klass, witnessIds) || !addWitness(componentType, witnessIds)
                || !addWitness(componentImport, witnessIds)) return null;
        for (PsiIndex.Node parameter : retained) {
            if (!addWitness(parameter, witnessIds)
                    || !addWitness(one(parameter, PsiIndex.EdgeRole.TYPE), witnessIds)) return null;
        }
        if (!addWitness(clone, witnessIds) || !addWitness(returnTypes.get(0), witnessIds)
                || !addWitness(call, witnessIds) || !addWitness(callee, witnessIds)) return null;
        if (returned != null && !addWitness(returned, witnessIds)) return null;
        for (PsiIndex.Node argument : arguments) {
            if (!addWitness(argument, witnessIds)
                    || !addWitness(one(argument, PsiIndex.EdgeRole.VALUE), witnessIds)) return null;
        }
        Rules.Analysis claim = Rules.claimOrNull(
            program, domain, cloneRule.ruleId(), proofForm, alternative, witnessIds);
        if (claim != null) selectedAlternativesForTest.put(cloneRule.ruleId(), alternative);
        return claim == null ? Rules.emptyAnalysis() : claim;
    }

    private PsiIndex.ImportEntry componentImport(PsiIndex.Node type, PsiIndex.Node klass, String componentFqn) {
        if (type.kind() != PsiIndex.NodeKind.TYPE_REF || type.name() == null || type.value() == null
                || type.fileId() != klass.fileId()) return null;
        PsiIndex.Node referencedType = one(type, PsiIndex.EdgeRole.TYPE);
        if (referencedType == null || referencedType.kind() != PsiIndex.NodeKind.TYPE_REF
                || referencedType.name() == null || referencedType.value() == null) return null;
        PsiIndex.ImportEntry match = null;
        for (int importId : program.file(klass.fileId()).importIds()) {
            PsiIndex.ImportEntry entry = program.imports().get(importId);
            if (!entry.exposedName().equals(type.name()) || !type.value().equals("zero_arg_super_call")
                    || !entry.exposedName().equals(referencedType.name())
                    || !entry.exposedName().equals(referencedType.value())
                    || !entry.fqName().equals(componentFqn)) continue;
            if (match != null) return null;
            match = entry;
        }
        if (match == null) return null;
        String packageName = program.file(klass.fileId()).packageName();
        if (hasTypeAliasCompetitor(packageName, type.name())) return null;
        for (PsiIndex.Node declaration : program.nodes()) {
            if (!isTypeDeclaration(declaration) || !type.name().equals(declaration.name())) continue;
            if (program.file(declaration.fileId()).packageName().equals(packageName)
                    || declaration.fileId() == klass.fileId()) return null;
        }
        return match;
    }

    private boolean hasTypeAliasCompetitor(String packageName, String exposedName) {
        for (int index = 0; index < program.tokens().size(); index++) {
            PsiIndex.Token token = program.tokens().get(index);
            if (!program.file(token.fileId()).packageName().equals(packageName)
                    || token.kind() != PsiIndex.TokenKind.KEYWORD || !token.value().equals("typealias")) continue;
            if (++index >= program.tokens().size()) return false;
            PsiIndex.Token name = program.tokens().get(index);
            if (name.fileId() == token.fileId() && name.kind() == PsiIndex.TokenKind.IDENTIFIER
                    && name.value().equals(exposedName)) return true;
            index--;
        }
        return false;
    }

    private boolean hasUnsupportedClassShape(PsiIndex.Node klass) {
        if (klass.flags().contains(PsiIndex.NodeFlag.SEALED)
                || hasTypeParameterList(klass, "class")) return true;
        for (PsiIndex.Node child : lexicalChildren(klass)) {
            if (child.kind() == PsiIndex.NodeKind.BLOCK
                    || child.kind() == PsiIndex.NodeKind.PROPERTY_DECL) return true;
        }
        for (int tokenId = klass.firstTokenId(); tokenId < klass.firstTokenId() + klass.tokenCount(); tokenId++) {
            PsiIndex.Token token = program.tokens().get(tokenId);
            if (token.kind() != PsiIndex.TokenKind.KEYWORD) continue;
            String value = token.value();
            if (value.equals("abstract") || value.equals("annotation") || value.equals("constructor")
                    || value.equals("context")
                    || value.equals("enum") || value.equals("expect") || value.equals("init") || value.equals("sealed")
                    || value.equals("value")) return true;
        }
        return false;
    }

    private boolean hasUnsupportedCloneModifier(PsiIndex.Node clone, PsiIndex.Node body) {
        if (hasTypeParameterList(clone, "fun")) return true;
        for (int tokenId = clone.firstTokenId(); tokenId < clone.firstTokenId() + clone.tokenCount(); tokenId++) {
            PsiIndex.Token token = program.tokens().get(tokenId);
            if (token.startUtf16() >= body.startUtf16()) break;
            if (token.kind() != PsiIndex.TokenKind.KEYWORD) continue;
            String value = token.value();
            if (value.equals("abstract") || value.equals("context") || value.equals("external")
                    || value.equals("infix") || value.equals("inline") || value.equals("internal")
                    || value.equals("operator") || value.equals("private") || value.equals("protected")
                    || value.equals("suspend") || value.equals("tailrec")) return true;
        }
        return false;
    }

    private boolean hasTypeParameterList(PsiIndex.Node declaration, String keyword) {
        boolean declarationKeyword = false;
        boolean declarationName = false;
        for (int tokenId = declaration.firstTokenId();
                tokenId < declaration.firstTokenId() + declaration.tokenCount(); tokenId++) {
            PsiIndex.Token token = program.tokens().get(tokenId);
            if (!declarationKeyword) {
                declarationKeyword = token.kind() == PsiIndex.TokenKind.KEYWORD
                    && token.value().equals(keyword);
                continue;
            }
            if (keyword.equals("fun")) {
                if (token.kind() == PsiIndex.TokenKind.OPERATOR && token.value().equals("<")) return true;
                if (token.kind() == PsiIndex.TokenKind.IDENTIFIER
                        && token.value().equals(declaration.name())) return false;
                continue;
            }
            if (!declarationName) {
                declarationName = token.kind() == PsiIndex.TokenKind.IDENTIFIER
                    && token.value().equals(declaration.name());
                continue;
            }
            return token.kind() == PsiIndex.TokenKind.OPERATOR && token.value().equals("<");
        }
        return false;
    }

    private boolean isDirectNameValue(PsiIndex.Node argument, PsiIndex.Node value, boolean named) {
        if (value.tokenCount() != 1) return false;
        PsiIndex.Token token = program.tokens().get(value.firstTokenId());
        if (token.kind() != PsiIndex.TokenKind.IDENTIFIER || !value.name().equals(token.value())) return false;
        if (argument.endUtf16() != value.endUtf16()) return false;
        if (!named) return argument.startUtf16() == value.startUtf16();
        if (argument.tokenCount() != 3 || argument.firstTokenId() + 2 != value.firstTokenId()) return false;
        PsiIndex.Token label = program.tokens().get(argument.firstTokenId());
        PsiIndex.Token equals = program.tokens().get(argument.firstTokenId() + 1);
        return label.kind() == PsiIndex.TokenKind.IDENTIFIER && label.value().equals(argument.name())
            && equals.kind() == PsiIndex.TokenKind.OPERATOR && equals.value().equals("=");
    }

    private boolean hasConstructorCompetitor(PsiIndex.Node klass) {
        for (int importId : program.file(klass.fileId()).importIds()) {
            if (program.imports().get(importId).exposedName().equals(klass.name())) return true;
        }
        String packageName = program.file(klass.fileId()).packageName();
        for (PsiIndex.Node declaration : program.nodes()) {
            if (declaration.id() == klass.id() || !klass.name().equals(declaration.name())
                    || !isCallableDeclaration(declaration)) continue;
            if (isWithin(declaration, klass)) return true;
            if (isTopLevel(declaration)
                    && program.file(declaration.fileId()).packageName().equals(packageName)) return true;
        }
        return false;
    }

    private boolean matchesNamed(List<PsiIndex.Node> arguments, List<PsiIndex.Node> retained) {
        if (arguments.size() != retained.size()) return false;
        Map<String, PsiIndex.Node> fields = new HashMap<>();
        for (PsiIndex.Node parameter : retained) if (fields.put(parameter.name(), parameter) != null) return false;
        for (PsiIndex.Node argument : arguments) {
            PsiIndex.Node field = fields.remove(argument.name());
            PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
            if (field == null || value == null || value.kind() != PsiIndex.NodeKind.NAME_REF
                    || !field.name().equals(value.name()) || !isDirectNameValue(argument, value, true)) return false;
        }
        return fields.isEmpty();
    }

    private boolean matchesPositional(List<PsiIndex.Node> arguments, List<PsiIndex.Node> parameters,
            List<PsiIndex.Node> retained) {
        if (parameters.size() != retained.size() || arguments.size() != parameters.size()) return false;
        for (int index = 0; index < arguments.size(); index++) {
            PsiIndex.Node value = one(arguments.get(index), PsiIndex.EdgeRole.VALUE);
            if (value == null || value.kind() != PsiIndex.NodeKind.NAME_REF
                    || !parameters.get(index).name().equals(value.name())
                    || !isDirectNameValue(arguments.get(index), value, false)) return false;
        }
        return true;
    }

    private List<PsiIndex.Node> lexicalChildren(PsiIndex.Node owner) {
        return targets(owner, PsiIndex.EdgeRole.LEXICAL_OWNER);
    }

    private List<PsiIndex.Node> targets(PsiIndex.Node from, PsiIndex.EdgeRole role) {
        List<PsiIndex.Node> result = new ArrayList<>();
        for (PsiIndex.Edge edge : outgoing.getOrDefault(from.id(), List.of())) {
            if (edge.role() == role) result.add(program.node(edge.toNodeId()));
        }
        return result;
    }

    private PsiIndex.Node one(PsiIndex.Node from, PsiIndex.EdgeRole role) {
        List<PsiIndex.Node> values = targets(from, role);
        return values.size() == 1 ? values.get(0) : null;
    }

    private boolean addWitness(PsiIndex.Node node, List<String> witnessIds) {
        if (node == null || node.witnessNodeId() == null) return false;
        witnessIds.add(node.witnessNodeId());
        return true;
    }

    private boolean addWitness(PsiIndex.ImportEntry entry, List<String> witnessIds) {
        if (entry == null || entry.witnessNodeId() == null) return false;
        witnessIds.add(entry.witnessNodeId());
        return true;
    }

    private boolean isWithin(PsiIndex.Node node, PsiIndex.Node ancestor) {
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            if (owner == ancestor.id()) return true;
            owner = lexicalOwners.get(owner);
        }
        return false;
    }

    private boolean isTopLevel(PsiIndex.Node node) {
        Integer owner = lexicalOwners.get(node.id());
        return owner != null && program.node(owner).kind() == PsiIndex.NodeKind.FILE;
    }

    private boolean isCallableDeclaration(PsiIndex.Node node) {
        return isTypeDeclaration(node) || node.kind() == PsiIndex.NodeKind.FUNCTION_DECL
            || node.kind() == PsiIndex.NodeKind.PROPERTY_DECL || node.kind() == PsiIndex.NodeKind.PARAMETER_DECL;
    }

    private boolean isDeclarationKind(PsiIndex.NodeKind kind) {
        return kind == PsiIndex.NodeKind.CLASS_DECL || kind == PsiIndex.NodeKind.INTERFACE_DECL
            || kind == PsiIndex.NodeKind.OBJECT_DECL || kind == PsiIndex.NodeKind.COMPANION_DECL
            || kind == PsiIndex.NodeKind.FUNCTION_DECL || kind == PsiIndex.NodeKind.PROPERTY_DECL
            || kind == PsiIndex.NodeKind.PARAMETER_DECL;
    }

    private boolean isTypeDeclaration(PsiIndex.Node node) {
        return node != null && (node.kind() == PsiIndex.NodeKind.CLASS_DECL
            || node.kind() == PsiIndex.NodeKind.INTERFACE_DECL
            || node.kind() == PsiIndex.NodeKind.OBJECT_DECL
            || node.kind() == PsiIndex.NodeKind.COMPANION_DECL);
    }
}
