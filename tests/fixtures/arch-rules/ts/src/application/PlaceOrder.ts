import { Order } from '../domain/Order';
import { PricingRules } from './internal/PricingRules';
import { LedgerHelper } from '../domain/LedgerHelper';
import { Clock } from '../support/Clock';

export class PlaceOrder {
  run(): void {
    new Order().run();
    new PricingRules().run();
    new LedgerHelper().run();
    new Clock().run();
  }
}
