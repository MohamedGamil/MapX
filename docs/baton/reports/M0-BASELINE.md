# M0 baseline — legacy import evidence

Date: 2026-10-30. Revision: `develop@7e5aa19` plus the uncommitted BATON adoption changes (no `src/` or `tests/` file changed). Environment: Linux 6.8, Node v26.9.0, npm 11.19.1, vitest 4.1.7. Dependencies installed with `npm ci --legacy-peer-deps`, as in CI.

## What this evidence covers

Iterations I01–I22 were delivered before BATON was adopted and are imported into `TASKS.json` as M0-01 … M0-22 with status DONE. Their shared completion evidence is the baseline below: the type check and the full test suite passing at import. **This is not proof that each iteration met its acceptance criteria.** The per-iteration verdicts, the disputed completions and the remediation tasks are in [`../reviews/REVIEW-2026-10-30-baseline.md`](../reviews/REVIEW-2026-10-30-baseline.md).

## Commands

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` (`tsc --noEmit`, `src/**` only) | 0 | 0 errors |
| `npm test` (`vitest run`) | 0 | 49 test files, 1050 tests passed, 0 failed, 0 skipped |

## Limitations

- `tsconfig.json` type-checks `src/` only; `tests/` and `scripts/` are not type-checked.
- CI runs on Node 20; this run used Node 26. No CI run was triggered.
- Coverage thresholds are not enforced (`vitest.config.ts` has no `thresholds`).
- The suite passing does not exercise the TOON exporter (mocked only), JSX render edges, or the dashboard bundle size. See the review.
