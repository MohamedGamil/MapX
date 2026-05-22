# Mapx — Specs & Delivery Index

This directory tracks all planned enhancements, feature specs, and delivery iterations for the mapx project. Each spec document is self-contained and describes a discrete unit of work that can be implemented and reviewed independently.

---

## How This Is Organised

```
specs/
├── README.md                         ← this file (master index + process guide)
├── ITERATIONS.md                     ← iteration log (start/complete dates, scope, status)
├── DECISIONS.md                      ← architecture decision record (ADR) log
│
├── 01-mapx-enhancements.md           ← original enhancement overview (reference)
├── 02-php-laravel-enhancements.md    ← PHP/Laravel enhancement overview (reference)
├── 03-code-structure-and-dataflow.md ← clusters, structure & data flow overview (reference)
├── 04-llm-integration-files.md       ← LLM agent integration files overview (reference)
├── 05-git-workspace-awareness.md     ← git workspace & submodule awareness overview (reference)
├── 06-smart-context-and-search.md    ← smart context & search tools overview (reference)
├── 07-language-expansion.md          ← language expansion overview (reference)
│
├── features/
│   ├── F01-edge-verifiability.md     ← Feature 1: dynamic vs. verified edges
│   ├── F02-metrics-engine.md         ← Feature 2: coupling & metrics command
│   ├── F03-glob-filters.md           ← Feature 3: scan/export include/exclude
│   ├── F04-edge-querying.md          ← Feature 4: granular edge querying
│   ├── F05-php-fqn-resolution.md     ← Feature 5: PHP qualified namespace resolution
│   ├── F06-php-type-hint-edges.md    ← Feature 6: PHP type-hint dependency edges
│   ├── F07-eloquent-relationships.md ← Feature 7: Eloquent model relationship edges
│   ├── F08-route-controller-binding.md ← Feature 8: Route-to-controller binding
│   ├── F09-service-provider-bindings.md ← Feature 9: IoC container binding edges
│   ├── F10-laravel-noise-reduction.md ← Feature 10: Laravel-aware scan exclusions
│   ├── F11-facade-resolution.md      ← Feature 11: Facade → concrete service resolution
│   ├── F12-event-job-dispatch.md     ← Feature 12: Event/Job/Notification dispatch edges
│   ├── F13-npm-distribution.md      ← Feature 13: npm/npx distribution & Node.js DX
│   ├── F14-cluster-detection.md     ← Feature 14: Module/domain cluster detection
│   ├── F15-cluster-visualization.md ← Feature 15: Cluster-aware export & visualization
│   ├── F16-data-flow-tracing.md     ← Feature 16: Data flow tracing & source/sink detection
│   ├── F17-llm-integration-files.md ← Feature 17: LLM agent integration file generation
│   ├── F18-git-workspace-submodules.md ← Feature 18: Git workspace & submodule awareness
│   ├── F19-smart-context-tools.md   ← Feature 19: Smart context & search MCP/CLI tools
│   ├── F20-language-expansion.md    ← Feature 20: Language expansion (19 languages)
│   ├── F21-framework-infrastructure.md ← Feature 21: Framework detection infrastructure
│   ├── F22-python-frameworks.md     ← Feature 22: Python framework routes (Django, Flask, FastAPI)
│   ├── F23-nodejs-frameworks.md     ← Feature 23: Node.js/TS framework routes (Express, NestJS)
│   ├── F24-frontend-routing.md      ← Feature 24: Frontend routing (React Router, Tanstack, Next.js, SvelteKit)
│   ├── F25-backend-frameworks.md   ← Feature 25: Backend framework routes (Rails, Spring, Go, Rust, ASP.NET, Vapor, Drupal, Laravel extended)
│   ├── F26-php-cms-frameworks.md   ← Feature 26: PHP CMS/frameworks (Symfony, Yii2, Yii3, WordPress)
│   ├── F27-toon-export.md           ← Feature 27: TOON (Token-Oriented Object Notation) export format
│   └── F28-web-dashboard.md         ← Feature 28: Bundled lightweight web dashboard
│
└── iterations/
    ├── I01.md                        ← Iteration 1: schema + parser labelling
    ├── I02.md                        ← Iteration 2: glob filters
    ├── I03.md                        ← Iteration 3: CLI/MCP surface
    ├── I04.md                        ← Iteration 4: PHP parser fundamentals
    ├── I05.md                        ← Iteration 5: Laravel structural patterns
    ├── I06.md                        ← Iteration 6: Laravel advanced patterns
    ├── I07.md                        ← Iteration 7: npm distribution & Node.js DX
    ├── I08.md                        ← Iteration 8: clusters, structure & data flow
    ├── I09.md                        ← Iteration 9: LLM agent integration files
    ├── I10.md                        ← Iteration 10: git workspace & submodule awareness
    ├── I11.md                        ← Iteration 11: smart context & search tools
    ├── I12.md                        ← Iteration 12: language expansion (19 languages)
    ├── I13.md                        ← Iteration 13: framework-aware parsing & route context
    ├── I14.md                        ← Iteration 14: TOON export format
    └── I15.md                        ← Iteration 15: bundled web dashboard
```

