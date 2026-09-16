# Task C2 report — Use the canonical knowledge server without losing lifecycle safety

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-cli-2026-09-15` (branch `track/cli050-cli`, base `c977ef0` = C1 complete).
Status: **DONE**. Two commits, never pushed. No emulator, no MCP tool, no real `pico-cli`, no install/setup: every child in every test is a fake process or a retained-byte replay.

## Commits

| SHA | Subject | Files |
| --- | --- | --- |
| `91022f0` | `fix: start the canonical pico-cli knowledge server from capability evidence` | `src/knowledge.ts`, `src/clicapabilities.ts`, `src/picoclihealth.ts`, `test/helpers/picocli-managed-fixture.mjs`, `test/knowledge-lifecycle.mjs`, `test/picocli-autoinstall.mjs` |
| `f743b0b` | `fix: report the knowledge server's own no-graph answer as a data gap` | `src/knowledge.ts`, `test/fixtures/fake-knowledge-server.mjs`, `test/knowledge-lifecycle.mjs` |

Both messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. The split is the one the dispatch allowed: commit 1 is transport selection, commit 2 is the graph-API reconciliation. Commit 1 was built and its suites run **in that reduced state** before committing (24/24 knowledge-lifecycle, 157/157 picocli), so the intermediate commit is not a broken tree.

Nothing outside the ownership list was touched: `package.json`, `.gitignore`, `.github/**`, `scripts/**`, `test/distribution-adoption.mjs`, `test/preflight.mjs`, every doc, and the C3/C4-owned sources are byte-identical to `c977ef0`.

## What was implemented

### 1. Managed transport argv now comes from capability evidence (`src/knowledge.ts`)

- `KnowledgeBridge.resolveManagedTransport(configuredArgv)` is the single place that decides what to spawn. It calls `ensurePicoCli()`, binds the target with `picoCliFromEnsure`, and asks `picoCliOperationCapability(target, "knowledge-server")`. A child is started **only** when the capability is `supported`, has a non-empty `argvPrefix`, and its whole recorded identity still matches the target being dispatched — `picoCliOperationCapability` re-derives the managed identity from the opaque handle and re-verifies the retained help bytes on every call, so drift surfaces as `stale-identity` rather than as a dispatch.
- `unknown` **with no usable evidence bound to the target** (`no-discovery:`, `stale-identity:`, `evidence-missing:`, `evidence-mismatch:`, `report-inconsistent:`) triggers exactly **one** bounded rediscovery through the C1 path (`ensurePicoCli({forceRefresh:true})`) and is then re-resolved. This is the lazy-first-real-use case: starting the knowledge child *is* a real CLI-backed operation. A classified `unknown` (`timed-out:`, `malformed-help:`, `output-truncated:`, `incomplete:`, `bounded:`, unproven `generic-parent-help:`) **is** evidence and is never re-probed — otherwise one bounded discovery would become an unbounded retry loop on every call. The predicate lives with the capability facts: `capabilityNeedsFreshDiscovery(reason)` in `src/clicapabilities.ts`.
- Anything else returns a structured refusal: `status:"unavailable"`, a `knowledge transport unavailable: …` note naming the resolved version and absolute path, the exact `picoCli` provenance, an honest `failureClass` (`utilities-not-installed:` → `setup-required` + `setupCommand`; `environment:` → `environment`; `unknown-command:` → `flag-or-version-drift`; everything else → `cli-unusable`), and a new `transport` field carrying `{operation, state, reason (verbatim), argvPrefix, evidence[]}` where `evidence` is the absolute paths of the retained bounded-help stdout/stderr bytes behind the decision. **No spawn, no alias retry.**
- Explicitly configured `command` and/or `args` bypass capability selection entirely and are spawned exactly as given (`configuredArgs` flag). A caller that passes `args` without `command` keeps its previous behaviour too (managed resolution + its own argv), which is why the bypass keys off `options.args !== undefined` rather than off `command` alone.
- `DEFAULT_KNOWLEDGE_ARGS` keeps its value and its export, but is now *read from* the 0.4.x route table (`cliOperationRoutes("0.4.4")`), so the argv literal exists in exactly one place (controller resolution 3). Grep confirms: the only `["mcp","dev-knowledge"]` in `src/` is the 0.4.x route-table entry; `src/knowledge.ts` mentions it only in prose.
- The spawned argv joined the session identity (`commandArgs` on `KnowledgeSession`, compared in `sameIdentity`), so a route change retires the old generation exactly the way a path/version change already did. Every other lifecycle path (EOF close, birth-identity capture, generation token, POSIX scans, signal validation, retirement blocking) is untouched.
- `describePicoCliEnvironmentFailure` is now wired (the second zero-call-site C1 helper the dispatch assigned to C2): a knowledge child that fails at the CLI's environment gate returns the exact PICO_HOME remedy as `error`, `failureClass:"environment"`, raw stderr in `outputTail`, and — verified by assertion — never prescribes `pico-cli setup`. The capability-refusal note appends the same guidance when the *probe* hit that gate.

