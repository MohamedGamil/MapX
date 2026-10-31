import Vue from 'vue';
import { createPinia, PiniaVuePlugin } from 'pinia';
import App from './App.vue';
import BaseIcon from './components/BaseIcon.vue';
import router from './router';
import store from './store';

Vue.use(PiniaVuePlugin);
Vue.component('BaseIcon', BaseIcon);

new Vue({
  router,
  store,
  pinia: createPinia(),
  render: (h) => h(App),
}).$mount('#app');
