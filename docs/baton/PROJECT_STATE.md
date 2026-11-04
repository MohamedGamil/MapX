# MapX project state

Updated 2026-11-04 (P2 defects, D041/D042). `EXTRACTOR_VERSION` is 32. Each item is committed on `develop` when DONE (D042); nothing is pushed or published.

- **D041/D042:** the owner started the P2 resolution defects and asked for a commit per item, continuing to the end of the batch. Remaining: M2-14, M2-20-R1, M2-21, M2-27, M2-28 and M2-12-R2. M6 (D038), M4-13-R1 (D035) and the P3 follow-ups stay held.
- **Done in the batch:**
  - **M0-02-R13:** a package.json edit re-parses only the files a field their resolution reads changed for. A root `version` bump on a 700-file npm tree re-parses 0 files instead of 598. Gaining or losing `vue`/`vue-router` re-parses the files, of any language, that hold a name the vue-router ignore list adds or drops. Full-scan output is byte-identical.
  - **M2-08-R5:** Python and Java package imports never link project symbols.
  - **M2-08-R4:** sync follows a module turned script, and new `declare global` names.
  - **M2-12-R1:** the arch UI spec counts follow M2-12. Bisected; `test:ui` had failed since M2-12 because it is not in `npm run check`.
  - **M4-09-R5:** every test run uses a private TMPDIR, and its teardown names any leftover.
  - **M0-07-R4:** the self-extracting installer removes its unpacked archive, including on HUP, INT or TERM and with stdin closed.
  - **M2-23:** Laravel migrations, seeders, factories and views (Blade parsed for its PHP) get class edges. Member calls in those files link only typed receivers. Their methods are no name-fallback targets.
  - **M2-16:** PHP `self::`/`static::`/`parent::` calls link the method the enclosing class's chain declares, with traits, `insteadof` and `as`. Vendor parents link nothing. On a real Laravel app it added 579 edges and removed none.
  - **M2-08-R9:** sync follows new global declarations (a new or renamed script, an added global, `declare global` in a new file), using the sync's own parse in a second worker batch. It also fixes a tree-sitter tree leak in main-thread parsing (`mapx serve`, watch mode).
  - **M2-08-R8:** sync re-parses the Java and Python importers whose import decision a changed package, class or top-level name flips, so sync matches `scan --force`. Re-parse cost is bounded: 1 file for a body edit or a single add.
  - **M2-08-R7:** a bare Python name resolves by name only in its own file and the files it star-imports, through re-export chains. The builtin `open` no longer links a project `open`. Checked on an 11k-file corpus.
  - **M2-08-R11:** bare imports resolve under module roots read from webpack `resolve.modules`, jest `moduleDirectories`/`modulePaths` and `NODE_PATH` in scripts. The nearest config decides. Scan cost and index size are back to HEAD's.
  - **M2-08-R6:** a JS/TS bare specifier never resolves to a root-relative project file. Workspace packages resolve by name, and a referenced tsconfig `baseUrl` is read.
  - **M0-07-R7:** the installer reads the installed version without `grep -P`, so it works on macOS.
  - **M0-07-R5:** the documented `curl … | sh` install works. Prompts go to /dev/tty; with no terminal, the installer does a `--local` install. The docs' commands are tested verbatim against a curl shim.

  Each was independently reviewed, with P1 findings fixed before DONE.
- **Registered from the batch:**
  - M2-08-R8 (P2): Java sync after an imported package is deleted.
  - M2-08-R9 (P2): sync for new global declarations.
  - M0-07-R4 (P2): the installer leaves its unpacked archive (done).
  - M0-07-R5 (P2): README's `curl … | sh` (done).
  - M0-07-R7 (P2): macOS `grep -P` (done).
  - M0-07-R6 (P3, held): an empty custom prefix.
  - M2-08-R11 (P2): configured module roots (done).
  - M2-27 (P2): a Java import of a project class links a same-named class in another package.
  - M2-28 (P2): a PHP `Foo::m()` links the class, not the method.
  - M2-12-R2 (P2): sync does not re-link callers when a method appears in a walked class chain.
  - M2-08-R10 and M2-25-R1 (P3, held).
- **Latest validation:**
  - `npm run check` exits 0: 161 files, 3535 passed, 4 skipped (M0-02-R13).
  - `npm run test:ui` exits 0: 54 passed on a rerun. The first run missed the perf-large budget by 1% at a load average of 16.
  - `npm run eval` is unchanged, with edges precision 0.9915.

