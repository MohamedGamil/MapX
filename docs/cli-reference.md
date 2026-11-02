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

In a terminal at least 64 columns wide, init first prints the MapX logo as text art in `#ff02fe`. It uses 24-bit colour where the terminal reports it, otherwise the nearest 256 colour, and prints the logo plain under `NO_COLOR`. The logo is never printed in a pipe or in CI, and `MAPX_NO_BANNER=1` turns it off.

Initialize MapxGraph in the current project. Creates `.mapx/` directory, `AGENTS.md`, and auto-adds `.mapx/` to `.gitignore`.

```bash
mapx init [/path] [--name <repo-name>] [--no-agents] [--no-suggestions] [--no-mcp-configs] [--no-discover] [--no-workspaces]
```

Options:
- `[path]` — Target directory (positional)
- `--name` — Custom repository name (defaults to directory name)
- `--no-agents` — Skip AGENTS.md creation
- `--no-suggestions` — Skip interactive framework suggestions
- `--no-mcp-configs` — Skip auto-generating MCP config files for detected agent tools
- `--no-discover` — Skip the monorepo / nested-repo discovery step
- `--no-workspaces` — Skip the submodule and VS Code workspace step

The init command also:
- Detects Laravel projects and offers to add framework-specific exclusions
- Prompts for LLM provider selection (generic, Claude, Cursor, VS Code, opencode)
- **Auto-detects installed agent tools** (opencode, Gemini CLI, Cursor, VS Code, Antigravity) and generates MCP server config files so mapx is immediately available as an MCP server
- **Discovers monorepo packages and nested git repositories** — prompts (Y/N, default Y) to register them immediately after init. Individual multi-select lets you choose exactly which packages / repos to track. Pass `--no-discover` to skip.
- **Detects submodules and VS Code workspace folders**: lists the `.gitmodules` entries (initialised or not) and the repos named in a `*.code-workspace` file, then asks whether to register them. Without a TTY it only reports them and suggests `mapx workspaces sync`. Pass `--no-workspaces` to skip.
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
- Revert LLM integration files (deleting files created solely by mapx, including files left with only mapx's front matter such as Continue prompts and the legacy `.continue/mapx.yaml`, or removing sentinel blocks from files that were appended to)
- Remove `.mapx/` directory from `.gitignore`
- Delete `.mapx/` directory completely

## `mapx scan`

Perform a full scan of all source files. Builds the graph from scratch. Without `--repo`, every registered repository is scanned, as with `--all`: run at a workspace root, `mapx scan` covers the nested repos registered there as well as the root repo.

- Shows real-time progress: discover, index, and parse phases
- File reads are parallelized for faster scanning
- Survives interruptions: progress is saved per-file, re-run to resume
- Unchanged files are not re-parsed. The exception is a moved target: when a file is removed, the names its referrers resolved into it are remembered, and when a new or changed file names one of them, those referrers are re-parsed, so a class moved to another file is found at its new path without `--force`
- Vue global components: when a new, changed or deleted JS/TS file adds, removes or retargets a `Vue.component` / `app.component` registration (or a `.vue` file joins or leaves an auto-registered folder), the unchanged `.vue` files using that tag are re-parsed, and no others. Likewise, when a Vue Router route record is added, removed, renamed or given another component or redirect, the unchanged `.vue` files and JS/TS modules navigating to it are re-parsed. Each Vue app (the nearest folder with a bundler config, or a `package.json` listing a build tool such as vite or `@vue/cli-service`, whatever the root `package.json` lists) keeps its own global registry and route table; a component library (vue as a peer dependency, a library build, or a published entry) shares its registrations with every app, and a component another app's registering file imports also sees that app's registrations. Where two files of an app register one name, the first by path wins. Adding or removing a `package.json` re-parses the files whose app changed and the files that navigate
- In a git repo, each file stores its blob id at HEAD (also for a repo that is not at the workspace root), unless the working-tree content differs from HEAD
- Scanning several repos (the default, or `--all`), the result does not depend on the order of the registered repos: a repo resolved before another repo of the run was indexed, and the files a repo parsed before another repo of the run changed, are resolved once more at the end; files of one repo that referenced a file another repo removed and restored are re-parsed. As within one repo, an unchanged file is not re-parsed because another repo gained a symbol it could now link to
- A symbol named by several files resolves to the one nearest the referencing file (most shared leading folders), then the first by path, so a scan and a sync pick the same file

```bash
mapx scan [/path] [--exclude <glob>] [--include <glob>] [--repo <name>] [--all] [--force] [--no-parallel]
```

Options:
- `--exclude` — Exclude glob patterns (repeatable)
- `--include` — Include glob patterns (repeatable)
- `--repo` — Scan only a specific registered repository
- `--all` — Scan all registered repositories (the default). A registered repo whose folder is missing is skipped with a warning and keeps its index
- `--force` — Force re-parsing of all files (bypasses file caching and rebuilds all symbols and edges)
- `--no-parallel` — Parse on the main thread only. By default, a batch large enough to repay worker startup (about 768 KB of source) parses on worker threads, sized from the source, the CPUs and the available memory; see `settings.parseWorkers` in [Parallel parsing](configuration.md#parallel-parsing)

## `mapx update` / `mapx sync`

Incremental scan. Detects changed files via git, or via content hashes outside git, and only re-scans those. The exceptions are re-scans that keep the graph identical to `mapx scan`:

- When a file that was removed comes back (a restored file, or a branch switch), the files that referenced it are re-parsed, so its inbound edges return.
- When the effective include/exclude filters differ from the last scan (config or flags), every file is re-parsed once, as `mapx scan` does.
- When git reports a rename, the old path leaves the index and the files that referenced it are re-parsed.
- When a removed file's referenced names appear in a new or changed file (a class moved to another file, in one sync or across two, with or without git), the files that referenced it are re-parsed, as `mapx scan` does.
- When a Vue global registration changes (`app.component('X', X)` added, removed or retargeted, or a `.vue` file added to or removed from an auto-registered folder), the `.vue` files using `<X/>` are re-parsed, as `mapx scan` does, although none of them changed. The same holds for a Vue Router route renamed or given another component in the router file: the `.vue` files and JS/TS modules navigating to it are re-parsed.
- A file git lists whose content is still the blob that was indexed (a mode change, or the commit of an edit an earlier sync indexed) is not re-parsed. Sync records the blob id of every file it indexes.
- A file that was indexed while untracked or only staged leaves the index once it is deleted, although git lists neither side of it.
- An edit reverted to the committed content (`git checkout -- f`, or `git reset` then `git checkout`) is re-indexed, although git no longer lists the file.
- A `git mv a b` that leaves a copy at `a` keeps both files.
- Gitignored files are indexed as `mapx scan` indexes them (see [Gitignored files](configuration.md#gitignored-files)).
- Files of another registered repo nested in this one stay with that repo; they are synced with it.
- Syncing several repos (the default, or `--all`), a file of one repo that referenced a file another repo removed and restored is re-parsed (in the same run, or by its own repo's next sync), and a repo that was removed with `workspaces remove` and added back is resolved again by the others.

In a repo that sits inside a larger git checkout, only changes under the repo's folder count, with paths relative to it.

```bash
mapx update [/path] [--exclude <glob>] [--include <glob>] [--repo <name>] [--all] [--no-parallel]
mapx sync [/path] [--exclude <glob>] [--include <glob>] [--repo <name>] [--all] [--no-parallel]
```

Options:
- `--exclude` — Exclude glob patterns (repeatable)
- `--include` — Include glob patterns (repeatable)
- `--repo` — Update only a specific registered repository
- `--all` — Update all registered repositories (the default: without `--repo`, every registered repository is synced)
- `--no-parallel` — Parse on the main thread only. By default, a batch large enough to repay worker startup (about 768 KB of source) parses on worker threads, sized from the source, the CPUs and the available memory; see `settings.parseWorkers` in [Parallel parsing](configuration.md#parallel-parsing)

## `mapx status`

Show scan metrics, collected data, graph statistics, and git changes since the last scan.

```bash
mapx status [/path] [--all]
```

`--all` prints one row per registered repository (Repo, Files, Symbols, Edges, HEAD, Last scan, Changed), the totals, and the cross-repo edge count per repo pair. Changed reads `unscanned` for a repo that is registered but has never been scanned, `clean` when nothing indexed has changed, and otherwise the number of changed files.

Outputs:
- **Scan info**: project name, directory, last scan time, last git commit, schema version
- **Collected data**: file/symbol/edge counts, language breakdown, symbol kind breakdown, edge type breakdown
- **Graph metrics**: graph density, average edges per file, top 5 most-connected files, PageRank top symbols
- **Storage**: database path and size
- **Git changes**: added/modified/removed/renamed files since last scan
- **Index recommendations**: stale index detection with upgrade suggestions

## `mapx query <term>`

Search for symbols by name. Supports partial matching, glob patterns (`*Service`, `get*`, `*Controller*`), wildcard (`*` to list all), and flexible namespace querying using double-colons or dots (e.g. `BillingService::getEffectiveLimits` or `BillingService.getEffectiveLimits`). When no matches are found, suggests similar symbols via fuzzy matching.

```bash
mapx query <term> [--dir /path]
```

A class that declares Eloquent relationships lists them under `relationships:`, one per line: the declaring method, the relationship call, the target model and the relationship type (`team → belongsTo App\Models\Team (many-to-one)`).

Examples:
```bash
mapx query UserService           # Partial match
mapx query '*Service'            # Glob: all symbols ending with "Service"
mapx query 'get*'                # Glob: all symbols starting with "get"
mapx query '*'                   # List all symbols
mapx query BillingService::getEffectiveLimits # Double-colon namespace query
mapx query BillingService.getEffectiveLimits  # Dot namespace query
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
mapx deps <file> [--dir /path] [--cross-repo]
```

A file that declares service-container bindings (`$this->app->bind/singleton(Abstract::class, Concrete::class)`, `$listen`) also gets a `Bindings (abstract → concrete)` block; closures show as `(closure)`, and `$listen` entries read `Event → Listener (listen)`.

`--cross-repo` lists only the edges whose two ends are in different registered repositories: `→ [repo] file (type)` for dependencies and `← [repo] file (type)` for dependents.

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
                            [--include-leaf-libraries] [--to <target>]
```

Options:
- `--direction` — Trace direction: `up`, `down`, `both` (default: `both`)
- `--depth` — Maximum traversal depth (default: 3)
- `--max-depth` — Alias for `--depth`
- `--format` — Output format: `text` (default), `dot`, `json`
- A class (or other container) as the start symbol stands for its members: `mapx trace Scanner --direction down` follows the calls made by `Scanner::scan`, `Scanner::walk`, …
- `--include-structural` — Include import/extends edges in trace (default: false)
- `--sources` — Show entry points instead of tracing a symbol
- `--sinks` — Show terminal consumers instead of tracing a symbol
- `--include-leaf-libraries` — Include high-import leaf libraries in terminal consumers output (when `--sinks` is active; default: false)
- `--to` — Find the shortest critical path from the start to a target symbol/file

Examples:
```bash
mapx trace handleRequest                            # Bidirectional trace
mapx trace handleRequest --direction up              # Upstream only
mapx trace --sources                                 # List all entry points
mapx trace --sinks                                   # List all terminal consumers
mapx trace --sinks --include-leaf-libraries          # List all terminal consumers including leaf libraries
mapx trace Store --to FlowTracer                     # Shortest path between symbols
mapx trace Store --format json                       # JSON output
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

Each callee's `@ file:line` is its own declaration. When the file declares the name several times (two classes with a `save` method), the line belongs to the class the caller also references there, for example the class it instantiates. When the declaration is unknown or ambiguous, only `@ file` is printed; the call-site line is never shown in its place.

## `mapx impact <symbol>`

Perform change impact analysis — show blast radius and risk for modifying a symbol. Validates symbol existence before running analysis; suggests alternatives via fuzzy matching if not found.

```bash
mapx impact <symbol> [--dir /path] [--depth <n>] [--format <format>]
```

Files that import the symbol's file without calling it are listed as `LOW` (`symbol: <import>`), but only when their source mentions the symbol's name. A file that imports other names from the same module is not affected.

## Staleness warning

Commands that read the index warn `Graph index may be stale` when indexed files changed content, were deleted, or new untracked files appeared. A new untracked file counts only if a scan would index it: the same rules apply as for the scan walk. These are the repo's include and exclude patterns from its last scan (including Laravel's default excludes), skipped directories such as `node_modules`, `vendor`, `build` and `coverage`, dot-prefixed files and directories, and a known language.

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
- `--all` — Every registered repository. The LLM format becomes a combined export: the repo list, the cross-repo dependencies, then one `## <repo>` section per repo sharing the token budget, with that repo's own export nested two heading levels below it
- `-o, --output <file>` — Write output to file instead of stdout
- `--exclude` — Exclude glob patterns; a pattern naming a folder (`**/Http`, `app/Http/**`) leaves out the files under it, as at scan time
- `--include` — Include glob patterns
- `--cluster` — Cluster rendering for DOT/SVG: `none` (default, flat) or `auto` (with subgraph blocks)
- `--depth` — Maximum cluster nesting depth for DOT/SVG. With `--cluster auto`, `--depth 0` is the cluster-level view: one node per cluster (with its file count), one edge per cluster pair labelled with its edge count and types, and `penwidth` = log(count) + 1, capped at 5
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
mapx export --format=dot --cluster=auto --depth=0    # Clusters only, edges weighted by count
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

List all supported languages with their extensions, file names (e.g. `Rakefile`, `Gemfile`) and tier. Every grammar ships bundled with MapX; nothing is downloaded or installed. `mapx_lang_list` returns the same text.

```bash
mapx lang list
```

## `mapx lang info <lang>`

Show a language's tier, extensions, file names and resolved grammar and query files. An unknown language exits with code 1. `mapx_lang_info` returns the same text.

```bash
mapx lang info ruby
```

## `mapx lang install <lang>` / `mapx lang uninstall <lang>`

Compatibility no-ops: they report that the grammar is bundled and nothing is installed or removed. To skip a language's files, use an exclude pattern (`mapx scan --exclude "**/*.sh"`).

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

The dashboard:
- **Themes:** light and dark. It follows the system setting until you pick one with the sun/moon button; your choice is kept in the browser.
- **Narrow windows:** below 1200 px the sidebar shrinks to icons, and below 640 px it becomes a drawer behind the menu button.
- **Keyboard:** every control can be reached with Tab and shows a focus ring. Arrow keys switch between Routes and Hooks, and Escape closes the drawer or the graph's details panel.
- **Graph details:** the details panel opens when you select a node or edge.
- **Clusters Map grouping:** the map groups files by architecture layer, or by directory when most files have no layer.
- **Rate limit:** `/api/graph`, `/api/graph/meta` and `/api/context` are rate-limited to 10 requests a minute per client. The dashboard itself and command-line clients on the same machine are exempt. A web page from another site is not, even on the same machine.
- **Loading:** only the default layout engine (fCoSE) loads with the page. ELK, Dagre and Cola load the first time you choose them.
- **Large graphs:** an fCoSE layout of more than 600 elements runs in a background worker, so the page stays responsive. If the worker can't start, the layout runs on the page as before.
- **Compression:** API responses over 1 KB, scripts and styles are sent compressed (brotli or gzip) when the browser accepts it.
- **Workspaces:** in a workspace with several registered repos, the sidebar's repo switcher scopes every view to one repo, or shows all of them. The choice is kept in the URL (`?repo=web`). The **Workspace** tab lists each repo with its files, symbols, edges, cross-repo edges, last scan and git state, and the dependencies between repos. In the graph, edges into another repo are dashed.

The dashboard's API takes the same `repo` query parameter. An unknown repo answers 404.

| Endpoint | Without `repo` | `repo=<name>` | `repo=all` |
| --- | --- | --- | --- |
| `/api/graph`, `/api/symbols`, `/api/routes` | every repo | that repo | every repo |
| `/api/clusters`, `/api/smells` | the primary repo | that repo | every repo |
| `/api/profile`, `/api/dsm`, `/api/metrics` | the primary repo | that repo | 400: these are per repo |
| `/api/repos` | every repo: counts, `lastScanned`, `git` (`isGit`, `head`, `changesSinceScan`), and the cross-repo pairs | — | — |

The **HTTP Calls** tab shows how the repos talk over HTTP:
- **Flow diagram:** from each calling repo to the repos whose routes serve its calls, and to "No route" for calls that reach none. Link widths follow the number of calls.
- **Calls table:** every frontend call site, filterable by method, repo pair, and matched or unmatched.
- **Selecting a call** shows both ends: the caller's file, line and code, and the route, handler and its file and line. Each end opens the graph at that file.

`/api/http` serves the same records as `mapx routes --clients --json`, adding `callerRepo`, `handlerRepo`, `callerCode` and `handlerLine`. It groups them in `pairs` (`from`, `to`, `count`, `calls`) and `unmatched` (`repo`, `count`, `calls`), and takes `repo=` (calls whose caller or handler is in that repo). In the graph, HTTP edges between repos are drawn dashed, like every cross-repo edge.

The **Configuration** tab shows the effective settings, read-only:
- **Values and sources:** each known setting with its value and where it comes from: `default`, `user` (set in `.mapx/config.json`) or `env` (`MAPX_PARSE_WORKERS`).
- **Pattern lists:** your own patterns are shown, and MapX's built-in ones are folded away.
- **Repos and languages:** the configured repos (missing folders marked) and user languages.
- **Warnings:** invalid values, unknown settings, repo folders that don't exist, and incomplete or shadowed user languages.

Edit `.mapx/config.json`, or use `mapx workspaces` and `mapx lang`, to change them. `/api/config` serves the same report, and every method other than GET answers 405.

## `mapx workspaces`

Manage multi-repository workspaces.

A config that names the same folder twice (a symlink to a registered repo, or another spelling of its path) is collapsed when it is loaded, by any command: the first entry is kept, the config is saved, the dropped entry's stored data is removed, and stderr says `Removed duplicate repo entry <name> (<path>): same folder as <kept> (<path>).`

Each repo's references are resolved against the files of the other repos indexed at the time. When a later `scan --all` or `update --all` finds a repo that was not indexed then (for example the primary repo, after `workspaces add` scanned the new repo first), it re-parses the earlier repo once, so its references into the newly indexed repo resolve without `--force`. `update` also takes the full-scan path for a repo with nothing indexed yet.

### `mapx workspaces` / `mapx workspaces list`

List the registered repositories as a table: Name, Path, Type (`primary`, `submodule`, `vscode-workspace`, `peer`, or `folder` for a registered directory without a checkout of its own, such as a monorepo package), Files, Last scanned and HEAD (each repo's own checkout; `-` for a `folder`). Uninitialised submodules are listed with `✗ not initialised` and the `git submodule update --init` command. `list` also shows unregistered discoveries.

```bash
mapx workspaces
mapx workspaces list [--include-peers]
```

### `mapx workspaces add <path>`

Register a new repository in the workspace. A path that resolves (through symlinks) to a registered repository is reported as already registered. The new repository is scanned straight away; run `mapx scan --all` afterwards if the primary repository has not been scanned yet.

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
mapx workspaces discover [--include-peers]
```

Outputs grouped results by source type with status indicators:
- **Submodules** — declared in `.gitmodules`
- **Peer repositories** — sibling git repositories in the parent folder. They are listed only with `--include-peers`; without it, discover only says how many exist
- **VS Code workspace folders** — folders listed in `.code-workspace` files (JSONC: comments and trailing commas are accepted)
- **Nested git repositories** — any directory up to 3 levels deep that contains a `.git` entry (common noise paths like `node_modules`, `dist`, `build`, `.cache` are skipped automatically)
- **Monorepo packages** — packages/apps declared in `pnpm-workspace.yaml`, `package.json` workspaces, `lerna.json`, `rush.json`, `Cargo.toml` `[workspace]`, `go.work`, or inferred from `apps/`, `packages/`, `libs/`, `services/` directories

Suggests `mapx workspaces add <path>` for registration.

### `mapx workspaces sync`

Sync all discovered submodules and VS Code workspace folders, plus peer repos with `--include-peers` (auto-registers them). For newly discovered **nested git repositories** and **monorepo packages**, interactive prompts let you choose which ones to register and scan. Without a TTY those prompts are skipped (sync says how many it found) and the other discoveries are still registered. A folder reached through a symlink to an already registered repository is not registered again.

```bash
mapx workspaces sync [--include-peers]
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

When a config file already exists, mapx **merges** its MCP entry into the file without overwriting other settings. A file that already holds the identical mapx entry is reported as up to date and left untouched, comments and formatting included.

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
mapx sinks [--dir /path] [--include-leaf-libraries]
```

Options:
- `--include-leaf-libraries` — Include high-import leaf libraries in output (default: false)

Identifies files with no outgoing data-bearing edges — database facades, cache managers, mail senders, and queue dispatchers. By default, high-import leaf libraries are filtered out to reduce noise, unless `--include-leaf-libraries` is passed.

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

Show coupling and instability metrics for files, ranked by total degree (in + out, then PageRank).

```bash
mapx metrics [path] [--dir /path] [--lang <language>] [--verified-only] [--format text|json]
             [--top <n>] [--exclude <glob,...>]
```

Options:
- `--lang` — Only list files of this language (degrees still count every file)
- `--verified-only` — Only compute metrics using verified edges
- `--format` — `text` (default; `llm` is an alias) or `json`. Any other value exits 1
- `--top <n>` — Number of rows (default 20); `0` lists every file. Must be a whole number ≥ 0, otherwise the command exits 1
- `--exclude <glob,...>` — Leave out matching files and their edges (globs or bare path segments, as in `scan --exclude`; comma-separated or repeated)

Text output (F02):

```
Metrics for: /repo   (last scan: 2026-10-31 01:48)
Files: 3 | Edges: 6 | Graph density: 0.5

Top coupled files (by total degree):

  RANK  FILE              IN  OUT  TOTAL  INSTABILITY
  ───────────────────────────────────────────────────
     1  src/store.ts       2    0      2     0.00
     2  src/service.ts     1    1      2     0.50
     3  src/api.ts         0    2      2     1.00

Instability = out / (in + out).  Range: 0 (stable) → 1 (unstable).
High in-degree  → depended-on bottleneck.
High out-degree → many outgoing deps (potential God Class / low cohesion).
```

`IN` counts the distinct files that depend on the file, `OUT` the distinct files it depends on. When `--top` cuts the list, a `... N more` line follows the table.

JSON output (`--format json`, decision D012):

```json
{ "dir": "/repo", "generatedAt": "2026-10-31T01:48:00.000Z", "summary": { "files": 3, "edges": 6, "density": 0.5 },
  "files": [ { "path": "src/store.ts", "language": "typescript", "inDegree": 2, "outDegree": 0, "totalDegree": 2, "instability": 0, "pagerank": 0.5209 } ] }
```

`summary` describes the graph the degrees are computed on: the repository's files and edges after `--exclude` and `--verified-only`. `edges` counts edge rows, so several symbol-level edges between the same two files (an import, a call, an instantiation) each count. `density` counts distinct directed file pairs instead: pairs / (files × (files − 1)), self-edges and edges to files outside the set left out, so it stays between 0 and 1. `--lang` and `--top` only select rows.

## `mapx edges`

Granular query of dependency edges.

```bash
mapx edges [file] [--dir /path] [--direction outgoing|incoming|both] [--type <types>] [--verified-only]
           [--format text|json] [--from <file>] [--to <file>]
```

Options:
- `[file]` — List the edges of this file (workspace-relative or absolute). A directory is still accepted as the target directory
- `--direction` — Needs a file: `outgoing` (edges leaving it), `incoming` (edges reaching it) or `both` (default). Without a file, or with another value, the command exits 1
- `--type` — Filter edges by type; comma-separated for several (e.g. `relation,extends`)
- `--verified-only` — Leave out inferred edges
- `--format` — `text` (default; `llm` is an alias) or `json`. Any other value exits 1
- `--from` — Filter edges originating from a file pattern
- `--to` — Filter edges targeting a file pattern

```bash
mapx edges app/Models/User.php --direction outgoing --type relation,extends --verified-only --format=json
```

With a file, the edges of every registered repo of the workspace count, so another repo's edge into the file is listed. Text output (F04) lists both sides; inferred edges end in `(inferred)` and a file of another repo shows as `repo:path`. An indexed file without edges prints `No edges for <file>.` (exit 0); a path that is not indexed prints `File "<file>" is not indexed. …` on stderr and exits 1:

```
Edges for: src/service.ts

  Incoming (2):
    ← src/api.ts  [import]  ./service
    ← src/api.ts  [instantiation]  Service

  Outgoing (2):
    → src/store.ts  [import]  ./store
    → src/store.ts  [instantiation]  Store
```

With a file, JSON output (decision D012) is `{ file, direction, incoming[], outgoing[] }`; with `--direction incoming` the `outgoing` list is empty, and vice versa. `sourceRepo` / `targetRepo` name the other repo of a cross-repo edge and are `null` otherwise:

```json
{ "file": "src/service.ts", "direction": "both",
  "incoming": [ { "sourceFile": "src/api.ts", "sourceRepo": null, "type": "instantiation", "sourceSymbol": "handler", "targetSymbol": "Service", "verifiability": "verified", "weight": 1, "line": 3 } ],
  "outgoing": [ { "targetFile": "src/store.ts", "targetRepo": null, "type": "instantiation", "sourceSymbol": "Service", "targetSymbol": "Store", "verifiability": "verified", "weight": 1, "line": 2 } ] }
```

Without a file (`--from` / `--to` / `--type` only), the output is the flat list: text lines `source → target (type)`, or a JSON array of `{ sourceFile, sourceSymbol, targetFile, targetSymbol, type, verifiability, weight, targetRepo, metadata }`.

## `mapx routes`

Show routes from all detected frameworks.

```bash
mapx routes [path] [--dir /path] [--framework <name>] [--method <verb>] [--path-pattern <pattern>] [--json]
mapx routes [path] --clients [--unmatched] [--method <verb>] [--path-pattern <pattern>] [--json]
```

Options:
- `--framework` — Filter by framework name
- `--method` — Filter by HTTP method (GET, POST, etc.)
- `--path-pattern` — Filter by route path pattern (with `--clients`: by request URL)
- `--json` — Output as JSON. Every route carries `line`, `name`, `middlewares`, `reachable`, `reachability`, `overridden` and `conditional`. `reachable` is false only when no mount can load the route; `reachability` is `reachable`, `unreachable` or `unknown` (Laravel: the file is not visibly mounted, but a mount of the app could not be evaluated, so it may be loaded). Overridden routes carry `overriddenBy` (`file:line` of the winner), and routes in a `Route::domain()` group carry `domain`. Laravel middlewares are named as Laravel resolves them, through the HTTP Kernel of the route's own app: a group becomes its members, an alias its class, a class constant is named through the route file's `use` statements, and parameters follow the class (`EnsureRole::class.':editor'` and `'role:editor'` → `App\Http\Middleware\EnsureRole:editor`)
- `--clients` — Instead of routes, list frontend HTTP call sites (axios, `fetch`, `axios.create` instances, factories, aliases and configured receivers) with their resolved URL and the backend route each reaches
- `--unmatched` — With `--clients`: only calls that reach no live route (dead or broken calls)

Client receivers MapX cannot recognise on its own (project wrappers) are configured in `.mapx/config.json`:

```json
{ "settings": { "http": { "clients": [{ "receiver": "apiService", "baseURL": "/api" }], "hosts": ["api.example.com"] } } }
```

A call pairs only with a live route that its literal path supports: at least one literal path segment must match. A URL with no literal segment, such as `` `${endpoint}?page=${n}` ``, stays unmatched. An absolute URL pairs only when its host belongs to the workspace:
- a local development host (`localhost`, `127.0.0.1`, `*.test`, `*.local`, `*.localhost`);
- a host named in a `.env*` file of a registered repo or in a configured client `baseURL`;
- a host listed in `settings.http.hosts`.

Calls to any other host are third-party calls. A call with a host pairs only with routes that serve that host: a route in a `Route::domain()` group needs its domain to match, with `{param}` segments matching one label each (`{account}.example.com` serves `acme.example.com`). A relative URL can pair with a route on any domain. A `fetch` whose method cannot be read from the code (`{ method: verb }`, a spread, an options variable) is listed with method `UNKNOWN` and never paired.

Paired calls are stored as `http` edges, from the calling file to the route handler.

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

Each provider line shows its file and that file's status in this project (`missing`, `current`, `outdated`, `edited`, `unmanaged (no mapx block)` or `conflicting keys`). Companion files a provider also writes are listed under it with `+`, and a legacy file that `agents generate` or `agents update` will remove with `-`.

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

Some providers write more than their instruction file:
- `claude`: `CLAUDE.md` documents both the stdio stanza and the SSE stanza (`mapx serve --sse --port <mcp-port>`, URL `http://localhost:<mcp-port>/sse`).
- `aider`: also writes `.aider.conf.yml` with `read: [AIDER.md]`, so Aider loads the instructions on startup (`aider --read AIDER.md` does the same by hand). If the file already has its own top-level `read:` key, it is left untouched and the output says which lines to merge by hand.
- `continue`: writes Continue's documented layout. `.continue/mcpServers/mapx.yaml` is a block with `name`, `version` and `schema: v1` whose `mcpServers` entry runs `mapx serve --dir <project>`. `.continue/prompts/mapx-impact.md`, `mapx-callers.md`, `mapx-context.md` and `mapx-sync.md` are prompts with `invokable: true` front matter, so they appear as `/mapx-impact`, `/mapx-callers`, `/mapx-context` and `/mapx-sync` in Continue. Continue never loaded the `.continue/mapx.yaml` that earlier versions wrote: if it still has a mapx block, that block is removed (and the file deleted when nothing else is left), with a message. A `.continue/mapx.yaml` without a mapx block is left alone. A legacy block edited after mapx wrote it is only removed when you confirm or pass `--force`. That includes a block written by 0.3.x or earlier (no content hash) whose body is not one those versions wrote.
- `zed`: also registers the mapx server under `context_servers` in `.zed/settings.json`. Existing keys and string values are kept; comments and trailing commas are accepted, but the merged file is written back as plain JSON, and the output warns when comments were dropped. A settings file that already holds the identical mapx entry is left untouched, comments included. A settings file that cannot be parsed is left untouched, with a warning.

Generated files end with a newline. A block written into an existing file uses that file's line endings (LF or CRLF).

## `mapx agents update`

Update existing LLM integration files to the current MapxGraph version.

```bash
mapx agents update [--dry-run] [--force] [--mcp-port <number>]
```

Options:
- `--dry-run` — Show updates without writing files
- `--force` — Force overwrite of customized blocks without prompt
- `--mcp-port` — Port for the MCP SSE transport server (default: 3456)

Only updates files that already exist; does not create new ones. That includes the shared `.agents/rules/instructions.md` and companion files such as `.aider.conf.yml`. The exception is a provider still on a legacy file (Continue's `.continue/mapx.yaml` with a mapx block): it is migrated, so its new files are written and the legacy block is removed. A mapx block that was edited, or a block written before content hashes existed whose body differs from the current template, is kept unless you confirm or pass `--force`. Duplicate mapx blocks in one file are merged into one.

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
