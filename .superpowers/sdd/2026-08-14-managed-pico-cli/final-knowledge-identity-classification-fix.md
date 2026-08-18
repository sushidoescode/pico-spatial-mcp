# Final-review Knowledge lifecycle identity and failure-classification remediation

Date: 2026-08-14

## Scope and evidence boundary

- Starting shared revision for this slice: `ec51131`; the runner and proof-boundary sibling commits
  landed before this slice was finalized, so its eventual parent is later.
- Owned production file: `src/knowledge.ts`.
- Owned test file: `test/knowledge-lifecycle.mjs`.
- Every test used fake local MCP servers, injected process tables/signals, temporary homes and the
  managed-runtime fixture. The real `~/.pico-mcp/cli` sentinel was absent around the recorded gates.
- No network/registry request, real npm install, real/global pico-cli, `pico-cli setup`, emulator,
  device, Swan hardware, rendered-frame LOOK, remote, visibility or permission mutation occurred.
  Native Windows execution was unavailable; Windows evidence in this slice is structural simulation
  only.

## RED evidence

Before production changes, focused lifecycle mutations reproduced these defects:

- an unproved retirement restarted a second generation instead of blocking replacement;
- root and remembered-descendant PID-reuse mutations never reached an identity-aware signal seam;
- unavailable and simulated-Windows process identity still allowed replacement;
- managed startup drift, startup timeout, call timeout and protocol failure returned managed
  provenance but dropped the derived `failureClass`;
- a synchronous process-table snapshot blocked startup stderr drainage and changed a measured
  setup refusal into `write EPIPE`/`runtime`; this rejected the synchronous design and led to the
  async bounded implementation;
- the SDK's delayed `close()` fallback delivered an unchecked `SIGTERM` after both explicit close
  and initialization failure;
- same-second remembered-descendant PID reuse was signalled when its generation token was absent;
- a managed path/version transition spawned generation two after generation-one retirement had
  already set the lifecycle block;
- a capture-time reused root row was accepted when the exact-child seam reported that the spawned
  child had exited;
- an injected process-table promise that never settled made retirement unbounded.

Each named mutation failed before its corresponding implementation change and passed afterward.

## Implementation

- POSIX process snapshots are asynchronous, time/output bounded, parsed fail-closed, and pin locale
  plus timezone (`C`, `UTC0`) so the OS start-time string is stable. Every read, including injected
  providers, is bounded by 250 ms and the shared lifecycle deadline.
- The root PID is bound to both its OS start time and the exact SDK `ChildProcess` handle while that
  handle is live. Capture, discovery and every signal recheck the handle. A live-handle/process-row
  conflict, missing handle proof or unavailable table blocks retirement and replacement.
- Descendants retain their captured start identity, but a start-time match alone is never signal
  authority: every descendant signal requires the exact 192-bit generation environment token in a
  fresh process-table read. Missing token means no signal and a blocked replacement.
- Every TERM/KILL is a single positive PID routed through the injected seam only after fresh proof;
  group signals and native-Windows numeric kills are absent. A process that disappeared or whose
  start identity changed is not signalled.
- The transport overrides SDK-internal close so error/overflow paths may end only the exact open
  stdin pipe. The SDK's numeric child handle is released only after the birth-bound process set is
  proven empty, preventing its delayed unchecked TERM/KILL fallback.
- Unconfirmed retirement sets a persistent lifecycle warning/block. `ensureStarted` rechecks the
  block after awaiting any retirement and immediately before transport construction, preventing
  path/version transitions from overlapping generations.
- Managed thrown failures now always retain the derived `failureClass`; startup/request/call
  timeouts map explicitly to `timeout`, while measured CLI usage drift and protocol/runtime failure
  retain their respective classifications and managed provenance.

## Verification record

Fresh final-tree verification before commit:

- `npm run build` — exit 0;
- `npm run test:knowledge-lifecycle` — 18/18 passed;
- `npm run test:distribution-adoption` — 43/43 passed;
- `npm run test:picocli` — legacy lane failures 0; managed/sweep Node tests 136/136 passed;
- `node --check test/knowledge-lifecycle.mjs` — exit 0;
- `git diff --check -- src/knowledge.ts test/knowledge-lifecycle.mjs` — exit 0.

## Honest residual limits

- Native Windows was not run. It deliberately sends no numeric lifecycle signals and blocks
  replacement because a native birth-identity provider is not implemented.
- The macOS production path was exercised structurally and through real local fixture processes;
  no Linux host was available for a native `/bin/ps` run in this slice.
- POSIX signal delivery necessarily has a small check-to-signal scheduling window. Root handle
  liveness and descendant generation-token revalidation materially narrow PID-reuse exposure, but
  this work does not claim an atomic kernel pidfd-style signal primitive on macOS.
- No emulator, device, Swan-hardware or visual claim is made.
