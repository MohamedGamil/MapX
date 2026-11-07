// Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application.
import { createRouter, createWebHistory } from 'vue-router';
import OrdersView from '../views/OrdersView.vue';
import { useOrdersStore } from '../stores/orders';

export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/orders', component: OrdersView }],
});

// A navigation guard reading a store (review of M5-17-R1).
router.beforeEach(() => useOrdersStore().count >= 0);
