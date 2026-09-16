# Task R5 — Check public documentation deterministically

**Status:** DONE
**Worktree:** `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-release-2026-09-15` (branch `track/cli050-release`)
**Commits:** `91a81a0` — `test: make public documentation checks reproducible`; `ff50473` — `test: refuse a public-doc path that climbs out of the checkout` (self-review finding; neither pushed)
**Base:** `62ef21a` (Tasks R1–R4 complete and reviewed)

---

## What I implemented

### The defect

`test/docsmeta.mjs:56–80` chose its file set by listing the working tree — `fs.readdirSync(repoRoot)`
for root `*.md` plus a recursive walk of `docs/`. A developer checkout carries gitignored root notes
(`/CLAUDE.md`, `/PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md`, `HANDOFF.md`, `NEXT-AGENT-PROMPT.md` — all
four are in `.gitignore:21,22,43,44`) that a clean CI checkout does not. So one command graded two
different sets of documents depending on where it ran. Measured, not asserted (see
**Clean-checkout parity** below): with those four notes present, the pre-change gate **failed 4 and
exited 1** locally while the identical command **passed with 0 failures** in a clean checkout of the
same commit.

### `scripts/public-docs.mjs` (new, 190 lines) — selection and link validation, pure

| Export | Behaviour |
| --- | --- |
| `publicMarkdownFiles({root, trackedPaths})` | `string[]`. The brief's filter — `.md` and (no `/` or `docs/` prefix) — plus a refusal of any `..` segment, deduplicated and `.sort()`ed with the **default** comparator (code-unit order, locale-independent; `localeCompare` would have put `docs/a.md` before `README.md`). Throws `TypeError` naming `trackedPaths` if the caller supplies none or a non-string entry. |
| `relativeLinkReport({root, files})` | `{links: number, failures: Array<{file,target,reason}>}`. The count exists because the gate's success line publishes it. |
| `relativeLinkFailures({root, files})` | `relativeLinkReport(...).failures`. |
| `parseTrackedPaths(stdout)` | `git ls-files -z` output → paths. NUL-separated, so a space in a filename survives. Tolerates a trailing separator and empty output. |
| `parsePackagedInventory(text)` | `["path", …]` or `{"files":["path", …]}`; refuses anything else with a message naming `files` / `inventory`. |
| `LINK_FAILURE_REASONS` | The closed vocabulary: `missing`, `escapes-checkout`, `undecodable`, `unreadable`. |

**`publicMarkdownFiles` never touches the filesystem.** That is the whole mechanism: an untracked
note cannot move the result because no code path exists that could read one. `root` is accepted for
call-site symmetry and deliberately ignored, which the module header states.

**Link validation**, in order, per link: strip fenced blocks and inline code (existing regexes kept
verbatim — they carry example paths, not links) → take the first whitespace token of the target
(drops an optional `"title"`) → skip non-relative targets → drop `#fragment` → count it →
`decodeURIComponent` → resolve against the document's own directory → **containment** → existence.

- *Containment before existence*, deliberately: `docs/escape.md -> /elsewhere/secret.md` exists
  perfectly well and is still not a link this repository can publish. `resolveThroughLinks` climbs to
  the nearest **existing** ancestor, `realpath`s that, and re-appends the not-yet-existing tail, so a
  symlink anywhere along the existing part is followed. Both sides of the comparison are realpath'd,
  which matters on macOS where the temp root is itself symlinked.
- *Decoding*: `a%20b.md` now finds `a b.md`; a malformed escape (`bad%zz.md`) is reported as
  `undecodable` instead of throwing out of the gate.
- *Exclusions*: previously `^(https?:|mailto:|#|<)`. Now any scheme (`[A-Za-z][A-Za-z0-9+.-]*:`),
  protocol-relative `//host/…`, fragment-only, and angle-bracket autolinks. **This is a deliberate
  widening** (`tel:`, `ftp:`, `vscode:` are absolute URLs, not repository paths) and is the one
  behaviour change that is not strictly conservative — noted under Concerns. It changed nothing here:
  the same 162 links across the same 72 files, 0 failures, before and after.
