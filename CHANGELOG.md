# Changelog

All notable changes to MapX are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/).

Unreleased work is tracked under **[Unreleased]**. When a version is released, move its entries from Unreleased and add a release date.

---

## [Unreleased]

### Added
- `mapx scan` and `mapx sync` (`update`) open with the MapX logo in a terminal, as `mapx init` does; the CLI only, never in pipes, CI or MCP (M4-25).
- `schemas/architecture.schema.json` ships in the package: the JSON Schema of `.mapx/architecture.jsonc`, the architecture-rules configuration (layers, selectors, allow rules, `extends`, `%parameters%`, views) that the coming `mapx check` reads. Its loader validates a document completely, reporting every problem with a JSON pointer (M5-02).

- `mapx check` checks `.mapx/architecture.jsonc` against the index (M5-05):
  - findings as a table grouped by layer, or as JSON (`--format json`, `--output`, described by `schemas/arch-report.schema.json`);
  - `--view`, `--layer`, `--rule`, `--report-uncovered`, `--report-allowed`, `--fail-on warn`, `--fail-on-uncovered` and `--sync`;
  - exit codes: 0 clean, 1 violations, 2 uncovered with `--fail-on-uncovered`, 3 configuration errors or no configuration, 4 no index or a stale one.
- The architecture rule evaluator and report (`src/arch/report.ts`, run by the coming `mapx check`) (M5-04). It covers:
  - allowances `L`, `+L` (transitive), `!L`, `*`, a `"*"` defaults key, and edge-type-scoped and advisory (`severity: "warn"`) allowances;
  - the evaluation chain: scope, uncovered, same layer, `disallowed-layer`, `private-layer`, allowed;
  - inferred edges as warnings by default;
  - one finding per class-level dependency and edge type, with a line-independent fingerprint;
  - `multi-layer`, `empty-layer` and `plus-cycle`;
  - a layer-pair matrix.

  On the labelled fixture it finds every row but those baselines and `@internal` markers own (M5-04).
- An architecture-rules fixture set (PHP, TypeScript, Python, Go and a two-repo workspace, with labelled violations, skips, uncovered and baseline rows) and `scripts/eval/score-arch.ts`, which scores a report per kind; the baseline is 0.0 until `mapx check` exists (M5-01).
- The architecture element view and core selectors (`path`, `name`, `layer`, `all`/`any`/`not`, `role`, `cluster`, `repo`, `workspacePackage`, `language`, `framework`) with layer membership that records which selector matched, computed once per scan and configuration (M5-03).

### Changed
- The terminal logo is half its former size, 32 columns by 12 rows instead of 64 by 23, without losing detail: each cell is split into two half-blocks, so every row of the art survives and its shading becomes `#ff02fe` mixed toward the terminal's background (dark or light when `COLORFGBG` says so, else a mid grey that reads on both); 256-colour terminals get one colour per shade. It shows in terminals from 32 columns, and no longer when `CI` is set or on `TERM=dumb` (M4-25, D031).

### Fixed
- Go: a struct embedding `v1.UnimplementedFooServer` or `database.Store` links again when the package name is not the import path's last element (`api/v1`, a package named differently from its folder); when two imported project packages could both be meant, no edge is made (M0-17-R5, review 2026-11-02).
- Dashboard: the Architecture profile shows its Yes/No pills again instead of their HTML as text (M4-24, review 2026-11-02).
- Architecture layer membership is recomputed after every scan and sync; a sync that kept the numbers of files, symbols and edges served the previous membership (M5-03, review 2026-11-02).
- `score-arch.ts` no longer lets a duplicate finding on another edge type, reported first, hide the one that matches a labelled row (M5-01, review 2026-11-02).
- The architecture fixture configurations under `tests/fixtures/**/.mapx/` are no longer gitignored, so a fresh clone passes the arch tests; a test fails when any file under `tests/` is ignored (M5-01, M5-02, review 2026-11-02).
- Completion of M4-09 is disputed: `tests/mcp-coverage.test.ts` still appends to the checkout's `.mapx/tool-calls.jsonl`; remediation is M4-09-R1 (review 2026-11-02).
- Architecture qualified names match the documented form on real scans (M5-03-R1):
  - nested and `a::b` C++ namespaces (`acme::domain::Order::run`);
  - Ruby module nesting and `class Billing::Receipt`;
  - Elixir functions under their module;
  - the full Dart `library` name;
  - Python packages and Rust crates in subfolders, which start at their `pyproject.toml` or `Cargo.toml`.

  The C++, Ruby and Dart symbol queries now store these declarations, and a function in a Scala `object` is a method of it (M5-03-R1).
- Go: a composite literal of a type from another project package (`domain.Order{}`, also through an aliased import) is an instantiation edge to that type; standard-library and third-party types make none (M5-25).
- `not` over a symbol-level selector no longer puts every file in a layer, and `language: typescript` also matches `.tsx` files (M5-03-R1).
- `mapx scan --repo` and `mapx sync --repo` with a name no repo is registered under fail with a message listing the registered repos (exit 1; the MCP `mapx_scan` and `mapx_sync` tools report it too) instead of reporting 0 files. A git sync reports the files it re-indexed, not every path git listed, as the hash sync does (M0-10-R6).
- A sync killed before its re-indexed files were written no longer loses a restored file, the edges into it, another repo's queued referrers, a changed tsconfig alias, or the record of a reverted edit: those records are consumed in the same transaction as the files (M0-02-R11).
- JS/TS import-bound calls (M2-08-R1):
  - a call to a name imported from a project module that neither declares nor re-exports it no longer links a same-named function in another file;
  - `mapx sync` follows `export … from` and `export *` barrels, re-parsing a barrel's importers only when a module behind it gains, loses or renames an export, or is deleted; an edit inside a function body re-parses none;
  - a `/*` inside a string or regex literal no longer hides a module's re-exports, and a commented-out `export default` names nothing;
  - `./utils` resolves to `utils.ts` before `utils/index.ts`, as Node and TypeScript do.
- A full scan killed after it indexed files, but before it wrote their parse results, no longer leaves changed files with stale symbols or loses the edges of a restored file's referrers. A file edited while a scan or sync parses it is reported stale afterwards (M0-02-R12).
- The test suite no longer appends to the checkout's `.mapx/tool-calls.jsonl`: `tests/mcp-coverage.test.ts` runs from a temporary folder, and `scripts/baton/check-test-cwd.mjs` now compares every tracked, untracked and ignored file (with its content) and runs the whole suite by default (M4-09-R1).
- The npm package no longer picks up release builds: `make package-*` writes binaries, tarballs and installers to `dist/release/`, which `npm pack` included (185 MB instead of 4.7 MB); `scripts/check-package.ts` now fails if any are packed (M5-02).

## [0.3.8] — 2026-11-02

### Added
- **The dashboard shows how repos talk over HTTP.** An HTTP Calls tab draws the calls from each frontend repo to the backend repos that serve them (and to "no route"), weighted by count; lists every call site with method, repo-pair and matched/unmatched filters; and shows both ends of a selected call: the caller's file, line and code, and the route, handler, file and line. `/api/http` serves the records `mapx routes --clients --json` prints, grouped per repo pair (M4-23).
- **The dashboard shows the effective configuration, read-only.** A Configuration tab lists each setting with its value and source (default, user or `MAPX_PARSE_WORKERS`), your own exclude patterns beside the folded built-in ones, the repos (missing folders marked) and user languages, and warns about invalid values, unknown settings, missing repo folders and incomplete user languages. `/api/config` serves it; write methods answer 405 (M4-22).
- **The dashboard shows every repo of a workspace.** A repo switcher (all repos, or one; kept in the URL as `?repo=`) scopes the graph, symbols, routes, clusters, smells, profile, DSM and metrics; a Workspace tab lists each repo's files, symbols, edges, cross-repo edges, last scan and git state, and the dependencies between repos; cross-repo edges are dashed in the graph. The API takes `repo=` and adds `/api/repos`. Metrics are now per repo throughout (they mixed whole-workspace totals with the primary repo's files), and the Clusters Map's community and layer grouping reads the cluster memberships it used to miss (M4-21).
- **Browser tests for the dashboard.** `npm run test:ui` (Playwright, Chromium) scans generated fixture workspaces, serves each with `mapx ui` and opens every tab: each must render its content with no console error, page error or failed `/api` request, and the graph must render the 500-file fixture within the M4-16 baseline plus 20%. CI runs them as the `UI` job; without an installed Chromium they skip and say so. The dashboard marks its graph state on `<body data-graph>` and a `mapx:graph-ready` performance mark for them (M4-19).

### Changed
- **The dashboard loads and lays out large graphs faster.** Its first download is 71% smaller (about 200 KB of JavaScript gzipped, from 675 KB): ELK, Dagre and Cola load when first chosen. Large fCoSE layouts run in a background worker with settings tuned for size, so the Full Codebase view of 2,000 files is ready in about 3.7–4.3 s instead of 7.1 s and the page never freezes (its longest task is about 0.4 s, from about 6 s). `/api/graph` and the scripts are sent compressed: 42 KB instead of 998 KB for 2,000 files (M4-20).
- **The dashboard has a design system, light and dark themes, and works on narrow screens and from the keyboard.** Colours, type, spacing, radii and shadows are tokens (`scripts/ui/check-tokens.ts` rejects colour literals elsewhere); the theme follows the system until chosen with the sun/moon button; below 1200 px the sidebar becomes an icon rail and below 640 px a drawer; the graph toolbar sits above the canvas and the details panel opens on selection; every control is reachable with Tab and shows a focus ring; axe finds no serious or critical violation on any tab in either theme. Metrics show bar charts with proper language names, the Clusters Map groups by directory when most files have no architecture layer, fonts come from the system instead of Google Fonts, and local clients are no longer rate-limited on `/api/graph` (M4-17).
- **New MapX logo.** The owner's logo symbol is in the dashboard header beside the wordmark, as the dashboard's favicons (16 and 32 px, and a 180 px apple-touch icon) and at the top of the README; `scripts/brand/logo-assets.sh` regenerates the sizes from `assets/brand/mapx-logo.png`. `mapx init` opens with the text-art logo in `#ff02fe` (24-bit colour where the terminal supports it, else the nearest 256 colour; plain under `NO_COLOR`), and only in a terminal at least 64 columns wide; `MAPX_NO_BANNER` turns it off (M4-18, D028).
- `mapx scan` and `mapx sync`, and the MCP `mapx_scan` and `mapx_sync` tools, cover every registered repository unless `--repo` (`repo`) names one, as `--all` does. Run at a workspace root, a plain `mapx scan --force` re-indexed only the root repo, leaving the nested repos registered there unscanned (M0-10-R5).
- Parse workers load a grammar only when they first parse a file of its language, and each grammar once per thread. Each worker used to load and compile all 23 grammars up front, and the language parsers then loaded the grammars they used again (TypeScript three times). On a generated 3,000-file mixed project, parallel scans went from 4.6 s and 1,293 MB peak RSS to 3.3 s and 872 MB from source, and the binary from 4.1 s and 1,387 MB to 2.7 s and 671 MB. `MAPX_WORKER_STATS=1` prints what the workers did, and `scripts/bench/workers.ts` measures it (M4-10).
- **One parse worker pool per run, and per `mapx serve` process.** The parse batches of a scan or sync share one pool; before, each batch started its own workers. `mapx serve` reuses it across calls, closing idle workers after `MAPX_WORKER_IDLE_MS` (default 60 s). Each run's context reaches the workers it reuses. A worker that dies is replaced, and a file that kills two workers is parsed on the main thread (M4-11).
- **The parse pool is sized per batch, from the work and the machine.** Any batch of more than 10 files used to get up to 8 workers, whatever its size or the free memory. Now small batches parse on the main thread, and larger ones get one worker per 384 KB of source: at least 2, and at most CPUs − 1, 8, the files, and what half the available memory holds. Running workers in `mapx serve` need less. A generated 3,000-file project now parses on one thread at 307 MB peak RSS instead of 902 MB, at the same speed, while three copies of MapX's own sources (829 files) still get 8 workers (6.1 s against 9.1 s on one thread). `settings.parseWorkers` (`"auto"` or a number) and `MAPX_PARSE_WORKERS` override the size (M4-13).
- **Parse workers get files by language.** Each worker gets an equal share of the batch, made of whole runs of one language, so each loads only the grammars of its share; before, files went to whichever worker was free. Idle workers take work of a language they already hold. On 8 workers, a generated six-language project needs 20 grammar loads instead of 40 (3.6 s → 3.2 s), and three copies of MapX's sources need 12 instead of 30 (M4-12).
- **Parse workers get files in batches of up to 16 files or 256 KB, and answer once per batch.** A generated 3,000-file scan sends 188 messages instead of 3,000; wall time is unchanged within this machine's noise. A failing file is still handed back alone. When a worker dies on a batch, its files are retried one per message, so only the file that kills a worker on its own is blamed. A batch that never answers is ended by a watchdog. Idle workers steal the language with the most work left, and the rest of a batch never takes on a new grammar (M4-14).
- Sharing compiled grammar code between parse workers was evaluated and rejected, so `web-tree-sitter` is not patched. Compiling a grammar costs at most 8 ms per worker, under 1% of a worker's startup, and every route depends on the library's internals (M4-15, D026).

### Fixed
- Dashboard review fixes: an unknown `?repo=` falls back to all repos instead of leaving every view empty; a quick repo switch no longer shows the previous repo's graph or metrics; each repo's communities stay separate in the All view; the Configuration tab no longer rewrites `config.json`, shows a fresh workspace's settings as defaults and survives a config without `settings`; the HTTP tab's "no route" filter works and its flow links are keyboard-operable (M4-21, M4-22, M4-23).
- Dashboard review fixes: choosing a layout while a large graph was being laid out left the graph empty; a layout engine that loaded late overrode a newer choice; switching view twice quickly could leave the graph waiting for an animation that never ended; a drawer left open on a narrow window trapped the keyboard after widening; `Accept-Encoding: gzip;q=0, *` got gzip (M4-20).
- HTTP calls from one registered repo to another's routes are cross-repo edges: they were stored without their target repo, so `mapx status --all`, `deps --cross-repo` and `mapx_dependencies` did not count a frontend's calls into its backend (M2-06-R3).
- Dashboard review fixes: the selection details and a symbol's source pass axe in the light theme and at 390 px, one Escape closes one thing (and none from a text field), the narrow-screen drawer takes and keeps focus, the colour-token check catches every named colour and runs in `npm run check`, and loopback requests from another site's page are rate-limited again (M4-17).
- **Scanned values can no longer run script in the dashboard.** Route paths, file and symbol names, smell descriptions, context results and logged tool calls were written into the page as HTML, so a file named `evil<img src=x onerror=…>.ts` ran its script on the Architecture tab. Every value is now escaped, a static check (`scripts/ui/check-escaping.ts`, run by `npm run check`) rejects unescaped interpolations, and a browser test scans such a fixture and opens every view (M4-24).
- **The Architecture tab shows the right cycles and frameworks.** A cyclic-dependency smell names the multi-file cycle it found (`js-aliases.ts -> client-calls.ts -> js-aliases.ts`), where it used to show a file's calls between its own functions as the cycle (`js-aliases.ts -> js-aliases.ts`). The codebase profile lists only frameworks found outside `graphExcludePatterns`, so a Laravel fixture app under `tests/` no longer appears next to "Has Backend: no"; its routes are still extracted (M0-32-R3).
- The standalone binary parses on worker threads: the build embeds the parse worker, which every parallel scan failed to load (`Cannot find module '/$bunfs/parsers/parse-worker.js'`), and `scripts/package.sh` smoke-scans the host binary and fails the build if it falls back to one thread. A PHP call named after an `Object.prototype` member (`$x->toString()`, `valueOf`, `constructor`) no longer reads that member as a Laravel facade: the call was dropped, and on worker threads it made the whole scan fall back to one thread. The same lookup is fixed for Vuex `dispatch`/`commit` and map helpers, and for Laravel resource names: `Route::resource('constructor', …)` lost every route of its file. A result a worker cannot hand back is parsed again on the main thread for that file only, with a warning (M0-06-R2).
- The MCP server reports the installed version in its `initialize` response (it said `0.1.3`), and the self-extracting installer's uninstall hint names the installer instead of its deleted temporary copy (M0-07-R3).

## [0.3.7] — 2026-11-01

### Added
- Svelte templates are read: `{expr}` calls, block headers, attribute values, event handlers (`on:click={save}`, `onclick={save}`) and `use:` / transition directives link to the component's own or imported functions, and component tags (`<Child />`, `<ui.Button />`, `<svelte:component this={X}>`) give render edges, through barrels too. Each-block, `let:`, `{@const}` and snippet names are never resolved; `{@html}`, comments and `<style>` are ignored (M0-12-R10).