Earlier: Updated 2026-11-04 (release refresh). Version 0.3.9: the local tag `v0.3.9` now points at the commit that documents everything since its first tagging, and `~/.local/bin/mapx` is rebuilt from it (D040). Nothing is pushed or published. `EXTRACTOR_VERSION` is 23, `ATTRIBUTION_VERSION` 2.

- **M5:** acceptance (M5-98) is DONE, and so are its follow-ups M5-98-R1 (`check --since`), M5-24-R1 (ambient access), M5-24-R2 (external multi-layer and inherited dependencies), M5-24-R3/R4, M5-16-R1/R2 (smell scoring, orphan-element and baseline-debt), M5-17-R1, M5-18-R1/R2, M5-19-R1, M5-21-R1, M5-22-R1, M5-23-R1, M5-25-R3/R4 and M5-07-R2. M5-98-R2 closed on the owner's deferral of user plugins (D040).
- **Requirements:** REQ-ARCH 22 VERIFIED, REQ-ARCH-023 DEFERRED by decision (D040).
- **Defects closed since the first 0.3.9 tag:** M4-30, M4-31, M4-32, M4-28-R1/R2, M4-29, M2-12, M2-13, M2-20, M2-25, M2-26.
- **Next work: none until the owner says (D040).** Held: M4-13-R1 (D035) and M6 (D038/D039).
- **Registered BACKLOG, not started:**
  - M5: M5-15-R1, M5-16-R3, M5-16-R4 (now also the ambient apps' smells), M5-24-R5 (more ambient sources), M5-24-R6 (an `ambient` reference kind);
  - defects: M2-14..M2-19, M2-20-R1, M2-21..M2-24, M2-08-R4..R7, M0-02-R13, M4-09-R5, M4-12-R2, M4-22-R1, M4-27-R1, M4-28-R3.

Earlier: Updated 2026-11-03 (release). Version 0.3.9, tagged `v0.3.9` and installed as the Linux binary in `~/.local/bin` (D037); nothing is published or pushed. `EXTRACTOR_VERSION` is 15.

- **M5:** every implementation task is DONE (M5-01 to M5-26 and their remediation, M5-15 to M5-24 included). Only M5-98 (acceptance re-score) is left, held by D035.
- **Defects closed since the morning update:**
  - M2-08-R3 (P1: external imports linking to project symbols);
  - M4-12-R1 (D034, grammar-steal cap);
  - M4-24-R1 (closed on a quiet machine);
  - M3-05-R3, M5-20-R1, M5-25-R2, M5-07-R1 and M4-09-R3/R4.
- **Documentation:** refreshed for the release by M4-28 (D036), and guarded by tests/docs-surface.test.ts.
- **Held:** M4-13-R1 and M5-98 (D035).
- **Follow-ups registered as BACKLOG, not started:**
  - M5: M5-18-R1, M5-24-R1/R2/R3, M5-17-R1, M5-15-R1, M5-25-R3, M5-07-R2, M5-16-R1/R2 and M5-21-R1;
  - defects: M0-02-R13, M2-08-R4, M4-12-R2, M4-28-R1/R2, M4-22-R1 and M2-12.

Earlier: Updated 2026-11-03, consolidation under claude-ff. The owner closed the other sessions; claude-ff runs every lane (one worktree per task, an independent review per commit, P0/P1 fixed before DONE, a clean-clone `npm run check` before each closure). `EXTRACTOR_VERSION` is 13. Commits are local on `develop`; nothing is pushed or published.

Done since the last update:
- **M5:**
  - **Rules:** M5-10 and M5-11 (internal and visibility rules; the arch scorer is at 33/33, precision 1); M5-09 (hierarchy and member selectors; inherited dependencies).
  - **Reporting and tooling:** M5-06 (baselines); M5-07 (CI reporters); M5-08 (the arch report in `mapx arch`); M5-13 (layer graph reporters); M5-14 (MCP architecture tools, 39 MCP tools); M5-16 (rule-derived smells); M5-17 (`mapx arch init` with eight presets).
  - **External references:** M5-19 (the external_refs pipeline); M5-20 (npm attribution); M5-21 (Composer attribution and PHP built-ins).
- **Remediation:** M5-08-R1 (P0 security: git refs no longer reach a shell), M5-07-R1 (CI paths in a subfolder workspace), M5-25-R1, M5-25-R2 (Go generic receivers; Go method calls resolve on declared types), M5-03-R2, M2-09, M2-10, M2-11, M4-26 and M4-27.

In progress as lanes:
- **External references:** M5-20-R1 (npm unreadable nested lock) with M5-22 (pip, Poetry and uv; review findings being fixed), and M5-23 (Go modules).
- **Other:** M3-05-R3 (Pinia/Vuex at workspace roots; review findings being fixed) and M5-18 (dogfood config and CI step, per D030).

Next: M5-24 (package, builtin and ambient selectors; waits on M5-22 and M5-23), then M5-98 (M5 acceptance re-score), then M5-15 (dashboard Architecture view, P3).

Open for the owner:
- **M4-12-R1 (BLOCKED):** under CPU load, M4-12's grammar-load bound (AC1) and its no-idle-worker rule (AC2) conflict. The owner chooses which one gives.
- **Quiet machine needed:** M4-24-R1 (`npm run test:ui` perf budgets) and M4-13-R1.

`tests/worker-pool.test.ts` (grammar count) and the 30 s arch CLI tests can fail at load averages above 25; they pass when rerun.

Earlier: Updated 2026-11-02 (evening), consolidation under claude-ff. Every task below was independently reviewed and its P0/P1 findings fixed before DONE. `EXTRACTOR_VERSION` is now 3, so an older index re-parses once.

Done this session:
- M2-08-R1, M2-08-R2: barrel-aware sync; new modules re-link their importers.
- M0-02-R12: a killed full scan keeps its work.
- M4-09-R2: test temp-dir hygiene.
- M5-26: the extractor version.
- M0-12-R11: Svelte block scopes.
- M1-07-R3: Laravel route-file arrays.
- M3-05-R2: Pinia and Vuex, gated on the package.
- M5-02-R1: `arch validate-config`.
- M2-04-R4: axios client scopes.
- M2-06-R4: route-domain hosts.
- M4-26: dotted symbol names.
- M5-05-R1: walk-based staleness.
- M4-27 (P1, found this session): the Lua grammar parsed only the first file of a process. Rebuilt with a patched scanner; a grammar health test now covers every bundled grammar.

M4-24-R1 is integrated (`7f127e2`). Its DONE waits for `npm run test:ui` on a quiet machine: the two perf budgets fail under load.

In progress as lanes: M5-25-R1, M5-03-R2, M2-09 and M2-10.

Next:
- defects: M4-13-R1 (needs a quiet machine) and M3-05-R3;
- M5: M5-10 (critical path), M5-06, M5-19, M5-08, M5-09, M5-07 and M5-13.

Earlier: Updated 2026-11-02, consolidation: the owner closed the other sessions (mapx-c0, mapx-fa), and claude-ff now owns every lane. Neither session left work in flight. Their unrecorded findings are now BACKLOG tasks:
- M5-25-R1: Go qualified calls, and generic, slice and map literals;
- M5-03-R2: qualified names in C++ `.h` headers, multi-namespace C# files and one-line C++ namespaces;
- M5-05-R1: staleness in status and MCP that finds new files as check does;
- M4-09-R2: tests leave `mapx-*` temp directories.

M2-08-R1 is done (D032). A call to a name its project module certainly lacks gets no edge. Sync re-parses a barrel's importers only when a module's export signature changes: in a 300-importer `export *` barrel, a body-only edit re-parses 1 file, against 302 in attempt 1. A deleted module's importers are re-parsed. JSX text and Vue templates no longer hide imports. `./utils` resolves to the file before the folder index. The independent review's three P1s were fixed. Its pre-existing added-file gap is **M2-08-R2**.

Earlier: Updated 2026-11-02, after the review: M4-25 is done (D031, owner request). `mapx init`, `scan` and `sync` open with the text-art logo at half its size, 32×12 in half-block cells, keeping every row of the art. It is CLI only, never in pipes, CI, `TERM=dumb` or MCP. M5-02-R2 was cancelled by D030: the architecture config may stay gitignored.

Reviewed 2026-11-02 (`reviews/REVIEW-2026-11-02-b2558df592cf.md`, range `24902da..b2558df`, 57 DONE items, six independent reviewers). Fixed in the review, each with a regression test that failed first:
- P0: the M5 fixture configs under `tests/fixtures/**/.mapx/` were gitignored and never committed (a fresh clone failed 12 arch tests); `.gitignore` negations and `tests/fixtures-tracked.test.ts`. They are committed with the review.
- P1: Go embedding regression (M0-17-R5); dashboard profile pills shown as HTML text (M4-24); stale arch membership after a count-preserving sync (M5-03); `score-arch.ts` duplicate dropping (M5-01).

M4-09 is COMPLETION DISPUTED (M4-09-R1, P1, READY). Registered 14 remediation tasks: P1 M4-09-R1, M5-03-R1 (blocks M5-04, M5-09, M5-19), and M5-02-R2, cancelled by D030 (the owner allows the architecture config to be gitignored); P2 M5-02-R1, M0-02-R11, M2-08-R1, M0-10-R6, M4-13-R1, M0-12-R11, M3-05-R2, M2-04-R4, M1-07-R3, M2-06-R4, M4-24-R1.

Earlier: Updated 2026-11-02: every M4 task is done. The worker-pool tasks M4-10 to M4-15 (D025, D026), and the dashboard tasks M4-16 to M4-24 (D027, D028):
- M4-16: audit;
- M4-18: logo;
- M4-19: Playwright harness;
- M4-17: design system, themes, responsive and accessible;
- M4-24: escaping scanned values;
- M4-20: lazy engines, worker layout, compression;
- M4-21: multi-repo views;
- M4-22: read-only config;
- M4-23: cross-repo HTTP view.

Found on the way and fixed:
- M2-06-R3: http edges between repos record their target repo;
- M0-32-R3;
- the post-acceptance defects that three independent reviews found (see each report).

`npm run test:ui` (42 browser tests) runs in CI's `UI` job. M5 has started: M5-02 (configuration loader and schema), M5-01 (fixture and scorer, 0.0 baseline), M5-03 (element view, selectors, membership) and its remediation M5-03-R1 (qualified names from real scans in every namespace or module language; three-valued `not`/`any`/`all` for symbol-level selectors on files) are done. M5-25 (Go `pkg.Type{}` literals resolve across packages; found while planning M5-04 and made its hard dependency) is done. M5-04 (rule evaluator and report) is done. On the fixture it finds every row except those the baseline (M5-06) and `@internal` markers (M5-10/M5-11) own. `private-layer` is evaluated there too, and M5-11 keeps internal and native markers. M5-05 (`mapx check`: table and JSON reporters, the AR-17 exit contract, staleness by walk, `--sync`) is done. M5-26 (detect an index built by an older extractor) is registered for the scanner lane. Owner decisions on 2026-11-02: D032 unblocks M2-08-R1 (barrel sync re-parses importers only when exported names change; READY, claude-ff), and D033 keeps fixture row workspace-03. Next are M5-06 (baselines and `--compare`), M5-08 and M5-13, then M5-19, M5-09 and M5-10. Version 0.3.8, tagged `v0.3.8`, and installed as the Linux binary in `~/.local/bin` (D029); nothing is published or pushed.

Earlier: Updated 2026-11-01, after the remediation of the review of `3ac0d6d..2db08bd` (D015–D018, committed in `8be5cdb`) and the owner Q&A that followed (D019, `ccfbad5`). All remaining M4 tasks are done: M4-01 (`a4bd752`), M4-03 (`1391d31`), M4-08 (`ac26e66`), M4-05 (`e4fc861`, D020) and M4-04. Plan baseline: `develop@7e5aa19` (0.3.5). Version 0.3.7, tagged `v0.3.7` at `8914c5b` and installed as the Linux binary in `~/.local/bin` with the project's installer (D023); v0.3.6 tagged at `e1d5da0`. Not published or pushed. Owner testing of the installed binary found two defects, fixed on `develop` after `v0.3.7`: M0-10-R5 (scan/sync cover every registered repo by default, D024) and M0-06-R2 (the binary parses on worker threads; prototype-key lookups in the PHP, Vuex and Laravel code). BATON was adopted in `8903afe`. Session 6 work is committed on `develop`, one commit per task (`9a09b37` … `3c24c1d`).

## Milestones

| Milestone | Status | Notes |
| --- | --- | --- |
| M0 Delivered baseline and remediation | Remediation of the 2db08bd review DONE | P1 M0-02-R6, M0-02-R7, M0-04-R6, M0-10-R4 and P2 M0-09-R5, M0-11-R3, M0-12-R7/R8/R9, M0-17-R4/R5, M0-20-R3, M0-02-R8 DONE |
| M1 Laravel route correctness | M1-07-R2, M1-03-R2 DONE | Routes scorer: 145 labels, URI/handler/attribute recall 1, precision 1, 0 FP. M1-99 (release) DEFERRED (D007) |
| M2 Cross-language precision and HTTP pairing | M2-04-R3, M2-06-R2, M2-08 DONE | HTTP scorer: 48 labels, every metric 1.0 |
| M3 Vue SFC semantics | All remediation DONE (M3-08-R1, M3-09-R1, M3-02-R1, M3-05-R1, M3-07-R1, M3-11-R1) | Edge scorer: 132 labels, recall 1.0, precision 0.992 (1 FP of 32 negatives: v3-039) |
| M4 Measurement and DX | All DONE except the review's remediation (M4-09-R1, M4-13-R1, M4-24-R1); M4-25 compact logo DONE (M4-09, M4-01, M4-03, M4-08, M4-05, M4-04; worker pool M4-10–M4-15; dashboard M4-16–M4-24) | `npm run eval` checks the three scorers against `scripts/eval/floors.json` in a CI `Eval` job (M4-01). Name resolution is linear on shared names: a generated 16,000-file scan takes 18 s instead of 70 s, with identical edges (M4-03). The routes and HTTP scorers reject malformed options (M4-08). Installs no longer bundle the dashboard; pack/publish and `mapx ui` from source do (M4-05, D020). A git sync that changes nothing indexed skips the post-scan analysis: 11 s → 2 s at 16,000 files (M4-04). M4-02, M4-06 and M4-07 deferred. M4-02, M4-06 and M4-07 deferred |
| M5 Architecture rules (Deptrac-inspired) | 28 of 37 DONE, 2 cancelled (M5-12, M5-02-R2 by D030); in progress M5-18, M5-20-R1, M5-22, M5-23; next M5-24, M5-98, M5-15 | Added 2026-10-31 (D013) from `docs/research/deptrac/`. M5-01 and M5-02 wait for the D019 gap tasks. Epic M5-12 decomposed into M5-19 … M5-24 and cancelled (D019). Interface deps: M5-10 → M3-04, M5-19 → M4-03, M5-18 → M4-01 |

Live list: `npm run plan:scan`.

## Remediation 2026-10-31 / 2026-11-01 of the 2db08bd review (D015–D018)

- **Order (D015):** the 7 P1s, then the P2s, before M4/M5. All 24 remediation tasks are DONE (20 from the review, plus M0-02-R8, M0-12-R8, M0-12-R9 and M4-09 registered on the way).
- **Method:**
  - P1s in a `scanner.ts` lane worked here, plus parallel worktree lanes for disjoint files (aliases, Laravel, middleware, and each P2 group).
  - Every task had at least one independent review: 9 review agents in all, given the diff and criteria but not the conclusions. Several tasks went through two or three rounds.
  - Every P0/P1 finding was fixed with a regression test and a mutation check before DONE. P2s were fixed or recorded in the task's report.
- **Notable corrections from review:**
  - performance of git sync with gitignored files (quadratic `existsExactly`, globs recompiled per call);
  - eol=crlf checkouts re-listing every file;
  - the Vue app boundary and alias boundary rules (D017);
  - a Python import rule that dropped Django, Airflow and pytest imports (D018);
  - rename round-trips losing callers' edges;
  - a menu config taken for a route table.
- **Measured:**
  - on an 18,000-file repo, a no-op sync takes 2.5–3.5 s against 5.8–6.3 s on base, and a no-op scan 12 s against 18 s;
  - MapX's own call edges went from 2,634 to 2,589: 51 removed, mostly wrong links of calls on locals, and 6 added (2 wrong `p.start()` guesses, documented).
- **Corrected decisions:** D016 (Svelte docs claim, then real extraction in M0-12-R8), D017 (app boundaries), D018 (Python roots). Each replaced a criterion authored by the review, not by the owner.
- **Known gaps recorded in reports** (now tasks M2-08, M0-02-R9, M0-12-R10 and M0-17-R6, D019):
  - calls are resolved by name, not through the file's named import;
  - `go.mod` and `composer.json` changes are not followed by sync;
  - a renamed name surviving in a comment keeps old edges until a force scan;
  - heuristic guard detection in Vue Router;
  - Svelte templates are not read;
  - a Laravel module's own `@/` does not reach the root `@` alias.

## Planning 2026-10-31: milestone M5 (D013)

Deptrac analysed and abstracted for MapX (`docs/research/deptrac/`, six documents). Plan additions: milestone M5 with 19 tasks (183 h expected; MUST set about 65 h) and REQ-ARCH-001 … 023. Reconciled against `develop@8b933e1`: no file overlap with M3; overlaps with M4-01 (`ci.yml`), M4-03/M4-04 (`scanner.ts`) and M4-05 (`package.json`) are carried as interface dependencies or R07. No existing task, `src/`, `tests/` or `specs/` file changed.

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

## Review 2026-10-31 of `3ac0d6d..2db08bd` (independent, six reviewers)

Scope: sessions 6 and 7 (78 commits, 45 newly DONE items). Report: `reviews/REVIEW-2026-10-31-2db08bd25e13.md`.

- **Evidence:** all 75 distinct registered commands exit 0; the three scorers reproduce the recorded numbers exactly; test counts match the reports.
- **Verdicts** (45 items): 17 CONFIRMED, 23 DEFECTIVE, 5 FALSELY COMPLETE (M3-08, M1-03-R1, M1-07-R1, M0-04-R3, M0-02-R2). Real-world shapes the fixtures lack keep breaking: two apps in one repo (Vue registry, route table, aliases, PHP names, Kernel), RouteServiceProvider mounts, and git sync sequences.
- **Fixed in the review** (regression test + mutation check each): Console Kernel verified middleware edges (M0-05-R3); webpack magic-comment lazy routes (M3-06); git sync ignored the scan walk's file rules (M0-02-R2); two-app PHP resolution (M0-04-R2/R5); raw PHP in `Route::any` URIs (M1-03-R1). Test gaps closed for M3-01 (scorer) and M3-10 (PHP methods).
- **Remediation:** 7 P1 READY (M3-08-R1, M3-09-R1, M0-02-R6, M0-02-R7, M0-10-R4, M1-07-R2, M0-04-R6), 12 P2 BACKLOG.

## Session 7 (2026-10-31): M3 Vue SFC semantics

Owner go-ahead for M3. Each task ran in its own worktree lane, was cherry-picked onto `develop` and closed with registered evidence (`4194c1e` … `db0c8b1`).

- **M3-01:** Vue 2.7 + 3 fixture (`tests/fixtures/vue-sfc`), edge contract (`iterations/M3-01.md`), `scripts/eval/score-edges.ts`. Baseline recall 13.5%, precision 62.5%.
- **M3-02 … M3-06:** template pass and component symbols, Options API `this.x()` and mixins, `<script setup>` macros and composables, Vuex/Pinia by namespace and store import, Vue Router `navigate` edges (new edge type).
- **Added during M3 from lane findings:** M3-07 (framework detection from sub-folder package.json, scoped), M3-08 (global registry and route records re-link on sync, per app), M3-09 (tsconfig/jsconfig/vite/webpack aliases), M3-10 (case-sensitive name lookup; MapX self-scan lost 49 wrong `call` edges), M3-11 (navigation from stores, guards and composables), M3-12 (HTTP pass and vue-router use the shared alias resolver). Also M0-04-R5 (PHP global function calls and require/include had no edges at all).
- **Edge scorer:** recall 13.5% → 100% (119/119), precision 62.5% → 99.0%, false positives 5 → 1 of 23 negatives. Routes and HTTP scorers unchanged at 1.0.
- **Registered, not started:** M0-17-R4 (calls on library/DOM receivers link to same-named project symbols; the remaining edges FP), M0-02-R6 (git sync after an edit reverted to HEAD; unreproduced), M4-08 (scorer flag strictness, P3).
- **Process notes:** the M3-01 lane ran without the lane brief (deleted in a scratchpad cleanup) and transitioned its own task with real evidence; the brief was restored and later lanes followed it. Fifteen cloned tasks had a copied `objective`; corrected in `b4ec122`.

## Session 6 (2026-10-31): review remediation

Owner Q&A first: D012 (metrics/edges output contract: spec structures, camelCase). Then five parallel lanes in git worktrees, each task cherry-picked onto `develop` and closed with registered evidence.

- **Review remediation (19 tasks):** M0-20-R2, M1-03-R1, M2-04-R2, M0-03-R3, M0-09-R3, M0-07-R2, M0-05-R3, M1-07-R1, M0-11-R2, M0-05-R4, M0-12-R3, M2-06-R1, M0-02-R2, M0-10-R2, M0-32-R1 (stack overflow found in M0-12-R3), M0-17-R2, M1-05-R1, M0-12-R4, M0-04-R2.
- **Follow-ups found by the lanes:** M0-32-R2, M0-17-R3, M0-03-R4, M1-05-R2, M0-02-R3, M0-10-R3, M0-02-R4, M0-02-R5, M0-04-R3 (10 DONE). Final gaps (D014): M0-09-R4, M0-12-R5, M0-12-R6, M1-05-R3. M1-05-R3 registered as P3.
- **Scorers:** routes 41 → 112 labels (URI 88/88, handler 85/85, 0 FP; the scorer now requires negative labels to be reported and flagged, and has `absent`); HTTP 32 → 46 labels (all metrics 1.0; every routed label carries a handler).
- **Measured:** import resolution 6.60 s → 0.12 s at 2,000 Java files (M0-12-R3); 20,000-file cyclic repo scans instead of crashing (M0-32-R1).
- **Integration fixes:** a test-typecheck error from M0-03-R3 (`9b8f9f6`); M0-03-R3 density counted raw edges (`b99f3a9`); the 214 s real-scan SCC test is opt-in via `MAPX_SLOW_TESTS=1` (`8965717`).
- **Process notes:** worktrees were created from `main` and every lane reset to `develop`; a 5-hour API limit paused all lanes for ~20 min; M0-04-R2 was missed in the first lane plan and started late. The M1-05-R1 oracle loaded `laravel/framework` through `/home/mgamil/majles/backend/vendor/autoload.php` with synthetic routes only (nothing committed from it); later lanes were told not to touch other projects and M1-05-R2 installed the framework fresh.

## Review 2026-10-31 (independent, six reviewers)

Scope: `40be3e4..fb75474` (M1, M2, M0-22-R2, M0-39, M0-40, M0-41 and the 18 session 5 remediation tasks). Report: `reviews/REVIEW-2026-10-31-fb75474ba377.md`.

- **Verdicts** (78 DONE items in scope): 20 CONFIRMED, 18 DEFECTIVE, 3 FALSELY COMPLETE (M1-06, M1-09, M0-12-R2), 37 UNVERIFIED (legacy and earlier-reviewed items, re-verified by command only).
- **Fixed in the review** (regression test + mutation check each):
  - P0: init / agents update / MCP replaced user-written agent files (M0-09-R1);
  - P1: the HTTP fixture `.env` files were never committed, so `npm run check` failed on a clean clone (M2-02);
  - P1: `**/_*` dropped every file and directory patterns stopped pruning (M0-02-R1);
  - P1: stale `http` edges (M2-07); `-ses` singulars (M1-05); cross-app overrides (M1-07); namespace-prefixed string class names (M0-04-R1); PHP callee lines (M0-11-R1); sync ignored shebang scripts (M0-12-R2).
- **Remediation:** 10 P1 tasks READY and 7 P2 in BACKLOG (listed in the milestone table); all are M3-01 dependencies per D010.
- **Committed** in `9bc1927`, including `tests/fixtures/vue-http/vue{2,3}/.env`; all remediation done in session 6.

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

Work order set by the owner:
1. **M4 worker resources (D025): done.**

   | Task | Result |
   | --- | --- |
   | M4-10 | Grammars per worker, loaded once |
   | M4-11 | A persistent pool |
   | M4-13 | Sizing |
   | M4-12 | Language affinity |
   | M4-14 | Batching |
   | M4-15 | Evaluated; no tree-sitter patch (D026) |

2. **M4 dashboard (D027), in order (all done):**

   | Task | Work |
   | --- | --- |
   | M4-16 | UX/UI audit: done (`fa31104`) |
   | M4-19 | Playwright harness: done, `npm run test:ui` |
   | M4-17 | Design system, themes and accessibility: done |
   | M4-24 | Escape scanned values in dashboard HTML (found in M4-17): done |
   | M4-20 | Performance: done |
   | M4-21 | Multi-repo views: done |
   | M4-22 | Read-only config view: done |
   | M4-23 | Cross-repo HTTP view: done |
   | M4-18 | New logo: done (`d246259`, D028); it does not block M5 |

3. **M5**, starting with M5-01 and M5-02. They hard-depend on the D025 and D027 tasks, except M4-18.


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

2026-11-01, after M0-10-R5 and M0-06-R2:
- **`npm run check`:** exit 0. The plan has 190 tasks; 106 test files, 1870 passed and 1 skipped.
- **`npm run eval`:** exit 0, and all floors hold.
- **`make package-linux`:** exit 0, with the new smoke scan reporting worker threads.
- **Scale check:** the compiled binary scanned a 3,481-file Laravel copy in 25.5 s on worker threads, against 37.7 s on one thread. The index was identical, and peak RSS was 3.8 GB.

2026-11-01, after M4-04 (uncommitted on `develop@e4fc861`):
- **`npm run check`:** exit 0 (plan valid with 187 tasks, changelog coverage 134 entries, typecheck, 100 test files with 1811 passed and 1 skipped, skill tests).
- **`npm run eval`:** exit 0. Routes, HTTP and edges all hold their floors; edges precision 0.9915 against a floor of 0.99.

Earlier:


2026-11-01, after the remediation (uncommitted on `develop@00407d6`):
- **`npm run check`:** exit 0 (plan valid with 176 tasks, changelog coverage 130 entries, typecheck, 96 test files with 1773 passed and 1 skipped, skill tests).
- **`npx vitest run`:** exit 0, 96 files, 1773 passed, 1 skipped.
- **Typecheck:** clean.
- **Plan:** valid, 176 tasks (147 DONE).
- **Edges scorer:** 132 labels, recall 1.0, precision 0.992 (1 FP of 32 negatives).
- **Routes scorer:** 145 labels, URI 112/112, handler 109/109, attributes 7/7, precision 1, 0 FP.
- **HTTP scorer:** 48 labels, every metric 1.0.

## Owner decisions recorded

- **D006:** the dashboard bundle target is re-baselined to a 720 KiB gzipped ceiling, enforced by `scripts/check-package.ts` and CI. M0-15-R2 is DONE.
- **D007:** releases are owner-initiated. M1-99 is DEFERRED and the gate is now `G-RELEASE` (`ownerInitiated`). Agents don't request it; work accumulates under CHANGELOG `[Unreleased]`.

- **D027 (2026-11-01):** the dashboard tasks M4-16 to M4-23 come before M5 (except M4-18, the logo); `@playwright/test` is a dev dependency; the config view is read-only first.
- **D026 (2026-11-01):** no tree-sitter patch for sharing compiled grammar code; M4-15 closed on the evaluation.
- **D025 (2026-11-01):** the parse-worker resource tasks M4-10 to M4-15 come before M5.
- **D024 (2026-11-01):** scan and sync, from the CLI and MCP, cover every registered repo unless one is named. A missing repo folder is skipped with a warning (M0-10-R5).
- **D023 (2026-11-01):** v0.3.7 tagged; installed as a user binary with the self-extracting installer; npm-global copy removed. Found and fixed M0-07-R3 (MCP version, installer hint).
- **D022 (2026-11-01):** version 0.3.7 built and installed locally; annotated tag v0.3.6 at its bump commit (local, not pushed).
- **D021 (2026-11-01):** version 0.3.6 (owner request): synced, built (npm tarball and linux binary), installed globally from the local tarball; not published.
- **D020 (2026-11-01):** git, `npm link` and `file:` installs need `npm run build:ui` for the dashboard; documented, not detected.
- **D019 (2026-11-01):** D016–D018 ratified; gap tasks registered; order M4 → gap tasks → M5; M5-12 decomposed into M5-19 … M5-24.

Resolved in session 6 (D014): Continue writes its documented layout (M0-09-R4, amends F17); a fish grammar is bundled (M0-12-R5, Unlicense, +19 KB packed); M1-05-R3 promoted to P2 and done. No owner decisions are pending.

## Known gaps

- R01: the legacy iterations were audited (M0-41) and remediated; the 2026-10-31 review found further defects outside the fixtures (see above).
- R06 (closed by M4-19): dashboard UI behaviour has browser tests, `npm run test:ui` (45). The 2,000-file graph budget passes alone (median 4,875 ms against 4,992 ms on 2026-11-02) but fails under heavy machine load.
