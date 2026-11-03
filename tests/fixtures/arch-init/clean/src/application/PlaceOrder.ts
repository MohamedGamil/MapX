// Synthetic fixture for M5-17 (mapx arch init --preset clean). Not a real application.
import { Order } from '../domain/Order';
import type { OrderRepository } from './OrderRepository';

export class PlaceOrder {
  constructor(private readonly repo: OrderRepository) {}

  run(total: number): Order {
    const order = new Order(total);
    this.repo.save(order);
    return order;
  }
}
