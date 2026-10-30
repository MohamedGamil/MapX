# Planning changes

## 2026-10-30 — BATON adoption

- Imported I01–I22 as M0-01 … M0-22 (D001, D002).
- Added remediation tasks from REVIEW-2026-10-30-baseline: M0-14-R1, M0-15-R1, M0-19-R1, M0-22-R1, M0-23, M0-30.
- Added milestones M1 (Laravel routes, 0.4.0), M2 (cross-language precision and HTTP pairing, 0.5.0), M3 (Vue SFC, 0.6.0) and M4 (measurement), from `docs/reports/2026-10-30-laravel-vue-coverage-findings.md` (D004).
- Folded report item 16 (`routes --json` fields) into M1-09, and the middleware-metadata defect into M1-09 acceptance.
- M4-02 (`postMessage` edges) is DEFERRED: optional in the report, P3.
- 2026-10-30: split M0-15-R1 into R1 (stop shipping source maps, D005) and R2 (size target, still blocked on owner decision).
- 2026-10-30: M1-09 acceptance corrected; the 'route edges lose middlewares' finding in REVIEW-2026-10-30-baseline was wrong and is withdrawn. M1-02…M1-09 also register tests/laravel-mounts.test.ts.
- 2026-10-30: M0-30 reconciled CHANGELOG 0.2.7–0.3.5, specs 09/10 and KNOWN_ISSUES. Imported M0-31…M0-35 as DONE (test evidence); added M0-36…M0-39 and M4-03…M4-05 (M4-06 and M4-07 deferred).
- 2026-10-30: owner decisions D006 (dashboard ceiling 720 KiB; M0-15-R2 unblocked) and D007 (releases are owner-initiated: M1-99 DEFERRED, gate renamed G-RELEASE and marked ownerInitiated, milestone release versions removed).
- 2026-10-30: M2-06 FAILED in verification after an independent review (1 P0, 7 P1). Added M2-03-R1 (P0/P1 extraction) and M2-04-R1 (P1 URL) as hard dependencies of M2-06, and M2-07 for the P2 follow-ups.
