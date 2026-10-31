import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { analyzeScriptBlock, reExportsOf } from '../src/parsers/languages/vue-script-setup.js';
import { VueParser } from '../src/parsers/languages/vue.js';
import { getBuiltinLanguages } from '../src/languages/registry.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M3-04: the component's interface (`props` / `emits`) on its component symbol (edge contract rule 1),
// and composables in script code (rule 4): `useX()` and the functions destructured from its result
// resolve through the import to the composable's file, never by name (docs/baton/iterations/M3-01.md).

const iface = async (code: string) => (await analyzeScriptBlock(code))!.interface;

describe('Vue <script setup> macros: the component interface', () => {
  it('reads a type-based defineProps, also inside withDefaults', async () => {
    expect(await iface('defineProps<{ id: number }>();')).toEqual({ props: ['id'] });
    expect(await iface(`withDefaults(defineProps<{ variant?: string; 'aria-label': string }>(), { variant: 'primary' });`))
      .toEqual({ props: ['variant', 'aria-label'] });
  });

  it('follows a same-block interface, type alias and intersection', async () => {
    expect(await iface('interface Props { id: number; name?: string }\nconst props = defineProps<Props>();'))
      .toEqual({ props: ['id', 'name'] });
    expect(await iface('type Base = { id: number };\nexport type Props = Base & { max?: number };\ndefineProps<Props>();'))
      .toEqual({ props: ['id', 'max'] });
  });

  it('reads runtime defineProps (object keys, array strings)', async () => {
    expect(await iface('const props = defineProps({ userId: { type: Number, required: true }, compact: Boolean });'))
      .toEqual({ props: ['userId', 'compact'] });
    expect(await iface("defineProps(['title', 'count']);")).toEqual({ props: ['title', 'count'] });
  });

  it('reads defineEmits in its type (call signatures, 3.3 tuples) and runtime forms', async () => {
    expect(await iface("const emit = defineEmits<{ (e: 'save' | 'cancel', id: number): void; (e: 'close'): void }>();"))
      .toEqual({ emits: ['save', 'cancel', 'close'] });
    expect(await iface("const emit = defineEmits<{ change: [id: number]; 'update:modelValue': [value: string] }>();"))
      .toEqual({ emits: ['change', 'update:modelValue'] });
    expect(await iface("const emit = defineEmits(['saved']);")).toEqual({ emits: ['saved'] });
    expect(await iface('const emit = defineEmits({ submit: (payload) => !!payload, reset: null });')).toEqual({ emits: ['submit', 'reset'] });
  });

  it('reads defineExpose and Options API props / emits', async () => {
    expect(await iface('defineExpose({ focus, reset: clear });')).toEqual({ exposes: ['focus', 'reset'] });
    expect(await iface("export default { props: { id: Number }, emits: ['picked'], methods: { pick() {} } };"))
      .toEqual({ props: ['id'], emits: ['picked'] });
    expect(await iface("export default defineComponent({ props: ['label'] });")).toEqual({ props: ['label'] });
  });

  it('puts props and emits on the component symbol, merged across script blocks', async () => {
    const parser = new VueParser(getBuiltinLanguages().vue);
    const result = await parser.parse('src/components/UserRow.vue', `<template><span>{{ id }}</span></template>
<script lang="ts">
export default { inheritAttrs: false, emits: ['legacy'] };
</script>
<script setup lang="ts">
defineProps<{ id: number }>();
const emit = defineEmits<{ (e: 'select', id: number): void }>();
</script>
`);
    const component = result.symbols.find((s) => s.name === 'UserRow' && s.kind === 'class');
    expect(component?.metadata).toEqual({ props: ['id'], emits: ['legacy', 'select'] });
  });
});

