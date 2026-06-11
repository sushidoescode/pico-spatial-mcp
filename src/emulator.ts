import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, okJson, run, sleep, tail } from "./util.js";
import { AVD_HOME, DISCOVERY_DIR, pickVersion, resolveToolsRoot } from "./toolchain.js";
import { adb, resolveSerial } from "./adb.js";

const LOG_DIR = path.join(os.tmpdir(), "pico-mcp");

export function listAvds(): string[] {
  if (!fs.existsSync(AVD_HOME)) return [];
  return fs
    .readdirSync(AVD_HOME)
    .filter((f) => f.endsWith(".ini"))
    .map((f) => f.replace(/\.ini$/, ""));
}

/** Parse the gRPC discovery dir the PICO emulator writes while running (port/token). */
export function readDiscovery(): Array<{ file: string; entries: Record<string, string> }> {
  if (!fs.existsSync(DISCOVERY_DIR)) return [];
  return fs
    .readdirSync(DISCOVERY_DIR)
    .filter((f) => f.endsWith(".ini"))
    .map((f) => {
      const entries: Record<string, string> = {};
      for (const line of fs.readFileSync(path.join(DISCOVERY_DIR, f), "utf8").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) entries[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return { file: path.join(DISCOVERY_DIR, f), entries };
    });
}

async function bootedSerial(): Promise<string | null> {
  const r = await adb(["devices"]);
  const serials = r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0].startsWith("emulator-") && p[1] === "device")
    .map((p) => p[0]);
  return serials[0] ?? null;
}

