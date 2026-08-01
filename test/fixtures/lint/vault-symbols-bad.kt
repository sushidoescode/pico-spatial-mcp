// Lint fixture (BAD): three planted defects against the fixture vault at test/fixtures/agent-vault.
//   1. RigidbodyComponent (lowercase b) — vault unknown-type warning; nearest match must be
//      com.pico.spatial.core.ecs.RigidBodyComponent.
//   2. CollisionComponent() — builtin rule 'collisioncomponent-no-arg' (error) AND vault
//      ctor-arity warning (declared arities are 2 | 5).
//   3. RigidBodyMode.STATIC as an FQN — vault unknown-enum-value warning (KINEMATIC/DYNAMIC/UNKNOWN).
import com.pico.spatial.core.ecs.RigidbodyComponent
import com.pico.spatial.core.ecs.CollisionComponent

fun setupBody(target: Entity) {
    target.components.set(CollisionComponent())
    target.components.set(RigidbodyComponent())
    val mode = com.pico.spatial.core.ecs.simulation.RigidBodyMode.STATIC
}
