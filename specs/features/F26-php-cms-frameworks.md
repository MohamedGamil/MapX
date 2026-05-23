# F26 — PHP CMS/Framework Routes (Symfony, Yii, WordPress)

| Field | Value |
|-------|-------|
| ID | F26 |
| Status | `planned` |
| Iteration | I13 |
| Branch | `feat/i13-framework-routes` |
| Depends on | F21 (infrastructure) |
| Blocked by | F21 must be merged |

---

## Overview

Three PHP ecosystem frameworks/CMSes with distinct routing and extension models:

- **Symfony** — attribute-based and YAML/PHP config routing; event subscriber hooks
- **Yii2 / Yii3** — URL rule config arrays (Yii2) and typed `Route` builder (Yii3); `actionXxx` method conventions
- **WordPress** — hook/filter registration (`add_action`, `add_filter`), REST API (`register_rest_route`), shortcodes (`add_shortcode`), and template-hierarchy-based page routing

All three share the `hook` `ReferenceType` already introduced for Drupal in F25. No new `ReferenceType` values are required.

---

## Symfony

### Detection

File: `src/frameworks/detectors/symfony.ts`

Detection signals:
- `symfony/framework-bundle` in `composer.json` `require`
- Alternative: `bin/console` present and `symfony/console` in `composer.json`

File match: any `.php` file containing `#[Route(` or `@Route` annotation; any `.yaml` file under `config/routes/`

### Route patterns extracted

#### PHP Attribute routing (Symfony 5.2+, recommended)

```php
use Symfony\Component\Routing\Attribute\Route;

#[Route('/users', name: 'user_')]
class UserController extends AbstractController
{
    #[Route('/', name: 'index', methods: ['GET'])]
    public function index(): Response { ... }

    #[Route('/{id}', name: 'show', methods: ['GET'])]
    public function show(int $id): Response { ... }

    #[Route('/', name: 'create', methods: ['POST'])]
    public function create(Request $request): Response { ... }

    #[Route('/{id}', name: 'update', methods: ['PUT', 'PATCH'])]
    public function update(int $id, Request $request): Response { ... }

    #[Route('/{id}', name: 'delete', methods: ['DELETE'])]
    public function delete(int $id): Response { ... }
}
```

**Extraction logic:**
1. Find `#[Route('prefix')]` or `#[Route('/prefix')]` on a class → note the prefix
2. For each method with `#[Route('path', methods: ['GET', ...])]`:
   - Path = class prefix + method path
   - One route edge per HTTP method listed in `methods:` (or `ANY` if methods not specified)
   - Emit `route` edge from controller file → method symbol
   - Edge metadata: `{ httpMethod: "GET", path: "/users/{id}", routeName: "user_show", confidence: "verified", framework: "symfony" }`
3. If `methods:` has multiple values, emit one route edge per method

**Route name** stored in metadata: class `name:` prefix + method `name:` suffix (e.g. `user_show`).

#### Legacy annotation routing (Symfony ≤5.1)

```php
/**
 * @Route("/users", name="user_")
 */
class UserController extends AbstractController
{
    /**
     * @Route("/", name="index", methods={"GET"})
     */
    public function index(): Response { ... }
}
```

Same extraction as attributes, using docblock `@Route(...)` pattern instead.

```typescript
const SYMFONY_ATTR_CLASS = /#\[Route\(\s*['"]([^'"]+)['"]\s*(?:,\s*name:\s*['"]([^'"]+)['"])?\s*\)\]/g;
const SYMFONY_ATTR_METHOD = /#\[Route\(\s*['"]([^'"]+)['"]\s*(?:,[^)]*methods:\s*\[([^\]]+)\])?(?:,[^)]*name:\s*['"]([^'"]+)['"])?\s*\)\]/g;
const SYMFONY_ANNOT_CLASS = /\*\s*@Route\(\s*["']([^"']+)["']\s*(?:,\s*name\s*=\s*["']([^"']+)["'])?\s*\)/g;
const SYMFONY_ANNOT_METHOD = /\*\s*@Route\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\{([^}]+)\}[^)]*\)/g;
```

#### YAML routing (`config/routes.yaml`)

```yaml
# config/routes.yaml
user_index:
  path: /users
  controller: App\Controller\UserController::index
  methods: GET

user_show:
  path: /users/{id}
  controller: App\Controller\UserController::show
  methods: GET

# Import controllers directory
controllers:
  resource:
    path: ../src/Controller/
    namespace: App\Controller
  type: attribute
```

