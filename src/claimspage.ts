import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * claimspage.ts — v22 pico-verify: the PUBLIC VERIFIABLE-CLAIMS PAGE.
 *
 * The trust ledger already makes over-claims structurally impossible *inside* the pipeline. This
 * module makes the claims inspectable *outside* it: a single static, dependency-free HTML page
 * (plus a machine-readable claims.json) generated FROM the ledgers — never hand-written — where
 * every vision/device-verified row carries the capture's sha256 + dimensions. Anyone holding the
 * artifact can `shasum -a 256` it and match the page. That is the whole verification story:
 * the page cannot say more than the ledger proved.
 */

const LEDGER_DIR = path.join(os.homedir(), ".pico-mcp", "ledgers");

// Strongest first. Mirrors the trust-ledger ranking (device > emulator vision > judged > host render > runtime logs > static).
const EVIDENCE_RANK = ["device_verified", "vision_verified", "auto_judged", "usd_host_render", "logcat", "structural", "compiles", "built_for_headset"] as const;
const EVIDENCE_MEANING: Record<string, string> = {
  device_verified: "a capture from REAL PICO hardware that a human/agent eye actually looked at",
  vision_verified: "an emulator frame that was actually LOOKED at (attestation + capture hash recorded)",
  auto_judged: "scored by the calibrated visual judge against expectations — no eye on this frame",
  usd_host_render: "verified via an off-device USD host render, not the PICO runtime",
  logcat: "asserted from runtime log evidence only",
  structural: "asserted from code/bundle structure only",
  compiles: "the code compiles; behavior unverified",
  built_for_headset: "built for real-hardware capability; awaiting device verification",
};
const BADGE_COLOR: Record<string, string> = {
  device_verified: "#7ce38b",
  vision_verified: "#58d6ff",
  auto_judged: "#c8a5ff",
  usd_host_render: "#8fd0c2",
  logcat: "#ffd479",
  structural: "#ffb27a",
  compiles: "#9aa4b2",
  built_for_headset: "#e0c060",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadAllLedgers(): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  if (!fs.existsSync(LEDGER_DIR)) return out;
  for (const f of fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), "utf8"));
      if (Array.isArray(raw) && raw.length) out[f.replace(/\.json$/, "")] = raw;
    } catch { /* unreadable ledger: skip, never invent */ }
  }
  return out;
}

export function buildClaimsManifest(opts: { apps?: string[]; minEvidence?: string } = {}) {
  const ledgers = loadAllLedgers();
  const cutoff = opts.minEvidence ? EVIDENCE_RANK.indexOf(opts.minEvidence as any) : EVIDENCE_RANK.length - 1;
  const apps: any[] = [];
  const totals: Record<string, number> = {};
  for (const [app, entries] of Object.entries(ledgers)) {
    if (opts.apps?.length && !opts.apps.includes(app)) continue;
    const kept = entries.filter((e) => {
      const r = EVIDENCE_RANK.indexOf(e.evidenceType);
      return r >= 0 && r <= cutoff;
    });
    if (!kept.length) continue;
    for (const e of kept) totals[e.evidenceType] = (totals[e.evidenceType] ?? 0) + 1;
    apps.push({
      app,
      claims: kept.map((e) => ({
        seq: e.seq,
        claim: e.claim,
        evidenceType: e.evidenceType,
        attestation: e.attestation ?? null,
        artifact: e.artifactPath ? path.basename(e.artifactPath) : null,
        capture: e.capture ?? null, // {sha256,width,height,bytes,format} — the verifiable part
        cClass: e.cClass ?? null,
        deviceSerial: e.deviceSerial ?? null,
        reproHash: e.reproHash ?? null,
      })),
    });
  }
  return { apps, totals, evidenceMeaning: EVIDENCE_MEANING, evidenceRank: EVIDENCE_RANK };
}

