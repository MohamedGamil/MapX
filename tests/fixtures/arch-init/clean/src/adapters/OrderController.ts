// Synthetic fixture for M5-17 (mapx arch init --preset clean). Not a real application.
import { PlaceOrder } from '../application/PlaceOrder';

export class OrderController {
  constructor(private readonly placeOrder: PlaceOrder) {}

  post(total: number) {
    return this.placeOrder.run(total);
  }
}
