# Decisions

Planning and architecture decisions made under BATON. Earlier decisions are in `specs/DECISIONS.md`.

## D001 — Adopt BATON; TASKS.json is the source of truth (2026-10-30)

MapX moves from `specs/ITERATIONS.md` plus per-iteration markdown to the BATON control plane used in OmniStrike:
- `docs/baton/TASKS.json` holds status, dependencies, gates and evidence;
- `scripts/baton/` (`npm run plan:*`) owns every status change;
- `docs/baton/iterations/<ID>.md` holds each iteration's spec.

`specs/` stays as frozen history and design reference. Feature specs `specs/features/F*.md` are cited from task `sources`.
Why: the old log marked I01–I22 done with no recorded verification. Per-iteration files contradicted it (I18, I19, I22), and post-I22 work had no iterations at all.

## D002 — Legacy iterations imported as DONE on baseline evidence (2026-10-30)

I01–I22 become M0-01 … M0-22 (`legacyId` keeps the old id). Their evidence is the baseline run at import (`reports/M0-BASELINE.md`), not per-criterion proof. Disputed items get remediation tasks (`<ID>-R1`). Terminal DONE states are never rewritten.

## D003 — Skills live in `.claude/skills/` (2026-10-30)

OmniStrike keeps skills in `.agents/skills/` and symlinks them from `.claude/skills/`. In MapX, `.agents/` is gitignored because `mapx agents generate` writes there (`src/agents/templates.ts`). So `baton` and `baton-review` live directly in `.claude/skills/`, and AGENTS.md points other harnesses to them.

## D004 — Milestones follow releases; fixtures before fixes (2026-10-30)

M1 (0.4.0), M2 (0.5.0) and M3 (0.6.0) each start with a labelled synthetic fixture and a recall/precision scorer (M1-01, M2-02, M3-01). Fix tasks depend on their fixture, so each gain is measured, following the report's suggestion to re-measure after every release. Publishing a release requires an owner-approved gate (`G-REL-x.y.z`).

## D005 — Do not ship source maps in the npm package (2026-10-30)

Owner decision: stop shipping the 7.8 MB `dist/ui/main.js.map`. UI source maps become opt-in with `MAPX_UI_SOURCEMAP=1` for local debugging. The bundle-size target (I15's <200 KB gzipped) is still open as M0-15-R2.

## D006 — Dashboard bundle target re-baselined to a 720 KiB ceiling (2026-10-30)

Owner decision: set a new target instead of reducing the bundle to I15's <200 KB gzipped. `dist/ui/main.js` measured 690,760 bytes gzipped, mostly Cytoscape and its layout plugins. The new target is a **regression ceiling of 737,280 bytes (720 KiB) gzipped**, about 6.7% headroom, enforced by default in `scripts/check-package.ts` and in CI. Raising it needs a new decision entry with the measured cause.

## D007 — Releases are owner-initiated, not milestone-driven (2026-10-30)

Owner decision: 0.4.0 is not released at the end of M1. A release happens only when the owner, after several iterations, judges that the accumulated changes warrant one, and signs off manually. Consequences:
- milestones carry no release version;
- the release task (M1-99) is DEFERRED;
- gate `G-REL-0.4.0` becomes `G-RELEASE` with `ownerInitiated: true`.

Agents never request this gate, never bump `VERSION` and never publish. Unreleased work keeps accumulating under CHANGELOG `[Unreleased]`.

## D008 — HTTP call-site contract: `.mapx/http-calls.json` (2026-10-30)

Frontend HTTP calls are persisted like routes, in `.mapx/http-calls.json`. It holds one record per client call site:

```
{ file, line, method, rawUrl, url, pattern?, route: { method, path, handlerSymbol?, handlerFile } | null }
```

- **`url`** is resolved: base URL joined with axios semantics, constants and template parts substituted, and unknown parts written as `{}`.
- **`route`** is the paired backend route; `null` means unmatched.
- **Writers:** M2-03 writes `file`, `line`, `method` and `rawUrl`; M2-04 and M2-05 fill `url`; M2-06 fills `route` and adds `http` edges.
- **Scorer:** `scripts/eval/score-http.ts` reads only this file, so the scorer (M2-02) can be built before any extractor exists.

Why: it mirrors `routes.json` (M1), keeps each stage independently testable, and lets the fixture record a 0.3.5 baseline of 0 now.

## D009 — Owner Q&A on clearing open issues (2026-10-30)

- **Scope before the next work item (M3-01):** fix M2-07 (the HTTP review P2s), M0-22-R2 (CLI search truncation), M0-40 (type-check tests and scripts, R04), M0-41 (full criterion-level audit of the legacy iterations, R01) and M0-39 (tests for untested 0.3.x features).
- **Root repo:** when sub-repos are registered, the workspace root `.` stays registered. It indexes files outside every sub-repo; the nested-repo fix (M0-23) already prevents double indexing. No change.
- **Commits:** one commit per task on `develop`.

## D010 — Owner Q&A on the legacy audit (2026-10-31)

Context: the M0-41 audit found 0 of 16 legacy iterations fully confirmed (`reviews/REVIEW-2026-10-30-legacy-audit.md`).

- **Language tiers (M0-12-R2):** all grammars are bundled. Amend I12/F20 accordingly: `lang list` reports every grammar as bundled; add `lang info`; `lang install`/`uninstall` become clear messages ("all grammars are bundled") instead of copying files nothing reads; add shebang detection.
- **Specified-but-unbuilt CLI/MCP surface (epic M0-03-R1):** implement everything as specified. The epic is decomposed into M0-03-R2, M0-05-R2, M0-09-R2 and M0-10-R1.
- **Impact try/catch downgrade (M0-11-R1):** remove it. Risk depends on call depth and test files only, as F19 specifies.
- **Ordering:** the whole remediation backlog, P2 included, is done before M3. M3-01 has a hard dependency on every remediation task.
