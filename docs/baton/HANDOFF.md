# MapX BATON handoff

Revision: develop@97cfa56287e0fa32f94438244066d0a76c122773 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M4 — Measurement and developer experience.

## Baseline
Last completed: M2-06-R3 — HTTP edges into another repo record their target repo.
Evidence: `npx vitest run tests/http-cross-repo.test.ts tests/http-pairing.test.ts tests/http-followups.test.ts` (exit 0) → docs/baton/reports/M2-06-R3.md; `npm run eval` (exit 0) → docs/baton/reports/M2-06-R3.md; `npm run check` (exit 0) → docs/baton/reports/M2-06-R3.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M4-21 — Multi-repo workspaces in the dashboard. Prerequisites: M4-17. Read docs/baton/iterations/M4-21.md. Objective: The dashboard shows every registered repo: a workspace overview, a repo switcher, and repo-scoped views, with cross-repo edges marked. Expected outputs: /api/repos; repo parameter on repo-scoped endpoints; repo switcher and overview; tests; reports/M4-21.md. Verify: `npx vitest run tests/ui-server.test.ts`; `npm run test:ui`; `npm run check`.
Also eligible: none.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M4-21 → M4-23 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (82h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
