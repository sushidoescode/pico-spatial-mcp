# PICO continuation package — 2026-09-16

This package prepares two fresh Claude Code sessions. It does not activate the MCP, provision tools, merge code, or build an app.

## Run order

1. **Chat A: MCP activation and native acceptance.** Paste [the activation prompt](CLAUDE_MCP_ACTIVATION_PROMPT.md). Its complete context and phased acceptance work are in [the activation handoff](MCP_ACTIVATION_HANDOFF.md).
2. **Chat B: reusable spatial UI polish.** After A establishes a usable local stack, paste [the polish prompt](CLAUDE_SPATIAL_POLISH_PROMPT.md). Read [the design](SPATIAL_POLISH_DESIGN.md) and [the implementation plan](SPATIAL_POLISH_PLAN.md).

B can do source research, design, host-only skill evaluation and component work while an external acceptance lane in A is blocked. Only one root agent/session may own device or emulator operations at a time. Do not run both native loops concurrently.

When pasted by the user, Chat A's prompt authorizes local integration of the accepted MCP continuation, reversible activation and demo-only device work. That changes the earlier instruction to preserve the MCP branch without merging. Chat B authorizes implementation, local commits, reversible activation and demo-only device work; its new polish branch stays unmerged pending a later instruction. Neither prompt authorizes pushing, changing unrelated applications, or resuming Mission Replay.

## Established starting point

- Main checkout: /Users/sushantsrikrish/PICO-MCP
- Main HEAD observed: 4478238a8d7aac266b12c2b8dc61c08482337286.
- Accepted branch: cli050-sdk61-evolution-2026-09-15.
- Accepted worktree: /Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15
- Accepted tip: f349eaf01f9788d0fe73fefbd30af17b7dccf776; clean at handoff preparation.
- Package version: 38.0.0. Host-only checkpoint accepted; runtime acceptance remains separate.
- Saved battery: 55/55 gates pass. Artifact receipt: 48/48 checks pass. These are prior results inspected during this review, not newly rerun tests.
- Current archive, relative to either checkout: evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/pico-spatial-mcp-38.0.0.tgz
- Archive SHA-256: ff394fbbcdf1828ea0745e3d7ad4fe931a2a46e7b910ea309f67c82c6858d042.
- Build input digest: bafeb2712c5b635d18a2a6a4523b41dc7a7eeee6e940bbe95c214822cd0628db.
- Build output digest: f4978b711f570efda70ef91f4a8c8157cadc231daab7ccc103909a36ee61c24d.
- The receipt's source/compiled file hashes and packed receipt were checked against the local tree. Both archive copies matched. Earlier archives and evidence were preserved.

Authoritative implementation record in the accepted worktree: docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md. The earlier CLI050_IMPLEMENTATION_CHECKPOINT.md is historical; its red claims gate and several gaps were subsequently resolved.

## Read-only observations during preparation

The connected MCP still resolves its skeleton in the main checkout. Its doctor reports cached CLI 0.4.4, without a registry freshness check; selected SDK tooling 6.1; packer 6.1.0.0-rls.25; emulator-5554 running; and calibration dated 2026-09-04 preceding the 2026-09-15 emulator boot. Accessibility was unknown. The old doctor's preflight SDK row still named 0.13 despite its separate toolchain row selecting 6.1.

These are observations of this connected server, not acceptance of the unpublished 38.0.0 candidate or proof of the latest registry version. Do not repeat old-path diagnoses against a different active server without checking its identity.

The user reports exclusive access to a physical PICO headset, called “Space Pro.” Its actual model, serial, runtime and capabilities have not been established by this preparation. Resolve them from the connected hardware before targeting it.

Mission Replay remains paused. Read-only inspection of its current governing documents found that build065's hold is historical/recovered; the later pause records build068, source 231dbce3, checkpoint ba2b3b4b710cea19c41e7ec708c01190f8c6201f. Re-read current documents if needed; do not reactivate old065 instructions or operate the app.

## Scope of the design recommendation

Build a repository-owned, versioned, opt-in polish skill, reusable native SpatialUI components, and a separate showcase app. Preserve the official PICO plugin as an upstream dependency. The first implementation targets PICO Spatial SDK apps; other frameworks need their own adapters and evidence.

Apple's material guidance informs hierarchy, restraint and accessibility. It is not an API portability promise. Public PICO 6.1.9 documentation confirms relevant material/design surfaces, but the executor must resolve the actual local Gradle artifacts and SDK declarations before writing code. A tool installation labeled 6.1 is not a BOM version decision.

## Preparation boundaries

Only these handoff documents were created. No implementation, test battery, host registration change, calibration, app install, or headset capture was performed in this preparation. The read-only doctor and filesystem/source review do not establish native acceptance. Files are saved locally; the executor should preserve them in its new checkpoint.
