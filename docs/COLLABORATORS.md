# Collaborator orientation

You know the PICO Spatial SDK deeply. You don't know this repo's vocabulary yet — that's what
this page and the [README's vocabulary primer](../README.md#vocabulary-primer) are for. Read
this once, then start from the pointers at the bottom.

## Repo layout

- **`src/`** — one TypeScript module per concern (emulator control, bundle/gradle compilation,
  codegen per SDK subsystem, the trust ledger, the doors facade, …). Every module exports a
  `registerXTools(server)` function; `src/index.ts` imports and calls each one to build the full
  MCP tool surface (239 tools on macOS and 236 on other hosts as of this writing — `npm run smoke`
  prints the exact registered count). `src/doors.ts` is the intent-level facade described in the
  README's vocabulary primer.
- **`test/*.mjs`** — the deterministic gate battery, 43 gate invocations (42 `test:` suites plus `smoke`):
  `test:lint`, `test:ledger`, `test:doors`, `test:vault`, `test:occupancy`, `test:affordance`,
  `test:eye`, `test:worldenv`, …. All of it runs headless, no emulator boot required. It's mirrored 1:1 in
  `.github/workflows/gates.yml`, which is what actually gates `main` — if a suite isn't in that
  workflow file, it isn't a real gate yet.
- **`briefs/`** — JSON brief fixtures (`{id, brief, spec}`) used by `fleet_build` and the
  SpatialBench corpus to build a batch of apps unattended.
- **`golden/`** — golden-file fixtures (a scorecard, a reference capture) that regression tests
  compare against.
- **`docs/claims/`** — a generated, filterable HTML page (`generate_claims_page`) that renders
  every trust-ledger entry as a public-style claims page — the same honesty invariant, presented
  for external review.
- **`docs/spatialbench/`** — the SpatialBench conformance/perf harness output (`run_spatialbench`):
  a corpus of briefs scored against expected scene content, headless-tier safe (no emulator-axis
  leaks in CI).

## What `.dev/` is

`.dev/` is **gitignored** — internal working docs (roadmaps, session handoffs, findings, dry-run
logs). You will not see it in a clone of this repo, and that's intentional: it's this project's
own scratch space, not published material. If a doc you're looking for is referenced by filename
under `.dev/...` in commit messages or code comments, that reference is historical context for
the original author, not something you're missing access to.

## Standing invariants

These hold across every change to this repo, not just the docs:

- **Looked-at captures for every visual claim.** No claim reaches `vision_verified` in the trust
  ledger without a linked capture a human or agent actually looked at — see the honesty invariant
  in the README.
- **Small verified commits.** Changes land in small steps, each one verified (build, test, or a
  looked-at capture) before the next, rather than large unverified batches.
- **Every gotcha becomes a lint rule or a lesson.** A discovered failure mode either gets a
  `preflight_lint` regex rule with fixtures, or a `record_lesson` / retained-lessons entry so
  `pico_fix` can match it later — it never just lives in someone's head.

## Where to start

1. **[QUICKSTART.md](../QUICKSTART.md)** — the proven first-run sequence, doors surface, with the
   two known first-run gotchas called out inline.
2. **[CAPABILITIES.md](../CAPABILITIES.md)** — the honest capability matrix: every category tagged
   with its strongest evidence class on file, regenerable anytime via `capability_matrix`.
3. **`pico_capabilities`** (doors surface) — the same matrix, live, from inside an agent session.

From there, **[SKILLS.md](../SKILLS.md)** is the agent-facing tool reference and
**[DESIGN.md](../DESIGN.md)** covers architecture and correctness rules (runtime physics, the PICO
math API, editor MaterialX, the visual-ground-truth rule) in depth.
