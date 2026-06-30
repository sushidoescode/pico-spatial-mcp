#!/usr/bin/env python3
"""
mouse_menu_bridge.py — let a Mac MOUSE select the in-world PICO Spatial game menu on the EMULATOR.

The PICO emulator has no controller/gaze pointer (C3) and a 2D click does not raycast into the
spatial runtime, so there is no native way to click an in-world menu. This host-side bridge closes
that gap: a Quartz event tap watches the real mouse over the emulator window, maps the cursor into
the device framebuffer, detects which of the 4 menu rows it is over, and fires the already-proven
command channel:  adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd <start|pause|resume|reset>
which the app routes to GameMenu.select(action).

Row detection is camera/scale robust: it locates the menu's amber/blue/red button bars in a fresh
screencap and least-squares-fits the 4 equally-spaced rows (so it works wherever the free camera
put the panel, and survives one button being highlighted).

Subcommands:
  detect                 screencap, detect rows, print them + save a debug overlay
  point <sx> <sy>        map one SCREEN point -> row -> broadcast select (for testing / one-off)
  point <sx> <sy> hover  same but send a 'hover' (move highlight only; needs app hover support)
  window                 print the emulator window bounds
  live                   run the live mouse tap (THIS is what the user runs; needs Input Monitoring)
                         LEFT-CLICK a menu button to select it. Set BRIDGE_HOVER=1 to also move the
                         highlight on hover (needs app hover support; off by default).

Env: ANDROID_SERIAL (default emulator-5554), BRIDGE_PKG (skip foreground autodetect),
     BRIDGE_TITLE_H (macOS title-bar height, default 28), BRIDGE_HOVER=1 (enable hover in live).
Requires: a venv with pyobjc-framework-Quartz + Pillow (see setup_bridge_venv.sh), adb on PATH.
"""
import subprocess, sys, time, tempfile, os, statistics as st

ADB = os.environ.get("ADB", "adb")
SERIAL = os.environ.get("ANDROID_SERIAL", "emulator-5554")
FB_W, FB_H = 2160, 2158          # device framebuffer (screencap) size
TITLE_H = int(os.environ.get("BRIDGE_TITLE_H", "28"))  # macOS title bar height (calibratable)
ACTIONS = ("start", "pause", "resume", "reset")


# ---------- adb helpers ----------
def adb(*args, binary=False):
    cmd = [ADB, "-s", SERIAL, *args]
    if binary:
        return subprocess.run(cmd, capture_output=True).stdout
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def screencap(path):
    data = adb("exec-out", "screencap", "-p", binary=True)
    with open(path, "wb") as f:
        f.write(data)
    return path


def foreground_pkg():
    out = adb("shell", "dumpsys", "activity", "activities")
    for line in out.splitlines():
        if "topResumedActivity" in line and "com.example." in line:
            for tok in line.split():
                if tok.startswith("com.example."):
                    return tok.split("/")[0]
    return None


def broadcast(pkg, action, hover=False):
    if hover:
        adb("shell", "am", "broadcast", "-a", f"{pkg}.DEBUG_CMD",
            "--es", "cmd", "hover", "--es", "target", action)
    else:
        adb("shell", "am", "broadcast", "-a", f"{pkg}.DEBUG_CMD", "--es", "cmd", action)


# ---------- menu row detection (framebuffer space) ----------
# Button-bar colors (the AAA texture: green START, amber PAUSE, blue RESUME, red RESET).
_RED   = lambda r, g, b: r > 150 and g < 105 and b < 105 and (r - g) > 70 and (r - b) > 70
_AMBER = lambda r, g, b: r > 195 and 120 <= g <= 210 and b < 110 and (r - b) > 110 and (r - g) > 35
_BLUE  = lambda r, g, b: 90 < g < 200 and b > 150 and (b - r) > 55 and (b - g) > 35 and r < 150
_GREEN = lambda r, g, b: g > 150 and r < 170 and b < 150 and (g - r) > 30 and (g - b) > 45
# The navy panel backing + bright-blue glowing border (used to find the panel bbox first).
_FRAME = lambda r, g, b: b > 150 and (b - g) > 45 and (b - r) > 60 and g > 60


