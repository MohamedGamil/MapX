import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, mapxEnv, query, workspace } from './helpers/e2e.js';
import { isGitRepo } from '../src/core/git-tracker.js';
import { storeDependencies, storePass } from '../src/parsers/languages/vue-stores.js';

// M3-05: Vuex and Pinia references resolve to the member in the right store file, by namespace or
// store import, never to a same-named function elsewhere or to the caller (edge contract rules 7
// and 8, docs/baton/iterations/M3-01.md).
const USERS_VUE = 'src/components/Users.vue';
const CART_VUE = 'src/components/Cart.vue';
const USERS = 'src/store/modules/users.js';
const ADMINS = 'src/store/modules/admins.js';
const CART = 'src/stores/cart.js';

describe('Vuex and Pinia resolution', () => {
  let root: string;
  let calls: { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string }[];
  const targetsOf = (file: string, source: string, target: string) =>
    calls.filter((e) => e.source_file === file && e.source_symbol === source && e.target_symbol === target).map((e) => e.target_file).sort();

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { vue: '^2.7.0', vuex: '^3.6.0', pinia: '^2.1.0' } }),
      'src/store/index.js': `import Vue from 'vue';
import Vuex from 'vuex';
import users from './modules/users';
import admins from './modules/admins';

Vue.use(Vuex);

export default new Vuex.Store({
  modules: { users, admins },
});
`,
      [USERS]: `const actions = {
  async FETCH({ commit }) {
    commit('SET_ALL', await (await fetch('/api/users')).json());
  },
};

export default {
  namespaced: true,
  state: () => ({ all: [] }),
  getters: {
    active: (state) => state.all.filter((user) => user.active),
  },
  mutations: {
    SET_ALL(state, users) { state.all = users; },
  },
  actions,
};
`,
      // Same action and mutation names, other namespace.
      [ADMINS]: `export default {
  namespaced: true,
  state: () => ({ all: [] }),
  mutations: {
    SET_ALL(state, admins) { state.all = admins; },
  },
  actions: {
    FETCH(context) {
      context.commit('SET_ALL', []);
    },
  },
};
`,
      // A second app's store, also with a namespaced `users` module: each app resolves against its own.
      'other/store/index.js': "import Vuex from 'vuex';\nimport users from './users';\nexport default new Vuex.Store({ modules: { users } });\n",
      'other/store/users.js': 'export default {\n  namespaced: true,\n  actions: {\n    FETCH() { return 0; },\n  },\n};\n',
      [CART]: `import { defineStore } from 'pinia';

export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] }),
  actions: {
    checkout() { this.items = []; },
    clear() { this.items = []; },
  },
});
`,
      // A setup store with the same action names.
      'src/stores/wishlist.js': `import { defineStore } from 'pinia';

export const useWishlistStore = defineStore('wishlist', () => {
  function checkout() { return 0; }
  function clear() { return 0; }
  return { checkout, clear };
});
`,
      [USERS_VUE]: `<template>
  <ul><li v-for="user in active" :key="user.id">{{ user.name }}</li></ul>
</template>

<script>
import { mapActions, mapGetters } from 'vuex';
import { useCartStore } from '../stores/cart';

export default {
  name: 'Users',
  computed: {
    ...mapGetters('users', ['active']),
  },
  methods: {
    ...mapActions('admins', { loadAdmins: 'FETCH' }),
    refresh() {
      return this.$store.dispatch('users/FETCH');
    },
    reload() {
      this.loadAdmins();
    },
    checkout() {
      useCartStore().checkout();
    },
  },
};
</script>
`,
      [CART_VUE]: `<template>
  <button @click="clear">Empty</button>
</template>

<script setup>
import { useCartStore } from '../stores/cart';

const cart = useCartStore();

function clear() {
  cart.clear();
}
</script>
`,
    });
    init(root);
    mapx(root, 'scan', '.');
    calls = query(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call'`);
  }, 90000);
  afterAll(() => cleanup(root));

  it("links this.$store.dispatch('users/FETCH') to FETCH in the users module", () => {
    expect(targetsOf(USERS_VUE, 'refresh', 'FETCH')).toEqual([USERS]);
  });

  it('links map helpers by namespace, from the component symbol and from this.NAME()', () => {
    expect(targetsOf(USERS_VUE, 'Users', 'active')).toEqual([USERS]);
    expect(targetsOf(USERS_VUE, 'Users', 'FETCH')).toEqual([ADMINS]);
    // `loadAdmins: 'FETCH'`: the store member is FETCH.
    expect(targetsOf(USERS_VUE, 'reload', 'FETCH')).toEqual([ADMINS]);
    expect(targetsOf(USERS_VUE, 'reload', 'loadAdmins')).toEqual([]);
  });

  it('keeps commit() inside a module in that module', () => {
    expect(targetsOf(USERS, 'FETCH', 'SET_ALL')).toEqual([USERS]);
    expect(targetsOf(ADMINS, 'FETCH', 'SET_ALL')).toEqual([ADMINS]);
  });

  it('gives an arrow-function getter a symbol', () => {
    const symbols = query<{ kind: string; scope: string | null }>(root, `SELECT kind, scope FROM symbols WHERE file_path = ? AND name = 'active'`, USERS);
    expect(symbols).toEqual([{ kind: 'method', scope: 'getters' }]);
  });

  it('links useCartStore().checkout() to the cart store, not the caller or another store', () => {
    expect(targetsOf(USERS_VUE, 'checkout', 'checkout')).toEqual([CART]);
    expect(targetsOf(USERS_VUE, 'checkout', 'useCartStore')).toEqual([CART]);
  });

  it('links a store bound in <script setup> from the component and from the calling function', () => {
    expect(targetsOf(CART_VUE, 'Cart', 'useCartStore')).toEqual([CART]);
    expect(targetsOf(CART_VUE, 'cart', 'useCartStore')).toEqual([]);
    expect(targetsOf(CART_VUE, 'clear', 'clear')).toEqual([CART]);
  });
});

