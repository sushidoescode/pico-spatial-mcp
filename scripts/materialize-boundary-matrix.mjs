#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBoundaryMatrix } from "../dist/boundarymatrix.js";
import { writeUserBrief } from "../dist/briefstore.js";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

/**
 * Materialize the pure matched matrix through the ordinary user-store writer. Tests inject a writer
 * and therefore never touch ~/.pico-mcp; the CLI path intentionally uses the production store.
 */
export function materializeBoundaryMatrix({
  canonicalBriefPath = path.join(repoRoot, "briefs", "boundarylabmixed.json"),
  writeBrief = writeUserBrief,
} = {}) {
  const canonical = JSON.parse(fs.readFileSync(canonicalBriefPath, "utf8"));
  return buildBoundaryMatrix(canonical).map((candidate) => ({
    id: candidate.id,
    variant: candidate.variant,
    packageName: candidate.packageName,
    effectiveSpecIdentity: candidate.effectiveSpecIdentity,
    path: writeBrief(candidate.id, candidate.entry),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.stdout.write(`${JSON.stringify({ status: "ok", rows: materializeBoundaryMatrix() }, null, 2)}\n`);
}
