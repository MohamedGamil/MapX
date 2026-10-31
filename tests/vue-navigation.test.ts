import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ExtractedSymbol, ScanContext } from '../src/types.js';
import {
  matchRoute, mayDefineRoutes, moduleNavigationReferences, navigationReferences, navTarget, routeRecords, type ResolvedRoute,
} from '../src/parsers/languages/vue-navigation.js';
import { VueParser } from '../src/parsers/languages/vue.js';
import { getBuiltinLanguages } from '../src/languages/registry.js';
import { VueRouterDetector } from '../src/frameworks/detectors/vue-router.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M3-06 / M3-11: Vue Router navigation (edge contract rule 9 in docs/baton/iterations/M3-01.md). The
// labelled yardstick is tests/fixtures/vue-sfc (patterns `router`, `router-record`, `router-module`); these tests
// pin the module and the cases the fixture does not cover (redirects, nested routes, aliases,
// patterns, fail-closed targets) and the edge type's life in a real scan, sync and the CLI/MCP.

describe('navTarget', () => {
  it('reads a path literal or a string name / path property, and nothing computed', () => {
    expect(navTarget(`'/users?tab=1#top'`)).toEqual({ path: '/users' });
    expect(navTarget('`/users/${user.id}/edit`')).toEqual({ path: '/users/${}/edit' });
    expect(navTarget(`{ name: 'user', params: { id } }`)).toEqual({ name: 'user' });
    expect(navTarget(`{ 'name': "user" }`)).toEqual({ name: 'user' });
    expect(navTarget(`{ path: '/users', query: { q } }`)).toEqual({ path: '/users' });
    expect(navTarget(`{ name: 'a', path: '/b' }`)).toEqual({ name: 'a' });
    for (const computed of ['path', `'/users/' + id`, `{ name: ROUTES.USER }`, '`user-${kind}`', `{ name: \`u-\${k}\` }`, `'relative'`, `{ params: { id } }`]) {
      expect(navTarget(computed), computed).toBeNull();
    }
  });
});

describe('navigationReferences (parser side)', () => {
  it('finds router calls in scripts and router-link targets in the template, with lines', () => {
    const sfc = `<template>
  <nav>
    <router-link :to="{ name: 'users' }">Users</router-link>
    <RouterLink to="/about">About</RouterLink>
    <!-- <router-link to="/hidden">x</router-link> -->
    <button @click="$router.push(\`/users/\${u.id}\`)">Open</button>
    <a :href="link" @click="items.push('/x')">x</a>
  </nav>
</template>

<script>
import router from '@/router';
export default {
  methods: {
    open(id) { this.$router.push({ name: 'user', params: { id } }); },
    home() { router.replace('/'); },
    later() { setTimeout(() => this.$router.push(somewhere), 1); },
    // this.$router.push('/commented')
  },
};
</script>

<script setup>
import { useRouter } from 'vue-router';
const nav = useRouter();
const list = [];
function go() { nav.push('/orders'); list.push('/not-a-route'); }
</script>`;
    const refs = navigationReferences(sfc).map((r) => ({ target: r.targetName, line: r.startLine, type: r.referenceType, owner: r.sourceSymbol, nav: r.metadata?.navigate }));
    expect(refs).toEqual([
      { target: 'user', line: 15, type: 'navigate', owner: null, nav: { name: 'user' } },
      { target: '/', line: 16, type: 'navigate', owner: null, nav: { path: '/' } },
      { target: '/orders', line: 27, type: 'navigate', owner: null, nav: { path: '/orders' } },
      { target: 'users', line: 3, type: 'navigate', owner: null, nav: { name: 'users' } },
      { target: '/about', line: 4, type: 'navigate', owner: null, nav: { path: '/about' } },
      { target: '/users/${}', line: 6, type: 'navigate', owner: null, nav: { path: '/users/${}' } },
    ]);
  });
});

const ROUTER = `import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import UserList from '@/views/UserList.vue';
import UserLayout from '../layouts/UserLayout.vue';
const UserProfile = () => import('../views/UserProfile.vue');

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: { name: 'users' } },
  // The list is named 'users'; views/Users.vue is an unrelated widget.
  { path: '/users', name: 'users', component: UserList },
  {
    path: '/users/:id',
    component: UserLayout,
    children: [
      { path: '', name: 'user', component: UserProfile },
      { path: 'settings', name: 'user-settings', components: { default: () => import('../views/UserSettings.vue'), aside: UserList } },
    ],
  },
  { path: '/legacy', redirect: '/users' },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('../views/NotFound.vue') },
];

export default createRouter({ history: createWebHistory(), routes });
`;

describe('routeRecords', () => {
  it('reads names, full paths, component specifiers, redirects and children', () => {
    expect(routeRecords(ROUTER).map(({ line: _line, ...r }) => r)).toEqual([
      { name: null, path: '/', component: null, redirect: { name: 'users' }, parent: false },
      { name: 'users', path: '/users', component: '@/views/UserList.vue', redirect: null, parent: false },
      { name: null, path: '/users/:id', component: '../layouts/UserLayout.vue', redirect: null, parent: true },
      { name: 'user', path: '/users/:id', component: '../views/UserProfile.vue', redirect: null, parent: false },
      { name: 'user-settings', path: '/users/:id/settings', component: '../views/UserSettings.vue', redirect: null, parent: false },
      { name: null, path: '/legacy', component: null, redirect: { path: '/users' }, parent: false },
      { name: 'not-found', path: '/:pathMatch(.*)*', component: '../views/NotFound.vue', redirect: null, parent: false },
    ]);
  });

  it('reads a lazy component whose import carries a webpack magic comment (the `vue create` router)', () => {
    const router = `const routes = [
  { path: '/about', name: 'about', component: () => import(/* webpackChunkName: "about" */ '../views/AboutView.vue') },
  { path: '/old', name: 'old', component: resolve => require(/* legacy */ ['../views/Old.vue'], resolve) },
];`;
    expect(routeRecords(router).map((r) => [r.name, r.component])).toEqual([
      ['about', '../views/AboutView.vue'],
      ['old', '../views/Old.vue'],
    ]);
  });
});

