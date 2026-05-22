# Iteration Log

Chronological record of all iterations: when they were started, completed, what was in scope, and what changed mid-flight.

---

## Template

```
## IXX — <title>

| Field | Value |
|-------|-------|
| Status | planned / in-progress / in-review / done / deferred |
| Started | YYYY-MM-DD |
| Completed | YYYY-MM-DD |
| Features | FXX, FXX |
| Branch | feat/iXX-<slug> |
| PR | #NNN |

### Scope
<!-- One paragraph on what this iteration delivers. -->

### Changes from original spec
<!-- List any decisions made during implementation that deviated from the spec. -->

### Blockers / notes
<!-- Anything that slowed this down or should inform the next iteration. -->
```

---

## I01 — Schema migration + parser edge labelling

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F01 |
| Branch | `feat/i01-edge-verifiability` |
| PR | — |

### Scope

Adds an `verifiability` column (`verified` \| `inferred`) to the `edges` SQLite table. Updates the PHP, JavaScript, and TypeScript parsers to label method calls and dependency edges at parse time. Introduces a common-method filter list so generic framework method names default to `inferred`.

### Changes from original spec

_None yet._

### Blockers / notes

_None yet._

---

## I02 — Glob filter pipeline in scanner

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F03 |
| Branch | `feat/i02-glob-filters` |
| PR | — |

### Scope

Extends `mapx scan` and `mapx export` with `--include` and `--exclude` glob pattern flags. Pattern matching is applied in the file-discovery walk before any file is read or parsed, so excluded files incur zero I/O cost. Patterns are also persisted in `.mapx/config.json` as project-level defaults.

### Changes from original spec

_None yet._

### Blockers / notes

_None yet._

---

## I03 — CLI + MCP surface (`metrics`, `edges`)

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F02, F04 |
| Branch | `feat/i03-metrics-edges` |
| PR | — |

### Scope

Implements two new CLI subcommands and their corresponding MCP tools:

- `mapx metrics` / `mapx_metrics` — coupling report (in-degree, out-degree, instability, afferent/efferent coupling)
- `mapx edges` / `mapx_edges` — neighbourhood query for a single file

F02 (`metrics`) depends on the `verifiability` column introduced in I01. F04 (`edges`) is independent.

### Changes from original spec

_None yet._

### Blockers / notes

Depends on I01 being merged before the `--verified-only` flag in `mapx metrics` can be implemented.

---

## I04 — PHP Parser Fundamentals

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F05, F06, F10 |
| Branch | `feat/i04-php-fundamentals` |
| PR | — |

### Scope

Fixes the critical baseline gaps in the PHP parser before any Laravel-specific logic is added. Three features are bundled: (F05) capture fully-qualified names from `use` import declarations instead of only the final name segment; (F06) extract constructor injection, method parameter, and return-type edges as `param_type`/`return_type` edge types; (F10) add Laravel project detection to `mapx init` and default exclusion patterns for migrations, seeders, factories, `bootstrap/cache`, and Blade template files.

### Changes from original spec

_None yet._

### Blockers / notes

F05 is a prerequisite for all of I05 — the use-import table it builds is consumed by F07, F08, and F09. I04 should be merged before I05 work begins.

---

## I05 — Laravel Structural Patterns

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F07, F08, F09 |
| Branch | `feat/i05-laravel-structural` |
| PR | — |

### Scope

Adds parser support for the three structural patterns that define every Laravel application architecture: (F07) Eloquent relationship edges (`hasMany`, `belongsTo`, etc.) from models to related models; (F08) route-to-controller binding edges from route files to controller classes and methods; (F09) IoC container binding edges from service providers, mapping abstract interfaces to concrete implementations.

### Changes from original spec

_None yet._

### Blockers / notes

Depends on I04 being fully merged — all three features rely on the use-import table from F05 to resolve `::class` constant arguments to FQNs.

---

## I06 — Laravel Advanced Patterns

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F11, F12 |
| Branch | `feat/i06-laravel-advanced` |
| PR | — |

### Scope

Completes the Laravel graph layer with two advanced patterns: (F11) facade resolution — a post-parse edge rewriting step that maps static `Cache::`, `DB::`, `Log::` calls to their underlying service FQNs using a built-in 26-entry facade map (extendable via config); (F12) event/job/notification dispatch edges — new `dispatch` and `notify` edge types capturing the various async dispatch forms (`event()`, `X::dispatch()`, `->notify()`, `Notification::send()`).

