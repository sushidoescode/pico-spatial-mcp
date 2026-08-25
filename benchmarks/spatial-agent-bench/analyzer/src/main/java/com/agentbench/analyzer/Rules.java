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
    private static final List<Integer> WITNESS_CAPS = List.of(
        11, 16, 14, 12, 16, 11, 12, 11, 12, 24, 12, 24, 10, 25, 20, 22);
    private static final Set<String> SYMBOL_KINDS = Set.of(
        "type", "constructor", "top_level_function", "member_function", "extension_function",
        "member_property", "top_level_property");
    private static final Set<String> MEMBER_PRECEDENCE = Set.of(
        "not_applicable", "sdk_member_wins", "source_extension_if_no_sdk_member");
    private static final Set<String> RECEIVER_KINDS = Set.of(
        "none", "instance", "declaring_type", "object_instance");
    private static final Set<String> CALLBACK_ROLES = Set.of(
        "application_entry", "window_content", "stage_content", "launched_effect", "button_click",
        "coroutine_body", "disposable_effect", "dispose_cleanup", "spatial_initial", "spatial_attachments",
        "spatial_update", "collection_element", "collection_predicate", "collection_selector", "inline_block",
        "remembered_factory", "anchor_update");
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
        "plane_geometry", "plane_orientation", "plane_tracking_manager", "immersion", "modifier", "opaque",
        "transform", "vector2", "throwable", "disposable_effect_scope", "composition_local",
        "spatial_container_scope", "kclass", "row_scope", "attachment_panel_builder",
        "spatial_view_attachments", "anchor_update");
    private static final Set<String> RETURN_SOURCES = Set.of(
        "element_of_receiver", "class_of_argument");
    private static final Set<String> OPERATOR_FORMS = Set.of(
        "index_get", "index_set", "plus_assign", "plus", "iterator", "contains", "invoke", "compare_to",
        "equals");
    private static final Set<String> CALLBACK_PARAMETER_SENTINELS = Set.of(
        "element_of_receiver");
    private static final Set<String> PROPERTY_NULL_RETURN_EXCEPTIONS = Set.of(
        "com.pico.spatial.core.container.SpatialViewEventManager.filter\nfilter: EventSourceFilter",
        "com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.localSpatialCoordinateSpace\nlocalSpatialCoordinateSpace: SpatialCoordinateSpace");
    private static final Map<String, String> OPERATOR_FORM_BY_IDENTITY = Map.of(
        symbolKey("com.pico.spatial.core.ecs.Entity.ComponentSet.get", "get(componentType: Class<T>): T?"), "index_get",
        symbolKey("kotlin.Function0.invoke", "invoke(): R"), "invoke",
        symbolKey("kotlin.ranges.IntProgression.iterator", "iterator(): IntIterator"), "iterator");
    private static final Map<String, String> RETURN_SOURCE_BY_IDENTITY = Map.of(
        symbolKey("com.pico.spatial.core.ecs.Entity.ComponentSet.get", "get(componentType: Class<T>): T?"), "class_of_argument",
        symbolKey("kotlin.collections.firstOrNull", "Iterable<T>.firstOrNull(): T?"), "element_of_receiver",
        symbolKey("kotlin.collections.maxByOrNull", "Iterable<T>.maxByOrNull(selector: (T) -> R): T?"), "element_of_receiver");
    private static final Map<String, String> NULLABLE_SIGNATURE_BY_FQN = Map.of(
        "android.os.BaseBundle.getString", "getString(key: String): String?",
        "com.pico.spatial.core.ecs.Entity.ComponentSet.get", "get(componentType: Class<T>): T?",
        "com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle", "bundle: Bundle?",
        "kotlin.Throwable.message", "message: String?",
        "kotlin.collections.firstOrNull", "Iterable<T>.firstOrNull(): T?",
        "kotlin.collections.maxByOrNull", "Iterable<T>.maxByOrNull(selector: (T) -> R): T?");
    private static final Set<String> NULLABLE_RESULT_IDENTITIES = Set.of(
        symbolKey("android.os.BaseBundle.getString", "getString(key: String): String?"),
        symbolKey("com.pico.spatial.core.ecs.Entity.ComponentSet.get", "get(componentType: Class<T>): T?"),
        symbolKey("com.pico.spatial.ui.platform.containers.SpatialContainerScope.bundle", "bundle: Bundle?"),
        symbolKey("kotlin.Throwable.message", "message: String?"),
        symbolKey("kotlin.collections.firstOrNull", "Iterable<T>.firstOrNull(): T?"),
        symbolKey("kotlin.collections.maxByOrNull", "Iterable<T>.maxByOrNull(selector: (T) -> R): T?"));
    private static final String CLONE_FQN = "com.pico.spatial.core.ecs.Component.clone";
    private static final String CLONE_SIGNATURE = "clone(): Component";
    private static final String SPATIAL_VIEW_FQN = "com.pico.spatial.ui.foundation.content.SpatialView";
    private static final String SPATIAL_VIEW_SIGNATURE = "SpatialView(modifier: Modifier = Modifier, update: ((SpatialViewContent, SpatialViewAttachments) -> Unit)? = null, attachments: (AttachmentPanelBuilder.() -> Unit)? = null, initial: suspend (SpatialViewContent, SpatialViewAttachments) -> Unit): Unit";
    private static final String PLANE_SUBSCRIBE_FQN = "com.pico.spatial.sense.plane.PlaneTrackingManager.subscribeAnchorUpdate";
    private static final String PLANE_SUBSCRIBE_SIGNATURE = "subscribeAnchorUpdate(subscriber: AnchorUpdateSubscriber<PlaneAnchor>): Cancellable";
    private static final String NAVIGATOR_TYPE_KEY = symbolKey(
        "com.pico.spatial.ui.platform.containers.SpatialNavigator", "interface SpatialNavigator");
    private static final String SPATIAL_VIEW_CONTENT_TYPE_KEY = symbolKey(
        "com.pico.spatial.core.container.SpatialViewContent", "class SpatialViewContent");
    private static final Map<String, List<String>> CLOSED_MEMBER_MANIFESTS = Map.of(
        NAVIGATOR_TYPE_KEY, List.of(
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.openWindowContainer", "openWindowContainer(id: String, tag: String? = null, bundle: Bundle? = null): Unit"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.closeWindowContainer", "closeWindowContainer(id: String, tag: String? = null): Unit"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.closeWindowContainer", "closeWindowContainer(): Unit"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.minimizeWindowContainer", "minimizeWindowContainer(id: String, tag: String? = null): Boolean"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.minimizeWindowContainer", "minimizeWindowContainer(): Boolean"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.restoreWindowContainer", "restoreWindowContainer(id: String, tag: String? = null): Boolean"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.restoreWindowContainer", "restoreWindowContainer(): Boolean"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.openStage", "openStage(id: String, style: StageStyle? = null, bundle: Bundle? = null, upperLimbRenderMode: UpperLimbRenderMode = UpperLimbRenderMode.Default): OpenStageResult"),
            symbolKey("com.pico.spatial.ui.platform.containers.SpatialNavigator.closeStage", "closeStage(): Unit")),
        SPATIAL_VIEW_CONTENT_TYPE_KEY, List.of(
            symbolKey("com.pico.spatial.core.container.SpatialViewEntityManager.entities", "entities: SpatialViewEntityCollection"),
            symbolKey("com.pico.spatial.core.container.SpatialViewEntityManager.addEntity", "addEntity(entity: Entity): Unit"),
            symbolKey("com.pico.spatial.core.container.SpatialViewEntityManager.removeEntity", "removeEntity(entity: Entity): Unit"),
            symbolKey("com.pico.spatial.core.container.SpatialViewEventManager.filter", "filter: EventSourceFilter"),
            symbolKey("com.pico.spatial.core.container.SpatialViewEventManager.subscribe", "subscribe(eventType: Class<T>, on: EventSource? = null, componentType: Class<out Component>? = null, subscriber: EventSubscriber<T>): Cancellable"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.localSpatialCoordinateSpace", "localSpatialCoordinateSpace: SpatialCoordinateSpace"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertPosition", "convertPosition(position: Vector3, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Vector3"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertPosition", "convertPosition(position: Vector3, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Vector3"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertSize", "convertSize(size: Vector3, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Vector3"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertSize", "convertSize(size: Vector3, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Vector3"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertRotation", "convertRotation(rotation: Quat, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Quat"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertRotation", "convertRotation(rotation: Quat, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Quat"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertScale", "convertScale(scale: Vector3, from: SpatialCoordinateSpace, to: ViewCoordinateSpace): Vector3"),
            symbolKey("com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter.convertScale", "convertScale(scale: Vector3, from: ViewCoordinateSpace, to: SpatialCoordinateSpace): Vector3")));
    private static final Map<String, List<String>> CLOSED_MEMBER_PREFIXES = Map.of(
        NAVIGATOR_TYPE_KEY, List.of("com.pico.spatial.ui.platform.containers.SpatialNavigator."),
        SPATIAL_VIEW_CONTENT_TYPE_KEY, List.of(
            "com.pico.spatial.core.container.SpatialViewEntityManager.",
            "com.pico.spatial.core.container.SpatialViewEventManager.",
            "com.pico.spatial.core.coordinate.SpatialCoordinateSpaceConverter."));
    private static final Map<String, String> EXCLUSIVE_CALLBACK_ROLES = Map.of(
        callbackKey(PLANE_SUBSCRIBE_FQN, PLANE_SUBSCRIBE_SIGNATURE, 0), "anchor_update",
        callbackKey(SPATIAL_VIEW_FQN, SPATIAL_VIEW_SIGNATURE, 1), "spatial_update");
    private static final Map<String, String> PHYSICAL_CALLBACK_PARAMETERS = Map.ofEntries(
        Map.entry(callbackParameterKey(PLANE_SUBSCRIBE_FQN, PLANE_SUBSCRIBE_SIGNATURE, 0, 0),
            physicalTypeValue("com.pico.spatial.sense.base.AnchorUpdate", "class AnchorUpdate<T : Anchor>", "anchor_update")),
        Map.entry(callbackParameterKey(SPATIAL_VIEW_FQN, SPATIAL_VIEW_SIGNATURE, 1, 0),
            physicalTypeValue("com.pico.spatial.core.container.SpatialViewContent", "class SpatialViewContent", "spatial_content")),
        Map.entry(callbackParameterKey(SPATIAL_VIEW_FQN, SPATIAL_VIEW_SIGNATURE, 1, 1),
            physicalTypeValue("com.pico.spatial.ui.foundation.content.SpatialViewAttachments", "interface SpatialViewAttachments", "spatial_view_attachments")),
        Map.entry(callbackParameterKey(SPATIAL_VIEW_FQN, SPATIAL_VIEW_SIGNATURE, 3, 0),
            physicalTypeValue("com.pico.spatial.core.container.SpatialViewContent", "class SpatialViewContent", "spatial_content")),
        Map.entry(callbackParameterKey(SPATIAL_VIEW_FQN, SPATIAL_VIEW_SIGNATURE, 3, 1),
            physicalTypeValue("com.pico.spatial.ui.foundation.content.SpatialViewAttachments", "interface SpatialViewAttachments", "spatial_view_attachments")));
    private static final Map<String, String> PHYSICAL_CALLBACK_RECEIVERS = Map.ofEntries(
        Map.entry(callbackKey("androidx.compose.runtime.DisposableEffect", "DisposableEffect(key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit", 1), physicalTypeValue("androidx.compose.runtime.DisposableEffectScope", "class DisposableEffectScope", "disposable_effect_scope")),
        Map.entry(callbackKey("androidx.compose.runtime.DisposableEffect", "DisposableEffect(key1: Any?, key2: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit", 2), physicalTypeValue("androidx.compose.runtime.DisposableEffectScope", "class DisposableEffectScope", "disposable_effect_scope")),
        Map.entry(callbackKey("androidx.compose.runtime.DisposableEffect", "DisposableEffect(key1: Any?, key2: Any?, key3: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit", 3), physicalTypeValue("androidx.compose.runtime.DisposableEffectScope", "class DisposableEffectScope", "disposable_effect_scope")),
        Map.entry(callbackKey("androidx.compose.runtime.DisposableEffect", "DisposableEffect(vararg keys: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult): Unit", 1), physicalTypeValue("androidx.compose.runtime.DisposableEffectScope", "class DisposableEffectScope", "disposable_effect_scope")),
        Map.entry(callbackKey("androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(key1: Any?, block: suspend CoroutineScope.() -> Unit): Unit", 1), physicalTypeValue("kotlinx.coroutines.CoroutineScope", "interface CoroutineScope", "coroutine_scope")),
        Map.entry(callbackKey("androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(key1: Any?, key2: Any?, block: suspend CoroutineScope.() -> Unit): Unit", 2), physicalTypeValue("kotlinx.coroutines.CoroutineScope", "interface CoroutineScope", "coroutine_scope")),
        Map.entry(callbackKey("androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(key1: Any?, key2: Any?, key3: Any?, block: suspend CoroutineScope.() -> Unit): Unit", 3), physicalTypeValue("kotlinx.coroutines.CoroutineScope", "interface CoroutineScope", "coroutine_scope")),
        Map.entry(callbackKey("androidx.compose.runtime.LaunchedEffect", "LaunchedEffect(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit): Unit", 1), physicalTypeValue("kotlinx.coroutines.CoroutineScope", "interface CoroutineScope", "coroutine_scope")),
        Map.entry(callbackKey("com.pico.spatial.ui.design.Button", "Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, size: ButtonSize = ButtonDefaults.Regular, colors: ButtonColors = ButtonDefaults.buttonColors(), leadingIcon: (@Composable () -> Unit)? = null, trailingIcon: (@Composable () -> Unit)? = null, contentPadding: PaddingValues = ButtonDefaults.paddingForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), shape: Shape = ButtonDefaults.shapeForButtonSize(size), gap: Dp = ButtonDefaults.gapForButtonSize(size, haveIcon = leadingIcon != null || trailingIcon != null), interactionSource: MutableInteractionSource = remember { MutableInteractionSource() }, content: @Composable RowScope.() -> Unit): Unit", 11), physicalTypeValue("androidx.compose.foundation.layout.RowScope", "interface RowScope", "row_scope")),
        Map.entry(callbackKey(SPATIAL_VIEW_FQN, SPATIAL_VIEW_SIGNATURE, 2), physicalTypeValue("com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder", "interface AttachmentPanelBuilder", "attachment_panel_builder")),
        Map.entry(callbackKey("com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer", "SpatialAppScope.DefaultWindowContainer(content: @Composable WindowContainerScope.() -> Unit): Unit", 0), physicalTypeValue("com.pico.spatial.ui.platform.containers.WindowContainerScope", "interface WindowContainerScope", "spatial_container_scope")),
        Map.entry(callbackKey("com.pico.spatial.ui.foundation.dsl.Stage", "SpatialAppScope.Stage(id: String, immersion: Immersion? = null, brightness: Brightness? = null, upperLimbRenderMode: UpperLimbRenderMode? = null, targetActivity: Class<out ComponentActivity>? = null, content: @Composable StageScope.() -> Unit): Unit", 5), physicalTypeValue("com.pico.spatial.ui.platform.containers.StageScope", "interface StageScope", "spatial_container_scope")),
        Map.entry(callbackKey("com.pico.spatial.ui.foundation.dsl.launch", "Application.launch(block: SpatialAppScope.() -> Unit): Unit", 0), physicalTypeValue("com.pico.spatial.ui.foundation.dsl.SpatialAppScope", "interface SpatialAppScope", "spatial_app_scope")));

    record Analysis(List<Map<String, Object>> nodes, List<Map<String, Object>> claims) {
        Analysis {
            nodes = copyNodes(nodes);
            claims = copyClaims(claims);
            validateAnalysis(nodes, claims);
        }
    }

    record ArgumentSpec(int position, String name, String abstractType,
            boolean hasDefault, boolean variadic, String samInterfaceFqn) {
        ArgumentSpec {
            if (position < 0 || (name != null && name.isEmpty()) || abstractType == null
                    || !ABSTRACT_TYPES.contains(abstractType)
                    || (samInterfaceFqn != null && !isExactFqn(samInterfaceFqn))) {
                throw new IllegalArgumentException("invalid argument spec");
            }
        }
    }

    record CallbackParameterSpec(int position, String abstractType) {
        CallbackParameterSpec {
            if (position < 0 || abstractType == null
                    || (!ABSTRACT_TYPES.contains(abstractType)
                        && !CALLBACK_PARAMETER_SENTINELS.contains(abstractType))
                    || abstractType.equals("opaque")) {
                throw new IllegalArgumentException("invalid callback parameter spec");
            }
        }
    }

    record CallbackSpec(int argumentPosition, String role, String invocationModel,
            String receiverAbstractType, String receiverSource,
            List<CallbackParameterSpec> parameters) {
        CallbackSpec {
            if (argumentPosition < 0 || !CALLBACK_ROLES.contains(role)
                    || !INVOCATION_MODELS.contains(invocationModel)
                    || (receiverAbstractType != null && (!ABSTRACT_TYPES.contains(receiverAbstractType)
                        || receiverAbstractType.equals("opaque")))
                    || (receiverSource != null && receiverSource.isEmpty())) {
                throw new IllegalArgumentException("invalid callback spec");
            }
            parameters = List.copyOf(parameters);
            if (parameters.size() > 2) {
                throw new IllegalArgumentException("callback parameter arity exceeds the physical bound");
            }
            for (int index = 0; index < parameters.size(); index++) {
                if (parameters.get(index).position() != index) {
                    throw new IllegalArgumentException("callback parameter positions are not dense");
                }
                if (CALLBACK_PARAMETER_SENTINELS.contains(parameters.get(index).abstractType())
                        && !(invocationModel.equals("element_flow")
                            || invocationModel.equals("predicate_flow")
                            || invocationModel.equals("selector_flow"))) {
                    throw new IllegalArgumentException("callback element sentinel requires collection flow");
                }
            }
        }
    }

    record SymbolSpec(String fqn, String signature, String kind, String receiverKind,
            String receiverAbstractType, String returnAbstractType, String returnSource,
            String memberPrecedence, List<String> typeArguments, List<String> conformsTo,
            boolean closedMemberSet, List<ArgumentSpec> arguments,
            List<CallbackSpec> callbacks, String operatorForm, List<String> effects) {
        SymbolSpec {
            requireText(fqn, "symbol fqn");
            requireText(signature, "symbol signature");
            if (!SYMBOL_KINDS.contains(kind) || !MEMBER_PRECEDENCE.contains(memberPrecedence)
                    || !RECEIVER_KINDS.contains(receiverKind)
                    || (receiverAbstractType != null && (!ABSTRACT_TYPES.contains(receiverAbstractType)
                        || receiverAbstractType.equals("opaque")))
                    || (returnAbstractType != null && (!ABSTRACT_TYPES.contains(returnAbstractType)
                        || returnAbstractType.equals("opaque")))
                    || (returnSource != null && !RETURN_SOURCES.contains(returnSource))
                    || (operatorForm != null && !OPERATOR_FORMS.contains(operatorForm))) {
                throw new IllegalArgumentException("invalid symbol vocabulary");
            }
            typeArguments = List.copyOf(typeArguments);
            conformsTo = List.copyOf(conformsTo);
            arguments = List.copyOf(arguments);
            callbacks = List.copyOf(callbacks);
            effects = List.copyOf(effects);
            if (arguments.size() > 19) {
                throw new IllegalArgumentException("argument arity exceeds the physical bound");
            }
            if (callbacks.size() > 3) {
                throw new IllegalArgumentException("callback arity exceeds the physical bound");
            }
            Map<Integer, Boolean> callbackPositions = new HashMap<>();
            Map<String, Boolean> argumentNames = new HashMap<>();
            Map<String, Boolean> conformanceValues = new HashMap<>();
            Map<String, Boolean> effectValues = new HashMap<>();
            for (int index = 0; index < arguments.size(); index++) {
                ArgumentSpec argument = arguments.get(index);
                if (argument.position() != index
                        || (argument.name() != null
                            && argumentNames.put(argument.name(), Boolean.TRUE) != null)) {
                    throw new IllegalArgumentException("argument positions or names are invalid");
                }
            }
            for (CallbackSpec callback : callbacks) {
                if (callback.argumentPosition() >= arguments.size()
                        || callbackPositions.put(callback.argumentPosition(), Boolean.TRUE) != null) {
                    throw new IllegalArgumentException("callback position is invalid");
                }
            }
            for (String typeArgument : typeArguments) {
                if (!ABSTRACT_TYPES.contains(typeArgument) || typeArgument.equals("opaque")) {
                    throw new IllegalArgumentException("invalid type argument");
                }
            }
            String priorConformance = null;
            for (String conformance : conformsTo) {
                if (!ABSTRACT_TYPES.contains(conformance) || conformance.equals("opaque")
                        || conformanceValues.put(conformance, Boolean.TRUE) != null
                        || (priorConformance != null && Protocol.compareUtf8(priorConformance, conformance) >= 0)) {
                    throw new IllegalArgumentException("invalid symbol conformance");
                }
                priorConformance = conformance;
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
                    "arguments", "callbacks", "closedMemberSet", "conformsTo", "effects", "fqn",
                    "kind", "memberPrecedence", "operatorForm", "receiverAbstractType", "receiverKind",
                    "returnAbstractType", "returnSource", "signature", "typeArguments"));
                SymbolSpec symbol = parseSymbol(row);
                String identity = Protocol.canonicalJson(Map.of("fqn", symbol.fqn(), "signature", symbol.signature()));
                if (priorIdentity != null && Protocol.compareUtf8(priorIdentity, identity) >= 0) {
                    throw new IllegalArgumentException("symbol rows are not canonical");
                }
                priorIdentity = identity;
                symbols.add(symbol);
            }
            validateSymbols(symbols);
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
            SymbolSpec clone = symbol(CLONE_FQN, CLONE_SIGNATURE);
            if (!constructor.kind().equals("constructor") || constructor.receiverAbstractType() != null
                    || !constructor.receiverKind().equals("none")
                    || !"component".equals(constructor.returnAbstractType())
                    || constructor.returnSource() != null || constructor.operatorForm() != null
                    || !constructor.memberPrecedence().equals("not_applicable")
                    || !constructor.typeArguments().isEmpty() || !constructor.conformsTo().isEmpty()
                    || constructor.closedMemberSet()
                    || !constructor.arguments().isEmpty() || !constructor.callbacks().isEmpty()
                    || !constructor.effects().equals(List.of("construct"))
                    || !type.kind().equals("type") || type.receiverAbstractType() != null
                    || !type.receiverKind().equals("none")
                    || !"component".equals(type.returnAbstractType())
                    || type.returnSource() != null || type.operatorForm() != null
                    || !type.memberPrecedence().equals("not_applicable") || !type.arguments().isEmpty()
                    || !type.callbacks().isEmpty() || !type.typeArguments().isEmpty()
                    || !type.conformsTo().isEmpty() || type.closedMemberSet() || !type.effects().isEmpty()
                    || !clone.kind().equals("member_function") || !"component".equals(clone.receiverAbstractType())
                    || !clone.receiverKind().equals("instance")
                    || !"component".equals(clone.returnAbstractType())
                    || clone.returnSource() != null || clone.operatorForm() != null
                    || !clone.memberPrecedence().equals("sdk_member_wins") || !clone.arguments().isEmpty()
                    || !clone.callbacks().isEmpty() || !clone.typeArguments().isEmpty()
                    || !clone.conformsTo().isEmpty() || clone.closedMemberSet()
                    || !clone.effects().equals(List.of("construct"))) {
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

    static Analysis combine(List<Analysis> parts) {
        if (parts == null) throw new IllegalArgumentException("analysis parts are null");
        if (parts.size() != RULE_ORDER.size()) {
            throw new IllegalArgumentException("analysis part count mismatch");
        }
        List<Map<String, Object>> claims = new ArrayList<>();
        Map<String, Map<String, Object>> nodesById = new HashMap<>();
        for (int index = 0; index < parts.size(); index++) {
            Analysis part = parts.get(index);
            if (part == null) throw new IllegalArgumentException("analysis part is null");
            if (part.claims().isEmpty()) continue;
            if (part.claims().size() != 1) {
                throw new IllegalArgumentException("analysis part claim count mismatch");
            }
            Map<String, Object> claim = part.claims().get(0);
            if (!RULE_ORDER.get(index).equals(claim.get("ruleId"))) {
                throw new IllegalArgumentException("analysis part rule mismatch");
            }
            claims.add(claim);
            for (Map<String, Object> node : part.nodes()) {
                String nodeId = (String) node.get("nodeId");
                Map<String, Object> prior = nodesById.putIfAbsent(nodeId, node);
                if (prior != null && !prior.equals(node)) {
                    throw new IllegalArgumentException("analysis node identity mismatch");
                }
            }
        }
        List<String> nodeIds = new ArrayList<>(nodesById.keySet());
        nodeIds.sort(Protocol::compareUtf8);
        List<Map<String, Object>> nodes = new ArrayList<>();
        for (String nodeId : nodeIds) nodes.add(nodesById.get(nodeId));
        return new Analysis(nodes, claims);
    }

    static Map<String, String> selectProof(Domain domain, String ruleId,
            Map<String, Boolean> completeByProofForm,
            Map<String, List<String>> satisfiedAlternativeIdsByProofForm) {
        if (domain == null || completeByProofForm == null
                || satisfiedAlternativeIdsByProofForm == null) {
            throw new IllegalArgumentException("proof selection input is null");
        }
        RuleSpec rule = domain.rule(ruleId);
        Set<String> expectedForms = Set.copyOf(rule.proofForms());
        if (!completeByProofForm.keySet().equals(expectedForms)
                || !satisfiedAlternativeIdsByProofForm.keySet().equals(expectedForms)) {
            throw new IllegalArgumentException("proof selection keyset mismatch");
        }
        for (int index = 0; index < rule.proofForms().size(); index++) {
            String proofForm = rule.proofForms().get(index);
            if (completeByProofForm.get(proofForm) == null) {
                throw new IllegalArgumentException("proof completeness is null");
            }
            List<String> satisfied = List.copyOf(satisfiedAlternativeIdsByProofForm.get(proofForm));
            Map<String, Boolean> unique = new HashMap<>();
            for (String alternativeId : satisfied) {
                if (!rule.alternatives().get(index).alternativeIds().contains(alternativeId)
                        || unique.put(alternativeId, Boolean.TRUE) != null) {
                    throw new IllegalArgumentException("satisfied alternative is invalid");
                }
            }
        }
        for (int index = 0; index < rule.proofForms().size(); index++) {
            String proofForm = rule.proofForms().get(index);
            if (!completeByProofForm.get(proofForm)) continue;
            List<String> satisfied = satisfiedAlternativeIdsByProofForm.get(proofForm);
            for (String alternativeId : rule.alternatives().get(index).alternativeIds()) {
                if (satisfied.contains(alternativeId)) {
                    return Map.of("proofForm", proofForm, "alternativeId", alternativeId);
                }
            }
        }
        return Map.of();
    }

    static int witnessCap(String ruleId) {
        int index = RULE_ORDER.indexOf(ruleId);
        if (index < 0) throw new IllegalArgumentException("unknown rule cap");
        return WITNESS_CAPS.get(index);
    }

    static Analysis claimOrNull(PsiIndex.Program program, Domain domain, String ruleId,
            String proofForm, String alternativeId, List<String> rawWitnessIds) {
        if (program == null || domain == null || rawWitnessIds == null) {
            throw new IllegalArgumentException("claim input is null");
        }
        RuleSpec rule = domain.rule(ruleId);
        boolean accepted = false;
        for (AlternativeSpec alternative : rule.alternatives()) {
            if (alternative.proofForm().equals(proofForm)
                    && alternative.alternativeIds().contains(alternativeId)) accepted = true;
        }
        if (!accepted) throw new IllegalArgumentException("claim is outside domain");
        Map<String, Boolean> unique = new HashMap<>();
        for (String nodeId : rawWitnessIds) {
            requireText(nodeId, "witness node id");
            unique.put(nodeId, Boolean.TRUE);
        }
        List<String> witnessIds = new ArrayList<>(unique.keySet());
        witnessIds.sort(Protocol::compareUtf8);
        if (witnessIds.isEmpty()) throw new IllegalArgumentException("claim witness count is invalid");
        if (witnessIds.size() > witnessCap(ruleId)) return null;
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
        String receiverKind = member(string(row.get("receiverKind"), "receiver kind"), RECEIVER_KINDS, "receiver kind");
        String receiver = nullableType(row.get("receiverAbstractType"), "receiver type");
        String result = nullableType(row.get("returnAbstractType"), "return type");
        String returnSource = nullableMember(row.get("returnSource"), RETURN_SOURCES, "return source");
        String precedence = member(string(row.get("memberPrecedence"), "precedence"), MEMBER_PRECEDENCE, "precedence");
        List<String> typeArguments = strings(row.get("typeArguments"), "type arguments", ABSTRACT_TYPES, false);
        List<String> conformsTo = strings(row.get("conformsTo"), "conformance", ABSTRACT_TYPES, true);
        boolean closedMemberSet = bool(row.get("closedMemberSet"), "closed member set");
        List<Object> rawArguments = array(row.get("arguments"), "arguments");
        List<ArgumentSpec> arguments = new ArrayList<>();
        for (int index = 0; index < rawArguments.size(); index++) {
            Map<String, Object> argument = object(rawArguments.get(index), "argument", Set.of(
                "abstractType", "hasDefault", "name", "position", "samInterfaceFqn", "variadic"));
            int position = integer(argument.get("position"), "argument position");
            if (position != index) throw new IllegalArgumentException("argument positions are not dense");
            Object rawName = argument.get("name");
            String name = rawName == null ? null : string(rawName, "argument name");
            String type = member(string(argument.get("abstractType"), "argument type"), ABSTRACT_TYPES, "argument type");
            boolean hasDefault = bool(argument.get("hasDefault"), "argument default flag");
            boolean variadic = bool(argument.get("variadic"), "argument variadic flag");
            String samInterfaceFqn = nullableString(argument.get("samInterfaceFqn"), "SAM interface FQN");
            arguments.add(new ArgumentSpec(position, name, type, hasDefault, variadic, samInterfaceFqn));
        }
        List<Object> rawCallbacks = array(row.get("callbacks"), "callbacks");
        List<CallbackSpec> callbacks = new ArrayList<>();
        Map<Integer, Boolean> callbackPositions = new HashMap<>();
        for (Object value : rawCallbacks) {
            Map<String, Object> callback = object(value, "callback", Set.of(
                "argumentPosition", "invocationModel", "parameters", "receiverAbstractType",
                "receiverSource", "role"));
            int position = integer(callback.get("argumentPosition"), "callback position");
            if (position >= arguments.size() || callbackPositions.put(position, Boolean.TRUE) != null) {
                throw new IllegalArgumentException("callback position is invalid");
            }
            List<Object> rawParameters = array(callback.get("parameters"), "callback parameters");
            List<CallbackParameterSpec> parameters = new ArrayList<>();
            for (int parameterIndex = 0; parameterIndex < rawParameters.size(); parameterIndex++) {
                Map<String, Object> parameter = object(rawParameters.get(parameterIndex),
                    "callback parameter", Set.of("abstractType", "position"));
                int parameterPosition = integer(parameter.get("position"), "callback parameter position");
                if (parameterPosition != parameterIndex) {
                    throw new IllegalArgumentException("callback parameter positions are not dense");
                }
                String parameterType = string(parameter.get("abstractType"), "callback parameter type");
                if (!ABSTRACT_TYPES.contains(parameterType)
                        && !CALLBACK_PARAMETER_SENTINELS.contains(parameterType)) {
                    throw new IllegalArgumentException("callback parameter type is unknown");
                }
                parameters.add(new CallbackParameterSpec(parameterPosition, parameterType));
            }
            callbacks.add(new CallbackSpec(position,
                member(string(callback.get("role"), "callback role"), CALLBACK_ROLES, "callback role"),
                member(string(callback.get("invocationModel"), "invocation model"), INVOCATION_MODELS, "invocation model"),
                nullableType(callback.get("receiverAbstractType"), "callback receiver type"),
                nullableString(callback.get("receiverSource"), "callback receiver source"),
                parameters));
        }
        String operatorForm = nullableMember(row.get("operatorForm"), OPERATOR_FORMS, "operator form");
        List<String> effects = strings(row.get("effects"), "effects", EFFECTS, true);
        return new SymbolSpec(fqn, signature, kind, receiverKind, receiver, result, returnSource,
            precedence, typeArguments, conformsTo, closedMemberSet, arguments, callbacks, operatorForm, effects);
    }

    private static void validateSymbols(List<SymbolSpec> symbols) {
        Map<String, SymbolSpec> byKey = new HashMap<>();
        Map<String, List<SymbolSpec>> typeByFqn = new HashMap<>();
        Map<String, List<String>> conformance = new HashMap<>();
        for (SymbolSpec symbol : symbols) {
            String key = symbolKey(symbol.fqn(), symbol.signature());
            if (byKey.put(key, symbol) != null) throw new IllegalArgumentException("duplicate symbol identity");
            if (symbol.effects().size() > 4) throw new IllegalArgumentException("too many symbol effects");
            if (symbol.conformsTo().size() > 8) throw new IllegalArgumentException("too many conformance values");
            if (symbol.kind().equals("type")) {
                typeByFqn.computeIfAbsent(symbol.fqn(), ignored -> new ArrayList<>()).add(symbol);
                List<String> targets = conformance.computeIfAbsent(
                    symbol.returnAbstractType(), ignored -> new ArrayList<>());
                for (String target : symbol.conformsTo()) {
                    if (target.equals(symbol.returnAbstractType())) {
                        throw new IllegalArgumentException("self semantic conformance");
                    }
                    if (!targets.contains(target)) targets.add(target);
                }
            }
        }
        for (List<String> targets : conformance.values()) {
            targets.sort(Protocol::compareUtf8);
        }
        for (Map.Entry<String, List<String>> entry : conformance.entrySet()) {
            validateConformancePath(entry.getKey(), conformance, new HashMap<>(), 0);
        }

        for (SymbolSpec symbol : symbols) {
            validateSymbolKind(symbol, typeByFqn);
            validateArgumentsAndCallbacks(symbol, conformance, byKey);
            String key = symbolKey(symbol.fqn(), symbol.signature());
            String expectedReturnSource = RETURN_SOURCE_BY_IDENTITY.get(key);
            if (expectedReturnSource == null ? symbol.returnSource() != null
                    : !expectedReturnSource.equals(symbol.returnSource())) {
                throw new IllegalArgumentException("return source does not match the exact audited identity");
            }
            String expectedOperatorForm = OPERATOR_FORM_BY_IDENTITY.get(key);
            if (expectedOperatorForm == null ? symbol.operatorForm() != null
                    : !expectedOperatorForm.equals(symbol.operatorForm())) {
                throw new IllegalArgumentException("operator form does not match the exact audited identity");
            }
            String expectedNullableSignature = NULLABLE_SIGNATURE_BY_FQN.get(symbol.fqn());
            if ((symbol.signature().endsWith("?") && !NULLABLE_RESULT_IDENTITIES.contains(key))
                    || (expectedNullableSignature != null
                        && !expectedNullableSignature.equals(symbol.signature()))) {
                throw new IllegalArgumentException("nullable result signature does not match the exact doctrine");
            }
            if (symbol.returnSource() != null) {
                if (symbol.returnAbstractType() != null || symbol.effects().contains("passthrough")
                        || !(symbol.kind().equals("top_level_function")
                            || symbol.kind().equals("member_function")
                            || symbol.kind().equals("extension_function"))) {
                    throw new IllegalArgumentException("invalid dynamic return source");
                }
                if (symbol.returnSource().equals("class_of_argument")) {
                    int matches = 0;
                    for (ArgumentSpec argument : symbol.arguments()) {
                        if (argument.abstractType().equals("java_class")) matches++;
                    }
                    if (matches != 1 || symbol.receiverAbstractType() == null) {
                        throw new IllegalArgumentException("invalid class-of-argument return source");
                    }
                }
            }
            if (symbol.effects().contains("passthrough")) {
                if (symbol.returnSource() != null) throw new IllegalArgumentException("passthrough has return source");
                if (symbol.returnAbstractType() != null) {
                    if (symbol.receiverAbstractType() == null
                            || !symbol.returnAbstractType().equals(symbol.receiverAbstractType())) {
                        throw new IllegalArgumentException("typed passthrough does not preserve receiver type");
                    }
                } else {
                    if (symbol.callbacks().size() != 1
                            || !symbol.callbacks().get(0).invocationModel().equals("immediate_inline")) {
                        throw new IllegalArgumentException("dynamic passthrough callback is invalid");
                    }
                }
            }
            if (!symbol.kind().equals("type") && symbol.returnAbstractType() != null
                    && !symbol.returnAbstractType().equals("unit") && symbol.effects().isEmpty()) {
                throw new IllegalArgumentException("typed result has no origin effect");
            }
        }
        validateClosedMemberManifests(symbols, byKey);
    }

    private static void validateSymbolKind(SymbolSpec symbol, Map<String, List<SymbolSpec>> typeByFqn) {
        boolean isFunction = symbol.kind().equals("top_level_function")
            || symbol.kind().equals("member_function") || symbol.kind().equals("extension_function");
        boolean isProperty = symbol.kind().equals("member_property")
            || symbol.kind().equals("top_level_property");
        if (!symbol.kind().equals("type")
                && (!symbol.conformsTo().isEmpty() || symbol.closedMemberSet())) {
            throw new IllegalArgumentException("non-type has type-only fields");
        }
        if (symbol.kind().equals("type")) {
            if (!symbol.receiverKind().equals("none") || symbol.receiverAbstractType() != null
                    || symbol.returnAbstractType() == null || !symbol.arguments().isEmpty()
                    || !symbol.callbacks().isEmpty() || !symbol.typeArguments().isEmpty()
                    || symbol.operatorForm() != null || symbol.returnSource() != null
                    || !symbol.memberPrecedence().equals("not_applicable") || !symbol.effects().isEmpty()) {
                throw new IllegalArgumentException("invalid type row");
            }
        } else if (symbol.kind().equals("constructor")) {
            if (!symbol.receiverKind().equals("none") || symbol.receiverAbstractType() != null
                    || symbol.returnAbstractType() == null || !symbol.callbacks().isEmpty()
                    || !symbol.typeArguments().isEmpty() || symbol.operatorForm() != null
                    || symbol.returnSource() != null || !symbol.memberPrecedence().equals("not_applicable")
                    || !symbol.effects().equals(List.of("construct"))) {
                throw new IllegalArgumentException("invalid constructor row");
            }
            List<SymbolSpec> types = typeByFqn.getOrDefault(symbol.fqn(), List.of());
            if (types.size() != 1
                    || !symbol.returnAbstractType().equals(types.get(0).returnAbstractType())) {
                throw new IllegalArgumentException("constructor has no exact physical type row");
            }
        } else if (symbol.kind().equals("member_function") || symbol.kind().equals("member_property")) {
            if (symbol.receiverKind().equals("none") || symbol.receiverAbstractType() == null
                    || !symbol.memberPrecedence().equals("sdk_member_wins")) {
                throw new IllegalArgumentException("invalid member receiver or precedence");
            }
            int separator = symbol.fqn().lastIndexOf('.');
            List<SymbolSpec> owners = separator < 0 ? List.of()
                : typeByFqn.getOrDefault(symbol.fqn().substring(0, separator), List.of());
            if (owners.size() != 1
                    || !symbol.receiverAbstractType().equals(owners.get(0).returnAbstractType())) {
                throw new IllegalArgumentException("member has no exact physical owner type row");
            }
        } else if (symbol.kind().equals("extension_function")) {
            if (!symbol.receiverKind().equals("instance") || symbol.receiverAbstractType() == null
                    || !symbol.memberPrecedence().equals("sdk_member_wins")) {
                throw new IllegalArgumentException("invalid audited extension row");
            }
        } else if (symbol.kind().equals("top_level_function")
                || symbol.kind().equals("top_level_property")) {
            if (!symbol.receiverKind().equals("none") || symbol.receiverAbstractType() != null
                    || !symbol.memberPrecedence().equals("not_applicable")) {
                throw new IllegalArgumentException("invalid top-level row");
            }
        }
        if (!isFunction && !symbol.callbacks().isEmpty()) {
            throw new IllegalArgumentException("callback on non-function row");
        }
        if (!isFunction && symbol.returnSource() != null) {
            throw new IllegalArgumentException("dynamic return on non-function row");
        }
        if (symbol.operatorForm() != null
                && !(symbol.kind().equals("member_function")
                    || symbol.kind().equals("extension_function"))) {
            throw new IllegalArgumentException("operator form on invalid row kind");
        }
        if (isProperty && (!symbol.arguments().isEmpty() || !symbol.callbacks().isEmpty()
                || !symbol.typeArguments().isEmpty() || symbol.operatorForm() != null
                || symbol.returnSource() != null)) {
            throw new IllegalArgumentException("property has callable-only fields");
        }
        if (isProperty && symbol.returnAbstractType() == null
                && !PROPERTY_NULL_RETURN_EXCEPTIONS.contains(symbolKey(symbol.fqn(), symbol.signature()))) {
            throw new IllegalArgumentException("untyped property is outside the closure exceptions");
        }
    }

    private static void validateArgumentsAndCallbacks(SymbolSpec symbol,
            Map<String, List<String>> conformance, Map<String, SymbolSpec> byKey) {
        int variadicCount = 0;
        Map<Integer, Boolean> callbackPositions = new HashMap<>();
        for (CallbackSpec callback : symbol.callbacks()) {
            callbackPositions.put(callback.argumentPosition(), Boolean.TRUE);
        }
        int highestNoncallback = -1;
        for (ArgumentSpec argument : symbol.arguments()) {
            if (!callbackPositions.containsKey(argument.position())) highestNoncallback = argument.position();
            if (argument.variadic()) {
                variadicCount++;
                if (argument.hasDefault() || callbackPositions.containsKey(argument.position())) {
                    throw new IllegalArgumentException("invalid variadic argument");
                }
            }
            if (argument.samInterfaceFqn() != null) {
                int callbackCount = 0;
                for (CallbackSpec callback : symbol.callbacks()) {
                    if (callback.argumentPosition() == argument.position()) callbackCount++;
                }
                if (!argument.abstractType().equals("callable") || callbackCount != 1) {
                    throw new IllegalArgumentException("invalid SAM argument");
                }
            }
        }
        if (variadicCount > 1) throw new IllegalArgumentException("multiple variadic arguments");
        for (ArgumentSpec argument : symbol.arguments()) {
            if (argument.variadic() && argument.position() != highestNoncallback) {
                throw new IllegalArgumentException("variadic is not highest noncallback position");
            }
        }
        for (CallbackSpec callback : symbol.callbacks()) {
            ArgumentSpec callbackArgument = symbol.arguments().get(callback.argumentPosition());
            if (!callbackArgument.abstractType().equals("callable")) {
                throw new IllegalArgumentException("callback argument is not callable");
            }
            if (callback.receiverAbstractType() == null) {
                if (callback.receiverSource() != null) {
                    throw new IllegalArgumentException("callback receiver source has no type");
                }
            } else if (callback.receiverSource() != null) {
                String sourceType;
                if (callback.receiverSource().equals("call_receiver")) {
                    if (symbol.receiverKind().equals("none")) {
                        throw new IllegalArgumentException("call-receiver callback has no callable receiver");
                    }
                    sourceType = symbol.receiverAbstractType();
                } else {
                    int position = argumentSourcePosition(callback.receiverSource());
                    if (position < 0 || position >= symbol.arguments().size()) {
                        throw new IllegalArgumentException("callback receiver argument source is invalid");
                    }
                    ArgumentSpec source = symbol.arguments().get(position);
                    if (source.abstractType().equals("opaque")) {
                        throw new IllegalArgumentException("opaque callback receiver source");
                    }
                    sourceType = source.abstractType();
                }
                if (sourceType == null || !conforms(sourceType, callback.receiverAbstractType(), conformance,
                        new HashMap<>(), 0)) {
                    throw new IllegalArgumentException("callback receiver source type mismatch");
                }
            }
            int concreteParameters = 0;
            String concreteParameterType = null;
            for (CallbackParameterSpec parameter : callback.parameters()) {
                if (ABSTRACT_TYPES.contains(parameter.abstractType())) {
                    concreteParameters++;
                    concreteParameterType = parameter.abstractType();
                }
            }
            if (callback.receiverAbstractType() == null
                    && callback.invocationModel().equals("immediate_inline")
                    && concreteParameters == 1 && symbol.receiverAbstractType() != null
                    && !conforms(symbol.receiverAbstractType(), concreteParameterType, conformance,
                        new HashMap<>(), 0)) {
                throw new IllegalArgumentException("immediate callback parameter is incompatible with receiver");
            }
            String key = callbackKey(symbol.fqn(), symbol.signature(), callback.argumentPosition());
            String expectedRole = EXCLUSIVE_CALLBACK_ROLES.get(key);
            if ((callback.role().equals("anchor_update") || callback.role().equals("spatial_update"))
                    && !callback.role().equals(expectedRole)) {
                throw new IllegalArgumentException("exclusive callback role is on the wrong identity");
            }
            if (expectedRole != null && !expectedRole.equals(callback.role())) {
                throw new IllegalArgumentException("exclusive callback identity has the wrong role");
            }
            String physicalReceiver = PHYSICAL_CALLBACK_RECEIVERS.get(key);
            if (physicalReceiver != null) {
                validatePhysicalCallbackType(physicalReceiver, callback.receiverAbstractType(), byKey);
                if (callback.receiverSource() != null) {
                    throw new IllegalArgumentException("SDK-created callback receiver has a source");
                }
            } else if (callback.receiverAbstractType() != null && callback.receiverSource() == null) {
                throw new IllegalArgumentException("SDK-created callback receiver lacks an exact physical map");
            }
            for (CallbackParameterSpec parameter : callback.parameters()) {
                String physicalParameter = PHYSICAL_CALLBACK_PARAMETERS.get(callbackParameterKey(
                    symbol.fqn(), symbol.signature(), callback.argumentPosition(), parameter.position()));
                if (physicalParameter != null) {
                    validatePhysicalCallbackType(physicalParameter, parameter.abstractType(), byKey);
                }
            }
            String parameterPrefix = key + "\n";
            for (Map.Entry<String, String> mapping : PHYSICAL_CALLBACK_PARAMETERS.entrySet()) {
                if (!mapping.getKey().startsWith(parameterPrefix)) continue;
                int parameterPosition = decimalSuffix(mapping.getKey());
                if (parameterPosition < 0 || parameterPosition >= callback.parameters().size()) {
                    throw new IllegalArgumentException("physical callback parameter is missing");
                }
                validatePhysicalCallbackType(mapping.getValue(),
                    callback.parameters().get(parameterPosition).abstractType(), byKey);
            }
        }
        String callbackPrefix = symbolKey(symbol.fqn(), symbol.signature()) + "\n";
        for (Map.Entry<String, String> binding : EXCLUSIVE_CALLBACK_ROLES.entrySet()) {
            if (!binding.getKey().startsWith(callbackPrefix)) continue;
            int callbackPosition = decimalSuffix(binding.getKey());
            CallbackSpec found = null;
            for (CallbackSpec callback : symbol.callbacks()) {
                if (callback.argumentPosition() == callbackPosition) found = callback;
            }
            if (found == null || !found.role().equals(binding.getValue())) {
                throw new IllegalArgumentException("exclusive callback binding is missing");
            }
        }
    }

    private static void validatePhysicalCallbackType(String encoded, String semanticType,
            Map<String, SymbolSpec> byKey) {
        int separator = encoded.lastIndexOf('\n');
        if (separator <= 0 || semanticType == null || !semanticType.equals(encoded.substring(separator + 1))) {
            throw new IllegalArgumentException("physical callback semantic type mismatch");
        }
        SymbolSpec physical = byKey.get(encoded.substring(0, separator));
        if (physical == null || !physical.kind().equals("type")
                || !semanticType.equals(physical.returnAbstractType())) {
            throw new IllegalArgumentException("physical callback type row is missing");
        }
    }

    private static void validateClosedMemberManifests(List<SymbolSpec> symbols,
            Map<String, SymbolSpec> byKey) {
        for (SymbolSpec symbol : symbols) {
            if (!symbol.closedMemberSet()) continue;
            String typeKey = symbolKey(symbol.fqn(), symbol.signature());
            List<String> expected = CLOSED_MEMBER_MANIFESTS.get(typeKey);
            List<String> prefixes = CLOSED_MEMBER_PREFIXES.get(typeKey);
            if (expected == null || prefixes == null) {
                throw new IllegalArgumentException("closed member set is not audited");
            }
            Map<String, Boolean> actual = new HashMap<>();
            for (SymbolSpec candidate : symbols) {
                boolean family = false;
                for (String prefix : prefixes) {
                    if (candidate.fqn().startsWith(prefix)) family = true;
                }
                if (family && (candidate.kind().equals("member_function")
                        || candidate.kind().equals("member_property"))) {
                    actual.put(symbolKey(candidate.fqn(), candidate.signature()), Boolean.TRUE);
                }
            }
            if (actual.size() != expected.size()) {
                throw new IllegalArgumentException("closed member manifest size mismatch");
            }
            for (String memberKey : expected) {
                if (!actual.containsKey(memberKey) || !byKey.containsKey(memberKey)) {
                    throw new IllegalArgumentException("closed member manifest is incomplete");
                }
            }
        }
        for (String requiredTypeKey : CLOSED_MEMBER_MANIFESTS.keySet()) {
            SymbolSpec requiredType = byKey.get(requiredTypeKey);
            if (requiredType != null && !requiredType.closedMemberSet()) {
                throw new IllegalArgumentException("required closed member type is not closed");
            }
        }
    }

    private static void validateConformancePath(String type, Map<String, List<String>> graph,
            Map<String, Boolean> active, int depth) {
        if (depth > 8) throw new IllegalArgumentException("conformance path exceeds depth bound");
        if (active.put(type, Boolean.TRUE) != null) {
            throw new IllegalArgumentException("cyclic semantic conformance");
        }
        for (String target : graph.getOrDefault(type, List.of())) {
            validateConformancePath(target, graph, active, depth + 1);
        }
        active.remove(type);
    }

    private static boolean conforms(String source, String target, Map<String, List<String>> graph,
            Map<String, Boolean> visited, int depth) {
        if (source.equals(target)) return true;
        if (depth >= 8 || visited.put(source, Boolean.TRUE) != null) return false;
        for (String next : graph.getOrDefault(source, List.of())) {
            if (conforms(next, target, graph, visited, depth + 1)) return true;
        }
        return false;
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
            if (ids.isEmpty() || ids.size() > Main.MAX_WITNESSES_PER_CLAIM
                    || ids.size() > witnessCap(ruleId)) {
                throw new IllegalArgumentException("claim witness bound");
            }
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
        return strings(value, label, allowed, true);
    }

    private static List<String> strings(Object value, String label, Set<String> allowed,
            boolean uniqueValues) {
        List<Object> raw = array(value, label);
        List<String> result = new ArrayList<>();
        Map<String, Boolean> unique = new HashMap<>();
        for (Object entry : raw) {
            String string = string(entry, label);
            if ((allowed != null && !allowed.contains(string))
                    || (uniqueValues && unique.put(string, Boolean.TRUE) != null)) {
                throw new IllegalArgumentException(label + " contains duplicate or unknown value");
            }
            result.add(string);
        }
        return List.copyOf(result);
    }

    private static String nullableType(Object value, String label) {
        return value == null ? null : member(string(value, label), ABSTRACT_TYPES, label);
    }

    private static String nullableMember(Object value, Set<String> allowed, String label) {
        return value == null ? null : member(string(value, label), allowed, label);
    }

    private static String nullableString(Object value, String label) {
        return value == null ? null : string(value, label);
    }

    private static boolean bool(Object value, String label) {
        if (!(value instanceof Boolean flag)) throw new IllegalArgumentException(label + " must be a boolean");
        return flag;
    }

    private static int argumentSourcePosition(String source) {
        String prefix = "argument:";
        if (!source.startsWith(prefix) || source.length() == prefix.length()) return -1;
        int result = 0;
        for (int index = prefix.length(); index < source.length(); index++) {
            char character = source.charAt(index);
            if (character < '0' || character > '9'
                    || (index == prefix.length() && character == '0' && source.length() > index + 1)) return -1;
            int digit = character - '0';
            if (result > (Integer.MAX_VALUE - digit) / 10) return -1;
            result = result * 10 + digit;
        }
        return result;
    }

    private static int decimalSuffix(String value) {
        int separator = value.lastIndexOf('\n');
        return separator < 0 ? -1 : argumentSourcePosition("argument:" + value.substring(separator + 1));
    }

    private static String symbolKey(String fqn, String signature) {
        return fqn + "\n" + signature;
    }

    private static String callbackKey(String fqn, String signature, int argumentPosition) {
        return symbolKey(fqn, signature) + "\n" + argumentPosition;
    }

    private static String callbackParameterKey(String fqn, String signature,
            int argumentPosition, int parameterPosition) {
        return callbackKey(fqn, signature, argumentPosition) + "\n" + parameterPosition;
    }

    private static String physicalTypeValue(String fqn, String signature, String semanticType) {
        return symbolKey(fqn, signature) + "\n" + semanticType;
    }

    private static boolean isExactFqn(String value) {
        if (value == null || value.isEmpty()) return false;
        boolean sawSeparator = false;
        boolean componentStart = true;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character == '.') {
                if (componentStart) return false;
                sawSeparator = true;
                componentStart = true;
                continue;
            }
            boolean letter = (character >= 'A' && character <= 'Z')
                || (character >= 'a' && character <= 'z') || character == '_' || character == '$';
            if (componentStart) {
                if (!letter) return false;
                componentStart = false;
            } else if (!letter && (character < '0' || character > '9')) {
                return false;
            }
        }
        return sawSeparator && !componentStart;
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
