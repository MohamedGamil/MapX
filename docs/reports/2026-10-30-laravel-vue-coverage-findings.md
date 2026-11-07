# Mapx 0.3.5: Laravel, Vue 2 and Vue 3 coverage findings and next-version suggestions

| | |
| --- | --- |
| Date | 2026-10-30 |
| Mapx version measured | 0.3.5, commit `7e5aa19` (Node 24, built from the lockfile with `npm ci --legacy-peer-deps`) |
| Source of the findings | Chainware iteration M0-09: Mapx and Codegraph 1.6.2 scored against a labeled fixture of 98 edges from a private Laravel 12 + Vue 3 pilot codebase |
| Safe to publish | Yes. This document contains no pilot source code, file paths, route names or identifiers. Examples are synthetic, and numbers are aggregates. |

## 1. How Mapx was measured

- **Workspaces:** a backend Laravel 12 repository (~4,200 PHP files, ~900 routes) and a frontend Vue repository (~1,260 `.vue` files, a Vue 2 → 3 migration branch), indexed in two layouts:
  - **parent folder:** both repositories under one `mapx init` root;
  - **multi-repository:** one workspace, `repos` set to `[backend, frontend]`, `frameworks.json` set to `["laravel"]`, `mapx scan . --all`.
- **Isolation:** runs were offline (network namespace removed) with telemetry variables set; Mapx made no outbound calls.
- **Ground truth:** 98 hand-verified edges pinned to commits:
  - **route → controller:** method, URI and `Controller@method`, across 10 declaration forms and every mount mechanism;
  - **frontend call → backend route:** `Api().get(...)` factories, `apiService` aliases, literal, template and constant URLs, and calls in `.js` and `.vue`;
  - **host ↔ iframe `postMessage` flags:** handled as part of the measurement; not a Mapx goal;
  - **negative cases:** an unmounted route file, routes overridden by a later registration of the same method and URI, and a client call to an unserved endpoint.
- **Scoring:** recall is found ÷ labeled. Precision is correct ÷ reported; anything reported on a negative case is a false positive. Path parameter names are ignored (`{id}` = `{slug}`), and a reported method set (`GET|POST`) matches any method in it.

## 2. Results for Mapx

| Level | Pattern | Parent folder | Multi-repository |
| --- | --- | --- | --- |
| route URI | `Route::get('/x', ['uses' => 'C@m'])` | 0/23 | 3/23 |
| route handler | same | 0/23 | **0/23** |
| route URI / handler | `[C::class, 'm']` | 0/7 / 0/7 | 4/7 / 7/7 |
| route URI / handler | `Route::controller(C::class)->group(...)` | 0/6 / 0/6 | 0/6 / **6/6** |
| route URI / handler | `Route::match([...])` | 0/3 / 0/3 | 1/3 / 2/3 |
| route URI / handler | `Route::resource(...)` (expanded) | 0/14 / 0/14 | 0/14 / **14/14** |
| route URI / handler | `$base.'/x'` path | 0/1 / 0/1 | 0/1 (false positive) / 1/1 |
| route URI | closures (web, tenant) | 0/2 | 2/2 |
| route, negative | overridden or unmounted declarations | — | 3 false positives |
| client → route | every client form (33 edges) | 0/33 | 0/33 |

**Cost** in the multi-repository layout: 6,699 files in 75 s, 2.8 GiB peak RSS, a 103 MB index.

**Comparison:**

- Mapx resolved **31 of 32** handlers outside the `['uses' => ...]` form; Codegraph 1.6.2 resolved 15 of 32, linking two to the wrong class.
- Codegraph recorded correct URIs for all 23 `['uses' => ...]` routes, because it follows nested `require` mounts.
- Neither tool paired any frontend call with a backend route.

## 3. Root causes (file references at `7e5aa19`)

### Laravel

1. **`['uses' => 'C@m']` arrays lose their handler.**
   - In `src/frameworks/detectors/laravel.ts` (around line 1474), the `@` branch strips quotes and requires the whole handler string to match `^Class@method$`.
   - An array such as `['type' => 'X', 'uses' => 'C@m']` never matches, so the route gets `handlerFile` = the route file and no `handlerSymbol`.
   - This is the most common form in older Laravel codebases.
2. **Files `require`d from a route file do not inherit the enclosing group.**
   - `getInitialGroupConfig` gives `routes/api.php` the `api` prefix (line ~324), but files pulled in with `require __DIR__.'/api/x.php'` inside a `Route::group(...)` start from an empty prefix, middleware and namespace.
   - Their URIs lose `api/` (and any group prefix), and the group middleware is lost.
3. **Provider mounts other than `loadRoutesFrom` are ignored, and `loadRoutesFrom` mounts get an empty prefix.**
   - In module providers (lines ~279–290) the prefix is hard-coded to `''`.
   - The common pattern `Route::prefix('api/v1')->middleware(...)->group(__DIR__.'/../Routes/api.php')` in any service provider's `boot()` is not read, so its prefix is dropped.
