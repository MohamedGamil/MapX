# MapX BATON handoff

Revision: develop@0e8a769d6778290615345f889d69a8449476375e (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M5-05 — `mapx check` CLI: table/json reporters, exit contract, staleness.
Evidence: `npx vitest run tests/arch-cli.test.ts` (exit 0) → docs/baton/reports/M5-05.md; `npm run check` (exit 0) → docs/baton/reports/M5-05.md.
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
External blockers: M2-08-R1: Owner decision: may sync re-parse every importer of a barrel when a module behind it changes (correct, costly in barrel-heavy repos), or only when the module`s exported names change.
