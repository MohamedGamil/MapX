// Synthetic fixture for M5-17 (mapx arch init --preset hexagonal). Not a real application.
import { Order } from '../domain/Order';
import { MemoryOrderStore } from '../adapters/MemoryOrderStore';

export class PlaceOrder {
  // The violation: the use case picks an adapter instead of taking the port.
  private readonly store = new MemoryOrderStore();

  run(total: number): Order {
    const order = new Order(total);
    this.store.add(order);
    return order;
  }
}
