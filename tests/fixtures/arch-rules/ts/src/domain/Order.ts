import { SqlOrderRepository } from '../infrastructure/SqlOrderRepository';
import { Money } from './Money';
import { OrderId } from './ids/OrderId';
import { LedgerHelper } from './LedgerHelper';

export class Order {
  run(): void {
    new SqlOrderRepository().run();
    new Money().run();
    new OrderId().run();
    new LedgerHelper().run();
  }
}
