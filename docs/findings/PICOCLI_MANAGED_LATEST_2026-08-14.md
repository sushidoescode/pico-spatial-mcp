# Managed pico-cli latest scratch proof — 2026-08-14

Evidence class: `structural`. This finding records bounded registry, process, filesystem, version,
and help-byte observations. It does not claim a rendered-frame LOOK, emulator/device behavior, or
semantic compatibility beyond the commands actually invoked.

## Result

At `2026-08-14T18:18:47.883Z`–`18:18:48.757Z`, the public npm registry reported
`@picoxr/pico-cli@latest` as 0.4.2. Under the explicitly selected
`PICO_MCP_CLI_POLICY=managed-latest` policy, a first-use MCP call then installed 0.4.2 into a fresh,
isolated managed root. The installation used a non-global staging prefix and `--ignore-scripts`.
Schema-2 install/publication records bound the returned command to a measured content manifest.

A fresh MCP process with a controlled failed registry view subsequently returned the same validated
cache with `action:"cached"`, `freshness:"unknown"`, `latestVersion:null`, and a
`latest-unknown` warning. A separate fresh online help sweep resolved latest to 0.4.2 and measured
69/69 advertised help paths unchanged. The narrow before/after snapshot of the ambient/global 0.3.0
installation was identical.

The full local battery was intentionally keep-going and completed all 46 discovered invocations.
Its exact result was **non-green**: `BATTERY FAIL 45/46 passed; 1 failed: smoke [exit 1]`.
`scene_schemas` was the sole failing smoke section because the host SDK lacks the expected USD
schema directory. Every other invocation passed.

This is a dated observation, not continuous-latest evidence. The live call proves the explicit
managed-latest path only. The unset-policy default is covered by the distribution/tarball gates,
not by an unset-policy live registry call.

This finding and its JSON supersede the stale evidence first committed in
`528ddb9f907038539720e9a5dfcf942b7be681c5`. Before no-clobber regeneration, the old tracked bytes
were copied into the new retained proof root. Their SHA-256 values were
`4d93d80229f96fe007da5ab63496670a2dfe4484a119e90b5e7b6f60c5968d86` (Markdown) and
`feb92f5b44b243dc5f2322f9867ba0d5175880316203eed4375f6edaf03f9324` (JSON).

## Source, host, and isolation

- The live registry, MCP, sweep, package, focused, and native observations used approved
  product/runtime commit `867f0f90aa5222a764ac5d40847fe29e6740dd54`, after a successful build.
- The complete battery ultimately used reviewed commit
  `40afbed062b0f00d8ddef4a4295328b01be6ca7a`. That commit changes only the test's expected
  `src/spatialbench.ts` hash; product/runtime source is byte-identical to the live-proof commit.
- Host: macOS 26.5 (25F71), Darwin 25.5.0, arm64.
- Node: `/usr/local/bin/node`, `v22.14.0`; npm: `/usr/local/bin/npm`, `10.9.2`.
- Retained live proof root:
  `/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-managed-proof.il1bY2`.
- Retained final battery root:
  `/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof2.M7qsxN`.
  Its linked source worktree was removed cleanly after the log and audit were retained.
- The user explicitly authorized the bounded live public-registry observations and non-global
  scratch installs recorded here.

Each phase started with `env -i`, a fresh `HOME`/`USERPROFILE`, scratch user identity and cwd, a
credential-free user npmrc containing only the fixed public registry and update-notifier/fund/audit
settings, an empty global npmrc, scratch npm cache/prefix/TMP/XDG/COREPACK locations, and a
dedicated `PICO_HOME` where applicable. The public registry was fixed to
`https://registry.npmjs.org/`; update notifier, fund, and audit were disabled in scratch config.
No ambient npm config, auth/token, or proxy variable was inherited. The restricted path was
`$PROOF/bin:/usr/bin:/bin:/usr/sbin:/sbin`: it exposed scratch node/npm wrappers and no
`pico-cli`. Each phase had its own npm argv ledger so calls from one phase could not mask another.

