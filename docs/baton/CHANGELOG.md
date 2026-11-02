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
- M4-01 planned (spec `iterations/M4-01.md`; acceptance made falsifiable, files and commands registered) and DONE: `scripts/eval/floors.json` + `npm run eval` + CI `Eval` job; the fixture tests read the same floors. Independent review: 1 P1 (route liveness flags were not a floor) and P2s, all fixed.
- M4-03 re-scoped from measurement: a CPU profile showed name resolution (`resolveSymbolToFile`, O(k) per call to a name declared in k files) as the superlinear phase, not the resume state or fileMap rebuilds named in spec 10. Title, objective, acceptance and files updated before start; AC2 limit raised from 2 s to 20 s after it flaked under full-suite load (876 s before the change). DONE with byte-identical edges; review P2s fixed.
- M4-08 DONE: strict option parsing for score-routes/score-http (`scripts/eval/args.ts`); a missing fixture is now a usage error (review finding).
- M4-05 DONE: `prepare` is tsup only, `prepack` builds the dashboard, `mapx ui` from source builds a stale bundle; CI packs with lifecycle scripts and checks the dashboard. Review P1 (git-dependency installs lose the dashboard) resolved by owner decision D020 (documented).
- M4-04 re-scoped from measurement (post-scan is synchronous CPU work; the walk is ~6% of a scan) to: paths-only pre-walk, and a git sync early exit when nothing indexed or analysed changed (11 s → 2 s at 16,000 files), with an analysis inputs fingerprint. DONE. Added M0-02-R10 (P1, pre-existing: an interrupted git sync loses symbols), a hard dependency of M5-01 and M5-02.
- 2026-11-01: version 0.3.6 bumped, built and installed locally at the owner's request (D021; not published).
- M2-08 DONE: calls resolve through the file's own imports (JS/TS, Vue/Svelte, Python), through re-exports; sync re-parses a changed module's importers. Review: 2 P1 (sync divergence, exponential export * walk) and P2s, all fixed.
- M0-02-R10 DONE: both sync paths write file hashes only after the parse result; git sync re-parses null-hash files and drops unreadable ones. Review P2s fixed.
- M0-02-R9 DONE: sync tracks go.mod and composer.json signatures per folder (NUL-prefixed family keys, per-family marker). Review P2s fixed.
- M0-12-R10 DONE: Svelte template references with Vue resolution hints; render branch accepts .svelte and follows barrels (also Vue). Review P1 (escaped quote) and P2s fixed.
- M0-17-R6 DONE: four heuristic follow-ups (codeOnly for vanished names, router shadowing/return types, Laravel module @, export/call-gated binding promotion). Review P1 (export default) and P2s fixed. All D019 gap tasks done.

## 2026-11-02 — Consolidation under claude-ff

- The owner closed the parallel sessions (mapx-c0, mapx-fa). Each handed off with nothing in flight.
- Their findings that no task recorded were registered as BACKLOG: M5-25-R1, M5-03-R2, M5-05-R1, M4-09-R2. Registered while doing M2-08-R1: M2-08-R2 (a new file satisfying or shadowing an import).
- M2-08-R1 DONE (attempt 2, D032):
  - an export-signature gate for the barrel walk;
  - JSX-, regex- and template-aware comment stripping (`src/core/js-source.ts`);
  - the deleted-module importer queue;
  - file before folder index.

  Independent review: 3 P1 (a changed barrel not walked, JSX text cutting the skeleton, an unterminated `/*` in text) and P2s. All were fixed, except the shadowing case, which went to M2-08-R2. `verificationCommands` gained `tests/js-source.test.ts` and `npm run eval`; `affectedFiles` gained `js-source` and the queries.