export function renderClaimsHtml(manifest: ReturnType<typeof buildClaimsManifest>, generatedAt: string): string {
  const totalClaims = Object.values(manifest.totals).reduce((a, b) => a + b, 0);
  const badges = manifest.evidenceRank
    .filter((t) => manifest.totals[t])
    .map((t) => `<span class="badge" style="--c:${BADGE_COLOR[t]}">${t} × ${manifest.totals[t]}</span>`)
    .join(" ");
  const legend = manifest.evidenceRank
    .map((t) => `<tr><td><span class="badge" style="--c:${BADGE_COLOR[t]}">${t}</span></td><td>${esc(EVIDENCE_MEANING[t])}</td></tr>`)
    .join("\n");
  const sections = manifest.apps
    .map((a) => {
      const rows = a.claims
        .map((c: any) => {
          const cap = c.capture
            ? `<div class="cap">capture <code>${esc(String(c.capture.sha256 ?? "?"))}</code> · ${c.capture.width}×${c.capture.height} ${esc(String(c.capture.format ?? ""))} · ${c.capture.bytes} bytes${c.artifact ? ` · <code>${esc(c.artifact)}</code>` : ""}</div>`
            : "";
          const att = c.attestation ? `<details><summary>attestation (what was actually seen)</summary><p>${esc(c.attestation)}</p></details>` : "";
          const dev = c.deviceSerial ? `<div class="cap">device <code>${esc(String(c.deviceSerial))}</code></div>` : "";
          return `<li><span class="badge" style="--c:${BADGE_COLOR[c.evidenceType] ?? "#999"}">${esc(c.evidenceType)}</span> ${esc(c.claim)}${cap}${dev}${att}</li>`;
        })
        .join("\n");
      return `<section><h2>${esc(a.app)} <small>${a.claims.length} claims</small></h2><ul>${rows}</ul></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pico-spatial-mcp — verifiable claims</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:2rem;background:#0d1117;color:#e6edf3;font:15px/1.55 -apple-system,"Segoe UI",sans-serif;max-width:62rem;margin-inline:auto}
h1{font-size:1.6rem}h2{font-size:1.1rem;border-bottom:1px solid #21262d;padding-bottom:.35rem;margin-top:2.2rem}
h2 small{color:#8b949e;font-weight:400;font-size:.8rem;margin-left:.5rem}
.badge{display:inline-block;border:1px solid var(--c);color:var(--c);border-radius:999px;padding:.05rem .55rem;font-size:.72rem;font-family:ui-monospace,monospace;margin-right:.35rem;white-space:nowrap}
ul{list-style:none;padding:0}li{padding:.6rem .8rem;border:1px solid #21262d;border-radius:8px;margin:.5rem 0;background:#161b22}
code{font-family:ui-monospace,monospace;font-size:.78rem;color:#79c0ff;word-break:break-all}
.cap{color:#8b949e;font-size:.8rem;margin-top:.3rem}
details{margin-top:.35rem}summary{cursor:pointer;color:#8b949e;font-size:.8rem}details p{color:#c9d1d9;font-size:.85rem;background:#0d1117;border-left:3px solid #30363d;padding:.5rem .7rem;margin:.4rem 0 0}
table{border-collapse:collapse;font-size:.85rem}td{padding:.3rem .6rem;border-bottom:1px solid #21262d;vertical-align:top}
.how{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:.9rem 1.1rem;font-size:.88rem}
footer{color:#8b949e;font-size:.78rem;margin-top:2.5rem;border-top:1px solid #21262d;padding-top:.8rem}
</style></head><body>
<h1>pico-spatial-mcp — verifiable claims</h1>
<p>${totalClaims} claims across ${manifest.apps.length} apps, generated <b>from the trust ledger</b> — never hand-written. A claim on this page cannot say more than the ledger proved.</p>
<p>${badges}</p>
<div class="how"><b>How to verify a claim yourself:</b> every vision/device-verified row records the sha256 + dimensions of the exact frame that was looked at. Given the artifact, run <code>shasum -a 256 &lt;capture&gt;</code> and match it against the hash on this page. The machine-readable version of this page is <code>claims.json</code> beside it.</div>
<h2>Evidence classes (strongest first)</h2>
<table>${legend}</table>
${sections}
<footer>Generated ${esc(generatedAt)} by pico-spatial-mcp <code>generate_claims_page</code> · honesty invariant: verified = a frame someone LOOKED at; honest deferral &gt; silent over-claim.</footer>
</body></html>\n`;
}

export function registerClaimsPageTools(server: McpServer) {
  server.tool(
    "generate_claims_page",
    "v22 pico-verify: generate the PUBLIC verifiable-claims page from the trust ledgers (~/.pico-mcp/ledgers/*.json). Emits a static, dependency-free HTML page plus a machine-readable claims.json next to it. Every vision/device-verified claim carries the capture's sha256 + dimensions so anyone holding the artifact can `shasum -a 256` it and match the page. The page is GENERATED from the ledger — it structurally cannot assert more than was recorded. Optional filters: apps (package-name list) and minEvidence (drop rows weaker than this class).",
    {
      outDir: z.string().optional().describe("directory to write index.html + claims.json (default: <repo>/docs/claims)"),
      apps: z.array(z.string()).optional().describe("restrict to these app packages (ledger file stems)"),
      minEvidence: z.enum(EVIDENCE_RANK).optional().describe("weakest evidence class to include (default: include all)"),
    },
    async ({ outDir, apps, minEvidence }) => {
      const manifest = buildClaimsManifest({ apps, minEvidence });
      const dir = outDir ?? path.join(process.cwd(), "docs", "claims");
      fs.mkdirSync(dir, { recursive: true });
      const generatedAt = new Date().toISOString();
      const htmlPath = path.join(dir, "index.html");
      const jsonPath = path.join(dir, "claims.json");
      fs.writeFileSync(htmlPath, renderClaimsHtml(manifest, generatedAt));
      fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt, ...manifest }, null, 2));
      const totalClaims = Object.values(manifest.totals).reduce((a, b) => a + b, 0);
      return okJson({ status: "ok", htmlPath, jsonPath, apps: manifest.apps.length, claims: totalClaims, totals: manifest.totals });
    },
  );
}