The real-home sentinel `/Users/sushantsrikrish/.pico-mcp/cli` was checked with `lstat` before and
after every phase and remained absent. Timestamped sentinel artifacts are retained. A whole-proof-
root search found no `update-check.json`.

The essential live commands were:

```bash
# In the isolated registry phase:
npm view @picoxr/pico-cli@latest version dist.integrity --json

# In a fresh isolated process, the built stdio server received exactly:
ensure_pico_cli {}

# In a separate isolated sweep phase, after archiving and then removing the old target:
node scripts/compare-picocli-surfaces.mjs \
  --from 0.4.2 \
  --to latest \
  --output "$(pwd)/docs/findings/picocli-managed-latest-surface-2026-08-14.json"
```

The MCP server child explicitly received `PICO_MCP_SURFACE=doors` and
`PICO_MCP_CLI_POLICY=managed-latest`; no default policy is inferred from that call.

## Registry observation and schema-2 publication

The independent direct registry response was:

```json
{
  "version": "0.4.2",
  "dist.integrity": "sha512-qapgwB+OljD0qQukilhaAmhIemuoIvMO/dkQOVDcZEhLdW1KxpbpkNyLII9hJ6m5F/QYF4UZoPpkjH9IL5U7mA=="
}
```

The separate online MCP window was `2026-08-14T18:19:29.468Z`–`18:19:43.991Z`. The result was:

- `status:"ok"`, `source:"managed"`, `policy:"managed-latest"`, `action:"installed"`;
- `version:"0.4.2"`, `latestVersion:"0.4.2"`, `freshness:"latest"`;
- `checkedAt:"2026-08-14T18:19:29.819Z"`, inside the MCP call window;
- absolute path
  `/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-managed-proof.il1bY2/phases/online/home/.pico-mcp/cli/versions/0.4.2/node_modules/.bin/pico-cli`.

Both lexical components and real paths were checked beneath the expected managed version root.
The package was `@picoxr/pico-cli@0.4.2`. `install.json` and `publication.json` were schema 2 and
agreed on version, registry-reported integrity, and this content identity:

| field | measured value |
|---|---|
| manifest schema | 1 |
| SHA-256 | `cc3aca2125ab4425de313aa710fc61086cde8ba613618ee41559a2bf5f838d69` |
| entries | 4,875 |
| total bytes | 56,546,571 |

`publication.json` and adjacent `.0.4.2.publish` were the same hard link and the same bytes:
`dev=16777231`, `ino=51799964`, link count 2, size 487, bytes SHA-256
`83398e441d47eabc10d3ecb1ae293c65b7360030585c2df3d58007885041c17c`. Their token was
`04fc3945-f6ec-4ade-855e-c48d32de3db0`. These facts establish local content binding and preserve
npm's reported integrity value; they do not independently establish publisher identity or make a
tamper-proof claim.

The direct-registry ledger contained exactly the one `view` above. The online MCP ledger contained
exactly:

```text
view @picoxr/pico-cli@latest version dist.integrity --json
install --prefix <contained-staging-prefix> --no-save --package-lock=false \
  --ignore-scripts --fund=false --audit=false @picoxr/pico-cli@0.4.2
```

There was no `-g`/`--global`, publish, setup, doctor, plugin doctor, or update-check call.

## Guarded version and help execution

A single fresh sanitized process used the production API chain
`ensurePicoCli({ managedRoot })` under `managed-cached` → `picoCliFromEnsure(result)` →
`runPicoCli(target, argv)`. Keeping this in one process preserved the opaque execution handle.
Production bounds and pre-spawn/post-spawn/post-completion validation ran for all 11 commands; the
invocations used a 120,000 ms timeout and 8 MiB output cap, and the instrumented callback counts
were 11/11/11. This is evidence about those production guards and callbacks, not syscall tracing.
The phase made zero npm calls.

