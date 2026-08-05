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
