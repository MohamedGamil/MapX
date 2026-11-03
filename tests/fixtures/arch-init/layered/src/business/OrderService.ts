// Synthetic fixture for M5-17 (mapx arch init --preset layered). Not a real application.
import { Money } from '../common/Money';
import { OrderRepository } from '../persistence/OrderRepository';

export class OrderService {
  constructor(private readonly repo: OrderRepository) {}

  total(): Money {
    return this.repo.total();
  }
}
