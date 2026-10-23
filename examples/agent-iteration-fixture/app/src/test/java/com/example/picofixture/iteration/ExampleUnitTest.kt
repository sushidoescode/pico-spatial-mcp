package com.example.picofixture.iteration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** App callback behavior only; Android run-as/IPC and rendered appearance require their own lanes. */
class ExampleUnitTest {
    @Test
    fun panelShowIsIdempotent() {
        assertFalse(FixtureState.panelVisible)
        assertEquals(0, FixtureState.counter)
        FixtureState.showPanel()
        assertTrue(FixtureState.panelVisible)
        assertEquals(1, FixtureState.counter)
        FixtureState.showPanel()
        assertTrue(FixtureState.panelVisible)
        assertEquals(1, FixtureState.counter)
    }
}
