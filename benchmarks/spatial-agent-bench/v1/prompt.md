Build a complete PICO Spatial SDK 0.13.3 application for the {{VARIANT_TITLE}} scenario.

Work only inside a new submission/ directory. Use package com.agentbench.{{VARIANT_ID}}.
Deliver the full Gradle project, source, manifest, resources, and executable tests; do not return only
an explanation or snippets.

The app starts in a planar spatial window showing three selectable items: {{ITEM_1}}, {{ITEM_2}}, and
{{ITEM_3}}. Show the current title, selected item, visit count, and paused/running state. Selecting an
item opens a Mixed Stage for it. Closing and reopening the Stage must preserve selection, title,
visit count, and pause state, and both containers must be able to update that same state.

In the Stage, place three spatial entities on a detected horizontal table. If no suitable table is
available, use a suitable horizontal floor. Surface readiness may lag tracking startup, so keep the
app responsive while searching and retry for a bounded period. Derive placement from the selected
surface pose and geometry. Show useful searching, no-surface, and error states. Release tracking,
subscriptions, and per-frame work when their owning lifecycle ends.

Animate the placed entities through engine-driven per-frame behavior. The pause control must stop and
resume that motion without losing the current selection or visit count.

For repeatable tests, expose a benchmark-only broadcast action
com.agentbench.{{VARIANT_ID}}.STATE whose response reports selection, title, visit_count, paused,
surface_status, surface_semantic, placement_count, and tick_count. Add executable tests that select
two different items, close and reopen the Stage, and prove the retained visit count and pause state.

Before finishing, run the strongest local build and unit-test commands available. Leave every
deliverable under submission/ and summarize the attempted commands and any remaining failure honestly.