The returned shim's `-v` output was
`pico-cli/0.4.2 (public) darwin-arm64 node-v22.14.0`; SHA-256 of `stdout + stderr` was
`267eac5634d3e971781cfaa5cb2ec29751cfa932f7803dfadb489ea624956f3b`. Root `--help` exited 0,
was not timed out or truncated, and hashed to
`c78b513f95bd5ad1e1b3bb0867265d7d9743b81a7b6d6a27a5ae92c268cf5941`.

The nine help-only canaries exactly matched `compatibility.json`:

| argv | exit | SHA-256 of stdout + stderr |
|---|---:|---|
| `perf monitor run --help` | 1 | `d22fe9b905cc5a56866b8ea4d8e88fe33e0e640078a9678aa882c179df943477` |
| `perf trace record --help` | 1 | `d22fe9b905cc5a56866b8ea4d8e88fe33e0e640078a9678aa882c179df943477` |
| `perf trace decode --help` | 1 | `d22fe9b905cc5a56866b8ea4d8e88fe33e0e640078a9678aa882c179df943477` |
| `perf trace load --help` | 1 | `d22fe9b905cc5a56866b8ea4d8e88fe33e0e640078a9678aa882c179df943477` |
| `perf trace query --help` | 1 | `d22fe9b905cc5a56866b8ea4d8e88fe33e0e640078a9678aa882c179df943477` |
| `app watch-crash --help` | 0 | `66665f115a9b01205d6f2cd361cd1bae20d9878e936c1f261f576a198f41d20c` |
| `capture record --help` | 0 | `edc531b100e9aab1873a6bf3c316dd755e96b52bc3c604fce1ab233b48ad2540` |
| `mcp dev-knowledge --help` | 0 | `33b0e8a01533cfd426d699e41f003193a45efa03e99af617c759b8bf6625ce55` |
| `emulator status --help` | 0 | `03e1af0ab85f065d8acbf7cd0e69298d5d005e875a92fd421f6451c7ef180005` |

All nine ended in `--help` and stayed within their output/time bounds. The five perf exits report the
setup gate; no perf runtime behind that gate was exercised. `emulator status --help` was help only,
not an emulator operation.

## Controlled latest-view failure

The fallback used a fresh process during `2026-08-14T18:21:18.751Z`–`18:21:20.913Z`. Its npm
proxy failed exactly one `view` with unique marker `TASK7_SCHEMA2_CONTROLLED_VIEW_FAILURE`; there
was no install. It returned the same path and 0.4.2 version with `action:"cached"`,
`freshness:"unknown"`, `latestVersion:null`, and `warning.failureClass:"latest-unknown"`.

The managed tree before and after had 4,881 deterministic manifest rows and the same SHA-256,
`40a9d281687441b5c3f560ad78cb53bf1143dee71d3ad135e0d4592674e40e23`.
Only the expected fresh phase log paths appeared. This proves the observed latest-unknown fallback,
not the known-newer/install-failure branch, which remains hermetic-test evidence.

## Ambient/global 0.3.0 invariant

The ambient command was resolved before restricting `PATH`, then invoked by absolute path only with
`-v` under an isolated home:

- shim: `/Users/sushantsrikrish/.nvm/versions/node/v25.8.1/bin/pico-cli`;
- output: `pico-cli/0.3.0 (public) darwin-arm64 node-v22.14.0`;
- symlink: mode 0755, size 50, target
  `../lib/node_modules/@picoxr/pico-cli/dist/index.js`;
- real file: mode 0755, size 202,272, SHA-256
  `8e561da9f4fd55686474d275316d1a2f8db06b1730995ce2ee26da9f13ad90a2`;
- deterministic non-following package manifest: 4,450 rows, SHA-256
  `17394901fadbe5caab023d5a3938ae01c5ca84a888c8df1340e18614d9339bc0`.

