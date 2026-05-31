# MapX MCP Tools: LLM Usage Guide & Improvement Analysis

> **Author perspective**: LLM agent that conducted a full end-to-end evaluation of all 32 MCP tools against the mapx codebase itself. Observations are based on actual tool invocations recorded on 2026-06-01.

---

## 1. Tool Inventory & Coverage

All 32 MCP tools were exercised. The table below summarizes behaviour, signal quality, and caveats observed in practice.

| Tool | Signal Quality | Primary Caveat |
|---|---|---|
| `mapx_scan` | ✅ Good | Output reports delta, not total — confusing (§3.1) |
| `mapx_sync` | ✅ Good | Same delta-report caveat |
| `mapx_status` | ✅ Excellent | Highly reliable; best first tool to call |
| `mapx_export` | ✅ Excellent | LLM format truncates long edge lists; use `tokens` wisely |
| `mapx_query` | ✅ Good | Glob patterns work; case-sensitive by default |
| `mapx_search` | ✅ Good | `kind` filter essential to avoid noise; limit=20 truncates silently |
| `mapx_node` | ⚠️ Partial | Returns class range only, no method listing without source flag |
| `mapx_files` | ✅ Good | Useful for filtering by extension or path prefix |
| `mapx_dependencies` | ✅ Good | Self-referential edges inflate counts (§3.4) |
| `mapx_callers` | ⚠️ Partial | Blind to `this.method()` intra-class calls (§3.2) |
| `mapx_callees` | ⚠️ Partial | Same blind spot; `callees("ClassName")` always returns empty |
| `mapx_trace` | ⚠️ Partial | JSON cycles array has duplicates; null symbol entries confusing |
| `mapx_impact` | ⚠️ Partial | Scratch/test files pollute blast radius (§3.5) |
| `mapx_clusters` | ⚠️ Partial | `community_1` swallowed 90 files; names are opaque (§3.6) |
| `mapx_sources` | ⚠️ Partial | Includes scratch files; misses some real entry points |
| `mapx_sinks` | ❌ Misleading | Marks core libraries as sinks (§3.3) |
| `mapx_routes` | ✅ Good | Returns `[]` for this TS codebase — correct |
| `mapx_hooks` | ✅ Good | Same |
| `mapx_context` | ✅ Excellent | Best tool for task-scoped deep dives |
| `mapx_metrics` | ✅ Good | Instability/coupling scores reliable |
| `mapx_clusters` | ⚠️ Partial | See §3.6 |
| `mapx_profile` | ✅ Good | Archetype detection accurate |
| `mapx_explain` | ✅ Good | Role signal breakdown useful for classification debugging |
| `mapx_smells` | ✅ Good | Actionable violations output |
| `mapx_dsm` | ✅ Good | DSM matrix useful for coupling visualisation |
| `mapx_layers` | ✅ Good | Layer assignments reasonable; `layer:other` is catch-all |
| `mapx_edges` | ✅ Good | Precise; essential for debugging specific relationships |
| `mapx_workspaces` | ✅ Good | Peer repo discovery works correctly |
| `mapx_batch` | ✅ Excellent | Most efficient tool for multi-symbol lookups |
| `mapx_lang_list` | ✅ Good | Accurate tier information |
| `mapx_context` | ✅ Excellent | Token-budgeted context generation is reliable |
| `mapx_agents_generate` | ✅ Good | Template output accurate |

---

## 2. Recommended LLM Workflows

### 2.1 Session Startup (always do this first)

```
mapx_status          → check staleness, language counts, top PageRank
mapx_sync            → if stale
mapx_export (tokens=8192–16384) → structural overview
```

Do **not** rely on `mapx_export` PageRank rankings to determine "most important" production code. In this codebase, the top two entries are a documentation Markdown file and a scratch test file — both PageRank-inflated by false positive edges or Markdown cross-references (§3.5).

### 2.2 Symbol Discovery

Always use `mapx_search` with a `kind` filter before falling back to bare name queries:

```json
{ "op": "search", "term": "Scanner", "kind": "class" }    // precise
{ "op": "search", "term": "scan",    "kind": "method" }    // narrow
```

`mapx_query` with glob patterns (`*Service`, `build*`) works well for namespace scanning. Avoid calling it without a glob on common words — the result set will hit the default limit.

### 2.3 Understanding a Class's Full API

`mapx_node("ClassName")` returns only the class line range and signature — **no method listing**. Follow immediately with a `search` for methods:

