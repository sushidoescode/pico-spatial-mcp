# PICO CLI

`@picoxr/pico-cli` is the public command-line interface for PICO spatial development workflows. It bundles device, emulator, app, performance, MCP, and plugin-setup commands into a single Node.js package.

## What It Does

Use `pico-cli` to:

- inspect and manage connected Android or PICO devices
- set up supported AI agent hosts for PICO plugin workflows
- start and diagnose PICO MCP servers
- work with emulator and app-install flows
- capture performance diagnostics and traces

## Install

Requirements:

- Node.js 18+
- npm

Install globally:

```bash
npm install -g @picoxr/pico-cli
```

Or run without a global install:

```bash
npx @picoxr/pico-cli --help
```

## Quick Start

See the available command groups:

```bash
pico-cli --help
```

Common first steps:

```bash
# Inspect the local environment
pico-cli doctor

# Set up supported agent hosts for plugin workflows
pico-cli setup

# Check connected devices
pico-cli device:list --format json

# Inspect emulator readiness
pico-cli emulator doctor --format json
```

## Plugin and MCP Workflows

For public users, `pico-cli setup` and `pico-cli plugin update` are the recommended entrypoints for installing and refreshing plugin-backed agent workflows.

If setup, plugin visibility, skill loading, or MCP connectivity is suspect, prefer:

```bash
pico-cli doctor --format json
pico-cli plugin doctor --format json
pico-cli mcp doctor --format json
```

## Main Command Areas

- `device:*` and `adb:*`: device inspection and Android Debug Bridge operations
- `app:*`: app install, launch, and app-facing workflows
- `emulator:*`: emulator lifecycle and environment checks
- `perf:*`: performance diagnosis and tracing
- `mcp:*`: MCP server entrypoints and diagnostics
- `setup` / `plugin update` / `plugin doctor`: plugin-backed host setup and maintenance
- `doctor`: top-level environment summary

## License and Notices

- License: See `LICENSE`
- Third-party notices: `ThirdPartyNoticeText.txt`
