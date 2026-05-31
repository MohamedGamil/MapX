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
mapx init [/path] [--name <repo-name>] [--no-agents] [--no-suggestions] [--no-mcp-configs] [--no-discover]
```

Options:
- `[path]` — Target directory (positional)
- `--name` — Custom repository name (defaults to directory name)
- `--no-agents` — Skip AGENTS.md creation
- `--no-suggestions` — Skip interactive framework suggestions
- `--no-mcp-configs` — Skip auto-generating MCP config files for detected agent tools
- `--no-discover` — Skip the monorepo / nested-repo discovery step

The init command also:
- Detects Laravel projects and offers to add framework-specific exclusions
- Prompts for LLM provider selection (generic, Claude, Cursor, VS Code, opencode)
- **Auto-detects installed agent tools** (opencode, Gemini CLI, Cursor, VS Code, Antigravity) and generates MCP server config files so mapx is immediately available as an MCP server
- **Discovers monorepo packages and nested git repositories** — prompts (Y/N, default Y) to register them immediately after init. Individual multi-select lets you choose exactly which packages / repos to track. Pass `--no-discover` to skip.
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

Options:
- `--exclude` — Exclude glob patterns (repeatable)
- `--include` — Include glob patterns (repeatable)
- `--repo` — Update only a specific registered repository
- `--all` — Update all registered repositories

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

The file argument supports multiple matching strategies:
1. **Exact path** — matches an indexed file directly
2. **Glob/wildcard** — `*`, `?`, `**` patterns against all tracked paths (returns all matches)
3. **Substring** — partial path match as fallback

Multiple matched files are all reported.

Examples:
```bash
mapx deps src/app.ts                # Exact match
mapx deps 'src/core/*.ts'           # Glob — all .ts files in src/core/
mapx deps scanner                   # Substring — any file containing "scanner"
```

## `mapx trace [symbol-or-file]`

Trace data flow paths from a starting symbol or file.

```bash
mapx trace [symbol-or-file] [--dir /path] [--direction <dir>] [--depth <n>] [--max-depth <n>]
                            [--format <fmt>] [--include-structural] [--sources] [--sinks]
                            [--to <target>]
