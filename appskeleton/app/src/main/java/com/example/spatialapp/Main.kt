package com.example.spatialapp

import com.example.spatialapp.content.HomeStage
import com.pico.spatial.ui.design.PicoTheme
import com.pico.spatial.ui.foundation.dsl.DefaultStage
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope

/**
 * App entry — the immersive 3D scene lives in DefaultStage. This is the scaffold default:
 * generate_app_wiring overwrites this file (and HomeStage.kt) when an AppSpec drives the build.
 */
fun mainApp(scope: SpatialAppScope) = with(scope) {
    DefaultStage { PicoTheme { HomeStage() } }
}
