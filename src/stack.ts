import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, run } from "./util.js";

/**
 * stack.ts — v5.3 SAFE STACKED-WORKTREE LANDING (thin git-worktree + gh wrappers).
 *
 * Each spec-node / generator change lands in its OWN git worktree, passes its OWN node-verify, and stacks
 * into a reviewable, independently-revertable chain. Also the answer to the parallel-writer clobber lesson:
 * parallel agents get ISOLATED worktrees instead of racing on shared files (HomeStage.kt). Adopt when you
 * move to PR-based review; otherwise these are optional over the direct-to-main flow.
 *   stack_new(name)    -> git worktree add -b <branch> <path> <base>
 *   stack_verify(path) -> run a verify command inside the worktree (default build+smoke)
 *   stack_land(name)   -> push the branch and (if gh present) open a PR onto the base
 */
export function registerStackTools(server: McpServer) {
  server.registerTool(
    "stack_new",
    {
      description:
        "Create an isolated git worktree + branch for a stacked change (safe parallel work — no shared-file clobber). Returns the worktree path + branch. Work in that dir, then stack_verify + stack_land.",
      inputSchema: {
        name: z.string().describe("Short kebab-case change name, e.g. 'fix-layout-arc'. Becomes branch stack/<name>."),
        repoDir: z.string().describe("The git repo root (e.g. the pico-spatial-mcp checkout)."),
        base: z.string().optional().describe("Base ref to branch from (default the current branch/HEAD)."),
      },
    },
    async ({ name, repoDir, base }) => {
      const branch = `stack/${name}`;
      const wt = path.join(repoDir, "..", ".pico-stacks", name);
      const args = ["-C", repoDir, "worktree", "add", "-b", branch, wt];
      if (base) args.push(base);
      const r = await run("git", args, { timeoutMs: 60_000 });
      if (r.code !== 0) return okJson({ status: "error", error: (r.stderr || r.stdout).trim() });
      return okJson({ status: "created", branch, worktree: wt, next: "cd into the worktree, make the change, then stack_verify then stack_land." });
    },
  );

  server.registerTool(
    "stack_verify",
    {
      description:
        "Run a verify command inside a stacked worktree (its OWN node-verify before landing). Default 'npm run build && npm run smoke'. Returns pass/fail + output tail. (The worktree needs its own deps for smoke — pass a lighter command like 'npm run build' if node_modules aren't installed there.)",
      inputSchema: {
        worktree: z.string().describe("The worktree path from stack_new."),
        command: z.string().optional().describe("Verify command (default 'npm run build && npm run smoke')."),
      },
    },
    async ({ worktree, command }) => {
      const cmd = command ?? "npm run build && npm run smoke";
      const r = await run("bash", ["-lc", cmd], { cwd: worktree, timeoutMs: 300_000 });
      const tail = (r.stdout + "\n" + r.stderr).trim().split("\n").slice(-25).join("\n");
      return okJson({ status: r.code === 0 ? "pass" : "fail", exitCode: r.code, command: cmd, output: tail });
    },
  );

  server.registerTool(
    "stack_land",
    {
      description:
        "Land a stacked change: push its branch and (if gh is installed) open a PR onto the base — an independently-revertable link in the stack. Does NOT merge automatically (review first). Set removeWorktree to clean up the worktree after pushing.",
      inputSchema: {
        worktree: z.string().describe("The worktree path from stack_new."),
        branch: z.string().describe("The branch to push, e.g. stack/fix-layout-arc."),
        base: z.string().optional().describe("PR base branch (default 'main')."),
        title: z.string().optional().describe("PR title (default the branch name)."),
        openPr: z.boolean().optional().describe("Open a gh PR after pushing (default true if gh is available)."),
        removeWorktree: z.boolean().optional().describe("Remove the worktree after landing (default false)."),
      },
    },
    async ({ worktree, branch, base, title, openPr, removeWorktree }) => {
      const push = await run("git", ["-C", worktree, "push", "-u", "origin", branch], { timeoutMs: 120_000 });
      if (push.code !== 0) return okJson({ status: "error", stage: "push", error: (push.stderr || push.stdout).trim() });
      let pr: any = "skipped";
      if (openPr !== false) {
        const gh = await run("gh", ["pr", "create", "--head", branch, "--base", base ?? "main", "--title", title ?? branch, "--body", "Stacked change landed via stack_land."], { cwd: worktree, timeoutMs: 120_000 });
        pr = gh.code === 0 ? gh.stdout.trim() : `gh unavailable/failed: ${(gh.stderr || gh.stdout).trim().slice(0, 200)}`;
      }
      let removed = false;
      if (removeWorktree) {
        const rm = await run("git", ["worktree", "remove", worktree, "--force"], { timeoutMs: 60_000 });
        removed = rm.code === 0;
      }
      return okJson({ status: "landed", pushed: branch, pr, worktreeRemoved: removed });
    },
  );
}
