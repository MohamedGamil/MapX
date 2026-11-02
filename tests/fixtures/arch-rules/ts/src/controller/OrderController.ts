import { PlaceOrder } from '../application/PlaceOrder';
import { BaseController } from './BaseController';
import { Order } from '../domain/Order';
import { PricingRules } from '../application/internal/PricingRules';

export class OrderController {
  run(): void {
    new PlaceOrder().run();
    new BaseController().run();
    new Order().run();
    new PricingRules().run();
  }
}
