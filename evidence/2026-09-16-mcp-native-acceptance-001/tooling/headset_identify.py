#!/usr/bin/env python3
"""Read-only physical-headset identification. Installs nothing, launches nothing, writes nothing to
the device. Refuses to name a target unless exactly one attached device is a non-emulator.

    python3 headset_identify.py [--out receipt.json]

Exit 0 = exactly one physical candidate, identity printed. Exit 3 = none attached.
Exit 4 = more than one candidate (the human must disambiguate; this tool never guesses).
"""
import argparse, json, subprocess, sys

PROPS = [
    "ro.product.model", "ro.product.manufacturer", "ro.product.brand", "ro.product.name",
    "ro.product.device", "ro.build.fingerprint", "ro.build.display.id", "ro.build.id",
    "ro.build.version.release", "ro.build.version.sdk", "ro.product.cpu.abilist",
    "ro.product.cpu.abi", "ro.boot.qemu", "ro.kernel.qemu", "ro.serialno",
    "ro.build.characteristics", "persist.pxr.device.type", "ro.pxr.device.name",
    "ro.pxr.sdk.version", "ro.pxr.os.version", "ro.build.version.incremental",
]

def sh(serial, *args, timeout=30):
    r = subprocess.run(["adb", "-s", serial, *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    a = ap.parse_args()
    listed = subprocess.run(["adb", "devices", "-l"], capture_output=True, text=True, timeout=30)
    rows = []
    for line in listed.stdout.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        rows.append({"serial": parts[0], "state": parts[1] if len(parts) > 1 else "?", "raw": line})
    report = {"adbDevicesRaw": listed.stdout, "devices": rows, "candidates": [], "target": None}

    online = [d for d in rows if d["state"] == "device"]
    unauthorized = [d for d in rows if d["state"] in ("unauthorized", "offline")]
    report["unauthorized"] = unauthorized

    for d in online:
        code, out, _ = sh(d["serial"], "shell", "getprop")
        props = {}
        for l in out.splitlines():
            if l.startswith("[") and "]: [" in l:
                k, v = l[1:].split("]: [", 1)
                props[k] = v.rstrip("]")
        ident = {k: props.get(k, "") for k in PROPS}
        ident["_allPxrProps"] = {k: v for k, v in props.items() if k.startswith(("ro.pxr", "persist.pxr.device", "ro.pico"))}
        emu_markers = []
        if props.get("ro.boot.qemu") == "1":
            emu_markers.append("ro.boot.qemu=1")
        if props.get("ro.kernel.qemu") == "1":
            emu_markers.append("ro.kernel.qemu=1")
        for k in ("ro.product.model", "ro.build.fingerprint", "ro.product.device"):
            if "emulator" in props.get(k, "").lower() or "qemu" in props.get(k, "").lower():
                emu_markers.append(f"{k} contains emulator/qemu")
        if d["serial"].startswith("emulator-"):
            emu_markers.append("serial has the emulator- prefix")
        entry = {"serial": d["serial"], "identity": ident, "emulatorMarkers": emu_markers,
                 "isPhysicalCandidate": not emu_markers}
        report["candidates"].append(entry)

    physical = [c for c in report["candidates"] if c["isPhysicalCandidate"]]
    if len(physical) == 1:
        report["target"] = physical[0]
        report["verdict"] = f"exactly one physical candidate: {physical[0]['serial']}"
        code = 0
    elif not physical:
        report["verdict"] = ("no physical device attached — every online device carries emulator markers. "
                             "Connect the headset over USB, enable developer mode + USB debugging on it, "
                             "and accept the 'Allow USB debugging' prompt inside the headset.")
        code = 3
    else:
        report["verdict"] = ("MORE THAN ONE physical candidate: " + ", ".join(c["serial"] for c in physical)
                             + ". Refusing to choose; name the serial explicitly.")
        code = 4
    if a.out:
        with open(a.out, "w") as f:
            json.dump(report, f, indent=2)
    print(json.dumps({"verdict": report["verdict"],
                      "online": [d["serial"] for d in online],
                      "unauthorized": [d["serial"] for d in unauthorized],
                      "target": report["target"]["serial"] if report["target"] else None,
                      "targetIdentity": report["target"]["identity"] if report["target"] else None},
                     indent=2, default=str))
    return code

if __name__ == "__main__":
    sys.exit(main())
