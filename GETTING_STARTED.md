# Getting started with pico-spatial-mcp

A step-by-step walkthrough, from a `.tgz` file to a PICO XR spatial app you have watched run in the
emulator. Assumes you already have the **PICO build SDK**, an **emulator bundle**, and a separately
created **PICO AVD**, and that you have never seen this tool before.

If you want the condensed reference instead of the walkthrough, `TESTERS.md` inside the package covers
the same ground in one page.

---

## What this actually is

It's an **MCP server**. You don't run it yourself — your AI coding agent does. Once it's registered,
your agent gains a set of tools for building PICO spatial apps: authoring a scene, compiling it through
the real `spatialbundle`/Gradle toolchain, installing it on the emulator, capturing what rendered, and
judging whether the result matches what you asked for.

The thing that makes it different from "an agent that writes Kotlin for you" is the last part. Every
claim the tools make carries an evidence class, and `vision_verified` means a real frame was captured
and looked at. A tool that only knows the app compiled will say `structural` and not pretend otherwise.
When something genuinely can't be checked, it reports `blocked` rather than guessing.

**You need an MCP-capable agent** — Claude Code, or any client that speaks MCP. The server is useless
on its own; it has no UI.

---

## Before you start

| What | Why | Check |
|---|---|---|
| **macOS** | Required for this repository's measured emulator and native host-GUI capture path | — |
| **Node ≥ 20** | Runs the server | `node --version` |
| **PICO build SDK** | Compilers and app dependencies | PICO Spatial Plugin in Android Studio |
| **PICO emulator bundle** | Emulator runtime | Spatial Editor/plugin flow, or `pico-cli emulator install --source auto --yes` |
| **PICO AVD** | Bootable virtual device | Create separately in Android Studio Device Manager |
| **adb** | Drives the emulator | Bundled with the SDK, or on your `PATH` |
| **JDK 17+** | Gradle builds the APK | Android Studio bundles one — that counts |
| **ImageMagick** | *Optional.* Some capture analysis | `brew install imagemagick` |

Don't chase these manually. Step 3 tells you exactly which ones you're missing.

The pico-cli install command above only downloads/updates the emulator bundle. It does **not**
create an AVD and does not install the JDK, Android SDK, Gradle, or PICO build SDK; keep those
Android Studio/toolchain steps separate.

The APK build lane works **out of the box**: every app is generated from a skeleton that ships inside
this package — Gradle files, wrapper, manifest, resources, PICO SDK dependencies, and a minimal stage
that renders with zero external assets. There is no template project to obtain. `preflight_env`
verifies the payload as the **`app-skeleton`** check; it only fails on a truncated install.

---

## Step 1 — Install the package

You were handed a file like `pico-spatial-mcp-<version>.tgz`. Put it anywhere, then:

```bash
mkdir pico-mcp && cd pico-mcp
npm init -y
npm install --omit=dev /path/to/pico-spatial-mcp-<version>.tgz
```

That's the whole MCP install. It puts nothing global on its own, and nothing is written outside this
directory. The optional, explicit pico-cli provisioning described in step 2 is separate.

> **Do not run `npm run build`.** The package ships a prebuilt `dist/`. There's no TypeScript source
> or `tsconfig.json` inside it, so `tsc` would just print its help text and exit non-zero. If you
> cloned the git repo instead, ignore this guide and follow `README.md` — different path entirely.

Note the absolute path to `node_modules/pico-spatial-mcp/dist/index.js`; you need it next. `pwd` will
give you the prefix.

---

## Step 2 — Register it with your agent

For **Claude Code**, add this to `.mcp.json` in your project (or your user-level MCP config):

