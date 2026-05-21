# CodeGraph - LLM Integration Guide

This project uses **CodeGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.

## What CodeGraph Does

CodeGraph scans source files, extracts symbols (classes, functions, methods, interfaces) and dependencies (imports, requires, extends, implements, calls), builds a weighted graph with PageRank importance scoring, and persists everything to `.codegraph/`.

This means you (the LLM) can quickly understand the codebase structure without reading every file.

## Commands

All commands accept a target directory. Three ways to specify:

```bash
# 1. Positional path argument
codegraph scan /path/to/project

# 2. --dir / -d flag
codegraph scan --dir /path/to/project
codegraph query "MyClass" -d /path/to/project

# 3. Global flag (works with any subcommand)
codegraph -d /path/to/project scan

# If no directory is specified, defaults to current working directory.
```

### Available Commands

```bash
# First-time setup
codegraph init [/path]            # accepts positional path

# Full scan (run once, or after major changes)
codegraph scan [/path]

# Incremental update (fast, only re-scans changed files)
codegraph update [/path]

# Check what changed since last scan
codegraph status [/path]

# Export compact graph summary (token-efficient)
codegraph export [--dir /path]              # default: LLM format, 8192 token budget
codegraph export --tokens=16384             # larger budget
codegraph export --format=json              # full graph as JSON
codegraph export --format=dot               # GraphViz DOT for visualization
codegraph export --format=svg               # SVG visualization (uses GraphViz if installed, else built-in renderer)

# Search for symbols
codegraph query <symbol-name> [--dir /path]

# Show dependencies for a file
codegraph deps <file-path> [--dir /path]

# Project summary
codegraph summary [/path]

# List supported languages
codegraph lang list

# Start MCP server (stdio transport)
codegraph serve --dir /path/to/project     # sets default dir for MCP tools
```

## MCP Tools

When running as an MCP server, CodeGraph exposes these tools:

- **`codegraph_scan`** — Scan/update the code graph
- **`codegraph_query`** — Search symbols by name pattern
- **`codegraph_dependencies`** — Get deps and reverse-deps for a file
- **`codegraph_export`** — Export compact graph summary
- **`codegraph_status`** — Check scan status and file counts

## When to Use

1. **Start of session**: Run `codegraph export` to get a compact overview (~2-8K tokens)
2. **Need to find something**: Run `codegraph query <term>` instead of grepping
3. **Need to understand a file**: Run `codegraph deps <file>` to see relationships
4. **Files changed**: Run `codegraph update` to incrementally update the graph
5. **Major changes**: Run `codegraph scan` for a full re-scan

## Storage

- `.codegraph/config.json` — Repo registry + settings
- `.codegraph/codegraph.db` — SQLite database (symbols, edges, cache, snapshots)

## Supported Languages

- **PHP** (built-in): classes, methods, functions, interfaces, traits, enums, constants
- **JavaScript** (built-in): classes, methods, functions, arrow functions
- **TypeScript** (built-in): classes, methods, functions, interfaces, enums, type aliases, properties