4. **`Route::controller(...)` groups and resources lose the outer prefix when the file itself was mounted by `require`.** This is the same cause as item 2; handlers are correct.
5. **Resource parameter names differ from Laravel's.**
   - `getResourceParam` (line ~1066) singularises naively and keeps hyphens: `blog-categories` → `{blog-category}`.
   - Laravel uses `Str::singular` with `-` replaced by `_`: `{blog_category}`.
   - Irregular plurals (`statuses` → `status`, `children`, `people`) are also wrong.
6. **Dynamic path segments are emitted verbatim.** `Route::get($base.'/x', ...)` yields the path `/$base.'/x`. Resolving local string variables assigned in the same closure (`$base = 'notices';`) would recover the URI.
7. **No mount reachability or load order.**
   - Every PHP file under `routes/` is treated as live, including files no provider or `require` loads.
   - When the same method and URI is declared twice, both are reported, although Laravel keeps the **last** registration.
   - Conditional mounts (`if (Feature::enabled()) { require ...; }`) are not flagged.
8. **Framework detection needs the repository at the scan root.**
   - `detect()` looks for `artisan` in the scanned file list, which never contains it because extensionless files aren't scanned. It then falls back to `composer.json` at the root.
   - In a parent-folder workspace Laravel is not detected at all, and `frameworks.json` set to `["laravel"]` does not override this: it is rewritten from detection.
9. **No line numbers on routes.**
   - `mapx routes --json` and the `route` edges in the store carry no source line, so a route cannot be tied back to its declaration.
   - The `route` edge's target is the route file itself rather than the controller method symbol.

### Vue 2 and Vue 3

10. **Only `<script>` blocks are parsed** (`src/parsers/languages/vue.ts`, through the TypeScript parser). The `<template>` is ignored, so these are lost:
    - event handlers (`@click="save"`);
    - method calls in bindings;
    - component usage (`<UserCard>`), which gives no component → component edge;
    - `v-model` and prop bindings.
11. **No SFC semantics.** In both Vue 2 and Vue 3:
    - Options API members (`methods`, `computed`, `watch`) are plain object properties, not component members, so `this.save()` does not resolve to `methods.save`.
    - Vuex `mapActions` / `mapGetters`, `this.$store.dispatch('module/ACTION')` and Pinia `useXStore()` calls do not resolve.
    - `<script setup>` macros (`defineProps`, `defineEmits`, `defineExpose`) are in the ignore list rather than modelled.
    - Composition `use*()` composables are ordinary calls.
12. **No HTTP client → route pairing.** Nothing links `axios.get('/x')`, `fetch('/api/x')` or project wrappers to the backend route they reach. Typical wrappers that must be supported:
    - a module that `export default () => axios.create({ baseURL })` and is used as `Api().get('x')`;
    - an alias `const api = Api()` or `apiHandler()`;
    - relative URLs combined with a base URL from config or env (`VUE_APP_ROOT_API`, `VITE_API_URL`);
    - URL constants (`const BASE = 'settings/x'`) and template literals (`` `${BASE}/${id}` ``);
    - a URL argument on the line after the call;
    - a conditional URL (`cond ? '/a' : '/b'`);
    - Vuex actions that call a service map by name (`services[payload.service](...)`).
13. **Cross-language name collisions.** In the multi-repository workspace, about 10,000 frontend→backend `call` edges were created by matching JavaScript call names (for example `get`) against PHP methods. These edges are noise.
14. **No `postMessage` / iframe modelling.** This is lower priority, but common in apps that embed viewers.

## 4. Suggestions for the next version

Ordered by impact on Laravel + Vue projects. Each item names a minimal test.

### P0: Laravel route correctness

1. **Parse `uses` arrays.**
   - Extract `'uses'\s*=>\s*'([^']+@[^']+)'` from array handlers, and also the `'as'` and `'middleware'` keys.
   - Apply the group namespace as for string handlers.
   - Test: `Route::get('/x', ['type' => 'T', 'uses' => 'XController@show'])` inside `Route::group(['namespace' => 'App\\Http\\Controllers'])` gives handler `App\Http\Controllers\XController@show`.
2. **Follow `require` / `include` inside route files.**
   - Resolve `__DIR__`-relative paths.
   - Push the current group stack (prefix, middleware, namespace, controller) onto the included file's initial config, keyed by the including file and line so one file can be mounted twice.
   - Test: `routes/api.php` with `Route::group(['middleware' => 'auth'], fn () => require __DIR__.'/api/users.php')` gives URIs `api/...` and middleware `api, auth`.
3. **Read provider mounts generally.**
   - In every `*ServiceProvider.php` `boot()`, parse `Route::prefix(..)->middleware(..)->namespace(..)->group(<path>)` and `$this->loadRoutesFrom(<path>)` together with an enclosing `Route::prefix(...)->group(function () { $this->loadRoutesFrom(...); })`.
   - Store the prefix in `packageRoutes` instead of `''`.
   - Test: a module provider mounting `Routes/api.php` under `api/external/v1`.
