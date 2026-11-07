# MapX BATON handoff

Revision: develop@28d085fd3710d9ca0f1a4fe97ae8f71b77cfb48b (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M5-25 — Go package-qualified composite literals resolve to the type in the imported package.
Evidence: `npx vitest run tests/go-qualified-instantiation.test.ts` (exit 0) → docs/baton/reports/M5-25.md; `npm run eval` (exit 0) → docs/baton/reports/M5-25.md; `npm run check` (exit 0) → docs/baton/reports/M5-25.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-04 — Policy expansion and rule evaluator (handler chain, findings, fingerprints). Prerequisites: M5-03, M5-03-R1, M5-25. Read docs/baton/iterations/M5-04.md. Objective: Allow-set expansion (`+`, `*`, `!`), per-rule severity and edge-type scope, verifiability policy, the AR-08 chain (scope → uncovered → same-layer → disallowed-layer → internal-element → private-layer → allowed), multi-layer and empty-layer warnings, ArchReport aggregation with layerEdges, stable fingerprints. Expected outputs: src/arch/policy.ts; src/arch/evaluate.ts; src/arch/report.ts; tests/arch-evaluate.test.ts. Verify: `npx vitest run tests/arch-evaluate.test.ts`; `npx tsx scripts/eval/score-arch.ts tests/fixtures/arch-rules --json`; `npm run check`.
Also eligible: M5-10, M5-19, M0-02-R12, M0-10-R6, M0-12-R11.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (40h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
