import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", ".gradle", ".cache", "build", "cache", "caches"]);
const DSL_CONTINUATION_TOKENS = new Set([".", "&", "?", "*", ":", "+", "-", "/", "%", "=", "|", "^", "!", "<", ">", ",", "(", "[", "@", "as", "in", "is"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** @typedef {{path:string, absolutePath:string, kind:"kotlin"|"gradle"|"manifest", original:string, structural:string}} SourceFile */
/** @typedef {{pluginIds:string[], moduleCoordinates:string[], versions:Record<string,string>, applicationIds:string[]}} GradleFacts */
/** @typedef {{applicationName:string|null, activities:string[], metadata:Array<{name:string,value:string|null,resource:string|null}>}} ManifestFacts */
/** @typedef {{kind:string,value:string,key?:string,alias?:string|null,version?:string|null,versionRef?:string|null,metadata?:{name:string,value:string|null,resource:string|null},path:string,line:number,excerpt:string}} FactEvidence */
/** @typedef {{projectDir:string, files:SourceFile[], totalBytes:number, facts:{gradle:GradleFacts,manifest:ManifestFacts},factEvidence:FactEvidence[]}} SourceIndex */

function fail(message) {
  throw new Error(`submission source rejected: ${message}`);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceAt(source, pathName, offset, fact) {
  const line = source.slice(0, offset).split("\n").length;
  return { ...fact, path: pathName, line, excerpt: source.split(/\r?\n/)[line - 1].trim() };
}

function freezeFact(fact) {
  if (fact.metadata) Object.freeze(fact.metadata);
  return Object.freeze(fact);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function selectedKind(relativePath) {
  const basename = path.posix.basename(relativePath);
  if (basename === "AndroidManifest.xml") return "manifest";
  if (relativePath.endsWith(".gradle") || relativePath.endsWith(".gradle.kts") || relativePath.endsWith(".toml")) return "gradle";
  if (relativePath.endsWith(".kt") || relativePath.endsWith(".kts")) return "kotlin";
  return null;
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
  }
}

function slashyCanStart(source, index) {
  let previous = index - 1;
  while (previous >= 0 && source[previous] !== "\n" && /[\t\r ]/.test(source[previous])) previous -= 1;
  if (previous < 0 || source[previous] === "\n" || "=([{,:;!&|?".includes(source[previous])) return true;
  if (source[previous] === ">" && source[previous - 1] === "-") return true;
  const keyword = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(source.slice(0, previous + 1))?.[1];
  return ["assert", "case", "print", "println", "return", "throw"].includes(keyword);
}

function slashyEnd(source, start) {
  let index = start;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === "/") return index;
    else index += 1;
  }
  return -1;
}

function dollarSlashyEnd(source, start) {
  for (let index = start; index < source.length - 1; index += 1) {
    if (!source.startsWith("/$", index)) continue;
    let dollars = 0;
    for (let previous = index - 1; previous >= start && source[previous] === "$"; previous -= 1) dollars += 1;
    if (dollars % 2 === 0) return index;
    index += 1;
  }
  return -1;
}

function tripleQuotedEnd(source, start, delimiter, escaped) {
  let index = start;
  while (index < source.length) {
    const candidate = source.indexOf(delimiter, index);
    if (candidate < 0) return -1;
    if (!escaped) return candidate;
    let backslashes = 0;
    for (let previous = candidate - 1; previous >= start && source[previous] === "\\"; previous -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return candidate;
    index = candidate + 1;
  }
  return -1;
}

function maskCode(source, label, groovy = false) {
  const characters = source.split("");
  let index = 0;
  while (index < source.length) {
    if (groovy && source.startsWith("$/", index)) {
      const start = index;
      const closing = dollarSlashyEnd(source, index + 2);
      if (closing < 0) fail(`${label} has an unterminated dollar-slashy string`);
      index = closing + 2;
      maskRange(characters, start, index);
      continue;
    }
    if (source.startsWith("//", index)) {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      maskRange(characters, start, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) fail(`${label} has an unterminated block comment`);
      maskRange(characters, start, index);
      continue;
    }
    if (source.startsWith('"""', index)) {
      const start = index;
      const closing = tripleQuotedEnd(source, index + 3, '"""', groovy);
      if (closing < 0) fail(`${label} has an unterminated raw string`);
      index = closing + 3;
      maskRange(characters, start, index);
      continue;
    }
    if (groovy && source.startsWith("'''", index)) {
      const start = index;
      const closing = tripleQuotedEnd(source, index + 3, "'''", true);
      if (closing < 0) fail(`${label} has an unterminated triple-single string`);
      index = closing + 3;
      maskRange(characters, start, index);
      continue;
    }
    if (groovy && source[index] === "/" && slashyCanStart(source, index)) {
      const start = index;
      const closing = slashyEnd(source, index + 1);
      if (closing < 0) fail(`${label} has an unterminated slashy string`);
      index = closing + 1;
      maskRange(characters, start, index);
      continue;
    }
    if (groovy && source[index] === "/") fail(`${label} has ambiguous slash syntax`);
    if (source[index] === '"' || source[index] === "'") {
      const start = index;
      const quote = source[index];
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (source[index] === "\n" || source[index] === "\r") fail(`${label} has an unterminated quoted literal`);
        index += 1;
      }
      if (!closed) fail(`${label} has an unterminated quoted literal`);
      maskRange(characters, start, index);
      continue;
    }
    index += 1;
  }
  return characters.join("");
}

function stripTomlComments(source, label) {
  const characters = source.split("");
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      } else if (character === "\n" || character === "\r") {
        fail(`${label} has an unterminated TOML string`);
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      const start = index;
      while (index < source.length && source[index] !== "\n") index += 1;
      maskRange(characters, start, index);
      index -= 1;
    }
  }
  if (quote !== null) fail(`${label} has an unterminated TOML string`);
  return characters.join("");
}

