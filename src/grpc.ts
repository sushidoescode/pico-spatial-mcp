import fs from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, image, ok, okJson } from "./util.js";
import { emulatorLibDir, pickVersion, resolveToolsRoot } from "./toolchain.js";
import { readDiscovery } from "./emulator.js";

/**
 * EXPERIMENTAL XR/gRPC layer.
 *
 * The PICO OS6 emulator (a fork of Google's Android Emulator 35.x) serves the
 * EmulatorController gRPC service on 127.0.0.1 (default port 8554) with token
 * auth published in a discovery dir. The .proto definitions ship inside the
 * user's emulator installation (<sdk>/<ver>/emulator/lib/), so we load them
 * dynamically at runtime — no PICO-owned interface definitions are vendored
 * into this repository.
 */

interface LoadedProto {
  pkgDef: protoLoader.PackageDefinition;
  controllerCtor: grpc.ServiceClientConstructor;
  protoPath: string;
}

let loaded: LoadedProto | null = null;

function loadProto(toolsVersion?: string): LoadedProto | { error: string } {
  if (loaded) return loaded;
  const { root } = resolveToolsRoot();
  const sel = pickVersion(root, toolsVersion, "emulator");
  if (!sel) return { error: `No emulator payload found under ${root}` };
  const libDir = emulatorLibDir(root, sel.version);
  const protoPath = path.join(libDir, "emulator_controller.proto");
  if (!fs.existsSync(protoPath)) return { error: `emulator_controller.proto not found at ${protoPath}` };
  try {
    const pkgDef = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [libDir],
    });
    const pkg = grpc.loadPackageDefinition(pkgDef) as any;
    const controllerCtor = pkg?.android?.emulation?.control?.EmulatorController;
    if (!controllerCtor) return { error: "android.emulation.control.EmulatorController not found in loaded proto" };
    loaded = { pkgDef, controllerCtor, protoPath };
    return loaded;
  } catch (e: any) {
    return { error: `Failed to load proto: ${e.message}` };
  }
}

function getEndpoint(): { address: string; metadata: grpc.Metadata } | { error: string } {
  const entries = readDiscovery();
  const withGrpc = entries.find((e) => e.entries["grpc.port"] || e.entries["grpc.token"]);
  const port = withGrpc?.entries["grpc.port"] ?? "8554";
  const token = withGrpc?.entries["grpc.token"];
  const metadata = new grpc.Metadata();
  if (token) metadata.set("authorization", `Bearer ${token}`);
  if (!withGrpc) {
    // No discovery file: emulator may be down, or running without -grpc-use-token.
    // We still try the default port with no auth and let the call surface the error.
  }
  return { address: `127.0.0.1:${port}`, metadata };
}

function getClient(toolsVersion?: string): { client: grpc.Client & Record<string, any>; metadata: grpc.Metadata } | { error: string } {
  const p = loadProto(toolsVersion);
  if ("error" in p) return p;
  const ep = getEndpoint();
  if ("error" in ep) return ep;
  // Raise the receive limit: a 2160px display screenshot (PNG or RGBA) exceeds the 4 MB default.
  const client = new p.controllerCtor(ep.address, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
  }) as any;
  return { client, metadata: ep.metadata };
}

function unary(client: any, method: string, request: unknown, metadata: grpc.Metadata, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (typeof client[method] !== "function") return reject(new Error(`RPC method not found in proto: ${method}`));
    const deadline = new Date(Date.now() + timeoutMs);
    client[method](request, metadata, { deadline }, (err: Error | null, resp: any) => (err ? reject(err) : resolve(resp)));
  });
}

/**
 * Grab one LIVE frame from streamScreenshot. Note: the unary getScreenshot RPC
 * returns a CACHED frame on this emulator build (verified: byte-identical across
 * calls and across visible state changes), so we stream and take the first frame.
 */
function firstStreamFrame(client: any, request: unknown, metadata: grpc.Metadata, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (typeof client.streamScreenshot !== "function") return reject(new Error("streamScreenshot RPC not found"));
    const deadline = new Date(Date.now() + timeoutMs);
    const call = client.streamScreenshot(request, metadata, { deadline });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { call.cancel(); } catch {} reject(new Error("streamScreenshot produced no frame")); }
    }, timeoutMs);
    call.on("data", (img: any) => {
      if (done) return;
      const bytes: Buffer = img?.image;
      if (bytes?.length) {
        done = true;
        clearTimeout(timer);
        try { call.cancel(); } catch {}
        resolve(Buffer.from(bytes));
      }
    });
    call.on("error", (e: any) => {
      // cancel() surfaces as a CANCELLED error after we already resolved — ignore.
      if (!done) { done = true; clearTimeout(timer); reject(e); }
    });
  });
}

