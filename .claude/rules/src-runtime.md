---
paths:
  - "src/**/*.ts"
---

# Runtime traps in src/

**One selection decides which SDK version is in play; the `0.13` literals that remain are labels,
not lookups.** `src/toolchainselection.ts` performs component-valid selection (packer, emulator,
adb, proto, editor) from one tools root — explicit `toolsRoot`, then a project's
`spatial.tools.dir`, then `$PICO_HOME`, then the macOS default — and every pack/launch/editor
operation resolves ONCE per call through `resolveOperationToolchain` / `prepareOperationToolchain`
in `src/toolchain.ts` (`test/toolchain-consumers.mjs` enumerates the consumers;
`install_editor_palette` joined that set in the 38.0.0 fix wave after re-signing a hardcoded 0.13
bundle from a module-scope constant). adb is one chain in `src/adb.ts`: an explicit `$PICO_ADB`
fails closed, then PATH, then the selected installation's bundled adb — never a hardcoded version
directory. What still names `0.13` in `src/` (134 matches at the fix wave; the complete list with
a disposition each is in `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md`):
`src/toolchainwatch.ts` (`check_toolchain_updates` reads the 0.13 emulator `package.xml` and the
0.13 editor `version` file — an informational reporter that selects and launches nothing; migrate
next sweep), `src/preflight.ts`'s `LEGACY_SDK_ADB` (kept as the LAST candidate of the doctor's adb
row, pinned by an S6 test), `src/vault.ts`'s default vault workspace `<tools root>/0.13/agent-vault`
(a version LABEL selecting a workspace, overridable by `$PICO_AGENT_VAULT`; every answer is
labeled with the revision its `package.xml` declares), `src/diagnose.ts:277`'s remedy text naming
the 0.13 emulator system-images root that `scripts/restart-emulator.sh` really does default to,
`'0.13'` as an example version label in tool schemas and error text, and a hundred-odd `0.13.3`
provenance references in tool descriptions and comments naming the SDK revision a fact was read
from. The escape hatches are still per-lane env vars (`PICO_ADB`, `PICO_SPATIALBUNDLE`,
`PICO_AGENT_VAULT`), not one global.

**`PICO_MCP_SURFACE` does not inherit into spawned children.** The MCP SDK spawns with a whitelist
env, so every self-spawn must pin the surface explicitly — `src/doors.ts`, `fleetbuild.ts`,
`hybridbuild.ts`, `marbleingest.ts` and `semanticsplat.ts` all repeat that dance. Write a new inner
self-client without `env: { PICO_MCP_SURFACE: "full" }` and it connects to an 18-tool server, so
every full-surface call returns "tool not found" — which reads like a registration bug, not an env
bug. `PICO_MCP_OUTER_SURFACE` exists so `preflight.ts` can still tell it is ultimately serving a
doors user; deleting it silently changes remediation text.

**The doors default is coded, not just documented.** `src/doors.ts` reads
`process.env.PICO_MCP_SURFACE ?? "doors"`, and `src/index.ts` registers the full surface only when
`!doorsSurfaceActive()`. Adding a tool to the full surface therefore does nothing for a default
session until it is also given a door.
