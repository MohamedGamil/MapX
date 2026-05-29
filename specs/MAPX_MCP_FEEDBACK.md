# MapxGraph MCP Server — Shortcomings, Caveats & Missing Functionality

> **Context**: This document is based on real-world experience using MapxGraph v0.2.6 via MCP during a comprehensive codebase audit, gap analysis, and full dashboard refactoring of a TypeScript/React/NestJS monorepo (~718 symbols, ~1361 edges, 22+ source files modified in a single session).
>
> **Date**: 2026-05-27
> **Project**: L3 Precision URL Engine (Turborepo monorepo with NestJS backend, React/Vite dashboard, Next.js landing, and shared packages)

---

## 1. Critical Blockers

### 1.1 `export default function` Components Are Invisible

**Severity**: 🔴 Critical — renders React graph analysis nearly useless

The TypeScript/TSX parser does not extract symbols from `export default function` declarations. This is the dominant export pattern in React applications.

```typescript
// ❌ INVISIBLE to mapx — not indexed at all
export default function LinksPage() { ... }
export default function App() { ... }
export default function DashboardLayout() { ... }

// ✅ Visible to mapx
export function useLinks() { ... }
export interface WorkspaceData { ... }
```

**Verified behavior** (post-sync with 71 files updated, 158 symbols):
- `mapx_search term=LinksPage` → `No symbols matching "LinksPage"`
- `mapx_search term=App file=App.tsx` → `No symbols matching "App"`
- `mapx_search term=DashboardLayout` → `No symbols matching "DashboardLayout"`
- `mapx_search term=AuthProvider` → `No symbols matching "AuthProvider"` (this is a **named** export function, not default)
- `mapx_search term=BreakdownList` → `No symbols matching "BreakdownList"` (also a named export)
- `mapx_search term=useLinks` → ✅ Found
- `mapx_search term=WorkspaceData` → ✅ Found

The inconsistency between `AuthProvider` (not found) and `useLinks` (found) — both are named exported functions — suggests the parser may have additional issues beyond just `export default`. Functions declared inside an `export function` parent scope, or functions that receive complex generic parameters, may also be missed.

**Impact**: In a React refactoring task where I decomposed a 4,827-line `App.tsx` into 20+ modular page components, **none** of the resulting page components were visible in the graph. The entire component tree — the most important part of a React app's architecture — was a black hole. I could not use `mapx_callers`, `mapx_impact`, or `mapx_trace` to understand which components consumed which hooks.

**Recommendation**: Support all function/class/const export forms:
- `export default function Foo() {}`
- `export default class Foo {}`
- `const Foo = () => {}; export default Foo;`
- `export default () => {}` (anonymous — use filename as symbol name)

### 1.2 React Component JSX Composition Not Tracked as Edges

**Severity**: 🔴 Critical — component hierarchy is invisible

Even if `export default function` were fixed, React component usage via JSX is not tracked as a dependency edge. In React, `<LinksPage />` inside a router is a "call" to that component, but mapx only tracks `import` statements, not JSX element usage.

```tsx
// This import IS tracked:
import LinksPage from './pages/dashboard/LinksPage';

// This usage is NOT tracked as a call/instantiation edge:
<Route path="/links" element={<LinksPage />} />
```

**Impact**: The React component tree — the primary architectural structure of any React app — is completely invisible to `mapx_callers`, `mapx_callees`, `mapx_trace`, and `mapx_impact`. You cannot answer "which components render LinksPage?" or "what is the blast radius of changing the DashboardLayout props?".

### 1.3 `mapx_routes` Returns Empty for NestJS

**Severity**: 🔴 Critical — primary backend framework not supported for route detection

```
mapx_routes dir=~/Projects/l3 → []
```

This project is a NestJS application with 10+ controllers using `@Controller()`, `@Get()`, `@Post()`, `@Patch()`, `@Delete()` decorators. The route detection engine returned zero results. NestJS is one of the most popular Node.js frameworks and decorator-based routing should be parseable.