def _frame_bbox(px, W, H):
    """Robust bbox (x0,y0,x1,y1) of the menu's blue panel backing/border.

    Only the bright glowing border passes _FRAME (the dark navy backing sits just under threshold),
    so the panel shows up as WIDE rows of frame-blue at its top + bottom edges. Scattered scene blue
    (a window sky, the Earth planet) is narrow/round and won't make a WIDE row, so we take the bbox
    of all wide rows — after a median-band filter that drops any wide row far from the main cluster.
    """
    wide = []                                   # (y, min_x, max_x) for each WIDE frame row
    for y in range(0, H, 2):
        xs = [x for x in range(0, W, 2) if _FRAME(*px[x, y])]
        if len(xs) >= 40:                       # a panel edge is a WIDE band; blobs are not
            wide.append((y, min(xs), max(xs)))
    if len(wide) < 3:
        return None
    ys = sorted(r[0] for r in wide)
    med = ys[len(ys) // 2]
    keep = [r for r in wide if abs(r[0] - med) <= 450]   # one panel is ~300px tall in the fb
    if len(keep) < 3:
        return None
    y0 = min(r[0] for r in keep); y1 = max(r[0] for r in keep)
    x0 = min(r[1] for r in keep); x1 = max(r[2] for r in keep)
    return (x0, y0, x1, y1)


def detect_rows(img_path):
    """Return {'rows': {action: y_fb}, 'col': (x0, x1), 'sp': spacing, 'bbox': ...} or None.

    Camera/scale robust AND scene-color robust: find the panel bbox first, then look for the
    button color-bands ONLY inside it, and least-squares-fit the 4 equally-spaced rows.
    """
    from PIL import Image
    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    px = im.load()
    bbox = _frame_bbox(px, W, H)
    if not bbox:
        return None
    fx0, fy0, fx1, fy1 = bbox
    inset = int((fx1 - fx0) * 0.12)             # sample the bar centers, skip the border
    ix0, ix1 = fx0 + inset, fx1 - inset

    def band_median(test):
        ys = [y for y in range(fy0, fy1 + 1) for x in range(ix0, ix1, 3) if test(*px[x, y])]
        return int(st.median(ys)) if len(ys) > 60 else None

    pts = []
    for row_idx, test in ((1, _GREEN), (2, _AMBER), (3, _BLUE), (4, _RED)):
        y = band_median(test)
        if y is not None:
            pts.append((row_idx, y))
    if len(pts) < 2:
        return None
    n = len(pts); sx = sum(p[0] for p in pts); sy = sum(p[1] for p in pts)
    sxx = sum(p[0] ** 2 for p in pts); sxy = sum(p[0] * p[1] for p in pts)
    sp = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    b0 = (sy - sp * sx) / n
    rows = {a: int(b0 + sp * (i + 1)) for i, a in enumerate(ACTIONS)}
    return {"rows": rows, "col": (fx0, fx1), "sp": sp, "bbox": bbox}


def classify(fbx, fby, det):
    """Which action row is the framebuffer point over? None if outside the panel."""
    x0, x1 = det["col"]; sp = det["sp"]; rows = det["rows"]
    if not (x0 - 20 <= fbx <= x1 + 20):
        return None
    ys = sorted(rows.values())
    if fby < ys[0] - sp * 0.7 or fby > ys[-1] + sp * 0.7:
        return None
    return min(rows, key=lambda a: abs(rows[a] - fby))


# ---------- macOS window + coordinate mapping ----------
def find_window():
    import Quartz
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID)
    best = None
    for w in wins:
        owner = (w.get("kCGWindowOwnerName") or "").lower()
        if "qemu" in owner or "crosvm" in owner:
            b = w["kCGWindowBounds"]
            area = b["Width"] * b["Height"]
            if best is None or area > best[4]:
                best = (b["X"], b["Y"], b["Width"], b["Height"], area)
    if not best:
        return None
    return {"x": best[0], "y": best[1], "w": best[2], "h": best[3]}


def screen_to_fb(sx, sy, win):
    """Map a global screen point to device framebuffer coords (letterbox-aware)."""
    cx, cy = win["x"], win["y"] + TITLE_H
    cw, ch = win["w"], win["h"] - TITLE_H
    scale = min(cw / FB_W, ch / FB_H)
    off_x = cx + (cw - FB_W * scale) / 2
    off_y = cy + (ch - FB_H * scale) / 2
    return (sx - off_x) / scale, (sy - off_y) / scale


def fb_to_screen(fbx, fby, win):
    """Inverse of screen_to_fb (for tests / cursor placement)."""
    cx, cy = win["x"], win["y"] + TITLE_H
    cw, ch = win["w"], win["h"] - TITLE_H
    scale = min(cw / FB_W, ch / FB_H)
    off_x = cx + (cw - FB_W * scale) / 2
    off_y = cy + (ch - FB_H * scale) / 2
    return off_x + fbx * scale, off_y + fby * scale


# ---------- the core: a screen point -> menu action ----------
_last = {"det": None, "t": 0.0}

def handle_point(sx, sy, win, pkg, hover=False, redetect=True):
    if redetect or _last["det"] is None or (time.time() - _last["t"]) > 1.5:
        tmp = os.path.join(tempfile.gettempdir(), "bridge_sc.png")
        det = detect_rows(screencap(tmp))
        if det:
            _last["det"], _last["t"] = det, time.time()
    det = _last["det"]
    if not det:
        return None
    fbx, fby = screen_to_fb(sx, sy, win)
    action = classify(fbx, fby, det)
    if action:
        broadcast(pkg, action, hover=hover)
    return action


