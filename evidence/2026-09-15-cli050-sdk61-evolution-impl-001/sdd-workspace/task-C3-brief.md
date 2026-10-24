## C3: Correct watcher timing and retain observation coverage

**Files:** modify `src/picoclitools.ts`, `src/picocli.ts`; create `src/cliobservations.ts`, `test/cliobservations.mjs`; extend `test/picocli.mjs`.

**Interface:** add honest coverage fields without silently changing the meaning of an existing output. Deprecate misleading `watchedSec` if compatibility requires retaining it; set it only to observed duration with an explicit schema/documentation change.

```ts
export type ObservationCoverage = {
  requestedDurationSec: number;
  elapsedSec: number;
  monitoredSec: number | null;
  endedBy: "cli-exit" | "native-duration" | "watchdog" | "error";
  coverage: "complete" | "partial" | "unknown";
  outputComplete: boolean;
};
export function watchArgv(
  packageName: string, serial: string, durationSec: number, nativeTimeout: boolean,
): string[] {
  const args = ["app", "watch-crash", packageName, "-d", serial];
  if (nativeTimeout) args.push("--monitor-timeout", String(durationSec));
  return args;
}
```

- [ ] Add fake-child timing tests for requested 60 seconds with exit after 1 second, native timeout at 60 seconds, launch waiting without a process, a stuck child, nonzero exit and output truncation. Use an injected monotonic clock so tests do not sleep for minutes.
- [ ] Add an actual wrapper argv assertion:

```js
assert.deepEqual(watchArgv("com.example.fixture", "fixture-serial", 60, true),
  ["app", "watch-crash", "com.example.fixture", "-d", "fixture-serial", "--monitor-timeout", "60"]);
```

- [ ] Inspect native timeout semantics in the retained source: it includes waiting for the process and crash signals. Report `monitoredSec: null` if the CLI does not expose enough information; elapsed time is not necessarily monitoring time. The audit found an internal 30-second bound even in 0.4.4, so do not retain the claim that it streams indefinitely.
- [ ] Implement capability-selected native timeout plus an outer watchdog with documented grace. Preserve optional start/activity behavior; no implicit launch. Keep early exit as partial/unknown coverage even when the process exit code is zero.
- [ ] Retain bounded raw stdout/stderr, hashes and truncation state with the observation. Test a crash marker outside the returned UI tail; either assess the complete retained log or report incomplete assessment. Never translate quiet partial output to no-crash success.
- [ ] Build; run `npm run test:picocli` and `node --test test/cliobservations.mjs`. Add the new suite to the derived suite inventory through the release track. Commit this timing fix separately.