// M3-05-R1: every documented Vuex map-helper form, members held in imported objects, and Pinia
// stores outside SFCs or with any hook name, still by exact store member, never by name alone.
describe('Vuex map-helper forms, imported members and Pinia outside SFCs', () => {
  const DASH = 'src/components/Dashboard.vue';
  const TEAM = 'src/components/Team.vue';
  const USERS_M = 'src/store/modules/users.js';
  const ADMINS_M = 'src/store/modules/admins.js';
  const CATALOG_ACTIONS = 'src/store/modules/catalog/actions.js';
  const CATALOG_GETTERS = 'src/store/modules/catalog/getters.js';
  const CATALOG_MUTATIONS = 'src/store/modules/catalog/mutations.js';
  const AUDIT = 'src/store/modules/audit.js';
  const CART_TS = 'src/stores/cart.ts';
  const WISH = 'src/stores/wish.ts';
  const PREFS = 'src/stores/prefs.ts';
  const ORDERS = 'src/api/orders.ts';
  const USE_BUY = 'src/composables/useBuy.ts';
  const LEGACY = 'src/composables/useLegacy.ts';
  const WISH_LIST = 'src/views/WishList.vue';
  let root: string;
  let calls: { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string }[];
  const targetsOf = (file: string, source: string, target: string) =>
    calls.filter((e) => e.source_file === file && e.source_symbol === source && e.target_symbol === target).map((e) => e.target_file).sort();
  const intoFile = (file: string, target: string) => calls.filter((e) => e.target_file === target && e.source_file === file);

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { vue: '^3.4.0', vuex: '^4.1.0', pinia: '^2.1.0' } }),
      'src/store/index.js': `import { createStore } from 'vuex';
import users from './modules/users';
import admins from './modules/admins';
import catalog from './modules/catalog';

export default createStore({
  modules: { users, admins, catalog },
});
`,
      [USERS_M]: `import { auditActions } from './audit';

export default {
  namespaced: true,
  state: () => ({ all: [] }),
  getters: {
    activeCount: (state) => state.all.length,
  },
  mutations: {
    SET_ALL(state, users) { state.all = users; },
  },
  actions: {
    ...auditActions,
    FETCH({ commit }) { commit('SET_ALL', []); },
  },
};
`,
      [AUDIT]: 'export const auditActions = {\n  AUDIT() { return 0; },\n};\n',
      // Same getter and action names in another namespace.
      [ADMINS_M]: `export default {
  namespaced: true,
  getters: {
    activeCount: (state) => 0,
  },
  actions: {
    FETCH() { return 0; },
  },
};
`,
      // A module whose members live in imported objects.
      'src/store/modules/catalog/index.js': `import actions from './actions';
import getters from './getters';
import * as mutations from './mutations';

export default {
  namespaced: true,
  state: () => ({ items: [] }),
  actions,
  getters,
  mutations,
};
`,
      [CATALOG_ACTIONS]: "export default {\n  LOAD({ commit }) { commit('SET_ITEMS', []); },\n};\n",
      [CATALOG_GETTERS]: 'export default {\n  visible: (state) => state.items,\n};\n',
      [CATALOG_MUTATIONS]: 'export function SET_ITEMS(state, items) { state.items = items; }\n',
      // Same names, not a store: never a target.
      'src/api/catalog.js': 'export function LOAD() { return 0; }\nexport function visible() { return 0; }\nexport function SET_ITEMS() { return 0; }\nexport function AUDIT() { return 0; }\n',
      [DASH]: `<template><p>{{ adminCount }}</p></template>

<script>
import { mapActions, mapGetters, mapMutations } from 'vuex';

export default {
  name: 'Dashboard',
  computed: {
    ...mapGetters(['users/activeCount']),
    ...mapGetters({ adminCount: 'admins/activeCount' }),
    ...mapGetters('catalog', ['visible']),
  },
  methods: {
    ...mapActions({ load: 'users/FETCH' }),
    ...mapActions('catalog', { loadCatalog: 'LOAD' }),
    ...mapActions('users', ['AUDIT']),
    ...mapMutations('catalog', ['SET_ITEMS']),
    refresh() {
      this.load();
      this.loadCatalog();
    },
  },
};
</script>
`,
      [TEAM]: `<template><p>{{ activeCount }}</p></template>

<script>
import { createNamespacedHelpers } from 'vuex';

const { mapActions, mapGetters } = createNamespacedHelpers('users');
const { mapActions: mapAdminActions } = createNamespacedHelpers('admins');
const catalog = createNamespacedHelpers('catalog');

export default {
  name: 'Team',
  computed: {
    ...mapGetters(['activeCount']),
  },
  methods: {
    ...mapActions(['FETCH']),
    ...mapAdminActions({ fetchAdmins: 'FETCH' }),
    ...catalog.mapActions(['LOAD']),
    reload() {
      this.FETCH();
      this.fetchAdmins();
      this.LOAD();
    },
  },
};
</script>
`,
      [CART_TS]: `import { defineStore } from 'pinia';

export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] as string[] }),
  actions: {
    checkout() { this.items = []; },
    add(item: string) { this.items.push(item); },
  },
});
`,
      // A setup store whose hook is not named use…Store.
      [WISH]: `import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useWish = defineStore('wish', () => {
  const items = ref<string[]>([]);
  function checkout() { items.value = []; }
  function save(item: string) { items.value.push(item); }
  return { items, checkout, save };
});
`,
      // An any-name hook defined and used in the same file.
      [PREFS]: `import { defineStore } from 'pinia';

export const usePrefs = defineStore('prefs', () => {
  function reset() { return 0; }
  return { reset };
});

export function resetAll() {
  usePrefs().reset();
}
`,
      // Same names, not a store.
      [ORDERS]: 'export function checkout() { return 1; }\nexport function add(x: string) { return x; }\nexport function save(x: string) { return x; }\nexport function reset() { return 0; }\n',
      [USE_BUY]: `import { useCartStore } from '../stores/cart';

export function useBuy() {
  const { checkout, add: addItem } = useCartStore();
  function buy() {
    addItem('a');
    checkout();
  }
  return { buy };
}
`,
      // A parameter or an inner function of the same name shadows the destructured action.
      'src/composables/useRetry.ts': `import { useCartStore } from '../stores/cart';

export function useRetry() {
  const { checkout } = useCartStore();
  function retry(checkout: () => number) {
    return checkout();
  }
  function undo() {
    function checkout() { return 0; }
    return checkout();
  }
  return { retry, undo };
}
`,
      // A composable, not a store, with a same-named inner function.
      [LEGACY]: 'export function useLegacy() {\n  function checkout() { return 0; }\n  return { checkout };\n}\n',
      // Pinia's own map helpers take a store hook of any name.
      [WISH_LIST]: `<template><button @click="pay">Pay</button></template>

<script>
import { mapActions } from 'pinia';
import { useWish } from '../stores/wish';
import { useLegacy } from '../composables/useLegacy';

export default {
  name: 'WishList',
  methods: {
    ...mapActions(useWish, ['checkout']),
    ...mapActions(useWish, { keep: 'save' }),
    ...mapActions(useLegacy, { legacyCheckout: 'checkout' }),
    pay() {
      this.checkout();
      this.keep('x');
      this.legacyCheckout();
    },
  },
};
</script>
`,
    });
    init(root);
    mapx(root, 'scan', '.');
    calls = query(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call'`);
  }, 90000);
  afterAll(() => cleanup(root));

  it("links mapGetters(['ns/name']) and the object form to the module member", () => {
    expect(targetsOf(DASH, 'Dashboard', 'activeCount')).toEqual([ADMINS_M, USERS_M]);
    expect(targetsOf(DASH, 'Dashboard', 'FETCH')).toEqual([USERS_M]);
  });

  it("follows this.load() mapped with { load: 'users/FETCH' } to the users module", () => {
    expect(targetsOf(DASH, 'refresh', 'FETCH')).toEqual([USERS_M]);
    expect(targetsOf(DASH, 'refresh', 'load')).toEqual([]);
  });

  it('links createNamespacedHelpers helpers (destructured, renamed, as members) and this.NAME()', () => {
    expect(targetsOf(TEAM, 'Team', 'activeCount')).toEqual([USERS_M]);
    expect(targetsOf(TEAM, 'Team', 'FETCH')).toEqual([ADMINS_M, USERS_M]);
    expect(targetsOf(TEAM, 'Team', 'LOAD')).toEqual([CATALOG_ACTIONS]);
    expect(targetsOf(TEAM, 'reload', 'FETCH')).toEqual([ADMINS_M, USERS_M]);
    expect(targetsOf(TEAM, 'reload', 'LOAD')).toEqual([CATALOG_ACTIONS]);
    expect(targetsOf(TEAM, 'reload', 'fetchAdmins')).toEqual([]);
  });

  it('finds module members defined in imported objects', () => {
    expect(targetsOf(DASH, 'Dashboard', 'visible')).toEqual([CATALOG_GETTERS]);
    expect(targetsOf(DASH, 'Dashboard', 'LOAD')).toEqual([CATALOG_ACTIONS]);
    expect(targetsOf(DASH, 'refresh', 'LOAD')).toEqual([CATALOG_ACTIONS]);
    expect(targetsOf(DASH, 'Dashboard', 'SET_ITEMS')).toEqual([CATALOG_MUTATIONS]);
    // A spread of an imported object in `actions`.
    expect(targetsOf(DASH, 'Dashboard', 'AUDIT')).toEqual([AUDIT]);
    expect(intoFile(DASH, 'src/api/catalog.js')).toEqual([]);
    // The imported getter (an arrow-function member) has a symbol to point at.
    const symbols = query<{ kind: string; scope: string | null }>(root, `SELECT kind, scope FROM symbols WHERE file_path = ? AND name = 'visible'`, CATALOG_GETTERS);
    expect(symbols).toEqual([{ kind: 'method', scope: 'getters' }]);
  });

  it('links actions destructured from a store in a .ts composable, renamed or not', () => {
    expect(targetsOf(USE_BUY, 'buy', 'checkout')).toEqual([CART_TS]);
    expect(targetsOf(USE_BUY, 'buy', 'add')).toEqual([CART_TS]);
    expect(targetsOf(USE_BUY, 'buy', 'addItem')).toEqual([]);
    expect(intoFile(USE_BUY, ORDERS)).toEqual([]);
    // Shadowed by a parameter or an inner function: not the store action.
    expect(targetsOf('src/composables/useRetry.ts', 'retry', 'checkout')).not.toContain(CART_TS);
    expect(targetsOf('src/composables/useRetry.ts', 'undo', 'checkout')).not.toContain(CART_TS);
  });

  it('recognises a setup store with any hook name from defineStore', () => {
    // Defined and used in the same file.
    expect(targetsOf(PREFS, 'resetAll', 'reset')).toEqual([PREFS]);
    expect(targetsOf(PREFS, 'resetAll', 'usePrefs')).toEqual([PREFS]);
    expect(intoFile(PREFS, ORDERS)).toEqual([]);
    // Imported and passed to Pinia's map helpers: confirmed from the store file's defineStore.
    expect(targetsOf(WISH_LIST, 'WishList', 'checkout')).toEqual([WISH]);
    expect(targetsOf(WISH_LIST, 'WishList', 'save')).toEqual([WISH]);
    expect(targetsOf(WISH_LIST, 'pay', 'checkout')).toEqual([WISH]);
    expect(targetsOf(WISH_LIST, 'pay', 'save')).toEqual([WISH]);
    // useLegacy is a composable, not a store: its inner checkout() is not a mapped action.
    expect(intoFile(WISH_LIST, LEGACY)).toEqual([]);
    expect(intoFile(WISH_LIST, ORDERS)).toEqual([]);
    const wish = query<{ metadata: string }>(root, 'SELECT metadata FROM files WHERE path = ?', WISH)[0];
    expect(JSON.parse(wish.metadata).vuex.piniaHooks).toEqual(['useWish']);
  });
});

