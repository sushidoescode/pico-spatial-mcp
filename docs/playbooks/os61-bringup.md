# OS 6.1 emulator bring-up playbook

## 0. Audience note

You have internal access to the PICO OS 6.1 emulator artifacts (`swan_spaceos` and whatever
`pico-cli setup` pulls down for it). We don't — our machines resolve the public internet only,
and the 6.1 distribution lives behind your internal update channel. That's the whole reason this
is a playbook and not something we ran ourselves: it's written for you to execute on your
machine, with your access, against your internal update channel — not for us to run against
yours.

What we bring instead: a verification harness that's already proven itself across five SDK
versions on 6.0 — camera calibration, a fleet of self-building/self-judging briefs, a trust
ledger that only calls something `vision_verified` when a human or agent actually looked at a
rendered frame, and a vault-diff engine built and CI-tested specifically for the day a second SDK
version shows up. None of that cares whether the emulator underneath it is 6.0 or 6.1 — it cares
whether the numbers it produces are honest. Run the steps below in order, and send back what
Section 6 asks for. That's the payoff: we get a real drift report without ever touching your
internal artifacts.

Every tool named below is a real registered MCP tool in this repo (`src/*.ts`, `registerXTools`)
— not a wrapper we're inventing for this doc. If a tool call errors with "not found," you're
likely on a stale build; run `npm run build` (or `npm run smoke` to confirm the registered tool
count) before assuming the playbook is wrong.

## 1. Before touching anything: snapshot the working 6.0 emulator

**Do this before you install or stage anything 6.1-related.** The running 6.0 emulator is the
verification substrate for this entire repo — every calibration, every ledger entry, every
`vision_verified` capture on file was produced against it. Losing it is losing the lab: not "we
lose one data point," but "every honesty claim this repo has made becomes unreproducible until
we rebuild the whole rig from scratch."

```
snapshot_save { name: "pre-6.1-baseline" }
```

- Note the AVD directory it snapshots (`$ANDROID_AVD_HOME`, typically
  `~/.android/avd/<name>.avd`) somewhere durable — you will want to know exactly which directory
  to restore if 6.1 staging goes sideways.
