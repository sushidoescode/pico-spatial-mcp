// Rigorous XR-gate probe: which injection path actually moves the rendered view?
// Uses RGBA8888 raw screenshots from gRPC and computes real pixel diffs vs a noise floor.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIB = path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/lib");
const discDir = path.join(os.homedir(), "Library/Caches/TemporaryItems/avd/pico_running");
const disc = fs.readdirSync(discDir).filter((f) => f.endsWith(".ini")).map((f) => fs.readFileSync(path.join(discDir, f), "utf8"))[0];
const token = disc.match(/^grpc\.token=(.+)$/m)?.[1];
const port = disc.match(/^grpc\.port=(.+)$/m)?.[1] ?? "8554";

const pkgDef = protoLoader.loadSync(path.join(LIB, "emulator_controller.proto"), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [LIB],
});
const Ctor = grpc.loadPackageDefinition(pkgDef).android.emulation.control.EmulatorController;
const client = new Ctor(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
  "grpc.max_receive_message_length": 64 * 1024 * 1024,
});
const md = new grpc.Metadata();
if (token) md.set("authorization", `Bearer ${token}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unary = (m, req, t = 20000) =>
  new Promise((res, rej) => client[m](req, md, { deadline: new Date(Date.now() + t) }, (e, r) => (e ? rej(e) : res(r))));

async function rawShot() {
  // Downscale to keep the RGBA buffer small and diffing fast; aspect preserved by the emulator.
  const r = await unary("getScreenshot", { format: "RGBA8888", width: 540, height: 540 }, 30000);
  return { buf: Buffer.from(r.image), w: r.format?.width, h: r.format?.height };
}
function diff(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0, changed = 0;
  for (let i = 0; i < n; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    sum += d;
    if (d > 24) changed++; // ~8/channel threshold
  }
  const px = n / 4;
  return { meanChannelDelta: +(sum / (px * 3)).toFixed(3), pctPixelsChanged: +((changed / px) * 100).toFixed(2) };
}

function streamHead(events, ms = 0) {
  return new Promise(async (res, rej) => {
    const call = client.streamInputEvent(md, { deadline: new Date(Date.now() + Math.max(15000, ms + 5000)) }, (e) => (e ? rej(e) : res()));
    for (const ev of events) { call.write(ev); if (ms) await sleep(ms / events.length); }
    call.end();
  });
}

const results = {};
const base = await rawShot();
console.log(`screenshot ${base.w}x${base.h}, ${base.buf.length} bytes (RGBA)`);

// 0. NOISE FLOOR: wait same duration as an injection, no input
await sleep(2500);
results["control_noise"] = diff(base.buf, (await rawShot()).buf);

// 1. xr_head_rotation: sustained yaw deltas (relative, accumulate to ~0.8 rad)
const b1 = (await rawShot()).buf;
await streamHead(Array.from({ length: 40 }, () => ({ xr_head_rotation_event: { x: 0, y: 0.02, z: 0 } })), 2000);
await sleep(800);
results["xr_head_rotation"] = diff(b1, (await rawShot()).buf);

// 2. xr_head_movement: sustained forward translation
const b2 = (await rawShot()).buf;
await streamHead(Array.from({ length: 40 }, () => ({ xr_head_movement_event: { x: 0, y: 0, z: 0.05 } })), 2000);
await sleep(800);
results["xr_head_movement"] = diff(b2, (await rawShot()).buf);

// 3. setPhysicalModel ROTATION (absolute degrees)
const b3 = (await rawShot()).buf;
try { await unary("setPhysicalModel", { target: "ROTATION", value: { data: [0, 45, 0] } }); } catch (e) { results["_physmodel_err"] = e.message; }
await sleep(1500);
results["setPhysicalModel_rotation"] = diff(b3, (await rawShot()).buf);
try { await unary("setPhysicalModel", { target: "ROTATION", value: { data: [0, 0, 0] } }); } catch {}

// 4. rotateVirtualSceneCamera
const b4 = (await rawShot()).buf;
try { await unary("rotateVirtualSceneCamera", { x: 0, y: 0.8, z: 0 }); } catch (e) { results["_virtcam_err"] = e.message; }
await sleep(1200);
results["rotateVirtualSceneCamera"] = diff(b4, (await rawShot()).buf);

// 5. setXrOptions passthrough toggle (known-good control that the Xr path handles)
const b5 = (await rawShot()).buf;
try { await unary("setXrOptions", { passthrough_coefficient: 1.0 }); } catch (e) { results["_xropt_err"] = e.message; }
await sleep(1500);
results["setXrOptions_passthrough"] = diff(b5, (await rawShot()).buf);
try { await unary("setXrOptions", { passthrough_coefficient: 0.0 }); } catch {}

console.log("\n=== Pixel-diff results (vs each method's own pre-shot) ===");
console.log("Noise floor (control):", JSON.stringify(results["control_noise"]));
for (const [k, v] of Object.entries(results)) {
  if (k === "control_noise" || k.startsWith("_")) continue;
  const noise = results["control_noise"].pctPixelsChanged;
  const verdict = v.pctPixelsChanged > Math.max(2, noise * 4) ? "  <-- MOVES THE VIEW" : "  (≈ noise)";
  console.log(`${k.padEnd(28)} ${JSON.stringify(v)}${verdict}`);
}
for (const [k, v] of Object.entries(results)) if (k.startsWith("_")) console.log(`${k}: ${v}`);
client.close();
