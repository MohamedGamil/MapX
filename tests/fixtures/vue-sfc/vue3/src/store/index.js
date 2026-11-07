import { createStore } from 'vuex';
import catalog from './modules/catalog';
import orders from './modules/orders';

export default createStore({
  modules: { catalog, orders },
});
