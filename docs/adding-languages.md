# Adding Languages

MapxGraph supports two tiers of pre-configured language support and a third tier for custom user-defined languages. All tiers use tree-sitter WASM grammars and `.scm` query files for symbol and reference extraction.

## Tier 1: Built-in Languages (Dedicated Parsers)

PHP, JavaScript, TypeScript, and Vue are built-in and always available. They use dedicated, language-specific parser implementations for enhanced analysis. Their tree-sitter WASM grammars and queries are bundled with the tool at relative paths (`wasm/` and `queries/`).

## Tier 2: Bundled Languages (Generic WASM Parsers)

Python, Go, Rust, Java, C#, Ruby, C, C++, Swift, Kotlin, Dart, Scala, Lua, Elixir, Zig, Bash, Fish, and Pascal are bundled — their WASM grammars and queries ship with the tool and are available out-of-the-box. They use relative paths and are parsed dynamically via the `GenericWasmParser` base class. Svelte is bundled too, but like Vue it has a dedicated parser (`src/parsers/languages/svelte.ts`) that hands each `<script>` block to the JavaScript or TypeScript parser.

Most grammars come from their npm packages. The fish grammar is not on npm: `npm run build:wasm` builds it from the pinned upstream archive, [ram02z/tree-sitter-fish](https://github.com/ram02z/tree-sitter-fish) 3.7.0 (Unlicense), with `tree-sitter build --wasm` (emscripten, or docker when emscripten is not installed).

## Tier 3: User-Defined Languages

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

#### Constants as call targets

`call` and `instantiation` references resolve by name. In JavaScript, TypeScript and Python they skip `constant` and `variable` symbols, because `GenericWasmParser` gives every possibly callable module-level binding another kind:

- a function value (`const f = () => …`, `= function () {}`, Python `= lambda …`) is a `function`;
- a call, a name or a member (`export const useAppSelector = useSelector`, `= createAsyncThunk(…)`, `= create(…)`, `= store.dispatch`, Python `= functools.partial(…)`) is a `function` too: a factory may return a callable, so calls must reach it;
- a class expression (`export const Klass = class {}`) is a `class`, so `new Klass()` reaches it.

Only a literal value stays a `constant` or `variable`: strings, numbers, booleans, objects, arrays, templates, operator expressions over them and `new X()`. Two exceptions: bindings in a Vue SFC stay values, because `const total = computed(…)` is reactive state and Vue value declarations own no references; and a function value declared inside a function or a block (`if (x) { const f = () => 1 }`) is no symbol at all.

Because call-made bindings are call targets, a call on a parameter or a plain local variable of the same name would reach them by name. So in JavaScript, TypeScript (outside Vue SFCs) and Python, `fetchUser()` makes no reference when `fetchUser` is a parameter (plain, typed, defaulted or rest) of an enclosing function, or a `const`/`let`/`var` (Python: an assignment) in an enclosing function or block. Destructured parameters and locals are not followed: `({ loadLanguage }) => loadLanguage()` over a dynamic import names the module's function, and the Vue store and composable passes resolve `const { reset } = useStore()` themselves.

In every other language a `constant` stays a call target, because there it can be callable: C function-like macros, Rust tuple variants, Lua `local f = function … end` and Bash aliases. If a new language's constants and variables are never callable, add it to `VALUE_SYMBOL_LANGUAGES` in `src/core/scanner.ts`.

#### Qualified names

A C++ out-of-line definition is a method named by its innermost name and scoped by the innermost qualifier, at any depth: `void a::b::c::D::g()` is `D::g`, `ns::K::~K()` is `K::~K` (a destructor keeps its tilde). A Go embedded type qualified by a package (`struct { log.Logger }`) is an `extends` reference that carries the import path of its package (`metadata.goPackage`). The scanner links it only to the type declared in that package's directory when the import resolves to a project package (through `go.mod`). A standard-library or third-party package links nothing, even if the project has a type with the same name.

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
     tier: 'bundled', // or 'built-in' (dedicated parser) / 'static' (no grammar)
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
