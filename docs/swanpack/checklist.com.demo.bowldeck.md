# PICO Swan bring-up checklist: com.demo.bowldeck

> Day one on hardware = verify these (they were built + compile-checked on the emulator but are HEADSET-ONLY). Everything else was already emulator-verified.

- [ ] **sense/plane surface pins** _(ceiling C1)_ — put the headset on a real surface; confirm pins snap to floor/wall/ceiling and anchors persist across a relaunch.
- [ ] **WorldAnchor persistence** _(ceiling C1)_ — put the headset on a real surface; confirm pins snap to floor/wall/ceiling and anchors persist across a relaunch.
- [ ] **controller-ray interaction** _(ceiling C3)_ — point the 6DOF controller ray at a target and pull the trigger; confirm select fires (vs the emulator head-ray/broadcast path).
- [ ] **in-front interactive Compose panels** _(ceiling C4)_ — confirm interactive Compose panels render IN FRONT and respond to the controller (vs the emulator in-world textured-quad fallback).

Regressions: run `verify_baseline` against emulator baselines where applicable; structural via `assert_scene`.
