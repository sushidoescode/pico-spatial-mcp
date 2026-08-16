import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPreliminarySchedule,
  createSignoffSchedule,
  loadCorpus,
  renderPrompt,
} from "../benchmarks/spatial-agent-bench/lib/corpus.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = path.join(root, "benchmarks", "spatial-agent-bench", "v1");

test("v1 corpus freezes the fair four-lane comparison", () => {
  const loaded = loadCorpus(corpusDir);
  assert.equal(loaded.corpus.sdkVersion, "0.13.3");
  assert.equal(loaded.corpus.picoCli.version, "0.4.2");
  assert.equal(loaded.corpus.picoCli.integrity, "sha512-qapgwB+OljD0qQukilhaAmhIemuoIvMO/dkQOVDcZEhLdW1KxpbpkNyLII9hJ6m5F/QYF4UZoPpkjH9IL5U7mA==");
  assert.equal(loaded.corpus.claudeCliVersion, "2.1.233");
  assert.equal(loaded.corpus.claudeCliSha256, "bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d");
  assert.deepEqual(loaded.corpus.toolchainNpm, {
    version: "10.9.2",
    integrity: "sha512-iriPEPIkoMYUy3F6f3wwSZAU93E0Eg6cHwIR6jzzOXWSy+SD/rOODEs74cVONHKSx2obXtuUoyidVEhISrisgQ==",
  });
  assert.equal(loaded.corpus.timeoutMs, 1_800_000);
  assert.equal(loaded.corpus.maxTurns, 100);
  assert.equal(loaded.corpus.seed, 20_260_816);
  assert.deepEqual(loaded.corpus.lanes.map(({ id, model, treatment }) => ({ id, model, treatment })), [
    { id: "sonnet_mcp", model: "claude-sonnet-5", treatment: "mcp" },
    { id: "opus_bare", model: "claude-opus-5", treatment: "bare" },
    { id: "sonnet_bare", model: "claude-sonnet-5", treatment: "bare" },
    { id: "opus_mcp", model: "claude-opus-5", treatment: "mcp" },
  ]);
  assert.deepEqual(loaded.corpus.variants.map((variant) => variant.id), [
    "museum", "planets", "instruments", "botanical", "vehicles",
  ]);
  assert.match(loaded.identity.sha256, /^[a-f0-9]{64}$/);
});

test("identity binds corpus.json bytes as well as parsed corpus content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbench-corpus-"));
  try {
    const copiedCorpusDir = path.join(tempDir, "v1");
    fs.cpSync(corpusDir, copiedCorpusDir, { recursive: true });
    const original = loadCorpus(copiedCorpusDir);
    const corpusPath = path.join(copiedCorpusDir, "corpus.json");
    fs.writeFileSync(corpusPath, `${fs.readFileSync(corpusPath, "utf8")}\n`);
    const whitespaceDrift = loadCorpus(copiedCorpusDir);
    assert.deepEqual(whitespaceDrift.corpus, original.corpus, "whitespace must preserve parsed corpus data");
    assert.notEqual(whitespaceDrift.identity.sha256, original.identity.sha256, "corpus byte drift must change frozen input identity");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loaded corpus exposes no mutable nested frozen input", () => {
  const loaded = loadCorpus(corpusDir);
  assert.equal(Object.isFrozen(loaded.corpus.lanes), true);
  assert.equal(Object.isFrozen(loaded.corpus.lanes[0]), true);
  assert.equal(Object.isFrozen(loaded.corpus.variants), true);
  assert.equal(Object.isFrozen(loaded.corpus.variants[0]), true);
  assert.equal(Object.isFrozen(loaded.corpus.variants[0].items), true);
  assert.throws(() => {
    loaded.corpus.lanes[0].id = "mutated_lane";
  }, TypeError);
  assert.throws(() => {
    loaded.corpus.variants[0].items.push("mutated_item");
  }, TypeError);
  assert.equal(loaded.corpus.lanes[0].id, "sonnet_mcp");
  assert.deepEqual(loaded.corpus.variants[0].items, ["vase", "astrolabe", "mask"]);
});

test("preliminary order is seeded, paired, and controls are predeclared", () => {
  const schedule = createPreliminarySchedule(loadCorpus(corpusDir));
  assert.deepEqual(schedule.primary.map(({ variantId, lanes }) => [variantId, lanes]), [
    ["museum", ["sonnet_mcp", "opus_bare"]],
    ["botanical", ["opus_bare", "sonnet_mcp"]],
    ["planets", ["sonnet_mcp", "opus_bare"]],
    ["instruments", ["sonnet_mcp", "opus_bare"]],
    ["vehicles", ["sonnet_mcp", "opus_bare"]],
  ]);
  assert.deepEqual(schedule.controls.map(({ variantId, laneId }) => `${variantId}:${laneId}`), [
    "museum:sonnet_bare", "vehicles:sonnet_bare", "vehicles:opus_mcp",
    "museum:opus_mcp", "instruments:sonnet_bare", "instruments:opus_mcp",
  ]);
  assert.equal(createSignoffSchedule(loadCorpus(corpusDir)).primary.length, 10);
});

test("SHA-256 schedule streams use standard Fisher-Yates indices beyond binary pairs", () => {
  const loaded = loadCorpus(corpusDir);
  const corpus = structuredClone(loaded.corpus);
  corpus.seed = 20_260_817;
  corpus.lanes.push({ id: "probe_mcp", model: "claude-sonnet-5", treatment: "mcp", role: "primary" });
  const schedule = createPreliminarySchedule({ ...loaded, corpus });
  assert.deepEqual(schedule.primary.map(({ variantId, lanes }) => [variantId, lanes]), [
    ["vehicles", ["opus_bare", "probe_mcp", "sonnet_mcp"]],
    ["botanical", ["opus_bare", "probe_mcp", "sonnet_mcp"]],
    ["instruments", ["sonnet_mcp", "opus_bare", "probe_mcp"]],
    ["museum", ["probe_mcp", "opus_bare", "sonnet_mcp"]],
    ["planets", ["probe_mcp", "sonnet_mcp", "opus_bare"]],
  ]);
});

test("the shared prompt fixes behavior without teaching rubric APIs", () => {
  const loaded = loadCorpus(corpusDir);
  const prompt = renderPrompt(loaded, "museum");
  for (const required of ["submission/", "0.13.3", "vase", "astrolabe", "mask", "Mixed Stage", "table", "floor", "visit count"]) {
    assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  for (const leaked of ["EntityQueryCondition", "SceneUpdateContext", "Bundle", "PlaneTrackingManager", "deltaTime"]) {
    assert.equal(prompt.includes(leaked), false, leaked);
  }
  for (const lane of loaded.corpus.lanes) assert.equal(prompt.includes(lane.id), false, lane.id);
  assert.equal(prompt, renderPrompt(loaded, "museum"), "the model/tool lane never changes prompt bytes");
});
