# CLI Reference

## Target Directory

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

## `mapx init`

Initialize MapxGraph in the current project. Creates `.mapx/` directory, `AGENTS.md`, and auto-adds `.mapx/` to `.gitignore`.

```bash
mapx init [/path] [--name <repo-name>] [--no-agents] [--no-suggestions] [--no-mcp-configs]
```

Options:
- `[path]` — Target directory (positional)
- `--name` — Custom repository name (defaults to directory name)
- `--no-agents` — Skip AGENTS.md creation
- `--no-suggestions` — Skip interactive framework suggestions
- `--no-mcp-configs` — Skip auto-generating MCP config files for detected agent tools

The init command also:
- Detects Laravel projects and offers to add framework-specific exclusions
- Prompts for LLM provider selection (generic, Claude, Cursor, VS Code, opencode)
- **Auto-detects installed agent tools** (opencode, Gemini CLI, Cursor, VS Code, Antigravity) and generates MCP server config files so mapx is immediately available as an MCP server
- Auto-adds `.mapx/` to `.gitignore` if a `.gitignore` file exists or the project is a git repository

## `mapx uninit`

Remove mapx configurations, the `.mapx/` directory, reverse integration changes (reverting files like `AGENTS.md` and custom provider instructions), and remove mapx entries from MCP config files.

```bash
mapx uninit [/path] [--force]
```

Options:
- `[path]` — Target directory (positional)
- `-f, --force` — Skip confirmation prompt

The uninit command will:
- Revert LLM integration files (deleting files created solely by mapx, or removing sentinel blocks from files that were appended to)
- Remove `.mapx/` directory from `.gitignore`
- Delete `.mapx/` directory completely

## `mapx scan`

Perform a full scan of all source files. Builds the graph from scratch.

- Shows real-time progress: discover, index, and parse phases
- File reads are parallelized for faster scanning
- Survives interruptions: progress is saved per-file, re-run to resume

```bash
mapx scan [/path] [--exclude <glob>] [--include <glob>] [--repo <name>] [--all] [--force]
```

Options:
- `--exclude` — Exclude glob patterns (repeatable)
- `--include` — Include glob patterns (repeatable)
- `--repo` — Scan only a specific registered repository
- `--all` — Scan all registered repositories
- `--force` — Force re-parsing of all files (bypasses file caching and rebuilds all symbols and edges)

## `mapx update` / `mapx sync`

Incremental scan. Detects changed files via git and only re-scans those.

```bash
mapx update [/path]
mapx sync [/path]
```

## `mapx status`

Show scan metrics, collected data, graph statistics, and git changes since the last scan.

```bash
mapx status [/path]
```

Outputs:
- **Scan info**: project name, directory, last scan time, last git commit, schema version
- **Collected data**: file/symbol/edge counts, language breakdown, symbol kind breakdown, edge type breakdown
- **Graph metrics**: graph density, average edges per file, top 5 most-connected files, PageRank top symbols
- **Storage**: database path and size
- **Git changes**: added/modified/removed/renamed files since last scan
- **Index recommendations**: stale index detection with upgrade suggestions

## `mapx query <term>`

Search for symbols by name. Supports partial matching, glob patterns (`*Service`, `get*`, `*Controller*`), and wildcard (`*` to list all). When no matches are found, suggests similar symbols via fuzzy matching.

```bash
mapx query <term> [--dir /path]
```

Examples:
```bash
mapx query UserService           # Partial match
mapx query '*Service'            # Glob: all symbols ending with "Service"
mapx query 'get*'                # Glob: all symbols starting with "get"
mapx query '*'                   # List all symbols
mapx query Stor                  # Typo: fuzzy suggestions → Store, StoreBackend
```

## `mapx search <term>`

Advanced filtered search for symbols. Supports the same glob and wildcard patterns as `query`, plus filtering by kind, file prefix, and output format. When a `--kind` filter yields zero results, search automatically retries without the kind filter (auto-expand) and notifies you.

```bash
mapx search <term> [--kind <kind>] [--file <prefix>] [--exact] [--limit <n>] [--format <format>]
```

Options:
- `--kind` — Filter by symbol kind (class, function, method, interface, trait, constant, enum, property, namespace, struct, module)
- `--file` — Filter by file path prefix
- `--exact` — Exact name match (case-insensitive, no partial/glob)
- `--limit` — Max results (default: 20)
- `--format` — Output format: `text` (default) or `json`

