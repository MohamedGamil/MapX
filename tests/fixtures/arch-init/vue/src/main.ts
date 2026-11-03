// Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application.
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';

createApp(App).use(createPinia()).use(router).mount('#app');
