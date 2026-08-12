# Changelog

Versions here key the plugin manifests (`/plugin update` uses them as its cache key).

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
