# MapX project state

Updated 2026-10-30. Plan baseline: `develop@7e5aa19` (0.3.5). BATON adopted today (D001); the adoption is uncommitted until the owner commits it.

## Delivered

- **M0-01 … M0-22:** legacy iterations I01–I22, imported as DONE on baseline evidence only (`reports/M0-BASELINE.md`).
- **Completion disputed** (see `reviews/REVIEW-2026-10-30-baseline.md`):
  - M0-14 (TOON tests never written) → M0-14-R1;
  - M0-15 (bundle 689 KB vs 200 KB) → M0-15-R1.
- **Unverifiable:** M0-19 → M0-19-R1, and M0-22 → M0-22-R1.

## Latest validation (2026-10-30)

- `npm run typecheck`: exit 0.
- `npm test`: exit 0, 1050 of 1050 tests in 49 files.
- `npm run plan:validate`: exit 0.
- Skill script tests: 5 of 5 pass.

## Ready now

Run `npm run plan:scan` for the live list.

- **M1-01** Laravel route fixture and scorer (P0, critical path).
- **M2-01** Fail-closed cross-language resolution (P0).
- **M0-14-R1, M0-30** (P1).
- **M0-19-R1, M0-22-R1, M0-23** (P2).

## Blocked

M0-15-R1 needs an owner decision on the bundle-size target.

## Not started

- M1 Laravel route correctness (0.4.0);
- M2 HTTP pairing (0.5.0);
- M3 Vue SFC (0.6.0);
- M4 measurement in CI.

## Known gaps

- Criterion-level review of most legacy iterations is pending (R01).
- Post-I22 work is not yet in the plan (M0-30).
