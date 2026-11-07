# Abstract feature model: architecture rules for MapX

This file restates Deptrac's features as **language-agnostic definitions** that MapX can implement once over its graph (files, symbols and typed edges in 23 languages) instead of over PHP ASTs. Every definition has a stable ID (`AR-nn`), so later tasks, requirements and specs can cite it.

Working name: **MapX Architecture Rules** (`mapx check`, `mapx arch …`, `mapx_arch_*`).

## 0. Vocabulary mapping

| Deptrac | MapX abstraction | MapX today |
|---|---|---|
| Token (class-like, function, file, superglobal) | **Element**: `file`, `symbol` (class, interface, trait, enum, struct, function, method, module, …), `external` (third-party package or symbol), `builtin` (stdlib/runtime), `ambient` (env, globals, process) | `files` and `symbols` exist. External, builtin and ambient elements are **not persisted**: resolution returns `null` for out-of-workspace symbols (`scanner.ts`, the "third-party/external" short-circuit). |
| Dependency plus `DependencyType` | **Dependency**: a graph edge `(source element, target element, edgeType, line, verifiability, metadata)` | `edges` with `ReferenceType` (`import`, `extends`, `implements`, `call`, `instantiation`, `param_type`, `return_type`, `route`, `binding`, `dispatch`, `http`, …) and `verifiability` |
| Emitter types (`analyser.types`) | **Dependency scope**: a filter over edge types and verifiability | Edge filters exist (`edges --type`, `--verified-only`) |
| Layer plus collectors | **Layer**: a name plus **selectors** | Only *inferred* roles (`FileRole`) and clusters; no user-declared layers |
| Ruleset | **Policy**: an allow graph, default deny | Fixed `LAYER_ORDER` per archetype (`flow-validator.ts`) |
| Violation, Skipped, Uncovered, Allowed, Warning, Error | **Finding kinds** (same six) | Only `ArchSmell { type, severity }` |
| `skip_violations` / baseline formatter | **Baseline** | None |
| Formatters | **Reporters** | `arch` prints text; no JSON or CI formats for architecture |
| `debug:*`, `changed-files` | **Introspection** | `explain <file>` (role signals), `layers` (role groups), `impact` |

## 1. Core definitions

### AR-01 Element

Anything that can be a dependency endpoint. It has a `kind` (above), a `qualifiedName` (namespace-qualified, normalised per language: PHP `App\Http\FooController`, TS `src/app/foo.ts#FooService`, Python `app.services.foo.FooService`, Java `com.acme.foo.FooService`, Go `example.com/app/internal/foo.Service`, Rust `crate::foo::Service`), a `file`, a `repo`/`package` (workspace member) and a `language`. It can also carry its decorators/annotations, doc tags, ancestors (transitive), MapX role, cluster, and framework entity type (`controller`, `model`, `route-handler`, `component`, `middleware`, …).

**Granularity rule (revised):** an edge is evaluated between the finest elements it names. When an edge end has a symbol, that symbol's layers are used; when it has only a file, the **file's** layers are used. A file's layers are the union of (a) layers whose `path`/`repo`/`language`/`role`/`cluster` selectors match the file and (b) layers of every top-level symbol declared in it. A symbol's layers are the union of the layers its own selectors match and its file's path-based layers (a). So a `path` layer covers everything in the directory, and a `name` layer can still single out one class in a multi-class file. Membership never flows from a symbol to a *different* symbol in the same file.

### AR-02 Dependency

A directed edge between elements, with `type` (the MapX `ReferenceType`), `line`, `verifiability` and `repo` → `targetRepo` (so cross-repo edges are allowed).

