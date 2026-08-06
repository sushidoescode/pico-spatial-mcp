import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
export interface SpatialGestureInput { packageName:string; targetId:string; commandDispatcher:string }

const KOTLIN_KEYWORDS = new Set([
 "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null",
 "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when",
 "while", "by", "catch", "constructor", "delegate", "dynamic", "field", "file", "finally", "get", "import", "init", "param",
 "property", "receiver", "set", "setparam", "value", "where", "actual", "abstract", "annotation", "companion", "const",
 "crossinline", "data", "enum", "expect", "external", "final", "infix", "inline", "inner", "internal", "lateinit", "noinline",
 "open", "operator", "out", "override", "private", "protected", "public", "reified", "sealed", "suspend", "tailrec", "vararg",
]);
const kotlinIdentifier = z.string().refine(
 (value) => /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && !KOTLIN_KEYWORDS.has(value),
 "expected a non-keyword Kotlin identifier",
);
const spatialGestureFields = {
 packageName: z.string().refine(
  (value) => value.includes(".") && value.split(".").every((segment) => /^[a-z][a-z0-9_]*$/.test(segment) && !KOTLIN_KEYWORDS.has(segment)),
  "expected a non-keyword Kotlin package",
 ),
 targetId: kotlinIdentifier,
 commandDispatcher: kotlinIdentifier.describe("Existing Kotlin function that accepts the generated select:<id> String command"),
};

export function generateSpatialGestureFiles(i:SpatialGestureInput) {
 const value=z.object(spatialGestureFields).parse(i);
 const kotlin=`package ${value.packageName}
import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import com.pico.spatial.ui.foundation.gesture.SpatialDragValue
import com.pico.spatial.ui.foundation.gesture.SpatialScaleValue
import com.pico.spatial.ui.foundation.gesture.TargetEntity
import com.pico.spatial.ui.foundation.gesture.detectSpatialDragGesture
import com.pico.spatial.ui.foundation.gesture.detectSpatialScaleGesture
import com.pico.spatial.ui.foundation.gesture.detectSpatialTapGesture
import com.pico.spatial.ui.platform.LocalPhysicalLengthConverter
import com.pico.spatial.ui.platform.LengthUnit
import com.pico.spatial.core.ecs.CollisionComponent
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.InteractableComponent
import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource
import com.pico.spatial.core.ecs.resource.ShapeResource
import com.pico.spatial.core.ecs.simulation.CollisionFilter
import com.pico.spatial.core.ecs.simulation.CollisionGroup
import com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel
import com.pico.spatial.core.ecs.simulation.CollisionResponseMode
import com.pico.spatial.core.math.Vector3

fun configure${value.targetId}Target(entity: Entity) {
    entity.components.set(InteractableComponent())
    entity.components.set(CollisionComponent(
        listOf(ShapeResource.createBox(Vector3(0.2f, 0.2f, 0.2f))),
        PhysicsMaterialResource(0.4f, 0.4f, 0.1f),
        // v35.13: TRIGGER_LITE, not COLLIDER_FULL — a tap target with COLLIDER_FULL is a physical
        // obstacle. Both this and every ScenePhysics body default to COLLISION_FILTER_DEFAULT
        // (group 1u, mask ALL) which always pairs, so a selectable card used to be an invisible
        // wall that dynamic bodies bounced off. PICO's tap target is TRIGGER_LITE on a private
        // group: InteractionReceiver.kt:49-55. Group stays bit 0 so rayCast still picks it; the
        // MASK is what excludes physics.
        CollisionResponseMode.TRIGGER_LITE,
        CollisionFilter(CollisionGroup(1u), CollisionGroup(1u)),
        CollisionInfoDetailLevel.BRIEF,
    ))
}
@Composable fun ${value.targetId}Gestures(entity: Entity, onDrag: (SpatialDragValue, Vector3)->Unit, onScale: (SpatialScaleValue)->Unit): Modifier {
    val context=LocalContext.current
    val converter=LocalPhysicalLengthConverter.current
    val density=LocalDensity.current
    val twentyCentimeters = converter.lengthToDp(20f, LengthUnit.Centimeters)
    return Modifier
      .requiredSize(twentyCentimeters) // a real 20 cm interaction surface, converted to Compose dp
      .pointerInput(entity, context) { detectSpatialTapGesture(context, TargetEntity.hit(entity)) { ${value.commandDispatcher}("select:${value.targetId}") } }
      .pointerInput(entity, context, onDrag, density, converter) { detectSpatialDragGesture(context, TargetEntity.hit(entity), onDrag = {
          val deltaXDp = with(density) { it.dragAmount.x.toDp() }
          val deltaYDp = with(density) { it.dragAmount.y.toDp() }
          val deltaZDp = with(density) { it.dragAmount.z.toDp() }
          val deltaMeters = Vector3(
              converter.dpToLength(deltaXDp, LengthUnit.Meters),
              converter.dpToLength(deltaYDp, LengthUnit.Meters),
              converter.dpToLength(deltaZDp, LengthUnit.Meters),
          )
          onDrag(it, deltaMeters) // named caller callback owns the transform and scene-unit policy
      }) }
      .pointerInput(entity, context, onScale) { detectSpatialScaleGesture(context, TargetEntity.hit(entity), onScale = { onScale(it) }) }
}`;
 return {files:{[`${value.targetId}SpatialGestures.kt`]:kotlin},evidence:["SDK 0.13.3 gesture signatures"],doesNotProve:["Tap uses the existing select command. Drag/scale are caller callbacks, not claimed dispatcher routes.","Generated command routing is structural; native gesture behavior requires driving and observation."]};
}
export function registerSpatialGestureTools(server:McpServer){server.registerTool("generate_spatial_gestures_kotlin",{description:"Generate SDK 0.13.3 source-grounded tap, drag, and scale gesture lanes for a named non-rigidbody entity with primitive collision. Tap routes to select:<id>; drag converts all three Offset3D pixel axes through Density and LocalPhysicalLengthConverter into a Vector3 in meters; drag and scale remain named caller callbacks. Structural evidence only; native pointer behavior requires driving and observation.",inputSchema:spatialGestureFields},async input=>okJson(generateSpatialGestureFiles(input)));}