```json
{
  "mcpServers": {
    "pico-spatial-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/pico-mcp/node_modules/pico-spatial-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Any MCP client works — it's JSON-RPC over stdio. Restart your client so it picks up the new server.

You should now see the **18-tool doors surface** — the default since v36.3 when the `env` block
sets no surface. Step 5 explains the two surfaces; set `"PICO_MCP_SURFACE": "full"` in that `env`
block for the full surface (249 tools on macOS and 246 on Linux are runtime-measured; on Windows,
the published 246-tool count is source-derived because no native Windows `tools/list`
measurement has run).

### Managed pico-cli policy

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

Package activation and utility setup are separate. Any setup is a manual, user-run setup command
using the absolute path returned by the MCP; the MCP never runs it. The MCP also never runs
`update --check`, because that command writes a local update cache; freshness comes from the
registry lookup instead.

`0.4.2` was registry latest on 2026-08-14, an observed value rather than a timeless pin. A v1.0
date supplied by the user/PICO team is planning input, not repository-verified release evidence.
The compatibility sweep is version-agnostic and covers the complete reachable advertised
help-only tree except the prohibited top-level setup subtree. It does not establish semantic
compatibility, hidden-alias longevity, perf provisioning, emulator/device/Windows behavior, or
visual evidence.

---

## Step 3 — Check your environment

Ask your agent:

> Run `pico_doctor`.

(That's the default doors-surface health check; on the full surface the same checks live in
`preflight_env`.) This is the intended first call. With `{}` it is strictly read-only — it changes
nothing on your machine. The explicit `pico_doctor {calibrate:true}` route is the mutating
calibration exception. The default call runs fourteen checks: Node, adb, the PICO SDK payload, the JDK, ImageMagick, the packaged app
skeleton, whether an emulator is actually running, the emulator's gRPC port, macOS Accessibility,
camera calibration, disk space, the Unity lane, pico-cli, and pico-cli's emulator status.

Every check that isn't passing comes back with a **specific fix**, not "check your setup". Work down
the list until the things you care about pass.

Two you can expect to see and shouldn't panic about:

- **`accessibility` — `unknown`.** macOS gives no read-only way to ask whether another process holds
  the Accessibility grant, so the tool refuses to guess. It matters because without it, free-camera
  drags are *silently dropped* — the check text tells you how to confirm it yourself.
- **`emulator` — `fail`** if you haven't booted one. Its remedy includes the verified bundle route
  `pico-cli emulator install --source auto --yes`, while stating that AVD creation and the build
  toolchain remain separate. After the bundle and AVD exist, open the PICO Spatial Editor app to
  boot it, then re-run `preflight_env`.

---

## Step 4 — Build your first app

Ask your agent:

> Use `pico_build_app` to build "a table standing on my real floor with three colored cubes
> dropping onto it from a menu".

That's a **Mixed-stage MR app** — the default: the passthrough home environment renders behind
your content, which seats on it. (A fully-virtual scene is the explicit opt-in: declare
`meta.stageStyle: "3"` in the spec you author in call two.)

This door is **deliberately two-step**, and the first response will look like a failure but isn't.

**Call one** returns `status: "needs-authoring"` and a *scaffold* — a skeleton AppSpec with the right
shape but placeholder content. The planner does this on purpose: it won't guess what you meant by
"three colored cubes" and quietly build the wrong thing.

**Call two** is your agent adapting that scaffold to your actual brief — the objects, counts, layout,
colors, menu — and calling `pico_build_app` again with `{brief, draftSpec: <the adapted scaffold>}`.

From there it runs unattended: scaffold the Gradle project, generate the Kotlin, `assembleDebug`,
install on the emulator, launch, let it settle, and capture a deterministic forward view. You'll get
back one of:

- `verified` — built, ran, and the capture was judged to match
- `built-needs-look` — it built and ran, but the judgment wasn't conclusive; go look at the capture.
  On a high-coverage Mixed-stage frame, count/not-black/dominant-color checks are advisory and add
  zero confidence. At least two distinct authored colors can score through the color-key lane at
  the default 0.8 confidence threshold; otherwise it routes to your eyes. Even a color-key PASS is
  only `auto_judged`, never a substitute for a looked-at `vision_verified` claim
- `failed` — with the actual error

A first build takes a few minutes, most of it Gradle.

---

## Step 5 — Look at it yourself

> Run `pico_look`.

It captures the emulator's forward view and returns an image path. **Read that image.** In this
project, that act is what turns a claim into `vision_verified` — not the tool saying so.

If what you see doesn't match what you asked for, say so to your agent. `pico_fix` takes a pasted
build error or a description of a wrong render and returns the matched known root cause from a corpus
of retained lessons, which is usually faster than debugging from scratch.

---

## Where your files land

Nothing is written inside the installed package, so upgrading the tarball never destroys your work.
Three locations, worth knowing before you go looking:

| What | Where |
|---|---|
| **The app** — Gradle project, Kotlin sources, APK | `~/AndroidStudioProjects/fleet-<id>-native` |
| The brief spec (JSON describing what you asked for) | `~/.pico-mcp/briefs/` |
| Captures taken during verification | `/tmp/pico-render/fleet/<id>/` |

The app directory is the one you want — open it in Android Studio, or sideload the APK. Tools hand it
back to you as `projectDir`.

---

## Choosing a surface

Since v36.3 the curated **18-tool** doors surface is the default. The full surface—249 tools on
macOS and 246 on Linux are runtime-measured; on Windows, the published 246-tool count is
source-derived because no native Windows `tools/list` measurement has run—is the power
opt-in for direct access to every lane. Switch in the
`env` block from step 2:

```json
"env": { "PICO_MCP_SURFACE": "full" }
```

(`"doors"` pins the default explicitly — useful for configs that may run pre-v36.3 checkouts,
where an unset variable served the full surface.)

The eighteen: `validate_toolchain` `ensure_pico_cli` `pico_build_app` `pico_scan_world`
`pico_place` `pico_look` `pico_verify_app` `pico_measure` `pico_perf` `pico_sdk` `pico_doctor`
`pico_ship` `pico_capabilities` `pico_fix` `pico_record` `pico_emulator` `pico_next` `pico_loop`. On this
surface `pico_doctor` replaces `preflight_env` as your health check.

**One sharp edge.** `pico_measure` needs a one-time camera calibration. On the doors surface run
`pico_doctor` with `{calibrate: true}` — it performs `fleet_build(['calib'])` then
`calibrate_capture_camera` through the full-surface inner server, no surface switch and no client
restart needed (v31). `pico_doctor` reports your calibration state either way.

Calibration also **dies on an emulator cold restart** — the camera's principal point can shift by
hundreds of pixels. Expect to redo it after rebooting the emulator, and before any measuring session.

---

## Known limits, stated plainly

This project treats over-claiming as a bug, so here's the honest boundary:

- It is **emulator-first**. Headset-only capabilities are reported as such rather than faked.
- It is **MR-first**: apps default to the Mixed stage (the passthrough room is the environment).
  Full Space (`stageStyle: "3"`) stays fully supported as an explicit opt-in, with one
  **partner-stated** caveat we report but did not measure: Full-Space immersive apps hit a known
  Guardian-boundary issue on hardware (per Matt/PICO, fix in progress).
- **Immersive Unity VR renders on the emulator** (v30.1 corrected an earlier "uniformly black"
  result — that was an `adb screencap` artifact; screencap is blind to XR-runtime output, so
  immersive apps are captured via `gui_capture`). **Native-NDK and WebXR immersive status is
  OPEN** — never re-tested through the corrected capture path; neither claimed nor ruled out.
- Tools distinguish `structural` (it built and didn't crash) from `vision_verified` (a frame was
  captured and looked at). Don't read the first as the second.
- Ask `pico_capabilities` at any time — it's generated from the trust ledger and shows every
  capability alongside the best evidence that actually exists for it.

---

## When you hit a problem

Send back (file at <https://github.com/sushidoescode/pico-spatial-mcp/issues>):

1. the full output of `preflight_env` (or `pico_doctor`),
2. the tool name and the complete error,
3. what you expected versus what happened.

And most valuable of all: **if a tool claimed something you don't believe, say so.** A tool reporting
success it didn't earn is the highest-severity bug this project has, and it's the one thing an outside
tester can catch that the author cannot.
