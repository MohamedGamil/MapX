# MapX BATON handoff

Revision: develop@ccfbad512980dc96178b81e7f89e34c0c6ccd4d3 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M4 — Measurement and developer experience.

## Baseline
Last completed: M4-01 — Recall/precision scoring in CI.
Evidence: `npm run eval` (exit 0) → docs/baton/reports/M4-01.md; `npx vitest run tests/eval-floors.test.ts tests/laravel-routes-fixture.test.ts tests/http-pairing-fixture.test.ts tests/vue-sfc.test.ts` (exit 0) → docs/baton/reports/M4-01.md; `npm run check` (exit 0) → docs/baton/reports/M4-01.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M4-04 — Scanner: bounded parallel directory walk and post-scan steps. Prerequisites: M0-02-R6, M0-17-R4, M3-08-R1, M3-09-R1, M0-02-R7, M0-10-R4, M1-07-R2, M0-04-R6, M3-02-R1, M3-05-R1, M3-11-R1, M3-07-R1, M0-12-R7, M0-17-R5, M0-20-R3, M2-06-R2, M2-04-R3, M0-09-R5, M1-03-R2, M0-11-R3, M0-02-R8, M0-12-R8, M0-12-R9. Read docs/baton/iterations/M4-04.md. Objective: discoverFiles walks directories with bounded concurrency, and independent post-scan steps run concurrently (spec 10). Expected outputs: scanner change; benchmark. Verify: `npx vitest run tests/scanner.test.ts`; `npm run bench:json`.
Also eligible: M4-03, M4-05, M4-08.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M4-04 → M2-08 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (82h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
