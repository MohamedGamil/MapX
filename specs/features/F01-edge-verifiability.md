# F01 — Edge Verifiability (verified / inferred)

| Field | Value |
|-------|-------|
| ID | F01 |
| Status | `planned` |
| Iteration | I01 |
| Branch | `feat/i01-edge-verifiability` |
| Depends on | — |
| Blocked by | — |

---

## Problem

The current graph treats every edge the same. A statically-provable inheritance edge (`extends UserModel`) and a dynamically-resolved method call (`$this->on('event', ...)`) carry identical weight, which pollutes coupling metrics and makes the graph noisy for LLM consumers.

---

## Goal

Label each edge at parse time as either:

- **`verified`** — the dependency was resolved statically (import, `extends`, `implements`, `new ClassName()`, typed method call)
- **`inferred`** — the call target could not be resolved without runtime information (dynamic dispatch, untyped variable, generic framework hooks)

---

## Database Schema Change

```sql
-- Migration: add verifiability column with a backward-compatible default
ALTER TABLE edges ADD COLUMN verifiability TEXT NOT NULL DEFAULT 'verified';

-- Index to support fast filtering in metrics queries
CREATE INDEX IF NOT EXISTS idx_edges_verifiability ON edges (verifiability);
```

No data migration is required. All existing edges inherit `'verified'` as the default, which is the conservative/safe choice.

The Store schema version must be bumped from 2 to 3, and a migration guard added to `store.ts` so existing databases are upgraded on first open.

---

## Parser Changes

### Shared contract

Each parser's `extractReferences()` return value already produces `ExtractedReference` objects. Add an optional `verifiability` field:

```typescript
// src/types.ts
export interface ExtractedReference {
  targetFile?: string;
  targetSymbol?: string;
  referenceType: ReferenceType;
  sourceLine: number;
  verifiability?: 'verified' | 'inferred';   // NEW — defaults to 'verified' if absent
}
```

When the scanner writes edges to the store, it maps `verifiability ?? 'verified'` to the column.

### PHP (`src/parsers/languages/php.ts`)

| Pattern | Label |
|---------|-------|
| `use Foo\Bar;` | `verified` |
| `class A extends B` | `verified` |
| `class A implements I` | `verified` |
| `new ClassName()` | `verified` |
| `(new ClassName())->method()` | `verified` |
| `$typedVar->method()` where `$typedVar` has a known type hint | `verified` |
| `$this->method()` / `$x->method()` where `$x` type is unknown | `inferred` |
| `self::method()` / `static::method()` | `verified` (resolved to current class) |
| Dynamic call patterns (e.g., `$this->on(...)`, `$model->save()`) | `inferred` if in common-method list |

### JavaScript / TypeScript (`src/parsers/languages/javascript.ts`, `typescript.ts`)

| Pattern | Label |
|---------|-------|
| `import { Foo } from './foo'` | `verified` |
| `require('./foo')` | `verified` |
| `extends BaseClass` | `verified` |
| `implements IFoo` | `verified` (TS only) |
| `new ClassName()` | `verified` |
| `instance.method()` where `instance` has a known type annotation | `verified` |
| `this.method()` / untyped variable method call | `inferred` |
| Event emitter / callback patterns | `inferred` |

### Common-method filter list

A shared constant in `src/parsers/index.ts` (or a dedicated `src/parsers/common-methods.ts`) lists method names that are generic enough to default to `inferred` when the receiver type cannot be determined:

```typescript
export const COMMON_FRAMEWORK_METHODS = new Set([
  // Laravel / PHP
  'save', 'delete', 'find', 'findOrFail', 'create', 'update', 'get', 'all',
  'toArray', 'toJson', 'rules', 'handle', 'boot', 'register',
  // JavaScript / Node
  'on', 'off', 'emit', 'once', 'then', 'catch', 'finally',
  'toString', 'valueOf', 'call', 'apply', 'bind',
]);
```

Any call to a method in this set where the receiver type is unresolved → `inferred`.

---

## Store Write Path

In `src/core/scanner.ts`, where `addDependencyEdge` is called, pass through the `verifiability` field:

```typescript
graph.addDependencyEdge({
  sourceFile,
  targetFile,
  sourceSymbol,
  targetSymbol,
  edgeType,
  repo,
  weight,
  verifiability: ref.verifiability ?? 'verified',   // NEW
});
```

The `Store.insertEdge()` method must include the column in its `INSERT` statement.

---

## Export Impact

- **LLM exporter**: optionally annotate edges in the summary with `[inferred]` when `verifiability = 'inferred'` to give the LLM a signal about confidence level
- **JSON exporter**: include `verifiability` field in each edge object
- **DOT / SVG exporter**: render inferred edges as dashed lines (`style=dashed`)

---

## Acceptance Criteria

- [ ] `edges` table has `verifiability TEXT NOT NULL DEFAULT 'verified'`
- [ ] Store schema version bumped; migration guard handles existing DBs
- [ ] `ExtractedReference` type has optional `verifiability` field
- [ ] PHP parser labels dynamic/untyped calls as `inferred`
- [ ] JS/TS parsers label untyped method calls as `inferred`
- [ ] Common-method filter list in place and applied
- [ ] Scanner write path passes `verifiability` through to store
- [ ] JSON export includes `verifiability` on each edge
- [ ] DOT/SVG renders inferred edges as dashed
- [ ] `mapx status` output includes inferred/verified edge counts
- [ ] TypeScript type-check passes (`npx tsc --noEmit`)
- [ ] Tested against a PHP Laravel project and a TypeScript project

---

## Out of Scope for F01

- The `mapx metrics` command (F02) — consumes `verifiability` but is a separate feature
- User-configurable overrides to the common-method list (deferred to a future spec)
