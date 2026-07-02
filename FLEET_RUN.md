# Fleet Run — the ≥10-brief unattended factory (capstone acceptance)

The leap's acceptance test: *a queue of ≥10 briefs becomes a fleet the pipeline processes reproducibly, verified honestly at scale.* This run demonstrates it at **12 briefs**, with the trust model intact.

## The corpus (12 briefs, 6 new this run)
Original 6: `ambient · dashboard · gallery · inspection · narrative · showcase`.
New 6 exercising the v6.5–v7.5 capabilities: `museum` (real 3D models, PBR, gaze) · `crystals` (procedural gems, spin animation) · `worldtour` (custom textured-mesh world) · `boutique` (PBR image-textured cards) · `orrery` (models, orbit animation) · `atrium` (multi-scene lobby→hall). Each was validated (`plan_app_spec` → 0 errors) before entering the corpus.

## Result — the fleet dashboard (`run_factory`, headless)
```
queued: 12   readyToBuild: 12   blocked: 0   invalid: 0
totalCompileSteps: 115   emulatorVerifiableNodes: 26   builtForSwanNodes: 10
ciScore: 1.0
totalVisionVerifiedInLedger: 0   totalAutoJudgedInLedger: 0   (honest: ready-to-build ≠ built)
```
**Reproducible:** two consecutive runs produced byte-identical records (`sha dfb018c0a1f84c3f == dfb018c0a1f84c3f`). `regression_gate` golden re-saved for 12 briefs (score 1.0, 115 steps) and `mode=check` → PASS, no drift.

## Unattended verification at scale — the new capability (v7.4 off-device renderer)
The factory reaches `ready_to_build` headlessly (plan + compile). Turning each into a *running, verified* app used to cost one emulator build + one pair of eyes per brief. The **off-device USD renderer** breaks that: a brief's generated USD content is rendered + judged in **seconds, no emulator**.

Demonstrated on the `crystals` brief: composed its 6 procedural gems into a USD grid → `render_usd_offscreen` (off-device Storm, sub-second) → recorded `usd_host_render` → `visual_judge`. **The 3-tier honesty held at scale:** the automated eye measured 5 (two center crystals overlapped) and **ESCALATED rather than false-passing** (confidence 0.75 < 0.8); a human LOOK resolved it to 6. Off-device render → auto-judge (honest escalation) → human audit — exactly the calibrated-eye-with-human-audit loop, running without a device.

## Honest verification ledger (what's proven vs deferred)
- **Headless (all 12):** plan + compile + referential integrity + C-class split, reproducible.
- **Off-device composition (`usd_host_render`):** the generative content renders correctly off-device (a distinct evidence class — composition/geometry, NOT device appearance, never conflated with device vision).
- **Device vision-verified (this session, representative):** real 3D models (v6.5), PBR + per-item textures (v6.6), 6 procedural gems on-device (v7.0), custom world clean render + walkable immersion (v7.2/v7.5), quad animation (v7.3) — each a frame a human LOOKed at.
- **Deferred honestly:** a full 12/12 on-device vision pass (12 emulator builds) and the real PICO Swan flip. The machinery for both is built and proven on representatives; neither is claimed as done.

## The through-line
The fleet gets processed reproducibly, its generated content is verified unattended off-device in seconds, and every evidence class stays separate — `structural` / `auto_judged` / `usd_host_render` / `vision_verified` / `built_for_headset` — with a fleet metric never upgrading any node's class. Trust is a measured, automated property that scales, and it still never lies.
