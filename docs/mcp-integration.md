# MCP Integration

MapxGraph can run as an MCP (Model Context Protocol) server, allowing LLM tools to interact with the code graph directly.

## Transports

MapxGraph supports two MCP transport modes:

| Transport | Flag | Use Case |
|-----------|------|----------|
| **stdio** | _(default)_ | Local development, CLI-based MCP clients (Claude Desktop, Cursor, opencode) |
| **SSE** | `--sse` | HTTP-based clients, remote access, browsers, multi-client |

## Starting the Server

### stdio (default)

```bash
mapx serve --dir /path/to/project
```

On startup, prints ready-to-copy configuration for Claude Desktop, Cursor, and VS Code.

### SSE (HTTP)

```bash
mapx serve --sse --port 3456 --dir /path/to/project
```

Options:
- `--sse` — Enable SSE transport (HTTP) instead of stdio
- `--port <port>` — Port to listen on (default: 45123)
- `--dir / -d` — Default target directory for MCP tools
- `--debug` — Enable verbose debug logging of MCP calls to stderr (logs request names, arguments, execution durations, and status)

On startup, prints the SSE URL, messages endpoint, and ready-to-copy configuration.

### Startup Output

Both modes print configuration snippets on startup:

```
  MapxGraph MCP server ready.

  Transport:    stdio
  Project dir:  /path/to/project

  Claude Desktop (claude_desktop_config.json):
  ```json
  {
    "mcpServers": {
      "mapx": {
        "command": "mapx",
        "args": ["serve", "--dir", "/path/to/project"]
      }
    }
  }
  ```

  Cursor / VS Code (.cursor/mcp.json or settings.json):
  ...
```

SSE mode additionally prints:
```
  Transport:    SSE (HTTP)
  URL:          http://localhost:3456/sse
  Messages:     POST http://localhost:3456/messages?sessionId=<id>
```

## Client Configuration

### Claude Desktop

Add to `claude_desktop_config.json`:

**stdio:**
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

Or with `npx tsx` from source:
```json
{
  "mcpServers": {
    "mapx": {
      "command": "npx",
      "args": ["tsx", "/path/to/mem-project/src/main.ts", "serve", "--dir", "/path/to/your/project"]
    }
  }
}
```

