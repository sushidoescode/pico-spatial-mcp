# Final runner and artifact-contract fix

Date: 2026-08-14

## Scope and boundaries

- Assigned whole-branch findings: runner/watch-crash contract finding 1 and artifact failure-class
  finding 4.
- Starting programme revision when assigned: `ec51131b2eb374ba05095d0e1f6c6e0bfa5e9e7b`.
- An independent documentation correction advanced the shared branch to
  `3c067e04ed16193d930cdf5b1d730e3217ecf5ed` without touching this slice.
- Files owned by this slice: `src/picocli.ts`, `src/picoclitools.ts`, `src/perftrace.ts`,
  `test/helpers/picocli-managed-fixture.mjs`, and `test/picocli-autoinstall.mjs`.
- Fake/offline only. No registry/network request, real pico-cli invocation, setup, device, emulator,
  Swan, rendered-frame LOOK, or native Windows run occurred.

## Root cause

`runPicoCliCommandWithRuntime` created one command deadline before spawn. When a duration-bounded
command reached that deadline, process-tree cleanup ran first and post-completion managed-store
validation ran afterward against the already-expired command deadline. A clean intentional
`watch_crash` timeout therefore acquired a synthetic `spawnError`. The wrapper then treated every
`timedOut` result as a healthy duration cap and hid that error.

Separately, `capture_record` and `perf_trace` changed `status` to `failed` for some exit-zero
artifact failures without returning the shared wrapper contract's `failureClass`. `perf_trace`
also treated an existing zero-byte artifact as successful.

## Strict RED evidence

After adding behavior tests and rebuilding the unchanged production source:

```text
node --test --test-name-pattern='fresh bounded post-completion|Task 4 production adapters' test/picocli-autoinstall.mjs
```

failed on the intended branches:

- managed hanging command: `timedOut:true` plus
  `post-completion ... managed publication identity check exhausted its deadline`;
- public missing capture: `failureClass` absent;
- public empty capture: `failureClass` absent;
- public hang plus managed-content drift: incorrectly returned `status:"ok"` and
  `endedBy:"duration-cap ..."`.

The missing trace assertion was ordered after the missing-capture assertion, and the empty trace
assertion after empty capture, so those later assertions were then observed by the complete GREEN
gate. A separate RED for the explicit validation bound:

```text
node --test --test-name-pattern='separate post-completion validation deadline remains' test/picocli-autoinstall.mjs
```

failed because the callback received about 1,976 ms of the 2,000 ms command budget instead of the
requested independent 25 ms validation budget.

## Implementation

- The child command deadline still bounds child execution and starts the existing POSIX
  process-group or Windows fixture tree-cleanup state machine.
- Pre-spawn and post-spawn checks still share that command deadline.
- After ordinary process completion or completed timeout cleanup, `afterCompletion` receives a new
  cooperative deadline. Its production maximum is 15 seconds; an internal test/caller option may
  lower but never raise it. A synchronous guard still must cooperate because JavaScript cannot
  preempt synchronous filesystem work.
- Exhausting this separate guard is a `spawnError` but does not falsely change the meaning of
  `timedOut`, which remains the child command's duration result.
- `watch_crash` succeeds only for a clean duration cap (`timedOut && !spawnError`) or clean ordinary
  exit (`!timedOut && !spawnError && code === 0`). A managed-integrity/runner failure is public
  `status:"failed"`, `failureClass:"runtime"`, with the exact runner error.
- Exit-zero missing and empty capture/trace artifacts are public `runtime` failures. Trace
  record/decode now rejects zero-byte output as well as missing output.
- Independent review found the remaining `existsSync`/`statSync` check could throw on a replacement
  race and accept a directory. A further RED public fixture returned `status:"ok"` for directory
  outputs from capture, trace record, and trace decode. Both wrappers now use one shared,
  non-throwing stat inspection and require a non-empty regular file. Definite missing paths,
  zero-byte files, directories, and other stat failures all fail closed as `runtime`.
- Review also found the first tamper fixture could race the post-spawn guard. The final POSIX fixture
  mutates only when timeout cleanup delivers SIGTERM, deterministically after both launch guards
  and before post-completion validation. That public subtest is explicitly skipped on Windows,
  where forced `taskkill /t /f` does not cooperatively deliver the Node handler; Windows completion
  rejection remains covered only by the structural process-tree seam, not a native-host claim.

## GREEN evidence

```text
npm run build
npm run test:picocli
git diff --check
```

- Build passed.
- The post-review focused runner/public MCP selection completed: 14 tests passed, 0 failed,
  0 cancelled, 0 skipped.
- The complete final combined picocli gate then completed against the final diff: 136 tests passed,
  0 failed, 0 cancelled, 0 skipped.
- The gate includes the legacy pure-function lane, managed resolver and real-process fixture lane,
  public MCP wrapper calls, and fake help-surface sweep.
- Diff check passed.
- The direct hanging managed PID was absent after settlement; a post-gate process scan found no
  runtime-driver, fixture-hang, or picocli-autoinstall process.
- `/Users/sushantsrikrish/.pico-mcp/cli` was absent before and after the tests.

## Evidence limits

The Windows tree-kill state machine retains fixture coverage, including completion rejection, but
this fix was not run on a native Windows host. No semantic CLI, setup-gated utility, emulator,
device, Swan, or visual claim is made.

## Review

An independent read-only reviewer checked the current five-file diff, deadline/cleanup state
machine, wrapper precedence, public artifact behavior, fixture process cleanup, and platform
boundary. It reported two Important findings (the artifact stat race/directory acceptance and the
initial tamper ordering/platform race); both were resolved as described above. Final verdict:
no Critical, Important, or Minor findings; ready.
