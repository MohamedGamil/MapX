# MapxGraph — Project Roadmap

> **Last updated:** 2026-05-22  
> **Scope:** 28 features across 15 iterations  
> **Based on:** specs/ directory (specs reviewed and sanitised 2026-05-22 — see [DECISIONS.md](specs/DECISIONS.md))

---

## Executive Summary

MapxGraph is a local code-graph memory tool that scans source files, extracts symbols and dependencies, builds a weighted graph with PageRank scoring, and exposes the result through a CLI and MCP server. The current codebase (`v2` schema) supports PHP, JavaScript, and TypeScript with basic scan/query/export commands.

This roadmap covers **28 planned features** grouped into **15 iterations** that transform mapx into a full-stack developer intelligence tool:

| Dimension | Baseline (now) | After all iterations |
|-----------|---------------|---------------------|
| Languages | 3 (PHP, JS, TS) | 22 (+ Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Scala, Dart, Svelte, Vue, Lua/Luau, Elixir, Zig, Bash, Pascal) |
| Frameworks | 0 | 21 (Laravel, Django, Flask, FastAPI, Express, NestJS, React Router, Tanstack Router, Next.js, SvelteKit, Rails, Spring Boot, Gin, chi, gorilla/mux, Axum, actix-web, Rocket, ASP.NET Core, Vapor, Symfony, Yii2/Yii3, Drupal, WordPress) |
| CLI commands | ~10 | ~37 (+27) |
| MCP tools | 5 | 20 (+15) |
| Schema version | v2 | v6 (+4 migrations) |
| Export formats | llm, json, dot, svg | + toon |
| UI | none | web dashboard (`mapx ui`) |

---

## Schema Version Timeline

Each database migration bumps the `CURRENT_SCHEMA_VERSION` constant in `src/core/store.ts`. Migrations are forward-only (no rollback scripts — use git to revert the feature).

```
v2 ── I01(F01) ──► v3 ── I08(F14) ──► v4 ── I10(F18) ──► v5 ── I13(F21) ──► v6
      verifiability        clusters            target_repo          edge metadata
      on edges             + namespace         on edges             on edges
```

| Version | Feature | Iteration | SQL |
|---------|---------|-----------|-----|
| v2 | baseline | — | existing schema |
| **v3** | F01 | I01 | `ALTER TABLE edges ADD COLUMN verifiability TEXT DEFAULT 'verified'` |
| **v4** | F14 | I08 | Add `clusters`, `cluster_membership` tables; `namespace TEXT` on `files` |
| **v5** | F18 | I10 | `ALTER TABLE edges ADD COLUMN target_repo TEXT` |
| **v6** | F21 | I13 | `ALTER TABLE edges ADD COLUMN metadata TEXT` |