describe('matchRoute (scanner side)', () => {
  const table = (file: string, dir: string): ResolvedRoute[] => routeRecords(ROUTER).map((r) => ({
    ...r, file, componentFile: r.component ? `${dir}/${r.component.replace(/^(\.\.\/|@\/)/, '')}` : null,
  }));
  const routes = table('src/router/index.ts', 'src');
  const hit = (t: { name?: string; path?: string }, from = 'src/components/Nav.vue', rs = routes) => {
    const m = matchRoute(t, rs, from);
    return m && { file: m.route.componentFile, exact: m.exact };
  };

  it('matches a name exactly, never by similarity', () => {
    expect(hit({ name: 'users' })).toEqual({ file: 'src/views/UserList.vue', exact: true });
    expect(hit({ name: 'Users' })).toBeNull();
    expect(hit({ name: 'user-list' })).toBeNull();
  });

  it('matches a literal path, then the most specific :param pattern; a parent yields to its empty-path child', () => {
    expect(hit({ path: '/users' })).toEqual({ file: 'src/views/UserList.vue', exact: true });
    expect(hit({ path: '/users/42' })).toEqual({ file: 'src/views/UserProfile.vue', exact: false });
    expect(hit({ path: '/users/${}' })).toEqual({ file: 'src/views/UserProfile.vue', exact: false });
    expect(hit({ path: '/users/${}/settings' })).toEqual({ file: 'src/views/UserSettings.vue', exact: false });
  });

  it('follows redirects, and never targets a catch-all record', () => {
    expect(hit({ path: '/' })).toEqual({ file: 'src/views/UserList.vue', exact: true });
    expect(hit({ path: '/legacy' })).toEqual({ file: 'src/views/UserList.vue', exact: true });
    expect(hit({ path: '/nowhere' })).toBeNull();
    expect(hit({ path: '/users/1/2/3' })).toBeNull();
  });

  it('prefers the router file nearest to the caller, and gives nothing when that is still ambiguous', () => {
    const two = [...table('admin/src/router/index.ts', 'admin/src'), ...table('shop/src/router/index.ts', 'shop/src')];
    expect(hit({ name: 'users' }, 'shop/src/views/Home.vue', two)).toEqual({ file: 'shop/src/views/UserList.vue', exact: true });
    expect(hit({ name: 'users' }, 'shared/Nav.vue', two)).toBeNull();
  });
});

describe('VueRouterDetector component resolution (M3-01 defect)', () => {
  const ctx = (imports: Record<string, string>): ScanContext => ({
    workspaceRoot: '/tmp/none',
    repoName: 'r',
    // The old path: name lookup, which picked the router file that imports the component.
    resolveSymbolToFile: () => 'src/router/index.js',
    resolveImport: (spec) => imports[spec] ?? null,
  });
  const content = `import HomeView from '../views/HomeView.vue';
import { RouterView } from 'vue-router';
export default new VueRouter({ routes: [
  { path: '/', name: 'Dashboard', component: HomeView },
  { path: '/about', component: () => import('@/views/AboutView.vue') },
  { path: '/nested', component: RouterView },
] });`;

  it('resolves a statically imported component through its import, to the .vue file and its component symbol', async () => {
    const routes = await new VueRouterDetector().extractRoutes('src/router/index.js', content, ctx({
      '../views/HomeView.vue': 'src/views/HomeView.vue', '@/views/AboutView.vue': 'src/views/AboutView.vue',
    }));
    expect(routes.map((r) => [r.path, r.handlerFile, r.handlerSymbol])).toEqual([
      ['/', 'src/views/HomeView.vue', 'HomeView'],
      ['/about', 'src/views/AboutView.vue', 'AboutView'],
      // A package import that resolves nowhere keeps the old fallback (the router file).
      ['/nested', 'src/router/index.js', 'RouterView'],
    ]);
  });

  it('resolves a lazy import that carries a webpack magic comment (review 2026-10-31)', async () => {
    const lazy = `export default new VueRouter({ routes: [
  { path: '/about', component: () => import(/* webpackChunkName: "about" */ '../views/AboutView.vue') },
] });`;
    const routes = await new VueRouterDetector().extractRoutes('src/router/index.js', lazy, ctx({
      '../views/AboutView.vue': 'src/views/AboutView.vue',
    }));
    expect(routes.map((r) => [r.path, r.handlerFile, r.handlerSymbol])).toEqual([['/about', 'src/views/AboutView.vue', 'AboutView']]);
  });
});

