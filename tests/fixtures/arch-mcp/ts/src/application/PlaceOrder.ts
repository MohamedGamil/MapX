import { Order } from '../domain/Order';
import { SqlOrderRepository } from '../infrastructure/SqlOrderRepository';

export class PlaceOrder {
  run(id: string): Order {
    const order = new Order(id);
    new SqlOrderRepository().save(order);
    return order;
  }
}