function maskTomlStrings(clean, label) {
  const characters = clean.split("");
  let index = 0;
  while (index < clean.length) {
    if (clean[index] !== '"' && clean[index] !== "'") {
      index += 1;
      continue;
    }
    const start = index;
    const quote = clean[index++];
    let escaped = false;
    while (index < clean.length) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && clean[index] === "\\") {
        escaped = true;
      } else if (clean[index] === quote) {
        index += 1;
        maskRange(characters, start, index);
        break;
      } else if (clean[index] === "\n" || clean[index] === "\r") {
        fail(`${label} has an unterminated TOML string`);
      }
      index += 1;
    }
    if (index >= clean.length && clean[index - 1] !== quote) fail(`${label} has an unterminated TOML string`);
  }
  return characters.join("");
}

function maskXml(source, label) {
  const characters = source.split("");
  let index = 0;
  let inTag = false;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const start = index;
      const closing = source.indexOf("-->", index + 4);
      if (closing < 0) fail(`${label} has an unterminated XML comment`);
      index = closing + 3;
      maskRange(characters, start, index);
      continue;
    }
    if (!inTag) {
      if (source[index] === "<") {
        inTag = true;
        index += 1;
      } else {
        const start = index;
        while (index < source.length && source[index] !== "<") index += 1;
        maskRange(characters, start, index);
      }
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      const start = index;
      const quote = source[index++];
      while (index < source.length && source[index] !== quote) index += 1;
      if (index >= source.length) fail(`${label} has an unterminated XML attribute`);
      index += 1;
      maskRange(characters, start, index);
    } else if (source[index] === ">") {
      inTag = false;
      index += 1;
    } else {
      index += 1;
    }
  }
  if (inTag) fail(`${label} has an unterminated XML tag`);
  return characters.join("");
}

function parseTomlQuoted(text, label) {
  if (text.length < 2 || !['"', "'"].includes(text[0]) || text.at(-1) !== text[0]) fail(`${label} must be a quoted TOML scalar`);
  const quote = text[0];
  const body = text.slice(1, -1);
  if (quote === "'") {
    if (body.includes("'")) fail(`${label} contains a malformed TOML literal string`);
    return body;
  }
  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "\\") {
      if (body[index] === '"') fail(`${label} contains an unescaped quote`);
      value += body[index];
      continue;
    }
    index += 1;
    if (index >= body.length) fail(`${label} has a trailing escape`);
    const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (!Object.hasOwn(escapes, body[index])) fail(`${label} contains an unsupported TOML escape`);
    value += escapes[body[index]];
  }
  return value;
}

function splitInlineFields(body, label) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote !== null) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ",") {
      parts.push(body.slice(start, index));
      start = index + 1;
    } else if (character === "{" || character === "}") {
      fail(`${label} contains nested TOML values`);
    }
  }
  if (quote !== null) fail(`${label} has an unterminated TOML string`);
  parts.push(body.slice(start));
  return parts;
}

function parseInlineTable(text, label) {
  if (!text.startsWith("{") || !text.endsWith("}")) fail(`${label} must be a TOML inline table`);
  const fields = new Map();
  for (const rawPart of splitInlineFields(text.slice(1, -1), label)) {
    const part = rawPart.trim();
    if (!part) fail(`${label} contains an empty inline-table field`);
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*([\s\S]+)$/.exec(part);
    if (!match) fail(`${label} contains a malformed inline-table field`);
    if (fields.has(match[1])) fail(`${label} contains duplicate field ${match[1]}`);
    fields.set(match[1], parseTomlQuoted(match[2].trim(), `${label}.${match[1]}`));
  }
  return fields;
}

function aliasKey(value) {
  return value.split(/[._-]+/).filter(Boolean).join(".").toLowerCase();
}

function parseCatalog(source, label) {
  const clean = stripTomlComments(source, label);
  const versions = new Map();
  const libraries = new Map();
  const plugins = new Map();
  const seenSections = new Set();
  let section = null;
  for (const [lineIndex, rawLine] of clean.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const sectionMatch = /^\[([A-Za-z]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (!["versions", "libraries", "plugins"].includes(section)) fail(`${label}:${lineIndex + 1} has unsupported TOML section ${section}`);
      if (seenSections.has(section)) fail(`${label}:${lineIndex + 1} contains duplicate TOML section ${section}`);
      seenSections.add(section);
      continue;
    }
    if (!section) fail(`${label}:${lineIndex + 1} has a value outside a version-catalog section`);
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*([\s\S]+)$/.exec(line);
    if (!assignment) fail(`${label}:${lineIndex + 1} contains malformed TOML`);
    const originalAlias = assignment[1];
    const normalized = aliasKey(originalAlias);
    if (!normalized) fail(`${label}:${lineIndex + 1} contains an empty alias`);
    const target = section === "versions" ? versions : section === "libraries" ? libraries : plugins;
    if (target.has(normalized)) fail(`${label}:${lineIndex + 1} contains duplicate alias ${originalAlias}`);
    if (section === "versions") {
      target.set(normalized, { alias: originalAlias, value: parseTomlQuoted(assignment[2].trim(), `${label}:${lineIndex + 1}`), path: label, line: lineIndex + 1, excerpt: source.split(/\r?\n/)[lineIndex].trim() });
      continue;
    }
    const fields = parseInlineTable(assignment[2].trim(), `${label}:${lineIndex + 1}`);
    const allowed = section === "libraries" ? new Set(["group", "name", "module", "version.ref"]) : new Set(["id", "version.ref"]);
    for (const key of fields.keys()) if (!allowed.has(key)) fail(`${label}:${lineIndex + 1} contains unsupported ${section} field ${key}`);
    if (section === "libraries") {
      const hasModule = fields.has("module");
      const hasPair = fields.has("group") && fields.has("name");
      if (hasModule === hasPair || fields.has("group") !== fields.has("name")) fail(`${label}:${lineIndex + 1} must define exactly module or group/name`);
      const coordinate = hasModule ? fields.get("module") : `${fields.get("group")}:${fields.get("name")}`;
      if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(coordinate)) fail(`${label}:${lineIndex + 1} has a dynamic or malformed module coordinate`);
      target.set(normalized, { alias: originalAlias, coordinate, versionRef: fields.get("version.ref") ?? null, path: label, line: lineIndex + 1, excerpt: source.split(/\r?\n/)[lineIndex].trim() });
    } else {
      const id = fields.get("id");
      if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) fail(`${label}:${lineIndex + 1} has a dynamic or malformed plugin id`);
      target.set(normalized, { alias: originalAlias, id, versionRef: fields.get("version.ref") ?? null, path: label, line: lineIndex + 1, excerpt: source.split(/\r?\n/)[lineIndex].trim() });
    }
  }
  for (const entry of [...libraries.values(), ...plugins.values()]) {
    if (entry.versionRef !== null && !versions.has(aliasKey(entry.versionRef))) fail(`${label} has unresolved version reference ${entry.versionRef}`);
  }
  return { versions, libraries, plugins, structural: maskTomlStrings(clean, label) };
}