**Extraction logic:**
- Parse each route entry: `path:`, `controller:` (`\Namespace\Class::method`), `methods:`
- Emit `route` edge from the YAML file → controller method symbol
- `resource: { path: ..., type: attribute }` → trigger attribute scan on the referenced directory
- Edge metadata: `{ routeName: "user_index", framework: "symfony", confidence: "verified" }`

#### PHP routing (`config/routes.php`)

```php
use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return function (RoutingConfigurator $routes): void {
    $routes->add('user_index', '/users')
        ->controller([UserController::class, 'index'])
        ->methods(['GET']);

    $routes->import('../src/Controller/', 'attribute');
};
```

Match `$routes->add('name', 'path')->controller([Class::class, 'method'])` pattern → emit route edges.

#### Symfony EventSubscriber

```php
class UserEventSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            UserCreatedEvent::class => 'onUserCreated',
            KernelEvents::REQUEST => [['onKernelRequest', 10]],
        ];
    }

    public function onUserCreated(UserCreatedEvent $event): void { ... }
    public function onKernelRequest(RequestEvent $event): void { ... }
}
```

`getSubscribedEvents()` return array keys → emit `hook` edges (source: subscriber file, target: listener method), metadata: `{ hookName: "UserCreatedEvent", hookType: "event_subscriber", framework: "symfony" }`.

---

## Yii2

### Detection

File: `src/frameworks/detectors/yii2.ts`

Detection signals:
- `yiisoft/yii2` in `composer.json` `require`

File match:
- `config/web.php`, `config/main.php`, or any PHP config file containing `'urlManager'`
- Any `.php` file extending `\yii\web\Controller`

### Route patterns extracted

#### URL rules (config array)

```php
// config/web.php
return [
    'components' => [
        'urlManager' => [
            'enablePrettyUrl' => true,
            'rules' => [
                'GET users' => 'user/index',
                'POST users' => 'user/create',
                'GET users/<id:\d+>' => 'user/view',
                'PUT users/<id:\d+>' => 'user/update',
                'DELETE users/<id:\d+>' => 'user/delete',
                // Object rules
                [
                    'class' => 'yii\rest\UrlRule',
                    'controller' => 'user',
                ],
            ],
        ],
    ],
];
```

**Extraction logic:**
- Find `'urlManager'` key → `'rules'` array
- For each string rule `'METHOD path' => 'controller/action'`:
  - Split key by space: `method` + `path`
  - Target: `ControllerName::actionAction` (e.g., `user/index` → `UserController::actionIndex`)
  - Emit `route` edge from config file → resolved method symbol, confidence: `inferred`
- For `yii\rest\UrlRule` with `'controller' => 'name'` → expand to 7 RESTful route edges (`index`, `view`, `create`, `update`, `delete`, `options` ×2 for collection and item)

```typescript
const YII2_RULE_STRING = /['"](?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?([^'"]+)['"]\s*=>\s*['"](\w+)\/(\w+)['"]/g;
const YII2_REST_RULE = /'controller'\s*=>\s*['"](\w+)['"]/g;
```

#### Controller action methods

```php
namespace app\controllers;

use yii\web\Controller;

class UserController extends Controller
{
    public function actionIndex(): string { ... }
    public function actionView(int $id): string { ... }
    public function actionCreate(): Response { ... }
    public function actionUpdate(int $id): Response { ... }
    public function actionDelete(int $id): Response { ... }
}
```

Action methods are named `actionXxx` by convention. When matched to a URL rule from config, the route edge is enriched with path. When no matching rule is found, emit route edge with path derived from default Yii2 convention: `/<module>/<controller-id>/<action-id>` (e.g., `UserController::actionView` → `GET /user/view`).

**Confidence:** `verified` for action methods (naming convention enforced by framework); `inferred` for default-convention path.

#### `behaviors()` access control

```php
public function behaviors(): array
{
    return [
        'access' => [
            'class' => AccessControl::class,
            'rules' => [
                ['actions' => ['index', 'view'], 'allow' => true, 'roles' => ['@']],
            ],
        ],
        'verbs' => [
            'class' => VerbFilter::class,
            'actions' => [
                'delete' => ['POST'],
            ],
        ],
    ];
}
```

`behaviors()` returning `AccessControl` or `VerbFilter` → emit `middleware` edges to those classes.

### Yii3

Detection signals:
- `yiisoft/yii-web` in `composer.json` (Yii3 web package)

#### Route definitions

