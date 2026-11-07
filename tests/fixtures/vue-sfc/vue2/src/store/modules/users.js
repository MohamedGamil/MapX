const state = () => ({ all: [] });

const mutations = {
  SET_USERS(state, users) {
    state.all = users;
  },
};

const actions = {
  async FETCH_ALL({ commit }) {
    const response = await fetch('/api/users');
    commit('SET_USERS', await response.json());
  },
};

export default { namespaced: true, state, mutations, actions };
