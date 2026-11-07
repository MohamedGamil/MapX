import { Order } from '../domain/Order';
import { OrderRepository } from '../domain/OrderRepository';

export class SqlOrderRepository implements OrderRepository {
  save(order: Order): void {
    void order.id;
  }
}
