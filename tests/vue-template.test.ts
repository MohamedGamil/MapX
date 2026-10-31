import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ExtractedReference, ExtractedSymbol } from '../src/types.js';
import {
  assignOwners, componentSymbol, globalRegistrations, templateReferences,
} from '../src/parsers/languages/vue-template.js';
import { analyzeOptionsComponent } from '../src/parsers/languages/vue-options.js';
import { VueParser } from '../src/parsers/languages/vue.js';
import { getBuiltinLanguages } from '../src/languages/registry.js';
import { changedRoutes, navigatesTo, type NavTarget, type StoredRoute } from '../src/parsers/languages/vue-navigation.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M3-02: Vue template pass (edge contract rules 1, 2, 4 and 5 in docs/baton/iterations/M3-01.md).
// The labelled yardstick is tests/fixtures/vue-sfc (tests/vue-sfc.test.ts); these tests pin the
// module's behaviour and the cases the fixture does not cover (aliases, auto-registration, fail closed).

const brief = (refs: ExtractedReference[]) => refs.map((r) => ({
  type: r.referenceType, source: r.sourceSymbol, target: r.targetName, line: r.startLine, vue: r.metadata?.vue,
}));

describe('componentSymbol (rule 1)', () => {
  it('names the component after the file and spans the whole file', () => {
    const sym = componentSymbol('src/components/TicketRow.vue', '<template>\n  <tr />\n</template>\n');
    expect(sym).toMatchObject({ name: 'TicketRow', kind: 'class', scope: null, startLine: 1, endLine: 4, metadata: {} });
  });
});

describe('templateReferences (rules 4 and 5)', () => {
  const sfc = `<template>
  <form @submit.prevent="save" :title="label(item)">
    <!-- <legacy-banner /> -->
    <price-tag v-model="amount" @changed="onChanged" />
    <PriceTag />
    <button v-on:click.native="go(1)" @keyup="$emit('x')" :class="cart.total()">{{ format(total) }} {{ total }}</button>
    <base-icon name="x" />
    <router-link to="/x" />
    <template v-if="ok"><li v-for="n in range(count)" :key="n">{{ n }}</li></template>
    <span @click="track('a')">{{ persistNow() }}</span>
  </form>
</template>

<script>
import PriceTag from './PriceTag.vue';
import LegacyBanner from './LegacyBanner.vue';
import trackable from '../mixins/trackable';
import { usePrefs } from '../composables/usePrefs';

export default {
  components: { PriceTag, LegacyBanner },
  mixins: [trackable],
  setup() {
    const { format, persist: persistNow } = usePrefs();
    return { format, persistNow };
  },
};
</script>
`;
  let refs: ExtractedReference[];
  beforeAll(async () => {
    const options = await analyzeOptionsComponent(sfc.slice(sfc.indexOf('<script>') + 8, sfc.indexOf('</script>')));
    refs = templateReferences(sfc, 'Form', options);
  });

  it('gives call references from the component for handlers, bindings and interpolations', () => {
    const calls = brief(refs.filter((r) => r.referenceType === 'call'));
    const own = { sameFile: true };
    expect(calls).toEqual([
      { type: 'call', source: 'Form', target: 'save', line: 2, vue: own },
      { type: 'call', source: 'Form', target: 'label', line: 2, vue: own },
      { type: 'call', source: 'Form', target: 'onChanged', line: 4, vue: own },
      { type: 'call', source: 'Form', target: 'go', line: 6, vue: own },
      { type: 'call', source: 'Form', target: 'format', line: 6, vue: { sameFile: true, from: [{ specifier: '../composables/usePrefs', name: 'format' }] } },
      { type: 'call', source: 'Form', target: 'range', line: 9, vue: own },
      { type: 'call', source: 'Form', target: 'track', line: 10, vue: own },
      // A renamed destructuring targets the composable's own name.
      { type: 'call', source: 'Form', target: 'persistNow', line: 10, vue: { sameFile: true, from: [{ specifier: '../composables/usePrefs', name: 'persist' }] } },
    ]);
  });

  it('gives Options API template calls the this.x() scope (mixins, map helpers)', () => {
    const track = refs.find((r) => r.targetName === 'track')!;
    expect(track.vueThis).toEqual({ own: false, mixins: ['../mixins/trackable'] });
    expect(templateReferences(sfc, 'Form').every((r) => r.vueThis === undefined)).toBe(true);
  });

  it('gives one render reference per registered child, global hints for the rest, nothing for comments and built-ins', () => {
    expect(brief(refs.filter((r) => r.referenceType === 'render'))).toEqual([
      { type: 'render', source: 'Form', target: 'PriceTag', line: 4, vue: { from: [{ specifier: './PriceTag.vue', name: 'PriceTag' }] } },
      { type: 'render', source: 'Form', target: 'BaseIcon', line: 7, vue: { global: true } },
    ]);
  });

  it('exposes <script setup> imports to the template and resolves aliased registrations', () => {
    const setup = `<template>
  <Card @click="formatDate(now)" /><fancy-list />
</template>
<script setup>
import Card from './Card.vue';
import { formatDate as fmt, formatDate } from '@/utils/date';
</script>
<script>
import FancyListImpl from './FancyList.vue';
export default { components: { 'fancy-list': FancyListImpl } };
</script>
`;
    expect(brief(templateReferences(setup, 'Page'))).toEqual([
      { type: 'render', source: 'Page', target: 'Card', line: 2, vue: { from: [{ specifier: './Card.vue', name: 'Card' }] } },
      { type: 'call', source: 'Page', target: 'formatDate', line: 2, vue: { sameFile: true, from: [{ specifier: '@/utils/date', name: 'formatDate' }] } },
      { type: 'render', source: 'Page', target: 'FancyList', line: 2, vue: { from: [{ specifier: './FancyList.vue', name: 'FancyList' }] } },
    ]);
  });

  it('ignores SFCs without an HTML template', () => {
    expect(templateReferences('<script>export default {}</script>', 'X')).toEqual([]);
    expect(templateReferences('<template lang="pug">\ndiv(@click="save")\n</template>', 'X')).toEqual([]);
  });
});

