import path from "node:path";
import { randomUUID } from "node:crypto";
import { picoCliObservationRoot } from "./picocli.js";

/**
 * capturepaths — where a capture goes when the caller did not say.
 *
 * The defect this exists to remove: every capture tool carried its own fixed default file
 * (`/tmp/pico-render/canonical.png`, `/tmp/pico-render/emulator_look.png`). The second capture
 * silently overwrote the first, so a frame an agent had already LOOKED at and cited could be
 * replaced by a later, unrelated one under the same name — and `record_verification`'s
 * byte-equality re-capture would then be comparing against bytes that had already moved. Two
 * agents capturing at once produced one file and two claims about it.
 *
 * A default capture is therefore RETAINED, not scratch: one run directory per capture, under the
 * same observation store `retainPicoCliObservation` and `capture_record` already write to, named
 * with the same sortable `<ISO instant without punctuation>-<uuid>` run id. An explicit `outPath`
 * still wins wherever a tool accepts one — this is only what happens when nobody chose.
 *
 * Naming a path creates nothing. The caller owns the write, and therefore owns the directory.
 */

/** The capture tools that have a default path. One subtree each, so a run directory names its producer. */
export type ObservationCaptureKind = "capture-frame" | "canonical" | "emulator-look";

/** `<observation root>/<kind>/<runId>/<fileName>` — unique per call, so no capture can overwrite another. */
export function observationCapturePath(kind: ObservationCaptureKind, fileName: string): string {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;
  return path.join(picoCliObservationRoot(), kind, runId, fileName);
}
