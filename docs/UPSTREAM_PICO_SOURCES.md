# Upstream PICO sources — what to watch, and why

The official PICO developer repositories. This project deliberately **complements** them rather
than competing: their tooling guides, scaffolds and ships the platform; this server adds the
build/verify/ship loop and the evidence discipline on top. That only stays true if we keep
watching what they publish.

Review cadence: **check before every release wave, and always before a curriculum deliverable.**
An upstream change can invalidate a claim we publish, so treat these as a source of truth that
outranks our own older measurements.

> **Scale correction (2026-08-15 recon):** the org holds roughly **63 repositories**, ~11 of them
> created in the preceding six weeks — the table below is a priority subset, not the list. Notably
> absent from it: `PICO-Unity-SDK`/SpatialAdapter and five `PICO-Emulator-*` repos.
>
> **GitHub is a LAGGING indicator for PICO.** `PICO-Intelligent-Plugins` has three commits ever,
> yet they published to public npm twice within one hour. Watch **npm dist-tags and `.mcp.json`
> diffs** on a schedule; an org sweep alone will miss what actually ships.

| Repo | What it is | Why it matters to us |
|---|---|---|
| [Pico-Developer](https://github.com/Pico-Developer) | The org index (~63 repos) | New repos appear here first — sweep it, don't just poll the known list |
| [PICO-Intelligent-Plugins](https://github.com/Pico-Developer/PICO-Intelligent-Plugins) | PICO's official agentic plugin (skills + MCP declarations) | **Closest sibling, and the real competitive front.** v0.4.1 added early Unity support, a heavyweight `pico-spatial-app-designer` skill, and — most importantly — **`pico-spatial-editor`, a second MCP that drives a headless Spatial Editor with offscreen capture, governed AI model generation, and a bundle packer.** Our "install both" posture depends on knowing exactly what theirs does |
| [Unity-MCP-Extensions](https://github.com/Pico-Developer/Unity-MCP-Extensions) | PICO's own Unity-side MCP | Tells us what PICO considers in-scope for a first-party MCP — i.e. what we should wrap or defer to rather than duplicate. (Relevant, but **`pico-spatial-editor` above is the sharper threat**) |
| [PICO-Spatial-SDK-Samples](https://github.com/Pico-Developer/PICO-Spatial-SDK-Samples) | The eight official Spatial SDK samples | Our `test:conformance` gate asserts divergences we closed against these. Upstream drift silently invalidates that gate — and the samples' BOM has been contaminated before (all eight read 6.0.0; `git diff` before trusting a sample tree) |
| [SecureMR-Samples](https://github.com/Pico-Developer/SecureMR-Samples) · [pySecureMR](https://github.com/Pico-Developer/pySecureMR) | Privacy-preserving on-device perception | We have **zero** SecureMR support. Assess whether that is a real gap for the programme or a niche |
| [SpatialML-XR-Utils](https://github.com/Pico-Developer/SpatialML-XR-Utils) | Spatial ML utilities | Potentially overlaps or strengthens our splat→OWL-v2 semantic labeling lane |
| [PICO-Unity-SDK](https://github.com/Pico-Developer/PICO-Unity-SDK) · [PICO-Unity-Project-Templates](https://github.com/Pico-Developer/PICO-Unity-Project-Templates) | Official Unity SDK + templates | We ship a hand-rolled `unityskeleton/`. If the official templates are better maintained, replacing ours removes a maintenance burden and a source of drift |

## Related non-repo sources

- `pico-cli` on npm (`@picoxr/pico-cli`) — **0.4.2** is current; this server pins nothing and uses
  whatever is on PATH (see `src/picocli.ts`; auto-install is opt-in and missing-only, auto-update
  is a separate opt-in). PICO has indicated a **v1.0 by end of September**, which lands before the
  November programme — plan a verification sweep against v1.0 rather than over-investing in 0.4.x.
- PICO Intelligence Plugins releases (0.4.1) and the Android Spatial documentation page.

## How to check for drift

Prefer evidence over assumption: clone the repo, read the actual files, and compare against what
we assert. Our measured claims about upstream live in
[ANSWERED_BY_MEASUREMENT.md](ANSWERED_BY_MEASUREMENT.md) and `docs/findings/`; when upstream moves,
those pages are what must be corrected first, because they are the ones that make claims.