Before, intermediate, and final snapshots matched for those exact fields. This is a narrow
invariant, not a claim about unrelated global state. No global install or update was run.

## Fresh reachable-help sweep

The separate sweep window was `2026-08-14T18:22:21.115Z`–`18:22:52.890Z`; the report's
`generatedAt` was `2026-08-14T18:22:52.196Z`. Its SHA-256 is
`304cb799c1fc49f0d776935031879c5b29f7be4d2162e7eb62f733e67c717b99`.

The sweep independently observed latest as 0.4.2 and installed exact 0.4.2 twice into separate
contained non-global prefixes. Both install argv included `--ignore-scripts`. It measured 69
commands on each side: 69 unchanged, zero added, zero removed, and zero help-byte changes.
`unchangedCommands.length === commandCount` on both sides. Its `setupInvoked:false` and
`nonHelpCommandsInvoked:false` fields report the generator's central argv guards; they are not
syscall tracing. Hidden and setup-gated descendants remain outside the measurement.

## Package, focused, native, and full-battery verification

Packaging ran from fresh source copy
`/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-package-proof.kFtQ7W/source` with sibling
TMP `/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-package-tmp.koCBKL`, outside the
proof/project ancestry. Exact outcomes:

```text
npm run build                       exit 0
npm pack --dry-run --json           exit 0; 268 files
npm run test:tarball                exit 0; Failures: 0
git diff --check                    exit 0
```

The dry-run tarball was 1,572,045 bytes (unpacked 5,761,019), shasum
`a6eb8d138bf03c9a8609ff20efda16e1752facca`, integrity
`sha512-H7NcNg5Q1j3CyW/D75tvdFnDUZiC8GxXkl3y6gY3BwF/msj5aQegpy7aiCN4JXlh93YkMPD0iZ2pvspTLyHVoQ==`.
Producer pack intentionally ran the repository prepack lifecycle in the copy; it removed only the
copy's `scripts/py/__pycache__`. Tarball verification installed into a contained consumer with
`--omit=dev`; the npm proxy inserted and forwarded `--ignore-scripts`. It found 249 Darwin
full-surface tools, 18 doors tools, the same 18 when the surface was unset, all 37 anchors, no home
path leak, and no build droppings. The ledger showed no view, publish, global install, setup, or
update-check call.

The fresh serial focused set at the live-proof commit passed 7/7:

```text
npm run build                         exit 0
npm run test:picocli                  exit 0; 129/129 tests
npm run test:preflight                exit 0; Failures: 0
npm run test:doors                    exit 0; Failures: 0
npm run test:distribution-adoption    exit 0; 43/43 tests
npm run test:docsmeta                 exit 0; Failures: 0
npm run test:knowledge-lifecycle      exit 0; 4/4 tests
```

`test:docsmeta` warned that its homepage/origin check was skipped because this repository worktree
uses a `.git` file; it otherwise reported zero failures. The audited npm ledger contained seven
outer runs plus two contained `pack --ignore-scripts` calls from distribution-adoption and no
registry view/install/global/setup/update-check.

Both native macOS gates passed:

```text
npm run test:vcamtransport-native    exit 0
npm run test:vcamreader-native       exit 0
```

The reader observed that the host executable was already camera-authorized, so it skipped the
readback-block assertion to remain device-free. This includes read-only host authorization/TCC and
camera metadata queries; it is not a claim of no host-device query or device verification.

The corrective battery used a true detached linked git worktree at the reviewed commit, plus the
existing `node_modules` as an exact-target untracked symlink. Before the battery, build,
`test:spatialui-adoption`, and `test:distribution-adoption` passed (the latter 43/43), proving the
`.git`-aware harness. The source worktree was then removed without deleting the retained root/log.

The unchanged launch was, under its fresh isolated phase environment:

