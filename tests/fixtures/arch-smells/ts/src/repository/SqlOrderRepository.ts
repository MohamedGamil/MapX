// Repository: a concrete store over Domain.
import { Order } from '../domain/Order';
import { OrderStore } from './OrderStore';

export class SqlOrderRepository implements OrderStore<Order> {
  private readonly rows: Order[] = [];

  find(id: string): Order {
    return this.rows.find((o) => o.id === id) ?? new Order(id);
  }

  blank(): Order {
    return new Order('');
  }

  save(order: Order): void {
    this.rows.push(order);
  }

  count(): number {
    return this.rows.length;
  }
}
