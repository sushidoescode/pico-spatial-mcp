# Task 7c report — Verify QEMU focus before host picker automation

## Scope

- Modified src/cameradrive.ts, test/observation.mjs, and test/homeenvironmenthost.mjs.
- Added a fresh NSWorkspace.shared.frontmostApplication PID readback after the existing
  PID-specific System Events focus request. frontmostQemu returns null only when the
  readback is one positive safe integer equal to the bound QEMU window-owner PID.
- A readback timeout, unsuccessful command, malformed/non-positive output, or differing PID
  returns a deterministic detail without echoing command output. Existing non-Darwin behavior
  and existing focus-request failure detail are unchanged.
- The real frontmostQemu result is tested in a child module with only the external run command
  seam mocked. The test includes matching PID, mismatching PID, malformed PID output,
  readback command failure, and existing focus-request failure. The host-state-machine test
  proves a returned focus-verification error reaches no openPicker or click action.
- No picker action, selector logic, dataset, evidence, metadata/count, version, benchmark,
  agentbench, device, or live host GUI state changed.

## TDD record

The behavior named before writing the regression was: a zero-exit focus request followed by
frontmost PID 416 must return
frontmost PID readback mismatch: expected 93013, observed 416; changing the production
function back to its old zero-exit-is-success branch makes this regression fail.

### RED

Before production edits, after adding the focused regressions, I ran:

    npm run build && node --test test/observation.mjs test/homeenvironmenthost.mjs

npm run build exited 0. The focused TAP run exited 1: tests 69, pass 68, fail 1.
The intended regression failed because the real frontmostQemu result was null, while the
hand-derived expected result was
frontmost PID readback mismatch: expected 93013, observed 416. No real GUI command ran: the
test replaces only the module's command-execution seam in its isolated child process.

### GREEN

I implemented the smallest guard: one swift -e AppKit frontmost-application PID readback
after the existing successful osascript request, strict positive-integer parsing, and exact
PID equality.

    npm run build && node --test test/observation.mjs test/homeenvironmenthost.mjs

Observed: build exit 0; TAP tests 69, pass 69, fail 0.

The owning package bridge command was also required by package adoption:

    npm run build && npm run test:bridge

Observed: both commands exit 0; bridge TAP tests 451, pass 451, fail 0, with the
mouse-bridge checks also reporting zero failures.

Final whitespace check:

    git diff --check

Observed: exit 0 with no diagnostics.

## Self-review

- null has one success path: an immediately preceding readback returns exactly the same
  positive safe-integer PID as binding.qemuWindowOwnerPid.
- A focus-request failure retains the prior osascript frontmost failed detail and performs no
  readback. The non-Darwin early return remains before every command.
- Readback diagnostics contain only fixed wording and an exit code or PIDs; they do not include
  stdout/stderr, preventing accidental command-output disclosure.
- The state-machine assertion uses its real guarded selection behavior and checks the observable
  action sequence ends at focus, rather than asserting on a mock implementation.
- Mutation review: removing the readback, accepting 0/text, accepting a mismatched PID, or
  continuing to openPicker each fails a focused assertion.

## Evidence ceiling

This is structural fail-closed evidence only. It proves the production guard rejects an
acknowledged focus request without an exact matching PID readback. It does not prove that QEMU
can become frontmost, expose select_scene_button, open or switch an environment, or classify a
post-switch mesh. No rendered frame was produced or inspected, and no vision/device verification
is claimed.

## Concerns

- The macOS AppKit readback is deliberately unexercised against the live host under this task's
  no-GUI-command restriction; later authorized host validation must establish its runtime
  availability and the QEMU frontmost transition.
- The isolated command mock uses Node's experimental module-mock flag internally so the normal
  owning suite can still run unchanged and no production command is issued during tests.
- pico_doctor {} was not exposed as a callable tool in this agent session, so it was not run
  and no substitute device/environment command was used.

## Fix round 1/5 — platform-scoped focus regressions

### Scope

Addressed only the Important portability finding from task-7c-review.md. The Darwin
command/readback regression now has a real process.platform Darwin skip condition. A second
regression is enabled only on actual non-Darwin hosts; it imports the real compiled
frontmostQemu, mocks only external command execution, and requires null with zero attempted
commands. process.platform is neither mutated nor faked.

The review Minors for additional PID/readback branch cases and exact command-vector assertions
are intentionally deferred as directed. No production source, live/device/GUI state, or evidence
was changed in this round.

### Verification

    npm run build && node --test test/observation.mjs test/homeenvironmenthost.mjs

Observed on this Darwin host: build exit 0; focused TAP tests 70, pass 69, fail 0, skipped 1.
The Darwin command/readback regression ran and passed; the actual non-Darwin early-return test
was skipped because this is not a non-Darwin runtime.

    npm run test:emulator-restart

Observed: exit 0; TAP tests 50, pass 49, fail 0, skipped 1. This includes the same
observation-suite platform shape used by the Ubuntu gate: the Darwin regression ran here and
the non-Darwin case was skipped.

    npm run test:bridge

Observed: exit 0; bridge TAP tests 451, pass 451, fail 0, skipped 0. Mouse-bridge checks also
reported zero failures.

    git diff --check

Observed: exit 0 with no diagnostics.

### Concerns

- The new non-Darwin regression can execute only in the Ubuntu/Windows gate; it was not forced
  locally because that would require faking or mutating process.platform, contrary to scope.
- The evidence ceiling remains structural. No rendered frame, live focus operation, emulator, or
  device validation occurred.
