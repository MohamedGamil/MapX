# Adding Languages

MapxGraph supports three tiers of language support. All tiers use tree-sitter WASM grammars and `.scm` query files for symbol and reference extraction.

## Tier 1: Built-in Languages

PHP, JavaScript, TypeScript, Python, Go, Rust, Java, and C# are built-in and always available. Their tree-sitter WASM grammars and queries are bundled with the tool at relative paths (`wasm/` and `queries/`).

## Tier 2: Bundled Languages

Ruby, C, C++, Swift, Kotlin, Dart, Scala, and Vue are bundled — their WASM grammars and queries ship with the tool and are available without any `mapx lang install` step. They use relative paths just like built-in languages.

## Tier 3: Installable Languages

Svelte, Lua, Elixir, Zig, Bash, and Pascal are installable. Use the CLI to manage them:

```bash
mapx lang list           # See all languages and their status
mapx lang install lua    # Install Lua grammar
mapx lang uninstall lua  # Remove Lua grammar
```

Installed grammars are stored in `~/.mapx/grammars/` and their queries in `~/.mapx/grammars/queries/<lang>/`.

## Tier 4: User-Defined Languages

Users can add entirely custom languages via `.mapx/config.json` without modifying the tool:

```json
{
  "languages": {
    "haskell": {
      "extensions": [".hs"],
      "grammarWasm": "./grammars/tree-sitter-haskell.wasm",
      "queries": {
        "symbols": "./queries/haskell/symbols.scm",
        "references": "./queries/haskell/references.scm"
      },
      "nodeMappings": {
        "function": "function",
        "class": "type_class_declaration",
        "module": "module"
      }
    }
  }
}
```

## Writing Query Files

The `GenericWasmParser` handles all query-driven languages. It looks for two capture name patterns:

### Symbol Queries (`symbols.scm`)

Use `@symbol.kind_<type>` captures where `<type>` is one of the `SymbolKind` values:

```
class | method | function | interface | trait | constant | enum | property | namespace | struct | module | field
```

Example (Python):
```scheme
; Classes
(class_definition
  name: (identifier) @symbol.name) @symbol.kind_class

; Functions
(function_definition
  name: (identifier) @symbol.name) @symbol.kind_function

; Constants (module-level assignments)
(expression_statement
  (assignment
    left: (identifier) @symbol.name)) @symbol.kind_constant
```

You can also use `@symbol.scope` to set the parent scope of a symbol:
```scheme
; Go method with receiver type as scope
(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: (type_identifier) @symbol.scope))
  name: (field_identifier) @symbol.name
) @symbol.kind_method
```

### Reference Queries (`references.scm`)

Use `@ref.target_<type>` captures where `<type>` is a reference type:

```
import | require | extends | implements | call | instantiation
```

Example (Ruby):
```scheme
; require 'foo'
(call
  method: (identifier) @_req
  arguments: (argument_list (string (string_content) @ref.target_require))
  (#eq? @_req "require")) @ref.type_require

; Class inheritance: class Foo < Bar
(class
  superclass: (constant) @ref.target_extends) @ref.type_extends

; Method calls
(call
  method: (identifier) @ref.target_call) @ref.type_call

; Instantiation: ClassName.new
(call
  method: (identifier) @_new
  receiver: (constant) @ref.target_instantiation
  (#eq? @_new "new")) @ref.type_instantiation
```

### Using Predicates

Tree-sitter queries support `#eq?` and `#match?` predicates for precision:

```scheme
; Only match specific method names
(call
  method: (identifier) @_attr_method
  (#match? @_attr_method "^attr_(reader|writer|accessor)$")
  arguments: (argument_list
    (simple_symbol) @symbol.name)) @symbol.kind_property

; Match exact keyword
(call
  target: (identifier) @_def
  (#eq? @_def "defmodule")
  arguments: (arguments (alias) @symbol.name)) @symbol.kind_module
```

## Node Mappings

The `nodeMappings` in `registry.ts` tell the parser which AST node types correspond to which symbol kinds. This is used for:

- **Scope resolution**: Determining if a function is inside a class → auto-promote to method
- **Container detection**: Knowing which nodes are "containers" (classes, modules, structs)
- **Signature extraction**: Pattern-matching source lines based on symbol kind

Every `SymbolKind` that appears in your `symbols.scm` should have a corresponding entry in `nodeMappings`.

## Adding a New Built-in Language

1. **Get the WASM grammar** and place it in `wasm/tree-sitter-<lang>.wasm`

2. **Create query files** in `queries/<lang>/symbols.scm` and `queries/<lang>/references.scm`

3. **Register in `src/languages/registry.ts`:**
   ```typescript
   mylang: {
     name: 'mylang',
     extensions: ['.ml'],
     grammarWasm: 'wasm/tree-sitter-mylang.wasm',
     queries: {
       symbols: 'queries/mylang/symbols.scm',
       references: 'queries/mylang/references.scm',
     },
     nodeMappings: {
       class: 'class_definition',
       function: 'function_definition',
       // ... all symbol kinds your queries capture
     },
     tier: 'built-in', // or 'bundled' / 'installable'
   },
   ```

4. **No parser class needed** — the `GenericWasmParser` handles everything automatically based on your query files.

## Finding Node Types

To discover the correct node type names for a new language:

```bash
node -e "
import('web-tree-sitter').then(async m => {
  await m.Parser.init();
  const p = new m.Parser();
  const { readFileSync } = await import('fs');
  const wasm = readFileSync('wasm/tree-sitter-YOUR-LANG.wasm');
  const lang = await m.Language.load(wasm);
  p.setLanguage(lang);
  const code = 'your sample code here';
  const tree = p.parse(code);
  function walk(node, depth = 0) {
    if (depth > 5) return;
    console.log('  '.repeat(depth) + node.type);
    for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1);
  }
  walk(tree.rootNode);
});
"
```

This prints the full tree structure so you can identify the correct node types for your queries.
