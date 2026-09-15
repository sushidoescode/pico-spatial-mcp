# Release and gate audit for CLI 0.5.0 / SDK 6.1 evolution

Date: 2026-09-15. Repository source inspected: `308c898e9c33975b5a21ecb78fed245fab17a0ed`.

This report records a bounded read-only source audit. No builds, tests, npm installs, CLI execution, emulator operations, or production changes were performed by this auditor. Counts below were derived by reading package/workflow/test files; they are not test-run results. The parent audit independently verified registry latest as CLI **0.5.0**, published **2026-09-10**, and retained integrity-verified 0.4.4 and 0.5.0 tarballs in this evidence directory. That verification was not repeated here.

## Prioritized findings

### P0 — repair CI inventory before relying on the upgrade battery

`package.json:27–76` contains **48 `test:` scripts**, or **49 named invocations including smoke**. `.github/workflows/gates.yml` currently assigns **45 Linux + 1 Windows + 2 macOS = 48** named invocations. The omitted script is `test:runrevision` (`package.json:67`), containing four revision suites.

`test/distribution-adoption.mjs:1990–2017` still expects 44 Linux/47 total; `test/distribution-adoption.mjs:2088–2096` expects 46 test scripts. Those assertions necessarily disagree with the inspected source. This is a confirmed static inconsistency, not a claim that the test command was executed.

Add the revision suites to the appropriate lane and derive the inventory from one source while retaining exact per-host assignment assertions. Update the historical README/AGENTS counts. Do not remove coverage assertions to make the upgrade pass.

### P0 — individual test commands can consume stale dist

`package.json:24–76` declares `build: tsc` but no `pretest` or shared freshness guard. **60 of 80 top-level test `.mjs` files contain actual imports from `../dist/`**; AGENTS' historical 51/60 count is stale. `dist` is ignored by `.gitignore:2`.

Require a current build identity before testing. Build once after each source change, then run relevant suites against that same output. Add a regression proving changed source cannot pass against an older `dist`. Do not mistake unchanged output from a stale build for evidence about edited source.

### P0 — warm source-plugin bootstrap has no source/lock freshness check

`scripts/plugin-bootstrap.mjs:34–45,202–220` only checks whether the `node_modules` directory and `dist/index.js` exist. Tests explicitly expect unchanged warm startup to run no build (`test/distribution-adoption.mjs:865–875,1020–1028`), but the decision inputs cannot distinguish changed source or lockfiles.

Add a source/lock/toolchain fingerprint or equivalent deterministic invalidation for source installations. Preserve fast unchanged warm startup, bounded subprocesses, and clean MCP stdio. Cover cold startup, unchanged warm startup, changed source, changed lockfile, and failed rebuild. This audit did not establish that the currently running server is stale; it established the missing freshness mechanism.

### P1 — normal packing rebuilds, but deleted modules can survive

The normal tarball path already rebuilds through `prepack` (`package.json:25`). However, `tsc` does not clean removed modules and prepack cleanup only removes Python bytecode (`scripts/prepack-clean.mjs:17–34`; `tsconfig.json:6–14`). Distribution-adoption's private pack helper explicitly uses `--ignore-scripts` (`test/distribution-adoption.mjs:58`).

Add safe clean-output or manifest-bound packaging so a removed TS module cannot remain as orphan JS. Preserve the normal prepack/build behavior. Add an orphan-output regression, and document that the `--ignore-scripts` fixture requires fresh output.

### P1 — smoke depends on a personal project and can run real packing

`test/smoke.mjs:11–15,132–148` references a Claimsight project/bundle under the host's home directory without checking its existence. The optional environmental skip recognizes only a narrow SDK-missing error regex (`test/smoke.mjs:23–33`); CI sets that flag (`.github/workflows/gates.yml:49–52`). When tooling exists, the test exercises real bundle packing.

Separate hermetic registration/contracts from explicit local SDK integration. Use a generated fixture or explicit project input. Report missing SDK/project prerequisites as bounded integration skips without suppressing actual tool errors. The current blanket smoke command is not an innocuous read-only environment check.

### P1 — CLI observation needs an upgrade baseline and useful retained diagnostics