```bash
SMOKE_SDK_OPTIONAL=1 /usr/local/bin/node \
  /private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof2.M7qsxN/source/scripts/run-battery.mjs \
  /private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof2.M7qsxN/source \
  /private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof2.M7qsxN/battery.log
```

It ran from `2026-08-14T19:07:34.530Z` through `19:12:26.679Z`, discovered and completed exactly
46 invocations, and reported:

```text
BATTERY FAIL 45/46 passed; 1 failed: smoke [exit 1]
```

The sole `[FAIL]` line was:

```text
=== scene_schemas (first 1k chars) [FAIL] ===
```

The missing path was
`/Users/sushantsrikrish/Library/PICO/sdk/6.0/editor/spatialbundle/usd`. Invocations 2–46 all passed,
including native macOS, SpatialUI adoption, distribution adoption, knowledge lifecycle,
conformance, and the local `picocli-win` fixture. This 45/46 result is accepted environmental
evidence but is not called green. The retained log SHA-256 is
`cfffbe6b8e27be37c59360b276da35edc4c4a5afa9d0fb1c719692ab881d38c0`.

The isolated battery home was seeded only with byte copies of smoke's two pre-existing ClaimSight
inputs: bundle SHA-256
`6240567c9129f6593a034bebce512ffbe8f3eb80b7bd37ee2985c1777604403c` and symlink-free
53-row `SpatialPackContent` manifest SHA-256
`219135b79dde58f3b23a26cdfed92c34c130ae565d73d832a86b00395ab23080`.
Source and copies matched before the run; the originals matched again afterward. The isolated home
contained no managed CLI, and its empty/temporary ledgers do not validate unrelated real-home
ledgers.

The battery npm ledger had 55 rows: 51 script runs, three contained packs, and one contained
consumer install. The consumer install actually forwarded `--ignore-scripts`; the two adoption
packs also included it, while the producer tarball pack intentionally exercised prepack. No
registry view, global install, setup, or update-check appeared in that ledger.

Smoke's unchanged read-only `emulator_list` observed `2G0YC5ZF7Z056Q device` and
`emulator-5554 device`. It made no lifecycle/control or device-mutating call, and this observation
is not emulator/device verification. Local `test:swan`, `test:emulator-restart`, and
`test:picocli-win` are fixture gates only; they do not establish real Swan, emulator, or
native-Windows execution.

The four `gates.yml` runner lanes are Windows/Node 22 picocli, Linux/Node 20, Linux/Node 22, and
macOS native. No GitHub Actions workflow ran because no push was authorized. Local macOS exercised
the native gates and full battery, but native Windows and the Linux CI executions remain pending;
the separate Windows emulator-probe and picocli-compat workflows also remain pending.

After replacing the two evidence files, a fresh isolated no-registry phase passed build,
`test:docsmeta` (zero failures, the same worktree `.git/config` warning),
`test:distribution-adoption` (43/43), `test:knowledge-lifecycle` (4/4), and
`git diff --check`. Its six-row npm ledger was exactly four script runs and the two contained
`pack --ignore-scripts` calls from distribution adoption; it had no view, install, global, setup,
or update-check call.

## Final invariants

The timestamped check at `2026-08-14T19:16:58.864Z`, repeated after the final evidence gates at
`19:34:08.206Z` locally and `19:34:21.728Z` globally, matched the baseline for:

- real worktree ignored bytecode: size 14,973, SHA-256
  `5e7dffcacd86a77c43064507956f4b2026147c8a46724deacd3a927bc7c4d85f`;
- real worktree `node_modules`: 5,410 non-following rows, SHA-256
  `6796e81fb7e452eb6e44a0c3581677e461f4e3de7c98b5f3ca680a20ace532db`, with no
  `node_modules/pico-spatial-mcp`;
- both original ClaimSight inputs and their hashes stated above;
- the narrow ambient/global 0.3.0 fields stated above;
- the absent real-home managed-root sentinel.

