import { defineStore } from 'pinia';

interface CartItem {
  id: number;
  name: string;
  price: number;
  quantity: number;
}

export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] as CartItem[] }),
  getters: {
    total(state) {
      return state.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    },
  },
  actions: {
    async checkout() {
      await fetch('/api/checkout', { method: 'POST', body: JSON.stringify(this.items) });
      this.items = [];
    },
    clear() {
      this.items = [];
    },
  },
});
