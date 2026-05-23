# Smart Context & Search — Overview

This document describes the second major expansion of mapx's MCP and CLI surface: **targeted symbol search, call graph traversal, impact analysis, and smart context building**.

---

## Problem

The current mapx MCP interface gives LLMs a blunt instrument: `mapx_export` (full graph dump) or `mapx_query` (name LIKE search). For large codebases, `mapx_export` exhausts the token budget before covering the relevant area, and `mapx_query` returns symbol metadata but no graph context. LLMs are left to cross-reference files manually.

Concretely, an LLM asked "refactor the payment checkout flow" needs to:
1. Find symbols related to checkout/payment
2. Understand what calls those symbols (entry points)
3. Understand what those symbols call (dependencies)
4. Know the blast radius of a change (impact)
5. Receive all this as a focused, token-efficient context block

None of these are possible with the current 4-tool MCP surface.

---

## Solution: 8 new tools

| Tool | Purpose | New? |
|------|---------|------|
| `mapx_search` | Find symbols by name, kind, file pattern | New (replaces `mapx_query`) |
| `mapx_context` | Build focused task-relevant context | New |
| `mapx_callers` | Find what calls a symbol | New |
| `mapx_callees` | Find what a symbol calls | New |
| `mapx_impact` | Transitive change impact analysis | New |
| `mapx_node` | Full symbol details, optionally with source | New |
| `mapx_files` | Indexed file list (faster than filesystem) | New |
| `mapx_status` | Index health + statistics (enhanced) | Enhancement |

---

## Architecture: `ContextBuilder`

The key new component is `src/core/context-builder.ts` — a `ContextBuilder` class that powers `mapx_context`. It:

1. Takes a free-text task description or seed symbol/file list
2. Uses the graph to expand outward (callers, callees, file dependencies)
3. Applies PageRank scores as relevance weights
4. Deduplicates, ranks, and trims the result to a token budget
5. Returns an ordered `ContextItem[]` list with reasons why each file/symbol is included

All other new tools (`mapx_callers`, `mapx_callees`, `mapx_impact`) are simpler graph traversals that `ContextBuilder` composes internally.

---

## New CLI commands

```bash
mapx search <term>          # enhanced symbol search with kind/file filters
mapx callers <symbol>       # show what calls this symbol
mapx callees <symbol>       # show what this symbol calls
mapx impact <symbol>        # show change blast radius
mapx node <symbol>          # show symbol details (+ optional --source)
mapx files                  # list indexed files with metadata
```

`mapx context` is MCP-only (no CLI equivalent needed — its output is designed for LLM consumption).

---

## Relationship to existing tools

| Existing tool | Status after F19 |
|--------------|-----------------|
| `mapx_query` | Superseded by `mapx_search` (kept for backward compat with same response shape) |
| `mapx_status` | Enhanced in-place (new fields, same tool name) |
| `mapx_scan` | Unchanged |
| `mapx_export` | Unchanged |
| `mapx_dependencies` | Unchanged (file-level); `mapx_callers`/`mapx_callees` add symbol-level |

---

## Scope

### In scope for F19

All 8 tools listed above, plus their CLI equivalents where applicable. The `ContextBuilder` class. New `Store` query methods required to support them (no schema changes needed — all queries work against existing tables).

### Out of scope

- Semantic/embedding-based search (vector similarity) — deferred, requires embedding model dependency
- Test coverage tracing (which tests cover a symbol) — deferred
- AI-generated change summaries — out of scope (LLM's job)
- `mapx_context` CLI command — deferred (output format is LLM-specific)
