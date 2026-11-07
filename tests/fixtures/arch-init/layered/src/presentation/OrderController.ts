// Synthetic fixture for M5-17 (mapx arch init --preset layered). Not a real application.
import { OrderService } from '../business/OrderService';
import { OrderRepository } from '../persistence/OrderRepository';

export class OrderController {
  // The violation: the controller builds the repository itself.
  private readonly service = new OrderService(new OrderRepository());

  show() {
    return this.service.total();
  }
}
