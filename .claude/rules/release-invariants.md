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
literals in verify-tarball's *source text*, requires the exact "254 tools on macOS … source-derived
251 on Linux and Windows …" sentence in nine docs, and requires it in two manifest descriptions;
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
of them silently becomes 254. Counts under 50 and doors-count claims only produce warnings that
never affect exit status, so a wrong doors count passes here and fails later in verify-tarball.

**The stamper is not self-maintaining for "instead of NNN" prose.** It keeps a hand-maintained
`PUBLISHED_COUNTS` history array and filters out the current value; README's "18 tools instead of
253 tools on macOS" was reachable only through that array during this count change. Change the count and you must also append the
old one, or the phrase stays wrong while `--check` reports zero drift — a staleness gate
certifying a stale number as clean.

**`.npmignore` at the root is inert.** With `files` set in `package.json` the allowlist wins, so a
`files` entry of `"tools"` packs everything beneath it, including `__pycache__` — and `.pyc` files
embed absolute author paths, which verify-tarball scans for. Deletion actually happens in
`scripts/prepack-clean.mjs`.

**`npm run build` never cleans `dist/`,** and verify-tarball derives the shipped payload from every
`dist/*.js` including orphans left by deleted sources.
