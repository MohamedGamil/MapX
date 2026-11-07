# MapX gap analysis and integration design

Baseline: `develop@e9c0c3f` plus the other agent's uncommitted work (`src/cli.ts`, `src/core/scanner.ts`, `src/exporters/llm-exporter.ts`, `src/core/relations.ts`, `tests/legacy-laravel-surface.test.ts`). Nothing here has been applied to the worktree.

## 1. What MapX already has that this builds on

| Asset | Where | Reuse for |
|---|---|---|
| Typed, verifiability-tagged edges across 23 languages, including framework edges (`route`, `binding`, `dispatch`, `notify`, `hook`, `middleware`, `relation`, `render`, `http`) | `src/types.ts` `ReferenceType`, store `edges` | Dependency model (AR-02) and dependency scope (AR-06) |
| Namespace/FQN resolution for PHP and import resolution for 7 more languages | M0-04-R1, M0-12-R1 | `name` selector on qualified names |
| `extends`/`implements` edges | parsers | `extends`/`implements`/`inherits` selectors |
| Role classifier: 5 weighted signals, user `settings.architecture.overrides` (glob → role), stored signals | `src/core/role-classifier.ts` | `role` selector; inference (AR-15); `explain` |
| Fixed per-archetype layer order plus `FlowValidator` | `src/core/flow-validator.ts` `LAYER_ORDER` | Default "inferred" policy when no configuration exists; preset seed |
| Smells: Tarjan cycles, hubs, role-order violations, god/orphan clusters, unstable dependency | `src/core/architecture-analyzer.ts`, table `arch_smells` | AR-18 at layer level; one place for smells |
| DSM over clusters | `calculateDSM`, `mapx arch --dsm`, `mapx_dsm`, `/api/dsm` | Layer DSM reporter |
| Clusters (directory, namespace, Leiden) | `cluster-engine.ts`, `cluster_membership` | `cluster` selector |
| Framework detectors (Laravel, NestJS, Django, FastAPI, …) | `src/frameworks/detectors/*` | `framework` selector; presets |
| Workspaces, cross-repo `http` edges, `targetRepo` | M0-10-R1, M2-06 | `repo` selector; cross-repo rules |
| Git tracker, snapshots, staleness | `git-tracker.ts`, `snapshots`, `staleness.ts` | `arch changed --since <ref>` (file list only), stale-graph exit code |
| DOT/SVG/TOON/LLM exporters | `src/exporters/*` | Layer graph reporters |
| Dashboard with smells panel, layer colour palette, `/api/smells`, `/api/dsm` | `src/ui/main.ts`, `src/ui-server.ts` | Architecture view |
| picomatch, JSONC loading | config, workspaces | Selectors, configuration loader |

## 2. Gaps

| # | Gap | Evidence | Needed for |
|---|---|---|---|
| G1 | **No user-declared layers or ruleset.** Layer violations come only from inferred roles in a hard-coded linear `LAYER_ORDER` | `flow-validator.ts`; `architecture-analyzer.ts` `detectLayerViolations` | Everything |
| G2 | **No CI contract.** `mapx arch` prints text, has no `--json`, no machine formats and always exits 0 | `cli.ts` `arch` command | AR-16, AR-17 |
| G3 | **External, builtin and ambient targets are dropped** at resolution, so "uncovered", vendor confinement and package hygiene are impossible | `scanner.ts` returns `null` for out-of-workspace symbols | AR-04 `package`/`builtin`/`ambient`, AR-08 uncovered, AR-18 `vendor-leak`/`undeclared-dependency`/`dev-dependency-in-prod` |
| G4 | **No general capture of decorators, attributes or doc tags** in symbol metadata. Decorators are regex-parsed only inside some framework detectors (NestJS, FastAPI) | `src/frameworks/detectors/nestjs.ts`; no capture in `src/parsers/languages/*` | `decorator`, `docTag` selectors; internal markers (AR-07); `deprecated-usage` |
| G5 | **No transitive ancestry query** (closure over `extends`/`implements`) | Edges exist; no closure helper | `inherits` selectors, `inheritanceDepth` |
| G6 | **Violation output is per edge, with no aggregation, fingerprint or baseline**. Smell dedupe keys on file pairs, so line-level duplicates collapse but nothing is stable across edits | `architecture-analyzer.ts` dedupe | AR-09, AR-10 |
| G7 | **`sameCluster` silently downgrades** role-order violations to `info`. Not configurable and not explained in output | `flow-validator.ts` | Policy transparency |
| G8 | **No "why is X in layer L" for user layers.** `explain` covers role signals only | `cli.ts` `explain` | AR-13b |
| G9 | **No package-manifest model** (direct vs transitive, dev vs prod) per ecosystem | — | `package` selector options |
| G10 | **Dashboard has smells but no layer/policy view**; no drill-down from a layer edge to concrete edges | `ui/main.ts` | Dashboard |
| G11 | **MCP has `mapx_layers`/`mapx_smells`/`mapx_dsm`, but no policy or pre-flight tool** | `mcp.ts` | AR-19 |

