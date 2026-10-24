# Agent iteration host configuration candidates

These are discovery-only stdio templates for a built checkout. Replace the literal `REPO_PATH` with its absolute path; the placeholder is not a host expansion variable. The templates enable the opt-in `pico_interaction` tool on the doors surface, disable CLI-backed operations with `PICO_MCP_CLI_POLICY=disabled`, and set `PICO_ADB=/fixture/no/such/adb`. The missing-file sentinel prevents fallback in the MCP's ADB resolver only. Official CLI 0.6.1 can ignore an inaccessible `ADB_PATH` and continue discovery, so a missing `ADB_PATH` is not an equivalent barrier. These profiles do not authorize or enable an emulator run.

The later [real host trials](AGENT_ITERATION_HOST_TRIALS.md) exercised a restricted adapter using these installed configuration contracts. Claude and Codex consumed the historical image; Claude also propagated cancellation and reconnected in one host process. The templates themselves still point directly at the candidate, so adapter-specific admission is not unrestricted template acceptance. Host startup has its own effects: Gemini 0.64.0 attempted an update before scratch-folder trust made local settings active. Its interactive lane remains blocked under the preservation requirement.

| Host observed on 2026-10-23 | Template | Configuration contract |
| --- | --- | --- |
| Claude Code 2.1.288 | [claude.json](../../examples/agent-iteration-fixture/host-configs/claude.json) | `mcpServers`, `type: stdio`, command/args/env; explicit `--mcp-config` with `--strict-mcp-config` |
| Codex CLI 0.163.0 | [codex.toml](../../examples/agent-iteration-fixture/host-configs/codex.toml) | `[mcp_servers.<name>]`, command/args/env and timeouts; invocation-only TOML `-c` overrides |
| Gemini CLI 0.64.0 | [gemini-settings.json](../../examples/agent-iteration-fixture/host-configs/gemini-settings.json) | Workspace `.gemini/settings.json`, `mcpServers`, stdio command/args/env, timeout in milliseconds, `trust: false` |

[Installed version/help evidence](../../evidence/2026-10-23-agent-iteration/hosts/HOST_HELP.json) records exact executable paths, hashes, arguments, exits and separate output streams. Claude and Gemini pipe help ended at 512 bytes despite exit 0. [The separate PTY observations](../../evidence/2026-10-23-agent-iteration/hosts/HOST_PTY_HELP.json) retain their complete declarations. [Source identities](../../evidence/2026-10-23-agent-iteration/hosts/SOURCE_IDENTITIES.json) bind Gemini's installed settings schema and storage implementation and Codex's native binary. That initial help-only phase performed no interactive host or model request; the later trial report records actual sessions and Codex's observed update to 0.164.0.

For a later Claude check, its normal interactive command can load only the supplied MCP configuration:

```sh
claude --strict-mcp-config --mcp-config REPO_PATH/examples/agent-iteration-fixture/host-configs/claude.json
```

Normal trust and permission decisions still apply. This is an unexecuted launch example. Claude's `--print` help explicitly says it skips the workspace trust dialog, so a headless print run would not establish the interactive trust behavior.

Codex's installed help supports `exec --ignore-user-config`, which omits the user `config.toml` but continues to use the existing authentication location. It supports TOML `-c key=value` overrides; it does not advertise an arbitrary `--config-file` flag. For a later isolated check, use an empty scratch workspace and translate the template table into invocation-only `-c` values. Project and organization policy must still be accounted for. The TOML server fields and timeouts are also documented by [OpenAI's MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Parsing the template here does not prove Codex loaded it.

The Gemini template parses as workspace `.gemini/settings.json` and retains `trust:false`. Do not launch it as a preservation-safe profile: its local settings do not constrain pre-trust startup, and the actual 0.64.0 trial attempted an automatic global update despite the workspace update-disable fields. That attempt failed; current account authentication also rejected this client. A supported login and a source-verified pre-trust startup guard remain prerequisites for another interactive trial. No installed settings were repaired or changed to make the trial run.

Local configuration or health listings do not complete host conformance. Claude's installed help says `mcp list/get` health-check approved servers. Gemini's installed implementation loads configured and extension servers, suppresses stdio in an untrusted folder, and otherwise connects and pings; that path does not discover tools or deliver images. The later real sessions retain actual model calls and wire traces separately.

For separately authorized native examples, set `PICO_ADB=/absolute/existing/adb` and `ADB_PATH=/absolute/existing/adb` as environment assignments on each scenario/replay invocation. Both values must name the same existing executable compatible with the running ADB server: the MCP reads `PICO_ADB`, while CLI 0.6.1 reads `ADB_PATH`. Set them before CLI discovery or session creation because they participate in the selection identity. This needs no global configuration change or ADB server restart; each native command still requires its explicit emulator serial.

| Evidence boundary | Result for this candidate |
| --- | --- |
| JSON/TOML template syntax | Parsed locally; exact versions/help retained |
| Generic MCP protocol, tool schema, errors and image/resource blocks | Covered by the root integration fixtures; independent of these host CLIs |
| Actual host discovery/calls through the restricted adapter | Claude and scoped-preapproved Codex passed; original direct-template admission remains distinct; Gemini blocked before tools |
| Model consumption of inline historical image | Claude and Codex transcribed it correctly; human host image-viewer display remains untested |
| Approval, trust, cancellation and reconnect | Claude per-call SDK consent, wire cancellation and same-process reconnect ran; Codex default denial, scoped preapproval and transport interruption/fresh-session recovery ran; Gemini displayed but did not accept folder trust |
| Native emulator state, rendered acceptance, hand/controller input | Not established by host configuration evidence |

The bounded conformance calls begin with `pico_doctor {}` and `pico_interaction {"action":"describe"}`. Retain actual discovery, consent and returned payload before progressing. An image block in a generic SDK fixture proves its wire shape; model transcription and human host-viewer inspection remain separate evidence.
