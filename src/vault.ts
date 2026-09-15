import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, okJson } from "./util.js";
import { IdentityCache } from "./identitycache.js";
import { hostToolchainIO } from "./toolchain.js";
import { isVersionToken, resolveRootCandidate } from "./toolchainselection.js";
import {
  hostDeclarationIO,
  loadVerifiedCompatibilityEvidence,
  parsePackageRevision,
  readCompatibilityIndex,
  readDeclarationIdentity,
  resolveDeclarationContext,
  SDK_COMPATIBILITY_DATA_DIR,
  SDK_COMPATIBILITY_INDEX_PATH,
} from "./declarationcontext.js";
import type { CompatibilityIndexResult, CompatibilityLoadResult, DeclarationContext, DeclarationIO, DeclarationIdentityResult, VerifiedCompatibilityEvidence } from "./declarationcontext.js";
import { readProjectSdkIdentity } from "./projectidentity.js";
import type { ProjectSdkIdentity } from "./projectidentity.js";

/**
 * vault.ts — v14.6 the AGENT-VAULT SYMBOL INDEX + the preflight vault check.
 *
 * The CLI's separately provisioned utility payload materializes PICO's authoritative SDK API
 * reference (the "agent-vault") at
 * ~/Library/PICO/sdk/0.13/agent-vault/knowledge/api-reference/ — 54 per-package markdown files of
 * pseudo-Kotlin declarations (419 top-level types, SDK 0.13.3). This module parses them into an
 * in-memory symbol index and validates emitted Kotlin against it. Phase 1 scope: TYPE-EXISTENCE
 * for `import com.pico.spatial.*` lines and inline FQN usages, non-ui packages only. Wired into
 * preflight_lint as a separate advisory `vault` block — findings NEVER affect `clean`, and an
 * absent vault degrades to status:"unavailable" (machines without that payload lose nothing).
 *
 * Format facts the parser relies on (verified across the whole corpus, 2026-07-12 vault audit):
 *  - a block = `# <pkg>` + `# <TypeName>` headers, then `package <pkg> {` ... a column-0 `}`;
 *  - doc comments are whole-line ranges and MUST be stripped before brace counting (they embed
 *    Kotlin code samples with braces, and phantom member docs with no declaration following);
 *  - nesting is expressed ONLY by braces — nested types sit at the SAME indentation as members;
 *  - members end in `;`, enum entries are bare identifiers, statics live in `object Companion`;
 *  - nullable is written `Type ?`; params can hold nested parens/generics/lambdas in defaults.
 *
 * ui.* packages document TYPES but not composable FUNCTIONS (Text, PicoTheme, backgroundMaterial
 * have no declarations, only doc samples), so ui imports are skipped — validating them would
 * false-positive on every SpatialUI panel we emit.
 *
 * The index is memoized per vault root and keyed on that root's CONTENT (package metadata +
 * declaration filenames and hashes), so a vault replaced in place is re-read rather than answered
 * from the copy that was there at startup. Parsing the 1.3MB api-reference takes ~50ms, so there
 * is deliberately NO disk cache (a cache adds a staleness bug class to save 50ms once per process).
 *
 * Task S5 — declaration AUTHORITY is explicit and versioned. A vault answers for the package
 * revision its package.xml declares and nothing else: every lookup is labeled `historical` unless
 * a reviewed compatibility record (declarationcontext.ts) verifies these exact declaration bytes
 * against the project's exact resolved SDK artifacts. The root/version/workspace resolution below
 * is unified on the selected PICO tools root; an explicit vault path is an explicitly identified
 * SOURCE, never proof of target compatibility; a version label is bounded to a numeric token and
 * never names a path; and no revision is inferred from a directory name.
 */

export interface VaultParam {
  name: string;
  type: string;
  hasDefault: boolean;
  /** First line of the member's `@param <name>` doc — carries unit semantics ("measured in degrees"). */
  doc?: string;
}
export interface VaultCtor {
  params: VaultParam[];
  minArity: number;
  maxArity: number;
}
export interface VaultFn {
  name: string;
  params: VaultParam[];
  returnType: string | null;
  static: boolean;
  suspend: boolean;
  line: number;
}
export interface VaultProp {
  name: string;
  type: string;
  mutable: boolean;
  static: boolean;
  line: number;
  /** First line of the property's doc comment — carries unit semantics ("measured in degrees"). */
  doc?: string;
}
export interface VaultType {
  package: string;
  /** Dotted-relative for nested types, e.g. "AnchorComponent.TrackingMode". */
  name: string;
  qualifiedName: string;
  kind: "class" | "interface" | "fun_interface" | "enum" | "object" | "annotation" | "typealias" | "value_class";
  supertypes: string[];
  nestedIn: string | null;
  file: string;
  line: number;
  constructors: VaultCtor[];
  properties: VaultProp[];
  functions: VaultFn[];
  enumEntries: string[] | null;
}
export interface VaultIndex {
  vaultRoot: string;
  sdkVersion: string | null;
  /** package -> (dotted type name -> entry) */
  packages: Map<string, Map<string, VaultType>>;
  typeCount: number;
  fileCount: number;
}

// ── tokenizer helpers ───────────────────────────────────────────────────────────────────────────────────

/** Strip leading annotations: `@MainThread`, `@RequiresApi(value = 27)`, use-site `@get: JvmName(...)`. */
function stripAnnotations(s: string): string {
  let t = s.trimStart();
  for (;;) {
    if (!t.startsWith("@")) return t;
    let i = 1;
    const useSite = /^@(?:get|set|field|param|property|receiver)\s*:\s*/.exec(t);
    if (useSite) i = useSite[0].length;
    while (i < t.length && /[\w.]/.test(t[i])) i++;
    if (t[i] === "(") {
      let depth = 0;
      do {
        if (t[i] === "(") depth++;
        else if (t[i] === ")") depth--;
        i++;
      } while (i < t.length && depth > 0);
    }
    t = t.slice(i).trimStart();
  }
}

/** Find the index of the matching close for the bracket at `open` (parens only). */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a param list on top-level commas — bracket-aware incl. generics/lambda braces, `->` guarded. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "<") depth++;
    else if (ch === ">" && s[i - 1] !== "-") depth--; // `->` in lambda types is not a generic close
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const normalizeType = (t: string) => t.trim().replace(/\s+\?/g, "?").replace(/\s+/g, " ");

function parseParams(inside: string): VaultParam[] {
  if (!inside.trim()) return [];
  return splitTopLevel(inside, ",").map((raw) => {
    // the default separator is the first top-level `=` (annotation args like @FloatRange(from = 0.0) sit at depth>0)
    let eq = -1;
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "<") depth++;
      else if (ch === ">" && raw[i - 1] !== "-") depth--;
      else if (ch === "=" && depth === 0) {
        eq = i;
        break;
      }
    }
    const decl = eq >= 0 ? raw.slice(0, eq) : raw;
    const noAnn = stripAnnotations(decl.trim()).replace(/^(?:val|var)\s+/, "");
    const colon = noAnn.indexOf(":");
    return {
      name: (colon >= 0 ? noAnn.slice(0, colon) : noAnn).trim(),
      type: colon >= 0 ? normalizeType(noAnn.slice(colon + 1)) : "",
      hasDefault: eq >= 0,
    };
  });
}

const ctorOf = (params: VaultParam[]): VaultCtor => ({
  params,
  minArity: params.filter((p) => !p.hasDefault).length,
  maxArity: params.length,
});

// ── declaration parsers ─────────────────────────────────────────────────────────────────────────────────

