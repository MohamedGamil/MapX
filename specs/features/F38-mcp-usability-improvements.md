# F38 — MCP & CLI Usability Improvements

> **Iteration**: [I22](../iterations/I22.md) · **Status**: `planned` · **Priority**: 🟠 HIGH
> **Origin**: MCP Feedback Sections 2.1, 2.2, 2.3, 2.6, 3.2, & 3.4 — CLI/MCP usability issues

---

## Problem

1. **Undocumented Required Parameter**: `mapx_context` schema demands `task`, which is undocumented and causes errors on first run without it.
2. **Wildcards Unsupported**: No way to retrieve all symbols in a file via `mapx_search` (wildcard `*` fails).
3. **Case Sensitivity & Casing Errors**: The kind filter is case-sensitive and returns nothing if case mismatch occurs.
4. **Impact Risk Analysis is Generic**: `mapx impact` labels all callers as HIGH risk, ignoring call depth, test file scopes, and try/catch blocks.
5. **No MCP Guide**: The MCP server directory contains no `instructions.md` outlining query capabilities.
6. **No File summaries in LLM Export**: The LLM summary export only provides metrics, lacking brief descriptions of file roles.

## Solution

1. **Wildcard & Case-Insensitive Searches**:
   - In `mapx_search` / `mapx search`, if the search `term` is `*` or empty, skip term filtering when a file path constraint is provided.
   - Resolve search `kind` case-insensitively, and clearly document valid kinds.
2. **Tuning `mapx_context` and documentation**:
   - Update `AGENTS.md` to document the required `task` parameter.
   - Refine token-budget scoring heuristics by including cluster grouping context.
3. **Advanced Impact Analysis Risk Model**:
   - Group risk categories (HIGH, MEDIUM, LOW) based on calling depth (e.g. depth 1 is HIGH, depth 2+ is MEDIUM/LOW).
   - Label calling sites inside test files or wrapped in try/catch blocks as LOW risk.
4. **Server Documentation & Summaries**:
   - Write a detailed `instructions.md` outlining tools, usage examples, and schemas.
   - Add brief, heuristic summaries (e.g., class/method count and dominant symbol types) to file nodes in the `llm` export format.

## Files Changed

| File | Change |
|------|--------|
| `src/core/context-builder.ts` | Refine context search BFS weighting and keyword logic |
| `src/core/impact-analyzer.ts` | Refine caller risk classification algorithm |
| `src/cli.ts` / `src/mcp.ts` | Document `task` parameter; standardize kind case-insensitively; support wildcard searches |
| `src/exporters/llm-exporter.ts` | Add file-level summaries to output template |
| `.agents/rules/instructions.md` | Create comprehensive MCP tool usage guide |

## Acceptance Criteria

- [ ] `mapx search "*" --file <filename>` lists all symbols in that file
- [ ] Kind filters like `interface` or `class` function case-insensitively
- [ ] Callers at depth 2+ are categorized as MEDIUM/LOW risk in `mapx impact`
- [ ] The MCP server schema documents `task` parameter requirement
- [ ] `instructions.md` file created in workspace
- [ ] LLM export includes file role summaries
- [ ] TypeScript compiles with 0 errors
