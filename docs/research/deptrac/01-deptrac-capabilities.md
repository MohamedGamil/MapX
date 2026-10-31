# Deptrac: capability assessment

Source: `deptrac/deptrac` at `66595d1` (2026-09-20), its bundled `docs/`, and the code under `src/`. Claims below were read from the code, not only from the docs. Where the docs and the code disagree, the code wins and the difference is noted.

## 1. What it is, in one paragraph

Deptrac is an **architecture conformance checker** for PHP. You declare named **layers**, each defined by **collectors**: predicates over code elements, such as "FQCN matches `.*Controller`", "file is under `src/Domain/`" or "implements `RepositoryInterface`". You then declare a **ruleset**, which says which layers each layer may depend on. Every dependency is denied unless the ruleset allows it. Deptrac extracts dependencies statically, assigns both ends of each one to layers, and classifies it as allowed, violation, skipped (baselined), uncovered (target is in no layer), warning or error. It then reports through a pluggable formatter: table, JSON, JUnit, CodeClimate, GitHub annotations, Graphviz or Mermaid. It is built for CI: the exit code is non-zero on violations or errors, and on uncovered dependencies when asked.

Its value is that **architecture stops being a diagram that drifts and becomes an executable, versioned contract.**

## 2. Pipeline

```
paths/exclude_files ─► Parser (nikic or experimental PHPStan) ─► AstMap (tokens + references)
      ─► Dependency emitters (enabled by analyser.types) ─► DependencyList
      ─► Flatten inheritance (class inherits its ancestors' dependencies) ─► + InheritDependency
      ─► For each dependency: resolve depender/dependent tokens → layers (collectors)
      ─► ProcessEvent per (dependency × depender layer) → rule-handler chain
      ─► PostProcessEvent (unmatched-baseline errors) ─► AnalysisResult ─► OutputFormatter ─► exit code
```

- **Tokens** (the nodes): `class-like` (class, interface, trait, enum), `function`, `file` and `superglobal`. Extensions can add token types through `TokenResolverInterface`.
- **Dependency types** (`DependencyType` enum, metadata on each edge): `use`, `inherit`, `returntype`, `parameter`, `new`, `static_property`, `static_method`, `instanceof`, `catch`, `variable` (property or `@var`), `throw`, `const`, `anonymous_class_extends/implements/trait`, `attribute`, `superglobal_variable` and `unresolved_function_call`.
- **Emitters** (`analyser.types`, which select the dependencies analysed): `class` (default), `class_superglobal`, `use` (default), `file`, `function`, `function_superglobal` and `function_call`. Custom emitters are registered by key.
- **Inheritance flattening:** if `B extends A` and `A` depends on `X`, then `B` depends on `X`, recorded as an `InheritDependency` with the full inheritance path. Base classes therefore cannot launder forbidden dependencies.
- **Cache:** parsed files are cached in `.deptrac.cache`; `--no-cache` disables it.

## 3. Layers and collectors (21 built-in)

A layer is `{ name, collectors[] }`. A token belongs to the layer if **any** collector matches it, and a token may belong to several layers.

