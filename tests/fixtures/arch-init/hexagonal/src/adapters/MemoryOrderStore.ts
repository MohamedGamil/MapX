// Synthetic fixture for M5-17 (mapx arch init --preset hexagonal). Not a real application.
import { Order } from '../domain/Order';
import type { OrderStore } from '../application/ports/OrderStore';

export class MemoryOrderStore implements OrderStore {
  readonly orders: Order[] = [];

  add(order: Order): void {
    this.orders.push(order);
  }
}