`.github/workflows/picocli-compat.yml:3–14,29–32` runs weekly or manually on Ubuntu and compares fixed **0.4.2 → latest**. This is a help observation, not JSON/runtime semantic compatibility. `scripts/compare-picocli-surfaces.mjs:455–505` records command counts and help hashes without retaining raw help. Its scratch directory is deleted even after failure (`scripts/compare-picocli-surfaces.mjs:564–565`).

For the upgrade, compare **0.4.4 → 0.5.0** and preserve historical 0.4.2 evidence. Add source-version-bound wrapper and JSON contract fixtures. Retain useful raw help, argv, exit status, and partial failure diagnostics without labeling incomplete traversal complete. Select the ongoing supported baseline deliberately. Preserve existing bounded execution and command-safety guards.

### P1 — installed-artifact tests are valuable but do not prove every host

`scripts/verify-tarball.mjs:94–110,332–404` already checks clean npm installation, hostile paths, exact full/doors/default tool counts, and the inner self-client round-trip. Preserve these tests. CI runs this suite only on Ubuntu (`.github/workflows/gates.yml:113–114`). Windows runs shim/fixture tests; macOS runs native helper contracts.

Host-launcher tests expand manifest tokens themselves and launch from the repository (`test/distribution-adoption.mjs:1031–1068`). They do not execute inside actual Claude, Codex, or Cursor hosts. Add installed-artifact checks on claimed platforms where support is intended, and record actual host discovery/startup separately. Simulated token expansion is not proof of host installation. Increasing tool counts is not an acceptance criterion for adding value to the CLI.

### P1 — tarball publication currently prunes previous artifacts

`scripts/verify-tarball.mjs:407–412` removes **all existing `.tgz` files** in its `--publish` directory before copying the verified artifact.

Use a fresh versioned publication/evidence directory for this upgrade. Preserve previous artifacts and receipts. A future enhancement should reject replacement or retain earlier versions rather than silently prune them.

### P2 — local docs validation sees a different file set from clean CI

`test/docsmeta.mjs:56–80` scans every filesystem root Markdown file plus `docs/**`, rather than only tracked files. This checkout includes extra root `CLAUDE.md`, `HANDOFF.md`, `NEXT-AGENT-PROMPT.md`, and `PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md` files that are not tracked and will not exist in clean CI.

Make public tracked-document validation deterministic, with a separately labeled optional local-doc audit. Create targets before linking them. Preserve relative-link validation.

### P2 — metadata is currently aligned; release updates must preserve that

All checked package/lock/core/Claude/Codex/Cursor/Copilot marketplace versions agree on **37.0.0**. `scripts/sync-metadata.mjs:123–242` synchronizes host manifests and selected public docs but does not synchronize `package-lock.json`. No release or npm-publish workflow exists among the three inspected workflows: `gates.yml`, `picocli-compat.yml`, and `windows-emulator-probe.yml`.

Choose a release version after the implemented scope is known, update package and lock together, run metadata sync, and verify the exact distributable. The operational CLI policy is byte-pinned across six documents (`test/distribution-adoption.mjs:83–197,1743–1755`). Preserve its semantics. Change the canonical source and all six governed copies together only if a reviewed policy change actually requires it. Historical observed CLI versions are dated evidence, not timeless pins.

## Proposed validation for the implementation chat

These commands were **not run** in this audit. Run them from the implementation checkout after corresponding source changes and fixes. A fresh build must precede source-dependent tests; avoid rebuilding or repeating completed suites without a new reason.

```sh
npm run build
npm run test:picocli
npm run test:runrevision
npm run test:runreceipt
npm run test:distribution-adoption
npm run test:knowledge-lifecycle
npm run test:preflight
npm run test:projectgen
npm run test:docsmeta
npm run test:tarball
```

Run `node scripts/sync-metadata.mjs --check` before and after release metadata changes. After smoke is explicit/hermetic and the inventory repaired, the existing keep-going runner discovers all named invocations automatically:

```sh
node scripts/run-battery.mjs /absolute/implementation/checkout /absolute/fresh-evidence/battery.log
```

Use a fresh log filename: `scripts/run-battery.mjs:46` overwrites its configured log. Off-platform macOS native scripts return success with an explicit skip (`scripts/test-cmio-camera-reader.sh:3–6`, `scripts/test-cmio-camera-writer.sh:3–6`). Report those as skips, not native verification. Neither a help sweep nor fixture tests establish emulator visual correctness or actual host integration.
