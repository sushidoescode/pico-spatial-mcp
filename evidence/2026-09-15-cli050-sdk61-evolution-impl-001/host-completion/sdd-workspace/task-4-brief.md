### Task 4: Bounded, correlated log observation — no implicit global logcat clear anywhere

**Files:**
- Create: `src/logwindow.ts`, `test/logwindow.mjs`
- Modify: `src/assertscene.ts:71-80`, `src/sense.ts:571-584`, `src/copilot.ts:64-66`, `src/workflow.ts:380-384`, `src/doors.ts:1012-1016` (`pico_loop`), `src/adb.ts:330-342` (`logcat clear`), `src/adb.ts:396-440` (`assert_logcat`), `src/agentloop.ts:140-160` (`wait_for_log`), `src/boundaryexperiment.ts:3004-3016`
- Test: `test/logwindow.mjs` (new, registered under `test:emulator-restart`'s command list or a new gate — see T6), `test/doors.mjs`, `test/boundaryexperiment.mjs`, plus whatever suites fixture `assert_scene`/`probe_planes`/`build_and_run` (`grep -ln 'assert_scene\|probe_planes\|build_and_run' test/*.mjs`)

**Interfaces:**
- Produces (`src/logwindow.ts`):

```ts
export const LOG_WINDOW_TAG = "pico-mcp";
export interface LogWindow { serial: string; marker: string; openedAt: string }
export type AdbRunner = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
/** Writes one marker line into the device's main log buffer (`adb -s S shell log -t pico-mcp <marker>`). Never clears anything. */
export async function openLogWindow(run: AdbRunner, serial: string): Promise<LogWindow>;
/** Bounded dump (`logcat -d -v threadtime -t <maxLines>` plus tag filters that always include pico-mcp:V), sliced to the lines AFTER the marker. */
export async function readLogWindow(run: AdbRunner, window: LogWindow, opts?: { tags?: string[]; buffers?: string[]; maxLines?: number; timeoutMs?: number }): Promise<{ markerSeen: boolean; lines: string[]; raw: string }>;
export function sliceAfterMarker(stdout: string, marker: string): { markerSeen: boolean; lines: string[] };
export function newLogMarker(): string; // `pico-mcp-window-<uuid>`
```

- Semantics every caller follows: a read with `markerSeen: false` (marker evicted or never written) is INCONCLUSIVE — the caller reports `{ logWindow: { marker, markerSeen: false }, status: "inconclusive" }` and never matches against the unscoped buffer. Every result carries `serial` (the explicit target context) and `logWindow`.

- [ ] **Step 1: Write `test/logwindow.mjs`** (pure unit tests, no adb)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sliceAfterMarker, openLogWindow, readLogWindow, LOG_WINDOW_TAG } from "../dist/logwindow.js";

test("sliceAfterMarker returns only lines after the marker line", () => {
  const out = ["old 1", "old 2", `09-16 00:00:00.000  1  1 I ${LOG_WINDOW_TAG}: pico-mcp-window-abc`, "new 1", "new 2"].join("\n");
  assert.deepEqual(sliceAfterMarker(out, "pico-mcp-window-abc"), { markerSeen: true, lines: ["new 1", "new 2"] });
});

test("a missing marker is reported, never silently treated as an empty window", () => {
  assert.deepEqual(sliceAfterMarker("a\nb\n", "pico-mcp-window-zzz"), { markerSeen: false, lines: [] });
});

test("openLogWindow writes exactly one `log -t pico-mcp <marker>` and never a clear", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const window = await openLogWindow(run, "fixture-serial");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["-s", "fixture-serial", "shell", "log", "-t"]);
  assert.equal(calls[0][5], LOG_WINDOW_TAG);
  assert.equal(calls[0][6], window.marker);
  assert.ok(!calls.some((a) => a.includes("-c")));
});