### Changes from original spec

_None yet._

### Blockers / notes

Depends on I05 being merged. F11 and F12 are independent of each other within I06 and can be developed in parallel. The `$listen` array parsing in `EventServiceProvider` is a stretch goal in F12 — may slip to I07 if tree-sitter query complexity is too high.

---

## I07 — npm Distribution & Node.js Developer Experience

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F13 |
| Branch | `feat/i07-npm-distribution` |
| PR | — |

### Scope

Adds an npm-compatible build pipeline so that Node.js developers can install mapx with `npm install -g mapx` or run it with no prior installation via `npx mapx`. The core changes are: (1) add `tsup` to transpile TypeScript to JS preserving directory structure (required for WASM path resolution to work correctly in the installed package); (2) update `package.json` with `bin`, `files`, `engines`, promote `better-sqlite3` to a regular dependency; (3) add a GitHub Actions workflow that automatically publishes to npm on version tag push with npm provenance for supply chain transparency. No parsing, graph, or export logic is changed — the Node.js runtime path already exists in the codebase via `NodeStore`.

### Changes from original spec

_None yet._

### Blockers / notes

Fully independent of I01–I06. Can be merged at any time. Requires a one-time setup by the repository maintainer: create npm account, generate automation token, configure `NPM_TOKEN` secret in GitHub repository settings, verify package name availability, and perform the first manual `npm publish --access public`.

---

## I08 — Code Structure, Clusters & Data Flow

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F14, F15, F16 |
| Branch | `feat/i08-clusters-and-flow` |
| PR | — |

### Scope

Adds structural intelligence and data-flow tracing to mapx. Three capabilities:

1. **F14 — Cluster detection**: infer logical modules/domains from namespace declarations (PHP, TypeScript), directory hierarchy, and edge-density community detection (Label Propagation). Clusters are persisted to a new schema v4 SQLite schema and exposed via `mapx clusters`.

2. **F15 — Cluster-aware export**: DOT `subgraph cluster_*` rendering, SVG cluster bounding boxes, LLM `## Structure` section, JSON `clusters` array. New `--cluster` and `--depth` flags on `mapx export`. Fully backward-compatible — default `--cluster none` produces identical output to current.

3. **F16 — Data flow tracing**: `mapx trace <symbol>` follows data-bearing edges (`call`, `instantiation`, `param_type`, `return_type`, `relation`, `dispatch`, `notify`, `route`) forward and backward through the graph. Detects cycles, identifies entry points (sources) and terminal consumers (sinks). Outputs text trees, DOT subgraphs, and JSON.

### Recommended implementation order

1. F14 (cluster engine + schema) — all other I08 work benefits from this
2. F16 (flow tracer) — can be developed in parallel with F14 since it reads existing `edges` table
3. F15 (cluster export) — depends on F14 cluster data being populated

### Changes from original spec

_None yet._

### Blockers / notes

Independent of I01–I07. F14 benefits from F05 (accurate PHP namespace parsing) but is not blocked by it. F16 traces are richer when F07–F12 Laravel edges (`dispatch`, `route`, `relation`) are present but will function correctly without them.

---

## I09 — LLM Agent Integration Files

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F17 |
| Branch | `feat/i09-llm-integration-files` |
| PR | — |

### Scope

Adds the `mapx agents` command group and provider-specific LLM integration file generation. When a developer installs mapx and runs `mapx init`, they are offered an interactive menu to select which LLM/agentic tools they use. mapx then generates correctly formatted, provider-specific integration files (`CLAUDE.md`, `.cursor/rules/mapx.mdc`, `.github/copilot-instructions.md`, etc.) that teach those tools how to use mapx for the current project.

The 10 supported providers are: Generic/Amp/Devin/OpenCode, Claude Desktop, Cursor, GitHub Copilot, Windsurf, Cline, Aider, Gemini CLI, Continue, and Zed.

All generated files contain a `<!-- mapx VERSION TIMESTAMP -->` / `<!-- /mapx -->` sentinel block. `mapx agents update` detects stale blocks and refreshes them in-place, preserving any user content outside the block. Files that append to shared instruction files (`.clinerules`, `.github/copilot-instructions.md`) never overwrite existing content.

### Changes from original spec

_None yet._