| Family | Collectors | Matches on |
|---|---|---|
| Name | `classLike`, `class`, `interface`, `trait`, `classNameRegex`, `functionName` | FQN regex, with an implicit `/…/i` (`classNameRegex` takes a raw regex) |
| Location | `directory` (regex on path), `glob` | File path |
| Type hierarchy | `extends`, `implements`, `inherits` (any of the three), `uses` (trait), `inheritanceLevel` (inheritance depth ≥ N) | Transitive ancestry |
| Metadata | `attribute` (PHP 8 attributes), `tagValueRegex` (phpdoc tag plus optional value regex, e.g. `@deprecated since v2`) | Annotations and doc tags |
| Members | `method` | The class has a method whose name matches the regex |
| Ecosystem | `composer` (packages from `composer.json`/`.lock`), `php_internal` (built-in classes and functions), `superglobal` | Third-party and runtime code |
| Composition | `bool` (`must[]` AND, `must_not[]` NOT), `layer` (reuse another layer's membership) | Other collectors |
| Custom | Any class implementing `CollectorInterface::satisfy(config, tokenRef)` | Anything |

**Modifier: `private: true` on a collector.** Tokens matched by that collector may only be referenced from within the same layer, even if the ruleset allows the layer. This gives a module a *public API* and a *private implementation*, or confines a vendor library to one layer.

**Doc tags: `@deptrac-internal` (always) and `analyser.internal_tag` (e.g. `@internal`).** A tagged class-like may not be referenced from outside its layer. This is per-class visibility without splitting layers.

## 4. Ruleset semantics

```yaml
ruleset:
  Controller: [Service]          # Controller → Service allowed
  Service:    [+Repository]      # '+' = Service may also use everything Repository may use (transitive)
  Repository: ~                  # nothing
```

- **Default deny** between distinct layers. Dependencies within a layer are always allowed.
- `+Layer` inherits that layer's allowances recursively. A cycle in `+` chains raises a **CircularReferenceException**, which is reported as an *error*.
- **Rule-handler chain** (Symfony event priorities, highest first; the first handler that decides stops propagation):

| Priority | Handler | Outcome |
|---|---|---|
| 2 | `UncoveredDependentHandler` | Target in no layer → **Uncovered**. PHP built-ins are ignored by default (`ignore_uncovered_internal_classes`). |
| 1 | `MatchingLayersHandler` | All target layers equal the depender layer → stop, nothing recorded |
| −1 | `DependsOnDisallowedLayer` | Target layer not allowed (after `+` expansion) → **Violation** (`DependsOnDisallowedLayer`) |
| −2 | `DependsOnInternalToken` | Target class tagged internal and in another layer → **Violation** (`DependsOnInternalToken`) |
| −3 | `DependsOnPrivateLayer` | Target matched by a `private` collector of another layer → **Violation** (`DependsOnPrivateLayer`) |
| −100 | `AllowDependencyHandler` | → **Allowed** |

  Every violation passes through `addSkippableViolation`. If `skip_violations[depender] ∋ dependent`, it becomes **SkippedViolation**.
- **Multi-layer tokens:** a depender in N layers is evaluated once per layer, and a **Warning** (`tokenIsInMoreThanOneLayer`) is emitted once per token.
- **PostProcess:** every baseline entry that matched nothing becomes an **Error** ("Skipped violation … was not matched"). This is *stale-suppression detection*: the baseline can only shrink.
- Violation-creating rules expose `ruleName()` and `ruleDescription()`, so every finding says *why* it fired.

## 5. Result model and exit contract

Counters: **Violations, Skipped violations, Uncovered, Allowed, Warnings, Errors.**

`analyse` exits with code 1 if there are violations, if there are errors, or if `--fail-on-uncovered` is set and something is uncovered. It also exits with 1 on an analyser exception or an unknown formatter. Otherwise it exits with 0. There is a single failure code; the result kinds cannot be told apart by exit status.

Flags: `--formatter/-f`, `--output/-o`, `--no-progress`, `--report-uncovered`, `--fail-on-uncovered`, `--report-skipped`, `--config-file`, `--cache-file`, `--no-cache`.

## 6. Formatters (13 classes)

| Formatter | Purpose |
|---|---|
| `table` (default) | Grouped per layer with the rule name and reason, then a report table |
| `console` | One line per violation, e.g. `A::5 must not depend on B (L1 on L2)` |
| `github-actions` | `::error file=…,line=…::` annotations; selected automatically when `GITHUB_ACTIONS` is set |
| `json` | Report counters plus per-file messages (`error` or `warning`) |
| `junit` | One testsuite per layer and one testcase per class |
| `codeclimate` | GitLab Code Quality; severities configurable per kind (failure, skipped, uncovered) |
| `xml` | Generic XML |
| `baseline` | Writes the `skip_violations` YAML (`deptrac.baseline.yaml`) |
| `graphviz-display`, `-dot`, `-html`, `-image` | Layer graph: edge labels are dependency counts, and violation edges are red and labelled with the violation count |
| `mermaidjs` | Flowchart with `-->|count|` edges, groups as subgraphs, direction and node shape options |

Graph options: `hidden_layers` (analysed but not drawn) and `groups` (subgraphs). Graphviz also has `pointToGroups`: edges to a node named like its group point at the group, which renders a module's public API.

## 7. Debug and exploration commands

| Command | Answers | Notes |
|---|---|---|
| `debug:layer [layer]` | Which tokens are in this layer? | Table of tokens and their token type |
| `debug:token <token> [type]` | Which layers is this token in? | Ignores emitter configuration |
| `debug:unassigned` | Which tokens are in no layer? | **Exit 2** if any: a CI coverage gate |
| `debug:dependencies <layer> [target]` | Every concrete dependency from layer to layer, with file:line | Used to justify or remove a rule |
| `debug:unused [--limit=N]` | Allowances used zero times (or ≤ N times) | Finds dead or weak rules, candidates for tightening |
| `changed-files [--with-dependencies] <files…>` | Layers touched by these files, and which layers depend on them | Experimental; drives selective CI (run only the affected suites) |
| `init` | Generates a starter `deptrac.php` | Controller, Service and Repository template |

## 8. Configuration

- Formats: `deptrac.php` (typed builder API, now the default) or `deptrac.yaml`.
- `paths`, `exclude_files` (regex), `layers`, `ruleset`, `skip_violations`, `analyser.types`, `analyser.internal_tag`, `ignore_uncovered_internal_classes`, `formatters.*`, `feature_flags.phpstan_parser`, `cache_file`.
- `imports:` splits configuration across files, typically to keep the baseline separate.
- `parameters:` declares `%name%` substitution; built-ins are `%currentWorkingDirectory%`, `%projectDirectory%` and `%cache_file%`.
- `services:` registers Symfony DI services: custom collectors, emitters, extractors, formatters and event subscribers.
- **Multiple views:** several config files, each a different architectural view (bounded-context isolation, vendor confinement, naming conventions), possibly sharing imported layer definitions.

Deptrac dogfoods all of this: its own `deptrac.php` defines 15 layers, mostly directory collectors plus `composer` collectors for Symfony and Graphviz. One composer collector is `private()` (phpdocumentor/type-resolver may only be used by `Ast`). The ruleset has 12 entries, Graphviz and Mermaid groups are configured, and the baseline is imported. A custom event subscriber ignores dependencies on `Contract`.

## 9. Extension points (stable `Contract\` namespace, under the BC policy)

`ReferenceExtractorInterface` (AST node → reference), `ParserInterface` (replaces the parser), `DependencyEmitterInterface` (reference → dependency), `TokenResolverInterface` (a priority chain for custom token types), `CollectorInterface` (layer membership), `ProcessEvent`/`PostProcessEvent` subscribers (custom rules, implementing `ViolationCreatingInterface` for a name and description), `OutputFormatterInterface`, and `BaselineMapperInterface` (custom baseline storage).

## 10. Benefits to developers

1. **Architecture as code.** Layer and rule definitions are reviewed in PRs like any other code, and the architecture doc can't silently drift.
2. **Fast CI gate.** Violations fail the build at file:line with a named rule. Native GitHub and GitLab annotations put the finding inline in the PR.
3. **Gradual adoption on legacy code.** The baseline freezes existing debt and blocks new debt. Unmatched-baseline errors force the baseline to shrink as debt is paid.
4. **Encapsulation that PHP lacks.** PHP has no module visibility; `private` collectors and `@internal` tags add package-private semantics.
5. **Dependency hygiene.** The `composer` collector confines vendors (e.g. "only Infrastructure may touch Doctrine"), keeps `require-dev` packages out of production code and flags transitive-only packages.
6. **Communication.** Generated diagrams with counts and red violation edges show the actual architecture rather than the intended one.
7. **Rule maintenance.** `debug:unused` finds dead allowances, `debug:unassigned` finds code no layer covers, and `debug:dependencies` explains an edge.
8. **Change scoping.** `changed-files --with-dependencies` maps a diff to the impacted layers.

## 11. Limitations (MapX should do better)

| Limitation | Consequence | MapX opportunity |
|---|---|---|
| PHP only | Polyglot repos need one tool per language (ArchUnit, dependency-cruiser, import-linter, go-arch-lint, NetArchTest, …), each with its own configuration | One rule model over 22 languages |
| Static symbol-level dependencies only | No routes, DI container bindings, events, HTTP calls, message buses or DB relations | MapX already has `route`, `binding`, `dispatch`, `notify`, `hook`, `http` and `relation` edges |
| Single repository | No cross-repo rules (frontend ↛ admin API, service A ↛ service B DB) | MapX workspaces and cross-repo `http` edges |
| Layers are hand-written regexes | High setup cost; empty or wrong layers fail silently until `debug:unassigned` is run | MapX's role classifier, clusters and framework detectors can **propose** layers |
| One exit code for everything | CI can't tell violations from configuration errors | Distinct exit codes |
| No severity per rule | Every violation is equal (CodeClimate can only remap a severity per kind) | Per-rule severity and "warn" rules |
| No diff/ratchet mode besides the baseline | The baseline must be regenerated and committed | `--since <git-ref>`: only new violations fail |
| No metrics beyond counts | No instability, abstractness, cycles or DSM | MapX has metrics, DSM, Leiden clusters and smells |
| Reports are static | Graphviz images; no drill-down | MapX dashboard plus MCP for agents |
| No notion of confidence | A dependency the parser *guessed* is weighted like one it proved | MapX's `verified`/`inferred` verifiability |
| Superglobal and `function_call` coverage is opt-in and PHP-specific | | Generalise into an "ambient access" concept (env, globals, process) |
