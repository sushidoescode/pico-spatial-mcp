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
/** Local, gitignored, and never packaged: it describes one machine's node_modules, nothing shared. */
export const DEPENDENCY_RECEIPT_NAME = ".pico-dependencies.json";
/** npm's own record of the tree it laid down, written by every `npm ci` and `npm install`. */
export const HIDDEN_LOCKFILE_SEGMENTS = ["node_modules", ".package-lock.json"];
const HIDDEN_LOCKFILE_NAME = HIDDEN_LOCKFILE_SEGMENTS.join("/");

/** What proved an install THIS time. */
export const ACCEPTED_BY = Object.freeze({ receipt: "receipt", hiddenLockfile: "hidden-lockfile" });
/** What a receipt records as the evidence that produced it. */
export const RECORDED_SOURCE = Object.freeze({ npmCi: "npm-ci", hiddenLockfile: "hidden-lockfile" });
const KNOWN_SOURCES = new Set(Object.values(RECORDED_SOURCE));

/**
 * The fields that say WHICH artifact is installed. Everything else a lockfile entry carries —
 * license, engines, bin, funding, dependency ranges — describes the package rather than identifying
 * what landed on disk, and npm is free to record it in one file and not the other.
 */
const RESOLUTION_FIELDS = ["version", "resolved", "integrity", "dev", "optional"];

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

/**
 * What `npm ci` was last asked to reproduce: the lockfile bytes plus the Node major that ran it.
 * Node major belongs here for the same reason it belongs in `inputIdentity` — npm resolves optional
 * and native dependencies against it, so the same lockfile installs differently across majors.
 *
 * Schema (`schemaVersion: 1`, recorded in the receipt): sha256 over sorted `<key>\0<sha256>\n`
 * lines for `package-lock.json` and `toolchain:node-major` — the material formula `inputIdentity`
 * uses. Deliberately NOT a walk of `node_modules`: hashing a 200 MB tree on every host start is the
 * cost this whole file exists to avoid, and the lockfile is the thing `npm ci` is contracted to.
 *
 * Returns null when there is no readable lockfile, because there is then nothing to be current
 * against — and an install nobody can account for must never be reported as current.
 */
