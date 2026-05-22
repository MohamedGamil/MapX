# F19 — Smart Context & Search Tools

| Field | Value |
|-------|-------|
| ID | F19 |
| Status | `planned` |
| Iteration | I11 |
| Branch | `feat/i11-smart-context-tools` |
| Depends on | — (independent; richer with F01 verifiability, F14 clusters, F16 flow tracing) |
| Blocked by | — |

---

## Problem

The current MCP surface (4 tools: `mapx_scan`, `mapx_query`, `mapx_dependencies`, `mapx_export`, `mapx_status`) is too coarse for LLMs doing targeted work:

- `mapx_export` dumps everything — wastes tokens on irrelevant parts of the codebase
- `mapx_query` is a name LIKE search — returns no graph context, no call relationships
- `mapx_dependencies` works at file level only — can't answer "what calls `UserService::create`?"
- `mapx_status` returns only last-scan time and counts — no health assessment or actionable info

LLMs need precision tools: "give me everything related to this task", "what breaks if I change this?", "who calls this function?", "show me the source of this symbol".

---

## Goal

Add 8 tools (7 new + 1 enhanced) that give LLMs precise, graph-driven, token-efficient answers:

1. **`mapx_search`** — structured symbol search with kind and file filters
2. **`mapx_context`** — smart context builder: relevant files + symbols for a task
3. **`mapx_callers`** — symbol-level reverse call graph (who calls this?)
4. **`mapx_callees`** — symbol-level forward call graph (what does this call?)
5. **`mapx_impact`** — transitive change blast radius (what breaks if I change this?)
6. **`mapx_node`** — full symbol details with optional source code extraction
7. **`mapx_files`** — indexed file list with metadata filters and sort
8. **`mapx_status`** (enhanced) — index health, language breakdown, hot symbols, stale detection

Add 5 corresponding CLI commands: `mapx search`, `mapx callers`, `mapx callees`, `mapx impact`, `mapx node`, `mapx files`.

---

## New source files

```
src/core/context-builder.ts     ← ContextBuilder class (powers mapx_context + mapx_impact)
```

## Modified source files

```
src/core/store.ts               ← new query methods for symbol-level call edges
src/mcp.ts                      ← 7 new tools + enhanced mapx_status
src/cli.ts                      ← 6 new subcommands
```

No schema changes required — all queries work against existing `symbols` and `edges` tables.

---

## Tool specifications

---

### 1. `mapx_search`

**Replaces `mapx_query` with a richer interface. `mapx_query` remains as a backward-compatible alias.**

```typescript
{
  name: "mapx_search",
  description: "Search for symbols (classes, functions, methods, interfaces) by name. Supports kind filters and file-path scoping. Returns definitions with locations, signatures, and PageRank importance scores. Use this instead of grep to find where something is defined.",
  inputSchema: {
    type: "object",
    required: ["term"],
    properties: {
      term:    { type: "string",  description: "Symbol name or partial name to search" },
      kind:    { type: "string",  enum: ["class","method","function","interface","trait","enum","constant","property","namespace"], description: "Filter by symbol kind" },
      file:    { type: "string",  description: "Restrict to files matching this glob or path prefix (e.g. 'app/Services/')" },
      exact:   { type: "boolean", description: "Exact match only (default: partial match)", default: false },
      limit:   { type: "number",  description: "Max results to return (default: 20, max: 100)" },
      repo:    { type: "string",  description: "Restrict to a specific repo" },
    }
  }
}
```

**Response (text format):**
```
Found 3 symbols matching "UserService":

  class   UserService                      app/Services/UserService.php:12
          signature: class UserService implements UserServiceInterface
          importance: 0.82  callers: 5  callees: 8

  method  UserService::create              app/Services/UserService.php:34
          signature: public function create(array $data): User
          importance: 0.61  callers: 3

  method  UserService::findById            app/Services/UserService.php:56
          importance: 0.45  callers: 2
```

**New `Store` method required:**
```typescript
searchSymbolsFiltered(options: {
  namePattern: string;
  kind?: string;
  filePrefix?: string;
  exact?: boolean;
  limit?: number;
  repo?: string;
}): SymbolRow[];
```

