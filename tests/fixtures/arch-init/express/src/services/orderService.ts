// Synthetic fixture for M5-17-R1 (mapx arch init --preset express). Not a real application.
import { Order } from '../models/order';

export function placeOrder(total: number): Order {
  return new Order(total);
}
