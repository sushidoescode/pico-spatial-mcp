# Managed pico-cli latest scratch proof — 2026-08-14

Evidence class: `structural`. This finding records bounded registry, filesystem, version, and
help-byte observations. It does not claim a rendered-frame LOOK, emulator/device behavior, or
semantic compatibility beyond the commands actually invoked.

## Result

Under the explicit `PICO_MCP_CLI_POLICY=managed-latest` policy, a first-use MCP call installed
registry-observed `@picoxr/pico-cli@0.4.2` into an isolated managed home and returned its absolute
shim. A fresh MCP process with a controlled registry-view failure then returned the same validated
cache with `freshness:"unknown"`, `latestVersion:null`, and a `latest-unknown` warning. The ambient
global `pico-cli` remained the separately installed 0.3.0 according to three matching narrow
snapshots.

This is a dated observation, not a continuous-latest claim. It proves the explicit managed-latest
path. The unset-policy default is covered by the distribution/tarball gates, not by this live call.

## Source and host

- Live MCP proof began at clean commit `6676ef1c3239b10006f3a2e331ee368ebcf62de4` after a fresh
  `npm run build`. The real sweep exposed two generator defects; the independently reviewed fix is
  commit `802060a77befafdefc70ada82decfacf96dc2b68`, which is the source used for the final sweep and
  verification.
- Host: macOS 26.5 (25F71), Darwin 25.5.0, arm64.
- Node: `/usr/local/bin/node`, `v22.14.0`. npm: `/usr/local/bin/npm`, `10.9.2`.
- Retained managed proof root:
  `/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-managed-proof.sxTL0x`.
- Every live phase used `env -i` with dedicated `HOME`, `USERPROFILE`, cwd, `TMPDIR`, npm
  cache/prefix/user/global config, and XDG config/cache/data; a scratch-only npm proxy logged argv.
  The public registry was fixed to `https://registry.npmjs.org/`. No auth, token, or proxy variable
  was inherited. `pico-cli` was absent from the restricted `PATH`.
- Every phase wrapper contained a failing absence check for the real-home sentinel
  `/Users/sushantsrikrish/.pico-mcp/cli`; those checks were not written as separate timestamped
  artifacts. The final `lstat` check remains absent. No `update-check.json` exists in the retained
  proof roots.

The essential live argv, with `$PROOF_ROOT` equal to the retained path above, was:

