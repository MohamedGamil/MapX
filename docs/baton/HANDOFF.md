# MapX BATON handoff

Revision: develop@c89f1afa2cdefaefcd4d7884ed46d4bfef8fda7b (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M5-01 — Architecture-rules fixture set and scorer (PHP, TS, Python, Go, cross-repo).
Evidence: `npx vitest run tests/arch-fixture.test.ts` (exit 0) → docs/baton/reports/M5-01.md; `npx tsx scripts/eval/score-arch.ts tests/fixtures/arch-rules --json` (exit 0) → docs/baton/reports/M5-01.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-03 — Element view, core selectors and layer membership with selector trace. Prerequisites: M5-01, M5-02. Read docs/baton/iterations/M5-03.md. Objective: Element abstraction over stored files and symbols with per-language qualifiedName normalisation; selectors path, name(+kind), layer, all/any/not, role, cluster, repo, workspacePackage, language, framework; membership memoised per (scan, config hash) and recording which selector matched. Expected outputs: src/arch/elements.ts; src/arch/selectors/; src/arch/membership.ts; tests/arch-selectors.test.ts. Verify: `npx vitest run tests/arch-selectors.test.ts`.
Also eligible: M5-10.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (50h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