Examples:
```bash
mapx search '*' --kind class               # All classes
mapx search '*Service' --kind class         # Classes ending with "Service"
mapx search '*' --kind enum                 # All enums (auto-expands if none found)
mapx search '*' --file src/core/            # All symbols in src/core/
mapx search User --format json --limit 5    # JSON output
```

## `mapx deps <file>`

Show dependencies (what the file depends on) and reverse dependencies (what depends on it).

```bash
mapx deps <file> [--dir /path]
```

## `mapx trace <symbol>`

Trace data flow paths from a symbol or file.

```bash
mapx trace <symbol> [--dir /path] [--depth <n>]
```

## `mapx callers <symbol>`

Show direct and nested callers of a symbol. If the symbol is not found, suggests similar symbols via fuzzy matching.

```bash
mapx callers <symbol> [--dir /path] [--depth <n>]
```

## `mapx callees <symbol>`

Show direct and nested callees of a symbol. If the symbol is not found, suggests similar symbols via fuzzy matching.

```bash
mapx callees <symbol> [--dir /path] [--depth <n>]
```

## `mapx impact <symbol>`

Perform change impact analysis — show blast radius and risk for modifying a symbol. Validates symbol existence before running analysis; suggests alternatives via fuzzy matching if not found.

```bash
mapx impact <symbol> [--dir /path] [--depth <n>] [--format <format>]
```

## `mapx node <symbol>`

Inspect a specific symbol node with detailed metadata. Optionally view its source code. If the symbol is not found, suggests similar symbols via fuzzy matching.

```bash
mapx node <symbol> [--dir /path] [--source] [--format <format>]
```

Options:
- `--source` — Include the source code of the symbol
- `--format` — Output format: `text` (default) or `json`

Examples:
```bash
mapx node Store                         # Text output
mapx node Store --source                # Text output with source code
mapx node Store --format json           # JSON output
mapx node Store --source --format json  # JSON with embedded source
```

## `mapx files`

List and filter project files.

```bash
mapx files [--path <prefix>] [--lang <language>] [--sort <sort>] [--limit <n>]
```

Options:
- `--path` — Filter by file path prefix
- `--lang` — Filter by language
- `--sort` — Sort by: `name`, `lines`, `size`, `pagerank` (default: `name`)
- `--limit` — Max results (default: 100)

## `mapx clusters`

List detected code clusters/modules.

```bash
mapx clusters [--dir /path]
```

## `mapx export`

Export the code graph in various formats.

```bash
mapx export [--format <fmt>] [--tokens <budget>] [--repo <name>] [-o <file>]
            [--exclude <glob>] [--include <glob>]
            [--cluster <mode>] [--depth <n>]
            [--delimiter <delimiter>] [--key-folding]
```

Options:
- `--format` — Output format: `llm` (default), `json`, `dot`, `svg`, `toon`
- `--tokens` — Token budget for LLM format (default: 8192)
- `--repo` — Filter by repository name
- `-o, --output <file>` — Write output to file instead of stdout
- `--exclude` — Exclude glob patterns
- `--include` — Include glob patterns
- `--cluster` — Cluster rendering for DOT/SVG: `none` (flat) or `auto` (default, with subgraph blocks)
- `--depth` — Maximum cluster nesting depth for DOT/SVG
- `--delimiter` — Delimiter for TOON format: `comma`, `tab`, `pipe` (default: `comma`)
- `--key-folding` — Collapse single-key chains into dotted paths for TOON

Examples:
```bash
mapx export                                          # Compact LLM summary (stdout)
mapx export -o summary.txt                           # LLM summary to file
mapx export --format=json -o graph.json              # Full JSON graph
mapx export --format=dot -o graph.dot                # GraphViz DOT
mapx export --format=svg -o graph.svg                # SVG visualization
mapx export --format=toon -o graph.toon              # TOON compact format
mapx export --format=dot --cluster=none              # Flat DOT (no clusters)
mapx export --format=svg --depth=2                   # SVG with max 2 cluster levels
mapx export --tokens=16384                           # More detailed LLM summary
```

### SVG Export

The `--format=svg` option generates an SVG visualization of the code graph:

- **With GraphViz installed**: Uses `dot -Tsvg` for high-quality layout and rendering
- **Without GraphViz**: Uses the built-in fallback renderer with PageRank-weighted nodes, language colors, and styled edges

See [Installing GraphViz](#installing-graphviz) for setup instructions.

## `mapx summary`

Show a one-line project summary (file count, symbol count, languages).

```bash
mapx summary [/path]
```

## `mapx lang list`

List all supported languages with their tier and status.

```bash
mapx lang list
```

## `mapx lang install <lang>`

Install a dynamic (installable-tier) language grammar.

```bash
mapx lang install python   # Install Python grammar
```

## `mapx lang uninstall <lang>`

Uninstall a previously installed language grammar.

```bash
mapx lang uninstall python
```

## `mapx ui`

Start the bundled lightweight web dashboard for interactive graph visualization.

```bash
mapx ui [--port <port>] [--dir /path]
```

## `mapx workspaces`

Manage multi-repository workspaces.

### `mapx workspaces list`

List all registered repositories and their stats.

```bash
mapx workspaces list
```

### `mapx workspaces add <path>`

Register a new repository in the workspace.

```bash
mapx workspaces add ../sibling-repo --name my-repo
```

### `mapx workspaces remove <name>`

Remove a registered repository from the workspace.

```bash
mapx workspaces remove my-repo
```

### `mapx workspaces discover`

Discover unregistered submodules, peer repos, and VS Code workspace folders (read-only).

```bash
mapx workspaces discover
```

Outputs grouped results by source type (submodules, peer repos, VS Code folders) with status indicators. Suggests `mapx workspaces add <path>` for registration.

### `mapx workspaces sync`

Sync all discovered submodules, peer repos, and VS Code workspace folders (auto-registers them).

```bash
mapx workspaces sync
```

## `mapx agents mcp`

Auto-detect installed agent tools and generate/update MCP server config files so mapx is immediately available to LLM agents.

```bash
mapx agents mcp [--tools <list>] [--all] [--detect] [--dry-run]
```

Options:
- `--tools <list>` — Comma-separated list of tools to generate configs for (`opencode`, `gemini-cli`, `cursor-mcp`, `vscode-mcp`, `antigravity`)
- `--all` — Generate MCP configs for all supported tools
- `--detect` — Only detect installed agent tools without writing files
- `--dry-run` — Show actions without writing files

Supported MCP config targets:

| Tool | Config File | Detection |
|------|-------------|-----------|
| opencode | `opencode.json` | `opencode.json` or `opencode.jsonc` exists |
| gemini-cli | `.gemini/settings.json` | `.gemini/` directory exists |
| cursor-mcp | `.cursor/mcp.json` | `.cursor/` directory exists |
| vscode-mcp | `.vscode/mcp.json` | `.vscode/` directory exists |
| antigravity | `.agents/mcp.json` | `.agents/` directory exists |

When a config file already exists, mapx **merges** its MCP entry into the file without overwriting other settings.

Examples:
```bash
mapx agents mcp                    # Auto-detect and generate
mapx agents mcp --detect           # Show detected tools only
mapx agents mcp --all              # Generate for all tools
mapx agents mcp --tools opencode   # Generate for opencode only
```

## `mapx serve`

Start as an MCP server. Supports stdio (default) and SSE (HTTP) transports.

```bash
mapx serve [--dir /path] [--sse] [--port <port>] [--debug]
```

Options:
- `--dir / -d` — Default target directory for MCP tools
- `--sse` — Enable SSE (HTTP) transport instead of stdio
- `--port <port>` — Port for SSE transport (default: 45123)
- `--debug` — Enable verbose debug logging of MCP calls to stderr (logs request names, parameters, durations, and status)

On startup, prints ready-to-copy configuration snippets for Claude Desktop, Cursor, and VS Code. SSE mode additionally prints the connection URL and messages endpoint.

> **Note:** When started without `--dir`, the server checks whether the current working directory is an initialized MapxGraph project. If it is, that directory becomes the default. Otherwise no default is set and each tool call must include a `dir` argument. The active directory is logged to stderr at startup.

Examples:
```bash
mapx serve --dir /path/to/project                  # stdio (default)
mapx serve --sse --port 3456 --dir /path/to/project  # SSE on port 3456
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
