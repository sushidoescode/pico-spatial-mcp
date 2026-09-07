@../AGENTS.md

## Claude Code

This file exists because Claude Code loads `CLAUDE.md`, never `AGENTS.md` — without the import
above, the repo's actual contract would not be in context. It lives in `.claude/` rather than the
repo root because the root `CLAUDE.md` is gitignored (it is `pico-cli`'s machine-local plugin
wiring) and therefore never reaches a teammate or a git worktree.

The root `CLAUDE.md` is written by `pico-cli` as a block-scoped upsert between its
`pico-cli:plugin-context` markers, so hand-written content outside those markers survives
`pico-cli setup` / `plugin update`. The file it imports is fully generated — edits to it are
overwritten without warning.

That imported plugin guidance is written for agents *building spatial apps with the PICO plugin*,
not for agents developing this server, and it disagrees with this repo in one important place: it
accepts a build or test result as "verified", while the rule above does not. This repo's app
skeleton builds on Spatial SDK 6.0.0. **Where they differ, this repo wins.**
