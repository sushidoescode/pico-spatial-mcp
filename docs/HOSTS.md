# Host registration — pico-spatial-mcp in any MCP client

The server is plain **stdio MCP** — one command, zero host-specific code:

```
node /abs/path/to/PICO-MCP/dist/index.js
```

Optional env: `PICO_MCP_SURFACE=doors` (the 13-tool intent facade — recommended for first
sessions; omit for the full ~214-tool surface). Build once first: `npm ci && npm run build`.
Whatever the host, point it at that command and the agent contract in [AGENTS.md](../AGENTS.md)
applies as-is.

Verification status is labeled honestly per host: **VERIFIED** = we ran it; **standard config**
= the host's documented MCP config format, not independently exercised by us — check your host
version's docs if it doesn't load.

## Claude Code — VERIFIED

As a plugin (the repo is its own marketplace; first launch auto-builds):
```bash
claude plugin marketplace add sushidoescode/PICO-MCP
claude plugin install pico-spatial-mcp@pico-mcp
```
Or as a plain server (doors surface shown):
```bash
claude mcp add pico-spatial --scope user --env PICO_MCP_SURFACE=doors -- node /abs/path/PICO-MCP/dist/index.js
```

## OpenAI Codex CLI — VERIFIED (codex-cli 0.144.6, 2026-07-22)

```bash
codex mcp add pico-spatial --env PICO_MCP_SURFACE=doors -- node /abs/path/PICO-MCP/dist/index.js
codex mcp list   # shows pico-spatial enabled
```
Or directly in `~/.codex/config.toml`:
```toml
[mcp_servers.pico-spatial]
command = "node"
args = ["/abs/path/PICO-MCP/dist/index.js"]
env = { PICO_MCP_SURFACE = "doors" }
```
Codex reads the repo's `AGENTS.md` natively — an agent working inside this repo (or a project
that references it) inherits the honesty contract automatically. Raise the MCP tool timeout for
build tools (`tool_timeout_sec` in the server table) — full builds run minutes.

## Cursor — standard config

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):
```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/abs/path/PICO-MCP/dist/index.js"], "env": { "PICO_MCP_SURFACE": "doors" } } } }
```

## Windsurf — standard config

`~/.codeium/windsurf/mcp_config.json`:
```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/abs/path/PICO-MCP/dist/index.js"], "env": { "PICO_MCP_SURFACE": "doors" } } } }
```

## VS Code (Copilot agent mode) — standard config

`.vscode/mcp.json`:
```json
{ "servers": { "pico-spatial": { "type": "stdio", "command": "node", "args": ["/abs/path/PICO-MCP/dist/index.js"], "env": { "PICO_MCP_SURFACE": "doors" } } } }
```

## Gemini CLI — standard config

`~/.gemini/settings.json`:
```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/abs/path/PICO-MCP/dist/index.js"], "env": { "PICO_MCP_SURFACE": "doors" } } } }
```

## Any other MCP host

Generic server entry:
```json
{ "command": "node", "args": ["/abs/path/PICO-MCP/dist/index.js"], "env": { "PICO_MCP_SURFACE": "doors" } }
```

## Model requirements (host-independent, honest)

- **Vision for the LOOK step**: the verification loop's strongest evidence class requires the
  agent to actually look at captured frames. Text-only models must use `visual_judge`
  (`auto_judged` — honestly weaker) and escalate the look. Everything else is plain
  JSON tool-calling.
- **Long tool timeouts**: `pico_build_app` / `fleet_build` run real Gradle builds — configure
  ≥ 10 minutes.
- macOS host requirements (emulator, adb, toolchain) are model-agnostic — `pico_doctor` reports
  them with exact fixes.