describe('Vue composable call hints', () => {
  const hints = async (code: string) => [...(await analyzeScriptBlock(code))!.hints].map(([k, h]) => `${k} ${JSON.stringify(h.from)}`);

  it('hints imported composables and destructured functions, within the destructuring\'s scope', async () => {
    const found = await hints(`import { useUser as useAccount } from '@/composables/useUser';
import useTheme from './useTheme';
import { useCartStore } from '@/stores/cart';
import { format } from '@/utils/format';
function setup() {
  const { refresh, rename: setName = noop } = useAccount();
  useTheme();
  function reload() { refresh(); setName('x'); }
}
function elsewhere() { refresh(); useCartStore(); useLocal(); format(1); }
`);
    // Not hinted: refresh() outside setup(), a Pinia store (M3-05), a local useX and a plain import.
    expect(found.sort()).toEqual([
      '6:useAccount [{"specifier":"@/composables/useUser","name":"useUser"}]',
      '7:useTheme [{"specifier":"./useTheme","name":"useTheme"}]',
      '8:refresh [{"specifier":"@/composables/useUser","name":"refresh"}]',
      '8:setName [{"specifier":"@/composables/useUser","name":"rename"}]',
    ]);
  });

  it('follows re-exports of a barrel file', () => {
    const barrel = "export * from './useAuth';\nexport { default as useTheme, useMode as useColorMode } from './theme';\n";
    expect(reExportsOf(barrel, 'useAuth')).toEqual([{ specifier: './useAuth', name: 'useAuth' }]);
    expect(reExportsOf(barrel, 'useTheme')).toEqual([{ specifier: './useAuth', name: 'useTheme' }, { specifier: './theme', name: 'useTheme' }]);
    expect(reExportsOf(barrel, 'useColorMode')).toEqual([{ specifier: './useAuth', name: 'useColorMode' }, { specifier: './theme', name: 'useMode' }]);
  });
});

const CARD = 'src/components/UserCard.vue';
const PROFILE = 'laravel/resources/js/Pages/Profile.vue';
const BADGE = 'laravel/resources/js/Components/Badge.vue';