```bash
PROOF_ROOT=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-managed-proof.sxTL0x
cd "$PROOF_ROOT/cwd"
env -i HOME="$PROOF_ROOT/home" USERPROFILE="$PROOF_ROOT/home" \
  TMPDIR="$PROOF_ROOT/tmp" \
  XDG_CONFIG_HOME="$PROOF_ROOT/xdg-config" \
  XDG_CACHE_HOME="$PROOF_ROOT/xdg-cache" \
  XDG_DATA_HOME="$PROOF_ROOT/xdg-data" \
  PATH="$PROOF_ROOT/bin:/usr/bin:/bin" LANG=C.UTF-8 \
  NPM_CONFIG_CACHE="$PROOF_ROOT/npm-cache" \
  NPM_CONFIG_PREFIX="$PROOF_ROOT/npm-prefix" \
  NPM_CONFIG_USERCONFIG="$PROOF_ROOT/home/.npmrc" \
  NPM_CONFIG_GLOBALCONFIG="$PROOF_ROOT/global.npmrc" \
  NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
  npm_config_cache="$PROOF_ROOT/npm-cache" \
  npm_config_prefix="$PROOF_ROOT/npm-prefix" \
  npm_config_userconfig="$PROOF_ROOT/home/.npmrc" \
  npm_config_globalconfig="$PROOF_ROOT/global.npmrc" \
  npm_config_registry=https://registry.npmjs.org/ \
  PROOF_REAL_NPM=/usr/local/bin/npm \
  PROOF_NPM_LOG="$PROOF_ROOT/npm-argv.jsonl" \
  npm view @picoxr/pico-cli@latest version dist.integrity --json

# From $PROOF_ROOT/cwd, a fresh stdio client started the exact built server and
# called only ensure_pico_cli {}. call-ensure.mjs explicitly supplied
# PICO_MCP_SURFACE=doors and PICO_MCP_CLI_POLICY=managed-latest to the child.
cd "$PROOF_ROOT/cwd"
env -i HOME="$PROOF_ROOT/home" USERPROFILE="$PROOF_ROOT/home" \
  TMPDIR="$PROOF_ROOT/tmp" \
  XDG_CONFIG_HOME="$PROOF_ROOT/xdg-config" \
  XDG_CACHE_HOME="$PROOF_ROOT/xdg-cache" \
  XDG_DATA_HOME="$PROOF_ROOT/xdg-data" \
  PATH="$PROOF_ROOT/bin:/usr/bin:/bin" LANG=C.UTF-8 \
  NPM_CONFIG_CACHE="$PROOF_ROOT/npm-cache" \
  NPM_CONFIG_PREFIX="$PROOF_ROOT/npm-prefix" \
  NPM_CONFIG_USERCONFIG="$PROOF_ROOT/home/.npmrc" \
  NPM_CONFIG_GLOBALCONFIG="$PROOF_ROOT/global.npmrc" \
  NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
  npm_config_cache="$PROOF_ROOT/npm-cache" \
  npm_config_prefix="$PROOF_ROOT/npm-prefix" \
  npm_config_userconfig="$PROOF_ROOT/home/.npmrc" \
  npm_config_globalconfig="$PROOF_ROOT/global.npmrc" \
  npm_config_registry=https://registry.npmjs.org/ \
  PROOF_ROOT="$PROOF_ROOT" PROOF_REAL_NPM=/usr/local/bin/npm \
  PROOF_NPM_LOG="$PROOF_ROOT/npm-argv.jsonl" \
  PROOF_ENSURE_OUTPUT="$PROOF_ROOT/evidence/ensure-online.json" \
  PROOF_SERVER_ENTRY=/Users/sushantsrikrish/PICO-MCP/.worktrees/pico-evolution-2026-08-14/dist/index.js \
  PROOF_CWD=/Users/sushantsrikrish/PICO-MCP/.worktrees/pico-evolution-2026-08-14 \
  "$PROOF_ROOT/bin/node" "$PROOF_ROOT/call-ensure.mjs"

# The fresh fallback call repeated the complete env -i command immediately above,
# inserted PROOF_NPM_FAIL=1, and changed only this output assignment:
# PROOF_ENSURE_OUTPUT="$PROOF_ROOT/evidence/ensure-fallback.json"
```

## Registry and managed publication

The direct registry observation was logged at `2026-08-14T13:47:19.204Z`; the broader direct+MCP
bracket was `2026-08-14T13:47:18Z` through `2026-08-14T13:47:29Z`:

```json
{
  "version": "0.4.2",
  "dist.integrity": "sha512-qapgwB+OljD0qQukilhaAmhIemuoIvMO/dkQOVDcZEhLdW1KxpbpkNyLII9hJ6m5F/QYF4UZoPpkjH9IL5U7mA=="
}
```

The MCP process made its own registry observation (logged separately at
`2026-08-14T13:47:20.411Z`) and returned:

- `status:"ok"`, `source:"managed"`, `policy:"managed-latest"`, `action:"installed"`;
- `version:"0.4.2"`, `latestVersion:"0.4.2"`, `freshness:"latest"`;
- `checkedAt:"2026-08-14T13:47:20.382Z"`, inside the MCP proof bracket;
- path
  `/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-managed-proof.sxTL0x/home/.pico-mcp/cli/versions/0.4.2/node_modules/.bin/pico-cli`.

The returned path was component-checked beneath the managed version root, and its resolved target
was contained there. The installed package name/version, `install.json`, registry integrity, and
directory version all agreed. Client `PATH` was unchanged across the call.

