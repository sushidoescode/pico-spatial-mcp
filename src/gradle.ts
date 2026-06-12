import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, ok, run, tail } from "./util.js";
import { gradleEnv } from "./toolchain.js";

function findArtifacts(projectDir: string, exts: string[], maxDepth = 8): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || found.length > 50) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // only descend into build trees once past the module level to keep this fast
        walk(p, depth + 1);
      } else if (exts.some((x) => e.name.endsWith(x)) && p.includes(`${path.sep}build${path.sep}`)) {
        found.push(p);
      }
    }
  };
  walk(projectDir, 0);
  return found;
}

export function registerGradleTools(server: McpServer) {
  server.registerTool(
    "gradle_build",
    {
      description:
        "Run a Gradle task in a PICO spatial Android project (./gradlew). The com.pico.spatial.tools plugin auto-wires spatial_pack_task into assemble, so 'assembleDebug' compiles scenes AND builds the APK. Use task 'spatial_pack_task' (optionally ':module:spatial_pack_task') to only compile scene bundles. Returns build output tail plus produced .apk/.bundle artifacts.",
      inputSchema: {
        projectDir: z.string().describe("Android project root containing gradlew"),
        task: z.string().default("assembleDebug").describe("Gradle task, e.g. assembleDebug, :editor-asset:spatial_pack_task"),
        extraArgs: z.array(z.string()).default([]).describe("Extra Gradle CLI args, e.g. ['--info']"),
        timeoutSec: z.number().int().default(900),
      },
    },
    async ({ projectDir, task, extraArgs, timeoutSec }) => {
      const dir = expandHome(projectDir);
      const gradlew = path.join(dir, "gradlew");
      if (!fs.existsSync(gradlew)) return fail(`No gradlew at ${gradlew}`);
      const before = new Set(findArtifacts(dir, [".apk", ".bundle"]));
      const r = await run(gradlew, [task, "--console=plain", ...extraArgs], {
        cwd: dir,
        timeoutMs: timeoutSec * 1000,
        env: gradleEnv(),
      });
      const combined = (r.stdout + "\n" + r.stderr).trim();
      const artifacts = findArtifacts(dir, [".apk", ".bundle"]).map((p) => ({
        path: p,
        sizeMB: Number((fs.statSync(p).size / 1024 / 1024).toFixed(2)),
        new: !before.has(p),
        mtime: fs.statSync(p).mtime.toISOString(),
      }));
      if (r.code !== 0) {
        return fail(`Gradle '${task}' failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}):\n${tail(combined, 100)}`);
      }
      return ok(
        `Gradle '${task}' succeeded.\n\nArtifacts:\n${artifacts.map((a) => `- ${a.path} (${a.sizeMB} MB${a.new ? ", NEW" : ""}, ${a.mtime})`).join("\n") || "(none found)"}\n\nOutput tail:\n${tail(combined, 40)}`,
      );
    },
  );

  server.registerTool(
    "gradle_tasks",
    {
      description: "List the spatial-related Gradle tasks available in a project (filters ./gradlew tasks --all for spatial/assemble/install).",
      inputSchema: { projectDir: z.string() },
    },
    async ({ projectDir }) => {
      const dir = expandHome(projectDir);
      const gradlew = path.join(dir, "gradlew");
      if (!fs.existsSync(gradlew)) return fail(`No gradlew at ${gradlew}`);
      const r = await run(gradlew, ["tasks", "--all", "--console=plain"], { cwd: dir, timeoutMs: 300_000, env: gradleEnv() });
      if (r.code !== 0) return fail(tail(r.stdout + r.stderr, 60));
      const lines = r.stdout.split("\n").filter((l) => /spatial|assemble|install.*Debug|bundle/i.test(l));
      return ok(lines.join("\n") || "(no matching tasks)");
    },
  );
}
