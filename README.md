# MapX

**Local code graph memory for LLMs.** Scan your codebase once — instantly query symbols, trace dependencies, and generate structured summaries without re-reading files.

MapX uses [tree-sitter](https://tree-sitter.github.io/) to parse source files, builds a PageRank-weighted dependency graph, and persists everything to a local SQLite database. Works as a standalone CLI or as an [MCP server](https://modelcontextprotocol.io/) for Claude Desktop, Cursor, VS Code, and any other MCP-compatible tool.

---

## Features

- **Multi-language** — PHP, JavaScript, and TypeScript built-in; extensible via tree-sitter WASM grammars
- **Incremental scans** — git-aware change detection; only re-parses files that changed
- **Fast** — parallelised file reads, bounded WASM concurrency, batched SQLite writes
- **Resumable** — scan progress is checkpointed; `Ctrl+C` and re-run picks up where it left off
- **MCP server** — exposes `mapx_scan`, `mapx_query`, `mapx_dependencies`, `mapx_export`, `mapx_status` tools over stdio or SSE
- **Multiple export formats** — LLM-friendly summary (token-budgeted), JSON, GraphViz DOT, SVG
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
# 1. Initialize mapx in your project
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

# 6. Check what changed since the last scan
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
| `mapx init [path]` | Initialise mapx; create `.mapx/` and `AGENTS.md` |
| `mapx scan [path]` | Full scan — builds the graph from scratch |
| `mapx update [path]` | Incremental scan — only re-parses changed files |
| `mapx status [path]` | Show graph metrics and git changes since last scan |
| `mapx export` | Export a token-budgeted LLM summary (default 8 K tokens) |
| `mapx export --format=json` | Full graph as JSON |
| `mapx export --format=dot` | GraphViz DOT |
| `mapx export --format=svg` | SVG visualisation |
| `mapx export -o out.txt` | Write export to a file |
| `mapx query <term>` | Search symbols by name (partial match) |
| `mapx deps <file>` | Show dependencies and reverse-dependencies |
| `mapx summary [path]` | One-line project summary |
| `mapx lang list` | List supported languages |
| `mapx serve --dir <path>` | Start MCP server (stdio) |
| `mapx serve --sse --port 3456 --dir <path>` | Start MCP server (SSE/HTTP) |

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
  "mcp": {
    "servers": {
      "mapx": {
        "command": "mapx",
        "args": ["serve", "--dir", "/path/to/your/project"]
      }
    }
  }
}
```

### Available MCP tools

| Tool | Description |
|------|-------------|
| `mapx_scan` | Scan or update the code graph |
| `mapx_query` | Search symbols by name pattern |
| `mapx_dependencies` | Get deps and reverse-deps for a file |
| `mapx_export` | Export a compact graph summary |
| `mapx_status` | Check scan status and file counts |

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

## Supported Languages

| Language | Extensions | Symbols extracted |
|----------|-----------|-------------------|
| TypeScript | `.ts`, `.tsx` | classes, methods, functions, interfaces, enums, type aliases, properties |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | classes, methods, functions, arrow functions |
| PHP | `.php` | classes, methods, functions, interfaces, traits, enums, constants |

Additional languages can be added by providing a tree-sitter WASM grammar and `.scm` query files. See [docs/adding-languages.md](docs/adding-languages.md).

---

## Storage

mapx stores everything locally inside your project:

```
.mapx/
├── config.json    # Repo configuration and language settings
├── mapx.db        # SQLite database — symbols, edges, scan cache
└── scan.lock      # Present only while a scan is running
```

Add `.mapx/` to your `.gitignore` — it is a local development artifact.

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
       │              │ (changes)  │       │ (languages) │
       │              └─────┬──────┘       └─────────────┘
       │                    │
┌──────▼────────────────────▼──────┐
│              Store               │
│         (SQLite + Graph)         │
└──────────────┬───────────────────┘
               │
        ┌──────▼──────┐
        │  Exporters  │
        │LLM/JSON/DOT │
        │    /SVG     │
        └─────────────┘
```

See [docs/architecture.md](docs/architecture.md) for a detailed breakdown of each component.

---

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | Installation and first steps |
| [CLI Reference](docs/cli-reference.md) | All commands and flags |
| [MCP Integration](docs/mcp-integration.md) | MCP server setup for Claude, Cursor, VS Code |
| [Configuration](docs/configuration.md) | Config file reference |
| [Adding Languages](docs/adding-languages.md) | Extend mapx with new tree-sitter grammars |
| [Architecture](docs/architecture.md) | Internals and component overview |

---

## Building from Source

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

## License

Apache 2.0 — see [LICENSE](LICENSE).