// M3-05-R1: an imported hook of any name is a store when its module defines it with defineStore;
// otherwise (a composable) its calls resolve as they did before, through the default resolution.
describe('Pinia stores with any hook name, imported', () => {
  const WISH = 'src/stores/wish.ts';
  const ORDERS = 'src/api/orders.ts';
  const HTTP = 'src/api/http.ts';
  const USE_WISH_BUY = 'src/composables/useWishBuy.ts';
  const USE_BOTH = 'src/composables/useBoth.ts';
  const WISH_VUE = 'src/views/WishView.vue';
  const PAGE = 'src/views/Page.vue';
  let root: string;
  let calls: { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string }[];
  const targetsOf = (file: string, source: string, target: string) =>
    calls.filter((e) => e.source_file === file && e.source_symbol === source && e.target_symbol === target).map((e) => e.target_file).sort();

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { vue: '^3.4.0', pinia: '^2.1.0' } }),
      [WISH]: `import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useWish = defineStore('wish', () => {
  const items = ref<string[]>([]);
  function checkout() { items.value = []; }
  function save(item: string) { items.value.push(item); }
  return { items, checkout, save };
});
`,
      // Same names, not a store.
      [ORDERS]: 'export function checkout() { return 1; }\nexport function save(x: string) { return x; }\n',
      [USE_WISH_BUY]: `import { computed } from 'vue';
import { useWish } from '../stores/wish';

export function useWishBuy() {
  const wish = useWish();
  const { save } = useWish();
  function buy() {
    wish.checkout();
    save('x');
  }
  return { buy, count: computed(() => wish.items.length) };
}
`,
      [WISH_VUE]: `<template><button @click="buy">Buy</button></template>

<script setup>
import { useWish } from '../stores/wish';

const wish = useWish();

function buy() {
  wish.checkout();
}
</script>
`,
      // Composables that are not stores keep the default resolution.
      [HTTP]: 'export function fetchAll() { return 1; }\nexport function clear() { return 0; }\n',
      'src/composables/useApi.ts': "import { fetchAll } from '../api/http';\nexport function useApi() { return { fetchAll }; }\n",
      'src/composables/useLocal.ts': 'export function useLocal() {\n  function refresh() { return 0; }\n  return { refresh };\n}\n',
      [USE_BOTH]: `import { ref } from 'vue';
import { useApi } from './useApi';
import { useLocal } from './useLocal';

export function useBoth() {
  const api = useApi();
  const { refresh } = useLocal();
  function go() {
    api.fetchAll();
    api.clear();
    refresh();
  }
  return { go, n: ref(0) };
}
`,
      [PAGE]: `<template><button @click="go">Go</button></template>

<script setup>
import { useApi } from '../composables/useApi';

const api = useApi();

function go() {
  api.fetchAll();
}
</script>
`,
    });
    init(root);
    mapx(root, 'scan', '.');
    calls = query(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call'`);
  }, 90000);
  afterAll(() => cleanup(root));

  it('links a member call and a destructured action of an any-name setup store in a .ts composable', () => {
    expect(targetsOf(USE_WISH_BUY, 'buy', 'checkout')).toEqual([WISH]);
    expect(targetsOf(USE_WISH_BUY, 'buy', 'save')).toEqual([WISH]);
    expect(calls.filter((e) => e.source_file === USE_WISH_BUY && e.target_file === ORDERS)).toEqual([]);
  });

  it('links a member call of an any-name setup store in <script setup>', () => {
    expect(targetsOf(WISH_VUE, 'buy', 'checkout')).toEqual([WISH]);
    expect(calls.filter((e) => e.source_file === WISH_VUE && e.target_symbol === 'checkout' && e.target_file !== WISH)).toEqual([]);
  });

  it('leaves calls through composables that are not stores to the default resolution', () => {
    expect(targetsOf(USE_BOTH, 'go', 'fetchAll')).toEqual([HTTP]);
    expect(targetsOf(USE_BOTH, 'go', 'refresh')).toEqual(['src/composables/useLocal.ts']);
    expect(targetsOf(PAGE, 'go', 'fetchAll')).toEqual([HTTP]);
    // `clear` is a built-in method name the generic extraction skips: still no edge.
    expect(targetsOf(USE_BOTH, 'go', 'clear')).toEqual([]);
  });
});

