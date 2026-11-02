# MapX BATON handoff

Revision: develop@4b6028930202187e22ac268907f4777b6a30ee35 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M2-08-R1 — Import-bound calls: export-from barrels in sync, and no fallback past a project import.
Evidence: `npx vitest run tests/import-bound-calls.test.ts` (exit 0) → docs/baton/reports/M2-08-R1.md; `npx vitest run tests/js-source.test.ts` (exit 0) → docs/baton/reports/M2-08-R1.md; `npm run eval` (exit 0) → docs/baton/reports/M2-08-R1.md; `npm run check` (exit 0) → docs/baton/reports/M2-08-R1.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-10 — Capture decorators/attributes and doc tags in symbol metadata (tier 1). Prerequisites: M5-01, M3-04. Read docs/baton/iterations/M5-10.md. Objective: Parsers persist `metadata.decorators` (normalised name, raw args) and `metadata.docTags` ({tag, value}) on symbols for PHP (attributes, PHPDoc), TS/JS (decorators, JSDoc/TSDoc), Python (decorators, docstring deprecations), Java/Kotlin (annotations, Javadoc/KDoc), C# (attributes, XML doc); add decorator and docTag selectors. Expected outputs: parser changes; src/arch/selectors/{decorator,doc-tag}.ts; tests/symbol-annotations.test.ts. Verify: `npx vitest run tests/symbol-annotations.test.ts`; `npm test`.
Also eligible: M5-06, M5-19, M0-02-R12, M0-12-R11, M1-07-R3.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-10 → M5-11 → M5-98 (26h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
