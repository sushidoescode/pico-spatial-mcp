# Task 6 implementer report — managed CLI public policy and distribution gates

Date: 2026-08-14

## Revision and scope

- Requested and verified base: `d7a8d3e2e37d8b62c9ad3564ed8aac205648b5d8`.
- Result head: the Task 6 commit containing this report (`git rev-parse HEAD` is reported in the
  parent handoff because a commit cannot embed its own content-addressed hash).
- Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/pico-evolution-2026-08-14`.
- Scope is the Task 6 operational docs, dated 0.4.2 finding/answer, distribution test, the
  scout-authorized claim-only comments in `src/picocli.ts` and `src/preflight.ts`, package and lock
  metadata, every tracked plugin/marketplace version manifest, and this report.
- No push, remote, visibility, permission, global CLI/PATH, emulator/device, Swan, native Windows,
  or visual operation was performed.

## TDD evidence

The distribution and documentation policy tests were written before source, prose, or metadata
changes. The behavior tests name observable regressions: ambient CLI selection, startup/doctor
provisioning, managed-home writes, PATH mutation, missing provenance/freshness, wrong install argv,
and setup/update-check execution. The documentation gate extracts only a heading-scoped managed CLI
section from six current operational documents and validates the supported policy/env vocabulary
plus operational boundaries; it does not sweep unrelated settings or dated Windows evidence.

The first guarded RED run was:

```text
npm run build
npm run test:distribution-adoption
```

Build passed. Distribution exited 1 with 34/36 passing. One intended failure was the absent
`Managed pico-cli policy` heading. The second failure was a test-shape mistake: the new installed
doctor probe expected a top-level status, while `pico_doctor` correctly returns a composite object
whose check status lives under `preflight`. The observed payload already showed the desired
read-only warning and no managed provisioning. The assertion was corrected to validate the real
`preflight.checks` boundary.

The repeated guarded RED then exited 1 with 35/36 passing and one failure only: the old operational
docs lacked the heading-scoped managed policy. Both installed/tarball behavior tests were already
green against the Task 5 production base, proving they exercise existing managed behavior while the
documentation policy test catches the Task 6 change.

During the subsequent focused policy GREEN, three assertions encoded an unnecessarily strict word
order (`global`/`PATH`, fallback `never`, and help-only/version-agnostic ordering). Each was relaxed
to accept equivalent prose while retaining the semantic boundary. No production or factual
requirement was weakened. The focused policy case then passed 1/1.

## Installed/tarball behavior gate

The test creates the package with `npm pack --ignore-scripts`, extracts the resulting tarball under
a temporary `node_modules/pico-spatial-mcp`, and links only already-installed runtime dependencies.
It never invokes `npm install` and does not require network access. All package bytes exercised by
the server and wrapper come from the tarball.

The installed server starts in a fresh child with temporary `HOME`/`USERPROFILE`, fake-only npm/CLI
commands, and no CLI policy override. Startup and `tools/list` return the default 18-tool doors
surface with zero fake-npm calls and no managed root. Default `pico_doctor {}` round-trips through
the doors inner server, still makes zero npm/managed-CLI calls, leaves the managed root absent, and
does not change the isolated home directory.

A separate fresh child imports the installed `KnowledgeBridge` wrapper. A deliberately failing
ambient `pico-cli` sits first on its fake PATH. The wrapper lazily resolves fake registry version
0.4.2, publishes the exact immutable managed path, starts `mcp dev-knowledge` through that path, and
returns explicit managed policy/version/latestVersion/checkedAt/freshness provenance. The child
reports identical PATH before and after; the ambient CLI bytes are identical and its invocation
marker remains absent. The invocation ledger requires exact `npm view`, exact-version
non-global-prefix install, and forbids `-g`, `--global`, setup, and `update --check` argv.

The parent test process imports fixture constructors but never calls the default production ensure
adapter. Production adapters run only in the isolated server/wrapper children. The real
`/Users/sushantsrikrish/.pico-mcp/cli` sentinel was absent before and after every gate.

## Documentation and claim corrections

The six operational policy sections consistently document:

- lazy default `managed-latest`, immutable MCP-owned exact versions, and registry freshness as of
  `checkedAt`;
- startup/tool registration/`tools/list`, `preflight_env`, and default `pico_doctor {}` as
  npm/provisioning/store-write-free, beside the mutating `{calibrate:true}` exception;
- untouched ambient global CLI/PATH and honest `unknown`/`outdated` cached fallback labels;
- `managed-cached`, absolute-path `external`, and `disabled` escape hatches;
- deprecated aliases through 37.x, force-refresh health with inert deprecated `update`, manual
  user-run setup, and why the MCP does not run cache-writing `update --check`;
- the dated 0.4.2 registry observation, v1.0 timing as unverified planning input, and the complete
  reachable advertised help-only sweep's explicit semantic/runtime/visual limits.

Current knowledge guidance now names `mcp dev-knowledge`. The dated 0.4.2 record still states that
the initial sweep was targeted, `app launch` differed, `update --check` writes a cache, and doctor
only returned on the one measured macOS arm64 machine. Current implementation labels changed from
`not-provisioned` to `setup-required`; the observed old hidden alias is preserved as a dated fact,
not a production dependency. Unsupported “fixed upstream” and generally common-0.3 comments were
removed from both authorized source files. Historical Windows evidence was not edited.

## Release metadata

The release decision is 37.0.0. `package.json`, the two package-lock root entries, root portable
manifest, Claude/Codex/Cursor manifests, and every tracked agents/Claude/Cursor/GitHub marketplace
version are synchronized. `CHANGELOG.md` has a dated 37.0.0 entry and records the migration without
claiming native Windows, emulator/device, setup-gated perf, or visual evidence.

## Verification

- `npm run build` — PASS (`tsc`, exit 0).
- `npm run test:distribution-adoption` — PASS: 36/36, 0 failed.
- `npm run test:docsmeta` — PASS: 0 failures; all 85 relative links resolve and metadata sync is
  clean. It emitted the existing linked-worktree warning because `.git` is a file rather than a
  directory, so homepage/origin comparison was skipped; no homepage/origin equality claim is made.
- `npm run test:lint` — PASS: 36 lint rules plus integration fixture, and 7/7 battery-runner tests.
- `git diff --check` — PASS, no output.
- Explicit metadata equality, scope, and claim searches — recorded in the final handoff after the
  fresh final run.

## Harness incidents and recovery

1. The initial RED used the wrong doctor response level, described above. It was a test assertion
   error, not a production failure; the corrected RED isolated the intended documentation change.
2. One focused policy probe assigned to zsh's read-only `status` variable after the test and both
   sentinel checks had completed. The shell wrapper itself exited at that assignment. Later probes
   use task-specific result names. No production command, npm/CLI adapter, or filesystem mutation
   was involved.
3. The first final scope audit compared an allowlist with `git diff --name-only`. That command omits
   untracked files, and the report is ignored by the SDD scratch-directory wildcard until it is
   force-added, so the audit falsely reported this report as missing and stopped before its trailing
   sentinel command. An immediate explicit check confirmed the real managed root was absent. The
   corrected audit includes worktree, staged, untracked, and this intentionally ignored report,
   then verifies the staged commit scope separately.

No real managed-root write occurred, so no cleanup or quarantine was required.

## Evidence limits

- 0.4.2 is reported only as registry latest observed on 2026-08-14, not a timeless latest value.
- The help sweep establishes only complete reachable advertised help bytes outside the prohibited
  top-level setup subtree. It does not prove semantics, hidden aliases, setup-gated perf behavior,
  emulator/device behavior, native Windows behavior, or visual results.
- No real registry request, real npm install, global CLI, setup, update-check, emulator/device,
  Swan, native Windows, or rendered-frame LOOK was performed in Task 6.
- The user/PICO-team v1.0 date is retained only as unverified planning input.

## Review fix round

The reviewer identified three important weaknesses in the Task 6 test gate. This round changes
only `test/distribution-adoption.mjs` and this report; production code and public prose remain
unchanged.

The original report's statement that the installed children had no CLI policy override was not
yet proven: the shared Task 4 harness seeds `PICO_MCP_CLI_POLICY=managed-latest`. A focused RED run
after adding the missing assertions failed 3/4 cases: both installed children reported the policy
as explicitly set, and a deliberately inverted policy section passed the old permissive regex
gate. The valid current policy section passed. Both fresh child-specific environment copies now
delete `PICO_MCP_CLI_POLICY` before launch and assert that it is absent; the wrapper child also
reports `policyWasSet: false` from inside the process while its returned provenance independently
reports the default `managed-latest` policy. The shared Task 4 helper was not changed.

The heading-scoped documentation validator now normalizes markdown and whitespace, then requires
independent literal normative clauses for the default, lazy activation, immutable ownership,
ambient CLI/PATH isolation, fallback truthfulness, all policy definitions, aliases, manual setup,
the update-check exclusion, and help-sweep limits. It also rejects known inverse clauses. An
adversarial fully inverted section must fail, and appending each forbidden inverse to the valid
README section must fail independently. During GREEN, the normalizer initially removed underscores
from environment variable names and caused 2/4 focused failures; retaining underscores corrected
the test helper without changing documentation.

Managed CLI provenance now must equal the canonical platform path
`<managedRoot>/versions/0.4.2/node_modules/.bin/pico-cli` (or `pico-cli.cmd` on Windows), rather than
merely sharing a version-directory prefix. A mutation assertion proves that the same path with an
`-evil` suffix is rejected. The guarded focused GREEN run passed 4/4, and the real
`/Users/sushantsrikrish/.pico-mcp/cli` sentinel was absent before and after both RED and GREEN.

The installed/tarball exercises continued to use only isolated temporary homes and fake npm/CLI
adapters. No network, real registry, npm install, global CLI, setup, update-check, emulator/device,
Swan, Windows, visual, remote, permission, or visibility operation was performed. Full gate results
for this fix round:

- `npm run build` — PASS (`tsc`, exit 0).
- `npm run test:distribution-adoption` — PASS: 37/37, 0 failed.
- `npm run test:docsmeta` — PASS: 0 failures and all 85 relative links resolve; it retained the
  linked-worktree `.git/config` warning, so no homepage/origin equality claim is made.
- `npm run test:lint` — PASS: 36 lint rules plus integration fixture and 7/7 battery-runner tests.
- `git diff --check` — PASS, no output.

The first exact-file staging command updated both tracked files but returned nonzero after warning
that the report's parent scratch directory is ignored. The commit therefore did not run. Status and
the staged-name list confirmed that no extra path was staged; the report was then restaged with the
explicit force required by that known ignore rule before the staged scope audit and commit.
