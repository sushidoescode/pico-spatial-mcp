import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, fail, okJson, expandHome, sleep } from "./util.js";
import { DRAG_SWIFT, resolveAdb } from "./emulatorlook.js";
import { getClient, unary } from "./grpc.js";

/**
 * cameradrive.ts — capture_orbit / capture_multiview: DRIVE the emulator free camera and
 * capture from multiple viewpoints, so an agent can visually verify 3D placement on its own
 * instead of asking the user for walk-around screenshots.
 *
 * Mechanism (settled empirically 2026-08-08 after a two-session goose chase):
 *  - TRANSLATION: gRPC EmulatorController.sendKey keydown/keyup with 'w','a','s','d','q','e'
 *    drives the GUI free-cam walk (W fwd / S back / A left / D right / Q down / E up, relative
 *    to current facing). Applies within ~0.5 s WHEN THE EMULATOR WINDOW IS FRONTMOST, with a
 *    smoothing/inertia tail of up to several seconds.
 *  - ROTATION: only a RIGHT-button mouse drag on the GL surface rotates (same lane as
 *    emulator_look). gRPC sendMouse does NOT rotate; xr_head_* InputEvents do NOT move the
 *    view. So rotation posts CGEvents (macOS + Accessibility); translation is plain gRPC.
 *  - SETTLE: every motion glides after input stops. Both prior sessions produced false
 *    "input doesn't work" verdicts by capturing once, too early, and reading byte-identical
 *    hashes. ALWAYS settle-wait (consecutive identical captures) before judging a capture.
 */

const KEYCODES: Record<string, true> = { w: true, a: true, s: true, d: true, q: true, e: true };

async function frontmostQemu(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const r = await run("osascript", ["-e", 'tell application "System Events" to set frontmost of (first process whose name contains "qemu") to true'], { timeoutMs: 5000 });
  return r.code === 0 ? null : `osascript frontmost failed: ${r.stderr || r.stdout}`;
}