> See [ADR-003](specs/DECISIONS.md#adr-003) for the canonical versioning strategy and rationale.

---

## Iteration Dependency Graph

```
I01 ──────────────────────────────── I03
(schema)                             (metrics+edges CLI)
  │
  └── required by I03 (metrics need verifiability)

I02 ─── independent (parallel with I01/I04)
(glob)

I04 ──── I05 ──── I06
(PHP)    (Laravel  (Laravel
          struct)   adv)

I07 ─── independent
(npm)

I08 ─── independent (enriched by I01 F01 verifiability)
(clusters)

I09 ─── independent (enriched by I18, I11)
(LLM files)

I10 ─── independent (enriched by I08)
(git/workspaces)

I11 ─── independent (enriched by I01, I08)
(smart context)

I12 ──── I13
(lang    (frameworks)
 exp)

I14 ─── independent
(TOON)

I15 ─── depends on I07 (bundled asset shipping)
(dashboard)
```

Critical paths:
- **Laravel track:** I04 → I05 → I06 (must be sequential)
- **Framework routing track:** I12 → I13 (F20 language parsers required before framework detection)
- **Dashboard track:** I07 → I15 (npm package required for bundled UI assets)
- **Schema track:** I01 → I08 → I10 → I13 (migrations must apply in order)

---

## Per-Iteration Detail

### I01 — Schema Migration + Parser Edge Labelling

| Field | Value |
|-------|-------|
| Features | F01 |
| Schema | v2 → **v3** |
| Depends on | — |
| Risk | Low |
| Complexity | Small |

Adds a `verifiability` column to the `edges` table (`verified` / `inferred`) and updates all parsers to label their edges appropriately. Provides the foundation for `mapx metrics --verified-only` and `mapx export --verified-only`.

**Key deliverables:** `ALTER TABLE edges ADD COLUMN verifiability TEXT DEFAULT 'verified'`; parser updates for PHP, JS, TS; `--verified-only` flag on `scan`, `export`, `metrics`.

---

### I02 — Glob Filter Pipeline

| Field | Value |
|-------|-------|
| Features | F03 |
| Schema | none |
| Depends on | — |
| Risk | Low |
| Complexity | Small |

Adds `--include` / `--exclude` glob patterns to `mapx scan`, `mapx update`, and `mapx export`. Patterns are applied at discovery time (zero I/O cost for excluded files). Supports both CLI flags and persistent config in `.mapx/config.json`.

**Key deliverables:** `includePatterns`/`excludePatterns` fields on `RepoConfig`; glob matcher injected into `Scanner.walkDirectory()`; config merge logic.

---

### I03 — CLI + MCP Surface (`metrics`, `edges`)

| Field | Value |
|-------|-------|
| Features | F02, F04 |
| Schema | none |
| Depends on | I01 (F02 metrics query uses verifiability) |
| Risk | Low |
| Complexity | Medium |

Adds `mapx metrics` (coupling, instability, afferent/efferent Ca/Ce) and `mapx edges` (granular edge filtering and querying). Exposes both as `mapx_metrics` and `mapx_edges` MCP tools.

**Key deliverables:** `mapx metrics [--lang=X] [--verified-only]`; `mapx edges [--type=X] [--from=X] [--to=X]`; `mapx_metrics` MCP tool; `mapx_edges` MCP tool.

---

### I04 — PHP Parser Fundamentals

| Field | Value |
|-------|-------|
| Features | F05, F06, F10 |
| Schema | none |
| Depends on | — |
| Risk | Medium |
| Complexity | Medium |

Three foundational PHP enhancements: FQN resolution (F05), type-hint dependency edges (F06), and Laravel-aware scan exclusions (F10). F06 depends on F05's use-import table. F10 is independent.

**Key deliverables:** `UsageImportTable` class (F05); 8+ new edge types from PHP type hints (F06); auto-exclude patterns for `vendor/`, `bootstrap/cache/`, compiled views, test helpers (F10).

> **Note:** F08 (route-controller) and F09 (service provider bindings) do NOT depend on F06. Route detection uses string literals; IoC binding uses `::class` constants. The dependency chain is: F05 → F06, and F05 → F07/F08/F09 (FQN resolution only).

---

### I05 — Laravel Structural Patterns

| Field | Value |
|-------|-------|
| Features | F07, F08, F09 |
| Schema | none |
| Depends on | I04 (F05 FQN resolution) |
| Risk | Medium |
| Complexity | Medium |

Adds Eloquent relationship edges (F07), route-to-controller binding edges (F08), and IoC service container binding edges (F09). All three depend only on F05's FQN resolution — not on F06 type hints.

**Key deliverables:** `has_one`, `has_many`, `belongs_to`, `belongs_to_many`, `morph_*` Eloquent edges; `route` + `middleware` edge types for Laravel routes; `binds`, `singleton`, `alias` IoC edges.

---

### I06 — Laravel Advanced Patterns

| Field | Value |
|-------|-------|
| Features | F11, F12 |
| Schema | none |
| Depends on | I04 (F05 FQN, F06 type hints); I05 (F09 IoC binding table) |
| Risk | Medium |
| Complexity | Medium |

Adds facade-to-concrete resolution (F11) and event/job/notification dispatch edges (F12). F11 uses a static facade map and FQN resolution (no binding table dependency). F12 adds `dispatches`, `fires`, `queues`, `listens_to`, `notifies` edge types.

**Key deliverables:** `FacadeResolver` static map (50+ built-in Laravel facades); `dispatches`/`fires`/`listens_to`/`notifies`/`queues` edge types.

---

### I07 — npm Distribution & Node.js DX

| Field | Value |
|-------|-------|
| Features | F13 |
| Schema | none |
| Depends on | — |
| Risk | Low |
| Complexity | Small |

Ships mapx as an npm package (`mapx` on the npm registry) with `npx mapx` support. Adds a one-liner installer script (`curl | sh`), an `AGENTS.md` stub injected at `mapx init`, and node-native SQLite fallback when Bun is not available.

**Key deliverables:** `package.json` with `bin: { mapx }`, `engines: { node: ">=20.0.0" }`; `store-node.ts` using `better-sqlite3`; installer script; `mapx init` AGENTS.md injection.

> **Node version:** Requires Node 20+ LTS (Node 18 reached EOL April 2025).

---

### I08 — Code Structure, Clusters & Data Flow

| Field | Value |
|-------|-------|
| Features | F14, F15, F16 |
| Schema | v3 → **v4** |
| Depends on | I01 (schema v3 must exist before v4 migration) |
| Risk | **HIGH** |
| Complexity | Large |

Three significant features in one iteration: cluster detection with Label Propagation (F14), cluster-aware DOT/SVG export (F15), and data-flow / source-sink tracing (F16). The schema migration adds `clusters` and `cluster_membership` tables plus a `namespace` column on `files`.

**Risks:**
- Label Propagation is non-deterministic; results vary across runs. Requires a seed or stabilisation strategy.
- Community detection quality depends heavily on the input graph density. Sparse graphs (few edges) produce poor clusters.
- F16 taint analysis performance can degrade super-linearly with graph size. Depth cap required.

**Key deliverables:** `ClusterDetector` class (Label Propagation + Louvain option); `mapx clusters` command; cluster-coloured DOT/SVG export; `mapx flow <symbol>` data-flow tracer; `mapx_clusters` and `mapx_flow` MCP tools.

---

### I09 — LLM Agent Integration Files

| Field | Value |
|-------|-------|
| Features | F17 |
| Schema | none |
| Depends on | — (enriched by I10, I11 data when available) |
| Risk | Low |
| Complexity | Medium |

Adds `mapx agents` to generate LLM agent integration files: `AGENTS.md`, `.cursorrules`, `copilot-instructions.md`, and `CLAUDE.md`. Each file is a codebase-aware document tailored to the agent's format, synthesised from the current graph.

**Key deliverables:** `mapx agents generate [--format=X] [--out=X]`; per-format templates; `mapx_agents_generate` MCP tool; 10 LLM provider configs.

---

### I10 — Git Workspace & Submodule Awareness

| Field | Value |
|-------|-------|
| Features | F18 |
| Schema | v4 → **v5** |
| Depends on | I08 (schema v4 must exist before v5 migration) |
| Risk | Medium |
| Complexity | Large |

Adds multi-repo support: auto-discovery of git submodules (`.gitmodules`), VS Code multi-root workspaces (`.code-workspace`), and sibling "peer" repos. Fixes incremental scan correctness for submodules. Adds cross-repo edge tracking.

**Key deliverables:** `WorkspaceManager` class; `mapx workspaces` command group (list/discover/add/remove); `--all` flag on `scan`, `update`, `status`, `export`; `mapx_workspaces` MCP tool; `ALTER TABLE edges ADD COLUMN target_repo TEXT`.

---

### I11 — Smart Context & Search Tools

| Field | Value |
|-------|-------|
| Features | F19 |
| Schema | none |
| Depends on | — (enriched by I01 verifiability, I08 clusters) |
| Risk | Medium |
| Complexity | Large |

Adds 7 new MCP tools and 6 CLI commands for precise, graph-driven LLM interactions. The flagship tool `mapx_context` builds a focused, token-efficient context block for a task by expanding outward from seed symbols.

**Tools added:** `mapx_search`, `mapx_context`, `mapx_callers`, `mapx_callees`, `mapx_impact`, `mapx_node`, `mapx_files` (new); `mapx_status` enhanced.

> **⚠ BREAKING CHANGE:** `mapx_status` text output format is restructured. Existing parsers reading only the first summary line are unaffected, but parsers that rely on line positions for the detailed fields will need updating.

**Key deliverables:** `ContextBuilder` class (`src/core/context-builder.ts`); 7 new Store query methods; 6 new CLI subcommands.

---

### I12 — Language Expansion (19 Languages)

| Field | Value |
|-------|-------|
| Features | F20 |
| Schema | none |
| Depends on | — |
| Risk | **HIGH** |
| Complexity | Very Large |

Adds tree-sitter parsers for 19 languages across 4 tiers:

| Tier | Languages | Strategy |
|------|-----------|----------|
| Bundled | Python, Go, TypeScript (already), JavaScript (already), PHP (already) | WASM parsers, shipped in npm package |
| Downloadable | Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Scala, Dart | On-demand WASM download |
| Community | Svelte, Vue, Lua/Luau, Elixir, Zig | Via user-defined language extension system |
| Experimental | Bash, Pascal | Regex fallback parsers |

**Risks:**
- WASM bundle size grows with each bundled language; must enforce budget per parser.
- `bundled` tier in the spec does not yet exist in `src/languages/registry.ts` — `LanguageTier` enum only has `builtin` and `downloadable`. Implementation must add this tier.
- Community parser quality is uncontrolled — user bears responsibility.
- 19 parsers to maintain and test; per-language test corpora needed.

**Key deliverables:** `LanguageTier.bundled` enum value; WASM fetch/cache infrastructure; `mapx lang list` output extended; per-language symbol/reference query files in `queries/`.

---

### I13 — Framework-Aware Parsing & Route Context (21 Frameworks)

| Field | Value |
|-------|-------|
| Features | F21, F22, F23, F24, F25, F26 |
| Schema | v5 → **v6** |
| Depends on | I12 (language parsers required for non-PHP/JS/TS frameworks) |
| Risk | **HIGH** |
| Complexity | Very Large |

The largest iteration in the roadmap. Adds a `FrameworkDetector` abstraction, a `RouteRegistry`, and 21 framework detectors across 5 feature specs. Every framework produces `route` + `middleware` edges stored with rich metadata in the new `edges.metadata` column.

**Framework coverage:**

| Spec | Frameworks |
|------|-----------|
| F21 | Infrastructure only (base classes, `mapx routes` CLI) |
| F22 | Django, Flask, FastAPI (Python) |
| F23 | Express, NestJS (Node.js/TS) |
| F24 | React Router, Tanstack Router, Next.js, SvelteKit (frontend) |
| F25 | Laravel extended, Drupal, Rails, Spring Boot, Gin, chi, gorilla/mux, Axum, actix-web, Rocket, ASP.NET Core, Vapor (backend) |
| F26 | Symfony, Yii2, Yii3, WordPress (PHP CMS/frameworks) |

**Risks:**
- Route detection relies on AST patterns that differ significantly across frameworks. Each detector needs its own test corpus.
- Frontend routes (F24) produce `route` edges with `metadata.routeType = "client"` — must be distinguished from server-side route edges (`routeType = "server"`) in all consumers (exports, dashboard, MCP tools).
- Framework detection can produce false positives on projects that partially match a framework's patterns. Detection confidence scoring is required.
- 21 frameworks × N route patterns = high ongoing maintenance surface.

**Key deliverables:** `FrameworkDetector` base class; `RouteRegistry`; `mapx routes` CLI command; `mapx_routes` MCP tool; `ALTER TABLE edges ADD COLUMN metadata TEXT`.

---

### I14 — TOON Export Format

| Field | Value |
|-------|-------|
| Features | F27 |
| Schema | none |
| Depends on | — (independent) |
| Risk | Low |
| Complexity | Small |

Adds `mapx export --format=toon` using the TOON v3.3 (Token-Oriented Object Notation) format. TOON uses tabular arrays, inline arrays, and key folding to produce exports that are more token-efficient than JSON or Markdown for LLM consumption.

**Key deliverables:** `ToonExporter` class; TOON quoting helpers; `--tokens=N` budget trimming.

---

### I15 — Bundled Web Dashboard

| Field | Value |
|-------|-------|
| Features | F28 |
| Schema | none |
| Depends on | I07 (npm package required for bundled UI assets) |
| Risk | Medium |
| Complexity | Large |

Adds `mapx ui` — a lightweight, self-contained web dashboard (zero runtime server dependencies; vanilla TypeScript client with Cytoscape.js for graph rendering). Includes a live MCP tool-call log via SSE.

**Risks:**
- Initial bundle target: < 200 KB gzipped (before lazy-loading fCoSE layout plugin). Total budget: < 350 KB gzipped. Cytoscape.js alone is ~150 KB — any additional dependencies require careful audit.
- The dashboard exposes graph data via HTTP; security defaults (127.0.0.1-only bind, optional bearer token, rate limiting, CORS) must be verified in code review.

**Key deliverables:** `src/ui-server.ts`; `src/ui-events.ts`; `src/ui/` client bundle; `build-ui.ts` esbuild script; REST API endpoints; SSE event stream.

---

## Risk Summary

| Iteration | Risk Level | Key Risk |
|-----------|-----------|---------|
| I01 | Low | Schema migration; parser labelling |
| I02 | Low | Glob edge cases |
| I03 | Low | CLI/MCP surface only |
| I04 | Medium | PHP AST parsing fidelity |
| I05 | Medium | Laravel pattern coverage |
| I06 | Medium | Facade static map completeness |
| I07 | Low | npm packaging and compatibility |
| **I08** | **HIGH** | Community detection non-determinism; taint analysis scalability |
| I09 | Low | Template quality |
| I10 | Medium | Multi-repo scan correctness; edge cases in .gitmodules parsing |
| **I11** | Medium | ContextBuilder keyword extraction quality; `mapx_status` breaking change |
| **I12** | **HIGH** | 19 parsers; WASM bundle budget; `bundled` tier not in registry yet |
| **I13** | **HIGH** | 21 frameworks; frontend vs server route disambiguation; false positives |
| I14 | Low | TOON v3.3 spec compliance; quoting edge cases |
| I15 | Medium | Bundle size; security defaults for HTTP server |

---

## CLI Command Catalog

### Existing commands (~10)
```
mapx init           mapx scan           mapx update
mapx status         mapx query          mapx deps
mapx export         mapx summary        mapx lang list
mapx serve
```

### New commands added across iterations

| Command | Iteration | Feature |
|---------|-----------|---------|
| `mapx metrics` | I03 | F02 |
| `mapx edges` | I03 | F04 |
| `mapx clusters` | I08 | F14 |
| `mapx flow <symbol>` | I08 | F16 |
| `mapx agents generate` | I09 | F17 |
| `mapx workspaces` | I10 | F18 |
| `mapx workspaces discover` | I10 | F18 |
| `mapx workspaces add <path>` | I10 | F18 |
| `mapx workspaces remove <name>` | I10 | F18 |
| `mapx scan --all` | I10 | F18 |
| `mapx update --all` | I10 | F18 |
| `mapx status --all` | I10 | F18 |
| `mapx export --all` | I10 | F18 |
| `mapx search <term>` | I11 | F19 |
| `mapx callers <symbol>` | I11 | F19 |
| `mapx callees <symbol>` | I11 | F19 |
| `mapx impact <symbol>` | I11 | F19 |
| `mapx node <symbol>` | I11 | F19 |
| `mapx files` | I11 | F19 |
| `mapx export --format=toon` | I14 | F27 |
| `mapx ui` | I15 | F28 |
| `mapx serve --ui` | I15 | F28 |
| `mapx routes` | I13 | F21 |
| `mapx routes --framework=X` | I13 | F21 |

**Total CLI commands (post-all-iterations): ~37**

---

## MCP Tool Catalog

### Existing tools (5)
| Tool | Description |
|------|-------------|
| `mapx_scan` | Full or incremental scan |
| `mapx_query` | Symbol name search (kept as alias) |
| `mapx_dependencies` | File-level dependency graph |
| `mapx_export` | Graph export (llm/json/dot/svg/toon) |
| `mapx_status` | Scan status (enhanced in I11) |

### New tools added across iterations (15)

| Tool | Iteration | Feature |
|------|-----------|---------|
| `mapx_metrics` | I03 | F02 |
| `mapx_edges` | I03 | F04 |
| `mapx_clusters` | I08 | F14 |
| `mapx_flow` | I08 | F16 |
| `mapx_agents_generate` | I09 | F17 |
| `mapx_workspaces` | I10 | F18 |
| `mapx_search` | I11 | F19 |
| `mapx_context` | I11 | F19 |
| `mapx_callers` | I11 | F19 |
| `mapx_callees` | I11 | F19 |
| `mapx_impact` | I11 | F19 |
| `mapx_node` | I11 | F19 |
| `mapx_files` | I11 | F19 |
| `mapx_routes` | I13 | F21 |
| `mapx_dashboard_status` | I15 | F28 |

**Total MCP tools (post-all-iterations): 20**

---

## Recommended Development Sequence

Respecting the dependency graph while maximising parallelism:

```
Phase 1 (foundation, can all run in parallel):
  I01 (schema v3)
  I02 (glob filters)
  I04 (PHP fundamentals)
  I07 (npm distribution)

Phase 2 (after Phase 1 completes relevant prerequisites):
  I03 (after I01)
  I05 (after I04)
  I08 (after I01 — schema v4)

Phase 3:
  I06 (after I05)
  I09 (after I08 — richer data)
  I10 (after I08 — schema v5)
  I11 (after I03, I08 — richer context)

Phase 4 (sequential by language/framework dependency):
  I12 (language expansion)
  I14 (TOON — independent, can run anytime)

Phase 5 (after I12):
  I13 (frameworks — requires language parsers from I12)

Phase 6:
  I15 (dashboard — after I07 npm package)
```

---

## Feature × Iteration Matrix

| | I01 | I02 | I03 | I04 | I05 | I06 | I07 | I08 | I09 | I10 | I11 | I12 | I13 | I14 | I15 |
|--|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| F01 edge verifiability | ✓ | | | | | | | | | | | | | | |
| F02 metrics engine | | | ✓ | | | | | | | | | | | | |
| F03 glob filters | | ✓ | | | | | | | | | | | | | |
| F04 edge querying | | | ✓ | | | | | | | | | | | | |
| F05 PHP FQN | | | | ✓ | | | | | | | | | | | |
| F06 PHP type hints | | | | ✓ | | | | | | | | | | | |
| F07 Eloquent rels | | | | | ✓ | | | | | | | | | | |
| F08 route bindings | | | | | ✓ | | | | | | | | | | |
| F09 IoC bindings | | | | | ✓ | | | | | | | | | | |
| F10 Laravel exclusions | | | | ✓ | | | | | | | | | | |
| F11 facade resolution | | | | | | ✓ | | | | | | | | | |
| F12 event/job dispatch | | | | | | ✓ | | | | | | | | | |
| F13 npm distribution | | | | | | | ✓ | | | | | | | | |
| F14 cluster detection | | | | | | | | ✓ | | | | | | | |
| F15 cluster viz | | | | | | | | ✓ | | | | | | | |
| F16 data flow | | | | | | | | ✓ | | | | | | | |
| F17 LLM agent files | | | | | | | | | ✓ | | | | | | |
| F18 git workspaces | | | | | | | | | | ✓ | | | | | |
| F19 smart context | | | | | | | | | | | ✓ | | | | |
| F20 lang expansion | | | | | | | | | | | | ✓ | | | |
| F21 framework infra | | | | | | | | | | | | | ✓ | | |
| F22 Python frameworks | | | | | | | | | | | | | ✓ | | |
| F23 Node.js frameworks | | | | | | | | | | | | | ✓ | | |
| F24 frontend routing | | | | | | | | | | | | | ✓ | | |
| F25 backend frameworks | | | | | | | | | | | | | ✓ | | |
| F26 PHP CMS frameworks | | | | | | | | | | | | | ✓ | | |
| F27 TOON export | | | | | | | | | | | | | | ✓ | |
| F28 web dashboard | | | | | | | | | | | | | | | ✓ |

---

## Known Issues / Spec Anomalies (Resolved)

The following issues were identified and fixed during the 2026-05-22 spec review:

| Issue | Severity | Resolution |
|-------|----------|-----------|
| F08, F09 falsely claimed F06 (type hints) as a dependency | Critical | Removed — route detection uses string literals, IoC uses `::class` constants |
| F11 falsely claimed F09 (binding table) as a dependency | Critical | Removed — facade resolution uses a static map, not the IoC binding table |
| Schema version conflict: F01, F14, F21 all claimed "v3" | Critical | Resolved via canonical sequence: v3(F01), v4(F14), v5(F18), v6(F21) — see ADR-003 |
| F21 misattributed `route`/`middleware` edge types as NEW | Critical | Fixed — `route`/`middleware` introduced in F08/I05; F21 extends them to all frameworks |
| F18 schema version was ambiguous ("v3 if not taken, else v4") | Critical | Fixed — definitively v5 |
| I14.md did not exist (F27 had no standalone iteration file) | High | Created `specs/iterations/I14.md` |
| F13 specified Node.js `>=18.0.0` (EOL April 2025) | High | Updated to `>=20.0.0` |
| F28 bundle size "< 200 KB gzipped" unrealistic (Cytoscape alone is ~150 KB) | High | Updated to initial < 200 KB (without lazy chunk) / total < 350 KB |
| F28 missing rate limiting and response size limits | High | Added to security section |
| F19 `mapx_status` enhancement undocumented as a breaking change | Medium | Added BREAKING note to F19 |
| F24 client vs server route semantics unclear | Medium | Added semantics note with `routeType` metadata disambiguation |
| F14 Label Propagation algorithm underspecified | Medium | Note added; implementer to select seed strategy for determinism |
| F20 `bundled` tier not present in registry.ts | Medium | Flagged in I12 risk section |

---

## Reference Links

- [Feature specs](specs/features/) — F01–F28
- [Iteration files](specs/iterations/) — I01–I15
- [Architecture decisions](specs/DECISIONS.md) — ADR-001, ADR-002, ADR-003
- [Specs README](specs/README.md) — master index and process guide
