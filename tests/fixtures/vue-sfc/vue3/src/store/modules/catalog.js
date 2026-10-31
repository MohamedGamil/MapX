export default {
  namespaced: true,
  state: () => ({ products: [] }),
  getters: {
    visibleProducts(state) {
      return state.products.filter((product) => !product.hidden);
    },
  },
  mutations: {
    SET_PRODUCTS(state, products) {
      state.products = products;
    },
  },
  actions: {
    async FETCH_PRODUCTS({ commit }) {
      const response = await fetch('/api/products');
      commit('SET_PRODUCTS', await response.json());
    },
    async FETCH_ALL({ dispatch }) {
      await dispatch('FETCH_PRODUCTS');
    },
  },
};