async function screencapBuf(adb: string, serial: string): Promise<Buffer | null> {
  const r = await runBinary(adb, ["-s", serial, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
  return r.code === 0 && r.stdout.length >= 1000 ? r.stdout : null;
}

/** Capture until two consecutive frames are byte-identical (the free-cam has inertia). */
async function settleCapture(adb: string, serial: string, maxTries = 12, intervalMs = 700): Promise<{ buf: Buffer; settled: boolean } | null> {
  let prev: Buffer | null = null;
  for (let i = 0; i < maxTries; i++) {
    const cur = await screencapBuf(adb, serial);
    if (!cur) return null;
    if (prev && cur.equals(prev)) return { buf: cur, settled: true };
    prev = cur;
    await sleep(intervalMs);
  }
  return prev ? { buf: prev, settled: false } : null;
}

/** gRPC sendKey hold. Starts the emulator's gRPC endpoint via console if it is not up yet. */
async function keyHold(serial: string, key: string, holdMs: number): Promise<string | null> {
  let c = getClient();
  if ("error" in c) return c.error;
  const tryOnce = async () => {
    const cc = c as Exclude<typeof c, { error: string }>;
    await unary(cc.client, "sendKey", { eventType: "keydown", key }, cc.metadata, 6000);
    await sleep(holdMs);
    await unary(cc.client, "sendKey", { eventType: "keyup", key }, cc.metadata, 6000);
  };
  try {
    await tryOnce();
    return null;
  } catch (e: any) {
    if (/UNAVAILABLE|ECONNREFUSED/i.test(String(e?.message))) {
      const adb = resolveAdb();
      await run(adb, ["-s", serial, "emu", "grpc", "8554"], { timeoutMs: 8000 });
      await sleep(800);
      c = getClient();
      if ("error" in c) return c.error;
      try {
        await tryOnce();
        return null;
      } catch (e2: any) {
        return `sendKey failed after starting gRPC endpoint: ${e2.message}`;
      }
    }
    return `sendKey failed: ${e.message}`;
  }
}

/** Right-button drag via CGEvents (rotation lane). macOS only. */
async function rightDrag(dx: number, dy: number): Promise<string | null> {
  if (process.platform !== "darwin") return "rotation (dragDx/dragDy) requires macOS CGEvents; on this platform use key moves only";
  const swiftPath = path.join(os.tmpdir(), "pico-camera-drive.swift");
  fs.writeFileSync(swiftPath, DRAG_SWIFT);
  const r = await run("swift", [swiftPath, "right", String(dx), String(dy), "24", "14"], { timeoutMs: 30_000 });
  if (r.code !== 0 || /NO_QEMU_WINDOW/.test(r.stdout)) {
    return `right-drag failed: ${r.stdout || r.stderr}. Emulator window open + Accessibility granted?`;
  }
  return null;
}

const moveSchema = z.object({
  key: z.enum(["w", "a", "s", "d", "q", "e"]).optional()
    .describe("Walk key: w=forward s=back a=left d=right q=down e=up, relative to current facing"),
  holdMs: z.number().int().min(50).max(5000).optional().describe("How long to hold the key (default 600 ms ≈ a large step)"),
  repeat: z.number().int().min(1).max(20).optional().describe("Repeat the hold N times (default 1)"),
  dragDx: z.number().optional().describe("Right-drag pixels: rotation. dx>0 looks right, dx<0 looks left (macOS only)"),
  dragDy: z.number().optional().describe("Right-drag pixels: dy>0 looks down, dy<0 looks up (macOS only)"),
});

async function applyMoves(serial: string, moves: Array<z.infer<typeof moveSchema>>): Promise<string | null> {
  for (const m of moves) {
    if (m.key) {
      if (!KEYCODES[m.key]) return `unknown key '${m.key}'`;
      const n = m.repeat ?? 1;
      for (let i = 0; i < n; i++) {
        const err = await keyHold(serial, m.key, m.holdMs ?? 600);
        if (err) return err;
        await sleep(150);
      }
    }
    if (m.dragDx != null || m.dragDy != null) {
      const err = await rightDrag(m.dragDx ?? 0, m.dragDy ?? 0);
      if (err) return err;
    }
  }
  return null;
}

function writeShrunk(buf: Buffer, outPath: string, maxDim: number): Promise<string> {
  const full = expandHome(outPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  const small = full.replace(/\.png$/, ".small.png");
  return run("sips", ["-Z", String(maxDim), full, "--out", small], { timeoutMs: 20_000 }).then((r) =>
    r.code === 0 && fs.existsSync(small) ? small : full,
  );
}

export function registerCameraDriveTools(server: McpServer) {
  server.registerTool(
    "capture_orbit",
    {
      description:
        "DRIVE the emulator free camera (walk keys + look drags), settle, then capture the HMD frame — the primitive that lets an agent verify 3D placement from angles OTHER than the launch-forward view. Moves run in order: {key:'w'|'a'|'s'|'d'|'q'|'e', holdMs?, repeat?} walks (gRPC sendKey; W fwd/S back/A left/D right/Q down/E up relative to facing), {dragDx, dragDy} rotates the view (right-button CGEvent drag; macOS). The camera has INERTIA: this tool settle-waits until two consecutive captures are byte-identical before returning. The emulator window is brought frontmost first (walks need it). LOOK at the returned frame before claiming anything about the scene.",
      inputSchema: {
        moves: z.array(moveSchema).min(1).describe("Sequence of walk/look moves, applied in order"),
        serial: z.string().optional().describe("adb serial (default emulator-5554)"),
        outPath: z.string().optional().describe("Where to write the full-res capture (default /tmp/pico-render/capture_orbit.png)"),
        maxDim: z.number().int().positive().optional().describe("Max dimension of the returned image (default 1200)"),
        capture: z.boolean().optional().describe("Capture + return the frame after moving (default true)"),
      },
    },
    async ({ moves, serial, outPath, maxDim, capture }) => {
      const dev = serial ?? "emulator-5554";
      const focusErr = await frontmostQemu();
      if (focusErr) return fail(focusErr);
      const err = await applyMoves(dev, moves);
      if (err) return fail(err);
      if (capture === false) return okJson({ status: "ok", note: "moves applied (no capture requested)" });
      const adb = resolveAdb();
      const settled = await settleCapture(adb, dev);
      if (!settled) return fail("screencap failed after moves");
      const full = expandHome(outPath ?? "/tmp/pico-render/capture_orbit.png");
      const smallPath = await writeShrunk(settled.buf, full, maxDim ?? 1200);
      const b64 = fs.readFileSync(smallPath).toString("base64");
      return {
        content: [
          { type: "image" as const, data: b64, mimeType: "image/png" as const },
          {
            type: "text" as const,
            text:
              `Applied ${moves.length} move(s), ${settled.settled ? "pose settled" : "POSE MAY STILL BE GLIDING (settle timeout)"} -> ${full}. ` +
              "LOOK at this frame and judge the scene from THIS angle; call again with more moves to keep exploring.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "capture_multiview",
    {
      description:
        "Capture one scene from FOUR viewpoints in a single call — front (current pose), high-angle (fly up + look down), and two side obliques (strafe + re-aim) — then walk the camera back and report whether the round trip closed. This is the multi-angle visual check that placement work MUST pass: a single forward view cannot verify a 3D layout (two sessions were lost to that). Each leg settle-waits out the free-cam inertia. macOS for the look-drags; walks are gRPC. LOOK at every returned frame: check nothing intersects furniture/walls/rug from ANY of the angles.",
      inputSchema: {
        serial: z.string().optional().describe("adb serial (default emulator-5554)"),
        outDir: z.string().optional().describe("Directory for the four frames (default /tmp/pico-render/multiview)"),
        sideHolds: z.number().int().min(1).max(10).optional().describe("How many 600ms strafe holds per side leg (default 3)"),
        aimSideDrag: z.number().optional().describe("Re-aim drag px toward subject after strafing (default 200)"),
        upHolds: z.number().int().min(1).max(10).optional().describe("How many 600ms up-holds for the high angle (default 2)"),
        aimDownDrag: z.number().optional().describe("Look-down drag px for the high angle (default 260)"),
        maxDim: z.number().int().positive().optional().describe("Max dimension of returned images (default 900)"),
      },
    },
    async ({ serial, outDir, sideHolds, aimSideDrag, upHolds, aimDownDrag, maxDim }) => {
      if (process.platform !== "darwin") {
        return fail("capture_multiview needs the macOS look-drag lane for its high/oblique aims; use capture_orbit with key moves only on this platform");
      }
      const dev = serial ?? "emulator-5554";
      const dir = expandHome(outDir ?? "/tmp/pico-render/multiview");
      fs.mkdirSync(dir, { recursive: true });
      const side = sideHolds ?? 3;
      const aim = aimSideDrag ?? 200;
      const up = upHolds ?? 2;
      const down = aimDownDrag ?? 260;
      const dim = maxDim ?? 900;
      const adb = resolveAdb();

      const focusErr = await frontmostQemu();
      if (focusErr) return fail(focusErr);

      const legs: Array<{ name: string; go: Array<z.infer<typeof moveSchema>>; back: Array<z.infer<typeof moveSchema>> }> = [
        { name: "front", go: [], back: [] },
        {
          name: "high",
          go: [{ key: "e", repeat: up }, { dragDy: down }],
          back: [{ dragDy: -down }, { key: "q", repeat: up }],
        },
        {
          name: "oblique_left",
          go: [{ key: "a", repeat: side }, { dragDx: aim }],
          back: [{ dragDx: -aim }, { key: "d", repeat: side }],
        },
        {
          name: "oblique_right",
          go: [{ key: "d", repeat: side }, { dragDx: -aim }],
          back: [{ dragDx: aim }, { key: "a", repeat: side }],
        },
      ];

      const content: any[] = [];
      const paths: string[] = [];
      const problems: string[] = [];
      let frontHash: Buffer | null = null;

      for (const leg of legs) {
        if (leg.go.length) {
          const err = await applyMoves(dev, leg.go);
          if (err) { problems.push(`${leg.name}: ${err}`); continue; }
        }
        const settled = await settleCapture(adb, dev);
        if (!settled) { problems.push(`${leg.name}: screencap failed`); continue; }
        if (leg.name === "front") frontHash = settled.buf;
        if (!settled.settled) problems.push(`${leg.name}: settle timeout (frame may be mid-glide)`);
        const full = path.join(dir, `${leg.name}.png`);
        const smallPath = await writeShrunk(settled.buf, full, dim);
        paths.push(full);
        content.push({ type: "image" as const, data: fs.readFileSync(smallPath).toString("base64"), mimeType: "image/png" as const });
        if (leg.back.length) {
          const err = await applyMoves(dev, leg.back);
          if (err) problems.push(`${leg.name} return: ${err}`);
        }
      }

      const final = await settleCapture(adb, dev);
      const roundTripClosed = !!(final && frontHash && final.buf.equals(frontHash));
      if (final) fs.writeFileSync(path.join(dir, "restored.png"), final.buf);

      content.push({
        type: "text" as const,
        text:
          `Frames (front, high, oblique_left, oblique_right) -> ${paths.join(", ")}. ` +
          `roundTripClosed=${roundTripClosed}${roundTripClosed ? "" : " (free-cam inertia drifts; the camera is NEAR but not exactly at the start pose)"}. ` +
          (problems.length ? `Problems: ${problems.join("; ")}. ` : "") +
          "LOOK at every frame: verify from EACH angle that content sits where it should and intersects nothing.",
      });
      return { content };
    },
  );
}
