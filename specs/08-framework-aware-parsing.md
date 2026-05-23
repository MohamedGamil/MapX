# Framework-Aware Parsing — Overview

## What this covers

mapx already has deep Laravel-specific knowledge (F07–F12). This document describes the architecture for extending that approach to 20 additional frameworks across 7 language ecosystems.

The goal is the same for all frameworks: **turn implicit runtime bindings into explicit graph edges** so that LLMs can answer questions like "what handles `POST /checkout`?", "where are all my Django URL patterns?", "what NestJS controllers handle WebSocket events?", "what Rails routes go to the Users controller?".

---

## Framework list

| Ecosystem | Frameworks |
|-----------|-----------|
| Python | Django, Flask, FastAPI |
| JavaScript / TypeScript | Express, NestJS |
| Frontend routing | React Router v6+, Tanstack Router, Next.js (App Router + Pages Router), SvelteKit |
| PHP | Laravel (extended), Drupal, Symfony, Yii2/Yii3, WordPress |
| Ruby | Rails |
| JVM | Spring (Boot) |
| Go | Gin, chi, gorilla/mux |
| Rust | Axum, actix-web, Rocket |
| C# | ASP.NET Core |
| Swift | Vapor |

---

## What is extracted for each framework

### Route edges

Every HTTP route definition is converted into a `route` edge:

```
<route-file>  —[route]→  <handler-symbol>
```

Edge metadata (carried in `target_symbol` field encoding, see F21):
- HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `ANY`, `HEAD`
- URI pattern: `/users/{id}`, `/api/orders`
- Handler: controller class, function, or method

Example edges after framework processing:

```
urls.py              —[route:GET:/users/]→       UserListView::as_view
views.py             —[route:POST:/users/]→      UserCreateView::create
app.ts               —[route:GET:/health]→        healthHandler
routes/web.php       —[route:GET:/checkout]→      CheckoutController::show
config/routes.rb     —[route:GET:/orders/:id]→    OrdersController::show
```

### Additional edge types

| Edge type | Source | Introduced by |
|-----------|--------|---------------|
| `route` | All frameworks | F08 (Laravel), extended here |
| `middleware` | All frameworks | F08 (Laravel), extended here |
| `hook` | Drupal, WordPress, Symfony event subscribers | F25, F26 |
| `graphql_resolver` | NestJS | F23 |
| `message_handler` | NestJS microservices | F23 |
| `websocket_handler` | NestJS WebSockets | F23 |

---

## Architecture

### Framework detector pipeline

Framework-aware parsing runs **after** the standard symbol/reference extraction phase, as a second post-processing pass. This avoids complicating the tree-sitter query layer with framework-specific logic.

```
scan phase 1: standard parse    → symbols + generic edges
scan phase 2: framework detect  → route edges + metadata enrichment
```

Each framework ships a `FrameworkDetector` that:
1. Decides whether a file/project is relevant (detector match)
2. Reads the file and extracts route definitions using its own logic
3. Emits `RouteBinding` records
4. The `RouteRegistry` resolves bindings to target symbols and writes edges

```typescript
// src/frameworks/framework-detector.ts
export interface RouteBinding {
  sourceFile: string;
  sourceSymbol: string | null;
  method: HttpMethod | 'ANY' | 'WS' | 'GQL';
  path: string;
  targetFile: string | null;   // resolved if known
  targetSymbol: string | null; // handler function/method name
  confidence: 'verified' | 'inferred';
  framework: string;
  metadata: Record<string, unknown>;
}

export interface FrameworkDetector {
  readonly framework: string;
  readonly language: string;
  detect(projectRoot: string, files: string[]): boolean;
  extractRoutes(filePath: string, source: string, allSymbols: SymbolRow[]): RouteBinding[];
}
```

### Framework auto-detection

On scan start, the `FrameworkDetector` registry probes each project for known framework signals:

| Framework | Detection signal |
|-----------|-----------------|
| Django | `manage.py` present or `settings.py` with `INSTALLED_APPS` |
| Flask | `from flask import Flask` or `import flask` in any `.py` file |
| FastAPI | `from fastapi import FastAPI` in any `.py` file |
| Express | `express` in `package.json` dependencies |
| NestJS | `@nestjs/core` in `package.json` dependencies |
| React Router | `react-router-dom` or `@tanstack/router` in `package.json` |
| Next.js | `next` in `package.json` + `app/` or `pages/` directory |
| SvelteKit | `@sveltejs/kit` in `package.json` |
| Laravel | `artisan` file in project root |
| Drupal | `core/lib/Drupal.php` present |
| Symfony | `symfony/framework-bundle` in `composer.json` |
| Yii2 | `yiisoft/yii2` in `composer.json` |
| Yii3 | `yiisoft/yii-web` in `composer.json` |
| WordPress | `wp-includes/functions.php` present, or `functions.php` with `ABSPATH`, or `Plugin Name:` header |
| Rails | `config/routes.rb` present |
| Spring | `@SpringBootApplication` annotation in any `.java` file |
| Gin/chi/gorilla | `github.com/gin-gonic/gin` (or chi/gorilla) in `go.mod` |
| Axum/actix/Rocket | `axum` (or actix/rocket) in `Cargo.toml` |
| ASP.NET | `.csproj` with `Microsoft.AspNetCore` package reference |
| Vapor | `Package.swift` with `Vapor` dependency |

Detection results are cached in `.mapx/` per repo so detection only runs once (until a re-scan).

### Route encoding in edges

The existing edge schema has no metadata column. Route edges encode HTTP method + path into the `target_symbol` field using the pattern `METHOD:path → handler`:

```
edge_type:    'route'
source_file:  'app/urls.py'
source_symbol: null
target_file:  'app/views.py'
target_symbol: 'GET:/users/ → UserListView.get'
weight:        1.0
```

This allows MCP tools to surface route info without schema changes.

A schema-level `edge_metadata` JSON column is proposed in F21 for richer storage; the encoding fallback ensures backward compatibility.

---

## Context building integration

Framework route edges enrich `mapx_context` (F19) and `mapx_impact` (F19):

- `mapx_context { task: "checkout payment" }` — route edges link `routes/web.php` to `CheckoutController`, so both are included in context automatically
- `mapx_impact { symbol: "UserService::create" }` — route edges surface which HTTP endpoints trigger the impacted symbol's call chain
- `mapx_node { symbol: "CheckoutController::store" }` — shows "routed via: POST /checkout (routes/web.php)"

---

## Feature breakdown

| Feature | Content |
|---------|---------|
| F21 | Framework detection infrastructure: shared types, `RouteRegistry`, edge schema extension, `mapx routes` CLI/MCP |
| F22 | Python frameworks: Django, Flask, FastAPI |
| F23 | Node.js/TS frameworks: Express, NestJS (HTTP + GraphQL + Microservices + WebSockets) |
| F24 | Frontend routing: React Router v6+, Tanstack Router, Next.js, SvelteKit |
| F25 | Backend frameworks: Laravel (extended), Drupal, Rails, Spring, Gin/chi/gorilla/mux, Axum/actix/Rocket, ASP.NET Core, Vapor |
| F26 | PHP CMS/frameworks: Symfony (attribute + YAML routes, event subscribers), Yii2 (URL rules, REST), Yii3 (typed Route builder), WordPress (hooks, filters, shortcodes, REST API, template hierarchy) |

All features land in I13.
