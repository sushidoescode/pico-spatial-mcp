# Managed Latest PICO CLI Design

**Date:** 2026-08-14  
**Programme:** [PICO MCP Evolution Programme](2026-08-14-pico-evolution-programme-design.md)  
**Status:** Approved policy; ready for implementation planning after written review

## Problem

The MCP currently resolves the first `pico-cli` on ambient `PATH`. Missing-only provisioning and
updates are separate opt-ins, and both run global npm installs. With default settings, an existing
0.3.0 can remain in use indefinitely. That conflicts with the product decision that pico-spatial-mcp
should complement the current official PICO CLI and automatically benefit from its releases.

Changing the default to global `npm install -g` is not acceptable. It would overwrite user-managed
state, require host-specific permissions, race with other processes, and couple MCP reliability to
an ambient binary. Automatically running `pico-cli setup` is also out of scope: measured 0.4.2
behavior shows that setup installs optional utility payloads and mutates machine state beyond the CLI
package itself.

On 2026-08-14, a read-only registry query returned stable `latest` version `0.4.2`. The reported
September v1.0 timing is a user-supplied planning forecast, not public evidence; the design is
version-agnostic.

## Goals

- Make the default CLI policy automatically track npm's stable `latest` dist-tag.
- Install and execute an MCP-owned exact version without changing the user's global CLI or `PATH`.
- Keep MCP initialization and tool registration network-free.
- Preserve a usable last validated managed version during transient registry/install failures while
  reporting that freshness is unknown or outdated.
- Never claim `latest` without a successful bounded registry check.
- Never run `pico-cli setup` or `pico-cli update --check` automatically.
- Make version/source/freshness visible in every CLI-backed result.
- Fail affected wrappers honestly when a new CLI changes their command contract.
- Work with absolute POSIX shims and Windows `.cmd` shims.

## Non-goals

- Provisioning perf/plugin utilities through `pico-cli setup`.
- Managing a user's global npm prefix or ambient CLI.
- Automatically rolling a wrapper back to an older CLI after command drift.
- Claiming every future PICO CLI command is compatible.
- Mirroring the npm registry or independently verifying PICO's publisher identity.
- Windows emulator validation; that is owned by the separate Windows programme.

## User policy

Introduce `PICO_MCP_CLI_POLICY` with these values:

| Value | Behavior |
|---|---|
| `managed-latest` | Default. Check stable registry latest, provision exact version, and use an honest cached fallback on transient failure. |
| `managed-cached` | Never contact the registry. Use the last validated managed version or return unavailable. |
| `external` | Use only the absolute path in `PICO_MCP_CLI_PATH`; never install or update it. |
| `disabled` | Do not execute or provision pico-cli; wrappers return an explicit disabled result. |

`PICO_MCP_CLI_PATH` must be absolute and is valid only with `external`. External results carry
`source: "external"` and never claim registry freshness.

The existing `PICO_MCP_AUTOINSTALL_CLI=1` and `PICO_MCP_AUTOUPDATE_CLI=1` variables remain accepted
as deprecated aliases for `managed-latest` through all 37.x releases; removal may occur no earlier
than 38.0.0. They are no longer needed and never trigger a global installation. If either legacy
variable is `1` while an explicit `PICO_MCP_CLI_POLICY` selects another policy, configuration fails
instead of guessing. `PICO_MCP_CLI_PATH` without `external`, or `external` without an absolute
`PICO_MCP_CLI_PATH`, also fails configuration.

## Managed store

Default root: `~/.pico-mcp/cli`.

```text
~/.pico-mcp/cli/
  versions/
    0.4.2/
      node_modules/
      package.json
      install.json
  staging/
    <uuid>/
```

Each atomically published version owns an immutable `install.json` record:

```ts
type ManagedCliInstallRecord = {
  schemaVersion: 1;
  version: string;
  relativeCliPath: string;
  registryIntegrity: string | null;
  installedAt: string;
};
```

