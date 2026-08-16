# Surface-Aware Prompt Registration Design

**Status:** Approved for implementation
**Date:** 2026-08-16  
**Base:** `pico-evolution-2026-08-14` at `acdbebb`

## Problem

The default MCP surface is `doors`, which exposes 18 intent-level tools. The server nevertheless registers five advanced prompts written for the 249-tool `full` surface. A doors client can discover those prompts, but following any of them immediately produces unknown-tool failures: the prompts direct the host to tools such as `scaffold_spatial_app`, `plan_app_spec`, and `compile_app_spec` that are intentionally absent from doors.

This is a contract defect, not missing documentation. Prompt discovery is part of the live MCP interface, so every prompt offered on a surface must be executable using tools on that surface. Prompt text must also preserve the repository's governing evidence rule: a compile, log, automated judgment, or returned capture path is never equivalent to someone looking at the rendered frame.

## Goals

1. Give doors users one short, executable first-light prompt that uses only tools available on doors.
2. Keep every existing advanced prompt available on the full surface without renaming it.
3. Make prompt-to-tool conformance an automated, hardware-free regression gate.
4. Correct the two user guides that currently send default-surface users to a full-only prompt.
5. Keep the change isolated from the active ledger, run-receipt, workflow-resume, and typed-door work.

## Non-Goals

- Redesigning the 18 doors or adding typed door output schemas.
- Changing capture routing or adding a host-GUI capture option to doors.
- Registering documentation as MCP resources.
- Rewriting or shortening the five existing full-surface prompts.
- Implementing the separate calibration-quality gate.
- Changing trust-ledger evidence semantics.
- Changing how invalid `PICO_MCP_SURFACE` values are interpreted. The existing parser treats anything other than exact `doors` as full; fail-closed surface parsing is a separate door-contract fix because it changes the tool surface as well as prompts.

## Approaches Considered

### 1. Surface-filtered registry with a doors-native prompt — selected

Pass the active surface into prompt registration. Register a new `pico_first_light` prompt on both surfaces because the full surface also includes the doors. Register the five existing advanced prompts only on full.

This is the smallest truthful contract. It removes unusable choices from doors, preserves full-surface compatibility, and confines behavior changes to prompt registration.

### 2. Maintain doors and full variants under every existing prompt name

This preserves the same prompt names across surfaces, but it creates ten long instruction bodies whose behavior can drift independently. It also suggests functional equivalence where the surfaces intentionally expose very different levels of control.

### 3. Keep all prompts visible and add a surface warning

This minimizes code changes but retains a discoverable workflow that cannot run. Requiring the host to restart or reconfigure the server after selecting a prompt is not conformance.

## Runtime Design

### Registration boundary

`registerPrompts` will take the active surface explicitly:

```ts
type PromptSurface = "doors" | "full";
registerPrompts(server, surface);
```

`src/index.ts` already owns surface selection, so it will pass `doorsSurfaceActive() ? "doors" : "full"`. Prompt registration will not read environment variables itself.

Export a small prompt contract map containing each prompt's allowed surfaces. `registerPrompts` will consult that map rather than duplicating the filtering rule in tests. The `pico_first_light` entry will additionally declare its exact tool references as machine-readable metadata:

```ts
requiredTools: [
  "pico_doctor",
  "pico_emulator",
  "pico_build_app",
  "pico_fix",
  "pico_look",
  "pico_record",
  "pico_next",
]
```

The conformance test will compare those declarations with the live doors surface and with the rendered prompt text.

Registration behavior:

| Prompt | doors | full |
| --- | --- | --- |
| `pico_first_light` | yes | yes |
| `autonomous_spatial_build` | no | yes |
| `brief_to_app` | no | yes |
| `autonomous_spatial_build_v6` | no | yes |
| `pico_spatial_dev_loop` | no | yes |
| `generative_spatial_build` | no | yes |

The existing advanced prompt names and workflows remain unchanged. Their registrations execute only when `surface === "full"`. Two narrow evidence-wording defects will be corrected while this file is open: “capture + logcat” becomes “a capture you LOOKED at + the matching structural assertion,” and “verify with a screenshot or log” is replaced with language that keeps visual and structural evidence distinct. No other advanced-prompt rewrite is in scope.

### `pico_first_light` contract

`pico_first_light` will require one prompt argument, `brief: string`. The returned user message will include that brief verbatim as the build objective; it will not rely on ambient conversation state.

The doors-native prompt will teach this bounded loop:

1. Run `pico_doctor` first and follow its exact fix instructions.
2. Use `pico_emulator` only when the doctor directs an emulator lifecycle action.
3. Call `pico_build_app` with the brief alone to obtain an AppSpec scaffold; author the draft; call it again with `draftSpec` to build.
4. On a tool error, give the returned text to `pico_fix`, apply the mapped fix, and retry the originating step.
5. Continue to the LOOK only when the second build returns `auto-judged-needs-look` or `built-needs-look` with non-null `capture`, `receiptId`, and `briefId`.
6. Inspect the exact immutable `pico_build_app.capture` with the host's vision capability. Treat black, missing, non-app, or unreadable pixels as inconclusive. `pico_look` is an optional diagnostic recapture, but its different bytes do not replace the receipt-bound build capture and must not be submitted with the earlier `receiptId`.
7. Only after actually seeing the receipt-bound frame, call `pico_record` with `app: "com.fleet." + briefId`, a precise `claim`, `evidenceType: "vision_verified"`, `artifactPath: capture`, a concrete `attestation`, and `runReceiptId: receiptId`. Never ask `pico_record` to create the producer-only `auto_judged` tier.
8. If the frame is inconclusive or visually wrong, do not record a positive visual claim; report the look obligation or defect and use `pico_next` for the next honest action or a bounded alternative.