SQL:
```sql
SELECT s.*, f.language
FROM symbols s
JOIN files f ON f.path = s.file_path
WHERE s.name LIKE ?           -- or = ? if exact
  AND (? IS NULL OR s.kind = ?)
  AND (? IS NULL OR s.file_path LIKE ?)
  AND (? IS NULL OR s.repo = ?)
ORDER BY s.name
LIMIT ?
```

**CLI:**
```
mapx search <term> [--kind=<kind>] [--file=<prefix>] [--exact] [--limit=N] [--dir=<path>]
```

---

### 2. `mapx_context`

**The flagship new tool. Builds a focused, token-efficient context block for a specific task.**

```typescript
{
  name: "mapx_context",
  description: "Build a focused code context for a specific task or question. Provide a natural-language task description (e.g. 'implement payment checkout', 'debug user registration', 'add email notifications'). Returns the most relevant files and symbols within the token budget, ranked by graph centrality and keyword relevance. Use this at the start of a focused task instead of mapx_export.",
  inputSchema: {
    type: "object",
    required: ["task"],
    properties: {
      task:     { type: "string",  description: "Natural-language description of the task or question" },
      seeds:    { type: "array",   items: { type: "string" }, description: "Optional: specific symbol names or file paths to seed the context expansion" },
      tokens:   { type: "number",  description: "Token budget for context output (default: 4096, max: 16384)" },
      depth:    { type: "number",  description: "Graph expansion depth from seed symbols (default: 2)" },
      format:   { type: "string",  enum: ["text", "json"], default: "text" },
      repo:     { type: "string" },
    }
  }
}
```

**Algorithm — `ContextBuilder.build(options)`:**

```
1. SEED EXTRACTION
   If seeds[] provided: resolve each seed to a symbol or file node.
   Otherwise: tokenise task description into candidate terms.
     - Strip stop words, extract noun phrases
     - Search symbols with each term (fuzzy: split CamelCase, snake_case)
     - Take top 10 by PageRank × name-match-score

2. GRAPH EXPANSION
   For each seed node:
     - Add the node's file to the candidate set
     - Expand outward depth times:
         - Add direct callees (edge_type IN ('call','instantiation','param_type','return_type'))
         - Add direct callers (reverse edges, same types)
         - Add file-level dependencies (edge_type IN ('import','require'))
     - Score each candidate: relevance = PageRank × (1 / depth_from_seed)

3. RANKING & DEDUPLICATION
   - Merge all candidate nodes; sum relevance scores from multiple paths
   - Sort descending by relevance score
   - Assign reason tags: 'seed', 'direct caller', 'direct callee', 'dependency', 'transitive'

4. TOKEN BUDGET ALLOCATION
   Estimate tokens per file entry (~150 tokens: path + symbols + edges).
   Include files in rank order until budget exhausted.
   Always include all seed files regardless of budget.

5. OUTPUT
   Structured text (or JSON) with:
     - Task summary line
     - Per-file block: path, language, relevant symbols, why included
     - Cross-file edges between included files
     - "Also relevant (excluded by budget)" truncation notice
```

**Text output example:**
```
Context for: "implement payment checkout"
Tokens: 1,840 / 4,096   Files: 6   Symbols: 18

app/Http/Controllers/CheckoutController.php        [seed — name match]
  class  CheckoutController                        :8
  method CheckoutController::store                 :24  callers: 1 (routes/web.php)
  method CheckoutController::confirm               :58

app/Services/PaymentService.php                    [direct callee of CheckoutController::store]
  class  PaymentService                            :6
  method PaymentService::charge                    :31  callers: 2
  method PaymentService::refund                    :67

app/Http/Requests/CheckoutRequest.php              [param_type of CheckoutController::store]
  class  CheckoutRequest                           :4

app/Models/Order.php                               [instantiation in PaymentService::charge]
  class  Order                                     :5
  method Order::create                             :28

app/Repositories/OrderRepository.php               [callee of PaymentService::charge]
  class  OrderRepository                           :4
  method OrderRepository::save                     :22

routes/web.php                                     [caller of CheckoutController::store]
  (route) POST /checkout → CheckoutController::store

Cross-file edges in this context:
  CheckoutController::store → PaymentService::charge   [call]
  CheckoutController::store → CheckoutRequest          [param_type]
  PaymentService::charge    → Order::create            [instantiation]
  PaymentService::charge    → OrderRepository::save    [call]
  routes/web.php            → CheckoutController       [route]

Also relevant (excluded by token budget): app/Events/PaymentProcessed.php, app/Mail/OrderConfirmation.php
```

