// Synthetic fixture for M5-17-R1 (mapx arch init --preset mvc). Not a real application.
import { Order } from '../models/Order';
import { renderOrder } from '../views/OrderView';

export class OrderController {
  show(): string {
    return renderOrder(new Order(1));
  }
}