`publication.json` and `.0.4.2.publish` contained the same 292 bytes and were the same hard link
(`dev=16777231`, `ino=51436151`). Their token was
`9420bcfd-b6e1-46cd-9d13-2da7f627ee7b`; version, integrity, and
`createdAt:"2026-08-14T13:47:20.382Z"` matched the install record. This establishes local
publication provenance and the registry-reported integrity, not the publisher's identity.

The online npm ledger contained only: one direct exact `view`, one MCP exact `view`, and one exact
non-global staged-prefix install of `@picoxr/pico-cli@0.4.2`. No `-g`, `--global`, `setup`, or
`update --check` appeared.

## Bounded version and help canaries

The returned absolute shim reported
`pico-cli/0.4.2 (public) darwin-arm64 node-v22.14.0`; the `stdout + stderr` SHA-256 was
`267eac5634d3e971781cfaa5cb2ec29751cfa932f7803dfadb489ea624956f3b`. Root `--help` exited 0
without timeout/truncation and hashed to
`c78b513f95bd5ad1e1b3bb0867265d7d9743b81a7b6d6a27a5ae92c268cf5941`.

The nine independently re-run help-only canaries exactly matched `compatibility.json`:

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

All nine were bounded, not truncated, and ended in `--help`. The five perf exits are diagnostics
from the setup gate; no perf runtime behind that gate was exercised.

## Controlled registry failure

A fresh MCP process made exactly one failed registry `view` and no install. It returned the same
absolute path/version with `action:"cached"`, `latestVersion:null`, `freshness:"unknown"`, and
`warning.failureClass:"latest-unknown"`; the warning tail contained
`TASK7_CONTROLLED_REGISTRY_FAILURE`. The complete managed version tree was unchanged before/after:
4,877 manifest rows and SHA-256
`6873046da5ea1a04ec63838ef29c517435a7dacc15fb62e0645a290ef9ac0aa1`.

This proves honest fallback when latest cannot be established. It does not exercise the separate
known-newer/install-failure branch, which remains hermetic-test evidence.

## Ambient/global 0.3.0 invariant

The absolute ambient command was invoked only with `-v` under an isolated home:

- shim: `/Users/sushantsrikrish/.nvm/versions/node/v25.8.1/bin/pico-cli`;
- link target: `../lib/node_modules/@picoxr/pico-cli/dist/index.js`;
- real file:
  `/Users/sushantsrikrish/.nvm/versions/node/v25.8.1/lib/node_modules/@picoxr/pico-cli/dist/index.js`;
- output: `pico-cli/0.3.0 (public) darwin-arm64 node-v22.14.0`;
- real-file SHA-256:
  `8e561da9f4fd55686474d275316d1a2f8db06b1730995ce2ee26da9f13ad90a2`;
- deterministic, non-following package manifest: 4,450 rows, SHA-256
  `0fc5b689ff82747ee6efa4c01de3cce1c1422f35f31ab53a1c8047be3a3f12d9`.

Before, post-live-proof, and final snapshots matched for shim lstat/mode/size/link target, real path
mode/size/hash, bounded `-v`, and deterministic package manifest. This is a narrow invariant claim,
not syscall tracing or a claim about unrelated global state.

## Complete reachable help sweep

The final separate observation ran:

```bash
node scripts/compare-picocli-surfaces.mjs \
  --from 0.4.2 \
  --to latest \
  --output "$(pwd)/docs/findings/picocli-managed-latest-surface-2026-08-14.json"
```

The no-clobber report was generated at `2026-08-14T14:13:30.745Z`, inside its own
`2026-08-14T14:12:52.990Z`–`2026-08-14T14:13:31.549Z` window. Its SHA-256 is
`feb92f5b44b243dc5f2322f9867ba0d5175880316203eed4375f6edaf03f9324`.
The sweep independently resolved latest to 0.4.2, installed exact 0.4.2 twice into separate
non-global prefixes, and measured 69 advertised help paths on both sides: 69 unchanged, zero added,
removed, or help-byte-changed. The safety booleans report what the script's central argv guard
allowed; they are not syscall tracing. Hidden/setup-gated descendants remain outside this result.

