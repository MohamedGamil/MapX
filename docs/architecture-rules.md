# Architecture rules (in progress)

MapX is gaining Deptrac-style architecture rules for every language it indexes (milestone M5). You declare **layers** with **selectors**, and a **policy** of which layers may depend on which. `mapx check` will then report every dependency that breaks the policy. The design is in `docs/research/deptrac/02-abstract-feature-model.md`.

What exists so far:

- **The configuration document** (M5-02): its schema, loading, `extends`, parameters, views and validation.
- **The element view, the core selectors and layer membership** (M5-03).
- **Rule evaluation and the report** (M5-04): policy expansion, the evaluation chain, findings with fingerprints, and the layer matrix.
- **`mapx check`** (M5-05): the table and JSON reporters, and the exit contract. See [cli-reference.md](cli-reference.md#mapx-check).
- **`mapx arch validate-config`** and the MCP tool `mapx_arch_validate_config` (M5-02-R1): validate the configuration alone, without an index.
- **Baselines and the `--compare` ratchet** (M5-06): see [Baselines and the ratchet](#baselines-and-the-ratchet). These are CLI only for now: `mapx check` has no MCP tool yet (M5-14).
- **Introspection** (M5-08): `mapx arch layers`, `which`, `unassigned`, `deps`, `unused`, `changed` and `allowed`. See [Introspection](#introspection). They are CLI only until M5-14.
- **CI reports** (M5-07): `--format sarif`, `github` (automatic inside GitHub Actions), `codeclimate` and `junit`. See [CI reports](#ci-reports).

`@internal` markers come in M5-09 to M5-11.

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
| `layer` | membership in another layer | the element |
| `all`, `any`, `not` | composition | |

**Symbol-level selectors on files.** A `name`, `decorator` or `docTag` selector does not apply to a file. It is not a match, and neither is `not` of it, so `{ "all": [{ "path": "app/**" }, { "not": { "name": "Controller$" } }] }` never puts a file in a layer by itself. The file joins the layer only through a top-level symbol that is in it (see Membership). `all`, `any` and `not` use three-valued logic. `all` is inapplicable when no branch fails and one is inapplicable. `any` is inapplicable when no branch matches and one is inapplicable. So `{ "not": { "any": [{ "name": "Controller$" }, { "path": "app/Legacy/**" }] } }` does not select a file either.

Not evaluated yet: these never match, `not` of them never matches either, and membership lists them as unsupported.

| Selectors | Task that adds them |
| --- | --- |
| `extends`, `implements`, `inherits`, `mixes`, `inheritanceDepth`, `member` | M5-09 |
| `package` | M5-24 (attribution M5-20 … M5-23) |
| `builtin` | M5-24 |
| `ambient` | M5-24 |

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

## The report

`mapx check --format json` prints this report, described by `schemas/arch-report.schema.json`. It comes from `runArchitecture(dir)` in `src/arch/report.ts`. Uncovered, skipped and allowed findings are listed only with `--report-uncovered`, `--report-skipped` or `--report-allowed`; `counts` always includes them:

- **`findings`:** one per dependency, edge type and rule. A source in several layers gets one finding whose `source.layer` lists them. Each has a `kind` (`violation`, `skipped`, `uncovered`, `allowed`, `warning`, `error`), a `rule`, a `severity`, the `source` and `target` (element, file, layer, repo, first line), the `edgeType`, `verifiability`, the number of `edges` it stands for, a `fingerprint` and a `message`. A `skipped` finding says why in `skippedBy`: `baseline` or `compare`. A finding whose fingerprint inputs differ from the elements it shows has an `identity`; see [Fingerprints](#fingerprints).
- **`fingerprint`:** a hash of the rule, both elements and the edge type, with no line number, so it survives edits that move code. See [Fingerprints](#fingerprints).
- **Warnings:**
  - `multi-layer`, for a top-level declaration in several non-overlay layers. It is an error under `policy.strictLayers`. A symbol-less file gets one only when it is a dependency end;
  - `empty-layer`, for a non-overlay layer that matches nothing;
  - `unsupported-selector`, for a selector this version cannot evaluate yet. It matches nothing.
- **Errors:** an invalid configuration gives `error` findings, `plus-cycle` for a `+` cycle (naming its first layer) and `config` for the rest. A baseline entry that matches nothing is a `stale-baseline` error.
- **`layers`:** elements and files per layer.
- **`layerEdges`:** allowed, violating and skipped dependencies per layer pair.
- **`counts`:** per kind.
- **`selection`** (from `mapx check`): the `view`, `layer` and `rule` the run evaluated and kept, `null` when not given.

A workspace with a configuration but no index is an error (`run mapx scan first`), never an empty report.

## CI reports

`mapx check --format` also writes the formats CI systems read natively. The code is in `src/arch/reporters/`; the mapping of every finding kind is in [cli-reference.md](cli-reference.md#ci-formats).

| Format | For | Notes |
| --- | --- | --- |
| `sarif` | GitHub code scanning (`github/codeql-action/upload-sarif`), IDE SARIF viewers | SARIF 2.1.0; skipped violations are suppressed (`external`, accepted); `partialFingerprints["mapx/v1"]` is the finding's fingerprint. GitHub accepts up to 10 MB (compressed) and 25,000 results per run |
| `github` | GitHub Actions annotations on the pull request | Chosen automatically when `GITHUB_ACTIONS` is `true`, no `--format` is given and the report goes to stdout. The run's causes are annotated first (GitHub shows 10 per level and step); every finding is also a log line |
| `codeclimate` | GitLab Code Quality (`artifacts:reports:codequality`) | A violation's issue fingerprint is the finding's fingerprint; other kinds derive one from kind and rule; severities from `report.codeclimate` |
| `junit` | GitLab and Jenkins test reports | One suite per layer, one testcase per finding; a testcase fails exactly when its finding fails the run |

- **Failing level:** every format marks exactly the findings that fail the run (the exit-code rule, with `--fail-on`, `--fail-on-uncovered` and `--compare`) at its failing level: SARIF `error`, `::error`, the CodeClimate `error` severity, a JUnit failure or error. So the cause of exit 1, 2 or 3 is always shown as an error.
- **Paths** are workspace-relative and use `/` in every format; a finding without a file is located on the configuration file. Run `mapx check` at the repository root so CI links the right file.
- **Determinism:** the same findings give the same bytes: no timestamps, durations, host names or absolute paths. Only SARIF's `tool.driver.version` changes with the MapX version.
- **Baselines and `--compare`:** a skipped violation is a SARIF suppression, a `::notice`, a CodeClimate issue at the `skipped` severity and a JUnit `<skipped>`, listed only with `--report-skipped`. A stale baseline entry is an error located on the baseline file (relative to the workspace, never absolute), its message naming the entry by JSON pointer (`.mapx/architecture.baseline.json#/entries/0`); the report gives it as `location`.

**The CodeClimate severity map.** `report.codeclimate` maps what a finding is to a CodeClimate severity (`info`, `minor`, `major`, `critical`, `blocker`). `error` is for the findings that fail the run. Other violations and warnings (an advisory rule, `"severity": "warn"`, or an inferred edge under `policy.inferred: "warn"`, without `--fail-on warn`) are `warn`; uncovered dependencies (without `--fail-on-uncovered`) and skipped violations are keyed by kind. Keys left out keep the defaults below, and an `extends` chain merges the map key by key. An unknown key or severity is a configuration error (exit 3).

```jsonc
{
  "report": {
    // the defaults: a failure is major, a skipped violation minor, an uncovered dependency info (as Deptrac)
    "codeclimate": { "error": "major", "warn": "minor", "uncovered": "info", "skipped": "minor" }
  }
}
```

A GitHub Actions job, as an example:

```yaml
- run: npx @mgamil/mapx scan && npx @mgamil/mapx check   # annotations, since GITHUB_ACTIONS is set
- run: npx @mgamil/mapx check --format sarif -o mapx.sarif
  if: always()
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: mapx.sarif
```

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

`--since <git-ref>`, which would scan the ref itself, is deferred (REQ-ARCH-021).

## Introspection

The `mapx arch` subcommands answer questions about the configuration from the index (AR-13, Deptrac's `debug:*` commands). Their options and exit codes are in [cli-reference.md](cli-reference.md#mapx-arch-introspection-subcommands). With `--format json` each prints the object the matching function of `src/arch/introspect.ts` returns, which the MCP tools will share (M5-14).

- **Elements.** An element is `{ element, kind, symbolKind?, file }`: `element` is a symbol's qualified name or a file's path, and `kind` is `file` or `symbol`.
- **Errors.** Every failure prints `{ "error": "…" }` on stdout in JSON, whatever its exit code. An ambiguous name or an unknown layer adds `candidates`, and an invalid configuration adds `issues: [{ file, pointer, message }]`.
- **Scope.** `scope.include` and `scope.exclude` apply as in `mapx check`. An element outside them takes part in no evaluated edge.

| Subcommand | Question | JSON |
| --- | --- | --- |
| `layers` | Which layers are there, and how big? | `{ layers: [{ name, overlay, elements, files }] }`, counted as `mapx check` counts them: every element, and the files among them |
| `layers <layer> [--why]` | Which elements are in this layer? | `{ name, overlay, elements, files, total, members: [element] }`. See below |
| `which <element>` | Which layers is this element in, and why? | `{ query, matches: [{ …element, layers, private, trace: [{ layer, selector, via }], inScope }] }`. See below |
| `unassigned` | What is in no layer? | `{ total, elements: [element] }`. See below. **Exit 2** when `total` is not 0 |
| `deps <from> [to]` | Which concrete edges go from one layer to another? | `{ from, to, counts: { allowed, violation, uncovered }, dependencies: [{ source: { …element, line }, target, targetLayers, edgeType, verifiability, kind, rule?, severity, violatedLayers? }] }`. See below |
| `unused [--limit N]` | Which allowances are used at most N times (default 0)? | `{ limit, total, allowances: [{ from, to, rule, types, severity, uses }] }`. See below |
| `changed [files…] [--since <ref>] [--with-dependents]` | Which layers do these files touch, and which layers depend on them? | `{ files: [{ file, indexed, inScope, layers }], layers, dependents?: [{ layer, files }], unassignedDependents? }`. See below |
| `allowed <from> <to> [--type T]` | Would a dependency from `from` to `to` pass `mapx check`? | Described below. **Exit 1** when `mapx check` would fail on it |

- **`layers <layer>`:**
  - Members are files and top-level symbols; `--nested` adds every symbol.
  - `--why` adds `selector`, the position that matched (`selectors[0].all`), and `via`: `self`, or the top-level symbol that put a file in the layer.
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
  allowedTypes, allowedLayers }
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
- **`allowedLayers`:** the layers every source layer may depend on, through full (non-advisory) allowances for `--type`. These are the alternatives.
- **No baseline.** No baseline applies: a baselined violation is still reported.
- **Elements must be in the index.** A file that does not exist yet cannot be named, so name its layer instead.