describe('assignOwners (rule 2)', () => {
  const S = (name: string, kind: ExtractedSymbol['kind'], startLine: number, endLine: number): ExtractedSymbol =>
    ({ name, kind, scope: null, signature: '', startLine, endLine, metadata: {} });
  const R = (startLine: number, sourceSymbol: string | null = null): ExtractedReference =>
    ({ sourceSymbol, targetName: 'x', referenceType: 'call', startLine });

  it('gives top-level, value-declaration and setup() code to the component, member code to the member', () => {
    const component = S('Panel', 'class', 1, 40);
    const symbols = [component, S('prefs', 'constant', 10, 10), S('setup', 'method', 12, 20), S('save', 'function', 14, 16), S('load', 'method', 22, 24)];
    const refs = [R(5), R(10), R(13), R(15), R(23), R(30, 'kept')];
    assignOwners(refs, symbols, component);
    expect(refs.map((r) => r.sourceSymbol)).toEqual(['Panel', 'Panel', 'Panel', 'save', 'load', 'kept']);
  });
});

describe('globalRegistrations', () => {
  it('follows the registered value through its import, require() or import()', () => {
    const main = `import Vue from 'vue';
import BaseIcon from './components/BaseIcon.vue';
import { Modal } from './components';
// Vue.component('Commented', Commented);
Vue.component('base-icon', BaseIcon);
Vue.component('Modal', Modal);
Vue.component('example-component', require('./components/ExampleComponent.vue').default);
app.component('LazyChart', defineAsyncComponent(() => import('./components/Chart.vue')));
`;
    expect(globalRegistrations(main)).toEqual({
      named: [
        { name: 'BaseIcon', specifier: './components/BaseIcon.vue' },
        { name: 'Modal', specifier: './components' },
        { name: 'ExampleComponent', specifier: './components/ExampleComponent.vue' },
        { name: 'LazyChart', specifier: './components/Chart.vue' },
      ],
      globs: [],
    });
  });

  it('reads require.context and import.meta.glob auto-registration, but not when commented out', () => {
    const laravel = `const files = require.context('./components', true, /\\.vue$/i);
files.keys().map(key => Vue.component(key.split('/').pop().split('.')[0], files(key).default));
`;
    expect(globalRegistrations(laravel).globs).toEqual([{ dir: './components', deep: true }]);
    expect(globalRegistrations(`// ${laravel.split('\n').join('\n// ')}`).globs).toEqual([]);
    const vite = `const modules = import.meta.glob('./widgets/*.vue', { eager: true });
for (const [path, mod] of Object.entries(modules)) app.component(path.split('/').pop().replace('.vue', ''), mod.default);
`;
    expect(globalRegistrations(vite).globs).toEqual([{ dir: './widgets', deep: false }]);
    // A glob without a computed `.component()` name registers nothing.
    expect(globalRegistrations(`const m = import.meta.glob('./pages/**/*.vue');`).globs).toEqual([]);
  });
});

describe('VueParser', () => {
  it('adds the component symbol, template references and owners in one parse', async () => {
    const parser = new VueParser(getBuiltinLanguages().vue);
    const res = await parser.parse('src/Panel.vue', `<template>
  <button @click="save">Save</button>
</template>

<script setup>
import { usePrefs } from './usePrefs';
const prefs = usePrefs();
function save() { prefs.persist(); }
</script>
`);
    expect(res.symbols.find((s) => s.kind === 'class')).toMatchObject({ name: 'Panel', startLine: 1, endLine: 10 });
    expect(res.references.filter((r) => r.referenceType === 'call').map((r) => [r.sourceSymbol, r.targetName]))
      .toEqual(expect.arrayContaining([['Panel', 'save'], ['Panel', 'usePrefs']]));
  });
});

