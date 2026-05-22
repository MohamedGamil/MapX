# F11 — Laravel Facade Resolution

| Field | Value |
|-------|-------|
| ID | F11 |
| Status | `implemented` |
| Iteration | I06 |
| Branch | `feat/i06-laravel-advanced` |
| Depends on | F05 (FQN resolution) |
| Blocked by | I05 must be merged |

---

## Problem

Laravel Facades are static proxies to underlying service container bindings. Code that calls `Cache::get(...)` is actually calling `CacheManager::get(...)` at runtime — but the source code just shows a static call to the `Cache` facade class.

Today the PHP parser captures these as:

```
SomeController  —[call]→  Cache
SomeController  —[call]→  DB
SomeController  —[call]→  Log
SomeController  —[call]→  Mail
```

These edges point to the Facade class (a thin static proxy), not the underlying service that actually does the work. This:

1. Clusters unrelated usage under generic Facade symbols
2. Loses the actual service dependency (a class that heavily uses `DB::` depends on `DatabaseManager`, not an alias)
3. Makes it impossible to trace which services a class actually depends on

---

## Goal

1. Maintain a built-in **facade resolution map** (alias → concrete class FQN)
2. When a `call` edge targets a known facade alias, rewrite the edge target to the concrete service FQN
3. Mark facade-resolved edges as `inferred` (because facade resolution is a Laravel runtime concern, not static analysis)
4. Allow users to add custom facade aliases via `.mapx/config.json`

---

## Built-in facade resolution map

```typescript
// src/parsers/languages/php-laravel-facades.ts
export const LARAVEL_FACADE_MAP: Record<string, string> = {
  // Core framework facades
  App:           'Illuminate\\Foundation\\Application',
  Auth:          'Illuminate\\Auth\\AuthManager',
  Bus:           'Illuminate\\Contracts\\Bus\\Dispatcher',
  Cache:         'Illuminate\\Cache\\CacheManager',
  Config:        'Illuminate\\Config\\Repository',
  Cookie:        'Illuminate\\Cookie\\CookieJar',
  Crypt:         'Illuminate\\Encryption\\Encrypter',
  DB:            'Illuminate\\Database\\DatabaseManager',
  Event:         'Illuminate\\Events\\Dispatcher',
  File:          'Illuminate\\Filesystem\\Filesystem',
  Gate:          'Illuminate\\Auth\\Access\\Gate',
  Hash:          'Illuminate\\Hashing\\HashManager',
  Http:          'Illuminate\\Http\\Client\\Factory',
  Lang:          'Illuminate\\Translation\\Translator',
  Log:           'Illuminate\\Log\\LogManager',
  Mail:          'Illuminate\\Mail\\Mailer',
  Notification:  'Illuminate\\Notifications\\ChannelManager',
  Password:      'Illuminate\\Auth\\Passwords\\PasswordBrokerManager',
  Queue:         'Illuminate\\Queue\\QueueManager',
  RateLimiter:   'Illuminate\\Cache\\RateLimiter',
  Redirect:      'Illuminate\\Routing\\Redirector',
  Request:       'Illuminate\\Http\\Request',
  Response:      'Illuminate\\Routing\\ResponseFactory',
  Route:         'Illuminate\\Routing\\Router',
  Schema:        'Illuminate\\Database\\Schema\\Builder',
  Session:       'Illuminate\\Session\\SessionManager',
  Storage:       'Illuminate\\Filesystem\\FilesystemManager',
  URL:           'Illuminate\\Routing\\UrlGenerator',
  Validator:     'Illuminate\\Validation\\Factory',
  View:          'Illuminate\\View\\Factory',
};
```

This map is the source of truth for built-in facade aliases. It ships with mapx and does not require any user configuration.

---

## Custom facade configuration

Users can extend or override the facade map in `.mapx/config.json`:

```json
{
  "settings": {
    "php": {
      "facadeMap": {
        "Analytics": "App\\Services\\AnalyticsService",
        "Payment":   "App\\Services\\Stripe\\StripeGateway"
      }
    }
  }
}
```

