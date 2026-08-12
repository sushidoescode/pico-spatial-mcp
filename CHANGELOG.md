# Changelog

Versions here key the plugin manifests (`/plugin update` uses them as its cache key).

## 36.3.0 — 2026-08-12
- **Default surface is now `doors`** (the 2026-08-12 tool vetting's #1 finding): with
  `PICO_MCP_SURFACE` unset the server registers the 17-tool intent facade instead of the
  full surface (248 tools on macOS / 245 elsewhere, ~88.5k tokens of registrations). Docs
  and every host config already said `doors`; the code now matches. **Migration:** set
  `PICO_MCP_SURFACE=full` to keep the old env-unset behavior — nothing is removed, and
  the doors' inner orchestration is unaffected (it always pinned `full` explicitly).
  Plugin installs (Claude Code, Cursor, Codex, portable) launch env-less and therefore
  now get the doors surface by default. Gated: env-unset assertions in `test:doors` and
  the tarball verifier. The flip's adversarial review found four internal self-spawns
  (fleet_build, build_hybrid_experience, ingest_marble_world, semantic splat) whose SDK
  child env never inherits the variable — each now pins `PICO_MCP_SURFACE=full`
  explicitly, and a static `test:doors` guard keeps future self-spawns pinned.
- **pico-cli 0.4.2 re-verification** (measured 2026-08-12, sandboxed npm install; see
  ANSWERED_BY_MEASUREMENT Q37): 0.4.x gates the perf family behind one-time
  `pico-cli setup` — new `not-provisioned` failure class carries that exact remedy;
  `app watch-crash` still has no duration flag (kill-bound stays required);
  `capture record` flags byte-identical; `mcp spatial-knowledge` renamed
  `dev-knowledge` (old name still works as a hidden alias); 0.4.2 `doctor` returns
  JSON in ~10s (the 0.3.0 hang is fixed upstream; the sub-second `-v` probe stays).

## 36.2.0 — 2026-08-11
- Public-launch readiness wave: canonical repo slug everywhere
  (`sushidoescode/pico-spatial-mcp`), maintainer identity (README Maintainer section,
  package.json author/repository/bugs, NOTICE), `.env.example`.
- Lazy bounded pico-cli auto-provisioning (opt-in via `PICO_MCP_AUTOINSTALL_CLI=1`,
  default OFF; doctor commands never invoked) + dedicated Windows CI lane.
- Plugin cold-start: bootstrap now runs `npm ci` only when node_modules is missing and
  `tsc` only when dist/ is missing (Claude Code pre-installs deps; first launch drops
  to a ~15 s build).
- Docs corrected against the shipped code: doors-surface calibration via
  `pico_doctor {calibrate:true}` (no surface switch), 14 preflight checks, degraded-mode
  (no SDK/emulator) statement, tarball-vs-repo link hygiene.
- CI hardening: gate-battery uniqueness fix, headless-runner fixes for the tarball
  spaced-path probe and the CMIO zero-device topology, node 20/22 matrix, npm cache,
  concurrency + timeouts.

## Earlier
- See git history (`v27` … `v36.1`): brief-to-verified-APK lanes, vision-verified trust
  ledger, world-model ingest, agent-vault SDK validation, doors surface, emulator drive.
