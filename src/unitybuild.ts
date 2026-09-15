import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, okJson } from "./util.js";

const run = promisify(execFile);

/**
 * unitybuild.ts — v30: one batchmode invocation, structured result. Never wraps verify_pico_apk
 * (the APK boundary IS the seam — approved decision, spec §3). PicoBuild.Apk writes
 * Builds/build-result.json; the log is evidence for humans, the JSON is the contract for tools.
 */

const HUB_EDITORS = "/Applications/Unity/Hub/Editor";

type FsLike = {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  readFileSync: (p: string, e: BufferEncoding) => string;
};

export function resolveUnityEditor(
  projectDir: string,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  fsLike: FsLike = fs as unknown as FsLike,
): { editorPath: string; version: string; source: "arg" | "env" | "hub-pinned" | "hub-any"; warning?: string } | null {
  let pinned = "";
  try {
    pinned = fsLike.readFileSync(path.join(projectDir, "ProjectSettings", "ProjectVersion.txt"), "utf8").match(/m_EditorVersion:\s*(\S+)/)?.[1] ?? "";
  } catch {
    /* unpinned project — any editor goes */
  }
  const binOf = (ver: string) => path.join(HUB_EDITORS, ver, "Unity.app", "Contents", "MacOS", "Unity");
  if (explicit) return fsLike.existsSync(explicit) ? { editorPath: explicit, version: pinned || "unknown", source: "arg" } : null;
  if (env.UNITY_EDITOR_PATH && fsLike.existsSync(env.UNITY_EDITOR_PATH))
    return { editorPath: env.UNITY_EDITOR_PATH, version: pinned || "unknown", source: "env" };
  if (!fsLike.existsSync(HUB_EDITORS)) return null;
  const installed = fsLike.readdirSync(HUB_EDITORS).filter((v) => /^\d+\./.test(v)).sort();
  if (pinned && installed.includes(pinned)) return { editorPath: binOf(pinned), version: pinned, source: "hub-pinned" };
  const any = installed[installed.length - 1];
  if (!any) return null;
  return {
    editorPath: binOf(any),
    version: any,
    source: "hub-any",
    warning: `editor version mismatch: project pins ${pinned || "(none)"}, using installed ${any} — Unity may prompt a project upgrade in batchmode; install the pinned version via Unity Hub if the build fails`,
  };
}

/** Known batchmode failure signatures -> pointed fixes (matched against the log tail). */
function pointedFix(logTail: string): string {
  if (/No valid Unity Editor license|License is not active|ULF|entitlement/i.test(logTail))
    return "Unity license is not activated for batchmode on this machine. Open Unity Hub once and sign in (a personal license activates on sign-in), then re-run. CI: `Unity -batchmode -username ... -password ...` or a license server.";
  if (/Android.*module|Android (SDK|NDK|JDK).*not (found|installed)|UnityException: Android/i.test(logTail))
    return "The editor lacks Android Build Support. Unity Hub -> Installs -> (this version) -> Add modules -> Android Build Support (+ SDK/NDK/OpenJDK), then re-run.";
  if (/executeMethod.*(not found|could not be (found|called))|class PicoBuild/i.test(logTail))
    return "PicoBuild.Apk was not found in the project — the scaffold is incomplete or was hand-edited. Re-run unity_scaffold_project into a fresh directory.";
  return "Read the log tail; the first C# or Gradle error names the cause. Re-run after fixing — the build is idempotent.";
}

export function registerUnityBuildTools(server: McpServer) {
  server.registerTool(
    "unity_build_apk",
    {
      description:
        "Build a Unity project (from unity_scaffold_project, or any project exposing PicoBuild.Apk) into an Android APK via the CONFIRMED headless path: Unity -batchmode -quit -executeMethod PicoBuild.Apk. Resolves the editor from editorPath -> $UNITY_EDITOR_PATH -> Unity Hub (preferring the project's ProjectVersion.txt pin). Reads Builds/build-result.json (structured contract — no log scraping) and returns pointed fixes for the known traps (license not activated, Android modules missing, scaffold drift). First build resolves packages and imports assets: minutes, not seconds. Verify the APK with verify_pico_apk — build and verify stay separate tools by design (the APK boundary is the seam).",
      inputSchema: {
        projectDir: z.string().describe("Unity project root (contains Assets/, Packages/, ProjectSettings/)."),
        editorPath: z.string().optional().describe("Explicit Unity binary (overrides env + Hub scan)."),
        timeoutSec: z.number().optional().describe("Build timeout in seconds (default 1200 — first import dominates)."),
      },
    },
    async ({ projectDir, editorPath, timeoutSec }) => {
      const dir = projectDir.replace(/^~\//, `${process.env.HOME}/`);
      if (!fs.existsSync(path.join(dir, "Assets", "Editor", "PicoBuild.cs")))
        return fail(`not a seam project: ${dir} has no Assets/Editor/PicoBuild.cs — scaffold with unity_scaffold_project first.`);
      const editor = resolveUnityEditor(dir, editorPath);
      if (!editor)
        return fail(`no Unity editor found (checked editorPath arg, $UNITY_EDITOR_PATH, ${HUB_EDITORS}). Install Unity 6000.4.9f1 via Unity Hub — the skeleton pins it.`);
      const logPath = path.join(dir, "Builds", "unity-build.log");
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const resultPath = path.join(dir, "Builds", "build-result.json");
      if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); // never report a stale result
      const started = Date.now();
      let execError: string | null = null;
      try {
        await run(
          editor.editorPath,
          ["-batchmode", "-quit", "-projectPath", dir, "-executeMethod", "PicoBuild.Apk", "-buildTarget", "android", "-logFile", logPath],
          { timeout: (timeoutSec ?? 1200) * 1000, maxBuffer: 64 * 1024 * 1024 },
        );
      } catch (e: any) {
        // A non-zero Unity exit lands here too; Builds/build-result.json stays the arbiter.
        execError = e.killed ? `timeout after ${timeoutSec ?? 1200}s` : e.message;
      }
      const logTail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-4000) : "(no log written)";
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        if (result.ok && fs.existsSync(result.apkPath)) {
          return okJson({
            built: true,
            apkPath: result.apkPath,
            unityVersion: result.unityVersion,
            durationSec: result.durationSec,
            editor,
            logPath,
            ...(editor.warning ? { warning: editor.warning } : {}),
            next: [`verify_pico_apk with apkPath='${result.apkPath}' and the serial of the device to observe (there is no default target; LOOK at the capture before any visual claim).`],
          });
        }
        return okJson({ built: false, error: result.error ?? "build reported not-ok", fix: pointedFix(logTail + (result.error ?? "")), logPath, logTail: logTail.slice(-1200) });
      }
      return okJson({
        built: false,
        error: execError ?? "Unity exited without writing build-result.json",
        fix: pointedFix(logTail),
        logPath,
        logTail: logTail.slice(-1200),
        tookSec: Math.round((Date.now() - started) / 1000),
      });
    },
  );
}
