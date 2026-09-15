/**
 * verify-sdk-compatibility-payload.mjs — the installed-payload canary for Task S6.
 *
 * `data/sdk-compatibility/` is resolved by `dist/declarationcontext.js` from its OWN module URL,
 * so an installed package that ships `dist/` without that directory degrades silently: the
 * reviewed index reads as `index-missing`, every SDK lookup stays historical, and nothing in the
 * build output says why. This canary is what an installed-tarball gate runs against the extracted
 * package so that failure is loud.
 *
 * It answers about the root it is HANDED. `packageRoot` must be absolute, every path is derived
 * from it, and nothing here consults the working directory, an environment variable or this
 * script's own location — a canary that resolved its data from the checkout it lives in would
 * cheerfully certify an extracted package whose data never shipped. It is pure `node:fs` +
 * `node:crypto`: no process is started, no network is opened and nothing is written.
 *
 * What it checks, in one pass:
 *   1. `<packageRoot>/data/sdk-compatibility/index.v1.json` exists and is a v1 reviewed index.
 *   2. every file the index references — reviewed records AND historical basis snapshots — is
 *      present and hashes to exactly its indexed sha256, inside the data directory.
 *   3. every reviewed record parses and cites only basis snapshots the index declares at the same
 *      hash, so the transitively required basis really shipped with the record that needs it.
 *
 * An EMPTY `records` list is valid — no complete reviewed mapping exists yet. A missing index, or
 * a declared historical basis that is absent or altered, is not.
 *
 * @typedef {{ path: string, sha256: string }} FileIdentity  package-relative posix path + digest
 * @returns {{ ok: boolean, checked: FileIdentity[], errors: string[] }}
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_SEGMENTS = ["data", "sdk-compatibility"];
const DATA_REL = DATA_SEGMENTS.join("/");
const INDEX_NAME = "index.v1.json";
const SHA256_HEX = /^[0-9a-f]{64}$/;

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const toPosix = (value) => value.split(path.sep).join("/");

/** A relative path that stays inside the data directory: no root, no `..`, no backslashes. */
function boundedRelativePath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function readFileBytes(target) {
  try {
    return fs.statSync(target).isFile() ? fs.readFileSync(target) : null;
  } catch {
    return null;
  }
}

/** `{path, sha256}[]`, or a string describing the first structural problem. */
function fileIdentityList(value, field) {
  if (!Array.isArray(value)) return `${field} must be an array of {path, sha256}`;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return `${field}[${i}] must be {path, sha256}`;
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "path,sha256") return `${field}[${i}] must have exactly the fields path and sha256 (got ${keys || "none"})`;
    if (!boundedRelativePath(entry.path)) return `${field}[${i}].path must be a relative path inside ${DATA_REL} (got ${JSON.stringify(entry.path)})`;
    if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) return `${field}[${i}].sha256 must be 64 lowercase hex characters`;
    if (seen.has(entry.path)) return `${field}[${i}].path ${entry.path} is listed twice`;
    seen.add(entry.path);
    out.push({ path: entry.path, sha256: entry.sha256 });
  }
  return out;
}

