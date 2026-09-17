# Rollback recipe — 2026-09-16 native-acceptance activation

## What activation changed

**No host configuration file was edited.** Every registration on this machine already points at the
absolute path `node /Users/sushantsrikrish/PICO-MCP/dist/index.js`:

| Host | Config | Server name | Env |
|---|---|---|---|
| Claude Code (account-a) | `~/.claude-account-a/.claude.json` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |
| Claude Code (account-b) | `~/.claude-account-b/.claude.json` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |
| Claude Code (default config dir) | `~/.claude.json` | `pico-spatial-mcp` | none (so: doors, the default) |
| Codex (`~/.codex`) | `~/.codex/config.toml` | `pico-spatial` and `pico-spatial-mcp` | doors / none |
| Codex (account-a) | `~/.codex-account-a/config.toml` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |
| Codex (account-b) | `~/.codex-account-b/config.toml` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |

Activation was therefore done by advancing what that path *contains*: a history-preserving
fast-forward of `main` in `/Users/sushantsrikrish/PICO-MCP`, followed by `npm run build`. Nothing
about host wiring, `PATH`, the ambient global `pico-cli`, or any plugin marketplace was touched.

Copies of all seven files as they stood BEFORE activation are at
`~/.pico-mcp/backups/2026-09-16-native-acceptance/` (they are kept outside the repository because
`.claude.json` carries unrelated per-project session state). Their pre-activation sha256 values are
in `host-config-backup-sources.sha256` beside this file, so a restore can be verified.

## To roll back

```bash
cd /Users/sushantsrikrish/PICO-MCP
git reset --hard 4478238a8d7aac266b12c2b8dc61c08482337286   # the pre-activation main HEAD
npm run build                                                # republish dist/ from that source
```

Then fully restart each host (or open a new session): a running MCP server keeps serving the
`dist/` it loaded at startup, so neither activation nor rollback reaches a process that is already
running.

The continuation branch `cli050-native-acceptance-2026-09-16`, the accepted branch
`cli050-sdk61-evolution-2026-09-15`, their worktrees, and every retained archive under
`evidence/` are untouched by either direction, so rolling back loses no work.