// ── End to end ──────────────────────────────────────────────────────────────────────────────────

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'users-app', private: true, dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' } }),
  'src/router/index.ts': ROUTER,
  'src/main.ts': "import { createApp } from 'vue';\nimport App from './App.vue';\nimport router from './router';\ncreateApp(App).use(router).mount('#app');\n",
  'src/App.vue': '<template>\n  <AppNav />\n  <router-view />\n</template>\n\n<script setup>\nimport AppNav from \'./components/AppNav.vue\';\n</script>\n',
  'src/components/AppNav.vue': [
    '<template>',
    '  <nav>',
    "    <router-link :to=\"{ name: 'users' }\">Users</router-link>",
    '    <RouterLink to="/users/7/settings?tab=a">Settings</RouterLink>',
    '  </nav>',
    '</template>',
    '',
    '<script setup>',
    "import { useRouter } from 'vue-router';",
    'const router = useRouter();',
    'function back() {',
    "  router.replace('/');",
    '}',
    'function nowhere() {',
    "  router.push('/nowhere');",
    "  router.push({ name: 'Users' });",
    '}',
    '</script>',
    '',
  ].join('\n'),
  'src/components/UserCard.vue': [
    '<template>',
    '  <div class="card" @click="$router.push(`/users/${user.id}`)">{{ user.name }}</div>',
    '</template>',
    '',
    '<script>',
    'export default {',
    "  props: ['user'],",
    '  methods: {',
    '    open(id) {',
    "      this.$router.push({ name: 'user', params: { id } });",
    '    },',
    '    queue() {',
    "      const items = [];",
    "      items.push('/users');",
    '    },',
    '  },',
    '};',
    '</script>',
    '',
  ].join('\n'),
  'src/layouts/UserLayout.vue': '<template>\n  <router-view />\n</template>\n',
  'src/views/UserList.vue': '<template>\n  <ul />\n</template>\n',
  'src/views/Users.vue': '<template>\n  <p>widget</p>\n</template>\n',
  'src/views/UserProfile.vue': '<template>\n  <p>profile</p>\n</template>\n',
  'src/views/UserSettings.vue': '<template>\n  <p>settings</p>\n</template>\n',
  'src/views/NotFound.vue': '<template>\n  <p>404</p>\n</template>\n',
};

type Edge = { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string | null };
const edgesOf = (root: string, type: string) => query<Edge>(
  root, 'SELECT source_file, source_symbol, target_file, target_symbol FROM edges WHERE edge_type = ? ORDER BY source_file, source_symbol, target_file', type,
);

const NAVIGATE: Edge[] = [
  { source_file: 'src/components/AppNav.vue', source_symbol: 'AppNav', target_file: 'src/views/UserList.vue', target_symbol: 'UserList' },
  { source_file: 'src/components/AppNav.vue', source_symbol: 'AppNav', target_file: 'src/views/UserSettings.vue', target_symbol: 'UserSettings' },
  { source_file: 'src/components/AppNav.vue', source_symbol: 'back', target_file: 'src/views/UserList.vue', target_symbol: 'UserList' },
  { source_file: 'src/components/UserCard.vue', source_symbol: 'UserCard', target_file: 'src/views/UserProfile.vue', target_symbol: 'UserProfile' },
  { source_file: 'src/components/UserCard.vue', source_symbol: 'open', target_file: 'src/views/UserProfile.vue', target_symbol: 'UserProfile' },
];
const ROUTE_TARGETS = [
  'src/layouts/UserLayout.vue#UserLayout',
  'src/views/NotFound.vue#NotFound',
  'src/views/UserList.vue#UserList',
  'src/views/UserProfile.vue#UserProfile',
  'src/views/UserSettings.vue#UserSettings',
];