### Blockers / notes

Fully independent of all other iterations. Can be merged at any time. No schema changes required. No new MCP tools (deferred to avoid security surface of MCP tools writing files).

---

## I10 — Git Workspace & Submodule Awareness

| Field | Value |
|-------|-------|
| Status | `completed` |
| Features | F18 |
| Branch | `feat/i10-git-workspace-awareness` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| PR | — |

### Scope

Fixes mapx's assumption that a project is always a single git repository. Adds `WorkspaceManager` — auto-discovers `.gitmodules`, VS Code `.code-workspace` folders, and optionally sibling git repos. Registers each as an independent `RepoConfig` entry. Scanner is updated to iterate repos independently, calling `getGitBlobHashes()` with each repo's own git root (fixing incremental scan accuracy for submodules). Adds `mapx workspaces` CLI command group, `--all` flags on `scan`/`update`/`status`/`export`, and `mapx_workspaces` MCP tool. Cross-repo edges stored with `target_repo` field via a schema migration.

### Changes from original spec

_None yet._

### Blockers / notes

Independent of all other iterations. Cross-repo FQN edge resolution is richer when I04/I05 (PHP namespace resolution) are merged, but F18 functions correctly without them. Bumps schema version to v5, building on top of the schema v4 changes from I08.

---

## I11 — Smart Context & Search Tools

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F19 |
| Branch | `feat/i11-smart-context-tools` |
| PR | — |

### Scope

Adds 7 new MCP tools and 6 new CLI commands that give LLMs symbol-level precision tools for navigating the code graph. Core new capability: `mapx_context` — a smart context builder that takes a natural-language task description, expands through the graph using keyword matching + PageRank weighting, and returns a focused, token-efficient context block. Supporting tools: `mapx_search` (filtered symbol search), `mapx_callers`/`mapx_callees` (call graph traversal), `mapx_impact` (transitive blast-radius with HIGH/MEDIUM/LOW risk), `mapx_node` (symbol details + optional source code), `mapx_files` (indexed file list with filters). The existing `mapx_status` tool is enhanced with language breakdown, top symbols, and stale detection. No schema changes — all queries work against existing `files`, `symbols`, and `edges` tables. New `src/core/context-builder.ts` added.

### Changes from original spec

_None yet._

### Blockers / notes

Fully independent of all other iterations. No schema changes required. `mapx_context` quality improves when F14 cluster data is available (clusters used as context grouping signals) and when F07/F08/F12 Laravel edges are present (richer call graph). `mapx_query` is kept as a backward-compatible alias for `mapx_search`.

---

## I12 — Language Expansion (19 languages)

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F20 |
| Branch | `feat/i12-language-expansion` |
| PR | — |

### Scope

Extends mapx from 3 supported languages (PHP, JavaScript, TypeScript) to 22 by adding tree-sitter-based parsing for Python, Go, Rust, Java, C# (Tier 1 — built-in); Ruby, C, C++, Swift, Kotlin, Scala, Dart (Tier 2 — bundled); and Svelte, Vue2/Vue3, Lua/Luau, Elixir, Zig, Bash/Shell, Pascal/Delphi (Tier 3 — installable via `mapx lang install`). Core architectural change: `GenericWasmParser` base class replaces boilerplate per-language parser classes. New `mapx lang install / uninstall / list / info` commands for on-demand grammar management. No schema changes.

### Changes from original spec

_None yet._

### Blockers / notes

Fully independent of all other iterations. The biggest risk is scope-tracking correctness for languages where method scope requires AST traversal beyond direct parent (Go receivers, Rust impl blocks). Svelte and Vue parsers are most complex due to multi-part file structure. `tree-sitter-pascal` is less maintained — fall back gracefully if grammar quality is poor.

---

## I13 — Framework-Aware Parsing & Route Context

| Field | Value |
|-------|-------|
| Status | `in-progress` |
| Started | 2026-05-23 |
| Completed | — |
| Features | F21, F22, F23, F24, F25 |
| Branch | `feat/i13-framework-routes` |
| PR | — |

### Scope

