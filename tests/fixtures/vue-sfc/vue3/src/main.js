import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import BaseButton from './components/BaseButton.vue';
import router from './router';
import store from './store';

const app = createApp(App);
app.component('BaseButton', BaseButton);
app.use(createPinia());
app.use(store);
app.use(router);
app.mount('#app');
