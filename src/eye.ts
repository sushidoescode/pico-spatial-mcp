import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, okJson, fail, expandHome } from "./util.js";
import { readCaptureBytes, validateCapture, validateCaptureBuffer } from "./evidence.js";
import { appendAutoJudgedEntry } from "./ledger.js";
import { sendXrRecenter } from "./grpc.js";

/**
 * eye.ts — v6.3 THE TRUSTWORTHY AUTOMATED EYE + DETERMINISTIC CAPTURE (now MR-aware).
 *
 * Two subsystems that scale verification WITHOUT lying:
 *
 * 1. capture_canonical — a deterministic capture. The adb-screencap forward view is byte-stable across
 *    repeated captures AND across kill+relaunch (measured: MAE=0), because content is authored in the
 *    forward FOV and this path (unlike the GUI free-cam orbit) does not drift. So "same brief → same
 *    pixels" is achievable simply by NOT moving the camera: optional RECENTER command, settle, screencap,
 *    hash. Returns a content sha256 so a frame is reproducible-by-construction and ledger-bindable, and
 *    can diff against an expected sha to DETECT drift instead of silently capturing the wrong view.
 *
 * 2. visual_judge — a calibrated automated judge. It MEASURES objective properties of a real frame
 *    (foreground object COUNT via connected-components, dominant colors, non-black coverage, brightness)
 *    against a node's acceptance predicate, and returns a verdict + confidence. THE INVARIANT HOLDS: a
 *    judge verdict is EVIDENCE, never human sight. A PASS records under the DISTINCT `auto_judged` class
 *    (bucketed separately from vision_verified in every report); a hard failed check returns FAIL,
 *    while low confidence ESCALATES to a human LOOK. Neither records evidence. It closes the "N cards render"
 *    over-claim by actually counting the cards. Calibrated against the human-verified golden (6 cards →
 *    the judge measures 6); a human audit sampling auto_judged entries keeps it honest.
 *
 * v6.3 MR MODE (the passthrough rule). The count model (12% gray threshold, drop the largest component
 * as "the void") is built for bright-objects-on-black VR stages; on a Mixed-stage passthrough frame it
 * INVERTS — the merged room+content blob is the dropped component and the residual DARK islands (menu
 * bodies, shadows) get counted instead of the authored objects (measured on the mrtable proof run:
 * coverage 0.9801, 7 dark islands vs 4 authored primitives). And notMostlyBlack is a tautology there —
 * the home environment always supplies pixels. So above PASSTHROUGH_COVERAGE_THRESHOLD the legacy
 * checks become ADVISORY (zero confidence, never PASS, never hardFail) and only color-keyed counting
 * against the spec's AUTHORED palette (expect.authoredColors → the metric layer's calibrated
 * detect_colorkey.py) can score. A passthrough frame with no scorable color-key evidence ALWAYS
 * escalates — by design, never auto-PASS on a dark-island count that happens to land in the band.
 */

