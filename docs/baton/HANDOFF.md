# MapX BATON handoff

Revision: develop@fb75474ba377854bcb439bfc9f84e906e745e0ea (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M0 — Delivered baseline and remediation.

## Baseline
Last completed: M0-15 — Bundled web dashboard.
Evidence: `npm run typecheck` (exit 0) → docs/baton/reports/M0-BASELINE.md; `npm test` (exit 0) → docs/baton/reports/M0-BASELINE.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M0-12-R3 — Linear-time import resolution; shebang scripts resolve references; D010 docs. Prerequisites: M0-12-R1, M0-12-R2. Read docs/baton/iterations/M0-12-R3.md. Objective: Import resolution scales to large repos, shebang scripts take part in the graph, and docs match D010. Expected outputs: fix; regression tests; reports/M0-12-R3.md. Verify: `npx vitest run tests/legacy-imports.test.ts tests/legacy-languages.test.ts`.
Also eligible: M0-02-R2, M0-04-R2, M0-09-R3, M0-11-R2, M0-20-R2.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M0-12-R3 → M0-12-R4 → M3-01 → M3-03 → M3-05 (44h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: M0-03-R3: Owner decision: implement the F02/F04 JSON shapes and options as specified, or record the current shapes as the contract (D010 says implement as specified)..
