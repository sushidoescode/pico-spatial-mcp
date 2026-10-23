package com.example.picofixture.iteration.content

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.example.picofixture.iteration.FixtureState
import com.pico.spatial.ui.design.PicoTheme
import com.pico.spatial.ui.design.Text

@Composable
fun HomePage() {
    Column(
        modifier = Modifier.fillMaxSize().padding(40.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Text("Agent iteration fixture (source revision 2)", color = PicoTheme.colorScheme.labelPrimary)
        Text("State transitions: " + FixtureState.counter, color = PicoTheme.colorScheme.labelPrimary)
        if (FixtureState.panelVisible) {
            Text(
                "Panel visible — fixture.panel",
                modifier = Modifier.testTag("fixture.panel"),
                color = PicoTheme.colorScheme.labelPrimary,
            )
        } else {
            Text("Panel hidden", color = PicoTheme.colorScheme.labelPrimary)
        }
    }
}
