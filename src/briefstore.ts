import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * briefstore.ts — where briefs live. There are TWO stores, and conflating them caused a real bug.
 *
 * The CORPUS ships inside the package and is READ-ONLY. It is the scored conformance suite that
 * run_brief_suite, run_spatialbench and regression_gate measure against, so nothing generated at
 * runtime may enter it: a user's own app showing up as an extra scored row silently changes the
 * benchmark they were asked to trust.
 *
 * The USER STORE lives under the user's home, outside the package. pico_build_app writes here.
 * It used to write into the package's briefs/ directory, which in an installed package is inside
 * node_modules. That had three consequences, all of which a tester would have hit: it contaminated
 * the corpus as above; `npm install` of the next tarball wiped every generated brief, so a briefId
 * the tool had just handed back later resolved to "brief not found" — reading like bad input rather
 * than a discarded write; and on a root-owned prefix or read-only image the write threw EACCES and
 * killed the tool on its first call.
 *
 * This is the same reasoning gate.ts records for regression_gate's goldens; the rule is simply that
 * nothing writes into its own installed package.
 */

export function corpusBriefsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "briefs");
}

export function userBriefsDir(): string {
  return path.join(os.homedir(), ".pico-mcp", "briefs");
}

/** Resolve a brief id across both stores, user-generated winning ties. Null when it exists in neither. */
export function findBriefPath(id: string): string | null {
  for (const dir of [userBriefsDir(), corpusBriefsDir()]) {
    const p = path.join(dir, `${id}.json`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Write a generated brief to the user store, creating the directory on demand. Returns the path. */
export function writeUserBrief(id: string, payload: unknown): string {
  const dir = userBriefsDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  return p;
}
