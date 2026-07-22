// v27.2 baked-in mouse bridge: pidfile status logic + tool registration. Run: npm run test:bridge
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const { bridgeStatus, stopBridge } = await import("../dist/mousebridge.js");
const PIDFILE = path.join(os.homedir(), ".pico-mcp", "bridge.pid");

// preserve any real pidfile (a live bridge on a dev machine must survive this test)
const hadReal = fs.existsSync(PIDFILE) ? fs.readFileSync(PIDFILE, "utf8") : null;
const realWasAlive = hadReal != null && (() => { try { process.kill(parseInt(hadReal, 10), 0); return true; } catch { return false; } })();

try {
  if (!realWasAlive) {
    // 1. no pidfile → not running
    try { fs.unlinkSync(PIDFILE); } catch { /* ok */ }
    const none = bridgeStatus();
    !none.running && none.pid === null ? ok("no pidfile → not running") : fail(`expected not-running, got ${JSON.stringify(none)}`);

    // 2. stale pidfile (dead pid) → cleaned up + not running
    fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
    fs.writeFileSync(PIDFILE, "999999");
    const stale = bridgeStatus();
    !stale.running && !fs.existsSync(PIDFILE) ? ok("stale pidfile → cleaned + not running") : fail(`stale pidfile mishandled: ${JSON.stringify(stale)} exists=${fs.existsSync(PIDFILE)}`);

    // 3. live pid (this test process) → running; stopBridge stops "it" (SIGTERM to a pid we ignore)
    fs.writeFileSync(PIDFILE, String(process.pid));
    const live = bridgeStatus();
    live.running && live.pid === process.pid ? ok("live pid → running") : fail(`live pid mishandled: ${JSON.stringify(live)}`);
    process.once("SIGTERM", () => {}); // absorb the stop signal aimed at "the bridge"
    const stopped = stopBridge();
    stopped.stopped && !fs.existsSync(PIDFILE) ? ok("stopBridge kills pidfile process + cleans up") : fail(`stopBridge mishandled: ${JSON.stringify(stopped)}`);
  } else {
    ok(`live bridge detected (pid ${hadReal.trim()}) — pidfile scenarios skipped to not disturb it`);
  }
} finally {
  if (hadReal != null && realWasAlive) fs.writeFileSync(PIDFILE, hadReal);
}

// 4. the three tools are registered on the full surface
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, PICO_MCP_SURFACE: "full" } });
const client = new Client({ name: "bridge-test", version: "0.0.0" });
await client.connect(transport);
const names = (await client.listTools()).tools.map((t) => t.name);
for (const t of ["mouse_bridge_start", "mouse_bridge_stop", "mouse_bridge_status"]) {
  names.includes(t) ? ok(`tool registered: ${t}`) : fail(`missing tool: ${t}`);
}
const st = await client.callTool({ name: "mouse_bridge_status", arguments: {} });
const stOut = JSON.parse(st.content[0].text);
typeof stOut.running === "boolean" ? ok(`mouse_bridge_status returns shape (running=${stOut.running})`) : fail(`bad status shape: ${JSON.stringify(stOut).slice(0, 120)}`);
await client.close();

console.log(`\nMouse-bridge test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
