# AGENTS.md — how ANY agent should drive pico-spatial-mcp

*(This file is host-neutral: Codex reads it natively; Claude Code, Cursor, Windsurf, Copilot,
Gemini CLI and any other MCP host get the same contract. The server is plain stdio MCP — no
host-specific behavior. Registration per host: [docs/HOSTS.md](docs/HOSTS.md).)*

## Register first (any host)

- **Claude Code**: `claude plugin marketplace add sushidoescode/pico-spatial-mcp` then
  `claude plugin install pico-spatial-mcp@pico-mcp`.
- **Codex CLI**: clone + `npm ci && npm run build`, then
  `codex mcp add pico-spatial --env PICO_MCP_SURFACE=doors -- node /abs/path/PICO-MCP/dist/index.js`.
- **Any MCP host**: plain stdio registration — [docs/HOSTS.md](docs/HOSTS.md) has every snippet.

Start with default `pico_doctor {}` (read-only; names the exact fix for anything missing).
The explicit `pico_doctor {calibrate:true}` route is the mutating calibration exception.

## The one rule that is not negotiable

**"Verified" means someone LOOKED at a rendered frame.** Never claim a visual result from a
compile, a log line, or a tool's return value. Every build/verify tool hands you a capture
path — read that image with your vision capability and judge it before claiming success. The
trust ledger (`record_verification`) structurally rejects a `vision_verified` entry without a
linked capture. Honest deferral is always acceptable; a silent over-claim is the one
unforgivable failure.

**If your model cannot see images**: do not fake the look. Use the calibrated auto-judge
(`visual_judge` → `auto_judged` evidence — honestly weaker than `vision_verified`), report the
capture path, and escalate the look to a human or a vision-capable agent.

## Managed pico-cli policy

`managed-latest` is the default. Resolution is lazy on the first real CLI-backed operation.
Server startup, tool registration and `tools/list`, `preflight_env`, and the default
`pico_doctor {}` inspect only an existing cache: they make no npm request, provision nothing, and
write nothing to the managed store. The explicit `pico_doctor {calibrate:true}` exception is
mutating because it runs the separately documented calibration workflow.

Each exact version is published as an immutable MCP-owned cache entry. The ambient global CLI and
`PATH` remain untouched. A successful registry lookup reports registry-latest as of `checkedAt`.
If that lookup fails, a validated cached fallback is labeled `unknown`; if a known-newer install
fails, it is labeled `outdated`. Neither fallback is ever called latest.

Set `PICO_MCP_CLI_POLICY` only when the default is not appropriate:

- `managed-latest` — lazily resolve and, on first CLI use, provision the exact registry version.
- `managed-cached` — use only a validated cached version, without registry or install work.
- `external` — run only the absolute `PICO_MCP_CLI_PATH`; it is never updated by the MCP.
- `disabled` — turn off CLI-backed operations.

Through 37.x, the deprecated aliases `PICO_MCP_AUTOINSTALL_CLI=1` and
`PICO_MCP_AUTOUPDATE_CLI=1` map to `managed-latest`; they never install globally and conflict with
another explicit policy. `ensure_pico_cli` is the force-refresh health path. Its deprecated
`update` input is inert and accepted only for compatibility.

Package activation and utility setup are separate. Any setup is a manual, user-run setup command
using the absolute path returned by the MCP; the MCP never runs it. The MCP also never runs
`update --check`, because that command writes a local update cache; freshness comes from the
registry lookup instead.

`0.4.2` was registry latest on 2026-08-14, an observed value rather than a timeless pin. A v1.0
date supplied by the user/PICO team is planning input, not repository-verified release evidence.
The compatibility sweep is version-agnostic and covers the complete reachable advertised
help-only tree except the prohibited top-level setup subtree. It does not establish semantic
compatibility, hidden-alias longevity, perf provisioning, emulator/device/Windows behavior, or
visual evidence.

## Session shape

1. **Start with default `pico_doctor {}`** (doors surface) or `preflight_env` (full surface) —
   read-only; every failing check carries the exact fix command. The explicit
   `pico_doctor {calibrate:true}` route is mutating. Never debug the environment by guessing.
2. **Prefer the doors surface for your first sessions** (`PICO_MCP_SURFACE=doors`, and the
   default when the variable is unset since v36.3): 18
   intent-level tools instead of the full surface (`PICO_MCP_SURFACE=full` —
   249 tools on macOS and 246 on Linux are runtime-measured; on Windows, the published 246-tool
   count is source-derived because no native Windows `tools/list` measurement has run).
   `pico_build_app` is a TWO-STEP protocol by design —
   a brief-only call returns a scaffold AppSpec for YOU to author; re-call with
   `{brief, draftSpec}` to build.
3. **On any error, feed the text to `pico_fix`** — it maps free text to a knowledge base of
   verified past failures and returns the known fix. Door errors carry a `fix` field; follow it
   before improvising.
4. **Use the right knowledge authority**: `knowledge_api` supplies broad graph context on the full
   surface; `vault_api` is authoritative for exact SDK declarations and file/line citations.
   `preflight_lint` queries the graph only through explicit `knowledgeSecondOpinion`, and the result
   is advisory — it never changes `clean`.
5. **Emulator pre-condition**: the PICO emulator must be running (Spatial Editor app, or
   `scripts/restart-emulator.sh`). `pico_doctor` tells you if it isn't.
6. **Record what you proved**: `record_verification` with the evidence class you actually
   earned (`structural` < `auto_judged` < `vision_verified` < `device_verified`). The full
   ranking and vocabulary: [README.md](README.md#vocabulary-primer). `device_verified` is not a
   label you can assert from strings: supply the attached serial and the server live-probes its
   identity plus a same-serial screencap, whose bytes must equal the frame you already LOOKED at.

## What to read next

- [QUICKSTART.md](QUICKSTART.md) — the proven 15-minute first-light sequence.
- [SKILLS.md](SKILLS.md) — the full agent reference for the tool surface.
- [CAPABILITIES.md](CAPABILITIES.md) — what is proven, with evidence classes.
- [docs/HOSTS.md](docs/HOSTS.md) — registering this server in your host.

## Known model-capability requirements (honest)

- **Vision** for the LOOK step (see rule one). Everything else — planning, authoring AppSpecs,
  driving tools, reading logs — is plain text/JSON tool-calling any capable model can do.
- Long tool timeouts: full builds run minutes; configure your host's MCP timeout ≥ 10 minutes
  for `pico_build_app`/`fleet_build`.
