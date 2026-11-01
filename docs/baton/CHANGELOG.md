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
- 2026-10-30: owner Q&A (D009). Added M0-22-R2 (CLI search defect), M0-40 (type-check tests and scripts) and M0-41 (legacy criterion audit); M2-07 and M0-39 are in scope before M3-01.
- 2026-10-31: M0-41 legacy audit added 15 remediation tasks (≈139 h). D010: tiers all-bundled; implement all promised surface (epic M0-03-R1 decomposed into M0-03-R2, M0-05-R2, M0-09-R2, M0-10-R1, then cancelled); impact try/catch downgrade removed; all remediation before M3 (M3-01 → BLOCKED on quality dependencies).
- 2026-10-31: D013 added milestone M5 (architecture rules, Deptrac-inspired): 19 tasks M5-01 … M5-18 and M5-98 (183 h expected; M5-12 is an epic) and REQ-ARCH-001 … 023, from `docs/research/deptrac/`. Interface dependencies M5-10 → M3-04, M5-12 → M4-03 and M5-18 → M4-01 encode the shared-file overlaps found in reconciliation; no existing task changed. The remaining critical path moves from M3 (32 h) to M5-01 → … → M5-98 (62 h); M3 remains the stated next milestone. Risk R07 added, R06 extended.
- 2026-10-31: review of `3ac0d6d..2db08bd` (`reviews/REVIEW-2026-10-31-2db08bd25e13.md`, six independent reviewers): 45 newly DONE items, 17 CONFIRMED, 23 DEFECTIVE, 5 FALSELY COMPLETE (M3-08, M1-03-R1, M1-07-R1, M0-04-R3, M0-02-R2). Six defects fixed in the review (M0-05-R3, M3-06, M0-02-R2, M0-04-R2/R5, M1-03-R1) plus three test gaps (M3-01, M3-10) and stub drift (M0-12-R6). Added P1 remediation M3-08-R1, M3-09-R1, M0-02-R7, M0-10-R4, M1-07-R2 and M0-04-R6 (READY), raised M0-02-R6 to P1 (reproduced; READY), and added P2 M3-02-R1, M3-05-R1, M3-11-R1, M3-07-R1, M0-12-R7, M0-17-R5, M0-20-R3, M2-06-R2, M2-04-R3, M0-09-R5, M1-03-R2 and M0-11-R3 (BACKLOG). No unstarted task depended on the disputed items, so no dependency was added. affectedFiles completed for M0-03-R3, M0-12-R3/R5/R6, M0-17-R3, M3-02/04/06/09 (docs touched by their commits).

## 2026-10-31 / 2026-11-01 — Remediation of the 2db08bd review (D015–D018)

- D015: the owner asked for the P1 remediation first, then the P2s, before new milestone work. The promotable M4/M5 tasks take a hard dependency on every open remediation task (addendum: M0-02-R8, M0-12-R8 and M0-12-R9 too).
- Done: the 7 P1 tasks (M0-02-R6, M0-02-R7, M0-04-R6, M0-10-R4, M1-07-R2, M3-08-R1, M3-09-R1) and the 13 P2 tasks of the review (M0-09-R5, M0-11-R3, M0-12-R7, M0-17-R4, M0-17-R5, M0-20-R3, M1-03-R2, M2-04-R3, M2-06-R2, M3-02-R1, M3-05-R1, M3-07-R1, M3-11-R1). Each passed at least one independent review, with every finding fixed or recorded in its report.
- Registered and done during the remediation:
  - M0-02-R8: sync after renames and config changes, from reviewer L;
  - M0-12-R8: Svelte script extraction, from D016;
  - M0-12-R9: Python namespace packages, from reviewer J;
  - M4-09: tests no longer write to the checkout.
- D016: the Svelte docs overclaimed; M0-11-R3 AC4 was corrected, and Svelte extraction became M0-12-R8.
- D017: app boundaries for Vue scopes and JS/TS aliases are separately built apps; M3-09-R1 AC2 was reworded.
- D018: Python absolute-import roots (the source-root rule was withdrawn); M0-12-R9 AC2 was reworded.
- `verificationCommands` of M4-09 changed while in progress to `node scripts/baton/check-test-cwd.mjs …`. `affectedFiles` were extended where lanes needed files outside them (recorded in each report).

## 2026-11-01 — Owner Q&A (D019)

- D016, D017 and D018 ratified.
- Added BACKLOG gap tasks from the remediation reports: M2-08 (P1, calls through the file's own imports), M0-02-R9 (sync follows go.mod and composer.json), M0-12-R10 (Svelte templates) and M0-17-R6 (heuristic follow-ups). Each depends hard on M4-01, M4-03, M4-04, M4-05 and M4-08; M5-01 and M5-02 depend hard on all four.
- Epic M5-12 (24 h) decomposed into M5-19 (external_refs store, 6 h), M5-20 (npm, 6 h), M5-21 (Composer, 4 h), M5-22 (pip/Poetry/uv, 5 h), M5-23 (Go, 4 h) and M5-24 (selectors and reporting, 6 h), then CANCELLED. REQ-ARCH-008 and REQ-ARCH-014 retraced; the M5-01 spec's mentions updated.
