# F24 — Frontend Routing Frameworks (React Router, Tanstack Router, Next.js, SvelteKit)

| Field | Value |
|-------|-------|
| ID | F24 |
| Status | `planned` |
| Iteration | I13 |
| Branch | `feat/i13-framework-routes` |
| Depends on | F21 (infrastructure) |
| Blocked by | F21 must be merged |

---

## Overview

Frontend routing frameworks define routes in different ways: React Router uses JSX component trees; Tanstack Router uses typed file-based or code-based routing; Next.js uses filesystem conventions; SvelteKit uses filesystem conventions with `+page.svelte` and `+server.ts` files.

All four produce `route` edges that link route definitions to the components or handlers they render.

> **Semantics note:** These are **client-side routing configurations** — they define how the browser navigates between views at runtime. They are NOT server-side HTTP routes (those are handled by F08/F22/F23). `route` edges produced here carry `metadata.routeType = "client"` and `metadata.framework = "<name>"` to distinguish them from server-side `route` edges (which use `metadata.routeType = "server"`). The edge means "this route definition **renders** this component", not "this URL path **serves** this HTTP response".

---

## React Router v6+

### Detection

File: `src/frameworks/detectors/react-router.ts`

Detection signals:
- `react-router-dom` in `package.json` dependencies

File match: any `.tsx` / `.jsx` / `.ts` / `.js` file containing `<Route`, `createBrowserRouter`, `createRoutesFromElements`, or `RouterProvider`

### Route patterns extracted

#### JSX-based routes (v6 `<Routes>` / `<Route>`)

```tsx
function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/users" element={<UserListPage />} />
      <Route path="/users/:id" element={<UserDetailPage />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboard />} />
        <Route path="users" element={<AdminUsersPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
```

**Extraction logic:**
- Walk JSX tree for `<Route path="..." element={<ComponentName />}>`
- Emit `route` edge from the file → the component symbol in `element={}`
- Path = `path` attribute value (with parent paths prepended for nested routes)
- Edge metadata: `{ httpMethod: "GET", path: "/users/:id", componentName: "UserDetailPage", framework: "react-router" }`

Nested routes: parent `path` is prepended to child paths.

**Confidence:** `verified` (JSX component reference)

#### `createBrowserRouter` (v6.4+ data routing)

```typescript
const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "users", element: <UserListPage />, loader: loadUsers },
      { path: "users/:id", element: <UserDetailPage />, action: updateUser },
    ],
  },
]);
```

**Extraction logic:**
- Match `createBrowserRouter([...])` call
- Walk the object array recursively for `path`, `element`, `loader`, `action`, `Component` keys
- `element: <ComponentName />` → `route` edge
- `loader: functionName` → emit `route` edge with metadata `{ routeRole: "loader" }`
- `action: functionName` → emit `route` edge with metadata `{ routeRole: "action" }`
- `index: true` → path segment = `""` (index route)

#### `createRoutesFromElements`

```tsx
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/" element={<Root />}>
      <Route path="users" element={<UserListPage />} />
    </Route>
  )
);
```

Same extraction as JSX-based routes.

### Implementation strategy

```typescript
// Match JSX: <Route path="..." element={<ComponentName .../>}
const JSX_ROUTE = /<Route\s[^>]*path=["']([^"']+)["'][^>]*element=\{<(\w+)/g;

// Match object: { path: "...", element: <Component /> }
const OBJ_ROUTE = /path:\s*["']([^"']+)["']\s*,\s*(?:element:\s*<(\w+)|[Cc]omponent:\s*(\w+))/g;

// Match: loader: functionName or action: functionName
const ROUTE_LOADER = /(?:loader|action):\s*(\w+)/g;
```

---

## Tanstack Router

### Detection

File: `src/frameworks/detectors/tanstack-router.ts`

Detection signals:
- `@tanstack/react-router` or `@tanstack/router` in `package.json`

Two routing modes: **file-based** (recommended, v1+) and **code-based**.

### File-based routing (recommended)

Tanstack Router's file-based routing uses a `routes/` directory where each file's path becomes a route:

