# MapxGraph — Implementation Checklist

> 38 features · 22 iterations · schema v2 → v6 · ~37 CLI commands · 25 MCP tools  
> Specs: [specs/README.md](specs/README.md) · Decisions: [specs/DECISIONS.md](specs/DECISIONS.md)

---

## Phase 1 — Foundation (all parallel)

### I01 · Schema Migration + Parser Edge Labelling · F01 · Risk: Low
- [x] `ALTER TABLE edges ADD COLUMN verifiability TEXT DEFAULT 'verified'` (schema v2 → v3)
- [x] Update PHP, JS, TS parsers to label edges as `verified` or `inferred`
- [x] Implement common-method filter list (suppress noise from generic method names)
- [x] Add `--verified-only` flag to `mapx metrics` and `mapx export`

### I02 · Glob Filter Pipeline · F03 · Risk: Low
- [x] Add `--include` / `--exclude` glob patterns to `mapx scan`, `mapx update`, `mapx export`
- [x] Apply filtering at discovery time (zero I/O cost for excluded files)
- [x] Persist patterns in `.mapx/config.json` under `includePatterns` / `excludePatterns`

### I04 · PHP Parser Fundamentals · F05, F06, F10 · Risk: Medium
- [x] Implement `UsageImportTable` class for FQN resolution from `use` imports (F05)
- [x] Add type-hint dependency edges: `param_type`, `return_type`, `property_type` (F06)
- [x] Auto-exclude `vendor/`, `bootstrap/cache/`, compiled views, test helpers (F10)
- [x] Validate: F05 is the only shared dependency of F06, F07, F08, F09

### I07 · npm Distribution & Node.js DX · F13 · Risk: Low
- [x] Publish `mapx` npm package with `bin: { mapx }`, `engines: { node: ">=20.0.0" }`
- [x] Implement `store-node.ts` using `better-sqlite3` (fallback when Bun unavailable)
- [x] Add `curl | sh` installer script and `mapx init` AGENTS.md injection
- [x] Add `MAPX_NO_UI=1` env flag to skip client bundle build in CI

---

## Phase 2 — Core Features (after relevant Phase 1 items)

### I03 · CLI + MCP Surface · F02, F04 · Risk: Low · Requires: I01
- [x] Implement `mapx metrics [--lang=X] [--verified-only]` with Ca/Ce/instability reports (F02)
- [x] Implement `mapx edges [--type=X] [--from=X] [--to=X]` for granular edge querying (F04)
- [x] Add MCP tools: `mapx_metrics`, `mapx_edges`

### I05 · Laravel Structural Patterns · F07, F08, F09 · Risk: Medium · Requires: I04
- [x] Add Eloquent relationship edges: `has_one`, `has_many`, `belongs_to`, `belongs_to_many`, `morph_*` (F07)
- [x] Detect route-to-controller bindings; emit `route` + `middleware` edge types (F08)
- [x] Detect IoC container bindings; emit `binds`, `singleton`, `alias` edge types (F09)
- [x] Confirm: F08 and F09 depend only on F05 FQN resolution, not F06 type hints

### I08 · Code Structure, Clusters & Data Flow · F14, F15, F16 · Risk: HIGH · Requires: I01
- [x] Implement `ClusterDetector` with namespace, directory, and Label Propagation strategies (F14)
- [x] Schema migration: add `clusters`, `cluster_membership` tables; `namespace TEXT` on `files` (v3 → v4)
- [x] Add `mapx clusters` CLI command and `mapx_clusters` MCP tool
- [x] Implement cluster-aware DOT/SVG export with subgraph outlines (F15)
- [x] Add data-flow tracer `mapx trace <symbol>` with source/sink detection; depth cap required (F16)
- [x] Add `mapx_trace` MCP tool
- [x] **Risk**: Label Propagation is non-deterministic — implement deterministic seeding strategy
- [x] **Risk**: Data-flow traversal can degrade super-linearly — enforce configurable depth limit

---

## Phase 3 — Laravel Completion & Context (sequential within phase)

### I06 · Laravel Advanced Patterns · F11, F12 · Risk: Medium · Requires: I04, I05
- [x] Implement `FacadeResolver` static map (50+ built-in Laravel facades → concrete classes) (F11)
- [x] Add event dispatch edges: `dispatches`, `fires`, `listens_to`, `notifies`, `queues` (F12)
- [x] Confirm: F11 uses static facade map only — no dependency on F09 IoC binding table

### I09 · LLM Agent Integration Files · F17 · Risk: Low · Requires: none (enriched by I08, I10)
- [x] Implement `mapx agents generate` command
- [x] Build templates: `AGENTS.md`, `.cursor/rules/mapx.mdc`, `.github/copilot-instructions.md`, `CLAUDE.md`, `.windsurf/rules/mapx.md`, `.clinerules`, `AIDER.md`, `GEMINI.md`, `.continue/mapx.yaml`, `.zed/mapx-instructions.md`
- [x] Add version sentinel comments for stale-detection / update flow
- [x] Add `mapx_agents_generate` MCP tool