describe('template edges on a real scan', () => {
  let root: string;
  type Edge = { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string; edge_type: string };
  let edges: string[];
  const key = (e: Edge) => `${e.source_file}#${e.source_symbol} -${e.edge_type}-> ${e.target_file}#${e.target_symbol}`;

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^2.7.16' } }),
      'src/main.js': `import Vue from 'vue';
import BaseIcon from './components/BaseIcon.vue';
import App from './App.vue';
import './plugins/widgets';
Vue.component('icon', BaseIcon);
new Vue({ render: (h) => h(App) }).$mount('#app');
`,
      'src/plugins/widgets.js': `import Vue from 'vue';
const files = require.context('../widgets', false, /\\.vue$/);
files.keys().forEach((key) => Vue.component(key.split('/').pop().split('.')[0], files(key).default));
`,
      'src/App.vue': `<template>
  <div>
    <icon name="bell" />
    <stat-card :value="count" />
    <card @click="track('open')" />
    <Unregistered />
    <button @click="refresh">{{ formatDate(now) }}</button>
  </div>
</template>

<script>
import FancyCard from './components/FancyCard.vue';
import trackable from './mixins/trackable';

export default {
  components: { Card: FancyCard },
  mixins: [trackable],
  methods: {
    formatDate(d) { return String(d); },
  },
};
</script>
`,
      'src/components/BaseIcon.vue': '<template><i /></template>\n',
      'src/components/FancyCard.vue': '<template><div /></template>\n',
      'src/components/Unregistered.vue': '<template><div /></template>\n',
      'src/widgets/StatCard.vue': '<template><b /></template>\n',
      'src/mixins/trackable.js': 'export default { methods: { track(event) { return event; } } };\n',
      // Same names in files the component does not use: never targets.
      'src/mixins/unused.js': 'export default { methods: { refresh() {}, track() {} } };\n',
    });
    init(root);
    mapx(root, 'scan', root);
    edges = query<Edge>(root, `SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges
      WHERE edge_type IN ('call', 'render') AND source_file = 'src/App.vue'`).map(key);
  }, 120000);

  afterAll(() => cleanup(root));

  it('resolves aliased local, aliased global and auto-registered components', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'src/App.vue#App -render-> src/components/BaseIcon.vue#BaseIcon',
      'src/App.vue#App -render-> src/widgets/StatCard.vue#StatCard',
      'src/App.vue#App -render-> src/components/FancyCard.vue#FancyCard',
    ]));
  });

  it('resolves template calls to own members and to mixins the component uses, and nothing else', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'src/App.vue#App -call-> src/App.vue#formatDate',
      'src/App.vue#App -call-> src/mixins/trackable.js#track',
    ]));
    expect(edges.filter((e) => /Unregistered|unused\.js|#refresh/.test(e))).toEqual([]);
    expect(query(root, `SELECT name, kind FROM symbols WHERE file_path = 'src/App.vue' AND kind = 'class'`)).toEqual([{ name: 'App', kind: 'class' }]);
  });
});

