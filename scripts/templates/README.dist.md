# CodeGraph - Multi-language Code Graph Memory System for LLMs

CodeGraph scans your source code, extracts symbols (classes, functions, methods, interfaces)
and dependencies (imports, extends, implements, calls), then builds a ranked graph you can
query for instant codebase understanding.

## Quick Start

```bash
# Initialize in your project
codegraph init

# Scan all source files
codegraph scan

# View compact summary
codegraph export

# Search for a symbol
codegraph query MyClass

# Check file dependencies
codegraph deps src/index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize codegraph for the project |
| `scan` | Full scan of all source files |
| `update` | Incremental scan (only changed files) |
| `status` | Show changed files since last scan |
| `export` | Export compact graph summary (LLM-friendly) |
| `export --format=json` | Export full graph as JSON |
| `export --format=dot` | Export as GraphViz DOT |
| `query <term>` | Search symbols by name |
| `deps <file>` | Show file dependencies |
| `summary` | One-line project summary |
| `lang list` | List supported languages |
| `serve` | Start MCP server (for Claude Desktop, Cursor, etc.) |

## Supported Languages

- **PHP**: classes, methods, functions, interfaces, traits, enums, constants
- **JavaScript**: classes, methods, functions, arrow functions
- **TypeScript**: classes, methods, functions, interfaces, enums, properties

## MCP Integration

Run `codegraph serve` and configure your LLM tool:

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

## Storage

All data is stored locally in `.codegraph/` within your project:

- `config.json` — Project configuration and language settings
- `codegraph.db` — SQLite database with symbols, edges, and cache

Add `.codegraph/` to your `.gitignore`.

## Documentation

See the `docs/` directory for detailed guides:
- `getting-started.md` — Full usage guide
- `cli-reference.md` — All commands with examples
- `mcp-integration.md` — MCP server setup
- `adding-languages.md` — How to add new language support
- `architecture.md` — Internal architecture
- `configuration.md` — Configuration reference
