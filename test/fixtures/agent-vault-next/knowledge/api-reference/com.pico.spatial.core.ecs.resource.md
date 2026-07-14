# com.pico.spatial.core.ecs.resource
# ShapeResource
package com.pico.spatial.core.ecs.resource {
    class ShapeResource: Resource {
        object Companion {
            /**
             * Creates a box-shaped ShapeResource with the specified dimensions.
             */
            @JvmStatic fun createBox(size: Vector3) : ShapeResource;

            /**
             * Creates a capsule-shaped ShapeResource with the specified height and radius.
             *
             * @param height The total height of the capsule, including the spherical caps, in meters.
             * @param radius The radius of the capsule in meters.
             */
            @JvmStatic fun createCapsule(height: Float, radius: Float) : ShapeResource;

            @JvmStatic fun createSphere(radius: Float) : ShapeResource;
        }
    }
}
# com.pico.spatial.core.ecs.resource
# MeshResource
package com.pico.spatial.core.ecs.resource {
    class MeshResource: Resource {
        object Companion {
            @JvmStatic fun createCapsule(height: Float, radius: Float) : MeshResource;
        }
    }
}
# com.pico.spatial.core.ecs.resource
# PhysicallyBasedMaterial
package com.pico.spatial.core.ecs.resource {
    class PhysicallyBasedMaterial: Material {
        constructor ();
    }
}
# com.pico.spatial.core.ecs.resource
# PhysicsMaterialResource
package com.pico.spatial.core.ecs.resource {
    class PhysicsMaterialResource: Resource {
        constructor (staticFriction: Float, dynamicFriction: Float, restitution: Float);
    }
}
