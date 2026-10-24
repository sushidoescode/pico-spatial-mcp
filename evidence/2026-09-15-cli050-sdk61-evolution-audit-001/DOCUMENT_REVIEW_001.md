# Handoff document review

Review type: independent source/document review, followed by root self-review. No implementation or test-pass claim.

The release audit agent reviewed the master handoff, CLI plan, SDK/release subplans, fresh-chat prompt and static CLI audit. It identified five actionable planning gaps:

1. Declaration provider/compatibility-record validation had contradictory ownership between SDK and CLI tracks. The SDK track now owns byte-based declaration inspection and verified mapping-record loading; CLI provides root/workspace hints only.
2. Operation-capability records lacked an explicit selected-CLI identity. The master plan now defines a capability set bound to version, executable path, package JSON and execution-tree hashes, with stale-record tests.
3. Dependency installation could race despite a build-only lock. The release plan now owns one bounded dependency/build transaction, explicit same-owner reentrancy and concurrent-bootstrap fixtures.
4. Gate-runner migration omitted Windows tests asserting script bodies. Release Task 3 now migrates those assertions to exact inventory command arrays.
5. The perf task did not spell out the available source-derived argv. The master plan now includes the complete `live run` fixture with canonical package/duration and explicit save/output flags, retaining the runtime limitation.

Root self-review also added JDK absence/replacement cache coverage; a final consumer pass added trace load/query envelope handling and emulator-status consistency checks. The Windows observation script's global installation is explicitly identified and assigned an exact-path replacement before use.

The SDK/release owners revised only their plan documents. No production source, package version, host plugin configuration or paused app files were changed. Final file/link/hash checks are recorded separately in `AUDIT_VALIDATION_001.json`.
