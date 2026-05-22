# MapxGraph — Implementation Checklist

> 28 features · 15 iterations · schema v2 → v6 · ~37 CLI commands · 20 MCP tools  
> Specs: [specs/README.md](specs/README.md) · Decisions: [specs/DECISIONS.md](specs/DECISIONS.md)

---

## Phase 1 — Foundation (all parallel)

### I01 · Schema Migration + Parser Edge Labelling · F01 · Risk: Low
- [ ] `ALTER TABLE edges ADD COLUMN verifiability TEXT DEFAULT 'verified'` (schema v2 → v3)
- [ ] Update PHP, JS, TS parsers to label edges as `verified` or `inferred`
- [ ] Implement common-method filter list (suppress noise from generic method names)
- [ ] Add `--verified-only` flag to `mapx metrics` and `mapx export`

### I02 · Glob Filter Pipeline · F03 · Risk: Low
- [ ] Add `--include` / `--exclude` glob patterns to `mapx scan`, `mapx update`, `mapx export`
- [ ] Apply filtering at discovery time (zero I/O cost for excluded files)
- [ ] Persist patterns in `.mapx/config.json` under `includePatterns` / `excludePatterns`

### I04 · PHP Parser Fundamentals · F05, F06, F10 · Risk: Medium
- [ ] Implement `UsageImportTable` class for FQN resolution from `use` imports (F05)
- [ ] Add type-hint dependency edges: `param_type`, `return_type`, `property_type` (F06)
- [ ] Auto-exclude `vendor/`, `bootstrap/cache/`, compiled views, test helpers (F10)
- [ ] Validate: F05 is the only shared dependency of F06, F07, F08, F09

### I07 · npm Distribution & Node.js DX · F13 · Risk: Low
- [ ] Publish `mapx` npm package with `bin: { mapx }`, `engines: { node: ">=20.0.0" }`
- [ ] Implement `store-node.ts` using `better-sqlite3` (fallback when Bun unavailable)
- [ ] Add `curl | sh` installer script and `mapx init` AGENTS.md injection
- [ ] Add `MAPX_NO_UI=1` env flag to skip client bundle build in CI

---

## Phase 2 — Core Features (after relevant Phase 1 items)

### I03 · CLI + MCP Surface · F02, F04 · Risk: Low · Requires: I01
- [ ] Implement `mapx metrics [--lang=X] [--verified-only]` with Ca/Ce/instability reports (F02)
- [ ] Implement `mapx edges [--type=X] [--from=X] [--to=X]` for granular edge querying (F04)
- [ ] Add MCP tools: `mapx_metrics`, `mapx_edges`

### I05 · Laravel Structural Patterns · F07, F08, F09 · Risk: Medium · Requires: I04
- [ ] Add Eloquent relationship edges: `has_one`, `has_many`, `belongs_to`, `belongs_to_many`, `morph_*` (F07)
- [ ] Detect route-to-controller bindings; emit `route` + `middleware` edge types (F08)
- [ ] Detect IoC container bindings; emit `binds`, `singleton`, `alias` edge types (F09)
- [ ] Confirm: F08 and F09 depend only on F05 FQN resolution, not F06 type hints

### I08 · Code Structure, Clusters & Data Flow · F14, F15, F16 · Risk: HIGH · Requires: I01
- [ ] Implement `ClusterDetector` with namespace, directory, and Label Propagation strategies (F14)
- [ ] Schema migration: add `clusters`, `cluster_membership` tables; `namespace TEXT` on `files` (v3 → v4)
- [ ] Add `mapx clusters` CLI command and `mapx_clusters` MCP tool
- [ ] Implement cluster-aware DOT/SVG export with subgraph outlines (F15)
- [ ] Add data-flow tracer `mapx flow <symbol>` with source/sink detection; depth cap required (F16)
- [ ] Add `mapx_flow` MCP tool
- [ ] **Risk**: Label Propagation is non-deterministic — implement deterministic seeding strategy
- [ ] **Risk**: Data-flow traversal can degrade super-linearly — enforce configurable depth limit

---

## Phase 3 — Laravel Completion & Context (sequential within phase)

