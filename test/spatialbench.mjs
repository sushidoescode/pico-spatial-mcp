// v23 SpatialBench test: the headless tier scores the ENTIRE corpus deterministically, and the
// report renderer keeps the honesty framing (eye = auto_judged, skips marked not zeroed).
// v27.5 adds the optional perf axis: unit-tests the scoring decision (scorePerfAxis) headlessly —
// no emulator involved — plus keeps the axes-shape assertion tolerant of the new column.
// Run: npm run test:bench
import { headlessRows, renderBenchHtml } from "../dist/spatialbench.js";
import { scorePerfAxis } from "../dist/perfprobe.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const { rows, briefsDir } = headlessRows();
if (rows.length >= 15) ok(`corpus loads (${rows.length} briefs from ${briefsDir})`);
else fail(`expected ≥15 corpus briefs, got ${rows.length}`);

const perfect = rows.filter((r) => r.score === 3 && r.max === 3).length;
if (perfect === rows.length) ok(`headless tier: every brief scores 3/3 (planned+compiled+shape)`);
else fail(`headless regressions: ${rows.filter((r) => r.score !== 3).map((r) => `${r.id}=${r.score}/3 [${r.notes.join("; ")}]`).join(", ")}`);

if (rows.every((r) => r.booted === null && r.captured === null && r.eye === null && r.perf === null)) ok("headless tier never claims emulator axes (booted/captured/eye/perf stay null)");
else fail("headless tier leaked emulator-axis claims");

// renderer honesty: emulator axes render as —, skips marked, auto_judged framing present
const report = {
  generatedAt: "2026-07-14T00:00:00Z",
  tier: "headless",
  briefsDir,
  summary: { total: rows.length, aggregate: rows.reduce((a, r) => a + r.score, 0), maxAggregate: rows.reduce((a, r) => a + r.max, 0), skipped: [], escalations: [] },
  rows: [...rows.slice(0, 2), { ...rows[2], skipped: "needs an external asset", notes: [] }],
};
const html = renderBenchHtml(report);
if (html.includes("auto_judged") && html.includes("NOT vision_verified")) ok("report keeps the honesty framing (eye = auto_judged, not vision)");
else fail("honesty framing missing from the report");
if (html.includes('<span class="na">—</span>') && html.includes("skipped: needs an external asset")) ok("unrun axes render as — and skips are marked, not zeroed");
else fail("axis/skip rendering wrong");

if (html.includes("<th>perf</th>") && html.includes("NOT the spatial engine's 3D frame pacing")) ok("report gains a perf column + honestly scopes it to UI frames, not 3D pacing");
else fail("perf column/honesty framing missing from the report");

// scorePerfAxis: the perf-axis decision function, headlessly testable without an emulator.
const budgetMs = 16.7;
const under = scorePerfAxis({ verdict: "smooth (60fps-class UI frames)", p95: 12.4 }, budgetMs);
if (under === 1) ok("scorePerfAxis: parsed data under budget -> 1");
else fail(`scorePerfAxis under-budget expected 1, got ${under}`);

const over = scorePerfAxis({ verdict: "janky", p95: 41.2 }, budgetMs);
if (over === 0) ok("scorePerfAxis: parsed data over budget -> 0");
else fail(`scorePerfAxis over-budget expected 0, got ${over}`);

const noData = scorePerfAxis({ verdict: "no-frame-data", p95: null }, budgetMs);
if (noData === null) ok("scorePerfAxis: no UI frame data -> null (skip, not a fail)");
else fail(`scorePerfAxis no-frame-data expected null, got ${noData}`);

console.log(`\nSpatialBench test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
