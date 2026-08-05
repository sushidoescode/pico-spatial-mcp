# Example scenes (vision-verified on the PICO Swan emulator)

- **docs-adoption-workbench.json** — a repo-only, non-executable structural recipe for a
  `DefaultStage` with caller-applied Mixed manifest style, a secondary `WindowContainer`, and
  spatial gesture lanes. It carries replayable generator args plus an explicit list of the app
  scaffolding, entity/color authorship, modifier mounting, destinations, and compile/LOOK work
  that Task 5 must supply. It is deliberately
  outside `BENCH_CORE` / `BENCH_MR` and excluded from the npm package. Its checks are structural;
  every appearance claim remains pending until someone builds the disposable demo and LOOKS at
  its captures.

- **HeroObservatory.kt** — the flagship complex experience for the video showcase
  (see `../VIDEO_DEMO.md`): a glowing emissive sun + point light, 5 orbiting PBR
  planets (one polished-gold with studio IBL reflection, two cyan emissive
  tech-worlds), spinning translucent holographic panels, and a pulsing status core.
  Uses the AAA generators: SceneLighting (shadow rig) + SceneAnimator
  (orbit/spin/bob + pulseEmissive/fadeOpacity) + SceneIBL (metal shine).
  Drop it into a scaffolded app's `content/` package alongside the generated
  SceneLighting.kt / SceneAnimator.kt / SceneIBL.kt + an `ibl/studio.ktx`
  (from `prepare_ibl_cubemap`).

- **BowlingGame.kt** — a REAL-PHYSICS bowling game (vision-verified): a lit wood lane with
  gutters, a polished metallic PBR ball (IBL shine), 10 spotlit pins in a triangle, and a
  glowing BOWL button. Broadcasting `bowl` (or clicking the button via the mouse bridge)
  throws the ball down the lane under real `PhysicsWorldComponent` + `RigidBodyComponent`
  simulation, knocking the pins down. KEY RECIPE: spawn a FRESH ball ELEVATED (not in resting
  contact) each throw so it's awake and its `PhysicsVelocityComponent` applies — a settled ball
  sleeps and ignores velocity. (The TransformComponent read-back is ~2s lagged; trust the visual.)