### Fixed
- Heuristic fixes: a rename whose old name survives in a comment or string now drops stale caller edges on sync; Vue Router ignores a `next` / `push` rebound by a parameter, local or `v-for` / `v-slot` and the returns of nested functions with any return type; a Laravel module without its own `@` alias uses the app's; and `const app = createApp(App)` stays a value unless it is exported or called (M0-17-R6).
- `mapx sync` follows `go.mod` module-path and `composer.json` PSR-4 changes, re-resolving the Go or PHP files they govern, so sync equals a full scan. An edit made before upgrading and before the first sync on this version needs one `mapx scan --force` (M0-02-R9).
- An interrupted `mapx sync` (Ctrl-C) no longer loses the symbols and edges of the files it had started re-indexing: the next sync re-parses them, and `mapx status` lists them meanwhile (M0-02-R10).
- Calls to a name a file imports from a project module (JS/TS, Vue/Svelte scripts and Python: named, aliased, default, namespace, `require` and `from … import`, through re-exports and package `__init__.py`) now link that module's declaration instead of a same-named function elsewhere; `mapx sync` re-parses a changed module's importers so sync equals a full scan (M2-08).

## [0.3.6] — 2026-11-01

### Changed
- `mapx sync` in a git repo no longer reruns the whole post-scan analysis when git lists only files MapX never indexes or reads (an untracked `.gitignore`, `.idea/`, build output, logs): a 16,000-file project's no-op sync drops from 11 s to 2 s. Settings and `.mapx/frameworks.json` edits now rerun the analysis on the next sync. Scans no longer read every file twice (M4-04).
- `npm install` / `npm ci` in a MapX checkout no longer bundles the web dashboard: `prepare` only compiles the CLI, `npm pack` / `npm publish` build the dashboard, and `mapx ui` run from source builds it when it is missing or older than `src/ui` (M4-05).
- Scans of large projects no longer slow down quadratically when many files declare the same name (`get`, `render`, `handle`): a generated 16,000-file TypeScript project scans in 18 s instead of 70 s, with identical results, and an interrupted scan's resume state is written in constant-size records per batch (M4-03).
- `mapx agents generate --providers continue` now writes Continue's documented layout, an MCP server block in `.continue/mcpServers/mapx.yaml` and `/mapx-impact`, `/mapx-callers`, `/mapx-context` and `/mapx-sync` prompts in `.continue/prompts/`, and removes the `.continue/mapx.yaml` that earlier versions wrote and Continue never loaded (M0-09-R4)
- `mapx metrics` / `mapx_metrics` and `mapx edges <file>` / `mapx_edges` now return the F02/F04 structures (camelCase), metrics shows 20 rows by default with `--top 0` for all and a new `--exclude`, and invalid `--top`, `--format` or a file-less `--direction` exit with an error (M0-03-R3).

### Added
- `npm run eval` scores the Laravel route, HTTP pairing and Vue SFC fixtures against the floors recorded in `scripts/eval/floors.json` (also read by the fixture tests), and CI runs it as a new `Eval` job that fails on any regression (M4-01).
- Vue Router navigation written in plain JS/TS modules (Pinia/Vuex store actions, navigation guards, composables) now gives `navigate` edges from that function to the route's component (M3-11).
- JS/TS/Vue imports through path aliases now resolve with the project's own configuration (tsconfig/jsconfig `paths` with `baseUrl`/`extends`, or a vite / vue-cli / webpack / Laravel Mix alias, read statically, from the nearest config folder), so Laravel's `@` → `resources/js` and multi-app repositories get their import, render, mixin and composable edges (M3-09).
- Vue Router navigation (`router.push` / `replace`, `this.$router.push`, `<router-link :to>`) now gives `navigate` edges to the component of the route it reaches, and Vue Router routes resolve statically imported components to their `.vue` file instead of the router file (M3-06).
- Vue components now expose their `props` / `emits` (from `defineProps`, `withDefaults`, `defineEmits` or the Options API) on the component symbol, and composable `useX()` calls and the functions destructured from them link to the composable's file through the import, including through barrel files and Laravel's `@` alias (M3-04).
- Vuex map helpers, `$store.dispatch/commit('ns/NAME')`, in-module dispatch/commit and Pinia `useXStore()` / `store.action()` calls now link to the member in the right store module, by namespace or store import, never to a same-named function elsewhere (M3-05).
- Vue SFCs now get a component symbol, template event handlers and binding calls become call edges, and component tags (registered locally, with `Vue.component` / `app.component`, or by `require.context` / `import.meta.glob` auto-registration) become render edges to the child component (M3-02).
- Vue Options API `this.x()` calls now resolve to the component's own member, then to a mixin listed in its `mixins` array, and no longer to an unrelated file that merely defines the same name (M3-03).
- `.fish` files now get function symbols, call edges and `source` imports from a bundled tree-sitter fish grammar (M0-12-R5).
- **Laravel route mount graph**: routes are now resolved through what actually loads each file: (M1-03, M1-04)
  - `bootstrap/app.php` `withRouting(...)`, `RouteServiceProvider`, or the `routes/web.php` / `routes/api.php` defaults;
  - service-provider mounts (`Route::prefix(..)->group(<path>)` and `$this->loadRoutesFrom(..)` inside prefixed groups);
  - `require`/`include` inside route groups.

  Routes inherit the enclosing prefix, middleware, namespace and controller, and a file mounted twice yields both sets of routes.
- **Route liveness flags**: (M1-07)
  - routes in files nothing loads are reported `reachable: false`;
  - mounts inside `if`/`else` are `conditional: true`;
  - when the same method and URI is registered twice, earlier registrations are `overridden: true`, with `overriddenBy` pointing at the winner, matching Laravel's last-registration-wins rule.
- **Route line numbers and names**: every route carries its declaration `line` and its `name` (`->name()` or `'as'`). `mapx routes --json` and `mapx_routes` now always include `line`, `name`, `middlewares`, `reachable`, `overridden` and `conditional`, and route edges keep the same metadata. (M1-09)
- **Laravel route fixture and scorer**: `tests/fixtures/laravel-routes` (41 labelled routes) and `scripts/eval/score-routes.ts`, which report per-pattern recall and precision. (M1-01)
- `frameworks.json` is now honoured as an override: frameworks listed there stay active even when detection misses them. (M1-08)

- **Frontend → backend HTTP pairing**: MapX now finds HTTP call sites in JS, TS and Vue files (axios, `fetch`, `axios.create` instances, factories such as `Api()`, aliases, and receivers configured in `settings.http.clients`), resolves their URLs (string constants, template literals, conditional branches, base URLs from `axios.create` options and `.env` files with axios joining rules), and pairs each call with the live backend route it reaches across repositories. Paired calls become `http` edges to the route handler. `mapx routes --clients [--unmatched]` and `mapx_routes { clients }` list calls and the calls that reach no route. (M2-03, M2-04, M2-05, M2-06)
- **HTTP pairing fixture and scorer**: `tests/fixtures/vue-http` (32 labelled calls in Vue 2.7 and Vue 3 apps) and `scripts/eval/score-http.ts`. (M2-02)
- **Vue SFC edge fixture and scorer**: `tests/fixtures/vue-sfc` (Vue 2.7 and Vue 3 apps, 100 labelled edges, 11 component symbols and 16 negatives over 15 patterns) and `scripts/eval/score-edges.ts`, a generic per-pattern edge recall/precision scorer. The edge contract for M3-02 … M3-06 is in `docs/baton/iterations/M3-01.md`. (M3-01)

- **Agent templates**: `CLAUDE.md` documents the SSE stanza next to the stdio one; Continue gets `slashCommands`; Aider gets `.aider.conf.yml` (`read: AIDER.md`) and `--read` instructions; generating Zed's instructions also registers the mapx MCP server in `.zed/settings.json` (also via `agents mcp`/`init`), keeping existing keys. (M0-09-R2)

- **Laravel structure surface**: `mapx query <Model>` lists the model's relationships (method, relationship call, target, type); a route's `->middleware('auth')` becomes a `middleware` edge from the route file to the middleware class (one per route file and middleware, with the guarded routes); the LLM export gains a `## Models` section and groups routes by controller class (one line per controller instead of one per action); `mapx deps <ServiceProvider>` shows its bindings as abstract → concrete. (M0-05-R2)
- **Metrics and edges**: `mapx metrics --format json --top N` (and `mapx_metrics { format, top }`) ranks files by total degree with their PageRank; `mapx edges <file> --direction outgoing|incoming --type a,b --verified-only --format json` lists one file's edges (relative or absolute path); `mapx_edges` returns JSON by default and takes `file`, `direction`, `verifiedOnly`; `mapx status --help` points to `mapx metrics`, and the agents stub lists all 32 MCP tools. (M0-03-R2)
- **Workspace surface (F18)**: `mapx workspaces` prints the Name/Path/Type/Files/Last scanned/HEAD table, including uninitialised submodules; `status --all` gives the per-repo table and cross-repo edge counts; `export --all` gives a combined LLM export with one section per repo; `deps --cross-repo` lists edges into and from other repos; `init` reports submodules and VS Code workspace repos (registers them on a TTY; `--no-workspaces` skips the step); `mapx_workspaces` returns each repo's real type (`submodule`, `vscode-workspace`, …), its HEAD, and a top-level `crossRepoEdgeCount`. Peer repos are now opt-in (`--include-peers`, `includePeers`), and `workspaces sync` no longer registers sibling directories by default. (M0-10-R1)
- `mapx export --format dot --cluster auto --depth 0` renders the cluster-level view: cluster nodes with file counts and cluster-to-cluster edges labelled with their count and types, with `penwidth` scaled by count. (M0-08-R1)

