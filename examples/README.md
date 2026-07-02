# Example scenes (vision-verified on the PICO Swan emulator)

- **HeroObservatory.kt** — the flagship complex experience for the video showcase
  (see `../VIDEO_DEMO.md`): a glowing emissive sun + point light, 5 orbiting PBR
  planets (one polished-gold with studio IBL reflection, two cyan emissive
  tech-worlds), spinning translucent holographic panels, and a pulsing status core.
  Uses the AAA generators: SceneLighting (shadow rig) + SceneAnimator
  (orbit/spin/bob + pulseEmissive/fadeOpacity) + SceneIBL (metal shine).
  Drop it into a scaffolded app's `content/` package alongside the generated
  SceneLighting.kt / SceneAnimator.kt / SceneIBL.kt + an `ibl/studio.ktx`
  (from `prepare_ibl_cubemap`).
