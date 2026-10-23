package com.example.picofixture.iteration.platform

import android.app.Application
import com.pico.spatial.ui.foundation.dsl.launch
import com.example.picofixture.iteration.mainApp
import com.example.picofixture.iteration.FixtureBridge

class SpatialApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        FixtureBridge.start(this)
        launch(::mainApp)
    }
}
