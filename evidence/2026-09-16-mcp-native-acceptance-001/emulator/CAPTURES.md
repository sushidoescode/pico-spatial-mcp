# Emulator capture provenance — every image in this directory, and what produced it

Derived views (`*.look.png`, `*crop3x.png`) are never evidence on their own: each one names the
full-resolution capture it was made from, and that capture's sha256 is the one bound in the ledger.

| File | sha256 | Derived from | How | Admitted by |
|---|---|---|---|---|
| `emulator-launch-001.png` | `d17a4a90…7078e` | — (original) | `verify_pico_apk` → `adb -s emulator-5554 exec-out screencap -p`, 2160×2158 guest display | **no gate** — taken at install/launch time, before the first admission attempt |
| `emulator-launch-001.look.png` | `bcf482b5…cc2f50` | `emulator-launch-001.png` | `sips -Z 1400` | as above |
| `gate-003-admitted.png` | `a236c1d5…bee02` | — (original) | `run_gate_v1.py polishlab-gate-003 --capture` → `screencapture -o -x -l<windowId>`, 1962×2018 host window | **render-liveness/1.0.0, 17/17** |
| `gate-003-admitted.look.png` | `e111391c…d08ca` | `gate-003-admitted.png` | `sips -Z 1400` | same gate |
| `gate-003-button-crop3x.png` | `e8ffbb17…3e2fca` | `gate-003-admitted.png` | `magick -crop 500x260+750+700 -filter point -resize 300%` | same gate |
| `hovergate-001-admitted.png` | `64e8a9fa…78c2fd` | — (original) | `run_gate_v1.py polishlab-hovergate-001 --capture`, taken after the hover | **render-liveness/1.0.0, 17/17** |
| `hover-button-crop3x.png` | `d6ddcbf6…9ad05` | `hovergate-001-admitted.png` | same crop geometry as above | same gate |
| `postclick-001-admitted.png` | `124ccab5…caf38` | — (original) | `run_gate_v1.py polishlab-postclick-001 --capture`, taken after the one click | **render-liveness/1.0.0, 17/17** |
| `postclick-full.look.png` | `3aa82818…f3a24` | `postclick-001-admitted.png` | `sips -Z 1400` | same gate |
| `postclick-button-crop3x.png` | `59347dbe…b0158` | `postclick-001-admitted.png` | same crop geometry | same gate |

The three `*-admitted.png` files are byte-identical copies of the gate tool's own immutable
receipts `polishlab-gate-003.png`, `polishlab-hovergate-001.png` and `polishlab-postclick-001.png`
under `../tooling/render-liveness-1.0.0/package-targeted-tooling-001/`, where each sits beside its
`*.gate.json` verdict and its raw 20-second log.

**`emulator-launch-001.png` is the one capture in this set that did not ride inside a passing
gate**, because it is the frame `verify_pico_apk` returns at install/launch time — before any gate
could run, since the gate requires the target to be installed and running. It is retained and was
looked at, and what it shows (the window renders, state "untouched (0 taps)") is corroborated by
the gate-admitted frames that follow. No claim in the checkpoint rests on it alone.

Crop geometry, for reproduction: origin (750,700), size 500×260, nearest-neighbour ×3, against a
1962×2018 frame whose window bounds were X=0 Y=33 W=981 H=1009 — so a crop pixel (cx,cy) maps to
frame pixel (750+cx/3, 700+cy/3) and to the global screen point (framepx/2, 33+framepy/2).