function readQuotedToken(source, start, label) {
  const quote = source[start];
  if ((quote === '"' && source.startsWith('"""', start)) || (quote === "'" && source.startsWith("'''", start))) {
    const delimiter = quote.repeat(3);
    const closing = tripleQuotedEnd(source, start + 3, delimiter, label.endsWith(".gradle"));
    if (closing < 0) fail(`${label} has an unterminated raw string`);
    const value = source.slice(start + 3, closing);
    return { type: "string", value, start, end: closing + 3, dynamic: quote === '"' && value.includes("$") };
  }
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === quote) return { type: "string", value, start, end: index + 1, dynamic: quote === '"' && value.includes("$") };
    if (source[index] === "\n" || source[index] === "\r") fail(`${label} has an unterminated Gradle string`);
    if (source[index] === "\\") {
      if (index + 1 >= source.length) fail(`${label} has an unterminated Gradle escape`);
      value += source[index] + source[index + 1];
      index += 2;
    } else {
      value += source[index++];
    }
  }
  fail(`${label} has an unterminated Gradle string`);
}

function tokenizeGradle(source, label) {
  const tokens = [];
  const groovy = label.endsWith(".gradle");
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (groovy && source.startsWith("$/", index)) {
      const closing = dollarSlashyEnd(source, index + 2);
      if (closing < 0) fail(`${label} has an unterminated dollar-slashy string`);
      const value = source.slice(index + 2, closing);
      tokens.push({ type: "string", value, start: index, end: closing + 2, dynamic: value.includes("$") });
      index = closing + 2;
      continue;
    }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) { depth += 1; index += 2; }
        else if (source.startsWith("*/", index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth) fail(`${label} has an unterminated Gradle block comment`);
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      const token = readQuotedToken(source, index, label);
      tokens.push(token);
      index = token.end;
      continue;
    }
    if (groovy && source[index] === "/" && slashyCanStart(source, index)) {
      const closing = slashyEnd(source, index + 1);
      if (closing < 0) fail(`${label} has an unterminated slashy string`);
      const value = source.slice(index + 1, closing);
      tokens.push({ type: "string", value, start: index, end: closing + 1, dynamic: value.includes("$") });
      index = closing + 1;
      continue;
    }
    if (groovy && source[index] === "/") fail(`${label} has ambiguous slash syntax`);
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(source.slice(index));
    if (identifier) {
      tokens.push({ type: "ident", value: identifier[0], start: index, end: index + identifier[0].length });
      index += identifier[0].length;
      continue;
    }
    tokens.push({ type: "symbol", value: source[index], start: index, end: index + 1 });
    index += 1;
  }
  const pairs = new Map([["}", "{"], [")", "("], ["]", "["]]);
  const stack = [];
  for (const token of tokens) {
    if (["{", "(", "["].includes(token.value)) stack.push(token.value);
    else if (pairs.has(token.value) && stack.pop() !== pairs.get(token.value)) fail(`${label} has malformed Gradle nesting`);
  }
  if (stack.length) fail(`${label} has unbalanced Gradle nesting`);
  return tokens;
}

function blockLabel(tokens, braceIndex) {
  let index = braceIndex - 1;
  if (tokens[index]?.value === ")") {
    let depth = 1;
    index -= 1;
    while (index >= 0 && depth) {
      if (tokens[index].value === ")") depth += 1;
      else if (tokens[index].value === "(") depth -= 1;
      index -= 1;
    }
  }
  return tokens[index]?.type === "ident" ? tokens[index].value : null;
}

function closesControlFlowHeader(tokens, closeIndex) {
  if (tokens[closeIndex]?.value !== ")") return false;
  let depth = 1;
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    else if (tokens[index].value === "(") depth -= 1;
    if (depth === 0) return ["catch", "for", "if", "while"].includes(tokens[index - 1]?.value);
  }
  return false;
}

function hasAnnotationMarkerBefore(tokens, start) {
  if (tokens[start - 1]?.value === "@") return true;
  return tokens[start - 1]?.value === ":"
    && tokens[start - 2]?.type === "ident"
    && tokens[start - 3]?.value === "@";
}

