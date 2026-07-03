# 🎬 Video Showcase — Prompting the agent to build a complex spatial experience

This is a director's guide for recording a screen-capture demo of **pico-spatial-mcp**: you
type one high-level prompt, and the agent plans → builds → runs it on the PICO Swan emulator →
looks at a frame → confirms it works. Everything below is **verified working** (see
`ledger_report` — the hero scene is `vision_verified` on the emulator).

---

## ⭐ The hero prompt (copy/paste this on camera)

> **"Build me an interactive holographic orrery for the PICO emulator — a glowing sun at the
> center with planets orbiting it, and make one planet look like polished gold that reflects a
> studio light. Add a couple of floating holographic telemetry panels and a pulsing status core.
> I want it to look AAA: real directional lighting, soft shadows, and smooth animation
> throughout. Build the app, run it on the emulator, and show me a captured frame proving it
> actually renders and animates."**

That single sentence exercises **the whole toolkit**. What the viewer will watch the agent do:

1. **Plan** — the agent lays out the scene (a sun, N orbiting planets, holo panels, a status
   core) and picks the right primitives.
2. **Generate the AAA building blocks** with MCP tools (visible tool calls):
   - `generate_lighting_kotlin` → a shadow-casting sun + fill rig
   - `prepare_ibl_cubemap` → a studio HDR cubemap so the gold planet *shines*
   - `generate_ibl_kotlin` → wire the reflection onto the metal
   - `generate_scene_animator_kotlin` → reliable orbit / spin / bob + `pulseEmissive` / `fadeOpacity`
3. **Assemble & build** — writes the Kotlin scene, runs a headless Gradle build, installs on
   `emulator-5554`.
4. **Verify visually** — `capture_frame` (a deterministic `adb screencap`), then the agent
   **LOOKS at the image** and describes exactly what it sees (the glowing sun, the shining gold
   planet, the orbiting planets, the holo panels), plus a two-frame MAE check proving motion.
5. **Report honestly** — records a `vision_verified` ledger entry linked to the actual frame.
   (The tool's north star: "verified" only ever means an agent *saw* it render.)

**Expected result:** a glowing pulsing sun, 5 orbiting PBR planets (a glossy blue ocean world, a
red rocky world, a **polished gold world reflecting the studio softbox**, two cyan emissive
tech-worlds), two spinning translucent holographic panels, and a pulsing status core — all under
real lighting with shadows, animating at 60fps. (Reference frame: `/tmp/pico-render/hero2.png`.)

---

## 🎥 Recording tips

- **Show the tool calls.** The magic is watching the agent reach for `prepare_ibl_cubemap`,
  `generate_scene_animator_kotlin`, `capture_frame`, etc. — the plan-build-verify loop is the story.
- **Let it LOOK.** The moment the agent captures a frame and narrates what it sees ("the gold
  planet is reflecting the softbox…") is the payoff. That visual self-verification is the
  differentiator vs. code-only generators.
- **Keep content at eye level.** The emulator's forward `adb screencap` is byte-deterministic and
  frames eye-level content (y≈1.4) perfectly — no camera wrangling on camera.
- **One honest caveat to mention:** true boundless *walk-around* immersion is Swan-hardware only
  (the emulator can't composite third-party immersive layers — proven three ways). Everything here
  is bounded "diorama" content, which is exactly what the emulator renders beautifully.

---

## 🔁 Alternate hero prompts (same wow, different flavor)

**Premium product showcase (Apple-keynote vibe):**
> "Build a premium product showcase: a hero object on a lit pedestal under studio lighting so its
> chrome and gold materials actually shine, slowly rotating, casting a soft shadow. Run it on the
> emulator and show me it looks AAA."

**Living data command deck:**
> "Build a living telemetry dashboard: a row of data bars, height and color coded by value
> (green/amber/red), that grow in on load and cast shadows, with a pulsing status core above.
> Build it, run it, and prove the bars animate."

**Energy reactor / sci-fi core:**
> "Build a sci-fi energy reactor: a pulsing emissive core, orbiting glowing rings/nodes, and
> translucent holographic panels around it. AAA lighting, smooth animation. Run it on the emulator
> and show me a frame."

---

## 🧰 What's under the hood (the capabilities the demo proves)

| Capability | Tool | Verified |
|---|---|---|
| Full PBR (metallic / roughness / mirror) | material generators | ✅ emulator |
| Real directional shadows | `generate_lighting_kotlin` (AAA rig) | ✅ emulator |
| Shining metals (studio reflections) | `prepare_ibl_cubemap` + `generate_ibl_kotlin` | ✅ emulator |
| HDR emission (glow) | `setEmissiveColor` | ✅ emulator |
| Reliable orbit / spin / bob | `generate_scene_animator_kotlin` | ✅ emulator |
| Material FX (pulse / fade / hue cycle) | `SceneAnimator` FX | ✅ emulator |
| Grow-in reveal (data-viz) | `SceneAnimator.growY` | ✅ emulator |
| Deterministic visual verification | `capture_frame` + agent LOOK | ✅ emulator |

> **Real physics simulates on the emulator** (v8.8): a launched ball knocks down pins that fly and
> scatter — vision-verified (`examples/BowlingGame.kt`). There's a ~2s beat between a launch command
> and visible motion (the engine batches physics ops); it reads as anticipation on camera.
