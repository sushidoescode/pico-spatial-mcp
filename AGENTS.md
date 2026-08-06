# AGENTS.md — how ANY agent should drive pico-spatial-mcp

*(This file is host-neutral: Codex reads it natively; Claude Code, Cursor, Windsurf, Copilot,
Gemini CLI and any other MCP host get the same contract. The server is plain stdio MCP — no
host-specific behavior. Registration per host: [docs/HOSTS.md](docs/HOSTS.md).)*

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

## Session shape

1. **Start with `pico_doctor`** (doors surface) or `preflight_env` (full surface) — read-only;
   every failing check carries the exact fix command. Never debug the environment by guessing.
2. **Prefer the doors surface for your first sessions** (`PICO_MCP_SURFACE=doors`): 16
   intent-level tools instead of the full surface (241 tools on macOS; 238 on other hosts).
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
   ranking and vocabulary: [README.md](README.md#vocabulary-primer).

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
