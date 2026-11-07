// Synthetic fixture for M5-17-R1 (mapx arch init --preset onion). Not a real application.
import { Order, type OrderRepository } from '../domain/model/Order';

export class SqlOrderRepository implements OrderRepository {
  find(id: number): Order {
    return new Order(id, 120);
  }
}
