# MapX MCP Tools: LLM Usage Guide & Improvement Analysis

> **Author perspective**: LLM agent that conducted a full end-to-end evaluation of all 32 MCP tools against the mapx codebase itself. Observations are based on actual tool invocations recorded on 2026-06-01.
>
> **Verification pass**: A second LLM independently verified every claim against source code on 2026-06-01. Corrections are noted inline with `[EDIT]` tags. New caveats discovered during the verification pass are marked `[NEW]`.

---

## 1. Tool Inventory & Coverage

All 32 MCP tools were exercised. The table below summarizes behaviour, signal quality, and caveats observed in practice.

<!-- [EDIT] Removed duplicate `mapx_clusters` and `mapx_context` rows that appeared twice in the original table. Added new caveats for `mapx_explain`, `mapx_profile`, and `mapx_smells` discovered during verification. -->

| Tool | Signal Quality | Primary Caveat |
|---|---|---|
| `mapx_scan` | ✅ Good | Output reports delta, not total — confusing (§3.1) |
| `mapx_sync` | ✅ Good | Same delta-report caveat |
| `mapx_status` | ✅ Excellent | Highly reliable; best first tool to call |
| `mapx_export` | ✅ Excellent | LLM format truncates long edge lists; use `tokens` wisely |
| `mapx_query` | ✅ Good | Glob patterns work; case-sensitive by default |
| `mapx_search` | ✅ Good | `kind` filter essential to avoid noise; silent truncation with no total count (§3.10) |
| `mapx_node` | ⚠️ Partial | Returns class range only, no method listing without source flag (§3.8) |
| `mapx_files` | ✅ Good | Useful for filtering by extension or path prefix |
| `mapx_dependencies` | ✅ Good | Self-referential edges inflate counts (§3.4) |
| `mapx_callers` | ⚠️ Partial | Blind to `this.method()` intra-class calls (§3.2) |
| `mapx_callees` | ⚠️ Partial | Same blind spot; `callees("ClassName")` always returns empty |
| `mapx_trace` | ⚠️ Partial | JSON cycles array has duplicates in single-direction mode (§3.9) |
| `mapx_impact` | ⚠️ Partial | Scratch/test files pollute blast radius (§3.5) |
| `mapx_clusters` | ⚠️ Partial | `community_1` swallowed 90 files; names are opaque (§3.6) |
| `mapx_sources` | ⚠️ Partial | Includes scratch files; misses some real entry points |
| `mapx_sinks` | ❌ Misleading | Marks core libraries as sinks (§3.3) |
| `mapx_routes` | ⚠️ Partial | Returns `[]` with no context — cannot distinguish no-framework vs no-routes (§3.7) |
| `mapx_hooks` | ⚠️ Partial | Same as routes |
| `mapx_context` | ✅ Excellent | Best tool for task-scoped deep dives |
| `mapx_metrics` | ✅ Good | Instability/coupling scores reliable |
| `mapx_profile` | ⚠️ Partial | Archetype detection can misclassify — see §3.11 |
| `mapx_explain` | ⚠️ Partial | Returns empty signals for core files — see §3.12 |
| `mapx_smells` | ⚠️ Partial | Duplicate violations inflate output — see §3.13 |
| `mapx_dsm` | ✅ Good | DSM matrix useful for coupling visualisation |
| `mapx_layers` | ✅ Good | Layer assignments reasonable; `layer:other` is catch-all (87 files) |
| `mapx_edges` | ✅ Good | Precise; essential for debugging specific relationships |
| `mapx_workspaces` | ✅ Good | Peer repo discovery works correctly |
| `mapx_batch` | ✅ Excellent | Most efficient tool for multi-symbol lookups |
| `mapx_lang_list` | ✅ Good | Accurate tier information |
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

<!-- [EDIT] Added note about file count discrepancy between scan and status, observed during E2E testing. -->

**Note**: `mapx_scan` and `mapx_status` may report slightly different file counts (e.g. 228 vs 226). The scan counts all discovered files including newly-indexed static files; status counts DB-tracked files which may lag by one sync cycle. Always trust `mapx_status` for current totals.

### 2.2 Symbol Discovery

Always use `mapx_search` with a `kind` filter before falling back to bare name queries:

```json
{ "op": "search", "term": "Scanner", "kind": "class" }    // precise
{ "op": "search", "term": "scan",    "kind": "method" }    // narrow
```