function annotationNameIsPrefixed(tokens, nameEnd) {
  if (tokens[nameEnd]?.type !== "ident") return false;
  let start = nameEnd;
  while (tokens[start - 1]?.value === "." && tokens[start - 2]?.type === "ident") start -= 2;
  return hasAnnotationMarkerBefore(tokens, start);
}

function endsAnnotationPrefix(tokens, endIndex) {
  if (annotationNameIsPrefixed(tokens, endIndex)) return true;
  if (tokens[endIndex]?.value === "]") {
    let depth = 1;
    for (let index = endIndex - 1; index >= 0; index -= 1) {
      if (tokens[index].value === "]") depth += 1;
      else if (tokens[index].value === "[") depth -= 1;
      if (depth === 0) return hasAnnotationMarkerBefore(tokens, index);
    }
    return false;
  }
  if (tokens[endIndex]?.value !== ")") return false;
  let depth = 1;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    else if (tokens[index].value === "(") depth -= 1;
    if (depth === 0) return annotationNameIsPrefixed(tokens, index - 1);
  }
  return false;
}

function directDslStatement(tokens, index, source) {
  const previous = tokens[index - 1];
  if (!previous || previous.value === "{" || previous.value === ";") return true;
  return !DSL_CONTINUATION_TOKENS.has(previous.value)
    && !["do", "else"].includes(previous.value)
    && !closesControlFlowHeader(tokens, index - 1)
    && !endsAnnotationPrefix(tokens, index - 1)
    && source.slice(previous.end, tokens[index].start).includes("\n");
}

function catalogReference(tokens, start) {
  if (tokens[start]?.type !== "ident" || tokens[start].value !== "libs") return null;
  const parts = ["libs"];
  let index = start + 1;
  while (tokens[index]?.value === "." && tokens[index + 1]?.type === "ident") {
    parts.push(tokens[index + 1].value);
    index += 2;
  }
  return { parts, end: index };
}

function closingParen(tokens, opening, label) {
  if (tokens[opening]?.value !== "(") fail(`${label} has a malformed Gradle call`);
  let depth = 1;
  for (let index = opening + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    else if (tokens[index].value === ")") depth -= 1;
    if (depth === 0) return index;
  }
  fail(`${label} has an unclosed Gradle call`);
}

function addVersionFact(entry, facts) {
  if (facts.versionEvidence.has(entry.alias)) return;
  facts.versionEvidence.add(entry.alias);
  facts.evidence.push({ kind: "gradle.version", key: entry.alias, value: entry.value, path: entry.path, line: entry.line, excerpt: entry.excerpt });
}

function resolveCatalog(tokens, start, category, catalog, facts, source, label, useOffset, record = true) {
  const reference = catalogReference(tokens, start);
  if (!reference || reference.parts.length < 2) fail(`${label} has a malformed catalog alias`);
  let actualCategory = "libraries";
  let aliasParts = reference.parts.slice(1);
  if (aliasParts[0] === "plugins") {
    actualCategory = "plugins";
    aliasParts = aliasParts.slice(1);
  } else if (aliasParts[0] === "versions" || aliasParts[0] === "bundles") {
    fail(`${label} uses unsupported catalog reference ${reference.parts.join(".")}`);
  }
  if (actualCategory !== category) fail(`${label} uses a ${actualCategory} alias where ${category} is required`);
  const alias = aliasKey(aliasParts.join("."));
  const entry = catalog[category].get(alias);
  if (!entry) fail(`${label} has unresolved catalog alias ${reference.parts.join(".")}`);
  const value = category === "plugins" ? entry.id : entry.coordinate;
  let version = null;
  if (entry.versionRef !== null) {
    const versionEntry = catalog.versions.get(aliasKey(entry.versionRef));
    if (!versionEntry) fail(`${label} has unresolved version reference ${entry.versionRef}`);
    version = versionEntry.value;
    if (record) {
      facts.versions.set(versionEntry.alias, versionEntry.value);
      addVersionFact(versionEntry, facts);
    }
  }
  if (record) {
    if (category === "plugins") facts.pluginIds.add(value);
    else facts.moduleCoordinates.add(value);
    facts.evidence.push(evidenceAt(source, label, useOffset, {
      kind: category === "plugins" ? "gradle.plugin" : "gradle.dependency",
      value,
      alias,
      version,
      versionRef: entry.versionRef,
    }));
  }
  return reference.end;
}

function pluginSuffixValue(tokens, cursor, keyword, label) {
  if (tokens[cursor]?.value === "(") {
    const close = closingParen(tokens, cursor, label);
    if (close !== cursor + 2) fail(`${label} has unsupported plugin ${keyword} arguments`);
    return { value: tokens[cursor + 1], end: close + 1 };
  }
  return { value: tokens[cursor], end: cursor + 1 };
}

function parsePluginSuffix(tokens, start, source, label) {
  let cursor = start;
  let previousEnd = tokens[start - 1]?.end ?? 0;
  let version = null;
  let applied = true;
  const seen = new Set();
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.value === ";" || token.value === "}" || source.slice(previousEnd, token.start).includes("\n")) break;
    if (token.type !== "ident" || !["version", "apply"].includes(token.value)) fail(`${label} has an unsupported plugin declaration suffix`);
    if (seen.has(token.value)) fail(`${label} has duplicate plugin ${token.value} suffix`);
    seen.add(token.value);
    const parsed = pluginSuffixValue(tokens, cursor + 1, token.value, label);
    if (token.value === "version") {
      if (!parsed.value || parsed.value.type !== "string" || parsed.value.dynamic || parsed.value.value.length === 0) fail(`${label} has a dynamic or malformed plugin version`);
      version = parsed.value.value;
    } else {
      if (!parsed.value || parsed.value.type !== "ident" || !["true", "false"].includes(parsed.value.value)) fail(`${label} has a dynamic or malformed plugin apply suffix`);
      applied = parsed.value.value === "true";
    }
    previousEnd = tokens[parsed.end - 1].end;
    cursor = parsed.end;
  }
  return { version, applied, end: cursor };
}

