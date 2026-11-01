# MapX BATON handoff

Revision: develop@68c737dc22054469daae9c6f372354a5b915d5cc (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M4 — Measurement and developer experience.

## Baseline
Last completed: M4-15 — Shared compiled grammar code across workers, after a risk evaluation.
Evidence: `npx vitest run tests/worker-pool.test.ts` (exit 0) → docs/baton/reports/M4-15.md; `npx tsx scripts/bench/workers.ts` (exit 0) → docs/baton/reports/M4-15.md; `npm run check` (exit 0) → docs/baton/reports/M4-15.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M4-16 — Dashboard UX/UI audit with a measured baseline. Prerequisites: M4-15. Read docs/baton/iterations/M4-16.md. Objective: Evaluate the dashboard's look and feel, usability and performance on fixture workspaces, with screenshots and measured baselines, and rank the findings. Expected outputs: docs/research/dashboard-ux-audit.md; screenshots; scripts/ui/audit.ts; reports/M4-16.md. Verify: `npx tsx scripts/ui/audit.ts`; `npm run check`.
Also eligible: none.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M4-16 → M4-19 → M4-17 → M4-21 → M4-23 → M5-01 → M5-03 → M5-04 → M5-05 → M5-08 → M5-16 → M5-98 (112h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: M4-18: Owner supplies the new logo (SVG preferred, with colour and usage notes).
