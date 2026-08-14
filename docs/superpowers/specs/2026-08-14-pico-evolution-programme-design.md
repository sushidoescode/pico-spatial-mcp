# PICO MCP Evolution Programme Design

**Date:** 2026-08-14  
**Base:** `96c54a350816d5b1b3b4bf553b75ea6d1267db72` (`audit-remediation-2026-08-12`)  
**Status:** Approved direction; each feature still receives its own design and implementation plan  
**Repository constraint:** The repository remains private. This programme does not change visibility,
permissions, collaborators, remotes, or publish state.

## Purpose

Evolve pico-spatial-mcp along two connected product tracks:

1. keep its official `pico-cli` complement current without touching a user's global CLI; and
2. make long-running, evidence-bound agent workflows capable of exploring and authoring richer
   Spatial Editor worlds with Spatial SDK behavior.

The governing evidence rule remains unchanged: **verified means a human or vision-capable agent
looked at the exact rendered frame bound to the claim.** A build, CLI result, process check, scene
dump, receipt, or automated eye result is never silently promoted to `vision_verified`.

## Baseline

The programme branches from remediation commit `96c54a3`, not the older local `main` checkout.
Before this design was written, a clean linked worktree ran:

```text
npm ci
npm run build
SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs
```

The build passed. The battery completed all 45 invocations: 44 passed and `smoke` failed only on
the known environmental `scene_schemas` absence under the locally installed SDK. This establishes
a valid starting point but is not Windows, Swan, or new rendered-frame evidence.

## Programme topology

```text
Remediation baseline
├── Managed latest pico-cli (independent platform/tooling track)
└── Digest-bound native run receipt
    ├── Revisioned run/resume store ──> change-aware iteration
    └── Boundary-aware roam journey ──> Editor World Bridge v0
```

After the receipt interface stabilizes, the run/resume track and immersive-world track may proceed
independently. They must not edit the same files concurrently in one shared worktree.

Windows operational work is intentionally excluded. A separate chat and external tester own that
lane. This programme may keep cross-platform unit contracts green, but it must not change Windows
support claims, infer Windows paths, or claim a Windows emulator run.

## Subproject 1: Managed latest pico-cli

Replace ambient-`PATH`, opt-in global provisioning with an MCP-owned versioned CLI store. The
default is resilient latest-first: check the registry lazily before CLI-backed work, activate an
exact validated version without `-g`, and use the last validated managed version with an explicit
`freshness: "unknown"` warning if the registry is temporarily unavailable. Never run
`pico-cli setup` automatically.

Detailed design:
[2026-08-14-managed-pico-cli-design.md](2026-08-14-managed-pico-cli-design.md).

## Subproject 2: Digest-bound native run receipt v1

### Goal

Bind the final APK, successful install and live launch session, and captured pixels into one
content-addressed structural record. This is the identity primitive required by ship readiness,
safe caching, resume, and roaming.

### Contract

Create a producer-written receipt with a schema version and immutable ID derived from canonical
content. V1 records:

- normalized AppSpec/source digest;
- final APK SHA-256 and size;
- package name, version metadata, and signing identity when those values are actually inspected;
- successful build task and output metadata;
- successful install result;
- device serial and observed fingerprint;
- launched component, live PID, and foreground package at capture time;
- capture SHA-256, dimensions, and ledger CAS path.

The receipt is `structural`. A `vision_verified` ledger entry may reference it only after a LOOK at
the receipt-bound capture. Readers re-hash the APK, receipt, and capture. A changed/missing value
breaks the chain and ship readiness fails closed.

### V1 boundary

V1 covers native debug APKs produced through the fleet path. It does not claim release signing,
store readiness, web deployment, Swan hardware behavior, or visual correctness.

### Acceptance

- Replacing the APK, capture, package, serial, session, or receipt independently invalidates it.
- Failed build/install/launch, dead PID, non-foreground package, or missing capture cannot mint it.
- A receipt alone never increments a visual evidence bucket.
- `ship_checklist` accepts current native bytes only when a valid receipt and a receipt-linked,
  intact looked entry agree.

## Subproject 3: Revisioned run and resume store v1

### Goal

Make Door 1 and `pico_loop` resumable without resending a full AppSpec or trusting mutable process
memory.

### Contract

Store immutable revisions below `~/.pico-mcp/runs/<runId>/revisions/<n>.json`. Each revision records
its parent, normalized goal/spec/acceptance digests, compiler outcome, receipt references, iteration
outcome, and terminal state. Door results return `{runId, revision}`. Resume calls provide
`{runId, expectedRevision}`; stale writers, changed goals, and conflicting acceptance criteria fail
closed.

### Boundary

This resumes MCP workflow state. It does not restore an emulator snapshot, undo user source edits,
or roll back an installed application.

