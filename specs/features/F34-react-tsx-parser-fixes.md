# F34 — React & TSX Parser Fixes

> **Iteration**: [I18](../iterations/I18.md) · **Status**: `planned` · **Priority**: 🔴 CRITICAL
> **Origin**: MCP Feedback Section 1.1 & 2.4 — Invisible default exports and missing TSX files

---

## Problem

1. **Invisible Default Exports**: The TS/TSX parser does not extract symbols from `export default function` or `export default class` declarations, nor does it resolve variables or arrow functions exported as default (`const Foo = () => {}; export default Foo`). This is the dominant pattern in React/Next.js development.
2. **Missing TSX Files**: During scans and updates, `.tsx` files are silently ignored or missing from `mapx_files` lists, preventing frontend components from being indexed.

## Solution

1. **Support TS/TSX Default Exports**:
   - Update TS/TSX symbols query to match:
     - `(export_statement (function_declaration name: (identifier) @symbol.name)) @symbol.kind_function`
     - `(export_statement (class_declaration name: (type_identifier) @symbol.name)) @symbol.kind_class`
     - `(export_statement value: (identifier) @symbol.name)` (e.g. `export default Foo`)
     - Anonymous default exports: `export default function() {}` or `export default () => {}`. Name them using the source file name as the symbol name (e.g., `LinksPage` for `LinksPage.tsx`).
2. **Include `.tsx` in Walks**:
   - Verify file indexing filters and scanner configuration. Ensure `.tsx` extension is mapped to the TS/JS parser and not ignored by file walks.

## Files Changed

| File | Change |
|------|--------|
| `src/core/config.ts` | Ensure `.tsx` is not excluded by default patterns |
| `src/parsers/parser-registry.ts` | Ensure `.tsx` is mapped to `TypeScriptParser` |
| `queries/typescript/symbols.scm` | Add default export query mappings |
| `queries/javascript/symbols.scm` | Add default export query mappings |

## Acceptance Criteria

- [ ] TS/TSX scans include `.tsx` files in `mapx_files` list
- [ ] `export default function Foo()` is indexed as a function/method symbol
- [ ] `export default class Foo` is indexed as a class symbol
- [ ] Anonymous default exports are named based on the file name
- [ ] TypeScript compiles with 0 errors
