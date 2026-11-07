// Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application.
import { computed } from 'vue';
import { useOrdersStore } from '../stores/orders';

export function useOrderTotal() {
  const orders = useOrdersStore();
  return computed(() => orders.total);
}
