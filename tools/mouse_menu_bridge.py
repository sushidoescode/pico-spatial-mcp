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


_fg = {"pkg": None, "t": 0.0}

def target_pkg(fixed=None):
    """Which app to broadcast to. A pinned BRIDGE_PKG wins; otherwise the FOREGROUND spatial app,
    re-checked each click (with a short cache) so clicks always hit the demo you're actually looking
    at — not a stale package. (This was the 'click registered but nothing happened' bug: the command
    went to a pinned app that wasn't in front.)"""
    if fixed:
        return fixed
    if _fg["pkg"] is None or (time.time() - _fg["t"]) > 0.8:
        fg = foreground_pkg()
        if fg:
            _fg["pkg"], _fg["t"] = fg, time.time()
    return _fg["pkg"]


def broadcast(pkg, action, hover=False):
    # hover PREVIEW encodes the target in the cmd string ("hover:start", "hover:none") so the app's
    # existing single-'cmd'-extra receiver can route it without a second extra. A click sends the bare
    # action ("reset"). action=None on hover -> "hover:none" clears the preview.
    cmd = f"hover:{action or 'none'}" if hover else action
    adb("shell", "am", "broadcast", "-a", f"{pkg}.DEBUG_CMD", "--es", "cmd", cmd)


def broadcast_move(pkg, dx, dy, dz):
    # MOVE the panel by a WORLD delta ("move:dx,dy,dz") — the app applies it + logs the new position.
    adb("shell", "am", "broadcast", "-a", f"{pkg}.DEBUG_CMD",
        "--es", "cmd", f"move:{dx:.4f},{dy:.4f},{dz:.4f}")


def broadcast_snap(pkg):
    # On drop: tell the app to SNAP the panel to its grid ("move:snap" -> GameMenu.snapPanel()).
    adb("shell", "am", "broadcast", "-a", f"{pkg}.DEBUG_CMD", "--es", "cmd", "move:snap")


# ---------- menu row detection (framebuffer space) ----------
# Button-bar colors (the AAA texture: green START, amber PAUSE, blue RESUME, red RESET), in row order.
_RED   = lambda r, g, b: r > 150 and g < 105 and b < 105 and (r - g) > 70 and (r - b) > 70
_AMBER = lambda r, g, b: r > 195 and 120 <= g <= 210 and b < 110 and (r - b) > 110 and (r - g) > 35
_BLUE  = lambda r, g, b: 90 < g < 200 and b > 150 and (b - r) > 55 and (b - g) > 35 and r < 150
_GREEN = lambda r, g, b: g > 150 and r < 170 and b < 150 and (g - r) > 30 and (g - b) > 45
_TESTS = (_GREEN, _AMBER, _BLUE, _RED)          # index 0..3 == row order start/pause/resume/reset


