import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalIdentity } from "./identity.mjs";

const CORPUS_KEYS = new Set(["schemaVersion", "corpusId", "rubricVersion", "sdkVersion", "picoCli", "claudeCliVersion", "claudeCliCommit", "claudeCliSha256", "toolchainNpm", "effort", "timeoutMs", "maxTurns", "maxOutputBytes", "expectedDoorTools", "seed", "controlVariantIds", "lanes", "variants"]);
const TEMPLATE_TOKENS = new Set(["VARIANT_TITLE", "VARIANT_ID", "ITEM_1", "ITEM_2", "ITEM_3"]);
const PROHIBITED_PROMPT_TERMS = ["EntityQueryCondition", "SceneUpdateContext", "Bundle", "PlaneTrackingManager", "deltaTime"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, label, keys) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required key: ${key}`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    assertString(item.id, `${label}.id`);
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate id: ${item.id}`);
    ids.add(item.id);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function parseJson(filePath, label) {
  return parseJsonBytes(fs.readFileSync(filePath), label);
}

function validateCorpus(corpus) {
  assertExactKeys(corpus, "corpus", CORPUS_KEYS);
  if (corpus.schemaVersion !== 1 || corpus.rubricVersion !== 1 || corpus.corpusId !== "pico-spatial-agent-bench-v1") throw new Error("corpus version drift");
  if (corpus.sdkVersion !== "0.13.3" || corpus.claudeCliVersion !== "2.1.233" || corpus.claudeCliCommit !== "f8d57569aaf3" || corpus.claudeCliSha256 !== "bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d") throw new Error("corpus pinned version drift");
  assertExactKeys(corpus.picoCli, "corpus.picoCli", new Set(["package", "version", "integrity"]));
  if (corpus.picoCli.package !== "@picoxr/pico-cli" || corpus.picoCli.version !== "0.4.2") throw new Error("pico-cli version drift");
  assertString(corpus.picoCli.integrity, "corpus.picoCli.integrity");
  assertExactKeys(corpus.toolchainNpm, "corpus.toolchainNpm", new Set(["version", "integrity"]));
  if (corpus.toolchainNpm.version !== "10.9.2") throw new Error("npm version drift");
  assertString(corpus.toolchainNpm.integrity, "corpus.toolchainNpm.integrity");
  if (corpus.effort !== "high") throw new Error("corpus effort drift");
  for (const [key, expected] of [["timeoutMs", 1_800_000], ["maxTurns", 100], ["maxOutputBytes", 67_108_864], ["seed", 20_260_816]]) {
    if (!Number.isSafeInteger(corpus[key]) || corpus[key] !== expected) throw new Error(`corpus ${key} drift`);
  }
  if (!Array.isArray(corpus.expectedDoorTools) || corpus.expectedDoorTools.length !== 18 || new Set(corpus.expectedDoorTools).size !== 18) throw new Error("corpus.expectedDoorTools must contain the frozen door tool set");
  for (const tool of corpus.expectedDoorTools) assertString(tool, "corpus.expectedDoorTools entry");
  if (!Array.isArray(corpus.controlVariantIds) || new Set(corpus.controlVariantIds).size !== corpus.controlVariantIds.length) throw new Error("corpus.controlVariantIds contains duplicates");
  for (const id of corpus.controlVariantIds) assertString(id, "corpus.controlVariantIds entry");
  if (!Array.isArray(corpus.lanes) || corpus.lanes.length !== 4) throw new Error("corpus.lanes must contain four lanes");
  for (const lane of corpus.lanes) {
    assertExactKeys(lane, "corpus.lanes entry", new Set(["id", "model", "treatment", "role"]));
    assertString(lane.id, "corpus lane id");
    if (!["claude-sonnet-5", "claude-opus-5"].includes(lane.model) || !["mcp", "bare"].includes(lane.treatment) || !["primary", "control"].includes(lane.role)) throw new Error("corpus lane drift");
  }
  assertIds(corpus.lanes, "corpus.lanes");
  if (corpus.lanes.filter((lane) => lane.role === "primary").length !== 2 || corpus.lanes.filter((lane) => lane.role === "control").length !== 2) throw new Error("corpus lanes must contain two primary and two control lanes");
  if (!Array.isArray(corpus.variants) || corpus.variants.length !== 5) throw new Error("corpus.variants must contain five variants");
  for (const variant of corpus.variants) {
    assertExactKeys(variant, "corpus.variants entry", new Set(["id", "title", "items"]));
    assertString(variant.id, "corpus variant id");
    assertString(variant.title, "corpus variant title");
    if (!Array.isArray(variant.items) || variant.items.length !== 3) throw new Error("each variant must contain three items");
    for (const item of variant.items) assertString(item, "corpus variant item");
  }
  assertIds(corpus.variants, "corpus.variants");
  const variantIds = new Set(corpus.variants.map((variant) => variant.id));
  for (const id of corpus.controlVariantIds) if (!variantIds.has(id)) throw new Error(`corpus control variant is unknown: ${id}`);
}

