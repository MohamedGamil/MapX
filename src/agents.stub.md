# MapxGraph - LLM Integration Guide

This project uses **MapxGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.

## What MapxGraph Does

MapxGraph scans source files, extracts symbols (classes, functions, methods, interfaces) and dependencies (imports, requires, extends, implements, calls), builds a weighted graph with PageRank importance scoring, and persists everything to `.mapx/`.

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

# If no directory is specified, defaults to current working directory.
```

### Available Commands

```bash
# First-time setup
mapx init [/path]            # accepts positional path

# Reverse installation
mapx uninit [/path]          # removes .mapx/ and reverses integration

# Full scan (run once, or after major changes)
mapx scan [/path]

# Incremental update (fast, only re-scans changed files)
mapx update [/path]

# Check what changed since last scan
mapx status [/path]

# Export compact graph summary (token-efficient)
mapx export [--dir /path]              # default: LLM format, 8192 token budget
mapx export --tokens=16384             # larger budget
mapx export --format=json              # full graph as JSON
mapx export --format=dot               # GraphViz DOT for visualization
mapx export --format=svg               # SVG visualization (uses GraphViz if installed, else built-in renderer)

# Export to file (validates path before writing)
mapx export -o summary.txt             # LLM summary to file
mapx export --format=json -o graph.json
mapx export --format=svg -o graph.svg

# Search for symbols
mapx query <symbol-name> [--dir /path]

# Show dependencies for a file
mapx deps <file-path> [--dir /path]

# Edges of one file, filtered, as JSON
mapx edges <file-path> --direction outgoing --type relation,extends --verified-only --format=json

# Most connected files (in + out degree) with PageRank
mapx metrics --format=json --top 10

# Project summary
mapx summary [/path]

# List supported languages
mapx lang list

# Start MCP server
mapx serve --dir /path/to/project                  # stdio transport (default)
mapx serve --sse --port 3456 --dir /path/to/project # SSE (HTTP) transport
```

## MCP Tools

When running as an MCP server, MapxGraph exposes 33 tools:

- **Graph building:** `mapx_scan`, `mapx_sync`
- **Symbol discovery:** `mapx_query`, `mapx_search`, `mapx_node`, `mapx_files`
- **Dependencies and flow:** `mapx_dependencies`, `mapx_callers`, `mapx_callees`, `mapx_trace`, `mapx_sources`, `mapx_sinks`, `mapx_routes`, `mapx_hooks`, `mapx_edges` (JSON by default: `{ file, direction, incoming[], outgoing[] }` with `file`; `direction`, `type` array, `verifiedOnly`)
- **Analysis:** `mapx_impact`, `mapx_clusters`, `mapx_status`, `mapx_metrics` (`format: "json"` gives `{ dir, generatedAt, summary, files[] }`; `top`, default 20, 0 = all; `exclude`), `mapx_profile`, `mapx_explain`, `mapx_smells`, `mapx_dsm`, `mapx_layers`
- **Export:** `mapx_export` (llm, json, dot, svg, toon), `mapx_context`
- **Workspaces:** `mapx_workspaces` (list, discover)
- **Languages:** `mapx_lang_list`, `mapx_lang_info` (all grammars are bundled; `mapx_lang_install` and `mapx_lang_uninstall` are no-ops)
- **Orchestration:** `mapx_batch`, `mapx_agents_generate`

## When to Use

1. **Start of session**: Run `mapx export` to get a compact overview (~2-8K tokens)
2. **Need to find something**: Run `mapx query <term>` instead of grepping
3. **Need to understand a file**: Run `mapx deps <file>` to see relationships
4. **Files changed**: Run `mapx update` to incrementally update the graph
5. **Major changes**: Run `mapx scan` for a full re-scan
6. **Need a visual overview**: Run `mapx export --format=svg -o graph.svg`

## Storage

- `.mapx/config.json` — Repo registry + settings
- `.mapx/mapx.db` — SQLite database (symbols, edges, cache, snapshots)

## Supported Languages

- **PHP** (built-in): classes, methods, functions, interfaces, traits, enums, constants, properties, namespaces
- **JavaScript** (built-in): classes, methods, functions, constants, variables, properties
- **TypeScript** (built-in): classes, methods, functions, interfaces, enums, type aliases, properties, namespaces
