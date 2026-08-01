# PICO Swan bring-up checklist: com.example.showroomxr

> Day one on hardware = verify these (they were built + compile-checked on the emulator but are HEADSET-ONLY). Everything else was already emulator-verified.

- [ ] **controller-ray select** _(ceiling C3)_ — point the 6DOF controller ray at a target and pull the trigger; confirm select fires (vs the emulator head-ray/broadcast path).

Regressions: run `verify_baseline` against emulator baselines where applicable; structural via `assert_scene`.
