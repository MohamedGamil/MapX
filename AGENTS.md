<!-- mapx v0.3.1 -->
# MapxGraph - LLM Integration Guide

This project uses **MapxGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.

## What MapxGraph Does

MapxGraph scans source files across **22 languages**, extracts symbols (classes, functions, methods, interfaces, traits, enums, structs, modules, constants, properties, namespaces) and dependencies (imports, requires, extends, implements, calls, instantiation), builds a weighted graph with PageRank importance scoring, and persists everything to `.mapx/`. It also indexes static files (Markdown, HTML, CSS/SCSS, JSON/JSONC/JSON5) for dependency tracking without symbol extraction.

This means you (the LLM) can quickly understand the codebase structure without reading every file.

## Commands

All commands accept a target directory. Three ways to specify:

```bash
# 1. Positional path argument
mapx scan /path/to/project

# 2. --dir / -d flag
mapx scan --dir /path/to/project
mapx query "MyClass" -d /path/to/project

# 3. Global flag (works with any subcommand)
mapx -d /path/to/project scan
```

### Available Commands

- `mapx init [path]` - First-time setup (auto-adds .mapx/ to .gitignore, discovers monorepo packages & nested repos)
- `mapx uninit [path]` - Remove .mapx/ and reverse integration changes
- `mapx scan [path]` - Full scan (use `--force` to bypass cache)
- `mapx update [path]` (alias: `sync`) - Incremental update (fast)
- `mapx status [path]` - Check what changed since last scan
- `mapx export [--dir path]` - Export compact graph summary
- `mapx export --format=<fmt>` - Export as `llm`, `json`, `dot`, `svg`, or `toon`
- `mapx export --cluster <mode> --depth <n>` - Cluster-aware DOT/SVG export
- `mapx query <symbol> [--dir path]` - Search for symbols (supports glob patterns: `*Service`, `get*`)
- `mapx search <term> [--dir path] [--kind kind] [--file prefix] [--exact] [--limit limit] [--format text|json]` - Advanced filtered search with auto-expand and fuzzy fallback
- `mapx deps <file> [--dir path]` - Show dependencies for a file (supports glob/wildcard/substring matching)
- `mapx summary [path]` - Project summary
- `mapx clusters [--dir path] [--source source] [--json]` - List detected clusters/modules (filter by source: namespace, directory, community, layer)
- `mapx trace <symbol> [--dir path]` - Trace data flow
- `mapx sources [--dir path]` - Find entry points (data sources) in the codebase
- `mapx sinks [--dir path]` - Find terminal consumers (data sinks) in the codebase
- `mapx context <task> [--dir path] [--seeds seeds] [--tokens budget] [--depth n] [--format fmt]` - Generate task-specific workspace context
- `mapx callers <symbol> [--dir path] [--depth depth]` - Trace callers of a symbol (fuzzy fallback on typos)
- `mapx callees <symbol> [--dir path] [--depth depth]` - Trace callees of a symbol (fuzzy fallback on typos)
- `mapx metrics [path]` - Show coupling and instability metrics for files
- `mapx edges [path] [--type type] [--from file] [--to file]` - Query dependency edges
- `mapx routes [path] [--framework name] [--method verb] [--json]` - Show framework routes
- `mapx hooks [path] [--framework name] [--type type] [--json]` - Show framework hooks
- `mapx profile [path]` - Show codebase profile (archetype, frameworks, active taxonomy)
- `mapx arch [path] [--smells] [--dsm] [--violations] [--json]` - Full architecture and health report
- `mapx explain <file> [--reclassify]` - Explain file role classification signals and weights
- `mapx layers [path] [--json]` - List files grouped by architectural roles/layers
- `mapx impact <symbol> [--dir path] [--depth depth]` - Change impact analysis with fuzzy pre-check
- `mapx node <symbol> [--dir path] [--source] [--format text|json]` - Inspect a symbol node with optional source code
- `mapx files [--dir path] [--path prefix_or_glob] [--lang language] [--sort sort] [--limit limit]` - List and filter files (--path accepts globs: src/core/*.ts, **/*.json)
- `mapx lang list` - List supported languages and status
- `mapx lang install <lang>` - Install dynamic language support
- `mapx lang uninstall <lang>` - Uninstall dynamic language support
- `mapx serve --dir /path` - Start stdio MCP server
- `mapx serve --sse --port <port>` - Start SSE (HTTP) MCP server
- `mapx ui [--port <port>]` - Open web dashboard for interactive visualization
- `mapx workspaces list` - List registered repositories
- `mapx workspaces add <path>` - Register a new repository
- `mapx workspaces discover` - Discover unregistered submodules, peers, VS Code folders, nested git repos (up to 3 levels deep), and monorepo packages
- `mapx workspaces sync` - Auto-register discovered repositories (prompts for nested git repos and monorepo packages)