function addModuleCoordinate(token, facts, source, label, useOffset) {
  if (token.type !== "string" || token.dynamic) fail(`${label} has a dynamic or unsupported dependency value`);
  const pieces = token.value.split(":");
  if (pieces.length < 2 || !pieces[0] || !pieces[1] || !/^[A-Za-z0-9_.-]+$/.test(pieces[0]) || !/^[A-Za-z0-9_.-]+$/.test(pieces[1])) fail(`${label} has a malformed dependency coordinate`);
  const coordinate = `${pieces[0]}:${pieces[1]}`;
  facts.moduleCoordinates.add(coordinate);
  facts.evidence.push(evidenceAt(source, label, useOffset, {
    kind: "gradle.dependency",
    value: coordinate,
    alias: null,
    version: pieces[2] ?? null,
    versionRef: null,
  }));
}

function parseDependencyArgument(tokens, start, catalog, facts, source, label, useOffset) {
  const argument = tokens[start];
  if (!argument) fail(`${label} has an empty dependency call`);
  if (argument.type === "string") {
    addModuleCoordinate(argument, facts, source, label, useOffset);
    return start + 1;
  }
  if (argument.value === "libs") return resolveCatalog(tokens, start, "libraries", catalog, facts, source, label, useOffset);
  if (["platform", "enforcedPlatform"].includes(argument.value)) {
    if (tokens[start + 1]?.value !== "(") fail(`${label} has a malformed dependency platform`);
    const close = closingParen(tokens, start + 1, label);
    const consumed = parseDependencyArgument(tokens, start + 2, catalog, facts, source, label, useOffset);
    if (consumed !== close) fail(`${label} has unsupported dependency platform arguments`);
    return close + 1;
  }
  if (["project", "files", "fileTree"].includes(argument.value) && tokens[start + 1]?.value === "(") {
    return closingParen(tokens, start + 1, label) + 1;
  }
  fail(`${label} has a dynamic or unsupported dependency value`);
}

function parseGradle(source, label, catalog, facts) {
  const tokens = tokenizeGradle(source, label);
  const contexts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "{") {
      const labelName = blockLabel(tokens, index);
      if (["android", "defaultConfig", "dependencies", "plugins"].includes(labelName)) {
        const handlerIndex = index - 1;
        const exactDirectHandler = tokens[handlerIndex]?.type === "ident"
          && tokens[handlerIndex].value === labelName
          && directDslStatement(tokens, handlerIndex, source);
        const exactScope = labelName === "defaultConfig"
          ? contexts.length === 1 && contexts[0] === "android"
          : contexts.length === 0;
        if (!exactDirectHandler || !exactScope) fail(`${label} has qualified or nested ${labelName} outside recognized Gradle scope`);
      }
      contexts.push(labelName);
      continue;
    }
    if (token.value === "}") {
      contexts.pop();
      continue;
    }
    const inPlugins = contexts.length === 1 && contexts[0] === "plugins";
    const inDependencies = contexts.length === 1 && contexts[0] === "dependencies";
    if (token.type === "ident" && token.value === "id" && inPlugins && (tokens[index + 1]?.value === "(" || tokens[index + 1]?.type === "string")) {
      if (!directDslStatement(tokens, index, source)) fail(`${label} has a qualified or indirect fake plugin id call`);
      const parenthesized = tokens[index + 1]?.value === "(";
      const value = parenthesized ? tokens[index + 2] : tokens[index + 1];
      if (!value || value.type !== "string" || value.dynamic || !/^[A-Za-z0-9_.-]+$/.test(value.value)) fail(`${label} has a dynamic or malformed plugin id`);
      const end = parenthesized ? closingParen(tokens, index + 1, label) + 1 : index + 2;
      if (parenthesized && end !== index + 4) fail(`${label} has unsupported plugin id arguments`);
      const suffix = parsePluginSuffix(tokens, end, source, label);
      if (suffix.applied) {
        facts.pluginIds.add(value.value);
        facts.evidence.push(evidenceAt(source, label, token.start, { kind: "gradle.plugin", value: value.value, alias: null, version: suffix.version, versionRef: null }));
      }
      index = suffix.end - 1;
    }
    if (token.type === "ident" && token.value === "alias" && inPlugins && tokens[index + 1]?.value === "(") {
      if (!directDslStatement(tokens, index, source)) fail(`${label} has a qualified or indirect fake plugin alias call`);
      const close = closingParen(tokens, index + 1, label);
      const suffix = parsePluginSuffix(tokens, close + 1, source, label);
      if (suffix.version !== null) fail(`${label} has an unsupported plugin alias version suffix`);
      const consumed = resolveCatalog(tokens, index + 2, "plugins", catalog, facts, source, label, token.start, suffix.applied);
      if (consumed !== close) fail(`${label} has unsupported plugin alias arguments`);
      index = suffix.end - 1;
    }
    if (token.type === "ident" && token.value === "applicationId") {
      if (contexts.length !== 2 || contexts[0] !== "android" || contexts[1] !== "defaultConfig") fail(`${label} has applicationId outside recognized android/defaultConfig scope`);
      if (!directDslStatement(tokens, index, source)) fail(`${label} has a qualified or indirect applicationId assignment`);
      if (tokens[index + 1]?.value !== "=") fail(`${label} applicationId must use a direct assignment`);
      const value = tokens[index + 2];
      if (!value || value.type !== "string") fail(`${label} has a dynamic or unsupported application id`);
      if (value.dynamic || !/^[A-Za-z0-9_.-]+$/.test(value.value)) fail(`${label} has a dynamic or malformed application id`);
      const following = tokens[index + 3];
      const lineSeparated = following && source.slice(value.end, following.start).includes("\n");
      if (following && following.value !== ";" && following.value !== "}" && (!lineSeparated || DSL_CONTINUATION_TOKENS.has(following.value))) fail(`${label} has an unsupported applicationId assignment suffix`);
      facts.applicationIds.add(value.value);
      facts.evidence.push(evidenceAt(source, label, token.start, { kind: "gradle.applicationId", value: value.value }));
    }
    if (token.type === "ident" && /^(?:implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|kapt|ksp|annotationProcessor|classpath)$/i.test(token.value) && inDependencies) {
      if (!directDslStatement(tokens, index, source)) fail(`${label} has a qualified or indirect fake dependency call`);
      if (tokens[index + 1]?.value === "(") {
        const close = closingParen(tokens, index + 1, label);
        const consumed = parseDependencyArgument(tokens, index + 2, catalog, facts, source, label, token.start);
        if (consumed !== close) fail(`${label} has unsupported dependency call arguments`);
      } else {
        parseDependencyArgument(tokens, index + 1, catalog, facts, source, label, token.start);
      }
    }
  }
}

