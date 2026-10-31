# MapX project state

Updated 2026-10-31, after the session 5 review (`reviews/REVIEW-2026-10-31-fb75474ba377.md`). Plan baseline: `develop@7e5aa19` (0.3.5). BATON was adopted in `8903afe`. All session 5 work is committed, one commit per task (`fa0a6e5` … `b371030`).

## Milestones

| Milestone | Status | Notes |
| --- | --- | --- |
| M0 Delivered baseline and remediation | 18 M0-41 remediation tasks DONE; **review 2026-10-31 added 12 more** | READY (P1): M0-20-R2, M0-11-R2, M0-02-R2, M0-04-R2, M0-09-R3, M0-12-R3. BACKLOG (P2): M0-05-R3, M0-05-R4, M0-10-R2, M0-12-R4, M0-17-R2, M0-07-R2, M0-03-R3 (owner decision) |
| M1 Laravel route correctness | 10 active tasks DONE; **M1-06 and M1-09 completion disputed** | READY: M1-03-R1, M1-07-R1 (P1); BACKLOG: M1-05-R1 (P2). M1-99 (release) DEFERRED (D007) |
| M2 Cross-language precision and HTTP pairing | 9 of 9 original tasks DONE | READY: M2-04-R2, M2-06-R1 (P1, review 2026-10-31) |
| M3 Vue SFC semantics | 0 of 6 | M3-01 BLOCKED: per D010 it depends on every remediation task, now including the 17 added by the review and M0-05-R3 |
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

## Review 2026-10-31 (independent, six reviewers)

Scope: `40be3e4..fb75474` (M1, M2, M0-22-R2, M0-39, M0-40, M0-41 and the 18 session 5 remediation tasks). Report: `reviews/REVIEW-2026-10-31-fb75474ba377.md`.

- **Verdicts** (78 DONE items in scope): 20 CONFIRMED, 18 DEFECTIVE, 3 FALSELY COMPLETE (M1-06, M1-09, M0-12-R2), 37 UNVERIFIED (legacy and earlier-reviewed items, re-verified by command only).
- **Fixed in the review** (regression test + mutation check each):
  - P0: init / agents update / MCP replaced user-written agent files (M0-09-R1);
  - P1: the HTTP fixture `.env` files were never committed, so `npm run check` failed on a clean clone (M2-02);
  - P1: `**/_*` dropped every file and directory patterns stopped pruning (M0-02-R1);
  - P1: stale `http` edges (M2-07); `-ses` singulars (M1-05); cross-app overrides (M1-07); namespace-prefixed string class names (M0-04-R1); PHP callee lines (M0-11-R1); sync ignored shebang scripts (M0-12-R2).
- **Remediation:** 10 P1 tasks READY and 7 P2 in BACKLOG (listed in the milestone table); all are M3-01 dependencies per D010.
- **Pending commit:** the review's working-tree changes, including `tests/fixtures/vue-http/vue{2,3}/.env`.

## Session 5 (2026-10-31): M0-41 remediation (D010)

All 18 remediation tasks are DONE. Each has a report in `reports/<ID>.md` with a mutation check, and its own commit.

- **P0:**
  - M0-05-R1: reference metadata persisted;
  - M0-06-R1: workers use the language parsers;
  - M0-07-R1: scoped package name, working binaries;
  - M0-12-R1: module, package and namespace imports for 7 languages;
  - M0-12-R2: all grammars bundled, `lang info`, shebangs.
- **P1:**
  - M0-04-R1: PHP namespace resolution;
  - M0-11-R1: impact, callees, staleness;
  - M0-20-R1: NestJS;
  - M0-02-R1: filters;
  - M0-09-R1 and M0-09-R2: agent files and templates (SSE, Continue, Aider, Zed);
  - M0-08-R1: Leiden, depth-0 cluster view, class trace, fallback SVG;
  - M0-10-R1: F18 workspace surface;
  - M0-17-R1: 11-language extraction accuracy;
  - M0-03-R2: metrics and edges surface;
  - M0-05-R2: Laravel relationships, middleware edges, models section, bindings.
- **P2:** M0-18-R1 (anonymous default class scope); M0-01-R1 (inferred member calls; dashed means inferred).
- **Found while fixing:**
  - A fresh parallel scan dropped `fileMetadata`, so PHP namespace clusters were missing (fixed in M0-08-R1).
  - The MCP config merge overwrote unparseable JSONC settings files (fixed in M0-09-R2).
  - `workspaces sync` registered every sibling repo (peers are opt-in now; M0-10-R1).
  - Hook edges ignore declared confidence (new **M0-05-R3**, P2).
- **Suite:** 86 files, 1244 tests; `npm run check` passes.

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

- The 10 READY P1 remediation tasks from the 2026-10-31 review, then the P2s (D010: all remediation before M3). `npm run plan:scan` lists them.
- M0-03-R3 needs an owner decision: implement the F02/F04 JSON shapes as specified, or record the current shapes as the contract.
- M3-01 (Vue SFC fixture set) once its dependencies are DONE; get the owner's go-ahead first.

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

2026-10-31 review: `npm run check` exit 0 after the review fixes: plan valid (111 tasks), 86 test files, 1253 tests, skill tests 5/5; routes scorer recall 1.0 / precision 1.0 / 0 FP; HTTP scorer 1.0 on all metrics; `scripts/check-package.ts` 256 files, 4.33 MB packed, dashboard 690,760 B gzipped (ceiling 737,280).

## Owner decisions recorded

- **D006:** the dashboard bundle target is re-baselined to a 720 KiB gzipped ceiling, enforced by `scripts/check-package.ts` and CI. M0-15-R2 is DONE.
- **D007:** releases are owner-initiated. M1-99 is DEFERRED and the gate is now `G-RELEASE` (`ownerInitiated`). Agents don't request it; work accumulates under CHANGELOG `[Unreleased]`.

No owner decisions are pending.

## Known gaps

- R01: the legacy iterations were audited (M0-41) and remediated; the 2026-10-31 review found further defects outside the fixtures (see above).
- R06: dashboard UI behaviour has no automated tests.
