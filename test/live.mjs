// Live XR verification against a RUNNING PICO emulator:
// gRPC status -> baseline screenshot -> inject head rotation -> screenshot -> diff -> recenter.
// Run: node test/live.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = path.join(os.tmpdir(), "pico-mcp-live");
fs.mkdirSync(OUT, { recursive: true });

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "live", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const png = (r) => r.content.find((c) => c.type === "image")?.data ?? null;
const report = (name, r, extra = "") => {
  if (r.isError) failures++;
  console.log(`\n=== ${name} [${r.isError ? "FAIL" : "ok"}] ===\n${text(r).slice(0, 1200)}${extra}`);
};

report("emulator_status", await client.callTool({ name: "emulator_status", arguments: {} }));
report("xr_grpc_status", await client.callTool({ name: "xr_grpc_status", arguments: {} }));

const shot1 = await client.callTool({ name: "xr_screenshot", arguments: {} });
const b1 = png(shot1);
if (b1) fs.writeFileSync(path.join(OUT, "before.png"), Buffer.from(b1, "base64"));
report("xr_screenshot (baseline)", shot1, b1 ? ` -> ${OUT}/before.png` : "");

report(
  "xr_set_head_pose (yaw 0.6 rad)",
  await client.callTool({ name: "xr_set_head_pose", arguments: { rotation: { x: 0, y: 0.6, z: 0 } } }),
);
await new Promise((r) => setTimeout(r, 2500));

const shot2 = await client.callTool({ name: "xr_screenshot", arguments: {} });
const b2 = png(shot2);
if (b2) fs.writeFileSync(path.join(OUT, "after.png"), Buffer.from(b2, "base64"));
report("xr_screenshot (after pose)", shot2, b2 ? ` -> ${OUT}/after.png` : "");

if (b1 && b2) {
  const a = Buffer.from(b1, "base64");
  const b = Buffer.from(b2, "base64");
  // PNG byte deltas are a weak signal (specular shimmer/animation produce small
  // diffs even with a static camera). Require a large structural change before
  // claiming the pose was honored; otherwise demand visual inspection.
  const sizeDeltaPct = (Math.abs(a.length - b.length) / a.length) * 100;
  console.log(`\nPNG size delta: ${sizeDeltaPct.toFixed(3)}% (${a.length} -> ${b.length} bytes)`);
  if (sizeDeltaPct > 1) {
    console.log("VERDICT: large structural change — head pose LIKELY honored (confirm visually: before.png vs after.png)");
  } else {
    console.log(
      "VERDICT: INCONCLUSIVE/NOT HONORED — view appears unchanged. Known result on emulator 0.13.1: " +
        "xr_* RPCs are accepted but the guest does not visibly apply them (see README). Inspect the PNGs to confirm.",
    );
  }
}

report("xr_recenter", await client.callTool({ name: "xr_recenter", arguments: {} }));

await client.close();
console.log(`\nLive test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
