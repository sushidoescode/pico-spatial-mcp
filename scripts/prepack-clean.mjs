#!/usr/bin/env node
/**
 * prepack-clean — remove build droppings that would otherwise ride along in the published tarball.
 *
 * Why this exists rather than an .npmignore entry: when `files` is set in package.json it acts as an
 * allowlist, and a ROOT .npmignore is not consulted. A `files` entry of "tools" therefore packs
 * EVERYTHING under tools/, including any `__pycache__` Python left behind. That actually shipped
 * once, and the .pyc files embed the author's absolute path and username — a small privacy leak in
 * every tarball. Deleting the directories before packing is the reliable fix.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Only the directories that actually ship (package.json `files`), so we never touch anything else.
const SHIPPED = ["scripts", "tools", "briefs", "dist"];
const removed = [];

function sweep(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__pycache__") { fs.rmSync(p, { recursive: true, force: true }); removed.push(path.relative(root, p)); }
      else sweep(p);
    } else if (e.name.endsWith(".pyc")) {
      fs.rmSync(p, { force: true }); removed.push(path.relative(root, p));
    }
  }
}

for (const d of SHIPPED) sweep(path.join(root, d));
console.log(removed.length ? `prepack-clean: removed ${removed.length} artifact(s): ${removed.join(", ")}` : "prepack-clean: nothing to remove");