- *`unreadable`*: a selected document that cannot be read (staged then deleted) is a failure with
  `target: ""`, not a thrown gate.

### `test/docsmeta.mjs` — the gate that feeds it real Git output

- **Default:** `spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "*.md"], {shell:false, timeout:60_000})`
  → `parseTrackedPaths` → `publicMarkdownFiles` → `relativeLinkReport`. `ls-files` reads the **index**,
  so documents staged for the current commit are graded in the run that introduces them.
- **No Git metadata → a clear failure, never a scan.** `public docs: not a git checkout — <detail>.
  Run this gate from a git checkout, or pass --packaged <inventory.json> for a source-less install.
  This gate never falls back to scanning the tree.`
- **`--packaged <inventory.json>` / `--packaged=…`** is the source-less installed-tarball path and
  must be asked for by name.
- **`--local`** prints its own heading — `-- --local: untracked local markdown (warnings only; never
  part of the gate result) --` — lists the local files and their link failures as `WARN`, and touches
  neither `publicDocs` nor `failures`.
- Unknown argument → usage on stderr, exit 2.
- Sections **(a)** version-everywhere, **(b)** `sync-metadata --check`, and **(d)** homepage/origin are
  byte-for-byte unchanged (verified in the diff).
- The success line is mode-accurate: `… (72 git-tracked files: …)` vs `… (72 files named by the
  packaged inventory: …)`.

### `scripts/gate-inventory.mjs` — one line

`"test:docsmeta"` gains a second argv: `["node","--test","test/public-docs.mjs"]`. **No new gate**,
so no `package.json` script, no `gates.yml` step, and no published count changes: gate entries are
53 at `62ef21a` and 53 now, and `test:lint` still prints `53 invocations / 52 test: suites; linux 50,
windows 1, macos 2`. `package.json` and `.github/workflows/gates.yml` are untouched.

---

## TDD: RED → GREEN

**RED 1** — `test/public-docs.mjs` written first, before `scripts/public-docs.mjs` existed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../.worktrees/cli050-track-release-2026-09-15/scripts/public-docs.mjs'
  imported from .../test/public-docs.mjs
✖ test/public-docs.mjs (27.779541ms)
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

**RED 2** — after implementing the module but before touching `test/docsmeta.mjs` or the gate entry,
exactly the two wiring tests failed and every behavioural test already passed:

```
ℹ tests 23  ℹ pass 21  ℹ fail 2

✖ test/docsmeta.mjs selects through git ls-files and refuses to guess without it
  AssertionError: the gate must use the shared selector
    expected: /publicMarkdownFiles/   (actual: the 98-line filesystem-scan gate)
✖ the docs gate runs this suite
  AssertionError: test:docsmeta must run test/public-docs.mjs
```

**GREEN** — 23/23, then 24/24 after the self-review clause below.

---

## Tests and results (all host-executed in this worktree, after `npm run build`)

| Command | Result |
| --- | --- |
| `npm run build` | `published 182 file(s) for source 209366c3ebda` |
| `node --test test/public-docs.mjs` | **24 pass / 0 fail** |
| `npm run test:docsmeta` | **Failures: 0** — `all 162 relative markdown links resolve (72 git-tracked files: root *.md + docs/**)`, plus **24 pass / 0 fail** |
| `node --test test/gate-inventory.mjs` | **31 pass / 0 fail** |
| `npm run test:lint` | `Lint fixture test done. Failures: 0`; **42 pass / 0 fail** |
| `npm run test:distribution-adoption` | **43 pass / 0 fail** |
| `git diff --check` | clean |

**Baseline at `62ef21a`**, for comparison: `all 162 relative markdown links resolve (72 files: root
*.md + docs/**)`, Failures: 0. Identical count, identical files — the change is a change of
*provenance*, not of verdict.

### Behavioural proofs against the real repository

