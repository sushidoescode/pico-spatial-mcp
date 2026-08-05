import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Run a command to completion, capturing output. Never throws on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const append = (which: "stdout" | "stderr", d: Buffer) => {
      const next = d.toString();
      const current = stdout.length + stderr.length;
      const limit = opts.maxOutputBytes;
      if (limit != null && current + next.length > limit) {
        const allowed = Math.max(0, limit - current);
        if (which === "stdout") stdout += next.slice(0, allowed); else stderr += next.slice(0, allowed);
        child.kill("SIGKILL");
        return;
      }
      if (which === "stdout") stdout += next; else stderr += next;
    };
    child.stdout.on("data", (d: Buffer) => append("stdout", d));
    child.stderr.on("data", (d: Buffer) => append("stderr", d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\nspawn error: ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Run a command capturing binary stdout (e.g. screencap PNG). */
export function runBinary(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ code: number | null; stdout: Buffer; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.concat(chunks), stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut });
    });
  });
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function tail(s: string, lines = 60): string {
  const arr = s.trimEnd().split("\n");
  return arr.length <= lines ? s.trimEnd() : `... (${arr.length - lines} lines omitted)\n` + arr.slice(-lines).join("\n");
}

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function okJson(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function image(pngBase64: string, note?: string): ToolResult {
  const content: ToolResult["content"] = [{ type: "image", data: pngBase64, mimeType: "image/png" }];
  if (note) content.push({ type: "text", text: note });
  return { content };
}