function uncommentXml(source, label) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const opening = source.indexOf("<!--", index);
    if (opening < 0) return result + source.slice(index);
    result += source.slice(index, opening);
    const closing = source.indexOf("-->", opening + 4);
    if (closing < 0) fail(`${label} has an unterminated XML comment`);
    result += source.slice(opening, closing + 3).replace(/[^\r\n]/g, " ");
    index = closing + 3;
  }
  return result;
}

function parseXmlAttributes(content, start, label) {
  const attributes = new Map();
  let index = start;
  while (index < content.length) {
    while (/\s/.test(content[index])) index += 1;
    if (index >= content.length || content[index] === "/") break;
    const name = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(content.slice(index));
    if (!name) fail(`${label} has a malformed XML attribute`);
    index += name[0].length;
    while (/\s/.test(content[index])) index += 1;
    if (content[index++] !== "=") fail(`${label} has an XML attribute without a value`);
    while (/\s/.test(content[index])) index += 1;
    const quote = content[index++];
    if (quote !== '"' && quote !== "'") fail(`${label} has an unquoted XML attribute`);
    const end = content.indexOf(quote, index);
    if (end < 0) fail(`${label} has an unterminated XML attribute`);
    if (attributes.has(name[0])) fail(`${label} has duplicate XML attribute ${name[0]}`);
    attributes.set(name[0], content.slice(index, end));
    index = end + 1;
  }
  while (/\s/.test(content[index])) index += 1;
  if (index < content.length && !(content[index] === "/" && /^\/\s*$/.test(content.slice(index)))) fail(`${label} has malformed XML tag content`);
  return attributes;
}

