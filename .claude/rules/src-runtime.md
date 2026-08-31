---
paths:
  - "src/**/*.ts"
---

# Runtime traps in src/

**Two mechanisms disagree about which SDK version is in play.** `src/toolchain.ts` `pickVersion()`
resolves the *newest* version directory under `~/Library/PICO/sdk`, while the literal `0.13` path
segment is hardcoded at roughly 32 sites — including `verifyapk`, `perfprobe`, `hybridbuild`,
`fleetbuild`, `editorexport`, `editorpalette`, `toolchainwatch`, the agent vault in `vault.ts`, and
`preflight.ts`'s `PICO_HOME + "/0.13"`. With SDK 6.0 installed, half the tools follow the newest
tree while adb, spatialbundle export, the editor palette, the watcher and the vault keep looking in
a 0.13 tree that may not exist. The symptom is incoherent rather than broken: `preflight_env`
reports "no PICO SDK payload" while `validate_toolchain` reports a healthy toolchain. The escape
hatches are per-lane env vars (`PICO_ADB`, `PICO_SPATIALBUNDLE`, `PICO_AGENT_VAULT`), not one
global.

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