The prompt will not name any full-only tool. It will not claim that adb capture is universal, and it will not instruct a non-vision host to pretend it looked. If the capture is unobservable, the prompt directs an honest deferral.

### Error handling

Registration has no runtime fallback. A prompt is either valid for the selected surface and registered, or it is absent. This avoids presenting an instruction that fails after selection.

Door failures are normally success-shaped MCP responses with a non-success `status`, not protocol errors. At every step the prompt will inspect `status` and `fix`. For `pico_build_app`, `needs-authoring` is the expected first-call state; `auto-judged-needs-look` and `built-needs-look` are the only states that may advance to LOOK, and only with complete receipt fields. `plan-failed`, `failed`, `built-not-installed`, `built-no-capture`, and `error` must stop the workflow. The agent passes their exact detail to `pico_fix`, follows the returned remedy, and retries only after satisfying the prerequisite.

The workflow never converts a non-success status or an inconclusive LOOK into a success claim.

## Conformance Test Design

Add `test/prompts.mjs`, built on the MCP SDK client and stdio transport, with no emulator or headset dependency.

The test will launch three server configurations:

- `PICO_MCP_SURFACE` unset, proving the default behaves as doors.
- `PICO_MCP_SURFACE=doors`.
- `PICO_MCP_SURFACE=full`.

Use `process.execPath`, an absolute `dist/index.js` path, and `try/finally` client cleanup. For the unset case, remove both `PICO_MCP_SURFACE` and `PICO_MCP_OUTER_SURFACE` from the child environment. Protocol failures must fail the test; do not replace a failed prompt request with an empty result.

For each configuration it will call `tools/list`, `prompts/list`, and `prompts/get`. SDK `getPrompt` requests for the five existing empty-schema prompts must include `arguments: {}`; omitting it correctly fails schema validation with MCP error `-32602` and would test the client call incorrectly rather than the prompt contract. The first-light request supplies `{brief: "prompt conformance fixture"}`. Sort names before comparison because protocol ordering is not contractual.

Assertions:

1. Default and explicit doors expose identical tool sets and only `pico_first_light`; do not hardcode the platform-dependent full-surface tool count.
2. Full contains the complete doors tool set and exposes `pico_first_light` plus the five existing prompt names.
3. The registered first-light description, argument schema, and returned text agree with its source contract metadata.
4. Every declared first-light tool reference exists on both doors and full.
5. Build the union of actual tool names returned by both surfaces. Scan prompt-list descriptions, argument descriptions, and every returned text message. Find identifier-boundary occurrences of multiword tool names and Markdown-code-span occurrences of single-word tool names, then assert every referenced tool is present on that prompt's active surface. This prevents ordinary prose and values such as `vision_verified` from becoming false references to single-word tools such as `verify` or `diagnose`.
6. Doors prompt text contains no known full-only tool reference.
7. Full prompts remain retrievable, preserving their existing public names.
8. The two corrected advanced-prompt evidence sentences cannot regress to treating an uninspected screenshot or a log as visual proof.
9. Focused first-light assertions cover the ordered door references, the `brief`/`draftSpec` two-step protocol, success and stop statuses, exact-error repair, receipt-bound capture, inconclusive visual states, host LOOK, caller-recordable evidence, and honest deferral.

The union-based scan avoids maintaining a second 249-tool allowlist while catching the cross-surface defect class that exposed full-only tools on doors. It does not detect a misspelled or removed tool name that exists on neither live surface; the machine-readable first-light declaration closes that gap for the default workflow, while generalized unknown-name linting remains outside this slice. The explicit first-light assertions prevent a vacuous prompt from passing merely because it references no tools.

Add `"test:prompts": "node --test test/prompts.mjs"` and a dedicated CI gate step immediately after `npm run build` and before smoke.

## Documentation

Update the prompt guidance in `README.md` and `docs/local-models.md`:

- Doors/default users load `pico_first_light` and follow the intent-level workflow.
- Full-surface users may load `pico_spatial_dev_loop` or the other advanced prompts.
- Examples must not imply that full-only tools are callable from the default surface.

This is required compatibility documentation for the live interface change, not a general documentation refresh.

## File Scope

Expected implementation files:

- `src/prompts.ts`
- `src/index.ts`
- `test/prompts.mjs` (new)
- `package.json`
- `.github/workflows/gates.yml`
- `README.md`
- `docs/local-models.md`

No ledger, evidence, run-receipt, resume-store, door-handler, calibration, or generated claims files will be changed.

## Compatibility and Rollout

Full-surface users retain every existing prompt and gain the shorter first-light prompt. Doors users lose five entries that were discoverable but not executable and gain one executable entry. No tool name, tool schema, existing prompt argument, or evidence class changes.

The work is based on the clean `pico-evolution-2026-08-14` tip in its own worktree. It will be delivered as a focused commit series that can be reviewed or cherry-picked independently. Before landing, rebase or replay onto the then-current integration tip and rerun both prompt conformance and doors tests.

## Acceptance Criteria

- Default doors clients can retrieve and follow `pico_first_light` without encountering an unknown tool.
- No prompt returned on doors references a tool absent from doors.
- All five existing advanced prompts remain present on full.
- The first-light prompt accepts a brief, handles non-success door statuses, inspects the exact receipt-bound capture, and states the honest inconclusive path.
- Its recording path supplies the canonical fleet app key, receipt ID, exact capture, claim, attestation, and only a caller-recordable evidence tier.
- The two misleading advanced-prompt evidence sentences are corrected without changing their workflow or public names.
- README and the local-model guide direct each surface to a prompt it actually exposes.
- Build, prompt conformance, and doors tests pass without emulator or headset access.
- The implementation does not touch files owned by the active ledger/resume work.