`mapx_query` with glob patterns (`*Service`, `build*`) works well for namespace scanning. Avoid calling it without a glob on common words — the result set will hit the default limit.

<!-- [EDIT] Added explicit note about silent truncation — the underlying store has countSymbolsFiltered() and offset support but MCP handler exposes neither. -->

**Truncation warning**: `mapx_search` defaults to `limit=20` and returns `Found N symbols` where N is the **returned** count, not the total matching count. There is no pagination (`offset` is not exposed in the MCP schema despite existing in the store layer). If you get exactly `limit` results, assume truncation and increase the limit.

### 2.3 Understanding a Class's Full API

`mapx_node("ClassName")` returns only the class line range and signature — **no method listing**. Follow immediately with a `search` for methods:

```json
[
  { "op": "node",   "symbol": "Scanner" },
  { "op": "search", "term": "Scanner",  "kind": "method", "limit": 50 }
]
```

Bundle both in a single `mapx_batch` call.

<!-- [EDIT] Added note about JSON format output — it omits the "Related" section and "Other symbols in same file" list available in text format. -->

**Format note**: `mapx_node` in JSON format returns a compact object (name, kind, file, lines, signature, callerCount, calleeCount) but omits the "Other symbols in same file" section shown in text format. Use text format when you need the sibling-symbol listing (capped at 5 entries).

### 2.4 Tracing Call Chains — The Intra-Class Blind Spot

`mapx_callers` and `mapx_callees` only track **cross-symbol call edges**. `this.methodX()` calls within the same class are **not indexed**. This means:

