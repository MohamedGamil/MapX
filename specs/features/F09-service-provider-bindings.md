# F09 — Service Container Binding Resolution

| Field | Value |
|-------|-------|
| ID | F09 |
| Status | `planned` |
| Iteration | I05 |
| Branch | `feat/i05-laravel-structural` |
| Depends on | F05 (FQN resolution) |
| Blocked by | I04 must be merged |

---

## Problem

Laravel's IoC container is the runtime wiring backbone of every application. Service providers register the bindings that determine which concrete class is resolved when code requests an interface:

```php
// app/Providers/AppServiceProvider.php
public function register(): void
{
    $this->app->bind(UserRepositoryInterface::class, UserRepository::class);
    $this->app->singleton(CacheService::class, fn($app) => new CacheService(
        $app->make(Redis::class)
    ));
    $this->app->alias(UserRepositoryInterface::class, 'user.repo');
}
```

Without parsing these bindings, the graph cannot represent:

1. Which **interface** resolves to which **concrete class** (the abstract-to-concrete mapping)
2. Which **services** are singletons (shared instances, relevant to coupling analysis)
3. Transitive wiring: `app()->make(Redis::class)` inside a factory closure

This means interfaces used as type hints (F06) produce edges to abstract classes that appear isolated from their implementations.

---

## Goal

1. Detect service provider files (by `extends ServiceProvider`)
2. Parse `$this->app->bind()`, `->singleton()`, `->scoped()`, `->instance()`, `->alias()` calls
3. Emit `binding` edges from the abstract (interface) to the concrete (implementation)
4. Record binding metadata (singleton/transient/scoped/alias) on the edge
5. Mark service providers with `metadata.laravelRole = 'service_provider'`

---

## New `ReferenceType` value

```typescript
export type ReferenceType =
  | 'import' | 'require' | 'extends' | 'implements'
  | 'call' | 'instantiation' | 'return_type' | 'param_type'
  | 'relation'    // F07
  | 'route'       // F08
  | 'middleware'  // F08
  | 'binding';    // NEW — IoC container binding (abstract → concrete)
```

---

## Binding patterns to detect

### Simple `::class` constant form (verified)

```php
$this->app->bind(UserRepositoryInterface::class, UserRepository::class);
$this->app->singleton(CacheService::class, fn($app) => new CacheService(...));
$this->app->scoped(SearchIndexer::class, ElasticsearchIndexer::class);
$this->app->instance(Config::class, $config);
```

The first argument is always the abstract (interface or alias). The second argument, when it is a `::class` constant, is the concrete.

### Alias form

```php
$this->app->alias(UserRepositoryInterface::class, 'user.repo');
```

Emits a `binding` edge with `metadata.bindingType = 'alias'`.

### `app()->bind()` / `app()->make()` (helper function form)

```php
app()->bind(Foo::class, Bar::class);
app()->make(Redis::class);
```

Treat `app()->bind()` the same as `$this->app->bind()`.

### `make()` call edges

```php
$app->make(Redis::class);
```

Emits a `call` edge (already partially handled) to `Redis`, but now with FQN resolution and optionally cross-referenced against known singleton bindings.

---

## Tree-sitter query additions (`queries/php/references.scm`)

```scheme
; $this->app->bind(Abstract::class, Concrete::class)
(member_call_expression
  object: (member_access_expression
    object: (variable_name) @_this (#eq? @_this "$this")
    name: (name) @_app (#eq? @_app "app"))
  name: (name) @ref.binding_type
  (#match? @ref.binding_type "^(bind|singleton|scoped|instance)$")
  arguments: (arguments
    (argument
      (class_constant_access_expression
        (name) @ref.target_binding_abstract))
    (argument
      (class_constant_access_expression
        (name) @ref.target_binding_concrete)))) @ref.type_binding

; app()->bind(Abstract::class, Concrete::class)
(member_call_expression
  object: (function_call_expression
    function: (name) @_app_fn (#eq? @_app_fn "app"))
  name: (name) @ref.binding_type2
  (#match? @ref.binding_type2 "^(bind|singleton|scoped|instance)$")
  arguments: (arguments
    (argument
      (class_constant_access_expression
        (name) @ref.target_binding_abstract))
    (argument
      (class_constant_access_expression
        (name) @ref.target_binding_concrete)))) @ref.type_binding
```

---

## Service provider role detection

A class is `metadata.laravelRole = 'service_provider'` when it:
1. `extends ServiceProvider` or `extends \Illuminate\Support\ServiceProvider`
2. OR contains a `register()` or `boot()` method with `$this->app->bind()` calls

---

## `register()` vs `boot()` method tagging

Bindings inside `register()` are always pure IoC wiring — set `metadata.serviceProviderPhase = 'register'`.

Bindings inside `boot()` are post-registration hooks (event listeners, view composers, etc.) — set `metadata.serviceProviderPhase = 'boot'`.

---

## Edge metadata

```typescript
references.push({
  sourceSymbol: currentMethod,  // 'register' or 'boot'
  targetName: resolveToFqn(abstractClass, useTable),   // the interface
  referenceType: 'binding',
  startLine,
  verifiability: '::class' form ? 'verified' : 'inferred',
  metadata: {
    bindingType:     'singleton',    // bind | singleton | scoped | instance | alias
    concreteClass:   'App\\Repositories\\UserRepository',
    serviceProviderPhase: 'register',
  },
});
```

---

## Cross-referencing with F06 type-hint edges

When the scanner resolves type-hint edges from F06, it can consult the binding table to upgrade interface-typed parameter edges:

```
OrderController::__construct(UserRepositoryInterface $repo)
  → param_type edge to UserRepositoryInterface

+ binding: UserRepositoryInterface → UserRepository (from AppServiceProvider)
  → scanner adds supplemental "resolved via binding" annotation
```

This cross-reference is optional in I05; it can be deferred to a later iteration.

---

## Acceptance Criteria

- [ ] `$this->app->bind(UserRepositoryInterface::class, UserRepository::class)` → `binding` edge
- [ ] `$this->app->singleton(CacheService::class, ...)` → `binding` edge, `metadata.bindingType = 'singleton'`
- [ ] `app()->bind(Foo::class, Bar::class)` → `binding` edge
- [ ] Closure-form concrete (`fn($app) => new CacheService(...)`) → `binding` edge with `concreteClass: null` (concrete not statically determinable)
- [ ] `$this->app->alias(Foo::class, 'foo')` → `binding` edge, `metadata.bindingType = 'alias'`
- [ ] Service providers receive `laravelRole = 'service_provider'`
- [ ] `register()` bindings tagged `serviceProviderPhase = 'register'`
- [ ] `boot()` bindings tagged `serviceProviderPhase = 'boot'`
- [ ] `mapx deps app/Providers/AppServiceProvider.php` shows all abstract-to-concrete edges
- [ ] TypeScript type-check passes

---

## Out of Scope for F09

- Cross-referencing binding table with type-hint edges from F06 (deferred to I05 stretch)
- `$this->app->tag()` — tagged bindings (deferred)
- Contextual bindings (`$this->app->when(X)->needs(Y)->give(Z)`) — deferred
- Auto-discovery via `config/app.php` providers array — deferred