---

## Feature Registry

| ID | Title | Status | Iteration | Spec |
|----|-------|--------|-----------|------|
| F01 | Edge verifiability (verified / inferred) | `done` | I01 | [F01](features/F01-edge-verifiability.md) |
| F02 | Metrics engine (`mapx metrics`) | `done` | I03 | [F02](features/F02-metrics-engine.md) |
| F03 | Glob include/exclude filters | `done` | I02 | [F03](features/F03-glob-filters.md) |
| F04 | Granular edge querying (`mapx edges`) | `done` | I03 | [F04](features/F04-edge-querying.md) |
| F05 | PHP qualified namespace (FQN) resolution | `done` | I04 | [F05](features/F05-php-fqn-resolution.md) |
| F06 | PHP type-hint dependency edges | `done` | I04 | [F06](features/F06-php-type-hint-edges.md) |
| F07 | Eloquent model relationship edges | `done` | I05 | [F07](features/F07-eloquent-relationships.md) |
| F08 | Route-to-controller binding edges | `done` | I05 | [F08](features/F08-route-controller-binding.md) |
| F09 | Service container binding edges | `done` | I05 | [F09](features/F09-service-provider-bindings.md) |
| F10 | Laravel-aware scan exclusions & noise reduction | `done` | I04 | [F10](features/F10-laravel-noise-reduction.md) |
| F11 | Laravel facade resolution | `done` | I06 | [F11](features/F11-facade-resolution.md) |
| F12 | Event / Job / Notification dispatch edges | `done` | I06 | [F12](features/F12-event-job-dispatch.md) |
| F13 | npm / npx distribution & Node.js developer experience | `done` | I07 | [F13](features/F13-npm-distribution.md) |
| F14 | Module / domain cluster detection | `done` | I08 | [F14](features/F14-cluster-detection.md) |
| F15 | Cluster-aware export & visualization | `done` | I08 | [F15](features/F15-cluster-visualization.md) |
| F16 | Data flow tracing & source/sink detection | `done` | I08 | [F16](features/F16-data-flow-tracing.md) |
| F17 | LLM agent integration file generation (`mapx agents`) | `done` | I09 | [F17](features/F17-llm-integration-files.md) |
| F18 | Git workspace & submodule awareness | `done` | I10 | [F18](features/F18-git-workspace-submodules.md) |
| F19 | Smart context & search MCP/CLI tools | `done` | I11 | [F19](features/F19-smart-context-tools.md) |
| F20 | Language expansion (Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Scala, Dart, Svelte, Vue, Lua/Luau, Elixir, Zig, Bash, Pascal) | `done` | I12 | [F20](features/F20-language-expansion.md) |
| F21 | Framework detection infrastructure (FrameworkDetector, RouteRegistry, schema v6, `mapx routes`) | `done` | I13 | [F21](features/F21-framework-infrastructure.md) |
| F22 | Python framework routes (Django, Flask, FastAPI) | `planned` | I13 | [F22](features/F22-python-frameworks.md) |
| F23 | Node.js/TypeScript framework routes (Express, NestJS) | `planned` | I13 | [F23](features/F23-nodejs-frameworks.md) |
| F24 | Frontend routing frameworks (React Router, Tanstack Router, Next.js, SvelteKit) | `planned` | I13 | [F24](features/F24-frontend-routing.md) |
| F25 | Backend framework routes (Laravel extended, Drupal, Rails, Spring, Gin/chi/gorilla, Axum/actix/Rocket, ASP.NET Core, Vapor) | `planned` | I13 | [F25](features/F25-backend-frameworks.md) |
| F26 | PHP CMS/framework routes (Symfony attribute + YAML routes, Yii2/Yii3, WordPress hooks/filters/shortcodes/REST/template hierarchy) | `planned` | I13 | [F26](features/F26-php-cms-frameworks.md) |
| F27 | TOON export format (`mapx export --format=toon`) | `done` | I14 | [F27](features/F27-toon-export.md) |
| F28 | Bundled lightweight web dashboard (`mapx ui`) | `planned` | I15 | [F28](features/F28-web-dashboard.md) |

