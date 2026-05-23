# Changelog

All notable changes to mapx are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/).

Unreleased work is tracked under **[Unreleased]**. When a version is released, move its entries from Unreleased and add a release date.

---

## [Unreleased]

### Added (I18 — Token Cost Benchmarking Suite)
- Added `mapx bench` built-in benchmarking suite for comparing LLM agent token consumption (baseline workspace reads vs MapX MCP tools)
- Added `benchmarks/run.ts` CLI runner with JSON output support (`--json`) and model pricing analysis
- Added `bench` and `bench-json` Makefile targets and npm scripts
- Added comprehensive Token Consumption Benchmarks section to README showing 87% average cost reduction

### Added (I16 — Audit Compliance Fixes)
- Added `mapx_workspaces` MCP tool with `list` and `discover` actions for workspace introspection
- Added `mapx workspaces discover` CLI subcommand for read-only repository discovery
- Added `--cluster` (`none`|`auto`) and `--depth` flags to `mapx export` for DOT/SVG cluster control
- Added `toon` to `mapx_export` MCP format enum
- Updated MCP `generateConfigs()` available tools list to include all 25 tools

### Changed (I16 — Audit Compliance Fixes)
- Fixed language tier alignment: Python/Go/Rust/Java/C# promoted to `built-in`; Ruby/C/C++/Swift/Kotlin/Scala/Dart/Vue promoted to `bundled` with relative WASM paths
- Vue language support changed from `installable` to `bundled`

### Added (I17 — Comprehensive Language Syntax Coverage)
- Expanded tree-sitter symbol and reference queries for all 20 languages (Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Dart, Scala, Vue, Svelte, Lua, Elixir, Zig, Bash, Pascal)
- Python: added constant symbols; expanded references with dotted inheritance, decorators, type annotations
- Go: added constant, namespace (package), property (var), type alias symbols; added interface embedding refs
- Rust: added impl, const, static, type alias, module, macro, enum variant symbols; added trait impl, scoped path, macro invocation refs
- Java: added field, constant, annotation type, enum constant, namespace (package) symbols; added extends, implements, annotation refs
- C#: added property, constant, namespace, record, delegate, event, enum member symbols; added inheritance, attribute refs
- Ruby: added module, constant, property (attr_*) symbols; added require, include/extend/prepend, inheritance, instantiation refs
- C: added enum, typedef, macro, union symbols; added #include refs
- C++: added namespace, enum, template, type alias symbols; added #include, inheritance, new instantiation refs
- Swift: added protocol, enum, extension, property, typealias symbols; added import, conformance, instantiation refs
- Kotlin: added object, property, enum entry symbols; added import, delegation extends/implements, instantiation refs
- Dart: added enum, mixin, extension, constructor, const/final symbols; added export, extends, implements, with, instantiation refs
- Scala: added trait, val, var, type alias, package symbols; added wildcard imports, extends, instantiation refs
- Vue: added class, method, property, arrow function symbols; added imports, member expression calls, Composition API tracking
- Svelte: added class, method, exported props, arrow functions, const symbols; added imports, member calls, lifecycle/store API tracking
- Lua: added method, local function, variable symbols; added require, dot-index/method calls
- Elixir: added defp, defmacro, defstruct, defprotocol, module attr symbols; added alias, import, use, require, remote calls, pipe, defimpl refs
- Zig: added struct, const, test, error set symbols; added @import, method call refs
- Bash: added variable assignment, alias symbols; added source/. includes, command substitution refs
- Pascal: added class, record, interface, method, constant, unit, variable, enum symbols; added uses, extends, instantiation refs
- Updated `nodeMappings` in `registry.ts` for all 20 languages

### Added (Misc)
- `mapx init` now auto-adds `.mapx/` to `.gitignore` when project is a git repo or `.gitignore` exists

### Added (I15 — Web Dashboard)
- Added `mapx ui` command — bundled lightweight web dashboard for graph visualization

### Added (I14 — TOON Export)
- Added `mapx export --format=toon` — TOON compact export format with delimiter and key-folding options

### Added (I13 — Framework Routes)
- Added framework-aware parsing for 21 frameworks (Laravel, Express, Next.js, Django, Flask, FastAPI, Spring, ASP.NET, Rails, Gin, Echo, Fiber, Actix, Rocket, Symfony, Yii2/Yii3, WordPress, Vue Router, React Router, SvelteKit, Nuxt)

### Added (I12 — Language Expansion)
- Added support for 14 additional languages beyond PHP/JS/TS: Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Svelte, Vue, Dart, Scala
- Added 8 installable languages: Lua, Elixir, Zig, Bash, Pascal, and more
- Added `mapx lang list`, `mapx lang install`, `mapx lang uninstall` commands

### Added (I11 — Smart Context & Search Tools)
- Added `ContextBuilder` API for intelligent, token-budgeted prompt context generation
- Added 7 new MCP tools: `mapx_search`, `mapx_context`, `mapx_callers`, `mapx_callees`, `mapx_impact`, `mapx_node`, and `mapx_files`
- Added 6 new CLI commands: `mapx search`, `mapx callers`, `mapx callees`, `mapx impact`, `mapx node`, and `mapx files`
- Enhanced `mapx status` CLI and `mapx_status` MCP tool with language breakdown, PageRank top files/symbols lists, and Git stale index detection with upgrade recommendations

### Added (I10 — Git & Workspace Awareness)
- Added multi-repository workspace support: `mapx workspaces add/remove/list/sync`
- Added `mapx_workspaces` MCP tool for workspace management
- Added cross-repo edge detection and tracking

### Added (I09 — LLM Integration)
- Added MCP server with stdio and SSE transports: `mapx serve`

### Added (I08 — Data Flow Tracing)
- Added `mapx trace`, `mapx sources`, `mapx sinks` commands
- Added `mapx_trace`, `mapx_sources`, `mapx_sinks` MCP tools
- Added `FlowTracer` with configurable max-depth and deterministic clustering

---

## [0.1.6] — 2026-05-22

### Changed
- Full rebrand from `codegraph` to `mapx` across all CLI commands, MCP tools, storage paths, class names, and documentation
  - CLI binary renamed: `codegraph` → `mapx`
  - Storage directory renamed: `.codegraph/` → `.mapx/`
  - Database renamed: `codegraph.db` → `mapx.db`
  - MCP server name: `codegraph` → `mapx`
  - MCP tools: `codegraph_*` → `mapx_*`
  - TypeScript class `CodeGraph` → `MapxGraph`
  - TypeScript type `CodeGraphConfig` → `MapxConfig`
  - All build artefacts, installer scripts, and docs updated

---

## [0.1.5] — prior release

_Changelog entries not yet backfilled. See git log for history._

---

## [0.1.4] — prior release

_Changelog entries not yet backfilled. See git log for history._

---

<!-- Links (keep at the bottom) -->
[Unreleased]: https://github.com/<owner>/mapx/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/<owner>/mapx/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/<owner>/mapx/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/<owner>/mapx/releases/tag/v0.1.4
