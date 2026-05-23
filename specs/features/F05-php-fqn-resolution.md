# F05 — Fully-Qualified Namespace Resolution

| Field | Value |
|-------|-------|
| ID | F05 |
| Status | `planned` |
| Iteration | I04 |
| Branch | `feat/i04-php-fundamentals` |
| Depends on | — |
| Blocked by | — |

---

## Problem

The PHP `references.scm` query captures only the final `name` node of a `namespace_use_clause`:

```scheme
(namespace_use_declaration
  (namespace_use_clause
    (name) @ref.target_import)) @ref.type_import
```

For `use App\Services\UserService;` this captures `UserService` — the last segment — discarding the namespace prefix. As a result:

1. Symbol resolution across files is broken: `UserService` in `app/Services/` and `UserService` in `app/Http/Factories/` are indistinguishable.
2. Edge targets cannot be matched against the `symbols` table where symbols are stored with their full class name.
3. The use-import table (needed by F06 to resolve type hints) cannot be built correctly.

This is a **blocking defect** for all downstream PHP enhancements.

---

## Goal

Capture the fully-qualified name (FQN) of every `use` import, resolve aliased imports (`use Foo\Bar as B`), and build a per-file use-import table that other parser logic (F06, F07, F08, F09) can consult to expand short names to FQNs.

---

## Tree-sitter query changes (`queries/php/references.scm`)

### Current (broken)

```scheme
(namespace_use_declaration
  (namespace_use_clause
    (name) @ref.target_import)) @ref.type_import
```

### Replacement

```scheme
; Simple use: use App\Services\UserService;
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @ref.target_import_fqn)) @ref.type_import

; Aliased use: use App\Services\UserService as US;
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @ref.target_import_fqn
    alias: (name) @ref.target_import_alias)) @ref.type_import

; Group use: use App\Services\{UserService, MailService};
(namespace_use_declaration
  (namespace_name) @ref.target_import_prefix
  (namespace_use_group
    (namespace_use_clause
      (name) @ref.target_import_suffix))) @ref.type_import_group
```

The PHP parser (`php.ts`) assembles the FQN from prefix + suffix for group `use` statements.

---

## Parser changes (`src/parsers/languages/php.ts`)

### Build a use-import table per file

Before processing references, build a map from short name → FQN for every `use` declaration in the file. Store this on the parser instance (scoped to the current `parse()` call):

```typescript
type UseImportTable = Map<string, string>;
// key: short name (or alias)
// value: FQN, e.g. "App\\Services\\UserService"
```

### FQN assembly

```typescript
function buildFqn(parts: string[]): string {
  return parts.join('\\');
}

// For aliased import: "use App\Services\UserService as US"
// table.set('US', 'App\\Services\\UserService')

// For simple import: "use App\Services\UserService"
// table.set('UserService', 'App\\Services\\UserService')

// For group import: "use App\Services\{UserService, MailService}"
// table.set('UserService', 'App\\Services\\UserService')
// table.set('MailService', 'App\\Services\\MailService')
```

### Resolve short names in all reference targets

After building the use-import table, apply it when emitting any reference whose `targetName` is a short name:

```typescript
function resolveToFqn(name: string, useTable: UseImportTable): string {
  // Already qualified (contains backslash)?
  if (name.includes('\\')) return name;
  // In use table?
  return useTable.get(name) ?? name;
}
```

This resolution is applied to:
- `extends` targets
- `implements` targets
- `instantiation` targets (`new Foo()`)
- `call` targets (scoped: `Foo::bar()`)
- All type-hint targets added by F06

---

## `qualified_name` node text

In tree-sitter-php, `qualified_name` text already includes backslash separators (`App\Services\UserService`). The capture `.text` value is the FQN — no assembly needed for simple cases.

---

## Store / symbol matching impact

Symbol FQNs are stored in the `symbols` table as `name` (e.g. `UserService`). After F05 the reference target will be `App\Services\UserService`. The scanner's symbol-resolution step must be updated to match on **both** the FQN and the short class name:

```typescript
// During edge resolution in scanner.ts:
const byFqn  = symbolMap.get(fqn);       // e.g. "App\\Services\\UserService"
const byShort = symbolMap.get(shortName); // e.g. "UserService" — fallback
const resolved = byFqn ?? byShort ?? null;
```

This is the same resolution strategy used by IDE language servers.

---

## Acceptance Criteria

- [ ] `use App\Services\UserService;` → `targetName` = `App\Services\UserService`
- [ ] `use App\Services\UserService as US;` → `targetName` = `App\Services\UserService`, alias `US` registered in use-import table
- [ ] Group use `use App\Services\{A, B};` → two separate references with FQNs `App\Services\A` and `App\Services\B`
- [ ] `extends UserService` where `UserService` is in the use-import table → resolved to FQN
- [ ] `new UserService()` where class is imported → FQN in edge target
- [ ] Use-import table is built before any reference is emitted
- [ ] Short name fallback still works for classes in the same namespace (no `use` required)
- [ ] TypeScript type-check passes
- [ ] Verified against a Laravel project: `mapx export --format=json` shows FQN edge targets

---

## Out of Scope for F05

- Resolving class names that are not imported via `use` (e.g. same-namespace references without explicit import) — covered by a future namespace-inference enhancement
- Resolving string-based class names like `app('App\Services\UserService')` — deferred to F09
