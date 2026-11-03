# MapX BATON handoff

Revision: develop@8832020757d055dd9cb663f5559f114caf9309f7 (uncommitted changes); plan baseline: develop@7e5aa19. Current milestone: M5 — Architecture rules (Deptrac-inspired).

## Baseline
Last completed: M4-28 — Release documentation for 0.3.9: README, docs and CHANGELOG cover every change since 0.3.5.
Evidence: `npm run check` (exit 0) → docs/baton/reports/M4-28.md.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's `sources`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
Next READY: M5-24-R1 — Ambient access is extracted: environment, globals and superglobals. Prerequisites: M5-24. Read docs/baton/iterations/M5-24-R1.md. Objective: Scans record ambient-access references (process.env, window/document/globalThis, $_GET/$_POST/$_SERVER/$GLOBALS, os.environ/sys.argv, Go os.Getenv) as external_refs with origin ambient, so the `ambient` selector matches them in every language, not only Go cgo C. Expected outputs: src/core/scanner.ts; queries/**; tests/external-refs.test.ts; reports/M5-24-R1.md. Verify: `npx vitest run tests/external-refs.test.ts`; `npx tsx scripts/eval/score-arch.ts tests/fixtures/arch-rules --json`.
Also eligible: M5-15-R1, M5-17-R1, M0-02-R13, M2-08-R4, M2-12.
Active work: none. One active iteration per owner.

## Observe
Run `npm run plan:validate`, inspect `git status`, then `npm run check`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: M5-15-R1 (8h). Recompute with `npm run plan:report` after every completion.
Pending gates: none; request approval only with reviewable evidence. Owner-initiated (never request): G-RELEASE.
External blockers: M5-98: Owner hold (D035, 2026-11-03): start only when the owner explicitly asks.; M4-13-R1: Owner hold (D035, 2026-11-03): start only when the owner explicitly asks..
