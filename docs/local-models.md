# Using pico-spatial-mcp with a local open-weight model

**Short answer: yes.** MCP is a transport-agnostic protocol, not a Claude feature — any
MCP-capable client can drive this server, including one backed by a local open-weight
model running on your Mac. This server speaks stdio MCP and has no cloud dependency of
its own (it shells out to your locally installed PICO toolchain + adb), so it runs fully
offline.

## Will it run well on an M5 Pro / 64 GB with a ~30B model?

Comfortably, on the hardware side. A 30B model quantized to 4-bit is ~18–20 GB of
weights; 64 GB of unified memory leaves ample room for context + the OS. The real
question is **tool-calling quality**, and that's where model choice matters:

- The community rule of thumb (2026): **≥14B for single-tool tasks, ≥32B for reliable
  multi-step tool use.** A capable ~30B model is right at the sweet spot for an
  agentic build loop.
- Open-weight tool-calling has improved sharply — recent Gemma and Qwen 3.x releases
  post strong tool-calling accuracy — but local models still trail Claude/GPT/Gemini on
  long multi-step chains. Expect to babysit a bit more: clearer prompts, occasional
  retries, smaller steps.

This server is deliberately built to make a local model's job easier (see below).

The default doors surface recommends the `pico_first_light` prompt. The `pico_spatial_dev_loop`
prompt and low-level tools require `PICO_MCP_SURFACE=full`.

## Clients that can connect a local model to this server

| Client | MCP support | Notes |
|---|---|---|
| **LM Studio** | Built-in MCP + tool calling | Easiest GUI path; OpenAI-compatible local server; add this MCP in its config. |
| **llama.cpp** (`llama-server`) | Full MCP client in its web UI (since 2026) | Server mgmt, agentic tool-call loop, MCP prompts + resources. |
| **Jan / Continue / other MCP clients** | Varies | Any client implementing the MCP client spec works. |
| **Ollama** | No built-in MCP yet | Use a bridge: `MCPHost`, `ollama-mcp-bridge`, or `mcp-client-for-ollama` (a TUI client). |

Register the server the same way as for Claude Code — point the client at:

```
command: node   args: ["/path/to/PICO-MCP/dist/index.js"]
```

## Why this server is local-model-friendly (by design)

A weaker model fails most often by getting lost in long tool chains. The MCP minimizes
that:

- **The doors prompt collapses the first-light workflow into intent-level calls** —
  `pico_first_light` guides `pico_doctor`, two-step `pico_build_app`, receipt-bound LOOK, and
  honest recording. Fewer reasoning hops = far more reliable for a 30B model.
- **On the full surface, high-level orchestration tools collapse many steps into one call** —
  `build_and_run` (build→install→launch→verify-rendered→screenshot), `iterate_scene`
  (pack→inspect→preview→shot), `compose_inspection_scene`, and especially
  `scaffold_spatial_app` (a whole buildable app in one call).
- **`validate_toolchain` front-loads environment problems** with explicit, fixable
  messages (missing JDK, no AVD, license not accepted) so the model isn't debugging
  blind.
- **On the full surface, self-documenting tools + a built-in prompt.** Load the
  `pico_spatial_dev_loop` prompt to give the model the whole workflow; tool descriptions state
  inputs, gotchas, and the next step to call.
- **Errors tell the model what to do** (e.g. gui_capture → "grant Screen Recording";
  gradle → JAVA_HOME auto-detected; build failures return the Gradle tail).
- **On the full surface, verification is built in**, so the model gets ground-truth feedback
  (`verify_scene` geometry counts, `rendered: true/false`, crash detection) instead of guessing.

## Suggested local-model loop (default doors surface)

1. Load `pico_first_light` with the user's brief.
2. Run `pico_doctor`; follow every fix.
3. Run the two-step `pico_build_app` protocol.
4. Inspect the exact returned build capture.
5. Use `pico_record` only for evidence actually observed, then ask `pico_next`.

For the `pico_spatial_dev_loop` prompt and low-level tools, set `PICO_MCP_SURFACE=full`.

Keep each turn to one tool call and let the structured results guide the next step. The
orchestration tools mean a competent ~30B model can complete the build loop end-to-end.
