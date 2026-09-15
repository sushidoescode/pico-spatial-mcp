import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileIdentity, ToolchainIO } from "./toolchainselection.js";
import { readProjectSdkIdentity, type ProjectSdkIdentity, type ResolvedArtifact } from "./projectidentity.js";

/**
 * declarationcontext.ts — Task S5: declaration authority is explicit and versioned.
 *
 * The defect this exists to remove: the agent-vault materialized on a machine (historically the
 * 0.13.3 payload under ~/Library/PICO/sdk/0.13/agent-vault) was handed out as "the authoritative
 * SDK declarations" for whatever SDK a project actually builds against. A vault's declarations
 * are a fact about ONE package revision; a project's BOM and its resolved Maven artifacts are
 * separate facts; and "these declarations describe that target" is a third fact that has to be
 * established by a reviewed, byte-verified mapping — never by a directory label, a version string
 * in a hint, or a caller saying so.
 *
 * Three SDK-owned operations, each reading local bytes and nothing else:
 *
 *   readDeclarationIdentity(root)            what the vault at `root` IS: the package revision it
 *                                            declares and a content fingerprint over its sorted,
 *                                            root-relative declaration files. Declaration authority
 *                                            requires both `package.xml` metadata and at least one
 *                                            api-reference file; prose-only roots are `prose`.
 *   loadVerifiedCompatibilityEvidence(...)   which reviewed records, listed in the package-owned
 *                                            index at a fixed module-relative path, verify
 *                                            byte-for-byte against THIS source identity, THIS
 *                                            project's exact resolved SDK artifact set and BOM, and
 *                                            the artifact bytes on this machine. Acceptance is
 *                                            branded privately (a `unique symbol` type brand plus a
 *                                            runtime WeakSet) and bound to the project state that
 *                                            was verified.
 *   resolveDeclarationContext(...)           the answer a consumer may give: `historical` (no
 *                                            target), `unknown` (no applicable verified record),
 *                                            `incompatible` (a verified-incompatible or conflicting
 *                                            scope) or `target-compatible`, with the exact symbol
 *                                            scope that was verified.
 *
 * Trust anchors. The only candidates are records listed by relative path AND exact sha256 in
 * `data/sdk-compatibility/index.v1.json`, resolved from this module's own location (never from
 * the working directory or a checkout path). A caller can SELECT reviewed records by path; it can
 * never add one, and it can never pass a DeclarationIdentity, a compatibility boolean or a
 * fingerprint that this module treats as authority. The index lists `records` (empty until a
 * complete reviewed mapping exists) and `historicalReferences` — byte-identical snapshots of the
 * SDK 6.0.0 drift measurement and the 0.13.3 adoption-provenance fixture, which are retained as
 * historical INPUTS: they grant neither whole-vault 6.0.0 compatibility nor any 6.1 authority.
 *
 * Signature derivation. A record binds each scoped symbol to the verified inputs on both sides:
 *   sourceSha256 = sha256("pico-signature-source/1\n" + symbol + "\n" + declarationFingerprint + "\n"
 *                         + sorted "coordinate\0sha256\n" of the SOURCE artifacts)
 *   targetSha256 = sha256("pico-signature-target/1\n" + symbol + "\n" + targetBom + "\n"
 *                         + sorted "coordinate\0sha256\n" of the TARGET artifacts)
 * The loader recomputes both from what it verified and rejects a record whose hashes were not
 * derived from exactly those inputs; it also requires each scoped symbol to be declared in the
 * record's listed source files. This is a binding commitment over verified bytes — it is not a
 * parse of Kotlin signatures out of a binary, which static host code cannot perform honestly.
 *
 * This module never starts a process, never runs Gradle or the CLI, never contacts a service and
 * never writes: the host adapter opens files under the vault root, the packaged data directory
 * and the Gradle module cache (`$GRADLE_USER_HOME/caches/modules-2/files-2.1`, read-only) only.
 */

// ─────────────────────────────────────────────────────────────────────────────── public types

export interface DeclarationIdentity {
  root: string; packageRevision: string | null; fingerprint: string;
  authority: "declarations" | "prose"; sources: readonly FileIdentity[];
}
export type DeclarationIdentityResult = {status:"ok"; identity:DeclarationIdentity}
  | {status:"unavailable"; code:string; detail:string};
export interface DeclarationIO extends Pick<ToolchainIO,"read"|"entries"|"realpath"> {
  artifactPath(coordinate:string, sha256:string): string | null;
}
export interface CompatibilityRecordV1 {
  schemaVersion:1; id:string; declarationFingerprint:string;
  packageRevision:string; targetBom:string;
  sourceFiles:readonly FileIdentity[]; // root-relative declaration paths; no user-project paths
  artifacts:readonly {side:"source"|"target"; coordinate:string; sha256:string}[];
  signatures:readonly {symbol:string; sourceSha256:string; targetSha256:string}[];
  symbols:readonly string[]; verdict:"compatible"|"incompatible"; basis:readonly FileIdentity[];
}
declare const verified: unique symbol; // module-private; also enforce runtime WeakSet membership
export type VerifiedCompatibilityEvidence = CompatibilityRecordV1 & {
  readonly [verified]:true; record:FileIdentity;
  binding:{projectRoot:string; projectFingerprint:string; artifactsFingerprint:string};
};
export interface CompatibilityLoadResult {
  accepted:readonly VerifiedCompatibilityEvidence[];
  rejected:readonly {path:string; code:string; detail:string}[];
}
export interface DeclarationContext {
  source: DeclarationIdentity; target: ProjectSdkIdentity | null;
  status: "target-compatible" | "historical" | "unknown" | "incompatible";
  evidencePaths: readonly string[]; verifiedSymbols:readonly string[];
}

