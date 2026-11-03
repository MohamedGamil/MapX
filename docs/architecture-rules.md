# Architecture rules

MapX checks Deptrac-style architecture rules for every language it indexes (milestone M5). You declare **layers** with **selectors**, and a **policy** of which layers may depend on which. `mapx check` reports every dependency that breaks the policy, in a format your CI reads, and exits non-zero when one does. The design is in `docs/research/deptrac/02-abstract-feature-model.md`. MapX checks its own source this way: see [MapX's own rules](#mapxs-own-rules).

## Quick start

Take a small TypeScript shop with four folders under `src/`: `controller`, `domain`, `infra` and `shared`. Declare one layer per folder and what each may use, in `.mapx/architecture.jsonc`:

```jsonc
{
  "layers": [
    { "name": "Controller", "selectors": [{ "path": "src/controller/**" }] },
    { "name": "Domain", "selectors": [{ "path": "src/domain/**" }] },
    { "name": "Infrastructure", "selectors": [{ "path": "src/infra/**" }] },
    { "name": "Shared", "selectors": [{ "path": "src/shared/**" }] }
  ],
  "rules": {
    "*": ["Shared"],                     // every layer may use Shared
    "Controller": ["+Domain"],           // Domain, and whatever Domain may use
    "Infrastructure": ["Domain"],
    "Domain": []
  }
}
```

Index the code, then check it:

```
$ mapx init && mapx scan
$ mapx check
Controller
  ✖ disallowed-layer [error]  src/controller/OrderController.ts#OrderController → src/infra/SqlOrderRepository.ts#SqlOrderRepository (import)
      src/controller/OrderController.ts:2  src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure)
  ✖ disallowed-layer [error]  src/controller/OrderController.ts#OrderController → src/infra/SqlOrderRepository.ts#SqlOrderRepository (instantiation)
      src/controller/OrderController.ts:7  src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure)

Violations: 2 (2 error, 0 warn)   Uncovered: 0   Skipped: 0   Allowed: 12   Warnings: 0   Errors: 0
$ echo $?
1
```

To adopt the rules on code that already breaks them, freeze today's violations in a baseline; only new ones fail from then on:

```
$ mapx check --generate-baseline
Wrote 2 baseline entries to .mapx/architecture.baseline.json.
$ mapx check
Violations: 0 (0 error, 0 warn)   Uncovered: 0   Skipped: 2   Allowed: 12   Warnings: 0   Errors: 0
```

`mapx arch init` writes a first configuration for you (see [Getting started](#getting-started-mapx-arch-init)). The examples on this page use this shop; each was run against the CLI.

## What is in it

The features, by the task that delivered them:

- **The configuration document** (M5-02): its schema, loading, `extends`, parameters, views and validation.
- **The element view, the core selectors and layer membership** (M5-03).
- **Rule evaluation and the report** (M5-04): policy expansion, the evaluation chain, findings with fingerprints, and the layer matrix.
- **`mapx check`** (M5-05): the table and JSON reporters, and the exit contract. See [cli-reference.md](cli-reference.md#mapx-check).
- **`mapx arch validate-config`** and the MCP tool `mapx_arch_validate_config` (M5-02-R1): validate the configuration alone, without an index.
- **Baselines and the `--compare` ratchet** (M5-06): see [Baselines and the ratchet](#baselines-and-the-ratchet). They are CLI only: `mapx_arch_check` applies the configuration's baseline but cannot generate one or compare.
- **Introspection** (M5-08): `mapx arch layers`, `which`, `unassigned`, `deps`, `unused`, `changed` and `allowed`. See [Introspection](#introspection).
- **CI reports** (M5-07): `--format sarif`, `github` (automatic inside GitHub Actions), `codeclimate` and `junit`. See [CI reports](#ci-reports).
- **MCP tools** (M5-14, AR-19): `mapx_arch_check`, `mapx_arch_layers`, `mapx_arch_allowed`, `mapx_arch_explain` and `mapx_arch_init` wrap `mapx check` and the introspection functions. See [mcp-integration.md](mcp-integration.md#architecture-rules-ar-19).
- **Layer graphs** (M5-13): `mapx arch graph --format dot|svg|mermaid|dsm|json`. See [Layer graphs](#layer-graphs). CLI only: no MCP tool draws the graph yet.
- **Hierarchy and member selectors, and inherited dependencies** (M5-09): `extends`, `implements`, `inherits`, `mixes`, `inheritanceDepth`, `member`, and `policy.inheritDependencies`. See [Type hierarchy and members](#type-hierarchy-and-members).
- **Smells from the rules** (M5-16, AR-18): with a configuration, `mapx_smells`, `mapx arch` and the dashboard take their layer violations from the rules and gain the smells the rules make possible. See [Smells](#smells).
- **`mapx arch init` and the first presets** (M5-17, AR-15): a starting configuration inferred from roles or clusters, or from a shipped preset, with an optional baseline. See [Getting started: `mapx arch init`](#getting-started-mapx-arch-init) and [Presets](#presets).
- **Decorators and doc tags** (M5-10): the `decorator` and `docTag` selectors. See [Decorators and doc tags](#decorators-and-doc-tags).
- **Private parts and internal elements** (M5-11): `private` selectors, `@internal` doc tags and native module visibility. See [Visibility](#visibility).

Not there yet: the dashboard's Architecture view (M5-15), and ambient access other than Go's cgo `C` (see [External dependencies](#external-dependencies-packages-built-ins-ambient-access)).

Where to look up each part:

| Part | Section |
| --- | --- |
| Selectors | [Selectors](#selectors) |
| Rules | [Rules](#rules) |
| Scope and policy | [Scope and policy](#scope-and-policy) |
| Private parts and `@internal` | [Visibility](#visibility) |
| Reporters | [Reporters](#reporters) and [CI reports](#ci-reports) |
| Exit codes | [Exit codes](#exit-codes) |
| Baselines and `--compare` | [Baselines and the ratchet](#baselines-and-the-ratchet) |
| Layer graphs | [Layer graphs](#layer-graphs) |
| Smells | [Smells](#smells) |
| Questions about the configuration | [Introspection](#introspection) |
| MCP tools | [MCP tools](#mcp-tools) |

## Getting started: `mapx arch init`

`mapx arch init` proposes a configuration from the index, for you to review before relying on it (AR-15). It is a dry run unless you pass `--write`, and it never writes over an existing configuration or baseline without `--force`. The MCP tool `mapx_arch_init` runs the same engine. Options and output are in [cli-reference.md](cli-reference.md#mapx-arch-init).

1. **Map MapX roles to layers** (`--from roles`, the default). There is one layer per role the scan assigned, in the archetype's `LAYER_ORDER`, and each may depend on the layers after it. `--from clusters` makes one layer per primary cluster instead.
2. **Or start from a preset** (`--preset <id>`, or `--from framework` for the detected framework's preset). The configuration `extends` the preset and sets its folder parameter, inferred from the indexed paths.
3. **Read the observed layer graph** in the comments: for each layer, its files and the dependencies on other layers the index has today, and which of them the rules refuse. With `--from clusters`, the rules allow exactly today's graph.
4. **Make day one green** with `--baseline`: today's violations go to `.mapx/architecture.baseline.json`, so `mapx check` exits 0 until a new one appears (see [Baselines and the ratchet](#baselines-and-the-ratchet)).
5. **Packages are covered.** When the index has references to packages outside the workspace, every proposal (every `--from` source and every preset) adds a `Packages` layer, `{ "package": "*" }`, which every layer may use (`"*": ["Packages"]`). Without it, `mapx check` reports each dependency on a package as uncovered (`policy.uncovered.externals`), and a baseline cannot skip an uncovered dependency, so `--fail-on-uncovered` would fail on day one. The layer holds dev-only and unattributed packages too; the `dev-dependency-in-prod` smell reports production code that uses a dev-only one. Narrow it, or split it into vendor layers, as the rules tighten (see [External dependencies](#external-dependencies-packages-built-ins-ambient-access)).

```bash
mapx arch init --preset laravel            # look at the proposal
mapx arch init --preset laravel --baseline --write
mapx check                                 # exit 0; new violations fail
```

## Presets

A preset is a shipped document, `mapx:preset/<id>`, that a configuration extends. Its source is `src/arch/presets/<id>.jsonc`, with a comment on each layer. A configuration that extends a preset can override its parameters, replace a layer by declaring one of the same name, and add layers and rules:

```jsonc
{
  "extends": "mapx:preset/clean",
  "parameters": { "root": "src/" },
  "layers": [
    // replaces the preset's Infrastructure layer: this codebase calls the folder infra/
    { "name": "Infrastructure", "selectors": [{ "path": "src/infra/**" }] },
    { "name": "Shared", "selectors": [{ "path": "src/shared/**" }] }
  ],
  "rules": { "*": ["Shared"] }
}
```

```
$ mapx arch layers
Layer           Elements  Files
Domain                20      7
Application            0      0
Adapters               3      1
Infrastructure         6      2
Shared                 9      3
```

| Preset | Layers | Rules | Parameter |
|---|---|---|---|
| `layered` | Presentation, Business, Persistence, Common (by folder name under `root`) | each layer on the one below and on Common | `root`, default `src/` |
| `clean` | Domain, Application, Adapters, Infrastructure | inward only; Domain on nothing | `root`, default `src/` |
| `hexagonal` | Domain, Application (use cases and ports), Adapters | Adapters on Application and Domain; Application on Domain | `root`, default `src/` |
| `ddd-contexts` | SharedKernel; the configuration declares one layer per context (`mapx arch init` adds one per folder under `root`) | `"*": ["SharedKernel"]`: a context never depends on another | `root`, default `src/` |
| `feature-sliced` | App, Processes, Pages, Widgets, Features, Entities, Shared | strictly top-down | `root`, default `src/` |
| `laravel` | Routes (`routes/` but `console.php`), Http (also route handlers and middleware outside `app/Http`, routed actions aside), Console (with `routes/console.php`), Providers, Jobs, Events, Listeners, Services (`Services`, `Actions`, `Domain`), Models (also classes with relations), Views, Database | Models, Jobs, Listeners and Providers never on Http. Routes on Http, Services (invokable actions) and Models (route-model binding, channel authorisation); Listeners on Events; Console on Jobs and Models (the Laravel 11 scheduler). Idiomatic Laravel 11 passes clean | `root`, default `""` (artisan at the repo root) |
| `nestjs` | Module, Controller, Enhancer (guards, interceptors, pipes, filters, middleware, strategies), Provider, Dto, Entity, by file-name suffix and `@Module`/`@Controller` | Controller on Enhancer, Provider and Dto only; Entity on nothing | none |
| `django` | Urls, Views, Admin, Commands, Forms, Serializers, Migrations, Models, by module name in any app | Models on nothing; Urls on Views | none |

Limits of this first wave:
- Presets select by path, file name, decorator and framework part. They do not use the hierarchy selectors (`extends`, `implements`, `inherits`) yet, so a Laravel model outside `app/Models` with no relation is not in Models unless your configuration adds an `inherits` selector to that layer.
- `feature-sliced` does not forbid imports between slices of one layer, and `ddd-contexts` has no "only through Contracts" exception: both need a layer per slice or private selectors, which you can add.
- A preset layer that matches nothing on your code is an `empty-layer` warning, not an error. `mapx arch init` warns when most layers are empty. It refuses to write a proposal whose every layer is empty (exit 3) unless you pass `--force`, since such a configuration checks nothing.
- Laravel's Mail, Notifications, Policies and Enums folders are in no layer: dependencies on them are uncovered, never violations.
- An inferred `root` is written as a literal glob. Glob characters in the folder name are escaped (`svc (v2)/` becomes `svc \(v2\)/`), and `%` is doubled.

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

**`extends`** takes relative files and `mapx:preset/<id>` presets (see [Presets](#presets)). Documents load depth-first, so extended documents come before the one that extends them:

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
- a `visibility.internalTags` entry that is not a doc tag (`"@internal"` and `"internal"` are; `"not a tag"` is not);
- circular `extends`, a missing extended file, an `extends` naming a directory or a path that cannot be read (a symlink loop, no permission), an unknown preset, a parameter without a value or in a cycle, and a regular expression that does not compile;
- an empty view name, or a view outside `.mapx/architecture/` (by `..` or through a symlink).

`mapx arch validate-config` prints these problems and exits 3 when there are any; see [cli-reference.md](cli-reference.md#mapx-arch-validate-config). `mapx check` reports them the same way, also with exit 3.

## Elements and qualified names

Selectors match **elements**: every indexed file, and every symbol in it (classes, functions, methods and so on). A symbol's **qualified name** is how a `name` selector sees it:

| Language | Qualified name of `Order.run` | From |
| --- | --- | --- |
| PHP | `App\Domain\Order::run` | the file's `namespace` |
| Java, Kotlin, Scala | `com.acme.domain.Order.run` | the `package` declaration (Scala: also nested and chained packages) |
| C# | `Acme.Domain.Order.run` | the enclosing `namespace` blocks (a file can hold several), or the file-scoped `namespace` |
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

**`.h` headers** are C unless the header itself is plainly C++. That means C++-only syntax outside every preprocessor conditional: `namespace X {`, a `class X {` or `class X :` declaration, `template <`, an access label such as `public:`, `using namespace`, or `extern "C++"`. Comments and strings don't count, and neither does anything inside `#if`, `#ifdef`, `#ifndef`, `#elif` or `#else` (for example, `#ifdef __cplusplus` glue). An include guard around the whole file is not a conditional. A C header keeps the path form.

**C# and Scala** take each declaration's namespace from the syntax tree:
- A file with namespace blocks `A` and `B` gives `A.X` and `B.Y`, even when the blocks share one line.
- `package a { package b { class X } }` gives `a.b.X`, and chained `package com.acme` then `package domain` give `com.acme.domain.Order`.
- A C# type outside every block is in the global namespace, so it uses the path form.
- The file's own qualified name is its first namespace.

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
| `decorator` | a decorator, attribute or annotation of the symbol, by name or trailing segments, or `/regex/flags` (see below) | symbols only |
| `docTag` (+ `value`) | a doc-block tag of the symbol, such as `@deprecated`, optionally with a value matching a regex (see below) | symbols only |
| `extends`, `implements`, `inherits`, `mixes` | an ancestor of the type, transitively, by name or trailing segments, or `/regex/flags` (see [Type hierarchy and members](#type-hierarchy-and-members)) | types only |
| `inheritanceDepth` | a type whose longest chain of bases is at least this long | types only |
| `member` | a type with an own member whose name matches a regex | types only |
| `layer` | membership in another layer | the element |
| `all`, `any`, `not` | composition | |

**Symbol-level selectors on files.** A `name`, `decorator`, `docTag` or hierarchy selector does not apply to a file. It is not a match, and neither is `not` of it, so `{ "all": [{ "path": "app/**" }, { "not": { "name": "Controller$" } }] }` never puts a file in a layer by itself. The file joins the layer only through a top-level symbol that is in it (see Membership). `all`, `any` and `not` use three-valued logic. `all` is inapplicable when no branch fails and one is inapplicable. `any` is inapplicable when no branch matches and one is inapplicable. So `{ "not": { "any": [{ "name": "Controller$" }, { "path": "app/Legacy/**" }] } }` does not select a file either.

The `package`, `builtin` and `ambient` selectors select what the workspace uses from outside itself: see [External dependencies](#external-dependencies-packages-built-ins-ambient-access).

One example of each selector, on the shop. The decorator, doc tag and hierarchy selectors have their own examples below. All of these are layers of one valid configuration, here the view `.mapx/architecture/selectors.jsonc`; `mapx arch which <element>` shows which of them an element is in, and why:

```jsonc
"parameters": { "src": "src" },
"layers": [
  { "name": "Http",        "selectors": [{ "path": "%src%/controller/**" }] },                // a glob, with a parameter
  { "name": "Infra",       "selectors": [{ "path": "/^src\\/infra\\//" }] },                  // a /regex/ on the path
  { "name": "Ports",       "selectors": [{ "name": "Repository$", "kind": ["interface"] }] }, // interfaces named …Repository
  { "name": "Backend",     "selectors": [{ "repo": "backend-*" }] },                          // a registered repo, by glob
  { "name": "TypeScript",  "selectors": [{ "language": "ts" }] },
  { "name": "Data",        "selectors": [{ "role": "data", "confidence": 0.2 }] },           // MapX role, at least 20% confident
  { "name": "DomainPkg",   "selectors": [{ "cluster": "src.domain" }] },                      // a cluster from `mapx clusters`
  { "name": "Shop",        "selectors": [{ "workspacePackage": "shop" }] },                   // "name" in the nearest package.json
  { "name": "Handlers",    "selectors": [{ "framework": "route-handler" }] },                // route targets (none in the shop)
  { "name": "NotShared",   "selectors": [{ "all": [{ "path": "src/**" }, { "not": { "path": "src/shared/**" } }] }] },
  { "name": "Either",      "selectors": [{ "any": [{ "path": "src/shared/**" }, { "name": "^src/domain/Clock" }] }] },
  { "name": "AlsoInfra",   "selectors": [{ "layer": "Infra" }], "overlay": true }             // whatever is in Infra
]
```

```
$ mapx arch which SqlOrderRepository --view selectors      # the shop is the repo "backend-shop"
src/infra/SqlOrderRepository.ts#SqlOrderRepository (class, src/infra/SqlOrderRepository.ts)
  Infra  ← selectors[0].path
  Backend  ← selectors[0].repo
  TypeScript  ← selectors[0].language
  Data  ← selectors[0].role
  Shop  ← selectors[0].workspacePackage
  NotShared  ← selectors[0].all
  AlsoInfra  ← selectors[0].layer
```

**Layer keys.** Besides `name` and `selectors`, a layer takes `private` (see [Visibility](#visibility)), `overlay` (a layer that is only ever a rule target, such as `Deprecated`; it never makes an element `multi-layer` or covered), `description`, and `group` and `color` for [layer graphs](#layer-graphs):

```jsonc
{ "name": "Deprecated", "description": "Code on its way out", "overlay": true, "color": "#f59e0b", "selectors": [{ "docTag": "@deprecated" }] }
```

### Decorators and doc tags

A scan stores each symbol's decorators, attributes or annotations, and its doc-block tags, for PHP, TypeScript, JavaScript (with Vue and Svelte script blocks), Python, Java, Kotlin and C#, and the doc tags of Go symbols. Other languages store none yet, so these selectors never match their symbols.

| Language | Decorators | Doc tags |
| --- | --- | --- |
| PHP | `#[Attr]`, `#[Attr(…)]`, several per group. The name is resolved like a class name, through `use` and the namespace (`#[ORM\Entity]` → `Doctrine\ORM\Mapping\Entity`), and the name as written is kept too when it differs (`ORM\Entity`, an alias) | PHPDoc `/** … */` block tags, Doctrine-style `@Route(…)` included |
| TypeScript, JavaScript | `@dec`, `@dec(…)`, `@a.b` on classes (before or after `export`), methods, fields and accessors | JSDoc/TSDoc block tags; a function's overload signatures give theirs to the implementation |
| Python | `@dec`, `@dec(…)`, `@app.route(…)` on `def` and `class` | docstring directives (`.. deprecated:: 2.0`) and `@tag` lines |
| Java, Kotlin | `@Ann`, `@Ann(…)`, `@a.b.Ann`, each of Kotlin's `@[A B]` | Javadoc and KDoc block tags |
| C# | `[Attr]`, `[Attr(…)]`, several per list; not `[return: …]`, `[param: …]`, `[field: …]` and other targets that name something else | XML doc `///` elements, as `@remarks`, `@param` and so on; `<summary>` is the description and `<code>` a sample, neither a tag |
| Go | none | the doc comment: the `//` (or `/* */`) comments directly above the declaration, each on its own line, with no blank line between (a detached or trailing comment is not documentation). `@tag` lines, and the `Deprecated:` paragraph as `@deprecated`; a value ends at the next tag or the end of its paragraph, and indented lines are code, never tags. In a `type ( … )` group, each spec's own comment |

A block tag starts a line of the doc comment (after the leading `*`), so an inline `{@link X}` is not a tag. Its value runs to the next tag. Decorator names keep their qualifier as written (`app.route`, `System.Obsolete`), except in PHP, where they are fully qualified. Parameter decorators are not stored. Comments between decorators, or between the doc comment and the declaration (`// eslint-disable-next-line`), are passed over; code is not.

**Code samples are never tags.** These are text:
- lines in a ```` ``` ```` fence, a `<pre>…</pre>` block or a multi-line `{@code …}`;
- everything after `@example`, which is that tag's value to the end of the comment (so put `@example` last);
- C# `<code>`;
- in a Python docstring, a literal block (the lines indented under a paragraph ending in `::`) and doctest examples (from `>>>` to the next blank line).

**A doc comment starts its own line.** A trailing comment documents the code before it, never the next declaration: in `type Legacy struct{} // @internal`, `int count; /** @internal */` or `x = 1; /** @internal */`, the next declaration gets no tag. The same holds for C# `///`.

**A doc comment attaches to the next declaration, even across blank lines,** as TypeScript and Javadoc tooling do (Go: only directly above). A file-header block (`/** @license MIT */` or `/** @internal */` at the top of a file) therefore becomes the first declaration's tags. Keep `@internal` and similar markers out of file headers, or the first class of the file is marked.

- **`decorator`.** A plain value matches a stored decorator, ignoring case, when:
  - it equals the decorator's name, or is a suffix of it on a namespace boundary (`\` or `.`). `Entity` and `Mapping\Entity` match `Doctrine\ORM\Mapping\Entity`; `tity` does not.
  - in PHP, the same holds for the name as written. `ORM\Entity` (with `use Doctrine\ORM\Mapping as ORM`) matches, and so does an alias such as `Baz` in `use Foo\Bar as Baz`.
  - outside PHP, where names are stored as written, the stored name is such a suffix of the value. `System.Obsolete` matches `[Obsolete]`, and `javax.persistence.Entity` matches `@Entity`. These languages cannot tell two libraries' `@Entity` apart.

  A leading `@`, `\` or `#[` in the value is ignored. In C#, `X` and `XAttribute` match each other, so `Obsolete` matches `[System.ObsoleteAttribute]`. A value written `/…/flags` is a regex on the stored name and on the name as written.
- **`docTag`, with optional `value`.** The symbol has the tag; the `@` is optional and case is ignored. With `value`, one occurrence of the tag has a value matching the regex (case-insensitive unless written `/…/flags`). In Python a `@deprecated` decorator (`@deprecated`, `@typing_extensions.deprecated("…")`) counts as the `@deprecated` tag, with its arguments as the value.
- **Overloads.** Overloads that are symbols (Java, C#, TS class methods) share one element, which carries the decorators and tags of them all. TS function overload signatures are not symbols, so their doc tags are stored on the implementation.

```jsonc
{ "name": "Controllers", "selectors": [{ "decorator": "Controller" }] },
{ "name": "Entities",    "selectors": [{ "decorator": "Doctrine\\ORM\\Mapping\\Entity" }] },
{ "name": "Deprecated",  "selectors": [{ "docTag": "@deprecated" }], "overlay": true },
{ "name": "BillingAPI",  "selectors": [{ "docTag": "@internal", "value": "^billing" }] }
```

### Type hierarchy and members

The hierarchy selectors judge a type (a class, interface, trait, struct, enum or module symbol) by its ancestry. A member of a type (a method, property, field or constant) is judged by its type, as `path` judges a symbol by its file, so a layer `{ "extends": "Eloquent\\Model" }` holds the models' methods too, and a dependency a method has is checked. Another symbol never matches, and a file is inapplicable, as for `name`.

**Where ancestry comes from.** A type's direct bases are:
- the stored `extends` and `implements` edges, for bases the index resolved to a workspace type;
- the base list its declaration's first line names, for bases outside the index. Each is named through what the file records: PHP name resolution (`use`, else the file's namespace: `Model` after `use Illuminate\Database\Eloquent\Model;` is that class, and a bare `P` in namespace `App` is `App\P`), a TS or JS import (`sequelize#Model`, the module and the name), a Python import (`models.Model` after `from django.db import models` is `django.db.models.Model`), or a Java, Kotlin or Scala `import` line (`org.springframework.data.jpa.domain.AbstractPersistable`). Otherwise the base keeps the name as written, generics dropped. A base so qualified that names a workspace type links to it;
- mixins: the traits a PHP class, trait or enum uses (`use HasUuid;`, resolved like class names), and Scala and Dart `with` clauses.

**What the file says wins over a same-named class.** The index may link a base to a workspace class only because the names match: `import { Model } from 'sequelize'` with a local `src/Model.ts`, `from django.db import models` with a local `Model`, or a Java import of Spring's `AbstractPersistable` with a local one. When the file's import says the base is outside the workspace, or the language's name resolution (PHP `use` and namespace, a JVM `import`) names another qualified name, the declared base is the ancestor and the edge is not followed. A base the file does resolve to the local class (`import { Model } from './Model'`) stays linked to it. A Kotlin type's qualified name is its path, so a Kotlin edge is never overruled.

The base list is read for PHP, TypeScript and JavaScript, Python, Java, Kotlin, Scala, Dart, C#, Swift and Ruby. Kotlin tells a superclass by its constructor call (`Base()`); C# and Swift take the first base of a class as its superclass, except a C# `IName`. Python and Ruby bases are all `extends`, and an interface's bases are `extends` in every language, whatever kind the index stored (Kotlin and C# store `interface B : A` as implements). Go embedding is stored as `extends` and counts as such; Go's structural interfaces, Ruby `include`, Rust `impl Trait for` and C++ base lists are not read.

**Closure.** Ancestry is transitive. A base outside the index is a leaf: nothing is known of its own bases, so `extends Model` matches a class two levels below `Eloquent\Model` only through a workspace base in between. A cycle (`class A extends B`, `class B extends A`: invalid code, valid input) is cut: every type is visited once per kind of path, and a type is never its own ancestor. The search keeps, for each ancestor reached, only the step it was reached from, so memory grows with the number of ancestors, not with the length of their paths; a path is rebuilt only when it is shown.

| Selector | Matches a type with an ancestor … |
| --- | --- |
| `extends` | reached through `extends` hops only (a class's superclasses, an interface's parent interfaces) |
| `implements` | reached through a path with an `implements` hop: an interface it implements, a parent of one, or one a superclass implements |
| `mixes` | reached through a path whose last hop is a mixin: a trait it uses, or one a base uses. A used trait is not `extends` |
| `inherits` | reached through any path |

**Values.** An ancestor value is a name or its trailing namespace segments, case-insensitive: `Model`, `Eloquent\Model` and `Illuminate\Database\Eloquent\Model` all match `Illuminate\Database\Eloquent\Model`, and `sequelize#Model` matches the TS base above (segments split at `\`, `.`, `#`, `/` and `::`). A base outside the index known only as written (no import qualified it) also matches a qualified value it ends: `org.acme.Base` matches `Base`. `/regex/flags` tests the ancestor's qualified name.

**`inheritanceDepth: N`** matches a type whose longest chain of bases is at least N long. A base outside the index counts as one level. Depth is computed once for all types, over the strongly connected components of the base graph: the types of a cycle count once each, so in `A extends B extends A` each has depth 1. Within a cycle this is an upper bound when no single chain passes through all of its types. The explanation shows a longest chain found from the type, never revisiting a type.

**`member: "regex"`** matches a type with an own member (method, property, field, constant) whose name matches the regex, case-insensitive unless written `/…/flags`. A PHP property's `$` is optional. Inherited members do not count.

**Explanations.** A hierarchy match records its chain, from the type to the ancestor that matched (for `inheritanceDepth`, the longest chain; for `member`, the type and the member). `mapx arch which` and `mapx arch layers <layer> --why` show it: `Domain  ← selectors[0].extends: App\Domain\Order → App\Support\BaseModel → Illuminate\Database\Eloquent\Model`, and with `--format json` it is `chain` in the trace entry or member.

```jsonc
{ "name": "Models",   "selectors": [{ "extends": "Eloquent\\Model" }] },
{ "name": "Payables", "selectors": [{ "implements": "Payable" }] },
{ "name": "Deep",     "selectors": [{ "inheritanceDepth": 4 }], "overlay": true },
{ "name": "Handlers", "selectors": [{ "all": [{ "path": "src/**" }, { "member": "^handle$" }] }] }
```

**Inherited dependencies (AR-02).** With `"policy": { "inheritDependencies": true }`, a type also answers for the dependencies of its workspace ancestors, through every kind of hop. Each is decided again with the type as source, by the same [evaluation](#evaluation) chain and the type's own layers. Its finding carries `via`, the inheritance path from the type to the ancestor that has the dependency, and its message ends `inherited via App\Domain\Order → App\Support\BaseModel`. A dependency is derived once per type, target and edge type, through the shortest path. It is not derived when the type has it itself, or the type's file does (an import in a file with several types belongs to the file; that finding has no `via`), nor when its target is the type or one of its own ancestors (that is the inheritance itself, decided where it is declared). An inherited finding has no line: its edge is in the ancestor's file. A `via` longer than eight names shows the first five and the last two around one `… N more …` entry. The default, `false`, derives nothing.

<!-- M5-24: external dependencies. A section of its own. -->
## External dependencies: packages, built-ins, ambient access

A scan records every reference to something outside the workspace (the `external_refs` view). It also records what each reference belongs to: a package of npm, Composer, pypi or Go modules, the language's standard library or runtime (a built-in), or ambient access. For each package it records whether the manifest lists it directly and whether it is dev-only. The rules see these as **external elements**. There is one per ecosystem and name: the package (`pg`, `guzzlehttp/guzzle`, `golang.org/x/sys`), a built-in's package (`node:fs`, `ext-pdo`, `python:os`, `net/http`), or for a package no manifest or lockfile provides, the name as written (`Acme\Missing\Widget`). A package that is a direct dependency for one file and a transitive one for another is two elements of the same name.

| Selector | Matches |
| --- | --- |
| `package` (+ `dev`, `direct`) | A package by name: `"pg"`, `"guzzlehttp/*"`, `"@acme/*"`, `"*"`. A package no manifest or lockfile provides is matched by its name as written (`github.com/pkg/errors`), so `"*"` covers every package. With `dev: true`, only dev-only packages; with `dev: false`, only production ones. With `direct: true`, only packages a manifest lists directly; with `direct: false`, only transitive ones and those no manifest lists. A package whose status is unknown (no lockfile says) matches neither value. |
| `builtin` | A built-in: `true`, or a name such as `"node:*"`, `"ext-pdo"`, `"python:os"`, `"net/http"` |
| `ambient` | Ambient access: `true`, or a name. Today the scan records only Go's cgo `C`. Process-global access such as `process.env`, `$_GET` or `os.environ` is not extracted yet. |

- **Names.** In these names `*` matches any run of characters, `/` included, because package names are not paths. `/regex/flags` is a regular expression. Names compare as their ecosystem compares them: npm, Composer, built-ins and ambient names ignore case; a pypi package name is normalised as PEP 503 says (case, and each run of `-`, `_` and `.` as one `-`), so `"Flask_SQLAlchemy"` and `"zope.interface"` match `flask-sqlalchemy` and `zope-interface`; a Go module or package path is exact.
- **Where they apply.** These selectors match external elements only. On a file or symbol they are inapplicable, like `name` on a file. Conversely, nothing but these selectors and `layer` applies to an external element. So `{ "not": { "path": "src/**" } }` never selects a package, and `{ "not": { "package": "*" } }` never selects a file.
- **Membership.** An external element is a member of the layers whose selectors match it. A vendor layer is therefore not an `empty-layer`, and its `files` count is 0. A layer's `private` selectors can name packages, which makes a package private to that layer.
- **No multi-layer warning.** An external element in several layers gets no `multi-layer` warning. Each of its layers is decided, as for any target.

**Evaluation.** Each recorded reference whose source file is in scope (`scope.include`, `scope.exclude`) and of a type in `scope.types` is decided like an edge whose target is the external element (the [evaluation](#evaluation) chain). The reference kind (`import`, `require`, `call`, `instantiation`, `extends`, `param_type` …) is the edge type. A target in no non-overlay layer is uncovered only as `policy.uncovered` says:
- `externals` (default `true`) for packages, including those no input provides;
- `builtins` (default `false`) for built-ins and ambient access.

A finding's target names the external (`"element": "pg"`, an empty `file`) and carries `external`: `{ ecosystem, origin, package, direct, dev }`. `origin` is `package`, `builtin` or `ambient`. External dependencies are not inherited under `policy.inheritDependencies`.

**Vendor confinement.** A layer of a package, and rules that let only some layers use it:

```jsonc
{
  "layers": [
    { "name": "Domain", "selectors": [{ "path": "src/domain/**" }] },
    { "name": "Infrastructure", "selectors": [{ "path": "src/infrastructure/**" }] },
    { "name": "Database", "selectors": [{ "package": "pg" }] },
    // Every dev-only package, denied to every layer: production code must not use them.
    { "name": "DevOnly", "overlay": true, "selectors": [{ "package": "*", "dev": true }] }
  ],
  "rules": { "*": ["!DevOnly"], "Domain": [], "Infrastructure": ["Domain", "Database"] }
}
```

Here `src/domain/Order.ts` importing `pg` is a `disallowed-layer` violation (`Domain on Database`), and importing `lodash` (a dev dependency) is one on `DevOnly`. A package used from Infrastructure but in no layer, such as `express`, is uncovered. A built-in is uncovered only under `uncovered.builtins`. Alternatively, `private: [{ "package": "pg" }]` on a layer that also selects `pg` lets other layers use the layer, but not `pg` (a `private-layer` violation, and a `vendor-leak` smell).

**Go and dev.** Go has no dev requirements: a module is dev-only when only `_test.go` files use it. A test file inside a layer's path is that layer's code, so with the `DevOnly` overlay above, its use of `testify` is a violation. Leave tests out of the layer (`{ "not": { "path": "**/*_test.go" } }`) if they may use test-only modules.

**Introspection.** `mapx arch which` and `mapx arch allowed` accept an external by name (`pg`, `node:fs`) or by ecosystem and name (`npm:pg`, `go:fmt`). `allowed` decides as `check` does: an external in no layer that `policy.uncovered` does not report (a built-in, by default) is `out-of-scope`, allowed, at `info`. `mapx arch layer` lists a layer's externals with `kind: "external"` and an empty `file`. `mapx arch unassigned` lists files and symbols only.

<!-- End of M5-24's section. -->

## Membership

- **Symbols.** A symbol is in the layers whose selectors match it. File-level selectors (`path`, `repo` and the like) judge a symbol by its file, so a `path` layer covers every symbol under its directory.
- **Files (AR-01).** A file is in the layers whose selectors match the file, plus the layers of its top-level symbols. A `name` layer can therefore single out one class of a multi-class file, and still claim the file for dependencies that only name the file. With `Controller` as `{ "name": "Controller$" }` and `Domain` as everything under `app/` except names ending in `Controller`, `app/Controller/OrderController.php` is in Controller only and `app/Domain/Order.php` is in Domain through `App\Domain\Order`.
- **Top-level symbols** are those declared at file level: not inside a type, and not a member. A declaration directly inside a C++ namespace or a Ruby module is still top-level. An Elixir module is a type, so its functions are members, while a nested `defmodule` is top-level.
- **No flow between symbols.** One symbol's layer never passes to another symbol.
- **Several layers.** An element in more than one non-overlay layer will get a `multi-layer` warning. A non-overlay layer that matches nothing will get an `empty-layer` warning.
- **Private parts.** A layer's `private` selectors mark the elements only that layer may reach. A file is private to a layer when its `private` selectors match the file or one of its top-level symbols.
- **Explanations.** Membership records why an element is in a layer: the selector position (`selectors[0].name`), for a file the top-level symbol that put it there, and for a hierarchy match the inheritance chain.
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

Every form, on the shop, with a `Deprecated` overlay (`{ "docTag": "@deprecated" }`) added to the quick-start layers:

```jsonc
"rules": {
  "*": ["Shared", "!Deprecated"],                                            // defaults for every layer
  "Controller": ["+Infrastructure"],                                         // Infrastructure, and what it may use
  "Infrastructure": [{ "to": "Domain", "types": ["import", "implements"] }], // only these edge types
  "Domain": [{ "allow": ["Infrastructure"], "severity": "warn" }],           // advisory
  "Shared": ["*"]                                                            // every non-overlay layer
}
```

```
$ mapx check --view rules
Controller
  ✖ disallowed-layer [error]  src/controller/OrderController.ts#OrderController → src/domain/LegacyPricing.ts#LegacyPricing (import)
      src/controller/OrderController.ts:3  … must not depend on src/domain/LegacyPricing.ts#LegacyPricing (Controller on Deprecated)
  ✖ disallowed-layer [error]  src/controller/OrderController.ts#OrderController → src/domain/Order.ts#Order (instantiation)
      src/controller/OrderController.ts:8  … must not depend on src/domain/Order.ts#Order (Controller on Domain)
  ✖ disallowed-layer [warn]  src/controller/OrderController.ts#OrderController → src/domain/OrderRepository.ts#OrderRepository (call, inferred)
      src/controller/OrderController.ts:8  … must not depend on src/domain/OrderRepository.ts#OrderRepository (Controller on Domain)

Domain
  ✖ disallowed-layer [warn]  src/domain/Audit.ts#Audit → src/infra/SqlOrderRepository.ts#SqlOrderRepository (import)
      src/domain/Audit.ts:1  … must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Domain on Infrastructure)
…
Violations: 8 (5 error, 3 warn)   Uncovered: 0   Skipped: 0   Allowed: 14   Warnings: 0   Errors: 0
```

- `!Deprecated` refuses the deprecated `LegacyPricing`, although `+Infrastructure` brings Domain.
- `+Infrastructure` brings Domain only over `import` and `implements`, Infrastructure's own types, so the controller's `new Order()` (an `instantiation`) is refused; its `import` of `Order` is allowed.
- The inferred call is a `warn` (see [`policy.inferred`](#scope-and-policy)).
- Domain on Infrastructure is advisory: `warn`, which fails only under `--fail-on warn`.
- `"Shared": ["*"]` lets Shared use every layer; the shop's `Auditable` (Shared) on `LedgerWriter` (Infrastructure) is allowed.

## Scope and policy

`scope` says which dependencies are checked; `policy` says how they are judged. Every key is optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `scope.types` | `import`, `require`, `extends`, `implements`, `call`, `instantiation`, `param_type`, `return_type` | The edge types checked. The framework edges (`route`, `http`, `dispatch`, `render` …) are opt-in |
| `scope.include` | everything | Globs: an edge is checked only when both its ends are in a matching file |
| `scope.exclude` | nothing | Globs: an edge with an end in a matching file is never checked |
| `policy.inferred` | `"warn"` | Edges MapX matched by name alone: `"error"` judges them like verified ones, `"warn"` reports their violations as `warn`, `"ignore"` skips them |
| `policy.inheritDependencies` | `false` | A type answers for its workspace ancestors' dependencies too (see [Type hierarchy and members](#type-hierarchy-and-members)) |
| `policy.strictLayers` | `false` | An element in several non-overlay layers is an error (`multi-layer`), not a warning |
| `policy.alsoInferred` | `false` | Keep the role-order layer violations in the smells beside the rules' own (see [Smells](#smells)) |
| `policy.uncovered` | `{ "externals": true, "builtins": false }` | Whether dependencies on packages and on the standard library count as uncovered. Packages under `externals`; built-ins and ambient access under `builtins` (see [External dependencies](#external-dependencies-packages-built-ins-ambient-access)) |

```jsonc
"scope": { "types": ["import", "extends", "implements", "instantiation"], "exclude": ["src/legacy/**"] },
"policy": {
  "inferred": "ignore",
  "inheritDependencies": true,
  "strictLayers": true,
  "alsoInferred": true,
  "uncovered": { "externals": true, "builtins": false }
}
```

With these, and a `Models` layer (`{ "extends": "BaseModel" }`) that overlaps Domain, the shop reports an inherited dependency and a strict `multi-layer` error. `Invoice` extends the Shared class `Auditable`, which uses Infrastructure:

```
$ mapx check --view policy
Domain
  …
  ✖ disallowed-layer [error]  src/domain/Invoice.ts#Invoice → src/infra/LedgerWriter.ts#LedgerWriter (import)
      src/domain/Invoice.ts  src/domain/Invoice.ts#Invoice must not depend on src/infra/LedgerWriter.ts#LedgerWriter (Domain on Infrastructure), inherited via src/domain/Invoice.ts#Invoice → src/shared/Auditable.ts#Auditable
…
Domain, Models
  ✖ multi-layer  src/domain/Order.ts#Order is in 2 layers: Domain, Models
      src/domain/Order.ts

Violations: 7 (7 error, 0 warn)   Uncovered: 0   Skipped: 0   Allowed: 11   Warnings: 0   Errors: 1
```

## Visibility

Two mechanisms hide a layer's implementation from other layers, even ones its rules allow (AR-07). Both apply only after the rules allow a dependency, so a forbidden one stays a `disallowed-layer` violation.

- **Private parts (rule `private-layer`).** A layer's `private` selectors mark elements only that layer may reach. `"private": [{ "path": "app/Infrastructure/Db/**" }]` lets other layers use the Infrastructure layer but not its database code.
- **Internal elements (rule `internal-element`).** An internal element is reachable only from its own layers. An element is internal when:
  - it is a symbol with a doc tag listed in `visibility.internalTags` (default `@internal` and `@mapx-internal`). Tags compare like the `docTag` selector: case is ignored and the `@` is optional. A list replaces the default, so `["@mapx-internal"]` stops `@internal` from counting;
  - it is a member of an internal type, since the type is how it is reached;
  - it is a file whose top-level symbols are all internal (an import of the file names them), or a whole file a native marker covers;
  - for a Go import, every in-scope file of the package is internal;
  - with `visibility.nativeMarkers: true`, its language's own module visibility makes it internal (below).

**Native markers** are off by default, because layer boundaries rarely match compiler boundaries. `"visibility": { "nativeMarkers": true }` turns on all of them. A native marker counts only for a reference the language itself refuses, so code that compiles (or follows the language's convention) is never flagged. Where MapX cannot see the boundary (no project, module or package file), it reports nothing:

| Language | Internal | Refused (an `internal-element` finding) when the referrer… |
| --- | --- | --- |
| Go | a file under a directory named `internal` | is not rooted at the parent of the (deepest) `internal` directory, by import path. `internal/http` may use `internal/domain`, and a module-root `internal/` is open to the whole module |
| Python | a module or package whose name starts with `_` (not a dunder such as `__init__`) | is outside the package that holds it and imports the private module itself. A name the package re-exports (`from ._journal import Journal` in `__init__.py`, used as `from app.domain import Journal`) is public through that path |
| Python | a symbol whose name starts with `_` (not a dunder) | is in another module. `from m import _x` names it, so that import is reported on `_x` too |
| Dart | a symbol whose name starts with `_` | is in another file that is not a `part of` |
| Dart | a file under `lib/src/` | is in another package (nearest `pubspec.yaml`) |
| Kotlin | `internal` | is in another module (nearest `build.gradle`, `build.gradle.kts` or `pom.xml`). A module's tests are in the module |
| C# | `internal` (not `protected internal`), `private protected`, and a type declared in a file or namespace without an access modifier. A partial type is as accessible as its most accessible part | is in another project (nearest `.csproj`) that the target's project does not name in `InternalsVisibleTo` (a `.csproj` item or `[assembly: InternalsVisibleTo("…")]`) |
| Java | package-private: a type or member without `public`, `protected` or `private`, except interface and annotation members | is in another package. A test in the same package under another source root (`src/test/java`) may use it |
| Rust | `pub(crate)`, `pub(self)`, `pub(super)`, `pub(in path)` | is in another crate (nearest `Cargo.toml`), or outside the item's module, its parent module, or the path. A plain item without `pub` is not marked: methods of a trait impl have no `pub` |
| TypeScript, TSX, JavaScript, Vue, Svelte | the `@internal` doc tag, even when `internalTags` leaves it out | is in another workspace package (nearest `package.json` name): `stripInternal` removes it from the published types |
| PHP | none | PHP has no module visibility. Its `@internal` convention is a doc tag: keep it in `internalTags` |
| Others | none | Swift's `internal` is its default; Scala `private[pkg]` is not read yet |

The scan stores the Kotlin, C#, Java and Rust visibility on each symbol as `metadata.visibility` (`internal`, `package`, `pub(crate)` …), only when it is restricted, as each declaration (or part of a partial type) writes it. Overloads that share one element are restricted only when every one of them is.

A finding names the marker: `App\Application\PlaceOrder must not depend on App\Domain\LedgerHelper: it is internal to Domain (@internal) (Application on Domain)`. When a member carries the marker, the finding (reported on its type) names the member: `… Account: core/Ledger.kt#Account.audit is internal to Core (Kotlin internal) …`.

On the shop, `LegacyPricing` is private to Domain and `Ledger` is marked `/** @internal */`. The rules allow Controller and Infrastructure to use Domain:

```jsonc
"visibility": { "internalTags": ["@internal"], "nativeMarkers": false },
"layers": [
  { "name": "Domain", "selectors": [{ "path": "src/domain/**" }], "private": [{ "path": "src/domain/LegacyPricing.ts" }] },
  …
]
```

```
$ mapx check --view visibility
Infrastructure
  ✖ internal-element [error]  src/infra/LedgerWriter.ts#LedgerWriter → src/domain/Ledger.ts#Ledger (import)
      src/infra/LedgerWriter.ts:1  src/infra/LedgerWriter.ts#LedgerWriter must not depend on src/domain/Ledger.ts#Ledger: it is internal to Domain (@internal) (Infrastructure on Domain)
…
Controller
  ✖ private-layer [error]  src/controller/OrderController.ts#OrderController → src/domain/LegacyPricing.ts#LegacyPricing (import)
      src/controller/OrderController.ts:3  src/controller/OrderController.ts#OrderController must not depend on src/domain/LegacyPricing.ts#LegacyPricing: it is private to Domain (Controller on Domain)
…
```

## Evaluation

Each stored edge in `scope.types` (default: `import`, `require`, `extends`, `implements`, `call`, `instantiation`, `param_type`, `return_type`) is checked in this order. The first step that applies decides:

1. **Out of scope:** the edge is skipped when its source or target path fails `scope.include`/`scope.exclude`, when it is inferred and `policy.inferred` is `"ignore"`, or when both ends are the same element.
2. **No source layer:** the source is in no layer, so there is nothing to check.
3. **Then, once for each non-overlay layer of the source:**
   1. **Denied overlay:** the target is in an overlay layer the source layer denies (`"*": ["!Deprecated"]`). This is a `disallowed-layer` violation, whatever the target's other layers. Overlays matter only as denied targets: `*` and default-deny never involve them.
   2. **Uncovered:** the target is in no non-overlay layer.
   3. **Same layer:** every non-overlay layer of the target is the source layer. Nothing is recorded.
   4. **`disallowed-layer`:** one of the target's other layers is not allowed for this edge type, or is denied.
   5. **`internal-element`:** the target is internal (see [Visibility](#visibility)) and the source layer is not one of its layers.
   6. **`private-layer`:** the target is private to a layer other than the source layer (a `private` selector).
   7. **Allowed.**

**Severity.** A violation is an `error`. It is a `warn` when the edge is inferred (under the default `policy.inferred: "warn"`) or when the pair is advisory. Uncovered dependencies are `warn`.

**Granularity.** Layers are decided on the finest element an edge names: the method, or the file for an import. An edge end names a symbol only when the file has exactly one symbol of that name; an import path names the file. A finding then names the top-level declaration: a method's dependency is reported on its class, even when the method is declared in another file of the class's namespace or package (Go, C# partial classes). An import is reported on the file's only top-level symbol, or on the file when it has several. So one class-to-class dependency is one finding per edge type, however many edges carry it. There are two exceptions:
- the target of an `http` or `route` edge stays the handler method;
- a Go import names a package, so its target is the package (its import path, with the layers of its directory's in-scope files). It is dropped when every importing file already has a finding of the same kind and rule on a type of that package. An allowed import is also dropped when every importing file has a finding of any kind on a type of that package: when that type is internal, the import is how the violation is reached.

## Reporters

`mapx check --format <format>` picks the reporter; `-o <file>` writes it to a file. All six list the same findings, in the same order, and each is deterministic: the same findings give the same bytes.

| Format | For | Example |
| --- | --- | --- |
| `table` (default) | people, in a terminal | [Quick start](#quick-start) |
| `json` | tools, `--compare`, the dashboard | [The report](#the-report) |
| `sarif` | GitHub code scanning, IDE SARIF viewers | [CI reports](#ci-reports) |
| `github` | GitHub Actions annotations (the default inside GitHub Actions) | [CI reports](#ci-reports) |
| `codeclimate` | GitLab Code Quality | [CI reports](#ci-reports) |
| `junit` | GitLab and Jenkins test reports | [CI reports](#ci-reports) |

`--report-uncovered`, `--report-skipped` and `--report-allowed` add those findings to every format; they are always counted. The table marks each finding by kind: `✖` a violation or an error, `!` a warning, `?` an uncovered dependency, `-` a skipped violation (`[baseline]` or `[compare]`), `✓` an allowed dependency:

```
$ mapx check --report-skipped --report-allowed       # after --generate-baseline
Controller
  - disallowed-layer [baseline]  src/controller/OrderController.ts#OrderController → src/infra/SqlOrderRepository.ts#SqlOrderRepository (import)
      src/controller/OrderController.ts:2  src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure)
  - disallowed-layer [baseline]  src/controller/OrderController.ts#OrderController → src/infra/SqlOrderRepository.ts#SqlOrderRepository (instantiation)
      …
  ✓ allowed  src/controller/OrderController.ts#OrderController → src/domain/LegacyPricing.ts#LegacyPricing (import)
      src/controller/OrderController.ts:3  src/controller/OrderController.ts#OrderController may depend on src/domain/LegacyPricing.ts#LegacyPricing (Controller on Domain)
…
```

Warnings (`!`) and uncovered dependencies (`?`) look like this:

```
layer Empty
  ! empty-layer  layer Empty matches no element

Domain
  ? uncovered  src/domain/Order.ts#Order → src/shared/BaseModel.ts#BaseModel (extends)
      src/domain/Order.ts:4  src/domain/Order.ts#Order depends on src/shared/BaseModel.ts#BaseModel, which is in no layer
```

## The report

`mapx check --format json` prints this report, described by `schemas/arch-report.schema.json`. It comes from `runArchitecture(dir)` in `src/arch/report.ts`. Uncovered, skipped and allowed findings are listed only with `--report-uncovered`, `--report-skipped` or `--report-allowed`; `counts` always includes them:

- **`findings`:** one per dependency, edge type and rule. A source in several layers gets one finding whose `source.layer` lists them. Each has a `kind` (`violation`, `skipped`, `uncovered`, `allowed`, `warning`, `error`), a `rule`, a `severity`, the `source` and `target` (element, file, layer, repo, first line), the `edgeType`, `verifiability`, the number of `edges` it stands for, a `fingerprint` and a `message`. A `skipped` finding says why in `skippedBy`: `baseline` or `compare`. A finding whose fingerprint inputs differ from the elements it shows has an `identity`; see [Fingerprints](#fingerprints).
- **`fingerprint`:** a hash of the rule, both elements and the edge type, with no line number, so it survives edits that move code. See [Fingerprints](#fingerprints).
- **Warnings:**
  - `multi-layer`, for a top-level declaration in several non-overlay layers. It is an error under `policy.strictLayers`. A symbol-less file gets one only when it is a dependency end;
  - `empty-layer`, for a non-overlay layer that matches nothing;
  - `unsupported-selector`, for a selector this version cannot evaluate yet. It matches nothing.
- **Errors:** an invalid configuration gives `error` findings, `plus-cycle` for a `+` cycle (naming its first layer) and `config` for the rest. A baseline entry that matches nothing is a `stale-baseline` error.
- **`layers`:** elements and files per layer, and `uncovered`: the uncovered dependencies whose source is in the layer.
- **`layerEdges`:** allowed, violating and skipped dependencies per layer pair, and `warnings`: how many of the violations are reported at `warn` (an advisory allowance, or an inferred edge under `policy.inferred: "warn"`). A pair keeps its own severity, so a source in two layers can be advisory on one pair and an error on the other.
- **`counts`:** per kind.
- **`selection`** (from `mapx check`): the `view`, `layer` and `rule` the run evaluated and kept, `null` when not given.

A workspace with a configuration but no index is an error (`run mapx scan first`), never an empty report.

The quick-start violation, as JSON (one finding, `layers` and `layerEdges` shortened):

```
$ mapx check --format json --rule disallowed-layer
{
  "version": 1,
  "counts": { "violation": 2, "skipped": 0, "uncovered": 0, "allowed": 0, "warning": 0, "error": 0 },
  "findings": [
    {
      "kind": "violation",
      "rule": "disallowed-layer",
      "severity": "error",
      "source": { "element": "src/controller/OrderController.ts#OrderController", "file": "src/controller/OrderController.ts", "layer": "Controller", "layers": ["Controller"], "repo": "backend-shop", "line": 2 },
      "target": { "element": "src/infra/SqlOrderRepository.ts#SqlOrderRepository", "file": "src/infra/SqlOrderRepository.ts", "layer": "Infrastructure", "layers": ["Infrastructure"], "repo": "backend-shop" },
      "edgeType": "import",
      "verifiability": "verified",
      "edges": 1,
      "fingerprint": "d9471194ce2c8212",
      "message": "src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure)",
      "identity": { "source": "src/controller/OrderController.ts", "target": "src/infra/SqlOrderRepository.ts" }
    },
    …
  ],
  "layers": [{ "name": "Controller", "elements": 3, "files": 1, "overlay": false, "uncovered": 0 }, …],
  "layerEdges": [{ "from": "Controller", "to": "Infrastructure", "allowed": 0, "violations": 2, "warnings": 0, "skipped": 0 }, …],
  "configErrors": [],
  "selection": { "view": null, "layer": null, "rule": "disallowed-layer" }
}
```

## CI reports

`mapx check --format` also writes the formats CI systems read natively. The code is in `src/arch/reporters/`; the mapping of every finding kind is in [cli-reference.md](cli-reference.md#ci-formats).

| Format | For | Notes |
| --- | --- | --- |
| `sarif` | GitHub code scanning (`github/codeql-action/upload-sarif`), IDE SARIF viewers | SARIF 2.1.0; skipped violations are suppressed (`external`, accepted); `partialFingerprints["mapx/v1"]` is the finding's fingerprint. GitHub accepts up to 10 MB (compressed) and 25,000 results per run |
| `github` | GitHub Actions annotations on the pull request | Chosen automatically when `GITHUB_ACTIONS` is `true`, no `--format` is given and the report goes to stdout. The run's causes are annotated first (GitHub shows 10 per level and step); every finding is also a log line |
| `codeclimate` | GitLab Code Quality (`artifacts:reports:codequality`) | A violation's issue fingerprint is the finding's fingerprint; other kinds derive one from kind and rule; severities from `report.codeclimate` |
| `junit` | GitLab and Jenkins test reports | One suite per layer, one testcase per finding; a testcase fails exactly when its finding fails the run |

- **Failing level:** every format marks exactly the findings that fail the run (the exit-code rule, with `--fail-on`, `--fail-on-uncovered` and `--compare`) at its failing level: SARIF `error`, `::error`, the CodeClimate `error` severity, a JUnit failure or error. So the cause of exit 1, 2 or 3 is always shown as an error.
- **Paths** use `/` in every format; a finding without a file is located on the configuration file. The CI formats give them from the root of the git repository that holds the workspace (`services/api/app/…` for a workspace in `services/api`), so CI links the right file; `table` and `json` keep them workspace-relative.
- **Determinism:** the same findings give the same bytes: no timestamps, durations, host names or absolute paths. Only SARIF's `tool.driver.version` changes with the MapX version.
- **Baselines and `--compare`:** a skipped violation is a SARIF suppression, a `::notice`, a CodeClimate issue at the `skipped` severity and a JUnit `<skipped>`, listed only with `--report-skipped`. A stale baseline entry is an error located on the baseline file (relative to the workspace, never absolute), its message naming the entry by JSON pointer (`.mapx/architecture.baseline.json#/entries/0`); the report gives it as `location`.

The quick-start violation (the `import`; the `instantiation` is alike) in each CI format:

```
$ mapx check --format github
[error] src/controller/OrderController.ts:2 disallowed-layer: src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure) [import]
…
::error file=src/controller/OrderController.ts,line=2,title=disallowed-layer::src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure) [import]
…
Violations: 2 (2 error, 0 warn)   Uncovered: 0   Skipped: 0   Allowed: 12   Warnings: 0   Errors: 0
```

```
$ mapx check --format sarif          # one result of runs[0].results
{
  "ruleId": "disallowed-layer",
  "ruleIndex": 0,
  "level": "error",
  "message": { "text": "src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure) [import]" },
  "locations": [{
    "physicalLocation": { "artifactLocation": { "uri": "src/controller/OrderController.ts", "uriBaseId": "%SRCROOT%" }, "region": { "startLine": 2 } },
    "logicalLocations": [{ "fullyQualifiedName": "src/controller/OrderController.ts#OrderController" }]
  }],
  "partialFingerprints": { "mapx/v1": "d9471194ce2c8212" },
  "properties": { "kind": "violation", "sourceLayer": "Controller", "target": "src/infra/SqlOrderRepository.ts#SqlOrderRepository",
                  "targetFile": "src/infra/SqlOrderRepository.ts", "targetLayer": "Infrastructure", "edgeType": "import", "verifiability": "verified", "edges": 1 }
}
```

```
$ mapx check --format codeclimate    # one issue of the array
{
  "type": "issue",
  "check_name": "disallowed-layer",
  "description": "src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure) [import]",
  "categories": ["Complexity"],
  "severity": "major",
  "fingerprint": "d9471194ce2c8212",
  "location": { "path": "src/controller/OrderController.ts", "lines": { "begin": 2 } }
}
```

```
$ mapx check --format junit
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="mapx check" tests="5" failures="2" errors="0">
  <testsuite name="Controller" tests="2" failures="2" errors="0" skipped="0">
    <testcase name="src/controller/OrderController.ts#OrderController → src/infra/SqlOrderRepository.ts#SqlOrderRepository (import)" classname="disallowed-layer">
      <failure type="disallowed-layer" message="src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure) [import]">src/controller/OrderController.ts:2
src/controller/OrderController.ts#OrderController must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Controller on Infrastructure) [import]
fingerprint: d9471194ce2c8212</failure>
    </testcase>
    …
  </testsuite>
  <testsuite name="Domain" tests="1" failures="0" errors="0" skipped="0">
    <testcase name="no findings" classname="layer"/>
  </testsuite>
  …
</testsuites>
```

**The CodeClimate severity map.** `report.codeclimate` maps what a finding is to a CodeClimate severity (`info`, `minor`, `major`, `critical`, `blocker`). `error` is for the findings that fail the run. Other violations and warnings (an advisory rule, `"severity": "warn"`, or an inferred edge under `policy.inferred: "warn"`, without `--fail-on warn`) are `warn`; uncovered dependencies (without `--fail-on-uncovered`) and skipped violations are keyed by kind. Keys left out keep the defaults below, and an `extends` chain merges the map key by key. An unknown key or severity is a configuration error (exit 3).

```jsonc
{
  "report": {
    // the defaults: a failure is major, a skipped violation minor, an uncovered dependency info (as Deptrac)
    "codeclimate": { "error": "major", "warn": "minor", "uncovered": "info", "skipped": "minor" }
  }
}
```

A GitHub Actions job, as an example. The index is not committed, so the job scans first:

```yaml
- run: npx @mgamil/mapx init . --no-agents --no-suggestions --no-mcp-configs && npx @mgamil/mapx scan .
- run: npx @mgamil/mapx check            # annotations, since GITHUB_ACTIONS is set
- run: npx @mgamil/mapx check --format sarif -o mapx.sarif
  if: always()
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: mapx.sarif
```

Uploading to code scanning needs `permissions: security-events: write`, which a pull request from a fork never gets, so on a public repository that takes fork PRs, keep the annotations as the gate and the SARIF file as a build artifact (`actions/upload-artifact`) instead, as [MapX's own CI](#mapxs-own-rules) does. Write reports outside the workspace or under `.mapx/` when another `mapx` command runs after them in the same job: a new file of a type MapX indexes (`.json`, `.md` …) elsewhere in the workspace makes the index stale (exit 4); `.sarif`, `.xml` and `.txt` files are not indexed.

## Exit codes

`mapx check` exits with the most basic problem it found. When several apply, 4 wins over 3, 3 over 1, and 1 over 2:

| Code | Meaning | Example on the shop |
| --- | --- | --- |
| 0 | No finding fails the run. Skipped (baselined) violations, warnings, uncovered dependencies and `warn`-level violations do not fail it by default | `mapx check` after `--generate-baseline` |
| 1 | A violation of severity `error`; with `--fail-on warn`, also a `warn`-level violation or a warning; under `policy.strictLayers`, a `multi-layer` error | the [quick start](#quick-start); an advisory rule with `--fail-on warn` |
| 2 | An uncovered dependency, with `--fail-on-uncovered` | below |
| 3 | A configuration, usage or baseline error: an invalid document, a `+` cycle, no configuration or no such view, an unknown option, `--layer` or `--rule`, a stale baseline entry, a missing or invalid baseline or `--compare` report | below |
| 4 | No index, a repo never scanned, an index older than the files (pass `--sync`) or than this MapX, or an internal error | below |

```
$ mapx check --view core --fail-on-uncovered       # a view without the Shared and Infrastructure layers
…
Violations: 0 (0 error, 0 warn)   Uncovered: 6   Skipped: 0   Allowed: 5   Warnings: 0   Errors: 0
$ echo $?
2

$ mapx check --view broken                         # "paht" and "Servce" are typos
configuration
  ✖ config  .mapx/architecture/broken.jsonc#/layers/0/selectors/0/paht: unknown selector key "paht"; expected one of path, name, …
  ✖ config  .mapx/architecture/broken.jsonc#/rules/Http/0: unknown layer "Servce"; did you mean "Service"?

Violations: 0 (0 error, 0 warn)   Uncovered: 0   Skipped: 0   Allowed: 0   Warnings: 0   Errors: 2
$ echo $?
3

$ mapx check --baseline ../stale.json --rule stale-baseline
configuration
  ✖ stale-baseline  src/domain/Order.ts#Order → src/infra/SqlOrderRepository.ts#SqlOrderRepository
      src/domain/Order.ts  ../stale.json#/skip_violations/src~1domain~1Order.ts#Order/0: skip_violations src/domain/Order.ts#Order → src/infra/SqlOrderRepository.ts#SqlOrderRepository matches no violation; delete it
…
$ echo $?
3

$ touch src/domain/Discount.ts && mapx check       # a new file the index does not have
The index is stale: 1 file(s) changed since the last scan (src/domain/Discount.ts (new)). Run `mapx update`, or `mapx check --sync`.
$ echo $?
4
```

The `mapx arch` subcommands follow the same codes: `arch allowed` exits 1 when `mapx check` would fail on the dependency, `arch unassigned` exits 2 when an element is in no layer, `arch validate-config` and `arch init` exit 3 on a configuration or usage error, and every subcommand exits 4 on an index problem. `arch graph` is not a gate: it exits 0 whatever the graph shows. The MCP tools return the same code as `exitCode` (see [MCP tools](#mcp-tools)).

## Layer graphs

`mapx arch graph` draws the layer graph (Deptrac's `graphviz-*` and `mermaidjs` formatters); its options are in [cli-reference.md](cli-reference.md#mapx-arch-graph). It is built from the report `mapx check` builds, baseline included, so every count and status is `check`'s own decision. `layerGraph(report, config)` in `src/arch/reporters/graph.ts` returns the graph, which `--format json` prints and the dashboard (M5-15) reads.

- **Nodes:** one per layer, in configuration order. A layer's `color` fills its node when it is `#rrggbb`, `#rrggbbaa` or a colour name; other values are ignored. Overlay layers have a dashed border.
- **Edges:** for each layer pair, the dependencies counted in `layerEdges` (one per element pair and edge type), one edge per status: allowed (grey), violations (red), warn-level violations (amber) and skipped, that is baselined, violations (dashed). The label is the count.
- **Groups** are subgraphs. A layer's group is the first group of `report.groups` that lists it, else its own `group` key.
- **Hidden layers** (`report.hidden`) are analysed but not drawn: neither the node nor its edges appear. The totals still count them; they name the number of hidden layers, never their names.
- **Point to group** (`report.pointToGroups: true`, Deptrac's `pointToGroups`): an edge into the layer named like its group points at the group, which shows a module's public API. An edge from inside the group still reaches the layer. DOT uses `lhead`, Mermaid an edge to the subgraph.
- **The layer DSM** (`--format dsm`) is a matrix of the visible layers, rows depending on columns, printed like the cluster DSM of `mapx arch --dsm`. A cell is its pair's count, marked by its worst status: `!` violations, `~` warn-level violations only, `s` skipped violations only. Columns widen to the widest cell.
- **Totals** are `mapx check`'s counts (`counts`, one per finding), with `warnings` the violations at `warn`. They are not sums over the pairs: a dependency on an element in both Domain and Shared counts on both pairs but once in the totals.
- **Escaping:** DOT node and cluster IDs are synthetic (`n0`, `n1` … and `cluster_0` …, numbered in name order), so no name can mean something to Graphviz as an ID (`%Domain`). Labels are double-quoted with `"` and `\` escaped and `&` written `&amp;`, so Graphviz shows `&lt;`, `\N` or `\G` in a name as written. Mermaid IDs are derived from the names (`layer_Http_Api`, then `_2` … on a clash) and labels use Mermaid entity codes (`#quot;`, `#lt;` …). SVG text is XML-escaped.
- **Determinism:** nodes and edges follow the configuration's layer order, so the same index and configuration give the same bytes. SVG through Graphviz depends on the Graphviz version; `--no-graphviz` is byte-stable everywhere.

```jsonc
{
  "layers": [
    { "name": "Controller", "group": "Web", "color": "#fde68a", "selectors": [{ "path": "src/controller/**" }] },
    // …
  ],
  "report": {
    "groups": { "Domain": ["Domain", "Shared"] },  // edges into Domain from outside point at the group
    "pointToGroups": true,
    "hidden": ["Infrastructure"]                    // counted, not drawn
  }
}
```

```
{ version: 1, view,
  layers: [{ name, overlay, elements, files, group, color, hidden, uncovered }],
  groups: [{ name, layers, pointTo }],
  edges: [{ from, to, allowed, violations, warnings, skipped, hidden }],
  totals: { allowed, violations, warnings, skipped, uncovered, hiddenLayers } }
```

`uncovered` counts the source layer's dependencies on elements in no layer, which have no edge to draw (the report's `layers[].uncovered`). `pointTo` is the layer whose incoming edges point at the group, or null.

The shop's graph, with the baselined Controller → Infrastructure dependencies (dashed) and the new Domain → Infrastructure violation (red):

```
$ mapx arch graph --format mermaid
flowchart TB
  %% Dependencies: 12 allowed, 2 violations (0 at warn), 2 skipped, 0 uncovered
  layer_Controller["Controller"]
  layer_Domain["Domain"]
  layer_Infrastructure["Infrastructure"]
  layer_Shared["Shared"]
  layer_Controller -->|5| layer_Domain
  layer_Controller -.->|2| layer_Infrastructure
  layer_Domain -->|2| layer_Infrastructure
  layer_Domain -->|4| layer_Shared
  layer_Infrastructure -->|3| layer_Domain
  linkStyle 1 stroke:#94a3b8,color:#94a3b8
  linkStyle 2 stroke:#dc2626,stroke-width:2px,color:#dc2626

$ mapx arch graph --format dsm
── Layer Dependency Structure Matrix (DSM) ────────────
                    L1   L2   L3   L4
-------------------------------------
L1 Controller        *    5   2s    .
L2 Domain            .    *   2!    4
L3 Infrastructure    .    3    *    .
L4 Shared            .    .    .    *
…
```

## Smells

`mapx_smells`, `mapx arch` (with `--smells` and `--violations`) and the dashboard's `/api/smells` list the smells the last scan found: cycles, hubs, cluster smells, and layer violations inferred from file roles (the role order of the codebase's archetype). Without `.mapx/architecture.jsonc`, that list is exactly as before. With one, the configuration is the one source of layer violations (`docs/research/deptrac/03-mapx-gap-and-integration.md` §3.3):

- **`layer-violation`** smells come from `mapx check`'s report, its baseline applied, one per source file → target file. Each line names the elements, the layers, the rule and the edge types. A violation of severity `error` is `CRITICAL`, a `warn` one `WARNING`.
- **The role-order violations are dropped,** so an edge is never reported twice. With `"policy": { "alsoInferred": true }` they are kept too, marked `Source: inferred-roles`, but only on edges the rules decide in no way: from a file in no layer, outside the paths the scope excludes. An edge the rules allow, report, baseline or exclude is theirs, and never comes back as inferred.
- **Errors that make `mapx check` exit 3** (a stale baseline entry, a `+` cycle …) are `architecture-config` smells (`CRITICAL`).
- **The rules add these smells,** each marked `Source: rules`:

| Smell | When |
| --- | --- |
| `layer-cycle` | Layers form a cycle in the observed layer graph: every pair with an allowed or a reported violating dependency, after the baseline. `CRITICAL`. |
| `layer-skip` | AR-18: in a strictly ordered chain, a layer bypasses the next one down. The chain is written with `+`: each layer's one `+` names the next layer down (`Controller: ["+Service"]`, `Service: ["+Repository"]`). A dependency on a layer of the source's chain past its next one skips the layers between that have elements, and the message names them all (`bypassing Service, Repository`). A layer the source's own rules or the `*` defaults name is no skip. A layer off the chain is no skip either, such as a shared kernel some layer allows plainly and the source reaches through `+`. A layer with several `+` ends the chain. One per source file → target file. |
| `dead-allowance` | An allowance the rules write for the pair (explicit, or the layer a `+` names) that no dependency uses, as `mapx arch unused` counts uses. Inherited grants and the `*` wildcard are not reported. A `"*"` default (`"*": ["Util"]`) is dead only when no layer uses it, and is then reported once, as `* → Util`. |
| `weak-allowance` | The same, used by only 1 or 2 stored edges (`mapx arch unused --limit 2`; a `"*"` default, by all layers together): a candidate for removing the coupling. |
| `unstable-layer-dependency` | Martin's Stable Dependencies Principle per layer pair: the source layer is more stable than its target, I(source) < I(target). |
| `abstractness-distance` | A layer with types and dependencies is far from the main sequence: D = \|A + I − 1\| > 0.7, in the zone of pain (concrete and stable) or of uselessness (abstract and unstable). |
| `deprecated-usage` | An edge in the configuration's scope into an element tagged `@deprecated` (a Python `@deprecated` decorator counts), or a member of one, from outside it. Deprecated code using deprecated code is not reported. |

Instability is I = Ce / (Ca + Ce) per layer, counted in files. Ca counts the files outside the layer with a dependency on it, and Ce the files of the layer with a dependency outside it, allowed or violating. A file counts once, whatever it declares. Abstractness A is the share of interfaces and traits among the layer's top-level types.

On the shop with the quick-start rules, its baseline, and a new `Audit` class in Domain that uses `SqlOrderRepository`:

```
$ mapx arch --smells
── Architectural Smells & Violations (5) ─────────────────

  [CRITICAL] layer-violation
    Description: Layer violation: src/domain/Audit.ts#Audit must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Domain on Infrastructure) [disallowed-layer: import, instantiation]
    Files:       src/domain/Audit.ts, src/infra/SqlOrderRepository.ts
    Suggestion:  Remove the dependency, or allow Domain → Infrastructure in .mapx/architecture.jsonc if it is intended (`mapx arch allowed` explains the decision).
    Source:      rules

  [CRITICAL] layer-cycle
    Description: Layer cycle: Domain -> Infrastructure -> Domain
    Layers:      Domain, Infrastructure
    …
    Source:      rules

  [WARNING] deprecated-usage
    Description: Deprecated usage: src/controller/OrderController.ts#OrderController uses src/domain/LegacyPricing.ts#LegacyPricing, which is deprecated (use Money)
    …
```

The baselined Controller → Infrastructure violations are neither a `layer-violation` nor part of a cycle. With `"policy": { "alsoInferred": true }`, role-order violations on edges the rules do not decide join the list, marked `Source: inferred-roles`.

**The baseline.** The layer graph (cycles, instability, distance) is the one after the baseline. A baselined violation is acknowledged debt: it is neither a smell nor a coupling, so it makes no cycle. Tracking that debt is a separate smell (`baseline-debt`, not built yet).

**Composed when read.** Rule smells are computed each time they are listed, from the index and the configuration as they are, so an edited configuration applies without a rescan. The edges are evaluated once per listing. In a multi-repo workspace, layer-level smells (cycles, allowances, stability, distance) belong to the workspace's primary repo, and the others to their source file's repo.

**A configuration that cannot be loaded** (or an invalid baseline) keeps the role-order violations, marked `inferred-roles`, and adds an `architecture-config` smell naming the first problem. `mapx arch validate-config` lists them all.

Package smells (M5-24), also marked `Source: rules`:

| Smell | When |
| --- | --- |
| `vendor-leak` | A `private-layer` violation on an external package: a package a layer's `private` selectors confine to it is used from another layer. It replaces the `layer-violation` smell for that pair. |
| `undeclared-dependency` | Code in scope (any layer, or none) uses a known package that a readable manifest positively does not list directly: a transitive one, or one in no manifest (`direct` false). The rule is the same for npm, Composer, pypi and Go: a package no input provides is never one, since there is no name the manifest could lack. One per source file and package. |
| `dev-dependency-in-prod` | Code in scope uses a dev-only package from a file that is not a test, configuration, script or tooling file: by its role (`test`, `config`, `scripts`), or by a conventional name (`*.config.ts`, `*.conf.js`, `.eslintrc.cjs`, `conftest.py`, `setup.py`, `noxfile.py`, `gulpfile.js` …). One per source file and package. |

A package whose direct or dev status is unknown gives neither of the last two.

## Baselines and the ratchet

A baseline lets you adopt rules on code that already breaks them. It freezes today's violations, so only new ones fail. It can only shrink: an entry that no longer matches a violation is an error, and you delete it. The code is in `src/arch/baseline.ts`.

### The baseline file

```json
{
  "version": 1,
  "entries": [
    {
      "fingerprint": "0816fbd611f92a81",
      "rule": "disallowed-layer",
      "source": "App\\Domain\\Order",
      "target": "App\\Infrastructure\\SqlOrderRepository",
      "edgeType": "instantiation"
    }
  ],
  "skip_violations": {
    "App\\Domain\\Order": ["App\\Infrastructure\\SqlOrderRepository"]
  }
}
```

- **`entries`** are what `mapx check --generate-baseline` writes. There is one per violation, sorted by rule, source, target and edge type, with no timestamp. The same violations always give the same bytes, so a diff of the baseline is a review of the debt.
  - **Fields:** an entry needs a `fingerprint`, or all of `rule`, `source`, `target` and `edgeType`, from which the fingerprint is computed. When both are given, they must agree.
  - **Repos:** an entry in a multi-repo workspace also has `sourceRepo` and `targetRepo` when an end is outside the root repo.
  - **Ends:** `source` and `target` are the fingerprint's ends, so an import's `source` is the importing file (`app/Domain/Order.php`).
- **`skip_violations`** is Deptrac's form: source element → target elements. A pair matches every violation between the two elements, whatever its rule or edge type. Use it to carry a Deptrac baseline over.
- **Matching:** a violation whose fingerprint, or element pair, is in the baseline is reported as `skipped`. It never fails the run and is counted as skipped in `layerEdges`.
- **Stale entries:** every entry or pair that matched no violation is an `error` finding with rule `stale-baseline`, and the run exits 3. Its ends name the files when the elements still exist. Regenerating drops it.
- **Which file:** `--baseline <file>`, else the configuration's `"baseline"` (relative to the workspace), else `.mapx/architecture.baseline.json` if it exists.
  - **Views:** a view uses `.mapx/architecture/<view>.baseline.json`, unless the view's own document sets `"baseline"`. A `baseline` it inherits through `extends` is ignored, so a view never reads or overwrites the main baseline.
  - **Errors:** a file named by the option or the configuration must exist. A missing file, invalid JSON, an unknown key or a bad entry is a configuration error (exit 3), reported with a JSON pointer. A UTF-8 byte order mark is ignored.
  - **Where to keep it:** under `.mapx/`. MapX indexes JSON files, so a baseline elsewhere in the workspace makes the index stale (exit 4) until the next scan; `--generate-baseline` warns and suggests a `.mapx/` path.

### Fingerprints

A fingerprint is the first 16 hex characters of sha256 over `[rule, source, target, edge type]`. When an end is outside the workspace's root repo, it is taken over `[rule, source, target, edge type, source repo, target repo]`.

- **The ends:**
  - **Symbol-level ends** are the reported element: a qualified name (`App\Domain\Order`, `app.domain.order.Order`, `src/domain/order.ts#Order`), with a method lifted to its class.
  - **File-level ends** are the workspace-relative file path. These are the ends an edge names at file level: an import's importing file, and an import path's target file. The report shows such an end as the file's only top-level declaration when it has one, but the fingerprint keeps the file. So adding a function or a constant to either file does not re-key the dependency. The finding's `identity` gives the ends when they differ from those shown. A file-level and a symbol-level dependency between the same two declarations, on the same edge type, are two findings.
- **Repos:** a repo is named by its workspace-relative path (`backend`), and the root repo by nothing. A single-repo workspace never names its repo, and in a multi-repo workspace two Laravel apps' `App\Domain\Order` are different dependencies.
- **Stable across runs and machines:** it hashes no line number, no layer, and nothing absolute or time-dependent.
- **Stable across path separators:** the store records paths with `/` on every OS. A hand-written entry with Windows separators in a path (`src\a.ts`) is normalised before it is fingerprinted, while a PHP name keeps its backslashes.
- **A moved line still matches,** since the line is not part of it. So does a re-scan of an unchanged tree, or a file edited elsewhere.
- **What re-keys it:**
  - **A renamed or moved class** is a new dependency.
  - **A moved file** re-keys its file-level ends everywhere. It also re-keys every element of a language whose qualified names are paths (TypeScript, JavaScript and the other path-form languages: `src/domain/order.ts#Order`). Moving such a file is, to the baseline, removing a dependency and adding one: regenerate.
  - **Another edge type** is another dependency: an `import` and an `instantiation` between the same two classes are two entries. A Deptrac pair covers both.

### `--compare`: the ratchet without a committed baseline

CI checks the merge base and keeps its JSON report. It then checks the head against it:

```bash
mapx check <base checkout> --format json --report-skipped --report-uncovered -o /tmp/base.json
mapx check --compare /tmp/base.json
```

- **What it skips:** a violation whose fingerprint is anywhere in the base report is skipped (`skippedBy: "compare"`), so only violations new since the base fail.
- **Other failing findings:** a warning under `--fail-on warn`, an uncovered dependency under `--fail-on-uncovered` or a strict `multi-layer` error does not fail when the base report has its fingerprint.
- **What always fails:** configuration errors and stale baseline entries.
- **Fixed violations** are not errors: paying debt off is the point.
- **Producing the base report:** produce it with `--report-skipped` and `--report-uncovered`, because hidden findings are not in the report and so cannot be recognised. A baseline still applies under `--compare`.
- **Like with like:** the report records its `selection`. A base report of another view, or one narrowed by a `--layer` or `--rule` that the head does not share, is refused (exit 3). Its missing findings would look new, or one view's findings would excuse another's. A narrower head against a whole base is fine.

On the shop, the base report holds the two baselined Controller violations; the head adds `Audit`, a Domain class that uses `SqlOrderRepository`:

```
$ mapx check --format json --report-skipped --report-uncovered -o ../base.json
$ mapx check --sync --compare ../base.json
Domain
  ✖ disallowed-layer [error]  src/domain/Audit.ts#Audit → src/infra/SqlOrderRepository.ts#SqlOrderRepository (import)
      src/domain/Audit.ts:1  src/domain/Audit.ts#Audit must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Domain on Infrastructure)
  ✖ disallowed-layer [error]  src/domain/Audit.ts#Audit → src/infra/SqlOrderRepository.ts#SqlOrderRepository (instantiation)
      src/domain/Audit.ts:4  src/domain/Audit.ts#Audit must not depend on src/infra/SqlOrderRepository.ts#SqlOrderRepository (Domain on Infrastructure)

Violations: 2 (2 error, 0 warn)   Uncovered: 0   Skipped: 2   Allowed: 12   Warnings: 0   Errors: 0
$ echo $?
1
```

`--since <git-ref>`, which would scan the ref itself, is deferred (REQ-ARCH-021).

## Introspection

The `mapx arch` subcommands answer questions about the configuration from the index (AR-13, Deptrac's `debug:*` commands). Their options and exit codes are in [cli-reference.md](cli-reference.md#mapx-arch-introspection-subcommands). With `--format json` each prints the object the matching function of `src/arch/introspect.ts` returns. The `mapx_arch_layers`, `mapx_arch_allowed` and `mapx_arch_explain` MCP tools return the same objects (M5-14).

- **Elements.** An element is `{ element, kind, symbolKind?, file }`: `element` is a symbol's qualified name or a file's path, and `kind` is `file` or `symbol`.
- **Errors.** Every failure prints `{ "error": "…" }` on stdout in JSON, whatever its exit code. An ambiguous name or an unknown layer adds `candidates`, and an invalid configuration adds `issues: [{ file, pointer, message }]`.
- **Scope.** `scope.include` and `scope.exclude` apply as in `mapx check`. An element outside them takes part in no evaluated edge.

| Subcommand | Question | JSON |
| --- | --- | --- |
| `layers` | Which layers are there, and how big? | `{ layers: [{ name, overlay, elements, files }] }`, counted as `mapx check` counts them: every element, and the files among them |
| `layers <layer> [--why]` | Which elements are in this layer? | `{ name, overlay, elements, files, total, members: [element] }`. See below |
| `which <element>` | Which layers is this element in, and why? | `{ query, matches: [{ …element, layers, private, trace: [{ layer, selector, via, chain? }], inScope }] }`. See below |
| `unassigned` | What is in no layer? | `{ total, elements: [element] }`. See below. **Exit 2** when `total` is not 0 |
| `deps <from> [to]` | Which concrete edges go from one layer to another? | `{ from, to, counts: { allowed, violation, uncovered }, dependencies: [{ source: { …element, line }, target, targetLayers, edgeType, verifiability, kind, rule?, severity, violatedLayers?, via? }] }`. See below |
| `unused [--limit N]` | Which allowances are used at most N times (default 0)? | `{ limit, total, allowances: [{ from, to, rule, types, severity, uses }] }`. See below |
| `changed [files…] [--since <ref>] [--with-dependents]` | Which layers do these files touch, and which layers depend on them? | `{ files: [{ file, indexed, inScope, layers }], layers, dependents?: [{ layer, files }], unassignedDependents? }`. See below |
| `allowed <from> <to> [--type T]` | Would a dependency from `from` to `to` pass `mapx check`? | Described below. **Exit 1** when `mapx check` would fail on it |

- **`layers <layer>`:**
  - Members are files and top-level symbols; `--nested` adds every symbol.
  - `--why` adds `selector`, the position that matched (`selectors[0].all`), and `via`: `self`, or the top-level symbol that put a file in the layer. A hierarchy match adds `chain`, the inheritance path that matched.
- **`which`:**
  - `layers` includes overlays, and `private` lists the layers the element is private to.
  - A name that matches several elements lists them all.
- **`unassigned`:**
  - It lists elements in no non-overlay layer that a dependency can involve, within the scope's paths. These are symbols (top-level ones, unless `--nested`) and files that declare a symbol or are an end of an evaluated edge. So the files `mapx init` writes (AGENTS.md and the like), JSON configs and other files nothing depends on are not listed, as `mapx check` never reports them uncovered.
  - `--kind` takes `file`, `symbol` or a symbol kind, and `--path` a path prefix or a glob.
  - An unknown kind, or a path that matches no indexed file, is a usage error (exit 3), so a typo cannot pass the gate.
- **`deps`:**
  - There is one entry per stored edge, at the finest element the edge names (a method, or a file for an import), with the decision `mapx check` makes before any baseline.
  - Without `to`, it lists every decided edge of `from`, uncovered ones included.
  - An edge counts for each other layer of its target, as in the report's `layerEdges`. An edge into an element in both Domain and Shared is a Domain → Shared edge, so `deps L L` lists nothing.
- **`unused`:**
  - `total` counts every allowance of the expanded policy, after `+`, `*` and `!`.
  - `rule` says how the pair is granted: `explicit`, `+L` (brought by that `+`) or `*`.
  - `types` is null when the allowance covers every type in scope, and `severity` is `warn` for an advisory allowance.
  - `uses` counts the stored edges the allowance decides: allowed ones, and the warnings an advisory allowance reports. A private-layer violation does not use the allowance of its layer.
- **`changed`:**
  - Paths are workspace-relative. The index is read as it is, never re-scanned, so a file it does not have is `indexed: false`.
  - Only in-scope files contribute to `layers`.
  - `--since <ref>` adds the files git reports changed since the ref: committed, staged, unstaged and untracked, both paths of a rename, `.mapx/` excluded. Git is asked in the workspace folder and in every registered repo inside it that has the ref, so a workspace whose root is no repository works through its repos. It is an error only when no repo has the ref.
  - A dependent is another file with an edge `mapx check` evaluates into one of the files.

### `allowed`

`allowed` is the agent pre-flight check. Its answer is what `mapx check` reports for the same pair, in severity and exit code: both decide through the same function (`decideEdge`). Each end is a layer name or an element.

- **Observed dependencies.** When the index already connects the two elements, their stored edges are decided as they are, with their types and verifiability, so `policy.inferred` applies. Without `--type`, every type they have is decided. A file stands for everything it declares, and a top-level symbol for its members, as findings name them.
- **Hypothetical dependencies.** Otherwise the dependency is hypothetical and verified, over `--type`, or without one over every type in `scope.types`.
- **Decisions.** There is one decision per edge type and source layer (AR-12: every layer of the source is checked).
- **The answer** is the strictest decision: by severity (error, warn, info), then a violation before anything else. One error-level decision makes it exit 1, even when another source layer or edge type is only advisory.

```
{ from, to, edgeType, allowed, rule, severity, reason, exitCode,
  decisions: [{ edgeType, observed, verifiability, sourceLayer, allowed, rule, severity, via?, violatedLayers?, reason }],
  allowedTypes, allowedLayers,
  alternatives: [{ layer, total, symbols: [{ element, kind, symbolKind?, file, match: supertype|name }] }] }
```

- **`from`, `to`:** `{ query, kind: layer|file|symbol, element?, file?, layers, overlays, private, inScope }`.
- **`allowed`:** no decision is a violation, of any severity. **`exitCode`:** 1 when a decision is an error-level violation, as `mapx check` exits.
- **`rule`:** one of the following.
  - `allowed` (with `via`: `explicit`, `+L` or `*`).
  - `same-layer`.
  - `uncovered`: the target is in no layer. It is allowed, with severity `warn`.
  - `overlay`: the target is an overlay layer that the source layer does not deny.
  - `disallowed-layer` or `private-layer`: a violation, with severity `error`. It is `warn` for an advisory allowance, or for an inferred edge under `policy.inferred: "warn"`.
  - `unassigned-source`: the source is in no layer, so no rule applies.
  - `out-of-scope`: an end outside the scope's paths, or a `--type` outside `scope.types`.
- **`decisions[]`:**
  - `edgeType`, `verifiability` and `sourceLayer` are null only for an answer that involves no edge type (`unassigned-source`, or an end out of scope).
  - `observed` is true when the decision is on edges the index has.
- **`allowedTypes`:** the edge types decided without any violation.
- **`allowedLayers`:** the layers every source layer may depend on, through full (non-advisory) allowances for `--type`.
- **`alternatives`** (M5-14, AR-19): for a refused dependency on a file or symbol, the layers that already expose a matching symbol, in configuration order. The layers are the source's own layers and `allowedLayers`. A file target stands for its top-level symbols, and a member for its type.
  - **Matches.** A symbol matches as a `supertype` (a class or interface the target extends or implements, transitively, through stored edges) or by `name`. A name match is a top-level symbol with the target's name, or with the end of it, at least 4 characters long: `OrderRepository` for `SqlOrderRepository`.
  - **Eligible symbols.** A symbol is listed only when `allowed` from the same source to it (for `--type`, or every type in scope) is itself allowed: layers, private parts, `@internal` markers and scope all apply.
  - **The cap.** At most 10 symbols per layer are listed; `total` counts them all.
  - **When it is empty.** An allowed answer, or a layer target, has none. The text output prints them as `instead, in <layer>: …`.
- **No baseline.** No baseline applies: a baselined violation is still reported.
- **Elements must be in the index.** A file that does not exist yet cannot be named, so name its layer instead.


## MCP tools

An agent reaches the same engine through the MCP server (`mapx serve`, AR-19). Each tool answers from the functions `mapx check` and `mapx arch` use, so the CLI and MCP agree. The arguments and result shapes are in [mcp-integration.md](mcp-integration.md#architecture-rules-ar-19).

| Tool | CLI equivalent | Example arguments |
| --- | --- | --- |
| `mapx_arch_check` | `mapx check --format json` | `{ "rule": "disallowed-layer", "limit": 1 }` |
| `mapx_arch_layers` | `mapx arch layers`, `mapx arch unassigned` | `{}`, `{ "layer": "Domain", "why": true }`, `{ "unassigned": true }` |
| `mapx_arch_allowed` | `mapx arch allowed` | `{ "from": "OrderController", "to": "SqlOrderRepository" }` |
| `mapx_arch_explain` | `mapx arch which` (and `allowed` with `to`) | `{ "element": "Order", "layer": "Domain" }` |
| `mapx_arch_init` | `mapx arch init --json` | `{ "preset": "clean" }` (a dry run unless `write: true`) |
| `mapx_arch_validate_config` | `mapx arch validate-config --format json` | `{}` |

Results are JSON. A list is capped by `limit`, and the result says so: `mapx_arch_check` with `{ "rule": "disallowed-layer", "limit": 1 }` on the shop returns one finding with `"exitCode": 1, "total": 4, "limit": 1, "truncated": true`. A failure is a tool result with `isError: true` and the [exit code](#exit-codes) as `exitCode` (3 for a configuration or usage error, 4 for an index problem), never a JSON-RPC error.

The pre-flight check an agent runs before adding an import:

```
mapx_arch_allowed { "from": "OrderController", "to": "SqlOrderRepository" }
→ { "allowed": false, "rule": "disallowed-layer", "severity": "error", "exitCode": 1,
    "reason": "Controller may not depend on Infrastructure over import: no rule allows it",
    "allowedLayers": ["Domain", "Shared"],
    "alternatives": [{ "layer": "Domain", "total": 1, "symbols": [{ "element": "src/domain/OrderRepository.ts#OrderRepository", "symbolKind": "interface", "match": "supertype", … }] }], … }
```

The answer names what the rules allow instead: the `OrderRepository` interface in Domain, which `SqlOrderRepository` implements.

## MapX's own rules

MapX checks its own `src/` in CI (M5-18). The configuration is [`.mapx/architecture.jsonc`](../.mapx/architecture.jsonc), with a comment on each layer and rule. It is the module map of `docs/research/deptrac/03-mapx-gap-and-integration.md` §3.9, with the `Arch` layer added:

| Layer | Path | May use |
| --- | --- | --- |
| Entry | `src/{main,index,cli,mcp,ui-server,ui-events,ui-arch,branding}.ts` | Agents, Arch, Exporters, `+Core` |
| UI | `src/ui/**` (the dashboard's browser client) | nothing |
| Agents | `src/agents/**` | Languages |
| Arch | `src/arch/**` | `+Core`, Exporters |
| Exporters | `src/exporters/**` | Core |
| Core | `src/core/**` | Frameworks, Parsers, Languages, Arch |
| Frameworks | `src/frameworks/**` | nothing |
| Parsers | `src/parsers/**` | Languages |
| Languages | `src/languages/**` | nothing |
| Shared | `src/{types,version}.ts` | every layer may use it (`"*": ["Shared", "Packages", "!Outside"]`) |
| Packages | `{ "package": "*", "dev": false }`: npm packages `package.json` lists for production (M5-24) | every layer may use it; a dev-only package is in no layer, so importing one from `src/` is uncovered and fails the check |
| Outside (overlay) | `{tests,scripts}/**` | no layer may use it: production code never imports tests, fixtures or scripts |

- **Scope:** `src/**`, plus `tests/**` and `scripts/**` as targets only (the `Outside` overlay, which every layer denies; a file in no other layer is never a source, so tests' and scripts' own imports are not judged), imports only (`"types": ["import", "require"]`), and `policy.inferred: "ignore"`. In TypeScript every dependency on another module starts with an import, and imports are resolved by module path, so they are exact. Calls and type references are resolved by name, and some resolve to the wrong symbol (`join` from `node:path` to a private `join` in `src/core/import-resolvers.ts`), which would fail CI on code that imports nothing new.
- **Core and Arch depend on each other on purpose:** with a configuration, `core/architecture-analyzer.ts` takes its layer violations from the rules (see [Smells](#smells)). `mapx arch --smells` reports this as a `layer-cycle`.
- **The baseline,** [`.mapx/architecture.baseline.json`](../.mapx/architecture.baseline.json), holds the 8 imports that broke the rules when they were written, so CI fails only on new ones: Languages → Parsers (`languages/installer.ts` imports `parsers/assets.ts`), Agents → Parsers (`agents/generator.ts` imports `parsers/static-file-parser.ts`), Parsers ↔ Frameworks (the Vue extractors import `maskCode` and `matchBracket` from `frameworks/http/client-calls.ts`, and `frameworks/detectors/vue-router.ts` imports the Vue extractors), Frameworks → Core (`client-calls.ts` imports `core/js-aliases.ts`) and Core → Exporters (`core/workspace-summary.ts` imports the `LLMExporter` type). Fixing one leaves a stale entry, and the check fails until the baseline is regenerated: `mapx check --generate-baseline`.
- **Only the configuration and the baseline are tracked.** The rest of `.mapx/`, the index included, stays ignored (D030) through a narrow negation in `.gitignore`.

The CI job (`Architecture` in `.github/workflows/ci.yml`) builds MapX, indexes the checkout and runs the check:

```yaml
- run: npm run build:npm
- run: |
    node dist/main.js init . --no-agents --no-suggestions --no-mcp-configs
    node dist/main.js scan .
- run: node dist/main.js check --fail-on-uncovered --format github
- run: node dist/main.js check --fail-on-uncovered --report-skipped --format sarif -o mapx-architecture.sarif
  continue-on-error: true
- uses: actions/upload-artifact@v4
  with:
    name: architecture-sarif
    path: mapx-architecture.sarif
```

`--format github` annotates a new violation on the pull request, and `--fail-on-uncovered` also fails a dependency on `src/` code in no layer (a new top-level folder, say), so the layers keep covering the source. The SARIF report is kept as an artifact rather than uploaded to code scanning, which would need `security-events: write`, a permission pull requests from forks never get. A forbidden import fails the job:

```
[error] src/frameworks/utils.ts:3 disallowed-layer: src/frameworks/utils.ts must not depend on src/exporters/llm-exporter.ts (Frameworks on Exporters) [import]
::error file=src/frameworks/utils.ts,line=3,title=disallowed-layer::src/frameworks/utils.ts must not depend on src/exporters/llm-exporter.ts (Frameworks on Exporters) [import]
Violations: 1 (1 error, 0 warn)   Uncovered: 0   Skipped: 8   Allowed: 227   Warnings: 0   Errors: 0
```

To run it locally: `npm run build:npm`, `node dist/main.js init . --no-agents --no-suggestions --no-mcp-configs`, `node dist/main.js scan .`, then `node dist/main.js check` (or `check --sync` after editing).
