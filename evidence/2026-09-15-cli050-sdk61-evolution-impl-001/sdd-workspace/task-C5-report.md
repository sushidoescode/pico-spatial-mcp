# Task C5 report — Single-flight doors with complete MCP result transport

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-cli-2026-09-15` (branch `track/cli050-cli`, base `9726a84`).
Status: **DONE** — two local commits, never pushed, tree clean.

| Commit | Subject | Files |
|---|---|---|
| `f401f21` | fix: initialize the inner doors server once and forward typed inner results | `src/innerclient.ts` (new), `src/doors.ts`, `test/innerclient.mjs` (new), `test/doors.mjs` |
| `558e19b` | test: record doors transport fixture measurements before and after C5 | `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/doors-transport/{README.md, measure-doors-transport.mjs, before.json, after.json}` |

The controller's example named two `fix:` commits (single-flight; typed forwarding). I made one implementation commit instead: `src/innerclient.ts` carries both the provider and the lanes, `doors.ts` imports them on one line, and the end-to-end fixture asserts both properties against the same cold server, so a split would have produced an intermediate `doors.ts` state (provider wired to the old text-only decoder) that I never built or tested. The evidence is its own commit.

## What was implemented

### `src/innerclient.ts` (new, 170 lines) — initialization ownership + result lanes

- `InnerClient` and `createSingleFlightClient(connect)` exactly as in the brief (the `pending ??= connect().catch(...)` snippet).
- `createInnerClientProvider(connect: (session) => Promise<InnerClient>)` — the generation-aware provider (controller resolution 1):
  - `acquire()`: one pending connect shared by every concurrent caller (one child); a failed first initialization rejects every waiter with the same error object and clears the slot so the next call reconnects; `generation()` / `current()` expose state for tests.
  - `retire(client)` / `session.retire()` / `close()`: retirement marks the generation and clears the provider slot **synchronously before any await**, then closes the underlying client. A close racing a new connect therefore never retires the new generation; a stale client cannot retire a newer one; retire is idempotent. A generation retired *while still connecting* is closed on arrival and its waiters are rejected with `inner client generation N was retired during initialization`.
- Lanes: `textOf`, `decodeDomainValue(name, result)`, `isInnerToolError`, `domainValueText`. The domain-lane error payload is `{status:"error", tool, error, structuredContent?, fix}` with a non-enumerable symbol marker (`INNER_TOOL_ERROR`) that never serializes and is dropped by object spread (a door that reshapes the payload owns its own status).

### `src/doors.ts` — wiring only (hunks local to `inner()`, the adapter, the two raw doors, `pico_emulator`'s seam, and the loop's two `detail` expressions)

- `connectInner(session)` replaces the old `inner()` body: same `childEnv` (`PICO_MCP_SURFACE=full`, `PICO_MCP_OUTER_SURFACE=doors`), same `StdioClientTransport` (the suite's static spawn-pin guard still matches), same bounded `callTool` timeout (`2_700_000` ms), stderr-only child, no stdout writes. `client.onclose` retires the generation through the session (child exit / broken pipe → the next door call reconnects instead of failing forever); the returned `close()` is a no-op once the transport already closed, so a retirement after a child exit does not wait on the SDK's 2 s grace timers.
- `inner()` = `provider.acquire()` + `lanesOf(...)` → `{ call, callRaw, close }`. `innerCall` (spatialbench) is unchanged in signature and stays on the domain lane.
- `registerDoorTools(server, dependencies?)`: `DoorToolDependencies` is now `{ call?, callRaw? }`. When `callRaw` is injected the domain lane is **derived from it with the production decoder** (so fixtures exercise real decoding); injecting only `call` keeps the existing receipt-test seam. `registerDoorTools.length` is still 2 (the suite checks it).
- Adapter: `door()` JSON-wraps the handler's value as before; if that value *is* an inner error payload (a forwarding door returned it whole) the envelope is additionally flagged `isError: true` (additive — the nested JSON shape is unchanged). New `forwardDoor()` returns the inner `CallToolResult` verbatim; only the door's own exceptions take the `{status:"error", error, fix}` shape (unchanged text).
- `pico_look` and `pico_verify_app` moved to `forwardDoor` + `doorCallRaw()`; `pico_emulator` obtains its lane through `doorCall()` (so the domain-lane fixture can inject). All other doors keep `const { call } = await inner();` untouched (incl. `pico_sdk` at S5's region and C4's perf axis).
- `pico_loop` structural/logcat `unmeasurable` details use `domainValueText(v)` so the tool's own words stay the detail (previously the isError *string*; now the payload's `error` text — same words). These two one-line edits sit immediately above C4's perf-axis hunk; see Concerns.

### Lane table (also in a code comment above `InnerLanes` in `doors.ts`)

| Lane | Doors | Behaviour |
|---|---|---|
| raw (`callRaw` → `CallToolResult`) | `pico_look` (capture_canonical), `pico_verify_app` (verify_pico_apk) | Inner result is the door's result verbatim: every content block (text/image/resource), `structuredContent`, `isError`. |
| domain (`call` → decoded value) | `pico_build_app`, `pico_scan_world`, `pico_place`, `pico_measure`, `pico_perf`, `pico_sdk`, `pico_doctor`, `pico_ship`, `pico_capabilities`, `pico_fix`, `pico_record`, `pico_emulator`, `pico_next`, `pico_loop`; `innerCall()` (spatialbench) | Successful results decode exactly as before (text blocks joined with `"\n"`, non-text blocks contribute an empty segment, `JSON.parse` else the string; `structuredContent` not merged). `isError` → `{status:"error", tool, error, structuredContent?, fix}`, never a success object; returned whole by a door ⇒ envelope `isError: true`. |

### Documented result migration (consumer-visible, deliberate)

1. `pico_look` / `pico_verify_app` on a **JSON** inner result: byte-identical text to before (the inner `okJson` 2-space text is forwarded rather than parsed and re-stringified), plus any `structuredContent`/image blocks the inner tool emits.
2. `pico_look` on an inner **error**: before `{"status":"ok","detail":"screencap failed…"}` (a laundering defect, measured in `before.json`); now the tool's own text with `isError: true`. `pico_verify_app` on an inner error: before a JSON-quoted string (`"\"…\""`) in a success envelope; now the text with `isError: true`.
3. Domain-lane doors that return an inner result whole (`pico_place`, `pico_measure`, `pico_perf`, `pico_sdk`, `pico_ship`, `pico_capabilities`, `pico_emulator`, `pico_record`, …): an inner `isError` is now `{status:"error", tool, error, structuredContent?, fix}` with envelope `isError: true`, instead of a bare string (or `{status:"ok", detail}` for `pico_emulator`). Doors that embed inner results in their own object (`pico_doctor`, `pico_fix`, `pico_next`, `pico_build_app`, `pico_scan_world`, `pico_loop`) keep their own status; the embedded field now holds the payload instead of a string.
4. Thrown door exceptions keep the exact previous shape and envelope (no `isError` added there — outside the defect, left untouched).

No tool was added, removed or renamed (18 doors-surface tools; tarball M6/M7 pass).

## TDD — RED then GREEN

Order followed: concurrency fixture RED → raw-result fixtures RED → implement.

**RED (base `dist/` built from untouched `src/` at 9726a84):**

```
$ node --test test/innerclient.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/innerclient.js' imported from …/test/innerclient.mjs
exit=1