// M3-05-R2: a plain module that imports only an any-name store hook (no `vue` / `pinia` import),
// and Vuex arrow-function members in an imported object whatever its file is called.
describe('Plain modules and member objects of any name', () => {
  const WISH = 'src/stores/wish.ts';
  const ORDERS = 'src/api/orders.ts';
  const HTTP = 'src/api/http.ts';
  const USE_WISH_ADD = 'src/composables/useWishAdd.ts';
  const USE_PLAIN = 'src/composables/usePlain.ts';
  const USER_ACTIONS = 'src/store/modules/user/userActions.js';
  const USER_GETTERS = 'src/store/modules/user/userGetters.js';
  const USER_MUTATIONS = 'src/store/modules/user/userMutations.js';
  const USER_API = 'src/api/user.js';
  const FLAGS = 'src/store/modules/user/flags.js';
  const FORMAT = 'src/utils/format.js';
  const MIXED = 'src/utils/mixed.js';
  const PROFILE = 'src/components/Profile.vue';
  let root: string;
  let calls: { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string }[];
  const targetsOf = (file: string, source: string, target: string) =>
    calls.filter((e) => e.source_file === file && e.source_symbol === source && e.target_symbol === target).map((e) => e.target_file).sort();
  const symbolsOf = (file: string, name: string) =>
    query<{ kind: string; scope: string | null }>(root, 'SELECT kind, scope FROM symbols WHERE file_path = ? AND name = ?', file, name);

  const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { vue: '^3.4.0', vuex: '^4.1.0', pinia: '^2.1.0' } }),
      [WISH]: `import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useWish = defineStore('wish', () => {
  const items = ref<string[]>([]);
  function add(item: string) { items.value.push(item); }
  function clear() { items.value = []; }
  return { items, add, clear };
});
`,
      // Same names, not a store: never a target.
      [ORDERS]: 'export function add(x: string) { return x; }\nexport function clear() { return 0; }\n',
      // Imports only the hook: no vue, no pinia, no use…Store name.
      [USE_WISH_ADD]: `import { useWish } from '../stores/wish';

export function useWishAdd() {
  const w = useWish();
  function addOne(item: string) {
    w.add(item);
  }
  function empty() {
    const wish = useWish();
    wish.clear();
  }
  return { addOne, empty };
}
`,
      // Composables that are not stores, used from a plain module: the default resolution.
      [HTTP]: 'export function fetchAll() { return 1; }\nexport function clear() { return 0; }\n',
      'src/composables/useApi.ts': "import { fetchAll } from '../api/http';\nexport function useApi() { return { fetchAll }; }\n",
      'src/composables/useLocal.ts': 'export function useLocal() {\n  function refresh() { return 0; }\n  return { refresh };\n}\n',
      [USE_PLAIN]: `import { useApi } from './useApi';
import { useLocal } from './useLocal';

export function usePlain() {
  const api = useApi();
  const { refresh } = useLocal();
  function go() {
    api.fetchAll();
    api.clear();
    refresh();
  }
  return { go };
}
`,
      'src/store/index.js': `import { createStore } from 'vuex';
import user from './modules/user';

export default createStore({
  modules: { user },
});
`,
      // Members in imported objects whose files are not named actions.js / getters.js / mutations.js.
      'src/store/modules/user/index.js': `import userActions from './userActions';
import userGetters from './userGetters';
import { userMutations } from './userMutations';
import { flags } from './flags';

export default {
  namespaced: true,
  state: () => ({ current: null, ready: false, on: false }),
  actions: userActions,
  getters: { ...userGetters },
  mutations: { ...userMutations, ...flags },
};
`,
      [USER_ACTIONS]: `import { getUser } from '../../../api/user';

export default {
  fetchUser: async ({ commit }, id) => {
    commit('SET_USER', await getUser(id));
  },
  logout: (context) => context.commit('SET_USER', null),
};
`,
      // A getter with a block body is still a getter: it writes nothing to state.
      [USER_GETTERS]: "export default {\n  displayName: (state) => (state.current ? state.current.name : ''),\n  initials: (state) => {\n    return state.current ? state.current.name[0] : '';\n  },\n};\n",
      // SET_USER writes state through a helper, so only the name says mutations.
      [USER_MUTATIONS]: 'function applyUser(state, user) {\n  state.current = user;\n}\n\nexport const userMutations = {\n  SET_USER: (state, user) => applyUser(state, user),\n};\n',
      // No kind in any name: mutations because they write state, an expression body included.
      [FLAGS]: 'export const flags = {\n  SET_READY: (state, ready) => (state.ready = ready),\n  TOGGLE: (state) => {\n    state.on = !state.on;\n  },\n};\n',
      // Same names, not a store: never a target.
      [USER_API]: 'export function getUser(id) { return id; }\nexport function fetchUser() { return 0; }\nexport function displayName() { return 0; }\nexport function SET_USER() { return 0; }\n',
      // An exported object of arrow functions, not all with a Vuex member's first parameter: no symbols.
      [FORMAT]: 'export default {\n  label: (state) => state.name,\n  upper: (text) => text.toUpperCase(),\n};\n',
      // Actions mixed with state functions: not one kind of members, no symbols.
      [MIXED]: 'export default {\n  load: ({ commit }) => commit(\'X\'),\n  count: (state) => state.n,\n};\n',
      [PROFILE]: `<template><p>{{ displayName }}</p></template>

<script>
import { mapActions, mapGetters, mapMutations } from 'vuex';

export default {
  name: 'Profile',
  computed: {
    ...mapGetters('user', ['displayName']),
  },
  methods: {
    ...mapActions('user', ['fetchUser', 'logout']),
    ...mapMutations('user', ['SET_USER', 'SET_READY']),
    reload() {
      this.fetchUser(1);
    },
  },
};
</script>
`,
  };

  beforeAll(() => {
    root = workspace(files);
    init(root);
    mapx(root, 'scan', '.');
    calls = query(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call'`);
  }, 90000);
  afterAll(() => cleanup(root));

  it('links w.add and wish.clear in a composable importing only useWish', () => {
    expect(targetsOf(USE_WISH_ADD, 'addOne', 'add')).toEqual([WISH]);
    expect(targetsOf(USE_WISH_ADD, 'empty', 'clear')).toEqual([WISH]);
    expect(calls.filter((e) => e.source_file === USE_WISH_ADD && e.target_file === ORDERS)).toEqual([]);
  });

  it('leaves calls through composables that are not stores to the default resolution in a plain module', () => {
    expect(targetsOf(USE_PLAIN, 'go', 'fetchAll')).toEqual([HTTP]);
    expect(targetsOf(USE_PLAIN, 'go', 'refresh')).toEqual(['src/composables/useLocal.ts']);
    expect(targetsOf(USE_PLAIN, 'go', 'clear')).toEqual([]);
  });

  it('links mapActions to an arrow member in userActions.js, and other kinds in any-name member files', () => {
    expect(targetsOf(PROFILE, 'Profile', 'fetchUser')).toEqual([USER_ACTIONS]);
    expect(targetsOf(PROFILE, 'Profile', 'logout')).toEqual([USER_ACTIONS]);
    expect(targetsOf(PROFILE, 'reload', 'fetchUser')).toEqual([USER_ACTIONS]);
    expect(targetsOf(PROFILE, 'Profile', 'displayName')).toEqual([USER_GETTERS]);
    expect(targetsOf(PROFILE, 'Profile', 'SET_USER')).toEqual([USER_MUTATIONS]);
    expect(calls.filter((e) => e.source_file === PROFILE && e.target_file === USER_API)).toEqual([]);
    expect(symbolsOf(USER_ACTIONS, 'fetchUser')).toEqual([{ kind: 'method', scope: 'actions' }]);
    expect(symbolsOf(USER_GETTERS, 'displayName')).toEqual([{ kind: 'method', scope: 'getters' }]);
    expect(symbolsOf(USER_GETTERS, 'initials')).toEqual([{ kind: 'method', scope: 'getters' }]);
    expect(symbolsOf(USER_MUTATIONS, 'SET_USER')).toEqual([{ kind: 'method', scope: 'mutations' }]);
  });

  it('scopes members that write state as mutations, an expression-bodied one included', () => {
    expect(targetsOf(PROFILE, 'Profile', 'SET_READY')).toEqual([FLAGS]);
    expect(symbolsOf(FLAGS, 'SET_READY')).toEqual([{ kind: 'method', scope: 'mutations' }]);
    expect(symbolsOf(FLAGS, 'TOGGLE')).toEqual([{ kind: 'method', scope: 'mutations' }]);
  });

  it('gives no member symbols to an object of plain arrow functions', () => {
    expect(symbolsOf(FORMAT, 'label')).toEqual([]);
    expect(symbolsOf(FORMAT, 'upper')).toEqual([]);
    expect(symbolsOf(MIXED, 'load')).toEqual([]);
    expect(symbolsOf(MIXED, 'count')).toEqual([]);
  });

  it('gives the same graph when the files are parsed on workers, which read the package the same way', () => {
    const viaWorkers = workspace(files);
    try {
      init(viaWorkers);
      mapxEnv(viaWorkers, { MAPX_PARSE_WORKERS: '2' }, 'scan', '.');
      const graph = (dir: string) => query(dir, `SELECT source_file, source_symbol, edge_type, target_file, target_symbol FROM edges ORDER BY 1, 2, 3, 4, 5`);
      const members = (dir: string) => query(dir, `SELECT file_path, name, kind, scope FROM symbols ORDER BY 1, 2, 3, 4`);
      expect(graph(viaWorkers)).toEqual(graph(root));
      expect(members(viaWorkers)).toEqual(members(root));
    } finally {
      cleanup(viaWorkers);
    }
  }, 90000);
});