Adds framework-specific route extraction for 21 web frameworks across 9 language ecosystems. A shared `FrameworkDetector` interface and `RouteRegistry` (F21) power all detectors. Python ecosystems (Django, Flask, FastAPI) are covered by F22; Node.js/TypeScript backends (Express, NestJS) by F23; frontend routing (React Router v6, Tanstack Router, Next.js, SvelteKit) by F24; the remaining backends (Laravel extended, Drupal, Rails, Spring Boot, Gin/chi/gorilla/mux, Axum/actix-web/Rocket, ASP.NET Core, Vapor) by F25; and PHP CMS/frameworks (Symfony, Yii2/Yii3, WordPress) by F26. The new `mapx routes` CLI command and `mapx_routes` MCP tool surface extracted routes; the new `mapx hooks` command and `mapx_hooks` MCP tool surface hook/filter/event registrations. Schema v6 adds a `metadata TEXT` column to the `edges` table for route-specific data (HTTP method, path, framework, confidence).

Four new `ReferenceType` values are introduced: `hook` (Drupal hook implementations), `graphql_resolver` (NestJS @Query/@Mutation), `message_handler` (NestJS @MessagePattern), `websocket_handler` (NestJS @SubscribeMessage).

### Changes from original spec

_None yet._

### Blockers / notes

F21 (infrastructure) must be merged before any of F22–F25 can proceed. F22–F25 are independent of each other once F21 is available. All framework detectors use regex-based extraction rather than tree-sitter AST — this means F25's Go/Rust/Java/C#/Swift/Ruby detectors do not require I12 language parsers to be merged first. Laravel extended support (F25) builds on the F08 route extractor refactored in F21; F21 must be merged before F25 Laravel work starts.

---

## I14 — TOON Export Format

| Field | Value |
|-------|-------|
| Status | `done` |
| Started | 2026-05-22 |
| Completed | 2026-05-22 |
| Features | F27 |
| Branch | `feat/i14-toon-export` |
| PR | — |

### Scope

Adds `toon` as a first-class export format alongside the existing `llm`, `json`, `dot`, and `svg` formats. TOON (Token-Oriented Object Notation, spec v3.3) is a line-oriented, indentation-based format with the same data model as JSON but significantly fewer tokens — making it well-suited for LLM consumption of the mapx graph. The exporter serialises files, symbols, and edges as tabular TOON arrays, respects the `--tokens` budget with truncation and a `truncated:` footer, and supports optional `--delimiter=tab|pipe` and `--key-folding` flags. A new `ToonExporter` class is added to `src/exporters/toon-exporter.ts`, exported from `src/exporters/index.ts`, and wired into the `mapx export` CLI command and the `mapx export --format=toon` MCP path.

### Changes from original spec

_None yet._

### Blockers / notes

Fully independent — can be merged at any time. The exporter uses a manual TOON encoder (no external runtime dependency). The reference TOON npm package (`@toon-format/toon`) is added as a `devDependency` only, for round-trip validation in tests.

---

## I15 — Bundled Web Dashboard

| Field | Value |
|-------|-------|
| Status | `done` |
| Features | F28 |
| Branch | `feat/i15-web-dashboard` |
| PR | — |

### Scope

Adds a lightweight, self-contained web dashboard that can be optionally served alongside the existing MCP server or standalone via `mapx ui`. The dashboard provides six panels: an Overview/Status bar, a Graph Explorer (interactive force-directed graph of files and edges via Cytoscape.js), a Symbol Explorer (searchable/sortable table), a Tool Call Log (live SSE stream of MCP tool calls), a Metrics Panel (PageRank, coupling, edge-type charts via uPlot), and a Context Viewer (task-based context building powered by F19 when available). The server path uses Node.js built-ins only (no Express). The client bundle targets < 200 KB gzipped. MCP tool calls are intercepted by a thin timing shim in `src/mcp.ts` that emits to a shared `UiEventBus`; if no dashboard is active the events are silently dropped.

New source files: `src/ui-server.ts`, `src/ui-events.ts`, `src/ui/` (client source), `scripts/build-ui.ts`. Dashboard assets are compiled to `dist/ui/` and shipped in the npm package. Set `MAPX_NO_UI=1` to skip the client build in CI.

### Changes from original spec

_None yet._

### Blockers / notes

Depends on I07 (F13) for npm packaging infrastructure. All other feature dependencies (F02, F14–F16, F18, F19, F21–F26) are optional — the dashboard degrades gracefully when their data is absent. The largest implementation risk is bundle size discipline: Cytoscape.js and layout plugins must be tree-shaken carefully to stay under the 200 KB target.