### Fixed
- Vue Router navigation also reads a `push` destructured from `useRouter()`, `router.push` in a `<script setup>` template, guard redirects (`next(target)` and a returned location), Pinia's `this.router.push`, route modules exported as `export default [ … ]`, and `<script setup generic="…">` blocks; each navigation links only to the component of the route record it names exactly (M3-11-R1).
- `mapx sync` drops the callers' edges to a function renamed or removed in a changed file, and re-resolves the files a changed `package.json`, tsconfig/jsconfig or bundler config governs, as `scan --force` does; `mapx status` reports an edit to a gitignored indexed file (M0-02-R8).
- Laravel routes load as PHP loads them: a file `require_once`'d twice is mounted once and a require cycle reports each route once; `'/'` under a prefix is the prefix itself; an unevaluable resource name gets `{dynamic}` wildcards; `Route::match` verbs are evaluated; single-action controllers get `__invoke`; partly dynamic URIs are flagged dynamic, unevaluable name prefixes are kept as `{dynamic}`, and RouteServiceProvider `.=`, `??=`, `$this->prop =` assignments and closure scope follow PHP (M1-03-R2).
- Python absolute imports never resolve to a sibling module from inside a regular package, also from a namespace sub-folder of one, and sync follows an `__init__.py` added or removed; the workspace root stays a search root even with a stray `__init__.py` (M0-12-R9).
- A `package.json` or `composer.json` in a sub-folder activates its framework detector for that folder only, also when your filters index manifest files (M3-07-R1).
- Vue templates no longer link `v-for` aliases and slot props (`v-slot`, `#slot`, `slot-scope`) to same-named component methods, skip `v-pre` subtrees, and ignore a `<template>` shown inside a custom block such as `<docs>`; `this.x()` inside a callback `function () {}` in an Options API method no longer links a same-named function in another file (M3-02-R1).
- Calls reach callables bound from a factory call or another name (`export const useAppSelector = useSelector`, `createAsyncThunk(…)`, `functools.partial(…)`), and a call on a parameter or local variable no longer links to a module function of the same name; Go `struct { log.Logger }` links only to a type in the imported project package; C++ out-of-line definitions at any qualifier depth and qualified destructors are methods; block-scoped arrows are no longer top-level functions, and `export const Klass = class {}` is a class (M0-17-R5).
- Laravel route middleware given as `X::class.':param'`, as several arguments to `->middleware()`, through a group `use A\{B, C as D}`, or in a controller constructor as a class constant is named with its class (and parameters); a bare name that is no Kernel alias or group no longer links by short class name, `Route::resource(…)->middleware()` reads one argument as Laravel does, and each Laravel app in a repo uses only its own HTTP Kernel's aliases, groups and middleware classes (M0-04-R6).
- NestJS routes keep their path with a trailing comma in multi-line decorators, generic handlers (`list<T>()`) are named after themselves, and a regex literal right after an `if`/`while`/`for` condition no longer swallows the next class (M0-20-R3).
- HTTP pairing honours Laravel `Route::domain()`: a call to an absolute URL pairs only with routes whose domain serves its host (`{param}` segments match one label) (M2-06-R2).
- Import edges follow each language: `import json` inside a Python package is the standard library, not a sibling `json.py`; a comment inside a parenthesised `from … import (…)` no longer drops the next name; `src/bin/*.rs` is a Rust crate root; a quoted module path in `go.mod` is read (M0-12-R7).
- `mapx agents` no longer deletes an edited hashless Continue block written by 0.3.x or earlier without confirmation or `--force`, and leaves an MCP config (JSON or JSONC) that already holds the identical mapx entry untouched, comments included (M0-09-R5).
- Vuex map helpers with namespaced paths (`mapGetters(['users/activeCount'])`, `mapActions({ load: 'users/FETCH' })`), `createNamespacedHelpers` and module members held in imported objects link to the exact module member; Pinia actions destructured from a store in a JS/TS module and setup stores with any hook name resolve in the store's own file (M3-05-R1).
- `impact` lists files that import a default export under another name; `deps` and `mapx_dependencies` accept backslash, `./` and absolute paths as `edges` does; `mapx status` lists only the git changes a scan would index (M0-11-R3).
- A client's `baseURL` constant is looked up in the scope where the client is created (a function-local `BASE` wins over a top-level one), and nested dotenv defaults (`${A:-${B:-/deep}}`) expand as Vite's `loadEnv` does (M2-04-R3).
- Calls on objects imported from npm packages (`axios.create()`, `_.get()`) and global functions (`fetch()`, timers) no longer link to project functions of the same name, unless the file imports or declares that name (M0-17-R4).
- `.svelte` files give the functions, classes, constants and `export let` props of their `<script>` blocks (`context="module"` too), and their imports, calls and instantiations link as in a `.ts` file, including through tsconfig aliases such as SvelteKit's `$lib`, with the built-in globals check; before, a `.svelte` file gave only its component, while the docs claimed more (D016) (M0-12-R8).
- `mapx sync` in a git repository restores a file's symbols and edges after an edit is reverted to the committed content (`git checkout -- f`, or `git reset` then `git checkout`); the edited content no longer stays indexed with `mapx status` reporting the file stale (M0-02-R6).
- `mapx sync` gives the index `mapx scan --force` gives when a registered folder repo sits inside the primary checkout (also registered through a symlink), when a class is re-added elsewhere after an unrelated file declared one of its method names, when `git mv` leaves a copy behind, and for gitignored files, which sync now indexes as scan does (M0-02-R7).
- A name declared in several files resolves to the declaring file nearest the caller, then the first by path, instead of whichever was indexed first, so `scan` and `sync` give the same edges (M0-02-R7).
- `export --exclude` (CLI and the `mapx_export` MCP tool) leaves out a whole folder for a folder pattern such as `**/Http`, as `scan` does (M0-02-R7).
- Multi-repo workspaces: the first `scan --all` gives the same cross-repo edges whatever the repo order; cross-repo edges come back after their target file is deleted and restored, or after `workspaces remove` and `workspaces add` of a repo, without `--force`; and the dashboard server also collapses duplicate repo entries and drops their data (M0-10-R4).
- Vue apps in one repo stay apart whatever the root `package.json` lists: each folder holding a `package.json` has its own global component registry and Vue Router route table, a folder where vue-router is not active is never a navigation target, and of two registrations of one name the first by path wins after any scan or sync history (M3-08-R1).
- JS/TS/Vue path aliases no longer cross an app's boundary: a nested app with its own `package.json` (such as a Vue CLI `frontend/` in a Laravel repo) resolves `@/` through its own configuration or its own `src/`, not the parent's `vite.config.js`, for import, render, route, navigate and HTTP-client edges; chained `alias.set(…).set(…)` and backslash path segments in bundler configs are read (M3-09-R1).
- Laravel RouteServiceProvider mounts are walked like other providers' mounts: glob loops, `require`, `loadRoutesFrom` and `->group($var)` make their routes reachable, mounts that cannot be evaluated give reachability unknown instead of unreachable, and the provider's prefixes (`config()` → `{dynamic}`, `"admin/{$this->version}"` from class properties), `name()` and `domain()` apply to the mounted routes (M1-07-R2).
- `scan` and `sync` now re-link Vue render and navigate edges when a global component registration (`app.component`, `Vue.component` or an auto-registered folder) or a Vue Router route record changes, without re-parsing unrelated components, and each app folder with its own `package.json` keeps its own global registry (M3-08).
- The Laravel Console Kernel (and any `Kernel.php` other than `app/Http/Kernel.php`) no longer gets verified `middleware` edges to every HTTP middleware (M0-05-R3).
- Vue Router lazy route components written with a webpack magic comment (`() => import(/* webpackChunkName: "about" */ '../views/AboutView.vue')`, the `vue create` default) resolve, so their route and navigate edges exist (M3-06).
- `mapx sync` in a git repo no longer indexes dot-named files, `DEFAULT_IGNORE` folders (`coverage/`, …) or files under directories pruned by an exclude pattern, which `scan` never indexes (M0-02-R2).
- PHP: when two Laravel apps in one repo declare the same classes or functions, `new X()`, function calls and route handlers resolve to the declaration nearest the caller instead of the first app's (M0-04-R2, M0-04-R5).
- Laravel `Route::any` URIs are evaluated like other verbs: unknown variables and constants become `{dynamic}`, never raw PHP text (M1-03-R1).
- The HTTP pass and Vue Router route components follow imports through the same alias resolution as the rest of the graph (tsconfig/jsconfig `paths`, vite / webpack aliases), so an axios client imported through Laravel's `@` → `resources/js` keeps its base URL (M3-12).
- Symbol resolution is now case-sensitive except where the language is not (PHP class, function and method names; Pascal), so `Cart` no longer links to a `cart` function or constant and global calls like `fetch()` no longer link to a Vuex `FETCH` mutation (M3-10).
- PHP calls to plain and namespaced functions now link to the file that declares the function, and `require` / `include` statements (with or without parentheses, including `__DIR__ . '/…'`) link to the included file (M0-04-R5).
- A `package.json` or `composer.json` in a sub-folder now turns on Vue Router, NestJS, Next.js, React Router, TanStack Router, SvelteKit, Symfony or Yii detection for the files in that folder only, so a frontend sub-app is detected without affecting a backend beside it (M3-07).
- `mapx lang list` and `mapx_lang_list` now report a language whose grammar file is missing as missing, and generated agent files state the language count from the registry (23) (M0-12-R6).
- Laravel routes now honour `withoutMiddleware`/`withoutMiddlewareFor` (routes, groups, resources, the `excluded_middleware` keys), report `{post:slug}` as `{post}` with its binding field, and keep only the last of a repeated chained `middleware`/`prefix`/`namespace` attribute, as Laravel's router does (M1-05-R3).
- Laravel route middleware given as class constants (`->middleware(EnsureAdmin::class)`, `Route::middleware([X::class])->group(...)`) is now named through the route file's `use` statements and linked to the middleware class (M0-04-R3).
- PHP `use` imports and namespaced class references now resolve only to the class declared in that namespace, so stock Laravel apps no longer get self-imports or `Illuminate\…` names linked to app files, and `$listen` is read from the syntax tree (M0-04-R2).
- `sync` now drops deleted files that were indexed while untracked or only staged, and records blob ids for the files it re-indexes, so committing an already synced edit no longer re-parses it (M0-02-R5).
- `scan` and `sync` now re-link the referrers of a class moved to another file without `--force`, store git blob hashes for repos that are not at the workspace root, and skip files git lists whose content is unchanged (M0-02-R4).
- `mapx_workspaces` now returns F18's absolute `path`, `relativePath`, `isRegistered` and `isInitialised` (and lists uninitialised submodules), duplicate repo entries already in a config are collapsed with a message, and `scan --all` / `update --all` after `workspaces add` resolve the new repo's references into the primary repo without `--force` (M0-10-R3).
- `sync` now drops the old path of a git rename and re-links its referrers, picks up changes in a repo nested inside a larger git checkout, treats a symlink to a registered repo as that repo, and small scans and syncs no longer recompile tree-sitter queries for every file (M0-02-R3).
- Laravel `Route::singleton`/`apiSingleton` (with `creatable`/`destroyable` and the plural forms), `->scoped()` binding fields, `->middlewareFor()` and route-level `prefix`/`domain` keys now match Laravel's router, including its placement of a route's own prefix before the group prefix (M1-05-R2).
- `mapx edges <file>` / `mapx_edges` now list edges from every repo of a workspace (incoming rows carry `sourceRepo`) and report a path that is not indexed instead of "No edges", and `mapx_dependencies` accepts globs and partial names like `mapx deps` (M0-03-R4).
- Java and TypeScript generic bases (`extends Base<T>`, `implements Run<T>`) are extracted, `export let`/`export var` and TypeScript top-level bindings are symbols, arrows declared inside functions are no longer top-level functions, and C# base lists use the indexed target's kind to choose extends or implements (M0-17-R3).
- Cyclic-dependency smells now list their files in cycle order, each once, and JSON/JSONC files with `key:`-like text inside strings keep their `$ref`/`extends` links when parsed in worker threads (M0-32-R2).
- Import edges are more precise: Ruby `require_relative` vs `require`, the right Java module in multi-module builds, Python aliased and multi-name imports, C# `using static`/aliases/nested namespaces, Rust `mod foo;` and uniform paths, and Go nested modules; import edges now name the imported module in `target_symbol` (M0-12-R4).
- Laravel resource routes now honour options arrays (`only`, `except`, `parameters`, `names`, `as`, `middleware`, `shallow`), nested `photos.comments` and shallow resources, `Route::resources([...])`/`apiResources([...])`, carry Laravel's route names, and group name prefixes and action arrays without `uses` keep route names and middleware (M1-05-R1).
- Calls no longer link to JS/Python constants or variables, or from built-in objects (`Math.max()`) to user functions. C++ out-of-line methods with template or nested qualifiers, C# exception and generic base classes, and Go qualified embedded structs are extracted correctly, and DOT dashes a file pair only when none of its edges is verified (M0-17-R2).
- `mapx scan` no longer crashes with a stack overflow on large cyclic dependency graphs; cycles are found with an iterative Tarjan and reported as before (M0-32-R1).
- The workspace table, `status --all` and `mapx_workspaces` now show no HEAD and the type `folder` for a registered directory without its own checkout, mark never-scanned repos `unscanned`, and no longer register a symlink to a registered repo twice. `export --all` nests each repo's sections, `workspaces sync` without a TTY still registers its discoveries, and MCP gains `root`, `headSha`, `mapx_export {all}` and `mapx_dependencies {crossRepo}` (M0-10-R2).
- `sync` and `scan` now restore the edges into a file that was deleted and comes back (a branch switch, a restored file), `sync` applies config filter changes, filtered JSON exports drop excluded files' clusters and memberships, `./` and Windows-style patterns work, and `laravelDefaultExcludes` can list the Laravel defaults to keep (M0-02-R2).
- HTTP pairing now needs literal path evidence, ignores calls to third-party hosts (own hosts come from `.env` files or `settings.http.hosts`), reads `fetch` methods only from the top level of the options, and no longer skips source directories named `public/` or `build/`. Also fixed: JSX closing tags hid calls on the same line (M2-06-R1).
- Import resolution no longer slows down with repository size (Java/Kotlin/Scala, Go and PHP imports use an index built once per scan), shebang scripts get call edges, `Rakefile`/`Gemfile` index as Ruby and `.fish` files are indexed, and `mapx_lang_info` matches `mapx lang info` (M0-12-R3).
- `mapx_query` now lists an Eloquent model's relationships and `mapx_dependencies` lists a provider's abstract → concrete bindings, matching the CLI (M0-05-R4).
- The "graph may be stale" warning now applies the scanner's own file rules, so files a scan never indexes (outside `includePatterns`, Laravel default excludes, dotfiles, `node_modules`/`coverage`) no longer keep it on; `impact` lists import-only dependants only when they import the symbol, and `callees` shows the called method's own line (or none) instead of a same-named method's or the call site's (M0-11-R2).
- `mapx metrics` graph density now counts distinct file pairs, so it stays between 0 and 1 instead of exceeding 1 when files share several edges (M0-03-R3).
- Laravel routes behind mounts MapX cannot evaluate are now reported with unknown reachability instead of unreachable (and still pair with HTTP calls), `module_path()`, `withRouting(then:)`, glob-loop and `DIRECTORY_SEPARATOR` mounts are followed, overridden routes and their winners both appear in `routes.json`, and attribute routes carry their line (M1-07-R1).
- Framework hook edges declared by their detector (such as Laravel Kernel middleware aliases) are now stored as verified, so `metrics --verified-only` keeps them (M0-05-R3).
- Agent integration files now stay single-block and "current" on CRLF checkouts, end with a newline, are never created by `agents update`, keep edited legacy or duplicate blocks behind consent, no longer duplicate Aider's `read:` key, and JSONC settings merges keep string values and warn when comments are dropped (M0-09-R3)
- Frontend HTTP URLs now resolve function-local constants in their own scope, and `.env` values are read like Vite: quotes before a trailing `# comment`, and `${VAR}` expansion (M2-04-R2).
- Laravel route extraction no longer reads routes, braces or `require` from strings and comments, scopes arrow-function and legacy path groups correctly, evaluates interpolated URIs and variable prefixes (or flags them dynamic), and ignores commented-out or uncalled RouteServiceProvider mounts (M1-03-R1).
- NestJS route and hook detection no longer loses or misattributes routes when comments or strings contain `class`, quotes or braces, or when classes use generics; GraphQL operation names ignore `name:` inside description strings (M0-20-R2)
- `mapx init`, `mapx agents update` and the `mapx_agents_generate` MCP tool no longer replace a user-written `AGENTS.md`/`CLAUDE.md` that has no mapx block, or an edited block: without a TTY they skip the file (MCP: pass `force: true` to overwrite). `mapx_agents_generate` accepts `providers: ["all"]`. (M0-09-R1)
- `--exclude '**/_*'` no longer drops every file in a subdirectory, and directory patterns such as `**/generated` and `packages/*/generated` exclude again; `app/Http/*` still keeps `app/Http/Controllers`. (M0-02-R1)
- PHP class names given as strings (`belongsTo('App\Models\Team')`, `bind('App\Contracts\X', ...)`) are no longer prefixed with the file's namespace. (M0-04-R1)
- `mapx callees` prints the declaration line of PHP namespaced callees instead of the call-site line. (M0-11-R1)
- `mapx sync` indexes new and changed extensionless scripts by their shebang, like a full scan. (M0-12-R2)
- `http` edges are removed when the last frontend HTTP call disappears. (M2-07)
- Laravel resource parameters for words ending in `-ses`/`-zes` (`courses` → `{course}`, `sizes` → `{size}`) follow `Str::singular`. (M1-05)
- Routes of two separate Laravel apps in one workspace no longer mark each other overridden. (M1-07)
- The HTTP fixture's `.env` files are committed, so the test suite passes on a clean clone. (M2-02)
- Language extraction accuracy: (M0-17-R1)
  - Ruby `class Foo < Base` extends `Base` (not `< Base`), `include M` is recorded as implements, and `include`/`extend` are no longer call edges;
  - C++ methods defined inside a class or as `Foo::run` are methods of `Foo`, and template functions are named by their identifier (not their whole source);
  - C# base lists separate the base class (extends) from interfaces (implements);
  - Dart calls produce call references;
  - Python `Bar()` is an instantiation, `@property` methods are properties, and module-level variables are symbols;
  - Go interface and struct embedding are extends edges;
  - Kotlin interfaces and enum classes have kinds `interface` and `enum`;
  - JavaScript top-level `const`/`let`/`var` bindings and class fields are symbols (new kind `variable`);
  - Rust impl blocks no longer duplicate their struct;
  - Swift initialisers are named `init`;
  - Scala imports target clean paths (`a.b.{C, D}` gives `a.b.C` and `a.b.D`).
- `.code-workspace` and `rush.json` files with comments or trailing commas are read (before, the workspace folders were silently ignored). (M0-10-R1)
- Clusters and trace: Leiden no longer merges two dense groups joined by a single edge (aggregation dropped each community's internal weight) and gives the same communities on every run; PHP apps no longer show empty `app.*` directory clusters; `mapx trace <Class>` follows the class's members instead of returning 0 edges, and trace edge counts are per symbol; the fallback SVG styles dispatch (bold magenta) and notify (dotted pink) edges. Fresh parallel scans (> 10 files) now keep each file's PHP namespace, so namespace clusters appear without a second scan. (M0-08-R1)
- MCP config merging accepts JSONC (comments, trailing commas) and no longer overwrites a config file it cannot parse; it warns and leaves the file alone. (M0-09-R2)
- Agent files: `agents generate --providers=all` works; Cursor and Windsurf rules keep their frontmatter first; `agents update` never overwrites a hand-edited mapx block without `--force`, even when the block is also outdated (sentinels now carry a content hash); `agents list` shows each file's status (missing, current, outdated, edited). (M0-09-R1)
- JS/TS calls on untyped receivers (`obj.method()`) are captured as inferred call edges (built-in methods such as `map` or `push` are skipped), and DOT export dashes only inferred edges, so verified bindings and dispatches are no longer drawn as if guessed. (M0-01-R1)
- Methods of an anonymous `export default class { … }` are scoped to the class name derived from the file. (M0-18-R1)
- Filters: removing an `--exclude` restores the edges into the re-included files (a filter change re-parses once); `--exclude "dir/*"` no longer drops subdirectories; filtered exports no longer list clusters of excluded files; Laravel's default excludes apply at scan time to `framework: laravel` repos unless declined at init. (M0-02-R1)
- NestJS: decorators no longer leak into the following class (no phantom routes or guards), GraphQL `@Query(() => T, { name })` and `@Mutation` operations are named correctly with their operation type on the edge, and interface hooks no longer create file-to-itself edges. (M0-20-R1)
- `mapx impact` no longer lowers a direct caller to LOW because its body (or a comment) contains `try`, and lists files that only import the symbol as LOW. `callees` prints each callee's own declaration line. Staleness warnings ignore files rewritten with identical content and now report new untracked files, which `mapx sync` indexes. The JS globals filter covers `.mjs/.cjs/.mts/.cts/.svelte`. (M0-11-R1)
- PHP: `use` statements become import edges (PSR-4 paths); names resolve relative to the file's namespace (so `Role::class` no longer jumps to another namespace's `Role`); imported classes named like facades (`App\Support\Cache`, `App\Models\Event`) are no longer rewritten to Laravel facades; app classes named `Request`/`Response` produce type edges; qualified names in `extends`, `implements`, `new` and static calls are captured. (M0-04-R1)
- Import edges are now resolved for Java, Kotlin, Scala (package paths), Rust (`crate::`/`self::`/`super::`), Go (module paths from `go.mod`), Python (absolute, relative, packages, submodules), Ruby (`require`/`require_relative`) and C# (`using` → the file declaring the namespace; `using` was not captured at all before). (M0-12-R1)
- Languages: every grammar is bundled, so `mapx lang list` reports all of them (including tsx) as bundled, and `lang install/uninstall` explain that instead of copying files nothing used. New `mapx lang info <lang>`. Extensionless scripts are recognised by their shebang line (bash, python, node, ruby, php, lua, elixir), and `.pyw`, `.rake`, `.gemspec`, `.zsh`, `.luau`, `.dpr`, `.lpr`, `.h++` and `.c++` are recognised. (M0-12-R2)
- Generated MCP configs run `npx -y @mgamil/mapx` (the unscoped `mapx` package is not MapX and returned 404). The `build:*` scripts embed the version and no longer use Bun `--bytecode`, which produced binaries that crashed at startup. Publishing setup (`NPM_TOKEN`) is documented. (M0-07-R1)
- Parallel scans (the default above 10 files) now parse with the same language parsers as sequential scans, so PHP facades, dispatch/notify edges and Laravel roles no longer disappear on real Laravel apps. Worker threads also start when MapX runs from source (they used to fall back to one thread silently), and a fallback is now reported. `Event::dispatch(new X)` targets X, and `$listen` arrays produce listener bindings. (M0-06-R1)
- Stored edges now keep the parser's metadata (Eloquent relationship type and method, binding type and phase, concrete class, facade alias). Laravel routes declared with `Class::class` handlers are stored as verified, so `metrics --verified-only` keeps them; resource routes keep `resourceType`. (M0-05-R1)
- Laravel routes declared with array handlers (`['uses' => 'C@m', 'as' => ..., 'middleware' => ...]`) now resolve their handler; handler symbols are fully qualified using the group namespace. (M1-02)
- Resource route parameters follow Laravel (`blog-categories` → `{blog_category}`, `statuses` → `{status}`, `people` → `{person}`); `->parameters()`, `->only()` and `->except()` are honoured. (M1-05)
- Route paths built from local string variables (`$base.'/x'`) resolve; unresolvable dynamic paths are flagged `dynamic` instead of leaking PHP source. (M1-06)
- `Route::prefix(..)->group(<path>)` inside a route file no longer leaks its prefix onto later routes. (M1-04)
- Laravel is detected when the app sits below the scanned folder, and when `artisan`/`composer.json` are not in the indexed file list. (M1-08)
- A long-running MCP server no longer keeps stale Laravel route context between scans. (M1-07)
- A registered repository nested inside another registered repository (for example `.` plus `backend/` and `frontend/`) is no longer indexed twice; the scan summary now reports the stored symbol and edge counts. (M0-23)
- Git's `fatal: ...` messages no longer leak into scan output for repositories without commits. (M0-23)
- TOON export with `--delimiter tab` or `pipe` now declares the delimiter in array headers as the TOON spec requires, so the output decodes. (M0-14-R1)
- `mapx_search` with `term: "*"` and a file filter returns every symbol in the file (previously capped at 20), and reports `Found N of M` with the real total whenever results are truncated. (M0-22-R1)
- The npm package no longer ships the 7.8 MB dashboard source map (`MAPX_UI_SOURCEMAP=1` keeps it for local builds). (M0-15-R1)
- Name-only symbol resolution no longer crosses languages: a PHP route whose controller is not indexed no longer links to a JavaScript class of the same name, and resolution without a known source language returns nothing instead of any match. (M2-01)
- HTTP call extraction handles nested ternaries and templates, parenthesised URLs, multi-declarator constants, async or block-bodied client factories, re-exports and `import * as axios`; skips built bundles (`public/`, `dist/`, `*.min.js`); is linear on huge files; and refreshes after `.env` or `settings.http` edits alone. Ties between equally good routes no longer depend on scan order. (M2-07)
- `mapx search "*" --file <path>` lists every symbol in the file (previously 20), and reports `Found N of M` with the real total when results are truncated; JSON output includes `totalMatches`. (M0-22-R2)
- `mapx node --include-members` now exists, as documented, and lists the member symbols of a class, interface or trait (text and JSON). (M0-36)
- The codebase profiler uses the configured `graphExcludePatterns` instead of fixed scratch/test rules. (M0-38)

