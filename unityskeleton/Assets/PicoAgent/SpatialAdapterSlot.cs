using UnityEngine;

/// The slot PICO's SpatialAdapter Unity packages drop into. unity_scaffold_project's
/// spatialAdapter input adds the packages to Packages/manifest.json and puts the define below
/// into picoagent-config.json extraDefines; until then this compiles to nothing. Wiring
/// milestone when the packages land: does adapter output composite in shared space on the
/// emulator? (LOOK, then record.)
public static class SpatialAdapterSlot
{
#if PICO_SPATIAL_ADAPTER
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Init()
    {
        // PICO SpatialAdapter initialization goes here the day the packages exist.
        Debug.Log("PICOAGENT| spatial_adapter_slot_active");
    }
#endif
}