**JSON output:**
```json
{
  "task": "implement payment checkout",
  "files": [
    {
      "path": "app/Http/Controllers/CheckoutController.php",
      "language": "php",
      "relevanceScore": 0.94,
      "reason": "seed",
      "symbols": [
        { "name": "CheckoutController", "kind": "class", "startLine": 8 },
        { "name": "CheckoutController::store", "kind": "method", "startLine": 24 }
      ]
    }
  ],
  "edges": [...],
  "excluded": ["app/Events/PaymentProcessed.php"],
  "tokenEstimate": 1840,
  "tokenBudget": 4096
}
```

**`ContextBuilder` class:**
```typescript
export interface ContextOptions {
  task: string;
  seeds?: string[];
  tokenBudget?: number;    // default 4096
  expansionDepth?: number; // default 2
  repo?: string;
}

export interface ContextItem {
  file: string;
  language: string;
  relevanceScore: number;
  reason: 'seed' | 'direct-caller' | 'direct-callee' | 'dependency' | 'transitive';
  symbols: SymbolRow[];
  incomingEdges: EdgeRow[];
  outgoingEdges: EdgeRow[];
}

export interface ContextResult {
  task: string;
  items: ContextItem[];
  excluded: string[];
  edges: EdgeRow[];
  tokenEstimate: number;
  tokenBudget: number;
}

export class ContextBuilder {
  constructor(private store: Store, private graph: MapxGraph) {}

  build(options: ContextOptions): ContextResult { ... }

  private extractSeedTerms(task: string): string[] { ... }
  private resolveSeeds(terms: string[]): string[] { ... }    // returns file paths
  private expand(seeds: string[], depth: number): Map<string, number> { ... }
  private estimateTokens(items: ContextItem[]): number { ... }
}
```

---

### 3. `mapx_callers`

**Find all symbols that call a given symbol. Symbol-level precision (not file-level).**

```typescript
{
  name: "mapx_callers",
  description: "Find all symbols that call or instantiate a given symbol. Use this to understand entry points and all code paths that reach a function. More precise than mapx_dependencies (which works at file level).",
  inputSchema: {
    type: "object",
    required: ["symbol"],
    properties: {
      symbol: { type: "string",  description: "Symbol name (e.g. 'UserService::create') or just class name (e.g. 'UserService')" },
      depth:  { type: "number",  description: "Traversal depth for transitive callers (default: 1, max: 5)" },
      kinds:  { type: "array",   items: { type: "string" }, description: "Edge types to follow (default: ['call','instantiation'])" },
      repo:   { type: "string" },
    }
  }
}
```

**Response:**
```
Callers of UserService::create  (depth 1)

  CheckoutController::store       app/Http/Controllers/CheckoutController.php:31  [call]
  AdminController::createUser     app/Http/Controllers/AdminController.php:88     [call]
  UserSeeder::run                 database/seeders/UserSeeder.php:18               [call]

3 direct callers.
```

With `--depth=2`:
```
Callers of UserService::create  (depth 2)

  Direct (depth 1):
    CheckoutController::store     app/Http/Controllers/CheckoutController.php:31  [call]
    AdminController::createUser   app/Http/Controllers/AdminController.php:88     [call]

  Transitive (depth 2):
    routes/web.php → CheckoutController::store  [route → call]
    AdminApiController::store   → AdminController::createUser  [call → call]
```

**New `Store` method:**
```typescript
getCallersOfSymbol(symbolName: string, edgeTypes?: string[]): EdgeRow[];
// SELECT e.*, s.file_path, s.kind FROM edges e
// JOIN symbols s ON s.name = e.source_symbol
// WHERE e.target_symbol LIKE ? AND e.edge_type IN (...)
```

**CLI:**
```
mapx callers <symbol> [--depth=N] [--dir=<path>]
```

---

### 4. `mapx_callees`

**Find all symbols that a given symbol calls.**

