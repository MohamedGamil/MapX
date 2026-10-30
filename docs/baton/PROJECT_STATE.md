# MapX project state

Updated 2026-10-30, end of session 2. Plan baseline: `develop@7e5aa19` (0.3.5). BATON was adopted in `8903afe`; this session's work is uncommitted until the owner commits it.

## Milestones

| Milestone | Status | Notes |
| --- | --- | --- |
| M0 Delivered baseline and remediation | all DONE except M0-39 | M0-39 (tests for untested 0.3.x features) promotable |
| M1 Laravel route correctness | **10 of 10 active tasks DONE** | M1-99 (release) DEFERRED: owner-initiated (D007) |
| M2 Cross-language precision and HTTP pairing | 1 of 6 DONE | M2-01 done; M2-02 READY |
| M3 Vue SFC semantics | 0 of 6 | M3-01 READY |
| M4 Measurement and DX | 0 of 7 | M4-03 and M4-05 promotable; M4-02, M4-06 and M4-07 deferred |

Live list: `npm run plan:scan`.

## Done this session (reports in `reports/`)

- **M0-15-R2:** dashboard size ceiling of 720 KiB enforced (D006).
- **M0-15-R1:** the npm package no longer ships the 7.8 MB source map; it went from 6.1 MB to 4.3 MB packed.
- **M0-14-R1:** real TOON tests. Fixed: invalid TOON for the `tab` and `pipe` delimiters.
- **M0-19-R1:** JSX render edges tested; verdict CONFIRMED.
- **M0-22-R1:** fixed three `mapx_search` defects (wildcard file listing capped at 20, total capped at 20, silent truncation).
- **M0-23:** nested registered repos were indexed twice; the summary now reports stored counts; git `fatal:` noise removed.
- **M0-30:** reconciled CHANGELOG 0.2.7–0.3.5, specs 09/10 and KNOWN_ISSUES. Imported M0-31 … M0-35 and added M0-36 … M0-39 and M4-03 … M4-07.
- **M0-36:** added the documented `mapx node --include-members`.
- **M0-37:** the parser-pool test now exercises the real pool.
- **M0-38:** the profiler honours `graphExcludePatterns`.
- **M1-01 … M1-09, M1-98:** Laravel mount graph. On the 41-route fixture: URI recall 67% → 100%, handler recall 57% → 100%, precision 60% → 100%, false positives 2 → 0.
- **M2-01:** reproduced name-only PHP → JS edges through the framework resolver; resolution now fails closed. MapX's own edge counts are unchanged.

## Corrections

The import review's finding "Laravel route edges lose middlewares" was wrong and is withdrawn (see `reviews/REVIEW-2026-10-30-baseline.md` and CHANGELOG).

## Latest validation

`npm run check` exit 0 (2026-10-30, end of session): plan valid (68 tasks); 19 Unreleased changelog entries all cite tasks; typecheck clean; 58 test files, 1094 tests passed; skill tests 5/5. `npx tsx scripts/check-package.ts`: 234 files, 4.29 MB packed, no source maps.

## Owner decisions recorded

- **D006:** the dashboard bundle target is re-baselined to a 720 KiB gzipped ceiling, enforced by `scripts/check-package.ts` and CI. M0-15-R2 is DONE.
- **D007:** releases are owner-initiated. M1-99 is DEFERRED and the gate is now `G-RELEASE` (`ownerInitiated`). Agents don't request it; work accumulates under CHANGELOG `[Unreleased]`.

No owner decisions are pending.

## Known gaps

- R01: criterion-level review of most legacy iterations is still pending; run `baton-review --full`.
- R06: dashboard UI behaviour has no automated tests.
