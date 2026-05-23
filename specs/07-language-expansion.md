# Language Expansion — Overview

## Current state

mapx ships with 3 built-in languages: **PHP**, **JavaScript**, **TypeScript**.

Each language is supported by:
1. A [tree-sitter](https://tree-sitter.github.io/tree-sitter/) WASM grammar (`wasm/tree-sitter-<lang>.wasm`)
2. Two tree-sitter query files (`queries/<lang>/symbols.scm`, `queries/<lang>/references.scm`)
3. A language definition in `src/languages/registry.ts` (extensions, grammar path, node mappings)
4. A parser class in `src/parsers/languages/<lang>.ts`

The 3 existing parsers are structurally identical — they differ only in how they build signatures and track scope. A **GenericWasmParser** can cover the majority of new languages without writing a new class per language.

---

## Target languages

| Priority | Languages |
|----------|-----------|
| Tier 1 — built-in | Python, Go, Rust, Java, C# |
| Tier 2 — bundled | Ruby, C, C++, Swift, Kotlin, Scala, Dart |
| Tier 3 — installable | Svelte, Vue2/Vue3, Lua/Luau, Elixir, Zig, Bash/Shell, Pascal/Delphi |

**Tier 1** languages ship inside the mapx binary (WASM bundled).
**Tier 2** languages are distributed in the mapx standard package but loaded on first use.
**Tier 3** languages require `mapx lang install <name>` (downloads WASM at runtime from the mapx CDN or npm).

---

## Architecture changes

### GenericWasmParser

The current `PhpParser`, `JavaScriptParser`, and `TypeScriptParser` are nearly identical boilerplate. `GenericWasmParser` extracts the common pattern into a single reusable class parameterized by `LanguageDefinition`.

```
src/parsers/generic-wasm-parser.ts    ← new
src/parsers/languages/python.ts       ← thin subclass (scope tracking override)
src/parsers/languages/go.ts           ← thin subclass (receiver → method detection)
src/parsers/languages/rust.ts         ← thin subclass (impl block → method scope)
src/parsers/languages/java.ts         ← GenericWasmParser directly (no override needed)
src/parsers/languages/csharp.ts       ← thin subclass
src/parsers/languages/ruby.ts         ← thin subclass
src/parsers/languages/c.ts            ← GenericWasmParser
src/parsers/languages/cpp.ts          ← thin subclass
src/parsers/languages/swift.ts        ← thin subclass
src/parsers/languages/kotlin.ts       ← thin subclass
src/parsers/languages/scala.ts        ← thin subclass
src/parsers/languages/dart.ts         ← thin subclass
src/parsers/languages/svelte.ts       ← specialized (mixed HTML/JS)
src/parsers/languages/vue.ts          ← specialized (mixed HTML/JS, Options API)
src/parsers/languages/lua.ts          ← thin subclass
src/parsers/languages/elixir.ts       ← thin subclass
src/parsers/languages/zig.ts          ← GenericWasmParser
src/parsers/languages/bash.ts         ← GenericWasmParser (functions only)
src/parsers/languages/pascal.ts       ← thin subclass
```

### Language tier system

`LanguageDefinition.tier` currently has values `'built-in' | 'installable' | 'user'`. Extended to `'built-in' | 'bundled' | 'installable' | 'user'`.

- `built-in`: WASM bundled in the binary/package (`wasm/` directory)
- `bundled`: WASM included in the npm package but not the standalone binary
- `installable`: WASM downloaded on demand via `mapx lang install`
- `user`: user-provided WASM (existing custom language mechanism)

### `mapx lang install` command

New CLI subcommand for Tier 3 languages:

```bash
mapx lang install svelte           # downloads tree-sitter-svelte.wasm to ~/.mapx/grammars/
mapx lang install vue
mapx lang install all              # installs all supported installable languages
mapx lang list                     # shows all languages + install status
mapx lang uninstall elixir
```

WASM files are cached in `~/.mapx/grammars/` (or `%APPDATA%/mapx/grammars/` on Windows).

---

## Symbol kinds per language

All languages map their constructs onto the existing `SymbolKind` set:

```typescript
type SymbolKind =
  | 'class'       // class, struct, interface type, record
  | 'method'      // function/procedure scoped to a type/class
  | 'function'    // top-level / standalone function
  | 'interface'   // interface, protocol, trait
  | 'trait'       // mixin, trait (when distinct from interface)
  | 'constant'    // const, val, macro, typedef
  | 'enum'        // enum type
  | 'property'    // field, attribute, prop
  | 'namespace'   // module, package, namespace, unit
```

Where a language has no equivalent for a kind, the kind is omitted (empty `nodeMappings` entry, same as current JS `trait: ''`).

---

## Per-language symbol mapping

| Language | class | method | function | interface | trait | constant | enum | property | namespace |
|----------|-------|--------|----------|-----------|-------|----------|------|----------|-----------|
| Python | class_definition | method inside class | function_definition | Protocol class | — | ALL_CAPS assignment | — | — | — |
| Go | struct type_spec | method_declaration | function_declaration | interface type_spec | — | const_spec | — | — | package_clause |
| Rust | struct_item | fn in impl_item | function_item | trait_item | — | const_item | enum_item | — | mod_item |
| Java | class_declaration | method_declaration | — | interface_declaration | — | field_declaration (final static) | enum_declaration | field_declaration | package_declaration |
| C# | class_declaration | method_declaration | — | interface_declaration | — | const_declaration | enum_declaration | property_declaration | namespace_declaration |
| Ruby | class | method/singleton_method | — | — | module (trait) | constant | — | — | module (ns) |
| C | — | — | function_definition | — | — | preproc_def | enum_specifier | — | — |
| C++ | class_specifier | (function in class scope) | function_definition | — | — | — | enum_specifier | field_declaration | namespace_definition |
| Swift | class_declaration | func in class | function_declaration | protocol_declaration | — | — | enum_declaration | — | — |
| Kotlin | class_declaration | function (in class) | function_declaration | interface_declaration | — | — | enum class | — | — |
| Scala | class_definition | def in class | def (top-level) | — | trait_definition | val_definition | enum (Scala 3) | — | object_definition |
| Dart | class_definition | method_signature | function_declaration | — | mixin_declaration | — | enum_declaration | — | — |
| Svelte | (component = file) | — | function in script | — | — | const in script | — | — | — |
| Vue | (component = file) | — | method in methods block | — | — | const in setup | — | prop in props | — |
| Lua | (table assignment) | table:method | function_declaration | — | — | — | — | — | — |
| Elixir | (defmodule) | def/defp in module | def/defp | — | — | — | — | — | defmodule |
| Zig | struct_decl | fn in struct | fn_decl | — | — | const_decl | enum_decl | — | — |
| Bash/Shell | — | — | function_definition | — | — | — | — | — | — |
| Pascal/Delphi | class_type | procedure/function in class | procedure/function | interface_type | — | const_section | enum_type | — | unit_declaration |

---

## Reference / import patterns per language

| Language | Import syntax | Tree-sitter node |
|----------|--------------|-----------------|
| Python | `import x`, `from x import y` | `import_statement`, `import_from_statement` |
| Go | `import "pkg/path"` | `import_spec` |
| Rust | `use crate::module::Type` | `use_declaration` |
| Java | `import com.example.Class` | `import_declaration` |
| C# | `using Namespace.Class` | `using_directive` |
| Ruby | `require 'file'`, `require_relative` | `call` (method_call with name "require") |
| C | `#include <file>` | `preproc_include` |
| C++ | `#include "file"` | `preproc_include` |
| Swift | `import Module` | `import_declaration` |
| Kotlin | `import com.example.Class` | `import_header` |
| Scala | `import com.example._` | `import_declaration` |
| Dart | `import 'package:x/y.dart'` | `import_specification` |
| Svelte | `import x from 'y'` | `import_statement` (inside script block) |
| Vue | `import x from 'y'` | `import_statement` (inside script block) |
| Lua | `require('module')` | `call` (function_call with "require") |
| Elixir | `alias`, `import`, `use`, `require` | `call` (matching on function name) |
| Zig | `@import("file")` | `builtin_call` with "import" |
| Bash/Shell | `source file`, `. file` | `command` (matching "source" or ".") |
| Pascal/Delphi | `uses Unit1, Unit2` | `uses_clause` |

---

## How to add a new language (contributor guide)

Adding a new language to mapx takes 4 steps:

### Step 1: Add the tree-sitter npm package

```bash
npm install tree-sitter-python --save-optional
```

### Step 2: Write the query files

Create `queries/<lang>/symbols.scm` and `queries/<lang>/references.scm`.

Use the tree-sitter playground (https://tree-sitter.github.io/tree-sitter/playground) or `tree-sitter parse` on sample files to discover node names.

Capture naming convention (required by `GenericWasmParser`):
- Symbol captures: `@symbol.name` (the name identifier) + `@symbol.kind_<kind>` (the declaration node)
- Reference captures: `@ref.target_<type>` (the target) + `@ref.type_<type>` (the containing node)

### Step 3: Register the language

Add an entry to `BUILTIN_LANGUAGES` (or appropriate tier map) in `src/languages/registry.ts`:

```typescript
python: {
  name: 'python',
  extensions: ['.py', '.pyw'],
  grammarWasm: 'wasm/tree-sitter-python.wasm',
  queries: {
    symbols: 'queries/python/symbols.scm',
    references: 'queries/python/references.scm',
  },
  nodeMappings: {
    class: 'class_definition',
    method: 'function_definition',  // scoped via scope tracking
    function: 'function_definition',
    interface: '',
    trait: '',
    constant: 'assignment',         // ALL_CAPS heuristic
    enum: '',
    property: '',
    namespace: '',
  },
  tier: 'built-in',
}
```

### Step 4: Register the parser

Add the language to `src/parsers/parser-registry.ts`. For most languages, the generic parser is sufficient:

```typescript
import { GenericWasmParser } from './generic-wasm-parser.js';

// in createParser():
case 'python':
case 'go':
case 'java':
  return new GenericWasmParser(langDef);
```

For languages requiring custom scope tracking or signature extraction, create a thin subclass:

```typescript
// src/parsers/languages/python.ts
export class PythonParser extends GenericWasmParser {
  protected trackScope(kind: SymbolKind, name: string): void {
    if (kind === 'class') this.currentScope = name;
    else if (kind === 'function' && this.currentScope) {
      // reclassify as method
    }
  }
}
```

### Step 5: Add WASM to build script

Add the grammar to `scripts/build-wasm.ts`:

```typescript
{ name: 'tree-sitter-python', files: ['tree-sitter-python.wasm'] },
```

---

## Coverage expectation

These 19 languages plus the existing 3 cover:

- Top 10 languages by GitHub usage (Python, JS, TS, Java, C#, C++, C, Go, Ruby, Kotlin)
- Most modern compiled languages (Rust, Zig, Swift, Go)
- Frontend component frameworks (Svelte, Vue)
- Scripting/embedded (Lua/Luau, Elixir, Bash)
- Enterprise legacy (Pascal/Delphi, Scala, Java)

Estimated symbol extraction quality by tier:
- **Tier 1**: Production quality — all major constructs, accurate import edges
- **Tier 2**: Good quality — major constructs, some edge cases in generics/templates
- **Tier 3**: Basic quality — function/class level, limited reference extraction for some languages
