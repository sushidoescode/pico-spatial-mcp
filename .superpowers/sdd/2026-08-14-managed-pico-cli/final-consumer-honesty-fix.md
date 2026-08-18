# Final-review consumer and documentation honesty remediation

Date: 2026-08-14

## Scope and evidence boundary

- Review base: `528ddb9f907038539720e9a5dfcf942b7be681c5`; the bounded help-sweep fixes
  `52815a4` and `1163e23` landed on the shared branch before this slice was committed.
- This slice changes the read-only doctor/preflight consumer, CLI-backed setup-refusal consumers,
  KnowledgeBridge startup diagnostics, managed setup remedies, SpatialBench schema wording,
  operational policy documentation and their focused hermetic gates.
- The planned gates used isolated fake executables, temporary homes and temporary managed stores.
  One independent-review scratch probe violated that boundary: it imported `KnowledgeBridge`
  before installing the fixture environment, so the adapter retained the real home and published
  the fake `sha512-runtime-fixture` entry under the real managed root. The exact tree was moved
  intact to `/tmp/pico-integrity-real-home-quarantine.YSiMBi/cli`, and the real root was confirmed
  absent afterward. The incident is recorded in the dated finding and this slice is not described
  as exclusively isolated or free of real-home mutation. No network/registry request, real npm
  install, real pico-cli, setup, `update --check`, emulator/device/Swan operation,
  native-Windows execution, rendered-frame LOOK,
  remote, visibility or permission change occurred.

## Review findings reproduced before implementation

- Seven hand-authored preflight inspection cases failed because production flattened disabled,
  managed-cache-only, corrupt immutable-cache, external and invalid configurations into generic
  managed/latest prose.
- Setup-refusal wrappers exposed the source claim "managed CLI is current" even for unknown,
  outdated, cached and external provenance.
- Runtime-published lint, vault, door and vault-workspace guidance exposed an ambient
  `pico-cli setup` command; SpatialBench's published schema required a CLI "on PATH".
- A fake knowledge server's startup refusal was inherited on process stderr and returned no
  structured setup remedy or bounded diagnostic tail.
- The operational-doc gate was a finite phrase blacklist, and the dated Task 7 finding falsely
  said no `record_verification` call occurred even though the synthetic battery invoked it against
  temporary test ledgers.
- Independent follow-up review found that a refusal followed by more than 16 KiB of stderr lost its
  setup classification, that pico_loop appended setup advice to unrelated structural/logcat
  measurement gaps, and that non-setup policy contradictions could be appended outside the exact
  documentation markers.

The RED runs were the focused `test/preflight.mjs`, `test/vault.mjs`, `test/vaultdiff.mjs`,
`test/briefroute.mjs`, and named `test/distribution-adoption.mjs` cases. Production was changed only
after those failures were observed.

## Implementation

- `preflight_env` and default `pico_doctor` now retain the exact read-only resolver result on the
  CLI check and derive policy-specific detail/fix text without claiming registry freshness.
- Perf, trace, crash, capture and knowledge startup setup refusals use one source/freshness-neutral
  statement and retain provenance plus `{path: <absolute resolved CLI>, args: ["setup"]}`. Setup is
  returned for manual execution and is never invoked by the tests or MCP. The dated implementation
  plan's example result was corrected to the same neutral contract.
- Lint, vault, vault-workspace, door-loop and vault-index-builder remedies first direct the caller
  through `ensure_pico_cli`, then the returned absolute path and structured setup argv.
- Vault workspace results now distinguish zero materialized vaults from exactly one rather than
  labeling both states "only one."
- KnowledgeBridge pipes and retains only the last 16 KiB of startup stderr, incrementally
  classifies the measured setup refusal in bounded overlapping windows even when later output
  evicts it from the retained tail, and preserves existing serialized child sharing and bounded
  retirement behavior.
- pico_loop carries the CLI failure class into an unmeasurable perf result and includes the manual
  setup remedy only for `perf` + `setup-required`; structural, logcat and other runtime gaps retain
  their own lane-specific diagnostics.
- SpatialBench now describes managed absolute-path resolution rather than ambient `PATH` lookup.
- Six operational documents carry one byte-exact policy block between canonical markers. The gate
  checks those exact bytes, rejects appended active/passive automatic setup/update claims plus
  alternate policy/default, PATH-mutation and fallback-as-latest prose, scans every
  runtime-published tool definition for actionable ambient setup guidance, and exercises the
  affected result/fix paths. Dated findings and changelog history are explicitly outside the
  operational-policy scanner.
- The Task 7 finding now distinguishes no live proof/real-ledger entry from isolated synthetic
  `record_verification` fixture calls.

The three follow-up findings were each reproduced with a failing hermetic test before the fix. An
independent re-review approved the resulting diff with no remaining Critical or Important finding.
That review's unsafe direct scratch reproduction caused the real-home fixture incident disclosed
above; its code finding remains valid, but the reproduction is not counted as isolated evidence.

## Verification record

After the integrity fix was committed at `f413096`, the following final gates were run serially,
with the real `~/.pico-mcp/cli` sentinel absent before and after every invocation:

- `npm run build` — exit 0;
- `npm run test:preflight` — 0 failures;
- `npm run test:doors` — 0 failures;
- `npm run test:briefroute` — all assertions passed;
- `npm run test:vault` — 0 failures;
- `npm run test:vaultdiff` — 0 failures;
- the named bounded-stderr KnowledgeBridge setup-refusal test — 1/1 passed;
- `npm run test:distribution-adoption` — 42/42 passed;
- `npm run test:docsmeta` — 0 failures, with only its known worktree `.git/config` origin-check
  warning;
- `npm run test:lint` — 0 lint-fixture failures and 7/7 battery-runner tests passed;
- `npm run test:claims` — 0 failures;
- `npm run test:picocli` — exit 0 (legacy fixture failures: 0; managed/sweep Node tests:
  119/119 passed).

Before the parent requested serial execution, the five focused consumer gates were first launched
concurrently; they all passed with their sentinels absent. They were then rerun serially as listed
above, so the final evidence does not rely on the overlapping run.

These are structural/fixture gates only. They do not establish registry availability, real-CLI
semantics, utility provisioning, emulator/device behavior, native-Windows behavior or visual
evidence.