### Notes
- Completion disputed by the 2026-10-31 review (`docs/baton/reviews/REVIEW-2026-10-31-fb75474ba377.md`): M1-06 and M1-09 (an acceptance criterion is unmet) and M0-12-R2 (F20 extensions); defects in M1-03, M1-04, M0-20-R1, M2-04, M2-06, M0-12-R1 and M0-03-R2. Remediation is planned as M0-20-R2, M0-11-R2, M0-02-R2, M0-04-R2, M0-09-R3, M0-12-R3, M1-03-R1, M1-07-R1, M2-04-R2 and M2-06-R1 (P1), plus M0-10-R2, M0-12-R4, M0-17-R2, M0-03-R3, M0-05-R4, M0-07-R2 and M1-05-R1 (P2). (M0-41)
- Completion disputed by the 2026-10-31 review of `3ac0d6d..2db08bd` (`docs/baton/reviews/REVIEW-2026-10-31-2db08bd25e13.md`): M3-08, M1-03-R1, M1-07-R1, M0-04-R3 and M0-02-R2 (an acceptance criterion is unmet); P1 defects in M3-06, M3-09, M3-11, M3-12, M0-02-R3, M0-02-R4 and M0-10-R3. Remediation is planned as M3-08-R1, M3-09-R1, M0-02-R6, M0-02-R7, M0-10-R4, M1-07-R2 and M0-04-R6 (P1), plus M3-02-R1, M3-05-R1, M3-11-R1, M3-07-R1, M0-12-R7, M0-17-R5, M0-20-R3, M2-06-R2, M2-04-R3, M0-09-R5, M1-03-R2 and M0-11-R3 (P2).

## [0.3.5] — 2026-06-01

### Changed
- Nothig, just a version bump to make NPM happy

## [0.3.4] — 2026-06-01

### Added
- **`graphExcludePatterns` configuration**: New setting to exclude test/scratch files from PageRank rankings, framework detection, and archetype scoring while keeping them indexed and queryable. Default patterns: `scratch/**`, `benchmarks/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*`.
- **Prepared Statement Caching**: Introduced a statement caching layer (`stmtCache`) in both `better-sqlite3` (NodeStore) and `bun:sqlite` (BunStore) drivers, reducing SQL statement compilation overhead during post-scanning loops.
- **SQLite-backed PageRank Column**: Added schema migration version 9 to introduce the `pagerank` column to the `files` table, allowing PageRank values to be persisted directly inside SQLite.
- **Intra-class call tracking**: `this.method()` calls within TypeScript and JavaScript classes are now tracked as call edges in the dependency graph, enabling accurate callers/callees tracing for internal class method references.
- **`include_members` option for `mapx_node`**: New boolean parameter for the `mapx_node` MCP tool (and `--include-members` CLI flag) to list class, interface, or trait member symbols (methods, properties) alongside the inspected symbol's metadata.
- **`include_leaf_libraries` option for `mapx_sinks` and `trace`**: New boolean parameter for the `mapx_sinks` MCP tool (and `--include-leaf-libraries` CLI flag for both `sinks` and `trace --sinks` commands) to include high-import leaf-library files that are normally filtered out as stable foundations.
- **Content-hash based incremental scanning**: Non-git projects can now use `mapx sync` for incremental updates. File changes are detected via content hashing (SHA-256) instead of requiring a Git working tree.
- **Pre-scan symbol index**: Built a pre-scan O(1) symbol lookup index to accelerate reference resolution during scanning, replacing repeated linear searches.
- **Parser pooling**: WASM `Parser` instances are now pooled and reused per language, eliminating redundant parser creation and WASM instantiation overhead during scans.
- **Hub/orchestrator classification signal**: Files with high fan-in combined with high fan-out are now classified with a hub/orchestrator signal in the role classifier, improving architectural layer accuracy.
- **Worker thread parallel parsing**: Spawns multiple worker threads via `node:worker_threads` to parse files concurrently, yielding a 3-5x CPU performance speedup for large codebases. Includes a `--no-parallel` CLI flag and `parallel: false` option (both CLI and MCP) to run sequentially on the main thread.
- **Centralized asset root path resolution**: Added a centralized, unified compatibility helper to resolve WASM assets safely across both Node.js and Bun runtimes.
- **Contextual error messages for routes/hooks**: `mapx routes` and `mapx hooks` (CLI and MCP) now return descriptive, context-aware error messages when no routes or hooks are found, including suggestions for supported frameworks and troubleshooting steps.

### Changed
- **Files-only PageRank Calculation**: PageRank is now calculated on a lightweight files-only dependency graph during post-scan analysis, reducing PageRank computation time to under 50ms and writing updates in a single database transaction.
- **Lightweight Graph Context Loading**: Initializing the workspace graph in CLI context loading, MCP tools, and Web Dashboard API endpoints now completely skips loading symbols into the in-memory graph.
- **Database-driven CLI/MCP Search & Query Rankings**: CLI search, MCP search, and LLM/Toon exporters now retrieve symbol importance scores using a fast SQLite JOIN between `symbols` and `files` tables.
- **Instant UI Graph Loading**: The visual graph `/api/graph` endpoint, `/api/metrics`, and `/api/context` endpoints bypass graphology initialization entirely. Additionally, `/api/graph` aggregates and deduplicates edges directly in SQLite via native grouping, reducing JSON payload generation and processing time by over 95% (from ~70,000 symbol-level edges to ~3,000 file-level edges for large repositories).
- Community clusters now use directory-prefix labels (e.g., `src/core (12 files)`) instead of generic `community_N` names, making cluster names immediately meaningful.
- Scan/sync output now shows total file count alongside changed file count (e.g., `Scanned 42 changed files (1,203 total)`).
- Search JSON format includes `totalMatches` and `offset` fields for pagination awareness.
- Leaf-library files (those with ≥3 structural importers) are filtered from sinks output by default; use `include_leaf_libraries` to restore them.

### Fixed
- **Static files in parallel scans resolved**: Fixed a critical crash and missing dependencies issue where worker threads failed to parse static file types (Markdown, CSS, HTML, JSON, YAML) and bypassed user-defined languages. Workers now inline and execute the static parser natively, ensuring all dependency links are preserved in multi-threaded scans.
- **Visual graph ESM dynamic require resolved**: Fixed a critical runtime crash where dynamic `require` statements failed in ESM mode for payloads larger than 1MB, resolving `/api/graph` failing to load on large codebases. Statically imported all dynamic dependencies in `ui-server.ts` and `ui-events.ts` to ensure compatibility across Node.js and Bun runtimes.
- **C# / ASP.NET scanner hang resolved**: Fixed a severe database lockup and thread blocking issue when scanning large repositories (such as `n2cms` with ~3,100 files and ~40,000 references). The scanner now merges newly parsed symbols in memory and updates the `symbolIndex` before reference resolution starts, keeping reference resolution at O(1) in memory and eliminating synchronous SQLite queries.
- **Scanner post-scan and visual hang resolved**: Resolved a secondary hang where the CLI progress bar appeared stuck on the last file by:
  - Deferring clearing of `symbolIndex` until after `runPostScanAnalysis` completes to avoid falling back to synchronous database queries during route/hook resolution.
  - Adding a `Resolving references` phase (`resolve`) progress reporting to the CLI instead of remaining visually stuck at `Parsing files`.
  - Batching framework route/hook edge database insertions inside `scanFrameworkRoutesAndHooks` within a single SQLite transaction, reducing disk-sync overhead.
  - Supporting qualified dot-separated namespaces (e.g. `N2.Content.Page`) in `resolveSymbolToFile` using O(1) index lookups.
- Self-edge guard prevents files from depending on themselves in the graph, eliminating spurious self-referential edges.
- Trace cycles deduplicated on `(fromFile→toFile:cycleLength)` tuple to avoid reporting the same cycle multiple times at different entry points.
- Architecture smells deduplicated on `(type, involvedFiles)` to prevent redundant smell reports.
- Scratch/test files (matching `graphExcludePatterns`) excluded from framework detection and archetype scoring, preventing test fixtures from influencing project classification.
- Duplicate framework detection calls eliminated with caching, reducing scan time for multi-framework projects.
- Post-scan analysis pipeline extracted into a shared function, eliminating ~85 lines of duplicated code between full scan and incremental sync paths.

## [0.3.3] — 2026-05-31

### Added
- **Flexible Symbol Querying**: Support querying and searching for symbols using both double-colon `::` and dot `.` notations natively.
  - Handled multi-level scopes (e.g. `Namespace::Class::Method` or `Namespace.Class.Method`).
  - Added fallback normalized scope matching for mixed notation lookups in `getSymbolByName`, `getCallersOfSymbol`, `getCalleesOfSymbol`, and `resolveStart` in `FlowTracer`.
  - Added unit test cases covering dot and double-colon nested namespace formats.
- **Symbol Explorer Graph Navigation**: Added support in the Web Dashboard's Symbol Explorer details view to navigate directly to and focus the symbol's file node on the Cytoscape graph.
  - Rendered the file path in the Symbol Explorer details panel as an interactive `involved-file-badge` that automatically switches tabs, changes to focus layout mode, and centers on the file node.
- **Expanded Test Coverage**: Dramatically increased automated test coverage by adding integration tests for all supported languages and web frameworks.
  - Added `tests/parsers-integration.test.ts` to verify parsing, AST queries, symbol extraction, and reference extraction using real WASM binaries for all 23 supported languages.
  - Added `tests/framework-extractors.test.ts` to cover route and hook extraction across all 22 web frameworks, ensuring zero regressions in routing/hooks mappings.
- **Monorepo Framework Detection**: Enabled framework routing and hooks detection for applications inside monorepo subdirectories.
  - Implemented shared utility helpers `hasPackageJsonDependency` and `hasComposerDependency` in `src/frameworks/utils.ts` to inspect all project configuration files in the workspace (including those in nested subdirectories like `apps/backend/package.json`).
  - Refactored JS/TS detectors (`NestJSDetector`, `ExpressDetector`, `NextJSDetector`, `ReactRouterDetector`, `SvelteKitDetector`, `TanstackRouterDetector`, `VueRouterDetector`) to utilize the package dependency helper.
  - Refactored other detectors (`LaravelDetector`, `SymfonyDetector`, `YiiDetector`, `SpringDetector`, `RailsDetector`, `GoDetector`, `RustDetector`, `VaporDetector`, `WordPressDetector`) to check both project root and subdirectory configurations.
  - Added comprehensive test suite `tests/framework-detectors.test.ts` to verify detectors under both standard root and nested monorepo folder layouts.
