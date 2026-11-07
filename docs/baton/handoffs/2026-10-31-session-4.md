# MapX BATON handoff

Revision: develop@6525daf4cae00812e3fed14b3550432111b73755 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M0 — Delivered baseline and remediation.

## Baseline
Last completed: M0-15 — Bundled web dashboard.
Evidence: `npm run typecheck` (exit 0) → docs/baton/reports/M0-BASELINE.md; `npm test` (exit 0) → docs/baton/reports/M0-BASELINE.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M0-05-R1 — Persist reference metadata and route edge verifiability. Prerequisites: M0-05. Read docs/baton/iterations/M0-05-R1.md. Objective: Reference metadata (Eloquent relationship type, binding type and phase, facade alias) reaches stored edges; route edges carry verifiability from their confidence and keep resourceType. Expected outputs: fixes; regression tests; reports/M0-05-R1.md. Verify: `npx vitest run tests/legacy-php-metadata.test.ts`.
Also eligible: M0-06-R1, M0-07-R1, M0-12-R1, M0-12-R2, M0-02-R1.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M0-05-R1 → M0-05-R2 → M3-01 → M3-03 → M3-05 (48h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
