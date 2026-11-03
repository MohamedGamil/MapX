// Synthetic fixture for M5-17-R1 (mapx arch init --preset onion). Not a real application.
import type { OrderRepository } from '../domain/model/Order';
import { discount } from '../domain/services/Pricing';
import { SqlOrderRepository } from '../infrastructure/SqlOrderRepository'; // the violation: the application ring reaches outward

export class Checkout {
  constructor(private readonly orders: OrderRepository = new SqlOrderRepository()) {}

  price(id: number): number {
    const order = this.orders.find(id);
    return order.total - discount(order);
  }
}