test("readLogWindow always includes the marker tag in its filter and bounds the dump", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: `x\nI ${LOG_WINDOW_TAG}: m1\nAgentBridge: dump_begin\n`, stderr: "" }; };
  const result = await readLogWindow(run, { serial: "fixture-serial", marker: "m1", openedAt: "t" }, { tags: ["AgentBridge"], maxLines: 500 });
  assert.equal(result.markerSeen, true);
  assert.deepEqual(result.lines, ["AgentBridge: dump_begin"]);
  assert.ok(calls[0].includes("-d") && calls[0].includes("-t") && calls[0].includes("500"));
  assert.ok(calls[0].includes("AgentBridge:V") && calls[0].includes(`${LOG_WINDOW_TAG}:V`) && calls[0].includes("*:S"));
  assert.ok(!calls[0].includes("-c"));
});
```

- [ ] **Step 2: Run; expect FAIL (module missing). Implement `src/logwindow.ts` per the interface (marker = `pico-mcp-window-${randomUUID()}`; `buffers` maps to repeated `-b <name>`; default `maxLines` 4000; `raw` is the dump text).**

- [ ] **Step 3: Run `test/logwindow.mjs`; expect PASS. Commit.**

```bash
git add src/logwindow.ts test/logwindow.mjs
git commit -m "feat: marker-correlated bounded log windows replace global logcat clearing"
```

- [ ] **Step 4: Replace every implicit clear.** For each site: open a window BEFORE the action that produces the lines, read the window after, report `serial` and `logWindow`, and treat `markerSeen:false` as inconclusive:

  - `src/assertscene.ts:76` (`assert_scene`): `const window = await openLogWindow(runner, dev);` … after the broadcast and settle, `const { markerSeen, lines } = await readLogWindow(runner, window, { tags: [tag] });` → `parseDump(lines.join("\n"))`; when `!markerSeen` return `{ error: "log window marker was evicted before the dump was read on <dev>; the buffer was not cleared, re-run" , serial: dev, logWindow }`.
  - `src/sense.ts:576` (`probe_planes`): same pattern with `tags: [t, "AgentBridge"]` inside the poll loop (one window opened before the broadcast; each poll re-reads the same window).
  - `src/copilot.ts:65` (`snapshot`): same, `tags: ["AgentBridge"]`.
  - `src/workflow.ts:383` (`build_and_run`): open the window before launch instead of clearing; every later logcat read in that handler reads the window; `report.steps.push({ logWindow: { marker, markerSeen } })`.
  - `src/doors.ts:1016` (`pico_loop`): `const marker = newLogMarker(); await call("adb_shell", { command: \`log -t ${LOG_WINDOW_TAG} ${marker}\` }).catch(() => {});` and pass `sinceMarker: marker` to every `assert_logcat` call in that iteration (line 1071).
  - `src/adb.ts:419` (`assert_logcat`): new input `sinceMarker: z.string().optional()`; `clearFirst` KEPT for compatibility but re-described ("opens a marker window instead of clearing the device log; equivalent to sinceMarker with a fresh marker") and implemented as `openLogWindow`; the poll matches only `sliceAfterMarker(stdout, marker).lines` when a marker is in play; the result carries `serial`, `logWindow`.
  - `src/agentloop.ts:150` (`wait_for_log`): same treatment; default `clearFirst: true` now opens a window.
  - `src/boundaryexperiment.ts:3011`: replace `logcat -b all -c` with `openLogWindow` and read `-b all` through `readLogWindow(..., { buffers: ["all"] })` into `prepare-logcat-all.txt` (write `lines`, plus a first line `# window marker <marker> seen=<bool>`); an unseen marker is a `BoundaryPreparationFailure` with `structuralStop: "log_window_evicted"` — never a silent pass.
  - `src/adb.ts:338` (`logcat` tool `clear:true`): the ONE explicit destructive clear stays, but `clear` now requires an explicit `serial` (no sole-device resolution) and the description says "destructive: erases the device's global log buffer; explicit serial required".

- [ ] **Step 5: Add the source-level guard to `test/logwindow.mjs`:**

```js
test("no src file clears logcat implicitly; the explicit logcat tool is the only clear", () => {
  const src = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const name of fs.readdirSync(src).filter((n) => n.endsWith(".ts"))) {
    const text = fs.readFileSync(new URL(name, src), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/"logcat",\s*(?:"-b",\s*"[a-z]+",\s*)?"-c"/.test(line) || /logcat -c/.test(line)) offenders.push(`${name}:${index + 1}`);
    }
  }
  assert.deepEqual(offenders, ["adb.ts:<line of the explicit clear>"], offenders.join(", ")); // pin the one allowed site by file:line
});
```

- [ ] **Step 6: Rebuild; run the suites that fixture these tools (`test:doors`, `test:emulator-restart`, `test:conformance` for boundaryexperiment, `test:preflight`, `test:picocli`, `test:observation`, `test/logwindow.mjs`); expect PASS. Register `test/logwindow.mjs` in the inventory (`test:observation`'s command list is the natural home — add `"test/logwindow.mjs"` to it; `validateGateInventory` derives the counts). Commit.**

```bash
git commit -am "fix: observation paths open marker windows instead of clearing the device log"
```

---

