# com.pico.spatial.core.math
# Vector3
package com.pico.spatial.core.math {
    @Immutable class Vector3 {
        constructor (x: Float = 0.0f, y: Float = 0.0f, z: Float = 0.0f);

        constructor (value: Float = 0.0f);

        var x: Float;

        var y: Float;

        var z: Float;

        operator fun div(other: Vector3) : Vector3;

        object Companion {
            @JvmField val ZERO: Vector3;

            @JvmStatic fun cross(a: Vector3, b: Vector3) : Vector3;
        }
    }
}
# com.pico.spatial.core.math
# Quat
package com.pico.spatial.core.math {
    @Immutable class Quat {
        constructor (x: Float = 0.0f, y: Float = 0.0f, z: Float = 0.0f, w: Float = 1.0f);

        object Companion {
            @JvmStatic fun identity() : Quat;
        }
    }
}
# com.pico.spatial.core.math
# Color4
package com.pico.spatial.core.math {
    @Immutable class Color4 {
        constructor (red: Float = 0.0f, green: Float = 0.0f, blue: Float = 0.0f, alpha: Float = 1.0f);

        val red: Float;
    }
}
# com.pico.spatial.core.math
# EulerAngles
package com.pico.spatial.core.math {
    @Immutable class EulerAngles {
        constructor (pitch: Float = 0.0f, yaw: Float = 0.0f, roll: Float = 0.0f);
    }
}