**Status values:** `planned` · `in-progress` · `in-review` · `done` · `deferred` · `cancelled`

---

## Iteration Summary

| Iteration | Scope | Status | Features |
|-----------|-------|--------|----------|
| [I01](iterations/I01.md) | Schema migration + parser edge labelling | `done` | F01 |
| [I02](iterations/I02.md) | Glob filter pipeline in scanner | `done` | F03 |
| [I03](iterations/I03.md) | CLI + MCP surface (`metrics`, `edges`) | `done` | F02, F04 |
| [I04](iterations/I04.md) | PHP parser fundamentals (FQN, type hints, noise) | `done` | F05, F06, F10 |
| [I05](iterations/I05.md) | Laravel structural patterns (models, routes, IoC) | `done` | F07, F08, F09 |
| [I06](iterations/I06.md) | Laravel advanced patterns (facades, dispatch) | `done` | F11, F12 |
| [I07](iterations/I07.md) | npm distribution & Node.js developer experience | `done` | F13 |
| [I08](iterations/I08.md) | Code structure, clusters & data flow | `done` | F14, F15, F16 |
| [I09](iterations/I09.md) | LLM agent integration files (`mapx agents`) | `done` | F17 |
| [I10](iterations/I10.md) | Git workspace & submodule awareness | `done` | F18 |
| [I11](iterations/I11.md) | Smart context & search tools | `done` | F19 |
| [I12](iterations/I12.md) | Language expansion (19 languages) | `done` | F20 |
| [I13](iterations/I13.md) | Framework-aware parsing & route context (21 frameworks) | `in-progress` | F21, F22, F23, F24, F25, F26 |
| [I14](iterations/I14.md) | TOON export format | `done` | F27 |
| [I15](iterations/I15.md) | Bundled web dashboard (`mapx ui`) | `planned` | F28 |

Iterations are intended to be **sequentially deliverable** but where features have no cross-dependency they can be parallelised. See each iteration doc for explicit dependency declarations.

---

## Process

### Adding a new feature spec

1. Assign the next `FXX` ID from the registry above.
2. Create `specs/features/FXX-<slug>.md` using the template in [features/F01-edge-verifiability.md](features/F01-edge-verifiability.md) as a guide.
3. Add a row to the **Feature Registry** table above.
4. Assign it to an iteration (existing or new).

### Adding a new iteration

1. Assign the next `IXX` ID from the iteration summary above.
2. Create `specs/iterations/IXX.md` using the template in [iterations/I01.md](iterations/I01.md) as a guide.
3. Add a row to the **Iteration Summary** table above.
4. Update [ITERATIONS.md](ITERATIONS.md) when work starts and completes.