### 2. Graph-API reconciliation against the published declarations (`src/knowledge.ts`, fixture)

See "Graph-API differences" below. Runtime effect: an `isError` tool answer matching the published degraded-server sentence becomes a distinct `unavailable` result carrying `knowledgeData {available:false, reason, remediation, source}`; `Graph file not found:` and ordinary remote errors keep their exact previous shapes (both are `deepEqual`-pinned by `test/distribution-adoption.mjs`, which I cannot edit — verified still passing).

### 3. `ensure_pico_cli` description (`src/picoclihealth.ts`)

Routed C1-review minor: the description now discloses that the tool also runs bounded per-operation capability discovery (≤ 8 `<route> --help` probes, time- and output-capped, retained under the managed store and returned as `capabilities`).

### 4. Test infrastructure (additive)

- `test/helpers/picocli-managed-fixture.mjs`: `createManagedRuntimeHarness({helpMap})` writes the map and sets `FAKE_PICO_HELP_MAP`; the runtime driver accepts inline `stdout`/`stderr` strings beside the existing `stdoutFile`/`stderrFile`/`code`/`hang`; it serves **both** knowledge routes; and its generic `--help` fallback now renders a usage line naming the probed route. That last change is load-bearing: the old `fixture help: …` reply has no usage section, so after C2 every managed runtime-harness test would classify `knowledge-server` as `unknown` and refuse. The fallback is fixture text, never real CLI bytes, and the `createHarness` fallback (whose `malformed-help` classification `test/picocli-autoinstall.mjs` asserts) is deliberately unchanged.
- `test/fixtures/fake-knowledge-server.mjs`: `FAKE_KNOWLEDGE_DECLARED_SHAPE=cli-degraded-stub` runs the published degraded server's raw JSON-RPC protocol, transcribed from the shipped bytes (`initialize` result, the single `[Unavailable] graph_stats` declaration with `{type:"object",properties:{}}`, the `isError` call answer, the empty-result default), with `FAKE_KNOWLEDGE_STUB_REASON` / `_PROJECT` supplying the version-specific parts. Every other branch of the fixture is unchanged.

## Graph-API differences found, and how they are mapped

Method: the official tarballs `picoxr-pico-cli-0.4.4.tgz` (sha256 `0eabffe9…0ba9524`) and `picoxr-pico-cli-0.5.0.tgz` (sha256 `a2afe604…6ac68642`) in `evidence/2026-09-15-cli050-sdk61-evolution-audit-001/` were read **in memory** (Python `tarfile`, no extraction, nothing executed).