describe('navigate edges in a real scan, sync and the CLI/MCP route views', () => {
  let root: string;
  let client: Client;
  beforeAll(async () => {
    root = workspace(files);
    init(root);
    mapx(root, 'scan', root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
  }, 120000);
  afterAll(async () => {
    await client?.close();
    cleanup(root);
  });

  it('links each navigation to the component of the route record it reaches, and nothing else', () => {
    expect(edgesOf(root, 'navigate')).toEqual(NAVIGATE);
    const meta = query<{ metadata: string; verifiability: string }>(
      root, "SELECT metadata, verifiability FROM edges WHERE edge_type = 'navigate' AND source_symbol = 'open'",
    )[0]!;
    expect(JSON.parse(meta.metadata)).toMatchObject({ navigate: { name: 'user' }, route: { file: 'src/router/index.ts', name: 'user', path: '/users/:id' } });
    expect(meta.verifiability).toBe('verified');
    // A router-link target is navigation, not a rendered child.
    expect(edgesOf(root, 'render').filter((e) => e.source_file === 'src/components/AppNav.vue')).toEqual([]);
  });

  it('gives the router file route edges to the components, never to itself', () => {
    const routes = edgesOf(root, 'route');
    expect(routes.every((e) => e.source_file === 'src/router/index.ts' && e.source_symbol === null)).toBe(true);
    expect([...new Set(routes.map((e) => `${e.target_file}#${e.target_symbol}`))].sort()).toEqual(ROUTE_TARGETS);
  });

  it('keeps navigate edges through sync and a second scan (framework edges are rebuilt after resolution)', () => {
    writeFileSync(join(root, 'src/views/UserList.vue'), '<template>\n  <ol />\n</template>\n');
    mapx(root, 'sync', root);
    expect(edgesOf(root, 'navigate')).toEqual(NAVIGATE);
    mapx(root, 'scan', root);
    expect(edgesOf(root, 'navigate')).toEqual(NAVIGATE);
    expect([...new Set(edgesOf(root, 'route').map((e) => `${e.target_file}#${e.target_symbol}`))].sort()).toEqual(ROUTE_TARGETS);
  });

  it('is not a backend route: routes (CLI and MCP) list only the route records, status counts it on its own', async () => {
    const cli = JSON.parse(mapx(root, 'routes', '--json')) as Array<{ path: string; handlerFile: string }>;
    const records = cli.map((r) => `${r.path} ${r.handlerFile}`).sort();
    expect(records).toEqual([
      '/:pathMatch(.*)* src/views/NotFound.vue',
      '/users src/views/UserList.vue',
      '/users/:id src/layouts/UserLayout.vue',
      '/users/:id src/views/UserProfile.vue',
      '/users/:id/settings src/views/UserList.vue',
      '/users/:id/settings src/views/UserSettings.vue',
    ]);
    const mcp = JSON.parse(((await client.callTool({ name: 'mapx_routes', arguments: { dir: root } })) as any).content[0].text) as Array<{ path: string; handlerFile: string }>;
    expect(mcp.map((r) => `${r.path} ${r.handlerFile}`).sort()).toEqual(records);
    const status = mapx(root, 'status');
    expect(status).toMatch(new RegExp(`\\n\\s+navigate\\s+${NAVIGATE.length}\\n`));
    expect(status).toMatch(new RegExp(`\\n\\s+route\\s+${edgesOf(root, 'route').length}\\n`));
  });
});

// ── M3-11: navigation from plain JS/TS modules ──────────────────────────────────────────────────

describe('moduleNavigationReferences (M3-11)', () => {
  it('owns each router call by the narrowest function or method; other push() calls give nothing', () => {
    const code = [
      "import router from '@/router';", // 1
      "import { useRouter } from 'vue-router';", // 2
      'export const useAuth = defineStore("auth", {', // 3
      '  actions: {', // 4
      '    logout() {', // 5
      "      this.items.push('/users');", // 6
      "      router.push({ name: 'login' });", // 7
      '    },', // 8
      '  },', // 9
      '});', // 10
      'export function useFlow() {', // 11
      '  const nav = useRouter();', // 12
      '  const queue = { push(x) { return x; } };', // 13
      '  function next() {', // 14
      "    queue.push('/a');", // 15
      "    nav.replace('/done');", // 16
      '  }', // 17
      '  return { next };', // 18
      '}', // 19
      "router.push('/top');", // 20
    ].join('\n');
    const symbols = [
      { name: 'useAuth', kind: 'constant', scope: null, startLine: 3, endLine: 10 },
      { name: 'logout', kind: 'method', scope: 'actions', startLine: 5, endLine: 8 },
      { name: 'useFlow', kind: 'function', scope: null, startLine: 11, endLine: 19 },
      { name: 'push', kind: 'method', scope: null, startLine: 13, endLine: 13 },
      { name: 'next', kind: 'function', scope: null, startLine: 14, endLine: 17 },
    ] as ExtractedSymbol[];
    expect(moduleNavigationReferences(code, symbols).map((r) => [r.sourceSymbol, r.targetName, r.startLine, r.referenceType])).toEqual([
      ['logout', 'login', 7, 'navigate'],
      ['next', '/done', 16, 'navigate'],
      [null, '/top', 20, 'navigate'],
    ]);
    expect(moduleNavigationReferences("const list = [];\nlist.push('/users');\n", [])).toEqual([]);
  });
});

const moduleFiles: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', private: true, dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0', pinia: '^2.1.0' } }),
  'src/router/index.js': [
    "import { createRouter, createWebHistory } from 'vue-router';",
    "import Home from '../views/Home.vue';",
    "import Login from '../views/Login.vue';",
    '',
    'const router = createRouter({',
    '  history: createWebHistory(),',
    '  routes: [',
    "    { path: '/', name: 'home', component: Home },",
    "    { path: '/login', name: 'login', component: Login },",
    "    { path: '/orders', name: 'orders', component: () => import('../views/Orders.vue') },",
    '  ],',
    '});',
    '',
    'function requireAuth(to) {',
    "  if (to.meta.auth && !localStorage.token) router.push({ name: 'login' });",
    '}',
    'router.beforeEach(requireAuth);',
    '',
    'export default router;',
    '',
  ].join('\n'),
  'src/stores/auth.js': [
    "import { defineStore } from 'pinia';",
    "import router from '../router';",
    '',
    "export const useAuthStore = defineStore('auth', {",
    '  state: () => ({ history: [] }),',
    '  actions: {',
    '    logout() {',
    "      this.history.push('/orders');",
    "      router.replace('/login');",
    '    },',
    '  },',
    '});',
    '',
  ].join('\n'),
  'src/composables/useOrders.ts': [
    "import { useRouter } from 'vue-router';",
    '',
    'export function useOrders() {',
    '  const router = useRouter();',
    '  const recent = { items: [] as string[], push(path: string) { this.items.push(path); } };',
    '  function openAll() {',
    "    recent.push('/orders');",
    "    router.push({ name: 'orders' });",
    '  }',
    '  return { openAll };',
    '}',
    '',
  ].join('\n'),
  'src/views/Home.vue': '<template>\n  <p>home</p>\n</template>\n',
  'src/views/Login.vue': '<template>\n  <p>login</p>\n</template>\n',
  'src/views/Orders.vue': '<template>\n  <p>orders</p>\n</template>\n',
};

describe('navigate edges from stores, guards and composables (M3-11, real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(moduleFiles);
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('links each router call to the route component, owned by its function, and nothing for other push() calls', () => {
    expect(edgesOf(root, 'navigate')).toEqual([
      { source_file: 'src/composables/useOrders.ts', source_symbol: 'openAll', target_file: 'src/views/Orders.vue', target_symbol: 'Orders' },
      { source_file: 'src/router/index.js', source_symbol: 'requireAuth', target_file: 'src/views/Login.vue', target_symbol: 'Login' },
      { source_file: 'src/stores/auth.js', source_symbol: 'logout', target_file: 'src/views/Login.vue', target_symbol: 'Login' },
    ]);
  });
});

