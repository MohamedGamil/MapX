# MapX BATON handoff

Revision: develop@e4fc86102aaea11a415daa67b2f80f7d171d1884 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M2 — Cross-language precision and HTTP pairing.

## Baseline
Last completed: M4-04 — Scanner: no redundant walk, and no post-scan when a sync changes nothing indexed.
Evidence: `npx vitest run tests/scan-redundancy.test.ts tests/scanner.test.ts` (exit 0) → docs/baton/reports/M4-04.md; `npm run eval` (exit 0) → docs/baton/reports/M4-04.md; `npm run check` (exit 0) → docs/baton/reports/M4-04.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M2-08 — Calls resolve through the file's own imports before name lookup. Prerequisites: M4-01, M4-03, M4-04, M4-05, M4-08, M0-17-R4, M0-02-R7. Read docs/baton/iterations/M2-08.md. Objective: A call or instantiation of a name the file imports from a project module links to that module's declaration (through re-exports), never to another file's same-named symbol; only unimported names fall back to name lookup. Expected outputs: fix; regression tests; reports/M2-08.md. Verify: `npx vitest run tests/legacy-language-accuracy.test.ts tests/legacy-imports.test.ts`; `npx tsx scripts/eval/score-edges.ts tests/fixtures/vue-sfc --json`.
Also eligible: M0-02-R10, M0-02-R9, M0-12-R10, M0-17-R6.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M2-08 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (70h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