```json
[
  { "op": "node",   "symbol": "Scanner" },
  { "op": "search", "term": "Scanner",  "kind": "method", "limit": 50 }
]
```

Bundle both in a single `mapx_batch` call.

### 2.4 Tracing Call Chains — The Intra-Class Blind Spot

`mapx_callers` and `mapx_callees` only track **cross-symbol call edges**. `this.methodX()` calls within the same class are **not indexed**. This means:

- `callers("Scanner::discoverFiles")` → returns empty (it's called via `this.discoverFiles(...)` inside the same class)
- `callees("Scanner::parseFilesParallel")` → returns empty (calls `this.parseOnMainThread(...)`)

**Workaround**: Read the method source with `mapx_node("Scanner::parseFilesParallel", source=true)` to see what it calls internally, then trace those external symbols normally.

For cross-class call chains, use `mapx_trace` with `direction=down` from an external entry point (e.g. `executeTool` in mcp.ts).

### 2.5 Checking Blast Radius Before a Change

```json
mapx_impact("ClassName::methodName", depth=3)
```

Filter out non-production results: entries under `scratch/`, `benchmarks/`, or `tests/` in the impact output are development artefacts, not production risk. Today, `scratch/` files appear at MEDIUM risk for many core functions — treat them as noise.

### 2.6 Data Flow / Architecture Mapping

Use `mapx_trace` with `include_structural=true` to include import/extends edges and get a broader dependency graph. The default (`include_structural=false`) shows only call/instantiation edges, which under-represents structural coupling from imports.

The JSON format (`format=json`) from `mapx_trace` is the most programmatically useful but requires careful handling:
- `"symbol": null` entries represent file-level top-level scope, not missing data
- The `cycles` array often contains **duplicate entries** for the same cycle traversed via different edge types — deduplicate on `(fromFile, fromSymbol, toFile, toSymbol)` before processing
- `sources` and `sinks` in the JSON response represent graph endpoints within the traversal, not global sources/sinks

### 2.7 Sources & Sinks — Do Not Use for Library Code

`mapx_sources` and `mapx_sinks` are defined as files with no **incoming** or **outgoing** data-flow call/instantiation edges respectively. This definition makes them **unreliable for library-style files**:

- `src/core/fuzzy-matcher.ts` is classified as a **sink** even though it is imported and called by 10+ files — because those are `import` edges, not `call` edges in the graph
- `src/frameworks/detectors/*.ts` (all 22) are classified as sinks for the same reason
- `src/languages/registry.ts` — same issue

**Use these tools only for identifying application entry points and terminal I/O consumers**, not for library/utility classification.

### 2.8 Clusters — Treat Communities as Approximate

```json
mapx_clusters({ "source": "directory" })  // most reliable for navigation
mapx_clusters({ "source": "layer"     })  // useful for architectural reasoning
mapx_clusters({ "source": "community" })  // coarse; community_1 = 90 files
```

Community clusters produced by Leiden algorithm are heavily influenced by edge density. The sparse call graph (due to the intra-class blind spot) creates one large community (`community_1`, 90 files) that absorbs most weakly-connected files. Directory-based and layer-based clusters are more actionable for LLM reasoning.

### 2.9 Context Builder — Best Tool for Task-Scoped Work

`mapx_context` is the single most valuable tool for getting started on a task. It performs seed-anchored graph expansion, token-budgets the output, and ranks by PageRank relevance. Always prefer it over raw `mapx_export` when you have a specific task:

```json
{
  "task": "improve incremental scan performance",
  "seeds": ["Scanner", "src/core/scanner.ts"],
  "tokens": 8192,
  "depth": 2
}
```

Note: the context builder's PageRank ranking inherits the false-positive edge pollution issue, so manually seed with the files you know are relevant.

### 2.10 Batch Operations — Use Aggressively

Every individual MCP tool call is a round-trip. Use `mapx_batch` to combine up to 10 operations. The five supported operations (`search`, `node`, `callers`, `callees`, `deps`) cover the most common lookup patterns.

```json
{
  "operations": [
    { "op": "search", "term": "Scanner",  "kind": "method", "limit": 30 },
    { "op": "node",   "symbol": "Scanner" },
    { "op": "deps",   "file": "src/core/scanner.ts" },
    { "op": "callers","symbol": "buildMatcher", "depth": 2 }
  ]
}
```

---

## 3. Caveats Observed During E2E Testing

### 3.1 Scan Output Reports Delta, Not Totals

After running `mapx_scan` on a partially-stale index, the tool reported:

```
Found 115 symbols, 296 edges in 674ms
```

But `mapx_status` immediately after showed `1053 symbols, 1324 edges`. The scan output numbers are the **new/changed file delta only** — they do not reflect total graph size. An LLM reading scan output as a measure of total coverage would severely underestimate the graph.

**Improvement**: Add a `totalSymbols`/`totalEdges` field alongside `newSymbols`/`newEdges` in scan output.

### 3.2 Intra-Class `this.xxx()` Calls Not Indexed

The graph does not track method calls of the form `this.methodName(args)` within a class. This is the **biggest gap** in call graph completeness for object-oriented TypeScript/JavaScript codebases. In `Scanner` alone, the following critical internal call chains are invisible:

| Caller | Callee | Visibility |
|---|---|---|
| `_scanFullForRepo` | `discoverFiles` | ❌ invisible |
| `_scanFullForRepo` | `parseFilesParallel` | ❌ invisible |
| `_scanFullForRepo` | `resolveReferencesWithMap` | ❌ invisible |
| `parseFilesParallel` | `parseOnMainThread` | ❌ invisible |
| `parseWithWorkers` | `parseOnMainThread` | ❌ invisible |

`callers` and `callees` for any of these methods return empty, making the call graph appear disconnected. An LLM using only these tools would conclude that `discoverFiles` is never called from anywhere.

**Improvement**: Track `this.method()` calls during TypeScript/JavaScript parsing, tagging source symbol with the enclosing class scope. This would dramatically improve call graph completeness for OOP codebases.

### 3.3 `mapx_sinks` Misclassifies Core Libraries

The following production-critical files are labelled as "terminal consumers" in the sinks output because they lack outgoing **call** edges (they are imported but never call tracked external symbols):

- `src/core/fuzzy-matcher.ts` — used by 8+ files
- `src/core/metrics.ts` — used by scanner, architecture-analyzer
- `src/frameworks/detectors/*.ts` — all 22 detectors
- `src/languages/registry.ts` — used by scanner, parsers
- `src/parsers/fallback-parser.ts` — used by parser registry
- `src/core/store-interface.ts` — interface/contract file

An LLM treating sinks as "safe to change with low impact" would severely underestimate the blast radius of modifying these files.

**Improvement**: Distinguish between "data-flow sinks" and "leaf-layer libraries". A file that has high in-degree (many importers) but no call edges out is a **stable foundation layer**, not a data sink. Consider adding a `role`-aware sink filter, or renaming this output to `data_sinks` with an explicit note excluding import-only leaf libraries.

### 3.4 Self-Referential Edges in `mapx_dependencies`

For `src/core/scanner.ts`, the dependencies output includes approximately 10 edges of the form:

```
→ src/core/scanner.ts (call)   [as dependency of itself]
← src/core/scanner.ts (call)   [as dependent of itself]
```

These are internal method calls within the same file being tracked as self-edges. While technically not wrong, they inflate the dependency count (scanner.ts shows 41 dependencies, but many are self-references or duplicated import+instantiation pairs to the same file). This makes the deps output harder to parse programmatically.

**Improvement**: Deduplicate self-referential edges in the `deps` output, or add a `selfEdges` count field so callers can filter them out.

### 3.5 Scratch/Benchmark Files Pollute Production Graph

`scratch/nestjs-test.ts` holds **the top 5 PageRank slots** for symbols in the entire codebase. Investigation shows this is caused by **false positive call edges** from production files to scratch files:

- `src/parsers/wasm-parser.ts` has 8+ call edges to `scratch/nestjs-test.ts`
- `src/agents/generator.ts` has 4+ call edges to `scratch/nestjs-test.ts`
- `scripts/build-wasm.ts` has call edges to `scratch/nestjs-test.ts`
- `src/core/impact-analyzer.ts` → `scratch/nestjs-test.ts`

These are artefacts of the `resolveSymbolToFile` heuristic: generic function/class names in `scratch/nestjs-test.ts` (e.g. `resolve`, `load`, `canActivate`) match call sites in production files, creating phantom edges.

Consequences:
- PageRank is dominated by scratch symbols, not production code
- Impact analysis for core functions lists scratch files as MEDIUM risk
- Community detection clusters production code with scratch files
- `mapx_context` seed expansion may pick up scratch content over real code

**Improvement**: Introduce a configurable `exclude-from-graph` list (separate from `excludePatterns`) that keeps files indexed (for completeness) but excludes them from PageRank computation, callers/callees, clusters, and impact analysis. Default this to `scratch/`, `benchmarks/`, `tests/` to match common project conventions.

### 3.6 Community Cluster Names Are Opaque

The Leiden algorithm returns clusters named `community_1` through `community_12`. `community_1` contains 90 files — over 40% of the total codebase. These opaque names and the lopsided distribution make community clusters largely unusable for LLM reasoning without significant post-processing.

**Improvement**:
1. Auto-name communities using the dominant directory prefix or namespace of member files (e.g. `community_1` with 70 TypeScript src files → `src-core-cluster`)
2. Apply a minimum cohesion threshold below which files are not forced into a community
3. Provide `dominant_directory` and `dominant_language` fields per community in the output

### 3.7 `routes`/`hooks` Empty Response Lacks Context

Both tools return `[]` with no explanation. An LLM cannot distinguish between:
- "No frameworks detected in this project"
- "Frameworks detected but no routes/hooks extracted"
- "Tool errored silently"

**Improvement**: Return a metadata object: `{ "frameworks_detected": ["nestjs"], "routes": [], "reason": "No matching route files found for detected frameworks" }`.

### 3.8 `mapx_node` for Classes Does Not List Members

`mapx_node("Scanner")` returns the class header and line range (77–1472) but no method signatures. For a 1395-line class with 31 methods, the LLM has no way to know what methods exist without a follow-up `search` call. This requires 2 round-trips for the common "understand this class" task.

**Improvement**: Add an optional `include_members: true` field to `mapx_node` that returns a compact list of method/property signatures when the target is a class or interface.

### 3.9 `mapx_trace` JSON Output Has Duplicate Cycles

When running `mapx_trace(start="parseFile", direction="up", format="json")`, the `cycles` array contained 7 entries for what is effectively the same 2-node intra-file cycle, each differentiated by edge type or null symbol variation. This inflates the JSON response and makes cycle analysis unreliable.

**Improvement**: Deduplicate cycle entries on `(fromFile, toFile, cycleLength)` in the JSON output, or deduplicate on canonical node pair regardless of edge type.

---

## 4. Positive Observations

Despite the caveats above, several aspects work well:

- **`mapx_batch`**: Reduces round-trips effectively. The 10-operation cap is sufficient for most lookup patterns.
- **`mapx_context` task-based expansion**: The token-budgeted, seed-anchored context builder is genuinely useful. It surfaces relevant files that bare export wouldn't prioritize.
- **`mapx_search` with kind filter**: Precisely scoped; auto-expand on zero results is helpful.
- **Fuzzy "Did you mean?" on callers/impact**: Gracefully handles typos in symbol names.
- **`mapx_status` staleness detection**: Git commit hash comparison is reliable and informative.
- **`mapx_workspaces` peer discovery**: Automatically finds sibling repos by scanning the parent directory.
- **`mapx_layers` and `mapx_explain`**: Layer assignment and signal breakdown are useful for architectural reasoning, especially `explain` which exposes the weighting system.
- **Import path resolution for Dart**: `package:` URI and `lib/` fallback correctly handled.
- **Framework detection is opt-in precise**: Route and hook extraction only fires for detected frameworks; confidence thresholds suppress low-confidence edges.

---

## 5. Prioritised Improvement Roadmap

| Priority | Improvement | Impact |
|---|---|---|
| P0 | Track `this.method()` intra-class calls in TS/JS parsers | Fixes the largest call graph gap |
| P0 | Configurable graph exclusion list (`scratch/`, `tests/`) | Removes PageRank pollution & false impact |
| P1 | `mapx_scan` output: add total graph stats alongside delta | Eliminates output confusion |
| P1 | `mapx_sinks` rename/filter: exclude import-only leaf libraries | Prevents dangerous misclassification |
| P1 | `mapx_node` add `include_members` option | Reduces 2-round-trip class exploration to 1 |
| P2 | Community cluster auto-naming | Makes cluster output usable |
| P2 | `mapx_trace` JSON cycle deduplication | Cleaner programmatic consumption |
| P2 | `mapx_routes`/`mapx_hooks` empty-result context | Reduces ambiguity |
| P3 | Self-edge deduplication in `mapx_dependencies` | Cleaner dep counts |
| P3 | `mapx_search` pagination support | Prevents silent truncation |