### I10 · Git Workspace & Submodule Awareness · F18 · Risk: Medium · Requires: I08 (schema v4 → v5)
- [x] Implement `WorkspaceManager`: parse `.gitmodules`, detect VS Code `.code-workspace`, peer repos
- [x] Fix incremental scan correctness: call `getGitBlobHashes()` per-repo with its own git root
- [x] Track cross-repo edges: `ALTER TABLE edges ADD COLUMN target_repo TEXT` (v4 → v5)
- [x] Add `mapx workspaces` / `mapx workspaces discover` / `mapx workspaces add` / `mapx workspaces remove`
- [x] Add `--all` flag to `mapx scan`, `mapx update`, `mapx status`, `mapx export`
- [x] Add `mapx_workspaces` MCP tool
- [x] Warn on unregistered nested `.git` directories found during scan

### I11 · Smart Context & Search Tools · F19 · Risk: Medium · Requires: none (enriched by I01, I08)
- [x] Implement `ContextBuilder` class: seed extraction → BFS graph expansion → token-budget trimming
- [x] Add 7 new MCP tools: `mapx_search`, `mapx_context`, `mapx_callers`, `mapx_callees`, `mapx_impact`, `mapx_node`, `mapx_files`
- [x] Add 6 new CLI commands: `mapx search`, `mapx callers`, `mapx callees`, `mapx impact`, `mapx node`, `mapx files`
- [x] Enhance `mapx_status`: language breakdown, top-5 files/symbols by PageRank, stale detection
- [x] **⚠ BREAKING**: `mapx_status` text output format restructured — document migration notes; first summary line preserved

---

## Phase 4 — Language Expansion (sub-phases)

### I12 · Language Expansion · F20 · Risk: HIGH · Requires: none
- [x] Add `LanguageTier` / registry tier mappings to `src/languages/registry.ts`
- [x] Create `GenericWasmParser` base class with WASM fetch/cache in `~/.mapx/grammars/`
- [x] Add `mapx lang list` / `mapx lang install` / `mapx lang uninstall` commands
- [x] **Sub-phase 1**: Python, Go, Rust, Java, C# — built-in tier, WASM bundled in npm package
- [x] **Sub-phase 2**: Ruby, C, C++, Swift, Kotlin — bundled tier, enforce per-parser WASM size budget
- [x] **Sub-phase 3**: Svelte, Vue, Lua/Luau, Elixir, Zig, Bash, Pascal, Dart, Scala, Kotlin (via `mapx lang install`)
- [x] Create per-language test corpora; per-parser `queries/<lang>/symbols.scm` + `references.scm`
- [x] **Risk**: 19 parsers to maintain — prioritise languages with mature tree-sitter grammars

---

## Phase 5 — Framework Support (after I12)

### I13 · Framework-Aware Parsing & Route Context · F21–F26 · Risk: HIGH · Requires: I10, I12 (v5 → v6)
- [x] Extract `FrameworkDetector` interface and `RouteRegistry` class from concrete implementations (F21)
- [x] Add `mapx routes [--framework=X]` CLI and `mapx_routes` MCP tool
- [x] Schema migration: `ALTER TABLE edges ADD COLUMN metadata TEXT` (v5 → v6)
- [x] **Concrete first**: implement Django, Express, and Laravel extended detectors before abstracting
- [x] Add framework detection confidence scoring to suppress false positives
- [x] Implement Python detectors: Django, Flask, FastAPI (F22)
- [x] Implement Node.js detectors: Express, NestJS (F23)
- [x] Implement frontend detectors: React Router, Tanstack Router, Next.js, SvelteKit, Vue Router (F24)
  - [x] Mark all frontend route edges with `metadata.routeType = "client"` (distinct from server routes)
- [x] Implement backend detectors: Rails, Spring Boot, Gin, chi, gorilla/mux, Axum, actix-web, Rocket, ASP.NET Core, Vapor; Laravel extended, Drupal (F25)
- [x] Implement PHP CMS detectors: Symfony, Yii2, Yii3, WordPress (F26)
- [x] **Risk**: frontend `route` edges must carry `routeType: "client"` to distinguish from server-side route edges
- [x] **Risk**: 21 frameworks = high ongoing maintenance surface — confidence scoring is mandatory

---

## Phase 6 — Polish & UX

