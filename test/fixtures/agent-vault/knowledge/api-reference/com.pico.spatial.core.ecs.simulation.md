# com.pico.spatial.core.ecs.simulation
# MassProperties
package com.pico.spatial.core.ecs.simulation {
    class MassProperties {
        constructor (mass: Float = 1.0f);
    }
}
# com.pico.spatial.core.ecs.simulation
# RigidBodyMode
package com.pico.spatial.core.ecs.simulation {
    enum RigidBodyMode: Enum<RigidBodyMode> {
        KINEMATIC,
        DYNAMIC,
        UNKNOWN

        val value: Int;

        fun valueOf(value: String) : RigidBodyMode;

        fun values() : Array<RigidBodyMode>;
    }
}