| # | Finding | Evidence label | How it is handled |
| --- | --- | --- | --- |
| 1 | The CLI implements **no** graph tools. `knowledge server` (0.5.0 `K050` → `serveGraphify` in `package/dist/graphifyServer-RAVORAOO.js` → `package/dist/chunk-BLCMTNZL.js`) and `mcp dev-knowledge` (0.4.4 `K044` → `package/dist/index.js`) resolve a `graph.json` + workspace and then `spawn(graphify, ["serve","--graph",<graph.json>,"--workspace",<dir>], {stdio:"inherit"})`. The provisioned `query_graph` / `switch_workspace` / `graph_stats` declarations live in that external Python binary. | **source-inspected** (tarball members read in memory) | Nothing claims compatibility. A transport start is never reported as API compatibility or as matched SDK declarations, and no `tools/list` result is promoted to declaration authority. Our eight zod input shapes are therefore *unreconciled against the published package* — stated here, not asserted anywhere in code. |
| 2 | The only knowledge-server tool declaration in the shipped bytes is the **degraded mode**: when no graph/workspace resolves, both lines serve a raw stdio JSON-RPC responder — `initialize` → `{protocolVersion:"2024-11-05", capabilities:{tools:{listChanged:false}}, serverInfo:{name:"pico-dev-knowledge", version:"0.0.0"}}`; `tools/list` → exactly one tool `graph_stats`, description `"[Unavailable] Knowledge graph not configured (<reason>). Run \`pico-cli setup --project <cwd>\` to initialize."`, `inputSchema {type:"object",properties:{}}`; **every** `tools/call` → `{content:[{type:"text",text:"Knowledge graph not available (<reason>). Run \`pico-cli setup --project <cwd>\` to initialize."}], isError:true}`; any other request with an id → `{}`. | **source-inspected**, then **fixture-tested** against a real child speaking that protocol | New `knowledgeDataGap` mapping. Previously this answer was reported as `status:"error"` (a remote graph error), indistinguishable from "remote graph rejected this node". It is now `status:"unavailable"` + `remoteError:true` + `knowledgeData {available:false, reason, remediation, source:"pico-cli knowledge server"}`, with full CLI provenance. Detection requires `isError:true` **and** the exact published sentence, so an ordinary answer that merely quotes the sentence cannot be misclassified. |
| 3 | The **reason** inside the parentheses is the version-specific part. 0.4.4 computes it inline (`graph.json not found at <path>` / `current directory is not a pico-cli setup project`); 0.5.0 computes it from its `.pico-env.json` diagnosis (`No .pico-env.json found. Fix: run …`, `[<v>] data not found. <scope> .pico-env.json (<file>) points to <path> which does not exist…`, `[<v>] not found. … is stale…`). The envelope around it is byte-identical on both lines. | **source-inspected** | The envelope is matched; the reason is carried through **verbatim**, never parsed, and the regex's reason group is greedy because 0.5.0 reasons themselves contain parentheses. That is the version-aware mapping: one detection, no per-line branch, and no invented vocabulary. |
| 4 | `graphify serve` argv is identical on both lines (`serve --graph <graph.json> --workspace <dir>`), so there is no per-line difference in how a *provisioned* server is launched. | **source-inspected** | Nothing to adapt. Recorded so a future reader does not go looking. |

Not established: any behaviour of a *provisioned* `graphify` binary (never present here), the real declaration set of the working server, and any claim that our action inputs/outputs match it. The `switch_workspace`/root handling remains a hint-only path — this adapter computes no declaration authority and asserts none (the SDK track owns `readDeclarationIdentity`, which does not exist in this worktree).

## TDD evidence

RED (tests written first, run against the C1 build; saved under the session scratchpad `red/`):

```
$ npm run test:knowledge-lifecycle                     → exit 1   ℹ tests 24  pass 19  fail 5
✖ managed knowledge transport spawns only the capability-proven route for each CLI identity
    actual [["mcp","dev-knowledge"]] - expected [["knowledge","server"]]
✖ a managed startup failure never retries another knowledge alias
✖ missing knowledge data and a transport startup failure stay distinct structured results
    actual 'error' - expected 'unavailable'
✖ the canonical managed route keeps cold startup, concurrency, output caps and EOF retirement
    actual [["mcp","dev-knowledge"],["mcp","dev-knowledge"]] - expected [["knowledge","server"],["knowledge","server"]]
✖ the exported legacy knowledge default is the 0.4.x route-table entry, not a second literal
    "the route literal belongs to the capability route table only": true !== false

$ node --test --test-name-pattern='knowledge consumer contract' test/picocli-autoinstall.mjs   → exit 1
SyntaxError: The requested module '../dist/clicapabilities.js' does not provide an export named 'capabilityNeedsFreshDiscovery'
```

The environment-guidance test was written after that first RED batch, so its RED was captured explicitly by disabling only that branch in `src/knowledge.ts`, rebuilding, running the one test, then restoring:

```
$ node --test --test-name-pattern='environment gate returns the exact PICO_HOME remedy' test/knowledge-lifecycle.mjs → exit 1
✖ … AssertionError: {"status":"unavailable","error":"spatial-knowledge connection closed",
    "failureClass":"environment","outputTail":"[warn] PICO_HOME is not set", …}
```

One RED was my fixture's fault, not the implementation's, and is worth recording: my first "unclassifiable help" stand-in read `fixture reply without a usage section`, which contains the word *usage*, so `classifyHelpOutput` took the usage-section branch and returned the terminal `unavailable/generic-parent-help` instead of `unknown/malformed-help`. The implementation was right; the fixture text changed, and the terminal case became its own assertion block using the **real** retained 0.5.0 `knowledge --help` parent bytes (invocation 080).

