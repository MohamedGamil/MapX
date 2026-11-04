# Configuration

MapxGraph stores its configuration in `.mapx/config.json`. The architecture rules have their own file, `.mapx/architecture.jsonc`, described in [architecture-rules.md](architecture-rules.md). The dashboard's Configuration tab (`mapx ui`) shows the effective settings, where each comes from, and any invalid or unknown setting.

## Default Config

```json
{
  "version": "1.0.0",
  "repos": [
    {
      "name": "my-project",
      "path": "."
    }
  ],
  "languages": {},
  "settings": {
    "maxTokenBudget": 16384,
    "excludePatterns": [
      ".git/**", ".mapx/**", "node_modules/**", "**/node_modules/**", "dist/**", "**/dist/**",
      "vendor/**", "**/vendor/**", "build/**", "**/build/**", "*.min.js", "*.min.css",
      "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.json", "composer.lock",
      "…"
    ],
    "includePatterns": [],
    "graphExcludePatterns": ["scratch/**", "benchmarks/**", "tests/**", "**/*.test.*", "**/*.spec.*"]
  }
}
```

The full default `excludePatterns` list is `DEFAULT_CONFIG` in `src/core/config.ts`: build and dependency folders, minified and vendored bundles, manifests and lockfiles, logs and editor files. Manifests and lockfiles are excluded from the index but still read: package attribution of external references uses `package.json`, `composer.json`, `pyproject.toml`, `go.mod` and their lockfiles (see [External dependencies](architecture-rules.md#external-dependencies-packages-built-ins-ambient-access)).

Each repo entry takes `name`, `path` (relative to the workspace root) and optionally `framework` (for example `laravel`, which turns on the [Laravel default excludes](#laravel-default-excludes)).

## Multi-Repo Setup

To track multiple repos or monorepo components:

```json
{
  "repos": [
    { "name": "frontend", "path": "./apps/web" },
    { "name": "backend", "path": "./apps/api" },
    { "name": "shared", "path": "./packages/shared" }
  ]
}
```

Use the workspace CLI to manage repos:

```bash
mapx workspaces add ../sibling-api --name api
mapx workspaces list
mapx workspaces discover    # find unregistered submodules, peers, VS Code folders
mapx workspaces remove api
```

## User-Defined Languages

Add custom language support without modifying the tool. Since Python is already built-in, here's an example with a hypothetical language:

```json
{
  "languages": {
    "haskell": {
      "extensions": [".hs"],
      "grammarWasm": "./grammars/tree-sitter-haskell.wasm",
      "queries": {
        "symbols": "./queries/haskell/symbols.scm",
        "references": "./queries/haskell/references.scm"
      },
      "nodeMappings": {
        "function": "function",
        "class": "type_class_declaration",
        "module": "module"
      }
    }
  }
}
```

See [Adding Languages](adding-languages.md) for details on writing query files.

## Built-in Language Coverage

All 23 supported languages are pre-configured. No `languages` entry is needed unless you want to override defaults or add a completely new language:

| Tier | Languages | Count |
|------|-----------|-------|
| **Built-in** | PHP, JavaScript, TypeScript, Python, Go, Rust, Java, C# | 8 |
| **Bundled** | Ruby, C, C++, Swift, Kotlin, Dart, Scala, Svelte, Vue, Lua, Elixir, Zig, Bash, Fish, Pascal | 15 |
| **Static** (index-only, no grammar) | Markdown, HTML, CSS, JSON, YAML | 5 |

The tier is what `mapx lang list` reports; every grammar ships with MapX. TypeScript's `.tsx` files have their own grammar entry (`tsx`) but count as TypeScript.

List all available languages and status with:
```bash
mapx lang list
```

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxTokenBudget` | number | 16384 | Maximum token budget for LLM export |
| `excludePatterns` | string[] | (see above) | Glob patterns for files to exclude from scanning |
| `includePatterns` | string[] | [] | If set, only include matching files; an exclude still wins |
| `graphExcludePatterns` | string[] | `["scratch/**", "benchmarks/**", "tests/**", "**/*.test.*", "**/*.spec.*"]` | Glob patterns for files to exclude from PageRank rankings and graph analysis (files are still indexed but deprioritized) |
| `laravelDefaultExcludes` | boolean \| string[] | `true` | Laravel's default excludes for repos with `"framework": "laravel"` (see below). `false` turns them off; a list applies only the patterns it names. |
| `parseWorkers` | `"auto"` \| number | `"auto"` | Parse workers per batch; see [Parallel parsing](#parallel-parsing). `"auto"` sizes the pool from the source to parse, the CPUs and the available memory. A number uses that many workers, at most one per file; `0` parses on the main thread. `MAPX_PARSE_WORKERS` overrides it, and `--no-parallel` forces one thread. |
| `php.facadeMap` | object | `{}` | Maps Laravel facade aliases to their classes (`{ "Cache": "Illuminate\\Cache\\CacheManager" }`), for facades MapX does not know |
| `http.clients` | `{ receiver, baseURL? }[]` | `[]` | HTTP client objects MapX cannot recognise on its own, for [HTTP pairing](framework-integration.md#http-pairing): calls on `receiver` (`apiService.get('/users')`) are HTTP calls, joined to `baseURL` |
| `http.hosts` | string[] | `[]` | Hosts of the workspace's own backends. An absolute URL pairs only when its host is one of these, a host named in a `.env*` file or a client's base URL, or a literal Laravel `Route::domain()` |
| `architecture` | object | — | Role classification overrides: see [Architecture & Role Classification](#architecture--role-classification). The architecture *rules* live in `.mapx/architecture.jsonc` instead |

### Environment variables

| Variable | Effect |
|----------|--------|
| `MAPX_PARSE_WORKERS` | Parse workers per batch, overriding `settings.parseWorkers` (see [Parallel parsing](#parallel-parsing)) |
| `MAPX_WORKER_IDLE_MS` | How long idle parse workers of `mapx serve` live (default 60000) |
| `MAPX_WORKER_BATCH_TIMEOUT_MS` | Watchdog for a parse batch that never answers (default 30 s plus 1 s per 100 KB) |
| `MAPX_WORKER_STATS` | `1` prints worker statistics after each parallel scan or sync |
| `MAPX_GRAPHVIZ_TIMEOUT_MS` | How long Graphviz may run for SVG output before the built-in renderer takes over (default 10000) |
| `MAPX_NO_BANNER` | Turns off the logo `init`, `scan` and `sync` print in a terminal |
| `MAPX_NO_UI` | `1`: `mapx ui` run from source does not build a missing or stale dashboard |
| `NO_COLOR` | Plain output, without colours |

Patterns match workspace-relative paths with `/` separators. A leading `./` is ignored, and `\` is read as `/`, so `./app/Models/**` and `app\Models\**` both mean `app/Models/**`. Because of this, a backslash cannot escape a glob character. Changing the patterns makes the next `scan` or `sync` re-parse every file once, so that edges into files that come back in are restored.

### Laravel default excludes

For a repo with `"framework": "laravel"`, every scan also excludes these patterns:

```
database/migrations/**  database/seeders/**  database/factories/**  storage/**
bootstrap/cache/**  public/**  resources/views/**  **/*.blade.php  vendor/**
```

When the repo is not at the workspace root, each pattern is scoped to its path (`api/public/**`). `mapx init` offers to add the same patterns to `excludePatterns`. If you decline, init records `"laravelDefaultExcludes": false`.

The default leaves `database/` and the views out: a migration, a seeder or a factory holds little application logic, and a Blade view is not PHP. Index them to check architecture rules on them (the `laravel` preset's Database and Views layers), by declining the suggestion or listing the defaults to keep. An indexed migration, seeder, factory or view (plain PHP or Blade) then gives the edges that name a class:
- `use`, `extends`, `new X`, `X::m()`, `X::class` (`$this->call(UserSeeder::class)`, `$model = User::class`) and type hints;
- in a Blade file, the PHP of `@php … @endphp` and `@php(…)`, the echoes `{{ … }}`, `{!! … !!}` and `{{{ … }}}`, `@use('Class')` and `@inject('name', 'Class')`. Comments, `@verbatim` and `@{{ … }}` are skipped, and so are the other directives (`@if (…)`, `@foreach (…)`, `@include('view')`, `<x-component>`), which are not complete PHP.
- A method called on an object links the method of the class the code gives, and nothing else: `$this->m()` (the class around), `$m->m()` for a parameter with a class type that the function never reassigns, `$this->prop->m()` for a typed or promoted property, `(new X())->m()`. A call on a variable of unknown class (`$table->id()`, `{{ $order->name() }}`) gives no edge in these files, since it would link every method of that name in the project; nor does `$this` in a view or an anonymous class (a Volt component, `return new class extends Migration`). `Order::factory()` links `Order`, not its factory.
- A method of a migration, seeder or factory (`up`, `down`, `run`, `definition`) is never the target of a call by name from another file.

`mapx init` on a Laravel app that declined the suggestion also keeps `**/migrations/**` and `**/seeds/**` out of `excludePatterns`; only `**/storage/**` is added.

To drop a single default, list the ones to keep. Also remove the pattern from `excludePatterns` if init added it there. For example, to index `public/`:

```json
{
  "settings": {
    "laravelDefaultExcludes": [
      "database/migrations/**", "database/seeders/**", "database/factories/**", "storage/**",
      "bootstrap/cache/**", "resources/views/**", "**/*.blade.php", "vendor/**"
    ]
  }
}
```

## Parallel parsing

`mapx scan` and `mapx sync` parse files on worker threads when the work repays them. `--no-parallel` (MCP: `parallel: false`) always parses on the main thread.
- **How many workers** (`settings.parseWorkers: "auto"`, the default), for each parse batch:
  - **None** below about 768 KB of source, since a cold worker needs about 384 KB to repay its startup.
  - **Otherwise** at least two workers, and at most the lowest of:
    - one per 384 KB;
    - CPUs − 1;
    - 8;
    - the number of files;
    - what half the available memory holds at 128 MB per worker.
  - **Warm workers:** workers already running, as in `mapx serve`, need only 48 KB each.
  - **Basis:** the figures were measured on real code (MapX's own sources: about 1.1 KB parsed per ms on one thread, and a 1.7× to 3.6× parse speed-up with 2 to 8 workers).
  - **Static files:** JSON, YAML, Markdown, CSS and HTML count a twentieth of their bytes, because they are scanned without a grammar.
  - **Available memory:** the lowest of the host's free memory, the runtime's figure and the container's limit less the process's RSS.
- **Overrides:** a whole number in `parseWorkers`, or in `MAPX_PARSE_WORKERS`, fixes the count, at most one per file and at most `max(CPUs, 8)`; `0` means one thread. Other values are ignored with one warning.
- **Grammars:** a worker loads a language's tree-sitter grammar only when it first parses a file of that language, and holds each grammar and compiled query once.
- **Distribution by language:** a batch's languages are laid end to end, the largest first, and cut into one equal share per worker. A large language spreads over several workers, small languages share one, and each worker loads only the grammars of its share. In `mapx serve`, a batch uses the workers that already hold most of its languages, and each share goes to the worker holding the most of it. Vue and Svelte files count as TypeScript, the grammar their scripts are read with. A worker that runs out of work takes files of a language it already holds, and loads another grammar only when enough work remains to repay it.
- **Batches:** a worker receives up to 16 files (or 256 KB) per message and answers in one message. A file that fails is still handed back on its own. When a worker dies on a batch, the batch's files are retried one per message, so only the file that kills a worker on its own is blamed. A batch that gets no answer within 30 s plus 1 s per 100 KB (`MAPX_WORKER_BATCH_TIMEOUT_MS`) is treated as a worker death.
- **One pool per run:** the parse batches of a scan or sync (each repo, re-resolution passes) share one pool of workers, so each worker starts, and loads its grammars, once per run. The CLI closes the pool when the run ends.
- **One pool per server:** `mapx serve` keeps one pool across `mapx_scan` and `mapx_sync` calls.
  - **Idle timeout:** its workers close after `MAPX_WORKER_IDLE_MS` milliseconds without work (default 60000).
  - **Process exit:** an idle worker never keeps the process alive.
- **Context:** each run sends its context (languages, framework ignore lists, `settings.php.facadeMap`) to the workers it reuses.
- **Crashes:** a worker that dies is replaced, and the file it was parsing goes to another worker. A file that kills two workers is parsed on the main thread.
- **Statistics:** `MAPX_WORKER_STATS=1` prints one line per scan or sync run that parsed on workers, to stderr. It reports the workers started during the run, the parse batches, the files and grammars of each live worker over its lifetime, the files handed back to the main thread, and the process's peak RSS:

  ```
  [mapx] worker-stats {"started":8,"batches":3,"messages":{"jobs":188,"context":8},"workers":[{"files":363,"grammars":[{"grammar":"php","loads":1}, …]}, …],"handbacks":0,"peakRssMb":671}
  ```
- **Hand-back:** a file a worker cannot return is parsed again on the main thread, with a warning.
- **Benchmark:** `npx tsx scripts/bench/workers.ts [--files N | --corpus <dir> --copies K] [--bin <binary>]` compares a parallel and a one-thread scan of a generated multi-language project, or of copies of a real directory: wall time, peak RSS, worker statistics, and whether the two indexes are identical.

## Architecture & Role Classification

MapxGraph dynamically profiles your codebase and classifies files into architectural roles. You can customize the classifier archetype, custom roles, and specific file classification overrides by adding an `architecture` section to the `settings` block in `.mapx/config.json`:

```json
{
  "settings": {
    "architecture": {
      "archetype": "web-api",
      "customRoles": [
        { "name": "billing", "paths": ["src/billing/**", "src/payments/**"] },
        { "name": "notifications", "paths": ["src/notifications/**"] }
      ],
      "overrides": {
        "src/legacy/**": "other",
        "src/graphql/resolvers/**": "api"
      }
    }
  }
}
```

### Architecture Settings Reference

| Setting | Type | Description |
|---------|------|-------------|
| `archetype` | string | Override the codebase archetype detection. Supported archetypes: `cli-tool`, `web-api`, `web-app`, `full-stack`, `library`, `monorepo`, `mobile-app`, `mixed`. |
| `customRoles` | object[] | Define new custom roles mapped to path patterns. Each entry has a `name` string and `paths` (string or array of strings). |
| `overrides` | record<string, string> | Map precise file/directory glob patterns directly to a specific dynamic role (e.g. `api`, `service`, `data`, `shared`, `other`). |

## .gitignore

The `.mapx/` directory is a local development artifact and should not be committed. During `mapx init`, the tool automatically adds `.mapx/` to `.gitignore` if:

- A `.gitignore` file already exists, or
- The project is a git repository

If the entry already exists in `.gitignore`, it is not duplicated.

### Gitignored files

MapX does not read `.gitignore` to decide what to index. `scan` indexes a gitignored file like any other, unless a default ignore (`node_modules`, `vendor`, `dist`, `build`, `coverage`, dot-named entries and the others in `src/core/file-rules.ts`) or an `excludePatterns` entry leaves it out. In a git repository, `sync` does the same: it asks git for the ignored entries, walks them with the same rules, and re-parses those whose content changed, so `sync` and `scan --force` give the same index. To keep generated or local files out of the graph, add them to `excludePatterns`.
