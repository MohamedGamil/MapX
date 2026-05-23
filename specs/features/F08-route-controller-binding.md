# F08 — Route-to-Controller Binding Edges

| Field | Value |
|-------|-------|
| ID | F08 |
| Status | `planned` |
| Iteration | I05 |
| Branch | `feat/i05-laravel-structural` |
| Depends on | F05 (FQN resolution) |
| Blocked by | I04 must be merged |

---

## Problem

Laravel route files (`routes/web.php`, `routes/api.php`, `routes/console.php`) are scanned today but produce only generic `call` edges to `Route::get`, `Route::post`, etc. The semantically important information — which controller class handles each route, which middleware is applied, which route name is assigned — is completely lost.

Example current output (route file contributes zero useful edges to graph):

```
routes/web.php  —[call]→  Route   (×47)
```

Expected output after F08:

```
routes/web.php  —[route:GET /users]→  App\Http\Controllers\UserController::index
routes/web.php  —[route:POST /users]→  App\Http\Controllers\UserController::store
routes/api.php  —[route:GET /api/orders/{id}]→  App\Http\Controllers\Api\OrderController::show
```

---

## Goal

1. Detect files as **route files** (by path pattern or file content)
2. Parse `Route::verb(uri, handler)` calls to extract URI, HTTP verb, controller class, and controller method
3. Emit `route` edges from the route file to the controller file/method
4. Detect `->middleware(...)` chaining and emit `middleware` edges from the route to the middleware class
5. Mark route files with `metadata.laravelRole = 'route_file'`
6. Mark controller classes with `metadata.laravelRole = 'controller'`

---

## Route handler forms

Laravel supports multiple handler syntaxes. Each must be handled:

### Array syntax (PHP 8, recommended — `verified`)

```php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
```

`UserController::class` is a compile-time constant → `verified`.

### String syntax (legacy — `inferred`)

```php
Route::get('/users', 'UserController@index');
Route::get('/users', 'App\Http\Controllers\UserController@index');
```

String value is resolved at runtime → `inferred`.

### Closure (no controller edge)

```php
Route::get('/ping', fn() => response()->json(['ok' => true]));
```

No controller reference. No edge emitted.

### Resource / API resource controllers

```php
Route::resource('orders', OrderController::class);
Route::apiResource('products', ProductController::class);
```

Emit a single `route` edge with `metadata.resourceType = 'resource'` or `'apiResource'`.

### Route groups

```php
Route::prefix('api/v2')->group(function () {
    Route::get('/users', [UserController::class, 'index']);
});

Route::middleware('auth')->group(function () {
    Route::get('/dashboard', [DashboardController::class, 'index']);
});
```

Groups modify the URI prefix and middleware applied to their children. The parser should accumulate group context (prefix stack, middleware stack) and apply it to leaf route edges.

---

## New `ReferenceType` values

```typescript
export type ReferenceType =
  | 'import' | 'require' | 'extends' | 'implements'
  | 'call' | 'instantiation' | 'return_type' | 'param_type'
  | 'relation'    // F07
  | 'route'       // NEW — route-to-controller binding
  | 'middleware'; // NEW — route-to-middleware or controller-to-middleware
```

---

## Tree-sitter query additions (`queries/php/references.scm`)

```scheme
; Array-form handler: Route::get('/path', [Controller::class, 'method'])
(scoped_call_expression
  scope: (name) @_route (#eq? @_route "Route")
  name: (name) @ref.route_verb
  arguments: (arguments
    (argument (encapsed_string) @ref.route_uri)
    (argument
      (array_creation_expression
        (array_element_initializer
          (class_constant_access_expression
            (name) @ref.target_route_controller))
        (array_element_initializer
          (string (string_content) @ref.route_method)))))) @ref.type_route

; resource() / apiResource()
(scoped_call_expression
  scope: (name) @_route (#eq? @_route "Route")
  name: (name) @ref.route_resource_type
  (#match? @ref.route_resource_type "^(resource|apiResource)$")
  arguments: (arguments
    (argument (encapsed_string) @ref.route_uri)
    (argument
      (class_constant_access_expression
        (name) @ref.target_route_controller)))) @ref.type_route_resource

; Middleware chaining: ->middleware('auth') or ->middleware([...])
(member_call_expression
  name: (name) @_mw (#eq? @_mw "middleware")
  arguments: (arguments
    (argument (encapsed_string (string_content) @ref.target_middleware)))) @ref.type_middleware
```

---

## Route file detection

A file is classified as a route file when **any** of the following is true:

1. Path matches `routes/**/*.php` (relative to project root)
2. File contains `Route::` static calls (heuristic, at least 2 occurrences)

When classified, set `metadata.laravelRole = 'route_file'` on the file record.

---

## Controller role detection

A class is marked `metadata.laravelRole = 'controller'` when:

1. It `extends Controller`, `extends BaseController`, or `extends \Illuminate\Routing\Controller`
2. OR it is the target of a `route` edge

---

## Edge metadata

```typescript
references.push({
  sourceSymbol: null,   // route files have no owning class
  targetName: resolveToFqn(controllerClass, useTable),
  referenceType: 'route',
  startLine,
  verifiability: isArraySyntax ? 'verified' : 'inferred',
  metadata: {
    httpVerb:       'GET',                         // POST, PUT, PATCH, DELETE, ANY, etc.
    uri:            '/users',
    controllerMethod: 'index',                     // null for closures
    routeName:      'users.index',                 // null if not named
    middlewares:    ['auth', 'throttle:60,1'],     // accumulated from group context
    resourceType:   null,                          // 'resource' | 'apiResource' | null
  },
});
```

---

## Scan/export filtering

Route files have a unique structure: they are almost entirely composed of `Route::` calls. Their edges should appear in `mapx deps` and the JSON export, but the LLM exporter may choose to summarise them as "routes to X controllers" rather than listing each individual route to keep the token budget reasonable.

Exporters should group route edges by controller class when rendering in LLM format:

```
routes/api.php → UserController (6 routes: GET/POST /users, GET/PUT/PATCH/DELETE /users/{id})
routes/api.php → OrderController (4 routes: ...)
```

---

## Acceptance Criteria

- [ ] `Route::get('/users', [UserController::class, 'index'])` → `route` edge, `verified`, `httpVerb: 'GET'`
- [ ] `Route::post('/users', 'UserController@store')` → `route` edge, `inferred`
- [ ] `Route::resource('orders', OrderController::class)` → `route` edge, `metadata.resourceType = 'resource'`
- [ ] `->middleware('auth')` → `middleware` edge to middleware class or alias
- [ ] Route groups: child routes inherit group prefix and middleware
- [ ] Route files detected by path and heuristic; `laravelRole = 'route_file'` set
- [ ] Controller classes receive `laravelRole = 'controller'`
- [ ] LLM exporter groups route edges by controller class
- [ ] `mapx deps routes/api.php` shows all controllers referenced
- [ ] TypeScript type-check passes

---

## Out of Scope for F08

- Named route resolution (`route('users.index')` string references in views/controllers) — deferred
- Route model binding (`{user}` → `User::class`) — deferred
- `Route::controller(UserController::class)->group(...)` (Laravel 9+) — deferred
- Console route commands (`routes/console.php` `Artisan::command(...)`) — deferred
