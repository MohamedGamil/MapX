# Deptrac → MapX: analysis and adoption pack

Prepared 2026-10-31 from `deptrac/deptrac@66595d1` (its source plus bundled docs) and MapX at `develop@e9c0c3f`; integrated into the plan at `develop@8b933e1` as milestone **M5** (D013). `docs/baton/TASKS.json` and `REQUIREMENTS.json` are authoritative for the tasks and requirements; the tables in 04 and 05 are the design record. Between the two revisions 40 `src/` files changed (session 6 remediation), notably `src/core/relations.ts` (new: model relations and bindings read from stored `relation` and `binding` edges, which the AR-04 `framework` selector can reuse), `src/core/store.ts`, `src/mcp.ts` and the Laravel/NestJS detectors; the cited line numbers in 03 are from `e9c0c3f`.

| File | Contents |
|---|---|
| [01-deptrac-capabilities.md](01-deptrac-capabilities.md) | What Deptrac does, verified against its code: pipeline, 21 collectors, ruleset semantics and the exact rule-handler order, result model and exit codes, 13 formatters, debug commands, extension points, developer benefits, limitations |
| [02-abstract-feature-model.md](02-abstract-feature-model.md) | Language-agnostic feature definitions **AR-01 … AR-19**: element, dependency, layer, selectors (Deptrac collectors generalised to 23 languages plus MapX-native ones), policy, visibility, evaluation order, finding model, baseline, configuration schema, introspection, views, presets/inference, reporters, exit contract, smells, MCP |
| [03-mapx-gap-and-integration.md](03-mapx-gap-and-integration.md) | What MapX already has, gaps G1–G11 with code evidence, module layout (`src/arch/`), CLI/MCP/dashboard design, per-language parser needs, framework presets, a dogfood configuration for MapX itself, risks |
| [04-plan-draft.md](04-plan-draft.md) | Milestone M5 in phases, a dependency graph, sequencing against the in-flight work, and the retrofit checklist |
| [05-requirements.md](05-requirements.md) | **Revision 2 requirement register**: 23 requirements (MUST/SHOULD/COULD) with acceptance, delivering and verifying tasks; the revision log; the integration scope as applied |
| `docs/baton/TASKS.json`, `REQUIREMENTS.json` | The 19 tasks (M5-01 … M5-98) and REQ-ARCH-001 … 023 as merged (D013); first-wave specs in `docs/baton/iterations/M5-01.md` and `M5-02.md` |

## Bottom line

**Deptrac's core idea transfers almost unchanged; its implementation does not need to.** It is a small, sharp model: declare layers as predicates over code elements, allow-list the dependencies between them, classify every dependency, report, and fail CI. All of it is computable from a dependency graph. MapX already has a richer graph than Deptrac: 23 languages, framework, HTTP and cross-repo edges, verifiability, roles and clusters. What MapX lacks is the *declared* half: user layers, rulesets, a baseline and a CI contract. Today its layer check is a hard-coded role order (`flow-validator.ts`) that always exits 0.

What MapX can do that Deptrac can't:

1. **One rule model for polyglot and multi-repo systems.** Rules like "frontend may only call the backend's public route handlers" use MapX's `http` edges.
2. **Rules over runtime wiring:** routes, DI bindings, `dispatch`, events and hooks, not only imports.
3. **Inference before declaration.** `mapx arch init` proposes layers and rules from roles, clusters and framework detectors, plus a baseline, so adoption takes minutes.
4. **Confidence-aware enforcement.** Inferred edges warn instead of failing CI.
5. **`--compare <base-report>` ratchet** with no committed baseline, and distinct exit codes.
6. **Agent pre-flight** (`mapx_arch_allowed`): an AI agent asks whether an import is allowed before writing it.
7. **Interactive dashboard** with violation drill-down, instead of static Graphviz images.

Highest-value slice: **Phase A** (M5-01 … M5-06, about 56 h). It gives path, name, role, cluster and repo-based layers, the evaluator, `mapx check` with exit codes, and the baseline, in every language at once. Deptrac's ecosystem-specific collectors (`composer`, `php_internal`, `superglobal`, `attribute`, `tagValueRegex`) need two parser and scanner investments that also benefit the rest of MapX:

- **G3:** persist external, builtin and ambient references. Today they are dropped at resolution.
- **G4:** capture decorators, attributes and doc tags.

## Decisions (resolved by D013 with the proposed defaults)

1. **Adopt M5, and where it sits:** adopted; M3 stays the stated next milestone and M5 Phase A is a parallel-safe lane. Merged as drafted, M5's 62 h chain is the computed critical path.
2. **Config location and name:** `.mapx/architecture.jsonc` with views in `.mapx/architecture/*.jsonc` (proposed), or a top-level `mapx.arch.jsonc` that is easier to find in PRs?
3. **Verb:** `mapx check` (proposed, a CI verb) versus `mapx arch check`.
4. **Exit codes 0–4** (AR-17) versus Deptrac's single 1.
5. **Default for inferred edges:** warn (proposed) or error.
6. **External references (G3):** a separate `external_refs` table (proposed, so existing metrics are unaffected) or `edges` with an `external` flag.
7. **Research doc home:** `docs/research/deptrac/` (cited by the drafted task `sources`) or `docs/reports/`.

## Method and limits

- Deptrac claims were checked against `src/` (rule handlers and their priorities, `LayerProvider` `+` expansion, the multi-layer warning, `AnalyseRunner` failure conditions, `DependencyType` and `EmitterType` enums, `CollectorType`). The docs describe 20 collectors; the code registers 21 (`inheritanceLevel` is undocumented).
- MapX claims cite files. The dogfood import matrix in 03 §3.9 is a static count of relative imports, not a MapX scan.
- The other agent's uncommitted changes (`cli.ts`, `scanner.ts`, `llm-exporter.ts`, `relations.ts`) were read only where needed and not edited.