- M4-09-R2 DONE: `check-test-cwd` gives the run a private TMPDIR and fails on leftovers. The `mapx-stale-*` leak in `tests/mcp-coverage.test.ts` is fixed. Review P2s fixed: the Windows tsx cache name, and cleanup failures. `verificationCommands` gained the whole-suite check.
- M0-02-R12 DONE: the full scan writes hashes with each parse result. Review P1 fixed: `last_scanned` is now the read time in all three paths, so edits made during a parse stay stale. `affectedFiles` gained `src/core/store.ts`.
- M5-26 DONE: the extractor version is recorded per repo, and an outdated index is stale (check exit 4, warnings, one full re-parse). Review: P1 fixed (an older resume state skipped the re-parse); P2s fixed (a test proving the re-parse, the re-check after `check --sync`).
- Registered M4-26 (P2): symbols whose name contains a dot (found by the M4-24-R1 lane).
- M0-12-R11 DONE (lane, cherry-picked as e6412bf): Svelte block scopes and quoted handlers. Review: P1 fixed (component names that look like void tags); P2s fixed (`{@const}` header, component attributes, quadratic lookups, index-only each, snippet types, destructuring keys).
- M1-07-R3 DONE (lane, cherry-picked as 3437053): Laravel route-file arrays and dynamic loop and conditional prefixes. Review: P1 fixed (closure and `static::` elements made files falsely unreachable); P2s fixed (loop back-edges, spread, `$key` test, do/while). L150 stays a placeholder until literal-array foreach is expanded. Routes scorer: 156 labels, URI 122/122, 0 false positives; the floors flagged 35→36 and exactParams 112→122 were raised.
- Registered M3-05-R3 (P2): the store-library gate follows package.json changes and monorepo roots.
- M3-05-R2 DONE (lane, cherry-picked as 98d9166): Pinia hooks of any name and Vuex arrow members, gated on the package using Pinia or Vuex. Review: 3 P1 fixed (React global filter, renamed destructures, source attribution on non-store hooks); P2s fixed (Koa and Redux objects, mutation scope, React scan cost, negative tests). The edges scorer is byte-identical.
- M5-02-R1 DONE (lane, cherry-picked as 81c12d7): `arch validate-config` on the CLI and MCP (34 tools), and loader robustness. Review: 3 P1 fixed (filesystem errors threw; `%` literals broke valid configs, now `%%` with undefined names literal outside name/path/package; parameters inside parameters); P2s fixed (`..legacy` views, symlinked views, empty view, framework parameters, tool counts).
- M4-24-R1 cherry-picked as 7f127e2. Review: P1 fixed (the spec missed a payload after navigation); P2s 1–8 fixed in the static check; `.length` documented. DONE waits for a `npm run test:ui` run on a quiet machine: its perf budgets fail under load, as HEAD's code does.
- M2-08-R2 DONE: recorded unresolved imports and same-path precedence re-link the importers of new modules, through barrels. Review: P1 fixed (barrels); P2s fixed (extension precedence, one record scan per call, untested paths, asset records). `EXTRACTOR_VERSION` is 2 (M0-12-R11, M1-07-R3, M3-05-R2, M2-08-R2). `affectedFiles` gained store.ts, extractor-version.ts and the scanner test mocks.
- M2-04-R4 DONE (lane, cherry-picked as 30ac482): per-block axios client scopes. Review: 2 P1 fixed (declarations in comments or strings, unscoped factory aliases); P2s fixed (fallback when masking fails; a cubic owner lookup, now 24 ms for 1,000 functions against 4.8 s at the base). The HTTP scorer is unchanged. Known on the base: `collectProviders` matches exported clients on raw text.
- M4-26 DONE (lane, cherry-picked as d6622ed): dotted symbol names. Review: P1 fixed (an exact name hid Class.method, losing callers and impact); P2s fixed (context seeds, impact short name, `Runner.go`). Registered M2-09 (member-assigned JS functions) and M4-27 (P1, found by the lane: the Lua grammar parses only the first file of a process).
- M2-06-R4 DONE (lane, cherry-picked as 768f715): literal route domains are workspace hosts. Review: P1 fixed (a domain host was served by other apps' domain-less routes); P2s fixed (negative tests; the fixture test reads the partners routes). Added labels L49 (paired) and L50 (expected unmatched); the HTTP scorer is 50/50.
- M4-27 DONE (P1): the Lua grammar's scanner state leaked between parses, so only the first Lua file of a process parsed. `build-wasm.ts` can now patch a grammar, and the Lua wasm was rebuilt with Docker emsdk 3.1.64. A grammar health test covers every bundled grammar. `EXTRACTOR_VERSION` is 3. Review P2s fixed; registered M2-10 (Lua `:` method calls).
- M5-05-R1 DONE (lane, cherry-picked as 78bbc96): walk-based staleness for status, CLI and MCP. Review: 2 P1 fixed (per-file matcher cost, now 9.7 s to 70 ms on 100,000 ignored images; a registered repo under a dot folder was missed); P2s fixed (unreadable files; tests for the gitignored-file change and the walk cost).
- M5-25-R1 DONE (lane, cherry-picked as 881921c): Go qualified calls and wrapped literals. Review: 3 P1 fixed (go.work and replace modules; shadowing locals; type parameters); P2s fixed (by-name fallback without go.mod for project packages, promoted methods, nested literals). `EXTRACTOR_VERSION` is 4. Registered M5-25-R2 (methods with a generic receiver).
- M5-03-R2 DONE (lane, cherry-picked as b3830fd): qualified names for C++ headers, C# blocks and Scala packages. Review: P1 fixed (C headers with `__cplusplus` guards were read as C++; now a conservative depth-0 rule); P2s fixed (linear and cached header check, so scan times are back to develop's; namespaces from the syntax tree for one-line C# blocks and nested Scala). `EXTRACTOR_VERSION` is 5.
