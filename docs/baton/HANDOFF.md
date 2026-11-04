# MapX BATON handoff

Revision: develop@cf39a4bc8dc583dddb6ab32aa6ac61dc69b83734 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M6 — Dashboard graph scale and readability.

## Baseline
Last completed: M2-16 — PHP `self::m()` and `static::m()` calls link the enclosing class's method.
Evidence: `npx vitest run tests/php-self-calls.test.ts` (exit 0) → docs/baton/reports/M2-16.md; `npm run eval` (exit 0) → docs/baton/reports/M2-16.md; `npm run check` (exit 0) → docs/baton/reports/M2-16.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M6-01 — Large-graph fixtures and baseline measurements for the graph and Architecture views. Prerequisites: M4-20, M5-15. Read docs/baton/iterations/M6-01.md. Objective: Generated synthetic workspaces of 2k, 10k, 50k and 100k files (realistic folder depth, fan-in/fan-out and cross-folder edges) plus an architecture config with 40+ layers and thousands of findings, and a Playwright measurement harness that records, per view: time to first render, time to interactive, longest main-thread task, pan/zoom frame time and JS heap. Expected outputs: scripts/ui/gen-large-workspace.ts; tests/ui/perf-scale.spec.ts; reports/M6-01.md. Verify: `npx playwright test tests/ui/perf-scale.spec.ts`.
Also eligible: M0-02-R13, M2-12-R2, M2-14, M2-20-R1, M2-21.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M6-01 → M6-02 → M6-04 → M6-06 → M6-98 (51h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: M4-13-R1: Owner hold (D035, 2026-11-03): start only when the owner explicitly asks..
