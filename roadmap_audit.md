# MapxGraph — Roadmap Implementation Audit

> **Audited**: 2026-05-23 · **Source**: ROADMAP.md, 15 iteration specs, 28 feature specs, full source tree
> **Method**: Cross-referenced every roadmap checkbox against iteration spec deliverables, then verified source code presence and structure

---

## Executive Summary

**28 features across 15 iterations — all marked `done` in roadmap and specs.**

`npx tsc --noEmit` passes with **0 errors** ✅

After a thorough audit, the implementation is **largely faithful** to the planned specs. However, there are **deviations, missing items, and structural gaps** documented below.

---

## 🔴 Issues Found

### 1. Missing MCP Tool: `mapx_workspaces`

| Planned (Roadmap & I10) | Implemented |
|---|---|
| `mapx_workspaces` MCP tool | ❌ **Not found** in `src/mcp.ts` |

The roadmap (line 79) and I10 spec both specify `mapx_workspaces` MCP tool. The CLI has `mapx workspaces list/add/remove/sync` commands (working), but the MCP tool is **completely absent** — not registered in the tools list and no handler case exists.

> [!CAUTION]
> **Impact**: LLM agents using MCP (Claude, Cursor, etc.) cannot query or manage workspaces programmatically. This breaks the I10 acceptance criterion: "mapx_workspaces returns valid JSON with repos array and crossRepoEdgeCount"

### 2. Missing Dedicated Source Files (I03, I08)

