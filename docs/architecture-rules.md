# Architecture rules (in progress)

MapX is gaining Deptrac-style architecture rules for every language it indexes (milestone M5). You declare **layers** with **selectors**, and a **policy** of which layers may depend on which. `mapx check` will then report every dependency that breaks the policy. The design is in `docs/research/deptrac/02-abstract-feature-model.md`.

What exists so far:

- **The configuration document** (M5-02): its schema, loading, `extends`, parameters, views and validation.
- **The element view, the core selectors and layer membership** (M5-03).
- **Rule evaluation and the report** (M5-04): policy expansion, the evaluation chain, findings with fingerprints, and the layer matrix.
- **`mapx check`** (M5-05): the table and JSON reporters, and the exit contract. See [cli-reference.md](cli-reference.md#mapx-check).
- **`mapx arch validate-config`** and the MCP tool `mapx_arch_validate_config` (M5-02-R1): validate the configuration alone, without an index.
- **Baselines and the `--compare` ratchet** (M5-06): see [Baselines and the ratchet](#baselines-and-the-ratchet). These are CLI only for now: `mapx check` has no MCP tool yet (M5-14).

CI reporters, introspection commands and `@internal` markers come in M5-07 to M5-11.

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

A scan stores each symbol's decorators, attributes or annotations, and its doc-block tags, for PHP, TypeScript, JavaScript (with Vue and Svelte script blocks), Python, Java, Kotlin and C#. Other languages store none yet, so these selectors never match their symbols.

| Language | Decorators | Doc tags |
| --- | --- | --- |
| PHP | `#[Attr]`, `#[Attr(…)]`, several per group. The name is resolved like a class name, through `use` and the namespace (`#[ORM\Entity]` → `Doctrine\ORM\Mapping\Entity`), and the name as written is kept too when it differs (`ORM\Entity`, an alias) | PHPDoc `/** … */` block tags, Doctrine-style `@Route(…)` included |
| TypeScript, JavaScript | `@dec`, `@dec(…)`, `@a.b` on classes (before or after `export`), methods, fields and accessors | JSDoc/TSDoc block tags; a function's overload signatures give theirs to the implementation |
| Python | `@dec`, `@dec(…)`, `@app.route(…)` on `def` and `class` | docstring directives (`.. deprecated:: 2.0`) and `@tag` lines |
| Java, Kotlin | `@Ann`, `@Ann(…)`, `@a.b.Ann`, each of Kotlin's `@[A B]` | Javadoc and KDoc block tags |
| C# | `[Attr]`, `[Attr(…)]`, several per list; not `[return: …]`, `[param: …]`, `[field: …]` and other targets that name something else | XML doc `///` elements, as `@remarks`, `@param` and so on; `<summary>` is the description and `<code>` a sample, neither a tag |

A block tag starts a line of the doc comment (after the leading `*`), so an inline `{@link X}` is not a tag. Its value runs to the next tag. Decorator names keep their qualifier as written (`app.route`, `System.Obsolete`), except in PHP, where they are fully qualified. Parameter decorators are not stored. Comments between decorators, or between the doc comment and the declaration (`// eslint-disable-next-line`), are passed over; code is not.

**Code samples are never tags.** These are text:
- lines in a ```` ``` ```` fence, a `<pre>…</pre>` block or a multi-line `{@code …}`;
- everything after `@example`, which is that tag's value to the end of the comment (so put `@example` last);
- C# `<code>`;
- in a Python docstring, a literal block (the lines indented under a paragraph ending in `::`) and doctest examples (from `>>>` to the next blank line).

**A doc comment attaches to the next declaration, even across blank lines,** as TypeScript and Javadoc tooling do. A file-header block (`/** @license MIT */` or `/** @internal */` at the top of a file) therefore becomes the first declaration's tags. Keep `@internal` and similar markers out of file headers, or the first class of the file is marked.

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
