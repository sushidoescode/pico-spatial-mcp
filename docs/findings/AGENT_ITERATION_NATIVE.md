# Dedicated emulator loop — 2026-10-24 UTC

Root completed **observe → semantic action → independent assertion → capture → source-bound rebuild → replay**, then opened the rendered evidence. The fixture changed visibly from source revision 2 / counter 0 / hidden to counter 1 / visible, and after rebuilding to source revision 3 / counter 1 / visible. This is one dedicated planar fixture on one PICO emulator. It establishes neither simulator parity nor hand/controller input.

The user [confirmed exclusive emulator use and authorized this run](../../evidence/2026-10-24-agent-iteration-native/AUTHORITY.json). The emulator was already running. [Final release](../../evidence/2026-10-24-agent-iteration-native/RELEASE.json) records drained sessions, no remaining target owner, and the emulator/fixture left running with their data and evidence preserved. No installed MCP activation, merge, push or version change occurred. Main and Stage 1 remain separate.

## Exact native identities

| Identity | Value |
| --- | --- |
| Emulator | `emulator-5554`, existing AVD `PICO_6.1`, model `swan_arm64` |
| Boot ID, unchanged throughout | `85f03dc1-bee6-4e4d-a19f-916fbf3ed0b4` |
| Debug package | `com.example.picofixture.iteration.debug` |
| Source revision 2 APK SHA-256 | `24704bdee8d5547b09621d48e073abe33741b94a42627d2f6ed9afe091956e04` |
| Initial process/generation | PID `4296`, start `44574`, generation `971b186f-e529-4bd6-8bab-c3b57f57d015` |
| Source revision 3 APK SHA-256 | `9e311dc104d70a3997832162d6597d45805692f22f729ca869c86bdff45d9a12` |
| Rebuilt process/generation | PID `8478`, start `170913`, generation `659e3ad2-39ed-42cf-bdc8-90a73810de4d` |
| Rebuilt input identity | `4caf221d0df5e87084ec7900bf4514fb3397e4168ac2c90c635d5f4ef6f6e4b7` |
| Successful action nonces | `749487cc-b353-41cc-8614-c83f3144c35d`, then `88ce38ff-1520-433c-918a-41ff60a8d982` |

The [iteration record](../../evidence/agent-iteration-example/a57e7dd3-dbee-4165-80c1-1e0fd45d366b/iteration-55050185-56cb-49a3-8ae6-6000304bdf85.json) binds source, 12,342 continuous resolved build inputs, immutable APK, CLI stop/install/launch, new process/generation, ACK and independent state. The authored APK change was the title in `HomePage.kt`. The build used existing Gradle 8.13, JDK 21 and the isolated dependency cache offline. Its project owner was released. No app data was cleared.

CLI 0.6.1 and MCP used the same existing ADB executable through per-invocation `ADB_PATH` and `PICO_ADB`: `/Users/sushantsrikrish/Library/Android/sdk/platform-tools/adb` (37.0.0). Early operations encountered ADB server connection resets while the CLI selected its bundled 34.0.5 binary. Aligning selection preceded stable execution; the resets' precise cause was not independently proven. No ADB server or emulator restart was issued. Every device operation named the emulator; connected physical devices were never fallback targets.

## What the frames actually showed

| Frame | SHA-256 | Root LOOK |
| --- | --- | --- |
| Initial | `29c8678a1cafac010350fc99eab67487a3fa8b2fde4c828f08e962fc6dc88cad` | Source revision 2, counter 0, hidden |
| Immediate first action | Same as initial | Failed rendered postcondition despite ACK/state success |
| Later first action | `a47573759f44babe72a7af4318413a8ac7f1a9f0966ccdd9b281fda4a62649c7` | Source revision 2, counter 1, visible |
| Immediate rebuilt replay | `3d706f2f3a9a166b498e22b7dafab33ec7911416d4560c11c61570a4a31beee2` | Room only; failed rendered postcondition |
| Later public MCP recapture | `e8ac0261cffa7ba0d101c2785113f617fc7ee5992c4f5f9866a0a24bea5451dc` | Source revision 3, counter 1, visible |