**Impact**: During the audit, I needed to enumerate all API endpoints to verify rate limiting coverage. I had to fall back to `grep_search` for `@Get\|@Post\|@Patch\|@Delete` patterns instead of using mapx's structured route data.

### 1.4 `mapx_hooks` Returns Empty for NestJS Lifecycle Hooks

**Severity**: 🟠 High

```
mapx_hooks dir=~/Projects/l3 → []
```

NestJS has well-defined lifecycle hooks (`OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`), guards (`CanActivate`), interceptors, and pipes. None were detected. Similarly, React hooks (`useEffect`, `useState`, `useCallback`) in the dashboard app were not detected.

---

## 2. Major Shortcomings

### 2.1 `mapx_context` — Undocumented Required Parameter & Poor Relevance Ranking

The `mapx_context` tool's `task` parameter is marked as `required` in the schema, but the `AGENTS.md` documentation describes it only as "Intelligent, token-budgeted workspace context builder" without mentioning this requirement. On first use with only a `budget` parameter, it returned:

```
Missing required parameter: task
```

Beyond the documentation issue, the context builder's relevance ranking is questionable. When asked about "dashboard authentication flow and API client token refresh", it correctly included `api/client.ts` but also included `useApiClients.ts` (OAuth client generation — unrelated to auth flow) and `auth.dto.ts` (backend DTOs — useful but lower priority than the actual `AuthContext.tsx` which was completely missing because it uses `export default`-like patterns).

### 2.2 `mapx_search` — Wildcard/Glob Patterns Don't Work

```
mapx_search term=* file=apps/dashboard/src/contexts → No symbols matching "*"
```

There is no way to list all symbols in a specific directory or file. The `term` parameter doesn't support wildcards or glob patterns, so you cannot do exploratory queries like "show me everything in this directory." The workaround is to use `mapx_files` to list files, then `mapx_node` on each symbol — but you need to already know the symbol names.

**Recommendation**: Support `*` or empty string as "match all" for the `term` parameter when a `file` filter is provided.

### 2.3 `mapx_search` — `kind` Filter Silently Returns Nothing for Valid Kinds

```
mapx_search term=Auth kind=interface → No symbols matching "Auth"
```

But `interface AuthContextValue` exists in the codebase. The `kind` filter appears to interact poorly with the `term` search — either the kind values don't match what the parser produces, or the filter is applied before the search. There's no documentation on what `kind` values are valid (is it `interface`, `Interface`, `INTERFACE`?).

### 2.4 `mapx_files` — Missing Files After Sync

After syncing 71 changed files (including 15+ new `.tsx` page components), `mapx_files` only returned 14 files for the dashboard app — exclusively `.ts` files. All `.tsx` files (pages, layouts, components) were completely absent from the file listing:

```
mapx_files path=apps/dashboard → 14 files (all .ts, zero .tsx)
```

This means the entire React component layer — layouts, pages, chart components — is not just invisible as symbols, but the *files themselves* are not listed. The `.tsx` extension appears to be treated differently from `.ts` despite both being TypeScript.

### 2.5 `mapx_callers` — Noisy `<top-level>` Entries

Every `import` statement generates a `<top-level>` caller entry:

```
← <top-level> (calls apiFetch) @ apps/dashboard/src/hooks/useAnalytics.ts:2
← useAnalytics (calls apiFetch) @ apps/dashboard/src/hooks/useAnalytics.ts:24
```

The `<top-level>` at line 2 is just the `import { apiFetch }` statement, not an actual call. This doubles the noise in every callers query and makes it harder to see the real usage graph. Import-level references should be categorized differently from actual invocations.

### 2.6 `mapx_impact` — All Callers Marked as HIGH Risk

```json
{
  "summary": { "high": 14, "medium": 0, "low": 0 },
  "recommendation": "Treat as BREAKING CHANGE — update all HIGH-risk callers"
}
```

