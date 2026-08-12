import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import {
  ensurePicoCli,
  PICO_CLI_AUTOINSTALL_ENV,
  PICO_CLI_AUTOUPDATE_ENV,
  PICO_CLI_INSTALL_TIMEOUT_MS,
} from "./picocli.js";

/** Explicit consent surface for the lazy official-CLI lane; registration itself has no side effects. */
export function registerPicoCliHealthTool(server: McpServer) {
  server.registerTool(
    "ensure_pico_cli",
    {
      description:
        "Explicitly ensure PICO's official @picoxr/pico-cli is available. If absent, this call is consent to run " +
        `a bounded (default ${PICO_CLI_INSTALL_TIMEOUT_MS / 1000}s) \`npm install -g @picoxr/pico-cli\`, then re-probe with ` +
        "`pico-cli -v` so the same MCP process can use it immediately. Healthy existing installs are a fast no-op; " +
        "a found-but-unusable CLI is never overwritten by missing-only consent. Set update:true to separately consent " +
        "to a registry version check and a bounded update/repair when stale or unusable; updates " +
        `are otherwise OFF. CLI-backed tools can do the same missing-only provisioning lazily when ${PICO_CLI_AUTOINSTALL_ENV}=1; ` +
        `automatic update checks require the separate ${PICO_CLI_AUTOUPDATE_ENV}=1 flag. Never runs either pico-cli doctor command.`,
      inputSchema: {
        update: z.boolean().optional().describe("Also check npm for a newer pico-cli and update if stale. Default false; this is separate update consent."),
      },
    },
    async ({ update }) => okJson(await ensurePicoCli({ explicit: true, update: update === true })),
  );
}
