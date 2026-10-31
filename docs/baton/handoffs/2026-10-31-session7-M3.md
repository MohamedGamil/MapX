# MapX BATON handoff

Revision: develop@db0c8b1ea646a244f95d5a5004779492ff930822 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M3-08 — Vue global registry: re-link on sync, scope per manifest folder.
Evidence: `npx vitest run tests/vue-template.test.ts` (exit 0) → docs/baton/reports/M3-08.md; `npx tsx scripts/eval/score-edges.ts tests/fixtures/vue-sfc --json` (exit 0) → docs/baton/reports/M3-08.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-01 — Architecture-rules fixture set and scorer (PHP, TS, Python, Go, cross-repo). Prerequisites: none. Read docs/baton/iterations/M5-01.md. Objective: Small synthetic apps per tier-1 language plus a two-repo workspace, each with a .mapx/architecture.jsonc and labelled expected findings (violation, skipped, uncovered, warning, error) keyed by fingerprint inputs, and a scorer reporting per-kind recall/precision. Baseline score is 0 (no engine yet). Expected outputs: tests/fixtures/arch-rules/; tests/fixtures/arch-rules/expected-findings.json; scripts/eval/score-arch.ts; tests/arch-fixture.test.ts. Verify: `npx vitest run tests/arch-fixture.test.ts`; `npx tsx scripts/eval/score-arch.ts tests/fixtures/arch-rules --json`.
Also eligible: M4-01, M5-02, M0-02-R6, M0-17-R4, M4-03.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (62h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