Custom entries are merged with the built-in map (custom entries take priority).

---

## Edge rewriting logic

```typescript
function resolveFacade(
  targetName: string,
  facadeMap: Record<string, string>
): { resolvedTarget: string; wasFacade: boolean } {
  // Strip namespace if present (e.g. "Illuminate\Support\Facades\Cache" → "Cache")
  const shortName = targetName.split('\\').at(-1) ?? targetName;
  const resolved  = facadeMap[shortName];
  return resolved
    ? { resolvedTarget: resolved, wasFacade: true }
    : { resolvedTarget: targetName, wasFacade: false };
}
```

Apply in the reference post-processing step (after tree-sitter parsing, before storing to graph):

```typescript
for (const ref of references) {
  if (ref.referenceType === 'call' || ref.referenceType === 'instantiation') {
    const { resolvedTarget, wasFacade } = resolveFacade(ref.targetName, mergedFacadeMap);
    if (wasFacade) {
      ref.targetName   = resolvedTarget;
      ref.verifiability = 'inferred';     // runtime resolution
      ref.metadata     = { ...ref.metadata, facadeAlias: shortName };
    }
  }
}
```

---

## `Route::` facade special handling

`Route::get(...)`, `Route::post(...)` etc. are already handled by F08 as `route` edge type. The facade resolver must **not** rewrite `Route::` calls — F08 takes priority and they have already been consumed before F11 runs.

```typescript
const FACADE_SKIP_FOR = new Set(['Route']); // handled by F08
```

---

## `Schema::` facade in migrations

Migration files are excluded from parsing by F10. If they somehow reach the facade resolver:
- `Schema::` → `Illuminate\Database\Schema\Builder` would be resolved
- But since migrations have no edges emitted (F10), this is a no-op

---

## `DB::` facade — raw query tracking

`DB::select(...)`, `DB::table(...)`, `DB::statement(...)` are resolved to `Illuminate\Database\DatabaseManager`. These edges indicate raw database access — potentially useful for identifying classes that bypass Eloquent.

Set `metadata.isRawDbAccess = true` on edges resolved from the `DB` facade.

---

## Real-time alias handling

Some applications register custom aliases in `config/app.php`:

```php
'aliases' => Facade::defaultAliases()->merge([
    'PDF' => Barryvdh\DomPDF\Facade\Pdf::class,
])->toArray(),
```

Parsing `config/app.php` to extract the aliases array is out of scope for F11. Users must add custom facades to `.mapx/config.json` manually.

---

## Edge metadata

```typescript
{
  referenceType: 'call',
  targetName:    'Illuminate\\Cache\\CacheManager',
  verifiability: 'inferred',
  metadata: {
    facadeAlias: 'Cache',
    isRawDbAccess: false,
  }
}
```

---

## Acceptance Criteria

- [x] `Cache::get(...)` call → edge to `Illuminate\Cache\CacheManager`, `inferred`
- [x] `DB::table(...)` → edge to `Illuminate\Database\DatabaseManager`, `metadata.isRawDbAccess = true`
- [x] `Log::info(...)` → edge to `Illuminate\Log\LogManager`
- [x] Custom facade in `.mapx/config.json` overrides built-in map
- [x] `Route::get(...)` NOT rewritten — handled by F08
- [x] `Schema::` calls in migration files produce no edges (F10 suppresses them)
- [x] `mapx query Cache` resolves to `CacheManager` references, not facade stub
- [x] `metadata.facadeAlias` preserved on edge for traceability
- [x] TypeScript type-check passes
- [x] Manual test: verify `DB` and `Cache` facade resolution on a real Laravel project

---

## Out of Scope for F11

- Parsing `config/app.php` aliases array automatically — deferred
- Real-time facade class auto-discovery via Composer autoload map — out of scope
- Facade method-level resolution (which specific `CacheManager` method is called) — out of scope
- Mockery facade mock detection in tests — out of scope
