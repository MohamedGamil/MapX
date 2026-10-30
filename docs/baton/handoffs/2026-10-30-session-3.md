# MapX BATON handoff

Revision: develop@315b4ebc5aee57d668f7878aaa8b793c0bc7267d (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M3 — Vue SFC semantics.

## Baseline
Last completed: M0-15 — Bundled web dashboard.
Evidence: `npm run typecheck` (exit 0) → docs/baton/reports/M0-BASELINE.md; `npm test` (exit 0) → docs/baton/reports/M0-BASELINE.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M3-01 — Vue SFC fixture set (2.7 and 3.x). Prerequisites: none. Read docs/baton/iterations/M3-01.md. Objective: One SFC per style (Options API, Composition API, <script setup>) in both Vue 2.7 and 3.x syntax, with expected symbols and edges. Expected outputs: tests/fixtures/vue-sfc/; expected edges JSON; tests/vue-sfc.test.ts. Verify: `npx vitest run tests/vue-sfc.test.ts`; `npx tsx scripts/eval/score-edges.ts tests/fixtures/vue-sfc --json`.
Also eligible: M0-39, M2-07, M4-03, M4-05, M4-04.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M3-01 → M3-03 → M3-05 (32h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