The immediate failures remain in [first-action LOOK](../../evidence/2026-10-24-agent-iteration-native/immediate-look.json) and [replay LOOK](../../evidence/2026-10-24-agent-iteration-native/replay-immediate-look.json). Successful later captures have separate [source-2](../../evidence/2026-10-24-agent-iteration-native/after-delayed-look.json) and [source-3](../../evidence/2026-10-24-agent-iteration-native/replay-look.json) attestations. `record_verification` stored three `vision_verified`, `C0_emulator` entries in a worktree-local ledger, including the initial frame. No `device_verified` hardware claim was made. Binary frames and APKs remain retained locally; the JSON records preserve exact paths and hashes.

`captureSettleMs` is optional, defaults to zero and is capped at 3000 ms. It stays inside the existing deadline and fence, checks cancellation, and revalidates identity/state before capture. The fixture requests 2500 ms. That interval was insufficient for the first frame after this rebuild, so it must not be presented as render readiness. The separate `capture` example uses public `pico_look` between bound observations and sends no action. Image LOOK remains necessary.

## Runtime defect and reconciliation

Android `run-as` refused hard-link publication. `exec-out` reported process exit zero while the remote failure appeared in stdout. The first request became `in_doubt` and retained its owner. It was never resent. The fix uses a persistent exclusive request-claim directory, private staging and guarded `mv -n -T` publication. A failed/interrupted claim remains retired, partial bytes stay outside the app's JSON scan, and bounded raw diagnostics are retained.

The [one-off reconciliation](../../evidence/2026-10-24-agent-iteration-native/reconciliation-proof.json) established two advancing post-deadline heartbeats at revision zero under the exact original source/APK/process/generation, absent request/temp/ACK, and completed owned transport. Root pinned owner and journal bytes/filesystem identity, archived the owner without replacement and synced records before release. [The result](../../evidence/2026-10-24-agent-iteration-native/reconciliation-result.json) retains the retired nonce `04f69643-b23e-4f95-b3f4-87d26b002287`. Original `in_doubt` result and journal remain unchanged. No stale-owner recovery policy or automatic retry was introduced.

## Runnable follow-up and boundaries

From the candidate worktree, this exercised command only captures and validates the currently installed fixture:

```sh
PICO_ADB=/Users/sushantsrikrish/Library/Android/sdk/platform-tools/adb \
ADB_PATH=/Users/sushantsrikrish/Library/Android/sdk/platform-tools/adb \
PICO_MCP_CLI_POLICY=managed-cached \
node scripts/agent-iteration-example.mjs capture \
  --native-authorized --serial emulator-5554 \
  --apk-sha 9e311dc104d70a3997832162d6597d45805692f22f729ca869c86bdff45d9a12
```

Use it only while holding actual emulator authority, and open the returned frame. For another rebuild/replay, edit the fixture source and use the [replay example](AGENT_ITERATION_CANDIDATE.md) with the currently installed hash. Initial-state mismatch refuses a repeated scenario; no implicit reset occurs.

The [artifact manifest](../../evidence/2026-10-24-agent-iteration-native/ARTIFACTS.json) pins the rebuilt server/APK/frames and exact tested replacement tarball; the [validation manifest](../../evidence/2026-10-24-agent-iteration-native/VALIDATION.json) records the final gates. The [capability matrix](AGENT_ITERATION_CANDIDATE.md#capability-matrix) separates implementation, host tests, native execution and rendered review. Multi-cycle watch/cancellation, competing native writers, ordinary-UID/release denial, physical input, other emulators/platforms and interactive Claude/Codex/Gemini behavior remain unverified. The live path did not exercise an official WorkflowRun reference; CLI workflow ownership is unchanged and its reference adapter has host-fixture evidence only. Stage 2 and Mission Replay restrictions remain unchanged.