const MODIFIERS = /^(?:open|sealed|abstract|final|override|operator|inline|suspend|protected|const|external|value|annotation|fun|enum)\s+/;

interface Header {
  kind: VaultType["kind"];
  name: string;
  supertypes: string[];
  primaryCtor: VaultCtor | null;
  ctorValProps: VaultProp[];
}

/** Parse a type-opening line (ends with `{`, annotations already relevant-stripped by caller). */
function parseTypeHeader(line: string, lineNo: number): Header | null {
  let s = stripAnnotations(line).replace(/\{\s*$/, "").trimEnd();
  const mods: string[] = [];
  for (;;) {
    const m = MODIFIERS.exec(s);
    if (!m) break;
    const word = m[0].trim();
    // `enum X`: the keyword doubles as the kind (the corpus never writes `enum class`) — stop
    // consuming modifiers when what follows is the type NAME rather than another keyword.
    if (word === "enum" && !/^class\b/.test(s.slice(m[0].length))) {
      mods.push("enum");
      s = s.slice(m[0].length);
      break;
    }
    mods.push(word);
    s = s.slice(m[0].length);
  }
  const kw = /^(class|interface|object|typealias)\s+([A-Za-z_]\w*)/.exec(s);
  let kind: VaultType["kind"];
  let name: string;
  if (kw) {
    name = kw[2];
    kind =
      kw[1] === "class" && mods.includes("annotation") ? "annotation"
      : kw[1] === "class" && mods.includes("value") ? "value_class"
      : kw[1] === "interface" && mods.includes("fun") ? "fun_interface"
      : (kw[1] as VaultType["kind"]);
    s = s.slice(kw.index + kw[0].length);
  } else if (mods.includes("enum")) {
    const en = /^([A-Za-z_]\w*)/.exec(s);
    if (!en) return null;
    name = en[1];
    kind = "enum";
    s = s.slice(en[0].length);
  } else {
    return null;
  }
  // generics: consume balanced <>
  s = s.trimStart();
  if (s.startsWith("<")) {
    let depth = 0;
    let i = 0;
    do {
      if (s[i] === "<") depth++;
      else if (s[i] === ">" && s[i - 1] !== "-") depth--;
      i++;
    } while (i < s.length && depth > 0);
    s = s.slice(i).trimStart();
  }
  // primary ctor: optional annotations + `constructor` keyword, then a balanced paren group
  s = stripAnnotations(s);
  if (s.startsWith("constructor")) s = s.slice("constructor".length).trimStart();
  let primaryCtor: VaultCtor | null = null;
  const ctorValProps: VaultProp[] = [];
  if (s.startsWith("(")) {
    const close = matchParen(s, 0);
    if (close < 0) return null;
    const rawParams = s.slice(1, close);
    for (const rp of splitTopLevel(rawParams, ",")) {
      const isProp = /^\s*(?:@[^ ]+\s+)*(val|var)\s/.exec(rp);
      if (isProp) {
        const p = parseParams(rp)[0];
        if (p) ctorValProps.push({ name: p.name, type: p.type, mutable: isProp[1] === "var", static: false, line: lineNo });
      }
    }
    primaryCtor = ctorOf(parseParams(rawParams));
    s = s.slice(close + 1).trimStart();
  }
  // supertypes
  let supertypes: string[] = [];
  if (s.startsWith(":")) supertypes = splitTopLevel(s.slice(1), ",").map((x) => x.trim()).filter(Boolean);
  return { kind, name, supertypes, primaryCtor, ctorValProps };
}

function attachParamDocs(params: VaultParam[], paramDocs: Record<string, string>) {
  for (const p of params) if (paramDocs[p.name]) p.doc = paramDocs[p.name];
}

/** Parse a `;`-terminated member line into the owning type. */
function parseMember(line: string, lineNo: number, owner: VaultType, isStatic: boolean, paramDocs: Record<string, string> = {}, blockDoc: string | null = null) {
  let s = stripAnnotations(line.trim()).replace(/;\s*$/, "").trim();
  let suspend = false;
  for (;;) {
    const m = /^(open|abstract|override|operator|inline|final|protected|external|suspend|const)\s+/.exec(s);
    if (!m) break;
    if (m[1] === "suspend") suspend = true;
    s = s.slice(m[0].length);
  }
  if (s.startsWith("constructor")) {
    const open = s.indexOf("(");
    if (open < 0) return;
    const close = matchParen(s, open);
    if (close < 0) return;
    const ctor = ctorOf(parseParams(s.slice(open + 1, close)));
    attachParamDocs(ctor.params, paramDocs);
    owner.constructors.push(ctor);
    return;
  }
  if (/^fun\b/.test(s)) {
    s = s.slice(3).trimStart();
    if (s.startsWith("<")) {
      let depth = 0;
      let i = 0;
      do {
        if (s[i] === "<") depth++;
        else if (s[i] === ">" && s[i - 1] !== "-") depth--;
        i++;
      } while (i < s.length && depth > 0);
      s = s.slice(i).trimStart();
    }
    const open = s.indexOf("(");
    if (open < 0) return;
    const nameSeg = s.slice(0, open).trim();
    const name = nameSeg.split(/\s*\.\s*/).pop() ?? nameSeg; // extension receivers: `BadgeSize . badgePadding`
    const close = matchParen(s, open);
    if (close < 0) return;
    const after = s.slice(close + 1).trim();
    const ret = after.startsWith(":") ? normalizeType(after.slice(1)) : null;
    const params = parseParams(s.slice(open + 1, close));
    attachParamDocs(params, paramDocs);
    owner.functions.push({ name, params, returnType: ret, static: isStatic, suspend, line: lineNo });
    return;
  }
  const prop = /^(var|val)\s+([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(s);
  if (prop && !owner.properties.some((p) => p.name === prop[2])) {
    owner.properties.push({
      name: prop[2], type: normalizeType(prop[3]), mutable: prop[1] === "var", static: isStatic, line: lineNo,
      ...(blockDoc ? { doc: blockDoc } : {}),
    });
  }
}

// ── file parser ─────────────────────────────────────────────────────────────────────────────────────────

export function parseVaultFile(text: string, fileName: string, out: VaultType[]) {
  const lines = text.split("\n");
  let inComment = false;
  type Scope =
    | { kind: "package"; pkg: string }
    | { kind: "type"; type: VaultType }
    | { kind: "companion"; type: VaultType }
    | { kind: "skip" };
  const stack: Scope[] = [];
  const curPkg = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === "package") return (stack[i] as any).pkg as string;
    return "";
  };
  const curType = (): VaultType | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const sc = stack[i];
      if (sc.kind === "type" || sc.kind === "companion") return sc.type;
      if (sc.kind === "package") return null;
    }
    return null;
  };

  // Docs from the CURRENT doc block, handed to the immediately-following declaration: @param
  // lines keyed by name, plus the block's first prose line (property docs carry the unit
  // semantics — "measured in degrees"). Reset on every new `/**` so phantom doc blocks
  // (nested-enum valueOf) can't leak onto the next member.
  let paramDocs: Record<string, string> = {};
  let blockDoc: string | null = null;

  for (let n = 0; n < lines.length; n++) {
    const t = lines[n].trim();
    if (inComment) {
      const pd = /^\*\s*@param\s+(\w+)\s+(.+)$/.exec(t);
      if (pd) paramDocs[pd[1]] = pd[2].slice(0, 200);
      else if (blockDoc === null) {
        const prose = /^\*\s*([^@\s].*)$/.exec(t);
        if (prose && !prose[1].startsWith("```")) blockDoc = prose[1].slice(0, 200);
      }
      if (t.includes("*/")) inComment = false;
      continue;
    }
    if (t.startsWith("/*")) {
      paramDocs = {};
      blockDoc = null;
      if (!t.includes("*/")) inComment = true;
      continue;
    }
    if (!t || t.startsWith("* ") || t === "*") continue;
    if (t.startsWith("# ")) {
      paramDocs = {};
      continue;
    }

    const pkgM = /^package\s+([\w.]+)\s*\{$/.exec(t);
    if (pkgM) {
      stack.push({ kind: "package", pkg: pkgM[1] });
      paramDocs = {};
      continue;
    }
    if (t === "}") {
      stack.pop();
      continue;
    }
    if (t.endsWith("{")) {
      const docsForDecl = paramDocs;
      paramDocs = {};
      blockDoc = null; // a type header's class doc must not leak onto its first member
      const noAnn = stripAnnotations(t);
      if (/^typealias\s/.test(noAnn)) {
        // typealias blocks carry a vestigial `{`/`}` pair and no body
        const name = /^typealias\s+([A-Za-z_]\w*)/.exec(noAnn)?.[1];
        if (name) {
          const parent = curType();
          const dotted = parent ? `${parent.name}.${name}` : name;
          out.push({
            package: curPkg(), name: dotted, qualifiedName: `${curPkg()}.${dotted}`, kind: "typealias",
            supertypes: [], nestedIn: parent?.name ?? null, file: fileName, line: n + 1,
            constructors: [], properties: [], functions: [], enumEntries: null,
          });
        }
        stack.push({ kind: "skip" });
        continue;
      }
      if (/^object\s+Companion\s*\{$/.test(noAnn)) {
        const owner = curType();
        stack.push(owner ? { kind: "companion", type: owner } : { kind: "skip" });
        continue;
      }
      const header = parseTypeHeader(t, n + 1);
      if (header) {
        if (header.primaryCtor) attachParamDocs(header.primaryCtor.params, docsForDecl);
        const parent = curType();
        const dotted = parent ? `${parent.name}.${header.name}` : header.name;
        const entry: VaultType = {
          package: curPkg(), name: dotted, qualifiedName: `${curPkg()}.${dotted}`, kind: header.kind,
          supertypes: header.supertypes, nestedIn: parent?.name ?? null, file: fileName, line: n + 1,
          constructors: header.primaryCtor ? [header.primaryCtor] : [],
          properties: header.ctorValProps, functions: [], enumEntries: header.kind === "enum" ? [] : null,
        };
        out.push(entry);
        stack.push({ kind: "type", type: entry });
      } else {
        stack.push({ kind: "skip" }); // unknown opener — keep braces balanced
      }
      continue;
    }
    if (t.endsWith(";")) {
      const top = stack[stack.length - 1];
      if (top && (top.kind === "type" || top.kind === "companion")) {
        parseMember(t, n + 1, top.type, top.kind === "companion", paramDocs, blockDoc);
      }
      paramDocs = {};
      blockDoc = null;
      continue;
    }
    // bare enum entry — consumes its own doc block, which must not leak onto the next member
    // (e.g. the last entry's doc landing on the enum's `val value: Int;`)
    const top = stack[stack.length - 1];
    if (top?.kind === "type" && top.type.kind === "enum" && /^[A-Za-z_]\w*,?$/.test(t)) {
      top.type.enumEntries!.push(t.replace(/,$/, ""));
      paramDocs = {};
      blockDoc = null;
    }
  }
}

// ── index loading (keyed on the vault's CONTENT; no disk cache — see header comment) ────────────────────

/**
 * Task S4 — one IdentityCache per vault root, keyed on what that root actually holds.
 *
 * A vault root is a directory the CLI's utility payload materializes and REPLACES: `pico-cli
 * setup` after an SDK upgrade rewrites `knowledge/api-reference/` in place. The previous memo was
 * keyed on the root string alone, so the first successful load of a long-lived server answered
 * every later query — an agent told to ground its Kotlin in "the authoritative declarations" was
 * being handed the declarations of a vault that had already been replaced, with a file:line
 * citation pointing into bytes that no longer existed. Keying on the canonical root, the package
 * metadata and every declaration file's name + content makes a swap a cache miss.
 *
 * Still per-root rather than one global entry, because `vault_diff` deliberately loads two roots
 * back to back and neither should evict the other. Absence is still never cached.
 */
const memo = new Map<string, IdentityCache<VaultIndex | null>>();

/**
 * The selected PICO tools root the vault workspaces live under — the same candidate chain the
 * toolchain resolver uses (explicit $PICO_HOME, else the documented platform default). On a
 * platform with no documented default the historical `~/Library/PICO/sdk` spelling is kept so
 * nothing that used to resolve stops resolving; it is not a new platform default.
 */
export function vaultSdkBase(): string {
  const candidate = resolveRootCandidate({}, hostToolchainIO());
  if ("root" in candidate) return candidate.root;
  return path.join(os.homedir(), "Library", "PICO", "sdk");
}

/** `<base>/<version>/agent-vault` for a NUMERIC version label only; anything else is null (never a path). */
export function vaultRootForVersion(version: string): string | null {
  if (!isVersionToken(version)) return null;
  return path.join(vaultSdkBase(), version, "agent-vault");
}

export function defaultVaultRoot(): string {
  return process.env.PICO_AGENT_VAULT || path.join(vaultSdkBase(), "0.13", "agent-vault");
}

export type VaultRootSource = "explicit" | "version" | "env" | "default";
export type VaultSelection =
  | { status: "ok"; root: string; source: VaultRootSource; version: string | null }
  | { status: "unavailable"; code: "version-invalid" | "root-invalid"; detail: string };

/**
 * explicit vaultRoot (an explicitly identified source) > numeric sdkVersion under the selected
 * base > $PICO_AGENT_VAULT > the 0.13 default. A version label that is not `\d+.\d+[.\d+]` is
 * refused rather than joined into a path, so `../x` can never reach outside the tools root.
 */
export function resolveVaultSelection(hints: { vaultRoot?: string; sdkVersion?: string } = {}): VaultSelection {
  const explicit = (hints.vaultRoot ?? "").trim();
  if (explicit) {
    const expanded = expandHome(explicit);
    if (!path.isAbsolute(expanded)) {
      return { status: "unavailable", code: "root-invalid", detail: `vaultRoot ${JSON.stringify(explicit)} is not an absolute path; an explicit vault root must name its location outright (relative roots are not resolved against the server's working directory)` };
    }
    return { status: "ok", root: path.resolve(expanded), source: "explicit", version: null };
  }
  const version = hints.sdkVersion ?? "";
  if (version !== "") {
    const root = vaultRootForVersion(version);
    if (!root) {
      return { status: "unavailable", code: "version-invalid", detail: `sdkVersion ${JSON.stringify(version)} is not a numeric version label (expected 0.13 or 6.1.0); a version label selects a workspace under ${vaultSdkBase()} and never names a path` };
    }
    return { status: "ok", root, source: "version", version };
  }
  if (process.env.PICO_AGENT_VAULT) return { status: "ok", root: process.env.PICO_AGENT_VAULT, source: "env", version: null };
  return { status: "ok", root: defaultVaultRoot(), source: "default", version: null };
}

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The identity of a vault root: where it really is, what revision it declares, and the exact
 * declaration files it carries. Reading the bytes is the same I/O the load performs anyway — the
 * cache saves the parse, which is the expensive half.
 */
function vaultIdentity(root: string, apiDir: string, files: string[]): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(root);
  } catch {
    canonical = path.resolve(root);
  }
  let metadata = "absent";
  try {
    metadata = sha256(fs.readFileSync(path.join(root, "package.xml")));
  } catch {
    /* package.xml is optional metadata; its ABSENCE is part of the identity too */
  }
  const declarations = [...files].sort().map((f) => {
    try {
      return `${f}\0${sha256(fs.readFileSync(path.join(apiDir, f)))}`;
    } catch {
      return `${f}\0unreadable`;
    }
  });
  return [canonical, metadata, ...declarations].join("\n");
}

