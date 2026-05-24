<!-- mapx v0.2.6 -->
# MapxGraph - LLM Integration Guide

This project uses **MapxGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.

## What MapxGraph Does

MapxGraph scans source files across **22 languages**, extracts symbols (classes, functions, methods, interfaces, traits, enums, structs, modules, constants, properties, namespaces) and dependencies (imports, requires, extends, implements, calls, instantiation), builds a weighted graph with PageRank importance scoring, and persists everything to `.mapx/`.

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

- `mapx init [path]` - First-time setup (auto-adds .mapx/ to .gitignore)
- `mapx uninit [path]` - Remove .mapx/ and reverse integration changes
- `mapx scan [path]` - Full scan
- `mapx update [path]` (alias: `sync`) - Incremental update (fast)
- `mapx status [path]` - Check what changed since last scan
- `mapx export [--dir path]` - Export compact graph summary
- `mapx export --format=<fmt>` - Export as `llm`, `json`, `dot`, `svg`, or `toon`
- `mapx export --cluster <mode> --depth <n>` - Cluster-aware DOT/SVG export
- `mapx query <symbol> [--dir path]` - Search for symbols
- `mapx search <term> [--dir path] [--kind kind] [--file prefix] [--exact] [--limit limit]` - Advanced search for symbols
- `mapx deps <file> [--dir path]` - Show dependencies for a file
- `mapx summary [path]` - Project summary
- `mapx clusters [--dir path]` - List detected clusters/modules
- `mapx trace <symbol> [--dir path]` - Trace data flow
- `mapx callers <symbol> [--dir path] [--depth depth]` - Trace callers of a symbol
- `mapx callees <symbol> [--dir path] [--depth depth]` - Trace callees of a symbol
- `mapx impact <symbol> [--dir path] [--depth depth]` - Perform change impact analysis
- `mapx node <symbol> [--dir path] [--source]` - Inspect a symbol node and optionally view its source code
- `mapx files [--dir path] [--path prefix] [--lang language] [--sort sort] [--limit limit]` - List and filter files
- `mapx lang list` - List supported languages and status
- `mapx lang install <lang>` - Install dynamic language support
- `mapx lang uninstall <lang>` - Uninstall dynamic language support
- `mapx serve --dir /path` - Start stdio MCP server
- `mapx serve --sse --port <port>` - Start SSE (HTTP) MCP server
- `mapx ui [--port <port>]` - Open web dashboard for interactive visualization
- `mapx workspaces list` - List registered repositories
- `mapx workspaces add <path>` - Register a new repository
- `mapx workspaces discover` - Discover unregistered submodules, peers, VS Code folders
- `mapx workspaces sync` - Auto-register discovered repositories

## MCP Tools

When running as an MCP server, MapxGraph exposes these tools:
- `mapx_scan` - Scan the code graph (full scan)
- `mapx_sync` - Sync changed files to update the graph (incremental scan)
- `mapx_query` - Search symbols by name pattern
- `mapx_search` - Filtered semantic and regex-like symbol search
- `mapx_node` - Deep inspection of a specific symbol and its source code
- `mapx_files` - List and filter files by path, language, and size or line counts
- `mapx_dependencies` - Get deps and reverse-deps for a file
- `mapx_callers` - Direct and nested callers of a symbol
- `mapx_callees` - Direct and nested callees of a symbol
- `mapx_trace` - Trace data flow paths from a starting symbol or file
- `mapx_sources` - Find entry points (sources) in the codebase
- `mapx_sinks` - Find terminal consumers (sinks) in the codebase
- `mapx_impact` - Multi-depth blast radius and change risk analysis for a symbol
- `mapx_clusters` - List code clusters/modules
- `mapx_status` - Check scan status, languages breakdown, top PageRank files/symbols, and index recommendations
- `mapx_export` - Export compact graph summary (formats: llm, json, dot, svg, toon)
- `mapx_context` - Intelligent, token-budgeted workspace context builder
- `mapx_workspaces` - Retrieve workspace configuration and repositories (list/discover)
- `mapx_lang_list` - List supported languages and status
- `mapx_lang_install` - Install dynamic language support
- `mapx_lang_uninstall` - Uninstall dynamic language support

## When to Use

1. **Start of session**: Run `mapx export` to get a compact overview.
2. **Need to find something**: Run `mapx query <term>` or `mapx search` instead of grepping.
3. **Need to understand a file**: Run `mapx deps <file>` to see relationships.
4. **Files changed**: Run `mapx sync` (or `mapx update`) to incrementally update the graph.
5. **Major changes**: Run `mapx scan` for a full re-scan.
6. **Need a visual overview**: Run `mapx export --format=svg -o graph.svg`.
7. **Trace data flow / call chains**: Run `mapx trace <symbol>`, `mapx callers`, or `mapx callees`.
8. **Planning a modification**: Run `mapx impact` to determine the blast radius.
9. **Building custom prompts / context**: Run `mapx context` to generate optimal context within a token budget.
<!-- /mapx -->