export function verifySdkCompatibilityPayload(packageRoot) {
  const errors = [];
  const checked = [];
  const fail = () => ({ ok: false, checked, errors });

  if (typeof packageRoot !== "string" || packageRoot.trim() === "") {
    errors.push(`packageRoot must be a non-empty absolute path to the installed package (got ${JSON.stringify(packageRoot)})`);
    return fail();
  }
  const root = path.normalize(packageRoot.trim());
  if (!path.isAbsolute(root)) {
    errors.push(`packageRoot ${JSON.stringify(packageRoot)} must be an absolute path; this canary never resolves a root against the working directory`);
    return fail();
  }

  const dataDir = path.join(root, ...DATA_SEGMENTS);
  const indexPath = path.join(dataDir, INDEX_NAME);
  const indexBytes = readFileBytes(indexPath);
  if (!indexBytes) {
    errors.push(`reviewed index ${indexPath} is absent or unreadable; the installed package must ship ${DATA_REL}/${INDEX_NAME}`);
    return fail();
  }

  let parsed;
  try {
    parsed = JSON.parse(indexBytes.toString("utf8"));
  } catch (error) {
    errors.push(`reviewed index ${indexPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return fail();
  }
  const schema = (detail) => {
    errors.push(`reviewed index ${indexPath}: ${detail}`);
    return fail();
  };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return schema("must be a JSON object");
  if (parsed.schemaVersion !== 1) return schema(`schemaVersion ${JSON.stringify(parsed.schemaVersion)} is not a supported index schema (expected 1)`);
  const unexpected = Object.keys(parsed).filter((key) => !["schemaVersion", "records", "historicalReferences"].includes(key));
  if (unexpected.length) return schema(`unexpected field ${unexpected.map((k) => JSON.stringify(k)).join(", ")}`);
  const records = fileIdentityList(parsed.records, "records");
  if (typeof records === "string") return schema(records);
  const historicalReferences = fileIdentityList(parsed.historicalReferences, "historicalReferences");
  if (typeof historicalReferences === "string") return schema(historicalReferences);
  const overlap = records.filter((r) => historicalReferences.some((h) => h.path === r.path));
  if (overlap.length) return schema(`${overlap[0].path} is listed both as a record and as a historical reference`);

  checked.push({ path: `${DATA_REL}/${INDEX_NAME}`, sha256: sha256(indexBytes) });

  // The data directory's canonical location, so a referenced file cannot resolve outside it.
  let canonicalDataDir = dataDir;
  try {
    canonicalDataDir = fs.realpathSync(dataDir);
  } catch {
    /* the index read above already proved the directory is reachable; keep the plain spelling */
  }

  /** Verified bytes per indexed path, so the record pass can reuse them. */
  const verified = new Map();
  for (const entry of [...historicalReferences, ...records].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const abs = path.join(dataDir, ...entry.path.split("/"));
    const bytes = readFileBytes(abs);
    if (!bytes) {
      errors.push(`reviewed file ${DATA_REL}/${entry.path} is missing from the installed package (expected sha256 ${entry.sha256} at ${abs})`);
      continue;
    }
    let canonical = abs;
    try {
      canonical = fs.realpathSync(abs);
    } catch {
      /* unreachable: readFileBytes just succeeded */
    }
    if (canonical !== canonicalDataDir && !canonical.startsWith(canonicalDataDir + path.sep)) {
      errors.push(`reviewed file ${DATA_REL}/${entry.path} resolves to ${canonical}, outside the packaged data directory ${canonicalDataDir}`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== entry.sha256) {
      errors.push(`reviewed file ${DATA_REL}/${entry.path} does not match its indexed hash (indexed ${entry.sha256}, actual ${actual})`);
      continue;
    }
    verified.set(entry.path, bytes);
    checked.push({ path: `${DATA_REL}/${toPosix(entry.path)}`, sha256: actual });
  }

  // Records: parseable, and citing only basis snapshots the index declares at the same hash.
  const declaredBasis = new Map(historicalReferences.map((h) => [h.path, h.sha256]));
  for (const entry of records) {
    const bytes = verified.get(entry.path);
    if (!bytes) continue; // already reported as missing or altered
    let record;
    try {
      record = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      errors.push(`reviewed record ${DATA_REL}/${entry.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      errors.push(`reviewed record ${DATA_REL}/${entry.path} must be a JSON object`);
      continue;
    }
    if (record.schemaVersion !== 1) {
      errors.push(`reviewed record ${DATA_REL}/${entry.path}: schemaVersion ${JSON.stringify(record.schemaVersion)} is not a supported record schema (expected 1)`);
      continue;
    }
    if (!Array.isArray(record.basis) || record.basis.length === 0) {
      errors.push(`reviewed record ${DATA_REL}/${entry.path} cites no basis; a reviewed mapping must name the historical evidence it rests on`);
      continue;
    }
    for (const cited of record.basis) {
      if (typeof cited !== "object" || cited === null || !boundedRelativePath(cited?.path) || typeof cited?.sha256 !== "string") {
        errors.push(`reviewed record ${DATA_REL}/${entry.path} cites a basis entry that is not {path, sha256}: ${JSON.stringify(cited)}`);
        continue;
      }
      const declared = declaredBasis.get(cited.path);
      if (declared === undefined) {
        errors.push(`reviewed record ${DATA_REL}/${entry.path} cites basis ${DATA_REL}/${cited.path}, which the installed index does not declare as a historical reference`);
        continue;
      }
      if (declared !== cited.sha256) {
        errors.push(`reviewed record ${DATA_REL}/${entry.path} cites basis ${DATA_REL}/${cited.path} at ${cited.sha256}, but the installed index declares ${declared}`);
        continue;
      }
      if (!verified.has(cited.path)) {
        errors.push(`reviewed record ${DATA_REL}/${entry.path} rests on basis ${DATA_REL}/${cited.path}, which did not verify in this package`);
      }
    }
  }

  return { ok: errors.length === 0, checked, errors };
}
