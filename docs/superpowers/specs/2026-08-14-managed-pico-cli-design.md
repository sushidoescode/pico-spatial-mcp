# Managed Latest PICO CLI Design

**Date:** 2026-08-14  
**Programme:** [PICO MCP Evolution Programme](2026-08-14-pico-evolution-programme-design.md)  
**Status:** Implemented policy; this document records the production schema-2 store contract

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
    .0.4.2.publish
    0.4.2/
      node_modules/
      staging-owner.json
      compatibility.json
      install.json
      publication.json
  staging/
    <uuid>/
      staging-owner.json
    .cleanup-<pid>-<uuid>/
```

The sibling `.0.4.2.publish` claim and `0.4.2/publication.json` are two directory entries for the
same hard-linked inode and exact bytes. `install.json` is a separate record. Both schema-2 records
bind the same deterministic content identity:

```ts
type ManagedContentBinding = {
  contentManifestSchemaVersion: 1;
  contentManifestSha256: string;
  contentManifestEntryCount: number;
  contentManifestTotalBytes: number;
};

type ManagedCliInstallRecord = {
  schemaVersion: 2;
  version: string;
  relativeCliPath: string;
  registryIntegrity: string | null;
  installedAt: string;
} & ManagedContentBinding;

type ManagedPublicationRecord = {
  schemaVersion: 2;
  kind: "pico-managed-publication";
  version: string;
  registryIntegrity: string | null;
  token: string;
  ownerPid: number;
  createdAt: string;
} & ManagedContentBinding;
```

The manifest hashes the sorted version-root tree, including directory/file/symlink type, relative
path, mode, link count where applicable, regular-file size and SHA-256, and raw UTF-8 symlink target.
Every real path and symlink target must remain inside the real version root. Its entry count and
total retained bytes are bound alongside the hash. Exactly the root `install.json` and
`publication.json` control records are excluded to avoid a circular digest; `staging-owner.json`,
`compatibility.json`, the package, dependencies and canonical shim are included. Traversal is
fail-closed and bounded to 100,000 entries, depth 128, 64 MiB of retained relative-path bytes,
256 MiB per regular file and 1 GiB total regular-file plus symlink-target bytes.

There is no shared mutable “current” pointer. An online resolution uses the exact version returned
by that check. Cached/offline resolution scans published stable-semver directories from highest to
lowest. Selection requires a complete schema-2 install record, matching install/publication content
bindings, the required claim/publication hard-link identity and bytes, a fresh full-tree hash,
canonical package/shim/version agreement, and a successful bounded `-v` probe. Schema-1 or
incomplete records are deliberately not migrated or trusted in place.

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
2. If the exact version directory exists, run the complete schema-2 publication/content validation
   above. Never overwrite an invalid immutable target.
3. Otherwise create a unique staging directory and fsynced owner record, then run this bounded,
   non-global, lifecycle-script-disabled exact install beneath it:

   ```text
   npm install --prefix <staging> --no-save --package-lock=false --ignore-scripts \
     --fund=false --audit=false @picoxr/pico-cli@<exact-version>
   ```

4. Validate containment and executable identity, run the bounded `-v` probe and help-only canaries,
   write `compatibility.json`, compute the final content identity, then write and fsync schema-2
   `install.json`.
5. Exclusively create `versions/.<exact-version>.publish`, atomically rename the complete staging
   tree to `versions/<exact-version>`, validate that unfinalized tree, then hard-link the claim to
   `<version>/publication.json`. Fsync directories where supported and validate the finalized
   claim, hard link, records, content and probes again. A concurrent process never replaces a
   target; it may use a winner only after the same validation succeeds.
6. Return the absolute versioned shim. Never mutate `PATH`.

Unique staging plus atomic version-directory publication avoids a shared install critical section.
Concurrent processes may perform redundant downloads, but an incomplete tree never validates as a
published version. A crash can leave staging, a publication claim, or a renamed-but-unfinalized
target. Cleanup handles only a staging directory with a valid owner record older than seven days
whose PID is definitely dead: it identity-checks and renames that directory to an owned cleanup
quarantine, but does not recursively delete it. Invalid published targets and claims fail closed
with their exact two paths and require manual removal only after the operator confirms that no
managed resolver process is active.

### Validation at execution boundaries

Before a managed `-v` probe or staged help canary, the resolver captures a bounded identity for the
canonical shim and its contained real target: type, mode, link count, size, raw symlink target,
real relative path and SHA-256. A synchronous pre-spawn callback must reproduce that identity within
the command deadline or process creation is refused. A corresponding post-spawn callback detects a
change, terminates the process and reports the failure. The complete content tree is recomputed
after the probe, and finalized published state is checked before and after cached validation.

These checks make accidental or uncoordinated store drift evident; they do not create a privileged
trust boundary. The store and both records are writable by the same user, so a same-user actor can
rewrite bytes and their bindings. Cross-platform Node launch cannot execute an already validated
file descriptor, leaving a small check-to-launch race between validation and the resolver probe,
and another between resolution and a later wrapper command. Post-spawn checking is detection and
termination, not proof that the child had no immediate side effect. A synchronous filesystem call
cannot be preempted by JavaScript even though its callback checks the deadline. Native Windows
hard-link, shim and process behavior remains fixture-only until a native Windows host runs it.

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
- Package installation always uses `--ignore-scripts`; package lifecycle scripts are not executed.
- Install output is capped and time-bounded. The runner contains POSIX process-group and Windows
  `taskkill` paths, but the Windows path has only fixture coverage here, not a native-host run.
- User-supplied CLI arguments continue to use argv execution without shell interpolation.
- Published version directories are treated as immutable. Fresh schema-2 record, publication-link,
  content-tree and executable checks fail closed on drift; this is tamper evidence, not protection
  against a same-user adversary.
- `install.json` is complete and fsynced in staging before atomic rename. The exclusive publication
  claim is fsynced before rename; its in-version hard link and affected directories are fsynced
  where supported before final validation.
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
10. schema-1/incomplete records, corrupt install/publication records, broken claim hard links,
    manifest/package/dependency/shim drift and out-of-root symlinks fail closed with exact manual
    recovery paths;
11. `managed-cached`, `external`, and `disabled` policies behave exactly as declared;
12. POSIX absolute-path execution works; Windows `.cmd` absolute-path behavior retains hermetic
    fixture coverage without a native-Windows execution claim;
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
