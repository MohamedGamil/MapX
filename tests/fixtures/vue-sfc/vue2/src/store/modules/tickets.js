const state = () => ({ all: [] });

const getters = {
  openTickets: (state) => state.all.filter((ticket) => ticket.status !== 'closed'),
};

const mutations = {
  SET_TICKETS(state, tickets) {
    state.all = tickets;
  },
  ADD_TICKET(state, ticket) {
    state.all.unshift(ticket);
  },
};

const actions = {
  async FETCH_ALL({ commit }) {
    const response = await fetch('/api/tickets');
    commit('SET_TICKETS', await response.json());
  },
  async CREATE({ commit }, payload) {
    const response = await fetch('/api/tickets', { method: 'POST', body: JSON.stringify(payload) });
    commit('ADD_TICKET', await response.json());
  },
};

export default { namespaced: true, state, getters, mutations, actions };