// M3-12: route components imported through a configured alias resolve through the shared resolver
// (M3-09); the vue-router detector and the route table no longer guess `@/` → the nearest src/.
// Laravel layout: vite.config.js aliases `@` to resources/js; the resources/js/src/ files are traps
// for that guess.
describe('route components through a configured alias (M3-12)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'laravel-app', private: true, dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' } }),
      'vite.config.js': "import { defineConfig } from 'vite';\nexport default defineConfig({ resolve: { alias: { '@': '/resources/js' } } });\n",
      'resources/js/src/router/index.js': [
        "import { createRouter, createWebHistory } from 'vue-router';",
        "import Home from '@/Pages/Home.vue';",
        'export default createRouter({',
        '  history: createWebHistory(),',
        '  routes: [',
        "    { path: '/', name: 'home', component: Home },",
        "    { path: '/about', name: 'about', component: () => import('@/Pages/About.vue') },",
        // Not under resources/js: the alias decides, so the src/ copy is not a fallback.
        "    { path: '/gone', name: 'gone', component: () => import('@/Pages/Gone.vue') },",
        '  ],',
        '});',
        '',
      ].join('\n'),
      'resources/js/Pages/Home.vue': '<template>\n  <p>home</p>\n</template>\n',
      'resources/js/Pages/About.vue': '<template>\n  <p>about</p>\n</template>\n',
      'resources/js/Components/Nav.vue': [
        '<template>',
        "  <router-link :to=\"{ name: 'about' }\">About</router-link>",
        '</template>',
        '',
        '<script setup>',
        "import { useRouter } from 'vue-router';",
        'const router = useRouter();',
        'function home() {',
        "  router.push({ name: 'home' });",
        '}',
        '</script>',
        '',
      ].join('\n'),
      'resources/js/src/Pages/Home.vue': '<template>\n  <p>trap</p>\n</template>\n',
      'resources/js/src/Pages/About.vue': '<template>\n  <p>trap</p>\n</template>\n',
      'resources/js/src/Pages/Gone.vue': '<template>\n  <p>trap</p>\n</template>\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('gives route and navigate edges to the aliased components, not to the nearest src/', () => {
    const components = edgesOf(root, 'route').filter((e) => e.target_file.endsWith('.vue'));
    expect([...new Set(components.map((e) => `${e.source_file} -> ${e.target_file}#${e.target_symbol}`))].sort()).toEqual([
      'resources/js/src/router/index.js -> resources/js/Pages/About.vue#About',
      'resources/js/src/router/index.js -> resources/js/Pages/Home.vue#Home',
    ]);
    expect(edgesOf(root, 'navigate').map((e) => `${e.source_symbol} -> ${e.target_file}`)).toEqual([
      'Nav -> resources/js/Pages/About.vue',
      'home -> resources/js/Pages/Home.vue',
    ]);
  });
});

