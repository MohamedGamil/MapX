# MCP Integration

CodeGraph can run as an MCP (Model Context Protocol) server, allowing LLM tools to interact with the code graph directly.

## Transports

CodeGraph supports two MCP transport modes:

| Transport | Flag | Use Case |
|-----------|------|----------|
| **stdio** | _(default)_ | Local development, CLI-based MCP clients (Claude Desktop, Cursor, opencode) |
| **SSE** | `--sse` | HTTP-based clients, remote access, browsers, multi-client |

## Starting the Server

### stdio (default)

```bash
codegraph serve --dir /path/to/project
```

On startup, prints ready-to-copy configuration for Claude Desktop, Cursor, and VS Code.

### SSE (HTTP)

```bash
codegraph serve --sse --port 3456 --dir /path/to/project
```

Options:
- `--sse` — Enable SSE transport (HTTP) instead of stdio
- `--port <port>` — Port to listen on (default: 45123)
- `--dir / -d` — Default target directory for MCP tools

On startup, prints the SSE URL, messages endpoint, and ready-to-copy configuration.

### Startup Output

Both modes print configuration snippets on startup:

```
  CodeGraph MCP server ready.

  Transport:    stdio
  Project dir:  /path/to/project

  Claude Desktop (claude_desktop_config.json):
  ```json
  {
    "mcpServers": {
      "codegraph": {
        "command": "codegraph",
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
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--dir", "/path/to/your/project"]
    }
  }
}
```

Or with `npx tsx` from source:
```json
{
  "mcpServers": {
    "codegraph": {
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
    "codegraph": {
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
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--dir", "/path/to/your/project"]
    }
  }
}
```

**SSE:**
```json
{
  "mcpServers": {
    "codegraph": {
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
      "codegraph": {
        "command": "codegraph",
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
      "codegraph": {
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
    "codegraph": {
      "command": "codegraph",
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
- If the current working directory contains a `.codegraph/config.json` file, it is used as the default.
- Otherwise no default is set, and every tool call **must** include a `dir` argument. Missing it returns an error:
  ```
  No project directory set. Either pass a "dir" argument or start the server with --dir /path/to/project.
  ```

The active directory is always printed to stderr at startup:
```
[codegraph] Default project directory: /path/to/project
```

## Available Tools

### `codegraph_scan`

Scans the codebase and builds/updates the graph.

**Parameters:**
- `dir` (string, optional): Target project directory

**When to use:** At the start of a session or after files have changed.

### `codegraph_query`

Searches for symbols by name pattern.

**Parameters:**
- `term` (string, required): Symbol name or pattern
- `dir` (string, optional): Target project directory

**When to use:** When you need to find where a class, function, or method is defined.

### `codegraph_dependencies`

Gets dependencies and reverse dependencies for a file.

**Parameters:**
- `file` (string, required): File path to analyze
- `dir` (string, optional): Target project directory

**When to use:** When you need to understand how a file relates to other files.

### `codegraph_export`

Exports a compact, token-efficient summary of the code graph.

**Parameters:**
- `format` (string, optional): `llm`, `json`, `dot`, or `svg` (default: `llm`)
- `tokens` (number, optional): Token budget for LLM format (default: 8192)
- `repo` (string, optional): Filter by repo name
- `dir` (string, optional): Target project directory

**When to use:** At the start of a session to get an overview of the codebase.

### `codegraph_status`

Checks what files have changed since the last scan.

**Parameters:**
- `dir` (string, optional): Target project directory

**When to use:** To determine if a re-scan is needed.
