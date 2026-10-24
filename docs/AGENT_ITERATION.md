# Bounded semantic app iteration

Version 38.2.0 adds the opt-in `pico_interaction` MCP tool for an explicitly named
emulator and a dedicated debug fixture. It connects observation, acknowledged named
actions, independent assertions, rendered evidence, source-bound rebuilds and replay.
The official CLI retains app lifecycle authority; the existing Kotlin AgentBridge
provides semantic actions.

Add `PICO_MCP_INTERACTION=1` to the server environment, retaining your existing surface.
For example, the doors registration can use:

```json
{
  "mcpServers": {
    "pico-spatial": {
      "command": "node",
      "args": ["/absolute/PICO-MCP/dist/index.js"],
      "env": {"PICO_MCP_SURFACE": "doors", "PICO_MCP_INTERACTION": "1"}
    }
  }
}
```

Open a new host session after changing registration. Start with read-only
`pico_doctor {}` and `pico_interaction {"action":"describe"}`. Enabling the tool
does not acquire emulator ownership or authorize a native operation.

From a built source checkout, this example needs no device:

```sh
npm run build
node scripts/agent-iteration-example.mjs describe
npm run test:interaction
```

The [fixture README](../examples/agent-iteration-fixture/README.md) and
[native example](findings/AGENT_ITERATION_CANDIDATE.md#runnable-source-checkout-example)
give build, scenario, capture and rebuild/replay commands with explicit artifact and
emulator identities. A lost acknowledgement retains uncertainty and blocks resend.
A frame must be opened and judged before a visual claim; an action ACK alone is
insufficient. Immediate native frames were inconclusive during acceptance; retained
later captures showed the expected state without resending actions.

The [capability matrix](findings/AGENT_ITERATION_CANDIDATE.md#capability-matrix)
separates implementation, fixture tests, native execution and reviewed frames.
[Real host trials](findings/AGENT_ITERATION_HOST_TRIALS.md) establish restricted
Claude/Codex calls and historical-image consumption, Claude MCP cancellation and
same-process reconnect, and Codex transport interruption with fresh-session recovery.
Gemini's account/startup lane remains unverified. These are semantic app actions;
hand/controller input, sensor replay and general simulator parity are not established.
