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
