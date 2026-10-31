import { ref } from 'vue';
import { defineStore } from 'pinia';

export const useWishlistStore = defineStore('wishlist', () => {
  const items = ref<unknown[]>([]);

  function add(product: unknown) {
    if (!items.value.includes(product)) items.value.push(product);
  }

  function clear() {
    items.value = [];
  }

  return { items, add, clear };
});