function validatePrompt(prompt) {
  for (const term of PROHIBITED_PROMPT_TERMS) if (prompt.includes(term)) throw new Error(`prompt contains prohibited rubric API term: ${term}`);
  const found = new Set();
  for (const match of prompt.matchAll(/{{([^{}]+)}}/g)) {
    if (!TEMPLATE_TOKENS.has(match[1])) throw new Error(`prompt contains undeclared template token: ${match[1]}`);
    found.add(match[1]);
  }
  for (const token of TEMPLATE_TOKENS) if (!found.has(token)) throw new Error(`prompt is missing template token: ${token}`);
}

function validateToolchain(packageJson, lockfile, corpus) {
  assertExactKeys(packageJson, "toolchain package.json", new Set(["name", "version", "private", "dependencies"]));
  if (packageJson.name !== "pico-spatial-agent-bench-pico-cli-toolchain" || packageJson.version !== "1.0.0" || packageJson.private !== true) throw new Error("toolchain package metadata drift");
  assertExactKeys(packageJson.dependencies, "toolchain dependencies", new Set([corpus.picoCli.package]));
  if (packageJson.dependencies[corpus.picoCli.package] !== corpus.picoCli.version) throw new Error("toolchain pico-cli version drift");
  if (!isRecord(lockfile) || lockfile.lockfileVersion !== 3 || !isRecord(lockfile.packages)) throw new Error("toolchain lockfile must use npm lockfile v3");
  const root = lockfile.packages[""];
  if (!isRecord(root) || !isRecord(root.dependencies) || root.dependencies[corpus.picoCli.package] !== corpus.picoCli.version) throw new Error("toolchain lockfile root dependency drift");
  for (const [entryPath, entry] of Object.entries(lockfile.packages)) {
    if (entryPath === "") continue;
    if (!isRecord(entry) || typeof entry.resolved !== "string" || !entry.resolved || typeof entry.integrity !== "string" || !entry.integrity) throw new Error(`toolchain lockfile package lacks resolved URL or integrity: ${entryPath}`);
  }
  const picoEntry = lockfile.packages[`node_modules/${corpus.picoCli.package}`];
  if (!isRecord(picoEntry) || picoEntry.version !== corpus.picoCli.version || picoEntry.integrity !== corpus.picoCli.integrity) throw new Error("toolchain pico-cli integrity drift");
}

function counterStream(seed, label) {
  let counter = 0;
  return () => crypto.createHash("sha256").update(`${String(seed)}\0${label}\0${String(counter++)}`).digest().readUInt32BE(0) / 2 ** 32;
}

