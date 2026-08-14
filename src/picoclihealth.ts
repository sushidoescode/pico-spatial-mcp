import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import {
  ensurePicoCli,
  PICO_CLI_INSTALL_TIMEOUT_MS,
} from "./picocli.js";

/** Explicit consent surface for the lazy official-CLI lane; registration itself has no side effects. */
export function registerPicoCliHealthTool(server: McpServer) {
  server.registerTool(
    "ensure_pico_cli",
    {
      description:
        "Force-refresh the registry-latest MCP-owned @picoxr/pico-cli and return its exact absolute path, version, " +
        `freshness, and policy. Provisioning is bounded (default ${PICO_CLI_INSTALL_TIMEOUT_MS / 1000}s), immutable, ` +
        "non-global, and never changes PATH or runs pico-cli setup/update --check. The deprecated update input is " +
        "accepted through 37.x but is inert: this explicit tool always force-refreshes.",
      inputSchema: {
        update: z.boolean().optional().describe("Deprecated compatibility input; accepted but inert. The tool always force-refreshes managed-latest."),
      },
    },
    async () => okJson(await ensurePicoCli({ forceRefresh: true })),
  );
}
