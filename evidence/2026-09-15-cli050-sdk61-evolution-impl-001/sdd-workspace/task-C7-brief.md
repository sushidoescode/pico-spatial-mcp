## C7: Route new CLI capabilities and finish the implementation checkpoint

**Files:** update `src/doors.ts` descriptions only where behavior changed; update relevant public guidance through the metadata/policy process; create `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` and `docs/findings/CLI050_CAPABILITY_MATRIX.md` during execution.

- [ ] Map official knowledge, project context, SpatialML, plugin and Editor workflow capabilities to existing MCP user intents. Include explicit availability and whether the MCP delegates, composes, or has no execution integration. Do not add one tool per CLI command.
- [ ] Review the official 0.5 Editor bootstrap workflow controller before expanding MCP Editor orchestration. Prefer consuming its manifest/review artifacts for app integration, preserving the distinction between an Editor's decision and independently earned app/native evidence.
- [ ] Audit dated retained lessons and usage text. This audit's `pico_fix` matched a historical interactive-hang rule recommending old commands; it was not applied. Preserve historical evidence and version-scope guidance rather than treating an old keyword match as a current command contract. Do not delete the user's local lesson store.
- [ ] Finish the release and SDK subplans, reconcile shared-file edits, rebuild current source and run the necessary targeted plus release checks. Record source/build/package identity and platform-specific skips. Re-run broader tests only for changed inputs, failures or unresolved integration concerns.
- [ ] Decide release version from the actual compatibility effect; synchronize lock/manifests through supported metadata tooling and package into a fresh immutable output directory. No push or history rewrite. No release claim before required checks succeed.
- [ ] Write the two implementation documents with actual commands, results, artifact paths, before/after behavior and unresolved utility/native acceptance. Include a concise copy-paste continuation prompt for any externally blocked work. Mission Replay stays paused.

