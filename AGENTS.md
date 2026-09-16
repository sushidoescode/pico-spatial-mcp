# AGENTS.md — pico-spatial-mcp

This repo **is** the MCP server: a plain stdio server that drives PICO Spatial SDK builds,
emulator work, and verification. Host-neutral — Codex, Cursor and Copilot read this file
natively; Claude Code loads it through `.claude/CLAUDE.md`. Registration snippets for every
host: [docs/HOSTS.md](docs/HOSTS.md).

Start any session with `pico_doctor {}` (read-only; every failing check names its own fix).
`pico_doctor {calibrate:true}` is the one mutating exception.

## The one rule that is not negotiable

**"Verified" means someone LOOKED at a rendered frame.** Every build/verify tool hands you a
capture path — read that image and judge it before claiming success. `record_verification`
structurally rejects a `vision_verified` entry with no linked capture, and `device_verified`
live-probes the serial and re-captures: the bytes must equal the frame you already looked at.
If your model cannot see images, use `visual_judge` (`auto_judged`, honestly weaker), report the
capture path, and escalate the look. Honest deferral is fine; a silent over-claim is not.

Evidence ranking: `structural` < `auto_judged` < `vision_verified` < `device_verified`.

## Gotchas — the expensive ones

**Tests import `dist/`, and nothing rebuilds it.** 70 of the 97 `test/*.mjs` files carry a
static or dynamic import specifier starting `../dist/`
(`grep -lE '(from|import\()[[:space:]]*"\.\./dist/' test/*.mjs | wc -l`);
`dist/` is gitignored and there is no `pretest` hook. Edit `src/`, run a test, and you get
byte-identical output because the test never saw your change. **Run `npm run build` first, every
time.** The plugin form closes the same trap by itself: `scripts/plugin-bootstrap.mjs` decides
from its build and dependency receipts — the identity of the sources and the lockfile the output
was built from, not whether `dist/index.js` happens to exist — and rebuilds a host plugin cache
whose source moved before it starts the server.

**A release is a version bump — there is no `npm publish`.** No publish step and no release
workflow exists. Hosts install from GitHub, and `/plugin update` keys off the version in the
manifests, so bumping `package.json` and running `npm run sync:meta` *is* the release. Testers
get a hand-built `.tgz`.

**`npm run smoke` is hermetic on purpose, and the real-toolchain lane is a separate command.**
Smoke builds the server's whole environment itself — an empty tools root, a fixture home, a PATH
whose first entry holds a fake `adb` that serves only `fixture-serial`, a fake Gradle, and an `npm`
that refuses every call — so it cannot select host tooling and its result is not a property of your
machine. `test:smoke-isolation` holds two specific lines, and it is worth knowing which. It runs
smoke twice — once under an empty home, once under a home stocked with tripwire SDK binaries and a
`PICO_HOME` naming them — and asserts the check lists and outcomes match, that both runs pass, that
no tripwire ran, and that the fixture log shows only `fixture-serial` and Gradle calls with no npm.
It separately asserts, against the source, that `test/smoke.mjs` contains no `process.env`,
`os.homedir()` or `AndroidStudioProjects`. A leak that changes an outcome (a host PATH, a host
home) fails the first; a leak that changes only the tools root is caught by the second, because no
retained check reads the toolchain. The tools that genuinely need an SDK live in
`node test/sdk-integration.mjs run --project … --bundle … --output …` — three absolute paths,
nothing discovered, deliberately not a gate, and its report says "no SDK evidence produced" unless
every step really ran.

**One inventory owns every gate command and its CI lane.** `scripts/gate-inventory.mjs` holds
`GATES`; each `test:*`/`smoke` script is only `node scripts/run-gate.mjs <name>`, and `run-gate`
refuses a gate whose `dist/` is stale before spawning anything — except the two `native-contract`
shell gates, which compile native sources and never load `dist/`. `run-gate` also spawns every
`fixture`/`installed-artifact` gate child with `PICO_ADB=/fixture/no/such/adb` (`FIXTURE_NO_ADB`
in the inventory), replacing whatever your shell inherited — a real adb, an empty string and
whitespace are all discarded, never passed through; the one pass-through is `PICO_GATE_FIXTURE_ADB`
naming an absolute executable fake, and anything else in that variable refuses the gate (exit 2)
before a child exists. `src/adb.ts` refuses an explicit adb that names no file — a blank `PICO_ADB`
included — and probes nothing else, so a suite that still reaches adb fails loudly instead of
touching a device. `gates.yml` keeps the same value at workflow level; it is the barrier only for
the one raw `node --test` step (run-gate replaces it for every gate child). A direct
`node --test test/<file>.mjs` gets neither, so export it yourself.
`validateGateInventory` is what `test:lint` and `test:distribution-adoption` check, and the
published counts are derived from it — so a gate that no lane runs (`test:runrevision` was exactly
that, four revision suites regressing invisibly) now fails a gate instead of a doc. Adding one is
three edits: an entry, a one-line script, a workflow step for its host lane.

