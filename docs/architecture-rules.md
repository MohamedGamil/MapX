# Architecture rules (in progress)

MapX is gaining Deptrac-style architecture rules for every language it indexes (milestone M5). You declare **layers** with **selectors**, and a **policy** of which layers may depend on which. `mapx check` will then report every dependency that breaks the policy. The design is in `docs/research/deptrac/02-abstract-feature-model.md`.

What exists so far:

- **The configuration document** (M5-02): its schema, loading, `extends`, parameters, views and validation.
- **The element view, the core selectors and layer membership** (M5-03).

Rule evaluation, `mapx check`, reports and baselines come in M5-04 to M5-08.

## The configuration document

Put the configuration in `.mapx/architecture.jsonc`. Views go in `.mapx/architecture/<view>.jsonc`. The format is JSON with comments and trailing commas. Point `$schema` at `schemas/architecture.schema.json`, which the npm package ships, for editor completion:

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

**`%name%`** is replaced in `name`, `path` and `package` values from the merged `parameters`.

**Validation reports every problem at once.** Each problem names its file and a JSON pointer, in document order. Validation catches:

- unknown keys (a typo such as `"paht"`), wrong types, unknown edge types and symbol kinds;
- a selector with no primary key, or with several primary keys (combine those with `all`);
- an unknown layer in rules, `layer` selectors or report groups. It suggests the closest name: `did you mean "Http"?`;
- an overlay layer used as a rule source;
- `+` cycles, named: `"+" allowances form a cycle: Service → Repo → Service`;
- circular `extends`, a missing extended file, an unknown preset, a parameter without a value, and a regular expression that does not compile.

## Elements and qualified names

Selectors match **elements**: every indexed file, and every symbol in it (classes, functions, methods and so on). A symbol's **qualified name** is how a `name` selector sees it:

| Language | Qualified name of `Order.run` | From |
| --- | --- | --- |
| PHP | `App\Domain\Order::run` | the file's `namespace` |
| Java, Kotlin, Scala | `com.acme.domain.Order.run` | the `package` declaration |
| C# | `Acme.Domain.Order.run` | the `namespace` declaration |
| Dart | `acme.domain.Order.run` | the library name |
| C++ | `acme::domain::Order::run` | the `namespace` |
| Go | `example.com/shop/domain.Order.Run` | `go.mod`'s module plus the package directory |
| Python | `app.domain.order.Order.run` | the module path; `src/` and `__init__` are dropped |
| Rust | `crate::domain::order::Order::run` | the module path; `lib.rs`, `main.rs` and `mod.rs` name their directory |
| Ruby | `Billing::Invoice` | module nesting |
| Elixir | `Billing.Invoice` | module names |
| JavaScript, TypeScript, TSX, Vue, Svelte, Swift, C, Lua, Zig, Bash, Fish, Pascal, Markdown, HTML, CSS, JSON, YAML | `src/domain/Order.ts#Order.run` | the workspace-relative path |

A namespace language whose file declares no namespace (a PHP file with only functions, say) falls back to the path form. Kotlin's package is not captured yet, so Kotlin uses the path form.

## Selectors

A selector object has exactly one primary key, plus the modifiers that refine it. An element is in a layer when **any** of the layer's selectors matches it.

| Selector | Matches | Evaluated on |
| --- | --- | --- |
| `path` | a glob (picomatch, dotfiles included) or `/regex/flags` on the workspace-relative path | the file |
| `name` (+ `kind`) | a regex on the qualified name: case-insensitive unless written `/…/flags`, optionally only these symbol kinds | symbols only |
| `repo` | a registered repo, by name or glob | the file |
| `language` | the file's language; `ts`, `js`, `py`, `c#` and the like are accepted | the file |
| `role` (+ `confidence`) | the MapX role of the file, optionally at a minimum classifier confidence | the file |
| `cluster` | a MapX cluster the file is in, by name or glob | the file |
| `workspacePackage` | the name in the nearest `package.json`, `composer.json`, `pyproject.toml`, `go.mod` or `Cargo.toml`, by name or glob | the file |
| `framework` | a framework part read from stored edges: `route-handler` (target of a `route` or `http` edge), `middleware`, `model` (source of a `relation` edge), `job` and `event` (targets of `dispatch`), `listener` (target of `notify`), `resolver`, `component` (target of `render`), `http-client` (source of `http`) | the file |
| `layer` | membership in another layer | the element |
| `all`, `any`, `not` | composition | |

Not evaluated yet: these never match, and membership lists them as unsupported.

| Selectors | Task that adds them |
| --- | --- |
| `extends`, `implements`, `inherits`, `mixes`, `inheritanceDepth`, `member` | M5-09 |
| `decorator`, `docTag` | M5-10 |
| `package` | M5-24 (attribution M5-20 … M5-23) |
| `builtin` | M5-24 |
| `ambient` | M5-24 |

## Membership

- **Symbols.** A symbol is in the layers whose selectors match it. File-level selectors (`path`, `repo` and the like) judge a symbol by its file, so a `path` layer covers every symbol under its directory.
- **Files.** A file is in the layers whose selectors match the file, plus the layers of its top-level symbols. A `name` layer can therefore single out one class of a multi-class file, and still claim the file for dependencies that only name the file.
- **No flow between symbols.** One symbol's layer never passes to another symbol.
- **Several layers.** An element in more than one non-overlay layer will get a `multi-layer` warning. A non-overlay layer that matches nothing will get an `empty-layer` warning.
- **Private parts.** A layer's `private` selectors mark the elements only that layer may reach.
- **Explanations.** Membership records why an element is in a layer: the selector position (`selectors[0].name`), and for a file the top-level symbol that put it there.
- **Caching.** Membership is computed once per scan and configuration.
