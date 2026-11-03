# MapX BATON handoff

Revision: develop@0bfce519b75a97da9fee7efd72eacbe0f65274cc (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M5-17 — `mapx arch init`: inference from roles/clusters/frameworks and first presets.
Evidence: `npx vitest run tests/arch-init.test.ts` (exit 0) → docs/baton/reports/M5-17.md; `npm run check` (exit 0) → docs/baton/reports/M5-17.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-15 — Dashboard Architecture view and /api/arch endpoints. Prerequisites: M5-05, M5-13. Read docs/baton/iterations/M5-15.md. Objective: Layer diagram with violation drill-down to concrete edges, layer DSM, findings table with filters, health tiles, declared-layer overlay on the graph; /api/arch/report, /api/arch/layers, /api/arch/edges. Expected outputs: src/ui/main.ts (view); src/ui-server.ts (endpoints); tests/ui-arch-api.test.ts. Verify: `npx vitest run tests/ui-arch-api.test.ts`; `npx tsx scripts/check-package.ts`.
Also eligible: M5-98, M4-13-R1.
Active work: M5-18 (claude-ff-lane-M5-18), M5-20-R1 (claude-ff-lane-pip), M5-22 (claude-ff-lane-pip2), M5-23 (claude-ff-lane-M5-23), M4-24-R1 (claude-ff-lane-M4-24-R1), M3-05-R3 (claude-ff-lane-M3-05-R3). One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-15 (12h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: M4-12-R1: Owner decision: under CPU load, idle lanes steal new grammars more often, so M4-12 AC1 (grammar loads at most languages + workers) and AC2 (no worker idles while files remain) conflict. Either cap new-grammar steals per batch (AC1 holds; a lane may end while another still has files) or restate AC1 as plan + up to (workers - 1) steals (AC2 holds)..
