import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * dataconnect.ts — v10.20 (P18): REAL-WORLD data connectors.
 *
 * Binds a live external API to the spatial lane. connect_data_source fetches a real source NOW
 * (weather / github / crypto / a custom URL+map), normalizes it to {key,label,value} fields, and
 * returns the live values PLUS a ready-to-run host poller and a generate_live_data_panel binding —
 * so a P13 panel (or a Scene3D.data() 3D scene) shows real, updating data. Turns the tool from a
 * demo generator into a real monitor/viz bridge.
 */

const pick = (o: any, pathStr: string): any => pathStr.split(".").reduce((a, k) => (a == null ? a : a[/^\d+$/.test(k) ? Number(k) : k]), o);

type Src = { url: string; map: { key: string; label: string; path: string; suffix?: string }[] };

function resolveSource(source: string, config: any): Src {
  if (source === "weather") {
    const lat = config?.lat ?? 37.77, lon = config?.lon ?? -122.42;
    return {
      url: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`,
      map: [
        { key: "temp", label: "TEMP", path: "current.temperature_2m", suffix: "°C" },
        { key: "humidity", label: "HUMIDITY", path: "current.relative_humidity_2m", suffix: "%" },
        { key: "wind", label: "WIND", path: "current.wind_speed_10m", suffix: " km/h" },
      ],
    };
  }
  if (source === "github") {
    const repo = config?.repo ?? "facebook/react";
    return {
      url: `https://api.github.com/repos/${repo}`,
      map: [
        { key: "stars", label: "STARS", path: "stargazers_count" },
        { key: "forks", label: "FORKS", path: "forks_count" },
        { key: "issues", label: "OPEN ISSUES", path: "open_issues_count" },
      ],
    };
  }
  if (source === "crypto") {
    const ids = config?.ids ?? "bitcoin,ethereum";
    return {
      url: `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      map: ids.split(",").map((id: string) => ({ key: id, label: id.toUpperCase(), path: `${id}.usd`, suffix: " USD" })),
    };
  }
  // custom
  return { url: config.url, map: config.map };
}

export function registerDataConnectTools(server: McpServer) {
  server.registerTool(
    "connect_data_source",
    {
      description:
        "Bind a REAL external API to the spatial lane (P18). Fetches a live source NOW and normalizes it to {key,label,value} fields, returning the live values PLUS (a) a host poller command that refreshes a served JSON file, and (b) a generate_live_data_panel binding so a P13 panel shows real updating data (or feed Scene3D.data() for a data-driven 3D scene). Built-in sources: 'weather' (open-meteo, no key; config {lat,lon}), 'github' (config {repo:'owner/name'}), 'crypto' (coingecko; config {ids:'bitcoin,ethereum'}), or 'custom' (config {url, map:[{key,label,path,suffix}]}). Returns the real fetched values — proof the connector works.",
      inputSchema: {
        source: z.enum(["weather", "github", "crypto", "custom"]).describe("Which real API."),
        config: z.any().optional().describe("Source config (see description)."),
        servePort: z.number().optional().describe("Port for the host poller/served JSON (default 8794)."),
      },
    },
    async ({ source, config, servePort }) => {
      const src = resolveSource(source, config ?? {});
      let raw: any, fields: { key: string; label: string; value: string }[] = [], error: string | undefined;
      try {
        const res = await fetch(src.url, { headers: { "User-Agent": "pico-spatial-mcp", Accept: "application/json" } });
        raw = await res.json();
        fields = src.map.map((m) => {
          const v = pick(raw, m.path);
          return { key: m.key, label: m.label, value: v == null ? "—" : `${v}${m.suffix ?? ""}` };
        });
      } catch (e: any) { error = String(e?.message ?? e); }
      const port = servePort ?? 8794;
      const panelFields = src.map.map((m) => ({ key: m.key, label: m.label }));
      return okJson({
        status: error ? "error" : "ok",
        source,
        url: src.url,
        liveValues: fields,
        error,
        // a host poller: refresh the served JSON every 5s from the real API, normalizing to the panel keys
        pollerCommand: `while true; do curl -s '${src.url}' | node -e "const m=${JSON.stringify(src.map)};const d=JSON.parse(require('fs').readFileSync(0));const o={};for(const x of m){const v=x.path.split('.').reduce((a,k)=>a?.[k],d);o[x.key]=v==null?'—':(''+v+(x.suffix||''))}require('fs').writeFileSync('data.json',JSON.stringify(o))"; sleep 5; done &  ; adb reverse tcp:${port} tcp:${port} ; (python3 -m http.server ${port} &)`,
        panelBinding: { tool: "generate_live_data_panel", args: { packageName: "<pkg>.content", title: source.toUpperCase(), dataUrl: `http://localhost:${port}/data.json`, fields: panelFields, pollSec: 5 } },
        note: error ? "fetch failed (network?) — the connector shape is still returned." : "liveValues are REAL, fetched just now. Run pollerCommand on the host to keep data.json fresh, then build the panel with panelBinding (P13) or feed Scene3D.data() (P16).",
      });
    },
  );
}
