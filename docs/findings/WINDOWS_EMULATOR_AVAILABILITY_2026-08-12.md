# Windows emulator availability — 2026-08-12

## Evidence boundary

- GitHub Actions run: [windows-emulator-probe run 31634981984](https://github.com/sushidoescode/pico-spatial-mcp/actions/runs/31634981984), attempt 1, completed successfully.
- Probed commit: `a2048f8a8502547a35c0f48b5b697ac98e699491`.
- Runner: `Windows`, image `win25-vs2026`, image version `20260803.193.1`, architecture `X64`, Node `v22.23.2`.
- CLI: the npm `latest` observed by this run on 2026-08-12 and the installed version were
  `@picoxr/pico-cli@0.4.2`; runtime identification `pico-cli/0.4.2 (public) win32-x64 node-v22.23.2`.
- Raw artifact: `windows-emulator-probe/windows-emulator-probe.json`, SHA-256 `8506753cbb1c5203ccabc6eac82aaa6b1c5ad61b7ba0bcfc429b6ee6708061e8`.
- The workflow installed the CLI package, not an emulator payload. Its only emulator-install invocation ended in `--help`.

Evidence class: structural/source only. The Windows/x64 emulator is source-advertised and
operationally unmeasured in this repository: no emulator was installed or booted, and no frame was
rendered or looked at.

The workflow evidence is only the bounded JSON artifact above. A separate read-only source inspection
at `2026-08-12T19:59:17Z` found that PICO's official [Windows setup guide](https://developer.picoxr.com/document/spatial-sdk/set-up-development-environment/)
specifies Windows 10/11 64-bit and directs developers to select Spatial Editor and PICO Emulator
under PICO OS 6 v6.0. PICO's [PICO OS 6 page](https://developer.picoxr.com/pico-os-6/) says the
emulator can test apps on a PC or Mac, and the [Spatial resources page](https://developer.picoxr.com/resources/?platform=spatial)
scopes the new emulator to Project Swan (PICO OS 6).

The same source inspection confirmed npm package `0.4.2`, published
`2026-08-08T04:23:43.444Z`, with integrity
`sha512-qapgwB+OljD0qQukilhaAmhIemuoIvMO/dkQOVDcZEhLdW1KxpbpkNyLII9hJ6m5F/QYF4UZoPpkjH9IL5U7mA==`.
Its shipped code maps Node `win32` to `windows` and `x64` to `x64` for emulator artifact selection.
A read-only fetch of its official [global settings endpoint](https://setting-global-api.picovr.com/service/settings/v3/?app=1&aid=13&caller_name=spatial_plugin)
returned a `sdk_config_beta` PICO Emulator 6.0.0 entry for `windows`/`x64`, archive
`pico_emulator_20260724_v6.0.0_win.zip`, size `4714031831`, SHA-1
`2b7531668e210228f8bad203bb009400d5be64df`. This establishes source-advertised existence only.
No archive was downloaded, installed, or executed, and no install root, AVD home, discovery path,
binary, flags, lifecycle, gRPC behavior, capture, or pixel behavior was measured.

## Commands and observations

Every recorded command completed without a timeout, spawn error, or output truncation. The raw
artifact retains the full bounded stdout/stderr; only short diagnostics are quoted here.

| Non-install observation                                | Bound/result | Observed diagnostic                                                                                                                                                 |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm view @picoxr/pico-cli version --json`             | 30 s; exit 0 | At the time of this 2026-08-12 run, npm `latest` returned `0.4.2`.                                                                                                   |
| `pico-cli -v`                                          | 30 s; exit 0 | `pico-cli/0.4.2 (public) win32-x64 node-v22.23.2`                                                                                                                   |
| `pico-cli emulator install --source auto --yes --help` | 30 s; exit 0 | Generic usage exposed version, source, config-URL, artifact-URL, checksum, and confirmation options; it named no host-specific bundle and denied no Windows bundle. |
| `pico-cli emulator status --format json`               | 30 s; exit 0 | `PARTIAL`: no running emulator process or online adb target; `processRunning=false`, `adbOnline=false`, and zero candidates.                                        |

The workflow's separate `npm install -g @picoxr/pico-cli@latest --no-audit --no-fund` step was
bounded to 120 seconds and exited 0. It installed 142 npm packages solely to make the official CLI
command available for the observations above.

## Answer

`source-advertised, operationally unmeasured` — on the observed Windows runner with `pico-cli`
0.4.2, the tested official CLI help/status channel neither identified a Windows-specific obtainable
emulator payload nor denied one. The official documentation and current package/configuration
sources separately advertise a Windows/x64 PICO OS 6 emulator bundle, but source inspection cannot
upgrade the workflow result or substitute for installing and running that bundle on Windows.

## Consequence for this lane

Do not write Windows install-root, AVD-home, discovery-directory, executable-name, flag, process,
or lifecycle assumptions from this evidence. The lane stops at source-advertised existence until an
upstream owner confirms the supported Windows delivery path and a real Windows machine installs and
boots the bundle so those values can be measured. Visual claims require a captured frame that a
person or vision-capable agent actually inspects.

## Upstream escalation

Private issue [#1: Windows emulator bundle availability: upstream confirmation needed](https://github.com/sushidoescode/pico-spatial-mcp/issues/1)
was opened against this private repository for authoritative confirmation. It asks @mattbelland for
the supported Windows PICO OS 6 bundle delivery/install path and @rikturnbull whether the Windows
Spatial plugin lists, installs, or launches an emulator payload; it explicitly requests no permission
or repository-visibility change. Upstream and real-Windows-machine confirmation remain pending.
