# MapX BATON handoff

Revision: develop@0e0365197a2edec7c9624416c037169281ca0aae (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M2 — Cross-language precision and HTTP pairing.

## Baseline
Last completed: M5-04 — Policy expansion and rule evaluator (handler chain, findings, fingerprints).
Evidence: `npx vitest run tests/arch-evaluate.test.ts` (exit 0) → docs/baton/reports/M5-04.md; `npx tsx scripts/eval/score-arch.ts tests/fixtures/arch-rules --json` (exit 0) → docs/baton/reports/M5-04.md; `npm run check` (exit 0) → docs/baton/reports/M5-04.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-05 — `mapx check` CLI: table/json reporters, exit contract, staleness. Prerequisites: M5-04. Read docs/baton/iterations/M5-05.md. Objective: Register `mapx check` with --view, --format table|json, --output, --report-uncovered, --fail-on-uncovered, --report-skipped, --fail-on warn, --layer, --rule, --sync; exit codes 0–4 as AR-17. Expected outputs: src/arch/reporters/table.ts; src/arch/reporters/json.ts; src/cli.ts (check command); tests/arch-cli.test.ts. Verify: `npm run build`; `npx vitest run tests/arch-cli.test.ts`.
Also eligible: M5-10, M5-19, M0-02-R12, M0-12-R11, M1-07-R3.
Active work: M2-08-R1 (claude-ff). One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-05 → M5-08 → M5-16 → M5-98 (28h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: none.
