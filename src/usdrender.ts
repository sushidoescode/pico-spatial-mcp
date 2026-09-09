import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, expandHome } from "./util.js";
import { completeDependencies } from "./dependencies.js";
import { analyzeFrame, type FrameMeasurements } from "./eye.js";
import { readCaptureBytes, validateCapture, validateCaptureBuffer } from "./evidence.js";
import { appendUsdHostRenderEntry } from "./ledger.js";

/**
 * usdrender.ts — v7.4 OFF-DEVICE USD RENDERER (the C2-killer for USD-authored content).
 *
 * Renders a USD scene (a procedural asset, a generate_composition_scene, any .usd/.usda/.usdc/.usdz) to a
 * PNG on the Mac HOST via the installed `usdrecord` (Apple USD Tools) + Hydra Storm — deterministic, HD,
 * sub-second, NO emulator, NO build. It composes a lighting rig (dome + distant key light) around the
 * asset so the render is clean and even (usdrecord's default camera-light blows out flat faces). Records a
 * DISTINCT `usd_host_render` evidence class.
 *
 * THE SOUL CONSTRAINT (why this is a new class, never `vision_verified`): a Storm render is NOT the on-
 * device PICO Filament render — different renderer, materials, lighting. It verifies scene COMPOSITION /
 * geometry / layout / color deterministically (great for pre-checking a generated asset before the
 * expensive bake→build→emulator cycle), NOT device appearance. It is bucketed separately in every report
 * and NEVER upgraded to device vision_verified. It only covers USD-authored content (not Kotlin-built scenes).
 */

function usdrecordBin(): string {
  for (const c of ["/usr/bin/usdrecord", "/usr/local/bin/usdrecord", "usdrecord"]) {
    if (c === "usdrecord" || fs.existsSync(c)) return c;
  }
  return "usdrecord";
}

const MIN_NON_BLACK_COVERAGE = 0.02;

export type AcceptedUsdMeasurements = {
  objectCount: number;
  nonBlackCoverage: number;
  dominantColors: string[];
};

/** A renderer exit code and a decodable PNG are necessary but not sufficient. The host-render tier
 * represents measured scene content, so unavailable metrics, an empty component set, or an
 * effectively black frame fail closed. */
export function acceptUsdMeasurements(measurements: FrameMeasurements):
  | { ok: true; measured: AcceptedUsdMeasurements }
  | { ok: false; reason: string } {
  if (!measurements.available) return { ok: false, reason: `frame measurements unavailable: ${measurements.error ?? "unknown analyzer failure"}` };
  if (!Number.isInteger(measurements.objectCount) || (measurements.objectCount ?? 0) <= 0) {
    return { ok: false, reason: `measured zero foreground objects (objectCount=${measurements.objectCount ?? "unavailable"}); no nontrivial composition was established` };
  }
  if (!Number.isFinite(measurements.nonBlackCoverage) || measurements.nonBlackCoverage == null) {
    return { ok: false, reason: "non-black coverage was unavailable; no composition proof was measured" };
  }
  if (measurements.mostlyBlack !== false || measurements.nonBlackCoverage < MIN_NON_BLACK_COVERAGE) {
    return { ok: false, reason: `render is effectively black (nonBlackCoverage=${measurements.nonBlackCoverage}); no composition proof was measured` };
  }
  if (!Array.isArray(measurements.dominantColors) || measurements.dominantColors.length === 0) {
    return { ok: false, reason: "dominant colors were unavailable; no nontrivial measured content was established" };
  }
  return {
    ok: true,
    measured: {
      objectCount: measurements.objectCount!,
      nonBlackCoverage: measurements.nonBlackCoverage,
      dominantColors: measurements.dominantColors.slice(0, 8),
    },
  };
}