There is no shared mutable “current” pointer. An online resolution uses the exact version returned by
that check. Cached/offline resolution scans published stable-semver directories from highest to
lowest and selects the first one whose install record, package metadata, executable path, and `-v`
result all agree. A corrupt record cannot bless a binary, and an older concurrent publisher cannot
move another process back from a newer version.

## Resolution flow

Tool registration performs no provisioning and no network request. The first actual CLI-backed
operation calls `resolveManagedPicoCli()`. The default `pico_doctor {}` CLI inspection and
`preflight_env` path are not provisioning operations: they call `inspectManagedPicoCli()` to inspect
only already-published managed versions (or an explicitly configured external path), perform no
registry request or write, and report that first CLI use will provision the managed latest when no
cached version exists. The existing explicit `pico_doctor {calibrate:true}` route still performs its
separately documented capture-camera calibration work; this design does not relabel that route
read-only.

For `managed-latest`:

1. Resolve npm's stable `latest` version and registry integrity using a bounded read-only
   `npm view` request. Cache a successful result in-process for one hour. Every new MCP process
   performs its own first-use check.
2. If the exact version directory exists, validate its absolute shim with `-v` and require the
   reported semver to equal the directory version.
3. Otherwise create a unique staging directory and run a bounded non-global exact-version install
   beneath it. No command may contain `-g` or `--global`.
4. Validate the staged package metadata and absolute shim with `-v`.
5. Atomically publish the whole staging directory as `versions/<exact-version>`. Concurrent losers
   validate and reuse the winner rather than overwriting it.
6. Return the absolute versioned shim. Never mutate `PATH`.

Unique staging plus atomic version-directory publication avoids a shared install critical section.
Concurrent processes may perform redundant downloads, but partial state is never visible as a
version. A crash leaves only an unreferenced staging directory; later bounded cleanup may remove
staging entries older than seven days.

## Freshness and failure behavior

The resolver returns one of:

```ts
type PicoCliFreshness = "latest" | "outdated" | "unknown" | "cached" | "external";

type ResolvedPicoCli = {
  status: "ok";
  source: "managed" | "external";
  policy: "managed-latest" | "managed-cached" | "external";
  path: string;
  version: string;
  latestVersion: string | null;
  checkedAt: string | null;
  freshness: PicoCliFreshness;
  action: "present" | "installed" | "updated" | "cached" | "external";
  warning?: {
    failureClass: "latest-unknown" | "update-failed";
    note: string;
    outputTail?: string;
  };
};
```

Rules:

- Successful registry check plus matching validated version: `freshness: "latest"`.
- Registry unavailable plus a validated managed version: run it with `freshness: "unknown"` and a
  visible `latest-unknown` warning.
- Registry unavailable with no validated managed version: return unavailable.
- Registry reports a newer version but installation/validation fails: retain and run the previous
  validated version with `freshness: "outdated"` and an `update-failed` warning.
- `managed-cached` returns `freshness: "cached"`; it never implies a latest check.
- A staged package whose `-v` version is missing or differs is never activated.
- Corrupt version records/directories are skipped; if no published version validates, return
  unavailable.

This is resilient latest-first, not a literal continuous guarantee. Public wording is “registry
latest as of `<checkedAt>`,” never “always latest.”

## Compatibility and setup behavior

Activation establishes package identity and a working `-v`; it does not establish wrapper
compatibility. After a newly seen version is activated, run bounded, non-mutating `--help` canaries
for the command families the MCP wraps. Store their raw hashes and results as diagnostics.

A failed help canary does not silently select an older CLI. The requested latest remains active;
the affected wrapper either uses its valid path or returns `flag-or-version-drift` with the CLI's
verbatim output. A scheduled compatibility sweep enumerates the full command tree and compares any
two supplied versions, so v1.0 validation does not depend on hard-coded 0.4.2 assumptions.

If a command reports that utility payloads are absent and instructs the user to run
`pico-cli setup`, classify it as `setup-required`. Return the exact absolute managed command the
user may run manually as structured `{path, args:["setup"]}` data plus safely rendered prose. The
MCP never invokes setup, never treats it as part of package freshness, and never calls
`pico-cli update --check` because that command writes CLI cache state.

## Public tool behavior