| Scenario | Command | Result |
| --- | --- | --- |
| Untracked note with a broken link, **pre-change gate** | `node test/docsmeta-old-oneshot.mjs` (`git show HEAD:test/docsmeta.mjs`) | `FAIL NEXT-AGENT-PROMPT.md: broken relative link -> docs/NOT-A-REAL-FILE.md`; **exit 1** |
| Same note, **post-change gate** | `node test/docsmeta.mjs` | `ok all 162 … (72 git-tracked files …)`; **exit 0** |
| Same note, `--local` | `node test/docsmeta.mjs --local` | `WARN 1 local file(s) outside the public set: NEXT-AGENT-PROMPT.md` / `WARN … missing relative link -> docs/NOT-A-REAL-FILE.md`; **exit 0** |
| **Tracked** broken link (staged, uncommitted `docs/TEMP-BROKEN-LINK-PROOF.md`) | `node test/docsmeta.mjs` | `FAIL docs/TEMP-BROKEN-LINK-PROOF.md: missing relative link -> ./NOT-A-REAL-FILE.md`; **exit 1** — proves staged docs are graded *and* that real failures still fail |
| No Git metadata | `GIT_DIR=/nonexistent/gitdir node test/docsmeta.mjs` | `FAIL public docs: not a git checkout — fatal: not a git repository: '/nonexistent/gitdir'. …`; **exit 1** |
| `git` binary absent | `env PATH=/nonexistent "$(command -v node)" test/docsmeta.mjs` | `FAIL public docs: not a git checkout — spawnSync git ENOENT. …`; **exit 1** |
| Packaged inventory, no Git | `GIT_DIR=/nonexistent/gitdir node test/docsmeta.mjs --packaged <inv>` | `ok public docs: 72 file(s) named by the packaged inventory …` / `ok all 162 …`; **exit 0** |
| Malformed inventory | `node test/docsmeta.mjs --packaged bad-inventory.json` | `FAIL public docs: packaged inventory … is unusable — packaged document inventory is not JSON: …`; **exit 1** |
| Unknown argument | `node test/docsmeta.mjs --nope` | `docsmeta: unknown argument --nope` + usage; **exit 2** |

All temporary artifacts (`NEXT-AGENT-PROMPT.md`, `docs/TEMP-BROKEN-LINK-PROOF.md`,
`test/docsmeta-old-oneshot.mjs`, the staged index entry) were removed; `git status` is clean.

### Fixtures in `test/public-docs.mjs` (24 tests, all real temp checkouts)

Each fixture is a `mkdtemp` base holding `checkout/` and a sibling `outside/`, both realpath'd.
Covered: the brief's two snippets verbatim; nested tracked Markdown outside `docs/` (`evidence/**`,
`briefs/**`, `.claude/**`, `test/fixtures/**`, and the `docsite/` near-miss); code-unit ordering and
dedup, order-independent; **selection with untracked notes physically present on disk**; `..`-climbing
and absolute inventory paths; `parseTrackedPaths` / `parsePackagedInventory`; the broken-link record
shape; percent-encoded resolve **and** miss; malformed escape; **a real symlink to a file outside the
checkout** (asserting `fs.existsSync` is true first, so the test proves containment and not
absence); `../../` escape; a climb that returns inside; scheme / protocol-relative / fragment-only /
autolink exclusions; fragment stripping; fence and inline-code stripping; image links and titles;
unreadable document; link counting; and **a real `git init` + `git add`** proving a staged-uncommitted
`docs/…HANDOFF…md` is selected while a `.gitignore`d `LOCAL-NOTES.md` and `CLAUDE.md` — both carrying
broken links — are not. Two structural tests keep the wiring from silently regressing: `docsmeta`'s
source must reference `publicMarkdownFiles`, `"ls-files"`, `"-z"`, `shell: false`, `not a git
checkout` and `--packaged`; and `GATES["test:docsmeta"]` must run this suite.

---

## Clean-checkout parity

Per the controller's resolution 4, via `git worktree add --detach <scratchpad>/parity-checkout HEAD`
(removed afterwards with `git worktree remove --force`; `git worktree list` confirms only the
pre-existing worktrees remain, none touched).

To make the comparison meaningful, the developer checkout was given all four documented gitignored
notes — `CLAUDE.md`, `HANDOFF.md`, `NEXT-AGENT-PROMPT.md`, `PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md` —
each containing `[plan](docs/NOT-A-REAL-FILE.md)`. `git status` stayed at 0 entries (they are
ignored); the clean worktree had 11 root `*.md`, the developer worktree 15.

