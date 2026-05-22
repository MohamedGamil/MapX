# F20 — Language Expansion (19 languages)

| Field | Value |
|-------|-------|
| ID | F20 |
| Status | `planned` |
| Iteration | I12 |
| Branch | `feat/i12-language-expansion` |
| Depends on | — (independent) |
| Blocked by | — |

---

## Problem

mapx currently indexes only 3 languages (PHP, JavaScript, TypeScript). Every file in Python, Go, Java, Rust, C#, and all other common languages is scanned by the **fallback regex parser** — a best-effort, heuristic matcher that produces poor symbol quality and no reference edges. LLMs working in polyglot codebases receive incomplete or empty graphs for large portions of the codebase.

---

## Goal

Add first-class tree-sitter support for 19 languages, organized into three tiers by inclusion strategy. Introduce a `GenericWasmParser` to eliminate boilerplate parser classes. Add `mapx lang install / list / uninstall` commands for on-demand grammar installation.

---

## Languages

| # | Language | Tier | npm grammar package | File extensions |
|---|---------|------|---------------------|----------------|
| 1 | Python | built-in | `tree-sitter-python` | `.py`, `.pyw` |
| 2 | Go | built-in | `tree-sitter-go` | `.go` |
| 3 | Rust | built-in | `tree-sitter-rust` | `.rs` |
| 4 | Java | built-in | `tree-sitter-java` | `.java` |
| 5 | C# | built-in | `tree-sitter-c-sharp` | `.cs` |
| 6 | Ruby | bundled | `tree-sitter-ruby` | `.rb`, `.rake`, `.gemspec`, `.Rakefile` |
| 7 | C | bundled | `tree-sitter-c` | `.c`, `.h` |
| 8 | C++ | bundled | `tree-sitter-cpp` | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.h++` |
| 9 | Swift | bundled | `tree-sitter-swift` | `.swift` |
| 10 | Kotlin | bundled | `tree-sitter-kotlin` | `.kt`, `.kts` |
| 11 | Scala | bundled | `tree-sitter-scala` | `.scala`, `.sc` |
| 12 | Dart | bundled | `tree-sitter-dart` | `.dart` |
| 13 | Svelte | installable | `tree-sitter-svelte` | `.svelte` |
| 14 | Vue (2/3) | installable | `tree-sitter-vue` | `.vue` |
| 15 | Lua/Luau | installable | `tree-sitter-lua`, `tree-sitter-luau` | `.lua`, `.luau` |
| 16 | Elixir | installable | `tree-sitter-elixir` | `.ex`, `.exs` |
| 17 | Zig | installable | `tree-sitter-zig` | `.zig` |
| 18 | Bash/Shell | installable | `tree-sitter-bash` | `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1` |
| 19 | Pascal/Delphi | installable | `tree-sitter-pascal` | `.pas`, `.pp`, `.dpr`, `.lpr`, `.dfm` |

---

## Architecture

### GenericWasmParser

All 3 existing parsers are structurally identical — they differ only in scope tracking logic and signature extraction. `GenericWasmParser` codifies the common pattern:

```typescript
// src/parsers/generic-wasm-parser.ts

export class GenericWasmParser implements LanguageParser {
  readonly languageName: string;
  readonly supportedExtensions: string[];

  protected language: any = null;
  protected symbolsQuery: string | null = null;
  protected referencesQuery: string | null = null;
  protected loadingPromise: Promise<void> | null = null;

  constructor(protected langDef: LanguageDefinition) {
    this.languageName = langDef.name;
    this.supportedExtensions = langDef.extensions;
  }

  protected ensureLoaded(): Promise<void> { /* same as existing parsers */ }

  async parse(filePath: string, source: string): Promise<ParseResult> {
    await this.ensureLoaded();
    const { symbols: symCaptures, references: refCaptures, nameByNodeId }
      = await parseWithQueries(source, this.language, this.symbolsQuery!, this.referencesQuery!);

    const symbols: ExtractedSymbol[] = [];
    const references: ExtractedReference[] = [];

    let currentScope: string | null = null;

    for (const [captureName, captures] of symCaptures) {
      if (!captureName.startsWith('symbol.kind_')) continue;
      const kind = captureName.replace('symbol.kind_', '') as SymbolKind;

      for (const capture of captures) {
        const name = nameByNodeId.get(capture.node.id) || capture.node.text;
        const startLine = capture.node.startPosition.row + 1;
        const endLine = capture.node.endPosition.row + 1;
        const scope = this.resolveScope(kind, name, currentScope, capture.node);
        currentScope = this.updateScope(kind, name, currentScope);
        const signature = this.extractSignature(source, capture.node, name, kind, startLine);

        symbols.push({ name, kind, scope, signature, startLine, endLine, metadata: {} });
      }
    }

    for (const [captureName, captures] of refCaptures) {
      // same existing reference extraction pattern
    }

    return { symbols, references, errors: [] };
  }

  // Override in subclasses for language-specific scope rules:
  protected resolveScope(
    kind: SymbolKind, name: string, currentScope: string | null, node: any
  ): string | null {
    return kind === 'method' || kind === 'property' ? currentScope : null;
  }

  protected updateScope(kind: SymbolKind, name: string, currentScope: string | null): string | null {
    return (kind === 'class' || kind === 'interface' || kind === 'trait') ? name : currentScope;
  }