```typescript
{
  name: "mapx_callees",
  description: "Find all symbols called or instantiated by a given symbol. Use this to understand what a function depends on and to trace its execution path forward.",
  inputSchema: {
    type: "object",
    required: ["symbol"],
    properties: {
      symbol: { type: "string" },
      depth:  { type: "number", description: "Traversal depth (default: 1, max: 5)" },
      kinds:  { type: "array", items: { type: "string" } },
      repo:   { type: "string" },
    }
  }
}
```

**Response:**
```
Callees of UserService::create  (depth 1)

  User::fill                  app/Models/User.php:23          [call]
  User (constructor)          app/Models/User.php:8           [instantiation]
  UserRepository::save        app/Repositories/UserRepository.php:22  [call]
  UserCreated (event)         app/Events/UserCreated.php:5    [instantiation]

4 direct callees.
```

**New `Store` method:**
```typescript
getCalleesOfSymbol(symbolName: string, edgeTypes?: string[]): EdgeRow[];
// SELECT e.*, s.file_path, s.kind FROM edges e
// LEFT JOIN symbols s ON s.name = e.target_symbol
// WHERE e.source_symbol LIKE ? AND e.edge_type IN (...)
```

**CLI:**
```
mapx callees <symbol> [--depth=N] [--dir=<path>]
```

---

### 5. `mapx_impact`

**Transitive blast-radius analysis. Given a symbol, what code is affected if it changes?**

```typescript
{
  name: "mapx_impact",
  description: "Analyze the change impact of modifying a symbol. Returns all code affected by a change — direct callers, transitive callers, files that type-hint on this symbol, and files that extend/implement it. Risk-scored by proximity. Use before refactoring to understand scope.",
  inputSchema: {
    type: "object",
    required: ["symbol"],
    properties: {
      symbol: { type: "string",  description: "Symbol to analyze (class, method, function, interface)" },
      depth:  { type: "number",  description: "Max transitive depth (default: 3, max: 8)" },
      format: { type: "string",  enum: ["text", "json"], default: "text" },
      repo:   { type: "string" },
    }
  }
}
```

**Algorithm:**
Uses `ContextBuilder.expand()` in reverse direction with edge types:
- `call` + `instantiation` → direct runtime impact
- `param_type` + `return_type` → type contract impact (signature change)
- `extends` + `implements` → inheritance impact (interface/base class change)
- `import` + `require` → module-level awareness (weaker, lower risk)

Each affected node gets a risk score:
- `HIGH` — depth 1 call/instantiation (breaks immediately if signature changes)
- `MEDIUM` — depth 2 call or depth 1 type-hint (may break depending on change)
- `LOW` — depth 3+ or import-only (awareness, unlikely to break)

**Text response:**
```
Impact analysis: UserService::create

  HIGH risk (direct callers — will break if signature changes):
    CheckoutController::store   app/Http/Controllers/CheckoutController.php:31
    AdminController::createUser app/Http/Controllers/AdminController.php:88
    UserSeeder::run             database/seeders/UserSeeder.php:18

  HIGH risk (type contracts — break if param/return type changes):
    UserServiceInterface::create  app/Contracts/UserServiceInterface.php:12  [param_type]

  MEDIUM risk (transitive callers — depth 2):
    routes/web.php                                    (via CheckoutController::store)
    app/Http/Middleware/AdminAuth.php                 (via AdminController::createUser)

  LOW risk (import-only awareness):
    tests/Unit/UserServiceTest.php                    (imports UserService)
    tests/Feature/CheckoutTest.php                    (imports CheckoutController)

Summary: 3 HIGH, 4 MEDIUM, 2 LOW   Total affected: 9 files
Recommendation: Treat as BREAKING CHANGE — update all HIGH-risk callers.
```

**JSON response:**
```json
{
  "symbol": "UserService::create",
  "depth": 3,
  "affected": [
    {
      "file": "app/Http/Controllers/CheckoutController.php",
      "symbol": "CheckoutController::store",
      "risk": "HIGH",
      "reason": "direct-caller",
      "depth": 1,
      "edgeType": "call"
    }
  ],
  "summary": { "HIGH": 3, "MEDIUM": 4, "LOW": 2, "total": 9 }
}
```

**CLI:**
```
mapx impact <symbol> [--depth=N] [--format=text|json] [--dir=<path>]
```

---

### 6. `mapx_node`

**Full details about a specific symbol — the "go to definition" equivalent for the code graph.**

