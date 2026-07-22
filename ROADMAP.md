# Roadmap — where pico-spatial-mcp is going

*(Public, gate-labeled, and honest: every line is either ungated work we can do on the current
emulator, or explicitly labeled with the event that unblocks it. Nothing here is a promise of a
date; everything shipped gets a ledger entry before it gets a claim. Rejected-on-the-record
ideas are listed too — knowing what we won't do is part of the honesty contract.)*

## Just shipped (v27.x)

- **First Light**: the 15-minute stranger onboarding path, actually timed and fixed (three
  structural frictions found by running it cold); `preflight_env` read-only doctor with
  fix-pointing; docs rewritten for a PICO-internal audience.
- **Partner instrumentation**: the OS 6.1 bring-up playbook + `vault_diff` runbook, and the
  `device_verified` evidence protocol — written for machines that have what ours lacks.
- **Name-aware procedural provisioning**: data-bound briefs whose names match shape archetypes
  (gems, crystals, pins, bottles…) now get REAL baked faceted geometry instead of placeholder
  cards — vision-verified (`com.fleet.crystals`).

## Near-term (ungated — buildable on the current emulator)

- **Line-of-sight placement constraint**: occupancy solving today guarantees non-intersection;
  a visibility constraint (can the camera actually SEE the placed object?) is the next honest
  step for the free-space world model.
- **SpatialBench perf axis**: add frame-budget measurement (`measure_perf`) as an optional
  scored column in the public conformance harness.
- **Scaffold archetypes**: the two-step `pico_build_app` authoring flow should offer scaffold
  variants per brief archetype (display / game / data-panel), so a stranger's first authored
  spec steers toward the pipeline's proven strengths.
- **Unity lane, step 1**: the "hello XR" settling test described in
  [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md) — then a `unity_batch_build` tool wrapping the
  confirmed batchmode path, if the test justifies it.
- **17.0 tail**: semantic scan → `anchorTo` brief into a NEW splat world through the compile
  path (proving the world-model loop generalizes beyond the ramen scan).

## Partner-gated (needs PICO-side artifacts or hardware)

- **OS 6.1 emulator bring-up** — playbook ready ([docs/playbooks/os61-bringup.md](docs/playbooks/os61-bringup.md));
  blocked on artifact access from our side.
- **First 0.14/6.1 `vault_diff` drift report** — the multi-version vault tooling is shipped and
  waiting for a second real vault to exist locally.
- **First `device_verified` ledger entry** — protocol + evidence ask-list shipped
  ([docs/DEVICE_VERIFICATION.md](docs/DEVICE_VERIFICATION.md)); needs a real Swan run.
- **Immersive OpenXR re-test** (native, WebXR, and Unity-built) — the compositing question in
  [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md), re-run first thing on a 6.1 emulator or hardware.

## Blessing-gated (needs PICO's go-ahead; nothing goes public before it)

- npm publish + marketplace listing, versioned releases, semver + deprecation policy for tool
  schemas.
- The public verifiable-claims page generated from the ledger (capture hashes included).

## Rejected on the record

- **Unattended signed releases** — contradicts the honesty invariant that is this project's brand.
- **Silent auto-repair** — repair only ever happens as ledger-visible events.
- **Claiming immersive/hardware capabilities from the emulator** — deferral is honest; a silent
  over-claim is the one unforgivable failure.