GREEN (after `npm run build`, on the committed tree):

```
$ npm run build                        → tsc clean
$ npm run test:knowledge-lifecycle     → exit 0   ℹ tests 26  pass 26  fail 0
$ npm run test:picocli                 → exit 0   pico-cli lane Failures: 0 ; tests 157 pass 157 fail 0
$ npm run test:doors                   → exit 0   Doors test done. Failures: 0
$ npm run test:distribution-adoption   → tests 43 pass 41 fail 2   (the two documented baseline reds only)
$ npm run test:preflight               → exit 0   Preflight test done. Failures: 0   (shared fixture helper changed; run for safety)
```

`test:distribution-adoption`'s two failures are exactly the known-red pair named in the dispatch: gate-lane counts `{linux: 45 !== 44}` and the `test:` script inventory (`test:tarball`, 48 vs 46). Their inputs (`gates.yml`, `package.json`, the test file) are byte-identical to `c977ef0`. **One flake to be aware of:** on one full-suite run under load, `bootstrap forwards SIGTERM to the MCP child` also failed (49 ms); it passes alone and passed on the immediate full-suite re-run. It is a timing flake in a test I did not touch, not a regression.

Brief's required fixture assertions, present verbatim in `test/knowledge-lifecycle.mjs`:

```js
assert.deepEqual(spawnsFor050.map((x) => x.args), [["knowledge", "server"]]);
assert.deepEqual(spawnsFor044.map((x) => x.args), [["mcp", "dev-knowledge"]]);
assert.equal(unknownCapabilitySpawns.length, 0);
assert.deepEqual(externalSpawn.args, ["custom-server", "--stdio"]);
```

## Files changed

| File | Why |
| --- | --- |
| `src/knowledge.ts` | Capability-driven transport selection, structured refusal, argv in the session identity, environment guidance, the published no-graph mapping. |
| `src/clicapabilities.ts` | `capabilityNeedsFreshDiscovery` (+11 lines): which `unknown` reasons justify one fresh bounded discovery. |
| `src/picoclihealth.ts` | `ensure_pico_cli` description discloses the bounded `--help` discovery probes (routed C1 minor). |
| `test/knowledge-lifecycle.mjs` | Seven new tests (below). |
| `test/picocli-autoinstall.mjs` | The knowledge consumer contract: per-line argv through `picoCliOperationCapability`, cross-line refusal, and the fresh-discovery rule pinned against the real reason strings. |
| `test/helpers/picocli-managed-fixture.mjs` | `helpMap` option, inline help bytes, both knowledge routes, usage-shaped fallback help. |
| `test/fixtures/fake-knowledge-server.mjs` | The published degraded-server shape behind an identity flag. |

New tests in `test/knowledge-lifecycle.mjs` (all in the existing `test:knowledge-lifecycle` script — **no new package script, nothing to register in CI**):

1. *managed knowledge transport spawns only the capability-proven route for each CLI identity* — the four brief assertions, plus the structured refusal (reason, argvPrefix, existing absolute evidence paths, provenance), zero child starts, no `mcp dev-knowledge` and no colon alias anywhere in the ledger, and exactly one registry lookup (an evidence-backed `unknown` must not trigger a second resolution). Includes the real-bytes terminal case (0.5.0 invocation 080 parent help → `unavailable`, zero spawns).
2. *a managed startup failure never retries another knowledge alias* — server-side rejection → `flag-or-version-drift`, no `transport` field (a startup failure is not a capability refusal), exactly one spawn and it is `knowledge server`.
3. *missing knowledge data and a transport startup failure stay distinct structured results* — the two shapes side by side under the same 0.5.0 identity.
4. *a knowledge server that stops at the environment gate returns the exact PICO_HOME remedy* — and never prescribes setup.
5. *the canonical managed route keeps cold startup, concurrency, output caps and EOF retirement* — one generation for concurrent callers, `maxOutputBytes` truncation, call timeout → `timeout` + retirement, replacement through the same capability-proven route with a different pid, exit observed after close, no surviving process.
6. *a started knowledge transport declares no graph API of its own* — `tools/list` against the published degraded shape declares only `graph_stats` with an empty input schema; none of our other seven actions is declared.
7. *the exported legacy knowledge default is the 0.4.x route-table entry, not a second literal* — value pinned **and** the literal's absence from `src/knowledge.ts` asserted.

