# F07 — Eloquent Relationship Edges

| Field | Value |
|-------|-------|
| ID | F07 |
| Status | `planned` |
| Iteration | I05 |
| Branch | `feat/i05-laravel-structural` |
| Depends on | F05 (FQN resolution) |
| Blocked by | I04 must be merged |

---

## Problem

Laravel's Eloquent ORM expresses the data model through relationship methods:

```php
class User extends Model
{
    public function posts(): HasMany
    {
        return $this->hasMany(Post::class);
    }

    public function team(): BelongsTo
    {
        return $this->belongsTo(Team::class, 'team_id');
    }

    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(Role::class, 'user_roles');
    }
}
```

`Post::class` and `Team::class` are **compile-time class constants** — they are statically resolved and represent high-confidence structural dependencies between models. Currently they are captured as generic `call` edges to `hasMany`, `belongsTo`, etc. — the related model class is invisible.

This means the graph has no representation of the data model shape, making it useless for understanding which models are central, which are junction tables, and how the domain is structured.

---

## Goal

Detect Eloquent relationship methods by name, extract the first argument (the related model class constant), and emit a dedicated `relation` edge type from the owning model to the related model.

---

## New `ReferenceType` value

```typescript
// src/types.ts
export type ReferenceType =
  | 'import' | 'require' | 'extends' | 'implements'
  | 'call' | 'instantiation' | 'return_type' | 'param_type'
  | 'relation';   // NEW — Eloquent relationship
```

---

## Eloquent relationship methods to detect

```typescript
export const ELOQUENT_RELATIONSHIP_METHODS = new Set([
  // Standard relationships
  'hasOne', 'hasMany', 'hasOneThrough', 'hasManyThrough',
  'belongsTo', 'belongsToMany',
  'morphTo', 'morphOne', 'morphMany', 'morphToMany', 'morphedByMany',
  // Laravel 8+ "has one of many"
  'hasOneOfMany', 'hasManyOfMany',
  // Belongs to many variants
  'belongsToManyThrough',
]);
```

---

## Tree-sitter query additions (`queries/php/references.scm`)

```scheme
; Eloquent relationship: $this->hasMany(Post::class)
; Captures the class constant used as the first argument
(member_call_expression
  name: (name) @_rel_method
  (#match? @_rel_method "^(hasOne|hasMany|hasOneThrough|hasManyThrough|belongsTo|belongsToMany|morphTo|morphOne|morphMany|morphToMany|morphedByMany|hasOneOfMany)$")
  arguments: (arguments
    (argument
      (class_constant_access_expression
        (name) @ref.target_relation)))) @ref.type_relation
```

The `class_constant_access_expression` with `(name) @ref.target_relation` captures the class part of `Post::class` (i.e., `Post`). This is then resolved via the use-import table to `App\Models\Post`.

---

## Model role detection

A PHP class is considered an Eloquent model when it:
1. Directly `extends Model`, `extends Authenticatable`, `extends Pivot`, or another class that transitively extends `Model`; OR
2. Contains one or more relationship methods from `ELOQUENT_RELATIONSHIP_METHODS`

When a model is detected, set `metadata.laravelRole = 'model'` on the class symbol.

```typescript
// In php.ts, after processing symbols:
if (usesEloquentRelationships || extendsModel) {
  classSymbol.metadata.laravelRole = 'model';
}
```

---

## Edge metadata

```typescript
references.push({
  sourceSymbol: currentClass,          // e.g. "User"
  targetName: resolveToFqn(relatedClass, useTable),  // e.g. "App\\Models\\Post"
  referenceType: 'relation',
  startLine,
  verifiability: 'verified',           // ::class constant is statically known
  metadata: {
    relationshipMethod: methodName,    // e.g. "hasMany"
    relationshipType: 'one-to-many',   // derived from method name
  },
});
```

### Relationship type mapping

| Method | `relationshipType` |
|--------|--------------------|
| `hasOne`, `morphOne` | `one-to-one` |
| `hasMany`, `morphMany`, `hasOneThrough`, `hasManyThrough` | `one-to-many` |
| `belongsTo`, `morphTo` | `many-to-one` |
| `belongsToMany`, `morphToMany`, `morphedByMany` | `many-to-many` |

---

## Export impact

### LLM exporter

Relationship edges are formatted differently from generic `call` edges:

```
User  —[hasMany]→  Post
User  —[belongsTo]→  Team
User  —[belongsToMany]→  Role
```

### DOT/SVG exporter

`relation` edges rendered in a distinct colour (e.g. blue) to distinguish data-model relationships from code-dependency edges.

### JSON exporter

```json
{
  "sourceFile": "app/Models/User.php",
  "targetFile": "app/Models/Post.php",
  "edgeType": "relation",
  "sourceSymbol": "User",
  "targetSymbol": "Post",
  "verifiability": "verified",
  "metadata": {
    "relationshipMethod": "hasMany",
    "relationshipType": "one-to-many"
  }
}
```

---

## Acceptance Criteria

- [ ] `$this->hasMany(Post::class)` → `relation` edge from `User` to `App\Models\Post`
- [ ] `$this->belongsTo(Team::class)` → `relation` edge, `many-to-one`
- [ ] `$this->belongsToMany(Role::class)` → `relation` edge, `many-to-many`
- [ ] `$this->morphMany(Comment::class, 'commentable')` → `relation` edge
- [ ] Class constants resolved to FQN via use-import table (F05)
- [ ] `metadata.laravelRole = 'model'` set on Eloquent model classes
- [ ] `metadata.relationshipMethod` and `metadata.relationshipType` on edge
- [ ] `relation` edges rendered distinctly in DOT/SVG
- [ ] `mapx query User` output shows relationship edges
- [ ] TypeScript type-check passes
- [ ] Verified on a Laravel project with 5+ related models

---

## Out of Scope for F07

- Dynamic relationship definitions (runtime `HasMany` constructor calls not via `$this->hasMany()`)
- `withCount`, `with`, `load` eager-loading (these are query-builder calls, not schema definitions)
- Pivot model detection (deferred)
- `HasRelationships` trait mixin analysis (deferred)