```
src/routes/
  __root.tsx           → /
  index.tsx            → /
  about.tsx            → /about
  users/
    index.tsx          → /users
    $userId.tsx        → /users/$userId
    $userId.edit.tsx   → /users/$userId/edit
  _layout.tsx          → layout (no path segment)
  _layout/
    dashboard.tsx      → /dashboard
```

**Extraction logic:**
- Walk the `src/routes/` directory (or configured `routesDirectory`)
- For each `.tsx`/`.jsx` file, derive the route path from the file path:
  - `index.tsx` → current directory path
  - `$param.tsx` → `:param` path segment
  - Files prefixed with `_` → layout routes (no path contribution)
  - Files prefixed with `(group)` → route groups (no path contribution)
- Find the default exported component or `createFileRoute('...').lazy()` call
- Emit `route` edge from `__root.tsx` (or route tree) → the file's default export

Edge metadata: `{ path: "/users/$userId", fileRoute: true, framework: "tanstack-router" }`

### Code-based routing

```typescript
const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  component: UserListComponent,
  loader: async () => fetchUsers(),
});

const userDetailRoute = createRoute({
  getParentRoute: () => usersRoute,
  path: '$userId',
  component: UserDetailComponent,
});
```

**Extraction logic:**
- Match `createRoute({ path: '...', component: ComponentName })` calls
- Emit `route` edge → `ComponentName`
- `loader:` function → emit `route` edge with `{ routeRole: "loader" }`

---

## Next.js

### Detection

File: `src/frameworks/detectors/nextjs.ts`

Detection signals:
- `next` in `package.json` dependencies
- `app/` directory (App Router) or `pages/` directory (Pages Router)

Two routing modes operate simultaneously in a hybrid Next.js project.

### App Router (Next.js 13+)

File-system conventions under `app/`:

```
app/
  page.tsx             → route /  (default export = Page component)
  layout.tsx           → layout wrapper
  loading.tsx          → loading UI
  error.tsx            → error boundary
  not-found.tsx        → 404 handler
  users/
    page.tsx           → route /users
    [id]/
      page.tsx         → route /users/[id]
      edit/
        page.tsx       → route /users/[id]/edit
  (marketing)/
    about/
      page.tsx         → route /about  (group does not affect URL)
  api/
    users/
      route.ts         → API route GET/POST /api/users
    users/[id]/
      route.ts         → API route GET/PUT/DELETE /api/users/[id]
```

**Page components:**
- For each `page.tsx` → emit `route` edge from the routing tree → default export of the file
- Path derived from directory structure
- Edge metadata: `{ httpMethod: "GET", path: "/users/[id]", framework: "nextjs", routerType: "app" }`

**API routes (`route.ts`):**
- Parse exported HTTP handler functions: `export async function GET()`, `export async function POST()`, etc.
- Emit `route` edge per exported HTTP method → handler function symbol
- Edge metadata: `{ httpMethod: "GET", path: "/api/users", framework: "nextjs", routerType: "app-api" }`

Supported exports: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`

**Server Actions:**
```typescript
// In a page or component:
async function createUser(formData: FormData) {
  'use server';
  ...
}
```
Functions marked `'use server'` emit a `route` edge with metadata `{ routeRole: "server-action" }`.

### Pages Router (legacy, Next.js ≤12)

```
pages/
  index.tsx            → route /
  about.tsx            → route /about
  users/
    index.tsx          → route /users
    [id].tsx           → route /users/[id]
  api/
    users.ts           → API route /api/users
    users/[id].ts      → API route /api/users/[id]