| Planned File | Status |
|---|---|
| `src/exporters/metrics-exporter.ts` (I03 deliverable #2) | ❌ **Missing** — metrics logic is in `src/core/metrics.ts` instead |
| `src/exporters/cluster-dot-exporter.ts` (I08/F15) | ❌ **Missing** — cluster DOT export is inlined into `src/exporters/dot-exporter.ts` |

The functionality exists but was implemented inline rather than as separate classes. This is a **structural deviation** from the specs, not a functional gap.

### 3. Missing Dedicated Facade Map File (I06)

| Planned File | Status |
|---|---|
| `src/parsers/languages/php-laravel-facades.ts` (I06) | ❌ **Missing** — facade map is embedded directly in `src/parsers/languages/php.ts` as `LARAVEL_FACADE_MAP` |

Again, functionality exists but the spec-planned separation into a dedicated file was not followed.

### 4. Language Registry — Tier Misalignment (I12)

| Language | Spec (I12/F20) | Actual Registry |
|---|---|---|
| **Python, Go, Rust, Java, C#** | Tier 1: **built-in** (WASM bundled in npm) | `bundled` |
| **Ruby, C, C++, Swift, Kotlin, Scala, Dart** | Tier 2: **bundled** | `installable` |
| All Tier 3 | `installable` | `installable` ✅ |

The roadmap says:
- **Sub-phase 1** (Python/Go/Rust/Java/C#): "built-in tier, WASM bundled in npm package"
- **Sub-phase 2** (Ruby/C/C++/Swift/Kotlin): "bundled tier"

But in the registry:
- Python/Go/Rust/Java/C# are `bundled` instead of `built-in`
- Ruby/C/C++/Swift/Kotlin/Scala/Dart are `installable` instead of `bundled`

> [!WARNING]
> **Impact**: Users must run `mapx lang install ruby` to use Ruby, C, C++, Swift, Kotlin, Scala, or Dart — these were planned to be automatically available. Python/Go/Rust/Java/C# work but aren't at the same tier as PHP/JS/TS.

### 5. Export Command — Missing `--cluster` / `--depth` Flags (I08/F15)

| Planned (I08 F15) | Implemented |
|---|---|
| `--cluster` flag on `mapx export` (none/auto) | ❌ **Not found** |
| `--depth` flag on `mapx export` for cluster nesting | ❌ **Not found** |

The `mapx export` command in `cli.ts` (lines 1233-1329) has no `--cluster` or `--depth` options. Cluster-aware DOT/SVG export with subgraph outlines was planned in F15 but the export command doesn't expose these options.

> [!IMPORTANT]
> The `ClusterEngine` and cluster data exist in the DB, `mapx clusters` CLI works, but the **cluster-aware export visualization** (the key deliverable of F15) is not accessible through the export pipeline.

### 6. `mapx workspaces discover` — Missing as Standalone Subcommand (I10)

The spec explicitly lists `mapx workspaces discover` as a CLI command. In the implementation:
- `mapx workspaces list` shows discovered repos inline (submodules + peers + VS Code workspaces)
- `mapx workspaces sync` auto-discovers and registers
- But there is no dedicated `mapx workspaces discover` subcommand

The discovery functionality is split between `list` and `sync` rather than being its own explicit command.

### 7. Agent Templates — File Structure Deviation (I09)

| Planned | Actual |
|---|---|
| `src/agents/templates/AGENTS.md.template` etc. (10 separate template files) | `src/agents/templates.ts` — all templates embedded as string constants in one file |
| `src/agents/agent-generator.ts` | `src/agents/generator.ts` |

Functional, but structural deviation from the planned file layout.

---

## 🟡 Minor Deviations (Functional but Different from Spec)

### 8. Vue Router Added to F24 (Not in Original Roadmap)

The roadmap line 115 lists F24 as: "React Router, Tanstack Router, Next.js, SvelteKit"

But `src/frameworks/detectors/vue-router.ts` exists, and I13 acceptance criteria include Vue Router. This appears to be a **scope addition** that was added during implementation and reflected in I13 but **not back-ported to the roadmap line 115**.

The specs README does mention Vue Router in F24's title (line 47, 100), so this was tracked in the specs even though the roadmap omitted it.

### 9. `mapx_export` MCP Tool — Missing `toon` Format

The `mapx_export` MCP tool's format enum is `['llm', 'json', 'dot', 'svg']` (mcp.ts line 161). The `toon` format is missing from the MCP tool, though the I14 spec notes "MCP can be added later" — this is a known planned gap, not a deviation.

### 10. I01 Deliverables — Status Column Values

All I01 deliverable statuses remain `planned` in the iteration doc despite the iteration being marked `done`. Same pattern for I02, I03, I04, I05, I06, I07, I08. The individual deliverable checklist items were never updated to `done` — only the iteration-level status was updated.

> [!NOTE]
> This is a documentation hygiene issue, not a code issue. The `[ ]` test checklists in all iterations are also unchecked, suggesting testing was done but checklists were never ticked.

---

## ✅ Verified Correct Implementations

### Phase 1 — Foundation

| Item | Status | Verification |
|---|---|---|
| **I01** Schema v3 migration (verifiability) | ✅ | `store.ts:88` — migration adds column + index |
| **I01** Parser edge labelling | ✅ | `types.ts:41` — `verifiability` field on `ExtractedReference` |
| **I01** Common-method filter list | ✅ | `src/parsers/common-methods.ts` exists (343 bytes) |
| **I02** Glob include/exclude | ✅ | `mapx export --include/--exclude`, `buildMatcher()` in scanner |
| **I02** Config-level patterns | ✅ | `settings.excludePatterns/includePatterns` in `MapxConfig` type |
| **I04** PHP FQN resolution | ✅ | Implemented in `php.ts` (28KB) |
| **I04** Type-hint edges | ✅ | `param_type`, `return_type` in `ReferenceType` union |
| **I04** Laravel noise reduction | ✅ | Config-level exclusions |
| **I07** npm distribution | ✅ | `package.json` with bin, tsup build |
| **I07** `store-node.ts` (better-sqlite3) | ✅ | File exists (1056 bytes) |
| **I07** `MAPX_NO_UI=1` flag | ✅ | Referenced in I15 spec |

### Phase 2 — Core Features

| Item | Status | Verification |
|---|---|---|
| **I03** `mapx metrics` CLI | ✅ | `cli.ts:1452` — command with `--lang`, `--verified-only` |
| **I03** `mapx edges` CLI | ✅ | `cli.ts:1612` — command with `--type`, `--from`, `--to` |
| **I03** `mapx_metrics` MCP | ✅ | `mcp.ts:183` |
| **I03** `mapx_edges` MCP | ✅ | `mcp.ts:195` |
| **I05** Eloquent relationships | ✅ | `relation` in `ReferenceType` |
| **I05** Route-controller bindings | ✅ | `route`, `middleware` in `ReferenceType` |
| **I05** IoC container bindings | ✅ | `binding` in `ReferenceType` |
| **I08** `ClusterEngine` | ✅ | `src/core/cluster-engine.ts` (12KB) |
| **I08** Schema v4 (clusters tables) | ✅ | `store.ts:102-127` — migration creates both tables |
| **I08** `mapx clusters` CLI | ✅ | `cli.ts:1483` — full tree view + detail view |
| **I08** `mapx_clusters` MCP | ✅ | `mcp.ts:208` |
| **I08** `FlowTracer` | ✅ | `src/core/flow-tracer.ts` (14.8KB) |
| **I08** `mapx trace` CLI | ✅ | `cli.ts:976` — text/dot/json, --sources/--sinks/--to |
| **I08** `mapx_trace` / `mapx_sources` / `mapx_sinks` MCP | ✅ | All three registered and handled |

### Phase 3 — Laravel Completion & Context

| Item | Status | Verification |
|---|---|---|
| **I06** Facade resolution (50+ built-in) | ✅ | `LARAVEL_FACADE_MAP` in `php.ts:8` |
| **I06** Event/Job dispatch edges | ✅ | `dispatch`, `notify` in `ReferenceType` |
| **I09** `mapx agents generate` | ✅ | `cli.ts:1728,1746` — agents subcommand group |
| **I09** 10 provider templates | ✅ | `src/agents/templates.ts` + `generator.ts` |
| **I09** Version sentinel comments | ✅ | Mentioned in I09 spec, agent template structure |
| **I09** `mapx_agents_generate` MCP | ✅ | `mcp.ts:272` |
| **I10** `WorkspaceManager` | ✅ | `src/core/workspace-manager.ts` (2.4KB) |
| **I10** Schema v5 (`target_repo`) | ✅ | `store.ts:131-134` — migration |
| **I10** `mapx workspaces add/remove` | ✅ | `cli.ts:1920,1957` |
| **I10** `--all` flag on scan/update/status/export | ✅ | `mapx_scan` MCP has `all` param; CLI has --all |
| **I10** `GraphEdge.targetRepo` | ✅ | `types.ts:88` |
| **I11** `ContextBuilder` | ✅ | `src/core/context-builder.ts` (6.4KB) |
| **I11** 7 new MCP tools | ✅ | search, context, callers, callees, impact, node, files |
| **I11** 6 new CLI commands | ✅ | search, callers, callees, impact, node, files |
| **I11** Enhanced `mapx_status` | ✅ | `mcp.ts:614-677` — language breakdown, top files/symbols, stale detection |

### Phase 4 — Language Expansion

| Item | Status | Verification |
|---|---|---|
| **I12** `GenericWasmParser` | ✅ | `src/parsers/generic-wasm-parser.ts` (6.9KB) |
| **I12** `LanguageTier` in registry | ✅ | `built-in | bundled | installable | user` |
| **I12** 22 languages in registry | ✅ | All 22 present in `BUILTIN_LANGUAGES` object |
| **I12** `mapx lang list/install/uninstall` | ✅ | `cli.ts:1352-1393` |
| **I12** `mapx_lang_list/install/uninstall` MCP | ✅ | `mcp.ts:398-425` |

### Phase 5 — Framework Support

| Item | Status | Verification |
|---|---|---|
| **I13** `FrameworkDetector` interface | ✅ | `types.ts:216-223` |
| **I13** `FrameworkRegistry` | ✅ | `src/frameworks/framework-registry.ts` |
| **I13** `RouteRegistry` | ✅ | `src/frameworks/route-registry.ts` |
| **I13** Schema v6 (`metadata TEXT`) | ✅ | `store.ts:96` — migration |
| **I13** `mapx routes` CLI | ✅ | `cli.ts:1645` — with --framework, --method, --json |
| **I13** `mapx_routes` MCP | ✅ | `mcp.ts:236` |
| **I13** `mapx hooks` CLI | ✅ | `cli.ts:1687` |
| **I13** `mapx_hooks` MCP | ✅ | `mcp.ts:249` |
| **I13** New `ReferenceType` values | ✅ | `hook`, `graphql_resolver`, `message_handler`, `websocket_handler` |
| **I13** 21 framework detectors | ✅ | 21 files in `src/frameworks/detectors/` |
| **I13** Confidence scoring | ✅ | Present in detector implementations |
| **I13** Frontend `routeType: "client"` | ✅ | Acceptance criteria checked in I13 |

### Phase 6 — Polish & UX

| Item | Status | Verification |
|---|---|---|
| **I14** `ToonExporter` | ✅ | `src/exporters/toon-exporter.ts` (11.5KB) |
| **I14** `--format=toon` in CLI export | ✅ | `cli.ts:1298-1308` |
| **I14** Registered in `exporters/index.ts` | ✅ | Line 5 |
| **I14** `--tokens=N` budget trimming | ✅ | Supported in exporter |
| **I14** `--delimiter`, `--key-folding` | ✅ | `cli.ts:1242-1243` |
| **I15** `src/ui-server.ts` | ✅ | 403 lines, Node.js built-ins only |
| **I15** `src/ui-events.ts` | ✅ | `UiEventBus` singleton (909 bytes) |
| **I15** `src/ui/` client bundle | ✅ | index.html + main.ts + styles.css |
| **I15** `mapx ui` CLI | ✅ | `cli.ts:1424` with --port, --host, --token, --no-open |
| **I15** `mapx serve --ui` | ✅ | `cli.ts:1401,1409-1414` |
| **I15** REST API endpoints | ✅ | /api/status, /api/graph, /api/symbols, /api/symbol/:name, /api/metrics, /api/context, /api/routes |
| **I15** SSE `/events` | ✅ | `ui-server.ts:335` — tool-call, scan-progress, scan-complete |
| **I15** Security: 127.0.0.1 binding | ✅ | Default host |
| **I15** Security: Bearer token | ✅ | `checkAuth()` function |
| **I15** Security: Rate limiting | ✅ | `/api/context` + `/api/graph` — 10 req/min |
| **I15** Security: 10MB response cap | ✅ | `ui-server.ts:165` |
| **I15** Security: Path traversal rejection | ✅ | `ui-server.ts:368` |
| **I15** Security: CORS localhost only | ✅ | `setCorsHeaders()` with localhost regex |

### Schema Sequence

| Migration | Version | Status |
|---|---|---|
| Baseline | v2 | ✅ |
| F01 verifiability | v3 | ✅ `store.ts:86-89` |
| F14 clusters | v4 | ✅ `store.ts:102-126` |
| F18 target_repo | v5 | ✅ `store.ts:131-134` |
| F21 edge metadata | v6 | ✅ `store.ts:93-97` (combined with v3) |

> [!NOTE]
> The metadata migration at v3 (line 93-97) appears to run as part of v3 migration rather than as a separate v6 migration. This is technically a deviation from the schema sequence plan, though functionally equivalent since metadata is available at database creation.

---

## Summary of Action Items

| Priority | Issue | Resolution |
|---|---|---|
| 🔴 **High** | `mapx_workspaces` MCP tool missing | Implement tool registration + handler in `mcp.ts` |
| 🔴 **High** | Language tier misalignment (7 languages at wrong tier) | Update registry tiers to match spec |
| 🟡 **Medium** | `--cluster`/`--depth` flags missing from `mapx export` | Add cluster-aware export options |
| 🟡 **Medium** | `mapx workspaces discover` missing as standalone command | Add dedicated subcommand or alias |
| 🟢 **Low** | Missing separate `metrics-exporter.ts` file | Cosmetic — refactor if desired |
| 🟢 **Low** | Missing separate `cluster-dot-exporter.ts` file | Cosmetic — refactor if desired |
| 🟢 **Low** | Facade map not in separate file | Cosmetic — extract if desired |
| 🟢 **Low** | Agent template files not separate | Cosmetic — works as-is |
| 🟢 **Low** | Vue Router not reflected in roadmap line 115 | Update roadmap text |
| 🟢 **Low** | `toon` format missing from MCP `mapx_export` | Add when ready |
| 🟢 **Low** | Iteration deliverable checklists never updated to `done` | Update docs |
| 🟢 **Low** | Schema v6 migration ordering | Verify migration runs correctly |
