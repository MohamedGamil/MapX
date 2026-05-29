# F35 — JSX Component Rendering Edges

> **Iteration**: [I19](../iterations/I19.md) · **Status**: `done` · **Priority**: 🔴 CRITICAL
> **Origin**: MCP Feedback Section 1.2 — React component JSX composition not tracked as edges

---

## Problem

React component composition uses JSX syntax (e.g. `<LinksPage />` or `<Route element={<LinksPage />} />`). Currently, mapx only tracks import statements, but doesn't record JSX element usage as a call or instantiation edge. This leaves the component rendering hierarchy completely invisible in graph queries.

## Solution

1. **AST Queries for JSX Elements**:
   - Update TSX/JSX parser queries to detect JSX opening elements (`jsx_opening_element`) and JSX self-closing elements (`jsx_self_closing_element`).
   - Extract the identifier/tag name of the component (e.g. `LinksPage` from `<LinksPage />`).
2. **Emit Dependency Edges**:
   - Save references with a type of `call` or a new `render` reference type.
   - Resolve these references to the appropriate symbol declarations using the import paths and scope context.

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Optionally add `render` to `ReferenceType` |
| `queries/typescript/references.scm` | Add JSX self-closing and opening element query patterns |
| `queries/javascript/references.scm` | Add JSX self-closing and opening element query patterns |

## Acceptance Criteria

- [x] JSX self-closing elements (`<Component />`) create reference edges
- [x] JSX opening/closing elements (`<Component>...</Component>`) create reference edges
- [x] Reference target names map correctly to the imported component name
- [x] Graph calls/callees tracing includes these rendering relationships
- [x] TypeScript compiles with 0 errors
