# MapX BATON handoff

Revision: develop@f53532345740d54d0ee20ac5db0b033f84b737d7 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M4 — Measurement and developer experience.

## Baseline
Last completed: M5-05-R1 — Staleness in status, MCP and the other commands finds new files as check does.
Evidence: `npx vitest run tests/legacy-impact-staleness.test.ts` (exit 0) → docs/baton/reports/M5-05-R1.md; `npm run check` (exit 0) → docs/baton/reports/M5-05-R1.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-10 — Capture decorators/attributes and doc tags in symbol metadata (tier 1). Prerequisites: M5-01, M3-04. Read docs/baton/iterations/M5-10.md. Objective: Parsers persist `metadata.decorators` (normalised name, raw args) and `metadata.docTags` ({tag, value}) on symbols for PHP (attributes, PHPDoc), TS/JS (decorators, JSDoc/TSDoc), Python (decorators, docstring deprecations), Java/Kotlin (annotations, Javadoc/KDoc), C# (attributes, XML doc); add decorator and docTag selectors. Expected outputs: parser changes; src/arch/selectors/{decorator,doc-tag}.ts; tests/symbol-annotations.test.ts. Verify: `npx vitest run tests/symbol-annotations.test.ts`; `npm test`.
Also eligible: M5-06, M5-19, M3-05-R3, M4-13-R1, M5-07.
Active work: M4-24-R1 (claude-ff-lane-M4-24-R1), M5-25-R1 (claude-ff-lane-M5-25-R1), M5-03-R2 (claude-ff-lane-M5-03-R2), M2-09 (claude-ff-lane-M2-09), M2-10 (claude-ff-lane-M2-10). One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-10 → M5-11 → M5-98 (26h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
