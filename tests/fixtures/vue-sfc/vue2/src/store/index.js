import Vue from 'vue';
import Vuex from 'vuex';
import tickets from './modules/tickets';
import users from './modules/users';

Vue.use(Vuex);

export default new Vuex.Store({
  modules: { tickets, users },
});