### I06 · Laravel Advanced Patterns · F11, F12 · Risk: Medium · Requires: I04, I05
- [ ] Implement `FacadeResolver` static map (50+ built-in Laravel facades → concrete classes) (F11)
- [ ] Add event dispatch edges: `dispatches`, `fires`, `listens_to`, `notifies`, `queues` (F12)
- [ ] Confirm: F11 uses static facade map only — no dependency on F09 IoC binding table

### I09 · LLM Agent Integration Files · F17 · Risk: Low · Requires: none (enriched by I08, I10)
- [ ] Implement `mapx agents generate [--format=X]` command
- [ ] Build per-format templates: `AGENTS.md`, `.cursorrules`, `copilot-instructions.md`, `CLAUDE.md`
- [ ] Add version sentinel comments for stale-detection / update flow
- [ ] Add `mapx_agents_generate` MCP tool

### I10 · Git Workspace & Submodule Awareness · F18 · Risk: Medium · Requires: I08 (schema v4 → v5)
- [ ] Implement `WorkspaceManager`: parse `.gitmodules`, detect VS Code `.code-workspace`, peer repos
- [ ] Fix incremental scan correctness: call `getGitBlobHashes()` per-repo with its own git root
- [ ] Track cross-repo edges: `ALTER TABLE edges ADD COLUMN target_repo TEXT` (v4 → v5)
- [ ] Add `mapx workspaces` / `mapx workspaces discover` / `mapx workspaces add` / `mapx workspaces remove`
- [ ] Add `--all` flag to `mapx scan`, `mapx update`, `mapx status`, `mapx export`
- [ ] Add `mapx_workspaces` MCP tool
- [ ] Warn on unregistered nested `.git` directories found during scan

### I11 · Smart Context & Search Tools · F19 · Risk: Medium · Requires: none (enriched by I01, I08)
- [ ] Implement `ContextBuilder` class: seed extraction → BFS graph expansion → token-budget trimming
- [ ] Add 7 new MCP tools: `mapx_search`, `mapx_context`, `mapx_callers`, `mapx_callees`, `mapx_impact`, `mapx_node`, `mapx_files`
- [ ] Add 6 new CLI commands: `mapx search`, `mapx callers`, `mapx callees`, `mapx impact`, `mapx node`, `mapx files`
- [ ] Enhance `mapx_status`: language breakdown, top-5 files/symbols by PageRank, stale detection
- [ ] **⚠ BREAKING**: `mapx_status` text output format restructured — document migration notes; first summary line preserved

---

## Phase 4 — Language Expansion (sub-phases)

### I12 · Language Expansion · F20 · Risk: HIGH · Requires: none
- [ ] Add `LanguageTier.bundled` enum value to `src/languages/registry.ts` (currently missing)
- [ ] Create `GenericWasmParser` base class with WASM fetch/cache in `~/.mapx/grammars/`
- [ ] Add `mapx lang list` / `mapx lang install` / `mapx lang uninstall` commands
- [ ] **Sub-phase 1**: Python, Go, Rust, Java, C# — built-in tier, WASM bundled in npm package
- [ ] **Sub-phase 2**: Ruby, C, C++, Swift, Kotlin — bundled tier, enforce per-parser WASM size budget
- [ ] **Sub-phase 3**: Svelte, Vue, Lua/Luau, Elixir, Zig, Bash, Pascal, Dart, Scala, Kotlin (via `mapx lang install`)
- [ ] Create per-language test corpora; per-parser `queries/<lang>/symbols.scm` + `references.scm`
- [ ] **Risk**: 19 parsers to maintain — prioritise languages with mature tree-sitter grammars

---

## Phase 5 — Framework Support (after I12)

### I13 · Framework-Aware Parsing & Route Context · F21–F26 · Risk: HIGH · Requires: I12 (v5 → v6)
- [ ] **Concrete first**: implement Django, Express, and Laravel extended detectors before abstracting
- [ ] Extract `FrameworkDetector` interface and `RouteRegistry` class from concrete implementations (F21)
- [ ] Add `mapx routes [--framework=X]` CLI and `mapx_routes` MCP tool
- [ ] Schema migration: `ALTER TABLE edges ADD COLUMN metadata TEXT` (v5 → v6)
- [ ] Add framework detection confidence scoring to suppress false positives
- [ ] Implement Python detectors: Django, Flask, FastAPI (F22)
- [ ] Implement Node.js detectors: Express, NestJS (F23)
- [ ] Implement frontend detectors: React Router, Tanstack Router, Next.js, SvelteKit (F24)
  - [ ] Mark all frontend route edges with `metadata.routeType = "client"` (distinct from server routes)
