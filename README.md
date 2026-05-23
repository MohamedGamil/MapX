# MapX

**Local code graph memory for LLMs.** Scan your codebase once — instantly query symbols, trace dependencies, analyze impact, and generate structured summaries without re-reading files.

MapX uses [tree-sitter](https://tree-sitter.github.io/) to parse source files across **22 languages**, builds a PageRank-weighted dependency graph, and persists everything to a local SQLite database. Works as a standalone CLI or as an [MCP server](https://modelcontextprotocol.io/) with **25 tools** for Claude Desktop, Cursor, VS Code, and any other MCP-compatible client.

---

## Features

- **22 languages** — 8 built-in (PHP, JS, TS, Python, Go, Rust, Java, C#), 8 bundled (Ruby, C, C++, Swift, Kotlin, Dart, Scala, Vue), 6 installable (Svelte, Lua, Elixir, Zig, Bash, Pascal)
- **Deep symbol extraction** — classes, methods, functions, interfaces, traits, enums, structs, modules, constants, properties, namespaces — with full import/inheritance/instantiation reference tracking
- **Incremental scans** — git-aware change detection; only re-parses files that changed
- **Fast** — parallelised file reads, bounded WASM concurrency, batched SQLite writes
- **Resumable** — scan progress is checkpointed; `Ctrl+C` and re-run picks up where it left off
- **25 MCP tools** — scan, query, search, trace, callers, callees, impact, export, context, workspaces, and more
- **Data flow tracing** — trace call chains, find sources/sinks, analyze change impact with blast radius scoring
- **Multi-repo workspaces** — register multiple repos, discover submodules, track cross-repo dependencies
- **Multiple export formats** — LLM summary (token-budgeted), JSON, GraphViz DOT, SVG, TOON
- **Framework detection** — 21 frameworks recognized (Laravel, Express, Next.js, Django, Flask, FastAPI, Spring, Rails, and more)
- **Web dashboard** — built-in `mapx ui` for interactive graph visualization
- **Zero cloud** — everything stays on disk in `.mapx/` inside your project

---

## Installation

### Pre-built binary (recommended)

Download the latest release for your platform from the [Releases](../../releases) page and place it on your `PATH`:

```bash
# Linux x86_64
curl -fsSL https://github.com/MohamedGamil/mapx/releases/latest/download/mapx-linux-x64-installer.sh | sh

# macOS Apple Silicon
curl -fsSL https://github.com/MohamedGamil/mapx/releases/latest/download/mapx-darwin-arm64-installer.sh | sh
```

Or extract the archive manually:

```bash
tar xzf mapx-<version>-linux-x64.tar.gz
cd mapx-<version>
./install.sh --local          # installs to ~/.local/bin (no sudo)
./install.sh --system         # installs to /usr/local/bin (needs sudo)
```

### From npm

```bash
npm install -g mapx
```

### From source

Requires [Node.js](https://nodejs.org/) ≥ 20 or [Bun](https://bun.sh/).

```bash
git clone https://github.com/MohamedGamil/mapx.git
cd mapx
npm install
npx tsx src/main.ts --help
```

---

## Quick Start

```bash
# 1. Initialize mapx in your project (auto-adds .mapx/ to .gitignore)
cd /path/to/your/project
mapx init

# 2. Scan all source files
mapx scan

# 3. View a token-efficient summary (great for pasting into an LLM)
mapx export

# 4. Search for a symbol
mapx query UserService

# 5. Show a file's dependencies
mapx deps src/app.ts

# 6. Trace who calls a function
mapx callers handleRequest

# 7. Assess change impact before refactoring
mapx impact UserService

# 8. Check what changed since the last scan
mapx status
```

All commands accept a target directory via a positional argument, `--dir`, or `-d`:

```bash
mapx scan /path/to/project
mapx query "MyClass" --dir /path/to/project
mapx -d /path/to/project export
```

---

## Commands

| Command | Description |
|---------|-------------|
| `mapx init [path]` | Initialise mapx; create `.mapx/`, `AGENTS.md`, update `.gitignore` |
| `mapx scan [path]` | Full scan — builds the graph from scratch |
| `mapx update [path]` | Incremental scan — only re-parses changed files |
| `mapx status [path]` | Show graph metrics, language breakdown, PageRank rankings, git changes |
| `mapx query <term>` | Search symbols by name (partial match) |
| `mapx search <term>` | Advanced symbol search with `--kind`, `--file`, `--exact`, `--limit` filters |
| `mapx deps <file>` | Show dependencies and reverse-dependencies |
| `mapx trace <symbol>` | Trace data flow paths from a symbol |
| `mapx callers <symbol>` | Show direct and nested callers |
| `mapx callees <symbol>` | Show direct and nested callees |
| `mapx impact <symbol>` | Change impact analysis — blast radius and risk scoring |
| `mapx node <symbol>` | Inspect a symbol with metadata and optional `--source` |
| `mapx files` | List and filter files with `--path`, `--lang`, `--sort`, `--limit` |
| `mapx clusters` | List detected code clusters/modules |
| `mapx export` | Export graph (default: LLM summary, 8K tokens) |
| `mapx export --format=json` | Full graph as JSON |
| `mapx export --format=dot` | GraphViz DOT (with `--cluster` and `--depth`) |
| `mapx export --format=svg` | SVG visualisation |
| `mapx export --format=toon` | TOON compact format (with `--delimiter`, `--key-folding`) |
| `mapx export -o out.txt` | Write export to a file |
| `mapx summary [path]` | One-line project summary |
| `mapx lang list` | List supported languages and status |
| `mapx lang install <name>` | Install an installable-tier language |
| `mapx lang uninstall <name>` | Uninstall a language |
| `mapx ui` | Open the web dashboard for interactive visualization |
| `mapx workspaces list` | List registered repositories |
| `mapx workspaces add <path>` | Register a new repository |
| `mapx workspaces discover` | Discover unregistered submodules, peers, VS Code folders |
| `mapx workspaces sync` | Auto-register discovered repositories |
| `mapx serve --dir <path>` | Start MCP server (stdio) |
| `mapx serve --sse --port 3456` | Start MCP server (SSE/HTTP) |

See [docs/cli-reference.md](docs/cli-reference.md) for full details on all flags.

---

## MCP Integration

Start the MCP server and paste the printed configuration into your tool:

```bash
mapx serve --dir /path/to/your/project
```

On startup mapx prints ready-to-copy configuration for Claude Desktop, Cursor, and VS Code.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "mapx": {
      "command": "mapx",
      "args": ["serve", "--dir", "/path/to/your/project"]
    }
  }
}
```

### Cursor / VS Code (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "mapx": {
      "command": "mapx",
      "args": ["serve", "--dir", "/path/to/your/project"]
    }
  }
}
```

### Available MCP tools (25 total)

| Category | Tools |
|----------|-------|
| **Graph Building** | `mapx_scan`, `mapx_sync` |
| **Symbol Discovery** | `mapx_query`, `mapx_search`, `mapx_node`, `mapx_files` |
| **Dependencies & Flow** | `mapx_dependencies`, `mapx_callers`, `mapx_callees`, `mapx_trace`, `mapx_sources`, `mapx_sinks` |
| **Analysis** | `mapx_impact`, `mapx_clusters`, `mapx_status` |
| **Export** | `mapx_export`, `mapx_context` |
| **Workspaces** | `mapx_workspaces` |
| **Language Management** | `mapx_lang_list`, `mapx_lang_install`, `mapx_lang_uninstall` |

See [docs/mcp-integration.md](docs/mcp-integration.md) for full tool parameters and client setup.

---

## Supported Languages

### Built-in (Tier 1) — Always available

| Language | Extensions | Key Symbols |
|----------|-----------|-------------|
| PHP | `.php`, `.phtml` | classes, methods, functions, interfaces, traits, enums, constants, properties, namespaces |
| JavaScript | `.js`, `.mjs`, `.cjs` | classes, methods, functions, interfaces, enums, properties |
| TypeScript | `.ts`, `.cts`, `.mts` | classes, methods, functions, interfaces, enums, properties, namespaces |
| Python | `.py` | classes, functions, constants |
| Go | `.go` | structs, interfaces, functions, methods, constants, packages |
| Rust | `.rs` | structs, traits, enums, functions, impl blocks, constants, modules, macros |
| Java | `.java` | classes, interfaces, enums, methods, fields, constants, packages |
| C# | `.cs` | classes, interfaces, enums, structs, methods, properties, namespaces, records |

### Bundled (Tier 2) — Ships with the tool

| Language | Extensions | Key Symbols |
|----------|-----------|-------------|
| Ruby | `.rb` | classes, modules, methods, constants, properties |
| C | `.c`, `.h` | structs, functions, enums, typedefs, macros |
| C++ | `.cpp`, `.hpp`, `.cc` | classes, structs, functions, namespaces, enums, templates |
| Swift | `.swift` | classes, structs, protocols, enums, functions, properties |
| Kotlin | `.kt`, `.kts` | classes, objects, functions, interfaces, properties |
| Dart | `.dart` | classes, functions, enums, mixins, extensions |
| Scala | `.scala`, `.sc` | classes, objects, traits, functions, vals |
| Vue | `.vue` | functions, classes, methods, properties |

### Installable (Tier 3) — `mapx lang install <name>`

| Language | Extensions | Key Symbols |
|----------|-----------|-------------|
| Svelte | `.svelte` | functions, classes, methods, props, constants |
| Lua | `.lua` | functions, methods, variables |
| Elixir | `.ex`, `.exs` | modules, functions, macros, structs, protocols |
| Zig | `.zig` | functions, structs, constants, tests |
| Bash | `.sh`, `.bash` | functions, variables, aliases |
| Pascal | `.pas`, `.pp` | classes, records, interfaces, methods, functions, constants, units |

All languages track **imports**, **inheritance/implementation**, **instantiation**, and **calls** where applicable. See [docs/adding-languages.md](docs/adding-languages.md) to add your own.

---

## AGENTS.md

`mapx init` creates (or updates) an `AGENTS.md` file in your project root. This file documents the mapx CLI and MCP tools so LLM coding agents can discover and use them automatically.

The content is wrapped in markers and can safely coexist with existing AGENTS.md content:

```markdown
<!-- mapx -->
...mapx documentation for LLMs...
<!-- /mapx -->
```

---

## Storage

mapx stores everything locally inside your project:

```
.mapx/
├── config.json    # Repo configuration and language settings
├── mapx.db        # SQLite database — symbols, edges, scan cache
└── scan.lock      # Present only while a scan is running
```

`.mapx/` is automatically added to `.gitignore` during `mapx init`.

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  CLI / MCP   │────▶│   Scanner    │────▶│   Parsers    │
│  Interface   │     │  (Walker)    │     │ (tree-sitter)│
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                     │
       │              ┌─────▼──────┐       ┌──────▼──────┐
       │              │ GitTracker │       │  Registry   │
       │              │ (changes)  │       │ (22 langs)  │
       │              └─────┬──────┘       └─────────────┘
       │                    │
┌──────▼────────────────────▼──────┐
│              Store               │
│         (SQLite + Graph)         │
└──────────────┬───────────────────┘
               │
        ┌──────▼───────┐     ┌──────────────┐
        │  Exporters   │     │ Flow Tracer  │
        │ LLM/JSON/DOT │     │ impact, call │
        │ SVG/TOON     │     │ chains, flow │
        └──────────────┘     └──────────────┘
```

See [docs/architecture.md](docs/architecture.md) for a detailed breakdown of each component.

---

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | Installation, quick start, supported languages |
| [CLI Reference](docs/cli-reference.md) | All 31 commands and their flags |
| [MCP Integration](docs/mcp-integration.md) | MCP server setup and all 25 tools |
| [Configuration](docs/configuration.md) | Config file, workspace setup, settings |
| [Adding Languages](docs/adding-languages.md) | Extend mapx with new tree-sitter grammars |
| [Architecture](docs/architecture.md) | Internals and component overview |

---

## Development

### npm script shortcuts

All CLI commands are available as npm scripts for development:

```bash
npm run scan                    # Full scan
npm run update                  # Incremental scan
npm run status                  # Show status
npm run export                  # LLM summary
npm run export:svg              # SVG export
npm run query -- UserService    # Symbol search
npm run search -- User --kind class  # Advanced search
npm run callers -- handleRequest     # Trace callers
npm run impact -- UserService        # Change impact
npm run ui                      # Web dashboard
npm run serve                   # MCP server (stdio)
npm run serve:sse               # MCP server (SSE)
```

### Makefile shortcuts

```bash
make help                       # Show all targets
make scan DIR=/path             # Full scan
make search q=User k=class     # Advanced search
make callers s=handleRequest   # Trace callers
make impact s=UserService d=3  # Impact with depth
make node s=UserService src=1  # Inspect with source
make export-toon DIR=/path     # TOON export
make serve-sse PORT=3456       # SSE server
make ui PORT=8080              # Web dashboard
```

### Building binaries

Requires [Bun](https://bun.sh/) for binary compilation.

```bash
# Build for all platforms
make build-all

# Build for a single platform
make build-linux
make build-mac-arm
make build-win

# Package into distributable archives + self-extracting installers
make package-all

# Install locally (no sudo)
make install-local
```

---

## Publishing to npm

To publish new releases of the npm package:

1. Create a tag matching the version in `package.json` and push it:
   ```bash
   git tag v0.1.7
   git push origin v0.1.7
   ```
2. The GitHub Actions publish workflow will automatically run, verify version synchronization, build WASM grammars, compile the TypeScript code using `tsup`, and publish to the npm registry with provenance.
3. **Important**: The workflow requires a repository secret named `NPM_TOKEN`. This token must be generated on `npmjs.com` as an **Automation** access token.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
