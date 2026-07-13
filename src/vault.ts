import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * vault.ts — v14.6 the AGENT-VAULT SYMBOL INDEX + the preflight vault check.
 *
 * `pico-cli setup` materializes PICO's authoritative SDK API reference (the "agent-vault") at
 * ~/Library/PICO/sdk/0.13/agent-vault/knowledge/api-reference/ — 54 per-package markdown files of
 * pseudo-Kotlin declarations (419 top-level types, SDK 0.13.3). This module parses them into an
 * in-memory symbol index and validates emitted Kotlin against it. Phase 1 scope: TYPE-EXISTENCE
 * for `import com.pico.spatial.*` lines and inline FQN usages, non-ui packages only. Wired into
 * preflight_lint as a separate advisory `vault` block — findings NEVER affect `clean`, and an
 * absent vault degrades to status:"unavailable" (machines without pico-cli setup lose nothing).
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
 * The index is memoized per vault root; parsing the 1.3MB api-reference takes ~50ms, so there is
 * deliberately NO disk cache (a cache adds a staleness bug class to save 50ms once per process).
 */

export interface VaultParam {
  name: string;
  type: string;
  hasDefault: boolean;
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

/** Split a param list on top-level commas — bracket-aware incl. generics, with a `->` guard. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
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

/** Parse a `;`-terminated member line into the owning type. */
function parseMember(line: string, lineNo: number, owner: VaultType, isStatic: boolean) {
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
    owner.constructors.push(ctorOf(parseParams(s.slice(open + 1, close))));
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
    owner.functions.push({ name, params: parseParams(s.slice(open + 1, close)), returnType: ret, static: isStatic, suspend, line: lineNo });
    return;
  }
  const prop = /^(var|val)\s+([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(s);
  if (prop && !owner.properties.some((p) => p.name === prop[2])) {
    owner.properties.push({ name: prop[2], type: normalizeType(prop[3]), mutable: prop[1] === "var", static: isStatic, line: lineNo });
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

  for (let n = 0; n < lines.length; n++) {
    const t = lines[n].trim();
    if (inComment) {
      if (t.includes("*/")) inComment = false;
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inComment = true;
      continue;
    }
    if (!t || t.startsWith("* ") || t === "*" || t.startsWith("# ")) continue;

    const pkgM = /^package\s+([\w.]+)\s*\{$/.exec(t);
    if (pkgM) {
      stack.push({ kind: "package", pkg: pkgM[1] });
      continue;
    }
    if (t === "}") {
      stack.pop();
      continue;
    }
    if (t.endsWith("{")) {
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
        parseMember(t, n + 1, top.type, top.kind === "companion");
      }
      continue;
    }
    // bare enum entry
    const top = stack[stack.length - 1];
    if (top?.kind === "type" && top.type.kind === "enum" && /^[A-Za-z_]\w*,?$/.test(t)) {
      top.type.enumEntries!.push(t.replace(/,$/, ""));
    }
  }
}

// ── index loading (memoized per root; no disk cache — see header comment) ───────────────────────────────

const memo = new Map<string, VaultIndex | null>();

export function defaultVaultRoot(): string {
  return process.env.PICO_AGENT_VAULT || path.join(os.homedir(), "Library", "PICO", "sdk", "0.13", "agent-vault");
}

export function loadVaultIndex(vaultRoot?: string): VaultIndex | null {
  const root = vaultRoot ?? defaultVaultRoot();
  if (memo.has(root)) return memo.get(root)!;
  let index: VaultIndex | null = null;
  try {
    const apiDir = path.join(root, "knowledge", "api-reference");
    const files = fs.readdirSync(apiDir).filter((f) => f.endsWith(".md"));
    if (files.length) {
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
        const xml = fs.readFileSync(path.join(root, "package.xml"), "utf8");
        const rm = /<revision><major>(\d+)<\/major><minor>(\d+)<\/minor>(?:<micro>(\d+)<\/micro>)?/.exec(xml);
        if (rm) sdkVersion = rm[3] !== undefined ? `${rm[1]}.${rm[2]}.${rm[3]}` : `${rm[1]}.${rm[2]}`;
      } catch {
        /* version is optional metadata */
      }
      index = { vaultRoot: root, sdkVersion, packages, typeCount: all.length, fileCount: files.length };
    }
  } catch {
    index = null;
  }
  // memoize ONLY successful loads — a server started before `pico-cli setup` must pick the vault
  // up once it appears (the retry cost of an absent vault is a single failed readdirSync)
  if (index) memo.set(root, index);
  return index;
}

// ── the check ───────────────────────────────────────────────────────────────────────────────────────────

/** SDK symbols that are REAL (runtime-verified by us) but absent from the vault api-reference. */
export const VAULT_ALLOWLIST: Record<string, string> = {
  GaussianSplattingResource: "runtime-verified 2026-07 (splat env pipeline); announced in vault Release notes, absent from api-reference/",
  GaussianSplattingComponent: "runtime-verified 2026-07 (splat env pipeline); announced in vault Release notes, absent from api-reference/",
};

export interface VaultFinding {
  check: "unknown-type" | "undocumented-package";
  severity: "warn" | "info";
  line: number;
  match: string;
  symbol: string;
  message: string;
}

export function runVaultCheck(content: string, index: VaultIndex): VaultFinding[] {
  const findings: VaultFinding[] = [];
  const seen = new Set<string>();
  const IMPORT = /^\s*import\s+(com\.pico\.spatial(?:\.\w+)*)\.([A-Za-z_]\w*)\s*$/;
  const INLINE = /\bcom\.pico\.spatial(?:\.\w+)*\.[A-Z]\w*\b/g;

  const check = (pkg: string, name: string, lineNo: number, match: string) => {
    if (!/^[A-Z]/.test(name)) return; // lowercase last segment: member/composable import — phase 1 skips
    if (pkg.startsWith("com.pico.spatial.ui")) return; // ui composables have no vault declarations
    if (VAULT_ALLOWLIST[name]) return;
    const fq = `${pkg}.${name}`;
    if (seen.has(fq)) return;
    seen.add(fq);
    // A qualified reference can be pkg.Type, pkg.Type.Nested (any depth), pkg.Enum.ENTRY, or
    // pkg.Type.Companion-constant. Walk backwards to the LONGEST prefix that is a real package,
    // then accept if ANY dotted prefix of the remainder resolves to an indexed type — member-level
    // validation (enum entries, companion constants) is deliberately phase 2, so a resolvable TYPE
    // prefix is enough to stay silent. This is what keeps advisory findings false-positive-free.
    const parts = fq.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const pkgPrefix = parts.slice(0, i).join(".");
      const pkgTypes = index.packages.get(pkgPrefix);
      if (!pkgTypes) continue;
      const rest = parts.slice(i);
      for (let j = rest.length; j >= 1; j--) {
        if (pkgTypes.has(rest.slice(0, j).join("."))) return; // resolves — silent
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

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const im = IMPORT.exec(lines[i]);
    if (im) {
      check(im[1], im[2], i + 1, lines[i].trim().slice(0, 160));
      continue;
    }
    for (const m of lines[i].matchAll(INLINE)) {
      const fq = m[0];
      const dot = fq.lastIndexOf(".");
      check(fq.slice(0, dot), fq.slice(dot + 1), i + 1, lines[i].trim().slice(0, 160));
    }
  }
  return findings;
}