// M3-05-R2 review: React hooks, Koa handler objects and Redux reducer maps index as they did before
// the store pass knew them. Outside a package listing vue / vuex / pinia the pass does not run on
// them; inside one, a hook that is not a store resolves as the call the generic extraction gave
// (its name, its source, the library filters).
describe('React, Koa and Redux code outside and inside Vuex and Pinia packages', () => {
  const DELETE = 'src/components/Delete.tsx';
  const FORM = 'src/components/Form.tsx';
  const PAGE = 'src/components/Page.tsx';
  const LIST = 'src/components/List.tsx';
  const ORDERS = 'src/api/orders.js';
  const SESSION = 'src/legacy/session.js';
  const HTTP = 'src/api/http.ts';
  const USERS_CONTROLLER = 'src/controllers/users.js';
  const ROUTES = 'src/routes/index.js';
  const REDUCERS = 'src/store/reducers.ts';
  const REDUX_STORE = 'src/store/index.ts';
  const REACT_FILES = [DELETE, FORM, PAGE];
  const react: Record<string, string> = {
    // A destructured hook result named like a browser global (P1-a).
    'src/hooks/useDialog.ts': 'export function useDialog() {\n  const confirm = (m) => window.confirm(m);\n  return { confirm, alert: (m) => window.alert(m) };\n}\n',
    [ORDERS]: 'export function confirm(id) { return id; }\nexport function alert(msg) { return msg; }\n',
    [DELETE]: `import { useDialog } from '../hooks/useDialog';
export function Delete() {
  const { confirm, alert } = useDialog();
  const d = useDialog();
  if (confirm('sure?')) alert('done');
  d.confirm('x');
  return null;
}
`,
    // A renamed destructure (P1-b).
    'src/hooks/useForm.ts': "import { useState } from 'react';\nexport function useForm() {\n  const [v, setV] = useState({});\n  const submit = async () => v;\n  return { submit, setV };\n}\n",
    'src/hooks/useModal.ts': 'export function useModal() {\n  return { show: () => 1 };\n}\n',
    [SESSION]: 'export function submit(form) { return form; }\nexport function open() { return 1; }\n',
    [FORM]: `import { useForm } from '../hooks/useForm';
import { useModal } from '../hooks/useModal';
export function Form() {
  const { submit: send } = useForm();
  const { show: open } = useModal();
  const go = () => { send(); open(); };
  return go;
}
`,
    // Calls in class methods and in object members that are not symbols (P1-c).
    'src/hooks/useApi.ts': "import { load, save } from '../api/http';\nexport function useApi() { return { load, save }; }\n",
    [HTTP]: 'export function load() { return 1; }\nexport function save() { return 1; }\n',
    [PAGE]: `import { useApi } from '../hooks/useApi';
export class Page {
  api = useApi();
  render() {
    const api = useApi();
    const handlers = {
      onClick: () => { api.load(); },
    };
    api.save();
    return handlers;
  }
}
export const Card = () => {
  const api = useApi();
  const cfg = { onSave() { api.save(); } };
  return cfg;
};
`,
  };
  const others: Record<string, string> = {
    // Koa handlers take ctx, as Vuex actions may.
    'src/services/users.js': "export function findAll() { return []; }\nexport function findOne(id) { return id; }\nexport function show() { return 'svc'; }\n",
    [USERS_CONTROLLER]: `import { findAll, findOne } from '../services/users';
export default {
  list: async (ctx) => {
    ctx.body = await findAll();
  },
  show: async (ctx) => {
    ctx.body = await findOne(ctx.params.id);
  },
};
`,
    [ROUTES]: `import Router from 'koa-router';
import users from '../controllers/users';
const r = new Router();
r.get('/users', users.list);
function local() { show(); list(); }
export default r;
`,
    // Redux reducers and selectors take state, as Vuex mutations and getters do.
    [REDUCERS]: `export const todoReducers = {
  add: (state, action) => {
    state.items.push(action.payload);
  },
  remove: (state, action) => {
    state.items = state.items.filter((i) => i !== action.payload);
  },
};
export const selectors = {
  count: (state) => state.items.length,
};
`,
    // Runs the store pass (createStore), yet is no Vuex package: no member symbols.
    [REDUX_STORE]: "import { createStore } from 'redux';\nexport const handlers = {\n  reset: (state) => ({ ...state, items: [] }),\n};\nexport default createStore((state = { items: [] }) => state);\n",
    [LIST]: `import { useSelector } from 'react-redux';
import { selectors, todoReducers } from '../store/reducers';
export function List() {
  const n = useSelector((state) => selectors.count(state));
  todoReducers.add({ items: [] }, { payload: 1 });
  remove();
  return n;
}
function remove() { return 0; }
`,
  };
  let plain: string;
  let pinia: string;
  const edgesFrom = (root: string, files: string[]) => query<{ source_file: string; source_symbol: string | null; target_file: string; target_symbol: string }>(root,
    `SELECT source_file, source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call' AND source_file IN (${files.map(() => '?').join(', ')}) ORDER BY 1, 2, 3, 4`, ...files);
  const symbolsIn = (root: string, file: string) => query<{ name: string; kind: string }>(root, 'SELECT name, kind FROM symbols WHERE file_path = ? ORDER BY start_line, name', file);

  beforeAll(() => {
    plain = workspace({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0', 'react-redux': '^9.0.0', koa: '^2.0.0', 'koa-router': '^12.0.0' } }),
      ...react,
      ...others,
    });
    pinia = workspace({ 'package.json': JSON.stringify({ name: 'mixed', dependencies: { vue: '^3.4.0', pinia: '^2.1.0', react: '^18.0.0' } }), ...react });
    for (const root of [plain, pinia]) {
      init(root);
      mapx(root, 'scan', '.');
    }
  }, 90000);
  afterAll(() => {
    cleanup(plain);
    cleanup(pinia);
  });

  it('runs the store pass on a React component or a Koa or Redux module only in a package listing the store library', () => {
    expect(storePass(DELETE, react[DELETE], join(plain, DELETE)).run).toBe(false);
    expect(storePass(DELETE, react[DELETE], join(pinia, DELETE)).run).toBe(true);
    expect(storePass(USERS_CONTROLLER, others[USERS_CONTROLLER], join(plain, USERS_CONTROLLER))).toEqual({ run: false, vuex: false });
    expect(storePass(LIST, others[LIST], join(plain, LIST)).run).toBe(false);
    expect(storePass(REDUCERS, others[REDUCERS], join(plain, REDUCERS)).run).toBe(false);
    // No path, no package: as before.
    expect(storePass(DELETE, react[DELETE]).run).toBe(false);
  });

  it('keeps the library filter, the call name and the source of hook calls (as at the parent)', () => {
    const edges = edgesFrom(plain, REACT_FILES);
    // P1-a: alert() is a browser global, filtered as before.
    expect(edges.filter((e) => e.target_file === ORDERS && e.target_symbol === 'alert')).toEqual([]);
    // P1-b: send() is not looked up as submit.
    expect(edges.filter((e) => e.target_file === SESSION && e.target_symbol === 'submit')).toEqual([]);
    // P1-c: calls belong to the method that holds them, by its qualified name.
    expect(edges.filter((e) => e.source_file === PAGE && e.target_file === HTTP)).toEqual([
      { source_file: PAGE, source_symbol: 'Card::onSave', target_file: HTTP, target_symbol: 'save' },
      { source_file: PAGE, source_symbol: 'Page::render', target_file: HTTP, target_symbol: 'load' },
      { source_file: PAGE, source_symbol: 'Page::render', target_file: HTTP, target_symbol: 'save' },
    ]);
  });

  it('resolves hooks that are not stores in a Pinia package exactly as outside one', () => {
    expect(edgesFrom(pinia, REACT_FILES)).toEqual(edgesFrom(plain, REACT_FILES));
    for (const file of REACT_FILES) expect(symbolsIn(pinia, file)).toEqual(symbolsIn(plain, file));
  });

  it('gives Koa handler objects and Redux reducer maps no Vuex member symbols, and no edges by their names', () => {
    expect(symbolsIn(plain, USERS_CONTROLLER)).toEqual([]);
    expect(symbolsIn(plain, REDUCERS)).toEqual([{ name: 'todoReducers', kind: 'constant' }, { name: 'selectors', kind: 'constant' }]);
    expect(storePass(REDUX_STORE, others[REDUX_STORE], join(plain, REDUX_STORE))).toEqual({ run: true, vuex: false });
    expect(symbolsIn(plain, REDUX_STORE).filter((s) => s.name === 'reset')).toEqual([]);
    const local = edgesFrom(plain, [ROUTES]).filter((e) => e.source_symbol === 'local');
    expect(local).toEqual([{ source_file: ROUTES, source_symbol: 'local', target_file: 'src/services/users.js', target_symbol: 'show' }]);
    expect(edgesFrom(plain, [LIST]).filter((e) => e.target_file === REDUCERS)).toEqual([]);
  });
});

