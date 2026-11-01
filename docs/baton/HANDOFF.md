# MapX BATON handoff

Revision: develop@b3283557387a5094a72210be94370a8c39f29706 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M4 — Measurement and developer experience.

## Baseline
Last completed: M4-17 — Dashboard look and feel: design system, themes, responsive and accessible.
Evidence: `npm run test:ui` (exit 0) → docs/baton/reports/M4-17.md; `npx tsx scripts/check-package.ts` (exit 0) → docs/baton/reports/M4-17.md; `npm run check` (exit 0) → docs/baton/reports/M4-17.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M4-21 — Multi-repo workspaces in the dashboard. Prerequisites: M4-17. Read docs/baton/iterations/M4-21.md. Objective: The dashboard shows every registered repo: a workspace overview, a repo switcher, and repo-scoped views, with cross-repo edges marked. Expected outputs: /api/repos; repo parameter on repo-scoped endpoints; repo switcher and overview; tests; reports/M4-21.md. Verify: `npx vitest run tests/ui-server.test.ts`; `npm run test:ui`; `npm run check`.
Also eligible: M4-24.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M4-21 → M4-23 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (82h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