Every single caller of `apiFetch` was marked as `HIGH` risk with zero differentiation. A useful impact analysis should consider:
- Whether the caller uses the specific parameter being changed
- Whether the caller is a test file vs. production code
- Whether the call site is in a try/catch (lower risk)
- Distance from the change (depth 1 = HIGH, depth 2+ = MEDIUM/LOW)

As-is, the impact analysis is just a glorified `mapx_callers` with a blanket "BREAKING CHANGE" label, regardless of the actual change.

---

## 3. Design Caveats

### 3.1 Monorepo Cross-Package Edge Pollution

The `mapx_trace` output showed cross-package edges that are semantically incorrect:

```
useLinks (apps/dashboard/src/hooks/useLinks.ts)
  └─[instantiation]─→ Date (apps/backend/src/modules/admin/dto/feature-flags.dto.ts)
```

`new Date()` in the dashboard is not instantiating anything from the backend's DTO file. Mapx appears to resolve `Date` to the first symbol named `Date` it finds in the graph, which happens to be a `@Type(() => Date)` decorator in a completely unrelated backend file. This pollutes the trace graph with false dependencies.

Similarly, `Error` in `apiFetch` was resolved to:
```
└─[instantiation]─→ Error (apps/backend/src/shared/logger/app-logger.ts)
```

Built-in JavaScript globals (`Date`, `Error`, `Map`, `Set`, `Promise`, etc.) should not be resolved to user-defined symbols with the same name.

### 3.2 No `instructions.md` for the MCP Server

The MCP server has no `instructions.md` file in its schema directory (`~/.gemini/antigravity/mcp/github/`). Other MCP servers provide usage guidance, best practices, and known limitations. The `AGENTS.md` user rule partially covers this but is generic — it doesn't describe parameter formats, valid enum values for filters, or edge type semantics.

### 3.3 Graph Staleness After Writes Is Not Communicated

After creating 15+ new files, querying mapx returned stale results with no indication that the graph was outdated. The agent must know to call `mapx_sync` after file changes, but there is no proactive warning or automatic invalidation. A simple "graph may be stale, X files changed since last scan" header on query results would prevent silent staleness.

### 3.4 `mapx_export format=llm` Doesn't Include File-Level Summaries

The LLM export format lists files with symbol counts and edges, but doesn't include any semantic summary of what each file does. For an LLM trying to understand a codebase, "what does this file do?" is more valuable than "this file has 12 symbols and 8 edges." Even a one-line heuristic summary based on the dominant symbol kinds would help.

---

## 4. Missing Functionality

### 4.1 No React/JSX-Specific Analysis

React is one of the most common frontend frameworks, yet mapx has zero React-specific features:
- No component tree extraction (parent → child rendering)
- No prop flow analysis (which props does component X receive?)
- No hook dependency tracking (`useEffect` dependency arrays)
- No context provider/consumer mapping
- No route structure extraction from `react-router-dom`

### 4.2 No TypeScript Type-Level Analysis

Mapx tracks runtime symbols (functions, classes) but not type-level constructs:
- No tracking of which interfaces a class implements
- No type alias resolution
- No generic parameter analysis
- No union/intersection type tracking
- Type-only imports (`import type { ... }`) don't create edges

For a TypeScript-heavy codebase, understanding the type graph is as important as understanding the call graph.

### 4.3 No Decorator Analysis for NestJS/Angular

NestJS and Angular rely heavily on decorators for DI, routing, and metadata:
- `@Injectable()`, `@Controller()`, `@Module()` define the DI graph
- `@Get()`, `@Post()` define routes
- `@UseGuards()`, `@UseInterceptors()` define middleware chains
- `@Inject()` defines constructor injection targets

None of these are parsed or tracked, making mapx significantly less useful for the two most popular TypeScript backend/frontend frameworks.

### 4.4 No Diff-Aware Analysis

