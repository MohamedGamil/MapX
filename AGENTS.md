<!-- mapx v0.4.0 #4fe0c7933788 -->
# MapxGraph - LLM Integration Guide

This project uses **MapxGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.

## What MapxGraph Does

MapxGraph scans source files across **23 languages**, extracts symbols (classes, functions, methods, interfaces, traits, enums, structs, modules, constants, properties, variables, namespaces) and dependencies (imports, requires, extends, implements, calls, instantiation), builds a weighted graph with PageRank importance scoring, and persists everything to `.mapx/`. It also indexes static files (Markdown, HTML, CSS/SCSS, JSON/JSONC/JSON5) for dependency tracking without symbol extraction.

This means you (the LLM) can quickly understand the codebase structure without reading every file.

## Commands

All commands accept a target directory. Three ways to specify:

```bash
# 1. Positional path argument
mapx scan /path/to/project

# 2. --dir / -d flag
mapx export --dir /path/to/project
mapx query "MyClass" -d /path/to/project

# 3. Global flag (works with any subcommand)
mapx -d /path/to/project scan
```

### Available Commands

- `mapx init [path]` - First-time setup (auto-adds .mapx/ to .gitignore, discovers monorepo packages & nested repos)
- `mapx uninit [path]` - Remove .mapx/ and reverse integration changes
- `mapx scan [path]` - Full scan (use `--force` to bypass cache, `--no-parallel` to disable worker threads)
- `mapx update [path]` (alias: `sync`) - Incremental update (fast, use `--no-parallel` to disable worker threads)
- `mapx status [path]` - Check what changed since last scan
- `mapx export [--dir path]` - Export compact graph summary
- `mapx export --format=<fmt>` - Export as `llm`, `json`, `dot`, `svg`, or `toon`
- `mapx export --cluster <mode> --depth <n>` - Cluster-aware DOT/SVG export
- `mapx query <symbol> [--dir path]` - Search for symbols (supports glob patterns: `*Service`, `get*`, and flexible namespace notations: `BillingService::getEffectiveLimits` or `BillingService.getEffectiveLimits`)
- `mapx search <term> [--dir path] [--kind kind] [--file prefix] [--exact] [--limit limit] [--format text|json]` - Advanced filtered search with auto-expand and fuzzy fallback
- `mapx deps <file> [--dir path]` - Show dependencies for a file (supports glob/wildcard/substring matching)
- `mapx summary [path]` - Project summary
- `mapx clusters [--dir path] [--source source] [--json]` - List detected clusters/modules (filter by source: namespace, directory, community, layer)
- `mapx trace [symbol-or-file] [--dir path] [--direction up|down|both] [--depth n] [--include-structural] [--sources] [--sinks] [--include-leaf-libraries]` - Trace data flow, path, entry points (sources), or terminal consumers (sinks)
- `mapx sources [--dir path]` - Find entry points (data sources) in the codebase
- `mapx sinks [--dir path] [--include-leaf-libraries]` - Find terminal consumers (data sinks) in the codebase
- `mapx context <task> [--dir path] [--seeds seeds] [--tokens budget] [--depth n] [--format fmt]` - Generate task-specific workspace context
- `mapx callers <symbol> [--dir path] [--depth depth]` - Trace callers of a symbol (fuzzy fallback on typos)
- `mapx callees <symbol> [--dir path] [--depth depth]` - Trace callees of a symbol (fuzzy fallback on typos)
- `mapx metrics [path] [--top n] [--exclude globs] [--format json]` - Files ranked by coupling (in/out/total degree, instability, PageRank)
- `mapx edges [file] [--direction dir] [--type types] [--format json]` - Incoming and outgoing edges of a file (without a file: --from/--to filtered list)
- `mapx routes [path] [--framework name] [--method verb] [--json]` - Show framework routes
- `mapx hooks [path] [--framework name] [--type type] [--json]` - Show framework hooks
- `mapx profile [path]` - Show codebase profile (archetype, frameworks, active taxonomy)
- `mapx arch [path] [--smells] [--dsm] [--violations]` - Full architecture and health report
- `mapx explain <file>` - Explain file role classification signals and weights
- `mapx layers [path] [--json]` - List files grouped by architectural roles/layers
- `mapx check [path] [--layer name] [--rule rule] [--format json]` - Check the architecture rules in `.mapx/architecture.jsonc` (exit 1 on violations)
- `mapx arch allowed <from> <to> [--json]` - Would a dependency between two files, symbols or layers be allowed? (also `mapx arch layers|which|unassigned|deps|unused|changed`)
- `mapx impact <symbol> [--dir path] [--depth depth]` - Change impact analysis with fuzzy pre-check
- `mapx node <symbol> [--dir path] [--source] [--format text|json] [--include-members]` - Inspect a symbol node with optional source code and member listing
- `mapx files [--dir path] [--path prefix_or_glob] [--lang language] [--sort sort] [--limit limit]` - List and filter files (--path accepts globs: src/core/*.ts, **/*.json)
- `mapx lang list` - List supported languages, extensions and tiers (all grammars are bundled)
- `mapx lang info <lang>` - Show a language's extensions, file names and grammar files
- `mapx serve --dir /path` - Start stdio MCP server
- `mapx serve --sse --port <port>` - Start SSE (HTTP) MCP server
- `mapx ui [--port <port>]` - Open web dashboard for interactive visualization
- `mapx workspaces list` - List registered repositories
- `mapx workspaces add <path>` - Register a new repository
- `mapx workspaces discover` - Discover unregistered submodules, peers, VS Code folders, nested git repos (up to 3 levels deep), and monorepo packages
- `mapx workspaces sync` - Auto-register discovered repositories (prompts for nested git repos and monorepo packages)