### Updating status

- Update the **Feature Registry** and **Iteration Summary** tables in this file.
- Log all status transitions in [ITERATIONS.md](ITERATIONS.md).
- Record any significant design decisions in [DECISIONS.md](DECISIONS.md).

---

## Dependency Graph

```
I01 (F01: edge schema + parser)
 └── I03 depends on I01   (metrics query uses verifiability column)

I02 (F03: glob filters)   — independent, can run in parallel with I01/I04

I03 (F02 + F04: CLI/MCP)
 ├── depends on I01 for F02 (metrics needs verifiability)
 └── F04 (edge querying) is independent of I01/I02

I04 (F05 + F06 + F10: PHP fundamentals)
 ├── F05 (FQN) is independent of all existing iterations — can run in parallel with I01/I02
 ├── F06 (type hints) depends on F05 (use-import table)
 └── F10 (noise reduction) is independent of all other features

I05 (F07 + F08 + F09: Laravel structural)
 ├── depends on I04 (F05 FQN resolution required by all three)
 └── F07, F08, F09 are independent of each other within I05

I06 (F11 + F12: Laravel advanced)
 ├── depends on I05
 ├── F11 (facades) depends on F09 binding table (optional: for cross-reference)
 └── F12 (dispatch) depends on F05 FQN only; independent of F07-F09

I07 (F13: npm distribution)
 └── FULLY INDEPENDENT — no dependency on I01–I06, can be merged at any time

I08 (F14 + F15 + F16: clusters & data flow)
 ├── INDEPENDENT of I01–I07 (can be developed in parallel)
 ├── F14 (cluster detection) benefits from F05 being merged (accurate PHP namespaces)
 ├── F15 (cluster export) depends on F14 within I08
 ├── F16 (data flow) is independent of F14/F15 — can be developed in parallel with F14
 └── F16 traces are richer when F07–F12 Laravel edges are present (dispatch, route, relation)

I09 (F17: LLM agent integration files)
 └── FULLY INDEPENDENT — no dependency on any other iteration, can be merged at any time

I10 (F18: git workspace & submodule awareness)
 ├── INDEPENDENT of all other iterations
 └── Cross-repo edges are richer when I04/I05 (PHP FQN resolution) are merged

I11 (F19: smart context & search tools)
 ├── INDEPENDENT of all other iterations
 ├── mapx_context is richer when F14 (clusters) are available
 └── mapx_callers/mapx_callees are richer with F16 (flow edges) and F07/F08/F12 (Laravel edges)

I12 (F20: language expansion)
 ├── FULLY INDEPENDENT — no dependency on any other iteration
 ├── Framework-aware edges for new languages (e.g. Django routes) deferred to future iterations
 └── Quality of symbol extraction depends on tree-sitter grammar maturity per language

I13 (F21–F26: framework-aware parsing)
 ├── F21 (framework infrastructure) is the prerequisite for F22–F26 — merge first
 ├── F22 (Python), F23 (Node.js), F24 (frontend), F25 (other backends), F26 (PHP CMS) are independent of each other
 ├── F25/F26 (Go/Rust/Java/C#/Swift/Ruby/PHP backends) benefit from I12 parsers but use regex extraction — can proceed before I12
 └── Route edges are richer when I05/I06 Laravel edges are already present (F25 Laravel extended builds on F08)

I14 (F27: TOON export)
 ├── FULLY INDEPENDENT — no dependency on any other iteration
 └── Benefits from I13 route/hook metadata in edges table (metadata JSON column from F21 schema v6) but works without it

I15 (F28: web dashboard)
 ├── Requires I07 (F13 npm dist) — dashboard assets must be shippable in the npm package
 ├── Richer with I08 (clusters), I10 (git), I11 (smart context), I13 (routes) — degrades gracefully without each
 └── MCP tool-call log requires mapx serve (any iteration) — standalone mapx ui still works without it
```
