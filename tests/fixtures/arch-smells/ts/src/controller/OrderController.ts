// Controller: depends on Service (its own "+Service" allowance), on Repository past Service (the
// next layer down the "+" chain: a layer skip) and on the Shared kernel, which Service allows
// plainly (not a skip).
import { OrderService } from '../service/OrderService';
import { SqlOrderRepository } from '../repository/SqlOrderRepository';
import { label } from '../shared/format';

export class OrderController {
  private readonly service = new OrderService();

  fresh(): OrderService {
    return new OrderService();
  }

  show(id: string): string {
    return this.service.describe(id);
  }

  title(id: string): string {
    return label(id);
  }

  audit(): number {
    return new SqlOrderRepository().count();
  }
}