```typescript
{
  name: "mapx_node",
  description: "Get full details about a specific symbol: kind, file location, signature, callers count, callees count, and PageRank importance. Pass --source=true to include the actual source lines. Use this when you need to read a specific function/class without opening the whole file.",
  inputSchema: {
    type: "object",
    required: ["symbol"],
    properties: {
      symbol: { type: "string",  description: "Symbol name. Use 'ClassName::methodName' for methods." },
      source: { type: "boolean", description: "Include source code lines (default: false)" },
      repo:   { type: "string" },
    }
  }
}
```

**Response (source: false):**
```
UserService::create
  Kind:        method
  Class:       UserService
  File:        app/Services/UserService.php
  Lines:       34–72
  Signature:   public function create(array $data): User
  Importance:  0.61 (PageRank)
  Callers:     3  (CheckoutController::store, AdminController::createUser, UserSeeder::run)
  Callees:     4  (User::fill, User (new), UserRepository::save, UserCreated (new))
  Metadata:    {}
```

**Response (source: true):**
```
UserService::create  (app/Services/UserService.php:34–72)

  34:  public function create(array $data): User
  35:  {
  36:      $user = new User();
  37:      $user->fill($data);
  38:      ...
  72:  }
```

Source extraction reads the actual file from disk between `startLine` and `endLine`.

**New Store method:**
```typescript
getSymbolByName(name: string, repo?: string): SymbolRow | undefined;
// Handles both 'MethodName' and 'ClassName::MethodName' forms
// For 'Class::Method': WHERE name = 'Method' AND scope = 'Class'
// For 'Method': WHERE name = 'Method'
// If multiple matches: return highest PageRank one
```

**CLI:**
```
mapx node <symbol> [--source] [--dir=<path>]
```

---

### 7. `mapx_files`

**List indexed files with metadata. Faster than filesystem scanning — reads from SQLite.**

```typescript
{
  name: "mapx_files",
  description: "List all indexed files with metadata (language, size, line count, last scanned). Use filters to scope to a subdirectory or language. Faster than filesystem scanning because it reads from the index. Useful for understanding project structure before diving into specific files.",
  inputSchema: {
    type: "object",
    properties: {
      dir:      { type: "string",  description: "Target project directory" },
      path:     { type: "string",  description: "Filter by file path prefix (e.g. 'app/Services/')" },
      lang:     { type: "string",  description: "Filter by language (e.g. 'php', 'typescript')" },
      sort:     { type: "string",  enum: ["path", "size", "lines", "scanned"], default: "path" },
      limit:    { type: "number",  description: "Max files to return (default: 50, max: 500)" },
      repo:     { type: "string" },
    }
  }
}
```

**Response:**
```
Indexed files: 312 total (showing 50)
Filter: lang=php, sort=lines desc

  Lines  Size    File
  ──────────────────────────────────────────────────────────
  842    28KB    app/Http/Controllers/CheckoutController.php
  634    21KB    app/Services/PaymentService.php
  412    14KB    app/Models/Order.php
  ...
```

**New Store method:**
```typescript
getFilesFiltered(options: {
  pathPrefix?: string;
  language?: string;
  sort?: 'path' | 'size' | 'lines' | 'scanned';
  limit?: number;
  repo?: string;
}): FileRow[];
```

SQL:
```sql
SELECT * FROM files
WHERE (? IS NULL OR path LIKE ?)
  AND (? IS NULL OR language = ?)
  AND (? IS NULL OR repo = ?)
ORDER BY <sort_column>
LIMIT ?
```

**CLI:**
```
mapx files [--path=<prefix>] [--lang=<lang>] [--sort=<field>] [--limit=N] [--dir=<path>]
```

---

### 8. `mapx_status` (enhanced)

**Enriches the existing `mapx_status` tool with actionable health information.**

> **⚠ BREAKING CHANGE** — The text output format of `mapx_status` is restructured. Consumers parsing `mapx_status` output programmatically (scripts, CI pipelines) must update their parsers. The JSON output format (if used via the MCP tool) preserves all existing fields and adds new ones (additive, not breaking for JSON consumers). The backward-compatibility guarantee is: the first summary line (`Files: N | Symbols: N | Edges: N`) is preserved in the same position.