**The pico-cli policy block below is byte-pinned across six files.**
`test/distribution-adoption.mjs` holds the canonical text inline and asserts an exact match in
README, GETTING_STARTED, TESTERS, SKILLS, docs/HOSTS and this file. Edit one copy and five suites
disagree with you. That test *also* rejects the block's distinctive policy vocabulary anywhere
outside the markers, so summarising or paraphrasing the policy in ordinary prose fails the gate
too — even a sentence describing the restriction can trip it. Read the pattern list in that test
before writing about the policy at all.

**Adding a doc link before the file exists breaks the docs gate.** `test/docsmeta.mjs` resolves
every relative link against the working tree. It also scans a different file set locally than in
CI, because gitignored root markdown (`CLAUDE.md`, `HANDOFF.md`, the plugin context file) exists
on your disk and not in a clean checkout.

**`PLUGINS.md` is not about the host plugins.** Despite the name it is an Android Studio /
Gradle / Spatial Editor surface recon report, unchanged since July. The host-plugin manifests are
the `.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`, `.github/plugin/` and `.agents/` trees.

**The two macOS-native suites pass by doing nothing off-macOS.** `test:vcamtransport-native` and
`test:vcamreader-native` `exit 0` printing "skipped" when `uname -s` is not Darwin — green, but
they tested nothing.

## Session shape

1. `pico_doctor {}` (doors) or `preflight_env` (full) — read-only, and every failure names its
   fix. Never debug the environment by guessing.
2. **Prefer the doors surface** (`PICO_MCP_SURFACE=doors`, the default since v36.3): 18
   intent-level tools instead of the full surface (`PICO_MCP_SURFACE=full` —
   255 tools on macOS (installed-tarball runtime-measured) versus a source-derived 252 on Linux and Windows from the three-tool host-GUI registration delta because no native Linux or Windows `tools/list` measurement has run).
   Note the doors surface does *not* expose `knowledge_api`, `vault_api` or `preflight_lint` —
   switch to full when you need them. `pico_build_app` is deliberately two-step: a brief-only
   call returns a scaffold AppSpec for YOU to author, then re-call with `{brief, draftSpec}`.
3. **On any error, feed the text to `pico_fix`** — it maps free text to verified past failures
   and returns the known fix. Door errors carry a `fix` field; follow it before improvising.
4. **Knowledge authority**: `vault_api` is authoritative for exact SDK declarations and
   file/line citations; `knowledge_api` is broad graph context. `preflight_lint` consults the
   graph only via explicit `knowledgeSecondOpinion`, and that result is advisory — it never
   changes `clean`.
5. **Emulator**: must be running before device work. From the doors surface, boot it with
   `pico_emulator {action:'boot'}`; `scripts/restart-emulator.sh` is the full-surface route.
6. **Record what you proved** with `record_verification`, using the evidence class you actually
   earned.

## Managed pico-cli policy

<!-- pico-mcp-managed-cli-policy:start -->
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

Package activation and utility setup are separate. Call `ensure_pico_cli`, then manually run its
returned absolute path with args `["setup"]` if the CLI reports an unprovisioned utility payload.
The MCP never runs setup. It also never runs `update --check`, because that command writes a local
update cache; freshness comes from the registry lookup instead.

`0.4.2` was registry latest on 2026-08-14, an observed value rather than a timeless pin. A v1.0
date supplied by the user/PICO team is planning input, not repository-verified release evidence.
The compatibility sweep is version-agnostic and covers the complete reachable advertised
help-only tree except the prohibited top-level setup subtree. It does not establish semantic
compatibility, hidden-alias longevity, perf provisioning, emulator/device/Windows behavior, or
visual evidence.
<!-- pico-mcp-managed-cli-policy:end -->

## Model-capability requirements

Vision is required for the LOOK step above; everything else is plain text/JSON tool-calling.
Full builds run for minutes — configure your host's MCP timeout to ≥10 minutes for
`pico_build_app` and `fleet_build`.