The first real sweep exposed npm-stderr JSON parsing and multi-token help-row defects. The failed
attempts wrote no report; their isolated ledgers were retained. The TDD fix in `802060a` was
independently reviewed before the successful fresh sweep.

## Verification

Focused Node 22/macOS verification passed all ten invocations:

```text
npm run build
npm run test:picocli
npm run test:preflight
npm run test:doors
npm run test:distribution-adoption
npm run test:docsmeta
npm run test:lint
node scripts/sync-metadata.mjs --check
npm run test:claims
git diff --check
```

Package verification ran from a fresh retained exact source copy so `prepack-clean` could not touch
the real worktree's ignored bytecode:

```text
npm run build                                      PASS
npm pack --ignore-scripts --dry-run --json         PASS (269 entries)
npm run test:tarball                               PASS
git diff --check                                   PASS
```

The tarball was 1,518 kB, installed with `--omit=dev`, listed exactly 249 Darwin full-surface tools,
listed 18 doors tools, and proved the unset surface defaults to those 18 tools. The source
`scripts/py/__pycache__/splat_perspective.cpython-312.pyc` remained byte-identical at SHA-256
`5e7dffcacd86a77c43064507956f4b2026147c8a46724deacd3a927bc7c4d85f`; only the scratch copy was
removed by prepack.

Both native macOS gates passed:

```text
npm run test:vcamtransport-native
npm run test:vcamreader-native
```

They compiled and ran their native contracts. The reader performed read-only authorization and
device-metadata checks; because the fresh executable was already authorized, it skipped the
readback-block assertion to stay device-free. This is not a claim that no host metadata/TCC query
occurred.

The final unchanged complete-battery invocation used this exact retained source, log, and isolated
environment:

```bash
PROOF_ROOT=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-managed-proof.sxTL0x
env -i \
  HOME=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/home \
  USERPROFILE=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/home \
  TMPDIR=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/tmp \
  XDG_CONFIG_HOME=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/xdg-config \
  XDG_CACHE_HOME=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/xdg-cache \
  XDG_DATA_HOME=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/xdg-data \
  PATH="$PROOF_ROOT/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG=C.UTF-8 PICO_HOME=/Users/sushantsrikrish/Library/PICO/sdk \
  PICO_MCP_CLI_POLICY=managed-cached SMOKE_SDK_OPTIONAL=1 \
  NPM_CONFIG_CACHE=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/cache \
  NPM_CONFIG_PREFIX=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/prefix \
  NPM_CONFIG_USERCONFIG=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/home/.npmrc \
  NPM_CONFIG_GLOBALCONFIG=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/global.npmrc \
  NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
  npm_config_cache=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/cache \
  npm_config_prefix=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/prefix \
  npm_config_userconfig=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/home/.npmrc \
  npm_config_globalconfig=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/global.npmrc \
  npm_config_registry=https://registry.npmjs.org/ \
  PROOF_REAL_NPM=/usr/local/bin/npm \
  PROOF_NPM_LOG=/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/npm-argv.jsonl \
  /usr/local/bin/node \
  /private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-package-proof.8P5sLT/source/scripts/run-battery.mjs \
  /private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-package-proof.8P5sLT/source \
  /var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-battery-proof-seeded.pmFcR5/battery.log
```

It completed all 45 invocations with the exact non-green result:

```text
BATTERY FAIL 44/45 passed; 1 failed: smoke [exit 1]
```

`smoke` had exactly one failing section: `scene_schemas (first 1k chars)`, because no
`schema.usda` files exist under
`/Users/sushantsrikrish/Library/PICO/sdk/6.0/editor/spatialbundle/usd`. To keep the battery home
isolated while preserving smoke's existing local fixtures, only the existing claimsight bundle and
complete `SpatialPackContent` were byte-copied into a fresh home. Before the run, source and copy
matched: bundle SHA-256
`6240567c9129f6593a034bebce512ffbe8f3eb80b7bd37ee2985c1777604403c`; SpatialPackContent 53-row
manifest SHA-256
`d703617cc949bfcd24518f150504e20e7626dc6a7bc940ad8ba8895897fee119`. The real source manifest and
bundle were unchanged afterward. The isolated copy gained only pack caches/generated library data.
The plan owner explicitly authorized this seeded, still-isolated corrective run after the strictly
empty-home diagnostic demonstrated that smoke's two local fixture inputs were absent.

