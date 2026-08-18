import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as promptsModule from "../dist/prompts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist", "index.js");
const fixtureBrief = "a prompt conformance fixture";
const { PROMPT_CONTRACTS, registerPrompts } = promptsModule;
const advanced = [
  "autonomous_spatial_build",
  "brief_to_app",
  "autonomous_spatial_build_v6",
  "pico_spatial_dev_loop",
  "generative_spatial_build",
].sort();

async function inspectSurface(surface) {
  const env = { ...process.env };
  delete env.PICO_MCP_OUTER_SURFACE;
  if (surface === undefined) delete env.PICO_MCP_SURFACE;
  else env.PICO_MCP_SURFACE = surface;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env,
  });
  const client = new Client({ name: "prompt-conformance", version: "1" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const listed = await client.listPrompts();
    const resolved = new Map();
    for (const prompt of listed.prompts) {
      const args = prompt.name === "pico_first_light" ? { brief: fixtureBrief } : {};
      resolved.set(prompt.name, await client.getPrompt({ name: prompt.name, arguments: args }));
    }
    return { tools: tools.tools, listed: listed.prompts, resolved };
  } finally {
    await client.close();
  }
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function promptText(snapshot, name) {
  const listed = snapshot.listed.find((prompt) => prompt.name === name);
  assert.ok(listed, `missing listed prompt ${name}`);
  const resolved = snapshot.resolved.get(name);
  assert.ok(resolved, `missing resolved prompt ${name}`);
  const metadata = [
    listed.description,
    ...(listed.arguments ?? []).map((argument) => argument.description),
  ];
  const messages = resolved.messages
    .filter((message) => message.content.type === "text")
    .map((message) => message.content.text);
  return [...metadata, ...messages].filter(Boolean).join("\n");
}

function referencedTools(text, universe) {
  const codeSpans = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...universe].filter((name) => {
    if (!/[_-]/.test(name)) {
      return codeSpans.some((span) => span === name || span.startsWith(`${name}(`));
    }
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(name)}(?=$|[^A-Za-z0-9_])`);
    return pattern.test(text);
  }).sort();
}

function picoIdentifiers(text) {
  return [...new Set(text.match(/\bpico_[A-Za-z0-9_]+\b/g) ?? [])].sort();
}

function assertDeclaredPicoTools(text, declaredTools) {
  const actual = picoIdentifiers(text);
  assert.deepEqual(
    actual,
    [...declaredTools].sort(),
    `pico_* identifiers must exactly match declared tools; found ${actual.join(", ")}`,
  );
}

function assertFirstLightSafetyContract(firstLight) {
  assert.ok(
    firstLight.includes(JSON.stringify(fixtureBrief)),
    "the rendered prompt must interpolate the supplied brief",
  );
  assert.match(firstLight, /first[^\n]*\{brief\}[^\n]*needs-authoring[^\n]*scaffold[^\n]*draftSpec/i);
  assert.match(firstLight, /\{brief,draftSpec\}/i);
  assert.match(firstLight, /only when[^.\n]*auto-judged-needs-look[^.\n]*built-needs-look/i);
  for (const status of ["plan-failed", "failed", "built-not-installed", "built-no-capture", "error"]) {
    assert.match(firstLight, new RegExp(`\\b${escapeRegex(status)}\\b`));
  }
  assert.match(firstLight, /after every door call[^.\n]*inspect[^.\n]*status[^.\n]*fix[^.\n]*before advancing/i);
  assert.match(firstLight, /failure, rejection, or unexpected status[^.\n]*stop/i);
  assert.match(firstLight, /send the exact non-success response to `pico_fix`/i);
  assert.match(firstLight, /if `pico_fix` itself[^.\n]*no usable remedy[^.\n]*stop[^.\n]*report/i);
  assert.match(firstLight, /non-null[^.\n]*capture[^.\n]*receiptId[^.\n]*briefId/i);
  assert.match(firstLight, /LOOK at the exact receipt-bound `pico_build_app\.capture`/);
  assert.match(firstLight, /`pico_look`[^.\n]*diagnostic recapture/i);
  assert.match(firstLight, /new bytes[^.\n]*do not replace[^.\n]*`pico_build_app\.capture`/i);
  assert.match(firstLight, /new bytes[^\n]*must never be bound to the earlier receiptId/i);
  assert.match(firstLight, /after you actually LOOKED at the exact frame/i);
  assert.doesNotMatch(firstLight, /successful human LOOK/i);
  assert.match(firstLight, /claim[^.\n]*precise[^.\n]*bounded[^.\n]*exact[^.\n]*frame/i);
  assert.match(firstLight, /evidenceType: "vision_verified"/);
  assert.match(firstLight, /artifactPath: capture/);
  assert.match(firstLight, /concrete attestation/i);
  assert.match(firstLight, /runReceiptId: receiptId/);
  assert.match(firstLight, /never ask `pico_record`[^.\n]*producer-only[^.\n]*auto_judged/i);
  assert.match(firstLight, /black, missing, unreadable, or non-app pixels are inconclusive/i);
  assert.match(firstLight, /do not record a positive visual claim/i);
  assert.match(firstLight, /explicit deferral/i);
  assert.match(firstLight, /`pico_record\.status === "recorded"`[^.\n]*before[^.\n]*`pico_next`/i);
}

test("first-light pico identifier gate rejects an invented tool name", () => {
  const declaredTools = ["pico_doctor", "pico_build_app"];
  const mutatedFixture = "Call `pico_doctor`, `pico_build_app`, then `pico_bulid_app`.";

  assert.deepEqual(
    picoIdentifiers(mutatedFixture),
    ["pico_build_app", "pico_bulid_app", "pico_doctor"],
  );
  assert.throws(
    () => assertDeclaredPicoTools(mutatedFixture, declaredTools),
    /pico_bulid_app/,
  );
});

test("each advanced prompt registration consults its own contract entry", () => {
  for (const promptName of advanced) {
    const promptSurfaces = PROMPT_CONTRACTS[promptName].surfaces;
    const registered = [];
    promptSurfaces.push("doors");
    try {
      registerPrompts({
        registerPrompt(name) {
          registered.push(name);
        },
      }, "doors");
    } finally {
      promptSurfaces.pop();
    }

    assert.deepEqual(
      registered.sort(),
      ["pico_first_light", promptName].sort(),
      `${promptName} must be controlled by its own PROMPT_CONTRACTS entry`,
    );
  }
});

test("prompt listings and guidance conform to the active tool surface", async () => {
  const defaults = await inspectSurface(undefined);
  const doors = await inspectSurface("doors");
  const full = await inspectSurface("full");
  const names = (items) => items.map(({ name }) => name).sort();

  assert.deepEqual(names(defaults.tools), names(doors.tools));
  assert.deepEqual(names(defaults.listed), ["pico_first_light"]);
  assert.deepEqual(names(doors.listed), ["pico_first_light"]);
  assert.deepEqual(names(full.listed), ["pico_first_light", ...advanced].sort());
  assert.ok(names(doors.tools).every((name) => names(full.tools).includes(name)));

  const firstListed = doors.listed.find(({ name }) => name === "pico_first_light");
  assert.deepEqual(
    firstListed.arguments?.map(({ name, required }) => ({ name, required })),
    [{ name: "brief", required: true }],
  );

  const universe = new Set([...names(doors.tools), ...names(full.tools)]);
  for (const snapshot of [defaults, doors, full]) {
    const available = new Set(names(snapshot.tools));
    for (const prompt of snapshot.listed) {
      const refs = referencedTools(promptText(snapshot, prompt.name), universe);
      assert.deepEqual(refs.filter((name) => !available.has(name)), []);
    }
  }

  const firstLight = promptText(doors, "pico_first_light");
  assertDeclaredPicoTools(firstLight, PROMPT_CONTRACTS.pico_first_light.requiredTools);
  const firstLightRefs = referencedTools(firstLight, universe);
  assert.deepEqual(firstLightRefs, [...PROMPT_CONTRACTS.pico_first_light.requiredTools].sort());
  const orderedPositions = PROMPT_CONTRACTS.pico_first_light.requiredTools
    .map((name) => firstLight.indexOf(`\`${name}\``));
  assert.ok(orderedPositions.every((position, index) =>
    position >= 0 && (index === 0 || position > orderedPositions[index - 1])));
  assertFirstLightSafetyContract(firstLight);
  assert.match(firstLight, /com\.fleet\..*briefId/is);
  assert.match(firstLight, /LOOK/is);

  const allFullPromptText = full.listed
    .map((prompt) => promptText(full, prompt.name))
    .join("\n");
  assert.doesNotMatch(allFullPromptText, /bar for ['"]done['"] is a real capture \+ a logcat assertion/i);
  assert.doesNotMatch(allFullPromptText, /verify with a screenshot or log/i);
});
