# MapX BATON handoff

Revision: develop@e1d5da0d194a19441f225d82a71f5c2faa28f864 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M0 — Delivered baseline and remediation.

## Baseline
Last completed: M2-08 — Calls resolve through the file's own imports before name lookup.
Evidence: `npx vitest run tests/import-bound-calls.test.ts tests/legacy-language-accuracy.test.ts tests/legacy-imports.test.ts` (exit 0) → docs/baton/reports/M2-08.md; `npm run eval` (exit 0) → docs/baton/reports/M2-08.md; `npm run check` (exit 0) → docs/baton/reports/M2-08.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M0-17-R6 — Heuristic follow-ups: renamed names in comments, router shadowing, module aliases, factory bindings. Prerequisites: M4-01, M4-03, M4-04, M4-05, M4-08, M0-02-R8, M3-11-R1, M3-09-R1, M0-17-R5. Read docs/baton/iterations/M0-17-R6.md. Objective: Close the heuristic gaps the 2026-11-01 reviews recorded: sync after a rename whose old name survives as text, Vue Router shadowing and guard returns, Laravel module aliases, and over-broad factory-binding promotion. Expected outputs: fix; regression tests; reports/M0-17-R6.md. Verify: `npx vitest run tests/legacy-globs.test.ts tests/vue-navigation.test.ts tests/legacy-imports.test.ts tests/legacy-language-accuracy.test.ts`.
Also eligible: M0-02-R10, M0-02-R9, M0-12-R10.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M0-17-R6 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (68h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