export function dependencyIdentity(root) {
  const checkout = path.resolve(root);
  let lockBytes;
  try { lockBytes = fs.readFileSync(path.join(checkout, "package-lock.json")); } catch { return null; }
  return digestFiles(sortFiles([
    { path: "package-lock.json", sha256: sha256(lockBytes) },
    { path: NODE_MAJOR_KEY, sha256: sha256(String(nodeMajor())) },
  ]));
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.length > 0 && value.every((token) => typeof token === "string");

export function dependencyReceipt(root, { npmArgv, identity = dependencyIdentity(root), source = RECORDED_SOURCE.npmCi }) {
  // `nodeMajor` is recorded even though `dependencyIdentity` already folds it in, because the
  // identity is a digest: once it fails to match, it can no longer say WHY. A receipt that names
  // its Node major can, and that difference is what stops npm's record from being read as
  // evidence about a major it knows nothing about (see verifyDependencies).
  const receipt = { schemaVersion: IDENTITY_SCHEMA_VERSION, dependencyIdentity: identity, source, nodeMajor: nodeMajor() };
  // Only our own install can name the command that produced it; adopting npm's record must not
  // claim one. An empty or invented argv would be a worse record than no argv at all.
  if (source === RECORDED_SOURCE.npmCi) receipt.npmArgv = [...npmArgv];
  return receipt;
}

/**
 * Record a dependency install. The caller must already have checked that the install succeeded and
 * that the lockfile still hashes to `identity` — this is the publication step, not the proof.
 */
export function writeDependencyReceipt(root, options) {
  const checkout = path.resolve(root);
  if (!KNOWN_SOURCES.has(options.source ?? RECORDED_SOURCE.npmCi)) {
    throw new Error(`refusing to record ${JSON.stringify(options.source)} as the evidence for an install in ${checkout}`);
  }
  if ((options.source ?? RECORDED_SOURCE.npmCi) === RECORDED_SOURCE.npmCi && !isStringList(options.npmArgv)) {
    throw new Error(`refusing to record an ${RECORDED_SOURCE.npmCi} install in ${checkout} without the command that produced it`);
  }
  const receipt = dependencyReceipt(checkout, options);
  if (typeof receipt.dependencyIdentity !== "string") {
    throw new Error(`refusing to record a dependency install with no readable package-lock.json in ${checkout}`);
  }
  fs.writeFileSync(path.join(checkout, DEPENDENCY_RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function readJsonFile(target) {
  try { return { value: JSON.parse(fs.readFileSync(target, "utf8")) }; }
  catch (error) { return { error }; }
}

/** Do two lockfile entries name the same installed artifact? Returns a reason, or null when they do. */
function resolutionMismatch(wanted, installed, key) {
  if (!isPlainObject(wanted) || !isPlainObject(installed)) {
    return `${HIDDEN_LOCKFILE_NAME} and package-lock.json disagree on the shape of ${key}`;
  }
  for (const field of RESOLUTION_FIELDS) {
    const inWanted = Object.hasOwn(wanted, field);
    const inInstalled = Object.hasOwn(installed, field);
    if (inWanted !== inInstalled) {
      return `${HIDDEN_LOCKFILE_NAME} and package-lock.json disagree on ${key}: ${field} is recorded in only one of them`;
    }
    if (inWanted && wanted[field] !== installed[field]) {
      return `${HIDDEN_LOCKFILE_NAME} records ${key} ${field} ${JSON.stringify(installed[field])} against package-lock.json's ${JSON.stringify(wanted[field])}`;
    }
  }
  return null;
}

/**
 * Does npm's own record of the installed tree still describe the lockfile on disk?
 *
 * `npm ci` and `npm install` write `node_modules/.package-lock.json` — the tree they actually laid
 * down. When it still matches `package-lock.json`, the dependencies ARE accounted for, by the tool
 * that installed them, and re-running `npm ci` would spend a network round trip to learn what is
 * already true. Without this, every pre-existing cache and every developer checkout is forced
 * through a full install on its next start, and an offline host cannot start at all.
 *
 * The comparison is deliberately narrow and purely local: the same `lockfileVersion`, the same set
 * of entries (npm omits the root `""` entry from its own record, so it is excluded from both), and
 * per entry only the fields that identify the installed artifact. Anything it cannot read, parse or
 * line up is not evidence of anything, and says so.
 */
export function matchesHiddenLockfile(root) {
  const checkout = path.resolve(root);

  const installedTree = readJsonFile(path.join(checkout, ...HIDDEN_LOCKFILE_SEGMENTS));
  if (installedTree.error) {
    return { matches: false, reasons: [installedTree.error.code === "ENOENT"
      ? `npm has no record of this tree either (${HIDDEN_LOCKFILE_NAME} does not exist)`
      : `${HIDDEN_LOCKFILE_NAME} could not be read: ${installedTree.error.code ?? installedTree.error.message}`] };
  }
  const lockfile = readJsonFile(path.join(checkout, "package-lock.json"));
  if (lockfile.error) {
    return { matches: false, reasons: [`package-lock.json could not be read: ${lockfile.error.code ?? lockfile.error.message}`] };
  }

  if (lockfile.value?.lockfileVersion !== installedTree.value?.lockfileVersion) {
    return { matches: false, reasons: [`${HIDDEN_LOCKFILE_NAME} records lockfileVersion ${JSON.stringify(installedTree.value?.lockfileVersion)} against package-lock.json's ${JSON.stringify(lockfile.value?.lockfileVersion)}`] };
  }
  const wanted = lockfile.value?.packages;
  const installed = installedTree.value?.packages;
  if (!isPlainObject(wanted) || !isPlainObject(installed)) {
    return { matches: false, reasons: [`${HIDDEN_LOCKFILE_NAME} or package-lock.json has no packages map to compare`] };
  }

  const wantedKeys = Object.keys(wanted).filter((key) => key !== "");
  for (const key of Object.keys(installed)) {
    if (key === "") continue;
    if (!Object.hasOwn(wanted, key)) {
      return { matches: false, reasons: [`${HIDDEN_LOCKFILE_NAME} lists ${key}, which package-lock.json does not`] };
    }
  }
  for (const key of wantedKeys) {
    if (!Object.hasOwn(installed, key)) {
      return { matches: false, reasons: [`${HIDDEN_LOCKFILE_NAME} does not list ${key}`] };
    }
    const reason = resolutionMismatch(wanted[key], installed[key], key);
    if (reason) return { matches: false, reasons: [reason] };
  }
  return { matches: true, reasons: [] };
}

/**
 * `{current, reasons[]}` plus the evidence, from a receipt alone.
 *
 * Also reports `present` (a receipt EXISTS here, whether or not it could be read or parsed), the
 * `nodeMajor` it records and the `source` it claims, so `verifyDependencies` can decide whether
 * npm's own record is allowed to speak for this tree. `nodeMajor` is null whenever the file could
 * not be read far enough to carry one — a recorded install of unknown provenance, which is not the
 * same thing as no install. Only ENOENT is "no install was ever recorded here": an EACCES or EISDIR
 * receipt demonstrably exists, and reporting it as absent is what let an unreadable receipt hand a
 * cross-major tree to npm's record.
 */
function receiptVerdict(checkout, identity) {
  const unusable = (reason, extra = {}) => ({ current: false, reasons: [reason], present: true, nodeMajor: null, source: null, ...extra });
  let raw;
  try { raw = fs.readFileSync(path.join(checkout, DEPENDENCY_RECEIPT_NAME), "utf8"); }
  catch (error) {
    // ENOENT is the only absence. Every other failure — EACCES, EISDIR, EIO — is a receipt that is
    // here and that we cannot account for, which is unknown provenance, not a clean slate.
    return { current: false, present: error.code !== "ENOENT", nodeMajor: null, source: null, reasons: [error.code === "ENOENT"
      ? `no install has been recorded here yet (${DEPENDENCY_RECEIPT_NAME} does not exist)`
      : `${DEPENDENCY_RECEIPT_NAME} is unreadable (${error.code ?? error.message})`] };
  }
  let receipt;
  try { receipt = JSON.parse(raw); }
  catch (error) { return unusable(`${DEPENDENCY_RECEIPT_NAME} is unparsable: ${error.message}`); }
  if (!isPlainObject(receipt) || receipt.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    return unusable(`${DEPENDENCY_RECEIPT_NAME} carries schemaVersion ${receipt?.schemaVersion} instead of ${IDENTITY_SCHEMA_VERSION}`);
  }
  // A receipt written before this file recorded its evidence can only have come from our own
  // install; one written before it recorded a Node major cannot say which major that was.
  const source = receipt.source ?? RECORDED_SOURCE.npmCi;
  const recorded = typeof receipt.nodeMajor === "number" && Number.isInteger(receipt.nodeMajor) ? receipt.nodeMajor : null;
  const evidence = { present: true, nodeMajor: recorded, source: KNOWN_SOURCES.has(source) ? source : null };
  if (!KNOWN_SOURCES.has(source)) {
    return unusable(`${DEPENDENCY_RECEIPT_NAME} names ${JSON.stringify(source)} as the evidence for this install, which this build does not know`, { nodeMajor: recorded });
  }
  if (typeof receipt.dependencyIdentity !== "string"
    || (source === RECORDED_SOURCE.npmCi && !isStringList(receipt.npmArgv))) {
    return { current: false, reasons: [`${DEPENDENCY_RECEIPT_NAME} is missing its dependency identity or the command that produced it`], ...evidence };
  }
  if (receipt.dependencyIdentity !== identity) {
    return { current: false, reasons: [`package-lock.json changed since the install (${receipt.dependencyIdentity.slice(0, 12)} -> ${identity.slice(0, 12)})`], ...evidence };
  }
  return { current: true, reasons: [], ...evidence };
}

/**
 * Why a recorded install cannot be handed to npm's record for a second opinion.
 *
 * `npm ci` resolves optional and native dependencies against the running Node major, so the same
 * lockfile lays down different trees on different majors. `node_modules/.package-lock.json` records
 * WHICH artifacts were installed and never which runtime installed them — so it can agree with
 * `package-lock.json` down to the last integrity hash and still be describing a tree this Node
 * cannot use. A receipt that names its major is the only thing that can tell the two apart.
 */
function crossMajorReason(recordedMajor) {
  const cannotVouch = "the hidden lockfile cannot vouch for native or optional dependencies across majors, so this install is reinstalled";
  // `null` covers every way a receipt can be here and still not say which major installed the tree:
  // the pre-change shape that has no such field, and one that is unreadable, unparsable or written
  // to a schema this build does not know.
  return recordedMajor === null
    ? `the Node major of the recorded install could not be read from ${DEPENDENCY_RECEIPT_NAME}, so its provenance is unknown; ${cannotVouch}`
    : `installed under Node ${recordedMajor}, running Node ${nodeMajor()}; ${cannotVouch}`;
}

/**
 * Do the installed dependencies still answer to the lockfile on disk? Never throws.
 *
 * Two things can answer yes. Our own receipt is the cheap one and the only one a warm start pays
 * for. Failing that, npm's own record of the install is consulted — a tree npm vouches for is
 * accounted for, even though we did not lay it down. Only when neither can speak is the tree
 * unknown, and unknown is never current: the caller reinstalls once rather than trusting it.
 *
 * `acceptedBy` says which of the two carried it, so a caller can record npm's evidence as its own
 * and make the next start receipt-fast. `provenance` says what that evidence actually WAS — an
 * adopted receipt stays receipt-fast forever, and must never start reporting itself as an `npm-ci`
 * install this bootstrap performed.
 *
 * One thing npm's record may never answer for: a tree installed under a different Node major. Once
 * a receipt is present and cannot vouch for THIS major, the hidden lockfile is not consulted at all
 * — it would agree, and agreeing about the wrong runtime is how unknown provenance gets laundered
 * into a verified-looking install identity.
 */
export function verifyDependencies(root) {
  const checkout = path.resolve(root);
  const unaccounted = (reasons, identity = null) => ({ current: false, acceptedBy: null, provenance: null, identity, reasons });

  if (!fs.existsSync(path.join(checkout, "node_modules"))) {
    return unaccounted(["node_modules/ does not exist; dependencies were never installed here"]);
  }

  const identity = dependencyIdentity(checkout);
  if (identity === null) {
    return unaccounted(["package-lock.json is unreadable, so the installed dependencies cannot be checked against it"]);
  }

  const receipt = receiptVerdict(checkout, identity);
  // A current receipt is same-major by construction: `dependencyIdentity` folds the Node major in,
  // so an identity that still matches could not have been written under another one.
  if (receipt.current) return { current: true, acceptedBy: ACCEPTED_BY.receipt, provenance: receipt.source, identity, reasons: [] };

  if (receipt.present && receipt.nodeMajor !== nodeMajor()) {
    return unaccounted([...receipt.reasons, crossMajorReason(receipt.nodeMajor)], identity);
  }

  const npm = matchesHiddenLockfile(checkout);
  if (npm.matches) {
    return { current: true, acceptedBy: ACCEPTED_BY.hiddenLockfile, provenance: RECORDED_SOURCE.hiddenLockfile, identity, reasons: [] };
  }

  return unaccounted([...receipt.reasons, ...npm.reasons], identity);
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

/** Every way the bytes in `outDir` can fail to be the ones `receipt` says were emitted. */
function emittedByteReasons(distDir, receipt) {
  const reasons = [];
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
  return reasons;
}

/**
 * Are the bytes in `dist/` the ones the receipt beside them records — output half only?
 *
 * This is the question an installed package can actually answer. A tarball ships `dist/` and
 * `scripts/` and nothing else: no `src/`, no `tsconfig.json`, no lockfile, so `inputIdentity` there
 * describes an empty checkout and `verifyBuild` is permanently `current:false`. Reading that as
 * "stale, rebuild" would be a lie twice over — there is no source to compile and no compiler to
 * compile it with. So a consumer checks only what shipped against what the publisher recorded.
 */
export function verifyEmittedOutput(root) {
  const distDir = path.join(path.resolve(root), "dist");
  if (!fs.existsSync(distDir)) return { current: false, reasons: ["dist/ does not exist; this installed payload is incomplete"] };

  const { receipt, reason } = readReceipt(distDir);
  if (!receipt) return { current: false, reasons: [reason] };

  const reasons = emittedByteReasons(distDir, receipt);
  return { current: reasons.length === 0, reasons };
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

  reasons.push(...emittedByteReasons(distDir, receipt));
  return { current: reasons.length === 0, reasons };
}