## MCP Tools

When running as an MCP server, MapxGraph exposes these tools:
- `mapx_scan` - Scan the code graph (full scan; supports `force` and `parallel` options)
- `mapx_sync` - Sync changed files to update the graph (incremental scan; supports `parallel` option)
- `mapx_query` - Search symbols by name pattern
- `mapx_search` - Filtered semantic and regex-like symbol search
- `mapx_node` - Deep inspection of a specific symbol and its source code (supports `include_members` to list class/interface members)
- `mapx_files` - List and filter files by path prefix or glob pattern, language, and size or line counts
- `mapx_dependencies` - Get deps and reverse-deps for a file
- `mapx_callers` - Direct and nested callers of a symbol
- `mapx_callees` - Direct and nested callees of a symbol
- `mapx_trace` - Trace data flow paths from a starting symbol or file
- `mapx_sources` - Find entry points (sources) in the codebase
- `mapx_sinks` - Find terminal consumers (sinks) in the codebase (supports `include_leaf_libraries` to show filtered leaf libraries)
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
- `mapx_arch_validate_config` - Validate the architecture rules configuration (.mapx/architecture.jsonc): every problem with its JSON pointer
- `mapx_arch_check` - Check the architecture rules against the index (as `mapx check`; filters `layer`, `rule`, `file`, `since`)
- `mapx_arch_layers` - The rule layers, a layer's members and the selector that matched, or the elements in no layer
- `mapx_arch_allowed` - Pre-flight: may this file or symbol depend on that one? Rule, reason and alternatives
- `mapx_arch_explain` - Why an element is in a layer, and why a dependency is allowed or a violation
- `mapx_arch_init` - Propose an architecture configuration from the index (writes only with `write: true`)
- `mapx_export` - Export compact graph summary (formats: llm, json, dot, svg, toon)
- `mapx_context` - Intelligent, token-budgeted workspace context builder
- `mapx_workspaces` - Retrieve workspace configuration and repositories (list/discover)
- `mapx_lang_list` - List supported languages, extensions and tiers (all grammars are bundled)
- `mapx_lang_info` - Show a language's extensions, file names and grammar files
- `mapx_lang_install` / `mapx_lang_uninstall` - Compatibility no-ops: grammars are bundled, nothing is installed or removed
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
11. **Adding an import across modules**: Call `mapx_arch_allowed` first (see below).

## Architecture Rules

When the project has `.mapx/architecture.jsonc` (`mapx_arch_init` proposes one, and writes it only with `write: true`):

1. **Before adding an import across modules, call `mapx_arch_allowed`** with `from` (the file or symbol you are editing) and `to` (what you want to use: a layer `Domain`, a file `src/domain/Order.ts`, a symbol `Order::total`, a package `npm:express` or `express`, or a built-in `node:fs`). If `allowed` is false, read `reason`. `alternatives` lists matching symbols (a supertype, or a similar name) that the rules let `from` use; check that one fits before switching to it.
2. Call `mapx_arch_explain` to see why an element is in a layer, or why a dependency is refused.
3. After editing, call `mapx_arch_check` with `sync: true` (narrow it with `file` or `since`): `exitCode` 1 means a violation to fix. Without `sync: true`, every architecture tool refuses an index older than your edits (`exitCode` 4); pass it to `mapx_arch_allowed` too once you have edited files.
<!-- /mapx -->

## MapX development: BATON

Read `docs/baton/PROJECT_STATE.md` and `docs/baton/HANDOFF.md`, inspect git, and run `npm run plan:validate` before any work. `docs/baton/TASKS.json` is authoritative for status, dependencies, gates and evidence; handoffs and reports are claims to verify against files and test output. `specs/` is frozen history (D001): cite `specs/features/F*.md` from task `sources`, and never update `specs/ITERATIONS.md`.

- **Plan and continue work** with the `baton` skill (`.claude/skills/baton/SKILL.md`; other harnesses: follow that file directly). Use `npm run plan:scan` for ready/promotable/next-wave work, and `npm run plan:transition` for every status change.
- **Review delivered work** with the `baton-review` skill (`.claude/skills/baton-review/`), which reviews since the marker in `docs/baton/reviews/state.json`.
- **Baseline check:** `npm run check` (plan validation, typecheck, vitest, skill tests). Run `npm ci --legacy-peer-deps` first on a fresh clone.
- **Ground rules:** fixtures before fixes; never use private or pilot code in fixtures; attach real evidence before DONE; one active iteration per owner. Releases are owner-initiated (D007): never bump the version, publish or request a release. Commit only when asked.
