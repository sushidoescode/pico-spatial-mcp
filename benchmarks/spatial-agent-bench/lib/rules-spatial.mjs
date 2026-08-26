import path from "node:path";
import { findFactEvidence } from "./source.mjs";

const SOURCE_ONLY_RULE_IDS = Object.freeze([
  "spatial.entity-content",
  "spatial.ui-lifecycle",
  "ecs.component-clone",
  "ecs.system-query",
  "ecs.frame-update",
  "ecs.lifecycle",
]);

function isIdentifierStart(code) {
  return code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierPart(code) {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

function tokenize(source) {
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    const code = source.charCodeAt(offset);
    if (source[offset] === "\n") {
      tokens.push({ type: "newline", value: "\n" });
      offset += 1;
    } else if (code === 96) {
      const closing = source.indexOf("`", offset + 1);
      if (closing < 0 || closing === offset + 1) return null;
      tokens.push({ type: "identifier", value: source.slice(offset + 1, closing) });
      offset = closing + 1;
    } else if (isIdentifierStart(code)) {
      let end = offset + 1;
      while (end < source.length && isIdentifierPart(source.charCodeAt(end))) end += 1;
      tokens.push({ type: "identifier", value: source.slice(offset, end) });
      offset = end;
    } else if (code === 13 || code === 9 || code === 32) {
      offset += 1;
    } else if (source.startsWith("->", offset)) {
      tokens.push({ type: "symbol", value: "->" });
      offset += 2;
    } else {
      tokens.push({ type: "symbol", value: source[offset] });
      offset += 1;
    }
  }
  return tokens;
}

function decodePackage(file) {
  const tokens = tokenize(file.structural);
  if (!tokens) return null;
  const packages = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "identifier" || tokens[index].value !== "package") continue;
    const parts = [];
    let cursor = index + 1;
    if (tokens[cursor]?.type !== "identifier") continue;
    parts.push(tokens[cursor].value);
    cursor += 1;
    while (tokens[cursor]?.value === "." && tokens[cursor + 1]?.type === "identifier") {
      parts.push(tokens[cursor + 1].value);
      cursor += 2;
    }
    if (tokens[cursor] && tokens[cursor].type !== "newline" && tokens[cursor].value !== ";") continue;
    packages.push(parts.join("."));
  }
  return packages.length === 1 ? packages[0] : null;
}

