# Surface-Aware Prompt Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every prompt exposed by the default doors surface executable with that surface, while preserving the existing advanced prompts on full and enforcing the boundary in hardware-free CI.

**Architecture:** `src/index.ts` passes the already-resolved surface into `registerPrompts`. `src/prompts.ts` owns an exported prompt contract map, registers a receipt-safe `pico_first_light` prompt on doors and full, and filters the five advanced prompts to full. A stdio MCP test launches default, explicit doors, and full servers and validates the public prompt/tool relationship.

**Tech Stack:** TypeScript 5.7, Node.js 20/22, `@modelcontextprotocol/sdk` 1.30, Zod 3.24, Node's built-in test runner, GitHub Actions.

## Global Constraints

- Work only in `/Users/sushantsrikrish/PICO-MCP/.worktrees/prompt-surface-conformance-2026-08-16` on branch `prompt-surface-conformance-2026-08-16`.
- Preserve the rule that `vision_verified` requires someone to inspect the exact linked rendered frame.
- The primary LOOK target is `pico_build_app.capture`; a later `pico_look` capture must never be bound to the earlier `receiptId`.
- Doors/default exposes only `pico_first_light`; full exposes it plus the five existing prompt names.
- Do not hardcode 249 full tools because Linux exposes 246; compare live sets.
- Do not change ledger, evidence, run-receipt, resume-store, door-handler, calibration, or generated-claims files.
- Tests must not require an emulator or headset.
- The baseline doors suite passes. The broader local smoke suite has one pre-existing SDK-content failure because SDK 6.0 lacks `editor/spatialbundle/usd` schemas; do not attribute that failure to this change.

---

### Task 1: Implement and enforce the surface-aware prompt contract

**Files:**
- Modify: `src/prompts.ts`
- Modify: `src/index.ts:381`
- Create: `test/prompts.mjs`
- Modify: `package.json:41`

**Interfaces:**
- Produces: `export type PromptSurface = "doors" | "full"`.
- Produces: `export const PROMPT_CONTRACTS`, mapping all six prompt names to `surfaces`; `pico_first_light` also exposes `requiredTools`.
- Changes: `registerPrompts(server: McpServer, surface: PromptSurface): void`.
- Consumes: `doorsSurfaceActive(): boolean` from `src/doors.ts`; do not modify its existing semantics.

- [ ] **Step 1: Add the red stdio conformance test and package script**

Add beside `test:doors` in `package.json`:

```json
"test:prompts": "node --test test/prompts.mjs"
```

Create `test/prompts.mjs` with the live MCP harness below:

```js
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
const { PROMPT_CONTRACTS } = promptsModule;
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
```

Add helpers that concatenate each list description, argument description, and every returned text message. Extract known tool references using identifier boundaries for names containing `_` or `-`; for ambiguous single-word tools, count only exact Markdown code spans. Do not use `body.includes(toolName)` because `vision_verified` contains `verify`:

```js
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
```

Add one test that obtains all three snapshots and begins with these public-surface assertions:

```js
const defaults = await inspectSurface(undefined);
const doors = await inspectSurface("doors");
const full = await inspectSurface("full");
const names = (items) => items.map(({ name }) => name).sort();

assert.deepEqual(names(defaults.tools), names(doors.tools));
assert.deepEqual(names(defaults.listed), ["pico_first_light"]);
assert.deepEqual(names(doors.listed), ["pico_first_light"]);
assert.deepEqual(names(full.listed), ["pico_first_light", ...advanced].sort());
assert.ok(names(doors.tools).every((name) => names(full.tools).includes(name)));
```

Assert the prompt argument and all discovered references:

```js
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
const firstLightRefs = referencedTools(firstLight, universe);
assert.deepEqual(firstLightRefs, [...PROMPT_CONTRACTS.pico_first_light.requiredTools].sort());
const orderedPositions = PROMPT_CONTRACTS.pico_first_light.requiredTools
  .map((name) => firstLight.indexOf(`\`${name}\``));
assert.ok(orderedPositions.every((position, index) =>
  position >= 0 && (index === 0 || position > orderedPositions[index - 1])));
