# CLI Reference

## Target Directory

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

## `codegraph init`

Initialize CodeGraph in the current project. Creates `.codegraph/` directory and `AGENTS.md`.

```bash
codegraph init [/path] [--name <repo-name>] [--no-agents]
```

Options:
- `[path]` — Target directory (positional)
- `--name` — Custom repository name (defaults to directory name)
- `--no-agents` — Skip AGENTS.md creation

## `codegraph scan`

Perform a full scan of all source files. Builds the graph from scratch.

- Shows real-time progress: discover, index, and parse phases
- File reads are parallelized for faster scanning
- Survives interruptions: progress is saved per-file, re-run to resume

```bash
codegraph scan [/path]
```

## `codegraph update`

Incremental scan. Detects changed files via git and only re-scans those.

```bash
codegraph update [/path]
```

## `codegraph status`

Show scan metrics, collected data, graph statistics, and git changes since the last scan.

```bash
codegraph status [/path]
```

Outputs:
- **Scan info**: project name, directory, last scan time, last git commit, schema version
- **Collected data**: file/symbol/edge counts, language breakdown, symbol kind breakdown, edge type breakdown
- **Graph metrics**: graph density, average edges per file, top 5 most-connected files
- **Storage**: database path and size
- **Git changes**: added/modified/removed/renamed files since last scan

## `codegraph query <term>`

Search for symbols by name pattern (supports partial matching).

```bash
codegraph query <term> [--dir /path]
```

Examples:
```bash
codegraph query User
codegraph query handleSave
```

## `codegraph deps <file>`

Show dependencies (what the file depends on) and reverse dependencies (what depends on it).

```bash
codegraph deps <file> [--dir /path]
```

## `codegraph export`

Export the code graph in various formats.

```bash
codegraph export [--format <fmt>] [--tokens <budget>] [--repo <name>] [-o <file>]
```

Options:
- `--format` — Output format: `llm` (default), `json`, `dot`, `svg`
- `--tokens` — Token budget for LLM format (default: 8192)
- `--repo` — Filter by repository name
- `-o, --output <file>` — Write output to file instead of stdout. Validates path before export.

Examples:
```bash
codegraph export                                          # Compact LLM summary (stdout)
codegraph export -o summary.txt                           # LLM summary to file
codegraph export --format=json -o graph.json              # Full JSON graph to file
codegraph export --format=dot -o graph.dot                # GraphViz DOT to file
codegraph export --format=svg -o graph.svg                # SVG visualization to file
codegraph export --format=svg                             # SVG to stdout
codegraph export --tokens=16384                           # More detailed LLM summary
```

### Output File Validation

When using `-o, --output`, the tool validates the path before running the export:
- Checks that the parent directory exists
- Verifies write permission with a probe write
- Exits with error if the path is invalid

### SVG Export

The `--format=svg` option generates an SVG visualization of the code graph:

- **With GraphViz installed**: Uses `dot -Tsvg` for high-quality layout and rendering
- **Without GraphViz**: Uses the built-in fallback renderer with PageRank-weighted nodes, language colors, and styled edges

See [Installing GraphViz](#installing-graphviz) for setup instructions.

## `codegraph summary`

Show a one-line project summary (file count, symbol count, languages).

```bash
codegraph summary [/path]
```

## `codegraph lang list`

List supported languages.

```bash
codegraph lang list
```

## `codegraph serve`

Start as an MCP server. Supports stdio (default) and SSE (HTTP) transports.

```bash
codegraph serve [--dir /path] [--sse] [--port <port>]
```

Options:
- `--dir / -d` — Default target directory for MCP tools
- `--sse` — Enable SSE (HTTP) transport instead of stdio
- `--port <port>` — Port for SSE transport (default: 45123)

On startup, prints ready-to-copy configuration snippets for Claude Desktop, Cursor, and VS Code. SSE mode additionally prints the connection URL and messages endpoint.

> **Note:** When started without `--dir`, the server checks whether the current working directory is an initialized CodeGraph project. If it is, that directory becomes the default. Otherwise no default is set and each tool call must include a `dir` argument. The active directory is logged to stderr at startup.

Examples:
```bash
codegraph serve --dir /path/to/project                  # stdio (default)
codegraph serve --sse --port 3456 --dir /path/to/project  # SSE on port 3456
```

See [MCP Integration](mcp-integration.md) for full client configuration details.

## Installing GraphViz

For high-quality SVG exports, install GraphViz. The SVG exporter uses `dot -Tsvg` when available and falls back to a built-in renderer otherwise.

### Linux

```bash
# Debian/Ubuntu
sudo apt-get install graphviz

# Fedora/RHEL
sudo dnf install graphviz

# Alpine
apk add graphviz

# Arch
sudo pacman -S graphviz
```

### macOS

```bash
# Homebrew
brew install graphviz

# MacPorts
sudo port install graphviz
```

### Windows

```bash
# winget
winget install graphviz

# Chocolatey
choco install graphviz

# Scoop
scoop install graphviz
```

### Conda (any platform)

```bash
conda install -c conda-forge graphviz
```

### Verify Installation

```bash
dot -V
# Expected output: dot - graphviz version X.X.X
```
