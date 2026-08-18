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
    }

    Rules.Analysis analyze() {
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
                    PsiIndex.Node origin = localValueOrigin(argumentValue(argument), facts);
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
        if (escapedOrigin(explicitReceiver, facts) != null || escapedOrigin(callee, facts) != null) {
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
        if (qualified.kind() == PsiIndex.NodeKind.QUALIFIED && isNullableFact(facts, receiver)) return false;
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
            if (qualified.kind() == PsiIndex.NodeKind.QUALIFIED && isNullableFact(facts, receiver)
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
            PsiIndex.Node retained = null;
            for (PsiIndex.Node candidate : program.nodes()) {
                if (candidate.kind() != PsiIndex.NodeKind.ASSIGNMENT || !isWithin(candidate, loop)
                        || candidate.startUtf16() >= success.startUtf16()
                        || isCanonicalLoopIncrement(loop, candidate, facts)) continue;
                if (retained == null || candidate.startUtf16() > retained.startUtf16()) retained = candidate;
            }
            if (retained != null) addFact(facts, factKeys, multiplicities, unsupported,
                "retained_exit", retained, loop, success, "", null);
        }
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
        for (Map<String, Object> fact : facts) {
            if (!fact.get("kind").equals("callback_parameter")
                    || !fact.get("ownerNodeId").equals((long) callback.id())) continue;
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
        PsiIndex.Node sourceType = sourceTypeForValue(receiver, facts);
        if (receiver == null || sourceType == null || call.name() == null) return matches;
        PsiIndex.Node receiverDeclaration = sourceValueDeclaration(receiver, facts);
        List<PsiIndex.Node> containers = new ArrayList<>();
        if (sourceType.kind() == PsiIndex.NodeKind.OBJECT_DECL) containers.add(sourceType);
        else if (receiverDeclaration != null && isTypeDeclaration(receiverDeclaration)) {
            for (PsiIndex.Node child : lexicalChildren(sourceType)) {
                if (child.kind() == PsiIndex.NodeKind.COMPANION_DECL) containers.add(child);
            }
        } else containers.add(sourceType);
        for (PsiIndex.Node container : containers) {
            for (PsiIndex.Node candidate : lexicalChildren(container)) {
                if (candidate.kind() == PsiIndex.NodeKind.FUNCTION_DECL
                        && call.name().equals(candidate.name())
                        && !candidate.flags().contains(PsiIndex.NodeFlag.PRIVATE)) matches.add(candidate);
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
        PsiIndex.Node callable = enclosingCallable(use);
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
            boolean visible = candidateCallable == callable || capturedDeclaration || isTopLevel(candidate)
                && program.file(candidate.fileId()).packageName().equals(program.file(use.fileId()).packageName());
            if (!visible) continue;
            if (candidate.id() > best) {
                best = candidate.id();
                match = candidate;
            }
        }
        return match;
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
        PsiIndex.Node exit = normalExit(body);
        return exit != null && exit.kind() == PsiIndex.NodeKind.RETURN
            ? one(exit, PsiIndex.EdgeRole.RETURN_VALUE) : null;
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
                && isNullableFact(facts, receiver)) return false;
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
                if (initializer != null) source = initializer;
            }
        }
        List<PsiIndex.Node> origins = new ArrayList<>();
        if (!collectSafeReceiverOrigins(
                source, facts, origins, 0, new HashMap<>())) return 2;
        return Math.min(origins.size(), 2);
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
        return constructed != null && isTypeDeclaration(constructed) ? constructed : null;
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
                || exactCollectionProducer(producer, facts) != null) return "plane_anchor";
        return elementType(type);
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
        if (origin.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                || origin.kind() == PsiIndex.NodeKind.ASSIGNMENT) {
            PsiIndex.Node structural = origin.kind() == PsiIndex.NodeKind.PROPERTY_DECL
                ? one(origin, PsiIndex.EdgeRole.INITIALIZER)
                : one(origin, PsiIndex.EdgeRole.VALUE);
            if (structural != null && structural.id() != origin.id()) addUniqueNode(candidates, structural);
        }
        return candidates;
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
                return definition;
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