// M3-05-R3: the store-library gate (the package.json that decides, read at parse time) is an input
// of the parse. Adding or removing pinia there makes sync re-parse the modules it governs, as
// scan --force would, on the git and the hash sync paths; a store library a monorepo root declares
// counts for its packages.
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

const PINIA_STORE = `import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useWish = defineStore('wish', () => {
  const items = ref<string[]>([]);
  function add(item: string) { items.value.push(item); }
  return { items, add };
});
`;
// Imports only the hook: the store pass runs on it only in a package listing pinia.
const HOOK_USER = `import { useWish } from '../stores/wish';

export function useWishAdd() {
  const w = useWish();
  function addOne(item: string) {
    w.add(item);
  }
  return { addOne };
}
`;

describe.each([['git sync', true], ['hash sync', false]] as const)('a %s after pinia is added to or removed from package.json', (_name, withGit) => {
  const USE_WISH_ADD = 'src/composables/useWishAdd.ts';
  const NESTED_USER = 'packages/admin/src/composables/useWishAdd.ts';
  const withPinia = JSON.stringify({ name: 'shop', dependencies: { vue: '^3.4.0', pinia: '^2.1.0' } });
  const withoutPinia = JSON.stringify({ name: 'shop', dependencies: { vue: '^3.4.0' } });
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': withoutPinia,
      'src/stores/wish.ts': PINIA_STORE,
      // Same name, not a store.
      'src/api/orders.ts': 'export function add(x: string) { return x; }\n',
      [USE_WISH_ADD]: HOOK_USER,
      // A nested package with its own dependencies: the root's package.json does not govern it.
      'packages/admin/package.json': JSON.stringify({ name: 'admin', dependencies: { vue: '^3.4.0' } }),
      'packages/admin/src/stores/wish.ts': PINIA_STORE,
      [NESTED_USER]: HOOK_USER,
    });
    if (withGit) {
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
    }
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const edges = () => query(root, 'SELECT source_file, source_symbol, edge_type, target_file, target_symbol FROM edges ORDER BY 1, 2, 3, 4, 5');
  const addOne = (file: string) => query<{ t: string }>(root,
    `SELECT target_file || '#' || target_symbol AS t FROM edges WHERE edge_type = 'call' AND source_file = ? AND source_symbol = 'addOne' ORDER BY 1`, file).map((e) => e.t);
  const scannedAt = () => Object.fromEntries(query<{ path: string; last_scanned: string }>(root, 'SELECT path, last_scanned FROM files').map((f) => [f.path, f.last_scanned]));
  const setManifest = (text: string) => {
    writeFileSync(join(root, 'package.json'), text);
    if (withGit) git(root, 'commit', '-qam', 'manifest');
  };
  const syncEqualsForce = () => {
    mapx(root, 'sync', '.');
    const synced = edges();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(edges());
  };

  it('links the hook call once pinia is listed, and drops it once it is removed, as scan --force does', () => {
    expect(addOne(USE_WISH_ADD)).not.toContain('src/stores/wish.ts#add');
    setManifest(withPinia);
    syncEqualsForce();
    expect(addOne(USE_WISH_ADD)).toEqual(['src/stores/wish.ts#add']);
    // The nested package lists its own dependencies, without pinia.
    expect(addOne(NESTED_USER)).not.toContain('packages/admin/src/stores/wish.ts#add');
    setManifest(withoutPinia);
    syncEqualsForce();
    expect(addOne(USE_WISH_ADD)).not.toContain('src/stores/wish.ts#add');
  }, 180000);

  it('lends the root store library to a package once pnpm-workspace.yaml lists it, as scan --force does', () => {
    const before = scannedAt();
    setManifest(withPinia);
    mapx(root, 'sync', '.');
    expect(scannedAt()[USE_WISH_ADD]).not.toBe(before[USE_WISH_ADD]);
    expect(addOne(NESTED_USER)).not.toContain('packages/admin/src/stores/wish.ts#add');
    // The root becomes a pnpm workspace root listing the nested package: its hoisted pinia counts there.
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    if (withGit) {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'workspace');
    }
    syncEqualsForce();
    expect(addOne(NESTED_USER)).toEqual(['packages/admin/src/stores/wish.ts#add']);
  }, 180000);
});