The existing implementation returns only:
```
Directory: /path
Last scan: 2h ago
Last commit: abc1234
Files: 312 | Symbols: 1840 | Edges: 4820
```

**Enhanced response:**

```typescript
{
  name: "mapx_status",
  description: "Check index health and statistics. Returns scan recency, file counts, language breakdown, top symbols by importance, and whether a re-scan is recommended. Use this at the start of a session to verify the index is up to date.",
  // inputSchema unchanged — still accepts optional dir
}
```

**New text response:**
```
Index status for /path/to/project

  Health:       ✓ index is current
  Last scan:    2 hours ago  (2026-05-22T08:00:00Z)
  Index commit: abc1234 (HEAD — no changes since scan)

  Contents:
    Files:      312  (PHP: 198, TypeScript: 72, JavaScript: 42)
    Symbols:    1,840
    Edges:      4,820
    Clusters:   8  (if F14 merged)

  Top files by importance (PageRank):
    app/Services/UserService.php         score: 0.91
    app/Http/Controllers/UserController.php  score: 0.84
    app/Models/User.php                  score: 0.79

  Top symbols by importance:
    UserService::create      (method)   score: 0.61
    User                     (class)    score: 0.58
    OrderRepository::save    (method)   score: 0.44

  Recommendation: Index is current. No re-scan needed.
```

When stale:
```
  Health:       ⚠ stale — 3 files changed since last scan
  Changed files:
    app/Services/PaymentService.php  (modified)
    app/Http/Controllers/NewController.php  (added)
    app/Models/Receipt.php  (deleted)

  Recommendation: Run `mapx update` to refresh (incremental, ~0.5s estimated).
```

**New Store methods needed:**
```typescript
getTopFilesByPageRank(limit: number, repo?: string): Array<{ path: string; score: number }>;
getTopSymbolsByPageRank(limit: number, repo?: string): Array<{ name: string; kind: string; score: number }>;
// Both read from graph PageRank scores (computed in memory, not stored in SQLite)
```

**CLI:** `mapx status` already exists; the enhanced output is applied there too.

---

## `ContextBuilder` class detail

```typescript
// src/core/context-builder.ts

export interface ContextOptions {
  task: string;
  seeds?: string[];      // symbol names or file paths to anchor context
  tokenBudget?: number;  // default 4096
  expansionDepth?: number; // default 2
  format?: 'text' | 'json';
  repo?: string;
}

export interface ContextItem {
  file: string;
  language: string;
  relevanceScore: number;
  reason: 'seed' | 'direct-caller' | 'direct-callee' | 'dependency' | 'transitive';
  symbols: Array<{ name: string; kind: string; startLine: number }>;
  incomingEdges: Array<{ from: string; fromSymbol: string | null; type: string }>;
  outgoingEdges: Array<{ to: string; toSymbol: string | null; type: string }>;
}

export interface ContextResult {
  task: string;
  items: ContextItem[];
  excluded: string[];
  crossEdges: Array<{ from: string; fromSymbol: string | null; to: string; toSymbol: string | null; type: string }>;
  tokenEstimate: number;
  tokenBudget: number;
}

export class ContextBuilder {
  constructor(private store: Store, private graph: MapxGraph) {}

  build(options: ContextOptions): ContextResult { ... }

  // Keyword extraction: split CamelCase, snake_case, remove stop words
  private extractTerms(task: string): string[] { ... }

  // Given term list, find top-scoring symbol matches
  private resolveTermsToSymbols(terms: string[]): string[] { ... }

  // BFS from seed files through call + dependency edges
  private expandGraph(seedFiles: string[], depth: number): Map<string, number> { ... }

  // Rough token estimator (150 tokens/file + 20 tokens/symbol)
  private estimateTokens(items: ContextItem[]): number { ... }

  // Format result as human-readable text
  formatText(result: ContextResult): string { ... }
}
```

---

## Impact analysis helper

`mapx_impact` uses `ContextBuilder.expandGraph()` in **reverse** direction with risk scoring:

```typescript
export type ImpactRisk = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ImpactItem {
  file: string;
  symbol: string | null;
  risk: ImpactRisk;
  reason: string;
  depth: number;
  edgeType: string;
  path: string[];  // chain of symbols from changed symbol to this one
}

export interface ImpactResult {
  symbol: string;
  depth: number;
  affected: ImpactItem[];
  summary: Record<ImpactRisk, number>;
}
```