- **Static YAML file support**: Registered `.yaml` and `.yml` as static tier languages and implemented path extraction in `StaticFileParser` to trace relative references between YAML files (establishing correlation only between each other). This also indexes files like `pubspec.yaml`, enabling the package mapper to resolve Dart package imports.
- **Flutter / Dart framework support**: Full first-class support for Flutter cross-platform mobile apps.
  - New `FlutterDetector` (`src/frameworks/detectors/flutter.ts`) — detects Flutter projects via `pubspec.yaml` (`sdk: flutter`) or the presence of `lib/main.dart`. Extracts routes from `Navigator.pushNamed`, `MaterialApp` routes map, `GoRouter` (`GoRoute(path: '...')`), and `auto_route` (`@RoutePage()`) annotations. Extracts widget lifecycle hooks (`initState`, `dispose`, `build`, `didChangeDependencies`, etc.) and state-management bindings for Provider/Riverpod (`context.watch`, `ref.watch`), BLoC (`BlocBuilder`, `BlocListener`, `BlocConsumer`), and GetX (`Obx`, `GetBuilder`).
  - **Expanded Dart symbol extraction** — `queries/dart/symbols.scm` now captures concrete functions (`function_declaration`), concrete methods (`method_declaration`), getters and setters (both concrete and abstract `*_signature` forms), factory and named constructors, `type_alias` / `function_type_alias` typedefs, `extension_type_declaration` (Dart 3.3+), enum member constants, and library declarations as namespaces.
  - **Improved Dart dependency resolution** — `queries/dart/references.scm` now captures `part` and `part of` directives, `function_invocation` (direct calls), named constructor invocations (`Foo.fromJson`), `mixin on` clauses, and generic type arguments (`Future<AuthResult>`). Removed the incorrect `function_expression_body` call rule.
  - **`package:` URI resolution in scanner** — `import 'package:my_app/src/auth.dart'` is now resolved to `lib/src/auth.dart` inside the project. `dart:` stdlib URIs are immediately short-circuited (no resolution attempt).
  - **Fixed Dart `nodeMappings`** — `method` now correctly maps to `method_declaration`, `function` to `function_declaration`. Added `property`, `namespace`, and `interface` entries.
  - **Flutter archetype detection** — `CodebaseProfiler` now recognises Flutter projects (`.dart` files under `lib/`) as `mobile-app`. `pubspec.yaml` is recognised as a package boundary for monorepo component detection.
  - **Flutter-aware role classification** — `RoleClassifier path signals for `blocs/`, `cubits/`, `providers/`, `notifiers/`, `repositories/`, `datasources/`, `routes/`, and `navigation/` directories. Naming signals for `*Bloc`, `*Cubit`, `*Notifier`, `*Screen`, `*Page` class suffixes. `main.dart` classified as `entry`.
  - **Enhanced Dart dependency resolution** — Comprehensive improvements to Dart import resolution in the scanner:
    - **pubspec.yaml-aware `package:` resolution** — Scanner now discovers `pubspec.yaml` files across the workspace, extracts the `name:` field, and builds a package-name → `lib/` path map. `package:` URI imports are resolved using this map first (enabling monorepo cross-package imports like `package:core_pkg/models/user.dart` → `packages/core/lib/models/user.dart`), then falls back to the previous `lib/` prepend for same-project imports.
    - **Dart-specific relative import fast-path** — Dart source files (`.dart`) now use a dedicated resolution path that resolves all non-scheme imports (including bare paths from `part` directives) relative to the source file's directory. This avoids trying JS/TS/Vue extension candidates (`.js`, `.ts`, `.tsx`, `/index.*`, etc.) that are meaningless for Dart files.
    - **Distinct `part`/`part of` tree-sitter captures** — `queries/dart/references.scm` now captures `part_directive` as `ref.target_part`/`ref.type_part` and `part_of_directive` as `ref.target_part_of`/`ref.type_part_of` (previously both used `ref.type_import`), enabling the scanner to distinguish part file relationships from regular imports.
    - **Dart/Flutter import signal for role classification** — `RoleClassifier.getImportsSignal` now recognises Flutter/Dart libraries: `flutter_bloc`/`bloc`/`riverpod`/`provider` → `state` role, `flutter/material`/`flutter/cupertino`/`flutter/widgets` → `components` role, `sqflite`/`hive`/`drift`/`isar` → `data` role.
    - **25 new tests** — Comprehensive `tests/dart-resolution.test.ts` covering: `dart:` stdlib skipping, `package:` URI resolution (basic and monorepo), `discoverDartPackages` (single and multi-pubspec), relative imports, bare-path part directives, and JS/TS non-regression.

### Changed
- **ASP.NET Route Extraction Improvements**: Upgraded `AspNetDetector` to support class-level `[Route]` back-scanning, resolving issues where multiple classes in a single file or complex class modifier layouts caused route associations to fail. Added support for C# `[action]` routing placeholder token replacements, and expanded route parameter constraint stripping to handle complex patterns like `{id:min(1)}` or `{id:int}`.
- **Picomatch Glob Migration**: Migrated remaining manual RegExp path/glob matching inside `resolveFilePaths` (`src/cli.ts`) and `resolveStart` (`src/core/flow-tracer.ts`) to use `picomatch` directly. Included dynamic `matchBase` configuration to correctly handle patterns with or without directory boundary slashes.
- **Test coverage improvements**: Increased statement/branch/function/line coverage across `src/cli.ts` and `src/mcp.ts`.
  - `cli.ts`: 70% → 74% statements, 58% → 62% branches, 57% → 62% functions.
  - `mcp.ts`: 71% → 77% statements, 56% → 62% branches, 55% → 69% functions.
  - New tests cover: `resolveFilePaths` glob/substring branches, fuzzy "Did you mean?" suggestions in `query`/`search`/`callers`/`callees`/`impact`/`node`, `trace` JSON/DOT/text with real paths (including cycle markers), `sources`/`sinks` route/queue/event/db/cache/mail annotations, `node --format json --source` error path, `profile` command with and without data, and staleness helper branches.
  - Fixed `vi.mock('../src/core/fuzzy-matcher.js')` to export `isGlobPattern` so `resolveFilePaths` glob detection works in the test environment.

### Fixed
- **CI Dependency Native Compilation**: Added `nan` override (`^2.22.0`) to root `package.json` to resolve native addon compilation errors for `tree-sitter-pascal` (and other tree-sitter packages using old `nan` bindings) under Node.js 20+ in CI workflows.
- **TypeScript Compilation & Declaration Emission**: Fixed `TS2339` error during `dts` emission by asserting type compatibility (`cand.scope as string` and `s.scope as string`) during scope filtering and matching.
- **WASM grammar ABI compatibility**: Rebuilt the compiled `tree-sitter-dart.wasm` binary from source using the local tree-sitter CLI to resolve compatibility errors (e.g. `failIf` errors inside `Language.load`) with the runtime `web-tree-sitter` package.
- **Dart Tree-sitter query compile errors**: Corrected AST patterns in `symbols.scm` and `references.scm` to be compatible with tree-sitter-dart v1.0.0 grammar. Commented out unsupported rules (`extension_type_declaration`, `mixin_on_clause`, `method_invocation`, `function_invocation`, `named_constructor_invocation`) and removed invalid field names. Explicitly traced parent-child AST paths for imports/exports through intermediate `configurable_uri` and `uri` nodes.
- **Language Grammar Query and WASM Parser Compatibility**: Resolved critical AST schema compatibility issues across multiple tree-sitter languages by correcting and updating query `.scm` files:
  - **Java**: Updated modifiers query to match static/final predicates against `(modifiers)` child nodes instead of the non-existent `(modifier)` node type.
  - **Swift**: Commented out the non-existent `extension_declaration` query.
  - **Bash**: Changed `name: (word)` to `name: (command_name)` in `command` queries to match the correct AST structure.
  - **Elixir**: Removed invalid `arguments:` field name in `call` queries, matching the `(arguments)` child node directly.
  - **Zig**: Updated symbols query to use `function_declaration` and `assignment_statement` instead of `fn_proto` and `variable_declaration`. Corrected references query to use `field_identifier` and `call_expression` inside `field_expression` without invalid fields.
  - **Ruby**: Updated superclass query to use a generic wildcard expression (`superclass: (_)`) and updated instantiation query to use separate non-field calls.
  - **Lua**: Rewrote `require` calls to match `(variable)` function names and use a version-agnostic arguments query `(_) @ref.target_require` to prevent syntax crashes.
  - **Pascal**: Replaced invalid query node types with actual AST nodes (`declProc` and `unit` for symbols, `uses_clause` and `exprCall` for references).
  - **Scala**: Simplified import reference query to capture the entire `(import_declaration)` node directly.
- **Svelte Symbol Extraction**: Added matching for the Svelte `<script>` tag (`script_element` mapped as `class`) to extract Svelte components as symbols, since modern tree-sitter-svelte parses script blocks as `raw_text`.
- **Parser Resiliency**: Enhanced `GenericWasmParser.cleanTarget` to strip outer parenthesized arguments (e.g., `('module')` -> `module`), ensuring robust dependency extraction when wildcard arguments are captured.

## [0.3.2] — 2026-05-31

### Added
- **Architecture & Health UI Revamp**: Re-architected the layout of the Architecture & Health panel.
  - Arranged the panel as a flat grid with top-row side-by-side cards (Codebase Profile and Smells) and a full-width bottom card (DSM matrix), completely eliminating horizontal page overflow.
  - Made the top row cards stretch to equal height for a clean layout, while maintaining responsiveness by auto-stacking on narrower viewports (<1000px).
  - Replaced the static, raw-text codebase profile details with glassmorphic pills/badges (`.profile-pill`) for dominant languages, frameworks, and architectural patterns, and color-coded status badges for boolean flags.
  - Added a premium, dynamic SVG circular progress ring (health gauge) to the system health card.
  - Styled involved files in architectural smells as clickable badges (`.involved-file-badge`) that trigger programmatic graph navigation.
  - Implemented a global click listener for node navigation (`data-go-id`) that automatically switches graph mode to Neighborhood focus at depth 1 with the clicked node as the focus seed, handles Cytoscape animation/resize, and transitions active tabs to the Graph Explorer.
  - Unified badge styling and solved spacing issues by replacing inline styles with `.selection-badge` and `.smell-badge-mini` CSS classes with proper padding, typography, and margins (`margin-right: 8px`).
- **Markdown Files Classification**: Configured markdown files (`.md`, `.markdown`, `.mdx`) to always be classified as `'docs'` (documentation) with 100% confidence by default.
- **Selected File Details Enrichment**: Tapping a file node in the Graph Explorer now dynamically loads and displays its Smart Architecture Classification signals and a summary of any architectural smells it is involved in (including suggestions to resolve them).
- **/api/explain API Endpoint**: Exposes classification signals for a specific file path.
- **Smart Architecture Classification**: Replaced the hardcoded path-only layer heuristic with an adaptive, multi-signal classification engine.
  - **Codebase Profiler**: Dynamic archetype detection (`cli-tool`, `web-api`, `web-app`, `full-stack`, `library`, `monorepo`, etc.) and pattern recognition.
  - **Multi-Signal Role Classifier**: Combines 5 signals (path structure, exported symbol naming suffixes, topology, framework bindings, and import directions) to dynamically classify files into Universal, Backend, Frontend, and Tool taxonomy roles.
  - **Leiden Community Detection**: Pure TypeScript implementation of the Leiden algorithm, yielding connected, deterministic, and resolution-controlled clusters.
  - **Architectural Smell Detector & Flow Validator**: Identifies design smells (`cyclic-dependency` via Tarjan's SCC, `hub-component`, `layer-violation` based on allowed direction flow, and `unstable-dependency`).
  - **Dependency Structure Matrix (DSM)**: Heatmap matrix of cluster coupling and Martin's stability metrics (Afferent/Efferent coupling, Instability, Abstractness, and Distance from Main Sequence).
- **New CLI Commands**:
  - `mapx profile` — Shows detected archetype, patterns, and language breakdown.
  - `mapx arch` — Full architectural report (profile, active layers, smells, and DSM).
  - `mapx explain <file>` — Explains classification signals and confidence scores for a file.
  - `mapx layers` — Lists files grouped by their architectural role.
- **New MCP Tools**: Added `mapx_profile`, `mapx_explain`, `mapx_smells`, `mapx_dsm`, and `mapx_layers` to support agentic architectural audits.
- **Web Dashboard "Architecture & Health" Tab**:
  - Interactive DSM heatmap matrix table showing cluster-level dependencies.
  - Health dashboard with gauges for circular dependencies, god clusters, and layer violations.
  - Smell annotations in the Graph View (enlarged hub nodes, dashed red circular edge paths, and highlighted violation arrows).
- **Static file indexing**: Markdown (`.md`, `.mdx`, `.markdown`), HTML (`.html`, `.htm`, `.xhtml`), CSS/SCSS/Sass/Less (`.css`, `.scss`, `.sass`, `.less`), and JSON/JSONC (`.json`, `.jsonc`, `.json5`) files are now indexed and included in the dependency graph. No symbol extraction is performed; only outgoing path references (links, `@import`, `url()`, `href`, `src`, `$ref`) are recorded as edges.
- New `'static'` tier in `LanguageDefinition` for index-only languages with no WASM grammar.
- New `StaticFileParser` (`src/parsers/static-file-parser.ts`) with per-language regex extraction. Markdown links are restricted to markdown-only targets to avoid spurious cross-type edges.
- New `Store.resetRepoForScan()` method — wipes files, symbols, outgoing edges, and clusters for a repo in a single transaction while preserving incoming cross-repo edges and scan-time meta keys.
- New `StaticFileParser` test suite (`tests/static-file-parser.test.ts`) — 69 tests covering all four file types, extension variants, edge-case filtering, and registry integration.
- **Architectural layer clusters** — `ClusterEngine` now detects a fourth cluster source: `'layer'`. Every file in a repo is automatically assigned one of 16 architectural layer categories (`entry`, `api`, `core`, `parsers`, `exporters`, `agents`, `frameworks`, `ui`, `data`, `utils`, `types`, `config`, `scripts`, `test`, `docs`, `other`) via `ClusterEngine.assignFileLayer(filePath)`, which applies path-pattern and filename heuristics in priority order. Each non-empty layer becomes a secondary cluster (stored with `is_primary = 0` so files can belong to both a structural cluster and a layer cluster). A new `layer` TEXT column (`DEFAULT 'other'`) has been added to the `clusters` DB table (migration v7).
- New **"Group: Arch Layer"** option in the UI graph proximity view grouping dropdown — selecting it visualises all nodes grouped by architectural layer with distinct per-layer border colours.
- Each layer cluster node in the graph carries a `layerColor` data property; a new cytoscape stylesheet rule (`node[type="cluster-group"][?layerColor]`) uses it to render per-layer border and background tints, making architectural structure immediately visible.
- `mapx clusters --source layer` now works as a filter. The summary line at the bottom of `mapx clusters` output includes the layer count when layer clusters are present (e.g. `… 16 layer`).
- New `ArchLayer` union type exported from `src/types.ts`.
- 17 new tests in `tests/cluster-engine.test.ts`: 15 unit tests for `assignFileLayer` covering every layer category (entry, api, core, parsers, exporters, agents, frameworks, ui, data, utils, types, config, scripts, test, docs, fallback), plus 2 integration tests confirming layer clusters are correctly persisted and wired to memberships.
- **`mapx init` monorepo/nested-repo discovery step** — after init completes, when a TTY is present, mapx now checks for monorepo packages and nested git repositories. If any are found a Y/N prompt (default Y) asks whether to register them, followed by individual `multiselect` lists for nested repos and monorepo packages separately. Pass `--no-discover` to skip entirely (useful for non-interactive CI environments).
- **Monorepo package discovery** — `WorkspaceManager.discoverMonorepoPackages(rootDir)` detects packages/apps within a monorepo and returns them as registerable repos. Detection reads workspace manifests in priority order: `pnpm-workspace.yaml` → `package.json` workspaces (npm/yarn) → `lerna.json` → `rush.json` → `Cargo.toml` `[workspace]` members → `go.work` `use` block → `turbo.json`/`nx.json` (uses default dirs). Falls back to scanning `apps/`, `packages/`, `libs/`, `services/`, `modules/`, `clients/`, `backend/`, `frontend/` when no manifest is found. Each directory must contain a package manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `composer.json`, `build.gradle`, `pom.xml`) and must not have its own `.git` entry (those are handled by `discoverNestedGitRepos`). Package names are resolved from manifests with `@scope/` prefix stripping.
- `mapx workspaces list` now includes a **"Monorepo packages"** section showing unregistered packages with their detected package manager.
- `mapx workspaces discover` includes monorepo packages in its output.
- `mapx workspaces sync` prompts with an interactive `multiselect` to choose which monorepo packages to register and scan.
- `mapx_workspaces` MCP tool `discover` action now includes `{ source: 'monorepo' }` entries for discovered packages.
- New `MonorepoPackageInfo` type exported from `src/types.ts`.
- 14 new tests in `tests/workspace-manager.test.ts` covering: npm/yarn/pnpm/lerna/cargo/go manifests, fallback scan, skip dirs without manifests, skip `.git` dirs, `@scope/` strip, directory name fallback, deduplication, and noise dir skipping.
- **Nested git repository discovery** — `WorkspaceManager.discoverNestedGitRepos(root, maxDepth=3)` recursively walks the workspace directory up to 3 levels deep, finding any subdirectory that contains a `.git` entry. Common noise paths (`node_modules`, `dist`, `build`, `.cache`, `coverage`, `vendor`, `target`, `.mapx`, etc.) are automatically skipped. Recursion stops at each discovered boundary so inner repos of an already-found repo are not double-reported.
- `mapx workspaces list` now includes a **"Nested git repositories (deep scan)"** section listing any discovered nested repos not yet registered.
- `mapx workspaces discover` includes nested git repos in its output with a `nested-git` source label, and counts them in the total.
- `mapx workspaces sync` prompts the user with an interactive `multiselect` to choose which newly discovered nested repositories to register and scan (submodules/peer repos are still auto-added silently as before).
- `mapx_workspaces` MCP tool `discover` action now includes `{ source: 'nested-git' }` entries for nested repos found by the deep scan.
- New `discoverNestedGitRepos` test suite in `tests/workspace-manager.test.ts` — 10 tests covering depth limits, custom `maxDepth`, skip lists, boundary non-recursion, multi-repo at same level, empty roots, and nonexistent paths.

### Changed
- **Default View & Reset View settings**: Configured the dashboard to load by default into the "Clusters Map" (proximity mode) with "Group: Architecture" (layer grouping) enabled. Standardized the "Reset All" button to restore these view settings.
- `*.min.css` added to default `excludePatterns` to avoid indexing minified stylesheets as noise.
- `mapx files --path` now accepts glob patterns (e.g. `src/core/*.ts`, `**/*.json`) in addition to plain path prefixes.
- `mapx deps <file>` now resolves file arguments via glob, wildcard, and substring matching — exact match is tried first, then glob patterns, then substring containment. Multiple matched files are all reported.
- `FlowTracer.resolveStart` (used by `mapx trace`) now resolves file arguments via glob and substring matching in addition to exact/suffix match.
- `mapx_files` MCP tool `path` parameter now accepts glob patterns; the response header says `"matching <glob>"` for glob inputs and `"under <prefix>"` for plain prefix inputs.
- Makefile `files` target now quotes the `--path` argument (`"$(p)"`) to prevent shell glob expansion before the CLI receives it.
- Makefile has new targets for all missing CLI commands: `context`, `profile`, `arch`, `explain`, and `layers`, aligning Makefile shortcuts with all available CLI commands.
- **Leiden community detection parameters**: Tuned resolution from `1.0` to `1.3` and lowered minimum community size from `3` to `2` to split large monolithic clusters and capture small component pairs (e.g. source-test relationships).
- **Proximity View unassigned file grouping**: Instead of a flat global `community_unassigned` bucket, files without community clusters are grouped dynamically by their parent directory paths as fallback folder clusters.
- **Enhanced Proximity Cluster Styling and Visuals**: Dynamically styled community clusters, folder fallbacks, orphans, and singulars in the graph using distinct shapes, border colors, and border styles (e.g. dashed borders for folder and orphan nodes, solid bronze hexagons for tight community groups) to significantly improve visibility and readability.

### Fixed

- **Proximity mapping collision**: Filtered membership inputs in `communityMap` to only map community clusters (names starting with `community_`), preventing directory/namespace memberships from overwriting proximity groupings.
- **Leiden community overlap discarding**: Removed strict overlap filtering that skipped community clusters matching directory file sets, preserving topological groupings in the Proximity view.
- **Proximity unassigned cluster labels**: Labeled unassigned directory fallback clusters dynamically as `Folder: <directory_path> (<count> files)` with correct drill-down capabilities, removing the repetitive "Unassigned" prefix.
- **UI Tab Panel Layout Nesting**: Fixed a layout bug in `src/ui/index.html` where missing closing tags (`</div>` and `</section>`) for the Metrics tab caused subsequent tabs (Architecture, Context, and Tool Call Log) to be incorrectly nested inside it, resulting in a blank screen.
- **ELK layout horizontal spread** — The ELK "Layered" graph layout now uses `elk.separateConnectedComponents: true` so disconnected file groups (e.g. standalone `.md`, `.json`, or `.scm` files) no longer bleed into the same horizontal bands as connected TypeScript/JavaScript trees, eliminating excessive left-right spread. File nodes are additionally partitioned by extension (`ts/tsx` → band 1, `js/jsx` → 2, `json/yaml` → 3, `html/css/vue/svelte` → 4, `md` → 5, `sh` → 6, `scm` → 7) via a `nodeLayoutOptions` callback, so files of the same type land in the same vertical cut of the tree and form separate compact sub-structures when unconnected to other groups. Spacing, compaction strategy (`LEFT_RIGHT_CONSTRAINT_LOCKING`), and aspect ratio (`1.7`) are tuned to reduce horizontal bloat.
- **Cytoscape self-loop edge warnings** — Edges where `source === target` (scanner artifacts where a file references itself) are now filtered out of `rawGraphElements` at load time. These caused `Edge 'edge-X-X' has invalid endpoints` console warnings in Cytoscape because source and target nodes overlap.
- **`.js`-extension imports resolving to `.ts` sources**: TypeScript projects that use the `"moduleResolution": "bundler"` / `"nodenext"` convention of writing `import './utils.js'` when the actual source file is `utils.ts` now resolve correctly. `resolveImportPath` now checks `<stem>.ts` and `<stem>.tsx` as immediate fallback candidates whenever the import specifier ends with `.js` or `.jsx`, **before** trying generic extension appending. A real `.js` file (if present) still takes priority.
- **False Cross-File Dependency Edges** — Fixed a symbol resolution bug in `resolveSymbolToFile` (`src/core/scanner.ts`) where a call to a locally-defined helper (e.g. `cleanQuotes` inside `php.ts`) could resolve to an identically-named symbol in a completely unrelated file (e.g. `express.ts`), creating phantom graph edges. The resolver now checks for a **same-file match first** at every resolution path (exact-name lookup, namespace-stripped fallback, and first-result fallback) before falling back to a global match.
- **`scan --force` stale data**: A forced full re-scan now wipes all existing DB data for the target repo (symbols, edges, files, clusters) and clears any stale interrupted-scan resume state **before** discovery begins. Previously, an interrupted prior scan could cause `--force` to silently skip files it considered already completed, and symbols/edges from deleted or renamed files could persist indefinitely.
- **Layer memberships overriding community grouping** — The UI proximity view's default "Group: Community" strategy built a `communityMap` from all memberships without filtering by source. Since every file also receives a `layer:*` membership and `Map.set` overwrites, layer entries appearing after community entries silently replaced community assignments for connected files, collapsing the view into `cluster:layer:*` pseudo-communities. The `communityMap` builder now skips memberships whose `clusterName` starts with `layer:` — the layer grouping strategy already has its own dedicated code path.
- **JSONC/JSON5 config files returning no references** — `StaticFileParser.extractJsonRefs` used `JSON.parse` directly, which rejects JSONC/JSON5 syntax (comments, trailing commas, unquoted keys, single-quoted strings). Files with `.jsonc` or `.json5` extensions — and common configs like `tsconfig.json` with comments — silently returned zero `$ref`/`extends` references. Added a `stripJsoncSyntax()` normaliser that handles line/block comments, trailing commas, single-quoted strings, and unquoted object keys before parsing. Includes 10 new test cases.

## [0.3.1] — 2026-05-31

### Added

- **Expanded Core Test Coverage** — Expanded unit test coverage to 80%+ across five key core modules:
  - `src/core/store-interface.ts` (100% line coverage)
  - `src/agents/generator.ts` (96.62% line coverage)
  - `src/core/scanner.ts` (86.35% line coverage)
  - `src/mcp.ts` (81.75% line coverage)
  - `src/cli.ts` (80.02% line coverage)
- **Robust Unit Test Mocking** — Refactored and expanded test suites using `vi.hoisted()` for clean module-level mocking in `tests/cli.test.ts` (expanded to 159 tests) and `tests/mcp.test.ts` (expanded to 98 tests), covering complex edge cases, progress rendering, subcommands, and tool implementations.
- **Symbol Explorer Pagination** — Symbol Explorer now supports paginated browsing with 50 results per page. Pagination controls (Prev / page-info / Next) appear at both the top and bottom of the left panel for quick navigation without scrolling. `/api/symbols` returns `{ results, total, limit, offset }` and accepts `limit`/`offset` query params. `Store.searchSymbolsFiltered` accepts an `offset` param; a new `Store.countSymbolsFiltered` method returns the total match count using the same WHERE clause.
- **Symbol Explorer Row Highlighting** — Clicking a row in the Symbol Explorer now highlights it with a blue-tinted background and outline via a `selected-symbol-row` CSS class, making it easy to track which symbol is currently selected while reading the detail panel.
- **Symbol Explorer Dual Pagination Controls** — Pagination Prev / info / Next controls now appear at both the top and bottom of the Symbol Explorer left panel, so the user never has to scroll to reach navigation.
- **Tool Call Log Infinite Scroll** — The Tool Call Log now loads entries in pages of 50 using an `IntersectionObserver` sentinel at the bottom of the scroll container. Scrolling to the bottom automatically fetches the next page of older entries. `/api/tool-calls` accepts `?limit=N&offset=M` and returns `{ events, total }` for cursor-based pagination; the SSE/polling path continues to inject new entries at the top in real-time.
- **Graph Loading Overlay** — A spinner overlay with phase labels ("Fetching graph data…" → "Building graph…" → "Running layout…") is displayed inside the graph canvas while data is loading. The overlay auto-dismisses on `layoutstop` or after a 10-second safety timeout.
- **fCoSE Default Graph Layout** — fCoSE (Force-directed Compound Spring Embedder) is now the default graph layout algorithm, replacing ELK. The layout selector defaults to "Organic — fCoSE" on page load and after Reset All.

### Changed

- **Graph API Edge Deduplication** — `/api/graph` now deduplicates edges server-side using a `Map` keyed on `source_file→target_file`, aggregating weight and count. This eliminates thousands of redundant symbol-level edges from being sent to the browser for large codebases, significantly improving load time and Cytoscape rendering performance.
- **Proximity Mode Threshold Lowered** — Auto-switching to Proximity Clusters mode now triggers when `fileCount > 200 || edgeCount > 500` (previously `fileCount > 1000`), catching medium-sized codebases that were silently overloading the force-directed layout.
- **fCoSE Layout Tuning** — fCoSE config now always uses `quality: 'default'` (was `'draft'` for large graphs, which skipped overlap removal). `nodeRepulsion` increased to `250000`, `gravity` set to `0.08`, `edgeElasticity` to `0.35`, `tilingPadding` to `40`, and `nodeSeparation` adapts between `120`–`160` based on node count. `uniformNodeDimensions: false` preserves dynamic sizing.
- **Pre-scatter Before Physics Layouts** — All physics-based layouts (fCoSE, cose, Cola, Concentric) now scatter nodes to randomized positions across the full container dimensions before running the layout. This prevents nodes from stacking at the origin `(0,0)` when switching modes or reloading the graph, and produces better-spread initial conditions for force simulation.
- **Animation Threshold Reduced** — Graph element animations are disabled when `visibleCount > 200` (was `> 500`), avoiding sluggish transitions on mid-sized graphs.

### Fixed

- **ERR_HTTP_HEADERS_SENT Crash** — Fixed a crash in `ui-server.ts` where `store.close()` inside a `finally` block could throw after the response was already sent, causing the outer `catch` to attempt a second `res.writeHead()`. Both catch blocks now guard with `if (!res.headersSent)` and `store.close()` errors are silently swallowed in `finally`.

## [0.3.0] — 2026-05-29

### Added

- **Picomatch Glob Migration** — Migrated all glob pattern matching, testing, and filtering logic across the entire MapX codebase from `minimatch` to `picomatch`.
- **Bundled Language & Dialect WASMs** — Bundled all 22 supported languages and dialect WASMs (including Svelte, Lua, Elixir, Zig, Bash, Pascal, and Dart) directly with the npm package under a `bundled` tier. This provides zero-install offline-first execution.
- **Fuzzy Symbol Suggestions (CLI & MCP)** — When a symbol is not found, all symbol-accepting commands (`query`, `search`, `callers`, `callees`, `impact`, `node`) now use [Fuse.js](https://fusejs.io/) to suggest up to 5 similar symbol names ranked by edit distance. Created `src/core/fuzzy-matcher.ts` as a shared module for both CLI and MCP tools.
- **`mapx_batch` MCP Tool** — New orchestration tool that executes multiple operations (`search`, `node`, `callers`, `callees`, `deps`) in a single round-trip call. Supports configurable `maxItems` limit (default: 10) with per-operation error isolation.
- **JSON Output for `search` and `node` CLI Commands** — Added `--format json` option to `mapx search` and `mapx node` CLI commands, producing structured JSON output with symbol metadata, PageRank scores, and optional source code.
- **Summary Headers (CLI & MCP)** — All search/query/caller/callee/files results now include a count summary header (e.g. `Found 20 symbols of kind "class":`), active filters, and broadening notices.
- **GitHub Actions CI Workflow** — Added `.github/workflows/ci.yml` with 4 jobs: type check, unit tests with coverage, build verification, and integration tests exercising glob/fuzzy/batch features.
- **Unit Test Suite (Vitest)** — Added `vitest` with `@vitest/coverage-v8` for unit testing. Created `tests/fuzzy-matcher.test.ts` (16 tests) and `tests/store-search.test.ts` (17 tests) covering glob patterns, wildcards, case-insensitive matching, fuzzy suggestions, kind filtering, and search-with-filter logic.
- **CLI, MCP, and Bun Store Unit Test Suites** — Implemented comprehensive unit test suites for `cli.ts`, `mcp.ts`, and `store-bun.ts`. Tests CLI subcommands, global flags, and outputs. Tests MCP server tools, schema parsing, and command routing using an in-memory transport mock. Tests BunStore SQL backend using a mock SQLite registry over `better-sqlite3`.
- **CI Test Coverage Expansion** — Expanded test coverage targets to include CLI, MCP, and BunStore, raising workspace statement coverage from 39.56% to 59.27% and lines coverage to 61.15%.

### Changed

- **Standalone Bun Binary Module Resolution Fix** — Refactored `store.ts` to statically import `store-bun.js` and `store-node.js` backends instead of using dynamic `createRequire`, resolving runtime `Cannot find module './store-bun.js'` crashes in compiled Bun standalone binaries.
- **Standalone Bun Binary WASM Path Fix** — Patched `findAssetRoot()` in `wasm-parser.ts` and `parse-worker.ts` to filter out Bun virtual filesystem paths (`/$bunfs` and `bun:`) and added the `locateFile` option to `Parser.init` pointing to `web-tree-sitter.wasm` inside `PROJECT_ROOT/wasm/` directory to prevent runtime WebAssembly crashes.
- **README Redesign** — Redesigned the main `README.md` with centered hero badges, a description tagline, an expandable Table of Contents, and structural parser tables matching the style of the picomatch README.
- **Wildcard & Glob Pattern Support (CLI & MCP)** — `mapx query`, `mapx search`, `mapx_query`, and `mapx_search` now support wildcard (`*`, empty string) and glob patterns (`*Service`, `get?`, `*Controller*`). The original bug where `{ "term": "*", "kind": "enum" }` returned no results is fixed. Glob patterns are converted to SQL `LIKE` patterns (`*` → `%`, `?` → `_`).
- **Case-Insensitive Symbol Search** — All symbol name matching across `searchSymbols()` and `searchSymbolsFiltered()` now uses `COLLATE NOCASE` for consistent case-insensitive behavior.
- **Auto-Expand on Zero Results** — When a `--kind` filter yields zero results in `search`/`mapx_search`, the search automatically retries without the kind filter and notifies the user that results were broadened.
- **Enhanced Staleness Warnings (CLI & MCP)** — Staleness warnings now list up to 5 changed file names (e.g. `Changed: src/mcp.ts, src/cli.ts (and 3 more)`) instead of just showing a count.
- **Enriched MCP Tool Schemas** — All 9 major MCP tool descriptions rewritten with concrete JSON usage examples, search mode documentation, and `kind` field `enum` constraint. Tools: `mapx_search`, `mapx_query`, `mapx_node`, `mapx_callers`, `mapx_callees`, `mapx_impact`, `mapx_context`, `mapx_files`, `mapx_export`.
- **Related Symbols in `mapx_node` / `mapx node`** — Node inspection now shows a "Related symbols" sidebar listing callers, callees, and sibling symbols in the same file.
- **Updated Agent Templates** — All 12 agent integration templates (AGENTS.md, CLAUDE.md, Cursor, Windsurf, Copilot, Aider, Gemini, Zed, Continue, Cline, Antigravity, Instructions) updated to document glob patterns, fuzzy fallback, `--format json`, `mapx_batch`, and 26-tool count.

## [0.2.7] — 2026-05-28

### Added

- **Proximity Clusters View Mode** — Added a new visualization mode designed specifically for large codebases (>1000 files). Files are grouped using community detection (LPA) into root-level cluster group nodes (styled as hexagons with wrapped labels showing file counts). Double-clicking or clicking root clusters zooms and expands them into focused drill-down views displaying cluster nodes and boundary nodes with dashed border formatting. Provides intuitive breadcrumb navigation to return to parent views.
- **Concentric & Hierarchical Dagre Layouts** — Registered and integrated Cytoscape Concentric layout (ordering nodes by connections) and Dagre hierarchical layout (visualizing parent-child dependency trees within expanded clusters) to replace the old Circle layout option.
- **Custom Grouping Strategies & Filtering** — Added support for grouping graph elements by Community Clusters, Directories, Programming Languages, or Custom User Tags.
- **Interactive Graph Editing** — Added "Remove Node" and "Remove Edge" actions directly in the selection details panel. Hidden elements can be cleared using the "Reset Hidden" toolbar action.
- **Custom Node Tagging** — Added a tag input and "Add Tag" button in the selection details panel to assign custom metadata tags, allowing custom-grouped graph visualization.
- **Qualified Hook Entries** — Upgraded Laravel hook binding extraction to register fully-qualified namespace and class names as hook entries in the code graph database.
- **UI Graph Selection Related Flows** — Added an interactive selection details panel component displaying related nodes and edges, organized by incoming/outgoing flow directions. Incoming and outgoing flows are wrapped in native details/summary collapsible elements (collapsed by default). Button elements use high-contrast color highlights to optimize legibility. Clicking any element in the list triggers programmatic graph centering, selection highlighting, and detail panel updates.
- **Laravel Pre-scan & Routing Context** — Integrated pre-scan parsing of `app/Http/Kernel.php` to extract middleware groups and aliases, and `app/Providers/RouteServiceProvider.php` to capture global prefixes, namespaces, and middleware groups applied to route files. Implemented recursive workspace directory scanning to discover custom package service providers (`*ServiceProvider.php`) and register route files loaded via `$this->loadRoutesFrom(...)`.
- **Laravel Middleware Resolution & Hook Extraction** — Enhanced route extraction to resolve and expand compound/alias middleware references to their concrete FQNs. Added hook bindings extraction to register discovered service providers (`service_provider`) and middlewares (`middleware`) as qualified entries in the code graph.
- **CLI Command Alignment (Sources, Sinks, Context)** — Added top-level CLI commands `mapx sources`, `mapx sinks`, and `mapx context <task>` to achieve feature parity and align the CLI toolset with the MCP server tools and documentation.
- **Automatic MCP Instructions Generation** — Integrated `instructions.md` (`.agents/rules/instructions.md`) into the central templates registry, so that it is automatically generated and updated during `mapx init`, `mapx agents generate`, and `mapx agents update` setups (while remaining hidden from CLI multiselect provider prompts).
- **Detailed MCP Guide** — Created `.agents/rules/instructions.md` containing a comprehensive usage guide for MapX MCP server tools, schemas, query parameters, and best practices.
- **LLM Exporter File Summaries** — Integrated heuristic summaries (class/method/function counts and dominant symbol types) for file nodes in the `llm` export format.
- **Graph Layout Dropdown with 8 Algorithms** — Replaced the scattered layout button group (fCoSE, Concentric, Dagre, Grid) with a single unified dropdown selector supporting 8 layout algorithms: Force-Directed (fCoSE), Spring Embedded, Constraint-Based (Cola), Tree Hierarchy (Dagre), ELK Hierarchical (MrTree), Circular, Ring (Concentric), and Grid. Each layout has tuned parameters via a centralized `getLayoutConfigForName()` resolver.
- **Custom Autocomplete for Neighborhood Focus** — Replaced the native HTML datalist with a fully custom autocomplete dropdown featuring fuzzy substring file matching, keyboard navigation (↑/↓/Enter/Escape), match text highlighting, language badges per result, file path display, and click-outside-to-close behavior.
- **Segmented Depth Toggle** — Replaced the cycling depth button in focus mode with a 3-button segmented control (`1 | 2 | 3`) providing immediate visual feedback of the current traversal depth selection.
- **Custom Tags Persistence** — Tags assigned to graph nodes are now saved to `localStorage` with a repo-scoped key (`mapx-custom-tags-{repoName}`) and automatically restored on page load. Tags can be removed individually via `✕` buttons on each tag badge.
- **Reset All Toolbar Button** — Added a "Reset All" action button that restores all toolbar state to defaults: mode (proximity), layout (concentric), grouping (community), language filter (none), focus state, cluster state, and hidden elements.
- **Enriched Selection Details Panel** — File node selection now displays a stat grid with: in/out degree, total connections, symbol count, PageRank score (×1000), and cluster membership. Edge selection shows verifiability badges (green for verified, yellow for inferred), edge weight, and clickable source/target links.
- **`/api/graph/meta` Endpoint** — Added a new lightweight API endpoint returning `{ totalFiles, totalEdges, totalElements }` for the UI to check graph size before requesting full data.
- **Graph API Pagination** — `/api/graph` now accepts `?limit=N&offset=M` query parameters. When pagination params are provided, the response is wrapped in `{ elements: [...], meta: { total, limit, offset } }`. Without pagination params, the flat array is returned for backward compatibility.
- **Graph API Gzip Compression** — Responses larger than 1MB are automatically gzip-compressed via streaming when the client sends `Accept-Encoding: gzip`, removing the previous hard 10MB error limit for large codebases.
- **Graph API Enriched Node/Edge Data** — `/api/graph` file nodes now include `symbolCount` (SQL aggregate from symbols table) and `pagerank` (computed via `MapxGraph.computePageRank()`). Edge elements now include `weight` from the database record.

### Changed

- **Graph Toolbar Contextual Visibility** — Mode-dependent controls now show/hide automatically: clusters toggle appears only in Full Codebase and Focus modes, grouping strategy dropdown only in Proximity mode, and focus panel only in Neighborhood Focus mode. This eliminates logical interference between mode-specific toggles.
- **Unified Layout Resolution** — Consolidated all per-mode layout configuration into a single `getLayoutConfigForName()` resolver function, eliminating ~70 lines of duplicated layout config across mode handlers. `updateGraphDisplay()` now respects the user's layout dropdown selection and only overrides for proximity top-level view (which requires fCoSE for community grouping).
- **fCoSE Node Spacing** — Increased `nodeRepulsion` from `60000` to `120000`, `idealEdgeLength` from `100` to `160`, enabled `nodeDimensionsIncludeLabels`, and added `nodeSeparation: 100` to prevent node overlap in force-directed layouts, especially for large graphs.
- **Directory Node Text Overflow** — Fixed long directory path labels overflowing node boundaries by truncating to last 2 path segments (e.g., `…/components/ui`) and applying Cytoscape `text-wrap: ellipsis` with `text-max-width` constraints.
- **Cluster Group Node Text Overflow** — Changed cluster group label rendering from `text-wrap: wrap` to `text-wrap: ellipsis` with dynamic `text-max-width` proportional to node size, preventing label spillover on compact hexagon nodes.
- **Edge Selection Details** — Edge tap details now show: verifiability as a styled badge (green for `verified`, yellow for `inferred`), edge weight when available, and clickable source/target file links that navigate the graph. Removed the verbose Edge ID display.
- **Laravel Route & Controller Mapping** — Upgraded the [LaravelDetector](./src/frameworks/detectors/laravel.ts) to support modular route structures (case-insensitive checking), group array attributes (prefix, namespace, middleware), `Route::controller` groups, `Route::match` and `Route::any` verbs, and inline comma-separated controller attributes. Added singularized resource route expansion (`resource`, `apiResource`, `resources`, `apiResources`) to generate actual individual routes with their controller action symbols rather than a single dummy `RESOURCE` route.
- **Deep Laravel Controller Analysis** — Added parsing of controller files to extract path, query, and request body parameters, as well as constructor-defined middlewares (supporting `.only(...)` and `.except(...)` filters) using an asynchronous file cache.
- **Route Registry Deduplication** — Updated the [RouteRegistry](./src/frameworks/route-registry.ts) `addRoute` method to check for and prevent duplicate route registrations.
- **Updated Agent Templates** — Aligned all IDE/agent templates (GitHub Copilot, Windsurf, Cline, Aider, Gemini, Zed) in [templates.ts](./src/agents/templates.ts) to include references to the new `sources`, `sinks`, and `context` commands or MCP tools.
- **Cross-Language Reference Prevention** — Constrained global symbol resolution to respect language compatibility groups. References from a source file (e.g. a PHP WordPress plugin) can no longer resolve to symbols in incompatible language files (e.g. TypeScript), preventing false edges.
- **Search Wildcard & Case-Insensitivity** — Modified the symbol search command and MCP tool to support wildcard `*` and empty string `""` queries to list all symbols under a file path constraint. Standardized `kind` search filters to run case-insensitively.
- **Logical Cluster Grouping Boost** — Refined the `mapx_context` token-budget relevance scoring heuristics to give an extra boost (+150 points) to files sharing logical clusters with the matched seed files.
- **Centralized try/catch-Aware Impact Analysis** — Extracted and centralized BFS traversal and risk categorization logic to a new reusable `ImpactAnalyzer` module. Categorized callers at depth 2+ as `MEDIUM` or `LOW` risk, and calling sites inside test files or wrapped in try/catch blocks as `LOW` risk.

- **Graph Resolution Blacklist** — Prevented standard built-in JavaScript/TypeScript globals (`Date`, `Error`, `Map`, `Set`, `Promise`, `Object`, `Array`, `String`, `Number`, `Boolean`, `Function`, `RegExp`, `Symbol`, `JSON`, `Math`, `console`, `Console`, etc.) from incorrectly resolving to user-defined symbols during database reference resolution.
- **Import Caller Filtering** — Excluded named imports and require declarations (`import` and `require` edge types) from the standard `callers` query outputs, eliminating `<top-level>` import statement noise in call graphs.
- **Enhanced Change Impact Risk Scoring** — Upgraded `mapx impact` and `mapx_impact` risk grading. Calls from test files (`.test.ts`, `.spec.ts`, etc.) are now classified as `LOW` risk, calls wrapped inside `try`/`catch` blocks are downgraded by one risk level, and callers at depth 2+ or inside test modules are classified as `MEDIUM` or `LOW` risk.
- **Filesystem Staleness Detection** — Added file modification time checking to output a staleness warning header (`⚠️ Warning: Graph index may be stale...`) in all CLI and MCP query tools when modifications occur on disk without running `mapx update`.
- **NestJS Decorator Routing** — Implemented decorator-based route extraction from class-level `@Controller` and method-level route handler decorators (`@Get`, `@Post`, `@Patch`, `@Delete`, etc.) supporting both string arguments (including template literals) and object configurations (e.g. `@Controller({ path: 'prefix' })`).

- **NestJS GraphQL & WebSockets Integration** — Added resolver extraction from `@Resolver`, `@Query`, `@Mutation`, and `@Subscription` decorators, WebSocket event subscriptions from `@SubscribeMessage`, and microservice handlers from `@MessagePattern` and `@EventPattern` using a robust, comment-resilient method name discovery helper.
- **NestJS Lifecycle & Custom Interfaces** — Cataloged class definitions implementing custom interfaces such as lifecycle hooks (`OnModuleInit`, `OnApplicationBootstrap`, etc.) and guard/pipe/interceptor definitions (`CanActivate`, `PipeTransform`, `NestInterceptor`) as queryable hooks.
- **NestJS Constructor Dependency Injection** — Extended TS/TSX tree-sitter references queries to capture type annotations in constructor parameters (e.g. `constructor(private readonly service: Service)`) and map them as `param_type` dependency injection edges in the graph.
- **AST-Based Parser Scope Resolution** — Fixed a critical scoping bug in the generic WASM parser that caused method/property symbols to incorrectly inherit the scope of the last-parsed class in file iteration, resolving them via AST ancestor symbol lookup instead.
- **JSX Rendering Edges** — Added parsing and extraction of opening (`<Component>`) and self-closing (`<Component />`) JSX tags in `.tsx` and `.jsx` files as `render` edges.
- **Native HTML Elements Filtering** — Implemented target name checking (`/^[A-Z]/`) to filter out native lowercase HTML tags (like `<div />`, `<span />`) and only emit edges for custom React component tags.
- **TS/TSX Query Separation** — Separated references query configuration between standard TypeScript and TSX files (`references.scm` and `references-tsx.scm`) to prevent grammar syntax compilation errors in non-JSX files.
- **JSX Extension Mapping** — Added `.jsx` file extension mapping to the JavaScript language registry for JSX file recognition and parsing.
- **Exporter Rendering Edge Styling** — Added distinctive cyan styling (dotted/dashed) for `render` edges in both DOT and SVG exporter modules.
- **CLI & MCP Sinks Filtering** — Added support for `render` type edges in data-bearing edges arrays in CLI and MCP server tools to ensure accurate terminal consumer/sink detection.
- **React & TSX Parser Fixes** — Added support for scanning, indexing, and querying TSX files (`.tsx` extensions) using a dedicated TSX tree-sitter parser grammar.
- **Default and Anonymous Export Parsing** — Enhanced TypeScript and JavaScript symbol extraction to query and match default class/function exports and anonymous arrow functions exported as default.
- **Anonymous Default Export Auto-naming** — Implemented auto-naming logic in the generic WASM parser to resolve anonymous default exports using the file's base name (e.g., `export default () => {}` in `Home.tsx` is named `Home`).
- **Duplicate Symbol Node Filtering** — Added a `seenNodeIds` lookup constraint during AST parse collection to prevent duplicate symbols from being extracted when matching multiple query patterns on the same node.
- **TSX Import Path Resolution** — Updated the path resolution algorithm to recognize `/index.tsx` and `.tsx` candidate targets for relative and absolute imports.
- **Exclusion Configuration Adjustments** — Extended JS/TS default ignore patterns in the configuration class to automatically exclude `**/*.test.tsx` and `**/*.spec.tsx` files.
- **Layout Algorithm Shorthand Labels** — Each layout option in the dropdown now includes the algorithm shorthand after an em dash for quick identification (e.g., "Tidy — Cola", "Organic — fCoSE", "Layered — Dagre", "Tree — ELK", "Radial — Concentric", "Circular — Circle").
- **Dedicated Layout Toolbar Group** — Separated the layout dropdown into its own `toolbar-group` with a "Layout" label, placed first in the toolbar for prominence.
- **Focus Mode Controls Restoration** — Restored the Neighborhood Focus controls (file search autocomplete, clear button, depth segmented toggle) as the last toolbar group, with a "Focus" label. Controls appear only when focus mode is active.
- **Breadcrumbs for Focus Mode** — Breadcrumbs now display in both Proximity Clusters drilldown (showing cluster name) and Neighborhood Focus mode (showing focused file name with "Focus →" prefix).
- **HTTP Method Color Coding** — Route method badges are now color-coded by verb: GET (emerald), POST (blue), PUT (amber), PATCH (teal), DELETE (red), HEAD (indigo), OPTIONS (violet), ANY (purple), with a slate fallback for unknown methods.
- **Hook Type Color Coding** — Hook type badges are now color-coded by keyword: middleware (indigo), event/listener (cyan), filter (amber), action (rose), lifecycle (teal), provider (violet), guard (red), pipe (cyan-light), interceptor (purple), resolver (blue), subscriber (pink).
- **Metric Card Glassmorphism** — Metric cards now feature glassmorphism styling with `backdrop-filter: blur`, hover state with brighter border and shadow, uppercase small-caps headings with bottom dividers, and tighter typographic spacing.
- **Global Monochromatic Scrollbars** — Replaced per-element scrollbar styles with a unified global `*` scrollbar using 5px monochromatic white-on-dark theme (`rgba(255,255,255, 0.12)` thumb, `rgba(255,255,255, 0.03)` track) applied consistently across all scrollable panels.

### Changed

- **Grouping Strategy Enable/Disable** — Changed grouping strategy dropdown from show/hide to always-visible with enabled/disabled state. Enabled only in Proximity Clusters mode at root level (no active drilldown). Disabled with 35% opacity and `not-allowed` cursor in all other modes or when drilled into a cluster/directory.
- **Toolbar Separator Visibility Centralized** — Separator visibility is now managed exclusively by `updateToolbarVisibility()`, shown when either breadcrumbs or focus search panel are visible. Removed 5 scattered separator manipulation points.
- **Cola Layout Vertical Drift Fix** — Added `randomize: true` to Cola config, position scrambling before each Cola run in `runLayout()`, tighter convergence threshold (0.001), explicit constraint iterations (`unconstrIter: 10`, `userConstIter: 20`, `allConstIter: 20`), increased `nodeSpacing` to 40, and `ungrabifyWhileSimulating: true` to prevent progressive vertical drift after view/grouping changes.

### Fixed

- **Silence prebuild-install Deprecation Warning** — Resolved the NPM deprecation warning for `prebuild-install` (transitive dependency of `better-sqlite3`) by adding a package-level override pointing directly to the tagged GitHub repository release. This preserves SQLite query/transaction integrity and prevents terminal noise during installation.
- **Fix Bun SQLite Require Compilation Warning** — Replaced direct Node-style `require('bun:sqlite')` with dynamically constructed `createRequire` in `src/core/store-bun.ts`. This silences the compiler warning during ESM builds while preserving native Bun SQLite loader capability.
- **Automatic Database Parent Directory Creation** — Updated the `Store` class constructor to check for and recursively create the target database's parent directory if it does not exist (excluding `:memory:` paths). This prevents `TypeError` crashes when programmatically instantiating the database store in new/nested directory structures.
- **ESM-Only Programmatic Usage Documentation** — Added an alert to the programmatic usage section of `README.md` clarifying that MapX is ESM-only and requires consumer applications to declare `"type": "module"` in their `package.json` to avoid resolution crashes.

---

## [0.2.6] — 2026-05-24

### Changed

- **Interactive CLI Revamp with Clack** — Integrated `@clack/prompts` to replace old readline-based console prompts with beautiful, interactive terminal widgets. Revamped confirmation prompts, LLM tool multi-select setups (`selectProvidersInteractive`), and converted the text-based scanner progress rendering to premium animated spinner sequences.
- **Default Exclude Patterns Expansion** — Significantly expanded the default file exclusion patterns in `src/core/config.ts` to automatically ignore build directories (`dist`, `build`, `.next`), virtual environments (`.venv`, `__pycache__`), package lockfiles (`yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `go.sum`, etc.), package manifests, system/log files (`DS_Store`, `*.log`), and large third-party assets (Monaco editor files, Bootstrap scripts, React/Vue production builds). This drastically reduces token consumption and database size during scans by default.
- **PULL_REQUEST_TEMPLATE.md Updates** — Updated the checklist to verify NPM dependency lock synchronization via `make version-sync`, local prebuilt packaging builds (e.g. `make package-linux`), and agentic integration rules (`.agents/rules/mapx.md`). Included testing guidelines for both native CLI running and zero-installation `npx` calls.


