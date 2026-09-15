/**
 * public-docs — which Markdown files are *public documentation* is decided by Git, not by whatever
 * happens to be lying in a working tree.
 *
 * The failure this suite exists to prevent: `test/docsmeta.mjs` used to pick its file set with
 * `fs.readdirSync(repoRoot)` plus a walk of `docs/`. A developer checkout carries gitignored root
 * notes (`CLAUDE.md`, `HANDOFF.md`, the pico-cli plugin context file) that a clean CI checkout does
 * not, so the gate scanned a different set of files locally than in CI — a local FAIL nobody could
 * reproduce in CI, and a local PASS that proved nothing about it. Selection now comes from
 * `git ls-files`, and `publicMarkdownFiles` never touches the filesystem at all, which is precisely
 * why an untracked note cannot move the result.
 *
 * Fixtures here are real temporary checkouts — real files, a real symlink pointing out of the
 * checkout, real percent-encoded names, and (for the pipeline test) a real `git init` + `git add`
 * so the staged-but-uncommitted case is exercised the way a release actually hits it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LINK_FAILURE_REASONS,
  parsePackagedInventory,
  parseTrackedPaths,
  publicMarkdownFiles,
  relativeLinkFailures,
  relativeLinkReport,
} from "../scripts/public-docs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A throwaway checkout, plus a sibling directory that is deliberately *outside* it. Both live under
 * one realpath'd base so that macOS's symlinked temp root cannot make a containment check
 * accidentally true or accidentally false.
 */
function makeFixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "public-docs-")));
  const root = path.join(base, "checkout");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  };
  return { base, root, outside, write };
}

// ------------------------------------------------------------------------------------------------
// Selection
// ------------------------------------------------------------------------------------------------

test("publicMarkdownFiles keeps tracked root and docs Markdown, and drops everything else", (t) => {
  const { root } = makeFixture(t);
  assert.deepEqual(publicMarkdownFiles({ root, trackedPaths: ["README.md", "docs/a.md", "src/a.ts"] }),
    ["README.md", "docs/a.md"]);
});

test("nested tracked Markdown outside docs/ is not public documentation", (t) => {
  const { root } = makeFixture(t);
  const trackedPaths = [
    "README.md",
    "AGENTS.md",
    "docs/HOSTS.md",
    "docs/superpowers/plans/2026-09-15-mcp-release-reliability.md",
    "docs/evidence/locomotion-spike-2026-09-02/L0.md",
    "evidence/2026-09-15-audit/README.md",
    "briefs/README.md",
    ".claude/CLAUDE.md",
    ".claude/rules/release-invariants.md",
    "test/fixtures/agent-vault-next/knowledge/api-reference/com.pico.spatial.core.ecs.md",
    "docsite/a.md",
    "package.json",
  ];
  assert.deepEqual(publicMarkdownFiles({ root, trackedPaths }), [
    "AGENTS.md",
    "README.md",
    "docs/HOSTS.md",
    "docs/evidence/locomotion-spike-2026-09-02/L0.md",
    "docs/superpowers/plans/2026-09-15-mcp-release-reliability.md",
  ]);
});

test("selection is ordered by code unit, not by locale, and deduplicated", (t) => {
  const { root } = makeFixture(t);
  const shuffled = ["docs/z.md", "README.md", "docs/a.md", "AGENTS.md", "docs/a.md", "README.md"];
  const selected = publicMarkdownFiles({ root, trackedPaths: shuffled });
  assert.deepEqual(selected, ["AGENTS.md", "README.md", "docs/a.md", "docs/z.md"]);
  assert.deepEqual(publicMarkdownFiles({ root, trackedPaths: [...shuffled].reverse() }), selected);
});

test("selection never reads the filesystem, so an untracked note cannot join the set", (t) => {
  const { root, write } = makeFixture(t);
  write("README.md", "# readme\n");
  write("HANDOFF.md", "[broken](nowhere.md)\n");
  write("CLAUDE.md", "[broken](nowhere.md)\n");
  write("docs/a.md", "# a\n");
  const selected = publicMarkdownFiles({ root, trackedPaths: ["README.md", "docs/a.md"] });
  assert.deepEqual(selected, ["README.md", "docs/a.md"]);
  assert.deepEqual(relativeLinkFailures({ root, files: selected }), []);
});

test("publicMarkdownFiles refuses a caller that supplies no tracked paths", (t) => {
  const { root } = makeFixture(t);
  assert.throws(() => publicMarkdownFiles({ root }), /trackedPaths/);
  assert.throws(() => publicMarkdownFiles({ root, trackedPaths: "README.md" }), /trackedPaths/);
});

