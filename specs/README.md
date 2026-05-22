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
│   └── F19-smart-context-tools.md   ← Feature 19: Smart context & search MCP/CLI tools
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
    └── I11.md                        ← Iteration 11: smart context & search tools
```

---

## Feature Registry

| ID | Title | Status | Iteration | Spec |
|----|-------|--------|-----------|------|
| F01 | Edge verifiability (verified / inferred) | `planned` | I01 | [F01](features/F01-edge-verifiability.md) |
| F02 | Metrics engine (`mapx metrics`) | `planned` | I03 | [F02](features/F02-metrics-engine.md) |
| F03 | Glob include/exclude filters | `planned` | I02 | [F03](features/F03-glob-filters.md) |
| F04 | Granular edge querying (`mapx edges`) | `planned` | I03 | [F04](features/F04-edge-querying.md) |
| F05 | PHP qualified namespace (FQN) resolution | `planned` | I04 | [F05](features/F05-php-fqn-resolution.md) |
| F06 | PHP type-hint dependency edges | `planned` | I04 | [F06](features/F06-php-type-hint-edges.md) |
| F07 | Eloquent model relationship edges | `planned` | I05 | [F07](features/F07-eloquent-relationships.md) |
| F08 | Route-to-controller binding edges | `planned` | I05 | [F08](features/F08-route-controller-binding.md) |
| F09 | Service container binding edges | `planned` | I05 | [F09](features/F09-service-provider-bindings.md) |
| F10 | Laravel-aware scan exclusions & noise reduction | `planned` | I04 | [F10](features/F10-laravel-noise-reduction.md) |
| F11 | Laravel facade resolution | `planned` | I06 | [F11](features/F11-facade-resolution.md) |
| F12 | Event / Job / Notification dispatch edges | `planned` | I06 | [F12](features/F12-event-job-dispatch.md) |
| F13 | npm / npx distribution & Node.js developer experience | `planned` | I07 | [F13](features/F13-npm-distribution.md) |
| F14 | Module / domain cluster detection | `planned` | I08 | [F14](features/F14-cluster-detection.md) |
| F15 | Cluster-aware export & visualization | `planned` | I08 | [F15](features/F15-cluster-visualization.md) |
| F16 | Data flow tracing & source/sink detection | `planned` | I08 | [F16](features/F16-data-flow-tracing.md) |
| F17 | LLM agent integration file generation (`mapx agents`) | `planned` | I09 | [F17](features/F17-llm-integration-files.md) |
| F18 | Git workspace & submodule awareness | `planned` | I10 | [F18](features/F18-git-workspace-submodules.md) |
| F19 | Smart context & search MCP/CLI tools | `planned` | I11 | [F19](features/F19-smart-context-tools.md) |

**Status values:** `planned` · `in-progress` · `in-review` · `done` · `deferred` · `cancelled`

---

## Iteration Summary

| Iteration | Scope | Status | Features |
|-----------|-------|--------|----------|
| [I01](iterations/I01.md) | Schema migration + parser edge labelling | `planned` | F01 |
| [I02](iterations/I02.md) | Glob filter pipeline in scanner | `planned` | F03 |
| [I03](iterations/I03.md) | CLI + MCP surface (`metrics`, `edges`) | `planned` | F02, F04 |
| [I04](iterations/I04.md) | PHP parser fundamentals (FQN, type hints, noise) | `planned` | F05, F06, F10 |
| [I05](iterations/I05.md) | Laravel structural patterns (models, routes, IoC) | `planned` | F07, F08, F09 |
| [I06](iterations/I06.md) | Laravel advanced patterns (facades, dispatch) | `planned` | F11, F12 |
| [I07](iterations/I07.md) | npm distribution & Node.js developer experience | `planned` | F13 |
| [I08](iterations/I08.md) | Code structure, clusters & data flow | `planned` | F14, F15, F16 |
| [I09](iterations/I09.md) | LLM agent integration files (`mapx agents`) | `planned` | F17 |
| [I10](iterations/I10.md) | Git workspace & submodule awareness | `planned` | F18 |
| [I11](iterations/I11.md) | Smart context & search tools | `planned` | F19 |

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
```
