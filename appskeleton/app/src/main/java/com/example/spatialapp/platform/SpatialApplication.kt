package com.example.spatialapp.platform

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import com.pico.spatial.ui.foundation.dsl.launch
import com.example.spatialapp.mainApp
import com.example.spatialapp.content.dispatchDebugCommand

class SpatialApplication : Application() {
    companion object {
        /** Absolute path of the app's external files dir, captured where a Context exists. */
        @Volatile var externalFilesPath: String? = null
    }

    // Headless debug command channel: `adb shell am broadcast -a com.example.spatialapp.DEBUG_CMD
    // --es cmd <place|clear>`. Lets an agent drive marker placement on the emulator, where the
    // controller trigger is GUI-gated.
    private val cmdReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val cmd = intent?.getStringExtra("cmd") ?: return
            runCatching { dispatchDebugCommand(cmd, intent.getIntExtra("arg", 0)) }
                .onFailure { Log.e("SpatialDemo", "DEBUG_CMD '$cmd' failed: ${it.message}") }
        }
    }

    override fun onCreate() {
        super.onCreate()
        externalFilesPath = getExternalFilesDir(null)?.absolutePath
        launch(::mainApp)
        val filter = IntentFilter("com.example.spatialapp.DEBUG_CMD")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(cmdReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(cmdReceiver, filter)
        }
        Log.i("SpatialDemo", "DEBUG_CMD receiver registered")
    }
}
