// Experiment: probe how the PICO emulator interprets xr_* InputEvents.
// Tries: large absolute rotation, translation, repeated event stream kept open,
// and an XrOptions environment change as a control (proves the Xr path works at all).
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIB = path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/lib");
const OUT = path.join(os.tmpdir(), "pico-mcp-live");
fs.mkdirSync(OUT, { recursive: true });

const disc = fs
  .readdirSync(path.join(os.homedir(), "Library/Caches/TemporaryItems/avd/pico_running"))
  .filter((f) => f.endsWith(".ini"))
  .map((f) => fs.readFileSync(path.join(os.homedir(), "Library/Caches/TemporaryItems/avd/pico_running", f), "utf8"))[0];
const token = disc.match(/^grpc\.token=(.+)$/m)?.[1];
const port = disc.match(/^grpc\.port=(.+)$/m)?.[1] ?? "8554";

const pkgDef = protoLoader.loadSync(path.join(LIB, "emulator_controller.proto"), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [LIB],
});
const pkg = grpc.loadPackageDefinition(pkgDef);
const Ctor = pkg.android.emulation.control.EmulatorController;
const client = new Ctor(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
const md = new grpc.Metadata();
md.set("authorization", `Bearer ${token}`);

const unary = (m, req, t = 20000) =>
  new Promise((res, rej) => client[m](req, md, { deadline: new Date(Date.now() + t) }, (e, r) => (e ? rej(e) : res(r))));
const shot = async (name) => {
  const r = await unary("getScreenshot", { format: "PNG" }, 30000);
  fs.writeFileSync(path.join(OUT, name), r.image);
  console.log(`${name}: ${r.image.length} bytes`);
  return r.image.length;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("getXrOptions:", JSON.stringify(await unary("getXrOptions", {}).catch((e) => e.message)));

await shot("exp0-baseline.png");

// A: single large rotation via short-lived stream
await new Promise((res, rej) => {
  const call = client.streamInputEvent(md, { deadline: new Date(Date.now() + 10000) }, (e) => (e ? rej(e) : res()));
  call.write({ xr_head_rotation_event: { x: 0, y: 1.57, z: 0 } });
  call.end();
});
await sleep(2000);
await shot("exp1-rot-short-stream.png");

// B: stream kept OPEN with repeated rotation + translation events, screenshot while open
await new Promise(async (res, rej) => {
  const call = client.streamInputEvent(md, { deadline: new Date(Date.now() + 30000) }, (e) => (e ? rej(e) : res()));
  for (let i = 0; i < 30; i++) {
    call.write({ xr_head_rotation_event: { x: 0, y: 0.05, z: 0 } });
    await sleep(33);
  }
  call.write({ xr_head_movement_event: { x: 0, y: 0, z: 2.0 } });
  await sleep(500);
  await shot("exp2-while-stream-open.png");
  call.end();
});
await sleep(1000);
await shot("exp3-after-stream-closed.png");

// C: control — XrOptions environment/passthrough change (visible if Xr path works)
console.log("setXrOptions passthrough=1:", JSON.stringify(await unary("setXrOptions", { passthrough_coefficient: 1.0 }).catch((e) => e.message)));
await sleep(2000);
await shot("exp4-passthrough.png");
console.log("setXrOptions passthrough=0:", JSON.stringify(await unary("setXrOptions", { passthrough_coefficient: 0.0 }).catch((e) => e.message)));
await sleep(1500);

// D: physical model rotation (generic device pose — does SpaceOS map it?)
console.log(
  "setPhysicalModel ROTATION:",
  JSON.stringify(await unary("setPhysicalModel", { target: "ROTATION", value: { data: [0, 45, 0] } }).catch((e) => e.message)),
);
await sleep(2000);
await shot("exp5-physical-rotation.png");
await unary("setPhysicalModel", { target: "ROTATION", value: { data: [0, 0, 0] } }).catch(() => {});

console.log("done ->", OUT);
client.close();