```

Options:
- `--direction` — Trace direction: `up`, `down`, `both` (default: `both`)
- `--depth` — Maximum traversal depth (default: 3)
- `--max-depth` — Alias for `--depth`
- `--format` — Output format: `text` (default), `dot`, `json`
- `--include-structural` — Include import/extends edges in trace (default: false)
- `--sources` — Show entry points instead of tracing a symbol
- `--sinks` — Show terminal consumers instead of tracing a symbol
- `--to` — Find the shortest critical path from the start to a target symbol/file

Examples:
```bash
mapx trace handleRequest               # Bidirectional trace
mapx trace handleRequest --direction up # Upstream only
mapx trace --sources                    # List all entry points
mapx trace --sinks                      # List all terminal consumers
mapx trace Store --to FlowTracer        # Shortest path between symbols
mapx trace Store --format json          # JSON output
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
mapx files [--path <prefix_or_glob>] [--lang <language>] [--sort <sort>] [--limit <n>]
```

Options:
- `--path` — Filter by file path prefix **or glob pattern** (e.g. `src/core/`, `src/core/*.ts`, `**/*.json`)
- `--lang` — Filter by language
- `--sort` — Sort by: `path`, `lines` (default: `path`)
- `--limit` — Max results (default: 50)

Examples:
```bash
mapx files --path src/core/          # plain prefix
mapx files --path 'src/core/*.ts'    # glob — quote to prevent shell expansion
mapx files --path '**/*.json'        # double-star glob
mapx files --lang typescript --sort lines --limit 20
```

## `mapx clusters`

List detected code clusters/modules.

```bash
mapx clusters [clusterOrPath] [--dir /path] [--source <source>] [--json]
```

Options:
- `[clusterOrPath]` — Target directory or a specific cluster name to inspect
- `--source` — Filter by cluster source: `namespace`, `directory`, `community`, `layer`, or `all` (default: `all`)
- `--json` — Output results as JSON

When a specific cluster name is given, shows detailed information including member files, dependencies ("depends on"), and reverse dependencies ("depended on by").

Examples:
```bash
mapx clusters                          # List all clusters
mapx clusters --source layer           # Only architectural layer clusters
mapx clusters --source community       # Only community-detected clusters
mapx clusters core --json              # Inspect a specific cluster as JSON
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
- `--cluster` — Cluster rendering for DOT/SVG: `none` (default, flat) or `auto` (with subgraph blocks)
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
mapx ui [path] [--port <port>] [--host <host>] [--token <token>] [--no-open] [--dir /path]
```

Options:
- `--port` — Port to run UI on (default: 45124)
- `--host` — Host to bind to (default: 127.0.0.1)
- `--token` — Bearer token for authorization
- `--no-open` — Do not open the dashboard in the browser automatically

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

Discover unregistered submodules, peer repos, VS Code workspace folders, **nested git repositories**, and **monorepo packages** (read-only).

```bash
mapx workspaces discover
```

Outputs grouped results by source type with status indicators:
- **Submodules** — declared in `.gitmodules`
- **Peer repositories** — sibling directories in the parent folder
- **VS Code workspace folders** — folders listed in `.code-workspace` files
- **Nested git repositories** — any directory up to 3 levels deep that contains a `.git` entry (common noise paths like `node_modules`, `dist`, `build`, `.cache` are skipped automatically)
- **Monorepo packages** — packages/apps declared in `pnpm-workspace.yaml`, `package.json` workspaces, `lerna.json`, `rush.json`, `Cargo.toml` `[workspace]`, `go.work`, or inferred from `apps/`, `packages/`, `libs/`, `services/` directories

Suggests `mapx workspaces add <path>` for registration.

### `mapx workspaces sync`

Sync all discovered submodules, peer repos, and VS Code workspace folders (auto-registers them). For newly discovered **nested git repositories** and **monorepo packages**, interactive prompts let you choose which ones to register and scan.

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
- `--ui` — Enable UI dashboard alongside MCP server
- `--ui-port <port>` — Port to run UI on (default: 45124)
- `--ui-host <host>` — Host to run UI on (default: 127.0.0.1)
- `--ui-token <token>` — Bearer token for UI authorization

On startup, prints ready-to-copy configuration snippets for Claude Desktop, Cursor, and VS Code. SSE mode additionally prints the connection URL and messages endpoint.

> **Note:** When started without `--dir`, the server checks whether the current working directory is an initialized MapxGraph project. If it is, that directory becomes the default. Otherwise no default is set and each tool call must include a `dir` argument. The active directory is logged to stderr at startup.

Examples:
```bash
mapx serve --dir /path/to/project                  # stdio (default)
mapx serve --sse --port 3456 --dir /path/to/project  # SSE on port 3456
```

See [MCP Integration](mcp-integration.md) for full client configuration details.

## `mapx sources`

Find entry points (data sources) in the codebase.

```bash
mapx sources [--dir /path]
```

Identifies files with no incoming data-bearing edges — route files, queue workers, event listeners, and middleware entry points.

## `mapx sinks`

Find terminal consumers (data sinks) in the codebase.

```bash
mapx sinks [--dir /path]
```

Identifies files with no outgoing data-bearing edges — database facades, cache managers, mail senders, and queue dispatchers.

## `mapx context <task>`

Generate task-specific workspace context within a token budget.

```bash
mapx context <task> [--dir /path] [--seeds <list>] [--tokens <budget>] [--depth <n>] [--format <format>]
```

Options:
- `--seeds` — Comma-separated list of seed symbols or file paths to anchor the context around
- `--tokens` — Maximum estimated token budget (default: 8192)
- `--depth` — Graph traversal depth (default: 2)
- `--format` — Output format: `text` (default) or `json`

Examples:
```bash
mapx context 'Add validation to the signup flow'                       # Basic
mapx context 'Refactor scanner' --seeds Scanner,Store --tokens 16384   # Seeded with higher budget
mapx context 'Fix auth bug' --format json                              # JSON output
```

## `mapx metrics`

Show coupling and instability metrics for files.

```bash
mapx metrics [path] [--dir /path] [--lang <language>] [--verified-only]
```

Options:
- `--lang` — Filter metrics by language
- `--verified-only` — Only compute metrics using verified edges

Outputs a table with afferent coupling (Ca), efferent coupling (Ce), and instability index for each file.

## `mapx edges`

Granular query of dependency edges.

```bash
mapx edges [path] [--dir /path] [--type <type>] [--from <file>] [--to <file>]
```

Options:
- `--type` — Filter edges by type (e.g. `call`, `import`, `instantiation`)
- `--from` — Filter edges originating from a file pattern
- `--to` — Filter edges targeting a file pattern

## `mapx routes`

Show routes from all detected frameworks.

```bash
mapx routes [path] [--dir /path] [--framework <name>] [--method <verb>] [--path-pattern <pattern>] [--json]
```

Options:
- `--framework` — Filter by framework name
- `--method` — Filter by HTTP method (GET, POST, etc.)
- `--path-pattern` — Filter by route path pattern
- `--json` — Output routes as JSON

## `mapx hooks`

Show hooks from all detected frameworks.

```bash
mapx hooks [path] [--dir /path] [--framework <name>] [--type <type>] [--name <pattern>] [--json]
```

Options:
- `--framework` — Filter by framework name
- `--type` — Filter by hook type
- `--name` — Filter by hook name pattern
- `--json` — Output hooks as JSON

## `mapx profile`

Show codebase profile details, including the detected archetype, frameworks, active taxonomy, and language composition.

```bash
mapx profile [path] [--dir /path]
```

Examples:
```bash
mapx profile
mapx profile /path/to/project
```

## `mapx arch`

Generate a comprehensive architecture and design quality report, with sections for codebase profile, active layers, architectural smells, and the cluster Dependency Structure Matrix (DSM).

```bash
mapx arch [path] [--dir /path] [--smells] [--dsm] [--violations] [--json]
```

Options:
- `--smells` — Show only detected architectural smells
- `--dsm` — Show only the cluster dependency matrix (DSM)
- `--violations` — Show only layer dependency flow violations
- `--json` — Output the architecture report as structured JSON

Examples:
```bash
mapx arch                           # Full text report
mapx arch --smells                  # Show only code smells
mapx arch --violations --json       # Show violations as JSON
```

## `mapx explain <file>`

Explain the automatic file role/layer classification result for a given file. Shows all evaluated signals (path, naming, topology, framework, imports) with confidence weights and alternate role scores.

```bash
mapx explain <file> [--dir /path] [--reclassify]
```

Options:
- `--reclassify` — Re-run the role classifier engine for this file on-the-fly instead of reading cached DB results

Examples:
```bash
mapx explain src/core/scanner.ts
mapx explain src/api/users.ts --reclassify
```

## `mapx layers`

List files grouped by their dynamically classified architectural roles/layers.

```bash
mapx layers [path] [--dir /path] [--json]
```

Options:
- `--json` — Output the layer groups and file lists as structured JSON

Examples:
```bash
mapx layers
mapx layers --json
```

## `mapx agents list`

List all supported LLM integration providers.

```bash
mapx agents list
```

## `mapx agents generate`

Generate or overwrite LLM integration files.

```bash
mapx agents generate [--providers <list>] [--all] [--dry-run] [--force] [--mcp-port <number>]
```

Options:
- `--providers` — Comma-separated list of providers to generate
- `--all` — Generate integration files for all supported providers
- `--dry-run` — Show actions without writing files
- `--force` — Force overwrite of existing files without prompt
- `--mcp-port` — Port for the MCP SSE transport server (default: 3456)

When run interactively without flags, presents a multi-select prompt to choose providers.

## `mapx agents update`

Update existing LLM integration files to the current MapxGraph version.

```bash
mapx agents update [--dry-run] [--force] [--mcp-port <number>]
```

Options:
- `--dry-run` — Show updates without writing files
- `--force` — Force overwrite of customized blocks without prompt
- `--mcp-port` — Port for the MCP SSE transport server (default: 3456)

Only updates files that already exist; does not create new ones.

## Static File Indexing

MapX indexes static files (Markdown, HTML, CSS, JSON) for dependency tracking without symbol extraction:

| File Type | Extensions | Extracted References |
|-----------|-----------|---------------------|
| Markdown | `.md`, `.mdx`, `.markdown` | Links (`[text](path)`) to other markdown files |
| HTML | `.html`, `.htm`, `.xhtml` | `href`, `src` attributes |
| CSS/SCSS/Sass/Less | `.css`, `.scss`, `.sass`, `.less` | `@import`, `url()` references |
| JSON/JSONC/JSON5 | `.json`, `.jsonc`, `.json5` | `$ref`, `extends` values |

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