// M3-08-R1: a route table belongs to its app folder; a folder where vue-router is not active is
// never a navigate target.
describe('route tables stop at the app boundary (M3-08-R1)', () => {
  const router = (name: string, view: string) => [
    "import { createRouter, createWebHistory } from 'vue-router';",
    `import ${view} from '../views/${view}.vue';`,
    `export default createRouter({ history: createWebHistory(), routes: [{ path: '/${name}', name: '${name}', component: ${view} }] });`,
    '',
  ].join('\n');
  const nav = (name: string) => `<template>\n  <nav>\n    <router-link to="/${name}">go</router-link>\n    <button @click="$router.push({ name: '${name}' })">go</button>\n  </nav>\n</template>\n`;
  // An app is built: vite among its dev dependencies.
  const app = (dir: string, deps: Record<string, string>) => ({ [`${dir}/package.json`]: JSON.stringify({ name: dir.replace(/\//g, '-'), dependencies: deps, devDependencies: { vite: '^5.0.0' } }) });

  it('gives no navigate edge into another app folder, by name or by path, when the root package.json lists vue', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true, devDependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' } }),
      ...app('admin', { vue: '^3.4.0', 'vue-router': '^4.3.0' }),
      'admin/src/router/index.js': router('reports', 'Reports'),
      'admin/src/views/Reports.vue': '<template><p>reports</p></template>\n',
      'admin/src/Nav.vue': nav('reports'),
      // `npm init` writes `main`: still an app (review 2026-10-31).
      'shop/package.json': JSON.stringify({ name: 'shop', main: 'index.js', dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' }, devDependencies: { vite: '^5.0.0' } }),
      'shop/src/router/index.js': router('cart', 'Cart'),
      'shop/src/views/Cart.vue': '<template><p>cart</p></template>\n',
      'shop/src/Nav.vue': nav('reports'),
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      expect(edgesOf(root, 'navigate').map((e) => `${e.source_file} -> ${e.target_file}`)).toEqual([
        'admin/src/Nav.vue -> admin/src/views/Reports.vue',
        'admin/src/Nav.vue -> admin/src/views/Reports.vue',
      ]);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('never targets a folder where vue-router is not active (backend/ beside frontend/)', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true }),
      ...app('frontend', { vue: '^3.4.0', 'vue-router': '^4.3.0' }),
      'frontend/src/router/index.js': router('home', 'Home'),
      'frontend/src/views/Home.vue': '<template><p>home</p></template>\n',
      'frontend/src/Nav.vue': nav('home').replace('</nav>', `  <router-link to="/admin">admin</router-link>\n    <button @click="$router.push({ name: 'admin' })">admin</button>\n  </nav>`),
      'backend/tools/router/index.js': router('admin', 'AdminPanel'),
      'backend/tools/views/AdminPanel.vue': '<template><p>admin</p></template>\n',
      // Navigation inside backend/ itself: vue-router is active for frontend/ only.
      'backend/tools/Panel.vue': nav('admin'),
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const targets = edgesOf(root, 'navigate').map((e) => e.target_file);
      expect(targets).not.toContain('backend/tools/views/AdminPanel.vue');
      expect(targets).toContain('frontend/src/views/Home.vue');
    } finally {
      cleanup(root);
    }
  }, 120000);
});

// Final review 2026-10-31 (M3-08-R1): a package.json added or removed moves a router file or a JS
// navigator to another scope; sync re-parses the navigators, as scan --force has them.
describe('navigate edges follow a scope move on sync', () => {
  it('drops and restores navigate edges when an app manifest is added and removed', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true, dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' }, devDependencies: { vite: '^5.0.0' } }),
      '.gitignore': '.mapx/\n',
      'apps/a/src/router.js': "import { createRouter, createWebHistory } from 'vue-router';\nimport Home from './views/Home.vue';\nexport default createRouter({ history: createWebHistory(), routes: [{ path: '/home', name: 'home', component: Home }] });\n",
      'apps/a/src/views/Home.vue': '<template><p>home</p></template>\n',
      'apps/b/src/store.js': "import { useRouter } from 'vue-router';\nexport function goHome() {\n  const router = useRouter();\n  router.push({ name: 'home' });\n}\n",
      'apps/c/src/Nav.vue': '<template>\n  <nav>\n    <router-link to="/home">go</router-link>\n    <button @click="$router.push({ name: \'home\' })">go</button>\n  </nav>\n</template>\n',
    }, ['.']);
    const sources = () => edgesOf(root, 'navigate').map((e) => e.source_file).sort();
    const all = () => query<{ e: string }>(root, "SELECT source_file || '>' || target_file || '>' || edge_type AS e FROM edges ORDER BY e").map((r) => r.e);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
    try {
      git('add', '-A');
      git('commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      expect(sources()).toEqual(['apps/b/src/store.js', 'apps/c/src/Nav.vue', 'apps/c/src/Nav.vue']);
      // apps/b becomes its own app: its store no longer sees apps/a's routes.
      writeFileSync(join(root, 'apps/b/package.json'), JSON.stringify({ name: 'b', devDependencies: { vite: '^5.0.0' } }));
      mapx(root, 'sync', root);
      expect(sources()).toEqual(['apps/c/src/Nav.vue', 'apps/c/src/Nav.vue']);
      // apps/a becomes its own app: its router moves away from apps/c's navigation.
      writeFileSync(join(root, 'apps/a/package.json'), JSON.stringify({ name: 'a', devDependencies: { vite: '^5.0.0' } }));
      mapx(root, 'sync', root);
      expect(sources()).toEqual([]);
      const synced = all();
      mapx(root, 'scan', root, '--force');
      expect(all()).toEqual(synced);
      // And back.
      rmSync(join(root, 'apps/a/package.json'));
      rmSync(join(root, 'apps/b/package.json'));
      mapx(root, 'sync', root);
      expect(sources()).toEqual(['apps/b/src/store.js', 'apps/c/src/Nav.vue', 'apps/c/src/Nav.vue']);
    } finally {
      cleanup(root);
    }
  }, 120000);
});

// ── M3-11-R1: more navigation and route-table forms (review 2026-10-31, P2) ──────────────────────

type Brief = [string | null, string, number];
const brief = (refs: { sourceSymbol: string | null; targetName: string; startLine: number }[]): Brief[] =>
  refs.map((r) => [r.sourceSymbol, r.targetName, r.startLine]);

describe('more navigation forms (M3-11-R1)', () => {
  it('reads a push / replace destructured from the router, in script and in a script-setup template', () => {
    const sfc = [
      '<template>', // 1
      "  <button @click=\"router.push({ name: 'about' })\">a</button>", // 2
      "  <button @click=\"push('/about')\">b</button>", // 3
      "  <button @click=\"go('/home')\">c</button>", // 4
      "  <button @click=\"list.push('/no')\">d</button>", // 5
      '</template>', // 6
      '<script setup>', // 7
      "import { useRouter } from 'vue-router';", // 8
      'const router = useRouter();', // 9
      'const { push, replace: go } = useRouter();', // 10
      'const list = [];', // 11
      "function a() { push({ name: 'about' }); go('/home'); }", // 12
      "function b() { list.push('/no'); list. push('/no2'); }", // 13
      '</script>', // 14
    ].join('\n');
    expect(brief(navigationReferences(sfc))).toEqual([
      [null, 'about', 12], [null, '/home', 12], [null, 'about', 2], [null, '/about', 3], [null, '/home', 4],
    ]);
    // A plain <script>'s bindings are not the template's: nothing there is the router.
    const options = "<template>\n  <button @click=\"router.push('/about')\">a</button>\n</template>\n<script>\nimport { useRouter } from 'vue-router';\nconst router = useRouter();\nexport default {};\n</script>\n";
    expect(navigationReferences(options)).toEqual([]);
    // Something else's push, destructured, is not navigation.
    const other = "<script setup>\nimport { useHistory } from './history';\nconst { push } = useHistory();\nfunction a() { push('/about'); }\n</script>\n";
    expect(navigationReferences(other)).toEqual([]);
  });

  it('reads guard redirects: next(target) and a returned target, in the guard only', () => {
    const code = [
      "import { createRouter } from 'vue-router';", // 1
      'const router = createRouter({ routes: [', // 2
      "  { path: '/admin', component: Admin, beforeEnter: (to, from, next) => next('/login') },", // 3
      '] });', // 4
      'router.beforeEach((to, from, next) => {', // 5
      "  if (!auth) next({ name: 'login' });", // 6
      '  else next();', // 7
      '});', // 8
      'router.beforeEach(async (to) => {', // 9
      "  const crumbs = to.matched.map((r) => { return { name: 'crumb' }; });", // 10
      "  if (to.meta.admin) return { name: 'forbidden' };", // 11
      '  return true;', // 12
      '});', // 13
      'router.beforeResolve(checkRole);', // 14
      'function checkRole(to) {', // 15
      "  if (!to.meta.role) return '/no-role';", // 16
      '}', // 17
      'function breadcrumb() {', // 18
      "  return { name: 'orders' };", // 19
      '}', // 20
      'export function requireAuth(to, from, next) {', // 21
      "  api.check().then((ok) => (ok ? next() : next({ path: '/login' })));", // 22
      '}', // 23
      "export const audit = (req, res, next) => next('/audit');", // 24
      'export default router;', // 25
    ].join('\n');
    const symbols = [
      { name: 'checkRole', kind: 'function', scope: null, startLine: 15, endLine: 17 },
      { name: 'breadcrumb', kind: 'function', scope: null, startLine: 18, endLine: 20 },
      { name: 'requireAuth', kind: 'function', scope: null, startLine: 21, endLine: 23 },
      { name: 'audit', kind: 'function', scope: null, startLine: 24, endLine: 24 },
    ] as ExtractedSymbol[];
    expect(brief(moduleNavigationReferences(code, symbols)).sort((x, y) => x[2] - y[2])).toEqual([
      [null, '/login', 3],
      [null, 'login', 6],
      [null, 'forbidden', 11],
      ['checkRole', '/no-role', 16],
      ['requireAuth', '/login', 22],
    ]);
    // An in-component guard, and a guard file that never names the router.
    const sfc = "<script>\nexport default {\n  beforeRouteLeave(to, from, next) { next({ name: 'home' }); },\n  methods: { next() { return { name: 'x' }; } },\n};\n</script>\n";
    expect(brief(navigationReferences(sfc))).toEqual([[null, 'home', 3]]);
    expect(brief(moduleNavigationReferences("export function guest(to, from, next) {\n  next('/');\n}\n", []))).toEqual([[null, '/', 2]]);
    // The router passed in (or imported from './index'): beforeEach is its own method; a typed nested
    // function's return is not the guard's.
    const setup = [
      'export function setupGuards(appRouter) {', // 1
      '  appRouter.beforeEach((to) => {', // 2
      "    function fallback(): RouteLocationRaw { return { name: 'nested' }; }", // 3
      "    if (!to.meta.ok) return '/denied';", // 4
      '  });', // 5
      "  test.beforeEach(() => { return { name: 'not-a-guard' }; });", // 6
      '}', // 7
    ].join('\n');
    expect(brief(moduleNavigationReferences(setup, []))).toEqual([[null, '/denied', 4]]);
  });

  it('reads this.router.push in a Pinia store (the router added by a store plugin), nowhere else', () => {
    const store = "import { defineStore } from 'pinia';\nexport const useAuth = defineStore('auth', {\n  actions: {\n    logout() { this.router.push({ name: 'login' }); },\n  },\n});\n";
    const symbols = [{ name: 'logout', kind: 'method', scope: null, startLine: 4, endLine: 4 }] as ExtractedSymbol[];
    expect(brief(moduleNavigationReferences(store, symbols))).toEqual([['logout', 'login', 4]]);
    expect(moduleNavigationReferences("export class Shell {\n  open() { this.router.push('/login'); }\n}\n", [])).toEqual([]);
  });
});

describe('route modules (M3-11-R1)', () => {
  it('reads a route module exported as export default [ … ] (also typed), and no other default array', () => {
    const module = "import Reports from '../views/Reports.vue';\nexport default [\n  { path: '/admin/reports', name: 'admin-reports', component: Reports },\n  { path: '/admin/users', name: 'admin-users', component: () => import('../views/Users.vue') },\n];\n";
    expect(mayDefineRoutes(module)).toBe(true);
    expect(routeRecords(module).map((r) => [r.name, r.path, r.component])).toEqual([
      ['admin-reports', '/admin/reports', '../views/Reports.vue'],
      ['admin-users', '/admin/users', '../views/Users.vue'],
    ]);
    const typed = "import type { RouteRecordRaw } from 'vue-router';\nexport default <RouteRecordRaw[]>[{ path: '/a', name: 'a', component: () => import('./A.vue') }];\n";
    expect(routeRecords(typed).map((r) => r.name)).toEqual(['a']);
    const satisfies = "export default [{ path: '/b', name: 'b', component: () => import('./B.vue') }] satisfies RouteRecordRaw[];\n";
    expect(routeRecords(satisfies).map((r) => r.name)).toEqual(['b']);
    // A menu, not routes: no record has a component.
    expect(routeRecords("export default [\n  { path: '/admin', title: 'Admin', icon: 'cog' },\n];\n")).toEqual([]);
    // Children written for a parent in another file: their full path is unknown, so they are left out.
    expect(routeRecords("export default [{ path: 'users', name: 'admin-users', component: () => import('./U.vue') }];\n")).toEqual([]);
  });
});

describe('<script setup generic> (M3-11-R1)', () => {
  it('reads a script setup block whose generic attribute holds `>`, as without it', async () => {
    const sfc = (attrs: string) => [
      '<template>',
      '  <Child @click="go" />',
      '</template>',
      `<script setup lang="ts"${attrs}>`,
      "import { useRouter } from 'vue-router';",
      "import Child from './Child.vue';",
      'const router = useRouter();',
      "function go() { router.push({ name: 'about' }); }",
      '</script>',
      '',
    ].join('\n');
    const generic = sfc(' generic="T extends Record<string, unknown>, U extends Array<T>"');
    expect(navigationReferences(generic).map((r) => [r.targetName, r.startLine])).toEqual([['about', 8]]);
    const parser = new VueParser(getBuiltinLanguages().vue);
    const plain = await parser.parse('src/Generic.vue', sfc(''));
    expect(plain.symbols.find((s) => s.name === 'go')?.startLine).toBe(8);
    expect(plain.references.find((r) => r.referenceType === 'navigate')?.sourceSymbol).toBe('go');
    expect(await parser.parse('src/Generic.vue', generic)).toEqual(plain);
  });
});

// The forms above in a real scan: each links to the record it names, from its own function, and a
// route module spread into the routes array is part of the route table.
describe('more navigation forms in a real scan (M3-11-R1)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'desk', private: true, dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0', pinia: '^2.1.0' } }),
      'src/router/index.ts': [
        "import { createRouter, createWebHistory } from 'vue-router';",
        "import adminRoutes from './admin';",
        "import Home from '../views/Home.vue';",
        "import Login from '../views/Login.vue';",
        'const router = createRouter({',
        '  history: createWebHistory(),',
        '  routes: [',
        "    { path: '/', name: 'home', component: Home },",
        "    { path: '/login', name: 'login', component: Login },",
        '    ...adminRoutes,',
        '  ],',
        '});',
        'function guardAdmin(to) {',
        "  if (to.path.startsWith('/admin') && !localStorage.admin) return { name: 'login' };",
        '}',
        'function crumbs() {',
        "  return { name: 'reports' };",
        '}',
        'router.beforeEach(guardAdmin);',
        'export default router;',
        '',
      ].join('\n'),
      'src/router/admin.ts': "export default [\n  { path: '/admin/reports', name: 'reports', component: () => import('../views/Reports.vue') },\n];\n",
      'src/router/guards.ts': "export function requireLogin(to, from, next) {\n  if (!localStorage.token) next({ name: 'login' });\n  else next();\n}\n",
      'src/stores/session.ts': "import { defineStore } from 'pinia';\nexport const useSession = defineStore('session', {\n  actions: {\n    expire() { this.router.push('/login'); },\n  },\n});\n",
      'src/components/Toolbar.vue': [
        '<template>',
        "  <button @click=\"router.push('/admin/reports')\">reports</button>",
        '</template>',
        '<script setup lang="ts" generic="T extends Record<string, unknown>">',
        "import { useRouter } from 'vue-router';",
        'const router = useRouter();',
        'const { push } = useRouter();',
        'const seen: string[] = [];',
        'function goHome() {',
        "  push({ name: 'home' });",
        "  seen.push('/login');",
        '}',
        '</script>',
        '',
      ].join('\n'),
      'src/views/Home.vue': '<template>\n  <p>home</p>\n</template>\n',
      'src/views/Login.vue': '<template>\n  <p>login</p>\n</template>\n',
      'src/views/Reports.vue': '<template>\n  <p>reports</p>\n</template>\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('gives the navigate edge of each form to the exact record, and nothing else', () => {
    expect(edgesOf(root, 'navigate').map((e) => `${e.source_file}#${e.source_symbol} -> ${e.target_file}`)).toEqual([
      'src/components/Toolbar.vue#Toolbar -> src/views/Reports.vue',
      'src/components/Toolbar.vue#goHome -> src/views/Home.vue',
      'src/router/guards.ts#requireLogin -> src/views/Login.vue',
      'src/router/index.ts#guardAdmin -> src/views/Login.vue',
      'src/stores/session.ts#expire -> src/views/Login.vue',
    ]);
  });
});