export function registerEmulatorTools(server: McpServer) {
  server.registerTool(
    "emulator_list",
    {
      description: "List PICO AVDs (~/.pico/avd) and any currently running emulator devices.",
      inputSchema: {},
    },
    async () => {
      const r = await adb(["devices"]).catch(() => null);
      return okJson({
        avds: listAvds(),
        adbDevices: r?.stdout.trim().split("\n").slice(1).filter(Boolean) ?? [],
        grpcDiscovery: readDiscovery(),
      });
    },
  );

  server.registerTool(
    "emulator_boot",
    {
      description:
        "Boot the PICO OS6 emulator (QEMU). Spawns it detached, waits for Android to finish booting, and returns the adb serial plus gRPC discovery info. Headless by default.",
      inputSchema: {
        avd: z.string().optional().describe("AVD name (default: the sole AVD in ~/.pico/avd)"),
        headless: z.boolean().default(true).describe("Run with -no-window (no Qt GUI)"),
        wipeData: z.boolean().default(false),
        snapshot: z.string().optional().describe("Boot from a named snapshot"),
        toolsVersion: z.string().optional().describe("Toolchain version (default: newest with an emulator payload)"),
        bootTimeoutSec: z.number().int().default(240),
        extraArgs: z.array(z.string()).default([]).describe("Additional raw emulator CLI flags"),
      },
    },
    async ({ avd, headless, wipeData, snapshot, toolsVersion, bootTimeoutSec, extraArgs }) => {
      const already = await bootedSerial();
      if (already) return fail(`An emulator is already online as ${already}. Kill it first (emulator_kill) or target it directly.`);

      const avds = listAvds();
      const name = avd ?? (avds.length === 1 ? avds[0] : undefined);
      if (!name) return fail(`Specify an AVD. Available: ${avds.join(", ") || "(none — create one in Android Studio Device Manager)"}`);

      const { root } = resolveToolsRoot();
      const sel = pickVersion(root, toolsVersion, "emulator");
      if (!sel?.emulatorBin) return fail(`No emulator binary found under ${root} (version ${toolsVersion ?? "any"})`);

      const args = ["-avd", name, "-gpu", "angle_indirect", "-grpc-use-token"];
      if (headless) args.push("-no-window");
      if (wipeData) args.push("-wipe-data");
      if (snapshot) args.push("-snapshot", snapshot);
      args.push(...extraArgs);

      fs.mkdirSync(LOG_DIR, { recursive: true });
      const logFile = path.join(LOG_DIR, `emulator-${name}-${Date.now()}.log`);
      const fd = fs.openSync(logFile, "w");
      const child = spawn(sel.emulatorBin, args, {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME },
        cwd: path.dirname(sel.emulatorBin),
      });
      child.unref();
      fs.closeSync(fd);

      const start = Date.now();
      let serial: string | null = null;
      while (Date.now() - start < bootTimeoutSec * 1000) {
        if (child.exitCode !== null) {
          return fail(
            `Emulator process exited early (code ${child.exitCode}). Log tail:\n${tail(fs.readFileSync(logFile, "utf8"), 40)}`,
          );
        }
        serial = await bootedSerial();
        if (serial) {
          const b = await adb(["-s", serial, "shell", "getprop", "sys.boot_completed"]).catch(() => null);
          if (b?.stdout.trim() === "1") break;
          serial = null;
        }
        await sleep(3000);
      }
      if (!serial) {
        return fail(
          `Timed out after ${bootTimeoutSec}s waiting for boot. PID ${child.pid}, log: ${logFile}\nLog tail:\n${tail(
            fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "",
            40,
          )}`,
        );
      }
      return okJson({
        serial,
        pid: child.pid,
        avd: name,
        emulatorBin: sel.emulatorBin,
        args,
        bootTimeSec: Math.round((Date.now() - start) / 1000),
        logFile,
        grpcDiscovery: readDiscovery(),
      });
    },
  );

  server.registerTool(
    "emulator_kill",
    {
      description: "Shut down a running PICO emulator (adb emu kill, console-auth handled automatically).",
      inputSchema: { serial: z.string().optional() },
    },
    async ({ serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "emu", "kill"]);
      await sleep(2000);
      const still = await bootedSerial();
      if (still === s) return fail(`emu kill sent but ${s} is still online: ${r.stdout} ${r.stderr}`);
      return ok(`Emulator ${s} shut down.`);
    },
  );

  server.registerTool(
    "emulator_console",
    {
      description:
        "Send an Android emulator console command via 'adb emu' (auth token handled by adb). Examples: 'sensor set acceleration 0:9.8:0', 'rotate', 'screenrecord start /sdcard/rec.webm', 'avd snapshot list'.",
      inputSchema: {
        command: z.string().describe("Console command line, e.g. 'sensor status'"),
        serial: z.string().optional(),
      },
    },
    async ({ command, serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "emu", ...command.split(/\s+/)], 30_000);
      const out = (r.stdout + r.stderr).trim();
      return r.code === 0 ? ok(out || "(ok)") : fail(out);
    },
  );

  server.registerTool(
    "emulator_status",
    {
      description: "Report running emulator state: adb presence, boot props, and gRPC discovery (port/token presence).",
      inputSchema: { serial: z.string().optional() },
    },
    async ({ serial }) => {
      const s = await bootedSerial();
      if (!s) return okJson({ running: false, grpcDiscovery: readDiscovery() });
      const target = serial ?? s;
      const props = await adb(["-s", target, "shell", "getprop"]);
      const want = ["ro.build.fingerprint", "ro.pvr.internal.version", "sys.boot_completed", "sys.pxr.product.name"];
      const picked: Record<string, string> = {};
      for (const line of props.stdout.split("\n")) {
        const m = line.match(/^\[([^\]]+)\]: \[(.*)\]$/);
        if (m && want.includes(m[1])) picked[m[1]] = m[2];
      }
      const discovery = readDiscovery().map((d) => ({
        file: d.file,
        port: d.entries["grpc.port"],
        hasToken: Boolean(d.entries["grpc.token"]),
      }));
      return okJson({ running: true, serial: target, props: picked, grpcDiscovery: discovery });
    },
  );
}
