// Service: uses Repository and Domain often, and Shared once (a weak allowance), through a
// deprecated Shared function. Two top-level declarations: instability counts this file once.
import { SqlOrderRepository } from '../repository/SqlOrderRepository';
import { Order } from '../domain/Order';
import { legacyLabel } from '../shared/format';

export class OrderService {
  private readonly repo = new SqlOrderRepository();

  describe(id: string): string {
    return legacyLabel(id);
  }

  place(id: string): Order {
    const order = new Order(id);
    this.repo.save(order);
    return order;
  }

  draft(id: string): Order {
    return new Order(id);
  }

  attach(repo: SqlOrderRepository): void {
    repo.count();
  }
}

export function quickOrder(id: string): Order {
  return new Order(id);
}
