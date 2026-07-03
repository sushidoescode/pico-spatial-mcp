# 🧪 Dry run — prompt a fresh agent to build the hero experience

This is the exact setup + steps to rehearse (and record) "type one prompt → the agent plans,
builds, and visually verifies a complex spatial app." Everything the MCP needs (JBR, adb, the
PICO toolchain) it resolves itself — no env vars to set.

---

## 0) One-time: register the MCP with Claude Code

MCP servers load at session start, so register it **once** in your terminal (not mid-session):

```bash
claude mcp add pico-spatial-mcp --scope user -- node /Users/sushantsrikrish/PICO-MCP/dist/index.js
```

`--scope user` makes the `pico-spatial-mcp` tools available in **every** Claude Code session on
this machine. Verify:

```bash
claude mcp list          # should show: pico-spatial-mcp
```

(If you ever edit the MCP's source, rebuild with `npm run build` in `~/PICO-MCP`.)

---

## 1) Before each run (30 seconds)

- **Emulator running** — it should already be up (`emulator-5554`). If not, launch the PICO
  **Spatial Editor** app (`~/Library/PICO/sdk/0.13/editor/Spatial Editor.app`), which boots the
  emulator. Confirm: `~/Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb devices`
  → `emulator-5554  device`.
- **Fresh camera (recommended for a clean shot)** — the emulator's free-cam remembers where it
  was last dragged. For a crisp forward capture, **restart the emulator** before recording so the
  camera is at its default pose (otherwise a capture can show the home-env bedroom instead of your
  scene). Keeping hero content at eye level + never dragging the free-cam avoids this.

---

## 2) Start the session and paste the prompt

```bash
cd ~/PICO-MCP            # run here so the agent has the AAA memory + can read VIDEO_DEMO.md/examples
claude
```

Approve the `pico-spatial-mcp` tools when prompted (once). Then paste the prompt.

> **Running inside `~/PICO-MCP` gives the agent the best context** (its recalled memory of every
> AAA gotcha + the example scene), so the dry run is smooth and representative. For a truly *cold*
> test (fresh empty folder, no memory), the agent works only from the tool descriptions — more
> realistic but rougher; do that once you're confident.

### Prompt A — dry run (a little directive, so a fresh agent lands it first try)

> **"Build me an interactive holographic orrery as a native PICO spatial app for the emulator.
> Scaffold a new app by cloning `~/AndroidStudioProjects/galleryxr-native` as the template
> (new package `com.demo.observatory`, into `~/AndroidStudioProjects/observatory-native`). Then
> build the scene at eye level (around y=1.4, z=-3 so the forward capture frames it): a glowing
> pulsing sun at the center with 4–5 planets orbiting it — make one look like polished gold that
> reflects a studio light — plus a couple of floating translucent holographic panels and a pulsing
> status core. Make it AAA: real directional lighting, soft shadows, and smooth animation. When
> it's built, install it on the emulator, capture a frame, LOOK at it, and tell me exactly what you
> see to confirm it renders and animates."**

### Prompt B — the natural hero prompt (for the polished video)

> **"Build me an interactive holographic orrery for the PICO emulator — a glowing sun with orbiting
> planets (make one look like polished gold that reflects a studio light), floating holographic
> panels, and a pulsing status core. AAA lighting, shadows, smooth animation. Build it, run it on
> the emulator, and show me a captured frame proving it actually renders and animates."**

---

## 3) What you'll watch the agent do (≈3–6 min)

1. **Scaffold** a new app (`scaffold_spatial_app` clones the template + rebrands — ~30–60s copy).
2. **Generate AAA building blocks** (visible tool calls): `generate_lighting_kotlin` (shadow rig),
   `prepare_ibl_cubemap` (studio HDR cubemap via cmgen), `generate_ibl_kotlin` (metal reflection),
   `generate_scene_animator_kotlin` (orbit/spin/bob + pulse/fade).
3. **Write** the scene (`HomeStage.kt`) and **build** (`build_and_run` → headless Gradle → install).
4. **Verify visually** — `capture_frame` (deterministic `adb screencap`), then the agent **looks
   at the image** and describes the glowing sun, the shining gold planet, the orbiting planets, the
   holo panels; a two-frame check confirms motion.
5. **Report** — records a `vision_verified` ledger entry linked to the frame.

---

## 4) Gotchas to know while filming

- **First build is slow** (Gradle warm-up + scene packing) — 1–3 min. Subsequent builds are faster.
- **Home-env bedroom in a capture** = the free-cam drifted; restart the emulator for a clean pose,
  or the agent can pitch the view back. Eye-level content + plain forward capture avoids it.
- **No boundless walk-around** — the emulator can't composite third-party immersive layers (proven);
  everything is bounded "diorama" content, which is what it renders beautifully. Mention this only
  if asked; it's a Swan-hardware feature.
- **Physics doesn't simulate** on the emulator — motion is scripted animation, not rigidbody.

See `VIDEO_DEMO.md` for the full director's guide + alternate hero prompts.