function resolveAdb(): string {
  const c = [process.env.PICO_ADB, path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb"), "/opt/homebrew/bin/adb", "adb"].filter(Boolean) as string[];
  for (const x of c) if (x === "adb" || fs.existsSync(x)) return x;
  return "adb";
}

export type FrameMeasurements = {
  available: boolean;
  sha256?: string;
  width?: number;
  height?: number;
  bytes?: number;
  meanBrightness?: number | null;
  nonBlackCoverage?: number | null;
  mostlyBlack?: boolean | null;
  dominantColors?: string[];
  objectCount?: number | null;
  objects?: { area: number; bbox: string }[];
  colorKey?: ColorKeyMeasurements;
  error?: string;
};

/** Above this nonBlackCoverage a frame is a passthrough/home-env composite (golden VR frames measure
 * ~0.06; the mrtable Mixed-stage proof frame measured 0.9801) — the count segmentation is unreliable
 * there and must never auto-PASS. */
export const PASSTHROUGH_COVERAGE_THRESHOLD = 0.5;

export function isPassthroughFrame(m: FrameMeasurements): boolean {
  return m.nonBlackCoverage != null && m.nonBlackCoverage > PASSTHROUGH_COVERAGE_THRESHOLD;
}

export type AuthoredColor = { name?: string; color: number[] };
export type ColorKeyMeasurements = {
  available: boolean;
  expected: string[];
  found: string[];
  missing: string[];
  neutralSkipped: string[];
  detections?: Record<string, { pixels: number; bbox: [number, number, number, number] } | null>;
  error?: string;
};

function resolvePython(): string | null {
  const candidates = [process.env.PICO_PY, path.join(os.homedir(), ".pico/venv/bin/python"), "python3"];
  for (const c of candidates) {
    if (!c) continue;
    if (c === "python3" || fs.existsSync(c)) return c;
  }
  return null;
}

const to255 = (c: number[]) => c.map((v) => (v <= 1 ? Math.round(v * 255) : Math.round(v))) as [number, number, number];
/** Distinct = enough channel spread to key on (mirrors detect_colorkey.py's spread>50 saturation gate —
 * a neutral color cannot be discriminated from a home-environment palette). */
const isDistinctColor = (rgb255: [number, number, number]) => Math.max(...rgb255) - Math.min(...rgb255) > 50;

/**
 * v6.3 MR counting — detect each AUTHORED object color in the frame via the metric layer's calibrated
 * detector (scripts/py/detect_colorkey.py: nearest-key + tolerance + saturation gate + channel-rank
 * signature + largest connected component — the same math measure_placement trusts). Colors are
 * [r,g,b] in 0..1 (AppSpec body.color) or 0..255. Neutral authored colors are skipped honestly; if
 * none are distinct, detection is unavailable (the judge then escalates rather than guessing).
 */
export async function analyzeColorKeys(imagePath: string, authored: AuthoredColor[]): Promise<ColorKeyMeasurements> {
  const keys: Record<string, [number, number, number]> = {};
  const neutralSkipped: string[] = [];
  authored.forEach((a, i) => {
    const name = a.name ?? `color${i}`;
    const rgb = to255(a.color);
    if (isDistinctColor(rgb)) keys[name] = rgb;
    else neutralSkipped.push(name);
  });
  const expected = Object.keys(keys);
  const base = { expected, found: [] as string[], missing: expected, neutralSkipped };
  if (!expected.length) return { available: false, ...base, error: "no distinct authored colors (all neutral, channel spread <= 50) — color-key counting cannot discriminate app content from a passthrough background" };
  const cap = validateCapture(imagePath);
  if (!cap.ok) return { available: false, ...base, error: cap.reason };
  const py = resolvePython();
  if (!py) return { available: false, ...base, error: "no python with PIL+numpy+scipy found (PICO_PY / ~/.pico/venv) — color-key detection unavailable" };
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/py/detect_colorkey.py");
  const res = await run(py, [script, imagePath, JSON.stringify(keys)], { timeoutMs: 120_000 });
  if (res.code !== 0 || !res.stdout.trim()) return { available: false, ...base, error: `detect_colorkey failed (code ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 200)}` };
  try {
    const parsed = JSON.parse(res.stdout) as { detections: Record<string, { pixels: number; bbox: [number, number, number, number] } | null> };
    const found = expected.filter((n) => parsed.detections[n]);
    const missing = expected.filter((n) => !parsed.detections[n]);
    const detections = Object.fromEntries(expected.map((n) => [n, parsed.detections[n] ? { pixels: parsed.detections[n]!.pixels, bbox: parsed.detections[n]!.bbox } : null]));
    return { available: true, expected, found, missing, neutralSkipped, detections };
  } catch (e: any) {
    return { available: false, ...base, error: `detect_colorkey output unparsable: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

/**
 * Measure a frame with ImageMagick (deterministic; no model). Foreground object count = connected
 * components after a non-black threshold, dropping the single largest component (the void/background).
 */
export async function analyzeFrame(imagePath: string, opts: { resize?: number; thresholdPct?: number; areaThreshold?: number } = {}): Promise<FrameMeasurements> {
  const cap = validateCapture(imagePath);
  if (!cap.ok) return { available: false, error: cap.reason };
  const resize = opts.resize ?? 500;
  const thr = opts.thresholdPct ?? 12;
  const area = opts.areaThreshold ?? 80;
  try {
    const meanC = await run("magick", [imagePath, "-resize", "1x1", "txt:-"]);
    const rgb = /\((\d+),(\d+),(\d+)/.exec(meanC.stdout.split("\n").find((l) => l.includes("(")) ?? "");
    const brightness = rgb ? (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / (3 * 255) : null;

    const cover = await run("magick", [imagePath, "-colorspace", "Gray", "-threshold", `${thr}%`, "-format", "%[fx:mean]", "info:"]);
    const nonBlackCoverage = cover.code === 0 ? Number(cover.stdout.trim()) : null;

    const hist = await run("magick", [imagePath, "-resize", "200x200", "-colors", "8", "-depth", "8", "-format", "%c", "histogram:info:"]);
    const dominantColors = hist.stdout.split("\n").map((l) => l.match(/#([0-9A-Fa-f]{6})/)?.[1]).filter(Boolean).map((c) => (c as string).toUpperCase()).slice(0, 8);

    // connected-components on the thresholded frame
    const cc = await run("magick", [imagePath, "-resize", `${resize}x${resize}`, "-colorspace", "Gray", "-threshold", `${thr}%`, "-define", "connected-components:verbose=true", "-define", `connected-components:area-threshold=${area}`, "-connected-components", "8", "null:"]);
    const comps: { area: number; bbox: string; white: boolean }[] = [];
    for (const l of cc.stdout.split("\n")) {
      // "  id: WxH+X+Y  cx,cy  area  graya(v,pct)"
      const m = l.match(/^\s*\d+:\s+(\d+x\d+[+\-]\d+[+\-]\d+)\s+[\d.,]+\s+(\d+)\s+\w+\(([\d.]+)/);
      if (m) comps.push({ bbox: m[1], area: Number(m[2]), white: Number(m[3]) > 127 });
    }
    // Foreground = components excluding the single largest (the background/void), above the area floor.
    comps.sort((a, b) => b.area - a.area);
    const foreground = comps.slice(1).filter((c) => c.area >= area);
    const objectCount = comps.length ? foreground.length : null;

    return {
      available: true,
      sha256: cap.sha256,
      width: cap.width,
      height: cap.height,
      bytes: cap.bytes,
      meanBrightness: brightness,
      nonBlackCoverage,
      mostlyBlack: nonBlackCoverage != null ? nonBlackCoverage < 0.02 : null,
      dominantColors,
      objectCount,
      objects: foreground.slice(0, 40).map((c) => ({ area: c.area, bbox: c.bbox })),
    };
  } catch (e: any) {
    return { available: false, sha256: cap.sha256, error: String(e?.message ?? e) };
  }
}

function colorClose(a: string, b: string, tol = 48): boolean {
  const x = a.replace("#", ""), y = b.replace("#", "");
  if (x.length < 6 || y.length < 6) return false;
  for (let i = 0; i < 6; i += 2) if (Math.abs(parseInt(x.slice(i, i + 2), 16) - parseInt(y.slice(i, i + 2), 16)) > tol) return false;
  return true;
}

export type Expectation = { minObjects?: number; maxObjects?: number; notMostlyBlack?: boolean; colorsPresent?: string[]; authoredColors?: AuthoredColor[] };
export type Judgement = { verdict: "PASS" | "FAIL" | "ESCALATE"; confidence: number; checks: { name: string; score: number; detail: string; hardFail?: boolean; advisory?: boolean }[] };

/** The ledger claim is producer-authored: it says exactly which predicate was evaluated and records
 * the resulting checks. Caller prose is never interpolated here because object/color heuristics do
 * not establish semantic assertions such as "dragons" or "finished game". */
export function canonicalVisualJudgeClaim(expect: Expectation, judgement: Judgement): string {
  return `visual_judge measured ${judgement.verdict}: ${JSON.stringify({
    expect,
    confidence: judgement.confidence,
    checks: judgement.checks,
  })}`;
}

/** Pure verdict logic (no I/O) — measure the frame's measurements against the predicate. Unit-testable.
 * THE PASSTHROUGH RULE (v6.3): above PASSTHROUGH_COVERAGE_THRESHOLD the count/black/dominant-color
 * checks are structurally blind (see the header) and become ADVISORY — they contribute ZERO confidence
 * (not padding), never PASS, and never hardFail. Only the color-keyed check (expect.authoredColors +
 * m.colorKey from analyzeColorKeys) can score there, and it needs >= 2 distinct authored colors to
 * auto-judge — a single key is too weak against a home-environment palette. No scoring checks at all
 * → ESCALATE, always. */
export function judgeFrame(m: FrameMeasurements, expect: Expectation, minConfidence = 0.8): Judgement {
  const checks: Judgement["checks"] = [];
  const passthrough = isPassthroughFrame(m);
  const cov = m.nonBlackCoverage?.toFixed(4);
  if (expect.minObjects != null) {
    const lo = expect.minObjects;
    const hi = expect.maxObjects ?? expect.minObjects + 1;
    const n = m.objectCount ?? 0;
    if (passthrough) {
      checks.push({ name: "objectCount", score: 0, advisory: true, detail: `passthrough frame (coverage ${cov}) — the ${n} measured components are dark islands, not authored objects; count segmentation unreliable; escalated by design` });
    } else {
      let score = 0;
      if (n >= lo && n <= hi) score = 1;
      else if (n >= lo - 1 && n <= hi + 1) score = 0.5;
      checks.push({ name: "objectCount", score, detail: `measured ${n} foreground objects; expected ${lo}${hi !== lo ? `..${hi}` : ""}`, hardFail: n === 0 && lo > 0 });
    }
  }
  if (expect.notMostlyBlack) {
    if (passthrough) {
      checks.push({ name: "notMostlyBlack", score: 0, advisory: true, detail: `coverage ${cov} — tautological on a passthrough frame (the home environment always supplies pixels); contributes zero confidence` });
    } else {
      const ok = m.mostlyBlack === false;
      checks.push({ name: "notMostlyBlack", score: ok ? 1 : 0, detail: `coverage ${cov} (${m.mostlyBlack ? "MOSTLY BLACK" : "has content"})`, hardFail: !ok });
    }
  }
  if (expect.colorsPresent?.length) {
    const top = m.dominantColors ?? [];
    let found = 0;
    const misses: string[] = [];
    for (const want of expect.colorsPresent) (top.some((c) => colorClose(c, want)) ? found++ : misses.push(want));
    const score = found / expect.colorsPresent.length;
    const detail = `${found}/${expect.colorsPresent.length} expected colors among dominant${misses.length ? ` (missing ${misses.join(",")})` : ""}`;
    if (passthrough) checks.push({ name: "colorsPresent", score, advisory: true, detail: `${detail} — the dominant-color histogram is environment-dominated on a passthrough frame; advisory only (use authoredColors for color-keyed counting)` });
    else checks.push({ name: "colorsPresent", score, detail });
  }
  if (expect.authoredColors?.length) {
    const ck = m.colorKey;
    if (ck?.available && ck.expected.length >= 2) {
      const score = ck.found.length / ck.expected.length;
      checks.push({
        name: "colorKeyCount",
        score,
        detail: `${ck.found.length}/${ck.expected.length} authored colors detected${ck.found.length ? ` (${ck.found.join(",")})` : ""}${ck.missing.length ? `; missing ${ck.missing.join(",")}` : ""}${ck.neutralSkipped.length ? `; ${ck.neutralSkipped.length} neutral color(s) skipped` : ""}`,
        hardFail: ck.found.length === 0,
      });
    } else if (ck?.available) {
      checks.push({ name: "colorKeyCount", score: ck.found.length, advisory: true, detail: `only ${ck.expected.length} distinct authored color (${ck.expected.join(",")}; found ${ck.found.length}) — too weak to auto-judge against a home-environment palette; advisory` });
    } else {
      checks.push({ name: "colorKeyCount", score: 0, advisory: true, detail: `color-key detection unavailable: ${ck?.error ?? "not measured (caller did not attach colorKey measurements)"}` });
    }
  }
  const scoring = checks.filter((c) => !c.advisory);
  const confidence = scoring.length ? Number((scoring.reduce((a, c) => a + c.score, 0) / scoring.length).toFixed(3)) : 0;
  const anyHardFail = checks.some((c) => c.hardFail);
  let verdict: Judgement["verdict"];
  if (anyHardFail) verdict = "FAIL";
  else if (scoring.length && confidence >= minConfidence && scoring.every((c) => c.score >= 0.5)) verdict = "PASS";
  else verdict = "ESCALATE";
  return { verdict, confidence, checks };
}

/** Keep the measurement verdict separate from evidence persistence. A PASS remains a measured
 * result when the ledger is unavailable, but it has not earned an on-file auto_judged claim. */
export function visualJudgePassNote(confidence: number, record: boolean | undefined, app: string | undefined, ledger?: any): string {
  const prefix = `Measured PASS at confidence ${confidence}. This is auto_judged (measured), NOT vision_verified (human-seen)`;
  if (!record || !app) return `${prefix}. Set record+app to log it, or LOOK to upgrade to human vision_verified.`;
  if (ledger?.status === "recorded") return `${prefix} — recorded to the ledger as auto_judged.`;
  const why = typeof ledger?.reason === "string"
    ? ledger.reason
    : typeof ledger?.message === "string"
      ? ledger.message
      : `ledger status ${ledger?.status ?? "missing"}`;
  return `${prefix} — NOT recorded: ${why}. Repair the ledger before treating this as durable auto_judged evidence.`;
}

export function registerEyeTools(
  server: McpServer,
  deps: {
    sendXrRecenterFn?: typeof sendXrRecenter;
    runBinaryFn?: typeof runBinary;
    analyzeFrameFn?: typeof analyzeFrame;
    analyzeColorKeysFn?: typeof analyzeColorKeys;
    resolveAdbFn?: typeof resolveAdb;
  } = {},
) {
  server.registerTool(
    "capture_canonical",
    {
      description:
        "DETERMINISTIC capture (v6.2). Grabs the emulator's forward immersive frame via `adb exec-out screencap` — byte-stable across repeated captures and across kill+relaunch (measured MAE=0) because content is authored in the forward FOV and this path does not drift (unlike the GUI free-cam orbit). With recenter:true it sends the actual gRPC xr_command RECENTER first; command acceptance is reported, while its rendered-pose effect remains unverified on emulator 0.13.1. Returns the saved path + content sha256 + objective measurements. Pass expectSha to detect drift instead of silently verifying a different view.",
      inputSchema: {
        serial: z.string().optional().describe("adb device serial (default emulator-5554)."),
        outPath: z.string().optional().describe("Full-res PNG output path (default /tmp/pico-render/canonical.png)."),
        recenter: z.boolean().optional().describe("Send gRPC xr_command RECENTER before capture. The command is real; its rendered-pose effect is unverified on emulator 0.13.1. Default false."),
        settleMs: z.number().int().optional().describe("Settle delay before capture (default 600ms)."),
        expectSha: z.string().optional().describe("Expected content sha256 — the tool reports match/DRIFT instead of silently returning a different view."),
      },
    },
    async ({ serial, outPath, recenter, settleMs, expectSha }) => {
      const adb = (deps.resolveAdbFn ?? resolveAdb)();
      const dev = serial ?? "emulator-5554";
      const full = expandHome(outPath ?? "/tmp/pico-render/canonical.png");
      fs.mkdirSync(path.dirname(full), { recursive: true });
      let recenterEffect: "unverified" | undefined;
      if (recenter) {
        const recenterResult = await (deps.sendXrRecenterFn ?? sendXrRecenter)(undefined, { serial: dev });
        if (!recenterResult.ok) return fail(`RECENTER was requested but the gRPC command failed; capture not taken: ${recenterResult.error}`);
        recenterEffect = recenterResult.effect;
      }
      await new Promise((r) => setTimeout(r, settleMs ?? 600));
      const res = await (deps.runBinaryFn ?? runBinary)(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (res.code !== 0 || res.stdout.length < 1000) return fail(`screencap failed (code ${res.code}, ${res.stdout.length} bytes). Is ${dev} running?`);
      fs.writeFileSync(full, res.stdout);
      const sha = crypto.createHash("sha256").update(res.stdout).digest("hex");
      const measurements = await (deps.analyzeFrameFn ?? analyzeFrame)(full);
      const drift = expectSha ? (sha === expectSha ? "MATCH" : "DRIFT") : undefined;
      return okJson({
        status: "captured",
        path: full,
        sha256: sha,
        bytes: res.stdout.length,
        ...(recenterEffect ? { recenter: { commandAccepted: true, targetSerial: dev, renderedPoseEffect: recenterEffect } } : {}),
        ...(drift ? { drift, expectSha } : {}),
        measurements,
        note: drift === "DRIFT"
          ? "DRIFT: this frame differs from the expected canonical view — the camera moved or the scene changed. Do NOT verify against it; re-establish the canonical pose."
          : "Deterministic forward capture. sha256 is reproducible if the camera is not moved. LOOK at it for human verification, or run visual_judge for a measured (auto_judged) check.",
      });
    },
  );

  server.registerTool(
    "visual_judge",
    {
      description:
        "THE CALIBRATED AUTOMATED EYE (v6.3, MR-aware). MEASURES objective properties of a real captured frame (foreground object COUNT via connected-components, dominant colors, non-black coverage, brightness) against an acceptance predicate, and returns a verdict + confidence. This scales verification WITHOUT lying: a judge verdict is EVIDENCE, never human sight. A confident PASS can be recorded (record=true) under the DISTINCT `auto_judged` evidence class — bucketed separately from vision_verified in every report and NEVER upgraded to it. A hard failed check returns FAIL; low confidence returns ESCALATE for a human LOOK. Neither records evidence. It closes the 'N cards render' over-claim by actually counting the objects. Calibrated against the human-verified golden (6 cards → measures 6). MR RULE: on a passthrough/home-env frame (coverage > 0.5 — every Mixed stageStyle '1' capture) the count/black checks are structurally blind and go ADVISORY (they can never auto-PASS); pass expect.authoredColors (the spec's body.color palette) to count objects by color-key detection instead — the real MR auto_judged lane. Without a scorable palette, passthrough frames ALWAYS escalate, by design.",
      inputSchema: {
        imagePath: z.string().describe("Path to the captured frame (from capture_canonical / capture_frame)."),
        claim: z.string().describe("Caller-authored context for why this predicate is being run. It is returned and stored as explicitly unverified context; only the producer-derived expect/check result becomes the measured ledger claim."),
        expect: z
          .object({
            minObjects: z.number().int().optional().describe("Minimum foreground objects expected (e.g. 6 cards)."),
            maxObjects: z.number().int().optional().describe("Maximum foreground objects expected (default minObjects + 1 slack)."),
            notMostlyBlack: z.boolean().optional().describe("The frame must not be an empty/black void. Tautological (advisory, zero confidence) on passthrough frames."),
            colorsPresent: z.array(z.string()).optional().describe("Hex colors expected among the dominant colors, e.g. ['#48A552']. Advisory on passthrough frames (the environment dominates the histogram)."),
            authoredColors: z
              .array(z.object({
                name: z.string().optional().describe("Object id, for the report."),
                color: z.array(z.number()).length(3).describe("Authored [r,g,b], 0..1 (AppSpec body.color) or 0..255."),
              }))
              .optional()
              .describe("MR MODE: the spec's AUTHORED object colors. Objects are counted by color-key detection against this palette (the metric layer's saturation-gated detector) — the only check that can score on a passthrough frame. Needs >= 2 distinct (non-neutral) colors to auto-judge; all-neutral palettes degrade honestly to ESCALATE."),
          })
          .describe("The acceptance predicate to measure against."),
        app: z.string().optional().describe("If set with record=true, records a passing verdict to this app's trust ledger as auto_judged."),
        cClass: z.enum(["C0_emulator", "C1", "C2", "C3", "C4_headset_only"]).optional(),
        record: z.boolean().optional().describe("Record a confident PASS to the ledger as auto_judged (default false). Never records vision_verified."),
        minConfidence: z.number().optional().describe("Confidence needed for a PASS (default 0.8); below the band → ESCALATE."),
      },
    },
    async ({ imagePath, claim, expect, app, cClass, record, minConfidence }) => {
      const source = readCaptureBytes(imagePath);
      if (!source.ok) return okJson({ status: "error", verdict: "ESCALATE", reason: source.reason });
      const sourceCapture = validateCaptureBuffer(source.bytes, imagePath);
      if (!sourceCapture.ok) return okJson({ status: "error", verdict: "ESCALATE", reason: sourceCapture.reason });

      // Analyze a private snapshot written from the one bounded source read. Fleet capture paths are
      // deterministic and may be overwritten concurrently; neither the analyzer nor CAS persistence
      // may re-open that mutable path and accidentally bind measurements to different pixels.
      const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-visual-judge-"));
      const snapshotPath = path.join(snapshotDir, `frame.${sourceCapture.format === "jpeg" ? "jpg" : "png"}`);
      fs.writeFileSync(snapshotPath, source.bytes, { flag: "wx", mode: 0o600 });
      try {
        const measured = await (deps.analyzeFrameFn ?? analyzeFrame)(snapshotPath);
        const m: FrameMeasurements = { ...measured };
        if (!m.available) return okJson({ status: "error", verdict: "ESCALATE", reason: m.error ?? "could not measure frame", measurements: m });
        if (expect.authoredColors?.length) m.colorKey = await (deps.analyzeColorKeysFn ?? analyzeColorKeys)(snapshotPath, expect.authoredColors);

        const after = readCaptureBytes(snapshotPath);
        const afterCapture = after.ok ? validateCaptureBuffer(after.bytes, snapshotPath) : after;
        if (!after.ok || !afterCapture.ok || afterCapture.sha256 !== sourceCapture.sha256) {
          return okJson({
            status: "error",
            verdict: "ESCALATE",
            reason: `the private measurement snapshot changed while visual_judge was running; refusing to bind measurements to unstable pixels${after.ok && afterCapture.ok ? ` (expected ${sourceCapture.sha256}, read ${afterCapture.sha256})` : `: ${afterCapture.reason}`}`,
          });
        }
        if (m.sha256 && m.sha256 !== sourceCapture.sha256) {
          return okJson({ status: "error", verdict: "ESCALATE", reason: `the analyzer measured sha256 ${m.sha256}, not the immutable snapshot ${sourceCapture.sha256}; refusing producer evidence`, measurements: m });
        }
        m.sha256 = sourceCapture.sha256;
        m.width ??= sourceCapture.width;
        m.height ??= sourceCapture.height;
        m.bytes ??= sourceCapture.bytes;

        const need = minConfidence ?? 0.8;
        const judgement = judgeFrame(m, expect, need);
        const { verdict, confidence, checks } = judgement;
        const passthrough = isPassthroughFrame(m);
        const measuredClaim = canonicalVisualJudgeClaim(expect, judgement);
        const callerContext = { text: claim, verified: false as const };

        let ledger: any = undefined;
        if (record && verdict === "PASS" && app) {
          const attestation = `auto_judged: ${checks.map((c) => `${c.name}=${c.score}${c.advisory ? "(advisory)" : ""}`).join(", ")} (conf ${confidence}); ${checks.map((c) => c.detail).join("; ")}`;
          ledger = appendAutoJudgedEntry(app, {
            claim: measuredClaim,
            artifactPath: imagePath,
            artifactBytes: source.bytes,
            attestation,
            cClass,
            autoJudge: {
              schemaVersion: 1,
              verdict,
              confidence,
              expect,
              checks,
              callerContext,
              measurements: { objectCount: m.objectCount, coverage: m.nonBlackCoverage, dominantColors: m.dominantColors, ...(m.colorKey ? { colorKey: { found: m.colorKey.found, missing: m.colorKey.missing, neutralSkipped: m.colorKey.neutralSkipped } } : {}) },
            },
          });
        }

        return okJson({
          status: "judged",
          verdict,
          confidence,
          claim: measuredClaim,
          callerContext,
          checks,
          measurements: m,
          ...(ledger ? { ledger } : {}),
          note:
            verdict === "PASS"
              ? visualJudgePassNote(confidence, record, app, ledger)
              : verdict === "FAIL"
                ? "Measured FAIL (a hard check failed). Diagnose + replan; do not record."
                : `Inconclusive (confidence ${confidence} below ${need} or a soft check is weak).${passthrough ? " Passthrough frame — count segmentation unreliable; escalated by design (pass expect.authoredColors — the spec's body.color palette — for the color-keyed MR lane)." : ""} ESCALATE to a human LOOK — do not auto-record.`,
        });
      } finally {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      }
    },
  );
}
