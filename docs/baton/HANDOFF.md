# MapX BATON handoff

Revision: develop@7e5aa1944315a6970599ffd6423050fc269a2dc4 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M1 — Laravel route correctness.

## Baseline
Last completed: M0-15 — Bundled web dashboard.
Evidence: `npm run typecheck` (exit 0) → docs/baton/reports/M0-BASELINE.md; `npm test` (exit 0) → docs/baton/reports/M0-BASELINE.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M1-01 — Laravel route fixture and recall/precision scorer. Prerequisites: none. Read docs/baton/iterations/M1-01.md. Objective: A synthetic Laravel app covering every declaration form and mount in the report, with labelled expected routes and a scorer that prints recall and precision. Expected outputs: tests/fixtures/laravel-routes/; tests/fixtures/laravel-routes/labels.json; scripts/eval/score-routes.ts; tests/laravel-routes-fixture.test.ts; docs/baton/reports/M1-01.md. Verify: `npx vitest run tests/laravel-routes-fixture.test.ts`; `npx tsx scripts/eval/score-routes.ts tests/fixtures/laravel-routes --json`.
Also eligible: M2-01, M0-14-R1, M0-30, M3-01, M0-19-R1.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M1-01 → M1-03 → M1-04 → M1-07 → M1-98 → M2-06 (65h). Recompute with `npm run plan:report` after every completion.
Pending gates: G-REL-0.4.0; request approval only with reviewable evidence.
External blockers: M0-15-R1: Owner decision: reduce the bundle to <200 KB gzipped, or re-baseline the target (record in DECISIONS.md).
