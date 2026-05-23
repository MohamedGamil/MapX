# Changelog

All notable changes to MapX are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/).

Unreleased work is tracked under **[Unreleased]**. When a version is released, move its entries from Unreleased and add a release date.

---

## [Unreleased]

---

## [0.2.5] — 2026-05-24

### Changed

- **Version Sync Lock Automation** — Updated the `version-sync` target in the `Makefile` to automatically run `npm i --legacy-peer-deps`. This guarantees that `package-lock.json` is updated and synchronized instantly with new version bumps.
- **README Layout Refinements** — Re-ordered the Installation headers in `README.md` to feature global NPM installation and Zero-Installation (via `npx`) prominently at the top. Clarified the project description by noting MapXGraph is also referred to as MapX.

---

## [0.2.4] — 2026-05-24

### Added

- **Scoped Package Installation Instructions** — Updated global installation documentation to use the scoped package name `@mgamil/mapx`.
- **Zero-Installation via npx** — Documented instant usage and server configuration templates using `npx @mgamil/mapx` across `README.md`, `docs/getting-started.md`, and `docs/mcp-integration.md`.
- **Tracked `package-lock.json`** — Removed `package-lock.json` from `.gitignore` to ensure it is committed to the repository. This fixes missing lockfile failures in GitHub Actions setup caching and `npm ci`.

### Changed

- **Peer Dependency Compatibility** — Appended `--legacy-peer-deps` to installation commands in `Makefile` and `publish-npm.yml` workflow to automatically bypass upstream peer dependency conflicts.

---

## [0.2.3] — 2026-05-23

### Added

- **Vue parser delegation support** — Added a custom `VueParser` that extracts `<script>` and `<script setup>` blocks and delegates parsing to the `TypeScriptParser`, which allows fully extracting symbols and references inside Vue 2 and Vue 3 Single File Components (SFCs).
- **Import resolution for Vue** — Enhanced `resolveImportPath` to support `.vue` and `/index.vue` candidates, enabling correct resolution of implicit and explicit imports of Vue components.
- **Line number offsetting** — Remapped all symbol and reference line numbers within Vue files relative to their original SFC offsets.
- **`@/` alias resolution in Vue components** — Added support for `import "@/..."` target paths pointing to the `src/` directory within Vue Single File Components (SFCs).
- **Force scan option (`--force`)** — Added a `--force` option to the `scan` command to bypass the incremental parse caching and force re-parsing of all files (useful when parser or import resolver logic changes).
- **Web Dashboard UI integration** — Bundled and served compiled Web Dashboard UI assets directly from packaged native binaries. Updated local/system installation targets and the release packaging workflow to ensure the `ui` assets folder is correctly bundled and placed in share directories.
- **Programmatic ESM entry point** — Added `main`, `module`, `types`, and `exports` mapping in `package.json` to allow clean programmatic consumption of Mapx classes and helpers in external Node.js/TypeScript environments.
- **TypeScript Declarations Generation** — Configured `tsup` to generate `.d.ts` declaration files for all codebase modules, resolving import typing errors.

### Changed

- **Package Lifecycle Hook** — Moved build tasks from `prepublishOnly` to the standard `prepare` lifecycle hook to guarantee clean builds for Git installations, local packing (`npm pack`), and dry-runs.
- **NPM Publication Exclusions** — Updated `.npmignore` to ignore platform-specific local compiled binary builds (`dist/mapx-*`) to prevent accidental bulk bundling.
- **Excluded Web UI from tsup compiler** — Prevented tsup from processing browser-only Web UI client files (which contain DOM references), avoiding type-compilation errors during build.
- **CI/CD Workflow Enhancements** — Enabled dependency caching in `publish-npm.yml` to speed up builds and cleaned up scripting commands by using `npm run build:wasm`.

### Fixed

- **Type-safe Reference Resolution** — Added type-checking guards for target and symbol names inside reference resolution helpers (`resolveRequirePath`, `resolveImportPath`, `resolveSymbolToFile`) and language parser engines (PHP, generic WASM parser) to prevent crashes when encountering null, undefined, or non-string reference targets during database scans.
- **Workflow Release Security Guard** — Added strict git tag verification to the publish workflow to ensure the triggering release tag matches the declared version in `package.json`.

---

## [0.2.2] — 2026-05-23

### Added