describe('Vue composables end to end', () => {
  let root: string;
  let calls: { source_symbol: string | null; target_file: string; target_symbol: string }[];
  let profileCalls: typeof calls;
  let laravelEdges: (typeof calls[number] & { source_file: string; edge_type: string })[];
  const targetsOf = (source: string, target: string, edges = calls) =>
    edges.filter((e) => e.source_symbol === source && e.target_symbol === target).map((e) => e.target_file).sort();

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'cards', dependencies: { vue: '^3.4.0' } }),
      [CARD]: `<template>
  <button @click="reload">{{ id }}</button>
</template>

<script setup lang="ts">
import { useUser } from '../composables/useUser';
import { useAuth, useTheme } from '@/composables';

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ (e: 'select', id: number): void }>();

const { refresh, rename: setName } = useUser(props.id);
const { logout } = useAuth();
useTheme();

function reload() {
  refresh();
  setName('card');
  emit('select', props.id);
}

function signOut() {
  logout();
}
</script>
`,
      'src/composables/useUser.ts': `export function useUser(id: number) {
  function refresh() { return id; }
  function rename(name: string) { return name; }
  return { refresh, rename };
}
`,
      'src/composables/useAuth.ts': 'export function useAuth() {\n  function logout() { return true; }\n  return { logout };\n}\n',
      'src/composables/useTheme.ts': "export default function useTheme() {\n  return 'dark';\n}\n",
      'src/composables/index.ts': "export * from './useAuth';\nexport { default as useTheme } from './useTheme';\n",
      // Same-name traps, sorted before src/composables so that a name lookup would pick them: a second
      // useUser, and top-level functions named like the destructured ones.
      'src/api/useUser.ts': 'export function useUser() {\n  return {};\n}\nexport function refresh() {\n  return 0;\n}\n',
      'src/api/session.ts': 'export function logout() {\n  return false;\n}\nexport function rename(name: string) {\n  return name;\n}\n',
      // Laravel app (M3-09): its vite.config.js aliases `@` to resources/js. The src/ files are traps
      // for a fixed `@/` → src/ mapping; src/api/useProfile.js shares the names but not the path.
      'laravel/package.json': JSON.stringify({ name: 'laravel-app', dependencies: { vue: '^3.4.0' } }),
      'laravel/vite.config.js': `import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [laravel({ input: 'resources/js/app.js', refresh: true }), vue()],
  resolve: { alias: { '@': '/resources/js' } },
});
`,
      [PROFILE]: `<template>
  <Avatar :size="2" />
</template>

<script setup>
import Avatar from '@/Components/Avatar.vue';
import { useProfile } from '@/composables/useProfile';

const { save } = useProfile();

function submit() {
  save();
}
</script>
`,
      [BADGE]: `<template>
  <span @click="track('badge')"><slot /></span>
</template>

<script>
import tracking from '@/mixins/tracking';

export default {
  mixins: [tracking],
  methods: {
    go() {
      this.track('go');
    },
  },
};
</script>
`,
      'laravel/resources/js/Components/Avatar.vue': '<template><img alt="" /></template>\n',
      'laravel/resources/js/mixins/tracking.js': 'export default {\n  methods: {\n    track(event) { return event; },\n  },\n};\n',
      'laravel/resources/js/composables/useProfile.js': 'export function useProfile() {\n  function save() { return 1; }\n  return { save };\n}\n',
      'src/Components/Avatar.vue': '<template><b /></template>\n',
      'src/mixins/tracking.js': 'export default {\n  methods: {\n    track() { return 0; },\n  },\n};\n',
      'src/composables/useProfile.js': 'export function useProfile() {\n  function save() { return 0; }\n  return { save };\n}\n',
      'src/api/useProfile.js': 'export function useProfile() {\n  return {};\n}\nexport function save() {\n  return 0;\n}\n',
    });
    init(root);
    mapx(root, 'scan', '.');
    calls = query(root, `SELECT source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call' AND source_file = ?`, CARD);
    profileCalls = query(root, `SELECT source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call' AND source_file = ?`, PROFILE);
    laravelEdges = query(root, `SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges WHERE source_file IN (?, ?) AND edge_type IN ('call', 'render')`, PROFILE, BADGE);
  }, 90000);
  afterAll(() => cleanup(root));

  it('exposes defineProps / defineEmits on the component symbol', () => {
    const [card] = query<{ metadata: string }>(root, `SELECT metadata FROM symbols WHERE file_path = ? AND name = 'UserCard' AND kind = 'class'`, CARD);
    expect(JSON.parse(card!.metadata)).toEqual({ props: ['id'], emits: ['select'] });
  });

  it('links useUser() to composables/useUser.ts through the import, not the same-named one in src/api', () => {
    expect(targetsOf('UserCard', 'useUser')).toEqual(['src/composables/useUser.ts']);
  });

  it('resolves destructured functions to the composable\'s inner function, also when renamed', () => {
    expect(targetsOf('reload', 'refresh')).toEqual(['src/composables/useUser.ts']);
    expect(targetsOf('reload', 'rename')).toEqual(['src/composables/useUser.ts']);
    expect(targetsOf('reload', 'setName')).toEqual([]);
  });

  it('follows a barrel index.ts to the composable (export *, export { default as … })', () => {
    expect(targetsOf('UserCard', 'useAuth')).toEqual(['src/composables/useAuth.ts']);
    expect(targetsOf('signOut', 'logout')).toEqual(['src/composables/useAuth.ts']);
    expect(targetsOf('UserCard', 'useTheme')).toEqual(['src/composables/useTheme.ts']);
  });

  it('resolves a Laravel @ → resources/js alias (vite.config.js) for composables, renders and mixins', () => {
    expect(targetsOf('Profile', 'useProfile', profileCalls)).toEqual(['laravel/resources/js/composables/useProfile.js']);
    expect(targetsOf('submit', 'save', profileCalls)).toEqual(['laravel/resources/js/composables/useProfile.js']);
    const edge = (source: string, type: string, target: string) => laravelEdges
      .filter((e) => e.source_symbol === source && e.edge_type === type && e.target_symbol === target).map((e) => e.target_file).sort();
    expect(edge('Profile', 'render', 'Avatar')).toEqual(['laravel/resources/js/Components/Avatar.vue']);
    expect(edge('go', 'call', 'track')).toEqual(['laravel/resources/js/mixins/tracking.js']);
    expect(edge('Badge', 'call', 'track')).toEqual(['laravel/resources/js/mixins/tracking.js']);
  });
});