**Inherited dependencies (Deptrac's flattening):** if `B` inherits from `A` and `A` → `X`, MapX may derive `B` → `X` with `via: [B, A]`. Off by default for MapX (`policy.inheritDependencies: false`), because MapX edges already include call-level detail. Without it, a subclass in layer L does not violate through its parent's dependencies; MapX reports them on `A`.

### AR-03 Layer

`{ name, description?, selectors[], private?: selectors[], overlay?: boolean, group?, color? }`. Membership: an element is in the layer if **any** selector matches. An element may be in several layers (see AR-12).

**Overlay layers (MapX addition, revised in).** `overlay: true` marks a layer that only ever appears on the *target* side of a rule: `Deprecated`, `Vendor`, `DevOnly`, `Internal`. An overlay layer is never used as a source layer, never counts toward the `multi-layer` warning, and is not a layer for "uncovered" purposes (an element only in overlays is still uncovered). Without this, every `@deprecated` class in `Domain` would be flagged as being in two layers, which is a Deptrac papercut this model avoids.

### AR-04 Selector (Deptrac's collector, generalised)

A predicate `(element, graph) → boolean`. All selectors are pure functions of the stored graph, so they can be cached per scan. Built-in selectors:

| Selector | Deptrac origin | Definition | Language notes |
|---|---|---|---|
| `path` | `directory`, `glob` | `glob` (picomatch, as MapX already uses) or `regex` on the repo-relative path | Universal |
| `name` | `classLike`, `class`, `interface`, `trait`, `classNameRegex`, `functionName` | Regex on `qualifiedName`, optionally restricted by `kind: [...]` | Kind vocabulary is MapX's `SymbolKind` (`struct` for Go/Rust/C#, `module` for Ruby/Elixir, …) |
| `extends` / `implements` / `inherits` / `mixes` | `extends`, `implements`, `inherits`, `uses` | Transitive ancestry over `extends`/`implements` edges; `mixes` covers traits, mixins, Ruby `include`, Scala/Dart `with`, Rust `impl Trait for` | Needs resolved inheritance edges; Go has no nominal inheritance (use `implements` inferred from method sets: P3) |
| `inheritanceDepth` | `inheritanceLevel` | Ancestry depth ≥ N | Mostly a smell input |
| `decorator` | `attribute` | Element carries an annotation, attribute or decorator whose name (FQN or suffix) matches | PHP `#[Attr]`, TS/JS `@Dec()`, Python `@dec`, Java/Kotlin `@Ann`, C# `[Attr]`, Rust `#[derive/attr]`, Dart `@ann`, Swift `@attr` |
| `docTag` | `tagValueRegex` | Doc block has tag T (and optionally a value matching regex V) | PHPDoc, JSDoc/TSDoc, Javadoc/KDoc, C# XML doc `<tag>`, Rust doc attributes, Python docstring directives (`.. deprecated::`); for Python, `@deprecated`-style decorators count too |
| `member` | `method` | Element has a member (method or field) whose name matches | Universal |
| `package` | `composer` | Element is external and belongs to a package matching name or glob, with options `dev: bool`, `direct: bool` | npm (`package.json`/lock), Composer, pip/Poetry/uv (`pyproject`, `requirements`), Go modules, Cargo, Maven/Gradle, NuGet, pub, Bundler, Mix, SwiftPM |
| `builtin` | `php_internal` | Element is part of the language standard library or runtime | Node built-ins (`node:fs`), Python stdlib, Go std, Java `java.*`, .NET `System.*`, Rust `std::` |
| `ambient` | `superglobal` | Access to process-global state: `$_GET`/`$_SERVER`, `process.env`, `os.environ`, `System.getenv`, `window`/`document`, globals | Enables "only Config may read env" |
| `role` | — (MapX-native) | Element's file has MapX role R (the classifier's output, confidence ≥ c) | Bridge from inferred to declared architecture |
| `cluster` | — | Element's file is in cluster C (directory, namespace or Leiden community) | |
| `framework` | — | Framework part, **derived from stored edges** (detectors emit edges, not entity types): `route-handler` = target of a `route` edge; `middleware` = target of a `middleware` edge; `model` = source of a `relation` edge; `job`/`event`/`listener` = target of `dispatch`/`notify` edges; `resolver` = `graphql_resolver` target; `component` = `render` target; `http-client` = source of an `http` edge | Limited to what detectors already persist; new entity kinds need detector work and are out of scope here |
| `repo` / `workspacePackage` | — | Element belongs to a workspace repo or monorepo package | Cross-repo rules |
| `language` | — | Element's language | Polyglot rules (e.g. "TS must not import generated Python stubs") |
| `layer` | `layer` | Element is in another named layer | Reuse and exclusion |
| `all` / `any` / `not` | `bool` (`must`, `must_not`) | Boolean composition; adds `any`, which Deptrac lacks | |
| custom | `CollectorInterface` | Plugin-provided selector (JS module) | P3: needs a plugin story |

