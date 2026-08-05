# Task 1 report — project configuration and build truth

## Delivered

- Added `verify_gradle_config`: a static, realpath-contained audit of the four required Compose exclusions and Stage/WindowContainer metadata/root compatibility. `resolveTransitives:false` is static-only; the explicit true path runs only a bounded Gradle dependency report, preserves static findings, records parent chains, and refuses an escaping wrapper symlink.
- Added `build_matrix_report` and `docs/BUILD_MATRIX.md`, extracting observed scaffold SDK, Java, Kotlin, AGP, Compose plugin/BOM, ABI, and exact `spatialToolsVersion: {status:"not-declared"}` values with source paths, extraction failures, and non-runtime caveats.
- Added total pico-cli status-envelope parsing and a post-`-v`, exact-argv `pico-cli emulator status --format json` preflight row. SUCCESS passes; PARTIAL/FAILED/malformed output warn with diagnostics. No doctor command is invoked.
- Integrated the static audit into `preflight_lint(projectDir)`, added Gradle lint coverage, diagnosis entries, prioritized `pico_fix` routing, full-surface capability/registration metadata, corrected Mixed-stage door wording, and synchronized the 236-tool metadata.

## TDD evidence

- RED witnessed before implementation: `npm run build && node test/adoption-safety.mjs` failed with `ERR_MODULE_NOT_FOUND` for `dist/projectconfig.js`.
- GREEN witnessed after implementation: `npm run build && npm run test:adoption-safety` completed with `Failures: 0`.

## Verification

- Focused: `npm run build`, `npm run test:adoption-safety`, `npm run test:lint`, `npm run test:picocli`, `npm run test:preflight`, and `npm run smoke` all passed.
- Final full battery: `npm run smoke` followed by every current `test:` script (40 scripts, including tarball and native virtual-camera suites) passed with command exit 0. Smoke listed exactly 236 tools.
- `npm run sync:meta` reported `tools=236 doors=16`; `git diff --check` passed.

## Review and constraints

- Independent review found and the implementation addressed: ABI extraction, source-output bounding, pico-cli diagnostic retention, and Groovy Gradle syntax support. The final focus/full verification above was rerun after those fixes.
- No emulator/device mutation was introduced or performed. The mandated live CLI observation was read-only `pico-cli emulator status --format json`; no `pico-cli doctor` or plugin doctor command was called.

## Follow-up safety-evidence tightening

- RED: the expanded adoption suite initially failed on scope-aware exclusions and the extractor caveat; this demonstrated the prior global-scope parser was too strict for the scaffold end-of-file form and the extractor caveat lacked the required wording.
- GREEN: `npm run build`, `test:adoption-safety`, `test:preflight`, `test:picocli`, `test:lint`, and smoke passed after the fixes.
- Added extractor-to-document literal consistency, global Kotlin/Groovy exclusion scope tests, unused-block negative coverage, mixed-metadata warning coverage, and complete bounded pico-cli diagnostic-payload coverage.
- Final follow-up battery: all 40 current `test:` scripts passed (after smoke, together the documented 41-invocation battery) with exit 0.

## Re-review contract fixes

- RED: nested `errors[].fix` was retained only in the raw payload and did not become the preflight remedy; the new fixture failed with the generic fallback.
- GREEN: recursive remediation extraction now uses deterministic precedence (`fix`, then `nextAction`; errors, checks, data, then sorted remaining fields), is bounded by the parsed-envelope limits, and preserves only returned strings.
- Expanded matrix/document assertions iterate every executable observed field, the spatial-tools sentinel, and both source-link mappings. Timeout/nonzero assertions now retain a genuine direct-Compose static error.
- Final verification: focused build/adoption/preflight/picocli/lint/smoke and the complete 40 `test:` script battery passed (41 documented invocations including smoke).

## Final matrix row binding

- RED: `npm run build && npm run test:adoption-safety` failed because the new exhaustive row test called the intentionally absent `buildMatrixMarkdownRows` projection.
- GREEN: the exported projection now binds each Markdown label to its exact ordered executable fields, exact source link, or spatial-tools sentinel; the focused build/adoption test passed.
- Final battery: smoke plus all 40 current `test:` scripts passed with exit 0 (41 documented invocations total).
