# Host registration — pico-spatial-mcp in any MCP client

The server is plain **stdio MCP** — one command, zero host-specific code:

```
node /abs/path/to/PICO-MCP/dist/index.js
```

Optional env: `PICO_MCP_SURFACE=doors` (the 17-tool intent facade — recommended for first
sessions; omit for the full surface: 248 tools on macOS, 245 on other hosts). Build once first:
`npm ci && npm run build`.
Whatever the host, point it at that command and the agent contract in [AGENTS.md](../AGENTS.md)
applies as-is.

Verification status is labeled honestly per host: **current launcher smoke** = the exact manifest
command was started as a real MCP process after the contract's required token expansion;
**historical plain-MCP verification** = the absolute registration was run before this launcher
change; **standard config** = the host's documented MCP config format, not independently exercised
by us. Check your host version's docs if it doesn't load.

## Repository plugin layouts — structurally validated

The checkout includes a standards-forward portable core plus host overlays. Root `plugin.json` and
`mcp.json` implement [Agent Plugins 1.0.0](https://agent-plugins.org/specification); the portable
server command is `node ${PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs`. Claude points its native
overlay to `.mcp.claude.json`, whose documented command is
`node ${CLAUDE_PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs`. Cursor points its overlay to
`mcp.cursor.json`, a `${CURSOR_PLUGIN_ROOT}` declaration that remains a live-test candidate rather
than a documented MCP placeholder. Keeping those configs separate prevents one host's root
semantics from leaking into another host's payload. The old root `.mcp.json` was removed so clients
cannot discover a duplicate definition beside canonical `mcp.json`.
The launcher resolves the repository
from its own `import.meta.url`, uses `npm.cmd` on Windows and `npm` elsewhere, builds only when
`node_modules` or `dist/index.js` is missing, keeps setup output off MCP stdout, and forwards the
server's exit/signal. The portable and Claude invocations are started as real MCP processes from an
unrelated working directory containing spaces and non-ASCII characters after their specified root
expansion. Cursor gets the same smoke after test-side token expansion only. These are executable
launcher checks, not post-change live installs in the host clients.

| Host | Marketplace | Payload | Status |
|---|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` | current launcher smoke; post-change live install not rerun |
| Codex | `.agents/plugins/marketplace.json` | root portable core + `.codex-plugin/plugin.json` interface | portable schema/launcher + Codex overlay validated; not live-installed here |
| Cursor | `.cursor-plugin/marketplace.json` | `.cursor-plugin/plugin.json` + `mcp.cursor.json` | declaration structurally validated; not live-installed here |
| GitHub Copilot | `.github/plugin/marketplace.json` | root portable core | portable schema/launcher validated; not live-installed here |

Claude Code documents `${CLAUDE_PLUGIN_ROOT}` as the installed plugin root and expands it before
launch. Agent Plugins requires `${PLUGIN_ROOT}` expansion for portable `mcp.json`; current Codex and
Copilot implementations support that core layout. GitHub's discovery order selects root
`plugin.json` before `.github/plugin/plugin.json`, so the shadowed nested payload was removed rather
than presented as active. Cursor's plugin-root expansion is not claimed: its separate declaration
remains structural. Use the absolute plain-server configuration below if a particular client
version does not implement the relevant plugin contract.

## Claude Code — current launcher smoke; historical plain-MCP verification

As a plugin (the repo is its own marketplace; the launcher builds when needed):
```bash
claude plugin marketplace add sushidoescode/pico-spatial-mcp
claude plugin install pico-spatial-mcp@pico-mcp
```
The current Claude-specific tokenized manifest has executable launcher coverage but has not been reinstalled live in
Claude Code. An earlier plugin revision was live-loaded. The absolute plain-server route below was
also historically verified (doors surface shown):
```bash
claude mcp add pico-spatial --scope user --env PICO_MCP_SURFACE=doors -- node /abs/path/PICO-MCP/dist/index.js
```

## OpenAI Codex CLI — historical plain-MCP verification (codex-cli 0.144.6, 2026-07-22)

This evidence applies to the absolute plain-MCP registration below, not to a post-change live install
of the `.codex-plugin` layout.

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