```

**Page components:** same as App Router (default export = handler).

**API routes (`pages/api/*.ts`):**
```typescript
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') { ... }
  if (req.method === 'POST') { ... }
}
```
Emit a single `route` edge with `httpMethod: "ANY"` (method is checked at runtime).

---

## SvelteKit

### Detection

File: `src/frameworks/detectors/sveltekit.ts`

Detection signals:
- `@sveltejs/kit` in `package.json`
- `src/routes/` directory present

File-system routing under `src/routes/`:

```
src/routes/
  +page.svelte         → route /  (page component)
  +layout.svelte       → layout wrapper
  +error.svelte        → error page
  +page.server.ts      → server-side load function for /
  +server.ts           → API endpoint (GET/POST/etc.) at /
  users/
    +page.svelte       → route /users
    [id]/
      +page.svelte     → route /users/[id]
      +page.server.ts  → load() function for /users/[id]
      +server.ts       → API: GET/POST /users/[id]
  (auth)/
    login/
      +page.svelte     → route /login  (group does not affect URL)
```

**Extraction logic:**

1. **`+page.svelte`** → emit `route` edge, target = file itself (component)
   - Path derived from directory structure relative to `src/routes/`
   - Edge metadata: `{ httpMethod: "GET", path: "/users/[id]", framework: "sveltekit", fileType: "page" }`

2. **`+page.server.ts`** → emit `route` edge for the `load()` function export
   - `export async function load({ params }) { ... }` → route edge with `{ routeRole: "load" }`
   - `export const actions = { default: ..., create: ..., update: ... }` → one route edge per action with `httpMethod: "POST"`

3. **`+server.ts`** → parse exported HTTP handlers:
   ```typescript
   export const GET: RequestHandler = async ({ params }) => { ... };
   export const POST: RequestHandler = async ({ request }) => { ... };
   ```
   - Emit `route` edge per exported HTTP method handler
   - Edge metadata: `{ httpMethod: "GET", path: "/users/[id]", framework: "sveltekit", fileType: "api" }`

4. **`+layout.server.ts`** → `load()` function applies to all routes within the directory subtree. Emit `route` edge with `{ routeRole: "layout-load" }`.

---

## `mapx routes` output for frontend frameworks

```
Routes in /path/to/project

  Method  Path                     Handler                          Framework       File
  ─────────────────────────────────────────────────────────────────────────────────────────
  GET     /                        App (jsx route)                  react-router    src/App.tsx
  GET     /users                   UserListPage                     react-router    src/App.tsx
  GET     /users/:id               UserDetailPage                   react-router    src/App.tsx
  GET     /users/$userId           UserDetailComponent              tanstack        src/routes/users.$userId.tsx
  GET     /users                   (page component)                 nextjs/app      app/users/page.tsx
  GET     /api/users               GET handler                      nextjs/app-api  app/api/users/route.ts
  POST    /api/users               POST handler                     nextjs/app-api  app/api/users/route.ts
  GET     /users/[id]              (page component)                 sveltekit       src/routes/users/[id]/+page.svelte
  GET     /api/users/[id]          GET handler                      sveltekit       src/routes/users/[id]/+server.ts
  POST    /api/users/[id]          POST handler                     sveltekit       src/routes/users/[id]/+server.ts
```

---

## Acceptance Criteria

### React Router
- [ ] `<Route path="/users" element={<UserListPage />}>` emits route edge to `UserListPage`
- [ ] Nested `<Route>` elements have parent path prepended
- [ ] `createBrowserRouter` object-array form emits route edges
- [ ] `loader:` and `action:` properties emit route edges with correct `routeRole`

### Tanstack Router — file-based
- [ ] `$userId.tsx` in routes dir maps to `:userId` path parameter
- [ ] `_layout.tsx` recognized as layout (no path contribution)
- [ ] Default export of route file is the route edge target

### Next.js App Router
- [ ] `page.tsx` in `users/[id]/` emits `GET /users/[id]` route edge
- [ ] `route.ts` exports (`GET`, `POST`, etc.) each emit separate route edges
- [ ] `'use server'` functions emit route edge with `routeRole: "server-action"`
- [ ] Route groups `(groupName)/` do not contribute to path

### Next.js Pages Router
- [ ] `pages/users/[id].tsx` emits `GET /users/[id]` route edge to default export
- [ ] `pages/api/users.ts` emits `ANY /api/users` route edge

### SvelteKit
- [ ] `+page.svelte` files emit route edges for their directory path
- [ ] `+page.server.ts` `load()` function emits route edge with `routeRole: "load"`
- [ ] `+page.server.ts` `actions` object emits POST route edges per action key
- [ ] `+server.ts` exported `GET`/`POST`/... emit separate route edges
- [ ] Route groups `(groupName)/` do not contribute to path

### Common
- [ ] All 4 frameworks produce edges in `mapx routes` output
- [ ] `mapx routes --framework=nextjs` filters correctly
- [ ] Path parameters normalized: `[id]`, `$id`, `:id` all shown as `{id}` in display
