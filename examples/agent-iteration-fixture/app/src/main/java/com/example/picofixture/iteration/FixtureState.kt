package com.example.picofixture.iteration

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

object FixtureState {
    var panelVisible by mutableStateOf(false)
        private set
    var counter by mutableStateOf(0)
        private set

    fun showPanel() {
        if (!panelVisible) {
            panelVisible = true
            counter += 1
        }
    }
}