4. **Match Laravel's resource parameter names:** `Str::singular` semantics, `-` → `_`, irregular plurals, and `->parameters([...])` overrides.
5. **Mount reachability and last-registration-wins.**
   - Build the mount graph: `RouteServiceProvider` `map()` calls that are actually called (skip commented ones), `require`, provider mounts and `bootstrap/app.php` `withRouting(...)`.
   - Mark routes in unreached files `reachable: false`, and flag conditional mounts.
   - For duplicate method and URI pairs, in load order, mark all but the last `overridden: true` and point to the winner.
   - Tests: an unmounted file, a duplicate across a parent file and a file it `require`s afterwards, and an `if (...) require`.
6. **Detect nested Laravel roots.**
   - When the scan root is not a Laravel app, look for subdirectories containing `artisan` or `composer.json` with `laravel/framework`, and treat each as its own route context.
   - Honour `frameworks.json` as an explicit override instead of rewriting it.
7. **Emit line numbers and real targets.** Add `line` to `RouteBinding`, to `mapx routes --json` and to `route` edge metadata. Point the `route` edge's target at the controller method symbol, not the route file.

### P1: Vue 2 and Vue 3

8. **Template pass.** Parse `<template>` (vue-eslint-parser or `@vue/compiler-sfc`) for:
   - event handlers and method calls → method edges;
   - component tags → component edges, resolved through local registration, global registration and auto-import conventions;
   - `v-model` and props.

   This works for both Vue 2 and Vue 3 templates.
9. **SFC member resolution:**
   - **Vue 2 Options API:** `this.x()` → `methods.x`, `computed`, `watch`, mixins.
   - **Vue 3 Options API:** the same.
   - **Composition API and `<script setup>`:** top-level bindings, `defineProps` / `defineEmits` as component interface, and `useX()` composables as edges to their definitions.
   - Test fixtures: one SFC per style, in both Vue 2.7 and Vue 3.x syntax, since migration branches mix them.
10. **State management.**
    - Resolve Vuex `mapActions`, `mapGetters`, `mapState` and `this.$store.dispatch/commit('ns/NAME')` to the action or mutation in the store module, including lazily registered modules.
    - Resolve Pinia `useXStore()` → store definition, and `store.action()` → action.
11. **Vue Router:** already detected (286 routes). Add navigation edges from `router.push({ name })`, `this.$router.push('/x')` and `<router-link :to>` to the route record and its component.

### P1: Frontend → backend HTTP pairing

12. **Client call-site extraction** in `.js`, `.ts` and `.vue`:
    - recognise `axios`, `fetch`, `ky` and similar, `axios.create(...)` instances, factories returning them (`export default () => axios.create(...)` called as `Api()`), and aliases (`const api = Api()`);
    - make receiver names configurable (`frameworks.http.clients: ["Api()", "apiService", "http"]`);
    - resolve file-local and imported string constants, template literals with constant parts, and arguments split across lines;
    - for conditional URLs, emit one edge per branch.
13. **Base URL resolution:** read `baseURL` from the factory, from env files (`.env*`: `VUE_APP_*`, `VITE_*`) and from config modules, and join paths with axios semantics (`/api/` + `x` and `/api/` + `/x` both give `/api/x`).
14. **Pairing with backend routes across repositories:** match method and normalised path (parameter placeholders unified) against Laravel routes in any registered repository. Emit `http` edges with confidence, plus `unmatched` markers for calls with no route, which is useful for finding dead or broken calls.
15. **Restrict cross-language name resolution.** Do not resolve a JavaScript call to a PHP symbol, or the reverse, by name alone; cross-language edges should come only from typed bridges such as HTTP pairing. This removes about 10k false edges in a two-repository workspace.

### P2: Developer experience and measurement

16. **`mapx routes --json` fields:** add `line`, `reachable`, `overridden`, `conditional`, `name` and `middlewares` (already present).
17. **Iframe and `postMessage` (optional):** model `window.postMessage(obj)` and `addEventListener('message')` with flag keys (`event.data?.isX`) as message edges between host and frame files.
18. **Regression fixtures:**
    - a small synthetic Laravel app covering every declaration form and mount above, including negative cases;
    - a Vue 2.7 app and a Vue 3 app with the client wrapper patterns;
    - a recall and precision score in CI.

    The Chainware fixture format (labels pinned to commits, `null` expected edges for negative cases) can be reused with synthetic code.

## 5. Expected effect

On the measured pilot:

- **Items 1–3** would take `uses-array` handlers from 0/23 towards 23/23, and URIs from 3/23 towards 23/23 (Codegraph already reaches 23/23 URIs this way).
- **Items 2, 3 and 4** fix the remaining resource and controller-group URIs.
- **Item 5** removes the 3 false positives.
- **Items 12–14** are the only way either tool scores above 0 on frontend → backend pairing.

Re-measuring with the same fixture after each release would show the gain per item.