/** Write a sequence of InputEvent messages over the client-streaming streamInputEvent RPC. */
function streamInput(client: any, events: unknown[], metadata: grpc.Metadata, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof client.streamInputEvent !== "function")
      return reject(new Error("streamInputEvent RPC not found in this emulator's proto"));
    const deadline = new Date(Date.now() + timeoutMs);
    const call = client.streamInputEvent(metadata, { deadline }, (err: Error | null) => (err ? reject(err) : resolve()));
    for (const ev of events) call.write(ev);
    call.end();
  });
}

const versionParam = z.string().optional().describe("Toolchain version to load protos from (default: newest)");

export function registerGrpcTools(server: McpServer) {
  server.registerTool(
    "xr_grpc_describe",
    {
      description:
        "EXPERIMENTAL: Introspect the emulator's gRPC surface as loaded from the local installation's emulator_controller.proto — lists EmulatorController RPC methods and the InputEvent fields (including xr_* head-pose events). Use this to debug field-name mismatches.",
      inputSchema: { toolsVersion: versionParam },
    },
    async ({ toolsVersion }) => {
      const p = loadProto(toolsVersion);
      if ("error" in p) return fail(p.error);
      const svc = p.pkgDef["android.emulation.control.EmulatorController"] as protoLoader.ServiceDefinition | undefined;
      const methods = svc ? Object.keys(svc) : [];
      const describeMsg = (name: string) => {
        const t = p.pkgDef[name] as any;
        return t?.type?.field?.map((f: any) => `${f.name}: ${f.typeName || f.type}`) ?? [];
      };
      return okJson({
        protoPath: p.protoPath,
        methods,
        InputEvent: describeMsg("android.emulation.control.InputEvent"),
        XrOptions: describeMsg("android.emulation.control.XrOptions"),
        XrCommand: describeMsg("android.emulation.control.XrCommand"),
        discovery: readDiscovery().map((d) => ({ file: d.file, keys: Object.keys(d.entries) })),
      });
    },
  );

  server.registerTool(
    "xr_grpc_status",
    {
      description: "EXPERIMENTAL: Call EmulatorController.getStatus over gRPC (verifies the control channel + auth works).",
      inputSchema: { toolsVersion: versionParam },
    },
    async ({ toolsVersion }) => {
      const c = getClient(toolsVersion);
      if ("error" in c) return fail(c.error);
      try {
        const resp = await unary(c.client, "getStatus", {}, c.metadata);
        return okJson(resp);
      } catch (e: any) {
        return fail(`getStatus failed: ${e.message}\nIs the emulator running with gRPC enabled? (emulator_boot uses -grpc-use-token)`);
      }
    },
  );

  server.registerTool(
    "xr_screenshot",
    {
      description:
        "Capture a LIVE screenshot of emulator display 0 via gRPC streamScreenshot (works headless; the unary getScreenshot is CACHED on this build so we stream one frame). NOTE: display 0 shows the home environment and 2D app panels — it does NOT capture host-composited immersive 3D spatial content (only the emulator GUI window shows that). Verify 3D scenes with inspect_bundle + runtime logs.",
      inputSchema: { toolsVersion: versionParam },
    },
    async ({ toolsVersion }) => {
      const c = getClient(toolsVersion);
      if ("error" in c) return fail(c.error);
      try {
        const bytes = await firstStreamFrame(c.client, { format: "PNG" }, c.metadata, 20_000);
        return image(bytes.toString("base64"), `gRPC live screenshot (${bytes.length} bytes, display 0)`);
      } catch (e: any) {
        return fail(`streamScreenshot failed: ${e.message}`);
      }
    },
  );

  server.registerTool(
    "xr_set_head_pose",
    {
      description:
        "EXPERIMENTAL (GATED — see xr_input_status): Inject 6DOF head pose via gRPC streamInputEvent (xr_head_rotation_event radians, xr_head_movement_event meters). The events are accepted, but on emulator 0.13.1 they do NOT move the rendered view: head/camera control is gated behind the GUI's WASD camera mode (virtualscene WASDInputHandler), which has no gRPC/console/keyboard entry point. Kept for forward-compat; verify any effect — do not assume it works.",
      inputSchema: {
        rotation: z
          .object({ x: z.number(), y: z.number(), z: z.number() })
          .optional()
          .describe("Head rotation in RADIANS, RELATIVE to current orientation (pitch/yaw/roll as x/y/z)"),
        movement: z
          .object({ x: z.number(), y: z.number(), z: z.number() })
          .optional()
          .describe("Head translation in meters"),
        toolsVersion: versionParam,
      },
    },
    async ({ rotation, movement, toolsVersion }) => {
      if (!rotation && !movement) return fail("Provide rotation and/or movement");
      const c = getClient(toolsVersion);
      if ("error" in c) return fail(c.error);
      const events: any[] = [];
      if (rotation) events.push({ xr_head_rotation_event: rotation });
      if (movement) events.push({ xr_head_movement_event: movement });
      try {
        await streamInput(c.client, events, c.metadata);
        return ok(`Sent ${events.length} XR head-pose event(s) (accepted by emulator; may NOT move the view — see xr_input_status): ${JSON.stringify(events)}`);
      } catch (e: any) {
        return fail(`streamInputEvent failed: ${e.message}\nTip: run xr_grpc_describe to check exact field names in this emulator build.`);
      }
    },
  );

  server.registerTool(
    "xr_input_status",
    {
      description:
        "Report what XR input IS and IS NOT drivable programmatically on the PICO emulator, based on this project's empirical testing. Call this before attempting head-pose/controller automation so you don't build on an unsupported path.",
      inputSchema: {},
    },
    async () => {
      const p = loadProto();
      const methods = "error" in p ? [] : Object.keys((p.pkgDef["android.emulation.control.EmulatorController"] as any) ?? {});
      return okJson({
        works: {
          screenshots: "streamScreenshot (live); display 0 = home env + 2D panels only",
          sensors: "setSensor / setPhysicalModel (accelerometer/gyro/etc.)",
          keys_touch: "sendKey / sendTouch / sendMouse (drive 2D UI and keyboard-mapped controller buttons)",
          xr_options: "setXrOptions / getXrOptions (passthrough coefficient, environment)",
          recenter: "xr_command RECENTER (accepted; effect unverified)",
        },
        gated_or_unavailable: {
          head_pose: "xr_head_rotation/movement accepted but NOT applied to the rendered view on 0.13.1 — gated behind the GUI's WASD camera mode (virtualscene WASDInputHandler), which has no gRPC/console/keyboard entry point",
          controller_6dof_pose: "no per-controller 6DOF pose RPC exists; controllers are keyboard-mapped (see controller_map/controller_press)",
          immersive_3d_capture: "host-composited 3D headset view is not in display-0 screenshots; only the GUI window shows it",
          hand_skeleton: "MediaPipe webcam pipeline runs in the GUI process; no injection API",
        },
        recommendation:
          "For automated scene/app verification, rely on inspect_bundle (geometry/material counts) + spatial runtime logcat + 2D-panel screenshots. Treat head-pose/immersive-capture as a GUI-only concern on this build.",
        rpcMethodCount: methods.length,
      });
    },
  );

  server.registerTool(
    "xr_recenter",
    {
      description: "EXPERIMENTAL: Send the XR RECENTER command via gRPC streamInputEvent (xr_command).",
      inputSchema: { toolsVersion: versionParam },
    },
    async ({ toolsVersion }) => {
      const c = getClient(toolsVersion);
      if ("error" in c) return fail(c.error);
      try {
        await streamInput(c.client, [{ xr_command: { action: "RECENTER" } }], c.metadata);
        return ok("RECENTER sent");
      } catch (e: any) {
        return fail(`xr_command failed: ${e.message}\nTip: run xr_grpc_describe to check the XrCommand field shape.`);
      }
    },
  );

  server.registerTool(
    "xr_set_options",
    {
      description:
        "EXPERIMENTAL: Set XR options via gRPC setXrOptions — virtual environment and/or passthrough coefficient (0..1).",
      inputSchema: {
        environment: z.string().optional().describe("e.g. LIVING_ROOM_DAY, LIVING_ROOM_NIGHT"),
        passthroughCoefficient: z.number().min(0).max(1).optional(),
        toolsVersion: versionParam,
      },
    },
    async ({ environment, passthroughCoefficient, toolsVersion }) => {
      const c = getClient(toolsVersion);
      if ("error" in c) return fail(c.error);
      const req: any = {};
      if (environment) req.environment = environment;
      if (passthroughCoefficient != null) req.passthrough_coefficient = passthroughCoefficient;
      try {
        const resp = await unary(c.client, "setXrOptions", req, c.metadata);
        return okJson({ sent: req, response: resp });
      } catch (e: any) {
        return fail(`setXrOptions failed: ${e.message}`);
      }
    },
  );

  server.registerTool(
    "xr_send_key",
    {
      description:
        "EXPERIMENTAL: Send a keyboard event via gRPC sendKey. On the PICO emulator, keys map to XR controller buttons per ~/.pico/avd/<AVD>.avd/controller_settings.ini (e.g. left controller: Q=trigger, WASD=joystick dirs, E=grip; right: U=trigger, IJKL, O=grip, Space=A).",
      inputSchema: {
        key: z.string().describe("Key string, e.g. 'q', 'w', ' ' — sent as a press+release"),
        eventType: z.enum(["keypress", "keydown", "keyup"]).default("keypress"),
        toolsVersion: versionParam,
      },
    },
    async ({ key, eventType, toolsVersion }) => {
      const c = getClient(toolsVersion);
      if ("error" in c) return fail(c.error);
      try {
        await unary(c.client, "sendKey", { eventType, text: key }, c.metadata);
        return ok(`sendKey ok: ${eventType} '${key}'`);
      } catch (e: any) {
        return fail(`sendKey failed: ${e.message}`);
      }
    },
  );
}