function fisherYates(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

export function loadCorpus(corpusDir) {
  const directory = path.resolve(corpusDir);
  const corpusPath = path.join(directory, "corpus.json");
  const promptPath = path.join(directory, "prompt.md");
  const packagePath = path.join(directory, "pico-cli-toolchain", "package.json");
  const lockPath = path.join(directory, "pico-cli-toolchain", "package-lock.json");
  const corpusBytes = fs.readFileSync(corpusPath);
  const corpus = parseJsonBytes(corpusBytes, "corpus");
  const promptBytes = fs.readFileSync(promptPath);
  const prompt = promptBytes.toString("utf8");
  const packageBytes = fs.readFileSync(packagePath);
  const lockBytes = fs.readFileSync(lockPath);
  const packageJson = parseJson(packagePath, "toolchain package.json");
  const lockfile = parseJson(lockPath, "toolchain package-lock.json");
  validateCorpus(corpus);
  validatePrompt(prompt);
  for (const toolName of corpus.expectedDoorTools) {
    if (prompt.includes(toolName)) throw new Error(`prompt contains treatment-specific tool: ${toolName}`);
  }
  validateToolchain(packageJson, lockfile, corpus);
  const identity = canonicalIdentity({ corpus, corpusBytes: corpusBytes.toString("base64"), promptBytes: promptBytes.toString("base64"), toolchainPackageBytes: packageBytes.toString("base64"), toolchainLockBytes: lockBytes.toString("base64") });
  return Object.freeze({ corpus: deepFreeze(corpus), prompt, identity: Object.freeze(identity) });
}

export function renderPrompt(loaded, variantId) {
  if (!loaded || !loaded.corpus || typeof loaded.prompt !== "string") throw new Error("loaded corpus is invalid");
  const variant = loaded.corpus.variants.find((entry) => entry.id === variantId);
  if (!variant) throw new Error(`unknown corpus variant: ${variantId}`);
  const replacements = { VARIANT_TITLE: variant.title, VARIANT_ID: variant.id, ITEM_1: variant.items[0], ITEM_2: variant.items[1], ITEM_3: variant.items[2] };
  const rendered = loaded.prompt.replace(/{{([^{}]+)}}/g, (_match, token) => {
    if (!Object.hasOwn(replacements, token)) throw new Error(`prompt contains undeclared template token: ${token}`);
    return replacements[token];
  });
  if (/{{[^{}]+}}/.test(rendered)) throw new Error("prompt contains unreplaced template tokens");
  return rendered;
}

export function createPreliminarySchedule(loaded) {
  const { corpus } = loaded;
  const primaryLanes = corpus.lanes.filter((lane) => lane.role === "primary");
  const primaryLaneCandidates = [...primaryLanes]
    .sort((left, right) => Number(right.treatment === "bare") - Number(left.treatment === "bare"))
    .map((lane) => lane.id);
  const controlLanes = corpus.lanes.filter((lane) => lane.role === "control").map((lane) => lane.id);
  const orderedVariants = fisherYates(corpus.variants.map((variant) => variant.id), counterStream(corpus.seed, "preliminary-primary-order"));
  const laneRandom = counterStream(corpus.seed, "preliminary-primary-lanes");
  const primary = orderedVariants.map((variantId) => ({ variantId, lanes: fisherYates(primaryLaneCandidates, laneRandom) }));
  const controlCandidates = controlLanes.flatMap((laneId) => corpus.controlVariantIds.map((variantId) => ({ variantId, laneId })));
  const controls = fisherYates(controlCandidates, counterStream(corpus.seed, "preliminary-controls"));
  return Object.freeze({ primary: Object.freeze(primary), controls: Object.freeze(controls) });
}

export function createSignoffSchedule(loaded) {
  const { corpus } = loaded;
  const primaryLanes = corpus.lanes.filter((lane) => lane.role === "primary").map((lane) => lane.id);
  const pairs = [0, 1].flatMap((accountBlock) => corpus.variants.map((variant) => ({ accountBlock, variantId: variant.id, lanes: [...primaryLanes] })));
  return Object.freeze({ primary: Object.freeze(fisherYates(pairs, counterStream(corpus.seed, "signoff-primary"))), controls: Object.freeze([]) });
}
