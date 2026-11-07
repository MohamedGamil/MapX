// Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application.
import { defineStore } from 'pinia';
import { fetchOrders } from '../services/ordersApi';
import { router } from '../router';

export const useOrdersStore = defineStore('orders', {
  state: () => ({ count: 0, total: 0 }),
  actions: {
    async load() {
      const orders = await fetchOrders();
      this.count = orders.length;
    },
    // A store navigating (review of M5-17-R1).
    async open() {
      await router.push('/orders');
    },
  },
});
