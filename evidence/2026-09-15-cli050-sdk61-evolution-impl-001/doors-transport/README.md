# Doors transport measurements (Task C5)

Host-executed fixture measurements taken on one machine before and after the C5 change
(single-flight inner doors server + complete MCP result transport). They are observations of the
hermetic doors fixture, not promises, targets, or device/emulator evidence. No optimization target was
set; the acceptance is the removal of two defects (duplicate inner initialization under concurrent
first use, lost inner results) with no unexplained regression in the fixed-input numbers.

## Method

- Script: [`measure-doors-transport.mjs`](measure-doors-transport.mjs) (`node <script> <label>`),
  run from the `track/cli050-cli` worktree. It spawns the repo's own `dist/index.js` on the doors
  surface under the same harness the doors suite uses (`test/helpers/picocli-managed-fixture.mjs`:
  fixture `HOME` and `PICO_HOME`, fake `npm` and a logging `node` proxy as the child's command
  shims), plus `PICO_ADB` pointed at an `exit 1` stub so `pico_look` can never reach a real adb or
  emulator. The inner full-surface child is counted from the node proxy's log (one line per
  `dist/index.js` lifetime).
- Fixed inputs: `pico_sdk {symbol:"Entity"}` (cold = first call on a fresh server, then 10 warm
  sequential calls), `pico_doctor {}` (read-only), `pico_look {}` (through the adb stub, i.e. the
  screencap-failure path), and a second fresh server receiving 20 concurrent `pico_sdk` calls.
- Bytes are `Buffer.byteLength(JSON.stringify(result))` of the door's MCP result.
- Environment: macOS (`darwin-arm64`), Node v25.8.1, source commit `9726a84` (`track/cli050-cli`).
  `before.json` was taken with `dist/` built from the untouched base `src/` (the working tree was
  dirty only with the new test files and this script). `after.json` was taken with `dist/` built
  from the C5 working tree, before the C5 commit (hence the same `commit` field and `dirty: true`).

## Numbers

| Measure | before ([before.json](before.json)) | after ([after.json](after.json)) |
|---|---:|---:|
| `pico_sdk` cold latency (first call, includes inner spawn) | 340.4 ms | 343.3 ms |
| `pico_sdk` warm latency, median of 10 (min–max) | 0.5 ms (0.3–0.7) | 0.5 ms (0.4–0.8) |
| `pico_sdk` response bytes | 816 | 816 |
| `pico_doctor {}` response bytes | 6788 | 6788 |
| `pico_look` envelope `isError` / text `status` | `false` / `"ok"` (the screencap failure was rewrapped as `{status:"ok", detail}`) | `true` / none (the capture tool's own `fail()` text, verbatim) |
| `pico_look` response bytes | 147 | 115 |
| inner children started, sequential server | 1 | 1 |
| inner children started, 20 concurrent first calls | **20** | **1** |
| 20-call burst wall time | 734.3 ms | 296.2 ms |
| burst responses identical / statuses | yes / 20 × `unavailable` | yes / 20 × `unavailable` |

`unavailable` is the expected `pico_sdk` answer under the fixture: no vault index exists below the
fixture `PICO_HOME`. The burst wall time fell because one child is started instead of twenty; it was
measured once per record (n = 1) and is not a performance claim. Cold and warm latency and the
byte sizes of unchanged doors are equal within run-to-run noise, so the transport change added no
measurable cost on this input set. The two `after` runs taken during development both recorded a
burst wall time of 296.2 ms; the retained record is the second one, taken after the final rebuild.

## Limits

- One machine, one run per record; cold latency is a single sample. Nothing here characterizes
  another host, CI, Windows, or a real device or emulator.
- The `pico_look` row measures only the failure path (adb stub). The success path (a real
  screencap with image data) is covered by the in-process lane fixture in `test/doors.mjs`, not by
  these numbers.
- The fixture vault is absent, so `pico_sdk` exercises the transport with a small `unavailable`
  payload; larger successful payloads were not measured.
- `dist/` freshness is the measurer's responsibility: the script does not build.