## Subproject 4: Change-aware iteration v1

### Goal

Use content identity to avoid repeating generation, Gradle, install, and fixed waits when inputs did
not change, without ever reusing stale runtime or visual proof.

### Contract

- Give compiler steps stable IDs and canonical input/output digests.
- Reuse a step only when its input digest matches and its current output re-hashes to the recorded
  output digest.
- Camera/acceptance-only changes may skip codegen and APK rebuild, but always obtain a fresh
  capture.
- Any APK-affecting change invalidates install, session, capture, and visual evidence.
- Replace blind fixed settling with bounded readiness and stable-frame polling.
- Report per-phase timings so optimization claims use measured latency.

### Boundary

This is invalidation and reuse, not new repair intelligence. Unsupported failure classes remain an
explicit manual-repair ceiling.

## Subproject 5: Boundary-aware roam journey v1

### Goal

Turn existing camera movement and capture primitives into a bounded, receipt-bound journey that can
reproduce Fabian's reported Mixed-versus-dynamic-Full behavior without calling it a safety-boundary
bypass.

### Contract

`pico_roam` accepts a named bounded route. Before and after every leg it checks that the expected
receipt-bound package and PID remain live and foreground, moves through the supported emulator
transport, waits for motion/frame stability, and writes each frame to a unique immutable capture.
It detects process death, focus loss, Home appearance when observable, unchanged frames, and
unsupported rotation routes. It returns a journey manifest plus explicit LOOK obligations; it does
not write `vision_verified` automatically.

### First runtime evaluation

Use one editor-authored world and one fixed start state. Run the same extended route under:

1. `DefaultStage` with manifest `stageStyle=1`; and
2. a dynamic `openStage(..., StageStyle.Full, ...)` route.

Look at the start/mid/end captures from both runs. Report only the exact emulator/SDK versions,
route, duration, and observed survival/failure. Hardware Guardian/Safeguard remains unverified.

### Boundary

V1 is relative emulator free-camera exploration. It is not metric localization, collision-safe
locomotion, headset movement, room-scale safety, or guaranteed boundless immersion.

## Subproject 6: Editor World Bridge v0

### Goal

Join the existing Spatial Editor/USD lane to the primary AppSpec/compiler/fleet lane without
inventing a complete replacement for USD or automating the Editor GUI.

### Contract

Add an optional `editorWorld` scene reference and optional packaged `editor-asset` module. V0 owns
one Editor project, one scene/bundle stem, one runtime root transform, and uniquely named bindings.
The compiler validates and builds the editor source, inspects and packages the cooked bundle,
generates a lifecycle-safe SDK loader, resolves the declared bindings, and attaches one existing
broadcast-driven interaction. Source, bundle, APK, session, and capture identities flow into the
run receipt.

### Demonstrator

Create a reopenable one-room museum with at least three unmistakable colored landmarks, one nested
transform, one editor component, and one obvious SDK-driven state change. Structural checks must
prove source/bundle/runtime identity. Receipt-bound capture A shows the authored world; an injected
interaction produces capture B. A human or vision-capable agent must LOOK at both before any visual
claim is recorded.

### Boundary

V0 does not promise a complete USD AST, arbitrary hierarchy mutation, shader/material graph
authoring, prefab/variant/LOD management, lossless editor round-tripping, GUI RPC, controller input,
audio playback, or hardware-scale immersion.

## Error and recovery policy

- Every persistent artifact is written through a unique staging path and atomic publication.
- A failed or interrupted producer never replaces the last valid state.
- Corrupt or unreadable state is reported as incomplete/unavailable; it is never silently skipped.
- Cached results always carry the digest and freshness boundary that makes reuse valid.
- External tools return their own bounded output tail and classified failure; causes are not guessed.
- No recovery path silently relaunches, downgrades a requirement, or upgrades an evidence class.

## Testing and evidence strategy

Each subproject gets its own design, test-first implementation plan, focused tests, documentation
gate, and commit. Unit and hermetic integration tests use injected runners and temporary roots.
Live emulator tests are separate and named as such. A visual acceptance test is incomplete until a
capture has been opened and judged.

Before any completion claim, run:

```text
npm run build
SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs
git diff --check
```

The expected local `scene_schemas` environmental failure is reported, not counted as a green smoke
suite. No Windows or Swan success may be inferred from macOS tests.

## Delivery policy

- Work in isolated branches/worktrees based on the last reviewed subproject commit.
- Do not resurrect the rejected workbench surface.
- Do not push or alter repository visibility/permissions.
- Commit messages state the exact tests and runtime evidence actually obtained.
- Keep external Windows feedback as a separately integrated evidence lane to avoid conflicting
  product edits or duplicated claims.

