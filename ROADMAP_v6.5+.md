# ROADMAP v6.5+ — "Prompt an idea → a AAA spatial experience"

The north star: a user types an idea and gets a **running, honestly-verified, genuinely-authored** spatial app in the PICO emulator (and, on hardware, a real headset). This roadmap turns that from a slogan into phases, grounded in the 2026-07-02 recon (4-agent audit of the SDK, editor binary, and repo).

## The one honest truth this roadmap is built on
**The automated pipeline today renders exactly one thing: flat, unlit, tinted quads.** Every impressive demo — the textured duck, the 8 planets — was *hand-authored* scene code, not pipeline output. The `AppSpec` even carries the richer intent (`object.source:"model"`, `object.anim`, `data.texture`); the compiler drops it. "AAA" is therefore the work of closing the gap between *colored planes* and *authored worlds* — and the last mile (`bake_textured_model`: real GLB → PBR+ASTC bundle that renders on-device) already works and is verified.

## Two verdicts that set the strategy
- **The Android Studio "plugin hack" is UX-only.** The AS integration is a Gradle shim (`ide_build.sh`) around the editor's headless `--ide_noGraphics` build — the same path this MCP already calls. A plugin unlocks **zero** new rendering/authoring capability. Deferred as an optional front-door later; it is not a fidelity lever.
- **The fidelity ceiling is the Filament runtime**, not the editor GUI. AAA is decided by the baked content we feed Filament (real models, PBR, IBL), and by generated content — all gated by the honest eye.

## Decisions (locked 2026-07-02)
1. **First axis: visual fidelity (models + worlds)** → v6.5, v6.6.
2. **Content source: hybrid** — procedural/library now, hosted text→3D API behind a flag → v7.0.
3. **Spike the off-device USD renderer now** → done (feasibility proven, see below); productionize in v7.x.

---

## Phase v6.5 — Close the content pipeline (models) · HIGHEST LEVERAGE, LOWEST RISK
Wire the pipeline to use the already-verified bake path per item.
- Honor `object.source:"model"` in `compiler.ts` + `assemble.ts`: emit a `makeModelCard(item)` that `AssetBundle.load`s a per-item baked bundle (async on IO, attach on Main — the proven runtime-attach pattern), returning a placeholder quad until loaded.
- Fix the `import_model_catalog` → `generate_data_binding_kotlin` bridge (add a `model`/`bundle` field to `DataItem`; the audit found it broken at 3 points).
- **DoD:** a brief whose items are real models builds an app showing N distinct textured models (not quads), compile-verified against SDK 0.13.3 and vision-verified from a frame a human LOOKs at.
- **Honesty gate:** object-count via the eye still works; per-model *appearance* needs a human LOOK (the eye's color-match assist assumes flat tints — extend or defer to human).

## Phase v6.6 — PBR materials + real environments
- Swap authored primitives/cards from `UnlitMaterial` to `PhysicallyBasedMaterial` + `TextureResource`, so the already-wired lighting rig has something to light.
- Wire the equirect-**skybox** path (`prepare_environment` → sky-sphere texture override — recon's "best visual path") and `texturedMesh` environments into `AppSpec`/compiler, replacing the faked `homeEnvProxy` default in templates.
- **DoD:** a scene renders lit, textured content in a real environment, vision-verified.
- **Note:** hand-authored MaterialX `<image>` nodes render BLACK on this runtime — textures MUST go through the bake path.

## Phase v7.0 — Generative depth (hybrid), behind an honest 3-tier gate
- **Procedural/library first (deterministic, offline):** a curated GLB library + parametric USD authoring (the editor bundles full USD), bound to `AppSpec` nodes.
- **Hosted text→3D behind a flag:** one adapter (Meshy/Tripo/Luma → GLB) feeding the verified bake path; each generated asset **cached + sha256-pinned as a committed fixture** so the deterministic regression gate still holds.
- **The 3-tier honesty gate (non-negotiable):**
  1. `structural` — asset validates (tri-budget, has-UVs, finite bbox, texture res; extend `inspectGltf`). Reject Draco/degenerate/oversized.
  2. `auto_judged` — it rendered (object present, non-black, plausible color) via `capture_canonical` + `visual_judge`.
  3. `vision_verified` — a human signed off on **quality**. A generated asset is **capped at auto_judged until a human LOOKs** — "generated" must never masquerade as "good." (Optional later: an advisory `vlm_judged` class that ALWAYS escalates, never upgrades.)
- **DoD:** a text idea yields a novel asset in a running app, ledgered honestly (structural/auto_judged, human-upgraded only on sign-off).
- **Biggest risk:** the eye measures count/color/coverage, not aesthetics. If `auto_judged` is ever allowed to stand for aesthetic quality, the fleet greenlights ugly/malformed meshes and the soul breaks. Hard-cap enforced in the ledger.

## Phase v7.x — Systems depth + productionize the off-device renderer
- Compose the **orphaned codegen tiers** (particles, video, tween/orbit animation, rigid-body physics — all built + compile-verified, never wired into an app) via `AppSpec` (`object.anim`, new effect/physics nodes).
- **Off-device USD renderer** as a NEW tool + evidence class (`usd_host_render`), separately bucketed, never conflated with device `vision_verified`.
- Baked-texture **text labels** (no runtime `TextComponent`) for information-dense UIs.

## The off-device renderer spike — RESULT (both hard risks retired)
- `libusd_ms.dylib` (USD 24.x, namespace `pxrInternal_v0_24`) exports the full offscreen surface; `FrameRecorder::Record`, its ctor, `UsdStage::Open`, `UsdImagingGLEngine::Render` all dlopen+resolve (set `DYLD_FALLBACK_LIBRARY_PATH` to the Frameworks dir; strip the mach-o leading `_` for `dlsym`).
- **Offscreen GL works headless** on this Mac (OpenGL 4.1 Metal / Apple M5 Pro; FBO clear + `glReadPixels` verified).
- Remaining = a ~150-line C++ host (USD 24.08 headers + camera synthesis + `PXR_PLUGINPATH_NAME` → `Frameworks/usd`) — bounded engineering, no research risk.
- **Soul constraint:** Storm render ≠ Filament device render — verifies *composition/geometry*, not device appearance; new evidence class only, and it covers USD-authored scenes (pairs with moving composition to USD).

## Invariants that never bend
Generators stay analytical/deterministic (network gen is cached+pinned as data). Every new render path is `built`/`compiles` until a real frame is seen (human) or measured (calibrated eye), and `vision_verified` (aesthetic quality) stays human-gated by design. Respect C1–C4; defer Swan honestly. Keep the five gates green per increment; commit small verified steps; feed every gotcha back into MEMORY.
