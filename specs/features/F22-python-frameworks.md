# F22 — Python Framework Routes (Django, Flask, FastAPI)

| Field | Value |
|-------|-------|
| ID | F22 |
| Status | `planned` |
| Iteration | I13 |
| Branch | `feat/i13-framework-routes` |
| Depends on | F21 (infrastructure), F20 (Python parser) |
| Blocked by | F21 must be merged |

---

## Overview

Extracts route → handler edges from the three major Python web frameworks. Each framework has distinct routing conventions; all three produce `route` edges using the shared `RouteBinding` type from F21.

---

## Django

### Detection

File: `src/frameworks/detectors/django.ts`

Detection signals (any one sufficient):
- `manage.py` present in project root
- `settings.py` containing `INSTALLED_APPS`
- `urls.py` files containing `urlpatterns`

File match: `**/urls.py` (primary), `**/views.py` (for view class resolution)

### URL patterns extracted

Django's `urlpatterns` list is defined in `urls.py` files. Three syntaxes are supported:

#### Function-based views (FBV)

```python
urlpatterns = [
    path('users/', views.user_list, name='user-list'),
    path('users/<int:pk>/', views.user_detail, name='user-detail'),
    re_path(r'^legacy/(?P<slug>[-\w]+)/$', views.legacy_view),
]
```

Each `path()` / `re_path()` call emits:
- `route` edge from `urls.py` → the view function
- Edge metadata: `{ httpMethod: "ANY", path: "users/", routeName: "user-list" }`
- Confidence: `verified` (direct function reference)

#### Class-based views (CBV) with `.as_view()`

```python
urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
    path('users/<int:pk>/', UserDetailView.as_view(), name='user-detail'),
]
```

CBV handler: `UserListView` class (the `.as_view()` is stripped).
- `route` edge from `urls.py` → `UserListView` class symbol
- Confidence: `verified` (direct class reference)

#### String-based views (deprecated but still found)

```python
url(r'^users/$', 'myapp.views.user_list')
```

- Confidence: `inferred` (string resolved at runtime)

#### `include()` for nested URL files

```python
urlpatterns = [
    path('api/', include('myapp.api_urls')),
    path('admin/', include(admin.site.urls)),
]
```

`include()` calls emit an `import` edge from the current `urls.py` to the included `urls.py` file (resolved via Python module path → file path mapping).

#### Router-based (Django REST Framework)

```python
router = DefaultRouter()
router.register(r'users', UserViewSet, basename='user')
router.register(r'orders', OrderViewSet, basename='order')
urlpatterns = router.urls
```

DRF `ViewSet` registrations emit route edges for all standard actions:
- `GET /users/` → `UserViewSet::list`
- `POST /users/` → `UserViewSet::create`
- `GET /users/{id}/` → `UserViewSet::retrieve`
- `PUT /users/{id}/` → `UserViewSet::update`
- `PATCH /users/{id}/` → `UserViewSet::partial_update`
- `DELETE /users/{id}/` → `UserViewSet::destroy`

Confidence: `verified`

### Implementation strategy

```typescript
export class DjangoDetector implements FrameworkDetector {
  readonly framework = 'django';
  readonly language = 'python';

  detect(projectRoot: string, files: string[]): boolean {
    return files.some(f => f.endsWith('manage.py')) ||
           files.some(f => path.basename(f) === 'urls.py');
  }

  matchesFile(filePath: string): boolean {
    return path.basename(filePath) === 'urls.py';
  }

  extractRoutes(filePath: string, source: string): RouteBinding[] {
    // Parse using Python AST or regex pattern matching:
    // 1. Find 'urlpatterns = [...]' assignment
    // 2. Walk list elements, match path()/re_path()/url()/include() calls
    // 3. Extract first arg (path string), second arg (view reference)
    // 4. Detect .as_view() suffix on CBV references
    // 5. Detect router.register() patterns for DRF
    ...
  }
}
```

Pattern matching approach: use regex on source text rather than full AST parsing (simpler, sufficient for well-formatted url files):

```typescript
// Match: path('uri', ViewClass.as_view(...), name='...')
const CBV_PATTERN = /(?:path|re_path|url)\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\.as_view\(/g;

// Match: path('uri', view_function, ...)
const FBV_PATTERN = /(?:path|re_path|url)\(\s*['"]([^'"]+)['"]\s*,\s*(?:views\.)?(\w+)/g;

// Match: router.register('prefix', ViewSetClass)
const DRF_PATTERN = /router\.register\(\s*r?['"]([^'"]+)['"]\s*,\s*(\w+)/g;
```

---

## Flask

### Detection

Detection signals:
- `from flask import Flask` or `import flask` in any `.py` file
- `Flask(__name__)` instantiation

File match: any `.py` file containing `@app.route` or `@<blueprint>.route` or `@<bp>.route`

### Route patterns extracted

#### Simple routes

```python
@app.route('/users', methods=['GET', 'POST'])
def user_list():
    ...

@app.route('/users/<int:user_id>', methods=['GET'])
def user_detail(user_id: int):
    ...
```

Each `@app.route(...)` decorator emits a `route` edge for each HTTP method listed in `methods`:
- `GET /users` → `user_list`
- `POST /users` → `user_list`
- `GET /users/<int:user_id>` → `user_detail`

When `methods` is absent, default is `GET` only.

Confidence: `verified` (decorator applied directly to function)

#### Blueprint routes