// M3-09-R1: a nested app with its own package.json and no alias config keeps Vue CLI's `@` → src/,
// although the Laravel root's vite.config.js aliases `@` to resources/js. Every resources/js file
// below is a trap with the same path as the app's own file.
describe('JS/TS aliases stop at a nested app\'s boundary (M3-09-R1)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'laravel', private: true, devDependencies: { vite: '^5.0.0', 'laravel-vite-plugin': '^1.0.0' } }),
      'vite.config.js': "import { defineConfig } from 'vite';\nimport laravel from 'laravel-vite-plugin';\nexport default defineConfig({ plugins: [laravel(['resources/js/app.js'])], resolve: { alias: { '@': '/resources/js' } } });\n",
      'resources/js/app.js': "import Home from '@/views/Home.vue';\nexport default Home;\n",
      'resources/js/App.vue': '<template>\n  <p>blade island</p>\n</template>\n',
      'resources/js/views/Home.vue': '<template>\n  <p>blade home</p>\n</template>\n',
      'resources/js/components/NavBar.vue': '<template>\n  <nav>blade nav</nav>\n</template>\n',
      'frontend/package.json': JSON.stringify({ name: 'spa', private: true, dependencies: { vue: '^2.7.0', 'vue-router': '^3.6.0' }, devDependencies: { '@vue/cli-service': '^5.0.0' } }),
      'frontend/src/main.js': "import Vue from 'vue';\nimport router from './router';\nimport App from '@/App.vue';\nnew Vue({ router, render: (h) => h(App) }).$mount('#app');\n",
      'frontend/src/App.vue': `<template>
  <div>
    <NavBar />
    <router-link :to="{ name: 'home' }">Home</router-link>
    <router-view />
  </div>
</template>
<script>
import NavBar from '@/components/NavBar.vue';
export default { name: 'App', components: { NavBar } };
</script>
`,
      'frontend/src/components/NavBar.vue': '<template>\n  <nav>spa nav</nav>\n</template>\n',
      'frontend/src/router/index.js': "import Vue from 'vue';\nimport VueRouter from 'vue-router';\nimport Home from '@/views/Home.vue';\nVue.use(VueRouter);\nconst routes = [{ path: '/', name: 'home', component: Home }];\nexport default new VueRouter({ routes });\n",
      'frontend/src/views/Home.vue': '<template>\n  <p>spa home</p>\n</template>\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 90000);
  afterAll(() => cleanup(root));

  const targets = (type: string, source: string) => query<{ target_file: string }>(
    root, 'SELECT DISTINCT target_file FROM edges WHERE edge_type = ? AND source_file = ? ORDER BY target_file', type, source,
  ).map((e) => e.target_file);

  it('import: the app\'s @/ is its own src/, the root\'s stays resources/js', () => {
    expect(targets('import', 'frontend/src/main.js')).toEqual(['frontend/src/App.vue', 'frontend/src/router/index.js']);
    expect(targets('import', 'frontend/src/router/index.js')).toEqual(['frontend/src/views/Home.vue']);
    expect(targets('import', 'frontend/src/App.vue')).toEqual(['frontend/src/components/NavBar.vue']);
    expect(targets('import', 'resources/js/app.js')).toEqual(['resources/js/views/Home.vue']);
  });

  it('render: <NavBar /> renders the app\'s component', () => {
    expect(targets('render', 'frontend/src/App.vue')).toEqual(['frontend/src/components/NavBar.vue']);
  });

  it('route: the route record\'s component is the app\'s view', () => {
    expect(targets('route', 'frontend/src/router/index.js')).toEqual(['frontend/src/views/Home.vue']);
  });

  it('navigate: <router-link> reaches the app\'s view', () => {
    expect(targets('navigate', 'frontend/src/App.vue')).toEqual(['frontend/src/views/Home.vue']);
  });
});
