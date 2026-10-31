import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ExtractedReference, ExtractedSymbol } from '../src/types.js';
import {
  assignOwners, componentSymbol, globalRegistrations, templateReferences,
} from '../src/parsers/languages/vue-template.js';
import { analyzeOptionsComponent } from '../src/parsers/languages/vue-options.js';
import { VueParser } from '../src/parsers/languages/vue.js';
import { getBuiltinLanguages } from '../src/languages/registry.js';
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