```php
// config/routes.php
use Yiisoft\Router\Route;

return [
    Route::get('/users')->action([UserController::class, 'index'])->name('user.index'),
    Route::post('/users')->action([UserController::class, 'create'])->name('user.create'),
    Route::get('/users/{id}')->action([UserController::class, 'view'])->name('user.view'),
    Route::methods(['PUT', 'PATCH'], '/users/{id}')->action([UserController::class, 'update']),
    Route::delete('/users/{id}')->action([UserController::class, 'delete']),

    // Route groups
    Route::addGroup('/api', static function (RouteCollectorInterface $r): void {
        $r->addRoute(Route::get('/health')->action(HealthController::class . '::index'));
    }),
];
```

**Extraction logic:**
- `Route::METHOD('path')->action([Class::class, 'method'])` → `route` edge to method
- `Route::methods(['PUT','PATCH'], 'path')` → two route edges (one per method)
- `Route::addGroup('prefix', fn)` → prefix prepended to all routes within the closure
- `->name('route.name')` → stored in edge metadata

```typescript
const YII3_ROUTE = /Route::(get|post|put|patch|delete|head|options)\(\s*['"]([^'"]+)['"]\s*\)/gi;
const YII3_METHODS = /Route::methods\(\s*\[([^\]]+)\]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
const YII3_ACTION = /->action\(\s*\[([^:]+)::class\s*,\s*['"](\w+)['"]\]\s*\)/g;
```

---

## WordPress

### Detection

File: `src/frameworks/detectors/wordpress.ts`

Detection signals (any one of):
- `wp-includes/functions.php` present (core or full install)
- `functions.php` containing `defined('ABSPATH')` or `define('ABSPATH'`
- `wp-content/plugins/` or `wp-content/themes/` directory present
- File with `Plugin Name:` comment header (plugin main file)
- `style.css` with `Theme Name:` comment header (theme)

Three sub-contexts are distinguished: **core/plugin** development, **theme** development, and **REST API** routes.

### Actions and filters — `hook` edges

```php
// In a plugin or theme's functions.php
add_action('init', 'my_plugin_init');
add_action('wp_enqueue_scripts', array($this, 'enqueue_assets'), 10, 0);
add_action('save_post', ['MyPlugin\PostHandler', 'onSavePost'], 20, 2);
add_filter('the_content', 'my_plugin_filter_content');
add_filter('wp_title', array($this, 'filter_title'), 10, 2);
```

**Extraction logic:**
- Match `add_action('hook_name', callback)` and `add_filter('hook_name', callback)` forms
- Emit `hook` edge from the file → resolved callback symbol
- Callback resolution:
  - String `'my_plugin_init'` → function symbol in same file (confidence: `inferred` if not found in same file)
  - `array($this, 'method')` or `[$this, 'method']` → method in containing class
  - `array(ClassName::class, 'method')` or `['ClassName', 'method']` → static method
  - Anonymous function → emit `hook` edge to the containing file
- Edge metadata:
  ```json
  {
    "hookName": "save_post",
    "hookType": "action",
    "priority": 20,
    "acceptedArgs": 2,
    "framework": "wordpress"
  }
  ```

For `add_filter`:
```json
{
  "hookName": "the_content",
  "hookType": "filter",
  "priority": 10,
  "framework": "wordpress"
}
```

Edge type: `hook`

```typescript
const WP_HOOK = /add_(action|filter)\(\s*['"]([^'"]+)['"]\s*,\s*(.+?)(?:\s*,\s*(\d+))?(?:\s*,\s*(\d+))?\s*\)/g;
```

### Shortcodes — `hook` edges

```php
add_shortcode('my_gallery', 'my_gallery_shortcode_handler');
add_shortcode('contact_form', array($this, 'renderContactForm'));
```

Emit `hook` edge with metadata: `{ hookName: "my_gallery", hookType: "shortcode", framework: "wordpress" }`.

Edge type: `hook`

### REST API — `route` edges

```php
add_action('rest_api_init', function() {
    register_rest_route('myplugin/v1', '/users', [
        'methods'  => 'GET',
        'callback' => 'myplugin_get_users',
        'permission_callback' => 'myplugin_permissions_check',
    ]);

    register_rest_route('myplugin/v1', '/users/(?P<id>\d+)', [
        [
            'methods'  => WP_REST_Request::READABLE,
            'callback' => 'myplugin_get_user',
        ],
        [
            'methods'  => WP_REST_Request::EDITABLE,
            'callback' => 'myplugin_update_user',
        ],
    ]);
});
```

