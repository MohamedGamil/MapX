// Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application.
import { useOrdersStore } from '../stores/orders'; // the violation: the API client reaches up into a store
import { emptyOrder, type OrderSummary } from '../types/order';

export async function fetchOrders(): Promise<OrderSummary[]> {
  return [{ ...emptyOrder(), total: useOrdersStore().total }];
}
