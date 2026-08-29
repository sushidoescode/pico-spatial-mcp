# Swan Mission Table — flagship design sketch

## Concept

**Swan Mission Table** is a room-aware lunar mission-control diorama. It opens as a Mixed
Stage (`stageStyle: "1"`), leaving the currently selected PICO home environment visible, then
fits one coherent installation to detected room geometry. The fleet brief id will be
`swanmissiontable`; fleet build identity will therefore be `com.fleet.swanmissiontable`.

The experience uses exactly three mesh semantic labels:

- `SemanticLabelType.TABLE` supports the tabletop exhibit.
- `SemanticLabelType.FLOOR` supports the explicit visible fallback when TABLE is absent.
- `SemanticLabelType.WALL_ART` supports the companion mission-control panel.

It never assumes a Museum environment, indexes an anchor list, or asserts an anchor count.
Counts and runtime UUIDs may change whenever an environment is re-selected. Triangle-to-label
alignment remains unverified, so the experience uses label-level anchor transforms and bounds
only; it does not infer a semantic triangle, face normal, or triangle-level spatial relation.

## The room-aware composition

On Stage entry, the app subscribes for mesh updates before starting mesh tracking. It waits for
two consecutive unfiltered, non-empty mesh reads before applying label filters, then classifies
`TABLE`, `FLOOR`, and `WALL_ART` from that same snapshot in one off-main pass.

For `TABLE`, it rejects geometrically unusable candidates, prefers the nearest usable horizontal
support to the Stage origin, and uses a stable bounds-and-pose tie-break rather than list order.
The installation root inherits that label-level anchor transform. Its base sits at the anchor
AABB top. A metre-authored mission-glass deck targets a 0.68 m × 0.42 m footprint and uniformly
scales down only when needed to remain within 70 percent of the detected table bounds; the
effective size and scale are displayed rather than hidden. If `TABLE` is absent but `FLOOR` is
present, the same installation remains visible at a deterministic forward X/Z target clamped
inside the live FLOOR bounds, on a 0.62 m floor-contacting plinth. The panel reports
`TABLE label_absent — FLOOR fallback`, and periodic re-query keeps TABLE preferred if it later
appears. If neither support label is present, the installation is hidden and continues waiting.

The table becomes a miniature space programme: a deep-blue Earth with a thin atmosphere shell,
a Moon, a lit orange launch pad, a capsule rocket, a dotted orbital path, and telemetry pylons.
Earth spins while the Moon and spacecraft orbit with separate radii and phases. Motion uses
PICO's engine-ticked ECS System lane, with delta-time-scaled `SpinComponent`/`SpinSystem` and
`OrbitComponent`/`OrbitSystem`; there is no timer-driven transform loop.

For `WALL_ART`, the app re-queries independently and chooses the usable match closest to the
selected table by centre distance, again with a stable geometric tie-break. An in-scene
`AttachmentPanel` sits 6 cm toward the Stage origin from the label-level anchor centre and uses
`LookAtComponent.setViewerAsTarget()`; it does not pretend the per-face semantic stream proves a
wall-facing normal. If `WALL_ART` is absent, the exhibit continues and the same panel moves to a
documented local position just above the table with `WALL_ART NOT PRESENT` visible.

The panel is SpatialUI inside `PicoTheme`, with no Material imports. It presents MISSION CONTROL,
flight phase, matched label names, detected surface dimensions, effective model scale, and live
orbit time. Public PICO `Button` affordances provide LAUNCH, PAUSE, and RESET. Equivalent
broadcast commands drive the same state transitions for deterministic emulator validation; that
route does not claim controller or gaze evidence. LAUNCH enables the spacecraft orbit and
advances the flight phase, PAUSE toggles the ECS components' `enabled` state, and RESET restores
the initial phase and angles.

## Re-selection and lifetime rules

Mesh ADDED, UPDATED, and REMOVED events trigger a bounded re-query; a slow periodic re-query also
catches environment re-selection. Every pass begins with unfiltered readiness and then re-matches
by label plus geometry. Runtime UUIDs are hints within one tracking epoch, never persistent
identity. Pose changes below a 2 cm / 2 degree deadband are ignored to prevent shimmer; larger
changes move the single installation root and its panel coherently. No stale anchor becomes a
placement authority.

The owning composition pairs every acquisition with cleanup: cancel the re-query job and mesh
subscription, stop mesh tracking, unregister both ECS systems, detach the exact Stage root from
AgentBridge, and release generated scene resources. The Stage attaches through
`AgentBridge.attachScene(stageRoot, "stage")` and registers the revision-41 scene-snapshot
producer, so the running build can expose the lossless
`pico.agent-bridge.scene-snapshot` schema-version-1 payload required by `query_scene_anchors`.

## What this demonstrates

One experience composes the visible home environment, metre-aware placement on a detected table,
a second semantic surface for companion UI, engine-owned living motion, SpatialUI interaction,
and a versioned inspection bridge. The room is part of the exhibit rather than a backdrop. Its
claims stop at label-level placement: exact counts, semantic-face alignment, hand/controller
input, and any particular home environment remain evidence to measure, not assumptions.
