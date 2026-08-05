# pico-spatial-mcp — installing from the tarball

You were handed a `.tgz`. This page is the whole install path, condensed. If you'd rather have
a step-by-step walkthrough — install through to a running app you've looked at — read
**`GETTING_STARTED.md`**, which ships alongside this file. **The other docs in this project
assume you cloned the git repository — you didn't, so ignore install/testing instructions in
`README.md`.** What's in the tarball is exactly what you need to run the server.

## What this is

An MCP server that lets an AI agent build, deploy and **visually verify** PICO XR spatial apps
against the PICO OS 6 emulator — no headset required. It authors scenes, compiles them through the
real `spatialbundle`/Gradle toolchain, drives the emulator over adb, captures rendered frames, and
records claims to a trust ledger that rejects "it works" without a linked image.

## Install

```bash
mkdir pico-mcp && cd pico-mcp
npm init -y
npm install --omit=dev /path/to/pico-spatial-mcp-<version>.tgz
```

That's it. **Do not run `npm run build`** — the tarball ships prebuilt `dist/`, and there is no
TypeScript source or `tsconfig.json` in it, so `tsc` will just print its help text and exit 1.

Requires **Node ≥ 20**. Nothing is installed globally.

## Register it with your MCP client

Claude Code (`.mcp.json` in your project, or your user config):

```json
{
  "mcpServers": {
    "pico-spatial-mcp": {
      "command": "node",
      "args": ["<absolute-path>/node_modules/pico-spatial-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Any MCP client works — it speaks JSON-RPC over stdio. The `env` block is where `PICO_MCP_SURFACE`
goes if you want the narrowed surface — see below.

## Check it works

Ask your agent to run **`preflight_env`** (or **`pico_doctor`** on the narrowed surface). It is
read-only, mutates nothing, and reports what your machine is missing with an exact fix for every
non-passing check. That is the intended first call.

Expect 236+ tools on the full surface.

## Choosing a surface

Set `PICO_MCP_SURFACE` in the `env` block of the config above:

```json
"env": { "PICO_MCP_SURFACE": "doors" }
```

- unset / `full` — **236+ tools.** Everything.
- `doors` — **16 tools**: `validate_toolchain` `pico_build_app` `pico_scan_world` `pico_place`
  `pico_look` `pico_verify_app` `pico_measure` `pico_perf` `pico_sdk` `pico_doctor` `pico_ship`
  `pico_capabilities` `pico_fix` `pico_record` `pico_emulator` `pico_next`.

Start with `doors` if 236+ tools is overwhelming; it's the curated path through the same engine.

One sharp edge worth knowing up front: **`pico_measure` needs a one-time camera calibration.**
On the `doors` surface run `pico_doctor` with `{calibrate: true}` — it performs
`fleet_build(['calib'])` then `calibrate_capture_camera` through the full-surface inner server,
no client restart needed (v31). `pico_doctor` reports your calibration state either way.
Calibration also dies on an emulator cold restart, so expect to redo it after rebooting the
emulator.

## What you'll also need

The server runs on its own, but most tools drive real local software. `preflight_env` checks each of
these and names an exact fix for any that fail:

- **PICO OS 6 emulator** + the PICO SDK (this is the main one)
- **adb** on `PATH`
- **JDK** for the Gradle build lane
- **ImageMagick** for some capture analysis (a warning, not a failure — you can build without it)

The APK build lane itself works out of the box: every app is **generated from a skeleton that ships
inside this package** (no template project to obtain). `preflight_env` verifies the payload as the
`app-skeleton` check — it only fails on a truncated install, and the fix is reinstalling the package.

There is also an **optional Unity lane** (`unity_scaffold_project` + `unity_build_apk`): it needs a
local Unity editor (6000.4.9f1 + Android Build Support) and shows up in `preflight_env` as the
warn-tier `unity-lane` check. Skip it entirely if you are not building Unity apps — nothing else
depends on it. Details: [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).

One thing it does not check is **macOS**, which the native virtual-camera gates require; nothing on
your machine can be probed for that beyond the platform you're already on.

Without the emulator you can still start the server, list tools, and read documentation tools —
you just can't build or capture anything.

Everything you generate lands outside the installed package, so upgrading the tarball never discards
your work. Three different places, worth knowing before you go looking:

- the **app itself** (Gradle project, Kotlin sources, APK) → `~/AndroidStudioProjects/fleet-<id>-native`.
  This is what you open in Android Studio or sideload. Tools return it to you as `projectDir`.
- the **brief spec** (the JSON describing what you asked for) → `~/.pico-mcp/briefs/`
- **captures** taken during verification → `/tmp/pico-render/fleet/<id>/`

## Known limits, stated plainly

This project treats over-claiming as a bug, so: it is **emulator-first**. Tools will tell you when
a result is `structural` (it built and didn't crash) rather than `vision_verified` (someone looked
at a frame), and when something is headset-only or simply `blocked`. Immersive Unity VR **does**
render on the emulator (corrected v30.1) — but `adb screencap` cannot see it: screencap reads the
shell composite and is blind to XR-runtime output, so capture immersive apps with `gui_capture`.
Native-NDK and WebXR immersive status is OPEN (never re-tested through the corrected capture
path) — neither claimed nor ruled out.

## Reporting problems

Include the output of `preflight_env`, the tool name, and the full error. If a tool claimed
something you don't believe, say so — that's the most valuable bug report this project can get.