## Self-review

- **Completeness.** Every brief checkbox: fixture captures argv under exact 0.4.4/0.5.0 identities ✔; default is `knowledge server` on 0.5.x with no silent alias retry ✔; configuration overrides, cold startup, concurrent callers, cancellation/timeout, EOF retirement, output cap, wrong/reused PID and generation ownership all still covered — the PID/birth-identity/ownership set is the pre-existing 19 tests, which still pass unchanged, and the managed-route variants of cold start/concurrency/cap/timeout/EOF are new ✔; canonical dispatch with preserved structured evidence and exact provenance, missing data vs startup failure distinct ✔; graph reconciliation from the published declarations with a harmless fixture server ✔; build + both named suites ✔. Controller resolutions 1–5 all followed, including the TDD order.
- **Quality.** Transport selection stayed in `knowledge.ts`, capability/route facts in `clicapabilities.ts`, managed store/probes untouched in `picoclimanaged.ts`. No restructuring of either large file: the new code is one private method plus three small module-level helpers.
- **Discipline (YAGNI).** I deliberately did **not** add a per-session `tools/list` call to production: the only declarations in the published package are the degraded server's, and its `tools/call` answer already identifies that state, so a round trip per session would buy nothing and add a failure mode to 20+ lifecycle fixtures. The declaration reconciliation is proved in the test instead. I also left the `knowledge_api` tool description alone.
- **Testing.** Everything runs against real fake child processes; the 0.4.4/0.5.0 classifications come from retained bytes, not from strings I wrote. Output is pristine (no stray logging). Source-derived stand-ins (the PICO_HOME line, the "unknown command server" rejection) are labelled as such in the test comments, per the C1 labelling convention.
- **The three specific checks.** *No alias retry after a server error*: argv is chosen once per call from the capability and never re-chosen after a spawn; the rediscovery branch runs strictly before any spawn and only for reasons meaning "no usable evidence bound to this target"; test 2 pins it. *No unrelated process can be killed*: the retirement/signal code is untouched, and adding argv to the session identity only makes identity stricter (more retirement, never a looser signal target). *Startup/default doctor still spawn nothing*: resolution happens only inside `call()`; `DEFAULT_KNOWLEDGE_ARGS` evaluates a pure route-table lookup at module load; `test:preflight` and the adoption suite's read-only startup case are green.

## Concerns / notes for the controller

1. **`test/helpers/picocli-managed-fixture.mjs` help fallback changed shape** (additive elsewhere). Any parallel track asserting the literal `fixture help: …` first line of the **runtime** harness's `--help` will need to accept the preceding usage line. `createHarness` (the other fixture) is untouched precisely because `test/picocli-autoinstall.mjs` asserts `malformed-help` from it.
2. **`DEFAULT_KNOWLEDGE_ARGS` is now derived.** `test/distribution-adoption.mjs` still pins its value, so the derivation is safe today; but if anyone ever edits the 0.4.x route-table entry, that unrelated-looking gate will fail. The new lifecycle test states the coupling explicitly.
3. **The knowledge-data mapping is text-matched on the CLI's own published sentence.** If PICO rewords it in a later release, the result silently reverts to today's `status:"error"` behaviour (no crash, no wrong claim, just a less specific answer). A future help/registration sweep is the natural place to notice.
4. **`environment` refusals from a capability reason** append the PICO_HOME guidance derived from the reason string rather than from raw stderr (only the reason survives discovery). The wording is unchanged and still never prescribes setup, but it is one indirection away from the bytes.
5. **One bounded rediscovery per call can re-resolve the CLI version.** If the forced refresh lands a newer package, the call proceeds against that newer target (with its provenance). That is `ensure_pico_cli`'s documented behaviour, but it means a single `knowledge_api` call can, in the no-evidence case, perform one registry lookup more than before.
6. **`test/distribution-adoption.mjs` flake**: `bootstrap forwards SIGTERM to the MCP child` failed once under load and passes in isolation and on re-run. Not mine, but worth a retry-tolerance or a timing fix from the release track.
7. **C3/C4 are still unguarded.** `picoclitools.ts`, `perfcli.ts` and `perftrace.ts` continue to dispatch without consulting `picoCliOperationCapability`; the `perf-live` route in particular is `unavailable`/no-route on 0.4.x. C2 wired only the knowledge path, as scoped.
