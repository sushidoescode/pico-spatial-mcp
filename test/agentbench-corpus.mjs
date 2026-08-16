import assert from "node:assert/strict";
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
