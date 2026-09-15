# Synthetic profiler fixtures (NOT retained CLI output)

Everything in this directory is **synthetic**: it was hand-written to match a published
declaration, not captured from a running `pico-cli` or profiler. Nothing here is evidence that any
command was executed, that a device was measured, or that the profiler is provisioned. Retained
*real* bytes live in `../help/` (see `../help/index.json`).

## What the report fixtures were built from

The `live-report-*.json` files encode the `ReportData` interface declared by the vendored profiler,
read in memory from the official tarballs in
`evidence/2026-09-15-cli050-sdk61-evolution-audit-001/` (Python `tarfile`; nothing was extracted or
executed):

| Fixture line | Nested archive member | Declaration |
| --- | --- | --- |
| `0.2.0` (bundled with pico-cli `0.5.0`) | `picoxr-pico-cli-0.5.0.tgz!package/vendor/profiler-cli/pspp-profiler-cli-0.2.0.tgz!package/dist/src/live/reporter.d.ts` (2245 bytes, sha256 `9d0e2c331d06e49692bc68800aa504428b1cd986cd3246362a35b10b6636e5cb`), lines 1–75 | `JankWindowEntry`, `ReportData` |
| `0.1.0` (bundled with pico-cli `0.4.4`) | `picoxr-pico-cli-0.4.4.tgz!package/vendor/profiler-cli/pspp-profiler-cli-0.1.0.tgz!package/dist/src/live/reporter.d.ts` | `ReportData` (excerpt `REPORT044`) |

Schema facts the fixtures exercise (`REPORT044` / `REPORT050` in
`CLI050_STATIC_EXCERPTS_001.json`):

- `metadata.app` (0.1.0) became `metadata.package` (0.2.0) — the only field that identifies the
  report's schema line, because neither report carries a version field.
- `metadata.timeAlignment` (`strategy: 'logcat-anchor-with-hb-fallback'`, `heartbeatMs`) is 0.2.0-only.
- `diagnosis.result` gained `SKIP` and `diagnosis.category` gained `INSUFFICIENT_DATA` in 0.2.0.
- `summary` declares `appFps` (`avg/max/min/p5/p10/p50/dropsCount`), `sysFps` (no `dropsCount`),
  `gpuUsage`, `gpuFreq`, `systemCpu`, `appCpu` (`avg/max`) and `gpuTemp` (`start/end/max/trend`).
  There is **no** `appFps.p95` field on either line.
- `jankWindows: JankWindowEntry[]` and `rawData: any[]`.

`live-report-0.2.0-skip.json` reproduces the branch retained as `PERF_SKIP050`
(`diagnoseFromFpsAvailability`): when neither app nor Spatial Runtime FPS was collected the
profiler emits `{result:"SKIP", category:"INSUFFICIENT_DATA", suggestion:"Skip for no App FPS or
Spatial Runtime FPS was collected"}`.

`live-report-0.2.0-no-app-frames.json` reproduces the neighbouring branch: Spatial Runtime FPS was
collected while app FPS was not. It exists so a test can prove that runtime/compositor FPS is never
accepted as app FPS.

## `fake-perf-cli.mjs`

A fake CLI used as the injected run seam of `collectPerfLive` / `runPerfTrace`. It reproduces, from
the same in-memory reads, only the decisions those wrappers depend on:

- the `0.5.0` router allow-list and its `Unknown perf subcommand: …` rejection text
  (`package/dist/index.js:36–37`, excerpts `PERF_ROUTER050` / `PERF_ENV050`), so `perf monitor run`
  is refused exactly as the published router refuses it;
- `LiveRunAction`'s own validation (`pspp-profiler-cli-0.2.0.tgz!package/dist/index.js:2`, excerpt
  `LIVE050`): `--package` required, `--app` a deprecated alias, and
  `` `-o, --output <path>` requires `--save` (or `--report-mode`, which implies save).`` — so a
  report file appears **only** when the supported save/output arguments were passed;
- the utilities gate and the `PICO_HOME` gate texts (`PERF_ENV050`), for the refusal classes.

The messages it prints are **source-derived** (constructed from the retained templates), not
observed output: no provisioned profiler help was ever available on this host.