Risk assignment rules:
- `HIGH`: depth=1 AND edgeType IN (`call`, `instantiation`, `param_type`, `return_type`, `extends`, `implements`)
- `MEDIUM`: depth=2 AND edgeType IN (`call`, `instantiation`) OR depth=1 AND edgeType IN (`import`)
- `LOW`: depth≥3 OR (depth≤2 AND edgeType = `import`)

---

## Backward compatibility

| Concern | Handling |
|---------|---------|
| `mapx_query` still works | Kept as alias — delegates to `mapx_search` with same response shape |
| `mapx_status` response format | Text output is a superset; existing parsers reading only the first line still work |
| No schema migration | All new queries use existing tables with new SQL — no ALTER TABLE needed |
| CLI `mapx query` | Still works; new `mapx search` is the preferred form |

---

## Acceptance Criteria

### `mapx_search`
- [ ] `mapx_search { term: "User" }` returns all symbols with "User" in name
- [ ] `mapx_search { term: "create", kind: "method" }` returns only methods
- [ ] `mapx_search { term: "UserService", file: "app/Services/" }` scopes to directory
- [ ] `mapx_search { term: "UserService", exact: true }` returns only exact name matches
- [ ] `limit` parameter respected; default 20 applied
- [ ] Results include importance score and caller/callee counts
- [ ] `mapx query <term>` still works unchanged (backward compat)

### `mapx_context`
- [ ] `mapx_context { task: "checkout payment" }` returns checkout-related files
- [ ] `mapx_context { task: "...", seeds: ["UserService"] }` anchors to UserService
- [ ] Token budget respected — response does not exceed `tokens` parameter
- [ ] `format: json` returns valid JSON with `items`, `edges`, `excluded`
- [ ] `depth: 1` returns only direct neighbors; `depth: 3` returns transitive
- [ ] Excluded files listed when budget exhausted
- [ ] Empty task with no seeds returns sensible error

### `mapx_callers`
- [ ] Returns all direct callers of a symbol (call + instantiation edges)
- [ ] `depth: 2` returns transitive callers
- [ ] Works with both `MethodName` and `Class::MethodName` forms
- [ ] Returns file path and line number for each caller

### `mapx_callees`
- [ ] Returns all direct callees of a symbol
- [ ] `depth: 2` returns transitive callees
- [ ] Works with both symbol name forms

### `mapx_impact`
- [ ] Returns HIGH/MEDIUM/LOW risk items for a changed symbol
- [ ] `depth` parameter controls transitive depth
- [ ] Summary counts correct
- [ ] `format: json` returns valid JSON
- [ ] `Recommendation:` line varies based on risk level

### `mapx_node`
- [ ] Returns kind, file, lines, signature, callers count, callees count
- [ ] `source: true` returns source lines from disk (reads file)
- [ ] Handles `Class::method` scoped lookup
- [ ] Returns 404-style error when symbol not found

### `mapx_files`
- [ ] Returns all files when no filters
- [ ] `path: "app/Services/"` restricts to that prefix
- [ ] `lang: "php"` restricts by language
- [ ] `sort: "lines"` sorts descending by line count
- [ ] `limit` respected; default 50

### `mapx_status` (enhanced)
- [ ] Includes language breakdown
- [ ] Includes top-5 files and top-5 symbols by importance
- [ ] Shows `✓ index is current` when HEAD matches last scan commit
- [ ] Shows `⚠ stale` with changed file list when git reports changes
- [ ] Includes `Recommendation:` line

### Common
- [ ] All 6 new CLI commands (`mapx search`, `mapx callers`, `mapx callees`, `mapx impact`, `mapx node`, `mapx files`) work correctly
- [ ] TypeScript type-check: `npx tsc --noEmit` passes with 0 errors
- [ ] All existing MCP tool behaviour unchanged

---

## Out of scope for F19

- Semantic/embedding-based similarity search (vector indexes) — deferred
- AI-generated change summaries in `mapx_impact` output
- `mapx_context` CLI command (output is LLM-specific, not human-readable)
- Cross-repo callers/callees (requires F18 multi-repo support)
- Test impact analysis (which tests cover a symbol)
- Live watch mode (re-compute context as files change)
