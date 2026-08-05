# Build matrix

This page reports configuration observed in the packaged Android scaffold. It is not proof that a build, install, or rendered frame succeeded.

| Setting | Observed value | Source |
| --- | --- | --- |
| compile / min / target SDK | 35 / 35 / 35 | [app build file](../appskeleton/app/build.gradle.kts) |
| Java / Kotlin JVM target | 11 / 11 | [app build file](../appskeleton/app/build.gradle.kts) |
| Android Gradle Plugin | 8.13.2 | [version catalog](../appskeleton/gradle/libs.versions.toml) |
| Kotlin / Compose compiler plugin | 2.0.0 / 2.0.0 | [version catalog](../appskeleton/gradle/libs.versions.toml) |
| PICO Spatial BOM | 0.13.3 | [version catalog](../appskeleton/gradle/libs.versions.toml) |
| ABI | arm64-v8a | [app build file](../appskeleton/app/build.gradle.kts) |
| Spatial tools version | `not-declared` | no version key in the checked-in catalog |

Use `build_matrix_report` for the same source-grounded values. Use a build tool for build evidence, and inspect a rendered capture before making visual claims.
