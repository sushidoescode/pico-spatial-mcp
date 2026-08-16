Build a complete PICO Spatial SDK 0.13.3 application for the {{VARIANT_TITLE}} scenario.

Work only inside a new submission/ directory. Use package com.agentbench.{{VARIANT_ID}}.
Deliver the full Gradle project, application code, manifest, resources, and executable tests; do not return only
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

For repeatable instrumentation, expose one benchmark-only ordered broadcast action
com.agentbench.{{VARIANT_ID}}.STATE. Read canonical JSON from the agentbench_request string extra and
return canonical JSON in the agentbench_response string result extra. A request contains
protocol_version 1, an opaque request_id, one command from snapshot, select, open_stage,
close_stage, pause, or resume, and an item only for select. Reject duplicate request IDs and invalid
field combinations.

Echo protocol_version and request_id in every response. Return status (ok or error), a nullable
error_code, and a reported object containing selection, title, visit_count, paused, stage_open,
surface_status, surface_semantic, placement_count, tick_count, process_instance, and
stage_generation. process_instance is an app-created value for one application-process lifetime;
stage_generation starts at zero and increments when the app creates a new Stage instance. Fresh app
state reports no selection, zero visits, running, and no open Stage. Each accepted select of one of
the three listed items increments visit_count once and opens the Stage if needed. Close and reopen
preserve selection, title, visit count, and pause state. A successful response has a null error_code.
A reused request ID, an invalid item/command field combination, or an item outside the three listed
items returns error with duplicate_request_id, invalid_fields, or unknown_item respectively and does
not change reported state. These fields are application-reported instrumentation and do not replace
the visible application behavior.

Add executable tests that select two different items, close and reopen the Stage, and assert the
retained visit count and pause state. Before finishing, run the strongest local build and unit-test
commands available. Leave every deliverable under submission/ and summarize the attempted commands
and any remaining failure honestly.
