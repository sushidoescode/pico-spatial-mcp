# Reusable PICO spatial UI polish — design and handoff

Status: proposed implementation direction requested by the user, ready for autonomous execution through the companion prompt. No skill, component kit or demo is implemented by this document.

Read [the starting identity](README.md), [Chat A's operational handoff](MCP_ACTIVATION_HANDOFF.md) and [the implementation plan](SPATIAL_POLISH_PLAN.md). Chat B uses Chat A's actual final checkpoint; f349eaf alone is not native acceptance.

## Product intent and scope

Give future PICO Spatial SDK apps a reusable way to produce clean, coherent, highly polished buttons, windows and containers. “AAA feel” means deliberate hierarchy, readable text, consistent proportions, crisp shapes, responsive real interactions and smooth comfortable motion, supported by hardware evidence. It is not a claim established by a style adjective or shader count.

The initial aesthetic is neutral adaptive native glass, restrained edge definition, one configurable accent, generous spacing and calm transitions. Product-specific palettes and typography remain supported; this is not a universal compulsory skin.

Three deliverables:
1. A repository-owned versioned skill that helps future agents choose, implement and review the design.
2. An original reusable Kotlin/SpatialUI component module with actual behavior and accessibility options.
3. A separate functional UI showcase app, exercised in the emulator and on the identified owned headset.

Initial scope is native Spatial SDK/SpatialUI. Unity, WebView/web and other UI stacks need separate adapters; do not claim automatic coverage of “any app.” Existing applications adopt the kit explicitly. Mission Replay stays paused.

## Approaches and recommendation

| Approach | Value | Limit |
|---|---|---|
| Native PICO materials, built-in components and a reusable token/wrapper layer — recommended | Best starting point for native interaction, runtime adaptation, readable text and maintained APIs | Optical effects remain bounded by public PICO support |
| Native foundation plus a small custom enhancement layer | Can add restrained edge/depth and transition details after measurement | Every effect needs capability, stereo, readability and performance evidence |
| A custom refractive rendering system | Could explore a stronger optical style | High rendering/compositor risk and much larger scope; requires a separate justified project |

Implement the first approach. Admit parts of the second only when they improve a measured comparison and retain a native fallback. Do not make custom refraction a dependency of the first release.

Apple's Liquid Glass is design inspiration, not a portable PICO API. Apple's materials guidance separates functional controls/navigation from content and encourages restraint; visionOS window glass also has its own platform behavior. Do not conflate them or promise pixel-identical Apple rendering. [Apple HIG materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/).

## Native visual contract

- Use the official PICO design-style contract and verified built-ins first. Wrappers preserve native semantics, hit testing and enabled/disabled behavior.
- Own one theme/token mapping, including deliberate inherited roles. The inspected 6.1.9 ColorScheme exposes 16 public roles. Recheck the actual resolved version; do not freeze a stale field count across future SDK changes.
- Resolve text foregrounds explicitly on ordinary layout surfaces. Local PicoTheme sources do not provide LocalContentColor; slot inheritance must have a verified provider.
- Window background, inner material surface and 3D scene attachment are different cases. Document which layer owns the background. Avoid doubled glass, opaque paint covering native glass or a helper that secretly creates another window.
- Leave the native root background alone by default. Switching it off must use the correct mechanism for that container. Resolve nullable/inherited defaults from the selected declarations and runtime.
- Clip a custom material surface to its shared shape before applying the material. Border, visual bounds and interactive bounds must agree.
- Use native hover/press/indication/haptics. Built-ins that already implement hover must not receive a duplicate hover modifier. Avoid decorative movement that shifts the hit target.
- Use consistent native typography roles and optical icon alignment. Use original or appropriately licensed assets; do not redistribute Apple assets or copied vendor implementation sources.
- Do not add blur/refraction APIs or backdrop/passthrough sampling by assumption. The inspected public backgroundMaterial modifier exposes enable/style, not arbitrary refraction controls.
- Material.Thin is unsuitable as a window-glass solution in the inspected 6.1.9 sources; it maps to no window material. Treat inner surfaces and window roots separately.

Relevant public declarations: [PICO material API](https://developer.picoxr.com/spatial-api/6.1.9/spatialui/foundation/com.pico.spatial.ui.foundation.material/index.html), [PICO design API](https://developer.picoxr.com/spatial-api/6.1.9/spatialui/design/com.pico.spatial.ui.design/index.html), [PICO Vibrant API](https://developer.picoxr.com/spatial-api/6.1.9/spatialui/foundation/com.pico.spatial.ui.foundation.vibrant/-vibrant/index.html). Public docs and local source presence do not prove what the demo resolves or renders.

## Existing skill/source map to inspect

Official plugin observed at:
/Users/sushantsrikrish/.codex-account-a/plugins/cache/pico-xr/pico-spatial-agentic-tools/0.5.0/skills

Read applicable current copies of spatial-ui-design-style, spatial-ui-ability, pico-env-doctor, pico-cli, spatial-app-onboarding, spatial-app-dev-workflow, spatial-sdk-guideline and, when needed, spatial-sdk-scene-builder/spatial-editor. Locate the Claude installation rather than assuming Codex's cache is Claude's runtime.

Do not edit cached vendor skills. The new skill is an additive, repository-owned contract that names its upstream dependency and records version drift. Do not silently weaken its verifier. If a verifier contradicts the resolved SDK, retain a minimal reproducer and a source-based ruling.

Known examples requiring source review:
- spatial-ui-ability/references/ability-background-material.md omits clipping in a rounded example; the design-style admission rule requires it.
- spatial-ui-design-style/references/hover.md warns against double hover but includes a Card example that adds hover.
- references/window-background.md illustrates Thin at a root, contrary to the inspected 6.1.9 window behavior.
- Simplified WindowContainer documentation describes a true default; the inspected DSL declaration is Boolean? = null. Resolve effective inheritance instead of substituting true blindly.

Local archives observed under /Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1/com.pico.spatial.ui/:

| Relative archive | SHA-256 |
|---|---|
| design/6.1.9/66d81734408d681a06a5f3368273de897f243a6a/design-6.1.9-sources.jar | d117cc73260f05af6b623c84aeefcd8bb2e023f86424f3c138b0257b26c8c210 |
| foundation/6.1.9/11e412b8e05590f1c15bd95e05b48112df390a0d/foundation-6.1.9-sources.jar | 3961ddd8e110653c68edb56a02f9f14963fcd1c41818670b390cafad5a63e6d6 |
| platform/6.1.9/c75a557d0337296ec4d4c1d4f4e396a6101fa480/platform-6.1.9-sources.jar | d39051031c44c3819d1da1dfbede69a55b5a5d97466238996262f4b3017bb264 |

Record archive hash, member path, line span and resolved dependency identity for each supported API. Relevant members include com/pico/spatial/ui/design/{ColorScheme,PicoTheme,Button}.kt, com/pico/spatial/ui/foundation/dsl/WindowContainer.kt, foundation/material/BackgroundMaterial.kt, foundation/window/Augments.kt, foundation/hover/SpatialHoverEffect.kt and com/pico/spatial/ui/platform/Material.kt. Paths abbreviated after the first package prefix must be resolved within the archive, not guessed in code.

## Component and showcase boundary

Required first component families:
- Primary/secondary/icon buttons, including disabled and loading states.
- A shaped inner surface/card and a window-content layout.
- A compact toolbar/segmented choice using available built-ins.
- Toggle and slider controls with real state.
- An editable field with long-text/error behavior.
- A dismissible secondary panel or dialog using a verified native container path.

Keep state and callbacks owned by the consuming app. Avoid a generic boolean-parameter component that mixes every interaction and window lifecycle into one function. Window creation/lifecycle belongs to the app.

The separate showcase has two useful flows that consume the same module:
1. A small library/browser view with selectable items, toolbar, details and one secondary surface.
2. A settings/control view with theme/accent selection, slider/toggle, editable text, reduced settings and reset.

Use real actions and state transitions, not dummy onClick handlers. Keep diagnostics and A/B controls in the showcase, not in the reusable app-facing components. A development-only state gallery may aid review but does not replace interaction evidence.

Compare identical content/layout in three modes:
- Stock native baseline.
- Polished native default.
- Optional enhanced mode only if supported and measured.

The native default must already be attractive and complete. Disabling an effect must never disable functionality.

## Accessibility, comfort and motion

Support reduced motion, increased contrast and reduced transparency as real settings, using supported platform preferences where available and explicit app settings otherwise. Persist app settings. Reduced transparency uses a deliberately owned opaque background rather than stacking opacity over existing glass.

Use a coherent brief motion specification: proposed 120–180 ms feedback and 180–240 ms panel transitions, with minimal translation and no overshoot in the initial design. These are design defaults to tune with evidence, not PICO timing requirements. Do not replace native interaction timing simply to meet those numbers.

Provide semantic labels, visible focus/selection and non-color-only states. Do not assume gaze/hand/controller features from the headset name; identify supported input modes, test those available, and disclose the rest. Headset wearer confirmation is required for comfort, stereo depth and reachability.

For the controlled test backgrounds, target at least 4.5:1 normal text contrast and 3:1 large text contrast, documenting which text qualifies and the rendered sampling method. These are adopted 2D legibility targets from [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), not a claim of complete XR accessibility conformance. Native vibrant/composited output and real passthrough need rendered assessment; nominal token values are insufficient.

## Acceptance matrix

| Dimension | Required observation |
|---|---|
| Visual | Opened native frames showing clean corners, no doubled borders/glass, legible foregrounds and clear hierarchy |
| Backgrounds | Controlled bright, dark and detailed backgrounds; physical passthrough when available, with user privacy preserved |
| Interaction | Actual hover/press/select/toggle/edit/dismiss paths, correct disabled/loading behavior, and observed state result |
| Layout | Minimum/default/expanded supported window sizes, long text and increased text size without clipped essential actions |
| Reduced settings | On/off comparison for motion/transparency/contrast; feature parity maintained |
| Motion | Native recordings inspected over transition intervals; no claim based only on endpoint stills |
| Physical headset | Exact model/runtime/serial, APK identity, native capture and wearer observations separately recorded |
| Reuse | Both showcase flows use the canonical module; no copied component implementation between them |
| Skill quality | Fresh-agent tasks improve over baseline and preserve upstream contracts; no unsupported optical promises |
| Discovery | Packaged skill and references load through the actual host integration route; static checks labeled separately |
| Performance | Native baseline and polished variant sampled under the same actual refresh/thermal/input conditions; unsupported counters remain unknown |

Performance protocol: identify refresh rate and metric scope first. Warm up for at least 30 seconds; collect three 60-second baseline samples and three 60-second candidate samples in interleaved order where tooling supports it. Retain temperatures/throttling and workload context. A run interrupted by a thermal/runtime transition is separately labeled, not selectively hidden.

Proposed project budget: app CPU and GPU p95 each <=85% of the relevant frame interval, and p99 <=one frame interval, when the profiler exposes those comparable measurements. Do not add CPU/GPU times as though serial, or compare app time to a different compositor refresh. Require no new sustained missed-frame pattern relative to the stock baseline. If metric scope cannot support the budget, report that lane unestablished and retain recordings; do not invent FPS from PxrMetric or screenshots. These are proposed app-quality budgets, not vendor guarantees or replacements for the emulator admission gate. Prefer removing optional effects to lowering targets after a failure.

## Definition of a reviewable first release

The installed skill is discoverable in the supported host route, its original component module builds against pinned resolved dependencies, both showcase flows function, emulator and headset evidence are clearly separated, native motion/perf/accessibility results are retained, and an independent reviewer has no unresolved blocking findings. The user receives a build and concise visual comparisons for motion review.

If a native lane is blocked, finish host work and report the unresolved lane. Do not call it device-accepted. Do not resume Mission Replay or imply the polish is automatically applied to other apps.