def _color_bars(px, W, H, test, min_w, step=2):
    """WIDE horizontal bars of one colour -> top-4 widest as (yc, x0, x1, width).

    A menu button is a wide horizontal bar; planets/cubes/plants are narrow or round and get pruned
    by min_w. Consecutive matching rows are merged into one band.
    """
    rowx = {}
    for y in range(0, H, step):
        xs = [x for x in range(0, W, step) if test(*px[x, y])]
        if len(xs) >= 10:
            rowx[y] = (min(xs), max(xs))
    bands, cur = [], []
    for y in sorted(rowx):
        if cur and y - cur[-1] <= 14:
            cur.append(y)
        else:
            if cur:
                bands.append(cur)
            cur = [y]
    if cur:
        bands.append(cur)
    out = []
    for band in bands:
        if len(band) < 2:
            continue
        x0 = min(rowx[y][0] for y in band); x1 = max(rowx[y][1] for y in band)
        if x1 - x0 >= min_w:
            out.append((sum(band) // len(band), x0, x1, x1 - x0))
    out.sort(key=lambda b: -b[3])
    return out[:4]


def _fit(chosen, W):
    """chosen = [(rowIndex, yc, x0, x1, w), ...] (3 or 4). Validate it's a vertical, same-column,
    equally-spaced stack and least-squares-fit y = b0 + sp*index over the 4 rows. None if it isn't."""
    idxs = [c[0] for c in chosen]; ys = [c[1] for c in chosen]
    cs = [(c[2] + c[3]) / 2 for c in chosen]
    xspread = max(cs) - min(cs)
    if xspread > 0.10 * W:                       # buttons share a column; a cube row does not
        return None
    if [y for _, y in sorted(zip(idxs, ys))] != sorted(ys) or len(set(ys)) != len(ys):
        return None                              # y must strictly increase with row index
    n = len(idxs); sx = sum(idxs); sy = sum(ys)
    sxx = sum(i * i for i in idxs); sxy = sum(i * y for i, y in zip(idxs, ys))
    denom = n * sxx - sx * sx
    if denom == 0:
        return None
    sp = (n * sxy - sx * sy) / denom; b0 = (sy - sp * sx) / n
    if sp <= 8:                                  # rows must be genuinely spaced (kills a flat cube row)
        return None
    err = sum(abs((b0 + sp * i) - y) for i, y in zip(idxs, ys)) / n
    if err > 0.22 * sp:                          # spacing must be regular
        return None
    rows = {a: int(b0 + sp * i) for i, a in enumerate(ACTIONS)}
    x0 = min(c[2] for c in chosen); x1 = max(c[3] for c in chosen)
    score = xspread / W + err / sp + (4 - len(chosen)) * 0.3   # prefer a full 4-of-4 match
    bbox = (x0, rows[ACTIONS[0]] - int(sp), x1, rows[ACTIONS[-1]] + int(sp))
    return {"rows": rows, "col": (x0, x1), "sp": sp, "bbox": bbox, "_score": score}


def detect_rows(img_path):
    """Return {'rows': {action: y_fb}, 'col': (x0, x1), 'sp': spacing, 'bbox': ...} or None.

    Scene-color robust: the menu's UNIQUE signature is four wide colour bars (green->amber->blue->red)
    STACKED vertically at the same column with equal spacing. Floor cubes (side-by-side, same height)
    and planets (round) can't match that, so they can't hijack detection. A 3-of-4 fallback recovers
    when a press flash or glassy cap momentarily washes one button's colour.
    """
    from PIL import Image
    from itertools import product
    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    px = im.load()
    min_w = int(W * 0.08)
    cand = [_color_bars(px, W, H, t, min_w) for t in _TESTS]
    best = None

    # 4-of-4: one bar from each colour forming the stack.
    for combo in product(*cand) if all(cand) else []:
        f = _fit([(i, *combo[i]) for i in range(4)], W)
        if f and (best is None or f["_score"] < best["_score"]):
            best = f
    if best:
        return best

    # 3-of-4 fallback: drop one colour (it may be washed) and fit the remaining stacked three.
    for drop in range(4):
        keep = [i for i in range(4) if i != drop]
        lists = [cand[i] for i in keep]
        if not all(lists):
            continue
        for combo in product(*lists):
            f = _fit([(keep[k], *combo[k]) for k in range(3)], W)
            if f and (best is None or f["_score"] < best["_score"]):
                best = f
    return best


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
        for _ in range(3):                       # a single frame can fail (a press flash washes a
            det = detect_rows(screencap(tmp))    # button mid-animation) -> retry before giving up
            if det:
                _last["det"], _last["t"] = det, time.time()
                break
    det = _last["det"]                           # fall back to the last good detection if all retries fail
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
    pkg = target_pkg(os.environ.get("BRIDGE_PKG"))
    if not pkg:
        print("no foreground com.example.* package"); return
    a = handle_point(float(sx), float(sy), win, pkg, hover=hover)
    print(f"point ({sx},{sy}) -> {'hover' if hover else 'select'} {a}  pkg={pkg}")


def cmd_window():
    print(find_window())


def cmd_live():
    """Watch the real mouse over the emulator; a LEFT-CLICK on a menu button selects it.

    A background thread keeps the menu detection + window bounds fresh (~every 0.4s) so the click and
    hover handlers never block on a screencap and stay accurate as the free camera drifts.

    Default = click-to-select only (needs NO app change). Set BRIDGE_HOVER=1 to ALSO preview the
    button under the pointer (mouse-over highlight) — it broadcasts `hover:<action>` only when the row
    CHANGES (efficient), which the app routes to GameMenu.hover(). Off by default."""
    import Quartz, threading
    win = {"v": find_window()}
    fixed = os.environ.get("BRIDGE_PKG")   # optional hard override; else auto-target the foreground app
    if not win["v"]:
        print("emulator window not found (is the PICO emulator running and visible?)"); return
    hover_on = os.environ.get("BRIDGE_HOVER") == "1"
    tgt = "pinned " + fixed if fixed else "auto (whichever demo is in front)"
    print(f"LIVE bridge ready. target={tgt}  hover={'on' if hover_on else 'off'}")
    print("  -> LEFT-CLICK a menu button to select it" + (" (it highlights on hover)." if hover_on else "."))
    print("  -> DRAG the panel's title/frame to MOVE it around the room; SCROLL over it to change depth.")
    print("  -> Ctrl-C to stop.")

    # Background detector: refresh the window bounds + menu rows off the event loop so handlers are instant.
    stop = threading.Event()
    def detector():
        tmp = os.path.join(tempfile.gettempdir(), "bridge_det.png")
        while not stop.is_set():
            try:
                w = find_window()
                if w:
                    win["v"] = w
                d = detect_rows(screencap(tmp))
                if d:
                    _last["det"], _last["t"] = d, time.time()
            except Exception:
                pass
            stop.wait(0.4)
    threading.Thread(target=detector, daemon=True).start()

    PANEL_WORLD_W = 0.85   # panel width in metres at default scale -> world metres per fb pixel = this / px_width
    MOVE_SENS = float(os.environ.get("BRIDGE_MOVE_SENS", "1.0"))   # drag sensitivity (1.0 = 1:1 direct drag)

    def fb_at(loc):
        return screen_to_fb(loc.x, loc.y, win["v"])

    def action_at(loc):
        det = _last["det"]
        if not det:
            return None
        fbx, fby = fb_at(loc)
        return classify(fbx, fby, det)

    def on_panel(loc):
        """True on the panel's grab zone = the title strip above the top button or the footer below the
        bottom one (NOT a button). The detected bbox is tight around the buttons, so extend generously
        upward (title) and downward (footer) using the row spacing."""
        det = _last["det"]
        if not det:
            return False
        x0, x1 = det["col"]; sp = det["sp"]; rows = sorted(det["rows"].values())
        fbx, fby = fb_at(loc)
        if not (x0 - 40 <= fbx <= x1 + 40):
            return False
        if not (rows[0] - sp * 2.6 <= fby <= rows[-1] + sp * 2.0):
            return False
        return classify(fbx, fby, det) is None   # title/footer/frame, not a button row

    # Coalescing move sender: the drag ACCUMULATES a world delta (instant — never blocks the mouse); a
    # background thread drains it one broadcast at a time, SUMMING everything queued while a broadcast is
    # in flight. So the panel tracks the cursor and STOPS the moment you do — no queued-broadcast drift.
    move = {"dx": 0.0, "dy": 0.0, "dz": 0.0, "pkg": None, "snap": False}
    mlock = threading.Lock()

    def mover():
        while not stop.is_set():
            with mlock:
                dx, dy, dz, pkg = move["dx"], move["dy"], move["dz"], move["pkg"]
                move["dx"] = move["dy"] = move["dz"] = 0.0
                moving = abs(dx) > 1e-5 or abs(dy) > 1e-5 or abs(dz) > 1e-5
                snap = move["snap"] and not moving   # snap only once the drag delta has fully drained
                if snap:
                    move["snap"] = False
            if pkg and moving:
                broadcast_move(pkg, dx, dy, dz)     # blocking (~21ms) but only on THIS thread
            elif pkg and snap:
                broadcast_snap(pkg); print("snapped to grid")
            else:
                stop.wait(0.012)
    threading.Thread(target=mover, daemon=True).start()

    def queue_move(pkg, dx, dy, dz):
        with mlock:
            move["dx"] += dx; move["dy"] += dy; move["dz"] += dz; move["pkg"] = pkg

    hov = {"act": "__init__"}                       # last hovered row, to broadcast only on change
    drag = {"on": False, "last": (0.0, 0.0)}        # panel-move drag state (grab the frame/title, drag to move)

    def cb(proxy, etype, event, refcon):
        try:
            if etype in (Quartz.kCGEventTapDisabledByTimeout, Quartz.kCGEventTapDisabledByUserInput):
                Quartz.CGEventTapEnable(tap, True); return event
            loc = Quartz.CGEventGetLocation(event)
            if etype == Quartz.kCGEventLeftMouseDown:
                pkg = target_pkg(fixed)        # re-checked each click -> always the visible demo
                if not pkg:
                    print("click (no foreground spatial app found)"); return
                a = action_at(loc)
                if a:
                    broadcast(pkg, a); print(f"click -> {a}  [{pkg.split('.')[-1]}]")
                elif on_panel(loc):
                    drag["on"] = True; drag["last"] = fb_at(loc)
                    print("grab panel — drag to move it around the room")
                else:
                    print("click (not over a menu button)")
            elif etype == Quartz.kCGEventLeftMouseDragged and drag["on"]:
                det = _last["det"]
                if det:
                    fbx, fby = fb_at(loc); lx, ly = drag["last"]; drag["last"] = (fbx, fby)
                    x0, x1 = det["col"]; k = PANEL_WORLD_W / max(1, (x1 - x0)) * MOVE_SENS
                    pkg = target_pkg(fixed)
                    if pkg:
                        queue_move(pkg, (fbx - lx) * k, -(fby - ly) * k, 0.0)   # right->+X, down->-Y
            elif etype == Quartz.kCGEventLeftMouseUp and drag["on"]:
                drag["on"] = False
                with mlock:
                    move["snap"] = True   # snap to grid once the drag deltas have drained (mover handles order)
                print("placed panel (snaps to grid; new position logged in logcat -> bake it into panelPosition)")
            elif etype == Quartz.kCGEventScrollWheel and on_panel(loc):
                d = Quartz.CGEventGetIntegerValueField(event, Quartz.kCGScrollWheelEventDeltaAxis1)
                pkg = target_pkg(fixed)
                if d and pkg:
                    queue_move(pkg, 0.0, 0.0, -d * 0.03)   # scroll = nearer / farther (depth)
            elif hover_on and etype == Quartz.kCGEventMouseMoved and not drag["on"]:
                a = action_at(loc)
                if a != hov["act"]:            # only broadcast when the hovered row changes
                    hov["act"] = a
                    pkg = target_pkg(fixed)
                    if pkg:
                        broadcast(pkg, a, hover=True)   # a may be None -> hover:none clears the preview
        except Exception as e:
            print("cb error:", e)
        return event

    mask = (Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDown) |
            Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDragged) |
            Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseUp) |
            Quartz.CGEventMaskBit(Quartz.kCGEventScrollWheel))
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
    try:
        Quartz.CFRunLoopRun()
    except KeyboardInterrupt:
        print("\nbridge stopped.")   # Ctrl-C — exit cleanly, no traceback
    finally:
        stop.set()


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
