# MapX BATON handoff

Revision: develop@a1f150cdc81cbcf2da43380c8d0206827edbd8c1 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M4-25 — Compact terminal logo for init, scan and sync.
Evidence: `npx vitest run tests/branding.test.ts` (exit 0) → docs/baton/reports/M4-25.md; `npm run check` (exit 0) → docs/baton/reports/M4-25.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-03-R1 — Qualified names from real scans for every built-in language; not over symbol-level selectors. Prerequisites: M5-03. Read docs/baton/iterations/M5-03-R1.md. Objective: Element qualified names match the documented form on a real scan for every built-in language, and a not over a symbol-level selector does not pull files into a layer. Expected outputs: src/arch/elements.ts; src/arch/selectors/index.ts; src/arch/membership.ts; tests/arch-selectors.test.ts; docs/architecture-rules.md; reports/M5-03-R1.md. Verify: `npx vitest run tests/arch-selectors.test.ts`; `npm run check`.
Also eligible: M4-09-R1, M5-10, M0-02-R11, M0-10-R6, M0-12-R11.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-03-R1 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (49h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
