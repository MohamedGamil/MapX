# Decisions

Planning and architecture decisions made under BATON. Earlier decisions are in `specs/DECISIONS.md`.

## D001 — Adopt BATON; TASKS.json is the source of truth (2026-10-30)

MapX moves from `specs/ITERATIONS.md` plus per-iteration markdown to the BATON control plane used in OmniStrike:
- `docs/baton/TASKS.json` holds status, dependencies, gates and evidence;
- `scripts/baton/` (`npm run plan:*`) owns every status change;
- `docs/baton/iterations/<ID>.md` holds each iteration's spec.

`specs/` stays as frozen history and design reference. Feature specs `specs/features/F*.md` are cited from task `sources`.
Why: the old log marked I01–I22 done with no recorded verification. Per-iteration files contradicted it (I18, I19, I22), and post-I22 work had no iterations at all.

## D002 — Legacy iterations imported as DONE on baseline evidence (2026-10-30)

I01–I22 become M0-01 … M0-22 (`legacyId` keeps the old id). Their evidence is the baseline run at import (`reports/M0-BASELINE.md`), not per-criterion proof. Disputed items get remediation tasks (`<ID>-R1`). Terminal DONE states are never rewritten.

## D003 — Skills live in `.claude/skills/` (2026-10-30)

OmniStrike keeps skills in `.agents/skills/` and symlinks them from `.claude/skills/`. In MapX, `.agents/` is gitignored because `mapx agents generate` writes there (`src/agents/templates.ts`). So `baton` and `baton-review` live directly in `.claude/skills/`, and AGENTS.md points other harnesses to them.

## D004 — Milestones follow releases; fixtures before fixes (2026-10-30)

M1 (0.4.0), M2 (0.5.0) and M3 (0.6.0) each start with a labelled synthetic fixture and a recall/precision scorer (M1-01, M2-02, M3-01). Fix tasks depend on their fixture, so each gain is measured, following the report's suggestion to re-measure after every release. Publishing a release requires an owner-approved gate (`G-REL-x.y.z`).

## D005 — Do not ship source maps in the npm package (2026-10-30)