// M3-08: the global registry follows registration edits on sync, and is per manifest folder.
describe('global registry on sync and per app (M3-08)', () => {
  type Row = { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string; edge_type: string };
  const key = (e: Row) => `${e.source_file}#${e.source_symbol} -${e.edge_type}-> ${e.target_file}#${e.target_symbol}`;
  const renders = (root: string) => query<Row>(root, `SELECT * FROM edges WHERE edge_type = 'render'`).map(key).sort();
  const snapshot = (root: string) => query<Row>(root, 'SELECT * FROM edges').map(key).sort();
  const ids = (root: string, file: string) => query<{ id: number }>(root, 'SELECT id FROM symbols WHERE file_path = ? ORDER BY id', file).map((r) => r.id);
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });

  const main = (userCard: boolean) => `import { createApp } from 'vue';
import App from './App.vue';
import BaseIcon from './components/BaseIcon.vue';
${userCard ? "import UserCard from './components/UserCard.vue';\n" : ''}import { registerWidgets } from './plugins/widgets';

const app = createApp(App);
app.component('BaseIcon', BaseIcon);
${userCard ? "app.component('UserCard', UserCard);\n" : ''}registerWidgets(app);
app.mount('#app');
`;

  it.each([['without git', false], ['with git', true]])(
    'adds and removes the render edges of unchanged components using the tag, as scan --force (%s)',
    (_, useGit) => {
      const root = workspace({
        'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } }),
        '.gitignore': '.mapx/\n',
        'src/main.js': main(false),
        'src/plugins/widgets.js': `export function registerWidgets(app) {
  const modules = import.meta.glob('../widgets/*.vue', { eager: true });
  for (const [path, mod] of Object.entries(modules)) app.component(path.split('/').pop().replace('.vue', ''), mod.default);
}
`,
        'src/App.vue': '<template>\n  <div><base-icon /><user-card /><new-widget /></div>\n</template>\n',
        'src/views/Other.vue': '<template>\n  <section><UserCard :id="1" /></section>\n</template>\n',
        'src/views/Plain.vue': '<template>\n  <p>plain</p>\n</template>\n',
        'src/components/BaseIcon.vue': '<template><i /></template>\n',
        'src/components/UserCard.vue': '<template><div /></template>\n',
        'src/widgets/OldWidget.vue': '<template><b /></template>\n',
      }, useGit ? [''] : []);
      // With git, each edit is committed: sync diffs against the last scanned commit.
      const commit = () => { if (useGit) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'edit'); } };
      const edit = (path: string, text: string) => { writeFileSync(join(root, path), text); commit(); };
      try {
        commit();
        init(root);
        mapx(root, 'scan', root);
        expect(renders(root)).toEqual(['src/App.vue#App -render-> src/components/BaseIcon.vue#BaseIcon']);
        const plain = ids(root, 'src/views/Plain.vue');
        expect(plain).toHaveLength(1);

        // Registration added in main.js only: both users gain the edge; Plain.vue is not re-parsed.
        edit('src/main.js', main(true));
        mapx(root, 'sync', root);
        expect(renders(root)).toEqual([
          'src/App.vue#App -render-> src/components/BaseIcon.vue#BaseIcon',
          'src/App.vue#App -render-> src/components/UserCard.vue#UserCard',
          'src/views/Other.vue#Other -render-> src/components/UserCard.vue#UserCard',
        ]);
        expect(ids(root, 'src/views/Plain.vue')).toEqual(plain);
        let synced = snapshot(root);
        mapx(root, 'scan', root, '--force');
        expect(snapshot(root)).toEqual(synced);

        // A .vue file added under an auto-registered folder: the component already using its tag.
        edit('src/widgets/NewWidget.vue', '<template><em /></template>\n');
        mapx(root, 'sync', root);
        expect(renders(root)).toContain('src/App.vue#App -render-> src/widgets/NewWidget.vue#NewWidget');
        synced = snapshot(root);
        mapx(root, 'scan', root, '--force');
        expect(snapshot(root)).toEqual(synced);

        // Registration removed again: the edges go, as with a forced scan.
        const before = ids(root, 'src/views/Plain.vue');
        edit('src/main.js', main(false));
        mapx(root, 'sync', root);
        expect(renders(root)).toEqual([
          'src/App.vue#App -render-> src/components/BaseIcon.vue#BaseIcon',
          'src/App.vue#App -render-> src/widgets/NewWidget.vue#NewWidget',
        ]);
        expect(ids(root, 'src/views/Plain.vue')).toEqual(before);
        synced = snapshot(root);
        mapx(root, 'scan', root, '--force');
        expect(snapshot(root)).toEqual(synced);
      } finally {
        cleanup(root);
      }
    },
    180000,
  );

  const router = (renamed: boolean) => `import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import UserView from '../views/UserView.vue';
import ProfileView from '../views/ProfileView.vue';

const routes = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/users/:id', name: '${renamed ? 'profile' : 'user'}', component: ${renamed ? 'ProfileView' : 'UserView'} },
];

export default createRouter({ history: createWebHistory(), routes });
`;

  it.each([['without git', false], ['with git', true]])(
    'updates the navigate edges of unchanged callers when a route is renamed or re-targeted, as scan --force (%s)',
    (_, useGit) => {
      const root = workspace({
        'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' } }),
        '.gitignore': '.mapx/\n',
        'src/router/index.js': router(false),
        'src/components/Nav.vue': `<template>
  <nav>
    <router-link :to="{ name: 'profile' }">Profile</router-link>
    <router-link to="/users/1">First user</router-link>
    <router-link to="/">Home</router-link>
  </nav>
</template>
`,
        'src/components/Card.vue': `<template>
  <div @click="open" />
</template>

<script>
export default {
  methods: {
    open() { this.$router.push({ name: 'user', params: { id: 1 } }); },
  },
};
</script>
`,
        'src/components/Plain.vue': '<template>\n  <p>plain</p>\n</template>\n',
        // A store navigates too (M3-11); a module without navigation is not re-parsed.
        'src/stores/session.js': "import router from '../router';\n\nexport function logout() {\n  router.push({ name: 'profile', params: { id: 1 } });\n}\n",
        'src/utils/format.js': 'export function format(v) {\n  return String(v);\n}\n',
        'src/views/HomeView.vue': '<template><main /></template>\n',
        'src/views/UserView.vue': '<template><main /></template>\n',
        'src/views/ProfileView.vue': '<template><main /></template>\n',
      }, useGit ? [''] : []);
      const navigates = () => query<Row>(root, `SELECT * FROM edges WHERE edge_type = 'navigate'`).map(key).sort();
      const commit = () => { if (useGit) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'edit'); } };
      try {
        commit();
        init(root);
        mapx(root, 'scan', root);
        expect(navigates()).toEqual([
          'src/components/Card.vue#open -navigate-> src/views/UserView.vue#UserView',
          'src/components/Nav.vue#Nav -navigate-> src/views/HomeView.vue#HomeView',
          'src/components/Nav.vue#Nav -navigate-> src/views/UserView.vue#UserView',
        ]);
        const plain = ids(root, 'src/components/Plain.vue');
        const format = ids(root, 'src/utils/format.js');

        // The router file alone: route `user` renamed `profile`, its component now ProfileView.
        writeFileSync(join(root, 'src/router/index.js'), router(true));
        commit();
        mapx(root, 'sync', root);
        // Nav's and the store's `{ name: 'profile' }` now resolve and `/users/1` reaches the new
        // component; Card's `{ name: 'user' }` no longer names a route.
        expect(navigates()).toEqual([
          'src/components/Nav.vue#Nav -navigate-> src/views/HomeView.vue#HomeView',
          'src/components/Nav.vue#Nav -navigate-> src/views/ProfileView.vue#ProfileView',
          'src/components/Nav.vue#Nav -navigate-> src/views/ProfileView.vue#ProfileView',
          'src/stores/session.js#logout -navigate-> src/views/ProfileView.vue#ProfileView',
        ]);
        expect(ids(root, 'src/components/Plain.vue')).toEqual(plain);
        expect(ids(root, 'src/utils/format.js')).toEqual(format);
        const synced = snapshot(root);
        mapx(root, 'scan', root, '--force');
        expect(snapshot(root)).toEqual(synced);
      } finally {
        cleanup(root);
      }
    },
    180000,
  );

  it('finds the changed route records, the redirects reaching them, and the SFCs navigating there', () => {
    const r = (path: string, name: string | null, component: string | null, redirect: NavTarget | null = null): StoredRoute =>
      ({ path, name, component, redirect, parent: false });
    const before = {
      'src/router/index.js': [r('/', 'home', './Home.vue'), r('/users/:id', 'user', './User.vue'), r('/me', null, null, { name: 'user' })],
      'src/router/admin.js': [r('/admin', 'admin', './Admin.vue')],
    };
    const after = {
      ...before,
      'src/router/index.js': [r('/', 'home', './Home.vue'), r('/users/:id', 'user', './Profile.vue'), r('/me', null, null, { name: 'user' })],
    };
    // The re-targeted record, and the redirect-only `/me` that reaches it; nothing unchanged.
    const changed = changedRoutes(before, after);
    expect(changed.map((c) => `${c.path} ${c.component}`).sort()).toEqual(['/me null', '/users/:id ./Profile.vue', '/users/:id ./User.vue']);
    expect(changedRoutes(before, before)).toEqual([]);
    const sfc = (to: string) => `<template>\n  <router-link ${to}>x</router-link>\n</template>\n`;
    expect(navigatesTo('src/X.vue', sfc(`:to="{ name: 'user' }"`), changed)).toBe(true);
    expect(navigatesTo('src/X.vue', sfc('to="/users/7"'), changed)).toBe(true);
    expect(navigatesTo('src/X.vue', sfc('to="/me"'), changed)).toBe(true);
    expect(navigatesTo('src/X.vue', sfc('to="/admin"'), changed)).toBe(false);
    expect(navigatesTo('src/X.vue', sfc(`:to="{ name: 'home' }"`), changed)).toBe(false);
    // A store or guard module (M3-11).
    const store = (target: string) => `import router from '../router';\nexport function go() { router.push(${target}); }\n`;
    expect(navigatesTo('src/stores/session.js', store(`{ name: 'user' }`), changed)).toBe(true);
    expect(navigatesTo('src/stores/session.js', store(`'/admin'`), changed)).toBe(false);
  });

  // M3-08-R1: the app boundary holds whatever the root package.json lists.
  it.each([
    ['vue in the root devDependencies', { devDependencies: { vue: '^3.4.0' } }],
    ['only vue-router in the root', { dependencies: { 'vue-router': '^4.3.0' } }],
  ])('keeps one registry per app folder when the root package.json lists %s, also after sync', (_, rootDeps) => {
    const app = (name: string, registrations: string) => ({
      [`apps/${name}/package.json`]: JSON.stringify({ name, dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
      [`apps/${name}/src/main.js`]: `import { createApp } from 'vue';
import App from './App.vue';
import Shared from './components/Shared.vue';
import OnlyA from './components/OnlyA.vue';
const app = createApp(App);
${registrations}app.mount('#app');
`,
      [`apps/${name}/src/App.vue`]: '<template>\n  <div><shared /><only-a /></div>\n</template>\n',
      [`apps/${name}/src/components/Shared.vue`]: '<template><i /></template>\n',
      [`apps/${name}/src/components/OnlyA.vue`]: '<template><b /></template>\n',
    });
    const root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true, ...rootDeps }),
      '.gitignore': '.mapx/\n',
      ...app('a', "app.component('Shared', Shared);\napp.component('OnlyA', OnlyA);\n"),
      ...app('b', "app.component('Shared', Shared);\n"),
    }, ['.']);
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      const expected = [
        'apps/a/src/App.vue#App -render-> apps/a/src/components/OnlyA.vue#OnlyA',
        'apps/a/src/App.vue#App -render-> apps/a/src/components/Shared.vue#Shared',
        'apps/b/src/App.vue#App -render-> apps/b/src/components/Shared.vue#Shared',
      ];
      expect(renders(root)).toEqual(expected);
      // A sync after app B's entry changes keeps the boundary, as scan --force does.
      writeFileSync(join(root, 'apps/b/src/main.js'), app('b', "app.component('Shared', Shared);\n")['apps/b/src/main.js']!.replace('#app', '#root'));
      mapx(root, 'sync', root);
      expect(renders(root)).toEqual(expected);
      const synced = snapshot(root);
      mapx(root, 'scan', root, '--force');
      expect(snapshot(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('lets the same registration win after a fresh index and after any sync history when two files register one name', () => {
    const plugin = (n: number) => `import Btn from '../components/BtnB.vue';\nexport function install(app) { app.component('Btn', Btn); }\n// ${n}\n`;
    const root = workspace({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } }),
      '.gitignore': '.mapx/\n',
      'src/main.js': "import { createApp } from 'vue';\nimport App from './App.vue';\nimport Btn from './components/BtnA.vue';\nimport { install } from './plugins/z.js';\nconst app = createApp(App);\napp.component('Btn', Btn);\ninstall(app);\n",
      'src/plugins/z.js': plugin(0),
      'src/App.vue': '<template>\n  <btn />\n</template>\n',
      'src/components/BtnA.vue': '<template><i /></template>\n',
      'src/components/BtnB.vue': '<template><b /></template>\n',
    }, ['.']);
    const btn = ['src/App.vue#App -render-> src/components/BtnA.vue#BtnA'];
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      expect(renders(root)).toEqual(btn);
      // Only the plugin changes, then only main.js: each sync re-reads one registering file.
      writeFileSync(join(root, 'src/plugins/z.js'), plugin(1));
      mapx(root, 'sync', root);
      expect(renders(root)).toEqual(btn);
      writeFileSync(join(root, 'src/main.js'), readFileSync(join(root, 'src/main.js'), 'utf8') + '// edited\n');
      mapx(root, 'sync', root);
      expect(renders(root)).toEqual(btn);
      mapx(root, 'scan', root, '--force');
      expect(renders(root)).toEqual(btn);
    } finally {
      cleanup(root);
    }
  }, 120000);

  // Independent review of M3-08-R1 (2026-10-31).
  it.each([
    ['a published library (main, vue peer)', { name: '@acme/ui', main: 'src/index.js', peerDependencies: { vue: '^3.4.0' } }],
    ['an internal package (no main, no peer)', { name: '@acme/ui', dependencies: { vue: '^3.4.0' } }],
    // Final review 2026-10-31: a library built by Vite in library mode is still a library.
    ['a Vite library-mode build', { name: '@acme/ui', devDependencies: { vite: '^5.0.0', vue: '^3.4.0' } }],
  ])('lets apps use the plugin registrations of %s, and the library its apps\' registrations', (label, manifest) => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true, devDependencies: { vue: '^3.4.0' } }),
      'packages/ui/package.json': JSON.stringify(manifest),
      ...(label.includes('Vite') ? { 'packages/ui/vite.config.ts': "export default { build: { lib: { entry: 'src/index.js', name: 'Ui' } } };\n" } : {}),
      'packages/ui/src/index.js': "import UiButton from './UiButton.vue';\nexport default { install(app) { app.component('UiButton', UiButton); } };\n",
      'packages/ui/src/UiButton.vue': '<template><button /></template>\n',
      'packages/ui/src/UiCard.vue': '<template>\n  <div><app-badge /></div>\n</template>\n',
      'apps/a/package.json': JSON.stringify({ name: 'a', dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
      'apps/a/src/main.js': "import { createApp } from 'vue';\nimport App from './App.vue';\nimport Ui from '../../../packages/ui/src/index.js';\nimport AppBadge from './AppBadge.vue';\nconst app = createApp(App);\napp.use(Ui);\napp.component('AppBadge', AppBadge);\napp.mount('#app');\n",
      'apps/a/src/App.vue': '<template>\n  <div><ui-button /></div>\n</template>\n',
      'apps/a/src/AppBadge.vue': '<template><i /></template>\n',
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      expect(renders(root)).toEqual([
        'apps/a/src/App.vue#App -render-> packages/ui/src/UiButton.vue#UiButton',
        'packages/ui/src/UiCard.vue#UiCard -render-> apps/a/src/AppBadge.vue#AppBadge',
      ]);
    } finally {
      cleanup(root);
    }
  }, 120000);

  // Final review 2026-10-31: an nWidart module has its own vite.config.js, but the root app imports
  // and registers its component, which then runs inside the root app and sees its registrations.
  it('lets a component that another app registers see that app\'s global registrations', () => {
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'package.json': JSON.stringify({ private: true, devDependencies: { vite: '^5.0.0', vue: '^3.4.0' } }),
      'resources/js/app.js': "import { createApp } from 'vue';\nimport BaseButton from './components/BaseButton.vue';\nimport BlogPost from '../../Modules/Blog/resources/assets/js/BlogPost.vue';\nconst app = createApp({});\napp.component('BaseButton', BaseButton);\napp.component('BlogPost', BlogPost);\napp.mount('#app');\n",
      'resources/js/components/BaseButton.vue': '<template><button /></template>\n',
      'Modules/Blog/package.json': JSON.stringify({ private: true, devDependencies: { vite: '^5.0.0' } }),
      'Modules/Blog/vite.config.js': "export default { build: { outDir: '../../public/build-blog' } };\n",
      'Modules/Blog/resources/assets/js/BlogPost.vue': '<template>\n  <article><base-button /></article>\n</template>\n',
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      expect(renders(root)).toContain('Modules/Blog/resources/assets/js/BlogPost.vue#BlogPost -render-> resources/js/components/BaseButton.vue#BaseButton');
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('follows a component that another app starts or stops registering, on sync as scan --force', () => {
    const appJs = (withBlog: boolean) => "import { createApp } from 'vue';\nimport BaseButton from './components/BaseButton.vue';\n"
      + (withBlog ? "import BlogPost from '../../Modules/Blog/resources/assets/js/BlogPost.vue';\n" : '')
      + "const app = createApp({});\napp.component('BaseButton', BaseButton);\n" + (withBlog ? "app.component('BlogPost', BlogPost);\n" : '') + "app.mount('#app');\n";
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      '.gitignore': '.mapx/\n',
      'package.json': JSON.stringify({ private: true, devDependencies: { vite: '^5.0.0', vue: '^3.4.0' } }),
      'resources/js/app.js': appJs(false),
      'resources/js/components/BaseButton.vue': '<template><button /></template>\n',
      'Modules/Blog/package.json': JSON.stringify({ private: true, devDependencies: { vite: '^5.0.0' } }),
      'Modules/Blog/vite.config.js': "export default { build: { outDir: '../../public/build-blog' } };\n",
      'Modules/Blog/resources/assets/js/BlogPost.vue': '<template>\n  <article><base-button /></article>\n</template>\n',
    }, ['.']);
    const edge = 'Modules/Blog/resources/assets/js/BlogPost.vue#BlogPost -render-> resources/js/components/BaseButton.vue#BaseButton';
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      expect(renders(root)).not.toContain(edge);
      writeFileSync(join(root, 'resources/js/app.js'), appJs(true));
      mapx(root, 'sync', root);
      expect(renders(root)).toContain(edge);
      const synced = snapshot(root);
      mapx(root, 'scan', root, '--force');
      expect(snapshot(root)).toEqual(synced);
      writeFileSync(join(root, 'resources/js/app.js'), appJs(false));
      mapx(root, 'sync', root);
      expect(renders(root)).not.toContain(edge);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('re-scopes on sync when a package.json is added or removed, as scan --force, and ignores a {"type": "module"} marker', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } }),
      '.gitignore': '.mapx/\n',
      'src/main.js': "import { createApp } from 'vue';\nimport App from './App.vue';\nimport Btn from './components/Btn.vue';\nconst app = createApp(App);\napp.component('Btn', Btn);\napp.mount('#app');\n",
      'src/App.vue': '<template><div /></template>\n',
      'src/components/Btn.vue': '<template><b /></template>\n',
      'src/views/package.json': '{ "type": "module" }\n',
      'src/views/Home.vue': '<template>\n  <btn />\n</template>\n',
      'widgets/Panel.vue': '<template>\n  <btn />\n</template>\n',
    }, ['.']);
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      const both = [
        'src/views/Home.vue#Home -render-> src/components/Btn.vue#Btn',
        'widgets/Panel.vue#Panel -render-> src/components/Btn.vue#Btn',
      ];
      expect(renders(root)).toEqual(both);
      writeFileSync(join(root, 'widgets/package.json'), JSON.stringify({ name: 'widgets', dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }));
      mapx(root, 'sync', root);
      expect(renders(root)).toEqual([both[0]]);
      const added = snapshot(root);
      mapx(root, 'scan', root, '--force');
      expect(snapshot(root)).toEqual(added);
      rmSync(join(root, 'widgets/package.json'));
      mapx(root, 'sync', root);
      expect(renders(root)).toEqual(both);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('keeps an app an app when its vite config merely has an alias named lib', () => {
    const app = (name: string, comp: string, alias = '') => ({
      [`apps/${name}/package.json`]: JSON.stringify({ name, dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
      [`apps/${name}/vite.config.js`]: `export default { resolve: { alias: { ${alias || "'@': '/src'"} } } };\n`,
      [`apps/${name}/src/main.js`]: `import { createApp } from 'vue';\nimport App from './App.vue';\nimport ${comp} from './${comp}.vue';\nconst app = createApp(App);\napp.component('${comp}', ${comp});\napp.mount('#app');\n`,
      [`apps/${name}/src/App.vue`]: '<template>\n  <div><only-a /><only-b /></div>\n</template>\n',
      [`apps/${name}/src/${comp}.vue`]: '<template><i /></template>\n',
    });
    const root = workspace({ ...app('a', 'OnlyA'), ...app('b', 'OnlyB', "lib: '/src/lib'") });
    try {
      init(root);
      mapx(root, 'scan', root);
      expect(renders(root)).toEqual([
        'apps/a/src/App.vue#App -render-> apps/a/src/OnlyA.vue#OnlyA',
        'apps/b/src/App.vue#App -render-> apps/b/src/OnlyB.vue#OnlyB',
      ]);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('keeps one registry per app folder (two package.json files)', () => {
    const app = (name: string, onlyA: boolean) => ({
      [`${name}/package.json`]: JSON.stringify({ name, dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
      [`${name}/src/main.js`]: `import { createApp } from 'vue';
import App from './App.vue';
import Widget from './components/Widget.vue';
${onlyA ? "import OnlyA from './components/OnlyA.vue';\n" : ''}
const app = createApp(App);
app.component('Widget', Widget);
${onlyA ? "app.component('OnlyA', OnlyA);\n" : ''}app.mount('#app');
`,
      [`${name}/src/App.vue`]: '<template>\n  <div><widget /><only-a /></div>\n</template>\n',
      [`${name}/src/components/Widget.vue`]: '<template><i /></template>\n',
      // App B has a file of the same name, never registered there.
      [`${name}/src/components/OnlyA.vue`]: '<template><b /></template>\n',
    });
    const root = workspace({ ...app('appA', true), ...app('appB', false) });
    try {
      init(root);
      mapx(root, 'scan', root);
      expect(renders(root)).toEqual([
        'appA/src/App.vue#App -render-> appA/src/components/OnlyA.vue#OnlyA',
        'appA/src/App.vue#App -render-> appA/src/components/Widget.vue#Widget',
        'appB/src/App.vue#App -render-> appB/src/components/Widget.vue#Widget',
      ]);
      // App B registers its own OnlyA: a plain scan re-links B's App to B's file only.
      writeFileSync(join(root, 'appB/src/main.js'), app('appB', true)['appB/src/main.js']!);
      mapx(root, 'scan', root);
      expect(renders(root)).toEqual([
        'appA/src/App.vue#App -render-> appA/src/components/OnlyA.vue#OnlyA',
        'appA/src/App.vue#App -render-> appA/src/components/Widget.vue#Widget',
        'appB/src/App.vue#App -render-> appB/src/components/OnlyA.vue#OnlyA',
        'appB/src/App.vue#App -render-> appB/src/components/Widget.vue#Widget',
      ]);
    } finally {
      cleanup(root);
    }
  }, 120000);
});

// M3-02-R1: names the template binds itself (v-for aliases, slot props) shadow component members,
// a v-pre subtree is not compiled, and only the top-level <template> block is the template.
describe('template scopes, v-pre and custom blocks (M3-02-R1)', () => {
  const calls = (refs: ExtractedReference[]) =>
    refs.filter((r) => r.referenceType === 'call').map((r) => `${r.targetName}:${r.startLine}`);
  const renders = (refs: ExtractedReference[]) =>
    refs.filter((r) => r.referenceType === 'render').map((r) => r.targetName);

  it('never gives v-for aliases or slot props a call reference, in the scope they bind', () => {
    const sfc = `<template>
  <div>
    <li v-for="format in formatters" :title="format(1)">{{ format(2) }}</li>
    <li v-for="({ id, run: go, done = noop }, i) of jobs(count)" :key="id">{{ go(i) }} {{ done() }} {{ id() }}</li>
    <DataTable v-slot="{ remove, refresh }" @reload="refresh">
      <button @click="remove(item)">x</button>
      <button @click="refresh">r</button>
    </DataTable>
    <Child #default="{ save }"><b @click="save()" /></Child>
    <Child v-slot:row="props"><i @click="props.open()">{{ props() }}</i></Child>
    <Legacy><span slot-scope="{ pick }" @click="pick">{{ pick() }}</span></Legacy>
    <Legacy><template scope="old">{{ old() }}</template></Legacy>
    <th scope="col">{{ col() }}</th>
    <button @click="format(3)">{{ remove() }} {{ save() }} {{ pick() }} {{ go() }}</button>
  </div>
</template>
<script>
export default {
  methods: { format() {}, jobs() {}, remove() {}, refresh() {}, save() {}, props() {}, pick() {}, old() {}, col() {}, go() {}, id() {}, done() {} },
};
</script>
`;
    // Left: a v-for source (outer scope), the component's own @reload (outside its slot), a native
    // `scope` attribute, and the calls after every scope has closed.
    expect(calls(templateReferences(sfc, 'List'))).toEqual([
      'jobs:4', 'refresh:5', 'col:13', 'format:14', 'remove:14', 'save:14', 'pick:14', 'go:14',
    ]);
    // The v-for source is outside its own alias: `page(1)` is the method, `page()` inside the alias.
    expect(calls(templateReferences('<template><li v-for="page in page(1)">{{ page() }}</li></template>', 'P'))).toEqual(['page:1']);
  });

  it('skips v-pre subtrees: no calls, renders or navigation inside', async () => {
    const sfc = `<template>
  <div>
    <span v-pre>{{ save() }} <UserCard @click="load" /><span>{{ nested() }}</span></span>
    <UserCard v-pre @click="load" />
    <section v-pre><router-link to="/admin">{{ admin() }}</router-link></section>
    <p @click="after">{{ load() }}</p>
  </div>
</template>
<script setup>
import UserCard from './UserCard.vue';
function save() {}
function load() {}
function after() {}
</script>
`;
    const refs = templateReferences(sfc, 'Pre');
    expect(calls(refs)).toEqual(['after:6', 'load:6']);
    expect(renders(refs)).toEqual([]);
    const parsed = await new VueParser(getBuiltinLanguages().vue).parse('src/Pre.vue', sfc);
    expect(parsed.references.filter((r) => r.referenceType === 'navigate')).toEqual([]);
  });

  it('reads the top-level <template> block, not a <template> shown inside a custom block', () => {
    const sfc = `<docs>
Usage:
<template><Fancy @click="danger()" /></template>
</docs>
<i18n lang="json">{ "en": { "template": "<template>" } }</i18n>
<custom-block />
<template>
  <div @click="go"><Fancy /></div>
</template>
<script setup>
import Fancy from './Fancy.vue';
function go() {}
function danger() {}
</script>
`;
    const refs = templateReferences(sfc, 'Docs');
    expect(calls(refs)).toEqual(['go:8']);
    expect(brief(refs.filter((r) => r.referenceType === 'render'))).toEqual([
      { type: 'render', source: 'Docs', target: 'Fancy', line: 8, vue: { from: [{ specifier: './Fancy.vue', name: 'Fancy' }] } },
    ]);
  });

  it('gives no edge to a same-named method on a real scan', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^2.7.16' } }),
      'src/components/DataTable.vue': '<template><table><slot :remove="drop" /></table></template>\n<script>\nexport default { methods: { drop() {} } };\n</script>\n',
      'src/components/Preview.vue': '<template><i /></template>\n',
      'src/components/List.vue': `<docs>
<template><List @click="danger()" /></template>
</docs>

<template>
  <div>
    <DataTable v-slot="{ remove }">
      <button @click="remove(item)">x</button>
    </DataTable>
    <DataTable><template slot-scope="{ refresh }"><b @click="refresh" /></template></DataTable>
    <ul><li v-for="format in formatters">{{ format(1) }}</li></ul>
    <span v-pre>{{ legacy() }} <Preview /></span>
    <button @click="reload">{{ label() }}</button>
  </div>
</template>

<script>
import DataTable from './DataTable.vue';
import Preview from './Preview.vue';

export default {
  components: { DataTable, Preview },
  methods: { remove() {}, refresh() {}, format() {}, legacy() {}, danger() {}, reload() {}, label() {} },
};
</script>
`,
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const edges = query<{ target_file: string; target_symbol: string; edge_type: string }>(root,
        `SELECT target_file, target_symbol, edge_type FROM edges WHERE edge_type IN ('call', 'render') AND source_file = 'src/components/List.vue' ORDER BY 1, 2`)
        .map((e) => `${e.edge_type} ${e.target_file}#${e.target_symbol}`);
      expect(edges).toEqual([
        'render src/components/DataTable.vue#DataTable',
        'call src/components/List.vue#label',
        'call src/components/List.vue#reload',
      ]);
    } finally {
      cleanup(root);
    }
  }, 120000);
});