test("parseTrackedPaths reads NUL-separated git output, including a trailing separator", () => {
  assert.deepEqual(parseTrackedPaths("README.md\0docs/a.md\0"), ["README.md", "docs/a.md"]);
  assert.deepEqual(parseTrackedPaths("README.md\0docs/a.md"), ["README.md", "docs/a.md"]);
  assert.deepEqual(parseTrackedPaths(""), []);
  assert.deepEqual(parseTrackedPaths("docs/with space.md\0"), ["docs/with space.md"]);
});

test("parsePackagedInventory accepts an explicit list and refuses anything vaguer", () => {
  assert.deepEqual(parsePackagedInventory('{"files":["README.md","docs/a.md"]}'), ["README.md", "docs/a.md"]);
  assert.deepEqual(parsePackagedInventory('["README.md"]'), ["README.md"]);
  assert.throws(() => parsePackagedInventory("{}"), /files/);
  assert.throws(() => parsePackagedInventory('{"files":[1]}'), /files/);
  assert.throws(() => parsePackagedInventory("not json"), /inventory/i);
});

// ------------------------------------------------------------------------------------------------
// Link validation
// ------------------------------------------------------------------------------------------------

test("relativeLinkFailures reports a tracked broken link", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/a.md", "See [gone](missing.md).\n");
  assert.equal(relativeLinkFailures({ root, files: ["docs/a.md"] })[0].target, "missing.md");
});

test("a broken link carries the file, the target as authored, and a known reason", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/a.md", "See [gone](missing.md).\n");
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/a.md"] }),
    [{ file: "docs/a.md", target: "missing.md", reason: "missing" }]);
  for (const failure of relativeLinkFailures({ root, files: ["docs/a.md"] })) {
    assert.ok(LINK_FAILURE_REASONS.includes(failure.reason), failure.reason);
  }
});

test("percent-encoded targets are decoded before they are resolved", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/a b.md", "# spaced\n");
  write("docs/a.md", "[here](a%20b.md) and [gone](c%20d.md)\n");
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/a.md"] }),
    [{ file: "docs/a.md", target: "c%20d.md", reason: "missing" }]);
});

test("a malformed percent escape is a failure, not a crash", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/a.md", "[bad](bad%zz.md)\n");
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/a.md"] }),
    [{ file: "docs/a.md", target: "bad%zz.md", reason: "undecodable" }]);
});

test("a symlink that leaves the checkout fails even though the target exists", (t) => {
  const { root, outside, write } = makeFixture(t);
  fs.writeFileSync(path.join(outside, "secret.md"), "# outside the checkout\n");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "docs", "escape.md"));
  write("docs/a.md", "[out](escape.md)\n");
  assert.ok(fs.existsSync(path.join(root, "docs", "escape.md")), "the symlink must resolve, or this proves nothing");
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/a.md"] }),
    [{ file: "docs/a.md", target: "escape.md", reason: "escapes-checkout" }]);
});

test("a relative path that climbs out of the checkout fails even though the target exists", (t) => {
  const { root, outside, write } = makeFixture(t);
  fs.writeFileSync(path.join(outside, "secret.md"), "# outside the checkout\n");
  write("docs/a.md", "[up](../../outside/secret.md)\n");
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/a.md"] }),
    [{ file: "docs/a.md", target: "../../outside/secret.md", reason: "escapes-checkout" }]);
});

test("a relative path inside the checkout that climbs and comes back is fine", (t) => {
  const { root, write } = makeFixture(t);
  write("README.md", "# readme\n");
  write("docs/a.md", "[readme](../README.md)\n");
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/a.md"] }), []);
});

test("http, mailto, other schemes, protocol-relative, fragment-only and autolink targets are not checked", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/a.md", [
    "[web](https://example.com/missing.md)",
    "[plain](http://example.com/missing.md)",
    "[mail](mailto:nobody@example.invalid)",
    "[tel](tel:+15550100)",
    "[proto](//example.com/missing.md)",
    "[frag](#a-heading)",
    "[auto](<https://example.com/x>)",
    "",
  ].join("\n"));
  const report = relativeLinkReport({ root, files: ["docs/a.md"] });
  assert.deepEqual(report.failures, []);
  assert.equal(report.links, 0, "none of those are relative links");
});

test("a fragment is stripped before the target is resolved", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/b.md", "# b\n");
  write("docs/a.md", "[b](b.md#a-section) and [gone](c.md#a-section)\n");
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/a.md"] }),
    [{ file: "docs/a.md", target: "c.md#a-section", reason: "missing" }]);
});

test("fenced blocks and inline code carry example paths, not links", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/real.md", "# real\n");
  write("docs/a.md", "```\n[fenced](nope.md)\n```\n\n`[inline](alsonope.md)`\n\n[real](real.md)\n");
  const report = relativeLinkReport({ root, files: ["docs/a.md"] });
  assert.deepEqual(report.failures, []);
  assert.equal(report.links, 1);
});

