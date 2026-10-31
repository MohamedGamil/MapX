import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ScanContext } from '../src/types.js';
import {
  matchRoute, navigationReferences, navTarget, routeRecords, withSrcAlias, type ResolvedRoute,
} from '../src/parsers/languages/vue-navigation.js';
import { VueRouterDetector } from '../src/frameworks/detectors/vue-router.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M3-06: Vue Router navigation (edge contract rule 9 in docs/baton/iterations/M3-01.md). The
// labelled yardstick is tests/fixtures/vue-sfc (patterns `router` and `router-record`); these tests
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

describe('withSrcAlias', () => {
  const files = new Set(['frontend/src/views/Home.vue', 'src/views/Home.vue']);
  const resolve = withSrcAlias((spec) => (files.has(spec) ? spec : null));
  it('maps @/ to the nearest src/ folder above the importing file', () => {
    expect(resolve('@/views/Home.vue', 'frontend/src/router/index.js')).toBe('frontend/src/views/Home.vue');
    expect(resolve('@/views/Home.vue', 'src/router/index.js')).toBe('src/views/Home.vue');
    expect(resolve('@/views/Home.vue', 'lib/router.js')).toBeNull();
    expect(resolve('~/views/Home.vue', 'src/router/index.js')).toBeNull();
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
