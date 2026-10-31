import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

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
