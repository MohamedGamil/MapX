# MapX BATON handoff

Revision: develop@8903afe95e0ca208450d2f40c0680c65d760c44c (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M2 — Cross-language precision and HTTP pairing.

## Baseline
Last completed: M0-15 — Bundled web dashboard.
Evidence: `npm run typecheck` (exit 0) → docs/baton/reports/M0-BASELINE.md; `npm test` (exit 0) → docs/baton/reports/M0-BASELINE.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M2-02 — Vue 2.7 and Vue 3 HTTP client fixture with labels. Prerequisites: M1-01. Read docs/baton/iterations/M2-02.md. Objective: Synthetic Vue 2.7 and Vue 3 apps using every client wrapper pattern from report §3 item 12, labelled against the M1 Laravel fixture routes. Expected outputs: tests/fixtures/vue-http/; tests/fixtures/vue-http/labels.json; scripts/eval/score-http.ts. Verify: `npx vitest run tests/http-pairing-fixture.test.ts`; `npx tsx scripts/eval/score-http.ts tests/fixtures/vue-http --json`.
Also eligible: M3-01, M0-39, M4-03, M4-05, M4-04.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M2-02 → M2-03 → M2-04 → M2-06 (46h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
