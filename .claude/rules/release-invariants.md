---
paths:
  - "scripts/**"
  - "package.json"
  - "*.md"
  - "docs/**/*.md"
  - "llms.txt"
---

# Release and metadata invariants

**The tool counts are a five-file chain, and three of the five fail in suites whose names give no
hint.** `scripts/verify-tarball.mjs` holds `EXPECTED_TOOLS` (macOS) and `EXPECTED_OTHER_HOST_TOOLS`,
plus the doors count hardcoded twice more. `test/distribution-adoption.mjs` regex-matches those
literals in verify-tarball's *source text*, requires the exact "255 tools on macOS … source-derived
252 on Linux and Windows …" sentence in nine docs, and requires it in two manifest descriptions;
`scripts/sync-metadata.mjs` re-derives from verify-tarball and rewrites those docs plus the host
manifests; `test/docsmeta.mjs` shells out to `sync-metadata --check`. Change a count in one place
and you get three unrelated-looking red suites instead of one clear message.

**`sync-metadata.mjs` parses `verify-tarball.mjs` as text, and a code comment is load-bearing.**
It regexes `const EXPECTED_TOOLS = <digits>`, so removing the spaces, adding a type annotation, or
making the value computed hard-exits with "its shape changed". It also derives the doors-name list
as *the run of entries before the `// core lanes` comment* — move, reword or delete that comment
and the docs gate goes down, naming a file you never touched.

**`npm run sync:meta` rewrites prose in place, broadly enough to corrupt unrelated sentences.**
Any 2–3 digit number ≥50 immediately followed by ` tools` or `-tool` in the nine stamped docs
(README, GETTING_STARTED, TESTERS, QUICKSTART, SKILLS, AGENTS, docs/HOSTS, docs/COLLABORATORS,
llms.txt) is replaced with the current tool count. Writing "the emulator exposes 120 tools" in any
of them silently becomes 255. Counts under 50 and doors-count claims only produce warnings that
never affect exit status, so a wrong doors count passes here and fails later in verify-tarball.

**The stamper is not self-maintaining for "instead of NNN" prose.** It keeps a hand-maintained
`PUBLISHED_COUNTS` history array and filters out the current value; README's "18 tools instead of
254 tools on macOS" was reachable only through that array during this count change. Change the count and you must also append the
old one, or the phrase stays wrong while `--check` reports zero drift — a staleness gate
certifying a stale number as clean.

**`.npmignore` at the root is inert.** With `files` set in `package.json` the allowlist wins, so a
`files` entry of `"tools"` packs everything beneath it, including `__pycache__` — and `.pyc` files
embed absolute author paths, which verify-tarball scans for. Deletion actually happens in
`scripts/prepack-clean.mjs`.

**`npm run build` publishes `dist/` wholesale, so an orphan cannot outlive the build that deleted
its source — but verify-tarball still derives the shipped payload from whatever `dist/*.js` it
finds.** `scripts/build-source.mjs` compiles into an owned staging tree and `publishStaging` swaps
it in synchronously: the previous `dist/` is renamed to a backup, the staging tree is renamed to
`dist/`, and the backup is removed (a failed rename puts the backup back and names it). A `.js`
left by a deleted source therefore disappears with the tree it lived in; nothing accumulates.
`dist/build-receipt.json` binds that output to the source identity that produced it, `run-gate`
refuses any `fixture`/`installed-artifact` gate — `test:tarball` included — whose receipt is
stale, and verify-tarball's `[M9]` check reads the receipt out of the *packed* copy, so the payload
it derives from `dist/*.js` (`[M1]`, the sibling directories the built modules cite) is the one
the receipt names. Invoke `scripts/verify-tarball.mjs` directly against an unbuilt or hand-edited
`dist/`, bypassing `run-gate`, and its derived payload is exactly as wrong as that directory.
