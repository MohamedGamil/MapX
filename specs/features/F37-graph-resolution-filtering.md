# F37 — Graph Resolution & Noise Reduction

> **Iteration**: [I21](../iterations/I21.md) · **Status**: `planned` · **Priority**: 🟠 HIGH
> **Origin**: MCP Feedback Sections 2.5, 2.6, 3.1, & 3.3 — Built-in global pollution, caller noise, and staleness detection

---

## Problem

1. **Global Class/Type Pollution**: Built-in Javascript globals (such as `Date`, `Error`, `Map`, `Set`, `Promise`, `Object`, `Array`) are incorrectly resolved during edge building to user-defined symbols of the same name (e.g., matching a backend DTO class `Date`).
2. **Caller Noise**: Every import statement yields a `<top-level>` caller reference in callers search, making actual execution pathways noisy and difficult to trace.
3. **Graph Staleness**: When files are changed or written, LLM queries return stale results from `.mapx/mapx.db` without warning the user/agent that index synchronization (`mapx update`) is needed.

## Solution

1. **Global Class Exclusion**:
   - Maintain a list of standard JS/TS globals in `src/parsers/common-methods.ts` or similar.
   - Skip resolution of these identifiers to user-defined symbols during edge assembly.
2. **Import/Top-Level Reference Filtering**:
   - Distinguish import declarations from actual call/instantiation statements in the references database.
   - Exclude import-only edges from standard `mapx callers` call graph views, or label them separately to avoid clutter.
3. **Staleness Warnings**:
   - When calling MCP or CLI query tools, compare the last-scanned timestamp of files against the filesystem `mtime` attributes.
   - If changes are detected, output a warning header stating that the graph index is stale and X files have changed since the last update.

## Files Changed

| File | Change |
|------|--------|
| `src/core/store.ts` | Filter/exclude built-in globals during edge resolution |
| `src/parsers/common-methods.ts` | Define blacklist of JS/TS built-in global class and type names |
| `src/core/scanner.ts` | Separate/ignore import statement references from caller list |
| `src/cli.ts` / `src/mcp.ts` | Add filesystem change checks and staleness warnings |

## Acceptance Criteria

- [ ] Instantiations of standard globals (`new Date()`, `new Error()`) do not create edges to user-defined symbols
- [ ] Import statements do not pollute `mapx_callers` output with `<top-level>` lines
- [ ] Modifying file contents causes query tools to emit a warning: `Graph may be stale...`
- [ ] TypeScript compiles with 0 errors