assert.match(firstLight, /brief.*draftSpec/is);
assert.match(firstLight, /auto-judged-needs-look.*built-needs-look/is);
assert.match(firstLight, /exact.*receipt-bound.*capture/is);
assert.match(firstLight, /black.*missing.*non-app.*inconclusive/is);
assert.match(firstLight, /com\.fleet\..*briefId/is);
assert.match(firstLight, /artifactPath.*capture/is);
assert.match(firstLight, /runReceiptId.*receiptId/is);
assert.match(firstLight, /LOOK/is);
assert.match(firstLight, /do not record|never record/is);
```

Add negative assertions for the two misleading baseline phrases:

```js
assert.doesNotMatch(allFullPromptText, /bar for ['"]done['"] is a real capture \+ a logcat assertion/i);
assert.doesNotMatch(allFullPromptText, /verify with a screenshot or log/i);
```

- [ ] **Step 2: Build and run the new test to prove it fails for the intended reason**

Run:

```bash
npm run build
npm run test:prompts
```

Expected: build succeeds; the test fails because default/doors still expose five advanced prompts and `pico_first_light`/`PROMPT_CONTRACTS` do not exist. If test syntax or transport cleanup fails first, repair the harness until the assertion reaches that product defect.

- [ ] **Step 3: Add the prompt contract and doors-native prompt**

At the top of `src/prompts.ts`, import Zod and define the shared contract:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type PromptSurface = "doors" | "full";

export const PROMPT_CONTRACTS = {
  pico_first_light: {
    surfaces: ["doors", "full"],
    requiredTools: [
      "pico_doctor",
      "pico_emulator",
      "pico_build_app",
      "pico_fix",
      "pico_look",
      "pico_record",
      "pico_next",
    ],
  },
  autonomous_spatial_build: { surfaces: ["full"] },
  brief_to_app: { surfaces: ["full"] },
  autonomous_spatial_build_v6: { surfaces: ["full"] },
  pico_spatial_dev_loop: { surfaces: ["full"] },
  generative_spatial_build: { surfaces: ["full"] },
} as const;

type PromptName = keyof typeof PROMPT_CONTRACTS;
const enabled = (name: PromptName, surface: PromptSurface) =>
  (PROMPT_CONTRACTS[name].surfaces as readonly PromptSurface[]).includes(surface);
```

Change the exported signature to `registerPrompts(server: McpServer, surface: PromptSurface)`. Register `pico_first_light` when enabled with:

```ts
{
  description: "Doors-native first-light loop: doctor, two-step AppSpec authoring/build, receipt-bound LOOK, and honest recording using only intent-level tools.",
  argsSchema: {
    brief: z.string().min(1).describe("The spatial app to build."),
  },
}
```

Its callback receives `{ brief }`, renders the objective with `JSON.stringify(brief)`, and returns one user text message. The message must state every executable rule below:

- `pico_doctor` is first; every failed check/fix blocks progress.
- `pico_emulator` is used only when doctor names an emulator lifecycle action.
- `pico_build_app` is called first with `{brief}`, then with `{brief,draftSpec}` after the agent authors the returned scaffold.
- `needs-authoring` is expected on call one.
- Only `auto-judged-needs-look` and `built-needs-look`, with `capture`, `receiptId`, and `briefId`, advance to LOOK.
- `plan-failed`, `failed`, `built-not-installed`, `built-no-capture`, and `error` stop; send exact detail to `pico_fix`, apply its fix, then retry the blocked step.
- The host looks at the exact `pico_build_app.capture`; black, missing, unreadable, or non-app pixels are inconclusive.
- `pico_look` is optional diagnosis only; its new bytes cannot use the earlier receipt ID.
- A positive record uses `pico_record` with `app: "com.fleet." + briefId`, `claim`, `evidenceType:"vision_verified"`, `artifactPath:capture`, concrete `attestation`, and `runReceiptId:receiptId`.
- Never ask `pico_record` for producer-only `auto_judged`; never record positive visual evidence after an inconclusive or failed look.
- Finish with `pico_next` for the next honest step.

After first-light registration, keep advanced prompts behind the contract:

```ts
if (!enabled("autonomous_spatial_build", surface)) return;
```

- [ ] **Step 4: Pass the resolved surface from the server entry point**

Replace the unconditional call at the end of `src/index.ts`:

```ts
registerPrompts(server, doorsSurfaceActive() ? "doors" : "full");
```

Update its comment to say first-light is available on both surfaces and advanced prompts are full-only.

- [ ] **Step 5: Correct the two advanced-prompt evidence sentences**

In `src/prompts.ts`, make only these semantic corrections:

```text
The bar for 'done' is a real capture you LOOKED at plus the matching structural assertion, never a claim.
```

```text
After every build/deploy, check structural or behavioral claims with the matching log/assertion, and verify appearance only by LOOKing at the exact captured frame; neither substitutes for the other.
```

Do not otherwise rewrite or rename the advanced prompts.

- [ ] **Step 6: Build and run focused regressions**

Run:

```bash
npm run build
npm run test:prompts
npm run test:doors
```

Expected: all commands exit 0; prompt conformance passes for default, doors, and full; the existing doors suite reports zero failures.

- [ ] **Step 7: Commit the runtime contract**

```bash
git add src/prompts.ts src/index.ts test/prompts.mjs package.json
git commit -m "fix(prompts): match guidance to active surface"
```

---

### Task 2: Publish the prompt boundary and gate it in CI

**Files:**
- Modify: `.github/workflows/gates.yml`
- Modify: `README.md:274-280`
- Modify: `docs/local-models.md:53-69`

**Interfaces:**
- Consumes: `pico_first_light` and `test:prompts` from Task 1.
- Produces: public surface-specific prompt guidance and a Linux/Node 20+22 CI gate.

- [ ] **Step 1: Add the CI gate**

Immediately after `Build (tsc)` and before `Smoke`, add:

```yaml
      - name: Prompt/tool surface conformance
        run: npm run test:prompts
```

- [ ] **Step 2: Correct README prompt guidance**

Replace the surface-agnostic paragraph with concise guidance equivalent to:

```markdown
The default doors surface exposes `pico_first_light`, a short loop over intent-level tools:
doctor → two-step AppSpec authoring/build → inspect the exact receipt-bound capture → record only
what was actually seen. The full surface additionally exposes the five advanced orchestration
prompts, including `pico_spatial_dev_loop`.
```

Keep the representative low-level loops, but label them full-surface examples so they do not imply `emulator_boot`, `build_and_run`, or `record_verification` exist on doors.

- [ ] **Step 3: Correct the local-model guide**

Change its default recommendation to `pico_first_light` and replace the suggested loop with:

```markdown
1. Load `pico_first_light` with the user's brief.
2. Run `pico_doctor`; follow every fix.
3. Run the two-step `pico_build_app` protocol.
4. Inspect the exact returned build capture.
5. Use `pico_record` only for evidence actually observed, then ask `pico_next`.
```

State that `pico_spatial_dev_loop` and low-level tools require `PICO_MCP_SURFACE=full`.

- [ ] **Step 4: Verify documentation and CI wiring**

Run:

```bash
rg -n "pico_first_light|pico_spatial_dev_loop|PICO_MCP_SURFACE=full" README.md docs/local-models.md
git diff --check
npm run test:prompts
```

Expected: both guides name first-light; every workflow recommendation names its surface; diff check and prompt test pass.

- [ ] **Step 5: Commit CI and documentation**

```bash
git add .github/workflows/gates.yml README.md docs/local-models.md
git commit -m "docs(prompts): publish surface-specific workflows"
```

---

### Task 3: Final verification and conflict audit

**Files:**
- Verify only; no planned file modifications.

**Interfaces:**
- Consumes: both implementation commits.
- Produces: review evidence and a bounded handoff; no merge or cherry-pick is authorized by this plan.

- [ ] **Step 1: Confirm branch scope**

Run:

```bash
git status --short --branch
git diff --name-only acdbebb..HEAD
```

Expected implementation paths, in addition to the approved design and plan, are:

```text
.github/workflows/gates.yml
README.md
docs/local-models.md
package.json
src/index.ts
src/prompts.ts
test/prompts.mjs
```

- [ ] **Step 2: Run the deterministic verification set**

Run:

```bash
npm run build
npm run test:prompts
npm run test:doors
npm run test:docsmeta
```

Expected: all exit 0. Do not claim broad smoke is green unless its pre-existing local SDK schema failure is separately resolved.

- [ ] **Step 3: Inspect the public MCP contract directly**

Use the conformance output or a short read-only SDK probe to confirm:

```text
unset: pico_first_light
doors: pico_first_light
full:  pico_first_light + five advanced prompts
```

Retrieve `pico_first_light` with a fixture brief and read the rendered text. This is text/API verification, not visual-app verification; no capture claim is involved.

- [ ] **Step 4: Request independent code and spec-conformance reviews**

Dispatch one reviewer for implementation correctness and one for spec compliance. Resolve every high/medium finding, rerun the focused suite, and commit fixes as narrowly named follow-ups.

- [ ] **Step 5: Recheck active branches before handoff**

Run:

```bash
git worktree list --porcelain
git log --oneline --decorate -5 --all --simplify-by-decoration
git diff --name-only pico-evolution-2026-08-14...HEAD
```

Report newly introduced overlap. Do not merge, cherry-pick, rebase, or alter another worktree without separate authorization.
