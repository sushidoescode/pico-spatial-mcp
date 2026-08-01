# Swan demo-day pack

Everything a PICO engineer needs on the desk for the first real-Swan session, pre-generated on
2026-08-01 against the live trust ledgers on the build machine. Read this file first, then work
from the two protocol docs it indexes.

## Read these first

- **`../DEVICE_VERIFICATION.md`** — the `device_verified` protocol: what the evidence class means,
  the on-device capture steps (including the screencap-blind-spot warning for immersive apps),
  the exact evidence ask-list to send back, how entries are minted, and the serial-support table
  saying which tools work against a hardware serial today.
- **`../playbooks/os61-bringup.md`** — the OS 6.1 emulator bring-up playbook (snapshot the 6.0
  baseline first; drift report steps).

## The three apps with headset-deferred work

Ledger keys verified against `~/.pico-mcp/ledgers/` on the build machine:

| App | built_for_headset rows in its trust ledger | Checklist features came from |
| --- | --- | --- |
| `com.example.showroomxr` | 1 (`controller-ray select`, C3 — seq 3) | its actual ledger row |
| `com.demo.bowldeck` | none (headset work not yet ledgered) | the generic headset-feature manifest (`generate_headset_readiness_codegen`) |
| `pico-spatial-mcp` | none (headset work not yet ledgered) | the generic headset-feature manifest |

Said honestly: only showroomxr has a real `built_for_headset` ledger row today. The other two
checklists are the generic C1/C3/C4 re-test plan, staged so day one is not blocked on us.

## Files

- `checklist.<app>.md` — the human-readable bring-up checklist (also `checklist.<app>.json`,
  the raw `swan_bring_up_checklist` output).
- `matrix.<app>.pre-fix.json` — raw `swan_verify_matrix` output. **Read the warning below before
  trusting the `status` field.**

## WARNING: the `*.pre-fix.json` matrices contain a live, since-fixed misclassification

These matrix files were generated with the pre-v31 build while a **Meta Quest 3** happened to be
attached to the build machine over USB. That build treated ANY non-`emulator-` adb serial as a
Swan, so every matrix file says:

```
"status": "swan_attached", "swanSerial": "2G0YC5ZF7Z056Q"
```

That serial is the Quest 3 (measured: `ro.product.model` = `Quest 3`, `ro.build.fingerprint` =
`oculus/eureka/eureka:14/...`), **not** PICO hardware — no Swan has ever been attached to this
rig. We staged the outputs unedited because they are the best possible exhibit of why v31 added
the hardware-identity gate: the same call on the fixed build returns `unrecognized_hardware`
with the getprop identity included and demands an explicit `assumeSwan: true` override. The
per-row content (emulator baseline, the exact on-device test, expected device result) is correct
and is what you actually work from; only the attach-status line was wrong.

The rows' `device_pending` statuses in these files are the same artifact — with a real Swan (or
after the fix, with `assumeSwan` asserted for a genuinely-PICO device), `device_pending` is what
you want to see, and each row flips to `device_verified` only via `record_verification` evidence
(see `DEVICE_VERIFICATION.md` Section 4).

## Day-one loop (short form)

1. `adb devices -l` — confirm the Swan's serial and model fields.
2. `swan_verify_matrix { app }` — should say `swan_attached` with the Swan's real identity in
   `deviceIdentity`; if it says `unrecognized_hardware`, read the reason before overriding.
3. `deploy_to_device { apkPath, packageName }` — install/launch/first-frame (screencap caveat:
   a black frame for an immersive app is a capture-path artifact, not failure).
4. Work the app's `checklist.<app>.md`, one row at a time: run the row's `deviceTest`, capture,
   **LOOK**, then `record_verification` with `evidenceType: "device_verified"`, the capture
   path, an attestation, the `deviceSerial`, and the row's `cClass`.
5. Re-run `swan_verify_matrix` — the recorded rows flip to `device_verified` and stay closed.
6. Send back the evidence ask-list per `DEVICE_VERIFICATION.md` Section 3.
