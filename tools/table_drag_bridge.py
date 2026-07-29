#!/usr/bin/env python3
"""
table_drag_bridge — DRAG THE TABLE WITH YOUR MOUSE, and it anchors to the floor when you drop it.

Why a host-side bridge at all: the PICO emulator gives no controller/gaze pointer (C3), a 2D
`adb input tap` does NOT reach spatially-composited content, and an app's own hit-test needs a ray
we cannot get. So — exactly like tools/mouse_menu_bridge.py — we watch the REAL mouse with a
listen-only Quartz event tap and translate drags into the app's DEBUG_CMD channel:

    OPTION+left-drag -> table:move:dx,dz   (streamed, coalesced)
    release    -> table:reseat       (y re-derived from the detected FLOOR plane = "anchors on drop")
    OPTION+scroll    -> table:move:0,dz    (push away / pull nearer)
    bare drag / right-drag -> UNTOUCHED: the shell keeps panel moving, clicks, camera orbit

Two rules learned the hard way in this repo, both preserved here:
  * NEVER run a blocking `adb broadcast` inside the event-tap callback — a fast drag backlogs and
    the object keeps drifting after the mouse stops. The callback only ACCUMULATES; a daemon thread
    drains one send at a time, summing whatever queued while a send was in flight.
  * The tap is LISTEN-ONLY (kCGEventTapOptionListenOnly) so the emulator keeps full mouse control.

Usage:  python3 tools/table_drag_bridge.py live      [BRIDGE_PKG=com.picoagent.mrtable]
Requires macOS Input Monitoring for the controlling process (same grant the menu bridge uses).
"""
import os
import subprocess
import sys
import threading
import time

import Quartz

ADB = os.environ.get(
    "PICO_ADB",
    os.path.expanduser("~/Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb"),
)
SERIAL = os.environ.get("PICO_SERIAL", "emulator-5554")
PKG = os.environ.get("BRIDGE_PKG", "com.picoagent.mrtable")

# Metres of world movement per pixel of drag. Tuned so a full drag across the emulator window moves
# the table roughly the width of the room; override with TABLE_DRAG_SENS.
SENS = float(os.environ.get("TABLE_DRAG_SENS", "0.0055"))

# OPTION-drag by default. Bare-drag was tried first and is genuinely dangerous here: every drag of
# the MARKET DESK panel ALSO slid the table (one gesture reaches both the shell and this tap), and
# the error accumulated until the table sat 36 METRES away, invisible. Set TABLE_DRAG_MODIFIER=none
# for bare-drag if no panel is open. The app also clamps the table to the detected floor now, so
# this can no longer lose it.
REQUIRE_ALT = os.environ.get("TABLE_DRAG_MODIFIER", "alt").lower() in ("alt", "option")


def adb(*args):
    return subprocess.run([ADB, "-s", SERIAL, *args], capture_output=True, text=True).stdout


def broadcast(cmd):
    adb("shell", "am", "broadcast", "-a", f"{PKG}.DEBUG_CMD", "--es", "cmd", cmd)


def find_window():
    """Bounds of the emulator window, so drags outside it are ignored."""
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    best = None
    for w in wins:
        owner = (w.get("kCGWindowOwnerName") or "").lower()
        if "qemu" not in owner and "crosvm" not in owner:
            continue
        b = w["kCGWindowBounds"]
        # LARGEST qemu window: the process also owns small toolbar/status windows, and grabbing a
        # 266x44 strip instead of the 902x930 viewport makes every drag land "outside" (hit once).
        if b["Width"] < 400 or b["Height"] < 400:
            continue
        area = b["Width"] * b["Height"]
        if best is None or area > best[0]:
            best = (area, {"x": b["X"], "y": b["Y"], "w": b["Width"], "h": b["Height"]})
    return best[1] if best else None


def inside(win, loc):
    return win and win["x"] <= loc.x <= win["x"] + win["w"] and win["y"] <= loc.y <= win["y"] + win["h"]