### I14 · TOON Export Format · F27 · Risk: Low · Requires: none (independent)
- [x] Implement `ToonExporter` class conforming to TOON v3.3 spec (tabular arrays, inline arrays, key folding)
- [x] Add `--format=toon` to `mapx export`; register in `src/exporters/index.ts`
- [x] Implement `toonQuote()`: handle lone `-` null marker, leading `-\S` values, control chars `\u0000-\u001F\u007F-\u009F`
- [x] Support `--tokens=N` budget trimming with trailing `# N nodes omitted` comment
- [x] Note spec version in TOON output header: `# toon v3.3`

### I15 · Bundled Web Dashboard · F28 · Risk: Medium · Requires: I07
- [x] Create `src/ui-server.ts` (HTTP server, Node.js built-ins only — no Express)
- [x] Create `src/ui-events.ts` (shared EventEmitter for MCP tool-call interception)
- [x] Build `src/ui/` client bundle with esbuild: Cytoscape.js graph, symbol table, tool log, metrics, context viewer
- [x] Add `mapx ui [--port=N] [--host=X] [--token=X] [--no-open]` and `mapx serve --ui`
- [x] Implement REST API: `/api/status`, `/api/graph`, `/api/symbols`, `/api/symbol/:name`, `/api/metrics`, `/api/context`, `/api/routes`
- [x] Implement SSE stream at `/events`: `tool-call`, `scan-progress`, `scan-complete` events
- [x] **Bundle target**: initial load < 200 KB gzipped (lazy-load fCoSE layout plugin); total < 350 KB gzipped
- [x] **Security**: bind `127.0.0.1` by default; optional `Authorization: Bearer` token; rate-limit `/api/context` + `/api/graph` to 10 req/min; cap responses at 10 MB; reject path traversal; CORS localhost only

---

## Phase 7 — Audit Compliance (I16)

### I16 · Audit Compliance Fixes · F29–F32 · Risk: Low · Requires: none
- [x] Implement `mapx_workspaces` MCP tool: register in tools list, add handler with list/discover actions (F29)
- [x] Fix language tier alignment: Python/Go/Rust/Java/C# → `built-in`; Ruby/C/C++/Swift/Kotlin/Scala/Dart → `bundled` (F30)
- [x] Add `--cluster` (`none`|`auto`) and `--depth` flags to `mapx export`; wire into DOT/SVG exporters (F31)
- [x] Add `mapx workspaces discover` standalone CLI subcommand (read-only discovery) (F32)
- [x] Add `toon` to `mapx_export` MCP format enum
- [x] Update `generateConfigs()` available tools list in `mcp.ts`

---

## Phase 8 — Language Depth (I17)

### I17 · Comprehensive Language Syntax Coverage · F33 · Risk: Medium · Requires: I12
- [x] **Python**: Add method, decorator, constant, property symbols; add instantiation, decorator refs
- [x] **Go**: Add constant, type alias, package, var symbols; add interface embedding refs
- [x] **Rust**: Add impl, const, static, type, module, macro, enum variant symbols; add trait impl, macro, path refs
- [x] **Java**: Add field, constant, annotation, namespace, enum constant symbols; add extends, implements, annotation refs
- [x] **C#**: Add property, constant, namespace, record, delegate, event symbols; add extends, attribute refs
- [x] **Ruby**: Add module, constant, property (attr_*) symbols; add require, include, extends, instantiation refs
- [x] **C**: Add enum, typedef, macro, union symbols; add #include refs
- [x] **C++**: Add namespace, enum, template, alias symbols; add #include, extends, instantiation refs
- [x] **Swift**: Add protocol, enum, extension, property, typealias symbols; add import, conformance, instantiation refs
- [x] **Kotlin**: Add interface, object, enum, property symbols; add import, extends, implements, instantiation refs
- [x] **Dart**: Add enum, mixin, extension, constant symbols; add extends, implements, with, instantiation refs
- [x] **Scala**: Add trait, val, var, type alias, package symbols; add extends, instantiation refs
- [x] **Vue**: Add class, method, property, arrow function symbols; add import, method call refs
- [x] **Svelte**: Add class, method, property, constant, arrow function symbols; add import, method call, lifecycle refs
- [x] **Lua**: Add method, local function, variable symbols; add require, method calls refs
- [x] **Elixir**: Add defp, defmacro, defstruct, defprotocol, module attr symbols; add alias, import, use, pipe, defimpl refs
- [x] **Zig**: Add struct, const, test, error set symbols; add @import, method call refs
- [x] **Bash**: Add variable assignment, alias symbols; add source/. includes, command substitution refs
- [x] **Pascal**: Add class, record, interface, method, constant, unit, variable, enum symbols; add uses, extends, instantiation refs
- [x] Update `nodeMappings` in `registry.ts` for all 20 languages

---

## Phase 9 — React & NestJS Deep Integration (I18–I20)

### I18 · React & TSX Parser Fixes · F34 · Risk: Medium
- [x] Fix TSX/TS parser to index default class/function exports and anonymous arrow exports (naming them based on filename)
- [x] Fix file discovery/sync issue where `.tsx` files are silently omitted or missing from scans

