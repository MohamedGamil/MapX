# F10 — Laravel-Aware Noise Reduction & Exclusions

| Field | Value |
|-------|-------|
| ID | F10 |
| Status | `planned` |
| Iteration | I04 |
| Branch | `feat/i04-php-fundamentals` |
| Depends on | — |
| Blocked by | — |

---

## Problem

A standard Laravel project contains large directories that carry zero cross-file application logic but significantly inflate file counts, symbol counts, and edge counts when scanned:

| Directory | Contents | Scan value |
|-----------|----------|------------|
| `database/migrations/` | Schema DDL via `Schema::create()`, `->bigIncrements()`, etc. | Nil — no references to application classes |
| `database/seeders/` | Data fixtures using `DB::table()->insert(...)` | Nil — data, not logic |
| `database/factories/` | Test data factories using `Factory::define()` | Low — only useful for test analysis |
| `storage/` | Runtime logs, compiled views, file uploads, cache | Always nil |
| `bootstrap/cache/` | `compiled.php`, `services.php`, `routes.php` — artisan-generated | Generates false edges to every class in the app |
| `public/` | `index.php`, compiled JS/CSS assets | Nil |
| `vendor/` | Composer dependencies | Already excluded; confirm always excluded |
| `resources/views/` | Blade `.php` files — mix of PHP and HTML template syntax | Currently parsed as PHP — produces severe noise |
| `node_modules/` | JS dependencies | Already excluded |

The `bootstrap/cache/services.php` is the worst offender: it is a serialised dump of the entire service container and generates thousands of false `instantiation` and `call` edges to vendor classes.

---

## Goal

1. Add Laravel-specific default exclusion patterns to `Config.DEFAULT_CONFIG`
2. Add heuristic detection of files that should be excluded regardless of path (e.g. generated artisan cache files)
3. Suppress or skip parsing of Blade template files (`.blade.php`) until dedicated Blade support is added
4. Emit `laravelRole` metadata for excluded-but-scanned file types so exporters can filter them
5. Update `mapx init` to suggest Laravel-appropriate patterns when a Laravel project is detected

---

## Default exclusion patterns for Laravel

The following patterns are added to `DEFAULT_CONFIG.settings.excludePatterns` **only when a Laravel project is detected** (see detection heuristic below). They extend — never replace — user-defined patterns.

```typescript
export const LARAVEL_DEFAULT_EXCLUDES = [
  'database/migrations/**',
  'database/seeders/**',
  'database/factories/**',
  'storage/**',
  'bootstrap/cache/**',
  'public/**',
  'resources/views/**',    // Blade templates — parse noise until Blade support added
  'vendor/**',             // Redundant with global default but explicit for clarity
];
```

These are added to `excludePatterns` during `mapx init` when a Laravel project is detected, **not** to the global default (they would break non-Laravel PHP projects).

---

## Laravel project detection heuristic

A project is detected as Laravel when **any** of the following is true:

1. `composer.json` exists and contains `"laravel/framework"` in `require`
2. `artisan` file exists in the project root
3. `app/Http/Kernel.php` exists
4. Directory layout contains `app/`, `routes/`, `config/`, `database/` simultaneously

Detection runs during `mapx init` and the result is stored in `.mapx/config.json`:

```json
{
  "repo": { "name": "...", "path": ".", "framework": "laravel" }
}
```

---

## Blade template files (`.blade.php`)

Blade files have the `.php` extension and are currently picked up by the PHP parser. However, they contain a mix of:
- Raw PHP (`<?php ... ?>`)
- Blade directives (`@foreach`, `@if`, `@component`)
- HTML

Parsing them as plain PHP produces:
- Incomplete symbol extraction (no class declarations)
- Noisy `call` edges from `@include`, `@component`, `@livewire` directives
- Parser errors from unrecognised Blade syntax

**Action for I04/F10**: Exclude `**/*.blade.php` from the PHP parser entirely. Add to `LARAVEL_DEFAULT_EXCLUDES`. A dedicated Blade parser is a future feature (out of scope here).

---

## Migration file classification

Migrations that **are** scanned (e.g. user overrides the exclude pattern) should be classified:

```typescript
// Detect migration files
const isMigration = (
  filePath.includes('/migrations/') ||
  classExtends === 'Migration' ||
  classExtends === '\\Illuminate\\Database\\Migrations\\Migration'
);

if (isMigration) {
  fileMetadata.laravelRole = 'migration';
  // Suppress all edges from this file — they are schema DDL, not app logic
  references.length = 0;
}
```

Suppressing edges from migration files eliminates noise from `Schema::create`, `Blueprint`, and column helper calls.

---

## Seeder and factory classification

Same approach as migrations:

```typescript
const isSeeder  = classExtends === 'Seeder' || classExtends === 'DatabaseSeeder';
const isFactory = classExtends === 'Factory' || filePath.includes('/factories/');
```

When detected: set `laravelRole`, suppress edges from the file.

---

## `bootstrap/cache` generated file detection

Files in `bootstrap/cache/` are artisan-generated PHP that serialise the entire container. They should be excluded by default but if included will produce catastrophic false edges.

Detection: if `filePath.includes('bootstrap/cache')` → skip parsing entirely (return empty `ParseResult`).

---

## `mapx init` prompting

When a Laravel project is detected during `mapx init`:

```
Detected Laravel project.

Suggested exclusions (recommended):
  ✓ database/migrations/**   (schema DDL — no app logic)
  ✓ database/seeders/**      (data fixtures)
  ✓ database/factories/**    (test data)
  ✓ storage/**               (runtime-generated)
  ✓ bootstrap/cache/**       (artisan-generated cache)
  ✓ public/**                (web assets)
  ✓ resources/views/**       (Blade templates — not yet supported)
  ✓ **/*.blade.php           (Blade files)

Add these to .mapx/config.json? [Y/n]
```

This can be bypassed with `mapx init --no-suggestions`.

---

## Impact on graph quality

Expected reduction in a typical mid-size Laravel app (200 application files + 80 migrations + 40 seeders + 120 vendor-like generated files):

| Metric | Before F10 | After F10 |
|--------|-----------|-----------|
| Files scanned | ~440 | ~200 |
| Symbols | ~3,200 | ~1,800 |
| Edges | ~8,400 | ~2,600 |
| False edges from `bootstrap/cache` | ~1,200 | 0 |
| False edges from migrations | ~900 | 0 |

---

## Acceptance Criteria

- [ ] `mapx init` detects Laravel projects (artisan file + composer.json check)
- [ ] Detected Laravel project: `mapx init` prompts with suggested exclusions
- [ ] `mapx init --no-suggestions` skips the prompt
- [ ] `LARAVEL_DEFAULT_EXCLUDES` applied when `framework: 'laravel'` in config
- [ ] `**/*.blade.php` excluded from PHP parser
- [ ] `bootstrap/cache/**` files return empty `ParseResult` without error
- [ ] Migration files (when not excluded) receive `laravelRole = 'migration'`, zero edges emitted
- [ ] Seeder/factory files receive `laravelRole = 'seeder'` / `'factory'`, zero edges
- [ ] `mapx status` shows active Laravel exclusion patterns
- [ ] TypeScript type-check passes
- [ ] File count in a standard Laravel app drops by ≥ 40% after `mapx init` with suggested exclusions

---

## Out of Scope for F10

- Blade parser / Blade component dependency extraction — future feature
- `config/` file parsing (config key references) — deferred
- `resources/lang/` translation file analysis — out of scope
- Horizon/Telescope/Nova vendor exclusions — covered by global `vendor/**`
