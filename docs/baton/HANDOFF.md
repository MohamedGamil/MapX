# MapX BATON handoff

Revision: develop@d246259d6f699ff21ff7c711da9ac52ce5aa6440 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M4 — Measurement and developer experience.

## Baseline
Last completed: M4-19 — Browser test harness for the dashboard.
Evidence: `npm run test:ui` (exit 0) → docs/baton/reports/M4-19.md; `npm run check` (exit 0) → docs/baton/reports/M4-19.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M4-17 — Dashboard look and feel: design system, themes, responsive and accessible. Prerequisites: M4-16, M4-19, M0-32-R3. Read docs/baton/iterations/M4-17.md. Objective: Give the dashboard a consistent design system (tokens for colour, type, spacing, radius, elevation), light and dark themes, a responsive layout and accessible contrast and focus, across every tab. Expected outputs: design tokens; themes; responsive layout; UI tests; reports/M4-17.md. Verify: `npm run test:ui`; `npx tsx scripts/check-package.ts`; `npm run check`.
Also eligible: M4-20.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M4-17 → M4-21 → M4-23 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (92h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