- **Extended UI Metrics Dashboard** — The Web UI Metrics page is now fully aligned with the CLI `status` command, rendering detailed, harmonized cards.
  - `/api/metrics` JSON payload extended to return `totalEdges`, `verifiedEdges`, `inferredEdges`, `languages` breakdown, `symbolKinds` aggregation, `edgeTypes` aggregation, `avgEdgesPerFile`, `dbSize`, and a detailed `git` status object.
  - Metrics view updated with new dedicated cards for **Language Breakdown**, **Symbol Kinds Breakdown**, **Dependency & Edges**, and **Storage & Git Status** (complete with icons and status colors).
- **Expanded PageRank Lists** — Increased the number of returned items for Top Files (PageRank) and Top Symbols (PageRank) from 5 to 10 in both the API response and web dashboard.
- **Framework-aware ignored symbols** — Parsers now automatically skip noisy framework-specific symbols (e.g. Vue's `ref`, `computed`, `watch`, `defineComponent`, `useRouter`, `t`, etc.) when the project is detected as using that framework. This prevents low-value super-nodes from polluting the code graph, skewing PageRank, and creating noise in impact analysis
  - Centralized `IGNORED_SYMBOLS_BY_FRAMEWORK` registry in `src/parsers/ignored-symbols.ts` — keyed by `FrameworkDetector.name`, making it trivial to add ignored sets for React, Laravel, Angular, or any other framework
  - `buildIgnoredSymbols()` helper merges active framework sets into a single `Set<string>` passed once per scan pass via parser options
  - Integrates with existing `FrameworkRegistry.detectActiveFrameworks()` — no ad-hoc detection, frameworks are detected before the parsing loop using the same detector infrastructure used for routes/hooks
  - Both symbol extraction and reference/edge creation respect the ignored set, preventing orphaned inferred edges
  - Vue ecosystem coverage includes: Composition API, Vue Router, Pinia, Vue I18n (`t`, `te`, `tm`, etc.), and Nuxt/VueUse utilities
- **Makefile completeness** — Added missing targets to align with all CLI commands:
  - `sync` — Alias for `update` (incremental scan)
  - `metrics` — Show coupling/instability metrics (`make metrics [l=lang]`)
  - `edges` — Query dependency edges (`make edges [from=file] [to=file]`)
  - `lang-install` / `lang-uninstall` — Install/remove language support (`make lang-install l=ruby`)
  - `workspaces-add` / `workspaces-remove` — Register/remove repos (`make workspaces-add p=/path`)
  - `agents-update` — Update existing agent integration files
- **Cross-process Tool Call Logging in Web UI** — Persistent logging of MCP tool calls to `.mapx/tool-calls.jsonl` enables the Tool Call Log tab in the Web UI dashboard to correctly capture and display MCP tool calls even when the MCP server and Web UI are running in separate processes
  - UI server reads/serves historical logs via `/api/tool-calls` endpoint and tails new logs for real-time pushing via SSE
  - UI client renders status badges, execution durations, parameters, and error details with robust client-side deduplication
- **Dynamic Graph Node Sizing & Spacing** — Graph nodes in the Graph Explorer are now dynamically sized based on their degree (scaling from `32px` baseline up to `48px`). The layout was enhanced with dynamic `nodeRepulsion` and `idealEdgeLength` functions in `cose` layout, and scaled-up layout circles in cluster mode to give larger nodes more spacing and prevent overlap.
- **Top-Aligned Node Labels and Rendering Hierarchies** — Standard file node labels are now top-aligned with negative margins. Explicitly configured a z-index hierarchy (`z-index: 10` on nodes, `1` on edges) as a precaution so labels are always rendered on top of edges.
- **Verbose MCP Debug Mode** — Added `--debug` flag to `mapx serve` CLI command to log verbose MCP calls, including request names, arguments, duration, and completion success/error details to stderr.

### Changed

- `GenericWasmParser.parse()` now checks `options.ignoredSymbols` (a `Set<string>`) to filter symbols and references — fully data-driven, no per-parser subclass overrides needed
- Scanner's `parseFilesParallel` / `parseOnMainThread` now accept an optional `ignoredSymbols` set instead of framework-specific boolean flags
- Graph node selection in the Web UI preserves dynamic size instead of resetting to a hardcoded size.
- Improved graph interaction with optimized wheel sensitivity (`3.2`) and degree capping.
- Enhanced tool call log tailing in the UI server: added `fs.watch` for instant, near-real-time updates, and reduced fallback polling interval to 500ms for robust periodic checks.

### Fixed

- **SVG Exporter Type-Safety** — Resolved outstanding typecast compilation errors in `src/exporters/svg-exporter.ts` to make the workspace compile cleanly and remain 100% type-safe.

---

## [0.2.1] — 2026-05-23

### Added

- **`mapx uninit` command** — Fully reverse a `mapx init`: removes `.mapx/` directory, reverts LLM agent integration files (sentinel-block cleanup in AGENTS.md, .cursor/rules/mapx.mdc, etc.), removes `.mapx/` from `.gitignore`, and cleans up empty directories
  - `-f, --force` flag to skip confirmation prompt
  - Added `uninit` to package.json scripts and Makefile targets
- **Agentic MCP auto-configuration** — `mapx init` now auto-detects installed agent tools and generates MCP server config files so mapx is immediately discoverable as an MCP server with all 25 tools:
  - **opencode** → `opencode.json` (detected via `opencode.json` or `opencode.jsonc`)
  - **Gemini CLI** → `.gemini/settings.json` (detected via `.gemini/` directory)
  - **Cursor** → `.cursor/mcp.json` (detected via `.cursor/` directory)
  - **VS Code** → `.vscode/mcp.json` (detected via `.vscode/` directory)
  - **Antigravity** → `.agents/mcp.json` + `.agents/rules/mapx.md` (detected via `.agents/` directory)
- **`mapx agents mcp` subcommand** — Manual control over MCP config generation:
  - `--detect` — Show detected agent tools without writing files
  - `--all` — Generate configs for all supported tools
  - `--tools <list>` — Target specific tools (e.g. `--tools opencode,gemini-cli`)
  - `--dry-run` — Preview actions without writing
- **Smart JSON config merging** — When a config file already exists (e.g. `.vscode/mcp.json` with other settings), mapx merges its MCP entry without overwriting existing config. On `uninit`, only the mapx entry is removed; if the file becomes empty, it is deleted entirely
- **`--no-mcp-configs` flag on `mapx init`** — Skip MCP config auto-generation if not desired
- **Antigravity provider template** (`antigravity`) — Generates `.agents/rules/mapx.md` with pre-planning initialization rules following the Antigravity `.agents/rules/` pattern:
  - Forces `mapx_sync` + `mapx_export` before any planning or reasoning
  - Pre-modification impact analysis via `mapx_impact` and `mapx_callers`
  - Post-modification re-indexing via `mapx_sync`
  - Fail-safe halt on MCP initialization errors
- **`mapx uninit` MCP cleanup** — Removes mapx entries from all MCP config files during uninit, with smart handling: deletes files that only contained mapx, or surgically removes just the mapx entry from shared configs

### Changed

- Updated `mapx agents list` to show the new `antigravity` provider (`.agents/rules/mapx.md`)
- Updated `mapx init` interactive provider selection to include `antigravity` as an option
- Updated README "Agentic Integration" section with auto-detection table and usage examples
- Updated CLI reference docs with `--no-mcp-configs`, `agents mcp` command, and Antigravity target
- Updated MCP integration docs with Antigravity configuration example

---

## [0.2.0] — 2026-05-23

### Added
- Added built-in network density and transitivity metric calculations in Metrics tab and `/api/metrics` API endpoint.
- Redesigned Context Builder with task-relevance BFS shortest-path distance scoring, filename keyword boosts, symbol name keyword boosts, and a PageRank fallback mechanism.
- Added styled fallback placeholders for empty layouts across all UI pages (Graph, Symbols, Routes/Hooks, Metrics, and Tool Log).

### Changed
- Rebuilt Symbol Explorer with a sticky right panel layout (`position: sticky`) and confined pre-formatted code blocks with custom scrollbars.
- Updated Symbol Explorer search filter to match against both symbol name and partial file paths.
- Fixed a routes & hooks subtab toggle bug that caused panels to blank out during navigation.

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
[Unreleased]: https://github.com/MohamedGamil/mapx/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/MohamedGamil/mapx/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/MohamedGamil/mapx/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/MohamedGamil/mapx/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/MohamedGamil/mapx/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MohamedGamil/mapx/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MohamedGamil/mapx/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/MohamedGamil/mapx/compare/v0.1.6...v0.1.9
[0.1.6]: https://github.com/MohamedGamil/mapx/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/MohamedGamil/mapx/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/MohamedGamil/mapx/releases/tag/v0.1.4