test("image links and link titles are handled like the gate always handled them", (t) => {
  const { root, write } = makeFixture(t);
  write("docs/shot.png", "not really a png");
  write("docs/a.md", '![shot](shot.png)\n\n[titled](shot.png "A title")\n\n[gone](absent.png "A title")\n');
  const report = relativeLinkReport({ root, files: ["docs/a.md"] });
  assert.equal(report.links, 3);
  assert.deepEqual(report.failures, [{ file: "docs/a.md", target: "absent.png", reason: "missing" }]);
});

test("a selected file that cannot be read is a failure, not a thrown gate", (t) => {
  const { root } = makeFixture(t);
  assert.deepEqual(relativeLinkFailures({ root, files: ["docs/deleted.md"] }),
    [{ file: "docs/deleted.md", target: "", reason: "unreadable" }]);
});

test("relativeLinkReport counts every relative link it checked across every file", (t) => {
  const { root, write } = makeFixture(t);
  write("README.md", "[a](docs/a.md) [b](docs/b.md)\n");
  write("docs/a.md", "[readme](../README.md)\n");
  write("docs/b.md", "# b\n");
  const report = relativeLinkReport({ root, files: ["README.md", "docs/a.md", "docs/b.md"] });
  assert.equal(report.links, 3);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(relativeLinkFailures({ root, files: ["README.md", "docs/a.md", "docs/b.md"] }), report.failures);
});

// ------------------------------------------------------------------------------------------------
// The pipeline the gate actually runs: real git, real index, real staged-but-uncommitted docs
// ------------------------------------------------------------------------------------------------

test("git ls-files feeds selection: staged docs are in, ignored local notes are out", (t) => {
  const { base, root, write } = makeFixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, "-c", "user.email=gate@example.invalid", "-c", "user.name=gate", ...args], {
      encoding: "utf8",
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: base,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(base, "absent-global-gitconfig"),
      },
    });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };

  write(".gitignore", "LOCAL-NOTES.md\nCLAUDE.md\n");
  write("README.md", "[hosts](docs/HOSTS.md)\n");
  write("docs/HOSTS.md", "# hosts\n");
  write("evidence/2026-09-15/README.md", "[sibling](./README.md)\n");
  write("src/index.ts", "export const x = 1;\n");
  git("init", "-q");
  git("add", "-A");
  // Added to the index but never committed — exactly the shape a release checkpoint has.
  write("docs/CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md", "[plans](superpowers/plans/p.md)\n");
  write("docs/superpowers/plans/p.md", "# plan\n");
  git("add", "docs/CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md", "docs/superpowers/plans/p.md");
  // Gitignored developer notes, with a link that would fail if they were ever scanned.
  write("LOCAL-NOTES.md", "[nowhere](nowhere.md)\n");
  write("CLAUDE.md", "[nowhere](nowhere.md)\n");

  const tracked = parseTrackedPaths(git("ls-files", "-z"));
  assert.ok(tracked.includes("LOCAL-NOTES.md") === false, "git must not track an ignored note");
  const files = publicMarkdownFiles({ root, trackedPaths: tracked });
  assert.deepEqual(files, [
    "README.md",
    "docs/CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md",
    "docs/HOSTS.md",
    "docs/superpowers/plans/p.md",
  ]);
  assert.deepEqual(relativeLinkFailures({ root, files }), []);
});

// ------------------------------------------------------------------------------------------------
// The gate wiring — structural, so a later edit cannot quietly restore the filesystem scan
// ------------------------------------------------------------------------------------------------

test("test/docsmeta.mjs selects through git ls-files and refuses to guess without it", () => {
  const source = fs.readFileSync(path.join(repoRoot, "test", "docsmeta.mjs"), "utf8");
  assert.match(source, /publicMarkdownFiles/, "the gate must use the shared selector");
  assert.match(source, /"ls-files"/, "the gate must ask git which files are tracked");
  assert.match(source, /"-z"/, "tracked paths must be NUL-separated so a space in a name is safe");
  assert.match(source, /shell:\s*false/, "git must never be spawned through a shell");
  assert.match(source, /not a git checkout/, "no-git must fail with a message that names the cause");
  assert.match(source, /--packaged/, "a source-less tarball must opt in explicitly");
});

test("the docs gate runs this suite", async () => {
  const { GATES } = await import("../scripts/gate-inventory.mjs");
  assert.ok(GATES["test:docsmeta"].commands.some((argv) => argv.includes("test/public-docs.mjs")),
    "test:docsmeta must run test/public-docs.mjs");
});