### I19 · JSX Component rendering edges · F35 · Risk: Medium · Requires: I18
- [x] Extract JSX/TSX elements (e.g. `<LinksPage />`) to create `render` / `call` type edges from the rendering component/file to the target symbol

### I20 · NestJS Routes, Hooks, & DI Parsing · F36 · Risk: Medium
- [x] Extract NestJS route decorators (`@Controller`, `@Get`, `@Post`, `@Patch`, `@Delete`)
- [x] Extract NestJS GraphQL resolvers (`@Resolver`, `@Query`, `@Mutation`)
- [x] Parse implemented lifecycle hooks (`OnModuleInit`, `OnApplicationBootstrap`, etc.) and decorators (`@Injectable`, `@Inject`, `@UseGuards`, `@UseInterceptors`)
- [x] Detect constructor parameter dependency injection to generate `param_type` / DI edges

---

## Phase 10 — Graph Accuracy & MCP Usability (I21–I22)

### I21 · Graph Resolution & Noise Reduction · F37 · Risk: Medium
- [x] Exclude built-in JS/TS globals (`Date`, `Error`, `Map`, `Set`, `Promise`, `Object`, etc.) from resolving to user-defined symbols during edge resolution
- [x] Filter out or distinctively flag import-level `<top-level>` references to suppress caller noise in `mapx_callers`
- [x] Enhance `mapx_impact` risk analysis with calling depth-based risk levels (HIGH/MEDIUM/LOW), test file flags, and try/catch checks
- [x] Introduce a filesystem staleness warning when queries are run after modifications without syncing

### I22 · CLI/MCP Search & Context Usability · F38 · Risk: Low
- [x] Support wildcard `*` or empty string in `mapx_search` to list all symbols when a file filter is provided
- [x] Case-insensitively map kinds (e.g. `interface`, `class`) in symbol queries and searches
- [x] Fix required parameter `task` in `mapx_context` schema/docs and optimize token-budget relevance scoring
- [x] Write detailed `instructions.md` with parameter and type documentation for the MCP server
- [x] Add file-level summaries to `llm` export

---

## Risk Mitigation

- [x] **I08** — Label Propagation: add deterministic seed; test cluster stability across runs
- [x] **I08** — Data-flow depth: add configurable `--max-depth` (default 3); benchmark on 10k-node graphs
- [x] **I12** — Language sub-phases: ship SP1 before starting SP2; gate each on CI green
- [x] **I13** — Framework scope: implement 3 concrete detectors before building `FrameworkDetector` interface
- [x] **I13** — False positives: confidence score < 0.5 suppresses edge emission; log warnings
- [x] **I11** — Breaking change: add `CHANGELOG` entry; deprecation warning in old `mapx_status` text until next major version
- [x] **I15** — Bundle size: CI check that `dist/ui/main.js` gzipped size ≤ 200 KB; audit Cytoscape plugin additions

---

## Dependency Reference

| Dependency | Direction | Reason |
|-----------|-----------|--------|
| F01 → F02 | required | `--verified-only` flag needs verifiability column |
| F05 → F06 | required | type-hint edges need use-import table for FQN resolution |
| F05 → F07, F08, F09 | required | Eloquent/route/IoC detection needs FQN resolution |
| F08 ↛ F06 | **not required** | route detection uses string literals, not type hints |
| F09 ↛ F06 | **not required** | IoC bindings use `::class` constants, not type hints |
| F11 ↛ F09 | **not required** | facade resolution uses static map, not IoC binding table |
| I01 → I08 | schema order | v3 must exist before v4 migration |
| I08 → I10 | schema order | v4 must exist before v5 migration |
| I10 → I13 | schema order | v5 must exist before v6 migration |
| I12 → I13 | parser coverage | non-PHP/JS/TS frameworks need their language parsers first |
| I07 → I15 | bundled assets | npm package infrastructure needed before shipping UI assets |
| F21 → F22–F26 | infrastructure | `FrameworkDetector` base class required before concrete detectors |

**Schema sequence**: v2 (baseline) → **v3** (F01 verifiability) → **v4** (F14 clusters) → **v5** (F18 target_repo) → **v6** (F21 edge metadata)

---

## Success Metrics

- [x] TypeScript type-check (`npx tsc --noEmit`) passes with 0 errors after every iteration
- [x] All acceptance criteria in each feature spec pass
- [x] No regression on existing `mapx scan/export/query` behaviour
- [x] WASM parser bundle per language ≤ budget defined in F20 spec
- [x] Dashboard initial bundle ≤ 200 KB gzipped
- [x] `mapx_context` p95 response time ≤ 200 ms on a 1000-file project
- [x] All schema migrations are additive (no column drops, no table renames)