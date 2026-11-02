# MapX BATON handoff

Revision: develop@fe9d7833b099b57086487021ff1f44ff3a97a065 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M0 — Delivered baseline and remediation.

## Baseline
Last completed: M5-03-R1 — Qualified names from real scans for every built-in language; not over symbol-level selectors.
Evidence: `npx vitest run tests/arch-selectors.test.ts` (exit 0) → docs/baton/reports/M5-03-R1.md; `npm run check` (exit 0) → docs/baton/reports/M5-03-R1.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-04 — Policy expansion and rule evaluator (handler chain, findings, fingerprints). Prerequisites: M5-03, M5-03-R1. Read docs/baton/iterations/M5-04.md. Objective: Allow-set expansion (`+`, `*`, `!`), per-rule severity and edge-type scope, verifiability policy, the AR-08 chain (scope → uncovered → same-layer → disallowed-layer → internal-element → private-layer → allowed), multi-layer and empty-layer warnings, ArchReport aggregation with layerEdges, stable fingerprints. Expected outputs: src/arch/policy.ts; src/arch/evaluate.ts; src/arch/report.ts; tests/arch-evaluate.test.ts. Verify: `npx vitest run tests/arch-evaluate.test.ts`; `npx tsx scripts/eval/score-arch.ts tests/fixtures/arch-rules --json`.
Also eligible: M5-10, M5-19, M0-10-R6, M0-12-R11, M1-07-R3.
Active work: M0-02-R11 (claude-ff). One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (40h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