$ npm run test:doors      (52 ok, 10 FAIL)
  FAIL pico_look dropped inner content: {"content":[{"type":"text","text":"{\n  \"status\": \"captured\", …
  FAIL pico_look laundered an inner error: …
  FAIL pico_look dropped a resource block: …
  FAIL pico_verify_app lost the structured failure: {"verify":{"content":[{"type":"text","text":"{\n  \"status\": \"attention\", \"installed\": false, \"launched\": false, …
  FAIL pico_emulator domain success drifted: {"content":[{"type":"text","text":"{\n  \"running\": true,\n  \"serial\": \"emulator-5554\", …
  FAIL pico_emulator laundered an inner error: …
  FAIL pico_emulator dropped structured failure content: …
  FAIL pico_emulator structured-success decoding drifted: …
  FAIL concurrent first use started 20 inner servers (statuses: unavailable)
  FAIL pico_look laundered or re-spawned: {"lookText":"{\n  \"status\": \"ok\",\n  \"detail\": \"screencap failed (code 1, 0 bytes). Is emulator-5554 running?\"\n}","innerStarts":20}
Doors test done. Failures: 10
```

The two end-to-end lines are the exact defects: **20 inner servers** for 20 concurrent first calls, and the screencap failure rewrapped as `status: "ok"`. Disclosure on the eight in-process lines: on the pre-C5 adapter `pico_look`, `pico_verify_app` and `pico_emulator` did not go through the injection seam at all (`const { call } = await inner()`), so the base run spawned a **real** inner server in the test process's real environment and those doors reached the real emulator read-only (`capture_canonical` screencap → overwrote the host scratch file `/tmp/pico-render/canonical.png`; `emulator_status` getprop; `verify_pico_apk` attempted an install of the nonexistent `/tmp/fixture.apk`, which failed without installing/launching anything). That is itself the missing-seam half of the defect, but to make sure a re-run against an old adapter never touches hardware, the committed fixture pins `PICO_ADB` to an `exit 1` stub for the block (with the new adapter the block spawns nothing). No emulator state was changed; the emulator was not restarted, moved or calibrated.

**GREEN (after `npm run build`):**

```
$ node --test test/innerclient.mjs        ℹ tests 15  ℹ pass 15  ℹ fail 0
$ npm run test:doors                      Doors test done. Failures: 0   (62 ok)
  ok   pico_look forwards an image block + structuredContent verbatim (raw lane)
  ok   pico_look forwards an inner isError text result as an error, not a success object
  ok   pico_look forwards an embedded resource block verbatim (raw lane)
  ok   pico_verify_app forwards a structured failure verbatim (isError + structuredContent) with its args intact
  ok   pico_emulator returns the decoded inner JSON object unchanged (domain lane success)
  ok   pico_emulator carries an inner isError as status:error with the tool's own words (domain lane), never {status:'ok', detail}
  ok   pico_emulator keeps a structured failure's structuredContent beside the inner error text
  ok   pico_emulator decodes a structured success from its text block (documented domain-lane semantics)
  ok   20 concurrent first door calls started exactly one inner server (all unavailable)
  ok   pico_look forwards the inner screencap failure as isError over the real inner transport
$ npm run test:prompts                    ℹ tests 3  ℹ pass 3  ℹ fail 0
$ npm run test:tarball                    Tarball verification done. Failures: 0  (registry access was available; M6 doors self-client + M7 default surface pass)
```

One intermediate run was red for a reason worth recording: my first pass changed `pico_look`'s handler body but left its registration on `door(` — the raw result came back JSON-wrapped (4 failures, all `pico_look`). Fixed by registering it through `forwardDoor(`; the background task's "exit 0" was the trailing `echo`, the log's `exit=1` was authoritative. One unit-test expectation was also wrong in my first draft (`"a\nb"`); the pre-C5 decoder yields `"a\n\nb"` for text/image/text and the implementation preserves that exactly, so the test was corrected, not the code.

Also corrected during review of the suite: `pgrep -fl '<worktree>/dist/index.js'` reported **0** lingering inner processes after every run (RED, GREEN, measurement); the doors suite log contains no stray non-protocol stdout lines.

### Tests added

- `test/innerclient.mjs` (new, `node --test`, injected fakes with explicit barriers, no process): 20-way single-flight for both the brief's snippet and the provider (one connect, identical identity, generation 1); failed-first-init rejects all 20 with the same error and the retry connects generation 2; old-generation close racing a new connect leaves generation 2 live; close during initialization never hands out the late client and closes it; session (transport)-driven retirement reconnects; retire idempotent / stale-safe; domain decoding of text success, structured success (text authoritative), text-only failure, structured failure, empty-text failure; `textOf` / `domainValueText`.
- `test/doors.mjs` additions (insertions only; the foreign-incumbent `verify_pico_apk` fixture is untouched — C6's): the in-process lane block through the real registered doors with an injected `callRaw` (image, resource, text-only failure, structured failure, domain success/failure/structured failure/structured success), and the **one real end-to-end case**: a cold doors server under the hermetic managed harness (`createManagedRuntimeHarness()`, fixture `HOME`/`PICO_HOME`, node proxy logging each `dist/index.js` lifetime, `PICO_ADB` exit-1 stub) receives 20 concurrent `pico_sdk` calls → exactly one inner child, then `pico_look` → `isError: true` with the inner text over the real transport; server and child closed in `finally`.

## Measurements (host-executed fixture measurements, not promises)

Evidence: `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/doors-transport/` in the cli worktree (`README.md`, `measure-doors-transport.mjs`, `before.json`, `after.json`), commit `558e19b`. Environment: darwin-arm64, Node v25.8.1, source `9726a84`; `before` = base `dist/`, `after` = C5 working tree `dist/` before commit (both records therefore say `commit 9726a84, dirty:true`; the README explains).

| Measure (fixed inputs) | before | after |
|---|---:|---:|
| `pico_sdk {symbol:"Entity"}` cold (first call, includes inner spawn) | 340.4 ms | 343.3 ms |
| `pico_sdk` warm, median of 10 (min–max) | 0.5 ms (0.3–0.7) | 0.5 ms (0.4–0.8) |
| `pico_sdk` response bytes | 816 | 816 |
| `pico_doctor {}` response bytes | 6788 | 6788 |
| `pico_look` (adb exit-1 stub) envelope `isError` / text `status` | false / `"ok"` | **true** / none (tool's own text) |
| inner children, 20 concurrent first calls | **20** | **1** |
| 20-call burst wall time (n = 1) | 734.3 ms | 296.2 ms |

Latency and bytes of unchanged doors are equal within run-to-run noise; the burst wall time fell because one child starts instead of twenty. No optimization target was set or met — the acceptance is the removal of the duplicate-initialization and lost-result defects. Limits: one machine, one run per record, fixture vault absent (`pico_sdk` → `unavailable`), `pico_look` measures the failure path only; nothing here is device/emulator or cross-platform evidence.

## Files changed

- `src/innerclient.ts` — new (provider + lanes).
- `src/doors.ts` — 1117 → ~1180 lines; hunks: imports, `InnerLanes`/`lanesOf`/`connectInner`/provider/`inner()`, `innerCall` doc, `DoorToolDependencies`/`registerDoorTools` adapter (+`forwardDoor`), `pico_look`, `pico_verify_app`, `pico_emulator` seam, two `pico_loop` `detail` lines.
- `test/innerclient.mjs` — new.
- `test/doors.mjs` — two inserted blocks (lane fixtures; cold end-to-end case).
- `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/doors-transport/*` — new.

Not touched: `package.json`, `.github/**`, `scripts/**`, `src/verifyapk.ts`, `src/capture.ts`, `src/picoclitools.ts`, any SDK-track file, policy docs.

## For the release track

- **CI registration**: `test/innerclient.mjs` runs with `node --test test/innerclient.mjs` and is registered nowhere. Adding it means a `test:innerclient` script in `package.json`, a `gates.yml` step, and bumping the gate-battery counts in `README.md` / `docs/COLLABORATORS.md` (`test/lint.mjs` and `test/distribution-adoption.mjs` assert script ↔ gates ↔ doc-count parity). Alternatively append it to an existing `node --test` script (e.g. `test:doors` → `node test/doors.mjs && node --test test/innerclient.mjs`) which changes no counts.
- **Tarball-level assertion worth adding** to `scripts/verify-tarball.mjs` M6 (release-owned, not edited here): after the existing `pico_sdk` round trip, (a) run `pico_look` with `PICO_ADB` pointed at an `exit 1` stub and assert `isError === true` from the *installed* artifact (cheap, no emulator); and/or (b) fire 20 concurrent `pico_sdk` calls at the installed doors server and assert one inner child — countable by reusing `createManagedRuntimeHarness()`'s node-proxy log (as the suite does) or via the transport's `pid` + a child-process listing on POSIX.
- Consider a CHANGELOG/README line for migration items 2–3 above (envelope `isError` on forwarded inner errors; raw text instead of `{status:"ok", detail}` from `pico_look`).

## Self-review

- Completeness: every brief checkbox — delayed fake connect ×20 (one connection, one child, identical identity), failed-first-init/retry, old-generation-close race; raw fixtures with `structuredContent`, text, image/resource blocks and `isError: true` asserting exact preservation in the raw lane and intentional decoding in the domain lane; pending connection + typed forwarding implemented with clean stdio and bounded timeouts unchanged and no nesting-shape change; cold/warm latency, bytes and child count measured before/after and committed. All five controller resolutions followed (generation provider; two lanes with the documented error payload; fakes + one real e2e; additive-only envelope; RED-first order).
- Quality: provider retirement is identity-keyed and synchronous, so the documented race is closed by construction and tested; the marker is out-of-band; the decoder's success path is byte-for-byte the old one (`textOf` + `JSON.parse`).
- Discipline: no new tools (tarball M6/M7 and the doors count test pass); result nesting unchanged, `isError` envelope flag additive and documented; no push, no history rewrite, no stash, no emulator/device operation by me (the base RED run's read-only contact through the old seam bypass is disclosed above).
- Testing: barrier-ordered races in `test/innerclient.mjs`; one real e2e case; suites close their servers in `finally`; 0 lingering `dist/index.js` processes after each run; no stray stdout.
- Verified claims: exactly one inner child under concurrent first use (suite + `after.json`); `isError` never becomes success (in-process and real-transport fixtures); image/resource blocks survive the raw lane byte-for-byte (JSON-equality of the content arrays including the base64 payload).

## Concerns

1. **Merge adjacency with C4**: the two `pico_loop` `detail` edits (structural/logcat `unmeasurable` branches, ~lines 1027–1045) sit directly above C4's perf-axis hunk. Git may report a textual conflict on merge; resolution is "keep both" (my lines end at the logcat branch, C4's start at `else if (c.kind === "perf")`). If the controller prefers zero adjacency, dropping those two edits costs only that the loop's `unmeasurable` detail would become the JSON of the error payload (`{"status":"error","tool":…,"error":"…"}` sliced to 300 chars) instead of the bare tool text.
2. **Behavioural change for hosts that render `isError`**: forwarded inner errors now surface as MCP errors at the envelope (with the same JSON text). That is the intended fix, but hosts that previously showed these as ordinary results will now show them as tool errors.
3. **`before.json` provenance**: recorded at `9726a84` with `dirty:true` (new test files present) — `src/` and `dist/` were base; stated in the README.
4. **Scratch side effect of the base RED run**: `/tmp/pico-render/canonical.png` (host scratch default output of `capture_canonical`) was overwritten by a real read-only screencap; no ledger/evidence artifact was touched.
5. `doors.ts` keeps growing (~1180 lines); the lane/provider logic now lives in `innerclient.ts`, but a future split of the loop door out of `doors.ts` would help C4/S5-style parallel edits.

## Fix round 1 (review items 1–3) — commit `12afdfd`

Commit `12afdfd` "fix: keep ledger detail text and never install a retired inner generation" on `track/cli050-cli` (never pushed; tree clean). Files: `src/doors.ts`, `src/innerclient.ts`, `test/doors.mjs`, `test/innerclient.mjs`. No other ledgered Minor item was touched; the evidence directory and measurement script are unchanged (see the note at the end).

### What changed

1. **Ledger detail text (`src/doors.ts`, pico_loop per-iteration ledger disclosure).** `NOT recorded: ${(typeof led === "string" ? led : JSON.stringify(led ?? null)).slice(0, 200)}` → `NOT recorded: ${domainValueText(led).slice(0, 200)}`, matching the structural and logcat branches. The `.catch` string (`record_verification threw: …`) and non-error objects (e.g. `{status:"rejected", reason}`) still print as before (string / JSON).
   Test: the receipt-fixture block in `test/doors.mjs` gained an `injectedLedgerFailure` switch; when set, the injected `record_verification` returns `decodeDomainValue("record_verification", {content:[{type:"text", text}], isError:true})` (the production decoder, imported from `dist/innerclient.js`). A one-iteration `pico_loop` then must report `iterationsLog[0].ledger` starting with `NOT recorded: <the tool's own text>` and containing no `"status":"error"` wrapper.
2. **Provider wedge (`src/innerclient.ts` `acquire()`).** `active = generation` is now `if (!generation.retired) active = generation;`, and the fulfilled branch that finds the generation retired clears `active` if it still points at it (`if (active === generation) active = null;`) before closing the late client and rejecting. A connect that calls `session.retire()` synchronously before its first await therefore never becomes the live generation; its waiters get the documented rejection and the next `acquire()` starts a fresh generation.
   Tests (`test/innerclient.mjs`): (a) a fake connect that retires its session synchronously then resolves — the first acquire rejects with `/retired during initialization/`, the late client is closed once, `current()` stays null, the next acquire invokes connect again (2 invocations), resolves to the new client, and 20 further concurrent acquires share it; (b) the same but the connect rejects after retiring — no wedged slot, next acquire reconnects.
3. **Hardened e2e adb stub (`test/doors.mjs`).** The stub is now `#!/bin/sh` + `printf '%s\n' "$*" >> '<harness root>/adb-invocations.log'` + `exit 1`. Immediately before `pico_look` the test asserts the stub is a regular file with the executable bit (`fs.accessSync(X_OK)` + `statSync().isFile()`), and **does not make the call** if that fails (eye.ts/capture.ts resolve `PICO_ADB` by existence first and would fall through to a real adb). After the call it asserts the marker exists and holds a line with `exec-out screencap` — proof the stub ran, not merely that `screencap failed` appeared.

### Commands and output

RED — against `dist/` built from `f401f21` (before the fix, after the new tests):

```
$ node --test test/innerclient.mjs
✖ provider: a connect that retires its session synchronously is never installed as the live generation; the next acquire reconnects
  AssertionError [ERR_ASSERTION]: the next acquire reconnects instead of returning the wedged rejection
  1 !== 2
ℹ tests 17  ℹ pass 16  ℹ fail 1
  (the reject-variant guard test already passed on the old code: the rejected branch cleared active)

$ npm run test:doors
  FAIL pico_loop ledger detail wraps or hides the tool's words: {"ledgerDetail":"NOT recorded: {\"status\":\"error\",\"tool\":\"record_verification\",\"error\":\"ledger root is read-only: EACCES /fixture/ledgers/com.example.fixture.json\",\"fix\":\"The full…
  ok   the e2e adb stub exists and is executable immediately before pico_look
Doors test done. Failures: 1
```

GREEN — after `npm run build` (tsc exit 0; `dist/innerclient.js` carries `if (!generation.retired) active = generation`, `dist/doors.js` carries `domainValueText(led)`):

```
$ node --test test/innerclient.mjs
✔ provider: a connect that retires its session synchronously is never installed as the live generation; the next acquire reconnects
✔ provider: a connect that retires its session synchronously and then fails leaves no wedged slot either
ℹ tests 17  ℹ pass 17  ℹ fail 0

$ npm run test:doors
  ok   pico_loop discloses a failed ledger lane with the tool's own words first
  ok   20 concurrent first door calls started exactly one inner server (all unavailable)
  ok   the e2e adb stub exists and is executable immediately before pico_look
  ok   pico_look forwards the inner screencap failure as isError over the real inner transport (stub adb ran: 1 invocation(s), screencap argv recorded)
Doors test done. Failures: 0   (64 ok)
```

`pgrep -fl '<worktree>/dist/index.js'` → 0 lingering inner processes after each run; no stray stdout in the suite log.

### Not re-done / disclosed

- Measurements were not re-taken: neither change touches a measured path (the ledger branch runs only inside pico_loop; the provider guard only alters a synchronous-retire path that `connectInner` cannot reach). `after.json`'s `pico_look` row already shows `code 1, 0 bytes`, which only the exit-1 stub produces (a real adb against the running emulator returns a PNG with code 0).
- The measurement script's own stub (`measure-doors-transport.mjs`) was not given the marker/pre-check hardening — not requested, and changing it after the fact would make the committed script differ from the one that produced the retained JSONs. Its stub is written immediately before spawning the server under the same harness root, so the missing-stub fall-through is not reachable in that flow; flagging in case the release track wants parity.
