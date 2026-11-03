// Synthetic fixture for M5-17-R1 (mapx arch init --preset onion). Not a real application.
import { Order } from '../model/Order';

export function discount(order: Order): number {
  return order.total > 100 ? 10 : 0;
}