## MCP Tools

When running as an MCP server, MapxGraph exposes these tools:
- `mapx_scan` - Scan the code graph (full scan)
- `mapx_sync` - Sync changed files to update the graph (incremental scan)
- `mapx_query` - Search symbols by name pattern
- `mapx_search` - Filtered semantic and regex-like symbol search
- `mapx_node` - Deep inspection of a specific symbol and its source code
- `mapx_files` - List and filter files by path prefix or glob pattern, language, and size or line counts
- `mapx_dependencies` - Get deps and reverse-deps for a file
- `mapx_callers` - Direct and nested callers of a symbol
- `mapx_callees` - Direct and nested callees of a symbol
- `mapx_trace` - Trace data flow paths from a starting symbol or file
- `mapx_sources` - Find entry points (sources) in the codebase
- `mapx_sinks` - Find terminal consumers (sinks) in the codebase
- `mapx_routes` - Show framework routes
- `mapx_hooks` - Show framework hooks
- `mapx_edges` - Granular query of graph dependency edges
- `mapx_impact` - Multi-depth blast radius and change risk analysis for a symbol
- `mapx_clusters` - List code clusters/modules
- `mapx_status` - Check scan status, languages breakdown, top PageRank files/symbols, and index recommendations
- `mapx_metrics` - Compute file coupling and instability metrics
- `mapx_profile` - Retrieve codebase profile (archetype, frameworks, active taxonomy)
- `mapx_explain` - Explain file dynamic role classification and weights
- `mapx_smells` - Detect design smells and architectural violations
- `mapx_dsm` - Generate cluster Dependency Structure Matrix (DSM)
- `mapx_layers` - List files grouped by architectural roles/layers
- `mapx_export` - Export compact graph summary (formats: llm, json, dot, svg, toon)
- `mapx_context` - Intelligent, token-budgeted workspace context builder
- `mapx_workspaces` - Retrieve workspace configuration and repositories (list/discover)
- `mapx_lang_list` - List supported languages and status
- `mapx_lang_install` - Install dynamic language support
- `mapx_lang_uninstall` - Uninstall dynamic language support
- `mapx_batch` - Execute multiple operations in a single call (search, node, callers, callees, deps)
- `mapx_agents_generate` - Generate/update agent integration instructions and rules

## When to Use

1. **Start of session**: Run `mapx export` to get a compact overview.
2. **Need to find something**: Run `mapx query <term>` or `mapx search` instead of grepping. Supports glob patterns like `*Service`, `get*`.
3. **Need to understand a file**: Run `mapx deps <file>` to see relationships.
4. **Files changed**: Run `mapx sync` (or `mapx update`) to incrementally update the graph.
5. **Major changes**: Run `mapx scan` for a full re-scan.
6. **Need a visual overview**: Run `mapx export --format=svg -o graph.svg`.
7. **Trace data flow / call chains**: Run `mapx trace <symbol>`, `mapx callers`, or `mapx callees`.
8. **Planning a modification**: Run `mapx impact` to determine the blast radius.
9. **Building custom prompts / context**: Run `mapx context` to generate optimal context within a token budget.
10. **Batch operations**: Use `mapx_batch` (MCP) to execute multiple operations in a single round-trip.
<!-- /mapx -->