- Confirm the snapshot took: `snapshot_list` should show `pre-6.1-baseline` before you proceed.
- If you can, back up the whole AVD directory out-of-band too (snapshot_save captures VM state
  inside the AVD; a copy of the directory itself survives even AVD-level corruption that the
  snapshot mechanism can't).
- To get back to a known-good 6.0 state at any point: `snapshot_load { name: "pre-6.1-baseline" }`.

Do not skip this because "6.1 is probably fine." The whole point of this playbook is that we
don't know that yet, and neither do you until you've re-run the checks in Sections 3–4.

## 2. Install / stage the 6.1 emulator (swan_spaceos)

Use your internal `pico-cli setup` / update-channel flow to materialize the 6.1 emulator
(`swan_spaceos`) the same way you'd stage any SDK update. We're not going to guess at your
internal command syntax here — you know it, we don't.

Expect breakage in at least three places, because every one of these has changed across SDK
minor versions before on this rig:

- **Launch recipe.** The exact `emulator -avd ...` invocation, cold-boot timing, and whatever
  `adb wait-for-device` sequencing currently works for 6.0 may not carry over unchanged.
- **Capture rig.** The deterministic forward-capture pipeline this repo's calibration and
  `fleet_build` judging depend on assumes a particular free-cam default pose and screen
  resolution. Both have drifted before on a plain 6.0 cold restart (see the gotcha under
  Section 3) — a full SDK minor bump is a strictly bigger perturbation.
- **gRPC discovery.** Anything that talks to the emulator over gRPC (device/toolchain discovery)
  may enumerate differently — different port, different service name, different startup latency
  before the socket is live.

**After every single change** — installing the 6.1 emulator, changing the launch recipe,
anything — run:

```
pico_doctor {}
```

`pico_doctor` is read-only: it runs `validate_toolchain`, `emulator_status`, `preflight_env`
(node/adb/emulator/AVD state/gRPC reachability/macOS Accessibility/disk headroom, every failing
check paired with an exact fix), and reports current camera-calibration freshness in one shot.
Treat every non-`pass` line as something to fix before moving to the next step, not something to
note and continue past — a `pico_doctor` run that looks "mostly fine" with one gRPC failure will
make every later step in this playbook silently produce garbage.

## 3. After ANY emulator change: recalibrate, then re-baseline

This step is not optional and not a one-time thing — repeat it after every emulator-affecting
change you make during 6.1 bring-up, not just once at the end. The load-bearing gotcha already on
record for this repo: camera calibration **dies on a plain emulator cold restart** on 6.0 — the
free-cam default pose shifted the vertical principal point by 299px across one restart, which
silently corrupts every meters-at-depth figure downstream until you recalibrate. A full SDK
version swap should be assumed to invalidate calibration at least that badly, probably worse.

Sequence:

1. Build the calibration brief fresh (don't reuse an old capture):

   ```
   fleet_build { briefIds: ["calib"] }
   ```

2. Feed the resulting capture into the solver:

   ```
   calibrate_capture_camera {
     capturePath: <path from the calib build>,
     markers: [ ...at least 3 color-keyed markers with known app-space positions... ]
   }
   ```

   Check the reported per-marker residuals. On 6.0 a healthy calibration lands around 13–14px
   residual; a much larger number means something about the capture geometry (resolution, FOV,
   default pose) actually changed under 6.1, not just the usual restart drift — investigate
   before trusting anything measured afterward.

3. Re-run the Swan bring-up checklist to re-baseline headset-only feature expectations. This
   tool needs the headset-feature manifest, which comes from
   `generate_headset_readiness_codegen` (already wired into any spatial-app-onboarding project):

   ```
   swan_bring_up_checklist {
     appName: "<your test app>",
     features: [ ...the headsetFeatureManifest entries from generate_headset_readiness_codegen... ]
   }
   ```

   It emits a keyed markdown checklist: for each headset-only feature (C1 sense/plane pins, C1
   WorldAnchor persistence, C3 controller-ray, C4 in-front panels), the exact re-test. Treat 6.1
   emulator bring-up as a trigger to re-walk this list even though it's nominally written for
   real-hardware day-one — anything that changed emulator-side capture/gRPC behavior is exactly
   the kind of thing that also changes what "no-ops safely on the emulator" still means.

4. Re-run one fleet core brief to re-baseline against a known-content target:

   ```
   fleet_build { briefIds: ["crystals"] }
   ```

   `crystals` is a small, self-contained core brief already in `briefs/` — use it as the
   canary. Compare the resulting `auto_judged` verdict and artifact capture against the existing
   6.0-era capture for the same brief (`~/.pico-mcp/artifacts/fleet-crystals-*.png` if you have
   one on your machine, or ask us for the reference we have on file). A verdict flip or a
   visibly different frame is the first real signal that 6.1 changed rendering, not just
   plumbing.

## 4. `vault_diff` runbook — the moment a 6.1/0.14 agent-vault materializes

The v26 multi-version vault tooling is already built and CI-tested for exactly this moment; only
a 0.13 vault exists on our machines, so it's never been run against a real second version. This
is the first real workout it gets.

The instant your `pico-cli setup` run for 6.1 materializes an agent-vault under
`~/Library/PICO/sdk/<version>/agent-vault` (expected version string something like `0.14` — use
whatever your `pico-cli setup` output actually reports):

1. Confirm both versions are visible:

   ```
   vault_workspaces {}
   ```

   Expect two entries now instead of one — the existing 0.13 workspace plus the new one. If you
   only see one, `pico-cli setup` didn't materialize the vault where this tooling expects it
   (`~/Library/PICO/sdk/<version>/agent-vault`); check its output/logs before going further.

2. Spot-check a handful of symbols you already know changed or suspect changed, per version:

   ```
   vault_api { symbol: "RigidBodyComponent", sdkVersion: "0.13" }
   vault_api { symbol: "RigidBodyComponent", sdkVersion: "0.14" }
   ```

   (Substitute the real 6.1 version string and whatever symbols you have reason to check —
   anything you know moved, renamed, or changed arity in the 6.1 release notes is a good
   candidate.)

3. Run the full drift report:

   ```
   vault_diff { from: "0.13", to: "0.14" }
   ```

   This diffs every type across both vaults — types added/removed, members added/removed,
   constructor-arity changes, enum-entry drift, kind changes — and pairs each breaking change
   with a concrete migration hint. It's conservative by design: renames are only ever flagged as
   "likely" when exactly one member was removed and one was added on the same type, never
   guessed from name similarity alone. Send us the full JSON output, not a summary — see
   Section 6.

## 5. If 6.1 unlocks full-immersive OpenXR compositing on the emulator, that's the headline test

On file today: full-immersive OpenXR compositing is Swan-hardware-only on 6.0 — proven three
separate ways, with 2D activities instead composited as floating spatial panels (docked, off the
forward capture view). If 6.1 changes that story on the emulator — even partially — that is the
single most consequential finding this bring-up can produce, more consequential than any vault
diff.

If you observe full-immersive compositing working on the 6.1 emulator:

- Re-run the boundless/immersive matrix (the same brief set that established the current
  Swan-only finding) against 6.1.
- Upgrade evidence classes **only where the new behavior is honestly, directly observed** —
  a capture that shows immersive compositing working is grounds for `vision_verified` on that
  specific claim; do not upgrade adjacent or inferred claims on the strength of one positive
  observation. The ledger's honesty invariant holds here exactly as everywhere else in this repo.
- Send us the capture either way (positive or still-Swan-only) — a confirmed "still emulator-only
  panels, nothing changed" result is just as valuable as a positive one, because it tells us
  whether to keep planning around the Swan-only constraint.

## 6. What to send back

This is the payoff of the whole exercise — everything above exists to produce these artifacts:

1. **The full `vault_diff` JSON** from Section 4, unedited (not a summary — we want the raw
   `typesAdded` / `typesRemoved` / `typesChanged` / `migrationHints` arrays to feed back into
   this repo's own migration tooling).
2. **`pico_doctor` output from before and after** — run it once right after Section 1 (pre-6.1,
   confirming the 6.0 baseline was healthy going in) and again after Section 3 completes
   (post-6.1, post-recalibration). We want the diff between the two, not just the final state.
3. **Any capture that changed** — the `crystals` re-baseline capture from Section 3, the
   immersive-matrix captures from Section 5 if you ran them, and anything else you looked at and
   noticed looked different from the 6.0-era equivalent. Include the file, not just a
   description — this repo's whole verification model is "a human or agent looked at a rendered
   frame," and we want to be able to do that ourselves on the receiving end.
4. **The `crystals` fleet-core-brief re-baseline result** specifically — the `auto_judged`
   verdict plus artifact path from step 4 of Section 3. This is the one canary result we most
   want as a single yes/no: did a known-content brief render and judge the same way under 6.1 as
   it did under 6.0?

Package all four as plainly as you can (a directory with the JSON/PNGs/text output is fine — no
need to write prose around it) and get it back to us. We'll fold the drift report into
`spatial-sdk-update` guidance and the capture comparisons into the trust ledger on our side.
