export default {
  namespaced: true,
  state: () => ({ list: [] }),
  mutations: {
    SET_ORDERS(state, orders) {
      state.list = orders;
    },
  },
  actions: {
    async FETCH_ALL({ commit }) {
      const response = await fetch('/api/orders');
      commit('SET_ORDERS', await response.json());
    },
  },
};