export function loadVaultIndex(vaultRoot?: string): VaultIndex | null {
  const root = vaultRoot ?? defaultVaultRoot();
  const apiDir = path.join(root, "knowledge", "api-reference");
  let files: string[];
  try {
    files = fs.readdirSync(apiDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  if (!files.length) return null;

  let cache = memo.get(root);
  if (!cache) memo.set(root, (cache = new IdentityCache<VaultIndex | null>()));
  return cache.getOr(
    vaultIdentity(root, apiDir, files),
    (): VaultIndex | null => {
      try {
        const all: VaultType[] = [];
        for (const f of files) parseVaultFile(fs.readFileSync(path.join(apiDir, f), "utf8"), f, all);
        const packages = new Map<string, Map<string, VaultType>>();
        for (const ty of all) {
          let m = packages.get(ty.package);
          if (!m) packages.set(ty.package, (m = new Map()));
          m.set(ty.name, ty);
        }
        let sdkVersion: string | null = null;
        try {
          sdkVersion = parsePackageRevision(fs.readFileSync(path.join(root, "package.xml"), "utf8"));
        } catch {
          /* version is optional metadata for the symbol index; declaration AUTHORITY requires it (declarationcontext.ts) */
        }
        return { vaultRoot: root, sdkVersion, packages, typeCount: all.length, fileCount: files.length };
      } catch {
        return null;
      }
    },
    // memoize ONLY successful loads — a server started before utility provisioning must pick the
    // vault up once it appears (the retry cost of an absent vault is a single failed readdirSync)
    (index) => index !== null,
  );
}

/**
 * v34.1 — the SpatialUI blind spot. `knowledge/api-reference/` documents the ECS/type surface only.
 * Compose modifiers, composables and gesture functions (rotate3D, SpatialModelView, Offset3D,
 * vibrantEffect, detectSpatialScaleGesture …) are documented in `knowledge/documentation/` instead,
 * so vault_api answered "not-found" for symbols PICO's own samples compile against — and the agent
 * contract ("never invent an SDK API; ground it in the vault") then forbade writing correct code.
 * Measured 2026-08-05 against the 8 official samples. This is a SECONDARY, prose-grade source: it
 * proves the symbol is real and cites where it is documented, but it is NOT a declaration.
 */
export type VaultDocHit = { symbol: string; file: string; line: number; excerpt: string };

export function searchVaultDocs(symbol: string, vaultRoot?: string, limit = 4): VaultDocHit[] {
  const root = vaultRoot ?? defaultVaultRoot();
  const docDir = path.join(root, "knowledge", "documentation");
  const hits: VaultDocHit[] = [];
  const bare = symbol.split(".").pop() ?? symbol;
  if (!bare || bare.length < 3) return hits;
  const needle = new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  let files: string[];
  try {
    files = fs.readdirSync(docDir).filter((f) => f.endsWith(".md"));
  } catch {
    return hits;
  }
  for (const f of files) {
    if (hits.length >= limit) break;
    let text: string;
    try {
      text = fs.readFileSync(path.join(docDir, f), "utf8");
    } catch {
      continue;
    }
    if (!needle.test(text)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (!needle.test(lines[i])) continue;
      hits.push({ symbol: bare, file: `knowledge/documentation/${f}`, line: i + 1, excerpt: lines[i].trim().slice(0, 240) });
      break; // one citation per file is enough to prove existence
    }
  }
  return hits;
}

// ── the check ───────────────────────────────────────────────────────────────────────────────────────────

/** SDK symbols that are REAL (runtime-verified by us) but absent from the vault api-reference. */
export const VAULT_ALLOWLIST: Record<string, string> = {
  GaussianSplattingResource: "runtime-verified 2026-07 (splat env pipeline); announced in vault Release notes, absent from api-reference/",
  GaussianSplattingComponent: "runtime-verified 2026-07 (splat env pipeline); announced in vault Release notes, absent from api-reference/",
};

export interface VaultFinding {
  check: "unknown-type" | "undocumented-package" | "unknown-enum-value" | "ctor-arity" | "unknown-ctor-arg" | "unit-advisory";
  severity: "warn" | "info";
  line: number;
  match: string;
  symbol: string;
  message: string;
}

const UNIT_RE = /degree|radian|lumen|meter|metre|second|millisecond|dp\b|pixel/i;

/** Unit semantics for a ctor param: its own @param doc, else the same-named property's doc. */
function unitDocFor(ty: VaultType, p: VaultParam): string | null {
  const doc = p.doc ?? ty.properties.find((x) => x.name === p.name)?.doc;
  return doc && UNIT_RE.test(doc) ? doc : null;
}

/** Is `member` a known member of `ty`: enum entry, property, function, nested type, or Companion? */
export function memberKindOf(index: VaultIndex, ty: VaultType, member: string): string | null {
  if (member === "Companion") return "companion object"; // companion members are folded into the owner
  if (ty.enumEntries?.includes(member)) return "enum entry";
  const p = ty.properties.find((x) => x.name === member);
  if (p) return p.static ? "companion constant" : "property";
  if (ty.functions.some((x) => x.name === member)) return "function";
  if (index.packages.get(ty.package)?.has(`${ty.name}.${member}`)) return "nested type";
  return null;
}

const validValuesOf = (ty: VaultType) => [
  ...(ty.enumEntries ?? []),
  ...ty.properties.filter((p) => p.static).map((p) => p.name),
];

/**
 * Strip a content line down to CODE for scanning: pure comment lines vanish, string literals are
 * emptied, trailing `//` comments are cut. Emitted Kotlin routinely names SDK symbols in log
 * strings and gotcha comments ("mode must be RigidBodyMode.STATIC") — those are prose, not usage.
 */
function codeOnly(raw: string): string {
  const t = raw.trimStart();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  let s = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const c = s.indexOf("//");
  if (c >= 0) s = s.slice(0, c);
  return s;
}

export function runVaultCheck(content: string, index: VaultIndex): VaultFinding[] {
  const findings: VaultFinding[] = [];
  // distinct dedupe namespaces per check kind — a phase-1 silent resolution must never be able to
  // suppress a phase-2 finding for the same symbol string (confirmed live in review round 2)
  const seen = new Set<string>();
  const IMPORT = /^\s*import\s+(com\.pico\.spatial(?:\.\w+)*)\.([A-Za-z_]\w*)\s*$/;
  const INLINE = /\bcom\.pico\.spatial(?:\.\w+)*\.[A-Z]\w*\b/g;

  const unknownMember = (ty: VaultType, member: string, lineNo: number, match: string) => {
    const fqSym = `${ty.qualifiedName}.${member}`;
    if (seen.has(`member:${fqSym}`)) return;
    seen.add(`member:${fqSym}`);
    const valid = validValuesOf(ty);
    findings.push({
      check: "unknown-enum-value", severity: "warn", line: lineNo, match, symbol: fqSym,
      message:
        `${member} is not an entry/constant/nested type of ${ty.name} per the agent-vault (${ty.file}:${ty.line})` +
        (valid.length ? `; valid values: ${valid.slice(0, 12).join(", ")}.` : "."),
    });
  };

  const check = (pkg: string, name: string, lineNo: number, match: string) => {
    if (!/^[A-Z]/.test(name)) return; // lowercase last segment: member/composable import — skipped
    if (pkg.startsWith("com.pico.spatial.ui")) return; // ui composables have no vault declarations
    if (VAULT_ALLOWLIST[name]) return;
    const fq = `${pkg}.${name}`;
    if (seen.has(`ref:${fq}`)) return;
    seen.add(`ref:${fq}`);
    // A qualified reference can be pkg.Type, pkg.Type.Nested (any depth), pkg.Enum.ENTRY, or
    // pkg.Type.Companion-constant. Walk backwards to the LONGEST prefix that is a real package,
    // then resolve the remainder: a dotted-prefix TYPE match is silent, and when the remainder
    // extends one segment past the deepest resolvable type, that segment is validated as a MEMBER
    // (so `...RigidBodyMode.BOGUS` written as an FQN or entry-import is caught, not just the
    // imported-simple-name form).
    const parts = fq.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const pkgPrefix = parts.slice(0, i).join(".");
      const pkgTypes = index.packages.get(pkgPrefix);
      if (!pkgTypes) continue;
      const rest = parts.slice(i);
      for (let j = rest.length; j >= 1; j--) {
        const ty = pkgTypes.get(rest.slice(0, j).join("."));
        if (!ty) continue;
        if (j === rest.length) return; // the remainder IS a type — silent
        if (memberKindOf(index, ty, rest[j])) return; // Type.MEMBER resolves — silent
        unknownMember(ty, rest[j], lineNo, match);
        return;
      }
      if (VAULT_ALLOWLIST[rest[0]]) return;
      const elsewhere = [...index.packages.entries()].filter(([, m]) => m.has(rest[0])).map(([p]) => p);
      findings.push({
        check: "unknown-type", severity: "warn", line: lineNo, match, symbol: fq,
        message:
          `${rest[0]} is not declared in ${pkgPrefix} per the agent-vault api-reference (SDK ${index.sdkVersion ?? "?"})` +
          (elsewhere.length ? `; it IS declared in: ${elsewhere.join(", ")}.` : "; no vault package declares it."),
      });
      return;
    }
    findings.push({
      check: "undocumented-package", severity: "info", line: lineNo, match, symbol: fq,
      message: `package ${pkg} has no api-reference file in the agent-vault — cannot validate (a vault coverage gap OR a wrong package path).`,
    });
  };

  // Phase 2 is driven ONLY by the content's own `import com.pico.spatial...` lines: a simple name
  // resolves to a vault type solely through an explicit import, so androidx/kotlinx/own types can
  // never resolve and therefore can never false-fire. ui.* stays excluded here too — its vault
  // docs are type-level only, so member/arity checks against it would false-positive.
  const importedTypes = new Map<string, VaultType>();
  const resolveImported = (pkg: string, name: string): VaultType | null => {
    const parts = `${pkg}.${name}`.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const pkgTypes = index.packages.get(parts.slice(0, i).join("."));
      if (pkgTypes) return pkgTypes.get(parts.slice(i).join(".")) ?? null;
    }
    return null;
  };

  const lines = content.split("\n");
  const code = lines.map(codeOnly);
  for (let i = 0; i < lines.length; i++) {
    const im = IMPORT.exec(lines[i]);
    if (im) {
      check(im[1], im[2], i + 1, lines[i].trim().slice(0, 160));
      if (/^[A-Z]/.test(im[2]) && !im[1].startsWith("com.pico.spatial.ui")) {
        const ty = resolveImported(im[1], im[2]);
        if (ty) importedTypes.set(im[2], ty);
      }
      continue;
    }
    for (const m of code[i].matchAll(INLINE)) {
      const fq = m[0];
      const dot = fq.lastIndexOf(".");
      check(fq.slice(0, dot), fq.slice(dot + 1), i + 1, lines[i].trim().slice(0, 160));
    }
  }
  if (importedTypes.size) {
    // tight dot only: doc prose like "VideoPlayerComponent. Call SceneVideo..." (sentence boundary
    // + capitalized word) must not read as a member access — emitted code never spaces the dot
    const MEMBER_ACCESS = /(?<![.@\w])([A-Z]\w*)\.([A-Z][A-Za-z0-9_]*)\b(?!\s*\()/g;
    const CALL = /(?<![.@\w])([A-Z]\w*)\s*\(/g;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s/.test(lines[i]) || !code[i]) continue;
      // enum entries / companion constants / nested types: Type.MEMBER (uppercase member, non-call)
      for (const m of code[i].matchAll(MEMBER_ACCESS)) {
        const ty = importedTypes.get(m[1]);
        if (!ty) continue;
        if (!memberKindOf(index, ty, m[2])) unknownMember(ty, m[2], i + 1, lines[i].trim().slice(0, 160));
      }
      // constructor arity: Type(...) closing on the same line (multi-line calls are skipped).
      // String literals were emptied by codeOnly and splitTopLevel tracks {} — so commas inside
      // string args or inline lambdas don't inflate the count; a trailing lambda counts as one arg.
      for (const m of code[i].matchAll(CALL)) {
        const ty = importedTypes.get(m[1]);
        if (!ty || !ty.constructors.length) continue;
        const open = m.index! + m[0].length - 1;
        const close = matchParen(code[i], open);
        if (close < 0) continue;
        const inside = code[i].slice(open + 1, close).trim();
        const argList = inside ? splitTopLevel(inside, ",") : [];
        let n = argList.length;
        if (/^\s*\{/.test(code[i].slice(close + 1))) n++; // trailing-lambda argument
        // v15.3: named-argument validation — a misspelled name is a guaranteed compile error the
        // agent can fix NOW, with the real names cited.
        const namedArgs = argList.map((a) => /^\s*([A-Za-z_]\w*)\s*=[^=]/.exec(a)?.[1]).filter((x): x is string => !!x);
        if (namedArgs.length) {
          const validNames = new Set(ty.constructors.flatMap((c) => c.params.map((p) => p.name)));
          for (const na of namedArgs) {
            if (validNames.has(na)) continue;
            const fqSym = `${ty.qualifiedName}(${na} = …)`;
            if (seen.has(`arg:${fqSym}`)) continue;
            seen.add(`arg:${fqSym}`);
            findings.push({
              check: "unknown-ctor-arg", severity: "warn", line: i + 1, match: lines[i].trim().slice(0, 160), symbol: fqSym,
              message: `no ${ty.name} constructor has a parameter named '${na}' per the agent-vault (${ty.file}:${ty.line}); parameter names: ${[...validNames].join(", ")}.`,
            });
          }
        }
        // v15.3: unit advisory — bare numeric literals flowing into unit-documented params (the
        // check that would have caught the spotlight radians bug mechanically). info-weight, once
        // per type; fires only for all-positional calls that match an overload exactly.
        if (!namedArgs.length && !seen.has(`unit:${ty.qualifiedName}`)) {
          const overload = ty.constructors.find((c) => n >= c.minArity && n <= c.maxArity && c.params.length >= n);
          if (overload) {
            const unitHits = argList
              .map((a, idx) => ({ arg: a.trim(), p: overload.params[idx] }))
              .filter((x) => x.p && /^-?\d[\d_.]*f?$/i.test(x.arg))
              .map((x) => ({ name: x.p.name, doc: unitDocFor(ty, x.p) }))
              .filter((x): x is { name: string; doc: string } => !!x.doc);
            if (unitHits.length) {
              seen.add(`unit:${ty.qualifiedName}`);
              findings.push({
                check: "unit-advisory", severity: "info", line: i + 1, match: lines[i].trim().slice(0, 160), symbol: `${ty.qualifiedName}(units)`,
                message:
                  `unit-sensitive parameters receive numeric literals — verify units against the vault (${ty.file}:${ty.line}): ` +
                  unitHits.map((u) => `${u.name} ("${u.doc.slice(0, 80)}")`).join("; ") + ".",
              });
            }
          }
        }
        if (!ty.constructors.some((c) => n >= c.minArity && n <= c.maxArity)) {
          const fqSym = `${ty.qualifiedName}(${n} args)`;
          if (seen.has(`arity:${fqSym}`)) continue;
          seen.add(`arity:${fqSym}`);
          const arities = ty.constructors.map((c) => (c.minArity === c.maxArity ? `${c.maxArity}` : `${c.minArity}-${c.maxArity}`)).join(" | ");
          findings.push({
            check: "ctor-arity", severity: "warn", line: i + 1, match: lines[i].trim().slice(0, 160), symbol: fqSym,
            message: `${ty.name} has no constructor taking ${n} arg(s) per the agent-vault (${ty.file}:${ty.line}); declared arities: ${arities}.`,
          });
        }
      }
    }
  }
  return findings;
}

// ── the vault_api lookup tool ───────────────────────────────────────────────────────────────────────────

const fmtParam = (p: VaultParam) => `${p.name}: ${p.type}${p.hasDefault ? " = <default>" : ""}${p.doc ? `  // ${p.doc}` : ""}`;

const DEFAULT_VAULT_SDK_VERSION = "0.13.3";
const SDK_600_DRIFT_DOC = "docs/SDK_6_0_0_DRIFT.md";

// ── declaration authority (Task S5) ─────────────────────────────────────────────────────────────────────

export interface DeclarationAuthorityHints {
  /** An Android project root whose declared BOM / resolved SDK the answer should be bound to. A hint, not an identity. */
  projectRoot?: string;
  /** Reviewed compatibility records to consider; only paths listed in the packaged index can ever be accepted. */
  recordPaths?: readonly string[];
}

export type SymbolAuthority = "unavailable" | "historical" | "unknown" | "incompatible" | "target-compatible";

/**
 * The state of the package-owned reviewed index, reported DISTINCTLY from "no records": an
 * index that is missing (not packaged, not readable) or invalid (schema, or a referenced file
 * whose bytes no longer match) means nothing can be verified — which is not the same fact as a
 * present index that lists no reviewed mappings yet.
 */
export interface CompatibilityIndexState {
  status: "present" | "missing" | "invalid";
  path: string;
  code: string | null;
  detail: string | null;
  records: number;
}

export function describeCompatibilityIndex(io: DeclarationIO = hostDeclarationIO()): { state: CompatibilityIndexState; result: CompatibilityIndexResult } {
  const result = readCompatibilityIndex(io);
  const state: CompatibilityIndexState = result.status === "ok"
    ? { status: "present", path: SDK_COMPATIBILITY_INDEX_PATH, code: null, detail: null, records: result.index.records.length }
    : { status: result.code === "index-missing" ? "missing" : "invalid", path: SDK_COMPATIBILITY_INDEX_PATH, code: result.code, detail: result.detail, records: 0 };
  return { state, result };
}

export interface DeclarationAuthorityReport {
  compatibilityIndex: CompatibilityIndexState;
  declarationIdentity:
    | { status: "ok"; root: string; packageRevision: string | null; authority: "declarations" | "prose"; fingerprint: string; sourceCount: number }
    | { status: "unavailable"; code: string; detail: string };
  target: { projectRoot: string; fingerprint: string; declaredBom: string | null; status: ProjectSdkIdentity["status"]; reasons: readonly string[] } | null;
  evidence: {
    index: string;
    accepted: { id: string; path: string; sha256: string; verdict: "compatible" | "incompatible"; targetBom: string; symbols: readonly string[] }[];
    rejected: readonly { path: string; code: string; detail: string }[];
  } | null;
  context: { status: DeclarationContext["status"]; evidencePaths: readonly string[]; verifiedSymbols: readonly string[] } | null;
  note: string;
}

/** What describeDeclarationAuthority read: the public report plus the SDK-owned objects the door result is derived from. */
export interface DeclarationAuthority {
  report: DeclarationAuthorityReport;
  identity: DeclarationIdentityResult;
  target: ProjectSdkIdentity | null;
  accepted: readonly VerifiedCompatibilityEvidence[];
  context: DeclarationContext | null;
}

function contextNote(identity: DeclarationIdentityResult, target: ProjectSdkIdentity | null, context: DeclarationContext | null, loaded: CompatibilityLoadResult | null, compatibilityIndex: CompatibilityIndexState): string {
  if (identity.status !== "ok") {
    return `Declaration identity unavailable (${identity.code}): ${identity.detail}. The symbol index below (when present) is a HISTORICAL lookup with no declared package revision behind it and no target authority.`;
  }
  const revision = identity.identity.packageRevision ?? "an undeclared revision";
  if (identity.identity.authority === "prose") {
    return `${identity.identity.root} carries prose documentation only (${revision}); prose never grants declaration authority.`;
  }
  if (!target) {
    return `HISTORICAL lookup: these declarations describe package revision ${revision} as materialized at ${identity.identity.root}. No project was supplied, so nothing here is target-verified — pass projectRoot to bind the answer to a project's declared BOM and resolved SDK artifacts.`;
  }
  const bom = target.declaredBom ?? "no literal BOM";
  const rejections = loaded?.rejected.length ? ` Rejected records: ${loaded.rejected.map((r) => `${r.code}`).join(", ")}.` : "";
  switch (context?.status) {
    case "target-compatible":
      return `Target-verified: a reviewed compatibility record binds these ${revision} declarations to project ${target.projectRoot} (BOM ${bom}) for the listed verifiedSymbols only; any other symbol remains unknown.${rejections}`;
    case "incompatible":
      return `INCOMPATIBLE: a reviewed record verifies that at least one scoped signature of these ${revision} declarations does NOT hold for project ${target.projectRoot} (BOM ${bom}); verifiedSymbols lists the scopes that do.${rejections}`;
    default: {
      const why = compatibilityIndex.status === "missing"
        ? `the reviewed compatibility index is missing (${compatibilityIndex.code}: ${compatibilityIndex.detail}), so nothing can be verified`
        : compatibilityIndex.status === "invalid"
          ? `the reviewed compatibility index is invalid (${compatibilityIndex.code}: ${compatibilityIndex.detail}), so nothing can be verified`
          : compatibilityIndex.records === 0 && !loaded?.rejected.length
            ? `the reviewed compatibility index lists no records, so nothing verifies these ${revision} declarations`
            : `no reviewed compatibility record verifies these ${revision} declarations`;
      return `Target linkage UNKNOWN for project ${target.projectRoot} (BOM ${bom}, identity ${target.status}): ${why}. Treat every declaration as historical ${revision} truth, not as a statement about the project's SDK.${rejections}`;
    }
  }
}

/**
 * Read the vault's declaration identity, the project's declared identity (when a root hint is
 * given) and whatever reviewed evidence links them. Hints select what is READ; nothing in them is
 * trusted as an identity, a fingerprint or a verdict — the SDK-owned reader and loader decide.
 */
export function describeDeclarationAuthority(vaultRoot: string, hints: DeclarationAuthorityHints = {}, io: DeclarationIO = hostDeclarationIO()): DeclarationAuthority {
  const identity = readDeclarationIdentity(vaultRoot, io);
  const target = hints.projectRoot?.trim() ? readProjectSdkIdentity(hints.projectRoot.trim()) : null;
  const { state: compatibilityIndex, result: index } = describeCompatibilityIndex(io);
  let loaded: CompatibilityLoadResult | null = null;
  let context: DeclarationContext | null = null;
  if (identity.status === "ok") {
    if (target) {
      const indexed = index.status === "ok" ? index.index.records.map((r) => path.join(SDK_COMPATIBILITY_DATA_DIR, ...r.path.split("/"))) : [];
      const paths = hints.recordPaths?.length ? hints.recordPaths : indexed;
      loaded = loadVerifiedCompatibilityEvidence(paths, identity.identity, target, io);
    }
    context = resolveDeclarationContext(identity.identity, target, loaded?.accepted ?? []);
  }
  const report: DeclarationAuthorityReport = {
    compatibilityIndex,
    declarationIdentity: identity.status === "ok"
      ? { status: "ok", root: identity.identity.root, packageRevision: identity.identity.packageRevision, authority: identity.identity.authority, fingerprint: identity.identity.fingerprint, sourceCount: identity.identity.sources.length }
      : { status: "unavailable", code: identity.code, detail: identity.detail },
    target: target ? { projectRoot: target.projectRoot, fingerprint: target.fingerprint, declaredBom: target.declaredBom, status: target.status, reasons: target.reasons } : null,
    evidence: loaded
      ? {
        index: SDK_COMPATIBILITY_INDEX_PATH,
        accepted: loaded.accepted.map((e) => ({ id: e.id, path: e.record.path, sha256: e.record.sha256, verdict: e.verdict, targetBom: e.targetBom, symbols: e.symbols })),
        rejected: loaded.rejected,
      }
      : null,
    context: context ? { status: context.status, evidencePaths: context.evidencePaths, verifiedSymbols: context.verifiedSymbols } : null,
    note: contextNote(identity, target, context, loaded, compatibilityIndex),
  };
  return { report, identity, target, accepted: loaded?.accepted ?? [], context };
}

export interface LookupHeadline {
  symbolAuthority: SymbolAuthority;
  /** `target-verified` only when the headline is a verified verdict; everything else is a historical lookup. */
  lookup: "historical" | "target-verified";
  /** Exactly the returned matches that are inside the verified-compatible scope. */
  verifiedMatches: string[];
  /** Exactly the returned matches that a verified record marks incompatible. */
  incompatibleMatches: string[];
}

/**
 * The headline for ONE lookup over the matches it returns. Conservative in both directions: any
 * match a verified record marks incompatible headlines `incompatible`; `target-compatible` requires
 * EVERY returned match to be in the verified scope — one verified `Entity` beside an unverified
 * same-named `Entity` from another package is `unknown`, with `verifiedMatches` naming the one.
 */
export function lookupHeadline(authority: Pick<DeclarationAuthority, "identity" | "target" | "accepted" | "context">, matchNames: readonly string[]): LookupHeadline {
  const none = { lookup: "historical" as const, verifiedMatches: [] as string[], incompatibleMatches: [] as string[] };
  if (authority.identity.status !== "ok" || !authority.context) return { symbolAuthority: "unavailable", ...none };
  if (!authority.target) return { symbolAuthority: "historical", ...none };
  const { context } = authority;
  if (context.status === "unknown" || authority.identity.identity.authority !== "declarations") return { symbolAuthority: "unknown", ...none };
  const applicable = authority.accepted.filter((e) => context.evidencePaths.includes(e.record.path));
  const incompatible = new Set(applicable.filter((e) => e.verdict === "incompatible").flatMap((e) => [...e.symbols]));
  const names = [...new Set(matchNames)];
  const incompatibleMatches = names.filter((name) => incompatible.has(name));
  const verifiedMatches = names.filter((name) => context.verifiedSymbols.includes(name));
  const symbolAuthority: SymbolAuthority = incompatibleMatches.length
    ? "incompatible"
    : names.length > 0 && verifiedMatches.length === names.length
      ? "target-compatible"
      : "unknown";
  return {
    symbolAuthority,
    lookup: symbolAuthority === "target-compatible" || symbolAuthority === "incompatible" ? "target-verified" : "historical",
    verifiedMatches,
    incompatibleMatches,
  };
}

function vaultProvenance(index: VaultIndex | null, selection?: VaultSelection, authority?: DeclarationAuthority) {
  const identity = authority?.identity;
  return {
    declarationSource: "PICO agent-vault knowledge/api-reference",
    defaultSdkVersion: DEFAULT_VAULT_SDK_VERSION,
    activeSdkVersion: index?.sdkVersion ?? null,
    packageRevision: identity?.status === "ok" ? identity.identity.packageRevision : null,
    declarationAuthority: identity?.status === "ok" ? identity.identity.authority : "unavailable",
    vaultRoot: selection?.status === "ok" ? selection.root : null,
    rootSource: selection?.status === "ok" ? selection.source : null,
    sdk600DriftDoc: SDK_600_DRIFT_DOC,
    note: `Default declarations come from the ${DEFAULT_VAULT_SDK_VERSION} vault and are HISTORICAL: they describe that package revision. The app skeleton builds on SDK 6.0.0; ${SDK_600_DRIFT_DOC} records the measured near-zero public-API drift as historical evidence, not target authority. A declaration is target-verified only when a reviewed record in ${SDK_COMPATIBILITY_INDEX_PATH} verifies against the local vault bytes and the project's exact resolved SDK artifacts.`,
  };
}

function typeCard(t: VaultType) {
  return {
    qualifiedName: t.qualifiedName,
    kind: t.kind,
    supertypes: t.supertypes,
    vaultRef: `knowledge/api-reference/${t.file}:${t.line}`,
    constructors: t.constructors.map((c) => ({ arity: c.minArity === c.maxArity ? `${c.maxArity}` : `${c.minArity}-${c.maxArity}`, params: c.params.map(fmtParam) })),
    properties: t.properties.slice(0, 80).map((p) => `${p.static ? "static " : ""}${p.mutable ? "var" : "val"} ${p.name}: ${p.type}${p.doc ? `  // ${p.doc}` : ""}`),
    functions: t.functions.slice(0, 80).map((f) => `${f.static ? "static " : ""}${f.suspend ? "suspend " : ""}fun ${f.name}(${f.params.map(fmtParam).join(", ")})${f.returnType ? ` : ${f.returnType}` : ""}`),
    ...(t.enumEntries ? { enumEntries: t.enumEntries } : {}),
  };
}

export function registerVaultTools(server: McpServer) {
  const managedSetupGuidance = "Call ensure_pico_cli, then manually run its returned absolute path with args [\"setup\"]; the MCP never runs setup.";
  server.registerTool(
    "vault_api",
    {
      description:
        "Look up the EXACT declaration of a PICO Spatial SDK symbol in the agent-vault api-reference (materialized by the CLI's separately provisioned utility payload) — constructors with param names/order/defaults, @param unit docs ('measured in degrees'), properties, functions, enum entries, supertypes, and the vault file:line citation. AUTHORITY IS EXPLICIT: the default declarations come from the 0.13.3 vault and every answer is labeled with the package revision its package.xml declares; the app skeleton builds on SDK 6.0.0, and docs/SDK_6_0_0_DRIFT.md records the measured near-zero public-API drift as historical evidence, not target authority. Pass projectRoot to bind the answer to that project's declared BOM: the result then reports declarationIdentity, target and declarationContext (target-compatible / unknown / incompatible) from SDK-owned reading of local bytes and reviewed compatibility records — hints select what is read, they never assert a verdict. Without a verified linkage the lookup is historical/unknown and says so. Consult BEFORE emitting Kotlin that calls an SDK API you have not used before — all-Float signatures compile silently with swapped/wrong-unit args (the createCapsule and SpotLightComponent bugs). Accepts a simple name ('RigidBodyComponent'), dotted nested name ('AnchorComponent.TrackingMode'), or full FQN.",
      inputSchema: {
        symbol: z.string().describe("Type name to look up: simple ('ShapeResource'), nested dotted ('Entity.CloneOptions'), or fully qualified ('com.pico.spatial.core.ecs.RigidBodyComponent')."),
        sdkVersion: z.string().optional().describe("v26: query a materialized vault workspace by NUMERIC version label (e.g. '0.13' -> <tools root>/0.13/agent-vault; see vault_workspaces). Not a path, and not a claim about what the declarations are — the answer reports the revision package.xml declares. Default: the active vault."),
        vaultRoot: z.string().optional().describe("Explicit agent-vault root to read instead of the version/default resolution. An explicitly identified SOURCE, not proof of target compatibility."),
        projectRoot: z.string().optional().describe("Android project root hint: its declared BOM and identity are read statically (never Gradle) and reviewed compatibility evidence is verified against it. Omit for a plain historical lookup."),
        recordPaths: z.array(z.string()).optional().describe("Reviewed compatibility record paths to consider. Only records listed in the packaged reviewed index can be accepted; a caller path never adds a trust anchor."),
      },
    },
    async ({ symbol, sdkVersion, vaultRoot, projectRoot, recordPaths }) => {
      const selection = resolveVaultSelection({ vaultRoot, sdkVersion });
      if (selection.status !== "ok") {
        return okJson({
          status: "unavailable", code: selection.code, symbol: symbol.trim(), symbolAuthority: "unavailable" as SymbolAuthority,
          note: `${selection.detail}. agent-vault workspaces live under ${vaultSdkBase()} (override the default with PICO_AGENT_VAULT). ${managedSetupGuidance}`,
          compatibilityIndex: describeCompatibilityIndex().state,
          vaultProvenance: vaultProvenance(null, selection),
        });
      }
      const root = selection.root;
      const authority = describeDeclarationAuthority(root, { projectRoot, recordPaths });
      const index = loadVaultIndex(root);
      if (!index) {
        return okJson({
          status: "unavailable", symbol: symbol.trim(), symbolAuthority: "unavailable" as SymbolAuthority,
          note: `agent-vault not found (${selection.source === "default" ? `default ${root}` : `${root} from ${selection.source}`}, override with PICO_AGENT_VAULT). ${managedSetupGuidance}`,
          vaultSelection: { root, source: selection.source, version: selection.version },
          declarationIdentity: authority.report.declarationIdentity,
          target: authority.report.target,
          compatibilityIndex: authority.report.compatibilityIndex,
          vaultProvenance: vaultProvenance(null, selection, authority),
        });
      }
      // The headline is computed over the matches a result RETURNS, never over the query string
      // alone: every returned match must be verified before the result is called target-verified.
      const authorityFields = (matchNames: readonly string[]) => {
        const headline = lookupHeadline(authority, matchNames);
        return {
          symbolAuthority: headline.symbolAuthority,
          lookup: headline.lookup,
          verifiedMatches: headline.verifiedMatches,
          incompatibleMatches: headline.incompatibleMatches,
          vaultSelection: { root, source: selection.source, version: selection.version },
          declarationIdentity: authority.report.declarationIdentity,
          target: authority.report.target,
          compatibilityIndex: authority.report.compatibilityIndex,
          declarationContext: authority.report.context ? { ...authority.report.context, rejected: authority.report.evidence?.rejected ?? [], note: authority.report.note } : { status: "unavailable" as const, rejected: [], note: authority.report.note },
          vaultProvenance: vaultProvenance(index, selection, authority),
        };
      };
      const wanted = symbol.trim();
      const matches: VaultType[] = [];
      let memberNote: string | undefined;
      const lookup = (q: string): VaultType[] => {
        const hits: VaultType[] = [];
        if (q.startsWith("com.pico.spatial")) {
          const parts = q.split(".");
          for (let i = parts.length - 1; i >= 1; i--) {
            const pkgTypes = index.packages.get(parts.slice(0, i).join("."));
            if (!pkgTypes) continue;
            const hit = pkgTypes.get(parts.slice(i).join("."));
            if (hit) hits.push(hit);
            break;
          }
        } else {
          for (const m of index.packages.values()) {
            for (const [name, t] of m) {
              if (name === q || name.endsWith(`.${q}`)) hits.push(t);
            }
          }
        }
        return hits;
      };
      matches.push(...lookup(wanted));
      // "Type.MEMBER" queries (enum entry, constant, property, function) resolve to the owning
      // type's card instead of a misleading not-found — the natural query right before emitting
      // that exact symbol.
      if (!matches.length && wanted.includes(".")) {
        const dot = wanted.lastIndexOf(".");
        const member = wanted.slice(dot + 1);
        for (const owner of lookup(wanted.slice(0, dot))) {
          const kind = memberKindOf(index, owner, member);
          if (kind) {
            matches.push(owner);
            memberNote = `${member} is a ${kind} of ${owner.qualifiedName} — full type card returned.`;
          }
        }
      }
      if (!matches.length) {
        const needle = wanted.toLowerCase().split(".").pop()!;
        const near = new Set<string>();
        for (const m of index.packages.values())
          for (const [name, t] of m)
            if (name.toLowerCase().includes(needle)) near.add(t.qualifiedName);
        const docHits = searchVaultDocs(wanted, index.vaultRoot);
        const revisionLabel = authority.identity.status === "ok" && authority.identity.identity.packageRevision ? `package revision ${authority.identity.identity.packageRevision}` : `SDK ${index.sdkVersion ?? "?"} (revision undeclared)`;
        // With a target whose linkage is not verified, an absence is a fact about the HISTORICAL
        // declarations only — it must never read as "the target SDK lacks this symbol".
        const absenceScope = authority.target
          ? ` This absence is a fact about the historical ${revisionLabel} declarations; it says nothing about project ${authority.target.projectRoot}'s SDK (${authority.target.declaredBom ?? "no literal BOM"}) — target linkage is ${authority.context?.status ?? "unavailable"}.`
          : "";
        if (docHits.length) {
          return okJson({
            status: "documented-only", sdkVersion: index.sdkVersion, symbol: wanted,
            note: "NOT in api-reference/ (which covers the ECS/type surface), but documented in the vault's prose docs — this is the SpatialUI/Compose surface: modifiers, composables and gesture functions. The symbol is REAL; the api-reference simply does not carry it. Read the cited doc for the call shape — do NOT invent parameters it does not show. Prose is secondary evidence and grants no declaration authority." + absenceScope,
            documentation: docHits,
            ...authorityFields([wanted]),
            ...(near.size ? { similar: [...near].slice(0, 10) } : {}),
          });
        }
        return okJson({
          status: "not-found", sdkVersion: index.sdkVersion, symbol: wanted,
          note: `no vault declaration and no prose-doc mention in the ${revisionLabel} vault — either the symbol does not exist in that revision or it is a vault coverage gap (cf. GaussianSplatting*). Do NOT invent a signature.` + absenceScope,
          ...authorityFields([wanted]),
          ...(near.size ? { similar: [...near].slice(0, 10) } : {}),
        });
      }
      const returned = matches.slice(0, 5);
      return okJson({
        status: "ok", sdkVersion: index.sdkVersion,
        ...(memberNote ? { note: memberNote } : {}),
        matches: returned.map(typeCard),
        ...authorityFields(returned.map((t) => t.qualifiedName)),
      });
    },
  );
}
