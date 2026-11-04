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

## Available Tools (39 total)

### Graph Building

#### `mapx_scan`
Full scan: parse all files, build graph. Unchanged files are not re-parsed, except the referrers of a removed file whose referenced names a new or changed file now holds (a moved class), and the `.vue` files using a tag whose Vue global registration changed or the files navigating to a Vue Router route that changed, as `mapx scan` does.
- `dir` (string, optional): Target project directory
- `repo` (string, optional): Scan only this registered repository. Without it, every registered repository is scanned (as `all: true`), so a workspace root's nested repos are covered too
- `all` (boolean, optional): Scan all registered repositories (the default)
- `force` (boolean, optional): Re-parse every file, as `mapx scan --force`
- `parallel` (boolean, optional): Parse on worker threads when the work repays them (default `true`; `settings.parseWorkers` sizes the pool); `false` parses on the main thread, as `--no-parallel`
- `exclude`, `include` (string, optional): Comma-separated glob patterns added to the configured exclude and include patterns for this scan, as `--exclude` and `--include`

#### `mapx_sync`
Incremental update: sync changed files only. Like `mapx sync`, it re-parses the referrers of a removed file that comes back, drops the old path of a git rename and re-parses its referrers, re-parses the referrers of a removed file when a new or changed file names what they referenced in it (the target moved), re-parses the `.vue` files using a tag whose Vue global registration changed (`app.component` added, removed or retargeted) or navigating to a route record that changed (renamed, another component), skips a file git lists whose blob is the one indexed, drops a deleted file that was indexed while untracked or only staged, re-indexes an edit reverted to the committed content, keeps both files of a `git mv` that left a copy behind, indexes gitignored files as a scan does, leaves the files of a nested registered repo to that repo, and re-parses everything once when the include/exclude filters have changed since the last scan.
- `dir` (string, optional): Target project directory
- `repo` (string, optional): Sync only this registered repository. Without it, every registered repository is synced (as `all: true`)
- `all` (boolean, optional): Sync all registered repositories (the default)
- `parallel` (boolean, optional): As for `mapx_scan` (default `true`)
- `exclude`, `include` (string, optional): Comma-separated glob patterns added to the configured ones for this sync

