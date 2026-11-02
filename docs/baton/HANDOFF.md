# MapX BATON handoff

Revision: develop@3553837c2d693fb5800aa63b66988f931ee53f54 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M4-23 — Cross-repo HTTP communication view in the dashboard.
Evidence: `npx vitest run tests/ui-server-http.test.ts` (exit 0) → docs/baton/reports/M4-23.md; `npm run test:ui` (exit 0) → docs/baton/reports/M4-23.md; `npm run check` (exit 0) → docs/baton/reports/M4-23.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-01 — Architecture-rules fixture set and scorer (PHP, TS, Python, Go, cross-repo). Prerequisites: M0-02-R6, M0-17-R4, M3-08-R1, M3-09-R1, M0-02-R7, M0-10-R4, M1-07-R2, M0-04-R6, M3-02-R1, M3-05-R1, M3-11-R1, M3-07-R1, M0-12-R7, M0-17-R5, M0-20-R3, M2-06-R2, M2-04-R3, M0-09-R5, M1-03-R2, M0-11-R3, M0-02-R8, M0-12-R8, M0-12-R9, M2-08, M0-02-R9, M0-12-R10, M0-17-R6, M0-02-R10, M4-10, M4-11, M4-13, M4-12, M4-14, M4-15, M4-16, M4-19, M4-17, M4-20, M4-21, M4-22, M4-23. Read docs/baton/iterations/M5-01.md. Objective: Small synthetic apps per tier-1 language plus a two-repo workspace, each with a .mapx/architecture.jsonc and labelled expected findings (violation, skipped, uncovered, warning, error) keyed by fingerprint inputs, and a scorer reporting per-kind recall/precision. Baseline score is 0 (no engine yet). Expected outputs: tests/fixtures/arch-rules/; tests/fixtures/arch-rules/expected-findings.json; scripts/eval/score-arch.ts; tests/arch-fixture.test.ts. Verify: `npx vitest run tests/arch-fixture.test.ts`; `npx tsx scripts/eval/score-arch.ts tests/fixtures/arch-rules --json`.
Also eligible: M5-02.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (62h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
