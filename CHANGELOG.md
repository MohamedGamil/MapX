# Changelog

All notable changes to MapX are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/).

Unreleased work is tracked under **[Unreleased]**. When a version is released, move its entries from Unreleased and add a release date.

---

## [Unreleased]

### Added
- **Static file indexing**: Markdown (`.md`, `.mdx`, `.markdown`), HTML (`.html`, `.htm`, `.xhtml`), CSS/SCSS/Sass/Less (`.css`, `.scss`, `.sass`, `.less`), and JSON/JSONC (`.json`, `.jsonc`, `.json5`) files are now indexed and included in the dependency graph. No symbol extraction is performed; only outgoing path references (links, `@import`, `url()`, `href`, `src`, `$ref`) are recorded as edges.
- New `'static'` tier in `LanguageDefinition` for index-only languages with no WASM grammar.
- New `StaticFileParser` (`src/parsers/static-file-parser.ts`) with per-language regex extraction. Markdown links are restricted to markdown-only targets to avoid spurious cross-type edges.
- New `Store.resetRepoForScan()` method — wipes files, symbols, outgoing edges, and clusters for a repo in a single transaction while preserving incoming cross-repo edges and scan-time meta keys.
- New `StaticFileParser` test suite (`tests/static-file-parser.test.ts`) — 59 tests covering all four file types, extension variants, edge-case filtering, and registry integration.
- **Nested git repository discovery** — `WorkspaceManager.discoverNestedGitRepos(root, maxDepth=3)` recursively walks the workspace directory up to 3 levels deep, finding any subdirectory that contains a `.git` entry. Common noise paths (`node_modules`, `dist`, `build`, `.cache`, `coverage`, `vendor`, `target`, `.mapx`, etc.) are automatically skipped. Recursion stops at each discovered boundary so inner repos of an already-found repo are not double-reported.
- `mapx workspaces list` now includes a **"Nested git repositories (deep scan)"** section listing any discovered nested repos not yet registered.
- `mapx workspaces discover` includes nested git repos in its output with a `nested-git` source label, and counts them in the total.
- `mapx workspaces sync` prompts the user with an interactive `multiselect` to choose which newly discovered nested repositories to register and scan (submodules/peer repos are still auto-added silently as before).
- `mapx_workspaces` MCP tool `discover` action now includes `{ source: 'nested-git' }` entries for nested repos found by the deep scan.
- New `discoverNestedGitRepos` test suite in `tests/workspace-manager.test.ts` — 10 tests covering depth limits, custom `maxDepth`, skip lists, boundary non-recursion, multi-repo at same level, empty roots, and nonexistent paths.

### Changed
- `*.min.css` added to default `excludePatterns` to avoid indexing minified stylesheets as noise.
- `mapx files --path` now accepts glob patterns (e.g. `src/core/*.ts`, `**/*.json`) in addition to plain path prefixes.
- `mapx deps <file>` now resolves file arguments via glob, wildcard, and substring matching — exact match is tried first, then glob patterns, then substring containment. Multiple matched files are all reported.
- `FlowTracer.resolveStart` (used by `mapx trace`) now resolves file arguments via glob and substring matching in addition to exact/suffix match.
- `mapx_files` MCP tool `path` parameter now accepts glob patterns; the response header says `"matching <glob>"` for glob inputs and `"under <prefix>"` for plain prefix inputs.
- Makefile `files` target now quotes the `--path` argument (`"$(p)"`) to prevent shell glob expansion before the CLI receives it.

### Fixed

- **`.js`-extension imports resolving to `.ts` sources**: TypeScript projects that use the `"moduleResolution": "bundler"` / `"nodenext"` convention of writing `import './utils.js'` when the actual source file is `utils.ts` now resolve correctly. `resolveImportPath` now checks `<stem>.ts` and `<stem>.tsx` as immediate fallback candidates whenever the import specifier ends with `.js` or `.jsx`, **before** trying generic extension appending. A real `.js` file (if present) still takes priority.
- **False Cross-File Dependency Edges** — Fixed a symbol resolution bug in `resolveSymbolToFile` (`src/core/scanner.ts`) where a call to a locally-defined helper (e.g. `cleanQuotes` inside `php.ts`) could resolve to an identically-named symbol in a completely unrelated file (e.g. `express.ts`), creating phantom graph edges. The resolver now checks for a **same-file match first** at every resolution path (exact-name lookup, namespace-stripped fallback, and first-result fallback) before falling back to a global match.
- **`scan --force` stale data**: A forced full re-scan now wipes all existing DB data for the target repo (symbols, edges, files, clusters) and clears any stale interrupted-scan resume state **before** discovery begins. Previously, an interrupted prior scan could cause `--force` to silently skip files it considered already completed, and symbols/edges from deleted or renamed files could persist indefinitely.

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
[Unreleased]: https://github.com/MohamedGamil/mapx/compare/v0.3.0...HEAD
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
