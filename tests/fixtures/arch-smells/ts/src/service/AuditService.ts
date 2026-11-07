// Service: a second user of Repository and Domain, which makes both more stable.
import { SqlOrderRepository } from '../repository/SqlOrderRepository';
import { Order } from '../domain/Order';

export class AuditService {
  total(): number {
    return new SqlOrderRepository().count();
  }

  probe(): Order {
    return new Order('audit');
  }
}