/** The reviewed index schema: candidates and historical basis, each by relative path + exact sha256. */
export interface CompatibilityIndexV1 {
  schemaVersion: 1;
  records: readonly FileIdentity[];
  historicalReferences: readonly FileIdentity[];
}
export type CompatibilityIndexResult =
  | { status: "ok"; dir: string; index: CompatibilityIndexV1; verified: readonly FileIdentity[] }
  | { status: "unavailable"; code: "index-missing" | "index-schema" | "evidence-hash"; detail: string };

// ────────────────────────────────────────────────────────────────────── fixed packaged paths

/**
 * The package-owned reviewed data directory, resolved from THIS module's location: from
 * `dist/declarationcontext.js` that is `<package>/data/sdk-compatibility`, wherever the package
 * is installed. Never derived from the working directory or a source checkout.
 */
export const SDK_COMPATIBILITY_DATA_DIR = fileURLToPath(new URL("../data/sdk-compatibility/", import.meta.url)).replace(/[\\/]+$/, "");
export const SDK_COMPATIBILITY_INDEX_PATH = path.join(SDK_COMPATIBILITY_DATA_DIR, "index.v1.json");

/** Groups whose artifacts form the SDK set; `com.pico.spatial*` per the compatibility contract. */
export const SDK_ARTIFACT_GROUP_PREFIX = "com.pico.spatial";

const DECLARATION_DIR = "knowledge/api-reference";
const PROSE_DIR = "knowledge/documentation";
const PACKAGE_FILE = "package.xml";

// ─────────────────────────────────────────────────────────────────────────────── primitives

const sha256 = (data: crypto.BinaryLike): string => crypto.createHash("sha256").update(data).digest("hex");
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** An exact literal version: two or three numeric parts. Ranges, `+` and `latest.*` cannot match. */
const LITERAL_VERSION = /^\d+\.\d+(?:\.\d+)?$/;
/** Dotted identifiers only — a wildcard, a trailing dot or a glob can never be a scoped symbol. */
const EXACT_SYMBOL = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVISION = /<revision>\s*<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>(?:\s*<micro>(\d+)<\/micro>)?/;

export interface ArtifactCoordinate {
  group: string;
  artifact: string;
  version: string;
  classifier: string | null;
  extension: string;
}

const COORDINATE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):([A-Za-z0-9_][A-Za-z0-9_.-]*):(\d+\.\d+(?:\.\d+)?)(?::([A-Za-z0-9_][A-Za-z0-9_.-]*))?@([A-Za-z0-9]+)$/;

/** `group:artifact:version[:classifier]@extension`, exact version only; a segment with `..` is not a coordinate. */
export function parseArtifactCoordinate(coordinate: string): ArtifactCoordinate | null {
  const m = COORDINATE.exec(coordinate);
  if (!m) return null;
  const parsed = { group: m[1]!, artifact: m[2]!, version: m[3]!, classifier: m[4] ?? null, extension: m[5]! };
  for (const segment of [parsed.group, parsed.artifact, parsed.classifier ?? ""]) {
    if (segment.includes("..")) return null;
  }
  return parsed;
}

const groupArtifactOf = (coordinate: string): string => {
  const parsed = parseArtifactCoordinate(coordinate);
  return parsed ? `${parsed.group}:${parsed.artifact}` : coordinate;
};

/** A relative posix path that stays inside its base: no absolute form, no drive, no `.`/`..`, no backslash. */
function isBoundedRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > 512) return false;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

const toPosix = (value: string): string => value.split(/[\\/]/).join("/");

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

const unavailable = (code: string, detail: string): DeclarationIdentityResult => ({ status: "unavailable", code, detail });

// ────────────────────────────────────────────────────────────────────────────── host adapter

/**
 * The host-backed DeclarationIO. `env`/`home` are parameters (defaulting to this process) so a
 * test can point the Gradle module-cache lookup at a fixture without touching the real cache.
 *
 * `artifactPath` answers from `<GRADLE_USER_HOME or ~/.gradle>/caches/modules-2/files-2.1/
 * <group>/<artifact>/<version>/<hash-dir>/<artifact>-<version>[-<classifier>].<extension>` and
 * returns a path only when that file's bytes hash to the requested sha256. It is a read-only
 * lookup of what a previous Gradle resolution left on disk; it resolves nothing itself.
 */
export function hostDeclarationIO(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): DeclarationIO {
  return {
    read(target: string): Buffer | null {
      try {
        return fs.statSync(target).isFile() ? fs.readFileSync(target) : null;
      } catch {
        return null;
      }
    },
    entries(target: string): string[] | null {
      try {
        return fs.readdirSync(target);
      } catch {
        return null;
      }
    },
    realpath(target: string): string | null {
      try {
        return fs.realpathSync(target);
      } catch {
        return null;
      }
    },
    artifactPath(coordinate: string, digest: string): string | null {
      const parsed = parseArtifactCoordinate(coordinate);
      if (!parsed || !SHA256_HEX.test(digest)) return null;
      const gradleHome = (env.GRADLE_USER_HOME ?? "").trim() || path.join(home, ".gradle");
      const moduleDir = path.join(gradleHome, "caches", "modules-2", "files-2.1", parsed.group, parsed.artifact, parsed.version);
      const fileName = `${parsed.artifact}-${parsed.version}${parsed.classifier ? `-${parsed.classifier}` : ""}.${parsed.extension}`;
      let hashDirs: string[];
      try {
        hashDirs = fs.readdirSync(moduleDir);
      } catch {
        return null;
      }
      for (const dir of [...hashDirs].sort()) {
        const candidate = path.join(moduleDir, dir, fileName);
        let bytes: Buffer;
        try {
          if (!fs.statSync(candidate).isFile()) continue;
          bytes = fs.readFileSync(candidate);
        } catch {
          continue;
        }
        if (sha256(bytes) === digest) return candidate;
      }
      return null;
    },
  };
}

// ───────────────────────────────────────────────────────────────────── declaration identity

/** Identities this reader produced. A structurally identical object built elsewhere is not one. */
const readerIdentities = new WeakSet<DeclarationIdentity>();

