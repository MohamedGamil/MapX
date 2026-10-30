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
