/**
 * public-docs — which Markdown files are public documentation, and whether their relative links
 * resolve. Pure functions over inputs the caller supplies; nothing here decides what is tracked.
 *
 * The bug this module exists to close: the docs gate used to choose its file set by listing the
 * working tree (`fs.readdirSync(repoRoot)` plus a walk of `docs/`). A developer checkout carries
 * gitignored root notes — `CLAUDE.md`, `HANDOFF.md`, `NEXT-AGENT-PROMPT.md`, the generated pico-cli
 * plugin-context file — that a clean CI checkout does not. So the same command graded a different
 * set of documents in the two places: a local failure nobody could reproduce in CI, and a local
 * pass that said nothing about it.
 *
 * `publicMarkdownFiles` therefore never touches the filesystem. It decides from `git ls-files`
 * output alone, which is the whole reason an untracked note cannot move the result — not a rule
 * someone has to remember, but the absence of any code path that could read one.
 *
 * `root` is accepted by both entry points so call sites read alike; selection deliberately ignores
 * it, and only link validation resolves paths against it.
 */
import fs from "node:fs";
import path from "node:path";

/** The closed vocabulary of link-failure reasons. A caller may match on these. */
export const LINK_FAILURE_REASONS = Object.freeze([
  "missing", // resolves inside the checkout, but nothing is there
  "escapes-checkout", // resolves outside the checkout, directly or through a symlink
  "undecodable", // a malformed percent escape — the target cannot be turned into a path at all
  "unreadable", // the selected document itself could not be read (staged then deleted, bad mode)
]);

const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)]+)\)/g;

/**
 * Targets that are not relative paths into this checkout: any scheme (`https:`, `mailto:`, `tel:`),
 * a protocol-relative `//host/…`, a fragment-only `#anchor`, and an angle-bracket autolink. These
 * were excluded before this change and stay excluded.
 */
const NOT_A_RELATIVE_PATH = /^([A-Za-z][A-Za-z0-9+.-]*:|\/\/|#|<)/;

/** `git ls-files -z` output -> paths. NUL-separated, so a space in a filename survives intact. */
export function parseTrackedPaths(stdout) {
  return String(stdout ?? "").split("\0").filter((entry) => entry.length > 0);
}

/**
 * An explicit document inventory, for a source-less installed tarball where no Git metadata exists.
 * Accepts `["path", …]` or `{"files": ["path", …]}` and refuses anything vaguer — the point of the
 * packaged mode is that someone stated the list, not that the gate guessed it.
 */
export function parsePackagedInventory(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch (error) {
    throw new TypeError(`packaged document inventory is not JSON: ${error.message}`);
  }
  const files = Array.isArray(parsed) ? parsed : parsed?.files;
  if (!Array.isArray(files) || files.some((entry) => typeof entry !== "string")) {
    throw new TypeError('packaged document inventory must be ["path", …] or {"files": ["path", …]}');
  }
  return files;
}

/**
 * The public documentation set: tracked root `*.md` plus tracked `docs/**\/*.md`.
 *
 * Tracked means staged too, so a release checkpoint's newly `git add`ed plan and handoff documents
 * are graded in the same run that introduces them. Everything else tracked Markdown — `evidence/**`,
 * `briefs/**`, `.claude/**`, `test/fixtures/**` — is working material, not published documentation,
 * and is not held to the published-link contract.
 *
 * Sorted with the default comparator (code-unit order, locale-independent) and deduplicated, so the
 * set is byte-identical on every machine.
 */
export function publicMarkdownFiles(options = {}) {
  const { trackedPaths } = options;
  if (!Array.isArray(trackedPaths) || trackedPaths.some((entry) => typeof entry !== "string")) {
    throw new TypeError("publicMarkdownFiles requires trackedPaths: string[] — the output of `git ls-files -z`");
  }
  const selected = trackedPaths.filter((p) => p.endsWith(".md") && (!p.includes("/") || p.startsWith("docs/")));
  return [...new Set(selected)].sort();
}

/** realpath, or the lexically resolved path when nothing is there to resolve. */
function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The real location a path denotes, following symlinks as far as they actually exist.
 *
 * `fs.realpathSync` throws on a path whose tail does not exist yet, which is the common case for a
 * broken link. So climb to the nearest existing ancestor, resolve *that* through its symlinks, and
 * re-append the tail. A symlink anywhere along the existing part is followed, which is what makes
 * `docs/escape.md -> /somewhere/else.md` detectable instead of merely existing.
 */
function resolveThroughLinks(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      // not there yet — keep climbing
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    tail.unshift(path.basename(current));
    current = parent;
  }
}

function withinRoot(rootReal, absolute) {
  const real = resolveThroughLinks(absolute);
  return real === rootReal || real.startsWith(rootReal + path.sep);
}

/**
 * Every relative Markdown link in `files`, with the ones that do not hold up.
 *
 * Fenced blocks and inline code are stripped first: they carry example paths, not links. A target
 * is percent-decoded, its `#fragment` dropped, resolved against the document's own directory, and
 * then required to stay inside the checkout *and* exist. Containment is checked before existence,
 * because a symlink out of the tree exists perfectly well and is still not a link this repository
 * can publish.
 *
 * @param {{root: string, files: string[]}} options
 * @returns {{links: number, failures: Array<{file: string, target: string, reason: string}>}}
 */
export function relativeLinkReport(options = {}) {
  const { root, files } = options;
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("relativeLinkReport requires root: an absolute checkout path");
  }
  if (!Array.isArray(files) || files.some((entry) => typeof entry !== "string")) {
    throw new TypeError("relativeLinkReport requires files: string[] — checkout-relative document paths");
  }
  const rootReal = realpathOrSelf(root);
  const failures = [];
  let links = 0;

  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      failures.push({ file, target: "", reason: "unreadable" });
      continue;
    }
    const scannable = source.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const match of scannable.matchAll(MARKDOWN_LINK)) {
      const target = match[1].trim().split(/\s+/)[0]; // drop an optional "title" part
      if (!target || NOT_A_RELATIVE_PATH.test(target)) continue;
      const withoutFragment = target.replace(/#.*$/, "");
      if (!withoutFragment) continue;
      links += 1;

      let decoded;
      try {
        decoded = decodeURIComponent(withoutFragment);
      } catch {
        failures.push({ file, target, reason: "undecodable" });
        continue;
      }
      const resolved = path.resolve(path.dirname(path.join(root, file)), decoded);
      if (!withinRoot(rootReal, resolved)) {
        failures.push({ file, target, reason: "escapes-checkout" });
        continue;
      }
      if (!fs.existsSync(resolved)) failures.push({ file, target, reason: "missing" });
    }
  }

  return { links, failures };
}

/** The failures alone, for a caller that only needs to know whether anything is broken. */
export function relativeLinkFailures(options = {}) {
  return relativeLinkReport(options).failures;
}