The server keeps one pool of parse workers across `mapx_scan` and `mapx_sync` calls, so a call reuses the workers and grammars of the previous one. The workers close after `MAPX_WORKER_IDLE_MS` milliseconds without work (default 60000); see [Parallel parsing](configuration.md#parallel-parsing).

### Symbol & File Discovery

#### `mapx_query`
Search symbols by name pattern. A class that declares Eloquent relationships lists them under `relationships:`, one per line, as `mapx query` does (`team → belongsTo App\Models\Team (many-to-one)`).
- `term` (string, required): Symbol name or pattern
- `dir` (string, optional): Target project directory

#### `mapx_search`
Advanced filtered symbol search.
- `term` (string, required): Symbol name, glob pattern (`*` and `?`), or `*` to list all; case-insensitive
- `kind` (string, optional): Filter by symbol kind: `class`, `method`, `function`, `interface`, `trait`, `constant`, `enum`, `property`, `namespace`, `struct`, `module` or `field`
- `file` (string, optional): Filter by file path prefix
- `exact` (boolean, optional): Exact name match
- `limit` (number, optional): Max results (default: 20)
- `format` (string, optional): `text` (default) or `json`
- `dir` (string, optional): Target project directory

#### `mapx_node`
Deep inspection of a specific symbol node.
- `symbol` (string, required): Symbol name, `Class::method` or `Class.method`. A name that itself contains a dot (`api.get`) opens by that name unless a class `api` has a member `get`; `scope::api.get` is unambiguous
- `source` (boolean, optional): Include source code
- `include_members` (boolean, optional): List the member symbols (methods, properties) of a class, interface or trait, as `mapx node --include-members`
- `format` (string, optional): `text` (default) or `json`
- `dir` (string, optional): Target project directory

#### `mapx_files`
List and filter project files.
- `path` (string, optional): Filter by path prefix or glob pattern
- `lang` (string, optional): Filter by language
- `sort` (string, optional): `path` (default, ascending) or `lines` (descending)
- `limit` (number, optional): Max results (default: 50)
- `dir` (string, optional): Target project directory

### Dependencies & Flow

#### `mapx_dependencies`
Get file-level dependencies and reverse dependencies. A file that declares service-container bindings also gets a `Bindings (abstract → concrete)` block, as `mapx deps` does: closures show as `(closure)`, and `$listen` entries read `Event → Listener (listen)`.
- `file` (string, required): File to analyze, resolved as `mapx deps` resolves it: an exact indexed path, a glob (`app/Providers/*.php`) or a partial name (`AppServiceProvider`). Several matches each get a `── path ──` section; no match returns `File "…" not found in index.` as an error
- `crossRepo` (boolean, optional): List only the edges that cross into or come from another registered repository, as `mapx deps --cross-repo` does (`→ [repo] file (type)` / `← [repo] file (type)`)
- `dir` (string, optional): Target project directory

#### `mapx_callers`
Trace direct and nested callers of a symbol.
- `symbol` (string, required): Symbol name or scoped name (`UserService::findAll`)
- `depth` (number, optional): Max traversal depth (default 1: direct callers; 2 or more is transitive)
- `dir` (string, optional): Target project directory

#### `mapx_callees`
Trace direct and nested callees of a symbol.
- `symbol` (string, required): Symbol name or scoped name
- `depth` (number, optional): Max traversal depth (default 1)
- `dir` (string, optional): Target project directory

#### `mapx_trace`
Trace data flow paths from a starting symbol or file.
- `start` (string, required): Starting symbol (`UserController::store`) or file path
- `direction` (string, optional): `up`, `down` or `both` (default)
- `depth` (number, optional): Max traversal depth (default 3)
- `format` (string, optional): `text` (default), `dot` or `json`
- `include_structural` (boolean, optional): Also follow structural edges such as `import` and `extends` (default `false`)
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
- `clients` (`"all"` | `"unmatched"`, optional): Instead of routes, list frontend HTTP call sites with their resolved URL and the backend route each reaches; `"unmatched"` lists only calls that reach no live route. Pairing follows the rules of `mapx routes --clients`: literal path evidence, workspace hosts only (`settings.http.hosts`, `.env*` URLs, client base URLs, literal `Route::domain()` hosts), and method `UNKNOWN` never paired
- `dir` (string, optional): Target project directory

Each route has the same fields as `mapx routes --json`: `line`, `name`, `middlewares`, `reachable`, `reachability` (`reachable`, `unreachable` or `unknown`), `overridden` (with `overriddenBy`), `conditional`, and `dynamic` and `domain` when they apply.

#### `mapx_hooks`
Show hooks from detected frameworks.
- `framework` (string, optional): Filter by framework name
- `type` (string, optional): Filter by hook type
- `namePattern` (string, optional): Filter by hook name pattern
- `dir` (string, optional): Target project directory

#### `mapx_edges`
Structured edge neighbourhood of a file, JSON by default. With `file` it returns the same `{ file, direction, incoming[], outgoing[] }` object as `mapx edges <file> --format json` (decision D012): incoming rows carry `sourceFile` and `sourceRepo`, outgoing rows `targetFile` and `targetRepo` (the other repo of a cross-repo edge, else `null`), and both carry `type`, `sourceSymbol`, `targetSymbol`, `verifiability`, `weight` and `line`. A file's neighbourhood includes the edges of every registered repo of the workspace. A file that is not indexed and has no edges returns `File "…" is not indexed.` as an error. Without `file` it returns the flat JSON array of the primary repo's edges (`sourceFile`, `targetFile`, …, `metadata`). `format: "text"` gives the CLI's text output.
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
- `symbol` (string, required): Symbol name or scoped name (`ClassName::method`)
- `depth` (number, optional): Max traversal depth (default 3)
- `dir` (string, optional): Target project directory

#### `mapx_clusters`
List detected code clusters/modules.
- `source` (string, optional): Filter by source (`layer`, `community`, `namespace`, `directory`, `all`)
- `cluster` (string, optional): Inspect one cluster by name
- `dir` (string, optional): Target project directory

#### `mapx_status`
Check scan status, language breakdown, PageRank rankings, and index recommendations. The changed-file count is the git changes plus the stale files git does not list, such as a new file in a nested repo or in a workspace that is not a git repository; the other tools' `Index is stale` warning names them too (see [Staleness warning](cli-reference.md#staleness-warning)).
- `exclude` (string array, optional): Globs; the changed files they match are not reported or counted, e.g. `["src/**"]`. A comma-separated string also works
- `include` (string array, optional): Globs; only the changed files they match are reported. An exclude wins over an include. In both, a comma inside an element splits it (`["a/**,b/**"]` is two globs) and empty globs are ignored, as in the CLI. The result lists the changed files (`+` added, `~` modified, `-` removed, `>` renamed) as `mapx status` does, and equals `mapx status --exclude … --include …` with the same patterns
- `limit` (number, optional): Max changed files listed (default 50; `0` lists every one). The count line is always the total, and a cut list ends with `… N more (showing L of T; pass limit: 0 to list all)`
- `dir` (string, optional): Target project directory

#### `mapx_metrics`
Structural coupling metrics per file, ranked by total degree (in + out, then PageRank). Same output as `mapx metrics`: the F02 ranked table, or with `format: "json"` the D012 object `{ dir, generatedAt, summary: { files, edges, density }, files: [{ path, language, inDegree, outDegree, totalDegree, instability, pagerank }] }`.
- `lang` (string, optional): Only list files of this language
- `verifiedOnly` (boolean, optional): Only verified edges
- `format` (string, optional): `text` (default; alias `llm`) or `json`
- `top` (number, optional): Number of files (default 20); `0` returns every file
- `exclude` (string, optional): Comma-separated globs; matching files and their edges are left out, and a glob naming a folder (`**/Http`) leaves out the files under it, as at scan time
- `dir` (string, optional): Target project directory

#### `mapx_profile`
Retrieve codebase profile (archetype, frameworks, active taxonomy).
- `repo` (string, optional): The repo whose profile to return (default: the workspace's)
- `dir` (string, optional): Target project directory

#### `mapx_explain`
Explain file architectural role classification details and signal weights, from the signals the last scan stored.
- `file` (string, required): File path to analyze (relative to the project root)
- `dir` (string, optional): Target project directory

#### `mapx_smells`
Detect design smells and potential architectural violations. With `.mapx/architecture.jsonc`, layer violations come from the rules instead of the file roles, and the rule-derived smells join them, each with a `Source:` line and, for layer-level ones, a `Layers:` line, as `mapx arch --smells` prints them. Without one, the output is unchanged. See [architecture-rules.md](architecture-rules.md#smells).
- `dir` (string, optional): Target project directory
- `repo` (string, optional): The repo whose smells to list (default: the workspace's)

#### `mapx_dsm`
Generate the cluster-level Dependency Structure Matrix (DSM).
- `repo` (string, optional): The repo whose DSM to return (default: the workspace's)
- `dir` (string, optional): Target project directory

#### `mapx_layers`
List files grouped by active dynamic architectural roles.
- `repo` (string, optional): The repo whose files to list (default: the workspace's)
- `dir` (string, optional): Target project directory

#### `mapx_arch_validate_config`
Validate the [architecture rules](architecture-rules.md) configuration, `.mapx/architecture.jsonc` or a view, with every document it extends, as `mapx arch validate-config` does. It needs no index. The result is JSON: `{ valid, view, files, issues: [{ file, pointer, message }] }`, every problem at once in document order, plus `policy` for a valid configuration: the resolved `policy.uncovered` and why packages are or are not reported (M5-24-R4). An invalid or missing configuration is a tool error (`isError`), as the CLI exits 3.
- `view` (string, optional): Validate `.mapx/architecture/<view>.jsonc`
- `format` (string, optional): `json` (default) or `text`, one `file#pointer: message` line per problem, as the CLI prints
- `dir` (string, optional): Target project directory

### Architecture Rules (AR-19)

These five tools answer from the same library functions as `mapx check` and the `mapx arch` subcommands, so the CLI and MCP give the same answers. The JSON shapes are in [architecture-rules.md](architecture-rules.md#introspection), and [its MCP section](architecture-rules.md#mcp-tools) maps each tool to its CLI command, with example calls on a sample project. Every tool returns JSON by default, and lists are capped by `limit` with the total reported: `mapx_arch_check` with `{ "rule": "disallowed-layer", "limit": 1 }` returns one finding and `"exitCode": 1, "total": 4, "limit": 1, "truncated": true` when there are four.

The configuration the tools read is described in [architecture-rules.md](architecture-rules.md); MapX's own, `.mapx/architecture.jsonc` in this repository, is a worked example ([MapX's own rules](architecture-rules.md#mapxs-own-rules)).

**Errors.** A failure is a tool result with `isError: true`, never a JSON-RPC error. Its JSON is `{ error, exitCode, issues?, candidates? }`, where `exitCode` has its [AR-17 meaning](cli-reference.md#mapx-check):
- `3`: a configuration or usage error. Examples: no or an invalid `.mapx/architecture.jsonc`, an unknown layer, an element no query resolves, a bad `type`, `limit` or `since`.
- `4`: the index is missing, unscanned, stale or built by an older MapX. `sync: true` brings a stale index up to date first.

A violation, or a refused dependency, is an answer rather than an error: it carries `exitCode: 1` in a normal result.

**Arguments are checked before the index**, as the CLI parses its options first. A bad `format`, `failOn`, `type`, `limit` or `since` is therefore exit 3, even on a stale index. A non-string `dir` is exit 3 too.

**The agent workflow.** Before adding an import across modules, an agent calls `mapx_arch_allowed`. If the answer is `allowed: false`, it may use one of the `alternatives`, each of which the rules allow. After editing, it calls `mapx_arch_check` with `sync: true`, narrowed with `file` or `since`. Without `sync: true`, every architecture tool refuses an index older than the edits (exit 4).

**What the server writes.** The server logs tool calls to `.mapx/tool-calls.jsonl` of the first workspace it is called on that already has a `.mapx/` folder. It never creates a workspace or a `.mapx/` folder. `mapx_arch_init` without `write: true` is never logged, so its workspace stays byte-identical.

#### `mapx_arch_check`
Checks the rules against the index, as `mapx check --format json` does. The result is the report: `{ version, counts, findings, layers, layerEdges, configErrors, selection, policy }` (`policy`: the resolved `policy.uncovered`, M5-24-R4). Four fields are added:
- `exitCode`: 0, 1 for violations, or 2 for uncovered dependencies with `failOnUncovered`;
- `total`: the findings shown before the cap;
- `limit`;
- `truncated`.

A configuration or baseline error is a tool error carrying the report of errors, with `exitCode: 3`.
- `layer`, `rule` (string, optional): As `--layer` and `--rule`.
- `file` (string, optional): Keep only the findings with an end under this path, or matching this glob. A path that matches no indexed file is an error.
- `since` (string, optional): The ratchet of `mapx check --since`: keep only the findings on dependencies whose source file changed on this branch since this git revision: the working tree (committed, staged, unstaged) against the merge base of the revision and HEAD, plus untracked files. Commits the revision gained after the branch left it do not count, which differs from `mapx arch changed --since`, whose base is the revision itself. A changed target alone does not count. `selection.since` in the answer names the revision. It is refused (exit 3) when it is not a revision of the repository, or when it starts with `-` or contains whitespace, quotes or shell characters.
- `failOn` (`error`|`warn`), `reportUncovered`, `failOnUncovered`, `reportSkipped`, `reportAllowed` (optional): As the CLI options.
- `limit` (number, optional): The most findings to return (default 50; 0 returns all of them). Counts always cover every finding.
- `format` (string, optional): `json` (default), or `text` for the whole table `mapx check` prints. `limit` does not apply to `text`.
- `view`, `sync`, `dir` (optional).

#### `mapx_arch_layers`
Answers what `mapx arch layers` and `mapx arch unassigned` answer (AR-13a–c):
- **Without arguments:** `{ layers: [{ name, overlay, elements, files }] }`.
- **With `layer`:** the layer's files and top-level symbols, `{ name, overlay, elements, files, total, members, truncated }`. `why: true` names the selector that matched each member (for a hierarchy selector such as `extends`, also `chain`, the inheritance path that matched), and `nested: true` adds the members of types.
- **With `unassigned: true`:** the elements in no layer, `{ total, elements, truncated }`, narrowed by `kind` and `path`.

Parameters:
- `layer`, `why`, `nested`, `unassigned`, `kind`, `path` (optional).
- `limit` (number, optional): Default 100; 0 returns every item.
- `view`, `sync`, `dir` (optional).

#### `mapx_arch_allowed`
The pre-flight check: may `from` depend on `to`? Each end is a layer, a file or a symbol. `to` can also be a package or built-in outside the workspace, by name or as `<ecosystem>:<name>` (`npm:pg`; M5-24). A bare name that is a direct dependency is the package before a same-named workspace symbol, and a package a manifest near `from` lists, or a built-in (`node:path`), is decided before any file uses it (review of M5-24-R3). The answer is `mapx arch allowed --json`:

`{ from, to, edgeType, allowed, rule, severity, reason, exitCode, decisions, allowedTypes, allowedLayers, alternatives }`

- **`alternatives`:** for a refused dependency on a file or symbol, the source's own and allowed layers that already expose a matching symbol. Each entry is `{ layer, total, symbols: [{ element, kind, symbolKind, file, match }] }`. `match` is `supertype` (a class or interface the target extends or implements) or `name` (a symbol named like the target, or like the end of its name). Every symbol listed is itself allowed from `from`, through the whole decision chain: layers, private parts, `@internal` markers and scope.

Parameters:
- `from`, `to` (string, required).
- `type` (string, optional): Decide for this edge type only.
- `view`, `sync`, `dir` (optional).

#### `mapx_arch_explain`
Explains why an element is in its layers, and why a dependency is allowed or a violation. The result is `{ element, layer?, dependency? }`:
- `element` is `mapx arch which <element> --json`, the selector trace of every match.
- `layer` is `{ name, matches: [{ element, inLayer, selector?, via?, chain? }] }`. `chain` is a hierarchy match's inheritance path, as in the `which` trace.
- `dependency` is the `mapx_arch_allowed` answer for `element` → `to`, the rule trace.

Parameters:
- `element` (string, required).
- `layer`, `to`, `type` (optional).
- `view`, `sync`, `dir` (optional).

#### `mapx_arch_init`
Proposes a configuration from the index (AR-15), as `mapx arch init --json` does: the same engine (`src/arch/infer.ts`), the same bytes. See [cli-reference.md](cli-reference.md#mapx-arch-init) for the sources and the JSONC it writes.
- By default, one layer per MapX role (`{ "role": … }`), in the order of the archetype's `LAYER_ORDER`. Each layer may depend on the layers below it. Roles with no place in the order are listed as `unplaced`.
- `from: "clusters"`: one layer per primary cluster; the rules allow the dependencies between clusters the index has today.
- `from: "framework"`, or `preset`: a configuration that extends a shipped preset (`mapx:preset/<id>`), its folder parameter inferred from the indexed paths. `from: "framework"` takes the preset of the detected framework (laravel, nestjs or django) and is an error (`exitCode: 3`) when none is detected.
- The JSONC comments give each layer's files and the observed layer graph; `observed` has the same as data.

The result is `{ path, view, exists, written, source, preset, archetype, parameters, layers: [{ name, files, role?, cluster?, path? }], unplaced, unclassified: { name, paths, files } | null (the code no layer selects, every layer's to use; review of M5-17-R1), observed: [{ from, to, dependencies, violations }], violations, baseline: { path, entries, exists, written } | null, issues, notes, warnings, config }`, where `config` is the JSONC text.

**It writes nothing unless `write: true`.** Each of these is refused as a tool error (`exitCode: 3`) that writes nothing:
- an existing configuration or baseline, unless `force: true`;
- a proposal whose every layer is empty, unless `force: true` (`warnings` says so in a dry run);
- a target that is a symlink, or that resolves outside the workspace, even with `force`.

The files are staged and replaced together, so a failed write is also `exitCode: 3` and leaves the configuration and baseline as they were. A proposal reads roles and paths, so a stale index is accepted, except with `baseline: true`, which lists today's violations and needs a current index (`exitCode: 4`, or `sync: true`). The proposal is a starting point to review.
- `from` (string, optional): `roles` (default), `clusters` or `framework`.
- `preset` (string, optional): `aspnet`, `clean`, `ddd-contexts`, `django`, `express`, `fastapi`, `feature-sliced`, `flutter`, `hexagonal`, `laravel`, `layered`, `mvc`, `mvvm`, `nestjs`, `nextjs`, `onion`, `rails`, `spring`, `symfony` or `vue`. It excludes `from`.
- `baseline` (boolean, optional): Also propose, and with `write` write, the baseline of today's violations (`.mapx/architecture.baseline.json`, or the view's), so `mapx check` passes on day one.
- `write` (boolean, optional): Write `.mapx/architecture.jsonc`, or the view.
- `force` (boolean, optional): With `write`, overwrite an existing configuration and baseline.
- `view` (string, optional): Propose `.mapx/architecture/<view>.jsonc` instead. A view that leads outside `.mapx/architecture/` is refused.
- `sync`, `dir` (optional).

### Export & LLM Prompts

#### `mapx_export`
Export compact graph summary.
- `format` (string, optional): `llm`, `json`, `dot`, `svg`, `toon` (default: `llm`)
- `tokens` (number, optional): Token budget for the LLM and TOON formats (default: 8192)
- `repo` (string, optional): Filter by repo name
- `all` (boolean, optional): LLM format only. Produces the combined multi-repo export of `mapx export --all`: the repo list, the cross-repo dependencies, then one `## <repo>` section per repo
- `exclude`, `include` (string, optional): Comma-separated glob patterns; matching files are left out of, or kept in, the export, as `mapx export --exclude` / `--include`
- `cluster` (string, optional): DOT/SVG: `none` (default) or `auto` (the cluster-level view)
- `depth` (number, optional): DOT/SVG: maximum cluster nesting depth (default 3)
- `fallback_grid` (boolean, optional): SVG: always use the built-in renderer, as `--fallback-grid`
- `dir` (string, optional): Target project directory

#### `mapx_context`
Intelligent, token-budgeted workspace context builder for LLM prompts.
- `task` (string, required): Describe your prompt target
- `seeds` (array of strings, optional): Seed files/symbols to expand around
- `tokens` (number, optional): Token budget (default 8192)
- `depth` (number, optional): Graph traversal depth from the seeds (default 2)
- `dir` (string, optional): Target project directory

### Workspace Management

#### `mapx_workspaces`
Workspace introspection with two actions:
- **`list`** — Returns the workspace `root` and all registered repos with stats: F18's `path` (absolute), `relativePath` (as registered, relative to the root), `isRegistered`, `isInitialised` (the folder exists and, for a submodule, has its own checkout), `type` (`primary`, `submodule`, `vscode-workspace`, `peer`, or `folder` for a directory without its own checkout), `fileCount`, `symbolCount`, `edgeCount`, `crossRepoEdgeCount`, `lastScanned` and `headSha` (the repo's own HEAD; `null` for a `folder`). Uninitialised submodules that are not registered follow, with `isRegistered: false`, `isInitialised: false` and empty stats, as in the `mapx workspaces` table. Also returns a top-level `crossRepoEdgeCount`, the per-pair `crossRepoEdges`, and the unregistered discoveries.
- **`discover`** — Discovers unregistered submodules, VS Code workspace folders, nested repos and monorepo packages; peer repos only with `includePeers`

Parameters:
- `action` (string, optional): `list` (default) or `discover`
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
- `maxItems` (number, optional): Max operations limit (default 10)
- `dir` (string, optional): Target project directory

#### `mapx_agents_generate`
Generate or update project-level agent integration instructions and rule files.
- `providers` (array of strings, optional): Specific integration providers
- `all` (boolean, optional): Generate configs for all providers
- `force` (boolean, optional): Overwrite files without prompting
- `dir` (string, optional): Target project directory

The result lists each file. For `continue` these are `.continue/mcpServers/mapx.yaml` and the four `.continue/prompts/mapx-*.md` slash-command prompts; a legacy `.continue/mapx.yaml` that still has a mapx block is reported as `Removed` (a legacy block edited after mapx wrote it needs `force: true`). It also reports when a merged JSONC settings file lost its comments, and when `.aider.conf.yml` was skipped because it already sets `read:`.
