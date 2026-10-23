package com.example.picofixture.iteration

import android.content.Context

object FixtureBridge {
    private var bridge: AgentInteractionBridge? = null
    fun start(context: Context) {
        check(bridge == null)
        bridge = AgentInteractionBridge(context.applicationContext, FixtureState::showPanel).also { it.start() }
    }
}
