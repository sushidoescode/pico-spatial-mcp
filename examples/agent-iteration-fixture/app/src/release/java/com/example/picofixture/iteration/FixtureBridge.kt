package com.example.picofixture.iteration

import android.content.Context

/** Release has no instrumentation; this adapter keeps the shared Application source unchanged. */
object FixtureBridge {
    @Suppress("UNUSED_PARAMETER")
    fun start(context: Context) = Unit
}
