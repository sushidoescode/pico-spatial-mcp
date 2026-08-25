import { findEvidence } from "./source.mjs";

function testPattern(source, pattern) {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(source);
}

function matchingFile(index, patterns) {
  return index.files.find((file) => /\.kt$/.test(file.path) && patterns.every((pattern) => testPattern(file.structural, pattern))) ?? null;
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

function functionBodyContaining(source, pattern) {
  const target = source.search(pattern);
  if (target < 0) return null;
  const signature = source.lastIndexOf("fun ", target);
  if (signature < 0) return null;
  const opening = source.indexOf("{", signature);
  if (opening < 0 || opening > target) return null;
  return balanced(source, opening);
}

function expressionFunction(source, name) {
  const signature = new RegExp(`(?:private\\s+)?fun\\s+${escaped(name)}\\s*\\([^)]*\\)\\s*:\\s*PlaneAnchor\\?\\s*=`).exec(source);
  if (!signature) return null;
  const rest = source.slice(signature.index + signature[0].length);
  const end = rest.search(/\n\s*(?:(?:private|suspend)\s+)?fun\s+[A-Za-z_]\w*\s*\(/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function planeHelper(source, name) {
  const signature = new RegExp(`(?:private\\s+)?fun\\s+${escaped(name)}\\s*\\(\\s*([A-Za-z_]\\w*)\\s*:\\s*PlaneAnchor\\s*\\)\\s*:\\s*(?:Boolean|Float)\\s*=`).exec(source);
  if (!signature) return null;
  const rest = source.slice(signature.index + signature[0].length);
  const end = rest.search(/\n\s*(?:(?:private|suspend)\s+)?fun\s+[A-Za-z_]\w*\s*\(/);
  return { parameter: signature[1], body: (end < 0 ? rest : rest.slice(0, end)).trim() };
}

function validatesOrientation(source, name) {
  const helper = planeHelper(source, name);
  if (!helper) return false;
  const parameter = escaped(helper.parameter);
  return new RegExp(`\\b${parameter}\\.planeOrientation\\s*==\\s*PlaneOrientation\\.HORIZONTAL_UPWARD`).test(helper.body)
    && new RegExp(`\\b${parameter}\\.planeOrientation\\s*==\\s*PlaneOrientation\\.HORIZONTAL_DOWNWARD`).test(helper.body);
}

function validatesArea(source, name) {
  const helper = planeHelper(source, name);
  if (!helper) return false;
  const parameter = escaped(helper.parameter);
  return new RegExp(`\\b${parameter}\\.boundingBoxSize\\.x\\s*\\*\\s*${parameter}\\.boundingBoxSize\\.y\\b`).test(helper.body);
}

function rows(index, file, patterns) {
  if (!file) return [];
  return patterns.flatMap((pattern) => {
    const match = findEvidence(index, pattern, { paths: file.path })[0];
    return match ? [{ evidenceClass: "source", ...match }] : [];
  });
}

function rule(id, pass, evidence, yes, no) {
  return { id, pass, evidence: pass ? evidence : [], reason: pass ? yes : no };
}

function retainedStore(main) {
  if (!main) return null;
  const singleton = /(?:^|\n)\s*val\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.instance\b/m.exec(main.structural);
  if (singleton) return { variable: singleton[1], type: singleton[2], snapshot: "snapshot", declaration: singleton[0].trim() };
  const current = /(?:^|\n)\s*val\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*=\s*\2\.current\s*\(\s*\)/m.exec(main.structural);
  if (current) return { variable: current[1], type: current[2], snapshot: "currentSnapshot", declaration: current[0].trim() };
  return null;
}

function storeBinding(main) {
  const retained = retainedStore(main);
  if (retained) return retained;
  if (!main) return null;
  const constructed = /(?:^|\n)\s*val\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(\s*\)/m.exec(main.structural);
  return constructed ? { variable: constructed[1], type: constructed[2], snapshot: "snapshot", declaration: constructed[0].trim() } : null;
}

function fileWithStore(index, { retainedOnly = false, patterns = [] } = {}) {
  return index.files.find((file) => /\.kt$/.test(file.path)
    && patterns.every((pattern) => testPattern(file.structural, pattern))
    && (retainedOnly ? retainedStore(file) : storeBinding(file))) ?? null;
}

function singleSource(index) {
  const main = fileWithStore(index, { retainedOnly: true, patterns: [/DefaultWindowContainer\s*\{/, /\bStage\s*\(/] });
  const retained = retainedStore(main);
  const pass = Boolean(retained);
  return rule("state.single-source", pass, rows(index, main, retained ? [retained.declaration] : []),
    "one process-retained repository is declared outside both container compositions",
    "no process-retained repository authority is declared outside both compositions");
}

function typedHandoff(index) {
  const state = matchingFile(index, [
    /data\s+class\s+\w*Snapshot\s*\([\s\S]*?selection\s*:\s*\w*Selection\?/,
    /selection\s*=\s*\w*Selection\s*\(\s*selectedId\s*\)/,
  ]);
  const bundle = matchingFile(index, [
    /\bBundle\s*\(\s*\)/,
    /putString\s*\(/,
    /putInt\s*\(/,
    /putBoolean\s*\(/,
    /getString\s*\(/,
    /getInt\s*\(/,
    /getBoolean\s*\(/,
  ]);
  const main = matchingFile(index, [/openStage\s*\([\s\S]*?\bbundle\b[\s\S]*?\)/]);
  const pass = Boolean(state && bundle && main);
  return rule("state.typed-handoff", pass, [
    ...rows(index, state, [/data\s+class\s+\w*Snapshot\s*\(/, /selection\s*=\s*\w*Selection\s*\(\s*selectedId\s*\)/]),
    ...rows(index, bundle, [/putString\s*\(/, /getString\s*\(/]),
    ...rows(index, main, [/openStage\s*\(/]),
  ], "a typed snapshot is encoded into Bundle primitives and reconstructed across the Stage boundary",
  "the Stage boundary lacks a typed snapshot with Bundle encoding and reconstruction");
}

function sharedReadWrite(index) {
  const main = fileWithStore(index, { patterns: [/GalleryWindow\s*\(/, /GalleryStage\s*\(/] });
  const retained = storeBinding(main);
  const stage = matchingFile(index, [/fun\s+GalleryStage\s*\(/, /\.restore\s*\(/, /\.select\s*\(/, /\.setPaused\s*\(/]);
  let pass = false;
  if (main && retained && stage) {
    const variable = retained.variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pass = new RegExp(`GalleryWindow\\s*\\(\\s*${variable}\\s*\\)`).test(main.structural)
      && new RegExp(`GalleryStage\\s*\\(\\s*bundle\\s*,\\s*${variable}\\s*\\)`).test(main.structural)
      && !/remember\s*\{\s*(?:BenchmarkStore|GallerySessionRepository)\s*\(/.test(`${main.structural}\n${stage.structural}`);
  }
  return rule("state.shared-read-write", pass, [
    ...rows(index, main, retained ? [new RegExp(`GalleryWindow\\s*\\(\\s*${retained.variable}\\s*\\)`), new RegExp(`GalleryStage\\s*\\(\\s*bundle\\s*,\\s*${retained.variable}\\s*\\)`)] : []),
    ...rows(index, stage, [/\.restore\s*\(/, /\.select\s*\(/, /\.setPaused\s*\(/]),
  ], "Window and Stage read and mutate the same retained repository without a remembered replacement",
  "Window and Stage do not both read and mutate the same retained repository");
}

function reopenWiring(index) {
  const main = fileWithStore(index, { patterns: [/closeStage\s*\(\s*\)/] });
  const retained = storeBinding(main);
  let pass = false;
  let evidencePatterns = [];
  if (main && retained) {
    const variable = retained.variable;
    const variablePattern = escaped(variable);
    const standardCall = new RegExp(`([A-Za-z_]\\w*)\\s*=\\s*${variablePattern}\\.snapshot\\s*\\(\\s*\\)[\\s\\S]*?([A-Za-z_]\\w*)\\s*=\\s*${variablePattern}\\b[\\s\\S]*?([A-Za-z_]\\w*)\\s*=\\s*true`).exec(main.structural);
    const standardControl = standardCall && new RegExp(`if\\s*\\(\\s*${standardCall[3]}\\s*\\)\\s*${standardCall[2]}\\.snapshot\\s*\\(\\s*\\)\\s*else\\s*${standardCall[1]}`).test(main.structural);
    const callbackCall = new RegExp(`([A-Za-z_]\\w*)\\s*=\\s*${variablePattern}\\.${retained.snapshot}\\s*\\(\\s*\\)[\\s\\S]*?([A-Za-z_]\\w*)\\s*=\\s*${variablePattern}\\b[\\s\\S]*?([A-Za-z_]\\w*)\\s*=\\s*${variablePattern}::${retained.snapshot}`).exec(main.structural);
    const callbackControl = callbackCall && new RegExp(`val\\s+\\w+\\s*=\\s*${callbackCall[3]}\\s*\\(\\s*\\)[\\s\\S]*?${callbackCall[2]}\\.restore\\s*\\(`).test(main.structural);
    const closePath = functionBodyContaining(main.structural, /closeStage\s*\(\s*\)/) ?? "";
    const readVariables = ["selection", "visitCount", "paused"].map((field) => new RegExp(`val\\s+([A-Za-z_]\\w*)(?:\\s*:[^=\\n]+)?\\s*=\\s*${variablePattern}\\.${retained.snapshot}\\s*\\(\\s*\\)\\.${field}`).exec(closePath)?.[1] ?? null);
    const retainedReads = readVariables.every(Boolean);
    const restoredReads = retainedReads && new RegExp(`\\.restore\\s*\\(\\s*[A-Za-z_]\\w*\\s*\\(\\s*${readVariables.map(escaped).join("\\s*,\\s*")}\\s*\\)\\s*\\)`).test(closePath);
    const authorityType = escaped(retained.type);
    const noReplacement = !new RegExp(`(?:val|var)\\s+[A-Za-z_]\\w*(?:\\s*:\\s*${authorityType})?\\s*=\\s*${authorityType}\\s*\\(|[A-Za-z_]\\w*\\s*=\\s*${authorityType}\\s*\\(`).test(closePath);
    pass = Boolean(retainedReads && restoredReads && noReplacement && ((standardCall && standardControl) || (callbackCall && callbackControl)));
    evidencePatterns = standardCall
      ? [new RegExp(`${standardCall[3]}\\s*=\\s*true`), /closeStage\s*\(\s*\)/, new RegExp(`${variablePattern}\\.${retained.snapshot}\\s*\\(\\s*\\)\\.selection`)]
      : [new RegExp(`${callbackCall?.[3] ?? "reentry"}\\s*=\\s*\\w+::\\w+`), new RegExp(`${callbackCall?.[3] ?? "reentry"}\\s*\\(\\s*\\)`), /closeStage\s*\(\s*\)/];
  }
  return rule("state.reopen-wiring", pass, rows(index, main, evidencePatterns),
    "Stage open, close, and reentry are wired back to selection, visit, and pause state from one retained repository",
    "Stage reopen construction is not wired back to all retained selection, visit, and pause state");
}

function retryReadiness(index) {
  const file = matchingFile(index, [/PlaneTrackingManager\.start\s*\(\s*\)/, /PlaneTrackingManager\.loadAllAnchors\s*\(\s*\)/]);
  const max = file ? /(?:const\s+val|val)\s+([A-Za-z_]\w*RETR\w*)\s*=\s*(\d+)/i.exec(file.structural) : null;
  const repeatMatch = file && max ? new RegExp(`repeat\\s*\\(\\s*${max[1]}\\s*\\)\\s*\\{`).exec(file.structural) : null;
  const repeatBody = repeatMatch ? balanced(file.structural, file.structural.indexOf("{", repeatMatch.index)) : null;
  const loaded = repeatBody && /(?:val\s+)?([A-Za-z_]\w*)\s*=\s*PlaneTrackingManager\.loadAllAnchors\s*\(\s*\)(?:\.toList\s*\(\s*\))?/.exec(repeatBody);
  const readiness = loaded && new RegExp(`\\b${loaded[1]}\\.(?:isNotEmpty|isEmpty)\\s*\\(\\s*\\)`).exec(repeatBody.slice(loaded.index + loaded[0].length));
  const betweenLoadAndReadiness = loaded && readiness ? repeatBody.slice(loaded.index + loaded[0].length, loaded.index + loaded[0].length + readiness.index) : "";
  const pass = Boolean(file && max && Number(max[2]) > 1 && repeatBody
    && loaded
    && readiness
    && !new RegExp(`\\b${loaded[1]}\\s*=`).test(betweenLoadAndReadiness)
    && !/state\s*==\s*(?:TrackingState\.)?RUNNING/.test(file.structural));
  return rule("plane.retry-readiness", pass, rows(index, file, [/PlaneTrackingManager\.start\s*\(/, /repeat\s*\(/, /PlaneTrackingManager\.loadAllAnchors\s*\(/]),
    "plane tracking starts and anchor loading uses a bounded multi-attempt readiness loop",
    "plane tracking start and bounded multi-attempt anchor readiness are not both present");
}

function semanticFallback(index) {
  const file = matchingFile(index, [
    /SemanticLabelType\.TABLE/,
    /SemanticLabelType\.FLOOR/,
    /PlaneOrientation\.HORIZONTAL_UPWARD/,
    /PlaneOrientation\.HORIZONTAL_DOWNWARD/,
    /boundingBoxSize\.x\s*\*\s*\w+\.boundingBoxSize\.y/,
  ]);
  const placementBody = file && functionBodyContaining(file.structural, /PlaneTrackingManager\.loadAllAnchors\s*\(/);
  const fallback = placementBody && /([A-Za-z_]\w*)\s*\(\s*\)\s*\?:\s*([A-Za-z_]\w*)\s*\(\s*\)/.exec(placementBody);
  const tableBody = fallback ? expressionFunction(file.structural, fallback[1]) : null;
  const floorBody = fallback ? expressionFunction(file.structural, fallback[2]) : null;
  const constrained = (body, semantic) => {
    if (!body || !/\.(?:maxByOrNull|firstOrNull)\s*\(/.test(body)) return false;
    const filter = /\.filter\s*\{\s*(?:([A-Za-z_]\w*)\s*->\s*)?([\s\S]*?)\}/.exec(body);
    if (!filter) return false;
    const element = filter[1] ?? "it";
    const elementPattern = escaped(element);
    if (!new RegExp(`\\b${elementPattern}\\.semantics\\s*==\\s*SemanticLabelType\\.${semantic}\\b`).test(filter[2])) return false;
    const areaCall = new RegExp(`\\b([A-Za-z_]\\w*)\\s*\\(\\s*${elementPattern}\\s*\\)\\s*>\\s*0f`).exec(filter[2]);
    const helperCalls = [...filter[2].matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*\\(\\s*${elementPattern}\\s*\\)`, "g"))].map((match) => match[1]);
    return Boolean(areaCall && validatesArea(file.structural, areaCall[1]) && helperCalls.some((name) => validatesOrientation(file.structural, name)));
  };
  const table = constrained(tableBody, "TABLE");
  const floor = constrained(floorBody, "FLOOR");
  const pass = Boolean(file && fallback && table && floor);
  return rule("plane.semantic-fallback", pass, rows(index, file, [/horizontalTablePlane\s*\(\s*\)\s*\?:\s*horizontalFloorPlane/, /SemanticLabelType\.TABLE/, /SemanticLabelType\.FLOOR/, /boundingBoxSize\.x\s*\*/]),
    "horizontal positive-area TABLE selection falls back to an equally constrained FLOOR plane",
    "TABLE selection lacks horizontal positive-area checks or an equally constrained FLOOR fallback");
}

function anchorPose(index) {
  const file = matchingFile(index, [/convertPositionFrom\s*\(/, /convertRotationFrom\s*\(/]);
  let pass = false;
  if (file) {
    const position = /val\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.convertPositionFrom\(\s*([A-Za-z_]\w*)\.transform\.position\s*,\s*null\s*\)/.exec(file.structural);
    const rotation = /val\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.convertRotationFrom\(\s*([A-Za-z_]\w*)\.transform\.quaternion\s*,\s*null\s*\)/.exec(file.structural);
    if (position && rotation && position[2] === rotation[2] && position[3] === rotation[3]) {
      const converted = position[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pass = new RegExp(`Vector3\\s*\\([\\s\\S]*?${converted}\\.x[\\s\\S]*?${converted}\\.y[\\s\\S]*?${converted}\\.z`).test(file.structural)
        && /boundingBoxSize\.(?:x|y)/.test(file.structural);
    }
  }
  return rule("plane.anchor-pose", pass, rows(index, file, [/convertPositionFrom\s*\(/, /convertRotationFrom\s*\(/, /convertedPosition\.y/]),
    "placement derives position, height, rotation, and spacing from the converted anchor transform and geometry",
    "placement does not derive its pose and height from the converted anchor transform");
}

function cleanupErrors(index) {
  const lifecycle = matchingFile(index, [/PlaneSession\s*\(\s*\)/, /onDispose\s*\{[\s\S]*?\.stopTrackingAndUnsubscribe\s*\(\s*\)/]);
  const plane = matchingFile(index, [
    /SurfaceStatus\.Searching/,
    /SurfaceStatus\.NoSurface/,
    /SurfaceStatus\.Placed/,
    /SurfaceStatus\.Error/,
    /subscription\?\.cancel\s*\(\s*\)/,
    /PlaneTrackingManager\.stop\s*\(\s*\)/,
    /catch\s*\(/,
  ]);
  const pass = Boolean(lifecycle && plane);
  return rule("plane.cleanup-errors", pass, [
    ...rows(index, lifecycle, [/\.stopTrackingAndUnsubscribe\s*\(/]),
    ...rows(index, plane, [/SurfaceStatus\.Searching/, /SurfaceStatus\.NoSurface/, /SurfaceStatus\.Error/, /subscription\?\.cancel/, /PlaneTrackingManager\.stop/]),
  ], "Stage teardown cancels and stops tracking while searching, empty, placed, and error states remain explicit",
  "paired tracking cleanup or explicit searching, empty, placed, and error handling is incomplete");
}

export function evaluateStatePlaneRules(index) {
  return [
    singleSource(index),
    typedHandoff(index),
    sharedReadWrite(index),
    reopenWiring(index),
    retryReadiness(index),
    semanticFallback(index),
    anchorPose(index),
    cleanupErrors(index),
  ];
}
