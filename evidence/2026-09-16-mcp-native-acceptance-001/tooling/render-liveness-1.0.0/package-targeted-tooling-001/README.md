# Package-targeted verification tooling (fresh; supersedes the frozen CP15 scripts)

Two apps now build from this source tree — the original `com.picoagent.rocketsim` and the separate
`com.picoagent.missionreplay` — so any tool carrying a hardcoded package can silently address the
wrong install. These are **new** tools in fresh evidence. The frozen CP15 scripts are not edited and
the receipts they already produced stay reproducible.

## The rule these enforce

Every tool requires **`--package`**, **`--device`**, and an expected build (**`--expected-apk`** or
**`--expected-sha256`**). There are no defaults. Before any side effect, the tool proves that the
named package is installed on the named device and that **the bytes actually installed hash to the
expected build**. Anything else is refused before it acts. Broadcast actions are *derived* from
`--package` (`<package>.DEBUG_CMD`), never written as literals, so a command aimed at one install can
never reach the other.

Identity is taken device-side with `/system/bin/sha256sum`, so a check costs no 66 MB pull.
`install_check_v2.py --pull` additionally re-hashes on the host.

## Tools

| Tool | Category | Notes |
| --- | --- | --- |
| `install_check_v2.py` | installation checks | `--pull` also pulls and re-hashes host-side. Read-only. |
| `app_log_capture_v2.py` | logs | Raw unfiltered sample + per-app render metrics. Sends no input. |
| `broadcast_capture_v2.py` | broadcasts | Action derived from `--package`. `--dry-run` prints the argv and sends nothing. |
| `perf_capture_v2.py` | performance collection | Every `pico-cli --app` value is the verified target. `--dry-run` available. |
| `pull_receipts_v2.py` | receipt pulls | `run-as <verified package>`; safe-extraction semantics carried over unchanged. |
| `package_target.py` | shared | Identity resolution, action derivation, immutable-evidence helper. |
| `app_render_metrics.py` | shared | Per-app render/progress measurement from a raw epoch log. |
| `selftest.py` | validation | Host-only: no broadcast, input, perf run or pull. |

Example:

    python3 app_log_capture_v2.py my-sample-001 \
      --package com.picoagent.rocketsim \
      --expected-apk ../host-check-041/apks/app-debug.apk \
      --device emulator-5554 --seconds 20

## Why per-app render metrics exist

Compositor frame rate is a property of the runtime, not of the app: PxrMetric can sit at 60 while
the app is frozen or not even focused. `app_render_metrics.py` reads the spatial runtime's
once-per-second `Watchdog: focus=NN(<package>) lastRenderTime=X, currentTime=Y, checkCount=Z` line,
which is emitted for the **focused** app. `currentTime - lastRenderTime` is how stale that app's
newest frame is; the advance of `lastRenderTime` across the window is direct evidence the app kept
producing frames. Thresholds are deliberately NOT baked in here — this stays measurement, not policy.

## Validation

`SELFTEST.json` — 31/31 host checks. It covers action derivation and disjointness, identity
resolution against the live 041 install, and the refusal paths that matter: a wrong expected build,
the 043 APK against the 041 install, an uninstalled package, a malformed package, every missing
required argument on all five tools, a broadcast refusing *before sending* at the wrong build, and
receipt immutability. The metrics module is validated against a retained real sample plus synthetic
frozen-app and wrong-focus fixtures.

No app rebuild was needed: this milestone changed no application code.
