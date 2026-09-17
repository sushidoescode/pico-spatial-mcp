# Reversal recipe — 2026-09-16 native-acceptance activation

**Superseded on 2026-09-17.** An earlier version of this file told you to run
`git reset --hard 4478238…` on `main`. **Do not do that, and it was never executed.** Moving
`main`'s branch pointer backwards discards 114 commits from that branch — they would survive only
in `cli050-native-acceptance-2026-09-16` and the reflog — and it destroys anything committed on
`main` after activation. A reversal must not cost history. The procedure below replaces it: it
preserves `main`, preserves every commit, and is itself reversible.

## What activation actually did

**No host configuration file was edited.** Every registration on this machine already points at the
absolute path `node /Users/sushantsrikrish/PICO-MCP/dist/index.js`:

| Host | Config | Server name | Env |
|---|---|---|---|
| Claude Code (account-a) | `~/.claude-account-a/.claude.json` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |
| Claude Code (account-b) | `~/.claude-account-b/.claude.json` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |
| Claude Code (default config dir) | `~/.claude.json` | `pico-spatial-mcp` | none, so: doors |
| Codex (`~/.codex`) | `~/.codex/config.toml` | `pico-spatial` and `pico-spatial-mcp` | doors / none |
| Codex (account-a) | `~/.codex-account-a/config.toml` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |
| Codex (account-b) | `~/.codex-account-b/config.toml` | `pico-spatial` | `PICO_MCP_SURFACE=doors` |

So activation was performed by advancing what that one path *contains*: a history-preserving
fast-forward of `main` from `4478238` to the continuation branch, then `npm ci && npm run build`.
Nothing about host wiring, `PATH`, the ambient global `pico-cli`, or any plugin marketplace was
touched.

Pre-activation copies of all seven host configuration files are at
`~/.pico-mcp/backups/2026-09-16-native-acceptance/`; they live outside the repository because
`.claude.json` carries unrelated per-project session state. Their pre-activation sha256 values are
in `host-config-backup-sources.sha256` beside this file.

## To reverse it: install the pre-activation server side by side, then repoint

The direction is the mirror image of activation. Activation changed the *contents* of a path and
needed no config edit; reversal keeps every path's contents intact and changes *which path* the
hosts name. One config line per host, all of them reversible, and `main` never moves.

**1. Build the pre-activation source beside main, without touching main.**

```bash
cd /Users/sushantsrikrish/PICO-MCP
git worktree add .worktrees/pre-activation-4478238 --detach 4478238a8d7aac266b12c2b8dc61c08482337286
cd .worktrees/pre-activation-4478238
npm ci
npm run build
```

`--detach` means no branch is created or moved. `main` stays exactly where it is, and every commit
stays reachable.

**2. Verify what that tree serves before pointing anything at it.**

```bash
node /Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-native-acceptance-2026-09-16/evidence/2026-09-16-mcp-native-acceptance-001/tooling/mcpcall.mjs \
  --entry /Users/sushantsrikrish/PICO-MCP/.worktrees/pre-activation-4478238/dist/index.js \
  --surface doors --list --out /tmp/pre-activation-probe.json
```

Expect `serverInfo.version` **37.0.0**. Do not skip this: `dist/index.js` is a thin entry shim and
is byte-identical across 37.0.0, 38.0.0 and 38.1.0, so hashing that file proves nothing. The
version in the handshake, and `dist/build-receipt.json`, are the identity.

**3. Repoint each registration you want reversed.** Change only the path inside `args`, from
`/Users/sushantsrikrish/PICO-MCP/dist/index.js` to
`/Users/sushantsrikrish/PICO-MCP/.worktrees/pre-activation-4478238/dist/index.js`.

For Claude Code, the supported route is the CLI rather than hand-editing `.claude.json` (run it once
per config directory, setting `CLAUDE_CONFIG_DIR` for the account you mean):

```bash
CLAUDE_CONFIG_DIR=~/.claude-account-a claude mcp remove pico-spatial -s user
CLAUDE_CONFIG_DIR=~/.claude-account-a claude mcp add pico-spatial --scope user --env PICO_MCP_SURFACE=doors \
  -- node /Users/sushantsrikrish/PICO-MCP/.worktrees/pre-activation-4478238/dist/index.js
```

For Codex, edit the one `args` line in each `config.toml`:

```toml
[mcp_servers.pico-spatial]
command = "node"
args = ["/Users/sushantsrikrish/PICO-MCP/.worktrees/pre-activation-4478238/dist/index.js"]
```

**4. Restart each host, or open a new session.** A running MCP server keeps serving the `dist/` it
loaded at startup, so neither activation nor reversal reaches a process that is already running.

## To undo the reversal

Point the same entries back at `/Users/sushantsrikrish/PICO-MCP/dist/index.js` and restart. Nothing
else has to be undone, because nothing else changed. When you no longer want the side-by-side
install:

```bash
git -C /Users/sushantsrikrish/PICO-MCP worktree remove .worktrees/pre-activation-4478238
```

## If you only want to stop using the server

Reversal is not the only option and is usually not the smallest one. To take the server out of a
host without building anything, remove or disable that host's registration
(`claude mcp remove pico-spatial -s user`, or delete the `[mcp_servers.…]` block from
`config.toml`) and restart. Re-adding it later is the same one line.

## What is preserved either way

`main`, the accepted branch `cli050-sdk61-evolution-2026-09-15` at `f349eaf`, the continuation
branch, every worktree, all three retained 38.0.0 archives, and the retained 38.1.0 distributable
under `evidence/2026-09-16-mcp-native-acceptance-001/release/`. No direction of this procedure
discards a commit or an artifact.
