// Controller: uses Service (its own "+Service"), reaches Repository past Service (a layer skip), and imports pg,
// which Repository keeps private (a vendor leak).
import { Pool } from 'pg';
import { OrderService } from '../service/OrderService';
import { SqlRepo } from '../repository/SqlRepo';

export class OrderController {
  private readonly service = new OrderService();
  private readonly pool = new Pool();

  show(id: string): string {
    return this.service.describe(id);
  }

  count(): number {
    return new SqlRepo().count();
  }
}
