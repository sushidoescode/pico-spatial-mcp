import { findEvidence, findFactEvidence } from "./source.mjs";

function testPattern(source, pattern) {
  if (typeof pattern === "string") return source.includes(pattern);
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(source);
}

function matchingFile(index, patterns, pathPattern = /\.kt$/) {
  return index.files.find((file) => testPattern(file.path, pathPattern) && patterns.every((pattern) => testPattern(file.structural, pattern))) ?? null;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function balanced(source, opening, open = "{", close = "}") {
  if (opening < 0 || source[opening] !== open) return null;
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close) depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  return null;
}

function balancedEnd(source, opening, open = "{", close = "}") {
  if (opening < 0 || source[opening] !== open) return -1;
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function containingFunction(source, offset) {
  let found = null;
  for (const match of source.matchAll(/\bfun\s+(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\([^)]*\)/g)) {
    if (match.index > offset) break;
    const opening = source.indexOf("{", match.index + match[0].length);
    const end = balancedEnd(source, opening);
    if (opening >= 0 && opening < offset && offset < end) found = { name: match[1], start: match.index, opening, end };
  }
  return found;
}

function calledOutsideOwnBody(source, owner) {
  if (!owner) return false;
  const matcher = new RegExp(`\\b${owner.name}\\s*\\(`, "g");
  return [...source.matchAll(matcher)].some((match) => match.index < owner.start || match.index > owner.end);
}

function braceDepth(source, end) {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
  }
  return depth;
}

function callArguments(source, pattern) {
  const match = pattern.exec(source);
  if (!match) return null;
  const opening = source.indexOf("(", match.index);
  return balanced(source, opening, "(", ")");
}

function allCallArguments(source, pattern) {
  const matcher = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "g");
  const calls = [];
  for (const match of source.matchAll(matcher)) {
    const opening = source.indexOf("(", match.index);
    const argumentsText = balanced(source, opening, "(", ")");
    if (argumentsText !== null) calls.push({ argumentsText, index: match.index });
  }
  return calls;
}