The unchanged smoke also called read-only `emulator_list`, which enumerated local ADB/device state.
It observed one physical ADB device and `emulator-5554`. No emulator lifecycle/control or
device-mutating command was run, and that enumeration is not presented as emulator/device
verification.

The earlier strictly empty-home diagnostic also completed 44/45, but smoke then had four failures:
the two absent claimsight inputs caused existing-bundle inspect, pack, and fresh inspect failures,
in addition to `scene_schemas`. That run is retained and is not presented as the final battery.
Neither 44/45 result is called green.

Local macOS cannot earn the Linux/Node 20, Linux/Node 22, or native-Windows CI jobs. Those executions
remain pending because no push was authorized. The local `test:picocli-win` fixture invocation
passed inside the complete battery, but it is not native-Windows evidence. Likewise, local fixture
gates named Swan/emulator do not establish real Swan or emulator execution. The claims/docs gates
passed under an isolated home; that does not validate unrelated real-home ledgers.

## Safety incidents and retained state

- Task 4 previously quarantined a fake fixture publication that reached the real managed root at
  `/tmp/pico-task4-real-home-quarantine.W5mCuK`; the real root was removed and remained absent. The
  quarantine was not modified here.
- Task 5 recorded one early missing-npm fixture case that could resolve ambient npm; registry/cache
  contact during that run cannot be ruled out. Therefore this programme is not described as having
  a contamination-free session, even though the final Task 7 live phases were isolated and audited.
- During final consumer-review remediation at 09:14:05, an independent review scratch probe
  statically imported `KnowledgeBridge` before applying a `createManagedRuntimeHarness()`
  environment. The adapter therefore retained the real home while the later process environment
  supplied the fake npm/CLI fixture. Without an explicit `managedRoot`, that probe published a fake
  cache entry under the real `~/.pico-mcp/cli`. The entry carried fixture registry value
  `sha512-runtime-fixture`, a dead owner PID `64216`, and a shim targeting the subsequently deleted
  `pico managed runtime N6g0Go` fixture driver. This was a real-home write; it was not a network,
  real-npm, real-pico-cli, setup, emulator, or device operation. The exact tree was moved intact to
  `/tmp/pico-integrity-real-home-quarantine.YSiMBi/cli`; the real managed root was confirmed absent
  afterward. This incident means the Task 7/remediation programme is not described as exclusively
  isolated or free of real-home mutation.
- The first Task 7 tarball attempt put its `TMPDIR` below the proof root, whose MCP-client
  `node_modules` link made npm select the proof root as the local project ancestor. It installed the
  tarball inside the proof root and failed the verifier's expected sandbox path. No real worktree or
  global package was installed. That proof-root package.json/lock/directory mutation and its ledger
  remain retained; the successful rerun used a fresh sibling root outside any package ancestor.
- The first empty-home battery and the failed sweep attempts remain retained as diagnostics. No
  evidence file was overwritten.

## Explicitly not verified

- `pico-cli setup`, `doctor`, `plugin doctor`, `update --check`, perf runtime behind setup, and
  hidden/setup-gated help descendants;
- emulator runtime, device behavior, Swan runtime, native-Windows managed resolution, Linux CI, or
  future continuous latestness;
- rendered-frame LOOK, visual correctness, emulator performance setup, or any visual evidence tier;
- publisher identity beyond npm's reported integrity, and unrelated real-home claim ledgers.

No real/live `record_verification` call or ledger entry was made for this CLI proof. The isolated
synthetic fixture battery did exercise `record_verification` calls against temporary test
ledgers; those calls are gate coverage, not evidence about the live registry, CLI, app, or host.
No setup, emulator lifecycle/control, device mutation, Swan runtime, rendered capture, or push
occurred. Read-only smoke/native host enumeration is disclosed above.