function decodeClassHeader(node) {
  const spanTokens = tokenize(node.file.structural.slice(node.startUtf16, node.endUtf16));
  if (!spanTokens) return null;
  const classOffsets = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let braceDepth = 0;
  let headerEnd = spanTokens.length;
  for (let index = 0; index < spanTokens.length; index += 1) {
    const token = spanTokens[index];
    const value = token.value;
    const topLevel = parenDepth === 0 && bracketDepth === 0 && angleDepth === 0 && braceDepth === 0;
    if (value === "{" && topLevel) {
      headerEnd = index;
      break;
    }
    if (topLevel && token.type === "identifier" && value === "class"
        && spanTokens[index + 1]?.type === "identifier") {
      classOffsets.push(index);
    }
    if (value === "(") parenDepth += 1;
    else if (value === ")") parenDepth -= 1;
    else if (value === "[") bracketDepth += 1;
    else if (value === "]") bracketDepth -= 1;
    else if (value === "<" && parenDepth === 0 && bracketDepth === 0) angleDepth += 1;
    else if (value === ">" && parenDepth === 0 && bracketDepth === 0 && angleDepth > 0) angleDepth -= 1;
    else if (value === "{") braceDepth += 1;
    else if (value === "}") braceDepth -= 1;
    if (parenDepth < 0 || bracketDepth < 0 || angleDepth < 0 || braceDepth < 0) return null;
  }
  if (classOffsets.length !== 1) return null;
  const tokens = spanTokens.slice(0, headerEnd);
  const classOffset = classOffsets[0];
  const className = tokens[classOffset + 1]?.type === "identifier" ? tokens[classOffset + 1].value : null;
  if (!className) return null;

  parenDepth = 0;
  bracketDepth = 0;
  angleDepth = 0;
  let colonOffset = -1;
  for (let index = classOffset + 2; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(") parenDepth += 1;
    else if (value === ")") parenDepth -= 1;
    else if (value === "[") bracketDepth += 1;
    else if (value === "]") bracketDepth -= 1;
    else if (value === "<" && parenDepth === 0 && bracketDepth === 0) angleDepth += 1;
    else if (value === ">" && parenDepth === 0 && bracketDepth === 0 && angleDepth > 0) angleDepth -= 1;
    else if (value === "{" && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) break;
    else if (value === ":" && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      colonOffset = index;
      break;
    }
    if (parenDepth < 0 || bracketDepth < 0 || angleDepth < 0) return null;
  }
  if (colonOffset < 0) return null;

  const baseParts = [];
  let cursor = colonOffset + 1;
  if (tokens[cursor]?.type !== "identifier") return null;
  baseParts.push(tokens[cursor].value);
  cursor += 1;
  while (tokens[cursor]?.value === "." && tokens[cursor + 1]?.type === "identifier") {
    baseParts.push(tokens[cursor + 1].value);
    cursor += 2;
  }
  if (tokens[cursor]?.value === "<") {
    let depth = 0;
    do {
      const value = tokens[cursor]?.value;
      if (value === "<") depth += 1;
      else if (value === ">" && depth > 0) depth -= 1;
      cursor += 1;
    } while (cursor < tokens.length && depth > 0);
    if (depth !== 0) return null;
  }
  if (!["(", "{", "\n"].includes(tokens[cursor]?.value ?? "\n")) return null;

  parenDepth = 0;
  angleDepth = 0;
  let whereClause = false;
  for (let index = cursor; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = token.value;
    if (value === "(") parenDepth += 1;
    else if (value === ")") parenDepth -= 1;
    else if (value === "<" && parenDepth === 0) angleDepth += 1;
    else if (value === ">" && parenDepth === 0 && angleDepth > 0) angleDepth -= 1;
    else if (token.type === "identifier" && value === "where" && parenDepth === 0 && angleDepth === 0) whereClause = true;
    else if (value === "," && parenDepth === 0 && angleDepth === 0 && !whereClause) return null;
    else if (value === "{" && parenDepth === 0 && angleDepth === 0) break;
    if (parenDepth < 0 || angleDepth < 0) return null;
  }
  const packageName = decodePackage(node.file);
  if (packageName === null) return null;
  return {
    qualifiedName: `${packageName}.${className}`,
    baseIdentifier: baseParts.at(-1),
  };
}

function declarationsFor(claim) {
  const declarations = [];
  for (const node of claim.witnesses) {
    if (node.kind !== "declaration") continue;
    const decoded = decodeClassHeader(node);
    if (decoded) declarations.push({ ...decoded, nodeId: node.nodeId });
  }
  return declarations;
}

function resolveManifestName(name, applicationId) {
  if (name.startsWith(".")) return `${applicationId}${name}`;
  if (name.includes(".")) return name;
  return `${applicationId}.${name}`;
}

const TYPED_FACT_KEYS = new Set([
  "kind", "value", "path", "line", "excerpt", "scope", "activityName",
  "key", "alias", "version", "versionRef", "metadata",
]);
const METADATA_KEYS = new Set(["scope", "activityName", "name", "value", "resource"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedString(value, maximumBytes, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !/[\r\n]/.test(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function relativeEvidencePath(value) {
  if (!boundedString(value, 1_024)) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes("\\")
      || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..")
    && path.posix.normalize(value) === value;
}

function representableMetadata(row) {
  if (!isRecord(row.metadata) || Object.keys(row.metadata).length !== METADATA_KEYS.size
      || Object.keys(row.metadata).some((key) => !METADATA_KEYS.has(key))) return false;
  const metadata = row.metadata;
  if (metadata.scope !== "application" && metadata.scope !== "activity") return false;
  if (metadata.scope === "application" && metadata.activityName !== null) return false;
  if (metadata.scope === "activity" && !boundedString(metadata.activityName, 512)) return false;
  if (!boundedString(metadata.name, 512)
      || !boundedString(metadata.value, 1_024, { nullable: true })
      || !boundedString(metadata.resource, 1_024, { nullable: true })
      || (metadata.value === null) === (metadata.resource === null)) return false;
  return row.scope === metadata.scope
    && row.activityName === metadata.activityName
    && row.value === metadata.name;
}

export function isRepresentableTypedFact(row) {
  if (!isRecord(row) || Object.keys(row).some((key) => !TYPED_FACT_KEYS.has(key))) return false;
  for (const key of ["kind", "value", "path", "line", "excerpt"]) {
    if (!Object.hasOwn(row, key)) return false;
  }
  if (!boundedString(row.kind, 256)
      || !boundedString(row.value, 1_024)
      || !relativeEvidencePath(row.path)
      || !Number.isSafeInteger(row.line) || row.line < 1
      || !boundedString(row.excerpt, 512)) return false;
  for (const key of ["key", "alias", "version", "versionRef"]) {
    if (!Object.hasOwn(row, key)) continue;
    if (key === "key" && row[key] === null) return false;
    if (!boundedString(row[key], 1_024, { nullable: key !== "key" })) return false;
  }
  const metadataFact = row.kind === "manifest.metadata";
  for (const key of ["scope", "activityName", "metadata"]) {
    if (metadataFact !== Object.hasOwn(row, key)) return false;
  }
  return !metadataFact || representableMetadata(row);
}

function typedEvidence(index, rows) {
  const evidence = [];
  for (const row of rows) {
    if (!isRepresentableTypedFact(row)) return null;
    const files = index.files.filter((file) => file.path === row.path);
    if (files.length !== 1) return null;
    const structuralExcerpt = files[0].structural.split("\n")[row.line - 1]?.trim();
    if (!boundedString(structuralExcerpt, 512)) return null;
    evidence.push({ evidenceClass: "typed_fact", ...row });
  }
  return evidence;
}

function failed(id, reason) {
  return { id, pass: false, evidence: [], reason };
}

function claimGate(context, id) {
  if (context.analysisStatus === "rejected") return { failure: failed(id, `supported-subset-v1 rejected: ${context.rejectionCode}`) };
  const claim = context.claimsById.get(id);
  if (!claim) return { failure: failed(id, "supported-subset-v1 claim absent") };
  if (!claim.representable) return { failure: failed(id, "supported-subset-v1 witness unrepresentable") };
  return { claim };
}

function projectEntry(index, context) {
  const id = "spatial.project-entry";
  const gate = claimGate(context, id);
  if (gate.failure) return gate.failure;
  const claim = gate.claim;
  const declarations = declarationsFor(claim);
  const applicationDeclarations = declarations.filter((row) => row.baseIdentifier === "Application");
  const activityDeclarations = declarations.filter((row) => row.baseIdentifier === "SpatialLaunchActivity");
  const plugins = findFactEvidence(index, { kind: "gradle.plugin", value: "com.android.application" });
  const boms = findFactEvidence(index, { kind: "gradle.dependency", value: "com.pico.spatial:bom", version: "0.13.3" });
  const foundations = findFactEvidence(index, { kind: "gradle.dependency", value: "com.pico.spatial.ui:foundation" });
  const applicationIds = findFactEvidence(index, { kind: "gradle.applicationId" });
  const manifestApplications = findFactEvidence(index, { kind: "manifest.application" });
  const manifestActivities = findFactEvidence(index, { kind: "manifest.activity" });
  const bindings = [];
  if (plugins.length === 1 && boms.length === 1 && foundations.length === 1) {
    for (const applicationId of applicationIds) {
      for (const applicationFact of manifestApplications) {
        const applicationName = resolveManifestName(applicationFact.value, applicationId.value);
        for (const applicationDeclaration of applicationDeclarations) {
          if (applicationDeclaration.qualifiedName !== applicationName) continue;
          for (const activityFact of manifestActivities) {
            const activityName = resolveManifestName(activityFact.value, applicationId.value);
            for (const activityDeclaration of activityDeclarations) {
              if (activityDeclaration.qualifiedName !== activityName) continue;
              bindings.push({ typed: [plugins[0], boms[0], foundations[0], applicationId, applicationFact, activityFact] });
            }
          }
        }
      }
    }
  }
  if (bindings.length !== 1) return failed(id, "supported-subset-v1 typed binding incomplete");
  const facts = typedEvidence(index, bindings[0].typed);
  if (facts === null) return failed(id, "supported-subset-v1 typed-fact evidence unrepresentable");
  return {
    id,
    pass: true,
    evidence: [...claim.sourceEvidence, ...facts],
    reason: `supported-subset-v1 witness: ${claim.proofForm}`,
  };
}

function staticMetadata(rows, expectedValue = undefined) {
  return rows.filter((row) => row.metadata
    && row.metadata.resource === null
    && typeof row.metadata.value === "string"
    && row.metadata.value.length > 0
    && (expectedValue === undefined || row.metadata.value === expectedValue));
}

function containerTopology(index, context) {
  const id = "spatial.container-topology";
  const gate = claimGate(context, id);
  if (gate.failure) return gate.failure;
  const claim = gate.claim;
  const declarations = declarationsFor(claim).filter((row) => row.baseIdentifier === "SpatialLaunchActivity");
  const applicationIds = findFactEvidence(index, { kind: "gradle.applicationId" });
  const activities = findFactEvidence(index, { kind: "manifest.activity" });
  const bindings = [];
  for (const applicationId of applicationIds) {
    for (const activity of activities) {
      const activityName = resolveManifestName(activity.value, applicationId.value);
      for (const declaration of declarations) {
        if (declaration.qualifiedName !== activityName) continue;
        const baseQuery = { scope: "activity", activityName: activity.value };
        const ids = staticMetadata(findFactEvidence(index, { kind: "manifest.metadata", value: "pico.spatial.windowcontainer.id", ...baseQuery }));
        const styles = staticMetadata(findFactEvidence(index, { kind: "manifest.metadata", value: "pico.spatial.windowcontainer.style", ...baseQuery }), "1");
        const sizes = staticMetadata(findFactEvidence(index, { kind: "manifest.metadata", value: "pico.spatial.windowcontainer.defaultsize", ...baseQuery }), "1280x720");
        for (const metadataId of ids) for (const style of styles) for (const size of sizes) {
          bindings.push({ typed: [applicationId, activity, metadataId, style, size] });
        }
      }
    }
  }
  if (bindings.length !== 1) return failed(id, "supported-subset-v1 typed binding incomplete");
  const facts = typedEvidence(index, bindings[0].typed);
  if (facts === null) return failed(id, "supported-subset-v1 typed-fact evidence unrepresentable");
  return {
    id,
    pass: true,
    evidence: [...claim.sourceEvidence, ...facts],
    reason: `supported-subset-v1 witness: ${claim.proofForm}`,
  };
}

function claimOnly(context, id) {
  const gate = claimGate(context, id);
  if (gate.failure) return gate.failure;
  return {
    id,
    pass: true,
    evidence: gate.claim.sourceEvidence,
    reason: `supported-subset-v1 witness: ${gate.claim.proofForm}`,
  };
}

export function evaluateSpatialRules(index, context) {
  return [
    projectEntry(index, context),
    containerTopology(index, context),
    ...SOURCE_ONLY_RULE_IDS.map((id) => claimOnly(context, id)),
  ];
}