The battery linked source was absent after safe worktree removal; its parent and log remained. The
retained proof roots were not cleaned so their phase-isolated ledgers, failed diagnostics, archived
old evidence, and incident artifacts remain reviewable.

## Incidents and diagnostic boundaries

- Task 4 previously quarantined a fake fixture publication that reached the real managed root at
  `/tmp/pico-task4-real-home-quarantine.W5mCuK`. It remained quarantined and the real root absent.
- Task 5 recorded an early missing-npm fixture case that may have made ambient registry/cache
  contact. Therefore the broader programme/session is not described as contamination-free.
- A later consumer-review scratch probe imported `KnowledgeBridge` before installing its managed
  runtime harness and wrote a fake publication into the real root. The tree was moved intact to
  `/tmp/pico-integrity-real-home-quarantine.YSiMBi/cli`; it involved no real npm/CLI/setup/device
  operation. The real root remained absent afterward.
- An older Task 7 tarball attempt put `TMPDIR` beneath its proof/package ancestry, causing a local
  tarball install into that proof root. It touched neither the real worktree nor global package;
  that mutated proof root remains retained. Successful packaging used the sibling TMP above.
- Earlier stale Task 7 sweep and battery attempts remain diagnostics. The old evidence was archived
  before replacement; no-clobber generation then created the fresh JSON.
- In this proof, an over-escaped direct-registry validator rejected the retained valid response;
  that same response was revalidated without a second view. A fallback verifier initially omitted
  `PROOF_ROOT`; only the verifier was rerun, not MCP. Both recovered phases retained their logs and
  sentinel checks.
- The first focused orchestration overlapped a duplicate picocli run and is not counted; the fresh
  serial 7/7 set above is authoritative. Its first ledger audit expected seven rows and omitted two
  contained pack calls; corrected audit v2 records all nine.
- A lexical `/var` battery launch was rejected by the canonical-path identity guard before it wrote
  a battery log or called npm; the `/private/var` launch above is authoritative.
- The first current battery used `git archive` at the live-proof commit and completed 43/46: smoke,
  SpatialUI adoption, and distribution adoption failed. The latter two diagnosed a stale expected
  source hash and the archive's missing `.git`; retained log SHA-256 is
  `e65717cbc819332776a3d04f7361aea13e1c4925e6590a8dc6f8a5d658734358`. The reviewed test-only hash
  correction and true linked worktree produced the final 45/46 evidence above.
- Corrective harness setup retained pre-run stops for a wrong `BUILD_MATRIX` canary, initial
  rejection of the explicitly approved `node_modules` symlink, and a reserved zsh variable. None
  launched the battery or made a registry call. During post-battery cleanup, absent
  `/usr/bin/unlink` deleted nothing; `/bin/unlink` then removed the exact symlink before clean
  worktree removal.

These disclosures are why the claims here stay bounded to the final measured phases rather than the
whole programme/session.

## Explicitly not verified

- `pico-cli setup`, `doctor`, `plugin doctor`, `update --check`, perf runtime behind setup, and
  hidden/setup-gated help descendants;
- emulator runtime/lifecycle, device behavior, Swan runtime, native-Windows managed resolution,
  Linux CI, Windows emulator probe, picocli-compat CI, or future continuous latestness;
- rendered-frame LOOK, visual correctness, emulator performance setup, or any visual evidence tier;
- independent publisher identity beyond npm's reported integrity, tamper-proof operation, syscall
  tracing, unrelated internal network behavior, or unrelated real-home ledgers.

No real/live `record_verification` call or ledger entry was made for this CLI proof. The isolated
synthetic fixture battery did exercise `record_verification` calls against temporary test ledgers;
those calls are gate coverage, not evidence about the live registry, CLI, app, or host. No real
setup, emulator lifecycle/control, device mutation, Swan runtime, rendered capture, publish, push,
or remote visibility/permission change occurred. Read-only smoke/native host observations are
disclosed above.