  protected extractSignature(
    source: string, node: any, name: string, kind: SymbolKind, line: number
  ): string {
    return source.split('\n')[line - 1]?.trim() ?? name;
  }
}
```

Languages that need custom logic extend `GenericWasmParser` and override `resolveScope`, `updateScope`, or `extractSignature`. Languages that work with the defaults (C, Java, Zig, Bash) use `GenericWasmParser` directly.

### Tier handling in registry

```typescript
// src/languages/registry.ts
export type LanguageTier = 'built-in' | 'bundled' | 'installable' | 'user';

export interface LanguageDefinition {
  // ... existing fields ...
  tier: LanguageTier;
  grammarNpm?: string;    // npm package name, used by 'mapx lang install'
}
```

### Grammar resolution

WASM loading order:
1. `<project>/.mapx/grammars/<lang>.wasm` (project-local override)
2. `~/.mapx/grammars/<lang>.wasm` (user-installed via `mapx lang install`)
3. `<mapx-binary-dir>/wasm/<lang>.wasm` (bundled, built-in/bundled tier)
4. Falls back to `FallbackParser`

### `mapx lang` CLI commands

```
mapx lang list                    List all supported languages + install status
mapx lang install <name>          Download and install a Tier 3 language grammar
mapx lang install all             Install all installable language grammars
mapx lang uninstall <name>        Remove a user-installed grammar
mapx lang info <name>             Show language details (extensions, tier, node mappings)
```

---

## Language specifications

---

### Python

**File extensions:** `.py`, `.pyw`
**npm package:** `tree-sitter-python`
**Tier:** built-in
**Parser:** `PythonParser extends GenericWasmParser` (scope override: nested function-in-class → method)

**Symbols query (`queries/python/symbols.scm`):**
```scheme
; Class definitions
(class_definition
  name: (identifier) @symbol.name) @symbol.kind_class

; Top-level function definitions (not inside a class)
(module
  (function_definition
    name: (identifier) @symbol.name)) @symbol.kind_function

; Async top-level functions
(module
  (decorated_definition
    (function_definition
      name: (identifier) @symbol.name))) @symbol.kind_function

; Methods (function definitions inside a class body)
(class_definition
  body: (block
    (function_definition
      name: (identifier) @symbol.name))) @symbol.kind_method

; Async methods
(class_definition
  body: (block
    (decorated_definition
      (function_definition
        name: (identifier) @symbol.name)))) @symbol.kind_method