function topLevelArguments(source) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ("([{<".includes(source[index])) depth += 1;
    else if (")]}>".includes(source[index])) depth -= 1;
    else if (source[index] === "," && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function kotlinClasses(index, supertype) {
  const classes = [];
  for (const file of index.files) {
    if (!/\.kt$/.test(file.path)) continue;
    const packageName = /(?:^|\n)\s*package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(file.structural)?.[1] ?? "";
    const declaration = new RegExp(`class\\s+([A-Za-z_]\\w*)\\s*:\\s*${supertype}\\s*\\(\\s*\\)`).exec(file.structural);
    if (declaration) classes.push({ file, name: declaration[1], qualifiedName: packageName ? `${packageName}.${declaration[1]}` : declaration[1] });
  }
  return classes;
}

function resolvedManifestName(name, applicationId) {
  if (name.startsWith(".")) return `${applicationId}${name}`;
  if (name.includes(".")) return name;
  return `${applicationId}.${name}`;
}

function sourceRows(index, file, patterns) {
  if (!file) return [];
  const rows = [];
  for (const pattern of patterns) {
    const evidence = findEvidence(index, pattern, { paths: file.path });
    if (evidence[0]) rows.push({ evidenceClass: "source", ...evidence[0] });
  }
  return rows;
}

function typedRows(facts) {
  return facts.map((fact) => ({ evidenceClass: "typed_fact", ...fact }));
}

function passRule(id, pass, evidence, reason) {
  return { id, pass, evidence: pass ? evidence : [], reason };
}

function componentShape(file) {
  if (!file) return null;
  const declaration = /class\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*:\s*Component\s*\(\s*\)\s*\{([\s\S]*?)\n\}/m.exec(file.structural);
  if (!declaration) return null;
  const [, name, parameters, body] = declaration;
  const fields = [...parameters.matchAll(/\b(?:var|val)\s+([A-Za-z_]\w*)\s*:[^,=]+=[^,\n]+/g)].map((match) => match[1]);
  const clone = new RegExp(`override\\s+fun\\s+clone\\s*\\(\\s*\\)\\s*:\\s*${name}\\s*=\\s*${name}\\s*\\(([^)]*)\\)`).exec(body);
  if (fields.length === 0 || !clone) return null;
  const argumentsText = clone[1];
  if (!fields.every((field) => new RegExp(`\\b${field}\\b`).test(argumentsText))) return null;
  return { name };
}

function systemShape(file) {
  if (!file) return null;
  const declaration = /class\s+([A-Za-z_]\w*)\s*:\s*System\s*\(\s*\)\s*\{([\s\S]*)\n\}/m.exec(file.structural);
  if (!declaration) return null;
  const [, type, body] = declaration;
  const query = /private\s+val\s+([A-Za-z_]\w*)\s*=\s*EntityQueryCondition\.hasComponent\(\s*([A-Za-z_]\w*)::class\.java\s*\)/.exec(body);
  const updateOffset = body.search(/override\s+fun\s+update\s*\(\s*([A-Za-z_]\w*)\s*:\s*SceneUpdateContext\s*\)/);
  if (!query || updateOffset < 0 || body.indexOf(query[0]) > updateOffset) return null;
  const context = /override\s+fun\s+update\s*\(\s*([A-Za-z_]\w*)\s*:\s*SceneUpdateContext\s*\)/.exec(body)[1];
  const updateOpening = body.indexOf("{", updateOffset);
  const updateBody = balanced(body, updateOpening);
  if (!updateBody) return null;
  if (!new RegExp(`\\b${context}\\.scene\\.queryEntity\\(\\s*${query[1]}\\s*\\)`).test(updateBody)) return null;
  return { type, body: updateBody, context };
}

function systemUpdateShape(file) {
  if (!file) return null;
  const declaration = /class\s+([A-Za-z_]\w*)\s*:\s*System\s*\(\s*\)\s*\{([\s\S]*)\n\}/m.exec(file.structural);
  if (!declaration) return null;
  const update = /override\s+fun\s+update\s*\(\s*([A-Za-z_]\w*)\s*:\s*SceneUpdateContext\s*\)/.exec(declaration[2]);
  if (!update) return null;
  const opening = declaration[2].indexOf("{", update.index);
  const body = balanced(declaration[2], opening);
  return body ? { type: declaration[1], body, context: update[1] } : null;
}

function projectEntry(index) {
  const android = findFactEvidence(index, { kind: "gradle.plugin", value: "com.android.application" });
  const bom = findFactEvidence(index, { kind: "gradle.dependency", value: "com.pico.spatial:bom", version: "0.13.3" });
  const spatial = findFactEvidence(index, { kind: "gradle.dependency", value: "com.pico.spatial.ui:foundation" });
  const applicationIds = findFactEvidence(index, { kind: "gradle.applicationId" });
  const applications = findFactEvidence(index, { kind: "manifest.application" });
  const activities = findFactEvidence(index, { kind: "manifest.activity" });
  const main = matchingFile(index, [/fun\s+mainApp\s*\(/, /DefaultWindowContainer\s*\{/]);
  const applicationClasses = kotlinClasses(index, "Application").filter(({ file }) => /launch\s*\(\s*::mainApp\s*\)/.test(file.structural));
  const activityClasses = kotlinClasses(index, "SpatialLaunchActivity");
  let bound = null;
  for (const applicationId of applicationIds) {
    const application = applicationClasses.find((candidate) => applications.some((fact) => resolvedManifestName(fact.value, applicationId.value) === candidate.qualifiedName));
    const activity = activityClasses.find((candidate) => activities.some((fact) => resolvedManifestName(fact.value, applicationId.value) === candidate.qualifiedName));
    if (application && activity) {
      bound = { applicationId, application, activity, applicationFact: applications.find((fact) => resolvedManifestName(fact.value, applicationId.value) === application.qualifiedName), activityFact: activities.find((fact) => resolvedManifestName(fact.value, applicationId.value) === activity.qualifiedName) };
      break;
    }
  }
  const pass = android.length > 0 && bom.length > 0 && spatial.length > 0 && main && bound;
  const evidence = [
    ...sourceRows(index, main, [/fun\s+mainApp\s*\(/]),
    ...sourceRows(index, bound?.application.file, [/launch\s*\(\s*::mainApp\s*\)/]),
    ...sourceRows(index, bound?.activity.file, [/SpatialLaunchActivity\s*\(\s*\)/]),
    ...typedRows([android[0], bom[0], spatial[0], bound?.applicationId, bound?.applicationFact, bound?.activityFact].filter(Boolean)),
  ];
  return passRule("spatial.project-entry", Boolean(pass), evidence, pass
    ? "active Android and PICO 0.13.3 facts are wired through the manifest application and mainApp launch"
    : "the active Android/PICO 0.13.3 project and manifest-to-mainApp launch conjunction is incomplete");
}

function containerTopology(index) {
  let owner = null;
  let metadata = null;
  const launchClassNames = new Set(kotlinClasses(index, "SpatialLaunchActivity").map(({ qualifiedName }) => qualifiedName));
  const applicationIds = findFactEvidence(index, { kind: "gradle.applicationId" }).map((fact) => fact.value);
  for (const activity of findFactEvidence(index, { kind: "manifest.activity" })) {
    if (!applicationIds.some((applicationId) => launchClassNames.has(resolvedManifestName(activity.value, applicationId)))) continue;
    const query = (value) => findFactEvidence(index, {
      kind: "manifest.metadata",
      value,
      scope: "activity",
      activityName: activity.value,
    });
    const id = query("pico.spatial.windowcontainer.id").filter((row) => row.metadata.resource === null && typeof row.metadata.value === "string" && row.metadata.value.length > 0);
    const style = query("pico.spatial.windowcontainer.style").filter((row) => row.metadata.resource === null && row.metadata.value === "1");
    const size = query("pico.spatial.windowcontainer.defaultsize").filter((row) => row.metadata.resource === null && row.metadata.value === "1280x720");
    if (id.length > 0 && style.length > 0 && size.length > 0) {
      owner = activity;
      metadata = [id[0], style[0], size[0]];
      break;
    }
  }
  const main = matchingFile(index, [
    /DefaultWindowContainer\s*\{/,
    /Stage\s*\([\s\S]*?\)\s*\{/,
    /openStage\s*\([\s\S]*?StageStyle\.Mixed\s*,[\s\S]*?\bbundle\b[\s\S]*?\)/,
  ]);
  let validStageDeclaration = false;
  if (main) {
    const declaredIds = new Set(allCallArguments(main.structural, /\bStage\s*\(/).flatMap(({ argumentsText: declaration }) => {
      if (/\bstyle\s*=/.test(declaration)) return [];
      const id = topLevelArguments(declaration).map((argument) => /^id\s*=\s*([\s\S]+)$/.exec(argument)?.[1]?.replace(/\s+/g, "")).find(Boolean);
      return id ? [id] : [];
    }));
    const mixedOpenIds = allCallArguments(main.structural, /\bopenStage\s*\(/).flatMap(({ argumentsText: opened, index: openOffset }) => {
      const args = topLevelArguments(opened);
      const ownerFunction = containingFunction(main.structural, openOffset);
      return args.length >= 3 && /\bStageStyle\.Mixed\b/.test(args[1]) && /\bbundle\b/.test(args.slice(2).join(",")) && calledOutsideOwnBody(main.structural, ownerFunction)
        ? [args[0].replace(/\s+/g, "")]
        : [];
    });
    validStageDeclaration = mixedOpenIds.some((id) => declaredIds.has(id));
  }
  const pass = Boolean(owner && metadata && main && validStageDeclaration);
  const evidence = [
    ...sourceRows(index, main, [/DefaultWindowContainer\s*\{/, /\bStage\s*\(/, /openStage\s*\([\s\S]*?StageStyle\.Mixed/]),
    ...typedRows(metadata ?? []),
  ];
  return passRule("spatial.container-topology", pass, evidence, pass
    ? "the launch activity owns the planar window facts and mainApp declares then opens a secondary Mixed Stage"
    : "activity-owned planar window facts or the declared-and-opened Mixed Stage relationship is incomplete");
}

function entityContent(index) {
  const main = matchingFile(index, [/\bStage\s*\([\s\S]*?\)\s*\{[\s\S]*?GalleryStage\s*\(/]);
  const content = matchingFile(index, [
    /fun\s+GalleryStage\s*\(/,
    /SpatialView\s*\(/,
    /\bEntity\s*\(/,
    /\.components\.(?:set|get)|components\s*\[/,
    /(?:addEntity|addChild)\s*\(/,
  ]);
  const androidSubstitute = content && /\b(?:Activity|AndroidView|View|Canvas|GLSurfaceView|OpenGL)\b/.test(content.structural);
  const pass = Boolean(main && content && !androidSubstitute);
  return passRule("spatial.entity-content", pass, sourceRows(index, content, [/SpatialView\s*\(/, /\bEntity\s*\(/, /\.components\.(?:set|get)|components\s*\[/]), pass
    ? "secondary Stage content is owned by SpatialView and PICO ECS entities/components"
    : "secondary Stage content lacks the SpatialView and PICO ECS ownership conjunction");
}

function uiLifecycle(index) {
  const main = matchingFile(index, [
    /DefaultWindowContainer\s*\{\s*PicoTheme\s*\{/,
    /GalleryWindow\s*\(/,
  ]);
  const stage = matchingFile(index, [
    /fun\s+GalleryStage\s*\(/,
    /DisposableEffect\s*\(/,
    /onDispose\s*\{/,
  ]);
  const pass = Boolean(main && stage);
  return passRule("spatial.ui-lifecycle", pass, [
    ...sourceRows(index, main, [/DefaultWindowContainer\s*\{\s*PicoTheme\s*\{/]),
    ...sourceRows(index, stage, [/DisposableEffect\s*\(/, /onDispose\s*\{/]),
  ], pass
    ? "planar SpatialUI content is under PicoTheme and Stage-owned resources have a paired composition lifecycle"
    : "the PicoTheme planar root or paired Stage composition lifecycle is incomplete");
}

function componentClone(index) {
  const file = index.files.find((candidate) => /\.kt$/.test(candidate.path) && /:\s*Component\s*\(\s*\)/.test(candidate.structural));
  const shape = componentShape(file);
  const pass = Boolean(shape);
  return passRule("ecs.component-clone", pass, sourceRows(index, file, [/class\s+\w+\s*\([\s\S]*?\)\s*:\s*Component/, /override\s+fun\s+clone\s*\(/]), pass
    ? "a default-constructible state-bearing Component clones all retained constructor state"
    : "no default-constructible state-bearing Component has a state-preserving clone");
}

function systemQuery(index) {
  const file = index.files.find((candidate) => /\.kt$/.test(candidate.path) && /:\s*System\s*\(\s*\)/.test(candidate.structural));
  const shape = systemShape(file);
  const pass = Boolean(shape);
  return passRule("ecs.system-query", pass, sourceRows(index, file, [/EntityQueryCondition\.hasComponent\s*\(/, /context\.scene\.queryEntity\s*\(/]), pass
    ? "a custom System hoists a component query and applies it to context.scene during update"
    : "the custom System lacks a hoisted component query against update context.scene");
}

function frameUpdate(index) {
  const file = index.files.find((candidate) => /\.kt$/.test(candidate.path) && /:\s*System\s*\(\s*\)/.test(candidate.structural));
  const shape = systemUpdateShape(file);
  let pass = false;
  if (shape) {
    const component = /val\s+([A-Za-z_]\w*)\s*=\s*\w+\.components\[\s*TransformComponent::class\.java\s*\]/.exec(shape.body);
    const deltaMutation = new RegExp(`\\b([A-Za-z_]\\w*)\\.([A-Za-z_]\\w*)\\s*(?:\\+=|=)\\s*[^\\n;]*\\b${shape.context}\\.deltaTime\\b`).exec(shape.body);
    const transformAssignment = component && new RegExp(`\\b${component[1]}\\.(?:position|quaternion|eulerAngles|scaleVector)\\s*=([^\\n;]+)`).exec(shape.body);
    pass = Boolean(component && deltaMutation && transformAssignment
      && new RegExp(`\\b${deltaMutation[1]}\\.${deltaMutation[2]}\\b|\\b${shape.context}\\.deltaTime\\b`).test(transformAssignment[1])
      && !/components\.set\s*\(\s*TransformComponent/.test(shape.body));
  }
  return passRule("ecs.frame-update", pass, sourceRows(index, file, [/context\.deltaTime/, /transform\.(?:position|quaternion|eulerAngles|scaleVector)\s*=/]), pass
    ? "per-frame work scales by context.deltaTime and mutates an existing TransformComponent property"
    : "per-frame work lacks deltaTime-scaled in-place TransformComponent mutation");
}

function lifecycle(index) {
  const file = matchingFile(index, [/DisposableEffect\s*\(/, /registerSystem\s*</]);
  const effectOpening = file ? file.structural.indexOf("{", file.structural.search(/DisposableEffect\s*\(/)) : -1;
  const effect = file ? balanced(file.structural, effectOpening) : null;
  const registered = effect ? /\bregisterSystem\s*<\s*([A-Za-z_]\w*)\s*>\s*\(\s*\)/.exec(effect) : null;
  const disposeOffset = effect ? effect.search(/onDispose\s*\{/) : -1;
  const disposeOpening = effect ? effect.indexOf("{", disposeOffset) : -1;
  const dispose = effect ? balanced(effect, disposeOpening) : null;
  const unregistered = dispose ? /unregisterSystem\s*<\s*([A-Za-z_]\w*)\s*>\s*\(\s*\)/.exec(dispose) : null;
  const pass = Boolean(registered && braceDepth(effect, registered.index) === 0
    && disposeOffset >= 0 && registered.index < disposeOffset
    && unregistered && registered[1] === unregistered[1]);
  return passRule("ecs.lifecycle", pass, sourceRows(index, file, [/registerSystem\s*</, /unregisterSystem\s*</]), pass
    ? "one composition lifecycle registers and unregisters the same concrete System type"
    : "one paired lifecycle does not register and unregister the same concrete System type");
}

export function evaluateSpatialRules(index) {
  return [
    projectEntry(index),
    containerTopology(index),
    entityContent(index),
    uiLifecycle(index),
    componentClone(index),
    systemQuery(index),
    frameUpdate(index),
    lifecycle(index),
  ];
}