**Extraction logic:**
- Match `register_rest_route('namespace', 'route', args)` calls
- Full path = `/wp-json/` + namespace + `/` + route
- If `args` is a flat array with `callback` → one route edge, method from `methods:` string
- If `args` is an indexed array of method arrays → one route edge per array entry
- `permission_callback` → emit `middleware` edge to callback symbol
- Edge metadata: `{ httpMethod: "GET", path: "/wp-json/myplugin/v1/users", namespace: "myplugin/v1", framework: "wordpress", confidence: "verified" }`

```typescript
const WP_REST_ROUTE = /register_rest_route\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*\[/g;
const WP_REST_CALLBACK = /'callback'\s*=>\s*['"]?(\w+)['"]?/g;
const WP_REST_METHODS = /'methods'\s*=>\s*['"]([^'"]+)['"]/g;
```

### Custom post types and taxonomies — `hook` edges

```php
register_post_type('portfolio', [
    'labels' => ['name' => 'Portfolio'],
    'public' => true,
    'supports' => ['title', 'editor', 'thumbnail'],
]);

register_taxonomy('portfolio_category', 'portfolio', [
    'label' => 'Portfolio Categories',
    'hierarchical' => true,
]);
```

Emit `hook` edges for registrations that create queryable URL endpoints:
- `register_post_type(slug)` → `hook` edge, metadata: `{ hookName: "portfolio", hookType: "post_type", hasArchive: true/false, framework: "wordpress" }`
- `register_taxonomy(slug)` → `hook` edge, metadata: `{ hookName: "portfolio_category", hookType: "taxonomy", framework: "wordpress" }`

These become reachable via WordPress URL patterns (`/portfolio/`, `/portfolio-category/`).

### WordPress template hierarchy — file-based routes

WordPress uses a template hierarchy to select the PHP file that renders a request. Template files in a theme become implicit route handlers:

```
wp-content/themes/mytheme/
  index.php          → catch-all fallback
  front-page.php     → GET /  (home page, if set)
  home.php           → GET /  (blog posts page)
  single.php         → GET /post-type/{slug}
  single-portfolio.php → GET /portfolio/{slug}
  page.php           → GET /{page-slug}
  page-about.php     → GET /about
  archive.php        → GET /post-type/
  archive-portfolio.php → GET /portfolio/
  category.php       → GET /category/{slug}
  tag.php            → GET /tag/{slug}
  author.php         → GET /author/{slug}
  search.php         → GET /?s={query}
  404.php            → HTTP 404 responses
```

**Extraction logic:**
- Walk theme directory for template files matching the WordPress template hierarchy patterns
- Emit `route` edge per file → file's default export (the template file itself, as no explicit handler)
- Path derived from filename using WordPress template hierarchy rules
- Edge metadata: `{ httpMethod: "GET", path: "/portfolio/{slug}", templateType: "single-cpt", framework: "wordpress", confidence: "inferred" }`

Template hierarchy filename patterns (partial):
- `front-page.php` → `GET /`
- `single.php` → `GET /{post_type}/{slug}`
- `single-{post-type}.php` → `GET /{post-type}/{slug}`
- `page.php` → `GET /{page-slug}`
- `page-{slug}.php` → `GET /{slug}`
- `archive-{post-type}.php` → `GET /{post-type}/`
- `category-{slug}.php` → `GET /category/{slug}`

---

## `mapx routes` and `mapx hooks` output

### `mapx routes --framework=wordpress`

```
Routes in /path/to/project

  Method  Path                             Handler                   Framework  File
  ────────────────────────────────────────────────────────────────────────────────────────
  GET     /wp-json/myplugin/v1/users       myplugin_get_users        wordpress  myplugin.php
  POST    /wp-json/myplugin/v1/users       myplugin_create_user      wordpress  myplugin.php
  GET     /portfolio/{slug}                (template)                wordpress  single-portfolio.php
  GET     /portfolio/                      (template)                wordpress  archive-portfolio.php
```

### `mapx routes --framework=symfony`

```
Routes in /path/to/project

  Method  Path              Handler                    Route name    File
  ────────────────────────────────────────────────────────────────────────────────
  GET     /users            UserController::index      user_index    src/Controller/UserController.php
  GET     /users/{id}       UserController::show       user_show     src/Controller/UserController.php
  POST    /users            UserController::create     user_create   src/Controller/UserController.php
  PUT     /users/{id}       UserController::update     user_update   src/Controller/UserController.php
  PATCH   /users/{id}       UserController::update     user_update   src/Controller/UserController.php
  DELETE  /users/{id}       UserController::delete     user_delete   src/Controller/UserController.php
```