```python
users_bp = Blueprint('users', __name__, url_prefix='/users')

@users_bp.route('/', methods=['GET'])
def list_users():
    ...

@users_bp.route('/<int:user_id>', methods=['DELETE'])
def delete_user(user_id: int):
    ...
```

- Route edges emitted with path = `<blueprint_prefix> + route_path`
- If prefix not found (blueprint defined in another file), emit without prefix and note in metadata
- Edge metadata: `{ blueprint: "users", urlPrefix: "/users" }`

#### `add_url_rule`

```python
app.add_url_rule('/health', 'health', health_check_view, methods=['GET'])
```

Equivalent to `@app.route`. Extracted identically.

#### Flask-RESTX / Flask-RESTful resources

```python
api.add_resource(UserResource, '/users', '/users/<int:user_id>')
```

Emits `ANY` method route edges (resource handles all HTTP methods).

### Implementation strategy

```typescript
// Match: @app.route('/path', methods=['GET', 'POST'])
// or: @bp_var.route('/path', ...)
const FLASK_ROUTE = /@(\w+)\.route\(\s*['"]([^'"]+)['"][^)]*methods\s*=\s*\[([^\]]+)\]/gm;
const FLASK_ROUTE_DEFAULT = /@(\w+)\.route\(\s*['"]([^'"]+)['"]\s*\)/gm;

// Match the function immediately following the decorator
// (capture function name on the line following the decorator)
```

---

## FastAPI

### Detection

Detection signals:
- `from fastapi import FastAPI` or `from fastapi import APIRouter` in any `.py` file
- `FastAPI()` or `APIRouter()` instantiation

File match: any `.py` file containing `@app.get`, `@app.post`, `@router.get`, etc.

### Route patterns extracted

#### Direct app decorators

```python
app = FastAPI()

@app.get("/users")
async def list_users() -> list[User]:
    ...

@app.post("/users", status_code=201)
async def create_user(user: UserCreate) -> User:
    ...

@app.get("/users/{user_id}")
async def get_user(user_id: int) -> User:
    ...
```

Each method decorator emits a `route` edge:
- `GET /users` → `list_users`
- `POST /users` → `create_user`

Supported decorators: `@app.get`, `@app.post`, `@app.put`, `@app.patch`, `@app.delete`, `@app.head`, `@app.options`, `@app.trace`, `@app.api_route` (with methods=[...])

Confidence: `verified`

#### Router-based

```python
router = APIRouter(prefix="/users", tags=["users"])

@router.get("/")
async def list_users():
    ...

@router.post("/", status_code=201)
async def create_user():
    ...

# In main app:
app.include_router(router)
app.include_router(router, prefix="/api/v1")
```

Router routes are emitted with prefix from `APIRouter(prefix=...)`. When `app.include_router(router, prefix=...)` overrides the prefix, the override is used if resolvable.

#### `@app.api_route` (multiple methods)

```python
@app.api_route("/items/{item_id}", methods=["GET", "HEAD"])
async def get_or_head_item(item_id: str):
    ...
```

Emits one edge per method.

### Implementation strategy

```typescript
// Match: @app.get("/path") or @router.post("/path", ...)
const FASTAPI_ROUTE = /@(\w+)\.(get|post|put|patch|delete|head|options|trace)\(\s*['"]([^'"]+)['"]/g;

// Match: @app.api_route("/path", methods=["GET", "POST"])
const FASTAPI_MULTI = /@(\w+)\.api_route\(\s*['"]([^'"]+)['"][^)]*methods\s*=\s*\[([^\]]+)\]/g;

// Match: APIRouter(prefix="/...")
const ROUTER_PREFIX = /APIRouter\([^)]*prefix\s*=\s*['"]([^'"]+)['"]/g;
```

---

## Metadata enrichment

For all Python framework views, the framework detector also enriches the target symbol's metadata in the store:

```json
{
  "frameworkRole": "view",
  "framework": "django",
  "routePaths": ["GET:/users/", "POST:/users/"],
  "routeNames": ["user-list"]
}
```

This metadata enables `mapx_node` to display "Routed via: GET /users/" alongside symbol details.

---

## Acceptance Criteria

### Django
- [ ] `path('users/', UserListView.as_view())` emits route edge to `UserListView`
- [ ] `re_path(r'^users/$', views.user_list)` emits route edge to `user_list`
- [ ] `include('app.urls')` emits import edge to included urls file
- [ ] `router.register('users', UserViewSet)` emits 6 CRUD route edges to `UserViewSet` methods
- [ ] Nested `urls.py` (via `include`) are transitively resolved
- [ ] `url()` legacy syntax recognized

### Flask
- [ ] `@app.route('/path', methods=['GET', 'POST'])` emits two edges
- [ ] Missing `methods=` defaults to GET only
- [ ] Blueprint prefix correctly prepended to route path
- [ ] `add_url_rule(...)` emits equivalent edges

### FastAPI
- [ ] All 8 HTTP method decorators recognized (`@app.get`, `.post`, `.put`, `.patch`, `.delete`, `.head`, `.options`, `.trace`)
- [ ] `APIRouter(prefix=...)` routes have prefix applied
- [ ] `@app.api_route("/path", methods=["GET", "HEAD"])` emits two edges
- [ ] Handler function symbol linked correctly (resolves to same file)

### Common
- [ ] Route edges stored with `metadata` JSON including `httpMethod`, `path`, `framework`, `confidence`
- [ ] `mapx routes --framework=django` lists only Django routes
- [ ] `mapx routes --framework=fastapi` lists FastAPI routes
- [ ] No regression in PHP/TS/JS parsing after scanner phase 2 added