There's no tool to answer "what changed between two points in time?" or "what symbols were added/removed/modified since commit X?". During a large refactoring, being able to say "show me the impact of all changes since the last scan" would be invaluable.

### 4.5 No Batch Symbol Lookup

When I need to check multiple symbols, I must make individual `mapx_node` or `mapx_search` calls. A batch API that accepts an array of symbol names would reduce round-trips significantly:
```json
// Desired:
mapx_search terms=["LinksPage", "SecretsPage", "DomainsPage", "ProfilePage"]
```

### 4.6 No "Unused/Dead Code" Detection

There's no tool to find symbols with zero incoming edges (potential dead code). `mapx_sinks` finds terminal data consumers, but not unreferenced functions or exports that could be safely deleted. During refactoring, this would be extremely useful for cleanup.

### 4.7 No File Content in `mapx_files` Output

`mapx_files` returns file paths, sizes, and languages, but there's no option to include a brief summary or first N lines of each file. This would save a follow-up `view_file` call for every file in an exploratory query.

### 4.8 No Monorepo-Aware Package Boundary Analysis

In a Turborepo/Nx monorepo, understanding cross-package dependencies is crucial. Mapx doesn't distinguish between:
- Intra-package imports (safe)
- Cross-package imports via package.json dependencies (tracked)
- Cross-package imports via relative paths (anti-pattern — should be flagged)
- Circular package dependencies (blocker)

---

## 5. Summary: What I Actually Used vs. What I Fell Back To

| Need | Mapx Tool Tried | Outcome | Fallback Used |
|------|----------------|---------|---------------|
| Codebase overview | `mapx_export format=llm` | ✅ Good — fast project summary | — |
| Sync after edits | `mapx_sync` | ✅ Good — fast incremental update | — |
| Find a named function | `mapx_search` | ✅ Works for `export function` | — |
| Find a default export component | `mapx_search` | ❌ Not found | `grep_search` |
| Find all symbols in a directory | `mapx_search term=*` | ❌ Wildcards don't work | `list_dir` + `view_file` |
| List API routes | `mapx_routes` | ❌ Empty for NestJS | `grep_search` for decorators |
| Detect framework hooks | `mapx_hooks` | ❌ Empty | `grep_search` |
| Trace call chain | `mapx_trace` | ⚠️ Works but misses React components | `view_file` on imports |
| Impact of changing a function | `mapx_impact` | ⚠️ Works but all HIGH, noisy | Manual analysis |
| Understand auth flow | `mapx_context` | ⚠️ Partial — missed key files | `view_file` on each file |
| Find interfaces | `mapx_search kind=interface` | ❌ No results with kind filter | `grep_search` |
| List dashboard files | `mapx_files` | ⚠️ Missing all .tsx files | `list_dir` |

**Bottom line**: Mapx was most useful for initial project overview (`mapx_export`) and for finding named function exports (`mapx_search`). For everything React/JSX-related, NestJS-specific, or involving `export default`, I fell back to `grep_search`, `list_dir`, and `view_file` — which defeats the purpose of having a code graph tool.

---

## 6. Priority Recommendations

1. **P0**: Fix `export default function/class` extraction — this is the #1 most common pattern in React/Next.js
2. **P0**: Fix `.tsx` file indexing — these files should be treated identically to `.ts`
3. **P1**: Add NestJS decorator parsing for routes, DI, and guards
4. **P1**: Track JSX element usage as call/render edges
5. **P1**: Fix built-in global resolution (Date, Error, Map, etc. should not resolve to user symbols)
6. **P2**: Add wildcard/empty term support for `mapx_search` when file filter is provided
7. **P2**: Add `instructions.md` with parameter documentation and valid enum values
8. **P2**: Differentiate import-level `<top-level>` references from actual call sites in `mapx_callers`
9. **P3**: Add staleness warning to query results
10. **P3**: Improve `mapx_impact` risk differentiation beyond blanket HIGH