**SSE:**
```json
{
  "mcpServers": {
    "mapx": {
      "url": "http://localhost:3456/sse"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

**stdio:**
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

**SSE:**
```json
{
  "mcpServers": {
    "mapx": {
      "url": "http://localhost:3456/sse"
    }
  }
}
```

### VS Code

Add to `.vscode/settings.json` or your user settings:

**stdio:**
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

**SSE:**
```json
{
  "mcp": {
    "servers": {
      "mapx": {
        "url": "http://localhost:3456/sse"
      }
    }
  }
}
```

### opencode

Add to your opencode configuration:

```json
{
  "mcp": {
    "mapx": {
      "command": "mapx",
      "args": ["serve", "--dir", "/path/to/your/project"]
    }
  }
}
```

## SSE Protocol Details

The SSE transport follows the standard MCP SSE protocol:

1. **Connect**: `GET /sse` — Opens an SSE stream. The first event is `endpoint` with the session-specific messages URL:
   ```
   event: endpoint
   data: /messages?sessionId=<uuid>
   ```

2. **Send messages**: `POST /messages?sessionId=<uuid>` — Send JSON-RPC requests. Returns `202 Accepted`.

3. **Receive responses**: Responses arrive as SSE `message` events on the GET stream:
   ```
   event: message
   data: {"jsonrpc":"2.0","id":1,"result":{...}}
   ```

Each SSE connection creates an independent MCP session with its own server instance.

## Default Project Directory

The `--dir` flag sets the default directory used by all tool calls that do not include an explicit `dir` argument.

If `--dir` is omitted:
- If the current working directory contains a `.mapx/config.json` file, it is used as the default.
- Otherwise no default is set, and every tool call **must** include a `dir` argument. Missing it returns an error:
  ```
  No project directory set. Either pass a "dir" argument or start the server with --dir /path/to/project.
  ```

The active directory is always printed to stderr at startup:
```
[mapx] Default project directory: /path/to/project
```

## Verbose Debug Mode

To troubleshoot or inspect MCP tool requests and responses in real-time, start the server with the `--debug` flag:

```bash
mapx serve --dir /path/to/project --debug
```

When active, the MCP server prints all incoming JSON-RPC calls and their outcomes to `stderr` (ensuring the `stdout` channel remains clean for protocol communication). Example stderr output:

```
[mapx debug] Received list_tools request
[mapx debug] Received tool call: mapx_status with arguments: {"dir":"/path/to/project"}
[mapx debug] Completed tool call: mapx_status in 12ms (success: true)
[mapx debug] Received tool call: mapx_scan with arguments: {"exclude":"node_modules"}
[mapx debug] Completed tool call: mapx_scan in 242ms (success: true)
```

This is highly useful when debugging integrations with clients like Claude Desktop, Cursor, or custom LLM frameworks.

## Available Tools (25 total)

### Graph Building

#### `mapx_scan`
Full scan: parse all files, build graph.
- `dir` (string, optional): Target project directory

#### `mapx_sync`
Incremental update: sync changed files only.
- `dir` (string, optional): Target project directory

### Symbol & File Discovery

#### `mapx_query`
Search symbols by name pattern.
- `term` (string, required): Symbol name or pattern
- `dir` (string, optional): Target project directory

#### `mapx_search`
Advanced filtered symbol search.
- `term` (string, required): Search term
- `kind` (string, optional): Filter by symbol kind (class, function, method, etc.)
- `file` (string, optional): Filter by file path prefix
- `exact` (boolean, optional): Exact name match
- `limit` (number, optional): Max results (default: 50)
- `dir` (string, optional): Target project directory

#### `mapx_node`
Deep inspection of a specific symbol node.
- `symbol` (string, required): Symbol name
- `source` (boolean, optional): Include source code
- `dir` (string, optional): Target project directory

#### `mapx_files`
List and filter project files.
- `path` (string, optional): Filter by path prefix
- `lang` (string, optional): Filter by language
- `sort` (string, optional): Sort by `name`, `lines`, `size`, `pagerank`
- `limit` (number, optional): Max results
- `dir` (string, optional): Target project directory

### Dependencies & Flow

#### `mapx_dependencies`
Get file-level dependencies and reverse dependencies.
- `file` (string, required): File path to analyze
- `dir` (string, optional): Target project directory

#### `mapx_callers`
Trace direct and nested callers of a symbol.
- `symbol` (string, required): Symbol name
- `depth` (number, optional): Max traversal depth
- `dir` (string, optional): Target project directory

#### `mapx_callees`
Trace direct and nested callees of a symbol.
- `symbol` (string, required): Symbol name
- `depth` (number, optional): Max traversal depth
- `dir` (string, optional): Target project directory

#### `mapx_trace`
Trace data flow paths from a starting symbol or file.
- `symbol` (string, required): Starting symbol or file
- `depth` (number, optional): Max traversal depth
- `dir` (string, optional): Target project directory

#### `mapx_sources`
Find entry points (sources) in the codebase.
- `dir` (string, optional): Target project directory

#### `mapx_sinks`
Find terminal consumers (sinks) in the codebase.
- `dir` (string, optional): Target project directory

### Analysis

#### `mapx_impact`
Change impact analysis — blast radius and risk for modifying a symbol.
- `symbol` (string, required): Symbol name
- `depth` (number, optional): Max traversal depth
- `dir` (string, optional): Target project directory

#### `mapx_clusters`
List detected code clusters/modules.
- `dir` (string, optional): Target project directory

#### `mapx_status`
Check scan status, language breakdown, PageRank rankings, and index recommendations.
- `dir` (string, optional): Target project directory

### Export

#### `mapx_export`
Export compact graph summary.
- `format` (string, optional): `llm`, `json`, `dot`, `svg`, `toon` (default: `llm`)
- `tokens` (number, optional): Token budget for LLM format (default: 8192)
- `repo` (string, optional): Filter by repo name
- `dir` (string, optional): Target project directory

#### `mapx_context`
Intelligent, token-budgeted workspace context builder for LLM prompts.
- `budget` (number, optional): Token budget
- `focus` (string, optional): Focus symbol or file
- `dir` (string, optional): Target project directory

### Workspace Management

#### `mapx_workspaces`
Workspace introspection with two actions:
- **`list`** — Returns all registered repos with stats (fileCount, symbolCount, edgeCount, crossRepoEdgeCount)
- **`discover`** — Discovers unregistered submodules, peer repos, and VS Code workspace folders

Parameters:
- `action` (string, required): `list` or `discover`
- `dir` (string, optional): Target project directory

### Language Management

#### `mapx_lang_list`
List supported languages and their status/tier.
- No parameters required

#### `mapx_lang_install`
Install a dynamic language grammar.
- `lang` (string, required): Language name to install

#### `mapx_lang_uninstall`
Uninstall a previously installed language grammar.
- `lang` (string, required): Language name to uninstall