function parseManifest(source, label) {
  const clean = uncommentXml(source, label);
  if (/<!DOCTYPE\b/i.test(clean)) fail(`${label} contains a forbidden XML DOCTYPE`);
  if (clean.includes("&")) fail(`${label} contains a forbidden XML entity`);
  if (/<!\[CDATA\[/i.test(clean)) fail(`${label} contains unsupported XML CDATA`);
  const stack = [];
  const activities = [];
  const metadata = [];
  const applicationIds = [];
  const evidence = [];
  let applicationName = null;
  let applicationCount = 0;
  let sawManifest = false;
  let index = 0;
  while (index < clean.length) {
    const opening = clean.indexOf("<", index);
    if (opening < 0) break;
    if (stack.length === 0 && clean.slice(index, opening).trim()) fail(`${label} has text outside the XML root`);
    let cursor = opening + 1;
    let quote = null;
    while (cursor < clean.length) {
      if (quote !== null) {
        if (clean[cursor] === quote) quote = null;
      } else if (clean[cursor] === '"' || clean[cursor] === "'") quote = clean[cursor];
      else if (clean[cursor] === ">") break;
      cursor += 1;
    }
    if (cursor >= clean.length) fail(`${label} has an unterminated XML tag`);
    const content = clean.slice(opening + 1, cursor).trim();
    index = cursor + 1;
    if (!content) fail(`${label} has an empty XML tag`);
    if (content.startsWith("?")) {
      if (!content.endsWith("?")) fail(`${label} has malformed XML processing instruction`);
      if (sawManifest || !/^\?xml\s/i.test(content)) fail(`${label} has an unsupported XML processing instruction`);
      continue;
    }
    if (content.startsWith("!")) fail(`${label} has an unsupported XML declaration`);
    if (content.startsWith("/")) {
      const closing = content.slice(1).trim();
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(closing) || stack.pop() !== closing) fail(`${label} has malformed XML nesting`);
      continue;
    }
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(content);
    if (!nameMatch) fail(`${label} has a malformed XML element`);
    const name = nameMatch[0];
    if (sawManifest && stack.length === 0) fail(`${label} has multiple XML root elements`);
    const selfClosing = /\/\s*$/.test(content);
    const attributes = parseXmlAttributes(content, name.length, label);
    if (!sawManifest) {
      if (name !== "manifest") fail(`${label} root element must be manifest`);
      sawManifest = true;
    }
    if (name === "manifest") {
      if (sawManifest && stack.length > 0) fail(`${label} has a nested manifest element`);
      const packageName = attributes.get("package");
      if (packageName) {
        if (packageName.includes("$") || !/^[A-Za-z0-9_.-]+$/.test(packageName)) fail(`${label} has a dynamic or malformed manifest package`);
        applicationIds.push(packageName);
        evidence.push(evidenceAt(source, label, opening, { kind: "manifest.package", value: packageName }));
      }
    } else if (name === "application") {
      if (stack.at(-1) !== "manifest" || ++applicationCount > 1) fail(`${label} has an invalid or multiple application element`);
      const value = attributes.get("android:name") ?? null;
      if (value?.includes("$")) fail(`${label} has a dynamic application name`);
      applicationName = value;
      if (value !== null) evidence.push(evidenceAt(source, label, opening, { kind: "manifest.application", value }));
    } else if (name === "activity") {
      if (stack.at(-1) !== "application") fail(`${label} activity must be a direct child of application`);
      const value = attributes.get("android:name");
      if (value) {
        if (value.includes("$")) fail(`${label} has a dynamic activity name`);
        activities.push(value);
        evidence.push(evidenceAt(source, label, opening, { kind: "manifest.activity", value }));
      }
    } else if (name === "meta-data") {
      if (stack.at(-1) !== "application") fail(`${label} meta-data must be a direct child of application`);
      const metadataName = attributes.get("android:name");
      if (metadataName) {
        const value = attributes.get("android:value") ?? null;
        const resource = attributes.get("android:resource") ?? null;
        if (metadataName.includes("$") || value?.includes("$") || resource?.includes("$")) fail(`${label} has dynamic manifest metadata`);
        if (value !== null && resource !== null) fail(`${label} metadata cannot define both value and resource`);
        const metadataValue = { name: metadataName, value, resource };
        metadata.push(metadataValue);
        evidence.push(evidenceAt(source, label, opening, { kind: "manifest.metadata", value: metadataName, metadata: metadataValue }));
      }
    }
    if (!selfClosing) stack.push(name);
  }
  if (stack.length === 0 && clean.slice(index).trim()) fail(`${label} has text outside the XML root`);
  if (!sawManifest || stack.length) fail(`${label} has malformed XML nesting`);
  return { applicationName, activities, metadata, applicationIds, evidence };
}

function readStableFile(absolutePath, expectedStat, label) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !sameStatIdentity(before, expectedStat)) fail(`${label} changed identity during inventory`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!sameStatIdentity(after, before) || bytes.length !== before.size) fail(`${label} changed while being read`);
    const pathAfter = fs.lstatSync(absolutePath);
    if (pathAfter.isSymbolicLink() || !sameStatIdentity(pathAfter, after)) fail(`${label} path identity changed after descriptor read`);
    try {
      return UTF8.decode(bytes);
    } catch {
      fail(`${label} is not valid UTF-8`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateRootIdentity(root, expectedStat, phase) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !sameStatIdentity(expectedStat, rootStat)) fail(`project root identity changed ${phase}`);
  const canonicalRoot = fs.realpathSync(root);
  const canonicalStat = fs.lstatSync(canonicalRoot);
  if (canonicalRoot !== root || !sameStatIdentity(expectedStat, canonicalStat)) fail(`project root identity changed ${phase}`);
}

function sortedRecord(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => compareStrings(left, right)));
}

