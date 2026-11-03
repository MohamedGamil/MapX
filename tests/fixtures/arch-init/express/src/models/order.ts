// Synthetic fixture for M5-17-R1 (mapx arch init --preset express). Not a real application.
import { settings } from '../config/settings';
import { createOrder } from '../controllers/orderController'; // the violation: a model reaches up into a controller

export class Order {
  readonly currency = settings.currency;
  static handler = createOrder;

  constructor(readonly total: number) {}
}
