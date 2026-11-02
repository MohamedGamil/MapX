# Architecture rules (in progress)

MapX is gaining Deptrac-style architecture rules for every language it indexes (milestone M5). You declare **layers** with **selectors**, and a **policy** of which layers may depend on which. `mapx check` will then report every dependency that breaks the policy. The design is in `docs/research/deptrac/02-abstract-feature-model.md`.

What exists so far:

- **The configuration document** (M5-02): its schema, loading, `extends`, parameters, views and validation.
- **The element view, the core selectors and layer membership** (M5-03).
- **Rule evaluation and the report** (M5-04): policy expansion, the evaluation chain, findings with fingerprints, and the layer matrix.
- **`mapx check`** (M5-05): the table and JSON reporters, and the exit contract. See [cli-reference.md](cli-reference.md#mapx-check).
- **`mapx arch validate-config`** and the MCP tool `mapx_arch_validate_config` (M5-02-R1): validate the configuration alone, without an index.

Baselines, CI reporters, introspection commands and `@internal` markers come in M5-06 to M5-11.

## The configuration document

Put the configuration in `.mapx/architecture.jsonc`. Views go in `.mapx/architecture/<view>.jsonc`, and a view name cannot lead outside that folder. The format is JSON with comments and trailing commas; a UTF-8 byte order mark is ignored. Point `$schema` at `schemas/architecture.schema.json`, which the npm package ships, for editor completion:

```jsonc
{
  "$schema": "./node_modules/@mgamil/mapx/schemas/architecture.schema.json",
  "extends": ["./architecture.base.jsonc"],
  "parameters": { "App": "App" },
  "layers": [
    { "name": "Controller", "selectors": [{ "path": "app/Http/Controllers/**" }] },
    { "name": "Domain", "selectors": [{ "name": "^%App%\\\\Domain\\\\", "kind": ["class", "interface", "enum"] }] },
    { "name": "Infrastructure", "selectors": [{ "path": "app/Infrastructure/**" }], "private": [{ "path": "app/Infrastructure/Db/**" }] }
  ],
  "rules": {
    "Controller": ["+Domain"],
    "Infrastructure": ["Domain"],
    "Domain": []
  }
}
```

**`extends`** takes relative files and `mapx:preset/<id>` presets; no presets ship yet. Documents load depth-first, so extended documents come before the one that extends them:

- a later document replaces a layer of the same name, which keeps its first position;
- rule lists are merged per source layer;
- other settings are overridden key by key.

**`%name%`** is replaced from the merged `parameters` in every string value of a selector: `path`, `name`, `package`, `repo`, `cluster`, `workspacePackage`, `role`, `language`, `framework` and the rest.

- **`name`, `path` and `package`:** a `%name%` without a value is an error.
- **Other keys:** only a declared parameter is replaced. Any other `%…%` stays as written, so a `docTag` value such as `"%s%s"` or a `member` regex such as `"/^%d%x$/"` means what it says.
- **`%%`** is a literal `%` in every key (`"^100%%"` is `^100%`).
- **A parameter value can name other parameters:** `"root": "%base%/app"`. Such a reference without a value is an error, and so is a cycle (`%a% → %b% → %a%`).
- **A `framework` part given as a parameter** is checked after it is replaced.

**Validation reports every problem at once.** Each problem names its file and a JSON pointer, in document order. Validation catches:

- unknown keys (a typo such as `"paht"`), wrong types, unknown edge types and symbol kinds;
- a selector with no primary key, or with several primary keys (combine those with `all`);
- an unknown layer in rules, `layer` selectors or report groups. It suggests the closest name: `did you mean "Http"?`;
- an overlay layer used as a rule source;
- `+` cycles, named: `"+" allowances form a cycle: Service → Repo → Service`;
- circular `extends`, a missing extended file, an `extends` naming a directory or a path that cannot be read (a symlink loop, no permission), an unknown preset, a parameter without a value or in a cycle, and a regular expression that does not compile;
- an empty view name, or a view outside `.mapx/architecture/` (by `..` or through a symlink).

`mapx arch validate-config` prints these problems and exits 3 when there are any; see [cli-reference.md](cli-reference.md#mapx-arch-validate-config). `mapx check` reports them the same way, also with exit 3.

## Elements and qualified names

Selectors match **elements**: every indexed file, and every symbol in it (classes, functions, methods and so on). A symbol's **qualified name** is how a `name` selector sees it:

| Language | Qualified name of `Order.run` | From |
| --- | --- | --- |
| PHP | `App\Domain\Order::run` | the file's `namespace` |
| Java, Kotlin, Scala | `com.acme.domain.Order.run` | the `package` declaration |
| C# | `Acme.Domain.Order.run` | the `namespace` declaration |
| Dart | `acme.domain.Order.run` | the library name |
| C++ | `acme::domain::Order::run` | the enclosing `namespace` blocks, nested or `a::b` |
| Go | `example.com/shop/domain.Order.Run` | `go.mod`'s module plus the package directory |
| Python | `app.domain.order.Order.run` | the module path from the package root (the nearest `pyproject.toml`, `setup.py` or `setup.cfg`, else the repo); `src/` and `__init__` are dropped |
| Rust | `crate::domain::order::Order::run` | the module path from the crate root (the nearest `Cargo.toml`); `lib.rs`, `main.rs` and `mod.rs` name their directory |
| Ruby | `Billing::Core::Invoice::pay` | module and class nesting, including compact `class Billing::Receipt` |
| Elixir | `Billing.Invoice.pay` | the enclosing `defmodule` |
| JavaScript, TypeScript, TSX, Vue, Svelte, Swift, C, Lua, Zig, Bash, Fish, Pascal, Markdown, HTML, CSS, JSON, YAML | `src/domain/Order.ts#Order.run` | the workspace-relative path |

A namespace language whose file declares no namespace (a PHP file with only functions, say) falls back to the path form. Kotlin's package is not captured yet, so Kotlin uses the path form.

In C++, Ruby and Elixir the nesting comes from the line ranges of the enclosing namespace, module and class symbols. A file in those languages can declare several namespaces, so the file's own qualified name is its path.

## Selectors

A selector object has exactly one primary key, plus the modifiers that refine it. An element is in a layer when **any** of the layer's selectors matches it.

| Selector | Matches | Evaluated on |
| --- | --- | --- |
| `path` | a glob (picomatch, dotfiles included) or `/regex/flags` on the workspace-relative path | the file |
| `name` (+ `kind`) | a regex on the qualified name: case-insensitive unless written `/…/flags`, optionally only these symbol kinds | symbols only |
| `repo` | a registered repo, by name or glob | the file |
| `language` | the file's language; `ts`, `js`, `py`, `c#` and the like are accepted, and `typescript` also matches `.tsx` files (`tsx` matches only those) | the file |
| `role` (+ `confidence`) | the MapX role of the file, optionally at a minimum classifier confidence | the file |
| `cluster` | a MapX cluster the file is in, by name or glob | the file |
| `workspacePackage` | the name in the nearest `package.json`, `composer.json`, `pyproject.toml`, `go.mod` or `Cargo.toml`, by name or glob | the file |
| `framework` | a framework part read from stored edges: `route-handler` (target of a `route` or `http` edge), `middleware`, `model` (source of a `relation` edge), `job` and `event` (targets of `dispatch`), `listener` (target of `notify`), `resolver`, `component` (target of `render`), `http-client` (source of `http`) | the file |
| `layer` | membership in another layer | the element |
| `all`, `any`, `not` | composition | |

**Symbol-level selectors on files.** A `name` selector does not apply to a file. It is not a match, and neither is `not` of it, so `{ "all": [{ "path": "app/**" }, { "not": { "name": "Controller$" } }] }` never puts a file in a layer by itself. The file joins the layer only through a top-level symbol that is in it (see Membership). `all`, `any` and `not` use three-valued logic. `all` is inapplicable when no branch fails and one is inapplicable. `any` is inapplicable when no branch matches and one is inapplicable. So `{ "not": { "any": [{ "name": "Controller$" }, { "path": "app/Legacy/**" }] } }` does not select a file either.

Not evaluated yet: these never match, `not` of them never matches either, and membership lists them as unsupported.

| Selectors | Task that adds them |
| --- | --- |
| `extends`, `implements`, `inherits`, `mixes`, `inheritanceDepth`, `member` | M5-09 |
| `decorator`, `docTag` | M5-10 |
| `package` | M5-24 (attribution M5-20 … M5-23) |
| `builtin` | M5-24 |
| `ambient` | M5-24 |

## Membership

- **Symbols.** A symbol is in the layers whose selectors match it. File-level selectors (`path`, `repo` and the like) judge a symbol by its file, so a `path` layer covers every symbol under its directory.
- **Files (AR-01).** A file is in the layers whose selectors match the file, plus the layers of its top-level symbols. A `name` layer can therefore single out one class of a multi-class file, and still claim the file for dependencies that only name the file. With `Controller` as `{ "name": "Controller$" }` and `Domain` as everything under `app/` except names ending in `Controller`, `app/Controller/OrderController.php` is in Controller only and `app/Domain/Order.php` is in Domain through `App\Domain\Order`.
- **Top-level symbols** are those declared at file level: not inside a type, and not a member. A declaration directly inside a C++ namespace or a Ruby module is still top-level. An Elixir module is a type, so its functions are members, while a nested `defmodule` is top-level.
- **No flow between symbols.** One symbol's layer never passes to another symbol.
- **Several layers.** An element in more than one non-overlay layer will get a `multi-layer` warning. A non-overlay layer that matches nothing will get an `empty-layer` warning.
- **Private parts.** A layer's `private` selectors mark the elements only that layer may reach. A file is private to a layer when its `private` selectors match the file or one of its top-level symbols.
- **Explanations.** Membership records why an element is in a layer: the selector position (`selectors[0].name`), and for a file the top-level symbol that put it there.
- **Caching.** Membership is computed once per scan and configuration.

## Rules

`rules` maps each non-overlay source layer to the layers it may depend on. Dependencies between different layers are denied unless allowed; dependencies within one layer are always allowed.

| Form | Meaning |
| --- | --- |
| `"L"` | may depend on L |
| `"+L"` | may depend on L, and on everything L may depend on, transitively |
| `"!L"` | may never depend on L |
| `"*"` | may depend on every non-overlay layer |
| `{ "allow": ["L"], "types": ["param_type"] }` or `{ "to": "L", "types": [...] }` | only over those edge types |
| `{ "allow": ["L"], "severity": "warn" }` | advisory: such dependencies are reported as warnings instead of errors |

A `"*"` key gives defaults to every source layer: `"*": ["Shared", "!Legacy"]`.

**Precedence.** `!` beats explicit allowances, which beat what `+` brings, which beats `*`. For one target, only the strongest form's allowances count, so an explicit `{ "to": "C", "types": ["import"] }` limits C to imports even if a `+` would bring C for calls. Allowances brought through `+` keep that `+`'s edge types and advisory severity. Each `+` path counts on its own, so the order of rules never matters.

## Evaluation

Each stored edge in `scope.types` (default: `import`, `require`, `extends`, `implements`, `call`, `instantiation`, `param_type`, `return_type`) is checked in this order. The first step that applies decides:

1. **Out of scope:** the edge is skipped when its source or target path fails `scope.include`/`scope.exclude`, when it is inferred and `policy.inferred` is `"ignore"`, or when both ends are the same element.
2. **No source layer:** the source is in no layer, so there is nothing to check.
3. **Then, once for each non-overlay layer of the source:**
   1. **Denied overlay:** the target is in an overlay layer the source layer denies (`"*": ["!Deprecated"]`). This is a `disallowed-layer` violation, whatever the target's other layers. Overlays matter only as denied targets: `*` and default-deny never involve them.
   2. **Uncovered:** the target is in no non-overlay layer.
   3. **Same layer:** every non-overlay layer of the target is the source layer. Nothing is recorded.
   4. **`disallowed-layer`:** one of the target's other layers is not allowed for this edge type, or is denied.
   5. **`private-layer`:** the target is private to a layer other than the source layer (a `private` selector).
   6. **Allowed.**

**Severity.** A violation is an `error`. It is a `warn` when the edge is inferred (under the default `policy.inferred: "warn"`) or when the pair is advisory. Uncovered dependencies are `warn`.

**Granularity.** Layers are decided on the finest element an edge names: the method, or the file for an import. An edge end names a symbol only when the file has exactly one symbol of that name; an import path names the file. A finding then names the top-level declaration: a method's dependency is reported on its class, even when the method is declared in another file of the class's namespace or package (Go, C# partial classes). An import is reported on the file's only top-level symbol, or on the file when it has several. So one class-to-class dependency is one finding per edge type, however many edges carry it. There are two exceptions:
- the target of an `http` or `route` edge stays the handler method;
- a Go import names a package, so its target is the package (its import path, with the layers of its directory's in-scope files). It is dropped when every importing file already has a finding of the same kind and rule on a type of that package.

## The report

`mapx check --format json` prints this report, described by `schemas/arch-report.schema.json`. It comes from `runArchitecture(dir)` in `src/arch/report.ts`. Uncovered, skipped and allowed findings are listed only with `--report-uncovered`, `--report-skipped` or `--report-allowed`; `counts` always includes them:

- **`findings`:** one per dependency, edge type and rule. A source in several layers gets one finding whose `source.layer` lists them. Each has a `kind` (`violation`, `uncovered`, `allowed`, `warning`, `error`; `skipped` arrives with baselines), a `rule`, a `severity`, the `source` and `target` (element, file, layer, repo, first line), the `edgeType`, `verifiability`, the number of `edges` it stands for, a `fingerprint` and a `message`.
- **`fingerprint`:** a hash of the rule, both elements and the edge type, with no line number, so it survives edits that move code.
- **Warnings:**
  - `multi-layer`, for a top-level declaration in several non-overlay layers. It is an error under `policy.strictLayers`. A symbol-less file gets one only when it is a dependency end;
  - `empty-layer`, for a non-overlay layer that matches nothing;
  - `unsupported-selector`, for a selector this version cannot evaluate yet. It matches nothing.
- **Errors:** an invalid configuration gives `error` findings, `plus-cycle` for a `+` cycle (naming its first layer) and `config` for the rest.
- **`layers`:** elements and files per layer.
- **`layerEdges`:** allowed and violating dependencies per layer pair.
- **`counts`:** per kind.

A workspace with a configuration but no index is an error (`run mapx scan first`), never an empty report.
