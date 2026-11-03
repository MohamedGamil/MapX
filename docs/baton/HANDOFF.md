# MapX BATON handoff

Revision: develop@b8bc2c40acb8572ce21c71d99a617d9ad54831c1 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M6 — Dashboard graph scale and readability.

## Baseline
Last completed: M4-28 — Release documentation for 0.3.9: README, docs and CHANGELOG cover every change since 0.3.5.
Evidence: `npm run check` (exit 0) → docs/baton/reports/M4-28.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M6-01 — Large-graph fixtures and baseline measurements for the graph and Architecture views. Prerequisites: M4-20, M5-15. Read docs/baton/iterations/M6-01.md. Objective: Generated synthetic workspaces of 2k, 10k and 50k files (realistic folder depth, fan-in/fan-out and cross-folder edges) plus an architecture config with 40+ layers and thousands of findings, and a Playwright measurement harness that records, per view: time to first render, time to interactive, longest main-thread task, pan/zoom frame time and JS heap. Expected outputs: scripts/ui/gen-large-workspace.ts; tests/ui/perf-scale.spec.ts; reports/M6-01.md. Verify: `npx playwright test tests/ui/perf-scale.spec.ts`.
Also eligible: M0-02-R13, M2-08-R4, M2-12, M2-13, M4-09-R5.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M6-01 → M6-02 → M6-04 → M6-06 → M6-98 (51h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: M5-98: Owner hold (D035, 2026-11-03): start only when the owner explicitly asks.; M4-13-R1: Owner hold (D035, 2026-11-03): start only when the owner explicitly asks.; M4-32: Owner decision: the root CLAUDE.md has hand edits; regenerate its block with `mapx agents generate --providers claude --force` (which also writes this checkout's path) or edit it by hand..