Owner decision: stop shipping the 7.8 MB `dist/ui/main.js.map`. UI source maps become opt-in with `MAPX_UI_SOURCEMAP=1` for local debugging. The bundle-size target (I15's <200 KB gzipped) is still open as M0-15-R2.

## D006 — Dashboard bundle target re-baselined to a 720 KiB ceiling (2026-10-30)

Owner decision: set a new target instead of reducing the bundle to I15's <200 KB gzipped. `dist/ui/main.js` measured 690,760 bytes gzipped, mostly Cytoscape and its layout plugins. The new target is a **regression ceiling of 737,280 bytes (720 KiB) gzipped**, about 6.7% headroom, enforced by default in `scripts/check-package.ts` and in CI. Raising it needs a new decision entry with the measured cause.

## D007 — Releases are owner-initiated, not milestone-driven (2026-10-30)

Owner decision: 0.4.0 is not released at the end of M1. A release happens only when the owner, after several iterations, judges that the accumulated changes warrant one, and signs off manually. Consequences:
- milestones carry no release version;
- the release task (M1-99) is DEFERRED;
- gate `G-REL-0.4.0` becomes `G-RELEASE` with `ownerInitiated: true`.

Agents never request this gate, never bump `VERSION` and never publish. Unreleased work keeps accumulating under CHANGELOG `[Unreleased]`.

## D008 — HTTP call-site contract: `.mapx/http-calls.json` (2026-10-30)

Frontend HTTP calls are persisted like routes, in `.mapx/http-calls.json`. It holds one record per client call site:

```
{ file, line, method, rawUrl, url, pattern?, route: { method, path, handlerSymbol?, handlerFile } | null }
```

- **`url`** is resolved: base URL joined with axios semantics, constants and template parts substituted, and unknown parts written as `{}`.
- **`route`** is the paired backend route; `null` means unmatched.
- **Writers:** M2-03 writes `file`, `line`, `method` and `rawUrl`; M2-04 and M2-05 fill `url`; M2-06 fills `route` and adds `http` edges.
- **Scorer:** `scripts/eval/score-http.ts` reads only this file, so the scorer (M2-02) can be built before any extractor exists.

Why: it mirrors `routes.json` (M1), keeps each stage independently testable, and lets the fixture record a 0.3.5 baseline of 0 now.

## D009 — Owner Q&A on clearing open issues (2026-10-30)

- **Scope before the next work item (M3-01):** fix M2-07 (the HTTP review P2s), M0-22-R2 (CLI search truncation), M0-40 (type-check tests and scripts, R04), M0-41 (full criterion-level audit of the legacy iterations, R01) and M0-39 (tests for untested 0.3.x features).
- **Root repo:** when sub-repos are registered, the workspace root `.` stays registered. It indexes files outside every sub-repo; the nested-repo fix (M0-23) already prevents double indexing. No change.
- **Commits:** one commit per task on `develop`.

## D010 — Owner Q&A on the legacy audit (2026-10-31)

Context: the M0-41 audit found 0 of 16 legacy iterations fully confirmed (`reviews/REVIEW-2026-10-30-legacy-audit.md`).

- **Language tiers (M0-12-R2):** all grammars are bundled. Amend I12/F20 accordingly: `lang list` reports every grammar as bundled; add `lang info`; `lang install`/`uninstall` become clear messages ("all grammars are bundled") instead of copying files nothing reads; add shebang detection.
- **Specified-but-unbuilt CLI/MCP surface (epic M0-03-R1):** implement everything as specified. The epic is decomposed into M0-03-R2, M0-05-R2, M0-09-R2 and M0-10-R1.
- **Impact try/catch downgrade (M0-11-R1):** remove it. Risk depends on call depth and test files only, as F19 specifies.
- **Ordering:** the whole remediation backlog, P2 included, is done before M3. M3-01 has a hard dependency on every remediation task.

## D011 — Distribution facts (M0-07-R1, 2026-10-31)

The package is `@mgamil/mapx` (the unscoped `mapx` is not ours), and the supported Node floor is 20.18 (`engines`; better-sqlite3 12 requires it). F13's "npm install -g mapx" and "Node 18" are superseded by these facts. Generated configs and docs use the scoped name.

## D012 — metrics and edges output contract (owner Q&A, 2026-10-31)

Context: review 2026-10-31 found `metrics` and `edges` output diverging from F02/F04 (task M0-03-R3). The owner compared samples and chose:

- **`metrics --format json` / `mapx_metrics`:** F02's envelope with camelCase keys, matching `export --format json`: `{ dir, generatedAt, summary: { files, edges, density }, files: [{ path, language, inDegree, outDegree, totalDegree, instability, pagerank }] }`.
- **`metrics` text:** F02's ranked table (`RANK FILE IN OUT TOTAL INSTABILITY`) under a `Files | Edges | Graph density` header with the instability legend; `--top` defaults to 20 (`--top 0` lists every file); `--exclude <glob,...>` is added.
- **`edges <file> --format json` / `mapx_edges`:** F04's `{ file, direction, incoming[], outgoing[] }` with camelCase keys, keeping `targetRepo` and `line`. Incoming rows carry `sourceFile`, outgoing rows `targetFile`. Without a file (`--from`/`--to`) the flat edge list stays.
- **`edges <file>` text:** F04's `Incoming (n)` / `Outgoing (n)` sections with ←/→ arrows, and a clear message when there are no edges.

camelCase supersedes F02/F04's snake_case keys; everything else follows the specs.

## D013 — Milestone M5, architecture rules (Deptrac-inspired), 2026-10-31

Context: the owner asked for an analysis of Deptrac (PHP architecture-conformance tool) and its abstraction for MapX's 22 languages, frameworks, CLI/MCP and dashboard, then instructed integration of the result into the plan. The research pack is `docs/research/deptrac/` (01 capabilities, 02 abstract feature model AR-01…AR-19, 03 gap analysis G1–G11, 04 phased plan, 05 requirement register REQ-ARCH-001…023). The seven open items were proposed with defaults and the owner instructed integration without overriding them, so the defaults stand; each can be revised by editing the affected tasks before they start.

- **Adopted:** milestone M5 with 19 tasks (M5-01 … M5-18, M5-98; M5-12 is an epic to decompose per ecosystem) and requirements REQ-ARCH-001…023 (P1 MUST = the CI gate, P2 SHOULD, P3 COULD; no P0 is claimed). Expected effort 183 h, MUST set about 65 h.
- **Ordering:** M3 stays the owner's stated next milestone (PROJECT_STATE "Next"); M5 Phase A (M5-01 … M5-06) lives in new `src/arch/`, `tests/` and `schemas/` paths and may run as a parallel lane. The only ordering constraints are the real ones, recorded as `interface` dependencies: M5-10 → M3-04 (TS/Vue extraction path), M5-12 → M4-03 (`src/core/scanner.ts`), M5-18 → M4-01 (`.github/workflows/ci.yml`). The computed critical path is now M5's chain (62 h); that reflects effort, not precedence over M3.
- **Config:** `.mapx/architecture.jsonc`, views under `.mapx/architecture/*.jsonc`, next to `config.json`, `routes.json` and `http-calls.json`.
- **Verb:** `mapx check` is the CI gate; introspection lives under `mapx arch <sub>` and the existing `mapx arch` flags stay unchanged.
- **Exit codes:** 0 clean, 1 violations, 2 uncovered/unassigned when asked, 3 config or baseline error, 4 stale graph or internal error (AR-17), instead of Deptrac's single 1.
- **Inferred edges:** warn by default; `policy.inferred: "error"` promotes them (REQ-ARCH-007).
- **External references (G3):** stored outside `edges`, in a separate table with ecosystem, package, direct/transitive and dev/prod attribution, so existing metrics, PageRank and exports are unchanged (REQ-ARCH-008, REQ-ARCH-014).
- **Ratchet:** `--compare <base-report.json>` is the MUST; `--since <git-ref>` is COULD (REQ-ARCH-021, no task yet).
- **Research home:** `docs/research/deptrac/`; task `sources` cite it. `specs/` stays frozen (D001).

## D014 — Final gaps before M3 (owner Q&A, 2026-10-31)

- **Continue (amends F17):** MapX writes Continue's documented layout instead of `.continue/mapx.yaml`, which Continue never loads: `.continue/mcpServers/mapx.yaml` for the MCP server and `.continue/prompts/*.md` for the slash commands. A leftover `.continue/mapx.yaml` written by mapx is migrated or reported. Task M0-09-R4.
- **`.fish` (F20):** bundle a licence-compatible tree-sitter fish grammar and extract `function` definitions and calls. If no usable WASM build exists, fall back to file-level indexing and record that here. Task M0-12-R5.
- **M1-05-R3:** promoted from P3 to P2 and made an M3-01 dependency (D010 applies).

## D015 — Review remediation before M4 and M5 (owner, 2026-10-31)

Answers the decision left open by `reviews/REVIEW-2026-10-31-2db08bd25e13.md`. The owner asked to work the seven P1 remediation tasks first, then the P2 remediation tasks, before new milestone work. As with D010, the promotable M4 and M5 tasks (M4-01, M4-03, M4-04, M4-05, M4-08, M5-01, M5-02) take a hard dependency on every open remediation task: M0-02-R6, M0-02-R7, M0-04-R6, M0-10-R4, M1-07-R2, M3-08-R1, M3-09-R1 (P1), and M0-09-R5, M0-11-R3, M0-12-R7, M0-17-R4, M0-17-R5, M0-20-R3, M1-03-R2, M2-04-R3, M2-06-R2, M3-02-R1, M3-05-R1, M3-07-R1, M3-11-R1 (P2).

## D016 — Svelte extraction claim and M0-11-R3 AC4 (2026-10-31)

M0-11-R3 AC4 asked for a `.svelte` reference that would link without the built-in globals check. Implementing it showed that a `.svelte` file yields no references at all: `queries/svelte/*.scm` have their JS nodes commented out, so only the script element's class symbol is extracted. The criterion's premise was false, and README and `docs/getting-started.md` overclaimed Svelte extraction. The criterion was authored by the 2026-10-31 review, not by the owner, so it is corrected to what can be tested: a test pins down that a `.svelte` script gives the component symbol and no edges. The docs are corrected now, and Svelte script extraction is registered as M0-12-R8 (P2, BACKLOG). The owner may reprioritise it.

## D017 — App boundaries for Vue scopes and JS/TS aliases, as refined by independent review (2026-10-31)

M3-08-R1 and M3-09-R1 first drew app boundaries at every folder holding a `package.json`. Four independent review rounds showed that this breaks common layouts:
- monorepo packages that use the root tsconfig `paths`;
- single-build monorepos with one root webpack config;
- component libraries consumed through `.use()`, including Vite library-mode builds;
- apps whose `package.json` has `main`;
- `{"type": "module"}` markers;
- Laravel modules registered by the root app.

The rule is now one rule for both:
- **Separately built app.** A folder with a bundler config, or a `package.json` listing a build tool. A Vue component library is a manifest with vue as a peer dependency, a library-mode build, or a published entry (`exports`, `module`).
- **Package.** Any other manifest with a name or dependencies.
- **No boundary.** A manifest without a name or dependencies.
- **Aliases.** Bundler aliases come from the nearest app. Compiler `paths` come from the nearest tsconfig/jsconfig, but not from above an app.
- **Vue global registries and route tables.** These are per app. Libraries share their registrations with every app, and a component that another app's registering file imports also sees that app's registrations.

M3-09-R1's AC2 is reworded to match. It had said bundler aliases come from "the nearest folder holding a package.json or bundler config". The criterion was authored by the 2026-10-31 review, not by the owner. Remaining limitation: a Laravel module's own `@/` imports do not reach the root app's `@` alias when the module has its own bundler config. The importer scope is not transitive: a child component of a module component registered by the root app does not see the root app's registrations (review 2026-11-01).

## D018 — Python absolute-import roots (M0-12-R9, 2026-11-01)

M0-12-R9 first treated a folder below a source root (`src/`, `lib/`, or a folder with `pyproject.toml`, `setup.py` or `setup.cfg`) as a namespace package, never a root. Independent review (reviewer M, P0) showed that this drops real project imports:
- Django in `backend/` under a root `pyproject.toml`;
- Airflow `dags/` under `setup.cfg`;
- pytest `tests/`;
- Lambda functions;
- every absolute import in a repo with a stray root `__init__.py`.

Python itself puts a script's own folder on `sys.path`, so a namespace folder outside any regular package is ambiguous: it is a root when run as a script, and a package when imported. The rule is now:
- **Not a root:** a regular package folder (`__init__.py`) and every folder inside one.
- **Always a root:** the workspace root.
- **Otherwise:** any other ancestor is a root, as before.

`import logging` in `src/nsp/app.py` with no `__init__.py` anywhere therefore links a sibling `logging.py`, as running that file would. M0-12-R9's AC2 (that case) is replaced with the reviewer's layouts. The criterion was authored by the review, not by the owner.

D015 addendum (2026-11-01): the remediation tasks registered during the remediation itself (M0-02-R8, M0-12-R8, M0-12-R9) join D015's list, so they too come before the M4 and M5 tasks. M4-09 (test hygiene, registered the same day) is done.

## D019 — Owner Q&A after the 2db08bd remediation (owner, 2026-11-01)

The owner answered four questions after the remediation was committed (`8be5cdb`):
- **Decisions D016, D017 and D018 are ratified** as recorded. Each had replaced a criterion authored by the review, not by the owner.
- **The known gaps the remediation recorded become tasks** (BACKLOG):
  - M2-08 (P1): calls resolve through the file's own imports before name lookup;
  - M0-02-R9: sync follows `go.mod` module paths and `composer.json` PSR-4 changes;
  - M0-12-R10: Svelte templates (calls, event handlers, child components);
  - M0-17-R6: heuristic follow-ups (a renamed name surviving in a comment, Vue Router shadowing and guard returns, a Laravel module's own `@/`, factory-binding promotion).
- **Order:** all remaining M4 tasks first (M4-01, M4-03, M4-08, M4-05, M4-04), then the four gap tasks, then M5. Each gap task takes a hard dependency on those five M4 tasks, and M5-01 and M5-02 take a hard dependency on the four gap tasks. M4-02, M4-06 and M4-07 stay DEFERRED.
- **Epic M5-12 is decomposed now** and cancelled (as M0-03-R1 was), into:
  - M5-19: the `external_refs` store and capture;
  - M5-20 … M5-23: package attribution and builtins for npm, Composer, pip/Poetry/uv and Go modules, each with its own fixture rows at recall/precision 1.0;
  - M5-24: package, builtin and ambient selectors, with uncovered and vendor-confinement reporting.

  REQ-ARCH-008 now traces to M5-19 and REQ-ARCH-014 to M5-19 … M5-24.

## D020 — Dashboard bundle for git, link and file installs (owner, 2026-11-01)

M4-05 moved the dashboard build out of `prepare`: installs in a checkout no longer bundle it, while `npm pack` / `npm publish` (`prepack`), the release binaries and `mapx ui` from source do. Independent review found that npm runs only `prepare` for a git dependency's install, `npm link` and `file:` installs, so those get no dashboard.

The owner chose to document this rather than detect pacote's internal environment or build once per clone:
- registry installs (the documented method) are unaffected;
- `npm run build:ui` adds the dashboard to other installs, as `docs/getting-started.md` says;
- the UI server prints that hint when it starts without a bundle.

## D021 — Version 0.3.6, built and installed locally (owner, 2026-11-01)

The owner asked for the version to be bumped to 0.3.6 (D007: owner-initiated), synced, built and installed from the local build:
- `VERSION`, `package.json`, `scripts/templates/VERSION` and the root entry of `package-lock.json` are at 0.3.6. Only those lockfile lines changed: npm 11.6.2's `npm i` would also have dropped the `libc` fields a newer npm wrote.
- The `CHANGELOG.md` Unreleased entries moved to `[0.3.6] — 2026-11-01`.
- `npm run build:wasm`, `npm run build:npm` and `scripts/check-package.ts` pass. `npm pack` produced `mgamil-mapx-0.3.6.tgz` (4.58 MB), with the dashboard, the grammars and `VERSION` 0.3.6.
- `npm run build:linux` produced a binary that reports `0.3.6`.
- The tarball is installed globally with nvm's npm (`mapx --version` gives 0.3.6), not from npmjs.

Nothing was published, tagged or pushed; `G-RELEASE` stays with the owner. The generated agent instruction files keep their `mapx v0.3.5` stamp until `mapx agents` next rewrites them.

## D022 — Version 0.3.7, built and installed locally; v0.3.6 tagged (owner, 2026-11-01)

The owner asked for these steps (D007: owner-initiated):
- **Tag.** `v0.3.6` is an annotated tag on the 0.3.6 bump commit `e1d5da0`, like the existing `v0.3.5`. It is local; nothing was pushed.
- **Bump.** The version is 0.3.7: `VERSION`, `package.json`, `scripts/templates/VERSION` and the lockfile's root entry, with only those lines changed. The Unreleased changelog entries moved to `[0.3.7] — 2026-11-01`: M2-08, M0-02-R10, M0-02-R9, M0-12-R10 and M0-17-R6.
- **Build.** `build:wasm`, `build:npm` and `check-package` pass. `npm pack` gives `mgamil-mapx-0.3.7.tgz` (4.59 MB), and the Linux binary reports `0.3.7`.
- **Install.** The tarball is installed globally with nvm's npm. `mapx --version` gives 0.3.7, and a smoke scan links a Svelte template handler.

Nothing was published. No `v0.3.7` tag was requested, so none was made.

## D023 — v0.3.7 tagged; binary user install (owner, 2026-11-01)

The owner asked for:
- **A tag.** `v0.3.7` is an annotated tag on `8914c5b`. It is local; nothing was pushed.
- **A Linux binary user install with the project's own installer,** not as a Node package.
  - `make package-linux` built `dist/release/mapx-0.3.7-linux-x64.tar.gz` and the self-extracting installer; `checksums-sha256.txt` verifies them.
  - `./mapx-0.3.7-linux-x64-installer.sh --local` installed `~/.local/bin/mapx` (a bun-compiled binary of 110 MB) and `~/.local/share/mapx/{wasm,queries,ui}`.
  - The npm-global copy left in nvm Node 24's prefix was uninstalled, so `mapx` resolves only to `~/.local/bin/mapx`.

**Verified** outside the repository, with a minimal PATH that holds no nvm Node:
- `mapx --version` gives 0.3.7, and `lang list` works;
- `init` and `scan` cover TS, Python, PHP and Svelte, with the expected callers;
- `mapx ui` serves `/` and `/main.js` from `~/.local/share/mapx/ui`;
- `mapx serve` answers MCP `initialize`.

That check found M0-07-R3: the MCP server reported version 0.1.3, and the installer's uninstall hint named a deleted temporary path. Both are fixed on `develop` for the next version. The installed `v0.3.7` binary still has them.

**Environment.** The default Node is now nvm 26.13.0, so the repository's `better-sqlite3` was rebuilt for it (`npm rebuild better-sqlite3`; `node_modules` only).

## D024 — scan and sync cover every registered repo by default (owner report, 2026-11-01)

Testing the installed `v0.3.7` binary, the owner ran `mapx scan --force` in a workspace whose config registers the root repo and the nested git repos `backend/` and `frontend/`. Only the root repo was reset and re-walked. The nested repos were not scanned, and the rebuilt index held the root repo's 8 files.

Scan and sync now cover every registered repository unless one is named: `mapx scan`, `mapx sync`, `mapx_scan` and `mapx_sync`.
- **Why:** the user expects that, and `docs/cli-reference.md` already promised "a full scan of all source files".
- **Flags:** `--repo <name>` (MCP `repo`) still limits the run to one repo. `--all` stays accepted as the explicit form.
- **Callers that name repos are unchanged:** `workspaces add` and `workspaces sync` pass explicit names.
- **Implemented by:** M0-10-R5.

## D025 — Parse worker resources: follow-up M4 work before M5 (owner, 2026-11-01)

Background: M0-06-R2 made parallel scans work at scale. On a 3,481-file project, 8 workers raised peak RSS from 2.0 to 3.8 GB, and measurement found duplicated work:
- **Pre-warm:** every worker loaded and compiled all 23 grammars (about 90 MB and 735 ms per thread). Only the fallback walk reads them.
- **Double loading:** the language parsers loaded each used grammar again.
- **Short-lived workers:** workers were started and terminated for every parse batch.

The owner accepted these items as M4 work, to be completed before M5:

| Task | Item |
| --- | --- |
| M4-10 | Load only the grammars of the files a worker parses, once per thread, and make worker activity measurable |
| M4-11 | Keep a pool of workers alive, provided it is well controlled and removes redundant work: one pool per scan or sync run, kept across MCP tool calls with an idle timeout, crash replacement, abort and shutdown |
| M4-13 | Size the pool from the work, the CPUs and the free memory |
| M4-12 | Distribute files to workers by language |
| M4-14 | Batch worker messages |
| M4-15 | Share compiled grammar code across workers |

Startup time is a desired outcome. M4-15 evaluates the risk of patching tree-sitter before anything changes: a route without a patch may be implemented, but any patch needs the owner's approval first.

M5-01 and M5-02 hard-depend on all six tasks.

## D026 — No tree-sitter patch for sharing compiled grammar code (owner, 2026-11-01)

M4-15 evaluated sharing compiled grammar code across parse workers; the evidence is in `reports/M4-15.md`.
- **Cost:** compiling a grammar costs 0.1–8 ms per worker on Node 26 and Bun 1.4, against about 377 ms of worker startup. Most of that startup is the worker's own boot, then about 48 ms of query compilation, which cannot be shared.
- **Routes:** every route needs patching `web-tree-sitter`, re-implementing its private `Language` constructor, or a custom threaded build.

The owner chose not to patch. M4-15 closes on the evaluation. Revisit only if `web-tree-sitter` gains a public API that loads a precompiled `WebAssembly.Module` under Node.

## D027 — Dashboard look and feel, tooling and workspace features before M5 (owner, 2026-11-01)

The owner asked for these new M4 tasks:

| Task | Item |
| --- | --- |
| M4-16 | An audit of the dashboard's look and feel and UX |
| M4-19 | A browser test harness |
| M4-17 | A design system, themes, and responsive, accessible layout |
| M4-18 | The new logo, which the owner will supply |
| M4-20 | Dashboard performance |
| M4-21 | Multi-repo workspaces |
| M4-22 | A config view |
| M4-23 | A cross-repo HTTP communication view, like majles's frontend to backend |

Choices:
- **Order:** M5-01 and M5-02 wait for all of them except M4-18, which waits on the owner's logo file and does not block M5.
- **Tooling:** `@playwright/test` (Apache-2.0) is accepted as a dev dependency for real-browser tests. CI installs Chromium; without a browser, the tests skip and say so.
- **Config view:** read-only first. Editing would be a later task with its own write API.

## D028 — The new MapX logo and the init banner (owner, 2026-11-01)

The owner supplied the logo symbol `mapx-logo.png` (1024×1024, transparent background) and a text-art logo `mapx-logo.txt`, with the colour `#ff02fe` for the text art.
- **The symbol:** used wherever MapX shows a logo: the dashboard header and favicons, the README and the docs.
- **The text art:** printed in `#ff02fe` as the header of `mapx init`, before its other output.

The source files live in `assets/brand/`. M4-18 no longer waits for M4-17's redesign, which builds on the logo instead.

## D029 — Version 0.3.8: tagged, packaged and installed for the user (owner, 2026-11-02)

The owner asked for:
- the version bumped to 0.3.8;
- a `v0.3.8` tag after the commit;
- the Linux binary packaged and installed for the user, as for v0.3.7 (D023).

The release holds everything since v0.3.7:
- scan and sync of every registered repo (M0-10-R5, D024), and parallel parsing in the binary (M0-06-R2);
- the parse worker pool (M4-10 to M4-15, D025, D026);
- the dashboard work (M4-16 to M4-24, D027, D028);
- cross-repo HTTP edges (M2-06-R3) and the analysis fixes (M0-32-R3).

The changelog's Unreleased entries moved to `[0.3.8] — 2026-11-02`. The tag is local; nothing is published or pushed. M5 follows.

**Installed (2026-11-02):**
- `make package-linux` built `dist/release/mapx-0.3.8-linux-x64.tar.gz` and the installer; `checksums-sha256.txt` verifies them, and the packaging smoke scan ran on worker threads.
- **Why not the installer:** its copy of the binary failed with "Text file busy", because three `mapx serve` MCP servers (the user's editors) were running the old one.
- **What was done instead:**
  - the binary was installed by rename (`~/.local/bin/mapx.new` → `mapx`); the running servers keep v0.3.7 until restarted;
  - the data folders were copied as the installer does;
  - `~/.local/share/mapx/ui` was cleared first: the installer merges into it, and the bundle is now split into hashed chunks.
- **Verified** outside the repository with a PATH without Node:
  - `mapx --version` 0.3.8;
  - a 400-file scan on 4 worker threads;
  - `mapx ui` serves the page, `main.js`, `layout-worker.js`, a lazy chunk, the logo, `/api/repos`, `/api/config` and `/api/http`, and `/api/graph` compressed (brotli 11 KB against 212 KB);
  - `mapx serve` answers MCP `initialize` with version 0.3.8.

## D030 — The architecture config may stay gitignored (owner, 2026-11-02)

Answers the decision left open by `reviews/REVIEW-2026-11-02-b2558df592cf.md` (M5-02-R2). The owner ruled that `.mapx/architecture.jsonc` and its baseline may be ignored like the rest of `.mapx/`: `mapx init` keeps writing `.mapx/` to `.gitignore`, and the config does not move. M5-02-R2 is cancelled and is no longer a dependency of M5-18. Test fixtures are different: their configs must be committed, which the review's `.gitignore` negations under `tests/fixtures/**/.mapx/` and `tests/fixtures-tracked.test.ts` ensure. M5-18's CI step needs MapX's own config in the repository, so M5-18 adds it explicitly (a negation in MapX's `.gitignore` or `git add -f`).

## D031 — A compact logo for init, scan and sync (owner, 2026-11-02)

The owner asked for the terminal logo of `mapx init` (D028) to be scaled down without losing its detail, and to be shown by `mapx scan` and `mapx sync` as well, in the CLI only (not MCP). Registered as M4-25. The compact mark is half the art's width and height (32×12) in half-block cells, so every row of the 23-row art survives; the shading becomes #ff02fe mixed toward the terminal background. `assets/brand/mapx-logo.txt` stays the source.

## D032 — Barrel sync re-parses importers only when exported names change (owner, 2026-11-02)

Answers M2-08-R1's blocking condition, after attempt 1 was reverted (`reports/M2-08-R1.md`: a 300× sync re-parse on body-only edits behind an `export *` barrel). When a module behind an `export … from` / `export *` barrel changes, `mapx sync` re-parses the barrel's importers **only when the module's exported names change**, never on every edit behind the barrel. This is correct for real API changes and cheap for body-only edits. It costs more code: the exported names are compared before and after. M2-08-R1 is unblocked (READY), still owned by claude-ff, and must test both cases: a body-only edit re-parses no importer; adding, removing or renaming an export re-parses them.

## D033 — Fixture row workspace-03 stays (owner, 2026-11-02)

M5-04 added the expected-findings row `workspace-03`: `backend/routes/api.php` imports the API controller, which is Backend → PublicApi, and the two-repo app's rules forbid it (`Backend: []`). M5-01 had left it unlabelled. The owner confirmed the label is the fixture's intent: the rules stay as they are and the row stays. Also recorded, without objection: M5-04 evaluates `private-layer` (the AR-08 chain names it), so M5-11 keeps internal markers, native markers and its fixture criterion for both rules.

## D034 — Grammar loads stay bounded; work stealing yields (owner, 2026-11-03)

Answers M4-12-R1's blocking condition. Under CPU load, idle lanes steal new grammars more often, so M4-12's AC1 (grammar loads at most languages + workers) and AC2 (no worker idles while files remain) conflict. The owner chose option (a): **cap new-grammar steals per batch**, so AC1 holds. A lane may finish while another still has files of a grammar it would have to load. M4-12-R1 implements the cap and makes the 4-worker test deterministic under load.

## D035 — M4-13-R1 and M5-98 wait for the owner; follow-ups registered, not started; v0.3.9 (owner, 2026-11-03)

- **Held:** M4-13-R1 (parse pool sizing honours CPU affinity) and M5-98 (M5 acceptance re-score) start only when the owner explicitly asks. Each carries an owner-hold blocking condition so the plan tool never promotes it.
- **Follow-ups:** every follow-up found during the 2026-11-03 consolidation is registered as BACKLOG, and none is started.
- **Release:** after the remaining work, the version goes to 0.3.9 with a local `v0.3.9` tag. The Linux binary is packaged and installed for the user, as for v0.3.7 (D023) and v0.3.8 (D029). Nothing is published or pushed.

## D036 — Release documentation before the v0.3.9 tag (owner, 2026-11-03)

Before the 0.3.9 version is pinned, the owner asked for all changes since 0.3.5 to be documented, every doc brought up to date, and the root README to reflect the features MapX provides now. Registered as M4-28 (P1). The bump and tag of D035 wait for it.

## D037 — Version 0.3.9: tagged, packaged and installed for the user (owner, 2026-11-03)

As asked in D035, after the remaining work and M4-28's documentation (D036):
- VERSION, package.json, scripts/templates/VERSION and the lockfile root are at 0.3.9;
- the changelog's Unreleased entries are under `[0.3.9] — 2026-11-03`;
- `v0.3.9` is an annotated local tag;
- the Linux binary is packaged with `make package-linux` and installed with the installer's `--local` mode, as for v0.3.7 (D023) and v0.3.8 (D029).

The release holds everything since v0.3.8:
- **M5 architecture rules:**
  - `mapx check` with baselines, CI reporters, hierarchy and package/builtin/ambient selectors, internal and visibility rules;
  - `mapx arch init` with presets, `mapx arch graph`, rule-derived smells;
  - the MCP architecture tools;
  - the dashboard Architecture view;
  - MapX checking itself in CI.
- **External references** with npm, Composer, pip/Poetry/uv and Go attribution.
- **The M2/M3/M4/M5 remediation:**
  - Lua grammar repair (M4-27) and Go generic receivers;
  - import-bound externals (M2-08-R3), and the git-ref shell-injection fix (M5-08-R1);
  - the worker-pool grammar cap (M4-12-R1, D034);
  - the documentation refresh (M4-28).

Nothing is published or pushed. M4-13-R1 and M5-98 stay on hold (D035).

Install note (2026-11-03): `./mapx-0.3.9-linux-x64-installer.sh --local --force` first failed with "Text file busy", because three `mapx serve` MCP servers of another session were running the 0.3.8 binary. The old binary was renamed aside, the same installer was run, and the renamed file was then removed; the running servers keep 0.3.8 until they restart. The installer fix is registered as M4-29.

Verified outside the repository with PATH=~/.local/bin:/usr/bin:/bin:
- `mapx --version` gives 0.3.9, and `lang list` works;
- `init` and `scan` of TS, Python and PHP files give the expected callers, and `node:path`'s `join` gives no false edge;
- `mapx check` gives exit 0 when clean and exit 1 on a forbidden Domain → Http import;
- `mapx ui` serves `/`, `/main.js` and `/api/arch/report` (200);
- `mapx serve` answers MCP `initialize` as mapx 0.3.9.

A one-line PHP class losing its calls was found; it is pre-existing (0.3.8 does the same) and registered as M2-13.

## D038 — Milestone M6: dashboard graph scale and readability; remaining findings registered (owner, 2026-11-03)

The owner asked for work items covering:
- dashboard UI and Architecture-view performance;
- more readable graph layouts;
- performance on large codebases;
- easier browsing of complex nodes and edges, applied to the Architecture screen as well.

They are registered as milestone **M6**, documented only and not started:
- **M6-01:** large-graph fixtures (2k/10k/50k files, a 40+ layer architecture config) and baseline measurements. Fixture first: every other M6 task is measured against it.
- **M6-02:** graph aggregation API.
- **M6-03:** renderer decision between Cytoscape canvas, Cytoscape WebGL and sigma.js.
- **M6-04:** level-of-detail rendering.
- **M6-05:** readable layered and grouped layouts.
- **M6-06:** browsing (focus, neighbourhoods, paths, filters, search, minimap).
- **M6-07:** the Architecture screen at scale.
- **M6-08:** runtime performance (virtual tables, workers, caching).
- **M6-09:** perf budgets that hold under load.
- **M6-98:** acceptance.

Findings from the 2026-11-03 session not registered before are BACKLOG too: M4-09-R5, M4-30, M4-31, M4-32 (owner decision on CLAUDE.md), M5-22-R1, M5-23-R1, M4-27-R1 and M5-25-R4.