**Post-change (this commit) — identical:**

```
########## DEVELOPER CHECKOUT (4 local notes present) ##########
  ok   all 162 relative markdown links resolve (72 git-tracked files: root *.md + docs/**)
Docs/metadata gate done. Failures: 0
exit=0
ℹ tests 23  ℹ pass 23  ℹ fail 0

########## CLEAN TEMPORARY CHECKOUT of HEAD ##########
  ok   all 162 relative markdown links resolve (72 git-tracked files: root *.md + docs/**)
Docs/metadata gate done. Failures: 0
exit=0
ℹ tests 23  ℹ pass 23  ℹ fail 0
```

The selected file set is not merely the same size but byte-identical — the 72 paths plus
`LINKS=162 FAILURES=0` dumped from each checkout `diff` clean and share one digest:

```
50423d87b6802c3a4fbdcb90a58cc8bad2614a0cfc89ddb9da169de33738df4c  set-dev.txt
50423d87b6802c3a4fbdcb90a58cc8bad2614a0cfc89ddb9da169de33738df4c  set-clean.txt
```

**Pre-change (`HEAD~1`'s `test/docsmeta.mjs`, run in both checkouts) — the divergence this task
removes:**

```
########## PRE-CHANGE gate, developer checkout ##########
  FAIL CLAUDE.md: broken relative link -> docs/NOT-A-REAL-FILE.md
  FAIL HANDOFF.md: broken relative link -> docs/NOT-A-REAL-FILE.md
  FAIL NEXT-AGENT-PROMPT.md: broken relative link -> docs/NOT-A-REAL-FILE.md
  FAIL PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md: broken relative link -> docs/NOT-A-REAL-FILE.md
Docs/metadata gate done. Failures: 4          exit=1

########## PRE-CHANGE gate, clean checkout ##########
  ok   all 162 relative markdown links resolve (72 files: root *.md + docs/**)
Docs/metadata gate done. Failures: 0          exit=0
```

(The `test:docsmeta` count reads 23 above because parity was measured before the self-review clause
and its 24th test landed; the final suite is 24/24 in both modes.)

---

## Files changed

| File | Change |
| --- | --- |
| `scripts/public-docs.mjs` | **new**, 190 lines. Selection + link validation, pure over supplied inputs. |
| `test/public-docs.mjs` | **new**, 325 lines, 24 tests. |
| `test/docsmeta.mjs` | 98 → 169 lines. Mode parsing added; section (c) replaced (28 lines of filesystem scan removed); section (c2) `--local` added. Sections (a), (b), (d) untouched. |
| `scripts/gate-inventory.mjs` | one line: `test:docsmeta` also runs `test/public-docs.mjs`. |

Not touched: `src/**`, `package.json`, `.github/workflows/gates.yml`, `scripts/verify-tarball.mjs`,
`scripts/sync-metadata.mjs`, `test/smoke*.mjs`, `test/sdk-integration.mjs`, every policy block, and
every document.

**Doc links fixed: none — none were broken.** Before touching the gate I ran the new validator over
the real tracked set and got `files: 72  links: 162  failures: 0`, so no prose change was needed or
made. The diff contains no `.md` file.

---

## Self-review

**Completeness.** All six brief checkboxes and all five controller resolutions are satisfied and
evidenced above: both interfaces exactly as specified; the five required fixture kinds; RED retained;
deterministic selection including staged docs; decode + containment + missing rejection;
HTTP/mail/fragment still excluded; code-block stripping and the version/manifest checks preserved
verbatim; untracked notes proven inert; `--packaged` explicit-only; `--local` separate and
warning-only; parity recorded with digests.

**Discipline.** Ownership boundaries respected. The controller's preference was followed —
`test/public-docs.mjs` was added to the existing `test:docsmeta` gate command, so no gate count,
workflow step, package script or published doc count moved. The byte-pinned pico-cli policy blocks
were not read, edited or paraphrased; no document was edited at all.

**Testing.** Real temp fixtures throughout — real symlinks, real percent-encoded filenames, a real
`git init`/`git add` — plus the eight real-repository behavioural probes above, each with its exit
code, and every artifact cleaned up. Output is pristine: 24/31/42/43 pass, 0 fail, `git diff --check`
clean, `git status` clean.

**One finding, fixed (commit `ff50473`).** Link *targets* were required to stay inside the checkout
but the document list was not: `docs/../../elsewhere.md` satisfied `startsWith("docs/")`. Unreachable
in the default path (`git ls-files` never emits a `..` segment) but reachable through a hand-written
`--packaged` inventory. Closed with one filter clause plus a test; absolute paths were already
rejected by the existing clause. I used a **second commit rather than `--amend`**, because the global
constraints say "never rewrite history" without qualification.

---

## Concerns

1. **The scheme exclusion was widened**, from `https?:|mailto:` to any URI scheme plus
   protocol-relative `//host`. This is the only non-conservative behaviour change. A Windows-style
   `C:\path` target would now be skipped as an absolute URL where it was previously checked (and
   would have failed as missing). No such link exists — the before/after link total is identical at
   162 — and markdown renderers treat `C:\…` as a URL too, but it is a real loosening and a reviewer
   may prefer the two-scheme list.
2. **`--packaged` has no producer.** Nothing in this repository writes an inventory JSON, and no
   gate invokes the mode; it exists so a source-less tarball fails loudly rather than silently
   scanning. If R6/R7 wants the installed tarball to self-check its docs, someone must generate and
   pack the inventory. Unverified: I have not run the mode from inside an actual installed tarball,
   only from this checkout with `GIT_DIR` redirected.
3. **The two wiring tests are source-text assertions**, not behaviour. `test/docsmeta.mjs` resolves
   its own root from `import.meta.url` and calls `process.exit`, so the no-Git path cannot be
   exercised from inside `node --test` without adding a root override I judged to be scope creep. The
   path is proven instead by the two real-repository probes (`GIT_DIR` redirected, `PATH` without
   git), which are recorded above but are not re-run by CI.
4. **`--local` is not covered by an automated test.** It is warning-only and cannot affect the gate
   result — that much is structural — but its walk of untracked `docs/**` is proven only by the
   manual run recorded above.
5. **Platform scope.** Everything here was executed on macOS (Darwin 27.0.0, Node v25.8.1) against
   this worktree. `test:docsmeta` is a Linux-lane gate; the code uses Node-20-safe APIs only and is
   path-separator agnostic, but it has not been run on Linux or Windows in this task. CI's Node 20/22
   Linux lane is the first real execution of it.
6. **Host-only fixture evidence.** No emulator, device, network, release, tarball or visual claim is
   made or implied by this task.

---

# Fix round 1 — document-path containment (review finding, Important)

**Commit:** `ff5fa8d` — `test: refuse a public document that resolves outside the checkout` (not pushed)
**Base:** `ff50473`

## The finding, confirmed

The reviewer was right, and the RED output made the mechanism visible rather than merely asserted.
`relativeLinkReport` opened every selected document with
`fs.readFileSync(path.join(root, file), "utf8")` and no containment check on `file` itself, while
targets found *inside* that content did get one via `withinRoot`. `publicMarkdownFiles` cannot cover
this: selection is deliberately filesystem-free — the property that makes an untracked note inert —
so it can only judge a path lexically, and `docs/evil.md` is lexically innocent whatever it points
at. `git ls-files` records a symlink as an ordinary entry (`120000 …  docs/evil.md`), and a
hand-written `--packaged` inventory is not trusted at all.

My fixtures made the outside file carry a link of its own, so the pre-fix behaviour reported:

```
✖ a selected document that is itself a symlink out of the checkout is refused, unread
  actual:   [ { file: 'docs/evil.md', target: './definitely-not-here.md', reason: 'missing' } ]
  expected: [ { file: 'docs/evil.md', target: '',                        reason: 'escapes-checkout' } ]
✖ a packaged inventory cannot smuggle in a document that resolves outside the checkout
  (same actual/expected)
ℹ tests 26  ℹ pass 24  ℹ fail 2
```

`./definitely-not-here.md` exists only in the file **outside** the checkout — the actual failure is
therefore direct proof that the outside document was opened and scanned.

## What changed

1. **`scripts/public-docs.mjs`** — `relativeLinkReport`'s per-file loop now computes `absolute` once
   and runs the existing `withinRoot(rootReal, absolute)` **before** the read, pushing
   `{file, target: "", reason: "escapes-checkout"}` and skipping the document. The link-resolution
   line reuses `absolute` instead of recomputing `path.join(root, file)`. The
   `LINK_FAILURE_REASONS` comment now records that `escapes-checkout` covers the document as well as
   its targets. Exactly the fix specified; no other behaviour touched.
2. **`test/public-docs.mjs`** — the two fixtures the controller asked for, both asserting
   `report.links === 0` so that "refused" cannot be confused with "empty":
   - `a selected document that is itself a symlink out of the checkout is refused, unread` — asserts
     `fs.existsSync` on the symlink first, so the test proves containment rather than absence.
   - `a packaged inventory cannot smuggle in a document that resolves outside the checkout` — drives
     `parsePackagedInventory` → `publicMarkdownFiles` → `relativeLinkReport`, and asserts that
     selection *does* return `docs/evil.md` (lexical selection cannot see through a symlink), so the
     refusal is demonstrably happening at the validation layer where it belongs.
3. **`test/docsmeta.mjs`** — the failure line was wrong for this class. The first probe printed
   `docs/evil.md: escapes-checkout relative link -> (the document itself could not be read)`: it is
   not a link failure, and the document *could* have been read — we refused to. A new
   `describeDocFailure` helper names the link for a link failure and the document for a
   document-level one, used by both the public report and `--local`.

## Tests and results (host-executed in this worktree)

| Command | Result |
| --- | --- |
| `npm run build` | `published 182 file(s) for source 209366c3ebda` |
| `node --test test/public-docs.mjs` | **26 pass / 0 fail** (was 24; RED first at 24 pass / 2 fail) |
| `npm run test:docsmeta` | **Failures: 0** — `all 162 relative markdown links resolve (72 git-tracked files: root *.md + docs/**)`, plus **26 pass / 0 fail** |
| `node --test test/gate-inventory.mjs` | **31 pass / 0 fail** |
| `npm run test:lint` | `Lint fixture test done. Failures: 0`; **42 pass / 0 fail** |
| `npm run test:distribution-adoption` | **43 pass / 0 fail** |
| `git diff --check` | clean |

`test:lint` and `test:distribution-adoption` were re-run beyond the requested set because
`test/docsmeta.mjs` changed again.

### Gate-level probe — a real tracked symlink out of the checkout

`docs/evil.md -> <scratchpad>/outside-secret.md`, `git add`ed so the default path really sees it
(`git ls-files -s` → `120000 2c72940513e88d7becf2a78ce201f102c5f50a5c 0  docs/evil.md`), and the
content readable through the link (`head -1` → `# Outside the checkout`).

```
########## default git path (tracked symlink) ##########
  FAIL docs/evil.md: the document resolves outside the checkout and was not read
Docs/metadata gate done. Failures: 1          exit=1

########## --packaged path (inventory naming it) ##########
  ok   public docs: 2 file(s) named by the packaged inventory …/evil-inventory.json
  FAIL docs/evil.md: the document resolves outside the checkout and was not read
Docs/metadata gate done. Failures: 1          exit=1

########## ordinary broken link still reads as a link failure ##########
  FAIL docs/TEMP-LINK-PROOF.md: missing relative link -> ./NOT-A-REAL-FILE.md
```

Both temporary documents were `git rm --cached`ed and deleted; `git status` is clean and the real
gate still reports the unchanged 162 links across 72 files.

**No ledgered Minor item was touched**, and no document was edited.

## Concerns after this round

The five concerns recorded above stand unchanged, with one narrowing: concern 2 (`--packaged` has no
producer) is now less dangerous, because an inventory that names a document outside the checkout is
refused rather than silently graded. It is still true that no producer exists and that I have not run
the mode from inside a real installed tarball.

One note for the reviewer: the fix protects against a document that *resolves* outside the checkout.
A tracked symlink pointing to another file **inside** the checkout is still followed and graded,
which is correct — it is this repository's own content either way.