### `mapx hooks` (new sub-command)

WordPress and Drupal both produce `hook` edges. A dedicated `mapx hooks` command (complementing `mapx routes`) surfaces them:

```
Hooks in /path/to/project

  Hook name               Type        Priority  Handler                      Framework  File
  ─────────────────────────────────────────────────────────────────────────────────────────────
  init                    action      10        my_plugin_init               wordpress  myplugin.php
  save_post               action      20        MyPlugin\PostHandler::onSave wordpress  PostHandler.php
  the_content             filter      10        my_plugin_filter_content     wordpress  myplugin.php
  my_gallery              shortcode   —         my_gallery_shortcode_handler wordpress  myplugin.php
  UserCreatedEvent        event       —         UserEventSubscriber::onCreated symfony   src/EventSubscriber/UserEventSubscriber.php
  node_insert             hook        —         mymodule_node_insert         drupal     mymodule.module
```

**`mapx hooks` CLI options:** `--framework=<name>`, `--type=<action|filter|shortcode|event|hook>`, `--name=<pattern>`, `--json`

**`mapx_hooks` MCP tool** — returns hook list as JSON.

---

## Acceptance Criteria

### Symfony
- [ ] `#[Route('/users', methods: ['GET'])]` on method emits `route` edge
- [ ] Class-level `#[Route('/prefix')]` prepended to method-level paths
- [ ] Multiple `methods:` values emit one route edge per method
- [ ] Route `name:` stored in edge metadata (`routeName`)
- [ ] Legacy docblock `@Route(...)` annotation also recognized
- [ ] YAML route file (`config/routes.yaml`) with `path:` + `controller:` emits route edge
- [ ] PHP `$routes->add('name', 'path')->controller([...])->methods([...])` emits route edge
- [ ] `getSubscribedEvents()` return array emits `hook` edges to listener methods

### Yii2
- [ ] String URL rule `'GET users' => 'user/index'` emits route edge to `UserController::actionIndex`
- [ ] `yii\rest\UrlRule` with `'controller' => 'user'` expands to 7 CRUD route edges
- [ ] Default convention path derived for actions with no explicit URL rule
- [ ] `behaviors()` with `AccessControl` / `VerbFilter` emits `middleware` edges

### Yii3
- [ ] `Route::get('/users')->action([UserController::class, 'index'])` emits route edge
- [ ] `Route::methods(['PUT','PATCH'], '/path')` emits two route edges
- [ ] `Route::addGroup('/prefix', fn)` prepends prefix to child routes
- [ ] `->name('route.name')` stored in edge metadata

### WordPress — actions/filters
- [ ] `add_action('init', 'callback')` emits `hook` edge with `hookType: "action"`
- [ ] `add_filter('the_content', 'callback')` emits `hook` edge with `hookType: "filter"`
- [ ] `array($this, 'method')` callback resolves to method in containing class
- [ ] `['ClassName', 'method']` callback resolves to static method symbol
- [ ] Priority and accepted-args values stored in edge metadata

### WordPress — shortcodes
- [ ] `add_shortcode('tag', 'handler')` emits `hook` edge with `hookType: "shortcode"`

### WordPress — REST API
- [ ] `register_rest_route('ns/v1', '/users', [...])` emits `route` edge to callback
- [ ] Full path = `/wp-json/ns/v1/users`
- [ ] Multi-method array form emits one route edge per method entry
- [ ] `permission_callback` emits `middleware` edge

### WordPress — post types and taxonomies
- [ ] `register_post_type('portfolio', [...])` emits `hook` edge with `hookType: "post_type"`
- [ ] `register_taxonomy('cat', 'portfolio', [...])` emits `hook` edge with `hookType: "taxonomy"`

### WordPress — template hierarchy
- [ ] `single-portfolio.php` in theme emits route edge for `GET /portfolio/{slug}`
- [ ] `page-about.php` emits route edge for `GET /about`
- [ ] `404.php` noted in metadata but not assigned an HTTP route path

### `mapx hooks`
- [ ] `mapx hooks` command prints hook table
- [ ] `mapx hooks --type=filter` filters to filter hooks only
- [ ] `mapx hooks --framework=wordpress` shows only WordPress hooks
- [ ] `mapx_hooks` MCP tool returns hook list as JSON
- [ ] `npx tsc --noEmit` passes