Regex flavour: JS `RegExp`, case-insensitive by default, as in Deptrac's simplified collectors. `/.../flags` overrides it.

### AR-05 Policy (ruleset)

```jsonc
"rules": {
  "Controller": ["Service"],
  "Service":    ["+Repository"],   // '+' = transitive: Service also gets Repository's allowances
  "Repository": []
}
```

- **Default deny** across distinct layers. Same-layer dependencies are always allowed.
- **`+L` transitive inheritance.** A `+` cycle is a configuration **error**, not a crash.
- MapX extensions (all optional, and absent from Deptrac):
  - **`"*"` as a value** allows every non-overlay layer. **`"*"` as a key** declares defaults that apply to every source layer and are merged into each layer's own list. `"!L"` is an explicit deny; precedence is **`!` > explicit allow > `+` expansion > `*`**, so `"*": ["!Deprecated"]` cannot be undone by a layer's `"*"`. Only the `+` form can create cycles; `*`, `!` and plain allows cannot;
  - **Per-rule severity:** `{ "allow": [...], "severity": "error" | "warn" }`, so a whole layer pair can be advisory;
  - **Per-rule dependency scope:** `{ "to": "Model", "types": ["param_type", "return_type"] }`, e.g. "views may reference model *types* but not call them";
  - **Verifiability policy:** `policy.inferred: "error" | "warn" | "ignore"`. Inferred edges are downgraded to warn by default, so heuristic edges don't break CI.

### AR-06 Dependency scope

`scope.types` (edge types analysed; the default is the structural set `import`, `require`, `extends`, `implements`, `call`, `instantiation`, `param_type`, `return_type`) and `scope.include` / `scope.exclude` (path globs). Framework edges (`route`, `binding`, `dispatch`, `notify`, `hook`, `middleware`, `relation`, `render`, `http`) are opt-in because they encode runtime wiring, and some teams want to police that too (e.g. "only Http may dispatch Jobs").

### AR-07 Visibility (public API vs private implementation)

Two mechanisms, both evaluated **after** the allow check passes:

