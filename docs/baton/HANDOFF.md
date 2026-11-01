# MapX BATON handoff

Revision: develop@cca20f4bc1f6bff67f2b3250d43a2b3600ac6343 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M4 — Measurement and developer experience.

## Baseline
Last completed: M4-21 — Multi-repo workspaces in the dashboard.
Evidence: `npx vitest run tests/ui-server-repos.test.ts` (exit 0) → docs/baton/reports/M4-21.md; `npm run test:ui` (exit 0) → docs/baton/reports/M4-21.md; `npm run check` (exit 0) → docs/baton/reports/M4-21.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M4-23 — Cross-repo HTTP communication view in the dashboard. Prerequisites: M4-21. Read docs/baton/iterations/M4-23.md. Objective: Show how repos talk over HTTP: frontend call sites paired with backend routes and handlers, unmatched calls, and a repo-to-repo flow, as for majles's frontend and backend. Expected outputs: /api/http; HTTP tab and flow view; tests; reports/M4-23.md. Verify: `npx vitest run tests/ui-server.test.ts`; `npm run test:ui`; `npm run check`.
Also eligible: M4-22.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M4-23 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (72h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
