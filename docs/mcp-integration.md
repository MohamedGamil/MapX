# MCP Integration

MapxGraph can run as an MCP (Model Context Protocol) server, allowing LLM tools to interact with the code graph directly.

## Transports

MapxGraph supports two MCP transport modes:

| Transport | Flag | Use Case |
|-----------|------|----------|
| **stdio** | _(default)_ | Local development, CLI-based MCP clients (Claude Desktop, Cursor, opencode) |
| **SSE** | `--sse` | HTTP-based clients, remote access, browsers, multi-client |

## Starting the Server

If you installed MapX globally using npm (`npm install -g @mgamil/mapx`), start the server with:

### stdio (default)

```bash
mapx serve --dir /path/to/project
```

### SSE (HTTP)

```bash
mapx serve --sse --port 3456 --dir /path/to/project
```

### Or using zero-installation (via npx):

```bash
npx @mgamil/mapx serve --dir /path/to/project
npx @mgamil/mapx serve --sse --port 3456 --dir /path/to/project
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

**stdio (Global installation):**
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

**stdio (Zero installation via npx):**
```json
{
  "mcpServers": {
    "mapx": {
      "command": "npx",
      "args": ["-y", "@mgamil/mapx", "serve", "--dir", "/path/to/your/project"]
    }
  }
}
```

**stdio (From source):**
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

**stdio (Global installation):**
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

**stdio (Zero installation via npx):**
```json
{
  "mcpServers": {
    "mapx": {
      "command": "npx",
      "args": ["-y", "@mgamil/mapx", "serve", "--dir", "/path/to/your/project"]
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

**stdio (Global installation):**
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

**stdio (Zero installation via npx):**
```json
{
  "mcp": {
    "servers": {
      "mapx": {
        "command": "npx",
        "args": ["-y", "@mgamil/mapx", "serve", "--dir", "/path/to/your/project"]
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

**stdio (Global installation):**
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

**stdio (Zero installation via npx):**
```json
{
  "mcp": {
    "mapx": {
      "command": "npx",
      "args": ["-y", "@mgamil/mapx", "serve", "--dir", "/path/to/your/project"]
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

## Available Tools (33 total)

### Graph Building

#### `mapx_scan`
Full scan: parse all files, build graph.
- `dir` (string, optional): Target project directory

#### `mapx_sync`
Incremental update: sync changed files only. Like `mapx sync`, it re-parses the referrers of a removed file that comes back, and re-parses everything once when the include/exclude filters have changed since the last scan.
- `dir` (string, optional): Target project directory

### Symbol & File Discovery

#### `mapx_query`
Search symbols by name pattern. A class that declares Eloquent relationships lists them under `relationships:`, one per line, as `mapx query` does (`team → belongsTo App\Models\Team (many-to-one)`).
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
- `path` (string, optional): Filter by path prefix or glob pattern
- `lang` (string, optional): Filter by language
- `sort` (string, optional): Sort by `name`, `lines`, `size`, `pagerank`
- `limit` (number, optional): Max results
- `dir` (string, optional): Target project directory

### Dependencies & Flow

#### `mapx_dependencies`
Get file-level dependencies and reverse dependencies. A file that declares service-container bindings also gets a `Bindings (abstract → concrete)` block, as `mapx deps` does: closures show as `(closure)`, and `$listen` entries read `Event → Listener (listen)`.
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
- `include_leaf_libraries` (boolean, optional): Include high-import leaf libraries that are normally filtered out as stable foundations (default: `false`)
- `dir` (string, optional): Target project directory

#### `mapx_routes`
Show routes extracted from framework controllers or configuration.
- `framework` (string, optional): Filter by framework name
- `method` (string, optional): Filter by HTTP method (GET, POST, etc.)
- `pathPattern` (string, optional): Filter by route path (or request URL with `clients`)
- `clients` (`"all"` | `"unmatched"`, optional): Instead of routes, list frontend HTTP call sites with their resolved URL and the backend route each reaches; `"unmatched"` lists only calls that reach no live route. Pairing follows the rules of `mapx routes --clients`: literal path evidence, workspace hosts only (`settings.http.hosts`), and method `UNKNOWN` never paired
- `dir` (string, optional): Target project directory

Each route has the same fields as `mapx routes --json`: `line`, `name`, `middlewares`, `reachable`, `reachability` (`reachable`, `unreachable` or `unknown`), `overridden` (with `overriddenBy`), `conditional`, and `dynamic` and `domain` when they apply.

#### `mapx_hooks`
Show hooks from detected frameworks.
- `framework` (string, optional): Filter by framework name
- `type` (string, optional): Filter by hook type
- `dir` (string, optional): Target project directory

#### `mapx_edges`
Structured edge neighbourhood of a file, JSON by default. With `file` it returns the same `{ file, direction, incoming[], outgoing[] }` object as `mapx edges <file> --format json` (decision D012): incoming rows carry `sourceFile`, outgoing rows `targetFile` and `targetRepo`, and both carry `type`, `sourceSymbol`, `targetSymbol`, `verifiability`, `weight` and `line`. Without `file` it returns the flat JSON array of edges (`sourceFile`, `targetFile`, …, `metadata`). `format: "text"` gives the CLI's text output.
- `file` (string, optional): File whose edges to list (workspace-relative or absolute)
- `direction` (string, optional): Needs `file`: `outgoing`, `incoming` or `both` (default)
- `type` (string array, optional): Edge types to include, e.g. `["relation", "extends"]`; a comma-separated string also works
- `verifiedOnly` (boolean, optional): Leave out inferred edges
- `format` (string, optional): `json` (default) or `text` (alias `llm`)
- `from` (string, optional): Originating file path pattern
- `to` (string, optional): Target file path pattern
- `dir` (string, optional): Target project directory

### Analysis

#### `mapx_impact`
Change impact analysis — blast radius and risk for modifying a symbol.
- `symbol` (string, required): Symbol name
- `depth` (number, optional): Max traversal depth
- `dir` (string, optional): Target project directory

#### `mapx_clusters`
List detected code clusters/modules.
- `source` (string, optional): Filter by source (`layer`, `community`, `namespace`, `directory`, `all`)
- `dir` (string, optional): Target project directory

#### `mapx_status`
Check scan status, language breakdown, PageRank rankings, and index recommendations.
- `dir` (string, optional): Target project directory

#### `mapx_metrics`
Structural coupling metrics per file, ranked by total degree (in + out, then PageRank). Same output as `mapx metrics`: the F02 ranked table, or with `format: "json"` the D012 object `{ dir, generatedAt, summary: { files, edges, density }, files: [{ path, language, inDegree, outDegree, totalDegree, instability, pagerank }] }`.
- `lang` (string, optional): Only list files of this language
- `verifiedOnly` (boolean, optional): Only verified edges
- `format` (string, optional): `text` (default; alias `llm`) or `json`
- `top` (number, optional): Number of files (default 20); `0` returns every file
- `exclude` (string, optional): Comma-separated globs; matching files and their edges are left out
- `dir` (string, optional): Target project directory

#### `mapx_profile`
Retrieve codebase profile (archetype, frameworks, active taxonomy).
- `dir` (string, optional): Target project directory

#### `mapx_explain`
Explain file architectural role classification details and signal weights.
- `file` (string, required): File path to analyze
- `reclassify` (boolean, optional): Re-run classification on-the-fly
- `dir` (string, optional): Target project directory

#### `mapx_smells`
Detect design smells and potential architectural violations.
- `dir` (string, optional): Target project directory

#### `mapx_dsm`
Generate the cluster-level Dependency Structure Matrix (DSM).
- `dir` (string, optional): Target project directory

#### `mapx_layers`
List files grouped by active dynamic architectural roles.
- `dir` (string, optional): Target project directory

### Export & LLM Prompts

#### `mapx_export`
Export compact graph summary.
- `format` (string, optional): `llm`, `json`, `dot`, `svg`, `toon` (default: `llm`)
- `tokens` (number, optional): Token budget for LLM format (default: 8192)
- `repo` (string, optional): Filter by repo name
- `dir` (string, optional): Target project directory

#### `mapx_context`
Intelligent, token-budgeted workspace context builder for LLM prompts.
- `task` (string, required): Describe your prompt target
- `seeds` (array of strings, optional): Seed files/symbols to expand around
- `tokens` (number, optional): Estimated token limit
- `depth` (number, optional): Graph depth traversal limit
- `dir` (string, optional): Target project directory

### Workspace Management

#### `mapx_workspaces`
Workspace introspection with two actions:
- **`list`** — Returns all registered repos with stats: `type` (`primary`, `submodule`, `vscode-workspace`, `peer`), `fileCount`, `symbolCount`, `edgeCount`, `crossRepoEdgeCount`, `lastScanned` and `headCommit`. Also returns a top-level `crossRepoEdgeCount`, the per-pair `crossRepoEdges`, and the unregistered discoveries.
- **`discover`** — Discovers unregistered submodules, VS Code workspace folders, nested repos and monorepo packages; peer repos only with `includePeers`

Parameters:
- `action` (string, required): `list` or `discover`
- `includePeers` (boolean, optional, default false): also discover sibling git repositories
- `dir` (string, optional): Target project directory

### Language Management

Every grammar ships bundled with MapX; there is nothing to download or install. The output matches `mapx lang list` and `mapx lang info`.

#### `mapx_lang_list`
List supported languages with their extensions, file names (e.g. `Rakefile`) and tier.
- No parameters required

#### `mapx_lang_info`
Show a language's tier, extensions, file names and resolved grammar and query files.
- `lang` (string, required): Language name
- An unknown language returns an error result (`isError: true`)

#### `mapx_lang_install` / `mapx_lang_uninstall`
Compatibility no-ops: they report that the grammar is bundled and nothing is installed or removed. To skip a language's files, use an exclude pattern.
- `lang` (string, required): Language name; an unknown or missing language returns an error result (`isError: true`)

### Orchestration & LLM Helpers

#### `mapx_batch`
Execute multiple operations in a single round-trip.
- `operations` (array, required): Operations list containing `{ tool, args }`
- `maxItems` (number, optional): Max operations limit

#### `mapx_agents_generate`
Generate or update project-level agent integration instructions and rule files.
- `providers` (array of strings, optional): Specific integration providers
- `all` (boolean, optional): Generate configs for all providers
- `force` (boolean, optional): Overwrite files without prompting
- `dir` (string, optional): Target project directory

The result lists each file. It also reports when a merged JSONC settings file lost its comments, and when `.aider.conf.yml` was skipped because it already sets `read:`.