describe('a store library declared at a monorepo root', () => {
  const APP_USER = 'packages/app/src/composables/useWishAdd.ts';
  const APP_STORE = 'packages/app/src/stores/wish.ts';
  let root: string;

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*', '!packages/legacy'], dependencies: { pinia: '^2.1.0' } }),
      // The package lists other dependencies, not pinia: the root's (hoisted) one counts for it.
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } }),
      [APP_STORE]: PINIA_STORE,
      'packages/app/src/api/orders.ts': 'export function add(x: string) { return x; }\n',
      [APP_USER]: HOOK_USER,
      // Packages the workspace globs do not list (outside them, or excluded): the root lends them nothing.
      'tools/cli/package.json': JSON.stringify({ name: 'cli', dependencies: { vue: '^3.4.0' } }),
      'packages/legacy/package.json': JSON.stringify({ name: 'legacy', dependencies: { vue: '^3.4.0' } }),
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 90000);
  afterAll(() => cleanup(root));

  it('gives a workspace package the Pinia handling', () => {
    const targets = query<{ t: string }>(root,
      `SELECT target_file || '#' || target_symbol AS t FROM edges WHERE edge_type = 'call' AND source_file = ? AND source_symbol = 'addOne'`, APP_USER).map((e) => e.t);
    expect(targets).toEqual([`${APP_STORE}#add`]);
    expect(storeDependencies(join(root, APP_USER))).toEqual({ vuex: false, pinia: true });
  });

  it('lends nothing to a package the workspace globs do not list', () => {
    expect(storeDependencies(join(root, 'tools/cli/src/a.ts'))).toEqual({ vuex: false, pinia: false });
    expect(storeDependencies(join(root, 'packages/legacy/src/a.ts'))).toEqual({ vuex: false, pinia: false });
  });

  it('looks for the workspace root only up to the repository root', () => {
    const nested = workspace({
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'], dependencies: { pinia: '^2.1.0' } }),
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } }),
      'packages/app/.git/HEAD': 'ref: refs/heads/main\n',
    });
    try {
      expect(storeDependencies(join(nested, 'packages/app/src/a.ts'))).toEqual({ vuex: false, pinia: false });
    } finally {
      cleanup(nested);
    }
  });

  it("reads yarn's workspaces.packages and a root's devDependencies", () => {
    const yarn = workspace({
      'package.json': JSON.stringify({ private: true, workspaces: { packages: ['apps/*'] }, devDependencies: { vuex: '^4.1.0' } }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { vue: '^3.4.0', pinia: '^2.1.0' } }),
      '.git/HEAD': 'ref: refs/heads/main\n',
    });
    try {
      expect(storeDependencies(join(yarn, 'apps/web/src/store/actions.js'))).toEqual({ vuex: true, pinia: true });
    } finally {
      cleanup(yarn);
    }
  });

  // storeDependencies of packages/a/src/x.ts in a repository (`.git` at its root) holding these files.
  const PIN_ROOT = JSON.stringify({ private: true, dependencies: { pinia: '^2.1.0' } });
  const APP = JSON.stringify({ name: 'a', dependencies: { vue: '^3.4.0' } });
  const piniaOf = (files: Record<string, string>, file = 'packages/a/src/x.ts') => {
    const dir = workspace({ '.git/HEAD': 'ref: refs/heads/main\n', ...files });
    try {
      return storeDependencies(join(dir, file)).pinia;
    } finally {
      cleanup(dir);
    }
  };

  it('reads pnpm-workspace.yaml in flow and block style, quoted or not, with comments', () => {
    for (const yaml of [
      "packages: ['packages/*']\n",
      'packages: [ "apps/*", packages/* ] # all\n',
      'packages:\n  [\n    "packages/*",\n  ]\n',
      '"packages":\n  - "packages/*"\n',
      "'packages':\n- 'packages/*'\n",
      'packages:\n  # apps\n\n  - packages/*  # all\n',
      'catalog:\n  pinia: ^2.1.0\npackages:\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\n',
    ]) expect(piniaOf({ 'package.json': PIN_ROOT, 'pnpm-workspace.yaml': yaml, 'packages/a/package.json': APP }), yaml).toBe(true);
    expect(piniaOf({ 'package.json': PIN_ROOT, 'pnpm-workspace.yaml': "packages: ['apps/*']\n", 'packages/a/package.json': APP })).toBe(false);
  });

  it('walks past a workspace root that does not list the package, to the root that does', () => {
    const npmRoot = JSON.stringify({ private: true, workspaces: ['packages/*'], dependencies: { pinia: '^2.1.0' } });
    // A pnpm-workspace.yaml with settings only, no packages.
    expect(piniaOf({ 'package.json': npmRoot, 'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n', 'packages/a/package.json': APP })).toBe(true);
    expect(piniaOf({ 'package.json': npmRoot, 'packages/pnpm-workspace.yaml': 'catalog:\n  x: 1\n', 'packages/a/package.json': APP })).toBe(true);
    // A nested workspace root whose globs list other folders.
    expect(piniaOf({
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/group/*'], dependencies: { pinia: '^2.1.0' } }),
      'packages/group/package.json': JSON.stringify({ private: true, workspaces: ['other/*'] }),
      'packages/group/a/package.json': APP,
    }, 'packages/group/a/src/x.ts')).toBe(true);
    // The root that lists the package decides, even without the library.
    expect(piniaOf({
      'package.json': npmRoot,
      'packages/package.json': JSON.stringify({ private: true, workspaces: ['a'], dependencies: { lodash: '^4.0.0' } }),
      'packages/a/package.json': APP,
    })).toBe(false);
  });

  it('looks for the workspace root only up to the MapX workspace when no repository holds it', () => {
    const files = { 'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'], dependencies: { pinia: '^2.1.0' } }), 'packages/a/package.json': APP };
    const outside = workspace({ ...files, 'packages/a/.mapx/config.json': '{}' });
    const inside = workspace({ ...files, '.mapx/config.json': '{}' });
    const none = workspace(files);
    try {
      expect(storeDependencies(join(outside, 'packages/a/src/x.ts')).pinia).toBe(false);
      expect(storeDependencies(join(inside, 'packages/a/src/x.ts')).pinia).toBe(true);
      expect(storeDependencies(join(none, 'packages/a/src/x.ts')).pinia).toBe(false);
    } finally {
      for (const dir of [outside, inside, none]) cleanup(dir);
    }
  });
});

// Review of M3-05-R3: the monorepo root is above the MapX workspace (MapX initialised in a package).
// Its package.json is an input of the parse there too, so sync follows it as scan --force does. The
// hash variant's `.git` is a folder git does not read, so sync takes the hash path while the
// repository root still bounds the walk.
describe.each([['git sync', true], ['hash sync', false]] as const)('a %s of a package below its monorepo root', (_name, withGit) => {
  const USER = 'src/composables/useWishAdd.ts';
  const rootManifest = (stores: Record<string, string>) => JSON.stringify({ private: true, workspaces: ['packages/*'], dependencies: { vue: '^3.4.0', ...stores } });
  let root: string;
  let app: string;
  beforeEach(() => {
    root = workspace({
      'package.json': rootManifest({ pinia: '^2.1.0' }),
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { lodash: '^4.0.0' } }),
      'packages/app/src/stores/wish.ts': PINIA_STORE,
      [`packages/app/${USER}`]: HOOK_USER,
    });
    if (withGit) {
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
    } else {
      mkdirSync(join(root, '.git'));
    }
    app = join(root, 'packages/app');
    init(app);
    mapx(app, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const edges = () => query(app, 'SELECT source_file, source_symbol, edge_type, target_file, target_symbol FROM edges ORDER BY 1, 2, 3, 4, 5');
  const addOne = () => query<{ t: string }>(app,
    `SELECT target_file || '#' || target_symbol AS t FROM edges WHERE edge_type = 'call' AND source_file = ? AND source_symbol = 'addOne'`, USER).map((e) => e.t);
  const setRoot = (text: string) => {
    writeFileSync(join(root, 'package.json'), text);
    if (withGit) git(root, 'commit', '-qam', 'root');
  };
  const syncEqualsForce = () => {
    mapx(app, 'sync', '.');
    const synced = edges();
    mapx(app, 'scan', '.', '--force');
    expect(synced).toEqual(edges());
  };

  it('follows the root gaining and losing pinia, as scan --force does', () => {
    expect(isGitRepo(app)).toBe(withGit);
    expect(addOne()).toEqual(['src/stores/wish.ts#add']);
    setRoot(rootManifest({}));
    syncEqualsForce();
    expect(addOne()).toEqual([]);
    setRoot(rootManifest({ pinia: '^2.1.0' }));
    syncEqualsForce();
    expect(addOne()).toEqual(['src/stores/wish.ts#add']);
  }, 180000);
});
