// Lint fixture (GOOD): every SDK symbol below resolves against the fixture vault at
// test/fixtures/agent-vault — expected: zero rule violations, zero vault findings.
import com.pico.spatial.core.ecs.CollisionComponent
import com.pico.spatial.core.ecs.PhysicsWorldComponent
import com.pico.spatial.core.ecs.RigidBodyComponent
import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource
import com.pico.spatial.core.ecs.resource.ShapeResource
import com.pico.spatial.core.ecs.simulation.MassProperties
import com.pico.spatial.core.ecs.simulation.RigidBodyMode
import com.pico.spatial.core.math.Vector3

fun buildBall(root: Entity, ball: Entity) {
    root.components.set(PhysicsWorldComponent())
    val shape = ShapeResource.createSphere(0.12f)
    ball.components.set(CollisionComponent(listOf(shape), PhysicsMaterialResource(0.5f, 0.5f, 0.4f)))
    ball.components.set(RigidBodyComponent(MassProperties(1f), RigidBodyMode.DYNAMIC))
    val extents = Vector3(1f, 1f, 1f)
}
