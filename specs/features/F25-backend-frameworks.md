# F25 — Backend Framework Routes (Laravel Extended, Drupal, Rails, Spring, Gin/chi/gorilla, Axum/actix/Rocket, ASP.NET Core, Vapor)

| Field | Value |
|-------|-------|
| ID | F25 |
| Status | `planned` |
| Iteration | I13 |
| Branch | `feat/i13-framework-routes` |
| Depends on | F21 (infrastructure), F20 (language expansion — Go/Rust/Java/C#/Swift/Ruby parsers) |
| Blocked by | F21 must be merged |

---

## Overview

Eight backend frameworks across six language ecosystems. Each implements `FrameworkDetector` and extracts `route` edges (and Drupal additionally extracts `hook` edges).

---

## Laravel (Extended Support)

### Context

F08–F12 cover the core Laravel route/controller/model/event patterns. This extended support adds patterns not yet handled:

### Additional patterns

#### Invokable controllers (single-action)

```php
Route::get('/users', UserController::class);  // invokable — no method name
```

Handler is the class itself (implements `__invoke`). Emit `route` edge to `UserController` class symbol with metadata `{ handlerStyle: "invokable" }`.

#### Route groups with prefix and middleware

```php
Route::middleware(['auth', 'verified'])
    ->prefix('admin')
    ->group(function () {
        Route::get('/users', [AdminUserController::class, 'index']);
        Route::post('/users', [AdminUserController::class, 'store']);
    });
```

- All routes within the group inherit the prefix (`admin/`) and middleware
- Emit `middleware` edges from each route to `auth` and `verified` middleware classes

#### Named route → controller method cross-reference

```php
Route::get('/users/{id}', [UserController::class, 'show'])->name('users.show');
```

Store `routeName: "users.show"` in edge metadata. Enables `mapx_routes --name=users.show` lookup.

#### `Route::resource` and `Route::apiResource` (F08 improvement)

F08 specified resource routes but may not capture custom `only`/`except` modifiers:

```php
Route::resource('photos', PhotoController::class)->only(['index', 'show']);
Route::resource('users', UserController::class)->except(['destroy']);
```

Only emit route edges for the specified (or non-excluded) methods.

#### Subdomain routing

```php
Route::domain('{account}.myapp.com')->group(function () {
    Route::get('/users', [UserController::class, 'index']);
});
```

Edge metadata: `{ domain: "{account}.myapp.com" }`.

---

## Drupal

### Detection

File: `src/frameworks/detectors/drupal.ts`

Detection signals:
- `core/lib/Drupal.php` present in project root

Two file types: YAML routing files and PHP hook files.

### Routing YAML files (`*.routing.yml`)

```yaml
# mymodule.routing.yml
mymodule.user_list:
  path: '/users'
  defaults:
    _controller: '\Drupal\mymodule\Controller\UserController::list'
    _title: 'User List'
  requirements:
    _permission: 'access content'

mymodule.user_form:
  path: '/users/add'
  defaults:
    _form: '\Drupal\mymodule\Form\UserAddForm'
  requirements:
    _permission: 'administer users'

mymodule.user_entity:
  path: '/users/{user}'
  defaults:
    _entity_view: 'user.full'
  requirements:
    _entity_access: 'user.view'
```

**Extraction logic:**
- Parse each YAML document in `*.routing.yml` files
- For each route entry:
  - `_controller: '\Class\Name::method'` → `route` edge from routing file → controller class method
  - `_form: '\Class\Name'` → `route` edge to form class
  - `_entity_view` / `_entity_form` → `route` edge to entity (use entity class if resolvable, otherwise store as metadata)
- Edge metadata: `{ routeName: "mymodule.user_list", path: "/users", framework: "drupal", confidence: "verified" }`

### Hook implementations in PHP files

Drupal modules implement hooks by naming functions `<modulename>_<hookname>`:

```php
// mymodule.module
function mymodule_node_insert(NodeInterface $node) { ... }
function mymodule_form_alter(&$form, FormStateInterface $form_state, $form_id) { ... }
function mymodule_theme($existing, $type, $theme, $path) { ... }
function mymodule_install() { ... }  // from mymodule.install
function mymodule_update_9001() { ... }  // schema update hook
```

**Extraction logic:**
- Scan `*.module`, `*.theme`, `*.install`, `*.inc` files
- For each function matching the pattern `<word>_<hookname>` where `hookname` starts with a known Drupal hook prefix:
  - Emit `hook` edge from the module file → the function symbol
  - Edge metadata: `{ hookName: "node_insert", moduleName: "mymodule", framework: "drupal", hookFile: ".module" }`

Known hook prefixes (partial list): `node_`, `form_`, `user_`, `block_`, `theme_`, `menu_`, `cron`, `install`, `uninstall`, `update_`, `schema`, `views_`, `entity_`

**Alt approach:** Any function in a `.module`/`.theme`/`.install` file not declared `private` that matches `\w+_\w+` pattern is a potential hook. Store with `confidence: "inferred"` since Drupal hook naming is conventional, not enforced by the runtime.

Edge type: `hook`

---

## Rails

### Detection

File: `src/frameworks/detectors/rails.ts`

Detection signals:
- `config/routes.rb` present in project root
- `rails` in `Gemfile`

File match: `config/routes.rb`, `config/routes/**/*.rb`

### Route patterns extracted

```ruby
# config/routes.rb
Rails.application.routes.draw do
  get '/users', to: 'users#index'
  post '/users', to: 'users#create'
  get '/users/:id', to: 'users#show'
  put '/users/:id', to: 'users#update'
  delete '/users/:id', to: 'users#destroy'

  resources :orders
  resources :products, only: [:index, :show]
  resource :profile

  namespace :admin do
    resources :users
  end

  # Hash-rocket legacy syntax
  get '/legacy', :to => 'legacy#index'

  # Scoped routes
  scope '/api/v1' do
    resources :users
  end
end
```

**Extraction logic:**

1. **Explicit HTTP verb methods** (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`):
   ```ruby
   get '/path', to: 'controller#action'
   get '/path', to: => 'controller#action'  # hash-rocket
   get '/path' => 'controller#action'       # shorthand
   ```
   Parse `controller#action` string → emit `route` edge from `config/routes.rb` → `UsersController::index`
   Confidence: `inferred` (string resolved at runtime)

2. **`resources :name`** → expand to standard CRUD routes:
   - `GET /resources` → `ResourcesController::index`
   - `GET /resources/new` → `ResourcesController::new`
   - `POST /resources` → `ResourcesController::create`
   - `GET /resources/:id` → `ResourcesController::show`
   - `GET /resources/:id/edit` → `ResourcesController::edit`
   - `PUT/PATCH /resources/:id` → `ResourcesController::update`
   - `DELETE /resources/:id` → `ResourcesController::destroy`
   With `only: [:index, :show]`: emit only those two.

3. **`resource :name`** (singular resource) → same as above but no `:id` and no `index`.

4. **`namespace :name`** → prefix all child routes with `name/` and look for `Name::ChildController`.

5. **`scope`** → prefix all child routes with scope path.

```typescript
// Match: get '/path', to: 'controller#action'
const RAILS_VERB = /\b(get|post|put|patch|delete|head|options)\s+['"]([^'"]+)['"]\s*(?:,\s*:to\s*=>?\s*['"]|=>?\s*['"])([^'"]+)['"]/g;

// Match: resources :name or resource :name
const RAILS_RESOURCES = /\b(resources?)\s+:(\w+)/g;

// Match: namespace :name
const RAILS_NAMESPACE = /namespace\s+:(\w+)/g;
```

---

## Spring (Boot)

### Detection

File: `src/frameworks/detectors/spring.ts`

Detection signals:
- `@SpringBootApplication` annotation in any `.java` file
- `spring-boot` in `pom.xml` or `build.gradle` dependencies

File match: any `.java` file containing `@Controller`, `@RestController`, `@RequestMapping`, `@GetMapping`, `@PostMapping`, etc.

### Route patterns extracted

```java
@RestController
@RequestMapping("/users")
public class UserController {

    @GetMapping
    public List<User> getAll() { ... }

    @GetMapping("/{id}")
    public User getOne(@PathVariable Long id) { ... }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public User create(@RequestBody CreateUserDto dto) { ... }

    @PutMapping("/{id}")
    public User update(@PathVariable Long id, @RequestBody UpdateUserDto dto) { ... }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) { ... }

    @RequestMapping(value = "/search", method = RequestMethod.GET)
    public List<User> search(@RequestParam String q) { ... }
}
```

**Extraction logic:**
1. Find `@RequestMapping("prefix")` on class → note prefix
2. For each method with HTTP mapping annotation:
   - `@GetMapping(path?)` → `route` edge, `httpMethod: "GET"`, path = `prefix + method_path`
   - `@PostMapping`, `@PutMapping`, `@PatchMapping`, `@DeleteMapping`, `@HeadMapping`, `@OptionsMapping` → respective methods
   - `@RequestMapping(value="path", method=RequestMethod.GET)` → extract method and path
3. Emit `route` edge from the controller file → the method symbol
4. Edge metadata: `{ httpMethod: "GET", path: "/users/{id}", controllerClass: "UserController", confidence: "verified", framework: "spring" }`

**Spring WebFlux (functional routing):**
```java
RouterFunction<ServerResponse> routes(UserHandler handler) {
    return route()
        .GET("/users", handler::getAll)
        .POST("/users", handler::create)
        .GET("/users/{id}", handler::getOne)
        .build();
}
```

Match `route().METHOD("path", handler::method)` chains → emit route edges. Confidence: `verified`.

```typescript
// Match: @GetMapping("/path") or @GetMapping
const SPRING_MAPPING = /@(Get|Post|Put|Patch|Delete|Head|Options)Mapping\(\s*(?:["']([^"']+)["']|value\s*=\s*["']([^"']+)["'])?\s*\)/g;

// Match: @RequestMapping(value = "/path", method = RequestMethod.GET)
const REQUEST_MAPPING = /@RequestMapping\([^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/g;

// Match: @RestController on class (to know it's a controller)
const REST_CONTROLLER = /@(Rest)?Controller\b/g;

// Match: @RequestMapping on class (prefix)
const CLASS_MAPPING = /@RequestMapping\(\s*["']([^"']+)["']\s*\)/g;
```

---

## Go: Gin, chi, gorilla/mux

### Detection

File: `src/frameworks/detectors/go-routers.ts`

Detection signals (from `go.mod`):
- `github.com/gin-gonic/gin` → Gin
- `github.com/go-chi/chi` or `github.com/go-chi/chi/v5` → chi
- `github.com/gorilla/mux` → gorilla/mux

File match: any `.go` file with `gin.Default()`, `chi.NewRouter()`, `mux.NewRouter()`, or `.GET(`, `.HandleFunc(`

### Gin

```go
r := gin.Default()
r.GET("/users", listUsers)
r.POST("/users", createUser)
r.GET("/users/:id", getUser)
r.PUT("/users/:id", updateUser)
r.DELETE("/users/:id", deleteUser)

// Router groups
v1 := r.Group("/api/v1")
{
    v1.GET("/users", listUsers)
    v1.GET("/orders", listOrders)
}
```

Patterns:
- `r.METHOD("path", handler)` → `route` edge, `httpMethod: "GET"`, target = `handler` symbol
- `r.Group("prefix")` → routes inside the group get prefix prepended
- Middleware: `r.Use(AuthMiddleware)` → `middleware` edge

```typescript
const GIN_ROUTE = /(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)\(\s*["']([^"']+)["']\s*,\s*(\w+)/g;
const GIN_GROUP = /(\w+)\.Group\(\s*["']([^"']+)["']\s*\)/g;
```

### chi

```go
r := chi.NewRouter()
r.Use(middleware.Logger)
r.Get("/users", listUsers)
r.Post("/users", createUser)
r.Get("/users/{id}", getUser)

r.Route("/admin", func(r chi.Router) {
    r.Use(AdminOnly)
    r.Get("/users", adminListUsers)
})
```

Patterns:
- `r.Get/Post/Put/Patch/Delete/Head/Options/Connect/Trace("path", handler)` → route edges
- `r.Route("prefix", func(r chi.Router) { ... })` → nested router with prefix
- `r.Use(middleware)` → `middleware` edges
- `r.Handle("path", handler)` → `ANY` method route

```typescript
const CHI_ROUTE = /r\.(Get|Post|Put|Patch|Delete|Head|Options|Connect|Trace|Handle)\(\s*["']([^"']+)["']\s*,\s*(\w+)/g;
```

### gorilla/mux

```go
r := mux.NewRouter()
r.HandleFunc("/users", listUsersHandler).Methods("GET", "OPTIONS")
r.HandleFunc("/users", createUserHandler).Methods("POST")
r.HandleFunc("/users/{id:[0-9]+}", getUserHandler).Methods("GET")

// Subrouters
s := r.PathPrefix("/api").Subrouter()
s.HandleFunc("/users", listUsersHandler).Methods("GET")
```

Patterns:
- `r.HandleFunc("path", handler).Methods("GET", "POST")` → emit one route edge per method listed
- `r.PathPrefix("prefix").Subrouter()` → child routes get prefix
- `.Methods()` not present → `ANY`

```typescript
const MUX_ROUTE = /\.HandleFunc\(\s*["']([^"']+)["']\s*,\s*(\w+)\s*\)(?:\.Methods\(([^)]+)\))?/g;
```

---

## Rust: Axum, actix-web, Rocket

### Detection

File: `src/frameworks/detectors/rust-frameworks.ts`

Detection signals (from `Cargo.toml`):
- `axum` → Axum
- `actix-web` → actix
- `rocket` → Rocket

### Axum

```rust
let app = Router::new()
    .route("/users", get(list_users).post(create_user))
    .route("/users/:id", get(get_user).put(update_user).delete(delete_user))
    .layer(middleware::from_fn(auth_middleware));
```

Patterns:
- `.route("path", METHOD(handler))` → route edge per method
- `get(handler)`, `post(handler)`, `put(handler)`, `patch(handler)`, `delete(handler)` → extract method and handler
- `.layer(...)` → `middleware` edge

```typescript
const AXUM_ROUTE = /\.route\(\s*["']([^"']+)["']\s*,\s*(.+?)\)/g;
const AXUM_METHOD = /\b(get|post|put|patch|delete|head|options)\((\w+)\)/g;
```

### actix-web

```rust
App::new()
    .route("/users", web::get().to(list_users))
    .route("/users", web::post().to(create_user))
    .route("/users/{id}", web::get().to(get_user))
    .service(
        web::scope("/api")
            .route("/orders", web::get().to(list_orders))
    )
```

Patterns:
- `.route("path", web::METHOD().to(handler))` → route edge
- `web::scope("prefix")` → nested routes with prefix
- `#[get("/path")]` / `#[post("/path")]` attribute macros on handler functions:
  ```rust
  #[get("/users")]
  async fn list_users(db: web::Data<Db>) -> impl Responder { ... }
  ```
  Emit route edge from the function's attribute. Confidence: `verified`.

```typescript
const ACTIX_ROUTE = /\.route\(\s*["']([^"']+)["']\s*,\s*web::(get|post|put|patch|delete|head|options)\(\)\.to\((\w+)\)/g;
const ACTIX_ATTR = /#\[(get|post|put|patch|delete|head|options)\(\s*["']([^"']+)["']\s*\)\]/g;
```

### Rocket

```rust
#[get("/users")]
fn list_users() -> Json<Vec<User>> { ... }

#[post("/users", data = "<user>")]
fn create_user(user: Json<CreateUserDto>) -> Json<User> { ... }

#[get("/users/<id>")]
fn get_user(id: i64) -> Option<Json<User>> { ... }

#[launch]
fn rocket() -> _ {
    rocket::build().mount("/api", routes![list_users, create_user, get_user])
}
```

Patterns:
- `#[get("path")]`, `#[post("path")]`, etc. on functions → route edge from function, `httpMethod`, `path`
- `.mount("prefix", routes![...])` → apply prefix to all listed route functions

```typescript
const ROCKET_ATTR = /#\[(get|post|put|patch|delete|head|options)\(\s*["']([^"']+)["']\s*(?:,.*?)?\)\]/g;
const ROCKET_MOUNT = /\.mount\(\s*["']([^"']+)["']\s*,\s*routes!\[([^\]]+)\]/g;
```

---

## ASP.NET Core

### Detection

File: `src/frameworks/detectors/aspnet.ts`

Detection signals:
- `.csproj` file referencing `Microsoft.AspNetCore`
- Any `.cs` file containing `[ApiController]` or `[Route(...)]`

File match: any `.cs` file containing `[HttpGet`, `[HttpPost`, `[Route(`, `[ApiController`

### Route patterns extracted

```csharp
[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet]
    public ActionResult<IEnumerable<User>> GetAll() { ... }

    [HttpGet("{id}")]
    public ActionResult<User> GetOne(int id) { ... }

    [HttpPost]
    [ProducesResponseType(StatusCodes.Status201Created)]
    public ActionResult<User> Create([FromBody] CreateUserDto dto) { ... }

    [HttpPut("{id}")]
    public IActionResult Update(int id, [FromBody] UpdateUserDto dto) { ... }

    [HttpDelete("{id}")]
    public IActionResult Delete(int id) { ... }

    [HttpGet("search")]
    [Route("find")]  // additional route alias
    public ActionResult<IEnumerable<User>> Search([FromQuery] string q) { ... }
}
```

**Extraction logic:**
1. Find `[Route("template")]` on the class → note route template
   - `[controller]` token → replace with lowercase class name minus "Controller" suffix (`UsersController` → `users`)
   - `[action]` token → replace with lowercase method name
2. For each method with `[HttpGet]`, `[HttpPost]`, `[HttpPut]`, `[HttpPatch]`, `[HttpDelete]`, `[HttpHead]`, `[HttpOptions]`:
   - Method-level route = class template + attribute path
   - Emit `route` edge → method symbol
   - Edge metadata: `{ httpMethod: "GET", path: "api/users/{id}", confidence: "verified", framework: "aspnet" }`

**Minimal API (ASP.NET 6+):**
```csharp
app.MapGet("/users", async (IUserService service) => await service.GetAllAsync());
app.MapPost("/users", async (CreateUserDto dto, IUserService service) => ...);
app.MapGroup("/api/users").MapGet("/{id}", getUser);
```

Match `app.Map[Method]("path", handler)` calls → emit route edges. Handler = lambda → emit route edge to containing file with the lambda as the symbol.

```typescript
const ASPNET_METHOD_ATTR = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpHead|HttpOptions)\(?["']?([^"'\]]*)?["']?\)?\]/g;
const ASPNET_CLASS_ROUTE = /\[Route\(\s*["']([^"']+)["']\s*\)\]/g;
const ASPNET_MINIMAL = /app\.Map(Get|Post|Put|Patch|Delete)\(\s*["']([^"']+)["']\s*,/g;
```

---

## Vapor (Swift)

### Detection

File: `src/frameworks/detectors/vapor.ts`

Detection signals:
- `Package.swift` containing `"Vapor"` as a dependency

File match: any `.swift` file containing `app.get(`, `app.post(`, `routes.get(`, `grouped(`, `RouteCollection`

### Route patterns extracted

```swift
func routes(_ app: Application) throws {
    app.get("health") { req async in "ok" }

    app.get("users") { req async throws -> [User] in
        try await User.query(on: req.db).all()
    }

    app.post("users", use: createUser)
    app.get("users", ":id", use: getUser)
    app.put("users", ":id", use: updateUser)
    app.delete("users", ":id", use: deleteUser)

    // Grouped routes
    let protected = app.grouped(UserToken.authenticator())
    protected.get("profile", use: getProfile)
    protected.post("logout", use: logout)

    // Route collections
    try app.register(collection: UserController())
}
```

**Extraction logic:**
1. `app.METHOD("segment", "segment2", use: handler)` → route edge
   - Path = slash-join of all string literal arguments
   - `":param"` → `{param}` in display
   - `use: handlerFunc` → target symbol = `handlerFunc`
   - Inline closures → emit route edge to containing file
2. `app.grouped(middleware)` → `middleware` edge to middleware type
3. `RouteCollection` conformance class → scan for `func boot(routes: RoutesBuilder)` and extract routes within it

```typescript
const VAPOR_ROUTE = /(\w+)\.(get|post|put|patch|delete)\(([^,)]+(?:,\s*["'][^"']+["'])*)\s*(?:,\s*use:\s*(\w+))?\s*\)/g;
const VAPOR_GROUP = /(\w+)\.grouped\(([^)]+)\)/g;
```

---

## `mapx routes` output for all backend frameworks

```
Routes in /path/to/project  (87 routes across 8 frameworks)

  Method   Path                      Handler                           Framework  File
  ────────────────────────────────────────────────────────────────────────────────────────────
  GET      /users                    UserController@index              rails      config/routes.rb
  POST     /users                    UserController@create             rails      config/routes.rb
  GET      /users/{id}               UserController@show               rails      config/routes.rb
  GET      /users/                   UserListView                      django     app/urls.py
  POST     /users/                   UserCreateView                    django     app/urls.py
  GET      /api/users                UserController::getAll            spring     src/main/java/.../UserController.java
  POST     /api/users                UserController::create            spring     src/main/java/.../UserController.java
  GET      /users                    listUsers                         gin        main.go
  GET      /users/{id}               getUser                           gin        main.go
  GET      /users                    list_users                        axum       src/main.rs
  GET      /api/users                GetAll()                          aspnet     Controllers/UsersController.cs
  GET      /health                   (closure)                         vapor      Sources/App/routes.swift
  HOOK     node_insert               mymodule_node_insert              drupal     modules/mymodule/mymodule.module
  HOOK     form_alter                mymodule_form_alter               drupal     modules/mymodule/mymodule.module
```

---

## Acceptance Criteria

### Laravel Extended
- [ ] Invokable controllers (`Route::get('/path', MyController::class)`) emit route edge to the class
- [ ] Route groups with `->prefix()` + `->middleware()` apply prefix/middleware to child routes
- [ ] `->name('route.name')` stores route name in edge metadata
- [ ] `Route::resource` with `->only([...])` emits only specified method edges
- [ ] Subdomain routing stores domain in edge metadata

### Drupal
- [ ] `_controller: '\Namespace\Controller::method'` in routing YAML emits `route` edge
- [ ] `_form: '\Namespace\FormClass'` emits `route` edge with `{ routeRole: "form" }`
- [ ] `mymodule_node_insert()` in `.module` file emits `hook` edge with `hookName: "node_insert"`
- [ ] Functions in `.install` files with update hook pattern recognized
- [ ] Hook edge stored with `edge_type: "hook"` in database

### Rails
- [ ] `get '/users', to: 'users#index'` emits route edge to `UsersController::index`
- [ ] Hash-rocket syntax `get '/users', :to => 'users#index'` recognized
- [ ] `resources :users` expands to 7 CRUD route edges
- [ ] `resources :users, only: [:index, :show]` emits only 2 edges
- [ ] `namespace :admin` prepends `admin/` to all child paths

### Spring
- [ ] `@GetMapping("/{id}")` on method + `@RequestMapping("/users")` on class = `GET /users/{id}`
- [ ] `@PostMapping` without value uses controller prefix only
- [ ] `@RequestMapping(value="/search", method=RequestMethod.GET)` parsed
- [ ] WebFlux `route().GET("path", handler::method)` emits route edge

### Go (Gin / chi / gorilla)
- [ ] `r.GET("/path", handler)` emits route edge (Gin)
- [ ] `r.Get("/path", handler)` emits route edge (chi)
- [ ] `r.HandleFunc("/path", handler).Methods("GET","POST")` emits two route edges (gorilla)
- [ ] Router groups / scopes / subrouters apply path prefix
- [ ] `r.Use(middleware)` emits `middleware` edge

### Rust (Axum / actix / Rocket)
- [ ] `.route("/path", get(handler))` emits route edge (Axum)
- [ ] `.route("/path", web::get().to(handler))` emits route edge (actix)
- [ ] `#[get("/path")]` attribute macro emits route edge (actix + Rocket)
- [ ] Rocket `.mount("/prefix", routes![fn1, fn2])` applies prefix to all listed handlers

### ASP.NET Core
- [ ] `[HttpGet("{id}")]` + `[Route("api/[controller]")]` on class = `GET /api/users/{id}`
- [ ] `[controller]` token resolved correctly (strips "Controller" suffix, lowercases)
- [ ] `app.MapGet("/path", handler)` minimal API emits route edge
- [ ] `MapGroup("/prefix")` applies prefix to chained `MapGet`/`MapPost` calls

### Vapor
- [ ] `app.get("users", ":id", use: getUser)` emits `GET /users/{id}` edge to `getUser`
- [ ] `app.grouped(middleware)` emits `middleware` edge
- [ ] Routes defined inside `RouteCollection.boot(routes:)` extracted
- [ ] Inline closure handlers emit route edge to the containing file

### Common
- [ ] All 8 frameworks produce edges visible in `mapx routes`
- [ ] `mapx routes --framework=rails` filters to Rails routes only
- [ ] `npx tsc --noEmit` passes