`ensure_pico_cli` remains the single health/prewarm tool and keeps its tool name. Calling it forces
a registry refresh under `managed-latest`; its legacy `update` input remains accepted but is
deprecated because updates are now the default. The result exposes policy, source, version,
registry version, freshness, check time, action, and any fallback warning.

Every CLI wrapper obtains its absolute executable from this resolver and includes the same compact
provenance fields. Wrapper-specific results continue to distinguish missing/unusable CLI,
latest-check/update failures, setup requirements, command drift, timeouts, and runtime failures.

Preflight reports the managed policy and freshness. It must not resolve ambient `PATH` unless the
explicit external policy selects a path, and it must not contact npm or install/update a package.

## Security and durability boundaries

- npm remains the package transport and integrity verifier; record npm's registry integrity value
  when available, but do not claim independent publisher verification.
- Install output is capped and time-bounded; process-tree termination remains cross-platform.
- User-supplied CLI arguments continue to use argv execution without shell interpolation.
- Version directories are immutable after publication. Validation fails closed if their package or
  shim identity changes.
- Each `install.json` is complete and fsynced inside staging before the whole version directory is
  atomically published; the versions directory is then fsynced where supported.
- Global prefixes, ambient shims, `PATH`, and `~/.pico` setup state are not modified.

## Testing

Hermetic tests use temporary managed roots and fake npm/CLI executables. Required cases:

1. cold first use resolves and installs the exact registry version beneath the managed root;
2. stale managed version updates to exact latest and switches atomically;
3. no child argv contains `install -g`, `--global`, `setup`, or `update --check`;
4. ambient/global CLI bytes and `PATH` remain unchanged;
5. missing registry plus valid managed CLI yields `freshness: "unknown"` and a warning;
6. missing registry plus no managed CLI is unavailable;
7. known newer version plus failed install uses the old validated version as `outdated`;
8. interrupted or malformed staging state is never activated;
9. concurrent processes converge on one valid immutable version directory;
10. corrupt install record, version metadata, or shim fails closed;
11. `managed-cached`, `external`, and `disabled` policies behave exactly as declared;
12. POSIX and Windows `.cmd` absolute paths execute without shell interpolation;
13. wrapper results carry freshness provenance and preserve setup/drift classification;
14. MCP startup and `tools/list` perform no registry or install operation;
15. a full command-tree comparison script accepts arbitrary old/new versions and writes a dated,
    machine-readable report.

Native Windows execution remains owned by the separate Windows lane; this programme adds and keeps
the Windows-compatible contract but does not claim that a Windows run occurred.

## Documentation and rollout

- Replace global install/opt-in instructions in README, GETTING_STARTED, SKILLS, AGENTS, TESTERS,
  and tool descriptions with the managed policy and explicit opt-out modes.
- Keep dated observations such as “npm latest observed on 2026-08-14 was 0.4.2”; do not write
  timeless “latest is 0.4.2” claims.
- Mark the existing environment variables deprecated without immediately rejecting them.
- Add the version-agnostic compatibility sweep to CI as a non-device, no-setup job. A registry
  outage reports the canary unavailable rather than weakening product tests.
- Do not claim v1.0 compatibility until that exact package has been installed in scratch,
  enumerated, wrapper-tested, and reported. Perf behavior behind setup remains unmeasured until a
  user explicitly provisions and tests it.

## Files expected to change

Primary implementation:

- `src/picocli.ts`
- `src/picoclihealth.ts`
- `src/preflight.ts`
- `src/knowledge.ts`
- `src/perfcli.ts`
- `src/perftrace.ts`
- `src/picoclitools.ts`
- `src/doors.ts`

Tests and automation:

- `test/picocli-autoinstall.mjs`
- `test/picocli.mjs`
- `test/doors.mjs`
- `test/distribution-adoption.mjs`
- a new version-agnostic CLI sweep script and test
- `package.json`
- `.github/workflows/gates.yml`

Documentation:

- `README.md`
- `GETTING_STARTED.md`
- `SKILLS.md`
- `AGENTS.md`
- `TESTERS.md`
- `CHANGELOG.md`