// Review 2026-11-01 (M3-11-R1): an `export default [ { path, component } ]` that no router imports
// (a sidebar menu config) is no route table.
describe('route modules are the ones a router imports', () => {
  it('links a router-link to the routed view, never to a menu config\'s icon component', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' }, devDependencies: { vite: '^5.0.0' } }),
      'src/router/index.js': "import { createRouter, createWebHistory } from 'vue-router';\nimport SettingsView from '../views/SettingsView.vue';\nimport adminRoutes from './admin.js';\nexport default createRouter({ history: createWebHistory(), routes: [{ path: '/settings', component: SettingsView }, ...adminRoutes] });\n",
      'src/router/admin.js': "import Reports from '../views/Reports.vue';\nexport default [{ path: '/reports', name: 'reports', component: Reports }];\n",
      'src/views/SettingsView.vue': '<template><p>settings</p></template>\n',
      'src/views/Reports.vue': '<template><p>reports</p></template>\n',
      'src/components/sidebar/menu.js': "import GearIcon from './icons/GearIcon.vue';\nimport ChartIcon from './icons/ChartIcon.vue';\nexport default [{ path: '/settings', label: 'Settings', component: GearIcon }, { path: '/reports', component: ChartIcon }];\n",
      'src/components/sidebar/icons/GearIcon.vue': '<template><i /></template>\n',
      'src/components/sidebar/icons/ChartIcon.vue': '<template><i /></template>\n',
      'src/components/sidebar/SideBar.vue': '<template>\n  <nav>\n    <router-link to="/settings">s</router-link>\n    <router-link to="/reports">r</router-link>\n  </nav>\n</template>\n',
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      expect(edgesOf(root, 'navigate').map((e) => `${e.source_file} -> ${e.target_file}`)).toEqual([
        'src/components/sidebar/SideBar.vue -> src/views/Reports.vue',
        'src/components/sidebar/SideBar.vue -> src/views/SettingsView.vue',
      ]);
    } finally {
      cleanup(root);
    }
  }, 120000);
});