/** @returns {SourceIndex} */
export function loadSubmissionSources(projectDir) {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) fail("project directory must be an absolute path");
  const requestedRoot = path.resolve(projectDir);
  const rootStat = fs.lstatSync(requestedRoot);
  if (rootStat.isSymbolicLink()) fail("project directory must not be a symlink");
  if (!rootStat.isDirectory()) fail("project path must be a directory");
  const root = fs.realpathSync(requestedRoot);
  const canonicalRootStat = fs.lstatSync(root);
  if (!canonicalRootStat.isDirectory() || !sameStatIdentity(rootStat, canonicalRootStat)) fail("project root identity changed between lstat and realpath");
  const entries = [];

  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort(compareStrings)) {
      const absolutePath = path.join(directory, name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`symlink or escape is not allowed: ${path.relative(root, absolutePath)}`);
      const resolved = fs.realpathSync(absolutePath);
      if (!inside(root, resolved)) fail(`path escapes project directory: ${absolutePath}`);
      const resolvedStat = fs.lstatSync(resolved);
      if (!sameStatIdentity(stat, resolvedStat)) fail(`path identity changed during realpath: ${absolutePath}`);
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(name.toLowerCase())) visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) fail(`special filesystem entry is not allowed: ${path.relative(root, absolutePath)}`);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const kind = selectedKind(relativePath);
      if (!kind) continue;
      if (stat.size > MAX_FILE_BYTES) fail(`${relativePath} exceeds the 2 MiB file size limit`);
      entries.push({ path: relativePath, absolutePath: resolved, kind, stat });
      if (entries.length > MAX_FILES) fail(`selected file count exceeds 2,000`);
    }
  }
  visit(root);
  const finalRootStat = fs.lstatSync(root);
  if (!sameStatIdentity(canonicalRootStat, finalRootStat)) fail("project root changed during inventory");
  entries.sort((left, right) => compareStrings(left.path, right.path));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.stat.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) fail("selected files exceed the 32 MiB total size limit");

  const rawFiles = [];
  for (const entry of entries) {
    const original = readStableFile(entry.absolutePath, entry.stat, entry.path);
    validateRootIdentity(root, canonicalRootStat, `after reading ${entry.path}`);
    rawFiles.push({ ...entry, original });
  }
  validateRootIdentity(root, canonicalRootStat, "after selected file reads");
  const catalogs = { versions: new Map(), libraries: new Map(), plugins: new Map() };
  const parsedCatalogs = new Map();
  for (const file of rawFiles.filter((entry) => entry.path.endsWith(".toml"))) {
    const isCatalog = file.path === "gradle/libs.versions.toml";
    const parsed = isCatalog
      ? parseCatalog(file.original, file.path)
      : { structural: maskTomlStrings(stripTomlComments(file.original, file.path), file.path) };
    parsedCatalogs.set(file.path, parsed);
    if (!isCatalog) continue;
    for (const category of ["versions", "libraries", "plugins"]) {
      for (const [alias, value] of parsed[category]) {
        if (catalogs[category].has(alias)) fail(`duplicate ${category} alias across catalogs: ${value.alias}`);
        catalogs[category].set(alias, value);
      }
    }
  }
  const facts = { pluginIds: new Set(), moduleCoordinates: new Set(), versions: new Map(), applicationIds: new Set(), evidence: [], versionEvidence: new Set() };

  let applicationName = null;
  const activities = new Set();
  const metadataByKey = new Map();
  for (const file of rawFiles) {
    if (file.kind === "manifest") {
      const parsed = parseManifest(file.original, file.path);
      if (applicationName !== null && parsed.applicationName !== null && parsed.applicationName !== applicationName) fail("manifest application names conflict");
      applicationName ??= parsed.applicationName;
      for (const value of parsed.activities) activities.add(value);
      for (const value of parsed.applicationIds) facts.applicationIds.add(value);
      facts.evidence.push(...parsed.evidence);
      for (const value of parsed.metadata) {
        const key = JSON.stringify(value);
        metadataByKey.set(key, value);
      }
    } else if ((file.path.endsWith(".gradle") || file.path.endsWith(".gradle.kts"))) {
      parseGradle(file.original, file.path, catalogs, facts);
    }
  }

  const files = rawFiles.map((file) => {
    let structural;
    if (file.kind === "manifest") structural = maskXml(file.original, file.path);
    else if (file.path.endsWith(".toml")) structural = parsedCatalogs.get(file.path).structural;
    else structural = maskCode(file.original, file.path, file.path.endsWith(".gradle"));
    return Object.freeze({ path: file.path, absolutePath: file.absolutePath, kind: file.kind, original: file.original, structural });
  });
  const gradle = Object.freeze({
    pluginIds: Object.freeze([...facts.pluginIds].sort(compareStrings)),
    moduleCoordinates: Object.freeze([...facts.moduleCoordinates].sort(compareStrings)),
    versions: Object.freeze(sortedRecord(facts.versions)),
    applicationIds: Object.freeze([...facts.applicationIds].sort(compareStrings)),
  });
  const manifest = Object.freeze({
    applicationName,
    activities: Object.freeze([...activities].sort(compareStrings)),
    metadata: Object.freeze([...metadataByKey.values()].sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right))).map(Object.freeze)),
  });
  const factEvidence = Object.freeze(facts.evidence
    .sort((left, right) => compareStrings(left.path, right.path) || left.line - right.line || compareStrings(left.kind, right.kind) || compareStrings(left.value, right.value))
    .map(freezeFact));
  return Object.freeze({ projectDir: root, files: Object.freeze(files), totalBytes, facts: Object.freeze({ gradle, manifest }), factEvidence });
}

function pathSelected(relativePath, paths) {
  if (paths === undefined) return true;
  const selectors = Array.isArray(paths) ? paths : [paths];
  return selectors.some((selector) => {
    if (typeof selector === "string") return relativePath === selector;
    if (selector instanceof RegExp) return new RegExp(selector.source, selector.flags.replace(/[gy]/g, "")).test(relativePath);
    fail("paths must contain only strings or regular expressions");
  });
}

function matchOffsets(source, matcher) {
  if (typeof matcher === "string") {
    if (!matcher) fail("matcher string must not be empty");
    const offsets = [];
    let offset = source.indexOf(matcher);
    while (offset >= 0) {
      offsets.push(offset);
      offset = source.indexOf(matcher, offset + Math.max(1, matcher.length));
    }
    return offsets;
  }
  if (!(matcher instanceof RegExp)) fail("matcher must be a string or regular expression");
  const expression = new RegExp(matcher.source, `${matcher.flags.replace(/[gy]/g, "")}g`);
  const offsets = [];
  for (const match of source.matchAll(expression)) offsets.push(match.index);
  return offsets;
}

export function findEvidence(index, matcher, { paths, original = false } = {}) {
  if (!index || !Array.isArray(index.files)) fail("source index is invalid");
  if (typeof original !== "boolean") fail("original option must be boolean");
  const evidence = [];
  for (const file of index.files) {
    if (!pathSelected(file.path, paths)) continue;
    const seenLines = new Set();
    for (const offset of matchOffsets(file.structural, matcher)) {
      const line = file.structural.slice(0, offset).split("\n").length;
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      const excerptSource = original ? file.original : file.structural;
      const excerpt = excerptSource.split(/\r?\n/)[line - 1].trim();
      evidence.push({ path: file.path, line, excerpt });
    }
  }
  return evidence;
}

export function findFactEvidence(index, query = {}) {
  if (!index || !Array.isArray(index.factEvidence)) fail("source index fact evidence is invalid");
  if (query === null || typeof query !== "object" || Array.isArray(query)) fail("fact evidence query must be an object");
  const allowed = new Set(["kind", "value", "key", "alias", "version", "versionRef", "path"]);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key)) fail(`fact evidence query contains unsupported field ${key}`);
    if (typeof value !== "string" && value !== null) fail(`fact evidence query field ${key} must be a string or null`);
  }
  return Object.freeze(index.factEvidence.filter((fact) => Object.entries(query).every(([key, value]) => fact[key] === value)));
}
