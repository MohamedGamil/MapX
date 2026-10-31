# MapX BATON handoff

Revision: develop@1ae33687b501107654015fe72a967869fdc4124d (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M3 — Vue SFC semantics.

## Baseline
Last completed: M0-04-R3 — Laravel: ->middleware(X::class) route middleware edges via the route file use table.
Evidence: `npx vitest run tests/laravel-mounts.test.ts tests/laravel-routes-fixture.test.ts` (exit 0) → docs/baton/reports/M0-04-R3.md; `npx tsx scripts/eval/score-routes.ts tests/fixtures/laravel-routes --json --min-recall 0.95 --max-fp 0` (exit 0) → docs/baton/reports/M0-04-R3.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M3-01 — Vue SFC fixture set (2.7 and 3.x). Prerequisites: M0-06-R1, M0-05-R1, M0-04-R1, M0-12-R1, M0-12-R2, M0-17-R1, M0-07-R1, M0-09-R1, M0-08-R1, M0-11-R1, M0-20-R1, M0-02-R1, M0-01-R1, M0-18-R1, M0-03-R2, M0-05-R2, M0-09-R2, M0-10-R1, M0-05-R3, M0-20-R2, M0-11-R2, M0-02-R2, M0-04-R2, M0-09-R3, M0-10-R2, M0-12-R3, M0-12-R4, M0-17-R2, M0-03-R3, M0-05-R4, M0-07-R2, M1-03-R1, M1-07-R1, M1-05-R1, M2-04-R2, M2-06-R1, M0-32-R1, M0-02-R3, M0-10-R3, M0-03-R4, M0-17-R3, M1-05-R2, M0-32-R2, M0-02-R4, M0-02-R5, M0-04-R3. Read docs/baton/iterations/M3-01.md. Objective: One SFC per style (Options API, Composition API, <script setup>) in both Vue 2.7 and 3.x syntax, with expected symbols and edges. Expected outputs: tests/fixtures/vue-sfc/; expected edges JSON; tests/vue-sfc.test.ts. Verify: `npx vitest run tests/vue-sfc.test.ts`; `npx tsx scripts/eval/score-edges.ts tests/fixtures/vue-sfc --json`.
Also eligible: M4-03, M4-05, M1-05-R3, M4-04.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M3-01 → M3-03 → M3-05 (32h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
