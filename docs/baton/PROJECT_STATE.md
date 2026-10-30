# MapX project state

Updated 2026-10-31, end of session 4. Plan baseline: `develop@7e5aa19` (0.3.5). BATON was adopted in `8903afe`; this session's work is uncommitted until the owner commits it.

## Milestones

| Milestone | Status | Notes |
| --- | --- | --- |
| M0 Delivered baseline and remediation | legacy imports, the first remediation round and M0-41 DONE | **18 audit remediation tasks open (D010: before M3)** |
| M1 Laravel route correctness | **10 of 10 active tasks DONE** | M1-99 (release) DEFERRED: owner-initiated (D007) |
| M2 Cross-language precision and HTTP pairing | **8 of 9 DONE** | M2-01 … M2-06 plus M2-03-R1 and M2-04-R1 done; M2-07 (P2 review follow-ups) promotable |
| M3 Vue SFC semantics | 0 of 6 | M3-01 BLOCKED until remediation is done (D010) |
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

## Session 4 (2026-10-30/31): clearing open defects (D009, D010)

- **Committed:**
  - `5b9f764` (M2);
  - M0-22-R2 (`561172c`): CLI search lists whole files and reports truncation;
  - M0-40 (`8c1526e`): type check covers tests and scripts; 19 errors fixed, including a real test bug;
  - M2-07 (`e67b48a`): HTTP review P2s, plus a latent `splitPlus` bug;
  - M0-39 (`6525daf`): tests for 4 untested features.
- **M0-41 legacy audit:** 3 independent agents, real CLI probes. **0 of 16 legacy iterations fully confirmed** (6 falsely complete, 10 defective). See `reviews/REVIEW-2026-10-30-legacy-audit.md`.
- **18 remediation tasks** (about 140 h). P0: M0-05-R1, M0-06-R1, M0-07-R1, M0-12-R1, M0-12-R2.
- **D010 (owner):** tiers all-bundled; implement all promised surface; remove the impact try/catch downgrade; **all remediation before M3**. M3-01 is BLOCKED on quality dependencies.

## Next

Run `/baton`. It picks the critical-path P0 remediation first (M0-05-R1 persist reference metadata; M0-06-R1 PHP post-processing in worker scans; M0-07-R1 package name in generated MCP configs; M0-12-R2 tiers; M0-12-R1 non-JS imports), then the P1s, then the P2s. Each task's acceptance criteria are the auditors' reproduced failing inputs.

## Done in session 3

- **M2-02:** Vue 2.7/3 HTTP fixture (32 labelled calls, 15 patterns) and `score-http.ts`; contract D008 (`.mapx/http-calls.json`).
- **M2-03:** call-site extraction (axios, fetch, instances, factories, aliases, configured receivers; ternary branches).
- **M2-04 / M2-05:** URL evaluation (constants, templates, imports) and base URLs (`axios.create`, `.env`, axios joining).
- **M2-06:** workspace-wide pairing with live backend routes; `http` edges; `mapx routes --clients [--unmatched]` and `mapx_routes { clients }`.
- On the fixture, 0.3.5 → now: call sites 0 → 100%, URLs 0 → 100%, pairing recall 0 → 100%, pairing precision 100%.
- **Independent review** of M2-03 … M2-06 found 1 P0 and 7 P1s, all fixed before M2-06 closed: M2-03-R1 (deleted-file records, global/require axios, calls in comments or strings, argument parsing), M2-04-R1 (constants, env prefixes, env walk) and pairing (client routers, `ALL`, `:id`/`<id>`). The P2s are M2-07.

## Corrections

The import review's finding "Laravel route edges lose middlewares" was wrong and is withdrawn (see `reviews/REVIEW-2026-10-30-baseline.md` and CHANGELOG).

## Latest validation

`npm run check` exit 0 (2026-10-30, end of session 3): plan valid (71 tasks); every Unreleased changelog entry cites a task; typecheck clean; 1136 tests passed; skill tests 5/5. `npx tsx scripts/check-package.ts`: 234 files, 4.29 MB packed, no source maps.

## Owner decisions recorded

- **D006:** the dashboard bundle target is re-baselined to a 720 KiB gzipped ceiling, enforced by `scripts/check-package.ts` and CI. M0-15-R2 is DONE.
- **D007:** releases are owner-initiated. M1-99 is DEFERRED and the gate is now `G-RELEASE` (`ownerInitiated`). Agents don't request it; work accumulates under CHANGELOG `[Unreleased]`.

No owner decisions are pending.

## Known gaps

- R01: criterion-level review of most legacy iterations is still pending; run `baton-review --full`.
- R06: dashboard UI behaviour has no automated tests.