export function canonicalUsdRenderClaim(input: {
  assetSha256: string;
  outputSha256: string;
  objectCount: number;
  nonBlackCoverage: number;
  dominantColors: string[];
}): string {
  return `render_usd_offscreen measured composition: ${JSON.stringify(input)}`;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Build a render-rig USDA that references the asset and adds even dome+distant lighting. */
function renderRig(assetPath: string, domeIntensity: number, keyIntensity: number, keyRotXYZ: [number, number, number]): string {
  return [
    `#usda 1.0`,
    `(`,
    `    upAxis = "Y"`,
    `    defaultPrim = "Rig"`,
    `)`,
    `def Xform "Rig"`,
    `{`,
    `    def "Content" (`,
    `        references = @${assetPath}@`,
    `    )`,
    `    {`,
    `    }`,
    `    # A textureless DomeLight = uniform ambient fill (intentional; usdrecord warns "no texture asset path",`,
    `    # which is benign per the OpenUSD spec). For an equirect-lit world, add inputs:texture:file (format="latlong").`,
    `    def DomeLight "Dome"`,
    `    {`,
    `        float inputs:intensity = ${domeIntensity}`,
    `    }`,
    `    def DistantLight "Key"`,
    `    {`,
    `        float inputs:intensity = ${keyIntensity}`,
    `        float inputs:angle = 5`,
    `        double3 xformOp:rotateXYZ = (${keyRotXYZ[0]}, ${keyRotXYZ[1]}, ${keyRotXYZ[2]})`,
    `        uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

interface UsdRenderDependencies {
  runFn: typeof run;
  analyzeFrameFn: typeof analyzeFrame;
  appendUsdHostRenderEntryFn: typeof appendUsdHostRenderEntry;
  usdrecordBinFn: typeof usdrecordBin;
}

export function registerUsdRenderTools(server: McpServer, overrides: Partial<UsdRenderDependencies> = {}) {
  const deps = completeDependencies<UsdRenderDependencies>(
    "registerUsdRenderTools", overrides,
    { runFn: true, analyzeFrameFn: true, appendUsdHostRenderEntryFn: true, usdrecordBinFn: true },
    () => ({ runFn: run, analyzeFrameFn: analyzeFrame, appendUsdHostRenderEntryFn: appendUsdHostRenderEntry, usdrecordBinFn: usdrecordBin }),
  );
  server.registerTool(
    "render_usd_offscreen",
    {
      description:
        "Render a USD scene (.usd/.usda/.usdc/.usdz — a procedural asset, a composition, etc.) to a PNG OFF-DEVICE on the Mac host via usdrecord + Hydra Storm: deterministic, HD, sub-second, NO emulator, NO build. The requested output is published only after usdrecord exits 0, the fresh output is a validated raster, and the analyzer measures non-black, non-empty content. Returns the PNG path, a content sha256, and objective measurements (object count / colors / coverage). Optionally records a `usd_host_render` ledger entry whose canonical claim contains only those measured facts plus asset/output hashes. This DISTINCT evidence class is NOT the on-device Filament appearance and does not prove caller-authored semantic prose. Use it to PRE-CHECK a generated asset/composition fast, before the expensive bake→build→emulator cycle. (Meshes should be doubleSided or have correct outward normals, or backfaces render dark.)",
      inputSchema: {
        assetPath: z.string().describe("Path to the USD file (.usd/.usda/.usdc/.usdz)."),
        outPath: z.string().optional().describe("Output PNG path (default /tmp/usdrender/<name>.png)."),
        width: z.number().int().optional().describe("Image width px (default 800)."),
        complexity: z.enum(["low", "medium", "high", "veryhigh"]).optional().describe("Refinement (default high)."),
        domeIntensity: z.number().optional().describe("Dome (ambient) light intensity (default 450)."),
        keyIntensity: z.number().optional().describe("Distant key light intensity (default 700)."),
        keyRotation: z.array(z.number()).length(3).optional().describe("Key light euler rotation [x,y,z] deg (default [-40,30,0])."),
        camera: z.string().optional().describe("Camera prim path/name in the asset (default: usdrecord auto-frames the geometry)."),
        app: z.string().optional().describe("If set with record=true, records a `usd_host_render` ledger entry for this app."),
        claim: z.string().optional().describe("Caller-authored context for the render request. It is stored as explicitly unverified metadata; it never becomes the measured ledger claim."),
        record: z.boolean().optional().describe("Record a `usd_host_render` ledger entry (default false)."),
      },
    },
    async ({ assetPath, outPath, width, complexity, domeIntensity, keyIntensity, keyRotation, camera, app, claim, record }) => {
      const asset = expandHome(assetPath);
      if (!fs.existsSync(asset)) return fail(`asset not found: ${asset}`);
      let assetStat: fs.Stats;
      let assetSha256: string;
      try {
        assetStat = fs.statSync(asset);
        if (!assetStat.isFile()) return fail(`asset is not a regular file: ${asset}`);
        assetSha256 = sha256File(asset);
      } catch (error: any) {
        return fail(`asset could not be read: ${error?.message ?? String(error)}`);
      }
      const bin = deps.usdrecordBinFn();
      const out = expandHome(outPath ?? path.join(os.tmpdir(), "usdrender", `${path.basename(asset).replace(/\.[^.]+$/, "")}.png`));
      if (path.resolve(out) === path.resolve(asset)) return fail("outPath must not overwrite the source USD asset");
      if (record && !app) return okJson({
        status: "evidence_rejected",
        reason: "record=true requires app; render was not started and no composition proof was produced",
        compositionProof: { measuredAccepted: false, durable: false },
      });
      fs.mkdirSync(path.dirname(out), { recursive: true });

      // usdrecord never receives the caller-owned output path. A unique sibling gives every attempt
      // fresh bytes and lets a successful acceptance gate publish with one atomic rename.
      const freshOut = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.${crypto.randomUUID()}.tmp.png`);

      // Compose the render rig (absolute asset ref so it resolves from the temp dir).
      const rigDir = fs.mkdtempSync(path.join(os.tmpdir(), "usdrig-"));
      const rigPath = path.join(rigDir, "rig.usda");
      fs.writeFileSync(rigPath, renderRig(asset, domeIntensity ?? 450, keyIntensity ?? 700, (keyRotation as [number, number, number]) ?? [-40, 30, 0]));

      const args = ["--complexity", complexity ?? "high", "--imageWidth", String(width ?? 800), "--disableCameraLight"];
      if (camera) args.push("--camera", camera);
      args.push(rigPath, freshOut);
      try {
        const r = await deps.runFn(bin, args, { timeoutMs: 60_000, maxOutputBytes: 256 * 1024 });
        if (r.code !== 0 || r.timedOut) return okJson({
          status: "render_failed",
          reason: `usdrecord failed${r.timedOut ? " (timed out)" : ` with code ${r.code}`}: ${(r.stderr || r.stdout || "no diagnostic output").trim()}`.slice(0, 600),
          requestedPath: out,
          published: false,
          compositionProof: { measuredAccepted: false, durable: false },
          note: "No fresh measured output was accepted, so this attempt provides no composition proof.",
        });
        if (!fs.existsSync(freshOut)) return okJson({
          status: "render_rejected",
          reason: "usdrecord exited 0 but produced no fresh output image",
          requestedPath: out,
          published: false,
          compositionProof: { measuredAccepted: false, durable: false },
          note: "No fresh measured output was accepted, so this attempt provides no composition proof.",
        });

        const firstCapture = validateCapture(freshOut);
        if (!firstCapture.ok) return okJson({
          status: "render_rejected",
          reason: `usdrecord output failed raster validation: ${firstCapture.reason}`,
          requestedPath: out,
          published: false,
          compositionProof: { measuredAccepted: false, durable: false },
          note: "The output was not an accepted scene raster, so this attempt provides no composition proof.",
        });
        const measurements = await deps.analyzeFrameFn(freshOut).catch((error: any) => ({ available: false, error: error?.message ?? String(error) } as FrameMeasurements));
        const accepted = acceptUsdMeasurements(measurements);
        if (!accepted.ok) return okJson({
          status: "render_rejected",
          reason: accepted.reason,
          requestedPath: out,
          published: false,
          measurements,
          compositionProof: { measuredAccepted: false, durable: false },
          note: "The fresh raster did not pass the nontrivial-content measurements, so this attempt provides no composition proof.",
        });

        let assetShaAfter: string;
        try { assetShaAfter = sha256File(asset); }
        catch (error: any) {
          return okJson({
            status: "render_rejected",
            reason: `source asset became unreadable during rendering: ${error?.message ?? String(error)}`,
            requestedPath: out,
            published: false,
            measurements,
            compositionProof: { measuredAccepted: false, durable: false },
            note: "The render could not be bound to stable source bytes, so this attempt provides no composition proof.",
          });
        }
        if (assetShaAfter !== assetSha256) return okJson({
          status: "render_rejected",
          reason: `source asset changed during rendering (before ${assetSha256}, after ${assetShaAfter})`,
          requestedPath: out,
          published: false,
          measurements,
          compositionProof: { measuredAccepted: false, durable: false },
          note: "The render could not be bound to stable source bytes, so this attempt provides no composition proof.",
        });
        const finalRead = readCaptureBytes(freshOut);
        if (!finalRead.ok) return okJson({
          status: "render_rejected",
          reason: `fresh output became unreadable during measurement: ${finalRead.reason}`,
          requestedPath: out,
          published: false,
          measurements,
          compositionProof: { measuredAccepted: false, durable: false },
          note: "The measurements could not be bound to stable output bytes, so this attempt provides no composition proof.",
        });
        const finalCapture = validateCaptureBuffer(finalRead.bytes, freshOut);
        if (!finalCapture.ok || finalCapture.sha256 !== firstCapture.sha256) return okJson({
          status: "render_rejected",
          reason: finalCapture.ok
            ? `fresh output changed during measurement (before ${firstCapture.sha256}, after ${finalCapture.sha256})`
            : `fresh output became invalid during measurement: ${finalCapture.reason}`,
          requestedPath: out,
          published: false,
          measurements,
          compositionProof: { measuredAccepted: false, durable: false },
          note: "The measurements could not be bound to stable output bytes, so this attempt provides no composition proof.",
        });
        const outputSha256 = finalCapture.sha256!;

        try {
          const fd = fs.openSync(freshOut, "r");
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(freshOut, out);
        } catch (error: any) {
          return okJson({
            status: "render_rejected",
            reason: `validated output could not be atomically published: ${error?.message ?? String(error)}`,
            requestedPath: out,
            published: false,
            measurements,
            compositionProof: { measuredAccepted: false, durable: false },
            note: "The requested output was not published, so this attempt provides no composition proof.",
          });
        }

        const callerContext = { text: claim ?? "", verified: false as const };
        const usdRender = {
          schemaVersion: 1 as const,
          assetSha256,
          outputSha256,
          ...accepted.measured,
          callerContext,
        };
        const measuredClaim = canonicalUsdRenderClaim({
          assetSha256: usdRender.assetSha256,
          outputSha256: usdRender.outputSha256,
          objectCount: usdRender.objectCount,
          nonBlackCoverage: usdRender.nonBlackCoverage,
          dominantColors: usdRender.dominantColors,
        });
        const attestation = `off-device Storm output passed the raster and nontrivial-content gates: ${JSON.stringify({
          objectCount: usdRender.objectCount,
          nonBlackCoverage: usdRender.nonBlackCoverage,
          dominantColors: usdRender.dominantColors,
        })}`;

        let ledger: any;
        if (record && app) {
          try {
            ledger = deps.appendUsdHostRenderEntryFn(app, {
              claim: measuredClaim,
              artifactPath: out,
              artifactBytes: finalRead.bytes,
              attestation,
              usdRender,
            });
          } catch (error: any) {
            ledger = { status: "rejected", reason: error?.message ?? String(error) };
          }
        }
        const common = {
          path: out,
          sha256: outputSha256,
          bytes: finalCapture.bytes,
          claim: measuredClaim,
          callerContext,
          measurements,
          ...(ledger ? { ledger } : {}),
        };
        if (ledger && ledger.status !== "recorded") return okJson({
          status: "evidence_rejected",
          ...common,
          compositionProof: { measuredAccepted: true, durable: false },
          note: `The fresh Storm raster passed objective content measurements, but the ledger did not record it (${ledger.reason ?? `status ${ledger.status}`}). No durable usd_host_render composition proof exists.`,
        });
        return okJson({
          status: "rendered",
          ...common,
          compositionProof: { measuredAccepted: true, durable: ledger?.status === "recorded" },
          note: `OFF-DEVICE Storm output passed the raster + nontrivial-content gates${ledger?.status === "recorded" ? " and was recorded as durable usd_host_render evidence" : "; it was not recorded to a ledger"}. The measurements establish object count, coverage, and colors for these exact asset/output hashes — not caller-authored semantics and NOT on-device Filament appearance.`,
        });
      } finally {
        try { fs.rmSync(rigDir, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(freshOut, { force: true }); } catch {}
      }
    },
  );
}
