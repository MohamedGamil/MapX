# Iteration Log

Chronological record of all iterations: when they were started, completed, what was in scope, and what changed mid-flight.

---

## Template

```
## IXX — <title>

| Field | Value |
|-------|-------|
| Status | planned / in-progress / in-review / done / deferred |
| Started | YYYY-MM-DD |
| Completed | YYYY-MM-DD |
| Features | FXX, FXX |
| Branch | feat/iXX-<slug> |
| PR | #NNN |

### Scope
<!-- One paragraph on what this iteration delivers. -->

### Changes from original spec
<!-- List any decisions made during implementation that deviated from the spec. -->

### Blockers / notes
<!-- Anything that slowed this down or should inform the next iteration. -->
```

---

## I01 — Schema migration + parser edge labelling

| Field | Value |
|-------|-------|
| Status | `planned` |
| Started | — |
| Completed | — |
| Features | F01 |
| Branch | `feat/i01-edge-verifiability` |
| PR | — |

### Scope

Adds an `verifiability` column (`verified` \| `inferred`) to the `edges` SQLite table. Updates the PHP, JavaScript, and TypeScript parsers to label method calls and dependency edges at parse time. Introduces a common-method filter list so generic framework method names default to `inferred`.

### Changes from original spec

_None yet._

### Blockers / notes

_None yet._

---

## I02 — Glob filter pipeline in scanner

| Field | Value |
|-------|-------|
| Status | `planned` |
| Started | — |
| Completed | — |
| Features | F03 |
| Branch | `feat/i02-glob-filters` |
| PR | — |

### Scope

Extends `mapx scan` and `mapx export` with `--include` and `--exclude` glob pattern flags. Pattern matching is applied in the file-discovery walk before any file is read or parsed, so excluded files incur zero I/O cost. Patterns are also persisted in `.mapx/config.json` as project-level defaults.

### Changes from original spec

_None yet._

### Blockers / notes

_None yet._

---

## I03 — CLI + MCP surface (`metrics`, `edges`)

| Field | Value |
|-------|-------|
| Status | `planned` |
| Started | — |
| Completed | — |
| Features | F02, F04 |
| Branch | `feat/i03-metrics-edges` |
| PR | — |

### Scope

Implements two new CLI subcommands and their corresponding MCP tools:

- `mapx metrics` / `mapx_metrics` — coupling report (in-degree, out-degree, instability, afferent/efferent coupling)
- `mapx edges` / `mapx_edges` — neighbourhood query for a single file

F02 (`metrics`) depends on the `verifiability` column introduced in I01. F04 (`edges`) is independent.

### Changes from original spec

_None yet._

### Blockers / notes

Depends on I01 being merged before the `--verified-only` flag in `mapx metrics` can be implemented.

---

## I04 — PHP Parser Fundamentals

| Field | Value |
|-------|-------|
| Status | `planned` |
| Started | — |
| Completed | — |
| Features | F05, F06, F10 |
| Branch | `feat/i04-php-fundamentals` |
| PR | — |

### Scope

Fixes the critical baseline gaps in the PHP parser before any Laravel-specific logic is added. Three features are bundled: (F05) capture fully-qualified names from `use` import declarations instead of only the final name segment; (F06) extract constructor injection, method parameter, and return-type edges as `param_type`/`return_type` edge types; (F10) add Laravel project detection to `mapx init` and default exclusion patterns for migrations, seeders, factories, `bootstrap/cache`, and Blade template files.

### Changes from original spec

_None yet._

### Blockers / notes

F05 is a prerequisite for all of I05 — the use-import table it builds is consumed by F07, F08, and F09. I04 should be merged before I05 work begins.

---

## I05 — Laravel Structural Patterns

| Field | Value |
|-------|-------|
| Status | `planned` |
| Started | — |
| Completed | — |
| Features | F07, F08, F09 |
| Branch | `feat/i05-laravel-structural` |
| PR | — |

### Scope

Adds parser support for the three structural patterns that define every Laravel application architecture: (F07) Eloquent relationship edges (`hasMany`, `belongsTo`, etc.) from models to related models; (F08) route-to-controller binding edges from route files to controller classes and methods; (F09) IoC container binding edges from service providers, mapping abstract interfaces to concrete implementations.

### Changes from original spec

_None yet._

### Blockers / notes

Depends on I04 being fully merged — all three features rely on the use-import table from F05 to resolve `::class` constant arguments to FQNs.

---

## I06 — Laravel Advanced Patterns

| Field | Value |
|-------|-------|
| Status | `planned` |
| Started | — |
| Completed | — |
| Features | F11, F12 |
| Branch | `feat/i06-laravel-advanced` |
| PR | — |

### Scope

Completes the Laravel graph layer with two advanced patterns: (F11) facade resolution — a post-parse edge rewriting step that maps static `Cache::`, `DB::`, `Log::` calls to their underlying service FQNs using a built-in 26-entry facade map (extendable via config); (F12) event/job/notification dispatch edges — new `dispatch` and `notify` edge types capturing the various async dispatch forms (`event()`, `X::dispatch()`, `->notify()`, `Notification::send()`).

### Changes from original spec

_None yet._

### Blockers / notes

Depends on I05 being merged. F11 and F12 are independent of each other within I06 and can be developed in parallel. The `$listen` array parsing in `EventServiceProvider` is a stretch goal in F12 — may slip to I07 if tree-sitter query complexity is too high.

---

## I07 — npm Distribution & Node.js Developer Experience

| Field | Value |
|-------|-------|
| Status | `planned` |
| Started | — |
| Completed | — |
| Features | F13 |
| Branch | `feat/i07-npm-distribution` |
| PR | — |

### Scope

Adds an npm-compatible build pipeline so that Node.js developers can install mapx with `npm install -g mapx` or run it with no prior installation via `npx mapx`. The core changes are: (1) add `tsup` to transpile TypeScript to JS preserving directory structure (required for WASM path resolution to work correctly in the installed package); (2) update `package.json` with `bin`, `files`, `engines`, promote `better-sqlite3` to a regular dependency; (3) add a GitHub Actions workflow that automatically publishes to npm on version tag push with npm provenance for supply chain transparency. No parsing, graph, or export logic is changed — the Node.js runtime path already exists in the codebase via `NodeStore`.

### Changes from original spec

_None yet._

### Blockers / notes

Fully independent of I01–I06. Can be merged at any time. Requires a one-time setup by the repository maintainer: create npm account, generate automation token, configure `NPM_TOKEN` secret in GitHub repository settings, verify package name availability, and perform the first manual `npm publish --access public`.
