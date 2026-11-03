// Synthetic fixture for M5-17 (mapx arch init --preset clean). Not a real application.
import { Order } from '../domain/Order';
import type { OrderRepository } from '../application/OrderRepository';

export class SqlOrderRepository implements OrderRepository {
  save(order: Order): void {
    void order;
  }
}
