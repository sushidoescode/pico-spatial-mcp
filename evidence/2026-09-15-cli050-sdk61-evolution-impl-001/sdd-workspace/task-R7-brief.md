### Task 7: Align release metadata and record honest platform acceptance

**Files:** Modify `package.json`, `package-lock.json`, `scripts/sync-metadata.mjs`, `test/docsmeta.mjs`, version-bearing `plugin.json`, `.claude-plugin/*`, `.codex-plugin/plugin.json`, `.cursor-plugin/*`, `.agents/plugins/marketplace.json`, `.github/plugin/marketplace.json`; write fresh release evidence and update affected public docs.

**Interfaces:** Extend existing docsmeta checks to compare `package-lock.json.version` and `package-lock.json.packages[''].version` to `package.json.version`. Consume Task 6's artifact receipt and the companion CLI plan's exact 0.4.4/0.5.0 compatibility receipts; do not infer semantic compatibility from help alone.

- [ ] Add a lock-version mismatch fixture without changing production version yet. Preserve each host's distinct manifest schema and exact launch-token contracts.
```js
for (const value of [lock.version, lock.packages[''].version]) assert.equal(value, pkg.version);
```
- [ ] Run the focused metadata test and retain a deliberate mismatch failure; restore the fixture, not production metadata.
- [ ] Choose the release version from accepted scope and repository compatibility policy, then set the task-specific `PICO_MCP_RELEASE_VERSION` environment value to that exact reviewed version. Apply it without creating a Git tag using the following guarded command; run `npm run sync:meta` and inspect the entire manifest/lock/doc diff before building.
```sh
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { npmLaunch } from './scripts/plugin-bootstrap.mjs';
const version = process.env.PICO_MCP_RELEASE_VERSION;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''))
  throw Error('PICO_MCP_RELEASE_VERSION must contain the reviewed release version');
const launch = npmLaunch(['version','--no-git-tag-version',version]);
const result = spawnSync(launch.command,launch.args,{stdio:'inherit'});
process.exit(result.status ?? 1);
NODE
```
- [ ] Run `npm run build`, `node scripts/sync-metadata.mjs --check`, `npm run test:docsmeta`, `npm run test:distribution-adoption`, and the now-hermetic inventory-driven battery with a fresh log path. Do not re-run completed expensive checks without source changes or unresolved failures.
- [ ] Produce the exact distributable through Task 6. Verify installed `tools/list` and representative door/full requests on each actually exercised platform. Record fixture-only Windows coverage and macOS compile/contract coverage separately when installed-host execution is unavailable.
- [ ] Actual Claude/Codex/Cursor discovery remains a separate host acceptance step: record host/version, plugin/source identity, expanded command, startup result, and observed tool requests. Test-side token replacement alone earns structural coverage. No emulator/physical/headset claim is part of this plan.
- [ ] Update AGENTS' stale historical test counts from the derived inventory without changing canonical policy bytes. If any policy change is independently approved by scope, update its canonical assertion and all six documents together; do not bypass its guard.
- [ ] Publish no remote release and push nothing. Commit the coherent local metadata/evidence checkpoint with `git commit -m "chore: checkpoint validated CLI SDK compatibility release"` after reviewing explicitly staged paths.

## Completion and Review Checklist

- [ ] Source/lock edits cannot serve or test stale output; removed source cannot ship orphan JS; failed builds preserve prior usable artifacts.
- [ ] Every named gate has one declared host assignment; revision suites execute; new scripts cannot silently escape CI.
- [ ] Default smoke needs no personal project and reaches no real device/CLI acquisition path; optional integration reports limits explicitly.
- [ ] Tracked docs have the same default result locally and in a clean checkout; package, lock, and host manifests carry one release identity.
- [ ] Verified publication never replaces/deletes prior artifacts; installed-artifact checks and actual-host checks are separately evidenced.
- [ ] No global CLI, paused app, emulator, Wing, credentials, policy guard, history, or remote state was changed outside authorized scope.