- `callers("Scanner::discoverFiles")` → returns empty (it's called via `this.discoverFiles(...)` inside the same class)
- `callees("Scanner::parseFilesParallel")` → returns empty (calls `this.parseOnMainThread(...)`)

<!-- [EDIT] Clarified root cause — the tree-sitter TypeScript references query only captures bare `identifier` calls, not `member_expression` via `this.`. This is query-level, not parser-level. -->

**Root cause**: The tree-sitter TypeScript references query (`queries/typescript/references.scm`) only captures `(call_expression function: (identifier) @ref.target_call)` — bare identifier calls. `this.method()` creates a `call_expression` with a `member_expression` function node, which is **not matched** by any query pattern. This is a query-level gap, not a parser-level limitation.

**Workaround**: Read the method source with `mapx_node("Scanner::parseFilesParallel", source=true)` to see what it calls internally, then trace those external symbols normally.

For cross-class call chains, use `mapx_trace` with `direction=down` from an external entry point (e.g. `executeTool` in mcp.ts).

<!-- [EDIT] Added that free functions called cross-file ARE tracked correctly. Verified with `callers("buildMatcher")` returning 4 callers across scanner.ts, mcp.ts. -->

**What works**: Free functions called across files are correctly tracked. `callers("buildMatcher")` correctly returns 4 callers from `Scanner::_scanIncrementalForRepo`, `Scanner::discoverFiles`, `executeTool`, and `buildServer`. The blind spot is specifically for `this.method()` within class bodies.

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

<!-- [EDIT] Added precision about dedup behavior — `both` direction has partial dedup on `fromFile->toFile` key, but single-direction (up/down) does not. -->

**Dedup behaviour**: When using `direction=both`, trace merges upstream and downstream results and deduplicates cycles on a `fromFile->toFile` key — but this loses edge-type differentiation. For `direction=up` or `direction=down`, **no deduplication occurs**, and you may see 3–7 entries for the same 2-node cycle with varying edge types or null symbol variations.

### 2.7 Sources & Sinks — Do Not Use for Library Code

`mapx_sources` and `mapx_sinks` are defined as files with no **incoming** or **outgoing** data-flow call/instantiation edges respectively. This definition makes them **unreliable for library-style files**:

<!-- [EDIT] Updated the specific edge types counted. The code at flow-tracer.ts:51-61 defines DATA_BEARING_EDGES as: call, instantiation, param_type, return_type, relation, dispatch, notify, route, render. Import/export/extends/implements are STRUCTURAL. -->

- `src/core/fuzzy-matcher.ts` is classified as a **sink** even though it is imported and called by 10+ files — because `import` edges are classified as `STRUCTURAL_EDGE`, not `DATA_BEARING_EDGE` in the flow tracer
- `src/frameworks/detectors/*.ts` (all framework detectors) are classified as sinks for the same reason
- `src/languages/registry.ts` — same issue

**Use these tools only for identifying application entry points and terminal I/O consumers**, not for library/utility classification.

<!-- [EDIT] Added that sources also suffer from scratch file pollution — 6 of 9 detected sources are in scratch/ or scripts/. Only `src/main.ts` is a real production entry point. -->

**Source quality**: Of the 9 files classified as sources, 6 are in `scratch/` or `scripts/` — only `src/main.ts` is a genuine production entry point. This makes the sources output noisy for LLM reasoning about the production codebase.

### 2.8 Clusters — Treat Communities as Approximate

```json
mapx_clusters({ "source": "directory" })  // most reliable for navigation
mapx_clusters({ "source": "layer"     })  // useful for architectural reasoning
mapx_clusters({ "source": "community" })  // coarse; community_1 = 90 files
```

Community clusters produced by Leiden algorithm are heavily influenced by edge density. The sparse call graph (due to the intra-class blind spot) creates one large community (`community_1`, 90 files) that absorbs most weakly-connected files. Directory-based and layer-based clusters are more actionable for LLM reasoning.

<!-- [EDIT] Confirmed 90-file community_1, added that the 12 total communities have 10 clusters with only 2-3 files each, making the distribution extremely lopsided. -->

**Distribution**: The 12 detected communities break down as: 1 cluster with 90 files, 1 with 11, 1 with 5, 1 with 3, and 8 clusters with just 2 files each. Over 70% of the codebase is in one mega-cluster.

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

After running `mapx_scan` on a fully-indexed codebase, the tool reported:

<!-- [EDIT] Updated example to show actual observed output from verification — 0 symbols, 66 edges when nothing changed, demonstrating the confusion more clearly. -->

```
Found 0 symbols, 66 edges in 479ms
```

But `mapx_status` immediately after showed `1053 symbols, 1324 edges`. The scan output numbers are the **new/changed file delta only** — they do not reflect total graph size. An LLM reading `0 symbols` would incorrectly conclude the scan failed or the graph is empty.

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

<!-- [EDIT] Added root cause detail — the tree-sitter query at queries/typescript/references.scm line 24-25 only matches `(call_expression function: (identifier))`, missing `(call_expression function: (member_expression object: (this)))`. -->

**Root cause**: `queries/typescript/references.scm` line 24-25 captures `(call_expression function: (identifier) @ref.target_call)`. The `this.method()` pattern creates a `member_expression` AST node, not a bare `identifier`, so it never matches. The same gap exists in the JavaScript references query.

**Improvement**: Add a tree-sitter query pattern for `(call_expression function: (member_expression object: (this) property: (property_identifier) @ref.target_call))` in the TypeScript and JavaScript references queries. Tag the source symbol with the enclosing class scope. This would dramatically improve call graph completeness for OOP codebases.

### 3.3 `mapx_sinks` Misclassifies Core Libraries

The following production-critical files are labelled as "terminal consumers" in the sinks output because they lack outgoing **data-bearing** edges (they are imported but never call tracked external symbols):

<!-- [EDIT] Updated count — 26 sinks total (was not specified before). Also noted that 4 of 26 sinks are scratch smoke-test files, further evidence of scratch pollution. -->

- `src/core/fuzzy-matcher.ts` — used by 8+ files
- `src/core/metrics.ts` — used by scanner, architecture-analyzer
- `src/frameworks/detectors/*.ts` — all framework detectors (13 files listed)
- `src/languages/registry.ts` — used by scanner, parsers
- `src/parsers/fallback-parser.ts` — used by parser registry
- `src/core/store-interface.ts` — interface/contract file
- `src/frameworks/route-registry.ts` — used by scanner post-scan pipeline

Total: 26 sinks, of which 4 are scratch smoke-test files, 13 are framework detectors, and the remaining are production utility/library files.

An LLM treating sinks as "safe to change with low impact" would severely underestimate the blast radius of modifying these files.

**Improvement**: Distinguish between "data-flow sinks" and "leaf-layer libraries". A file that has high in-degree (many importers) but no call edges out is a **stable foundation layer**, not a data sink. Consider adding a `role`-aware sink filter, or renaming this output to `data_sinks` with an explicit note excluding import-only leaf libraries.

### 3.4 Self-Referential Edges in `mapx_dependencies`

For `src/core/scanner.ts`, the dependencies output includes approximately 10 edges of the form:

```
→ src/core/scanner.ts (call)   [as dependency of itself]
← src/core/scanner.ts (call)   [as dependent of itself]
```

<!-- [EDIT] Added root cause — resolveSymbolToFile() at scanner.ts:1236-1239 has a `sameFileMatch` preference that explicitly returns the source file for intra-file symbol references, directly creating self-edges. Also, graph.ts:44-67 addDependencyEdge has no sourceFile===targetFile guard. -->

**Root cause**: `resolveSymbolToFile()` has a same-file preference — when a symbol name matches a symbol in the same file, it returns the source file itself, creating a self-referential edge. `graph.ts:addDependencyEdge()` has no `sourceFile === targetFile` guard.

These self-edges inflate the dependency count (scanner.ts shows 41 dependencies, but 10 are self-references and several others are duplicated import+instantiation pairs to the same file). This makes the deps output harder to parse programmatically.

**Improvement**: Deduplicate self-referential edges in the `deps` output, or add a `selfEdges` count field so callers can filter them out.

### 3.5 Scratch/Benchmark Files Pollute Production Graph

`scratch/nestjs-test.ts` holds **the top 5 PageRank slots** for symbols in the entire codebase. Investigation shows this is caused by **false positive call edges** from production files to scratch files:

- `src/parsers/wasm-parser.ts` has 8+ call edges to `scratch/nestjs-test.ts`
- `src/agents/generator.ts` has 4+ call edges to `scratch/nestjs-test.ts`
- `scripts/build-wasm.ts` has call edges to `scratch/nestjs-test.ts`
- `src/core/impact-analyzer.ts` → `scratch/nestjs-test.ts`

These are artefacts of the `resolveSymbolToFile` heuristic: generic function/class names in `scratch/nestjs-test.ts` (e.g. `resolve`, `load`, `canActivate`) match call sites in production files, creating phantom edges.

<!-- [EDIT] Added verified impact data — also confirmed via `mapx_status` that top 5 symbols by PageRank are ALL in scratch/nestjs-test.ts, and top file by PageRank is specs/MAPX_MCP_FEEDBACK.md (a Markdown doc). -->

Consequences:
- PageRank is dominated by scratch symbols, not production code (verified: top 5 symbols by PageRank are all in `scratch/nestjs-test.ts`)
- Top file by PageRank is `specs/MAPX_MCP_FEEDBACK.md` (a Markdown doc), not `scanner.ts` or `mcp.ts`
- Impact analysis for core functions lists scratch files as MEDIUM risk
- Community detection clusters production code with scratch files
- `mapx_context` seed expansion may pick up scratch content over real code

**Improvement**: Introduce a configurable `exclude-from-graph` list (separate from `excludePatterns`) that keeps files indexed (for completeness) but excludes them from PageRank computation, callers/callees, clusters, and impact analysis. Default this to `scratch/`, `benchmarks/`, `tests/` to match common project conventions.

### 3.6 Community Cluster Names Are Opaque

The Leiden algorithm returns clusters named `community_1` through `community_12`. `community_1` contains 90 files — over 40% of the total codebase. These opaque names and the lopsided distribution make community clusters largely unusable for LLM reasoning without significant post-processing.

<!-- [EDIT] Confirmed naming logic at cluster-engine.ts:336 — purely sequential `community_${communityIndex++}` with labels like `Community 1`. No directory/language/namespace analysis. -->

**Root cause**: `cluster-engine.ts:336` generates names as `community_${communityIndex++}` with labels `Community N`. No auto-naming based on dominant directory, language, or file patterns.

**Improvement**:
1. Auto-name communities using the dominant directory prefix or namespace of member files (e.g. `community_1` with 70 TypeScript src files → `src-core-cluster`)
2. Apply a minimum cohesion threshold below which files are not forced into a community
3. Provide `dominant_directory` and `dominant_language` fields per community in the output

### 3.7 `routes`/`hooks` Empty Response Lacks Context

Both tools return `[]` with no explanation. An LLM cannot distinguish between:
- "No frameworks detected in this project"
- "Frameworks detected but no routes/hooks extracted"
- "Tool errored silently"

<!-- [EDIT] Added observed inconsistency: `mapx_profile` reports `aspnet` as a detected framework, yet `mapx_routes` returns empty `[]`. This creates contradictory signals — the LLM sees a framework was detected but cannot tell why no routes were found. -->

**Observed inconsistency**: `mapx_profile` reports `aspnet` as a detected framework for this project (likely a false positive from `scratch/` files), yet `mapx_routes` returns `[]`. An LLM receiving both results faces contradictory information with no explanation.

**Improvement**: Return a metadata object: `{ "frameworks_detected": ["aspnet"], "routes": [], "reason": "No matching route files found for detected frameworks" }`.

### 3.8 `mapx_node` for Classes Does Not List Members

`mapx_node("Scanner")` returns the class header and line range (77–1472) but no method signatures. For a 1395-line class with 31 methods, the LLM has no way to know what methods exist without a follow-up `search` call. This requires 2 round-trips for the common "understand this class" task.

<!-- [EDIT] Added that the "Related" section shows up to 5 sibling symbols in text format, but these are NOT filtered to class members — they are arbitrary symbols from the same file. In JSON format this section is omitted entirely. -->

**Note**: The text format output includes "Other symbols in same file" (capped at 5 entries), but these are arbitrary file-level symbols, not class members. JSON format omits this entirely, returning only `callerCount` and `calleeCount`.

**Improvement**: Add an optional `include_members: true` field to `mapx_node` that returns a compact list of method/property signatures when the target is a class or interface.

### 3.9 `mapx_trace` JSON Output Has Duplicate Cycles

When running `mapx_trace(start="parseFile", direction="up", format="json")`, the `cycles` array contained 7 entries for what is effectively the same 2-node intra-file cycle, each differentiated by edge type or null symbol variation. This inflates the JSON response and makes cycle analysis unreliable.

<!-- [EDIT] Added nuance — `direction=both` mode has partial deduplication via a Map on `fromFile->toFile` key (flow-tracer.ts:166), but this loses edge type differentiation and only applies to bidirectional traces. Single-direction traces have no dedup. -->

**Dedup in `both` mode**: `flow-tracer.ts:166` deduplicates merged cycles using a `${c.fromFile}->${c.toFile}` key, which provides some dedup but loses edge type information. This mitigation is absent for `direction=up` or `direction=down` traces.

**Improvement**: Deduplicate cycle entries on `(fromFile, toFile, cycleLength)` in the JSON output, or deduplicate on canonical node pair regardless of edge type.

### 3.10 `mapx_search` Has No Pagination or Total Count

<!-- [NEW] Discovered during verification — the underlying store exposes both `offset` and `countSymbolsFiltered()` but the MCP handler uses neither. -->

`mapx_search` returns `Found N symbols` where N is the count of returned results, not the total matching. The MCP schema has `limit` (default=20) but no `offset` parameter, despite the underlying `store.searchSymbolsFiltered()` accepting both. The `store.countSymbolsFiltered()` method exists but is never called by the MCP handler.

This means an LLM receiving exactly 20 results has no way to know if there were 20 total or 200 total. The auto-expand fallback (broadening the search on zero results) is helpful, but pagination for large result sets is completely absent.

**Improvement**: Add `offset` to the MCP schema and include `totalMatches` in the response header alongside the results.

### 3.11 `mapx_profile` Can Misdetect Archetype and Frameworks

<!-- [NEW] Discovered during E2E testing — MapX (a CLI tool) is classified as "web-app" with "aspnet" framework. -->

`mapx_profile` for the MapX codebase returns:
```
Archetype: web-app (confidence: 0.85)
Detected Frameworks: aspnet
```

MapX is a **CLI tool with an MCP server**, not a web application, and has no ASP.NET code. The false positive likely arises from:
- The `scratch/nestjs-test.ts` file containing NestJS-style decorators that match ASP.NET-like patterns
- The UI server (`src/ui-server.ts`) and HTML files inflating the "web-app" archetype score

An LLM trusting this profile would make incorrect architectural assumptions about the codebase.

**Improvement**: Exclude scratch/test files from framework detection heuristics. Consider adding a confidence breakdown per framework so LLMs can identify weak signals.

### 3.12 `mapx_explain` Returns Empty Signals for Core Files

<!-- [NEW] Discovered during E2E testing — scanner.ts gets no classification signals. -->

`mapx_explain("src/core/scanner.ts")` returns:
```
Role: other (confidence: 0.50)
Signals: (none)
```

The scanner — the central orchestrator of the entire indexing pipeline — is classified as `other` with zero explanatory signals. This suggests the classifier has no heuristic for "core orchestration" or "pipeline coordinator" roles. The `other` catch-all bucket (`mapx_layers` shows 87 files in `OTHER`) is too large to be useful for architectural reasoning.

**Improvement**: Add classification signals for files with high fan-in/fan-out combinations (hub files). A file importing 10+ modules and exporting functionality should receive a `core` or `orchestrator` signal rather than defaulting to `other`.

### 3.13 `mapx_smells` Outputs Duplicate Violations

<!-- [NEW] Discovered during E2E testing — same layer violation repeated 7 times. -->

`mapx_smells` outputs the same layer violation `mcp.ts → fuzzy-matcher.ts` **7 times** as separate WARNING entries. Each is identical:
```
[WARNING] layer-violation
  Description: Layer violation: 'config' depends on 'shared' (src/mcp.ts -> src/core/fuzzy-matcher.ts)
```

This duplication appears to be caused by multiple edges between the same file pair generating separate smell entries. For a 26-entry smells output, 7 entries are this same duplicate — over 25% noise.

**Improvement**: Deduplicate smell entries on `(type, fromFile, toFile)` before output. Show edge count as metadata instead of repeating the entry.

---

## 4. Positive Observations

Despite the caveats above, several aspects work well:

- **`mapx_batch`**: Reduces round-trips effectively. The 10-operation cap is sufficient for most lookup patterns.
- **`mapx_context` task-based expansion**: The token-budgeted, seed-anchored context builder is genuinely useful. It surfaces relevant files that bare export wouldn't prioritize.
- **`mapx_search` with kind filter**: Precisely scoped; auto-expand on zero results is helpful.
- **Fuzzy "Did you mean?" on callers/impact**: Gracefully handles typos in symbol names.
- **`mapx_status` staleness detection**: Git commit hash comparison is reliable and informative. The edge breakdown (`verified: 1305, inferred: 19`) is a useful confidence signal.
- **`mapx_workspaces` peer discovery**: Automatically finds sibling repos by scanning the parent directory. Returns structured JSON with both registered repos and discovered peers.
- **`mapx_layers` and `mapx_explain`**: Layer assignment and signal breakdown are useful for architectural reasoning, especially `explain` which exposes the weighting system (when signals exist).
- **Import path resolution for Dart**: `package:` URI and `lib/` fallback correctly handled.
- **Framework detection is opt-in precise**: Route and hook extraction only fires for detected frameworks; confidence thresholds suppress low-confidence edges.
<!-- [EDIT] Added new positive observations discovered during E2E testing. -->
- **`mapx_sync` incremental efficiency**: Updating 2 changed markdown files took only 122ms — incremental path is very fast for git-tracked repos.
- **`mapx_lang_list` tier clarity**: Clear distinction between `built-in`, `bundled`, and `static` tiers helps LLMs understand language support depth.
- **`mapx_callers` depth control**: Multi-depth callers correctly chains across files (e.g. `callers("buildMatcher", depth=2)` returns 4 callers with call chain from `buildServer → executeTool → buildMatcher`).

---

## 5. Prioritised Improvement Roadmap

<!-- [EDIT] Updated priorities based on verified impact. Added new items §3.10-3.13. Moved search pagination to P1 since the store already supports it. -->

| Priority | Improvement | Impact |
|---|---|---|
| P0 | Track `this.method()` intra-class calls in TS/JS references queries | Fixes the largest call graph gap |
| P0 | Configurable graph exclusion list (`scratch/`, `tests/`) | Removes PageRank pollution & false impact |
| P1 | `mapx_scan` output: add total graph stats alongside delta | Eliminates output confusion |
| P1 | `mapx_sinks` rename/filter: exclude import-only leaf libraries | Prevents dangerous misclassification |
| P1 | `mapx_node` add `include_members` option | Reduces 2-round-trip class exploration to 1 |
| P1 | `mapx_search` add `offset` and `totalMatches` to MCP schema | Prevents silent truncation — store already supports it |
| P2 | Community cluster auto-naming | Makes cluster output usable |
| P2 | `mapx_trace` JSON cycle deduplication for single-direction traces | Cleaner programmatic consumption |
| P2 | `mapx_routes`/`mapx_hooks` empty-result context | Reduces ambiguity |
| P2 | `mapx_smells` deduplicate violations on (type, fromFile, toFile) | Removes 25%+ noise from output |
| P2 | `mapx_profile` exclude scratch files from framework detection | Prevents archetype/framework false positives |
| P3 | Self-edge deduplication in `mapx_dependencies` | Cleaner dep counts |
| P3 | `mapx_explain` add signals for hub/orchestrator files | Reduces `other` catch-all bucket (87 files) |
