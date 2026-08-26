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
    else if (value === "<") angleDepth += 1;
    else if (value === ">") angleDepth -= 1;
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
    else if (value === "<") angleDepth += 1;
    else if (value === ">") angleDepth -= 1;
    else if (value === "{" && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) break;
    else if (value === ":" && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      if (colonOffset >= 0) return null;
      colonOffset = index;
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
  if (!["(", "{", "\n"].includes(tokens[cursor]?.value ?? "\n")) return null;

  parenDepth = 0;
  angleDepth = 0;
  for (let index = cursor; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(") parenDepth += 1;
    else if (value === ")") parenDepth -= 1;
    else if (value === "<") angleDepth += 1;
    else if (value === ">") angleDepth -= 1;
    else if (value === "," && parenDepth === 0 && angleDepth === 0) return null;
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

function typedEvidence(index, rows) {
  const evidence = [];
  for (const row of rows) {
    const files = index.files.filter((file) => file.path === row.path);
    if (files.length !== 1) throw new Error("typed fact source path must resolve exactly once");
    const structuralExcerpt = files[0].structural.split("\n")[row.line - 1]?.trim();
    if (typeof structuralExcerpt !== "string") throw new Error("typed fact source line is out of bounds");
    if (typeof row.excerpt !== "string") throw new Error("typed fact excerpt must be a string");
    if (structuralExcerpt.length === 0 || Buffer.byteLength(structuralExcerpt, "utf8") > 512
        || row.excerpt.length === 0 || Buffer.byteLength(row.excerpt, "utf8") > 512) return null;
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