G3 and G4 are **parser and scanner work** that benefits MapX beyond this feature (search, impact and LLM export all gain from external package nodes and decorators). They are also the riskiest items, since they touch `scanner.ts`, which the other agent is editing now.

## 3. Integration design

### 3.1 Module layout (new files; minimal edits to existing ones)

```
src/arch/                      # new: keeps the feature out of the busy core/ files
  config.ts                    # load/validate .mapx/architecture*.jsonc, extends/presets/parameters (AR-11/14/15)
  schema.ts                    # JSON Schema (also emitted to schemas/architecture.schema.json)
  elements.ts                  # Element view over store: files, symbols, externals; qualifiedName normalisation per language
  selectors/                   # one file per selector family; registry keyed by selector name (AR-04)
    path.ts name.ts hierarchy.ts decorator.ts doc-tag.ts member.ts package.ts builtin.ts ambient.ts
    role.ts cluster.ts framework.ts repo.ts language.ts layer.ts bool.ts
  membership.ts                # element → layers (+ matching selector trace), memoised per scan
  policy.ts                    # allow-set expansion (+, *, !), cycle detection → config error
  evaluate.ts                  # handler chain (AR-08) → Finding[]; multi-layer warnings
  baseline.ts                  # fingerprint, load/generate, unmatched → error, --compare diff (AR-10)
  report.ts                    # ArchReport aggregation (counts, layerEdges)
  reporters/                   # table json sarif github codeclimate junit baseline dot svg mermaid dsm toon
  introspect.ts                # layer/token/unassigned/deps/unused/changed/allowed (AR-13)
  infer.ts                     # arch init: roles + LAYER_ORDER + observed graph → config + baseline (AR-15)
  presets/*.jsonc              # shipped presets
```

Touch points in existing files, each small:

- `cli.ts`: register `check` plus `arch <sub>`. Keep the existing `arch` report working and add a `--rules` section.
- `mcp.ts`: add the tools.
- `ui-server.ts`: add `/api/arch/*`.
- `ui/main.ts`: add the view.
- `architecture-analyzer.ts`: when an architecture configuration exists, layer violations come from `evaluate.ts` instead of `FlowValidator`, and the AR-18 smells are appended.
- `store.ts`: add an `arch_findings` table (or cache the report as JSON in `meta`, like `codebase_profile`).

### 3.2 Evaluation pipeline

```
scan (existing) ─► store (files, symbols, edges, roles, clusters, + G3 externals, + G4 decorators/tags)
mapx check ─► config.load(view) ─► membership(elements) ─► edges in scope ─► evaluate ─► baseline ─► report ─► reporter ─► exit code
```

- **Performance target:** evaluation is linear in edges after O(elements × selectors) membership. Membership is memoised by `(scanId, configHash)`. 50k files and 500k edges should check in under 5 s on a warm graph; record this in `docs/benchmarking.md`.
- **Stale graph:** reuse `checkAndPrintStaleness`. `check --fail-on-stale` exits 4. `check --sync` runs an incremental scan first.

### 3.3 Relationship to existing smells and roles (one source of truth)