# ---------- subcommands ----------
def cmd_detect():
    tmp = os.path.join(tempfile.gettempdir(), "bridge_sc.png")
    screencap(tmp)
    det = detect_rows(tmp)
    print("detect:", det)
    if det:
        from PIL import Image, ImageDraw
        im = Image.open(tmp).convert("RGB"); d = ImageDraw.Draw(im)
        cols = {"start": (0, 255, 0), "pause": (255, 140, 0), "resume": (0, 160, 255), "reset": (255, 0, 0)}
        if det.get("bbox"):
            d.rectangle(list(det["bbox"]), outline=(255, 255, 255), width=3)
        x0, x1 = det["col"]
        for a, y in det["rows"].items():
            d.rectangle([x0, y - 28, x1, y + 28], outline=cols[a], width=5)
        ov = os.path.join(tempfile.gettempdir(), "bridge_overlay.png")
        im.save(ov); print("overlay:", ov)


def cmd_point(sx, sy, hover):
    win = find_window()
    if not win:
        print("emulator window not found"); return
    pkg = os.environ.get("BRIDGE_PKG") or foreground_pkg()
    if not pkg:
        print("no foreground com.example.* package"); return
    a = handle_point(float(sx), float(sy), win, pkg, hover=hover)
    print(f"point ({sx},{sy}) -> {'hover' if hover else 'select'} {a}  pkg={pkg}")


def cmd_window():
    print(find_window())


def cmd_live():
    """Watch the real mouse over the emulator; a LEFT-CLICK on a menu button selects it.

    Default = click-to-select only (needs NO app change). Set BRIDGE_HOVER=1 to ALSO move the
    highlight on mouse-over — but that fires a broadcast per move and only does anything if the app
    routes a 'hover' DEBUG_CMD (headset-equivalent feedback; off by default to avoid adb spam)."""
    import Quartz
    win = {"v": find_window()}
    pkg = {"v": os.environ.get("BRIDGE_PKG") or foreground_pkg()}
    if not win["v"]:
        print("emulator window not found (is the PICO emulator running and visible?)"); return
    hover_on = os.environ.get("BRIDGE_HOVER") == "1"
    print(f"LIVE bridge ready. pkg={pkg['v']}  hover={'on' if hover_on else 'off'}")
    print("  -> Move your mouse over a menu button in the emulator and LEFT-CLICK to select it.")
    print("  -> Ctrl-C to stop.")
    last_move = {"t": 0.0}

    def cb(proxy, etype, event, refcon):
        try:
            if etype in (Quartz.kCGEventTapDisabledByTimeout, Quartz.kCGEventTapDisabledByUserInput):
                Quartz.CGEventTapEnable(tap, True); return event
            loc = Quartz.CGEventGetLocation(event)
            if etype == Quartz.kCGEventLeftMouseDown:
                win["v"] = find_window() or win["v"]
                pkg["v"] = pkg["v"] or foreground_pkg()
                a = handle_point(loc.x, loc.y, win["v"], pkg["v"], hover=False)
                print(f"click -> {a}" if a else "click (not over a menu button)")
            elif hover_on and etype == Quartz.kCGEventMouseMoved:
                now = time.time()
                if now - last_move["t"] > 0.12:   # throttle hover broadcasts
                    last_move["t"] = now
                    handle_point(loc.x, loc.y, win["v"], pkg["v"], hover=True, redetect=False)
        except Exception as e:
            print("cb error:", e)
        return event

    mask = Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDown)
    if hover_on:
        mask |= Quartz.CGEventMaskBit(Quartz.kCGEventMouseMoved)
    tap = Quartz.CGEventTapCreate(Quartz.kCGSessionEventTap, Quartz.kCGHeadInsertEventTap,
                                  Quartz.kCGEventTapOptionListenOnly, mask, cb, None)
    if not tap:
        print("ERROR: could not create event tap. Grant Input Monitoring to your terminal app "
              "(System Settings > Privacy & Security > Input Monitoring), then quit + relaunch it.")
        return
    src = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
    Quartz.CFRunLoopAddSource(Quartz.CFRunLoopGetCurrent(), src, Quartz.kCFRunLoopCommonModes)
    Quartz.CGEventTapEnable(tap, True)
    Quartz.CFRunLoopRun()


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(0)
    if a[0] == "detect":
        cmd_detect()
    elif a[0] == "point" and len(a) >= 3:
        cmd_point(a[1], a[2], hover=(len(a) > 3 and a[3] == "hover"))
    elif a[0] == "window":
        cmd_window()
    elif a[0] == "live":
        cmd_live()
    else:
        print(__doc__)
