package com.agentbench.analyzer;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class Rules {
    private static final List<String> RULE_ORDER = List.of(
        "spatial.project-entry", "spatial.container-topology", "spatial.entity-content", "spatial.ui-lifecycle",
        "ecs.component-clone", "ecs.system-query", "ecs.frame-update", "ecs.lifecycle",
        "state.single-source", "state.typed-handoff", "state.shared-read-write", "state.reopen-wiring",
        "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose", "plane.cleanup-errors");
    private static final List<String> WITNESS_KINDS = List.of(
        "declaration", "callable_reference", "call", "argument", "property_read", "assignment",
        "condition", "loop", "lambda", "return", "type_reference", "catch");
    private static final Set<String> SYMBOL_KINDS = Set.of(
        "type", "constructor", "top_level_function", "member_function", "extension_function", "member_property");
    private static final Set<String> MEMBER_PRECEDENCE = Set.of(
        "not_applicable", "sdk_member_wins", "source_extension_if_no_sdk_member");
    private static final Set<String> CALLBACK_ROLES = Set.of(
        "application_entry", "window_content", "stage_content", "launched_effect", "button_click",
        "coroutine_body", "disposable_effect", "dispose_cleanup", "spatial_initial", "spatial_attachments",
        "spatial_update", "collection_element", "collection_predicate", "collection_selector", "inline_block",
        "remembered_factory");
    private static final Set<String> INVOCATION_MODELS = Set.of(
        "source_root", "possible_path", "user_action", "launched_path", "acquire_path", "cleanup_path",
        "element_flow", "predicate_flow", "selector_flow", "immediate_inline");
    private static final Set<String> EFFECTS = Set.of(
        "read", "mutate", "construct", "replace", "unknown_escape", "open", "close", "acquire",
        "release", "load", "readiness", "convert", "place", "status_assign", "passthrough");
    private static final Set<String> ABSTRACT_TYPES = Set.of(
        "boolean", "int", "long", "float", "double", "string", "unit", "java_class", "callable",
        "immutable_iterable", "immutable_list", "integer_range", "coroutine_scope", "android_application",
        "spatial_launch_activity", "bundle", "spatial_app_scope", "spatial_navigator", "stage_style",
        "spatial_content", "component", "component_store", "entity", "entity_collection",
        "entity_query_condition", "ecs_system", "scene", "scene_update_context", "transform_component",
        "vector3", "quat", "cancellable", "semantic_label", "plane_anchor", "plane_anchor_collection",
        "plane_geometry", "plane_orientation", "plane_tracking_manager", "immersion", "modifier");

    record Analysis(List<Map<String, Object>> nodes, List<Map<String, Object>> claims) {
        Analysis {
            nodes = copyNodes(nodes);
            claims = copyClaims(claims);
            validateAnalysis(nodes, claims);
        }
    }

    record ArgumentSpec(int position, String name, String abstractType) {
        ArgumentSpec {
            if (position < 0 || (name != null && name.isEmpty()) || abstractType == null
                    || !ABSTRACT_TYPES.contains(abstractType)) throw new IllegalArgumentException("invalid argument spec");
        }
    }

    record CallbackSpec(int argumentPosition, String role, String invocationModel) {
        CallbackSpec {
            if (argumentPosition < 0 || !CALLBACK_ROLES.contains(role) || !INVOCATION_MODELS.contains(invocationModel)) {
                throw new IllegalArgumentException("invalid callback spec");
            }
        }
    }

    record SymbolSpec(String fqn, String signature, String kind, String receiverAbstractType,
            String returnAbstractType, String memberPrecedence, List<ArgumentSpec> arguments,
            List<CallbackSpec> callbacks, List<String> effects) {
        SymbolSpec {
            requireText(fqn, "symbol fqn");
            requireText(signature, "symbol signature");
            if (!SYMBOL_KINDS.contains(kind) || !MEMBER_PRECEDENCE.contains(memberPrecedence)
                    || (receiverAbstractType != null && !ABSTRACT_TYPES.contains(receiverAbstractType))
                    || (returnAbstractType != null && !ABSTRACT_TYPES.contains(returnAbstractType))) {
                throw new IllegalArgumentException("invalid symbol vocabulary");
            }
            arguments = List.copyOf(arguments);
            callbacks = List.copyOf(callbacks);
            effects = List.copyOf(effects);
            Map<Integer, Boolean> callbackPositions = new HashMap<>();
            Map<String, Boolean> effectValues = new HashMap<>();
            for (int index = 0; index < arguments.size(); index++) {
                if (arguments.get(index).position() != index) throw new IllegalArgumentException("argument positions are not dense");
            }
            for (CallbackSpec callback : callbacks) {
                if (callback.argumentPosition() >= arguments.size()
                        || callbackPositions.put(callback.argumentPosition(), Boolean.TRUE) != null) {
                    throw new IllegalArgumentException("callback position is invalid");
                }
            }
            for (String effect : effects) {
                if (!EFFECTS.contains(effect) || effectValues.put(effect, Boolean.TRUE) != null) {
                    throw new IllegalArgumentException("invalid symbol effect");
                }
            }
        }
    }

    record AlternativeSpec(String proofForm, List<String> alternativeIds) {
        AlternativeSpec {
            requireText(proofForm, "proof form");
            alternativeIds = List.copyOf(alternativeIds);
            if (alternativeIds.isEmpty()) throw new IllegalArgumentException("empty alternatives");
            Map<String, Boolean> unique = new HashMap<>();
            for (String alternativeId : alternativeIds) {
                requireText(alternativeId, "alternative id");
                if (unique.put(alternativeId, Boolean.TRUE) != null) throw new IllegalArgumentException("duplicate alternative");
            }
        }
    }

    record RuleSpec(String ruleId, List<String> proofForms, List<AlternativeSpec> alternatives) {
        RuleSpec {
            requireText(ruleId, "rule id");
            proofForms = List.copyOf(proofForms);
            alternatives = List.copyOf(alternatives);
            if (proofForms.isEmpty() || proofForms.size() != alternatives.size()) {
                throw new IllegalArgumentException("invalid rule spec");
            }
            Map<String, Boolean> unique = new HashMap<>();
            for (int index = 0; index < proofForms.size(); index++) {
                String proofForm = proofForms.get(index);
                requireText(proofForm, "proof form");
                if (unique.put(proofForm, Boolean.TRUE) != null
                        || !proofForm.equals(alternatives.get(index).proofForm())) {
                    throw new IllegalArgumentException("rule proof alignment is invalid");
                }
            }
        }
    }

    static final class Domain {
        private final String analyzerName;
        private final int domainVersion;
        private final List<String> ruleOrder;
        private final List<String> witnessKinds;
        private final List<RuleSpec> rules;
        private final List<SymbolSpec> symbols;

        private Domain(String analyzerName, int domainVersion, List<String> ruleOrder,
                List<String> witnessKinds, List<RuleSpec> rules, List<SymbolSpec> symbols) {
            this.analyzerName = analyzerName;
            this.domainVersion = domainVersion;
            this.ruleOrder = List.copyOf(ruleOrder);
            this.witnessKinds = List.copyOf(witnessKinds);
            this.rules = List.copyOf(rules);
            this.symbols = List.copyOf(symbols);
        }

        static Domain load() {
            byte[] bytes;
            try (InputStream input = Rules.class.getResourceAsStream("/domain-v1.json")) {
                if (input == null) throw new IllegalArgumentException("domain resource is missing");
                bytes = input.readAllBytes();
            } catch (IOException error) {
                throw new IllegalArgumentException("domain resource cannot be read", error);
            }
            Map<String, Object> root = object(Protocol.parseCanonical(bytes), "domain", Set.of(
                "acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule",
                "ruleOrder", "symbols", "witnessKinds"));
            String name = string(root.get("analyzerName"), "analyzerName");
            if (!"supported-subset-abstract-interpreter-v1".equals(name)) {
                throw new IllegalArgumentException("domain analyzer name mismatch");
            }
            int version = integer(root.get("domainVersion"), "domainVersion");
            if (version != 1) throw new IllegalArgumentException("domain version mismatch");
            List<String> ruleOrder = strings(root.get("ruleOrder"), "ruleOrder", null);
            List<String> witnessKinds = strings(root.get("witnessKinds"), "witnessKinds", null);
            if (!ruleOrder.equals(RULE_ORDER) || !witnessKinds.equals(WITNESS_KINDS)) {
                throw new IllegalArgumentException("domain ordered vocabulary mismatch");
            }
            Map<String, Object> rawProofs = object(root.get("proofFormsByRule"), "proof forms", Set.copyOf(RULE_ORDER));
            Map<String, Object> rawAlternatives = object(
                root.get("acceptedAlternativesByRule"), "accepted alternatives", Set.copyOf(RULE_ORDER));
            List<RuleSpec> rules = new ArrayList<>();
            for (String ruleId : RULE_ORDER) {
                List<String> forms = strings(rawProofs.get(ruleId), ruleId + " proof forms", null);
                if (!forms.equals(expectedProofForms(ruleId))) throw new IllegalArgumentException("proof forms mismatch");
                Map<String, Object> alternatives = object(
                    rawAlternatives.get(ruleId), ruleId + " alternatives", Set.copyOf(forms));
                List<AlternativeSpec> specs = new ArrayList<>();
                for (String proofForm : forms) {
                    List<String> ids = strings(alternatives.get(proofForm), proofForm + " alternatives", null);
                    if (!ids.equals(expectedAlternatives(ruleId, proofForm))) {
                        throw new IllegalArgumentException("alternative vocabulary mismatch");
                    }
                    specs.add(new AlternativeSpec(proofForm, ids));
                }
                rules.add(new RuleSpec(ruleId, forms, specs));
            }
            List<Object> rawSymbols = array(root.get("symbols"), "symbols");
            List<SymbolSpec> symbols = new ArrayList<>();
            String priorIdentity = null;
            for (int index = 0; index < rawSymbols.size(); index++) {
                Map<String, Object> row = object(rawSymbols.get(index), "symbol", Set.of(
                    "arguments", "callbacks", "effects", "fqn", "kind", "memberPrecedence",
                    "receiverAbstractType", "returnAbstractType", "signature"));
                SymbolSpec symbol = parseSymbol(row);
                String identity = Protocol.canonicalJson(Map.of("fqn", symbol.fqn(), "signature", symbol.signature()));
                if (priorIdentity != null && Protocol.compareUtf8(priorIdentity, identity) >= 0) {
                    throw new IllegalArgumentException("symbol rows are not canonical");
                }
                priorIdentity = identity;
                symbols.add(symbol);
            }
            Domain domain = new Domain(name, version, ruleOrder, witnessKinds, rules, symbols);
            domain.verifyCloneCanary();
            return domain;
        }

        String analyzerName() { return analyzerName; }
        int domainVersion() { return domainVersion; }
        List<String> ruleOrder() { return ruleOrder; }
        List<String> witnessKinds() { return witnessKinds; }
        List<RuleSpec> rules() { return rules; }
        List<SymbolSpec> symbols() { return symbols; }

        RuleSpec rule(String ruleId) {
            RuleSpec match = null;
            for (RuleSpec candidate : rules) if (candidate.ruleId().equals(ruleId)) {
                if (match != null) throw new IllegalArgumentException("duplicate rule");
                match = candidate;
            }
            if (match == null) throw new IllegalArgumentException("unknown rule");
            return match;
        }

        SymbolSpec symbol(String fqn, String signature) {
            SymbolSpec match = null;
            for (SymbolSpec candidate : symbols) {
                if (candidate.fqn().equals(fqn) && candidate.signature().equals(signature)) {
                    if (match != null) throw new IllegalArgumentException("duplicate symbol");
                    match = candidate;
                }
            }
            if (match == null) throw new IllegalArgumentException("unknown symbol");
            return match;
        }

        private void verifyCloneCanary() {
            SymbolSpec constructor = symbol("com.pico.spatial.core.ecs.Component", "Component()");
            SymbolSpec type = symbol("com.pico.spatial.core.ecs.Component", "open class Component");
            SymbolSpec clone = symbol("com.pico.spatial.core.ecs.Component.clone", "clone(): Component");
            if (!constructor.kind().equals("constructor") || constructor.receiverAbstractType() != null
                    || !"component".equals(constructor.returnAbstractType())
                    || !constructor.memberPrecedence().equals("not_applicable")
                    || !constructor.arguments().isEmpty() || !constructor.callbacks().isEmpty()
                    || !constructor.effects().equals(List.of("construct"))
                    || !type.kind().equals("type") || type.receiverAbstractType() != null
                    || !"component".equals(type.returnAbstractType())
                    || !type.memberPrecedence().equals("not_applicable") || !type.arguments().isEmpty()
                    || !type.callbacks().isEmpty() || !type.effects().isEmpty()
                    || !clone.kind().equals("member_function") || !"component".equals(clone.receiverAbstractType())
                    || !"component".equals(clone.returnAbstractType())
                    || !clone.memberPrecedence().equals("sdk_member_wins") || !clone.arguments().isEmpty()
                    || !clone.callbacks().isEmpty() || !clone.effects().equals(List.of("construct"))) {
                throw new IllegalArgumentException("clone canary mismatch");
            }
        }
    }

    private Rules() {}

    static Analysis analyze(PsiIndex.Program program) {
        if (program == null) throw new IllegalArgumentException("program is null");
        Domain domain = Domain.load();
        return new AbstractInterpreter(program, domain).analyze();
    }

    static Analysis emptyAnalysis() { return new Analysis(List.of(), List.of()); }

    static Analysis claim(PsiIndex.Program program, Domain domain, String ruleId, String proofForm,
            String alternativeId, List<String> rawWitnessIds) {
        RuleSpec rule = domain.rule(ruleId);
        boolean accepted = false;
        for (AlternativeSpec alternative : rule.alternatives()) {
            if (alternative.proofForm().equals(proofForm) && alternative.alternativeIds().contains(alternativeId)) {
                accepted = true;
            }
        }
        if (!accepted) throw new IllegalArgumentException("claim is outside domain");
        Map<String, Boolean> unique = new HashMap<>();
        for (String nodeId : rawWitnessIds) unique.put(nodeId, Boolean.TRUE);
        List<String> witnessIds = new ArrayList<>(unique.keySet());
        witnessIds.sort(Protocol::compareUtf8);
        if (witnessIds.isEmpty() || witnessIds.size() > Main.MAX_WITNESSES_PER_CLAIM) {
            throw new IllegalArgumentException("claim witness count is invalid");
        }
        List<Map<String, Object>> nodes = new ArrayList<>();
        for (String nodeId : witnessIds) {
            PsiIndex.WitnessNode witness = program.witness(nodeId);
            PsiIndex.FileUnit file = program.file(witness.fileId());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("nodeId", witness.nodeId());
            row.put("path", file.path());
            row.put("fileSha256", file.sha256());
            row.put("startUtf16", (long) witness.startUtf16());
            row.put("endUtf16", (long) witness.endUtf16());
            row.put("kind", witnessKindName(witness.kind()));
            row.put("textSha256", witness.textSha256());
            row.put("structuralToken", witness.structuralToken());
            nodes.add(row);
        }
        Map<String, Object> digestMaterial = new LinkedHashMap<>();
        digestMaterial.put("ruleId", ruleId);
        digestMaterial.put("proofForm", proofForm);
        digestMaterial.put("witnessNodeIds", witnessIds);
        Map<String, Object> claim = new LinkedHashMap<>(digestMaterial);
        claim.put("witnessDigest", Protocol.sha256(Protocol.canonicalBytes(digestMaterial)));
        return new Analysis(nodes, List.of(claim));
    }

    private static SymbolSpec parseSymbol(Map<String, Object> row) {
        String fqn = string(row.get("fqn"), "symbol fqn");
        String signature = string(row.get("signature"), "symbol signature");
        String kind = member(string(row.get("kind"), "symbol kind"), SYMBOL_KINDS, "symbol kind");
        String receiver = nullableType(row.get("receiverAbstractType"), "receiver type");
        String result = nullableType(row.get("returnAbstractType"), "return type");
        String precedence = member(string(row.get("memberPrecedence"), "precedence"), MEMBER_PRECEDENCE, "precedence");
        List<Object> rawArguments = array(row.get("arguments"), "arguments");
        List<ArgumentSpec> arguments = new ArrayList<>();
        for (int index = 0; index < rawArguments.size(); index++) {
            Map<String, Object> argument = object(rawArguments.get(index), "argument", Set.of("abstractType", "name", "position"));
            int position = integer(argument.get("position"), "argument position");
            if (position != index) throw new IllegalArgumentException("argument positions are not dense");
            Object rawName = argument.get("name");
            String name = rawName == null ? null : string(rawName, "argument name");
            String type = member(string(argument.get("abstractType"), "argument type"), ABSTRACT_TYPES, "argument type");
            arguments.add(new ArgumentSpec(position, name, type));
        }
        List<Object> rawCallbacks = array(row.get("callbacks"), "callbacks");
        List<CallbackSpec> callbacks = new ArrayList<>();
        Map<Integer, Boolean> callbackPositions = new HashMap<>();
        for (Object value : rawCallbacks) {
            Map<String, Object> callback = object(value, "callback", Set.of("argumentPosition", "invocationModel", "role"));
            int position = integer(callback.get("argumentPosition"), "callback position");
            if (position >= arguments.size() || callbackPositions.put(position, Boolean.TRUE) != null) {
                throw new IllegalArgumentException("callback position is invalid");
            }
            callbacks.add(new CallbackSpec(position,
                member(string(callback.get("role"), "callback role"), CALLBACK_ROLES, "callback role"),
                member(string(callback.get("invocationModel"), "invocation model"), INVOCATION_MODELS, "invocation model")));
        }
        List<String> effects = strings(row.get("effects"), "effects", EFFECTS);
        return new SymbolSpec(fqn, signature, kind, receiver, result, precedence, arguments, callbacks, effects);
    }

    private static List<String> expectedProofForms(String rule) {
        if (rule.equals("ecs.component-clone")) return List.of("expression-component-clone", "single-return-block-component-clone");
        if (rule.equals("ecs.frame-update")) return List.of("assign-delta-update", "plus-assign-delta-update");
        if (rule.equals("spatial.container-topology")) return List.of(
            "direct-mixed-stage-open", "one-helper-mixed-stage-open", "two-helper-mixed-stage-open");
        if (rule.equals("spatial.project-entry")) return List.of("application-launch-root");
        if (rule.equals("spatial.entity-content")) return List.of("spatial-view-entity-attachment");
        if (rule.equals("spatial.ui-lifecycle")) return List.of("themed-window-and-disposable-stage");
        if (rule.equals("ecs.system-query")) return List.of("hoisted-query-scene-update");
        if (rule.equals("ecs.lifecycle")) return List.of("paired-system-lifecycle");
        if (rule.equals("state.single-source")) return List.of("shared-strong-authority");
        if (rule.equals("state.typed-handoff")) return List.of("typed-bundle-roundtrip");
        if (rule.equals("state.shared-read-write")) return List.of("same-authority-read-write");
        if (rule.equals("state.reopen-wiring")) return List.of("retained-state-close-reopen");
        if (rule.equals("plane.retry-readiness")) return List.of("bounded-retained-load-retry");
        if (rule.equals("plane.semantic-fallback")) return List.of("dominating-semantic-plane-fallback");
        if (rule.equals("plane.anchor-pose")) return List.of("same-anchor-pose-conversion");
        if (rule.equals("plane.cleanup-errors")) return List.of("paired-plane-cleanup-status");
        throw new IllegalArgumentException("unknown rule vocabulary");
    }

    private static List<String> expectedAlternatives(String rule, String proof) {
        if (rule.equals("spatial.container-topology")) return List.of(
            "named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id",
            "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id");
        if (rule.equals("ecs.component-clone")) return List.of("positional-fields", "named-fields");
        if (rule.equals("ecs.frame-update")) return List.of("direct-transform", "pure-helper-transform");
        if (rule.equals("spatial.project-entry")) return List.of("direct-launch-import", "aliased-launch-import");
        if (rule.equals("spatial.entity-content")) return List.of("direct-initial-entity", "unique-helper-initial-entity");
        if (rule.equals("spatial.ui-lifecycle")) return List.of("direct-theme-paired-dispose");
        if (rule.equals("ecs.system-query")) return List.of("direct-query-use", "pure-helper-query-use");
        if (rule.equals("ecs.lifecycle")) return List.of("direct-register-unregister");
        if (rule.equals("state.single-source")) return List.of("top-level-val", "object-singleton", "companion-held-singleton");
        if (rule.equals("state.typed-handoff")) return List.of("direct-bundle-adapter", "unique-helper-bundle-adapter");
        if (rule.equals("state.shared-read-write")) return List.of("direct-container-summaries");
        if (rule.equals("state.reopen-wiring")) return List.of("standard-store-reopen", "equivalent-repository-reopen");
        if (rule.equals("plane.retry-readiness")) return List.of("bounded-for", "canonical-bounded-while");
        if (rule.equals("plane.semantic-fallback")) return List.of("inline-selectors", "unique-helper-selectors");
        if (rule.equals("plane.anchor-pose")) return List.of("direct-pose-conversion", "pure-helper-pose-conversion");
        if (rule.equals("plane.cleanup-errors")) return List.of("direct-cleanup", "unique-helper-cleanup");
        throw new IllegalArgumentException("unknown alternative vocabulary: " + proof);
    }

    private static List<Map<String, Object>> copyNodes(List<Map<String, Object>> rows) {
        List<Map<String, Object>> copy = new ArrayList<>();
        for (Map<String, Object> row : List.copyOf(rows)) copy.add(Map.copyOf(row));
        return List.copyOf(copy);
    }

    private static List<Map<String, Object>> copyClaims(List<Map<String, Object>> rows) {
        List<Map<String, Object>> copy = new ArrayList<>();
        for (Map<String, Object> row : List.copyOf(rows)) {
            Map<String, Object> value = new LinkedHashMap<>(row);
            Object ids = value.get("witnessNodeIds");
            if (ids instanceof List<?> list) value.put("witnessNodeIds", List.copyOf(list));
            copy.add(Map.copyOf(value));
        }
        return List.copyOf(copy);
    }

    private static void validateAnalysis(List<Map<String, Object>> nodes, List<Map<String, Object>> claims) {
        if (nodes.size() > Main.MAX_RESPONSE_NODES || claims.size() > Main.MAX_CLAIMS) {
            throw new IllegalArgumentException("analysis exceeds response bounds");
        }
        Map<String, Map<String, Object>> catalog = new HashMap<>();
        String priorNode = null;
        for (Map<String, Object> node : nodes) {
            if (!node.keySet().equals(Set.of("nodeId", "path", "fileSha256", "startUtf16", "endUtf16",
                    "kind", "textSha256", "structuralToken"))) throw new IllegalArgumentException("node keys mismatch");
            String nodeId = hash(node.get("nodeId"), "node id");
            String path = string(node.get("path"), "node path");
            String fileHash = hash(node.get("fileSha256"), "file hash");
            long start = nonnegative(node.get("startUtf16"), "node start");
            long end = nonnegative(node.get("endUtf16"), "node end");
            String kind = member(string(node.get("kind"), "node kind"), Set.copyOf(WITNESS_KINDS), "node kind");
            String textHash = hash(node.get("textSha256"), "text hash");
            if (!(node.get("structuralToken") instanceof Boolean structural) || end <= start
                    || (!structural && !kind.equals("argument"))) throw new IllegalArgumentException("invalid node witness");
            Map<String, Object> identity = Map.of("path", path, "fileSha256", fileHash, "startUtf16", start,
                "endUtf16", end, "kind", kind, "textSha256", textHash, "structuralToken", structural);
            if (!Protocol.sha256(Protocol.canonicalBytes(identity)).equals(nodeId)
                    || (priorNode != null && Protocol.compareUtf8(priorNode, nodeId) >= 0)
                    || catalog.put(nodeId, node) != null) throw new IllegalArgumentException("node catalog is not canonical");
            priorNode = nodeId;
        }
        Map<String, Boolean> union = new HashMap<>();
        Map<String, Boolean> ruleIds = new HashMap<>();
        int total = 0;
        int priorRuleIndex = -1;
        for (Map<String, Object> claim : claims) {
            if (!claim.keySet().equals(Set.of("ruleId", "proofForm", "witnessNodeIds", "witnessDigest"))) {
                throw new IllegalArgumentException("claim keys mismatch");
            }
            String ruleId = string(claim.get("ruleId"), "claim rule");
            String proof = string(claim.get("proofForm"), "claim proof");
            int ruleIndex = RULE_ORDER.indexOf(ruleId);
            if (ruleIndex <= priorRuleIndex || ruleIds.put(ruleId, Boolean.TRUE) != null
                    || !expectedProofForms(ruleId).contains(proof)) {
                throw new IllegalArgumentException("claim rule or proof is outside the domain");
            }
            priorRuleIndex = ruleIndex;
            List<String> ids = strings(claim.get("witnessNodeIds"), "claim witnesses", null);
            if (ids.isEmpty() || ids.size() > Main.MAX_WITNESSES_PER_CLAIM) throw new IllegalArgumentException("claim witness bound");
            boolean structural = false;
            String prior = null;
            for (String id : ids) {
                Map<String, Object> node = catalog.get(id);
                if (node == null || (prior != null && Protocol.compareUtf8(prior, id) >= 0)) {
                    throw new IllegalArgumentException("claim witnesses are not canonical");
                }
                structural |= Boolean.TRUE.equals(node.get("structuralToken"));
                union.put(id, Boolean.TRUE);
                prior = id;
            }
            if (!structural) throw new IllegalArgumentException("claim lacks structural witness");
            total = Math.addExact(total, ids.size());
            Map<String, Object> material = Map.of("ruleId", ruleId, "proofForm", proof, "witnessNodeIds", ids);
            if (!Protocol.sha256(Protocol.canonicalBytes(material)).equals(hash(claim.get("witnessDigest"), "witness digest"))) {
                throw new IllegalArgumentException("claim digest mismatch");
            }
        }
        if (total > Main.MAX_TOTAL_WITNESSES || union.size() != catalog.size()) {
            throw new IllegalArgumentException("claim catalog union mismatch");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String label, Set<String> keys) {
        if (!(value instanceof Map<?, ?> raw)) throw new IllegalArgumentException(label + " must be an object");
        Map<String, Object> result = (Map<String, Object>) raw;
        if (!result.keySet().equals(keys)) throw new IllegalArgumentException(label + " keys mismatch");
        return result;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> array(Object value, String label) {
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException(label + " must be an array");
        return (List<Object>) list;
    }

    private static List<String> strings(Object value, String label, Set<String> allowed) {
        List<Object> raw = array(value, label);
        List<String> result = new ArrayList<>();
        Map<String, Boolean> unique = new HashMap<>();
        for (Object entry : raw) {
            String string = string(entry, label);
            if ((allowed != null && !allowed.contains(string)) || unique.put(string, Boolean.TRUE) != null) {
                throw new IllegalArgumentException(label + " contains duplicate or unknown value");
            }
            result.add(string);
        }
        return List.copyOf(result);
    }

    private static String nullableType(Object value, String label) {
        return value == null ? null : member(string(value, label), ABSTRACT_TYPES, label);
    }

    private static String member(String value, Set<String> allowed, String label) {
        if (!allowed.contains(value)) throw new IllegalArgumentException(label + " is unknown");
        return value;
    }

    private static String string(Object value, String label) {
        if (!(value instanceof String string) || string.isEmpty()) throw new IllegalArgumentException(label + " must be text");
        return string;
    }

    private static int integer(Object value, String label) {
        if (!(value instanceof Long number) || number < 0 || number > Integer.MAX_VALUE) {
            throw new IllegalArgumentException(label + " must be a nonnegative integer");
        }
        return number.intValue();
    }

    private static long nonnegative(Object value, String label) {
        if (!(value instanceof Long number) || number < 0) throw new IllegalArgumentException(label + " is invalid");
        return number;
    }

    private static String hash(Object value, String label) {
        String hash = string(value, label);
        if (hash.length() != 64) throw new IllegalArgumentException(label + " is invalid");
        for (int index = 0; index < hash.length(); index++) {
            char character = hash.charAt(index);
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) {
                throw new IllegalArgumentException(label + " is invalid");
            }
        }
        return hash;
    }

    private static String witnessKindName(PsiIndex.WitnessKind kind) {
        int ordinal = kind.ordinal();
        if (ordinal < 0 || ordinal >= WITNESS_KINDS.size()) throw new IllegalArgumentException("unknown witness kind");
        return WITNESS_KINDS.get(ordinal);
    }

    private static void requireText(String value, String label) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(label + " is empty");
    }
}