---

## [0.2.5] — 2026-05-24

### Changed

- **Version Sync Lock Automation** — Updated the `version-sync` target in the `Makefile` to automatically run `npm i --legacy-peer-deps`. This guarantees that `package-lock.json` is updated and synchronized instantly with new version bumps.
- **README Layout Refinements** — Re-ordered the Installation headers in `README.md` to feature global NPM installation and Zero-Installation (via `npx`) prominently at the top. Clarified the project description by noting MapXGraph is also referred to as MapX.

---

## [0.2.4] — 2026-05-24

### Added

- **Scoped Package Installation Instructions** — Updated global installation documentation to use the scoped package name `@mgamil/mapx`.
- **Zero-Installation via npx** — Documented instant usage and server configuration templates using `npx @mgamil/mapx` across `README.md`, `docs/getting-started.md`, and `docs/mcp-integration.md`.
- **Tracked `package-lock.json`** — Removed `package-lock.json` from `.gitignore` to ensure it is committed to the repository. This fixes missing lockfile failures in GitHub Actions setup caching and `npm ci`.

### Changed

- **Peer Dependency Compatibility** — Appended `--legacy-peer-deps` to installation commands in `Makefile` and `publish-npm.yml` workflow to automatically bypass upstream peer dependency conflicts.

---