- [ ] Implement backend detectors: Rails, Spring Boot, Gin, chi, gorilla/mux, Axum, actix-web, Rocket, ASP.NET Core, Vapor; Laravel extended, Drupal (F25)
- [ ] Implement PHP CMS detectors: Symfony, Yii2, Yii3, WordPress (F26)
- [ ] **Risk**: frontend `route` edges must carry `routeType: "client"` to distinguish from server-side route edges
- [ ] **Risk**: 21 frameworks = high ongoing maintenance surface — confidence scoring is mandatory

---

## Phase 6 — Polish & UX

### I14 · TOON Export Format · F27 · Risk: Low · Requires: none (independent)
- [ ] Implement `ToonExporter` class conforming to TOON v3.3 spec (tabular arrays, inline arrays, key folding)
- [ ] Add `--format=toon` to `mapx export`; register in `src/exporters/index.ts`
- [ ] Implement `toonQuote()`: handle lone `-` null marker, leading `-\S` values, control chars `\u0000-\u001F\u007F-\u009F`
- [ ] Support `--tokens=N` budget trimming with trailing `# N nodes omitted` comment
- [ ] Note spec version in TOON output header: `# toon v3.3`

### I15 · Bundled Web Dashboard · F28 · Risk: Medium · Requires: I07
- [ ] Create `src/ui-server.ts` (HTTP server, Node.js built-ins only — no Express)
- [ ] Create `src/ui-events.ts` (shared EventEmitter for MCP tool-call interception)
- [ ] Build `src/ui/` client bundle with esbuild: Cytoscape.js graph, symbol table, tool log, metrics, context viewer
- [ ] Add `mapx ui [--port=N] [--host=X] [--token=X] [--no-open]` and `mapx serve --ui`
- [ ] Implement REST API: `/api/status`, `/api/graph`, `/api/symbols`, `/api/symbol/:name`, `/api/metrics`, `/api/context`, `/api/routes`
- [ ] Implement SSE stream at `/events`: `tool-call`, `scan-progress`, `scan-complete` events
- [ ] **Bundle target**: initial load < 200 KB gzipped (lazy-load fCoSE layout plugin); total < 350 KB gzipped
- [ ] **Security**: bind `127.0.0.1` by default; optional `Authorization: Bearer` token; rate-limit `/api/context` + `/api/graph` to 10 req/min; cap responses at 10 MB; reject path traversal; CORS localhost only

---

## Risk Mitigation

- [ ] **I08** — Label Propagation: add deterministic seed; test cluster stability across runs
- [ ] **I08** — Data-flow depth: add configurable `--max-depth` (default 3); benchmark on 10k-node graphs
- [ ] **I12** — Language sub-phases: ship SP1 before starting SP2; gate each on CI green
- [ ] **I13** — Framework scope: implement 3 concrete detectors before building `FrameworkDetector` interface
- [ ] **I13** — False positives: confidence score < 0.5 suppresses edge emission; log warnings
- [ ] **I11** — Breaking change: add `CHANGELOG` entry; deprecation warning in old `mapx_status` text until next major version
- [ ] **I15** — Bundle size: CI check that `dist/ui/main.js` gzipped size ≤ 200 KB; audit Cytoscape plugin additions

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

- [ ] TypeScript type-check (`npx tsc --noEmit`) passes with 0 errors after every iteration
- [ ] All acceptance criteria in each feature spec pass
- [ ] No regression on existing `mapx scan/export/query` behaviour
- [ ] WASM parser bundle per language ≤ budget defined in F20 spec
- [ ] Dashboard initial bundle ≤ 200 KB gzipped
- [ ] `mapx_context` p95 response time ≤ 200 ms on a 1000-file project
- [ ] All schema migrations are additive (no column drops, no table renames)