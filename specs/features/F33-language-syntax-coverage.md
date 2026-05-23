# F33 — Comprehensive Language Syntax Coverage

> **Iteration**: [I17](../iterations/I17.md) · **Status**: `in-progress` · **Priority**: 🔴 HIGH
> **Origin**: Audit finding — most built-in/bundled languages have minimal symbol and reference coverage

---

## Problem

While mapx supports 22 languages, only PHP, JavaScript, and TypeScript have comprehensive symbol extraction (8–9 kinds) and full reference coverage (imports, calls, extends, implements, instantiation). The remaining 11 built-in/bundled languages have severe gaps:

- **Python**: Only captures `class` and `function` (no decorators, constants, properties, method distinction)
- **Ruby**: Only captures `class`, `method` (no `require`, no inheritance, no modules)
- **C/C++**: Missing enums, includes, namespaces, templates
- **Kotlin**: Only `class` and `function` — no interfaces, objects, enums, data classes, imports
- **Vue**: Only `function` — no component, prop, or composable detection

This means scanning a Python or Ruby project yields dramatically fewer insights than scanning a PHP project of the same complexity.

## Solution

For each of the 14 built-in/bundled languages, expand:

1. **`queries/<lang>/symbols.scm`** — tree-sitter queries capturing all relevant `SymbolKind` values (class, method, function, interface, trait, constant, enum, property, namespace, struct, module, field)
2. **`queries/<lang>/references.scm`** — tree-sitter queries capturing all relevant reference types (import, call, extends, implements, instantiation)
3. **`src/languages/registry.ts`** — `nodeMappings` updated to match captured symbol kinds

No changes to the `GenericWasmParser` are needed — it already handles `symbol.kind_*` and `ref.target_*` capture names generically.

## Coverage Target

### Symbol Kinds per Language

| Language | Current | Target | Additions |
|----------|---------|--------|-----------|
| Python | 2 | 6+ | method, decorator, constant, property |
| Go | 4 | 6+ | constant, type alias |
| Rust | 4 | 7+ | impl, const, static, type alias, module |
| Java | 5 | 8+ | field, constant, namespace (package), annotation |
| C# | 6 | 9+ | property, constant, namespace, delegate |
| Ruby | 3 | 6+ | module, constant, property (attr_*) |
| C | 2 | 5+ | enum, typedef, macro, union |
| C++ | 3 | 7+ | namespace, enum, method, template |
| Swift | 4 | 7+ | protocol, enum, extension, property |
| Kotlin | 2 | 7+ | interface, object, enum, data class, property |
| Dart | 3 | 6+ | enum, mixin, extension, constant |
| Scala | 3 | 6+ | trait, case class, val, package |
| Vue | 1 | 4+ | component, prop, computed, import |

### Reference Types per Language

| Language | Current | Target | Additions |
|----------|---------|--------|-----------|
| Python | 3 | 5+ | instantiation, decorator ref |
| Go | 3 | 3 | (adequate) |
| Rust | 3 | 4+ | impl trait |
| Java | 3 | 5+ | extends, implements |
| C# | 3 | 5+ | extends, implements |
| Ruby | 1 | 5+ | require, include, extends, instantiation |
| C | 1 | 2+ | #include |
| C++ | 1 | 4+ | #include, extends, instantiation |
| Swift | 1 | 4+ | import, conformance, inheritance |
| Kotlin | 1 | 5+ | import, extends, implements, instantiation |
| Dart | 2 | 5+ | extends, implements, with, instantiation |
| Scala | 2 | 4+ | extends, with, instantiation |
| Vue | 1 | 3+ | import, component ref |

## Files Changed

| File | Change |
|------|--------|
| `queries/python/symbols.scm` | Expand from 2 to 6+ symbol kinds |
| `queries/python/references.scm` | Add instantiation, decorator |
| `queries/go/symbols.scm` | Add constant, type alias |
| `queries/rust/symbols.scm` | Add impl, const, static, type, module |
| `queries/java/symbols.scm` | Add field, constant, annotation |
| `queries/java/references.scm` | Add extends, implements |
| `queries/c-sharp/symbols.scm` | Add property, constant, namespace |
| `queries/c-sharp/references.scm` | Add extends, implements |
| `queries/ruby/symbols.scm` | Add module, constant, attr_* |
| `queries/ruby/references.scm` | Add require, include, extends, instantiation |
| `queries/c/symbols.scm` | Add enum, typedef, macro |
| `queries/c/references.scm` | Add #include |
| `queries/cpp/symbols.scm` | Add namespace, enum, method |
| `queries/cpp/references.scm` | Add #include, extends, instantiation |
| `queries/swift/symbols.scm` | Add protocol, enum, property |
| `queries/swift/references.scm` | Add import, conformance |
| `queries/kotlin/symbols.scm` | Add interface, object, enum, property |
| `queries/kotlin/references.scm` | Add import, extends, implements, instantiation |
| `queries/dart/symbols.scm` | Add enum, mixin, extension, const |
| `queries/dart/references.scm` | Add extends, implements, with, instantiation |
| `queries/scala/symbols.scm` | Add trait, case class, val |
| `queries/scala/references.scm` | Add extends, with, instantiation |
| `queries/vue/symbols.scm` | Add component, prop, computed |
| `queries/vue/references.scm` | Add import, component ref |
| `src/languages/registry.ts` | Update nodeMappings for all 14 languages |

## Acceptance Criteria

- [ ] Every built-in language captures ≥6 symbol kinds
- [ ] Every bundled language captures ≥4 symbol kinds
- [ ] Every language captures imports/requires where applicable
- [ ] Every language captures inheritance/implementation where applicable
- [ ] `nodeMappings` in `registry.ts` matches all captured symbol kinds
- [ ] TypeScript compiles with 0 errors