/** The `<revision><major>/<minor>[/<micro>]` a vault's package.xml declares, or null when it declares none. */
export function parsePackageRevision(xml: string): string | null {
  const m = REVISION.exec(xml);
  if (!m) return null;
  return m[3] !== undefined ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`;
}

/**
 * Read what the vault at `root` declares. Canonical root, declared package revision and a
 * deterministic CONTENT fingerprint over the sorted root-relative declaration files — so two
 * identical installations at different roots agree on `fingerprint` and differ on `root`, and no
 * revision is ever inferred from a directory label. Bounded: a symlink escaping the root, two
 * entries resolving to one file, or bytes changing between the hash pass and the verify pass make
 * the identity unavailable rather than approximately right.
 */
export function readDeclarationIdentity(root: string, io: DeclarationIO = hostDeclarationIO()): DeclarationIdentityResult {
  const requested = String(root ?? "").trim();
  if (!requested) return unavailable("root-unavailable", "no declaration root was given");
  const canonical = io.realpath(requested);
  if (!canonical || io.entries(canonical) === null) {
    return unavailable("root-unavailable", `${requested} is not a readable directory`);
  }
  const listMarkdown = (dir: string): string[] => (io.entries(dir) ?? []).filter((f) => f.endsWith(".md")).sort();
  const declarations = listMarkdown(path.join(canonical, ...DECLARATION_DIR.split("/")));
  const prose = listMarkdown(path.join(canonical, ...PROSE_DIR.split("/")));
  const authority: DeclarationIdentity["authority"] | null = declarations.length ? "declarations" : prose.length ? "prose" : null;
  if (!authority) {
    return unavailable("declarations-missing", `${canonical} has no ${DECLARATION_DIR}/*.md declarations and no ${PROSE_DIR}/*.md prose; it is not an agent-vault`);
  }

  const packageFile = path.join(canonical, PACKAGE_FILE);
  const packageBytes = io.read(packageFile);
  let packageRevision: string | null = null;
  if (packageBytes) {
    packageRevision = parsePackageRevision(packageBytes.toString("utf8"));
    if (packageRevision === null && authority === "declarations") {
      return unavailable("package-xml-revision-malformed", `${packageFile} carries no <revision><major>/<minor> metadata; declaration authority requires the package revision it declares`);
    }
  } else if (authority === "declarations") {
    return unavailable("package-xml-missing", `${packageFile} is absent or unreadable; declaration authority requires the package revision it declares, and none is inferred from the directory name`);
  }

  const relDir = authority === "declarations" ? DECLARATION_DIR : PROSE_DIR;
  const entries: { rel: string; abs: string }[] = [];
  if (packageBytes) entries.push({ rel: PACKAGE_FILE, abs: packageFile });
  for (const name of authority === "declarations" ? declarations : prose) {
    entries.push({ rel: `${relDir}/${name}`, abs: path.join(canonical, ...relDir.split("/"), name) });
  }

  const canonicalSeen = new Map<string, string>();
  const hashed: { rel: string; sha256: string }[] = [];
  for (const entry of entries) {
    const real = io.realpath(entry.abs);
    if (!real) return unavailable("declaration-unreadable", `${entry.abs} cannot be resolved`);
    if (!isInside(canonical, real)) {
      return unavailable("declaration-escape", `${entry.abs} resolves to ${real}, outside the declaration root ${canonical}`);
    }
    const previous = canonicalSeen.get(real);
    if (previous) return unavailable("declaration-duplicate", `${entry.abs} and ${previous} are the same file (${real})`);
    canonicalSeen.set(real, entry.abs);
    const bytes = io.read(entry.abs);
    if (!bytes) return unavailable("declaration-unreadable", `${entry.abs} exists but cannot be read`);
    hashed.push({ rel: entry.rel, sha256: sha256(bytes) });
  }
  // Verify pass: the bytes that were hashed must still be the bytes on disk.
  for (const entry of hashed) {
    const again = io.read(path.join(canonical, ...entry.rel.split("/")));
    if (!again || sha256(again) !== entry.sha256) {
      return unavailable("declaration-changed", `${entry.rel} changed while its identity was being read; read it again`);
    }
  }

  const sources: FileIdentity[] = hashed
    .map((entry) => ({ path: toPosix(entry.rel), sha256: entry.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let material = `pico-declaration-identity/1\n${authority}\n`;
  for (const source of sources) material += `${source.path}\0${source.sha256}\n`;
  const identity: DeclarationIdentity = deepFreeze({
    root: canonical,
    packageRevision,
    fingerprint: sha256(material),
    authority,
    sources,
  });
  readerIdentities.add(identity);
  return { status: "ok", identity };
}

// ──────────────────────────────────────────────────────────────────────────── reviewed index

function fileIdentityList(value: unknown, field: string): FileIdentity[] | string {
  if (!Array.isArray(value)) return `${field} must be an array of {path, sha256}`;
  const out: FileIdentity[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i] as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return `${field}[${i}] must be {path, sha256}`;
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== "path,sha256") return `${field}[${i}] must have exactly the fields path and sha256 (got ${keys.join(", ") || "none"})`;
    if (!isBoundedRelativePath(entry.path)) return `${field}[${i}].path must be a relative path inside data/sdk-compatibility (got ${JSON.stringify(entry.path)})`;
    if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) return `${field}[${i}].sha256 must be 64 lowercase hex characters`;
    if (seen.has(entry.path)) return `${field}[${i}].path ${entry.path} is listed twice`;
    seen.add(entry.path);
    out.push({ path: entry.path, sha256: entry.sha256 });
  }
  return out;
}

/**
 * Read and verify the package-owned reviewed index. Every referenced file — records and
 * historical references alike — is re-hashed; one mismatch or absence makes the whole index
 * unavailable as `evidence-hash`, because reviewed data is one unit and a partially altered
 * payload must not keep serving the parts that still match.
 */
export function readCompatibilityIndex(io: DeclarationIO = hostDeclarationIO()): CompatibilityIndexResult {
  const bytes = io.read(SDK_COMPATIBILITY_INDEX_PATH);
  if (!bytes) {
    return { status: "unavailable", code: "index-missing", detail: `reviewed index ${SDK_COMPATIBILITY_INDEX_PATH} is absent or unreadable` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { status: "unavailable", code: "index-schema", detail: `reviewed index ${SDK_COMPATIBILITY_INDEX_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const schema = (detail: string): CompatibilityIndexResult => ({ status: "unavailable", code: "index-schema", detail: `reviewed index ${SDK_COMPATIBILITY_INDEX_PATH}: ${detail}` });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return schema("must be a JSON object");
  const object = parsed as Record<string, unknown>;
  if (object.schemaVersion !== 1) return schema(`schemaVersion ${JSON.stringify(object.schemaVersion)} is not a supported index schema (expected 1)`);
  const unexpected = Object.keys(object).filter((key) => !["schemaVersion", "records", "historicalReferences"].includes(key));
  if (unexpected.length) return schema(`unexpected field ${unexpected.map((k) => JSON.stringify(k)).join(", ")}`);
  const records = fileIdentityList(object.records, "records");
  if (typeof records === "string") return schema(records);
  const historicalReferences = fileIdentityList(object.historicalReferences, "historicalReferences");
  if (typeof historicalReferences === "string") return schema(historicalReferences);
  const overlap = records.filter((r) => historicalReferences.some((h) => h.path === r.path));
  if (overlap.length) return schema(`${overlap[0]!.path} is listed both as a record and as a historical reference`);

  const verified: FileIdentity[] = [];
  for (const entry of [...historicalReferences, ...records]) {
    const abs = path.join(SDK_COMPATIBILITY_DATA_DIR, ...entry.path.split("/"));
    const referenced = io.read(abs);
    if (!referenced) {
      return { status: "unavailable", code: "evidence-hash", detail: `reviewed file ${entry.path} is missing from ${SDK_COMPATIBILITY_DATA_DIR}` };
    }
    const actual = sha256(referenced);
    if (actual !== entry.sha256) {
      return { status: "unavailable", code: "evidence-hash", detail: `reviewed file ${entry.path} does not match its indexed hash (indexed ${entry.sha256}, actual ${actual})` };
    }
    verified.push({ path: entry.path, sha256: actual });
  }
  return deepFreeze({
    status: "ok",
    dir: io.realpath(SDK_COMPATIBILITY_DATA_DIR) ?? SDK_COMPATIBILITY_DATA_DIR,
    index: { schemaVersion: 1, records, historicalReferences },
    verified,
  });
}

/** Absolute paths of every record the reviewed index lists; empty when the index is unavailable. */
export function indexedRecordPaths(io: DeclarationIO = hostDeclarationIO()): string[] {
  const index = readCompatibilityIndex(io);
  if (index.status !== "ok") return [];
  return index.index.records.map((entry) => path.join(SDK_COMPATIBILITY_DATA_DIR, ...entry.path.split("/")));
}

// ─────────────────────────────────────────────────────────────────────── signature derivation

const artifactLines = (artifacts: readonly { coordinate: string; sha256: string }[]): string =>
  [...new Set(artifacts.map((a) => `${a.coordinate}\0${a.sha256}`))].sort().map((line) => `${line}\n`).join("");

/** The reviewed source-side commitment: symbol + verified declaration fingerprint + source artifact set. */
export function deriveSourceSignatureSha256(symbol: string, declarationFingerprint: string, sourceArtifacts: readonly { coordinate: string; sha256: string }[]): string {
  return sha256(`pico-signature-source/1\n${symbol}\n${declarationFingerprint}\n${artifactLines(sourceArtifacts)}`);
}

/** The reviewed target-side commitment: symbol + target BOM + target artifact set. */
export function deriveTargetSignatureSha256(symbol: string, targetBom: string, targetArtifacts: readonly { coordinate: string; sha256: string }[]): string {
  return sha256(`pico-signature-target/1\n${symbol}\n${targetBom}\n${artifactLines(targetArtifacts)}`);
}

// ──────────────────────────────────────────────────────────────────────────── record schema

const RECORD_FIELDS = ["schemaVersion", "id", "declarationFingerprint", "packageRevision", "targetBom", "sourceFiles", "artifacts", "signatures", "symbols", "verdict", "basis"] as const;

type Validation = { ok: true; record: CompatibilityRecordV1 } | { ok: false; detail: string };

/** Strict: exactly the v1 fields, exact versions, exact symbols, both artifact sides, a nonempty basis. */
function validateRecord(parsed: unknown): Validation {
  const bad = (detail: string): Validation => ({ ok: false, detail });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad("a record must be a JSON object");
  const object = parsed as Record<string, unknown>;
  if (object.schemaVersion !== 1) return bad(`schemaVersion ${JSON.stringify(object.schemaVersion)} is not a supported record schema (expected 1)`);
  const unexpected = Object.keys(object).filter((key) => !(RECORD_FIELDS as readonly string[]).includes(key));
  if (unexpected.length) return bad(`unexpected field ${unexpected.map((k) => JSON.stringify(k)).join(", ")}: a reviewed record carries no project root, project fingerprint, binding or compatibility flag`);
  const missing = RECORD_FIELDS.filter((key) => !(key in object));
  if (missing.length) return bad(`missing field ${missing.join(", ")}`);

  if (typeof object.id !== "string" || !RECORD_ID.test(object.id)) return bad("id must be a short identifier (letters, digits, . _ -)");
  if (typeof object.declarationFingerprint !== "string" || !SHA256_HEX.test(object.declarationFingerprint)) return bad("declarationFingerprint must be 64 lowercase hex characters");
  if (typeof object.packageRevision !== "string" || !LITERAL_VERSION.test(object.packageRevision)) return bad(`packageRevision ${JSON.stringify(object.packageRevision)} must be one exact version (no ranges or dynamic versions)`);
  if (typeof object.targetBom !== "string" || !LITERAL_VERSION.test(object.targetBom)) return bad(`targetBom ${JSON.stringify(object.targetBom)} must be one exact version (no ranges or dynamic versions)`);

  const sourceFiles = fileIdentityList(object.sourceFiles, "sourceFiles");
  if (typeof sourceFiles === "string") return bad(sourceFiles);
  if (sourceFiles.length === 0) return bad("sourceFiles must list at least one declaration file");
  for (const file of sourceFiles) {
    if (file.path !== PACKAGE_FILE && !file.path.startsWith("knowledge/")) {
      return bad(`sourceFiles: ${file.path} is not a vault declaration path (package.xml or knowledge/...); user-project paths do not belong in a record`);
    }
  }

  if (!Array.isArray(object.artifacts) || object.artifacts.length === 0) return bad("artifacts must be a nonempty array of {side, coordinate, sha256}");
  const artifacts: CompatibilityRecordV1["artifacts"][number][] = [];
  const artifactKeys = new Set<string>();
  for (let i = 0; i < object.artifacts.length; i += 1) {
    const entry = object.artifacts[i] as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return bad(`artifacts[${i}] must be {side, coordinate, sha256}`);
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "coordinate,sha256,side") return bad(`artifacts[${i}] must have exactly the fields side, coordinate and sha256`);
    if (entry.side !== "source" && entry.side !== "target") return bad(`artifacts[${i}].side must be "source" or "target"`);
    if (typeof entry.coordinate !== "string" || !parseArtifactCoordinate(entry.coordinate)) {
      return bad(`artifacts[${i}].coordinate ${JSON.stringify(entry.coordinate)} is not group:artifact:version[:classifier]@extension with one exact version`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) return bad(`artifacts[${i}].sha256 must be 64 lowercase hex characters`);
    const key = `${entry.side}\0${entry.coordinate}`;
    if (artifactKeys.has(key)) return bad(`artifacts[${i}] repeats ${entry.side} coordinate ${entry.coordinate}`);
    artifactKeys.add(key);
    artifacts.push({ side: entry.side, coordinate: entry.coordinate, sha256: entry.sha256 });
  }
  if (!artifacts.some((a) => a.side === "source")) return bad("artifacts: at least one source artifact is required");
  if (!artifacts.some((a) => a.side === "target")) return bad("artifacts: at least one target artifact is required");

  if (!Array.isArray(object.symbols) || object.symbols.length === 0) return bad("symbols must list at least one exact symbol");
  const symbols: string[] = [];
  for (let i = 0; i < object.symbols.length; i += 1) {
    const symbol = object.symbols[i];
    if (typeof symbol !== "string" || !EXACT_SYMBOL.test(symbol)) return bad(`symbols[${i}] ${JSON.stringify(symbol)} is not one exact dotted symbol (wildcards and globs are not a scope)`);
    if (symbols.includes(symbol)) return bad(`symbols[${i}] ${symbol} is listed twice`);
    symbols.push(symbol);
  }

  if (!Array.isArray(object.signatures) || object.signatures.length === 0) return bad("signatures must list one entry per scoped symbol");
  const signatures: CompatibilityRecordV1["signatures"][number][] = [];
  for (let i = 0; i < object.signatures.length; i += 1) {
    const entry = object.signatures[i] as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return bad(`signatures[${i}] must be {symbol, sourceSha256, targetSha256}`);
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "sourceSha256,symbol,targetSha256") return bad(`signatures[${i}] must have exactly the fields symbol, sourceSha256 and targetSha256`);
    if (typeof entry.symbol !== "string" || !EXACT_SYMBOL.test(entry.symbol)) return bad(`signatures[${i}].symbol ${JSON.stringify(entry.symbol)} is not one exact dotted symbol`);
    if (!symbols.includes(entry.symbol)) return bad(`signatures[${i}]: symbol ${entry.symbol} is not in the record's symbols scope`);
    if (signatures.some((s) => s.symbol === entry.symbol)) return bad(`signatures[${i}]: symbol ${entry.symbol} is listed twice`);
    if (typeof entry.sourceSha256 !== "string" || !SHA256_HEX.test(entry.sourceSha256)) return bad(`signatures[${i}].sourceSha256 must be 64 lowercase hex characters`);
    if (typeof entry.targetSha256 !== "string" || !SHA256_HEX.test(entry.targetSha256)) return bad(`signatures[${i}].targetSha256 must be 64 lowercase hex characters`);
    signatures.push({ symbol: entry.symbol, sourceSha256: entry.sourceSha256, targetSha256: entry.targetSha256 });
  }
  const unsigned = symbols.filter((symbol) => !signatures.some((s) => s.symbol === symbol));
  if (unsigned.length) return bad(`signatures: no signature entry for scoped symbol ${unsigned.join(", ")}`);

  if (object.verdict !== "compatible" && object.verdict !== "incompatible") return bad(`verdict ${JSON.stringify(object.verdict)} must be "compatible" or "incompatible"`);

  const basis = fileIdentityList(object.basis, "basis");
  if (typeof basis === "string") return bad(basis);
  if (basis.length === 0) return bad("basis must cite at least one reviewed historical reference");

  return {
    ok: true,
    record: {
      schemaVersion: 1,
      id: object.id,
      declarationFingerprint: object.declarationFingerprint,
      packageRevision: object.packageRevision,
      targetBom: object.targetBom,
      sourceFiles,
      artifacts,
      signatures,
      symbols,
      verdict: object.verdict,
      basis,
    },
  };
}

// ─────────────────────────────────────────────────────────────────── SDK artifact-set identity

interface SdkArtifactSet {
  keys: readonly string[];
  malformed: readonly string[];
  fingerprint: string;
}

/**
 * The normalized SDK set of a resolution: every artifact in a `com.pico.spatial*` group plus any
 * coordinate the record explicitly identifies (a Compose fork published under another group enters
 * this way). Unrelated application dependencies never enter; an SDK-group artifact whose identifier
 * does not parse is reported as malformed so it can prevent, never fake, an exact match.
 */
function normalizeSdkArtifactSet(resolved: readonly ResolvedArtifact[], identified: ReadonlySet<string>): SdkArtifactSet {
  const keys: string[] = [];
  const malformed: string[] = [];
  for (const artifact of resolved) {
    const parsed = parseArtifactCoordinate(artifact.coordinate);
    const group = parsed ? parsed.group : (artifact.coordinate.split(":")[0] ?? "");
    const inSdk = group.startsWith(SDK_ARTIFACT_GROUP_PREFIX) || (parsed !== null && identified.has(`${parsed.group}:${parsed.artifact}`));
    if (!inSdk) continue;
    if (!parsed) {
      malformed.push(artifact.coordinate);
      continue;
    }
    keys.push(`${artifact.coordinate}\0${artifact.sha256}`);
  }
  const sorted = [...new Set(keys)].sort();
  return { keys: sorted, malformed, fingerprint: sha256(`pico-sdk-artifact-set/1\n${sorted.map((k) => `${k}\n`).join("")}`) };
}

const describeKeys = (keys: readonly string[]): string => keys.map((k) => k.replace("\0", "@sha256:")).join(", ") || "none";

// ──────────────────────────────────────────────────────────────────────── verified evidence

/** Evidence this loader accepted. The type brand keeps callers from naming the type; this keeps them from faking it. */
const acceptedEvidence = new WeakSet<VerifiedCompatibilityEvidence>();

const DECLARATION_KEYWORDS = "class|interface|object|enum|typealias|fun|val|var";

/** Is `symbol`'s simple name declared (header or keyword) in any of the record's listed source files? */
function symbolDeclaredIn(symbol: string, source: DeclarationIdentity, files: readonly FileIdentity[], io: DeclarationIO): boolean {
  const simple = symbol.split(".").pop() ?? symbol;
  const escaped = simple.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^#\\s+${escaped}\\s*$)|(?:\\b(?:${DECLARATION_KEYWORDS})\\s+${escaped}\\b)`, "m");
  for (const file of files) {
    const bytes = io.read(path.join(source.root, ...file.path.split("/")));
    if (bytes && pattern.test(bytes.toString("utf8"))) return true;
  }
  return false;
}

/**
 * Load the reviewed compatibility records at `paths` and accept only those that verify against
 * `source` (a reader-produced declaration identity), `target` (a resolved project identity) and
 * the artifact bytes reachable through `io`. Rejections are reported per path with one code:
 *
 *   record-not-reviewed   not listed in the reviewed index (caller paths cannot add trust anchors),
 *                         or the index itself is missing/unreadable, or a basis is not indexed
 *   record-schema         not the v1 record schema: unknown version, ranges, wildcards, stray fields
 *   evidence-hash         record, basis, historical-reference, artifact or signature bytes differ
 *                         from what the review committed to
 *   artifact-unavailable  a source or target artifact is not present locally
 *   context-mismatch      wrong source (fingerprint/revision/prose/caller-built), wrong BOM, a
 *                         different resolved SDK artifact set, or a symbol the source never declares
 *   target-unresolved     the project identity is declared-only/unknown, or changed since it was read
 *
 * After a record verifies, the project is read again and the acceptance is bound to that current
 * state (canonical root, content fingerprint, normalized SDK artifact-set fingerprint): a record is
 * reusable across applications with the same exact resolved SDK, an acceptance is not.
 */
export function loadVerifiedCompatibilityEvidence(paths:readonly string[], source:DeclarationIdentity,
  target:ProjectSdkIdentity, io?:DeclarationIO): CompatibilityLoadResult {
  const host = io ?? hostDeclarationIO();
  const accepted: VerifiedCompatibilityEvidence[] = [];
  const rejected: { path: string; code: string; detail: string }[] = [];
  const requested = [...new Set((paths ?? []).map((p) => String(p ?? "")))];
  if (requested.length === 0) return deepFreeze({ accepted, rejected });

  const index = readCompatibilityIndex(host);
  const indexed = new Map<string, FileIdentity>();
  if (index.status === "ok") {
    for (const entry of index.index.records) {
      const abs = path.join(SDK_COMPATIBILITY_DATA_DIR, ...entry.path.split("/"));
      indexed.set(host.realpath(abs) ?? abs, entry);
    }
  }
  const sourceGenuine = readerIdentities.has(source);
  // Lazily re-read once per call: the vault and the project must still be what the caller read.
  let freshSource: DeclarationIdentityResult | null = null;
  let freshTarget: ProjectSdkIdentity | null = null;

  for (const requestedPath of requested) {
    const reject = (code: string, detail: string) => rejected.push({ path: requestedPath, code, detail });
    if (requestedPath === "") {
      reject("record-not-reviewed", "an empty path names no reviewed record");
      continue;
    }
    if (index.status !== "ok") {
      reject(index.code === "evidence-hash" ? "evidence-hash" : "record-not-reviewed", `reviewed index unavailable (${index.code}): ${index.detail}`);
      continue;
    }
    const abs = path.isAbsolute(requestedPath) ? requestedPath : path.join(SDK_COMPATIBILITY_DATA_DIR, ...toPosix(requestedPath).split("/"));
    const canonical = host.realpath(abs);
    if (!canonical) {
      reject("record-not-reviewed", `${abs} cannot be read, so it cannot be matched against the reviewed index ${SDK_COMPATIBILITY_INDEX_PATH}`);
      continue;
    }
    const entry = indexed.get(canonical);
    if (!entry) {
      reject("record-not-reviewed", `${abs} is not listed in the reviewed index ${SDK_COMPATIBILITY_INDEX_PATH}; caller paths cannot add trust anchors`);
      continue;
    }
    const bytes = host.read(abs);
    if (!bytes) {
      reject("record-not-reviewed", `${abs} exists in the reviewed index but cannot be read`);
      continue;
    }
    const recordSha = sha256(bytes);
    if (recordSha !== entry.sha256) {
      reject("evidence-hash", `record bytes at ${abs} (sha256 ${recordSha}) do not match the reviewed index entry ${entry.path} (${entry.sha256})`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      reject("record-schema", `${abs} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const validated = validateRecord(parsed);
    if (!validated.ok) {
      reject("record-schema", `${abs}: ${validated.detail}`);
      continue;
    }
    const record = validated.record;

    // Basis: every citation must be a reviewed historical reference, byte-verified by the index read.
    let basisProblem: { code: string; detail: string } | null = null;
    for (const cited of record.basis) {
      const listed = index.index.historicalReferences.find((h) => h.path === cited.path);
      if (!listed) {
        basisProblem = { code: "record-not-reviewed", detail: `basis ${cited.path} is not a reviewed historical reference in ${SDK_COMPATIBILITY_INDEX_PATH}` };
        break;
      }
      if (listed.sha256 !== cited.sha256) {
        basisProblem = { code: "evidence-hash", detail: `basis ${cited.path}: the record cites ${cited.sha256} but the reviewed index lists ${listed.sha256}` };
        break;
      }
      const basisBytes = host.read(path.join(SDK_COMPATIBILITY_DATA_DIR, ...cited.path.split("/")));
      if (!basisBytes || sha256(basisBytes) !== cited.sha256) {
        basisProblem = { code: "evidence-hash", detail: `basis ${cited.path} bytes do not match the reviewed hash ${cited.sha256}` };
        break;
      }
    }
    if (basisProblem) {
      reject(basisProblem.code, basisProblem.detail);
      continue;
    }

    // Source: reader-produced, declaration-grade, still current, and exactly what the record bound.
    if (!sourceGenuine) {
      reject("context-mismatch", "the source identity was not produced by readDeclarationIdentity; caller-built identities carry no authority");
      continue;
    }
    if (source.authority !== "declarations") {
      reject("context-mismatch", `the source root ${source.root} carries prose only; prose never grants declaration authority`);
      continue;
    }
    if (!freshSource) freshSource = readDeclarationIdentity(source.root, host);
    if (freshSource.status !== "ok") {
      reject("context-mismatch", `the declaration root ${source.root} is no longer readable (${freshSource.code}: ${freshSource.detail})`);
      continue;
    }
    if (freshSource.identity.fingerprint !== source.fingerprint) {
      reject("context-mismatch", `the declaration root ${source.root} changed since its identity was read (fingerprint ${source.fingerprint} -> ${freshSource.identity.fingerprint}); read it again`);
      continue;
    }
    if (record.declarationFingerprint !== source.fingerprint) {
      reject("context-mismatch", `record declarationFingerprint ${record.declarationFingerprint} does not match the local declaration fingerprint ${source.fingerprint} of ${source.root}`);
      continue;
    }
    if (record.packageRevision !== source.packageRevision) {
      reject("context-mismatch", `record packageRevision ${record.packageRevision} does not match the declared package revision ${source.packageRevision ?? "none"} of ${source.root}`);
      continue;
    }
    const unmatchedSource = record.sourceFiles.find((file) => !source.sources.some((s) => s.path === file.path && s.sha256 === file.sha256));
    if (unmatchedSource) {
      const local = source.sources.find((s) => s.path === unmatchedSource.path);
      reject(local ? "evidence-hash" : "context-mismatch", local
        ? `source file ${unmatchedSource.path}: the record cites ${unmatchedSource.sha256} but the local bytes hash ${local.sha256}`
        : `source file ${unmatchedSource.path} is not part of the local declaration set of ${source.root}`);
      continue;
    }

    // Signatures: the reviewed derivation must recompute from the verified inputs, and every
    // scoped symbol must actually be declared in the source files the record lists.
    const sourceArtifacts = record.artifacts.filter((a) => a.side === "source");
    const targetArtifacts = record.artifacts.filter((a) => a.side === "target");
    const badSignature = record.signatures.find((s) =>
      s.sourceSha256 !== deriveSourceSignatureSha256(s.symbol, record.declarationFingerprint, sourceArtifacts)
      || s.targetSha256 !== deriveTargetSignatureSha256(s.symbol, record.targetBom, targetArtifacts));
    if (badSignature) {
      reject("evidence-hash", `signature ${badSignature.symbol}: sourceSha256/targetSha256 were not derived from the verified declaration fingerprint, target BOM and artifact sets`);
      continue;
    }
    const undeclared = record.symbols.find((symbol) => !symbolDeclaredIn(symbol, source, record.sourceFiles, host));
    if (undeclared) {
      reject("context-mismatch", `symbol ${undeclared} is not declared in the record's source files (${record.sourceFiles.map((f) => f.path).join(", ")})`);
      continue;
    }

    // Target: a resolved project whose declared BOM and exact resolved SDK set the record binds.
    if (target.status !== "resolved" || target.resolvedArtifacts.length === 0) {
      reject("target-unresolved", `project ${target.projectRoot} identity is ${target.status}${target.declaredBom ? ` (declared BOM ${target.declaredBom})` : ""}; a declared-only or unknown BOM never establishes a target artifact set`);
      continue;
    }
    if (target.declaredBom === null) {
      reject("context-mismatch", `project ${target.projectRoot} declares no literal BOM (${target.reasons.join("; ") || "no declaration"}), so the record's target BOM ${record.targetBom} cannot be confirmed`);
      continue;
    }
    if (target.declaredBom !== record.targetBom) {
      reject("context-mismatch", `record targets BOM ${record.targetBom} but project ${target.projectRoot} declares ${target.declaredBom}`);
      continue;
    }
    const identified = new Set(targetArtifacts.map((a) => groupArtifactOf(a.coordinate)));
    const projectSet = normalizeSdkArtifactSet(target.resolvedArtifacts, identified);
    if (projectSet.malformed.length) {
      reject("context-mismatch", `resolved SDK artifact ${projectSet.malformed.join(", ")} is not a group:artifact:version[:classifier]@extension identifier`);
      continue;
    }
    const recordSet = [...new Set(targetArtifacts.map((a) => `${a.coordinate}\0${a.sha256}`))].sort();
    if (recordSet.join("\n") !== projectSet.keys.join("\n")) {
      const missing = recordSet.filter((k) => !projectSet.keys.includes(k));
      const extra = projectSet.keys.filter((k) => !recordSet.includes(k));
      reject("context-mismatch", `the project's resolved SDK artifact set differs from the record's target set — missing: ${describeKeys(missing)}; unexpected: ${describeKeys(extra)}`);
      continue;
    }

    // Artifacts: both sides must be present locally with exactly the reviewed bytes.
    let artifactProblem: { code: string; detail: string } | null = null;
    for (const artifact of record.artifacts) {
      const located = host.artifactPath(artifact.coordinate, artifact.sha256);
      if (!located) {
        artifactProblem = { code: "artifact-unavailable", detail: `${artifact.side} artifact ${artifact.coordinate} (sha256 ${artifact.sha256}) is not available locally` };
        break;
      }
      const payload = host.read(located);
      if (!payload) {
        artifactProblem = { code: "artifact-unavailable", detail: `${artifact.side} artifact ${artifact.coordinate} at ${located} cannot be read` };
        break;
      }
      const actual = sha256(payload);
      if (actual !== artifact.sha256) {
        artifactProblem = { code: "evidence-hash", detail: `${artifact.side} artifact ${artifact.coordinate} bytes at ${located} hash ${actual}, not the reviewed ${artifact.sha256}` };
        break;
      }
    }
    if (artifactProblem) {
      reject(artifactProblem.code, artifactProblem.detail);
      continue;
    }

    // Binding: re-read the project and bind the acceptance to its CURRENT state.
    if (!freshTarget) freshTarget = readProjectSdkIdentity(target.projectRoot, { resolvedArtifacts: target.resolvedArtifacts });
    if (freshTarget.projectRoot !== target.projectRoot || freshTarget.fingerprint !== target.fingerprint
      || freshTarget.status !== "resolved" || freshTarget.declaredBom !== target.declaredBom) {
      reject("target-unresolved", `project ${target.projectRoot} changed since its identity was read (fingerprint ${target.fingerprint} -> ${freshTarget.fingerprint}, status ${freshTarget.status}); read the project identity again and load again`);
      continue;
    }
    const evidence = deepFreeze({
      ...record,
      record: { path: canonical, sha256: recordSha },
      binding: { projectRoot: freshTarget.projectRoot, projectFingerprint: freshTarget.fingerprint, artifactsFingerprint: projectSet.fingerprint },
    }) as VerifiedCompatibilityEvidence;
    acceptedEvidence.add(evidence);
    accepted.push(evidence);
  }
  return deepFreeze({ accepted, rejected });
}

// ──────────────────────────────────────────────────────────────────────── context resolution

/** Does this accepted evidence still speak for this source and this exact current project state? */
function appliesTo(evidence: VerifiedCompatibilityEvidence, source: DeclarationIdentity, target: ProjectSdkIdentity): boolean {
  if (source.authority !== "declarations") return false;
  if (evidence.declarationFingerprint !== source.fingerprint || evidence.packageRevision !== source.packageRevision) return false;
  if (target.status !== "resolved" || target.declaredBom !== evidence.targetBom) return false;
  if (evidence.binding.projectRoot !== target.projectRoot || evidence.binding.projectFingerprint !== target.fingerprint) return false;
  const identified = new Set(evidence.artifacts.filter((a) => a.side === "target").map((a) => groupArtifactOf(a.coordinate)));
  const current = normalizeSdkArtifactSet(target.resolvedArtifacts, identified);
  return current.malformed.length === 0 && current.fingerprint === evidence.binding.artifactsFingerprint;
}

/**
 * The answer a consumer may give. Only loader-branded evidence counts (checked at runtime), and
 * only while its binding matches the fresh `target` handed in — a changed project must be loaded
 * again. No target: `historical`. No applicable evidence: `unknown`. Any applicable
 * verified-incompatible scope, or a symbol both verdicts claim: `incompatible`. Otherwise
 * `target-compatible`, and `verifiedSymbols` is exactly the compatible scope — a symbol outside it
 * stays unknown no matter what another symbol's record says. Prose never grants authority.
 */
export function resolveDeclarationContext(source: DeclarationIdentity, target: ProjectSdkIdentity | null,
  evidence: readonly VerifiedCompatibilityEvidence[]): DeclarationContext {
  if (!readerIdentities.has(source)) {
    throw new TypeError("resolveDeclarationContext: source must be an identity produced by readDeclarationIdentity; caller-built identities carry no authority");
  }
  if (target === null) {
    return deepFreeze({ source, target: null, status: "historical", evidencePaths: [], verifiedSymbols: [] });
  }
  const applicable = (evidence ?? []).filter((item) => item !== null && typeof item === "object" && acceptedEvidence.has(item) && appliesTo(item, source, target));
  if (applicable.length === 0) {
    return deepFreeze({ source, target, status: "unknown", evidencePaths: [], verifiedSymbols: [] });
  }
  const incompatible = new Set(applicable.filter((e) => e.verdict === "incompatible").flatMap((e) => [...e.symbols]));
  const compatible = [...new Set(applicable.filter((e) => e.verdict === "compatible").flatMap((e) => [...e.symbols]))]
    .filter((symbol) => !incompatible.has(symbol))
    .sort();
  return deepFreeze({
    source,
    target,
    status: incompatible.size ? "incompatible" : "target-compatible",
    evidencePaths: [...new Set(applicable.map((e) => e.record.path))],
    verifiedSymbols: compatible,
  });
}