; Module-level constants (ALL_CAPS assignment)
(module
  (expression_statement
    (assignment
      left: (identifier) @symbol.name
      (#match? @symbol.name "^[A-Z][A-Z0-9_]+$")))) @symbol.kind_constant
```

**References query (`queries/python/references.scm`):**
```scheme
; import module
(import_statement
  name: (dotted_name) @ref.target_import) @ref.type_import

; from module import name
(import_from_statement
  module_name: (dotted_name) @ref.target_import) @ref.type_import

; Class inheritance
(class_definition
  superclasses: (argument_list
    (identifier) @ref.target_extends)) @ref.type_extends

; Function calls
(call
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls
(call
  function: (attribute
    attribute: (identifier) @ref.target_call)) @ref.type_call

; Object instantiation (new-style: ClassName(...))
(call
  function: (identifier) @ref.target_instantiation
  (#match? @ref.target_instantiation "^[A-Z]")) @ref.type_instantiation
```

**Scope tracking override:**
```typescript
protected resolveScope(kind: SymbolKind, name: string, scope: string | null, node: any): string | null {
  if (kind === 'method') return scope; // set by class tracking
  return null;
}
protected updateScope(kind: SymbolKind, name: string, scope: string | null): string | null {
  return kind === 'class' ? name : scope;
}
```

**Special handling:**
- `self` parameter is stripped from method signatures
- Dataclasses (`@dataclass`) class fields are extracted as `property` symbols via the decorated_definition pattern
- `__init__` is indexed as a method named `__init__`; display as constructor in export

---

### Go

**File extensions:** `.go`
**npm package:** `tree-sitter-go`
**Tier:** built-in
**Parser:** `GoParser extends GenericWasmParser` (receiver → method scope)

**Symbols query (`queries/go/symbols.scm`):**
```scheme
; Struct types (map to class)
(type_declaration
  (type_spec
    name: (type_identifier) @symbol.name
    type: (struct_type))) @symbol.kind_class

; Interface types
(type_declaration
  (type_spec
    name: (type_identifier) @symbol.name
    type: (interface_type))) @symbol.kind_interface

; Top-level functions (no receiver)
(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; Methods (with receiver)
(method_declaration
  name: (field_identifier) @symbol.name) @symbol.kind_method

; Constants
(const_declaration
  (const_spec
    name: (identifier) @symbol.name)) @symbol.kind_constant

; Type aliases
(type_declaration
  (type_spec
    name: (type_identifier) @symbol.name)) @symbol.kind_constant
```

**References query (`queries/go/references.scm`):**
```scheme
; Import declarations
(import_spec
  path: (interpreted_string_literal) @ref.target_import) @ref.type_import

; Struct literal instantiation
(composite_literal
  type: (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls
(call_expression
  function: (selector_expression
    field: (field_identifier) @ref.target_call)) @ref.type_call

; Type assertions / type usage
(type_assertion_expression
  type: (type_identifier) @ref.target_param_type) @ref.type_param_type
```

**Scope tracking override:**
```typescript
// Go methods carry the receiver type in the node — extract it:
protected resolveScope(kind: SymbolKind, name: string, scope: string | null, node: any): string | null {
  if (kind !== 'method') return null;
  // node is method_declaration; get receiver.parameter_declaration.type_identifier
  try {
    const receiver = node.parent?.childForFieldName('receiver');
    const typeNode = receiver?.namedChild(0)?.childForFieldName('type');
    return typeNode?.text?.replace('*', '') ?? null; // strip pointer receiver
  } catch { return null; }
}
protected updateScope(kind: SymbolKind, name: string, scope: string | null): string | null {
  return scope; // Go scope is per-method from receiver, not class-level tracking
}
```

**Special handling:**
- Package name extracted from `package_clause` and stored as a namespace symbol
- Exported symbols (uppercase first letter) are prioritized in LLM context output
- Go generics (type parameters) are included in signatures but not split into separate symbols

---

### Rust

**File extensions:** `.rs`
**npm package:** `tree-sitter-rust`
**Tier:** built-in
**Parser:** `RustParser extends GenericWasmParser` (impl block → method scope)

**Symbols query (`queries/rust/symbols.scm`):**
```scheme
; Struct definitions
(struct_item
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Enum definitions
(enum_item
  name: (type_identifier) @symbol.name) @symbol.kind_enum

; Trait definitions
(trait_item
  name: (type_identifier) @symbol.name) @symbol.kind_interface

; Top-level functions (not inside impl)
(source_file
  (function_item
    name: (identifier) @symbol.name)) @symbol.kind_function

; Methods inside impl blocks
(impl_item
  body: (declaration_list
    (function_item
      name: (identifier) @symbol.name))) @symbol.kind_method

; Const items
(const_item
  name: (identifier) @symbol.name) @symbol.kind_constant

; Module declarations
(mod_item
  name: (identifier) @symbol.name) @symbol.kind_namespace
```

**References query (`queries/rust/references.scm`):**
```scheme
; use declarations
(use_declaration
  argument: (scoped_identifier) @ref.target_import) @ref.type_import

(use_declaration
  argument: (identifier) @ref.target_import) @ref.type_import

(use_declaration
  argument: (use_list) @ref.target_import) @ref.type_import

; Struct initialization
(struct_expression
  name: (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls
(call_expression
  function: (field_expression
    field: (field_identifier) @ref.target_call)) @ref.type_call

; Trait implementation
(impl_item
  trait: (type_identifier) @ref.target_implements) @ref.type_implements

; Type usage in function signatures
(type_identifier) @ref.target_param_type
```

**Scope tracking override:**
```typescript
// Track impl block's type as scope for contained methods
private implScope: string | null = null;
protected resolveScope(kind: SymbolKind, name: string, scope: string | null, node: any): string | null {
  if (kind !== 'method') return null;
  // node is function_item inside impl_item; get impl's type
  try {
    const implNode = node.parent?.parent; // declaration_list → impl_item
    return implNode?.childForFieldName('type')?.text ?? null;
  } catch { return null; }
}
```

**Special handling:**
- `pub fn` vs `fn` visibility tracked in metadata
- Lifetime parameters stripped from signatures for readability
- `impl Trait for Type` creates an edge `Type --implements--> Trait`

---

### Java

**File extensions:** `.java`
**npm package:** `tree-sitter-java`
**Tier:** built-in
**Parser:** `GenericWasmParser` (standard class → method scope works)

**Symbols query (`queries/java/symbols.scm`):**
```scheme
; Class declarations
(class_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; Interface declarations
(interface_declaration
  name: (identifier) @symbol.name) @symbol.kind_interface

; Enum declarations
(enum_declaration
  name: (identifier) @symbol.name) @symbol.kind_enum

; Method declarations
(method_declaration
  name: (identifier) @symbol.name) @symbol.kind_method

; Constructor declarations
(constructor_declaration
  name: (identifier) @symbol.name) @symbol.kind_method

; Field declarations
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @symbol.name)) @symbol.kind_property

; Package declaration
(package_declaration
  (scoped_identifier) @symbol.name) @symbol.kind_namespace
```

**References query (`queries/java/references.scm`):**
```scheme
; Import declarations
(import_declaration
  (scoped_identifier) @ref.target_import) @ref.type_import

; Class instantiation
(object_creation_expression
  type: (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; Method calls
(method_invocation
  name: (identifier) @ref.target_call) @ref.type_call

; Extends
(superclass
  (type_identifier) @ref.target_extends) @ref.type_extends

; Implements
(super_interfaces
  (type_list
    (type_identifier) @ref.target_implements)) @ref.type_implements
```

---

### C#

**File extensions:** `.cs`
**npm package:** `tree-sitter-c-sharp`
**Tier:** built-in
**Parser:** `CSharpParser extends GenericWasmParser` (namespace + nested class scope)

**Symbols query (`queries/csharp/symbols.scm`):**
```scheme
; Class declarations
(class_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; Interface declarations
(interface_declaration
  name: (identifier) @symbol.name) @symbol.kind_interface

; Struct declarations
(struct_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; Record declarations
(record_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; Enum declarations
(enum_declaration
  name: (identifier) @symbol.name) @symbol.kind_enum

; Method declarations
(method_declaration
  name: (identifier) @symbol.name) @symbol.kind_method

; Constructor declarations
(constructor_declaration
  name: (identifier) @symbol.name) @symbol.kind_method

; Property declarations
(property_declaration
  name: (identifier) @symbol.name) @symbol.kind_property

; Namespace declarations
(namespace_declaration
  name: (identifier) @symbol.name) @symbol.kind_namespace

; File-scoped namespace
(file_scoped_namespace_declaration
  name: (identifier) @symbol.name) @symbol.kind_namespace
```

**References query (`queries/csharp/references.scm`):**
```scheme
; Using directives
(using_directive
  (identifier) @ref.target_import) @ref.type_import

(using_directive
  (qualified_name) @ref.target_import) @ref.type_import

; Object creation
(object_creation_expression
  type: (identifier) @ref.target_instantiation) @ref.type_instantiation

; Method calls
(invocation_expression
  function: (member_access_expression
    name: (identifier) @ref.target_call)) @ref.type_call

; Base class
(base_list
  (identifier) @ref.target_extends) @ref.type_extends

; Interface implementation
(base_list
  (identifier) @ref.target_implements) @ref.type_implements
```

---

### Ruby

**File extensions:** `.rb`, `.rake`, `.gemspec`; files named `Rakefile`, `Gemfile`
**npm package:** `tree-sitter-ruby`
**Tier:** bundled
**Parser:** `RubyParser extends GenericWasmParser`

**Symbols query (`queries/ruby/symbols.scm`):**
```scheme
; Class definitions
(class
  name: (constant) @symbol.name) @symbol.kind_class

; Module definitions (used as both namespace and mixin)
(module
  name: (constant) @symbol.name) @symbol.kind_namespace

; Instance method definitions
(method
  name: (identifier) @symbol.name) @symbol.kind_method

; Class-level singleton methods
(singleton_method
  name: (identifier) @symbol.name) @symbol.kind_method

; Constants (ALL_CAPS or CamelCase assignment at module level)
(assignment
  left: (constant) @symbol.name) @symbol.kind_constant
```

**References query (`queries/ruby/references.scm`):**
```scheme
; require / require_relative calls
(call
  method: (identifier) @_method
  arguments: (argument_list
    (string (string_content) @ref.target_import))
  (#match? @_method "^require")) @ref.type_import

; Class instantiation (ClassName.new)
(call
  receiver: (constant) @ref.target_instantiation
  method: (identifier) @_method
  (#eq? @_method "new")) @ref.type_instantiation

; Method calls
(call
  method: (identifier) @ref.target_call) @ref.type_call

; Superclass
(class
  superclass: (constant) @ref.target_extends) @ref.type_extends

; Module include/extend (Ruby trait-like)
(call
  method: (identifier) @_m
  arguments: (argument_list (constant) @ref.target_implements)
  (#match? @_m "^(include|extend|prepend)$")) @ref.type_implements
```

---

### C

**File extensions:** `.c`, `.h`
**npm package:** `tree-sitter-c`
**Tier:** bundled
**Parser:** `GenericWasmParser` (no class scope)

**Symbols query (`queries/c/symbols.scm`):**
```scheme
; Function definitions
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @symbol.name)) @symbol.kind_function

; Struct declarations (named)
(struct_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Enum declarations
(enum_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_enum

; Typedef declarations
(type_definition
  declarator: (type_identifier) @symbol.name) @symbol.kind_constant

; Macro definitions
(preproc_def
  name: (identifier) @symbol.name) @symbol.kind_constant

; Macro functions
(preproc_function_def
  name: (identifier) @symbol.name) @symbol.kind_function
```

**References query (`queries/c/references.scm`):**
```scheme
; #include
(preproc_include
  path: (system_lib_string) @ref.target_import) @ref.type_import

(preproc_include
  path: (string_literal) @ref.target_import) @ref.type_import

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Struct initialization
(compound_literal_expression
  type: (type_identifier) @ref.target_instantiation) @ref.type_instantiation
```

---

### C++

**File extensions:** `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.h++`
**npm package:** `tree-sitter-cpp`
**Tier:** bundled
**Parser:** `CppParser extends GenericWasmParser` (class body → method scope)

**Symbols query (`queries/cpp/symbols.scm`):**
```scheme
; Class declarations
(class_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Struct declarations
(struct_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Namespace definitions
(namespace_definition
  name: (identifier) @symbol.name) @symbol.kind_namespace

; Function definitions (top-level)
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @symbol.name)) @symbol.kind_function

; Methods (function_definition inside class/struct)
(field_declaration_list
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @symbol.name))) @symbol.kind_method

; Enum declarations
(enum_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_enum
```

**References query (`queries/cpp/references.scm`):**
```scheme
(preproc_include
  path: [(system_lib_string) (string_literal)] @ref.target_import) @ref.type_import

(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

(call_expression
  function: (field_expression
    field: (field_identifier) @ref.target_call)) @ref.type_call

(new_expression
  type: (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; Inheritance
(base_class_clause
  (type_identifier) @ref.target_extends) @ref.type_extends
```

---

### Swift

**File extensions:** `.swift`
**npm package:** `tree-sitter-swift`
**Tier:** bundled
**Parser:** `SwiftParser extends GenericWasmParser`

**Symbols query (`queries/swift/symbols.scm`):**
```scheme
(class_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_class

(struct_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_class

(protocol_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_interface

(enum_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_enum

; Top-level functions
(function_declaration
  name: (simple_identifier) @symbol.name) @symbol.kind_function

; Methods inside class/struct bodies
(class_body
  (function_declaration
    name: (simple_identifier) @symbol.name)) @symbol.kind_method

(struct_body
  (function_declaration
    name: (simple_identifier) @symbol.name)) @symbol.kind_method

; Stored properties
(class_body
  (property_declaration
    (pattern
      (simple_identifier) @symbol.name))) @symbol.kind_property
```

**References query (`queries/swift/references.scm`):**
```scheme
(import_declaration
  path: (identifier) @ref.target_import) @ref.type_import

(call_expression
  function: (simple_identifier) @ref.target_call) @ref.type_call

; Protocol conformance / class inheritance
(type_inheritance_clause
  (type_identifier) @ref.target_implements) @ref.type_implements

(type_inheritance_clause
  (type_identifier) @ref.target_extends) @ref.type_extends
```

---

### Kotlin

**File extensions:** `.kt`, `.kts`
**npm package:** `tree-sitter-kotlin`
**Tier:** bundled
**Parser:** `KotlinParser extends GenericWasmParser`

**Symbols query (`queries/kotlin/symbols.scm`):**
```scheme
(class_declaration
  (type_identifier) @symbol.name) @symbol.kind_class

(interface_declaration
  (type_identifier) @symbol.name) @symbol.kind_interface

(object_declaration
  (type_identifier) @symbol.name) @symbol.kind_class

(function_declaration
  (simple_identifier) @symbol.name) @symbol.kind_function

(anonymous_initializer) @symbol.kind_method  ; companion object init

; Enum class
(enum_class_body
  (enum_entry
    (simple_identifier) @symbol.name)) @symbol.kind_enum
```

**References query (`queries/kotlin/references.scm`):**
```scheme
(import_header
  (identifier) @ref.target_import) @ref.type_import

(call_expression
  (simple_identifier) @ref.target_call) @ref.type_call

(object_creation_expression
  (user_type
    (simple_identifier) @ref.target_instantiation)) @ref.type_instantiation

(delegation_specifier
  (user_type
    (simple_identifier) @ref.target_extends)) @ref.type_extends
```

---

### Scala

**File extensions:** `.scala`, `.sc`
**npm package:** `tree-sitter-scala`
**Tier:** bundled
**Parser:** `ScalaParser extends GenericWasmParser`

**Symbols query (`queries/scala/symbols.scm`):**
```scheme
(class_definition
  name: (identifier) @symbol.name) @symbol.kind_class

(trait_definition
  name: (identifier) @symbol.name) @symbol.kind_interface

(object_definition
  name: (identifier) @symbol.name) @symbol.kind_class

; Methods
(function_definition
  name: (identifier) @symbol.name) @symbol.kind_method

; Values / variables
(val_definition
  pattern: (identifier) @symbol.name) @symbol.kind_property

; Package declaration
(package_clause
  name: (package_identifier) @symbol.name) @symbol.kind_namespace
```

**References query (`queries/scala/references.scm`):**
```scheme
(import_declaration
  path: (stable_identifier) @ref.target_import) @ref.type_import

(class_parameters
  (class_parameter
    type: (type_identifier) @ref.target_param_type)) @ref.type_param_type

(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Extends / with
(extends_clause
  type: (type_identifier) @ref.target_extends) @ref.type_extends

(with_clause
  type: (type_identifier) @ref.target_implements) @ref.type_implements
```

---

### Dart

**File extensions:** `.dart`
**npm package:** `tree-sitter-dart`
**Tier:** bundled
**Parser:** `DartParser extends GenericWasmParser`

**Symbols query (`queries/dart/symbols.scm`):**
```scheme
(class_definition
  name: (identifier) @symbol.name) @symbol.kind_class

(mixin_declaration
  name: (identifier) @symbol.name) @symbol.kind_trait

(enum_declaration
  name: (identifier) @symbol.name) @symbol.kind_enum

(function_signature
  name: (identifier) @symbol.name) @symbol.kind_method

(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function
```

**References query (`queries/dart/references.scm`):**
```scheme
(import_or_export
  (configured_uri
    (uri
      (string_literal) @ref.target_import))) @ref.type_import

(type_name
  (identifier) @ref.target_instantiation) @ref.type_instantiation

(superclass
  (type_not_void
    (type_name
      (identifier) @ref.target_extends))) @ref.type_extends

(interfaces
  (type_not_void_list
    (type_not_void
      (type_name
        (identifier) @ref.target_implements)))) @ref.type_implements
```

---

### Svelte

**File extensions:** `.svelte`
**npm package:** `tree-sitter-svelte`
**Tier:** installable
**Parser:** `SvelteParser extends GenericWasmParser` (specialized: component + script block extraction)

**Special handling:**
Svelte files are multi-part: `<script>`, `<template>` (HTML), `<style>`. The tree-sitter-svelte grammar represents this as a single tree with script/style/template regions.

- The component itself is treated as a `class` symbol named after the file basename (e.g. `Button.svelte` → `Button`)
- Exported variables in `<script>` are treated as `property` symbols (component props)
- Functions defined in `<script>` or `<script module>` are `function` symbols
- `import` statements in `<script>` generate import edges
- `{#each}`, `{#if}` are not indexed — only script-level symbols

```scheme
; Script block contents — symbols extracted from script_element children
(script_element
  (raw_text) @script_content)   ; raw_text dispatched to JS/TS parser

; Exports (props) — parsed from script
; (handled in SvelteParser.parse() by delegating script_content to TypeScriptParser)
```

`SvelteParser` implementation strategy:
1. Extract raw content of `<script>` and `<script lang="ts">` blocks
2. Delegate to `JavaScriptParser` or `TypeScriptParser` to extract symbols from the script block
3. Add a synthetic `class` symbol for the component name from the file basename
4. Adjust line numbers by the `<script>` block's start offset

---

### Vue (2/3)

**File extensions:** `.vue`
**npm package:** `tree-sitter-vue`
**Tier:** installable
**Parser:** `VueParser extends GenericWasmParser` (specialized, similar to Svelte)

**Special handling:**
Similar to Svelte — multi-part file. Two modes:
- **Composition API / `<script setup>`**: delegate script to TypeScript parser; `defineProps()` call extracts prop types
- **Options API**: parse the exported object for `data()`, `computed`, `methods`, `props`, `components`

The component name is the file basename.

For Options API, the following members are indexed:
- `methods.functionName` → `method` symbol
- `computed.propName` → `property` symbol  
- `props.propName` → `property` symbol
- `components.ComponentName` → `import` edge

For Composition API (`<script setup>`):
- All `const`, `function`, `ref()`, `computed()` assignments → `function` or `property`
- `defineProps<{ ... }>()` → `property` symbols for each prop

---

### Lua/Luau

**File extensions:** `.lua`, `.luau`
**npm packages:** `tree-sitter-lua` (Lua), `tree-sitter-luau` (Luau)
**Tier:** installable
**Parser:** `LuaParser extends GenericWasmParser`

**Note:** Luau (Roblox's Lua dialect) has a superset grammar. The Luau parser handles both `.lua` and `.luau` files. The standard `tree-sitter-lua` parser is used for `.lua` files; `tree-sitter-luau` for `.luau`.

**Symbols query (`queries/lua/symbols.scm`):**
```scheme
; Global function declaration
(function_statement
  name: (identifier) @symbol.name) @symbol.kind_function

; Local function declaration
(local_function
  name: (identifier) @symbol.name) @symbol.kind_function

; Method syntax (table:method)
(function_statement
  name: (method_index_expression
    method: (identifier) @symbol.name)) @symbol.kind_method

; Function assigned to table field (class-like)
(function_statement
  name: (dot_index_expression
    field: (identifier) @symbol.name)) @symbol.kind_function

; Table constructors as "classes"
(assignment_statement
  (variable_list
    name: (identifier) @symbol.name)
  (expression_list
    value: (table_constructor))) @symbol.kind_class
```

**References query (`queries/lua/references.scm`):**
```scheme
; require() calls
(call
  prefix: (identifier) @_fn
  args: (args
    (string) @ref.target_import)
  (#eq? @_fn "require")) @ref.type_import

; Function calls
(call
  prefix: (identifier) @ref.target_call) @ref.type_call

; Method calls
(call
  prefix: (method_index_expression
    method: (identifier) @ref.target_call)) @ref.type_call
```

---

### Elixir

**File extensions:** `.ex`, `.exs`
**npm package:** `tree-sitter-elixir`
**Tier:** installable
**Parser:** `ElixirParser extends GenericWasmParser`

**Symbols query (`queries/elixir/symbols.scm`):**
```scheme
; Module definitions
(call
  target: (identifier) @_defmodule
  arguments: (arguments
    (alias) @symbol.name)
  (#eq? @_defmodule "defmodule")) @symbol.kind_namespace

; Public function definitions
(call
  target: (identifier) @_def
  arguments: (arguments
    (call
      target: (identifier) @symbol.name))
  (#eq? @_def "def")) @symbol.kind_function

; Private function definitions
(call
  target: (identifier) @_defp
  arguments: (arguments
    (call
      target: (identifier) @symbol.name))
  (#eq? @_defp "defp")) @symbol.kind_function

; Macro definitions
(call
  target: (identifier) @_defmacro
  arguments: (arguments
    (call
      target: (identifier) @symbol.name))
  (#match? @_defmacro "^defmacro")) @symbol.kind_function
```

**References query (`queries/elixir/references.scm`):**
```scheme
; alias
(call
  target: (identifier) @_alias
  arguments: (arguments (alias) @ref.target_import)
  (#eq? @_alias "alias")) @ref.type_import

; import
(call
  target: (identifier) @_import
  arguments: (arguments (alias) @ref.target_import)
  (#eq? @_import "import")) @ref.type_import

; use
(call
  target: (identifier) @_use
  arguments: (arguments (alias) @ref.target_implements)
  (#eq? @_use "use")) @ref.type_implements

; Function calls
(call
  target: (identifier) @ref.target_call) @ref.type_call
```

---

### Zig

**File extensions:** `.zig`
**npm package:** `tree-sitter-zig`
**Tier:** installable
**Parser:** `GenericWasmParser` (no subclass needed)

**Symbols query (`queries/zig/symbols.scm`):**
```scheme
; Function declarations
(FnProto
  function_identifier: (IDENTIFIER) @symbol.name) @symbol.kind_function

; Struct declarations assigned to const
(VarDecl
  identifier_token: (IDENTIFIER) @symbol.name
  (ContainerDecl
    (STRUCT))) @symbol.kind_class

; Enum declarations
(VarDecl
  identifier_token: (IDENTIFIER) @symbol.name
  (ContainerDecl
    (ENUM))) @symbol.kind_enum

; Union declarations
(VarDecl
  identifier_token: (IDENTIFIER) @symbol.name
  (ContainerDecl
    (UNION))) @symbol.kind_class

; Constants
(VarDecl
  identifier_token: (IDENTIFIER) @symbol.name) @symbol.kind_constant
```

**References query (`queries/zig/references.scm`):**
```scheme
; @import built-in
(BuiltinCallTwo
  identifier_token: (BUILTINIDENTIFIER) @_builtin
  (StringLiteral) @ref.target_import
  (#eq? @_builtin "@import")) @ref.type_import

; Function calls
(CallExpr
  function: (IDENTIFIER) @ref.target_call) @ref.type_call
```

---

### Bash/Shell

**File extensions:** `.sh`, `.bash`, `.zsh`, `.fish`; files named without extension detected as shell via shebang
**npm package:** `tree-sitter-bash`
**Tier:** installable
**Parser:** `GenericWasmParser` (functions only — no class/scope concepts)

**Symbols query (`queries/bash/symbols.scm`):**
```scheme
; Function definitions (both syntaxes)
(function_definition
  name: (word) @symbol.name) @symbol.kind_function

; Function with function keyword
(function_definition
  name: (variable_name) @symbol.name) @symbol.kind_function
```

**References query (`queries/bash/references.scm`):**
```scheme
; source / . commands
(command
  name: (word) @_cmd
  argument: (word) @ref.target_import
  (#match? @_cmd "^(source|\\.)$")) @ref.type_import

; Function calls (command invocations matching defined function names)
(command
  name: (word) @ref.target_call) @ref.type_call
```

**Special handling:**
- Shebang detection: files without a recognized extension but starting with `#!/bin/bash`, `#!/usr/bin/env bash`, `#!/bin/sh`, `#!/usr/bin/env zsh` are indexed with the `bash` parser
- `.fish` files use `tree-sitter-bash` as a best-effort (Fish syntax differs but function definitions parse adequately)

---

### Pascal/Delphi

**File extensions:** `.pas`, `.pp`, `.dpr`, `.lpr`
**npm package:** `tree-sitter-pascal`
**Tier:** installable
**Parser:** `PascalParser extends GenericWasmParser`

**Symbols query (`queries/pascal/symbols.scm`):**
```scheme
; Unit declaration
(unit_declaration
  identifier: (identifier) @symbol.name) @symbol.kind_namespace

; Program declaration
(program_declaration
  identifier: (identifier) @symbol.name) @symbol.kind_namespace

; Type declarations (class)
(type_section
  (type_definition
    identifier: (identifier) @symbol.name
    type: (class_type))) @symbol.kind_class

; Interface section type declarations
(type_section
  (type_definition
    identifier: (identifier) @symbol.name
    type: (interface_type))) @symbol.kind_interface

; Enum type declarations
(type_section
  (type_definition
    identifier: (identifier) @symbol.name
    type: (enumerated_type))) @symbol.kind_enum

; Procedure declarations
(procedure_declaration
  identifier: (identifier) @symbol.name) @symbol.kind_function

; Function declarations
(function_declaration
  identifier: (identifier) @symbol.name) @symbol.kind_function

; Method implementations (ClassName.MethodName)
(procedure_declaration
  identifier: (identifier)
  (qualified_identifier
    identifier: (identifier) @symbol.name)) @symbol.kind_method
```

**References query (`queries/pascal/references.scm`):**
```scheme
; uses clause
(uses_clause
  (identifier) @ref.target_import) @ref.type_import

; Inherited class
(class_type
  (heritage
    (identifier) @ref.target_extends)) @ref.type_extends

; Object construction
(call_expression
  procedure_designator: (identifier) @_create
  actual_parameter_list: (actual_parameter_list
    (identifier) @ref.target_instantiation)
  (#eq? @_create "Create")) @ref.type_instantiation
```

---

## New and modified files

### New files

```
src/parsers/generic-wasm-parser.ts         ← GenericWasmParser base class
src/parsers/languages/python.ts            ← PythonParser
src/parsers/languages/go.ts               ← GoParser
src/parsers/languages/rust.ts             ← RustParser
src/parsers/languages/java.ts             ← GenericWasmParser alias (no subclass)
src/parsers/languages/csharp.ts           ← CSharpParser
src/parsers/languages/ruby.ts             ← RubyParser
src/parsers/languages/c.ts               ← GenericWasmParser alias
src/parsers/languages/cpp.ts             ← CppParser
src/parsers/languages/swift.ts           ← SwiftParser
src/parsers/languages/kotlin.ts          ← KotlinParser
src/parsers/languages/scala.ts           ← ScalaParser
src/parsers/languages/dart.ts            ← DartParser
src/parsers/languages/svelte.ts          ← SvelteParser (specialized)
src/parsers/languages/vue.ts             ← VueParser (specialized)
src/parsers/languages/lua.ts             ← LuaParser
src/parsers/languages/elixir.ts          ← ElixirParser
src/parsers/languages/zig.ts             ← GenericWasmParser alias
src/parsers/languages/bash.ts            ← GenericWasmParser alias (+ shebang detection)
src/parsers/languages/pascal.ts          ← PascalParser

queries/python/symbols.scm
queries/python/references.scm
queries/go/symbols.scm
queries/go/references.scm
queries/rust/symbols.scm
queries/rust/references.scm
queries/java/symbols.scm
queries/java/references.scm
queries/csharp/symbols.scm
queries/csharp/references.scm
queries/ruby/symbols.scm
queries/ruby/references.scm
queries/c/symbols.scm
queries/c/references.scm
queries/cpp/symbols.scm
queries/cpp/references.scm
queries/swift/symbols.scm
queries/swift/references.scm
queries/kotlin/symbols.scm
queries/kotlin/references.scm
queries/scala/symbols.scm
queries/scala/references.scm
queries/dart/symbols.scm
queries/dart/references.scm
queries/svelte/symbols.scm
queries/svelte/references.scm
queries/vue/symbols.scm
queries/vue/references.scm
queries/lua/symbols.scm
queries/lua/references.scm
queries/elixir/symbols.scm
queries/elixir/references.scm
queries/zig/symbols.scm
queries/zig/references.scm
queries/bash/symbols.scm
queries/bash/references.scm
queries/pascal/symbols.scm
queries/pascal/references.scm
```

### Modified files

```
src/languages/registry.ts         ← add 19 language definitions + LanguageTier enum + grammarNpm field
src/parsers/parser-registry.ts    ← register all 19 new parsers in createParser()
scripts/build-wasm.ts             ← add Tier 1+2 grammars to GRAMMARS array
src/cli.ts                        ← add 'mapx lang install/uninstall/list/info' subcommands
src/core/scanner.ts               ← shebang detection for extensionless shell files
docs/adding-languages.md          ← updated contributor guide
docs/getting-started.md           ← mention new supported languages
docs/cli-reference.md             ← document 'mapx lang' commands
```

### No schema changes

The existing `files`, `symbols`, `edges` tables support all new languages without modification. The `language` column in `files` will simply contain the new language name strings.

---

## Acceptance Criteria

### Architecture

- [ ] `GenericWasmParser` class exists and passes all current PHP/JS/TS parser tests when instantiated with their `LanguageDefinition`
- [ ] PHP, JavaScript, and TypeScript parsers are refactored to extend `GenericWasmParser` with no change in behaviour

### Tier 1 languages (Python, Go, Rust, Java, C#)

For each language:
- [ ] Standard files are recognized by extension
- [ ] Classes/structs are extracted as `class` symbols
- [ ] Functions at module/top level are extracted as `function` symbols
- [ ] Methods (scoped to a class/struct/impl) are extracted as `method` symbols with correct `scope`
- [ ] Import/require/use statements generate `import` edges
- [ ] Inheritance generates `extends` edges
- [ ] Interface implementation generates `implements` edges
- [ ] `mapx scan` on a sample project produces non-zero symbol counts for each language

### Tier 2 languages (Ruby, C, C++, Swift, Kotlin, Scala, Dart)

- [ ] Each language recognized and scanned
- [ ] Functions and classes extracted correctly
- [ ] Import edges generated from include/import/require statements
- [ ] `mapx lang list` shows all Tier 2 languages as "bundled"

### Tier 3 languages (Svelte, Vue, Lua/Luau, Elixir, Zig, Bash, Pascal)

- [ ] `mapx lang list` shows all Tier 3 languages as "not installed"
- [ ] `mapx lang install svelte` downloads grammar to `~/.mapx/grammars/`
- [ ] After install, `.svelte` files are scanned and produce symbols
- [ ] `mapx lang uninstall svelte` removes the grammar
- [ ] Svelte: component name extracted from file basename; script block symbols extracted
- [ ] Vue: both Options API methods and Composition API functions extracted
- [ ] Bash: functions extracted; shebang-only shell files recognized

### Common

- [ ] `mapx lang list` displays all 22 languages (3 original + 19 new) with tier and status
- [ ] TypeScript: `npx tsc --noEmit` passes with 0 errors
- [ ] `mapx scan` on a polyglot project (multiple languages) produces correct language breakdown in `mapx status`
- [ ] Fallback parser still used for unrecognized extensions (`.xml`, `.json`, `.html` etc.)
- [ ] No regression in PHP/JS/TS symbol extraction after refactor

---

## Out of scope for F20

- Framework-aware context for new languages (Django routes, Rails routes, etc.) — deferred to F22
- Type inference or type resolution across languages
- Cross-language edges (e.g. Python calling a TypeScript API via a binding layer)
- IDE language server integration
- Semantic analysis beyond tree-sitter grammar capabilities
- `.tsx` support for Svelte/Vue TS mode (`.tsx` is already handled by the TypeScript parser)