def main():
    win = find_window()
    if not win:
        print("no emulator window found — is the PICO emulator running?")
        return 1
    print(f"table drag bridge LIVE  pkg={PKG}  window={win}")
    gate = "OPTION + LEFT-DRAG" if REQUIRE_ALT else "LEFT-DRAG"
    print(f"  -> {gate} inside the emulator to slide the table; release to anchor it to the floor.")
    print("  -> SCROLL over the emulator to push it away / pull it nearer.")
    if not REQUIRE_ALT:
        print("  -> NOTE: dragging the MARKET DESK panel also slides the table.")
        print("     Run with TABLE_DRAG_MODIFIER=alt to require Option and free bare drags for the panel.")
    print("  -> Ctrl-C to stop.")

    move = {"dx": 0.0, "dz": 0.0, "drop": False}
    lock = threading.Lock()
    stop = threading.Event()

    def sender():
        """Drain accumulated motion one broadcast at a time; send the anchor AFTER motion settles."""
        while not stop.is_set():
            with lock:
                dx, dz, drop = move["dx"], move["dz"], move["drop"]
                move["dx"], move["dz"] = 0.0, 0.0
                if dx == 0.0 and dz == 0.0 and drop:
                    move["drop"] = False
            if dx or dz:
                broadcast(f"table:move:{dx:.4f},{dz:.4f}")
            elif drop:
                broadcast("table:reseat")
                print("  dropped -> anchored to the detected floor")
            else:
                stop.wait(0.012)

    threading.Thread(target=sender, daemon=True).start()

    drag = {"on": False, "last": (0.0, 0.0)}
    winCache = {"w": win, "t": time.time()}

    def cb(proxy, etype, event, refcon):
        try:
            if etype in (Quartz.kCGEventTapDisabledByTimeout, Quartz.kCGEventTapDisabledByUserInput):
                Quartz.CGEventTapEnable(tap, True)
                return event
            loc = Quartz.CGEventGetLocation(event)
            now = time.time()
            if now - winCache["t"] > 1.0:
                winCache["w"], winCache["t"] = find_window(), now
            w = winCache["w"]
            # OPTION-drag only. A bare left-drag must stay with the shell: that is how the user
            # moves the MARKET DESK panel by its caption bar and interacts with panel buttons. Without
            # this gate, dragging the panel also slid the table — two things moving from one gesture.
            modOk = (not REQUIRE_ALT) or bool(Quartz.CGEventGetFlags(event) & Quartz.kCGEventFlagMaskAlternate)
            if etype == Quartz.kCGEventLeftMouseDown and inside(w, loc) and modOk:
                drag["on"] = True
                drag["last"] = (loc.x, loc.y)
                print("  grabbed the table — slide it")
            elif etype == Quartz.kCGEventLeftMouseDragged and drag["on"]:
                lx, ly = drag["last"]
                drag["last"] = (loc.x, loc.y)
                # screen right -> world +X ; screen DOWN -> world +Z (toward the user)
                with lock:
                    move["dx"] += (loc.x - lx) * SENS
                    move["dz"] += (loc.y - ly) * SENS
            elif etype == Quartz.kCGEventLeftMouseUp and drag["on"]:
                drag["on"] = False
                with lock:
                    move["drop"] = True
            elif etype == Quartz.kCGEventScrollWheel and inside(w, loc) and modOk:
                d = Quartz.CGEventGetIntegerValueField(event, Quartz.kCGScrollWheelEventDeltaAxis1)
                if d:
                    with lock:
                        move["dz"] += -d * 0.04
                        move["drop"] = True
        except Exception as e:  # never let a callback exception kill the tap
            print("cb error:", e)
        return event

    mask = (
        Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDown)
        | Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDragged)
        | Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseUp)
        | Quartz.CGEventMaskBit(Quartz.kCGEventScrollWheel)
    )
    tap = Quartz.CGEventTapCreate(
        Quartz.kCGSessionEventTap,
        Quartz.kCGHeadInsertEventTap,
        Quartz.kCGEventTapOptionListenOnly,  # listen-only: the emulator keeps full mouse control
        mask,
        cb,
        None,
    )
    if not tap:
        print("could not create the event tap — grant Input Monitoring to this process")
        return 2
    src = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
    Quartz.CFRunLoopAddSource(Quartz.CFRunLoopGetCurrent(), src, Quartz.kCFRunLoopCommonModes)
    Quartz.CGEventTapEnable(tap, True)
    try:
        Quartz.CFRunLoopRun()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "live":
        sys.exit(main())
    print(__doc__)