## [0.2.3] — 2026-05-23

### Added

- **Vue parser delegation support** — Added a custom `VueParser` that extracts `<script>` and `<script setup>` blocks and delegates parsing to the `TypeScriptParser`, which allows fully extracting symbols and references inside Vue 2 and Vue 3 Single File Components (SFCs).
- **Import resolution for Vue** — Enhanced `resolveImportPath` to support `.vue` and `/index.vue` candidates, enabling correct resolution of implicit and explicit imports of Vue components.
- **Line number offsetting** — Remapped all symbol and reference line numbers within Vue files relative to their original SFC offsets.
- **`@/` alias resolution in Vue components** — Added support for `import "@/..."` target paths pointing to the `src/` directory within Vue Single File Components (SFCs).
- **Force scan option (`--force`)** — Added a `--force` option to the `scan` command to bypass the incremental parse caching and force re-parsing of all files (useful when parser or import resolver logic changes).
- **Web Dashboard UI integration** — Bundled and served compiled Web Dashboard UI assets directly from packaged native binaries. Updated local/system installation targets and the release packaging workflow to ensure the `ui` assets folder is correctly bundled and placed in share directories.
- **Programmatic ESM entry point** — Added `main`, `module`, `types`, and `exports` mapping in `package.json` to allow clean programmatic consumption of Mapx classes and helpers in external Node.js/TypeScript environments.
- **TypeScript Declarations Generation** — Configured `tsup` to generate `.d.ts` declaration files for all codebase modules, resolving import typing errors.

