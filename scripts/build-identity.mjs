/**
 * build-identity — the digest that binds published `dist/` bytes to the source that produced them.
 *
 * Tests import `../dist/*.js` and nothing rebuilds it, so a stale `dist/` silently passes suites that
 * never saw the edit. The fix is an identity: every successful build writes `dist/build-receipt.json`
 * recording what it compiled FROM (`inputIdentity`) and what it emitted, and `verifyBuild` recomputes
 * both. A receipt is deliberately portable — no timestamps, no absolute paths, no hostnames — so the
 * same source, toolchain and Node major produce the same digest on any machine.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IDENTITY_SCHEMA_VERSION = 1;
export const RECEIPT_NAME = "build-receipt.json";

/** Hashed alongside the sources. `src/`-relative paths and these three root files can never collide
 *  with a `toolchain:` key, so the namespace stays unambiguous without escaping. */
const TYPESCRIPT_KEY = "toolchain:typescript";
const NODE_MAJOR_KEY = "toolchain:node-major";
const ROOT_INPUTS = ["package-lock.json", "package.json", "tsconfig.json"];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** One digest over `<path>\0<sha256>\n` lines, so both a renamed file and a changed byte move it. */
function digestFiles(files) {
  const material = files.map(({ path: filePath, sha256: hash }) => `${filePath}\0${hash}\n`).join("");
  return sha256(material);
}

function sortFiles(files) {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Every regular file under `dir`, as `/`-separated paths relative to it. Sorted by the caller. */
function listFilesRecursive(dir, filter = () => true, prefix = "") {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFilesRecursive(path.join(dir, entry.name), filter, relativePath));
    else if (entry.isFile() && filter(relativePath)) found.push(relativePath);
  }
  return found;
}

/** The TypeScript actually installed in this checkout, or null when none is. */
export function installedTypeScriptVersion(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "typescript", "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

export function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

/**
 * Everything the compiler reads plus the toolchain that reads it: every `.ts` file under `src/`, the
 * three root config files, the installed TypeScript version and this Node major.
 */
export function inputIdentity(root) {
  const checkout = path.resolve(root);
  const files = [
    { path: TYPESCRIPT_KEY, sha256: sha256(installedTypeScriptVersion(checkout) ?? "") },
    { path: NODE_MAJOR_KEY, sha256: sha256(String(nodeMajor())) },
  ];
  for (const name of ROOT_INPUTS) {
    const target = path.join(checkout, name);
    if (fs.existsSync(target)) files.push({ path: name, sha256: sha256(fs.readFileSync(target)) });
  }
  for (const relativePath of listFilesRecursive(path.join(checkout, "src"), (name) => name.endsWith(".ts"))) {
    files.push({ path: `src/${relativePath}`, sha256: sha256(fs.readFileSync(path.join(checkout, "src", ...relativePath.split("/")))) });
  }
  const sorted = sortFiles(files);
  return { schemaVersion: IDENTITY_SCHEMA_VERSION, sha256: digestFiles(sorted), files: sorted };
}

/** The emitted tree, receipt excluded — a receipt can never be part of its own output digest. */
export function outputIdentity(outDir) {
  const files = sortFiles(
    listFilesRecursive(outDir, (relativePath) => relativePath !== RECEIPT_NAME).map((relativePath) => ({
      path: relativePath,
      sha256: sha256(fs.readFileSync(path.join(outDir, ...relativePath.split("/")))),
    })),
  );
  return { sha256: digestFiles(files), files };
}

export function buildReceipt(root, outDir, identity = inputIdentity(root)) {
  const output = outputIdentity(outDir);
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    input: { sha256: identity.sha256, files: identity.files },
    output,
    typescript: installedTypeScriptVersion(path.resolve(root)),
    nodeMajor: nodeMajor(),
  };
}

export function writeReceipt(root, outDir, identity = inputIdentity(root)) {
  const receipt = buildReceipt(root, outDir, identity);
  fs.writeFileSync(path.join(outDir, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function readReceipt(distDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(distDir, RECEIPT_NAME), "utf8"); }
  catch (error) {
    return { reason: `dist/${RECEIPT_NAME} is unreadable (${error.code ?? error.message}); this output was not published by scripts/build-source.mjs` };
  }
  let receipt;
  try { receipt = JSON.parse(raw); }
  catch (error) { return { reason: `dist/${RECEIPT_NAME} is unparsable: ${error.message}` }; }
  if (!receipt || typeof receipt !== "object" || receipt.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    return { reason: `dist/${RECEIPT_NAME} carries schemaVersion ${receipt?.schemaVersion} instead of ${IDENTITY_SCHEMA_VERSION}` };
  }
  if (typeof receipt.input?.sha256 !== "string" || !Array.isArray(receipt.output?.files) || typeof receipt.output?.sha256 !== "string") {
    return { reason: `dist/${RECEIPT_NAME} is missing its input or output identity` };
  }
  return { receipt };
}

/**
 * Is `dist/` the output of the source that is on disk right now? Never throws: every failure is a
 * reason, and an empty reason list is the only thing that makes `current` true.
 */
export function verifyBuild(root) {
  const checkout = path.resolve(root);
  const distDir = path.join(checkout, "dist");
  const reasons = [];

  if (!fs.existsSync(distDir)) return { current: false, reasons: ["dist/ does not exist; run npm run build"] };

  const { receipt, reason } = readReceipt(distDir);
  if (!receipt) return { current: false, reasons: [reason] };

  let identity;
  try { identity = inputIdentity(checkout); }
  catch (error) { return { current: false, reasons: [`the source identity could not be recomputed: ${error.message}`] }; }
  if (identity.sha256 !== receipt.input.sha256) {
    reasons.push(`the source input identity changed since the build (${receipt.input.sha256.slice(0, 12)} -> ${identity.sha256.slice(0, 12)})`);
  }

  const listed = new Set();
  const rehashed = [];
  for (const entry of receipt.output.files) {
    // A receipt is untrusted input: it may only ever name files inside the tree it describes.
    if (typeof entry?.path !== "string" || typeof entry?.sha256 !== "string"
      || path.isAbsolute(entry.path) || entry.path.split("/").includes("..")) {
      reasons.push(`dist/${RECEIPT_NAME} lists a malformed output entry`);
      continue;
    }
    listed.add(entry.path);
    const target = path.join(distDir, ...entry.path.split("/"));
    let bytes;
    try { bytes = fs.readFileSync(target); }
    catch { reasons.push(`dist/${entry.path} is missing but the receipt lists it`); continue; }
    const hash = sha256(bytes);
    rehashed.push({ path: entry.path, sha256: hash });
    if (hash !== entry.sha256) reasons.push(`dist/${entry.path} does not match the bytes this build emitted`);
  }

  for (const relativePath of listFilesRecursive(distDir, (name) => name.endsWith(".js"))) {
    if (!listed.has(relativePath)) reasons.push(`dist/${relativePath} is an orphan: no build emitted it`);
  }

  if (!reasons.length && digestFiles(sortFiles(rehashed)) !== receipt.output.sha256) {
    reasons.push(`dist/${RECEIPT_NAME} records an output digest that its own file list does not produce`);
  }

  return { current: reasons.length === 0, reasons };
}
