# BATON review 2026-10-30 — full, import baseline at 7e5aa19

Scope: full review of the repository at BATON adoption (`develop@7e5aa19`), covering legacy iterations I01–I22 and the external report `docs/reports/2026-10-30-laravel-vue-coverage-findings.md`. Working tree included: yes (BATON adoption files only; no `src/` or `tests/` changes).
Environment: Linux 6.8, Node v26.9.0, npm 11.19.1, vitest 4.1.7, dependencies from `npm ci --legacy-peer-deps`. Reviewer: Claude Code session. Independent reviewer agents were launched but stopped on an API rate limit before reporting, so **every verdict below comes from one reviewer**, and items not explicitly checked are marked UNVERIFIED rather than CONFIRMED.

## Summary

- The baseline is green: `npm run typecheck` exits 0, and `npm test` passes 1050 of 1050 tests in 49 files.
- Of the report's 14 root-cause claims, 10 are confirmed (6 reproduced on a synthetic fixture) and 3 partly confirmed. One (item 13, ~10k cross-language edges) did not reproduce on a minimal fixture; a fail-closed fix is planned as M2-01.
- Of the legacy iterations:
  - 2 are **FALSELY COMPLETE**: I14 (TOON round-trip tests never existed) and I15 (bundle-size target missed by 3.4×).
  - 2 are **UNVERIFIABLE**: I19 (render edges are untested) and I22 (its own spec says in-progress).
  - 1 has a confirmed partial gap: I06 (the `$listen` stretch goal was not delivered).
  - The rest are UNVERIFIED at criterion level. Only their deliverables were spot-checked.
- Three new defects were found (the first was later withdrawn as incorrect; see Findings):
  - Laravel route edges always drop their middlewares.
  - The scan summary edge count disagrees with the stored count.
  - `composer.json` is excluded by default, which defeats nested Laravel detection.
- The planning documents had drifted: per-iteration status disagreed with the log for I18, I19 and I22; status values were inconsistent (`completed` vs `done`); and I15 has no dates. Work after I22 (0.2.x–0.3.5) has no iterations at all.
- Realignment: remediation tasks M0-14-R1, M0-15-R1, M0-19-R1, M0-22-R1, M0-23 and M0-30, plus milestones M1–M4 built from the report.
- One user decision is needed: the dashboard bundle target (M0-15-R1).

## Re-verification

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | 0 errors (`src/**` only) |
| `npm test` | 0 | 49 files, 1050 tests passed |
| `npm run plan:validate` | 0 | 53 tasks, 5 milestones, 13 requirements valid |
| `node --test .claude/skills/*/scripts/*.test.mjs` | 0 | 5 of 5 tests passed |

## Report verification (docs/reports/2026-10-30-laravel-vue-coverage-findings.md)

Reproduction: a probe script calling `LaravelDetector.extractRoutes` on synthetic `routes/api.php` and `routes/api/users.php`, plus a two-repo workspace (`backend` PHP, `frontend` JS + `.vue`) scanned with `mapx scan . --all`.

| # | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | `['uses' => 'C@m']` loses its handler | CONFIRMED, reproduced | `laravel.ts:1474-1480`: the regex is anchored `^Class@method$` on the whole array text. Probe output: `GET /api/x -` (no handler). |
| 2 | `require`d route files don't inherit the group | CONFIRMED, reproduced | No `require`/`include` handling anywhere in `laravel.ts`. Probe: `routes/api/users.php GET /users` with middleware `[]` (expected `/api/users`, `[api, auth]`). |
| 3 | Provider mounts get an empty prefix; other mounts are ignored | CONFIRMED | `laravel.ts:279-290`: only `loadRoutesFrom` is matched, with `prefix: ''` hard-coded. |
| 4 | Controller groups and resources lose the outer prefix when mounted by `require` | CONFIRMED (same cause as #2) | Follows from #2. |
| 5 | Resource parameter names differ from Laravel's | CONFIRMED, reproduced | `getResourceParam` at `laravel.ts:1066`. Probe: `{blog-category}` and `{statuse}`. |
| 6 | Dynamic path segments are emitted verbatim | CONFIRMED, reproduced | Probe: `GET /api/$base.'/x`. |
| 7 | No reachability or last-registration-wins | CONFIRMED, reproduced | No `reachable` or `overridden` field anywhere. Probe: both `GET /api/dup` routes reported. |
| 8 | Detection needs the repo at the scan root; `frameworks.json` is rewritten | CONFIRMED, with a correction | `detect()` at `laravel.ts:371` looks for `artisan`, which is never in the file list. `hasComposerDependency` (`utils.ts:43`) would search nested `composer.json` files, but `composer.json` is in the default excludes (`config.ts:54`), so only the root one is read. `frameworks.json` is write-only (`scanner.ts:1405`). The parent-folder fixture indexed 0 symbols. |
| 9 | No line numbers; route edge targets the route file | PARTLY CONFIRMED | `RouteBinding` (`types.ts:301`) has no `line`. The edge targets `route.handlerFile` plus `targetSymbol` (`scanner.ts:1469`), which is the controller file when resolution succeeds and the route file only when it fails. |
| 10 | Only `<script>` is parsed | CONFIRMED | `vue.ts:24` matches `<script>` blocks only. |
| 11 | No SFC semantics | CONFIRMED | `defineProps`/`defineEmits` are in `ignored-symbols.ts:22`. There's no Options API, Vuex or Pinia handling. The fixture's `this.$http.save` and `@click="save"` produced no edges. |
| 12 | No HTTP client → route pairing | CONFIRMED | No HTTP client modelling in `src/` (the only `axios` mention is in `context-builder.ts` keywords). |
| 13 | ~10k cross-language name-collision edges | NOT REPRODUCED | `resolveSymbolToFile` filters with `areLanguagesCompatible` (`scanner.ts:1259`, `registry.ts:514`). The two-repo fixture (`api.get`, `api.save` and `this.$http.save` against PHP `Repo::get`/`save`) produced 0 cross-language edges. The filter is bypassed when the source language is unknown (`sourceLang` null) and in the framework ScanContext resolver, which passes no `sourcePath` (`scanner.ts:1422`). Planned as M2-01: a spike, then fail-closed. |
| 14 | No `postMessage` modelling | CONFIRMED | Only the worker's own `postMessage` appears. Optional item, M4-02 (DEFERRED). |

The section 4 suggestions map to tasks M1-01 … M4-02. `REQUIREMENTS.json` traces each report item to its implementing and verifying tasks.

## Completion audit (legacy iterations)

| Item | Verdict | Basis |
| --- | --- | --- |
| M0-14 (I14 TOON) | FALSELY COMPLETE | I14 states `@toon-format/toon` is a devDependency for round-trip tests. It is absent from `package.json`, and `ToonExporter` is only `vi.mock`ed (`tests/cli.test.ts:211`, `tests/mcp.test.ts:211`). → **M0-14-R1** |
| M0-15 (I15 dashboard) | FALSELY COMPLETE | Target: client bundle < 200 KB gzipped. Measured: `gzip -c dist/ui/main.js \| wc -c` = 689,107 bytes. `dist/ui/main.js.map` (7.8 MB) ships because `files` includes `dist/`. No start or completion dates were recorded. → **M0-15-R1** (needs an owner decision) |
| M0-19 (I19 JSX render edges) | UNVERIFIABLE | Delivered (`queries/typescript/references-tsx.scm:33,39`; `'render'` in `types.ts:64`), but no test mentions render edges. `specs/iterations/I19.md` says `planned`. → **M0-19-R1** |
| M0-22 (I22 usability) | UNVERIFIABLE | `specs/iterations/I22.md` says `in-progress` with no completion date, while ITERATIONS.md says done. → **M0-22-R1** |
| M0-18 (I18 TSX fixes) | UNVERIFIED | `specs/iterations/I18.md` says `planned`; ITERATIONS.md says done. Not examined further. |
| M0-06 (I06 facades/dispatch) | Partly confirmed | The facade map has 48 entries (`php.ts:8`; the claim was 26, extendable through `facadeMap` config, `types.ts:163`). The `$listen` parsing stretch goal does not exist (no `$listen` in `src/`). |
| M0-03 (I03 metrics/edges) | Deliverable present | `--verified-only` exists (`cli.ts:1940`). |
| M0-07 (I07 npm) | Deliverable present | `.github/workflows/publish-npm.yml` uses provenance. |
| M0-13 (I13 frameworks) | Deliverable present | 22 detector files (21 claimed plus Flutter, added later). Each detector name appears in at least one test file, but several (aspnet, django, drupal, fastapi) appear in only one. |
| M0-16 (I16) | Deliverable present | 32 distinct `mapx_*` tools in `src/mcp.ts`, matching README and CLAUDE.md. |
| Others (I01, I02, I04, I05, I08–I12, I17, I20, I21) | UNVERIFIED | Imported as DONE on baseline evidence only. Criterion-level audit is pending: run `baton-review --full` once the rate limit clears. |

## Findings

### WITHDRAWN — Laravel route edges always lose middlewares (M0-13, `src/core/scanner.ts:1481`)

> **Withdrawn 2026-10-30 (during M1-09):** this finding was wrong. The Laravel detector's `resolveRouteMiddlewares` copies middlewares onto `route.middlewares` before the scanner reads them, so Laravel route edges kept their middlewares. The claim came from reading the code, without running it. A mutation check in M1-09 exposed it. The scanner now also falls back to `metadata.middlewares` for other detectors, and `tests/laravel-mounts.test.ts` asserts edge middlewares.


Scenario: any Laravel route inside `Route::middleware('auth')->group(...)` is stored with `metadata.middlewares` undefined. The scanner reads `route.middlewares`, but the Laravel detector writes `route.metadata.middlewares` (`laravel.ts:1569`). Reproduced: yes, by reading the code path. The probe shows the detector output carrying middlewares, and the edge builder drops them. Resolution: covered by **M1-09** acceptance.

### P1 — Nested Laravel detection is defeated by the default excludes (M0-13, `src/core/config.ts:54`)

Scenario: in a parent-folder workspace with `backend/composer.json`, Laravel is not detected, because `composer.json` is excluded from the indexed file list that `hasComposerDependency` searches. Reproduced: yes (the parent-folder fixture indexed 0 symbols). Resolution: **M1-08**.

### P2 — Scan summary edge count differs from stored edges (`src/cli.ts` scan output)

Scenario: in the two-repo fixture, `mapx scan . --all` printed "Found 14 symbols, 4 edges", while `SELECT count(*) FROM edges` returned 1. Reproduced: yes. Resolution: **M0-23**.

### P2 — The type check does not cover tests or scripts (`tsconfig.json` `include`)

Scenario: type errors in `tests/**` or `scripts/**` pass CI. Reproduced: by configuration. Resolution: record in RISKS (R04); not planned yet.

## Plan deviations

| Deviation | Evidence | Realignment |
| --- | --- | --- |
| Per-iteration status contradicts the log | `specs/iterations/I18.md`, `I19.md` (`planned`), `I22.md` (`in-progress`) vs ITERATIONS.md `done` | `TASKS.json` is now authoritative; `specs/` is frozen as history (D001) |
| Inconsistent status vocabulary and missing dates | I10 says `completed`; I15 has no dates; every PR field is `—`; every "Changes from original spec" says "None yet" | Imported with import-date placeholders, noted in each task's description |
| Work shipped with no iteration | CHANGELOG 0.2.x–0.3.5 (smells, DSM, layers, profile, explain, Leiden, worker threads, Flutter), specs 09/10 | **M0-30** reconciliation |
| "Done" with no verification evidence | No iteration recorded commands or results | Baseline evidence recorded (M0-BASELINE.md); criterion-level audit pending |

## Realignment verification

`npm run plan:validate` exits 0, and `npm run plan:report` regenerated the derived reports. The scanner lists 7 READY items with no plan gaps and 1 blocked on an owner decision.

## Decisions needed

1. **Dashboard bundle (M0-15-R1):** reduce `dist/ui/main.js` to under 200 KB gzipped, or re-baseline the target. Either way, stop shipping the 7.8 MB source map in the npm package.
2. **Release gate G-REL-0.4.0:** approve when M1-98 has evidence. Nothing to approve yet.

## Not reviewed / limitations

- Criterion-level checks for I01, I02, I04, I05, I08–I12, I17, I18, I20 and I21 were not done. The independent reviewers stopped on the rate limit.
- The ~10k cross-language edges (report item 13) were tested only on a minimal fixture. The pilot codebase is private and was not available.
- No CI run was triggered. Node 26 was used locally, while CI uses Node 20.
