import { Order } from '../domain/Order';
import { PlaceOrder } from '../application/PlaceOrder';

export class OrderController {
  store(id: string): Order {
    return new PlaceOrder().run(id);
  }
}
