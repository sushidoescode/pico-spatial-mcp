# com.pico.spatial.core.ecs
# Entity
package com.pico.spatial.core.ecs {
    /**
     * The base ECS entity. Doc comments embed code samples that MUST NOT be indexed:
     * ```kotlin
     * class Sneaky : Component() { fun trap() { } }
     * ```
     */

    open class Entity: EventSource, SpatialCoordinateSpace {
        constructor ();

        @Volatile var scene: Scene ?;

        fun setName(name: String);

        open operator override fun equals(other: Any ?) : Boolean;

        object Companion {
            @JvmStatic suspend fun loadSuspend(file: File) : Entity;
        }

        class CloneOptions(val recursive: Boolean = false, val shouldShareMaterialInstance: Boolean = false) {
        }
    }
}
# com.pico.spatial.core.ecs
# RigidBodyComponent
package com.pico.spatial.core.ecs {
    /**
     * A Component responsible for defining the properties of the rigid body.
     */

    @MainThread class RigidBodyComponent: Component {
        constructor ();

        constructor (massProperties: MassProperties, rigidBodyMode: RigidBodyMode);

        /**
         * Controls how fast a dynamic rigid body's rotational motion approaches rest. Default value is 0.05.
         */
        var angularDamping: Float;

        var isAffectedByGravity: Boolean;
    }
}
# com.pico.spatial.core.ecs
# AnchorComponent
package com.pico.spatial.core.ecs {
    @MainThread class AnchorComponent: Component {
        @MainThread constructor (anchorTarget: AnchorTarget);

        enum Alignment: Enum<AnchorComponent.Alignment> {
            /**
             * Returns the enum constant of this type with the specified name — a phantom doc
             * with NO declaration following it (real corpus quirk; must not create a member).
             */
            CENTER,
            EDGE

            val value: Int;

            fun values() : Array<AnchorComponent.Alignment>;
        }

        class TrackingMode {
            open operator override fun equals(other: Any ?) : Boolean;

            object Companion {
                @JvmField val CONTINUOUS: AnchorComponent.TrackingMode;
            }
        }
    }
}
# com.pico.spatial.core.ecs
# CollisionComponent
package com.pico.spatial.core.ecs {
    @MainThread class CollisionComponent: Component {
        constructor (shapes: List<ShapeResource>, material: PhysicsMaterialResource);

        constructor (shapes: List<ShapeResource>, material: PhysicsMaterialResource, mode: ColliderMode, filter: CollisionFilter, detail: CollisionInfoDetailLevel);
    }
}
# com.pico.spatial.core.ecs
# ModelComponent
package com.pico.spatial.core.ecs {
    @MainThread class ModelComponent: Component {
        constructor ();
    }
}
# com.pico.spatial.core.ecs
# PhysicsForceComponent
package com.pico.spatial.core.ecs {
    @MainThread class PhysicsForceComponent: Component {
        constructor ();
    }
}
# com.pico.spatial.core.ecs
# PhysicsVelocityComponent
package com.pico.spatial.core.ecs {
    @MainThread class PhysicsVelocityComponent: Component {
        constructor ();
    }
}
# com.pico.spatial.core.ecs
# PhysicsWorldComponent
package com.pico.spatial.core.ecs {
    @MainThread class PhysicsWorldComponent: Component {
        constructor ();
    }
}
# com.pico.spatial.core.ecs
# TransformComponent
package com.pico.spatial.core.ecs {
    @MainThread class TransformComponent: Component {
        constructor (position: Vector3, rotation: Quat, scale: Vector3);
    }
}
# com.pico.spatial.core.ecs
# ExtraComponentDataSyncer
package com.pico.spatial.core.ecs {
    typealias ExtraComponentDataSyncer = (ComponentType, Entity) -> Component ? {
    }
}
