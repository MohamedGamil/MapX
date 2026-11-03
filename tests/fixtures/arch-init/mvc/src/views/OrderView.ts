// Synthetic fixture for M5-17-R1 (mapx arch init --preset mvc). Not a real application.
import type { Order } from '../models/Order';
import { OrderController } from '../controllers/OrderController'; // the violation: a view reaches into its controller

export function renderOrder(order: Order): string {
  return `<p>${order.total}</p>` + OrderController.name;
}