### Changed

- **Package Lifecycle Hook** — Moved build tasks from `prepublishOnly` to the standard `prepare` lifecycle hook to guarantee clean builds for Git installations, local packing (`npm pack`), and dry-runs.
- **NPM Publication Exclusions** — Updated `.npmignore` to ignore platform-specific local compiled binary builds (`dist/mapx-*`) to prevent accidental bulk bundling.
- **Excluded Web UI from tsup compiler** — Prevented tsup from processing browser-only Web UI client files (which contain DOM references), avoiding type-compilation errors during build.
- **CI/CD Workflow Enhancements** — Enabled dependency caching in `publish-npm.yml` to speed up builds and cleaned up scripting commands by using `npm run build:wasm`.

### Fixed

- **Type-safe Reference Resolution** — Added type-checking guards for target and symbol names inside reference resolution helpers (`resolveRequirePath`, `resolveImportPath`, `resolveSymbolToFile`) and language parser engines (PHP, generic WASM parser) to prevent crashes when encountering null, undefined, or non-string reference targets during database scans.
- **Workflow Release Security Guard** — Added strict git tag verification to the publish workflow to ensure the triggering release tag matches the declared version in `package.json`.

---

## [0.2.2] — 2026-05-23

### Added

- **Extended UI Metrics Dashboard** — The Web UI Metrics page is now fully aligned with the CLI `status` command, rendering detailed, harmonized cards.
  - `/api/metrics` JSON payload extended to return `totalEdges`, `verifiedEdges`, `inferredEdges`, `languages` breakdown, `symbolKinds` aggregation, `edgeTypes` aggregation, `avgEdgesPerFile`, `dbSize`, and a detailed `git` status object.
  - Metrics view updated with new dedicated cards for **Language Breakdown**, **Symbol Kinds Breakdown**, **Dependency & Edges**, and **Storage & Git Status** (complete with icons and status colors).
- **Expanded PageRank Lists** — Increased the number of returned items for Top Files (PageRank) and Top Symbols (PageRank) from 5 to 10 in both the API response and web dashboard.
- **Framework-aware ignored symbols** — Parsers now automatically skip noisy framework-specific symbols (e.g. Vue's `ref`, `computed`, `watch`, `defineComponent`, `useRouter`, `t`, etc.) when the project is detected as using that framework. This prevents low-value super-nodes from polluting the code graph, skewing PageRank, and creating noise in impact analysis
  - Centralized `IGNORED_SYMBOLS_BY_FRAMEWORK` registry in `src/parsers/ignored-symbols.ts` — keyed by `FrameworkDetector.name`, making it trivial to add ignored sets for React, Laravel, Angular, or any other framework
  - `buildIgnoredSymbols()` helper merges active framework sets into a single `Set<string>` passed once per scan pass via parser options
  - Integrates with existing `FrameworkRegistry.detectActiveFrameworks()` — no ad-hoc detection, frameworks are detected before the parsing loop using the same detector infrastructure used for routes/hooks
  - Both symbol extraction and reference/edge creation respect the ignored set, preventing orphaned inferred edges
  - Vue ecosystem coverage includes: Composition API, Vue Router, Pinia, Vue I18n (`t`, `te`, `tm`, etc.), and Nuxt/VueUse utilities
- **Makefile completeness** — Added missing targets to align with all CLI commands:
  - `sync` — Alias for `update` (incremental scan)
  - `metrics` — Show coupling/instability metrics (`make metrics [l=lang]`)
  - `edges` — Query dependency edges (`make edges [from=file] [to=file]`)
  - `lang-install` / `lang-uninstall` — Install/remove language support (`make lang-install l=ruby`)
  - `workspaces-add` / `workspaces-remove` — Register/remove repos (`make workspaces-add p=/path`)
  - `agents-update` — Update existing agent integration files
- **Cross-process Tool Call Logging in Web UI** — Persistent logging of MCP tool calls to `.mapx/tool-calls.jsonl` enables the Tool Call Log tab in the Web UI dashboard to correctly capture and display MCP tool calls even when the MCP server and Web UI are running in separate processes
  - UI server reads/serves historical logs via `/api/tool-calls` endpoint and tails new logs for real-time pushing via SSE
  - UI client renders status badges, execution durations, parameters, and error details with robust client-side deduplication
- **Dynamic Graph Node Sizing & Spacing** — Graph nodes in the Graph Explorer are now dynamically sized based on their degree (scaling from `32px` baseline up to `48px`). The layout was enhanced with dynamic `nodeRepulsion` and `idealEdgeLength` functions in `cose` layout, and scaled-up layout circles in cluster mode to give larger nodes more spacing and prevent overlap.
- **Top-Aligned Node Labels and Rendering Hierarchies** — Standard file node labels are now top-aligned with negative margins. Explicitly configured a z-index hierarchy (`z-index: 10` on nodes, `1` on edges) as a precaution so labels are always rendered on top of edges.
- **Verbose MCP Debug Mode** — Added `--debug` flag to `mapx serve` CLI command to log verbose MCP calls, including request names, arguments, duration, and completion success/error details to stderr.

### Changed

- `GenericWasmParser.parse()` now checks `options.ignoredSymbols` (a `Set<string>`) to filter symbols and references — fully data-driven, no per-parser subclass overrides needed
- Scanner's `parseFilesParallel` / `parseOnMainThread` now accept an optional `ignoredSymbols` set instead of framework-specific boolean flags
- Graph node selection in the Web UI preserves dynamic size instead of resetting to a hardcoded size.
- Improved graph interaction with optimized wheel sensitivity (`3.2`) and degree capping.
- Enhanced tool call log tailing in the UI server: added `fs.watch` for instant, near-real-time updates, and reduced fallback polling interval to 500ms for robust periodic checks.

### Fixed

- **SVG Exporter Type-Safety** — Resolved outstanding typecast compilation errors in `src/exporters/svg-exporter.ts` to make the workspace compile cleanly and remain 100% type-safe.

---

## [0.2.1] — 2026-05-23

### Added

- **`mapx uninit` command** — Fully reverse a `mapx init`: removes `.mapx/` directory, reverts LLM agent integration files (sentinel-block cleanup in AGENTS.md, .cursor/rules/mapx.mdc, etc.), removes `.mapx/` from `.gitignore`, and cleans up empty directories
  - `-f, --force` flag to skip confirmation prompt
  - Added `uninit` to package.json scripts and Makefile targets
- **Agentic MCP auto-configuration** — `mapx init` now auto-detects installed agent tools and generates MCP server config files so mapx is immediately discoverable as an MCP server with all 25 tools:
  - **opencode** → `opencode.json` (detected via `opencode.json` or `opencode.jsonc`)
  - **Gemini CLI** → `.gemini/settings.json` (detected via `.gemini/` directory)
  - **Cursor** → `.cursor/mcp.json` (detected via `.cursor/` directory)
  - **VS Code** → `.vscode/mcp.json` (detected via `.vscode/` directory)
  - **Antigravity** → `.agents/mcp.json` + `.agents/rules/mapx.md` (detected via `.agents/` directory)
- **`mapx agents mcp` subcommand** — Manual control over MCP config generation:
  - `--detect` — Show detected agent tools without writing files
  - `--all` — Generate configs for all supported tools
  - `--tools <list>` — Target specific tools (e.g. `--tools opencode,gemini-cli`)
  - `--dry-run` — Preview actions without writing
- **Smart JSON config merging** — When a config file already exists (e.g. `.vscode/mcp.json` with other settings), mapx merges its MCP entry without overwriting existing config. On `uninit`, only the mapx entry is removed; if the file becomes empty, it is deleted entirely
- **`--no-mcp-configs` flag on `mapx init`** — Skip MCP config auto-generation if not desired
- **Antigravity provider template** (`antigravity`) — Generates `.agents/rules/mapx.md` with pre-planning initialization rules following the Antigravity `.agents/rules/` pattern:
  - Forces `mapx_sync` + `mapx_export` before any planning or reasoning
  - Pre-modification impact analysis via `mapx_impact` and `mapx_callers`
  - Post-modification re-indexing via `mapx_sync`
  - Fail-safe halt on MCP initialization errors
- **`mapx uninit` MCP cleanup** — Removes mapx entries from all MCP config files during uninit, with smart handling: deletes files that only contained mapx, or surgically removes just the mapx entry from shared configs

### Changed

- Updated `mapx agents list` to show the new `antigravity` provider (`.agents/rules/mapx.md`)
- Updated `mapx init` interactive provider selection to include `antigravity` as an option
- Updated README "Agentic Integration" section with auto-detection table and usage examples
- Updated CLI reference docs with `--no-mcp-configs`, `agents mcp` command, and Antigravity target
- Updated MCP integration docs with Antigravity configuration example

---

## [0.2.0] — 2026-05-23

### Added
- Added built-in network density and transitivity metric calculations in Metrics tab and `/api/metrics` API endpoint.
- Redesigned Context Builder with task-relevance BFS shortest-path distance scoring, filename keyword boosts, symbol name keyword boosts, and a PageRank fallback mechanism.
- Added styled fallback placeholders for empty layouts across all UI pages (Graph, Symbols, Routes/Hooks, Metrics, and Tool Log).

### Changed
- Rebuilt Symbol Explorer with a sticky right panel layout (`position: sticky`) and confined pre-formatted code blocks with custom scrollbars.
- Updated Symbol Explorer search filter to match against both symbol name and partial file paths.
- Fixed a routes & hooks subtab toggle bug that caused panels to blank out during navigation.

### Added (I18 — Token Cost Benchmarking Suite)
- Added `mapx bench` built-in benchmarking suite for comparing LLM agent token consumption (baseline workspace reads vs MapX MCP tools)
- Added `benchmarks/run.ts` CLI runner with JSON output support (`--json`) and model pricing analysis
- Added `bench` and `bench-json` Makefile targets and npm scripts
- Added comprehensive Token Consumption Benchmarks section to README showing 87% average cost reduction

### Added (I16 — Audit Compliance Fixes)
- Added `mapx_workspaces` MCP tool with `list` and `discover` actions for workspace introspection
- Added `mapx workspaces discover` CLI subcommand for read-only repository discovery
- Added `--cluster` (`none`|`auto`) and `--depth` flags to `mapx export` for DOT/SVG cluster control
- Added `toon` to `mapx_export` MCP format enum
- Updated MCP `generateConfigs()` available tools list to include all 25 tools

### Changed (I16 — Audit Compliance Fixes)
- Fixed language tier alignment: Python/Go/Rust/Java/C# promoted to `built-in`; Ruby/C/C++/Swift/Kotlin/Scala/Dart/Vue promoted to `bundled` with relative WASM paths
- Vue language support changed from `installable` to `bundled`

### Added (I17 — Comprehensive Language Syntax Coverage)
- Expanded tree-sitter symbol and reference queries for all 20 languages (Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Dart, Scala, Vue, Svelte, Lua, Elixir, Zig, Bash, Pascal)
- Python: added constant symbols; expanded references with dotted inheritance, decorators, type annotations
- Go: added constant, namespace (package), property (var), type alias symbols; added interface embedding refs
- Rust: added impl, const, static, type alias, module, macro, enum variant symbols; added trait impl, scoped path, macro invocation refs
- Java: added field, constant, annotation type, enum constant, namespace (package) symbols; added extends, implements, annotation refs
- C#: added property, constant, namespace, record, delegate, event, enum member symbols; added inheritance, attribute refs
- Ruby: added module, constant, property (attr_*) symbols; added require, include/extend/prepend, inheritance, instantiation refs
- C: added enum, typedef, macro, union symbols; added #include refs
- C++: added namespace, enum, template, type alias symbols; added #include, inheritance, new instantiation refs
- Swift: added protocol, enum, extension, property, typealias symbols; added import, conformance, instantiation refs
- Kotlin: added object, property, enum entry symbols; added import, delegation extends/implements, instantiation refs
- Dart: added enum, mixin, extension, constructor, const/final symbols; added export, extends, implements, with, instantiation refs
- Scala: added trait, val, var, type alias, package symbols; added wildcard imports, extends, instantiation refs
- Vue: added class, method, property, arrow function symbols; added imports, member expression calls, Composition API tracking
- Svelte: added class, method, exported props, arrow functions, const symbols; added imports, member calls, lifecycle/store API tracking
- Lua: added method, local function, variable symbols; added require, dot-index/method calls
- Elixir: added defp, defmacro, defstruct, defprotocol, module attr symbols; added alias, import, use, require, remote calls, pipe, defimpl refs
- Zig: added struct, const, test, error set symbols; added @import, method call refs
- Bash: added variable assignment, alias symbols; added source/. includes, command substitution refs
- Pascal: added class, record, interface, method, constant, unit, variable, enum symbols; added uses, extends, instantiation refs
- Updated `nodeMappings` in `registry.ts` for all 20 languages

### Added (Misc)
- `mapx init` now auto-adds `.mapx/` to `.gitignore` when project is a git repo or `.gitignore` exists

### Added (I15 — Web Dashboard)
- Added `mapx ui` command — bundled lightweight web dashboard for graph visualization

### Added (I14 — TOON Export)
- Added `mapx export --format=toon` — TOON compact export format with delimiter and key-folding options

### Added (I13 — Framework Routes)
- Added framework-aware parsing for 21 frameworks (Laravel, Express, Next.js, Django, Flask, FastAPI, Spring, ASP.NET, Rails, Gin, Echo, Fiber, Actix, Rocket, Symfony, Yii2/Yii3, WordPress, Vue Router, React Router, SvelteKit, Nuxt)

### Added (I12 — Language Expansion)
- Added support for 14 additional languages beyond PHP/JS/TS: Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Svelte, Vue, Dart, Scala
- Added 8 installable languages: Lua, Elixir, Zig, Bash, Pascal, and more
- Added `mapx lang list`, `mapx lang install`, `mapx lang uninstall` commands

### Added (I11 — Smart Context & Search Tools)
- Added `ContextBuilder` API for intelligent, token-budgeted prompt context generation
- Added 7 new MCP tools: `mapx_search`, `mapx_context`, `mapx_callers`, `mapx_callees`, `mapx_impact`, `mapx_node`, and `mapx_files`
- Added 6 new CLI commands: `mapx search`, `mapx callers`, `mapx callees`, `mapx impact`, `mapx node`, and `mapx files`
- Enhanced `mapx status` CLI and `mapx_status` MCP tool with language breakdown, PageRank top files/symbols lists, and Git stale index detection with upgrade recommendations

### Added (I10 — Git & Workspace Awareness)
- Added multi-repository workspace support: `mapx workspaces add/remove/list/sync`
- Added `mapx_workspaces` MCP tool for workspace management
- Added cross-repo edge detection and tracking

### Added (I09 — LLM Integration)
- Added MCP server with stdio and SSE transports: `mapx serve`

### Added (I08 — Data Flow Tracing)
- Added `mapx trace`, `mapx sources`, `mapx sinks` commands
- Added `mapx_trace`, `mapx_sources`, `mapx_sinks` MCP tools
- Added `FlowTracer` with configurable max-depth and deterministic clustering

---

## [0.1.6] — 2026-05-22

### Changed
- Full rebrand from `codegraph` to `mapx` across all CLI commands, MCP tools, storage paths, class names, and documentation
  - CLI binary renamed: `codegraph` → `mapx`
  - Storage directory renamed: `.codegraph/` → `.mapx/`
  - Database renamed: `codegraph.db` → `mapx.db`
  - MCP server name: `codegraph` → `mapx`
  - MCP tools: `codegraph_*` → `mapx_*`
  - TypeScript class `CodeGraph` → `MapxGraph`
  - TypeScript type `CodeGraphConfig` → `MapxConfig`
  - All build artefacts, installer scripts, and docs updated

---

## [0.1.5] — prior release

_Changelog entries not yet backfilled. See git log for history._

---

## [0.1.4] — prior release

_Changelog entries not yet backfilled. See git log for history._

---

<!-- Links (keep at the bottom) -->
[Unreleased]: https://github.com/MohamedGamil/mapx/compare/v0.3.8...HEAD
[0.3.8]: https://github.com/MohamedGamil/mapx/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/MohamedGamil/mapx/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/MohamedGamil/mapx/compare/v0.3.5...v0.3.6
[0.3.4]: https://github.com/MohamedGamil/mapx/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/MohamedGamil/mapx/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/MohamedGamil/mapx/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/MohamedGamil/mapx/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MohamedGamil/mapx/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/MohamedGamil/mapx/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/MohamedGamil/mapx/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/MohamedGamil/mapx/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/MohamedGamil/mapx/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/MohamedGamil/mapx/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/MohamedGamil/mapx/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MohamedGamil/mapx/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MohamedGamil/mapx/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/MohamedGamil/mapx/compare/v0.1.6...v0.1.9
[0.1.6]: https://github.com/MohamedGamil/mapx/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/MohamedGamil/mapx/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/MohamedGamil/mapx/releases/tag/v0.1.4
