# F21 — Framework Detection Infrastructure

| Field | Value |
|-------|-------|
| ID | F21 |
| Status | `planned` |
| Iteration | I13 |
| Branch | `feat/i13-framework-routes` |
| Depends on | F20 (language expansion — required for Python/Go/Rust/Java/C#/Ruby parsers) |
| Blocked by | I12 recommended first (parsers must exist before framework detectors run) |

---

## Problem

F08 introduced Laravel route → controller edges as a one-off, ad-hoc implementation. To support 17 more frameworks, a shared infrastructure is needed: common types, a detector registry, a route resolver, CLI/MCP surface, and an optional schema extension. Without this foundation, each new framework would require reimplementing the same wiring.

---

## Goal

1. Define shared `FrameworkDetector` interface and `RouteBinding` types
2. Build a `FrameworkRegistry` that auto-detects active frameworks per repo
3. Build a `RouteRegistry` that collects `RouteBinding` records, resolves target files/symbols, and writes edges
4. Introduce new `ReferenceType` values: `hook`, `graphql_resolver`, `message_handler`, `websocket_handler`
5. Add optional `edge_metadata` JSON column to the `edges` table (schema v6)
6. Add `mapx routes` CLI command and `mapx_routes` MCP tool
7. Refactor F08 (Laravel route extraction) to use the new infrastructure

---

## New `ReferenceType` values

```typescript
export type ReferenceType =
  | 'import' | 'require' | 'extends' | 'implements'
  | 'call' | 'instantiation' | 'return_type' | 'param_type'
  | 'relation'          // F07: Eloquent model relationships
  | 'route'             // F08: HTTP route → handler (introduced in F08/I05, extended here to all frameworks)
  | 'middleware'        // F08: Route middleware (introduced in F08/I05, extended here)
  | 'binding'           // F09: IoC container bindings
  | 'dispatch'          // F12: Event/Job dispatch
  | 'notify'            // F12: Notification send
  | 'hook'              // F21 NEW: CMS hook registrations (Drupal, WordPress)
  | 'graphql_resolver'  // F21 NEW: GraphQL resolver → query/mutation/subscription
  | 'message_handler'   // F21 NEW: Microservice @MessagePattern / @EventPattern
  | 'websocket_handler';// F21 NEW: WebSocket @SubscribeMessage handler
```

---

## Schema extension: `edge_metadata` column

The existing `edges` table is extended with an optional JSON column:

```sql
ALTER TABLE edges ADD COLUMN metadata TEXT;  -- JSON, nullable
```

Schema bumps to v6 (v3 = F01 verifiability, v4 = F14 clusters, v5 = F18 target_repo). Migration is automatic on open (existing rows get `metadata = NULL`).

**Route edge metadata structure:**
```json
{
  "httpMethod": "GET",
  "path": "/users/{id}",
  "framework": "django",
  "confidence": "verified",
  "routeName": "user-detail",
  "middlewares": ["auth:sanctum"],
  "guards": ["IsAuthenticated"]
}
```

**For GraphQL edges:**
```json
{
  "operationType": "query",
  "operationName": "getUser",
  "framework": "nestjs",
  "confidence": "verified"
}
```

The existing encoding fallback (`target_symbol = "METHOD:path → handler"`) is kept for backward compatibility when `metadata` is null.

---

## Shared types

```typescript
// src/frameworks/types.ts

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type RouteConfidence = 'verified' | 'inferred';

export interface RouteBinding {
  sourceFile: string;
  sourceSymbol: string | null;   // route group/blueprint/router var name if known
  method: HttpMethod | 'ANY' | 'WS' | 'GQL';
  path: string;
  targetFile: string | null;     // resolved file path of handler
  targetSymbol: string | null;   // handler function/method name
  confidence: RouteConfidence;
  framework: string;
  routeName?: string;
  middlewares?: string[];
  metadata?: Record<string, unknown>;
}

export interface FrameworkDetector {
  readonly framework: string;
  readonly language: string;
  /** Returns true if this framework is active in the project */
  detect(projectRoot: string, files: string[]): boolean;
  /** Returns true if this file should be processed by this detector */
  matchesFile(filePath: string): boolean;
  /** Extract route bindings from a single file */
  extractRoutes(filePath: string, source: string, projectRoot: string): RouteBinding[];
}
```

---

## FrameworkRegistry

```typescript
// src/frameworks/registry.ts

export class FrameworkRegistry {
  private detectors: FrameworkDetector[] = [];

  register(detector: FrameworkDetector): void { ... }

  /** Returns detectors active for the given project */
  detectActive(projectRoot: string, files: string[]): FrameworkDetector[] { ... }

  /** Returns all detectors that match a specific file */
  detectorsForFile(filePath: string, activeDetectors: FrameworkDetector[]): FrameworkDetector[] { ... }
}
```

Active frameworks are cached to `.mapx/frameworks.json`:
```json
{
  "detected": ["django", "react-router"],
  "detectedAt": "2026-05-22T08:00:00Z"
}
```

Cache is invalidated when `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `Gemfile`, or `pom.xml` changes.

---

## RouteRegistry

```typescript
// src/frameworks/route-registry.ts

export class RouteRegistry {
  constructor(private store: Store) {}

  /** Called during scan phase 2 for each file */
  processFile(
    filePath: string,
    source: string,
    detectors: FrameworkDetector[],
    projectRoot: string
  ): void { ... }

  /** Resolve all pending route bindings → edges, write to store */
  flush(repo: string): void { ... }

  private resolveTarget(binding: RouteBinding, allSymbols: SymbolRow[]): GraphEdge { ... }
}
```

Scan phase 2 runs after all files have been parsed (so all symbols are in the store for target resolution).

---

## Scanner integration

```typescript
// src/core/scanner.ts  (modified)

async scan(options: ScanOptions): Promise<ScanResult> {
  // Phase 1: discover + parse files (existing)
  const symbols = await this.parseAllFiles(files, progress);

  // Phase 2: framework detection (NEW)
  if (!options.skipFrameworks) {
    const activeDetectors = frameworkRegistry.detectActive(projectRoot, files);
    if (activeDetectors.length > 0) {
      progress({ phase: 'frameworks', current: 0, total: files.length });
      for (const file of files) {
        const detectors = frameworkRegistry.detectorsForFile(file, activeDetectors);
        if (detectors.length > 0) {
          const source = await readFile(file);
          routeRegistry.processFile(file, source, detectors, projectRoot);
        }
      }
      routeRegistry.flush(options.repo);
    }
  }
}
```

New `ScanPhase` value: `'frameworks'`

---

## `mapx routes` CLI command

```
mapx routes [--framework=<name>] [--method=<GET|POST|...>] [--path=<pattern>] [--dir=<path>]

List all detected HTTP routes in the project.

Options:
  --framework   Filter by framework name (e.g. django, express, nestjs)
  --method      Filter by HTTP method
  --path        Filter by path pattern (glob)
  --format      Output format: table (default), json
  --dir         Project directory

Examples:
  mapx routes
  mapx routes --framework=django
  mapx routes --method=POST
  mapx routes --path="/api/*"
```

**Output:**
```
Routes in /path/to/project  (32 routes across 3 frameworks)

  Method  Path                         Handler                                  Framework   File
  ──────────────────────────────────────────────────────────────────────────────────────────────
  GET     /                            HomeView::get                           django      app/urls.py
  GET     /users/                      UserListView::get                       django      app/urls.py
  POST    /users/                      UserCreateView::post                    django      app/urls.py
  GET     /users/<int:pk>/             UserDetailView::get                     django      app/urls.py
  GET     /health                      healthHandler                           express     src/app.ts
  POST    /api/users                   UserController::create                  express     src/routes/users.ts
  GET     /api/users/:id               UserController::findOne                 express     src/routes/users.ts
  GQL     users (query)                UserResolver::getUsers                  nestjs      src/users/users.resolver.ts
  WS      events                       EventsGateway::handleEvent              nestjs      src/events/events.gateway.ts
```

---

## `mapx_routes` MCP tool

```typescript
{
  name: "mapx_routes",
  description: "List all HTTP routes, GraphQL resolvers, and WebSocket handlers detected in the project. Returns the route path, HTTP method, handler symbol, and source file for each route. Use this to understand the API surface of an application before making changes, or to find which handler a specific endpoint maps to.",
  inputSchema: {
    type: "object",
    properties: {
      framework: { type: "string",  description: "Filter by framework (django, express, nestjs, rails, spring, etc.)" },
      method:    { type: "string",  description: "Filter by HTTP method (GET, POST, PUT, PATCH, DELETE)" },
      path:      { type: "string",  description: "Filter by path prefix or glob (e.g. '/api/')" },
      format:    { type: "string",  enum: ["text", "json"], default: "text" },
      repo:      { type: "string" },
    }
  }
}
```

---

## Refactoring F08 (Laravel routes)

The existing Laravel `RouteExtractor` in `src/parsers/languages/php.ts` is moved to `src/frameworks/detectors/laravel.ts` and made to implement `FrameworkDetector`. Behavior is identical; it is now registered through `FrameworkRegistry` instead of being hardwired in the scanner.

---

## New source files

```
src/frameworks/types.ts                  ← RouteBinding, FrameworkDetector interface
src/frameworks/registry.ts               ← FrameworkRegistry
src/frameworks/route-registry.ts         ← RouteRegistry + edge flush
src/frameworks/detectors/               ← one file per framework (F22–F25)
src/frameworks/index.ts                  ← barrel export
```

## Modified source files

```
src/types.ts                             ← new ReferenceType values
src/core/store.ts                        ← edge_metadata column + getRouteEdges() query
src/core/scanner.ts                      ← Phase 2 framework pass
src/cli.ts                               ← mapx routes command
src/mcp.ts                               ← mapx_routes tool
src/parsers/languages/php.ts             ← move route extraction to src/frameworks/detectors/laravel.ts
```

---

## Acceptance Criteria

- [ ] `FrameworkDetector` interface and `RouteBinding` type defined in `src/frameworks/types.ts`
- [ ] `FrameworkRegistry.detectActive()` returns correct detector list for each test project
- [ ] `RouteRegistry.flush()` writes `route` edges with `metadata` JSON to the store
- [ ] Schema migration v6 adds `metadata TEXT` column to `edges` table without breaking existing databases
- [ ] `mapx routes` CLI lists routes from a test project with Django and Express
- [ ] `mapx_routes` MCP tool returns JSON-parseable response
- [ ] F08 Laravel route extraction behaviour is unchanged after refactor to `FrameworkDetector`
- [ ] `npx tsc --noEmit` passes with 0 errors
