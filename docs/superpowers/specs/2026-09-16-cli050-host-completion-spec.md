# CLI 0.5 / SDK 6.1 host-only completion pass — specification (2026-09-16)

Dispatch received after the 38.0.0 checkpoint (`docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md`,
branch `cli050-sdk61-evolution-2026-09-15` at `dfb3f2d`). The user's words, verbatim:

> Keep the branch and worktrees intact. Do not merge or push yet. Continue with a bounded host-only
> completion pass; do not stop at another integration menu.
>
> 1. Close fixture isolation gaps first. Empty, whitespace-only, or inherited real PICO_ADB values
>    must not enable hardware access in fixture gates. Allow fake executables through explicit
>    harness configuration. Route every injected door through its dependency seam and test that none
>    can unexpectedly spawn the real inner server. Establish isolation before running RED tests.
>
> 2. Make the required gates deterministic. Give test:claims a fixture ledger while preserving
>    tracked-snapshot consistency checks. Leave the real ledgers and public claims untouched. Fix the
>    revision-lock test's timing assumptions with controlled synchronization or an explicit test
>    deadline, without weakening production limits.
>
> 3. Restore artifact-preservation guarantees. Remove the replacing-rename fallback; fail closed where
>    atomic non-replacing publication is unavailable. Give canonical LOOK captures unique retained
>    paths. Preserving capture history does not require changing the default target at the same time.
>
> 4. Remove implicit global log clearing from observation paths, including assert_scene and
>    probe_planes. Use bounded, correlated observations and explicit target context. Preserve the
>    incident records; those hardware contacts were constraint violations, not acceptable RED-phase
>    exceptions.
>
> 5. Close the remaining host-side correctness gaps. Hidden-lock adoption must not override known
>    Node-version incompatibility or turn unknown provenance into verified installation identity.
>    Update check_toolchain_updates to use selected tools. Carry explicit device selection through the
>    perf door and wrappers. Preserve historical SDK references where they document provenance.
>
> 6. Rebuild, run targeted regressions, obtain an independent review, then run the final required
>    battery against the resulting source. Produce a fresh artifact and checkpoint, preserving previous
>    failures and tarballs. No "red by ruling" exception for a fixable fixture defect.
>
> Keep profiler provisioning, actual host discovery, cross-platform execution and native/visual
> acceptance separately tracked. Their absence must not block these host fixes. Do not begin emulator
> or physical-device work, require emulator sign-in, or resume Mission Replay.
>
> Preserve the committed evidence and logs. Return a merge-ready checkpoint with precise remaining
> acceptance limits.

The standing constraints from the 2026-09-15 dispatch remain binding (root alone owns emulator-5554;
never restart/move the emulator, kill unrelated processes, change Wing, push or rewrite history; no
emulator sign-in or Chrome credentials; no edits to rocketsim-mission-replay; preserve original
evidence bytes, explicit serial/APK/boot/process identity, typed results and the LOOK requirement; no
global logcat clear or foreign-app stop in ordinary verification; never claim end-to-end,
cross-platform, Mission Replay or full-app completion from help/fixtures).