1. **`private` selectors on a layer.** Elements they match are reachable only from the same layer (Deptrac's `private: true`, rule `private-layer`).
2. **Internal markers.** A symbol marked internal is reachable only from its own layer (rule `internal-element`). Markers:
   - doc tags `@internal` and `@mapx-internal` (configurable);
   - **language-native visibility where it is module-scoped**: Go `internal/` directories (the compiler enforces these per module, but not across a monorepo's layers), Kotlin `internal`, C# `internal`, Rust `pub(crate)`/`pub(super)`, Java package-private, Python leading-underscore modules and names, Dart `_` names and `src/` under `lib/`, TS `@internal` with `stripInternal`.

   Native markers are **off by default** (`visibility.nativeMarkers: true` enables them), because layer boundaries rarely coincide with compiler boundaries.

### AR-08 Evaluation order (rule-handler chain)

Deterministic and documented. The first match decides:

1. **Out of scope** (edge type, path or verifiability) → ignored.
2. **Uncovered:** the target is in no layer. Builtins are ignored unless `uncovered.builtins: true`; externals are reported unless `uncovered.externals: false`.
3. **Same layer:** every target layer equals the source layer → nothing recorded.
4. **`disallowed-layer`:** the target layer is not in the expanded allow-set, or is denied with `!`.
5. **`internal-element`.**
6. **`private-layer`.**
7. **Allowed.**

Steps 4–6 go through **baseline matching**: a match turns the finding into `skipped`.

Rule IDs are stable strings with a human description, exactly as in Deptrac's `ruleName`/`ruleDescription`.

### AR-09 Finding kinds and result model

```ts
type FindingKind = 'violation' | 'skipped' | 'uncovered' | 'allowed' | 'warning' | 'error';
interface Finding {
  kind: FindingKind;
  rule?: 'disallowed-layer' | 'internal-element' | 'private-layer' | string; // custom rules later
  severity: 'error' | 'warn' | 'info';
  source: { element: string; file: string; line: number; layer: string; repo: string };
  target: { element: string; file?: string; layer?: string; repo?: string; external?: { ecosystem: string; package: string } };
  edgeType: ReferenceType; verifiability: 'verified' | 'inferred';
  via?: string[];          // inherited-dependency path (AR-02)
  fingerprint: string;     // stable: hash(rule, source.element, target.element, edgeType). No line number, so it survives edits.
  message: string;         // "App\Repo\UserRepo must not depend on App\Http\UserController (Repository on Controller)"
}
interface ArchReport {
  counts: Record<FindingKind, number>;
  findings: Finding[];
  layers: { name: string; elements: number; files: number }[];
  layerEdges: { from: string; to: string; allowed: number; violations: number; skipped: number }[]; // for graph/DSM
  configErrors: string[];
}
```

**Warnings:** an element in more than one layer (`multi-layer`), a layer that matched nothing (`empty-layer`, which Deptrac lacks), and a selector referencing an unknown layer.

**Errors:** an unmatched baseline entry (AR-10), a `+` cycle, invalid configuration.

### AR-10 Baseline

- `mapx check --generate-baseline [file]` writes every current violation **fingerprint** with readable `source`/`target`/`rule` keys, sorted and stable, so diffs review cleanly.
- On load, a matching violation becomes `skipped`. **An entry that matches nothing becomes an `error`** (it's stale, so delete it). This is the ratchet.
- Element-pair matching (Deptrac semantics: `source element → [target elements]`) is supported for portability; fingerprint matching is the default.
- **Ratchet without a committed baseline (revised).** The primary form is **`--compare <report.json>`**: a JSON report produced on the base revision (CI runs `mapx check --format json -o base.json` on the merge base, then `mapx check --compare base.json` on the head). Only fingerprints absent from the base report fail. It is deterministic and costs one extra check. The convenience **`--since <git-ref>`**, which would need a second scan of a worktree at the ref, is **deferred (COULD)**: it is expensive on large repos and its result depends on scan cache state.

### AR-11 Configuration document

`.mapx/architecture.jsonc`, with optional extra views in `.mapx/architecture/<view>.jsonc` (AR-14). JSONC like `workspaces` (M0-10-R1). A JSON Schema is published for editor completion.

```jsonc
{
  "$schema": "https://unpkg.com/@mgamil/mapx/schemas/architecture.schema.json",
  "extends": ["./architecture.base.jsonc", "mapx:preset/laravel"],   // Deptrac 'imports' plus built-in presets
  "parameters": { "App": "App" },                                     // %App% substitution
  "scope": { "types": ["import", "extends", "implements", "call", "instantiation", "param_type", "return_type"],
             "exclude": ["tests/**", "database/migrations/**"] },
  "policy": { "inferred": "warn", "inheritDependencies": false, "uncovered": { "externals": true, "builtins": false } },
  "visibility": { "internalTags": ["@internal", "@mapx-internal"], "nativeMarkers": false },
  "layers": [
    { "name": "Http",       "selectors": [{ "path": "app/Http/**" }], "group": "Entry" },
    { "name": "Domain",     "selectors": [{ "name": "^%App%\\\\Domain\\\\", "kind": ["class", "interface", "enum"] }] },
    { "name": "Infra",      "selectors": [{ "path": "app/Infrastructure/**" }],
                            "private":   [{ "package": "doctrine/*" }] },               // only Infra may touch Doctrine
    { "name": "Models",     "selectors": [{ "extends": "Illuminate\\Database\\Eloquent\\Model" }] },
    { "name": "Deprecated", "overlay": true, "selectors": [{ "docTag": "@deprecated" }] },
    { "name": "Vendor",     "overlay": true, "selectors": [{ "package": "*", "dev": false }] },
    { "name": "DevOnly",    "overlay": true, "selectors": [{ "package": "*", "dev": true }] },
    { "name": "Frontend",   "selectors": [{ "repo": "web" }] },
    { "name": "PublicApi",  "selectors": [{ "all": [{ "repo": "api" }, { "framework": "route-handler" }] }] }
  ],
  "rules": {
    "Http":     ["Domain", "+Infra", "Models"],
    "Infra":    ["Domain", "Vendor"],
    "Domain":   [],
    "Frontend": [{ "allow": ["PublicApi"], "types": ["http"] }],     // cross-repo, via MapX http edges
    "*":        ["!Deprecated", "!DevOnly"]                          // nobody may use deprecated or dev-only code
  },
  "baseline": ".mapx/architecture.baseline.json",
  "report": { "groups": { "Entry": ["Http"] }, "hidden": ["Vendor"] }
}
```

### AR-12 Multi-layer elements

The source element is evaluated once per **non-overlay** source layer, with one `multi-layer` warning per element. `strictLayers: true` turns that warning into an error. This is the usual fix for ambiguous regexes.

### AR-13 Introspection (Deptrac's debug commands)

| ID | Question | Deptrac | Output and exit |
|---|---|---|---|
| AR-13a | Which elements are in layer L? | `debug:layer` | Element, kind, file, matching selector (*why*, which Deptrac does not show) |
| AR-13b | Which layers is element E in, and why? | `debug:token` | Layer and selector trace (pairs with `mapx explain`) |
| AR-13c | What is in no layer? | `debug:unassigned` | **Exit 2** if non-empty; `--kind`, `--path` filters |
| AR-13d | Which concrete edges go from L1 to L2? | `debug:dependencies` | Edge list with file:line, type and verifiability |
| AR-13e | Which allowances are unused or weak? | `debug:unused --limit` | Rule, from, to, count |
| AR-13f | Which layers do these files touch, and who depends on them? | `changed-files --with-dependencies` | Also `--since <ref>` for the *file list only* (cheap: `git diff --name-only`, via git-tracker); no re-scan |
| AR-13g | Would a new dependency `A → B` be allowed? | — (MapX-native) | Decision plus rule plus path. **The agent pre-flight check.** |
| AR-13h | Bootstrap: propose layers and rules from the current graph | `init` (static template) | From roles, clusters, framework detectors and the observed layer DAG (AR-15) |

### AR-14 Views

Several configuration documents, each an independent policy over the same graph: e.g. `layers` (technical layering), `contexts` (bounded-context isolation), `vendors` (third-party confinement), `naming` (conventions). They share definitions through `extends`. `mapx check --view contexts`; with no view, all views run and the results are merged with a `view` field on each finding.

### AR-15 Presets and inference (MapX-native)

- **Presets:** shipped JSONC fragments, `mapx:preset/<name>`, for common architectures. They are parameterised by path conventions and refined by MapX framework detection:
  - generic: `layered`, `clean`, `hexagonal` (ports and adapters), `onion`, `ddd-contexts`, `mvc`, `mvvm`, `feature-sliced` (frontend);
  - framework: `laravel`, `symfony`, `nestjs`, `express`, `django`, `fastapi`, `rails`, `spring`, `aspnet`, `flutter`, `nextjs`, `vue`.
- **Inference (`mapx arch init`):**
  - map MapX roles to layers;
  - turn the existing `LAYER_ORDER[archetype]` into a "may depend downward" ruleset;
  - compute the observed layer-to-layer edges;
  - emit the configuration plus a baseline of today's violations, so day one is green and further drift fails.

  The inferred configuration is a starting point that a person reviews and edits before relying on it.

### AR-16 Reporters

| Reporter | Deptrac | Notes |
|---|---|---|
| `table` (default TTY), `text` | table, console | Grouped by layer, with rule name and reason |
| `json` | json | The `ArchReport` above; a stable schema for MCP and the dashboard |
| `sarif` | — | GitHub code scanning and most IDEs. **Preferred over** github-actions for persistence |
| `github` | github-actions | Selected automatically when `GITHUB_ACTIONS` is set |
| `codeclimate` | codeclimate | GitLab Code Quality; severity map |
| `junit` | junit | One suite per layer |
| `baseline` | baseline | AR-10 |
| `dot`, `svg`, `mermaid` | graphviz-*, mermaidjs | Layer graph: counts on edges, violations red, skipped dashed, groups as subgraphs, hidden layers, point-to-group. Reuse MapX's dot/svg exporters. |
| `dsm` | — | Layer × layer matrix: cells are counts, red where disallowed. Reuses `calculateDSM`. |
| `toon` / `llm` | — | Compact form for LLM context (MapX already has TOON) |

### AR-17 Exit contract (an improvement on Deptrac)

| Code | Meaning |
|---|---|
| 0 | No failing findings |
| 1 | Violations (severity error, not baselined) |
| 2 | Uncovered with `--fail-on-uncovered`, or unassigned (AR-13c) |
| 3 | Configuration or baseline errors (stale entries, `+` cycle, invalid schema) |
| 4 | Graph stale or missing (scan required), or internal error |

`--fail-on warn` promotes warnings.

### AR-18 Architecture-aware smells (derived from the rule model)

These come for free once layers exist. They join `mapx_smells` with `source: "rules"`:

| Smell | Definition |
|---|---|
| `layer-cycle` | Strongly connected component in the *observed* layer graph (Tarjan, already in `architecture-analyzer.ts`, run at layer level) |
| `dead-allowance` | An allowed pair with 0 dependencies (AR-13e): the rule could be tightened |
| `weak-allowance` | An allowed pair used ≤ N times: a candidate for removing the coupling |
| `vendor-leak` | An external package used outside its confining layer (private package selector) |
| `undeclared-dependency` | Imports a package that is not a direct dependency in the manifest (transitive only), or is missing entirely |
| `dev-dependency-in-prod` | Non-test code depends on a dev-only package |
| `deprecated-usage` | Edges into elements tagged `@deprecated` (a docTag layer) |
| `layer-skip` | In a strictly ordered preset, a layer bypasses the next one down (Controller → Repository when Service exists) |
| `unstable-layer-dependency` | Martin's Stable Dependencies Principle at layer level (I(source) < I(target)); exists today at cluster level |
| `abstractness-distance` | Distance from the main sequence D = abs(A + I − 1) per layer, using interface/abstract counts. New metric. |
| `orphan-element` | Unassigned element with no inbound edges (dead code inside an uncovered area) |
| `baseline-debt` | Count and age of baselined violations per layer: tracks paydown |

### AR-19 Agent surface (MCP)

| Tool | Purpose |
|---|---|
| `mapx_arch_check` | Run the policy; returns `ArchReport` (counts, top findings, filters `layer`, `rule`, `file`, `since`) |
| `mapx_arch_layers` | Layers, sizes and membership (AR-13a/b/c) |
| `mapx_arch_allowed` | **Pre-flight**: "may file/symbol A depend on B (or layer L)?" → `{ allowed, rule, reason, alternatives }`, where alternatives are the allowed layers that already expose a matching symbol. Lets an agent check a dependency before writing the import. |
| `mapx_arch_explain` | Why element E is in layer L and why edge E→F is a violation (selector and rule trace) |
| `mapx_arch_init` | Propose a configuration (AR-15); never writes unless `write: true` |

## 2. Feature-to-benefit map

| Feature | Developer benefit | Who |
|---|---|---|
| AR-03/04/05 layers, selectors, policy | Architecture as reviewed, versioned code | Leads, architects |
| AR-08/09 findings with named rules | Actionable CI failures at file:line | Every developer |
| AR-10 baseline and `--since` | Adopt on legacy code without a big-bang cleanup | Teams with legacy code |
| AR-07 visibility | Package-private semantics in languages without them (PHP, Python, JS) | Library and module owners |
| AR-04 `package`/`builtin`/`ambient` | Vendor confinement and dependency hygiene in every ecosystem | Platform and security |
| AR-04 `repo`/`http` scope | Cross-service rules: polyglot and multi-repo | Microservice and full-stack teams |
| AR-13 introspection | Debug and maintain rules cheaply | Rule authors |
| AR-15 presets and inference | Usable in minutes, not hours | New adopters |
| AR-16/17 reporters and exit codes | Fits GitHub, GitLab and IDEs natively | DevOps |
| AR-18 smells | Health trends beyond pass/fail | Architects, tech-debt planning |
| AR-19 MCP | AI agents respect the architecture *before* writing code | Agent-assisted teams |
