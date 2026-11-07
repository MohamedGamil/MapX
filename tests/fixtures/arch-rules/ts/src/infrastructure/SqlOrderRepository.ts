import { Order } from '../domain/Order';

export class SqlOrderRepository {
  run(): void {
    new Order().run();
  }
}