| Situation | Layer-violation source | Notes |
|---|---|---|
| No `.mapx/architecture*.jsonc` | `FlowValidator` (today's behaviour) | Mark these smells `source: "inferred-roles"` |
| Configuration present | `arch/evaluate.ts` | `layer-violation` smells come from the configuration; the role-order check is suppressed so findings aren't duplicated |
| Both wanted | `policy.alsoInferred: true` | Advanced |

`mapx layers` keeps listing roles, and gains `--declared` to list configured layers. `mapx_layers` gets `{ source: "roles" | "declared" }`.

### 3.4 CLI surface (proposed)

```
mapx check [--view v] [--format table|json|sarif|github|codeclimate|junit] [--output f]
           [--report-uncovered] [--fail-on-uncovered] [--report-skipped] [--fail-on warn]
           [--compare <base-report.json>] [--generate-baseline [f]] [--layer L] [--rule r] [--sync]
mapx arch init      [--preset p] [--from roles|clusters|framework] [--baseline] [--write]
mapx arch layers    [L] [--why]             # AR-13a (+ selector trace)
mapx arch which     <file|symbol>           # AR-13b
mapx arch unassigned [--kind k] [--path g]  # AR-13c, exit 2 if any
mapx arch deps      <from> [to]             # AR-13d
mapx arch unused    [--limit n]             # AR-13e
mapx arch changed   [files…] [--since ref] [--with-dependents]   # AR-13f
mapx arch allowed   <from> <to>             # AR-13g
mapx arch graph     [--format dot|svg|mermaid|dsm] [--hide L] [--group G=L1,L2]
mapx arch validate-config                    # schema + semantic checks, exit 3 on errors
```

Naming: `check` is the CI verb (it mirrors `deptrac analyse`). The `arch …` subcommands extend the existing `arch` command; today it takes only flags, so subcommands don't break it.

### 3.5 MCP surface

`mapx_arch_check`, `mapx_arch_layers`, `mapx_arch_allowed`, `mapx_arch_explain`, `mapx_arch_init` (AR-19). Defaults are JSON, matching M0-03-R2's `mapx_edges` default. Results are capped and truncation is reported (the lesson from M0-22-R1). Adding them updates the "32 tools" count in CLAUDE.md, the agent templates and the stub, as M0-03-R2 did.

Agent template addition (`src/agents/templates.ts`): *"Before adding an import across modules, call `mapx_arch_allowed`."*

### 3.6 Dashboard: an "Architecture" view

1. **Layer diagram:** layers as compound nodes (groups as parents), edges weighted by count, colours allowed (neutral), violation (red) and skipped (amber dashed). Clicking an edge shows its concrete dependencies with file:line (AR-13d), and clicking a layer lists its members with the matching selector.
2. **Layer DSM:** cells coloured by policy (disallowed and non-zero is red; allowed and zero is faint, a dead allowance).
3. **Findings table:** filters for kind, rule, layer and verifiability. Each row opens the file in the existing details panel.
4. **Health tiles:** violations, baseline debt, uncovered and unassigned counts, plus a trend from snapshots when present.
5. **Coverage overlay** on the existing graph: colour nodes by declared layer, as the role palette already does; unassigned elements are grey.

Budget: Cytoscape is already bundled, so this is mostly DOM and data. It must stay under the 720 KiB gzipped ceiling (D006, enforced by `scripts/check-package.ts`). R06 (no automated UI tests) applies, so add API-level tests for `/api/arch/*` at minimum.

### 3.7 Language and framework coverage: what each selector needs from parsers

| Capability | PHP | TS/JS | Python | Java/Kotlin | C# | Go | Rust | Ruby | Dart | Others |
|---|---|---|---|---|---|---|---|---|---|---|
| Qualified names | ✅ (M0-04-R1) | module path#name | dotted module (M0-12-R1) | package (M0-12-R1) | namespace (M0-12-R1) | import path (M0-12-R1) | crate path (M0-12-R1) | constant path (M0-12-R1) | library URI | path-based fallback |
| extends/implements | ✅ | ✅ | bases | ✅ | ✅ | — (structural) | `impl Trait for` | `<`, `include` | `extends`/`implements`/`with` | per grammar |
| Decorators/attributes (G4) | `#[...]` | `@x` | `@x` | `@X` | `[X]` | — | `#[x]` | — | `@x` | Swift `@x`, Scala `@x` |
| Doc tags (G4) | PHPDoc | JSDoc/TSDoc | docstring | Javadoc/KDoc | XML doc | `// Deprecated:` | `#[deprecated]`, doc | YARD | dartdoc | per grammar |
| Package attribution (G3, G9) | composer.json/lock | package.json plus lockfiles | pyproject/requirements/poetry.lock/uv.lock | pom/gradle | csproj/packages.lock | go.mod/go.sum | Cargo.toml/lock | Gemfile/lock | pubspec.yaml/lock | Mix, SwiftPM, … |
| Builtins | PhpStorm stubs list (as Deptrac uses) | `node:` plus the builtin module list | `sys.stdlib_module_names` snapshot | `java.*`, `javax.*` | `System.*` | std packages | `std`/`core`/`alloc` | stdlib list | `dart:` | |
| Ambient | superglobals | `process.env`, `window`, `globalThis` | `os.environ`, `sys.argv` | `System.getenv/getProperty` | `Environment.*` | `os.Getenv` | `std::env` | `ENV` | `Platform.environment` | |
| Native internal markers | — | `@internal` | `_name` | package-private, Kotlin `internal` | `internal` | `internal/` | `pub(crate)` | `private_constant` | `_name`, `lib/src` | |

Delivery order follows MapX's tiers: PHP, TS/JS, Python and Go first (fixture-backed), then Java/Kotlin and C#, then the rest.

### 3.8 Framework presets: the first wave

| Preset | Layers (selectors) | Key rules |
|---|---|---|
| `laravel` | Http (`app/Http/**`, `framework: controller/middleware`), Models (`extends Eloquent\Model`), Jobs/Events/Listeners (framework), Providers, Console, Domain/Services (`app/Services/**`), Views | Models ↛ Http; Jobs ↛ Http; only Http, Console and Jobs may `dispatch`; Providers ↛ Http |
| `symfony` | Controller, Entity (`decorator: Doctrine\ORM\Mapping\Entity`), Repository, Form, Command, EventSubscriber, Service | Entity ↛ Controller/Form; Repository ↛ Controller |
| `nestjs` | Controller (`@Controller`), Provider (`@Injectable`), Module (`@Module`), Entity, DTO, Guard/Interceptor/Pipe | Controller → Provider only; Entity ↛ Controller |
| `django` | views, models, forms, serializers, admin, management commands, migrations | models ↛ views/forms/serializers |
| `clean` / `hexagonal` | Domain, Application (UseCases/Ports), Adapters/Infrastructure, Interface/UI | Dependencies point inward; Domain → nothing (except `builtin`) |
| `feature-sliced` (frontend) | app, pages, widgets, features, entities, shared (path conventions) | Strict top-down order; no cross-imports within a level between slices |
| `ddd-contexts` | One layer per bounded context (`path: src/<ctx>/**`) plus `SharedKernel` | Context ↛ other context except through `Contracts` (private selectors) |

### 3.9 Dogfood: MapX's own architecture (example `.mapx/architecture.jsonc`)

Observed module-level import edges in `src/` today (a static scan of relative imports; counts are import statements):

```
cli → core 15, exporters 5, languages 2, ui-server 2, agents 1, frameworks 1, frameworks/http 1, mcp 1
mcp → core 14, exporters 4, languages 2, agents 1, frameworks 1, frameworks/http 1, ui-events 1
ui-server → core 6, frameworks 1, ui-events 1
exporters → core 11
core → types 12, languages 5, parsers 5, frameworks/http 4, frameworks 2
frameworks ↔ frameworks/detectors (22 / 10)        ← cycle
parsers ↔ languages (7 / 1)                         ← cycle
parsers ↔ parsers/languages (7 / 7)                 ← cycle (same package; fine if one layer)
agents → parsers 1
```

A first configuration to dogfood:

```jsonc
{
  "layers": [
    { "name": "Entry",      "selectors": [{ "path": "src/{main,index,cli,mcp,ui-server,ui-events}.ts" }] },
    { "name": "UI",         "selectors": [{ "path": "src/ui/**" }] },
    { "name": "Agents",     "selectors": [{ "path": "src/agents/**" }] },
    { "name": "Exporters",  "selectors": [{ "path": "src/exporters/**" }] },
    { "name": "Core",       "selectors": [{ "path": "src/core/**" }] },
    { "name": "Frameworks", "selectors": [{ "path": "src/frameworks/**" }] },
    { "name": "Parsers",    "selectors": [{ "path": "src/parsers/**" }] },
    { "name": "Languages",  "selectors": [{ "path": "src/languages/**" }] },
    { "name": "Shared",     "selectors": [{ "path": "src/{types,version}.ts" }] }
  ],
  "rules": {
    "Entry":      ["Agents", "Exporters", "+Core"],
    "Exporters":  ["Core", "Shared"],
    "Core":       ["Frameworks", "Parsers", "Languages", "Shared"],
    "Frameworks": ["Shared"],
    "Parsers":    ["Languages", "Shared"],
    "Languages":  ["Shared"],
    "Agents":     ["Shared"],
    "UI":         []
  }
}
```

Expected first findings, which make good fixture-validation targets:

- `Languages → Parsers` (1): a cycle with Parsers. Either allow it, or move the shared piece into Shared.
- `Agents → Parsers` (1): a real layering question.

Writing this dogfood file is a natural acceptance test for the epic: `mapx check` on MapX itself must run in CI.

## 4. Risks and conflicts

| Risk | Mitigation |
|---|---|
| The other agent is editing `scanner.ts` and `cli.ts` now | The arch engine lives in a new `src/arch/`. G3 (`scanner.ts`) is sequenced after their work lands. CLI registration is a small, late edit. |
| G3 external nodes grow the DB and change existing edge counts, metrics and PageRank | Store externals in a **separate table** (`external_refs`), not in `edges`, so existing metrics are unchanged unless they opt in. Fixture-check MapX's own edge counts, as M2-01 did. |
| Regex selectors over qualified names behave differently per language | Normalise `qualifiedName` per language (AR-01) and test every selector on a polyglot fixture |
| Inferred edges cause false CI failures | `policy.inferred: "warn"` by default |
| Scope creep (23 languages × 18 selectors) | Fixtures-first (D004). Tier 1 languages first; every selector ships with a fixture row. |
| Overlap with `FlowValidator` produces double reporting | §3.3 single-source rule |
| Dashboard size | D006 ceiling enforced by CI |
