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

In a terminal at least 32 columns wide, `init`, `scan` and `sync` (`update`) first print the MapX logo: the text art at half its size, 32 columns by 12 rows, in half-block cells shaded with `#ff02fe`. It uses 24-bit colour where the terminal reports it (`COLORTERM=truecolor`), otherwise 256 colours with one colour per shade. The shading fades toward a dark or light background when `COLORFGBG` names one, else toward a mid grey that reads on both. Under `NO_COLOR` it prints plain shade characters. The logo is never printed in a pipe, when `CI` is set, on `TERM=dumb`, or by the MCP tools, and `MAPX_NO_BANNER=1` turns it off.

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

In a terminal, scan opens with the MapX logo (see [`mapx init`](#mapx-init)).

Perform a full scan of all source files. Builds the graph from scratch. Without `--repo`, every registered repository is scanned, as with `--all`: run at a workspace root, `mapx scan` covers the nested repos registered there as well as the root repo.

- Shows real-time progress: discover, index, and parse phases
- File reads are parallelized for faster scanning
- Survives interruptions: progress is saved per-file, re-run to resume
- Unchanged files are not re-parsed. The exception is a moved target: when a file is removed, the names its referrers resolved into it are remembered, and when a new or changed file names one of them, those referrers are re-parsed, so a class moved to another file is found at its new path without `--force`
- Vue global components: when a new, changed or deleted JS/TS file adds, removes or retargets a `Vue.component` / `app.component` registration (or a `.vue` file joins or leaves an auto-registered folder), the unchanged `.vue` files using that tag are re-parsed, and no others. Likewise, when a Vue Router route record is added, removed, renamed or given another component or redirect, the unchanged `.vue` files and JS/TS modules navigating to it are re-parsed. Each Vue app (the nearest folder with a bundler config, or a `package.json` listing a build tool such as vite or `@vue/cli-service`, whatever the root `package.json` lists) keeps its own global registry and route table; a component library (vue as a peer dependency, a library build, or a published entry) shares its registrations with every app, and a component another app's registering file imports also sees that app's registrations. Where two files of an app register one name, the first by path wins. Adding or removing a `package.json` re-parses the files whose app changed and the files that navigate to that app's routes.
- In a git repo, each file stores its blob id at HEAD (also for a repo that is not at the workspace root), unless the working-tree content differs from HEAD
- Scanning several repos (the default, or `--all`), the result does not depend on the order of the registered repos: a repo resolved before another repo of the run was indexed, and the files a repo parsed before another repo of the run changed, are resolved once more at the end; files of one repo that referenced a file another repo removed and restored are re-parsed. As within one repo, an unchanged file is not re-parsed because another repo gained a symbol it could now link to
- A symbol named by several files resolves to the one nearest the referencing file (most shared leading folders), then the first by path, so a scan and a sync pick the same file

```bash
mapx scan [/path] [--exclude <glob>] [--include <glob>] [--repo <name>] [--all] [--force] [--no-parallel]
```

Options:
- `--exclude` — Exclude glob patterns (repeatable)
- `--include` — Include glob patterns (repeatable)
- `--repo` — Scan only a specific registered repository; a name no repo is registered under is an error that lists the registered repos (exit 1)
- `--all` — Scan all registered repositories (the default). A registered repo whose folder is missing is skipped with a warning and keeps its index
- `--force` — Force re-parsing of all files (bypasses file caching and rebuilds all symbols and edges)
- `--no-parallel` — Parse on the main thread only. By default, a batch large enough to repay worker startup (about 768 KB of source) parses on worker threads, sized from the source, the CPUs and the available memory; see `settings.parseWorkers` in [Parallel parsing](configuration.md#parallel-parsing)

## `mapx update` / `mapx sync`

In a terminal, update and sync open with the MapX logo (see [`mapx init`](#mapx-init)).

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
- `--repo` — Update only a specific registered repository; an unknown name is an error, as for `scan`
- `--all` — Update all registered repositories (the default: without `--repo`, every registered repository is synced)
- `--no-parallel` — Parse on the main thread only. By default, a batch large enough to repay worker startup (about 768 KB of source) parses on worker threads, sized from the source, the CPUs and the available memory; see `settings.parseWorkers` in [Parallel parsing](configuration.md#parallel-parsing)

## `mapx status`

Show scan metrics, collected data, graph statistics, and git changes since the last scan.

```bash
mapx status [/path] [--all] [--exclude <glob>] [--include <glob>]
```

`--exclude` and `--include` narrow the changed files reported: a changed file an `--exclude` glob matches is left out, and with `--include` only the changed files it matches are listed (an exclude wins). Empty globs (`--include ''`, a trailing comma) are ignored, here and in `scan`/`update`. They are shown, with the configured patterns, in the **Scan info** lines (`Excludes:`, `Includes:`), and do not change the indexed counts. MCP `mapx_status` takes the same patterns and lists the same files. `--all` ignores them. `--all` prints one row per registered repository (Repo, Files, Symbols, Edges, HEAD, Last scan, Changed), the totals, and the cross-repo edge count per repo pair. Changed reads `unscanned` for a repo that is registered but has never been scanned, `clean` when nothing indexed has changed, and otherwise the number of changed files.

Outputs:
- **Scan info**: project name, directory, last scan time, last git commit, schema version
- **Collected data**: file/symbol/edge counts, language breakdown, symbol kind breakdown, edge type breakdown
- **Graph metrics**: graph density, average edges per file, top 5 most-connected files, PageRank top symbols
- **Storage**: database path and size
- **Git changes**: added/modified/removed/renamed files since last scan
- **Other changes** (**Changes** in a workspace that is not a git repository): the stale files git does not list, such as a new file in a nested repo or in a non-git workspace. They are found as the [staleness warning](#staleness-warning) finds them.
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

Commands that read the index warn `Graph index may be stale` when indexed files changed content, were deleted, or new files appeared. A new file counts only if a scan would index it: the same rules apply as for the scan walk. These are the repo's include and exclude patterns from its last scan (including Laravel's default excludes), skipped directories such as `node_modules`, `vendor`, `build` and `coverage`, dot-prefixed files and directories, unregistered nested git repositories, and a known language.

New files are found by walking the workspace with those rules, not by asking git. So a new file counts in a workspace that is not a git repository, in a nested repo, and in a registered repo below a folder the scan otherwise skips (such as `.wt/api`). A file in a gitignored folder counts too, because the scan does not read `.gitignore` and indexes it. A file the scan cannot read does not count. `mapx status`, `mapx check`, this warning and the MCP tools' warning all find new files this way. Each command, and each MCP tool call, walks the workspace once, and a file is tested by name before any pattern, so a folder of thousands of images costs little more than listing it.

The index records the version of the extractor that built it. An index an older MapX built (one from before a fix that changes what a scan extracts) is stale too: the commands warn `was built by an older MapX`, `mapx check` exits 4, and the next `mapx scan` or `mapx update` re-parses every file of that repo once (M5-26).

## `mapx node <symbol>`

Inspect a specific symbol node with detailed metadata. Optionally view its source code. If the symbol is not found, suggests similar symbols via fuzzy matching.

`<symbol>` is a name, `Class::method` or `Class.method`. A symbol whose own name contains a dot, such as the object member `'api.get'` or Lua's `M.foo`, opens by that name when no class `api` has a member `get`; when one does, `api.get` opens that member and `actions::api.get` (scope, then name) opens the object member. `mapx callers`, `callees` and `impact` take both readings (M4-26).

```bash
mapx node <symbol> [--dir /path] [--source] [--include-members] [--format <format>]
```

Options:
- `--source` — Include the source code of the symbol
- `--include-members` — List the member symbols (methods, properties) of a class, interface or trait
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
mapx export [--format <fmt>] [--tokens <budget>] [--repo <name>] [--all] [-o <file>]
            [--exclude <glob>] [--include <glob>]
            [--cluster <mode>] [--depth <n>] [--fallback-grid]
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
- `--fallback-grid` — For SVG: always use the built-in renderer, even when Graphviz is installed
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
- **Keyboard:** every control can be reached with Tab and shows a focus ring. Arrow keys switch between sub-tabs (Routes and Hooks; Overview and Layer rules), and Escape closes the drawer or the graph's details panel.
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

The **Architecture** tab's **Layer rules** view shows `.mapx/architecture.jsonc` as `mapx check` evaluates it, baseline included (see `docs/architecture-rules.md`):
- **Health tiles:** violations, warn-level violations, baseline debt (skipped violations), uncovered dependencies, warnings (as `mapx check` counts them), unassigned elements (`mapx arch unassigned`), rule smells and configuration errors. There is no trend yet: snapshots do not record these counts.
- **Layer diagram:** the layers, with groups as boxes, and one edge per status of each layer pair, labelled with its count: allowed grey, violations red, warn-level orange, skipped dashed amber. Selecting an edge lists the pair's findings, counted as the DSM counts them, each with its dependencies' file and line (`mapx arch deps`); selecting a layer lists its members and the selector that matched each (`mapx arch layers --why`).
- **Layer DSM:** rows depend on columns. A cell is coloured by its worst status, and an allowance that no dependency uses is a faint 0 (`mapx arch unused`). Cells (unused allowances too) and row headers are buttons that open the same lists, so every pair and layer is reachable from the keyboard.
- **Findings:** what `mapx check --report-uncovered --report-skipped` shows, filterable by kind, rule, layer and verifiability; allowed dependencies are only counted. A finding's file opens in the graph's details panel.
- **Graph overlay:** the graph's **Declared layers** button colours each file by its first declared layer, with a legend; files in no layer are grey.

Without `.mapx/architecture.jsonc`, the view suggests `mapx arch init`. The dashboard never writes the configuration.

| Endpoint | Answers |
| --- | --- |
| `/api/arch/report` | `graph` (as `mapx arch graph --format json`), `drawn` (its edges per status), `dsm`, `unusedAllowances`, `health` (`warnings` is `mapx check`'s Warnings; `warnLevelViolations` the violations reported at warn), `counts`, `findings` and `smells` (the rule smells of `mapx_smells`) |
| `/api/arch/layers` | `layers`, `groups`, `files` (each file's non-overlay layers) and `unassigned` (files); with `layer=<name>`, that layer's members with their selector |
| `/api/arch/edges?from=<layer>&to=<layer>` | the pair's `findings`, counted in `counts` as the DSM and `mapx check` count the pair (one per element pair and edge type), each with its `dependencies` as `mapx arch deps --format json` lists them; without `to`, every finding from `from`, uncovered ones included |

Every answer carries `stale`: when `mapx check` would refuse the index (exit 4: files changed since the scan, an unscanned repo, an older MapX), it is `true` and `staleReason` gives check's message; the view shows it in a banner. One evaluation serves a batch of requests while the index, the configurations and the baseline are unchanged. Without a configuration, each answers 200 with `{ "configured": false, "hint": … }`; with an invalid one, `{ "configured": true, "valid": false, "errors": […] }`. An unknown layer answers 404, `edges` without `from` 400, and methods other than GET 405. The rules cover the whole workspace, as `mapx check` does: `repo=<name>` narrows the findings, members, files and dependencies to that repo, while the graph, DSM and health stay the workspace's.

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
- a host listed in `settings.http.hosts`;
- a host a live route names literally in `Route::domain()` (a domain with `{param}` or unevaluated parts names no single host). When nothing else names such a host, only the apps that declare it serve it: their routes, plus other apps' routes on a domain that matches it (an unevaluated domain does not count).

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

The subcommands `init`, `validate-config`, `layers`, `which`, `unassigned`, `deps`, `unused`, `changed`, `allowed` and `graph` work with the architecture rules configuration; they are described below.

Options:
- `--smells` — Show only detected architectural smells
- `--dsm` — Show only the cluster dependency matrix (DSM)
- `--violations` — Show only layer dependency flow violations
- `--json` — Output the architecture report as structured JSON

Without `.mapx/architecture.jsonc`, layer violations come from the file roles. With one, they come from the rules, as `mapx check` reports them (its baseline applied), and the rule-derived smells (`layer-cycle`, `layer-skip`, `dead-allowance`, `weak-allowance`, `unstable-layer-dependency`, `abstractness-distance`, `deprecated-usage`, and M5-24's `vendor-leak`, `undeclared-dependency`, `dev-dependency-in-prod`) join the list. Those smells print a `Source:` line (`rules`, or `inferred-roles` for the role-order violations `policy.alsoInferred` keeps), and layer-level ones a `Layers:` line. See [architecture-rules.md](architecture-rules.md#smells).

Examples:
```bash
mapx arch                           # Full text report
mapx arch --smells                  # Show only code smells
mapx arch --violations --json       # Show violations as JSON
```

### `mapx arch init`

Proposes a starting configuration, `.mapx/architecture.jsonc` (or a view), for a person to review (AR-15). It is a **dry run by default**: it prints the JSONC on stdout and a one-line summary on stderr, and writes nothing. The comments in the JSONC give, for each layer, the files it holds and the dependencies on other layers the index has today, and which of them the proposed rules refuse. The MCP tool `mapx_arch_init` runs the same engine and returns the same JSON as `--json`.

```bash
mapx arch init [path] [--dir /path] [--from roles|clusters|framework] [--preset <id>] [--baseline]
               [--write] [--force] [--view <name>] [--sync] [--format text|json] [--json]
```

Where the layers come from:
- `--from roles` (the default): one layer per MapX role, in the order of the archetype's `LAYER_ORDER` (`{ "role": … }` selectors). Each layer may depend on the layers after it in that order. Roles with no place in the order (`other`, `test`…) are named in the header and left out.
- `--from clusters`: one layer per primary cluster (`mapx clusters`, `{ "cluster": … }` selectors). The rules allow exactly the dependencies between clusters the index has today, so a new one fails `mapx check`.
- `--from framework`: the preset of the framework the scan detected, tried in this order: `laravel`, `nestjs`, `django`, `symfony`, `nextjs`, `express`, `fastapi`, `rails`, `spring`, `aspnet`, `flutter`, and `vue` for a Vue Router app. Exit 3 when none is detected.
- `--preset <id>`: one of `aspnet`, `clean`, `ddd-contexts`, `django`, `express`, `fastapi`, `feature-sliced`, `flutter`, `hexagonal`, `laravel`, `layered`, `mvc`, `mvvm`, `nestjs`, `nextjs`, `onion`, `rails`, `spring`, `symfony` or `vue`. The proposal is a configuration that `extends` the shipped preset `mapx:preset/<id>` (see [architecture-rules.md](architecture-rules.md#presets)). The preset's folder parameter (`root`) is inferred: the folder, up to three levels down, under which the most of the preset's layers have files. For `ddd-contexts`, every folder under `root` becomes a context layer. `--preset` and `--from` exclude each other.

Whatever the source, when the index has references to packages outside the workspace, the proposal also declares a `Packages` layer, `{ "package": "*" }`, that every layer may use (`"*": ["Packages"]`) (M5-24). Its package selector opts the configuration in to uncovered packages, and it covers every package, so `mapx check --fail-on-uncovered` passes on the proposal's first day; without a non-overlay layer that has a package selector, packages are out of scope (M5-24-R4, D039). That layer is left out of `layers` in the JSON output and of the empty-layer warnings.

Options:
- `--baseline`: also propose `.mapx/architecture.baseline.json` (the view's own baseline file for a view), listing the proposal's violations on today's index, so `mapx check` exits 0 until a new violation appears. It needs a current index: on a stale one it exits 4 (`--sync` syncs first). Without `--baseline`, a stale index is accepted, since roles and paths are what a proposal reads.
- `--write`: write the files. It refuses each of these with exit 3, and writes nothing:
  - a configuration or baseline file that already exists, unless `--force` is given;
  - a proposal whose every layer is empty (no file matches its selectors), unless `--force` is given;
  - a proposal with problems;
  - a target that is a symlink, or that is in a folder resolving outside the workspace, even with `--force`.

  The files are written together. Each is staged in a temporary file first, so a failure (a directory in the way, no permission) leaves the configuration and baseline as they were, and exits 3. A dry run warns, on stderr, when every layer or most of them are empty.
- `--force`: with `--write`, overwrite an existing configuration and baseline, and write a proposal whose layers are all empty.
- `--view <name>`: propose `.mapx/architecture/<name>.jsonc`. A name that leads outside `.mapx/architecture/` (`../x`, or through a symlink) is exit 3.
- `--format json` / `--json`: `{ path, view, exists, written, source, preset, archetype, parameters, layers: [{ name, files, role?, cluster?, path? }], unplaced: [{ role, files }], unclassified: { name, paths, files } | null, observed: [{ from, to, dependencies, violations }], violations, baseline: { path, entries, exists, written } | null, issues, notes, warnings, config }`, where `config` is the JSONC.

It exits 0 on success, 3 for a usage error, a refused write or a failed one, and 4 for a missing or outdated index (or a stale one with `--baseline`). The output depends only on the index: the same index gives the same bytes.

```bash
$ mapx arch init --preset clean --baseline
// Proposed by `mapx arch init` from the preset mapx:preset/clean (AR-15): Clean Architecture, dependencies pointing inward.
// Review it before relying on it. Layers and rules declared here merge over the preset's (a layer of
// the same name replaces the preset's); `mapx arch layers` lists the result.
// root = "src/": the folder where the most of the preset's layers have files (4 of 4, 6 files).
// The layers on this index (files; dependencies on other layers today):
//   Domain          1 file; → Infrastructure 2; against the rules: Infrastructure 2
//   Application     2 files; → Domain 3
//   Adapters        1 file; → Application 2
//   Infrastructure  2 files; → Application 2, Domain 1
// Today: 10 dependencies between layers, 2 against these rules.
// With the baseline (.mapx/architecture.baseline.json), `mapx check` skips today's 2 violations and fails on new ones.
{
  "extends": "mapx:preset/clean",
  "parameters": { "root": "src/" }
}
Dry run (4 layers, 2 violations today): nothing written. Add --write to create .mapx/architecture.jsonc and .mapx/architecture.baseline.json (2 entries).

$ mapx arch init --preset clean --baseline --write
Wrote .mapx/architecture.jsonc (4 layers, 2 violations today).
Wrote .mapx/architecture.baseline.json (2 entries).
Review it, then run `mapx check`.

$ mapx check
Violations: 0 (0 error, 0 warn)   Uncovered: 0   Skipped: 2   Allowed: 8   Warnings: 0   Errors: 0
```

### `mapx arch validate-config`

Validates the architecture rules configuration, `.mapx/architecture.jsonc` or a view, with every document it `extends`. It reads no index, so it works before `mapx init`. Every problem is printed at once, in document order, as `file#pointer: message`, where the pointer is a JSON pointer into that document. See [architecture-rules.md](architecture-rules.md#the-configuration-document) for what is checked.

```bash
mapx arch validate-config [path] [--dir /path] [--view <name>] [--format text|json]
```

Options:
- `--view <name>`: validate `.mapx/architecture/<name>.jsonc`. An empty name is an error, and so is a name or a symlink that leads outside `.mapx/architecture/` (`../x`).
- `--format json`: `{ valid, view, files, issues: [{ file, pointer, message }] }`, where `files` lists the documents read, extended ones first. A valid configuration also has `policy: { uncovered: { externals: { value, source, file?, layer? }, builtins } }`: the resolved uncovered policy, and why packages in no layer are or are not reported (`source`: `explicit` in `file`, `package-selector` in `layer`, or `default`; M5-24-R4). The text form adds a line such as `Packages in no layer: out of scope (policy.uncovered.externals is unset and no non-overlay layer has a package selector).`

It exits 0 when the configuration is valid, and 3 when it has problems, does not exist, or for a usage error. The MCP tool `mapx_arch_validate_config` does the same.

```bash
$ mapx arch validate-config
.mapx/architecture.jsonc#/layers/0/selectors/0/paht: unknown selector key "paht"; expected one of path, name, …
.mapx/architecture.jsonc#/rules/Http/0: unknown layer "Servce"
2 problems in .mapx/architecture.jsonc.
```

### `mapx arch` introspection subcommands

Questions about the architecture configuration, answered from the index without a whole check (Deptrac's `debug:*` commands). See [architecture-rules.md](architecture-rules.md#introspection) for what each answers and the JSON it prints.

```bash
mapx arch layers [layer] [--why] [--nested]          # layers and sizes; a layer's members
mapx arch which <element>                            # the layers of a file or symbol, and why (with a hierarchy match's chain)
mapx arch unassigned [--kind <kind>] [--path <path>] [--nested]
mapx arch deps <from> [to]                           # concrete edges from one layer to another
mapx arch unused [--limit <n>]                       # allowances used at most n times (default 0)
mapx arch changed [files...] [--since <ref>] [--with-dependents]
mapx arch allowed <from> <to> [--type <edgeType>]    # would mapx check pass this dependency?
```

Every subcommand takes:
- `-d, --dir <path>`: the workspace (`mapx arch` takes no path argument before a subcommand name; a directory named like a subcommand needs `--dir`).
- `--view <name>`: use `.mapx/architecture/<name>.jsonc`.
- `--format text|json` (default `text`), or `--json`.
- `--sync`: when files changed since the last scan, sync the index first (not on `changed`).

Elements (`which`, `allowed`) are named by an indexed file path, a qualified name (`App\Domain\Order`, `src/domain/Order.ts#Order`), a scoped name (`Order::run`, `Order.run`), a bare symbol name (top-level symbols first), or, when none of these matches, an external package or built-in by name or by ecosystem and name (`pg`, `npm:pg`, `node:fs`; M5-24). A name that matches several elements is an error that lists them (`candidates` in JSON). `allowed` also takes layer names.

Exit codes follow `mapx check`:

| Code | Meaning |
| --- | --- |
| 0 | Answered |
| 1 | `allowed`: `mapx check` would report an error-level violation for the dependency (in any edge type or source layer) |
| 2 | `unassigned`: at least one element is in no layer |
| 3 | No configuration or no such `--view`, an invalid configuration, or a usage error: an unknown option or layer, an element no query resolves or several match, an unknown `unassigned --kind` or a `--path` that matches no indexed file, a bad `--limit`, `--type`, or a `--since` ref no repo has |
| 4 | No index, a repo never scanned, a stale index (run `mapx update` or pass `--sync`; `changed` reads a stale index as it is), an index an older MapX built, or an internal error |

With `--format json`, every failure prints `{ "error": "…" }` on stdout, with `candidates` for an ambiguous name or an unknown layer and `issues` for an invalid configuration.

Examples:
```bash
$ mapx arch which OrderId
src/domain/ids/OrderId.ts#OrderId (class, src/domain/ids/OrderId.ts)
  Domain  ← selectors[0].all
  Shared  ← selectors[1].path
$ mapx arch allowed OrderController Order
✖ not allowed (disallowed-layer, error): Controller may not depend on Domain over import: no rule allows it
  ✖ import [Controller] disallowed-layer (error), in the index (verified)
  ✖ instantiation [Controller] disallowed-layer (error), in the index (verified)
Controller may depend on: Application
$ mapx arch allowed PlaceOrder SqlOrderRepository          # AR-19 alternatives (M5-14)
✖ not allowed (disallowed-layer, error): Application may not depend on Infrastructure over import: no rule allows it
  ✖ import [Application] disallowed-layer (error), in the index (verified)
  ✖ instantiation [Application] disallowed-layer (error), in the index (verified)
Application may depend on: Domain
  instead, in Domain: src/domain/OrderRepository.ts#OrderRepository (supertype)
$ mapx arch changed --since origin/main --with-dependents --json   # selective CI
$ mapx arch unassigned --kind class                                # coverage gate: exit 2 if any
```

### `mapx arch graph`

Draws the layer graph: one node per layer, and per layer pair the dependencies `mapx check` counts, with the same decisions. See [architecture-rules.md](architecture-rules.md#layer-graphs) for what it draws and the JSON shape.

```bash
mapx arch graph [--format dot|svg|mermaid|dsm|json] [-o <file>] [--view <name>] [--baseline <file>] [--no-graphviz] [--sync] [-d <dir>]
```

- `--format`: `dot` (default, Graphviz), `svg`, `mermaid` (a flowchart for Markdown), `dsm` (a layer × layer text matrix) or `json` (the graph itself; `--json` is the same).
- `-o, --output <file>`: write to a file (relative to the current directory; its folder is created) instead of stdout.
- `--baseline <file>`: use this baseline instead of the configuration's. As in `mapx check`, baselined violations are drawn as skipped.
- `--no-graphviz`: for `svg`, always use the built-in renderer. Without it, `svg` uses Graphviz (`dot -Tsvg`) when it is installed, as `mapx export --format svg` does, and the built-in renderer otherwise: when `dot` is missing, fails, prints no SVG, or runs longer than `MAPX_GRAPHVIZ_TIMEOUT_MS` (default 10000; it is then killed). The timeout and the output check apply to `mapx export --format svg` too. The built-in renderer needs no dependency, and its output is byte-stable on every machine; Graphviz output depends on the Graphviz version.
- `-d/--dir`, `--view` and `--sync` work as for the introspection subcommands.

Edge labels are dependency counts. Allowed dependencies are grey, violations red, warn-level violations (an advisory allowance, or an inferred edge under `policy.inferred: "warn"`) amber, and skipped (baselined) violations dashed. A pair with several statuses gets one edge per status. Groups are subgraphs, hidden layers are left out, and the totals (a graph label in DOT, a `%%` comment in Mermaid, the footer in SVG and the DSM) are `mapx check`'s own counts, hidden layers included. A dependency on an element in two layers counts once in the totals, but on both pairs' edges. The output is sorted by the configuration's layer order, so the same index and configuration give the same bytes.

It exits 0 whatever the graph shows: it is not a gate. 3 is a configuration or usage error (an unknown `--format`, a missing `--baseline` file), and 4 an index problem, as for the subcommands above.

```bash
$ mapx arch graph | dot -Tpng -o layers.png
$ mapx arch graph --format mermaid -o docs/layers.mmd
$ mapx arch graph --format svg --no-graphviz -o layers.svg
$ mapx arch graph --format dsm
── Layer Dependency Structure Matrix (DSM) ────────────
                    L1   L2   L3   L4
...
L1 Controller        *   8!   2~    .
```

## `mapx check`

Checks the architecture rules in `.mapx/architecture.jsonc` against the index: layers, the allow policy, private parts and internal elements. See [architecture-rules.md](architecture-rules.md) for the configuration, with an example of every selector, rule, reporter and exit code. It is meant for CI, so it never prints the logo and its exit code says what it found. MapX runs it on its own source in CI ([MapX's own rules](architecture-rules.md#mapxs-own-rules)).

```bash
mapx check [path] [--view <name>] [--format table|json|sarif|github|codeclimate|junit] [--output <file>]
           [--report-uncovered] [--fail-on-uncovered] [--report-skipped] [--report-allowed]
           [--fail-on error|warn] [--layer <name>] [--rule <rule>] [--sync]
           [--baseline <file>] [--generate-baseline [file]] [--compare <report.json>]
```

Options:
- `--view <name>`: check `.mapx/architecture/<name>.jsonc` instead.
- `--format`: how the report is printed. Every format lists the same findings (those the `--report-*` options show), in the same stable order, and is byte-stable: no timestamps, durations or absolute paths. See [CI formats](#ci-formats) below.
  - `table` (the default): findings grouped by source layer, with file and line.
  - `json`: the report described by `schemas/arch-report.schema.json`.
  - `sarif`: SARIF 2.1.0, for GitHub code scanning and IDE viewers.
  - `github`: GitHub Actions annotations. Chosen when `GITHUB_ACTIONS` is `true`, no `--format` is given and the report goes to stdout (with `--output`, the file gets the table).
  - `codeclimate`: a GitLab Code Quality report.
  - `junit`: JUnit XML, for GitLab's and Jenkins's test reports.
- `--output <file>`: write the report to a file instead of stdout. The path is relative to the current directory, and missing folders are created.
- `--report-uncovered`: list dependencies on elements in no layer. Otherwise they are only counted.
- `--fail-on-uncovered`: exit 2 when there are any (also lists them).
- `--report-skipped`: list violations a baseline or `--compare` skips. Each has `skippedBy` set to `baseline` or `compare`.
- `--report-allowed`: list allowed dependencies too.
- An inherited dependency (`policy.inheritDependencies`) has `via`, the inheritance path from the source type to the ancestor whose dependency it is, and its message ends `inherited via …`. See [architecture-rules.md](architecture-rules.md#type-hierarchy-and-members).
- `--fail-on warn`: warn-level violations (advisory rules, inferred edges) and warnings (`multi-layer`, `empty-layer`, `unsupported-selector`) also fail the run.
- `--layer <name>`: only findings whose source or target layer is `<name>`, or that are about that layer. A name that is not a layer of the configuration is an error (exit 3), so a typo cannot turn the check off. A layer whose name contains ", " is matched whole: findings carry their layers as a list (`source.layers`, `target.layers`) next to the joined `layer`.
- `--rule <rule>`: only findings of one rule: `disallowed-layer`, `internal-element`, `private-layer`, `uncovered`, `allowed`, `multi-layer`, `empty-layer`, `unsupported-selector`, or the errors `plus-cycle`, `config` and `stale-baseline`. An unknown rule is an error (exit 3).
- `--sync`: when files changed since the last scan, sync the index first instead of failing.
- `--baseline <file>`: use this baseline instead of the configuration's `baseline`. The path is relative to the current directory.
- `--generate-baseline [file]`: write every current violation to the baseline and exit 0.
  - Without `<file>`, it writes the baseline the check reads: `--baseline`, else the configuration's `baseline`, else `.mapx/architecture.baseline.json` (`.mapx/architecture/<view>.baseline.json` for a view).
  - It ignores the baseline in force, so a regenerated baseline lists every violation and drops stale entries.
  - It takes no `--compare`, `--layer` or `--rule` (exit 3), and writes no report, so `--format` and `--output` have no effect.
  - `<file>` must end in `.json` and must not be a directory (exit 3). The option takes the word after it, so put the workspace path first: `mapx check <path> --generate-baseline`.
  - A view writes `.mapx/architecture/<view>.baseline.json` unless the view's own document sets `baseline`.
  - A file in the workspace outside `.mapx/` gets a warning with a `.mapx/` path to use instead: it would make the index stale (exit 4).
- `--compare <report.json>`: the ratchet without a committed baseline. A violation whose fingerprint is in this report (`mapx check --format json` on the base revision) is skipped. Only new violations fail. Warnings under `--fail-on warn`, uncovered dependencies under `--fail-on-uncovered` and strict `multi-layer` errors whose fingerprints the report has do not fail either. Configuration errors and stale baseline entries always fail. A base report of another `--view`, or narrowed by a `--layer` or `--rule` the check does not share, is refused (exit 3): each report records them as `selection`.

Baselines are described in [architecture-rules.md](architecture-rules.md#baselines-and-the-ratchet). Keep baselines and base reports under `.mapx/` or outside the workspace. MapX indexes JSON files, so a new one anywhere else makes the index stale (exit 4) until the next scan. The same holds for a report written into the workspace (`-o`) when another `mapx` command runs after it in the same CI job, whatever its format, if MapX indexes its file type: `-o report.json` and `-o report.md` (a table) make the index stale, while `.sarif`, `.xml` and `.txt` files are not indexed.

Before checking, `mapx check` makes sure the index is current. Every registered repo must have a completed scan, and no indexed file may have changed or been deleted. No new file a scan would index may be missing, in a git workspace or not, in nested repos too.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | No failing finding |
| 1 | Violations of severity error (with `--fail-on warn`, also warn-level violations and warnings) |
| 2 | Uncovered dependencies, with `--fail-on-uncovered` |
| 3 | Configuration errors (invalid document, a `+` cycle), no configuration or no such `--view`, a usage error (an unknown option, a missing value, an unknown `--layer` or `--rule`), or a baseline error: a stale entry (`stale-baseline`), a missing or invalid baseline, or a missing or invalid `--compare` report. With any `--format` but `table` (or with `--output`), a missing configuration still gives a report with one `config` error |
| 4 | No index, a repo never scanned, a stale index (run `mapx update` or pass `--sync`), an index an older MapX built (run `mapx scan` or pass `--sync`), or an internal error |

When several apply, the lower-level problem wins: 4, then 3, then 1, then 2. `--layer` and `--rule` narrow what fails, but a configuration error always fails.

Examples:
```bash
mapx check                                   # table; exit 1 on violations
mapx check --format json -o arch-report.json # the report for CI or other tools
mapx check --sync --fail-on-uncovered        # sync first; every dependency must be in a layer
mapx check --layer Domain --rule disallowed-layer
mapx check --generate-baseline               # freeze today's violations in .mapx/architecture.baseline.json
# CI ratchet: check a scanned checkout of the merge base, then compare the head with it
mapx check ../base --format json --report-skipped --report-uncovered -o /tmp/base.json
mapx check --compare /tmp/base.json          # exit 1 only on violations new since the base
mapx check --format sarif -o mapx.sarif      # for github/codeql-action/upload-sarif
mapx check --format codeclimate -o gl-code-quality.json
mapx check --format junit -o mapx-junit.xml
```

### CI formats

Paths in every CI format use `/` and are relative to the root of the git repository that holds the workspace, where GitHub and GitLab look files up: a workspace in the monorepo folder `services/api` names `services/api/app/Domain/Order.php`. At the repository root, or outside git, they are workspace-relative. If git refuses a workspace inside a checkout (a wrong `GIT_DIR`, git's "dubious ownership" check in a CI container: add the folder to `safe.directory`), the paths are workspace-relative and a warning on stderr says so; stdout is still only the report. (The `table` and `json` formats, and messages, stay workspace-relative.) A stale baseline entry is located on the baseline file (relative, even outside the workspace: `../ci/baseline.json` from a workspace at the repository root, `services/ci/baseline.json` from `services/api`), its message naming the entry by JSON pointer (`#/entries/0`). A file outside the repository (or, with no repository, outside the workspace) is never a location in a CI format, because a `..` path would leave `%SRCROOT%` and code scanning needs a file in the repository: the finding is located on the configuration file, at the line of its `"baseline"` key (line 1 when `--baseline` names the file), its message ends `(in ../shared/bl.json, outside the repository)`, and in `sarif` `properties.outsideRoot` names the file. A workspace inside a git submodule names files from the submodule's root, the repository they belong to. A finding without a source file (a configuration error, `empty-layer`, `unsupported-selector`) is located on the configuration file, `.mapx/architecture.jsonc` or the view's. Allowed dependencies (`--report-allowed`) appear only in `sarif` (as `kind: "pass"`) and `junit` (as passing testcases).

**Every format marks exactly the findings that fail the run at its failing level:** SARIF `error`, `::error`, the CodeClimate `error` severity, and a JUnit `<failure>` or `<error>`. Which findings fail follows the exit code: errors always do, warn-level violations and warnings with `--fail-on warn`, uncovered dependencies with `--fail-on-uncovered`, and nothing the `--compare` base report knows. So a run that exits 1, 2 or 3 always shows its cause at the failing level.

| Finding | Fails the run | `sarif` level | `github` command | `codeclimate` severity key (default) | `junit` |
| --- | --- | --- | --- | --- | --- |
| failing (see above) | yes | `error` | `::error` | `error` (`major`) | `<failure>`; `<error>` for `config`, `plus-cycle`, `stale-baseline`, in suite `configuration` |
| violation or warning that does not fail (warn level without `--fail-on warn`, known to `--compare`) | no | `warning` | `::warning` | `warn` (`minor`) | passes, message in `<system-out>` |
| uncovered, without `--fail-on-uncovered` | no | `note` | `::notice` | `uncovered` (`info`) | passes |
| skipped (baseline or `--compare`) | no | `note`, with an `external`, accepted suppression | `::notice` | `skipped` (`minor`) | `<skipped>` |

- **`sarif`:** one run of the driver `MapX`, with the rules its results use. Each result has a `%SRCROOT%`-relative location with its first line (1 when the finding has none: code scanning requires one), the element as a logical location, `partialFingerprints["mapx/v1"]` (the finding's fingerprint) and properties (kind, layers, target, edge type, verifiability). `automationDetails.id` is `mapx-check/`, or `mapx-check/<view>/`, so code scanning keeps views apart. It validates against the official SARIF 2.1.0 schema. GitHub code scanning accepts uploads up to 10 MB (gzip-compressed) and 25,000 results per run; MapX does not truncate, so narrow a larger report with `--layer` or `--rule`, or leave out `--report-uncovered`, `--report-skipped` and `--report-allowed`.
- **`github`:** first every finding as a plain log line (`[error] app/Domain/Order.php:5 disallowed-layer: …`), then one workflow command per finding (`::error file=…,line=…,title=<rule>::<message>`), then the counts line. GitHub shows at most 10 annotations of each level per step, so the run's causes are annotated first: configuration errors, stale baseline entries, then failing findings by severity, then the rest in report order. Beyond 10 per level a finding is not annotated, and the counts line says how many (`N more not annotated`); the log lines above still list it, and `sarif` has them all. Text is escaped as the Actions toolkit does: `%`, CR and LF in the message, and also `:` and `,` in properties; a log line has its line breaks replaced by spaces. So a finding is always one line. The format is chosen automatically only for stdout: with `--output` and no `--format`, the file gets the table.
- **`codeclimate`:** the JSON array GitLab reads as `artifacts:reports:codequality`. Each issue has `type`, `check_name` (the rule), `description`, `categories`, `severity`, `fingerprint` and `location` (`path`, `lines.begin`; 1 when the finding has no line). A violation's `fingerprint` is the finding's, as in the JSON report and baselines, so GitLab tracks it across base and head; every other kind gets one derived from its kind, rule and finding fingerprint, because one finding fingerprint can name a violation, the same dependency skipped, and its stale baseline entry. Severities come from `report.codeclimate` in the configuration ([architecture-rules.md](architecture-rules.md#ci-reports)).
- **`junit`:** for `artifacts:reports:junit` and Jenkins's `junit` step. One testsuite per non-overlay layer, in the configuration's order, then one per other group: a source in several layers (`Domain, Shared`) and `configuration`. With `--layer`, only that layer and the groups with findings. **One testcase per finding**, named after the dependency (`App\Domain\Order → App\Infra\Repo (import)`) with the rule as class name. A layer without findings has one passing testcase, `no findings`, so a clean run is never an empty report. Characters XML 1.0 cannot carry (control characters, lone surrogates) become U+FFFD. It validates against the Jenkins xUnit plugin's JUnit schema.

## `mapx explain <file>`

Explain the automatic file role/layer classification result for a given file. Shows the role, its confidence and every signal the last scan stored for the file (path, naming, topology, framework, imports), each with its role, confidence and reason. The path is the indexed, workspace-relative one.

```bash
mapx explain <file> [--dir /path]
```

Examples:
```bash
mapx explain src/core/scanner.ts
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
