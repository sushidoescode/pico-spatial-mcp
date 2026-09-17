#!/usr/bin/env node
// mcpcall.mjs — DIRECT STDIO TRANSPORT probe for a pico-spatial-mcp build. It spawns the named
// entry as a child MCP server, performs the initialize handshake, and either lists tools or calls
// one tool with JSON arguments. This proves transport + tool behaviour of the exact entry it was
// pointed at; it proves NOTHING about host-plugin discovery inside Claude/Codex/Cursor.
// Usage:
//   node mcpcall.mjs --entry /abs/dist/index.js [--surface doors|full] [--cwd DIR] --list --out FILE
//   node mcpcall.mjs --entry /abs/dist/index.js [--surface doors|full] --tool NAME [--args JSON | --args-file F] --out FILE [--timeout-ms N]
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const has = (name) => argv.includes(name);
const entry = opt("--entry");
const surface = opt("--surface", "full");
const cwd = opt("--cwd", path.dirname(path.dirname(entry)));
const tool = opt("--tool");
const out = opt("--out");
const timeoutMs = Number(opt("--timeout-ms", "1800000"));
let args = {};
if (has("--args-file")) args = JSON.parse(fs.readFileSync(opt("--args-file"), "utf8"));
else if (has("--args")) args = JSON.parse(opt("--args"));
if (!entry) { console.error("--entry required"); process.exit(2); }

const startedAt = new Date().toISOString();
const stderrChunks = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd,
  env: { ...process.env, PICO_MCP_SURFACE: surface },
  stderr: "pipe",
});
const client = new Client({ name: "native-acceptance-probe", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
transport.stderr?.on("data", (d) => stderrChunks.push(d.toString()));
const serverInfo = client.getServerVersion();
const childPid = transport.pid;
const record = { probe: "direct-stdio-transport", startedAt, entry, cwd, surface, childPid, serverInfo };

try {
  if (has("--list")) {
    const listed = await client.listTools();
    record.toolCount = listed.tools.length;
    record.tools = listed.tools.map((t) => ({ name: t.name, inputKeys: Object.keys(t.inputSchema?.properties ?? {}), required: t.inputSchema?.required ?? [] }));
    record.toolsFull = listed.tools;
  } else if (tool) {
    record.tool = tool;
    record.arguments = args;
    const t0 = Date.now();
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true });
    record.elapsedMs = Date.now() - t0;
    record.isError = result.isError ?? false;
    record.content = [];
    let n = 0;
    for (const c of result.content ?? []) {
      if (c.type === "image" && out) {
        const img = `${out}.${n++}.${(c.mimeType || "image/png").split("/")[1]}`;
        fs.writeFileSync(img, Buffer.from(c.data, "base64"));
        record.content.push({ type: "image", mimeType: c.mimeType, savedTo: img, bytes: Buffer.from(c.data, "base64").length });
      } else record.content.push(c);
    }
    if (result.structuredContent) record.structuredContent = result.structuredContent;
  }
} catch (e) {
  record.error = { message: e?.message ?? String(e), code: e?.code, data: e?.data };
}
record.finishedAt = new Date().toISOString();
try { await client.close(); } catch {}
record.serverStderr = stderrChunks.join("");
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(record, null, 2)); }
const summary = { serverInfo, childPid, surface, tool: tool ?? (has("--list") ? "(list)" : null), toolCount: record.toolCount, isError: record.isError, error: record.error, elapsedMs: record.elapsedMs, savedTo: out };
console.log(JSON.stringify(summary));
if (record.content) for (const c of record.content) if (c.type === "text") console.log(c.text.length > 3000 ? c.text.slice(0, 3000) + `\n…[${c.text.length} chars total, full text in ${out}]` : c.text);
